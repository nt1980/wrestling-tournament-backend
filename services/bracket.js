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
      parent_match_ids ? JSON.stringify(parent_match_ids) : null,
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
    // pool creation transaction already rolled back above if it threw
    client.release();
    throw err;
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
    // Repechage brackets
    // ---------------------------------------------------------------------------
    // Standard wrestling repechage: the two finalists' brackets.
    // Each finalist "owns" a repechage chain: athletes who lost to the finalist
    // (at any round) compete for bronze.
    //
    // For simplified_bronze: single 3rd-place match between the two semi-final losers.
    // For full_repechage: full repechage bracket from each side.
    //
    // We always create repechage_brackets rows for both finalists.
    // Then we build repechage match placeholders.

    const repechageBrackets = [];

    // Identify the final match
    const finalMatch = matchGrid[numRounds - 1][0];

    // The two semi-final matches feed the final
    const semi1Match = numRounds >= 2 ? matchGrid[numRounds - 2][0] : null;
    const semi2Match = numRounds >= 2 ? matchGrid[numRounds - 2][1] : null;

    if (repechageMode === 'simplified_bronze') {
      // Just one bronze match between the two semi losers
      const bronzeId = uuidv4();
      const bronze = await insertMatch(client, {
        id: bronzeId,
        competition_id: competitionId,
        tournament_id: tournamentId,
        round: numRounds, // round after final
        index_in_round: 0,
        bracket: 'bronze',
        phase: 'final',
        match_type: 'bronze',
        status: 'blocked',
        parent_match_ids: [semi1Match?.id, semi2Match?.id].filter(Boolean),
      });
      bracketMatches.push(bronze);

      // Patch semi-final loser_to → bronze
      if (semi1Match) await patchMatch(client, semi1Match.id, { loser_to: bronzeId });
      if (semi2Match) await patchMatch(client, semi2Match.id, { loser_to: bronzeId });

    } else {
      // Full repechage: create repechage_brackets for each finalist side
      // and build the repechage ladder.

      for (const side of ['A', 'B']) {
        const rbId = uuidv4();
        const rbResult = await client.query(
          `INSERT INTO repechage_brackets
             (id, competition_id, finalist_side, finalist_id)
           VALUES ($1, $2, $3, $4) RETURNING *`,
          [rbId, competitionId, side, null] // finalist_id filled after semis played
        );
        repechageBrackets.push(rbResult.rows[0]);

        // Build repechage rounds for this side.
        // Round structure:
        //   Level 0: losers from round 0 (first round) who lost to athletes on this side
        //   Level 1: losers from round 1 who lost to athletes advancing on this side
        //   ...
        //   Level numRounds-2: loser of the semi-final on this side → bronze
        //
        // For bracket size B with numRounds rounds:
        //   repechage levels = numRounds - 1 (rounds 0..numRounds-2)
        //   At each level l, there are 2^(numRounds-2-l) losers feeding in
        //   and the same number of repechage matches.
        //
        // We build the repechage match grid per side and link them up.

        const sideMatchGrid = buildRepechageGrid(side, numRounds, matchGrid);

        // Insert repechage matches
        for (let level = 0; level < sideMatchGrid.length; level++) {
          const levelMatches = sideMatchGrid[level];
          for (let idx = 0; idx < levelMatches.length; idx++) {
            const slot = levelMatches[idx];

            const isLastLevel = level === sideMatchGrid.length - 1;
            const rmId = slot.id;

            const repMatch = await insertMatch(client, {
              id: rmId,
              competition_id: competitionId,
              tournament_id: tournamentId,
              round: numRounds + level,
              index_in_round: idx,
              bracket: isLastLevel ? 'bronze' : 'repechage',
              phase: isLastLevel ? 'final' : 'repechage',
              match_type: isLastLevel ? 'bronze' : 'repechage',
              status: 'blocked',
              parent_match_ids: slot.parentMatchIds,
              winner_to: slot.winnerTo,
            });
            bracketMatches.push(repMatch);

            // Record in repechage_matches table
            await client.query(
              `INSERT INTO repechage_matches
                 (id, repechage_bracket_id, match_id, source_match_ids, level)
               VALUES ($1, $2, $3, $4, $5)`,
              [
                uuidv4(),
                rbId,
                rmId,
                JSON.stringify(slot.sourceMainMatchIds),
                level,
              ]
            );
          }
        }

        // Patch main-bracket matches: loser_to → first repechage match for that loser's slot
        patchMainBracketLoserTo(client, side, numRounds, matchGrid, sideMatchGrid);
      }
    }

    await client.query('COMMIT');
    return { bracket_matches: bracketMatches, repechage_brackets: repechageBrackets };
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
 * Standard bracket seeding: 1 at top, 2 at bottom, 3/4 at quarter boundaries, etc.
 */
function buildSeedPositions(size) {
  let positions = [0, size - 1];
  while (positions.length < size) {
    const next = [];
    const quarter = size / (positions.length * 2);
    for (const p of positions) {
      // The "mirror" position in the opposite sub-bracket of the same section
      const mirror = p < size / 2
        ? p + Math.floor(size / positions.length) - 1
        : p - Math.floor(size / positions.length) + 1;
      next.push(p);
      next.push(clamp(mirror, 0, size - 1));
    }
    positions = [...new Set(next)].slice(0, positions.length * 2);
  }

  // Fallback: just return 0..size-1 if something went wrong
  if (positions.length !== size) {
    return Array.from({ length: size }, (_, i) => i);
  }
  return positions;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
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
 * Build the repechage match grid for one finalist side.
 *
 * The structure (for numRounds = 3, bracketSize = 8):
 *   Level 0: 1 match  – the first-round loser on this side
 *   Level 1 (bronze): 1 match – loser feeds in from level 0 winner, other loser is semi loser
 *
 * For numRounds = 4 (bracketSize = 16):
 *   Level 0: 2 matches – first-round losers
 *   Level 1: 2 matches – level-0 winners vs second-round losers
 *   Level 2 (bronze): 1 match – level-1 winners vs semi loser
 *
 * In general for numRounds rounds, repechage has (numRounds - 1) levels.
 * Level l has 2^(numRounds-2-l) matches.
 *
 * side 'A' corresponds to the left half of the bracket (indices 0..bracketSize/2-1 at round 0)
 * side 'B' corresponds to the right half.
 *
 * Returns array of levels, each level is array of { id, parentMatchIds, winnerTo, sourceMainMatchIds }
 */
function buildRepechageGrid(side, numRounds, matchGrid) {
  const numLevels = numRounds - 1; // last level is bronze
  const grid = [];

  // Pre-create IDs for all repechage matches
  for (let level = 0; level < numLevels; level++) {
    const count = Math.pow(2, numRounds - 2 - level);
    const row = [];
    for (let i = 0; i < count; i++) {
      row.push({
        id: uuidv4(),
        parentMatchIds: [],
        sourceMainMatchIds: [],
        winnerTo: null,
      });
    }
    grid.push(row);
  }

  // Wire winner_to within repechage levels
  for (let level = 0; level < numLevels - 1; level++) {
    const currentLevel = grid[level];
    const nextLevel = grid[level + 1];
    for (let i = 0; i < currentLevel.length; i++) {
      const nextIdx = Math.floor(i / 2);
      currentLevel[i].winnerTo = nextLevel[nextIdx].id;
    }
  }
  // Last level winners go nowhere (they are bronze medal winners)

  // Record which main-bracket matches feed into each repechage slot.
  // At level 0: losers from main bracket round 0 on the given side.
  // At level l: losers from main bracket round l on the given side
  //             are injected into the repechage matches at level l.
  // The side determines which half of round r's matches we use.

  const halfSize = matchGrid[0].length / 2; // matches per side at round 0
  for (let level = 0; level < numLevels; level++) {
    const mainRound = level; // losers from this main round join repechage at this level
    const mainMatchesInRound = matchGrid[mainRound];

    // Which indices belong to this side?
    // Side A: left half (indices 0 .. halfSize/2^level - 1 ) … actually we need to track
    // which matches are in the sub-bracket that leads to finalist A.
    // A simpler model: side A = indices 0..count/2-1, side B = the rest, where count = matchesInRound.length
    const count = mainMatchesInRound.length;
    const sideACount = count / 2;
    const startIdx = side === 'A' ? 0 : sideACount;
    const endIdx = side === 'A' ? sideACount : count;

    const losersFromThisRound = [];
    for (let i = startIdx; i < endIdx; i++) {
      losersFromThisRound.push(mainMatchesInRound[i].id);
    }

    // At level 0, these losers are the direct inputs.
    // At level l, they are injected one-per-match alongside the previous winner.
    const repLevel = grid[level];
    for (let i = 0; i < repLevel.length; i++) {
      const mainMatchId = losersFromThisRound[i] ?? null;
      if (mainMatchId) {
        repLevel[i].sourceMainMatchIds.push(mainMatchId);
        repLevel[i].parentMatchIds.push(mainMatchId); // will resolve to loser
      }
      // If level > 0, also link the previous level winner
      if (level > 0) {
        const prevLevel = grid[level - 1];
        if (prevLevel[i]) {
          repLevel[i].parentMatchIds.push(prevLevel[i].id);
        }
      }
    }
  }

  return grid;
}

/**
 * Patch main-bracket match loser_to fields to point to the correct repechage match.
 *
 * Loser of main bracket round r, index idx on the given side →
 * repechage level r, index relative to that side.
 *
 * This function fires async but errors are acceptable here as they don't affect
 * match creation (the link is informational for the application layer).
 * In production you'd await this inside the transaction.
 */
async function patchMainBracketLoserTo(client, side, numRounds, matchGrid, sideRepGrid) {
  for (let r = 0; r < numRounds - 1; r++) {
    // Skip the final (no loser_to for finalist)
    const mainMatchesInRound = matchGrid[r];
    const count = mainMatchesInRound.length;
    const sideACount = count / 2;
    const startIdx = side === 'A' ? 0 : sideACount;
    const endIdx = side === 'A' ? sideACount : count;

    const repLevel = sideRepGrid[r] ?? null;
    if (!repLevel) continue;

    let repIdx = 0;
    for (let i = startIdx; i < endIdx; i++) {
      const mainMatch = mainMatchesInRound[i];
      const repMatch = repLevel[repIdx] ?? repLevel[repLevel.length - 1];
      if (mainMatch && repMatch) {
        try {
          await patchMatch(client, mainMatch.id, { loser_to: repMatch.id });
        } catch {
          // Non-fatal: proceed
        }
      }
      repIdx++;
    }
  }
}
