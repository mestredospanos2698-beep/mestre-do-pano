/**
 * Mestre do Pano — backend/test/shipping/inpost.test.js
 *
 * Testa InPostProvider com um `fetchImpl` mockado — sem rede, sem
 * credenciais reais. Cobre exatamente o que foi confirmado/decidido em
 * backend/src/shipping/providers/inpost.js (ver comentário no topo desse
 * ficheiro para o que foi validado por chamada HTTP direta nesta fase).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InPostProvider } from '../../src/shipping/providers/inpost.js';
import { ShippingProviderError, SHIPPING_ERROR_CODES } from '../../src/shipping/provider.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

test('InPostProvider: id/name/baseUrl corretos por ambiente', () => {
  const sandbox = new InPostProvider({ environment: 'sandbox' });
  assert.equal(sandbox.id, 'inpost');
  assert.equal(sandbox.baseUrl, 'https://sandbox-api-shipx-pl.easypack24.net');

  const production = new InPostProvider({ environment: 'production' });
  assert.equal(production.baseUrl, 'https://api-shipx-pl.easypack24.net');
});

test('InPostProvider: environment desconhecido cai para sandbox (nunca produção por omissão)', () => {
  const provider = new InPostProvider({ environment: 'qualquer-coisa' });
  assert.equal(provider.environment, 'sandbox');
});

test('InPostProvider: getPickupPoints funciona sem token (endpoint público confirmado) para PL', async () => {
  const fetchImpl = async (url) => {
    assert.match(String(url), /\/v1\/points\?/);
    return jsonResponse({
      items: [
        { name: '60000', address: { line1: 'street 1/1', line2: '00000 town' }, address_details: { city: 'town', post_code: '00000' } },
      ],
    });
  };
  const provider = new InPostProvider({ environment: 'sandbox', fetchImpl });
  const points = await provider.getPickupPoints({ country: 'PL', postalCode: '00000' });
  assert.equal(points.length, 1);
  assert.equal(points[0].id, '60000');
  assert.equal(points[0].address.city, 'town');
});

test('InPostProvider: getPickupPoints rejeita países não confirmados (nunca inventa cobertura)', async () => {
  const provider = new InPostProvider({ environment: 'sandbox', fetchImpl: async () => { throw new Error('não deveria chamar fetch'); } });
  await assert.rejects(
    () => provider.getPickupPoints({ country: 'PT' }),
    (err) => err instanceof ShippingProviderError && err.code === SHIPPING_ERROR_CODES.COUNTRY_NOT_SUPPORTED,
  );
});

test('InPostProvider: getRates exige autenticação configurada (nunca inventa preço)', async () => {
  const provider = new InPostProvider({ environment: 'sandbox' }); // sem token
  await assert.rejects(
    () => provider.getRates({ country: 'PL', package: { weightG: 500 } }),
    (err) => err instanceof ShippingProviderError && err.code === SHIPPING_ERROR_CODES.NOT_CONFIGURED,
  );
});

test('InPostProvider: getRates com autenticação configurada ainda recusa (não validado nesta fase) sem simular preço', async () => {
  const provider = new InPostProvider({ environment: 'sandbox', apiToken: 'tok', organizationId: 'org-1' });
  await assert.rejects(
    () => provider.getRates({ country: 'PL', package: { weightG: 500 } }),
    (err) => err instanceof ShippingProviderError && err.code === SHIPPING_ERROR_CODES.NOT_SUPPORTED,
  );
});

test('InPostProvider: createShipment exige autenticação configurada', async () => {
  const provider = new InPostProvider({ environment: 'sandbox' });
  await assert.rejects(
    () => provider.createShipment({ orderNumber: 'MP-1', serviceId: 'inpost_locker', package: { weightG: 500 }, pickupPointId: 'AAA666' }),
    (err) => err instanceof ShippingProviderError && err.code === SHIPPING_ERROR_CODES.NOT_CONFIGURED,
  );
});

test('InPostProvider: createShipment sem peso é rejeitado (nunca inventa dimensões/peso)', async () => {
  const provider = new InPostProvider({ environment: 'sandbox', apiToken: 'tok', organizationId: 'org-1' });
  await assert.rejects(
    () => provider.createShipment({ orderNumber: 'MP-1', serviceId: 'inpost_locker', package: { weightG: 0 }, pickupPointId: 'AAA666' }),
    (err) => err instanceof ShippingProviderError && err.code === SHIPPING_ERROR_CODES.MISSING_PACKAGE_DIMENSIONS,
  );
});

test('InPostProvider: createShipment para inpost_locker sem pickupPointId é rejeitado', async () => {
  const provider = new InPostProvider({ environment: 'sandbox', apiToken: 'tok', organizationId: 'org-1' });
  await assert.rejects(
    () => provider.createShipment({ orderNumber: 'MP-1', serviceId: 'inpost_locker', package: { weightG: 500 } }),
    (err) => err instanceof ShippingProviderError && err.code === SHIPPING_ERROR_CODES.PICKUP_POINT_REQUIRED,
  );
});

test('InPostProvider: createShipment com auth+peso+ponto envia o payload esperado e devolve shipmentId/tracking', async () => {
  let capturedUrl;
  let capturedBody;
  const fetchImpl = async (url, opts) => {
    capturedUrl = String(url);
    capturedBody = JSON.parse(opts.body);
    return jsonResponse({ id: 999, tracking_number: 'TRACK123' }, 201);
  };
  const provider = new InPostProvider({ environment: 'sandbox', apiToken: 'tok', organizationId: 'org-1', fetchImpl });

  const result = await provider.createShipment({
    orderNumber: 'MP-20260101-ABC123',
    serviceId: 'inpost_locker',
    customer: { email: 'ana@example.com', phone: '912345678', firstName: 'Ana', lastName: 'Silva' },
    package: { weightG: 500 },
    pickupPointId: 'AAA666',
  });

  assert.match(capturedUrl, /\/v1\/organizations\/org-1\/shipments$/);
  assert.equal(capturedBody.reference, 'MP-20260101-ABC123');
  assert.equal(capturedBody.target_point, 'AAA666');
  assert.equal(capturedBody.parcels[0].weight.amount, 0.5);
  assert.equal(result.shipmentId, '999');
  assert.equal(result.trackingNumber, 'TRACK123');
});

test('InPostProvider: createShipment traduz erro HTTP da API em ShippingProviderError (erro da API)', async () => {
  const fetchImpl = async () => jsonResponse({ message: 'invalid parcel' }, 422);
  const provider = new InPostProvider({ environment: 'sandbox', apiToken: 'tok', organizationId: 'org-1', fetchImpl });

  await assert.rejects(
    () => provider.createShipment({ orderNumber: 'MP-1', serviceId: 'inpost_locker', package: { weightG: 500 }, pickupPointId: 'AAA666' }),
    (err) => err instanceof ShippingProviderError && err.code === SHIPPING_ERROR_CODES.PROVIDER_REQUEST_FAILED && /invalid parcel/.test(err.message),
  );
});

test('InPostProvider: createShipment traduz falha de rede em ShippingProviderError', async () => {
  const fetchImpl = async () => { throw new TypeError('network down'); };
  const provider = new InPostProvider({ environment: 'sandbox', apiToken: 'tok', organizationId: 'org-1', fetchImpl });

  await assert.rejects(
    () => provider.createShipment({ orderNumber: 'MP-1', serviceId: 'inpost_locker', package: { weightG: 500 }, pickupPointId: 'AAA666' }),
    (err) => err instanceof ShippingProviderError && err.code === SHIPPING_ERROR_CODES.PROVIDER_REQUEST_FAILED,
  );
});

test('InPostProvider: trackShipment mapeia status documentados para o vocabulário interno', async () => {
  const fetchImpl = async () => jsonResponse({ status: 'delivered', tracking_details: [] });
  const provider = new InPostProvider({ environment: 'sandbox', apiToken: 'tok', organizationId: 'org-1', fetchImpl });

  const result = await provider.trackShipment({ shipmentId: '999' });
  assert.equal(result.status, 'DELIVERED');
  assert.equal(result.providerStatus, 'delivered');
});

test('InPostProvider: trackShipment com status desconhecido não inventa equivalência (devolve como está)', async () => {
  const fetchImpl = async () => jsonResponse({ status: 'algo_novo_da_api', tracking_details: [] });
  const provider = new InPostProvider({ environment: 'sandbox', apiToken: 'tok', organizationId: 'org-1', fetchImpl });

  const result = await provider.trackShipment({ shipmentId: '999' });
  assert.equal(result.status, 'algo_novo_da_api');
});

test('InPostProvider: cancelShipment chama o endpoint de cancelamento e devolve cancelled:true', async () => {
  let calledPath;
  const fetchImpl = async (url) => { calledPath = String(url); return jsonResponse({}); };
  const provider = new InPostProvider({ environment: 'sandbox', apiToken: 'tok', organizationId: 'org-1', fetchImpl });

  const result = await provider.cancelShipment({ shipmentId: '999' });
  assert.equal(result.cancelled, true);
  assert.match(calledPath, /\/v1\/shipments\/999\/cancel$/);
});

test('InPostProvider: verifyWebhookSignature devolve sempre false (mecanismo não confirmado nesta fase)', async () => {
  const provider = new InPostProvider({ environment: 'sandbox', apiToken: 'tok', organizationId: 'org-1' });
  const isValid = await provider.verifyWebhookSignature({ headers: new Headers(), rawBody: '{}' });
  assert.equal(isValid, false);
});

test('InPostProvider: parseWebhookEvent extrai shipmentId/status/orderNumber de um payload plausível', () => {
  const provider = new InPostProvider({ environment: 'sandbox' });
  const parsed = provider.parseWebhookEvent({ payload: { id: 999, status: 'delivered', reference: 'MP-1' } });
  assert.deepEqual(parsed, { shipmentId: '999', status: 'DELIVERED', orderNumber: 'MP-1' });
});
