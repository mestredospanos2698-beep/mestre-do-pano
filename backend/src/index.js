/**
 * Mestre do Pano — backend/src/index.js
 * Fase 5 — backend serverless (Cloudflare Workers) + base de dados (D1).
 *
 * Responsabilidades deste backend (e só deste backend):
 *   - Recalcular sempre preço/peso/portes/total a partir do catálogo
 *     publicado (nunca confiar em valores vindos do browser).
 *   - Criar e capturar pagamentos PayPal Sandbox.
 *   - Validar webhooks do PayPal antes de confiar neles (idempotente).
 *   - Guardar o estado real da encomenda em D1 (o frontend só lê este
 *     estado, nunca o define) — ver docs/orders.md.
 *   - Reduzir o stock real de venda de forma atómica, só depois do
 *     pagamento confirmado, protegendo contra overselling.
 *
 * Nenhum secret está neste ficheiro — todos vêm de `env` (variáveis de
 * ambiente / secrets do Worker, configuradas com `wrangler secret put`).
 */

import { QuoteError } from './pricing.js';
import {
  createOrder,
  getOrder,
  updateOrder,
  toPublicOrder,
  redactCustomerForLogs,
  applyStockDecrementForPaidOrder,
  syncStockFromPublishedCatalog,
  claimWebhookEventOnce,
} from './orders.js';
import { createPayPalOrder, capturePayPalOrder, extractCapturedAmountCents, verifyWebhookSignature } from './paypal.js';
import { corsHeaders, json } from './cors.js';
import {
  getRatesSafely,
  getPickupPointsSafely,
  createShipmentForOrder,
  getShipmentLabel,
  refreshShipmentTracking,
  cancelShipment,
  applyShipmentWebhookEvent,
} from './shipping/shipments.js';
import { getShippingProvider, listShippingProviders } from './shipping/registry.js';
import { getShipmentByOrderId } from './db.js';
import { ShippingProviderError } from './shipping/provider.js';

const QUOTE_ERROR_STATUS = 400;

async function readJson(request) {
  try {
    return await request.json();
  } catch (e) {
    return null;
  }
}

async function handleCreateOrder(request, env) {
  const body = await readJson(request);
  if (!body) return json({ error: 'JSON inválido.' }, { status: 400 });

  const idemKey = request.headers.get('Idempotency-Key');

  try {
    const order = await createOrder(env, body, idemKey);
    console.log('order.created', { orderNumber: order.orderNumber, customer: redactCustomerForLogs(order.customer) });
    return json({
      orderNumber: order.orderNumber,
      status: order.status,
      paymentStatus: order.paymentStatus,
      currency: order.currency,
      subtotal: order.subtotal,
      shippingCost: order.shippingCost,
      total: order.total,
      totalWeightG: order.totalWeightG,
    }, { status: 201 });
  } catch (err) {
    if (err instanceof QuoteError) {
      return json({ error: err.message, code: err.code }, { status: QUOTE_ERROR_STATUS });
    }
    console.error('order.create.error', err.message);
    return json({ error: 'Não foi possível criar a encomenda.' }, { status: 400 });
  }
}

async function handleGetOrder(orderNumber, env) {
  const order = await getOrder(env, orderNumber);
  if (!order) return json({ error: 'Encomenda não encontrada.' }, { status: 404 });
  return json(toPublicOrder(order));
}

async function handleCreatePayPalOrder(request, env) {
  const body = await readJson(request);
  if (!body || !body.orderNumber) return json({ error: 'orderNumber em falta.' }, { status: 400 });

  const order = await getOrder(env, body.orderNumber);
  if (!order) return json({ error: 'Encomenda não encontrada.' }, { status: 404 });
  if (order.status !== 'PENDING_PAYMENT') {
    return json({ error: `Encomenda já está em estado ${order.status}.` }, { status: 409 });
  }

  try {
    const paypalOrder = await createPayPalOrder(env, { orderId: order.orderNumber, total: order.total, currency: order.currency });
    await updateOrder(env, order.orderNumber, { paypal_order_id: paypalOrder.id });
    return json({ paypalOrderId: paypalOrder.id });
  } catch (err) {
    console.error('paypal.create.error', err.message);
    return json({ error: 'Não foi possível iniciar o pagamento PayPal.' }, { status: 502 });
  }
}

async function handleCapturePayPalOrder(request, env) {
  const body = await readJson(request);
  if (!body || !body.orderNumber || !body.paypalOrderId) {
    return json({ error: 'orderNumber e paypalOrderId são obrigatórios.' }, { status: 400 });
  }

  const order = await getOrder(env, body.orderNumber);
  if (!order) return json({ error: 'Encomenda não encontrada.' }, { status: 404 });

  // Idempotência: se já foi capturada/paga, devolve o estado atual sem
  // tentar capturar outra vez (evita pagamentos duplicados em duplo clique).
  if (order.paymentStatus === 'COMPLETED') {
    return json({ status: order.status, paymentStatus: order.paymentStatus, orderNumber: order.orderNumber, total: order.total, currency: order.currency });
  }

  if (order.paypalOrderId !== body.paypalOrderId) {
    return json({ error: 'paypalOrderId não corresponde à encomenda.' }, { status: 400 });
  }

  try {
    const captureResult = await capturePayPalOrder(env, body.paypalOrderId);

    if (!captureResult.ok || captureResult.status !== 'COMPLETED') {
      await updateOrder(env, order.orderNumber, { payment_status: 'FAILED' });
      return json({ status: order.status, paymentStatus: 'FAILED', orderNumber: order.orderNumber }, { status: 402 });
    }

    // Nunca confiar apenas em "status: COMPLETED" — confirmar que o valor
    // capturado é exatamente o valor calculado pelo backend para esta encomenda.
    const captured = extractCapturedAmountCents(captureResult);
    if (!captured || captured.cents !== order.total || captured.currency !== order.currency) {
      console.error('paypal.capture.amount_mismatch', { orderNumber: order.orderNumber, expected: order.total, captured });
      await updateOrder(env, order.orderNumber, { payment_status: 'FAILED' });
      return json({ status: order.status, paymentStatus: 'FAILED', orderNumber: order.orderNumber, error: 'Valor capturado não corresponde ao esperado.' }, { status: 402 });
    }

    const captureId = (captureResult.raw && captureResult.raw.purchase_units
      && captureResult.raw.purchase_units[0].payments.captures[0].id) || null;

    // Pagamento confirmado => marcar PAID/COMPLETED e só agora reduzir o
    // stock real de venda, de forma atómica (protege contra overselling).
    let updated = await updateOrder(env, order.orderNumber, {
      status: 'PAID',
      payment_status: 'COMPLETED',
      paypal_capture_id: captureId,
    });

    const stockResult = await applyStockDecrementForPaidOrder(env, updated);
    if (!stockResult.ok) {
      // Caso raro: o pagamento foi confirmado mas entretanto o stock
      // esgotou para 1+ artigo (dois clientes a comprar as últimas
      // unidades ao mesmo tempo). Não há reembolso automático nesta fase
      // — ver docs/orders.md, secção "Limitações". A encomenda fica
      // marcada para intervenção manual.
      console.error('order.stock_conflict', { orderNumber: order.orderNumber, conflicts: stockResult.conflicts });
    }
    updated = await updateOrder(env, order.orderNumber, { status: 'PROCESSING' });

    return json({
      status: updated.status,
      paymentStatus: updated.paymentStatus,
      orderNumber: updated.orderNumber,
      total: updated.total,
      currency: updated.currency,
      stockConflict: !stockResult.ok,
    });
  } catch (err) {
    console.error('paypal.capture.error', err.message);
    await updateOrder(env, order.orderNumber, { payment_status: 'FAILED' });
    return json({ status: order.status, paymentStatus: 'FAILED', orderNumber: order.orderNumber }, { status: 502 });
  }
}

async function handlePayPalWebhook(request, env) {
  const rawBody = await request.text();
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch (e) {
    return json({ error: 'JSON inválido.' }, { status: 400 });
  }

  const isValid = await verifyWebhookSignature(env, { headers: request.headers, body });
  if (!isValid) {
    console.error('webhook.invalid_signature', { eventId: body.id });
    return json({ error: 'Assinatura de webhook inválida.' }, { status: 400 });
  }

  const eventType = body.event_type;
  const resource = body.resource || {};
  // custom_id / reference_id foi definido como o nosso orderNumber ao criar a ordem PayPal.
  const orderNumber = resource.custom_id
    || (resource.purchase_units && resource.purchase_units[0] && resource.purchase_units[0].custom_id)
    || (resource.supplementary_data && resource.supplementary_data.related_ids && resource.supplementary_data.related_ids.order_id);

  // Idempotência de webhooks: o PayPal pode reenviar o mesmo evento — a
  // chave primária de webhook_events garante que só processamos uma vez,
  // mesmo que dois webhooks cheguem em simultâneo.
  const isNewEvent = await claimWebhookEventOnce(env, { eventId: body.id, eventType, orderNumber });
  if (!isNewEvent) {
    return json({ received: true, duplicate: true });
  }

  if (orderNumber) {
    if (eventType === 'PAYMENT.CAPTURE.COMPLETED' || eventType === 'CHECKOUT.ORDER.APPROVED') {
      const order = await getOrder(env, orderNumber);
      if (order && order.paymentStatus !== 'COMPLETED') {
        // O webhook é uma confirmação adicional, não a única fonte: o
        // estado "oficial" já devia ter sido definido pelo capture-order.
        // Aqui apenas registamos — nunca reduzimos stock aqui outra vez
        // (evitaria duplicar a redução já feita no capture-order).
        console.log('webhook.payment_completed', { orderNumber });
      }
    } else if (eventType === 'PAYMENT.CAPTURE.DENIED' || eventType === 'CHECKOUT.ORDER.VOIDED') {
      await updateOrder(env, orderNumber, { payment_status: 'FAILED' });
    } else if (eventType === 'PAYMENT.CAPTURE.REFUNDED') {
      await updateOrder(env, orderNumber, { status: 'REFUNDED', payment_status: 'REFUNDED' });
    }
  }

  return json({ received: true });
}

async function handleSyncStock(request, env) {
  // Endpoint interno (ver docs/orders.md) — não expõe operações
  // perigosas ao browser: apenas lê o catálogo publicado e atualiza o
  // stock disponível por delta (nunca sobrescreve vendas já feitas).
  try {
    const result = await syncStockFromPublishedCatalog(env);
    return json({ ok: true, result });
  } catch (err) {
    console.error('stock.sync.error', err.message);
    return json({ error: 'Não foi possível sincronizar o stock.' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// LOGÍSTICA (Fase 6) — ver backend/src/shipping/ e docs/shipping.md.
//
// Nenhum destes endpoints aceita preço/portes vindos do browser: rates são
// consultados ao provider (ou marcados indisponíveis); a criação de envio
// só acontece com paymentStatus=COMPLETED confirmado pelo próprio backend.
// ---------------------------------------------------------------------------

function shippingErrorStatus(code) {
  const map = {
    NOT_SUPPORTED: 200, // resultado de negócio ("esta transportadora não suporta X agora"), não uma falha HTTP
    NOT_CONFIGURED: 200,
    COUNTRY_NOT_SUPPORTED: 200,
    PICKUP_POINT_REQUIRED: 400,
    INVALID_PICKUP_POINT: 400,
    MISSING_PACKAGE_DIMENSIONS: 422,
    SHIPMENT_ALREADY_EXISTS: 409,
    PROVIDER_REQUEST_FAILED: 502,
  };
  return map[code] || 500;
}

/** GET /api/shipping/methods — transportadoras conhecidas pela arquitetura (não implica que estejam operacionais). */
async function handleListShippingMethods(request, env) {
  const providers = listShippingProviders(env);
  return json({
    providers: providers.map((p) => ({ id: p.id, name: p.name, authConfigured: p.isAuthConfigured() })),
  });
}

/** POST /api/shipping/rates — { provider, country, postalCode, totalWeightG } → tarifas reais ou indisponibilidade documentada. */
async function handleGetShippingRates(request, env) {
  const body = await readJson(request);
  if (!body || !body.provider || !body.country || typeof body.totalWeightG !== 'number') {
    return json({ error: 'provider, country e totalWeightG são obrigatórios.' }, { status: 400 });
  }

  const result = await getRatesSafely(env, body.provider, {
    country: body.country,
    postalCode: body.postalCode,
    package: { weightG: body.totalWeightG, lengthMm: null, widthMm: null, heightMm: null, numberOfPackages: 1 },
  });
  return json(result);
}

/** POST /api/shipping/pickup-points — { provider, country, postalCode, city } → pontos reais ou indisponibilidade documentada. */
async function handleGetPickupPoints(request, env) {
  const body = await readJson(request);
  if (!body || !body.provider || !body.country) {
    return json({ error: 'provider e country são obrigatórios.' }, { status: 400 });
  }
  const result = await getPickupPointsSafely(env, body.provider, { country: body.country, postalCode: body.postalCode, city: body.city });
  return json(result);
}

/**
 * POST /api/shipping/create-shipment — { orderNumber, provider, serviceId, pickupPointId }
 * Só cria o envio se orders.payment_status === 'COMPLETED' (ver
 * createShipmentForOrder). Idempotente: chamar duas vezes para a mesma
 * encomenda+provider devolve o mesmo envio em vez de criar outro.
 */
async function handleCreateShipment(request, env) {
  const body = await readJson(request);
  if (!body || !body.orderNumber || !body.provider || !body.serviceId) {
    return json({ error: 'orderNumber, provider e serviceId são obrigatórios.' }, { status: 400 });
  }

  const order = await getOrder(env, body.orderNumber);
  if (!order) return json({ error: 'Encomenda não encontrada.' }, { status: 404 });

  try {
    const { shipment, created } = await createShipmentForOrder(env, order, {
      providerId: body.provider,
      serviceId: body.serviceId,
      pickupPointId: body.pickupPointId || null,
      customer: order.customer,
    });
    return json({ shipment, created }, { status: created ? 201 : 200 });
  } catch (err) {
    if (err instanceof ShippingProviderError) {
      console.error('shipping.create_shipment.error', { orderNumber: body.orderNumber, code: err.code, message: err.message });
      return json({ error: err.message, code: err.code }, { status: shippingErrorStatus(err.code) });
    }
    console.error('shipping.create_shipment.unexpected_error', err.message);
    return json({ error: 'Não foi possível criar o envio.' }, { status: 500 });
  }
}

/** GET /api/shipping/orders/:orderNumber/label?provider=inpost */
async function handleGetShipmentLabel(request, env, orderNumber) {
  const url = new URL(request.url);
  const providerId = url.searchParams.get('provider');
  if (!providerId) return json({ error: 'provider é obrigatório (query string).' }, { status: 400 });

  const order = await getOrder(env, orderNumber);
  if (!order) return json({ error: 'Encomenda não encontrada.' }, { status: 404 });

  const shipment = await getShipmentByOrderId(env.DB, order.id, providerId);
  if (!shipment) return json({ error: 'Não existe envio para esta encomenda/transportadora.' }, { status: 404 });

  try {
    const label = await getShipmentLabel(env, shipment);
    return json({ label });
  } catch (err) {
    if (err instanceof ShippingProviderError) {
      return json({ error: err.message, code: err.code }, { status: shippingErrorStatus(err.code) });
    }
    console.error('shipping.get_label.unexpected_error', err.message);
    return json({ error: 'Não foi possível obter a etiqueta.' }, { status: 500 });
  }
}

/** GET /api/shipping/orders/:orderNumber/tracking?provider=inpost */
async function handleGetShipmentTracking(request, env, orderNumber) {
  const url = new URL(request.url);
  const providerId = url.searchParams.get('provider');
  if (!providerId) return json({ error: 'provider é obrigatório (query string).' }, { status: 400 });

  const order = await getOrder(env, orderNumber);
  if (!order) return json({ error: 'Encomenda não encontrada.' }, { status: 404 });

  const shipment = await getShipmentByOrderId(env.DB, order.id, providerId);
  if (!shipment) return json({ error: 'Não existe envio para esta encomenda/transportadora.' }, { status: 404 });

  try {
    const updated = await refreshShipmentTracking(env, shipment);
    return json({ shipment: updated });
  } catch (err) {
    if (err instanceof ShippingProviderError) {
      // Falha ao consultar a transportadora não deve impedir o cliente de
      // ver o último estado conhecido guardado na base de dados.
      console.error('shipping.tracking.provider_error', { orderNumber, code: err.code, message: err.message });
      return json({ shipment, warning: err.message });
    }
    console.error('shipping.tracking.unexpected_error', err.message);
    return json({ error: 'Não foi possível atualizar o tracking.' }, { status: 500 });
  }
}

/** POST /api/shipping/orders/:orderNumber/cancel — { provider } */
async function handleCancelShipment(request, env, orderNumber) {
  const body = await readJson(request);
  if (!body || !body.provider) return json({ error: 'provider é obrigatório.' }, { status: 400 });

  const order = await getOrder(env, orderNumber);
  if (!order) return json({ error: 'Encomenda não encontrada.' }, { status: 404 });

  const shipment = await getShipmentByOrderId(env.DB, order.id, body.provider);
  if (!shipment) return json({ error: 'Não existe envio para esta encomenda/transportadora.' }, { status: 404 });

  try {
    const updated = await cancelShipment(env, shipment);
    return json({ shipment: updated });
  } catch (err) {
    if (err instanceof ShippingProviderError) {
      return json({ error: err.message, code: err.code }, { status: shippingErrorStatus(err.code) });
    }
    console.error('shipping.cancel.unexpected_error', err.message);
    return json({ error: 'Não foi possível cancelar o envio.' }, { status: 500 });
  }
}

/**
 * POST /api/webhooks/shipping/:provider — webhook de uma transportadora.
 * Nunca atualiza nenhum estado sem `provider.verifyWebhookSignature`
 * confirmar a autenticidade (ver secção 13 do pedido da Fase 6). Como
 * nenhum provider desta fase tem um mecanismo de assinatura confirmado
 * (ver docs/shipping.md), isto devolve 401 na prática até essa
 * confirmação existir — o endpoint já está pronto para ativar assim que
 * o provider real passar a validar a assinatura.
 */
async function handleShippingWebhook(request, env, providerId) {
  const rawBody = await request.text();
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch (e) {
    return json({ error: 'JSON inválido.' }, { status: 400 });
  }

  let provider;
  try {
    provider = getShippingProvider(env, providerId);
  } catch (err) {
    return json({ error: 'Transportadora desconhecida.' }, { status: 404 });
  }

  const isValid = await provider.verifyWebhookSignature({ headers: request.headers, rawBody });
  if (!isValid) {
    console.error('shipping.webhook.invalid_signature', { provider: providerId });
    return json({ error: 'Assinatura de webhook inválida ou não suportada.' }, { status: 401 });
  }

  const parsedEvent = provider.parseWebhookEvent(body);
  const updated = await applyShipmentWebhookEvent(env, providerId, parsedEvent);
  return json({ received: true, updated: !!updated });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = corsHeaders(env, request);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }

    let response;

    if (url.pathname === '/api/health') {
      response = json({ ok: true, environment: env.PAYPAL_ENVIRONMENT });
    } else if (url.pathname === '/api/orders' && request.method === 'POST') {
      response = await handleCreateOrder(request, env);
    } else if (url.pathname.startsWith('/api/orders/') && request.method === 'GET') {
      response = await handleGetOrder(decodeURIComponent(url.pathname.split('/api/orders/')[1]), env);
    } else if (url.pathname === '/api/paypal/create-order' && request.method === 'POST') {
      response = await handleCreatePayPalOrder(request, env);
    } else if (url.pathname === '/api/paypal/capture-order' && request.method === 'POST') {
      response = await handleCapturePayPalOrder(request, env);
    } else if (url.pathname === '/api/webhooks/paypal' && request.method === 'POST') {
      response = await handlePayPalWebhook(request, env);
    } else if (url.pathname === '/api/internal/sync-stock' && request.method === 'POST') {
      response = await handleSyncStock(request, env);
    } else if (url.pathname === '/api/shipping/methods' && request.method === 'GET') {
      response = await handleListShippingMethods(request, env);
    } else if (url.pathname === '/api/shipping/rates' && request.method === 'POST') {
      response = await handleGetShippingRates(request, env);
    } else if (url.pathname === '/api/shipping/pickup-points' && request.method === 'POST') {
      response = await handleGetPickupPoints(request, env);
    } else if (url.pathname === '/api/shipping/create-shipment' && request.method === 'POST') {
      response = await handleCreateShipment(request, env);
    } else if (/^\/api\/shipping\/orders\/[^/]+\/label$/.test(url.pathname) && request.method === 'GET') {
      response = await handleGetShipmentLabel(request, env, decodeURIComponent(url.pathname.split('/')[4]));
    } else if (/^\/api\/shipping\/orders\/[^/]+\/tracking$/.test(url.pathname) && request.method === 'GET') {
      response = await handleGetShipmentTracking(request, env, decodeURIComponent(url.pathname.split('/')[4]));
    } else if (/^\/api\/shipping\/orders\/[^/]+\/cancel$/.test(url.pathname) && request.method === 'POST') {
      response = await handleCancelShipment(request, env, decodeURIComponent(url.pathname.split('/')[4]));
    } else if (/^\/api\/webhooks\/shipping\/[^/]+$/.test(url.pathname) && request.method === 'POST') {
      response = await handleShippingWebhook(request, env, decodeURIComponent(url.pathname.split('/')[4]));
    } else {
      response = json({ error: 'Not found' }, { status: 404 });
    }

    const finalHeaders = new Headers(response.headers);
    Object.entries(headers).forEach(([k, v]) => finalHeaders.set(k, v));
    return new Response(response.body, { status: response.status, headers: finalHeaders });
  },

  // Cron Trigger (ver wrangler.toml [triggers]) — mantém a tabela `stock`
  // sincronizada com o catálogo publicado sem depender de uma encomenda
  // acontecer primeiro.
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(syncStockFromPublishedCatalog(env).catch((err) => console.error('stock.sync.scheduled.error', err.message)));
  },
};
