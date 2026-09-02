/**
 * Mestre do Pano — backend/src/orders.js
 *
 * Fase 5: encomendas persistidas em Cloudflare D1 (ver schema.sql,
 * src/db.js e docs/orders.md), com:
 *   - Snapshot dos preços/pesos/unit_count no momento da compra
 *     (order_items nunca depende do catálogo atual — secção 15).
 *   - Idempotência na criação da encomenda (Idempotency-Key) e no
 *     processamento de webhooks (event id do PayPal).
 *   - Nenhuma redução de stock nesta função — isso só acontece depois da
 *     confirmação do pagamento (ver index.js, handleCapturePayPalOrder).
 */

import { computeQuote } from './pricing.js';
import {
  insertOrder,
  getOrderByNumber,
  getOrderByPaypalOrderId,
  updateOrderFields,
  findOrderByIdempotencyKey,
  saveIdempotencyKey,
  claimWebhookEvent,
  decrementStockForOrder,
  syncStockFromCatalog,
  getStock,
} from './db.js';

/** Remove dados pessoais completos antes de qualquer log (secção 28 do pedido). */
export function redactCustomerForLogs(customer) {
  if (!customer) return customer;
  return {
    name: customer.name ? `${customer.name.slice(0, 1)}***` : undefined,
    email: customer.email ? customer.email.replace(/^(.).*(@.*)$/, '$1***$2') : undefined,
    phone: customer.phone ? '***' : undefined,
  };
}

/**
 * Cria uma encomenda nova (PENDING_PAYMENT / PENDING) — ou devolve a
 * encomenda já existente se a mesma Idempotency-Key já tiver sido usada
 * (proteção contra duplo clique / retries de rede).
 *
 * NÃO decrementa stock aqui: computeQuote já rejeita quantidades acima do
 * `stock` do catálogo como verificação preliminar — a garantia real e
 * atómica contra overselling acontece em decrementStockForOrder, chamada
 * só após o pagamento confirmado.
 */
export async function createOrder(env, { customer, shipping, items }, idemKey) {
  if (idemKey) {
    const existing = await findOrderByIdempotencyKey(env.DB, idemKey);
    if (existing) return existing;
  }

  if (!customer || !customer.email || !customer.name) {
    const err = new Error('Dados do cliente incompletos.');
    err.code = 'INVALID_CUSTOMER';
    throw err;
  }
  if (!shipping || !shipping.country || !shipping.method || !shipping.address || !shipping.postalCode || !shipping.city) {
    const err = new Error('Dados de entrega incompletos.');
    err.code = 'INVALID_SHIPPING';
    throw err;
  }

  const { loadCatalog } = await import('./catalog.js');
  const { catalog, countriesConfig, shippingConfig } = await loadCatalog(env);

  // Recalcula sempre preço/peso/portes/total a partir do catálogo (nunca
  // confia em nada vindo do browser além de sku + qty — ver pricing.js).
  const quote = computeQuote(
    { items, country: shipping.country, method: shipping.method },
    { catalog, countriesConfig, shippingConfig },
  );

  const order = await insertOrder(env.DB, {
    quote,
    customer,
    shipping,
    isTest: env.PAYPAL_ENVIRONMENT !== 'live',
  });

  if (idemKey) {
    await saveIdempotencyKey(env.DB, idemKey, order.id);
  }

  return order;
}

export async function getOrder(env, orderNumber) {
  return getOrderByNumber(env.DB, orderNumber);
}

export async function getOrderByPaypal(env, paypalOrderId) {
  return getOrderByPaypalOrderId(env.DB, paypalOrderId);
}

export async function updateOrder(env, orderNumber, patch) {
  return updateOrderFields(env.DB, orderNumber, patch);
}

/**
 * Chamado exclusivamente DEPOIS de um pagamento PayPal confirmado
 * (capture COMPLETED com o valor correto — ver index.js). Reduz o stock
 * real de venda de forma atómica; se algum artigo já não tiver stock
 * suficiente (outro cliente comprou entretanto), devolve conflicts e
 * marca a encomenda com stock_conflict=1 para intervenção manual — ver
 * docs/orders.md, secção "Limitações".
 */
export async function applyStockDecrementForPaidOrder(env, order) {
  // order.items vem de rowToOrder (db.js) e usa `qty`; decrementStockForOrder
  // espera `quantity` — mapear aqui em vez de renomear o campo público da
  // encomenda (usado também pelo frontend em toPublicOrder).
  const itemsForDecrement = order.items.map((i) => ({ sku: i.sku, quantity: i.qty }));
  const result = await decrementStockForOrder(env.DB, itemsForDecrement);
  if (!result.ok) {
    await updateOrderFields(env.DB, order.orderNumber, { stock_conflict: 1 });
  }
  return result;
}

/** Mantém a tabela `stock` sincronizada a partir do catálogo publicado (products.json). */
export async function syncStockFromPublishedCatalog(env) {
  const { loadCatalog } = await import('./catalog.js');
  const { catalog } = await loadCatalog(env);
  return syncStockFromCatalog(env.DB, catalog.products || []);
}

/** Consulta rápida de stock real de venda de um SKU (usada em diagnósticos/testes). */
export async function getAvailableStock(env, sku) {
  const row = await getStock(env.DB, sku);
  return row ? row.available_stock : null;
}

/**
 * Regista que um evento de webhook (pelo seu event id único do PayPal) já
 * foi processado — usado para ignorar webhooks duplicados (o PayPal pode
 * reenviar o mesmo evento mais do que uma vez). Devolve `true` quando o
 * evento é novo e deve ser processado agora.
 */
export async function claimWebhookEventOnce(env, { eventId, eventType, orderNumber }) {
  return claimWebhookEvent(env.DB, { eventId, eventType, orderNumber });
}

/**
 * Devolve uma versão da encomenda segura para expor ao frontend — sem
 * detalhes internos desnecessários (mantém o essencial para a confirmação).
 */
export function toPublicOrder(order) {
  if (!order) return null;
  return {
    orderNumber: order.orderNumber,
    status: order.status,
    paymentStatus: order.paymentStatus,
    currency: order.currency,
    subtotal: order.subtotal,
    shippingCost: order.shippingCost,
    total: order.total,
    totalWeightG: order.totalWeightG,
    items: order.items.map((i) => ({
      sku: i.sku,
      name: i.name,
      qty: i.qty,
      unitPriceCents: i.unitPriceCents,
      unitCount: i.unitCount,
      lineTotalCents: i.lineTotalCents,
    })),
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
}
