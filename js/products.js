/**
 * Mestre do Pano — products.js (Fase 6.5B)
 * Carrega data/products.json (gerado por tools/sync_stock.py a partir do
 * Stock.xlsx) e trata da listagem, filtros e página individual de produto.
 *
 * NOVIDADE FASE 6.5 — AGRUPAMENTO DE VARIAÇÕES:
 *   Um produto pode vir de duas formas no products.json:
 *     - "simples": schema igual à Fase 5 (price/stock/images no topo).
 *     - "agrupado": tem `variation_type` ('cor' | 'quantidade') e uma
 *       lista `variations: []`, cada uma com sku/variacao/preco/stock/
 *       peso_kg/unidades/foto_principal/galeria_fotos própprios.
 *   O catálogo mostra sempre 1 card por produto (mesmo quando agrupado);
 *   a página de produto mostra um seletor de variações e atualiza título,
 *   foto, preço e stock em tempo real ao mudar de variação.
 *
 * FASE 6.5B — UI/UX FRONTEND:
 *   CATÁLOGO: 1 card por produto com badge "+X opções", apenas stock.
 *   PÁGINA: seletor dinâmico (cor/unidade), galeria thumbnails, preloading fade-in.
 *   ANIMAÇÕES: botão confirmação 1.5s + pulso carrinho, spinner numérico custom.
 */

const MestreDoPanoProducts = (() => {
  let cache = null;

  async function loadAll() {
    if (cache) return cache;
    const res = await fetch('data/products.json');
    if (!res.ok) throw new Error('Não foi possível carregar os produtos.');
    const data = await res.json();
    cache = data.products;
    return cache;
  }

  async function getById(id) {
    const products = await loadAll();
    return products.find((p) => p.id === id) || null;
  }

  function isGrouped(product) {
    return Array.isArray(product.variations) && product.variations.length > 0;
  }

  function stockLabel(stock) {
    if (stock <= 0) return { text: 'Esgotado', className: 'stock-out' };
    if (stock <= 3) return { text: 'Últimas unidades', className: 'stock-low' };
    return { text: 'Em stock', className: 'stock-ok' };
  }

  /** Stock "agregado" de um produto para efeitos do card do catálogo. */
  function getTotalStock(product) {
    if (isGrouped(product)) {
      return product.variations.reduce((sum, v) => sum + (v.stock || 0), 0);
    }
    return product.stock;
  }

  function hasUnitPricingGeneric(price, unitCount) {
    return typeof unitCount === 'number' && unitCount > 1;
  }

  function unitPriceInlineTextGeneric(price, unitCount) {
    if (!hasUnitPricingGeneric(price, unitCount)) return '';
    return `${formatPrice(price / unitCount)} / unidade`;
  }

  // ---- CATÁLOGO (Fase 6.5B) ----
  // 1 card por produto, badge "+X opções", apenas stock, sem preço unitário

  function cardTemplate(product) {
    const priceLabel = formatPrice(product.price);
    const totalStock = getTotalStock(product);
    const stock = stockLabel(totalStock);
    const firstImage = product.images && product.images[0];
    const variationCount = isGrouped(product) ? product.variations.length : 0;

    return `
      <a class="product-card" href="product.html?id=${encodeURIComponent(product.id)}">
        <div class="thumb">
          ${firstImage
            ? `<img src="${firstImage}" alt="${product.name}" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'), { className: 'placeholder-pattern', ariaHidden: 'true' }))">`
            : '<div class="placeholder-pattern" aria-hidden="true"></div>'}
          ${variationCount > 0 ? `<span class="variation-badge">+${variationCount} opções</span>` : ''}
        </div>
        <h3>${product.name}</h3>
        <p class="price">${priceLabel}</p>
        <p class="stock-note ${stock.className}">${stock.text}</p>
      </a>
    `;
  }

  /** Renderiza uma grelha de produtos num contentor, com filtro opcional por categoria. */
  async function renderGrid(containerSelector, { category = null, limit = null } = {}) {
    const container = document.querySelector(containerSelector);
    if (!container) return;

    let products = await loadAll();
    if (category) {
      products = products.filter((p) => p.category === category);
    }
    if (limit) {
      products = products.slice(0, limit);
    }

    if (products.length === 0) {
      container.innerHTML = '<p class="empty-state">Sem produtos para os filtros selecionados.</p>';
      return;
    }

    container.innerHTML = products.map(cardTemplate).join('');
  }

  /** Página de loja: grelha + filtros de categoria (gerados a partir dos dados). */
  async function initShopPage() {
    const grid = document.querySelector('[data-product-grid]');
    if (!grid) return;

    const products = await loadAll();
    const filterContainer = document.querySelector('[data-category-filters]');
    const resultsCount = document.querySelector('[data-results-count]');

    const categorias = [...new Set(products.map((p) => p.category).filter(Boolean))].sort();

    if (filterContainer) {
      filterContainer.innerHTML = categorias.map((cat) => `
        <label><input type="checkbox" data-category-filter value="${cat}"> ${cat}</label>
      `).join('');
    }

    const filterInputs = document.querySelectorAll('[data-category-filter]');

    function applyFilters() {
      const checked = Array.from(filterInputs)
        .filter((input) => input.checked)
        .map((input) => input.value);

      const filtered = checked.length === 0
        ? products
        : products.filter((p) => checked.includes(p.category));

      grid.innerHTML = filtered.length
        ? filtered.map(cardTemplate).join('')
        : '<p class="empty-state">Sem produtos para os filtros selecionados.</p>';

      if (resultsCount) {
        resultsCount.textContent = `${filtered.length} produto${filtered.length === 1 ? '' : 's'}`;
      }
    }

    filterInputs.forEach((input) => input.addEventListener('change', applyFilters));
    applyFilters();
  }

  // ---------- Página de produto individual (Fase 6.5B) ----------

  /** Nomes de cor conhecidos → cor CSS. */
  const COLOR_HEX_MAP = {
    verde: '#3f7a4f',
    lilás: '#b79fd6',
    lilas: '#b79fd6',
    cinzento: '#9a978f',
    castanho: '#6b4a34',
    'azul marinho': '#1f2f4a',
    'azul-marinho': '#1f2f4a',
    azul: '#2f6fa8',
    amarelo: '#e8c547',
    rosa: '#e59bb0',
    turquesa: '#3fa9a0',
    vermelho: '#a83232',
    bordeaux: '#5c1f2b',
    vinho: '#5c1f2b',
    multi: 'linear-gradient(135deg, #e59bb0, #2f6fa8, #e8c547)',
    branco: '#f5f2ea',
    preto: '#1a1a1a',
  };

  function colorToSwatchBackground(nomeCor) {
    const chave = String(nomeCor || '').trim().toLowerCase();
    return COLOR_HEX_MAP[chave] || '#c7b287';
  }

  /** Seletor dinâmico de variações (cor: swatches | quantidade: pills). */
  function variationSelectorTemplate(product, selectedVariation) {
    if (!isGrouped(product)) return '';

    const isColor = product.variation_type === 'cor';

    const itemsHtml = product.variations.map((variacao) => {
      const esgotado = (variacao.stock || 0) <= 0;
      const selecionada = variacao.sku === selectedVariation.sku;
      const classes = [
        isColor ? 'variation-swatch' : 'variation-pill',
        esgotado ? 'is-out-of-stock' : '',
        selecionada ? 'is-selected' : '',
      ].filter(Boolean).join(' ');

      if (isColor) {
        return `
          <button type="button" class="${classes}" data-variation-sku="${variacao.sku}"
            ${esgotado ? 'disabled aria-disabled="true"' : ''}
            style="--swatch-color: ${colorToSwatchBackground(variacao.variacao)}"
            title="${variacao.variacao}${esgotado ? ' — Esgotado' : ''}">
            <span class="variation-swatch-circle"></span>
            <span class="variation-swatch-label">${variacao.variacao}${esgotado ? ' (Esgotado)' : ''}</span>
          </button>
        `;
      }

      const rotulo = `${variacao.variacao} Unidade${Number(variacao.variacao) === 1 ? '' : 's'}`;
      return `
        <button type="button" class="${classes}" data-variation-sku="${variacao.sku}"
          ${esgotado ? 'disabled aria-disabled="true"' : ''}
          title="${rotulo}${esgotado ? ' — Esgotado' : ''}">
          ${rotulo}${esgotado ? ' <span class="variation-pill-esgotado">Esgotado</span>' : ''}
        </button>
      `;
    }).join('');

    const legenda = isColor ? 'Cor' : 'Tamanho / Quantidade';

    return `
      <div class="variation-selector" data-variation-selector>
        <p class="variation-selector-label">${legenda}: <strong data-variation-current>${selectedVariation.variacao}</strong></p>
        <div class="variation-options ${isColor ? 'variation-options-color' : 'variation-options-pill'}">
          ${itemsHtml}
        </div>
      </div>
    `;
  }

  /** Galeria estilo Temu: foto grande + thumbnails (Fase 6.5B: fade-in, preload). */
  function galleryTemplate(fotos, nomeProduto) {
    if (!fotos || fotos.length === 0) {
      return {
        mainHtml: '<div class="placeholder-pattern" aria-hidden="true"></div>',
        thumbsHtml: '',
      };
    }
    const mainHtml = `<img src="${fotos[0]}" alt="${nomeProduto}" data-gallery-main loading="eager" style="opacity: 1; transition: opacity 0.15s ease;" onerror="this.style.display='none'">`;
    const thumbsHtml = fotos.length > 1
      ? `
        <div class="gallery-thumbs" data-gallery-thumbs>
          ${fotos.map((foto, i) => `
            <button type="button" class="gallery-thumb ${i === 0 ? 'is-active' : ''}" data-gallery-thumb data-src="${foto}">
              <img src="${foto}" alt="${nomeProduto} — miniatura ${i + 1}" loading="lazy">
            </button>
          `).join('')}
        </div>
      `
      : '';
    return { mainHtml, thumbsHtml };
  }

  function pickDefaultVariation(product) {
    const comStock = product.variations.find((v) => (v.stock || 0) > 0);
    return comStock || product.variations[0];
  }

  /** Página de produto individual: lê ?id= da URL e renderiza os detalhes. */
  async function initProductPage() {
    const root = document.querySelector('[data-product-root]');
    if (!root) return;

    const params = new URLSearchParams(window.location.search);
    const id = params.get('id');
    const product = id ? await getById(id) : null;

    if (!product) {
      root.innerHTML = '<p class="empty-state">Produto não encontrado. <a href="shop.html">Voltar à loja</a>.</p>';
      return;
    }

    const grouped = isGrouped(product);
    let selectedVariation = grouped ? pickDefaultVariation(product) : null;
    let qty = 1;

    function currentPrice() {
      return grouped ? selectedVariation.preco : product.price;
    }
    function currentStock() {
      return grouped ? (selectedVariation.stock || 0) : product.stock;
    }
    function currentUnitCount() {
      return grouped ? selectedVariation.unidades : product.unit_count;
    }
    function currentFotos() {
      if (grouped) return selectedVariation.galeria_fotos || [];
      return product.images || [];
    }
    function currentTitle() {
      if (grouped) return `${product.name} ${selectedVariation.variacao}`.trim();
      return product.name;
    }
    function currentDescription() {
      if (grouped && selectedVariation.descricao) return selectedVariation.descricao;
      return product.description;
    }

    function render() {
      document.title = `${currentTitle()} — Mestre do Pano`;

      const stock = stockLabel(currentStock());
      const esgotado = currentStock() <= 0;
      const { mainHtml, thumbsHtml } = galleryTemplate(currentFotos(), currentTitle());
      const unitCount = currentUnitCount();
      const price = currentPrice();
      const packHtml = hasUnitPricingGeneric(price, unitCount)
        ? `
          <p class="pack-note">Pack com ${unitCount} unidades</p>
          <p class="unit-price">${unitPriceInlineTextGeneric(price, unitCount)}</p>
        `
        : '';

      root.innerHTML = `
        <div class="product-gallery">
          <div class="main-image" data-main-image>${mainHtml}</div>
          ${thumbsHtml}
        </div>
        <div class="product-info">
          <h1 data-product-title>${currentTitle()}</h1>
          <p class="price" data-product-price>${formatPrice(price)}</p>
          ${packHtml}
          <p class="stock-note ${stock.className}" data-product-stock>${stock.text}${!esgotado && grouped ? ` (${currentStock()} unidades)` : ''}</p>

          ${variationSelectorTemplate(product, selectedVariation || {})}

          <div class="qty-row">
            <button type="button" class="qty-btn qty-decrease" data-qty-decrease aria-label="Diminuir quantidade" ${esgotado ? 'disabled' : ''}>−</button>
            <input type="text" class="qty-input" value="1" readonly data-qty-value inputmode="numeric">
            <button type="button" class="qty-btn qty-increase" data-qty-increase aria-label="Aumentar quantidade" ${esgotado ? 'disabled' : ''}>+</button>
            <button type="button" class="btn btn-primary" data-add-to-cart ${esgotado ? 'disabled' : ''}>
              ${esgotado ? 'Esgotado' : 'Adicionar ao carrinho'}
            </button>
          </div>

          <div class="product-description" data-product-description>
            <p>${currentDescription()}</p>
          </div>

          <div class="product-meta">
            <dl>
              ${product.category ? `<dt>Categoria</dt><dd>${product.category}</dd>` : ''}
              ${product.material ? `<dt>Material</dt><dd>${product.material}</dd>` : ''}
            </dl>
          </div>

          ${product.additional_info ? `
            <details class="product-accordion">
              <summary>Avisos de segurança e informação adicional</summary>
              <p class="additional-info">${product.additional_info}</p>
            </details>
          ` : ''}
        </div>
      `;

      attachRowEvents();
    }

    function attachRowEvents() {
      // Stepper de quantidade (Fase 6.5B: botões [-] [ N ] [+])
      const qtyValue = root.querySelector('[data-qty-value]');
      root.querySelector('[data-qty-decrease]')?.addEventListener('click', () => {
        qty = Math.max(1, qty - 1);
        qtyValue.value = qty;
      });
      root.querySelector('[data-qty-increase]')?.addEventListener('click', () => {
        const max = currentStock() || 1;
        qty = Math.min(max, qty + 1);
        qtyValue.value = qty;
      });

      // Miniaturas da galeria: fade-in suave
      root.querySelectorAll('[data-gallery-thumb]').forEach((thumbBtn) => {
        thumbBtn.addEventListener('click', () => {
          const src = thumbBtn.dataset.src;
          const mainImg = root.querySelector('[data-gallery-main]');
          if (mainImg) {
            mainImg.style.opacity = '0';
            setTimeout(() => {
              mainImg.src = src;
              mainImg.style.opacity = '1';
            }, 120);
          }
          root.querySelectorAll('[data-gallery-thumb]').forEach((b) => b.classList.remove('is-active'));
          thumbBtn.classList.add('is-active');
        });
      });

      // Seletor de variações: atualiza título, foto, preço, stock, descrição
      root.querySelectorAll('[data-variation-sku]').forEach((btn) => {
        btn.addEventListener('click', () => {
          if (btn.disabled) return;
          const sku = btn.dataset.variationSku;
          const nova = product.variations.find((v) => v.sku === sku);
          if (!nova) return;
          selectedVariation = nova;
          qty = 1;
          render();
        });
      });

      // Adicionar ao carrinho (Fase 6.5B: animação confirmação + pulso carrinho)
      root.querySelector('[data-add-to-cart]')?.addEventListener('click', () => {
        const btn = root.querySelector('[data-add-to-cart]');
        const originalText = btn.textContent;
        btn.textContent = '✓ Adicionado!';
        btn.disabled = true;

        // Pulso no carrinho
        const cartCount = document.querySelector('.cart-count');
        if (cartCount) {
          cartCount.classList.add('pulse-animation');
          setTimeout(() => cartCount.classList.remove('pulse-animation'), 600);
        }

        setTimeout(() => {
          btn.textContent = originalText;
          btn.disabled = false;
        }, 1500);

        window.MestreDoPanoCart.addItem({
          productId: product.id,
          name: currentTitle(),
          price: currentPrice(),
          unitCount: currentUnitCount() || null,
          image: (currentFotos() && currentFotos()[0]) || null,
          variant: grouped ? String(selectedVariation.variacao) : (product.color || null),
          qty,
        });
      });
    }

    render();
  }

  return {
    loadAll, getById, renderGrid, initShopPage, initProductPage,
    isGrouped, getTotalStock,
  };
})();

window.MestreDoPanoProducts = MestreDoPanoProducts;

document.addEventListener('DOMContentLoaded', () => {
  MestreDoPanoProducts.renderGrid('[data-featured-grid]', { limit: 4 });
  MestreDoPanoProducts.initShopPage();
  MestreDoPanoProducts.initProductPage();
});
