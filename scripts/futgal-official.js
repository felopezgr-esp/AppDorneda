/*
 * AppDorneda · Paso 11C
 * Fuente oficial de Liga para "Resultados y Búsqueda".
 *
 * competicion.json es la única fuente de verdad de esta pantalla.
 * No modifica db, Firebase, clasificación, Copa, plantilla ni datos manuales.
 */
(function () {
  'use strict';

  const CACHE_KEY = 'dorneda_futgal_official_cache_v1';
  const META_KEY = 'dorneda_futgal_official_meta_v1';
  const RAW_FALLBACK =
    'https://raw.githubusercontent.com/felopezgr-esp/AppDorneda/main/competicion.json';

  const state = {
    data: null,
    jornadas: [],
    meta: null,
    loading: false,
    error: null
  };

  function norm(v) {
    return String(v ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase()
      .replace(/\./g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function fechaSlash(v) {
    const s = String(v || '').trim();
    const m = s.match(/^(\d{2})-(\d{2})-(\d{4})$/);
    return m ? `${m[1]}/${m[2]}/${m[3]}` : s;
  }

  function minutoLimpio(v) {
    if (v === null || v === undefined || v === '') return null;
    return String(v).replace(/[’']/g, '').replace(/\s+/g, '').trim();
  }

  function codActaDesdeUrl(url) {
    const m = String(url || '').match(/[?&](?:CodActa|cod_acta)=(\d+)/i);
    return m ? m[1] : '';
  }

  function equipoStaff(obj) {
    if (!obj || typeof obj !== 'object') return [];

    const etiquetas = {
      delegado: 'Delegado',
      entrenador: 'Entrenador',
      segundo_entrenador: 'Segundo Entrenador',
      auxiliar: 'Auxiliar',
      medico: 'Médico',
      preparador: 'Preparador'
    };

    return Object.entries(obj)
      .filter(([, value]) => value && !/^no presenta$/i.test(String(value).trim()))
      .map(([key, value]) => ({
        cargo: etiquetas[key] || key.replace(/_/g, ' '),
        nombre: String(value)
      }));
  }

  function tarjetasActa(lista) {
    return (Array.isArray(lista) ? lista : []).map(t => ({
      minuto: minutoLimpio(t.minuto),
      tipo: String(t.tipo || '').toLowerCase().includes('roja') ? 'Roja' : 'Amarilla',
      nombre: t.jugador || ''
    }));
  }

  function alineacionActa(lista) {
    return (Array.isArray(lista) ? lista : []).map(x => ({
      dorsal: x.dorsal ?? '',
      nombre: x.jugador || x.nombre || ''
    }));
  }

  function actaDataDesdeFuente(p) {
    if (!p?.acta) return null;

    const a = p.acta;
    const url = a.url || '';
    const resultado = p.resultado || {};
    const eqL = a.equipo_local || {};
    const eqV = a.equipo_visitante || {};

    const goles = (Array.isArray(a.goles) ? a.goles : []).map(g => ({
      minuto: minutoLimpio(g.minuto),
      scoreProgression: g?.marcador
        ? `${g.marcador.local} - ${g.marcador.visitante}`
        : '',
      rawScorer: g.jugador || '',
      penalti: /penalti/i.test(String(g.tipo_gol || '')),
      propiaPuerta: /propia/i.test(String(g.tipo_gol || '')),
      tipo: g.tipo_gol || 'Gol'
    }));

    return {
      codActa: codActaDesdeUrl(url),
      enlaceActa: url,
      localTeam: p.local,
      visitTeam: p.visitante,
      fecha: fechaSlash(p.fecha),
      hora: p.hora || '',
      arbitro: a.arbitro || '',
      campo: a.estadio || p.campo || '',
      ciudad: a.ciudad || '',
      localTitulares: alineacionActa(eqL.titulares),
      localSuplentes: alineacionActa(eqL.suplentes),
      localStaff: equipoStaff(eqL.cuerpo_tecnico),
      localTarjetas: tarjetasActa(eqL.tarjetas),
      visitTitulares: alineacionActa(eqV.titulares),
      visitSuplentes: alineacionActa(eqV.suplentes),
      visitStaff: equipoStaff(eqV.cuerpo_tecnico),
      visitTarjetas: tarjetasActa(eqV.tarjetas),
      allGoles: goles,
      resultado: resultado.texto || ''
    };
  }

  function validate(data) {
    const errores = [];

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { correcto: false, errores: ['JSON inválido.'] };
    }

    if (data.fuente !== 'FUTGAL') errores.push('Fuente distinta de FUTGAL.');
    if (data.temporada !== '2026-2027') errores.push('Temporada distinta de 2026-2027.');
    if (!Array.isArray(data.equipos) || data.equipos.length !== 16) {
      errores.push(`Equipos: ${Array.isArray(data.equipos) ? data.equipos.length : 0}/16.`);
    }
    if (!Array.isArray(data.jornadas) || data.jornadas.length !== 30) {
      errores.push(`Jornadas: ${Array.isArray(data.jornadas) ? data.jornadas.length : 0}/30.`);
      return { correcto: false, errores };
    }

    let partidos = 0;
    const numeros = new Set();

    for (const j of data.jornadas) {
      const n = Number(j.numero);
      if (!Number.isInteger(n) || n < 1 || n > 30 || numeros.has(n)) {
        errores.push(`Jornada inválida o duplicada: ${j.numero}.`);
      }
      numeros.add(n);

      const lista = Array.isArray(j.partidos) ? j.partidos : [];
      if (lista.length !== 8) errores.push(`J${n}: ${lista.length}/8 partidos.`);
      partidos += lista.length;

      const equipos = [];
      for (const p of lista) {
        if (!p.local || !p.visitante || !p.fecha) {
          errores.push(`J${n}: partido incompleto.`);
          continue;
        }
        equipos.push(norm(p.local), norm(p.visitante));
        if (p.estado === 'FINALIZADO' && !p.resultado) {
          errores.push(`J${n} ${p.local}-${p.visitante}: finalizado sin resultado.`);
        }
      }

      if (new Set(equipos).size !== 16) {
        errores.push(`J${n}: no aparecen 16 equipos distintos.`);
      }
    }

    if (partidos !== 240) errores.push(`Partidos: ${partidos}/240.`);
    if (Number(data.totalJornadas) !== 30) errores.push('Cabecera totalJornadas incorrecta.');
    if (Number(data.totalPartidos) !== 240) errores.push('Cabecera totalPartidos incorrecta.');

    return { correcto: errores.length === 0, errores };
  }

  function convertir(data) {
    return data.jornadas
      .map(j => {
        const partidos = (j.partidos || []).map((p, idx) => {
          const url = p?.acta?.url || '';
          return {
            id: Number(j.numero) * 100 + (Number(p.orden) || idx + 1),
            local: p.local,
            visitante: p.visitante,
            fecha: fechaSlash(p.fecha),
            hora: p.hora || '',
            campo: p.campo || '',
            dorneda: /DORNEDA/i.test(String(p.local || '')) || /DORNEDA/i.test(String(p.visitante || '')),
            estado: p.estado === 'FINALIZADO' ? 'Finalizado' : 'Programado',
            gl: p.resultado ? Number(p.resultado.local) : null,
            gv: p.resultado ? Number(p.resultado.visitante) : null,
            enlaceActa: url,
            codActa: codActaDesdeUrl(url),
            arbitro: p?.acta?.arbitro || '',
            actaData: actaDataDesdeFuente(p)
          };
        });

        const fechas = partidos
          .map(p => p.fecha)
          .filter(Boolean)
          .sort((a, b) => {
            const ma = a.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
            const mb = b.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
            const ta = ma ? Date.UTC(+ma[3], +ma[2] - 1, +ma[1]) : 0;
            const tb = mb ? Date.UTC(+mb[3], +mb[2] - 1, +mb[1]) : 0;
            return ta - tb;
          });

        return {
          jornada: Number(j.numero),
          fecha: fechas[0] || '',
          vuelta: Number(j.numero) > 15 ? 2 : 1,
          partidos
        };
      })
      .sort((a, b) => a.jornada - b.jornada);
  }

  function formatDateTime(v) {
    if (!v) return '';
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return String(v);
    return d.toLocaleString('es-ES', {
      timeZone: 'Europe/Madrid',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function refreshUI() {
    try {
      if (typeof window.updateFutgalSyncUI === 'function') {
        window.updateFutgalSyncUI();
      }
    } catch (e) {}

    try {
      if (typeof window.renderLigaResultadosView === 'function') {
        window.renderLigaResultadosView();
      }
    } catch (e) {
      console.warn('No se pudo refrescar Resultados y Búsqueda:', e);
    }
  }

  function apply(data, options = {}) {
    const val = validate(data);
    if (!val.correcto) {
      const err = new Error('competicion.json no válido: ' + val.errores.slice(0, 5).join(' | '));
      err.validation = val;
      throw err;
    }

    state.data = data;
    state.jornadas = convertir(data);
    state.error = null;
    state.loading = false;
    state.meta = {
      source: options.source || 'FUTGAL',
      loadedAt: new Date().toISOString(),
      extractedAt: data.fechaExtraccion || '',
      totalJornadas: data.totalJornadas,
      totalPartidos: data.totalPartidos,
      totalActas: data.totalActasIntegradas ?? data.totalActasDetectadas ?? 0
    };

    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(data));
      localStorage.setItem(META_KEY, JSON.stringify(state.meta));
    } catch (e) {
      console.warn('No se pudo guardar caché oficial FUTGAL:', e);
    }

    refreshUI();
    return val;
  }

  function loadCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return false;
      apply(JSON.parse(raw), { source: 'cache' });
      return true;
    } catch (e) {
      return false;
    }
  }

  async function fetchJson(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function loadFresh() {
    state.loading = true;
    state.error = null;

    const stamp = Date.now();
    const urls = [];

    if (/^https?:$/i.test(location.protocol)) {
      urls.push(new URL(`competicion.json?v=${stamp}`, location.href).href);
    }

    urls.push(`${RAW_FALLBACK}?v=${stamp}`);

    let lastError = null;

    for (const url of urls) {
      try {
        const data = await fetchJson(url);
        apply(data, { source: url });
        return data;
      } catch (e) {
        lastError = e;
      }
    }

    state.loading = false;
    state.error = lastError || new Error('No se pudo cargar competicion.json.');
    refreshUI();
    throw state.error;
  }

  async function loadManualFile(file) {
    const text = await file.text();
    const data = JSON.parse(text);
    apply(data, { source: 'manual' });
    return data;
  }

  function getJornadas() {
    return state.jornadas;
  }

  function getData() {
    return state.data;
  }

  function getMeta() {
    return state.meta;
  }

  function getStatus() {
    return {
      loading: state.loading,
      error: state.error ? String(state.error.message || state.error) : '',
      hasData: state.jornadas.length === 30
    };
  }

  window.FutgalOfficial = {
    validate,
    apply,
    loadFresh,
    loadManualFile,
    getJornadas,
    getData,
    getMeta,
    getStatus,
    formatDateTime
  };

  loadCache();

  // Siempre intentamos refrescar desde el JSON publicado.
  loadFresh().catch(err => {
    console.warn('FUTGAL oficial: se mantiene la última caché válida.', err);
  });
})();
