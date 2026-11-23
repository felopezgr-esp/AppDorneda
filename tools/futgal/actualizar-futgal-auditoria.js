const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const basePath = path.join(__dirname, 'actualizar-futgal.js');
const tempPath = path.join(__dirname, '.actualizar-futgal-auditoria-runtime.js');

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
      'No ejecuto la auditoría para no alterar una versión del scraper que no reconozco.'
    );
  }

  src = src.replace(regex, replacement);
  cambios++;
}

// La auditoría completa debe reabrir TODAS las actas.
// Una acta cacheada sirve como histórico, nunca como prueba de que FUTGAL sigue igual.
reemplazarUnaVez(
  'forzar lectura fresca de todas las actas',
  /if \(\s*\n\s*cacheActaValida\(\s*\n\s*cacheActas\[t\.url\]\s*\n\s*\)\s*\n\s*\) \{\s*\n\s*registrar\(\s*\n\s*`\s*\[\$\{n \+ 1\}\/\$\{tareas\.length\}\] J\$\{t\.jornada\} ACTA \$\{t\.indice\}\/\$\{t\.totalJornada\} \| CACHE OK`\s*\n\s*\);\s*\n\s*continue;\s*\n\s*\}/,
  `if (\n        cacheActaValida(\n          cacheActas[t.url]\n        )\n      ) {\n        registrar(\n          \`   [\${n + 1}/\${tareas.length}] J\${t.jornada} ACTA \${t.indice}/\${t.totalJornada} | CACHE IGNORADA: auditoría fresca obligatoria\`\n        );\n        delete cacheActas[t.url];\n      }`
);

// Etiquetamos la salida para que quede claro que procede de auditoría completa.
reemplazarUnaVez(
  'marcar competición auditada',
  /(fuente: 'FUTGAL',\s*\n\s*)temporada: '2026-2027'/,
  `$1modoActualizacion: 'audit',\n      auditoriaActasFrescas: true,\n      temporada: '2026-2027'`
);

if (cambios !== 2) {
  throw new Error(`Auditoría completa: número inesperado de parches aplicados (${cambios}/2).`);
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
  console.error('Auditoría completa: el runtime generado no supera node --check.');
  process.exit(1);
}

const run = spawnSync(
  process.execPath,
  [tempPath],
  {
    cwd: __dirname,
    env: {
      ...process.env,
      FUTGAL_MODE: 'audit'
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
