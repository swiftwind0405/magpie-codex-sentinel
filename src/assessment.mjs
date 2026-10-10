import { hash } from './config.mjs';

export const ASSESSMENT_VERSION = 'reference-drop-v1';
export const DROP_THRESHOLD = 0.20;
export const FAMILY_DROP_THRESHOLD = 0.15;
export const AUTO_BASELINE_RUNS = 3;
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

export function baselineCandidates(runs) {
  const groups = new Map();
  for (const run of [...runs].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt) || a.id.localeCompare(b.id))) {
    if (run.kind !== 'evaluation' || run.profile !== 'standard' || run.runStatus !== 'completed'
      || !run.summary?.complete || !run.observed?.stable || run.persisted === false) { continue; }
    const key = JSON.stringify([run.comparisonKey, run.observed.key, run.suiteVersion, run.cases.map((c) => c.id)]);
    const group = groups.get(key) || [];
    if (!group.some((r) => r.id === run.id)) { group.push(run); }
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function baselineCollectionVerdict(run, baseline, runs) {
  if (baseline) {
    if (baseline.assessmentVersion !== ASSESSMENT_VERSION) {
      return { code: 'baseline_incompatible', label: '历史参考版本不一致', reason: '已保留原参考，请检查版本并通过维护命令明确重建。' };
    }
    const member = baseline.runIds.includes(run.id);
    return { code: member ? 'baseline_established' : 'reference_ready',
      label: member ? '历史参考已固定，本轮为参考样本' : '历史参考已就绪，本轮保留原始得分',
      reason: `已固定 ${baseline.runIds.length} 轮标准检测的参考，平均通过率 ${(baseline.mean * 100).toFixed(1)}%。${member ? '参考样本不与自身比较' : '这份历史报告不追溯判定下降'}；后续相同配置的标准检测将自动比较。` };
  }
  const groups = baselineCandidates(runs).filter((group) => group[0].comparisonKey === run.comparisonKey);
  const matching = groups.find((group) => group[0].observed.key === run.observed.key
    && group[0].suiteVersion === run.suiteVersion
    && JSON.stringify(group[0].cases.map((c) => c.id)) === JSON.stringify(run.cases.map((c) => c.id)));
  const collected = Math.min(matching?.length || 0, AUTO_BASELINE_RUNS);
  return { code: 'no_baseline', label: `正在建立历史参考 · ${collected}/${AUTO_BASELINE_RUNS} 轮`,
    reason: collected < AUTO_BASELINE_RUNS
      ? `已收集 ${collected}/${AUTO_BASELINE_RUNS} 轮同配置、同实际通道的完整标准检测，再完成 ${AUTO_BASELINE_RUNS - collected} 轮后自动固定参考，无需手动选择。`
      : '合格记录已足够，等待自动保存参考。若持续显示此状态，请检查服务日志和数据目录写入权限。' };
}

export function incompleteVerdict(run) {
  const s = run.summary;
  const errors = s.errors || {};
  const names = { empty_output: '未取得最终答案', timeout: '单题超时', run_timeout: '整轮超时', rate_limited: '限流 / 额度不足',
    auth_error: '认证 / 权限失败', refusal: '拒答', tool_contaminated: '出现工具调用', truncated: '输出截断',
    incomplete_stream: '响应流未完成', protocol_error: '响应格式异常', upstream_error: '上游失败',
    network_error: '网络错误', response_too_large: '响应超限', cancelled: '已取消', http_error: 'HTTP 错误' };
  const http = [...new Set((run.cases || []).filter((c) => c.status === 'http_error').map((c) => c.httpStatus).filter(Number.isInteger))];
  if (http.length) { names.http_error = `HTTP ${http.join(' / ')}`; }
  const causes = Object.entries(errors).map(([code, count]) => `${count} 题${names[code] || code}`);
  const failed = Object.values(errors).reduce((sum, count) => sum + count, 0);
  const unattempted = Math.max(0, s.planned - s.attempted);
  const accountUnavailable = run.cases?.some((c) => c.diagnostic?.cause === 'account_unavailable');
  let label = run.runStatus === 'cancelled' ? '检测已取消'
    : accountUnavailable ? '请求失败：指定账号无法服务所选模型'
      : !s.usable && http.length ? `请求失败：HTTP ${http.join(' / ')}`
        : run.runStatus === 'completed' && errors.empty_output === failed ? `检测结束，${failed} 题未取得最终答案`
          : `检测${run.runStatus === 'completed' ? '结束，评分不完整' : '提前结束'}${causes.length ? `：${causes.join('；')}` : ''}`;
  if (run.runStatus === 'running') { label = '检测尚未完成，仅有中间记录'; }
  return { code: 'incomplete', label,
    reason: `已执行 ${s.attempted}/${s.planned} 题，可评分 ${s.usable} 题，其中 ${s.passed} 题通过。${causes.length ? `${causes.join('；')}。` : ''}${unattempted ? `${unattempted} 题未执行。` : ''}本轮结果不足以比较能力变化；未评分项不计作答错。${run.stop?.reason || (accountUnavailable ? '请检查账号与模型的对应关系。' : '可展开异常题目查看诊断。')}` };
}

export function assessRun(run, baseline, priorRuns = []) {
  if (run.runStatus !== 'completed' || !run.summary.complete) {
    return incompleteVerdict(run);
  }
  if (run.profile === 'quick') return { code: 'quick_only', label: '快速初筛完成，尚不足以判断退化', reason: '6 道小题仅显示本轮表现。请用同配置标准检测建立参考和复测。' };
  if (!run.observed.stable) return { code: 'route_unverified', label: '实际通道不一致或证据不足', reason: '路由头、实际 effort 或 trace 不完整，或测试中发生 fallback；本轮只展示得分，不作基线下降判断。' };
  if (!baseline) { return baselineCollectionVerdict(run, null, [...priorRuns.filter((r) => r.id !== run.id), run]); }
  if (baseline.assessmentVersion !== ASSESSMENT_VERSION) return { code: 'baseline_incompatible', label: '基线判定版本不一致', reason: '请用当前版本重新建立参考。' };
  if (baseline.observedKey !== run.observed.key) return { code: 'route_changed', label: '实际模型或档位已变化', reason: '当前路由身份与基线不同，不能把配置变化解释为原模型能力下降。' };
  if (baseline.runIds.includes(run.id)) { return baselineCollectionVerdict(run, baseline, priorRuns); }
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
