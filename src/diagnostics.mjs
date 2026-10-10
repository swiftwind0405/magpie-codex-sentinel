// Diagnostics contain selected, bounded metadata; never whole response objects.
export function redact(value, { apiKey, account } = {}, limit = 800) {
  let text = typeof value === 'string' ? value : '';
  for (const secret of [apiKey, account]) {
    if (secret) {
      for (const form of new Set([secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)])) {
        text = text.split(form).join('[已隐藏]');
      }
    }
  }
  return text
    .replace(/its accounts are[\s\S]*/i, 'its accounts are [已隐藏账号列表]')
    .replace(/no account\s+"[^"]*"/gi, 'no account "[已隐藏]"')
    .replace(/[\w.+-]+@[\w.-]+/g, '[已隐藏邮箱]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[已隐藏地址]')
    .replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer [已隐藏]')
    .replace(/((?:["']?(?:[\w-]*(?:key|token|secret|password)|authorization|cookie)["']?)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[已隐藏]')
    .replace(/\b(?:sk-[\w-]+|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g, '[已隐藏]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, limit);
}

export function upstreamDiagnostic(payload, config = {}) {
  const error = payload?.response?.error ?? payload?.error ?? payload ?? {};
  const code = typeof error.code === 'string' ? error.code : '';
  const message = typeof error.message === 'string' ? error.message : '';
  let cause = null;
  if (['account_not_found', 'account_unavailable', 'account_model_unavailable'].includes(code)
    || /^X-Magpie-Account: no account ".+" serves this model; its accounts are /i.test(message)) {
    cause = 'account_unavailable';
  } else if (['model_not_found', 'unknown_model', 'unsupported_model'].includes(code)) {
    cause = 'model_unavailable';
  } else if (['endpoint_not_found', 'route_not_found'].includes(code)) {
    cause = 'endpoint_unavailable';
  }
  return {
    cause,
    upstreamCode: redact(code, config, 120) || null,
    upstreamType: redact(error.type, config, 120) || null,
    upstreamMessage: redact(message, config) || null,
  };
}

export function outputShape(output) {
  if (!Array.isArray(output)) { return []; }
  const tag = (value) => typeof value === 'string' && /^[a-z_]{1,60}$/.test(value) ? value : null;
  return output.slice(0, 32).map((item) => ({
    type: tag(item?.type), role: tag(item?.role), phase: tag(item?.phase), status: tag(item?.status),
    content: (Array.isArray(item?.content) ? item.content : []).slice(0, 16).map((part) => ({
      type: tag(part?.type), textChars: typeof part?.text === 'string' ? part.text.length : 0,
    })),
  }));
}

export function stopForFailure(row) {
  const cause = row.diagnostic?.cause;
  if (cause === 'account_unavailable') {
    return { scope: 'account', reason: '指定账号无法服务所选模型，已停止本账号；请检查账号与模型的对应关系。' };
  }
  if (['model_unavailable', 'endpoint_unavailable'].includes(cause)) {
    return { scope: 'batch', reason: '网关明确报告模型或接口配置不可用，已停止后续检测；请检查模型与网关地址。' };
  }
  if (['auth_error', 'rate_limited', 'cancelled', 'run_timeout'].includes(row.status)) {
    return { scope: 'account', reason: '遇到认证、限流、取消或整轮超时，已停止本账号的后续请求。' };
  }
  if (row.status === 'http_error' && row.httpStatus === 404) {
    return { scope: 'account', reason: '请求返回 HTTP 404，已停止本账号的重复请求；具体原因未确认，请查看诊断。' };
  }
  return null;
}
