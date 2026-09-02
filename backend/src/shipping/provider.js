/**
 * Mestre do Pano — backend/src/shipping/provider.js
 *
 * Interface abstrata que qualquer transportadora (InPost, CTT, futuras)
 * deve implementar. O resto do backend (checkout, orders, index.js)
 * fala APENAS com esta interface — nunca com um SDK/API de transportadora
 * diretamente. Isto permite trocar/adicionar transportadoras sem tocar
 * no fluxo de encomendas.
 *
 * Nenhum método aqui é "genérico e falso" — cada provider concreto deve
 * documentar explicitamente quais destes métodos consegue realmente
 * cumprir com a conta/API disponível, e lançar `ShippingProviderError`
 * com o código `NOT_SUPPORTED` para os que não pode.
 *
 * Ver docs/shipping.md para o estado real de cada transportadora.
 */

/** Erro de domínio para qualquer falha de transportadora (nunca deixar escapar erros HTTP crus). */
export class ShippingProviderError extends Error {
  constructor(code, message, details) {
    super(message || code);
    this.code = code;
    this.details = details;
  }
}

export const SHIPPING_ERROR_CODES = {
  // A operação existe na API mas não está disponível para esta
  // conta/país/serviço contratado — NUNCA simular um resultado.
  NOT_SUPPORTED: 'NOT_SUPPORTED',
  // Faltam credenciais/configuração (ex.: token de organização).
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  // A transportadora não serve o país/método pedido.
  COUNTRY_NOT_SUPPORTED: 'COUNTRY_NOT_SUPPORTED',
  // Falha de rede/HTTP ao comunicar com a API da transportadora.
  PROVIDER_REQUEST_FAILED: 'PROVIDER_REQUEST_FAILED',
  // A transportadora exige um ponto de recolha e nenhum foi indicado.
  PICKUP_POINT_REQUIRED: 'PICKUP_POINT_REQUIRED',
  // O ponto de recolha indicado não existe/não é válido.
  INVALID_PICKUP_POINT: 'INVALID_PICKUP_POINT',
  // Faltam dimensões de embalagem obrigatórias para este serviço.
  MISSING_PACKAGE_DIMENSIONS: 'MISSING_PACKAGE_DIMENSIONS',
  // Já existe um envio válido para esta encomenda (proteção de idempotência).
  SHIPMENT_ALREADY_EXISTS: 'SHIPMENT_ALREADY_EXISTS',
};

/**
 * @typedef {object} PackageDetails
 * @property {number} weightG           - peso total, em gramas (obrigatório; vem de weight_g × quantity)
 * @property {number|null} lengthMm      - comprimento em mm, se conhecido (nunca inventado)
 * @property {number|null} widthMm       - largura em mm, se conhecida (nunca inventada)
 * @property {number|null} heightMm      - altura em mm, se conhecida (nunca inventada)
 * @property {number} numberOfPackages   - número de volumes (default 1)
 */

/**
 * Interface abstrata — cada provider concreto (InPostProvider,
 * CTTProvider, ...) estende esta classe. Métodos não sobrepostos lançam
 * NOT_SUPPORTED por omissão, para nunca fingir suportar uma operação.
 */
export class ShippingProvider {
  /** Identificador curto e estável usado na base de dados (`shipments.provider`). */
  get id() {
    throw new Error('ShippingProvider.id deve ser implementado pela subclasse.');
  }

  /** Nome apresentável (usado em logs/documentação, não necessariamente na UI). */
  get name() {
    return this.id;
  }

  /**
   * Devolve as tarifas/métodos disponíveis desta transportadora para um
   * destino + embalagem. Nunca inventa um preço — se a API/conta não
   * disponibilizar cotação em tempo real, deve devolver `[]` e documentar
   * a limitação (ver docs/shipping.md), nunca simular um valor.
   *
   * @param {{country: string, postalCode: string, package: PackageDetails}} input
   * @returns {Promise<Array<{ serviceId: string, name: string, priceCents: number|null, currency: string, requiresPickupPoint: boolean }>>}
   */
  async getRates(_input) {
    throw new ShippingProviderError(SHIPPING_ERROR_CODES.NOT_SUPPORTED, `${this.id}: getRates não suportado.`);
  }

  /**
   * Devolve pontos de recolha (lockers/agências) próximos de uma morada
   * ou código postal, quando o serviço selecionado o exigir.
   *
   * @param {{country: string, postalCode: string, city?: string}} input
   * @returns {Promise<Array<{ id: string, name: string, address: object }>>}
   */
  async getPickupPoints(_input) {
    throw new ShippingProviderError(SHIPPING_ERROR_CODES.NOT_SUPPORTED, `${this.id}: getPickupPoints não suportado.`);
  }

  /**
   * Cria o envio junto da transportadora para uma encomenda já paga.
   * Deve ser idempotente do lado do chamador (ver
   * backend/src/shipping/shipments.js) — o provider pode assumir que só
   * é chamado quando ainda não existe envio válido para a encomenda.
   *
   * @param {{orderNumber: string, serviceId: string, customer: object, shippingAddress: object, package: PackageDetails, pickupPointId?: string}} input
   * @returns {Promise<{ shipmentId: string, trackingNumber: string|null, trackingUrl: string|null, raw: object }>}
   */
  async createShipment(_input) {
    throw new ShippingProviderError(SHIPPING_ERROR_CODES.NOT_SUPPORTED, `${this.id}: createShipment não suportado.`);
  }

  /**
   * Obtém a etiqueta de um envio já criado (normalmente PDF/ZPL).
   *
   * @param {{shipmentId: string, format?: string}} input
   * @returns {Promise<{ format: string, url: string|null, base64: string|null }>}
   */
  async getLabel(_input) {
    throw new ShippingProviderError(SHIPPING_ERROR_CODES.NOT_SUPPORTED, `${this.id}: getLabel não suportado.`);
  }

  /**
   * Consulta o estado/tracking atual de um envio.
   *
   * @param {{shipmentId: string, trackingNumber?: string}} input
   * @returns {Promise<{ status: string, providerStatus: string, events: Array<object> }>}
   */
  async trackShipment(_input) {
    throw new ShippingProviderError(SHIPPING_ERROR_CODES.NOT_SUPPORTED, `${this.id}: trackShipment não suportado.`);
  }

  /**
   * Cancela um envio (normalmente só possível antes de ser processado
   * pela transportadora).
   *
   * @param {{shipmentId: string}} input
   * @returns {Promise<{ cancelled: boolean }>}
   */
  async cancelShipment(_input) {
    throw new ShippingProviderError(SHIPPING_ERROR_CODES.NOT_SUPPORTED, `${this.id}: cancelShipment não suportado.`);
  }

  /**
   * Valida a autenticidade de um webhook desta transportadora, quando o
   * mecanismo oficial existir. Deve devolver `false` (nunca lançar) para
   * qualquer webhook que não possa ser comprovadamente autenticado.
   *
   * @param {{headers: Headers, rawBody: string}} input
   * @returns {Promise<boolean>}
   */
  async verifyWebhookSignature(_input) {
    return false;
  }

  /**
   * Traduz um evento de webhook já validado para o vocabulário interno
   * de estados de envio (ver SHIPMENT_STATUSES em shipments.js).
   *
   * @param {object} _event
   * @returns {{ shipmentId: string|null, status: string|null, orderNumber: string|null } | null}
   */
  parseWebhookEvent(_event) {
    return null;
  }
}
