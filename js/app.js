import { db, uid } from './db.js';
import { streamChat, CONN_TYPES, DEFAULT_BASE_URL } from './api.js';

const $ = (s) => document.querySelector(s);

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}

// ---------- 状態 ----------
const S = {
  settings: { connections: [], activeConnId: null, showImages: true, lastPromptId: null, lastChatId: null,
    ui: { theme: 'auto', fontSize: '16', enterSend: false, autoScroll: true, showTimer: true, skipDeleteConfirm: false } },
  prompts: [],
  chats: [],
  chat: null,
  msgs: new Map(),
  busy: false,
  abort: null,
  error: '',
  editing: null,
  tab: 'conn',
  openCard: null,
};

const saveSettings = () => db.kvSet('settings', S.settings);
const activeConn = () => S.settings.connections.find((c) => c.id === S.settings.activeConnId);
const modelLabel = (c) => (!c ? 'モデル未選択' : c.type === 'dummy' ? 'ダミーAI' : c.model || 'モデル未選択');

const THEMES = {
  auto: ['自動', 'linear-gradient(90deg,#f6f4ef 50%,#17181b 50%)'],
  kinari: ['生成り', '#f6f4ef'], sakura: ['桜', '#f8dfe5'], sora: ['空', '#d9eaf6'], wakakusa: ['若草', '#e1eccf'],
  sepia: ['セピア', '#ead9b8'], sumi: ['墨', '#212327'], aiyo: ['藍夜', '#1b2540'], azuki: ['小豆', '#4a2c36'],
};

function applyUi() {
  const ui = S.settings.ui;
  const root = document.documentElement;
  if (ui.theme === 'auto') delete root.dataset.theme; else root.dataset.theme = ui.theme;
  root.style.setProperty('--msg-size', `${ui.fontSize}px`);
  const color = getComputedStyle(root).getPropertyValue('--panel').trim();
  document.querySelectorAll('meta[name=theme-color]').forEach((m) => { m.content = color; m.removeAttribute('media'); });
}

const promptOf = (id) => S.prompts.find((p) => p.id === id);

const DEFAULT_MODELS = ['gemini-3.1-pro-preview', 'gemini-3.5-flash-lite', 'gemini-4-hydrogen', 'gemini-4-argon', 'gemini-4-carbon'];

function newConn() {
  return {
    id: uid(), name: 'Vertex AI', type: 'vertex', apiKey: '', baseUrl: '', model: DEFAULT_MODELS[0], models: [...DEFAULT_MODELS],
    temperature: '', maxTokens: '', thinkMode: 'none', thinkBudget: '', thinkLevel: 'high',
    showThoughts: false, safety: 'default',
  };
}

function blankChat() {
  const promptId = promptOf(S.settings.lastPromptId) ? S.settings.lastPromptId : null;
  return { id: uid(), title: '', promptId, createdAt: Date.now(), updatedAt: Date.now(), leafId: null };
}

// ---------- 会話の木 ----------
const childrenOf = (parentId) =>
  [...S.msgs.values()].filter((m) => m.parentId === parentId).sort((a, b) => a.createdAt - b.createdAt);

function pathTo(id) {
  const out = [];
  while (id) {
    const m = S.msgs.get(id);
    if (!m) break;
    out.unshift(m);
    id = m.parentId;
  }
  return out;
}

function deepest(id) {
  for (;;) {
    const kids = childrenOf(id);
    if (!kids.length) return id;
    id = kids[kids.length - 1].id;
  }
}

function subtree(id) {
  const ids = [id];
  for (let i = 0; i < ids.length; i++) for (const k of childrenOf(ids[i])) ids.push(k.id);
  return ids;
}

async function saveChat() {
  S.chat.updatedAt = Date.now();
  if (!S.chats.includes(S.chat)) S.chats.unshift(S.chat);
  S.settings.lastChatId = S.chat.id;
  await Promise.all([db.put('chats', S.chat), saveSettings()]);
}

async function openChat(chat) {
  S.abort?.abort();
  S.chat = chat;
  S.error = '';
  S.editing = null;
  S.msgs = new Map((await db.messagesOf(chat.id)).map((m) => [m.id, m]));
  if (S.chats.includes(chat)) { S.settings.lastChatId = chat.id; saveSettings(); }
  render();
  scrollBottom();
}

// ---------- 表示 ----------
const IMG_URL = /(?:!\[[^\]]*\]\()?(https?:\/\/[^\s<>"'()（）「」【】]+?\.(?:avif|webp|png|jpe?g|gif))\)?/gi;

function picture(url, show) {
  if (!show) {
    const chip = h('button', { class: 'picchip', text: '🖼 画像を表示', onclick: () => chip.replaceWith(picture(url, true)) });
    return chip;
  }
  let src = url;
  try { src = encodeURI(decodeURI(url)); } catch { /* そのまま使う */ }
  const img = h('img', {
    class: 'pic', src, alt: '', loading: 'lazy',
    onclick: () => img.replaceWith(picture(url, false)),
    onerror: () => img.replaceWith(h('span', { class: 'hint', text: `（画像を読み込めません: ${url}）` })),
  });
  return img;
}

function richText(text) {
  const frag = document.createDocumentFragment();
  const plain = (s) => {
    s.split(/\*\*(.+?)\*\*/s).forEach((part, i) => {
      if (part) frag.append(i % 2 ? h('strong', { text: part }) : part);
    });
  };
  let last = 0;
  for (const m of text.matchAll(IMG_URL)) {
    plain(text.slice(last, m.index));
    frag.append(picture(m[1], S.settings.showImages));
    last = m.index + m[0].length;
  }
  plain(text.slice(last));
  return frag;
}

function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 2200);
}

function scrollBottom() {
  const box = $('#messages');
  box.scrollTop = box.scrollHeight;
}

function messageEl(m) {
  const el = h('div', { class: `msg ${m.role}` });
  el.dataset.id = m.id;

  if (S.editing === m.id) {
    const ta = h('textarea', { value: m.text });
    const isUser = m.role === 'user';
    el.append(ta, h('div', { class: 'editbtns' },
      h('button', { class: 'primary', text: isUser ? '送り直す（枝を作る）' : '別の枝として保存', onclick: () => saveEdit(m, ta.value, true) }),
      h('button', { text: '上書きだけ', onclick: () => saveEdit(m, ta.value, false) }),
      h('button', { text: 'やめる', onclick: () => { S.editing = null; render(); } }),
    ));
    return el;
  }

  const fold = async () => { m.collapsed = !m.collapsed; render(); await db.put('messages', m); };
  const bubble = h('div', { class: `bubble ${m.collapsed ? 'folded' : ''}`, onclick: m.collapsed && !S.busy ? fold : null });
  if (m.collapsed) {
    bubble.append(h('div', { class: 'body', text: m.text.replace(IMG_URL, '🖼').trim().slice(0, 200) }));
  } else {
    if (m.thought) bubble.append(h('details', { class: 'thought' }, h('summary', { text: '思考' }), h('div', { text: m.thought })));
    bubble.append(h('div', { class: 'body' }, richText(m.text)));
    if (m.notice) bubble.append(h('div', { class: 'hint', text: `※ ${m.notice}` }));
  }
  el.append(bubble);

  if (!S.busy) {
    const sibs = childrenOf(m.parentId);
    const idx = sibs.indexOf(m);
    const tools = h('div', { class: 'tools' });
    if (sibs.length > 1) {
      tools.append(
        h('button', { text: '◀', disabled: idx === 0, 'aria-label': '前の枝', onclick: () => switchBranch(sibs[idx - 1]) }),
        h('span', { class: 'sib', text: `${idx + 1} / ${sibs.length}` }),
        h('button', { text: '▶', disabled: idx === sibs.length - 1, 'aria-label': '次の枝', onclick: () => switchBranch(sibs[idx + 1]) }),
      );
    }
    tools.append(h('button', { text: m.collapsed ? '▸ ひらく' : '▾ たたむ', onclick: fold }));
    if (m.role === 'assistant') tools.append(h('button', { text: '再生成', onclick: () => generate(m.parentId) }));
    tools.append(
      h('button', { text: '編集', onclick: () => { S.editing = m.id; render(); } }),
      h('button', { text: 'コピー', onclick: () => navigator.clipboard.writeText(m.text).then(() => toast('コピーしました')) }),
      h('button', { text: '削除', onclick: () => removeMessage(m) }),
    );
    el.append(tools);
  }
  return el;
}

function render() {
  $('#chatTitle').textContent = S.chat.title || '新しいチャット';
  $('#promptChip').textContent = `プロンプト：${promptOf(S.chat.promptId)?.name || 'なし'}`;
  $('#modelChip').textContent = modelLabel(activeConn());
  $('#btnImages').classList.toggle('off', !S.settings.showImages);
  $('#btnSend').textContent = S.busy ? '停止' : '送信';

  const box = $('#messages');
  const path = pathTo(S.chat.leafId);
  box.replaceChildren(...path.map(messageEl));
  if (!path.length && !S.error) {
    const conn = activeConn();
    box.append(h('div', { class: 'empty', text: conn?.apiKey ? 'メッセージを入力して始めましょう' : 'まず右上の ⚙ から「接続先」にAPIキーを入力してください' }));
  }
  if (S.error) {
    const leaf = S.msgs.get(S.chat.leafId);
    box.append(h('div', { class: 'errbox' }, S.error,
      leaf?.role === 'user' && h('div', { class: 'btnrow' }, h('button', { text: 'もう一度試す', onclick: () => generate(leaf.id) }))));
  }
}

// ---------- 会話の操作 ----------
async function generate(parentId) {
  if (S.busy) return;
  const system = promptOf(S.chat.promptId)?.text || '';
  const history = pathTo(parentId).map(({ role, text }) => ({ role, text }));
  const m = { id: uid(), chatId: S.chat.id, parentId, role: 'assistant', text: '', thought: '', createdAt: Date.now() };
  const chat = S.chat;
  S.msgs.set(m.id, m);
  chat.leafId = m.id;
  S.error = '';
  S.editing = null;
  S.busy = true;
  S.abort = new AbortController();
  render();
  scrollBottom();

  const box = $('#messages');
  const body = box.querySelector(`[data-id="${m.id}"] .body`);
  const ui = S.settings.ui;
  const started = Date.now();
  const waiting = () => `${m.thought ? '思考中' : '応答待ち'}…${ui.showTimer ? ` ${Math.round((Date.now() - started) / 1000)}秒` : ''}`;
  body.textContent = waiting();
  let queued = false;
  const paint = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      if (S.chat !== chat) return;
      const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
      body.textContent = m.text || waiting();
      if (stick && ui.autoScroll) scrollBottom();
    });
  };

  const ticker = setInterval(() => { if (!m.text) paint(); }, 1000);
  try {
    for await (const ev of streamChat(activeConn(), { system, messages: history, signal: S.abort.signal })) {
      if (ev.text) m.text += ev.text;
      if (ev.thought) m.thought += ev.thought;
      if (ev.notice) m.notice = ev.notice;
      paint();
    }
  } catch (e) {
    if (e.name !== 'AbortError') S.error = e.message;
  }

  clearInterval(ticker);
  S.busy = false;
  if (m.text) {
    await db.put('messages', m);
  } else {
    S.msgs.delete(m.id);
    if (chat.leafId === m.id) chat.leafId = parentId;
    if (!S.error && !S.abort.signal.aborted) S.error = m.notice || '返事が空でした。もう一度試してください。';
  }
  if (S.chat === chat) { await saveChat(); render(); } else { await db.put('chats', chat); }
}

async function send() {
  if (S.busy) { S.abort.abort(); return; }
  const input = $('#input');
  const text = input.value.trim();
  const leaf = S.msgs.get(S.chat.leafId);
  if (!text) {
    if (leaf?.role === 'user') generate(leaf.id);
    return;
  }
  const m = { id: uid(), chatId: S.chat.id, parentId: S.chat.leafId ?? null, role: 'user', text, createdAt: Date.now() };
  S.msgs.set(m.id, m);
  S.chat.leafId = m.id;
  if (!S.chat.title) S.chat.title = text.replace(/\s+/g, ' ').slice(0, 24);
  input.value = '';
  resizeInput();
  await Promise.all([db.put('messages', m), saveChat()]);
  generate(m.id);
}

async function switchBranch(target) {
  S.chat.leafId = deepest(target.id);
  S.error = '';
  render();
  await saveChat();
}

async function saveEdit(m, text, asBranch) {
  S.editing = null;
  if (!text.trim()) { render(); return; }
  if (!asBranch) {
    m.text = text;
    await db.put('messages', m);
    render();
    return;
  }
  const copy = { id: uid(), chatId: m.chatId, parentId: m.parentId, role: m.role, text, createdAt: Date.now() };
  S.msgs.set(copy.id, copy);
  S.chat.leafId = copy.id;
  await Promise.all([db.put('messages', copy), saveChat()]);
  if (copy.role === 'user') generate(copy.id);
  else render();
}

async function removeMessage(m) {
  const ids = subtree(m.id);
  const more = ids.length > 1 ? `\nこの先に続く ${ids.length - 1} 件も一緒に消えます。` : '';
  if (!S.settings.ui.skipDeleteConfirm && !confirm(`このメッセージを削除しますか？${more}`)) return;
  const onPath = pathTo(S.chat.leafId).includes(m);
  ids.forEach((id) => S.msgs.delete(id));
  if (onPath) {
    const sibs = childrenOf(m.parentId);
    S.chat.leafId = sibs.length ? deepest(sibs[sibs.length - 1].id) : m.parentId;
  }
  S.error = '';
  render();
  await Promise.all([db.delMany('messages', ids), saveChat()]);
}

// ---------- パネル ----------
const PANELS = ['#drawer', '#sheet', '#settings'];

function show(sel) {
  PANELS.forEach((p) => ($(p).hidden = p !== sel));
  $('#backdrop').hidden = false;
}

function closePanels() {
  PANELS.forEach((p) => ($(p).hidden = true));
  $('#backdrop').hidden = true;
  render();
}

function openDrawer() {
  $('#chatList').replaceChildren(...S.chats
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((c) => h('div', { class: `row ${c === S.chat ? 'on' : ''}` },
      h('button', { class: 'plain', text: c.title || '（無題）', onclick: async () => { await openChat(c); closePanels(); } }),
      h('button', { class: 'iconbtn', text: '🗑', 'aria-label': '削除', onclick: () => removeChat(c) }),
    )));
  if (!S.chats.length) $('#chatList').append(h('p', { class: 'hint', text: 'まだチャットはありません。' }));
  show('#drawer');
}

async function removeChat(c) {
  if (!confirm(`「${c.title || '無題'}」を削除しますか？\n枝分かれした分もすべて消えます。`)) return;
  const ids = (await db.messagesOf(c.id)).map((m) => m.id);
  await Promise.all([db.delMany('messages', ids), db.del('chats', c.id)]);
  S.chats = S.chats.filter((x) => x !== c);
  if (S.chat === c) await openChat(blankChat());
  openDrawer();
}

function openPromptSheet() {
  $('#sheetTitle').textContent = 'プロンプトを選ぶ';
  const pick = async (id) => {
    S.chat.promptId = id;
    S.settings.lastPromptId = id;
    await saveSettings();
    if (S.chats.includes(S.chat)) await db.put('chats', S.chat);
    closePanels();
  };
  const row = (id, name) => h('div', { class: `row ${S.chat.promptId === id ? 'on' : ''}` },
    h('button', { class: 'plain', text: name, onclick: () => pick(id) }));
  $('#sheetBody').replaceChildren(
    row(null, 'なし'),
    ...S.prompts.map((p) => row(p.id, p.name || '（名前なし）')),
    h('div', { class: 'btnrow' }, h('button', { text: 'プロンプトを追加・編集する', onclick: () => openSettings('prompts') })),
  );
  show('#sheet');
}

function modelEditor(c, onPick, again) {
  const input = h('input', { type: 'text', placeholder: 'モデル名を入力して追加', autocapitalize: 'off', autocorrect: 'off' });
  const choose = (name) => {
    c.model = name;
    saveSettings();
    if (onPick) onPick(); else again();
  };
  const add = () => {
    const name = input.value.trim();
    if (!name) return;
    if (!c.models.includes(name)) c.models.push(name);
    choose(name);
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  const current = (name) => c.model === name && (!onPick || c.id === S.settings.activeConnId);
  return h('div', {},
    c.models.map((name) => h('div', { class: `row ${current(name) ? 'on' : ''}` },
      h('button', { class: 'plain', text: `${current(name) ? '✔ ' : ''}${name}`, onclick: () => choose(name) }),
      h('button', { class: 'iconbtn', text: '✕', 'aria-label': '一覧から消す', onclick: () => {
        c.models = c.models.filter((x) => x !== name);
        if (c.model === name) c.model = c.models[0] || '';
        saveSettings();
        again();
      } }))),
    h('div', { class: 'addrow' }, input, h('button', { text: '追加', onclick: add })));
}

function openModelSheet() {
  $('#sheetTitle').textContent = 'モデルを選ぶ';
  const many = S.settings.connections.length > 1;
  $('#sheetBody').replaceChildren(...S.settings.connections.flatMap((c) => [
    many && h('p', { class: 'hint', text: c.name || '（名前なし）' }),
    c.type === 'dummy'
      ? h('div', { class: `row ${c.id === S.settings.activeConnId ? 'on' : ''}` }, h('button', { class: 'plain', text: `${c.id === S.settings.activeConnId ? '✔ ' : ''}ダミーAI（通信しません）`, onclick: () => { S.settings.activeConnId = c.id; saveSettings(); closePanels(); } }))
      : modelEditor(c, () => { S.settings.activeConnId = c.id; saveSettings(); closePanels(); }, openModelSheet),
  ]).filter(Boolean));
  show('#sheet');
}

// ---------- 設定 ----------
function field(label, control, hint) {
  return h('label', { class: 'f' }, label, control, hint && h('div', { class: 'hint', text: hint }));
}

function bound(obj, key, save, props = {}, tag = 'input') {
  const el = h(tag, { ...props, value: obj[key] ?? '' });
  el.addEventListener('change', () => { obj[key] = el.value; save(); });
  return el;
}

function select(obj, key, options, save, after) {
  const el = h('select', {}, Object.entries(options).map(([value, text]) => h('option', { value, text })));
  el.value = obj[key];
  el.addEventListener('change', () => { obj[key] = el.value; save(); after?.(); });
  return el;
}

function connCard(c) {
  const isActive = c.id === S.settings.activeConnId;
  const isDummy = c.type === 'dummy';
  const isGemini = c.type === 'vertex' || c.type === 'gemini';
  const again = () => renderSettings();
  const result = h('div', { class: 'result' });

  const test = async (btn) => {
    btn.disabled = true;
    result.textContent = '接続を確認中…';
    let text = '';
    try {
      for await (const ev of streamChat(c, { system: '', messages: [{ role: 'user', text: 'こんにちは。ひとことで返事をしてください。' }] })) {
        if (ev.text) text += ev.text;
      }
      result.textContent = text ? `✅ つながりました\n返事: ${text}` : '⚠️ つながりましたが、返事が空でした。';
    } catch (e) {
      result.textContent = `❌ ${e.message}`;
    }
    btn.disabled = false;
  };

  const card = h('details', { class: `card ${isActive ? 'active' : ''}`, open: S.openCard === c.id },
    h('summary', { text: `${c.name || '（名前なし）'}${isActive ? '　✔ 使用中' : ''}` }),
    field('名前', bound(c, 'name', () => { saveSettings(); again(); }, { type: 'text' })),
    field('種類', select(c, 'type', CONN_TYPES, saveSettings, again)),
    !isDummy && field('APIキー', bound(c, 'apiKey', saveSettings, { type: 'password', autocomplete: 'off' }), 'この端末の中だけに保存されます。'),
    !isDummy && !isGemini && field('接続先URL', bound(c, 'baseUrl', saveSettings, { type: 'text', placeholder: DEFAULT_BASE_URL, inputMode: 'url' }), '空欄ならOpenRouterにつなぎます。'),
    !isDummy && h('div', { class: 'f' }, 'モデル（タップで選ぶ。チャット画面上部のモデル名からも切り替えられます）', modelEditor(c, null, again)),
    !isDummy && field('温度（空欄＝おまかせ）', bound(c, 'temperature', saveSettings, { type: 'number', step: '0.1', min: '0', max: '2', inputMode: 'decimal' }), 'Gemini 4 など新しいモデルは温度に対応していません。空欄のままにしてください。古いモデルでは、高いほど自由な文章、低いほど安定した文章になります。'),
    !isDummy && field('最大出力トークン（空欄＝おまかせ）', bound(c, 'maxTokens', saveSettings, { type: 'number', min: '1', inputMode: 'numeric' })),
    !isDummy && field('思考の設定', select(c, 'thinkMode', { none: '指定しない（モデルの標準）', level: '思考レベルで指定（Gemini 3 以降）', budget: '思考予算で指定（Gemini 2.5 など古いモデル）' }, saveSettings, again)),
    !isDummy && c.thinkMode === 'budget' && field('思考予算', bound(c, 'thinkBudget', saveSettings, { type: 'number', inputMode: 'numeric' }), '0＝思考しない、-1＝自動。Gemini 4 では使えません（エラーになります）。'),
    !isDummy && c.thinkMode === 'level' && field('思考レベル', select(c, 'thinkLevel', { low: '低', medium: '中', high: '高', xhigh: '最高（Gemini 4 Hydrogen のみ）', minimal: '最小（Gemini 3 系のみ）' }, saveSettings), 'Gemini 4 は 低・中・高 の3段階です。対応していない段階を選ぶとエラーになります。'),
    !isDummy && h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: !!c.showThoughts, onchange: (e) => { c.showThoughts = e.target.checked; saveSettings(); } }), '思考の内容を表示する'),
    isDummy && field('返す文章（空欄＝受け取った文章をそのまま返す）', bound(c, 'dummyText', saveSettings, { placeholder: '画像URLや長文を入れて、表示の確認に使えます。' }, 'textarea'), 'APIを使わずに、画面の動き・分岐・画像表示などを試すための接続先です。料金はかかりません。'),
    isGemini && field('安全フィルター', select(c, 'safety', { default: '指定しない（標準）', BLOCK_ONLY_HIGH: '弱め', BLOCK_NONE: 'ブロックしない' }, saveSettings)),
    h('div', { class: 'btnrow' },
      !isActive && h('button', { class: 'primary', text: 'この接続を使う', onclick: () => { S.settings.activeConnId = c.id; saveSettings(); again(); } }),
      h('button', { text: '接続テスト', onclick: (e) => test(e.target) }),
      h('button', { class: 'danger', text: '削除', onclick: () => {
        if (!confirm(`接続先「${c.name}」を削除しますか？`)) return;
        S.settings.connections = S.settings.connections.filter((x) => x !== c);
        if (isActive) S.settings.activeConnId = S.settings.connections[0]?.id ?? null;
        saveSettings(); again();
      } }),
    ),
    result,
  );
  card.addEventListener('toggle', () => { if (card.open) S.openCard = c.id; else if (S.openCard === c.id) S.openCard = null; });
  return card;
}

function promptCard(p) {
  const save = () => db.put('prompts', p);
  const card = h('details', { class: 'card', open: S.openCard === p.id },
    h('summary', { text: p.name || '（名前なし）' }),
    field('名前', bound(p, 'name', () => { save(); card.querySelector('summary').textContent = p.name || '（名前なし）'; }, { type: 'text' })),
    field('内容', bound(p, 'text', save, { class: 'big', placeholder: '文体の指示、ロールプレイの決まりごと、世界設定などを書きます。' }, 'textarea')),
    h('div', { class: 'btnrow' }, h('button', { class: 'danger', text: '削除', onclick: async () => {
      if (!confirm(`プロンプト「${p.name}」を削除しますか？`)) return;
      S.prompts = S.prompts.filter((x) => x !== p);
      await db.del('prompts', p.id);
      renderSettings();
    } })),
  );
  card.addEventListener('toggle', () => { if (card.open) S.openCard = p.id; else if (S.openCard === p.id) S.openCard = null; });
  return card;
}

async function exportData() {
  const [chats, messages, prompts] = await Promise.all([db.all('chats'), db.all('messages'), db.all('prompts')]);
  const data = { app: 'sousaku-pwa', version: 1, exportedAt: new Date().toISOString(), chats, messages, prompts };
  const name = `sousaku-backup-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([JSON.stringify(data)], name, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = h('a', { href: URL.createObjectURL(file), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

async function importData(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'sousaku-pwa') throw new Error('このアプリの書き出しファイルではありません。');
    await db.putMany('chats', data.chats || []);
    await db.putMany('messages', data.messages || []);
    await db.putMany('prompts', data.prompts || []);
    await loadAll();
    renderSettings();
    toast(`読み込みました（チャット ${data.chats?.length || 0} 件）`);
  } catch (e) {
    alert(`読み込めませんでした。\n${e.message}`);
  }
}

function renderSettings() {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === S.tab));
  const body = $('#settingsBody');
  if (S.tab === 'conn') {
    body.replaceChildren(
      h('p', { class: 'hint', text: '「✔ 使用中」の接続先でチャットします。入力した内容は自動で保存されます。' }),
      ...S.settings.connections.map(connCard),
      h('button', { class: 'wide', text: '＋ 接続先を追加', onclick: () => {
        const c = newConn();
        c.name = '新しい接続先';
        S.settings.connections.push(c);
        S.settings.activeConnId ??= c.id;
        S.openCard = c.id;
        saveSettings(); renderSettings();
      } }),
    );
  } else if (S.tab === 'prompts') {
    body.replaceChildren(
      h('p', { class: 'hint', text: '執筆用・ロールプレイ用などを保存しておき、チャット画面上部の「プロンプト：」をタップして切り替えます。' }),
      ...S.prompts.map(promptCard),
      h('button', { class: 'wide', text: '＋ プロンプトを追加', onclick: async () => {
        const p = { id: uid(), name: '新しいプロンプト', text: '', createdAt: Date.now() };
        S.prompts.push(p);
        S.openCard = p.id;
        await db.put('prompts', p);
        renderSettings();
      } }),
    );
  } else if (S.tab === 'ui') {
    const ui = S.settings.ui;
    const save = () => { saveSettings(); applyUi(); };
    const check = (key, label, hint) => h('div', {},
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: !!ui[key], onchange: (e) => { ui[key] = e.target.checked; save(); } }), label),
      hint && h('div', { class: 'hint', text: hint }));
    body.replaceChildren(
      h('div', { class: 'card' },
        h('strong', { text: '配色' }),
        h('div', { class: 'swatches' }, Object.entries(THEMES).map(([key, [name, color]]) =>
          h('button', { class: `swatch ${ui.theme === key ? 'on' : ''}`, onclick: () => { ui.theme = key; save(); renderSettings(); } },
            h('i', { style: `background:${color}` }), name))),
        h('div', { class: 'hint', text: '「自動」はiPhoneのライト／ダーク設定に合わせます。' })),
      h('div', { class: 'card' },
        h('strong', { text: '文字' }),
        field('本文の文字サイズ', select(ui, 'fontSize', { 14: '小', 16: '標準', 18: '大', 20: '特大' }, save))),
      h('div', { class: 'card' },
        h('strong', { text: '操作' }),
        check('autoScroll', '返事が届いている間、自動で下へスクロールする'),
        check('showTimer', '返事を待っている間、秒数を表示する'),
        check('enterSend', 'Enterキーで送信する', 'オンにすると、iPhoneのキーボードでは「改行」キーで送信されます（改行できなくなります）。外付けキーボードやPC向けです。Shift+Enterで改行できます。'),
        check('skipDeleteConfirm', 'メッセージ削除のときに確認しない')),
    );
  } else {
    const picker = h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: () => picker.files[0] && importData(picker.files[0]) });
    body.replaceChildren(
      h('div', { class: 'card' },
        h('strong', { text: '書き出し（バックアップ）' }),
        h('p', { class: 'hint', text: 'チャット・枝分かれ・プロンプトを1つのファイルに保存します。APIキーは含まれません。' }),
        h('button', { class: 'primary', text: 'ファイルに書き出す', onclick: exportData })),
      h('div', { class: 'card' },
        h('strong', { text: '読み込み' }),
        h('p', { class: 'hint', text: '書き出したファイルを読み込みます。今あるチャットは消えず、追加されます。' }),
        h('button', { text: 'ファイルを選ぶ', onclick: () => picker.click() }), picker),
      h('div', { class: 'card' },
        h('strong', { text: 'アプリを更新' }),
        h('p', { class: 'hint', text: '新しい機能が反映されないときに押してください。チャットや設定は消えません。' }),
        h('button', { text: '最新版に更新する', onclick: async () => {
          for (const r of await navigator.serviceWorker?.getRegistrations?.() || []) await r.unregister();
          for (const k of await caches.keys()) await caches.delete(k);
          location.reload();
        } })),
      h('div', { class: 'card' },
        h('strong', { text: 'すべて消す' }),
        h('p', { class: 'hint', text: 'チャット・プロンプト・接続先（APIキー）をすべて削除します。元に戻せません。' }),
        h('button', { class: 'danger', text: '全データを削除する', onclick: async () => {
          if (!confirm('チャット・プロンプト・APIキーをすべて削除します。\n本当によろしいですか？')) return;
          if (!confirm('元に戻せません。先に「ファイルに書き出す」でバックアップを取りましたか？\nOKを押すと削除します。')) return;
          await Promise.all(['chats', 'messages', 'prompts', 'kv'].map(async (st) => db.delMany(st, (await db.all(st)).map((x) => x.id ?? x.key))));
          location.reload();
        } })),
      h('p', { class: 'hint', text: 'データはこの端末のブラウザ内に保存されています。ホーム画面のアイコンを削除すると消えるので、ときどき書き出しておくと安心です。' }),
    );
  }
}

function openSettings(tab) {
  if (tab) S.tab = tab;
  if (S.tab === 'conn') S.openCard ??= S.settings.activeConnId;
  renderSettings();
  show('#settings');
}

// ---------- 起動 ----------
function resizeInput() {
  const el = $('#input');
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight + 2}px`;
}

async function loadAll() {
  const [settings, prompts, chats] = await Promise.all([db.kvGet('settings'), db.all('prompts'), db.all('chats')]);
  const uiDefaults = S.settings.ui;
  Object.assign(S.settings, settings);
  S.settings.ui = { ...uiDefaults, ...settings?.ui };
  applyUi();
  for (const c of S.settings.connections) {
    if (!Array.isArray(c.models)) c.models = c.type === 'openai' ? [] : [...DEFAULT_MODELS];
    if (c.model && !c.models.includes(c.model)) c.models.unshift(c.model);
  }
  S.prompts = prompts.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  S.chats = chats;
  if (!S.settings.connections.length) {
    const c = newConn();
    S.settings.connections.push(c);
    S.settings.activeConnId = c.id;
    await saveSettings();
  }
  await openChat(S.chats.find((c) => c.id === (S.chat?.id ?? S.settings.lastChatId)) || blankChat());
}

$('#btnSend').addEventListener('click', send);
$('#input').addEventListener('input', resizeInput);
$('#input').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
  if (e.metaKey || e.ctrlKey || (S.settings.ui.enterSend && !e.shiftKey)) { e.preventDefault(); send(); }
});
$('#btnBottom').addEventListener('click', scrollBottom);
$('#messages').addEventListener('scroll', () => {
  const box = $('#messages');
  $('#btnBottom').hidden = box.scrollHeight - box.scrollTop - box.clientHeight < 300;
}, { passive: true });
$('#btnDrawer').addEventListener('click', openDrawer);
$('#btnNewChat').addEventListener('click', async () => { await openChat(blankChat()); closePanels(); });
$('#btnSettings').addEventListener('click', () => openSettings());
$('#promptChip').addEventListener('click', openPromptSheet);
$('#modelChip').addEventListener('click', openModelSheet);
$('#btnImages').addEventListener('click', () => {
  S.settings.showImages = !S.settings.showImages;
  saveSettings();
  render();
  toast(S.settings.showImages ? '画像を表示します' : '画像を隠します');
});
$('#chatTitle').addEventListener('click', async () => {
  const name = prompt('チャットの名前', S.chat.title);
  if (name == null) return;
  S.chat.title = name.trim();
  if (S.chats.includes(S.chat)) await db.put('chats', S.chat);
  render();
});
$('#backdrop').addEventListener('click', closePanels);
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closePanels));
document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => { S.tab = b.dataset.tab; S.openCard = null; renderSettings(); }));

navigator.storage?.persist?.();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
loadAll();
