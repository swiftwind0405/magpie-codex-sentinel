import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, rm, readFile, writeFile, stat, mkdir } from 'node:fs/promises';
import { readdirSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDashboard } from '../src/web.mjs';
import { buildSuite } from '../src/suite.mjs';
import { normalizeOptions } from '../src/config.mjs';
import { parseResponse, normalizeUsage } from '../src/transport.mjs';
import { runEvaluation, runFingerprint, getHistory, getRun, setBaseline } from '../src/engine.mjs';
import { observedIdentity } from '../src/assessment.mjs';
import { acquireRun, ensureStore, readBaseline, readRun, atomicJSON } from '../src/storage.mjs';
import { renderHtml, formatHistory, formatReport } from '../src/report.mjs';
import { initializeBaselines } from '../src/baselines.mjs';

const seed = 'integration-fixture-only';
const model = 'codex/fixture-test';
const message = (text, phase = 'final_answer') => ({ type: 'message', role: 'assistant', phase, content: [{ type: 'output_text', text }] });
const complete = (text, output) => ({ type: 'response.completed', response: { status: 'completed', model: 'fixture-version', output: output || [message(text)], usage: { input_tokens: 50, output_tokens: 10, output_tokens_details: { reasoning_tokens: 0 } } } });

function sse(events, fragment = 17) {
  const bytes = new TextEncoder().encode(events.map((e) => `event: ${e.type}\r\ndata: ${JSON.stringify(e)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n');
  return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += fragment) controller.enqueue(bytes.slice(i, i + fragment)); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'sentinel-e2e-'));
  const answers = new Map(buildSuite({ profile: 'standard', seed }).map((c) => [c.prompt, c.expected]));
  const state = { calls: [], sessions: new Map(), wrong: false, errorStatus: null, member: model, routePending: false, routeReads: 0, tools: false,
    events: null, json: null, text: null, hang: false, hangAccount: null, accountErrors: new Map(), routeStatus: 200, gatewayVersion: '0.1.1132',
    accounts: [{ provider: 'codex', user: 'private@example.test', plan: 'test', windows: [] }, { provider: 'codex', user: 'second@example.test', plan: 'test', windows: [] }] };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (state.discoveryFailure?.path === url.pathname) {
        if (state.discoveryFailure.hang) { return; }
        if (state.discoveryFailure.disconnect) { response.destroy(); return; }
        const { status, type = 'application/json', body } = state.discoveryFailure;
        response.writeHead(status, { 'content-type': type });
        response.end(body); return;
      }
      if (url.pathname === '/v1') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ name: 'magpie', version: state.gatewayVersion })); return;
      }
      if (url.pathname === '/v1/magpie/quotas') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ data: state.accounts })); return;
      }
      if (url.pathname === '/v1/models') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: [{ id: model, supported_reasoning_levels: [{ effort: 'high' }] }] })); return; }
      if (url.pathname === '/v1/magpie/route') {
        state.routeReads++; const session = url.searchParams.get('session'); const seen = state.sessions.get(session);
        const pending = state.routePending && !url.searchParams.has('after');
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ session, seq: pending ? 1 : 2, route: seen ? { model: seen.model, effort: 'high', done: !pending, status: pending ? undefined : state.routeStatus, served: 'fixture-version', tries: [{ model: seen.model, effort: 'high', done: !pending, status: pending ? undefined : state.routeStatus }] } : null })); return;
      }
      if (url.pathname !== '/v1/responses') { response.writeHead(404).end(); return; }
      let raw = ''; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw); state.calls.push({ body, headers: request.headers });
      const account = Buffer.from(request.headers['x-magpie-account'] || '', 'latin1').toString('utf8');
      if (state.hang || state.hangAccount === account) { return; }
      const errorStatus = state.accountErrors.get(account) || state.errorStatus;
      if (errorStatus) { response.writeHead(errorStatus, { 'content-type': state.errorType || 'application/json', 'x-request-id': 'fixture-request-id' }); response.end(state.errorBody || '{"error":{"message":"fixture error"}}'); return; }
      state.sessions.set(request.headers['x-magpie-session'], { model: state.member });
      if (state.json) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(state.json));
        return;
      }
      if (state.events) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(state.events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
        return;
      }
      const prompt = body.input[0].content[0].text;
      let text;
      if (answers.has(prompt)) text = JSON.stringify({ answer: state.wrong ? null : answers.get(prompt) });
      else {
        const count = /(?:exactly|generate|produce|output|Give me|Give)\s+(\d+)/i.exec(prompt)?.[1] || /\b(301|319|327)\b/.exec(prompt)?.[1];
        assert.ok(count, 'Fingerprint fixture should recognize the reference count');
        text = JSON.stringify(Array.from({ length: Number(count) }, (_, i) => ((i * 47 + 9) % 355) + 1));
      }
      if (state.text !== null) { text = state.text; }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'X-Magpie-Provider': state.member.split('/')[0], 'X-Magpie-Model': state.member });
      const output = [message('中途说明不是最终答案。', 'commentary'), message(text)];
      if (state.tools) output.push({ type: 'function_call', name: 'unexpected_tool', arguments: '{}' });
      response.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: '中途说明不是最终答案。' })}\n\n`);
      if (state.emptyTerminal) {
        response.write(`event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', output_index: 1, item: { ...message(text), status: 'completed' } })}\n\n`);
        response.end(`event: response.completed\ndata: ${JSON.stringify(complete('', []))}\n\ndata: [DONE]\n\n`);
        return;
      }
      response.end(`event: response.completed\ndata: ${JSON.stringify(complete(text, output))}\n\ndata: [DONE]\n\n`);
    } catch (error) { response.writeHead(500).end(); state.error = error; }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await rm(directory, { recursive: true, force: true }); if (state.error) throw state.error; });
  const options = { target: model, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, seed, account: 'private@example.test' };
  return { directory, options, state, args: { options, directory, apiKey: 'fixture-secret-never-persist' } };
}

test('Responses grading uses final_answer only, even across fragmented UTF-8 / CRLF events', async () => {
  const result = await parseResponse(sse([{ type: 'response.output_text.delta', delta: '先说一下 29。' }, complete('{"answer":21}', [message('21 是答案吗？', 'commentary'), message('{"answer":21}')])], 5));
  assert.equal(result.text, '{"answer":21}');
  assert.equal(result.usage.reasoning, 0);
  const legacyMessage = (text) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
  const legacy = await parseResponse(new Response(JSON.stringify({ status: 'completed', output: [legacyMessage('old'), legacyMessage('final')] }), { headers: { 'content-type': 'application/json' } }));
  assert.equal(legacy.text, 'final');
  const empty = await parseResponse(sse([complete('', [message('commentary', 'commentary'), message('')])]));
  assert.equal(empty.text, '');
});

test('damaged, incomplete and tool-bearing responses cannot silently become ordinary wrong answers', async () => {
  for (const status of ['in_progress', undefined]) await assert.rejects(parseResponse(sse([{ type: 'response.completed', response: { status, output: [message('21')] } }])), { code: 'protocol_error' });
  await assert.rejects(parseResponse(sse([{ type: 'response.output_text.delta', delta: '{"answer":21}' }])), { code: 'incomplete_stream' });
  await assert.rejects(parseResponse(sse([{ type: 'response.incomplete', response: { status: 'incomplete' } }])), { code: 'truncated' });
  const tool = await parseResponse(sse([complete('{"answer":21}', [message('{"answer":21}'), { type: 'function_call' }])]));
  assert.equal(tool.toolUsed, true);
  assert.equal(normalizeUsage({}).reasoning, null);
});

test('VPS empty terminal output preserves a completed final answer, never commentary or unfinished text', async () => {
  // Structural replay of the VPS js-trace-06 response on 2026-10-10.
  const final = { ...message('{"answer":[8,8,4,7]}'), status: 'completed' };
  const done = { type: 'response.output_item.done', output_index: 1, item: final };
  const terminal = complete('', []);
  const events = [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning' } },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning' } },
    { type: 'response.output_item.added', output_index: 1, item: { ...final, status: 'in_progress', content: [] } },
    { type: 'response.output_text.done', output_index: 1, text: '{"answer":[8,8,4,7]}' },
    done, terminal,
  ];
  const result = await parseResponse(sse(events, 3));
  assert.equal(result.text, '{"answer":[8,8,4,7]}');
  assert.equal(result.diagnostic.outputSource, 'completed_items');
  assert.deepEqual(result.diagnostic.terminalOutput, []);
  assert.equal(result.diagnostic.completedItems[1].phase, 'final_answer');
  assert.doesNotMatch(JSON.stringify(result.diagnostic), /"text":|8,8,4,7/);

  const commentary = await parseResponse(sse([{ ...done, item: message('not an answer', 'commentary') }, terminal]));
  assert.equal(commentary.text, '');
  assert.equal(commentary.diagnostic.emptyReason, 'no_final_answer');
  const unfinished = await parseResponse(sse([events[2], { type: 'response.output_text.delta', delta: '{"answer":999}' }, terminal]));
  assert.equal(unfinished.text, '');
  assert.equal(unfinished.diagnostic.textDeltaChars, 14);
  const inconsistent = await parseResponse(sse([{ ...done, item: { ...final, status: 'in_progress' } }, terminal]));
  assert.equal(inconsistent.text, '', 'An item explicitly marked in progress is not a completed answer');
  await assert.rejects(parseResponse(sse([done])), { code: 'incomplete_stream' });
  const explicitEmpty = await parseResponse(sse([done, complete('', [message('')])]));
  assert.equal(explicitEmpty.text, '', 'An explicit terminal answer remains authoritative');
  const tools = await parseResponse(sse([done, { type: 'response.output_item.done', output_index: 2, item: { type: 'function_call' } }, terminal]));
  assert.equal(tools.toolUsed, true);
  for (const wire of ['json', 'sse']) {
    const malformed = { status: 'completed', output: [{ type: 'message', role: 'assistant', phase: 'final_answer', content: 'not-an-array' }] };
    await assert.rejects(parseResponse(wire === 'json' ? new Response(JSON.stringify(malformed)) : sse([{ type: 'response.completed', response: malformed }])),
      (error) => error.code === 'protocol_error' && error.evidence.diagnostic.emptyReason === 'unrecognized_output');
  }
});

test('empty terminal responses are graded and persisted through the real HTTP engine path', async (t) => {
  const f = await fixture(t); f.state.emptyTerminal = true;
  const report = await runEvaluation(f.args);
  assert.equal(report.summary.complete, true);
  assert.equal(report.summary.passed, 6);
  assert.equal(report.verdict.code, 'quick_only');
  assert.ok(report.cases.every((c) => c.diagnostic.outputSource === 'completed_items'));
  assert.deepEqual(await getRun({ ...f.args, id: report.id }), report);
});

test('empty answers expose missing scores without claiming a complete batch result', async (t) => {
  const f = await fixture(t); f.state.text = '';
  const d = await dashboard(t, f);
  await d.request('/api/runs', { target: model, profile: 'quick', accountId: d.accounts[0].id });
  const job = await d.finished();
  assert.equal(job.accounts[0].status, 'incomplete');
  const report = await getRun({ ...f.args, id: job.reportId });
  assert.equal(report.runStatus, 'completed');
  assert.equal(report.summary.complete, false);
  assert.match(report.verdict.label, /6 题未取得最终答案/);
  assert.match(report.verdict.reason, /已执行 6\/6 题，可评分 0 题/);
  assert.ok(report.cases.every((c) => c.diagnostic.emptyReason === 'empty_final_answer'));
});

test('HTTP diagnostics redact secrets, preserve the reason, and stop an unavailable account after one request', async (t) => {
  const f = await fixture(t);
  f.state.accountErrors.set(f.state.accounts[0].user, 404);
  f.state.errorBody = JSON.stringify({ error: { type: 'not_found_error', code: null,
    message: `X-Magpie-Account: no account "${f.options.account}" serves this model; its accounts are second@example.test, private-team` },
    token: 'do-not-copy-whole-payload' });
  const d = await dashboard(t, f);
  await d.request('/api/runs', { target: model, profile: 'quick', accountIds: d.accounts.map((a) => a.id) });
  const job = await d.finished();
  assert.deepEqual(job.accounts.map((a) => a.status), ['incomplete', 'completed']);
  assert.equal(f.state.calls.length, 7);
  const report = await getRun({ ...f.args, id: job.accounts[0].reportId });
  assert.equal(report.cases.length, 1);
  assert.equal(report.stop.scope, 'account');
  assert.equal(report.cases[0].diagnostic.cause, 'account_unavailable');
  assert.equal(report.cases[0].requestId, 'fixture-request-id');
  assert.match(report.verdict.label, /指定账号无法服务所选模型/);
  assert.match(report.verdict.reason, /5 题未执行/);
  for (const text of [JSON.stringify(report), formatReport(report), renderHtml(report)]) {
    assert.doesNotMatch(text, /private@example|second@example|private-team|do-not-copy/);
    assert.match(text, /not_found_error/);
  }
});

test('explicit shared configuration failures stop a batch; ambiguous 404s only stop the current account', async (t) => {
  const f = await fixture(t);
  const d = await dashboard(t, f);
  for (const code of ['model_not_found', 'endpoint_not_found', null]) {
    f.state.calls = [];
    f.state.errorStatus = 404;
    f.state.errorBody = JSON.stringify({ error: { code, message: 'fixture error' } });
    await d.request('/api/runs', { target: model, profile: 'quick', accountIds: d.accounts.map((a) => a.id) });
    const job = await d.finished();
    assert.deepEqual(job.accounts.map((a) => a.status), code ? ['incomplete', 'skipped'] : ['incomplete', 'incomplete']);
    assert.equal(f.state.calls.length, code ? 1 : 2);
    const report = await getRun({ ...f.args, id: job.accounts[0].reportId });
    assert.equal(report.stop.scope, code ? 'batch' : 'account');
  }
});

test('diagnostic bodies are bounded and redacted across HTTP and SSE failures', async (t) => {
  const f = await fixture(t);
  const privateMessage = `key=${f.args.apiKey} email=${f.options.account} token="unknown-upstream-secret" Bearer another-secret https://private.test/?password=hidden`;
  for (const sseFailure of [false, true]) {
    f.state.errorStatus = sseFailure ? null : 404;
    f.state.errorBody = JSON.stringify({ error: { message: privateMessage, code: 'model_not_found' } });
    f.state.events = sseFailure ? [{ type: 'response.failed', response: { status: 'failed', error: { message: privateMessage, code: 'model_not_found' } } }] : null;
    const report = await runEvaluation(f.args);
    assert.equal(report.stop.scope, 'batch');
    assert.equal(report.cases.length, 1);
    assert.doesNotMatch(JSON.stringify(report), /fixture-secret-never-persist|private@example|unknown-upstream-secret|another-secret|private.test/);
    assert.match(report.cases[0].diagnostic.upstreamMessage, /已隐藏/);
  }
  f.state.events = null; f.state.errorStatus = 404;
  f.state.errorType = 'text/plain';
  f.state.errorBody = `${privateMessage} ${'x'.repeat(20000)}`;
  const bounded = await runEvaluation(f.args);
  assert.equal(bounded.cases[0].httpStatus, 404);
  assert.equal(bounded.cases[0].diagnostic.bodyTruncated, true);
  assert.ok(bounded.cases[0].diagnostic.upstreamMessage.length <= 800);
  assert.doesNotMatch(JSON.stringify(bounded), /fixture-secret-never-persist|private@example|unknown-upstream-secret|another-secret/);
});

test('old incomplete reports gain specific explanations on read without rewriting history', async (t) => {
  const f = await fixture(t); f.state.text = '';
  const report = await runEvaluation(f.args);
  report.verdict = { code: 'incomplete', label: '运行不完整，无法判断能力变化', reason: '旧版通用说明' };
  for (const row of report.cases) { delete row.diagnostic; }
  const path = join(f.directory, 'codex-sentinel', 'runs', `${report.id}.json`);
  const original = JSON.stringify(report);
  await writeFile(path, original);
  const displayed = await getRun({ ...f.args, id: report.id });
  assert.match(displayed.verdict.label, /6 题未取得最终答案/);
  assert.equal(displayed.summary.usable, 0);
  assert.match(renderHtml(displayed), /此历史记录未保存响应诊断/);
  assert.match(formatReport(displayed), /无法从旧报告恢复/);
  assert.equal(await readFile(path, 'utf8'), original);
});

test('an unfinished trace with good headers is not a verified comparison identity', () => {
  const observed = observedIdentity([{ status: 'pass', model: 'fixture-version', route: { provider: 'fixture', model, trace: { model: null, effort: null, done: false, tries: [] } } }]);
  assert.equal(observed.stable, false); assert.equal(observed.traceMissing, 1);
});

test('real HTTP path completes quick checks, waits for route completion and never stores a gateway key', async (t) => {
  const f = await fixture(t); f.state.routePending = true;
  const report = await runEvaluation(f.args);
  assert.equal(report.summary.passed, 6); assert.equal(report.summary.complete, true);
  assert.equal(report.observed.stable, true); assert.equal(report.verdict.code, 'quick_only');
  assert.equal(f.state.calls.length, 6); assert.equal(f.state.routeReads, 12);
  for (const { body, headers } of f.state.calls) {
    assert.equal(body.model, model); assert.equal(body.store, false); assert.equal(body.input.length, 1); assert.deepEqual(body.tools, []);
    assert.equal(headers['x-magpie-account'], 'private@example.test');
    assert.equal(Object.hasOwn(body, 'expected'), false);
  }
  const rows = await getHistory(f.args); assert.equal(rows[0].id, report.id);
  assert.equal(JSON.stringify(rows).includes('fixture-secret-never-persist'), false);
  assert.equal(JSON.stringify(rows).includes('private@example.test'), false);
});

test('frozen same-configuration baselines require repeats and reject route changes and damaged references', async (t) => {
  const f = await fixture(t); const runs = [];
  for (let i = 0; i < 3; i++) runs.push(await runEvaluation({ ...f.args, profile: 'standard' }));
  const baseline = await setBaseline({ ...f.args, runIds: runs.map((r) => r.id) });
  assert.equal(baseline.mean, 1);
  await assert.rejects(setBaseline({ ...f.args, runIds: [runs[0].id, runs[0].id, runs[1].id] }), /重复/);
  f.state.wrong = true;
  const one = await runEvaluation({ ...f.args, profile: 'standard' });
  assert.equal(one.verdict.code, 'decline_signal');
  const two = await runEvaluation({ ...f.args, profile: 'standard' });
  assert.equal(two.verdict.code, 'repeated_decline');
  f.state.member = 'fixture/different-model';
  const changed = await runEvaluation({ ...f.args, profile: 'standard' });
  assert.equal(changed.verdict.code, 'route_changed');
  const path = join(f.directory, 'codex-sentinel', 'baselines', `${baseline.comparisonKey}.json`);
  const invalid = { ...baseline }; delete invalid.families;
  await writeFile(path, JSON.stringify(invalid));
  const afterDamage = await runEvaluation({ ...f.args, profile: 'standard' });
  assert.equal(afterDamage.summary.complete, true); assert.equal(afterDamage.verdict.code, 'baseline_unavailable');
  assert.equal(afterDamage.persisted, true); assert.equal((await getHistory(f.args))[0].id, afterDamage.id);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), invalid);
});

test('three completed standards automatically freeze a reference, then subsequent runs compare without replacing it', async (t) => {
  const f = await fixture(t);
  const dataDir = join(f.directory, 'codex-sentinel');
  const one = await runEvaluation({ ...f.args, profile: 'standard' });
  assert.equal(await readBaseline(dataDir, one.comparisonKey), null);
  assert.match(one.verdict.reason, /已收集 1\/3/);
  const two = await runEvaluation({ ...f.args, profile: 'standard' });
  assert.equal(await readBaseline(dataDir, one.comparisonKey), null);
  assert.match(two.verdict.reason, /已收集 2\/3/);
  const before = await readFile(join(dataDir, 'runs', `${one.id}.json`), 'utf8');
  // Completeness does not require a perfect score.
  f.state.wrong = true;
  const three = await runEvaluation({ ...f.args, profile: 'standard' });
  assert.equal(three.summary.rate, 0);
  const baseline = await readBaseline(dataDir, one.comparisonKey);
  assert.deepEqual(baseline.runIds, [one.id, two.id, three.id]);
  assert.equal(baseline.source, 'automatic');
  assert.equal(baseline.mean, 2 / 3);
  assert.equal(three.verdict.code, 'baseline_established');
  assert.equal(three.verdict.drop, undefined, 'Do not compare a reference sample against itself');
  assert.equal((await getRun({ ...f.args, id: one.id })).verdict.code, 'baseline_established');
  assert.equal(await readFile(join(dataDir, 'runs', `${one.id}.json`), 'utf8'), before);
  const baselinePath = join(dataDir, 'baselines', `${one.comparisonKey}.json`);
  const frozen = await readFile(baselinePath, 'utf8');
  const fourth = await runEvaluation({ ...f.args, profile: 'standard' });
  assert.equal(fourth.verdict.code, 'decline_signal');
  const fifth = await runEvaluation({ ...f.args, profile: 'standard' });
  assert.equal(fifth.verdict.code, 'repeated_decline');
  assert.equal(await readFile(baselinePath, 'utf8'), frozen);
  await initializeBaselines(dataDir);
  assert.equal(await readFile(baselinePath, 'utf8'), frozen);
});

test('automatic collection excludes incomplete and quick runs and separates actual routes', async (t) => {
  const f = await fixture(t);
  const dataDir = join(f.directory, 'codex-sentinel');
  const first = await runEvaluation({ ...f.args, profile: 'standard' });
  await runEvaluation(f.args);
  f.state.errorStatus = 429;
  await runEvaluation({ ...f.args, profile: 'standard' });
  f.state.errorStatus = null;
  f.state.member = 'fixture/other-route';
  await runEvaluation({ ...f.args, profile: 'standard' });
  const other = await runEvaluation({ ...f.args, profile: 'standard' });
  assert.match(other.verdict.reason, /已收集 2\/3/);
  assert.equal(await readBaseline(dataDir, first.comparisonKey), null);
  f.state.member = model;
  const second = await runEvaluation({ ...f.args, profile: 'standard' });
  assert.match(second.verdict.reason, /已收集 2\/3/);
  const third = await runEvaluation({ ...f.args, profile: 'standard' });
  assert.deepEqual((await readBaseline(dataDir, first.comparisonKey)).runIds, [first.id, second.id, third.id]);
});

test('automatic references do not mix accounts or different request configurations', async (t) => {
  const f = await fixture(t);
  const dataDir = join(f.directory, 'codex-sentinel');
  const first = await runEvaluation({ ...f.args, profile: 'standard' });
  const otherArgs = { ...f.args, options: { ...f.options, account: 'second@example.test' }, profile: 'standard' };
  const other = await runEvaluation(otherArgs);
  await runEvaluation(otherArgs);
  const different = await runEvaluation({ ...f.args, options: { ...f.options, effort: 'medium' }, profile: 'standard' });
  assert.equal(await readBaseline(dataDir, first.comparisonKey), null);
  assert.equal(await readBaseline(dataDir, other.comparisonKey), null);
  assert.equal(await readBaseline(dataDir, different.comparisonKey), null);
  const otherThird = await runEvaluation(otherArgs);
  assert.equal(otherThird.verdict.code, 'baseline_established');
  assert.equal(await readBaseline(dataDir, first.comparisonKey), null);
  assert.equal(await readBaseline(dataDir, different.comparisonKey), null);
  assert.equal((await readBaseline(dataDir, other.comparisonKey)).runIds.length, 3);
});

test('startup backfills existing records once without rewriting sources and respects the data lock', async (t) => {
  const f = await fixture(t);
  const dataDir = join(f.directory, 'codex-sentinel');
  const runs = [];
  for (let i = 0; i < 3; i++) { runs.push(await runEvaluation({ ...f.args, profile: 'standard' })); }
  const path = join(dataDir, 'baselines', `${runs[0].comparisonKey}.json`);
  await rm(path); // Reproduce an existing pre-automatic data directory.
  const sourceBytes = await Promise.all(runs.map((run) => readFile(join(dataDir, 'runs', `${run.id}.json`), 'utf8')));
  const release = await acquireRun(dataDir);
  await assert.rejects(initializeBaselines(dataDir), /已有一轮检测/);
  assert.equal(await readBaseline(dataDir, runs[0].comparisonKey), null);
  await release();
  const d = await dashboard(t, f);
  assert.equal((await (await d.request('/api/state')).json()).baselineWarning, '');
  const baseline = await readBaseline(dataDir, runs[0].comparisonKey);
  assert.deepEqual(baseline.runIds, runs.map((r) => r.id));
  assert.equal((await (await d.request(`/api/runs/${runs[0].id}`)).json()).verdict.code, 'baseline_established');
  assert.deepEqual(await Promise.all(runs.map((run) => readFile(join(dataDir, 'runs', `${run.id}.json`), 'utf8'))), sourceBytes);
  const bytes = await readFile(path, 'utf8');
  const again = await initializeBaselines(dataDir);
  assert.equal(again.created.length, 0);
  assert.equal(await readFile(path, 'utf8'), bytes);
});

test('baseline creation failure preserves saved scores and never claims reference success', async (t) => {
  const f = await fixture(t);
  const dataDir = join(f.directory, 'codex-sentinel');
  const one = await runEvaluation({ ...f.args, profile: 'standard' });
  await runEvaluation({ ...f.args, profile: 'standard' });
  const path = join(dataDir, 'baselines', `${one.comparisonKey}.json`);
  await mkdir(path);
  const third = await runEvaluation({ ...f.args, profile: 'standard' });
  assert.equal(third.persisted, true);
  assert.equal(third.summary.passed, 18);
  assert.equal(third.verdict.code, 'baseline_unavailable');
  assert.equal((await stat(path)).isDirectory(), true);
  assert.equal((await readRun(dataDir, third.id)).summary.passed, 18);
  await rm(path, { recursive: true });
  await initializeBaselines(dataDir);
  assert.equal((await readBaseline(dataDir, one.comparisonKey)).runIds.length, 3);
});

test('a third run whose final report cannot be saved never creates an automatic reference', async (t) => {
  const f = await fixture(t);
  const dataDir = join(f.directory, 'codex-sentinel');
  const one = await runEvaluation({ ...f.args, profile: 'standard' });
  await runEvaluation({ ...f.args, profile: 'standard' });
  const report = await runEvaluation({ ...f.args, profile: 'standard', onProgress({ message }) {
    if (!message.startsWith('18/')) { return; }
    for (const file of readdirSync(join(dataDir, 'runs'))) {
      const path = join(dataDir, 'runs', file);
      if (JSON.parse(readFileSync(path, 'utf8')).runStatus === 'running') {
        // A directory at the destination makes the real final atomic rename fail.
        unlinkSync(path);
        mkdirSync(path);
      }
    }
  } });
  assert.equal(report.summary.complete, true);
  assert.equal(report.persisted, false);
  assert.equal(await readBaseline(dataDir, one.comparisonKey), null);
});

test('CLI baseline without IDs backfills historical records without calling the gateway', async (t) => {
  const f = await fixture(t);
  const runs = [];
  for (let i = 0; i < 3; i++) { runs.push(await runEvaluation({ ...f.args, profile: 'standard' })); }
  const dataDir = join(f.directory, 'codex-sentinel');
  await rm(join(dataDir, 'baselines', `${runs[0].comparisonKey}.json`));
  const calls = f.state.calls.length;
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/sentinel.mjs', import.meta.url)), 'baseline', '--data-dir', dataDir, '--json']);
  let output = ''; let errors = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { errors += chunk; });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  assert.equal(code, 0, errors);
  assert.equal(JSON.parse(output).created.length, 1);
  assert.deepEqual((await readBaseline(dataDir, runs[0].comparisonKey)).runIds, runs.map((r) => r.id));
  assert.equal(f.state.calls.length, calls);
});

test('rate limits stop the run and have no capability denominator', async (t) => {
  const f = await fixture(t); f.state.errorStatus = 429;
  const report = await runEvaluation(f.args);
  assert.equal(f.state.calls.length, 1); assert.equal(report.summary.usable, 0); assert.equal(report.summary.rate, null);
  assert.equal(report.verdict.code, 'incomplete'); assert.equal(report.cases[0].status, 'rate_limited');
});

test('typed SSE and JSON failures stop on quota/auth errors but ordinary upstream failures remain distinct', async (t) => {
  const f = await fixture(t);
  const scenarios = [
    { events: [{ type: 'error', code: 'usage_limit_reached' }], status: 'rate_limited' },
    { events: [{ type: 'error', error: { type: 'rate_limit_error' } }], status: 'rate_limited' },
    { events: [{ type: 'response.failed', response: { status: 'failed', error: { code: 'insufficient_quota' } } }], status: 'rate_limited' },
    { events: [{ type: 'response.failed', response: { status: 'failed', error: { code: 'invalid_api_key' } } }], status: 'auth_error' },
    { json: { status: 'failed', error: { type: 'permission_error' } }, status: 'auth_error' },
    { json: { status: 'failed', error: { code: 'rate_limit_exceeded' } }, status: 'rate_limited' },
    { events: [{ type: 'response.failed', response: { status: 'failed', error: { code: 'server_error' } } }], status: 'upstream_error' },
  ];
  for (const scenario of scenarios) {
    f.state.calls = [];
    f.state.events = scenario.events ?? null;
    f.state.json = scenario.json ?? null;
    const report = await runEvaluation(f.args);
    assert.equal(f.state.calls.length, scenario.status === 'upstream_error' ? 6 : 1);
    assert.ok(report.cases.every((row) => row.status === scenario.status));
    assert.equal(report.summary.usable, 0);
    assert.equal(report.verdict.code, 'incomplete');
  }
});

test('generic SSE failures use completed Magpie route status for quota and authentication stops', async (t) => {
  const f = await fixture(t);
  f.state.events = [{ type: 'response.failed', response: { status: 'failed', error: { code: 'server_error' } } }];
  for (const status of [429, 401, 403]) {
    f.state.calls = [];
    f.state.routeStatus = status;
    const report = await runEvaluation(f.args);
    assert.equal(f.state.calls.length, 1);
    assert.equal(report.cases[0].status, status === 429 ? 'rate_limited' : 'auth_error');
    assert.equal(report.cases[0].httpStatus, 200);
    assert.equal(report.cases[0].route.trace.status, status);
  }
});

test('incomplete and failed responses retain reported usage and model without grading partial output', async (t) => {
  const f = await fixture(t);
  const usage = { input_tokens: 123, output_tokens: 456, output_tokens_details: { reasoning_tokens: 200 } };
  for (const state of ['incomplete', 'failed']) {
    for (const streaming of [false, true]) {
      const response = { status: state, model: 'fixture-observed-version', usage, output: [message('partial-answer-marker')],
        ...(state === 'failed' ? { error: { code: 'usage_limit_reached' } } : { incomplete_details: { reason: 'max_output_tokens' } }) };
      f.state.json = streaming ? null : response;
      f.state.events = streaming ? [{ type: `response.${state}`, response }] : null;
      const report = await runEvaluation(f.args);
      const saved = await getRun({ ...f.args, id: report.id });
      for (const row of saved.cases) {
        assert.equal(row.status, state === 'incomplete' ? 'truncated' : 'rate_limited');
        assert.equal(row.model, 'fixture-observed-version');
        assert.deepEqual(row.usage, { input: 123, output: 456, reasoning: 200, cached: null, total: 579 });
        assert.equal(row.text, '');
        assert.equal(row.grade, undefined);
      }
      assert.equal(saved.summary.tokens.output, saved.cases.length * 456);
      assert.equal(saved.summary.usable, 0);
      assert.equal(JSON.stringify(saved).includes('partial-answer-marker'), false);
    }
  }
});

test('cancelled runs retain completed paid work; cancelled baseline selection never writes', async (t) => {
  const f = await fixture(t); const controller = new AbortController();
  const report = await runEvaluation({ ...f.args, signal: controller.signal, onProgress({ message }) { if (message.startsWith('1/')) controller.abort(); } });
  assert.equal(report.cancelled, true); assert.equal(report.cases.length, 1); assert.equal(report.summary.passed, 1);
  assert.equal((await getHistory(f.args))[0].runStatus, 'cancelled');
  await assert.rejects(setBaseline({ ...f.args, runIds: ['nonexistent-id'], signal: controller.signal }), { name: 'AbortError' });
  assert.equal(await readBaseline(join(f.directory, 'codex-sentinel'), report.comparisonKey), null);
});

test('cancelling after the last scored answer prevents decline verdicts and baseline eligibility', async (t) => {
  const f = await fixture(t);
  const references = [];
  for (let index = 0; index < 3; index++) { references.push(await runEvaluation({ ...f.args, profile: 'standard' })); }
  await setBaseline({ ...f.args, runIds: references.map((run) => run.id) });
  f.state.wrong = true;
  const prior = await runEvaluation({ ...f.args, profile: 'standard' });
  assert.equal(prior.verdict.code, 'decline_signal');
  const controller = new AbortController();
  const report = await runEvaluation({ ...f.args, profile: 'standard', signal: controller.signal,
    onProgress({ message }) { if (message.startsWith('18/')) { controller.abort(); } } });
  assert.equal(report.summary.complete, true);
  assert.equal(report.cancelled, true);
  assert.equal(report.runStatus, 'cancelled');
  assert.equal(report.verdict.code, 'incomplete');
  assert.equal((await getRun({ ...f.args, id: report.id })).verdict.code, 'incomplete');
  await assert.rejects(setBaseline({ ...f.args, runIds: [references[0].id, references[1].id, report.id] }), /完整完成/);
});

test('oversized batch run keeps the readable checkpoint and exportable result and stops queued accounts', async (t) => {
  const f = await fixture(t);
  f.state.text = JSON.stringify({ answer: 'x'.repeat(3 * 1024 * 1024) });
  const d = await dashboard(t, f);
  assert.equal((await d.request('/api/runs', { target: model, profile: 'standard', accountIds: d.accounts.map((account) => account.id) })).status, 202);
  const job = await d.finished();
  assert.equal(job.status, 'failed');
  assert.deepEqual(job.accounts.map((item) => item.status), ['incomplete', 'skipped']);
  assert.ok(f.state.calls.every((call) => call.headers['x-magpie-account'] === d.accounts[0].name));
  const report = await (await d.request(`/api/runs/${job.reportId}/export?format=json`)).json();
  assert.equal(report.persisted, false);
  assert.equal(report.runStatus, 'incomplete');
  assert.equal(report.verdict.code, 'incomplete');
  assert.ok(f.state.calls.length < 18, 'Stop further probes after a checkpoint exceeds the storage budget');
  const path = join(f.directory, 'codex-sentinel', 'runs', `${report.id}.json`);
  assert.ok((await stat(path)).size <= 32 * 1024 * 1024);
  const checkpoint = await getRun({ ...f.args, id: report.id });
  assert.equal(checkpoint.runStatus, 'running');
  assert.equal(checkpoint.cases.length, report.cases.length - 1);
  assert.equal(checkpoint.cases[0].text, f.state.text);
  assert.doesNotThrow(() => renderHtml(checkpoint));
  assert.equal((await getHistory(f.args))[0].kind, 'evaluation');
});

test('storage budgets count UTF-8 bytes and reject an oversized first write', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'sentinel-size-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'large.json');
  await assert.rejects(atomicJSON(path, { text: '汉'.repeat(12 * 1024 * 1024) }), /超过 32 MiB/);
  await assert.rejects(stat(path), { code: 'ENOENT' });
});

test('a damaged verdict is isolated in history and does not break the CLI JSON output', async (t) => {
  const f = await fixture(t);
  const good = await runEvaluation(f.args);
  const damaged = await runEvaluation(f.args);
  delete damaged.verdict;
  const path = join(f.directory, 'codex-sentinel', 'runs', `${damaged.id}.json`);
  const contents = JSON.stringify(damaged);
  await writeFile(path, contents);
  const history = await getHistory(f.args);
  assert.equal(history.find((row) => row.id === damaged.id).kind, 'unreadable');
  assert.equal(history.find((row) => row.id === good.id).kind, 'evaluation');
  assert.match(formatHistory(history), /损坏或版本不支持/);
  const cli = fileURLToPath(new URL('../bin/sentinel.mjs', import.meta.url));
  const child = spawn(process.execPath, [cli, 'history', '--directory', f.directory, '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (data) => { stdout += data; });
  child.stderr.on('data', (data) => { stderr += data; });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  assert.equal(code, 0, stderr);
  assert.equal(JSON.parse(stdout).find((row) => row.id === damaged.id).kind, 'unreadable');
  assert.equal(await readFile(path, 'utf8'), contents);
});

test('fingerprint requests use exact upstream prompts without added local instructions, and keep separate results', async (t) => {
  const f = await fixture(t);
  const report = await runFingerprint(f.args);
  assert.equal(f.state.calls.length, 3); assert.equal(report.kind, 'fingerprint');
  assert.equal(report.fingerprint.status, 'reported'); assert.equal(report.fingerprint.source.magpieTransportCalibrated, false);
  assert.equal(Object.hasOwn(report, 'verdict'), false);
  for (const call of f.state.calls) assert.equal(Object.hasOwn(call.body, 'instructions'), false);
});

async function dashboard(t, f) {
  const app = await startDashboard({ ...f.args, port: 0 });
  t.after(() => app.close());
  const request = (path, body, headers = {}) => fetch(app.url + path, body === undefined ? { headers } : {
    method: 'POST', headers: { origin: app.url, 'content-type': 'application/json', 'x-sentinel-request': '1', ...headers }, body: JSON.stringify(body),
  });
  const { accounts } = await (await request('/api/accounts')).json();
  const finished = async () => {
    for (let i = 0; i < 500; i++) {
      const { job } = await (await request('/api/state')).json();
      if (job && ['done', 'failed'].includes(job.status)) { return job; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail('Dashboard run did not finish within 5 seconds');
  };
  return { app, request, finished, accounts };
}

test('dashboard uses the real HTTP engine, exposes saved reports and blocks cross-origin probe requests', async (t) => {
  const f = await fixture(t);
  const d = await dashboard(t, f);
  const page = await d.request('/');
  const html = await page.text();
  assert.match(html, /Codex Sentinel · 账号检测台/);
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal((await (await d.request('/api/state')).json()).version, manifest.version);
  // Every section link and script-bound control must resolve uniquely.
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  for (const [, target] of html.matchAll(/href="#([^"]+)"/g)) { assert.ok(ids.includes(target)); }
  const script = await d.request('/app.js');
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /javascript/);
  assert.match(html, /<script src="\/app\.js" type="module"><\/script>/);
  const cardModule = await d.request('/account-result.js');
  assert.equal(cardModule.status, 200);
  assert.match(cardModule.headers.get('content-type'), /javascript/);
  assert.equal(await cardModule.text(), await readFile(new URL('../web/account-result.js', import.meta.url), 'utf8'));
  for (const [, id] of (await script.text()).matchAll(/\$\('([^']+)'\)/g)) { assert.ok(ids.includes(id), `Missing control: ${id}`); }
  const stylesheet = await d.request('/style.css');
  assert.equal(stylesheet.status, 200);
  assert.match(stylesheet.headers.get('content-type'), /text\/css/);
  assert.match(page.headers.get('content-security-policy'), /style-src 'self'/);
  assert.equal((await d.request('/src/web.mjs')).status, 404);
  // fetch normalizes Host to the URL; use HTTP directly to exercise rebinding.
  const badHostStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(`${d.app.url}/api/state`, { headers: { host: 'evil.example' } }, (response) => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end();
  });
  assert.equal(badHostStatus, 403);
  const data = await (await d.request('/api/models')).json();
  assert.equal(data.models[0].id, model);
  assert.equal(f.state.calls.length, 0);
  const body = { target: model, profile: 'quick', effort: 'high', accountId: d.accounts[0].id };
  assert.equal((await d.request('/api/runs', { ...body, accountId: undefined })).status, 400);
  assert.equal((await d.request('/api/runs', { ...body, accountId: 'unknown-account' })).status, 400);
  assert.equal((await d.request('/api/runs', { ...body, target: 'group/auto' })).status, 400);
  assert.equal((await d.request('/api/runs', body, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await d.request('/api/runs', body, { 'x-sentinel-request': '' })).status, 403);
  assert.equal((await d.request('/api/runs', { ...body, profile: 'unknown' })).status, 400);
  assert.equal(f.state.calls.length, 0);
  assert.equal((await d.request('/api/runs', body)).status, 202);
  const job = await d.finished();
  assert.equal(job.status, 'done');
  const report = await (await d.request(`/api/runs/${job.reportId}`)).json();
  assert.equal(report.summary.passed, 6);
  assert.equal(report.runStatus, 'completed');
  assert.equal((await getRun({ ...f.args, id: report.id })).id, report.id);
  const history = await (await d.request('/api/history')).json();
  assert.equal(history.runs[0].id, report.id);
  assert.equal('cases' in history.runs[0], false);
  for (const format of ['html', 'md', 'json']) {
    const response = await d.request(`/api/runs/${report.id}/export?format=${format}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition'), /attachment/);
    const text = await response.text();
    assert.ok(text.includes(report.id));
    assert.equal(text.includes(f.args.apiKey), false);
  }
  assert.equal((await d.request('/api/baseline', { runIds: [report.id] })).status, 400);
  assert.equal(f.state.calls.length, 6);
  assert.equal(JSON.stringify({ job, history, report }).includes(f.args.apiKey), false);
});

test('dashboard refresh cannot duplicate jobs; stopping a job persists cancellation and releases the run lock', async (t) => {
  const f = await fixture(t);
  f.state.hang = true;
  const d = await dashboard(t, f);
  const body = { target: model, profile: 'quick', accountId: d.accounts[0].id };
  const started = await (await d.request('/api/runs', body)).json();
  assert.equal((await d.request('/api/runs', body)).status, 409);
  for (let i = 0; i < 100 && !f.state.calls.length; i++) { await new Promise((resolve) => setTimeout(resolve, 10)); }
  assert.equal(f.state.calls.length, 1);
  const refreshed = await (await d.request('/api/state')).json();
  assert.equal(refreshed.job.id, started.job.id);
  assert.equal(refreshed.job.status, 'running');
  assert.equal((await d.request('/api/cancel', { id: 'a-different-job' })).status, 409);
  assert.equal((await d.request('/api/cancel', { id: started.job.id })).status, 202);
  const job = await d.finished();
  const report = await getRun({ ...f.args, id: job.reportId });
  assert.equal(report.runStatus, 'cancelled');
  assert.equal(report.verdict.code, 'incomplete');
  assert.equal(report.cases.length, 1);
  assert.equal(f.state.calls.length, 1);
  f.state.hang = false;
  assert.equal((await d.request('/api/runs', body)).status, 202);
  const next = await d.finished();
  assert.notEqual(next.reportId, job.reportId);
  assert.equal((await getRun({ ...f.args, id: next.reportId })).runStatus, 'completed');
});

test('dashboard automatically collects three standards and exposes collection progress without selection controls', async (t) => {
  const f = await fixture(t);
  const d = await dashboard(t, f);
  const runs = [];
  const sourceBytes = [];
  const html = await (await d.request('/')).text();
  assert.doesNotMatch(html, /id="baseline"|data-select|设为基线/);
  for (let i = 0; i < 3; i++) {
    assert.equal((await d.request('/api/runs', { target: model, profile: 'standard', accountId: d.accounts[0].id })).status, 202);
    const job = await d.finished();
    runs.push(await getRun({ ...f.args, id: job.reportId }));
    sourceBytes.push(await readFile(join(f.directory, 'codex-sentinel', 'runs', `${job.reportId}.json`), 'utf8'));
    assert.equal(runs.at(-1).verdict.code, i < 2 ? 'no_baseline' : 'baseline_established');
  }
  const ids = runs.map((run) => run.id);
  assert.deepEqual((await readBaseline(join(f.directory, 'codex-sentinel'), runs[0].comparisonKey)).runIds, ids);
  for (const [index, run] of runs.entries()) {
    assert.equal(await readFile(join(f.directory, 'codex-sentinel', 'runs', `${run.id}.json`), 'utf8'), sourceBytes[index]);
    assert.equal((await getRun({ ...f.args, id: run.id })).verdict.code, 'baseline_established');
  }
});

test('all-account dashboard run completes one standard check per account with separate saved reports', async (t) => {
  const f = await fixture(t);
  const d = await dashboard(t, f);
  const accountIds = d.accounts.map((account) => account.id);
  assert.equal((await d.request('/api/runs', { target: model, profile: 'standard', effort: 'high', seed, accountIds })).status, 202);
  const job = await d.finished();
  assert.equal(job.scope, 'all');
  assert.equal(job.status, 'done');
  assert.deepEqual(job.accounts.map((item) => item.status), ['completed', 'completed']);
  assert.deepEqual(f.state.calls.map((call) => call.headers['x-magpie-account']),
    [...Array(18).fill(d.accounts[0].name), ...Array(18).fill(d.accounts[1].name)]);
  const reports = await Promise.all(job.accounts.map((item) => getRun({ ...f.args, id: item.reportId })));
  assert.deepEqual(reports.map((report) => report.config.accountId), accountIds);
  assert.equal(new Set(reports.map((report) => report.comparisonKey)).size, 2);
  for (const report of reports) {
    assert.equal(report.profile, 'standard');
    assert.equal(report.config.target, model);
    assert.equal(report.config.effort, 'high');
    assert.equal(report.config.seed, seed);
    assert.equal(report.cases.length, 18);
    assert.equal(report.persisted, true);
    assert.equal(report.verdict.code, 'no_baseline', 'Running every account must not create a baseline or declare health');
    assert.deepEqual(await (await d.request(`/api/runs/${report.id}`)).json(), report);
  }
  const { runs } = await (await d.request('/api/history')).json();
  assert.deepEqual(new Set(runs.map((run) => run.id)), new Set(reports.map((report) => report.id)));
});

test('all-account dashboard run continues after quota and authentication failures without switching account', async (t) => {
  const f = await fixture(t);
  f.state.accounts.push({ provider: 'codex', user: 'third@example.test · 团队', plan: 'test', windows: [] });
  f.state.accountErrors.set(f.state.accounts[0].user, 429);
  f.state.accountErrors.set(f.state.accounts[1].user, 401);
  const d = await dashboard(t, f);
  assert.equal((await d.request('/api/runs', { target: model, profile: 'quick', accountIds: d.accounts.map((account) => account.id) })).status, 202);
  const job = await d.finished();
  assert.deepEqual(job.accounts.map((item) => item.status), ['incomplete', 'incomplete', 'completed']);
  assert.deepEqual(f.state.calls.map((call) => Buffer.from(call.headers['x-magpie-account'], 'latin1').toString('utf8')),
    [d.accounts[0].name, d.accounts[1].name, ...Array(6).fill(d.accounts[2].name)]);
  for (const [index, status] of ['rate_limited', 'auth_error'].entries()) {
    const report = await getRun({ ...f.args, id: job.accounts[index].reportId });
    assert.equal(report.config.accountId, d.accounts[index].id);
    assert.equal(report.cases.length, 1);
    assert.equal(report.cases[0].status, status);
    assert.equal(report.summary.usable, 0);
    assert.equal(report.verdict.code, 'incomplete');
  }
  assert.equal((await getRun({ ...f.args, id: job.accounts[2].reportId })).cases.length, 6);
});

test('all-account fingerprint run preserves its separate three-sample contract for each account', async (t) => {
  const f = await fixture(t);
  const d = await dashboard(t, f);
  assert.equal((await d.request('/api/runs', { target: model, profile: 'fingerprint', accountIds: d.accounts.map((account) => account.id) })).status, 202);
  const job = await d.finished();
  assert.deepEqual(f.state.calls.map((call) => call.headers['x-magpie-account']),
    [...Array(3).fill(d.accounts[0].name), ...Array(3).fill(d.accounts[1].name)]);
  for (const item of job.accounts) {
    const report = await getRun({ ...f.args, id: item.reportId });
    assert.equal(report.kind, 'fingerprint');
    assert.equal(report.cases.length, 3);
    assert.equal(report.config.accountId, item.accountId);
    assert.equal(Object.hasOwn(report, 'verdict'), false);
  }
});

test('stopping an all-account run retains finished reports, cancels the current account and never starts queued accounts', async (t) => {
  const f = await fixture(t);
  f.state.accounts.push({ provider: 'codex', user: 'third@example.test', plan: 'test', windows: [] });
  f.state.hangAccount = f.state.accounts[1].user;
  const d = await dashboard(t, f);
  const body = { target: model, profile: 'quick', accountIds: d.accounts.map((account) => account.id) };
  const started = await (await d.request('/api/runs', body)).json();
  for (let i = 0; i < 200 && f.state.calls.length < 7; i++) { await new Promise((resolve) => setTimeout(resolve, 10)); }
  assert.equal(f.state.calls.length, 7);
  assert.equal((await d.request('/api/runs', body)).status, 409);
  assert.equal((await d.request('/api/runs', { target: model, profile: 'quick', accountId: d.accounts[0].id })).status, 409);
  f.state.accounts.push({ provider: 'codex', user: 'new@example.test', windows: [] });
  const refreshed = await (await d.request('/api/state')).json();
  assert.equal(refreshed.job.id, started.job.id);
  assert.deepEqual(refreshed.job.accounts.map((item) => item.status), ['completed', 'running', 'queued']);
  assert.equal((await d.request('/api/cancel', { id: 'wrong-job' })).status, 409);
  assert.equal((await d.request('/api/cancel', { id: started.job.id })).status, 202);
  const job = await d.finished();
  assert.equal(job.cancelled, true);
  assert.deepEqual(job.accounts.map((item) => item.status), ['completed', 'cancelled', 'skipped']);
  assert.equal(f.state.calls.length, 7);
  assert.equal((await getRun({ ...f.args, id: job.accounts[0].reportId })).runStatus, 'completed');
  const cancelled = await getRun({ ...f.args, id: job.accounts[1].reportId });
  assert.equal(cancelled.runStatus, 'cancelled');
  assert.equal(cancelled.config.accountId, d.accounts[1].id);
  const { runs } = await (await d.request('/api/history')).json();
  assert.equal(runs.length, 2);
  assert.equal(job.accounts[2].reportId, undefined);
  f.state.hangAccount = null;
  assert.equal((await d.request('/api/runs', { target: model, profile: 'quick', accountId: d.accounts[2].id })).status, 202);
  assert.equal((await d.finished()).accounts[0].status, 'completed');
});

test('all-account run rejects empty, duplicate and changed lists before any probe', async (t) => {
  const f = await fixture(t);
  const d = await dashboard(t, f);
  const ids = d.accounts.map((account) => account.id);
  for (const accountIds of [[], [ids[0], ids[0]], [ids[0]], [ids[0], 'unknown'], null]) {
    assert.equal((await d.request('/api/runs', { target: model, profile: 'quick', accountIds })).status, 400);
  }
  f.state.accounts.pop();
  assert.equal((await d.request('/api/runs', { target: model, profile: 'quick', accountIds: ids })).status, 400);
  f.state.accounts = [];
  assert.equal((await d.request('/api/runs', { target: model, profile: 'quick', accountIds: [] })).status, 400);
  assert.equal(f.state.calls.length, 0);
});

test('account diagnostics identify the failed discovery step without exporting upstream secrets or making probes', async (t) => {
  const f = await fixture(t);
  const d = await dashboard(t, f);
  const privateText = 'private@example.test fixture-secret-never-persist /home/private/config token=secret';
  for (const scenario of [
    { path: '/v1', status: 401, body: privateText, stage: 'gateway_info', code: 'auth_error' },
    { path: '/v1/magpie/quotas', status: 403, body: privateText, stage: 'accounts', code: 'auth_error' },
    { path: '/v1/magpie/quotas', status: 404, body: privateText, stage: 'accounts', code: 'http_error' },
    { path: '/v1/magpie/quotas', status: 429, body: privateText, stage: 'accounts', code: 'rate_limited' },
    { path: '/v1', status: 200, type: 'text/html', body: `<html>${privateText}</html>`, stage: 'gateway_info', code: 'invalid_json' },
    { path: '/v1', status: 200, body: 'null', stage: 'gateway_info', code: 'invalid_gateway' },
    { path: '/v1', status: 200, body: JSON.stringify({ name: 'magpie', version: privateText }), stage: 'gateway_info', code: 'unsupported_version' },
    { path: '/v1', status: 200, body: privateText.repeat(5000), stage: 'gateway_info', code: 'response_too_large' },
    { path: '/v1/magpie/quotas', status: 200, body: JSON.stringify({ error: privateText }), stage: 'accounts', code: 'invalid_accounts' },
    { path: '/v1/magpie/quotas', status: 200, body: JSON.stringify({ data: [{ provider: 'codex', user: privateText, windows: [null] }] }), stage: 'accounts', code: 'invalid_accounts' },
  ]) {
    f.state.discoveryFailure = scenario;
    const response = await d.request('/api/accounts');
    assert.equal(response.status, 502);
    const result = await response.json();
    assert.ok(result.diagnostic, 'Account failures must include a shareable diagnostic');
    const step = result.diagnostic.steps.at(-1);
    assert.equal(step.stage, scenario.stage);
    assert.equal(step.code, scenario.code);
    assert.equal(step.httpStatus, scenario.status);
    assert.ok(step.elapsedMs >= 0);
    assert.match(result.error, new RegExp(scenario.stage === 'gateway_info' ? '版本' : '账号'));
    assert.doesNotMatch(JSON.stringify(result), /private@example|fixture-secret|\/home\/private|token=secret/);
  }
  f.state.discoveryFailure = null;
  f.state.gatewayVersion = '0.1.1000';
  const old = await (await d.request('/api/accounts')).json();
  assert.equal(old.diagnostic.steps.length, 1);
  assert.equal(old.diagnostic.steps[0].code, 'unsupported_version');
  assert.equal(old.diagnostic.steps[0].gatewayVersion, '0.1.1000');
  f.state.gatewayVersion = '0.1.1132';
  for (const empty of [false, true]) {
    if (empty) { f.state.accounts = []; }
    const response = await d.request('/api/accounts');
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.diagnostic.accountCount, empty ? 0 : 2);
    assert.deepEqual(result.diagnostic.steps.map((step) => step.code), ['ok', 'ok']);
    assert.doesNotMatch(JSON.stringify(result.diagnostic), /private@example|fixture-secret/);
  }
  assert.equal(f.state.calls.length, 0, 'Account discovery and diagnostic collection must not run inference');
});

test('account diagnostics capture real network disconnects and the gateway version timeout', async (t) => {
  const f = await fixture(t);
  const d = await dashboard(t, f);
  for (const failure of [{ disconnect: true, code: 'network_error' }, { hang: true, code: 'timeout' }]) {
    f.state.discoveryFailure = { path: '/v1', ...failure };
    const response = await d.request('/api/accounts');
    assert.equal(response.status, 502);
    const result = await response.json();
    assert.equal(result.diagnostic.steps.length, 1);
    const step = result.diagnostic.steps[0];
    assert.equal(step.stage, 'gateway_info');
    assert.equal(step.code, failure.code);
    assert.equal(step.httpStatus, null);
    assert.equal(step.timeoutMs, 5000);
    assert.ok(step.elapsedMs >= 0);
    assert.match(result.error, /读取 Magpie 版本失败/);
  }
  assert.equal(f.state.calls.length, 0);
});

test('account selection pins the named account, separates history and rejects mixed-account baselines', async (t) => {
  const f = await fixture(t);
  f.state.gatewayVersion = 'v0.1.1111';
  f.state.accounts[1].user = 'second@example.test · 团队';
  const d = await dashboard(t, f);
  const runs = [];
  for (const account of [d.accounts[0], d.accounts[0], d.accounts[1]]) {
    assert.equal((await d.request('/api/runs', { target: model, profile: 'standard', accountId: account.id })).status, 202);
    const job = await d.finished();
    assert.equal(job.accountName, account.name);
    const report = await getRun({ ...f.args, id: job.reportId });
    assert.equal(report.config.accountId, account.id);
    assert.equal(report.config.accountPinned, true);
    assert.equal(Buffer.from(f.state.calls.at(-1).headers['x-magpie-account'], 'latin1').toString('utf8'), account.name);
    runs.push(report);
  }
  assert.equal(runs[0].comparisonKey, runs[1].comparisonKey);
  assert.notEqual(runs[1].comparisonKey, runs[2].comparisonKey);
  const mixed = await d.request('/api/baseline', { runIds: runs.map((run) => run.id) });
  assert.equal(mixed.status, 400);
  assert.match((await mixed.json()).error, /账户/);
  const history = await getHistory(f.args);
  assert.deepEqual(new Set(history.map((run) => run.id)), new Set(runs.slice(0, 2).map((run) => run.id)));
  const { runs: all } = await (await d.request('/api/history')).json();
  assert.equal(all.length, 3);
  assert.equal(JSON.stringify(all).includes(f.state.accounts[1].user), false, 'Persisted reports mask names; the local account list maps their stable IDs');
  f.state.accounts.pop();
  assert.equal((await d.request('/api/runs', { target: model, profile: 'quick', accountId: d.accounts[1].id })).status, 400);
  assert.equal(f.state.calls.length, 54, 'A removed account must never fall back to an existing account');
  f.state.gatewayVersion = '0.1.1000';
  const oldGateway = await d.request('/api/runs', { target: model, profile: 'quick', accountId: d.accounts[0].id });
  assert.equal(oldGateway.status, 502);
  assert.match((await oldGateway.json()).error, /当前网关报告 0\.1\.1000/);
  assert.equal(f.state.calls.length, 54, 'Unverified old gateways must not silently ignore the account pin');
});

test('default CLI starts the local dashboard with no-open, and SIGINT cancels its real active job', async (t) => {
  const f = await fixture(t);
  f.state.hang = true;
  const cli = fileURLToPath(new URL('../bin/sentinel.mjs', import.meta.url));
  const child = spawn(process.execPath, [cli, '--no-open', '--port', '0', '--base-url', f.options.baseUrl, '--directory', f.directory], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CLI did not start')), 5000);
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const match = /http:\/\/127\.0\.0\.1:\d+/.exec(stdout);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
  });
  const { accounts } = await (await fetch(`${url}/api/accounts`)).json();
  const request = await fetch(`${url}/api/runs`, { method: 'POST', headers: { origin: url, 'content-type': 'application/json', 'x-sentinel-request': '1' }, body: JSON.stringify({ target: model, profile: 'quick', accountId: accounts[0].id }) });
  assert.equal(request.status, 202);
  for (let i = 0; i < 100 && !f.state.calls.length; i++) { await new Promise((resolve) => setTimeout(resolve, 10)); }
  assert.equal(f.state.calls.length, 1);
  child.kill('SIGINT');
  assert.equal(await exited, 0, stderr);
  const history = await getHistory(f.args);
  assert.equal(history[0].runStatus, 'cancelled');
  assert.equal(history[0].persisted, true);
});

test('stale-lock recovery grants at most one concurrent owner', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'sentinel-lock-')); t.after(() => rm(dataDir, { recursive: true, force: true }));
  await ensureStore(dataDir);
  await writeFile(join(dataDir, 'run.lock'), JSON.stringify({ pid: 2000000000, token: 'dead-owner' }));
  const attempts = await Promise.allSettled([acquireRun(dataDir), acquireRun(dataDir), acquireRun(dataDir)]);
  const winners = attempts.filter((r) => r.status === 'fulfilled');
  try { assert.equal(winners.length, 1); } finally { for (const winner of winners) await winner.value(); }
});

test('configuration rejects recursive targets and remote credential-bearing URLs; HTML treats outputs as text', async (t) => {
  assert.throws(() => normalizeOptions({ target: 'codex-sentinel/quick' }), /自己/);
  assert.throws(() => normalizeOptions({ target: model, baseUrl: 'https://x:secret@example.org/v1', allowRemote: true }), /密码/);
  assert.throws(() => normalizeOptions({ target: model, baseUrl: 'https://example.org/v1' }), /allowRemote/);
  const f = await fixture(t); const report = await runEvaluation(f.args);
  report.cases[0].text = '</pre><script>alert(1)</script>';
  const html = renderHtml(report);
  assert.equal(html.includes('</pre><script>alert(1)</script>'), false); assert.match(html, /&lt;script&gt;alert/);
});

test('CLI completes a real local HTTP run and reports a usable JSON result', async (t) => {
  const f = await fixture(t); const cli = fileURLToPath(new URL('../bin/sentinel.mjs', import.meta.url));
  const child = spawn(process.execPath, [cli, 'run', '--target', model, '--base-url', f.options.baseUrl, '--seed', seed, '--directory', f.directory, '--json'], { env: { ...process.env, MAGPIE_GATEWAY_KEY: f.args.apiKey }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = ''; child.stdout.on('data', (data) => stdout += data); child.stderr.on('data', (data) => stderr += data);
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  assert.equal(code, 0, stderr); const report = JSON.parse(stdout);
  assert.equal(report.summary.passed, 6); assert.equal(report.persisted, true);
  assert.equal(stdout.includes(f.args.apiKey), false); assert.match(stderr, /6\/6/);
});

test('CLI run deadline exits as incomplete while an explicit cancellation still exits 130', async (t) => {
  const f = await fixture(t);
  f.state.hang = true;
  const cli = fileURLToPath(new URL('../bin/sentinel.mjs', import.meta.url));
  for (const cancel of [false, true]) {
    f.state.calls = [];
    const child = spawn(process.execPath, [cli, 'run', '--target', model, '--base-url', f.options.baseUrl, '--directory', f.directory,
      '--run-timeout-ms', cancel ? '10000' : '1000', '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let signalled = false;
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => {
      stderr += data;
      if (cancel && !signalled && stderr.includes('将串行发送')) { signalled = true; child.kill('SIGINT'); }
    });
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    assert.equal(code, cancel ? 130 : 3, stderr);
    const report = JSON.parse(stdout);
    assert.equal(report.cancelled, cancel);
    assert.equal(report.runStatus, cancel ? 'cancelled' : 'incomplete');
    assert.equal(report.verdict.code, 'incomplete');
    if (!cancel) {
      assert.equal(f.state.calls.length, 1);
      assert.equal(report.cases[0].status, 'run_timeout');
    }
  }
});
