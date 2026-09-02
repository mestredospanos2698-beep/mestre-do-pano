/**
 * Mestre do Pano — checkout.js
 * Fase 6: métodos de entrega e portes consultados ao BACKEND real de
 * logística (InPost/CTT — ver docs/shipping.md), com seleção de ponto
 * de recolha quando o método o exigir. O backend continua a ser a
 * única autoridade sobre preço/peso/portes/total — nada aqui calcula ou
 * confirma um valor final.
 *
 * Nada neste ficheiro:
 *  - cobra dinheiro diretamente (isso é sempre o backend + PayPal)
 *  - guarda dados pessoais no localStorage/sessionStorage
 *  - cria o envio antes do pagamento estar confirmado (isso só acontece
 *    depois de showPaymentCompleted, chamando createShipmentAfterPayment)
 */

const MestreDoPanoCheckout = (() => {
  // ---- estado em memória (NUNCA persistido) ------------------------------
  let cartItems = [];
  let productsById = new Map();
  let countries = [];
  let selectedCountry = null; // objeto país (de countries.json)
  let selectedMethodId = null; // id do método local (shipping.json: 'ctt' | 'inpost')
  let selectedMethodConfig = null; // entrada correspondente em shipping.json (provider, requiresPickupPoint, ...)
  let selectedPickupPoint = null; // { id, name, address } — só quando requiresPickupPoint
  let weightG = 0;
  let weightKg = 0;
  let weightWarnings = [];
  let subtotalCents = 0;
  let shippingCents = null;
  let backendOrderNumber = null;

  const els = {};

  // ---- utilitários de dinheiro (cêntimos internamente) --------------------
  function eurosToCents(value) {
    return Math.round(value * 100);
  }

  function formatCents(cents) {
    return new Intl.NumberFormat('pt-PT', { style: 'currency', currency: 'EUR' }).format(cents / 100);
  }

  // ---- arranque -------------------------------------------------------------

  async function init() {
    els.root = document.querySelector('[data-checkout-root]');
    if (!els.root) return; // não estamos na página de checkout

    els.empty = document.querySelector('[data-checkout-empty]');
    els.formWrap = document.querySelector('[data-checkout-form-wrap]');
    els.summary = document.querySelector('[data-checkout-summary]');
    els.confirmation = document.querySelector('[data-checkout-confirmation]');
    els.form = document.querySelector('[data-checkout-form]');
    els.summaryItems = document.querySelector('[data-summary-items]');
    els.summaryWeight = document.querySelector('[data-summary-weight]');
    els.summarySubtotal = document.querySelector('[data-summary-subtotal]');
    els.summaryShipping = document.querySelector('[data-summary-shipping]');
    els.summaryTotal = document.querySelector('[data-summary-total]');
    els.submitBtn = document.querySelector('[data-checkout-submit]');
    els.formError = document.querySelector('[data-form-error]');
    els.countrySelect = document.querySelector('[data-field="country"]');
    els.postalLabel = document.querySelector('[data-postal-label]');
    els.postalInput = document.querySelector('#codigo-postal');
    els.regionRow = document.querySelector('[data-region-row]');
    els.regionLabel = document.querySelector('[data-region-label]');
    els.shippingMethods = document.querySelector('[data-shipping-methods]');
    els.pickupPointSection = document.querySelector('[data-pickup-point-section]');
    els.pickupPointList = document.querySelector('[data-pickup-point-list]');
    els.weightWarning = document.querySelector('[data-weight-warning]');
    els.paypalSection = document.querySelector('[data-paypal-section]');
    els.paypalError = document.querySelector('[data-paypal-error]');
    els.paymentPending = document.querySelector('[data-payment-pending]');
    els.paymentCancelled = document.querySelector('[data-payment-cancelled]');
    els.paymentFailed = document.querySelector('[data-payment-failed]');

    cartItems = window.MestreDoPanoCart ? window.MestreDoPanoCart.getItems() : [];

    if (cartItems.length === 0) {
      if (els.empty) els.empty.hidden = false;
      if (els.formWrap) els.formWrap.hidden = true;
      if (els.summary) els.summary.hidden = true;
      return;
    }

    try {
      const [products, loadedCountries] = await Promise.all([
        window.MestreDoPanoProducts.loadAll(),
        window.MestreDoPanoShipping.loadCountries(),
      ]);
      productsById = new Map(products.map((p) => [p.id, p]));
      countries = loadedCountries;
    } catch (err) {
      console.error(err);
      showFormError('Não foi possível carregar os dados da loja. Tente recarregar a página.');
      return;
    }

    const weightResult = window.MestreDoPanoShipping.computeCartWeightG(cartItems, productsById);
    weightG = weightResult.totalWeightG;
    weightKg = weightResult.totalWeightG / 1000;
    weightWarnings = weightResult.warnings;
    subtotalCents = cartItems.reduce((sum, item) => sum + eurosToCents(item.price) * item.qty, 0);

    if (els.weightWarning) {
      if (weightWarnings.length) {
        els.weightWarning.hidden = false;
        els.weightWarning.textContent = `Atenção: ${weightWarnings.length} produto(s) sem peso definido no Stock.xlsx — os portes exibidos podem estar incompletos. O total final é sempre recalculado pelo backend.`;
      } else {
        els.weightWarning.hidden = true;
      }
    }

    renderSummaryItems();
    renderCountryOptions();
    updateTotalsDisplay();
    attachEvents();
  }

  // ---- renderização ----------------------------------------------------------

  function renderSummaryItems() {
    if (!els.summaryItems) return;
    els.summaryItems.innerHTML = cartItems.map((item) => {
      const packNote = (typeof item.unitCount === 'number' && item.unitCount > 1)
        ? `<span class="summary-item-pack">Pack de ${item.unitCount} un. · ${formatCents(eurosToCents(item.price / item.unitCount))} / unidade</span>`
        : '';
      return `
      <div class="summary-item">
        <span class="summary-item-name">${item.qty} × ${item.name}${item.variant ? ` (${item.variant})` : ''}${packNote}</span>
        <span class="summary-item-price">${formatCents(eurosToCents(item.price) * item.qty)}</span>
      </div>
    `;
    }).join('');
  }

  function renderCountryOptions() {
    if (!els.countrySelect) return;
    const options = ['<option value="" disabled selected>Selecione o país</option>']
      .concat(countries.map((c) => `
        <option value="${c.code}" ${c.enabled ? '' : 'disabled'}>
          ${c.name}${c.enabled ? '' : ' — brevemente'}
        </option>
      `));
    els.countrySelect.innerHTML = options.join('');
  }

  async function renderShippingMethods() {
    if (!els.shippingMethods) return;

    if (!selectedCountry) {
      els.shippingMethods.innerHTML = '<p class="empty-state">Selecione um país para ver os métodos de entrega disponíveis.</p>';
      hidePickupPointSection();
      return;
    }

    if (!selectedCountry.enabled) {
      els.shippingMethods.innerHTML = `<p class="empty-state">Ainda não entregamos em ${selectedCountry.name} nesta fase de testes. Selecione outro país.</p>`;
      hidePickupPointSection();
      return;
    }

    const methods = await window.MestreDoPanoShipping.getAvailableMethods(selectedCountry.code);

    if (methods.length === 0) {
      els.shippingMethods.innerHTML = '<p class="empty-state">Sem métodos de entrega configurados para este país.</p>';
      hidePickupPointSection();
      return;
    }

    // Portes: consultamos sempre o BACKEND real da transportadora primeiro
    // (ver docs/shipping.md) — quando a transportadora/conta não suporta
    // cotação em tempo real (available:false), usamos o tarifário manual
    // de data/shipping.json como fallback documentado, nunca inventamos
    // um valor novo.
    const rows = await Promise.all(methods.map(async (method) => {
      let priceCents = null;
      let sourceNote = '';

      if (method.provider && window.MestreDoPanoPayments) {
        try {
          const rateResult = await window.MestreDoPanoPayments.getShippingRates({
            provider: method.provider,
            country: selectedCountry.code,
            totalWeightG: weightG,
          });
          if (rateResult.available && Array.isArray(rateResult.rates) && rateResult.rates.length > 0) {
            const match = rateResult.rates.find((r) => r.priceCents != null) || rateResult.rates[0];
            priceCents = match.priceCents;
            sourceNote = ' (tarifa em tempo real)';
          }
        } catch (err) {
          console.warn('Cotação real indisponível, a usar tarifário de teste.', err);
        }
      }

      if (priceCents == null) {
        const fallback = await window.MestreDoPanoShipping.calculateShippingCents(selectedCountry.code, method.id, weightKg);
        priceCents = fallback.priceCents != null ? fallback.priceCents : null;
      }

      const priceLabel = priceCents != null ? formatCents(priceCents) : 'indisponível para este peso';
      const disabled = priceCents == null;
      return {
        method, priceCents, disabled,
        html: `
        <label class="shipping-option ${disabled ? 'is-disabled' : ''}">
          <input type="radio" name="metodo-entrega" value="${method.id}" ${disabled ? 'disabled' : ''}>
          <span class="shipping-option-name">${method.name}${sourceNote}</span>
          <span class="shipping-option-price">${priceLabel}</span>
        </label>
      `,
      };
    }));

    els.shippingMethods.innerHTML = rows.map((r) => r.html).join('') + '<p class="shipping-demo-note">Portes: tarifa em tempo real quando disponível; caso contrário, tarifário de teste — ver docs/shipping.md.</p>';

    els.shippingMethods.querySelectorAll('input[name="metodo-entrega"]').forEach((input) => {
      input.addEventListener('change', onMethodChange);
    });
  }

  function hidePickupPointSection() {
    selectedPickupPoint = null;
    if (els.pickupPointSection) els.pickupPointSection.hidden = true;
    if (els.pickupPointList) els.pickupPointList.innerHTML = '';
  }

  async function renderPickupPoints() {
    if (!els.pickupPointList || !selectedMethodConfig || !selectedMethodConfig.provider) return;

    els.pickupPointList.innerHTML = '<p class="empty-state">A carregar pontos de recolha…</p>';

    try {
      const result = await window.MestreDoPanoPayments.getPickupPoints({
        provider: selectedMethodConfig.provider,
        country: selectedCountry.code,
      });

      if (!result.available || !Array.isArray(result.points) || result.points.length === 0) {
        els.pickupPointList.innerHTML = `<p class="empty-state">Pontos de recolha indisponíveis para ${selectedCountry.name} nesta fase${result.message ? `: ${result.message}` : '.'}</p>`;
        return;
      }

      els.pickupPointList.innerHTML = result.points.slice(0, 20).map((point) => `
        <label class="pickup-point-option">
          <input type="radio" name="ponto-recolha" value="${point.id}">
          <span class="pickup-point-name">${point.name}</span>
          <span class="pickup-point-address">${point.address && point.address.line1 ? point.address.line1 : ''}${point.address && point.address.city ? `, ${point.address.city}` : ''}</span>
        </label>
      `).join('');

      els.pickupPointList.querySelectorAll('input[name="ponto-recolha"]').forEach((input) => {
        input.addEventListener('change', (event) => {
          const point = result.points.find((p) => String(p.id) === event.target.value);
          selectedPickupPoint = point || null;
          clearFieldError('ponto-recolha');
        });
      });
    } catch (err) {
      console.error(err);
      els.pickupPointList.innerHTML = '<p class="empty-state">Não foi possível carregar os pontos de recolha.</p>';
    }
  }

  function updateTotalsDisplay() {
    if (els.summaryWeight) els.summaryWeight.textContent = `${weightKg.toFixed(2).replace('.', ',')} kg`;
    if (els.summarySubtotal) els.summarySubtotal.textContent = formatCents(subtotalCents);
    if (els.summaryShipping) {
      els.summaryShipping.textContent = shippingCents != null ? formatCents(shippingCents) : 'Selecione país e método';
    }
    if (els.summaryTotal) {
      const total = subtotalCents + (shippingCents || 0);
      els.summaryTotal.textContent = shippingCents != null ? formatCents(total) : `${formatCents(subtotalCents)} + portes`;
    }
  }

  // ---- eventos ----------------------------------------------------------------

  function attachEvents() {
    if (els.countrySelect) els.countrySelect.addEventListener('change', onCountryChange);
    if (els.submitBtn) els.submitBtn.addEventListener('click', onSubmit);

    // limpar erro de campo assim que o utilizador o edita
    if (els.form) {
      els.form.querySelectorAll('input, select').forEach((field) => {
        field.addEventListener('input', () => clearFieldError(field.id));
      });
    }
  }

  async function onCountryChange(event) {
    const code = event.target.value;
    selectedCountry = countries.find((c) => c.code === code) || null;
    selectedMethodId = null;
    shippingCents = null;

    if (els.postalLabel) {
      els.postalLabel.textContent = selectedCountry ? `Código postal (${selectedCountry.postalCodeFormat})` : 'Código postal';
    }
    if (els.postalInput) {
      els.postalInput.placeholder = selectedCountry ? selectedCountry.postalCodeFormat : '';
    }
    if (els.regionRow) {
      const showRegion = !!(selectedCountry && selectedCountry.hasRegion);
      els.regionRow.hidden = !showRegion;
    }
    if (els.regionLabel && selectedCountry) {
      els.regionLabel.textContent = selectedCountry.regionLabel || 'Região';
    }

    clearFieldError('pais');
    await renderShippingMethods();
    updateTotalsDisplay();
  }

  async function onMethodChange(event) {
    selectedMethodId = event.target.value;
    const shippingConfig = await window.MestreDoPanoShipping.loadShippingConfig();
    selectedMethodConfig = (shippingConfig.methods || []).find((m) => m.id === selectedMethodId) || null;
    selectedPickupPoint = null;

    let priceCents = null;
    if (selectedMethodConfig && selectedMethodConfig.provider && window.MestreDoPanoPayments) {
      try {
        const rateResult = await window.MestreDoPanoPayments.getShippingRates({
          provider: selectedMethodConfig.provider,
          country: selectedCountry.code,
          totalWeightG: weightG,
        });
        if (rateResult.available && Array.isArray(rateResult.rates) && rateResult.rates.length > 0) {
          const match = rateResult.rates.find((r) => r.priceCents != null) || rateResult.rates[0];
          priceCents = match.priceCents;
        }
      } catch (err) {
        console.warn('Cotação real indisponível, a usar tarifário de teste.', err);
      }
    }
    if (priceCents == null) {
      const fallback = await window.MestreDoPanoShipping.calculateShippingCents(selectedCountry.code, selectedMethodId, weightKg);
      priceCents = fallback.priceCents != null ? fallback.priceCents : null;
    }
    shippingCents = priceCents;

    if (selectedMethodConfig && selectedMethodConfig.requiresPickupPoint) {
      if (els.pickupPointSection) els.pickupPointSection.hidden = false;
      await renderPickupPoints();
    } else {
      hidePickupPointSection();
    }

    clearFieldError('metodo-entrega');
    updateTotalsDisplay();
  }

  // ---- validação ----------------------------------------------------------------

  function setFieldError(fieldId, message) {
    const errorEl = document.querySelector(`[data-error-for="${fieldId}"]`);
    if (errorEl) errorEl.textContent = message;
    const input = document.getElementById(fieldId);
    if (input) input.classList.add('has-error');
  }

  function clearFieldError(fieldId) {
    const errorEl = document.querySelector(`[data-error-for="${fieldId}"]`);
    if (errorEl) errorEl.textContent = '';
    const input = document.getElementById(fieldId);
    if (input) input.classList.remove('has-error');
  }

  function clearAllErrors() {
    document.querySelectorAll('[data-error-for]').forEach((el) => { el.textContent = ''; });
    document.querySelectorAll('.has-error').forEach((el) => el.classList.remove('has-error'));
    if (els.formError) els.formError.hidden = true;
  }

  function showFormError(message) {
    if (!els.formError) return;
    els.formError.textContent = message;
    els.formError.hidden = false;
  }

  function val(id) {
    const el = document.getElementById(id);
    return el ? el.value.trim() : '';
  }

  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  function isValidPhone(phone) {
    return /^[0-9+()\s-]{6,20}$/.test(phone);
  }

  function validate() {
    clearAllErrors();
    let firstInvalid = null;
    const values = {
      nome: val('nome'),
      apelido: val('apelido'),
      email: val('email'),
      telefone: val('telefone'),
      morada: val('morada'),
      codigoPostal: val('codigo-postal'),
      cidade: val('cidade'),
      regiao: val('regiao'),
    };

    const fail = (fieldId, message) => {
      setFieldError(fieldId, message);
      if (!firstInvalid) firstInvalid = fieldId;
    };

    if (!values.nome) fail('nome', 'Por favor, indique o seu nome.');
    if (!values.apelido) fail('apelido', 'Por favor, indique o seu apelido.');
    if (!values.email) fail('email', 'Por favor, introduza o seu email.');
    else if (!isValidEmail(values.email)) fail('email', 'Por favor, introduza um email válido.');
    if (!values.telefone) fail('telefone', 'Por favor, indique o seu telefone.');
    else if (!isValidPhone(values.telefone)) fail('telefone', 'Por favor, introduza um telefone válido.');

    if (!selectedCountry) {
      fail('pais', 'Por favor, selecione o país de destino.');
    } else if (!selectedCountry.enabled) {
      fail('pais', 'Ainda não há entrega disponível para este país.');
    }

    if (!values.morada) fail('morada', 'Por favor, indique a morada.');

    if (!values.codigoPostal) {
      fail('codigo-postal', 'Por favor, indique o código postal.');
    } else if (selectedCountry && selectedCountry.postalCodeRegex && !(new RegExp(selectedCountry.postalCodeRegex).test(values.codigoPostal))) {
      fail('codigo-postal', `Por favor, introduza um código postal válido (formato: ${selectedCountry.postalCodeFormat}).`);
    }

    if (!values.cidade) fail('cidade', 'Por favor, indique a cidade.');

    if (selectedCountry && selectedCountry.enabled && (!selectedMethodId || shippingCents == null)) {
      fail('metodo-entrega', 'Por favor, selecione um método de entrega.');
    }

    if (selectedMethodConfig && selectedMethodConfig.requiresPickupPoint && !selectedPickupPoint) {
      fail('ponto-recolha', 'Por favor, selecione um ponto de recolha.');
    }

    if (firstInvalid) {
      const el = document.getElementById(firstInvalid) || els.shippingMethods;
      if (el && el.focus) el.focus();
      return { valid: false, values: null };
    }

    return { valid: true, values };
  }

  // ---- submissão: cria a encomenda no BACKEND e avança para o PayPal -----------
  //
  // O frontend nunca decide o total a pagar nem marca a encomenda como paga.
  // Ele só envia SKU + quantidade + morada/método ao backend, que recalcula
  // tudo (preço, peso, portes, total) e é quem fala com o PayPal.

  let submitting = false;

  async function onSubmit() {
    if (cartItems.length === 0) {
      showFormError('Não é possível fazer checkout com o carrinho vazio.');
      return;
    }
    if (submitting) return;

    const { valid, values } = validate();
    if (!valid) {
      showFormError('Por favor, corrija os campos assinalados antes de continuar.');
      return;
    }
    if (els.formError) els.formError.hidden = true;

    if (!window.MestreDoPanoPayments) {
      showFormError('Módulo de pagamentos não disponível. Recarregue a página.');
      return;
    }

    submitting = true;
    if (els.submitBtn) {
      els.submitBtn.disabled = true;
      els.submitBtn.textContent = 'A preparar pagamento…';
    }

    try {
      const result = await window.MestreDoPanoPayments.createBackendOrder({
        customer: {
          name: `${values.nome} ${values.apelido}`.trim(),
          email: values.email,
          phone: values.telefone,
        },
        shippingAddress: {
          country: selectedCountry.code,
          address: values.morada,
          postalCode: values.codigoPostal,
          city: values.cidade,
          region: values.regiao || null,
        },
        deliveryMethod: selectedMethodId,
        items: cartItems.map((item) => ({ productId: item.productId, qty: item.qty })),
      });

      backendOrderNumber = result.orderNumber;

      // Mostrar ao cliente os valores REAIS, tal como recalculados pelo
      // backend (podem diferir ligeiramente da pré-visualização local).
      subtotalCents = result.subtotal;
      shippingCents = result.shippingCost;
      updateTotalsDisplay();

      if (els.paypalSection) els.paypalSection.hidden = false;
      if (els.submitBtn) els.submitBtn.hidden = true;

      await window.MestreDoPanoPayments.renderPayPalButtons({
        containerSelector: '[data-paypal-button-container]',
        backendOrderId: backendOrderNumber,
        onApproved: (paymentResult) => showPaymentCompleted(paymentResult),
        onCancelled: () => showPaymentState('cancelled'),
        onError: (err) => {
          console.error(err);
          if (els.paypalError) {
            els.paypalError.hidden = false;
            els.paypalError.textContent = 'Não foi possível concluir o pagamento. Pode tentar novamente.';
          }
          showPaymentState('failed');
        },
      });
    } catch (err) {
      console.error(err);
      showFormError(err.message || 'Não foi possível criar a encomenda. Tente novamente.');
    } finally {
      submitting = false;
      if (els.submitBtn) {
        els.submitBtn.disabled = false;
        els.submitBtn.textContent = 'Continuar para pagamento';
      }
    }
  }

  function showPaymentState(state) {
    [els.paymentPending, els.paymentCancelled, els.paymentFailed, els.confirmation].forEach((el) => {
      if (el) el.hidden = true;
    });
    const map = { cancelled: els.paymentCancelled, failed: els.paymentFailed, pending: els.paymentPending };
    const target = map[state];
    if (target) target.hidden = false;
  }

  function showPaymentCompleted(result) {
    if (els.formWrap) els.formWrap.hidden = true;
    if (els.summary) els.summary.hidden = true;
    if (els.empty) els.empty.hidden = true;
    [els.paymentPending, els.paymentCancelled, els.paymentFailed].forEach((el) => {
      if (el) el.hidden = true;
    });
    if (!els.confirmation) return;

    els.confirmation.hidden = false;
    els.confirmation.innerHTML = `
      <div class="confirmation-box">
        <p class="confirmation-tag">PAGAMENTO CONCLUÍDO (PAYPAL SANDBOX)</p>
        <h2>Pagamento concluído!</h2>
        <p>Obrigado pela sua encomenda.</p>
        <dl class="confirmation-meta">
          <dt>Número da encomenda</dt><dd>${result.orderNumber}</dd>
          <dt>Total</dt><dd>${formatCents(result.total)}</dd>
        </dl>
        <p class="confirmation-note" data-shipment-status>A preparar o envio…</p>
        <a href="shop.html" class="btn btn-primary">Voltar à loja</a>
      </div>
    `;

    // Encomenda paga com sucesso: só agora esvaziamos o carrinho.
    window.MestreDoPanoCart.clear();

    // Criar o envio só DEPOIS do pagamento confirmado (secção 10 do pedido
    // da Fase 6) — o backend recusa criar o envio se payment_status ≠
    // COMPLETED, independentemente do que este frontend pensa que aconteceu.
    createShipmentAfterPaymentConfirmed(result.orderNumber);
  }

  async function createShipmentAfterPaymentConfirmed(orderNumber) {
    const statusEl = document.querySelector('[data-shipment-status]');
    if (!selectedMethodConfig || !selectedMethodConfig.provider) {
      if (statusEl) statusEl.textContent = '';
      return;
    }

    try {
      const result = await window.MestreDoPanoPayments.createShipmentAfterPayment({
        orderNumber,
        provider: selectedMethodConfig.provider,
        serviceId: selectedMethodConfig.providerServiceId || selectedMethodConfig.id,
        pickupPointId: selectedPickupPoint ? selectedPickupPoint.id : null,
      });
      if (statusEl) {
        const tracking = result.shipment && result.shipment.trackingNumber;
        statusEl.textContent = tracking
          ? `Envio criado. Número de seguimento: ${tracking}.`
          : 'Envio criado. O número de seguimento será disponibilizado em breve.';
      }
    } catch (err) {
      console.error(err);
      if (statusEl) {
        statusEl.textContent = 'O envio ainda não pôde ser criado automaticamente (ver docs/shipping.md). A nossa equipa irá processá-lo manualmente.';
      }
    }
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', () => {
  MestreDoPanoCheckout.init();
});
