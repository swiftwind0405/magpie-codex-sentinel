const linkError = new URLSearchParams(location.search).get('error');
if (linkError) {
  document.getElementById('login-error').textContent = linkError === 'rate_limited'
    ? '登录尝试过于频繁，请一分钟后重新打开链接或输入密钥。'
    : '链接中的访问密钥无效。请使用当前 MAGPIE_WEB_KEY 或管理员提供的密码。';
}
document.getElementById('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = document.getElementById('login');
  const error = document.getElementById('login-error');
  button.disabled = true;
  error.textContent = '';
  try {
    const response = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-sentinel-request': '1' },
      body: JSON.stringify({ password: document.getElementById('password').value }), signal: AbortSignal.timeout(15000) });
    if (!response.headers.get('content-type')?.includes('application/json')) {
      throw new Error(`检测服务或反向代理返回 HTTP ${response.status}，请稍后重试或检查服务日志。`);
    }
    const result = await response.json();
    if (!response.ok) { throw new Error(result.error || '登录失败。'); }
    location.replace('/');
  } catch (cause) { error.textContent = cause.message || '连接失败，请稍后重试。'; }
  finally { document.getElementById('password').value = ''; button.disabled = false; }
});
