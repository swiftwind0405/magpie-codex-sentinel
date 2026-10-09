import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import plugin from '../index.mjs';
import { buildSuite } from '../src/suite.mjs';
import { normalizeOptions } from '../src/config.mjs';
import { parseResponse, normalizeUsage } from '../src/transport.mjs';
import { runEvaluation, runFingerprint, getHistory, getRun, setBaseline } from '../src/engine.mjs';
import { observedIdentity } from '../src/assessment.mjs';
import { acquireRun, ensureStore, readBaseline, atomicJSON } from '../src/storage.mjs';
import { renderHtml, formatHistory } from '../src/report.mjs';

const seed = 'integration-fixture-only';
const model = 'fixture/codex-test';
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
    events: null, json: null, text: null, hang: false, routeStatus: 200 };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
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
      if (state.hang) { return; }
      if (state.errorStatus) { response.writeHead(state.errorStatus, { 'content-type': 'application/json' }); response.end('{"error":{"message":"fixture error"}}'); return; }
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

test('oversized run writes keep the readable checkpoint and report failure instead of persisting unreadable JSON', async (t) => {
  const f = await fixture(t);
  f.state.text = JSON.stringify({ answer: 'x'.repeat(3 * 1024 * 1024) });
  const report = await runEvaluation({ ...f.args, profile: 'standard' });
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

test('real plugin entry runs the shared engine via a plain command, while native connection tests stay free', async (t) => {
  const f = await fixture(t); const hooks = await plugin({ directory: f.directory }, f.options);
  const loader = await hooks.auth.loader(async () => ({ type: 'api', key: f.args.apiKey }));
  const send = (content) => loader.fetch('http://127.0.0.1:1/virtual', { method: 'POST', body: JSON.stringify({ model: 'quick', stream: true, messages: [{ role: 'user', content }] }) });
  assert.match(await (await send('Hi')).text(), /sentinel check/); assert.equal(f.state.calls.length, 0);
  const text = await (await send('sentinel check')).text();
  assert.match(text, /6\/6/); assert.match(text, /快速初筛/); assert.equal(f.state.calls.length, 6);
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
