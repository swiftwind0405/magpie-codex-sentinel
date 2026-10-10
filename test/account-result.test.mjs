import assert from 'node:assert/strict';
import test from 'node:test';
import { ASSESSMENT_VERSION, assessRun, summarize } from '../src/assessment.mjs';
import { accountResult, latestAccountRun } from '../web/account-result.js';

function report(statuses, options = {}) {
  const run = {
    id: 'current-report', kind: 'evaluation', profile: 'standard', runStatus: 'completed',
    startedAt: '2026-10-10T08:00:00Z', comparisonKey: 'same-config',
    config: { accountId: 'account-a', target: 'codex/test', effort: 'high', seed: 'same-seed' },
    observed: { stable: true, key: 'same-route' }, ...options,
    cases: statuses.map((status, index) => ({ status, family: ['candy', 'js-trace', 'constraint'][index % 3], httpStatus: status === 'http_error' ? 404 : 200 })),
  };
  run.summary = summarize(run.cases, run.profile === 'quick' ? 6 : 18);
  run.verdict = assessRun(run, options.baseline);
  return run;
}

test('account cards distinguish full passes from missing results and wrong answers without claiming historical stability', () => {
  const passing = accountResult(report(Array(18).fill('pass')));
  assert.equal(passing.title, '本轮全部通过');
  assert.equal(passing.score, '18 / 18');
  assert.match(passing.note, /已收集 1\/3/);
  assert.match(passing.note, /自动固定参考/);
  const partial = accountResult(report([...Array(12).fill('pass'), ...Array(6).fill('timeout')]));
  assert.equal(partial.title, '检测未完成');
  assert.equal(partial.tone, 'warning');
  assert.equal(partial.score, '12 / 18');
  assert.match(partial.detail, /6 题未评分/);
  assert.match(partial.note, /未评分不计作答错/);
  const wrong = accountResult(report([...Array(14).fill('pass'), ...Array(4).fill('wrong_answer')]));
  assert.equal(wrong.title, '本轮有 4 题未通过');
  assert.match(wrong.detail, /4 题答案或格式未通过/);
  assert.match(wrong.note, /已收集 1\/3/);
});

test('account cards explain request failure, early stop, cancellation, quick checks and missing history', () => {
  const failure = accountResult(report(['http_error'], { runStatus: 'incomplete' }));
  assert.equal(failure.title, '检测未成功');
  assert.equal(failure.tone, 'error');
  assert.equal(failure.score, '—');
  assert.equal(failure.scoreLabel, '暂无成绩');
  assert.match(failure.detail, /18 题未评分（含 17 题未执行）/);
  assert.match(failure.note, /HTTP 404/);
  assert.equal(accountResult(report(['pass'], { runStatus: 'cancelled' })).title, '检测已停止');
  assert.equal(accountResult(report(['pass'], { runStatus: 'running' })).title, '检测进行中');
  const quick = accountResult(report(Array(6).fill('pass'), { profile: 'quick' }));
  assert.equal(quick.title, '快速检测全部通过');
  assert.match(quick.note, /需要标准检测和历史参考/);
  assert.equal(accountResult(null).title, '尚未检测');
});

test('account cards use the engine verdict for comparison instead of inventing a pass-rate threshold', () => {
  const baseline = { assessmentVersion: ASSESSMENT_VERSION, observedKey: 'same-route', createdAt: '2026-10-09T00:00:00Z',
    mean: 1, min: 1, max: 1, families: { candy: 1, 'js-trace': 1, constraint: 1 }, runIds: ['a', 'b', 'c'] };
  const lowered = report([...Array(12).fill('pass'), ...Array(6).fill('wrong_answer')], { baseline });
  const result = accountResult(lowered);
  assert.equal(lowered.verdict.code, 'decline_signal');
  assert.equal(result.title, '成绩低于历史参考');
  assert.match(result.note, /100%，本轮 66.7%/);
  const repeated = { ...lowered, id: 'next-report', startedAt: '2026-10-10T09:00:00Z' };
  repeated.verdict = assessRun(repeated, baseline, [lowered]);
  assert.equal(accountResult(repeated).title, '连续两轮成绩下降');
  const unchanged = accountResult(report(Array(18).fill('pass'), { baseline }));
  assert.equal(unchanged.title, '未发现明显下降');
  assert.match(unchanged.note, /未达到预设下降阈值/);
  const unverified = accountResult(report(Array(18).fill('pass'), { observed: { stable: false } }));
  assert.equal(unverified.title, '本轮全部通过');
  assert.match(unverified.note, /实际通道证据不足/);
});

test('the latest matching evaluation is visible even when an older standard run passed', () => {
  const older = report(Array(18).fill('pass'));
  const recent = report(['http_error'], { id: 'recent', startedAt: '2026-10-10T09:00:00Z', profile: 'quick', runStatus: 'incomplete' });
  const unrelated = ['accountId', 'target', 'effort', 'seed'].map((key) => ({
    ...recent, startedAt: '2026-10-10T10:00:00Z', config: { ...recent.config, [key]: 'different' },
  }));
  const fingerprint = { ...recent, kind: 'fingerprint', startedAt: '2026-10-10T11:00:00Z' };
  const runs = [older, ...unrelated, fingerprint, recent];
  assert.equal(latestAccountRun(runs, older.config), recent);
  assert.equal(runs[0], older);
  assert.equal(latestAccountRun(runs, { ...older.config, accountId: 'missing' }), null);
});
