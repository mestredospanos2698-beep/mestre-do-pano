/**
 * Mestre do Pano — backend/src/pricing.js
 *
 * Funções PURAS de recálculo de preço/peso/portes. Nunca confiam em nada
 * que venha do browser além de SKU + quantidade + país + método — tudo o
 * resto (preço, peso, custo de envio, total) é sempre recalculado aqui a
 * partir do catálogo (products.json / shipping.json), que é a única fonte
 * de verdade no backend.
 *
 * Sem dependências de runtime (Workers/Node) — por isso é fácil de testar
 * com `node --test`.
 */

export const ERROR_CODES = {
  EMPTY_CART: 'EMPTY_CART',
  INVALID_SKU: 'INVALID_SKU',
  INVALID_QTY: 'INVALID_QTY',
  OUT_OF_STOCK: 'OUT_OF_STOCK',
  MISSING_PRODUCT_WEIGHT: 'MISSING_PRODUCT_WEIGHT',
  INVALID_COUNTRY: 'INVALID_COUNTRY',
  COUNTRY_DISABLED: 'COUNTRY_DISABLED',
  INVALID_SHIPPING_METHOD: 'INVALID_SHIPPING_METHOD',
  WEIGHT_ABOVE_LIMIT: 'WEIGHT_ABOVE_LIMIT',
};

export class QuoteError extends Error {
  constructor(code, message, details) {
    super(message || code);
    this.code = code;
    this.details = details;
  }
}

function eurosToCents(value) {
  return Math.round(value * 100);
}

/**
 * @param {Array<{sku: string, qty: number}>} items
 * @param {{country: string, method: string}} shippingSelection
 * @param {{products: Array<object>}} catalog          data/products.json
 * @param {{countries: Array<object>}} countriesConfig  data/countries.json
 * @param {{methods: Array<object>, rates: object}} shippingConfig data/shipping.json
 * @returns {{
 *   lineItems: Array<object>,
 *   subtotalCents: number,
 *   totalWeightG: number,
 *   shippingCostCents: number,
 *   totalCents: number,
 *   currency: string,
 * }}
 * @throws {QuoteError}
 */
export function computeQuote({ items, country, method }, { catalog, countriesConfig, shippingConfig }) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new QuoteError(ERROR_CODES.EMPTY_CART, 'O carrinho está vazio.');
  }

  const productsById = new Map((catalog.products || []).map((p) => [p.id, p]));

  const lineItems = [];
  let subtotalCents = 0;
  let totalWeightG = 0;

  for (const rawItem of items) {
    const sku = rawItem && rawItem.sku;
    const qty = rawItem && Number(rawItem.qty);

    if (!Number.isInteger(qty) || qty <= 0 || qty > 1000) {
      throw new QuoteError(ERROR_CODES.INVALID_QTY, `Quantidade inválida para ${sku || '(sem SKU)'}.`, { sku, qty: rawItem && rawItem.qty });
    }

    const product = productsById.get(sku);
    if (!product) {
      throw new QuoteError(ERROR_CODES.INVALID_SKU, `Produto desconhecido: ${sku}.`, { sku });
    }

    if (typeof product.stock === 'number' && qty > product.stock) {
      throw new QuoteError(ERROR_CODES.OUT_OF_STOCK, `Stock insuficiente para ${product.name}.`, { sku, requested: qty, available: product.stock });
    }

    if (typeof product.weight_g !== 'number' || product.weight_g <= 0) {
      throw new QuoteError(
        ERROR_CODES.MISSING_PRODUCT_WEIGHT,
        `WARNING: Produto "${product.name}" não possui Peso (g) válido — não é possível calcular os portes.`,
        { sku },
      );
    }

    const unitPriceCents = eurosToCents(product.price);
    const lineTotalCents = unitPriceCents * qty;
    const lineWeightG = product.weight_g * qty;

    subtotalCents += lineTotalCents;
    totalWeightG += lineWeightG;

    // unit_count (Fase 5): quantas unidades físicas há dentro de UMA unidade
    // de venda (ex.: pack de 5 panos). Nunca assumido — só existe quando o
    // catálogo trouxer um número inteiro > 0; caso contrário fica null e o
    // preço por unidade física simplesmente não é calculado/mostrado.
    const unitCount = Number.isInteger(product.unit_count) && product.unit_count > 0
      ? product.unit_count
      : null;
    const perPhysicalUnitPriceCents = (unitCount && unitCount > 1) ? Math.round(unitPriceCents / unitCount) : null;

    lineItems.push({
      sku,
      name: product.name,
      qty,
      unitPriceCents,
      lineTotalCents,
      unitWeightG: product.weight_g,
      lineWeightG,
      unitCount,
      perPhysicalUnitPriceCents,
    });
  }

  const countryEntry = (countriesConfig.countries || []).find((c) => c.code === country);
  if (!countryEntry) {
    throw new QuoteError(ERROR_CODES.INVALID_COUNTRY, `País desconhecido: ${country}.`, { country });
  }
  if (!countryEntry.enabled) {
    throw new QuoteError(ERROR_CODES.COUNTRY_DISABLED, `Ainda não entregamos em ${countryEntry.name}.`, { country });
  }

  const ratesForCountry = (shippingConfig.rates || {})[country];
  const methodEntry = (shippingConfig.methods || []).find((m) => m.id === method && m.enabled);
  if (!methodEntry || !ratesForCountry || !ratesForCountry[method]) {
    throw new QuoteError(ERROR_CODES.INVALID_SHIPPING_METHOD, `Método de entrega indisponível: ${method}.`, { method, country });
  }

  const weightKg = totalWeightG / 1000;
  const brackets = [...ratesForCountry[method]].sort((a, b) => a.maxWeight - b.maxWeight);
  const bracket = brackets.find((b) => weightKg <= b.maxWeight);
  if (!bracket) {
    throw new QuoteError(ERROR_CODES.WEIGHT_ABOVE_LIMIT, 'Peso total acima do limite disponível para este método de entrega.', { weightKg });
  }

  const shippingCostCents = bracket.price;
  const totalCents = subtotalCents + shippingCostCents;

  return {
    lineItems,
    subtotalCents,
    totalWeightG,
    shippingCostCents,
    totalCents,
    currency: shippingConfig._meta && shippingConfig._meta.currency ? shippingConfig._meta.currency : 'EUR',
  };
}
