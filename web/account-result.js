export function latestAccountRun(runs, config) {
  return runs.filter((run) => run.kind === 'evaluation'
    && ['accountId', 'target', 'effort', 'seed'].every((key) => run.config?.[key] === config[key]))
    .reduce((latest, run) => !latest || Date.parse(run.startedAt) > Date.parse(latest.startedAt) ? run : latest, null);
}

const percent = (value) => (value * 100).toFixed(1).replace(/\.0$/, '');

export function accountResult(run) {
  if (!run) {
    return { tone: 'neutral', title: '尚未检测', score: '—', scoreLabel: '', detail: '当前配置还没有检测记录。', note: '选择此账号，然后开始检测。' };
  }
  const { summary, verdict } = run;
  const failed = summary.usable - summary.passed;
  const unscored = summary.planned - summary.usable;
  const result = {
    tone: failed ? 'warning' : 'pass',
    title: failed ? `本轮有 ${failed} 题未通过` : '本轮全部通过',
    score: summary.usable ? `${summary.passed} / ${summary.planned}` : '—',
    scoreLabel: summary.usable ? '题通过' : '暂无成绩',
    detail: failed ? `${failed} 题答案或格式未通过` : `${summary.planned} 题均已完成评分`,
    note: '',
  };
  if (run.runStatus !== 'completed' || !summary.complete) {
    result.tone = run.runStatus === 'cancelled' || run.runStatus === 'running' ? 'neutral' : summary.usable ? 'warning' : 'error';
    result.title = run.runStatus === 'cancelled' ? '检测已停止' : run.runStatus === 'running' ? '检测进行中'
      : summary.usable ? '检测未完成' : '检测未成功';
    result.detail = `${failed ? `${failed} 题未通过 · ` : ''}${unscored} 题未评分${summary.attempted < summary.planned ? `（含 ${summary.planned - summary.attempted} 题未执行）` : ''}`;
    result.note = run.runStatus === 'running' ? '当前是中间结果，请等待检测结束。'
      : run.runStatus === 'cancelled' ? '本轮已停止，结果不足以判断能力变化。'
        : `${verdict.label}。查看报告排查原因后再测；未评分不计作答错。`;
    return result;
  }
  switch (verdict.code) {
    case 'decline_signal':
    case 'repeated_decline':
      result.tone = 'warning';
      result.title = verdict.code === 'repeated_decline' ? '连续两轮成绩下降' : '成绩低于历史参考';
      result.note = `历史平均通过率 ${percent(verdict.referenceMean)}%，本轮 ${percent(summary.rate)}%。${verdict.code === 'repeated_decline' ? '请排查通道与配置。' : '建议用相同配置复测确认。'}`;
      break;
    case 'no_decline_signal':
      result.title = '未发现明显下降';
      result.note = `历史平均通过率 ${percent(verdict.referenceMean)}%，本轮 ${percent(summary.rate)}%；未达到预设下降阈值。`;
      break;
    case 'no_baseline':
      result.note = verdict.reason;
      break;
    case 'baseline_established':
    case 'reference_ready':
      result.note = verdict.reason;
      break;
    case 'quick_only':
      result.title = failed ? `初筛有 ${failed} 题未通过` : '快速检测全部通过';
      result.note = '初筛题量较少；判断能力变化需要标准检测和历史参考。';
      break;
    case 'route_unverified':
      result.note = '实际通道证据不足，暂不能比较历史；请查看报告。';
      break;
    case 'route_changed':
      result.note = '实际模型或推理强度已变化，不能直接与原参考比较。';
      break;
    case 'baseline_incompatible':
      result.note = '历史参考的判定版本已变化，需要重新建立参考。';
      break;
    default:
      result.note = verdict.label;
  }
  return result;
}
