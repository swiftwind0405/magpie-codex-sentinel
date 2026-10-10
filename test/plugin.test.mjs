import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccess } from '../src/access.mjs';

for (const remote of [false, true]) {
test(`plugin ${remote ? 'remote' : 'local'} serves without provider hooks, shares one port and takes over after owner exit`, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'sentinel-plugin-'));
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const children = [];
  t.after(async () => {
    for (const child of children) { child.kill(); }
    await Promise.all(children.map((child) => child.closed));
    await rm(directory, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${port}`;
  const options = { port, open: false };
  if (remote) {
    options.remoteOrigin = 'https://sentinel.example.test';
    options.passwordFile = join(directory, 'password');
    await writeFile(options.passwordFile, 'plugin-remote-fixture-password', { mode: 0o600 });
  }
  const access = await createAccess(options);
  const readState = () => remote ? access.peerState(port) : fetch(url + '/api/state', { signal: AbortSignal.timeout(500) }).then((response) => response.json());
  async function host() {
    const source = `import plugin from ${JSON.stringify(new URL('../index.mjs', import.meta.url).href)};
      const hooks = await plugin(${JSON.stringify({ directory })}, ${JSON.stringify(options)});
      console.log('HOOKS:' + JSON.stringify(hooks));
      process.stdin.resume();`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.closed = new Promise((resolve) => child.once('close', resolve));
    children.push(child);
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const hooks = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Plugin did not start: ' + stderr)), 5000);
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += chunk;
        const match = /HOOKS:(.*)\n/.exec(output);
        if (match) { clearTimeout(timeout); resolve(JSON.parse(match[1])); }
      });
      child.once('error', reject);
    });
    assert.deepEqual(hooks, {}, 'A dashboard plugin must not add auth/provider/config hooks');
    return child;
  }
  const first = await host();
  const firstState = await readState();
  assert.equal(firstState.mode, 'plugin');
  assert.equal(firstState.job, null, 'Loading the plugin must not start paid checks');
  if (!remote) { assert.match(await (await fetch(url)).text(), /Codex 账号/); }
  const second = await host();
  assert.equal((await readState()).serviceId, firstState.serviceId);
  first.kill();
  await first.closed;
  let resumed = false;
  for (let i = 0; i < 40; i++) {
    try {
      const state = await readState();
      resumed = state.mode === 'plugin' && state.serviceId === firstState.serviceId;
      if (resumed) { break; }
    } catch { /* The second host checks ownership every two seconds. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(resumed, true);
  second.kill();
  await second.closed;
  await assert.rejects(fetch(url + '/api/state', { signal: AbortSignal.timeout(500) }));
});
}
