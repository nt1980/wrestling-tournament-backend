-- Créer la base de données
CREATE DATABASE wrestling_tournaments;

-- Utiliser la base de données
\c wrestling_tournaments;

-- Créer la table des utilisateurs
CREATE TABLE users (
  id UUID PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  role VARCHAR(50) DEFAULT 'user', -- user, admin, judge
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Créer la table des tournois
CREATE TABLE tournaments (
  id UUID PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  date DATE NOT NULL,
  location VARCHAR(255) NOT NULL,
  sport VARCHAR(100) DEFAULT 'wrestling',
  status VARCHAR(50) DEFAULT 'pending', -- pending, ongoing, completed
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Créer la table des participants
CREATE TABLE participants (
  id UUID PRIMARY KEY,
  tournament_id UUID REFERENCES tournaments(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  weight DECIMAL(5, 2) NOT NULL,
  club VARCHAR(255),
  category VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Créer la table des matchs
CREATE TABLE matches (
  id UUID PRIMARY KEY,
  tournament_id UUID REFERENCES tournaments(id) ON DELETE CASCADE,
  participant1_id UUID REFERENCES participants(id),
  participant2_id UUID REFERENCES participants(id),
  score1 INT DEFAULT 0,
  score2 INT DEFAULT 0,
  winner_id UUID REFERENCES participants(id),
  category VARCHAR(100),
  weight_class VARCHAR(100),
  status VARCHAR(50) DEFAULT 'pending', -- pending, ongoing, completed
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Créer la table des résultats
CREATE TABLE results (
  id UUID PRIMARY KEY,
  match_id UUID REFERENCES matches(id) ON DELETE CASCADE,
  winner_id UUID REFERENCES participants(id),
  technique VARCHAR(255),
  points INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Créer les indices pour optimiser les requêtes
CREATE INDEX idx_tournaments_date ON tournaments(date);
CREATE INDEX idx_participants_tournament ON participants(tournament_id);
CREATE INDEX idx_matches_tournament ON matches(tournament_id);
CREATE INDEX idx_matches_status ON matches(status);
CREATE INDEX idx_users_email ON users(email);

-- Insérer un utilisateur de test (à supprimer en production)
-- Password: "password123" (hashed with bcrypt)
INSERT INTO users (id, email, password, name, role) 
VALUES (
  '550e8400-e29b-41d4-a716-446655440000',
  'admin@example.com',
  '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcg7b3XeKeUxWdeS86E36LrvY1S',
  'Admin User',
  'admin'
);
