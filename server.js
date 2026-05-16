import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';

dotenv.config();

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-key-change-this';

// Database Pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Middleware
app.use(cors());
app.use(express.json());

// JWT Verification Middleware
const verifyToken = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// ===== ROUTES SANTÉ =====
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// ===== ROUTES AUTHENTIFICATION =====

// POST Register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, password, and name are required' });
    }

    // Check if user exists
    const userExists = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (userExists.rows.length > 0) {
      return res.status(409).json({ error: 'User already exists' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create user
    const userId = uuidv4();
    const result = await pool.query(
      'INSERT INTO users (id, email, password, name, created_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING id, email, name',
      [userId, email, hashedPassword, name]
    );

    // Create token
    const token = jwt.sign(
      { userId: result.rows[0].id, email: result.rows[0].email },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(201).json({
      user: result.rows[0],
      token
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];
    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { userId: user.id, email: user.email },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name
      },
      token
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ===== ROUTES TOURNOIS =====

// GET all tournaments
app.get('/api/tournaments', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM tournaments ORDER BY date DESC');
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching tournaments:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET tournament details
app.get('/api/tournaments/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM tournaments WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Tournament not found' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching tournament:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST create tournament (requires auth)
app.post('/api/tournaments', verifyToken, async (req, res) => {
  try {
    const { name, date, location, sport } = req.body;

    if (!name || !date || !location || !sport) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const tournamentId = uuidv4();
    const result = await pool.query(
      'INSERT INTO tournaments (id, name, date, location, sport, created_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, NOW()) RETURNING *',
      [tournamentId, name, date, location, sport, req.user.userId]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating tournament:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ===== ROUTES PARTICIPANTS =====

// GET participants for a tournament
app.get('/api/tournaments/:tournamentId/participants', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM participants WHERE tournament_id = $1 ORDER BY name',
      [req.params.tournamentId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching participants:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST add participant
app.post('/api/tournaments/:tournamentId/participants', verifyToken, async (req, res) => {
  try {
    const { name, weight, club } = req.body;

    if (!name || !weight) {
      return res.status(400).json({ error: 'Name and weight are required' });
    }

    const participantId = uuidv4();
    const result = await pool.query(
      'INSERT INTO participants (id, tournament_id, name, weight, club, created_at) VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING *',
      [participantId, req.params.tournamentId, name, weight, club || 'N/A']
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error adding participant:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ===== ROUTES MATCHS =====

// GET matches for a tournament
app.get('/api/tournaments/:tournamentId/matches', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT m.*, 
              p1.name as participant1_name, 
              p2.name as participant2_name
       FROM matches m
       LEFT JOIN participants p1 ON m.participant1_id = p1.id
       LEFT JOIN participants p2 ON m.participant2_id = p2.id
       WHERE m.tournament_id = $1
       ORDER BY m.created_at`,
      [req.params.tournamentId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching matches:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST create match
app.post('/api/tournaments/:tournamentId/matches', verifyToken, async (req, res) => {
  try {
    const { participant1_id, participant2_id, category, weight_class } = req.body;

    if (!participant1_id || !participant2_id) {
      return res.status(400).json({ error: 'Both participants are required' });
    }

    const matchId = uuidv4();
    const result = await pool.query(
      `INSERT INTO matches 
       (id, tournament_id, participant1_id, participant2_id, category, weight_class, status, created_at) 
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', NOW()) 
       RETURNING *`,
      [matchId, req.params.tournamentId, participant1_id, participant2_id, category || 'freestyle', weight_class || 'N/A']
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating match:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT update match (record result)
app.put('/api/matches/:id', verifyToken, async (req, res) => {
  try {
    const { score1, score2, winner_id, status } = req.body;

    const result = await pool.query(
      `UPDATE matches 
       SET score1 = COALESCE($1, score1),
           score2 = COALESCE($2, score2),
           winner_id = COALESCE($3, winner_id),
           status = COALESCE($4, status),
           updated_at = NOW()
       WHERE id = $5
       RETURNING *`,
      [score1, score2, winner_id, status, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Match not found' });
    }

    // Notify WebSocket clients of the update
    broadcastToAll({
      type: 'match_updated',
      match: result.rows[0]
    });

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating match:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ===== WebSocket pour les matchs en direct =====
const clients = new Set();

function broadcastToAll(data) {
  clients.forEach(client => {
    if (client.readyState === 1) { // OPEN
      client.send(JSON.stringify(data));
    }
  });
}

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`Client connected. Total: ${clients.size}`);

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      console.log('WebSocket message:', data);

      // Broadcast to all clients
      broadcastToAll({
        type: data.type,
        data: data.data,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('WebSocket message error:', error);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`Client disconnected. Total: ${clients.size}`);
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

// ===== ERROR HANDLING =====
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// ===== START SERVER =====
server.listen(PORT, () => {
  console.log(`🏆 Wrestling Tournament Backend running on port ${PORT}`);
  console.log(`📍 Health check: http://localhost:${PORT}/api/health`);
  console.log(`🔌 WebSocket: ws://localhost:${PORT}`);
});

export default app;
