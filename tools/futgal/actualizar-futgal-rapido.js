const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const basePath = path.join(__dirname, 'actualizar-futgal.js');
const tempPath = path.join(__dirname, '.actualizar-futgal-rapido-runtime.js');

if (!fs.existsSync(basePath)) {
  console.error('No existe tools/futgal/actualizar-futgal.js');
  process.exit(1);
}

let src = fs.readFileSync(basePath, 'utf8');
let cambios = 0;

function reemplazarUnaVez(nombre, regex, replacement) {
  const flags = regex.flags.includes('g') ? regex.flags : regex.flags + 'g';
  const matches = [...src.matchAll(new RegExp(regex.source, flags))];

  if (matches.length !== 1) {
    throw new Error(
      `${nombre}: esperaba 1 coincidencia y encontré ${matches.length}. ` +
      'No ejecuto el modo rápido para no alterar una versión del scraper que no reconozco.'
    );
  }

  src = src.replace(regex, replacement);
  cambios++;
}

// 1) Identificador de modo.
reemplazarUnaVez(
  'insertar modo rápido',
  /const EN_CI =\s*\n\s*process\.env\.GITHUB_ACTIONS === 'true' \|\|\s*\n\s*process\.env\.CI === 'true';/,
  `const EN_CI =\n  process.env.GITHUB_ACTIONS === 'true' ||\n  process.env.CI === 'true';\n\nconst FUTGAL_MODO_RAPIDO = true;`
);

// 2) Elegimos UNA sola jornada: la que corresponde a la semana lunes-domingo.
//    La decisión se toma por el calendario oficial ya validado del checkpoint.
const helper = String.raw`
function fechaFutgalADate(valor) {
  const m = String(valor || '').match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return null;

  return new Date(
    Number(m[3]),
    Number(m[2]) - 1,
    Number(m[1]),
    12, 0, 0, 0
  );
}

function fechaCortaRapida(d) {
  const p = n => String(n).padStart(2, '0');
  return p(d.getDate()) + '-' + p(d.getMonth() + 1) + '-' + d.getFullYear();
}

function seleccionarJornadaSemanalRapida(fallbackMap, jornadasEsperadas) {
  const ahora = new Date();
  const hoy = new Date(
    ahora.getFullYear(),
    ahora.getMonth(),
    ahora.getDate(),
    12, 0, 0, 0
  );

  // JS: domingo=0 ... sábado=6. Convertimos a lunes=0.
  const diasDesdeLunes = (hoy.getDay() + 6) % 7;

  const lunes = new Date(hoy);
  lunes.setDate(lunes.getDate() - diasDesdeLunes);
  lunes.setHours(0, 0, 0, 0);

  const domingo = new Date(lunes);
  domingo.setDate(domingo.getDate() + 6);
  domingo.setHours(23, 59, 59, 999);

  const sabado = new Date(lunes);
  sabado.setDate(sabado.getDate() + 5);
  sabado.setHours(12, 0, 0, 0);

  const centroFinSemana = new Date(sabado);
  centroFinSemana.setHours(18, 0, 0, 0);

  const candidatos = [];

  for (let n = 1; n <= jornadasEsperadas; n++) {
    const j = fallbackMap.get(n);
    if (!j || !Array.isArray(j.partidos)) continue;

    const fechas = j.partidos
      .map(p => fechaFutgalADate(p.fecha))
      .filter(Boolean);

    if (!fechas.length) continue;

    const dentroSemana = fechas.filter(
      d => d.getTime() >= lunes.getTime() && d.getTime() <= domingo.getTime()
    );

    if (!dentroSemana.length) continue;

    const enFinSemana = dentroSemana.filter(
      d => d.getDay() === 6 || d.getDay() === 0
    ).length;

    const distancia = Math.min(
      ...dentroSemana.map(d => Math.abs(d.getTime() - centroFinSemana.getTime()))
    );

    candidatos.push({
      numero: n,
      partidosSemana: dentroSemana.length,
      partidosFinSemana: enFinSemana,
      distancia
    });
  }

  // La jornada de la semana será la que concentre más partidos ese fin de semana.
  // Así un aplazado aislado de una jornada antigua no roba la selección.
  candidatos.sort((a, b) =>
    (b.partidosFinSemana - a.partidosFinSemana) ||
    (b.partidosSemana - a.partidosSemana) ||
    (a.distancia - b.distancia) ||
    (a.numero - b.numero)
  );

  let elegida = candidatos[0] || null;
  let metodo = 'semana_lunes_domingo';

  // Respaldo excepcional: si esa semana no hay ningún partido, tomamos la jornada
  // cuyo calendario esté más cerca del fin de semana de la semana actual.
  if (!elegida) {
    const alternativos = [];

    for (let n = 1; n <= jornadasEsperadas; n++) {
      const j = fallbackMap.get(n);
      if (!j || !Array.isArray(j.partidos)) continue;

      const fechas = j.partidos
        .map(p => fechaFutgalADate(p.fecha))
        .filter(Boolean);

      if (!fechas.length) continue;

      alternativos.push({
        numero: n,
        partidosSemana: 0,
        partidosFinSemana: 0,
        distancia: Math.min(
          ...fechas.map(d => Math.abs(d.getTime() - centroFinSemana.getTime()))
        )
      });
    }

    alternativos.sort((a, b) =>
      (a.distancia - b.distancia) ||
      (a.numero - b.numero)
    );

    elegida = alternativos[0] || null;
    metodo = 'respaldo_jornada_mas_cercana';
  }

  if (!elegida || !Number.isInteger(elegida.numero)) {
    throw new Error(
      'Modo súper rápido: no pude determinar la jornada de la semana desde el calendario validado.'
    );
  }

  return {
    jornadas: new Set([elegida.numero]),
    semana: {
      lunes: fechaCortaRapida(lunes),
      domingo: fechaCortaRapida(domingo),
      jornada: elegida.numero,
      metodo,
      partidosSemana: elegida.partidosSemana,
      partidosFinSemana: elegida.partidosFinSemana
    }
  };
}

`;

reemplazarUnaVez(
  'insertar selector semanal',
  /\n\(async \(\) => \{/,
  `\n${helper}(async () => {`
);

// 3) Determinamos la jornada objetivo después de cargar el checkpoint válido.
reemplazarUnaVez(
  'declarar jornada semanal objetivo',
  /(registrar\(\s*`\s*Checkpoint disponible como respaldo:[\s\S]*?registrar\(\s*'\s*IMPORTANTE: el checkpoint NO evita la lectura fresca\.'\s*\);)/,
  `$1\n\n    const seleccionRapida =\n      seleccionarJornadaSemanalRapida(\n        fallbackMap,\n        jornadasEsperadas\n      );\n\n    const jornadasObjetivoRapido = seleccionRapida.jornadas;\n    const semanaRapida = seleccionRapida.semana;\n    const jornadasNoRevisadasRapido = [];\n\n    registrar(\n      '   MODO SÚPER RÁPIDO - semana ' +\n      semanaRapida.lunes + ' → ' + semanaRapida.domingo +\n      ' | J' + semanaRapida.jornada\n    );\n\n    registrar(\n      '   Solo J' + semanaRapida.jornada +\n      ' se consulta en vivo; el resto se conserva desde el checkpoint validado.'\n    );`
);

// 4) Las otras 29 jornadas se conservan sin navegar por FUTGAL.
reemplazarUnaVez(
  'saltar jornadas fuera de la semana',
  /(for \(\s*\n\s*let esperada = 1;\s*\n\s*esperada <= jornadasEsperadas;\s*\n\s*esperada\+\+\s*\n\s*\) \{\s*\n)(\s*registrar\(\s*\n\s*`\s*J\$\{esperada\}: lectura FRESCA directa aislada\.\.\.`\s*\n\s*\);)/,
  `$1      if (!jornadasObjetivoRapido.has(esperada)) {\n        const base = fallbackMap.get(esperada);\n\n        if (\n          !base ||\n          !checkpointJornadaValido(\n            base,\n            esperada,\n            partidosPorJornada\n          )\n        ) {\n          throw new Error(\n            \`Modo súper rápido sin checkpoint válido para J\${esperada}.\`\n          );\n        }\n\n        const copia = JSON.parse(JSON.stringify(base));\n        copia.origenDatos = 'CHECKPOINT_VALIDADO_NO_REVISADO_SUPERRAPIDO';\n\n        mapaJornadas.set(esperada, copia);\n        jornadasNoRevisadasRapido.push(esperada);\n        continue;\n      }\n\n$2`
);

// 5) En la jornada semanal NO aceptamos un acta cacheada como lectura actual.
//    Las actas de las otras jornadas sí se conservan desde el checkpoint.
reemplazarUnaVez(
  'forzar actas frescas de la jornada semanal',
  /if \(\s*\n\s*cacheActaValida\(\s*\n\s*cacheActas\[t\.url\]\s*\n\s*\)\s*\n\s*\) \{\s*\n\s*registrar\(\s*\n\s*`\s*\[\$\{n \+ 1\}\/\$\{tareas\.length\}\] J\$\{t\.jornada\} ACTA \$\{t\.indice\}\/\$\{t\.totalJornada\} \| CACHE OK`\s*\n\s*\);\s*\n\s*continue;\s*\n\s*\}/,
  `if (\n        cacheActaValida(\n          cacheActas[t.url]\n        )\n      ) {\n        if (jornadasObjetivoRapido.has(t.jornada)) {\n          registrar(\n            \`   [\${n + 1}/\${tareas.length}] J\${t.jornada} ACTA \${t.indice}/\${t.totalJornada} | CACHE DESCARTADA: lectura fresca obligatoria\`\n          );\n          delete cacheActas[t.url];\n        } else {\n          registrar(\n            \`   [\${n + 1}/\${tareas.length}] J\${t.jornada} ACTA \${t.indice}/\${t.totalJornada} | CACHE OK (fuera de jornada semanal)\`\n          );\n          continue;\n        }\n      }`
);

// 6) Metadatos de diagnóstico del calendario rápido.
reemplazarUnaVez(
  'marcar calendario súper rápido',
  /(const calendarioCompleto = \{\s*\n\s*fecha:\s*\n\s*new Date\(\)\.toISOString\(\),\s*\n\s*metodo:\s*\n\s*)'10E_futgal_fresco_con_checkpoint_solo_respaldo'/,
  `$1'11A_SUPERRAPIDO_jornada_semanal',\n      modoActualizacion: 'superfast',\n      semanaRapida,\n      jornadasObjetivoRapido: [...jornadasObjetivoRapido].sort((a, b) => a - b),\n      jornadasNoRevisadasRapido`
);

// 7) Metadatos del JSON público.
reemplazarUnaVez(
  'marcar competición súper rápida',
  /(fuente: 'FUTGAL',\s*\n\s*)temporada: '2026-2027'/,
  `$1modoActualizacion: 'superfast',\n      semanaRapida,\n      jornadasObjetivoRapido: [...jornadasObjetivoRapido].sort((a, b) => a - b),\n      temporada: '2026-2027'`
);

if (cambios !== 7) {
  throw new Error(`Modo súper rápido: número inesperado de parches aplicados (${cambios}/7).`);
}

fs.writeFileSync(tempPath, src, 'utf8');

const syntax = spawnSync(
  process.execPath,
  ['--check', tempPath],
  {
    cwd: __dirname,
    stdio: 'inherit'
  }
);

if (syntax.error || syntax.status !== 0) {
  try { fs.unlinkSync(tempPath); } catch {}
  console.error('Modo súper rápido: el runtime generado no supera node --check.');
  process.exit(1);
}

const run = spawnSync(
  process.execPath,
  [tempPath],
  {
    cwd: __dirname,
    env: {
      ...process.env,
      FUTGAL_MODE: 'superfast'
    },
    stdio: 'inherit'
  }
);

try { fs.unlinkSync(tempPath); } catch {}

if (run.error) {
  console.error(run.error);
  process.exit(1);
}

process.exit(run.status ?? 1);
