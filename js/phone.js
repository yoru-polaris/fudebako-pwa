// 「スマホをのぞく」機能。
// AIには決まった形のデータ（JSON）でスマホの中身を作らせ、ここで画面に組み立てる。
// 生成は会話とは別枠で行い、結果はAIに送る履歴には入れない（キャラは見られたことを知らない）。

const SHAPE = `{
  "device": "スマホ",
  "owner": "持ち主の名前",
  "time": "21:48",
  "date": "10月21日 土曜日",
  "wallpaper": "壁紙の説明（その人らしさが出る一枚）",
  "apps": { "messages": "メッセージ", "memos": "メモ", "searches": "ブラウザ", "wallet": "ウォレット", "calendar": "カレンダー", "photos": "写真", "sns": "SNS", "deleted": "最近削除" },
  "notifications": [{ "app": "アプリ名", "text": "通知の文面", "time": "18:58" }],
  "messages": [{ "name": "相手の名前", "relation": "関係", "unread": 0, "thread": [{ "from": "them または me", "text": "本文", "time": "16:50" }] }],
  "memos": [{ "title": "題名", "date": "10月21日 18:12", "body": "本文。箇条書きは改行と「・」で書く" }],
  "searches": [{ "kind": "search または site", "text": "検索した言葉、またはページの題名", "site": "site のときだけドメイン", "time": "18:05" }],
  "wallet": [{ "shop": "店名", "category": "分類", "date": "10月21日", "note": "買ったもの", "amount": "-¥680" }],
  "calendar": [{ "date": "10月24日", "time": "16:30–18:00", "title": "予定", "place": "場所" }],
  "photos": [{ "date": "10月20日", "caption": "何が写っているか" }],
  "sns": {
    "main": { "name": "表のアカウントの表示名", "handle": "@id", "bio": "自己紹介", "posts": [{ "text": "投稿", "time": "10月21日 20:10", "likes": 12 }] },
    "sub": { "name": "裏のアカウントの表示名", "handle": "@id", "bio": "自己紹介", "posts": [{ "text": "投稿", "time": "10月21日 23:40", "likes": 0 }] }
  },
  "deleted": [{ "kind": "種類（下書き・写真など）", "date": "10月21日", "text": "消したものの中身" }]
}`;

const prompt = (name, user) => `あなたは物語の小道具を作る係です。ロールプレイは続けず、「${name}」が持っているスマホの中身を、下の形のJSONだけで出力してください。

# 方針
- これまでの会話、${name}の性格、${user}との関係を土台にする。矛盾する設定は作らない。
- 普段の会話では見せない本音や生活感がにじむようにする。気持ちを直接書かず、買い物・検索・予定・消したものの跡で匂わせる。
- ${user}のことは、${name}が他の人とやり取りする中で話題に出す形を優先する。${user}本人とのトークは入れても1人分まで。
- メッセージの相手は、会話に出てきた人物を優先し、足りなければ世界観に合う人物を作る。相手ごとに口調と距離感を変える。"me" が${name}本人の発言。
- 日付と時刻は物語の中の「今」に合わせ、新しいものほど最近にする。
- 世界観にスマホが無い場合は、書簡・手帳・魔導具など合う私物に置き換え、device と apps の名前、金額の単位をそれに合わせる。SNSが無い世界なら、表は掲示や公の日誌、裏は隠し日記や匿名の落書きなどに置き換える。
- 注釈や説明、伏せ字は書かない。${name}本人が書いた・残したものだけを書く。

# 分量
- notifications: 2〜4件
- messages: 3人。各 thread は 8〜12通。最後の数通を未読にしてよい（unread に件数。未読は相手からの発言だけ）
- memos: 3件（1件は${user}に関すること）
- searches: 5〜7件（こっそり調べたこと）
- wallet: 4〜6件（1件は${user}に関係する出費）
- calendar: 2〜4件
- photos: 3〜4件
- sns: 表と裏の2つのアカウント。それぞれ posts を4〜5件
  - 表（main）：他人に見せる前提の発言。仕事や付き合い向けの、取りつくろった自分。メッセージやメモより改まっている
  - 裏（sub）：鍵をかけた愚痴や本音。ただし誰かに見られるかもしれない前提なので、名前や場所はぼかして書く。メモや下書きほど無防備ではない
  - 表と裏で、同じ出来事を違う言い方で書いている投稿を1組入れる
- deleted: 2〜3件（消した理由が透けて見えるもの。送らなかった文面、消した写真など）

# 出力の形（このJSONだけを出力する。コードブロックの記号や前置きは書かない）
${SHAPE}`;

const SAMPLE = JSON.stringify({
  device: 'スマホ', owner: 'ダミーさん', time: '21:48', date: '10月21日 土曜日', wallpaper: '雨上がりの路地で撮った猫の後ろ姿',
  notifications: [{ app: 'メッセージ', text: '明日、少しだけ時間ある？', time: '21:40' }, { app: 'カレンダー', text: '明日 10:30 打ち合わせ', time: '20:00' }],
  messages: [
    { name: '見本 一郎', relation: '友人', unread: 2, thread: [
      { from: 'them', text: '今日の夜空いてる？', time: '16:50' }, { from: 'me', text: 'ごめん、先約あって無理だわ', time: '16:58' },
      { from: 'them', text: 'そっか。また今度', time: '17:02' }, { from: 'them', text: '最近付き合い悪くない？', time: '17:35' }, { from: 'them', text: 'まあいいけど。今度おごってよ', time: '17:40' }] },
    { name: '見本 二葉', relation: '同僚', unread: 0, thread: [{ from: 'them', text: '資料ありがとう。助かった', time: '14:10' }, { from: 'me', text: 'いえいえ。また言って', time: '14:22' }] },
  ],
  memos: [{ title: '好きなものメモ', date: '10月21日 18:12', body: '・猫\n・ジャズ\n・薔薇の香り' }, { title: 'やることリスト', date: '10月21日 13:40', body: '・書類の確認\n・週末の予定を空ける' }],
  searches: [{ kind: 'search', text: 'プレゼント 重くない 選び方', time: '18:05' }, { kind: 'site', text: '星空観測ガイド - 秋の星座', site: 'star-guide.example', time: '17:52' }],
  wallet: [{ shop: '駅前書店', category: '本', date: '10月21日', note: '参考書', amount: '-¥3,520' }, { shop: '花屋', category: '贈り物', date: '10月20日', note: '小さな花束', amount: '-¥1,800' }],
  calendar: [{ date: '10月24日', time: '16:30–18:00', title: '打ち合わせ', place: '会議室A' }],
  photos: [{ date: '10月20日', caption: '窓辺で眠っている猫' }, { date: '10月19日', caption: '二人分のコーヒーカップ' }],
  sns: {
    main: { name: 'ダミーさん', handle: '@dummy_official', bio: '仕事の記録と、ときどき猫。', posts: [{ text: '本日も無事に終了。関係者の皆さま、ありがとうございました。', time: '10月21日 19:02', likes: 24 }, { text: '窓辺の猫。今日はよく眠っていました。', time: '10月20日 12:30', likes: 51 }] },
    sub: { name: 'ねむい', handle: '@nemui_0x', bio: '鍵。ひとりごと。', posts: [{ text: '無事に終了、とか書いたけど全然無事じゃない。胃が痛い。', time: '10月21日 23:48', likes: 0 }, { text: 'あの人の前だと調子が狂う。なんでだろ。', time: '10月21日 23:55', likes: 1 }] },
  },
  deleted: [{ kind: 'メッセージの下書き', date: '10月21日', text: '今日はありがとう。また会' }, { kind: '写真', date: '10月20日', text: '隠し撮りになってしまった横顔' }],
});

const APPS = [
  ['messages', 'メッセージ', 'ai', '#3aa76d'], ['memos', 'メモ', 'book', '#c9972b'], ['searches', 'ブラウザ', 'globe', '#3d7fd6'], ['wallet', 'ウォレット', 'card', '#7d6ad6'],
  ['calendar', 'カレンダー', 'calendar', '#d2574e'], ['photos', '写真', 'image', '#c75b97'], ['sns', 'SNS', 'at', '#2f9fb5'], ['screentime', 'スクリーンタイム', 'clock', '#5c7389'], ['deleted', '最近削除', 'trash', '#6b6b73'],
];

export function initPhone(x) {
  const { $, h, icon, ICONS, S, db, streamChat } = x;
  Object.assign(ICONS, {
    phone: 'M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM11 18h2',
    back: 'M15 18l-6-6 6-6',
    close: 'M18 6L6 18M6 6l12 12',
    search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
    globe: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20',
    card: 'M3 6h18a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1zM2 10h20',
    calendar: 'M4 5h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM16 3v4M8 3v4M3 10h18',
    clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
    at: 'M16 12a4 4 0 1 0-8 0 4 4 0 0 0 8 0zM16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94',
    heart: 'M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z',
    lock: 'M5 11h14a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1zM8 11V7a4 4 0 0 1 8 0v4',
  });

  let cur = null;   // 開いているスマホ { peek, app, index }
  let job = null;   // 生成中 { name, started, chars, abort }

  const list = (v) => (Array.isArray(v) ? v.filter((item) => item && typeof item === 'object') : []);
  const onPeekSheet = () => !$('#sheet').hidden && $('#sheetTitle').textContent === 'スマホをのぞく';
  const str = (v) => (v == null ? '' : String(v));

  // ---------- 生成 ----------
  async function generate(name) {
    const chat = S.chat;
    const path = x.pathTo(chat.leafId);
    if (!path.length) { alert('まだ会話がありません。少し話を進めてから試してください。'); return; }
    const hero = x.heroOf(chat)?.name || 'ユーザー';
    const cut = x.summaryCut(chat, path);
    const { system } = x.buildSystem(chat, `${path.slice(-4).map((m) => m.text).join('\n')}\n${name || ''}`, cut ? chat.summary.text : '');
    const talk = path.slice(cut).filter((m) => !m.side).map((m) => `【${m.role === 'user' ? hero : '語り・相手役'}】\n${x.apiMessage(m).text}`).join('\n\n');
    const who = name || '会話の主な相手役（あなたが判断する）';
    const input = `# 設定\n${system || '（なし）'}\n\n# これまでの会話\n${talk}\n\n# 依頼\n${who} のスマホの中身を作ってください。`;
    const conn = { ...x.activeConn(), tailUser: '', tailModel: '' };

    job = { name: name || '相手', started: Date.now(), chars: 0, abort: new AbortController() };
    const tick = setInterval(() => { if (onPeekSheet()) openPeekSheet(); }, 1000);   // 別の画面を開いているときは上書きしない
    openPeekSheet();
    const run = async (json) => {
      let out = '';
      job.chars = 0;
      for await (const ev of streamChat(conn, { system: prompt(name || '相手役', hero), messages: [{ role: 'user', text: input }], json, sample: SAMPLE, signal: job.abort.signal })) {
        if (ev.text) { out += ev.text; job.chars = out.length; }
        if (ev.notice && !out) throw new Error(ev.notice);
      }
      return out;
    };
    try {
      let out;
      try { out = await run(true); } catch (e) {
        if (e.name === 'AbortError') throw e;
        out = await run(false);   // 「JSONで返す」指定に対応していないモデル向けに、指定なしでもう一度
      }
      const data = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
      const peek = { id: x.uid(), name: str(data.owner) || name || '相手', at: path.length, createdAt: Date.now(), model: x.modelLabel(conn), data };
      chat.peeks = [...(chat.peeks || []), peek];
      await db.put('chats', chat);
      clearInterval(tick);
      job = null;
      const waiting = onPeekSheet();
      job = null;
      if (S.chat === chat && waiting) openPhone(peek);
      else x.toast('スマホの中身ができました（チャット名 →「スマホをのぞく」から開けます）');
    } catch (e) {
      clearInterval(tick);
      job = null;
      if (e.name !== 'AbortError') alert(`スマホの中身を作れませんでした。\n${e instanceof SyntaxError ? 'AIの返事が決まった形になっていませんでした。もう一度試すか、別のモデルで試してください。' : e.message}`);
      if (onPeekSheet()) openPeekSheet();
    }
  }

  // ---------- 入口のシート ----------
  function openPeekSheet() {
    $('#sheetTitle').textContent = 'スマホをのぞく';
    const chat = S.chat;
    const cast = x.chatChars(chat).filter((c) => (c.type || 'char') === 'char');
    const body = $('#sheetBody');
    if (job) {
      body.replaceChildren(
        h('p', { class: 'hint', text: `「${job.name}」のスマホの中身を作っています… ${Math.round((Date.now() - job.started) / 1000)}秒（${job.chars.toLocaleString()}字）\n1〜2分かかることがあります。この画面を閉じても続きます。` }),
        h('div', { class: 'btnrow' }, h('button', { text: 'やめる', onclick: () => job?.abort.abort() })));
    } else {
      const peeks = [...(chat.peeks || [])].reverse();
      body.replaceChildren(...[
        h('p', { class: 'hint', text: '今までの会話をもとに、相手のスマホの中身（メッセージ、メモ、検索履歴、買い物など）をAIが作ります。のぞいた内容は会話には残らず、相手にも知られません。1回につき返事1回分ほどの料金がかかります。' }),
        ...(cast.length ? cast : [null]).map((c) => h('button', { class: 'primary wide', style: 'margin-top:8px', onclick: () => generate(c?.name) }, icon('phone'), c ? `「${c.name}」のスマホをのぞく` : '相手のスマホをのぞく')),
        peeks.length > 0 && h('p', { class: 'grouphead', text: '前にのぞいたもの' }),
        ...peeks.map((p) => h('div', { class: 'row' },
          h('button', { class: 'plain withic', onclick: () => openPhone(p) }, icon('phone'), `${p.name}（${p.at}件目の時点・${x.stamp(p.createdAt)}）`),
          h('button', { class: 'iconbtn', 'aria-label': '削除', onclick: async () => {
            if (!confirm('この記録を削除しますか？')) return;
            chat.peeks = chat.peeks.filter((q) => q !== p);
            await db.put('chats', chat);
            openPeekSheet();
          } }, icon('trash')))),
      ].filter(Boolean));
    }
    x.show('#sheet');
  }

  // ---------- スマホの画面 ----------
  function openPhone(peek) {
    cur = { peek, app: null, index: null };
    draw();
    x.show('#phone');
  }

  const top = (title, sub, back) => h('div', { class: 'ph-top' },
    h('button', { class: 'ph-back', 'aria-label': '戻る', onclick: back }, icon('back')),
    h('div', { class: 'ph-title' }, title, sub && h('small', { text: sub })));
  const card = (...kids) => h('div', { class: 'ph-card' }, ...kids);
  const row = (props, ...kids) => h(props.onclick ? 'button' : 'div', { class: 'ph-row', ...props }, ...kids);
  const badge = (name, color) => h('span', { class: 'ph-badge', style: `background:${color}` }, icon(name));
  const empty = () => h('p', { class: 'ph-empty', text: '何もありません' });

  function draw() {
    const d = cur.peek.data || {};
    const names = { ...Object.fromEntries(APPS.map((a) => [a[0], a[1]])), ...(d.apps || {}) };
    const home = () => { cur.app = null; cur.index = null; draw(); };
    const root = $('#phone');
    const app = cur.app;
    let view;

    if (!app) {
      const unread = list(d.messages).reduce((n, m) => n + (Number(m.unread) || 0), 0);
      view = [
        h('div', { class: 'ph-top' }, h('button', { class: 'ph-back', 'aria-label': '閉じる', onclick: x.closePanels }, icon('close')),
          h('div', { class: 'ph-title' }, `${str(d.owner) || cur.peek.name}の${str(d.device) || 'スマホ'}`)),
        h('div', { class: 'ph-clock' }, h('b', { text: str(d.time) }), h('span', { text: str(d.date) })),
        d.wallpaper && h('p', { class: 'ph-wall', text: `壁紙：${str(d.wallpaper)}` }),
        ...list(d.notifications).map((n) => h('div', { class: 'ph-note' }, h('b', { text: str(n.app) }), h('span', { text: str(n.time) }), h('div', { text: str(n.text) }))),
        h('div', { class: 'ph-grid' }, APPS.filter(([key]) => (key === 'sns' ? d.sns?.main || d.sns?.sub : list(d[key]).length)).map(([key, , ic, color]) => h('button', { onclick: () => { cur.app = key; draw(); } },
          h('span', { class: 'ph-icon', style: `background:${color}` }, icon(ic), key === 'messages' && unread > 0 && h('i', { text: unread })),
          h('span', { text: str(names[key]) })))),
        h('p', { class: 'ph-foot', text: `${cur.peek.at}件目の時点 ・ ${x.stamp(cur.peek.createdAt)} ・ ${cur.peek.model || ''}` }),
      ];
    } else if (app === 'messages' && cur.index != null) {
      const m = list(d.messages)[cur.index] || {};
      const thread = list(m.thread);
      const firstUnread = thread.length - (Number(m.unread) || 0);
      view = [
        top(str(m.name), str(m.relation), () => { cur.index = null; draw(); }),
        h('div', { class: 'ph-thread' }, thread.flatMap((t, i) => [
          i === firstUnread && firstUnread > 0 && h('div', { class: 'ph-unread', text: 'まだ読んでいないメッセージ' }),
          h('div', { class: `ph-msg ${t.from === 'me' ? 'me' : 'them'}` }, h('span', { text: str(t.text) }), h('small', { text: str(t.time) })),
        ]).filter(Boolean)),
      ];
    } else if (app === 'messages') {
      const all = list(d.messages);
      view = [top(str(names.messages), all.some((m) => m.unread) ? `未読 ${all.reduce((n, m) => n + (Number(m.unread) || 0), 0)}` : '', home),
        all.length ? card(...all.map((m, i) => {
          const last = list(m.thread).at(-1) || {};
          return row({ onclick: () => { cur.index = i; draw(); } },
            h('span', { class: 'ph-avatar', text: str(m.name).slice(0, 1) }, Number(m.unread) > 0 && h('i')),
            h('div', { class: 'ph-main' }, h('b', { text: str(m.name) }), h('span', { text: str(last.text) })),
            h('small', { text: str(last.time) }));
        })) : empty()];
    } else if (app === 'memos' && cur.index != null) {
      const m = list(d.memos)[cur.index] || {};
      view = [top(str(names.memos), '', () => { cur.index = null; draw(); }),
        h('div', { class: 'ph-memo' }, h('small', { text: str(m.date) }), h('h3', { text: str(m.title) }), h('p', { text: str(m.body) }))];
    } else if (app === 'memos') {
      const all = list(d.memos);
      view = [top(str(names.memos), `${all.length}件`, home),
        all.length ? card(...all.map((m, i) => row({ onclick: () => { cur.index = i; draw(); } },
          badge('book', '#c9972b'), h('div', { class: 'ph-main' }, h('b', { text: str(m.title) }), h('span', { text: str(m.body).split('\n')[0] })), h('small', { text: str(m.date) })))) : empty()];
    } else if (app === 'searches') {
      const all = list(d.searches);
      view = [top(str(names.searches), '最近の履歴', home),
        all.length ? card(...all.map((s) => row({},
          badge(s.kind === 'site' ? 'globe' : 'search', '#3d7fd6'), h('div', { class: 'ph-main wrap' }, h('b', { text: str(s.text) }), h('span', { text: s.kind === 'site' ? str(s.site) : '検索' })), h('small', { text: str(s.time) })))) : empty()];
    } else if (app === 'wallet') {
      const all = list(d.wallet);
      view = [top(str(names.wallet), '', home),
        h('div', { class: 'ph-paycard' }, icon('card'), h('b', { text: str(d.owner) || cur.peek.name })),
        all.length ? card(...all.map((w) => row({},
          h('div', { class: 'ph-main wrap' }, h('b', { text: str(w.shop) }), h('span', { text: [w.category, w.date].filter(Boolean).join(' ｜ ') }), w.note && h('span', { text: str(w.note) })),
          h('b', { class: 'ph-amount', text: str(w.amount) })))) : empty()];
    } else if (app === 'calendar') {
      const all = list(d.calendar);
      view = [top(str(names.calendar), str(d.date), home),
        all.length ? card(...all.map((c) => row({},
          h('span', { class: 'ph-bar' }), h('div', { class: 'ph-main wrap' }, h('b', { text: str(c.title) }), h('span', { text: [c.date, c.time].filter(Boolean).join(' ｜ ') }), c.place && h('span', { text: str(c.place) }))))) : empty()];
    } else if (app === 'photos') {
      const all = list(d.photos);
      view = [top(str(names.photos), `${all.length}枚`, home),
        all.length ? h('div', { class: 'ph-photos' }, all.map((p) => h('div', {}, h('span', {}, icon('image')), h('p', { text: str(p.caption) }), h('small', { text: str(p.date) })))) : empty()];
    } else if (app === 'sns') {
      const tab = cur.index === 'sub' ? 'sub' : 'main';
      const acc = d.sns?.[tab] || {};
      const posts = list(acc.posts);
      view = [top(str(names.sns), '', home),
        h('div', { class: 'ph-tabs' }, [['main', '表のアカウント'], ['sub', '裏のアカウント']].map(([key, label]) =>
          h('button', { class: tab === key ? 'on' : '', onclick: () => { cur.index = key; draw(); } }, key === 'sub' && icon('lock'), label))),
        h('div', { class: 'ph-profile' },
          h('span', { class: 'ph-avatar', text: str(acc.name).slice(0, 1) }),
          h('div', { class: 'ph-main wrap' }, h('b', { text: str(acc.name) }), h('span', { text: str(acc.handle) }), acc.bio && h('span', { class: 'bio', text: str(acc.bio) }))),
        posts.length ? card(...posts.map((p) => h('div', { class: 'ph-post' },
          h('p', { text: str(p.text) }),
          h('small', {}, str(p.time), p.likes != null && h('span', {}, icon('heart'), str(p.likes)))))) : empty()];
    } else if (app === 'screentime') {
      const all = list(d.screentime);
      const max = Math.max(1, ...all.map((s) => Number(s.minutes) || 0));
      const time = (n) => (n >= 60 ? `${Math.floor(n / 60)}時間${n % 60 ? `${n % 60}分` : ''}` : `${n}分`);
      view = [top(str(names.screentime), '今日', home),
        all.length ? card(...all.map((s) => row({},
          h('div', { class: 'ph-main wrap' }, h('b', { text: str(s.app) }), h('span', { class: 'ph-meter' }, h('i', { style: `width:${Math.round(((Number(s.minutes) || 0) / max) * 100)}%` }))),
          h('small', { text: Number.isFinite(Number(s.minutes)) ? time(Number(s.minutes)) : str(s.minutes) })))) : empty()];
    } else {
      const all = list(d.deleted);
      view = [top(str(names.deleted), '', home),
        all.length ? card(...all.map((x2) => row({},
          badge('trash', '#6b6b73'), h('div', { class: 'ph-main wrap' }, h('b', { text: str(x2.kind) }), h('span', { class: 'ph-strike', text: str(x2.text) })), h('small', { text: str(x2.date) })))) : empty()];
    }
    root.replaceChildren(h('div', { class: 'ph-scroll' }, ...view.filter(Boolean)));
  }

  return { openPeekSheet };
}
