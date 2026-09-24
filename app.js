(() => {
'use strict';

const GAME_ID = 'docchina';
const GAME_NAME = 'どっちーな';
const MAX_PLAYERS = 10;
const WORKER_ORIGIN = 'https://docchina-online.naitoryo7110.workers.dev';
const COMMON_PLAYER_NAME_KEY = 'boardgamePlayerName';
const ROOM_IDS = ['room1', 'room2', 'room3', 'room4'];
const APP_VERSION = 'v0.3.2';

const NAME_DRAFT_KEY = `${GAME_ID}-name-draft`;
const ACTIVE_ROOM_KEY = `${GAME_ID}-online-room`;
const ACTIVE_NAME_KEY = `${GAME_ID}-online-active-name`;
const QUESTION_BANK_KEY_V1 = `${GAME_ID}-question-bank-v1`;
const QUESTION_BANK_KEY = `${GAME_ID}-question-bank-v2`;
const CATEGORY_PREF_KEY = `${GAME_ID}-category-pref-v1`;
const MODE_PREF_KEY = `${GAME_ID}-mode-pref-v1`;

const CATEGORY_META = {
  normal: { label: '通常' },
  love: { label: '恋愛' },
  boardgame: { label: 'ボドゲ' },
  adult: { label: '大人' },
  idol: { label: 'アイドル' },
  music: { label: '音楽' },
  food: { label: '食べ物' },
  game: { label: 'ゲーム' },
  anime_manga: { label: 'アニメ漫画' },
  travel: { label: '旅行' },
  values: { label: '性格・価値観' },
  hypothetical: { label: 'もしも' }
};
const CATEGORY_KEYS = Object.keys(CATEGORY_META);
const DEFAULT_CATEGORIES = Object.fromEntries(CATEGORY_KEYS.map(k => [k, k === 'normal']));
const LEAF_LABELS = ['A','B','C','D','E','F'];
const PYRAMID_LEVELS = 5;
const PYRAMID_QUESTION_COUNT = 15;
const REPLACEMENT_RESERVE_COUNT = 15;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const els = {
  titleView: $('#titleView'),
  roomView: $('#roomView'),
  roomLayout: $('.room-layout'),
  sidePanel: $('.side-panel'),
  playerName: $('#playerName'),
  roomGrid: $('#roomGrid'),
  titleMessage: $('#titleMessage'),
  questionBtn: $('#questionBtn'),
  pinBtn: $('#pinBtn'),
  leaveBtn: $('#leaveBtn'),
  rulesBtn: $('#rulesBtn'),
  roomTitle: $('#roomTitle'),
  roomStatus: $('#roomStatus'),
  playerList: $('#playerList'),
  lobbySettings: $('#lobbySettings'),
  categorySettings: $('#categorySettings'),
  activeQuestionCount: $('#activeQuestionCount'),
  modeSettings: $('#modeSettings'),
  startBtn: $('#startBtn'),
  lobbyArea: $('#lobbyArea'),
  gameArea: $('#gameArea'),
  resultArea: $('#resultArea'),
  roundLabel: $('#roundLabel'),
  respondentLabel: $('#respondentLabel'),
  phaseLabel: $('#phaseLabel'),
  pyramid: $('#pyramid'),
  actionArea: $('#actionArea'),
  toast: $('#toast'),
  questionSummary: $('#questionSummary'),
  questionCategoryFilter: $('#questionCategoryFilter'),
  questionSearch: $('#questionSearch'),
  questionList: $('#questionList'),
  addQuestionBtn: $('#addQuestionBtn'),
  exportQuestionsBtn: $('#exportQuestionsBtn'),
  importQuestionsInput: $('#importQuestionsInput'),
  resetQuestionsBtn: $('#resetQuestionsBtn'),
  editQuestionTitle: $('#editQuestionTitle'),
  editQuestionCategory: $('#editQuestionCategory'),
  editQuestionText: $('#editQuestionText'),
  saveQuestionBtn: $('#saveQuestionBtn')
};

let questionBank = loadQuestionBank();
let categoryPrefs = loadCategoryPrefs();
let modePrefs = loadModePrefs();

let ws = null;
let currentRoomId = null;
let currentPlayerName = '';
let roomState = null;
let selfId = null;
let reconnectTimer = null;
let roomsPollTimer = null;
let commonNameSavedForSession = null;
let actionSeq = 0;
let editingQuestionId = null;
let localPredictionDraft = null;
let hostSettingsSyncedForRoom = false;
let manualClose = false;
let createdRoomThisJoin = false;

function commonSavedName() {
  return String(localStorage.getItem(COMMON_PLAYER_NAME_KEY) || '').trim().slice(0, 32);
}
function saveCommonNameOnActualStart(playerName) {
  const name = String(playerName || '').trim().slice(0, 32);
  if (!name) return;
  localStorage.setItem(COMMON_PLAYER_NAME_KEY, name);
}
function tokenKey(roomId) {
  return `${GAME_ID}-online-token-${roomId}`;
}
function getToken(roomId) {
  let token = localStorage.getItem(tokenKey(roomId));
  if (!token) {
    token = crypto.randomUUID().replace(/-/g, '');
    localStorage.setItem(tokenKey(roomId), token);
  }
  return token;
}
function newActionId(prefix='op') {
  actionSeq = (actionSeq + 1) % 1000000;
  return [prefix, Date.now(), actionSeq, Math.random().toString(36).slice(2,8)].join('-');
}
function showToast(message, ms=2200) {
  els.toast.textContent = message;
  els.toast.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => els.toast.classList.add('hidden'), ms);
}
function showTitleMessage(message='') {
  els.titleMessage.textContent = message;
}
function openModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('hidden');
  el.setAttribute('aria-hidden','false');
}
function closeModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add('hidden');
  el.setAttribute('aria-hidden','true');
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[ch]));
}
function roomStatusLabel(room) {
  if (room.status === 'playing') return 'ゲーム中';
  if (room.status === 'finished') return '終了';
  return '待機中';
}
function roomNo(roomId) {
  const i = ROOM_IDS.indexOf(roomId);
  return i >= 0 ? i + 1 : roomId;
}
function switchView(view) {
  els.titleView.classList.toggle('active', view === 'title');
  els.roomView.classList.toggle('active', view === 'room');
  updateTopButtons();
}
function updateTopButtons() {
  const inRoom = !!currentRoomId;
  const isHost = !!(roomState && selfId && roomState.hostId === selfId);
  const lobbyHost = inRoom && isHost && roomState.status === 'lobby';

  els.pinBtn.classList.toggle('hidden', !inRoom);
  els.leaveBtn.classList.toggle('hidden', !inRoom);
  els.questionBtn.classList.toggle('hidden', inRoom ? !lobbyHost : false);
}
function makeDefaultQuestionBank() {
  const out = [];
  for (const category of CATEGORY_KEYS) {
    const arr = (window.BASE_QUESTION_SETS && window.BASE_QUESTION_SETS[category]) || [];
    arr.forEach((text, i) => out.push({
      id: `${category}_${String(i+1).padStart(3,'0')}`,
      category,
      text: String(text),
      enabled: true,
      source: 'base'
    }));
  }
  return out;
}
function validQuestion(q) {
  return q && typeof q.id === 'string' && CATEGORY_KEYS.includes(q.category)
    && typeof q.text === 'string' && typeof q.enabled === 'boolean';
}
function loadQuestionBank() {
  try {
    const parsed = JSON.parse(localStorage.getItem(QUESTION_BANK_KEY) || 'null');
    if (Array.isArray(parsed) && parsed.length && parsed.every(validQuestion)) return parsed;
  } catch {}

  // v0.2.0以前の編集内容を維持しつつ、新7カテゴリだけ追加する。
  try {
    const oldBank = JSON.parse(localStorage.getItem(QUESTION_BANK_KEY_V1) || 'null');
    if (Array.isArray(oldBank) && oldBank.length && oldBank.every(validQuestion)) {
      const migrated = oldBank.map(q => ({ ...q }));
      const existingCategories = new Set(migrated.map(q => q.category));
      const defaults = makeDefaultQuestionBank();
      for (const q of defaults) {
        if (!existingCategories.has(q.category)) migrated.push(q);
      }
      localStorage.setItem(QUESTION_BANK_KEY, JSON.stringify(migrated));
      return migrated;
    }
  } catch {}

  return makeDefaultQuestionBank();
}
function saveQuestionBank() {
  localStorage.setItem(QUESTION_BANK_KEY, JSON.stringify(questionBank));
}
function loadCategoryPrefs() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CATEGORY_PREF_KEY) || 'null');
    if (parsed && typeof parsed === 'object') {
      return Object.fromEntries(
        CATEGORY_KEYS.map(k => [k, typeof parsed[k] === 'boolean' ? parsed[k] : DEFAULT_CATEGORIES[k]])
      );
    }
  } catch {}
  return { ...DEFAULT_CATEGORIES };
}
function saveCategoryPrefs() {
  localStorage.setItem(CATEGORY_PREF_KEY, JSON.stringify(categoryPrefs));
}
function loadModePrefs() {
  try {
    const parsed = JSON.parse(localStorage.getItem(MODE_PREF_KEY) || 'null');
    if (parsed && typeof parsed.hideFutureQuestions === 'boolean') {
      return { hideFutureQuestions: parsed.hideFutureQuestions };
    }
  } catch {}
  return { hideFutureQuestions: false };
}
function saveModePrefs() {
  localStorage.setItem(MODE_PREF_KEY, JSON.stringify(modePrefs));
}
function categoryCount(category, enabledOnly=true) {
  return questionBank.filter(q => q.category === category && (!enabledOnly || q.enabled)).length;
}
function eligibleQuestions(categories) {
  return questionBank.filter(q => q.enabled && categories[q.category]);
}
function currentSettingsPayload() {
  return {
    categories: { ...categoryPrefs },
    activeQuestionCount: eligibleQuestions(categoryPrefs).length,
    categoryCounts: Object.fromEntries(CATEGORY_KEYS.map(k => [k, categoryCount(k, true)])),
    hideFutureQuestions: modePrefs.hideFutureQuestions === true
  };
}
function randomId() {
  return `custom_${Date.now()}_${Math.random().toString(36).slice(2,9)}`;
}
function shuffle(array) {
  const a = array.slice();
  for (let i=a.length-1;i>0;i--) {
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]]=[a[j],a[i]];
  }
  return a;
}

async function loadRooms() {
  if (currentRoomId) return;
  try {
    const response = await fetch(`${WORKER_ORIGIN}/rooms`, { cache:'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'ROOM情報を取得できません。');
    renderRooms(data.rooms || []);
    showTitleMessage('');
  } catch (err) {
    renderRooms(ROOM_IDS.map(id => ({ roomId:id, status:'lobby', playerCount:0, players:[] })));
    showTitleMessage('サーバーへ接続できません。Workerをデプロイ済みか確認してください。');
  }
}
function renderRooms(rooms) {
  const map = new Map(rooms.map(r => [r.roomId, r]));
  els.roomGrid.innerHTML = ROOM_IDS.map(id => {
    const room = map.get(id) || { roomId:id, status:'lobby', playerCount:0, players:[] };
    const names = Array.isArray(room.players) && room.players.length ? room.players.join('、') : 'なし';
    const tokenExists = !!localStorage.getItem(tokenKey(id));
    const label = tokenExists && room.playerCount > 0 ? '参加 / 再接続' : '参加する';
    return `
      <article class="room-card">
        <div class="room-card-head">
          <h2>ROOM ${roomNo(id)}</h2>
          <span class="room-status">${escapeHtml(roomStatusLabel(room))}</span>
        </div>
        <div class="room-count">${Number(room.playerCount)||0} / ${MAX_PLAYERS}人</div>
        <div class="room-players">参加者：${escapeHtml(names)}</div>
        <div class="room-actions">
          <button class="primary-btn" data-join-room="${id}">${label}</button>
          <button class="danger-outline-btn" data-reset-room="${id}">初期化</button>
        </div>
      </article>
    `;
  }).join('');
  $$('[data-join-room]').forEach(btn => btn.addEventListener('click', () => joinRoom(btn.dataset.joinRoom)));
  $$('[data-reset-room]').forEach(btn => btn.addEventListener('click', () => resetRoom(btn.dataset.resetRoom)));
}
async function resetRoom(roomId) {
  const ok = confirm(`ROOM ${roomNo(roomId)} を初期化しますか？`);
  if (!ok) return;
  try {
    const response = await fetch(`${WORKER_ORIGIN}/reset-empty?roomId=${encodeURIComponent(roomId)}`, {
      method:'POST', cache:'no-store'
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'ROOMを初期化できませんでした。');
    localStorage.removeItem(tokenKey(roomId));
    if (localStorage.getItem(ACTIVE_ROOM_KEY) === roomId) {
      localStorage.removeItem(ACTIVE_ROOM_KEY);
      localStorage.removeItem(ACTIVE_NAME_KEY);
    }
    showToast(`ROOM ${roomNo(roomId)} を初期化しました。`);
    await loadRooms();
  } catch (err) {
    showToast(err.message || 'ROOMを初期化できませんでした。', 3200);
  }
}
async function checkRoomJoin(roomId, playerName, token) {
  const url = new URL(`${WORKER_ORIGIN}/join-check`);
  url.searchParams.set('roomId', roomId);
  url.searchParams.set('name', playerName);
  url.searchParams.set('token', token);
  const response = await fetch(url, { cache:'no-store' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'ROOMへ参加できません。');
  return data;
}
async function joinRoom(roomId, opts={}) {
  if (ws && ws.readyState <= 1) return;
  const playerName = String(opts.name ?? els.playerName.value).trim().slice(0,32);
  if (!playerName) {
    showTitleMessage('プレイヤー名を入力してください。');
    els.playerName.focus();
    return;
  }
  const token = getToken(roomId);
  showTitleMessage('');
  try {
    const joinInfo = await checkRoomJoin(roomId, playerName, token);
    createdRoomThisJoin = joinInfo && joinInfo.hostCheck === true;
  } catch (err) {
    if (opts.auto) {
      localStorage.removeItem(ACTIVE_ROOM_KEY);
      localStorage.removeItem(ACTIVE_NAME_KEY);
    } else {
      showTitleMessage(err.message);
    }
    return;
  }

  currentRoomId = roomId;
  currentPlayerName = playerName;
  manualClose = false;
  hostSettingsSyncedForRoom = false;
  localPredictionDraft = null;
  connectWebSocket(roomId, playerName, token);
}
function connectWebSocket(roomId, playerName, token) {
  const wsBase = WORKER_ORIGIN.replace(/^http:/,'ws:').replace(/^https:/,'wss:');
  const url = new URL(`${wsBase}/ws`);
  url.searchParams.set('roomId', roomId);
  url.searchParams.set('name', playerName);
  url.searchParams.set('token', token);
  ws = new WebSocket(url.toString());

  ws.addEventListener('open', () => {
    switchView('room');
    clearTimeout(reconnectTimer);
  });
  ws.addEventListener('message', ev => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'state') {
      roomState = msg.state;
      selfId = msg.state.selfId || selfId;
      localStorage.setItem(ACTIVE_ROOM_KEY, currentRoomId);
      localStorage.setItem(ACTIVE_NAME_KEY, currentPlayerName);
      onRoomStateReceived(roomState);
      renderRoomState();
      maybeSyncHostSettings();
    } else if (msg.type === 'error') {
      showToast(msg.error || '操作できませんでした。', 3000);
    } else if (msg.type === 'ping') {
      showToast(`${msg.name || 'プレイヤー'} がピンを送りました`);
      const row = document.querySelector(`[data-player-id="${CSS.escape(msg.playerId || '')}"]`);
      if (row) {
        row.classList.remove('pinged');
        void row.offsetWidth;
        row.classList.add('pinged');
      }
    }
  });
  ws.addEventListener('close', () => {
    ws = null;
    if (!manualClose && currentRoomId) scheduleReconnect();
  });
  ws.addEventListener('error', () => {});
}
function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    if (!currentRoomId || (ws && ws.readyState <= 1)) return;
    connectWebSocket(currentRoomId, currentPlayerName, getToken(currentRoomId));
  }, 1200);
}
function sendAction(type, payload={}, prefix=type) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('サーバーへ再接続中です。');
    scheduleReconnect();
    return;
  }
  ws.send(JSON.stringify({ type, actionId:newActionId(prefix), ...payload }));
}
function onRoomStateReceived(state) {
  const started = state.status === 'playing' || state.gameStarted === true;
  const sessionId = state.gameSessionId || null;
  if (started && sessionId && commonNameSavedForSession !== sessionId) {
    saveCommonNameOnActualStart(currentPlayerName);
    commonNameSavedForSession = sessionId;
  }
}
function maybeSyncHostSettings() {
  if (!roomState || roomState.status !== 'lobby' || roomState.hostId !== selfId || hostSettingsSyncedForRoom) return;
  hostSettingsSyncedForRoom = true;
  if (!createdRoomThisJoin) return;
  sendAction('setSettings', { settings: currentSettingsPayload() }, 'settings');
}
function renderRoomState() {
  if (!roomState) return;
  els.roomTitle.textContent = `ROOM ${roomNo(roomState.roomId)}`;
  els.roomStatus.textContent = roomStatusLabel(roomState);
  renderPlayers();
  renderCategories();
  updateTopButtons();

  const isLobby = roomState.status === 'lobby';
  els.roomLayout.classList.toggle('lobby-mode', isLobby);
  els.roomLayout.classList.toggle('play-mode', !isLobby);
  els.sidePanel.classList.toggle('hidden', !isLobby);
  els.lobbyArea.classList.toggle('hidden', !isLobby);
  els.gameArea.classList.toggle('hidden', isLobby || roomState.status === 'finished');
  els.resultArea.classList.toggle('hidden', roomState.status !== 'finished');

  if (roomState.status === 'playing') renderGame();
  if (roomState.status === 'finished') renderFinalResult();

  const isHost = roomState.hostId === selfId;
  els.startBtn.classList.toggle('hidden', !(isLobby && isHost));
}
function renderPlayers() {
  const respondentId = roomState.game && roomState.game.respondentId;
  const predictionStatus = roomState.game && roomState.game.predictionStatus || {};
  els.playerList.innerHTML = (roomState.players || []).map(p => {
    const meta = [
      p.id === roomState.hostId ? 'ホスト' : '',
      p.id === respondentId ? '回答者' : '',
      roomState.game && roomState.game.phase === 'reviewing' && p.id === respondentId ? '質問確認中' : '',
      roomState.game && roomState.game.phase === 'predicting' && p.id !== respondentId
        ? (predictionStatus[p.id] ? '予想済み' : '予想中') : '',
      p.connected ? '' : '再接続待ち'
    ].filter(Boolean).join(' / ');
    return `
      <div class="player-row ${p.id===selfId?'current':''} ${p.id===respondentId?'respondent':''}" data-player-id="${escapeHtml(p.id)}">
        <div class="player-main">
          <div class="player-name">${escapeHtml(p.name)}</div>
          <div class="player-meta">${escapeHtml(meta || '参加中')}</div>
        </div>
        <div class="player-score">${Number(p.score)||0}</div>
      </div>
    `;
  }).join('');
}
function renderCategories() {
  const isHost = roomState && roomState.hostId === selfId && roomState.status === 'lobby';
  const serverSettings = roomState && roomState.settings;
  const cats = isHost ? categoryPrefs : (serverSettings && serverSettings.categories) || DEFAULT_CATEGORIES;
  const counts = isHost
    ? Object.fromEntries(CATEGORY_KEYS.map(k => [k, categoryCount(k,true)]))
    : (serverSettings && serverSettings.categoryCounts) || {};
  els.categorySettings.innerHTML = CATEGORY_KEYS.map(k => `
    <div class="category-row">
      <div>
        <div class="category-label">${CATEGORY_META[k].label}</div>
        <div class="category-count">${Number(counts[k])||0}問</div>
      </div>
      <label class="switch">
        <input type="checkbox" data-category-toggle="${k}" ${cats[k]?'checked':''} ${isHost?'':'disabled'}>
        <span class="slider"></span>
      </label>
    </div>
  `).join('');
  const total = isHost ? eligibleQuestions(categoryPrefs).length : Number(serverSettings && serverSettings.activeQuestionCount)||0;
  els.activeQuestionCount.textContent = `出題候補：${total}問`;

  const hideFutureQuestions = isHost
    ? modePrefs.hideFutureQuestions === true
    : !!(serverSettings && serverSettings.hideFutureQuestions);
  els.modeSettings.innerHTML = `
    <div class="mode-row">
      <div class="mode-copy">
        <div class="category-label">質問を隠すモード</div>
        <div class="category-count">回答者には進行中の質問だけ表示</div>
      </div>
      <label class="switch">
        <input type="checkbox" id="hideFutureQuestionsToggle" ${hideFutureQuestions?'checked':''} ${isHost?'':'disabled'}>
        <span class="slider"></span>
      </label>
    </div>
  `;

  if (isHost) {
    $$('[data-category-toggle]').forEach(input => input.addEventListener('change', () => {
      categoryPrefs[input.dataset.categoryToggle] = input.checked;
      saveCategoryPrefs();
      const payload = currentSettingsPayload();
      sendAction('setSettings', { settings:payload }, 'settings');
      renderCategories();
    }));
    const modeToggle = $('#hideFutureQuestionsToggle');
    if (modeToggle) modeToggle.addEventListener('change', () => {
      modePrefs.hideFutureQuestions = modeToggle.checked;
      saveModePrefs();
      sendAction('setSettings', { settings:currentSettingsPayload() }, 'settings');
      renderCategories();
    });
  }
}
function buildQuestionRounds(playerCount) {
  const pool = eligibleQuestions(categoryPrefs);
  if (pool.length < PYRAMID_QUESTION_COUNT + 1) {
    throw new Error(`質問が足りません。最低${PYRAMID_QUESTION_COUNT + 1}問をONにしてください。`);
  }
  const rounds = [];
  for (let r=0;r<playerCount;r++) {
    const shuffled = shuffle(pool);
    const questions = shuffled.slice(0, PYRAMID_QUESTION_COUNT).map(q => ({
      id:q.id, category:q.category, text:q.text
    }));
    const reserveSize = Math.min(REPLACEMENT_RESERVE_COUNT, Math.max(1, shuffled.length - PYRAMID_QUESTION_COUNT));
    const reserve = shuffled.slice(PYRAMID_QUESTION_COUNT, PYRAMID_QUESTION_COUNT + reserveSize).map(q => ({
      id:q.id, category:q.category, text:q.text
    }));
    rounds.push({ questions, reserve });
  }
  return rounds;
}
function startGame() {
  if (!roomState || roomState.hostId !== selfId || roomState.status !== 'lobby') return;
  const playerCount = (roomState.players || []).length;
  if (playerCount < 2) {
    showToast('2人以上で開始してください。');
    return;
  }
  if (!CATEGORY_KEYS.some(k => categoryPrefs[k])) {
    showToast('カテゴリを1つ以上ONにしてください。');
    return;
  }
  try {
    const questionRounds = buildQuestionRounds(playerCount);
    sendAction('start', { questionRounds, settings:currentSettingsPayload() }, 'start');
  } catch (err) {
    showToast(err.message, 3400);
  }
}
function rowStart(row) {
  return row * (row + 1) / 2;
}
function currentNodeFromAnswers(answers) {
  const a = answers || [];
  const row = a.length;
  const rightMoves = a.filter(answer => answer === false).length;
  return rowStart(row) + rightMoves;
}
function endpointFromAnswers(answers) {
  return (answers || []).filter(answer => answer === false).length;
}
function renderGame() {
  const g = roomState.game;
  if (!g) return;
  els.roundLabel.textContent = `ROUND ${Number(g.roundIndex)+1} / ${Number(g.totalRounds)}`;
  const respondent = (roomState.players || []).find(p => p.id === g.respondentId);
  els.respondentLabel.textContent = `回答者：${respondent ? respondent.name : '---'}`;
  const phaseText = {
    reviewing:'質問確認・チェンジ',
    predicting:'最終地点を予想',
    answering:'YES / NO 回答',
    result:'結果発表'
  }[g.phase] || '';
  els.phaseLabel.textContent = phaseText;

  renderPyramid(g);
  renderActionArea(g);

  if (g.phase === 'result') {
    els.gameArea.classList.add('hidden');
    els.resultArea.classList.remove('hidden');
    renderRoundResult(g);
  } else {
    els.resultArea.classList.add('hidden');
    els.gameArea.classList.remove('hidden');
  }
}
function renderPyramid(g) {
  const questions = g.questions || [];
  const answers = g.answers || [];
  const pathNodes = g.pathNodes || [];
  const currentNode = g.phase === 'answering' && answers.length < PYRAMID_LEVELS ? currentNodeFromAnswers(answers) : -1;
  const isRespondent = selfId === g.respondentId;
  const canChange = g.phase === 'reviewing' && isRespondent && Number(g.replacementRemaining) > 0;
  const rows = [
    { cls:'r1', indexes:[0] },
    { cls:'r2', indexes:[1,2] },
    { cls:'r3', indexes:[3,4,5] },
    { cls:'r4', indexes:[6,7,8,9] },
    { cls:'r5', indexes:[10,11,12,13,14] }
  ];
  const html = rows.map(row => `
    <div class="p-row ${row.cls}">
      ${row.indexes.map(idx => {
        const q = questions[idx] || {};
        const pathPos = pathNodes.indexOf(idx);
        const visitedClass = pathPos >= 0 ? (answers[pathPos] ? 'visited-yes' : 'visited-no') : '';
        const hiddenText = !q.text;
        return `<div class="qnode ${idx===currentNode?'current':''} ${visitedClass} ${hiddenText?'question-hidden':''}" data-label="Q${idx+1}">
          <span class="qnode-text">${hiddenText ? '？？？' : escapeHtml(q.text)}</span>
          ${canChange && !hiddenText ? `<button class="change-q-btn" data-change-question="${idx}" title="この質問をチェンジ">変更</button>` : ''}
        </div>`;
      }).join('')}
    </div>
  `).join('');

  const canPredict = g.phase === 'predicting' && selfId !== g.respondentId && g.myPrediction == null;
  const leaves = `
    <div class="p-row leaves">
      ${LEAF_LABELS.map((label, idx) => {
        const selected = localPredictionDraft === idx;
        const arrived = g.arrivedEndpoint === idx;
        return `<button class="leaf-btn ${selected?'selected':''} ${arrived?'arrived':''}" data-leaf="${idx}" ${canPredict?'':'disabled'}>${label}</button>`;
      }).join('')}
    </div>
  `;
  els.pyramid.innerHTML = html + leaves;

  if (canChange) {
    $$('[data-change-question]').forEach(btn => btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.changeQuestion);
      if (!Number.isInteger(idx)) return;
      sendAction('changeQuestion', { index:idx }, 'changeq');
    }));
  }
  if (canPredict) {
    $$('[data-leaf]').forEach(btn => btn.addEventListener('click', () => {
      localPredictionDraft = Number(btn.dataset.leaf);
      renderPyramid(g);
      renderActionArea(g);
    }));
  }
}
function renderActionArea(g) {
  const isRespondent = selfId === g.respondentId;
  if (g.phase === 'reviewing') {
    if (isRespondent) {
      els.actionArea.innerHTML = `
        <div class="action-card">
          <div class="big-text">答えたくない質問があれば「変更」で入れ替えられます</div>
          <div class="predict-note">残りチェンジ：${Number(g.replacementRemaining)||0}回</div>
          <button id="confirmQuestionsBtn" class="primary-btn">この質問で開始</button>
        </div>
      `;
      $('#confirmQuestionsBtn').addEventListener('click', () => sendAction('confirmQuestions', {}, 'confirmq'));
    } else {
      els.actionArea.innerHTML = `<div class="action-card"><div class="big-text">回答者が質問を確認中です</div><div class="predict-note">質問のチェンジ内容は確定するまで非公開です。</div></div>`;
    }
    return;
  }
  if (g.phase === 'predicting') {
    if (isRespondent) {
      const need = (roomState.players || []).length - 1;
      const done = Object.values(g.predictionStatus || {}).filter(Boolean).length;
      els.actionArea.innerHTML = `<div class="action-card"><div class="big-text">みんなが予想中です</div><div class="predict-note">${done} / ${need}人 予想済み</div></div>`;
    } else if (g.myPrediction != null) {
      els.actionArea.innerHTML = `<div class="action-card"><div class="big-text">予想：${LEAF_LABELS[g.myPrediction]} で確定済み</div><div class="predict-note">全員の予想が揃うまでお待ちください。</div></div>`;
    } else {
      const draft = localPredictionDraft;
      els.actionArea.innerHTML = `
        <div class="action-card">
          <div class="big-text">この人は最終的にどこへ行く？</div>
          <div class="predict-note">${draft == null ? 'A～Fから1か所選んでください。' : `選択中：${LEAF_LABELS[draft]}`}</div>
          <button id="confirmPredictionBtn" class="primary-btn" ${draft==null?'disabled':''}>この地点で確定</button>
        </div>
      `;
      const btn = $('#confirmPredictionBtn');
      if (btn) btn.addEventListener('click', () => {
        if (localPredictionDraft == null) return;
        sendAction('predict', { endpoint:localPredictionDraft }, 'predict');
      });
    }
    return;
  }

  if (g.phase === 'answering') {
    if (isRespondent) {
      const node = currentNodeFromAnswers(g.answers || []);
      const q = (g.questions || [])[node];
      els.actionArea.innerHTML = `
        <div class="action-card">
          <div class="big-text">${escapeHtml(q ? q.text : '')}</div>
          <button id="yesBtn" class="answer-btn yes">YES</button>
          <button id="noBtn" class="answer-btn no">NO</button>
        </div>
      `;
      $('#yesBtn').addEventListener('click', () => sendAction('answer', { answer:true }, 'answer'));
      $('#noBtn').addEventListener('click', () => sendAction('answer', { answer:false }, 'answer'));
    } else {
      els.actionArea.innerHTML = `<div class="action-card"><div class="big-text">回答者のYES / NOを見守っています</div></div>`;
    }
  }
}
function renderRoundResult(g) {
  localPredictionDraft = null;
  const arrived = Number(g.arrivedEndpoint);
  const predictions = g.predictions || {};
  const respondent = (roomState.players || []).find(p => p.id === g.respondentId);
  const cards = (roomState.players || []).filter(p => p.id !== g.respondentId).map(p => {
    const ep = predictions[p.id];
    const correct = Number(ep) === arrived;
    return `
      <div class="prediction-item ${correct?'correct':''}">
        <div><b>${escapeHtml(p.name)}</b></div>
        <div>予想：${ep == null ? '---' : LEAF_LABELS[ep]} ${correct?'✓ +1点':''}</div>
      </div>
    `;
  }).join('');
  const isHost = roomState.hostId === selfId;
  els.resultArea.innerHTML = `
    <div class="result-card">
      <h2>ROUND ${Number(g.roundIndex)+1} 結果</h2>
      <div class="arrival">${escapeHtml(respondent ? respondent.name : '')} の到達地点：<b>${LEAF_LABELS[arrived] || '---'}</b></div>
      <div class="prediction-results">${cards}</div>
      <div class="result-actions">
        ${isHost ? `<button id="nextRoundBtn" class="primary-btn">${Number(g.roundIndex)+1 >= Number(g.totalRounds) ? '最終結果へ' : '次のラウンド'}</button>` : `<span class="small-muted">ホストが次へ進めます</span>`}
      </div>
    </div>
  `;
  const btn = $('#nextRoundBtn');
  if (btn) btn.addEventListener('click', () => sendAction('nextRound', {}, 'next'));
}
function renderFinalResult() {
  const players = (roomState.players || []).slice().sort((a,b) => (b.score||0)-(a.score||0));
  let rank = 0, lastScore = null;
  const rows = players.map((p,i) => {
    if (lastScore !== p.score) rank = i+1;
    lastScore = p.score;
    return `<div class="rank-row"><div class="rank-no">${rank}位</div><div>${escapeHtml(p.name)}</div><div class="rank-score">${Number(p.score)||0}点</div></div>`;
  }).join('');

  const history = Array.isArray(roomState.game && roomState.game.roundHistory)
    ? roomState.game.roundHistory
    : [];
  const historyByPlayer = new Map(history.map(entry => [entry.respondentId, entry]));
  const answerHistory = (roomState.players || []).map(p => {
    const entry = historyByPlayer.get(p.id);
    const answers = entry && Array.isArray(entry.answers) ? entry.answers : [];
    const answerRows = answers.length ? answers.map((item,index) => `
      <div class="answer-history-row">
        <div class="answer-history-no">${index+1}</div>
        <div class="answer-history-badge ${item.answer ? 'yes' : 'no'}">${item.answer ? 'YES' : 'NO'}</div>
        <div class="answer-history-question">${escapeHtml(item.question || '---')}</div>
      </div>
    `).join('') : `<div class="small-muted answer-history-empty">回答履歴がありません</div>`;
    const endpoint = entry && Number.isInteger(Number(entry.arrivedEndpoint))
      ? (LEAF_LABELS[Number(entry.arrivedEndpoint)] || '---')
      : '---';
    return `
      <section class="player-answer-history">
        <div class="player-answer-history-head">
          <h3>${escapeHtml(p.name)}</h3>
          <span>到達地点 ${endpoint}</span>
        </div>
        <div class="answer-history-list">${answerRows}</div>
      </section>
    `;
  }).join('');

  const isHost = roomState.hostId === selfId;
  els.resultArea.innerHTML = `
    <div class="result-card final-result-card">
      <h2>最終結果</h2>
      <div class="final-ranking">${rows}</div>
      <h2 class="history-title">YES / NO 回答履歴</h2>
      <div class="all-answer-history">${answerHistory}</div>
      <div class="result-actions">
        ${isHost ? `<button id="backLobbyBtn" class="primary-btn">ロビーへ戻る</button>` : `<span class="small-muted">ホストがロビーへ戻します</span>`}
      </div>
    </div>
  `;
  const btn = $('#backLobbyBtn');
  if (btn) btn.addEventListener('click', () => sendAction('returnLobby', {}, 'lobby'));
}

function leaveRoom() {
  if (!currentRoomId) return;
  const playing = roomState && roomState.status === 'playing';
  if (playing) {
    const ok = confirm('ゲーム中です。退出するとROOMには席が残り、同じROOMから再接続できます。退出しますか？');
    if (!ok) return;
  }
  if (ws && ws.readyState === WebSocket.OPEN) sendAction('leave', {}, 'leave');
  manualClose = true;
  try { ws && ws.close(1000,'leave'); } catch {}
  ws = null;
  localStorage.removeItem(ACTIVE_ROOM_KEY);
  localStorage.removeItem(ACTIVE_NAME_KEY);
  currentRoomId = null;
  currentPlayerName = '';
  roomState = null;
  selfId = null;
  hostSettingsSyncedForRoom = false;
  createdRoomThisJoin = false;
  switchView('title');
  loadRooms();
}
function sendPin() {
  if (currentRoomId) sendAction('pin', {}, 'pin');
}

function fillQuestionSelectors() {
  const options = CATEGORY_KEYS.map(k => `<option value="${k}">${CATEGORY_META[k].label}</option>`).join('');
  els.questionCategoryFilter.innerHTML = `<option value="all">すべて</option>${options}`;
  els.editQuestionCategory.innerHTML = options;
}
function renderQuestionManager() {
  const filter = els.questionCategoryFilter.value || 'all';
  const term = els.questionSearch.value.trim().toLowerCase();
  const filtered = questionBank.filter(q => (filter === 'all' || q.category === filter) && (!term || q.text.toLowerCase().includes(term)));
  const enabledCount = questionBank.filter(q => q.enabled).length;
  els.questionSummary.textContent = `全${questionBank.length}問 / 有効${enabledCount}問`;
  els.questionList.innerHTML = filtered.map(q => `
    <div class="question-item ${q.enabled?'':'off'}" data-question-row="${escapeHtml(q.id)}">
      <label class="switch">
        <input type="checkbox" data-question-enable="${escapeHtml(q.id)}" ${q.enabled?'checked':''}>
        <span class="slider"></span>
      </label>
      <div class="q-cat">${CATEGORY_META[q.category].label}</div>
      <div class="q-text">${escapeHtml(q.text)}</div>
      <div class="q-actions">
        <button class="ghost-btn" data-question-edit="${escapeHtml(q.id)}">編集</button>
        <button class="danger-outline-btn" data-question-delete="${escapeHtml(q.id)}">削除</button>
      </div>
    </div>
  `).join('') || `<div class="small-muted">該当する質問がありません。</div>`;

  $$('[data-question-enable]').forEach(input => input.addEventListener('change', () => {
    const q = questionBank.find(x => x.id === input.dataset.questionEnable);
    if (!q) return;
    q.enabled = input.checked;
    saveQuestionBank();
    renderQuestionManager();
    onQuestionBankChanged();
  }));
  $$('[data-question-edit]').forEach(btn => btn.addEventListener('click', () => openQuestionEditor(btn.dataset.questionEdit)));
  $$('[data-question-delete]').forEach(btn => btn.addEventListener('click', () => deleteQuestion(btn.dataset.questionDelete)));
}
function onQuestionBankChanged() {
  if (roomState && roomState.hostId === selfId && roomState.status === 'lobby') {
    sendAction('setSettings', { settings:currentSettingsPayload() }, 'settings');
    renderCategories();
  }
}
function openQuestionEditor(id=null) {
  editingQuestionId = id;
  const q = id ? questionBank.find(x => x.id === id) : null;
  els.editQuestionTitle.textContent = q ? '質問を編集' : '質問を新規追加';
  els.editQuestionCategory.value = q ? q.category : 'normal';
  els.editQuestionText.value = q ? q.text : '';
  openModal('editQuestionModal');
  setTimeout(() => els.editQuestionText.focus(), 0);
}
function saveEditedQuestion() {
  const category = els.editQuestionCategory.value;
  const text = els.editQuestionText.value.trim();
  if (!CATEGORY_KEYS.includes(category) || !text) {
    showToast('カテゴリと質問文を入力してください。');
    return;
  }
  if (editingQuestionId) {
    const q = questionBank.find(x => x.id === editingQuestionId);
    if (!q) return;
    q.category = category;
    q.text = text;
  } else {
    questionBank.push({ id:randomId(), category, text, enabled:true, source:'custom' });
  }
  saveQuestionBank();
  closeModal('editQuestionModal');
  renderQuestionManager();
  onQuestionBankChanged();
}
function deleteQuestion(id) {
  const q = questionBank.find(x => x.id === id);
  if (!q) return;
  if (!confirm(`この質問を削除しますか？\n\n「${q.text}」`)) return;
  questionBank = questionBank.filter(x => x.id !== id);
  saveQuestionBank();
  renderQuestionManager();
  onQuestionBankChanged();
}
function exportQuestions() {
  const payload = {
    game:GAME_ID,
    version:1,
    exportedAt:new Date().toISOString(),
    questions:questionBank
  };
  const blob = new Blob([JSON.stringify(payload,null,2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `docchina_questions_${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function importQuestions(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const arr = Array.isArray(parsed) ? parsed : parsed.questions;
    if (!Array.isArray(arr) || !arr.length || !arr.every(validQuestion)) throw new Error('質問データ形式が正しくありません。');
    if (!confirm(`現在の質問${questionBank.length}問を、読み込んだ${arr.length}問で置き換えますか？`)) return;
    questionBank = arr.map(q => ({...q}));
    saveQuestionBank();
    renderQuestionManager();
    onQuestionBankChanged();
    showToast('質問データを読み込みました。');
  } catch (err) {
    showToast(err.message || '質問データを読み込めませんでした。', 3200);
  } finally {
    els.importQuestionsInput.value = '';
  }
}
function resetQuestions() {
  if (!confirm('編集・追加・削除した内容を破棄して、初期1800問に戻しますか？')) return;
  questionBank = makeDefaultQuestionBank();
  saveQuestionBank();
  renderQuestionManager();
  onQuestionBankChanged();
  showToast('初期1800問に戻しました。');
}
function openQuestionManager() {
  renderQuestionManager();
  openModal('questionModal');
}

async function attemptAutoReconnect() {
  const roomId = localStorage.getItem(ACTIVE_ROOM_KEY);
  const name = String(localStorage.getItem(ACTIVE_NAME_KEY) || '').trim();
  if (!ROOM_IDS.includes(roomId) || !name) return false;
  els.playerName.value = name;
  await joinRoom(roomId, { name, auto:true });
  return !!currentRoomId;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && currentRoomId && (!ws || ws.readyState !== WebSocket.OPEN)) scheduleReconnect();
});
window.addEventListener('online', () => {
  if (currentRoomId && (!ws || ws.readyState !== WebSocket.OPEN)) scheduleReconnect();
});

els.playerName.value = sessionStorage.getItem(NAME_DRAFT_KEY) ?? commonSavedName() ?? '';
els.playerName.addEventListener('input', e => sessionStorage.setItem(NAME_DRAFT_KEY, e.target.value));
els.startBtn.addEventListener('click', startGame);
els.leaveBtn.addEventListener('click', leaveRoom);
els.pinBtn.addEventListener('click', sendPin);
els.rulesBtn.addEventListener('click', () => openModal('rulesModal'));
els.questionBtn.addEventListener('click', openQuestionManager);
els.addQuestionBtn.addEventListener('click', () => openQuestionEditor());
els.saveQuestionBtn.addEventListener('click', saveEditedQuestion);
els.questionCategoryFilter.addEventListener('change', renderQuestionManager);
els.questionSearch.addEventListener('input', renderQuestionManager);
els.exportQuestionsBtn.addEventListener('click', exportQuestions);
els.importQuestionsInput.addEventListener('change', () => importQuestions(els.importQuestionsInput.files[0]));
els.resetQuestionsBtn.addEventListener('click', resetQuestions);
$$('[data-close-modal]').forEach(btn => btn.addEventListener('click', () => closeModal(btn.dataset.closeModal)));
$$('.modal').forEach(modal => modal.addEventListener('click', e => {
  if (e.target === modal) closeModal(modal.id);
}));

fillQuestionSelectors();
switchView('title');
loadRooms();
clearInterval(roomsPollTimer);
roomsPollTimer = setInterval(loadRooms, 5000);
attemptAutoReconnect();

})();