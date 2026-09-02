import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeQuote, QuoteError, ERROR_CODES } from '../src/pricing.js';

const catalog = {
  products: [
    { id: 'PAN001', name: 'Pano Amores', price: 4.99, stock: 50, weight_g: 82, unit_count: 1 },
    { id: 'PAN002', name: 'Pano Sem Peso', price: 9.99, stock: 10, weight_g: null, unit_count: 1 },
    { id: 'PAN003', name: 'Pano Caro', price: 120.0, stock: 1, weight_g: 5000, unit_count: 1 },
    { id: 'PACK005', name: 'Pack de panos', price: 12.0, stock: 20, weight_g: 500, unit_count: 5 },
    { id: 'PACK010', name: 'Pack grande', price: 24.9, stock: 20, weight_g: 300, unit_count: 10 },
    { id: 'PACKINV', name: 'Pack sem unidades definidas', price: 20.0, stock: 20, weight_g: 600, unit_count: null },
  ],
};

const countriesConfig = {
  countries: [
    { code: 'PT', name: 'Portugal', enabled: true },
    { code: 'PL', name: 'Polónia', enabled: false },
  ],
};

const shippingConfig = {
  _meta: { currency: 'EUR' },
  methods: [
    { id: 'ctt', name: 'CTT', enabled: true },
    { id: 'inpost', name: 'InPost', enabled: true },
  ],
  rates: {
    PT: {
      ctt: [
        { maxWeight: 0.5, price: 476 },
        { maxWeight: 1, price: 542 },
        { maxWeight: 2, price: 589 },
      ],
      inpost: [
        { maxWeight: 0.5, price: 349 },
      ],
    },
  },
};

function ctx() {
  return { catalog, countriesConfig, shippingConfig };
}

test('peso: calcula corretamente para várias unidades de um produto', () => {
  const result = computeQuote({ items: [{ sku: 'PAN001', qty: 3 }], country: 'PT', method: 'ctt' }, ctx());
  assert.equal(result.totalWeightG, 246); // 82 * 3
});

test('peso: soma corretamente vários produtos diferentes', () => {
  // PAN001 (82g) x2 + PAN003 (5000g) x0 não aplicável — usar dois produtos
  // cujo peso combinado ainda cabe num escalão de portes disponível.
  const result = computeQuote(
    { items: [{ sku: 'PAN001', qty: 3 }, { sku: 'PAN001', qty: 2 }], country: 'PT', method: 'ctt' },
    ctx(),
  );
  assert.equal(result.totalWeightG, 82 * 3 + 82 * 2);
});

test('peso: produto sem weight_g bloqueia o cálculo com o código correto', () => {
  assert.throws(
    () => computeQuote({ items: [{ sku: 'PAN002', qty: 1 }], country: 'PT', method: 'ctt' }, ctx()),
    (err) => err instanceof QuoteError && err.code === ERROR_CODES.MISSING_PRODUCT_WEIGHT,
  );
});

test('peso: peso total correto determina o escalão de portes certo', () => {
  const result = computeQuote({ items: [{ sku: 'PAN001', qty: 1 }], country: 'PT', method: 'ctt' }, ctx());
  assert.equal(result.totalWeightG, 82);
  assert.equal(result.shippingCostCents, 476); // <= 0.5kg bracket
});

test('checkout: SKU inválido é rejeitado', () => {
  assert.throws(
    () => computeQuote({ items: [{ sku: 'INEXISTENTE', qty: 1 }], country: 'PT', method: 'ctt' }, ctx()),
    (err) => err instanceof QuoteError && err.code === ERROR_CODES.INVALID_SKU,
  );
});

test('checkout: quantidade inválida (zero) é rejeitada', () => {
  assert.throws(
    () => computeQuote({ items: [{ sku: 'PAN001', qty: 0 }], country: 'PT', method: 'ctt' }, ctx()),
    (err) => err instanceof QuoteError && err.code === ERROR_CODES.INVALID_QTY,
  );
});

test('checkout: quantidade inválida (negativa) é rejeitada', () => {
  assert.throws(
    () => computeQuote({ items: [{ sku: 'PAN001', qty: -5 }], country: 'PT', method: 'ctt' }, ctx()),
    (err) => err instanceof QuoteError && err.code === ERROR_CODES.INVALID_QTY,
  );
});

test('checkout: país inválido é rejeitado', () => {
  assert.throws(
    () => computeQuote({ items: [{ sku: 'PAN001', qty: 1 }], country: 'XX', method: 'ctt' }, ctx()),
    (err) => err instanceof QuoteError && err.code === ERROR_CODES.INVALID_COUNTRY,
  );
});

test('checkout: país desativado é rejeitado', () => {
  assert.throws(
    () => computeQuote({ items: [{ sku: 'PAN001', qty: 1 }], country: 'PL', method: 'ctt' }, ctx()),
    (err) => err instanceof QuoteError && err.code === ERROR_CODES.COUNTRY_DISABLED,
  );
});

test('checkout: método de entrega inválido é rejeitado', () => {
  assert.throws(
    () => computeQuote({ items: [{ sku: 'PAN001', qty: 1 }], country: 'PT', method: 'voador' }, ctx()),
    (err) => err instanceof QuoteError && err.code === ERROR_CODES.INVALID_SHIPPING_METHOD,
  );
});

test('checkout: carrinho vazio é rejeitado', () => {
  assert.throws(
    () => computeQuote({ items: [], country: 'PT', method: 'ctt' }, ctx()),
    (err) => err instanceof QuoteError && err.code === ERROR_CODES.EMPTY_CART,
  );
});

test('segurança: preço enviado pelo frontend é ignorado — backend usa sempre o do catálogo', () => {
  // O frontend nunca deveria enviar "price", mas mesmo que envie, a função
  // só lê "sku" e "qty" do item — qualquer "price" injetado é ignorado.
  const result = computeQuote(
    { items: [{ sku: 'PAN001', qty: 1, price: 0.01 }], country: 'PT', method: 'ctt' },
    ctx(),
  );
  assert.equal(result.lineItems[0].unitPriceCents, 499); // preço real do catálogo (4.99€), não 0.01€
});

test('segurança: subtotal/portes/total enviados pelo frontend são irrelevantes — só o output importa', () => {
  const result = computeQuote(
    { items: [{ sku: 'PAN001', qty: 2, subtotal: 1, shippingCost: 1, total: 2 }], country: 'PT', method: 'ctt' },
    ctx(),
  );
  assert.equal(result.subtotalCents, 998); // 4.99 * 2 = 9.98€ = 998 cents
  assert.equal(result.totalCents, 998 + result.shippingCostCents);
});

test('segurança: quantidade manipulada acima do stock é rejeitada', () => {
  assert.throws(
    () => computeQuote({ items: [{ sku: 'PAN003', qty: 99 }], country: 'PT', method: 'inpost' }, ctx()),
    (err) => err instanceof QuoteError && err.code === ERROR_CODES.OUT_OF_STOCK,
  );
});

test('portes: peso acima do limite máximo disponível é rejeitado', () => {
  assert.throws(
    () => computeQuote({ items: [{ sku: 'PAN003', qty: 1 }], country: 'PT', method: 'ctt' }, ctx()),
    (err) => err instanceof QuoteError && err.code === ERROR_CODES.WEIGHT_ABOVE_LIMIT,
  );
});

test('total: subtotal + portes = total (cêntimos inteiros, sem floating point)', () => {
  const result = computeQuote(
    { items: [{ sku: 'PAN001', qty: 5 }], country: 'PT', method: 'ctt' },
    ctx(),
  );
  assert.equal(Number.isInteger(result.subtotalCents), true);
  assert.equal(Number.isInteger(result.shippingCostCents), true);
  assert.equal(result.totalCents, result.subtotalCents + result.shippingCostCents);
});

// ---- Preço por unidade (Fase 5) --------------------------------------------

test('preço por unidade: €12,00 / 5 unidades = €2,40/unidade', () => {
  const result = computeQuote({ items: [{ sku: 'PACK005', qty: 1 }], country: 'PT', method: 'ctt' }, ctx());
  assert.equal(result.lineItems[0].unitCount, 5);
  assert.equal(result.lineItems[0].perPhysicalUnitPriceCents, 240);
});

test('preço por unidade: €24,90 / 10 unidades = €2,49/unidade', () => {
  const result = computeQuote({ items: [{ sku: 'PACK010', qty: 1 }], country: 'PT', method: 'ctt' }, ctx());
  assert.equal(result.lineItems[0].unitCount, 10);
  assert.equal(result.lineItems[0].perPhysicalUnitPriceCents, 249);
});

test('preço por unidade: unit_count = 1 não gera preço por unidade (null)', () => {
  const result = computeQuote({ items: [{ sku: 'PAN001', qty: 1 }], country: 'PT', method: 'ctt' }, ctx());
  assert.equal(result.lineItems[0].unitCount, 1);
  assert.equal(result.lineItems[0].perPhysicalUnitPriceCents, null);
});

test('preço por unidade: unit_count em falta/inválido no catálogo não inventa valor', () => {
  const result = computeQuote({ items: [{ sku: 'PACKINV', qty: 1 }], country: 'PT', method: 'ctt' }, ctx());
  assert.equal(result.lineItems[0].unitCount, null);
  assert.equal(result.lineItems[0].perPhysicalUnitPriceCents, null);
});

test('preço por unidade: quantity comprada nunca é confundida com unit_count', () => {
  // Cliente compra 3 packs de 10 unidades cada => 30 unidades físicas,
  // mas unitCount do line item continua a ser 10 (unidades por pack).
  const result = computeQuote({ items: [{ sku: 'PACK010', qty: 3 }], country: 'PT', method: 'ctt' }, ctx());
  const item = result.lineItems[0];
  assert.equal(item.qty, 3);
  assert.equal(item.unitCount, 10);
  assert.equal(item.lineTotalCents, 2490 * 3);
});
