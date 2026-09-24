const { chromium } = require('playwright');
const fs = require('fs');

const EN_CI =
  process.env.GITHUB_ACTIONS === 'true' ||
  process.env.CI === 'true';

const CALENDARIO =
  'https://www.futgal.es/pnfg/NPcd/NFG_CmpJornada?cod_primaria=1000120';

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

function clean(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

function low(s) {
  return clean(s).toLocaleLowerCase('es');
}

function claveTexto(s) {
  return low(s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s*-\s*/g, '-')
    .replace(/\s*\|\s*/g, '|');
}

async function seleccionarPorTexto(page, textoObjetivo) {
  const objetivo = claveTexto(textoObjetivo);

  for (let intento = 1; intento <= 30; intento++) {
    const selects = page.locator('select');

    const total = await selects.count();

    for (let i = 0; i < total; i++) {
      const sel = selects.nth(i);

      const opciones = await sel.locator('option')
        .allTextContents()
        .catch(() => []);

      const indice = opciones.findIndex(
        t => claveTexto(t) === objetivo
      );

      if (indice >= 0) {
        const option = sel.locator('option').nth(indice);
        const value = await option.getAttribute('value');

        if (value !== null) {
          await sel.selectOption(value);
        } else {
          await sel.selectOption({
            label: opciones[indice].trim()
          });
        }

        console.log('   OK -> ' + textoObjetivo);
        await page.waitForTimeout(900);
        return true;
      }
    }

    if (intento === 10 || intento === 20) {
      await page.reload({
        waitUntil: 'domcontentloaded',
        timeout: 60000
      }).catch(() => {});
    }

    await page.waitForTimeout(500);
  }

  throw new Error('No encontré la opción: ' + textoObjetivo);
}

async function comprobarCompeticion(page) {
  try {
    await page.waitForFunction(
      () => {
        const t = document.body?.innerText || '';

        return (
          /Temporada\s+2026-2027/i.test(t) &&
          /VETERANOS\s*-\s*PRIMERA GALICIA/i.test(t) &&
          /A CORUÑA\s*\|\s*1ª DIVISIÓN VETERANOS/i.test(t) &&
          /\bJornada\s+1\b/i.test(t)
        );
      },
      { timeout: 12000 }
    );

    return true;
  } catch {
    return false;
  }
}

async function abrirCompeticion(page, registrar) {
  registrar('1. Abriendo directamente la competición FUTGAL...');

  for (let intento = 1; intento <= 3; intento++) {
    await page.goto(COMPETICION_DIRECTA, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    await page.waitForTimeout(1200);

    if (await comprobarCompeticion(page)) {
      registrar(
        `   Apertura directa OK (intento ${intento})`
      );

      return {
        metodo: 'url_directa'
      };
    }

    registrar(
      `   La apertura directa no quedó lista en intento ${intento}`
    );

    await page.waitForTimeout(1200);
  }

  registrar(
    '   Usando plan B: filtros de la web...'
  );

  await page.goto(CALENDARIO, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  await page.waitForTimeout(1500);

  await seleccionarPorTexto(page, '2026-2027');
  await seleccionarPorTexto(page, 'A Coruña');
  await seleccionarPorTexto(page, 'Fútbol-11');
  await seleccionarPorTexto(page, 'Competiciones Federadas');
  await seleccionarPorTexto(page, 'Veteranos - Primera Galicia');
  await seleccionarPorTexto(page, 'A Coruña | 1ª División Veteranos');

  // Aseguramos J1 después de seleccionar filtros.
  const destino = new URL(page.url());
  destino.searchParams.set('CodJornada', '1');

  await page.goto(destino.href, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  await page.waitForTimeout(1200);

  if (!await comprobarCompeticion(page)) {
    throw new Error(
      'FUTGAL no cargó correctamente la competición ni por URL directa ni por filtros.'
    );
  }

  registrar('   Plan B de filtros: OK');

  return {
    metodo: 'filtros_fallback'
  };
}

function esControl(linea) {
  const t = low(linea);

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
  const t = clean(linea);

  // Casos observados en FUTGAL:
  // "-", "- 2", "3 -", "3 - 3", "0 - 5", etc.
  return /^\d*\s*-\s*\d*$/.test(t);
}

function extraerPartidosDesdeTexto(texto) {
  const lineas = texto
    .split(/\r?\n/)
    .map(clean)
    .filter(Boolean);

  const jl = lineas.find(l => /^Jornada\s+\d+$/i.test(l));
  const jornada = jl ? Number(jl.match(/\d+/)[0]) : null;

  const partidos = [];

  for (let i = 0; i < lineas.length; i++) {
    if (!/^\d{2}-\d{2}-\d{4}$/.test(lineas[i])) continue;

    const fecha = lineas[i];

    let p = i - 1;

    while (
      p >= 0 &&
      (
        esControl(lineas[p]) ||
        esLineaMarcador(lineas[p])
      )
    ) {
      p--;
    }

    const local = p >= 0 ? lineas[p] : '';

    let j = i + 1;
    let hora = null;

    if (/^\d{1,2}:\d{2}$/.test(lineas[j] || '')) {
      hora = lineas[j];
      j++;
    }

    while (
      j < lineas.length &&
      (
        esControl(lineas[j]) ||
        esLineaMarcador(lineas[j])
      )
    ) {
      j++;
    }

    const visitante = lineas[j] || '';
    j++;

    let campo = null;

    while (j < lineas.length) {
      const cand = lineas[j];

      if (
        /^-\s*/.test(cand) ||
        /hierba/i.test(cand) ||
        esControl(cand) ||
        esLineaMarcador(cand)
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

    partidos.push({
      local,
      visitante,
      fecha,
      hora,
      campo
    });
  }

  return { jornada, partidos };
}

async function contarActas(page) {
  const els = page.locator('a, button');

  const data = await els.evaluateAll(nodes =>
    nodes.map((el, index) => {
      const img = el.querySelector('img');
      const meta = [
        el.innerText || '',
        el.getAttribute('title') || '',
        el.getAttribute('aria-label') || '',
        img?.getAttribute('alt') || '',
        img?.getAttribute('title') || ''
      ].filter(Boolean).join(' | ');

      return { index, meta };
    })
  );

  let n = 0;

  for (const item of data) {
    if (!/\bacta\b/i.test(item.meta)) continue;
    if (await els.nth(item.index).isVisible().catch(() => false)) n++;
  }

  return n;
}

async function numeroJornada(page) {
  const body = await page.locator('body').innerText();
  const m = body.match(/\bJornada\s+(\d+)\b/i);
  return m ? Number(m[1]) : null;
}

async function esperarCambioJornada(page, antes, timeout = 8000) {
  try {
    await page.waitForFunction(
      (jornadaAnterior) => {
        const texto = document.body?.innerText || '';
        const m = texto.match(/\bJornada\s+(\d+)\b/i);

        return (
          m &&
          Number(m[1]) !== Number(jornadaAnterior)
        );
      },
      antes,
      { timeout }
    );

    return true;
  } catch {
    return false;
  }
}

async function controlesNavegacion(page, nombre) {
  const loc = page.getByText(
    new RegExp(`^\\s*${nombre}\\s*$`, 'i')
  );

  const salida = [];

  for (let i = 0; i < await loc.count(); i++) {
    const el = loc.nth(i);

    if (!await el.isVisible().catch(() => false)) {
      continue;
    }

    salida.push({
      locator: el,
      indice: i,
      href: await el.getAttribute('href').catch(() => null),
      onclick: await el.getAttribute('onclick').catch(() => null),
      ariaDisabled: await el.getAttribute('aria-disabled').catch(() => null),
      disabled: await el.isDisabled().catch(() => false),
      clase: await el.getAttribute('class').catch(() => null)
    });
  }

  return salida;
}

async function clickNavegacion(page, nombre) {
  const antes = await numeroJornada(page);

  if (!Number.isInteger(antes)) {
    return {
      antes,
      despues: null,
      cambio: false,
      finConfirmado: false,
      atasco: true,
      motivo: 'jornada_actual_no_detectada',
      controles: []
    };
  }

  for (let ronda = 1; ronda <= 3; ronda++) {
    const controles = await controlesNavegacion(page, nombre);

    const activos = controles.filter(
      c =>
        !c.disabled &&
        String(c.ariaDisabled).toLowerCase() !== 'true'
    );

    // Sin control activo = extremo real de la competición.
    if (activos.length === 0) {
      return {
        antes,
        despues: antes,
        cambio: false,
        finConfirmado: true,
        atasco: false,
        motivo: 'sin_control_activo',
        controles: controles.map(({ locator, ...rest }) => rest)
      };
    }

    for (const c of activos) {
      try {
        if (
          c.href &&
          !/^javascript:/i.test(c.href) &&
          c.href !== '#'
        ) {
          const destino = new URL(c.href, page.url()).href;

          await page.goto(destino, {
            waitUntil: 'domcontentloaded',
            timeout: 60000
          });
        } else {
          await c.locator.click({
            timeout: 10000
          });
        }

        const cambio = await esperarCambioJornada(
          page,
          antes,
          8000
        );

        const despues = await numeroJornada(page);

        if (
          cambio &&
          Number.isInteger(despues) &&
          despues !== antes
        ) {
          return {
            antes,
            despues,
            cambio: true,
            finConfirmado: false,
            atasco: false,
            motivo: `ok_ronda_${ronda}_control_${c.indice}`,
            controles: controles.map(({ locator, ...rest }) => rest)
          };
        }
      } catch {
        // Probar el siguiente control visible.
      }
    }

    // Puede haber una petición AJAX lenta.
    await page.waitForTimeout(1500);

    const despuesTardio = await numeroJornada(page);

    if (
      Number.isInteger(despuesTardio) &&
      despuesTardio !== antes
    ) {
      return {
        antes,
        despues: despuesTardio,
        cambio: true,
        finConfirmado: false,
        atasco: false,
        motivo: `cambio_tardio_ronda_${ronda}`,
        controles: controles.map(({ locator, ...rest }) => rest)
      };
    }

    // Recuperar un posible estado visual atascado antes del siguiente intento.
    if (ronda < 3) {
      await page.reload({
        waitUntil: 'domcontentloaded',
        timeout: 60000
      }).catch(() => {});

      await page.waitForTimeout(1000);
    }
  }

  const controlesFinales = await controlesNavegacion(page, nombre);

  return {
    antes,
    despues: await numeroJornada(page),
    cambio: false,
    finConfirmado: false,
    atasco: true,
    motivo: 'controles_activos_pero_no_avanzan',
    controles: controlesFinales.map(({ locator, ...rest }) => rest)
  };
}

function validarJornada(j) {
  const errores = [];

  if (!Number.isInteger(j.jornada)) {
    errores.push('Número de jornada no detectado');
  }

  if (j.partidos.length !== 8) {
    errores.push(`Partidos detectados: ${j.partidos.length}, esperados: 8`);
  }

  const equipos = [];

  j.partidos.forEach((p, i) => {
    if (!p.local) {
      errores.push(`P${i+1}: falta local`);
    } else if (esLineaMarcador(p.local)) {
      errores.push(`P${i+1}: local parece marcador: ${p.local}`);
    }

    if (!p.visitante) {
      errores.push(`P${i+1}: falta visitante`);
    } else if (esLineaMarcador(p.visitante)) {
      errores.push(`P${i+1}: visitante parece marcador: ${p.visitante}`);
    }
    if (!/^\d{2}-\d{2}-\d{4}$/.test(p.fecha || '')) {
      errores.push(`P${i+1}: fecha inválida`);
    }
    if (p.hora !== null && !/^\d{1,2}:\d{2}$/.test(p.hora)) {
      errores.push(`P${i+1}: hora inválida`);
    }
    if (!p.campo) errores.push(`P${i+1}: falta campo`);

    equipos.push(p.local, p.visitante);
  });

  const distintos = new Set(equipos.map(low));

  if (equipos.length !== 16) {
    errores.push(`Equipos presentes: ${equipos.length}, esperados: 16`);
  }

  if (distintos.size !== 16) {
    errores.push(`Equipos distintos: ${distintos.size}, esperados: 16`);
  }

  if (j.actas < 0 || j.actas > 8) {
    errores.push(`Número de actas imposible: ${j.actas}`);
  }

  return {
    correcto: errores.length === 0,
    errores
  };
}

async function candidatosNavegacion(page, nombre) {
  const selector =
    'a, button, input[type="button"], input[type="submit"], [role="button"]';

  const elementos = page.locator(selector);

  const metas = await elementos.evaluateAll((els, nombreBuscado) => {
    const clean = s => (s || '').replace(/\s+/g, ' ').trim();
    const objetivo = clean(nombreBuscado).toLocaleLowerCase('es');

    return els.map((el, index) => {
      const img = el.querySelector('img');

      const textos = [
        el.innerText || '',
        el.textContent || '',
        el.getAttribute('value') || '',
        el.getAttribute('title') || '',
        el.getAttribute('aria-label') || '',
        img?.getAttribute('alt') || '',
        img?.getAttribute('title') || ''
      ]
        .map(clean)
        .filter(Boolean);

      const exacto = textos.some(
        t => t.toLocaleLowerCase('es') === objetivo
      );

      return {
        index,
        exacto,
        textos,
        href: el.getAttribute('href') || null,
        onclick: el.getAttribute('onclick') || null,
        disabled:
          el.hasAttribute('disabled') ||
          String(el.getAttribute('aria-disabled')).toLowerCase() === 'true'
      };
    });
  }, nombre);

  const salida = [];

  for (const m of metas.filter(x => x.exacto && !x.disabled)) {
    const loc = elementos.nth(m.index);

    if (await loc.isVisible().catch(() => false)) {
      salida.push({
        ...m,
        locator: loc
      });
    }
  }

  return salida;
}

async function esperarJornadaExacta(page, esperada, timeout = 10000) {
  try {
    await page.waitForFunction(
      (n) => {
        const txt = document.body?.innerText || '';
        const m = txt.match(/\bJornada\s+(\d+)\b/i);
        return m && Number(m[1]) === Number(n);
      },
      esperada,
      { timeout }
    );

    return true;
  } catch {
    return false;
  }
}

async function recuperarJornada(page, jornada, urlBuena) {
  for (let intento = 1; intento <= 4; intento++) {
    try {
      await page.goto(urlBuena, {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      });

      await page.waitForTimeout(
        1500 + intento * 700
      );

      if ((await numeroJornada(page)) === jornada) {
        return true;
      }
    } catch {}

    await page.waitForTimeout(
      1500 * intento
    );
  }

  return false;
}

async function intentarSiguiente(page, esperada, urlBase) {
  const origen = await numeroJornada(page);
  const urlOrigen = page.url();

  const diagnostico = {
    esperada,
    origen,
    urlOrigen,
    metodo: null,
    intentos: [],
    directa: null
  };

  if (!Number.isInteger(origen)) {
    diagnostico.error =
      'No pude detectar la jornada de origen';

    return {
      ok: false,
      diagnostico
    };
  }

  // FUTGAL ha mostrado respuestas intermitentes después de varias jornadas.
  // Cada intento parte de una jornada válida conocida y, si falla,
  // restauramos esa página antes de volver a probar.
  for (let intento = 1; intento <= 6; intento++) {
    const detalle = {
      intento,
      recuperadaAntes: null,
      irA_disponible: null,
      irA_resultado: null,
      click_resultado: null,
      directa_resultado: null
    };

    if ((await numeroJornada(page)) !== origen) {
      detalle.recuperadaAntes =
        await recuperarJornada(
          page,
          origen,
          urlOrigen
        );

      if (!detalle.recuperadaAntes) {
        diagnostico.intentos.push(detalle);
        continue;
      }
    }

    // A partir del segundo intento damos un margen creciente al servidor.
    if (intento > 1) {
      await page.waitForTimeout(
        Math.min(12000, 2500 * intento)
      );
    }

    // MÉTODO 1: invocar directamente la función nativa de FUTGAL.
    // Los propios enlaces de la web son javascript:IrA(N).
    try {
      detalle.irA_disponible =
        await page.evaluate(() =>
          typeof window.IrA === 'function'
        );

      if (detalle.irA_disponible) {
        try {
          await page.evaluate((n) => {
            window.IrA(n);
          }, esperada);
        } catch {
          // La navegación puede destruir el contexto JS:
          // eso no significa que IrA haya fallado.
        }

        detalle.irA_resultado =
          await esperarJornadaExacta(
            page,
            esperada,
            14000
          );

        if (detalle.irA_resultado) {
          diagnostico.metodo =
            `IrA_nativo_intento_${intento}`;

          diagnostico.intentos.push(detalle);

          // Pequeña pausa para no encadenar peticiones demasiado rápido.
          await page.waitForTimeout(2200);

          return {
            ok: true,
            diagnostico
          };
        }
      }
    } catch {}

    // Si el servidor devolvió una página inválida, recuperar el último
    // estado bueno antes de intentar el click.
    if ((await numeroJornada(page)) !== origen) {
      const recuperada =
        await recuperarJornada(
          page,
          origen,
          urlOrigen
        );

      detalle.recuperadaTrasIrA = recuperada;

      if (!recuperada) {
        diagnostico.intentos.push(detalle);
        continue;
      }
    }

    // MÉTODO 2: click real en un control Siguiente.
    try {
      const candidatos =
        await candidatosNavegacion(
          page,
          'Siguiente'
        );

      detalle.candidatos =
        candidatos.map(
          ({ locator, ...rest }) => rest
        );

      for (const c of candidatos) {
        try {
          await c.locator.click({
            timeout: 10000,
            force: true
          });
        } catch {}

        const ok =
          await esperarJornadaExacta(
            page,
            esperada,
            12000
          );

        if (ok) {
          detalle.click_resultado = true;

          diagnostico.metodo =
            `click_siguiente_intento_${intento}`;

          diagnostico.intentos.push(detalle);

          await page.waitForTimeout(2200);

          return {
            ok: true,
            diagnostico
          };
        }

        // Un click fallido puede haber dejado una respuesta vacía.
        // No probamos un locator viejo: restauramos primero.
        await recuperarJornada(
          page,
          origen,
          urlOrigen
        );
      }

      detalle.click_resultado = false;
    } catch {}

    // MÉTODO 3: URL directa, pero solo como último recurso.
    // Se reintenta porque ya hemos visto que FUTGAL puede devolver
    // temporalmente una página sin jornada.
    if (intento >= 3) {
      try {
        const destino =
          new URL(urlBase.href);

        destino.searchParams.set(
          'CodJornada',
          String(esperada)
        );

        await page.goto(destino.href, {
          waitUntil: 'domcontentloaded',
          timeout: 60000
        });

        await page.waitForTimeout(
          1800 + intento * 500
        );

        const devuelta =
          await numeroJornada(page);

        detalle.directa_resultado = {
          solicitada: esperada,
          devuelta,
          url: page.url()
        };

        diagnostico.directa =
          detalle.directa_resultado;

        if (devuelta === esperada) {
          diagnostico.metodo =
            `CodJornada_directo_intento_${intento}`;

          diagnostico.intentos.push(detalle);

          await page.waitForTimeout(2200);

          return {
            ok: true,
            diagnostico
          };
        }
      } catch (e) {
        detalle.directa_resultado = {
          solicitada: esperada,
          error: String(e?.message || e)
        };
      }
    }

    diagnostico.intentos.push(detalle);

    // Siempre terminar el intento restaurando el último estado bueno.
    await recuperarJornada(
      page,
      origen,
      urlOrigen
    );
  }

  diagnostico.error =
    'FUTGAL no respondió correctamente tras 6 intentos con recuperación';

  return {
    ok: false,
    diagnostico
  };
}


function normaliza(s) {
  return low(s);
}

function claveEquipo(s) {
  return clean(s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('es')
    .replace(/[^a-z0-9ñ]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function clavePartido(local, visitante) {
  return `${claveEquipo(local)}|||${claveEquipo(visitante)}`;
}

function validarIntegracionJornada(registro, urlsActa, actasExtraidas) {
  const errores = [];

  if (!registro.validacionCalendario?.correcto) {
    errores.push(
      `Validación de calendario: ${(registro.validacionCalendario?.errores || []).join(' | ')}`
    );
  }

  const partidosConActa = registro.partidos.filter(
    p => p.actaDisponible
  );

  if (partidosConActa.length !== actasExtraidas.length) {
    errores.push(
      `Actas integradas: ${partidosConActa.length}; actas extraídas válidas: ${actasExtraidas.length}`
    );
  }

  if (urlsActa.length !== actasExtraidas.length) {
    errores.push(
      `Enlaces ACTA detectados: ${urlsActa.length}; actas extraídas válidas: ${actasExtraidas.length}`
    );
  }

  const claves = new Set();

  for (const p of registro.partidos) {
    const k = clavePartido(p.local, p.visitante);

    if (claves.has(k)) {
      errores.push(
        `Partido duplicado en J${registro.numero}: ${p.local} - ${p.visitante}`
      );
    }

    claves.add(k);

    if (p.actaDisponible) {
      if (!p.resultado) {
        errores.push(
          `Partido con acta sin resultado: ${p.local} - ${p.visitante}`
        );
      }

      if (!p.acta?.arbitro) {
        errores.push(
          `Partido con acta sin árbitro: ${p.local} - ${p.visitante}`
        );
      }

      if (!Array.isArray(p.acta?.equipo_local?.titulares)) {
        errores.push(
          `Partido con acta sin titulares locales: ${p.local} - ${p.visitante}`
        );
      }

      if (!Array.isArray(p.acta?.equipo_visitante?.titulares)) {
        errores.push(
          `Partido con acta sin titulares visitantes: ${p.local} - ${p.visitante}`
        );
      }
    } else {
      if (!p.fecha) {
        errores.push(
          `Partido sin acta y sin fecha: ${p.local} - ${p.visitante}`
        );
      }

      if (!p.campo) {
        errores.push(
          `Partido sin acta y sin campo: ${p.local} - ${p.visitante}`
        );
      }
    }
  }

  return {
    correcto: errores.length === 0,
    errores
  };
}

async function extraerActaRobusta(
  context,
  url,
  jornada,
  indice,
  registrar
) {
  const intentos = [];

  for (let intento = 1; intento <= 4; intento++) {
    const actaPage = await context.newPage();

    try {
      await actaPage.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      });

      await actaPage.waitForTimeout(
        1600 + intento * 700
      );

      let acta = await extraerActa(actaPage);
      acta = repararActa(acta);

      const validacion = validarActa(acta);

      intentos.push({
        intento,
        local: acta.local,
        visitante: acta.visitante,
        resultado: acta.resultado?.texto ?? null,
        correcto: validacion.correcto,
        errores: validacion.errores
      });

      if (validacion.correcto) {
        await actaPage.close();

        return {
          ok: true,
          url,
          acta,
          validacion,
          intentos
        };
      }

      try {
        await actaPage.screenshot({
          path:
            `errores/acta-J${jornada}-${indice}-intento${intento}.png`,
          fullPage: true
        });
      } catch {}

    } catch (e) {
      intentos.push({
        intento,
        error: String(e?.message || e)
      });
    } finally {
      if (!actaPage.isClosed()) {
        await actaPage.close().catch(() => {});
      }
    }

    registrar(
      `         reintento ACTA ${intento}/4...`
    );

    await new Promise(
      r => setTimeout(r, 1800 * intento)
    );
  }

  return {
    ok: false,
    url,
    acta: null,
    validacion: null,
    intentos
  };
}


async function detectarActas(page) {
  const elementos = page.locator('a, button');

  const meta = await elementos.evaluateAll(els =>
    els.map((el, index) => {
      const img = el.querySelector('img');

      const partes = [
        el.innerText || '',
        el.getAttribute('title') || '',
        el.getAttribute('aria-label') || '',
        img?.getAttribute('alt') || '',
        img?.getAttribute('title') || ''
      ].filter(Boolean);

      return {
        index,
        etiqueta: partes
          .join(' | ')
          .replace(/\s+/g, ' ')
          .trim(),
        href: el.getAttribute('href') || ''
      };
    })
  );

  const candidatos = meta.filter(
    x => /\bacta\b/i.test(x.etiqueta)
  );

  const resultado = [];
  const vistos = new Set();

  for (const c of candidatos) {
    const loc = elementos.nth(c.index);

    if (!await loc.isVisible().catch(() => false)) {
      continue;
    }

    let url = null;

    if (
      c.href &&
      !c.href.toLowerCase().startsWith('javascript:')
    ) {
      try {
        url = new URL(c.href, page.url()).href;
      } catch {}
    }

    const clave = url || `${c.index}|${c.etiqueta}`;

    if (!vistos.has(clave)) {
      vistos.add(clave);

      resultado.push({
        index: c.index,
        etiqueta: c.etiqueta,
        url
      });
    }
  }

  return resultado;
}

async function extraerActa(page) {
  return await page.evaluate(() => {
    const clean = s =>
      (s || '').replace(/\s+/g, ' ').trim();

    function pseudoDigit(el, pseudo) {
      if (!el) return null;

      const content =
        getComputedStyle(el, pseudo).content;

      if (
        !content ||
        content === 'none' ||
        content === 'normal'
      ) {
        return null;
      }

      const limpio = content
        .replace(/^["']|["']$/g, '')
        .trim();

      return /^\d$/.test(limpio)
        ? Number(limpio)
        : null;
    }

    function digitFromScoreSide(root) {
      if (!root) return null;

      const todos = [
        root,
        ...root.querySelectorAll('*')
      ];

      for (const el of todos) {
        const before = pseudoDigit(el, '::before');
        if (before !== null) return before;

        const after = pseudoDigit(el, '::after');
        if (after !== null) return after;
      }

      for (const el of todos) {
        for (const cls of (el.classList || [])) {
          const m = /^fa-([0-9])$/.exec(cls);
          if (m) return Number(m[1]);
        }
      }

      const html = root.outerHTML || '';

      const simple =
        html.match(
          /content\s*:\s*["']([0-9])["']/i
        );

      if (simple) {
        return Number(simple[1]);
      }

      for (const el of todos) {
        const st = getComputedStyle(el);

        if (
          st.display === 'none' ||
          st.visibility === 'hidden'
        ) {
          continue;
        }

        for (const node of el.childNodes) {
          if (node.nodeType === Node.TEXT_NODE) {
            const t = clean(node.textContent);

            if (/^[0-9]$/.test(t)) {
              return Number(t);
            }
          }
        }
      }

      return null;
    }

    function scoreFromStrong(strong) {
      if (!strong) {
        return {
          local: null,
          visitante: null
        };
      }

      let lados = [];

      try {
        lados = Array.from(
          strong.querySelectorAll(
            ':scope > i.fa-solid'
          )
        );
      } catch {
        lados = Array.from(
          strong.children
        ).filter(
          el =>
            el.matches &&
            el.matches('i.fa-solid')
        );
      }

      if (lados.length >= 2) {
        return {
          local: digitFromScoreSide(lados[0]),
          visitante: digitFromScoreSide(lados[1])
        };
      }

      return {
        local: null,
        visitante: null
      };
    }

    function jugadores(block, titulo) {
      if (!block) return [];

      const h = Array.from(
        block.querySelectorAll('h5')
      ).find(
        x =>
          clean(x.textContent).toLowerCase() ===
          titulo.toLowerCase()
      );

      if (!h) return [];

      let table = h.nextElementSibling;

      while (
        table &&
        table.tagName !== 'TABLE'
      ) {
        table = table.nextElementSibling;
      }

      if (!table) return [];

      return Array.from(
        table.querySelectorAll('tbody tr')
      )
        .map(tr => {
          const tds =
            tr.querySelectorAll('td');

          return {
            dorsal: clean(
              tds[0]?.textContent || ''
            ),
            jugador: clean(
              tds[1]?.textContent || ''
            )
          };
        })
        .filter(x => x.jugador);
    }

    function tarjetas(block) {
      if (!block) return [];

      const h = Array.from(
        block.querySelectorAll('h4')
      ).find(
        x =>
          clean(x.textContent)
            .toLowerCase() === 'tarjetas'
      );

      if (!h) return [];

      let table = h.nextElementSibling;

      while (
        table &&
        table.tagName !== 'TABLE'
      ) {
        table = table.nextElementSibling;
      }

      if (!table) return [];

      return Array.from(
        table.querySelectorAll('tbody tr')
      )
        .map(tr => {
          const img =
            tr.querySelector('img');

          const src =
            (
              img?.getAttribute('src') || ''
            ).toLowerCase();

          let tipo = 'desconocida';

          if (src.includes('amar')) {
            tipo = 'amarilla';
          } else if (src.includes('roj')) {
            tipo = 'roja';
          }

          const td =
            tr.querySelectorAll('td')[1];

          const minNode =
            td?.querySelector('.font-blue');

          return {
            tipo,
            minuto: clean(
              minNode?.textContent || ''
            ).replace(/^\(|\)$/g, ''),
            jugador: clean(
              (td?.textContent || '').replace(
                minNode?.textContent || '',
                ''
              )
            )
          };
        })
        .filter(x => x.jugador);
    }

    function cuerpoTecnico(block) {
      const salida = {};

      if (!block) return salida;

      for (
        const h of block.querySelectorAll(
          'h5.font_responsive'
        )
      ) {
        const texto = clean(h.textContent);

        if (
          /^DEL\.\s*Equipo:/i.test(texto)
        ) {
          salida.delegado = clean(
            texto.replace(
              /^DEL\.\s*Equipo:/i,
              ''
            )
          );
        } else if (
          /^Entrenador:/i.test(texto)
        ) {
          salida.entrenador = clean(
            texto.replace(
              /^Entrenador:/i,
              ''
            )
          );
        }
      }

      return salida;
    }

    const cabecera = Array.from(
      document.querySelectorAll(
        'h5.font-grey-cascade'
      )
    )
      .map(x => clean(x.textContent))
      .find(
        x =>
          /Temporada\s+\d{4}-\d{4}/i.test(x)
      ) || '';

    const mc = cabecera.match(
      /Temporada\s+(\d{4}-\d{4}).*?Jornada\s+(\d+).*?(\d{2}-\d{2}-\d{4})\s+(\d{1,2}:\d{2})\s*h?/i
    );

    const row =
      document.querySelector(
        '.row.nova_text'
      );

    const centro =
      row?.querySelector(
        '.col-sm-push-4'
      ) || null;

    const localBlock =
      row?.querySelector(
        '.col-sm-pull-4'
      ) || null;

    const columnas = row
      ? Array.from(row.children).filter(
          el =>
            el.classList?.contains(
              'col-sm-4'
            )
        )
      : [];

    const visitanteBlock =
      columnas.find(
        el =>
          el !== centro &&
          el !== localBlock
      ) || null;

    const local = clean(
      localBlock
        ?.querySelector(
          '.dashboard-stat.grey .number'
        )
        ?.textContent || ''
    );

    const visitante = clean(
      visitanteBlock
        ?.querySelector(
          '.dashboard-stat.grey .number'
        )
        ?.textContent || ''
    );

    const resultadoPrincipal =
      scoreFromStrong(
        centro?.querySelector(
          'h2.ntype strong'
        )
      );

    const stats = centro
      ? Array.from(
          centro.querySelectorAll(
            '.dashboard-stat'
          )
        )
      : [];

    const arbBlock = stats.find(
      x =>
        clean(
          x.querySelector('.number')
            ?.textContent
        ).toLowerCase() === 'árbitros'
    );

    let arbitro = '';

    if (arbBlock) {
      arbitro = clean(
        clean(
          arbBlock
            .querySelector('.desc')
            ?.textContent || ''
        ).replace(/^Árbitro/i, '')
      );
    }

    const goles = [];

    const golesBlock = stats.find(
      x =>
        clean(
          x.querySelector('.number')
            ?.textContent
        ).toLowerCase() === 'goles'
    );

    if (golesBlock) {
      for (
        const tr of golesBlock.querySelectorAll(
          'tbody tr'
        )
      ) {
        const tds =
          tr.querySelectorAll('td');

        if (tds.length < 2) continue;

        const marcadorRaw =
          scoreFromStrong(
            tds[0].querySelector('strong')
          );

        const minNode =
          tds[1].querySelector(
            '.font-blue'
          );

        const iconoGol =
          tds[0].querySelector('a.img');

        const tipoGol = clean(
          iconoGol
            ?.getAttribute('title') || ''
        );

        goles.push({
          marcador_raw: marcadorRaw,
          marcador: { ...marcadorRaw },
          minuto: clean(
            minNode?.textContent || ''
          ).replace(/^\(|\)$/g, ''),
          jugador: clean(
            (tds[1].textContent || '')
              .replace(
                minNode?.textContent || '',
                ''
              )
          ),
          tipo_gol: tipoGol || null,
          marcador_fuente: 'raw'
        });
      }
    }

    let estadio = '';
    let ciudad = '';

    if (centro) {
      estadio = clean(
        centro
          .querySelector(
            'a[href*="NFG_VisCampos"]'
          )
          ?.textContent || ''
      );

      const ciudadH = Array.from(
        centro.querySelectorAll('h4')
      ).find(
        x =>
          /^Ciudad:/i.test(
            clean(x.textContent)
          )
      );

      if (ciudadH) {
        ciudad = clean(
          ciudadH.textContent.replace(
            /^Ciudad:/i,
            ''
          )
        );
      }
    }

    function equipo(block, nombre) {
      return {
        nombre,
        titulares:
          jugadores(block, 'Titulares'),
        suplentes:
          jugadores(block, 'Suplentes'),
        cuerpo_tecnico:
          cuerpoTecnico(block),
        tarjetas:
          tarjetas(block)
      };
    }

    return {
      temporada: mc?.[1] || null,
      jornada:
        mc ? Number(mc[2]) : null,
      fecha: mc?.[3] || null,
      hora: mc?.[4] || null,

      local,
      visitante,

      resultado_principal_raw:
        resultadoPrincipal,

      resultado: {
        local: resultadoPrincipal.local,
        visitante:
          resultadoPrincipal.visitante,
        texto:
          resultadoPrincipal.local !== null &&
          resultadoPrincipal.visitante !== null
            ? `${resultadoPrincipal.local}-${resultadoPrincipal.visitante}`
            : null,
        fuente: 'marcador_principal'
      },

      arbitro,
      estadio,
      ciudad,
      goles,

      equipo_local:
        equipo(localBlock, local),

      equipo_visitante:
        equipo(
          visitanteBlock,
          visitante
        )
    };
  });
}

function repararActa(acta) {
  let prevLocal = 0;
  let prevVisitante = 0;
  let todoResuelto = true;

  const localPlayers = new Set(
    [
      ...acta.equipo_local.titulares,
      ...acta.equipo_local.suplentes
    ].map(x => normaliza(x.jugador))
  );

  const visitantePlayers = new Set(
    [
      ...acta.equipo_visitante.titulares,
      ...acta.equipo_visitante.suplentes
    ].map(x => normaliza(x.jugador))
  );

  for (const gol of acta.goles) {
    const rawL =
      gol.marcador_raw?.local;

    const rawV =
      gol.marcador_raw?.visitante;

    const candidatoL = {
      local: prevLocal + 1,
      visitante: prevVisitante
    };

    const candidatoV = {
      local: prevLocal,
      visitante: prevVisitante + 1
    };

    function coste(c) {
      let valor = 0;

      if (
        Number.isInteger(rawL) &&
        rawL !== c.local
      ) {
        valor++;
      }

      if (
        Number.isInteger(rawV) &&
        rawV !== c.visitante
      ) {
        valor++;
      }

      return valor;
    }

    const costeL = coste(candidatoL);
    const costeV = coste(candidatoV);

    let elegido = null;
    let fuente = null;

    // PRIORIDAD 1: el propio acta nos dice quién marcó.
    // Si el jugador pertenece inequívocamente a uno de los dos equipos,
    // ese dato manda sobre un marcador RAW ofuscado/corrupto.
    const jugador =
      normaliza(gol.jugador);

    const perteneceL =
      localPlayers.has(jugador);

    const perteneceV =
      visitantePlayers.has(jugador);

    const tipo =
      normaliza(gol.tipo_gol || '');

    const esPropia =
      tipo.includes('propia') ||
      tipo.includes('propio');

    if (
      perteneceL &&
      !perteneceV
    ) {
      elegido =
        esPropia
          ? candidatoV
          : candidatoL;

      const rawCoincide =
        rawL === elegido.local &&
        rawV === elegido.visitante;

      fuente =
        rawCoincide
          ? 'raw_y_jugador_coherentes'
          : (
              esPropia
                ? 'jugador_autogol_prioritario'
                : 'jugador_prioritario'
            );
    } else if (
      perteneceV &&
      !perteneceL
    ) {
      elegido =
        esPropia
          ? candidatoL
          : candidatoV;

      const rawCoincide =
        rawL === elegido.local &&
        rawV === elegido.visitante;

      fuente =
        rawCoincide
          ? 'raw_y_jugador_coherentes'
          : (
              esPropia
                ? 'jugador_autogol_prioritario'
                : 'jugador_prioritario'
            );
    } else {
      // PRIORIDAD 2: si no podemos identificar inequívocamente
      // el equipo del goleador, usamos el RAW como pista secundaria.
      if (costeL < costeV) {
        elegido = candidatoL;
        fuente =
          costeL === 0
            ? 'raw_coherente'
            : 'secuencia_corregida';
      } else if (costeV < costeL) {
        elegido = candidatoV;
        fuente =
          costeV === 0
            ? 'raw_coherente'
            : 'secuencia_corregida';
      }
    }

    if (!elegido) {
      todoResuelto = false;

      gol.marcador = {
        local: null,
        visitante: null
      };

      gol.marcador_fuente =
        'no_resuelto';

      continue;
    }

    gol.marcador = elegido;
    gol.marcador_fuente = fuente;

    prevLocal = elegido.local;
    prevVisitante =
      elegido.visitante;
  }

  if (
    acta.goles.length > 0 &&
    todoResuelto
  ) {
    const ultimo =
      acta.goles[
        acta.goles.length - 1
      ].marcador;

    acta.resultado = {
      local: ultimo.local,
      visitante: ultimo.visitante,
      texto:
        `${ultimo.local}-${ultimo.visitante}`,
      fuente:
        'secuencia_goles_validada'
    };
  } else if (
    acta.goles.length === 0 &&
    acta.temporada &&
    Number.isInteger(acta.jornada) &&
    acta.fecha &&
    acta.local &&
    acta.visitante
  ) {
    // Solo inferimos 0-0 si la página es realmente un ACTA válida.
    // Una respuesta vacía o rota de FUTGAL NO puede convertirse en 0-0.
    acta.resultado = {
      local: 0,
      visitante: 0,
      texto: '0-0',
      fuente: 'sin_goles'
    };
  } else if (
    Number.isInteger(
      acta.resultado_principal_raw?.local
    ) &&
    Number.isInteger(
      acta.resultado_principal_raw
        ?.visitante
    )
  ) {
    acta.resultado = {
      local:
        acta.resultado_principal_raw.local,
      visitante:
        acta.resultado_principal_raw
          .visitante,
      texto:
        `${acta.resultado_principal_raw.local}-` +
        `${acta.resultado_principal_raw.visitante}`,
      fuente:
        'marcador_principal'
    };
  }

  return acta;
}

function validarActa(acta) {
  const pruebas = [];
  const errores = [];

  function check(
    nombre,
    ok,
    obtenido
  ) {
    pruebas.push({
      prueba: nombre,
      ok: Boolean(ok),
      obtenido
    });

    if (!ok) errores.push(nombre);
  }

  check(
    'Temporada presente',
    Boolean(acta.temporada),
    acta.temporada
  );

  check(
    'Jornada presente',
    Number.isInteger(acta.jornada),
    acta.jornada
  );

  check(
    'Fecha presente',
    Boolean(acta.fecha),
    acta.fecha
  );

  check(
    'Hora presente',
    Boolean(acta.hora),
    acta.hora
  );

  check(
    'Equipo local presente',
    Boolean(acta.local),
    acta.local
  );

  check(
    'Equipo visitante presente',
    Boolean(acta.visitante),
    acta.visitante
  );

  check(
    'Resultado completo',
    Number.isInteger(
      acta.resultado?.local
    ) &&
      Number.isInteger(
        acta.resultado?.visitante
      ),
    acta.resultado?.texto
  );

  check(
    'Árbitro presente',
    Boolean(acta.arbitro),
    acta.arbitro
  );

  check(
    'Estadio presente',
    Boolean(acta.estadio),
    acta.estadio
  );

  check(
    'Titulares local razonables',
    acta.equipo_local.titulares.length >= 7 &&
      acta.equipo_local.titulares.length <= 11,
    acta.equipo_local.titulares.length
  );

  check(
    'Titulares visitante razonables',
    acta.equipo_visitante.titulares.length >= 7 &&
      acta.equipo_visitante.titulares.length <= 11,
    acta.equipo_visitante.titulares.length
  );

  const jugadoresLocal = new Set(
    [
      ...acta.equipo_local.titulares,
      ...acta.equipo_local.suplentes
    ].map(x => normaliza(x.jugador))
  );

  const jugadoresVisitante = new Set(
    [
      ...acta.equipo_visitante.titulares,
      ...acta.equipo_visitante.suplentes
    ].map(x => normaliza(x.jugador))
  );

  let prevL = 0;
  let prevV = 0;
  let secuenciaOk = true;
  let asignacionGoleadorOk = true;

  const detalleGoles = [];

  for (
    let i = 0;
    i < acta.goles.length;
    i++
  ) {
    const g = acta.goles[i];

    const L =
      g.marcador?.local;

    const V =
      g.marcador?.visitante;

    const enteros =
      Number.isInteger(L) &&
      Number.isInteger(V);

    const dL =
      enteros ? L - prevL : null;

    const dV =
      enteros ? V - prevV : null;

    const pasoOk =
      enteros &&
      (
        (
          dL === 1 &&
          dV === 0
        ) ||
        (
          dL === 0 &&
          dV === 1
        )
      );

    if (!pasoOk) {
      secuenciaOk = false;
    }

    const jugador =
      normaliza(g.jugador);

    const enLocal =
      jugadoresLocal.has(jugador);

    const enVisitante =
      jugadoresVisitante.has(jugador);

    const tipo =
      normaliza(g.tipo_gol || '');

    const autogol =
      tipo.includes('propia') ||
      tipo.includes('propio');

    let equipoEsperado = null;

    if (
      enLocal &&
      !enVisitante
    ) {
      equipoEsperado =
        autogol
          ? 'visitante'
          : 'local';
    } else if (
      enVisitante &&
      !enLocal
    ) {
      equipoEsperado =
        autogol
          ? 'local'
          : 'visitante';
    }

    const equipoMarcador =
      dL === 1 && dV === 0
        ? 'local'
        : dL === 0 && dV === 1
          ? 'visitante'
          : null;

    const goleadorOk =
      equipoEsperado === null ||
      equipoEsperado === equipoMarcador;

    if (!goleadorOk) {
      asignacionGoleadorOk = false;
    }

    detalleGoles.push({
      gol: i + 1,
      minuto: g.minuto,
      jugador: g.jugador,
      tipo_gol: g.tipo_gol,
      raw: g.marcador_raw,
      corregido: g.marcador,
      fuente: g.marcador_fuente,
      equipo_esperado:
        equipoEsperado,
      equipo_marcador:
        equipoMarcador,
      secuencia_ok:
        pasoOk,
      goleador_ok:
        goleadorOk
    });

    if (enteros) {
      prevL = L;
      prevV = V;
    }
  }

  check(
    'Secuencia de goles coherente',
    secuenciaOk,
    detalleGoles
  );

  check(
    'Goleadores asignados al equipo correcto',
    asignacionGoleadorOk,
    detalleGoles
  );

  if (
    acta.goles.length > 0
  ) {
    const ultimo =
      acta.goles[
        acta.goles.length - 1
      ].marcador;

    check(
      'Último marcador coincide con resultado',
      ultimo.local ===
        acta.resultado.local &&
      ultimo.visitante ===
        acta.resultado.visitante,
      {
        ultimoGol: ultimo,
        resultado:
          acta.resultado.texto
      }
    );
  } else {
    check(
      'Sin goles equivale a 0-0',
      acta.resultado.local === 0 &&
        acta.resultado.visitante === 0,
      acta.resultado.texto
    );
  }

  if (
    Number.isInteger(
      acta.resultado?.local
    ) &&
    Number.isInteger(
      acta.resultado?.visitante
    )
  ) {
    check(
      'Número de goles coincide con resultado',
      acta.goles.length ===
        (
          acta.resultado.local +
          acta.resultado.visitante
        ),
      {
        filasGol:
          acta.goles.length,
        totalMarcador:
          acta.resultado.local +
          acta.resultado.visitante
      }
    );
  }

  check(
    'Ningún marcador sin resolver',
    acta.goles.every(
      g =>
        Number.isInteger(
          g.marcador?.local
        ) &&
        Number.isInteger(
          g.marcador?.visitante
        )
    ),
    acta.goles.map(g => ({
      minuto: g.minuto,
      marcador: g.marcador,
      fuente:
        g.marcador_fuente
    }))
  );

  return {
    correcto:
      pruebas.every(p => p.ok),
    errores,
    pruebas
  };
}


function cargarJsonSeguro(ruta, fallback) {
  try {
    if (!fs.existsSync(ruta)) return fallback;
    return JSON.parse(
      fs.readFileSync(ruta, 'utf8')
    );
  } catch {
    return fallback;
  }
}

function guardarJson(ruta, valor) {
  fs.writeFileSync(
    ruta,
    JSON.stringify(valor, null, 2),
    'utf8'
  );
}

function cacheActaValida(entry) {
  return Boolean(
    entry &&
    entry.ok === true &&
    entry.acta &&
    entry.acta.local &&
    entry.acta.visitante &&
    entry.acta.temporada &&
    Number.isInteger(entry.acta.jornada) &&
    entry.validacion &&
    entry.validacion.correcto === true
  );
}

async function leerActaEnPagina(actaPage) {
  let acta = await extraerActa(actaPage);

  const paginaPareceActa = Boolean(
    acta &&
    acta.temporada &&
    Number.isInteger(acta.jornada) &&
    acta.fecha &&
    acta.local &&
    acta.visitante
  );

  if (!paginaPareceActa) {
    return {
      okPagina: false,
      acta,
      validacion: null
    };
  }

  acta = repararActa(acta);
  const validacion = validarActa(acta);

  return {
    okPagina: true,
    acta,
    validacion
  };
}

async function extraerActaRobustaV2(
  context,
  url,
  jornada,
  indice,
  registrar,
  modo = 'normal'
) {
  const intentos = [];

  const plan = modo === 'recuperacion'
    ? [3000, 7000, 12000, 18000, 25000]
    : [1800, 3500, 6500];

  for (
    let intento = 1;
    intento <= plan.length;
    intento++
  ) {
    const actaPage =
      await context.newPage();

    try {
      await actaPage.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      });

      await actaPage.waitForTimeout(
        plan[intento - 1]
      );

      let lectura =
        await leerActaEnPagina(
          actaPage
        );

      // Si FUTGAL devolvió una página vacía/incompleta,
      // hacemos una recarga dentro del mismo intento antes de rendirnos.
      if (!lectura.okPagina) {
        await actaPage.waitForTimeout(
          1500 * intento
        );

        await actaPage.reload({
          waitUntil: 'domcontentloaded',
          timeout: 60000
        }).catch(() => {});

        await actaPage.waitForTimeout(
          2000 + intento * 900
        );

        lectura =
          await leerActaEnPagina(
            actaPage
          );
      }

      const acta =
        lectura.acta;

      const validacion =
        lectura.validacion;

      intentos.push({
        intento,
        modo,
        paginaActaValida:
          lectura.okPagina,
        local:
          acta?.local || '',
        visitante:
          acta?.visitante || '',
        resultado:
          acta?.resultado?.texto ?? null,
        correcto:
          validacion?.correcto ?? false,
        errores:
          validacion?.errores || [
            'FUTGAL devolvió una página ACTA incompleta'
          ]
      });

      if (
        lectura.okPagina &&
        validacion?.correcto
      ) {
        await actaPage.close();

        return {
          ok: true,
          url,
          acta,
          validacion,
          intentos
        };
      }

      try {
        await actaPage.screenshot({
          path:
            `errores/acta-J${jornada}-${indice}-${modo}-intento${intento}.png`,
          fullPage: true
        });
      } catch {}

    } catch (e) {
      intentos.push({
        intento,
        modo,
        error:
          String(e?.message || e)
      });
    } finally {
      if (!actaPage.isClosed()) {
        await actaPage
          .close()
          .catch(() => {});
      }
    }

    registrar(
      `         reintento ACTA ${intento}/${plan.length} (${modo})...`
    );

    await new Promise(
      r => setTimeout(
        r,
        modo === 'recuperacion'
          ? 4000 * intento
          : 1800 * intento
      )
    );
  }

  return {
    ok: false,
    url,
    acta: null,
    validacion: null,
    intentos
  };
}

function construirPartidoIntegrado(
  p,
  idx,
  resultadoActa,
  actaPendienteUrl = null
) {
  if (resultadoActa) {
    return {
      orden: idx + 1,
      local: p.local,
      visitante: p.visitante,
      fecha: p.fecha,
      hora: p.hora,
      campo: p.campo,
      estado: 'FINALIZADO',
      actaDisponible: true,
      resultado:
        resultadoActa.acta.resultado,
      acta: {
        url:
          resultadoActa.url,
        arbitro:
          resultadoActa.acta.arbitro,
        estadio:
          resultadoActa.acta.estadio,
        ciudad:
          resultadoActa.acta.ciudad,
        goles:
          resultadoActa.acta.goles,
        equipo_local:
          resultadoActa.acta.equipo_local,
        equipo_visitante:
          resultadoActa.acta.equipo_visitante
      }
    };
  }

  if (actaPendienteUrl) {
    return {
      orden: idx + 1,
      local: p.local,
      visitante: p.visitante,
      fecha: p.fecha,
      hora: p.hora,
      campo: p.campo,
      estado: 'ACTA_PENDIENTE',
      actaDisponible: true,
      actaUrl:
        actaPendienteUrl,
      resultado: null,
      acta: null
    };
  }

  return {
    orden: idx + 1,
    local: p.local,
    visitante: p.visitante,
    fecha: p.fecha,
    hora: p.hora,
    campo: p.campo,
    estado: 'PROGRAMADO',
    actaDisponible: false,
    resultado: null,
    acta: null
  };
}


function urlJornadaDirecta(numero) {
  return (
    'https://www.futgal.es/pnfg/NPcd/NFG_CmpJornada?' +
    'cod_primaria=1000120' +
    '&CodCompeticion=26991153' +
    '&CodGrupo=28251751' +
    '&CodTemporada=22' +
    '&CodJornada=' + numero +
    '&Sch_Codigo_Delegacion=1' +
    '&Sch_Tipo_Juego=1' +
    '&cod_agrupacion=1'
  );
}

function checkpointJornadaValido(j, numero, partidosPorJornada) {
  return Boolean(
    j &&
    j.numero === numero &&
    j.validacionCalendario?.correcto === true &&
    Array.isArray(j.partidos) &&
    j.partidos.length === partidosPorJornada &&
    Array.isArray(j.actaUrls)
  );
}

async function extraerJornadaDirectaRobusta(
  browser,
  numero,
  partidosPorJornada,
  registrar,
  modo = 'normal'
) {
  const esperas = modo === 'recuperacion'
    ? [3500, 7000, 12000, 20000, 30000, 45000]
    : [1800, 3500, 6500, 10000];

  const intentos = [];

  for (let intento = 1; intento <= esperas.length; intento++) {
    const contextJ = await browser.newContext({
      viewport: { width: 1440, height: 1000 }
    });

    const pageJ = await contextJ.newPage();
    const url = urlJornadaDirecta(numero);

    try {
      await pageJ.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      });

      await pageJ.waitForTimeout(esperas[intento - 1]);

      const body = await pageJ.locator('body')
        .innerText()
        .catch(() => '');

      const extra = extraerPartidosDesdeTexto(body);

      const temp = {
        jornada: extra.jornada,
        totalPartidos: extra.partidos.length,
        actas: 0,
        partidosSinActa: extra.partidos.length,
        partidos: extra.partidos.map(p => ({ ...p }))
      };

      const validacionCalendario = validarJornada(temp);

      const detectadas = await detectarActas(pageJ)
        .catch(() => []);

      const actaUrls = [
        ...new Set(
          detectadas
            .map(x => x.url)
            .filter(Boolean)
        )
      ];

      let ok = Boolean(
        extra.jornada === numero &&
        extra.partidos.length === partidosPorJornada &&
        validacionCalendario.correcto
      );

      let extraFinal = extra;
      let validacionFinal = validacionCalendario;
      let actaUrlsFinal = actaUrls;
      let warmupUsado = false;

      // Si la URL directa llega vacía/incompleta, hacemos el "paso previo"
      // dentro del MISMO contexto y volvemos a entrar en la jornada.
      // Así no dependemos siempre del paso previo, pero lo usamos cuando
      // FUTGAL necesita inicializar sesión/cookies.
      if (!ok) {
        try {
          warmupUsado = true;

          await pageJ.goto(
            'https://www.futgal.es/pnfg/NPortada',
            {
              waitUntil: 'domcontentloaded',
              timeout: 60000
            }
          );

          await pageJ.waitForTimeout(
            1800 + intento * 700
          );

          await pageJ.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: 60000
          });

          await pageJ.waitForTimeout(
            2200 + intento * 900
          );

          const body2 =
            await pageJ.locator('body')
              .innerText()
              .catch(() => '');

          const extra2 =
            extraerPartidosDesdeTexto(
              body2
            );

          const temp2 = {
            jornada:
              extra2.jornada,
            totalPartidos:
              extra2.partidos.length,
            actas: 0,
            partidosSinActa:
              extra2.partidos.length,
            partidos:
              extra2.partidos.map(
                p => ({ ...p })
              )
          };

          const validacion2 =
            validarJornada(temp2);

          const detectadas2 =
            await detectarActas(pageJ)
              .catch(() => []);

          const actaUrls2 = [
            ...new Set(
              detectadas2
                .map(x => x.url)
                .filter(Boolean)
            )
          ];

          const ok2 = Boolean(
            extra2.jornada === numero &&
            extra2.partidos.length === partidosPorJornada &&
            validacion2.correcto
          );

          if (ok2) {
            ok = true;
            extraFinal = extra2;
            validacionFinal = validacion2;
            actaUrlsFinal = actaUrls2;
          }
        } catch {}
      }

      intentos.push({
        intento,
        modo,
        url,
        warmupUsado,
        jornadaDevuelta:
          extraFinal.jornada,
        partidos:
          extraFinal.partidos.length,
        actas:
          actaUrlsFinal.length,
        correcto: ok,
        errores:
          validacionFinal.errores || []
      });

      if (ok) {
        await contextJ.close();

        return {
          ok: true,
          jornada: {
            numero,
            totalPartidos:
              extraFinal.partidos.length,
            validacionCalendario:
              validacionFinal,
            partidos:
              extraFinal.partidos.map(
                p => ({ ...p })
              ),
            actaUrls:
              actaUrlsFinal
          },
          diagnostico: {
            esperada: numero,
            metodo:
              `url_directa_aislada_${modo}`,
            intentos
          }
        };
      }

      try {
        await pageJ.screenshot({
          path: `errores/calendario-J${numero}-${modo}-intento${intento}.png`,
          fullPage: true
        });
      } catch {}

    } catch (e) {
      intentos.push({
        intento,
        modo,
        url,
        correcto: false,
        error: String(e?.message || e)
      });
    } finally {
      await contextJ.close().catch(() => {});
    }

    registrar(
      `      J${numero}: reintento ${intento}/${esperas.length} (${modo})...`
    );

    await new Promise(
      r => setTimeout(
        r,
        modo === 'recuperacion'
          ? Math.min(12000, 2500 * intento)
          : 1800 * intento
      )
    );
  }

  return {
    ok: false,
    jornada: null,
    diagnostico: {
      esperada: numero,
      metodo: `url_directa_aislada_${modo}`,
      intentos,
      error: 'FUTGAL no devolvió una jornada válida'
    }
  };
}


function valorCalendario(v) {
  return v === undefined || v === null ? null : String(v);
}

function compararJornadasCalendario(anterior, nueva) {
  const cambios = [];

  if (!anterior || !Array.isArray(anterior.partidos)) {
    return cambios;
  }

  const mapaAnterior = new Map(
    anterior.partidos.map(p => [
      clavePartido(p.local, p.visitante),
      p
    ])
  );

  for (const p of (nueva.partidos || [])) {
    const key = clavePartido(p.local, p.visitante);
    const old = mapaAnterior.get(key);

    if (!old) {
      cambios.push({
        tipo: 'partido_nuevo_o_pareja_distinta',
        local: p.local,
        visitante: p.visitante,
        nuevo: {
          fecha: p.fecha,
          hora: p.hora,
          campo: p.campo
        }
      });
      continue;
    }

    const diferencias = {};

    for (const campo of ['fecha', 'hora', 'campo']) {
      const antes = valorCalendario(old[campo]);
      const ahora = valorCalendario(p[campo]);

      if (antes !== ahora) {
        diferencias[campo] = { antes, ahora };
      }
    }

    if (Object.keys(diferencias).length) {
      cambios.push({
        tipo: 'cambio_programacion',
        local: p.local,
        visitante: p.visitante,
        diferencias
      });
    }
  }

  return cambios;
}

function mapaCheckpointsCalendario(
  totalEquipos,
  jornadasEsperadas,
  partidosPorJornada
) {
  const mapa = new Map();

  const fuentes = [
    cargarJsonSeguro('checkpoint-calendario.json', null),
    cargarJsonSeguro('checkpoint-calendario-parcial.json', null)
  ];

  for (const fuente of fuentes) {
    if (
      !fuente ||
      fuente.totalEquipos !== totalEquipos ||
      fuente.jornadasEsperadas !== jornadasEsperadas ||
      !Array.isArray(fuente.jornadas)
    ) {
      continue;
    }

    for (const j of fuente.jornadas) {
      if (
        checkpointJornadaValido(
          j,
          j.numero,
          partidosPorJornada
        )
      ) {
        mapa.set(j.numero, j);
      }
    }
  }

  return mapa;
}


(async () => {
  const launchOptions = EN_CI
    ? {
        headless: true
      }
    : {
        channel: 'chrome',
        headless: false,
        slowMo: 50
      };

  const browser =
    await chromium.launch(
      launchOptions
    );

  const context =
    await browser.newContext({
      viewport: {
        width: 1440,
        height: 1000
      },
      locale: 'es-ES',
      timezoneId: 'Europe/Madrid'
    });

  const page =
    await context.newPage();

  const log = [];
  const registrar = t => {
    console.log(t);
    log.push(t);
  };

  fs.mkdirSync(
    'errores',
    { recursive: true }
  );

  const diagnosticoActas = [];
  const diagnosticoNavegacion = [];

  try {
    registrar(
      '=========================================='
    );
    registrar(
      '  ACTUALIZADOR DORNEDA - PASO 10E'
    );
    registrar(
      '  CALENDARIO PRIMERO + ACTAS DESPUES'
    );
    registrar(
      '=========================================='
    );
    registrar('');

    registrar(
      '1. Cargando checkpoints locales ANTES de acceder a FUTGAL...'
    );

    const checkpointInicial =
      cargarJsonSeguro(
        'checkpoint-calendario-parcial.json',
        null
      );

    let arranque = null;
    let totalEquipos = null;
    let jornadasEsperadas = null;
    let equiposOriginales = [];

    const checkpointEstructuraValido =
      Boolean(
        checkpointInicial &&
        Number.isInteger(
          checkpointInicial.totalEquipos
        ) &&
        checkpointInicial.totalEquipos >= 2 &&
        Number.isInteger(
          checkpointInicial.jornadasEsperadas
        ) &&
        checkpointInicial.jornadasEsperadas >= 1 &&
        Array.isArray(
          checkpointInicial.jornadas
        ) &&
        checkpointInicial.jornadas.length > 0
      );

    if (checkpointEstructuraValido) {
      totalEquipos =
        checkpointInicial.totalEquipos;

      jornadasEsperadas =
        checkpointInicial.jornadasEsperadas;

      for (
        const j of
        checkpointInicial.jornadas
      ) {
        for (
          const p of
          (j.partidos || [])
        ) {
          for (
            const equipo of [
              p.local,
              p.visitante
            ]
          ) {
            if (
              equipo &&
              !equiposOriginales.some(
                x =>
                  claveEquipo(x) ===
                  claveEquipo(equipo)
              )
            ) {
              equiposOriginales.push(
                equipo
              );
            }
          }
        }
      }

      arranque = {
        metodo:
          'checkpoint_local_sin_arranque_futgal'
      };

      registrar(
        `   Checkpoint detectado: ${checkpointInicial.jornadas.length}/${jornadasEsperadas} jornadas ya guardadas.`
      );
      registrar(
        '   No abrimos portada, filtros ni competición para detectar la estructura.'
      );
    } else {
      registrar(
        '   No existe checkpoint suficiente. Usando arranque FUTGAL normal...'
      );

      arranque =
        await abrirCompeticion(
          page,
          registrar
        );

      if (
        (await numeroJornada(page)) !== 1
      ) {
        throw new Error(
          'La competición no quedó situada en J1.'
        );
      }

      const bodyJ1 =
        await page.locator('body')
          .innerText();

      const extraJ1 =
        extraerPartidosDesdeTexto(
          bodyJ1
        );

      for (
        const p of extraJ1.partidos
      ) {
        for (
          const equipo of [
            p.local,
            p.visitante
          ]
        ) {
          if (
            !equiposOriginales.some(
              x =>
                claveEquipo(x) ===
                claveEquipo(equipo)
            )
          ) {
            equiposOriginales.push(
              equipo
            );
          }
        }
      }

      totalEquipos =
        equiposOriginales.length;

      if (totalEquipos < 2) {
        throw new Error(
          `Número de equipos inválido: ${totalEquipos}`
        );
      }

      jornadasEsperadas =
        totalEquipos % 2 === 0
          ? 2 * (totalEquipos - 1)
          : 2 * totalEquipos;
    }

    registrar('');
    registrar(
      '2. Estructura de la competición...'
    );
    registrar(
      `   Equipos detectados: ${totalEquipos}`
    );
    registrar(
      `   Jornadas esperadas: ${jornadasEsperadas}`
    );
    registrar(
      `   Equipos identificados en checkpoint/datos: ${equiposOriginales.length}`
    );

    // ==========================================
    // FASE 1: CALENDARIO COMPLETO Y FRESCO.
    //
    // CAMBIO 10E:
    // - Los checkpoints ya NO sustituyen la lectura de FUTGAL.
    // - En cada ejecución intentamos leer de nuevo J1-J30.
    // - El checkpoint sirve únicamente como respaldo si FUTGAL falla.
    // - Si FUTGAL cambia fecha/hora/campo, el dato fresco prevalece.
    // ==========================================
    registrar('');
    registrar(
      '3. FASE 1/2 - Leyendo J1-J30 de FUTGAL de nuevo (datos frescos)...'
    );

    const partidosPorJornada =
      Math.floor(totalEquipos / 2);

    const fallbackMap =
      mapaCheckpointsCalendario(
        totalEquipos,
        jornadasEsperadas,
        partidosPorJornada
      );

    registrar(
      `   Checkpoint disponible como respaldo: ${fallbackMap.size}/${jornadasEsperadas} jornadas.`
    );
    registrar(
      '   IMPORTANTE: el checkpoint NO evita la lectura fresca.'
    );

    const mapaJornadas = new Map();
    const cambiosCalendario = [];
    const pendientesCalendario = [];
    let jornadasConFallback = [];
    let nuevasDesdePausa = 0;

    function guardarTrabajoCalendario() {
      const combinado = new Map(fallbackMap);

      for (const [numero, jornada] of mapaJornadas.entries()) {
        combinado.set(numero, jornada);
      }

      guardarJson(
        'checkpoint-calendario-parcial.json',
        {
          fecha:
            new Date().toISOString(),
          modo:
            '10E_fresco_con_respaldo',
          totalEquipos,
          jornadasEsperadas,
          jornadas:
            [...combinado.values()]
              .sort((a, b) => a.numero - b.numero)
        }
      );
    }

    // Primera pasada: SIEMPRE intentamos FUTGAL en vivo.
    for (
      let esperada = 1;
      esperada <= jornadasEsperadas;
      esperada++
    ) {
      registrar(
        `   J${esperada}: lectura FRESCA directa aislada...`
      );

      const r =
        await extraerJornadaDirectaRobusta(
          browser,
          esperada,
          partidosPorJornada,
          registrar,
          'normal'
        );

      diagnosticoNavegacion.push(
        r.diagnostico
      );

      if (r.ok) {
        const anterior =
          fallbackMap.get(esperada) || null;

        const cambios =
          compararJornadasCalendario(
            anterior,
            r.jornada
          );

        r.jornada.origenDatos =
          'FUTGAL_FRESCO';

        r.jornada.fechaLecturaFresca =
          new Date().toISOString();

        mapaJornadas.set(
          esperada,
          r.jornada
        );

        if (cambios.length) {
          cambiosCalendario.push({
            jornada:
              esperada,
            cambios
          });

          registrar(
            `      CAMBIOS frente al checkpoint: ${cambios.length}`
          );

          for (const c of cambios) {
            if (
              c.tipo ===
              'cambio_programacion'
            ) {
              const campos =
                Object.entries(
                  c.diferencias
                )
                  .map(
                    ([k, v]) =>
                      `${k}: ${v.antes ?? 'null'} -> ${v.ahora ?? 'null'}`
                  )
                  .join(' | ');

              registrar(
                `         ${c.local} - ${c.visitante} | ${campos}`
              );
            }
          }
        }

        registrar(
          `   J${esperada}: ${r.jornada.totalPartidos} partidos | ` +
          `${r.jornada.actaUrls.length} acta(s) | FRESCA OK`
        );

        guardarTrabajoCalendario();

        nuevasDesdePausa++;

        await page.waitForTimeout(
          2200
        );

        if (
          nuevasDesdePausa >= 4
        ) {
          registrar(
            '      Pausa preventiva para no saturar FUTGAL...'
          );

          await page.waitForTimeout(
            8000
          );

          nuevasDesdePausa = 0;
        }

      } else {
        pendientesCalendario.push(
          esperada
        );

        registrar(
          `   J${esperada}: lectura fresca falló; queda para recuperación.`
        );

        await page.waitForTimeout(
          4500
        );
      }
    }

    // Segunda pasada de las jornadas que no pudieron leerse en vivo.
    if (
      pendientesCalendario.length > 0
    ) {
      registrar('');
      registrar(
        `   RECUPERACION FRESCA: ${pendientesCalendario.length} jornada(s)...`
      );

      await page.waitForTimeout(
        15000
      );

      for (
        const esperada of
        pendientesCalendario
      ) {
        registrar(
          `   Recuperando J${esperada} desde FUTGAL...`
        );

        const r =
          await extraerJornadaDirectaRobusta(
            browser,
            esperada,
            partidosPorJornada,
            registrar,
            'recuperacion'
          );

        diagnosticoNavegacion.push(
          r.diagnostico
        );

        if (r.ok) {
          const anterior =
            fallbackMap.get(esperada) || null;

          const cambios =
            compararJornadasCalendario(
              anterior,
              r.jornada
            );

          r.jornada.origenDatos =
            'FUTGAL_FRESCO_RECUPERADO';

          r.jornada.fechaLecturaFresca =
            new Date().toISOString();

          mapaJornadas.set(
            esperada,
            r.jornada
          );

          if (cambios.length) {
            cambiosCalendario.push({
              jornada:
                esperada,
              cambios
            });
          }

          registrar(
            `   J${esperada}: RECUPERADA FRESCA | ${r.jornada.totalPartidos} partidos`
          );

          guardarTrabajoCalendario();

          await page.waitForTimeout(
            4500
          );

        } else {
          const fallback =
            fallbackMap.get(
              esperada
            );

          if (
            fallback &&
            checkpointJornadaValido(
              fallback,
              esperada,
              partidosPorJornada
            )
          ) {
            const copia =
              JSON.parse(
                JSON.stringify(
                  fallback
                )
              );

            copia.origenDatos =
              'CHECKPOINT_FALLBACK';

            mapaJornadas.set(
              esperada,
              copia
            );

            jornadasConFallback.push(
              esperada
            );

            registrar(
              `   J${esperada}: FUTGAL no respondió. Se conserva checkpoint SOLO como respaldo.`
            );

            guardarTrabajoCalendario();
          } else {
            registrar(
              `   J${esperada}: SIN DATO FRESCO NI CHECKPOINT VÁLIDO`
            );
          }
        }
      }
    }

    guardarJson(
      'diagnostico-navegacion.json',
      diagnosticoNavegacion
    );

    guardarJson(
      'diagnostico-cambios-calendario.json',
      cambiosCalendario
    );

    const jornadasCalendario =
      [...mapaJornadas.values()]
        .sort(
          (a, b) =>
            a.numero - b.numero
        );

    const faltantes = [];

    for (
      let n = 1;
      n <= jornadasEsperadas;
      n++
    ) {
      if (
        !mapaJornadas.has(n)
      ) {
        faltantes.push(n);
      }
    }

    if (
      faltantes.length > 0
    ) {
      throw new Error(
        `Calendario incompleto. Faltan jornadas: ${faltantes.join(', ')}.`
      );
    }

    const calendarioCompleto = {
      fecha:
        new Date().toISOString(),
      metodo:
        '10E_futgal_fresco_con_checkpoint_solo_respaldo',
      totalEquipos,
      jornadasEsperadas,
      jornadasConFallback,
      cambiosDetectados:
        cambiosCalendario.length,
      jornadas:
        jornadasCalendario
    };

    guardarJson(
      'checkpoint-calendario.json',
      calendarioCompleto
    );

    registrar(
      `   FASE 1 COMPLETADA: ${jornadasEsperadas - jornadasConFallback.length}/${jornadasEsperadas} jornadas leídas frescas.`
    );

    if (
      jornadasConFallback.length > 0
    ) {
      registrar(
        `   AVISO: jornadas usando respaldo: ${jornadasConFallback.join(', ')}`
      );
    }

    // ==========================================
    // FASE 2: ACTAS.
    // A estas alturas ya NO dependemos de seguir
    // navegando por las jornadas.
    // ==========================================
    registrar('');
    registrar(
      '4. FASE 2/2 - Extrayendo y validando actas...'
    );

    let cacheActas =
      cargarJsonSeguro(
        'checkpoint-actas.json',
        {}
      );

    const tareas = [];

    for (
      const j of
      calendarioCompleto.jornadas
    ) {
      for (
        let i = 0;
        i < j.actaUrls.length;
        i++
      ) {
        tareas.push({
          jornada:
            j.numero,
          indice:
            i + 1,
          totalJornada:
            j.actaUrls.length,
          url:
            j.actaUrls[i]
        });
      }
    }

    registrar(
      `   Actas detectadas en calendario: ${tareas.length}`
    );

    const pendientes = [];

    for (
      let n = 0;
      n < tareas.length;
      n++
    ) {
      const t = tareas[n];

      if (
        cacheActaValida(
          cacheActas[t.url]
        )
      ) {
        registrar(
          `   [${n + 1}/${tareas.length}] J${t.jornada} ACTA ${t.indice}/${t.totalJornada} | CACHE OK`
        );
        continue;
      }

      registrar(
        `   [${n + 1}/${tareas.length}] J${t.jornada} ACTA ${t.indice}/${t.totalJornada}`
      );

      const r =
        await extraerActaRobustaV2(
          context,
          t.url,
          t.jornada,
          t.indice,
          registrar,
          'normal'
        );

      diagnosticoActas.push({
        jornada:
          t.jornada,
        url:
          t.url,
        ok:
          r.ok,
        fase:
          'primera_pasada',
        intentos:
          r.intentos,
        validacion:
          r.validacion
      });

      if (r.ok) {
        cacheActas[t.url] = {
          ok: true,
          jornada:
            t.jornada,
          url:
            t.url,
          acta:
            r.acta,
          validacion:
            r.validacion,
          fuente:
            'extraido_10B'
        };

        guardarJson(
          'checkpoint-actas.json',
          cacheActas
        );

        registrar(
          `      ${r.acta.local} ${r.acta.resultado.texto} ${r.acta.visitante} | OK`
        );
      } else {
        pendientes.push(t);

        registrar(
          '      PENDIENTE PARA SEGUNDA PASADA'
        );
      }

      await page.waitForTimeout(
        1800
      );
    }

    // Segunda pasada: separada temporalmente de la primera.
    if (pendientes.length > 0) {
      registrar('');
      registrar(
        `5. RECUPERACION - ${pendientes.length} acta(s) pendiente(s)...`
      );

      await page.waitForTimeout(
        12000
      );

      for (
        let i = 0;
        i < pendientes.length;
        i++
      ) {
        const t =
          pendientes[i];

        // Refrescamos la sesión de FUTGAL antes de reintentar
        // una acta que había devuelto página vacía.
        await page.goto(
          COMPETICION_DIRECTA,
          {
            waitUntil:
              'domcontentloaded',
            timeout: 60000
          }
        ).catch(() => {});

        await page.waitForTimeout(
          3500
        );

        registrar(
          `   RECUPERANDO J${t.jornada} ACTA ${t.indice}/${t.totalJornada}`
        );

        const r =
          await extraerActaRobustaV2(
            context,
            t.url,
            t.jornada,
            t.indice,
            registrar,
            'recuperacion'
          );

        diagnosticoActas.push({
          jornada:
            t.jornada,
          url:
            t.url,
          ok:
            r.ok,
          fase:
            'recuperacion',
          intentos:
            r.intentos,
          validacion:
            r.validacion
        });

        if (r.ok) {
          cacheActas[t.url] = {
            ok: true,
            jornada:
              t.jornada,
            url:
              t.url,
            acta:
              r.acta,
            validacion:
              r.validacion,
            fuente:
              'recuperado_10B'
          };

          guardarJson(
            'checkpoint-actas.json',
            cacheActas
          );

          registrar(
            `      RECUPERADA: ${r.acta.local} ${r.acta.resultado.texto} ${r.acta.visitante}`
          );
        } else {
          registrar(
            '      SIGUE SIN PODER VALIDARSE'
          );
        }
      }
    }

    // ==========================================
    // INTEGRACIÓN FINAL.
    // ==========================================
    registrar('');
    registrar(
      '6. Integrando calendario + actas...'
    );

    const jornadas = [];

    for (
      const j of
      calendarioCompleto.jornadas
    ) {
      const resultadosJornada =
        j.actaUrls
          .map(
            url =>
              cacheActaValida(
                cacheActas[url]
              )
                ? cacheActas[url]
                : null
          )
          .filter(Boolean);

      const mapa =
        new Map();

      for (
        const r of
        resultadosJornada
      ) {
        mapa.set(
          clavePartido(
            r.acta.local,
            r.acta.visitante
          ),
          r
        );
      }

      const fallidas =
        j.actaUrls.filter(
          url =>
            !cacheActaValida(
              cacheActas[url]
            )
        );

      const noMapeados =
        j.partidos
          .map((p, idx) => ({
            p,
            idx,
            key:
              clavePartido(
                p.local,
                p.visitante
              )
          }))
          .filter(
            x =>
              !mapa.has(x.key)
          );

      const pendientePorIndice =
        new Map();

      // Solo asociamos URL fallida a partido por eliminación
      // cuando la correspondencia es inequívoca.
      if (
        fallidas.length > 0 &&
        fallidas.length ===
          noMapeados.length
      ) {
        for (
          let i = 0;
          i < fallidas.length;
          i++
        ) {
          pendientePorIndice.set(
            noMapeados[i].idx,
            fallidas[i]
          );
        }
      }

      const partidos =
        j.partidos.map(
          (p, idx) => {
            const r =
              mapa.get(
                clavePartido(
                  p.local,
                  p.visitante
                )
              );

            return construirPartidoIntegrado(
              p,
              idx,
              r,
              pendientePorIndice.get(
                idx
              ) || null
            );
          }
        );

      const jornadaFinal = {
        numero:
          j.numero,
        totalPartidos:
          partidos.length,
        totalActasDetectadas:
          j.actaUrls.length,
        totalActasIntegradas:
          partidos.filter(
            p =>
              p.estado ===
              'FINALIZADO'
          ).length,
        actasPendientes:
          fallidas,
        validacionCalendario:
          j.validacionCalendario,
        partidos
      };

      const actasExtraidas =
        resultadosJornada.map(
          r => ({
            ok: true,
            url: r.url,
            acta: r.acta,
            validacion:
              r.validacion
          })
        );

      jornadaFinal.validacion =
        validarIntegracionJornada(
          jornadaFinal,
          j.actaUrls,
          actasExtraidas
        );

      jornadas.push(
        jornadaFinal
      );

      registrar(
        `   J${j.numero}: ` +
        `${jornadaFinal.totalActasIntegradas}/${jornadaFinal.totalActasDetectadas} actas integradas | ` +
        `${jornadaFinal.validacion.correcto ? 'OK' : 'FALLOS'}`
      );
    }

    const erroresGlobales = [];

    if (
      Array.isArray(calendarioCompleto.jornadasConFallback) &&
      calendarioCompleto.jornadasConFallback.length > 0
    ) {
      erroresGlobales.push(
        `Jornadas sin lectura fresca de FUTGAL: ${calendarioCompleto.jornadasConFallback.join(', ')}`
      );
    }

    if (
      jornadas.length !==
      jornadasEsperadas
    ) {
      erroresGlobales.push(
        `Jornadas integradas: ${jornadas.length}; esperadas: ${jornadasEsperadas}`
      );
    }

    const jornadasConFallos =
      jornadas.filter(
        j =>
          !j.validacion.correcto
      );

    if (
      jornadasConFallos.length
    ) {
      erroresGlobales.push(
        `Jornadas con fallos de integración: ` +
        jornadasConFallos
          .map(j => j.numero)
          .join(', ')
      );
    }

    const urlsFallidas = [
      ...new Set(
        jornadas.flatMap(
          j => j.actasPendientes
        )
      )
    ];

    if (
      urlsFallidas.length
    ) {
      erroresGlobales.push(
        `Actas pendientes: ${urlsFallidas.length}`
      );
    }

    const totalPartidos =
      jornadas.reduce(
        (s, j) =>
          s + j.totalPartidos,
        0
      );

    const totalActasDetectadas =
      jornadas.reduce(
        (s, j) =>
          s +
          j.totalActasDetectadas,
        0
      );

    const totalActasIntegradas =
      jornadas.reduce(
        (s, j) =>
          s +
          j.totalActasIntegradas,
        0
      );

    const competicion = {
      versionFormato: 2,
      fechaExtraccion:
        new Date().toISOString(),
      fuente: 'FUTGAL',
      temporada: '2026-2027',
      competicion:
        'Veteranos - Primera Galicia',
      grupo:
        'A Coruña | 1ª División Veteranos',
      totalEquipos,
      equipos:
        equiposOriginales,
      totalJornadas:
        jornadas.length,
      totalPartidos,
      totalActasDetectadas,
      totalActasIntegradas,
      jornadas:
        jornadas.map(
          j => ({
            numero:
              j.numero,
            totalPartidos:
              j.totalPartidos,
            totalActasDetectadas:
              j.totalActasDetectadas,
            totalActasIntegradas:
              j.totalActasIntegradas,
            actasPendientes:
              j.actasPendientes,
            partidos:
              j.partidos
          })
        )
    };

    const validacionFinal = {
      fecha:
        new Date().toISOString(),
      arquitectura:
        'datos_frescos_dos_fases_checkpoint_solo_respaldo',
      metodoArranque:
        arranque.metodo,
      metodoRecorrido:
        '10E_fresco_url_directa_aislada_con_fallback_a_checkpoint',
      jornadasEsperadas,
      jornadasIntegradas:
        jornadas.length,
      partidosEsperados:
        jornadasEsperadas *
        Math.floor(
          totalEquipos / 2
        ),
      partidosIntegrados:
        totalPartidos,
      actasDetectadas:
        totalActasDetectadas,
      actasIntegradas:
        totalActasIntegradas,
      actasPendientes:
        urlsFallidas,
      jornadasConFallback:
        calendarioCompleto.jornadasConFallback || [],
      cambiosCalendarioDetectados:
        calendarioCompleto.cambiosDetectados || 0,
      todasCorrectas:
        erroresGlobales.length === 0,
      erroresGlobales,
      resumenJornadas:
        jornadas.map(
          j => ({
            jornada:
              j.numero,
            correcto:
              j.validacion.correcto,
            errores:
              j.validacion.errores,
            actasDetectadas:
              j.totalActasDetectadas,
            actasIntegradas:
              j.totalActasIntegradas
          })
        )
    };

    guardarJson(
      'competicion.json',
      competicion
    );

    guardarJson(
      'validacion-competicion.json',
      validacionFinal
    );

    guardarJson(
      'diagnostico-actas.json',
      diagnosticoActas
    );

    guardarJson(
      'diagnostico-navegacion.json',
      diagnosticoNavegacion
    );

    registrar('');
    registrar(
      '=========================================='
    );
    registrar(
      `Jornadas: ${jornadas.length}/${jornadasEsperadas}`
    );
    registrar(
      `Partidos: ${totalPartidos}`
    );
    registrar(
      `Actas: ${totalActasIntegradas}/${totalActasDetectadas}`
    );

    if (
      validacionFinal.todasCorrectas
    ) {
      registrar(
        '   INTEGRACION 10E: VALIDACION OK'
      );
    } else {
      registrar(
        '   INTEGRACION 10E: HAY FALLOS'
      );
      registrar(
        erroresGlobales.join(' | ')
      );

      // En GitHub Actions una validación incompleta debe
      // detener el flujo para impedir publicar un JSON malo.
      process.exitCode = 2;
    }

    registrar(
      '=========================================='
    );

    fs.writeFileSync(
      'salida-integracion.txt',
      log.join('\r\n'),
      'utf8'
    );

    if (!EN_CI) {
      await page.waitForTimeout(
        30000
      );
    }

  } catch (err) {
    registrar('');
    registrar(
      'FALLO EN PASO 10E:'
    );
    registrar(
      err.stack || err.message
    );

    try {
      await page.screenshot({
        path:
          'error-integracion.png',
        fullPage: true
      });
    } catch {}

    fs.writeFileSync(
      'salida-integracion.txt',
      log.join('\r\n'),
      'utf8'
    );

    process.exitCode = 1;

    if (!EN_CI) {
      await page.waitForTimeout(
        15000
      );
    }
  } finally {
    await browser.close();
  }
})();
