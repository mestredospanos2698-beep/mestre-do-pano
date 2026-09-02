/**
 * Mestre do Pano — shipping.js
 * Fase 3: cálculo de portes de demonstração.
 *
 * Fonte de dados:
 *   data/countries.json → países suportados (e quais estão ativos)
 *   data/shipping.json  → métodos de entrega + tabela de preços de TESTE
 *
 * Nada aqui fala com uma transportadora real. Quando existir uma API real
 * (InPost/CTT), só a função `calculateShippingCents` precisa de ser trocada
 * por uma chamada ao backend — o resto do checkout não muda (ver secção
 * "Arquitetura para o futuro" no README).
 */

const MestreDoPanoShipping = (() => {
  let countriesCache = null;
  let shippingCache = null;

  async function loadCountries() {
    if (countriesCache) return countriesCache;
    const res = await fetch('data/countries.json');
    if (!res.ok) throw new Error('Não foi possível carregar a lista de países.');
    const data = await res.json();
    countriesCache = data.countries;
    return countriesCache;
  }

  async function loadShippingConfig() {
    if (shippingCache) return shippingCache;
    const res = await fetch('data/shipping.json');
    if (!res.ok) throw new Error('Não foi possível carregar a tabela de portes.');
    shippingCache = await res.json();
    return shippingCache;
  }

  async function getCountry(code) {
    const countries = await loadCountries();
    return countries.find((c) => c.code === code) || null;
  }

  /** Métodos de entrega ativos globalmente E com tabela de preços para este país. */
  async function getAvailableMethods(countryCode) {
    const config = await loadShippingConfig();
    const ratesForCountry = config.rates[countryCode] || {};
    return config.methods.filter((m) => m.enabled && ratesForCountry[m.id]);
  }

  /**
   * Peso total do carrinho, em GRAMAS, a partir de products.json
   * (campo "weight_g", lido do Stock.xlsx pela coluna "Peso (g)").
   *
   * NUNCA inventa um peso por omissão: se um produto não tiver weight_g
   * válido, fica de fora do total e é reportado em `warnings`, para que a
   * UI possa avisar que os portes exibidos podem estar incompletos —
   * o backend faz o mesmo cálculo (de forma independente do frontend)
   * antes de aceitar qualquer encomenda.
   *
   * cartItems: [{productId, qty, ...}]  productsById: Map(productId -> product)
   * Devolve { totalWeightG, warnings: string[] }.
   */
  function computeCartWeightG(cartItems, productsById) {
    let totalWeightG = 0;
    const warnings = [];

    for (const item of cartItems) {
      const product = productsById.get(item.productId);
      const weightG = product && typeof product.weight_g === 'number' && product.weight_g > 0
        ? product.weight_g
        : null;

      if (weightG === null) {
        const nome = product ? product.name : item.productId;
        warnings.push(`WARNING: Produto "${nome}" não possui Peso (g) válido.`);
        console.warn(`Produto ${item.productId} sem weight_g válido em products.json — não incluído no peso total.`);
        continue;
      }

      totalWeightG += weightG * item.qty;
    }

    return { totalWeightG, warnings };
  }

  /** Compatibilidade retroativa: devolve apenas o peso total em kg (número). */
  function computeCartWeightKg(cartItems, productsById) {
    const { totalWeightG } = computeCartWeightG(cartItems, productsById);
    return Math.round((totalWeightG / 1000) * 1000) / 1000; // 3 casas decimais
  }

  /**
   * Devolve { priceCents } ou { error } — nunca lança exceção para o chamador
   * não ter de andar com try/catch para casos de negócio normais (país sem
   * cobertura, peso acima do escalão máximo disponível).
   */
  async function calculateShippingCents(countryCode, methodId, weightKg) {
    const config = await loadShippingConfig();
    const ratesForCountry = config.rates[countryCode];
    if (!ratesForCountry) {
      return { error: 'PAIS_SEM_COBERTURA' };
    }
    const brackets = ratesForCountry[methodId];
    if (!brackets) {
      return { error: 'METODO_INDISPONIVEL' };
    }
    const sorted = [...brackets].sort((a, b) => a.maxWeight - b.maxWeight);
    const bracket = sorted.find((b) => weightKg <= b.maxWeight);
    if (!bracket) {
      return { error: 'PESO_ACIMA_DO_LIMITE' };
    }
    return { priceCents: bracket.price };
  }

  return {
    loadCountries,
    loadShippingConfig,
    getCountry,
    getAvailableMethods,
    computeCartWeightG,
    computeCartWeightKg,
    calculateShippingCents,
  };
})();

window.MestreDoPanoShipping = MestreDoPanoShipping;
