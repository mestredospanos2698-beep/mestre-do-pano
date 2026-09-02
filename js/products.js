/**
 * Mestre do Pano — products.js
 * Carrega data/products.json (gerado por tools/sync_stock.py a partir do
 * Stock.xlsx) e trata da listagem, filtros e página individual de produto.
 *
 * Nota sobre o schema: o Stock.xlsx não tem um sistema de variantes — cada
 * cor de um produto é uma linha própria no Excel, logo cada linha é um
 * produto independente (com o seu próprio id, stock e fotografias).
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

  function stockLabel(stock) {
    if (stock <= 0) return { text: 'Esgotado', className: 'stock-out' };
    if (stock <= 3) return { text: 'Últimas unidades', className: 'stock-low' };
    return { text: 'Em stock', className: 'stock-ok' };
  }

  function cardTemplate(product) {
    const priceLabel = formatPrice(product.price);
    const stock = stockLabel(product.stock);
    const firstImage = product.images && product.images[0];

    return `
      <a class="product-card" href="product.html?id=${encodeURIComponent(product.id)}">
        <div class="thumb">
          ${firstImage
            ? `<img src="${firstImage}" alt="${product.name}" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'), { className: 'placeholder-pattern', ariaHidden: 'true' }))">`
            : '<div class="placeholder-pattern" aria-hidden="true"></div>'}
        </div>
        <h3>${product.name}</h3>
        <p class="price">${priceLabel}</p>
        ${hasUnitPricing(product) ? `<p class="unit-price-inline">${unitPriceInlineText(product)}</p>` : ''}
        <p class="stock-note ${stock.className}">${stock.text}</p>
        ${product.color ? `<p class="variant-note">${product.color}</p>` : ''}
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

    document.title = `${product.name} — Mestre do Pano`;

    const stock = stockLabel(product.stock);
    const esgotado = product.stock <= 0;
    let qty = 1;

    const galeria = (product.images && product.images.length)
      ? product.images.map((img, i) => `<img src="${img}" alt="${product.name}" ${i > 0 ? 'style="display:none"' : ''} onerror="console.error('Gallery image failed:', this.src); this.style.display='none'">`).join('')
      : '<div class="placeholder-pattern" aria-hidden="true"></div>';

    root.innerHTML = `
      <div class="product-gallery">
        <div class="main-image">${galeria}</div>
      </div>
      <div class="product-info">
        <h1>${product.name}</h1>
        <p class="price">${formatPrice(product.price)}</p>
        ${unitPricingLabelHtml(product)}
        <p class="stock-note ${stock.className}">${stock.text}</p>
        <p>${product.description}</p>

        <div class="qty-row">
          <div class="qty-stepper">
            <button type="button" data-qty-decrease aria-label="Diminuir quantidade" ${esgotado ? 'disabled' : ''}>–</button>
            <input type="text" value="1" readonly data-qty-value>
            <button type="button" data-qty-increase aria-label="Aumentar quantidade" ${esgotado ? 'disabled' : ''}>+</button>
          </div>
          <button type="button" class="btn btn-primary" data-add-to-cart ${esgotado ? 'disabled' : ''}>
            ${esgotado ? 'Esgotado' : 'Adicionar ao carrinho'}
          </button>
        </div>

        <div class="product-meta">
          <dl>
            ${product.category ? `<dt>Categoria</dt><dd>${product.category}</dd>` : ''}
            ${product.color ? `<dt>Cor</dt><dd>${product.color}</dd>` : ''}
            ${product.material ? `<dt>Material</dt><dd>${product.material}</dd>` : ''}
            ${product.condition ? `<dt>Estado</dt><dd>${product.condition}</dd>` : ''}
          </dl>
          ${product.additional_info ? `<p class="additional-info">${product.additional_info}</p>` : ''}
        </div>
      </div>
    `;

    // Stepper de quantidade (limitado ao stock disponível)
    const qtyValue = root.querySelector('[data-qty-value]');
    root.querySelector('[data-qty-decrease]')?.addEventListener('click', () => {
      qty = Math.max(1, qty - 1);
      qtyValue.value = qty;
    });
    root.querySelector('[data-qty-increase]')?.addEventListener('click', () => {
      qty = Math.min(product.stock, qty + 1);
      qtyValue.value = qty;
    });

    // Adicionar ao carrinho
    root.querySelector('[data-add-to-cart]')?.addEventListener('click', () => {
      window.MestreDoPanoCart.addItem({
        productId: product.id,
        name: product.name,
        price: product.price,
        unitCount: product.unit_count || null,
        image: (product.images && product.images[0]) || null,
        variant: product.color || null,
        qty,
      });
    });
  }

  return { loadAll, getById, renderGrid, initShopPage, initProductPage };
})();

window.MestreDoPanoProducts = MestreDoPanoProducts;

document.addEventListener('DOMContentLoaded', () => {
  MestreDoPanoProducts.renderGrid('[data-featured-grid]', { limit: 4 });
  MestreDoPanoProducts.initShopPage();
  MestreDoPanoProducts.initProductPage();
});
