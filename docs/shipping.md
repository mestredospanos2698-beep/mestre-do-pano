# Mestre do Pano — Logística real: InPost + CTT (Fase 6)

Este documento descreve a arquitetura de transportadoras introduzida na
Fase 6: interface abstrata `ShippingProvider`, portes reais, pontos de
recolha, criação de envios/etiquetas, tracking e webhooks — sobre a base
de dados D1 criada na Fase 5.

Ver também `docs/orders.md` (Fase 5 — encomendas/stock/overselling) e
`docs/payments.md` (Fase 4 — PayPal Sandbox).

**Estado atual: nenhuma transportadora está operacional em produção
nesta fase.** InPost tem um cliente HTTP real mas sem conta comercial
confirmada para Portugal; CTT é um stub que recusa todas as operações.
Ver secções 3 e 4 para o detalhe exato do que foi e não foi confirmado.

---

## 1. Por que esta fase não "liga" InPost/CTT de imediato

Antes de escrever qualquer código de integração, foi feita uma
verificação direta (chamadas HTTP, sem inventar nada a partir de
memória/treino) à documentação e aos endpoints publicamente acessíveis
de cada transportadora. Resultado resumido:

| Transportadora | API pública documentada? | Sandbox self-service? | Conclusão |
|---|---|---|---|
| InPost | Sim — "ShipX API" (Polónia), hosts `*.easypack24.net` respondem e devolvem versão | Parcialmente — `GET /v1/points` funciona sem token | Cliente HTTP real implementado; operações autenticadas exigem conta comercial (token de organização) **não confirmada para Portugal** |
| CTT | Não encontrada | Não | Implementado como **stub que recusa** todas as operações |

Isto significa que esta fase entrega a **arquitetura completa e testável**
(interface abstrata, providers, base de dados, endpoints HTTP, fluxo de
idempotência/pagamento) mas **não entrega envios reais em produção** —
isso depende de passos comerciais fora do alcance de código (ver secção
13).

---

## 2. Arquitetura geral

```
Frontend (checkout.js)
    │  fetch — nunca fala diretamente com InPost/CTT
    ▼
Backend (Cloudflare Worker) — mestre-do-pano-api
    │
    ├── backend/src/shipping/provider.js
    │     interface abstrata ShippingProvider (getRates, getPickupPoints,
    │     createShipment, getLabel, trackShipment, cancelShipment,
    │     verifyWebhookSignature, parseWebhookEvent)
    │
    ├── backend/src/shipping/registry.js
    │     constrói o provider concreto certo a partir de `env`
    │     (SHIPPING_ENVIRONMENT explícito — nunca produção por omissão)
    │
    ├── backend/src/shipping/providers/inpost.js   (cliente HTTP real)
    ├── backend/src/shipping/providers/ctt.js       (stub que recusa)
    │
    ├── backend/src/shipping/shipments.js
    │     regras de negócio: peso a partir de order_items (nunca
    │     inventado), idempotência de criação de envio, obrigatoriedade
    │     de pagamento confirmado
    │
    └── tabela `shipments` (D1) — ver schema.sql
```

O checkout/encomendas nunca importa `InPostProvider`/`CTTProvider`
diretamente — fala sempre com a interface `ShippingProvider` através do
registry. Adicionar uma nova transportadora no futuro (DPD, GLS, ...) só
exige um novo ficheiro em `providers/` + registá-lo em `registry.js`.

---

## 3. InPost — o que foi confirmado e o que não foi

### Confirmado nesta fase (chamadas HTTP diretas, sem conta)

- `https://sandbox-api-shipx-pl.easypack24.net` e
  `https://api-shipx-pl.easypack24.net` respondem e devolvem
  `{"version": "..."}` — são hosts reais da "ShipX API" da InPost.
- `GET /v1/points` e `GET /v1/points/{id}` funcionam **sem
  autenticação** e devolvem dados reais de parcel lockers — mas este
  endpoint está alojado em `sandbox-api-pl-points.easypack24.net`, ou
  seja, é a base de pontos da InPost **Polónia** (`_pl_`).
- Qualquer endpoint autenticado (ex.: `GET /v1/organizations`) devolve
  `401 {"error":"token_invalid"}` sem um Bearer token válido — confirma
  que a API exige um **token de organização**, obtido apenas através de
  uma conta comercial InPost (painel "Manager"/"ShipX"), não através de
  registo self-service público.

### NÃO confirmado — não assumir

- A InPost em **Portugal** opera pela marca/infraestrutura "InPost
  Iberia" (antiga Mondial Relay, `inpost.pt`). O site institucional
  promove integração via **Web Service, plugins de e-commerce
  (PrestaShop/Shopify/WooCommerce/Magento) e EDI**, todos vendidos
  comercialmente — **não documenta publicamente** se essa integração
  usa a mesma ShipX API (`*-pl.easypack24.net`) da Polónia, uma API
  dedicada a Portugal, ou algo diferente.
- Não foi encontrado nenhum host equivalente confirmado para Portugal
  (ex.: `*-pt.easypack24.net`).
- **Antes de qualquer envio real em Portugal**, é obrigatório confirmar
  com o gestor de conta InPost/InPost Iberia: (a) o host/API correto
  para Portugal, (b) o formato de autenticação, (c) os serviços
  contratados (Locker/Ponto Pack vs. courier), (d) o formato de
  etiqueta suportado, (e) o mecanismo de webhooks.

### O que este backend faz hoje

`backend/src/shipping/providers/inpost.js`:

- `getPickupPoints({ country: 'PL', ... })` — funciona sem credenciais
  (usa o endpoint público). Qualquer país diferente de `PL` é
  **rejeitado explicitamente** com `COUNTRY_NOT_SUPPORTED` — nunca
  devolve pontos que não foram confirmados como servindo esse país.
- `getRates()`, `createShipment()`, `getLabel()`, `trackShipment()`,
  `cancelShipment()` — implementados segundo o padrão documentado
  publicamente da ShipX API (`/v1/organizations/{id}/shipments`, etc.),
  mas exigem `INPOST_API_TOKEN` + `INPOST_ORGANIZATION_ID` reais. Sem
  eles, lançam `NOT_CONFIGURED` em vez de simular uma resposta.
- `verifyWebhookSignature()` devolve sempre `false` — o mecanismo de
  assinatura de webhooks da InPost não foi confirmado nesta fase (sem
  conta). Nenhum webhook InPost é aceite como autenticado até isso ser
  confirmado com uma conta real.

---

## 4. CTT — por que é um stub

`developers.ctt.pt` e `api.ctt.pt` não resolvem/devolvem 404. O site
institucional (`ctt.pt/empresas/e-commerce-e-logistica`) descreve
integração via "Criar Lojas Online" (plataforma própria CTT), "Plugins
de expedição" para plataformas de terceiros, e um "Portal Logística" —
nenhum destes expõe uma API REST pública com sandbox self-service. A
CTT também opera a marca "CTT Express" (`cttexpress.com`) com adesão
contratual, cuja documentação técnica (se existir) está atrás de
contrato comercial.

Por indicação explícita do pedido desta fase, `backend/src/shipping/providers/ctt.js`
é um **stub** que:

- cumpre a interface `ShippingProvider` (para o sistema poder tratar
  `ctt` como uma transportadora válida na arquitetura);
- **recusa explicitamente** qualquer operação real
  (`getRates`, `getPickupPoints`, `createShipment`, `getLabel`,
  `trackShipment`, `cancelShipment`) com o código `NOT_CONFIGURED`;
- nunca devolve tarifas, pontos, envios, etiquetas ou tracking
  simulados/fictícios;
- `verifyWebhookSignature()` devolve sempre `false`.

Quando existir um contrato comercial com os CTT que disponibilize
documentação de API, reescrever este ficheiro à imagem de
`providers/inpost.js` — a interface e o resto do backend já estão
preparados e não precisam de mudar.

---

## 5. Estados: encomenda vs. pagamento vs. envio

Três conceitos, sempre separados (nunca misturados numa só coluna):

```
orders.status            PENDING_PAYMENT | PAID | PROCESSING | SHIPPED | DELIVERED | CANCELLED | REFUNDED
orders.payment_status    PENDING | COMPLETED | FAILED | CANCELLED | REFUNDED
shipments.status          LABEL_CREATED | READY_TO_SHIP | SHIPPED | IN_TRANSIT |
                          OUT_FOR_DELIVERY | DELIVERED | DELIVERY_FAILED | RETURNED
```

`shipments.status` (ver `SHIPMENT_STATUSES` em
`backend/src/shipping/shipments.js`) descreve exclusivamente o estado
logístico junto da transportadora — uma encomenda pode estar `PAID` na
tabela `orders` e ainda não ter nenhum `shipments` associado.

---

## 6. Peso e embalagem — nunca inventados

`buildPackageFromOrder()` (`backend/src/shipping/shipments.js`) constrói
o `PackageDetails` enviado ao provider a partir do peso já calculado em
`order.totalWeightG` (que por sua vez vem de `weight_g × quantity` de
cada `order_item`, snapshot da Fase 5):

```js
{
  weightG: order.totalWeightG,  // peso real, sempre presente
  lengthMm: null,                // NÃO existe no Stock.xlsx — nunca inventado
  widthMm: null,
  heightMm: null,
  numberOfPackages: 1,
}
```

Se uma transportadora exigir dimensões (comprimento/largura/altura) e
elas não existirem, o provider deve lançar
`MISSING_PACKAGE_DIMENSIONS` (ver `InPostProvider.createShipment`, que
já valida o peso desta forma) — nunca enviar zeros ou valores
fictícios. Nesta fase, nenhum produto tem dimensões no Excel; se forem
necessárias no futuro, devem ser adicionadas como nova coluna no
`Stock.xlsx` e lidas por `sync_stock.py`, exatamente como `Peso (g)` e
`Unidades` nas fases anteriores.

---

## 7. Portes reais — como são calculados

```
POST /api/shipping/rates
{ "provider": "inpost", "country": "PT", "totalWeightG": 500 }
    ↓
getRatesSafely(env, provider, input)
    ↓
provider.getRates(input)
    ↓ (nesta fase: sempre NOT_CONFIGURED ou NOT_SUPPORTED — ver secções 3/4)
{ "available": false, "reason": "NOT_CONFIGURED", "message": "..." }
```

O frontend (`js/checkout.js`) tenta sempre a cotação real primeiro; se
`available: false`, usa o tarifário manual de `data/shipping.json`
(herdado da Fase 3, ainda marcado `"demo": true`) como *fallback*
explícito e visível ao cliente ("tarifário de teste"). **O backend nunca
aceita um preço vindo do browser** — mesmo quando o frontend mostra o
valor de `shipping.json`, a criação da encomenda (`POST /api/orders`)
continua a recalcular tudo a partir de `data/shipping.json` no
`pricing.js` (arquitetura da Fase 4/5, inalterada), porque nenhuma
transportadora real fornece cotação autenticada nesta fase.

Quando uma conta comercial (InPost ou CTT) passar a fornecer cotação
real, `pricing.js` deve ser atualizado para preferir
`getRatesSafely` como fonte de verdade dos portes, com o mesmo
tarifário manual como *fallback* de segurança — a estrutura dos
endpoints já está pronta para isso.

---

## 8. Pontos de recolha

```
POST /api/shipping/pickup-points
{ "provider": "inpost", "country": "PT" }
    ↓
getPickupPointsSafely(env, 'inpost', { country: 'PT' })
    ↓
InPostProvider.getPickupPoints({ country: 'PT' })
    ↓ país ≠ 'PL' (único confirmado) → COUNTRY_NOT_SUPPORTED
{ "available": false, "reason": "COUNTRY_NOT_SUPPORTED", "message": "..." }
```

No checkout, quando o método selecionado tem `requiresPickupPoint: true`
(ver `data/shipping.json → methods[].requiresPickupPoint`), a secção
"Escolher ponto de recolha" é mostrada; se não houver pontos disponíveis
(caso atual para `PT`), o cliente vê uma mensagem explícita em vez de uma
lista vazia ou fictícia. A validação do formulário (`validate()` em
`checkout.js`) recusa avançar sem um ponto selecionado quando o método o
exige — cobre a secção 18 do pedido ("ponto de recolha obrigatório mas
não selecionado").

O ponto escolhido é guardado apenas em memória no frontend e enviado ao
backend só no momento de criar o **envio** (depois do pagamento
confirmado) — nunca faz parte do cálculo de preço da encomenda.

---

## 9. Criação de envio — só depois do pagamento confirmado

```
Cliente aprova o pagamento PayPal
        ↓
Backend captura o pagamento e confirma o valor (Fase 4/5, inalterado)
        ↓
orders.payment_status = 'COMPLETED'
        ↓
Frontend chama POST /api/shipping/create-shipment
{ orderNumber, provider, serviceId, pickupPointId }
        ↓
createShipmentForOrder(env, order, {...})
        ↓
  order.paymentStatus !== 'COMPLETED' ?  → rejeita (nunca cria envio de encomenda não paga)
  já existe shipments (order_id, provider) ativo ?  → devolve o existente (idempotência)
        ↓
provider.createShipment({...})  →  transportadora real (ou erro documentado)
        ↓
INSERT INTO shipments (...)
```

`createShipmentForOrder` (`backend/src/shipping/shipments.js`) faz as
duas verificações acima **antes** de chamar qualquer transportadora —
ver `backend/test/shipping/shipments.test.js` para os testes que cobrem
explicitamente "recusa criar envio se o pagamento não estiver
COMPLETED" e "idempotente numa segunda chamada".

### Idempotência

A tabela `shipments` tem `UNIQUE(order_id, provider)` (ver
`schema.sql`) — mesmo que duas chamadas a `/api/shipping/create-shipment`
cheguem para a mesma encomenda+transportadora (duplo clique, retry de
rede), só uma linha é criada. `createShipmentForOrder` também verifica
isto em código antes de chamar a transportadora, evitando criar dois
envios reais (e cobrar duas etiquetas) mesmo antes de a constraint da
base de dados entrar em jogo.

---

## 10. Etiquetas

```
GET /api/shipping/orders/:orderNumber/label?provider=inpost
    ↓
getShipmentLabel(env, shipment)
    ↓
provider.getLabel({ shipmentId })
```

Nunca é criada uma etiqueta nova se já existir um `shipments` válido
para a encomenda+provider — a etiqueta é sempre obtida a partir do
`shipmentId` já guardado. Substituir uma etiqueta exigiria cancelar o
envio (`POST /api/shipping/orders/:orderNumber/cancel`) e criar um novo,
nunca uma segunda etiqueta silenciosa para o mesmo envio.

Nesta fase, `getLabel` da InPost segue o padrão documentado da ShipX API
mas não foi testado com credenciais reais (não disponíveis); o CTT
recusa sempre.

---

## 11. Tracking

```
GET /api/shipping/orders/:orderNumber/tracking?provider=inpost
    ↓
refreshShipmentTracking(env, shipment)
    ↓
provider.trackShipment({ shipmentId, trackingNumber })
    ↓
mapInPostStatus(providerStatus) → um de SHIPMENT_STATUSES, ou o valor
                                    bruto se for um status desconhecido
                                    (nunca inventa uma equivalência)
    ↓
UPDATE shipments SET status = ...
```

Se a consulta à transportadora falhar, o endpoint devolve o último
estado conhecido guardado na base de dados mais um `warning` — nunca
apaga/corrompe o estado local por causa de uma falha temporária de rede.

Campos guardados por envio (ver `schema.sql → shipments`):
`provider`, `service`, `shipment_id`, `tracking_number`, `tracking_url`,
`label_reference`, `pickup_point_id`, `pickup_point_data`, `status`.

---

## 12. Webhooks

```
POST /api/webhooks/shipping/:provider
    ↓
provider.verifyWebhookSignature({ headers, rawBody })
    ↓ false (nesta fase, SEMPRE, para InPost e CTT — ver secções 3/4)
401 { "error": "Assinatura de webhook inválida ou não suportada." }
```

O endpoint já existe e está ligado a `applyShipmentWebhookEvent`
(atualiza o `shipments` correspondente pelo `shipmentId` do provider,
nunca por adivinhação) — mas, como **nenhuma transportadora tem
mecanismo de assinatura confirmado nesta fase**, nenhum webhook é
aceite como autenticado. Isto é uma escolha deliberada (secção 13 do
pedido: "evitar atualizar estados apenas porque alguém chamou
manualmente um endpoint") — o endpoint só passa a processar eventos
reais depois de `verifyWebhookSignature` ser implementado com a
documentação real da conta.

---

## 13. O que depende de uma conta comercial

- **InPost**: `INPOST_API_TOKEN` + `INPOST_ORGANIZATION_ID` (obtidos só
  com conta InPost/InPost Iberia); confirmação do host/API correto para
  Portugal; confirmação do mecanismo de assinatura de webhooks;
  confirmação dos serviços contratados (Locker/Ponto Pack vs. courier
  ao domicílio) e do formato de etiqueta.
- **CTT**: qualquer credencial/endpoint — não existe API pública
  documentada; depende de contrato comercial + documentação de
  integração fornecida pelos CTT (equipa de conta/logística).
- **Ambos**: confirmação de preços reais por peso/país/serviço (esta
  fase mantém `data/shipping.json` como tarifário manual de fallback,
  claramente identificado como valores de teste).

---

## 14. Configuração — passo a passo

1. `SHIPPING_ENVIRONMENT` em `backend/wrangler.toml → [vars]` — explícito
   (`"sandbox"` por omissão; só mudar para `"production"` depois de ter
   credenciais reais confirmadas e testadas em sandbox).
2. Quando existir conta comercial InPost:
   ```bash
   wrangler secret put INPOST_API_TOKEN
   wrangler secret put INPOST_ORGANIZATION_ID
   ```
3. Aplicar a migração da tabela `shipments` (incluída em `schema.sql`,
   já coberta por `db:migrate:local` / `db:migrate:remote` — ver
   `docs/orders.md`).
4. CTT: sem passos possíveis nesta fase — ver secção 4.

Nenhuma credencial de transportadora é colocada em `products.json`,
HTML, CSS ou qualquer ficheiro JavaScript público — ver
`backend/.env.example` e `.gitignore` atualizados nesta fase.

---

## 15. Testes

```bash
cd backend
npm test          # node --test (recursivo: test/ e test/shipping/)
```

Cobertura de logística (Fase 6, 41 testes novos — total 103 no backend):

- **`test/shipping/inpost.test.js`** (18 testes): host por ambiente,
  ambiente desconhecido nunca cai em produção, pontos de recolha reais
  para `PL` sem token, país não confirmado rejeitado, `getRates`/
  `createShipment` exigem autenticação, peso obrigatório (nunca inventa
  dimensões), ponto de recolha obrigatório para `inpost_locker`, payload
  enviado à API, tradução de erros HTTP/rede, mapeamento de status
  documentados (e não inventados), cancelamento, webhook sempre não
  autenticado, parsing de evento de webhook.
- **`test/shipping/ctt.test.js`** (9 testes): cada operação (rates,
  pickup points, createShipment, getLabel, trackShipment,
  cancelShipment) recusa explicitamente com `NOT_CONFIGURED`; webhook
  sempre `false`; `parseWebhookEvent` sempre `null`.
- **`test/shipping/shipments.test.js`** (14 testes): peso agregado a
  partir de `order_items` para várias quantidades, dimensões nunca
  inventadas, `SHIPPING_ENVIRONMENT` nunca assume produção, registry
  devolve os providers certos, `getRatesSafely`/`getPickupPointsSafely`
  nunca deixam um erro de provider rebentar, criação de envio recusa
  sem pagamento confirmado, CTT recusa mesmo pago, InPost recusa sem
  ponto de recolha, criação **idempotente** (segunda chamada não
  duplica nem chama a transportadora outra vez), erro da API propagado
  sem criar shipment local.

Os testes de peso da Fase 4/5 (`pricing.test.js`) continuam válidos e
cobrem "produto com peso válido", "vários produtos", "várias
quantidades", "peso total correto" — reaproveitados nesta fase através
de `buildPackageFromOrder`, que usa o mesmo `order.totalWeightG`.

---

## 16. Limitações desta fase (o que NÃO está pronto para produção)

- **Nenhuma transportadora está operacional em produção.** InPost tem
  cliente HTTP real mas sem conta/credenciais/confirmação de mercado
  para Portugal; CTT é um stub.
- Portes reais em tempo real não existem ainda — o checkout usa
  `data/shipping.json` (tarifário de teste) como fallback sempre que o
  provider devolve `available:false` (o que acontece sempre nesta fase).
- Webhooks de transportadoras não processam nenhum evento real (sempre
  `401`) até existir confirmação do mecanismo de assinatura de cada
  transportadora.
- Sem dimensões de embalagem (comprimento/largura/altura) — só peso.
  Qualquer transportadora que as exija falha explicitamente com
  `MISSING_PACKAGE_DIMENSIONS`.
- `getLabel`/`trackShipment`/`cancelShipment` da InPost seguem o padrão
  documentado da ShipX API mas nunca foram exercitados contra uma conta
  real — devem ser validados em sandbox real antes de qualquer uso em
  produção.
- Sem painel administrativo para visualizar/gerir envios — só os
  endpoints da API.

## 17. O que ficou preparado para produção

- Interface `ShippingProvider` estável — adicionar uma transportadora
  nova (DPD, GLS, ...) não exige tocar no checkout nem nas encomendas.
- Tabela `shipments` com idempotência (`UNIQUE(order_id, provider)`) e
  separação clara de estados (encomenda/pagamento/envio).
- Fluxo de segurança completo: nenhuma credencial no frontend, nenhum
  preço/portes aceite do browser, envio nunca criado sem pagamento
  confirmado, webhooks só processados com assinatura validada.
- `SHIPPING_ENVIRONMENT` explícito, nunca assume produção por omissão.
