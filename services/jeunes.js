import pool from '../db.js';
import { v4 as uuidv4 } from 'uuid';

// ---------------------------------------------------------------------------
// Pool generation — Jeunes (U9 / U11)
// ---------------------------------------------------------------------------
// Rules:
//  • Max 4 athletes per pool
//  • weight_max ≤ weight_min × 1.10  (10 % spread)
//  • Prefer same-gender pools; overflow athletes are merged into mixed pools
//  • Only athletes with weigh_in_status = 'done'
// ---------------------------------------------------------------------------

/**
 * Generate Jeunes pools for a tournament.
 *
 * @param {string}   tournamentId
 * @param {object}   options
 * @param {boolean}  options.reset            – delete existing jeunes data first
 * @param {string[]} options.age_categories   – default ['U9','U11']
 * @returns {Promise<{pools_created, unassigned_count}>}
 */
export async function generateJeunesPools(tournamentId, options = {}) {
  const { reset = false, age_categories = ['U9', 'U11'], tolerance = 10.0 } = options;
  const tolFactor = 1 + tolerance / 100; // ex. 10 → 1.10

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (reset) await _deleteJeunesPools(client, tournamentId);

    // ── Fetch eligible athletes ──────────────────────────────────────────────
    const { rows: athletes } = await client.query(`
      SELECT
        tr.id                                              AS reg_id,
        tr.athlete_id,
        tr.final_age_category                             AS age_category,
        tr.weigh_in_weight_kg::NUMERIC(6,2)               AS weight,
        a.first_name || ' ' || a.last_name                AS name,
        a.gender,
        COALESCE(c.short_name, c.name, '—')               AS club
      FROM tournament_registrations tr
      JOIN athletes a ON a.id = tr.athlete_id
      LEFT JOIN clubs c ON c.id = a.club_id
      WHERE tr.tournament_id = $1
        AND tr.weigh_in_status = 'done'
        AND tr.final_age_category = ANY($2)
        AND tr.weigh_in_weight_kg IS NOT NULL
      ORDER BY tr.final_age_category, a.gender, tr.weigh_in_weight_kg::NUMERIC
    `, [tournamentId, age_categories]);

    // ── Group and form pools ─────────────────────────────────────────────────
    const allPools      = [];
    const allUnassigned = [];

    for (const ageCat of age_categories) {
      const group = athletes.filter(a => a.age_category === ageCat);
      if (!group.length) continue;

      const girls = group.filter(a => a.gender === 'F').sort((a, b) => +a.weight - +b.weight);
      const boys  = group.filter(a => a.gender === 'M').sort((a, b) => +a.weight - +b.weight);

      const girlResult  = _formPools(girls, ageCat, 'F', tolFactor);
      const boyResult   = _formPools(boys,  ageCat, 'M', tolFactor);

      // Overflow from single-gender passes → try to pair them in mixed pools
      const overflow = [...girlResult.unassigned, ...boyResult.unassigned]
        .sort((a, b) => +a.weight - +b.weight);
      const mixedResult = _formPools(overflow, ageCat, 'MX', tolFactor);

      allPools.push(...girlResult.pools, ...boyResult.pools, ...mixedResult.pools);
      allUnassigned.push(...mixedResult.unassigned);
    }

    // ── Persist valid pools ──────────────────────────────────────────────────
    let poolsCreated = 0;
    let displayOrder = 1;

    if (!reset) {
      const { rows } = await client.query(
        `SELECT COALESCE(MAX(display_order),0) AS m FROM jeunes_pools WHERE tournament_id=$1`,
        [tournamentId]
      );
      displayOrder = Number(rows[0].m) + 1;
    }

    for (const pg of allPools) {
      if (pg.athletes.length < 2) { allUnassigned.push(...pg.athletes); continue; }

      const ws   = pg.athletes.map(a => +a.weight);
      const wMin = Math.min(...ws);
      const wMax = Math.max(...ws);

      // competition (source = 'jeunes')
      const compId = uuidv4();
      await client.query(`
        INSERT INTO competitions(id,tournament_id,style,gender,age_category,weight_category,format_type,source)
        VALUES($1,$2,'libre',$3,$4,$5,'nordic','jeunes')
      `, [compId, tournamentId,
          pg.gender === 'MX' ? 'MX' : pg.gender,
          pg.ageCat,
          `${wMin.toFixed(1)}-${wMax.toFixed(1)}`]);

      // pool
      const poolId = uuidv4();
      await client.query(`
        INSERT INTO pools(id,competition_id,tournament_id,name,status)
        VALUES($1,$2,$3,$4,'active')
      `, [poolId, compId, tournamentId, `Poule ${displayOrder}`]);

      // pool_athletes + registration link
      for (let i = 0; i < pg.athletes.length; i++) {
        const a = pg.athletes[i];
        await client.query(
          `INSERT INTO pool_athletes(id,pool_id,athlete_id,seed_order) VALUES($1,$2,$3,$4)`,
          [uuidv4(), poolId, a.athlete_id, i + 1]
        );
        await client.query(
          `UPDATE tournament_registrations SET competition_id=$1 WHERE id=$2`,
          [compId, a.reg_id]
        );
      }

      // jeunes_pools metadata
      await client.query(`
        INSERT INTO jeunes_pools(id,tournament_id,competition_id,pool_id,age_category,weight_min,weight_max,gender_strategy,display_order)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
      `, [uuidv4(), tournamentId, compId, poolId, pg.ageCat, wMin, wMax,
          pg.gender === 'MX' ? 'mixed' : (pg.gender === 'F' ? 'girls_first' : 'boys_only'),
          displayOrder]);

      poolsCreated++;
      displayOrder++;
    }

    // ── Unassigned ───────────────────────────────────────────────────────────
    for (const a of allUnassigned) {
      await client.query(`
        INSERT INTO jeunes_unassigned(id,tournament_id,registration_id,athlete_id,age_category,weigh_in_weight,reason)
        VALUES($1,$2,$3,$4,$5,$6,'no_pool_fit')
        ON CONFLICT (registration_id) DO NOTHING
      `, [uuidv4(), tournamentId, a.reg_id, a.athlete_id, a.age_category, a.weight]);
    }

    await client.query('COMMIT');
    return { pools_created: poolsCreated, unassigned_count: allUnassigned.length };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Sliding-window pool formation with optimal even splitting.
 *
 * Algorithm:
 *  1. Find the maximum contiguous window starting at i where
 *     max_weight ≤ min_weight × 1.10  (all within 10 % tolerance).
 *  2. Split that window evenly into sub-pools of ≤ 4 athletes:
 *       5 athletes → 3 + 2
 *       6 athletes → 3 + 3
 *       7 athletes → 4 + 3
 *       8 athletes → 4 + 4   etc.
 *  3. Lone athletes (window of 1) try to join the previous pool;
 *     otherwise go to unassigned.
 *
 * @param {object[]} athletes  – sorted by weight ASC, must have .weight
 * @param {string}   ageCat
 * @param {string}   gender    – 'F' | 'M' | 'MX'
 * @returns {{ pools, unassigned }}
 */
function _formPools(athletes, ageCat, gender, tolFactor = 1.10) {
  const pools = [], unassigned = [];
  if (!athletes.length) return { pools, unassigned };

  let i = 0;
  while (i < athletes.length) {
    // Find max window where all fit within tolerance (athletes are sorted ASC)
    const wBase = +athletes[i].weight;
    let j = i + 1;
    while (j < athletes.length && +athletes[j].weight <= wBase * tolFactor) j++;

    const group = athletes.slice(i, j);

    if (group.length === 1) {
      // Single athlete — try to absorb into most recent pool if it has room
      let absorbed = false;
      for (let pi = pools.length - 1; pi >= 0; pi--) {
        const p = pools[pi];
        if (p.athletes.length < 4) {
          const ws = [...p.athletes.map(a => +a.weight), +group[0].weight];
          if (Math.max(...ws) <= Math.min(...ws) * tolFactor) {
            p.athletes.push(group[0]);
            absorbed = true;
            break;
          }
        }
      }
      if (!absorbed) unassigned.push(...group);
    } else {
      // Split group evenly into sub-pools of ≤ 4 — larger pools first
      const numSub  = Math.ceil(group.length / 4);
      const base    = Math.floor(group.length / numSub);
      const extra   = group.length % numSub; // first `extra` pools get +1
      let start = 0;
      for (let p = 0; p < numSub; p++) {
        const size = base + (p < extra ? 1 : 0);
        pools.push({ athletes: group.slice(start, start + size), ageCat, gender });
        start += size;
      }
    }
    i = j;
  }

  return { pools, unassigned };
}

/**
 * Delete all jeunes data for a tournament (used by reset and DELETE endpoint).
 */
export async function deleteJeunesPools(tournamentId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await _deleteJeunesPools(client, tournamentId);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function _deleteJeunesPools(client, tournamentId) {
  // Reset competition_id on registrations
  await client.query(`
    UPDATE tournament_registrations SET competition_id=NULL
    WHERE tournament_id=$1
      AND competition_id IN (SELECT id FROM competitions WHERE tournament_id=$1 AND source='jeunes')
  `, [tournamentId]);

  await client.query(`
    DELETE FROM match_queue WHERE match_id IN (
      SELECT m.id FROM matches m
      JOIN competitions c ON c.id=m.competition_id
      WHERE c.tournament_id=$1 AND c.source='jeunes'
    )
  `, [tournamentId]);

  await client.query(`
    DELETE FROM matches WHERE competition_id IN (
      SELECT id FROM competitions WHERE tournament_id=$1 AND source='jeunes'
    )
  `, [tournamentId]);

  await client.query(`
    DELETE FROM pool_athletes WHERE pool_id IN (
      SELECT p.id FROM pools p
      JOIN competitions c ON c.id=p.competition_id
      WHERE c.tournament_id=$1 AND c.source='jeunes'
    )
  `, [tournamentId]);

  await client.query(`
    DELETE FROM pools WHERE competition_id IN (
      SELECT id FROM competitions WHERE tournament_id=$1 AND source='jeunes'
    )
  `, [tournamentId]);

  await client.query(
    `DELETE FROM competitions WHERE tournament_id=$1 AND source='jeunes'`,
    [tournamentId]
  );

  await client.query(
    `DELETE FROM jeunes_unassigned WHERE tournament_id=$1`,
    [tournamentId]
  );
}

/**
 * Check pool constraints — returns array of violation strings (empty = OK).
 */
export function checkPoolConstraints(athletes, ageCategory) {
  const violations = [];
  if (athletes.length > 4) violations.push(`Trop d'athlètes (${athletes.length}/4 max)`);
  if (athletes.length < 2) violations.push('Moins de 2 athlètes');
  const ws = athletes.map(a => +a.weight).filter(Boolean);
  if (ws.length > 1) {
    const spread = Math.max(...ws) / Math.min(...ws);
    if (spread > 1.10) violations.push(`Écart de poids > 10 % (${((spread-1)*100).toFixed(1)} %)`);
  }
  const ages = [...new Set(athletes.map(a => a.age_category))];
  if (ages.length > 1) violations.push(`Catégories d'âge mixtes (${ages.join(', ')})`);
  return violations;
}
