/**
 * Mestre do Pano — payments.js (Fase 4)
 *
 * Este ficheiro NUNCA:
 *  - calcula o valor final a cobrar (isso é sempre feito pelo backend);
 *  - decide sozinho se um pagamento foi concluído (isso vem do backend,
 *    que por sua vez só confia no PayPal depois de capturar o pagamento
 *    e/ou receber o webhook correspondente);
 *  - contém client secrets. O PAYPAL_CLIENT_ID é público por natureza.
 *
 * Fluxo:
 *   1. POST /api/orders            → backend recalcula tudo e cria a
 *                                     encomenda em PAYMENT_PENDING.
 *   2. Botões PayPal (Sandbox) são renderizados.
 *   3. createOrder()  → POST /api/paypal/create-order  (backend fala com o PayPal)
 *   4. onApprove()    → POST /api/paypal/capture-order (backend captura e confirma)
 *   5. UI mostra o estado devolvido pelo backend (nunca assume sucesso sozinha).
 */

const MestreDoPanoPayments = (() => {
  const cfg = window.MestreDoPanoConfig || {};
  const API_BASE_URL = (cfg.API_BASE_URL || '').replace(/\/$/, '');
  const PAYPAL_CLIENT_ID = cfg.PAYPAL_CLIENT_ID;
  const CURRENCY = cfg.PAYPAL_CURRENCY || 'EUR';

  let paypalSdkPromise = null;
  let currentIdempotencyKey = null;

  function apiUrl(path) {
    return `${API_BASE_URL}${path}`;
  }

  /** Gera (uma única vez por tentativa de checkout) uma chave de idempotência. */
  function getIdempotencyKey({ reset = false } = {}) {
    if (reset || !currentIdempotencyKey) {
      currentIdempotencyKey = (window.crypto && window.crypto.randomUUID)
        ? window.crypto.randomUUID()
        : `mdp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
    return currentIdempotencyKey;
  }

  async function apiFetch(path, options = {}) {
    const res = await fetch(apiUrl(path), {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });

    let body = null;
    try {
      body = await res.json();
    } catch (e) {
      body = null;
    }

    if (!res.ok) {
      const message = (body && body.error) || `Erro do servidor (${res.status}).`;
      const error = new Error(message);
      error.status = res.status;
      error.body = body;
      throw error;
    }

    return body;
  }

  /**
   * Cria a encomenda no backend. O backend recalcula subtotal, peso,
   * portes e total a partir do SKU/quantidade — nunca aceita os valores
   * calculados no browser.
   *
   * `shippingAddress.pickupPointId` é enviado apenas informativamente
   * (não afeta o preço) — é guardado no envio real (não na encomenda)
   * só depois de o pagamento estar confirmado, ver createShipmentAfterPayment.
   */
  async function createBackendOrder({ customer, shippingAddress, deliveryMethod, items }) {
    const idempotencyKey = getIdempotencyKey();
    return apiFetch('/api/orders', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({
        customer,
        shipping: {
          country: shippingAddress.country,
          method: deliveryMethod,
          address: shippingAddress.address,
          postalCode: shippingAddress.postalCode,
          city: shippingAddress.city,
          region: shippingAddress.region || null,
        },
        items: items.map((i) => ({ sku: i.productId, qty: i.qty })),
      }),
    });
  }

  async function getOrderStatus(orderNumber) {
    return apiFetch(`/api/orders/${encodeURIComponent(orderNumber)}`, { method: 'GET' });
  }

  // ---- Logística real (Fase 6) --------------------------------------------
  //
  // Nenhuma destas chamadas calcula preço/portes no browser — são sempre
  // consultas/comandos ao backend, que fala com a transportadora (ou
  // devolve `available:false` quando a transportadora/conta não suporta
  // a operação — ver docs/shipping.md).

  /** Transportadoras conhecidas pela arquitetura (não implica que estejam operacionais). */
  async function listShippingMethods() {
    return apiFetch('/api/shipping/methods', { method: 'GET' });
  }

  /** Cotação real de portes de uma transportadora para um destino+peso. Nunca lança — devolve available:false com o motivo quando indisponível. */
  async function getShippingRates({ provider, country, postalCode, totalWeightG }) {
    return apiFetch('/api/shipping/rates', {
      method: 'POST',
      body: JSON.stringify({ provider, country, postalCode, totalWeightG }),
    });
  }

  /** Pontos de recolha reais de uma transportadora (ex.: lockers InPost). */
  async function getPickupPoints({ provider, country, postalCode, city }) {
    return apiFetch('/api/shipping/pickup-points', {
      method: 'POST',
      body: JSON.stringify({ provider, country, postalCode, city }),
    });
  }

  /**
   * Cria o envio junto da transportadora — só deve ser chamado depois de
   * o pagamento estar confirmado (o backend recusa criar o envio se
   * payment_status ≠ COMPLETED, ver seccão 10 do pedido da Fase 6).
   */
  async function createShipmentAfterPayment({ orderNumber, provider, serviceId, pickupPointId }) {
    return apiFetch('/api/shipping/create-shipment', {
      method: 'POST',
      body: JSON.stringify({ orderNumber, provider, serviceId, pickupPointId }),
    });
  }

  async function getShipmentTracking({ orderNumber, provider }) {
    return apiFetch(`/api/shipping/orders/${encodeURIComponent(orderNumber)}/tracking?provider=${encodeURIComponent(provider)}`, { method: 'GET' });
  }

  function loadPaypalSdk() {
    if (paypalSdkPromise) return paypalSdkPromise;
    paypalSdkPromise = new Promise((resolve, reject) => {
      if (window.paypal) {
        resolve(window.paypal);
        return;
      }
      if (!PAYPAL_CLIENT_ID) {
        reject(new Error('PAYPAL_CLIENT_ID não configurado em js/config.js.'));
        return;
      }
      const script = document.createElement('script');
      script.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(PAYPAL_CLIENT_ID)}&currency=${encodeURIComponent(CURRENCY)}&intent=capture`;
      script.onload = () => resolve(window.paypal);
      script.onerror = () => reject(new Error('Não foi possível carregar o SDK do PayPal.'));
      document.head.appendChild(script);
    });
    return paypalSdkPromise;
  }

  /**
   * Renderiza os botões do PayPal (Sandbox) num contentor e liga os
   * callbacks ao backend. Devolve nada — usa os callbacks fornecidos
   * para informar a página do resultado.
   */
  async function renderPayPalButtons({
    containerSelector,
    backendOrderId,
    onApproved,
    onCancelled,
    onError,
  }) {
    const container = document.querySelector(containerSelector);
    if (!container) return;
    container.innerHTML = '';

    let paypal;
    try {
      paypal = await loadPaypalSdk();
    } catch (err) {
      onError(err);
      return;
    }

    paypal.Buttons({
      // Nunca definimos o valor aqui — o backend é quem sabe o total
      // real (recalculado a partir do carrinho) e é quem cria a
      // encomenda PayPal do lado do servidor.
      createOrder: async () => {
        const { paypalOrderId } = await apiFetch('/api/paypal/create-order', {
          method: 'POST',
          body: JSON.stringify({ orderNumber: backendOrderId }),
        });
        return paypalOrderId;
      },
      onApprove: async (data) => {
        try {
          const result = await apiFetch('/api/paypal/capture-order', {
            method: 'POST',
            body: JSON.stringify({ orderNumber: backendOrderId, paypalOrderId: data.orderID }),
          });
          if (result.paymentStatus === 'COMPLETED') {
            onApproved(result);
          } else {
            onError(new Error('O backend não confirmou o pagamento.'), result);
          }
        } catch (err) {
          onError(err);
        }
      },
      onCancel: () => {
        onCancelled();
      },
      onError: (err) => {
        onError(err instanceof Error ? err : new Error(String(err)));
      },
    }).render(containerSelector);
  }

  return {
    createBackendOrder,
    getOrderStatus,
    renderPayPalButtons,
    getIdempotencyKey,
    listShippingMethods,
    getShippingRates,
    getPickupPoints,
    createShipmentAfterPayment,
    getShipmentTracking,
  };
})();

window.MestreDoPanoPayments = MestreDoPanoPayments;
