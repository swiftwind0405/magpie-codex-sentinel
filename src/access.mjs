import { readFile } from 'node:fs/promises';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { request as httpRequest } from 'node:http';

const derive = promisify(scrypt);
const COOKIE = '__Host-sentinel';
const SESSION_MS = 12 * 60 * 60 * 1000;
const fail = (status, message) => Object.assign(new Error(message), { status });

/** Remote policy is resolved once, before any listener or paid work exists. */
export async function createAccess(options = {}, env = process.env) {
  const configuredOrigin = options.remoteOrigin ?? env.SENTINEL_REMOTE_ORIGIN;
  const passwordFile = options.passwordFile ?? env.SENTINEL_PASSWORD_FILE;
  const bind = options.remoteBind ?? env.SENTINEL_REMOTE_BIND;
  if (!configuredOrigin) {
    if (passwordFile || bind) { throw new Error('passwordFile / remoteBind 需要同时配置 remoteOrigin。'); }
    return { remote: false, bind: '127.0.0.1' };
  }
  let address;
  try { address = new URL(configuredOrigin); } catch { throw new Error('remoteOrigin 必须是完整 HTTPS 地址。'); }
  if (address.protocol !== 'https:' || address.username || address.password || address.pathname !== '/' || address.search || address.hash) {
    throw new Error('remoteOrigin 必须是无路径、账号或查询参数的 HTTPS origin。');
  }
  if (!passwordFile || typeof passwordFile !== 'string') { throw new Error('远程模式必须配置 passwordFile，不能免登录启动。'); }
  if (bind !== undefined && !['127.0.0.1', '0.0.0.0'].includes(bind)) { throw new Error('remoteBind 只能是 127.0.0.1 或 0.0.0.0。'); }
  let password;
  try { password = (await readFile(passwordFile, 'utf8')).replace(/\r?\n$/, ''); }
  catch { throw new Error('无法读取 Sentinel 密码文件。'); }
  if (password.length < 16 || Buffer.byteLength(password) > 1024 || /[\r\n]/.test(password)) {
    throw new Error('Sentinel 密码必须是 16–1024 字节的单行长密码。');
  }
  const salt = randomBytes(16);
  const expected = await derive(password, salt, 32);
  const sessions = new Map();
  let attempts = [];
  let checking = false;
  let peerCookie;
  const token = (request) => {
    const cookies = String(request.headers.cookie || '').split(';').map((item) => item.trim());
    const value = cookies.find((item) => item.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    return /^[a-f0-9]{64}$/.test(value || '') ? value : null;
  };
  const prune = () => {
    for (const [id, expires] of sessions) { if (expires <= Date.now()) { sessions.delete(id); } }
  };
  const cookie = (value, age) => `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;
  const access = {
    remote: true, origin: address.origin, bind: bind || '0.0.0.0',
    authenticated(request) { prune(); return sessions.has(token(request)); },
    async login(request, response, body) {
      const now = Date.now();
      attempts = attempts.filter((time) => time > now - 60000);
      if (checking || attempts.length >= 10) {
        response.setHeader('retry-after', '60');
        throw fail(429, '登录尝试过于频繁，请一分钟后重试。');
      }
      attempts.push(now);
      if (typeof body.password !== 'string' || Buffer.byteLength(body.password) > 1024) { throw fail(401, '密码不正确。'); }
      checking = true;
      try {
        const actual = await derive(body.password, salt, 32);
        if (!timingSafeEqual(actual, expected)) { throw fail(401, '密码不正确。'); }
        prune();
        sessions.delete(token(request));
        // Bound memory and invalidate the oldest session when the limit is reached.
        if (sessions.size >= 64) { sessions.delete(sessions.keys().next().value); }
        const id = randomBytes(32).toString('hex');
        sessions.set(id, Date.now() + SESSION_MS);
        response.setHeader('set-cookie', cookie(id, SESSION_MS / 1000));
      } finally { checking = false; }
    },
    logout(request, response) {
      sessions.delete(token(request));
      response.setHeader('set-cookie', cookie('', 0));
    },
    // A second Magpie host uses the normal login boundary, never a backdoor.
    // Keep its cookie so follower checks do not repeatedly attempt login.
    async peerState(port) {
      const call = (path, body) => new Promise((resolve, reject) => {
        const req = httpRequest({ hostname: '127.0.0.1', port, path, method: body ? 'POST' : 'GET',
          headers: { host: address.host, origin: address.origin, 'x-sentinel-request': '1', 'content-type': 'application/json', ...(peerCookie ? { cookie: peerCookie } : {}) },
        }, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; if (data.length > 1048576) { res.destroy(new Error('响应过大')); } });
          res.on('error', reject);
          res.on('end', () => resolve({ status: res.statusCode, cookie: res.headers['set-cookie']?.[0]?.split(';')[0], data }));
        });
        req.setTimeout(1500, () => req.destroy(new Error('宿主探测超时')));
        req.on('error', reject);
        req.end(body ? JSON.stringify(body) : undefined);
      });
      let result = await call('/api/state');
      if (result.status === 401) {
        const login = await call('/api/login', { password });
        if (login.status !== 200 || !login.cookie) { throw new Error('端口上的服务未接受当前远程登录配置。'); }
        peerCookie = login.cookie;
        result = await call('/api/state');
      }
      if (result.status !== 200) { throw new Error('无法验证现有 Sentinel 宿主。'); }
      return JSON.parse(result.data);
    },
  };
  return access;
}
