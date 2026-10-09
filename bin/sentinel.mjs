#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { normalizeOptions } from '../src/config.mjs';
import { fetchModels } from '../src/transport.mjs';
import { runEvaluation, runFingerprint, getHistory, getRun, setBaseline, formatReport, formatHistory } from '../src/engine.mjs';
import { renderHtml } from '../src/report.mjs';

const help = `Codex Sentinel · Magpie 检测插件的命令行入口

用法：node bin/sentinel.mjs <命令> [参数]

  models                         查看 Magpie 中真正存在的模型与推理档位
  run --profile quick|standard   运行能力检查（6 / 18 次独立请求）
  fingerprint                    运行 3 次可选 ModelTrace 指纹采样
  history                        查看最近 20 轮本机记录
  show RUN_ID                    查看一轮完整报告（加 --json 看原始证据）
  baseline ID1 ID2 ID3 [...]      选定至少 3 轮完整标准检测为固定参考
  export RUN_ID --out FILE        导出报告；--format html|json|md

通用参数：
  --config FILE                  从 JSON 文件读取插件 options
  --target PROVIDER/MODEL         目标；必须从 models 列表选择
  --effort high                   请求推理档位；default 表示不显式发送
  --account EMAIL_OR_ID           通过 Magpie 的账户固定请求头指定订阅账户
  --seed STRING                  固定题目种子（变化后需新建基线）
  --base-url URL                 默认 http://127.0.0.1:3425/v1
  --allow-remote                 显式允许 HTTPS 远程 Magpie
  --directory PATH               Magpie 配置目录；默认 ~/.config/magpie
  --data-dir PATH                检测记录目录（可选）
  --timeout-ms N                 单题超时；默认 120000
  --run-timeout-ms N             整轮超时；默认 1800000
  --max-output-tokens N          请求输出上限；Codex 订阅适配器可能移除它
  --json                         输出 JSON；进度写 stderr
  --force                        export 时允许覆盖已存在的目标文件

认证：插件里用 magpie plugin login codex-sentinel；CLI 读取
MAGPIE_GATEWAY_KEY，默认本机 token 为 magpie。CLI 不自动读取插件认证文件。
CLI 与插件共享同一记录目录，但 options 需用 --config 或参数显式传入。

退出码：0=请求流程完成（不等于已证明健康）；1=配置/存储异常；
2=达到预设下降阈值；3=检测不完整/有效指纹不足；130=取消。
`;

function parse(argv) {
  const result = { command: argv[0] || 'help', positionals: [], flags: {} };
  if (result.command === '--help' || result.command === '-h') result.command = 'help';
  const booleans = new Set(['json', 'allow-remote', 'force', 'help']);
  const values = new Set(['config', 'target', 'effort', 'account', 'seed', 'base-url', 'directory', 'data-dir', 'timeout-ms', 'run-timeout-ms', 'max-output-tokens', 'max-response-bytes', 'profile', 'out', 'format']);
  for (let i = 1; i < argv.length; i++) {
    const item = argv[i];
    if (!item.startsWith('--')) { result.positionals.push(item); continue; }
    const name = item.slice(2);
    if (booleans.has(name)) { result.flags[name] = true; continue; }
    if (!values.has(name)) throw new Error(`未知参数 --${name}。使用 --help 查看用法。`);
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error(`--${name} 缺少值。`);
    result.flags[name] = argv[++i];
  }
  return result;
}

async function main() {
  const args = parse(process.argv.slice(2)); const flags = args.flags;
  if (args.command === 'help' || flags.help) { process.stdout.write(help); return; }
  if (!['models', 'run', 'fingerprint', 'history', 'show', 'baseline', 'export'].includes(args.command)) throw new Error('未知命令。使用 --help 查看用法。');
  let options = flags.config ? JSON.parse(await readFile(resolve(flags.config), 'utf8')) : {};
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('--config 文件必须包含 JSON 对象。');
  options = { ...options };
  const mapping = { target: 'target', effort: 'effort', account: 'account', seed: 'seed', 'base-url': 'baseUrl', 'allow-remote': 'allowRemote', 'data-dir': 'dataDir', 'timeout-ms': 'timeoutMs', 'run-timeout-ms': 'runTimeoutMs', 'max-output-tokens': 'maxOutputTokens', 'max-response-bytes': 'maxResponseBytes' };
  for (const [flag, key] of Object.entries(mapping)) if (flags[flag] !== undefined) options[key] = /^(timeout|run-timeout|max-output|max-response)/.test(flag) ? Number(flags[flag]) : flags[flag];
  const controller = new AbortController();
  const cancel = () => controller.abort(new DOMException('User cancelled', 'AbortError'));
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  const common = { options, directory: flags.directory ? resolve(flags.directory) : undefined, signal: controller.signal };
  const output = (value, text) => process.stdout.write((flags.json ? JSON.stringify(value, null, 2) : text) + '\n');
  try {
    if (args.command === 'models') {
      const config = normalizeOptions(options, { directory: common.directory, requireTarget: false });
      const models = await fetchModels(config, common);
      output(models, models.map((m) => `${m.id}\t${(m.supported_reasoning_levels || []).map((l) => typeof l === 'string' ? l : l.effort).join(', ') || '未报告可选档位'}`).join('\n'));
    } else if (args.command === 'run' || args.command === 'fingerprint') {
      const task = { ...common, profile: flags.profile || 'quick', onProgress: ({ message }) => process.stderr.write(message + '\n') };
      const report = await (args.command === 'run' ? runEvaluation(task) : runFingerprint(task));
      output(report, formatReport(report));
      if (report.persisted === false) { process.exitCode = 1; }
      else if (report.cancelled) { process.exitCode = 130; }
      else if (report.runStatus !== 'completed') { process.exitCode = 3; }
      else if (report.kind === 'evaluation') {
        process.exitCode = !report.summary.complete ? 3 : ['decline_signal', 'repeated_decline'].includes(report.verdict.code) ? 2 : 0;
      } else {
        process.exitCode = report.fingerprint?.status === 'reported' ? 0 : 3;
      }
    } else if (args.command === 'history') {
      const rows = await getHistory(common); output(rows, formatHistory(rows));
    } else if (args.command === 'baseline') {
      const result = await setBaseline({ ...common, runIds: args.positionals }); output(result, result.message);
    } else {
      const id = args.positionals[0]; if (!id || args.positionals.length !== 1) throw new Error('请提供一个完整的 run ID。');
      const report = await getRun({ ...common, id });
      if (args.command === 'show') { output(report, formatReport(report)); return; }
      if (!flags.out) throw new Error('export 需要 --out 文件路径。');
      const format = flags.format || extname(flags.out).slice(1) || 'html';
      if (!['html', 'md', 'json'].includes(format)) throw new Error('导出格式只能是 html、md 或 json。');
      const contents = format === 'html' ? renderHtml(report) : format === 'json' ? JSON.stringify(report, null, 2) + '\n' : formatReport(report) + '\n';
      const path = resolve(flags.out); await writeFile(path, contents, { encoding: 'utf8', flag: flags.force ? 'w' : 'wx', mode: 0o600 });
      output({ path, format, id }, `已导出 ${path}`);
    }
  } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}

main().catch((error) => {
  let message = String(error.message || '检测失败。');
  const key = process.env.MAGPIE_GATEWAY_KEY;
  if (key && key.length >= 3) message = message.split(key).join('[redacted]');
  process.stderr.write(`错误：${message}\n`); process.exitCode = 1;
});
