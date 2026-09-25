/*
 * AppDorneda · Paso 11C
 * Web -> Cloudflare Worker -> GitHub Actions -> FUTGAL -> Resultados y Búsqueda.
 */
(function () {
  'use strict';

  const WORKER_URL = 'https://appdorneda-futgal.felopezgr.workers.dev';
  const REQUEST_KEY = 'dorneda_futgal_cloud_request_prod';
  const PIN_KEY = 'dorneda_futgal_cloud_pin_session_prod';

  let pollTimer = null;

  function el(id) { return document.getElementById(id); }

  function esc(v) {
    return String(v ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function getPin() {
    return sessionStorage.getItem(PIN_KEY) || '';
  }

  function setPin(v) {
    sessionStorage.setItem(PIN_KEY, String(v || '').trim());
  }

  function setEstado(html, tipo = 'normal') {
    const box = el('futgalCloudStatus');
    if (!box) return;

    const tonos = {
      normal: 'rgba(59,130,246,0.08)',
      ok: 'rgba(22,163,74,0.10)',
      error: 'rgba(220,38,38,0.09)',
      warning: 'rgba(234,179,8,0.10)'
    };

    box.style.background = tonos[tipo] || tonos.normal;
    box.innerHTML = html;
  }

  async function api(path, options = {}) {
    const pin = getPin();

    if (!pin) {
      throw new Error('Introduce el PIN de actualización.');
    }

    const headers = new Headers(options.headers || {});
    headers.set('X-Dorneda-Pin', pin);

    if (options.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    const res = await fetch(WORKER_URL + path, {
      ...options,
      headers,
      cache: 'no-store'
    });

    const text = await res.text();
    let body = {};

    try {
      body = text ? JSON.parse(text) : {};
    } catch (e) {
      body = { error: text || `HTTP ${res.status}` };
    }

    if (!res.ok) {
      throw new Error(body?.error || body?.message || `HTTP ${res.status}`);
    }

    return body;
  }

  function guardarPin() {
    const pin = String(el('futgalCloudPin')?.value || '').trim();
    if (!pin) {
      setEstado('Introduce el PIN de actualización.', 'error');
      return false;
    }
    setPin(pin);
    return true;
  }

  async function probarConexionFutgalCloud() {
    setEstado('Comprobando el servicio…', 'normal');

    try {
      const res = await fetch(WORKER_URL + '/health', { cache: 'no-store' });
      const data = await res.json();

      if (!res.ok || !data.ok) {
        throw new Error(data?.error || 'El Worker no respondió correctamente.');
      }

      setEstado(
        `Servicio conectado.<br><strong>Repositorio:</strong> ${esc(data.repo)} · ` +
        `<strong>Rama:</strong> ${esc(data.ref)}`,
        'ok'
      );
    } catch (err) {
      setEstado(`No se pudo conectar: ${esc(err.message || err)}`, 'error');
    }
  }

  function pintarProgreso(st) {
    if (st.status === 'queued' || st.status === 'waiting_for_run') {
      setEstado(
        `<strong>GitHub Actions:</strong> en cola.<br>` +
        `Solicitud: <code>${esc(st.request_id || '')}</code>`,
        'warning'
      );
      return;
    }

    if (st.status === 'in_progress') {
      setEstado(
        `<strong>Actualizando FUTGAL en la nube…</strong><br>` +
        `Ejecución #${esc(st.run_number || '')}. Puedes cerrar el navegador: GitHub continuará trabajando.`,
        'normal'
      );
      return;
    }

    if (st.status === 'completed' && st.conclusion === 'success') {
      setEstado(
        '<strong>Extracción y validación correctas.</strong><br>' +
        'Cargando los nuevos datos oficiales en Resultados y Búsqueda…',
        'ok'
      );
      return;
    }

    if (st.status === 'completed') {
      setEstado(
        `<strong>GitHub terminó con error.</strong><br>` +
        `Conclusión: ${esc(st.conclusion || 'desconocida')}. Los datos anteriores se mantienen.`,
        'error'
      );
    }
  }

  function detenerPolling() {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  async function aplicarDatosTrasExito(requestId) {
    const result = await api(`/data?request_id=${encodeURIComponent(requestId)}`);

    if (!result?.competicion) {
      throw new Error('El servicio no devolvió competicion.json.');
    }

    if (!window.FutgalOfficial) {
      throw new Error('El módulo de datos oficiales no está disponible.');
    }

    window.FutgalOfficial.apply(result.competicion, {
      source: `GitHub Actions #${result.run_number || ''}`
    });

    localStorage.removeItem(REQUEST_KEY);
    detenerPolling();

    setEstado(
      `<strong>Actualización completada.</strong><br>` +
      `30 jornadas y 240 partidos cargados desde GitHub Actions #${esc(result.run_number || '')}.`,
      'ok'
    );

    if (typeof window.toast === 'function') {
      window.toast('✓ Resultados FUTGAL actualizados', 'success');
    }

    setTimeout(() => {
      try { window.closeModal('modalFutgalCloud'); } catch (e) {}
    }, 1200);
  }

  async function consultarEstadoFutgalCloud(requestId, silencioso = false) {
    try {
      const st = await api(`/status?request_id=${encodeURIComponent(requestId)}`);
      pintarProgreso(st);

      if (st.status === 'completed' && st.conclusion === 'success') {
        await aplicarDatosTrasExito(requestId);
        return;
      }

      if (st.status === 'completed') {
        localStorage.removeItem(REQUEST_KEY);
        detenerPolling();
        return;
      }

      pollTimer = setTimeout(
        () => consultarEstadoFutgalCloud(requestId, true),
        5000
      );

    } catch (err) {
      if (!silencioso) {
        setEstado(`Error consultando GitHub: ${esc(err.message || err)}`, 'error');
      }

      pollTimer = setTimeout(
        () => consultarEstadoFutgalCloud(requestId, true),
        10000
      );
    }
  }

  async function lanzarActualizacionFutgalCloud() {
    if (!guardarPin()) return;

    const btn = el('btnFutgalCloudStart');
    if (btn) btn.disabled = true;

    detenerPolling();
    setEstado('<strong>Solicitando una nueva ejecución a GitHub Actions…</strong>', 'normal');

    try {
      const result = await api('/start', {
        method: 'POST',
        body: JSON.stringify({})
      });

      if (!result?.request_id) {
        throw new Error('No recibí el identificador de la ejecución.');
      }

      localStorage.setItem(REQUEST_KEY, result.request_id);
      await consultarEstadoFutgalCloud(result.request_id);

    } catch (err) {
      setEstado(`No se pudo iniciar la actualización: ${esc(err.message || err)}`, 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function abrirActualizacionFutgalCloud() {
    const pinInput = el('futgalCloudPin');
    if (pinInput) pinInput.value = getPin();

    if (typeof window.openModal === 'function') {
      window.openModal('modalFutgalCloud');
    } else {
      el('modalFutgalCloud')?.classList.add('open');
    }

    const pendiente = localStorage.getItem(REQUEST_KEY);

    if (pendiente && getPin()) {
      setEstado(
        `Hay una actualización pendiente.<br>` +
        `Reanudando seguimiento de <code>${esc(pendiente)}</code>…`,
        'normal'
      );
      consultarEstadoFutgalCloud(pendiente);
      return;
    }

    const meta = window.FutgalOfficial?.getMeta?.();
    const ultima = meta?.extractedAt
      ? window.FutgalOfficial.formatDateTime(meta.extractedAt)
      : '';

    setEstado(
      ultima
        ? `Datos oficiales cargados.<br><strong>Última extracción:</strong> ${esc(ultima)}`
        : 'Listo para ejecutar el extractor FUTGAL en GitHub.',
      'normal'
    );
  }

  function cancelarSeguimientoFutgalCloud() {
    detenerPolling();
    localStorage.removeItem(REQUEST_KEY);
    setEstado(
      'Seguimiento detenido en este navegador. GitHub continuará si la ejecución ya estaba iniciada.',
      'warning'
    );
  }

  async function cargarFutgalJsonManual(event) {
    const file = event?.target?.files?.[0];
    if (!file) return;

    try {
      await window.FutgalOfficial.loadManualFile(file);
      if (typeof window.toast === 'function') {
        window.toast('✓ JSON oficial cargado manualmente', 'success');
      }
    } catch (err) {
      alert('No se pudo cargar el JSON:\n\n' + String(err?.message || err));
    } finally {
      if (event?.target) event.target.value = '';
    }
  }

  function seleccionarFutgalJsonManual() {
    el('futgalOfficialFileInput')?.click();
  }

  window.abrirActualizacionFutgalCloud = abrirActualizacionFutgalCloud;
  window.probarConexionFutgalCloud = probarConexionFutgalCloud;
  window.lanzarActualizacionFutgalCloud = lanzarActualizacionFutgalCloud;
  window.cancelarSeguimientoFutgalCloud = cancelarSeguimientoFutgalCloud;
  window.cargarFutgalJsonManual = cargarFutgalJsonManual;
  window.seleccionarFutgalJsonManual = seleccionarFutgalJsonManual;
})();
