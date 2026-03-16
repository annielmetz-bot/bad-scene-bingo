/* =========================================================
   BAD SCENE BINGO – Frontend App
   ========================================================= */

// Global error recovery — if a JS crash happens, show a reload button
window.addEventListener('error', () => showRecovery());
window.addEventListener('unhandledrejection', () => showRecovery());
function showRecovery() {
  const existing = document.getElementById('recovery-banner');
  if (existing) return;
  const el = document.createElement('div');
  el.id = 'recovery-banner';
  el.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#e63950;color:#fff;text-align:center;padding:1rem;font-family:sans-serif;';
  el.innerHTML = 'Something went wrong. <button onclick="caches.keys().then(k=>Promise.all(k.map(c=>caches.delete(c)))).then(()=>location.reload(true))" style="margin-left:1rem;padding:0.4rem 1rem;background:#fff;color:#e63950;border:none;border-radius:4px;font-weight:bold;cursor:pointer;">Reload &amp; Fix</button>';
  document.body.prepend(el);
}

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

  // Collab
  collab: { id: null, hostToken: null, isHost: false, items: [] },
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
  try {
    await fetch('/auth/logout', { method: 'POST' });
  } catch {}
  window.location.href = '/';
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

// --------------- Render Home Saved Cards ---------------

async function renderHomeSavedCards() {
  const section = document.getElementById('home-saved-section');
  const list    = document.getElementById('home-saved-list');
  if (!section || !list) return;

  let templates = [];
  let isCloud   = false;

  if (state.user) {
    templates = await loadCloudTemplates();
    isCloud   = true;
  } else {
    templates = loadLocalTemplates();
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
    const itemArr = t.items;
    count.textContent = `${Array.isArray(itemArr) ? itemArr.length : '?'} items`;

    info.appendChild(name);
    info.appendChild(count);

    const actions = document.createElement('div');
    actions.className = 'template-actions';

    const playBtn = document.createElement('button');
    playBtn.className = 'btn btn-sm btn-load';
    playBtn.textContent = '▶ Play';
    playBtn.addEventListener('click', () => {
      launchCard(t.title, t.items);
    });

    const editBtn = document.createElement('button');
    editBtn.className = 'btn btn-sm';
    editBtn.textContent = '✏️ Edit';
    editBtn.addEventListener('click', () => {
      cardTitleEl.value = t.title;
      itemsInput.value  = t.items.join('\n');
      itemsInput.dispatchEvent(new Event('input'));
      showScreen('screen-create');
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
      renderHomeSavedCards();
    });

    actions.appendChild(playBtn);
    actions.appendChild(editBtn);
    actions.appendChild(delBtn);
    li.appendChild(info);
    li.appendChild(actions);
    list.appendChild(li);
  });
}

// Keep renderTemplates as a no-op alias so any remaining internal calls are safe
function renderTemplates() {
  return renderHomeSavedCards();
}

// --------------- Launch Card ---------------

async function launchCard(title, items) {
  try {
    const res = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items, title: title || 'Bad Scene Bingo' }),
    });
    if (!res.ok) throw new Error('Server error');
    const { roomId } = await res.json();
    window.location.href = `/?room=${roomId}&autoplay=1`;
  } catch {
    showToast('Could not launch — please try again.');
  }
}

// --------------- Leaderboard ---------------

async function renderLeaderboard() {
  try {
    const data = await fetch('/api/leaderboard').then(r => r.json());
    const section = document.getElementById('leaderboard-section');
    const list    = document.getElementById('leaderboard-list');

    if (!Array.isArray(data) || data.length === 0) return;
    if (data.error) return;

    section.classList.remove('hidden');
    list.innerHTML = '';
    data.forEach((p, i) => {
      const li = document.createElement('li');
      li.className = 'leaderboard-item';
      li.innerHTML = `
        <span class="lb-rank">#${i+1}</span>
        ${p.avatar ? `<img class="lb-avatar" src="${escHtml(p.avatar)}" alt="">` : '<span class="lb-avatar-placeholder"></span>'}
        <span class="lb-name">${escHtml(p.name)}</span>
        <span class="lb-stats">${p.first_bingo_count} first · ${p.bingo_count} bingo · ${p.games_played} games</span>
      `;
      list.appendChild(li);
    });
  } catch {}
}

// --------------- History screen ---------------

function buildHistoryItem(g, templates) {
  const li = document.createElement('li');
  li.className = 'history-item' + (g.got_bingo ? ' got-bingo' : '');
  const date = new Date(g.played_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  li.innerHTML = `
    <div class="history-info">
      <div class="history-title">${escHtml(g.title)}</div>
      <div class="history-meta">
        ${g.got_bingo ? (g.bingo_order === 1 ? 'First Bingo' : 'Bingo') : 'No bingo'}
        · ${g.player_count} player${g.player_count != 1 ? 's' : ''}
        · ${date}
      </div>
    </div>
  `;

  // Find items: from game record (with defensive parse), or matching saved template
  let rawItems = g.items;
  if (typeof rawItems === 'string') {
    try { rawItems = JSON.parse(rawItems); } catch { rawItems = null; }
  }
  const gameItems = Array.isArray(rawItems) && rawItems.length >= 8 ? rawItems : null;
  const titleLower = (g.title || '').toLowerCase().trim();
  const tplMatch = templates.find(t => (t.title || '').toLowerCase().trim() === titleLower);
  const items = gameItems || tplMatch?.items || null;

  const btn = document.createElement('button');
  btn.className = 'btn btn-sm btn-load';
  if (items) {
    btn.textContent = '▶ Play Again';
    btn.addEventListener('click', () => launchCard(g.title, items));
  } else {
    btn.textContent = '✏️ Recreate';
    btn.addEventListener('click', () => {
      cardTitleEl.value = g.title;
      itemsInput.value = '';
      itemsInput.dispatchEvent(new Event('input'));
      showScreen('screen-create');
    });
  }
  li.appendChild(btn);
  return li;
}

async function showHistory() {
  showScreen('screen-history');
  const list = document.getElementById('history-list');
  list.innerHTML = '<li class="history-loading">Loading…</li>';
  try {
    const [data, templates] = await Promise.all([
      fetch('/api/history').then(r => r.json()),
      state.user ? loadCloudTemplates() : Promise.resolve(loadLocalTemplates()),
    ]);
    list.innerHTML = '';
    if (!data.length) {
      list.innerHTML = '<li class="history-empty">No games yet — go play!</li>';
      return;
    }
    data.forEach(g => list.appendChild(buildHistoryItem(g, templates)));
  } catch {
    list.innerHTML = '<li class="history-empty">Could not load history.</li>';
  }
}

document.getElementById('btn-history-back').addEventListener('click', () => {
  showScreen('screen-home');
});

// --------------- Built-in Templates ---------------

const BUILTIN_TEMPLATES = [
  {
    emoji: '🇺🇸',
    title: 'Trump Speech Bingo',
    items: [
      'Fake news',
      'Nobody knows more about this than me',
      'Many people are saying',
      'Tremendous',
      'Disaster',
      'The radical left',
      'Witch hunt',
      'The deep state',
      'Believe me',
      'Like you\'ve never seen before',
      'Very unfair',
      'Millions and millions',
      'Our great military',
      'They want to destroy our country',
      'Nickname for an opponent',
      'Perfect',
      'Frankly',
      'China (said with emphasis)',
      'The failing New York Times',
      'Hand gesture',
      '"Beautiful" (used for something weird)',
      'We\'re going to win so much',
      'Nasty',
      'No collusion',
    ],
  },
  {
    emoji: '💼',
    title: 'Corporate Meeting Bingo',
    items: [
      'Let\'s take this offline',
      'Circle back',
      'Move the needle',
      'Low-hanging fruit',
      'Synergy',
      'Bandwidth',
      'Deep dive',
      'Leverage',
      'Touch base',
      'Going forward',
      'Action items',
      'Best practices',
      'Scalable',
      'Thought leader',
      'Disruptive',
      'Pivot',
      'Ping me',
      'Value-add',
      'Someone joins late',
      'Someone\'s mic is muted when they talk',
      'Can everyone see my screen?',
      'Meeting runs over time',
      'At the end of the day',
      'This could have been an email',
    ],
  },
  {
    emoji: '🍽️',
    title: 'Awkward Family Dinner Bingo',
    items: [
      'Someone asks when you\'re getting married',
      'Politics comes up',
      'A passive-aggressive compliment',
      'Someone retells a story everyone\'s heard',
      'Unsolicited parenting advice',
      'Comparison to a sibling',
      'The host apologizes for the food',
      'Someone\'s on their phone the whole time',
      'A decades-old grievance is mentioned',
      '"You look tired"',
      '"When are you having kids?"',
      'Someone brings up an ex',
      'Dietary restriction is ignored',
      '"Back in my day..."',
      'An old photo is brought out to embarrass someone',
      'Someone leaves early',
      '"I\'m not trying to start anything, but..."',
      'The same argument from last year',
      'Someone overshares about their health',
      'Someone falls asleep',
      'The TV stays on during dinner',
      'Someone cries',
      'A gift goes unappreciated',
      'Someone gives feedback that wasn\'t asked for',
    ],
  },
  {
    emoji: '💔',
    title: 'Bad First Date Bingo',
    items: [
      'They talk about their ex',
      'They\'re on their phone',
      'They\'re late',
      '"I\'m not like other guys/girls"',
      'They talk only about themselves',
      'Awkward silence lasting 30+ seconds',
      'They order for you without asking',
      'They mention how much money they make',
      'They\'re rude to the server',
      'They bring up their trauma in the first 10 minutes',
      '"My therapist says..."',
      'They look nothing like their photos',
      'They ask how many people you\'ve dated',
      'They already have a nickname for you',
      'They suggest splitting the check then order the most expensive thing',
      'They\'re very into astrology',
      '"I\'m basically an empath"',
      'They talk about their diet for 10 minutes',
      'They have opinions about your order',
      '"I\'m between jobs"',
      'They ask about your five-year plan',
      'They suggest a second location within the first hour',
      '"I\'m very authentic"',
      'They mention their podcast',
    ],
  },
  {
    emoji: '🎄',
    title: 'Office Holiday Party Bingo',
    items: [
      'Someone drinks too much',
      'Awkward Secret Santa gift',
      'The boss makes a speech',
      'Someone brings up work gossip',
      'Someone you don\'t recognize acts like they know you',
      'Someone asks about your salary',
      'The vegetarian option is just salad',
      'Someone corners you and won\'t stop talking',
      'A couple has a visible argument',
      'Someone cries in the bathroom',
      'Mandatory "fun" activity',
      'Someone\'s plus-one wasn\'t invited',
      'The venue is too hot or too cold',
      'A speech goes on way too long',
      'Someone hooks up with a coworker',
      'Someone falls',
      'Someone wears something inappropriate',
      'HR gets involved in something',
      'Someone proposes a toast that goes sideways',
      'A slideshow no one asked for',
      'Karaoke that gets out of hand',
      'The food runs out before you get there',
      'You get trapped talking about someone\'s renovation',
      'The CEO pretends to be relatable',
    ],
  },
];

function renderBuiltinTemplates() {
  const container = document.getElementById('builtin-template-cards');
  if (!container) return;
  container.innerHTML = '';
  BUILTIN_TEMPLATES.forEach(tpl => {
    const card = document.createElement('div');
    card.className = 'template-card';
    card.innerHTML = `
      <div class="template-card-emoji">${tpl.emoji}</div>
      <div class="template-card-title">${escHtml(tpl.title)}</div>
      <div class="template-card-count">${tpl.items.length} items</div>
      <button class="template-card-btn">Play this →</button>
    `;
    card.querySelector('.template-card-btn').addEventListener('click', () => {
      document.getElementById('card-title').value = tpl.title;
      document.getElementById('items-input').value = tpl.items.join('\n');
      document.getElementById('items-input').dispatchEvent(new Event('input'));
      showScreen('screen-create');
    });
    container.appendChild(card);
  });
}

// --------------- Home / Create navigation ---------------

document.getElementById('btn-go-create').addEventListener('click', () => {
  showScreen('screen-create');
});

document.getElementById('btn-share-app').addEventListener('click', async () => {
  const shareData = {
    title: 'Bad Scene Bingo',
    text: 'Find the humor. Survive together. Real-time multiplayer bingo for awkward social situations.',
    url: window.location.origin,
  };
  if (navigator.share) {
    try { await navigator.share(shareData); } catch {}
  } else {
    navigator.clipboard.writeText(window.location.origin)
      .then(() => showToast('Link copied!'))
      .catch(() => showToast(window.location.origin));
  }
});

document.getElementById('btn-create-back').addEventListener('click', () => {
  showScreen('screen-home');
  renderHomeSavedCards();
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
  // Collab can start with 0 items — collaborators add items together
});

function parseItems(text) {
  return text.split('\n').map(s => s.trim()).filter(Boolean);
}

btnCreate.addEventListener('click', async () => {
  const items = parseItems(itemsInput.value);
  if (items.length < 8) return;
  const title = cardTitleEl.value.trim() || 'Bad Scene Bingo';

  btnCreate.disabled = true;
  btnCreate.textContent = 'Creating…';

  try {
    const res = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items, title }),
    });

    if (!res.ok) throw new Error('Server error');
    const { roomId } = await res.json();

    // Auto-save so the card appears in "Your Saved Cards" on the home screen
    if (state.user) {
      saveCloudTemplate(title, items).catch(() => {});
    } else {
      saveLocalTemplate(title, items);
    }

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
  renderHomeSavedCards();
});

document.getElementById('btn-collab-start').addEventListener('click', async () => {
  const items = parseItems(itemsInput.value);
  const title = cardTitleEl.value.trim();

  if (!title) {
    cardTitleEl.focus();
    cardTitleEl.placeholder = 'Give your card a name first…';
    cardTitleEl.classList.add('input-error');
    setTimeout(() => {
      cardTitleEl.classList.remove('input-error');
      cardTitleEl.placeholder = '';
    }, 2500);
    return;
  }

  try {
    const res = await fetch('/api/collab', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    const { collabId, hostToken } = await res.json();
    // Navigate to collab screen as host; items entered are pre-loaded from URL state
    const params = new URLSearchParams({ collab: collabId, host: hostToken });
    // Stash items in sessionStorage so host can add them after joining
    try { sessionStorage.setItem('bsb-collab-items', JSON.stringify({ items, title })); } catch {}
    window.location.href = '/?' + params.toString();
  } catch {
    alert('Could not start collaboration. Please try again.');
  }
});

// --------------- Collab screen ---------------

const collabNameInput   = document.getElementById('collab-name-input');
const btnCollabJoin     = document.getElementById('btn-collab-join');
const collabJoinError   = document.getElementById('collab-join-error');
const collabItemInput   = document.getElementById('collab-item-input');
const btnCollabAdd      = document.getElementById('btn-collab-add');
const collabItemsList   = document.getElementById('collab-items-list');
const collabItemCount   = document.getElementById('collab-item-count');
const collabParticipant = document.getElementById('collab-participant-badge');
const btnCollabLaunch   = document.getElementById('btn-collab-launch');
const collabError       = document.getElementById('collab-error');

collabNameInput.addEventListener('input', () => {
  btnCollabJoin.disabled = collabNameInput.value.trim().length < 1;
});
collabNameInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !btnCollabJoin.disabled) btnCollabJoin.click();
});

btnCollabJoin.addEventListener('click', () => {
  const name = collabNameInput.value.trim();
  if (!name) return;
  btnCollabJoin.disabled = true;
  socket.emit('join-collab', {
    collabId:  state.collab.id,
    name,
    hostToken: state.collab.hostToken || '',
  });
});

collabItemInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') btnCollabAdd.click();
});

btnCollabAdd.addEventListener('click', () => {
  const text = collabItemInput.value.trim();
  if (!text) return;
  socket.emit('collab-add-item', { collabId: state.collab.id, text });
  collabItemInput.value = '';
  collabItemInput.focus();
});

document.getElementById('btn-collab-copy-link').addEventListener('click', async () => {
  const url = `${window.location.origin}/?collab=${state.collab.id}`;
  const title = document.getElementById('collab-workspace-title').textContent;
  const shareData = {
    title: `Build "${title}" together`,
    text: `Help build the "${title}" Bad Scene Bingo card — add your items before we play!`,
    url,
  };
  if (navigator.share) {
    try { await navigator.share(shareData); return; } catch {}
  }
  navigator.clipboard.writeText(url).catch(() => {});
  showToast('Invite link copied!');
});

btnCollabLaunch.addEventListener('click', () => {
  if (state.collab.items.length < 8) return;
  btnCollabLaunch.disabled = true;
  btnCollabLaunch.textContent = 'Launching…';
  socket.emit('collab-launch', { collabId: state.collab.id, hostToken: state.collab.hostToken });
});

function makeCollabItem(item) {
  const li = document.createElement('li');
  li.className = 'collab-item' + (item.isOwn ? ' collab-item-own' : '');
  li.dataset.id = item.id;

  if (item.isOwn) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'collab-item-input-inline';
    input.value = item.text;
    input.maxLength = 120;

    const saveEdit = () => {
      const newText = input.value.trim();
      if (newText && newText !== item.text) {
        socket.emit('collab-edit-item', { collabId: state.collab.id, itemId: item.id, text: newText });
      } else if (!newText) {
        input.value = item.text;
      }
    };
    input.addEventListener('blur', saveEdit);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); saveEdit(); input.blur(); } });

    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-sm btn-delete collab-item-del';
    delBtn.textContent = '✕';
    delBtn.title = 'Remove your item';
    delBtn.addEventListener('click', () => {
      socket.emit('collab-remove-item', { collabId: state.collab.id, itemId: item.id });
    });

    li.appendChild(input);
    li.appendChild(delBtn);
  } else {
    const text = document.createElement('span');
    text.className = 'collab-item-text';
    text.textContent = item.text;

    const by = document.createElement('span');
    by.className = 'collab-item-by';
    by.textContent = item.contributor;

    li.appendChild(text);
    li.appendChild(by);
  }
  return li;
}

function renderCollabItems() {
  const items = state.collab.items;
  collabItemCount.textContent = items.length;
  if (btnCollabLaunch) btnCollabLaunch.disabled = items.length < 8;

  const activeId = document.activeElement?.closest('[data-id]')?.dataset.id;
  const activeVal = document.activeElement?.tagName === 'INPUT' ? document.activeElement.value : null;

  // Remove rows that no longer exist
  const currentIds = new Set(items.map(i => i.id));
  collabItemsList.querySelectorAll('[data-id]').forEach(el => {
    if (!currentIds.has(el.dataset.id)) el.remove();
  });

  // Add or update each item in order
  items.forEach((item, idx) => {
    const existing = collabItemsList.querySelector(`[data-id="${item.id}"]`);
    if (existing) {
      // Update text for non-focused own items
      if (item.id !== activeId) {
        const input = existing.querySelector('input');
        if (input) input.value = item.text;
        const span = existing.querySelector('.collab-item-text');
        if (span) span.textContent = item.text;
      }
      // Ensure correct position
      const children = collabItemsList.children;
      if (children[idx] !== existing) collabItemsList.insertBefore(existing, children[idx] || null);
    } else {
      const li = makeCollabItem(item);
      const children = collabItemsList.children;
      collabItemsList.insertBefore(li, children[idx] || null);
    }
  });

  // Restore focus and value if interrupted by re-render
  if (activeId && activeVal !== null) {
    const el = collabItemsList.querySelector(`[data-id="${activeId}"] input`);
    if (el && el !== document.activeElement) { el.focus(); el.value = activeVal; }
  }
}

function updateCollabParticipants(count) {
  if (collabParticipant) {
    collabParticipant.textContent = `${count} ${count === 1 ? 'person' : 'people'}`;
  }
}

// Collab socket events
socket.on('collab-joined', ({ isHost, title, items, participantCount }) => {
  state.collab.isHost = isHost;
  state.collab.items  = items;

  document.getElementById('collab-join-panel').classList.add('hidden');
  const workspace = document.getElementById('collab-workspace');
  workspace.classList.remove('hidden');
  document.getElementById('collab-workspace-title').textContent = title || 'Card Items';
  updateCollabParticipants(participantCount);

  if (isHost) {
    document.getElementById('collab-host-actions').classList.remove('hidden');
    // If host stashed items from the create screen, add them all now
    try {
      const stash = JSON.parse(sessionStorage.getItem('bsb-collab-items') || 'null');
      if (stash && Array.isArray(stash.items)) {
        stash.items.forEach(text => {
          socket.emit('collab-add-item', { collabId: state.collab.id, text });
        });
        sessionStorage.removeItem('bsb-collab-items');
      }
    } catch {}
  } else {
    document.getElementById('collab-waiting-msg').classList.remove('hidden');
  }

  renderCollabItems();
});

socket.on('collab-update', ({ items, participantCount }) => {
  state.collab.items = items;
  renderCollabItems();
  if (participantCount !== undefined) updateCollabParticipants(participantCount);
});

socket.on('collab-participant-update', ({ participantCount }) => {
  updateCollabParticipants(participantCount);
});

socket.on('collab-launched', ({ roomId }) => {
  window.location.href = `/?room=${roomId}`;
});

socket.on('collab-error', (msg) => {
  if (collabError) {
    collabError.textContent = msg;
    collabError.classList.remove('hidden');
    setTimeout(() => collabError.classList.add('hidden'), 4000);
  }
  if (btnCollabLaunch) {
    btnCollabLaunch.disabled = state.collab.items.length < 8;
    btnCollabLaunch.textContent = 'Launch Game';
  }
});

// --------------- Your Games (home screen) ---------------

async function renderGames() {
  if (!state.user) return;
  const section = document.getElementById('games-section');
  const list    = document.getElementById('games-list');
  if (!section || !list) return;

  section.classList.remove('hidden');
  list.innerHTML = '<li class="history-loading">Loading…</li>';

  // Wire "View all" button
  const viewAllBtn = document.getElementById('btn-view-history');
  if (viewAllBtn) viewAllBtn.onclick = showHistory;

  try {
    const [data, templates] = await Promise.all([
      fetch('/api/history').then(r => r.json()),
      loadCloudTemplates(),
    ]);
    list.innerHTML = '';
    if (!Array.isArray(data) || data.length === 0) {
      list.innerHTML = '<li class="history-empty">No games yet — go play!</li>';
      return;
    }
    data.slice(0, 5).forEach(g => list.appendChild(buildHistoryItem(g, templates)));
  } catch {
    list.innerHTML = '<li class="history-empty">Could not load history.</li>';
  }
}

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

document.getElementById('btn-play-home').addEventListener('click', () => {
  showScreen('screen-home');
  renderHomeSavedCards();
  renderLeaderboard();
  renderGames();
});

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
    li.textContent = name;
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
    showAlert(`${name} called BINGO!`);
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

  const params    = new URLSearchParams(window.location.search);
  const roomId    = params.get('room');
  const collabId  = params.get('collab');
  const hostToken = params.get('host');
  const autoplay  = params.get('autoplay') === '1';

  if (collabId) {
    state.collab.id        = collabId.toUpperCase();
    state.collab.hostToken = hostToken || null;

    // Fetch session info for the title
    try {
      const res = await fetch(`/api/collab/${state.collab.id}`);
      if (!res.ok) throw new Error();
      const s = await res.json();
      document.getElementById('collab-session-title').textContent =
        s.title ? `"${s.title}"` : 'Join and help build the bingo card';
    } catch {
      document.getElementById('collab-join-error').textContent =
        'This collaboration session has expired or was not found.';
      document.getElementById('collab-join-error').classList.remove('hidden');
      btnCollabJoin.disabled = true;
    }

    showScreen('screen-collab');
    // Pre-fill name and auto-join if we have one
    const prefill = state.user ? state.user.name : loadSavedName();
    if (prefill) {
      collabNameInput.value = prefill;
      btnCollabJoin.disabled = false;
      setTimeout(() => btnCollabJoin.click(), 300);
    } else {
      collabNameInput.focus();
    }
    return;
  }

  if (!roomId) {
    showScreen('screen-home');
    renderBuiltinTemplates();
    await renderHomeSavedCards();
    renderLeaderboard();
    renderGames();
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
      // Auto-join when launched from "Play" on a saved card
      if (autoplay) setTimeout(() => btnJoin.click(), 300);
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

// --------------- Install prompt (PWA) ---------------

let deferredInstallPrompt = null;

// Capture Chrome/Android/Edge install event before it auto-fires
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  // Show banner after a short delay so the page has settled
  setTimeout(() => showInstallBanner('android'), 2500);
});

// Listen for successful install
window.addEventListener('appinstalled', () => {
  removeInstallBanner();
  deferredInstallPrompt = null;
});

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches ||
         window.navigator.standalone === true;
}

function isIOSSafari() {
  const ua = navigator.userAgent;
  return /iphone|ipad|ipod/i.test(ua) &&
         /safari/i.test(ua) &&
         !/crios|fxios|opios|chrome/i.test(ua);
}

function installDismissed() {
  try { return !!localStorage.getItem('bsb-install-dismissed'); } catch { return false; }
}

function markInstallDismissed() {
  try { localStorage.setItem('bsb-install-dismissed', '1'); } catch {}
}

function removeInstallBanner() {
  const el = document.getElementById('install-banner');
  if (el) el.remove();
}

function showInstallBanner(type) {
  if (isStandalone()) return;
  if (installDismissed()) return;
  if (document.getElementById('install-banner')) return; // already showing

  const banner = document.createElement('div');
  banner.id = 'install-banner';
  banner.className = 'install-banner';

  if (type === 'ios') {
    banner.innerHTML = `
      <div class="install-banner-icon">😬</div>
      <div class="install-banner-body">
        <div class="install-banner-title">Add to Home Screen</div>
        <div class="install-banner-sub">
          Tap
          <svg class="ios-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-label="Share">
            <path d="M8 12H3v9h18v-9h-5M12 3v12M8 7l4-4 4 4"/>
          </svg>
          then <strong>"Add to Home Screen"</strong>
        </div>
      </div>
      <div class="install-banner-actions">
        <button class="btn-install-dismiss" id="btn-install-dismiss" aria-label="Dismiss">✕</button>
      </div>
    `;
  } else {
    banner.innerHTML = `
      <div class="install-banner-icon">😬</div>
      <div class="install-banner-body">
        <div class="install-banner-title">Install Bad Scene Bingo</div>
        <div class="install-banner-sub">Add to your home screen for quick access at your next gathering.</div>
      </div>
      <div class="install-banner-actions">
        <button class="btn btn-install" id="btn-install-now">Install</button>
        <button class="btn-install-dismiss" id="btn-install-dismiss" aria-label="Dismiss">✕</button>
      </div>
    `;
  }

  document.body.appendChild(banner);

  document.getElementById('btn-install-dismiss').addEventListener('click', () => {
    markInstallDismissed();
    removeInstallBanner();
  });

  if (type === 'android') {
    document.getElementById('btn-install-now').addEventListener('click', async () => {
      if (!deferredInstallPrompt) return;
      deferredInstallPrompt.prompt();
      const { outcome } = await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
      if (outcome === 'accepted') {
        removeInstallBanner();
      }
    });
  }
}

// iOS: show after a short delay on the create screen only
if (isIOSSafari() && !isStandalone() && !installDismissed()) {
  setTimeout(() => showInstallBanner('ios'), 3000);
}
