// IndexedDB の薄いラッパー。保存場所: chats / messages / prompts / kv
const NAME = 'sousaku';
const VERSION = 1;
let opening;

function open() {
  return (opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('chats', { keyPath: 'id' });
      d.createObjectStore('messages', { keyPath: 'id' }).createIndex('chatId', 'chatId');
      d.createObjectStore('prompts', { keyPath: 'id' });
      d.createObjectStore('kv', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

async function run(stores, mode, fn) {
  const d = await open();
  return new Promise((resolve, reject) => {
    const t = d.transaction(stores, mode);
    const out = fn(t);
    t.oncomplete = () => resolve(out?.result);
    t.onerror = t.onabort = () => reject(t.error);
  });
}

export const db = {
  all: (store) => run(store, 'readonly', (t) => t.objectStore(store).getAll()),
  put: (store, value) => run(store, 'readwrite', (t) => t.objectStore(store).put(value)),
  putMany: (store, values) =>
    run(store, 'readwrite', (t) => { for (const v of values) t.objectStore(store).put(v); }),
  del: (store, id) => run(store, 'readwrite', (t) => t.objectStore(store).delete(id)),
  delMany: (store, ids) =>
    run(store, 'readwrite', (t) => { for (const id of ids) t.objectStore(store).delete(id); }),
  messagesOf: (chatId) =>
    run('messages', 'readonly', (t) => t.objectStore('messages').index('chatId').getAll(chatId)),
  kvGet: async (key) =>
    (await run('kv', 'readonly', (t) => t.objectStore('kv').get(key)))?.value,
  kvSet: (key, value) => run('kv', 'readwrite', (t) => t.objectStore('kv').put({ key, value })),
};

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
