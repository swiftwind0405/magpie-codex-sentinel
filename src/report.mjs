import { DROP_THRESHOLD, FAMILY_DROP_THRESHOLD } from './assessment.mjs';

const familyNames = { candy: '组合保证', 'js-trace': 'JS 代码跟踪', constraint: '约束逻辑', fingerprint: '数字指纹' };
const statuses = { pass: '通过', wrong_answer: '答案不符', invalid_format: '格式不符', completed: '采样完成', timeout: '超时', rate_limited: '限流/额度', auth_error: '认证/权限', cancelled: '已取消', run_timeout: '整轮超时', refusal: '拒答', tool_contaminated: '出现工具调用', empty_output: '空输出', incomplete_stream: '流未完成', truncated: '输出截断', network_error: '网络错误', http_error: 'HTTP 错误', protocol_error: '协议错误', upstream_error: '上游失败', response_too_large: '响应超限' };
export const percentage = (value) => typeof value === 'number' && Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '未知';
const md = (value) => String(value ?? '未知').replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|').replace(/`/g, '\\`');
const brief = (value, length = 160) => { const s = typeof value === 'string' ? value : JSON.stringify(value); return s === undefined ? '—' : s.length > length ? `${s.slice(0, length)}…` : s; };
const token = (value, reported, total) => value === null || value === undefined ? '未返回' : `${value.toLocaleString('en-US')}${reported < total ? `（${reported}/${total} 个请求有数据）` : ''}`;

export function formatHistory(rows = []) {
  if (!rows.length) return '暂无检测历史。选择 quick 或 standard 模型并发送 `sentinel check`，或用 CLI 运行检测。';
  const lines = ['## 检测历史', '', '| Run ID | 时间（UTC） | 检测 | 目标 | 结果 |', '|---|---|---|---|---|'];
  for (const r of rows) lines.push(`| ${md(r.id)} | ${md(r.startedAt || '—')} | ${md(r.profile || r.kind)} | ${md(r.config?.target || '—')} | ${md(r.kind === 'evaluation' ? `${r.summary.passed}/${r.summary.usable} · ${r.verdict.label}` : r.kind === 'fingerprint' ? `${r.fingerprint?.status} · ${r.fingerprint?.prediction || '未得出候选'}` : r.error)} |`);
  lines.push('', '建立能力参考：在 history 模型发送 `sentinel baseline ID1 ID2 ID3`。只接受至少三轮同配置、同实际通道且完整完成的 standard 检测。历史结果不会因新基线重新改写。');
  return lines.join('\n');
}

export function formatReport(r) {
  const lines = [`# Codex Sentinel · ${r.kind === 'fingerprint' ? '辅助指纹' : '能力检查'}`, '', `**${md(r.kind === 'evaluation' ? r.verdict?.label : r.fingerprint?.status === 'reported' ? '指纹采样完成，仅供辅助观察' : '指纹有效样本不足或运行异常')}**`, '',
    `- Run ID：\`${md(r.id)}\``, `- 时间：${md(r.startedAt)}（UTC）`,
    `- 请求目标：\`${md(r.config?.target)}\`；请求档位：\`${md(r.config?.effort)}\``,
    `- 范围：${r.config?.accountPinned ? md(r.config.accountHint) : '该 Magpie 路由，未固定账户'}`, `- 题目种子：\`${md(r.config?.seed)}\`；题库版本：\`${md(r.suiteVersion)}\``, ''];
  if (r.kind === 'evaluation') {
    const s = r.summary;
    lines.push(`本轮严格通过 **${s.passed}/${s.usable}（${percentage(s.rate)}）**；计划 ${s.planned} 题，已请求 ${s.attempted} 题，未评分 ${s.unscored} 题。`,
      `格式遵从率 ${percentage(s.formatRate)}。格式不符 ${s.formatErrors} 题计入“未通过”，但与答案算错分别列出。`, '',
      '| 题型 | 通过 / 可评分 | 通过率 | 格式不符 |', '|---|---:|---:|---:|');
    for (const [name, f] of Object.entries(s.families)) lines.push(`| ${familyNames[name] || md(name)} | ${f.passed}/${f.total} | ${percentage(f.rate)} | ${f.formatErrors} |`);
    if (typeof r.verdict?.referenceMean === 'number') {
      lines.push('', `参考均值 **${percentage(r.verdict.referenceMean)}**（${r.verdict.referenceRuns} 轮）。本轮变化 **${r.verdict.drop > 0 ? '-' : '+'}${(Math.abs(r.verdict.drop) * 100).toFixed(1)} 个百分点**。`);
    }
    lines.push('', md(r.verdict?.reason || ''), '', '## 逐题结果', '', '| 题目 | 结果 | 期望答案 | 实际最终答案 |', '|---|---|---|---|');
    for (const c of r.cases) lines.push(`| ${md(c.id)} | ${statuses[c.status] || md(c.status)} | ${md(brief(c.expected))} | ${md(brief(c.grade?.answer ?? c.error ?? c.text))} |`);
    lines.push('', '## 用量与耗时', '',
      `- 输入 tokens：${token(s.tokens.input, s.tokens.inputReported, s.attempted)}`, `- 输出 tokens：${token(s.tokens.output, s.tokens.outputReported, s.attempted)}`,
      `- reasoning tokens：${token(s.tokens.reasoning, s.tokens.reasoningReported, s.attempted)}`,
      `- 逐题端到端耗时合计：${(s.elapsedMs / 1000).toFixed(1)} 秒（包含网络与推理等待；不是纯解码速度）`);
  } else {
    const f = r.fingerprint;
    lines.push(`有效样本 **${f?.acceptedSamples ?? 0}/${r.summary?.planned ?? 3}**。${f?.prediction ? `当前参考库首位候选：**${md(f.prediction)}**，闭集权重 ${percentage(f.score)}。` : '没有可报告的候选。'}`,
      '', '**候选权重不是降智概率，也不能证明服务商实际运行了哪个模型。**', '', '| 参考库候选 | 闭集权重 |', '|---|---:|');
    for (const c of (f?.candidates || []).slice(0, 5)) lines.push(`| ${md(c.model)} | ${percentage(c.weight)} |`);
    lines.push('', `参考库：ModelTrace，${f?.source?.modelCount ?? '?'} 个标签，commit \`${md(f?.source?.commit)}\`。未在 Magpie 当前路径校准。`);
    if (f?.error) lines.push('', `评分异常：${md(f.error.message)}`);
    for (const limitation of f?.limitations || []) lines.push(`- ${md(limitation)}`);
  }
  lines.push('', '## 实际路由证据', '');
  for (const d of r.observed?.distinct || []) lines.push(`- Magpie member：\`${md(d.model)}\`；网关记录档位：\`${md(d.gatewayEffort)}\`；上游自报 model：\`${md(d.vendorModel)}\``);
  lines.push(`- 通道证据${r.observed?.stable ? '一致' : '不完整或不一致'}；缺少 trace ${r.observed?.traceMissing ?? 0} 题，fallback ${r.observed?.fallbackCount ?? 0} 题。`,
    '- 这些是网关选择及上游自报信息，不能独立认证模型权重或内部推理预算。', '', '## 说明', '',
    '- 仅向模型发送独立测试题，不带入正在工作的项目对话；不检测长上下文、仓库级任务或工具使用能力。',
    '- 输出 token 上限为请求参数，可能被通道移除；请求次数和超时由检测器控制。停止连接不保证上游立即停止计费。');
  for (const warning of r.warnings || []) lines.push(`- ${md(warning)}`);
  lines.push('', r.persisted === false ? '本轮最终记录未成功保存，请保留当前输出。' : '完整题干、最终回答、用量和路由证据保存在本机的本轮 JSON 中。用 CLI 的 show / export 命令查看或导出。');
  return lines.join('\n');
}

const esc = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Self-contained report: no remote assets, scripts, account names, or auth keys. */
export function renderHtml(r) {
  const evaluation = r.kind === 'evaluation';
  const title = evaluation ? r.verdict?.label : 'ModelTrace 辅助指纹';
  const score = evaluation ? percentage(r.summary?.rate) : percentage(r.fingerprint?.score);
  const detailRows = (r.cases || []).map((c) => `<details data-status="${esc(c.status)}"><summary><span>${esc(c.id)}</span><strong>${esc(statuses[c.status] || c.status)}</strong><span>${((c.elapsedMs || 0) / 1000).toFixed(1)} s</span></summary><h4>独立测试题</h4><pre>${esc(c.prompt)}</pre>${c.expected !== undefined ? `<h4>期望答案</h4><pre>${esc(JSON.stringify(c.expected))}</pre>` : ''}<h4>模型最终回答</h4><pre>${esc(c.text || c.error || '无最终回答')}</pre>${c.grade?.reason ? `<p>${esc(c.grade.reason)}</p>` : ''}</details>`).join('');
  const familyCards = evaluation ? Object.entries(r.summary?.families || {}).map(([name, f]) => `<div class="metric"><span>${esc(familyNames[name] || name)}</span><strong>${f.passed} / ${f.total}</strong><small>${percentage(f.rate)} · 格式不符 ${f.formatErrors}</small></div>`).join('') : (r.fingerprint?.candidates || []).slice(0, 3).map((c) => `<div class="metric"><span>${esc(c.model)}</span><strong>${percentage(c.weight)}</strong><small>参考库内候选权重</small></div>`).join('');
  const rawSummary = formatReport(r);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Codex Sentinel · ${esc(r.id)}</title><style>
  :root{font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;color:#17202b;background:#f4f6f8;font-synthesis:none}*{box-sizing:border-box}body{margin:0}main{max-width:1100px;margin:auto;padding:36px 26px 80px}header{display:flex;justify-content:space-between;gap:20px;align-items:center;border-bottom:1px solid #dbe1e7;padding-bottom:20px}.brand{font-weight:800;font-size:20px;letter-spacing:-.4px}.tag{font-size:12px;color:#4b637d;letter-spacing:1.3px}h1{font-size:29px;line-height:1.45;margin:24px 0 12px}h2{font-size:19px;margin-top:32px}p{line-height:1.8}.hero{display:grid;grid-template-columns:1fr 180px;gap:24px;align-items:center}.score{font-size:45px;font-weight:760;text-align:right;color:#17676c}.caption{font-size:12px;color:#61717e;display:block;line-height:1.7}.meta{display:flex;gap:10px;flex-wrap:wrap;margin:18px 0}.meta span{background:#e7edf1;border-radius:6px;padding:7px 10px;font-size:13px}.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin:25px 0}.metric{background:white;border:1px solid #dbe1e7;border-radius:10px;padding:20px}.metric span,.metric small{display:block;color:#61717e;font-size:13px}.metric strong{display:block;font-size:25px;margin:10px 0}.notice{background:#e9f1f2;border-left:3px solid #17676c;border-radius:4px;padding:14px 18px;font-size:14px;line-height:1.8}.warning{background:#fff3de;border-left-color:#9d650f}details{background:white;border:1px solid #dbe1e7;border-radius:8px;margin:10px 0;padding:0 17px}summary{padding:16px 0;cursor:pointer;display:flex;gap:18px;align-items:center}summary span:first-child{flex:1;font-family:monospace}summary span:last-child{font-size:12px;color:#61717e}summary strong{font-size:13px}pre{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.65;background:#f6f8fa;padding:16px;border-radius:6px;font-size:13px}button{cursor:pointer;border:1px solid #c5cfd7;border-radius:6px;background:white;color:#24435c;padding:8px 12px;margin-right:7px}h4{font-size:13px;color:#61717e}.raw{font-family:inherit;font-size:13px}.foot{font-size:12px;color:#71818c;margin-top:30px}@media(max-width:650px){main{padding:24px 16px}.hero{grid-template-columns:1fr}.score{text-align:left}.metrics{grid-template-columns:1fr}h1{font-size:24px}header{align-items:flex-start;flex-direction:column}}@media print{body{background:white}button{display:none}main{padding:0}details{break-inside:avoid}.raw{font-size:10px}}
  </style></head><body><main><header><div class="brand">Codex Sentinel</div><span class="tag">可复现的能力检查 · 可核查的结果</span></header><section class="hero"><div><h1>${esc(title)}</h1><p>${esc(evaluation ? r.verdict?.reason : '数字输出更接近参考库中的哪些标签；不代表降智概率或真实模型身份。')}</p></div><div class="score">${esc(score)}<span class="caption">${evaluation ? '本轮严格通过率' : '首位候选闭集权重'}</span></div></section><div class="meta"><span>${esc(r.config?.target)}</span><span>请求档位 ${esc(r.config?.effort)}</span><span>${esc(r.profile)}</span><span>${esc(r.startedAt)}</span></div><div class="metrics">${familyCards}</div><div class="notice">${evaluation ? `已请求 ${r.summary.attempted} / ${r.summary.planned} 题；${r.summary.unscored} 题未评分。格式不符和答案不符分别列出。` : `有效指纹样本 ${r.fingerprint?.acceptedSamples ?? 0} / 3。当前调用路径未独立校准。`} ${r.config?.accountPinned ? '按配置固定账户。' : '未固定账户，结果代表该 Magpie 路由。'}</div>${r.transport?.outputLimitEnforced === false ? '<p class="notice warning">Magpie 的 Codex 订阅适配器会改写请求并删除 max_output_tokens。输出 token 设置不是硬费用上限。</p>' : ''}<h2>逐题证据</h2><button id="failures">展开未通过项</button><button id="collapse">全部收起</button>${detailRows}<h2>完整报告</h2><pre class="raw">${esc(rawSummary)}</pre><p class="foot">Run ${esc(r.id)} · 本文件不加载远程资源。阈值：${DROP_THRESHOLD * 100} 个百分点总变化与至少两个题型各 ${FAMILY_DROP_THRESHOLD * 100} 个百分点变化；属于工程规则，不是统计显著性检验。</p></main><script>document.getElementById('failures').onclick=()=>document.querySelectorAll('details').forEach(e=>e.open=!['pass','completed'].includes(e.dataset.status));document.getElementById('collapse').onclick=()=>document.querySelectorAll('details').forEach(e=>e.open=false);</script></body></html>`;
}
