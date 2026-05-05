import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  updateProfile,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  getDatabase,
  ref,
  get,
  set,
  push,
  query,
  orderByKey,
  limitToLast,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js';
import { APP_CONFIG } from './config.js';
import {
  saveLocalTest,
  listLocalTestsMeta,
  getLocalTestJson,
} from './local-tests.js';

const FB = initializeApp(APP_CONFIG.firebase);
const auth = getAuth(FB);
const db = getDatabase(FB);

const ROUTE_AUTH = 'auth';
const ROUTE_MENU = 'menu';
const ROUTE_TEST_SELECTION = 'test_selection';
const ROUTE_RUN = 'run';
const ROUTE_ATTEMPT_HISTORY = 'attempt_history';
const ROUTE_ATTEMPT = 'attempt';
const ROUTE_RESULT = 'result';
const ROUTE_PROFILE = 'profile';
const ROUTE_SETTINGS = 'settings';
const ROUTE_TEST_EDITOR = 'test_editor';

const LS_THEME = 'lycoris_web_theme';
const LS_SHUFFLE = 'lycoris_web_shuffle';
const LS_SOURCE = 'lycoris_web_test_source';
const LS_LOCAL_ATTEMPTS = 'lycoris_web_attempts_local';
const LS_PENDING_RUN = 'lycoris_web_pending_run';
const MAX_LOCAL_ATTEMPTS = 50;

const DEFAULT_THEME = {
  primaryDark: '#2c3a5e',
  primaryMedium: '#4a5c80',
  primaryLight: '#7284a8',
  accentGold: '#e6b800',
  bgStart: '#fafaff',
  bgEnd: '#ebeef5',
};

/** @type {{ user: import('firebase/auth').User | null, displayName: string, testRun: object | null, timerId: any, updateInfo: any, updateChecked: boolean }} */
const state = {
  user: null,
  displayName: '',
  testRun: null,
  timerId: null,
  updateInfo: null,
  updateChecked: false,
};

function applyThemeFromStorage() {
  try {
    const raw = localStorage.getItem(LS_THEME);
    const t = raw ? { ...DEFAULT_THEME, ...JSON.parse(raw) } : DEFAULT_THEME;
    const r = document.documentElement;
    r.style.setProperty('--primary-dark', t.primaryDark);
    r.style.setProperty('--primary-medium', t.primaryMedium);
    r.style.setProperty('--primary-light', t.primaryLight);
    r.style.setProperty('--accent-gold', t.accentGold);
    r.style.setProperty('--bg-start', t.bgStart);
    r.style.setProperty('--bg-end', t.bgEnd);
  } catch {
    /* ignore */
  }
}

applyThemeFromStorage();

function parseHash() {
  const h = (location.hash || `#/${ROUTE_MENU}`).replace(/^#\/?/, '');
  const [path, query = ''] = h.split('?');
  const segments = path.split('/').filter(Boolean);
  const name = segments[0] || 'menu';
  const params = new URLSearchParams(query);
  return { name, segments, params };
}

function setHash(path) {
  location.hash = '#/' + path;
}

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function showToast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(showToast._id);
  showToast._id = setTimeout(() => {
    t.hidden = true;
  }, 2600);
}

async function checkForWebUpdate() {
  if (state.updateChecked) return state.updateInfo;
  state.updateChecked = true;
  try {
    const res = await fetch(`${APP_CONFIG.updateManifestUrl}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const info = await res.json();
    if (!info || typeof info.version_code !== 'number') return null;
    if (info.version_code > (APP_CONFIG.appVersionCode || 0)) {
      state.updateInfo = info;
      return info;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function authErrorRu(err) {
  const c = err?.code || '';
  const map = {
    'auth/invalid-email': 'Некорректный email',
    'auth/user-disabled': 'Аккаунт заблокирован',
    'auth/user-not-found': 'Пользователь с таким email не найден',
    'auth/wrong-password': 'Неверный пароль',
    'auth/invalid-credential': 'Неверный email или пароль',
    'auth/email-already-in-use': 'Этот email уже зарегистрирован',
    'auth/weak-password': 'Пароль должен содержать минимум 6 символов',
    'auth/invalid-login-credentials': 'Неверный email или пароль',
  };
  return map[c] || err?.message || 'Ошибка авторизации';
}

async function syncDisplayName(user) {
  if (!user) {
    state.displayName = '';
    return;
  }
  try {
    const snap = await get(ref(db, `users/${user.uid}/profile/displayName`));
    const v = snap.val();
    if (v && String(v).trim()) {
      state.displayName = String(v).trim();
      return;
    }
  } catch {
    /* ignore */
  }
  const base = user.email ? user.email.split('@')[0] : 'Пользователь';
  state.displayName = user.displayName?.trim() || base;
}

function parseQuestionsFromJson(testData) {
  const list = [];
  const arr = testData?.questions;
  const assets = testData?.assets && typeof testData.assets === 'object' ? testData.assets : {};
  if (!Array.isArray(arr)) return list;
  for (const q of arr) {
    if (!q?.question) continue;

    // Unified contract: answers[{ text, isCorrect }]
    if (Array.isArray(q.answers)) {
      const options = [];
      let correct = -1;
      for (let j = 0; j < q.answers.length; j++) {
        const a = q.answers[j];
        if (!a || typeof a.text !== 'string') continue;
        options.push(a.text);
        if (a.isCorrect === true) correct = j;
      }
      if (correct >= 0 && options.length) {
        const imageRef = q.image || q.imageUrl || q.image_url || '';
        list.push({
          question: q.question,
          image: resolveQuestionImage(imageRef, assets),
          options,
          correctAnswer: correct,
        });
      }
      continue;
    }

    // Legacy fallback: options[] + correctAnswer(index)
    if (Array.isArray(q.options)) {
      const options = q.options.filter((o) => typeof o === 'string');
      const correct = Number(q.correctAnswer);
      if (options.length && Number.isInteger(correct) && correct >= 0 && correct < options.length) {
        const imageRef = q.image || q.imageUrl || q.image_url || '';
        list.push({
          question: q.question,
          image: resolveQuestionImage(imageRef, assets),
          options,
          correctAnswer: correct,
        });
      }
    }
  }
  return list;
}

function resolveQuestionImage(imageRef, assets) {
  const src = String(imageRef || '').trim();
  if (!src) return '';
  if (src.startsWith('asset:')) {
    const assetKey = src.slice('asset:'.length).trim();
    const assetValue = assets && Object.prototype.hasOwnProperty.call(assets, assetKey) ? assets[assetKey] : '';
    return typeof assetValue === 'string' ? assetValue : '';
  }
  return src;
}

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function isShuffleOn() {
  return localStorage.getItem(LS_SHUFFLE) !== 'false';
}

function getTestSource() {
  return localStorage.getItem(LS_SOURCE) === 'local' ? 'local' : 'github';
}

async function fetchRemoteTestList() {
  const res = await fetch(APP_CONFIG.testsIndexUrl);
  if (!res.ok) throw new Error('Не удалось загрузить список тестов');
  const data = await res.json();
  const tests = Array.isArray(data.tests) ? data.tests : [];
  return tests.map((t) => ({
    id: t.id || '',
    name: t.name || 'Тест',
    description: t.description || '',
    questionCount: t.questionCount || 0,
    estimatedTime: t.estimatedTime || '',
    difficulty: t.difficulty || '',
    fileName: t.fileName || '',
  }));
}

async function loadTestJson(source, fileName) {
  if (source === 'local') {
    const json = await getLocalTestJson(fileName);
    if (!json) throw new Error('Локальный тест не найден');
    return json;
  }
  const url = APP_CONFIG.testsBaseUrl + encodeURIComponent(fileName);
  const res = await fetch(url);
  if (!res.ok) throw new Error('Ошибка загрузки теста');
  return res.json();
}

function clearTestTimer() {
  if (state.timerId) {
    clearInterval(state.timerId);
    state.timerId = null;
  }
}

function readLocalAttempts() {
  try {
    const raw = localStorage.getItem(LS_LOCAL_ATTEMPTS);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writeLocalAttempts(arr) {
  localStorage.setItem(LS_LOCAL_ATTEMPTS, JSON.stringify(arr.slice(0, MAX_LOCAL_ATTEMPTS)));
}

function pushLocalAttempt(record) {
  const all = readLocalAttempts();
  all.unshift(record);
  writeLocalAttempts(all);
}

function readPendingRun() {
  try {
    const raw = localStorage.getItem(LS_PENDING_RUN);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return null;
    return data;
  } catch {
    return null;
  }
}

function writePendingRun(runState) {
  if (!runState) return;
  const payload = {
    questions: Array.isArray(runState.questions) ? runState.questions : [],
    index: Number.isFinite(runState.index) ? runState.index : 0,
    seconds: Number.isFinite(runState.seconds) ? runState.seconds : 0,
    answersByIndex: Array.isArray(runState.answersByIndex) ? runState.answersByIndex : [],
    checked: Array.isArray(runState.checked) ? runState.checked : [],
    meta: runState.meta || null,
    source: runState.source || '',
    fileName: runState.fileName || '',
    userName: runState.userName || 'Гость',
    savedAt: new Date().toISOString(),
  };
  localStorage.setItem(LS_PENDING_RUN, JSON.stringify(payload));
}

function clearPendingRun() {
  localStorage.removeItem(LS_PENDING_RUN);
}

function buildAttemptPayload(attemptState, meta) {
  const { questions, seconds, answersByIndex, userName, testName, testId } = attemptState;
  let correct = 0;
  let incorrect = 0;
  const userAnswers = [];
  for (let i = 0; i < questions.length; i++) {
    const ans = answersByIndex[i] || '';
    userAnswers.push(ans);
    const right = questions[i].options[questions[i].correctAnswer];
    if (ans === right) correct++;
    else incorrect++;
  }
  const questionsSnap = questions.map((q) => ({
    question: q.question,
    image: q.image || '',
    options: q.options,
    correctAnswer: q.correctAnswer,
  }));
  return {
    userName,
    testName: testName || meta?.name || 'Тест',
    testId: testId || meta?.id || 'unknown',
    timeSpent: seconds,
    correctAnswers: correct,
    incorrectAnswers: incorrect,
    totalQuestions: questions.length,
    userAnswers,
    questions: questionsSnap,
    dateTime: new Date().toISOString(),
  };
}

async function saveAttemptFirebase(uid, payload) {
  const attemptData = {
    userId: uid,
    userName: payload.userName,
    testId: payload.testId,
    testName: payload.testName,
    timestamp: new Date().toISOString(),
    dateTime: payload.dateTime,
    timeSpent: payload.timeSpent,
    correctAnswers: payload.correctAnswers,
    incorrectAnswers: payload.incorrectAnswers,
    totalQuestions: payload.totalQuestions,
    percentage: Math.round((payload.correctAnswers / Math.max(1, payload.totalQuestions)) * 1000) / 10,
    userAnswers: payload.userAnswers,
    questions: payload.questions,
  };
  const userRef = ref(db, `users/${uid}/attempts`);
  await push(userRef, attemptData);
  const lbRef = ref(db, 'leaderboardAttempts');
  await push(lbRef, {
    userId: uid,
    userName: payload.userName,
    testName: payload.testName,
    timestamp: attemptData.timestamp,
    correctAnswers: payload.correctAnswers,
    incorrectAnswers: payload.incorrectAnswers,
    totalQuestions: payload.totalQuestions,
    timeSpent: payload.timeSpent,
  });
}

async function loadUserAttempts(uid) {
  const snap = await get(ref(db, `users/${uid}/attempts`));
  const val = snap.val();
  if (!val || typeof val !== 'object') return [];
  return Object.entries(val)
    .map(([key, a]) => ({ id: key, ...a }))
    .sort((x, y) => String(y.timestamp || '').localeCompare(String(x.timestamp || '')));
}

function normalizeNickname(raw) {
  if (!raw || !String(raw).trim()) return null;
  const t = String(raw).trim();
  if (t.includes('@')) {
    const p = t.split('@')[0];
    if (p && p.trim()) return p.trim();
  }
  return t;
}

function roundToOneDecimal(value) {
  return Math.round(value * 10) / 10;
}

function parseAttemptTimestamp(raw) {
  if (raw == null) return 0;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const s = String(raw).trim();
  if (!s) return 0;
  if (/^\d+$/.test(s)) return Number(s);
  const ts = Date.parse(s);
  return Number.isNaN(ts) ? 0 : ts;
}

const CHART_DAYS_WEB = 30;

function localYmdFromMs(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getAttemptDayKey(attempt) {
  const raw = attempt.timestamp ?? attempt.dateTime;
  if (raw == null) return null;
  let t;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    t = raw < 1e12 ? raw * 1000 : raw;
  } else {
    t = Date.parse(String(raw));
  }
  if (Number.isNaN(t)) return null;
  return localYmdFromMs(t);
}

function buildDateWindow(days) {
  const out = [];
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const ymd = localYmdFromMs(d.getTime());
    const label = `${d.getDate()}.${String(d.getMonth() + 1).padStart(2, '0')}`;
    const title = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
    out.push({ ymd, label, title });
  }
  return out;
}

function avgToneClass(avg) {
  if (avg >= 70) return 'tone-ok';
  if (avg >= 50) return 'tone-mid';
  return 'tone-low';
}

function pluralRu(n, one, few, many) {
  n = Math.abs(n) % 100;
  const n1 = n % 10;
  if (n >= 11 && n <= 14) return many;
  if (n1 === 1) return one;
  if (n1 >= 2 && n1 <= 4) return few;
  return many;
}

async function loadLeaderboard(limit = 50) {
  const attemptsWindow = Math.max(limit * 20, 500);
  const qy = query(ref(db, 'leaderboardAttempts'), orderByKey(), limitToLast(attemptsWindow));
  const snap = await get(qy);
  const val = snap.val();
  const byUser = new Map();
  if (val && typeof val === 'object') {
    for (const attempt of Object.values(val)) {
      if (!attempt?.userId) continue;
      let e = byUser.get(attempt.userId);
      if (!e) {
        e = {
          userId: attempt.userId,
          userName: normalizeNickname(attempt.userName) || 'Пользователь',
          attempts: 0,
          totalCorrect: 0,
          totalQuestions: 0,
          totalTimeSeconds: 0,
          bestPercent: 0,
          lastAttemptAt: 0,
        };
        byUser.set(attempt.userId, e);
      }
      const name = normalizeNickname(attempt.userName);
      if (name) e.userName = name;
      const correct = Number(attempt.correctAnswers) || 0;
      const total = Math.max(1, Number(attempt.totalQuestions) || 1);
      const time = Number(attempt.timeSpent) || 0;
      const percent = Math.round((correct / total) * 100);
      const attemptTs = parseAttemptTimestamp(attempt.timestamp);
      e.attempts++;
      e.totalCorrect += correct;
      e.totalQuestions += total;
      e.totalTimeSeconds += time;
      if (percent > e.bestPercent) e.bestPercent = percent;
      if (attemptTs > e.lastAttemptAt) e.lastAttemptAt = attemptTs;
    }
  }
  let profiles = {};
  try {
    const ps = await get(ref(db, 'publicProfiles'));
    profiles = ps.val() || {};
  } catch {
    /* ignore */
  }
  for (const [uid, profile] of Object.entries(profiles)) {
    const e = byUser.get(uid);
    const dn = profile?.displayName;
    if (e && dn && String(dn).trim()) e.userName = normalizeNickname(dn) || e.userName;
  }
  const list = [];
  for (const e of byUser.values()) {
    if (e.attempts > 0 && e.totalQuestions > 0) {
      e.averagePercent = roundToOneDecimal((e.totalCorrect / e.totalQuestions) * 100);
      list.push(e);
    }
  }
  list.sort((a, b) => {
    if (b.averagePercent !== a.averagePercent) return b.averagePercent - a.averagePercent;
    if (b.bestPercent !== a.bestPercent) return b.bestPercent - a.bestPercent;
    if (b.attempts !== a.attempts) return b.attempts - a.attempts;
    return b.lastAttemptAt - a.lastAttemptAt;
  });
  return limit > 0 ? list.slice(0, limit) : list;
}

function renderAuth() {
  const root = el(`
    <div class="layout">
      <div class="hero">
        <h1>Lycoris</h1>
        <p class="sub">Проверь свои знания</p>
        <div class="emoji" aria-hidden="true">🌸</div>
      </div>
      <div class="card" style="max-width:400px;margin:0 auto;">
        <h2 id="auth-title" style="margin:0 0 0.75rem;">Вход</h2>
        <p class="muted" id="auth-sub" style="margin:0 0 1rem;">Войдите в аккаунт, чтобы продолжить</p>
        <div class="segmented" id="auth-seg">
          <button type="button" class="active" data-mode="in">Вход</button>
          <button type="button" data-mode="up">Регистрация</button>
        </div>
        <p class="error" id="auth-err" hidden></p>
        <form id="auth-form">
          <div class="field">
            <label for="em">Email</label>
            <input id="em" name="email" type="email" autocomplete="email" required />
          </div>
          <div class="field">
            <label for="pw">Пароль</label>
            <input id="pw" name="password" type="password" autocomplete="current-password" required minlength="6" />
          </div>
          <button type="submit" class="btn btn-primary" id="auth-submit" style="width:100%;min-width:auto;">Войти</button>
        </form>
      </div>
      <p class="footer-note">Веб-версия Lycoris · GitHub Pages</p>
    </div>
  `);
  let mode = 'in';
  const seg = root.querySelector('#auth-seg');
  const err = root.querySelector('#auth-err');
  const form = root.querySelector('#auth-form');
  const authTitle = root.querySelector('#auth-title');
  const authSub = root.querySelector('#auth-sub');
  const authSubmit = root.querySelector('#auth-submit');

  function syncAuthUi() {
    if (mode === 'in') {
      authTitle.textContent = 'Вход';
      authSub.textContent = 'Войдите в аккаунт, чтобы продолжить';
      authSubmit.textContent = 'Войти';
    } else {
      authTitle.textContent = 'Регистрация';
      authSub.textContent = 'Создайте аккаунт для доступа к тестам';
      authSubmit.textContent = 'Зарегистрироваться';
    }
  }
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (!b) return;
    mode = b.dataset.mode;
    seg.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    syncAuthUi();
  });
  syncAuthUi();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    const fd = new FormData(form);
    const email = String(fd.get('email') || '').trim();
    const password = String(fd.get('password') || '');
    try {
      if (mode === 'in') {
        await signInWithEmailAndPassword(auth, email, password);
      } else {
        const cred = await createUserWithEmailAndPassword(auth, email, password);
        await updateProfile(cred.user, { displayName: email.split('@')[0] });
      }
      setHash(ROUTE_MENU);
    } catch (ex) {
      err.textContent = authErrorRu(ex);
      err.hidden = false;
    }
  });
  return root;
}

function renderMenu() {
  const dn = state.displayName || '…';
  const root = el(`
    <div class="layout">
      <div class="top-bar">
        <button type="button" class="icon-btn" title="Статистика" id="to-profile">📊</button>
        <button type="button" class="icon-btn" title="Настройки" id="to-settings">⚙️</button>
      </div>
      <div class="hero">
        <h1>Lycoris</h1>
        <p class="sub">Проверь свои знания</p>
        <p class="muted">Вы вошли как <strong>${escapeHtml(dn)}</strong></p>
        <div class="emoji" aria-hidden="true">🌸</div>
      </div>
      <div class="stack">
        <button type="button" class="btn btn-primary" id="go-tests">Выбор теста</button>
        <button type="button" class="btn btn-secondary" id="go-create">Создать тест</button>
        <button type="button" class="btn btn-secondary" id="go-history">История попыток</button>
        <button type="button" class="btn btn-ghost" id="logout">Выйти</button>
      </div>
    </div>
  `);
  root.querySelector('#go-tests').onclick = () => setHash(ROUTE_TEST_SELECTION);
  root.querySelector('#go-create').onclick = () => setHash(ROUTE_TEST_EDITOR);
  root.querySelector('#go-history').onclick = () => setHash(ROUTE_ATTEMPT_HISTORY);
  root.querySelector('#to-profile').onclick = () => setHash(ROUTE_PROFILE);
  root.querySelector('#to-settings').onclick = () => setHash(ROUTE_SETTINGS);
  root.querySelector('#logout').onclick = async () => {
    await signOut(auth);
    setHash(ROUTE_AUTH);
  };
  return root;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function renderTests() {
  const source = getTestSource();
  const wrap = el(`<div class="layout"></div>`);
  wrap.appendChild(
    el(`
    <div class="top-bar" style="justify-content:space-between;">
      <button type="button" class="btn btn-secondary" style="min-width:auto;padding:0.5rem 1rem;" id="back-menu">← Меню</button>
    </div>
  `),
  );
  wrap.querySelector('#back-menu').onclick = () => setHash(ROUTE_MENU);

  const card = el(`
    <div class="card">
      <h2>Выбор теста</h2>
      <div class="segmented" id="src-seg">
        <button type="button" class="${source === 'github' ? 'active' : ''}" data-src="github">GitHub</button>
        <button type="button" class="${source === 'local' ? 'active' : ''}" data-src="local">Локальные</button>
      </div>
      <p class="muted" id="src-hint"></p>
      <div id="import-wrap" hidden style="margin-bottom:1rem;">
        <label class="btn btn-secondary" style="display:inline-block;cursor:pointer;">
          Импортировать тест
          <input type="file" id="import-files" accept=".json,.lypkg,application/json" multiple hidden />
        </label>
      </div>
      <div id="tests-loading" class="loading">Загрузка…</div>
      <div id="tests-grid" class="test-grid" hidden></div>
      <p class="error" id="tests-err" hidden></p>
    </div>
  `);
  wrap.appendChild(card);

  const seg = card.querySelector('#src-seg');
  const hint = card.querySelector('#src-hint');
  const importWrap = card.querySelector('#import-wrap');
  const importInput = card.querySelector('#import-files');
  const loading = card.querySelector('#tests-loading');
  const grid = card.querySelector('#tests-grid');
  const errEl = card.querySelector('#tests-err');

  function updateHints(src) {
    if (src === 'github') {
      hint.textContent = 'Тесты загружаются с GitHub Pages (как в десктопном приложении).';
      importWrap.hidden = true;
    } else {
      hint.textContent =
        'Локальные тесты хранятся в браузере (IndexedDB). Поддерживаются картинки через URL, data:image и asset: ключи.';
      importWrap.hidden = false;
    }
  }

  updateHints(source);

  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-src]');
    if (!b) return;
    const src = b.dataset.src;
    localStorage.setItem(LS_SOURCE, src);
    seg.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    updateHints(src);
    loadList();
  });

  importInput.addEventListener('change', async () => {
    const files = importInput.files;
    if (!files?.length) return;
    let ok = 0;
    let bad = 0;
    for (const file of files) {
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        const json = parsed?.format === 'lycoris-test-package' && parsed?.test ? parsed.test : parsed;
        if (!Array.isArray(json?.questions) || !json.questions.length) {
          bad++;
          continue;
        }
        let name = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
        name = name.replace(/\.lypkg$/i, '');
        if (!name.toLowerCase().endsWith('.json')) name += '.json';
        await saveLocalTest(name, json);
        ok++;
      } catch {
        bad++;
      }
    }
    importInput.value = '';
    showToast(`Импорт: ${ok} ок, пропущено ${bad}`);
    if (getTestSource() === 'local') loadList();
  });

  async function loadList() {
    loading.hidden = false;
    grid.hidden = true;
    errEl.hidden = true;
    grid.innerHTML = '';
    try {
      const src = getTestSource();
      const tests = src === 'github' ? await fetchRemoteTestList() : await listLocalTestsMeta();
      loading.hidden = true;
      grid.hidden = false;
      if (!tests.length) {
        grid.innerHTML = `<p class="muted">Нет доступных тестов.</p>`;
        return;
      }
      for (const t of tests) {
        if (src === 'local') {
          const cardEl = el(`
            <div class="test-card">
              <h3>${escapeHtml(t.name)}</h3>
              <p>${escapeHtml(t.description || '')}</p>
              <div class="badge-row">
                <span class="badge">${t.questionCount || '?'} вопр.</span>
                <span class="badge">${escapeHtml(t.difficulty || '')}</span>
                <span class="badge">${escapeHtml(t.estimatedTime || '')}</span>
              </div>
              <div class="row-actions" style="margin-top:0.75rem;justify-content:flex-start;">
                <button type="button" class="btn btn-primary run-local" style="min-width:auto;">Запустить</button>
                <button type="button" class="btn btn-secondary export-local" style="min-width:auto;">Экспорт LYPKG</button>
              </div>
            </div>
          `);
          cardEl.querySelector('.run-local').onclick = () => setHash(`run/${src}/${encodeURIComponent(t.fileName)}`);
          cardEl.querySelector('.export-local').onclick = async () => {
            try {
              const test = await getLocalTestJson(t.fileName);
              if (!test) throw new Error('Тест не найден');
              const pkg = {
                format: 'lycoris-test-package',
                version: 1,
                test,
              };
              downloadTextFile(`${t.fileName.replace(/\.json$/i, '')}.lypkg`, JSON.stringify(pkg, null, 2), 'application/json');
              showToast('Пакет экспортирован');
            } catch (e) {
              showToast(`Ошибка экспорта: ${e.message || e}`);
            }
          };
          grid.appendChild(cardEl);
        } else {
          const btn = el(`
            <button type="button" class="test-card" data-file="${escapeHtml(t.fileName)}" data-src="${src}">
              <h3>${escapeHtml(t.name)}</h3>
              <p>${escapeHtml(t.description || '')}</p>
              <div class="badge-row">
                <span class="badge">${t.questionCount || '?'} вопр.</span>
                <span class="badge">${escapeHtml(t.difficulty || '')}</span>
                <span class="badge">${escapeHtml(t.estimatedTime || '')}</span>
              </div>
            </button>
          `);
          btn.onclick = () => setHash(`run/${src}/${encodeURIComponent(t.fileName)}`);
          grid.appendChild(btn);
        }
      }
    } catch (e) {
      loading.hidden = true;
      errEl.textContent = e.message || String(e);
      errEl.hidden = false;
    }
  }

  loadList();
  return wrap;
}

function downloadTextFile(filename, content, mime = 'text/plain') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function renderRun(segments) {
  const source = segments[1];
  const fileName = decodeURIComponent(segments[2] || '');
  if (!fileName || (source !== 'github' && source !== 'local')) {
    setHash(ROUTE_TEST_SELECTION);
    return el('<div></div>');
  }

  clearTestTimer();
  state.testRun = null;

  const wrap = el(`<div class="layout"></div>`);
  wrap.appendChild(
    el(`
    <div class="top-bar" style="justify-content:space-between;flex-wrap:wrap;">
      <button type="button" class="btn btn-secondary" style="min-width:auto;padding:0.5rem 1rem;" id="abort">☰ Выход</button>
      <span class="timer-pill" id="timer">00:00</span>
    </div>
  `),
  );

  const body = el(`
    <div class="card" id="run-card">
      <div class="loading" id="run-load">Загрузка теста…</div>
      <div id="run-ui" hidden></div>
    </div>
  `);
  wrap.appendChild(body);

  try {
    const raw = await loadTestJson(source, fileName);
    let questions = parseQuestionsFromJson(raw);
    if (!questions.length) throw new Error('В файле нет валидных вопросов');
    if (isShuffleOn()) questions = shuffleArray(questions);

    const meta = {
      id: raw.id || fileName.replace(/\.json$/i, ''),
      name: raw.name || fileName.replace(/\.json$/i, ''),
      fileName,
    };
    const userName = state.displayName || state.user?.email?.split('@')[0] || 'Гость';
    const pending = readPendingRun();
    const canResume = !!pending
      && pending.source === source
      && pending.fileName === fileName
      && Array.isArray(pending.questions)
      && pending.questions.length > 0;
    const runState = canResume
      ? {
          questions: pending.questions,
          index: Math.max(0, Math.min(Number(pending.index) || 0, pending.questions.length - 1)),
          seconds: Math.max(0, Number(pending.seconds) || 0),
          answersByIndex: Array.isArray(pending.answersByIndex) ? pending.answersByIndex : [],
          checked: Array.isArray(pending.checked)
            ? pending.checked
            : pending.questions.map((_, idx) => !!(pending.answersByIndex && pending.answersByIndex[idx])),
          meta: pending.meta || meta,
          source,
          fileName,
          userName: pending.userName || userName,
          selectedOption: null,
        }
      : {
          questions,
          index: 0,
          seconds: 0,
          answersByIndex: [],
          checked: [],
          meta,
          source,
          fileName,
          userName,
          selectedOption: null,
        };
    if (canResume) {
      showToast('Восстановлен незавершенный тест');
    }
    state.testRun = runState;

    const loadEl = body.querySelector('#run-load');
    const ui = body.querySelector('#run-ui');
    loadEl.hidden = true;
    ui.hidden = false;

    const timerEl = wrap.querySelector('#timer');
    const m0 = Math.floor(runState.seconds / 60);
    const s0 = runState.seconds % 60;
    timerEl.textContent = `${String(m0).padStart(2, '0')}:${String(s0).padStart(2, '0')}`;

    wrap.querySelector('#abort').onclick = () => {
      const dlg = el(`
        <div class="run-exit-overlay">
          <div class="run-exit-dialog card">
            <h3>Завершение теста</h3>
            <p class="muted">Выберите действие для текущего прогресса.</p>
            <div class="row-actions">
              <button type="button" class="btn btn-secondary" style="min-width:auto;" data-act="cancel">Отмена</button>
              <button type="button" class="btn btn-secondary" style="min-width:auto;" data-act="later">Продолжить потом</button>
              <button type="button" class="btn btn-primary" style="min-width:auto;" data-act="finish">Завершить</button>
            </div>
          </div>
        </div>
      `);
      const close = () => dlg.remove();
      dlg.addEventListener('click', (e) => {
        if (e.target === dlg) close();
      });
      dlg.querySelector('[data-act="cancel"]').onclick = close;
      dlg.querySelector('[data-act="later"]').onclick = () => {
        writePendingRun(runState);
        clearTestTimer();
        state.testRun = null;
        close();
        showToast('Прогресс сохранен. Вернетесь позже.');
        setHash(ROUTE_MENU);
      };
      dlg.querySelector('[data-act="finish"]').onclick = () => {
        close();
        finish();
      };
      wrap.appendChild(dlg);
    };
    state.timerId = setInterval(() => {
      runState.seconds++;
      const m = Math.floor(runState.seconds / 60);
      const s = runState.seconds % 60;
      timerEl.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }, 1000);

    function renderQuestion() {
      const i = runState.index;
      const q = runState.questions[i];
      const n = runState.questions.length;
      const answered = !!runState.checked[i];
      const pct = (i / n) * 100;
      ui.innerHTML = `
        <h2 style="margin:0 0 0.5rem;font-size:1.1rem;color:var(--primary-medium);">${escapeHtml(meta.name)}</h2>
        <p class="muted" style="margin:0 0 0.5rem;">👤 ${escapeHtml(userName)}</p>
        <div class="progress-wrap">
          <p style="margin:0 0 0.35rem;font-size:0.9rem;">Вопрос ${i + 1} / ${n}</p>
          <div class="progress-bar"><div style="width:${pct}%"></div></div>
        </div>
        <p style="font-size:1.15rem;font-weight:600;margin:1rem 0;">${escapeHtml(q.question)}</p>
        ${q.image ? `<img class="question-image" src="${escapeHtml(q.image)}" alt="Изображение к вопросу" loading="lazy" />` : ''}
        <div class="options" id="opts"></div>
        <div class="row-actions">
          <button type="button" class="btn btn-secondary" style="min-width:120px;" id="prev" ${i === 0 ? 'disabled' : ''}>← Назад</button>
          <button type="button" class="btn btn-primary" id="action">${answered ? (i === n - 1 ? '✓ Завершить' : '✓ Далее') : '✓ Проверить'}</button>
          <button type="button" class="btn btn-secondary" style="min-width:120px;" id="next" ${i >= n - 1 ? 'disabled' : ''}>Вперёд →</button>
        </div>
      `;
      const opts = ui.querySelector('#opts');
      q.options.forEach((text, oi) => {
        const right = oi === q.correctAnswer;
        const saved = runState.answersByIndex[i];
        const row = el(`
          <label class="option ${answered && saved === text ? 'selected' : ''}">
            <input type="radio" name="o" value="${oi}" ${answered ? 'disabled' : ''} />
            <span>${escapeHtml(text)}</span>
          </label>
        `);
        if (answered) {
          const st = row.style;
          if (right) {
            st.borderColor = '#28a745';
            st.background = '#d4edda';
          } else if (saved === text) {
            st.borderColor = '#dc3545';
            st.background = '#f8d7da';
          }
        }
        row.querySelector('input').addEventListener('change', () => {
          runState.selectedOption = text;
        });
        opts.appendChild(row);
      });
      if (!answered && runState.answersByIndex[i]) {
        const savedText = runState.answersByIndex[i];
        opts.querySelectorAll('input').forEach((inp) => {
          const lab = inp.closest('label');
          const span = lab?.querySelector('span')?.textContent;
          if (span === savedText) inp.checked = true;
        });
      }
      ui.querySelector('#prev').onclick = () => {
        if (runState.index > 0) {
          runState.index--;
          renderQuestion();
        }
      };
      ui.querySelector('#next').onclick = () => {
        if (runState.index < n - 1) {
          runState.index++;
          renderQuestion();
        }
      };
      ui.querySelector('#action').onclick = () => {
        if (!answered) {
          const sel = ui.querySelector('input[name="o"]:checked');
          if (!sel) {
            showToast('Пожалуйста, выберите хотя бы один вариант ответа');
            return;
          }
          const text = q.options[Number(sel.value)];
          runState.answersByIndex[i] = text;
          runState.checked[i] = true;
          renderQuestion();
          return;
        }
        if (i < n - 1) {
          runState.index++;
          renderQuestion();
        } else {
          finish();
        }
      };
    }

    function finish() {
      clearTestTimer();
      clearPendingRun();
      const payload = buildAttemptPayload(
        {
          questions: runState.questions,
          seconds: runState.seconds,
          answersByIndex: runState.answersByIndex,
          userName: runState.userName,
          testName: meta.name,
          testId: meta.id,
        },
        meta,
      );
      const localRecord = {
        localId: `l-${Date.now()}`,
        at: payload.dateTime,
        payload,
      };
      pushLocalAttempt(localRecord);
      if (state.user) {
        saveAttemptFirebase(state.user.uid, payload).catch((e) => {
          console.warn(e);
          showToast('Не удалось сохранить в Firebase (проверьте сеть и правила БД)');
        });
      }
      state.testRun = null;
      setHash(`result/local/${localRecord.localId}`);
    }

    if (!Array.isArray(runState.checked) || runState.checked.length !== runState.questions.length) {
      runState.checked = runState.questions.map((_, idx) => !!runState.answersByIndex[idx]);
    }
    renderQuestion();
  } catch (e) {
    body.querySelector('#run-load').innerHTML = `<p class="error">${escapeHtml(e.message || String(e))}</p>`;
  }

  return wrap;
}

function renderResult(segments) {
  const scope = segments[1];
  const id = segments[2];
  const attempts = readLocalAttempts();
  let payload = null;
  if (scope === 'local') {
    const r = attempts.find((x) => x.localId === id);
    payload = r?.payload || null;
  }
  if (!payload) {
    const w = el(`<div class="layout"><p class="card">Запись не найдена.</p>
      <button class="btn btn-primary" id="bk">В меню</button></div>`);
    w.querySelector('#bk').onclick = () => setHash(ROUTE_MENU);
    return w;
  }
  const pct = Math.round((payload.correctAnswers / Math.max(1, payload.totalQuestions)) * 100);
  const root = el(`
    <div class="layout">
      <div class="card">
        <h2>Результат: ${escapeHtml(payload.testName)}</h2>
        <p><strong>${payload.correctAnswers}</strong> верно из <strong>${payload.totalQuestions}</strong> (${pct}%)</p>
        <p class="muted">Время: ${formatDuration(payload.timeSpent)}</p>
        <div class="row-actions">
          <button type="button" class="btn btn-secondary" id="to-tests">К тестам</button>
          <button type="button" class="btn btn-primary" id="review">Разбор ответов</button>
        </div>
      </div>
    </div>
  `);
  root.querySelector('#to-tests').onclick = () => setHash(ROUTE_TEST_SELECTION);
  root.querySelector('#review').onclick = () => setHash(`${ROUTE_ATTEMPT}/local/${id}`);
  return root;
}

function formatDuration(sec) {
  const s = Number(sec) || 0;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

async function renderHistory() {
  const wrap = el(`<div class="layout"></div>`);
  wrap.appendChild(
    el(`
    <div class="top-bar" style="justify-content:space-between;">
      <button type="button" class="btn btn-secondary" style="min-width:auto;" id="bk">← Меню</button>
    </div>
  `),
  );
  wrap.querySelector('#bk').onclick = () => setHash(ROUTE_MENU);

  const card = el(`
    <div class="card">
      <h2>История попыток</h2>
      <p class="muted" id="hist-src"></p>
      <div class="segmented segmented--tabs" id="hist-tabs">
        <button type="button" class="active" data-tab="all">Общая</button>
        <button type="button" data-tab="tests">По тестам</button>
      </div>
      <div id="hist-list"></div>
    </div>
  `);
  wrap.appendChild(card);

  const listEl = card.querySelector('#hist-list');
  const srcEl = card.querySelector('#hist-src');
  const tabsEl = card.querySelector('#hist-tabs');

  const local = readLocalAttempts();
  let remote = [];
  if (state.user) {
    try {
      remote = await loadUserAttempts(state.user.uid);
      srcEl.textContent = 'Источник: Firebase + локальные попытки';
    } catch {
      srcEl.textContent = 'Источник: локальные попытки (ошибка Firebase)';
    }
  } else {
    srcEl.textContent = 'Источник: локальные попытки';
  }

  const merged = [];
  for (const a of remote) {
    merged.push({
      kind: 'fb',
      id: a.id,
      at: a.timestamp,
      title: a.testName || 'Тест',
      correct: Number(a.correctAnswers) || 0,
      total: Number(a.totalQuestions) || 0,
      timeSpent: Number(a.timeSpent) || 0,
    });
  }
  for (const a of local) {
    merged.push({
      kind: 'local',
      id: a.localId,
      at: a.at,
      title: a.payload?.testName || 'Тест',
      correct: Number(a.payload?.correctAnswers) || 0,
      total: Number(a.payload?.totalQuestions) || 0,
      timeSpent: Number(a.payload?.timeSpent) || 0,
    });
  }
  merged.sort((x, y) => String(y.at || '').localeCompare(String(x.at || '')));

  function renderAttempts(items, options = {}) {
    const onlyToday = !!options.onlyToday;
    const target = onlyToday
      ? items.filter((x) => {
          const ts = parseAttemptTimestamp(x.at);
          if (!ts) return false;
          const d = new Date(ts);
          const now = new Date();
          return d.getFullYear() === now.getFullYear()
            && d.getMonth() === now.getMonth()
            && d.getDate() === now.getDate();
        })
      : items;

    if (!target.length) {
      return `<p class="muted">Пока нет попыток для выбранного фильтра.</p>`;
    }
    const totalAttempts = target.length;
    const averagePercent = roundToOneDecimal(
      target.reduce((sum, item) => sum + ((item.correct / Math.max(1, item.total)) * 100), 0) / totalAttempts,
    );
    const bestPercent = roundToOneDecimal(
      target.reduce((best, item) => Math.max(best, (item.correct / Math.max(1, item.total)) * 100), 0),
    );
    let attemptsHtml = '';
    for (const item of target) {
      const percent = roundToOneDecimal((item.correct / Math.max(1, item.total)) * 100);
      attemptsHtml += `
        <button type="button" class="card history-item" style="margin-top:0.75rem;" data-kind="${item.kind}" data-id="${escapeHtml(item.id)}">
          <div class="row">
            <h3>${escapeHtml(item.title)}</h3>
            <span class="badge">${item.correct}/${item.total} · ${percent}%</span>
          </div>
          <p class="muted" style="margin:0.35rem 0 0;">Время: ${formatDuration(item.timeSpent)} · ${escapeHtml(item.at || '')}</p>
        </button>`;
    }
    return `
      <div class="segmented" style="margin-top:0.25rem;margin-bottom:0.5rem;" id="hist-filter">
        <button type="button" data-filter="today" ${onlyToday ? 'class="active"' : ''}>Сегодняшний день</button>
        <button type="button" data-filter="all" ${onlyToday ? '' : 'class="active"'}>Вся история</button>
      </div>
      <div class="row" style="gap:0.75rem;flex-wrap:wrap;margin-bottom:0.75rem;">
        <div class="card" style="padding:0.75rem 1rem;min-width:110px;">
          <p class="muted" style="margin:0;">Попыток</p>
          <p style="margin:0.2rem 0 0;font-weight:700;">${totalAttempts}</p>
        </div>
        <div class="card" style="padding:0.75rem 1rem;min-width:110px;">
          <p class="muted" style="margin:0;">Средний</p>
          <p style="margin:0.2rem 0 0;font-weight:700;">${averagePercent}%</p>
        </div>
        <div class="card" style="padding:0.75rem 1rem;min-width:110px;">
          <p class="muted" style="margin:0;">Лучший</p>
          <p style="margin:0.2rem 0 0;font-weight:700;">${bestPercent}%</p>
        </div>
      </div>
      ${attemptsHtml}
    `;
  }

  function renderByTests(items) {
    const grouped = new Map();
    for (const it of items) {
      if (!grouped.has(it.title)) grouped.set(it.title, []);
      grouped.get(it.title).push(it);
    }
    if (!grouped.size) return '<p class="muted">Пока нет завершенных попыток.</p>';
    const cards = [];
    for (const [testName, arr] of grouped.entries()) {
      const avg = roundToOneDecimal(arr.reduce((s, x) => s + ((x.correct / Math.max(1, x.total)) * 100), 0) / arr.length);
      const best = roundToOneDecimal(arr.reduce((b, x) => Math.max(b, (x.correct / Math.max(1, x.total)) * 100), 0));
      cards.push(`
        <button type="button" class="card history-item" style="margin:0;min-width:240px;" data-test="${escapeHtml(testName)}">
          <div class="row"><h3>${escapeHtml(testName)}</h3><span class="badge">${arr.length} попыт.</span></div>
          <p class="muted" style="margin:0.35rem 0 0;">Средний: ${avg}% · Лучший: ${best}%</p>
        </button>`);
    }
    return `
      <div class="row" style="gap:0.75rem;flex-wrap:wrap;" id="hist-tests-grid">${cards.join('')}</div>
      <div id="hist-test-details" class="card" style="margin-top:0.9rem;">
        <p class="muted">Выберите карточку теста, чтобы открыть историю именно по нему и график результатов.</p>
      </div>`;
  }

  function renderTestDetails(testName) {
    const arr = merged.filter((x) => x.title === testName).slice().sort((a, b) => parseAttemptTimestamp(a.at) - parseAttemptTimestamp(b.at));
    if (!arr.length) return;
    const detailEl = listEl.querySelector('#hist-test-details');
    if (!detailEl) return;
    const avg = roundToOneDecimal(arr.reduce((s, x) => s + ((x.correct / Math.max(1, x.total)) * 100), 0) / arr.length);
    const best = roundToOneDecimal(arr.reduce((b, x) => Math.max(b, (x.correct / Math.max(1, x.total)) * 100), 0));
    const maxPct = Math.max(1, ...arr.map((x) => roundToOneDecimal((x.correct / Math.max(1, x.total)) * 100)));
    const barsHeight = arr.length > 30 ? 320 : (arr.length > 16 ? 280 : 240);
    let bars = '';
    let rows = '';
    arr.forEach((x, i) => {
      const pct = roundToOneDecimal((x.correct / Math.max(1, x.total)) * 100);
      const h = Math.max(2, Math.round((pct / maxPct) * 100));
      bars += `<div class="activity-col" title="${escapeHtml(String(x.at || ''))} · ${pct}%"><div class="bar" style="height:${h}%"></div><span class="lbl">${i + 1}</span></div>`;
      rows += `<button type="button" class="card history-item" style="margin-top:0.5rem;" data-kind="${x.kind}" data-id="${escapeHtml(x.id)}">
        <div class="row"><h3>${escapeHtml(x.title)}</h3><span class="badge">${x.correct}/${x.total} · ${pct}%</span></div>
        <p class="muted" style="margin:0.35rem 0 0;">Время: ${formatDuration(x.timeSpent)} · ${escapeHtml(x.at || '')}</p>
      </button>`;
    });
    detailEl.innerHTML = `
      <h3 style="margin:0 0 0.6rem;">${escapeHtml(testName)}</h3>
      <p class="muted" style="margin:0 0 0.6rem;">Попыток: ${arr.length} · Средний: ${avg}% · Лучший: ${best}%</p>
      <p class="activity-title">График результата по попыткам</p>
      <div class="activity-bars" style="height:${barsHeight}px;">${bars}</div>
      <p class="activity-footnote">Ось X — номер попытки, ось Y — процент результата.</p>
      ${rows}
    `;
  }

  function bindHistoryClicks() {
    listEl.querySelectorAll('.history-item[data-kind][data-id]').forEach((b) => {
      b.onclick = () => setHash(`${ROUTE_ATTEMPT}/${b.dataset.kind}/${b.dataset.id}`);
    });
    const filterWrap = listEl.querySelector('#hist-filter');
    if (filterWrap) {
      filterWrap.onclick = (e) => {
        const btn = e.target.closest('button[data-filter]');
        if (!btn) return;
        const onlyToday = btn.dataset.filter === 'today';
        listEl.innerHTML = renderAttempts(merged, { onlyToday });
        bindHistoryClicks();
      };
    }
    listEl.querySelectorAll('#hist-tests-grid .history-item[data-test]').forEach((b) => {
      b.onclick = () => {
        renderTestDetails(b.dataset.test);
        bindHistoryClicks();
      };
    });
  }

  let tab = 'all';
  function renderTab() {
    if (tab === 'tests') listEl.innerHTML = renderByTests(merged);
    else listEl.innerHTML = renderAttempts(merged, { onlyToday: false });
    bindHistoryClicks();
  }
  tabsEl.onclick = (e) => {
    const btn = e.target.closest('button[data-tab]');
    if (!btn) return;
    tab = btn.dataset.tab;
    tabsEl.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === btn));
    renderTab();
  };
  renderTab();
  return wrap;
}

async function renderAttempt(segments) {
  const scope = segments[1];
  const id = segments[2];
  const wrap = el(`<div class="layout"></div>`);
  wrap.appendChild(
    el(`
    <div class="top-bar">
      <button type="button" class="btn btn-secondary" style="min-width:auto;" id="bk">← История</button>
    </div>
  `),
  );
  wrap.querySelector('#bk').onclick = () => setHash(ROUTE_ATTEMPT_HISTORY);

  let payload = null;
  if (scope === 'local') {
    const r = readLocalAttempts().find((x) => x.localId === id);
    payload = r?.payload;
  } else if (scope === 'fb' && state.user) {
    const attempts = await loadUserAttempts(state.user.uid);
    const a = attempts.find((x) => x.id === id);
    if (a) {
      payload = {
        testName: a.testName,
        correctAnswers: a.correctAnswers,
        incorrectAnswers: a.incorrectAnswers,
        totalQuestions: a.totalQuestions,
        userAnswers: a.userAnswers || [],
        questions: a.questions || [],
        timeSpent: a.timeSpent,
      };
    }
  }

  if (!payload) {
    wrap.appendChild(el('<p class="card">Не удалось загрузить попытку.</p>'));
    return wrap;
  }

  const box = el('<div class="card"></div>');
  const pct = roundToOneDecimal((Number(payload.correctAnswers) / Math.max(1, Number(payload.totalQuestions))) * 100);
  box.innerHTML = `<h2>${escapeHtml(payload.testName)}</h2>
    <p class="muted">Верно: ${payload.correctAnswers} · Неверно: ${payload.incorrectAnswers} · Точность: ${pct}% · Время: ${formatDuration(payload.timeSpent)}</p>`;

  const qs = payload.questions || [];
  const ans = payload.userAnswers || [];
  for (let i = 0; i < qs.length; i++) {
    const q = qs[i];
    const userAns = ans[i] || '';
    const rightIdx = q.correctAnswer;
    const rightText = Array.isArray(q.options) && q.options[rightIdx] != null ? q.options[rightIdx] : '';
    const ok = userAns === rightText;
    const card = el(`
      <div class="card" style="margin-top:1rem;">
        <p style="font-weight:600;margin:0 0 0.5rem;">${i + 1}. ${escapeHtml(q.question || '')}</p>
        ${q.image ? `<img class="question-image" src="${escapeHtml(q.image)}" alt="Изображение к вопросу" loading="lazy" />` : ''}
        <p class="muted" style="margin:0;">Ваш ответ: <strong style="color:var(--primary-dark);">${escapeHtml(userAns || '—')}</strong></p>
        ${ok ? '<p style="margin:0.5rem 0 0;color:#28a745;font-weight:600;">Верно</p>' : `<p style="margin:0.5rem 0 0;color:#c0392b;">Правильный ответ: <strong>${escapeHtml(rightText)}</strong></p>`}
      </div>
    `);
    box.appendChild(card);
  }
  wrap.appendChild(box);
  return wrap;
}

async function renderProfile() {
  const wrap = el(`<div class="layout"></div>`);
  wrap.appendChild(
    el(`
    <div class="top-bar" style="justify-content:space-between;">
      <button type="button" class="btn btn-secondary" style="min-width:auto;" id="bk">← Меню</button>
    </div>
  `),
  );
  wrap.querySelector('#bk').onclick = () => setHash(ROUTE_MENU);

  const card = el(`
    <div class="card">
      <h2>Статистика</h2>
      <p class="profile-meta muted" id="prof-meta" hidden style="margin: -0.35rem 0 0.85rem; font-size: 0.9rem"></p>
      <div class="segmented segmented--tabs" id="prof-seg">
        <button type="button" class="active" data-tab="me">Общая</button>
        <button type="button" data-tab="lb">Глобальная</button>
      </div>
      <div id="prof-body"></div>
    </div>
  `);
  wrap.appendChild(card);
  const body = card.querySelector('#prof-body');
  const seg = card.querySelector('#prof-seg');
  const metaEl = card.querySelector('#prof-meta');
  if (metaEl && state.user) {
    metaEl.hidden = false;
    const em = state.user.email || '';
    metaEl.innerHTML = state.displayName
      ? `<strong style="color:var(--primary-dark)">${escapeHtml(state.displayName)}</strong> <span>· ${escapeHtml(em)}</span>`
      : escapeHtml(em);
  }
  let tab = 'me';

  async function showMe() {
    if (!state.user) {
      body.innerHTML = '<p class="muted">Войдите, чтобы открыть раздел статистики.</p>';
      return;
    }
    let attempts = [];
    try {
      attempts = await loadUserAttempts(state.user.uid);
    } catch {
      body.innerHTML = '<p class="error">Не удалось загрузить попытки.</p>';
      return;
    }
    if (!attempts.length) {
      body.innerHTML =
        '<p class="muted" style="margin:0 0 0.5rem;font-weight:600;">Пока нет данных</p>' +
        '<p class="muted" style="margin:0;font-size:0.9rem;line-height:1.45;">Пройдите тест с сохранением в аккаунт — здесь появятся попытки, средний балл, график активности и рекорды.</p>';
      return;
    }
    let totalCorrect = 0;
    let totalQ = 0;
    let timeSum = 0;
    const byTest = new Map();
    for (const a of attempts) {
      const c = Number(a.correctAnswers) || 0;
      const tq = Number(a.totalQuestions) || 0;
      totalCorrect += c;
      totalQ += tq;
      timeSum += Number(a.timeSpent) || 0;
      const name = a.testName || 'Тест';
      const prev = byTest.get(name) || { best: 0, n: 0 };
      const pct = tq ? Math.round((c / tq) * 100) : 0;
      prev.best = Math.max(prev.best, pct);
      prev.n++;
      byTest.set(name, prev);
    }
    const avg = totalQ ? roundToOneDecimal((totalCorrect / totalQ) * 100) : 0;
    let best = 0;
    let bestLine = '';
    for (const [name, v] of byTest.entries()) {
      if (v.best > best) best = v.best;
      bestLine += `<li><strong>${escapeHtml(name)}</strong> — лучший результат ${v.best}% (${v.n} попыт.)</li>`;
    }
    const totalWrong = totalQ - totalCorrect;
    const uniqueTests = new Set(attempts.map((a) => a.testName || 'Тест')).size;
    const dayKeys = new Set();
    for (const a of attempts) {
      const k = getAttemptDayKey(a);
      if (k) dayKeys.add(k);
    }
    const activeDays = dayKeys.size;
    const attemptsSub =
      uniqueTests > 0
        ? `${uniqueTests} ${pluralRu(uniqueTests, 'разный тест', 'разных теста', 'разных тестов')}`
        : '';
    const tone = avgToneClass(avg);
    const last = attempts[0];
    const lastTq = Math.max(1, Number(last.totalQuestions) || 1);
    const lastPct = Math.round(((Number(last.correctAnswers) || 0) / lastTq) * 100);
    const lastRaw = last.timestamp || last.dateTime;
    const lastWhen = lastRaw
      ? new Date(lastRaw).toLocaleString('ru-RU', {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })
      : '';
    const windowDays = buildDateWindow(CHART_DAYS_WEB);
    const countMap = new Map(windowDays.map((w) => [w.ymd, 0]));
    for (const a of attempts) {
      const k = getAttemptDayKey(a);
      if (k && countMap.has(k)) countMap.set(k, countMap.get(k) + 1);
    }
    const maxC = Math.max(1, ...countMap.values());
    let barCols = '';
    for (const w of windowDays) {
      const c = countMap.get(w.ymd) || 0;
      const h = Math.round((c / maxC) * 100);
      const tip = `${w.title} — ${c} ${pluralRu(c, 'попытка', 'попытки', 'попыток')}`;
      barCols += `<div class="activity-col" title="${escapeHtml(tip)}"><div class="bar" style="height:${h}%"></div><span class="lbl">${escapeHtml(w.label)}</span></div>`;
    }
    const bestListHtml = bestLine
      ? `<ul style="margin:0.35rem 0 0;padding-left:1.2rem;font-size:0.88rem;color:var(--primary-light);line-height:1.4;">${bestLine}</ul>`
      : '';
    body.innerHTML = `
      <div class="stats-panel">
        <h3>Ваши результаты</h3>
        <div class="stat-tiles">
          <div class="stat-tile">
            <div class="stat-ico" aria-hidden="true">📝</div>
            <p class="stat-value">${attempts.length}</p>
            <p class="stat-label">Попыток</p>
            ${attemptsSub ? `<p class="stat-sub">${escapeHtml(attemptsSub)}</p>` : ''}
          </div>
          <div class="stat-tile">
            <div class="stat-ico" aria-hidden="true">📊</div>
            <p class="stat-value ${tone}">${avg}%</p>
            <p class="stat-label">Средний балл</p>
          </div>
          <div class="stat-tile">
            <div class="stat-ico" aria-hidden="true">🏆</div>
            <p class="stat-value tone-gold">${best}%</p>
            <p class="stat-label">Лучший %</p>
          </div>
          <div class="stat-tile">
            <div class="stat-ico" aria-hidden="true">⏱</div>
            <p class="stat-value">${escapeHtml(formatDuration(timeSum))}</p>
            <p class="stat-label">Всего времени</p>
          </div>
        </div>
        <div class="progress-wrap" style="margin-top:0.9rem;">
          <p class="muted" style="margin:0 0 0.35rem;font-size:0.82rem;">Средняя точность по всем ответам</p>
          <div class="progress-bar"><div class="progress-fill ${tone}" style="width:${Math.min(100, Math.max(0, avg))}%"></div></div>
        </div>
        <p class="muted" style="margin:0.65rem 0 0;font-size:0.88rem;color:var(--primary-medium);">Ответов всего: ✓ ${totalCorrect} · ✗ ${totalWrong}</p>
        ${activeDays > 0 ? `<p class="muted" style="margin:0.35rem 0 0;font-size:0.82rem;">Дней с активностью: ${activeDays}</p>` : ''}
        <div class="activity-chart">
          <p class="activity-title">Активность: сколько тестов пройдено за день</p>
          <div class="activity-bars" role="img" aria-label="Попытки по дням">${barCols}</div>
          <p class="activity-footnote">Одна попытка = один проход теста. Последние ${CHART_DAYS_WEB} дней (старое слева). Подсказка — наведите на столбец.</p>
        </div>
        ${
          last
            ? `<div style="margin-top:0.85rem;text-align:center;">
          <p class="muted" style="margin:0;font-size:0.82rem;font-weight:600;color:var(--primary-dark);">Последняя попытка</p>
          <p class="muted" style="margin:0.25rem 0 0;font-size:0.85rem;">${escapeHtml(last.testName || 'Тест')} · ${lastPct}% · ${escapeHtml(lastWhen)}</p>
        </div>`
            : ''
        }
        ${
          bestListHtml
            ? `<div style="margin-top:0.75rem;"><p class="muted" style="margin:0;font-size:0.82rem;font-weight:600;color:var(--primary-dark);">Лучший результат по тестам</p>${bestListHtml}</div>`
            : ''
        }
      </div>
    `;
  }

  async function showLb() {
    if (!state.user) {
      body.innerHTML = '<p class="muted">Войдите, чтобы открыть глобальную статистику.</p>';
      return;
    }
    body.innerHTML = '<p class="loading">Загрузка...</p>';
    try {
      const board = await loadLeaderboard(50);
      if (!board.length) {
        body.innerHTML = '<p class="muted">Глобальная статистика пока пуста.</p>';
        return;
      }
      let rows = '';
      board.forEach((e, idx) => {
        const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : '';
        const me = e.userId === state.user.uid ? ' me' : '';
        const avg = Math.round(e.averagePercent * 10) / 10;
        const avgTone = avgToneClass(avg);
        const placeCls = idx < 3 ? 'leader-place-top' : '';
        rows += `<tr class="${me}">
          <td><span class="medal">${medal}</span> <span${placeCls ? ` class="${placeCls}"` : ''}>${idx + 1}</span></td>
          <td>${escapeHtml(e.userName)}${e.userId === state.user.uid ? ' <span class="muted" style="font-size:0.8rem;">(вы)</span>' : ''}</td>
          <td><span class="leader-avg ${avgTone}">${avg}%</span></td>
          <td>${e.bestPercent}%</td>
          <td>${e.attempts}</td>
        </tr>`;
      });
      body.innerHTML = `
        <table class="leader-table">
          <thead><tr><th>#</th><th>Имя</th><th>Средн.</th><th>Лучш.</th><th>Попыт.</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <p class="muted" style="margin-top:0.75rem;font-size:0.85rem;">Сортировка по среднему проценту верных ответов.</p>
      `;
    } catch (e) {
      body.innerHTML = `<p class="error">${escapeHtml(e.message || 'Ошибка рейтинга')}</p>
        <p class="muted" style="font-size:0.85rem;">Проверьте правила Realtime Database для <code>leaderboardAttempts</code> и <code>publicProfiles</code>.</p>`;
    }
  }

  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (!b) return;
    tab = b.dataset.tab;
    seg.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    if (tab === 'me') showMe();
    else showLb();
  });

  await showMe();
  return wrap;
}

function renderSettings() {
  const theme = { ...DEFAULT_THEME, ...JSON.parse(localStorage.getItem(LS_THEME) || '{}') };
  const wrap = el(`<div class="layout"></div>`);
  wrap.appendChild(
    el(`
    <div class="top-bar" style="justify-content:space-between;">
      <button type="button" class="btn btn-secondary" style="min-width:auto;" id="bk">← Меню</button>
    </div>
  `),
  );
  wrap.querySelector('#bk').onclick = () => setHash(ROUTE_MENU);

  const shuf = isShuffleOn();
  const root = el(`
    <div class="card">
      <h2>Настройки</h2>
      <div class="field">
        <label for="dname">Отображаемое имя (рейтинг)</label>
        <input id="dname" type="text" value="${escapeHtml(state.displayName)}" maxlength="80" />
        <button type="button" class="btn btn-secondary" style="min-width:auto;margin-top:0.5rem;" id="save-name">Сохранить имя</button>
        <p class="muted" id="name-msg" style="margin:0.35rem 0 0;"></p>
      </div>
      <div class="field">
        <label><input type="checkbox" id="shuffle" ${shuf ? 'checked' : ''} /> Перемешивать вопросы</label>
      </div>
      <h3 style="font-size:1rem;margin:1.25rem 0 0.5rem;">Тема</h3>
      <div class="color-grid" id="colors"></div>
      <div class="row-actions" style="margin-top:1rem;">
        <button type="button" class="btn btn-primary" id="apply-theme">Применить тему</button>
        <button type="button" class="btn btn-secondary" id="reset-theme">Сброс</button>
      </div>
      <h3 style="font-size:1rem;margin:1.25rem 0 0.5rem;">Обновления</h3>
      <div class="field">
        <button type="button" class="btn btn-secondary" style="min-width:auto;" id="check-update">Проверить обновления</button>
        <p class="muted" id="update-msg" style="margin:0.35rem 0 0;"></p>
      </div>
      <p class="footer-note" style="margin-top:1.5rem;">Lycoris Web · те же тесты и Firebase, что и в десктопной версии.</p>
    </div>
  `);
  wrap.appendChild(root);

  const colorFields = [
    ['primaryDark', 'Основной тёмный', theme.primaryDark],
    ['primaryMedium', 'Основной средний', theme.primaryMedium],
    ['primaryLight', 'Основной светлый', theme.primaryLight],
    ['accentGold', 'Акцент', theme.accentGold],
    ['bgStart', 'Фон (верх)', theme.bgStart],
    ['bgEnd', 'Фон (низ)', theme.bgEnd],
  ];
  const cg = root.querySelector('#colors');
  const picks = {};
  for (const [key, label, val] of colorFields) {
    const row = el(`
      <div class="color-row">
        <label>${escapeHtml(label)}</label>
        <input type="color" data-k="${key}" value="${val}" />
      </div>
    `);
    picks[key] = row.querySelector('input');
    cg.appendChild(row);
  }

  root.querySelector('#shuffle').onchange = (e) => {
    localStorage.setItem(LS_SHUFFLE, e.target.checked ? 'true' : 'false');
  };

  root.querySelector('#apply-theme').onclick = () => {
    const t = {};
    for (const k of Object.keys(picks)) t[k] = picks[k].value;
    localStorage.setItem(LS_THEME, JSON.stringify(t));
    applyThemeFromStorage();
    showToast('Тема сохранена');
  };
  root.querySelector('#reset-theme').onclick = () => {
    localStorage.removeItem(LS_THEME);
    for (const k of Object.keys(picks)) picks[k].value = DEFAULT_THEME[k];
    applyThemeFromStorage();
    showToast('Тема сброшена');
  };

  root.querySelector('#save-name').onclick = async () => {
    const msg = root.querySelector('#name-msg');
    msg.textContent = '';
    const v = root.querySelector('#dname').value.trim();
    if (!v) {
      msg.textContent = 'Имя не может быть пустым';
      return;
    }
    if (!state.user) {
      msg.textContent = 'Нужна авторизация';
      return;
    }
    try {
      await set(ref(db, `users/${state.user.uid}/profile/displayName`), v);
      await set(ref(db, `publicProfiles/${state.user.uid}/displayName`), v);
      await updateProfile(state.user, { displayName: v });
      state.displayName = v;
      msg.textContent = 'Сохранено';
      showToast('Имя обновлено');
    } catch (e) {
      msg.textContent = e.message || String(e);
    }
  };

  root.querySelector('#check-update').onclick = async () => {
    const msg = root.querySelector('#update-msg');
    msg.textContent = 'Проверяем...';
    state.updateChecked = false;
    state.updateInfo = null;
    const info = await checkForWebUpdate();
    if (!info) {
      msg.textContent = 'Обновлений не найдено.';
      return;
    }
    const link = info.update_url || '#';
    msg.innerHTML = `Доступна версия <strong>${escapeHtml(String(info.latest_version || 'new'))}</strong>. <a href="${escapeHtml(String(link))}" target="_blank" rel="noopener noreferrer">Открыть</a>`;
  };

  return wrap;
}

function renderTestEditor() {
  const wrap = el(`<div class="layout"></div>`);
  wrap.appendChild(
    el(`
    <div class="top-bar" style="justify-content:space-between;">
      <button type="button" class="btn btn-secondary" style="min-width:auto;" id="bk">← Меню</button>
    </div>
  `),
  );
  wrap.querySelector('#bk').onclick = () => setHash(ROUTE_MENU);

  const root = el(`
    <div class="card">
      <h2>Конструктор теста</h2>
      <p class="muted">Фото добавляется выбором файла.</p>
      <div class="field"><label>Название</label><input id="t-name" type="text" placeholder="Новый тест" /></div>
      <div class="field"><label>Описание</label><input id="t-desc" type="text" placeholder="Краткое описание" /></div>
      <div class="field"><label>Сложность</label><input id="t-diff" type="text" value="Пользовательский" /></div>
      <div class="field"><label>Время</label><input id="t-time" type="text" value="10 мин" /></div>
      <div id="q-list"></div>
      <div class="row-actions">
        <button type="button" class="btn btn-secondary" id="add-q">Добавить вопрос</button>
        <button type="button" class="btn btn-primary" id="save-test">Сохранить локально</button>
      </div>
    </div>
  `);
  wrap.appendChild(root);

  /** @type {{question:string,image:string,answers:string[],correctIndex:number}[]} */
  const draft = [{ question: '', image: '', answers: ['', '', '', ''], correctIndex: 0 }];
  const qList = root.querySelector('#q-list');

  function renderQuestions() {
    qList.innerHTML = '';
    draft.forEach((q, i) => {
      const card = el(`
        <div class="card" style="margin-top:0.75rem;">
          <h3 style="margin:0 0 0.5rem;">Вопрос ${i + 1}</h3>
          <div class="field"><label>Текст вопроса</label><input type="text" data-k="question" /></div>
          <div class="field">
            <label>Фото из файла</label>
            <input type="file" accept="image/*" data-k="image-file" />
          </div>
          <p class="muted" data-k="image-state" style="margin:0;">Фото не выбрано</p>
          <div class="field"><label>Ответ 1</label><input type="text" data-k="a0" /></div>
          <div class="field"><label>Ответ 2</label><input type="text" data-k="a1" /></div>
          <div class="field"><label>Ответ 3</label><input type="text" data-k="a2" /></div>
          <div class="field"><label>Ответ 4</label><input type="text" data-k="a3" /></div>
          <div class="field">
            <label>Правильный ответ</label>
            <select data-k="correct">
              <option value="0">Ответ 1</option>
              <option value="1">Ответ 2</option>
              <option value="2">Ответ 3</option>
              <option value="3">Ответ 4</option>
            </select>
          </div>
          <button type="button" class="btn btn-secondary" style="min-width:auto;" data-k="remove">Удалить вопрос</button>
        </div>
      `);
      card.querySelector('input[data-k="question"]').value = q.question;
      card.querySelector('[data-k="image-state"]').textContent = q.image ? 'Фото выбрано' : 'Фото не выбрано';
      q.answers.forEach((a, idx) => {
        card.querySelector(`input[data-k="a${idx}"]`).value = a;
      });
      card.querySelector('select[data-k="correct"]').value = String(q.correctIndex);

      card.querySelector('input[data-k="question"]').oninput = (e) => {
        q.question = e.target.value;
      };
      card.querySelector('input[data-k="image-file"]').onchange = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const data = await fileToDataUrl(file);
        q.image = data;
        renderQuestions();
      };
      q.answers.forEach((_, idx) => {
        card.querySelector(`input[data-k="a${idx}"]`).oninput = (e) => {
          q.answers[idx] = e.target.value;
        };
      });
      card.querySelector('select[data-k="correct"]').onchange = (e) => {
        q.correctIndex = Number(e.target.value) || 0;
      };
      card.querySelector('button[data-k="remove"]').onclick = () => {
        if (draft.length > 1) {
          draft.splice(i, 1);
          renderQuestions();
        }
      };
      qList.appendChild(card);
    });
  }

  root.querySelector('#add-q').onclick = () => {
    draft.push({ question: '', image: '', answers: ['', '', '', ''], correctIndex: 0 });
    renderQuestions();
  };

  root.querySelector('#save-test').onclick = async () => {
    const name = root.querySelector('#t-name').value.trim();
    const description = root.querySelector('#t-desc').value.trim();
    const difficulty = root.querySelector('#t-diff').value.trim() || 'Пользовательский';
    const estimatedTime = root.querySelector('#t-time').value.trim() || '10 мин';
    if (!name) {
      showToast('Введите название теста');
      return;
    }
    const questions = draft
      .filter((q) => q.question.trim() && q.answers.filter((a) => a.trim()).length >= 2)
      .map((q) => {
        const cleaned = q.answers.map((x) => x.trim()).filter(Boolean);
        const safeCorrect = Math.max(0, Math.min(q.correctIndex, cleaned.length - 1));
        return {
          question: q.question.trim(),
          image: (q.image || '').trim(),
          answers: cleaned.map((text, idx) => ({ text, isCorrect: idx === safeCorrect })),
        };
      });
    if (!questions.length) {
      showToast('Добавьте хотя бы один валидный вопрос');
      return;
    }
    const fileName = `${sanitizeFilename(name)}_${Date.now()}.json`;
    const testObj = { name, description, difficulty, estimatedTime, questions };
    await saveLocalTest(fileName, testObj);
    showToast('Тест сохранён в локальные');
    setHash(ROUTE_TEST_SELECTION);
  };

  renderQuestions();
  return wrap;
}

function sanitizeFilename(name) {
  return String(name).replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'custom_test';
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result || ''));
    reader.readAsDataURL(file);
  });
}

async function render() {
  applyThemeFromStorage();
  const app = document.getElementById('app');
  if (!app) return;
  clearTestTimer();

  if (!state.user) {
    const { name } = parseHash();
    if (name !== 'auth') {
      setHash(ROUTE_AUTH);
      return;
    }
    app.innerHTML = '';
    app.appendChild(renderAuth());
    return;
  }

  await syncDisplayName(state.user);
  await checkForWebUpdate();

  let { name, segments } = parseHash();
  if (name === ROUTE_AUTH) {
    setHash(ROUTE_MENU);
    return;
  }
  if (!name || name === ROUTE_MENU) {
    app.innerHTML = '';
    app.appendChild(renderMenu());
    return;
  }

  app.innerHTML = '';
  // Keep route aliases for backward compatibility.
  const normalizedName = name === 'tests' ? ROUTE_TEST_SELECTION : name === 'history' ? ROUTE_ATTEMPT_HISTORY : name;
  if (normalizedName === ROUTE_TEST_SELECTION) app.appendChild(await renderTests());
  else if (normalizedName === ROUTE_RUN) app.appendChild(await renderRun(segments));
  else if (normalizedName === ROUTE_ATTEMPT_HISTORY) app.appendChild(await renderHistory());
  else if (normalizedName === ROUTE_ATTEMPT) app.appendChild(await renderAttempt(segments));
  else if (normalizedName === ROUTE_RESULT) app.appendChild(renderResult(segments));
  else if (normalizedName === ROUTE_PROFILE) app.appendChild(await renderProfile());
  else if (normalizedName === ROUTE_SETTINGS) app.appendChild(renderSettings());
  else if (normalizedName === ROUTE_TEST_EDITOR) app.appendChild(renderTestEditor());
  else {
    setHash(ROUTE_MENU);
  }
}

onAuthStateChanged(auth, (user) => {
  state.user = user;
  const h = location.hash;
  if (!h || h === '#' || h === '#/') {
    location.hash = user ? `#/${ROUTE_MENU}` : `#/${ROUTE_AUTH}`;
  } else {
    render();
  }
});

window.addEventListener('hashchange', () => render());
