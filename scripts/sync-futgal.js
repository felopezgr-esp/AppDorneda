/**
 * sync-futgal.js - Script de sincronización backend autónomo con FUTGAL y Firebase Firestore
 * Xuventude Dorneda - Temporada 2026/27
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  FUTGAL_COMPETITIONS,
  parseFutgalJornadaHtml,
  parseFutgalClasificacionHtml,
  parseFutgalActaHtml,
  buildFutgalUrl,
  mergeFutgalDataIntoDB,
  getMadridFormattedTimestamp
} = require('./futgal-core');

const FIRESTORE_PROJECT = "appdorneda";
const FIRESTORE_DOC_PATH = "dorneda_app_data/temporada_2026_2027";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

let sessionCookies = "";
let firestoreAccessToken = null;

function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

/**
 * Obtiene un token OAuth temporal usando la cuenta de servicio guardada
 * exclusivamente como secreto de GitHub Actions.
 */
async function getFirestoreAccessToken() {
  if (firestoreAccessToken) return firestoreAccessToken;

  const rawCredentials = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!rawCredentials) {
    throw new Error('Falta el secreto FIREBASE_SERVICE_ACCOUNT_JSON. Se cancela la sincronización para no usar acceso anónimo.');
  }

  let credentials;
  try {
    credentials = JSON.parse(rawCredentials);
  } catch (error) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON no contiene un JSON válido.');
  }

  if (!credentials.client_email || !credentials.private_key) {
    throw new Error('La credencial de Firebase no contiene client_email y private_key.');
  }

  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64Url(JSON.stringify({
    iss: credentials.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  }));
  const unsignedJwt = `${header}.${claims}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsignedJwt), credentials.private_key).toString('base64url');
  const assertion = `${unsignedJwt}.${signature}`;

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    })
  });
  const body = await response.json();
  if (!response.ok || !body.access_token) {
    throw new Error(`No se pudo autenticar la cuenta de servicio (${response.status}).`);
  }

  firestoreAccessToken = body.access_token;
  return firestoreAccessToken;
}

/**
 * Realiza una petición HTTPS con soporte de cookies y seguimiento de redirecciones
 */
function fetchWithCookies(url, customHeaders = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const headers = {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
      ...customHeaders
    };
    if (sessionCookies) {
      headers['Cookie'] = sessionCookies;
    }

    const req = https.get(parsedUrl, { headers }, (res) => {
      // Capturar cookies de sesión
      if (res.headers['set-cookie']) {
        const cookies = res.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');
        sessionCookies = sessionCookies ? `${sessionCookies}; ${cookies}` : cookies;
      }

      // Manejar redirecciones 301, 302, 303, 307
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let redirectUrl = res.headers.location;
        if (!redirectUrl.startsWith('http')) {
          redirectUrl = new URL(redirectUrl, parsedUrl.origin).href;
        }
        res.resume();
        return fetchWithCookies(redirectUrl, customHeaders).then(resolve).catch(reject);
      }

      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        // Decodificar en ISO-8859-1 o Windows-1252
        const html = buffer.toString('latin1');
        resolve({ statusCode: res.statusCode, html, buffer });
      });
    });

    req.on('error', (err) => reject(err));
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error(`Timeout fetching ${url}`));
    });
  });
}

/**
 * Lee el documento actual desde Firebase Firestore vía REST API
 */
async function getFirestoreDB() {
  const url = `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT}/databases/(default)/documents/${FIRESTORE_DOC_PATH}`;
  const accessToken = await getFirestoreAccessToken();
  
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Authorization: `Bearer ${accessToken}` } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            const json = JSON.parse(data);
            if (json.fields && json.fields.db) {
              const dbObj = convertFirestoreValue(json.fields.db);
              resolve(dbObj);
            } else {
              resolve(null);
            }
          } else {
            console.warn(`Firestore GET returned status ${res.statusCode}: ${data}`);
            resolve(null);
          }
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

/**
 * Convierte un mapa de Firestore Value Types a un objeto JavaScript estándar
 */
function convertFirestoreValue(val) {
  if (!val) return null;
  if ('stringValue' in val) return val.stringValue;
  if ('integerValue' in val) return parseInt(val.integerValue, 10);
  if ('doubleValue' in val) return parseFloat(val.doubleValue);
  if ('booleanValue' in val) return val.booleanValue;
  if ('nullValue' in val) return null;
  if ('arrayValue' in val) {
    const arr = val.arrayValue.values || [];
    return arr.map(convertFirestoreValue);
  }
  if ('mapValue' in val) {
    return convertFirestoreMapToObject(val.mapValue);
  }
  return null;
}

function convertFirestoreMapToObject(mapVal) {
  const res = {};
  const fields = mapVal.fields || {};
  for (const k of Object.keys(fields)) {
    res[k] = convertFirestoreValue(fields[k]);
  }
  return res;
}

/**
 * Convierte un objeto JavaScript a la estructura de campos de Firestore REST
 */
function convertObjectToFirestoreValue(val) {
  if (val === null || val === undefined) {
    return { nullValue: null };
  }
  if (typeof val === 'string') {
    return { stringValue: val };
  }
  if (typeof val === 'number') {
    if (Number.isInteger(val)) {
      return { integerValue: String(val) };
    }
    return { doubleValue: val };
  }
  if (typeof val === 'boolean') {
    return { booleanValue: val };
  }
  if (Array.isArray(val)) {
    return {
      arrayValue: {
        values: val.map(convertObjectToFirestoreValue)
      }
    };
  }
  if (typeof val === 'object') {
    const fields = {};
    for (const k of Object.keys(val)) {
      fields[k] = convertObjectToFirestoreValue(val[k]);
    }
    return {
      mapValue: { fields }
    };
  }
  return { stringValue: String(val) };
}

/**
 * Guarda el objeto DB en Firebase Firestore vía REST API
 */
async function saveFirestoreDB(dbObj) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT}/databases/(default)/documents/${FIRESTORE_DOC_PATH}`;
  const accessToken = await getFirestoreAccessToken();
  
  const payload = JSON.stringify({
    fields: {
      db: convertObjectToFirestoreValue(dbObj),
      version: { stringValue: 'v17' },
      updatedAt: { timestampValue: new Date().toISOString() }
    }
  });

  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request(parsed, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error(`Firestore PATCH failed (${res.statusCode}): ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * Función principal de sincronización
 */
async function runSync() {
  console.log(`[${getMadridFormattedTimestamp()}] Iniciando sincronización oficial con FUTGAL...`);

  const futgalResults = {
    liga: [],
    copa: []
  };

  // 0. Inicializar sesión y cookies en la portada de FUTGAL
  try {
    console.log("Conectando con portada de FUTGAL para obtener sesión...");
    await fetchWithCookies('https://www.futgal.es/');
  } catch(e) {
    console.warn("Aviso al obtener cookies de portada:", e.message);
  }

  // 1. Sincronizar Liga (30 jornadas)
  const ligaConfig = FUTGAL_COMPETITIONS.find(c => c.tipo === 'liga');
  if (ligaConfig) {
    console.log(`\n=== Consultando LIGA (${ligaConfig.nombre}): ${ligaConfig.jornadas} Jornadas ===`);
    for (let j = 1; j <= ligaConfig.jornadas; j++) {
      const url = buildFutgalUrl(ligaConfig, j);
      try {
        const { html } = await fetchWithCookies(url);
        const matches = parseFutgalJornadaHtml(html, j, ligaConfig);
        futgalResults.liga.push(matches);
        const dornedaM = matches.find(m => m.dorneda);
        if (dornedaM) {
          console.log(`  ✓ J${j}: ${dornedaM.local} (${dornedaM.gl !== null ? dornedaM.gl : '-'}) vs ${dornedaM.visitante} (${dornedaM.gv !== null ? dornedaM.gv : '-'}) | ${dornedaM.fecha} ${dornedaM.hora || ''}`);
        } else {
          console.log(`  ✓ J${j}: ${matches.length} partidos encontrados`);
        }
      } catch (err) {
        console.error(`  ✗ Error al consultar Liga J${j}:`, err.message);
      }
      // Pequeña pausa para evitar rate limiting
      await new Promise(r => setTimeout(r, 120));
    }
  }

  // 2. Sincronizar Copas (Copa 1 y futuras)
  const copaConfigs = FUTGAL_COMPETITIONS.filter(c => c.tipo === 'copa');
  for (const copaConfig of copaConfigs) {
    console.log(`\n=== Consultando COPA (${copaConfig.nombre}) ===`);
    let ronda = 1;
    let keepChecking = true;

    while (keepChecking && ronda <= 10) {
      const url = buildFutgalUrl(copaConfig, ronda);
      try {
        const { html } = await fetchWithCookies(url);
        const matches = parseFutgalJornadaHtml(html, ronda, copaConfig);

        if (matches.length === 0) {
          console.log(`  ℹ Ronda ${ronda}: Sin partidos publicados aún.`);
          keepChecking = false;
        } else {
          futgalResults.copa.push(matches);
          const dornedaM = matches.find(m => m.dorneda);
          if (dornedaM) {
            console.log(`  ✓ Ronda ${ronda} (Dorneda): ${dornedaM.local} (${dornedaM.gl !== null ? dornedaM.gl : '-'}) vs ${dornedaM.visitante} (${dornedaM.gv !== null ? dornedaM.gv : '-'}) | ${dornedaM.fecha} ${dornedaM.hora || ''} | Estado: ${dornedaM.estado}`);
          } else {
            console.log(`  ✓ Ronda ${ronda}: ${matches.length} partidos encontrados.`);
          }
          ronda++;
        }
      } catch (err) {
        console.error(`  ✗ Error al consultar Copa Ronda ${ronda}:`, err.message);
        keepChecking = false;
      }
      await new Promise(r => setTimeout(r, 150));
    }
  }

  // 3. Sincronizar Clasificación
  if (ligaConfig) {
    console.log(`\n=== Consultando CLASIFICACIÓN (${ligaConfig.nombre}) ===`);
    const clasifUrl = `https://www.futgal.es/pnfg/NPcd/NFG_VisClasificacion?cod_primaria=1000120&codcompeticion=${ligaConfig.codCompeticion}&codgrupo=${ligaConfig.codGrupo}&cod_agrupacion=1`;
    try {
      const { html } = await fetchWithCookies(clasifUrl);
      const clasifData = parseFutgalClasificacionHtml(html);
      if (clasifData && clasifData.length > 0) {
        console.log(`  ✓ Clasificación descargada: ${clasifData.length} equipos`);
        futgalResults.clasificacion = clasifData;
      }
    } catch (err) {
      console.error(`  ✗ Error al consultar Clasificación:`, err.message);
    }
  }

  // 4. Sincronizar Actas de todos los partidos de Liga disputados (para Goleadores / Pichichi) y de Dorneda
  console.log(`\n=== Consultando ACTAS oficiales de todos los partidos jugados en la Liga... ===`);
  const allPlayedLeagueMatches = [];
  if (futgalResults.liga) {
    futgalResults.liga.forEach(jl => jl.forEach(m => {
      if (m.enlaceActa && (m.gl !== null || m.estado === 'Finalizado' || (m.gl === null && m.gv === null && m.fecha && /2026/.test(m.fecha)))) {
        // Incluir si tiene enlace de acta
        allPlayedLeagueMatches.push(m);
      }
    }));
  }

  const scorersMap = {}; // { 'Jugador|Equipo': { jugador, equipo, goles, penaltis, pj } }

  for (const lm of allPlayedLeagueMatches) {
    try {
      console.log(`  🔍 Consultando acta: J${lm.jornada} ${lm.local} vs ${lm.visitante}...`);
      const { html } = await fetchWithCookies(lm.enlaceActa);
      const actaData = parseFutgalActaHtml(html);
      if (actaData) {
        lm.actaParsed = actaData;
        if (actaData.arbitro && !lm.arbitro) lm.arbitro = actaData.arbitro;
        if (actaData.campo && !lm.campo) lm.campo = actaData.campo;

        // Procesar goles para la tabla de Pichichi / Goleadores de Liga
        if (actaData.allGoles && actaData.allGoles.length > 0) {
          actaData.allGoles.forEach(g => {
            if (!g.rawScorer) return;
            // Identificar equipo del goleador si es posible o usar local/visitante
            const team = lm.dorneda ? (lm.condicionDorneda === 'Local' ? lm.local : lm.visitante) : (lm.local || 'Equipo');
            const key = `${g.rawScorer}|${team}`;
            if (!scorersMap[key]) {
              scorersMap[key] = {
                jugador: g.rawScorer,
                equipo: team,
                goles: 0,
                penaltis: 0,
                pj: 1
              };
            }
            scorersMap[key].goles += 1;
            if (g.penalti) scorersMap[key].penaltis += 1;
          });
        }
      }
    } catch (err) {
      console.error(`  ✗ Error al consultar acta ${lm.enlaceActa}:`, err.message);
    }
    await new Promise(r => setTimeout(r, 150));
  }

  // Convertir mapa de goleadores a lista ordenada
  const leagueScorersList = Object.values(scorersMap).sort((a, b) => {
    if (b.goles !== a.goles) return b.goles - a.goles;
    return a.jugador.localeCompare(b.jugador);
  });

  if (leagueScorersList.length > 0) {
    console.log(`  ✓ Tabla de Goleadores (Pichichi) compilada: ${leagueScorersList.length} goleadores.`);
    futgalResults.ligaGoleadores = leagueScorersList;
  }

  // 5. Obtener DB actual de Firestore
  console.log(`\n=== Obteniendo datos actuales de Firebase Firestore... ===`);
  let currentDB = await getFirestoreDB();

  // Cargar base de seguridad si Firestore está vacío o incompleto
  const backupDir = path.join(__dirname, '..', 'Archivos', 'backups');
  let safetyDB = null;
  if (fs.existsSync(backupDir)) {
    const backupFiles = fs.readdirSync(backupDir).filter(f => f.endsWith('.json')).sort().reverse();
    for (const bf of backupFiles) {
      try {
        let raw = fs.readFileSync(path.join(backupDir, bf), 'utf8');
        if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
        const parsed = JSON.parse(raw);
        const candidate = parsed.fields && parsed.fields.db ? convertFirestoreValue(parsed.fields.db) : parsed;
        if (candidate && candidate.jugadores && candidate.jugadores.length >= 25) {
          safetyDB = candidate;
          console.log(`✓ Base de datos de seguridad cargada desde backup ${bf}`);
          break;
        }
      } catch (e) {}
    }
  }

  if (!currentDB || !currentDB.jugadores || currentDB.jugadores.length < 25 || !currentDB.partidos || currentDB.partidos.length < 30) {
    console.warn(`Firestore contiene datos parciales o vacíos. Restaurando base completa desde seguridad...`);
    if (safetyDB) {
      currentDB = JSON.parse(JSON.stringify(safetyDB));
    } else {
      currentDB = { jugadores: [], partidos: [], calendario: [], todasJornadas: [], copaJornadas: [], economia: { cuotas: [] }, clasificacion: [] };
    }
  } else if (safetyDB) {
    // Fusión de campos clave de seguridad (fotos, notas, cuotas)
    if (safetyDB.jugadores && currentDB.jugadores) {
      safetyDB.jugadores.forEach(sj => {
        const cj = currentDB.jugadores.find(j => j.id === sj.id || (j.nombre && sj.nombre && j.nombre.toLowerCase() === sj.nombre.toLowerCase()));
        if (cj) {
          if (sj.foto && !cj.foto) cj.foto = sj.foto;
          if (sj.notas && !cj.notas) cj.notas = sj.notas;
        } else {
          currentDB.jugadores.push(sj);
        }
      });
    }
    if (safetyDB.partidos && currentDB.partidos) {
      safetyDB.partidos.forEach(sp => {
        if (sp.codigo && sp.codigo.startsWith('Pret_')) {
          if (!currentDB.partidos.some(p => p.codigo === sp.codigo)) {
            currentDB.partidos.unshift(sp);
          }
        }
      });
    }
    if (safetyDB.economia && (!currentDB.economia || !currentDB.economia.cuotas || currentDB.economia.cuotas.length === 0)) {
      currentDB.economia = safetyDB.economia;
    }
  }

  // 4. Merge no destructivo
  console.log(`=== Realizando fusión no destructiva (Upsert) de datos... ===`);
  const { updatedDB, summary, logs } = mergeFutgalDataIntoDB(currentDB, futgalResults);

  console.log(`\nResumen de Sincronización:`);
  console.log(`- Jornadas de Liga revisadas: ${summary.ligaJornadasChecked}`);
  console.log(`- Rondas de Copa encontradas: ${summary.copaRondasFound}`);
  console.log(`- Partidos actualizados: ${summary.partidosActualizados}`);
  console.log(`- Nuevos partidos: ${summary.nuevosPartidos}`);
  console.log(`- Sin cambios: ${summary.sinCambios}`);

  if (logs.length > 0) {
    console.log(`\nCambios detectados:`);
    logs.forEach(l => console.log(`  • [${l.fecha} ${l.hora}] ${l.detalle}`));
  }

  // Validación de integridad estricta antes de escribir en Firestore
  if (!updatedDB.jugadores || updatedDB.jugadores.length < 25 || !updatedDB.partidos || updatedDB.partidos.length < 35) {
    console.error(`✗ ERROR: La base de datos resultante no supera el test de integridad (jugadores: ${updatedDB.jugadores?.length}, partidos: ${updatedDB.partidos?.length}). Abortando escritura en Firestore para proteger datos.`);
    return;
  }

  // 5. Guardar en Firestore
  console.log(`\n=== Guardando datos actualizados en Firestore... ===`);
  try {
    await saveFirestoreDB(updatedDB);
    console.log(`✓ Datos guardados exitosamente en Firestore.`);
  } catch (err) {
    console.error(`✗ Error al guardar en Firestore:`, err.message);
  }

  // 6. Guardar snapshot local de backup
  try {
    const backupDir = path.join(__dirname, '..', 'Archivos', 'backups');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    const backupFile = path.join(backupDir, `db_snapshot_${Date.now()}.json`);
    fs.writeFileSync(backupFile, JSON.stringify(updatedDB, null, 2), 'utf8');
    console.log(`✓ Snapshot de seguridad guardado en ${backupFile}`);
  } catch (e) {
    console.warn(`No se pudo guardar el snapshot local:`, e.message);
  }

  console.log(`\n[${getMadridFormattedTimestamp()}] Sincronización completada con éxito.`);
}

// Ejecutar si se invoca directamente
if (require.main === module) {
  runSync().catch(err => {
    console.error('Error fatal en sincronización:', err);
    process.exit(1);
  });
}

module.exports = {
  runSync,
  fetchWithCookies,
  getFirestoreDB,
  saveFirestoreDB,
  convertFirestoreValue,
  convertFirestoreMapToObject
};
