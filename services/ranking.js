import pool from '../db.js';

// Points de classement par type de victoire
const rankingPoints = (winType) => {
  switch (winType) {
    case 'fall': case 'dq': case 'forfeit': case 'abandon': return 5;
    case 'superiority': return 4;
    case 'points': return 3;
    default: return 0;
  }
};

// Calcul classement nordique / poules
export async function computePoolRankings(competitionId, poolId = null) {
  const matchFilter = poolId
    ? 'AND m.pool_id = $2'
    : "AND m.bracket = 'main' AND m.phase = 'pool'";
  const params = poolId ? [competitionId, poolId] : [competitionId];

  const matches = await pool.query(
    `SELECT m.*,
      ra.id as r_id, ra.first_name||' '||ra.last_name as r_name, rc.short_name as r_club,
      ba.id as b_id, ba.first_name||' '||ba.last_name as b_name, bc.short_name as b_club
     FROM matches m
     LEFT JOIN athletes ra ON ra.id = m.red_athlete_id
     LEFT JOIN clubs rc ON rc.id = ra.club_id
     LEFT JOIN athletes ba ON ba.id = m.blue_athlete_id
     LEFT JOIN clubs bc ON bc.id = ba.club_id
     WHERE m.competition_id = $1 ${matchFilter} AND m.status = 'finished' AND m.is_bye = false`,
    params
  );

  const stats = {};

  const ensure = (id, name, club) => {
    if (!stats[id]) stats[id] = { id, name, club, wins: 0, losses: 0, pts: 0, tech_pts: 0, tech_pts_against: 0, opponents: [] };
  };

  for (const m of matches.rows) {
    if (!m.red_athlete_id || !m.blue_athlete_id) continue;
    ensure(m.red_athlete_id, m.r_name, m.r_club);
    ensure(m.blue_athlete_id, m.b_name, m.b_club);

    const redWon = m.winner_id === m.red_athlete_id;
    const wtype = m.win_type;

    if (redWon) {
      stats[m.red_athlete_id].wins++;
      stats[m.red_athlete_id].pts += rankingPoints(wtype);
      stats[m.blue_athlete_id].losses++;
    } else {
      stats[m.blue_athlete_id].wins++;
      stats[m.blue_athlete_id].pts += rankingPoints(wtype);
      stats[m.red_athlete_id].losses++;
    }

    stats[m.red_athlete_id].tech_pts += m.score_red;
    stats[m.red_athlete_id].tech_pts_against += m.score_blue;
    stats[m.blue_athlete_id].tech_pts += m.score_blue;
    stats[m.blue_athlete_id].tech_pts_against += m.score_red;

    stats[m.red_athlete_id].opponents.push({ id: m.blue_athlete_id, won: redWon });
    stats[m.blue_athlete_id].opponents.push({ id: m.red_athlete_id, won: !redWon });
  }

  const ranked = Object.values(stats).sort((a, b) => {
    if (b.pts !== a.pts) return b.pts - a.pts;
    const aDiff = a.tech_pts - a.tech_pts_against;
    const bDiff = b.tech_pts - b.tech_pts_against;
    if (bDiff !== aDiff) return bDiff - aDiff;
    // Head-to-head
    const h2h = a.opponents.find(o => o.id === b.id);
    if (h2h) return h2h.won ? -1 : 1;
    return 0;
  });

  return ranked.map((r, i) => ({ ...r, rank: i + 1 }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Classement spécifique Jeunes (U9/U11)
// Victoire = 2 pts classement, Nul = 1 pt chacun, Défaite = 0 pt
// Tri : 1. pts classement (desc) → 2. goal average tech (desc) → 3. pts tech marqués (desc) → 4. face-à-face
// ─────────────────────────────────────────────────────────────────────────────
export async function computeJeunesPoolRankings(competitionId, poolId = null) {
  const matchFilter = poolId
    ? 'AND m.pool_id = $2'
    : "AND m.bracket = 'main' AND m.phase = 'pool'";
  const params = poolId ? [competitionId, poolId] : [competitionId];

  const matches = await pool.query(
    `SELECT m.*,
      ra.id as r_id, ra.first_name||' '||ra.last_name as r_name, rc.short_name as r_club,
      ba.id as b_id, ba.first_name||' '||ba.last_name as b_name, bc.short_name as b_club
     FROM matches m
     LEFT JOIN athletes ra ON ra.id = m.red_athlete_id
     LEFT JOIN clubs rc ON rc.id = ra.club_id
     LEFT JOIN athletes ba ON ba.id = m.blue_athlete_id
     LEFT JOIN clubs bc ON bc.id = ba.club_id
     WHERE m.competition_id = $1 ${matchFilter} AND m.status = 'finished' AND m.is_bye = false`,
    params
  );

  const stats = {};

  const ensure = (id, name, club) => {
    if (!stats[id]) stats[id] = {
      id, name, club,
      wins: 0, draws: 0, losses: 0,
      pts: 0,           // points de classement (2/1/0)
      tech_pts: 0,      // points techniques marqués (goal average numérateur)
      tech_pts_against: 0,
      opponents: [],
    };
  };

  for (const m of matches.rows) {
    if (!m.red_athlete_id || !m.blue_athlete_id) continue;
    ensure(m.red_athlete_id, m.r_name, m.r_club);
    ensure(m.blue_athlete_id, m.b_name, m.b_club);

    const isDraw = !m.winner_id;
    const redWon = m.winner_id === m.red_athlete_id;

    if (isDraw) {
      stats[m.red_athlete_id].draws++;
      stats[m.red_athlete_id].pts += 1;
      stats[m.blue_athlete_id].draws++;
      stats[m.blue_athlete_id].pts += 1;
    } else if (redWon) {
      stats[m.red_athlete_id].wins++;
      stats[m.red_athlete_id].pts += 2;
      stats[m.blue_athlete_id].losses++;
    } else {
      stats[m.blue_athlete_id].wins++;
      stats[m.blue_athlete_id].pts += 2;
      stats[m.red_athlete_id].losses++;
    }

    stats[m.red_athlete_id].tech_pts         += Number(m.score_red  ?? 0);
    stats[m.red_athlete_id].tech_pts_against += Number(m.score_blue ?? 0);
    stats[m.blue_athlete_id].tech_pts         += Number(m.score_blue ?? 0);
    stats[m.blue_athlete_id].tech_pts_against += Number(m.score_red  ?? 0);

    stats[m.red_athlete_id].opponents.push({ id: m.blue_athlete_id, won: redWon && !isDraw });
    stats[m.blue_athlete_id].opponents.push({ id: m.red_athlete_id, won: !redWon && !isDraw });
  }

  const ranked = Object.values(stats).sort((a, b) => {
    // 1. Points de classement (desc)
    if (b.pts !== a.pts) return b.pts - a.pts;
    // 2. Goal average = pts tech. marqués − pts tech. encaissés (desc)
    const aDiff = a.tech_pts - a.tech_pts_against;
    const bDiff = b.tech_pts - b.tech_pts_against;
    if (bDiff !== aDiff) return bDiff - aDiff;
    // 3. Points techniques marqués (desc)
    if (b.tech_pts !== a.tech_pts) return b.tech_pts - a.tech_pts;
    // 4. Face-à-face
    const h2h = a.opponents.find(o => o.id === b.id);
    if (h2h) return h2h.won ? -1 : 1;
    return 0;
  });

  return ranked.map((r, i) => ({ ...r, rank: i + 1 }));
}

// Classement final d'une compétition tableau
export async function computeBracketRankings(competitionId) {
  // Trouver les médaillés depuis les matchs de finale et bronze
  const final = await pool.query(
    `SELECT * FROM matches WHERE competition_id=$1 AND match_type='final' AND status='finished'`,
    [competitionId]
  );
  const bronzes = await pool.query(
    `SELECT * FROM matches WHERE competition_id=$1 AND match_type='bronze' AND status='finished' ORDER BY created_at`,
    [competitionId]
  );

  const results = [];
  if (final.rows.length) {
    const f = final.rows[0];
    results.push({ rank: 1, athlete_id: f.winner_id });
    results.push({ rank: 2, athlete_id: f.loser_id });
  }
  bronzes.rows.forEach(b => {
    results.push({ rank: 3, athlete_id: b.winner_id });
  });

  return results;
}
