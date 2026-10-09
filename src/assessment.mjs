import { hash } from './config.mjs';

export const ASSESSMENT_VERSION = 'reference-drop-v1';
export const DROP_THRESHOLD = 0.20;
export const FAMILY_DROP_THRESHOLD = 0.15;
const SCORED = new Set(['pass', 'wrong_answer', 'invalid_format']);

export function summarize(cases, planned) {
  const usable = cases.filter((c) => SCORED.has(c.status));
  const families = {};
  for (const row of usable) {
    const f = families[row.family] ??= { passed: 0, total: 0, formatErrors: 0 };
    f.total++; if (row.status === 'pass') f.passed++; if (row.status === 'invalid_format') f.formatErrors++;
  }
  for (const f of Object.values(families)) f.rate = f.total ? f.passed / f.total : null;
  const passed = usable.filter((c) => c.status === 'pass').length;
  const formats = usable.filter((c) => c.status === 'invalid_format').length;
  const errors = {};
  for (const row of cases.filter((c) => !SCORED.has(c.status))) errors[row.status] = (errors[row.status] || 0) + 1;
  const tokens = {};
  for (const field of ['input', 'output', 'reasoning', 'cached', 'total']) {
    const known = cases.map((c) => c.usage?.[field]).filter((v) => typeof v === 'number' && Number.isFinite(v));
    tokens[field] = known.length ? known.reduce((a, b) => a + b, 0) : null;
    tokens[`${field}Reported`] = known.length;
  }
  return { planned, attempted: cases.length, usable: usable.length, passed, rate: usable.length ? passed / usable.length : null,
    formatErrors: formats, formatRate: usable.length ? (usable.length - formats) / usable.length : null,
    complete: cases.length === planned && usable.length === planned,
    unscored: planned - usable.length, errors, families, tokens,
    elapsedMs: cases.reduce((sum, c) => sum + (c.elapsedMs || 0), 0) };
}

export function observedIdentity(cases) {
  const scored = cases.filter((c) => SCORED.has(c.status) || c.status === 'completed');
  const identities = []; let traceMissing = 0; let headerConflict = 0; let fallbackCount = 0;
  for (const c of scored) {
    const trace = c.route?.trace;
    const model = c.route?.model || trace?.model || null;
    const provider = c.route?.provider || model?.split('/')[0] || null;
    const attempt = trace?.tries?.[0];
    const completeTrace = trace?.done === true && trace.status >= 200 && trace.status < 300
      && typeof trace.model === 'string' && Boolean(trace.model)
      && trace.tries?.length === 1 && attempt?.done === true && attempt.status >= 200 && attempt.status < 300
      && !attempt.failed && attempt.model === trace.model;
    if (!completeTrace || !model || !provider) traceMissing++;
    if (c.route?.model && trace?.model && c.route.model !== trace.model) headerConflict++;
    if ((trace?.tries?.length || 0) > 1) fallbackCount++;
    identities.push({ provider, model, vendorModel: c.model ?? null, gatewayEffort: trace?.effort ?? null, effortReported: completeTrace && trace?.effort != null });
  }
  const distinct = [...new Set(identities.map((i) => JSON.stringify(i)))].map((i) => JSON.parse(i));
  return { scope: 'gateway-observed', distinct, traceMissing, headerConflict, fallbackCount,
    stable: scored.length > 0 && distinct.length === 1 && !traceMissing && !headerConflict && !fallbackCount,
    key: distinct.length === 1 && !traceMissing && !headerConflict && !fallbackCount ? hash(JSON.stringify(distinct[0])) : null };
}

export function makeBaseline(runs) {
  if (!Array.isArray(runs) || runs.length < 3 || runs.length > 20) throw new Error('基线需要明确指定 3–20 轮标准检测的 ID。');
  if (new Set(runs.map((r) => r.id)).size !== runs.length) throw new Error('同一轮不能重复计入基线。');
  const first = runs[0];
  if (runs.some((r) => r.kind !== 'evaluation' || r.profile !== 'standard' || r.runStatus !== 'completed' || !r.summary?.complete)) {
    throw new Error('只能选取完整完成的标准检测；快速检测、指纹检测和网络失败不能作为能力基线。');
  }
  if (runs.some((r) => !r.observed?.stable || r.observed.key !== first.observed.key)) {
    throw new Error('基线各题必须观测到一致的实际通道和推理档位，且无 fallback；不能混用不同实际路由。');
  }
  if (runs.some((r) => r.comparisonKey !== first.comparisonKey || r.suiteVersion !== first.suiteVersion || JSON.stringify(r.cases.map((c) => c.id)) !== JSON.stringify(first.cases.map((c) => c.id)))) {
    throw new Error('基线必须使用同一通道、账户选择、凭据、档位、种子、题库和运行参数。');
  }
  const mean = runs.reduce((s, r) => s + r.summary.rate, 0) / runs.length;
  const families = {};
  for (const family of Object.keys(first.summary.families)) families[family] = runs.reduce((s, r) => s + r.summary.families[family].rate, 0) / runs.length;
  return { schemaVersion: 1, assessmentVersion: ASSESSMENT_VERSION, createdAt: new Date().toISOString(),
    comparisonKey: first.comparisonKey, observedKey: first.observed.key, config: first.config,
    suiteVersion: first.suiteVersion, profile: first.profile, runIds: runs.map((r) => r.id), mean, families,
    min: Math.min(...runs.map((r) => r.summary.rate)), max: Math.max(...runs.map((r) => r.summary.rate)),
    note: '用户选定的本机参考表现，不是官方健康标签或经过校准的总体能力基准。' };
}

function dropDetails(run, baseline) {
  const drop = baseline.mean - run.summary.rate;
  const familyDrops = Object.fromEntries(Object.entries(baseline.families).map(([name, rate]) => [name, rate - (run.summary.families[name]?.rate ?? rate)]));
  const loweredFamilies = Object.values(familyDrops).filter((value) => value + 1e-10 >= FAMILY_DROP_THRESHOLD).length;
  return { drop, familyDrops, loweredFamilies, signal: drop + 1e-10 >= DROP_THRESHOLD && loweredFamilies >= 2 };
}

export function assessRun(run, baseline, priorRuns = []) {
  if (run.runStatus !== 'completed' || !run.summary.complete) {
    return { code: 'incomplete', label: '运行不完整，无法判断能力变化', reason: '取消、超时、限流、认证失败、拒答、工具调用或未完成输出单列；已完成题可查看，但本轮不作能力下降判定。' };
  }
  if (run.profile === 'quick') return { code: 'quick_only', label: '快速初筛完成，尚不足以判断退化', reason: '6 道小题仅显示本轮表现。请用同配置标准检测建立参考和复测。' };
  if (!run.observed.stable) return { code: 'route_unverified', label: '实际通道不一致或证据不足', reason: '路由头、实际 effort 或 trace 不完整，或测试中发生 fallback；本轮只展示得分，不作基线下降判断。' };
  if (!baseline) return { code: 'no_baseline', label: '本轮检测完成，尚无同配置基线', reason: '先完成至少 3 轮标准检测，再明确选择这些 run ID 建立本机参考。' };
  if (baseline.assessmentVersion !== ASSESSMENT_VERSION) return { code: 'baseline_incompatible', label: '基线判定版本不一致', reason: '请用当前版本重新建立参考。' };
  if (baseline.observedKey !== run.observed.key) return { code: 'route_changed', label: '实际模型或档位已变化', reason: '当前路由身份与基线不同，不能把配置变化解释为原模型能力下降。' };
  const details = dropDetails(run, baseline);
  const prior = priorRuns.filter((r) => r.id !== run.id && r.kind === 'evaluation' && r.comparisonKey === run.comparisonKey && Date.parse(r.startedAt) >= Date.parse(baseline.createdAt))
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];
  const repeated = details.signal && prior?.runStatus === 'completed' && prior?.summary?.complete && prior.observed?.key === baseline.observedKey && dropDetails(prior, baseline).signal;
  return { code: repeated ? 'repeated_decline' : details.signal ? 'decline_signal' : 'no_decline_signal',
    label: repeated ? '连续两轮表现低于参考，请排查通道与配置' : details.signal ? '发现下降信号，建议同配置复测' : '本轮未触发预设下降阈值',
    reason: '工程判定阈值：总分下降至少 20 个百分点，且至少两个题型各下降 15 个百分点。不是经过标定的概率，也不能证明服务商降智或换模。',
    referenceMean: baseline.mean, referenceRuns: baseline.runIds.length, referenceRange: [baseline.min, baseline.max],
    previousRun: prior?.id ?? null, ...details };
}
