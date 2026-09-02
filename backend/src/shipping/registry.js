/**
 * Mestre do Pano — backend/src/shipping/registry.js
 *
 * Ponto único de construção dos ShippingProvider concretos a partir de
 * `env` (variáveis de ambiente do Worker). O resto do backend nunca
 * importa `InPostProvider`/`CTTProvider` diretamente — só usa
 * `getShippingProvider(env, providerId)`.
 */

import { InPostProvider } from './providers/inpost.js';
import { CTTProvider } from './providers/ctt.js';
import { ShippingProviderError, SHIPPING_ERROR_CODES } from './provider.js';

/** SHIPPING_ENVIRONMENT explícito — nunca assume produção por omissão. */
function resolveEnvironment(env) {
  return env.SHIPPING_ENVIRONMENT === 'production' ? 'production' : 'sandbox';
}

let cachedProviders = null;

function buildProviders(env) {
  const environment = resolveEnvironment(env);
  return {
    inpost: new InPostProvider({
      environment,
      apiToken: env.INPOST_API_TOKEN || null,
      organizationId: env.INPOST_ORGANIZATION_ID || null,
    }),
    ctt: new CTTProvider({ environment }),
  };
}

/** Devolve o provider concreto para um id (`inpost`/`ctt`). Lança se desconhecido. */
export function getShippingProvider(env, providerId) {
  // Não usar cache entre pedidos diferentes do Worker (env pode variar
  // em testes) — construir sempre a partir do env atual é barato (sem I/O).
  const providers = buildProviders(env);
  const provider = providers[providerId];
  if (!provider) {
    throw new ShippingProviderError(SHIPPING_ERROR_CODES.NOT_SUPPORTED, `Transportadora desconhecida: ${providerId}.`);
  }
  return provider;
}

export function listShippingProviders(env) {
  return Object.values(buildProviders(env));
}

export { resolveEnvironment };
