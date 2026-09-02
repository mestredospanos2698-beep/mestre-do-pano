# Mestre do Pano — Fase 3

Loja online estática (HTML/CSS/JS vanilla) para a marca Mestre do Pano.

**Novidade da Fase 3:** checkout completo (dados do cliente, morada, país,
método de entrega, cálculo de portes por peso, resumo e "encomenda de
teste") — **sem pagamentos reais** e **sem ligação a APIs de
transportadoras**. Ver secção [Fase 3 — Checkout](#fase-3--checkout) abaixo.

**Novidade da Fase 2:** os produtos já não são fictícios — vêm do teu `Stock.xlsx`
(OneDrive) através da ferramenta `tools/sync_stock.py`. O Excel continua a ser a
única fonte de dados e nunca é alterado por este processo.

## Configuração inicial (só uma vez)

1. Copia `config.example.json` para `config.json`.
2. Edita `config.json` com os caminhos reais do teu computador, por exemplo:

```json
{
  "stock_excel_path": "C:\\Users\\Utilizador\\OneDrive\\Gestão\\Vinted\\Stock.xlsx",
  "photos_base_dir": "C:\\Users\\Utilizador\\OneDrive\\Gestão\\Vinted",
  "sheet_name": "Rascunhos",
  "output_json": "data/products.json",
  "output_images_dir": "images/produtos"
}
```

`config.json` está no `.gitignore` — nunca é enviado para o GitHub.

## Sincronizar o stock

Sempre que alterares o `Stock.xlsx`:

```bash
cd tools
python sync_stock.py
```

Isto:
1. Lê o `Stock.xlsx` (folha `Rascunhos`) — apenas leitura, nunca escreve no Excel.
2. Gera `data/products.json` com os campos públicos dos produtos.
3. Copia as fotografias da pasta indicada em `pasta_fotos` para `images/produtos/<id>/`.
4. Mostra um resumo (produtos novos/atualizados/removidos, fotografias em falta).

## Testar localmente

```bash
python3 -m http.server 8000
```

Depois abrir `http://localhost:8000`.

## Estrutura de dados encontrada no teu Stock.xlsx

Folha usada: **Rascunhos**. Colunas e para onde vão:

| Coluna no Excel | Vai para o site? | Campo em `products.json` |
| --- | --- | --- |
| `titulo` | Sim | `name` (e gera o `id` do produto) |
| `descricao` | Sim | `description` |
| `preco` | Sim | `price` |
| `marca` | Sim | `brand` |
| `categoria` | Sim | `category` (filtros da loja) |
| `estado` | Sim | `condition` |
| `cor` | Sim | `color` |
| `material` | Sim | `material` |
| `mensagem_personalizada` | Sim | `additional_info` (avisos de segurança/composição) |
| `stock` | Sim | `stock` |
| `pasta_fotos` | Sim (indiretamente) | `images` (fotos copiadas para `images/produtos/`) |
| `peso_kg` / `peso` (opcional) | Sim | `weight_kg` — ver nota abaixo |
| `custo` | **Não** | fica só no Excel — nunca é publicado |

### Limitações atuais (por não existirem no Excel)

- **Sem SKU/código de barras/referência.** O `id` de cada produto é gerado a
  partir do título (ex.: `pareo-de-praia-verde-toalha-versatil-...`). Isto é
  estável enquanto não mudares o título no Excel, mas se um dia mudares o
  título, o `id` muda também (e o link do produto muda). Se quiseres um `id`
  fixo e independente do título, o mais simples é adicionar uma coluna
  `referencia` ou `sku` ao `Stock.xlsx` — dizes-me e ajusto o script para a
  usar em vez do título.
- **Peso ainda não vem do Excel (usa uma estimativa de demonstração).** O
  `Stock.xlsx` não tem coluna de peso. `sync_stock.py` já sabe ler uma coluna
  opcional `peso_kg` (ou `peso`, em kg) se a adicionares — mas enquanto ela
  não existir, o script atribui um **peso ESTIMADO por categoria** (ex.:
  0,20 kg para toalhas de praia, 0,30 kg por conjunto de 6 panos de cozinha,
  escalado para conjuntos maiores) só para o checkout ter algo com que
  trabalhar. Cada produto com peso estimado aparece nos avisos do sync.
  **Ação recomendada:** adicionar `peso_kg` ao `Stock.xlsx` assim que possível.
- **Sem variantes estruturadas.** Cada cor é hoje uma linha própria no Excel
  (produto independente, com o seu próprio stock e fotos) — não um único
  produto com várias cores. O site trata assim cada linha como um produto
  separado, como já acontecia nos teus rascunhos.

## O que esta fase inclui

- Catálogo, página de produto e carrinho ligados ao `Stock.xlsx` real
- Filtros de categoria gerados automaticamente a partir dos dados
- Indicação de stock: "Em stock" / "Últimas unidades" / "Esgotado"
- Carrinho persistido em `localStorage` (guarda só `productId` + `quantity`)
- Separação clara entre dados públicos e internos (`custo` nunca sai do Excel)

## Fase 3 — Checkout

Fluxo: `Carrinho → Checkout → Dados do cliente → País → Método de entrega →
Cálculo de portes → Resumo → "Finalizar encomenda" (teste)`.

### Ficheiros novos

- `data/countries.json` — os 28 países pedidos, cada um com `enabled`
  (permite ligar/desligar entrega por país sem tocar em código),
  formato/regex do código postal e se tem campo de região/distrito.
- `data/shipping.json` — configuração central de portes: métodos de entrega
  (`ctt`, `inpost` — apenas estrutura, **sem ligação a nenhuma API**) e
  tabela de preços por país/método/escalão de peso. Tudo marcado
  explicitamente como `"demo": true` — **valores de teste, não comerciais**.
  Os valores estão em **cêntimos** (evita erros de arredondamento com floats).
- `js/shipping.js` — calcula o peso total do carrinho a partir de
  `products.json` (`weight_kg`) e consulta `shipping.json` para obter o
  preço do escalão correto. É o único ponto que será substituído por uma
  chamada real à API da InPost/CTT no futuro.
- `js/checkout.js` — toda a lógica da página: validação de formulário,
  país → morada/portes dinâmicos, cálculo de subtotal/portes/total em
  cêntimos, e o ecrã de confirmação da encomenda de teste (com `orderId` no
  formato `TEST-YYYYMMDD-NNNN`).

### Ficheiros modificados

- `checkout.html` / `css/checkout.css` — checkout completo (era só uma
  pré-visualização estática na Fase 2).
- `tools/sync_stock.py` — passa a gerar `weight_kg` (lê coluna opcional do
  Excel; sem ela, usa uma estimativa de demonstração — ver aviso na secção
  do `products.json` acima).
- `data/products.json` — cada produto passa a ter `weight_kg` (valor
  **estimado**, à espera da coluna real no Excel).

### Privacidade

O carrinho (`productId` + `quantity`) continua em `localStorage`, como na
Fase 2. Os dados pessoais do checkout (nome, email, telefone, morada) **só
existem em memória** enquanto a página está aberta — nunca são escritos em
`localStorage`/`sessionStorage`, nem enviados para fora do browser.

### Arquitetura pensada para a Fase 4

```
Agora:   Checkout → shipping.json          → preço de teste
Futuro:  Checkout → Backend → InPost/CTT API → preço real
```

Só `js/shipping.js` (a função `calculateShippingCents`) precisa de mudar
para passar a chamar um backend/API real — o resto do checkout (formulário,
validação, resumo, totais) não muda.

## O que fica para a Fase 4 (não implementado)

- Pagamentos (Stripe, MB WAY, PayPal)
- Transportadoras (CTT, InPost, GLS, DPD) e etiquetas automáticas — API real
- Backend / base de dados real, autenticação/contas de cliente
- Emails automáticos
- Atualização de stock em tempo real a partir de compras
- Tracking de encomendas

## Publicar no GitHub Pages

1. Criar um repositório (ex. `mestre-do-pano`) e enviar o conteúdo desta pasta.
2. Confirmar que `Stock.xlsx` e `config.json` **não** estão no repositório
   (o `.gitignore` já os exclui).
3. GitHub → **Settings → Pages → Source** → branch `main`, pasta `/ (root)`.
4. O site fica disponível em `https://<utilizador>.github.io/mestre-do-pano/`.

Fluxo normal de atualização:
```
Altero Stock.xlsx → guardo no OneDrive → python sync_stock.py → git add/commit/push
```
