const { chromium } = require('playwright');
const fs = require('fs');

const EN_CI =
  process.env.GITHUB_ACTIONS === 'true' ||
  process.env.CI === 'true';

const COMP_BASE =
  'https://www.futgal.es/pnfg/NPcd/NFG_CmpJornada?' +
  'cod_primaria=1000120' +
  '&CodCompeticion=26991153' +
  '&CodGrupo=28251751' +
  '&CodTemporada=22' +
  '&cod_agrupacion=1' +
  '&Sch_Codigo_Delegacion=1' +
  '&Sch_Tipo_Juego=1';

function clean(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function norm(s) {
  return clean(s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('es')
    .replace(/[^a-z0-9ñ]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function readJson(path, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(path, value) {
  fs.writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function fechaTimestamp(valor) {
  const m = String(valor || '').match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return null;
  return new Date(
    Number(m[3]),
    Number(m[2]) - 1,
    Number(m[1]),
    12, 0, 0, 0
  ).getTime();
}

function rangoSemanaActual() {
  const ahora = new Date();
  const dia = ahora.getDay();
  const deltaLunes = dia === 0 ? -6 : 1 - dia;

  const inicio = new Date(
    ahora.getFullYear(),
    ahora.getMonth(),
    ahora.getDate() + deltaLunes,
    0, 0, 0, 0
  );

  const fin = new Date(
    inicio.getFullYear(),
    inicio.getMonth(),
    inicio.getDate() + 6,
    23, 59, 59, 999
  );

  return {
    inicio: inicio.getTime(),
    fin: fin.getTime(),
    ahora: ahora.getTime()
  };
}

function seleccionarJornadaSemana(comp) {
  const rango = rangoSemanaActual();
  const candidatas = [];

  for (const j of comp.jornadas || []) {
    const fechas = (j.partidos || [])
      .map(p => fechaTimestamp(p.fecha))
      .filter(Number.isFinite);

    if (!fechas.length) continue;

    const dentro = fechas.filter(
      t => t >= rango.inicio && t <= rango.fin
    ).length;

    const centro =
      fechas.reduce((a, b) => a + b, 0) / fechas.length;

    candidatas.push({
      numero: Number(j.numero),
      dentro,
      distancia: Math.abs(centro - rango.ahora)
    });
  }

  const deEstaSemana = candidatas
    .filter(x => x.dentro > 0)
    .sort((a, b) =>
      b.dentro - a.dentro ||
      a.distancia - b.distancia ||
      a.numero - b.numero
    );

  if (deEstaSemana.length) return deEstaSemana[0].numero;

  const masCercana = candidatas
    .sort((a, b) =>
      a.distancia - b.distancia ||
      a.numero - b.numero
    )[0];

  if (!masCercana || !Number.isInteger(masCercana.numero)) {
    throw new Error(
      'Modo súper rápido: no pude determinar la jornada de esta semana.'
    );
  }

  return masCercana.numero;
}

function esControl(linea) {
  const t = clean(linea).toLocaleLowerCase('es');
  return [
    'anterior',
    'siguiente',
    'provisional',
    'definitivo',
    'resultados',
    'calendario',
    'clasificación',
    'clasificacion',
    'tabla cruzada',
    'goleadores',
    'imprimir',
    'contacta coa rfgf'
  ].includes(t);
}

function esLineaMarcador(linea) {
  return /^\d*\s*-\s*\d*$/.test(clean(linea));
}

function leerMarcador(lineas) {
  for (const linea of lineas) {
    const m = clean(linea).match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      const local = Number(m[1]);
      const visitante = Number(m[2]);
      return {
        local,
        visitante,
        texto: local + '-' + visitante,
        fuente: 'FUTGAL_JORNADA_RAPIDA'
      };
    }
  }
  return null;
}

function extraerJornadaDesdeTexto(texto) {
  const lineas = String(texto || '')
    .split(/\r?\n/)
    .map(clean)
    .filter(Boolean);

  const jl = lineas.find(l => /^Jornada\s+\d+$/i.test(l));
  const jornada = jl ? Number(jl.match(/\d+/)[0]) : null;
  const partidos = [];

  for (let i = 0; i < lineas.length; i++) {
    if (!/^\d{2}-\d{2}-\d{4}$/.test(lineas[i])) continue;

    const fecha = lineas[i];

    const marcadoresAntes = [];
    let p = i - 1;

    while (
      p >= 0 &&
      (esControl(lineas[p]) || esLineaMarcador(lineas[p]))
    ) {
      if (esLineaMarcador(lineas[p])) marcadoresAntes.unshift(lineas[p]);
      p--;
    }

    const local = p >= 0 ? lineas[p] : '';

    let j = i + 1;
    let hora = null;

    if (/^\d{1,2}:\d{2}$/.test(lineas[j] || '')) {
      hora = lineas[j];
      j++;
    }

    const marcadoresDespues = [];

    while (
      j < lineas.length &&
      (esControl(lineas[j]) || esLineaMarcador(lineas[j]))
    ) {
      if (esLineaMarcador(lineas[j])) marcadoresDespues.push(lineas[j]);
      j++;
    }

    const visitante = lineas[j] || '';
    j++;

    let campo = null;

    while (j < lineas.length) {
      const cand = lineas[j];

      if (esLineaMarcador(cand)) {
        marcadoresDespues.push(cand);
        j++;
        continue;
      }

      if (
        /^-\s*/.test(cand) ||
        /hierba/i.test(cand) ||
        esControl(cand)
      ) {
        j++;
        continue;
      }

      if (/^\d{2}-\d{2}-\d{4}$/.test(cand)) break;

      if (/^\d{1,2}:\d{2}$/.test(cand)) {
        j++;
        continue;
      }

      campo = cand;
      break;
    }

    const resultado =
      leerMarcador(marcadoresAntes) ||
      leerMarcador(marcadoresDespues);

    partidos.push({
      local,
      visitante,
      fecha,
      hora,
      campo,
      resultado
    });
  }

  return { jornada, partidos };
}

function validarExtraida(extra, esperada) {
  if (extra.jornada !== esperada) {
    throw new Error(
      'Modo súper rápido: FUTGAL devolvió J' +
      extra.jornada +
      ' y esperaba J' +
      esperada +
      '.'
    );
  }

  if (!Array.isArray(extra.partidos) || extra.partidos.length !== 8) {
    throw new Error(
      'Modo súper rápido: partidos detectados ' +
      (extra.partidos?.length || 0) +
      '/8.'
    );
  }

  const equipos = extra.partidos.flatMap(
    p => [norm(p.local), norm(p.visitante)]
  );

  if (new Set(equipos).size !== 16) {
    throw new Error(
      'Modo súper rápido: no aparecen 16 equipos distintos.'
    );
  }
}

function clavePartido(local, visitante) {
  return norm(local) + '|||' + norm(visitante);
}

function aplicarJornadaACompeticion(comp, numero, extra) {
  const jornada = (comp.jornadas || []).find(
    j => Number(j.numero) === Number(numero)
  );

  if (!jornada) {
    throw new Error(
      'Modo súper rápido: J' + numero + ' no existe en competicion.json.'
    );
  }

  const mapa = new Map(
    (jornada.partidos || []).map(p => [
      clavePartido(p.local, p.visitante),
      p
    ])
  );

  let resultadosLeidos = 0;

  for (const live of extra.partidos) {
    const actual = mapa.get(
      clavePartido(live.local, live.visitante)
    );

    if (!actual) {
      throw new Error(
        'Modo súper rápido: partido no reconocido: ' +
        live.local + ' - ' + live.visitante
      );
    }

    actual.local = live.local;
    actual.visitante = live.visitante;
    actual.fecha = live.fecha;
    actual.hora = live.hora;
    actual.campo = live.campo || actual.campo;

    if (live.resultado) {
      actual.resultado = live.resultado;
      resultadosLeidos++;

      if (actual.actaDisponible === true && actual.acta) {
        actual.estado = 'FINALIZADO';
      }
    }
  }

  jornada.fuenteActualizacion = 'FUTGAL_SUPER_RAPIDA';
  jornada.fechaActualizacionRapida = new Date().toISOString();

  return resultadosLeidos;
}

function actualizarCheckpoint(path, numero, extra) {
  const cp = readJson(path, null);
  if (!cp || !Array.isArray(cp.jornadas)) return;

  const j = cp.jornadas.find(
    x => Number(x.numero) === Number(numero)
  );

  if (!j || !Array.isArray(j.partidos)) return;

  const mapa = new Map(
    j.partidos.map(p => [
      clavePartido(p.local, p.visitante),
      p
    ])
  );

  for (const live of extra.partidos) {
    const p = mapa.get(
      clavePartido(live.local, live.visitante)
    );
    if (!p) continue;

    p.local = live.local;
    p.visitante = live.visitante;
    p.fecha = live.fecha;
    p.hora = live.hora;
    p.campo = live.campo || p.campo;

    if (live.resultado) p.resultado = live.resultado;
  }

  cp.fecha = new Date().toISOString();
  cp.modoActualizacion = 'fast';
  cp.jornadasObjetivoRapido = [numero];

  writeJson(path, cp);
}

(async () => {
  const comp = readJson('competicion.json', null);

  if (
    !comp ||
    !Array.isArray(comp.jornadas) ||
    comp.jornadas.length !== 30
  ) {
    throw new Error(
      'Modo súper rápido: competicion.json no contiene las 30 jornadas.'
    );
  }

  const jornadaObjetivo = seleccionarJornadaSemana(comp);

  console.log('==========================================');
  console.log(' FUTGAL SÚPER RÁPIDA');
  console.log(' Jornada única objetivo: J' + jornadaObjetivo);
  console.log(' Sin actas · sin goleadores');
  console.log('==========================================');

  const browser = await chromium.launch(
    EN_CI
      ? { channel: 'chrome', headless: true }
      : { channel: 'chrome', headless: false }
  );

  try {
    const page = await browser.newPage({
      locale: 'es-ES',
      timezoneId: 'Europe/Madrid'
    });

    const url =
      COMP_BASE +
      '&CodJornada=' +
      jornadaObjetivo;

    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    });

    await page.waitForTimeout(500);

    const body = await page.locator('body')
      .innerText()
      .catch(() => '');

    const extra = extraerJornadaDesdeTexto(body);
    validarExtraida(extra, jornadaObjetivo);

    const resultadosLeidos =
      aplicarJornadaACompeticion(
        comp,
        jornadaObjetivo,
        extra
      );

    comp.fechaExtraccion = new Date().toISOString();
    comp.modoActualizacion = 'fast';
    comp.jornadasObjetivoRapido = [jornadaObjetivo];
    comp.ultimaActualizacionRapida = {
      fecha: comp.fechaExtraccion,
      jornada: jornadaObjetivo,
      partidos: 8,
      resultadosLeidos,
      actasConsultadas: 0,
      goleadoresActualizados: false
    };

    writeJson('competicion.json', comp);

    actualizarCheckpoint(
      'checkpoint-calendario.json',
      jornadaObjetivo,
      extra
    );

    actualizarCheckpoint(
      'checkpoint-calendario-parcial.json',
      jornadaObjetivo,
      extra
    );

    console.log(
      'J' + jornadaObjetivo +
      ': 8/8 partidos · ' +
      resultadosLeidos +
      ' marcador(es) visibles.'
    );

    console.log('Actas consultadas: 0');
    console.log('Goleadores actualizados: NO');
    console.log('SÚPER RÁPIDA OK');
  } finally {
    await browser.close();
  }
})().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
