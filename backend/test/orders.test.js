import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './d1-sqlite-adapter.js';

// --- Catálogo de teste devolvido pelo fetch() mockado ----------------------
const FAKE_CATALOG = {
  products: [
    { id: 'PAN001', name: 'Pano Amores', price: 4.99, stock: 50, weight_g: 82, unit_count: 1 },
  ],
};
const FAKE_COUNTRIES = { countries: [{ code: 'PT', name: 'Portugal', enabled: true }] };
const FAKE_SHIPPING = {
  _meta: { currency: 'EUR' },
  methods: [{ id: 'ctt', name: 'CTT', enabled: true }],
  rates: { PT: { ctt: [{ maxWeight: 1, price: 500 }] } },
};

let originalFetch;

before(() => {
  originalFetch = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('products.json')) return new Response(JSON.stringify(FAKE_CATALOG), { status: 200 });
    if (u.includes('countries.json')) return new Response(JSON.stringify(FAKE_COUNTRIES), { status: 200 });
    if (u.includes('shipping.json')) return new Response(JSON.stringify(FAKE_SHIPPING), { status: 200 });
    throw new Error(`fetch inesperado em teste: ${u}`);
  };
});

after(() => {
  global.fetch = originalFetch;
});

const {
  createOrder,
  getOrder,
  claimWebhookEventOnce,
  redactCustomerForLogs,
  applyStockDecrementForPaidOrder,
  syncStockFromPublishedCatalog,
  getAvailableStock,
} = await import('../src/orders.js');
const { generateOrderNumber } = await import('../src/db.js');

function makeEnv() {
  return {
    DB: createTestDb(),
    PRODUCTS_URL: 'https://example.test/products.json',
    COUNTRIES_URL: 'https://example.test/countries.json',
    SHIPPING_URL: 'https://example.test/shipping.json',
    PAYPAL_ENVIRONMENT: 'sandbox',
  };
}

const validPayload = {
  customer: { name: 'Ana Silva', email: 'ana@example.com', phone: '912345678' },
  shipping: { country: 'PT', method: 'ctt', address: 'Rua X, 1', postalCode: '1000-001', city: 'Lisboa' },
  items: [{ sku: 'PAN001', qty: 2 }],
};

test('generateOrderNumber: segue o formato MP-YYYYMMDD-XXXXXX', () => {
  const id = generateOrderNumber();
  assert.match(id, /^MP-\d{8}-[A-Z0-9]{6}$/);
});

test('redactCustomerForLogs: nunca expõe dados pessoais completos', () => {
  const redacted = redactCustomerForLogs({ name: 'Ana Silva', email: 'ana@example.com', phone: '912345678' });
  assert.equal(redacted.email.includes('ana@example.com'), false);
  assert.equal(redacted.phone, '***');
});

test('createOrder: cria uma encomenda PENDING_PAYMENT/PENDING com totais recalculados', async () => {
  const env = makeEnv();
  const order = await createOrder(env, validPayload, 'idem-key-1');
  assert.equal(order.status, 'PENDING_PAYMENT');
  assert.equal(order.paymentStatus, 'PENDING');
  assert.equal(order.subtotal, 998); // 4.99 * 2 = 9.98€
  assert.equal(order.totalWeightG, 164); // 82 * 2
  assert.equal(order.shippingCost, 500);
  assert.equal(order.total, 998 + 500);
});

test('idempotência: duplo clique com a mesma Idempotency-Key não cria duas encomendas', async () => {
  const env = makeEnv();
  const first = await createOrder(env, validPayload, 'same-key');
  const second = await createOrder(env, validPayload, 'same-key');
  assert.equal(first.id, second.id);
  assert.equal(first.orderNumber, second.orderNumber);
});

test('idempotência: chaves diferentes criam encomendas diferentes', async () => {
  const env = makeEnv();
  const first = await createOrder(env, validPayload, 'key-a');
  const second = await createOrder(env, validPayload, 'key-b');
  assert.notEqual(first.orderNumber, second.orderNumber);
});

test('createOrder: rejeita cliente sem email', async () => {
  const env = makeEnv();
  await assert.rejects(
    () => createOrder(env, { ...validPayload, customer: { name: 'Ana' } }, null),
    (err) => err.code === 'INVALID_CUSTOMER',
  );
});

test('createOrder: rejeita morada incompleta', async () => {
  const env = makeEnv();
  await assert.rejects(
    () => createOrder(env, { ...validPayload, shipping: { country: 'PT', method: 'ctt' } }, null),
    (err) => err.code === 'INVALID_SHIPPING',
  );
});

test('getOrder: encontra a encomenda pelo número gerado', async () => {
  const env = makeEnv();
  const created = await createOrder(env, validPayload, null);
  const found = await getOrder(env, created.orderNumber);
  assert.equal(found.orderNumber, created.orderNumber);
});

test('webhook: evento processado uma vez não é considerado duplicado antes de o marcar', async () => {
  const env = makeEnv();
  const first = await claimWebhookEventOnce(env, { eventId: 'evt-1', eventType: 'PAYMENT.CAPTURE.COMPLETED', orderNumber: 'MP-1' });
  assert.equal(first, true);
  const second = await claimWebhookEventOnce(env, { eventId: 'evt-1', eventType: 'PAYMENT.CAPTURE.COMPLETED', orderNumber: 'MP-1' });
  assert.equal(second, false);
});

test('syncStockFromPublishedCatalog: sincroniza a partir do products.json mockado', async () => {
  const env = makeEnv();
  const result = await syncStockFromPublishedCatalog(env);
  assert.equal(result.created, 1);
  assert.equal(await getAvailableStock(env, 'PAN001'), 50);
});

test('applyStockDecrementForPaidOrder: reduz stock atomicamente após pagamento confirmado', async () => {
  const env = makeEnv();
  await syncStockFromPublishedCatalog(env);
  const order = await createOrder(env, validPayload, null);

  const result = await applyStockDecrementForPaidOrder(env, order);
  assert.equal(result.ok, true);
  assert.equal(await getAvailableStock(env, 'PAN001'), 48); // 50 - 2
});

test('applyStockDecrementForPaidOrder: marca stock_conflict quando não há stock suficiente', async () => {
  const env = makeEnv();
  await syncStockFromPublishedCatalog(env);
  const order = await createOrder(env, validPayload, null);

  // Esgota o stock manualmente antes da redução real (simula outro cliente a comprar entretanto).
  const { decrementStockForOrder } = await import('../src/db.js');
  await decrementStockForOrder(env.DB, [{ sku: 'PAN001', quantity: 49 }]);

  const result = await applyStockDecrementForPaidOrder(env, order);
  assert.equal(result.ok, false);
  assert.deepEqual(result.conflicts, ['PAN001']);

  const updated = await getOrder(env, order.orderNumber);
  assert.equal(updated.stockConflict, true);
});
