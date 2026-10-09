const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const labels = { quick: '快速初筛', standard: '标准检测', fingerprint: '行为指纹' };
const statuses = { pass: '通过', wrong_answer: '答案不符', invalid_format: '格式不符', completed: '采样完成', rate_limited: '限流 / 额度不足', auth_error: '认证失败', timeout: '单题超时', run_timeout: '整轮超时', cancelled: '已取消', upstream_error: '上游失败', network_error: '网络错误', truncated: '输出截断', refusal: '拒答', tool_contaminated: '出现工具调用', empty_output: '空输出', protocol_error: '协议异常', incomplete_stream: '流未完成', response_too_large: '响应超限' };
const familyNames = { candy: '组合保证', 'js-trace': '代码跟踪', constraint: '约束逻辑' };
let models = [];
let accounts = [];
let runs = [];
let job = null;
let seenJob = null;
let submitting = false;
let connectionLost = false;
let defaults = {};
let viewedRun = null;
let seenResults = '';
const selected = new Set();
const isActive = () => job && ['running', 'cancelling'].includes(job.status);
const profile = () => document.querySelector('input[name="profile"]:checked').value;

function notice(message, success = false) {
  $('notice').textContent = message;
  $('notice').classList.toggle('success', success);
  $('notice').hidden = !message;
}

async function api(path, body) {
  const response = await fetch(path, body === undefined ? { cache: 'no-store', signal: AbortSignal.timeout(15000) } : {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-sentinel-request': '1' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  const result = await response.json();
  if (!response.ok) { throw new Error(result.error || '请求失败。'); }
  return result;
}

function controls() {
  const busy = Boolean(isActive()) || submitting;
  document.querySelectorAll('#account-cards [data-account]').forEach((button) => {
    const chosen = button.dataset.account === $('account').value;
    button.disabled = busy;
    button.setAttribute('aria-pressed', String(chosen));
    button.textContent = chosen ? '已选择' : '选择此账号';
    button.closest('.account-card').classList.toggle('selected', chosen);
  });
  $('run-fields').disabled = busy;
  $('start').disabled = busy || !models.length || !$('account').value;
  $('start').innerHTML = busy ? '检测进行中…' : `开始${labels[profile()] === '快速初筛' ? '快速检测' : labels[profile()]} <span aria-hidden="true">↗</span>`;
  $('start-all').disabled = busy || !models.length || !accounts.length;
  $('start-all').textContent = `全部检测 · ${accounts.length} 个账号`;
  $('refresh-accounts').disabled = busy;
  $('cancel').hidden = !isActive();
  $('cancel').disabled = job?.status === 'cancelling';
  $('cancel').textContent = job?.status === 'cancelling' ? '正在停止并保存结果…' : job?.scope === 'all' ? '停止全部检测' : '停止本轮检测';
  $('back-progress').hidden = !isActive() || !viewedRun;
  if (job?.scope === 'all') {
    $('run-state').textContent = job.status === 'cancelling' ? '批次正在停止' : isActive() ? '批次检测中' : job.cancelled ? '批次已停止' : job.status === 'failed' ? '批次异常结束' : '批次已结束';
  }
  $('baseline').disabled = busy || selected.size < 3;
  $('selected-count').textContent = selected.size;
  $('run-hint').textContent = profile() === 'fingerprint' ? '发送 3 次采样请求，候选相似度不能证明模型身份。' : `点击后最多发送 ${profile() === 'quick' ? 6 : 18} 次独立请求，使用所选通道的额度。`;
  const perAccount = profile() === 'fingerprint' ? 3 : profile() === 'quick' ? 6 : 18;
  $('batch-hint').textContent = `${labels[profile()]}：${accounts.length} 个账号 × ${perAccount} 次，最多 ${accounts.length * perAccount} 次测试请求。逐个检测，单个账号失败后继续；结果分别保存。`;
}

function efforts(preferred = $('effort').value) {
  const available = [...new Set(models.find((model) => model.id === $('model').value)?.efforts || [])];
  const items = available.length ? available : ['default'];
  if (!items.includes('default')) { items.push('default'); }
  $('effort').replaceChildren(...items.map((value) => new Option(value === 'default' ? '通道默认' : value, value)));
  $('effort').value = items.includes(preferred) ? preferred : items.includes('high') ? 'high' : items[0];
}

function remember() {
  try { localStorage.setItem('sentinel-selection', JSON.stringify({ target: $('model').value, accountId: $('account').value, effort: $('effort').value, seed: $('seed').value, profile: profile() })); }
  catch { /* Storage is optional; the server owns the run. */ }
}

function accountName(id, fallback = '未固定账号') {
  return accounts.find((account) => account.id === id)?.name || fallback;
}

function scoreText(run) {
  if (run.summary.usable > 0) { return `${run.summary.passed}/${run.summary.usable}`; }
  const errors = Object.keys(run.summary.errors || {}).map((code) => statuses[code] || code);
  return errors.length ? `未评分 · ${errors.join('、')}` : '暂无可评分结果';
}

function accountCards() {
  $('account-count').textContent = `${accounts.length} 个`;
  $('account-cards').innerHTML = accounts.length ? accounts.map((account) => {
    const relevant = runs.filter((run) => run.config?.accountId === account.id && run.kind === 'evaluation'
      && run.config.target === $('model').value && run.config.effort === $('effort').value && run.config.seed === $('seed').value);
    const latest = relevant.find((run) => run.profile === 'standard') || relevant[0];
    const quota = account.windows.map((window) => {
      const known = window.remaining != null;
      const label = known ? `剩余 ${window.remaining}%` : '额度未知';
      return `<div class="quota ${known && window.remaining <= 10 ? 'low' : ''}"><div class="quota-labels"><span>${esc(window.name)}</span><strong>${esc(label)}</strong></div>${known ? `<meter min="0" max="100" value="${esc(window.remaining)}" aria-label="${esc(`${window.name}：${label}`)}">${esc(label)}</meter>` : '<div class="quota-unknown" aria-hidden="true"></div>'}${window.remaining === 0 && window.resetsAt ? `<p class="quota-reset">${esc(date(window.resetsAt))} 重置</p>` : ''}</div>`;
    }).join('');
    const unavailable = account.windows.some((window) => window.remaining === 0);
    const decline = ['decline_signal', 'repeated_decline'].includes(latest?.verdict?.code);
    const result = latest ? `${labels[latest.profile]} ${date(latest.startedAt)} · ${scoreText(latest)} · ${latest.verdict.label}` : '尚无当前配置的账号检测';
    return `<article class="account-card ${decline ? 'decline' : ''}" aria-label="${esc(account.name)}"><div class="account-head"><span class="account-avatar" aria-hidden="true">C</span><strong>${esc(account.name)}</strong><span class="badge">${esc(account.plan || 'Codex')}</span></div>${quota ? `<div class="quota-windows">${quota}</div>` : ''}<p class="account-result ${latest ? '' : 'no-result'}">${esc(result)}</p>${unavailable || account.error || !quota ? `<p class="hint">${unavailable ? '额度不足，暂不能检测。' : ''}${esc(account.error || (!quota ? '额度暂未知' : ''))}</p>` : ''}<small>额度读取：${esc(date(account.readAt))}</small><div class="account-actions"><button type="button" class="text-button" data-account="${esc(account.id)}">选择此账号</button>${latest ? `<button type="button" class="text-button" data-view="${esc(latest.id)}">查看报告</button>` : ''}</div></article>`;
  }).join('') : '<p>Magpie 未返回 Codex 账号。请先在 Magpie 的 Codex provider 登录账号，然后刷新。</p>';
  controls();
}

async function loadAccounts() {
  try {
    const data = await api('/api/accounts');
    accounts = [...new Map(data.accounts.map((account) => [account.id, account])).values()];
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('sentinel-selection')) || {}; } catch { /* Use defaults. */ }
    const preferred = isActive() ? job.accountId : $('account').value || saved.accountId || defaults.accountId;
    $('account').replaceChildren(...accounts.map((account) => new Option(`${account.name} · ${account.plan}`, account.id)));
    $('account').value = accounts.some((account) => account.id === preferred) ? preferred : accounts.find((account) => !account.windows.some((window) => window.remaining === 0))?.id || accounts[0]?.id || '';
    if (!accounts.length) { $('account').add(new Option('暂无 Codex 账号', '')); }
    renderHistory();
    accountCards();
  } catch (error) {
    accounts = [];
    $('account-count').textContent = '读取失败';
    $('account').replaceChildren(new Option('账号读取失败，请刷新', ''));
    $('account-cards').innerHTML = `<p>${esc(error.message)}</p>`;
    notice(error.message);
  }
  controls();
}

async function loadModels() {
  $('connection-label').textContent = '正在连接 Magpie';
  try {
    const data = await api('/api/models');
    models = data.models;
    let remembered = {};
    try { remembered = JSON.parse(localStorage.getItem('sentinel-selection')) || {}; } catch { /* Use defaults. */ }
    const target = isActive() ? job.target : $('model').value || remembered.target || defaults.target;
    $('model').replaceChildren(...models.map((model) => new Option(model.id, model.id)));
    $('model').value = models.some((model) => model.id === target) ? target : models.find((model) => model.id.startsWith('codex/'))?.id || models[0]?.id || '';
    if (!models.length) { $('model').add(new Option('Magpie 尚未提供模型', '')); }
    efforts(isActive() ? job.effort : remembered.effort || defaults.effort || 'high');
    $('connection-label').textContent = models.length ? `Magpie 已连接 · ${models.length} 个模型` : '已连接 · 暂无模型';
    $('connection-dot').classList.add('connected');
  } catch (error) {
    models = [];
    $('model').replaceChildren(new Option('连接后显示可用模型', ''));
    $('connection-label').textContent = 'Magpie 未连接';
    $('connection-dot').classList.remove('connected');
    notice(`${error.message} 请确认 Magpie 已启动，或检查启动时的网关配置，然后点击“刷新模型”。`);
  }
  controls();
}

function showProgress() {
  $('empty-result').hidden = true;
  $('progress').hidden = false;
  $('report').hidden = true;
  $('run-state').textContent = job.status === 'cancelling' ? '正在停止' : '检测中';
  $('progress-title').textContent = `${job.accountName} · ${labels[job.profile]} · ${job.target}`;
  const total = job.profile === 'quick' ? 6 : job.profile === 'standard' ? 18 : 3;
  const counts = job.messages.map((line) => /^(\d+)\/(\d+) /.exec(line)).filter(Boolean);
  const completed = Number(counts.at(-1)?.[1] || 0);
  $('progress-count').textContent = `${completed} / ${total}`;
  $('progress-bar').max = total;
  $('progress-bar').value = completed;
  $('progress-log').replaceChildren(...job.messages.map((message) => {
    const row = document.createElement('li'); row.textContent = message; return row;
  }));
}

function renderBatch() {
  $('batch-results').hidden = job?.scope !== 'all';
  if (job?.scope !== 'all') { return; }
  const done = job.accounts.filter((item) => !['queued', 'running', 'skipped'].includes(item.status)).length;
  const state = job.status === 'cancelling' ? '正在停止' : isActive() ? '进行中' : job.cancelled ? '已停止' : job.status === 'failed' ? '异常结束' : '已结束';
  $('batch-title').textContent = `全部账号${labels[job.profile]} · ${state}`;
  const completed = job.accounts.filter((item) => item.status === 'completed').length;
  const skipped = job.accounts.filter((item) => item.status === 'skipped').length;
  $('batch-status').textContent = `已处理 ${done} / ${job.accounts.length} 个账号，完成检测 ${completed} 个${skipped ? `，未开始 ${skipped} 个` : ''}。${job.error || '各账号独立判定，完成检测不代表已证明能力正常。'}`;
  const names = { queued: '等待检测', running: '正在检测', completed: '已完成', incomplete: '未完整完成', cancelled: '已取消', failed: '启动失败', skipped: '未开始' };
  $('batch-body').innerHTML = job.accounts.map((item) => {
    const result = item.error || (item.summary ? job.profile === 'fingerprint'
      ? `${item.fingerprint?.acceptedSamples || 0}/3 有效样本`
      : `${scoreText(item)} · ${item.verdict.label}` : '');
    return `<tr><td>${esc(item.accountName)}</td><td>${esc(names[item.status] || item.status)}<small>${esc(result)}</small>${item.persisted === false ? '<small class="unsaved">保存失败，请导出报告</small>' : ''}</td><td>${item.reportId ? `<button type="button" class="text-button" data-view="${esc(item.reportId)}">查看</button>` : '—'}</td></tr>`;
  }).join('');
}

function date(value) {
  return value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '—';
}

function renderReport(report) {
  $('empty-result').hidden = true;
  $('progress').hidden = true;
  $('report').hidden = false;
  $('run-state').textContent = ({ completed: '已完成', incomplete: '未完整完成', cancelled: '已取消', running: '中间记录' })[report.runStatus] || report.runStatus;
  const evaluation = report.kind === 'evaluation';
  const summary = report.summary;
  const title = evaluation ? report.verdict.label : report.fingerprint?.status === 'reported' ? '行为指纹采样完成' : '行为指纹有效样本不足';
  const reason = evaluation ? report.verdict.reason : '候选只表示数字输出与参考库的相似程度，不代表模型身份证明或降智概率。';
  const stats = evaluation ? [[summary.usable ? `${summary.passed} / ${summary.usable}` : '—', '严格通过 / 可评分'], [String(summary.unscored), '未评分'], [`${(summary.elapsedMs / 1000).toFixed(1)}s`, '逐题耗时合计']]
    : [[`${report.fingerprint?.acceptedSamples || 0} / 3`, '有效样本'], [String(summary.attempted), '已发出请求'], [report.fingerprint?.score == null ? '—' : `${(report.fingerprint.score * 100).toFixed(1)}%`, '首位候选闭集权重']];
  const families = evaluation ? Object.entries(summary.families).map(([name, value]) => [familyNames[name] || name, `${value.passed} / ${value.total}`]) : (report.fingerprint?.candidates || []).slice(0, 3).map((item) => [item.model, `${(item.weight * 100).toFixed(1)}%`]);
  const details = report.cases.map((item) => `<details class="case ${esc(item.status)}"><summary><span>${esc(item.id)}</span><span class="case-status">${esc(statuses[item.status] || item.status)} · ${((item.elapsedMs || 0) / 1000).toFixed(1)}s</span></summary><p>独立测试题</p><pre>${esc(item.prompt)}</pre>${item.expected === undefined ? '' : `<p>期望答案</p><pre>${esc(JSON.stringify(item.expected))}</pre>`}<p>模型最终回答</p><pre>${esc(item.text || item.error || '无最终回答')}</pre></details>`).join('');
  $('report').innerHTML = `<div class="report-meta">${esc(report.config.target)} · ${esc(report.config.effort)} · ${esc(date(report.startedAt))}</div><h3 class="report-title">${esc(title)}</h3><p class="report-reason">${esc(reason)}</p>${report.persisted === false ? '<p class="unsaved">最终结果未能保存。请立即导出本轮报告，开始下一轮或关闭服务后将无法恢复这份完整结果。</p>' : ''}<div class="score-row">${stats.map(([value, label]) => `<div><strong>${esc(value)}</strong><small>${esc(label)}</small></div>`).join('')}</div><div class="families">${families.map(([name, value]) => `<div class="family">${esc(name)}<strong>${esc(value)}</strong></div>`).join('')}</div><div class="report-actions">${['html', 'json', 'md'].map((format) => `<a href="/api/runs/${encodeURIComponent(report.id)}/export?format=${format}" download>导出 ${format.toUpperCase()}</a>`).join('')}</div>${details}<details class="report-warnings"><summary>路由证据与检测说明</summary><p>通道证据${report.observed?.stable ? '一致' : '不完整或不一致'}；缺少 trace ${report.observed?.traceMissing || 0} 题，fallback ${report.observed?.fallbackCount || 0} 题。</p><ul>${(report.observed?.distinct || []).map((row) => `<li>${esc(row.model)} · ${esc(row.gatewayEffort)} · 上游自报 ${esc(row.vendorModel)}</li>`).join('')}${(report.warnings || []).map((warning) => `<li>${esc(warning)}</li>`).join('')}</ul><p>Run ID：${esc(report.id)}</p></details>`;
}

async function showRun(id) {
  try {
    const report = await api(`/api/runs/${encodeURIComponent(id)}`);
    viewedRun = isActive() && job.scope !== 'all' ? null : id;
    renderReport(report);
    $('report').querySelector('.report-meta').prepend(`${accountName(report.config?.accountId, report.config?.accountHint)} · `);
    controls();
  }
  catch (error) { notice(error.message); }
}

function renderHistory() {
  const visible = runs.filter((run) => run.kind === 'unreadable' || run.config?.accountId === $('account').value);
  for (const id of selected) { if (!visible.some((run) => run.id === id)) { selected.delete(id); } }
  if (!visible.length) { $('history-body').innerHTML = '<tr><td colspan="6" class="empty-history">这个账号还没有检测记录。之前未固定账号的检测不能归到此账号。</td></tr>'; controls(); return; }
  $('history-body').innerHTML = visible.map((run) => {
    const eligible = run.kind === 'evaluation' && run.profile === 'standard' && run.runStatus === 'completed' && run.summary.complete && run.observed?.stable;
    const result = run.kind === 'unreadable' ? run.error : run.kind === 'evaluation' ? `${scoreText(run)} · ${run.verdict.label}` : `${run.fingerprint?.acceptedSamples || 0}/3 有效样本`;
    return `<tr><td><input type="checkbox" data-select="${esc(run.id)}" aria-label="选择 ${esc(run.id)} 作为基线" ${eligible ? '' : 'disabled'} ${selected.has(run.id) ? 'checked' : ''}></td><td>${esc(date(run.startedAt))}</td><td>${esc(run.config?.target || '—')}<small>${esc(run.config?.effort || '')}</small></td><td>${esc(labels[run.profile] || '记录异常')}</td><td>${esc(result)}</td><td>${run.kind === 'unreadable' ? '—' : `<button class="text-button" data-view="${esc(run.id)}">查看</button>`}</td></tr>`;
  }).join('');
  controls();
}

async function history() {
  const data = await api('/api/history');
  runs = data.runs;
  renderHistory();
  accountCards();
}

async function syncState() {
  const state = await api('/api/state');
  if (connectionLost) { connectionLost = false; notice(''); }
  job = state.job;
  renderBatch();
  if (isActive()) {
    if (seenJob !== job.id) {
      seenJob = job.id;
      viewedRun = null;
      document.querySelector(`input[name="profile"][value="${job.profile}"]`).checked = true;
      $('model').value = job.target;
      $('account').value = job.accountId;
      efforts(job.effort);
      $('seed').value = job.seed;
    }
    if (!viewedRun) { showProgress(); }
    if (job.scope === 'all') {
      const results = `${job.id}:${job.accounts.filter((item) => item.reportId).length}`;
      if (seenResults !== results) { seenResults = results; await history(); }
    }
  } else if (job && seenJob !== `${job.id}:finished`) {
    if (seenJob !== job.id) { viewedRun = null; }
    seenJob = `${job.id}:finished`;
    if (job.reportId) { await showRun(viewedRun || job.reportId); }
    else {
      $('progress').hidden = true;
      $('empty-result').hidden = job.scope === 'all';
      $('run-state').textContent = job.cancelled ? '已停止' : '启动失败';
      if (!job.cancelled) { notice(job.error || '检测未完成。'); }
    }
    await history();
  }
  controls();
  return state;
}

$('run-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (isActive() || submitting) { return; }
  submitting = true;
  notice('');
  controls();
  remember();
  try {
    const accountChoice = event.submitter?.id === 'start-all' ? { accountIds: accounts.map((account) => account.id) } : { accountId: $('account').value };
    const result = await api('/api/runs', { ...accountChoice, target: $('model').value, effort: $('effort').value, profile: profile(), seed: $('seed').value });
    job = result.job;
    seenJob = job.id;
    viewedRun = null;
    renderBatch();
    if (isActive()) { showProgress(); }
    else { await syncState(); }
  } catch (error) { notice(error.message); }
  finally { submitting = false; controls(); }
});
$('batch-body').addEventListener('click', (event) => {
  if (event.target.dataset.view) { showRun(event.target.dataset.view); }
});
$('back-progress').addEventListener('click', () => { viewedRun = null; showProgress(); controls(); });
$('cancel').addEventListener('click', async () => {
  try { const result = await api('/api/cancel', { id: job.id }); job = result.job; renderBatch(); controls(); }
  catch (error) { notice(error.message); }
});
$('refresh-models').addEventListener('click', () => { notice(''); loadModels(); });
$('refresh-accounts').addEventListener('click', () => { notice(''); loadAccounts(); });
$('model').addEventListener('change', () => { efforts(); remember(); accountCards(); });
$('effort').addEventListener('change', () => { remember(); accountCards(); });
$('seed').addEventListener('change', () => { remember(); accountCards(); });
$('account').addEventListener('change', () => { selected.clear(); remember(); renderHistory(); });
$('account-cards').addEventListener('click', (event) => {
  if (event.target.dataset.view) { showRun(event.target.dataset.view); }
  if (event.target.dataset.account && !isActive() && !submitting) {
    $('account').value = event.target.dataset.account;
    selected.clear(); remember(); renderHistory();
  }
});
document.querySelectorAll('input[name="profile"]').forEach((input) => input.addEventListener('change', () => { controls(); remember(); }));
$('history-body').addEventListener('change', (event) => {
  const id = event.target.dataset.select;
  if (!id) { return; }
  if (event.target.checked) { selected.add(id); } else { selected.delete(id); }
  controls();
});
$('history-body').addEventListener('click', (event) => {
  const id = event.target.dataset.view;
  if (id) { showRun(id); }
});
$('baseline').addEventListener('click', async () => {
  try {
    const result = await api('/api/baseline', { runIds: [...selected] });
    selected.clear();
    notice(result.message, true);
    await history();
  } catch (error) { notice(error.message); }
});

function initAppearance() {
  let theme = 'system';
  try { theme = localStorage.getItem('sentinel-theme') || theme; } catch { /* Use the system theme. */ }
  const apply = (value) => {
    const valid = ['system', 'light', 'dark'].includes(value) ? value : 'system';
    $('theme').value = valid;
    if (valid === 'system') { delete document.documentElement.dataset.theme; }
    else { document.documentElement.dataset.theme = valid; }
  };
  apply(theme);
  $('theme').addEventListener('change', () => {
    apply($('theme').value);
    try { localStorage.setItem('sentinel-theme', $('theme').value); } catch { /* Theme remains usable without storage. */ }
  });
  const navigation = () => {
    const links = [...document.querySelectorAll('.seg a')];
    const current = links.some((link) => link.hash === location.hash) ? location.hash : '#workspace';
    links.forEach((link) => {
      if (link.hash === current) { link.setAttribute('aria-current', 'location'); }
      else { link.removeAttribute('aria-current'); }
    });
  };
  navigation();
  window.addEventListener('hashchange', navigation);
}

async function init() {
  try {
    const state = await syncState();
    defaults = state.defaults;
    $('version').textContent = `v${state.version}`;
    $('gateway-address').textContent = state.gateway.replace(/^http:\/\//, '');
    if (!isActive()) {
      let saved = {};
      try { saved = JSON.parse(localStorage.getItem('sentinel-selection')) || {}; } catch { /* Use defaults. */ }
      $('seed').value = saved.seed || defaults.seed;
      if (Object.hasOwn(labels, saved.profile)) { document.querySelector(`input[name="profile"][value="${saved.profile}"]`).checked = true; }
    }
    await loadModels();
    await loadAccounts();
    await history();
  } catch (error) { notice(`本地服务暂不可用：${error.message}`); }
  async function poll() {
    try { await syncState(); }
    catch { connectionLost = true; notice('本地服务连接中断。请确认 Magpie 插件仍启用，恢复后刷新页面。'); }
    setTimeout(poll, 1500);
  }
  setTimeout(poll, 1500);
}
initAppearance();
init();
