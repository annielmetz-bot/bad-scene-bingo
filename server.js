/* =========================================================
   BAD SCENE BINGO – Server
   ========================================================= */

const express      = require('express');
const { createServer } = require('http');
const { Server }   = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path         = require('path');
const session      = require('express-session');
const passport     = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const db           = require('./db');

// --------------- App setup ---------------

const app        = express();
const httpServer = createServer(app);
const io         = new Server(httpServer);

app.set('trust proxy', 1); // Railway sits behind a proxy; needed for secure session cookies
app.use(express.json());

// --------------- Session ---------------

const sessionSecret = process.env.SESSION_SECRET || 'bsb-dev-secret-change-me';

// Use postgres session store in production if DB is available
let sessionStore;
if (db.pool && process.env.NODE_ENV === 'production') {
  const PgSession = require('connect-pg-simple')(session);
  sessionStore = new PgSession({ pool: db.pool, tableName: 'user_sessions', createTableIfMissing: true });
}

app.use(session({
  store: sessionStore,
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  },
}));

// --------------- Passport / Google OAuth ---------------

const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const BASE_URL             = process.env.BASE_URL || 'http://localhost:3000';

const oauthEnabled = !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && db.pool);

// Log OAuth config on startup so we can verify in Railway logs
console.log('OAuth config check:', {
  clientID:     GOOGLE_CLIENT_ID ? GOOGLE_CLIENT_ID.slice(0, 12) + '...' : 'MISSING',
  clientSecret: GOOGLE_CLIENT_SECRET ? GOOGLE_CLIENT_SECRET.slice(0, 8) + '...' : 'MISSING',
  callbackURL:  `${BASE_URL}/auth/google/callback`,
  oauthEnabled,
});

if (oauthEnabled) {
  passport.use(new GoogleStrategy({
    clientID:     GOOGLE_CLIENT_ID,
    clientSecret: GOOGLE_CLIENT_SECRET,
    callbackURL:  `${BASE_URL}/auth/google/callback`,
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      const user = await db.findOrCreateUser({
        googleId: profile.id,
        name:     profile.displayName,
        email:    profile.emails?.[0]?.value || null,
        avatar:   profile.photos?.[0]?.value || null,
      });
      done(null, user);
    } catch (err) {
      done(err);
    }
  }));

  passport.serializeUser((user, done) => done(null, user.id));
  passport.deserializeUser(async (id, done) => {
    try {
      const result = await db.query('SELECT * FROM users WHERE id=$1', [id]);
      done(null, result.rows[0] || false);
    } catch (err) {
      done(err);
    }
  });

  app.use(passport.initialize());
  app.use(passport.session());
}

// --------------- Auth routes ---------------

// Check auth status (frontend polls this)
app.get('/auth/me', (req, res) => {
  if (req.user) {
    res.json({
      loggedIn: true,
      id:     req.user.id,
      name:   req.user.name,
      email:  req.user.email,
      avatar: req.user.avatar,
    });
  } else {
    res.json({ loggedIn: false, oauthEnabled });
  }
});

// Start Google OAuth flow
app.get('/auth/google', (req, res, next) => {
  if (!oauthEnabled) return res.status(503).json({ error: 'Auth not configured' });
  // Save the page they came from so we can redirect back
  req.session.returnTo = req.query.returnTo || '/';
  passport.authenticate('google', { scope: ['profile', 'email'] })(req, res, next);
});

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/?auth=failed' }),
  (req, res) => {
    const returnTo = req.session.returnTo || '/';
    delete req.session.returnTo;
    res.redirect(returnTo);
  }
);

app.post('/auth/logout', (req, res) => {
  req.logout(() => res.json({ ok: true }));
});

// --------------- Template API (requires auth) ---------------

app.get('/api/templates', requireAuth, async (req, res) => {
  try {
    const templates = await db.getTemplates(req.user.id);
    res.json(templates);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/templates', requireAuth, async (req, res) => {
  const { title, items } = req.body;
  if (!title || !Array.isArray(items) || items.length < 8) {
    return res.status(400).json({ error: 'Need title and at least 8 items' });
  }
  try {
    const t = await db.saveTemplate(req.user.id, title, items);
    res.json(t);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bulk import (migrate localStorage templates on first login)
app.post('/api/templates/import', requireAuth, async (req, res) => {
  const { templates } = req.body;
  if (!Array.isArray(templates)) return res.status(400).json({ error: 'Invalid' });
  try {
    for (const t of templates) {
      if (t.title && Array.isArray(t.items) && t.items.length >= 8) {
        await db.saveTemplate(req.user.id, t.title, t.items);
      }
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/templates/:id', requireAuth, async (req, res) => {
  try {
    await db.deleteTemplate(req.user.id, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --------------- Leaderboard / history API ---------------

app.get('/api/leaderboard', async (req, res) => {
  if (!db.pool) return res.json([]);
  try {
    res.json(await db.getLeaderboard());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/history', requireAuth, async (req, res) => {
  try {
    res.json(await db.getUserHistory(req.user.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --------------- Helper ---------------

function requireAuth(req, res, next) {
  if (req.user) return next();
  res.status(401).json({ error: 'Not logged in' });
}

// --------------- Static files ---------------

app.use(express.static(path.join(__dirname, 'public')));

// --------------- Room management ---------------

const rooms = new Map();

// Load a room from memory, falling back to DB if not found
async function getOrLoadRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room && db.pool) {
    try {
      const dbRoom = await db.getRoom(roomId);
      if (dbRoom) {
        room = {
          id:           dbRoom.id,
          title:        dbRoom.title,
          items:        dbRoom.items,
          players:      new Map(),
          bingoCallers: [],
          createdAt:    new Date(dbRoom.created_at).getTime(),
          gameId:       null,
          bingoOrder:   0,
        };
        rooms.set(dbRoom.id, room);
      }
    } catch {}
  }
  return room || null;
}

// Clean up rooms older than 48 hours every hour (memory + DB)
setInterval(() => {
  const cutoff = Date.now() - 48 * 60 * 60 * 1000;
  for (const [id, room] of rooms) {
    if (room.createdAt < cutoff) rooms.delete(id);
  }
  db.cleanOldRooms().catch(() => {});
}, 60 * 60 * 1000);

// --------------- Collab sessions ---------------

const collabSessions = new Map();

// Clean up collab sessions older than 12 hours
setInterval(() => {
  const cutoff = Date.now() - 12 * 60 * 60 * 1000;
  for (const [id, s] of collabSessions) {
    if (s.createdAt < cutoff) collabSessions.delete(id);
  }
}, 60 * 60 * 1000);

app.post('/api/collab', (req, res) => {
  const { title } = req.body;
  const collabId  = uuidv4().slice(0, 8).toUpperCase();
  const hostToken = uuidv4().slice(0, 12);
  collabSessions.set(collabId, {
    id: collabId,
    hostToken,
    title: title || '',
    items: [],
    sockets: new Map(), // socketId -> { name }
    createdAt: Date.now(),
  });
  res.json({ collabId, hostToken });
});

app.get('/api/collab/:id', (req, res) => {
  const s = collabSessions.get(req.params.id.toUpperCase());
  if (!s) return res.status(404).json({ error: 'Collab session not found or expired' });
  res.json({
    id:    s.id,
    title: s.title,
    items: s.items.map(({ id, text, contributor }) => ({ id, text, contributor })),
  });
});

// Create a new room
app.post('/api/rooms', (req, res) => {
  const { items, title } = req.body;
  if (!items || !Array.isArray(items) || items.length < 8) {
    return res.status(400).json({ error: 'Need at least 8 items' });
  }

  const roomId    = uuidv4().slice(0, 8).toUpperCase();
  const roomTitle = title || 'Bad Scene Bingo';
  const roomItems = items.map(s => s.trim()).filter(Boolean);

  rooms.set(roomId, {
    id:           roomId,
    title:        roomTitle,
    items:        roomItems,
    players:      new Map(),
    bingoCallers: [],
    createdAt:    Date.now(),
    gameId:       null,
    bingoOrder:   0,
  });

  // Persist to DB so the room survives server restarts
  db.saveRoom(roomId, roomTitle, roomItems).catch(() => {});

  res.json({ roomId });
});

// Get room info (for joining)
app.get('/api/rooms/:id', async (req, res) => {
  const room = await getOrLoadRoom(req.params.id.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({
    id:           room.id,
    title:        room.title,
    items:        room.items,
    playerCount:  room.players.size,
    bingoCallers: room.bingoCallers,
  });
});

// Health check — lets you verify DB + OAuth config without signing in
app.get('/api/health', async (req, res) => {
  let dbConnected = false;
  if (db.pool) {
    try {
      await db.pool.query('SELECT 1');
      dbConnected = true;
    } catch (e) {
      console.error('DB health check failed:', e.message);
    }
  }
  res.json({
    ok: true,
    dbPool: !!db.pool,
    dbConnected,
    oauthEnabled,
    clientIDPrefix:     GOOGLE_CLIENT_ID     ? GOOGLE_CLIENT_ID.slice(0, 12)     : 'MISSING',
    clientSecretPrefix: GOOGLE_CLIENT_SECRET ? GOOGLE_CLIENT_SECRET.slice(0, 8)  : 'MISSING',
    callbackURL: `${BASE_URL}/auth/google/callback`,
  });
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Global error handler — logs to Railway console so we can diagnose 500s
app.use((err, req, res, next) => {
  console.error('Unhandled error on', req.method, req.path, ':', err.stack || err.message || err);
  res.status(500).json({ error: 'Internal server error', detail: err.message });
});

// --------------- Socket.io ---------------

function broadcastCollabItems(collabId) {
  const s = collabSessions.get(collabId);
  if (!s) return;
  const room = io.sockets.adapter.rooms.get(`collab:${collabId}`);
  if (!room) return;
  for (const sid of room) {
    const sock = io.sockets.sockets.get(sid);
    if (!sock) continue;
    sock.emit('collab-update', {
      items: s.items.map(({ id, text, contributor, socketId: ownerId }) => ({
        id, text, contributor, isOwn: ownerId === sid,
      })),
      participantCount: s.sockets.size,
    });
  }
}

io.on('connection', (socket) => {
  let currentRoomId   = null;
  let playerName      = null;
  let userId          = null;  // set if the player is logged in (passed from client)
  let currentCollabId = null;
  let collabName      = null;

  socket.on('join-room', async ({ roomId, name, userId: uid }) => {
    const room = await getOrLoadRoom(roomId.toUpperCase());
    if (!room) {
      socket.emit('room-error', 'Room not found. The link may have expired.');
      return;
    }

    currentRoomId = roomId.toUpperCase();
    playerName    = name;
    userId        = uid || null;

    socket.join(currentRoomId);
    room.players.set(socket.id, { name, hasBingo: false, userId });

    const players = Array.from(room.players.entries()).map(([id, p]) => ({
      id, name: p.name, hasBingo: p.hasBingo,
    }));

    socket.emit('room-joined', { players, bingoCallers: room.bingoCallers });
    socket.to(currentRoomId).emit('player-joined', { id: socket.id, name, hasBingo: false });
  });

  socket.on('call-bingo', async () => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    const player = room.players.get(socket.id);
    if (!player || player.hasBingo) return;

    player.hasBingo = true;
    room.bingoOrder += 1;
    const thisOrder = room.bingoOrder;

    if (!room.bingoCallers.includes(player.name)) {
      room.bingoCallers.push(player.name);
    }

    io.to(currentRoomId).emit('bingo-called', {
      id: socket.id,
      name: player.name,
      bingoCallers: room.bingoCallers,
    });

    // Record to DB if available
    if (db.pool) {
      try {
        // Create game record on first bingo
        if (!room.gameId) {
          const game = await db.recordGame(room.id, room.title);
          room.gameId = game.id;

          // Record all current players as participants (non-bingo)
          for (const [, p] of room.players) {
            if (!p.hasBingo || p === player) continue;
            await db.recordResult(room.gameId, p.userId, p.name, false, null);
          }
        }
        await db.recordResult(room.gameId, player.userId, player.name, true, thisOrder);
      } catch (err) {
        console.error('DB error recording bingo:', err.message);
      }
    }
  });

  // ----- Collab events -----

  socket.on('join-collab', ({ collabId, name, hostToken }) => {
    const s = collabSessions.get((collabId || '').toUpperCase());
    if (!s) { socket.emit('collab-error', 'Collab session not found or expired.'); return; }

    currentCollabId = collabId.toUpperCase();
    collabName = name;
    const isHost = s.hostToken === hostToken;
    s.sockets.set(socket.id, { name, isHost });
    socket.join(`collab:${currentCollabId}`);

    socket.emit('collab-joined', {
      isHost,
      title: s.title,
      items: s.items.map(({ id, text, contributor, socketId: ownerId }) => ({
        id, text, contributor, isOwn: ownerId === socket.id,
      })),
      participantCount: s.sockets.size,
    });
    // Notify others of new participant count
    socket.to(`collab:${currentCollabId}`).emit('collab-participant-update', {
      participantCount: s.sockets.size,
    });
  });

  socket.on('collab-add-item', ({ collabId, text }) => {
    const s = collabSessions.get((collabId || '').toUpperCase());
    if (!s) return;
    const trimmed = (text || '').trim().slice(0, 120);
    if (!trimmed) return;
    s.items.push({ id: uuidv4().slice(0, 8), text: trimmed, contributor: collabName, socketId: socket.id });
    broadcastCollabItems(currentCollabId);
  });

  socket.on('collab-edit-item', ({ collabId, itemId, text }) => {
    const s = collabSessions.get((collabId || '').toUpperCase());
    if (!s) return;
    const item = s.items.find(i => i.id === itemId && i.socketId === socket.id);
    if (!item) return;
    const trimmed = (text || '').trim().slice(0, 120);
    if (!trimmed) return;
    item.text = trimmed;
    broadcastCollabItems(currentCollabId);
  });

  socket.on('collab-remove-item', ({ collabId, itemId }) => {
    const s = collabSessions.get((collabId || '').toUpperCase());
    if (!s) return;
    const idx = s.items.findIndex(i => i.id === itemId && i.socketId === socket.id);
    if (idx === -1) return;
    s.items.splice(idx, 1);
    broadcastCollabItems(currentCollabId);
  });

  socket.on('collab-launch', ({ collabId, hostToken }) => {
    const s = collabSessions.get((collabId || '').toUpperCase());
    if (!s || s.hostToken !== hostToken) return;
    if (s.items.length < 8) {
      socket.emit('collab-error', 'Need at least 8 items to launch the game.');
      return;
    }
    const roomId = uuidv4().slice(0, 8).toUpperCase();
    rooms.set(roomId, {
      id: roomId,
      title: s.title || 'Bad Scene Bingo',
      items: s.items.map(i => i.text),
      players: new Map(),
      bingoCallers: [],
      createdAt: Date.now(),
      gameId: null,
      bingoOrder: 0,
    });
    io.to(`collab:${currentCollabId}`).emit('collab-launched', { roomId });
    collabSessions.delete(currentCollabId);
  });

  // ----- Room / disconnect -----

  socket.on('disconnect', () => {
    // Collab cleanup
    if (currentCollabId) {
      const s = collabSessions.get(currentCollabId);
      if (s) {
        s.sockets.delete(socket.id);
        socket.to(`collab:${currentCollabId}`).emit('collab-participant-update', {
          participantCount: s.sockets.size,
        });
      }
    }

    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    // If game has ended (gameId set), record this player as a non-bingo participant
    if (room.gameId && db.pool) {
      const player = room.players.get(socket.id);
      if (player && !player.hasBingo) {
        db.recordResult(room.gameId, player.userId, player.name, false, null).catch(() => {});
      }
    }

    room.players.delete(socket.id);
    socket.to(currentRoomId).emit('player-left', { id: socket.id, name: playerName });
  });
});

// --------------- Start ---------------

const PORT = process.env.PORT || 3000;

(async () => {
  if (db.pool) await db.initSchema();
  httpServer.listen(PORT, () => {
    console.log(`\n😬 Bad Scene Bingo is running!`);
    console.log(`   Open: http://localhost:${PORT}`);
    console.log(`   Auth: ${oauthEnabled ? 'Google OAuth enabled' : 'No auth (set GOOGLE_CLIENT_ID/SECRET + DATABASE_URL)'}\n`);
  });
})();
