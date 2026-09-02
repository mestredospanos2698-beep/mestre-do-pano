/**
 * Mestre do Pano — backend/src/shipping/shipments.js
 *
 * Regras de negócio dos envios: estados de logística (separados de
 * status/payment_status da encomenda), cálculo do pacote (peso real +
 * dimensões só quando existirem), e o fluxo de criação de envio protegido
 * por idempotência e pelo estado de pagamento da encomenda.
 */

import { ShippingProviderError, SHIPPING_ERROR_CODES } from './provider.js';
import { getShippingProvider } from './registry.js';
import {
  getShipmentByOrderId,
  insertShipment,
  updateShipmentFields,
  getShipmentByProviderShipmentId,
} from '../db.js';

/**
 * Estados de ENVIO (shipments.status) — nunca confundidos com
 * orders.status nem orders.payment_status (ver schema.sql e secção 11 do
 * pedido da Fase 6).
 */
export const SHIPMENT_STATUSES = [
  'LABEL_CREATED',
  'READY_TO_SHIP',
  'SHIPPED',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'DELIVERY_FAILED',
  'RETURNED',
];

/**
 * Constrói o `PackageDetails` (ver provider.js) a partir dos order_items
 * já guardados em snapshot — nunca inventa dimensões. Se a transportadora
 * escolhida precisar de dimensões e elas não existirem, quem chama
 * `createShipment` recebe `MISSING_PACKAGE_DIMENSIONS` do próprio
 * provider (ver providers/inpost.js) em vez de enviarmos zeros/fictícios.
 */
export function buildPackageFromOrder(order) {
  const weightG = order.totalWeightG;
  return {
    weightG,
    // Dimensões físicas (comprimento/largura/altura) ainda não existem
    // em lado nenhum dos dados do produto (Stock.xlsx só tem peso) — por
    // isso ficam explicitamente `null`, nunca um valor inventado. Ver
    // secção 9 do pedido da Fase 6 e docs/shipping.md.
    lengthMm: null,
    widthMm: null,
    heightMm: null,
    numberOfPackages: 1,
  };
}

/**
 * Devolve as tarifas disponíveis de uma transportadora para o destino +
 * pacote indicados. Nunca deixa um erro de provider (NOT_SUPPORTED,
 * NOT_CONFIGURED, COUNTRY_NOT_SUPPORTED) rebentar para o chamador —
 * traduz para `{ available: false, reason }`, porque "esta transportadora
 * não tem cotação disponível agora" é um resultado de negócio normal,
 * não uma falha do backend.
 */
export async function getRatesSafely(env, providerId, input) {
  try {
    const provider = getShippingProvider(env, providerId);
    const rates = await provider.getRates(input);
    return { available: true, rates };
  } catch (err) {
    if (err instanceof ShippingProviderError) {
      return { available: false, reason: err.code, message: err.message };
    }
    throw err;
  }
}

/** Idem para pontos de recolha. */
export async function getPickupPointsSafely(env, providerId, input) {
  try {
    const provider = getShippingProvider(env, providerId);
    const points = await provider.getPickupPoints(input);
    return { available: true, points };
  } catch (err) {
    if (err instanceof ShippingProviderError) {
      return { available: false, reason: err.code, message: err.message };
    }
    throw err;
  }
}

/**
 * Cria o envio de uma encomenda já paga — chamado exclusivamente depois
 * de `order.paymentStatus === 'COMPLETED'` (nunca em PENDING_PAYMENT; ver
 * index.js, handleCapturePayPalOrder, e secção 10 do pedido da Fase 6).
 *
 * Idempotência (secção 15 do pedido): se já existir um shipment válido
 * (não cancelado) para esta encomenda + provider, devolve-o em vez de
 * criar outro — protege contra duplo clique / retries no endpoint
 * `/api/shipping/create-shipment`.
 */
export async function createShipmentForOrder(env, order, { providerId, serviceId, pickupPointId, customer }) {
  if (order.paymentStatus !== 'COMPLETED') {
    throw new ShippingProviderError(
      SHIPPING_ERROR_CODES.NOT_SUPPORTED,
      `Não é possível criar o envio: a encomenda ${order.orderNumber} ainda não tem pagamento confirmado (payment_status=${order.paymentStatus}).`,
    );
  }

  const existing = await getShipmentByOrderId(env.DB, order.id, providerId);
  if (existing && existing.status !== 'RETURNED') {
    return { shipment: existing, created: false };
  }

  const provider = getShippingProvider(env, providerId);
  const pkg = buildPackageFromOrder(order);

  const result = await provider.createShipment({
    orderNumber: order.orderNumber,
    serviceId,
    customer: customer || order.customer,
    shippingAddress: order.shipping,
    package: pkg,
    pickupPointId,
  });

  const shipment = await insertShipment(env.DB, {
    orderId: order.id,
    provider: providerId,
    service: serviceId,
    shipmentId: result.shipmentId,
    trackingNumber: result.trackingNumber,
    trackingUrl: result.trackingUrl,
    pickupPointId: pickupPointId || null,
    status: 'LABEL_CREATED',
  });

  return { shipment, created: true };
}

/** Etiqueta de um envio já criado — nunca gera etiqueta nova se já existir uma válida (secção 14). */
export async function getShipmentLabel(env, shipment) {
  const provider = getShippingProvider(env, shipment.provider);
  return provider.getLabel({ shipmentId: shipment.shipmentId });
}

/** Consulta o estado atual (tracking) junto da transportadora e persiste a atualização. */
export async function refreshShipmentTracking(env, shipment) {
  const provider = getShippingProvider(env, shipment.provider);
  const result = await provider.trackShipment({ shipmentId: shipment.shipmentId, trackingNumber: shipment.trackingNumber });
  if (result.status && SHIPMENT_STATUSES.includes(result.status)) {
    return updateShipmentFields(env.DB, shipment.id, { status: result.status });
  }
  return shipment;
}

/** Cancela o envio junto da transportadora e marca RETURNED localmente (permite recriar depois). */
export async function cancelShipment(env, shipment) {
  const provider = getShippingProvider(env, shipment.provider);
  await provider.cancelShipment({ shipmentId: shipment.shipmentId });
  return updateShipmentFields(env.DB, shipment.id, { status: 'RETURNED' });
}

/**
 * Processa um webhook de transportadora já validado (assinatura
 * confirmada pelo provider — ver provider.verifyWebhookSignature).
 * Atualiza o shipment correspondente pelo `shipmentId` do provider.
 * Nunca atualiza nada a partir de um webhook não autenticado.
 */
export async function applyShipmentWebhookEvent(env, providerId, parsedEvent) {
  if (!parsedEvent || !parsedEvent.shipmentId) return null;
  const shipment = await getShipmentByProviderShipmentId(env.DB, providerId, parsedEvent.shipmentId);
  if (!shipment) return null;
  if (!parsedEvent.status || !SHIPMENT_STATUSES.includes(parsedEvent.status)) return shipment;
  return updateShipmentFields(env.DB, shipment.id, { status: parsedEvent.status });
}
