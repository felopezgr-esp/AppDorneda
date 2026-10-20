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

// 1) Identificador de modo. No cambia la lógica de validación del scraper original.
reemplazarUnaVez(
  'insertar modo rápido',
  /const EN_CI =\s*\n\s*process\.env\.GITHUB_ACTIONS === 'true' \|\|\s*\n\s*process\.env\.CI === 'true';/,
  `const EN_CI =\n  process.env.GITHUB_ACTIONS === 'true' ||\n  process.env.CI === 'true';\n\nconst FUTGAL_MODO_RAPIDO = true;`
);

// 2) Funciones auxiliares para elegir las jornadas prioritarias a partir del
//    calendario YA validado que existe en checkpoint.
const helper = String.raw`
function fechaFutgalATimestamp(valor) {
  const m = String(valor || '').match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return null;

  return new Date(
    Number(m[3]),
    Number(m[2]) - 1,
    Number(m[1]),
    12, 0, 0, 0
  ).getTime();
}

function seleccionarJornadasPrioritariasRapidas(
  fallbackMap,
  jornadasEsperadas
) {
  const ahora = new Date();
  const finDeHoy = new Date(
    ahora.getFullYear(),
    ahora.getMonth(),
    ahora.getDate(),
    23, 59, 59, 999
  ).getTime();

  const calendario = [];

  for (let n = 1; n <= jornadasEsperadas; n++) {
    const j = fallbackMap.get(n);
    if (!j || !Array.isArray(j.partidos)) continue;

    const fechas = j.partidos
      .map(p => fechaFutgalATimestamp(p.fecha))
      .filter(Number.isFinite);

    if (!fechas.length) continue;

    calendario.push({
      numero: n,
      inicio: Math.min(...fechas),
      fin: Math.max(...fechas)
    });
  }

  calendario.sort((a, b) => a.inicio - b.inicio);

  if (!calendario.length) {
    throw new Error(
      'Modo rápido: no pude determinar la jornada actual desde el checkpoint validado.'
    );
  }

  const iniciadas = calendario.filter(j => j.inicio <= finDeHoy);
  const futuras = calendario.filter(j => j.inicio > finDeHoy);

  const ultimaIniciada = iniciadas.length
    ? iniciadas[iniciadas.length - 1].numero
    : calendario[0].numero;

  const proxima = futuras.length
    ? futuras[0].numero
    : null;

  // Ventana deliberadamente conservadora:
  // anterior + jornada vigente/recién jugada + próxima.
  // En lunes/martes cubre resultados del fin de semana y horarios siguientes.
  // En sábado/domingo cubre la jornada en disputa, la anterior y la próxima.
  const elegidas = new Set();

  for (const n of [ultimaIniciada - 1, ultimaIniciada, proxima]) {
    if (
      Number.isInteger(n) &&
      n >= 1 &&
      n <= jornadasEsperadas
    ) {
      elegidas.add(n);
    }
  }

  if (!elegidas.size) {
    throw new Error('Modo rápido: no se seleccionó ninguna jornada prioritaria.');
  }

  return elegidas;
}

`;

reemplazarUnaVez(
  'insertar selector de jornadas',
  /\n\(async \(\) => \{/,
  `\n${helper}(async () => {`
);

// 3) Después de cargar el checkpoint validado, determinamos qué jornadas
//    consultar en vivo. El resto NO se inventa ni se reconstruye: se conserva
//    exactamente desde el último checkpoint válido.
reemplazarUnaVez(
  'declarar jornadas prioritarias',
  /(registrar\(\s*`\s*Checkpoint disponible como respaldo:[\s\S]*?registrar\(\s*'\s*IMPORTANTE: el checkpoint NO evita la lectura fresca\.'\s*\);)/,
  `$1\n\n    const jornadasObjetivoRapido =\n      seleccionarJornadasPrioritariasRapidas(\n        fallbackMap,\n        jornadasEsperadas\n      );\n\n    const jornadasNoRevisadasRapido = [];\n\n    registrar(\n      '   MODO RÁPIDO - jornadas prioritarias: ' +\n      [...jornadasObjetivoRapido]\n        .sort((a, b) => a - b)\n        .map(n => 'J' + n)\n        .join(', ')\n    );\n\n    registrar(\n      '   El resto se conserva desde el último checkpoint validado.'\n    );`
);

// 4) Saltamos la lectura FUTGAL únicamente para jornadas no prioritarias.
//    Si falta un checkpoint válido, el modo rápido se detiene: nunca rellena
//    datos a ciegas.
reemplazarUnaVez(
  'saltar jornadas no prioritarias',
  /(for \(\s*\n\s*let esperada = 1;\s*\n\s*esperada <= jornadasEsperadas;\s*\n\s*esperada\+\+\s*\n\s*\) \{\s*\n)(\s*registrar\(\s*\n\s*`\s*J\$\{esperada\}: lectura FRESCA directa aislada\.\.\.`\s*\n\s*\);)/,
  `$1      if (!jornadasObjetivoRapido.has(esperada)) {\n        const base = fallbackMap.get(esperada);\n\n        if (\n          !base ||\n          !checkpointJornadaValido(\n            base,\n            esperada,\n            partidosPorJornada\n          )\n        ) {\n          throw new Error(\n            \`Modo rápido sin checkpoint válido para J\${esperada}.\`\n          );\n        }\n\n        const copia = JSON.parse(JSON.stringify(base));\n        copia.origenDatos = 'CHECKPOINT_VALIDADO_NO_REVISADO_RAPIDO';\n\n        mapaJornadas.set(esperada, copia);\n        jornadasNoRevisadasRapido.push(esperada);\n        continue;\n      }\n\n$2`
);

// 5) Marcamos el resultado para poder auditar exactamente qué hizo el modo rápido.
reemplazarUnaVez(
  'marcar calendario rápido',
  /(const calendarioCompleto = \{\s*\n\s*fecha:\s*\n\s*new Date\(\)\.toISOString\(\),\s*\n\s*metodo:\s*\n\s*)'10E_futgal_fresco_con_checkpoint_solo_respaldo'/,
  `$1'10E_RAPIDO_prioritario_con_checkpoint_validado',\n      modoActualizacion: 'fast',\n      jornadasObjetivoRapido: [...jornadasObjetivoRapido].sort((a, b) => a - b),\n      jornadasNoRevisadasRapido`
);

reemplazarUnaVez(
  'marcar competicion rápida',
  /(fuente: 'FUTGAL',\s*\n\s*)temporada: '2026-2027'/,
  `$1modoActualizacion: 'fast',\n      jornadasObjetivoRapido: [...jornadasObjetivoRapido].sort((a, b) => a - b),\n      temporada: '2026-2027'`
);

if (cambios !== 6) {
  throw new Error(`Modo rápido: número inesperado de parches aplicados (${cambios}/6).`);
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
  try {
    fs.unlinkSync(tempPath);
  } catch {}

  console.error(
    'Modo rápido: el runtime generado no supera node --check.'
  );
  process.exit(1);
}

const run = spawnSync(
  process.execPath,
  [tempPath],
  {
    cwd: __dirname,
    env: {
      ...process.env,
      FUTGAL_MODE: 'fast'
    },
    stdio: 'inherit'
  }
);

try {
  fs.unlinkSync(tempPath);
} catch {}

if (run.error) {
  console.error(run.error);
  process.exit(1);
}

process.exit(run.status ?? 1);
