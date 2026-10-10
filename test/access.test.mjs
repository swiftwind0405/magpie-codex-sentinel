import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDashboard } from '../src/web.mjs';
import { createAccess } from '../src/access.mjs';

const origin = 'https://sentinel.example.test';
const password = 'remote-fixture-only-password';
async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'sentinel-access-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const passwordFile = join(directory, 'password');
  await writeFile(passwordFile, password + '\n', { mode: 0o600 });
  return { directory, options: { remoteOrigin: origin, passwordFile } };
}

function call(port, path, { body, cookie, headers = {}, method = body ? 'POST' : 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method,
      headers: { host: 'sentinel.example.test', origin, 'content-type': 'application/json', 'x-sentinel-request': '1', ...(cookie ? { cookie } : {}), ...headers },
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

test('remote mode fails closed on missing credentials, weak passwords and non-HTTPS origins', async (t) => {
  const f = await setup(t);
  for (const options of [
    { remoteOrigin: origin }, { passwordFile: f.options.passwordFile },
    { ...f.options, remoteOrigin: 'http://sentinel.example.test' },
    { ...f.options, remoteOrigin: origin + '/sentinel' },
    { ...f.options, remoteBind: '::' },
  ]) { await assert.rejects(createAccess(options, {})); }
  await writeFile(f.options.passwordFile, 'short');
  await assert.rejects(createAccess(f.options, {}), /密码/);
  assert.deepEqual(await createAccess({}, {}), { remote: false, bind: '127.0.0.1' });
});

test('remote login protects every data path, preserves paid job storage, rejects CSRF and invalidates logout cookies', async (t) => {
  const f = await setup(t);
  let gatewayReads = 0;
  let paidCalls = 0;
  const gateway = createServer(async (req, res) => {
    gatewayReads++;
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1') { res.end(JSON.stringify({ name: 'magpie', version: '0.1.1132' })); }
    else if (req.url === '/v1/magpie/quotas') { res.end(JSON.stringify({ data: [{ provider: 'codex', user: 'remote@example.test', plan: 'test', windows: [] }] })); }
    else if (req.url === '/v1/responses') {
      paidCalls++;
      assert.equal(req.headers['x-magpie-account'], 'remote@example.test');
      for await (const chunk of req) { void chunk; }
      res.writeHead(429); res.end('{"error":{"message":"fixture exhausted"}}');
    } else { res.writeHead(404).end('{}'); }
  });
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { gateway.closeAllConnections(); gateway.close(resolve); }));
  f.options.baseUrl = `http://127.0.0.1:${gateway.address().port}/v1`;
  const app = await startDashboard({ ...f, port: 0 });
  t.after(() => app.close());
  assert.equal(app.remote, true);
  assert.equal(app.url, origin);
  assert.equal((await call(app.port, '/')).headers.location, '/login');
  assert.match((await call(app.port, '/login')).text, /autocomplete="current-password"/);
  for (const path of ['/api/state', '/api/accounts', '/api/models', '/api/history', '/api/runs/12345678', '/api/runs/12345678/export?format=html', '/app.js']) {
    assert.equal((await call(app.port, path)).status, 401, path);
  }
  for (const path of ['/api/runs', '/api/cancel', '/api/baseline']) {
    assert.equal((await call(app.port, path, { body: {} })).status, 401, path);
  }
  assert.equal(gatewayReads, 0, 'Unauthenticated requests must never reach Magpie');
  assert.equal((await call(app.port, '/api/login', { body: { password: 'wrong' } })).status, 401);
  for (const headers of [{ origin: 'https://evil.test' }, { host: 'evil.test' }, { 'x-sentinel-request': '' }, { 'sec-fetch-site': 'cross-site' }]) {
    assert.equal((await call(app.port, '/api/login', { body: { password }, headers })).status, 403);
  }
  const login = await call(app.port, '/api/login', { body: { password }, cookie: '__Host-sentinel=' + 'a'.repeat(64) });
  assert.equal(login.status, 200);
  const setCookie = login.headers['set-cookie'][0];
  assert.match(setCookie, /HttpOnly; Secure; SameSite=Lax; Max-Age=43200/);
  assert.doesNotMatch(setCookie, /Domain=/);
  const cookie = setCookie.split(';')[0];
  assert.notEqual(cookie, '__Host-sentinel=' + 'a'.repeat(64));
  const state = await call(app.port, '/api/state', { cookie });
  assert.equal(state.status, 200);
  assert.doesNotMatch(state.text, new RegExp(password));
  const accounts = JSON.parse((await call(app.port, '/api/accounts', { cookie })).text).accounts;
  const body = { profile: 'quick', target: 'codex/fixture', accountId: accounts[0].id };
  assert.equal((await call(app.port, '/api/runs', { cookie, body, headers: { origin: 'https://evil.test' } })).status, 403);
  assert.equal(paidCalls, 0);
  assert.equal((await call(app.port, '/api/runs', { cookie, body })).status, 202);
  let job;
  for (let i = 0; i < 100; i++) {
    job = JSON.parse((await call(app.port, '/api/state', { cookie })).text).job;
    if (job.status === 'done') { break; }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(job.status, 'done');
  assert.equal(paidCalls, 1);
  const report = await call(app.port, `/api/runs/${job.reportId}/export?format=json`, { cookie });
  assert.equal(report.status, 200);
  assert.equal(JSON.parse(report.text).cases[0].status, 'rate_limited');
  const saved = await readFile(join(f.directory, 'codex-sentinel', 'runs', job.reportId + '.json'), 'utf8');
  assert.deepEqual(JSON.parse(saved), JSON.parse(report.text));
  assert.doesNotMatch(saved, new RegExp(password));
  const logout = await call(app.port, '/api/logout', { cookie, body: {} });
  assert.match(logout.headers['set-cookie'][0], /Max-Age=0/);
  assert.equal((await call(app.port, '/api/state', { cookie })).status, 401);
  assert.equal((await call(app.port, `/api/runs/${job.reportId}/export`, { cookie })).status, 401);
});

test('login rate limit is global and cannot be bypassed by forged proxy IP headers', async (t) => {
  const f = await setup(t);
  const app = await startDashboard({ ...f, port: 0 });
  t.after(() => app.close());
  for (let i = 0; i < 10; i++) {
    assert.equal((await call(app.port, '/api/login', { body: { password: 'wrong' }, headers: { 'x-forwarded-for': `192.0.2.${i}` } })).status, 401);
  }
  const blocked = await call(app.port, '/api/login', { body: { password } });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers['retry-after'], '60');
});

test('remote plugin ownership checks use authenticated access and reject different credentials', async (t) => {
  const f = await setup(t);
  const access = await createAccess(f.options, {});
  const app = await startDashboard({ ...f, port: 0, mode: 'plugin' });
  t.after(() => app.close());
  assert.equal((await access.peerState(app.port)).mode, 'plugin');
  for (let i = 0; i < 12; i++) { assert.equal((await access.peerState(app.port)).remote, true); }
  await writeFile(f.options.passwordFile, 'different-fixture-password');
  const other = await createAccess(f.options, {});
  await assert.rejects(other.peerState(app.port), /未接受/);
});

test('sessions expire after twelve hours and do not survive server restart', async (t) => {
  const f = await setup(t);
  let app = await startDashboard({ ...f, port: 0 });
  t.after(() => app.close());
  const login = () => call(app.port, '/api/login', { body: { password } });
  const cookie = (await login()).headers['set-cookie'][0].split(';')[0];
  assert.equal((await call(app.port, '/api/state', { cookie })).status, 200);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.mock.timers.setTime(Date.now() + 12 * 60 * 60 * 1000 + 1);
  assert.equal((await call(app.port, '/api/state', { cookie })).status, 401);
  t.mock.timers.reset();
  const fresh = (await login()).headers['set-cookie'][0].split(';')[0];
  await app.close();
  app = await startDashboard({ ...f, port: 0 });
  assert.equal((await call(app.port, '/api/state', { cookie: fresh })).status, 401);
});

test('Magpie-style key link exchanges for a session and clean address without exposing keys', async (t) => {
  const f = await setup(t);
  const app = await startDashboard({ ...f, port: 0 });
  t.after(() => app.close());
  const navigation = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
  const result = await call(app.port, '/?k=' + encodeURIComponent(password), { headers: navigation });
  assert.equal(result.status, 303);
  assert.equal(result.headers.location, '/');
  assert.equal(result.headers['referrer-policy'], 'no-referrer');
  assert.equal(result.headers['cache-control'], 'no-store');
  const cookie = result.headers['set-cookie'][0].split(';')[0];
  assert.equal((await call(app.port, '/api/state', { cookie })).status, 200);
  assert.equal((await call(app.port, '/api/state', { cookie, headers: navigation })).status, 403);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(password));
  const wrong = await call(app.port, '/?k=wrong-secret', { headers: navigation });
  assert.equal(wrong.status, 303);
  assert.equal(wrong.headers.location, '/login?error=invalid_key');
  assert.equal(wrong.headers['set-cookie'], undefined);
  assert.doesNotMatch(JSON.stringify(wrong), /wrong-secret/);
  assert.equal((await call(app.port, '/?k=' + password, { headers: { host: 'evil.test' } })).status, 403);
  const page = await call(app.port, '/', { cookie });
  assert.doesNotMatch(page.text, /id="logout"/);
});
