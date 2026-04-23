const DB_NAME = 'lycoris_web';
const DB_VERSION = 1;
const STORE = 'tests';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'fileName' });
      }
    };
  });
}

/**
 * @param {string} fileName
 * @param {object} jsonObject полный объект теста (как в .json файле)
 */
export async function saveLocalTest(fileName, jsonObject) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore(STORE).put({
      fileName,
      json: jsonObject,
      updatedAt: Date.now(),
    });
  });
}

export async function listLocalTestsMeta() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);
    const req = store.getAll();
    req.onsuccess = () => {
      const rows = req.result || [];
      const meta = rows
        .map((row) => buildMeta(row.fileName, row.json))
        .filter(Boolean)
        .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ru'));
      resolve(meta);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getLocalTestJson(fileName) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(fileName);
    req.onsuccess = () => resolve(req.result ? req.result.json : null);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteLocalTest(fileName) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore(STORE).delete(fileName);
  });
}

function buildMeta(fileName, root) {
  if (!root || !Array.isArray(root.questions) || root.questions.length === 0) {
    return null;
  }
  const fallback = fileName.replace(/\.json$/i, '');
  return {
    id: sanitizeId(root.name || fallback),
    name: root.name || fallback,
    description: root.description || 'Импортированный тест',
    questionCount: root.questions.length,
    estimatedTime: root.estimatedTime || `${Math.max(2, root.questions.length)} мин`,
    difficulty: root.difficulty || 'Пользовательский',
    fileName,
  };
}

function sanitizeId(name) {
  let id = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return id || 'custom-test';
}
