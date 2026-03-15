/* =========================================================
   BAD SCENE BINGO – Frontend App
   ========================================================= */

// --------------- State ---------------
const state = {
  roomId: null,
  roomTitle: '',
  items: [],
  playerName: null,
  playerId: null,     // socket id assigned on join
  card: [],           // 25-item array, index 12 = 'FREE'
  marked: new Set(),  // marked indices
  players: [],        // [{ id, name, hasBingo }]
  hasBingo: false,
  bingoCallers: [],
};

const socket = io();

// --------------- Persistence ---------------

function saveCardState() {
  if (!state.roomId) return;
  try {
    localStorage.setItem(`bsb-card-${state.roomId}`, JSON.stringify({
      card: state.card,
      marked: Array.from(state.marked),
      playerName: state.playerName,
      hasBingo: state.hasBingo,
    }));
  } catch {}
}

function loadCardState(roomId) {
  try {
    const raw = localStorage.getItem(`bsb-card-${roomId}`);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function loadSavedName() {
  try { return localStorage.getItem('bsb-player-name') || ''; } catch { return ''; }
}

function saveName(name) {
  try { localStorage.setItem('bsb-player-name', name); } catch {}
}

// --------------- Utility helpers ---------------

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function generateCard(items) {
  let pool = [...items];
  // Fill up to 24 by repeating if needed
  while (pool.length < 24) pool = [...pool, ...items];
  pool = shuffle(pool).slice(0, 24);
  // Insert FREE at position 12 (center of 5×5)
  pool.splice(12, 0, 'FREE');
  return pool; // length 25
}

function checkBingo(marked) {
  const lines = [
    // Rows
    [0,1,2,3,4],[5,6,7,8,9],[10,11,12,13,14],[15,16,17,18,19],[20,21,22,23,24],
    // Cols
    [0,5,10,15,20],[1,6,11,16,21],[2,7,12,17,22],[3,8,13,18,23],[4,9,14,19,24],
    // Diagonals
    [0,6,12,18,24],[4,8,12,16,20],
  ];
  return lines.filter(line => line.every(i => marked.has(i)));
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), 2500);
}

function showAlert(msg) {
  const el = document.getElementById('bingo-alert');
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 5000);
}

// --------------- Create screen ---------------

const itemsInput   = document.getElementById('items-input');
const countNum     = document.getElementById('count-num');
const btnCreate    = document.getElementById('btn-create');
const cardTitleEl  = document.getElementById('card-title');

itemsInput.addEventListener('input', () => {
  const items = parseItems(itemsInput.value);
  countNum.textContent = items.length;
  btnCreate.disabled = items.length < 8;
});

function parseItems(text) {
  return text.split('\n').map(s => s.trim()).filter(Boolean);
}

btnCreate.addEventListener('click', async () => {
  const items = parseItems(itemsInput.value);
  if (items.length < 8) return;

  btnCreate.disabled = true;
  btnCreate.textContent = 'Creating…';

  try {
    const res = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items,
        title: cardTitleEl.value.trim() || 'Bad Scene Bingo',
      }),
    });

    if (!res.ok) throw new Error('Server error');
    const { roomId } = await res.json();

    // Redirect to join flow with the new room
    window.location.href = `/?room=${roomId}`;
  } catch (err) {
    btnCreate.disabled = false;
    btnCreate.textContent = 'Create & Get Share Link';
    alert('Something went wrong. Please try again.');
  }
});

// --------------- Join screen ---------------

const playerNameEl = document.getElementById('player-name');
const btnJoin      = document.getElementById('btn-join');
const joinError    = document.getElementById('join-error');

playerNameEl.addEventListener('input', () => {
  btnJoin.disabled = playerNameEl.value.trim().length < 1;
});

playerNameEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !btnJoin.disabled) btnJoin.click();
});

btnJoin.addEventListener('click', () => {
  const name = playerNameEl.value.trim();
  if (!name || !state.roomId || !state.items.length) return;

  saveName(name);
  state.playerName = name;

  // Restore saved card for this room if it exists
  const saved = loadCardState(state.roomId);
  if (saved && saved.playerName === name && saved.card?.length === 25) {
    state.card = saved.card;
    state.marked = new Set(saved.marked);
    state.hasBingo = saved.hasBingo || false;
  } else {
    state.card = generateCard(state.items);
    state.marked = new Set([12]); // FREE space always marked
  }

  // Join via socket
  socket.emit('join-room', { roomId: state.roomId, name });
});

// --------------- Share button ---------------

document.getElementById('btn-share').addEventListener('click', () => {
  const url = buildShareUrl();
  navigator.clipboard.writeText(url).then(() => showToast('Link copied!'));
});

function buildShareUrl() {
  return `${window.location.origin}/?room=${state.roomId}`;
}

// --------------- Bingo button ---------------

document.getElementById('btn-bingo').addEventListener('click', () => {
  if (state.hasBingo) return;
  state.hasBingo = true;
  saveCardState();
  socket.emit('call-bingo');
  showBingoCalled();
});

function showBingoCalled() {
  document.getElementById('btn-bingo').classList.add('hidden');
  document.getElementById('btn-bingo-called').classList.remove('hidden');
  document.getElementById('bingo-banner').classList.remove('hidden');
}

// --------------- Grid rendering ---------------

function renderGrid() {
  const grid = document.getElementById('bingo-grid');
  grid.innerHTML = '';

  const bingoLines = state.hasBingo ? checkBingo(state.marked) : [];
  const bingoIndices = new Set(bingoLines.flat());

  state.card.forEach((item, i) => {
    const cell = document.createElement('div');
    cell.className = 'bingo-cell';

    const isFree = item === 'FREE';
    const isMarked = state.marked.has(i);
    const isBingoCell = bingoIndices.has(i);

    if (isFree) cell.classList.add('free');
    if (isMarked && !isFree) cell.classList.add('marked');
    if (isBingoCell) cell.classList.add('bingo-line');

    cell.textContent = isFree ? '★ FREE ★' : item;

    if (!isFree) {
      cell.addEventListener('click', () => toggleCell(i));
    }

    grid.appendChild(cell);
  });
}

function toggleCell(i) {
  if (state.marked.has(i)) {
    state.marked.delete(i);
  } else {
    state.marked.add(i);
  }

  saveCardState();
  renderGrid();
  checkAndHandleBingo();
}

function checkAndHandleBingo() {
  if (state.hasBingo) return;
  const lines = checkBingo(state.marked);
  if (lines.length > 0) {
    // Show the CALL BINGO button — player must confirm
    document.getElementById('btn-bingo').classList.remove('hidden');
    renderGrid(); // re-render to show highlighted line
  } else {
    document.getElementById('btn-bingo').classList.add('hidden');
  }
}

// --------------- Players list ---------------

function renderPlayers() {
  const list = document.getElementById('players-list');
  list.innerHTML = '';

  state.players.forEach(p => {
    const li = document.createElement('li');
    if (p.hasBingo) li.classList.add('has-bingo');

    const dot = document.createElement('span');
    dot.className = 'player-dot';

    const name = document.createElement('span');
    name.textContent = p.name;

    li.appendChild(dot);
    li.appendChild(name);

    if (p.id === socket.id) {
      const badge = document.createElement('span');
      badge.className = 'me-badge';
      badge.textContent = 'you';
      li.appendChild(badge);
    }

    list.appendChild(li);
  });
}

function renderBingoCallers() {
  const section = document.getElementById('bingo-callers-section');
  const list = document.getElementById('bingo-callers-list');

  if (state.bingoCallers.length === 0) {
    section.classList.add('hidden');
    return;
  }

  section.classList.remove('hidden');
  list.innerHTML = '';
  state.bingoCallers.forEach(name => {
    const li = document.createElement('li');
    li.textContent = `🎉 ${name}`;
    list.appendChild(li);
  });
}

// --------------- Socket events ---------------

socket.on('room-joined', ({ players, bingoCallers }) => {
  state.players = players;
  state.bingoCallers = bingoCallers || [];

  document.getElementById('play-title').textContent = state.roomTitle;
  document.getElementById('play-player').textContent = `Playing as: ${state.playerName}`;

  if (state.hasBingo) showBingoCalled();

  renderGrid();
  renderPlayers();
  renderBingoCallers();
  checkAndHandleBingo();

  showScreen('screen-play');
});

socket.on('room-error', (msg) => {
  joinError.textContent = msg;
  joinError.classList.remove('hidden');
  btnJoin.disabled = false;
});

socket.on('player-joined', ({ id, name, hasBingo }) => {
  if (!state.players.find(p => p.id === id)) {
    state.players.push({ id, name, hasBingo });
    renderPlayers();
    showAlert(`${name} joined the game!`);
  }
});

socket.on('player-left', ({ id, name }) => {
  state.players = state.players.filter(p => p.id !== id);
  renderPlayers();
  showAlert(`${name || 'A player'} left the game.`);
});

socket.on('bingo-called', ({ id, name, bingoCallers }) => {
  // Update the caller's player entry
  const player = state.players.find(p => p.id === id);
  if (player) player.hasBingo = true;

  state.bingoCallers = bingoCallers;
  renderPlayers();
  renderBingoCallers();

  if (id !== socket.id) {
    showAlert(`🎉 ${name} called BINGO!`);
  }
});

// --------------- Routing / init ---------------

async function init() {
  const params = new URLSearchParams(window.location.search);
  const roomId = params.get('room');

  if (!roomId) {
    // Show create screen
    showScreen('screen-create');
    itemsInput.focus();
    return;
  }

  // We have a room ID — fetch it and show join screen
  state.roomId = roomId.toUpperCase();
  showScreen('screen-join');

  try {
    const res = await fetch(`/api/rooms/${state.roomId}`);
    if (!res.ok) throw new Error('Not found');
    const room = await res.json();

    state.items = room.items;
    state.roomTitle = room.title;

    document.getElementById('join-room-title').textContent = room.title;
    document.getElementById('join-room-info').textContent =
      `${room.playerCount} player${room.playerCount !== 1 ? 's' : ''} already in this game`;

    // Pre-fill name from last session
    const savedName = loadSavedName();
    if (savedName) {
      playerNameEl.value = savedName;
      btnJoin.disabled = false;
    } else {
      playerNameEl.focus();
    }
  } catch {
    document.getElementById('join-room-title').textContent = 'Room Not Found';
    document.getElementById('join-room-info').textContent =
      'This link may have expired. Ask the host to create a new game.';
    btnJoin.disabled = true;
  }
}

init();
