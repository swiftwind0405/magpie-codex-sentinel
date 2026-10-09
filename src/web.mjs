import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { normalizeOptions, VERSION, hash, accountId } from './config.mjs';
import { fetchModels, fetchAccounts } from './transport.mjs';
import { runEvaluation, runFingerprint, getHistory, getRun, setBaseline, formatReport } from './engine.mjs';
import { renderHtml } from './report.mjs';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);

function failure(status, message) {
  return Object.assign(new Error(message), { status });
}

async function readBody(request) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') {
    throw failure(415, '请求需要使用 JSON。');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8192) { throw failure(413, '请求内容过大。'); }
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) { throw new Error(); }
    return body;
  } catch { throw failure(400, '请求需要合法的 JSON 对象。'); }
}

function send(response, status, body, type = 'application/json; charset=utf-8') {
  response.writeHead(status, { 'content-type': type });
  response.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

/** Only the local service owns jobs and credentials; the browser is a view. */
export async function startDashboard({ options = {}, directory, apiKey, port = 47821, mode = 'cli' } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) { throw new Error('port 必须是 0–65535 的整数。'); }
  const config = normalizeOptions(options, { directory, apiKey, requireTarget: false });
  const common = { options, directory, apiKey: config.apiKey };
  const serviceId = hash(`${config.dataDir}\n${config.baseUrl}`);
  const cleanError = (error) => {
    const message = String(error?.message || '操作失败。');
    return message.split(config.apiKey).join('[已隐藏密钥]').slice(0, 800);
  };
  let origin;
  let job = null;
  let controller;
  let pending = Promise.resolve();
  let closing = false;
  const active = () => job && ['running', 'cancelling'].includes(job.status);
  const snapshot = () => job ? { ...job, report: undefined, reportId: job.report?.id ?? null } : null;
  const readRun = async (id) => {
    if (job?.report?.id === id) { return job.report; }
    try { return await getRun({ ...common, id }); }
    catch (error) { throw failure(404, cleanError(error)); }
  };

  async function executeJob(current, runOptions, signal) {
    const run = current.profile === 'fingerprint' ? runFingerprint : runEvaluation;
    for (const item of current.accounts) {
      if (signal.aborted) { break; }
      current.accountId = item.accountId;
      current.accountName = item.accountName;
      current.messages = [];
      item.status = 'running';
      try {
        const report = await run({ ...common, options: { ...runOptions, account: item.accountName }, profile: current.profile, signal,
          onProgress: ({ message }) => { current.messages.push(message); } });
        current.report = report;
        Object.assign(item, { status: report.runStatus, reportId: report.id, summary: report.summary, verdict: report.verdict, fingerprint: report.fingerprint, persisted: report.persisted });
        if (!report.persisted) {
          current.error = '结果保存失败，已停止后续账号。请先导出未保存的报告。';
          break;
        }
      } catch (error) {
        item.status = 'failed';
        item.error = cleanError(error);
      }
    }
    for (const item of current.accounts) {
      if (item.status === 'queued') { item.status = 'skipped'; }
    }
    current.cancelled = signal.aborted;
    current.status = current.error || current.accounts.every((item) => item.status === 'failed') ? 'failed' : 'done';
    current.error ||= current.scope === 'single' ? current.accounts[0].error : undefined;
    current.completedAt = new Date().toISOString();
  }

  const server = createServer((request, response) => {
    handle(request, response).catch((error) => {
      if (!response.headersSent) { send(response, error.status || 500, { error: cleanError(error) }); }
      else { response.end(); }
    });
  });

  async function handle(request, response) {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    // Host validation prevents DNS rebinding; mutations require our own origin
    // and a custom header, so another website cannot start a paid probe.
    if (request.headers.host !== new URL(origin).host
      || (request.headers.origin && request.headers.origin !== origin)
      || request.headers['sec-fetch-site'] === 'cross-site') {
      throw failure(403, '仅接受本地检测页面的请求。');
    }
    const url = new URL(request.url, origin);
    const path = url.pathname;
    if (request.method === 'GET' && assets.has(path)) {
      const [file, type] = assets.get(path);
      send(response, 200, await readFile(new URL(`../web/${file}`, import.meta.url)), type);
      return;
    }
    if (request.method === 'GET' && path === '/api/state') {
      send(response, 200, { product: 'codex-sentinel', version: VERSION, serviceId, mode, gateway: config.baseUrl, defaults: { target: config.target, effort: config.effort, seed: config.seed, accountId: accountId(config.baseUrl, config.account) }, job: snapshot() });
      return;
    }
    if (request.method === 'GET' && path === '/api/models') {
      let models;
      try { models = await fetchModels(config); }
      catch (error) { throw failure(502, cleanError(error)); }
      send(response, 200, { models: models.filter((model) => typeof model.id === 'string' && model.id.startsWith('codex/')).map((model) => ({
        id: model.id,
        efforts: (Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels : []).map((level) => typeof level === 'string' ? level : level.effort).filter((level) => typeof level === 'string'),
      })) });
      return;
    }
    if (request.method === 'GET' && path === '/api/accounts') {
      try { send(response, 200, { accounts: await fetchAccounts(config) }); }
      catch (error) { throw failure(502, cleanError(error)); }
      return;
    }
    if (request.method === 'GET' && path === '/api/history') {
      const rows = await getHistory({ ...common, options: { ...options, target: '', account: '' }, limit: 100 });
      send(response, 200, { runs: rows.map(({ cases, ...row }) => row) });
      return;
    }
    const runPath = /^\/api\/runs\/([a-zA-Z0-9-]{8,100})(\/export)?$/.exec(path);
    if (request.method === 'GET' && runPath) {
      const report = await readRun(runPath[1]);
      if (!runPath[2]) { send(response, 200, report); return; }
      const format = url.searchParams.get('format') || 'html';
      if (!['html', 'json', 'md'].includes(format)) { throw failure(400, '导出格式应为 html、json 或 md。'); }
      response.setHeader('content-disposition', `attachment; filename="sentinel-${report.id}.${format}"`);
      if (format === 'html') { send(response, 200, renderHtml(report), 'text/html; charset=utf-8'); }
      else if (format === 'md') { send(response, 200, formatReport(report), 'text/markdown; charset=utf-8'); }
      else { send(response, 200, report); }
      return;
    }
    if (request.method !== 'POST') { throw failure(404, '没有这个页面或操作。'); }
    if (request.headers.origin !== origin || request.headers['x-sentinel-request'] !== '1') {
      throw failure(403, '请从本地检测页面发起操作。');
    }
    if (closing) { throw failure(503, '检测服务正在关闭。'); }
    const body = await readBody(request);
    if (path === '/api/runs') {
      if (active()) { throw failure(409, '已有检测正在运行，请等待完成或先停止。'); }
      if (!['quick', 'standard', 'fingerprint'].includes(body.profile)) { throw failure(400, '请选择有效的检测类型。'); }
      if (typeof body.target !== 'string' || !body.target.trim()) { throw failure(400, '请选择要检测的模型。'); }
      if (!body.target.startsWith('codex/')) { throw failure(400, '账号检测只接受 Codex provider 下的模型。'); }
      const allAccounts = body.accountIds !== undefined;
      if (allAccounts) {
        if (!Array.isArray(body.accountIds) || !body.accountIds.length || body.accountIds.some((id) => typeof id !== 'string' || !id)
          || new Set(body.accountIds).size !== body.accountIds.length || body.accountId !== undefined) {
          throw failure(400, '全部检测需要完整且不重复的账号列表，请刷新账号。');
        }
      } else if (typeof body.accountId !== 'string' || !body.accountId) { throw failure(400, '请选择一个 Codex 账号，检测不能使用自动路由。'); }
      let accounts;
      try { accounts = await fetchAccounts(config); }
      catch (error) { throw failure(502, cleanError(error)); }
      // Freeze exactly the accounts shown before the click; never silently add
      // newly discovered accounts to a batch with a different request budget.
      accounts = [...new Map(accounts.map((account) => [account.id, account])).values()];
      if (allAccounts && (accounts.length !== body.accountIds.length || accounts.some((account) => !body.accountIds.includes(account.id)))) {
        throw failure(400, 'Codex 账号列表已变化，请刷新账号后再开始全部检测。');
      }
      const chosen = allAccounts ? body.accountIds.map((id) => accounts.find((account) => account.id === id)) : accounts.filter((account) => account.id === body.accountId);
      if (!chosen.length) { throw failure(400, '该账号已不在 Codex 列表中，请刷新账号。'); }
      const runOptions = { ...options, target: body.target, account: chosen[0].name, effort: body.effort ?? config.effort };
      if (body.seed !== undefined) { runOptions.seed = body.seed; }
      try { normalizeOptions(runOptions, { directory, apiKey: config.apiKey }); }
      catch (error) { throw failure(400, cleanError(error)); }
      // Discovery is asynchronous: a second submit may arrive while it waits.
      if (active()) { throw failure(409, '已有检测正在运行，请等待完成或先停止。'); }
      if (closing) { throw failure(503, '检测服务正在关闭。'); }
      controller = new AbortController();
      job = { id: randomUUID(), scope: allAccounts ? 'all' : 'single', status: 'running', accountId: chosen[0].id, accountName: chosen[0].name,
        accounts: chosen.map((account) => ({ accountId: account.id, accountName: account.name, status: 'queued' })),
        target: runOptions.target, effort: runOptions.effort, seed: runOptions.seed ?? config.seed, profile: body.profile, startedAt: new Date().toISOString(), messages: [] };
      pending = executeJob(job, runOptions, controller.signal);
      send(response, 202, { job: snapshot() });
      return;
    }
    if (path === '/api/cancel') {
      if (!active() || body.id !== job.id) { throw failure(409, '该检测已结束，或当前运行的是另一轮检测。'); }
      job.status = 'cancelling';
      controller.abort(new DOMException('User cancelled', 'AbortError'));
      send(response, 202, { job: snapshot() });
      return;
    }
    if (path === '/api/baseline') {
      if (active()) { throw failure(409, '请等待当前检测结束后再设置基线。'); }
      try { send(response, 200, await setBaseline({ ...common, runIds: body.runIds })); }
      catch (error) { throw failure(400, cleanError(error)); }
      return;
    }
    throw failure(404, '没有这个操作。');
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    url: origin,
    async close() {
      closing = true;
      controller?.abort(new DOMException('Service stopped', 'AbortError'));
      await pending;
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => { if (error) { reject(error); } else { resolve(); } }));
    },
  };
}

export function openBrowser(url) {
  const address = new URL(url);
  if (address.protocol !== 'http:' || address.hostname !== '127.0.0.1') { throw new Error('只自动打开本机检测页面。'); }
  const [command, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : ['xdg-open', [url]];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', shell: false });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) { resolve(); } else { reject(new Error(`浏览器启动程序退出：${code}`)); }
    });
  });
}
