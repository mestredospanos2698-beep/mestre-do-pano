/**
 * Mestre do Pano — cart.js
 * Carrinho de compras persistido em localStorage.
 * Preparado para, numa fase futura, alimentar o checkout real
 * (sem qualquer lógica de pagamento nesta fase).
 */

const MestreDoPanoCart = (() => {
  const STORAGE_KEY = 'mdp_cart_v1';

  function getItems() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      console.warn('Carrinho corrompido em localStorage, a reiniciar.', e);
      return [];
    }
  }

  function saveItems(items) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    renderHeaderCount();
  }

  function lineKey(productId, variant) {
    return `${productId}::${variant || 'default'}`;
  }

  /**
   * Bloco "Pack com N unidades / €X / unidade" para uma linha do carrinho.
   * Segue a mesma regra da Fase 5: nada é mostrado quando unitCount não é
   * um número válido > 1 (não confundir com `qty`, a quantidade comprada).
   */
  function cartItemUnitPricingHtml(item) {
    if (typeof item.unitCount !== 'number' || item.unitCount <= 1) return '';
    const unitPrice = item.price / item.unitCount;
    return `<p class="pack-note-small">Pack com ${item.unitCount} unidades · ${formatPrice(unitPrice)} / unidade</p>`;
  }

  function addItem({ productId, name, price, unitCount, image, variant, qty }) {
    const items = getItems();
    const key = lineKey(productId, variant);
    const existing = items.find((i) => lineKey(i.productId, i.variant) === key);

    if (existing) {
      existing.qty += qty;
    } else {
      items.push({ productId, name, price, unitCount: unitCount || null, image, variant, qty });
    }
    saveItems(items);
  }

  function removeItem(productId, variant) {
    const items = getItems().filter(
      (i) => lineKey(i.productId, i.variant) !== lineKey(productId, variant)
    );
    saveItems(items);
  }

  function updateQty(productId, variant, qty) {
    const items = getItems();
    const item = items.find((i) => lineKey(i.productId, i.variant) === lineKey(productId, variant));
    if (item) {
      item.qty = Math.max(1, qty);
      saveItems(items);
    }
  }

  function clear() {
    saveItems([]);
  }

  function totalCount() {
    return getItems().reduce((sum, i) => sum + i.qty, 0);
  }

  function subtotal() {
    return getItems().reduce((sum, i) => sum + i.qty * i.price, 0);
  }

  function renderHeaderCount() {
    const el = document.querySelector('[data-cart-count]');
    if (!el) return;
    const count = totalCount();
    el.textContent = count;
    el.style.display = count > 0 ? 'inline-flex' : 'none';
  }

  /** Renderiza a página do carrinho (cart.html). */
  function renderCartPage() {
    const listEl = document.querySelector('[data-cart-list]');
    if (!listEl) {
      // Página sem lista de itens (ex.: checkout.html) — ainda assim
      // atualiza o resumo de totais, se existir.
      updateSummary();
      return;
    }

    const items = getItems();

    if (items.length === 0) {
      listEl.innerHTML = '<p class="cart-empty">O seu carrinho está vazio. <a href="shop.html">Ver produtos</a>.</p>';
    } else {
      listEl.innerHTML = items.map((item) => `
        <div class="cart-row" data-line="${lineKey(item.productId, item.variant)}">
          <div class="thumb">
            <img src="${item.image}" alt="${item.name}" onerror="this.style.display='none'">
          </div>
          <div class="item-info">
            <h3>${item.name}</h3>
            ${item.variant ? `<p class="variant">Cor: ${item.variant}</p>` : ''}
            ${cartItemUnitPricingHtml(item)}
            <div class="item-qty">
              <div class="qty-stepper">
                <button type="button" data-cart-decrease aria-label="Diminuir quantidade">–</button>
                <input type="text" value="${item.qty}" readonly>
                <button type="button" data-cart-increase aria-label="Aumentar quantidade">+</button>
              </div>
              <button type="button" class="remove-btn" data-cart-remove>Remover</button>
            </div>
          </div>
          <div class="item-total">${formatPrice(item.price * item.qty)}</div>
        </div>
      `).join('');
    }

    updateSummary();
    attachCartRowEvents();
  }

  function attachCartRowEvents() {
    document.querySelectorAll('[data-cart-list] .cart-row').forEach((row) => {
      const [productId, variant] = row.dataset.line.split('::');
      const variantValue = variant === 'default' ? null : variant;

      row.querySelector('[data-cart-increase]')?.addEventListener('click', () => {
        const item = getItems().find((i) => lineKey(i.productId, i.variant) === row.dataset.line);
        updateQty(productId, variantValue, (item?.qty || 1) + 1);
        renderCartPage();
      });

      row.querySelector('[data-cart-decrease]')?.addEventListener('click', () => {
        const item = getItems().find((i) => lineKey(i.productId, i.variant) === row.dataset.line);
        updateQty(productId, variantValue, (item?.qty || 1) - 1);
        renderCartPage();
      });

      row.querySelector('[data-cart-remove]')?.addEventListener('click', () => {
        removeItem(productId, variantValue);
        renderCartPage();
      });
    });
  }

  function updateSummary() {
    const subtotalEl = document.querySelector('[data-cart-subtotal]');
    const totalEl = document.querySelector('[data-cart-total]');
    const sub = subtotal();
    if (subtotalEl) subtotalEl.textContent = formatPrice(sub);
    if (totalEl) totalEl.textContent = formatPrice(sub); // portes/IVA entram em fase futura
  }

  return {
    getItems, addItem, removeItem, updateQty, clear,
    totalCount, subtotal, renderHeaderCount, renderCartPage,
  };
})();

window.MestreDoPanoCart = MestreDoPanoCart;

document.addEventListener('DOMContentLoaded', () => {
  MestreDoPanoCart.renderCartPage();
});
