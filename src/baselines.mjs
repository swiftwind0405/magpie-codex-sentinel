import { AUTO_BASELINE_RUNS, baselineCandidates, baselineCollectionVerdict, makeBaseline } from './assessment.mjs';
import { acquireRun, listRuns, readBaseline, saveBaseline } from './storage.mjs';

// Callers that already own the data-directory lock use this during run finalization.
export async function collectBaselines(dataDir, runs) {
  const ready = baselineCandidates(runs).filter((group) => group.length >= AUTO_BASELINE_RUNS)
    .map((group) => group.slice(0, AUTO_BASELINE_RUNS))
    .sort((a, b) => Date.parse(a.at(-1).startedAt) - Date.parse(b.at(-1).startedAt)
      || a.at(-1).id.localeCompare(b.at(-1).id));
  const created = [];
  const errors = [];
  const seen = new Set();
  for (const group of ready) {
    const key = group[0].comparisonKey;
    if (seen.has(key)) { continue; }
    seen.add(key);
    try {
      if (await readBaseline(dataDir, key)) { continue; }
      const baseline = { ...makeBaseline(group), source: 'automatic',
        note: '同配置、同实际通道最先集齐的三轮完整标准检测；固定参考，不是官方健康认证。' };
      await saveBaseline(dataDir, baseline);
      created.push(baseline);
    } catch {
      errors.push(key);
    }
  }
  return { created, errors };
}

export async function initializeBaselines(dataDir) {
  const release = await acquireRun(dataDir);
  try { return await collectBaselines(dataDir, await listRuns(dataDir)); }
  finally { await release(); }
}

export async function explainBaselineCollection(dataDir, run, runs) {
  if (run.kind !== 'evaluation' || run.verdict.code !== 'no_baseline') { return run; }
  try {
    const baseline = await readBaseline(dataDir, run.comparisonKey);
    return { ...run, verdict: baselineCollectionVerdict(run, baseline, runs),
      baseline: baseline ? { createdAt: baseline.createdAt, runIds: baseline.runIds, mean: baseline.mean, observedKey: baseline.observedKey } : null };
  } catch {
    return { ...run, verdict: { code: 'baseline_unavailable', label: '历史参考无法读取，仅报告本轮得分',
      reason: '原文件未被覆盖，请检查历史参考文件和数据目录权限。' } };
  }
}
