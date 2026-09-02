/**
 * Mestre do Pano — backend/src/db.js
 *
 * Camada de acesso à base de dados (Cloudflare D1 — ver schema.sql e
 * docs/orders.md). Todas as funções recebem `db` como primeiro argumento
 * (normalmente `env.DB`), o que também permite testar esta camada com
 * qualquer implementação compatível com a API do D1
 * (`prepare(sql).bind(...).run()/.first()/.all()`) — ver
 * backend/test/d1-sqlite-adapter.js, que usa node:sqlite (o mesmo motor
 * SQLite do D1) para testes rápidos e sem rede.
 *
 * Princípios seguidos nesta camada (Fase 5):
 *   - O Stock.xlsx continua a ser a fonte do CATÁLOGO; esta base de dados é
 *     a fonte de verdade do STOCK REAL DE VENDA e das ENCOMENDAS.
 *     Uma sincronização do Excel nunca "devolve à venda" unidades já
 *     vendidas (ver syncStockFromCatalog).
 *   - Nenhuma redução de stock é definitiva antes do pagamento estar
 *     confirmado (ver decrementStockForOrder, chamado só após captura).
 *   - A redução de stock usa uma condição atómica (`WHERE available_stock
 *     >= ?`) para nunca deixar o stock ficar negativo, mesmo com dois
 *     pedidos em simultâneo (proteção contra overselling).
 */

function nowIso() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// STOCK
// ---------------------------------------------------------------------------

/**
 * Calcula o novo `available_stock` quando o catálogo (Stock.xlsx via
 * products.json) reporta um novo `catalog_stock` para um SKU.
 *
 * Função PURA (sem I/O) para ser fácil de testar exaustivamente — é o
 * coração da regra da secção 12 do pedido: nunca simplesmente sobrescrever
 * available_stock com o valor do Excel, porque isso apagaria vendas já
 * confirmadas. Em vez disso aplicamos o DELTA do catálogo:
 *
 *   novo available_stock = available_stock atual + (novo catalog_stock - catalog_stock antigo)
 *
 * Exemplos:
 *   - Produto novo (sem linha ainda): available_stock = catalog_stock inicial.
 *   - Dono repõe stock no Excel de 0 para 5 (+5): available_stock += 5.
 *   - Dono corrige Excel de 10 para 8 (-2) depois de 3 vendas (available=7):
 *     available_stock = 7 - 2 = 5 (nunca volta a "10").
 *   - Nunca deixamos available_stock ficar negativo por causa do Excel.
 */
function computeSyncedAvailableStock({ existing, newCatalogStock }) {
  if (!existing) {
    return { catalog_stock: newCatalogStock, available_stock: Math.max(0, newCatalogStock) };
  }
  const delta = newCatalogStock - existing.catalog_stock;
  const newAvailable = Math.max(0, existing.available_stock + delta);
  return { catalog_stock: newCatalogStock, available_stock: newAvailable };
}

/** Lê o stock real de venda (available_stock) de um único SKU. `null` se ainda não sincronizado. */
async function getStock(db, sku) {
  const row = await db.prepare('SELECT * FROM stock WHERE sku = ?').bind(sku).first();
  return row || null;
}

/**
 * Sincroniza a tabela `stock` a partir do catálogo publicado
 * (products.json). Chamado periodicamente (Cron Trigger, ver wrangler.toml
 * `[triggers]`) e, como rede de segurança, antes de qualquer criação de
 * encomenda — nunca escreve no Excel, só lê `catalog.stock` de cada produto.
 */
async function syncStockFromCatalog(db, products) {
  const results = { created: 0, updated: 0, unchanged: 0 };

  for (const product of products) {
    if (!product || !product.id || typeof product.stock !== 'number') continue;

    const existing = await getStock(db, product.id);
    const { catalog_stock, available_stock } = computeSyncedAvailableStock({
      existing,
      newCatalogStock: product.stock,
    });

    if (!existing) {
      await db
        .prepare('INSERT INTO stock (sku, catalog_stock, available_stock, updated_at) VALUES (?, ?, ?, ?)')
        .bind(product.id, catalog_stock, available_stock, nowIso())
        .run();
      results.created += 1;
    } else if (existing.catalog_stock !== catalog_stock || existing.available_stock !== available_stock) {
      await db
        .prepare('UPDATE stock SET catalog_stock = ?, available_stock = ?, updated_at = ? WHERE sku = ?')
        .bind(catalog_stock, available_stock, nowIso(), product.id)
        .run();
      results.updated += 1;
    } else {
      results.unchanged += 1;
    }
  }

  return results;
}

/**
 * Reduz definitivamente o stock disponível para os artigos de uma
 * encomenda — só deve ser chamado DEPOIS da confirmação do pagamento
 * (nunca em PENDING_PAYMENT).
 *
 * Cada linha é reduzida com uma única instrução UPDATE condicional
 * (`WHERE available_stock >= quantity`), que é atómica ao nível do SQLite
 * — mesmo que dois pedidos cheguem "ao mesmo tempo", o SQLite serializa as
 * escritas e apenas um deles consegue reduzir stock que já não existe.
 *
 * Nota sobre atomicidade entre VÁRIOS artigos da mesma encomenda: o D1 não
 * suporta (ainda) transações interativas multi-instrução, por isso usamos
 * aqui uma abordagem de "tentar tudo, compensar se algo falhar": reduzimos
 * item a item e, se algum falhar por falta de stock, devolvemos o stock já
 * reduzido dos itens anteriores dessa mesma encomenda. Isto está
 * documentado como uma limitação conhecida em docs/orders.md.
 *
 * Devolve { ok: true } ou { ok: false, conflicts: [sku, ...] }.
 */
async function decrementStockForOrder(db, items) {
  const decremented = [];

  for (const item of items) {
    const result = await db
      .prepare('UPDATE stock SET available_stock = available_stock - ?, updated_at = ? WHERE sku = ? AND available_stock >= ?')
      .bind(item.quantity, nowIso(), item.sku, item.quantity)
      .run();

    const changed = (result.meta && result.meta.changes) || 0;

    if (changed === 1) {
      decremented.push(item);
    } else {
      // Falhou — compensar (devolver) o que já tínhamos reduzido nesta encomenda.
      for (const done of decremented) {
        await db
          .prepare('UPDATE stock SET available_stock = available_stock + ?, updated_at = ? WHERE sku = ?')
          .bind(done.quantity, nowIso(), done.sku)
          .run();
      }
      return { ok: false, conflicts: [item.sku] };
    }
  }

  return { ok: true };
}

/** Devolve o stock ao inventário (ex.: pagamento capturado mas depois marcado inválido). */
async function restockOrderItems(db, items) {
  for (const item of items) {
    await db
      .prepare('UPDATE stock SET available_stock = available_stock + ?, updated_at = ? WHERE sku = ?')
      .bind(item.quantity, nowIso(), item.sku)
      .run();
  }
}

// ---------------------------------------------------------------------------
// ORDERS / ORDER_ITEMS
// ---------------------------------------------------------------------------

function randomSuffix(len = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem carateres ambíguos
  let out = '';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  for (let i = 0; i < len; i += 1) out += chars[bytes[i] % chars.length];
  return out;
}

function generateOrderNumber() {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  return `MP-${yyyy}${mm}${dd}-${randomSuffix()}`;
}

/**
 * Cria uma encomenda (PENDING_PAYMENT / PENDING) com os seus order_items
 * em snapshot. NÃO mexe em stock (isso só acontece após o pagamento —
 * ver decrementStockForOrder). Devolve a encomenda completa (com items).
 */
async function insertOrder(db, { quote, customer, shipping, isTest = true }) {
  const orderNumber = generateOrderNumber();
  const now = nowIso();

  const orderResult = await db
    .prepare(
      `INSERT INTO orders (
        order_number, status, payment_status, payment_provider,
        customer_name, customer_email, customer_phone,
        shipping_country, shipping_address, shipping_postal_code, shipping_city, shipping_region, shipping_method, shipping_cost,
        subtotal, total, total_weight_g, currency, is_test, created_at, updated_at
      ) VALUES (?, 'PENDING_PAYMENT', 'PENDING', 'paypal', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      orderNumber,
      customer.name,
      customer.email,
      customer.phone || null,
      shipping.country,
      shipping.address,
      shipping.postalCode,
      shipping.city,
      shipping.region || null,
      shipping.method,
      quote.shippingCostCents,
      quote.subtotalCents,
      quote.totalCents,
      quote.totalWeightG,
      quote.currency,
      isTest ? 1 : 0,
      now,
      now,
    )
    .run();

  const orderId = orderResult.meta.last_row_id;

  for (const item of quote.lineItems) {
    await db
      .prepare(
        `INSERT INTO order_items (
          order_id, sku, product_name, quantity, unit_price, unit_weight_g, unit_count, total_price, total_weight_g
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        orderId,
        item.sku,
        item.name,
        item.qty,
        item.unitPriceCents,
        item.unitWeightG,
        item.unitCount,
        item.lineTotalCents,
        item.lineWeightG,
      )
      .run();
  }

  return getOrderById(db, orderId);
}

async function rowToOrder(db, row) {
  if (!row) return null;
  const itemsResult = await db.prepare('SELECT * FROM order_items WHERE order_id = ?').bind(row.id).all();
  return {
    id: row.id,
    orderNumber: row.order_number,
    status: row.status,
    paymentStatus: row.payment_status,
    paymentProvider: row.payment_provider,
    paypalOrderId: row.paypal_order_id,
    paypalCaptureId: row.paypal_capture_id,
    customer: { name: row.customer_name, email: row.customer_email, phone: row.customer_phone },
    shipping: {
      country: row.shipping_country,
      address: row.shipping_address,
      postalCode: row.shipping_postal_code,
      city: row.shipping_city,
      region: row.shipping_region,
      method: row.shipping_method,
    },
    shippingCost: row.shipping_cost,
    subtotal: row.subtotal,
    total: row.total,
    totalWeightG: row.total_weight_g,
    currency: row.currency,
    isTest: !!row.is_test,
    stockConflict: !!row.stock_conflict,
    items: (itemsResult.results || []).map((i) => ({
      sku: i.sku,
      name: i.product_name,
      qty: i.quantity,
      unitPriceCents: i.unit_price,
      unitWeightG: i.unit_weight_g,
      unitCount: i.unit_count,
      lineTotalCents: i.total_price,
      lineWeightG: i.total_weight_g,
    })),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getOrderById(db, id) {
  const row = await db.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first();
  return rowToOrder(db, row);
}

async function getOrderByNumber(db, orderNumber) {
  const row = await db.prepare('SELECT * FROM orders WHERE order_number = ?').bind(orderNumber).first();
  return rowToOrder(db, row);
}

async function getOrderByPaypalOrderId(db, paypalOrderId) {
  const row = await db.prepare('SELECT * FROM orders WHERE paypal_order_id = ?').bind(paypalOrderId).first();
  return rowToOrder(db, row);
}

/** Atualiza colunas simples da encomenda (status, payment_status, paypal ids, stock_conflict). */
async function updateOrderFields(db, orderNumber, fields) {
  const allowed = ['status', 'payment_status', 'paypal_order_id', 'paypal_capture_id', 'stock_conflict'];
  const sets = [];
  const values = [];
  for (const key of Object.keys(fields)) {
    if (!allowed.includes(key)) continue;
    sets.push(`${key} = ?`);
    values.push(fields[key]);
  }
  if (sets.length === 0) return getOrderByNumber(db, orderNumber);

  sets.push('updated_at = ?');
  values.push(nowIso());
  values.push(orderNumber);

  await db.prepare(`UPDATE orders SET ${sets.join(', ')} WHERE order_number = ?`).bind(...values).run();
  return getOrderByNumber(db, orderNumber);
}

// ---------------------------------------------------------------------------
// IDEMPOTÊNCIA (criação de encomendas)
// ---------------------------------------------------------------------------

async function findOrderByIdempotencyKey(db, key) {
  if (!key) return null;
  const row = await db.prepare('SELECT order_id FROM idempotency_keys WHERE key = ?').bind(key).first();
  if (!row) return null;
  return getOrderById(db, row.order_id);
}

async function saveIdempotencyKey(db, key, orderId) {
  if (!key) return;
  // INSERT OR IGNORE: se duas requisições concorrentes com a mesma chave
  // chegarem ao mesmo tempo, só uma linha fica gravada (chave primária).
  await db
    .prepare('INSERT OR IGNORE INTO idempotency_keys (key, order_id, created_at) VALUES (?, ?, ?)')
    .bind(key, orderId, nowIso())
    .run();
}

// ---------------------------------------------------------------------------
// WEBHOOKS (idempotência de eventos do PayPal)
// ---------------------------------------------------------------------------

/**
 * Tenta registar este evento como processado. Devolve `true` se este
 * evento é novo (deve ser processado agora), `false` se já tinha sido
 * processado antes (duplicado — ignorar). A chave primária de
 * `webhook_events.event_id` garante que isto é seguro mesmo com dois
 * webhooks a chegar em simultâneo.
 */
async function claimWebhookEvent(db, { eventId, eventType, orderNumber }) {
  try {
    await db
      .prepare('INSERT INTO webhook_events (event_id, event_type, order_number, processed_at) VALUES (?, ?, ?, ?)')
      .bind(eventId, eventType || null, orderNumber || null, nowIso())
      .run();
    return true;
  } catch (err) {
    // Violação da chave primária => evento já processado.
    return false;
  }
}

// ---------------------------------------------------------------------------
// SHIPMENTS (Fase 6 — ver backend/src/shipping/ e docs/shipping.md)
// ---------------------------------------------------------------------------

function rowToShipment(row) {
  if (!row) return null;
  return {
    id: row.id,
    orderId: row.order_id,
    provider: row.provider,
    service: row.service,
    shipmentId: row.shipment_id,
    trackingNumber: row.tracking_number,
    trackingUrl: row.tracking_url,
    labelReference: row.label_reference,
    pickupPointId: row.pickup_point_id,
    pickupPointData: row.pickup_point_data ? JSON.parse(row.pickup_point_data) : null,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Envio ATIVO (não necessariamente o único historicamente) de uma encomenda para um provider. */
async function getShipmentByOrderId(db, orderId, provider) {
  const row = await db
    .prepare('SELECT * FROM shipments WHERE order_id = ? AND provider = ?')
    .bind(orderId, provider)
    .first();
  return rowToShipment(row);
}

async function getShipmentByProviderShipmentId(db, provider, shipmentId) {
  const row = await db
    .prepare('SELECT * FROM shipments WHERE provider = ? AND shipment_id = ?')
    .bind(provider, shipmentId)
    .first();
  return rowToShipment(row);
}

async function getShipmentById(db, id) {
  const row = await db.prepare('SELECT * FROM shipments WHERE id = ?').bind(id).first();
  return rowToShipment(row);
}

/**
 * Cria o registo do envio. A UNIQUE(order_id, provider) do schema é a
 * rede de segurança final contra duplicação (ver seccão 15 do pedido da
 * Fase 6) — createShipmentForOrder (shipping/shipments.js) já verifica
 * isto antes de chamar a transportadora, mas se dois pedidos concorrentes
 * passarem essa verificação ao mesmo tempo, esta constraint impede duas
 * linhas para a mesma encomenda+provider.
 */
async function insertShipment(db, { orderId, provider, service, shipmentId, trackingNumber, trackingUrl, pickupPointId, pickupPointData, status }) {
  const now = nowIso();
  const result = await db
    .prepare(
      `INSERT INTO shipments (
        order_id, provider, service, shipment_id, tracking_number, tracking_url,
        pickup_point_id, pickup_point_data, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      orderId,
      provider,
      service,
      shipmentId,
      trackingNumber || null,
      trackingUrl || null,
      pickupPointId || null,
      pickupPointData ? JSON.stringify(pickupPointData) : null,
      status || 'LABEL_CREATED',
      now,
      now,
    )
    .run();
  return getShipmentById(db, result.meta.last_row_id);
}

async function updateShipmentFields(db, id, fields) {
  const allowed = ['status', 'tracking_number', 'tracking_url', 'label_reference'];
  const sets = [];
  const values = [];
  for (const key of Object.keys(fields)) {
    if (!allowed.includes(key)) continue;
    sets.push(`${key} = ?`);
    values.push(fields[key]);
  }
  if (sets.length === 0) return getShipmentById(db, id);

  sets.push('updated_at = ?');
  values.push(nowIso());
  values.push(id);

  await db.prepare(`UPDATE shipments SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run();
  return getShipmentById(db, id);
}

export {
  computeSyncedAvailableStock,
  getStock,
  syncStockFromCatalog,
  decrementStockForOrder,
  restockOrderItems,
  generateOrderNumber,
  insertOrder,
  getOrderById,
  getOrderByNumber,
  getOrderByPaypalOrderId,
  updateOrderFields,
  findOrderByIdempotencyKey,
  saveIdempotencyKey,
  claimWebhookEvent,
  getShipmentByOrderId,
  getShipmentByProviderShipmentId,
  getShipmentById,
  insertShipment,
  updateShipmentFields,
};
