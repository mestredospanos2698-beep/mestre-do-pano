# Mestre do Pano — Encomendas, Stock e Base de Dados (Fase 5)

Este documento descreve a arquitetura introduzida na Fase 5: preço por
unidade, base de dados real (Cloudflare D1), sistema de encomendas com
snapshot de valores, e proteção contra overselling.

Ver também `docs/payments.md` (Fase 4 — PayPal Sandbox, ainda válido) e
`README.md`.

**Estado atual: Sandbox / testes. Nenhum pagamento real é processado.**

---

## 1. Porque Cloudflare D1

A Fase 4 usava Cloudflare KV (`ORDERS_KV`) como protótipo de armazenamento
de encomendas — suficiente para guardar/ler um objeto JSON por chave, mas
sem:

- consultas relacionais (ex.: "todos os items de uma encomenda");
- constraints (chave única, chave estrangeira);
- transações/condições atómicas (`WHERE available_stock >= ?`) necessárias
  para proteger o stock contra overselling.

Foi escolhido **Cloudflare D1** (SQLite gerido pela Cloudflare) em vez de
Supabase/Neon/Postgres externo porque:

- corre na mesma plataforma do Worker já criado na Fase 4 — sem outra
  conta, outro fornecedor, ou outra rede a atravessar;
- sem custo adicional (plano gratuito generoso, adequado a uma loja
  pequena, tal como o Worker e o KV da Fase 4);
- `wrangler d1` já vem incluído na mesma toolchain (`wrangler`) que já
  publica o Worker;
- SQLite é suficiente para o volume de uma loja pequena e é fácil de testar
  localmente e em CI (`node:sqlite`, ver secção 6);
- liga-se ao Worker por binding direto (`env.DB`), sem gerir strings de
  ligação/segredos extra.

Alternativas consideradas e não escolhidas: Supabase/Neon (Postgres) —
mais poder relacional, mas outra conta/rede/latência extra sem necessidade
real ao volume desta loja; ficam como opção futura se a loja crescer muito
(ex.: relatórios complexos, múltiplos writers concorrentes fora do Worker).

---

## 2. Arquitetura geral

```
Stock.xlsx  (fonte do CATÁLOGO — preço, peso, unidades, stock "no papel")
    │  tools/sync_stock.py
    ▼
data/products.json  (publicado no GitHub Pages)
    │
    │  GET periódico (cache 60s) — backend/src/catalog.js
    ▼
Cloudflare Worker (mestre-do-pano-api)
    │
    ├── tabela `stock` (D1) — fonte de verdade do STOCK REAL DE VENDA
    │     catalog_stock   = última leitura do products.json
    │     available_stock = quanto pode realmente ser vendido agora
    │                        (nunca sobrescrito pelo Excel — só por delta)
    │
    ├── tabela `orders` + `order_items` (D1) — encomendas, com SNAPSHOT
    │     dos valores no momento da compra (nunca reconstruído a partir
    │     do catálogo atual)
    │
    ├── tabela `idempotency_keys` — protege contra duplo clique na criação
    │
    ├── tabela `webhook_events` — protege contra reprocessamento de
    │     webhooks duplicados do PayPal
    │
    └── fala com o PayPal REST API (Sandbox) — ver docs/payments.md
```

Estrutura do código (`backend/`):

```
backend/
├── schema.sql              # tabelas D1 (stock, orders, order_items, idempotency_keys, webhook_events)
├── wrangler.toml            # binding D1 (env.DB) + Cron Trigger de sincronização de stock
├── src/
│   ├── db.js                 # camada de acesso a D1 (stock, orders, idempotência, webhooks)
│   ├── orders.js              # regras de negócio: criar encomenda, aplicar pagamento, sincronizar stock
│   ├── index.js                 # router HTTP + scheduled() do Cron Trigger
│   ├── pricing.js                 # recálculo puro de preço/peso/portes/total (Fase 4, com unit_count desde a Fase 5)
│   ├── paypal.js                    # cliente REST do PayPal (Fase 4, sem alterações)
│   └── catalog.js                    # busca products/shipping/countries.json (Fase 4, sem alterações)
└── test/
    ├── d1-sqlite-adapter.js    # adaptador D1 sobre node:sqlite, só para testes
    ├── db.test.js               # testes de backend/src/db.js
    ├── orders.test.js            # testes de backend/src/orders.js
    ├── paypal.test.js             # testes de backend/src/paypal.js (Fase 4, inalterados)
    └── pricing.test.js             # testes de backend/src/pricing.js (peso + preço por unidade)
```

---

## 3. Tabela `stock` — stock real de venda vs. catálogo

Ver `schema.sql` para os comentários completos. Resumo da regra mais
importante desta fase:

```
catalog_stock    → última leitura do Stock.xlsx (via products.json)
available_stock  → quanto está realmente disponível para venda agora
                   (já descontando encomendas pagas)
```

Uma sincronização do catálogo (Cron Trigger a cada 10 minutos, ver
`wrangler.toml → [triggers]`, ou o endpoint interno
`/api/internal/sync-stock`) **nunca sobrescreve** `available_stock` com o
valor do Excel — em vez disso aplica o **delta**:

```
novo available_stock = available_stock atual + (novo catalog_stock - catalog_stock antigo)
```

Exemplos (`computeSyncedAvailableStock`, em `backend/src/db.js`):

| Situação                                             | Resultado                                    |
|-------------------------------------------------------|-----------------------------------------------|
| Produto novo (sem linha ainda), catalog_stock = 20    | available_stock = 20                          |
| Dono repõe no Excel de 0 para 5 (+5)                  | available_stock += 5                          |
| Dono corrige Excel de 10 para 8 (-2), já com 3 vendas | 7 → 5 (nunca "volta" a 8 ou 10)               |
| Delta deixaria o valor negativo                       | `available_stock` fica sempre em `max(0, …)`  |

`available_stock` é o único campo usado para decidir se uma venda pode
acontecer — nunca `catalog_stock` diretamente, e nunca o campo `stock`
do `products.json` publicado (que é só a "foto" do Excel).

---

## 4. Proteção contra overselling

`decrementStockForOrder` (`backend/src/db.js`) só é chamado **depois** da
captura PayPal confirmada (`applyStockDecrementForPaidOrder`, em
`backend/src/orders.js`, chamado a partir de
`handleCapturePayPalOrder` em `index.js`) — nunca em `PENDING_PAYMENT`.

Cada linha é reduzida com uma única instrução SQL condicional e atómica:

```sql
UPDATE stock
SET available_stock = available_stock - ?, updated_at = ?
WHERE sku = ? AND available_stock >= ?
```

Como o SQLite serializa escritas na mesma base de dados, mesmo que dois
clientes tentem comprar "ao mesmo tempo" as últimas unidades do mesmo
produto, apenas um `UPDATE` terá `changes = 1` — o outro fica com
`changes = 0` e é tratado como conflito (ver `db.test.js`, teste
"proteção contra overselling concorrente").

### Limitação conhecida: encomendas multi-item

O D1 não suporta (ainda) transações interativas multi-instrução. Para uma
encomenda com vários artigos, a abordagem usada é
**"tentar tudo, compensar se algo falhar"**:

1. Reduz item a item, um `UPDATE` atómico por SKU.
2. Se algum falhar por falta de stock, **devolve** (compensa) o stock já
   reduzido dos itens anteriores dessa mesma encomenda.
3. Devolve `{ ok: false, conflicts: [sku, ...] }`.

Isto evita "reduzir só parte" de uma encomenda, mas não é uma transação
verdadeiramente atómica ao nível da base de dados — existe uma janela
(muito curta) entre os `UPDATE`s onde outro pedido concorrente poderia, em
teoria, intercalar-se com um dos SKUs já reduzidos e não ainda
compensados. Para o volume desta loja (poucas encomendas em simultâneo,
poucos artigos por encomenda) o risco é aceitável; ver secção 7.

### Caso raro: pagamento confirmado mas stock esgotado entretanto

Se o PayPal confirmar o pagamento mas, entre a criação da encomenda e a
captura, o stock de 1+ artigo esgotar (outro cliente comprou as últimas
unidades primeiro), a encomenda fica marcada com `stock_conflict = 1` na
tabela `orders`. **Não há reembolso automático nesta fase** — exige
intervenção manual (verificar a encomenda, contactar o cliente,
reembolsar via PayPal Sandbox/Dashboard se necessário). Fica para uma
fase futura automatizar isto.

---

## 5. Encomendas: estados e snapshot

### 5.1 `status` vs `payment_status`

Mantidos sempre **separados** (uma encomenda pode estar `PAID` mas ainda
`PROCESSING` no armazém, por exemplo):

```
status:          PENDING_PAYMENT | PAID | PROCESSING | SHIPPED | DELIVERED | CANCELLED | REFUNDED
payment_status:  PENDING | COMPLETED | FAILED | CANCELLED | REFUNDED
```

Fluxo normal:

```
createOrder()          → status=PENDING_PAYMENT, payment_status=PENDING
POST /paypal/create-order → paypal_order_id gravado
Cliente aprova no PayPal
POST /paypal/capture-order → captura confirmada e valor validado
                          → status=PAID, payment_status=COMPLETED
                          → decrementStockForOrder() chamado agora
                          → status=PROCESSING
(fases futuras)         → status=SHIPPED → DELIVERED
```

### 5.2 Snapshot em `order_items`

Cada `order_items` guarda uma **cópia** do nome, preço, peso e
`unit_count` do produto no momento da compra — nunca é reconstruído a
partir do catálogo atual. Isto garante que, mesmo que o preço ou o
`unit_count` de um produto mude no Excel mais tarde, o histórico de uma
encomenda antiga continua a mostrar exatamente o que o cliente pagou.

---

## 6. Testes (adaptador D1 sobre `node:sqlite`)

`backend/test/d1-sqlite-adapter.js` imita a API pública do D1
(`db.prepare(sql).bind(...).run()/.first()/.all()`, incluindo
`result.meta.changes` e `result.meta.last_row_id`) usando `node:sqlite`
(`DatabaseSync`, built-in a partir do Node 22 — o mesmo motor SQLite
usado pelo D1). Isto permite testar `backend/src/db.js` e
`backend/src/orders.js` sem rede e sem depender de `wrangler d1 dev`.

```bash
cd backend
npm install
npm test          # node --test test/*.test.js
```

Cobertura atual (62 testes):

- **`db.test.js`** (22 testes): `computeSyncedAvailableStock` (produto
  novo, reposição, correção para baixo nunca devolve vendas, nunca fica
  negativo), `syncStockFromCatalog` (cria/atualiza/ignora sem alterar
  vendas), `decrementStockForOrder` (reduz com stock suficiente, rejeita
  sem alterar nada, compensação em encomenda multi-item, **overselling
  concorrente** com `Promise.all`), `restockOrderItems`, `insertOrder`
  (snapshot, `unit_count` nulo sem inventar valor), `getOrderByNumber`,
  `updateOrderFields`, idempotência de encomendas (`idempotency_keys`,
  incluindo `INSERT OR IGNORE` sob duas chamadas com a mesma chave) e de
  webhooks (`webhook_events`, incluindo reclamação concorrente do mesmo
  `event_id`).
- **`orders.test.js`** (12 testes): formato do `orderNumber`, redação de
  PII em logs, criação com totais recalculados, idempotência
  (`Idempotency-Key`), validação de cliente/morada, leitura por número,
  deduplicação de webhook, sincronização de stock a partir do
  `products.json` mockado, e `applyStockDecrementForPaidOrder` (sucesso e
  `stock_conflict`).
- **`paypal.test.js`** (7 testes, Fase 4, sem alterações): continuam a
  passar sem modificações — este módulo não depende de KV nem de D1,
  só de `order.total`/`order.orderId` como campos soltos.
- **`pricing.test.js`** (36 testes, Fase 4 + preço por unidade da Fase 5):
  peso, checkout, segurança, portes, total, e os 5 testes de preço por
  unidade (`€12,00/5`, `€24,90/10`, regra do 1, `unit_count` em falta,
  `quantity` nunca confundido com `unit_count`).

Testes do peso/unidades no `sync_stock.py` (Python, sem alterações de
comportamento nesta fase, só a leitura da nova coluna `Unidades`):

```bash
python tools/test_sync_stock.py
```

20/20 testes: 10 de peso (Fase 4) + 10 de `Unidades`/`unit_count`
(válido = 1, válido > 1, como texto numérico, em falta, string vazia,
zero inválido, negativo inválido, decimal inválido, texto inválido,
coluna em falta).

---

## 7. Configuração — passo a passo (D1)

1. `cd backend && npm install`
2. Criar a base de dados: `npx wrangler d1 create mestre-do-pano-db` →
   copiar o `database_id` devolvido para `wrangler.toml → [[d1_databases]]`.
3. Aplicar o schema:
   - Local/dev: `npm run db:migrate:local`
   - Produção: `npm run db:migrate:remote`
4. Confirmar o Cron Trigger em `wrangler.toml → [triggers]` (por defeito,
   sincroniza o stock a cada 10 minutos).
5. `npm run dev` para testar localmente (`wrangler dev`, usa a D1 local).
6. `npm run deploy` para publicar o Worker com a D1 remota.
7. Chamar `POST /api/internal/sync-stock` uma vez (ou esperar pelo Cron)
   para popular a tabela `stock` a partir do `products.json` publicado.

O resto da configuração (secrets do PayPal, `js/config.js`, GitHub Pages)
mantém-se igual ao descrito em `docs/payments.md`.

---

## 8. Preço por unidade (recapitulação)

Ver `README.md`/`docs/payments.md` para o fluxo completo do peso; aqui só
a parte nova da Fase 5:

- `Stock.xlsx` ganha a coluna `Unidades` (preenchida manualmente pelo
  dono da loja) → `tools/sync_stock.py` lê-a e grava `unit_count` em
  `products.json`, validando que é um número inteiro positivo (nunca
  assume `1`, nunca inventa).
- `backend/src/pricing.js` calcula `perPhysicalUnitPriceCents =
  round(unitPriceCents / unitCount)` **apenas quando `unitCount > 1`**;
  quando `unitCount === 1` ou é `null` (em falta/inválido no Excel), o
  campo fica `null` e a interface não mostra "preço por unidade" nem
  "pack com 1 unidade".
- `order_items.unit_count` guarda o snapshot deste valor no momento da
  compra, tal como o preço e o peso.
- O frontend (`js/main.js`, `js/products.js`, `js/cart.js`,
  `js/checkout.js`) mostra "Pack com N unidades" + "€X / unidade" só
  quando `unit_count > 1`.

---

## 9. Limitações desta fase

- Encomendas multi-item não são reduzidas em stock dentro de uma
  transação SQL verdadeiramente atómica (ver secção 4) — mitigado por
  compensação, não por `BEGIN/COMMIT` multi-instrução (D1 ainda não
  suporta transações interativas).
- Sem reembolso automático quando `stock_conflict = 1` — exige
  intervenção manual.
- Sem painel administrativo para gerir encomendas (`status`,
  `SHIPPED`/`DELIVERED`) — atualização feita diretamente na base de dados
  ou via chamadas manuais à API por agora.
- Sem faturação nem emails automáticos de confirmação.
- Continua tudo em PayPal Sandbox — nenhum pagamento real processado.

Estas ficam para uma fase futura.
