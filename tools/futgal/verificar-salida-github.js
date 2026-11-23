const fs = require('fs');

function leerJson(ruta) {
  if (!fs.existsSync(ruta)) {
    throw new Error(`No existe ${ruta}`);
  }

  return JSON.parse(
    fs.readFileSync(ruta, 'utf8')
  );
}

function exigir(condicion, mensaje) {
  if (!condicion) {
    throw new Error(mensaje);
  }
}

function numeroEntero(v) {
  return Number.isInteger(Number(v));
}

function norm(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\./g, '')
    .replace(/[^A-Z0-9Ñ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

try {
  const c = leerJson('competicion.json');
  const v = leerJson('validacion-competicion.json');
  const co = leerJson('clasificacion-oficial.json');

  exigir(c.fuente === 'FUTGAL', 'Fuente distinta de FUTGAL.');
  exigir(c.temporada === '2026-2027', 'Temporada inesperada.');
  exigir(Number(c.totalEquipos) === 16, `Equipos: ${c.totalEquipos}/16.`);
  exigir(Number(c.totalJornadas) === 30, `Jornadas: ${c.totalJornadas}/30.`);
  exigir(Number(c.totalPartidos) === 240, `Partidos: ${c.totalPartidos}/240.`);

  exigir(
    Number(c.totalActasDetectadas) === Number(c.totalActasIntegradas),
    `Actas incompletas: ${c.totalActasIntegradas}/${c.totalActasDetectadas}.`
  );

  exigir(v.todasCorrectas === true, 'validacion-competicion.json no está al 100%.');
  exigir(
    Array.isArray(v.erroresGlobales) && v.erroresGlobales.length === 0,
    `Errores globales: ${(v.erroresGlobales || []).join(' | ')}`
  );
  exigir(
    Array.isArray(v.jornadasConFallback) && v.jornadasConFallback.length === 0,
    `Se usó checkpoint como respaldo en una jornada que debía leerse fresca: ${(v.jornadasConFallback || []).join(', ')}`
  );
  exigir(Number(v.jornadasIntegradas) === 30, `Validación jornadas: ${v.jornadasIntegradas}/30.`);
  exigir(Number(v.partidosIntegrados) === 240, `Validación partidos: ${v.partidosIntegrados}/240.`);
  exigir(
    Number(v.actasDetectadas) === Number(v.actasIntegradas),
    `Validación actas: ${v.actasIntegradas}/${v.actasDetectadas}.`
  );

  exigir(Array.isArray(c.jornadas) && c.jornadas.length === 30, 'Array de jornadas incompleto.');

  const numeros = c.jornadas.map(j => Number(j.numero)).sort((a, b) => a - b);
  const equiposCalendario = new Set();

  for (let n = 1; n <= 30; n++) {
    exigir(numeros[n - 1] === n, `Falta o está duplicada la jornada ${n}.`);
  }

  for (const j of c.jornadas) {
    exigir(
      Array.isArray(j.partidos) && j.partidos.length === 8,
      `J${j.numero}: ${j.partidos?.length || 0}/8 partidos.`
    );

    exigir(
      Array.isArray(j.actasPendientes) && j.actasPendientes.length === 0,
      `J${j.numero}: quedan actas pendientes.`
    );

    const equipos = [];

    for (const p of j.partidos) {
      exigir(p.local && p.visitante, `J${j.numero}: partido sin equipos.`);
      equipos.push(p.local, p.visitante);
      equiposCalendario.add(norm(p.local));
      equiposCalendario.add(norm(p.visitante));

      exigir(
        /^\d{2}-\d{2}-\d{4}$/.test(String(p.fecha || '')),
        `J${j.numero} ${p.local}-${p.visitante}: fecha inválida.`
      );

      if (p.hora !== null && p.hora !== '') {
        exigir(
          /^\d{1,2}:\d{2}$/.test(String(p.hora)),
          `J${j.numero} ${p.local}-${p.visitante}: hora inválida.`
        );
      }

      if (p.estado === 'FINALIZADO') {
        exigir(
          p.resultado &&
          numeroEntero(p.resultado.local) &&
          numeroEntero(p.resultado.visitante),
          `J${j.numero} ${p.local}-${p.visitante}: finalizado sin marcador.`
        );

        exigir(
          p.actaDisponible === true && p.acta && p.acta.url,
          `J${j.numero} ${p.local}-${p.visitante}: finalizado sin acta completa.`
        );
      }
    }

    exigir(
      new Set(equipos.map(norm)).size === 16,
      `J${j.numero}: no aparecen 16 equipos distintos.`
    );
  }

  exigir(equiposCalendario.size === 16, `Equipos únicos en calendario: ${equiposCalendario.size}/16.`);

  // La clasificación oficial FUTGAL es obligatoria en TODA publicación.
  exigir(c.fuenteClasificacionOficial === 'FUTGAL', 'Falta fuente oficial de clasificación FUTGAL.');
  exigir(
    Array.isArray(c.clasificacionOficial) && c.clasificacionOficial.length === 16,
    `Clasificación oficial en competicion.json: ${c.clasificacionOficial?.length || 0}/16.`
  );
  exigir(
    co.fuente === 'FUTGAL' && Array.isArray(co.filas) && co.filas.length === 16,
    `clasificacion-oficial.json no contiene 16 filas oficiales.`
  );

  const clasifEquipos = new Set();
  const posiciones = new Set();

  for (const r of c.clasificacionOficial) {
    const k = norm(r.equipo);
    exigir(equiposCalendario.has(k), `Clasificación: equipo no reconocido: ${r.equipo}.`);
    exigir(!clasifEquipos.has(k), `Clasificación: equipo duplicado: ${r.equipo}.`);
    clasifEquipos.add(k);

    exigir(numeroEntero(r.pos), `Clasificación: posición inválida para ${r.equipo}.`);
    exigir(Number(r.pos) >= 1 && Number(r.pos) <= 16, `Clasificación: posición fuera de rango para ${r.equipo}.`);
    exigir(!posiciones.has(Number(r.pos)), `Clasificación: posición duplicada ${r.pos}.`);
    posiciones.add(Number(r.pos));

    exigir(Number.isFinite(Number(r.pts)), `Clasificación: puntos inválidos para ${r.equipo}.`);
  }

  exigir(clasifEquipos.size === 16, `Clasificación: ${clasifEquipos.size}/16 equipos únicos.`);
  exigir(posiciones.size === 16, `Clasificación: ${posiciones.size}/16 posiciones únicas.`);

  console.log('==========================================');
  console.log(' VALIDACIÓN GITHUB: 100% CORRECTA');
  console.log(` Jornadas: ${c.totalJornadas}/30`);
  console.log(` Partidos: ${c.totalPartidos}/240`);
  console.log(` Actas: ${c.totalActasIntegradas}/${c.totalActasDetectadas}`);
  console.log(' Clasificación FUTGAL: 16/16');
  console.log(' Fallback en jornada fresca: 0');
  console.log('==========================================');

} catch (err) {
  console.error('');
  console.error('VALIDACIÓN GITHUB FALLIDA');
  console.error(err.message);
  process.exit(1);
}
