/**
 * Mestre do Pano — backend/src/paypal.js
 *
 * Cliente mínimo para a API REST do PayPal (v2 Orders + verificação de
 * webhooks). PAYPAL_CLIENT_SECRET nunca sai deste ficheiro / deste
 * ambiente de execução — é lido apenas de env (variável de ambiente do
 * Worker), nunca de código, nunca enviado ao frontend.
 */

function apiBase(env) {
  return env.PAYPAL_ENVIRONMENT === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';
}

let cachedToken = { token: null, expiresAt: 0 };

/** Exportado apenas para testes — força a obtenção de um novo access token. */
export function resetPayPalTokenCache() {
  cachedToken = { token: null, expiresAt: 0 };
}

async function getAccessToken(env) {
  const now = Date.now();
  if (cachedToken.token && now < cachedToken.expiresAt - 30_000) {
    return cachedToken.token;
  }

  const basicAuth = btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`);
  const res = await fetch(`${apiBase(env)}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!res.ok) {
    throw new Error(`Falha na autenticação com o PayPal (${res.status}).`);
  }

  const data = await res.json();
  cachedToken = { token: data.access_token, expiresAt: now + data.expires_in * 1000 };
  return cachedToken.token;
}

/**
 * Cria uma ordem de pagamento no PayPal Sandbox para uma encomenda já
 * calculada pelo backend. `order.total` (cêntimos) e `order.currency` são
 * a única fonte de verdade para o valor cobrado.
 *
 * PayPal-Request-Id garante idempotência do lado do PayPal: se o mesmo
 * pedido for reenviado (ex.: duplo clique com falha de rede a meio),
 * o PayPal devolve a mesma ordem em vez de criar outra.
 */
export async function createPayPalOrder(env, order) {
  const token = await getAccessToken(env);
  const amountValue = (order.total / 100).toFixed(2);

  const res = await fetch(`${apiBase(env)}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': order.orderId,
    },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: order.orderId,
          custom_id: order.orderId,
          amount: { currency_code: order.currency, value: amountValue },
        },
      ],
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Não foi possível criar a ordem PayPal: ${data.message || res.status}`);
  }
  return data; // contém data.id (paypalOrderId)
}

/**
 * Captura o pagamento de uma ordem PayPal já aprovada pelo cliente.
 * Verifica sempre o valor capturado contra o total calculado pelo
 * backend antes de considerar a encomenda paga.
 */
export async function capturePayPalOrder(env, paypalOrderId) {
  const token = await getAccessToken(env);

  const res = await fetch(`${apiBase(env)}/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  const data = await res.json();
  if (!res.ok) {
    return { ok: false, status: data.status || 'FAILED', raw: data };
  }
  return { ok: true, status: data.status, raw: data };
}

/** Extrai o valor efetivamente capturado (em cêntimos) da resposta do PayPal. */
export function extractCapturedAmountCents(captureResponse) {
  try {
    const capture = captureResponse.raw.purchase_units[0].payments.captures[0];
    return { cents: Math.round(parseFloat(capture.amount.value) * 100), currency: capture.amount.currency_code };
  } catch (e) {
    return null;
  }
}

/**
 * Valida a autenticidade de um webhook do PayPal usando a API oficial de
 * verificação (`/v1/notifications/verify-webhook-signature`), conforme a
 * documentação do PayPal. Nunca aceitar um webhook sem esta verificação.
 */
export async function verifyWebhookSignature(env, { headers, body }) {
  const token = await getAccessToken(env);

  const payload = {
    transmission_id: headers.get('paypal-transmission-id'),
    transmission_time: headers.get('paypal-transmission-time'),
    cert_url: headers.get('paypal-cert-url'),
    auth_algo: headers.get('paypal-auth-algo'),
    transmission_sig: headers.get('paypal-transmission-sig'),
    webhook_id: env.PAYPAL_WEBHOOK_ID,
    webhook_event: body,
  };

  if (!payload.transmission_id || !payload.transmission_sig || !payload.cert_url) {
    return false;
  }

  const res = await fetch(`${apiBase(env)}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) return false;
  const data = await res.json();
  return data.verification_status === 'SUCCESS';
}
