/**
 * Mestre do Pano — config.js
 * Configuração pública do frontend (Fase 4).
 *
 * IMPORTANTE: este ficheiro é servido publicamente pelo GitHub Pages.
 * NUNCA colocar aqui client secrets, API keys privadas ou credenciais.
 * O PAYPAL_CLIENT_ID é público por design (é enviado ao browser pelo
 * próprio PayPal SDK) — o PAYPAL_CLIENT_SECRET fica exclusivamente no
 * backend, como variável de ambiente.
 *
 * Edita estes dois valores antes de publicar:
 *   - API_BASE_URL: URL do backend (Cloudflare Worker) desta loja.
 *   - PAYPAL_CLIENT_ID: Client ID da app PayPal Sandbox (developer.paypal.com).
 */

window.MestreDoPanoConfig = {
  API_BASE_URL: 'https://mestre-do-pano-api.mestredopano.workers.dev',
  PAYPAL_CLIENT_ID: 'SANDBOX_CLIENT_ID_AQUI',
  PAYPAL_CURRENCY: 'EUR',
};
