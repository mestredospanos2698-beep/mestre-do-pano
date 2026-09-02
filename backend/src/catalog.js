/**
 * Mestre do Pano — backend/src/catalog.js
 *
 * O backend NUNCA confia no catálogo que o frontend possa enviar — busca
 * sempre products.json / shipping.json / countries.json diretamente da
 * fonte publicada (GitHub Pages), com uma cache curta em memória para não
 * martelar o GitHub Pages a cada pedido.
 *
 * Isto também significa que, assim que `tools/sync_stock.py` é corrido e o
 * `data/products.json` atualizado é publicado, o backend passa a usar os
 * novos preços/pesos/stock automaticamente — sem precisar de deploy.
 */

const CACHE_TTL_MS = 60 * 1000; // 1 minuto — suficiente para não sobrecarregar o GitHub Pages

let cache = { at: 0, catalog: null, countriesConfig: null, shippingConfig: null };

async function fetchJson(url, label) {
  const res = await fetch(url, { cf: { cacheTtl: 60, cacheEverything: true } });
  if (!res.ok) {
    throw new Error(`Não foi possível carregar ${label} (${res.status}).`);
  }
  return res.json();
}

export async function loadCatalog(env) {
  const now = Date.now();
  if (cache.catalog && now - cache.at < CACHE_TTL_MS) {
    return cache;
  }

  const [catalog, countriesConfig, shippingConfig] = await Promise.all([
    fetchJson(env.PRODUCTS_URL, 'products.json'),
    fetchJson(env.COUNTRIES_URL, 'countries.json'),
    fetchJson(env.SHIPPING_URL, 'shipping.json'),
  ]);

  cache = { at: now, catalog, countriesConfig, shippingConfig };
  return cache;
}
