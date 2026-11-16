import { db, uid } from './db.js';
import { streamChat, CONN_TYPES, DEFAULT_BASE_URL } from './api.js';
import { initPhone } from './phone.js';

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

// 線画アイコン（絵文字は端末ごとに見た目が変わるので使わない）
const ICONS = {
  pencil: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  book: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z',
  branch: 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9',
  summary: 'M17 10H3M21 6H3M21 14H3M13 18H3',
  fold: 'M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7',
  unfold: 'M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7',
  copy: 'M20 9h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1',
  save: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  trash: 'M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2',
  user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  ai: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  image: 'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM8.5 11a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM21 16l-5-5-9 9',
  clip: 'M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48',
  gauge: 'M12 21a9 9 0 1 1 9-9M12 12l5-3M3 12h2M12 3v2',
  spark: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z',
};

function icon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'ic');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

// ---------- 状態 ----------
const S = {
  settings: { connections: [], activeConnId: null, showImages: true, lastPromptId: null, lastChatId: null, lastCharIds: [],
    summary: { connId: '', model: '', auto: false, threshold: 40, keep: 10 },
    ui: { theme: 'auto', fontSize: '16', enterSend: false, autoScroll: true, showTimer: true, skipDeleteConfirm: false,
      replaceUser: true, toolsMode: 'always', toolColors: true, showMeta: true, scrollbar: true, continueText: '続きを書いてください。', imgBase: '', imgExt: '.avif', bgVeil: 70, bubbleAlpha: 85 } },
  prompts: [],
  chars: [],
  chats: [],
  chat: null,
  msgs: new Map(),  // openChat で MsgMap に差し替える
  busy: false,
  pending: [],
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
  auto: ['自動', 'linear-gradient(90deg,#3b6ea5 50%,#2a2d33 50%)'],
  kinari: ['生成り', '#3b6ea5'], aizumi: ['藍墨', '#26437a'], sora: ['空', '#1f78b4'], matcha: ['抹茶', '#3d6b2a'], wakakusa: ['若草', '#5f8f2f'],
  sakura: ['桜', '#c2476a'], beni: ['紅', '#a3263c'], sumire: ['菫', '#6a45b0'], sepia: ['セピア', '#8a5c24'],
  sumi: ['墨', '#2a2d33'], aiyo: ['藍夜', '#24345c'], azuki: ['小豆', '#5a2f3c'], yozakura: ['夜桜', '#4a2450'],
};

function applyUi() {
  const ui = S.settings.ui;
  const root = document.documentElement;
  if (ui.theme === 'auto') delete root.dataset.theme; else root.dataset.theme = ui.theme;
  root.style.setProperty('--msg-size', `${ui.fontSize}px`);
  root.style.setProperty('--veil', `${ui.bgVeil}%`);
  root.style.setProperty('--bubble-alpha', `${ui.bubbleAlpha}%`);
  const color = getComputedStyle($('#topbar')).backgroundColor;
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

const CHAR_TYPES = { char: '登場人物', hero: '主人公（自分が演じる・語る人物）', world: '世界設定', doc: '資料（まるごと読み込む）' };
const chatChars = (chat) => (chat.charIds || []).map((id) => S.chars.find((c) => c.id === id)).filter(Boolean);

// {{user}} {{char}} と、単独の「User」を、選んでいる主人公・登場人物の名前に置き換える
function fillNames(chat, text) {
  const chars = chatChars(chat);
  const hero = chars.find((c) => c.type === 'hero')?.name;
  const cast = chars.find((c) => (c.type || 'char') === 'char')?.name;
  if (cast) text = text.replace(/\{\{char\}\}/gi, () => cast);
  if (hero) {
    text = text.replace(/\{\{user\}\}/gi, () => hero);
    if (S.settings.ui.replaceUser) text = text.replace(/(^|[^A-Za-z])User(?![A-Za-z])/g, (_, pre) => pre + hero);
  }
  return text;
}

// プロンプトとキャラ表から、AIに渡すシステムプロンプトを組み立てる。
// 「詳細」は、直近の会話に名前かキーワードが出たキャラの分だけ入れる。
// 要約が有効なら、path のうち何件目までが要約済みかを返す（無効・対象外なら 0）
function summaryCut(chat, path) {
  const sum = chat.summary;
  if (!sum?.text?.trim() || chat.summaryOn === false) return 0;
  const i = path.findIndex((m) => m.id === sum.uptoId);
  return i >= 0 && i < path.length - 1 ? i + 1 : 0;
}

function buildSystem(chat, recentText, summaryText) {
  const parts = [promptOf(chat.promptId)?.text || ''];
  const loaded = [];
  const block = (c) => {
    let text = `## ${c.name}\n${c.core || ''}`.trim();
    const keys = [c.name, ...(c.keywords || '').split(/[,、，\n]+/)].map((k) => k.trim()).filter(Boolean);
    if (c.detail?.trim() && keys.some((k) => recentText.includes(k))) {
      text += `\n${c.detail.trim()}`;
      loaded.push(c.name);
    }
    return text;
  };
  const chars = chatChars(chat);
  for (const [type, title] of [['world', '# 世界設定'], ['hero', '# 主人公（ユーザーが演じる・語る人物）'], ['char', '# 登場人物'], ['doc', '# 資料']]) {
    const list = chars.filter((c) => (c.type || 'char') === type);
    if (list.length) parts.push(`${title}\n\n${list.map(block).join('\n\n')}`);
  }
  if (chat.note?.trim()) parts.push(`# 今回の話\n\n${chat.note.trim()}`);
  if (summaryText) parts.push(`# これまでのあらすじ\n\n${summaryText.trim()}`);
  return { system: fillNames(chat, parts.filter(Boolean).join('\n\n')), loaded };
}

function blankChat() {
  const promptId = promptOf(S.settings.lastPromptId) ? S.settings.lastPromptId : null;
  const charIds = (S.settings.lastCharIds || []).filter((id) => S.chars.some((c) => c.id === id));
  return { id: uid(), title: '', promptId, charIds, createdAt: Date.now(), updatedAt: Date.now(), leafId: null };
}

// ---------- 会話の木 ----------
// 親ごとの子メッセージ一覧。メッセージの追加・削除があったときだけ作り直す。
let kidsIndex = null;
class MsgMap extends Map {
  set(k, v) { kidsIndex = null; return super.set(k, v); }
  delete(k) { kidsIndex = null; return super.delete(k); }
}
function childrenOf(parentId) {
  if (!kidsIndex) {
    kidsIndex = new Map();
    for (const m of S.msgs.values()) {
      const key = m.parentId ?? null;
      if (!kidsIndex.has(key)) kidsIndex.set(key, []);
      kidsIndex.get(key).push(m);
    }
    for (const list of kidsIndex.values()) list.sort((a, b) => a.createdAt - b.createdAt);
  }
  return kidsIndex.get(parentId ?? null) || [];
}

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

// 長い会話でも重くならないよう、画面に出すのは直近 PAGE 件だけにする（上のボタンで追加表示）
const PAGE = 60;

async function openChat(chat) {
  S.abort?.abort();
  S.chat = chat;
  S.error = '';
  S.editing = null;
  S.showCount = PAGE;
  S.msgs = new MsgMap((await db.messagesOf(chat.id)).map((m) => [m.id, m]));
  kidsIndex = null;
  if (S.chats.includes(chat)) { S.settings.lastChatId = chat.id; saveSettings(); }
  render();
  scrollBottom();
  applyBg();
}

// ---------- 表示 ----------
const IMG_URL = /(?:!\[[^\]]*\]\()?(https?:\/\/[^\s<>"'()（）「」【】]+?\.(?:avif|webp|png|jpe?g|gif))\)?/gi;

function expandImages(text) {
  const base = S.settings.ui.imgBase.trim();
  if (!base) return text;
  const ext = S.settings.ui.imgExt.trim();
  return text.replace(/\[\[([^\[\]\n]{1,80})\]\]/g, (_, name) =>
    `${base.replace(/\/?$/, '/')}${name.trim()}${/\.\w{2,5}$/.test(name.trim()) ? '' : ext}`);
}

function picture(url, show) {
  if (!show) {
    const chip = h('button', { class: 'picchip', onclick: () => chip.replaceWith(picture(url, true)) }, icon('image'), '画像を表示');
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
  text = expandImages(text);
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

const num = (n) => Number(n || 0).toLocaleString();
const usageText = (u) => `入力 ${num(u.in)}${u.cached ? `（うちキャッシュ ${num(u.cached)}・${Math.round((u.cached / Math.max(1, u.in)) * 100)}％）` : ''} ／ 出力 ${num(u.out)}${u.think ? ` ／ 思考 ${num(u.think)}` : ''} トークン`;

function openUsage() {
  $('#sheetTitle').textContent = '使用量';
  const sum = (list) => list.reduce((t, m) => (m.usage ? { n: t.n + 1, in: t.in + m.usage.in, out: t.out + m.usage.out, think: t.think + m.usage.think, cached: t.cached + m.usage.cached } : t), { n: 0, in: 0, out: 0, think: 0, cached: 0 });
  const table = (title, t) => h('div', { class: 'card' },
    h('strong', { text: title }),
    t.n ? h('div', { class: 'usagegrid' },
      h('span', { text: '返事の回数' }), h('b', { text: `${num(t.n)} 回` }),
      h('span', { text: '入力' }), h('b', { text: `${num(t.in)} トークン` }),
      h('span', { text: 'うちキャッシュ' }), h('b', { text: `${num(t.cached)} トークン（${Math.round((t.cached / Math.max(1, t.in)) * 100)}％）` }),
      h('span', { text: '出力' }), h('b', { text: `${num(t.out)} トークン` }),
      h('span', { text: '思考' }), h('b', { text: `${num(t.think)} トークン` }))
      : h('p', { class: 'hint', text: 'まだ記録がありません（この機能を入れたあとの返事から数えます）。' }));
  const path = pathTo(S.chat.leafId);
  const last = [...path].reverse().find((m) => m.usage);
  $('#sheetBody').replaceChildren(
    h('p', { class: 'hint', text: 'AIから返ってきた実際の数字です。入力は「毎回送っている量」で、会話が長いほど増えます。キャッシュは、前回と同じ出だしの部分が割引で処理された量です。' }),
    last && h('div', { class: 'card' }, h('strong', { text: '直近の返事' }), h('p', { class: 'hint', text: usageText(last.usage) })),
    table('今見ている枝の合計', sum(path)),
    table('このチャット全体（消していない枝すべて）', sum([...S.msgs.values()])),
    h('p', { class: 'hint', text: '料金の金額は表示していません（モデルごとの単価が変わるため）。要約・スマホをのぞく・AI整理で使った分は、ここには含まれません。' }),
  );
  show('#sheet');
}

function messageEl(m, index) {
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
  const ui = S.settings.ui;
  const tapTools = (e) => {
    if (ui.toolsMode !== 'tap' || S.busy || e.target.closest('img,button,details,a') || String(getSelection())) return;
    S.toolsFor = S.toolsFor === m.id ? null : m.id;
    render();
  };
  const bubble = h('div', { class: `bubble ${m.collapsed ? 'folded' : ''}`, onclick: m.collapsed ? (S.busy ? null : fold) : tapTools });
  if (ui.showMeta) bubble.append(h('div', { class: 'meta', text: [`#${index + 1}`, m.model, new Date(m.createdAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })].filter(Boolean).join(' / ') }));
  if (m.collapsed) {
    bubble.append(h('div', { class: 'body', text: expandImages(m.text).replace(IMG_URL, '〔画像〕').trim().slice(0, 200) }));
  } else {
    if (m.thought) bubble.append(h('details', { class: 'thought' }, h('summary', { text: '思考' }), h('div', { text: m.thought })));
    bubble.append(h('div', { class: 'body' }, richText(m.text)));
    if (m.files?.length) bubble.append(h('div', { class: 'files' }, m.files.map((f) => f.kind === 'image'
      ? h('img', { src: `data:${f.mime};base64,${f.data}`, alt: f.name })
      : h('span', { class: 'filechip' }, icon('clip'), f.name))));
    if (m.notice) bubble.append(h('div', { class: 'hint', text: `※ ${m.notice}` }));
    if (m.usage && ui.showMeta) bubble.append(h('div', { class: 'meta usage', text: usageText(m.usage) }));
    if (m.loaded?.length) bubble.append(h('div', { class: 'hint' }, icon('book'), `詳細を読み込み: ${m.loaded.join('、')}`));
  }
  el.append(bubble);

  if (!S.busy && (ui.toolsMode !== 'tap' || m.id === S.chat.leafId || S.toolsFor === m.id)) {
    const sibs = childrenOf(m.parentId);
    const idx = sibs.indexOf(m);
    const tools = h('div', { class: `tools ${ui.toolColors ? 'colored' : ''}` });
    if (sibs.length > 1) {
      tools.append(
        h('button', { text: '◀', disabled: idx === 0, 'aria-label': '前の枝', onclick: () => switchBranch(sibs[idx - 1]) }),
        h('span', { class: 'sib', text: `${idx + 1} / ${sibs.length}` }),
        h('button', { text: '▶', disabled: idx === sibs.length - 1, 'aria-label': '次の枝', onclick: () => switchBranch(sibs[idx + 1]) }),
      );
    }
    tools.append(h('button', { class: 'sym c-fold', text: m.collapsed ? '▸' : '▾', 'aria-label': m.collapsed ? 'ひらく' : 'たたむ', onclick: fold }));
    if (m.role === 'assistant' && m.id === S.chat.leafId) tools.append(h('button', { class: 'c-go', text: '続き', onclick: () => continueFrom(m) }));
    if (m.role === 'assistant') tools.append(h('button', { class: 'c-retry', text: '再生成', onclick: () => generate(m.parentId) }));
    tools.append(
      h('button', { class: 'c-edit', text: '編集', onclick: () => { S.editing = m.id; render(); } }),
      h('button', { class: 'c-copy', text: 'コピー', onclick: () => navigator.clipboard.writeText(m.text).then(() => toast('コピーしました')) }),
      h('button', { class: 'c-del', text: '削除', onclick: () => removeMessage(m) }),
      h('span', { class: 'cnt', text: `${m.text.length.toLocaleString()} / ${S.totalChars.toLocaleString()}字` }),
    );
    el.append(tools);
  }
  return el;
}

function render() {
  $('#chatTitle').textContent = S.chat.title || '新しいチャット';
  $('#promptChip span').textContent = promptOf(S.chat.promptId)?.name || 'プロンプトなし';
  $('#modelChip span').textContent = modelLabel(activeConn());
  // 接続先が複数あるときは、同じ名前のモデルを見分けられるよう接続先の名前も出す
  const several = S.settings.connections.length > 1 && activeConn();
  $('#connTag').hidden = !several;
  $('#connTag').textContent = several ? (activeConn().name || '').slice(0, 5) : '';
  $('#charChip span').textContent = chatChars(S.chat).length;
  $('#btnImages').classList.toggle('off', !S.settings.showImages);
  $('#btnSend').textContent = S.busy ? '停止' : '送信';

  const box = $('#messages');
  const path = pathTo(S.chat.leafId);
  S.totalChars = path.reduce((n, m) => n + m.text.length, 0);
  const cut = summaryCut(S.chat, path);
  const hidden = Math.max(0, path.length - (S.showCount || PAGE));
  box.replaceChildren(...[
    hidden > 0 && h('button', { class: 'wide older', text: `▲ 前のメッセージを表示（あと ${hidden} 件）`, onclick: () => {
      const before = box.scrollHeight;
      S.showCount = (S.showCount || PAGE) + PAGE;
      render();
      box.scrollTop += box.scrollHeight - before;
    } }),
    ...path.flatMap((m, i) => (i < hidden ? [] : [messageEl(m, i), i === cut - 1 && h('div', { class: 'cutline', text: 'ここまで要約済み（これより上はあらすじとして送られます）' })])),
  ].filter(Boolean));
  if (!path.length && !S.error) {
    const conn = activeConn();
    const ready = conn?.apiKey || conn?.type === 'dummy';
    const starts = chatChars(S.chat).filter((c) => c.greeting?.trim());
    box.append(h('div', { class: 'empty' },
      ready ? 'メッセージを入力して始めましょう' : 'まず右上の歯車のマークから「接続先」にAPIキーを入力してください',
      starts.map((c) => h('div', { class: 'btnrow center' }, h('button', { text: `「${c.name}」の始まり方で始める`, onclick: () => startWith(c) })))));
  }
  if (S.error) {
    const leaf = S.msgs.get(S.chat.leafId);
    box.append(h('div', { class: 'errbox' }, S.error,
      leaf?.role === 'user' && h('div', { class: 'btnrow' }, h('button', { text: 'もう一度試す', onclick: () => generate(leaf.id) }))));
  }
  updateBar();
}

function updateBar() {
  const box = $('#messages');
  const bar = $('#scrollbar');
  const on = S.settings.ui.scrollbar;
  box.classList.toggle('custombar', on);
  const range = box.scrollHeight - box.clientHeight;
  bar.hidden = !on || range < 40;
  if (bar.hidden) return;
  const r = box.getBoundingClientRect();
  bar.style.top = `${r.top}px`;
  bar.style.height = `${r.height}px`;
  const thumb = Math.max(44, (r.height * box.clientHeight) / box.scrollHeight);
  bar.firstElementChild.style.height = `${thumb}px`;
  bar.firstElementChild.style.top = `${(box.scrollTop / range) * (r.height - thumb)}px`;
}

function dragBar(e) {
  const box = $('#messages');
  const r = box.getBoundingClientRect();
  const thumb = $('#scrollbar').firstElementChild.offsetHeight;
  const ratio = Math.min(1, Math.max(0, (e.clientY - r.top - thumb / 2) / (r.height - thumb)));
  box.scrollTop = ratio * (box.scrollHeight - box.clientHeight);
}

let bgUrl = '';
async function applyBg() {
  const box = $('#messages');
  const global = await db.kvGet('bg');
  const own = S.chat ? chatChars(S.chat).find((c) => c.bg)?.bg : null;
  const blob = own || global;
  if (bgUrl) URL.revokeObjectURL(bgUrl);
  bgUrl = blob ? URL.createObjectURL(blob) : '';
  box.classList.toggle('hasbg', !!blob);
  box.style.setProperty('--bgimg', blob ? `url("${bgUrl}")` : 'none');
  return !!global;
}

async function shrinkImage(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const cv = h('canvas', { width: Math.round(bmp.width * scale), height: Math.round(bmp.height * scale) });
  cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
  return new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.85));
}

async function setBg(file) {
  try {
    await db.kvSet('bg', await shrinkImage(file));
    await applyBg();
    renderSettings();
  } catch (e) {
    alert(`この画像は読み込めませんでした。\n${e.message}`);
  }
}

function openNote() {
  $('#sheetTitle').textContent = '今回の話';
  const ta = h('textarea', { class: 'big', value: S.chat.note || '', placeholder: 'このチャットだけの設定を書きます。\n例: 今回は文化祭の前日の話。ひよりと高坂がけんかするところから始める。' });
  $('#sheetBody').replaceChildren(
    h('p', { class: 'hint', text: 'プロンプト・キャラ表に加えて、このチャットのときだけAIに渡されます。画面には出ません。' }),
    ta,
    h('div', { class: 'btnrow' }, h('button', { class: 'primary', text: '保存', onclick: async () => {
      S.chat.note = ta.value;
      if (S.chats.includes(S.chat)) await db.put('chats', S.chat);
      closePanels();
      toast('保存しました');
    } })),
  );
  show('#sheet');
}

// 枝分かれの全体図。一本道の区間を1行にまとめ、分岐するたびに一段下げて表示する。
function openTree() {
  $('#sheetTitle').textContent = '分岐ツリー';
  const onPath = new Set(pathTo(S.chat.leafId).map((m) => m.id));
  const rows = [];
  const walk = (start, depth) => {
    let node = start;
    let count = 1;
    for (;;) {
      const kids = childrenOf(node.id);
      if (kids.length !== 1) {
        rows.push({ start, last: node, count, depth, kids });
        kids.forEach((k) => walk(k, depth + 1));
        return;
      }
      node = kids[0];
      count++;
    }
  };
  childrenOf(null).forEach((root) => walk(root, 0));

  const jump = (row) => {
    if (!onPath.has(row.last.id)) S.chat.leafId = deepest(row.last.id);
    const p = pathTo(S.chat.leafId);
    S.showCount = Math.max(S.showCount || PAGE, p.length - p.findIndex((m) => m.id === row.start.id) + 2);
    S.error = '';
    closePanels();
    saveChat();
    $(`#messages [data-id="${row.start.id}"]`)?.scrollIntoView({ block: 'start' });
  };
  const leaves = rows.filter((r) => !r.kids.length).length;
  $('#sheetBody').replaceChildren(
    h('p', { class: 'hint', text: rows.length ? `全部で ${S.msgs.size} 件、枝の先は ${leaves} 本あります。行をタップするとその枝に切り替わります。` : 'まだメッセージがありません。' }),
    ...rows.map((r) => h('div', { class: `treerow ${onPath.has(r.start.id) ? 'on' : ''}`, style: `margin-left:${Math.min(r.depth, 8) * 14}px` },
      h('button', { class: 'plain', onclick: () => jump(r) },
        h('div', { class: 't' }, icon(r.start.role === 'user' ? 'user' : 'ai'), expandImages(r.start.text).replace(IMG_URL, '〔画像〕').replace(/\s+/g, ' ').slice(0, 60) || '（添付のみ）'),
        h('div', { class: 'd', text: `${r.count} 件${r.kids.length ? `　→ ここから ${r.kids.length} つに分岐` : '　・枝の先'}${onPath.has(r.last.id) && !r.kids.length ? '　✔ 今ここ' : ''}　${stamp(r.last.createdAt)}` })),
      h('button', { class: 'iconbtn', 'aria-label': 'この枝を削除', onclick: async () => { await removeMessage(r.start); if (!$('#sheet').hidden) openTree(); } }, icon('trash')))),
  );
  show('#sheet');
}

const SUMMARY_PROMPT = `あなたは物語の記録係です。渡される小説・ロールプレイの本文を、続きを書くための「あらすじ」にまとめてください。

- 出来事を起きた順に書く。
- 登場人物それぞれの今の状態、気持ち、関係の変化を書く。
- 今いる場所と時間、まだ解決していないこと、約束や伏線を書く。
- 途中で決まった設定や呼び名があれば書く。
- 「これまでのあらすじ」が渡されたら、その内容を残したまま、続きの本文の分を足して1つにまとめ直す。
- 内容を和らげたり、評価や感想を加えたりしない。
- 2000字以内。あらすじの本文だけを出力する。`;

function summaryConn() {
  const cfg = S.settings.summary;
  const base = S.settings.connections.find((c) => c.id === cfg.connId) || activeConn();
  return base && { ...base, model: (cfg.connId && cfg.model) || base.model, tailUser: '', tailModel: '' };
}

async function summarize(manual) {
  if (S.summarizing) return;
  const chat = S.chat;
  const path = pathTo(chat.leafId);
  const keep = Math.max(2, Number(S.settings.summary.keep) || 10);
  const done = chat.summary ? path.findIndex((m) => m.id === chat.summary.uptoId) + 1 : 0;
  const end = path.length - keep;
  if (end - done < 2) {
    if (manual) alert(`まだ要約するほど長くありません。\n直近 ${keep} 件はそのまま残し、それより前を要約します。`);
    return;
  }
  const body = path.slice(done, end).map((m) => `${m.role === 'user' ? '【ユーザー】' : '【AI】'}\n${apiMessage(m).text}`).join('\n\n');
  const input = `${done ? `# これまでのあらすじ\n${chat.summary.text}\n\n` : ''}# 続きの本文\n${body}`;
  S.summarizing = true;
  if (!manual) toast('古い部分を要約しています…');
  try {
    let out = '';
    for await (const ev of streamChat(summaryConn(), { system: SUMMARY_PROMPT, messages: [{ role: 'user', text: input }] })) {
      if (ev.text) out += ev.text;
      if (ev.notice && !out) throw new Error(ev.notice);
    }
    if (!out.trim()) throw new Error('要約の返事が空でした。');
    chat.summary = { text: out.trim(), uptoId: path[end - 1].id, createdAt: Date.now() };
    chat.summaryOn = true;
    await db.put('chats', chat);
    toast(`${end} 件目までを要約しました`);
    if (S.chat === chat && !S.busy) { if ($('#sheet').hidden) render(); else openSummary(); }
  } catch (e) {
    if (manual) alert(`要約できませんでした。\n${e.message}`); else toast('要約に失敗しました（チャットはそのまま続けられます）');
  }
  S.summarizing = false;
}

function openSummary() {
  $('#sheetTitle').textContent = 'あらすじ（要約）';
  const chat = S.chat;
  const cfg = S.settings.summary;
  const path = pathTo(chat.leafId);
  const done = chat.summary ? path.findIndex((m) => m.id === chat.summary.uptoId) + 1 : 0;
  const saveChatOnly = () => (S.chats.includes(chat) ? db.put('chats', chat) : null);
  const ta = h('textarea', { class: 'big', value: chat.summary?.text || '', placeholder: 'まだ要約はありません。' });
  ta.addEventListener('input', () => { if (chat.summary) { chat.summary.text = ta.value; saveChatOnly(); } });
  const models = { '': '本文と同じモデルを使う' };
  for (const c of S.settings.connections) for (const name of c.type === 'dummy' ? ['ダミーAI'] : c.models) models[`${c.id}|${name}`] = `${c.name} / ${name}`;
  const pick = h('select', {}, Object.entries(models).map(([value, text]) => h('option', { value, text })));
  pick.value = cfg.connId ? `${cfg.connId}|${cfg.model}` : '';
  if (pick.selectedIndex < 0) pick.value = '';
  pick.addEventListener('change', () => { [cfg.connId, cfg.model] = pick.value ? pick.value.split('|') : ['', '']; saveSettings(); });
  const runBtn = h('button', { class: 'primary', text: '今すぐ要約する', onclick: async () => { runBtn.disabled = true; runBtn.textContent = '要約中…'; await summarize(true); if (!$('#sheet').hidden) openSummary(); } });
  $('#sheetBody').replaceChildren(
    h('p', { class: 'hint', text: '会話が長くなったら、古い部分をあらすじに置き換えてAIに送ります。料金が減り、序盤の内容も忘れにくくなります。画面の会話は消えません。' }),
    h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: chat.summaryOn !== false, onchange: (e) => { chat.summaryOn = e.target.checked; saveChatOnly(); } }), 'このチャットで要約を使う'),
    h('div', { class: 'hint', text: done ? `${path.length} 件のうち ${done} 件目までを要約済みです。下の文章は書き直せます。` : chat.summary ? '今見ている枝には、この要約は当てはまりません（別の枝で作った要約です）。' : '' }),
    ta,
    h('div', { class: 'btnrow' }, runBtn,
      chat.summary && h('button', { class: 'danger', text: '要約を消す', onclick: async () => { if (!confirm('要約を消して、全文を送る状態に戻しますか？')) return; delete chat.summary; await saveChatOnly(); openSummary(); } })),
    h('div', { class: 'card', style: 'margin-top:14px' },
      h('strong', { text: '要約の設定（全チャット共通）' }),
      field('要約に使うモデル', pick, '安いモデルで十分です。'),
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: !!cfg.auto, onchange: (e) => { cfg.auto = e.target.checked; saveSettings(); } }), '長くなったら自動で要約する'),
      field('要約していないメッセージがこの件数を超えたら要約', bound(cfg, 'threshold', saveSettings, { type: 'number', min: '6', inputMode: 'numeric' })),
      field('直近この件数は要約せずそのまま送る', bound(cfg, 'keep', saveSettings, { type: 'number', min: '2', inputMode: 'numeric' }))),
  );
  show('#sheet');
}

function saveText(list) {
  const name = `${(S.chat.title || 'チャット').replace(/[\\/:*?"<>|\n]/g, '_')}.txt`;
  closePanels();
  return saveFile(new File([list.map((m) => m.text).join('\n\n')], name, { type: 'text/plain' }));
}

function openChatMenu() {
  $('#sheetTitle').textContent = 'このチャット';
  const path = pathTo(S.chat.leafId);
  const item = (ic, text, fn) => h('div', { class: 'row' }, h('button', { class: 'plain withic', onclick: fn }, icon(ic), text));
  const foldAll = async (collapsed) => {
    path.forEach((m) => (m.collapsed = collapsed));
    closePanels();
    await db.putMany('messages', path);
  };
  const copy = (list) => navigator.clipboard.writeText(list.map((m) => m.text).join('\n\n')).then(() => { toast('コピーしました'); closePanels(); });
  $('#sheetBody').replaceChildren(
    item('pencil', '名前を変える', async () => {
      const name = prompt('チャットの名前', S.chat.title);
      if (name == null) return;
      S.chat.title = name.trim();
      if (S.chats.includes(S.chat)) await db.put('chats', S.chat);
      closePanels();
    }),
    item('book', `今回の話${S.chat.note?.trim() ? '（設定あり）' : ''}`, openNote),
    item('phone', 'スマホをのぞく', phone.openPeekSheet),
    item('gauge', '使用量（トークン・キャッシュ）', openUsage),
    item('branch', '分岐ツリー', openTree),
    item('summary', `あらすじ（要約）${S.chat.summary ? (S.chat.summaryOn === false ? '（オフ）' : '（あり）') : ''}`, openSummary),
    item('fold', 'すべてたたむ', () => foldAll(true)),
    item('unfold', 'すべてひらく', () => foldAll(false)),
    item('copy', '全文をコピー（今見えている枝）', () => copy(path)),
    item('copy', 'AIの文章だけコピー', () => copy(path.filter((m) => m.role === 'assistant'))),
    item('save', 'テキストファイルで保存（全文）', () => saveText(path)),
    item('save', 'テキストファイルで保存（AIの文章だけ）', () => saveText(path.filter((m) => m.role === 'assistant'))),
  );
  show('#sheet');
}

async function startWith(c) {
  const m = { id: uid(), chatId: S.chat.id, parentId: null, role: 'assistant', text: fillNames(S.chat, c.greeting.trim()), createdAt: Date.now() };
  S.msgs.set(m.id, m);
  S.chat.leafId = m.id;
  if (!S.chat.title) S.chat.title = c.name;
  render();
  await Promise.all([db.put('messages', m), saveChat()]);
}

// ---------- 会話の操作 ----------
// 保存してあるメッセージを、APIに送る形にする（テキスト添付は本文に足し、画像は別に渡す）
function apiMessage(m) {
  const texts = (m.files || []).filter((f) => f.kind === 'text').map((f) => `【添付ファイル: ${f.name}】\n${f.text}`);
  return {
    role: m.role,
    text: [m.text, ...texts].filter(Boolean).join('\n\n'),
    images: (m.files || []).filter((f) => f.kind === 'image').map((f) => ({ mime: f.mime, data: f.data })),
  };
}

function renderPending() {
  const box = $('#pending');
  box.hidden = !S.pending.length;
  box.replaceChildren(...S.pending.map((f) => h('button', { onclick: () => { S.pending = S.pending.filter((x) => x !== f); renderPending(); } }, icon(f.kind === 'image' ? 'image' : 'clip'), `${f.name} ✕`)));
  updateBar();
}

async function addFiles(files) {
  for (const f of files) {
    try {
      if (f.type.startsWith('image/')) {
        const url = await toDataUrl(await shrinkImage(f));
        S.pending.push({ kind: 'image', name: f.name, mime: 'image/jpeg', data: url.slice(url.indexOf(',') + 1) });
      } else {
        S.pending.push({ kind: 'text', name: f.name, text: await f.text() });
      }
    } catch (e) {
      alert(`「${f.name}」を読み込めませんでした。\n${e.message}`);
    }
  }
  renderPending();
}

const continueFrom = (m) => generate(m.id, { extraUser: S.settings.ui.continueText.trim() || '続きを書いてください。' });

async function generate(parentId, opts = {}) {
  if (S.busy) return;
  const conn = activeConn();
  const fullPath = pathTo(parentId);
  let cut = summaryCut(S.chat, [...fullPath, {}]);
  if (cut >= fullPath.length) cut = 0;
  const history = fullPath.slice(cut).map(apiMessage);
  const { system, loaded } = buildSystem(S.chat, history.slice(-4).map((x) => x.text).join('\n'), cut ? S.chat.summary.text : '');
  if (opts.extraUser) history.push({ role: 'user', text: opts.extraUser });
  if (conn?.tailUser?.trim()) history.push({ role: 'user', text: conn.tailUser });
  const prefill = conn?.tailModel?.trim() ? conn.tailModel : '';
  if (prefill) history.push({ role: 'assistant', text: prefill });
  let got = false;
  const m = { id: uid(), chatId: S.chat.id, parentId, role: 'assistant', text: prefill && conn.tailJoin ? prefill : '', thought: '', createdAt: Date.now() };
  if (loaded.length) m.loaded = loaded;
  m.model = modelLabel(conn) + (S.settings.connections.length > 1 && conn?.type !== 'dummy' ? `（${conn.name}）` : '');
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
      body.textContent = got || m.text ? m.text : waiting();
      updateBar();
      if (stick && ui.autoScroll) scrollBottom();
    });
  };

  const ticker = setInterval(() => { if (!m.text) paint(); }, 1000);
  try {
    for await (const ev of streamChat(conn, { system, messages: history, signal: S.abort.signal })) {
      if (ev.text) { m.text += ev.text; got = true; }
      if (ev.thought) m.thought += ev.thought;
      if (ev.notice) m.notice = ev.notice;
      if (ev.usage) m.usage = ev.usage;
      paint();
    }
  } catch (e) {
    if (e.name !== 'AbortError') S.error = e.message;
  }

  clearInterval(ticker);
  S.busy = false;
  if (got) {
    await db.put('messages', m);
  } else {
    S.msgs.delete(m.id);
    if (chat.leafId === m.id) chat.leafId = parentId;
    if (!S.error && !S.abort.signal.aborted) S.error = m.notice || '返事が空でした。もう一度試してください。';
  }
  if (S.chat === chat) { await saveChat(); render(); } else { await db.put('chats', chat); }
  if (got && S.chat === chat && S.settings.summary.auto) {
    const p = pathTo(chat.leafId);
    if (p.length - summaryCut(chat, p) > Number(S.settings.summary.threshold || 40)) summarize(false);
  }
}

async function send() {
  if (S.busy) { S.abort.abort(); return; }
  const input = $('#input');
  const text = input.value.trim();
  const leaf = S.msgs.get(S.chat.leafId);
  if (!text && !S.pending.length) {
    if (leaf?.role === 'user') generate(leaf.id);
    else if (leaf) continueFrom(leaf);
    return;
  }
  const m = { id: uid(), chatId: S.chat.id, parentId: S.chat.leafId ?? null, role: 'user', text, createdAt: Date.now() };
  if (S.pending.length) { m.files = S.pending; S.pending = []; renderPending(); }
  S.msgs.set(m.id, m);
  S.chat.leafId = m.id;
  if (!S.chat.title) S.chat.title = (text || m.files[0].name).replace(/\s+/g, ' ').slice(0, 24);
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
  if (m.files) copy.files = m.files;
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
const PANELS = ['#drawer', '#sheet', '#settings', '#phone'];

function show(sel) {
  PANELS.forEach((p) => ($(p).hidden = p !== sel));
  $('#backdrop').hidden = false;
}

function closePanels() {
  flushSaves();
  PANELS.forEach((p) => ($(p).hidden = true));
  $('#backdrop').hidden = true;
  render();
}

const stamp = (t) => new Date(t).toLocaleString('ja-JP', { year: '2-digit', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

function pickFile(accept, fn) {
  const el = h('input', { type: 'file', accept, onchange: () => el.files[0] && fn(el.files[0]) });
  el.click();
}

let chatQuery = '';
let bodyIndex = null;

async function searchChats(q) {
  chatQuery = q.trim();
  if (chatQuery && !bodyIndex) {
    bodyIndex = new Map();
    for (const m of await db.all('messages')) bodyIndex.set(m.chatId, `${bodyIndex.get(m.chatId) || ''}\n${m.text}`);
  }
  openDrawer(true);
}

function openDrawer(keepSearch) {
  if (keepSearch !== true) { chatQuery = ''; bodyIndex = null; $('#chatSearch').value = ''; }
  const hit = (c) => !chatQuery || (c.title || '').includes(chatQuery) || (bodyIndex?.get(c.id) || '').includes(chatQuery);
  $('#drawerTools').replaceChildren(
    h('button', { text: '全出力', onclick: exportData }),
    h('button', { text: '取込', onclick: () => pickFile('.json,application/json', (f) => importData(f).then(openDrawer)) }),
    h('button', { text: 'テキスト取込', onclick: () => pickFile('.txt,text/plain', importText) }),
  );
  $('#chatList').replaceChildren(...S.chats
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .filter(hit)
    .map((c) => h('div', { class: `chatrow ${c === S.chat ? 'on' : ''}` },
      h('button', { class: 'plain', onclick: async () => { await openChat(c); closePanels(); } },
        h('div', { class: 't', text: c.title || '（無題）' }),
        h('div', { class: 'd', text: `作成 ${stamp(c.createdAt)}　更新 ${stamp(c.updatedAt)}` })),
      h('div', { class: 'acts' },
        h('button', { 'aria-label': '名前を変える', onclick: async () => {
          const name = prompt('チャットの名前', c.title);
          if (name == null) return;
          c.title = name.trim();
          await db.put('chats', c);
          render();
          openDrawer();
        } }, icon('pencil')),
        h('button', { text: '出力', onclick: () => exportChat(c) }),
        h('button', { text: '複製', onclick: () => duplicateChat(c) }),
        h('button', { class: 'danger', text: '削除', onclick: () => removeChat(c) })),
    )));
  if (!$('#chatList').children.length) $('#chatList').append(h('p', { class: 'hint', text: chatQuery ? '見つかりませんでした。' : 'まだチャットはありません。' }));
  show('#drawer');
}

async function exportChat(c) {
  const messages = await db.messagesOf(c.id);
  const data = { app: 'sousaku-pwa', version: 1, exportedAt: new Date().toISOString(), chats: [c], messages, chars: await packChars(chatChars(c)) };
  await saveFile(new File([JSON.stringify(data)], `${(c.title || 'チャット').replace(/[\\/:*?"<>|\n]/g, '_')}.json`, { type: 'application/json' }));
}

async function duplicateChat(c) {
  const msgs = await db.messagesOf(c.id);
  const ids = new Map(msgs.map((m) => [m.id, uid()]));
  const copy = { ...c, id: uid(), title: `${c.title || '無題'}（複製）`, createdAt: Date.now(), updatedAt: Date.now(), leafId: ids.get(c.leafId) ?? null };
  if (c.summary) copy.summary = { ...c.summary, uptoId: ids.get(c.summary.uptoId) };
  await db.putMany('messages', msgs.map((m) => ({ ...m, id: ids.get(m.id), chatId: copy.id, parentId: m.parentId ? ids.get(m.parentId) : null })));
  await db.put('chats', copy);
  S.chats.unshift(copy);
  openDrawer();
  toast('複製しました');
}

async function importText(file) {
  const text = (await file.text()).trim();
  if (!text) { alert('ファイルが空です。'); return; }
  const chat = { ...blankChat(), title: file.name.replace(/\.[^.]+$/, '') };
  const m = { id: uid(), chatId: chat.id, parentId: null, role: 'assistant', text, createdAt: Date.now() };
  chat.leafId = m.id;
  await db.put('messages', m);
  await openChat(chat);
  await saveChat();
  closePanels();
  toast('テキストを新しいチャットとして取り込みました');
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

function openCharSheet() {
  $('#sheetTitle').textContent = 'このチャットで使うもの';
  const ids = (S.chat.charIds ||= []);
  const toggle = async (c) => {
    const i = ids.indexOf(c.id);
    if (i >= 0) ids.splice(i, 1);
    else {
      if (c.type === 'hero') for (const o of S.chars) if (o.type === 'hero' && ids.includes(o.id)) ids.splice(ids.indexOf(o.id), 1);
      ids.push(c.id);
    }
    S.settings.lastCharIds = [...ids];
    await saveSettings();
    if (S.chats.includes(S.chat)) await db.put('chats', S.chat);
    applyBg();
    openCharSheet();
  };
  const group = (type, title) => {
    const list = S.chars.filter((c) => (c.type || 'char') === type);
    return [h('p', { class: 'grouphead', text: title }),
      ...list.map((c) => h('div', { class: `row ${ids.includes(c.id) ? 'on' : ''}` },
        h('button', { class: 'plain', text: `${ids.includes(c.id) ? '✔' : '　'} ${c.name || '（名前なし）'}`, onclick: () => toggle(c) }))),
      !list.length && h('p', { class: 'hint', text: 'まだありません。' })];
  };
  $('#sheetBody').replaceChildren(...[
    ...group('hero', '主人公（1人だけ選べます）'),
    ...group('char', '登場人物（何人でも）'),
    ...group('world', '世界設定（いくつでも）'),
    ...group('doc', '資料（いくつでも）'),
    h('div', { class: 'btnrow' }, h('button', { text: '追加・編集する', onclick: () => openSettings('chars') })),
  ].filter(Boolean));
  show('#sheet');
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
  // iPhoneでは入力欄からフォーカスが外れないまま画面を閉じられることがあるので、
  // 入力のたびに値を反映し、少し待ってから保存する。
  let timer = 0;
  const flush = () => { clearTimeout(timer); pendingSaves.delete(flush); save(); };
  el.addEventListener('input', () => {
    obj[key] = el.value;
    clearTimeout(timer);
    pendingSaves.add(flush);
    timer = setTimeout(flush, 700);
  });
  el.addEventListener('change', () => { obj[key] = el.value; flush(); });
  return el;
}

const pendingSaves = new Set();
const flushSaves = () => [...pendingSaves].forEach((f) => f());

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
      result.textContent = text ? `【成功】つながりました\n返事: ${text}` : '【注意】つながりましたが、返事が空でした。';
    } catch (e) {
      result.textContent = `【失敗】${e.message}`;
    }
    btn.disabled = false;
  };

  const card = h('details', { class: `card ${isActive ? 'active' : ''}`, open: S.openCard === c.id },
    h('summary', { text: `${c.name || '（名前なし）'}${isActive ? '　✔ 使用中' : ''}` }),
    field('名前', bound(c, 'name', () => { saveSettings(); card.querySelector('summary').textContent = `${c.name || '（名前なし）'}${isActive ? '　✔ 使用中' : ''}`; }, { type: 'text' })),
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
!isDummy && h('details', { class: 'sub' },
      h('summary', { text: 'ダミープロンプト（上級者向け）' }),
      h('div', { class: 'hint', text: '送信するたびに、会話の最後へ自動で付け足す文章です。画面や履歴には残りません。空欄なら何もしません。' }),
      field('ダミーUserプロンプト', bound(c, 'tailUser', saveSettings, { placeholder: '例: 上記の続きを、設定を守って書いてください。' }, 'textarea')),
      field('ダミーModelプロンプト（返事の書き出し）', bound(c, 'tailModel', saveSettings, { placeholder: '例: 承知しました。続きを書きます。' }, 'textarea'), 'モデルによっては対応しておらず、エラーになることがあります。'),
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: !!c.tailJoin, onchange: (e) => { c.tailJoin = e.target.checked; saveSettings(); } }), 'ダミーModelの文章を返事の先頭につなげて表示する')),
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

const TIDY_PROMPT = `あなたは編集者です。ユーザーが渡すロールプレイ用の設定文を、内容を変えずに整理して、次のJSONだけを出力してください。前置きや説明、コードブロックの記号は書かないでください。

{"name": "人物の名前", "core": "...", "detail": "...", "keywords": ["..."], "greeting": "..."}

- core: 毎回読み込む要点。名前、外見、一人称や口調、性格、相手との関係、必ず守るルールを、箇条書きで800字以内にまとめる。
- detail: core に入らなかった細かい設定すべて。背景、世界観、隠し設定、台詞の例、展開の案など。情報を削らない。
- keywords: この人物を指す呼び名（名前、愛称、肩書き）の配列。
- greeting: 冒頭の場面（イントロ、最初のメッセージ）があれば一字一句そのまま。なければ空文字。
- 同じ内容が重複している箇所は1つにまとめる。
- 設定の中身や表現を言い換えたり、和らげたり、付け足したりしない。`;

async function tidyCard(c, btn) {
  const source = [c.core, c.detail, c.greeting && `【イントロ】\n${c.greeting}`].filter(Boolean).join('\n\n');
  if (!source.trim()) { alert('先に設定文を貼り付けてください。'); return; }
  if (!confirm(`今選んでいるモデル（${modelLabel(activeConn())}）に設定文を送り、整理したカードを新しく作ります。\n元のカードはそのまま残ります。`)) return;
  btn.disabled = true;
  btn.textContent = '整理中…（1分ほどかかることがあります）';
  try {
    let out = '';
    for await (const ev of streamChat({ ...activeConn(), tailUser: '', tailModel: '' }, { system: TIDY_PROMPT, messages: [{ role: 'user', text: source }] })) {
      if (ev.text) out += ev.text;
      if (ev.notice && !out) throw new Error(ev.notice);
    }
    const json = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
    const made = {
      id: uid(), type: c.type || 'char', createdAt: Date.now(),
      name: `${json.name || c.name}（整理版）`,
      core: String(json.core || ''), detail: String(json.detail || ''),
      keywords: [].concat(json.keywords || []).join('、'), greeting: String(json.greeting || c.greeting || ''),
    };
    S.chars.push(made);
    S.openCard = made.id;
    await db.put('chars', made);
    renderSettings();
    toast('整理したカードを作りました');
  } catch (e) {
    alert(`整理できませんでした。\n${e instanceof SyntaxError ? 'AIの返事が決まった形になっていませんでした。もう一度試すか、別のモデルで試してください。' : e.message}`);
    btn.disabled = false;
    btn.replaceChildren(icon('spark'), 'AIに整理してもらう');
  }
}

function charCard(c) {
  const save = () => db.put('chars', c);
  const type = c.type || 'char';
  const simple = type === 'hero' || type === 'doc';
  const bgPick = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: async () => {
    if (!bgPick.files[0]) return;
    try { c.bg = await shrinkImage(bgPick.files[0]); await save(); applyBg(); renderSettings(); } catch (e) { alert(`この画像は読み込めませんでした。\n${e.message}`); }
  } });
  const card = h('details', { class: 'card', open: S.openCard === c.id },
    h('summary', { text: c.name || '（名前なし）' }),
    field('名前', bound(c, 'name', () => { save(); card.querySelector('summary').textContent = c.name || '（名前なし）'; }, { type: 'text' })),
    field('種類', select(c, 'type', CHAR_TYPES, () => { save(); renderSettings(); })),
    simple
      ? field(type === 'doc' ? '本文' : '設定', bound(c, 'core', save, { class: 'big', placeholder: type === 'doc' ? '設定資料やこれまでの本文などを、そのまま貼り付けます。' : '年齢、容姿、性格、立場など。話によって主人公を変えたいときは、カードを複数作って切り替えます。' }, 'textarea'), `これを選んだチャットで、毎回まるごとAIに渡されます。${type === 'doc' ? `（今 ${(c.core || '').length.toLocaleString()} 文字）` : ''}`)
      : field(type === 'world' ? '基本（いつも読み込む）' : '核（いつも読み込む）', bound(c, 'core', save, { class: 'big', placeholder: type === 'world' ? '世界のあらまし、時代、決まりごとなど。短くまとめます。' : '性格、口調、一人称、外見など。他のアプリ用に書いた設定文を、そのまままるごと貼り付けても大丈夫です。' }, 'textarea'), 'このチャットで使うと決めたら、毎回AIに渡されます。'),
    !simple && field(type === 'world' ? '詳細（キーワードが出たときだけ読み込む）' : '詳細（名前が出たときだけ読み込む）', bound(c, 'detail', save, { class: 'big', placeholder: type === 'world' ? '地名、組織、用語、歴史など。長くても大丈夫です。' : '過去、人間関係、細かい設定、台詞の例など。長くても大丈夫です。' }, 'textarea'), '直近4つのメッセージに、名前か下のキーワードが出てきたときだけAIに渡されます。'),
    !simple && field('キーワード（「、」で区切る）', bound(c, 'keywords', save, { type: 'text', placeholder: type === 'world' ? '例: 王都、騎士団、魔法学院' : '例: ひよ、日和、先輩' })),
    type === 'char' && field('始まり方（最初のメッセージ）', bound(c, 'greeting', save, { class: 'big', placeholder: '新しいチャットでこの人物を選ぶと、「この始まり方で始める」ボタンが出ます。空欄なら出ません。' }, 'textarea')),
    type === 'char' && h('div', { class: 'f' }, '背景画像（この人物を使うチャットの背景）',
      h('div', { class: 'btnrow' },
        h('button', { text: c.bg ? '画像を変える' : '画像を選ぶ', onclick: () => bgPick.click() }),
        c.bg && h('button', { class: 'danger', text: 'やめる', onclick: async () => { delete c.bg; await save(); applyBg(); renderSettings(); } }),
        bgPick)),
    h('div', { class: 'btnrow' },
      type === 'char' && h('button', { onclick: (e) => tidyCard(c, e.currentTarget) }, icon('spark'), 'AIに整理してもらう'),
      h('button', { class: 'danger', text: '削除', onclick: async () => {
      if (!confirm(`「${c.name}」を削除しますか？`)) return;
      S.chars = S.chars.filter((x) => x !== c);
      await db.del('chars', c.id);
      renderSettings();
    } })),
  );
  card.addEventListener('toggle', () => { if (card.open) S.openCard = c.id; else if (S.openCard === c.id) S.openCard = null; });
  return card;
}

const toDataUrl = (blob) => new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
const packChars = (list) => Promise.all(list.map(async (c) => (c.bg instanceof Blob ? { ...c, bg: await toDataUrl(c.bg) } : c)));
const unpackChars = (list) => Promise.all(list.map(async (c) => (typeof c.bg === 'string' ? { ...c, bg: await (await fetch(c.bg)).blob() } : c)));

async function refreshApp() {
  try {
    for (const r of await navigator.serviceWorker?.getRegistrations?.() || []) await r.unregister();
    for (const k of await caches.keys()) await caches.delete(k);
  } catch { /* 消せなくても読み込み直しは試す */ }
  location.reload();
}

// 起動に失敗したときの画面。データには触れず、書き出しと更新だけできるようにする。
function showFatal(e) {
  $('#messages').replaceChildren(h('div', { class: 'errbox' },
    `アプリの起動に失敗しました。保存してあるデータは消えていません。\n\n（${e?.message || e}）`,
    h('div', { class: 'btnrow' },
      h('button', { text: 'データをファイルに書き出す', onclick: () => exportData().catch((x) => alert(`書き出せませんでした。\n${x.message}`)) }),
      h('button', { text: 'キャッシュを削除して開き直す', onclick: refreshApp }))));
}

async function exportData() {
  const [chats, messages, prompts, chars] = await Promise.all([db.all('chats'), db.all('messages'), db.all('prompts'), db.all('chars')]);
  // 巨大な1本の文字列を作るとメモリ不足で失敗しやすいので、1件ずつ小分けにしてファイルにする
  const parts = [`{"app":"sousaku-pwa","version":1,"exportedAt":"${new Date().toISOString()}"`];
  for (const [key, list] of Object.entries({ chats, messages, prompts, chars: await packChars(chars) })) {
    parts.push(`,"${key}":[`);
    list.forEach((item, i) => parts.push((i ? ',' : '') + JSON.stringify(item)));
    parts.push(']');
  }
  parts.push('}');
  await saveFile(new File(parts, `sousaku-backup-${new Date().toISOString().slice(0, 10)}.json`, { type: 'application/json' }));
}

async function saveFile(file) {
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = h('a', { href: URL.createObjectURL(file), download: file.name });
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
    await db.putMany('chars', await unpackChars(data.chars || []));
    await loadAll();
    if (!$('#settings').hidden) renderSettings();
    toast(`読み込みました（チャット ${data.chats?.length || 0} 件）`);
  } catch (e) {
    alert(`読み込めませんでした。\n${e.message}`);
  }
}

function renderSettings() {
  flushSaves();
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
      h('p', { class: 'hint', text: '執筆用・ロールプレイ用などを保存しておき、チャット画面上部のプロンプト名をタップして切り替えます。' }),
      ...S.prompts.map(promptCard),
      h('button', { class: 'wide', text: '＋ プロンプトを追加', onclick: async () => {
        const p = { id: uid(), name: '新しいプロンプト', text: '', createdAt: Date.now() };
        S.prompts.push(p);
        S.openCard = p.id;
        await db.put('prompts', p);
        renderSettings();
      } }),
    );
  } else if (S.tab === 'chars') {
    const section = (type, title, hint, label) => [
      h('h3', { class: 'grouphead', text: title }),
      h('p', { class: 'hint', text: hint }),
      ...S.chars.filter((c) => (c.type || 'char') === type).map(charCard),
      h('button', { class: 'wide', text: `＋ ${label}を追加`, onclick: async () => {
        const c = { id: uid(), name: `新しい${label}`, type, core: '', detail: '', keywords: '', greeting: '', createdAt: Date.now() };
        S.chars.push(c);
        S.openCard = c.id;
        await db.put('chars', c);
        renderSettings();
      } }),
    ];
    body.replaceChildren(
      h('p', { class: 'hint', text: 'ここで作ったカードを、チャット画面上部の人のマークから、そのチャットで使うものだけ選びます。' }),
      ...section('hero', '主人公', '自分が演じる・語る人物。話によって変えたいときは複数作って、チャットごとに1人選びます。', '主人公'),
      ...section('char', '登場人物', '相手役や脇役。人数が多くても、詳細は名前が出た人の分だけ読み込まれます。', '登場人物'),
      ...section('world', '世界設定', '舞台や用語。キーワードが出たときだけ詳細を読み込みます（他のアプリの「ロアブック」と同じ働きです）。', '世界設定'),
      ...section('doc', '資料', '設定をまとめたテキストを、分けずにまるごと読み込ませたいとき用です。Geminiのノートブックや、Claudeのプロジェクトに入れるテキストと同じ使い方ができます。', '資料'),
      h('button', { class: 'wide', style: 'margin-top:8px', text: '＋ テキストファイルから資料を追加（複数可）', onclick: () => {
        const el = h('input', { type: 'file', accept: '.txt,.md,text/plain,text/markdown', multiple: true, onchange: async () => {
          for (const f of el.files) {
            const c = { id: uid(), name: f.name.replace(/\.[^.]+$/, ''), type: 'doc', core: await f.text(), detail: '', keywords: '', greeting: '', createdAt: Date.now() };
            S.chars.push(c);
            await db.put('chars', c);
          }
          renderSettings();
          toast(`${el.files.length} 件の資料を追加しました`);
        } });
        el.click();
      } }),
    );
  } else if (S.tab === 'ui') {
    const ui = S.settings.ui;
    const save = () => { saveSettings(); applyUi(); };
    const bgPicker = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: async () => { if (bgPicker.files[0]) { await setBg(bgPicker.files[0]); S.hasBg = true; renderSettings(); } } });
    const range = (key, min, max) => {
      const el = h('input', { type: 'range', min, max, value: ui[key] });
      el.addEventListener('input', () => { ui[key] = Number(el.value); applyUi(); el.parentElement.firstChild.textContent = el.parentElement.firstChild.textContent.replace(/\d+％/, `${el.value}％`); });
      el.addEventListener('change', save);
      return el;
    };
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
        h('strong', { text: '背景画像' }),
        h('div', { class: 'btnrow' },
          h('button', { text: S.hasBg ? '画像を変える' : '画像を選ぶ', onclick: () => bgPicker.click() }),
          S.hasBg && h('button', { class: 'danger', text: '背景をやめる', onclick: async () => { await db.del('kv', 'bg'); S.hasBg = await applyBg(); renderSettings(); } }),
          bgPicker),
        field(`背景の薄さ（${ui.bgVeil}％）`, range('bgVeil', 0, 100), '大きいほど画像が薄くなり、文字が読みやすくなります。'),
        h('div', { class: 'hint', text: 'ここで選ぶのは全体の背景です。登場人物のカードに背景画像を付けると、その人物を使うチャットではそちらが優先されます。' }),
        field(`吹き出しの濃さ（${ui.bubbleAlpha}％）`, range('bubbleAlpha', 20, 100), '小さいほど吹き出しが透けて、背景が見えます。')),
      h('div', { class: 'card' },
        h('strong', { text: '画像URLの短縮書き' }),
        h('div', { class: 'hint', text: 'ベースURLを入れておくと、AIが [[ひより/笑顔]] と書いただけで画像として表示します。プロンプトには「画像は [[キャラ名/表情]] の形で書く」と指示してください。空欄なら使いません。' }),
        field('ベースURL', bound(ui, 'imgBase', save, { type: 'text', placeholder: 'https://example.netlify.app/', inputMode: 'url', autocapitalize: 'off' })),
        field('拡張子', bound(ui, 'imgExt', save, { type: 'text', placeholder: '.avif', autocapitalize: 'off' }))),
      h('div', { class: 'card' },
        h('strong', { text: '操作' }),
        check('replaceUser', '設定文の「User」を主人公の名前に置き換える', '主人公を選んでいるチャットで、キャラ設定や始まり方に書かれた「User」「{{user}}」を主人公の名前に変えてからAIに渡します。'),
        check('scrollbar', '右端にスクロールバーを表示する', '指でつまんで動かすと、長い会話をすばやく移動できます。'),
        field('「続き」ボタンでAIに送る指示', bound(ui, 'continueText', save, { type: 'text' }), '最後の返事の下の「続き」を押すと、この文章をこっそり送って続きを書かせます。画面には残りません。'),
        check('autoScroll', '返事が届いている間、自動で下へスクロールする'),
        check('showTimer', '返事を待っている間、秒数を表示する'),
        check('enterSend', 'Enterキーで送信する', 'オンにすると、iPhoneのキーボードでは「改行」キーで送信されます（改行できなくなります）。外付けキーボードやPC向けです。Shift+Enterで改行できます。'),
        check('skipDeleteConfirm', 'メッセージ削除のときに確認しない')),
      h('div', { class: 'card' },
        h('strong', { text: 'メッセージのボタン' }),
        field('ボタンの出し方', select(ui, 'toolsMode', { always: 'いつも表示する', tap: '吹き出しをタップしたときだけ表示する' }, save), '「タップしたときだけ」でも、最後のメッセージにはいつも表示されます。'),
        check('toolColors', 'ボタンを色分けする'),
        check('showMeta', '番号・モデル名・時刻を吹き出しに表示する')),
    );
  } else {
    const usage = h('p', { class: 'hint', text: '' });
    navigator.storage?.estimate?.().then(async (e) => {
      const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
      usage.textContent = `保存しているデータ: 約 ${mb(e.usage || 0)}（チャット ${S.chats.length} 件）。この端末で使える目安: ${mb(e.quota || 0)}`;
    }).catch(() => {});
    const picker = h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: () => picker.files[0] && importData(picker.files[0]) });
    body.replaceChildren(
      h('div', { class: 'card' },
        h('strong', { text: '書き出し（バックアップ）' }),
        h('p', { class: 'hint', text: 'チャット・枝分かれ・プロンプト・キャラ表を1つのファイルに保存します。APIキーは含まれません。' }),
        h('button', { class: 'primary', text: 'ファイルに書き出す', onclick: exportData })),
      h('div', { class: 'card' },
        h('strong', { text: '読み込み' }),
        h('p', { class: 'hint', text: '書き出したファイルを読み込みます。今あるチャットは消えず、追加されます。' }),
        h('button', { text: 'ファイルを選ぶ', onclick: () => picker.click() }), picker),
      h('div', { class: 'card' },
        h('strong', { text: 'キャッシュ削除・アプリを更新' }),
        h('p', { class: 'hint', text: 'アプリ本体のキャッシュ（一時保存）を削除して、最新版を読み込み直します。新しい機能が反映されないときや、動きが重い・おかしいときに押してください。チャット・設定・APIキーは消えません。' }),
        h('button', { text: 'キャッシュを削除して開き直す', onclick: refreshApp })),
      usage,
      h('div', { class: 'card' },
        h('strong', { text: 'すべて消す' }),
        h('p', { class: 'hint', text: 'チャット・プロンプト・接続先（APIキー）をすべて削除します。元に戻せません。' }),
        h('button', { class: 'danger', text: '全データを削除する', onclick: async () => {
          if (!confirm('チャット・プロンプト・APIキーをすべて削除します。\n本当によろしいですか？')) return;
          if (!confirm('元に戻せません。先に「ファイルに書き出す」でバックアップを取りましたか？\nOKを押すと削除します。')) return;
          await Promise.all(['chats', 'messages', 'prompts', 'chars', 'kv'].map(async (st) => db.delMany(st, (await db.all(st)).map((x) => x.id ?? x.key))));
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
  const [settings, prompts, chats, chars] = await Promise.all([db.kvGet('settings'), db.all('prompts'), db.all('chats'), db.all('chars')]);
  S.chars = chars.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const uiDefaults = S.settings.ui;
  Object.assign(S.settings, settings);
  S.settings.ui = { ...uiDefaults, ...settings?.ui };
  S.settings.summary = { connId: '', model: '', auto: false, threshold: 40, keep: 10, ...settings?.summary };
  applyUi();
  const hasBg = await applyBg();
  S.hasBg = hasBg;
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
let jumpTimer = 0;
$('#btnBottom').addEventListener('click', scrollBottom);
$('#btnTop').addEventListener('click', () => { $('#messages').scrollTop = 0; });
$('#messages').addEventListener('scroll', updateBar, { passive: true });
window.addEventListener('resize', updateBar);
$('#scrollbar').addEventListener('pointerdown', (e) => { e.currentTarget.setPointerCapture(e.pointerId); e.currentTarget.classList.add('drag'); dragBar(e); });
$('#scrollbar').addEventListener('pointermove', (e) => { if (e.currentTarget.classList.contains('drag')) dragBar(e); });
for (const ev of ['pointerup', 'pointercancel']) $('#scrollbar').addEventListener(ev, (e) => e.currentTarget.classList.remove('drag'));
$('#messages').addEventListener('scroll', () => {
  const box = $('#messages');
  $('#btnBottom').hidden = box.scrollHeight - box.scrollTop - box.clientHeight < 300;
  $('#btnTop').hidden = box.scrollTop < 300;
  // ジャンプボタンはスクロール中だけ出し、止まったら消す（メッセージのボタンに重ならないように）
  document.querySelectorAll('.jump').forEach((b) => b.classList.add('show'));
  clearTimeout(jumpTimer);
  jumpTimer = setTimeout(() => document.querySelectorAll('.jump').forEach((b) => b.classList.remove('show')), 2500);
}, { passive: true });
$('#btnAttach').addEventListener('click', () => {
  const el = h('input', { type: 'file', accept: 'image/*,.txt,.md,text/plain,text/markdown', multiple: true, onchange: () => addFiles(el.files) });
  el.click();
});
$('#btnDrawer').addEventListener('click', openDrawer);
$('#chatSearch').addEventListener('input', (e) => searchChats(e.target.value));
$('#btnNewChat').addEventListener('click', async () => { await openChat(blankChat()); closePanels(); });
$('#btnSettings').addEventListener('click', () => openSettings());
$('#promptChip').addEventListener('click', openPromptSheet);
$('#modelChip').addEventListener('click', openModelSheet);
$('#charChip').addEventListener('click', openCharSheet);
$('#btnImages').addEventListener('click', () => {
  S.settings.showImages = !S.settings.showImages;
  saveSettings();
  render();
  toast(S.settings.showImages ? '画像を表示します' : '画像を隠します');
});
$('#chatTitle').addEventListener('click', openChatMenu);
$('#backdrop').addEventListener('click', closePanels);
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closePanels));
document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => { S.tab = b.dataset.tab; S.openCard = null; renderSettings(); }));

document.addEventListener('visibilitychange', () => { if (document.hidden) flushSaves(); });
// iPhoneではキーボードが出ても画面の高さが変わらず、入力欄が宙に浮いたり隠れたりする。
// 実際に見えている範囲（visualViewport）に合わせて、画面全体の位置と高さを合わせ直す。
const vv = window.visualViewport;
if (vv) {
  const fit = () => {
    const box = $('#messages');
    const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    const root = document.documentElement.style;
    root.setProperty('--vh', `${vv.height}px`);
    root.setProperty('--vt', `${vv.offsetTop}px`);
    root.setProperty('--vb', `${Math.max(0, window.innerHeight - vv.height - vv.offsetTop)}px`);
    if (stick) scrollBottom();
    updateBar();
  };
  vv.addEventListener('resize', fit);
  vv.addEventListener('scroll', fit);
  fit();
}

navigator.storage?.persist?.();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
const phone = initPhone({ $, h, icon, ICONS, S, db, streamChat, uid, pathTo, chatChars, buildSystem, summaryCut, apiMessage, activeConn, modelLabel, show, closePanels, toast, stamp });
loadAll().catch(showFatal);
