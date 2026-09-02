/**
 * Mestre do Pano — backend/test/shipping/ctt.test.js
 *
 * Confirma que o stub dos CTT recusa EXPLICITAMENTE todas as operações
 * (nunca devolve um resultado fictício) e nunca aceita webhooks.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CTTProvider } from '../../src/shipping/providers/ctt.js';
import { ShippingProviderError, SHIPPING_ERROR_CODES } from '../../src/shipping/provider.js';

test('CTTProvider: id/name corretos', () => {
  const provider = new CTTProvider();
  assert.equal(provider.id, 'ctt');
  assert.equal(provider.name, 'CTT');
});

test('CTTProvider: isAuthConfigured é sempre false (não existem credenciais reais nesta fase)', () => {
  const provider = new CTTProvider();
  assert.equal(provider.isAuthConfigured(), false);
});

test('CTTProvider: getRates recusa explicitamente (nunca inventa tarifa)', async () => {
  const provider = new CTTProvider();
  await assert.rejects(
    () => provider.getRates({ country: 'PT', package: { weightG: 500 } }),
    (err) => err instanceof ShippingProviderError && err.code === SHIPPING_ERROR_CODES.NOT_CONFIGURED,
  );
});

test('CTTProvider: getPickupPoints recusa explicitamente', async () => {
  const provider = new CTTProvider();
  await assert.rejects(
    () => provider.getPickupPoints({ country: 'PT' }),
    (err) => err instanceof ShippingProviderError && err.code === SHIPPING_ERROR_CODES.NOT_CONFIGURED,
  );
});

test('CTTProvider: createShipment recusa explicitamente (nunca simula um envio)', async () => {
  const provider = new CTTProvider();
  await assert.rejects(
    () => provider.createShipment({ orderNumber: 'MP-1', serviceId: 'ctt_domicilio', package: { weightG: 500 } }),
    (err) => err instanceof ShippingProviderError && err.code === SHIPPING_ERROR_CODES.NOT_CONFIGURED,
  );
});

test('CTTProvider: getLabel recusa explicitamente', async () => {
  const provider = new CTTProvider();
  await assert.rejects(
    () => provider.getLabel({ shipmentId: 'x' }),
    (err) => err instanceof ShippingProviderError && err.code === SHIPPING_ERROR_CODES.NOT_CONFIGURED,
  );
});

test('CTTProvider: trackShipment recusa explicitamente (nunca inventa estado/tracking)', async () => {
  const provider = new CTTProvider();
  await assert.rejects(
    () => provider.trackShipment({ shipmentId: 'x' }),
    (err) => err instanceof ShippingProviderError && err.code === SHIPPING_ERROR_CODES.NOT_CONFIGURED,
  );
});

test('CTTProvider: cancelShipment recusa explicitamente', async () => {
  const provider = new CTTProvider();
  await assert.rejects(
    () => provider.cancelShipment({ shipmentId: 'x' }),
    (err) => err instanceof ShippingProviderError && err.code === SHIPPING_ERROR_CODES.NOT_CONFIGURED,
  );
});

test('CTTProvider: verifyWebhookSignature devolve sempre false (nenhum webhook CTT é aceite nesta fase)', async () => {
  const provider = new CTTProvider();
  const isValid = await provider.verifyWebhookSignature({ headers: new Headers(), rawBody: '{}' });
  assert.equal(isValid, false);
});

test('CTTProvider: parseWebhookEvent devolve sempre null', () => {
  const provider = new CTTProvider();
  assert.equal(provider.parseWebhookEvent({ anything: true }), null);
});
