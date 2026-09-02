export function corsHeaders(env, request) {
  const origin = request.headers.get('Origin');
  const allowed = env.ALLOWED_ORIGIN;
  const allowOrigin = allowed && (allowed === '*' || origin === allowed) ? (allowed === '*' ? '*' : origin) : allowed;

  return {
    'Access-Control-Allow-Origin': allowOrigin || allowed || '',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export function json(data, init = {}, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...extraHeaders,
      ...(init.headers || {}),
    },
  });
}
