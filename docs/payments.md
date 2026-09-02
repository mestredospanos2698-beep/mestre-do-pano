# Mestre do Pano — Pagamentos e Backend (Fase 4)

Este documento descreve a arquitetura de pagamentos introduzida na Fase 4:
backend serverless, PayPal Sandbox, e a integração do peso real (`Peso (g)`)
no cálculo dos portes.

**Estado atual: Sandbox / testes. Nenhum pagamento real é processado.**

---

## 1. Arquitetura

```
GitHub Pages (frontend estático)
        │
        │  fetch (fala apenas com o backend, nunca com o PayPal diretamente
        │  para criar/capturar pagamentos)
        ▼
Cloudflare Worker (backend serverless) — mestre-do-pano-api
        │
        ├── recalcula sempre: preço, peso, portes, total
        │   (a partir de data/products.json + data/shipping.json +
        │    data/countries.json, publicados no próprio GitHub Pages)
        │
        ├── guarda encomendas em Cloudflare KV (ORDERS_KV)
        │
        └── fala com o PayPal REST API (Sandbox)
                │
                ▼
        PayPal Sandbox (api-m.sandbox.paypal.com)
```

O frontend nunca:
- calcula o valor final a cobrar;
- decide sozinho se um pagamento foi concluído;
- tem acesso a `PAYPAL_CLIENT_SECRET` ou `PAYPAL_WEBHOOK_ID`.

O backend é a única fonte de verdade para preço, peso, portes, total e
estado do pagamento.

---

## 2. Backend escolhido: Cloudflare Workers

Foi escolhido **Cloudflare Workers** (não Vercel/Netlify Functions) por:
- plano gratuito generoso, adequado a uma loja pequena;
- KV incluído (`ORDERS_KV`) — suficiente para esta fase, sem precisar de
  contratar uma base de dados definitiva já;
- deploy simples via `wrangler`, sem necessitar de servidor próprio;
- boa integração com sites 100% estáticos (GitHub Pages) através de CORS.

Estrutura do código: `backend/`

```
backend/
├── wrangler.toml         # configuração do Worker (nomes, KV, vars públicas)
├── package.json
├── .env.example           # placeholders — copiar para .dev.vars localmente
├── src/
│   ├── index.js            # router com todos os endpoints /api/*
│   ├── pricing.js           # recálculo puro de preço/peso/portes/total
│   ├── orders.js             # KV, idempotência, geração de orderId
│   ├── paypal.js              # cliente REST do PayPal (Sandbox)
│   ├── catalog.js              # busca products/shipping/countries.json
│   └── cors.js                  # cabeçalhos CORS
└── test/
    ├── pricing.test.js
    ├── orders.test.js
    └── paypal.test.js
```

---

## 3. Como o `Peso (g)` chega do Excel ao cálculo dos portes

```
Stock.xlsx
  coluna "Peso (g)"  (já existente, criada pelo proprietário da loja)
        ↓
tools/sync_stock.py
  lê APENAS essa coluna, valida (numérico, > 0), nunca estima/inventa
        ↓
data/products.json
  campo "weight_g" (inteiro, em gramas) — ou null + aviso, se inválido/em falta
        ↓
Frontend (js/shipping.js)
  computeCartWeightG() soma weight_g × qty de cada linha do carrinho,
  só para PRÉ-VISUALIZAR o total no ecrã de checkout
        ↓
Backend (backend/src/pricing.js → computeQuote)
  RECALCULA o peso total do zero a partir do SKU + quantidade enviados,
  ignorando qualquer peso que o frontend possa ter enviado
        ↓
data/shipping.json
  tabela de escalões de peso (kg) × país × método → preço (cêntimos)
        ↓
Total de portes = escalão correspondente ao peso total recalculado
```

Se um produto não tiver `weight_g` válido, o backend **recusa criar a
encomenda** com esse produto (`MISSING_PRODUCT_WEIGHT`) — nunca assume um
peso de substituição. O frontend mostra um aviso equivalente durante a
pré-visualização, para o cliente perceber antes de chegar ao pagamento.

### Exemplo de `products.json`

```json
{
  "id": "pareo-de-praia-verde-toalha-versatil-para-viagem-e-praia",
  "name": "Pareô de Praia Verde",
  "price": 7.4,
  "stock": 2,
  "weight_g": 200
}
```

### Exemplo de cálculo do peso total

```
Produto A → 82 g  × 3 = 246 g
Produto B → 120 g × 2 = 240 g
                        ─────
Peso total            = 486 g  (0,486 kg)
```

### Como os portes são calculados

1. O backend soma `weight_g × qty` de cada linha (nunca aceita um peso
   vindo do frontend).
2. Converte para kg (`totalWeightG / 1000`).
3. Consulta `data/shipping.json → rates[país][método]`, uma lista de
   escalões `{ maxWeight (kg), price (cêntimos) }`.
4. Usa o primeiro escalão cujo `maxWeight` seja ≥ ao peso total.
5. Se nenhum escalão servir (peso acima do limite máximo), a encomenda é
   recusada com o erro `WEIGHT_ABOVE_LIMIT`.

Os valores em `shipping.json` continuam a ser **valores de demonstração**
(herdados da Fase 3) — não são preços comerciais reais da CTT/InPost.

---

## 4. PayPal Sandbox

### 4.1 Criar a app Sandbox

1. Entrar em https://developer.paypal.com/dashboard/ (conta PayPal normal).
2. **Apps & Credentials → Sandbox → Create App**.
3. Copiar o **Client ID** (público) e o **Secret** (nunca partilhar).
4. Em **Sandbox → Accounts**, confirmar que existe uma conta *Business*
   (para receber) e uma conta *Personal* (para simular o comprador).

### 4.2 Configurar o Webhook Sandbox

1. Na app criada, secção **Webhooks → Add Webhook**.
2. URL: `https://<o-teu-worker>.workers.dev/api/webhooks/paypal`
3. Eventos a subscrever (mínimo):
   - `PAYMENT.CAPTURE.COMPLETED`
   - `PAYMENT.CAPTURE.DENIED`
   - `CHECKOUT.ORDER.APPROVED`
   - `CHECKOUT.ORDER.VOIDED`
4. Copiar o **Webhook ID** gerado → vai para `PAYPAL_WEBHOOK_ID`.

### 4.3 Fluxo de pagamento

```
Cliente preenche o checkout
        ↓
Frontend → POST /api/orders (backend recalcula tudo, cria encomenda PAYMENT_PENDING)
        ↓
Botões PayPal (SDK) aparecem no checkout
        ↓
createOrder()  → frontend → POST /api/paypal/create-order → backend cria a
                  ordem no PayPal com o TOTAL calculado pelo backend
        ↓
Cliente aprova no popup do PayPal Sandbox (com a conta Personal de teste)
        ↓
onApprove()   → frontend → POST /api/paypal/capture-order → backend CAPTURA
                  o pagamento no PayPal e confirma que o valor capturado é
                  exatamente igual ao total calculado
        ↓
Backend atualiza o estado da encomenda → PAYMENT_COMPLETED (ou PAYMENT_FAILED)
        ↓
Frontend mostra a confirmação (lida do backend, nunca assumida sozinha)
        ↓
PayPal também envia um webhook (confirmação independente/assíncrona) →
  /api/webhooks/paypal — verificado com a assinatura oficial do PayPal
```

---

## 5. Endpoints do backend

| Método | Rota                         | Função                                                                 |
|--------|-------------------------------|-------------------------------------------------------------------------|
| GET    | `/api/health`                 | Verificação simples de que o Worker está online.                       |
| POST   | `/api/orders`                 | Recalcula tudo e cria a encomenda (`PAYMENT_PENDING`). Aceita `Idempotency-Key`. |
| GET    | `/api/orders/:orderId`        | Estado público da encomenda (para a UI de confirmação/polling).        |
| POST   | `/api/paypal/create-order`    | Cria a ordem correspondente no PayPal, com o total já calculado.       |
| POST   | `/api/paypal/capture-order`   | Captura o pagamento e confirma o valor capturado antes de marcar como pago. |
| POST   | `/api/webhooks/paypal`        | Recebe e valida webhooks do PayPal (assinatura oficial obrigatória).   |

### Exemplo — criar encomenda

```http
POST /api/orders
Idempotency-Key: 6f2b6e6a-...-uuid

{
  "customer": { "name": "Ana Silva", "email": "ana@example.com", "phone": "912345678" },
  "shipping": { "country": "PT", "method": "ctt", "address": "Rua X, 1", "postalCode": "1000-001", "city": "Lisboa" },
  "items": [ { "sku": "pareo-de-praia-verde-...", "qty": 2 } ]
}
```

Resposta:

```json
{
  "orderId": "MP-20260902-7K3N9Q",
  "status": "PAYMENT_PENDING",
  "currency": "EUR",
  "subtotal": 1480,
  "shippingCost": 476,
  "total": 1956,
  "totalWeightG": 400
}
```

---

## 6. Segurança

- `PAYPAL_CLIENT_SECRET` e `PAYPAL_WEBHOOK_ID` só existem como **secrets do
  Worker** (`wrangler secret put`), nunca em código, `.env` versionado,
  `products.json`, `shipping.json` ou GitHub Pages.
- **Preço, peso, portes e total são sempre recalculados no backend** a
  partir de SKU + quantidade. Qualquer `price`, `subtotal`, `shippingCost`
  ou `total` que o frontend envie é ignorado (ver `pricing.js`).
- **Idempotência**:
  - Criação de encomenda: cabeçalho `Idempotency-Key` — a mesma chave
    devolve sempre a mesma encomenda em vez de criar outra.
  - Criação da ordem PayPal: cabeçalho `PayPal-Request-Id` (= `orderId`) —
    o próprio PayPal deduplica do seu lado.
  - Captura: se a encomenda já estiver `PAYMENT_COMPLETED`, o backend
    devolve o estado atual em vez de capturar outra vez.
  - Webhooks: cada `event.id` do PayPal só é processado uma vez
    (`ORDERS_KV` guarda os IDs já vistos).
- **Verificação do valor capturado**: depois de o PayPal devolver
  `status: COMPLETED`, o backend confirma que o valor efetivamente
  capturado é igual, cêntimo a cêntimo, ao total calculado — só aí marca
  a encomenda como paga.
- **Webhooks nunca são aceites sem verificação de assinatura**
  (`/v1/notifications/verify-webhook-signature`, API oficial do PayPal).
- **Dados pessoais**: o carrinho (`productId` + `qty`) continua em
  `localStorage`; nome/morada/telefone/email nunca são guardados
  permanentemente no browser. Nos logs do backend, os dados do cliente são
  sempre redigidos (`redactCustomerForLogs`) antes de serem escritos.
- **CORS**: o Worker só aceita pedidos com origem = `ALLOWED_ORIGIN`
  (o domínio do GitHub Pages da loja).
- **Cartões**: não são processados diretamente — a arquitetura está
  preparada para acrescentar Stripe/Cartão via PayPal mais tarde sem mudar
  a estrutura da encomenda; nunca se guarda número de cartão nem CVV.

---

## 7. Variáveis de ambiente

Ficheiro `backend/.env.example` (copiar para `backend/.dev.vars` em
desenvolvimento local — nunca commitar o `.dev.vars`):

```
PAYPAL_CLIENT_ID=
PAYPAL_CLIENT_SECRET=
PAYPAL_ENVIRONMENT=sandbox
PAYPAL_WEBHOOK_ID=
```

Variáveis não-secretas (já em `backend/wrangler.toml → [vars]`):

```
PAYPAL_ENVIRONMENT = "sandbox"
ALLOWED_ORIGIN      = "https://SEU-UTILIZADOR.github.io"
PRODUCTS_URL        = ".../data/products.json"
SHIPPING_URL        = ".../data/shipping.json"
COUNTRIES_URL       = ".../data/countries.json"
CURRENCY            = "EUR"
```

Em produção:

```bash
cd backend
wrangler secret put PAYPAL_CLIENT_ID
wrangler secret put PAYPAL_CLIENT_SECRET
wrangler secret put PAYPAL_WEBHOOK_ID
```

No frontend, `js/config.js` (público, sem secrets):

```js
window.MestreDoPanoConfig = {
  API_BASE_URL: 'https://mestre-do-pano-api.<subdominio>.workers.dev',
  PAYPAL_CLIENT_ID: '<Client ID Sandbox — é público>',
  PAYPAL_CURRENCY: 'EUR',
};
```

---

## 8. Configuração — passo a passo

1. `cd backend && npm install`
2. Criar o KV: `npx wrangler kv namespace create ORDERS_KV` (e o preview:
   `npx wrangler kv namespace create ORDERS_KV --preview`) → colar os IDs
   devolvidos em `wrangler.toml`.
3. Editar `wrangler.toml → [vars]` com o domínio real do GitHub Pages e os
   URLs reais de `products.json` / `shipping.json` / `countries.json`.
4. `cp .env.example .dev.vars` e preencher com as credenciais Sandbox.
5. `npm run dev` para testar localmente (`wrangler dev`).
6. `npm run deploy` para publicar o Worker.
7. Configurar os secrets em produção (`wrangler secret put ...`).
8. Editar `js/config.js` no frontend com o URL do Worker publicado e o
   `PAYPAL_CLIENT_ID` Sandbox.
9. Publicar o frontend no GitHub Pages, como habitualmente.

---

## 9. Testes

```bash
cd backend
npm test          # node --test test/*.test.js
```

Cobertura atual (31 testes):

- **Peso** (`pricing.test.js`): peso válido, produto sem peso (bloqueia com
  `MISSING_PRODUCT_WEIGHT`), várias unidades, vários produtos, peso total
  correto, escalão de portes correto.
- **Checkout** (`pricing.test.js`): SKU inválido, quantidade inválida
  (zero/negativa), país inválido, país desativado, método de entrega
  inválido, carrinho vazio.
- **Segurança** (`pricing.test.js`): preço manipulado é ignorado, portes/
  subtotal/total manipulados são ignorados, quantidade acima do stock é
  rejeitada, peso acima do limite é rejeitado, total = subtotal + portes
  sempre em cêntimos inteiros.
- **Encomendas/idempotência** (`orders.test.js`): formato do `orderId`,
  redação de PII em logs, criação com totais recalculados, duplo clique
  com a mesma `Idempotency-Key` não duplica a encomenda, chaves diferentes
  criam encomendas diferentes, validação de cliente/morada incompletos,
  deduplicação de eventos de webhook.
- **PayPal** (`paypal.test.js`): total enviado ao PayPal é sempre o do
  backend, captura falhada devolve `ok:false`, captura bem-sucedida
  devolve `COMPLETED`, extração do valor capturado em cêntimos,
  verificação de assinatura de webhook rejeita quando faltam cabeçalhos e
  só aceita com `verification_status: SUCCESS`.

Testes do peso no `sync_stock.py`:

```bash
python tools/test_sync_stock.py
```

10/10 testes: peso válido, peso como texto numérico, peso em falta, string
vazia, texto inválido (`"abc"`), texto com unidade (`"82 gramas"`), peso
negativo, peso zero, peso decimal arredondado, coluna em falta.

---

## 10. Como passar para produção no futuro

Quando a loja estiver pronta para pagamentos reais:

1. Criar uma app **Live** no PayPal Developer Dashboard (não Sandbox).
2. Substituir os secrets do Worker pelos valores Live
   (`wrangler secret put PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` /
   `PAYPAL_WEBHOOK_ID`, agora com as credenciais de produção).
3. Mudar `PAYPAL_ENVIRONMENT` para `"live"` em `wrangler.toml`.
4. Atualizar `js/config.js` com o `PAYPAL_CLIENT_ID` Live.
5. Configurar o Webhook Live com o mesmo URL do Worker.
6. Testar cuidadosamente com um pagamento real de valor baixo antes de
   anunciar a loja como "ao vivo".
7. Nesta altura (ou antes), implementar também: redução real de stock após
   `PAYMENT_COMPLETED`, base de dados definitiva (em vez de só KV), emails
   automáticos de confirmação, e faturação.

---

## 11. Limitações desta fase

- Sem gestão completa de stock — o stock só é lido, nunca reduzido
  automaticamente (arquitetura preparada, comentário no código onde
  entraria).
- Sem InPost/CTT/GLS/DPD reais — `shipping.json` continua com valores de
  demonstração.
- Sem etiquetas, tracking, envio automático ou emails automáticos.
- Sem painel administrativo nem faturação.
- Sem base de dados definitiva — encomendas ficam em Cloudflare KV (30
  dias de retenção nesta fase).
- Sem pagamentos por cartão direto — só PayPal Sandbox nesta fase (a
  arquitetura já suporta acrescentar cartão/Stripe sem alterar a
  estrutura da encomenda).
- **Nenhum pagamento real é processado nesta fase** — tudo em PayPal
  Sandbox.

Estas funcionalidades ficam para a Fase 5, juntamente com as
transportadoras reais (InPost/CTT), que não foram implementadas nesta
fase por indicação explícita do pedido.
