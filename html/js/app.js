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

const LS_THEME = 'lycoris_web_theme';
const LS_SHUFFLE = 'lycoris_web_shuffle';
const LS_SOURCE = 'lycoris_web_test_source';
const LS_LOCAL_ATTEMPTS = 'lycoris_web_attempts_local';
const MAX_LOCAL_ATTEMPTS = 50;

const DEFAULT_THEME = {
  primaryDark: '#2c3a5e',
  primaryMedium: '#4a5c80',
  primaryLight: '#7284a8',
  accentGold: '#e6b800',
  bgStart: '#fafaff',
  bgEnd: '#ebeef5',
};

/** @type {{ user: import('firebase/auth').User | null, displayName: string, testRun: object | null, timerId: any }} */
const state = {
  user: null,
  displayName: '',
  testRun: null,
  timerId: null,
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
  const h = (location.hash || '#/menu').replace(/^#\/?/, '');
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
  if (!Array.isArray(arr)) return list;
  for (const q of arr) {
    if (!q?.question || !Array.isArray(q.answers)) continue;
    const options = [];
    let correct = -1;
    for (let j = 0; j < q.answers.length; j++) {
      const a = q.answers[j];
      if (!a || typeof a.text !== 'string') continue;
      options.push(a.text);
      if (a.isCorrect === true) correct = j;
    }
    if (correct >= 0 && options.length) {
      list.push({ question: q.question, options, correctAnswer: correct });
    }
  }
  return list;
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
        };
        byUser.set(attempt.userId, e);
      }
      const name = normalizeNickname(attempt.userName);
      if (name) e.userName = name;
      const correct = Number(attempt.correctAnswers) || 0;
      const total = Math.max(1, Number(attempt.totalQuestions) || 1);
      const time = Number(attempt.timeSpent) || 0;
      const percent = Math.round((correct / total) * 100);
      e.attempts++;
      e.totalCorrect += correct;
      e.totalQuestions += total;
      e.totalTimeSeconds += time;
      if (percent > e.bestPercent) e.bestPercent = percent;
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
      e.averagePercent = (e.totalCorrect / e.totalQuestions) * 100;
      list.push(e);
    }
  }
  list.sort((a, b) => {
    if (b.averagePercent !== a.averagePercent) return b.averagePercent - a.averagePercent;
    if (b.bestPercent !== a.bestPercent) return b.bestPercent - a.bestPercent;
    return b.attempts - a.attempts;
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
          <button type="submit" class="btn btn-primary" style="width:100%;min-width:auto;">Продолжить</button>
        </form>
      </div>
      <p class="footer-note">Веб-версия Lycoris · GitHub Pages</p>
    </div>
  `);
  let mode = 'in';
  const seg = root.querySelector('#auth-seg');
  const err = root.querySelector('#auth-err');
  const form = root.querySelector('#auth-form');
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (!b) return;
    mode = b.dataset.mode;
    seg.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
  });
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
      setHash('menu');
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
        <button type="button" class="btn btn-primary" id="go-tests">Начать тест</button>
        <button type="button" class="btn btn-secondary" id="go-history">История попыток</button>
        <button type="button" class="btn btn-ghost" id="logout">Выйти</button>
      </div>
    </div>
  `);
  root.querySelector('#go-tests').onclick = () => setHash('tests');
  root.querySelector('#go-history').onclick = () => setHash('history');
  root.querySelector('#to-profile').onclick = () => setHash('profile');
  root.querySelector('#to-settings').onclick = () => setHash('settings');
  root.querySelector('#logout').onclick = async () => {
    await signOut(auth);
    setHash('auth');
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
  wrap.querySelector('#back-menu').onclick = () => setHash('menu');

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
          Импорт JSON
          <input type="file" id="import-files" accept=".json,application/json" multiple hidden />
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
        'Локальные тесты хранятся в браузере (IndexedDB). Импортируйте .json с массивом questions.';
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
        const json = JSON.parse(text);
        if (!Array.isArray(json.questions) || !json.questions.length) {
          bad++;
          continue;
        }
        let name = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
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
    } catch (e) {
      loading.hidden = true;
      errEl.textContent = e.message || String(e);
      errEl.hidden = false;
    }
  }

  loadList();
  return wrap;
}

async function renderRun(segments) {
  const source = segments[1];
  const fileName = decodeURIComponent(segments[2] || '');
  if (!fileName || (source !== 'github' && source !== 'local')) {
    setHash('tests');
    return el('<div></div>');
  }

  clearTestTimer();
  state.testRun = null;

  const wrap = el(`<div class="layout"></div>`);
  wrap.appendChild(
    el(`
    <div class="top-bar" style="justify-content:space-between;flex-wrap:wrap;">
      <button type="button" class="btn btn-secondary" style="min-width:auto;padding:0.5rem 1rem;" id="abort">← К списку</button>
      <span class="timer-pill" id="timer">00:00</span>
    </div>
  `),
  );
  wrap.querySelector('#abort').onclick = () => {
    clearTestTimer();
    setHash('tests');
  };

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

    const runState = {
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
    state.testRun = runState;

    const loadEl = body.querySelector('#run-load');
    const ui = body.querySelector('#run-ui');
    loadEl.hidden = true;
    ui.hidden = false;

    const timerEl = wrap.querySelector('#timer');
    state.timerId = setInterval(() => {
      runState.seconds++;
      const m = Math.floor(runState.seconds / 60);
      const s = runState.seconds % 60;
      timerEl.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }, 1000);

    function renderQuestion() {
      const i = runState.index;
      const q = questions[i];
      const n = questions.length;
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

    runState.checked = questions.map(() => false);
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
    w.querySelector('#bk').onclick = () => setHash('menu');
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
  root.querySelector('#to-tests').onclick = () => setHash('tests');
  root.querySelector('#review').onclick = () => setHash(`attempt/local/${id}`);
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
  wrap.querySelector('#bk').onclick = () => setHash('menu');

  const card = el(`
    <div class="card">
      <h2>История попыток</h2>
      <p class="muted" id="hist-src"></p>
      <div id="hist-list"></div>
    </div>
  `);
  wrap.appendChild(card);

  const listEl = card.querySelector('#hist-list');
  const srcEl = card.querySelector('#hist-src');

  const local = readLocalAttempts();
  let remote = [];
  if (state.user) {
    try {
      remote = await loadUserAttempts(state.user.uid);
      srcEl.textContent = 'Источник: Firebase и сохранённые в браузере попытки.';
    } catch {
      srcEl.textContent = 'Источник: только локальные попытки (ошибка загрузки Firebase).';
    }
  } else {
    srcEl.textContent = 'Источник: локальные попытки.';
  }

  const merged = [];
  for (const a of remote) {
    merged.push({ kind: 'fb', id: a.id, at: a.timestamp, title: a.testName || 'Тест', sub: `${a.correctAnswers}/${a.totalQuestions}` });
  }
  for (const a of local) {
    merged.push({
      kind: 'local',
      id: a.localId,
      at: a.at,
      title: a.payload?.testName || 'Тест',
      sub: `${a.payload?.correctAnswers}/${a.payload?.totalQuestions}`,
    });
  }
  merged.sort((x, y) => String(y.at || '').localeCompare(String(x.at || '')));

  if (!merged.length) {
    listEl.innerHTML = '<p class="muted">Пока нет попыток.</p>';
    return wrap;
  }

  for (const item of merged) {
    const b = el(`
      <button type="button" class="card history-item" style="margin-top:0.75rem;">
        <div class="row">
          <h3>${escapeHtml(item.title)}</h3>
          <span class="badge">${escapeHtml(item.sub)}</span>
        </div>
        <p class="muted" style="margin:0.35rem 0 0;">${escapeHtml(item.at || '')}</p>
      </button>
    `);
    b.onclick = () => setHash(`attempt/${item.kind}/${item.id}`);
    listEl.appendChild(b);
  }
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
  wrap.querySelector('#bk').onclick = () => setHash('history');

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
  box.innerHTML = `<h2>${escapeHtml(payload.testName)}</h2>
    <p class="muted">Верно: ${payload.correctAnswers} · Неверно: ${payload.incorrectAnswers} · Время: ${formatDuration(payload.timeSpent)}</p>`;

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
  wrap.querySelector('#bk').onclick = () => setHash('menu');

  const card = el(`
    <div class="card">
      <h2>Статистика</h2>
      <div class="segmented" id="prof-seg">
        <button type="button" class="active" data-tab="me">Мои результаты</button>
        <button type="button" data-tab="lb">Рейтинг</button>
      </div>
      <div id="prof-body"></div>
    </div>
  `);
  wrap.appendChild(card);
  const body = card.querySelector('#prof-body');
  const seg = card.querySelector('#prof-seg');
  let tab = 'me';

  async function showMe() {
    if (!state.user) {
      body.innerHTML = '<p class="muted">Войдите, чтобы видеть статистику.</p>';
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
      body.innerHTML = '<p class="muted">Пока нет завершённых тестов.</p>';
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
    const avg = totalQ ? Math.round((totalCorrect / totalQ) * 100) : 0;
    let bestLine = '';
    for (const [name, v] of byTest.entries()) {
      bestLine += `<li><strong>${escapeHtml(name)}</strong> — лучший результат ${v.best}% (${v.n} попыт.)</li>`;
    }
    body.innerHTML = `
      <p>Всего попыток: <strong>${attempts.length}</strong></p>
      <p>Средняя точность: <strong>${avg}%</strong></p>
      <p class="muted">Суммарное время: ${formatDuration(timeSum)}</p>
      <h3 style="margin:1rem 0 0.5rem;font-size:1rem;">По тестам</h3>
      <ul style="margin:0;padding-left:1.2rem;" class="muted">${bestLine}</ul>
    `;
  }

  async function showLb() {
    if (!state.user) {
      body.innerHTML = '<p class="muted">Войдите, чтобы видеть рейтинг.</p>';
      return;
    }
    body.innerHTML = '<p class="loading">Загрузка рейтинга…</p>';
    try {
      const board = await loadLeaderboard(50);
      if (!board.length) {
        body.innerHTML = '<p class="muted">Рейтинг пока пуст.</p>';
        return;
      }
      let rows = '';
      board.forEach((e, idx) => {
        const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : '';
        const me = e.userId === state.user.uid ? ' me' : '';
        const avg = Math.round(e.averagePercent * 10) / 10;
        rows += `<tr class="${me}">
          <td><span class="medal">${medal}</span> ${idx + 1}</td>
          <td>${escapeHtml(e.userName)}</td>
          <td>${avg}%</td>
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
  wrap.querySelector('#bk').onclick = () => setHash('menu');

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

  return wrap;
}

async function render() {
  applyThemeFromStorage();
  const app = document.getElementById('app');
  if (!app) return;
  clearTestTimer();

  if (!state.user) {
    const { name } = parseHash();
    if (name !== 'auth') {
      setHash('auth');
      return;
    }
    app.innerHTML = '';
    app.appendChild(renderAuth());
    return;
  }

  await syncDisplayName(state.user);

  let { name, segments } = parseHash();
  if (name === 'auth') {
    setHash('menu');
    return;
  }
  if (!name || name === 'menu') {
    app.innerHTML = '';
    app.appendChild(renderMenu());
    return;
  }

  app.innerHTML = '';
  if (name === 'tests') app.appendChild(await renderTests());
  else if (name === 'run') app.appendChild(await renderRun(segments));
  else if (name === 'history') app.appendChild(await renderHistory());
  else if (name === 'attempt') app.appendChild(await renderAttempt(segments));
  else if (name === 'result') app.appendChild(renderResult(segments));
  else if (name === 'profile') app.appendChild(await renderProfile());
  else if (name === 'settings') app.appendChild(renderSettings());
  else {
    setHash('menu');
  }
}

onAuthStateChanged(auth, (user) => {
  state.user = user;
  const h = location.hash;
  if (!h || h === '#' || h === '#/') {
    location.hash = user ? '#/menu' : '#/auth';
  } else {
    render();
  }
});

window.addEventListener('hashchange', () => render());
