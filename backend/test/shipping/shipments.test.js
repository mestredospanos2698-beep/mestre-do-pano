/**
 * Mestre do Pano — backend/test/shipping/shipments.test.js
 *
 * Testa backend/src/shipping/shipments.js e registry.js com o adaptador
 * D1-sobre-node:sqlite (test/d1-sqlite-adapter.js) e providers reais
 * (InPost com fetch mockado; CTT como stub) — sem rede.
 *
 * Cobre: peso (agregação a partir de order_items), idempotência da
 * criação de envio, proteção contra criar envio sem pagamento
 * confirmado, ausência de dimensões nunca inventadas, e o registry
 * (SHIPPING_ENVIRONMENT nunca assume produção por omissão).
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from '../d1-sqlite-adapter.js';
import { insertOrder, updateOrderFields } from '../../src/db.js';
import {
  buildPackageFromOrder,
  createShipmentForOrder,
  getRatesSafely,
  getPickupPointsSafely,
} from '../../src/shipping/shipments.js';
import { getShippingProvider, listShippingProviders, resolveEnvironment } from '../../src/shipping/registry.js';
import { ShippingProviderError, SHIPPING_ERROR_CODES } from '../../src/shipping/provider.js';

let db;

beforeEach(() => {
  db = createTestDb();
});

function baseQuote(totalWeightG = 1000) {
  return {
    lineItems: [
      { sku: 'PAN001', name: 'Pano Amores', qty: 2, unitPriceCents: 499, unitWeightG: 500, unitCount: 1, lineTotalCents: 998, lineWeightG: totalWeightG },
    ],
    subtotalCents: 998,
    shippingCostCents: 500,
    totalCents: 1498,
    totalWeightG,
    currency: 'EUR',
  };
}

function baseCustomer() {
  return { name: 'Ana Silva', email: 'ana@example.com', phone: '912345678' };
}

function baseShipping() {
  return { country: 'PT', method: 'ctt', address: 'Rua X, 1', postalCode: '1000-001', city: 'Lisboa' };
}

async function createPaidOrder(totalWeightG = 1000) {
  const order = await insertOrder(db, { quote: baseQuote(totalWeightG), customer: baseCustomer(), shipping: baseShipping(), isTest: true });
  return updateOrderFields(db, order.orderNumber, { status: 'PAID', payment_status: 'COMPLETED' });
}

function fakeEnv(overrides = {}) {
  return { DB: db, SHIPPING_ENVIRONMENT: 'sandbox', ...overrides };
}

// ---------------------------------------------------------------------------
// Peso (secção 18 do pedido: "peso total correto")
// ---------------------------------------------------------------------------

test('buildPackageFromOrder: usa o peso total já calculado (produto x quantidade) e nunca inventa dimensões', async () => {
  const order = await createPaidOrder(1230);
  const pkg = buildPackageFromOrder(order);
  assert.equal(pkg.weightG, 1230);
  assert.equal(pkg.lengthMm, null);
  assert.equal(pkg.widthMm, null);
  assert.equal(pkg.heightMm, null);
  assert.equal(pkg.numberOfPackages, 1);
});

test('buildPackageFromOrder: várias quantidades diferentes refletem-se no peso total da encomenda', async () => {
  const order5 = await createPaidOrder(500 * 5);
  const order12 = await createPaidOrder(500 * 12);
  assert.equal(buildPackageFromOrder(order5).weightG, 2500);
  assert.equal(buildPackageFromOrder(order12).weightG, 6000);
});

// ---------------------------------------------------------------------------
// Registry — SHIPPING_ENVIRONMENT explícito, nunca produção por omissão
// ---------------------------------------------------------------------------

test('registry: SHIPPING_ENVIRONMENT em falta ou desconhecido nunca assume produção', () => {
  assert.equal(resolveEnvironment({}), 'sandbox');
  assert.equal(resolveEnvironment({ SHIPPING_ENVIRONMENT: 'qualquer-coisa' }), 'sandbox');
  assert.equal(resolveEnvironment({ SHIPPING_ENVIRONMENT: 'production' }), 'production');
});

test('registry: getShippingProvider devolve inpost e ctt; provider desconhecido lança NOT_SUPPORTED', () => {
  const env = fakeEnv();
  assert.equal(getShippingProvider(env, 'inpost').id, 'inpost');
  assert.equal(getShippingProvider(env, 'ctt').id, 'ctt');
  assert.throws(
    () => getShippingProvider(env, 'dhl'),
    (err) => err instanceof ShippingProviderError && err.code === SHIPPING_ERROR_CODES.NOT_SUPPORTED,
  );
});

test('registry: listShippingProviders devolve ambas as transportadoras conhecidas pela arquitetura', () => {
  const providers = listShippingProviders(fakeEnv());
  const ids = providers.map((p) => p.id).sort();
  assert.deepEqual(ids, ['ctt', 'inpost']);
});

// ---------------------------------------------------------------------------
// getRatesSafely / getPickupPointsSafely — nunca deixam o erro do provider
// rebentar (checkout: "método inválido" / "país não suportado")
// ---------------------------------------------------------------------------

test('getRatesSafely: CTT sem configuração devolve available:false com o motivo, nunca lança', async () => {
  const result = await getRatesSafely(fakeEnv(), 'ctt', { country: 'PT', package: { weightG: 500 } });
  assert.equal(result.available, false);
  assert.equal(result.reason, SHIPPING_ERROR_CODES.NOT_CONFIGURED);
});

test('getRatesSafely: provider desconhecido no checkout (método inválido) devolve available:false em vez de rebentar', async () => {
  const result = await getRatesSafely(fakeEnv(), 'metodo-voador', { country: 'PT', package: { weightG: 500 } });
  assert.equal(result.available, false);
  assert.equal(result.reason, SHIPPING_ERROR_CODES.NOT_SUPPORTED);
});

test('getPickupPointsSafely: país não suportado pela InPost (fora de PL) devolve available:false documentado', async () => {
  const result = await getPickupPointsSafely(fakeEnv(), 'inpost', { country: 'PT' });
  assert.equal(result.available, false);
  assert.equal(result.reason, SHIPPING_ERROR_CODES.COUNTRY_NOT_SUPPORTED);
});

// ---------------------------------------------------------------------------
// createShipmentForOrder — pagamento confirmado obrigatório + idempotência
// ---------------------------------------------------------------------------

test('createShipmentForOrder: recusa criar envio se o pagamento não estiver COMPLETED', async () => {
  const order = await insertOrder(db, { quote: baseQuote(), customer: baseCustomer(), shipping: baseShipping(), isTest: true });
  // status ainda PENDING_PAYMENT / PENDING (não confirmado)
  await assert.rejects(
    () => createShipmentForOrder(fakeEnv(), order, { providerId: 'inpost', serviceId: 'inpost_locker', pickupPointId: 'AAA666' }),
    (err) => err instanceof ShippingProviderError,
  );
});

test('createShipmentForOrder: CTT (stub) recusa mesmo com pagamento confirmado — nunca simula um envio', async () => {
  const order = await createPaidOrder();
  await assert.rejects(
    () => createShipmentForOrder(fakeEnv(), order, { providerId: 'ctt', serviceId: 'ctt_domicilio' }),
    (err) => err instanceof ShippingProviderError && err.code === SHIPPING_ERROR_CODES.NOT_CONFIGURED,
  );
});

test('createShipmentForOrder: InPost sem pickupPointId para inpost_locker é rejeitado (ponto de recolha obrigatório mas não selecionado)', async () => {
  const order = await createPaidOrder();
  const env = fakeEnv({ INPOST_API_TOKEN: 'tok', INPOST_ORGANIZATION_ID: 'org-1' });
  await assert.rejects(
    () => createShipmentForOrder(env, order, { providerId: 'inpost', serviceId: 'inpost_locker' }),
    (err) => err instanceof ShippingProviderError && err.code === SHIPPING_ERROR_CODES.PICKUP_POINT_REQUIRED,
  );
});

test('createShipmentForOrder: com fetch mockado, cria o envio e é idempotente numa segunda chamada', async () => {
  let calls = 0;
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    calls += 1;
    return new Response(JSON.stringify({ id: 555, tracking_number: 'TRACK555' }), { status: 201 });
  };
  try {
    const order = await createPaidOrder();
    const env = fakeEnv({ INPOST_API_TOKEN: 'tok', INPOST_ORGANIZATION_ID: 'org-1' });

    const first = await createShipmentForOrder(env, order, { providerId: 'inpost', serviceId: 'inpost_locker', pickupPointId: 'AAA666' });
    assert.equal(first.created, true);
    assert.equal(first.shipment.shipmentId, '555');
    assert.equal(calls, 1);

    // Segunda chamada para a MESMA encomenda + provider: não deve criar
    // outro envio nem chamar a transportadora outra vez (idempotência —
    // secção 15 do pedido da Fase 6).
    const second = await createShipmentForOrder(env, order, { providerId: 'inpost', serviceId: 'inpost_locker', pickupPointId: 'AAA666' });
    assert.equal(second.created, false);
    assert.equal(second.shipment.id, first.shipment.id);
    assert.equal(calls, 1, 'a transportadora não deve ser chamada uma segunda vez');
  } finally {
    global.fetch = originalFetch;
  }
});

test('createShipmentForOrder: erro da API InPost (ex.: peso rejeitado) propaga-se como ShippingProviderError sem criar shipment local', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({ message: 'invalid parcel weight' }), { status: 422 });
  try {
    const order = await createPaidOrder();
    const env = fakeEnv({ INPOST_API_TOKEN: 'tok', INPOST_ORGANIZATION_ID: 'org-1' });
    await assert.rejects(
      () => createShipmentForOrder(env, order, { providerId: 'inpost', serviceId: 'inpost_locker', pickupPointId: 'AAA666' }),
      (err) => err instanceof ShippingProviderError && err.code === SHIPPING_ERROR_CODES.PROVIDER_REQUEST_FAILED,
    );
  } finally {
    global.fetch = originalFetch;
  }
});
