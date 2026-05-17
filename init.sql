-- ============================================================
-- DROP EVERYTHING (ordre inverse des dépendances)
-- ============================================================
DROP TABLE IF EXISTS audit_logs CASCADE;
DROP TABLE IF EXISTS mat_sessions CASCADE;
DROP TABLE IF EXISTS mat_accounts CASCADE;
DROP TABLE IF EXISTS role_permissions CASCADE;
DROP TABLE IF EXISTS tournament_users CASCADE;
DROP TABLE IF EXISTS global_roles CASCADE;
DROP TABLE IF EXISTS match_queue CASCADE;
DROP TABLE IF EXISTS repechage_matches CASCADE;
DROP TABLE IF EXISTS repechage_brackets CASCADE;
DROP TABLE IF EXISTS match_results CASCADE;
DROP TABLE IF EXISTS matches CASCADE;
DROP TABLE IF EXISTS pool_athletes CASCADE;
DROP TABLE IF EXISTS pools CASCADE;
DROP TABLE IF EXISTS competitions CASCADE;
DROP TABLE IF EXISTS tournament_registrations CASCADE;
DROP TABLE IF EXISTS mats CASCADE;
DROP TABLE IF EXISTS athletes CASCADE;
DROP TABLE IF EXISTS tournaments CASCADE;
DROP TABLE IF EXISTS clubs CASCADE;
DROP TABLE IF EXISTS users CASCADE;

-- DROP old tables if exist
DROP TABLE IF EXISTS bout_events CASCADE;
DROP TABLE IF EXISTS bout_queue CASCADE;
DROP TABLE IF EXISTS bouts CASCADE;
DROP TABLE IF EXISTS pool_athletes CASCADE;
DROP TABLE IF EXISTS competition_users CASCADE;
DROP TABLE IF EXISTS profiles CASCADE;
DROP TABLE IF EXISTS user_roles CASCADE;
DROP TABLE IF EXISTS categories CASCADE;
DROP TABLE IF EXISTS bout_queue CASCADE;

-- DROP ENUMs
DROP TYPE IF EXISTS tournament_status CASCADE;
DROP TYPE IF EXISTS global_role CASCADE;
DROP TYPE IF EXISTS tournament_role CASCADE;
DROP TYPE IF EXISTS wrestling_style CASCADE;
DROP TYPE IF EXISTS gender_type CASCADE;
DROP TYPE IF EXISTS age_category CASCADE;
DROP TYPE IF EXISTS competition_format CASCADE;
DROP TYPE IF EXISTS match_status CASCADE;
DROP TYPE IF EXISTS match_bracket CASCADE;
DROP TYPE IF EXISTS match_phase CASCADE;
DROP TYPE IF EXISTS match_type CASCADE;
DROP TYPE IF EXISTS win_type CASCADE;
DROP TYPE IF EXISTS weigh_in_status CASCADE;
DROP TYPE IF EXISTS queue_status CASCADE;
DROP TYPE IF EXISTS repechage_mode CASCADE;
DROP TYPE IF EXISTS app_role CASCADE;
DROP TYPE IF EXISTS pool_status CASCADE;
DROP TYPE IF EXISTS bout_status CASCADE;
DROP TYPE IF EXISTS win_type CASCADE;
DROP TYPE IF EXISTS wrestling_style CASCADE;
DROP TYPE IF EXISTS gender CASCADE;
DROP TYPE IF EXISTS age_cat CASCADE;
DROP TYPE IF EXISTS pool_format CASCADE;
DROP TYPE IF EXISTS bout_slot CASCADE;

-- ============================================================
-- ENUMS
-- ============================================================

CREATE TYPE tournament_status AS ENUM (
  'draft',
  'registrations_open',
  'weigh_in',
  'running',
  'finished'
);

CREATE TYPE global_role AS ENUM (
  'super_admin',
  'admin'
);

CREATE TYPE tournament_role AS ENUM (
  'tournament_admin',
  'mat_manager',
  'referee',
  'weigh_in_manager',
  'viewer'
);

CREATE TYPE wrestling_style AS ENUM (
  'libre',
  'greco',
  'feminine',
  'jeune',
  'grappling',
  'jjb'
);

CREATE TYPE gender_type AS ENUM ('M', 'F');

CREATE TYPE age_category AS ENUM (
  'U7', 'U9', 'U11', 'U13', 'U15', 'U17', 'U19', 'Senior'
);

CREATE TYPE competition_format AS ENUM (
  'nordic',
  'pools_finals',
  'bracket_repechage'
);

CREATE TYPE match_status AS ENUM (
  'waiting',
  'ready',
  'blocked',
  'on_mat',
  'finished'
);

CREATE TYPE match_bracket AS ENUM (
  'main',
  'repechage',
  'bronze',
  'final'
);

CREATE TYPE match_phase AS ENUM (
  'pool',
  'main_bracket',
  'repechage',
  'final'
);

CREATE TYPE match_type AS ENUM (
  'qualification',
  'main_bracket',
  'repechage',
  'semifinal',
  'bronze',
  'final'
);

CREATE TYPE win_type AS ENUM (
  'points',
  'fall',
  'superiority',
  'dq',
  'forfeit',
  'abandon',
  'bye'
);

CREATE TYPE weigh_in_status AS ENUM (
  'pending',
  'done',
  'no_show',
  'overweight'
);

CREATE TYPE queue_status AS ENUM (
  'waiting',
  'ready',
  'blocked',
  'on_mat',
  'finished'
);

CREATE TYPE repechage_mode AS ENUM (
  'official_uww',
  'simplified_bronze'
);

-- ============================================================
-- USERS
-- ============================================================
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- GLOBAL ROLES
-- ============================================================
CREATE TABLE global_roles (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       global_role NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);

-- ============================================================
-- CLUBS
-- ============================================================
CREATE TABLE clubs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fflda_number      TEXT UNIQUE,
  short_name        TEXT NOT NULL,
  name              TEXT NOT NULL,
  regional_committee TEXT,
  city              TEXT,
  country           TEXT DEFAULT 'France',
  coach_name        TEXT,
  logo_url          TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- TOURNAMENTS
-- ============================================================
CREATE TABLE tournaments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT NOT NULL,
  slug              TEXT UNIQUE NOT NULL,
  event_date        DATE NOT NULL,
  city              TEXT NOT NULL,
  organizer_club_id UUID REFERENCES clubs(id) ON DELETE SET NULL,
  logo_url          TEXT,
  number_of_mats    INT NOT NULL DEFAULT 1,
  status            tournament_status NOT NULL DEFAULT 'draft',
  repechage_mode    repechage_mode NOT NULL DEFAULT 'official_uww',

  -- Visibilité publique
  public_page_enabled          BOOLEAN NOT NULL DEFAULT false,
  public_program_enabled       BOOLEAN NOT NULL DEFAULT false,
  public_results_enabled       BOOLEAN NOT NULL DEFAULT false,
  public_live_matches_enabled  BOOLEAN NOT NULL DEFAULT false,
  public_rankings_enabled      BOOLEAN NOT NULL DEFAULT false,

  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- TOURNAMENT USERS (rôles par tournoi)
-- ============================================================
CREATE TABLE tournament_users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          tournament_role NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tournament_id, user_id, role)
);

-- ============================================================
-- MATS
-- ============================================================
CREATE TABLE mats (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,          -- "A", "B", "C"...
  slug          TEXT NOT NULL,          -- "mat-a"
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tournament_id, slug)
);

-- ============================================================
-- MAT ACCOUNTS (comptes génériques tapis)
-- ============================================================
CREATE TABLE mat_accounts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  mat_id        UUID NOT NULL REFERENCES mats(id) ON DELETE CASCADE,
  username      TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tournament_id, mat_id)
);

-- ============================================================
-- MAT SESSIONS
-- ============================================================
CREATE TABLE mat_sessions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mat_id     UUID NOT NULL REFERENCES mats(id) ON DELETE CASCADE,
  user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  token      TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

-- ============================================================
-- ATHLETES
-- ============================================================
CREATE TABLE athletes (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  license_number        TEXT UNIQUE NOT NULL,
  first_name            TEXT NOT NULL,
  last_name             TEXT NOT NULL,
  gender                gender_type NOT NULL,
  nationality           TEXT DEFAULT 'France',
  birth_date            DATE,
  style                 wrestling_style,
  age_category_imported TEXT,
  licensed_age_category TEXT,
  mastery_level         TEXT,
  default_weight_kg     NUMERIC(5,2),
  license_status        TEXT,
  club_id               UUID REFERENCES clubs(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- TOURNAMENT REGISTRATIONS
-- ============================================================
CREATE TABLE tournament_registrations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id       UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  athlete_id          UUID NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  weigh_in_weight_kg  NUMERIC(5,2),
  weigh_in_status     weigh_in_status NOT NULL DEFAULT 'pending',
  final_age_category  age_category,
  final_weight_category TEXT,
  final_style         wrestling_style,
  competition_id      UUID,               -- lié après génération
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tournament_id, athlete_id)
);

-- ============================================================
-- COMPETITIONS
-- ============================================================
CREATE TABLE competitions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id  UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  style          wrestling_style NOT NULL,
  gender         gender_type NOT NULL,
  age_category   age_category NOT NULL,
  weight_category TEXT NOT NULL,
  format_type    competition_format NOT NULL DEFAULT 'nordic',
  repechage_mode repechage_mode NOT NULL DEFAULT 'official_uww',
  athlete_count  INT NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'draft',  -- draft, running, finished
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tournament_id, style, gender, age_category, weight_category)
);

-- FK retour sur tournament_registrations
ALTER TABLE tournament_registrations
  ADD CONSTRAINT fk_reg_competition
  FOREIGN KEY (competition_id) REFERENCES competitions(id) ON DELETE SET NULL;

-- ============================================================
-- POOLS
-- ============================================================
CREATE TABLE pools (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id UUID NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  tournament_id  UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,       -- "Poule A", "Poule B"
  status         TEXT NOT NULL DEFAULT 'draft',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- POOL ATHLETES
-- ============================================================
CREATE TABLE pool_athletes (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_id        UUID NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
  athlete_id     UUID NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  registration_id UUID REFERENCES tournament_registrations(id) ON DELETE SET NULL,
  seed_order     INT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (pool_id, athlete_id)
);

-- ============================================================
-- MATCHES
-- ============================================================
CREATE TABLE matches (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id   UUID NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  tournament_id    UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  pool_id          UUID REFERENCES pools(id) ON DELETE SET NULL,
  mat_id           UUID REFERENCES mats(id) ON DELETE SET NULL,

  round            INT NOT NULL DEFAULT 0,
  index_in_round   INT NOT NULL DEFAULT 0,
  bracket          match_bracket NOT NULL DEFAULT 'main',
  phase            match_phase NOT NULL DEFAULT 'main_bracket',
  match_type       match_type NOT NULL DEFAULT 'main_bracket',

  red_athlete_id   UUID REFERENCES athletes(id) ON DELETE SET NULL,
  blue_athlete_id  UUID REFERENCES athletes(id) ON DELETE SET NULL,

  winner_id        UUID REFERENCES athletes(id) ON DELETE SET NULL,
  loser_id         UUID REFERENCES athletes(id) ON DELETE SET NULL,

  winner_to        UUID,             -- FK vers matches(id) résolu après insert
  loser_to         UUID,
  parent_match_ids UUID[] DEFAULT '{}',
  next_match_id    UUID,

  status           match_status NOT NULL DEFAULT 'blocked',

  score_red        INT NOT NULL DEFAULT 0,
  score_blue       INT NOT NULL DEFAULT 0,
  win_type         win_type,

  scheduled_order  INT,
  duration_seconds INT,
  started_at       TIMESTAMPTZ,
  ended_at         TIMESTAMPTZ,

  is_bye           BOOLEAN NOT NULL DEFAULT false,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- MATCH RESULTS (historique)
-- ============================================================
CREATE TABLE match_results (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id       UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  winner_id      UUID REFERENCES athletes(id) ON DELETE SET NULL,
  loser_id       UUID REFERENCES athletes(id) ON DELETE SET NULL,
  score_red      INT NOT NULL DEFAULT 0,
  score_blue     INT NOT NULL DEFAULT 0,
  win_type       win_type,
  recorded_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- REPECHAGE BRACKETS
-- ============================================================
CREATE TABLE repechage_brackets (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id UUID NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  finalist_side  TEXT NOT NULL CHECK (finalist_side IN ('top', 'bottom')),
  finalist_id    UUID REFERENCES athletes(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- REPECHAGE MATCHES
-- ============================================================
CREATE TABLE repechage_matches (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repechage_bracket_id UUID NOT NULL REFERENCES repechage_brackets(id) ON DELETE CASCADE,
  match_id            UUID REFERENCES matches(id) ON DELETE SET NULL,
  source_match_ids    UUID[] DEFAULT '{}',
  level               INT NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- MATCH QUEUE
-- ============================================================
CREATE TABLE match_queue (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  match_id      UUID NOT NULL UNIQUE REFERENCES matches(id) ON DELETE CASCADE,
  mat_id        UUID REFERENCES mats(id) ON DELETE SET NULL,
  position      INT NOT NULL,
  priority      INT NOT NULL DEFAULT 0,
  status        queue_status NOT NULL DEFAULT 'waiting',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- ROLE PERMISSIONS
-- ============================================================
CREATE TABLE role_permissions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role       tournament_role NOT NULL,
  permission TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (role, permission)
);

-- ============================================================
-- AUDIT LOGS
-- ============================================================
CREATE TABLE audit_logs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id UUID REFERENCES tournaments(id) ON DELETE SET NULL,
  user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  action        TEXT NOT NULL,
  entity_type   TEXT NOT NULL,
  entity_id     UUID,
  old_data      JSONB,
  new_data      JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- TRIGGERS updated_at
-- ============================================================
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_clubs_updated_at
  BEFORE UPDATE ON clubs FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_tournaments_updated_at
  BEFORE UPDATE ON tournaments FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_athletes_updated_at
  BEFORE UPDATE ON athletes FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_registrations_updated_at
  BEFORE UPDATE ON tournament_registrations FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_competitions_updated_at
  BEFORE UPDATE ON competitions FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_matches_updated_at
  BEFORE UPDATE ON matches FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_match_queue_updated_at
  BEFORE UPDATE ON match_queue FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ============================================================
-- SLUG GENERATION HELPER
-- ============================================================
CREATE OR REPLACE FUNCTION generate_slug(input TEXT)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  result TEXT;
BEGIN
  result := lower(input);
  result := regexp_replace(result, '[àâä]', 'a', 'g');
  result := regexp_replace(result, '[éèêë]', 'e', 'g');
  result := regexp_replace(result, '[îï]', 'i', 'g');
  result := regexp_replace(result, '[ôö]', 'o', 'g');
  result := regexp_replace(result, '[ùûü]', 'u', 'g');
  result := regexp_replace(result, '[ç]', 'c', 'g');
  result := regexp_replace(result, '[^a-z0-9\s-]', '', 'g');
  result := regexp_replace(result, '\s+', '-', 'g');
  result := regexp_replace(result, '-+', '-', 'g');
  result := trim(both '-' from result);
  RETURN result;
END;
$$;

-- ============================================================
-- POINTS DE CLASSEMENT LUTTE
-- ============================================================
CREATE OR REPLACE FUNCTION match_ranking_points(wtype win_type, is_winner BOOLEAN)
RETURNS INT LANGUAGE plpgsql AS $$
BEGIN
  IF is_winner THEN
    CASE wtype
      WHEN 'fall', 'dq', 'forfeit', 'abandon' THEN RETURN 5;
      WHEN 'superiority' THEN RETURN 4;
      WHEN 'points' THEN RETURN 3;
      WHEN 'bye' THEN RETURN 0;
      ELSE RETURN 0;
    END CASE;
  ELSE
    RETURN 0;
  END IF;
END;
$$;

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX idx_tournaments_slug       ON tournaments(slug);
CREATE INDEX idx_tournaments_status     ON tournaments(status);
CREATE INDEX idx_tournaments_event_date ON tournaments(event_date);

CREATE INDEX idx_athletes_license       ON athletes(license_number);
CREATE INDEX idx_athletes_club          ON athletes(club_id);
CREATE INDEX idx_athletes_name          ON athletes(last_name, first_name);

CREATE INDEX idx_registrations_tournament ON tournament_registrations(tournament_id);
CREATE INDEX idx_registrations_athlete    ON tournament_registrations(athlete_id);
CREATE INDEX idx_registrations_competition ON tournament_registrations(competition_id);

CREATE INDEX idx_competitions_tournament ON competitions(tournament_id);
CREATE INDEX idx_competitions_style_gender ON competitions(style, gender, age_category);

CREATE INDEX idx_pools_competition      ON pools(competition_id);

CREATE INDEX idx_pool_athletes_pool     ON pool_athletes(pool_id);
CREATE INDEX idx_pool_athletes_athlete  ON pool_athletes(athlete_id);

CREATE INDEX idx_matches_competition    ON matches(competition_id);
CREATE INDEX idx_matches_tournament     ON matches(tournament_id);
CREATE INDEX idx_matches_mat            ON matches(mat_id);
CREATE INDEX idx_matches_status         ON matches(status);
CREATE INDEX idx_matches_bracket        ON matches(bracket);
CREATE INDEX idx_matches_red            ON matches(red_athlete_id);
CREATE INDEX idx_matches_blue           ON matches(blue_athlete_id);

CREATE INDEX idx_queue_tournament       ON match_queue(tournament_id);
CREATE INDEX idx_queue_mat              ON match_queue(mat_id);
CREATE INDEX idx_queue_status           ON match_queue(status);
CREATE INDEX idx_queue_position         ON match_queue(position);

CREATE INDEX idx_mats_tournament        ON mats(tournament_id);
CREATE INDEX idx_tournament_users_tournament ON tournament_users(tournament_id);
CREATE INDEX idx_tournament_users_user  ON tournament_users(user_id);
CREATE INDEX idx_audit_tournament       ON audit_logs(tournament_id);
CREATE INDEX idx_audit_entity           ON audit_logs(entity_type, entity_id);

-- ============================================================
-- PERMISSIONS PAR RÔLE
-- ============================================================
INSERT INTO role_permissions (role, permission) VALUES
  ('tournament_admin',  'manage_tournament'),
  ('tournament_admin',  'manage_athletes'),
  ('tournament_admin',  'manage_competitions'),
  ('tournament_admin',  'manage_mats'),
  ('tournament_admin',  'manage_users'),
  ('tournament_admin',  'view_results'),
  ('mat_manager',       'manage_mats'),
  ('mat_manager',       'view_results'),
  ('referee',           'score_match'),
  ('referee',           'view_mat'),
  ('weigh_in_manager',  'manage_weigh_in'),
  ('weigh_in_manager',  'view_athletes'),
  ('viewer',            'view_results');

-- ============================================================
-- ADMIN PAR DÉFAUT
-- ============================================================
INSERT INTO users (id, email, password_hash, name) VALUES (
  '00000000-0000-0000-0000-000000000001',
  'admin@lutte.app',
  '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcg7b3XeKeUxWdeS86E36LrvY1S',
  'Administrateur'
);

INSERT INTO global_roles (user_id, role) VALUES (
  '00000000-0000-0000-0000-000000000001',
  'super_admin'
);
