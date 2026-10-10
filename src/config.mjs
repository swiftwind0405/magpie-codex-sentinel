import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export const VERSION = '0.3.0';
export const REQUEST_VERSION = 'responses-isolated-v1';
export const hash = (value) => createHash('sha256').update(String(value)).digest('hex');
export const accountId = (baseUrl, account) => account ? hash(`${baseUrl}\ncodex\n${account.toLowerCase()}`).slice(0, 16) : null;

export function defaultDirectory() {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'magpie');
}

function integer(value, fallback, min, max, name) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} 必须是 ${min}–${max} 之间的整数。`);
  }
  return value;
}

export function normalizeOptions(options = {}, { directory, apiKey, requireTarget = true } = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('options 必须是 JSON 对象。');
  const base = new URL(options.baseUrl || 'http://127.0.0.1:3425/v1');
  if (base.username || base.password || base.search || base.hash) throw new Error('baseUrl 不可包含用户名、密码、查询参数或 fragment。');
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname);
  if (!loopback && options.allowRemote !== true) throw new Error('远程 Magpie 需显式设置 allowRemote: true，并使用 HTTPS。');
  if (!['http:', 'https:'].includes(base.protocol) || (!loopback && base.protocol !== 'https:')) {
    throw new Error('本机仅支持 HTTP/HTTPS，远程仅支持 HTTPS。');
  }
  base.pathname = base.pathname.replace(/\/+$/, '') || '/v1';
  if (!base.pathname.endsWith('/v1')) throw new Error('baseUrl 应以 /v1 结尾，例如 http://127.0.0.1:3425/v1。');
  const target = typeof options.target === 'string' ? options.target.trim() : '';
  if (requireTarget && !target) { throw new Error('请选择检测目标，或设置 target 为 Magpie 模型列表中的 provider/model。'); }
  if (target && (!/^[^\s/]+\/[^\s]+$/.test(target) || /[\u0000-\u001f]/.test(target))) throw new Error('target 必须是完整的 provider/model，不能只写模型名。');
  if (/^codex-sentinel(?:-plugin)?\//.test(target)) throw new Error('检测目标不能是检测插件自己。请选择真正的 Codex 通道。');
  const effort = options.effort ?? 'high';
  if (!['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'default'].includes(effort)) {
    throw new Error('未知 effort；请使用 Magpie 模型列表支持的档位，或 default（不显式发送）。');
  }
  const account = options.account === undefined ? '' : String(options.account).trim();
  if (/[\u0000-\u001f\u007f]/.test(account) || account.length > 300) throw new Error('account 含无效字符或过长。');
  const seed = options.seed ?? 'sentinel-v1-reference';
  if (typeof seed !== 'string' || seed.length < 1 || seed.length > 200) throw new Error('seed 必须是 1–200 字符的字符串。');
  const parent = resolve(directory || defaultDirectory());
  if (options.dataDir !== undefined && (typeof options.dataDir !== 'string' || !options.dataDir)) throw new Error('dataDir 必须是非空路径。');
  const dataDir = options.dataDir ? (isAbsolute(options.dataDir) ? options.dataDir : resolve(parent, options.dataDir)) : join(parent, 'codex-sentinel');
  const key = apiKey ?? process.env.MAGPIE_GATEWAY_KEY ?? 'magpie';
  if (typeof key !== 'string' || !key || /[\r\n]/.test(key)) throw new Error('Magpie gateway key 不能为空或包含换行。');
  return {
    baseUrl: base.href.replace(/\/$/, ''), target, effort, account, seed, dataDir, apiKey: key,
    timeoutMs: integer(options.timeoutMs, 120000, 1000, 300000, 'timeoutMs'),
    runTimeoutMs: integer(options.runTimeoutMs, 1800000, 1000, 3600000, 'runTimeoutMs'),
    maxOutputTokens: integer(options.maxOutputTokens, 8192, 512, 32768, 'maxOutputTokens'),
    // A response byte limit also bounds reasoning/event data; it is not a billed-token guarantee.
    maxResponseBytes: integer(options.maxResponseBytes, 8 * 1024 * 1024, 8192, 32 * 1024 * 1024, 'maxResponseBytes'),
  };
}

export function publicConfig(config) {
  const accountHint = !config.account ? '未固定账户' : config.account.includes('@')
    ? `${config.account.slice(0, 2)}***@${config.account.split('@').at(-1)}` : `已固定账户（${hash(config.account).slice(0, 8)}）`;
  return {
    baseUrl: config.baseUrl, target: config.target, effort: config.effort,
    seed: config.seed, maxOutputTokens: config.maxOutputTokens,
    timeoutMs: config.timeoutMs, runTimeoutMs: config.runTimeoutMs,
    accountPinned: Boolean(config.account), accountHint,
    accountId: accountId(config.baseUrl, config.account),
    // Never serialize an auth key or the unmasked account name.
    accessIdentity: hash(`${config.baseUrl}\n${config.apiKey}\n${config.account}`),
    requestVersion: REQUEST_VERSION, concurrency: 1,
  };
}

export function comparisonKey(config, profile, suiteVersion) {
  const p = publicConfig(config);
  return hash(JSON.stringify({ ...p, accountHint: undefined, profile, suiteVersion }));
}
