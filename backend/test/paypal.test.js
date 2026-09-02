import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

let originalFetch;
let calls;

before(() => { originalFetch = global.fetch; });
after(() => { global.fetch = originalFetch; });

beforeEach(() => { calls = []; resetPayPalTokenCache(); });

const { createPayPalOrder, capturePayPalOrder, extractCapturedAmountCents, verifyWebhookSignature, resetPayPalTokenCache } = await import('../src/paypal.js');

function env(overrides = {}) {
  return {
    PAYPAL_ENVIRONMENT: 'sandbox',
    PAYPAL_CLIENT_ID: 'test-client-id',
    PAYPAL_CLIENT_SECRET: 'test-secret',
    PAYPAL_WEBHOOK_ID: 'test-webhook-id',
    ...overrides,
  };
}

function mockFetchSequence(handlers) {
  let i = 0;
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    const handler = handlers[Math.min(i, handlers.length - 1)];
    i += 1;
    return handler(url, opts);
  };
}

test('createPayPalOrder: envia o total calculado pelo backend (nunca um valor do frontend)', async () => {
  mockFetchSequence([
    async () => new Response(JSON.stringify({ access_token: 'tok123', expires_in: 3600 }), { status: 200 }),
    async (url, opts) => {
      const body = JSON.parse(opts.body);
      assert.equal(body.purchase_units[0].amount.value, '14.98');
      assert.equal(body.purchase_units[0].amount.currency_code, 'EUR');
      assert.equal(opts.headers['PayPal-Request-Id'], 'MP-20260101-ABC123');
      return new Response(JSON.stringify({ id: 'PAYPAL-ORDER-1', status: 'CREATED' }), { status: 201 });
    },
  ]);

  const order = { orderId: 'MP-20260101-ABC123', total: 1498, currency: 'EUR' };
  const result = await createPayPalOrder(env(), order);
  assert.equal(result.id, 'PAYPAL-ORDER-1');
});

test('capturePayPalOrder: devolve ok:false quando o PayPal não completa o pagamento', async () => {
  mockFetchSequence([
    async () => new Response(JSON.stringify({ access_token: 'tok123', expires_in: 3600 }), { status: 200 }),
    async () => new Response(JSON.stringify({ status: 'DECLINED' }), { status: 422 }),
  ]);

  const result = await capturePayPalOrder(env(), 'PAYPAL-ORDER-1');
  assert.equal(result.ok, false);
});

test('capturePayPalOrder: devolve ok:true e status COMPLETED em caso de sucesso', async () => {
  mockFetchSequence([
    async () => new Response(JSON.stringify({ access_token: 'tok123', expires_in: 3600 }), { status: 200 }),
    async () => new Response(JSON.stringify({
      status: 'COMPLETED',
      purchase_units: [{ payments: { captures: [{ amount: { value: '14.98', currency_code: 'EUR' } }] } }],
    }), { status: 201 }),
  ]);

  const result = await capturePayPalOrder(env(), 'PAYPAL-ORDER-1');
  assert.equal(result.ok, true);
  assert.equal(result.status, 'COMPLETED');
});

test('extractCapturedAmountCents: converte o valor capturado para cêntimos inteiros', () => {
  const captureResponse = {
    raw: { purchase_units: [{ payments: { captures: [{ amount: { value: '14.98', currency_code: 'EUR' } }] } }] },
  };
  const result = extractCapturedAmountCents(captureResponse);
  assert.equal(result.cents, 1498);
  assert.equal(result.currency, 'EUR');
});

test('extractCapturedAmountCents: devolve null perante uma resposta inesperada', () => {
  assert.equal(extractCapturedAmountCents({ raw: {} }), null);
});

test('verifyWebhookSignature: rejeita quando faltam cabeçalhos essenciais do PayPal', async () => {
  mockFetchSequence([
    async () => new Response(JSON.stringify({ access_token: 'tok123', expires_in: 3600 }), { status: 200 }),
  ]);
  const headers = new Headers(); // sem paypal-transmission-id, etc.
  const isValid = await verifyWebhookSignature(env(), { headers, body: { id: 'evt-1' } });
  assert.equal(isValid, false);
});

test('verifyWebhookSignature: aceita apenas quando o PayPal confirma verification_status SUCCESS', async () => {
  mockFetchSequence([
    async () => new Response(JSON.stringify({ access_token: 'tok123', expires_in: 3600 }), { status: 200 }),
    async () => new Response(JSON.stringify({ verification_status: 'SUCCESS' }), { status: 200 }),
  ]);
  const headers = new Headers({
    'paypal-transmission-id': 't1',
    'paypal-transmission-time': '2026-01-01T00:00:00Z',
    'paypal-cert-url': 'https://api.paypal.com/cert',
    'paypal-auth-algo': 'SHA256withRSA',
    'paypal-transmission-sig': 'sig',
  });
  const isValid = await verifyWebhookSignature(env(), { headers, body: { id: 'evt-1' } });
  assert.equal(isValid, true);
});
