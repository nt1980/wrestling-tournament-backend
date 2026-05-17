import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { parse as csvParse } from 'csv-parse/sync';

dotenv.config();

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

const verifyToken = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token requis' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token invalide' });
  }
};

const isSuperAdmin = async (userId) => {
  const r = await pool.query(
    "SELECT 1 FROM global_roles WHERE user_id=$1 AND role='super_admin'",
    [userId]
  );
  return r.rowCount > 0;
};

const hasTournamentRole = async (userId, tournamentId, roles = []) => {
  if (await isSuperAdmin(userId)) return true;
  const r = await pool.query(
    'SELECT 1 FROM tournament_users WHERE user_id=$1 AND tournament_id=$2 AND role=ANY($3)',
    [userId, tournamentId, roles]
  );
  return r.rowCount > 0;
};

const audit = async (tournamentId, userId, action, entityType, entityId, oldData = null, newData = null) => {
  await pool.query(
    'INSERT INTO audit_logs(tournament_id,user_id,action,entity_type,entity_id,old_data,new_data) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [tournamentId, userId, action, entityType, entityId, oldData ? JSON.stringify(oldData) : null, newData ? JSON.stringify(newData) : null]
  );
};

const broadcastToTournament = (tournamentId, data) => {
  for (const [ws, meta] of wsClients) {
    if (meta.tournamentId === tournamentId && ws.readyState === 1) {
      ws.send(JSON.stringify(data));
    }
  }
};

const generateSlug = (text) => {
  return text
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
};

// ─────────────────────────────────────────────
// HEALTH
// ─────────────────────────────────────────────

app.get('/api/health', (_, res) => res.json({ status: 'ok', timestamp: new Date() }));

// ─────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis' });

    const r = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
    if (!r.rows.length) return res.status(401).json({ error: 'Identifiants invalides' });

    const user = r.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Identifiants invalides' });

    const rolesR = await pool.query('SELECT role FROM global_roles WHERE user_id=$1', [user.id]);
    const globalRoles = rolesR.rows.map(r => r.role);

    const token = jwt.sign({ userId: user.id, email: user.email, globalRoles }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, email: user.email, name: user.name, globalRoles } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/auth/me', verifyToken, async (req, res) => {
  try {
    const r = await pool.query('SELECT id,email,name,created_at FROM users WHERE id=$1', [req.user.userId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Utilisateur introuvable' });
    const rolesR = await pool.query('SELECT role FROM global_roles WHERE user_id=$1', [req.user.userId]);
    res.json({ ...r.rows[0], globalRoles: rolesR.rows.map(r => r.role) });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─────────────────────────────────────────────
// USERS (admin)
// ─────────────────────────────────────────────

app.get('/api/users', verifyToken, async (req, res) => {
  try {
    if (!await isSuperAdmin(req.user.userId)) return res.status(403).json({ error: 'Accès refusé' });
    const r = await pool.query('SELECT u.id,u.email,u.name,u.created_at, array_agg(gr.role) FILTER (WHERE gr.role IS NOT NULL) as global_roles FROM users u LEFT JOIN global_roles gr ON gr.user_id=u.id GROUP BY u.id ORDER BY u.name');
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/users', verifyToken, async (req, res) => {
  try {
    if (!await isSuperAdmin(req.user.userId)) return res.status(403).json({ error: 'Accès refusé' });
    const { email, password, name, role } = req.body;
    if (!email || !password || !name) return res.status(400).json({ error: 'Champs requis manquants' });
    const hash = await bcrypt.hash(password, 10);
    const id = uuidv4();
    await pool.query('INSERT INTO users(id,email,password_hash,name) VALUES($1,$2,$3,$4)', [id, email, hash, name]);
    if (role) await pool.query('INSERT INTO global_roles(user_id,role) VALUES($1,$2) ON CONFLICT DO NOTHING', [id, role]);
    res.status(201).json({ id, email, name });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Email déjà utilisé' });
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.delete('/api/users/:id', verifyToken, async (req, res) => {
  try {
    if (!await isSuperAdmin(req.user.userId)) return res.status(403).json({ error: 'Accès refusé' });
    await pool.query('DELETE FROM users WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─────────────────────────────────────────────
// CLUBS
// ─────────────────────────────────────────────

app.get('/api/clubs', async (req, res) => {
  try {
    const { search } = req.query;
    let q = 'SELECT * FROM clubs';
    const params = [];
    if (search) { q += ' WHERE name ILIKE $1 OR short_name ILIKE $1'; params.push(`%${search}%`); }
    q += ' ORDER BY name';
    const r = await pool.query(q, params);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/clubs', verifyToken, async (req, res) => {
  try {
    const { fflda_number, short_name, name, regional_committee, city, country, coach_name } = req.body;
    if (!short_name || !name) return res.status(400).json({ error: 'short_name et name requis' });
    const r = await pool.query(
      'INSERT INTO clubs(id,fflda_number,short_name,name,regional_committee,city,country,coach_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(fflda_number) DO UPDATE SET name=EXCLUDED.name,short_name=EXCLUDED.short_name,regional_committee=EXCLUDED.regional_committee,city=EXCLUDED.city,coach_name=EXCLUDED.coach_name RETURNING *',
      [uuidv4(), fflda_number || null, short_name, name, regional_committee || null, city || null, country || 'France', coach_name || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.put('/api/clubs/:id', verifyToken, async (req, res) => {
  try {
    const { short_name, name, regional_committee, city, country, coach_name } = req.body;
    const r = await pool.query(
      'UPDATE clubs SET short_name=$1,name=$2,regional_committee=$3,city=$4,country=$5,coach_name=$6,updated_at=now() WHERE id=$7 RETURNING *',
      [short_name, name, regional_committee, city, country, coach_name, req.params.id]
    );
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─────────────────────────────────────────────
// TOURNAMENTS
// ─────────────────────────────────────────────

app.get('/api/tournaments', async (req, res) => {
  try {
    const { public_only } = req.query;
    let q = `SELECT t.*,c.name as organizer_club_name,c.short_name as organizer_club_short FROM tournaments t LEFT JOIN clubs c ON c.id=t.organizer_club_id`;
    if (public_only === 'true') q += ` WHERE t.public_page_enabled=true`;
    q += ` ORDER BY t.event_date DESC`;
    const r = await pool.query(q);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/tournaments/:id', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT t.*,c.name as organizer_club_name,c.short_name as organizer_club_short,c.logo_url as organizer_logo FROM tournaments t LEFT JOIN clubs c ON c.id=t.organizer_club_id WHERE t.id=$1 OR t.slug=$1`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Tournoi introuvable' });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/tournaments', verifyToken, async (req, res) => {
  try {
    if (!await isSuperAdmin(req.user.userId)) return res.status(403).json({ error: 'Accès refusé' });
    const { name, event_date, city, organizer_club_id, number_of_mats = 1 } = req.body;
    if (!name || !event_date || !city) return res.status(400).json({ error: 'name, event_date, city requis' });

    const baseSlug = generateSlug(`${name}-${city}`);
    let slug = baseSlug;
    let i = 1;
    while ((await pool.query('SELECT 1 FROM tournaments WHERE slug=$1', [slug])).rowCount > 0) {
      slug = `${baseSlug}-${i++}`;
    }

    const id = uuidv4();
    const r = await pool.query(
      'INSERT INTO tournaments(id,name,slug,event_date,city,organizer_club_id,number_of_mats,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [id, name, slug, event_date, city, organizer_club_id || null, number_of_mats, req.user.userId]
    );

    // Créer les tapis automatiquement
    const matNames = 'ABCDEFGHIJKLMNOP'.split('').slice(0, number_of_mats);
    for (const matName of matNames) {
      await pool.query(
        'INSERT INTO mats(id,tournament_id,name,slug) VALUES($1,$2,$3,$4)',
        [uuidv4(), id, `Tapis ${matName}`, `mat-${matName.toLowerCase()}`]
      );
    }

    await audit(id, req.user.userId, 'CREATE', 'tournament', id, null, r.rows[0]);
    res.status(201).json(r.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.put('/api/tournaments/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    if (!await hasTournamentRole(req.user.userId, id, ['tournament_admin'])) return res.status(403).json({ error: 'Accès refusé' });
    const { name, event_date, city, organizer_club_id, status, number_of_mats,
      public_page_enabled, public_program_enabled, public_results_enabled,
      public_live_matches_enabled, public_rankings_enabled, repechage_mode } = req.body;

    const r = await pool.query(
      `UPDATE tournaments SET
        name=COALESCE($1,name), event_date=COALESCE($2,event_date), city=COALESCE($3,city),
        organizer_club_id=COALESCE($4,organizer_club_id), status=COALESCE($5,status),
        number_of_mats=COALESCE($6,number_of_mats),
        public_page_enabled=COALESCE($7,public_page_enabled),
        public_program_enabled=COALESCE($8,public_program_enabled),
        public_results_enabled=COALESCE($9,public_results_enabled),
        public_live_matches_enabled=COALESCE($10,public_live_matches_enabled),
        public_rankings_enabled=COALESCE($11,public_rankings_enabled),
        repechage_mode=COALESCE($12,repechage_mode),
        updated_at=now()
      WHERE id=$13 RETURNING *`,
      [name, event_date, city, organizer_club_id, status, number_of_mats,
       public_page_enabled, public_program_enabled, public_results_enabled,
       public_live_matches_enabled, public_rankings_enabled, repechage_mode, id]
    );
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─────────────────────────────────────────────
// TOURNAMENT USERS (rôles)
// ─────────────────────────────────────────────

app.get('/api/tournaments/:id/users', verifyToken, async (req, res) => {
  try {
    if (!await hasTournamentRole(req.user.userId, req.params.id, ['tournament_admin'])) return res.status(403).json({ error: 'Accès refusé' });
    const r = await pool.query(
      'SELECT tu.*,u.name,u.email FROM tournament_users tu JOIN users u ON u.id=tu.user_id WHERE tu.tournament_id=$1 ORDER BY u.name',
      [req.params.id]
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/tournaments/:id/users', verifyToken, async (req, res) => {
  try {
    if (!await hasTournamentRole(req.user.userId, req.params.id, ['tournament_admin'])) return res.status(403).json({ error: 'Accès refusé' });
    const { user_id, role } = req.body;
    const r = await pool.query(
      'INSERT INTO tournament_users(id,tournament_id,user_id,role) VALUES($1,$2,$3,$4) ON CONFLICT(tournament_id,user_id,role) DO NOTHING RETURNING *',
      [uuidv4(), req.params.id, user_id, role]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.delete('/api/tournaments/:id/users/:userId', verifyToken, async (req, res) => {
  try {
    if (!await hasTournamentRole(req.user.userId, req.params.id, ['tournament_admin'])) return res.status(403).json({ error: 'Accès refusé' });
    await pool.query('DELETE FROM tournament_users WHERE tournament_id=$1 AND user_id=$2', [req.params.id, req.params.userId]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─────────────────────────────────────────────
// MATS
// ─────────────────────────────────────────────

app.get('/api/tournaments/:id/mats', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM mats WHERE tournament_id=$1 ORDER BY name', [req.params.id]);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/tournaments/:id/mats', verifyToken, async (req, res) => {
  try {
    if (!await hasTournamentRole(req.user.userId, req.params.id, ['tournament_admin', 'mat_manager'])) return res.status(403).json({ error: 'Accès refusé' });
    const { name } = req.body;
    const slug = generateSlug(name);
    const r = await pool.query(
      'INSERT INTO mats(id,tournament_id,name,slug) VALUES($1,$2,$3,$4) RETURNING *',
      [uuidv4(), req.params.id, name, slug]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─────────────────────────────────────────────
// ATHLETES
// ─────────────────────────────────────────────

app.get('/api/athletes', verifyToken, async (req, res) => {
  try {
    const { search, club_id } = req.query;
    let q = 'SELECT a.*,c.name as club_name,c.short_name as club_short FROM athletes a LEFT JOIN clubs c ON c.id=a.club_id WHERE 1=1';
    const params = [];
    if (search) { params.push(`%${search}%`); q += ` AND (a.last_name ILIKE $${params.length} OR a.first_name ILIKE $${params.length} OR a.license_number ILIKE $${params.length})`; }
    if (club_id) { params.push(club_id); q += ` AND a.club_id=$${params.length}`; }
    q += ' ORDER BY a.last_name,a.first_name LIMIT 200';
    const r = await pool.query(q, params);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/athletes', verifyToken, async (req, res) => {
  try {
    const { license_number, first_name, last_name, gender, nationality, birth_date, style,
      age_category_imported, licensed_age_category, mastery_level, default_weight_kg, license_status, club_id } = req.body;
    if (!license_number || !first_name || !last_name || !gender) return res.status(400).json({ error: 'Champs requis manquants' });
    const r = await pool.query(
      `INSERT INTO athletes(id,license_number,first_name,last_name,gender,nationality,birth_date,style,age_category_imported,licensed_age_category,mastery_level,default_weight_kg,license_status,club_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT(license_number) DO UPDATE SET first_name=EXCLUDED.first_name,last_name=EXCLUDED.last_name,gender=EXCLUDED.gender,nationality=EXCLUDED.nationality,birth_date=EXCLUDED.birth_date,style=EXCLUDED.style,age_category_imported=EXCLUDED.age_category_imported,licensed_age_category=EXCLUDED.licensed_age_category,mastery_level=EXCLUDED.mastery_level,default_weight_kg=EXCLUDED.default_weight_kg,license_status=EXCLUDED.license_status,club_id=EXCLUDED.club_id,updated_at=now()
       RETURNING *`,
      [uuidv4(), license_number, first_name, last_name, gender, nationality || 'France', birth_date || null, style || null,
       age_category_imported || null, licensed_age_category || null, mastery_level || null, default_weight_kg || null, license_status || null, club_id || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─────────────────────────────────────────────
// IMPORT CSV FFLDA
// ─────────────────────────────────────────────

const normalizeStyle = (s) => {
  if (!s) return null;
  const v = s.toLowerCase().trim();
  if (v.includes('libre')) return 'libre';
  if (v.includes('greco') || v.includes('gréco')) return 'greco';
  if (v.includes('féminin') || v.includes('feminin') || v.includes('feminine')) return 'feminine';
  if (v.includes('jeune')) return 'jeune';
  if (v.includes('grappling')) return 'grappling';
  if (v.includes('jjb')) return 'jjb';
  return null;
};

const normalizeGender = (s) => {
  if (!s) return null;
  const v = s.toLowerCase().trim();
  if (v.startsWith('m') || v === 'masculin') return 'M';
  if (v.startsWith('f') || v === 'féminin' || v === 'feminin') return 'F';
  return null;
};

const normalizeWeight = (s) => {
  if (!s) return null;
  const v = s.toString().replace(',', '.').trim();
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
};

const normalizeDate = (s) => {
  if (!s) return null;
  const parts = s.split('/');
  if (parts.length === 3) return `${parts[2]}-${parts[1]}-${parts[0]}`;
  return null;
};

const IGNORED_COLS = ['Photo', 'Assurance', 'Mail', 'Téléphone', 'Actions'];

app.post('/api/import/athletes', verifyToken, async (req, res) => {
  try {
    const { csv_data } = req.body;
    if (!csv_data) return res.status(400).json({ error: 'csv_data requis' });

    const records = csvParse(csv_data, { columns: true, skip_empty_lines: true, delimiter: ';', relax_quotes: true });
    let created = 0, updated = 0, errors = [];

    for (const row of records) {
      try {
        const fflda_number = row['N° Club']?.trim();
        const short_name = row['Sigle du Club']?.trim();
        const club_name = row['Nom du Club']?.trim();
        const regional_committee = row['Comité Régional']?.trim();

        let club_id = null;
        if (fflda_number || club_name) {
          const club = await pool.query(
            'INSERT INTO clubs(id,fflda_number,short_name,name,regional_committee) VALUES($1,$2,$3,$4,$5) ON CONFLICT(fflda_number) DO UPDATE SET name=EXCLUDED.name,short_name=EXCLUDED.short_name RETURNING id',
            [uuidv4(), fflda_number || null, short_name || '', club_name || '', regional_committee || null]
          );
          club_id = club.rows[0].id;
        }

        const license_number = row['N° Licence']?.trim();
        if (!license_number) continue;

        const existing = await pool.query('SELECT id FROM athletes WHERE license_number=$1', [license_number]);
        const athleteData = {
          license_number,
          first_name: row['Prénom']?.trim(),
          last_name: row['Nom']?.trim(),
          gender: normalizeGender(row['Sexe']),
          nationality: row['Nationalité']?.trim() || 'France',
          birth_date: normalizeDate(row['Date de naissance']),
          style: normalizeStyle(row['Style']),
          age_category_imported: row['Catégorie d\'âge']?.trim(),
          licensed_age_category: row['Cat âge licencié']?.trim(),
          mastery_level: row['Maîtrise']?.trim(),
          default_weight_kg: normalizeWeight(row['Poids']),
          license_status: row['Statut']?.trim(),
          club_id,
        };

        if (existing.rowCount > 0) {
          await pool.query(
            'UPDATE athletes SET first_name=$1,last_name=$2,gender=$3,nationality=$4,birth_date=$5,style=$6,age_category_imported=$7,licensed_age_category=$8,mastery_level=$9,default_weight_kg=$10,license_status=$11,club_id=$12,updated_at=now() WHERE license_number=$13',
            [athleteData.first_name, athleteData.last_name, athleteData.gender, athleteData.nationality, athleteData.birth_date,
             athleteData.style, athleteData.age_category_imported, athleteData.licensed_age_category, athleteData.mastery_level,
             athleteData.default_weight_kg, athleteData.license_status, club_id, license_number]
          );
          updated++;
        } else {
          await pool.query(
            'INSERT INTO athletes(id,license_number,first_name,last_name,gender,nationality,birth_date,style,age_category_imported,licensed_age_category,mastery_level,default_weight_kg,license_status,club_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
            [uuidv4(), license_number, athleteData.first_name, athleteData.last_name, athleteData.gender, athleteData.nationality,
             athleteData.birth_date, athleteData.style, athleteData.age_category_imported, athleteData.licensed_age_category,
             athleteData.mastery_level, athleteData.default_weight_kg, athleteData.license_status, club_id]
          );
          created++;
        }
      } catch (rowErr) {
        errors.push({ row: row['N° Licence'], error: rowErr.message });
      }
    }
    res.json({ created, updated, errors });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur import' });
  }
});

// ─────────────────────────────────────────────
// TOURNAMENT REGISTRATIONS
// ─────────────────────────────────────────────

app.get('/api/tournaments/:id/registrations', verifyToken, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT tr.*,a.first_name,a.last_name,a.license_number,a.gender,a.birth_date,a.default_weight_kg,
              c.name as club_name,c.short_name as club_short
       FROM tournament_registrations tr
       JOIN athletes a ON a.id=tr.athlete_id
       LEFT JOIN clubs c ON c.id=a.club_id
       WHERE tr.tournament_id=$1
       ORDER BY a.last_name,a.first_name`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/tournaments/:id/registrations', verifyToken, async (req, res) => {
  try {
    if (!await hasTournamentRole(req.user.userId, req.params.id, ['tournament_admin', 'weigh_in_manager'])) return res.status(403).json({ error: 'Accès refusé' });
    const { athlete_id, final_age_category, final_weight_category, final_style } = req.body;
    const r = await pool.query(
      'INSERT INTO tournament_registrations(id,tournament_id,athlete_id,final_age_category,final_weight_category,final_style) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tournament_id,athlete_id) DO NOTHING RETURNING *',
      [uuidv4(), req.params.id, athlete_id, final_age_category || null, final_weight_category || null, final_style || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/tournaments/:id/registrations/import', verifyToken, async (req, res) => {
  try {
    if (!await hasTournamentRole(req.user.userId, req.params.id, ['tournament_admin'])) return res.status(403).json({ error: 'Accès refusé' });
    const { csv_data } = req.body;
    const records = csvParse(csv_data, { columns: true, skip_empty_lines: true, delimiter: ';', relax_quotes: true });
    let registered = 0, errors = [];

    for (const row of records) {
      try {
        const license_number = row['N° Licence']?.trim();
        if (!license_number) continue;
        const athlete = await pool.query('SELECT id FROM athletes WHERE license_number=$1', [license_number]);
        if (!athlete.rowCount) continue;
        const athleteId = athlete.rows[0].id;
        await pool.query(
          'INSERT INTO tournament_registrations(id,tournament_id,athlete_id,final_style,final_age_category) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
          [uuidv4(), req.params.id, athleteId, normalizeStyle(row['Style']), row['Catégorie d\'âge']?.trim() || null]
        );
        registered++;
      } catch (rowErr) {
        errors.push({ license: row['N° Licence'], error: rowErr.message });
      }
    }
    res.json({ registered, errors });
  } catch (e) {
    res.status(500).json({ error: 'Erreur import inscriptions' });
  }
});

// PESÉE
app.put('/api/tournaments/:id/registrations/:regId/weigh-in', verifyToken, async (req, res) => {
  try {
    if (!await hasTournamentRole(req.user.userId, req.params.id, ['tournament_admin', 'weigh_in_manager'])) return res.status(403).json({ error: 'Accès refusé' });
    const { weigh_in_weight_kg, weigh_in_status, final_weight_category } = req.body;
    const r = await pool.query(
      'UPDATE tournament_registrations SET weigh_in_weight_kg=$1,weigh_in_status=$2,final_weight_category=COALESCE($3,final_weight_category),updated_at=now() WHERE id=$4 AND tournament_id=$5 RETURNING *',
      [weigh_in_weight_kg, weigh_in_status || 'done', final_weight_category || null, req.params.regId, req.params.id]
    );
    broadcastToTournament(req.params.id, { type: 'weigh_in_updated', registration: r.rows[0] });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Stats inscriptions par club
app.get('/api/tournaments/:id/stats/clubs', verifyToken, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT c.id,c.name,c.short_name,COUNT(tr.id) as total,
        jsonb_object_agg(COALESCE(tr.final_age_category,'?'), cnt) as by_category
       FROM tournament_registrations tr
       JOIN athletes a ON a.id=tr.athlete_id
       LEFT JOIN clubs c ON c.id=a.club_id
       JOIN (SELECT tournament_id,final_age_category,COUNT(*) as cnt FROM tournament_registrations WHERE tournament_id=$1 GROUP BY tournament_id,final_age_category) sub ON sub.tournament_id=tr.tournament_id AND sub.final_age_category IS NOT DISTINCT FROM tr.final_age_category
       WHERE tr.tournament_id=$1
       GROUP BY c.id,c.name,c.short_name ORDER BY total DESC`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─────────────────────────────────────────────
// COMPETITIONS — GÉNÉRATION AUTOMATIQUE
// ─────────────────────────────────────────────

app.post('/api/tournaments/:id/competitions/generate', verifyToken, async (req, res) => {
  try {
    if (!await hasTournamentRole(req.user.userId, req.params.id, ['tournament_admin'])) return res.status(403).json({ error: 'Accès refusé' });
    const tournamentId = req.params.id;

    // Récupérer tous les inscrits pesés
    const regs = await pool.query(
      `SELECT tr.*,a.style,a.gender FROM tournament_registrations tr JOIN athletes a ON a.id=tr.athlete_id
       WHERE tr.tournament_id=$1 AND tr.weigh_in_status='done' AND tr.final_age_category IS NOT NULL AND tr.final_weight_category IS NOT NULL`,
      [tournamentId]
    );

    // Grouper par style+gender+age_category+weight_category
    const groups = {};
    for (const reg of regs.rows) {
      const style = reg.final_style || reg.style;
      const key = `${style}|${reg.gender}|${reg.final_age_category}|${reg.final_weight_category}`;
      if (!groups[key]) groups[key] = { style, gender: reg.gender, age_category: reg.final_age_category, weight_category: reg.final_weight_category, athletes: [] };
      groups[key].athletes.push(reg);
    }

    const created = [];
    for (const [, group] of Object.entries(groups)) {
      const count = group.athletes.length;
      let format = 'nordic';
      if (count >= 6 && count <= 8) format = 'pools_finals';
      if (count >= 9) format = 'bracket_repechage';

      const compR = await pool.query(
        `INSERT INTO competitions(id,tournament_id,style,gender,age_category,weight_category,format_type,athlete_count)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT(tournament_id,style,gender,age_category,weight_category) DO UPDATE SET format_type=EXCLUDED.format_type,athlete_count=EXCLUDED.athlete_count,updated_at=now()
         RETURNING *`,
        [uuidv4(), tournamentId, group.style, group.gender, group.age_category, group.weight_category, format, count]
      );
      const comp = compR.rows[0];

      // Lier les inscriptions à la compétition
      for (const reg of group.athletes) {
        await pool.query('UPDATE tournament_registrations SET competition_id=$1 WHERE id=$2', [comp.id, reg.id]);
      }
      created.push(comp);
    }

    await audit(tournamentId, req.user.userId, 'GENERATE_COMPETITIONS', 'tournament', tournamentId, null, { count: created.length });
    res.json({ created: created.length, competitions: created });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur génération' });
  }
});

app.get('/api/tournaments/:id/competitions', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT *,(SELECT COUNT(*) FROM tournament_registrations WHERE competition_id=competitions.id) as athlete_count FROM competitions WHERE tournament_id=$1 ORDER BY age_category,weight_category,style',
      [req.params.id]
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─────────────────────────────────────────────
// MATCHES — RÉCUPÉRATION
// ─────────────────────────────────────────────

app.get('/api/competitions/:compId/matches', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT m.*,
        r.first_name||' '||r.last_name as red_name, rc.short_name as red_club,
        b.first_name||' '||b.last_name as blue_name, bc.short_name as blue_club,
        w.first_name||' '||w.last_name as winner_name,
        mt.name as mat_name
       FROM matches m
       LEFT JOIN athletes r ON r.id=m.red_athlete_id
       LEFT JOIN clubs rc ON rc.id=r.club_id
       LEFT JOIN athletes b ON b.id=m.blue_athlete_id
       LEFT JOIN clubs bc ON bc.id=b.club_id
       LEFT JOIN athletes w ON w.id=m.winner_id
       LEFT JOIN mats mt ON mt.id=m.mat_id
       WHERE m.competition_id=$1
       ORDER BY m.bracket,m.round,m.index_in_round`,
      [req.params.compId]
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─────────────────────────────────────────────
// MATCH RESULT — SAISIE ARBITRE
// ─────────────────────────────────────────────

app.put('/api/matches/:matchId/result', verifyToken, async (req, res) => {
  try {
    const { matchId } = req.params;
    const matchR = await pool.query('SELECT * FROM matches WHERE id=$1', [matchId]);
    if (!matchR.rows.length) return res.status(404).json({ error: 'Combat introuvable' });
    const match = matchR.rows[0];

    if (!await hasTournamentRole(req.user.userId, match.tournament_id, ['tournament_admin', 'referee', 'mat_manager'])) return res.status(403).json({ error: 'Accès refusé' });

    const { winner_id, loser_id, score_red, score_blue, win_type } = req.body;
    if (!winner_id) return res.status(400).json({ error: 'winner_id requis' });

    // Sauvegarder historique
    await pool.query(
      'INSERT INTO match_results(id,match_id,winner_id,loser_id,score_red,score_blue,win_type,recorded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [uuidv4(), matchId, winner_id, loser_id || null, score_red || 0, score_blue || 0, win_type || null, req.user.userId]
    );

    // Mettre à jour le match
    await pool.query(
      'UPDATE matches SET winner_id=$1,loser_id=$2,score_red=$3,score_blue=$4,win_type=$5,status=\'finished\',ended_at=now(),updated_at=now() WHERE id=$6',
      [winner_id, loser_id || null, score_red || 0, score_blue || 0, win_type || null, matchId]
    );

    // Avancer le vainqueur dans le tableau
    if (match.winner_to) {
      const nextMatch = await pool.query('SELECT * FROM matches WHERE id=$1', [match.winner_to]);
      if (nextMatch.rows.length) {
        const nm = nextMatch.rows[0];
        if (!nm.red_athlete_id) {
          await pool.query('UPDATE matches SET red_athlete_id=$1,updated_at=now() WHERE id=$2', [winner_id, nm.id]);
        } else if (!nm.blue_athlete_id) {
          await pool.query('UPDATE matches SET blue_athlete_id=$1,updated_at=now() WHERE id=$2', [winner_id, nm.id]);
        }
        // Débloquer si les deux participants sont connus
        const updated = await pool.query('SELECT * FROM matches WHERE id=$1', [nm.id]);
        if (updated.rows[0].red_athlete_id && updated.rows[0].blue_athlete_id) {
          await pool.query('UPDATE matches SET status=\'ready\',updated_at=now() WHERE id=$1', [nm.id]);
          // Ajouter à la queue
          await pool.query(
            'INSERT INTO match_queue(id,tournament_id,match_id,position,status) SELECT $1,$2,$3,COALESCE((SELECT MAX(position)+1 FROM match_queue WHERE tournament_id=$2),1),\'ready\' WHERE NOT EXISTS(SELECT 1 FROM match_queue WHERE match_id=$3)',
            [uuidv4(), match.tournament_id, nm.id]
          );
        }
      }
    }

    // Mettre à jour queue du match actuel
    await pool.query('UPDATE match_queue SET status=\'finished\',updated_at=now() WHERE match_id=$1', [matchId]);

    const updated = await pool.query('SELECT * FROM matches WHERE id=$1', [matchId]);
    broadcastToTournament(match.tournament_id, { type: 'match_finished', match: updated.rows[0] });
    await audit(match.tournament_id, req.user.userId, 'MATCH_RESULT', 'match', matchId, match, updated.rows[0]);

    res.json(updated.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─────────────────────────────────────────────
// MATCH QUEUE
// ─────────────────────────────────────────────

app.get('/api/tournaments/:id/queue', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT mq.*,m.score_red,m.score_blue,m.status as match_status,m.bracket,m.match_type,
        r.first_name||' '||r.last_name as red_name, rc.short_name as red_club,
        b.first_name||' '||b.last_name as blue_name, bc.short_name as blue_club,
        mt.name as mat_name,
        comp.style,comp.age_category,comp.weight_category,comp.gender
       FROM match_queue mq
       JOIN matches m ON m.id=mq.match_id
       LEFT JOIN athletes r ON r.id=m.red_athlete_id
       LEFT JOIN clubs rc ON rc.id=r.club_id
       LEFT JOIN athletes b ON b.id=m.blue_athlete_id
       LEFT JOIN clubs bc ON bc.id=b.club_id
       LEFT JOIN mats mt ON mt.id=mq.mat_id
       LEFT JOIN competitions comp ON comp.id=m.competition_id
       WHERE mq.tournament_id=$1 AND mq.status NOT IN ('finished')
       ORDER BY mq.mat_id NULLS LAST,mq.position`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.put('/api/queue/:queueId/assign-mat', verifyToken, async (req, res) => {
  try {
    const { mat_id } = req.body;
    const r = await pool.query(
      'UPDATE match_queue SET mat_id=$1,status=\'on_mat\',updated_at=now() WHERE id=$2 RETURNING *',
      [mat_id, req.params.queueId]
    );
    await pool.query('UPDATE matches SET mat_id=$1,status=\'on_mat\',updated_at=now() WHERE id=$2', [mat_id, r.rows[0].match_id]);
    broadcastToTournament(r.rows[0].tournament_id, { type: 'match_assigned', queue: r.rows[0] });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─────────────────────────────────────────────
// VUE TAPIS (public)
// ─────────────────────────────────────────────

app.get('/api/mats/:matId/live', async (req, res) => {
  try {
    const current = await pool.query(
      `SELECT m.*,mq.position,
        r.first_name||' '||r.last_name as red_name, rc.short_name as red_club,
        b.first_name||' '||b.last_name as blue_name, bc.short_name as blue_club,
        comp.style,comp.age_category,comp.weight_category,comp.gender
       FROM matches m
       JOIN match_queue mq ON mq.match_id=m.id
       LEFT JOIN athletes r ON r.id=m.red_athlete_id LEFT JOIN clubs rc ON rc.id=r.club_id
       LEFT JOIN athletes b ON b.id=m.blue_athlete_id LEFT JOIN clubs bc ON bc.id=b.club_id
       LEFT JOIN competitions comp ON comp.id=m.competition_id
       WHERE mq.mat_id=$1 AND mq.status='on_mat'
       ORDER BY mq.position LIMIT 1`,
      [req.params.matId]
    );
    const next = await pool.query(
      `SELECT m.*,mq.position,
        r.first_name||' '||r.last_name as red_name,
        b.first_name||' '||b.last_name as blue_name,
        comp.style,comp.age_category,comp.weight_category
       FROM matches m
       JOIN match_queue mq ON mq.match_id=m.id
       LEFT JOIN athletes r ON r.id=m.red_athlete_id
       LEFT JOIN athletes b ON b.id=m.blue_athlete_id
       LEFT JOIN competitions comp ON comp.id=m.competition_id
       WHERE mq.mat_id=$1 AND mq.status='ready'
       ORDER BY mq.position LIMIT 3`,
      [req.params.matId]
    );
    res.json({ current: current.rows[0] || null, next: next.rows });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─────────────────────────────────────────────
// RÉSULTATS PUBLICS
// ─────────────────────────────────────────────

app.get('/api/tournaments/:id/results', async (req, res) => {
  try {
    const tournament = await pool.query('SELECT public_results_enabled FROM tournaments WHERE id=$1 OR slug=$1', [req.params.id]);
    if (!tournament.rows.length) return res.status(404).json({ error: 'Tournoi introuvable' });
    if (!tournament.rows[0].public_results_enabled) return res.status(403).json({ error: 'Résultats non publics' });

    const r = await pool.query(
      `SELECT m.*,
        r.first_name||' '||r.last_name as red_name, rc.short_name as red_club,
        b.first_name||' '||b.last_name as blue_name, bc.short_name as blue_club,
        w.first_name||' '||w.last_name as winner_name,
        comp.style,comp.age_category,comp.weight_category
       FROM matches m
       LEFT JOIN athletes r ON r.id=m.red_athlete_id LEFT JOIN clubs rc ON rc.id=r.club_id
       LEFT JOIN athletes b ON b.id=m.blue_athlete_id LEFT JOIN clubs bc ON bc.id=b.club_id
       LEFT JOIN athletes w ON w.id=m.winner_id
       LEFT JOIN competitions comp ON comp.id=m.competition_id
       WHERE m.tournament_id=$1 AND m.status='finished'
       ORDER BY m.ended_at DESC`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─────────────────────────────────────────────
// DASHBOARD STATS
// ─────────────────────────────────────────────

app.get('/api/tournaments/:id/dashboard', verifyToken, async (req, res) => {
  try {
    const [athletes, clubs, comps, matchesTotal, matchesDone, matsActive] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM tournament_registrations WHERE tournament_id=$1', [req.params.id]),
      pool.query('SELECT COUNT(DISTINCT a.club_id) FROM tournament_registrations tr JOIN athletes a ON a.id=tr.athlete_id WHERE tr.tournament_id=$1', [req.params.id]),
      pool.query('SELECT COUNT(*) FROM competitions WHERE tournament_id=$1', [req.params.id]),
      pool.query('SELECT COUNT(*) FROM matches WHERE tournament_id=$1 AND is_bye=false', [req.params.id]),
      pool.query("SELECT COUNT(*) FROM matches WHERE tournament_id=$1 AND status='finished' AND is_bye=false", [req.params.id]),
      pool.query("SELECT COUNT(*) FROM mats WHERE tournament_id=$1 AND is_active=true", [req.params.id]),
    ]);
    res.json({
      athletes: parseInt(athletes.rows[0].count),
      clubs: parseInt(clubs.rows[0].count),
      competitions: parseInt(comps.rows[0].count),
      matches_total: parseInt(matchesTotal.rows[0].count),
      matches_done: parseInt(matchesDone.rows[0].count),
      mats_active: parseInt(matsActive.rows[0].count),
    });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─────────────────────────────────────────────
// AUDIT LOGS
// ─────────────────────────────────────────────

app.get('/api/tournaments/:id/audit', verifyToken, async (req, res) => {
  try {
    if (!await hasTournamentRole(req.user.userId, req.params.id, ['tournament_admin'])) return res.status(403).json({ error: 'Accès refusé' });
    const r = await pool.query(
      'SELECT al.*,u.name as user_name FROM audit_logs al LEFT JOIN users u ON u.id=al.user_id WHERE al.tournament_id=$1 ORDER BY al.created_at DESC LIMIT 200',
      [req.params.id]
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─────────────────────────────────────────────
// WEBSOCKET
// ─────────────────────────────────────────────

const wsClients = new Map();

wss.on('connection', (ws, req) => {
  const tournamentId = new URL(req.url, 'http://x').searchParams.get('tournament');
  wsClients.set(ws, { tournamentId });

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
    } catch {}
  });

  ws.on('close', () => wsClients.delete(ws));
  ws.on('error', () => wsClients.delete(ws));
  ws.send(JSON.stringify({ type: 'connected', tournamentId }));
});

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`🏆 Lutte API démarrée sur le port ${PORT}`);
  console.log(`📍 Health: http://localhost:${PORT}/api/health`);
});

export default app;
