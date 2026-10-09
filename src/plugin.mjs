import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeOptions, hash, defaultDirectory, VERSION } from './config.mjs';
import { startDashboard, openBrowser } from './web.mjs';

let companion;

/** Owned by Magpie's Bun host: no provider, auth method or virtual model. */
export default async function CodexSentinelPlugin(input = {}, options = {}) {
  if (companion) { return {}; }
  const directory = input.directory || defaultDirectory();
  let saved = {};
  try { saved = JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') { throw error; } }
  const port = options.port ?? 47821;
  if (!Number.isInteger(port) || port < 1 || port > 65535) { throw new Error('插件 port 必须是 1–65535 的整数。'); }
  const gatewayPort = Number.isInteger(saved.port) && saved.port >= 1024 && saved.port <= 65535 ? saved.port : 3425;
  const configured = { ...options, baseUrl: options.baseUrl || `http://127.0.0.1:${gatewayPort}/v1` };
  const config = normalizeOptions(configured, { directory, requireTarget: false });
  const serviceId = hash(`${config.dataDir}\n${config.baseUrl}`);
  const url = `http://127.0.0.1:${port}`;
  let app;
  let starting = false;
  async function ensure() {
    if (app || starting) { return; }
    starting = true;
    try {
      try { app = await startDashboard({ options: configured, directory, port, mode: 'plugin' }); }
      catch (error) {
        if (error.code !== 'EADDRINUSE') { throw error; }
        let state;
        try { state = await (await fetch(`${url}/api/state`, { signal: AbortSignal.timeout(1500) })).json(); }
        catch { throw new Error(`Sentinel 端口 ${port} 被其他服务占用；请修改插件 port 选项。`); }
        if (state.product !== 'codex-sentinel' || state.serviceId !== serviceId || state.mode !== 'plugin' || state.version !== VERSION) {
          throw new Error(`Sentinel 端口 ${port} 已被其他服务占用；请关闭旧服务或修改插件 port。`);
        }
        return; // Another Magpie host owns it; take over if that host exits.
      }
      if (options.open !== false) {
        try {
          const stamp = join(config.dataDir, '.browser-opened');
          await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
          const last = await stat(stamp).then((value) => value.mtimeMs).catch(() => 0);
          // CLI inspection and the desktop can initialize separate hosts together.
          if (Date.now() - last > 30000) {
            await openBrowser(url);
            await writeFile(stamp, url, { mode: 0o600 });
          }
        } catch { console.error(`Codex Sentinel 无法自动打开浏览器，请手动访问 ${url}`); }
      }
      console.info(`Codex Sentinel: ${url}`);
    } finally { starting = false; }
  }
  await ensure();
  const timer = setInterval(() => { ensure().catch((error) => console.error(error.message)); }, 2000);
  timer.unref();
  companion = { app, timer };
  // Magpie closes its host's stdin on disable/update/exit. Its process exit
  // closes this socket as well; paid jobs checkpoint each completed answer.
  return {};
}
