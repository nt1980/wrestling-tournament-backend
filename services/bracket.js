import pool from '../db.js';
import { v4 as uuidv4 } from 'uuid';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Insert a single match row and return the full inserted record.
 */
async function insertMatch(client, fields) {
  const id = fields.id ?? uuidv4();
  const {
    competition_id,
    tournament_id,
    pool_id = null,
    round = 0,
    index_in_round = 0,
    bracket = 'main',
    phase = 'main_bracket',
    match_type = 'main_bracket',
    red_athlete_id = null,
    blue_athlete_id = null,
    winner_id = null,
    loser_id = null,
    winner_to = null,
    loser_to = null,
    parent_match_ids = null,
    status = 'ready',
    is_bye = false,
    scheduled_order = null,
  } = fields;

  const result = await client.query(
    `INSERT INTO matches (
       id, competition_id, tournament_id, pool_id,
       round, index_in_round, bracket, phase, match_type,
       red_athlete_id, blue_athlete_id,
       winner_id, loser_id,
       winner_to, loser_to, parent_match_ids,
       status, is_bye, scheduled_order
     ) VALUES (
       $1,$2,$3,$4,
       $5,$6,$7,$8,$9,
       $10,$11,
       $12,$13,
       $14,$15,$16,
       $17,$18,$19
     ) RETURNING *`,
    [
      id, competition_id, tournament_id, pool_id,
      round, index_in_round, bracket, phase, match_type,
      red_athlete_id, blue_athlete_id,
      winner_id, loser_id,
      winner_to, loser_to,
      parent_match_ids ?? null,
      status, is_bye, scheduled_order,
    ]
  );
  return result.rows[0];
}

/**
 * Patch winner_to / loser_to on an already-inserted match.
 */
async function patchMatch(client, matchId, updates) {
  const keys = Object.keys(updates);
  const setClauses = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  const values = [matchId, ...keys.map(k => updates[k])];
  await client.query(`UPDATE matches SET ${setClauses} WHERE id = $1`, values);
}

// ---------------------------------------------------------------------------
// 1. generateNordic
// ---------------------------------------------------------------------------

/**
 * Round-robin: every athlete vs every other athlete.
 * Uses the circle/round-robin algorithm so rounds are balanced.
 *
 * @param {string} competitionId
 * @param {string} tournamentId
 * @param {Array}  athletes   – array of athlete objects with at least { id }
 * @param {object} [poolObj]  – optional pool row (for pools_finals format)
 * @returns {Promise<Array>}  array of created match objects
 */
export async function generateNordic(competitionId, tournamentId, athletes, poolObj = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const created = [];
    const ids = athletes.map(a => a.id);
    const n = ids.length;

    if (n < 2) {
      await client.query('COMMIT');
      return created;
    }

    // Circle algorithm – handles odd/even counts
    const list = [...ids];
    const fixed = n % 2 === 0 ? null : 'BYE'; // phantom for odd
    if (fixed !== null) list.push(fixed);
    const size = list.length; // always even
    const numRounds = size - 1;

    let scheduledOrder = 0;

    for (let r = 0; r < numRounds; r++) {
      const pairings = [];
      for (let i = 0; i < size / 2; i++) {
        const a = list[i];
        const b = list[size - 1 - i];
        if (a !== 'BYE' && b !== 'BYE') {
          pairings.push([a, b]);
        }
      }

      for (let idx = 0; idx < pairings.length; idx++) {
        const [red, blue] = pairings[idx];
        const match = await insertMatch(client, {
          competition_id: competitionId,
          tournament_id: tournamentId,
          pool_id: poolObj ? poolObj.id : null,
          round: r,
          index_in_round: idx,
          bracket: 'main',
          phase: 'main_bracket',
          match_type: 'qualification',
          red_athlete_id: red,
          blue_athlete_id: blue,
          status: 'ready',
          is_bye: false,
          scheduled_order: scheduledOrder++,
        });
        created.push(match);
      }

      // Rotate: keep list[0] fixed, rotate rest
      const last = list[size - 1];
      for (let i = size - 1; i > 1; i--) {
        list[i] = list[i - 1];
      }
      list[1] = last;
    }

    await client.query('COMMIT');
    return created;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// 2. generatePoolsAndFinals
// ---------------------------------------------------------------------------

/**
 * Split athletes into 2 pools, run round-robin within each, then create
 * knockout matches (semis, final, bronze).
 *
 * Split sizes:
 *   6 → 3+3 | 7 → 4+3 | 8 → 4+4
 *   For any other count we split as evenly as possible (ceil/floor).
 *
 * @param {string} competitionId
 * @param {string} tournamentId
 * @param {Array}  athletes       – array of athlete objects ({ id, club_id? })
 * @param {string} repechageMode  – 'simplified_bronze' | anything else = 2 bronzes
 * @returns {Promise<{pools: Array, matches: Array}>}
 */
export async function generatePoolsAndFinals(
  competitionId,
  tournamentId,
  athletes,
  repechageMode
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const n = athletes.length;

    // --- Determine pool sizes ---
    let sizeA, sizeB;
    if (n === 6) { sizeA = 3; sizeB = 3; }
    else if (n === 7) { sizeA = 4; sizeB = 3; }
    else if (n === 8) { sizeA = 4; sizeB = 4; }
    else {
      sizeA = Math.ceil(n / 2);
      sizeB = Math.floor(n / 2);
    }

    // --- Distribute athletes, avoiding same club in same pool ---
    const shuffled = [...athletes];
    // Group by club
    const byClub = new Map();
    for (const a of shuffled) {
      const club = a.club_id ?? '__none__';
      if (!byClub.has(club)) byClub.set(club, []);
      byClub.get(club).push(a);
    }

    // Interleave clubs so consecutive entries differ
    const sorted = [...byClub.values()].sort((x, y) => y.length - x.length);
    const interleaved = [];
    while (interleaved.length < n) {
      for (const group of sorted) {
        if (group.length > 0 && interleaved.length < n) {
          interleaved.push(group.shift());
        }
      }
    }

    // Assign alternately to pool A and B
    const poolAAthletes = [];
    const poolBAthletes = [];
    for (let i = 0; i < interleaved.length; i++) {
      if (poolAAthletes.length < sizeA) poolAAthletes.push(interleaved[i]);
      else poolBAthletes.push(interleaved[i]);
    }

    // --- Create pool rows ---
    const poolAId = uuidv4();
    const poolBId = uuidv4();

    const poolAResult = await client.query(
      `INSERT INTO pools (id, competition_id, tournament_id, name, status)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [poolAId, competitionId, tournamentId, 'A', 'active']
    );
    const poolBResult = await client.query(
      `INSERT INTO pools (id, competition_id, tournament_id, name, status)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [poolBId, competitionId, tournamentId, 'B', 'active']
    );

    const poolA = poolAResult.rows[0];
    const poolB = poolBResult.rows[0];

    // --- Insert pool_athletes ---
    for (let i = 0; i < poolAAthletes.length; i++) {
      await client.query(
        `INSERT INTO pool_athletes (id, pool_id, athlete_id, seed_order)
         VALUES ($1, $2, $3, $4)`,
        [uuidv4(), poolAId, poolAAthletes[i].id, i + 1]
      );
    }
    for (let i = 0; i < poolBAthletes.length; i++) {
      await client.query(
        `INSERT INTO pool_athletes (id, pool_id, athlete_id, seed_order)
         VALUES ($1, $2, $3, $4)`,
        [uuidv4(), poolBId, poolBAthletes[i].id, i + 1]
      );
    }

    await client.query('COMMIT');

    // --- Round-robin within each pool (uses its own transaction) ---
    const poolAMatches = await generateNordic(competitionId, tournamentId, poolAAthletes, poolA);
    const poolBMatches = await generateNordic(competitionId, tournamentId, poolBAthletes, poolB);

    // --- Create knockout matches (all blocked – winners TBD after pools) ---
    const knockoutClient = await pool.connect();
    try {
      await knockoutClient.query('BEGIN');

      // We need a stable round numbering after pool rounds.
      // Pool matches used round 0..k; knockout starts at round 100 for clarity.
      const SEMI_ROUND = 100;
      const BRONZE_ROUND = 101;
      const FINAL_ROUND = 102;

      // Semi-finals: A1 vs B2, B1 vs A2
      const semi1Id = uuidv4();
      const semi2Id = uuidv4();
      const finalId = uuidv4();

      // Bronze matches
      const bronze1Id = uuidv4();
      const bronze2Id = uuidv4(); // only used when repechageMode !== 'simplified_bronze'

      // Semi 1: A1 vs B2
      const semi1 = await insertMatch(knockoutClient, {
        id: semi1Id,
        competition_id: competitionId,
        tournament_id: tournamentId,
        round: SEMI_ROUND,
        index_in_round: 0,
        bracket: 'main',
        phase: 'main_bracket',
        match_type: 'semifinal',
        status: 'blocked',
        winner_to: finalId,
        loser_to: repechageMode === 'simplified_bronze' ? bronze1Id : bronze1Id,
      });

      // Semi 2: B1 vs A2
      const semi2 = await insertMatch(knockoutClient, {
        id: semi2Id,
        competition_id: competitionId,
        tournament_id: tournamentId,
        round: SEMI_ROUND,
        index_in_round: 1,
        bracket: 'main',
        phase: 'main_bracket',
        match_type: 'semifinal',
        status: 'blocked',
        winner_to: finalId,
        loser_to: repechageMode === 'simplified_bronze' ? bronze1Id : bronze2Id,
      });

      // Final
      const finalMatch = await insertMatch(knockoutClient, {
        id: finalId,
        competition_id: competitionId,
        tournament_id: tournamentId,
        round: FINAL_ROUND,
        index_in_round: 0,
        bracket: 'final',
        phase: 'final',
        match_type: 'final',
        status: 'blocked',
        parent_match_ids: [semi1Id, semi2Id],
      });

      const bronzeMatches = [];

      if (repechageMode === 'simplified_bronze') {
        // One 3rd place match between the two semi-final losers
        const b1 = await insertMatch(knockoutClient, {
          id: bronze1Id,
          competition_id: competitionId,
          tournament_id: tournamentId,
          round: BRONZE_ROUND,
          index_in_round: 0,
          bracket: 'bronze',
          phase: 'final',
          match_type: 'bronze',
          status: 'blocked',
          parent_match_ids: [semi1Id, semi2Id],
        });
        bronzeMatches.push(b1);
      } else {
        // Two separate bronze matches (each semi loser plays for 3rd independently)
        const b1 = await insertMatch(knockoutClient, {
          id: bronze1Id,
          competition_id: competitionId,
          tournament_id: tournamentId,
          round: BRONZE_ROUND,
          index_in_round: 0,
          bracket: 'bronze',
          phase: 'final',
          match_type: 'bronze',
          status: 'blocked',
          parent_match_ids: [semi1Id],
        });
        const b2 = await insertMatch(knockoutClient, {
          id: bronze2Id,
          competition_id: competitionId,
          tournament_id: tournamentId,
          round: BRONZE_ROUND,
          index_in_round: 1,
          bracket: 'bronze',
          phase: 'final',
          match_type: 'bronze',
          status: 'blocked',
          parent_match_ids: [semi2Id],
        });
        bronzeMatches.push(b1, b2);
      }

      await knockoutClient.query('COMMIT');

      const allMatches = [
        ...poolAMatches,
        ...poolBMatches,
        semi1,
        semi2,
        finalMatch,
        ...bronzeMatches,
      ];

      return {
        pools: [poolA, poolB],
        matches: allMatches,
      };
    } catch (err) {
      await knockoutClient.query('ROLLBACK');
      throw err;
    } finally {
      knockoutClient.release();
    }
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {} // no-op si déjà committé
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// 3. generateBracket
// ---------------------------------------------------------------------------

/**
 * Single-elimination bracket with repechage.
 *
 * @param {string} competitionId
 * @param {string} tournamentId
 * @param {Array}  athletes       – athlete objects ({ id, club_id? })
 * @param {string} repechageMode  – 'simplified_bronze' | 'full_repechage' | other
 * @returns {Promise<{bracket_matches: Array, repechage_brackets: Array}>}
 */
export async function generateBracket(
  competitionId,
  tournamentId,
  athletes,
  repechageMode
) {
  const BRACKET_SIZES = [8, 16, 32, 64];
  const n = athletes.length;
  const bracketSize = BRACKET_SIZES.find(s => s >= n);
  if (!bracketSize) throw new Error(`Too many athletes (${n}) for bracket generation.`);

  const numRounds = Math.log2(bracketSize); // e.g. 8→3, 16→4

  // ---------------------------------------------------------------------------
  // Seed athletes – avoid same club in same quarter when possible
  // ---------------------------------------------------------------------------
  const seeded = seedAthletes(athletes, bracketSize);
  // seeded is an array of length bracketSize; null entries = BYE slots

  // ---------------------------------------------------------------------------
  // Build all match IDs up-front so we can wire winner_to / loser_to
  // ---------------------------------------------------------------------------
  // Matches are stored per round.
  // Round 0 = first round (bracketSize/2 matches)
  // Round numRounds-1 = final (1 match)
  //
  // matchGrid[round][index] = { id, ... }

  const matchGrid = buildMatchGrid(bracketSize, numRounds);

  // ---------------------------------------------------------------------------
  // DB insert
  // ---------------------------------------------------------------------------
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const bracketMatches = [];

    for (let r = 0; r < numRounds; r++) {
      const matchesInRound = matchGrid[r];
      for (let idx = 0; idx < matchesInRound.length; idx++) {
        const slot = matchesInRound[idx];

        let red = null;
        let blue = null;
        let isBye = false;
        let status = 'blocked';
        let winnerId = null;

        if (r === 0) {
          // First round – athletes are known (or BYE)
          const redAthlete = seeded[idx * 2];
          const blueAthlete = seeded[idx * 2 + 1];

          const redIsReal = redAthlete !== null;
          const blueIsReal = blueAthlete !== null;

          red = redIsReal ? redAthlete.id : null;
          blue = blueIsReal ? blueAthlete.id : null;

          if (redIsReal && blueIsReal) {
            status = 'ready';
          } else if (redIsReal && !blueIsReal) {
            // BYE: red auto-advances
            isBye = true;
            status = 'finished';
            winnerId = red;
          } else if (!redIsReal && blueIsReal) {
            // BYE: blue auto-advances
            isBye = true;
            status = 'finished';
            winnerId = blue;
          } else {
            // Both BYE – should not happen with proper seeding but guard it
            isBye = true;
            status = 'finished';
          }
        }
        // rounds > 0 remain blocked (athletes TBD from previous round results)

        const isLastRound = r === numRounds - 1;
        const matchType = isLastRound
          ? 'final'
          : r === numRounds - 2
          ? 'semifinal'
          : 'main_bracket';

        const phase = isLastRound ? 'final' : 'main_bracket';
        const bracket = isLastRound ? 'final' : 'main';

        // winner_to / loser_to
        let winnerTo = null;
        let loserTo = null;

        if (!isLastRound) {
          const nextRound = r + 1;
          const nextIdx = Math.floor(idx / 2);
          winnerTo = matchGrid[nextRound][nextIdx].id;
        }

        // loser_to for repechage – only non-BYE losers enter repechage
        // We'll link loser_to after creating repechage brackets below
        // For now leave null; we'll patch it.

        const match = await insertMatch(client, {
          id: slot.id,
          competition_id: competitionId,
          tournament_id: tournamentId,
          round: r,
          index_in_round: idx,
          bracket,
          phase,
          match_type: matchType,
          red_athlete_id: red,
          blue_athlete_id: blue,
          winner_id: winnerId,
          status,
          is_bye: isBye,
          winner_to: winnerTo,
          scheduled_order: r * 1000 + idx,
        });
        bracketMatches.push(match);
      }
    }

    // ---------------------------------------------------------------------------
    // Propagate BYE winners to next-round slots
    // ---------------------------------------------------------------------------
    // BYE matches are pre-generated as finished. Populate the corresponding
    // slot in round 1 so athletes appear immediately without manual processing.
    if (numRounds >= 2) {
      const byeMatches = bracketMatches.filter(
        m => m.is_bye && m.winner_id && m.round === 0
      );
      for (const byeMatch of byeMatches) {
        const nextRoundIdx = Math.floor(byeMatch.index_in_round / 2);
        const nextSlot = matchGrid[1]?.[nextRoundIdx];
        if (!nextSlot) continue;
        // Even index → red slot of next match; odd index → blue slot
        const col = byeMatch.index_in_round % 2 === 0 ? 'red_athlete_id' : 'blue_athlete_id';
        await patchMatch(client, nextSlot.id, { [col]: byeMatch.winner_id });
      }
    }

    // ---------------------------------------------------------------------------
    // Repechage brackets (UWW unified structure)
    // ---------------------------------------------------------------------------
    // simplified_bronze : one 3rd-place match between the two semi-final losers.
    // everything else   : full UWW repechage —
    //   BR(k)  = PM(2k-1) vs PM(2k)          adjacent first-round losers
    //   R(k)   = PA(k)    vs VBR(K-k+1)      mirror crossing (K = N/2)
    //   Merge  = pairs of R winners
    //   R2(k)  = PB(k)    vs VMerge(K/2-k+1) mirror crossing
    //   … until 2 final winners = 3e place ex-aequo

    if (repechageMode === 'simplified_bronze') {
      const bronzeId    = uuidv4();
      const semi1Match  = numRounds >= 2 ? matchGrid[numRounds - 2][0] : null;
      const semi2Match  = numRounds >= 2 ? matchGrid[numRounds - 2][1] : null;
      const bronze = await insertMatch(client, {
        id: bronzeId,
        competition_id: competitionId,
        tournament_id:  tournamentId,
        round: numRounds,
        index_in_round: 0,
        bracket: 'bronze', phase: 'final', match_type: 'bronze',
        status: 'blocked',
        parent_match_ids: [semi1Match?.id, semi2Match?.id].filter(Boolean),
      });
      bracketMatches.push(bronze);
      if (semi1Match) await patchMatch(client, semi1Match.id, { loser_to: bronzeId });
      if (semi2Match) await patchMatch(client, semi2Match.id, { loser_to: bronzeId });

    } else {
      await buildUWWRepechage(
        client, bracketMatches,
        competitionId, tournamentId,
        numRounds, matchGrid
      );
    }

    await client.query('COMMIT');
    return { bracket_matches: bracketMatches, repechage_brackets: [] };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Internal helpers for bracket generation
// ---------------------------------------------------------------------------

/**
 * Return an array of length bracketSize with athlete objects or null (BYE).
 * Tries to place athletes from the same club in different quarters.
 */
function seedAthletes(athletes, bracketSize) {
  const slots = new Array(bracketSize).fill(null);

  if (athletes.length === 0) return slots;

  // Standard seeding positions for power-of-2 brackets.
  // Positions are interleaved so that seeds 1 and 2 meet in the final,
  // seeds 1-4 meet only in semis, etc.
  const seedPositions = buildSeedPositions(bracketSize);

  // Group athletes by club, sort clubs by size descending
  const byClub = new Map();
  for (const a of athletes) {
    const club = a.club_id ?? `__solo_${a.id}`;
    if (!byClub.has(club)) byClub.set(club, []);
    byClub.get(club).push(a);
  }

  // Interleave so same-club athletes are spread apart
  const ordered = [];
  const groups = [...byClub.values()].sort((a, b) => b.length - a.length);
  while (ordered.length < athletes.length) {
    for (const g of groups) {
      if (g.length > 0) ordered.push(g.shift());
      if (ordered.length >= athletes.length) break;
    }
  }

  for (let i = 0; i < ordered.length; i++) {
    slots[seedPositions[i]] = ordered[i];
  }

  return slots;
}

/**
 * Build seeding positions for a bracket of given size.
 * Standard bracket seeding: seed 1 and seed 2 can only meet in the final,
 * seeds 1/4 and 2/3 can only meet in the semis, etc.
 *
 * Recursive approach: split bracket in half, interleave sub-results
 * so that top-half seeds are at even slots and bottom-half mirrors at odd slots.
 * Terminates in O(n log n) for any power-of-2 size.
 */
function buildSeedPositions(size) {
  if (size <= 1) return [0];
  if (size === 2) return [0, 1];
  const half = size / 2;
  const sub = buildSeedPositions(half);
  const result = new Array(size);
  for (let i = 0; i < half; i++) {
    result[i * 2]     = sub[i];              // odd seeds  → top half
    result[i * 2 + 1] = size - 1 - sub[i];  // even seeds → bottom half (mirror)
  }
  return result;
}

/**
 * Create the main bracket match grid with pre-assigned IDs.
 * matchGrid[round][index] = { id: uuid }
 */
function buildMatchGrid(bracketSize, numRounds) {
  const grid = [];
  for (let r = 0; r < numRounds; r++) {
    const count = bracketSize / Math.pow(2, r + 1);
    const row = [];
    for (let i = 0; i < count; i++) {
      row.push({ id: uuidv4() });
    }
    grid.push(row);
  }
  return grid;
}

/**
 * Build the unified UWW repechage bracket.
 *
 * Structure for N first-round matches:
 *
 *   BR round  : BRk = PM(2k-1) vs PM(2k)       adjacent first-round losers
 *   Cross 1   : Rk  = PA(k) vs VBR(K-k+1)      mirror  (K = N/2)
 *   Merge 1   : pairs of R winners              binary merge
 *   Cross 2   : R2k = PB(k) vs VM1(K/2-k+1)    mirror
 *   Merge 2   …
 *   Cross n   : 2 final matches → 3e place ex-aequo, no small final
 *
 * Connector logic visible in the frontend:
 *   BR  → Cross  (same count) : 1-to-1 straight connectors
 *   Cross → Merge (halved)    : elbow / binary-merge connectors
 *   Merge → Cross (same count): 1-to-1 straight connectors
 */
async function buildUWWRepechage(
  client, bracketMatches,
  competitionId, tournamentId,
  numRounds, matchGrid
) {
  const N = matchGrid[0].length; // first-round match count = bracketSize / 2

  // ── Pre-allocate IDs ──────────────────────────────────────────────────────
  const brIds = Array.from({ length: N / 2 }, () => uuidv4());

  // repSeq: sequence of rounds after BR
  // { type: 'cross'|'merge', count, mainRound? (cross only), ids }
  const repSeq = [];
  let cur  = N / 2;
  let mr   = 1; // main-bracket round whose losers enter the next cross

  // First cross: N/2 matches (A-round losers × BR winners, mirror)
  repSeq.push({ type: 'cross', count: cur, mainRound: mr, ids: Array.from({ length: cur }, () => uuidv4()) });
  mr++;

  while (cur > 2) {
    // Merge: halve the winner pool
    const mc = cur / 2;
    repSeq.push({ type: 'merge', count: mc, ids: Array.from({ length: mc }, () => uuidv4()) });
    cur = mc;

    // Cross: merge winners × next main-round losers (mirror)
    repSeq.push({ type: 'cross', count: cur, mainRound: mr, ids: Array.from({ length: cur }, () => uuidv4()) });
    mr++;
  }
  // Last cross has 2 matches → those 2 winners are 3e place ex-aequo

  // ── Wire winner_to ────────────────────────────────────────────────────────
  const wt = {}; // id → next-match id

  // BR[k].winnerTo = firstCross[K-1-k]  (mirror)
  const K = brIds.length;
  for (let k = 0; k < K; k++) {
    wt[brIds[k]] = repSeq[0].ids[K - 1 - k];
  }

  for (let i = 0; i < repSeq.length - 1; i++) {
    const cur  = repSeq[i];
    const next = repSeq[i + 1];

    if (cur.type === 'cross' && next.type === 'merge') {
      // Sequential pairing: (0,1)→0, (2,3)→1, …
      for (let k = 0; k < cur.ids.length; k++) {
        wt[cur.ids[k]] = next.ids[Math.floor(k / 2)];
      }
    } else if (cur.type === 'merge' && next.type === 'cross') {
      // Sequential: merge[k] → cross[k]
      // On garde le même ordre visuel (pas de croisement de lignes) —
      // la position dans le tour cross est alignée avec le merge précédent.
      for (let k = 0; k < cur.ids.length; k++) {
        wt[cur.ids[k]] = next.ids[k];
      }
    }
  }
  // Last cross: winners go nowhere (3e place)

  // ── Insert BR matches ─────────────────────────────────────────────────────
  for (let k = 0; k < brIds.length; k++) {
    const m = await insertMatch(client, {
      id: brIds[k],
      competition_id: competitionId, tournament_id: tournamentId,
      round: numRounds, index_in_round: k,
      bracket: 'repechage', phase: 'repechage', match_type: 'repechage',
      status: 'blocked', winner_to: wt[brIds[k]] ?? null,
    });
    bracketMatches.push(m);
  }

  // ── Insert repSeq matches ─────────────────────────────────────────────────
  const lastRi = repSeq.length - 1;
  for (let ri = 0; ri < repSeq.length; ri++) {
    const seq      = repSeq[ri];
    const round    = numRounds + 1 + ri;
    const isBronze = ri === lastRi && seq.type === 'cross';

    for (let k = 0; k < seq.ids.length; k++) {
      const m = await insertMatch(client, {
        id: seq.ids[k],
        competition_id: competitionId, tournament_id: tournamentId,
        round, index_in_round: k,
        bracket:    isBronze ? 'bronze'    : 'repechage',
        phase:      isBronze ? 'final'     : 'repechage',
        match_type: isBronze ? 'bronze'    : 'repechage',
        status: 'blocked', winner_to: wt[seq.ids[k]] ?? null,
      });
      bracketMatches.push(m);
    }
  }

  // ── Patch main-bracket loser_to ───────────────────────────────────────────
  // Build a map id → inserted match (to detect BYEs)
  const byId = {};
  for (const m of bracketMatches) byId[m.id] = m;

  // Round 0 losers → BR  (BRk = PM(2k-1) vs PM(2k), i.e. match i → BR[floor(i/2)])
  for (let i = 0; i < matchGrid[0].length; i++) {
    if (byId[matchGrid[0][i].id]?.is_bye) continue; // BYE → no real loser
    await patchMatch(client, matchGrid[0][i].id, { loser_to: brIds[Math.floor(i / 2)] });
  }

  // Si l'un des deux matchs sources d'un BR est un BYE, le BR lui-même
  // n'aura qu'un seul athlète réel → on le marque is_bye = true.
  // Le serveur auto-avancera cet athlète vers le tour C1 dès qu'il arrive.
  for (let k = 0; k < brIds.length; k++) {
    const src0 = matchGrid[0][2 * k];
    const src1 = matchGrid[0][2 * k + 1];
    const bye0 = !src0 || !!byId[src0?.id]?.is_bye;
    const bye1 = !src1 || !!byId[src1?.id]?.is_bye;
    if (bye0 || bye1) {
      await patchMatch(client, brIds[k], { is_bye: true });
    }
  }

  // Each cross round: A[k]/B[k]/… loser_to = cross[k]  (direct, no mirror on this side)
  for (const seq of repSeq) {
    if (seq.type !== 'cross') continue;
    const mainSlots = matchGrid[seq.mainRound];
    if (!mainSlots) continue;
    for (let k = 0; k < mainSlots.length && k < seq.ids.length; k++) {
      await patchMatch(client, mainSlots[k].id, { loser_to: seq.ids[k] });
    }
  }
}
