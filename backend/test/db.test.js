/**
 * Mestre do Pano — backend/test/db.test.js
 *
 * Testa backend/src/db.js contra o adaptador D1-sobre-node:sqlite
 * (test/d1-sqlite-adapter.js) — sem rede, sem `wrangler d1 dev`.
 *
 * Cobre, em particular (secção 12 e "Por fazer" da Fase 5):
 *   - Overselling concorrente (decrementStockForOrder é atómico mesmo
 *     com dois pedidos "em simultâneo" para o mesmo SKU).
 *   - Compensação quando uma encomenda tem vários artigos e um deles
 *     falha a meio (os artigos já decrementados são devolvidos).
 *   - Sincronização de stock por delta (nunca sobrescreve vendas já
 *     feitas quando o Excel é sincronizado de novo).
 *   - Idempotência da criação de encomendas (idempotency_keys) e do
 *     processamento de webhooks (webhook_events).
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './d1-sqlite-adapter.js';
import {
  computeSyncedAvailableStock,
  getStock,
  syncStockFromCatalog,
  decrementStockForOrder,
  restockOrderItems,
  insertOrder,
  getOrderById,
  getOrderByNumber,
  updateOrderFields,
  findOrderByIdempotencyKey,
  saveIdempotencyKey,
  claimWebhookEvent,
} from '../src/db.js';

let db;

beforeEach(() => {
  db = createTestDb();
});

function baseQuote(overrides = {}) {
  return {
    lineItems: [
      { sku: 'PAN001', name: 'Pano Amores', qty: 2, unitPriceCents: 499, unitWeightG: 82, unitCount: 1, lineTotalCents: 998, lineWeightG: 164 },
    ],
    subtotalCents: 998,
    shippingCostCents: 500,
    totalCents: 1498,
    totalWeightG: 164,
    currency: 'EUR',
    ...overrides,
  };
}

function baseCustomer() {
  return { name: 'Ana Silva', email: 'ana@example.com', phone: '912345678' };
}

function baseShipping() {
  return { country: 'PT', method: 'ctt', address: 'Rua X, 1', postalCode: '1000-001', city: 'Lisboa' };
}

// ---------------------------------------------------------------------------
// computeSyncedAvailableStock (função pura)
// ---------------------------------------------------------------------------

test('computeSyncedAvailableStock: produto novo (sem linha ainda) usa o catalog_stock inicial', () => {
  const result = computeSyncedAvailableStock({ existing: null, newCatalogStock: 20 });
  assert.deepEqual(result, { catalog_stock: 20, available_stock: 20 });
});

test('computeSyncedAvailableStock: reposição no Excel (+5) soma ao available_stock atual', () => {
  const result = computeSyncedAvailableStock({ existing: { catalog_stock: 10, available_stock: 3 }, newCatalogStock: 15 });
  assert.deepEqual(result, { catalog_stock: 15, available_stock: 8 });
});

test('computeSyncedAvailableStock: correção no Excel para baixo (-2) nunca "devolve" vendas', () => {
  // catalog 10 -> 8, available atual 7 (já houve vendas) => 7 - 2 = 5, nunca volta a 8/10.
  const result = computeSyncedAvailableStock({ existing: { catalog_stock: 10, available_stock: 7 }, newCatalogStock: 8 });
  assert.deepEqual(result, { catalog_stock: 8, available_stock: 5 });
});

test('computeSyncedAvailableStock: nunca deixa available_stock ficar negativo', () => {
  const result = computeSyncedAvailableStock({ existing: { catalog_stock: 10, available_stock: 1 }, newCatalogStock: 3 });
  // delta = -7, available seria 1 - 7 = -6 => clamp a 0
  assert.deepEqual(result, { catalog_stock: 3, available_stock: 0 });
});

// ---------------------------------------------------------------------------
// syncStockFromCatalog (I/O)
// ---------------------------------------------------------------------------

test('syncStockFromCatalog: cria linhas novas para SKUs ainda não sincronizados', async () => {
  const result = await syncStockFromCatalog(db, [
    { id: 'PAN001', stock: 20 },
    { id: 'PAN002', stock: 5 },
  ]);
  assert.equal(result.created, 2);
  assert.equal((await getStock(db, 'PAN001')).available_stock, 20);
  assert.equal((await getStock(db, 'PAN002')).available_stock, 5);
});

test('syncStockFromCatalog: aplica delta sem sobrescrever vendas já feitas', async () => {
  await syncStockFromCatalog(db, [{ id: 'PAN001', stock: 10 }]);

  // Simula 3 vendas confirmadas (available_stock desce para 7).
  await decrementStockForOrder(db, [{ sku: 'PAN001', quantity: 3 }]);
  assert.equal((await getStock(db, 'PAN001')).available_stock, 7);

  // Dono corrige o Excel de 10 para 8 (-2).
  const result = await syncStockFromCatalog(db, [{ id: 'PAN001', stock: 8 }]);
  assert.equal(result.updated, 1);
  const row = await getStock(db, 'PAN001');
  assert.equal(row.catalog_stock, 8);
  assert.equal(row.available_stock, 5); // 7 - 2, nunca "8"
});

test('syncStockFromCatalog: ignora produtos sem stock numérico e reporta unchanged quando nada muda', async () => {
  await syncStockFromCatalog(db, [{ id: 'PAN001', stock: 10 }]);
  const result = await syncStockFromCatalog(db, [{ id: 'PAN001', stock: 10 }, { id: 'SEM_STOCK' }]);
  assert.equal(result.unchanged, 1);
  assert.equal(result.created, 0);
  assert.equal(result.updated, 0);
});

// ---------------------------------------------------------------------------
// decrementStockForOrder — proteção contra overselling
// ---------------------------------------------------------------------------

test('decrementStockForOrder: reduz stock quando há disponibilidade suficiente', async () => {
  await syncStockFromCatalog(db, [{ id: 'PAN001', stock: 10 }]);
  const result = await decrementStockForOrder(db, [{ sku: 'PAN001', quantity: 4 }]);
  assert.equal(result.ok, true);
  assert.equal((await getStock(db, 'PAN001')).available_stock, 6);
});

test('decrementStockForOrder: rejeita quando não há stock suficiente e não altera nada', async () => {
  await syncStockFromCatalog(db, [{ id: 'PAN001', stock: 3 }]);
  const result = await decrementStockForOrder(db, [{ sku: 'PAN001', quantity: 5 }]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.conflicts, ['PAN001']);
  assert.equal((await getStock(db, 'PAN001')).available_stock, 3); // inalterado
});

test('decrementStockForOrder: encomenda multi-item — se o 2º item falhar, o 1º é compensado (devolvido)', async () => {
  await syncStockFromCatalog(db, [
    { id: 'PAN001', stock: 10 },
    { id: 'PAN002', stock: 1 },
  ]);

  const result = await decrementStockForOrder(db, [
    { sku: 'PAN001', quantity: 4 },
    { sku: 'PAN002', quantity: 5 }, // só há 1 em stock => falha
  ]);

  assert.equal(result.ok, false);
  assert.deepEqual(result.conflicts, ['PAN002']);
  // PAN001 tinha sido decrementado mas foi compensado de volta a 10.
  assert.equal((await getStock(db, 'PAN001')).available_stock, 10);
  assert.equal((await getStock(db, 'PAN002')).available_stock, 1);
});

test('decrementStockForOrder: proteção contra overselling concorrente — só uma de duas encomendas simultâneas para as últimas unidades tem sucesso', async () => {
  await syncStockFromCatalog(db, [{ id: 'PAN001', stock: 6 }]);

  // Duas "encomendas" a pedir 6 unidades cada, em simultâneo, quando só há 6.
  const [resultA, resultB] = await Promise.all([
    decrementStockForOrder(db, [{ sku: 'PAN001', quantity: 6 }]),
    decrementStockForOrder(db, [{ sku: 'PAN001', quantity: 6 }]),
  ]);

  const oks = [resultA.ok, resultB.ok].filter(Boolean);
  assert.equal(oks.length, 1, 'exatamente uma das duas encomendas concorrentes deve ter sucesso');
  assert.equal((await getStock(db, 'PAN001')).available_stock, 0);
});

test('restockOrderItems: devolve stock ao inventário', async () => {
  await syncStockFromCatalog(db, [{ id: 'PAN001', stock: 10 }]);
  await decrementStockForOrder(db, [{ sku: 'PAN001', quantity: 4 }]);
  await restockOrderItems(db, [{ sku: 'PAN001', quantity: 4 }]);
  assert.equal((await getStock(db, 'PAN001')).available_stock, 10);
});

// ---------------------------------------------------------------------------
// insertOrder / getOrderById — snapshot de valores no momento da compra
// ---------------------------------------------------------------------------

test('insertOrder: cria a encomenda em PENDING_PAYMENT/PENDING com snapshot dos line items', async () => {
  const order = await insertOrder(db, { quote: baseQuote(), customer: baseCustomer(), shipping: baseShipping(), isTest: true });

  assert.match(order.orderNumber, /^MP-\d{8}-[A-Z0-9]{6}$/);
  assert.equal(order.status, 'PENDING_PAYMENT');
  assert.equal(order.paymentStatus, 'PENDING');
  assert.equal(order.subtotal, 998);
  assert.equal(order.total, 1498);
  assert.equal(order.items.length, 1);
  assert.equal(order.items[0].sku, 'PAN001');
  assert.equal(order.items[0].unitCount, 1);
});

test('insertOrder: aceita unit_count nulo (produto sem Unidades definidas no Excel) sem inventar valor', async () => {
  const quote = baseQuote({
    lineItems: [
      { sku: 'PACKINV', name: 'Pack sem unidades', qty: 1, unitPriceCents: 2000, unitWeightG: 600, unitCount: null, lineTotalCents: 2000, lineWeightG: 600 },
    ],
  });
  const order = await insertOrder(db, { quote, customer: baseCustomer(), shipping: baseShipping(), isTest: true });
  assert.equal(order.items[0].unitCount, null);
});

test('getOrderByNumber: encontra a encomenda pelo número gerado', async () => {
  const order = await insertOrder(db, { quote: baseQuote(), customer: baseCustomer(), shipping: baseShipping(), isTest: true });
  const found = await getOrderByNumber(db, order.orderNumber);
  assert.equal(found.id, order.id);
});

test('updateOrderFields: atualiza status/payment_status/paypal ids preservando o resto', async () => {
  const order = await insertOrder(db, { quote: baseQuote(), customer: baseCustomer(), shipping: baseShipping(), isTest: true });
  const updated = await updateOrderFields(db, order.orderNumber, {
    status: 'PAID',
    payment_status: 'COMPLETED',
    paypal_order_id: 'PAYPAL-1',
    paypal_capture_id: 'CAPTURE-1',
  });
  assert.equal(updated.status, 'PAID');
  assert.equal(updated.paymentStatus, 'COMPLETED');
  assert.equal(updated.paypalOrderId, 'PAYPAL-1');
  assert.equal(updated.paypalCaptureId, 'CAPTURE-1');
  assert.equal(updated.total, order.total); // inalterado
});

// ---------------------------------------------------------------------------
// Idempotência — criação de encomendas
// ---------------------------------------------------------------------------

test('idempotency_keys: findOrderByIdempotencyKey devolve null quando a chave não existe', async () => {
  assert.equal(await findOrderByIdempotencyKey(db, 'inexistente'), null);
});

test('idempotency_keys: saveIdempotencyKey liga uma chave a uma encomenda e pode ser encontrada depois', async () => {
  const order = await insertOrder(db, { quote: baseQuote(), customer: baseCustomer(), shipping: baseShipping(), isTest: true });
  await saveIdempotencyKey(db, 'same-key', order.id);
  const found = await findOrderByIdempotencyKey(db, 'same-key');
  assert.equal(found.id, order.id);
});

test('idempotency_keys: chave duplicada (INSERT OR IGNORE) não é sobrescrita para outra encomenda', async () => {
  const orderA = await insertOrder(db, { quote: baseQuote(), customer: baseCustomer(), shipping: baseShipping(), isTest: true });
  const orderB = await insertOrder(db, { quote: baseQuote(), customer: baseCustomer(), shipping: baseShipping(), isTest: true });

  await saveIdempotencyKey(db, 'same-key', orderA.id);
  await saveIdempotencyKey(db, 'same-key', orderB.id); // deve ser ignorado

  const found = await findOrderByIdempotencyKey(db, 'same-key');
  assert.equal(found.id, orderA.id);
});

// ---------------------------------------------------------------------------
// Idempotência — webhooks do PayPal
// ---------------------------------------------------------------------------

test('claimWebhookEvent: primeira vez devolve true (evento novo, deve ser processado)', async () => {
  const claimed = await claimWebhookEvent(db, { eventId: 'evt-1', eventType: 'PAYMENT.CAPTURE.COMPLETED', orderNumber: 'MP-1' });
  assert.equal(claimed, true);
});

test('claimWebhookEvent: reenvio do mesmo event_id devolve false (duplicado, ignorar)', async () => {
  await claimWebhookEvent(db, { eventId: 'evt-1', eventType: 'PAYMENT.CAPTURE.COMPLETED', orderNumber: 'MP-1' });
  const claimedAgain = await claimWebhookEvent(db, { eventId: 'evt-1', eventType: 'PAYMENT.CAPTURE.COMPLETED', orderNumber: 'MP-1' });
  assert.equal(claimedAgain, false);
});

test('claimWebhookEvent: dois webhooks com o mesmo event_id em simultâneo — só um é reclamado', async () => {
  const [a, b] = await Promise.all([
    claimWebhookEvent(db, { eventId: 'evt-concurrent', eventType: 'X', orderNumber: 'MP-1' }),
    claimWebhookEvent(db, { eventId: 'evt-concurrent', eventType: 'X', orderNumber: 'MP-1' }),
  ]);
  const trueCount = [a, b].filter(Boolean).length;
  assert.equal(trueCount, 1);
});
