// 各APIへの接続。streamChat は { text } / { thought } / { notice } を順に返す。

export const CONN_TYPES = {
  vertex: 'Vertex AI（APIキー）',
  gemini: 'Gemini（Google AI Studio）',
  openai: 'OpenAI互換（OpenRouterなど）',
  dummy: 'ダミーAI（動作確認用・通信しません）',
};

export const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? undefined : Number(v));

async function* sse(resp) {
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const parse = (line) => {
    if (!line.startsWith('data:')) return;
    const d = line.slice(5).trim();
    if (!d || d === '[DONE]') return;
    try { return JSON.parse(d); } catch { /* 途中で切れた行は無視 */ }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const obj = parse(buf.slice(0, i).replace(/\r$/, ''));
      buf = buf.slice(i + 1);
      if (obj) yield obj;
    }
  }
  const last = parse(buf.trim());
  if (last) yield last;
}

const HINTS = {
  400: 'リクエストの内容が受け付けられませんでした。温度や思考の設定がこのモデルに合っていない可能性があります。温度を空欄に、思考の設定を「指定しない」にして試してください。',
  401: 'APIキーが正しくないか、この接続先では使えないキーです。',
  403: 'このキーには権限がありません。APIが有効になっているか確認してください。',
  404: 'モデル名が見つかりません。モデル名のつづりを確認してください。',
  429: '利用上限に達しました。しばらく待ってからやり直してください。',
};

async function fail(resp) {
  let detail = await resp.text();
  try {
    let j = JSON.parse(detail);
    if (Array.isArray(j)) j = j[0];
    detail = j?.error?.message || detail;
  } catch { /* JSONでなければそのまま */ }
  const hint = HINTS[resp.status] || (resp.status >= 500 ? 'サーバー側のエラーです。少し待ってやり直してください。' : '');
  throw new Error(`エラー ${resp.status}\n${hint}\n\n（サーバーからの返事）\n${detail}`.trim());
}

async function post(url, headers, body, signal) {
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error(`通信できませんでした。電波の状態やURLを確認してください。\n（${e.message}）`);
  }
  if (!resp.ok) await fail(resp);
  return resp;
}

const BLOCK_REASONS = {
  SAFETY: '安全フィルターにより止められました',
  PROHIBITED_CONTENT: '禁止コンテンツと判定され止められました',
  RECITATION: '既存の文章との重複と判定され止められました',
  MAX_TOKENS: '最大出力トークンに達して途中で終わりました',
  BLOCKLIST: '禁止語句により止められました',
  OTHER: '不明な理由で止められました',
};

async function* gemini(conn, { system, messages, signal }) {
  const model = encodeURIComponent(conn.model.trim());
  const url = conn.type === 'vertex'
    ? `https://aiplatform.googleapis.com/v1/publishers/google/models/${model}:streamGenerateContent?alt=sse`
    : `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`;

  const generationConfig = {};
  if (num(conn.temperature) !== undefined) generationConfig.temperature = num(conn.temperature);
  if (num(conn.maxTokens) !== undefined) generationConfig.maxOutputTokens = num(conn.maxTokens);
  const thinking = {};
  if (conn.thinkMode === 'budget' && num(conn.thinkBudget) !== undefined) thinking.thinkingBudget = num(conn.thinkBudget);
  if (conn.thinkMode === 'level' && conn.thinkLevel) thinking.thinkingLevel = conn.thinkLevel.toUpperCase();
  if (conn.showThoughts) thinking.includeThoughts = true;
  if (Object.keys(thinking).length) generationConfig.thinkingConfig = thinking;

  const body = {
    contents: messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.text }],
    })),
    generationConfig,
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (conn.safety && conn.safety !== 'default') {
    body.safetySettings = [
      'HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH',
      'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT',
    ].map((category) => ({ category, threshold: conn.safety }));
  }

  const resp = await post(url, { 'x-goog-api-key': conn.apiKey.trim() }, body, signal);
  for await (const chunk of sse(resp)) {
    if (chunk.error) throw new Error(`エラー\n${chunk.error.message || JSON.stringify(chunk.error)}`);
    const block = chunk.promptFeedback?.blockReason;
    if (block) yield { notice: `入力が${BLOCK_REASONS[block] || block}` };
    const cand = chunk.candidates?.[0];
    for (const part of cand?.content?.parts || []) {
      if (!part.text) continue;
      yield part.thought ? { thought: part.text } : { text: part.text };
    }
    const fin = cand?.finishReason;
    if (fin && fin !== 'STOP') yield { notice: BLOCK_REASONS[fin] || `終了理由: ${fin}` };
  }
}

async function* openai(conn, { system, messages, signal }) {
  const base = (conn.baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  const body = {
    model: conn.model.trim(),
    stream: true,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      ...messages.map((m) => ({ role: m.role, content: m.text })),
    ],
  };
  if (num(conn.temperature) !== undefined) body.temperature = num(conn.temperature);
  if (num(conn.maxTokens) !== undefined) body.max_tokens = num(conn.maxTokens);
  if (conn.thinkMode === 'budget' && num(conn.thinkBudget) !== undefined) body.reasoning = { max_tokens: num(conn.thinkBudget) };
  if (conn.thinkMode === 'level' && conn.thinkLevel) body.reasoning = { effort: conn.thinkLevel };

  const resp = await post(`${base}/chat/completions`, { Authorization: `Bearer ${conn.apiKey.trim()}` }, body, signal);
  for await (const chunk of sse(resp)) {
    if (chunk.error) throw new Error(`エラー\n${chunk.error.message || JSON.stringify(chunk.error)}`);
    const choice = chunk.choices?.[0];
    const d = choice?.delta || {};
    const thought = d.reasoning || d.reasoning_content;
    if (thought && conn.showThoughts) yield { thought };
    if (d.content) yield { text: d.content };
    if (choice?.finish_reason === 'length') yield { notice: BLOCK_REASONS.MAX_TOKENS };
    if (choice?.finish_reason === 'content_filter') yield { notice: BLOCK_REASONS.SAFETY };
  }
}

async function* dummy(conn, { messages, signal }) {
  const last = messages.at(-1)?.text || '';
  const text = conn.dummyText?.trim() || `これはダミーAIの返事です。通信はしていません。\n\n受け取った文章（${messages.length}件目）:\n${last}`;
  for (let i = 0; i < text.length; i += 4) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    await new Promise((r) => setTimeout(r, 30));
    yield { text: text.slice(i, i + 4) };
  }
}

export function streamChat(conn, req) {
  if (!conn) throw new Error('接続先がありません。⚙ 設定 →「接続先」で追加してください。');
  if (conn.type === 'dummy') return dummy(conn, req);
  if (!conn.apiKey?.trim()) throw new Error('APIキーが入力されていません。⚙ 設定 →「接続先」で入力してください。');
  if (!conn.model?.trim()) throw new Error('モデル名が入力されていません。⚙ 設定 →「接続先」で入力してください。');
  return conn.type === 'openai' ? openai(conn, req) : gemini(conn, req);
}
