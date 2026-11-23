const { chromium } = require('playwright');
const fs = require('fs');

const EN_CI =
  process.env.GITHUB_ACTIONS === 'true' ||
  process.env.CI === 'true';

const COMPETICION_DIRECTA =
  'https://www.futgal.es/pnfg/NPcd/NFG_CmpJornada?' +
  'cod_primaria=1000120' +
  '&CodCompeticion=26991153' +
  '&CodGrupo=28251751' +
  '&CodTemporada=22' +
  '&cod_agrupacion=1' +
  '&CodJornada=1' +
  '&Sch_Codigo_Delegacion=1' +
  '&Sch_Tipo_Juego=1';

const CLASIFICACION_DIRECTA_CANDIDATOS = [
  'https://www.futgal.es/pnfg/NPcd/NFG_VisClasificacion?' +
    'cod_primaria=1000110&CodCompeticion=26991153&CodGrupo=28251751&CodTemporada=22' +
    '&cod_agrupacion=1&Sch_Codigo_Delegacion=1&Sch_Tipo_Juego=1',
  'https://www.futgal.es/pnfg/NPcd/NFG_VisClasificacion?' +
    'cod_primaria=1000120&CodCompeticion=26991153&CodGrupo=28251751&CodTemporada=22' +
    '&cod_agrupacion=1&Sch_Codigo_Delegacion=1&Sch_Tipo_Juego=1'
];

function clean(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function norm(s) {
  return clean(s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\./g, '')
    .replace(/[^A-Z0-9Ñ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function leerJson(ruta) {
  return JSON.parse(fs.readFileSync(ruta, 'utf8'));
}

function guardarJson(ruta, valor) {
  fs.writeFileSync(ruta, JSON.stringify(valor, null, 2) + '\n', 'utf8');
}

function numeroCelda(v) {
  const s = clean(v).replace(',', '.');
  const m = s.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

function equiposDesdeCompeticion(c) {
  const mapa = new Map();

  for (const j of (c.jornadas || [])) {
    for (const p of (j.partidos || [])) {
      for (const nombre of [p.local, p.visitante]) {
        const k = norm(nombre);
        if (k && !mapa.has(k)) mapa.set(k, clean(nombre));
      }
    }
  }

  return [...mapa.values()];
}

function statsCalculados(c) {
  const out = new Map();

  function ensure(nombre) {
    const k = norm(nombre);
    if (!out.has(k)) {
      out.set(k, {
        equipo: clean(nombre),
        pj: 0,
        g: 0,
        e: 0,
        p: 0,
        gf: 0,
        gc: 0,
        pts: 0
      });
    }
    return out.get(k);
  }

  for (const j of (c.jornadas || [])) {
    for (const m of (j.partidos || [])) {
      const r = m && m.resultado;
      if (!r) continue;

      const gl = Number(r.local);
      const gv = Number(r.visitante);
      if (!Number.isFinite(gl) || !Number.isFinite(gv)) continue;

      const l = ensure(m.local);
      const v = ensure(m.visitante);

      l.pj++; v.pj++;
      l.gf += gl; l.gc += gv;
      v.gf += gv; v.gc += gl;

      if (gl > gv) {
        l.g++; v.p++;
        l.pts += 3;
      } else if (gv > gl) {
        v.g++; l.p++;
        v.pts += 3;
      } else {
        l.e++; v.e++;
        l.pts++; v.pts++;
      }
    }
  }

  return out;
}

function headerKey(v) {
  return norm(v).replace(/\s+/g, ' ');
}

function detectarColumnas(headers) {
  const idx = {};

  headers.forEach((h, i) => {
    const k = headerKey(h);

    if (idx.pos == null && /^(POS|POSICION|PUESTO|CLASIFICACION|CLAS)$/.test(k)) idx.pos = i;
    if (idx.equipo == null && /^(EQUIPO|CLUB|EQUIPOS|CLUBES)$/.test(k)) idx.equipo = i;
    if (idx.pts == null && /^(PT|PTS|PTO|PTOS|PUNTOS)$/.test(k)) idx.pts = i;
    if (idx.pj == null && /^(PJ|J|JUG|JUGADOS|PARTIDOS)$/.test(k)) idx.pj = i;
    if (idx.g == null && /^(PG|G|GAN|GANADOS|VICTORIAS)$/.test(k)) idx.g = i;
    if (idx.e == null && /^(PE|E|EMP|EMPATADOS|EMPATES)$/.test(k)) idx.e = i;
    if (idx.p == null && /^(PP|PER|PERDIDOS|DERROTAS)$/.test(k)) idx.p = i;
    if (idx.gf == null && /^(GF|GOLES FAVOR|GOLES A FAVOR|FAVOR)$/.test(k)) idx.gf = i;
    if (idx.gc == null && /^(GC|GOLES CONTRA|GOLES EN CONTRA|CONTRA)$/.test(k)) idx.gc = i;
    if (idx.dg == null && /^(DG|DIF|DIFERENCIA)$/.test(k)) idx.dg = i;
  });

  return idx;
}

function equipoDeFila(cells, equipos) {
  const conocidos = equipos.map(e => ({ nombre: e, k: norm(e) }));

  for (let i = 0; i < cells.length; i++) {
    const ck = norm(cells[i]);
    if (!ck) continue;

    const exacto = conocidos.find(x => ck === x.k);
    if (exacto) return { equipo: exacto.nombre, indice: i };
  }

  for (let i = 0; i < cells.length; i++) {
    const ck = norm(cells[i]);
    if (!ck) continue;

    const parcial = conocidos.find(x =>
      (ck.includes(x.k) || x.k.includes(ck)) &&
      Math.min(ck.length, x.k.length) >= 5
    );

    if (parcial) return { equipo: parcial.nombre, indice: i };
  }

  return null;
}

function inferirColumnaPuntos(teamRows, equipos, stats) {
  const maxCols = Math.max(...teamRows.map(r => r.cells.length));
  const candidatos = [];

  for (let col = 0; col < maxCols; col++) {
    const valores = [];
    let filasValidas = 0;
    let coincideEquipo = false;

    for (const row of teamRows) {
      const hit = equipoDeFila(row.cells, equipos);
      if (!hit) continue;
      if (hit.indice === col) {
        coincideEquipo = true;
        break;
      }

      const n = numeroCelda(row.cells[col]);
      if (n == null) continue;
      filasValidas++;
      valores.push(n);
    }

    if (coincideEquipo || filasValidas < Math.min(14, teamRows.length)) continue;

    const ints = valores.map(Number);
    const esPosicion =
      ints.length >= 14 &&
      ints.every((v, i) => Number.isInteger(v) && v === i + 1);

    if (esPosicion) continue;

    let ordenCorrecto = 0;
    for (let i = 0; i < ints.length - 1; i++) {
      if (ints[i] >= ints[i + 1]) ordenCorrecto++;
    }

    const min = Math.min(...ints);
    const max = Math.max(...ints);
    const rango = max - min;

    if (min < -20 || max > 100 || rango < 2) continue;

    // Los puntos de una clasificación están ordenados de mayor a menor.
    // Como desempates pueden intercalar equipos con los mismos puntos, la secuencia
    // debe ser prácticamente monótona.
    const monotonia = ints.length > 1 ? ordenCorrecto / (ints.length - 1) : 0;
    if (monotonia < 0.85) continue;

    // Refuerzo: la columna de puntos suele estar cerca de la suma obtenida por resultados,
    // salvo sanciones/ajustes administrativos.
    let cercania = 0;
    let nCercania = 0;
    for (const row of teamRows) {
      const hit = equipoDeFila(row.cells, equipos);
      if (!hit) continue;
      const v = numeroCelda(row.cells[col]);
      const calc = stats.get(norm(hit.equipo));
      if (v == null || !calc) continue;
      cercania += Math.abs(v - calc.pts);
      nCercania++;
    }

    const errorMedio = nCercania ? cercania / nCercania : 99;
    const score = monotonia * 100 + Math.min(rango, 30) - errorMedio * 2;

    candidatos.push({ col, score, monotonia, errorMedio });
  }

  candidatos.sort((a, b) => b.score - a.score);
  return candidatos.length ? candidatos[0].col : null;
}

function resolverTabla(datosDom, equipos, stats) {
  const tablas = Array.isArray(datosDom.tables) ? datosDom.tables : [];
  const candidatas = [];

  for (let ti = 0; ti < tablas.length; ti++) {
    const rows = tablas[ti].rows || [];
    const teamRows = rows.filter(r => equipoDeFila(r.cells || [], equipos));
    candidatas.push({ ti, rows, teamRows });
  }

  candidatas.sort((a, b) => b.teamRows.length - a.teamRows.length);
  let elegida = candidatas[0] || null;

  // Respaldo para una maquetación sin <table>: filas detectadas alrededor del nombre del club.
  if (!elegida || elegida.teamRows.length < equipos.length) {
    const generic = (datosDom.genericRows || []).filter(r => equipoDeFila(r.cells || [], equipos));
    if (generic.length > (elegida ? elegida.teamRows.length : 0)) {
      elegida = { ti: -1, rows: generic, teamRows: generic };
    }
  }

  if (!elegida || elegida.teamRows.length < equipos.length) {
    throw new Error(
      `Clasificación FUTGAL incompleta en DOM: ${elegida ? elegida.teamRows.length : 0}/${equipos.length} equipos.`
    );
  }

  // Eliminamos duplicados de equipo conservando el primer orden visible.
  const vistos = new Set();
  const teamRows = [];
  for (const row of elegida.teamRows) {
    const hit = equipoDeFila(row.cells || [], equipos);
    if (!hit) continue;
    const k = norm(hit.equipo);
    if (vistos.has(k)) continue;
    vistos.add(k);
    teamRows.push({ ...row, _team: hit });
  }

  if (teamRows.length !== equipos.length) {
    throw new Error(`Clasificación FUTGAL: ${teamRows.length}/${equipos.length} equipos únicos.`);
  }

  // Buscamos una cabecera compatible antes de las filas de equipos.
  let headers = [];
  if (elegida.ti >= 0) {
    const firstTeamIndex = elegida.rows.findIndex(r => equipoDeFila(r.cells || [], equipos));
    const prev = firstTeamIndex > 0 ? elegida.rows.slice(0, firstTeamIndex) : [];
    const conClaves = prev
      .map(r => ({ cells: r.cells || [], cols: detectarColumnas(r.cells || []) }))
      .sort((a, b) => Object.keys(b.cols).length - Object.keys(a.cols).length);
    headers = conClaves[0] ? conClaves[0].cells : [];
  }

  const cols = detectarColumnas(headers);
  if (cols.pts == null) {
    cols.pts = inferirColumnaPuntos(teamRows, equipos, stats);
  }

  if (cols.pts == null) {
    throw new Error('No pude identificar de forma segura la columna de puntos de FUTGAL.');
  }

  const salida = teamRows.map((row, index) => {
    const cells = row.cells || [];
    const hit = row._team || equipoDeFila(cells, equipos);
    const calc = stats.get(norm(hit.equipo));

    function val(col, fallback = null) {
      if (col == null || col < 0 || col >= cells.length) return fallback;
      const n = numeroCelda(cells[col]);
      return n == null ? fallback : n;
    }

    const pts = val(cols.pts, null);
    if (pts == null) {
      throw new Error(`FUTGAL: puntos no legibles para ${hit.equipo}.`);
    }

    let pos = val(cols.pos, null);
    if (!Number.isInteger(pos) || pos < 1 || pos > equipos.length) pos = index + 1;

    const puntosCalculados = calc ? calc.pts : null;
    const ajustePuntos = puntosCalculados == null ? null : pts - puntosCalculados;

    return {
      pos,
      equipo: hit.equipo,
      pts,
      pj: val(cols.pj, null),
      g: val(cols.g, null),
      e: val(cols.e, null),
      p: val(cols.p, null),
      gf: val(cols.gf, null),
      gc: val(cols.gc, null),
      dg: val(cols.dg, null),
      puntosCalculados,
      ajustePuntos,
      ajusteMotivo: ajustePuntos ? 'Ajuste oficial FUTGAL' : '',
      fuente: 'FUTGAL'
    };
  });

  // La posición visual es también fuente oficial. Reordenamos por pos cuando es consistente.
  const posiciones = new Set(salida.map(x => x.pos));
  if (posiciones.size === equipos.length) {
    salida.sort((a, b) => a.pos - b.pos);
  } else {
    salida.forEach((x, i) => { x.pos = i + 1; });
  }

  return salida;
}

function validarClasificacion(rows, equipos) {
  const errores = [];

  if (!Array.isArray(rows) || rows.length !== equipos.length) {
    errores.push(`Filas: ${Array.isArray(rows) ? rows.length : 0}/${equipos.length}.`);
    return errores;
  }

  const esperados = new Set(equipos.map(norm));
  const encontrados = new Set();
  const posiciones = new Set();

  for (const r of rows) {
    const k = norm(r.equipo);
    if (!esperados.has(k)) errores.push(`Equipo no esperado: ${r.equipo}.`);
    if (encontrados.has(k)) errores.push(`Equipo duplicado: ${r.equipo}.`);
    encontrados.add(k);

    if (!Number.isInteger(Number(r.pos)) || Number(r.pos) < 1 || Number(r.pos) > equipos.length) {
      errores.push(`Posición inválida: ${r.equipo} = ${r.pos}.`);
    }
    posiciones.add(Number(r.pos));

    if (!Number.isFinite(Number(r.pts))) {
      errores.push(`Puntos inválidos: ${r.equipo}.`);
    }
  }

  for (const e of equipos) {
    if (!encontrados.has(norm(e))) errores.push(`Falta ${e}.`);
  }

  if (posiciones.size !== equipos.length) errores.push('Posiciones oficiales duplicadas o incompletas.');

  return errores;
}

async function abrirClasificacion(page, equipos) {
  await page.goto(COMPETICION_DIRECTA, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });
  await page.waitForTimeout(1500);

  const contarEquipos = async () => {
    const body = norm(await page.locator('body').innerText().catch(() => ''));
    return equipos.filter(e => body.includes(norm(e))).length;
  };

  // Primero usamos el propio control oficial de FUTGAL.
  const candidatos = page.locator('a, button, [role="button"]');
  const total = await candidatos.count();

  for (let i = 0; i < total; i++) {
    const el = candidatos.nth(i);
    if (!await el.isVisible().catch(() => false)) continue;

    const meta = clean([
      await el.innerText().catch(() => ''),
      await el.getAttribute('title').catch(() => ''),
      await el.getAttribute('aria-label').catch(() => '')
    ].filter(Boolean).join(' '));

    if (!/clasificaci[oó]n/i.test(meta)) continue;

    try {
      const href = await el.getAttribute('href').catch(() => null);
      if (href && href !== '#' && !/^javascript:/i.test(href)) {
        await page.goto(new URL(href, page.url()).href, {
          waitUntil: 'domcontentloaded',
          timeout: 60000
        });
      } else {
        await el.click({ timeout: 10000 });
      }

      await page.waitForTimeout(1800);
      if (await contarEquipos() >= 12) return { metodo: 'control_clasificacion_futgal' };
    } catch {}
  }

  // Respaldo: endpoints habituales de la plataforma NFG.
  for (const url of CLASIFICACION_DIRECTA_CANDIDATOS) {
    try {
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      });
      await page.waitForTimeout(1800);
      if (await contarEquipos() >= 12) return { metodo: 'url_clasificacion_directa', url };
    } catch {}
  }

  throw new Error('No pude abrir la clasificación oficial de FUTGAL.');
}

async function capturarDom(page, equipos) {
  return page.evaluate((equiposEntrada) => {
    const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
    const norm = s => clean(s)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase()
      .replace(/\./g, '')
      .replace(/[^A-Z0-9Ñ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const teamKeys = new Map(equiposEntrada.map(e => [norm(e), e]));

    const tables = [...document.querySelectorAll('table')].map((table, ti) => ({
      ti,
      rows: [...table.querySelectorAll('tr')].map((tr, ri) => ({
        ri,
        cells: [...tr.querySelectorAll(':scope > th, :scope > td')].map(c => clean(c.innerText || c.textContent || ''))
      })).filter(r => r.cells.length)
    }));

    const genericRows = [];
    const seen = new Set();

    for (const el of [...document.querySelectorAll('body *')]) {
      const txt = norm(el.innerText || el.textContent || '');
      if (!teamKeys.has(txt)) continue;

      let node = el.closest('tr');
      if (!node) {
        node = el;
        for (let up = 0; up < 5 && node && node.parentElement; up++) {
          const parent = node.parentElement;
          const children = [...parent.children];
          const parentText = clean(parent.innerText || parent.textContent || '');
          const numeros = (parentText.match(/\b-?\d+\b/g) || []).length;
          if (children.length >= 3 && children.length <= 20 && numeros >= 2 && parentText.length < 700) {
            node = parent;
            break;
          }
          node = parent;
        }
      }

      if (!node) continue;
      const key = node.tagName + '|' + clean(node.innerText || node.textContent || '');
      if (seen.has(key)) continue;
      seen.add(key);

      let cells = [];
      if (node.matches && node.matches('tr')) {
        cells = [...node.querySelectorAll(':scope > th, :scope > td')]
          .map(c => clean(c.innerText || c.textContent || ''));
      } else {
        cells = [...node.children].map(c => clean(c.innerText || c.textContent || '')).filter(Boolean);
      }

      if (cells.length) genericRows.push({ cells });
    }

    return {
      url: location.href,
      title: document.title,
      tables,
      genericRows,
      bodySample: clean(document.body?.innerText || '').slice(0, 5000)
    };
  }, equipos);
}

(async () => {
  if (!fs.existsSync('competicion.json')) {
    throw new Error('No existe tools/futgal/competicion.json. Ejecuta primero el actualizador de resultados.');
  }

  const competicion = leerJson('competicion.json');
  const equipos = equiposDesdeCompeticion(competicion);

  if (equipos.length !== 16) {
    throw new Error(`No puedo validar clasificación: detecté ${equipos.length}/16 equipos en competicion.json.`);
  }

  const stats = statsCalculados(competicion);

  const browser = await chromium.launch(EN_CI ? { headless: true } : { channel: 'chrome', headless: false });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
    locale: 'es-ES',
    timezoneId: 'Europe/Madrid'
  });
  const page = await context.newPage();

  try {
    console.log('==========================================');
    console.log(' CLASIFICACIÓN OFICIAL FUTGAL');
    console.log('==========================================');

    const apertura = await abrirClasificacion(page, equipos);
    console.log('Apertura:', apertura.metodo);

    const dom = await capturarDom(page, equipos);
    const rows = resolverTabla(dom, equipos, stats);
    const errores = validarClasificacion(rows, equipos);

    if (errores.length) {
      guardarJson('diagnostico-clasificacion.json', {
        fecha: new Date().toISOString(),
        correcto: false,
        errores,
        apertura,
        dom,
        rows
      });
      throw new Error('Clasificación FUTGAL no válida: ' + errores.join(' | '));
    }

    const ahora = new Date().toISOString();

    competicion.clasificacionOficial = rows;
    competicion.fechaClasificacionOficial = ahora;
    competicion.fuenteClasificacionOficial = 'FUTGAL';

    guardarJson('competicion.json', competicion);
    guardarJson('clasificacion-oficial.json', {
      fechaExtraccion: ahora,
      fuente: 'FUTGAL',
      temporada: competicion.temporada,
      competicion: competicion.competicion,
      grupo: competicion.grupo,
      filas: rows
    });
    guardarJson('diagnostico-clasificacion.json', {
      fecha: ahora,
      correcto: true,
      errores: [],
      apertura,
      urlFinal: dom.url,
      filas: rows.length,
      ajustesDetectados: rows
        .filter(r => Number(r.ajustePuntos) !== 0)
        .map(r => ({
          equipo: r.equipo,
          puntosCalculados: r.puntosCalculados,
          puntosOficiales: r.pts,
          ajuste: r.ajustePuntos
        }))
    });

    console.log(`Clasificación: ${rows.length}/16 equipos | OK`);

    const ajustes = rows.filter(r => Number(r.ajustePuntos) !== 0);
    if (ajustes.length) {
      console.log('Ajustes oficiales detectados:');
      for (const a of ajustes) {
        console.log(` - ${a.equipo}: ${a.puntosCalculados} calculados -> ${a.pts} FUTGAL (${a.ajustePuntos > 0 ? '+' : ''}${a.ajustePuntos})`);
      }
    } else {
      console.log('Ajustes oficiales detectados: ninguno.');
    }

  } catch (err) {
    console.error('CLASIFICACIÓN FUTGAL: ERROR');
    console.error(err.stack || err.message);
    try {
      await page.screenshot({ path: 'error-clasificacion.png', fullPage: true });
    } catch {}
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
