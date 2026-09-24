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

try {
  const c = leerJson('competicion.json');
  const v = leerJson('validacion-competicion.json');

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
    `Se usó checkpoint como respaldo en: ${(v.jornadasConFallback || []).join(', ')}`
  );
  exigir(Number(v.jornadasIntegradas) === 30, `Validación jornadas: ${v.jornadasIntegradas}/30.`);
  exigir(Number(v.partidosIntegrados) === 240, `Validación partidos: ${v.partidosIntegrados}/240.`);
  exigir(
    Number(v.actasDetectadas) === Number(v.actasIntegradas),
    `Validación actas: ${v.actasIntegradas}/${v.actasDetectadas}.`
  );

  exigir(Array.isArray(c.jornadas) && c.jornadas.length === 30, 'Array de jornadas incompleto.');

  const numeros = c.jornadas.map(j => Number(j.numero)).sort((a, b) => a - b);

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
      new Set(equipos).size === 16,
      `J${j.numero}: no aparecen 16 equipos distintos.`
    );
  }

  console.log('==========================================');
  console.log(' VALIDACIÓN GITHUB: 100% CORRECTA');
  console.log(` Jornadas: ${c.totalJornadas}/30`);
  console.log(` Partidos: ${c.totalPartidos}/240`);
  console.log(` Actas: ${c.totalActasIntegradas}/${c.totalActasDetectadas}`);
  console.log(' Fallback de checkpoint: 0');
  console.log('==========================================');

} catch (err) {
  console.error('');
  console.error('VALIDACIÓN GITHUB FALLIDA');
  console.error(err.message);
  process.exit(1);
}
