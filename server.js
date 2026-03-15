const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory room storage
const rooms = new Map();

// Clean up rooms older than 24 hours every hour
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [id, room] of rooms) {
    if (room.createdAt < cutoff) {
      rooms.delete(id);
    }
  }
}, 60 * 60 * 1000);

// Create a new room
app.post('/api/rooms', (req, res) => {
  const { items, title } = req.body;

  if (!items || !Array.isArray(items) || items.length < 8) {
    return res.status(400).json({ error: 'Need at least 8 items' });
  }

  const roomId = uuidv4().slice(0, 8).toUpperCase();
  rooms.set(roomId, {
    id: roomId,
    title: title || 'Bad Scene Bingo',
    items: items.map(s => s.trim()).filter(Boolean),
    players: new Map(),
    bingoCallers: [],
    createdAt: Date.now(),
  });

  res.json({ roomId });
});

// Get room info (for joining)
app.get('/api/rooms/:id', (req, res) => {
  const room = rooms.get(req.params.id.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });

  res.json({
    id: room.id,
    title: room.title,
    items: room.items,
    playerCount: room.players.size,
    bingoCallers: room.bingoCallers,
  });
});

// Serve the app for all routes (SPA fallback)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Socket.io real-time logic
io.on('connection', (socket) => {
  let currentRoomId = null;
  let playerName = null;

  socket.on('join-room', ({ roomId, name }) => {
    const room = rooms.get(roomId.toUpperCase());
    if (!room) {
      socket.emit('room-error', 'Room not found. The link may have expired.');
      return;
    }

    currentRoomId = roomId.toUpperCase();
    playerName = name;

    socket.join(currentRoomId);

    room.players.set(socket.id, {
      name,
      hasBingo: false,
    });

    // Send current room state to the new player
    const players = Array.from(room.players.entries()).map(([id, p]) => ({
      id,
      name: p.name,
      hasBingo: p.hasBingo,
    }));

    socket.emit('room-joined', {
      players,
      bingoCallers: room.bingoCallers,
    });

    // Notify everyone else
    socket.to(currentRoomId).emit('player-joined', {
      id: socket.id,
      name,
      hasBingo: false,
    });
  });

  socket.on('call-bingo', () => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    const player = room.players.get(socket.id);
    if (!player || player.hasBingo) return;

    player.hasBingo = true;
    if (!room.bingoCallers.includes(player.name)) {
      room.bingoCallers.push(player.name);
    }

    io.to(currentRoomId).emit('bingo-called', {
      id: socket.id,
      name: player.name,
      bingoCallers: room.bingoCallers,
    });
  });

  socket.on('disconnect', () => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    room.players.delete(socket.id);
    socket.to(currentRoomId).emit('player-left', {
      id: socket.id,
      name: playerName,
    });
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`\n🎬 Bad Scene Bingo is running!`);
  console.log(`   Open: http://localhost:${PORT}\n`);
});
