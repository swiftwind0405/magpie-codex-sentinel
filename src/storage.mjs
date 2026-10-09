import { mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const validRunId = (id) => typeof id === 'string' && /^[a-zA-Z0-9-]{8,100}$/.test(id);
const MAX_JSON_BYTES = 32 * 1024 * 1024;

export async function ensureStore(dataDir) {
  await mkdir(join(dataDir, 'runs'), { recursive: true, mode: 0o700 });
  await mkdir(join(dataDir, 'baselines'), { recursive: true, mode: 0o700 });
}

async function readJSON(path) {
  const info = await stat(path);
  if (info.size > MAX_JSON_BYTES) { throw new Error('历史文件超过 32 MiB，无法读取。'); }
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function atomicJSON(path, value) {
  const contents = JSON.stringify(value, null, 2) + '\n';
  if (Buffer.byteLength(contents, 'utf8') > MAX_JSON_BYTES) {
    throw new Error('记录超过 32 MiB，未覆盖已有文件。');
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(contents, 'utf8');
    await handle.sync(); await handle.close(); handle = null;
    await rename(temporary, path);
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function saveRun(dataDir, report) {
  if (!validRunId(report.id)) throw new Error('无效 run id。');
  await ensureStore(dataDir);
  await atomicJSON(join(dataDir, 'runs', `${report.id}.json`), report);
}

export async function readRun(dataDir, id) {
  if (!validRunId(id)) throw new Error('run id 格式不正确。请复制 /history 中的完整 ID。');
  const report = await readJSON(join(dataDir, 'runs', `${id}.json`));
  const rate = (value) => value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1);
  const natural = (value) => Number.isSafeInteger(value) && value >= 0;
  if (report.schemaVersion !== 1 || report.id !== id || !['evaluation', 'fingerprint'].includes(report.kind)
    || !['running', 'cancelled', 'completed', 'incomplete'].includes(report.runStatus)
    || !Array.isArray(report.cases) || !report.config || !report.summary || !Number.isFinite(Date.parse(report.startedAt))
    || !/^[a-f0-9]{64}$/.test(report.comparisonKey)) throw new Error('历史文件的版本、ID 或结构不匹配。');
  if (report.kind === 'evaluation' && (!natural(report.summary.passed) || !natural(report.summary.usable)
    || report.summary.passed > report.summary.usable || !rate(report.summary.rate) || !report.summary.families
    || Object.values(report.summary.families).some((f) => !f || !natural(f.total) || !natural(f.passed) || f.passed > f.total || !rate(f.rate)))) {
    throw new Error('历史能力分数结构无效。');
  }
  if (report.kind === 'evaluation' && (!report.verdict || typeof report.verdict.code !== 'string'
    || typeof report.verdict.label !== 'string' || typeof report.verdict.reason !== 'string')) {
    throw new Error('历史能力判定结构无效。');
  }
  return report;
}

export async function listRuns(dataDir) {
  let files;
  try { files = await readdir(join(dataDir, 'runs')); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const rows = [];
  for (const file of files.filter((name) => name.endsWith('.json')).sort().reverse()) {
    const id = file.slice(0, -5);
    if (!validRunId(id)) continue;
    try { rows.push(await readRun(dataDir, id)); }
    catch { rows.push({ id, kind: 'unreadable', error: '该历史文件损坏或版本不支持，已保留原文件。' }); }
  }
  return rows;
}

export async function readBaseline(dataDir, key) {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('无效 baseline key。');
  try {
    const baseline = await readJSON(join(dataDir, 'baselines', `${key}.json`));
    const rate = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
    if (baseline.schemaVersion !== 1 || baseline.comparisonKey !== key || !/^[a-f0-9]{64}$/.test(baseline.observedKey)
      || typeof baseline.assessmentVersion !== 'string' || !Number.isFinite(Date.parse(baseline.createdAt))
      || !Array.isArray(baseline.runIds) || baseline.runIds.length < 3 || baseline.runIds.length > 20
      || baseline.runIds.some((id) => !validRunId(id)) || new Set(baseline.runIds).size !== baseline.runIds.length
      || !rate(baseline.mean) || !rate(baseline.min) || !rate(baseline.max)
      || !baseline.families || !['candy', 'js-trace', 'constraint'].every((name) => rate(baseline.families[name]))) {
      throw new Error('基线文件结构无效，原文件已保留。');
    }
    return baseline;
  }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function saveBaseline(dataDir, baseline) {
  if (!/^[a-f0-9]{64}$/.test(baseline.comparisonKey)) throw new Error('无效 baseline key。');
  await ensureStore(dataDir);
  await atomicJSON(join(dataDir, 'baselines', `${baseline.comparisonKey}.json`), baseline);
}

/** One active run per local data directory, including other CLI/host processes. */
export async function acquireRun(dataDir) {
  await ensureStore(dataDir);
  const path = join(dataDir, 'run.lock'); const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() })); }
      finally { await handle.close(); }
      return async () => {
        try { const lock = await readJSON(path); if (lock.token === token) await unlink(path); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const reclaimPath = `${path}.reclaim`;
      let reclaim;
      try { reclaim = await open(reclaimPath, 'wx', 0o600); }
      catch (e) {
        if (e.code === 'EEXIST') throw new Error(`另一进程正在检查检测锁。如果上次检查被强行终止，请确认无检测进程后检查 ${reclaimPath}。`);
        throw e;
      }
      try {
        // A single reclaimer owns all stale-lock deletion. Other claimants
        // may create a new run lock, but cannot delete this reclaimer's read.
        let old;
        try { old = await readJSON(path); } catch (e) { if (e.code === 'ENOENT') continue; throw new Error(`检测锁无法读取，请检查 ${path}。`); }
        let alive = true;
        if (Number.isSafeInteger(old.pid) && old.pid > 0) {
          try { process.kill(old.pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
        }
        if (alive) throw new Error('已有一轮检测正在运行。请等它结束或取消后再试。');
        await unlink(path);
      } finally { await reclaim.close(); await unlink(reclaimPath).catch((e) => { if (e.code !== 'ENOENT') throw e; }); }
    }
  }
  throw new Error('检测锁竞争，请稍后重试。');
}
