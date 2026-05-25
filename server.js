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
import { generateNordic, generatePoolsAndFinals, generateBracket } from './services/bracket.js';
import { computePoolRankings, computeBracketRankings } from './services/ranking.js';
import { generateJeunesPools, deleteJeunesPools } from './services/jeunes.js';

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

// Vérifie qu'un utilisateur a AU MOINS UN rôle sur ce tournoi (lecture)
const canAccessTournament = async (userId, tournamentId) => {
  if (await isSuperAdmin(userId)) return true;
  const r = await pool.query(
    'SELECT 1 FROM tournament_users WHERE user_id=$1 AND tournament_id=$2',
    [userId, tournamentId]
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

    // Endpoint public : pages publiques uniquement
    if (public_only === 'true') {
      const r = await pool.query(
        `SELECT t.*,c.name as organizer_club_name,c.short_name as organizer_club_short
         FROM tournaments t LEFT JOIN clubs c ON c.id=t.organizer_club_id
         WHERE t.public_page_enabled=true ORDER BY t.event_date DESC`
      );
      return res.json(r.rows);
    }

    // Endpoint privé : authentification requise
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Token requis' });
    let decoded;
    try { decoded = jwt.verify(token, JWT_SECRET); }
    catch { return res.status(401).json({ error: 'Token invalide' }); }

    const userId = decoded.userId;
    let r;

    if (await isSuperAdmin(userId)) {
      // Super admin : voit tout
      r = await pool.query(
        `SELECT t.*,c.name as organizer_club_name,c.short_name as organizer_club_short
         FROM tournaments t LEFT JOIN clubs c ON c.id=t.organizer_club_id
         ORDER BY t.event_date DESC`
      );
    } else {
      // Utilisateur normal : uniquement les tournois auxquels il est affecté
      r = await pool.query(
        `SELECT DISTINCT t.*,c.name as organizer_club_name,c.short_name as organizer_club_short
         FROM tournaments t
         LEFT JOIN clubs c ON c.id=t.organizer_club_id
         JOIN tournament_users tu ON tu.tournament_id=t.id AND tu.user_id=$1
         ORDER BY t.event_date DESC`,
        [userId]
      );
    }
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

    // Créer les tapis automatiquement (slug global unique)
    const matNames = 'ABCDEFGHIJKLMNOP'.split('').slice(0, number_of_mats);
    for (const matName of matNames) {
      const fullName = `Tapis ${matName}`;
      const baseMatSlug = generateSlug(fullName); // 'tapis-a', 'tapis-b'…
      let matSlug = baseMatSlug; let msi = 2;
      while ((await pool.query('SELECT 1 FROM mats WHERE slug=$1', [matSlug])).rowCount > 0) {
        matSlug = `${baseMatSlug}-${msi++}`;
      }
      await pool.query(
        'INSERT INTO mats(id,tournament_id,name,slug) VALUES($1,$2,$3,$4)',
        [uuidv4(), id, fullName, matSlug]
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
      public_live_matches_enabled, public_rankings_enabled, repechage_mode,
      min_rest_minutes, jeunes_weight_tolerance } = req.body;

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
        min_rest_minutes=COALESCE($13,min_rest_minutes),
        jeunes_weight_tolerance=COALESCE($14,jeunes_weight_tolerance),
        updated_at=now()
      WHERE id=$15 RETURNING *`,
      [name, event_date, city, organizer_club_id, status, number_of_mats,
       public_page_enabled, public_program_enabled, public_results_enabled,
       public_live_matches_enabled, public_rankings_enabled, repechage_mode,
       min_rest_minutes != null ? parseInt(min_rest_minutes) : null,
       jeunes_weight_tolerance != null ? parseFloat(jeunes_weight_tolerance) : null,
       id]
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
    // mat_manager et tournament_admin peuvent voir la liste des utilisateurs du tournoi
    if (!await hasTournamentRole(req.user.userId, req.params.id, ['tournament_admin', 'mat_manager'])) return res.status(403).json({ error: 'Accès refusé' });
    const r = await pool.query(
      'SELECT tu.*, u.name AS user_name, u.email AS user_email FROM tournament_users tu JOIN users u ON u.id=tu.user_id WHERE tu.tournament_id=$1 ORDER BY u.name',
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

    const { user_id, email, name, password, role } = req.body;
    if (!role) return res.status(400).json({ error: 'role requis' });

    let targetUserId = user_id;

    // Mode création/recherche par email (accessible à l'admin tournoi)
    if (!targetUserId && email && name) {
      const existing = await pool.query('SELECT id FROM users WHERE email=$1', [email]);
      if (existing.rows.length > 0) {
        // Compte existant → on réutilise (le mot de passe n'est pas modifié)
        targetUserId = existing.rows[0].id;
      } else {
        // Nouveau compte
        if (!password) return res.status(400).json({ error: 'Mot de passe requis pour créer un compte' });
        const hash = await bcrypt.hash(password, 10);
        targetUserId = uuidv4();
        await pool.query(
          'INSERT INTO users(id,email,password_hash,name) VALUES($1,$2,$3,$4)',
          [targetUserId, email, hash, name]
        );
      }
    }

    if (!targetUserId) return res.status(400).json({ error: 'user_id ou email/name requis' });

    const r = await pool.query(
      'INSERT INTO tournament_users(id,tournament_id,user_id,role) VALUES($1,$2,$3,$4) ON CONFLICT(tournament_id,user_id,role) DO NOTHING RETURNING *',
      [uuidv4(), req.params.id, targetUserId, role]
    );
    res.status(201).json(r.rows[0] ?? { tournament_id: req.params.id, user_id: targetUserId, role });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Email déjà utilisé' });
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
    const r = await pool.query(
      `SELECT m.*, u.id as referee_id, u.name as referee_name
       FROM mats m
       LEFT JOIN users u ON u.id = m.referee_id
       WHERE m.tournament_id = $1 ORDER BY m.name`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/tournaments/:id/mats', verifyToken, async (req, res) => {
  try {
    if (!await hasTournamentRole(req.user.userId, req.params.id, ['tournament_admin', 'mat_manager'])) return res.status(403).json({ error: 'Accès refusé' });
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Nom requis' });
    // Slug from name — globally unique across all tournaments
    const baseSlug = generateSlug(name.trim()) || 'tapis';
    let slug = baseSlug;
    let si = 2;
    while ((await pool.query('SELECT 1 FROM mats WHERE slug=$1', [slug])).rowCount > 0) {
      slug = `${baseSlug}-${si++}`;
    }
    const r = await pool.query(
      'INSERT INTO mats(id,tournament_id,name,slug) VALUES($1,$2,$3,$4) RETURNING *',
      [uuidv4(), req.params.id, name.trim(), slug]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Renommer un tapis
app.put('/api/mats/:matId', verifyToken, async (req, res) => {
  try {
    const matR = await pool.query('SELECT * FROM mats WHERE id=$1', [req.params.matId]);
    if (!matR.rows.length) return res.status(404).json({ error: 'Tapis introuvable' });
    const mat = matR.rows[0];

    if (!await hasTournamentRole(req.user.userId, mat.tournament_id, ['tournament_admin', 'mat_manager'])) {
      return res.status(403).json({ error: 'Accès refusé' });
    }

    const { name, is_active, slug } = req.body;
    if (name !== undefined && !name.trim()) return res.status(400).json({ error: 'Nom invalide' });

    // Ajouter la colonne is_active si elle n'existe pas encore
    await pool.query(`ALTER TABLE mats ADD COLUMN IF NOT EXISTS is_active boolean DEFAULT true`).catch(() => {});

    const updates = [];
    const params = [];
    if (name !== undefined) { params.push(name.trim()); updates.push(`name=$${params.length}`); }
    if (is_active !== undefined) { params.push(is_active); updates.push(`is_active=$${params.length}`); }
    if (slug !== undefined) {
      const cleanSlug = slug.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
      if (!cleanSlug || cleanSlug.length < 1 || cleanSlug.length > 50)
        return res.status(400).json({ error: 'Slug invalide (1-50 caractères, lettres minuscules, chiffres et tirets)' });
      // Global uniqueness (exclude current mat)
      const existing = await pool.query('SELECT id FROM mats WHERE slug=$1 AND id!=$2', [cleanSlug, req.params.matId]);
      if (existing.rowCount > 0) return res.status(409).json({ error: 'Ce slug est déjà utilisé par un autre tapis' });
      params.push(cleanSlug); updates.push(`slug=$${params.length}`);
    }
    if (updates.length === 0) return res.status(400).json({ error: 'Aucune donnée à mettre à jour' });

    params.push(req.params.matId);
    const r = await pool.query(
      `UPDATE mats SET ${updates.join(',')} WHERE id=$${params.length} RETURNING *`,
      params
    );
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Supprimer un tapis
app.delete('/api/mats/:matId', verifyToken, async (req, res) => {
  try {
    const matR = await pool.query('SELECT * FROM mats WHERE id=$1', [req.params.matId]);
    if (!matR.rows.length) return res.status(404).json({ error: 'Tapis introuvable' });
    const mat = matR.rows[0];

    if (!await hasTournamentRole(req.user.userId, mat.tournament_id, ['tournament_admin'])) {
      return res.status(403).json({ error: 'Accès refusé' });
    }

    // Bloquer si combat on_mat sur ce tapis
    const activeR = await pool.query(
      `SELECT COUNT(*) as cnt FROM match_queue WHERE mat_id=$1 AND status='on_mat'`,
      [req.params.matId]
    );
    if (parseInt(activeR.rows[0].cnt) > 0) {
      return res.status(409).json({ error: 'Un combat est en cours sur ce tapis — terminez-le avant de supprimer' });
    }

    // Désaffecter les combats en attente sur ce tapis → queue globale
    await pool.query(
      `UPDATE match_queue SET mat_id=NULL,status='ready',updated_at=now() WHERE mat_id=$1 AND status='ready'`,
      [req.params.matId]
    );
    await pool.query(
      `UPDATE matches SET mat_id=NULL,status='ready',updated_at=now() WHERE mat_id=$1 AND status='ready'`,
      [req.params.matId]
    );

    await pool.query('DELETE FROM mats WHERE id=$1', [req.params.matId]);
    broadcastToTournament(mat.tournament_id, { type: 'mat_deleted', mat_id: req.params.matId });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─────────────────────────────────────────────
// AFFECTATION ARBITRE À UN TAPIS
// ─────────────────────────────────────────────

// Affecter / désaffecter un arbitre sur un tapis
app.put('/api/mats/:matId/referee', verifyToken, async (req, res) => {
  try {
    const matR = await pool.query('SELECT * FROM mats WHERE id=$1', [req.params.matId]);
    if (!matR.rows.length) return res.status(404).json({ error: 'Tapis introuvable' });
    const mat = matR.rows[0];

    if (!await hasTournamentRole(req.user.userId, mat.tournament_id, ['tournament_admin', 'mat_manager'])) {
      return res.status(403).json({ error: 'Accès refusé' });
    }

    // Bloquer si un combat est en cours sur ce tapis
    const activeR = await pool.query(
      `SELECT COUNT(*) as cnt FROM match_queue WHERE mat_id=$1 AND status='on_mat'`,
      [req.params.matId]
    );
    if (parseInt(activeR.rows[0].cnt) > 0) {
      return res.status(409).json({ error: 'Un combat est en cours — impossible de changer l\'arbitre maintenant' });
    }

    const { referee_id } = req.body; // null = désaffecter
    const r = await pool.query(
      `UPDATE mats SET referee_id=$1 WHERE id=$2 RETURNING *`,
      [referee_id || null, req.params.matId]
    );

    broadcastToTournament(mat.tournament_id, { type: 'mat_referee_changed', mat_id: req.params.matId, referee_id: referee_id || null });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Récupérer le tapis affecté à l'arbitre connecté (pour le redirect post-login)
app.get('/api/users/me/referee-mat', verifyToken, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT m.id as mat_id, m.name as mat_name, m.tournament_id, t.name as tournament_name, t.slug as tournament_slug
       FROM mats m
       JOIN tournaments t ON t.id = m.tournament_id
       WHERE m.referee_id = $1
       LIMIT 1`,
      [req.user.userId]
    );
    res.json(r.rows[0] || null);
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

app.put('/api/athletes/:id', verifyToken, async (req, res) => {
  try {
    const { first_name, last_name, gender, nationality, birth_date, style, age_category_imported, licensed_age_category, mastery_level, default_weight_kg, license_status, club_id } = req.body;
    const r = await pool.query(
      'UPDATE athletes SET first_name=$1,last_name=$2,gender=$3,nationality=$4,birth_date=$5,style=$6,age_category_imported=$7,licensed_age_category=$8,mastery_level=$9,default_weight_kg=$10,license_status=$11,club_id=$12,updated_at=now() WHERE id=$13 RETURNING *',
      [first_name, last_name, gender, nationality, birth_date, style, age_category_imported, licensed_age_category, mastery_level, default_weight_kg, license_status, club_id, req.params.id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Athlète non trouvé' });
    res.json(r.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.delete('/api/athletes/:id', verifyToken, async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM athletes WHERE id=$1 RETURNING id', [req.params.id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Athlète non trouvé' });
    res.json({ deleted: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.delete('/api/athletes', verifyToken, async (req, res) => {
  try {
    if (!await isSuperAdmin(req.user.userId)) return res.status(403).json({ error: 'Accès refusé' });
    const r = await pool.query('DELETE FROM athletes');
    res.json({ deleted: r.rowCount });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─────────────────────────────────────────────
// CLUBS MANAGEMENT
// ─────────────────────────────────────────────

app.put('/api/clubs/:id', verifyToken, async (req, res) => {
  try {
    const { fflda_number, short_name, name, regional_committee } = req.body;
    const r = await pool.query(
      'UPDATE clubs SET fflda_number=$1,short_name=$2,name=$3,regional_committee=$4,updated_at=now() WHERE id=$5 RETURNING *',
      [fflda_number || null, short_name, name, regional_committee || null, req.params.id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Club non trouvé' });
    res.json(r.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.delete('/api/clubs/:id', verifyToken, async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM clubs WHERE id=$1 RETURNING id', [req.params.id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Club non trouvé' });
    res.json({ deleted: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.delete('/api/clubs', verifyToken, async (req, res) => {
  try {
    if (!await isSuperAdmin(req.user.userId)) return res.status(403).json({ error: 'Accès refusé' });
    const r = await pool.query('DELETE FROM clubs');
    res.json({ deleted: r.rowCount });
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

const detectDelimiter = (csv_data) => {
  const firstLine = csv_data.split('\n')[0];
  const semicolonCount = (firstLine.match(/;/g) || []).length;
  const commaCount = (firstLine.match(/,/g) || []).length;
  return semicolonCount > commaCount ? ';' : ',';
};

const normalizeColumnName = (name) => {
  return name?.trim().toLowerCase().replace(/[éèê]/g, 'e').replace(/[àâ]/g, 'a').replace(/[ôo]/g, 'o').replace(/ç/g, 'c') || '';
};

const getColumnValue = (row, possibleNames) => {
  const normalizedRow = {};
  for (const key in row) {
    normalizedRow[normalizeColumnName(key)] = row[key];
  }
  for (const name of possibleNames) {
    const normalized = normalizeColumnName(name);
    if (normalizedRow[normalized] !== undefined) {
      return normalizedRow[normalized];
    }
  }
  return null;
};

app.post('/api/import/athletes', verifyToken, async (req, res) => {
  try {
    const { csv_data } = req.body;
    if (!csv_data) return res.status(400).json({ error: 'csv_data requis' });

    const delimiter = detectDelimiter(csv_data);
    const records = csvParse(csv_data, { columns: true, skip_empty_lines: true, delimiter, relax_quotes: true });
    let created = 0, updated = 0, errors = [];

    for (const row of records) {
      try {
        const fflda_number = getColumnValue(row, ['N° Club', 'N Club', 'Numero Club'])?.trim();
        const short_name = getColumnValue(row, ['Sigle du Club', 'Sigle Club', 'Club Sigle'])?.trim();
        const club_name = getColumnValue(row, ['Nom du Club', 'Nom Club', 'Club Name'])?.trim();
        const regional_committee = getColumnValue(row, ['Comité Régional', 'Comite Regional', 'Regional Committee'])?.trim();

        let club_id = null;
        if (club_name) {
          let clubResult;
          if (fflda_number) {
            clubResult = await pool.query(
              'SELECT id FROM clubs WHERE fflda_number=$1 LIMIT 1',
              [fflda_number]
            );
            if (clubResult.rowCount > 0) {
              club_id = clubResult.rows[0].id;
              await pool.query(
                'UPDATE clubs SET name=$1,short_name=$2,regional_committee=$3 WHERE id=$4',
                [club_name || '', short_name || '', regional_committee || null, club_id]
              );
            } else {
              const newClub = await pool.query(
                'INSERT INTO clubs(id,fflda_number,short_name,name,regional_committee) VALUES($1,$2,$3,$4,$5) RETURNING id',
                [uuidv4(), fflda_number, short_name || '', club_name, regional_committee || null]
              );
              club_id = newClub.rows[0].id;
            }
          } else {
            clubResult = await pool.query(
              'SELECT id FROM clubs WHERE name=$1 LIMIT 1',
              [club_name]
            );
            if (clubResult.rowCount > 0) {
              club_id = clubResult.rows[0].id;
              await pool.query(
                'UPDATE clubs SET short_name=$1,regional_committee=$2 WHERE id=$3',
                [short_name || '', regional_committee || null, club_id]
              );
            } else {
              const newClub = await pool.query(
                'INSERT INTO clubs(id,short_name,name,regional_committee) VALUES($1,$2,$3,$4) RETURNING id',
                [uuidv4(), short_name || '', club_name, regional_committee || null]
              );
              club_id = newClub.rows[0].id;
            }
          }
        }

        const license_number = getColumnValue(row, ['N° Licence', 'N Licence', 'License Number'])?.trim();
        if (!license_number) continue;

        const existing = await pool.query('SELECT id FROM athletes WHERE license_number=$1', [license_number]);
        const athleteData = {
          license_number,
          first_name: getColumnValue(row, ['Prénom', 'Prenom', 'First Name'])?.trim(),
          last_name: getColumnValue(row, ['Nom', 'Name'])?.trim(),
          gender: normalizeGender(getColumnValue(row, ['Sexe', 'Gender'])),
          nationality: getColumnValue(row, ['Nationalité', 'Nationalite', 'Nationality'])?.trim() || 'France',
          birth_date: normalizeDate(getColumnValue(row, ['Date de naissance', 'Date Naissance', 'Birth Date'])),
          style: normalizeStyle(getColumnValue(row, ['Style'])),
          age_category_imported: getColumnValue(row, ['Catégorie d\'âge', 'Categorie age', 'Age Category'])?.trim(),
          licensed_age_category: getColumnValue(row, ['Cat âge licencié', 'Cat age licencie', 'Licensed Age Category'])?.trim(),
          mastery_level: getColumnValue(row, ['Maîtrise', 'Maitrise', 'Mastery'])?.trim(),
          default_weight_kg: normalizeWeight(getColumnValue(row, ['Poids', 'Weight'])),
          license_status: getColumnValue(row, ['Statut', 'Status'])?.trim(),
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
    if (!await canAccessTournament(req.user.userId, req.params.id)) return res.status(403).json({ error: 'Accès refusé' });
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
    const delimiter = detectDelimiter(csv_data);
    const records = csvParse(csv_data, { columns: true, skip_empty_lines: true, delimiter, relax_quotes: true });
    let registered = 0, errors = [];

    for (const row of records) {
      try {
        const license_number = getColumnValue(row, ['N° Licence', 'N Licence', 'License Number'])?.trim();
        if (!license_number) continue;
        const athlete = await pool.query('SELECT id FROM athletes WHERE license_number=$1', [license_number]);
        if (!athlete.rowCount) continue;
        const athleteId = athlete.rows[0].id;
        await pool.query(
          'INSERT INTO tournament_registrations(id,tournament_id,athlete_id,final_style,final_age_category) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
          [uuidv4(), req.params.id, athleteId, normalizeStyle(getColumnValue(row, ['Style'])), getColumnValue(row, ['Catégorie d\'âge', 'Categorie age', 'Age Category'])?.trim() || null]
        );
        registered++;
      } catch (rowErr) {
        errors.push({ license: license_number, error: rowErr.message });
      }
    }
    res.json({ registered, errors });
  } catch (e) {
    res.status(500).json({ error: 'Erreur import inscriptions' });
  }
});

app.delete('/api/tournaments/:id/registrations/:regId', verifyToken, async (req, res) => {
  try {
    if (!await hasTournamentRole(req.user.userId, req.params.id, ['tournament_admin'])) return res.status(403).json({ error: 'Accès refusé' });
    const r = await pool.query('DELETE FROM tournament_registrations WHERE id=$1 AND tournament_id=$2 RETURNING id', [req.params.regId, req.params.id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Inscription non trouvée' });
    res.json({ deleted: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.delete('/api/tournaments/:id/registrations', verifyToken, async (req, res) => {
  try {
    if (!await hasTournamentRole(req.user.userId, req.params.id, ['tournament_admin'])) return res.status(403).json({ error: 'Accès refusé' });
    const r = await pool.query('DELETE FROM tournament_registrations WHERE tournament_id=$1', [req.params.id]);
    res.json({ deleted: r.rowCount });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur serveur' });
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
    if (!await canAccessTournament(req.user.userId, req.params.id)) return res.status(403).json({ error: 'Accès refusé' });
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

// Options disponibles pour filtrer la génération (styles + catégories d'âge des inscrits pesés)
app.get('/api/tournaments/:id/competitions/options', verifyToken, async (req, res) => {
  try {
    if (!await canAccessTournament(req.user.userId, req.params.id)) return res.status(403).json({ error: 'Accès refusé' });
    const r = await pool.query(
      `SELECT DISTINCT COALESCE(tr.final_style, a.style) as style, tr.final_age_category as age_category
       FROM tournament_registrations tr
       JOIN athletes a ON a.id = tr.athlete_id
       WHERE tr.tournament_id = $1
         AND tr.weigh_in_status = 'done'
         AND tr.final_age_category IS NOT NULL
         AND tr.final_weight_category IS NOT NULL
       ORDER BY style, age_category`,
      [req.params.id]
    );
    const rows = r.rows;
    const styles = [...new Set(rows.map(row => row.style).filter(Boolean))].sort();
    const age_categories = [...new Set(rows.map(row => row.age_category).filter(Boolean))].sort();
    res.json({ styles, age_categories });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/tournaments/:id/competitions/generate', verifyToken, async (req, res) => {
  try {
    if (!await hasTournamentRole(req.user.userId, req.params.id, ['tournament_admin'])) return res.status(403).json({ error: 'Accès refusé' });
    const tournamentId = req.params.id;
    const { style: filterStyle, age_category: filterAge } = req.body;

    // Récupérer les inscrits pesés (avec filtres optionnels)
    const params = [tournamentId];
    let extraFilters = '';
    if (filterStyle) {
      params.push(filterStyle);
      extraFilters += ` AND COALESCE(tr.final_style, a.style) = $${params.length}`;
    }
    if (filterAge) {
      params.push(filterAge);
      extraFilters += ` AND tr.final_age_category = $${params.length}`;
    }

    // Vérifier qu'il n'y a aucune pesée en attente dans la sélection
    const pendingCheck = await pool.query(
      `SELECT COUNT(*) as cnt,
              STRING_AGG(DISTINCT COALESCE(a.last_name||' '||a.first_name, '?'), ', ' ORDER BY COALESCE(a.last_name||' '||a.first_name, '?')) as names
       FROM tournament_registrations tr
       JOIN athletes a ON a.id = tr.athlete_id
       WHERE tr.tournament_id=$1 AND tr.weigh_in_status='pending'${extraFilters}`,
      params
    );
    const pendingCount = parseInt(pendingCheck.rows[0].cnt);
    if (pendingCount > 0) {
      const label = [filterAge, filterStyle].filter(Boolean).join(' · ');
      return res.status(409).json({
        error: `${pendingCount} pesée${pendingCount > 1 ? 's' : ''} en attente${label ? ` (${label})` : ''} — complétez la pesée avant de générer.`,
        pending_count: pendingCount,
        pending_names: pendingCheck.rows[0].names,
      });
    }

    const regs = await pool.query(
      `SELECT tr.*,a.style,a.gender FROM tournament_registrations tr JOIN athletes a ON a.id=tr.athlete_id
       WHERE tr.tournament_id=$1 AND tr.weigh_in_status='done' AND tr.final_age_category IS NOT NULL AND tr.final_weight_category IS NOT NULL${extraFilters}`,
      params
    );

    // Catégories d'âge "mixtes" : le sexe n'est pas pris en compte dans le regroupement
    const MIXED_AGE_CATS = new Set(['U5', 'U7', 'U9', 'U11']);

    // Grouper par style + gender + age_category + weight_category
    // Pour U5/U7/U9/U11 : gender = 'MX' (mixte) — les M et F concourent ensemble
    const groups = {};
    for (const reg of regs.rows) {
      const style = reg.final_style || reg.style;
      const isMixed = MIXED_AGE_CATS.has(reg.final_age_category);
      const genderKey = isMixed ? 'MX' : (reg.gender || 'M');
      const key = `${style}|${genderKey}|${reg.final_age_category}|${reg.final_weight_category}`;
      if (!groups[key]) groups[key] = { style, gender: genderKey, age_category: reg.final_age_category, weight_category: reg.final_weight_category, athletes: [] };
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
      "SELECT *,(SELECT COUNT(*) FROM tournament_registrations WHERE competition_id=competitions.id) as athlete_count FROM competitions WHERE tournament_id=$1 AND (source IS NULL OR source='standard') ORDER BY age_category,weight_category,style",
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
        // Vainqueurs issus du repêchage → slot ROUGE (priorité RED)
        // pour respecter la règle UWW : vainqueur repêchage = rouge, repeché tableau = bleu.
        const winnerIsRepechage = ['repechage', 'bronze'].includes(match.bracket);
        if (winnerIsRepechage) {
          if (!nm.red_athlete_id) {
            await pool.query('UPDATE matches SET red_athlete_id=$1,updated_at=now() WHERE id=$2', [winner_id, nm.id]);
          } else if (!nm.blue_athlete_id) {
            await pool.query('UPDATE matches SET blue_athlete_id=$1,updated_at=now() WHERE id=$2', [winner_id, nm.id]);
          }
        } else {
          if (!nm.red_athlete_id) {
            await pool.query('UPDATE matches SET red_athlete_id=$1,updated_at=now() WHERE id=$2', [winner_id, nm.id]);
          } else if (!nm.blue_athlete_id) {
            await pool.query('UPDATE matches SET blue_athlete_id=$1,updated_at=now() WHERE id=$2', [winner_id, nm.id]);
          }
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

    // ─── Avancer le PERDANT dans le repêchage ───────────────────────────────
    // loser_id peut ne pas être fourni explicitement : on le déduit du match.
    const effectiveLoserId = loser_id
      || (winner_id === match.red_athlete_id  ? match.blue_athlete_id
        : winner_id === match.blue_athlete_id ? match.red_athlete_id
        : null);

    if (effectiveLoserId && match.loser_to) {
      const loserNext = await pool.query('SELECT * FROM matches WHERE id=$1', [match.loser_to]);
      if (loserNext.rows.length) {
        const lm = loserNext.rows[0];
        // Perdants du tableau principal → slot BLEU dans le tour de repêchage
        // (règle UWW : repeché tableau final = bleu, vainqueur repêchage = rouge)
        if (!lm.blue_athlete_id) {
          await pool.query('UPDATE matches SET blue_athlete_id=$1,updated_at=now() WHERE id=$2', [effectiveLoserId, lm.id]);
        } else if (!lm.red_athlete_id) {
          await pool.query('UPDATE matches SET red_athlete_id=$1,updated_at=now() WHERE id=$2', [effectiveLoserId, lm.id]);
        }
        // Débloquer ou auto-avancer selon que le match RA est un BYE ou non
        const updatedLoser = await pool.query('SELECT * FROM matches WHERE id=$1', [lm.id]);
        const ulm = updatedLoser.rows[0];

        if (ulm.is_bye) {
          // Match RA marqué BYE (une source était un BYE) → un seul athlète réel.
          // On l'auto-avance immédiatement vers le tour C1 (slot ROUGE = position BR winner).
          const autoWinner = ulm.red_athlete_id || ulm.blue_athlete_id;
          if (autoWinner && ulm.status !== 'finished') {
            await pool.query(
              'UPDATE matches SET status=\'finished\',winner_id=$1,updated_at=now() WHERE id=$2',
              [autoWinner, ulm.id]
            );
            if (ulm.winner_to) {
              const c1Res = await pool.query('SELECT * FROM matches WHERE id=$1', [ulm.winner_to]);
              if (c1Res.rows.length) {
                const c1m = c1Res.rows[0];
                // Prend le slot ROUGE (rôle du vainqueur BR)
                if (!c1m.red_athlete_id) {
                  await pool.query('UPDATE matches SET red_athlete_id=$1,updated_at=now() WHERE id=$2', [autoWinner, c1m.id]);
                } else if (!c1m.blue_athlete_id) {
                  await pool.query('UPDATE matches SET blue_athlete_id=$1,updated_at=now() WHERE id=$2', [autoWinner, c1m.id]);
                }
                const updC1 = await pool.query('SELECT * FROM matches WHERE id=$1', [c1m.id]);
                if (updC1.rows[0].red_athlete_id && updC1.rows[0].blue_athlete_id) {
                  await pool.query('UPDATE matches SET status=\'ready\',updated_at=now() WHERE id=$1', [c1m.id]);
                  await pool.query(
                    'INSERT INTO match_queue(id,tournament_id,match_id,position,status) SELECT $1,$2,$3,COALESCE((SELECT MAX(position)+1 FROM match_queue WHERE tournament_id=$2),1),\'ready\' WHERE NOT EXISTS(SELECT 1 FROM match_queue WHERE match_id=$3)',
                    [uuidv4(), match.tournament_id, c1m.id]
                  );
                }
              }
            }
          }
        } else if (ulm.red_athlete_id && ulm.blue_athlete_id) {
          // Match RA normal : les deux combattants sont présents, on débloque.
          await pool.query('UPDATE matches SET status=\'ready\',updated_at=now() WHERE id=$1', [lm.id]);
          await pool.query(
            'INSERT INTO match_queue(id,tournament_id,match_id,position,status) SELECT $1,$2,$3,COALESCE((SELECT MAX(position)+1 FROM match_queue WHERE tournament_id=$2),1),\'ready\' WHERE NOT EXISTS(SELECT 1 FROM match_queue WHERE match_id=$3)',
            [uuidv4(), match.tournament_id, lm.id]
          );
        }
      }
    }
    // ────────────────────────────────────────────────────────────────────────

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
        m.round, m.pool_id,
        (SELECT MAX(m2.round) FROM matches m2
          WHERE m2.competition_id=m.competition_id AND m2.bracket IN ('main','final')) AS max_round,
        r.first_name||' '||r.last_name as red_name, rc.short_name as red_club,
        b.first_name||' '||b.last_name as blue_name, bc.short_name as blue_club,
        mt.name as mat_name,
        p.name as pool_name,
        comp.style,comp.age_category,comp.weight_category,comp.gender,comp.format_type,
        (SELECT MAX(m2.ended_at) FROM matches m2
          WHERE m2.tournament_id=mq.tournament_id AND m2.status='finished'
          AND m2.ended_at IS NOT NULL AND m2.id != mq.match_id
          AND (m2.red_athlete_id=m.red_athlete_id OR m2.blue_athlete_id=m.red_athlete_id)
        ) AS red_last_fight_at,
        (SELECT MAX(m2.ended_at) FROM matches m2
          WHERE m2.tournament_id=mq.tournament_id AND m2.status='finished'
          AND m2.ended_at IS NOT NULL AND m2.id != mq.match_id
          AND (m2.red_athlete_id=m.blue_athlete_id OR m2.blue_athlete_id=m.blue_athlete_id)
        ) AS blue_last_fight_at
       FROM match_queue mq
       JOIN matches m ON m.id=mq.match_id
       LEFT JOIN athletes r ON r.id=m.red_athlete_id
       LEFT JOIN clubs rc ON rc.id=r.club_id
       LEFT JOIN athletes b ON b.id=m.blue_athlete_id
       LEFT JOIN clubs bc ON bc.id=b.club_id
       LEFT JOIN mats mt ON mt.id=mq.mat_id
       LEFT JOIN competitions comp ON comp.id=m.competition_id
       LEFT JOIN pools p ON p.id=m.pool_id
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

    // Si le tapis a déjà un combat on_mat → pré-file (status=ready + mat_id)
    const busy = await pool.query(
      `SELECT COUNT(*) as cnt FROM match_queue WHERE mat_id=$1 AND status='on_mat'`,
      [mat_id]
    );
    const newStatus = parseInt(busy.rows[0].cnt) > 0 ? 'ready' : 'on_mat';

    const r = await pool.query(
      `UPDATE match_queue SET mat_id=$1,status=$2,confirmed=false,updated_at=now() WHERE id=$3 RETURNING *`,
      [mat_id, newStatus, req.params.queueId]
    );
    await pool.query(
      `UPDATE matches SET mat_id=$1,status=$2,updated_at=now() WHERE id=$3`,
      [mat_id, newStatus, r.rows[0].match_id]
    );
    broadcastToTournament(r.rows[0].tournament_id, { type: 'match_assigned', queue: r.rows[0] });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Désaffecter un combat (le remettre dans la queue globale)
app.put('/api/queue/:queueId/unassign', verifyToken, async (req, res) => {
  try {
    const qR = await pool.query('SELECT * FROM match_queue WHERE id=$1', [req.params.queueId]);
    if (!qR.rows.length) return res.status(404).json({ error: 'Introuvable' });
    const q = qR.rows[0];

    if (!await hasTournamentRole(req.user.userId, q.tournament_id, ['tournament_admin', 'mat_manager'])) {
      return res.status(403).json({ error: 'Accès refusé' });
    }
    await pool.query(
      `UPDATE match_queue SET mat_id=NULL,status='ready',confirmed=false,updated_at=now() WHERE id=$1`,
      [req.params.queueId]
    );
    await pool.query(
      `UPDATE matches SET mat_id=NULL,status='ready',updated_at=now() WHERE id=$1`,
      [q.match_id]
    );
    broadcastToTournament(q.tournament_id, { type: 'match_unassigned', queue_id: req.params.queueId });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Promouvoir un combat ready → on_mat (lancer le prochain combat sur le tapis)
app.put('/api/queue/:queueId/promote', verifyToken, async (req, res) => {
  try {
    const qR = await pool.query('SELECT * FROM match_queue WHERE id=$1', [req.params.queueId]);
    if (!qR.rows.length) return res.status(404).json({ error: 'Introuvable' });
    const q = qR.rows[0];
    if (!await hasTournamentRole(req.user.userId, q.tournament_id, ['tournament_admin', 'mat_manager'])) {
      return res.status(403).json({ error: 'Accès refusé' });
    }
    if (q.status !== 'ready') return res.status(409).json({ error: 'Ce combat n\'est pas en attente' });
    if (!q.mat_id) return res.status(409).json({ error: 'Ce combat n\'est pas affecté à un tapis' });
    // Vérifier qu'aucun autre combat n'est déjà on_mat sur ce tapis
    const busy = await pool.query(
      `SELECT COUNT(*) as cnt FROM match_queue WHERE mat_id=$1 AND status='on_mat'`,
      [q.mat_id]
    );
    if (parseInt(busy.rows[0].cnt) > 0) {
      return res.status(409).json({ error: 'Un combat est déjà en cours sur ce tapis' });
    }
    const r = await pool.query(
      `UPDATE match_queue SET status='on_mat',updated_at=now() WHERE id=$1 RETURNING *`,
      [req.params.queueId]
    );
    await pool.query(
      `UPDATE matches SET status='on_mat',mat_id=$1,updated_at=now() WHERE id=$2`,
      [q.mat_id, q.match_id]
    );
    broadcastToTournament(q.tournament_id, { type: 'match_promoted', queue: r.rows[0] });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Confirmer / infirmer un combat dans la file d'un tapis
app.put('/api/queue/:queueId/confirm', verifyToken, async (req, res) => {
  try {
    await pool.query(`ALTER TABLE match_queue ADD COLUMN IF NOT EXISTS confirmed boolean DEFAULT false`).catch(() => {});
    const qR = await pool.query('SELECT * FROM match_queue WHERE id=$1', [req.params.queueId]);
    if (!qR.rows.length) return res.status(404).json({ error: 'Introuvable' });
    const q = qR.rows[0];
    if (!await hasTournamentRole(req.user.userId, q.tournament_id, ['tournament_admin', 'mat_manager'])) {
      return res.status(403).json({ error: 'Accès refusé' });
    }
    const newConfirmed = !(q.confirmed === true);
    const r = await pool.query(
      `UPDATE match_queue SET confirmed=$1,updated_at=now() WHERE id=$2 RETURNING *`,
      [newConfirmed, req.params.queueId]
    );
    broadcastToTournament(q.tournament_id, { type: 'queue_confirmed', queue: r.rows[0] });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Réordonner la file de combats
app.put('/api/tournaments/:id/queue/reorder', verifyToken, async (req, res) => {
  try {
    if (!await hasTournamentRole(req.user.userId, req.params.id, ['tournament_admin', 'mat_manager'])) {
      return res.status(403).json({ error: 'Accès refusé' });
    }
    const { items } = req.body; // [{id, position}]
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'items requis' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const item of items) {
        await client.query(
          `UPDATE match_queue SET position=$1,updated_at=now() WHERE id=$2 AND tournament_id=$3`,
          [item.position, item.id, req.params.id]
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    broadcastToTournament(req.params.id, { type: 'queue_reordered' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Score live (broadcast WebSocket en cours de combat)
app.put('/api/matches/:matchId/live-score', verifyToken, async (req, res) => {
  try {
    const { score_red, score_blue } = req.body;
    const mR = await pool.query('SELECT * FROM matches WHERE id=$1', [req.params.matchId]);
    if (!mR.rows.length) return res.status(404).json({ error: 'Match introuvable' });
    const match = mR.rows[0];
    if (!await hasTournamentRole(req.user.userId, match.tournament_id, ['tournament_admin', 'referee', 'mat_manager'])) {
      return res.status(403).json({ error: 'Accès refusé' });
    }
    await pool.query(
      `UPDATE matches SET score_red=$1,score_blue=$2,updated_at=now() WHERE id=$3`,
      [score_red ?? 0, score_blue ?? 0, req.params.matchId]
    );
    broadcastToTournament(match.tournament_id, {
      type: 'score_update',
      match_id: req.params.matchId,
      score_red: score_red ?? 0,
      score_blue: score_blue ?? 0,
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─────────────────────────────────────────────
// VUE TAPIS (public)
// ─────────────────────────────────────────────

// ── Helper partagé pour la vue live d'un tapis ──────────────────────────────
async function _matLiveData(matId) {
  const matInfo = await pool.query(
    'SELECT tournament_id, name, slug FROM mats WHERE id=$1',
    [matId]
  );
  if (!matInfo.rows.length) return null;
  const { tournament_id, name: mat_name, slug: mat_slug } = matInfo.rows[0];

  const tournamentInfo = await pool.query('SELECT slug FROM tournaments WHERE id=$1', [tournament_id]);
  const tournament_slug = tournamentInfo.rows[0]?.slug ?? null;

  const current = await pool.query(
    `SELECT m.*,mq.id as queue_id,mq.position,
      r.first_name||' '||r.last_name as red_name, rc.short_name as red_club,
      b.first_name||' '||b.last_name as blue_name, bc.short_name as blue_club,
      comp.style,comp.age_category,comp.weight_category,comp.gender
     FROM matches m
     LEFT JOIN match_queue mq ON mq.match_id=m.id AND mq.mat_id=$1
     LEFT JOIN athletes r ON r.id=m.red_athlete_id LEFT JOIN clubs rc ON rc.id=r.club_id
     LEFT JOIN athletes b ON b.id=m.blue_athlete_id LEFT JOIN clubs bc ON bc.id=b.club_id
     LEFT JOIN competitions comp ON comp.id=m.competition_id
     WHERE m.mat_id=$1 AND m.status='on_mat'
     ORDER BY mq.position LIMIT 1`,
    [matId]
  );
  const next = await pool.query(
    `SELECT m.*,mq.id as queue_id,mq.position,mq.confirmed,
      r.first_name||' '||r.last_name as red_name,
      b.first_name||' '||b.last_name as blue_name,
      comp.style,comp.age_category,comp.weight_category
     FROM matches m
     JOIN match_queue mq ON mq.match_id=m.id
     LEFT JOIN athletes r ON r.id=m.red_athlete_id
     LEFT JOIN athletes b ON b.id=m.blue_athlete_id
     LEFT JOIN competitions comp ON comp.id=m.competition_id
     WHERE mq.mat_id=$1 AND mq.status='ready' AND mq.confirmed=true
     ORDER BY mq.position LIMIT 3`,
    [matId]
  );
  return { current: current.rows[0] || null, next: next.rows, tournament_id, mat_name, mat_slug, tournament_slug };
}

// GET /api/mats/:matId/live — accès par UUID (rétro-compatibilité)
app.get('/api/mats/:matId/live', async (req, res) => {
  try {
    const data = await _matLiveData(req.params.matId);
    if (!data) return res.status(404).json({ error: 'Tapis introuvable' });
    res.json(data);
  } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
});

// GET /api/debug/mat/:matSlug — diagnostic (temporaire)
app.get('/api/debug/mat/:matSlug', async (req, res) => {
  try {
    const slug = req.params.matSlug;
    const matR = await pool.query('SELECT id, name, slug, tournament_id FROM mats WHERE slug=$1', [slug]);
    if (!matR.rows.length) return res.json({ error: 'Aucun mat avec ce slug', slug });
    const mat = matR.rows[0];

    const onMatMatches = await pool.query(
      `SELECT m.id, m.status, m.mat_id, m.red_athlete_id, m.blue_athlete_id
       FROM matches m WHERE m.mat_id=$1 AND m.status='on_mat'`, [mat.id]);

    const queueEntries = await pool.query(
      `SELECT mq.id, mq.match_id, mq.mat_id, mq.status, mq.confirmed
       FROM match_queue mq WHERE mq.mat_id=$1`, [mat.id]);

    const allOnMatInTournament = await pool.query(
      `SELECT m.id, m.status, m.mat_id, mq.mat_id as q_mat_id, mq.status as q_status
       FROM matches m
       LEFT JOIN match_queue mq ON mq.match_id=m.id
       WHERE m.tournament_id=$1 AND m.status='on_mat'`, [mat.tournament_id]);

    res.json({ mat, onMatMatches: onMatMatches.rows, queueEntries: queueEntries.rows, allOnMatInTournament: allOnMatInTournament.rows });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// GET /api/live/:matSlug — accès par slug global (URL simple)
app.get('/api/live/:matSlug', async (req, res) => {
  try {
    const matR = await pool.query('SELECT id FROM mats WHERE slug=$1', [req.params.matSlug]);
    if (!matR.rows.length) return res.status(404).json({ error: 'Tapis introuvable' });
    const data = await _matLiveData(matR.rows[0].id);
    res.json(data);
  } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
});

// GET /api/live/:tournamentSlug/:matSlug — rétrocompatibilité (accès par slug tournoi + mat)
app.get('/api/live/:tournamentSlug/:matSlug', async (req, res) => {
  try {
    const matR = await pool.query(
      `SELECT m.id FROM mats m
       JOIN tournaments t ON t.id = m.tournament_id
       WHERE t.slug = $1 AND m.slug = $2`,
      [req.params.tournamentSlug, req.params.matSlug]
    );
    if (!matR.rows.length) return res.status(404).json({ error: 'Tapis introuvable' });
    const data = await _matLiveData(matR.rows[0].id);
    res.json(data);
  } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
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
// PROGRAMME PUBLIC
// ─────────────────────────────────────────────

app.get('/api/tournaments/:id/programme', async (req, res) => {
  try {
    const t = await pool.query(
      'SELECT public_page_enabled, public_program_enabled FROM tournaments WHERE id=$1 OR slug=$1',
      [req.params.id]
    );
    if (!t.rows.length) return res.status(404).json({ error: 'Tournoi introuvable' });
    if (!t.rows[0].public_page_enabled || !t.rows[0].public_program_enabled)
      return res.status(403).json({ error: 'Programme non public' });

    // Competitions
    const comps = await pool.query(
      `SELECT c.*, COUNT(ca.athlete_id) as athlete_count
       FROM competitions c
       LEFT JOIN (
         SELECT DISTINCT athlete_id, competition_id FROM pool_athletes
       ) ca ON ca.competition_id = c.id
       WHERE c.tournament_id=$1
       GROUP BY c.id
       ORDER BY c.age_category, c.weight_category`,
      [req.params.id]
    );

    // Pools with athletes
    const pools = await pool.query(
      `SELECT p.*, c.age_category, c.weight_category, c.style, c.gender,
              json_agg(json_build_object(
                'athlete_id', a.id,
                'name', a.first_name||' '||a.last_name,
                'club', COALESCE(cl.short_name, cl.name),
                'weight', tr.weigh_in_weight_kg
              ) ORDER BY a.last_name) as athletes
       FROM pools p
       JOIN competitions c ON c.id = p.competition_id
       LEFT JOIN pool_athletes pa ON pa.pool_id = p.id
       LEFT JOIN athletes a ON a.id = pa.athlete_id
       LEFT JOIN clubs cl ON cl.id = a.club_id
       LEFT JOIN tournament_registrations tr ON tr.athlete_id = a.id AND tr.tournament_id = c.tournament_id
       WHERE c.tournament_id = $1
       GROUP BY p.id, c.age_category, c.weight_category, c.style, c.gender
       ORDER BY c.age_category, c.weight_category, p.name`,
      [req.params.id]
    );

    res.json({ competitions: comps.rows, pools: pools.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─────────────────────────────────────────────
// DASHBOARD STATS
// ─────────────────────────────────────────────

app.get('/api/tournaments/:id/dashboard', verifyToken, async (req, res) => {
  try {
    if (!await canAccessTournament(req.user.userId, req.params.id)) return res.status(403).json({ error: 'Accès refusé' });
    const [athletes, clubs, comps, matchesTotal, matchesDone, matsActive, weighStats, queueStats] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM tournament_registrations WHERE tournament_id=$1', [req.params.id]),
      pool.query('SELECT COUNT(DISTINCT a.club_id) FROM tournament_registrations tr JOIN athletes a ON a.id=tr.athlete_id WHERE tr.tournament_id=$1', [req.params.id]),
      pool.query('SELECT COUNT(*) FROM competitions WHERE tournament_id=$1', [req.params.id]),
      pool.query('SELECT COUNT(*) FROM matches WHERE tournament_id=$1 AND is_bye=false', [req.params.id]),
      pool.query("SELECT COUNT(*) FROM matches WHERE tournament_id=$1 AND status='finished' AND is_bye=false", [req.params.id]),
      pool.query("SELECT COUNT(*) FROM mats WHERE tournament_id=$1 AND is_active=true", [req.params.id]),
      pool.query(`
        SELECT
          COUNT(*) AS total,
          COUNT(CASE WHEN weigh_in_status='done'       THEN 1 END) AS done,
          COUNT(CASE WHEN weigh_in_status='overweight' THEN 1 END) AS overweight,
          COUNT(CASE WHEN weigh_in_status='no_show'    THEN 1 END) AS no_show,
          COUNT(CASE WHEN weigh_in_status='pending'    THEN 1 END) AS pending
        FROM tournament_registrations WHERE tournament_id=$1`, [req.params.id]),
      pool.query(`
        SELECT
          COUNT(CASE WHEN status='on_mat' THEN 1 END) AS on_mat,
          COUNT(CASE WHEN status='ready'  THEN 1 END) AS ready
        FROM match_queue WHERE tournament_id=$1`, [req.params.id]),
    ]);
    const w = weighStats.rows[0];
    const q = queueStats.rows[0];
    res.json({
      athletes:     parseInt(athletes.rows[0].count),
      clubs:        parseInt(clubs.rows[0].count),
      competitions: parseInt(comps.rows[0].count),
      matches_total: parseInt(matchesTotal.rows[0].count),
      matches_done:  parseInt(matchesDone.rows[0].count),
      mats_active:   parseInt(matsActive.rows[0].count),
      weigh_in: {
        total:      parseInt(w.total),
        done:       parseInt(w.done),
        overweight: parseInt(w.overweight),
        no_show:    parseInt(w.no_show),
        pending:    parseInt(w.pending),
      },
      queue: {
        on_mat: parseInt(q.on_mat),
        ready:  parseInt(q.ready),
      },
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
// MATCH — GET SINGLE
// ─────────────────────────────────────────────

app.get('/api/matches/:matchId', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT m.*,
        ra.first_name||' '||ra.last_name as red_name, rc.short_name as red_club,
        ba.first_name||' '||ba.last_name as blue_name, bc.short_name as blue_club,
        wa.first_name||' '||wa.last_name as winner_name,
        mt.name as mat_name,
        comp.style, comp.age_category, comp.weight_category, comp.gender
       FROM matches m
       LEFT JOIN athletes ra ON ra.id=m.red_athlete_id LEFT JOIN clubs rc ON rc.id=ra.club_id
       LEFT JOIN athletes ba ON ba.id=m.blue_athlete_id LEFT JOIN clubs bc ON bc.id=ba.club_id
       LEFT JOIN athletes wa ON wa.id=m.winner_id
       LEFT JOIN mats mt ON mt.id=m.mat_id
       LEFT JOIN competitions comp ON comp.id=m.competition_id
       WHERE m.id=$1`,
      [req.params.matchId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Combat introuvable' });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─────────────────────────────────────────────
// BRACKET GENERATION
// ─────────────────────────────────────────────

app.post('/api/competitions/:compId/generate-bracket', verifyToken, async (req, res) => {
  try {
    const { compId } = req.params;
    const compR = await pool.query('SELECT * FROM competitions WHERE id=$1', [compId]);
    if (!compR.rows.length) return res.status(404).json({ error: 'Compétition introuvable' });
    const comp = compR.rows[0];

    if (!await hasTournamentRole(req.user.userId, comp.tournament_id, ['tournament_admin'])) return res.status(403).json({ error: 'Accès refusé' });

    // Récupérer les athlètes inscrits dans cette compétition
    const athletesR = await pool.query(
      `SELECT a.*, c.short_name as club_short, tr.final_weight_category, tr.final_age_category
       FROM tournament_registrations tr
       JOIN athletes a ON a.id=tr.athlete_id
       LEFT JOIN clubs c ON c.id=a.club_id
       WHERE tr.competition_id=$1 AND tr.weigh_in_status='done'`,
      [compId]
    );
    const athletes = athletesR.rows;
    if (athletes.length < 2) return res.status(400).json({ error: 'Pas assez d\'athlètes (minimum 2)' });

    // Supprimer les anciens matchs de cette compétition
    await pool.query('DELETE FROM repechage_matches WHERE repechage_bracket_id IN (SELECT id FROM repechage_brackets WHERE competition_id=$1)', [compId]);
    await pool.query('DELETE FROM repechage_brackets WHERE competition_id=$1', [compId]);
    await pool.query('DELETE FROM match_queue WHERE match_id IN (SELECT id FROM matches WHERE competition_id=$1)', [compId]);
    await pool.query('DELETE FROM pool_athletes WHERE pool_id IN (SELECT id FROM pools WHERE competition_id=$1)', [compId]);
    await pool.query('DELETE FROM matches WHERE competition_id=$1', [compId]);
    await pool.query('DELETE FROM pools WHERE competition_id=$1', [compId]);

    let result;
    if (comp.format_type === 'nordic') {
      // Créer la poule unique (round-robin complet)
      const poolId = uuidv4();
      const poolResult = await pool.query(
        `INSERT INTO pools(id, competition_id, tournament_id, name, status) VALUES($1,$2,$3,$4,$5) RETURNING *`,
        [poolId, compId, comp.tournament_id, 'Poule', 'active']
      );
      for (let i = 0; i < athletes.length; i++) {
        await pool.query(
          `INSERT INTO pool_athletes(id, pool_id, athlete_id, seed_order) VALUES($1,$2,$3,$4)`,
          [uuidv4(), poolId, athletes[i].id, i + 1]
        );
      }
      const poolObj = poolResult.rows[0];
      const matches = await generateNordic(compId, comp.tournament_id, athletes, poolObj);
      // Ajouter à la queue
      for (let i = 0; i < matches.length; i++) {
        await pool.query('INSERT INTO match_queue(id,tournament_id,match_id,position,status) VALUES($1,$2,$3,$4,$5)',
          [uuidv4(), comp.tournament_id, matches[i].id, i + 1, 'ready']);
      }
      result = { format: 'nordic', matches: matches.length };
    } else if (comp.format_type === 'pools_finals') {
      result = await generatePoolsAndFinals(compId, comp.tournament_id, athletes, comp.repechage_mode);
      // Ajouter les matchs de poule à la queue
      const readyMatches = await pool.query("SELECT id FROM matches WHERE competition_id=$1 AND status='ready'", [compId]);
      for (let i = 0; i < readyMatches.rows.length; i++) {
        await pool.query('INSERT INTO match_queue(id,tournament_id,match_id,position,status) VALUES($1,$2,$3,$4,$5)',
          [uuidv4(), comp.tournament_id, readyMatches.rows[i].id, i + 1, 'ready']);
      }
    } else {
      result = await generateBracket(compId, comp.tournament_id, athletes, comp.repechage_mode);
      // Ajouter les matchs ready à la queue
      const readyMatches = await pool.query("SELECT id FROM matches WHERE competition_id=$1 AND status='ready'", [compId]);
      for (let i = 0; i < readyMatches.rows.length; i++) {
        await pool.query('INSERT INTO match_queue(id,tournament_id,match_id,position,status) VALUES($1,$2,$3,$4,$5)',
          [uuidv4(), comp.tournament_id, readyMatches.rows[i].id, i + 1, 'ready']);
      }
    }

    await audit(comp.tournament_id, req.user.userId, 'GENERATE_BRACKET', 'competition', compId, null, { format: comp.format_type, athletes: athletes.length });
    broadcastToTournament(comp.tournament_id, { type: 'bracket_generated', competition_id: compId });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('Bracket generation error:', e);
    res.status(500).json({ error: e.message || 'Erreur génération tableau' });
  }
});

// ─────────────────────────────────────────────
// DELETE BRACKET — tableau d'une compétition
// ─────────────────────────────────────────────

app.delete('/api/competitions/:compId/bracket', verifyToken, async (req, res) => {
  try {
    const { compId } = req.params;
    const compR = await pool.query('SELECT * FROM competitions WHERE id=$1', [compId]);
    if (!compR.rows.length) return res.status(404).json({ error: 'Compétition introuvable' });
    const comp = compR.rows[0];

    if (!await hasTournamentRole(req.user.userId, comp.tournament_id, ['tournament_admin'])) {
      return res.status(403).json({ error: 'Accès refusé' });
    }

    // force=true uniquement pour super_admin : ignore les combats déjà joués
    const forceDelete = req.query.force === 'true' && await isSuperAdmin(req.user.userId);

    if (!forceDelete) {
      const blockedR = await pool.query(
        `SELECT COUNT(*) as cnt FROM matches WHERE competition_id=$1 AND status IN ('on_mat','finished')`,
        [compId]
      );
      if (parseInt(blockedR.rows[0].cnt) > 0) {
        return res.status(409).json({ error: 'Des combats sont en cours ou terminés — impossible de supprimer ce tableau' });
      }
    }

    await pool.query('DELETE FROM repechage_matches WHERE repechage_bracket_id IN (SELECT id FROM repechage_brackets WHERE competition_id=$1)', [compId]);
    await pool.query('DELETE FROM repechage_brackets WHERE competition_id=$1', [compId]);
    await pool.query('DELETE FROM match_queue WHERE match_id IN (SELECT id FROM matches WHERE competition_id=$1)', [compId]);
    await pool.query('DELETE FROM pool_athletes WHERE pool_id IN (SELECT id FROM pools WHERE competition_id=$1)', [compId]);
    await pool.query('DELETE FROM matches WHERE competition_id=$1', [compId]);
    await pool.query('DELETE FROM pools WHERE competition_id=$1', [compId]);

    await audit(comp.tournament_id, req.user.userId, 'DELETE_BRACKET', 'competition', compId, null, { weight_category: comp.weight_category, age_category: comp.age_category, style: comp.style });
    broadcastToTournament(comp.tournament_id, { type: 'bracket_deleted', competition_id: compId });
    res.json({ ok: true });
  } catch (e) {
    console.error('Delete bracket error:', e);
    res.status(500).json({ error: e.message || 'Erreur suppression tableau' });
  }
});

// ─────────────────────────────────────────────
// DELETE BRACKETS BULK — tous les tableaux d'une catégorie d'âge
// ─────────────────────────────────────────────

app.delete('/api/tournaments/:id/brackets', verifyToken, async (req, res) => {
  try {
    const tournamentId = req.params.id;
    const { age_category } = req.query;

    if (!await hasTournamentRole(req.user.userId, tournamentId, ['tournament_admin'])) {
      return res.status(403).json({ error: 'Accès refusé' });
    }

    // force=true uniquement pour super_admin
    const forceDelete = req.query.force === 'true' && await isSuperAdmin(req.user.userId);

    // Récupérer les compétitions concernées
    let compsQuery = 'SELECT id, weight_category, age_category, style FROM competitions WHERE tournament_id=$1';
    const params = [tournamentId];
    if (age_category) {
      params.push(age_category);
      compsQuery += ` AND age_category=$${params.length}`;
    }
    const compsR = await pool.query(compsQuery, params);
    const compIds = compsR.rows.map(c => c.id);
    if (compIds.length === 0) return res.status(404).json({ error: 'Aucune compétition trouvée' });

    if (!forceDelete) {
      // Bloquer si un combat est en cours ou terminé dans la sélection
      const blockedR = await pool.query(
        `SELECT COUNT(*) as cnt FROM matches WHERE competition_id = ANY($1::uuid[]) AND status IN ('on_mat','finished')`,
        [compIds]
      );
      if (parseInt(blockedR.rows[0].cnt) > 0) {
        return res.status(409).json({ error: `Des combats sont en cours ou terminés dans cette sélection — impossible de supprimer ces tableaux` });
      }
    }

    for (const compId of compIds) {
      await pool.query('DELETE FROM repechage_matches WHERE repechage_bracket_id IN (SELECT id FROM repechage_brackets WHERE competition_id=$1)', [compId]);
      await pool.query('DELETE FROM repechage_brackets WHERE competition_id=$1', [compId]);
      await pool.query('DELETE FROM match_queue WHERE match_id IN (SELECT id FROM matches WHERE competition_id=$1)', [compId]);
      await pool.query('DELETE FROM pool_athletes WHERE pool_id IN (SELECT id FROM pools WHERE competition_id=$1)', [compId]);
      await pool.query('DELETE FROM matches WHERE competition_id=$1', [compId]);
      await pool.query('DELETE FROM pools WHERE competition_id=$1', [compId]);
    }

    await audit(tournamentId, req.user.userId, 'DELETE_BRACKETS_BULK', 'tournament', tournamentId, null, { age_category: age_category || 'all', count: compIds.length });
    broadcastToTournament(tournamentId, { type: 'brackets_deleted', age_category: age_category || null, count: compIds.length });
    res.json({ ok: true, deleted: compIds.length });
  } catch (e) {
    console.error('Delete brackets bulk error:', e);
    res.status(500).json({ error: e.message || 'Erreur suppression tableaux' });
  }
});

// ─────────────────────────────────────────────
// RANKINGS
// ─────────────────────────────────────────────

app.get('/api/competitions/:compId/rankings', async (req, res) => {
  try {
    const compR = await pool.query('SELECT * FROM competitions WHERE id=$1', [req.params.compId]);
    if (!compR.rows.length) return res.status(404).json({ error: 'Compétition introuvable' });
    const comp = compR.rows[0];

    let rankings;
    if (comp.format_type === 'bracket_repechage') {
      rankings = await computeBracketRankings(req.params.compId);
    } else {
      rankings = await computePoolRankings(req.params.compId);
    }
    res.json(rankings);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─────────────────────────────────────────────
// STATS CLUBS PAR TOURNOI
// ─────────────────────────────────────────────

app.get('/api/tournaments/:id/stats/clubs', verifyToken, async (req, res) => {
  try {
    if (!await canAccessTournament(req.user.userId, req.params.id)) return res.status(403).json({ error: 'Accès refusé' });
    const r = await pool.query(
      `SELECT c.id, c.name, c.short_name,
        COUNT(tr.id) as total,
        COUNT(CASE WHEN tr.final_age_category IS NOT NULL THEN 1 END) as categorized,
        json_agg(json_build_object('category', tr.final_age_category, 'style', tr.final_style, 'athlete', a.last_name||' '||a.first_name) ORDER BY tr.final_age_category) as athletes
       FROM tournament_registrations tr
       JOIN athletes a ON a.id=tr.athlete_id
       LEFT JOIN clubs c ON c.id=a.club_id
       WHERE tr.tournament_id=$1
       GROUP BY c.id, c.name, c.short_name
       ORDER BY total DESC`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─────────────────────────────────────────────
// BRACKET VIEW DATA
// ─────────────────────────────────────────────

app.get('/api/competitions/:compId/bracket', async (req, res) => {
  try {
    const matches = await pool.query(
      `SELECT m.*,
        ra.first_name||' '||ra.last_name as red_name, rc.short_name as red_club,
        ba.first_name||' '||ba.last_name as blue_name, bc.short_name as blue_club,
        wa.first_name||' '||wa.last_name as winner_name,
        mt.name as mat_name
       FROM matches m
       LEFT JOIN athletes ra ON ra.id=m.red_athlete_id LEFT JOIN clubs rc ON rc.id=ra.club_id
       LEFT JOIN athletes ba ON ba.id=m.blue_athlete_id LEFT JOIN clubs bc ON bc.id=ba.club_id
       LEFT JOIN athletes wa ON wa.id=m.winner_id
       LEFT JOIN mats mt ON mt.id=m.mat_id
       WHERE m.competition_id=$1
       ORDER BY m.bracket, m.round, m.index_in_round`,
      [req.params.compId]
    );

    const pools = await pool.query(
      `SELECT p.*, json_agg(json_build_object('id',a.id,'name',a.last_name||' '||a.first_name,'club',c.short_name) ORDER BY pa.seed_order) as athletes
       FROM pools p
       LEFT JOIN pool_athletes pa ON pa.pool_id=p.id
       LEFT JOIN athletes a ON a.id=pa.athlete_id
       LEFT JOIN clubs c ON c.id=a.club_id
       WHERE p.competition_id=$1
       GROUP BY p.id ORDER BY p.name`,
      [req.params.compId]
    );

    const comp = await pool.query('SELECT * FROM competitions WHERE id=$1', [req.params.compId]);

    res.json({
      competition: comp.rows[0],
      matches: matches.rows,
      pools: pools.rows,
    });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─────────────────────────────────────────────
// JEUNES — Pools U9 / U11
// ─────────────────────────────────────────────

// GET — Liste des poules + non-assignés
app.get('/api/tournaments/:id/jeunes', async (req, res) => {
  try {
    const { age_category } = req.query;
    const params = [req.params.id];
    let ageFilter = '';
    if (age_category) { params.push(age_category); ageFilter = ` AND jp.age_category = $${params.length}`; }

    const poolsR = await pool.query(`
      SELECT jp.*, c.gender, c.weight_category,
        p.name  AS pool_name, p.status AS pool_status,
        m.name  AS mat_name, m.id AS mat_id,
        u.name  AS referee_name,
        (SELECT COUNT(*) FROM matches WHERE competition_id=jp.competition_id AND is_bye=false)                        AS match_count,
        (SELECT COUNT(*) FROM matches WHERE competition_id=jp.competition_id AND status='finished' AND is_bye=false)  AS matches_done,
        COALESCE(json_agg(
          json_build_object(
            'athlete_id', a.id,
            'name',       a.first_name || ' ' || a.last_name,
            'gender',     a.gender,
            'weight',     tr.weigh_in_weight_kg,
            'club',       COALESCE(cl.short_name, cl.name, '—'),
            'seed_order', pa.seed_order
          ) ORDER BY pa.seed_order
        ) FILTER (WHERE a.id IS NOT NULL), '[]') AS athletes
      FROM jeunes_pools jp
      JOIN competitions c ON c.id  = jp.competition_id
      JOIN pools         p ON p.id  = jp.pool_id
      LEFT JOIN mats     m ON m.id  = jp.mat_id
      LEFT JOIN users    u ON u.id  = jp.referee_id
      LEFT JOIN pool_athletes pa ON pa.pool_id = jp.pool_id
      LEFT JOIN athletes      a  ON a.id  = pa.athlete_id
      LEFT JOIN tournament_registrations tr ON tr.athlete_id = a.id AND tr.tournament_id = jp.tournament_id
      LEFT JOIN clubs    cl ON cl.id = a.club_id
      WHERE jp.tournament_id = $1${ageFilter}
      GROUP BY jp.id, c.gender, c.weight_category, p.name, p.status, m.name, m.id, u.name
      ORDER BY jp.display_order
    `, params);

    const uParams = [req.params.id];
    let uAgeFilter = '';
    if (age_category) { uParams.push(age_category); uAgeFilter = ` AND ju.age_category = $2`; }

    const unassignedR = await pool.query(`
      SELECT ju.*, a.first_name || ' ' || a.last_name AS name, a.gender,
        COALESCE(cl.short_name, cl.name, '—') AS club
      FROM jeunes_unassigned ju
      JOIN athletes a ON a.id = ju.athlete_id
      LEFT JOIN clubs cl ON cl.id = a.club_id
      WHERE ju.tournament_id = $1${uAgeFilter}
      ORDER BY ju.age_category, ju.weigh_in_weight
    `, uParams);

    res.json({ pools: poolsR.rows, unassigned: unassignedR.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

// POST — Générer les poules
app.post('/api/tournaments/:id/jeunes/generate', verifyToken, async (req, res) => {
  try {
    if (!await hasTournamentRole(req.user.userId, req.params.id, ['tournament_admin']))
      return res.status(403).json({ error: 'Accès refusé' });
    const { reset = false, age_categories = ['U9', 'U11'] } = req.body;
    // Lire la tolérance configurée dans les paramètres du tournoi
    const tR = await pool.query('SELECT COALESCE(jeunes_weight_tolerance,10.0) AS tol FROM tournaments WHERE id=$1', [req.params.id]);
    const tolerance = Number(tR.rows[0]?.tol ?? 10.0);
    const result = await generateJeunesPools(req.params.id, { reset, age_categories, tolerance });
    broadcastToTournament(req.params.id, { type: 'jeunes_updated' });
    res.json(result);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur génération poules jeunes' }); }
});

// DELETE — Supprimer toutes les poules jeunes
app.delete('/api/tournaments/:id/jeunes', verifyToken, async (req, res) => {
  try {
    if (!await hasTournamentRole(req.user.userId, req.params.id, ['tournament_admin']))
      return res.status(403).json({ error: 'Accès refusé' });
    await deleteJeunesPools(req.params.id);
    broadcastToTournament(req.params.id, { type: 'jeunes_updated' });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur suppression' }); }
});

// PUT — Assigner tapis et arbitre
app.put('/api/tournaments/:id/jeunes/pools/:jeunesPoolId', verifyToken, async (req, res) => {
  try {
    if (!await hasTournamentRole(req.user.userId, req.params.id, ['tournament_admin']))
      return res.status(403).json({ error: 'Accès refusé' });
    const { mat_id, referee_id } = req.body;
    const r = await pool.query(
      `UPDATE jeunes_pools SET mat_id=$1, referee_id=$2, updated_at=now()
       WHERE id=$3 AND tournament_id=$4 RETURNING *`,
      [mat_id || null, referee_id || null, req.params.jeunesPoolId, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Poule introuvable' });
    const jp = r.rows[0];

    // Sync match_queue.mat_id for all ready (not yet started) matches of this pool
    if (mat_id) {
      await pool.query(
        `UPDATE match_queue SET mat_id=$1, updated_at=now()
         WHERE tournament_id=$2 AND status='ready'
           AND match_id IN (
             SELECT id FROM matches WHERE competition_id=$3 AND status != 'finished'
           )`,
        [mat_id, req.params.id, jp.competition_id]
      );
    } else {
      // Remove mat from ready matches only (never touch on_mat)
      await pool.query(
        `UPDATE match_queue SET mat_id=NULL, updated_at=now()
         WHERE tournament_id=$1 AND status='ready'
           AND match_id IN (
             SELECT id FROM matches WHERE competition_id=$2 AND status != 'finished'
           )`,
        [req.params.id, jp.competition_id]
      );
    }

    broadcastToTournament(req.params.id, { type: 'jeunes_updated' });
    res.json(jp);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

// PUT — Déplacer un athlète vers une autre poule (ajustement manuel)
app.put('/api/tournaments/:id/jeunes/pools/:jeunesPoolId/athletes', verifyToken, async (req, res) => {
  try {
    if (!await hasTournamentRole(req.user.userId, req.params.id, ['tournament_admin']))
      return res.status(403).json({ error: 'Accès refusé' });
    const { athlete_id, target_jeunes_pool_id } = req.body;
    const srcR = await pool.query('SELECT * FROM jeunes_pools WHERE id=$1 AND tournament_id=$2', [req.params.jeunesPoolId, req.params.id]);
    if (!srcR.rows.length) return res.status(404).json({ error: 'Poule source introuvable' });
    const dstR = await pool.query('SELECT * FROM jeunes_pools WHERE id=$1 AND tournament_id=$2', [target_jeunes_pool_id, req.params.id]);
    if (!dstR.rows.length) return res.status(404).json({ error: 'Poule destination introuvable' });
    await pool.query(`UPDATE pool_athletes SET pool_id=$1 WHERE pool_id=$2 AND athlete_id=$3`, [dstR.rows[0].pool_id, srcR.rows[0].pool_id, athlete_id]);
    await pool.query(`UPDATE tournament_registrations SET competition_id=$1 WHERE tournament_id=$2 AND athlete_id=$3`, [dstR.rows[0].competition_id, req.params.id, athlete_id]);
    broadcastToTournament(req.params.id, { type: 'jeunes_updated' });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur déplacement athlète' }); }
});

// Helper — recalculate gender + weight range for a jeunes pool after roster change
async function _recalcPoolMeta(tournamentId, jp) {
  // Remaining athletes
  const statsR = await pool.query(`
    SELECT a.gender, MIN(tr.weigh_in_weight_kg::NUMERIC) AS wmin, MAX(tr.weigh_in_weight_kg::NUMERIC) AS wmax,
      COUNT(*) AS cnt
    FROM pool_athletes pa
    JOIN athletes a ON a.id = pa.athlete_id
    JOIN tournament_registrations tr ON tr.athlete_id = pa.athlete_id AND tr.tournament_id=$1
    WHERE pa.pool_id=$2
    GROUP BY a.gender
  `, [tournamentId, jp.pool_id]);

  const cnt = statsR.rows.reduce((s, r) => s + Number(r.cnt), 0);
  if (cnt === 0) return { athletes_remaining: 0 };

  const genders = [...new Set(statsR.rows.map(r => r.gender))];
  const newGender = genders.length === 1 ? genders[0] : 'MX';
  const newStrategy = newGender === 'MX' ? 'mixed' : (newGender === 'F' ? 'girls_first' : 'boys_only');
  const wmin = Math.min(...statsR.rows.map(r => Number(r.wmin)));
  const wmax = Math.max(...statsR.rows.map(r => Number(r.wmax)));

  await pool.query(
    `UPDATE jeunes_pools SET weight_min=$1,weight_max=$2,gender_strategy=$3,updated_at=now() WHERE id=$4`,
    [wmin, wmax, newStrategy, jp.id]
  );
  await pool.query(
    `UPDATE competitions SET gender=$1::gender_type WHERE id=$2`,
    [newGender, jp.competition_id]
  );
  return { athletes_remaining: cnt };
}

// DELETE — Retirer un athlète d'une poule → non-assigné
app.delete('/api/tournaments/:id/jeunes/pools/:jeunesPoolId/athletes/:athleteId', verifyToken, async (req, res) => {
  try {
    if (!await hasTournamentRole(req.user.userId, req.params.id, ['tournament_admin']))
      return res.status(403).json({ error: 'Accès refusé' });
    const jpR = await pool.query('SELECT * FROM jeunes_pools WHERE id=$1 AND tournament_id=$2', [req.params.jeunesPoolId, req.params.id]);
    if (!jpR.rows.length) return res.status(404).json({ error: 'Poule introuvable' });
    const jp = jpR.rows[0];
    const trR = await pool.query(
      `SELECT id, weigh_in_weight_kg FROM tournament_registrations WHERE tournament_id=$1 AND athlete_id=$2`,
      [req.params.id, req.params.athleteId]
    );
    await pool.query(`DELETE FROM pool_athletes WHERE pool_id=$1 AND athlete_id=$2`, [jp.pool_id, req.params.athleteId]);
    await pool.query(`UPDATE tournament_registrations SET competition_id=NULL WHERE tournament_id=$1 AND athlete_id=$2`, [req.params.id, req.params.athleteId]);
    if (trR.rows.length) {
      const tr = trR.rows[0];
      await pool.query(`
        INSERT INTO jeunes_unassigned(id,tournament_id,registration_id,athlete_id,age_category,weigh_in_weight,reason)
        VALUES($1,$2,$3,$4,$5,$6,'manual_removal') ON CONFLICT(registration_id) DO NOTHING
      `, [uuidv4(), req.params.id, tr.id, req.params.athleteId, jp.age_category, tr.weigh_in_weight_kg]);
    }
    // Recalculer min/max + genre après retrait
    const meta = await _recalcPoolMeta(req.params.id, jp);
    broadcastToTournament(req.params.id, { type: 'jeunes_updated' });
    res.json({ ok: true, athletes_remaining: meta.athletes_remaining });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur suppression athlète' }); }
});

// DELETE — Supprimer une poule vide
app.delete('/api/tournaments/:id/jeunes/pools/:jeunesPoolId', verifyToken, async (req, res) => {
  try {
    if (!await hasTournamentRole(req.user.userId, req.params.id, ['tournament_admin']))
      return res.status(403).json({ error: 'Accès refusé' });
    const jpR = await pool.query('SELECT * FROM jeunes_pools WHERE id=$1 AND tournament_id=$2', [req.params.jeunesPoolId, req.params.id]);
    if (!jpR.rows.length) return res.status(404).json({ error: 'Poule introuvable' });
    const jp = jpR.rows[0];

    // Vérifier qu'il n'y a plus d'athlètes
    const cntR = await pool.query(`SELECT COUNT(*) AS cnt FROM pool_athletes WHERE pool_id=$1`, [jp.pool_id]);
    if (Number(cntR.rows[0].cnt) > 0)
      return res.status(409).json({ error: 'La poule contient encore des athlètes — retirez-les d\'abord' });

    // Supprimer combats & file d'attente liés
    await pool.query(`DELETE FROM match_queue WHERE match_id IN (SELECT id FROM matches WHERE competition_id=$1)`, [jp.competition_id]);
    await pool.query(`DELETE FROM matches WHERE competition_id=$1`, [jp.competition_id]);
    // Supprimer la poule elle-même
    await pool.query(`DELETE FROM pools WHERE id=$1`, [jp.pool_id]);
    // Supprimer jeunes_pools
    await pool.query(`DELETE FROM jeunes_pools WHERE id=$1`, [jp.id]);
    // Supprimer la compétition
    await pool.query(`DELETE FROM competitions WHERE id=$1`, [jp.competition_id]);

    broadcastToTournament(req.params.id, { type: 'jeunes_updated' });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur suppression poule' }); }
});

// POST — Assigner un athlète non assigné à une poule existante
app.post('/api/tournaments/:id/jeunes/unassigned/:athleteId/assign', verifyToken, async (req, res) => {
  try {
    if (!await hasTournamentRole(req.user.userId, req.params.id, ['tournament_admin']))
      return res.status(403).json({ error: 'Accès refusé' });
    const { jeunes_pool_id } = req.body;
    const jpR = await pool.query('SELECT * FROM jeunes_pools WHERE id=$1 AND tournament_id=$2', [jeunes_pool_id, req.params.id]);
    if (!jpR.rows.length) return res.status(404).json({ error: 'Poule introuvable' });
    const jp = jpR.rows[0];
    // Vérifier que l'athlète est dans jeunes_unassigned
    const uR = await pool.query(`SELECT * FROM jeunes_unassigned WHERE tournament_id=$1 AND athlete_id=$2`, [req.params.id, req.params.athleteId]);
    if (!uR.rows.length) return res.status(404).json({ error: 'Athlète non trouvé dans les non-assignés' });
    const ua = uR.rows[0];
    // Calculer le prochain seed_order
    const seedR = await pool.query(`SELECT COALESCE(MAX(seed_order),0)+1 AS next FROM pool_athletes WHERE pool_id=$1`, [jp.pool_id]);
    const nextSeed = seedR.rows[0].next;
    // Ajouter à la poule
    await pool.query(`INSERT INTO pool_athletes(id,pool_id,athlete_id,seed_order) VALUES($1,$2,$3,$4)`,
      [uuidv4(), jp.pool_id, req.params.athleteId, nextSeed]);
    // Lier la registration
    await pool.query(`UPDATE tournament_registrations SET competition_id=$1 WHERE id=$2`,
      [jp.competition_id, ua.registration_id]);
    // Supprimer de jeunes_unassigned
    await pool.query(`DELETE FROM jeunes_unassigned WHERE tournament_id=$1 AND athlete_id=$2`, [req.params.id, req.params.athleteId]);
    // Recalculer min/max + genre après ajout
    await _recalcPoolMeta(req.params.id, jp);
    broadcastToTournament(req.params.id, { type: 'jeunes_updated' });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur assignation athlète' }); }
});

// POST — Créer une poule manuellement depuis les non-assignés
app.post('/api/tournaments/:id/jeunes/pools', verifyToken, async (req, res) => {
  try {
    if (!await hasTournamentRole(req.user.userId, req.params.id, ['tournament_admin']))
      return res.status(403).json({ error: 'Accès refusé' });
    const { age_category, athlete_ids = [] } = req.body;
    if (!age_category) return res.status(400).json({ error: 'age_category requis' });
    if (!athlete_ids.length) return res.status(400).json({ error: 'Sélectionnez au moins un athlète' });

    // Récupérer les infos des athlètes dans jeunes_unassigned
    const uR = await pool.query(`
      SELECT ju.athlete_id, ju.registration_id, ju.weigh_in_weight,
        a.gender, a.first_name||' '||a.last_name AS name
      FROM jeunes_unassigned ju
      JOIN athletes a ON a.id = ju.athlete_id
      WHERE ju.tournament_id=$1 AND ju.athlete_id=ANY($2::uuid[])
    `, [req.params.id, athlete_ids]);
    if (!uR.rows.length) return res.status(404).json({ error: 'Athlètes introuvables dans les non-assignés' });
    const athData = uR.rows;

    // Déterminer le genre de la poule
    const genders = [...new Set(athData.map(a => a.gender))];
    const poolGender = genders.length === 1 ? genders[0] : 'MX';

    // Plage de poids
    const weights = athData.map(a => Number(a.weigh_in_weight));
    const wMin = Math.min(...weights);
    const wMax = Math.max(...weights);

    // Display order + per-category sequence for naming
    const orderR = await pool.query(`SELECT COALESCE(MAX(display_order),0)+1 AS next FROM jeunes_pools WHERE tournament_id=$1`, [req.params.id]);
    const displayOrder = Number(orderR.rows[0].next);
    const cntR = await pool.query(`SELECT COUNT(*) AS cnt FROM jeunes_pools WHERE tournament_id=$1 AND age_category=$2`, [req.params.id, age_category]);
    const poolSeq = String(Number(cntR.rows[0].cnt) + 1).padStart(2, '0');
    const poolName = `${age_category}-${poolSeq}`;

    // weight_category unique (éviter conflit UNIQUE sur competitions)
    let wCategory = `${wMin.toFixed(1)}-${wMax.toFixed(1)}`;
    const dupR = await pool.query(
      `SELECT 1 FROM competitions WHERE tournament_id=$1 AND source='jeunes' AND weight_category=$2 AND age_category=$3::age_category AND gender=$4::gender_type`,
      [req.params.id, wCategory, age_category, poolGender]
    );
    if (dupR.rows.length) wCategory = `${wCategory} (${displayOrder})`;

    // Création dans une transaction
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const compId = uuidv4();
      await client.query(`
        INSERT INTO competitions(id,tournament_id,style,gender,age_category,weight_category,format_type,source)
        VALUES($1,$2,'libre',$3,$4,$5,'nordic','jeunes')
      `, [compId, req.params.id, poolGender, age_category, wCategory]);

      const poolId = uuidv4();
      await client.query(`INSERT INTO pools(id,competition_id,tournament_id,name,status) VALUES($1,$2,$3,$4,'active')`,
        [poolId, compId, req.params.id, poolName]);

      for (let i = 0; i < athData.length; i++) {
        const a = athData[i];
        await client.query(`INSERT INTO pool_athletes(id,pool_id,athlete_id,seed_order) VALUES($1,$2,$3,$4)`,
          [uuidv4(), poolId, a.athlete_id, i + 1]);
        await client.query(`UPDATE tournament_registrations SET competition_id=$1 WHERE id=$2`, [compId, a.registration_id]);
        await client.query(`DELETE FROM jeunes_unassigned WHERE tournament_id=$1 AND athlete_id=$2`, [req.params.id, a.athlete_id]);
      }

      const strategyMap = { F: 'girls_first', M: 'boys_only', MX: 'mixed' };
      await client.query(`
        INSERT INTO jeunes_pools(id,tournament_id,competition_id,pool_id,age_category,weight_min,weight_max,gender_strategy,display_order)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
      `, [uuidv4(), req.params.id, compId, poolId, age_category, wMin, wMax, strategyMap[poolGender] || 'mixed', displayOrder]);

      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }

    broadcastToTournament(req.params.id, { type: 'jeunes_updated' });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur création poule' }); }
});

// POST — Générer les matchs d'une poule
app.post('/api/tournaments/:id/jeunes/pools/:jeunesPoolId/generate-matches', verifyToken, async (req, res) => {
  try {
    if (!await hasTournamentRole(req.user.userId, req.params.id, ['tournament_admin']))
      return res.status(403).json({ error: 'Accès refusé' });
    const jpR = await pool.query('SELECT * FROM jeunes_pools WHERE id=$1 AND tournament_id=$2', [req.params.jeunesPoolId, req.params.id]);
    if (!jpR.rows.length) return res.status(404).json({ error: 'Poule introuvable' });
    const jp = jpR.rows[0];
    const athletesR = await pool.query(
      `SELECT a.*, c.short_name AS club_short, pa.seed_order
       FROM pool_athletes pa
       JOIN athletes a ON a.id = pa.athlete_id
       LEFT JOIN clubs c ON c.id = a.club_id
       WHERE pa.pool_id = $1 ORDER BY pa.seed_order`,
      [jp.pool_id]
    );
    if (athletesR.rows.length < 2) return res.status(400).json({ error: 'Pas assez d\'athlètes (minimum 2)' });
    await pool.query(`DELETE FROM match_queue WHERE match_id IN (SELECT id FROM matches WHERE competition_id=$1)`, [jp.competition_id]);
    await pool.query(`DELETE FROM matches WHERE competition_id=$1`, [jp.competition_id]);
    const poolRow = (await pool.query('SELECT * FROM pools WHERE id=$1', [jp.pool_id])).rows[0];
    const matches = await generateNordic(jp.competition_id, req.params.id, athletesR.rows, poolRow);
    for (let i = 0; i < matches.length; i++) {
      await pool.query(
        'INSERT INTO match_queue(id,tournament_id,match_id,position,status,mat_id) VALUES($1,$2,$3,$4,$5,$6)',
        [uuidv4(), req.params.id, matches[i].id, i + 1, 'ready', jp.mat_id || null]
      );
    }
    broadcastToTournament(req.params.id, { type: 'jeunes_updated' });
    res.json({ matches_created: matches.length });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur génération matchs' }); }
});

// POST — Générer tous les matchs d'une catégorie d'âge
app.post('/api/tournaments/:id/jeunes/:ageCategory/generate-matches', verifyToken, async (req, res) => {
  try {
    if (!await hasTournamentRole(req.user.userId, req.params.id, ['tournament_admin']))
      return res.status(403).json({ error: 'Accès refusé' });
    const { ageCategory } = req.params;
    const poolsR = await pool.query(
      `SELECT jp.* FROM jeunes_pools jp WHERE jp.tournament_id=$1 AND jp.age_category=$2 ORDER BY jp.display_order`,
      [req.params.id, ageCategory]
    );
    let totalMatches = 0;
    for (const jp of poolsR.rows) {
      const athletesR = await pool.query(
        `SELECT a.*, c.short_name AS club_short, pa.seed_order
         FROM pool_athletes pa JOIN athletes a ON a.id=pa.athlete_id LEFT JOIN clubs c ON c.id=a.club_id
         WHERE pa.pool_id=$1 ORDER BY pa.seed_order`, [jp.pool_id]
      );
      if (athletesR.rows.length < 2) continue;
      await pool.query(`DELETE FROM match_queue WHERE match_id IN (SELECT id FROM matches WHERE competition_id=$1)`, [jp.competition_id]);
      await pool.query(`DELETE FROM matches WHERE competition_id=$1`, [jp.competition_id]);
      const poolRow = (await pool.query('SELECT * FROM pools WHERE id=$1', [jp.pool_id])).rows[0];
      const matches = await generateNordic(jp.competition_id, req.params.id, athletesR.rows, poolRow);
      for (let i = 0; i < matches.length; i++) {
        await pool.query('INSERT INTO match_queue(id,tournament_id,match_id,position,status,mat_id) VALUES($1,$2,$3,$4,$5,$6)',
          [uuidv4(), req.params.id, matches[i].id, i + 1, 'ready', jp.mat_id || null]);
      }
      totalMatches += matches.length;
    }
    broadcastToTournament(req.params.id, { type: 'jeunes_updated' });
    res.json({ matches_created: totalMatches, pools_processed: poolsR.rows.length });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur génération matchs' }); }
});

// GET — Classements par poule jeunes
app.get('/api/tournaments/:id/jeunes/rankings', async (req, res) => {
  try {
    const { age_category } = req.query;
    const params = [req.params.id];
    let ageFilter = '';
    if (age_category) { params.push(age_category); ageFilter = ` AND jp.age_category = $2`; }
    const poolsR = await pool.query(`
      SELECT jp.id AS jeunes_pool_id, jp.age_category, jp.weight_min, jp.weight_max,
        jp.competition_id, jp.pool_id, c.gender, p.name AS pool_name, jp.display_order,
        jp.mat_id, mt.name AS mat_name
      FROM jeunes_pools jp
      JOIN competitions c ON c.id = jp.competition_id
      JOIN pools p ON p.id = jp.pool_id
      LEFT JOIN mats mt ON mt.id = jp.mat_id
      WHERE jp.tournament_id=$1${ageFilter}
      ORDER BY jp.display_order
    `, params);
    const result = [];
    for (const jp of poolsR.rows) {
      const rankings = await computePoolRankings(jp.competition_id, jp.pool_id);
      const matchesR = await pool.query(
        `SELECT m.id, m.round, m.position, m.status, m.win_type,
            m.score_red, m.score_blue, m.red_athlete_id, m.blue_athlete_id, m.winner_id,
            r.first_name||' '||r.last_name AS red_name,
            b.first_name||' '||b.last_name AS blue_name,
            w.first_name||' '||w.last_name AS winner_name,
            mq.mat_id AS queue_mat_id, mt.name AS queue_mat_name, mq.status AS queue_status
         FROM matches m
         LEFT JOIN athletes r ON r.id=m.red_athlete_id
         LEFT JOIN athletes b ON b.id=m.blue_athlete_id
         LEFT JOIN athletes w ON w.id=m.winner_id
         LEFT JOIN match_queue mq ON mq.match_id=m.id
         LEFT JOIN mats mt ON mt.id=mq.mat_id
         WHERE m.competition_id=$1 AND m.is_bye=false
         ORDER BY m.round, m.position`,
        [jp.competition_id]
      );
      // All pool athletes for complete ranking (even before matches)
      const athletesR = await pool.query(
        `SELECT pa.athlete_id, a.first_name||' '||a.last_name AS name,
            COALESCE(c.short_name, c.name, '—') AS club,
            tr.weigh_in_weight_kg::NUMERIC(6,2) AS weight
         FROM pool_athletes pa
         JOIN athletes a ON a.id=pa.athlete_id
         LEFT JOIN clubs c ON c.id=a.club_id
         LEFT JOIN tournament_registrations tr ON tr.athlete_id=pa.athlete_id AND tr.tournament_id=$2
         WHERE pa.pool_id=$1
         ORDER BY pa.seed_order`,
        [jp.pool_id, req.params.id]
      );
      result.push({
        jeunes_pool_id: jp.jeunes_pool_id,
        age_category: jp.age_category,
        weight_range: `${Number(jp.weight_min).toFixed(1)}–${Number(jp.weight_max).toFixed(1)}`,
        gender: jp.gender,
        pool_name: jp.pool_name,
        display_order: jp.display_order,
        mat_name: jp.mat_name,
        rankings,
        matches: matchesR.rows,
        athletes: athletesR.rows,
      });
    }
    res.json(result);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur classements' }); }
});

// GET — Temps de repos par athlète (jeunes)
app.get('/api/tournaments/:id/jeunes/rest-times', async (req, res) => {
  try {
    const { age_category } = req.query;
    const params = [req.params.id];
    let ageFilter = '';
    if (age_category) { params.push(age_category); ageFilter = ` AND jp.age_category = $2`; }
    const matchesR = await pool.query(`
      SELECT m.red_athlete_id, m.blue_athlete_id,
        m.updated_at AS finished_at,
        ra.first_name||' '||ra.last_name AS red_name,
        ba.first_name||' '||ba.last_name AS blue_name,
        jp.age_category
      FROM matches m
      JOIN competitions c ON c.id = m.competition_id
      JOIN jeunes_pools jp ON jp.competition_id = c.id
      LEFT JOIN athletes ra ON ra.id = m.red_athlete_id
      LEFT JOIN athletes ba ON ba.id = m.blue_athlete_id
      WHERE c.tournament_id=$1 AND c.source='jeunes' AND m.status='finished' AND m.is_bye=false${ageFilter}
      ORDER BY m.updated_at DESC
    `, params);
    const lastFight = new Map();
    for (const m of matchesR.rows) {
      for (const [athId, athName] of [[m.red_athlete_id, m.red_name], [m.blue_athlete_id, m.blue_name]]) {
        if (!athId) continue;
        if (!lastFight.has(athId)) {
          lastFight.set(athId, { athlete_id: athId, name: athName, finished_at: m.finished_at, age_category: m.age_category });
        }
      }
    }
    const tR = await pool.query('SELECT min_rest_minutes FROM tournaments WHERE id=$1', [req.params.id]);
    const minRest = tR.rows[0]?.min_rest_minutes ?? 5;
    const athletes = [...lastFight.values()].map(v => ({
      ...v,
      elapsed_seconds: Math.floor((Date.now() - new Date(v.finished_at).getTime()) / 1000),
      min_rest_seconds: minRest * 60,
      rested: Math.floor((Date.now() - new Date(v.finished_at).getTime()) / 1000) >= minRest * 60,
    }));
    res.json({ min_rest_minutes: minRest, athletes });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur temps de repos' }); }
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

// ─────────────────────────────────────────────
// MIGRATIONS IDEMPOTENTES AU DÉMARRAGE
// ─────────────────────────────────────────────
pool.query(`ALTER TABLE mats ADD COLUMN IF NOT EXISTS referee_id UUID REFERENCES users(id) ON DELETE SET NULL`)
  .catch(e => console.warn('Migration mats.referee_id:', e.message));

pool.query(`ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS min_rest_minutes INT NOT NULL DEFAULT 5`)
  .catch(e => console.warn('Migration tournaments.min_rest_minutes:', e.message));

pool.query(`ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS jeunes_weight_tolerance NUMERIC(4,1) NOT NULL DEFAULT 10.0`)
  .catch(e => console.warn('Migration tournaments.jeunes_weight_tolerance:', e.message));

// Allow 'MX' (mixte) gender for jeunes mixed pools
// ALTER TYPE ADD VALUE cannot run inside a transaction — must be a top-level statement
pool.query(`ALTER TYPE gender_type ADD VALUE IF NOT EXISTS 'MX'`)
  .catch(e => console.warn('Migration gender_type MX:', e.message));

// Jeunes: source column on competitions (standard vs jeunes)
pool.query(`ALTER TABLE competitions ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'standard'`)
  .catch(e => console.warn('Migration competitions.source:', e.message));

// Jeunes pools metadata table
pool.query(`
  CREATE TABLE IF NOT EXISTS jeunes_pools (
    id UUID PRIMARY KEY,
    tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    competition_id UUID NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
    pool_id UUID NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
    age_category VARCHAR(10) NOT NULL,
    weight_min NUMERIC(6,2) NOT NULL,
    weight_max NUMERIC(6,2) NOT NULL,
    gender_strategy VARCHAR(20) NOT NULL DEFAULT 'mixed',
    mat_id UUID REFERENCES mats(id) ON DELETE SET NULL,
    referee_id UUID REFERENCES users(id) ON DELETE SET NULL,
    display_order INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
  )
`).catch(e => console.warn('Migration jeunes_pools:', e.message));

// Unassigned athletes for jeunes
pool.query(`
  CREATE TABLE IF NOT EXISTS jeunes_unassigned (
    id UUID PRIMARY KEY,
    tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    registration_id UUID NOT NULL REFERENCES tournament_registrations(id) ON DELETE CASCADE,
    athlete_id UUID NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
    age_category VARCHAR(10) NOT NULL,
    weigh_in_weight NUMERIC(6,2),
    reason VARCHAR(50) DEFAULT 'no_pool_fit',
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(registration_id)
  )
`).catch(e => console.warn('Migration jeunes_unassigned:', e.message));

server.listen(PORT, () => {
  console.log(`🏆 Lutte API démarrée sur le port ${PORT}`);
  console.log(`📍 Health: http://localhost:${PORT}/api/health`);
});

export default app;
