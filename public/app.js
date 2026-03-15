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

  // Auth
  user: null,         // { id, name, email, avatar } or null
  oauthEnabled: false,
};

const socket = io();

// --------------- Auth ---------------

async function fetchMe() {
  try {
    const res = await fetch('/auth/me');
    const data = await res.json();
    state.oauthEnabled = data.oauthEnabled || false;
    if (data.loggedIn) {
      state.user = { id: data.id, name: data.name, email: data.email, avatar: data.avatar };
    } else {
      state.user = null;
    }
  } catch {
    state.user = null;
  }
  renderAccountBar();
}

function renderAccountBar() {
  const bar = document.getElementById('account-bar');
  if (!bar) return;

  if (state.user) {
    bar.innerHTML = `
      <div class="account-info">
        ${state.user.avatar ? `<img class="account-avatar" src="${escHtml(state.user.avatar)}" alt="">` : ''}
        <span class="account-name">${escHtml(state.user.name)}</span>
        <button class="btn btn-sm btn-ghost" id="btn-history">📜 History</button>
        <button class="btn btn-sm btn-ghost" id="btn-signout">Sign out</button>
      </div>
    `;
    document.getElementById('btn-signout').addEventListener('click', signOut);
    document.getElementById('btn-history').addEventListener('click', showHistory);
  } else if (state.oauthEnabled) {
    bar.innerHTML = `
      <a href="/auth/google?returnTo=${encodeURIComponent(window.location.href)}" class="btn btn-sm btn-google">
        <svg width="16" height="16" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.616Z" fill="#4285F4"/>
          <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18Z" fill="#34A853"/>
          <path d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332Z" fill="#FBBC05"/>
          <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 6.29C4.672 4.163 6.656 3.58 9 3.58Z" fill="#EA4335"/>
        </svg>
        Sign in with Google
      </a>
    `;
  }
}

async function signOut() {
  await fetch('/auth/logout', { method: 'POST' });
  state.user = null;
  renderAccountBar();
  renderTemplates();
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// --------------- Persistence (localStorage) ---------------

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

// --------------- Local Templates ---------------

function loadLocalTemplates() {
  try { return JSON.parse(localStorage.getItem('bsb-templates') || '[]'); } catch { return []; }
}

function saveLocalTemplate(title, items) {
  const templates = loadLocalTemplates();
  const id = Date.now().toString();
  templates.unshift({ id, title, items });
  try { localStorage.setItem('bsb-templates', JSON.stringify(templates)); } catch {}
  return id;
}

function deleteLocalTemplate(id) {
  const templates = loadLocalTemplates().filter(t => t.id !== id);
  try { localStorage.setItem('bsb-templates', JSON.stringify(templates)); } catch {}
}

// --------------- Cloud Templates ---------------

async function loadCloudTemplates() {
  try {
    const res = await fetch('/api/templates');
    if (!res.ok) return [];
    return await res.json();
  } catch { return []; }
}

async function saveCloudTemplate(title, items) {
  const res = await fetch('/api/templates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, items }),
  });
  if (!res.ok) throw new Error('Failed to save');
  return res.json();
}

async function deleteCloudTemplate(id) {
  await fetch(`/api/templates/${id}`, { method: 'DELETE' });
}

// On first login, offer to migrate localStorage templates to the cloud
async function migrateLocalTemplatesToCloud() {
  const local = loadLocalTemplates();
  if (!local.length) return;
  try {
    await fetch('/api/templates/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templates: local }),
    });
    // Clear local templates after successful migration
    localStorage.removeItem('bsb-templates');
    showToast('Your saved cards have been synced to your account! ☁️');
  } catch {}
}

// --------------- Render Templates ---------------

async function renderTemplates() {
  const section = document.getElementById('templates-section');
  const list    = document.getElementById('templates-list');
  const badge   = document.getElementById('templates-sync-badge');

  let templates = [];
  let isCloud   = false;

  if (state.user) {
    // Logged in — use cloud templates
    templates = await loadCloudTemplates();
    isCloud   = true;
    if (badge) badge.classList.remove('hidden');
  } else {
    // Not logged in — use localStorage
    templates = loadLocalTemplates();
    if (badge) badge.classList.add('hidden');
  }

  if (templates.length === 0) {
    section.classList.add('hidden');
    return;
  }

  section.classList.remove('hidden');
  list.innerHTML = '';

  templates.forEach(t => {
    const li = document.createElement('li');
    li.className = 'template-item';

    const info = document.createElement('div');
    info.className = 'template-info';

    const name = document.createElement('span');
    name.className = 'template-name';
    name.textContent = t.title;

    const count = document.createElement('span');
    count.className = 'template-count';
    const itemArr = isCloud ? t.items : t.items;
    count.textContent = `${Array.isArray(itemArr) ? itemArr.length : '?'} items`;

    info.appendChild(name);
    info.appendChild(count);

    const actions = document.createElement('div');
    actions.className = 'template-actions';

    const loadBtn = document.createElement('button');
    loadBtn.className = 'btn btn-sm btn-load';
    loadBtn.textContent = '▶ Play';
    loadBtn.addEventListener('click', () => {
      cardTitleEl.value = t.title;
      itemsInput.value  = (isCloud ? t.items : t.items).join('\n');
      itemsInput.dispatchEvent(new Event('input'));
      document.querySelector('.panel h2').scrollIntoView({ behavior: 'smooth' });
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-sm btn-delete';
    delBtn.textContent = '✕';
    delBtn.title = 'Delete saved card';
    delBtn.addEventListener('click', async () => {
      if (isCloud) {
        await deleteCloudTemplate(t.id);
      } else {
        deleteLocalTemplate(t.id);
      }
      renderTemplates();
    });

    actions.appendChild(loadBtn);
    actions.appendChild(delBtn);
    li.appendChild(info);
    li.appendChild(actions);
    list.appendChild(li);
  });
}

// --------------- Leaderboard ---------------

async function renderLeaderboard() {
  try {
    const data = await fetch('/api/leaderboard').then(r => r.json());
    const section = document.getElementById('leaderboard-section');
    const list    = document.getElementById('leaderboard-list');

    if (!Array.isArray(data) || data.length === 0) return;

    section.classList.remove('hidden');
    list.innerHTML = '';
    data.forEach((p, i) => {
      const li = document.createElement('li');
      li.className = 'leaderboard-item';
      li.innerHTML = `
        <span class="lb-rank">${i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i+1}`}</span>
        ${p.avatar ? `<img class="lb-avatar" src="${escHtml(p.avatar)}" alt="">` : '<span class="lb-avatar-placeholder"></span>'}
        <span class="lb-name">${escHtml(p.name)}</span>
        <span class="lb-stats">${p.first_bingo_count} 🎉 · ${p.bingo_count} bingo · ${p.games_played} games</span>
      `;
      list.appendChild(li);
    });
  } catch {}
}

// --------------- History screen ---------------

async function showHistory() {
  showScreen('screen-history');
  const list = document.getElementById('history-list');
  list.innerHTML = '<li class="history-loading">Loading…</li>';
  try {
    const data = await fetch('/api/history').then(r => r.json());
    list.innerHTML = '';
    if (!data.length) {
      list.innerHTML = '<li class="history-empty">No games yet — go play!</li>';
      return;
    }
    data.forEach(g => {
      const li = document.createElement('li');
      li.className = 'history-item' + (g.got_bingo ? ' got-bingo' : '');
      const date = new Date(g.played_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      li.innerHTML = `
        <div class="history-title">${escHtml(g.title)}</div>
        <div class="history-meta">
          ${g.got_bingo ? (g.bingo_order === 1 ? '🥇 First Bingo' : '🎉 Bingo') : '😬 No bingo'}
          · ${g.player_count} player${g.player_count != 1 ? 's' : ''}
          · ${date}
        </div>
      `;
      list.appendChild(li);
    });
  } catch {
    list.innerHTML = '<li class="history-empty">Could not load history.</li>';
  }
}

document.getElementById('btn-history-back').addEventListener('click', () => {
  showScreen('screen-create');
});

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
  const enough = items.length >= 8;
  btnCreate.disabled = !enough;
  document.getElementById('btn-save-template').disabled = !enough;
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

    window.location.href = `/?room=${roomId}`;
  } catch (err) {
    btnCreate.disabled = false;
    btnCreate.textContent = 'Create & Get Share Link';
    alert('Something went wrong. Please try again.');
  }
});

document.getElementById('btn-save-template').addEventListener('click', async () => {
  const items = parseItems(itemsInput.value);
  if (items.length < 8) return;
  const title = cardTitleEl.value.trim() || 'Untitled Card';

  if (state.user) {
    try {
      await saveCloudTemplate(title, items);
      showToast(`"${title}" saved to your account! ☁️`);
    } catch {
      showToast('Could not save — check your connection.');
    }
  } else {
    saveLocalTemplate(title, items);
    showToast(`"${title}" saved locally!`);
  }
  renderTemplates();
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
    state.card    = saved.card;
    state.marked  = new Set(saved.marked);
    state.hasBingo = saved.hasBingo || false;
  } else {
    state.card    = generateCard(state.items);
    state.marked  = new Set([12]); // FREE space always marked
  }

  // Join via socket — pass userId if logged in so server can record stats
  socket.emit('join-room', {
    roomId: state.roomId,
    name,
    userId: state.user ? state.user.id : null,
  });
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

  const bingoLines   = state.hasBingo ? checkBingo(state.marked) : [];
  const bingoIndices = new Set(bingoLines.flat());

  state.card.forEach((item, i) => {
    const cell = document.createElement('div');
    cell.className = 'bingo-cell';

    const isFree      = item === 'FREE';
    const isMarked    = state.marked.has(i);
    const isBingoCell = bingoIndices.has(i);

    if (isFree)      cell.classList.add('free');
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
    document.getElementById('btn-bingo').classList.remove('hidden');
    renderGrid();
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

    const dot  = document.createElement('span');
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
  const list    = document.getElementById('bingo-callers-list');

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
  state.players      = players;
  state.bingoCallers = bingoCallers || [];

  document.getElementById('play-title').textContent  = state.roomTitle;
  document.getElementById('play-player').textContent = `Playing as: ${state.playerName}`;
  document.querySelector('.play-layout').dataset.printTitle =
    `${state.roomTitle || 'Bad Scene Bingo'} — ${state.playerName}`;

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
  // Load auth state first
  await fetchMe();

  // Check if this is the first login (local templates exist but no cloud ones yet)
  if (state.user) {
    const local = loadLocalTemplates();
    if (local.length > 0) {
      await migrateLocalTemplatesToCloud();
    }
  }

  const params = new URLSearchParams(window.location.search);
  const roomId = params.get('room');

  if (!roomId) {
    showScreen('screen-create');
    await renderTemplates();
    renderLeaderboard();
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

    state.items     = room.items;
    state.roomTitle = room.title;

    document.getElementById('join-room-title').textContent = room.title;
    document.getElementById('join-room-info').textContent =
      `${room.playerCount} player${room.playerCount !== 1 ? 's' : ''} already in this game`;

    // Pre-fill name: logged-in user's name, or last saved name
    const prefillName = state.user ? state.user.name : loadSavedName();
    if (prefillName) {
      playerNameEl.value = prefillName;
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
