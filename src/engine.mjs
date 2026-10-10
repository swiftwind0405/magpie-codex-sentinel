import { randomUUID } from 'node:crypto';
import { normalizeOptions, publicConfig, comparisonKey, VERSION } from './config.mjs';
import { buildSuite, gradeCase, SUITE_VERSION } from './suite.mjs';
import { buildFingerprintProbes, analyzeFingerprint } from './fingerprint.mjs';
import { requestProbe } from './transport.mjs';
import { acquireRun, listRuns, readRun, saveRun, readBaseline, saveBaseline } from './storage.mjs';
import { summarize, observedIdentity, makeBaseline, assessRun } from './assessment.mjs';
import { stopForFailure } from './diagnostics.mjs';
import { collectBaselines, explainBaselineCollection } from './baselines.mjs';
export { formatReport, formatHistory } from './report.mjs';

function runId() { return `${new Date().toISOString().replace(/[-:.]/g, '')}-${randomUUID().slice(0, 8)}`; }

async function run({ options = {}, apiKey, directory, profile = 'quick', signal, onProgress = () => {}, fetchImpl }, kind) {
  const config = normalizeOptions(options, { apiKey, directory });
  if (kind === 'evaluation' && !['quick', 'standard'].includes(profile)) throw new Error('检测 profile 必须是 quick 或 standard。');
  const probes = kind === 'evaluation' ? buildSuite({ profile, seed: config.seed }) : buildFingerprintProbes({ seed: config.seed, samples: 3 });
  const release = await acquireRun(config.dataDir);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('Run timed out', 'TimeoutError')), config.runTimeoutMs);
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const report = { schemaVersion: 1, pluginVersion: VERSION, id: runId(), kind, profile: kind === 'evaluation' ? profile : 'fingerprint',
    startedAt: new Date().toISOString(), config: publicConfig(config), suiteVersion: kind === 'evaluation' ? SUITE_VERSION : 'modeltrace-json-probes-v1',
    comparisonKey: comparisonKey(config, kind === 'evaluation' ? profile : 'fingerprint', kind === 'evaluation' ? SUITE_VERSION : 'modeltrace-json-probes-v1'),
    cases: [], warnings: [], execution: 'fresh-stateless-gateway-requests', runStatus: 'running', persisted: false };
  const progress = (message) => { try { onProgress({ message }); } catch { /* A disconnected renderer must not change a score. */ } };
  async function checkpoint() {
    report.updatedAt = new Date().toISOString();
    report.observed = observedIdentity(report.cases);
    if (kind === 'evaluation') {
      report.summary = summarize(report.cases, probes.length);
      report.verdict = { code: 'running', label: '检测尚未完成', reason: '这是逐题保存的中间记录，不能作为能力基线。' };
    } else {
      report.summary = { planned: probes.length, attempted: report.cases.length, completed: report.cases.filter((c) => c.status === 'completed').length };
      report.fingerprint = { status: 'incomplete', prediction: null, acceptedSamples: 0 };
    }
    report.persisted = true;
    await saveRun(config.dataDir, report);
  }
  try {
    if (kind === 'evaluation' && profile === 'standard') {
      try { await collectBaselines(config.dataDir, await listRuns(config.dataDir)); }
      catch { report.warnings.push('历史参考收集暂不可用，将保留本轮检测成绩。'); }
    }
    await checkpoint();
    progress(`目标 ${config.target}；将串行发送 ${probes.length} 个独立测试请求，每题超时 ${config.timeoutMs / 1000} 秒。输出 token 上限是否生效由通道决定。`);
    for (const probe of probes) {
      if (combined.aborted) break;
      const result = await requestProbe(config, probe, { signal: combined, fetchImpl });
      const row = { ...probe, ...result };
      if (kind === 'evaluation' && result.status === 'completed') {
        row.grade = gradeCase(probe, result.text);
        row.status = row.grade.passed ? 'pass' : row.grade.formatValid ? 'wrong_answer' : 'invalid_format';
      }
      report.cases.push(row);
      const stop = stopForFailure(row);
      if (stop) { report.stop = { ...stop, caseId: row.id }; }
      try { await checkpoint(); }
      catch {
        report.persisted = false;
        report.warnings.push('逐题保存失败，已停止后续请求。当前界面仍显示已取得的结果；磁盘可能只有较早的中间记录。');
        break;
      }
      const state = { pass: '通过', wrong_answer: '答案不符', invalid_format: '格式不符', completed: '采样完成' }[row.status] || row.status;
      progress(`${report.cases.length}/${probes.length} ${probe.id}：${state}`);
      if (stop) {
        report.warnings.push(stop.reason); break;
      }
    }
    report.completedAt = new Date().toISOString();
    report.cancelled = combined.aborted && combined.reason?.name !== 'TimeoutError';
    report.runStatus = report.cancelled ? 'cancelled' : combined.aborted ? 'incomplete' : report.persisted && report.cases.length === probes.length ? 'completed' : 'incomplete';
    report.observed = observedIdentity(report.cases);
    report.transport = {
      requestedOutputLimit: config.maxOutputTokens,
      outputLimitEnforced: 'unknown',
      promptIsolation: 'new gateway request, no working-conversation history',
      gatewayMayRewrite: true,
    };
    if (report.observed.distinct.some((entry) => entry.provider === 'codex') || config.target.startsWith('codex/')) {
      report.transport.outputLimitEnforced = false;
      report.transport.knownMagpieCodexTransforms = ['adds Codex system prompt', 'moves instructions to developer input', 'removes max_output_tokens', 'forces tool_choice auto', 'normalizes ultra to max'];
      report.warnings.push('已核对版本的 Magpie codex 订阅适配器会添加系统提示、删除 max_output_tokens，并可能改写工具/推理参数；输出 token 设置不是硬费用上限。指纹未在该路径校准。');
    }
    if (kind === 'evaluation') {
      report.summary = summarize(report.cases, probes.length);
      let baseline = null; let priorRuns = [];
      let historyUnavailable = false;
      try { baseline = await readBaseline(config.dataDir, report.comparisonKey); priorRuns = await listRuns(config.dataDir); }
      catch { baseline = null; priorRuns = []; historyUnavailable = true; report.warnings.push('基线或历史读取失败，未执行下降判断；原始文件已保留。'); }
      if (priorRuns.some((r) => r.kind === 'unreadable')) {
        priorRuns = [];
        report.warnings.push('部分历史无法读取，本轮不会作“连续两轮下降”的确认。');
      }
      report.verdict = historyUnavailable ? { code: 'baseline_unavailable', label: '基线无法读取，仅报告本轮得分', reason: '原基线没有被覆盖；请检查历史文件和数据目录权限。' } : assessRun(report, baseline, priorRuns);
      report.baseline = baseline ? { createdAt: baseline.createdAt, runIds: baseline.runIds, mean: baseline.mean, observedKey: baseline.observedKey } : null;
    } else {
      const accepted = report.cases.filter((c) => c.status === 'completed').map((c) => ({ text: c.text, expectedCount: c.expectedCount }));
      report.fingerprint = analyzeFingerprint(accepted);
      report.summary = { planned: probes.length, attempted: report.cases.length, completed: accepted.length };
      if (!report.observed.stable) report.warnings.push('本轮实际路由证据不完整或混用通道，合并的输出指纹不适合归属于单一通道。');
    }
    report.warnings.push(config.account ? '本次使用 X-Magpie-Account 严格固定账号；Magpie 的契约是不可用时失败，不切换账号。归属依赖网关执行此契约，不是对上游登录身份的独立认证。' : '未固定账户：结果代表该 Magpie 路由。多账户切换可能影响比较。');
    try { report.persisted = true; await saveRun(config.dataDir, report); }
    catch { report.persisted = false; report.warnings.push('最终结果无法保存，请保留当前输出；没有声称磁盘记录已更新。'); }
    if (kind === 'evaluation' && report.persisted && profile === 'standard') {
      try {
        const saved = await listRuns(config.dataDir);
        const result = await collectBaselines(config.dataDir, saved);
        if (result.errors.includes(report.comparisonKey)) {
          report.warnings.push('自动保存历史参考失败，请检查数据目录权限或已有参考文件；检测成绩已保存。');
          report.verdict = { code: 'baseline_unavailable', label: '历史参考保存失败，仅报告本轮得分', reason: report.warnings.at(-1) };
        } else {
          Object.assign(report, await explainBaselineCollection(config.dataDir, report, saved));
        }
      } catch {
        report.warnings.push('自动收集历史参考失败，已保存的检测记录未改写；请检查数据目录。');
      }
    }
    return report;
  } finally { clearTimeout(timer); await release(); }
}

export function runEvaluation(args = {}) { return run(args, 'evaluation'); }
export function runFingerprint(args = {}) { return run(args, 'fingerprint'); }

export async function getHistory({ options = {}, apiKey, directory, limit = 20 } = {}) {
  const config = normalizeOptions(options, { apiKey, directory, requireTarget: false });
  const runs = await listRuns(config.dataDir);
  const visible = runs.filter((r) => r.kind === 'unreadable' || ((!config.target || r.config?.target === config.target)
    && (!config.account || r.config?.accountId === publicConfig(config).accountId))).slice(0, limit);
  return Promise.all(visible.map((run) => explainBaselineCollection(config.dataDir, run, runs)));
}

export async function getRun({ options = {}, apiKey, directory, id } = {}) {
  const config = normalizeOptions(options, { apiKey, directory, requireTarget: false });
  const report = await readRun(config.dataDir, id);
  return explainBaselineCollection(config.dataDir, report, report.verdict?.code === 'no_baseline' ? await listRuns(config.dataDir) : []);
}

export async function setBaseline({ options = {}, apiKey, directory, runIds, signal } = {}) {
  signal?.throwIfAborted();
  const config = normalizeOptions(options, { apiKey, directory, requireTarget: false });
  if (!Array.isArray(runIds)) throw new Error('请提供要作为参考的 runIds 数组。');
  const runs = [];
  for (const id of runIds) { signal?.throwIfAborted(); runs.push(await readRun(config.dataDir, id)); }
  const baseline = makeBaseline(runs);
  signal?.throwIfAborted();
  const release = await acquireRun(config.dataDir);
  try {
    signal?.throwIfAborted();
    await saveBaseline(config.dataDir, baseline);
    return { ...baseline, message: `已将 ${runs.length} 轮标准检测设为固定参考，平均通过率 ${(baseline.mean * 100).toFixed(1)}%。后续相同配置使用此参考，不自动覆盖。` };
  } finally { await release(); }
}
