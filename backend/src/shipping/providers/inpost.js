/**
 * Mestre do Pano — backend/src/shipping/providers/inpost.js
 *
 * Cliente HTTP real para a API pública da InPost — "ShipX API"
 * (documentação: https://docs.inpost.pl/, ambientes verificados nesta
 * fase por chamada direta HTTP, sem credenciais):
 *
 *   Sandbox:    https://sandbox-api-shipx-pl.easypack24.net
 *   Produção:   https://api-shipx-pl.easypack24.net
 *
 * O QUE FOI CONFIRMADO NESTA FASE (por chamada HTTP direta, sem conta):
 *   - Ambos os hosts respondem e devolvem `{"version": "..."}` em `/`.
 *   - `GET /v1/points` e `GET /v1/points/{id}` respondem SEM autenticação
 *     e devolvem dados reais de pontos de recolha (parcel lockers) — mas
 *     este endpoint de pontos está alojado em
 *     `sandbox-api-pl-points.easypack24.net`, ou seja, é a base de pontos
 *     da InPost **Polónia** (`_pl_`).
 *   - Qualquer endpoint que exija autenticação (ex.: `GET /v1/organizations`)
 *     devolve `401 {"error":"token_invalid"}` sem um Bearer token válido —
 *     confirma que a API exige um token de organização real, obtido
 *     apenas através de uma conta comercial InPost (painel "ShipX" /
 *     "Manager"), não através de um registo self-service público.
 *
 * O QUE NÃO FOI CONFIRMADO E NÃO DEVE SER ASSUMIDO:
 *   - A InPost em Portugal opera através da marca/infraestrutura
 *     "InPost Iberia" (antiga Mondial Relay, inpost.pt) — o site
 *     institucional em inpost.pt promove integração via "Web Service",
 *     plugins de e-commerce (PrestaShop/Shopify/WooCommerce/Magento) e
 *     EDI, vendidos comercialmente, e NÃO documenta publicamente se essa
 *     API é a mesma ShipX (`*-pl.easypack24.net`) usada na Polónia, uma
 *     API dedicada a Portugal, ou uma integração diferente.
 *   - Não foi encontrado nenhum host equivalente confirmado para Portugal
 *     (ex.: `*-pt.easypack24.net`) nem documentação pública de
 *     autenticação/endpoints específicos para o mercado português.
 *   - Este cliente NÃO deve ser considerado "pronto para produção em
 *     Portugal" só porque fala com um host `*.easypack24.net` que
 *     responde. Antes de qualquer envio real, é obrigatório confirmar
 *     com o gestor de conta InPost/InPost Iberia: (a) o host correto
 *     para Portugal, (b) o formato de autenticação (token de
 *     organização vs. OAuth), (c) os serviços contratados
 *     (Locker/Ponto Pack, courier), (d) o formato de etiqueta suportado.
 *
 * Arquitetura desta implementação:
 *   - `getPickupPoints()` usa o endpoint público `/v1/points` — funciona
 *     hoje sem credenciais, mas só foi validado para a Polónia. Chamar
 *     com um país diferente de `PL` lança `COUNTRY_NOT_SUPPORTED` até
 *     isto ser confirmado comercialmente.
 *   - `getRates()`, `createShipment()`, `getLabel()`, `trackShipment()`,
 *     `cancelShipment()` seguem o padrão de endpoints documentado da
 *     ShipX API (`/v1/organizations/{organization_id}/shipments`, etc.)
 *     e usam Bearer token — mas lançam `NOT_CONFIGURED` explicitamente
 *     enquanto não existirem `INPOST_API_TOKEN` + `INPOST_ORGANIZATION_ID`
 *     reais, em vez de simular uma resposta.
 *   - Todos os métodos aceitam um `fetchImpl` injetável (por omissão,
 *     `fetch` global) para permitir testes com mocks sem rede — ver
 *     backend/test/shipping/inpost.test.js.
 */

import { ShippingProvider, ShippingProviderError, SHIPPING_ERROR_CODES } from '../provider.js';

const HOSTS = {
  sandbox: 'https://sandbox-api-shipx-pl.easypack24.net',
  production: 'https://api-shipx-pl.easypack24.net',
};

// Endpoint público de pontos de recolha — confirmado nesta fase como
// pertencente à rede InPost da POLÓNIA. Nenhum outro país é servido por
// este host enquanto isso não for confirmado comercialmente.
const POINTS_COUNTRY_CONFIRMED = 'PL';

export class InPostProvider extends ShippingProvider {
  /**
   * @param {{
   *   environment: 'sandbox'|'production',
   *   apiToken?: string,
   *   organizationId?: string,
   *   fetchImpl?: typeof fetch,
   * }} config
   */
  constructor({ environment = 'sandbox', apiToken = null, organizationId = null, fetchImpl = fetch } = {}) {
    super();
    this.environment = environment === 'production' ? 'production' : 'sandbox';
    this.apiToken = apiToken || null;
    this.organizationId = organizationId || null;
    this.fetchImpl = fetchImpl;
  }

  get id() {
    return 'inpost';
  }

  get name() {
    return 'InPost';
  }

  get baseUrl() {
    return HOSTS[this.environment];
  }

  isAuthConfigured() {
    return Boolean(this.apiToken && this.organizationId);
  }

  requireAuthConfigured() {
    if (!this.isAuthConfigured()) {
      throw new ShippingProviderError(
        SHIPPING_ERROR_CODES.NOT_CONFIGURED,
        'InPost: INPOST_API_TOKEN e/ou INPOST_ORGANIZATION_ID não configurados. '
          + 'Estes valores só existem através de uma conta comercial InPost — ver docs/shipping.md.',
      );
    }
  }

  async request(path, { method = 'GET', body = null, auth = true } = {}) {
    if (auth) this.requireAuthConfigured();

    const headers = { 'Content-Type': 'application/json' };
    if (auth) headers.Authorization = `Bearer ${this.apiToken}`;

    let res;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new ShippingProviderError(SHIPPING_ERROR_CODES.PROVIDER_REQUEST_FAILED, `InPost: falha de rede (${err.message}).`, { path });
    }

    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (e) {
      data = null;
    }

    if (!res.ok) {
      throw new ShippingProviderError(
        SHIPPING_ERROR_CODES.PROVIDER_REQUEST_FAILED,
        `InPost: erro ${res.status} em ${path}${data && data.message ? ` — ${data.message}` : ''}.`,
        { status: res.status, path, response: data },
      );
    }

    return data;
  }

  /**
   * Pontos de recolha (parcel lockers / Ponto Pack). Usa o endpoint
   * público `/v1/points` (sem autenticação) — confirmado a funcionar
   * apenas para a rede da Polónia nesta fase (ver comentário no topo
   * do ficheiro). Chamar com outro país lança COUNTRY_NOT_SUPPORTED em
   * vez de devolver pontos que não foram confirmados como servindo esse
   * país.
   */
  async getPickupPoints({ country, postalCode, city } = {}) {
    if (!country) {
      throw new ShippingProviderError(SHIPPING_ERROR_CODES.NOT_SUPPORTED, 'InPost: país é obrigatório para getPickupPoints.');
    }
    if (country !== POINTS_COUNTRY_CONFIRMED) {
      throw new ShippingProviderError(
        SHIPPING_ERROR_CODES.COUNTRY_NOT_SUPPORTED,
        `InPost: cobertura de pontos de recolha para '${country}' não confirmada nesta fase — `
          + `apenas '${POINTS_COUNTRY_CONFIRMED}' foi validado contra a API pública de pontos. `
          + 'Confirmar com a InPost/InPost Iberia antes de expor este país no checkout.',
        { country },
      );
    }

    const params = new URLSearchParams({ per_page: '25' });
    if (postalCode) params.set('relative_post_code', postalCode);
    if (city) params.set('city', city);

    const data = await this.request(`/v1/points?${params.toString()}`, { auth: false });
    return (data.items || []).map((p) => ({
      id: p.name,
      name: p.name,
      address: {
        line1: p.address && p.address.line1,
        line2: p.address && p.address.line2,
        city: p.address_details && p.address_details.city,
        postalCode: p.address_details && p.address_details.post_code,
      },
      raw: p,
    }));
  }

  /**
   * Cotação de portes. A ShipX API não expõe um endpoint público de
   * cotação sem token de organização (não confirmado nesta fase sem
   * conta) — por isso este método exige autenticação configurada e
   * nunca inventa um preço quando não a tem.
   */
  async getRates(_input) {
    this.requireAuthConfigured();
    throw new ShippingProviderError(
      SHIPPING_ERROR_CODES.NOT_SUPPORTED,
      'InPost: cotação de portes em tempo real ainda não foi validada com uma conta real nesta fase. '
        + 'Continuar a usar data/shipping.json como tarifário manual até isto ser confirmado — ver docs/shipping.md.',
    );
  }

  /**
   * Cria um envio na organização configurada.
   * Endpoint documentado do padrão ShipX:
   *   POST /v1/organizations/{organization_id}/shipments
   * NÃO testado nesta fase com credenciais reais (não disponíveis) —
   * a forma do payload segue a documentação pública da ShipX API, mas
   * deve ser validada num ambiente sandbox real antes de produção.
   */
  async createShipment({ orderNumber, serviceId, customer, shippingAddress, package: pkg, pickupPointId } = {}) {
    this.requireAuthConfigured();

    if (!pkg || typeof pkg.weightG !== 'number' || pkg.weightG <= 0) {
      throw new ShippingProviderError(SHIPPING_ERROR_CODES.MISSING_PACKAGE_DIMENSIONS, 'InPost: peso da encomenda (weightG) é obrigatório para criar o envio.');
    }
    if (serviceId === 'inpost_locker' && !pickupPointId) {
      throw new ShippingProviderError(SHIPPING_ERROR_CODES.PICKUP_POINT_REQUIRED, 'InPost: ponto de recolha (locker) obrigatório para o serviço inpost_locker.');
    }

    const payload = {
      receiver: {
        email: customer && customer.email,
        phone: customer && customer.phone,
        first_name: customer && customer.firstName,
        last_name: customer && customer.lastName,
        address: pickupPointId ? undefined : {
          line1: shippingAddress && shippingAddress.address,
          city: shippingAddress && shippingAddress.city,
          post_code: shippingAddress && shippingAddress.postalCode,
          country_code: shippingAddress && shippingAddress.country,
        },
      },
      parcels: [{ weight: { amount: pkg.weightG / 1000, unit: 'kg' } }],
      service: serviceId,
      target_point: pickupPointId || undefined,
      reference: orderNumber,
      custom_attributes: { sending_method: pickupPointId ? 'parcel_locker' : 'dispatch_order' },
    };

    const data = await this.request(`/v1/organizations/${this.organizationId}/shipments`, { method: 'POST', body: payload });

    return {
      shipmentId: String(data.id),
      trackingNumber: data.tracking_number || null,
      trackingUrl: data.tracking_number ? `https://inpost.pl/sledzenie-przesylek?number=${encodeURIComponent(data.tracking_number)}` : null,
      raw: data,
    };
  }

  /** GET /v1/organizations/{organization_id}/shipments/{id}/label — padrão documentado da ShipX API. */
  async getLabel({ shipmentId, format = 'pdf' } = {}) {
    this.requireAuthConfigured();
    if (!shipmentId) throw new ShippingProviderError(SHIPPING_ERROR_CODES.NOT_SUPPORTED, 'InPost: shipmentId é obrigatório para getLabel.');

    const data = await this.request(
      `/v1/organizations/${this.organizationId}/shipments/${encodeURIComponent(shipmentId)}/label?format=${encodeURIComponent(format)}`,
    );
    return { format, url: data && data.href ? data.href : null, base64: null, raw: data };
  }

  /** GET /v1/shipments/{id} — padrão documentado da ShipX API para estado/tracking. */
  async trackShipment({ shipmentId } = {}) {
    this.requireAuthConfigured();
    if (!shipmentId) throw new ShippingProviderError(SHIPPING_ERROR_CODES.NOT_SUPPORTED, 'InPost: shipmentId é obrigatório para trackShipment.');

    const data = await this.request(`/v1/shipments/${encodeURIComponent(shipmentId)}`);
    return {
      status: mapInPostStatus(data.status),
      providerStatus: data.status,
      events: Array.isArray(data.tracking_details) ? data.tracking_details : [],
      raw: data,
    };
  }

  /** POST /v1/shipments/{id}/cancel — padrão documentado da ShipX API. */
  async cancelShipment({ shipmentId } = {}) {
    this.requireAuthConfigured();
    if (!shipmentId) throw new ShippingProviderError(SHIPPING_ERROR_CODES.NOT_SUPPORTED, 'InPost: shipmentId é obrigatório para cancelShipment.');

    await this.request(`/v1/shipments/${encodeURIComponent(shipmentId)}/cancel`, { method: 'POST' });
    return { cancelled: true };
  }

  /**
   * Webhooks: a ShipX API suporta configurar webhooks por organização
   * no painel ("Manager"), com eventos como `status_change`. NÃO foi
   * possível confirmar nesta fase (sem conta) o mecanismo exato de
   * assinatura/verificação usado — por isso esta implementação nunca
   * aceita um webhook InPost como autenticado. Só ativar isto depois de
   * confirmar com a documentação da conta real qual o cabeçalho/segredo
   * usado para assinar os webhooks.
   */
  async verifyWebhookSignature(_input) {
    return false;
  }

  parseWebhookEvent(event) {
    if (!event || !event.payload) return null;
    return {
      shipmentId: event.payload.id ? String(event.payload.id) : null,
      status: mapInPostStatus(event.payload.status),
      orderNumber: event.payload.reference || null,
    };
  }
}

/**
 * Mapa de status documentados da ShipX API para o vocabulário interno
 * de estados de envio (ver SHIPMENT_STATUSES em shipping/shipments.js).
 * Apenas os estados documentados publicamente estão mapeados; qualquer
 * status desconhecido é devolvido como está, sem inventar equivalência.
 */
function mapInPostStatus(providerStatus) {
  const map = {
    confirmed: 'LABEL_CREATED',
    dispatched_by_sender: 'READY_TO_SHIP',
    collected_from_sender: 'SHIPPED',
    taken_by_courier: 'IN_TRANSIT',
    adopted_at_source_branch: 'IN_TRANSIT',
    out_for_delivery: 'OUT_FOR_DELIVERY',
    ready_to_pickup: 'OUT_FOR_DELIVERY',
    delivered: 'DELIVERED',
    avizo: 'DELIVERY_FAILED',
    undelivered: 'DELIVERY_FAILED',
    returned_to_sender: 'RETURNED',
    canceled: 'RETURNED',
  };
  return map[providerStatus] || providerStatus || null;
}
