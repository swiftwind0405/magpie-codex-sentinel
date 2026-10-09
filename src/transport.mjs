import { randomUUID } from 'node:crypto';

export class ProbeError extends Error {
  constructor(code, message, status = null, evidence = {}) {
    super(message);
    this.name = 'ProbeError'; this.code = code; this.status = status; this.evidence = evidence;
  }
}

function failureCode(status, error = {}) {
  const tags = [error.type, error.code];
  if (status === 429 || tags.some((tag) => ['rate_limit_error', 'rate_limit_exceeded', 'usage_limit_reached', 'insufficient_quota'].includes(tag))) {
    return 'rate_limited';
  }
  if (status === 401 || status === 403 || tags.some((tag) => ['authentication_error', 'permission_error', 'invalid_api_key'].includes(tag))) {
    return 'auth_error';
  }
  return 'upstream_error';
}

function responseFailure(payload, evidence = {}) {
  const error = payload.response?.error ?? payload.error ?? payload;
  const status = [error.status, error.status_code, error.code, payload.status_code].find(Number.isInteger) ?? null;
  const code = failureCode(status, error);
  const message = code === 'rate_limited' ? '上游报告限流或额度不足。'
    : code === 'auth_error' ? '上游报告认证或权限失败。' : '上游返回失败结果。';
  return new ProbeError(code, message, status, evidence);
}

const numeric = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
export function normalizeUsage(usage) {
  const input = numeric(usage?.input_tokens ?? usage?.prompt_tokens);
  const output = numeric(usage?.output_tokens ?? usage?.completion_tokens);
  return {
    input, output,
    reasoning: numeric(usage?.output_tokens_details?.reasoning_tokens ?? usage?.completion_tokens_details?.reasoning_tokens ?? usage?.reasoning_output_tokens),
    cached: numeric(usage?.input_tokens_details?.cached_tokens ?? usage?.prompt_tokens_details?.cached_tokens),
    total: numeric(usage?.total_tokens) ?? (input !== null && output !== null ? input + output : null),
  };
}

function finalText(response) {
  const messages = (response?.output ?? []).filter((item) => item.type === 'message' && (!item.role || item.role === 'assistant'));
  // Codex can emit progress messages before its answer. Only its final phase
  // is scored. For legacy unphased messages, the last assistant message wins.
  const selected = messages.filter((item) => item.phase === 'final_answer').at(-1)
    ?? messages.filter((item) => item.phase == null).at(-1);
  if (selected) return (selected.content ?? []).filter((item) => item.type === 'output_text').map((item) => item.text ?? '').join('\n');
  if (messages.length) return ''; // Commentary alone is not a final answer.
  return typeof response?.output_text === 'string' ? response.output_text : '';
}

function hasTool(response) {
  return (response?.output ?? []).some((item) => /_call$/.test(item?.type ?? '') || item?.type === 'mcp_approval_request');
}

function hasRefusal(response) {
  return (response?.output ?? []).some((item) => (item.content ?? []).some((part) => part.type === 'refusal'));
}

async function limitedText(response, maxBytes) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0; let text = '';
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxBytes) throw new ProbeError('response_too_large', '响应超过本地大小上限；该题不计为能力失败。');
      text += decoder.decode(part.value, { stream: true });
    }
    return text + decoder.decode();
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Reads only the Responses final-answer channel. Reasoning summaries are never graded. */
export async function parseResponse(response, { maxResponseBytes = 8 * 1024 * 1024 } = {}) {
  const type = response.headers.get('content-type') || '';
  const started = Date.now();
  if (!type.includes('event-stream')) {
    let data;
    try { data = JSON.parse(await limitedText(response, maxResponseBytes)); }
    catch (error) { if (error instanceof ProbeError) throw error; throw new ProbeError('protocol_error', '网关未返回有效的 Responses JSON。'); }
    const evidence = { model: data.model ?? null, usage: normalizeUsage(data.usage), firstTextMs: null };
    if (data.error || data.status === 'failed') { throw responseFailure(data, evidence); }
    if (data.status === 'incomplete') { throw new ProbeError('truncated', '上游未完成输出，可能达到输出上限。', null, evidence); }
    if (data.status !== 'completed') { throw new ProbeError('protocol_error', 'Responses JSON 缺少 completed 终止状态。', null, evidence); }
    return { text: finalText(data), model: data.model ?? null, usage: normalizeUsage(data.usage), toolUsed: hasTool(data), refusal: hasRefusal(data), firstTextMs: null };
  }
  if (!response.body) throw new ProbeError('protocol_error', '流式响应没有 body。');
  const reader = response.body.getReader(); const decoder = new TextDecoder();
  let buffer = ''; let bytes = 0; let text = ''; let model = null; let usage = null;
  const items = new Map();
  let toolUsed = false; let refusal = false; let completed = false; let wireEnded = false; let firstTextMs = null;
  function processBlock(block) {
    let name = ''; const data = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) name = line.slice(6).trim();
      if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (!data.length) return;
    if (data.join('\n').trim() === '[DONE]') { if (completed) wireEnded = true; return; }
    let event;
    try { event = JSON.parse(data.join('\n')); } catch { throw new ProbeError('protocol_error', '收到无法解析的 SSE 事件。'); }
    name = event.type || name;
    if (event.response?.model) model = event.response.model;
    if (event.response?.usage) usage = event.response.usage;
    if (name === 'error' || name === 'response.failed' || event.error) { throw responseFailure(event); }
    if (name === 'response.incomplete') throw new ProbeError('truncated', '上游输出被截断；该题不计为能力失败。');
    if (/response\.(?:function_call|web_search_call|code_interpreter_call|mcp_call)/.test(name) || /_call$/.test(event.item?.type ?? '') || event.item?.type === 'mcp_approval_request') toolUsed = true;
    if (name === 'response.refusal.delta' || name === 'response.refusal.done') refusal = true;
    if ((name === 'response.output_item.added' || name === 'response.output_item.done') && event.item) {
      items.set(event.output_index ?? event.item.id, event.item);
    }
    if (name === 'response.output_text.delta' && typeof event.delta === 'string') {
      if (firstTextMs === null && event.delta) firstTextMs = Date.now() - started;
      text += event.delta;
    }
    if (name === 'response.completed') {
      if (event.response?.status !== 'completed') throw new ProbeError('protocol_error', 'completed 事件中的状态无效。');
      if (Array.isArray(event.response.output) || typeof event.response.output_text === 'string') {
        text = finalText(event.response);
      } else if (items.size) {
        text = finalText({ output: [...items.values()] });
      } else {
        throw new ProbeError('protocol_error', '终态缺少可识别的最终输出项，不能将中途文本当作答案。');
      }
      toolUsed ||= hasTool(event.response); refusal ||= hasRefusal(event.response);
      completed = true;
    }
  }
  try {
    while (!wireEnded) {
      const part = await reader.read();
      if (part.done) { buffer += decoder.decode(); break; }
      bytes += part.value.byteLength;
      if (bytes > maxResponseBytes) throw new ProbeError('response_too_large', '响应超过本地大小上限。');
      // CRLF may straddle chunks. Normalize only complete lines below.
      buffer += decoder.decode(part.value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      let at;
      while ((at = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, at); buffer = buffer.slice(at + 2); processBlock(block);
        if (wireEnded) break;
      }
    }
    if (!wireEnded && buffer.trim()) processBlock(buffer.replace(/\r\n/g, '\n'));
    if (!completed) throw new ProbeError('incomplete_stream', '流在 response.completed 前结束；不是答错。');
    return { text, model, usage: normalizeUsage(usage), toolUsed, refusal, firstTextMs };
  } catch (error) {
    // Keep only observed metadata, never intermediate text or reasoning.
    if (error instanceof Error) {
      error.evidence = { model, usage: normalizeUsage(usage), firstTextMs };
    }
    throw error;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

function authHeaders(config, session) {
  const headers = new Headers({ authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json', 'X-Magpie-Response-Model': 'vendor' });
  if (session) headers.set('X-Magpie-Session', session);
  if (config.account) headers.set('X-Magpie-Account', config.account);
  return headers;
}

async function observeRoute(config, session, signal, fetchImpl) {
  const timeout = AbortSignal.timeout(3000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let last = null; let sequence = null;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const query = `session=${encodeURIComponent(session)}${sequence === null ? '' : `&after=${sequence}&wait=1`}`;
      const response = await fetchImpl(`${config.baseUrl}/magpie/route?${query}`, { headers: authHeaders(config), signal: combined, redirect: 'error' });
      if (!response.ok) { await response.body?.cancel(); return last; }
      const raw = JSON.parse(await limitedText(response, 128 * 1024));
      if (raw.session !== session) return null;
      sequence = Number.isSafeInteger(raw.seq) && raw.seq >= 0 ? raw.seq : null;
      if (!raw.route) continue;
      const r = raw.route;
      last = { model: r.model ?? null, effort: r.effort ?? null, done: r.done === true, status: r.status ?? null, served: r.served ?? null,
        tries: (Array.isArray(r.tries) ? r.tries : []).map((t) => ({ model: t.model ?? null, effort: t.effort ?? null, done: t.done === true, status: t.status ?? null, failed: Boolean(t.fail) })) };
      if (last.done) return last;
    }
    return last;
  } catch { return last; }
}

export async function requestProbe(config, probe, { signal, fetchImpl = fetch } = {}) {
  const session = `codex-sentinel-${randomUUID()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('Probe timed out', 'TimeoutError')), config.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const started = Date.now(); let headers = {}; let requestId = null; let status = null;
  try {
    const body = {
      model: config.target, stream: true, store: false,
      ...(probe.family === 'fingerprint' ? {} : { instructions: '完成用户给出的独立测试。只返回题目要求的最终 JSON，不调用任何工具，不引用其他会话。' }),
      input: [{ role: 'user', content: [{ type: 'input_text', text: probe.prompt }] }],
      tools: [], tool_choice: 'none', max_output_tokens: config.maxOutputTokens,
      ...(config.effort === 'default' ? {} : { reasoning: { effort: config.effort } }),
    };
    const response = await fetchImpl(`${config.baseUrl}/responses`, { method: 'POST', headers: authHeaders(config, session), body: JSON.stringify(body), signal: combined, redirect: 'error' });
    status = response.status;
    headers = { provider: response.headers.get('X-Magpie-Provider'), model: response.headers.get('X-Magpie-Model') };
    requestId = response.headers.get('x-request-id')?.slice(0, 200) ?? null;
    if (!response.ok) {
      await response.body?.cancel();
      const classification = failureCode(status);
      const code = classification === 'upstream_error' ? 'http_error' : classification;
      throw new ProbeError(code, `HTTP ${status}：${code === 'auth_error' ? '网关或被测账户认证/权限失败' : code === 'rate_limited' ? '限流、额度不足或账户休息中' : '上游请求失败'}。`, status);
    }
    const answer = await parseResponse(response, config);
    const elapsedMs = Date.now() - started;
    clearTimeout(timer);
    const route = await observeRoute(config, session, signal, fetchImpl);
    return { status: answer.toolUsed ? 'tool_contaminated' : answer.refusal ? 'refusal' : !answer.text.trim() ? 'empty_output' : 'completed', ...answer,
      elapsedMs, requestId, httpStatus: status, route: { ...headers, trace: route }, session };
  } catch (error) {
    const elapsedMs = Date.now() - started;
    clearTimeout(timer);
    let code = signal?.aborted ? (signal.reason?.name === 'TimeoutError' ? 'run_timeout' : 'cancelled') : controller.signal.aborted ? 'timeout' : error instanceof ProbeError ? error.code : 'network_error';
    const route = status >= 200 && status < 300 && !combined.aborted ? await observeRoute(config, session, signal, fetchImpl) : null;
    // Magpie can emit a generic SSE error after its HTTP 200 keepalive.
    // Its completed route still carries the actual failure status.
    if (code === 'upstream_error' && route?.done) { code = failureCode(route.status); }
    const evidence = error?.evidence;
    return { status: code, error: code === 'rate_limited' ? '上游报告限流或额度不足。' : code === 'auth_error' ? '上游报告认证或权限失败。' : error instanceof ProbeError ? error.message : code === 'timeout' ? '该题超过时间上限。' : code === 'run_timeout' ? '整轮达到时间上限。' : code === 'cancelled' ? '用户取消。' : '无法完成网关请求，请检查 Magpie 是否运行及地址设置。',
      text: '', model: evidence?.model ?? null, usage: evidence?.usage ?? normalizeUsage(null), firstTextMs: evidence?.firstTextMs ?? null,
      elapsedMs, requestId, httpStatus: status, route: { ...headers, trace: route }, session };
  } finally { clearTimeout(timer); }
}

export async function fetchModels(config, { signal, fetchImpl = fetch } = {}) {
  const timeout = AbortSignal.timeout(10000);
  const response = await fetchImpl(`${config.baseUrl}/models`, { headers: authHeaders(config), signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'error' });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`读取 Magpie 模型列表失败（HTTP ${response.status}）。`); }
  const data = JSON.parse(await limitedText(response, 4 * 1024 * 1024));
  if (!Array.isArray(data.data)) throw new Error('Magpie /models 没有返回 data 数组。');
  return data.data;
}
