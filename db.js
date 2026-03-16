/* =========================================================
   BAD SCENE BINGO – Database layer (PostgreSQL)
   ========================================================= */

const { Pool } = require('pg');

// If no DATABASE_URL, the app runs without a DB (local-only mode)
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    })
  : null;

async function query(sql, params) {
  if (!pool) throw new Error('No database configured');
  return pool.query(sql, params);
}

// --------------- Schema ---------------

async function initSchema() {
  if (!pool) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id          SERIAL PRIMARY KEY,
      google_id   TEXT UNIQUE NOT NULL,
      name        TEXT NOT NULL,
      email       TEXT,
      avatar      TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS templates (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
      title      TEXT NOT NULL,
      items      JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS games (
      id         SERIAL PRIMARY KEY,
      room_id    TEXT NOT NULL,
      title      TEXT NOT NULL,
      items      JSONB,
      played_at  TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE games ADD COLUMN IF NOT EXISTS items JSONB;

    CREATE TABLE IF NOT EXISTS game_results (
      id         SERIAL PRIMARY KEY,
      game_id    INTEGER REFERENCES games(id) ON DELETE CASCADE,
      user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      player_name TEXT NOT NULL,
      got_bingo  BOOLEAN DEFAULT FALSE,
      bingo_order INTEGER  -- 1 = first bingo, 2 = second, etc.
    );

    CREATE TABLE IF NOT EXISTS rooms (
      id         VARCHAR(20) PRIMARY KEY,
      title      TEXT NOT NULL,
      items      JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS user_sessions (
      sid    varchar NOT NULL,
      sess   json NOT NULL,
      expire timestamp(6) NOT NULL,
      CONSTRAINT session_pkey PRIMARY KEY (sid) NOT DEFERRABLE INITIALLY IMMEDIATE
    );
    CREATE INDEX IF NOT EXISTS idx_session_expire ON user_sessions (expire);
  `);

  console.log('✅ Database schema ready');
}

// --------------- Room helpers ---------------

async function saveRoom(roomId, title, items) {
  if (!pool) return;
  await query(
    `INSERT INTO rooms (id, title, items) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING`,
    [roomId, title, JSON.stringify(items)]
  );
}

async function getRoom(roomId) {
  if (!pool) return null;
  const result = await query('SELECT * FROM rooms WHERE id=$1', [roomId]);
  return result.rows[0] || null;
}

async function cleanOldRooms() {
  if (!pool) return;
  await query("DELETE FROM rooms WHERE created_at < NOW() - INTERVAL '48 hours'");
}

// --------------- User helpers ---------------

async function findOrCreateUser({ googleId, name, email, avatar }) {
  const existing = await query(
    'SELECT * FROM users WHERE google_id = $1',
    [googleId]
  );
  if (existing.rows.length > 0) {
    // Update name/avatar in case they changed
    await query(
      'UPDATE users SET name=$1, email=$2, avatar=$3 WHERE google_id=$4',
      [name, email, avatar, googleId]
    );
    return existing.rows[0];
  }
  const result = await query(
    'INSERT INTO users (google_id, name, email, avatar) VALUES ($1,$2,$3,$4) RETURNING *',
    [googleId, name, email, avatar]
  );
  return result.rows[0];
}

// --------------- Template helpers ---------------

async function getTemplates(userId) {
  const result = await query(
    'SELECT * FROM templates WHERE user_id=$1 ORDER BY created_at DESC',
    [userId]
  );
  return result.rows;
}

async function saveTemplate(userId, title, items) {
  const result = await query(
    'INSERT INTO templates (user_id, title, items) VALUES ($1,$2,$3) RETURNING *',
    [userId, title, JSON.stringify(items)]
  );
  return result.rows[0];
}

async function deleteTemplate(userId, templateId) {
  await query(
    'DELETE FROM templates WHERE id=$1 AND user_id=$2',
    [templateId, userId]
  );
}

// --------------- Game history helpers ---------------

async function recordGame(roomId, title, items) {
  const result = await query(
    'INSERT INTO games (room_id, title, items) VALUES ($1,$2,$3) RETURNING *',
    [roomId, title, JSON.stringify(items || [])]
  );
  return result.rows[0];
}

async function recordResult(gameId, userId, playerName, gotBingo, bingoOrder) {
  await query(
    `INSERT INTO game_results (game_id, user_id, player_name, got_bingo, bingo_order)
     VALUES ($1,$2,$3,$4,$5)`,
    [gameId, userId || null, playerName, gotBingo, bingoOrder || null]
  );
}

async function getLeaderboard() {
  const result = await query(`
    SELECT
      u.id,
      u.name,
      u.avatar,
      COUNT(DISTINCT gr.game_id)                                        AS games_played,
      SUM(CASE WHEN gr.got_bingo THEN 1 ELSE 0 END)                    AS bingo_count,
      SUM(CASE WHEN gr.bingo_order = 1 THEN 1 ELSE 0 END)              AS first_bingo_count
    FROM users u
    JOIN game_results gr ON gr.user_id = u.id
    GROUP BY u.id, u.name, u.avatar
    ORDER BY first_bingo_count DESC, bingo_count DESC, games_played DESC
    LIMIT 20
  `);
  return result.rows;
}

async function getUserHistory(userId) {
  const result = await query(`
    SELECT
      g.title,
      COALESCE(g.items, r.items, t.items) AS items,
      g.played_at,
      gr.got_bingo,
      gr.bingo_order,
      (SELECT COUNT(*) FROM game_results gr2 WHERE gr2.game_id = g.id) AS player_count
    FROM games g
    JOIN game_results gr ON gr.game_id = g.id
    LEFT JOIN rooms r ON r.id = g.room_id
    LEFT JOIN templates t ON t.user_id = $1 AND t.title = g.title
    WHERE gr.user_id = $1
    ORDER BY g.played_at DESC
    LIMIT 50
  `, [userId]);
  return result.rows;
}

module.exports = {
  pool,
  query,
  initSchema,
  saveRoom,
  getRoom,
  cleanOldRooms,
  findOrCreateUser,
  getTemplates,
  saveTemplate,
  deleteTemplate,
  recordGame,
  recordResult,
  getLeaderboard,
  getUserHistory,
};
