/**
 * Mestre do Pano — backend/src/shipping/providers/ctt.js
 *
 * STUB explícito para os CTT (Correios de Portugal).
 *
 * O QUE FOI VERIFICADO NESTA FASE:
 *   - Não existe nenhum portal de developers/API pública documentada dos
 *     CTT equivalente ao que a InPost publica para a Polónia
 *     (`developers.ctt.pt` e `api.ctt.pt` não resolvem/devolvem 404).
 *   - O site institucional (`ctt.pt/empresas/e-commerce-e-logistica`)
 *     descreve integração de e-commerce através de: "Criar Lojas Online"
 *     (plataforma própria CTT), "Plugins de expedição" para plataformas
 *     de terceiros (ex.: WooCommerce/Shopify/PrestaShop, vendidos/
 *     distribuídos comercialmente), e um "Portal Logística" — nenhum
 *     destes expõe uma API REST pública com sandbox self-service.
 *   - Os CTT também operam a marca "CTT Express" (cttexpress.com) e
 *     serviços "Expresso" com adesão contratual — a documentação técnica
 *     de integração (se existir) está atrás de um contrato comercial e
 *     de um gestor de conta, não foi possível confirmá-la publicamente
 *     nesta fase.
 *
 * DECISÃO TOMADA (por indicação explícita do pedido da Fase 6):
 *   Em vez de inventar endpoints, formatos de payload ou um "sandbox"
 *   fictício dos CTT, este ficheiro implementa um STUB que:
 *     - cumpre a interface `ShippingProvider` (para o resto do sistema
 *       poder tratar "ctt" como uma transportadora válida na arquitetura);
 *     - RECUSA explicitamente qualquer operação real, lançando
 *       `ShippingProviderError` com o código `NOT_CONFIGURED` e uma
 *       mensagem clara a apontar para docs/shipping.md;
 *     - nunca devolve tarifas, pontos, envios, etiquetas ou tracking
 *       simulados/fictícios.
 *
 * QUANDO SUBSTITUIR ESTE STUB:
 *   Assim que existir um contrato comercial com os CTT que disponibilize
 *   documentação de API (endpoints, autenticação, sandbox), reescrever
 *   este ficheiro à imagem de `providers/inpost.js` (cliente HTTP real,
 *   variáveis de ambiente `CTT_*`, mapeamento de estados documentados) —
 *   a interface `ShippingProvider` e o resto do backend (shipments.js,
 *   index.js) já estão preparados e não precisam de mudar.
 */

import { ShippingProvider, ShippingProviderError, SHIPPING_ERROR_CODES } from '../provider.js';

const NOT_AVAILABLE_MESSAGE = 'CTT: nenhuma API/serviço de e-commerce dos CTT foi confirmado ou configurado nesta fase. '
  + 'A integração real depende de acesso comercial/credenciais dos CTT — ver docs/shipping.md, secção "CTT".';

export class CTTProvider extends ShippingProvider {
  constructor({ environment = 'sandbox' } = {}) {
    super();
    this.environment = environment;
  }

  get id() {
    return 'ctt';
  }

  get name() {
    return 'CTT';
  }

  isAuthConfigured() {
    // Nunca true: não existem credenciais CTT reais nesta fase, e não
    // há endpoint confirmado onde as usar mesmo que existissem.
    return false;
  }

  async getRates(_input) {
    throw new ShippingProviderError(SHIPPING_ERROR_CODES.NOT_CONFIGURED, NOT_AVAILABLE_MESSAGE);
  }

  async getPickupPoints(_input) {
    throw new ShippingProviderError(SHIPPING_ERROR_CODES.NOT_CONFIGURED, NOT_AVAILABLE_MESSAGE);
  }

  async createShipment(_input) {
    throw new ShippingProviderError(SHIPPING_ERROR_CODES.NOT_CONFIGURED, NOT_AVAILABLE_MESSAGE);
  }

  async getLabel(_input) {
    throw new ShippingProviderError(SHIPPING_ERROR_CODES.NOT_CONFIGURED, NOT_AVAILABLE_MESSAGE);
  }

  async trackShipment(_input) {
    throw new ShippingProviderError(SHIPPING_ERROR_CODES.NOT_CONFIGURED, NOT_AVAILABLE_MESSAGE);
  }

  async cancelShipment(_input) {
    throw new ShippingProviderError(SHIPPING_ERROR_CODES.NOT_CONFIGURED, NOT_AVAILABLE_MESSAGE);
  }

  /** Nunca há um webhook CTT autenticável nesta fase — sempre falso. */
  async verifyWebhookSignature(_input) {
    return false;
  }

  parseWebhookEvent(_event) {
    return null;
  }
}
