-- Mestre do Pano — schema.sql (Fase 5)
--
-- Base de dados: Cloudflare D1 (SQLite gerido).
--
-- Aplicar com:
--   wrangler d1 create mestre-do-pano-db
--   wrangler d1 execute mestre-do-pano-db --file=./schema.sql          (local/dev)
--   wrangler d1 execute mestre-do-pano-db --remote --file=./schema.sql (produção)
--
-- Ver docs/orders.md para a explicação completa da arquitetura.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- stock: fonte de verdade do STOCK REAL DE VENDA (não confundir com o
-- catálogo do Stock.xlsx).
--
-- catalog_stock   -> a última leitura do Stock.xlsx via sync_stock.py /
--                    products.json ("quanto o Excel diz que existe").
-- available_stock -> quanto está realmente disponível para venda agora,
--                    já descontando encomendas pagas. É este campo que o
--                    backend usa para decidir se pode vender mais unidades,
--                    NUNCA o catalog_stock diretamente e NUNCA o campo
--                    "stock" do products.json publicado.
--
-- Uma sincronização do Excel só pode ALTERAR catalog_stock; a atualização
-- de available_stock é sempre feita por delta (ver src/db.js,
-- syncStockFromCatalog) para nunca "devolver à venda" unidades já vendidas.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stock (
  sku              TEXT PRIMARY KEY,
  catalog_stock    INTEGER NOT NULL DEFAULT 0,
  available_stock  INTEGER NOT NULL DEFAULT 0,
  updated_at       TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- orders: uma encomenda. `status` (estado logístico/comercial da encomenda)
-- é sempre mantido separado de `payment_status` (estado do pagamento) —
-- ver secção 17 do pedido da Fase 5.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  order_number           TEXT NOT NULL UNIQUE,

  -- PENDING_PAYMENT | PAID | PROCESSING | SHIPPED | DELIVERED | CANCELLED | REFUNDED
  status                 TEXT NOT NULL DEFAULT 'PENDING_PAYMENT',
  -- PENDING | COMPLETED | FAILED | CANCELLED | REFUNDED
  payment_status         TEXT NOT NULL DEFAULT 'PENDING',

  payment_provider       TEXT NOT NULL DEFAULT 'paypal',
  paypal_order_id        TEXT,
  paypal_capture_id      TEXT,

  customer_name          TEXT NOT NULL,
  customer_email         TEXT NOT NULL,
  customer_phone         TEXT,

  shipping_country       TEXT NOT NULL,
  shipping_address       TEXT NOT NULL,
  shipping_postal_code   TEXT NOT NULL,
  shipping_city          TEXT NOT NULL,
  shipping_region        TEXT,
  shipping_method        TEXT NOT NULL,
  shipping_cost          INTEGER NOT NULL,   -- cêntimos

  subtotal               INTEGER NOT NULL,   -- cêntimos
  total                  INTEGER NOT NULL,   -- cêntimos
  total_weight_g         INTEGER NOT NULL,
  currency               TEXT NOT NULL DEFAULT 'EUR',

  -- true (1) para encomendas de teste (Sandbox) — nunca misturadas com
  -- encomendas reais em relatórios/exportações (secção 33).
  is_test                INTEGER NOT NULL DEFAULT 1,

  -- Marcado quando o pagamento foi confirmado mas o stock já não estava
  -- disponível para 1+ artigos (caso raro de overselling — ver docs/orders.md
  -- secção "Limitações"). Exige intervenção manual (reembolso) por agora.
  stock_conflict         INTEGER NOT NULL DEFAULT 0,

  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orders_paypal_order_id ON orders(paypal_order_id);
CREATE INDEX IF NOT EXISTS idx_orders_customer_email ON orders(customer_email);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

-- ---------------------------------------------------------------------------
-- order_items: produtos de cada encomenda, com SNAPSHOT dos valores no
-- momento da compra (nome, preço, peso, unit_count). Nunca reconstruído a
-- partir do catálogo atual — ver secção 15 do pedido da Fase 5.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id         INTEGER NOT NULL REFERENCES orders(id),

  sku              TEXT NOT NULL,
  product_name     TEXT NOT NULL,     -- snapshot
  quantity         INTEGER NOT NULL,  -- packs/unidades de venda compradas

  unit_price       INTEGER NOT NULL,  -- cêntimos, snapshot (preço de 1 unidade de venda)
  unit_weight_g    INTEGER NOT NULL,  -- snapshot
  unit_count       INTEGER,           -- snapshot; null quando não definido no Excel

  total_price      INTEGER NOT NULL,  -- unit_price * quantity
  total_weight_g   INTEGER NOT NULL   -- unit_weight_g * quantity
);

CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);

-- ---------------------------------------------------------------------------
-- idempotency_keys: protege a CRIAÇÃO de encomendas contra duplo
-- clique/retry de rede (Idempotency-Key enviado pelo frontend).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key         TEXT PRIMARY KEY,
  order_id    INTEGER NOT NULL REFERENCES orders(id),
  created_at  TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- webhook_events: protege o PROCESSAMENTO de webhooks do PayPal contra
-- reenvios duplicados (o PayPal pode entregar o mesmo evento mais do que
-- uma vez) — chave primária garante que cada event_id só é processado uma
-- única vez mesmo sob concorrência.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS webhook_events (
  event_id       TEXT PRIMARY KEY,
  event_type     TEXT,
  order_number   TEXT,
  processed_at   TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- shipments: envio (transportadora) associado a uma encomenda paga
-- (Fase 6 — ver backend/src/shipping/ e docs/shipping.md).
--
-- Separado propositadamente de `orders.status` (estado comercial) e de
-- `orders.payment_status` (estado do pagamento) — `shipments.status`
-- guarda exclusivamente o estado LOGÍSTICO do envio junto da
-- transportadora (LABEL_CREATED, IN_TRANSIT, DELIVERED, ...).
--
-- Uma encomenda pode, em teoria, ter mais do que um envio ao longo do
-- tempo (ex.: envio cancelado e recriado com outra transportadora) —
-- por isso esta tabela não é 1:1 com `orders`; a UNIQUE constraint em
-- (order_id, provider) impede duplicar um envio ATIVO para a MESMA
-- transportadora na mesma encomenda (proteção de idempotência —
-- ver createShipmentForOrder em shipping/shipments.js, que também
-- verifica isto em código antes de chamar a transportadora).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shipments (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id           INTEGER NOT NULL REFERENCES orders(id),

  provider           TEXT NOT NULL,     -- 'inpost' | 'ctt' | futuras transportadoras
  service            TEXT NOT NULL,     -- id do serviço/método dentro do provider (ex.: 'inpost_locker')

  shipment_id        TEXT NOT NULL,     -- id do envio devolvido pela transportadora
  tracking_number    TEXT,
  tracking_url       TEXT,
  label_reference    TEXT,              -- referência/URL da etiqueta, quando obtida (ver getShipmentLabel)

  pickup_point_id    TEXT,              -- id do ponto de recolha, quando aplicável (ver secção 6 do pedido)
  pickup_point_data  TEXT,              -- JSON com nome/morada do ponto, snapshot no momento da escolha

  -- LABEL_CREATED | READY_TO_SHIP | SHIPPED | IN_TRANSIT | OUT_FOR_DELIVERY | DELIVERED | DELIVERY_FAILED | RETURNED
  status             TEXT NOT NULL DEFAULT 'LABEL_CREATED',

  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,

  UNIQUE (order_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_shipments_order_id ON shipments(order_id);
CREATE INDEX IF NOT EXISTS idx_shipments_provider_shipment_id ON shipments(provider, shipment_id);
