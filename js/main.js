/**
 * Mestre do Pano — main.js
 * Comportamento partilhado por todas as páginas:
 * menu mobile, ano no rodapé, contador do carrinho no header.
 */

document.addEventListener('DOMContentLoaded', () => {
  initMobileNav();
  initFooterYear();
  if (window.MestreDoPanoCart) {
    window.MestreDoPanoCart.renderHeaderCount();
  }
});

function initMobileNav() {
  const toggle = document.querySelector('.nav-toggle');
  const header = document.querySelector('.site-header');
  if (!toggle || !header) return;

  toggle.addEventListener('click', () => {
    const isOpen = header.classList.toggle('nav-open');
    toggle.setAttribute('aria-expanded', String(isOpen));
  });
}

function initFooterYear() {
  const el = document.querySelector('[data-current-year]');
  if (el) el.textContent = new Date().getFullYear();
}

/**
 * Toast notification simples (substitui alert() nativo).
 * type: 'success' | 'error' | 'info'
 */
function showToast(message, type = 'success') {
  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    container.setAttribute('aria-live', 'polite');
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  requestAnimationFrame(() => toast.classList.add('is-visible'));

  setTimeout(() => {
    toast.classList.remove('is-visible');
    setTimeout(() => toast.remove(), 250);
  }, 2800);
}
window.showToast = showToast;

/** Utilitário simples de formatação de preço em euros. */
function formatPrice(value) {
  return new Intl.NumberFormat('pt-PT', {
    style: 'currency',
    currency: 'EUR',
  }).format(value);
}

/**
 * Preço por unidade (Fase 5).
 *
 * Regra: só existe preço por unidade quando `unit_count` é um número
 * válido MAIOR que 1. Quando `unit_count` é 1, é `null`/indefinido (ainda
 * não preenchido no Excel), a interface nunca mostra "X / unidade" nem
 * "Pack com 1 unidade" — mostra apenas o preço normal do produto.
 *
 * `unit_count` nunca é assumido como 1 quando está em falta: nesse caso
 * o produto simplesmente não mostra informação de preço por unidade (o
 * mesmo comportamento visual de unit_count === 1), mas sem afirmar que o
 * produto tem 1 unidade.
 */
function hasUnitPricing(product) {
  return typeof product.unit_count === 'number' && product.unit_count > 1;
}

function unitPriceValue(product) {
  if (!hasUnitPricing(product)) return null;
  return product.price / product.unit_count;
}

/** Devolve o HTML (pode ser string vazia) do bloco "Pack com N unidades / €X / unidade". */
function unitPricingLabelHtml(product) {
  if (!hasUnitPricing(product)) return '';
  const unitPrice = unitPriceValue(product);
  return `
    <p class="pack-note">Pack com ${product.unit_count} unidades</p>
    <p class="unit-price">${formatPrice(unitPrice)} / unidade</p>
  `;
}

/** Versão compacta (uma linha) para espaços apertados, ex.: listagem/carrinho. */
function unitPriceInlineText(product) {
  if (!hasUnitPricing(product)) return '';
  return `${formatPrice(unitPriceValue(product))} / unidade`;
}
