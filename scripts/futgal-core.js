/**
 * futgal-core.js - Motor centralizado de configuración, parsing y sincronización de FUTGAL
 * Xuventude Dorneda - Temporada 2026/27
 */

// Configuración centralizada de competiciones FUTGAL
const FUTGAL_COMPETITIONS = [
  {
    id: "liga",
    nombre: "Primera Futgal",
    competicionNombreOficial: "VETERANOS - PRIMERA GALICIA",
    grupoNombreOficial: "A CORUÑA | 1ª DIVISIÓN VETERANOS",
    codCompeticion: "26991153",
    codGrupo: "28251751",
    codTemporada: "22",
    jornadas: 30,
    tipo: "liga"
  },
  {
    id: "copa1",
    nombre: "Copa Federacion A Coruna",
    competicionNombreOficial: "VETERANOS COPA",
    codCompeticion: "26991557",
    codGrupo: "26991558",
    codTemporada: "22",
    tipo: "copa"
  }
  // Para añadir la futura Copa 2, descomentar y rellenar:
  // {
  //   id: "copa2",
  //   nombre: "Copa 2",
  //   codCompeticion: "XXXXX",
  //   codGrupo: "XXXXX",
  //   codTemporada: "22",
  //   tipo: "copa"
  // }
];

// Identificadores y nombres clave de Xuventude Dorneda en FUTGAL
const DORNEDA_INFO = {
  idEquipo: "3990553",
  idClub: "1905",
  nombres: [
    "xuventude dorneda",
    "xuv. dorneda",
    "dorneda",
    "xuventude dorneda c.f.",
    "c.f. xuventude dorneda"
  ]
};

// Array de permutación de dígitos de Novanet (FUTGAL)
const NOVANET_D_ARRAY = [
  2, 5, 9, 4, 1, 0, 8, 6, 3, 7,
  1, 3, 5, 7, 9, 0, 2, 4, 6, 8,
  0, 2, 4, 6, 8, 1, 3, 5, 7, 9,
  7, 5, 2, 0, 9, 6, 3, 8, 4, 1
];

/**
 * Normaliza nombres quitando acentos y espacios extra
 */
function normalizeNameStr(str) {
  if (!str) return '';
  try {
    return String(str).trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  } catch (e) {
    return String(str).trim().toLowerCase();
  }
}

/**
 * Comprueba si un nombre o ID corresponde al Xuventude Dorneda
 */
function isDornedaTeam(teamName, teamId) {
  if (teamId && String(teamId).trim() === DORNEDA_INFO.idEquipo) return true;
  const norm = normalizeNameStr(teamName);
  return DORNEDA_INFO.nombres.some(n => norm.includes(n) || n.includes(norm));
}

/**
 * Decodifica un dígito o marcador ofuscado de Novanet/FUTGAL
 */
function decodeNovanetString(str) {
  if (!str) return '';
  let s = String(str);
  s = s.replace(/#[a-zA-Z0-9_-]+:(?:before|after)\s*\{\s*content:\s*["'](?:\\003)?(\d)["']\s*\}\s*;?\s*\d*/gi, '$1');
  s = s.replace(/ntype\(["'][^"']*["'],\s*(\d+),\s*(\d+)[^)]*\)\s*;?\s*\d*/gi, function(match, nStr, iStr) {
    const n = parseInt(nStr, 10);
    const i = parseInt(iStr, 10);
    const idx = (i * 10) + n;
    if (idx >= 0 && idx < NOVANET_D_ARRAY.length) {
      return String(NOVANET_D_ARRAY[idx]);
    }
    return '';
  });
  s = s.replace(/eval\(function[\s\S]*?\}\)\);?/gi, '');
  return s;
}

function decodeFutgalScoreSpan(spanHtml, tableHtml) {
  if (!spanHtml) return null;
  const contextHtml = (tableHtml || "") + " " + spanHtml;

  // 1. Extraer ID del elemento si existe (e.g. id=idh1965202 o id="idh1965202")
  const idMatch = spanHtml.match(/id=["']?([a-zA-Z0-9_-]+)["']?/i);
  if (idMatch) {
    const elemId = idMatch[1];

    // Regla A: Novanet ntype(id, n, i, ...) -> d[(i*10)+n]
    const ntypeRegex = new RegExp(`ntype\\(["']${elemId}["'],\\s*(\\d+),\\s*(\\d+)`, 'i');
    const ntypeMatch = contextHtml.match(ntypeRegex);
    if (ntypeMatch) {
      const n = parseInt(ntypeMatch[1], 10);
      const i = parseInt(ntypeMatch[2], 10);
      const idx = (i * 10) + n;
      if (idx >= 0 && idx < NOVANET_D_ARRAY.length) {
        return NOVANET_D_ARRAY[idx];
      }
    }

    // Regla B: CSS pseudo-elementos (#elemId:before o #elemId:after)
    // CUIDADO: Si contiene 'display:none', es un señuelo (honeypot) de Novanet!
    const cssStyleRegex = new RegExp(`#${elemId}[^{]*\\{([^}]*)\\}`, 'i');
    const cssMatch = contextHtml.match(cssStyleRegex);
    if (cssMatch) {
      const cssRules = cssMatch[1];
      if (!/display:\s*none/i.test(cssRules)) {
        const cMatch = cssRules.match(/content:\s*["'](?:\\003)?(\d)["']/i);
        if (cMatch) {
          return parseInt(cMatch[1], 10);
        }
      }
    }

    // Regla C: Texto inline directo en #elemId, descartando hijos con display:none
    let cleanSpan = spanHtml
      .replace(/<span[^>]*style=["'][^"']*display:\s*none[^"']*["'][^>]*>.*?<\/span>/gi, '')
      .replace(/<span[^>]*style=["'][^"']*display:\s*none[^"']*["'][^>]*>[^<]*/gi, '');
    const inlineRegex = new RegExp(`<[^>]*id=["']?${elemId}["']?[^>]*>([^<]*)`, 'i');
    const inlineMatch = cleanSpan.match(inlineRegex);
    if (inlineMatch && inlineMatch[1].trim() !== "") {
      const inlineDigits = inlineMatch[1].replace(/\D/g, '');
      if (inlineDigits.length > 0) {
        return parseInt(inlineDigits, 10);
      }
    }
  }

  // 2. Valor directo en <i class=fa-solid>DIGIT</i>
  const directMatch = spanHtml.match(/<i\s+class=["']?fa-solid["']?>\s*(\d+)\s*<\/i>/i);
  if (directMatch) {
    return parseInt(directMatch[1], 10);
  }

  // 3. Texto plano directo descartando estilos, scripts y elementos con display:none
  let cleanText = spanHtml
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<span[^>]*style=["'][^"']*display:\s*none[^"']*["'][^>]*>.*?<\/span>/gi, '')
    .replace(/<span[^>]*style=["'][^"']*display:\s*none[^"']*["'][^>]*>[^<]*/gi, '')
    .replace(/<[^>]*>/g, '')
    .trim();
  const digits = cleanText.replace(/\D/g, '');
  if (digits.length > 0) {
    return parseInt(digits, 10);
  }

  return null;
}

/**
 * Parsea el HTML de una jornada de FUTGAL y devuelve la lista de partidos
 */
function parseFutgalJornadaHtml(html, jornadaNum, compConfig) {
  const matches = [];
  if (!html) return matches;

  // Extraer tablas de partido (<table width="100%">...</table>)
  const tableRegex = /<table width="100%">[\s\S]*?<\/table>/gi;
  let tableMatch;

  while ((tableMatch = tableRegex.exec(html)) !== null) {
    const tableHtml = tableMatch[0];
    if (!tableHtml.includes('NFG_VisEquipos')) continue;

    // Equipos: local y visitante
    const teamRegex = /NFG_VisEquipos\?cod_primaria=1000119&Codigo_Equipo=(\d+)">([^<]+)<\/a>/gi;
    const teamMatches = [];
    let tm;
    while ((tm = teamRegex.exec(tableHtml)) !== null) {
      teamMatches.push({ id: tm[1], nombre: tm[2].trim() });
    }

    if (teamMatches.length < 2) {
      // Caso de descanso (e.g. "Descansa")
      continue;
    }

    const local = teamMatches[0];
    const visitante = teamMatches[1];

    // Campo
    let campo = "";
    const campoMatch = tableHtml.match(/NFG_VisCampos\?cod_primaria=1000122&Codigo_Campo=\d+">([^<]+)<\/a>/i);
    if (campoMatch) {
      campo = campoMatch[1].trim();
    }

    // Fecha y hora
    let fecha = "";
    let hora = "";
    const horarioRegex = /<span class=["']?horario["']?[^>]*>\s*(\d{2}-\d{2}-\d{4}|\d{2}:\d{2})\s*<\/span>/gi;
    let hm;
    while ((hm = horarioRegex.exec(tableHtml)) !== null) {
      const val = hm[1].trim();
      if (/^\d{2}-\d{2}-\d{4}$/.test(val)) {
        fecha = val.replace(/-/g, '/');
      } else if (/^\d{2}:\d{2}$/.test(val)) {
        hora = val;
      }
    }

    // Marcador
    let gl = null;
    let gv = null;
    const scoreSpansRegex = /<span class="[^"]*resultado[^"]*">([\s\S]*?)<\/span>/gi;
    const scoreSpans = [];
    let sm;
    while ((sm = scoreSpansRegex.exec(tableHtml)) !== null) {
      scoreSpans.push(sm[1]);
    }

    if (scoreSpans.length >= 2) {
      gl = decodeFutgalScoreSpan(scoreSpans[0], tableHtml);
      gv = decodeFutgalScoreSpan(scoreSpans[1], tableHtml);
    }

    // Acta oficial
    let codActa = "";
    let enlaceActa = "";
    const actaMatch = tableHtml.match(/CodActa=(\d+)/i);
    if (actaMatch) {
      codActa = actaMatch[1];
      enlaceActa = `https://www.futgal.es/pnfg/NPcd/NFG_CmpPartido?cod_primaria=1000120&CodActa=${codActa}&cod_acta=${codActa}`;
    }

    // Árbitro
    let arbitro = "";
    const arbitroMatch = tableHtml.match(/<strong>&Aacute;rbitro:\s*<\/strong>\s*&nbsp;([^<]+)/i);
    if (arbitroMatch) {
      arbitro = arbitroMatch[1].trim();
    }

    // Estado del partido
    let estado = "Oficial";
    if (tableHtml.includes("cubo_cerrada") || tableHtml.includes("wid2_resultado_cerrada") || (gl !== null && gv !== null)) {
      estado = "Finalizado";
    } else if (tableHtml.includes("wid2_resultado_enjuego") || tableHtml.includes("cubo_noacaba")) {
      estado = "En juego";
    } else if (/aplazado/i.test(tableHtml)) {
      estado = "Aplazado";
    }

    const isLocalDorneda = isDornedaTeam(local.nombre, local.id);
    const isVisitanteDorneda = isDornedaTeam(visitante.nombre, visitante.id);
    const isDornedaMatch = isLocalDorneda || isVisitanteDorneda;

    matches.push({
      jornada: jornadaNum,
      competicionId: compConfig.id,
      competicionNombre: compConfig.nombre,
      local: local.nombre,
      localId: local.id,
      visitante: visitante.nombre,
      visitanteId: visitante.id,
      campo,
      fecha,
      hora,
      gl,
      gv,
      codActa,
      enlaceActa,
      arbitro,
      estado,
      dorneda: isDornedaMatch,
      condicionDorneda: isLocalDorneda ? "Local" : (isVisitanteDorneda ? "Visitante" : "Neutral"),
      rivalDorneda: isLocalDorneda ? visitante.nombre : (isVisitanteDorneda ? local.nombre : "")
    });
  }

  return matches;
}

/**
 * Genera la URL de FUTGAL para una competición y jornada dada
 */
function buildFutgalUrl(compConfig, jornadaNum) {
  return `https://www.futgal.es/pnfg/NPcd/NFG_CmpJornada?cod_primaria=1000120&CodCompeticion=${compConfig.codCompeticion}&CodGrupo=${compConfig.codGrupo}&CodTemporada=${compConfig.codTemporada}&CodJornada=${jornadaNum}&Sch_Codigo_Delegacion=1&codigo_tipo_juego=1`;
}

/**
 * Obtiene la fecha y hora formateada en zona horaria Europe/Madrid
 */
function getMadridFormattedTimestamp() {
  const now = new Date();
  const options = {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  };
  const formatter = new Intl.DateTimeFormat('es-ES', options);
  const parts = formatter.formatToParts(now);
  const map = {};
  parts.forEach(p => map[p.type] = p.value);
  return `${map.day}/${map.month}/${map.year} · ${map.hour}:${map.minute}`;
}

/**
 * Convierte fecha DD/MM/YYYY a ISO YYYY-MM-DD
 */
function parseDateToISO(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return '';
  const parts = dateStr.trim().split('/');
  if (parts.length === 3) {
    const d = parts[0].padStart(2, '0');
    const m = parts[1].padStart(2, '0');
    const y = parts[2];
    return `${y}-${m}-${d}`;
  }
  return '';
}

/**
 * Calcula hora de quedada (90 minutos antes del partido)
 */
function calcHoraQuedada(horaStr) {
  if (!horaStr || !horaStr.includes(':')) return '';
  const [h, m] = horaStr.split(':').map(Number);
  if (isNaN(h) || isNaN(m)) return '';
  const totalM = h * 60 + m - 30;
  if (totalM < 0) return '';
  const qH = Math.floor(totalM / 60).toString().padStart(2, '0');
  const qM = (totalM % 60).toString().padStart(2, '0');
  return `${qH}:${qM}`;
}

/**
 * Realiza la sincronización no destructiva de los datos de FUTGAL con el objeto DB
 */
function mergeFutgalDataIntoDB(currentDB, futgalResults) {
  const db = JSON.parse(JSON.stringify(currentDB));
  
  if (!db.partidos) db.partidos = [];
  if (!db.calendario) db.calendario = [];
  if (!db.todasJornadas) db.todasJornadas = [];
  if (!db.copaJornadas) db.copaJornadas = [];
  if (!db.futgalSync) {
    db.futgalSync = {
      lastSuccess: null,
      lastAttempt: null,
      status: 'pending',
      summary: {},
      logs: []
    };
  }

  const logs = [];
  let partidosActualizados = 0;
  let nuevosPartidos = 0;
  let sinCambios = 0;

  const timestampStr = getMadridFormattedTimestamp();
  db.futgalSync.lastAttempt = timestampStr;

  // Procesar partidos de Liga
  if (futgalResults.liga && futgalResults.liga.length > 0) {
    futgalResults.liga.forEach(matchList => {
      if (!matchList || !matchList.length) return;
      const jNum = matchList[0].jornada;

      // 1. Actualizar db.todasJornadas
      let tj = db.todasJornadas.find(t => t.jornada === jNum);
      if (!tj) {
        tj = {
          jornada: jNum,
          fecha: matchList[0].fecha || '',
          vuelta: jNum > 15 ? 2 : 1,
          partidos: []
        };
        db.todasJornadas.push(tj);
      }
      if (matchList[0].fecha) tj.fecha = matchList[0].fecha;

      // Actualizar partidos de la jornada preservando actaData existente
      tj.partidos = matchList.map(m => {
        const prev = (tj.partidos || []).find(p => p.codActa === m.codActa || (p.local === m.local && p.visitante === m.visitante));
        return {
          local: m.local,
          visitante: m.visitante,
          gl: m.gl !== null && m.gl !== undefined ? m.gl : (prev ? prev.gl : null),
          gv: m.gv !== null && m.gv !== undefined ? m.gv : (prev ? prev.gv : null),
          dorneda: m.dorneda,
          fecha: m.fecha || (prev ? prev.fecha : '') || tj.fecha || '',
          hora: m.hora || (prev ? prev.hora : '') || '',
          campo: m.campo || (prev ? prev.campo : '') || '',
          arbitro: m.arbitro || (prev ? prev.arbitro : '') || '',
          enlaceActa: m.enlaceActa || (prev ? prev.enlaceActa : '') || '',
          codActa: m.codActa || (prev ? prev.codActa : '') || '',
          actaData: m.actaParsed || (prev ? prev.actaData : null) || null,
          estado: m.estado || (prev ? prev.estado : 'Oficial')
        };
      });

      // 2. Localizar partido del Xuventude Dorneda
      const dornedaMatch = matchList.find(m => m.dorneda);
      if (dornedaMatch) {
        const codigoJornada = `J${jNum}`;
        let pObj = db.partidos.find(p => p.codigo === codigoJornada || (p.competicion === 'Primera Futgal' && p.jornada === jNum));

        let hasChanges = false;
        const changeNotes = [];

        if (!pObj) {
          // Crear nuevo registro si no existiera
          const nextId = db.partidos.reduce((max, p) => Math.max(max, p.id || 0), 0) + 1;
          pObj = {
            id: nextId,
            codigo: codigoJornada,
            tipo: 'Oficial',
            competicion: 'Primera Futgal',
            fecha: dornedaMatch.fecha,
            fechaISO: parseDateToISO(dornedaMatch.fecha),
            horaQuedada: dornedaMatch.hora ? calcHoraQuedada(dornedaMatch.hora) : '',
            horaPartido: dornedaMatch.hora,
            rival: dornedaMatch.rivalDorneda,
            condicion: dornedaMatch.condicionDorneda,
            campo: dornedaMatch.campo || (dornedaMatch.condicionDorneda === 'Local' ? 'Campo de Fútbol A Marola' : ''),
            gf: dornedaMatch.condicionDorneda === 'Local' ? dornedaMatch.gl : dornedaMatch.gv,
            gc: dornedaMatch.condicionDorneda === 'Local' ? dornedaMatch.gv : dornedaMatch.gl,
            resultado: '',
            sistema: '',
            equipacionDorneda: 'Blanca / Negro / Blancas',
            equipacionRival: '',
            kataAsistio: true,
            incidencias: '',
            resumen: '',
            observacionesRival: '',
            jugadorDestacado: '',
            enlaceActa: dornedaMatch.enlaceActa,
            codActa: dornedaMatch.codActa,
            convocados: [],
            ausentes: []
          };
          db.partidos.push(pObj);
          nuevosPartidos++;
          hasChanges = true;
          changeNotes.push(`Creado partido Liga ${codigoJornada}`);
        } else {
          // Comparar y actualizar campos oficiales
          if (dornedaMatch.fecha && pObj.fecha !== dornedaMatch.fecha) {
            changeNotes.push(`Fecha: ${pObj.fecha || '--'} → ${dornedaMatch.fecha}`);
            pObj.fecha = dornedaMatch.fecha;
            pObj.fechaISO = parseDateToISO(dornedaMatch.fecha);
            hasChanges = true;
          }

          if (dornedaMatch.hora && pObj.horaPartido !== dornedaMatch.hora) {
            changeNotes.push(`Hora: ${pObj.horaPartido || '--'} → ${dornedaMatch.hora}`);
            pObj.horaPartido = dornedaMatch.hora;
            if (!pObj.horaQuedada || pObj.horaQuedada === '') {
              pObj.horaQuedada = calcHoraQuedada(dornedaMatch.hora);
            }
            hasChanges = true;
          }

          if (dornedaMatch.campo && pObj.campo !== dornedaMatch.campo) {
            pObj.campo = dornedaMatch.campo;
            hasChanges = true;
          }

          if (dornedaMatch.rivalDorneda && (!pObj.rival || pObj.rival !== dornedaMatch.rivalDorneda)) {
            pObj.rival = dornedaMatch.rivalDorneda;
            hasChanges = true;
          }

          if (dornedaMatch.enlaceActa && pObj.enlaceActa !== dornedaMatch.enlaceActa) {
            pObj.enlaceActa = dornedaMatch.enlaceActa;
            pObj.codActa = dornedaMatch.codActa;
            hasChanges = true;
          }

          // Goles y resultado
          const newGf = dornedaMatch.condicionDorneda === 'Local' ? dornedaMatch.gl : dornedaMatch.gv;
          const newGc = dornedaMatch.condicionDorneda === 'Local' ? dornedaMatch.gv : dornedaMatch.gl;

          if (newGf !== null && newGc !== null) {
            if (pObj.gf !== newGf || pObj.gc !== newGc) {
              changeNotes.push(`Resultado: ${pObj.gf !== null ? pObj.gf : '-'}-${pObj.gc !== null ? pObj.gc : '-'} → ${newGf}-${newGc}`);
              pObj.gf = newGf;
              pObj.gc = newGc;
              if (newGf > newGc) pObj.resultado = 'Victoria';
              else if (newGf === newGc) pObj.resultado = 'Empate';
              else pObj.resultado = 'Derrota';
              hasChanges = true;
            }
          }
        }

        if (hasChanges) {
          partidosActualizados++;
          logs.push({
            fecha: timestampStr.split(' · ')[0],
            hora: timestampStr.split(' · ')[1],
            detalle: `Liga ${codigoJornada}: ${changeNotes.join(', ')}`
          });
        } else {
          sinCambios++;
        }

        // 3. Sincronizar db.calendario
        let calItem = db.calendario.find(c => c.codigo === codigoJornada);
        if (calItem) {
          if (pObj.fecha) calItem.fecha = pObj.fecha;
          if (pObj.rival) calItem.rival = pObj.rival;
          if (pObj.condicion) calItem.condicion = pObj.condicion;
          if (pObj.gf !== null && pObj.gc !== null) {
            calItem.estado = 'Jugado';
          }
        }
      }
    });
  }

  // Procesar partidos de Copa
  if (futgalResults.copa && futgalResults.copa.length > 0) {
    futgalResults.copa.forEach((matchList, rIndex) => {
      if (!matchList || !matchList.length) return;
      const rondaNum = rIndex + 1;
      const rondaCodigo = rondaNum === 1 ? 'C_32avos' : (rondaNum === 2 ? 'C_16avos' : (rondaNum === 3 ? 'C_Octavos' : (rondaNum === 4 ? 'C_Cuartos' : (rondaNum === 5 ? 'C_Semis' : 'C_Final'))));
      const rondaNombre = rondaNum === 1 ? '32avos de Final' : (rondaNum === 2 ? '16avos de Final' : (rondaNum === 3 ? 'Octavos de Final' : (rondaNum === 4 ? 'Cuartos de Final' : (rondaNum === 5 ? 'Semifinales' : 'Gran Final'))));

      let cj = db.copaJornadas.find(c => c.ronda === rondaNum || c.codigo === rondaCodigo);
      if (!cj) {
        cj = {
          ronda: rondaNum,
          nombre: rondaNombre,
          codigo: rondaCodigo,
          fecha: matchList[0].fecha || '',
          partidos: []
        };
        db.copaJornadas.push(cj);
      }
      if (matchList[0].fecha) cj.fecha = matchList[0].fecha;

      cj.partidos = matchList.map((m, pIdx) => {
        const prev = (cj.partidos || []).find(p => p.codActa === m.codActa || (p.local === m.local && p.visitante === m.visitante));
        return {
          id: (rondaNum * 100) + pIdx + 1,
          local: m.local,
          visitante: m.visitante,
          gl: m.gl !== null && m.gl !== undefined ? m.gl : (prev ? prev.gl : null),
          gv: m.gv !== null && m.gv !== undefined ? m.gv : (prev ? prev.gv : null),
          fecha: m.fecha || (prev ? prev.fecha : ''),
          hora: m.hora || (prev ? prev.hora : ''),
          campo: m.campo || (prev ? prev.campo : ''),
          arbitro: m.arbitro || (prev ? prev.arbitro : ''),
          dorneda: m.dorneda,
          enlaceActa: m.enlaceActa || (prev ? prev.enlaceActa : ''),
          codActa: m.codActa || (prev ? prev.codActa : '') || '',
          actaData: m.actaParsed || (prev ? prev.actaData : null) || null,
          estado: m.estado || (prev ? prev.estado : 'Oficial')
        };
      });

      // Localizar partido del Xuventude Dorneda en Copa
      const dornedaCopaMatch = matchList.find(m => m.dorneda);
      if (dornedaCopaMatch) {
        let pObj = db.partidos.find(p => p.codigo === rondaCodigo || (p.competicion && p.competicion.toLowerCase().includes('copa') && p.codigo === rondaCodigo));

        let hasChanges = false;
        const changeNotes = [];

        if (!pObj) {
          const nextId = db.partidos.reduce((max, p) => Math.max(max, p.id || 0), 0) + 1;
          pObj = {
            id: nextId,
            codigo: rondaCodigo,
            tipo: 'Oficial',
            competicion: 'Copa Federacion A Coruna',
            fecha: dornedaCopaMatch.fecha,
            fechaISO: parseDateToISO(dornedaCopaMatch.fecha),
            horaQuedada: '',
            horaPartido: dornedaCopaMatch.hora,
            rival: dornedaCopaMatch.rivalDorneda,
            condicion: dornedaCopaMatch.condicionDorneda,
            campo: dornedaCopaMatch.campo,
            gf: dornedaCopaMatch.condicionDorneda === 'Local' ? dornedaCopaMatch.gl : dornedaCopaMatch.gv,
            gc: dornedaCopaMatch.condicionDorneda === 'Local' ? dornedaCopaMatch.gv : dornedaCopaMatch.gl,
            resultado: '',
            sistema: '',
            equipacionDorneda: 'Blanca / Negro / Blancas',
            equipacionRival: '',
            kataAsistio: true,
            incidencias: '',
            resumen: '',
            observacionesRival: '',
            jugadorDestacado: '',
            enlaceActa: dornedaCopaMatch.enlaceActa,
            codActa: dornedaCopaMatch.codActa,
            convocados: [],
            ausentes: []
          };
          db.partidos.push(pObj);
          nuevosPartidos++;
          hasChanges = true;
          changeNotes.push(`Creado partido Copa ${rondaCodigo}`);
        } else {
          if (dornedaCopaMatch.fecha && pObj.fecha !== dornedaCopaMatch.fecha) {
            changeNotes.push(`Fecha: ${pObj.fecha || '--'} → ${dornedaCopaMatch.fecha}`);
            pObj.fecha = dornedaCopaMatch.fecha;
            pObj.fechaISO = parseDateToISO(dornedaCopaMatch.fecha);
            hasChanges = true;
          }

          if (dornedaCopaMatch.hora && pObj.horaPartido !== dornedaCopaMatch.hora) {
            changeNotes.push(`Hora: ${pObj.horaPartido || '--'} → ${dornedaCopaMatch.hora}`);
            pObj.horaPartido = dornedaCopaMatch.hora;
            hasChanges = true;
          }

          if (dornedaCopaMatch.campo && pObj.campo !== dornedaCopaMatch.campo) {
            pObj.campo = dornedaCopaMatch.campo;
            hasChanges = true;
          }

          if (dornedaCopaMatch.rivalDorneda && pObj.rival !== dornedaCopaMatch.rivalDorneda) {
            pObj.rival = dornedaCopaMatch.rivalDorneda;
            hasChanges = true;
          }

          if (dornedaCopaMatch.condicionDorneda && pObj.condicion !== dornedaCopaMatch.condicionDorneda) {
            pObj.condicion = dornedaCopaMatch.condicionDorneda;
            hasChanges = true;
          }

          if (dornedaCopaMatch.enlaceActa && pObj.enlaceActa !== dornedaCopaMatch.enlaceActa) {
            pObj.enlaceActa = dornedaCopaMatch.enlaceActa;
            pObj.codActa = dornedaCopaMatch.codActa;
            hasChanges = true;
          }

          const newGf = dornedaCopaMatch.condicionDorneda === 'Local' ? dornedaCopaMatch.gl : dornedaCopaMatch.gv;
          const newGc = dornedaCopaMatch.condicionDorneda === 'Local' ? dornedaCopaMatch.gv : dornedaCopaMatch.gl;

          if (newGf !== null && newGc !== null) {
            if (pObj.gf !== newGf || pObj.gc !== newGc) {
              changeNotes.push(`Resultado: ${pObj.gf !== null ? pObj.gf : '-'}-${pObj.gc !== null ? pObj.gc : '-'} → ${newGf}-${newGc}`);
              pObj.gf = newGf;
              pObj.gc = newGc;
              if (newGf > newGc) pObj.resultado = 'Victoria';
              else if (newGf === newGc) pObj.resultado = 'Empate';
              else pObj.resultado = 'Derrota';
              hasChanges = true;
            }
          }
        }

        if (hasChanges) {
          partidosActualizados++;
          logs.push({
            fecha: timestampStr.split(' · ')[0],
            hora: timestampStr.split(' · ')[1],
            detalle: `Copa ${rondaCodigo}: ${changeNotes.join(', ')}`
          });
        } else {
          sinCambios++;
        }

        // Sincronizar db.calendario
        let calItem = db.calendario.find(c => c.codigo === rondaCodigo);
        if (calItem) {
          if (pObj.fecha) calItem.fecha = pObj.fecha;
          if (pObj.rival) calItem.rival = pObj.rival;
          if (pObj.condicion) calItem.condicion = pObj.condicion;
          if (pObj.gf !== null && pObj.gc !== null) {
            calItem.estado = 'Jugado';
          }
        }
      }
    });
  }

  // 3. Procesar Clasificación
  if (futgalResults.clasificacion && futgalResults.clasificacion.length > 0) {
    db.clasificacion = futgalResults.clasificacion;
  }

  // 4. Procesar Goleadores (Pichichi) de Liga
  if (futgalResults.ligaGoleadores && futgalResults.ligaGoleadores.length > 0) {
    db.ligaGoleadores = futgalResults.ligaGoleadores;
  }

  // Actualizar metadatos de sincronización
  db.futgalSync.lastSuccess = timestampStr;
  db.futgalSync.status = 'success';
  db.futgalSync.summary = {
    ligaJornadasChecked: futgalResults.liga ? futgalResults.liga.length : 0,
    copaRondasFound: futgalResults.copa ? futgalResults.copa.length : 0,
    partidosActualizados,
    nuevosPartidos,
    sinCambios
  };

  if (logs.length > 0) {
    db.futgalSync.logs = logs.concat(db.futgalSync.logs || []).slice(0, 30);
  }

  return {
    updatedDB: db,
    summary: db.futgalSync.summary,
    logs: logs
  };
}

function parseFutgalClasificacionHtml(html) {
  const result = [];
  if (!html) return result;

  function decodeSpan(spanHtml, fullHtml) {
    if (!spanHtml) return 0;
    const idM = spanHtml.match(/id=["']?([a-zA-Z0-9_-]+)["']?/);
    if (idM) {
      const elemId = idM[1];
      const ntypeM = fullHtml.match(new RegExp(`ntype\\(["']${elemId}["'],\\s*(\\d+),\\s*(\\d+)`, 'i'));
      if (ntypeM) {
        const n = parseInt(ntypeM[1]);
        const i = parseInt(ntypeM[2]);
        const idx = (i * 10) + n;
        if (idx >= 0 && idx < NOVANET_D_ARRAY.length) {
          return NOVANET_D_ARRAY[idx];
        }
      }
      const cssM = fullHtml.match(new RegExp(`#${elemId}[^{]*\\{[^}]*content:\\s*["'](?:\\\\003)?(\\d)["']`, 'i'));
      if (cssM) return parseInt(cssM[1]);
    }
    const clean = spanHtml.replace(/<[^>]*>/g, '').trim();
    const num = parseInt(clean);
    return isNaN(num) ? 0 : num;
  }

  const tableRegex = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  let m;
  while ((m = tableRegex.exec(html)) !== null) {
    if (m[1].includes('NFG_VisCompeticiones_Grupo') || m[1].includes('NFG_VisEquipos')) {
      const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
      let trM;
      let pos = 1;
      while ((trM = trRegex.exec(m[1])) !== null) {
        const row = trM[1];
        if (row.includes('<th') || (!row.includes('NFG_VisCompeticiones_Grupo') && !row.includes('NFG_VisEquipos'))) continue;
        const teamMatch = row.match(/NFG_Vis[^>]*>([^<]+)<\/a>/i);
        if (!teamMatch) continue;
        const equipo = teamMatch[1].trim();
        const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
        const tds = [];
        let tdM;
        while ((tdM = tdRegex.exec(row)) !== null) {
          tds.push(tdM[1]);
        }
        if (tds.length >= 11) {
          const pj = decodeSpan(tds[5], html);
          const g = decodeSpan(tds[6], html);
          const e = decodeSpan(tds[7], html);
          const p = decodeSpan(tds[8], html);
          const gf = decodeSpan(tds[9], html);
          const gc = decodeSpan(tds[10], html);
          const pts = (g * 3) + e;

          result.push({
            pos: pos++,
            equipo,
            pts,
            pj: pj || 1,
            g,
            e,
            p,
            gf,
            gc
          });
        }
      }
      if (result.length > 0) break;
    }
  }
  return result;
}

// Diccionario de correspondencia de nombres federativos oficiales de la RFGF a los alias del Xuventude Dorneda
const DORNEDA_PLAYER_ALIASES = [
  { alias: 'Coté', names: ['aguado pernas, jose l', 'aguado pernas, jose luis', 'aguado, jose', 'cote'] },
  { alias: 'Cata', names: ['garcia dapia, jose ignacio', 'garcia dapia, jose i', 'garcia, jose ignacio', 'cata'] },
  { alias: 'Boliche', names: ['sanchez vieiro, sergio', 'sanchez, sergio', 'boliche'] },
  { alias: 'Nolas', names: ['barrenechea padin, jose', 'barrenechea, jose', 'nolas'] },
  { alias: 'Manu', names: ['blanco canosa, manuel', 'blanco, manuel', 'manu'] },
  { alias: 'Felipe', names: ['lopez granado, felipe', 'lopez, felipe', 'felipe'] },
  { alias: 'Meilan', names: ['meilan fernandez, pablo', 'meilan, pablo', 'meilan'] },
  { alias: 'Carro', names: ['carro canosa, diego', 'carro, diego', 'carro'] },
  { alias: 'Suso', names: ['vazquez varela, jesus', 'vazquez, jesus', 'suso'] },
  { alias: 'David', names: ['diaz lago, david', 'diaz, david', 'david'] },
  { alias: 'Marcos', names: ['otero blanco, marcos', 'otero, marcos', 'marcos'] },
  { alias: 'Nacho', names: ['garcia vazquez, ignacio', 'garcia, ignacio', 'nacho'] },
  { alias: 'Jorge', names: ['castro rodriguez, jorge', 'castro, jorge', 'jorge'] },
  { alias: 'Alberto', names: ['mendez blanco, alberto', 'mendez, alberto', 'alberto'] },
  { alias: 'Fran', names: ['martinez perez, francisco', 'martinez, francisco', 'fran'] },
  { alias: 'Manuly', names: ['santos varela, manuel', 'santos, manuel', 'manuly'] },
  { alias: 'Pena', names: ['rejo gomez, jorge', 'rejo, jorge', 'pena'] },
  { alias: 'Fonato', names: ['vidal gonzalez, alfonso', 'vidal, alfonso', 'fonato'] },
  { alias: 'Brais', names: ['rodriguez vazquez, brais', 'rodriguez, brais', 'brais'] },
  { alias: 'Oscar', names: ['vazquez mallo, oscar', 'vazquez, oscar', 'oscar'] },
  { alias: 'Javi', names: ['suarez fernandez, javier', 'suarez, javier', 'javi'] },
  { alias: 'Borja', names: ['ferreiro varela, borja', 'ferreiro, borja', 'borja'] },
  { alias: 'Casti', names: ['castineiras iglesias, miguel', 'castineiras, miguel', 'casti'] },
  { alias: 'Hugo', names: ['villar fontenla, hugo', 'villar, hugo', 'hugo'] },
  { alias: 'Alfonso', names: ['souto lopez, alfonso', 'souto, alfonso', 'alfonso'] }
];

/**
 * Empareja un nombre federativo oficial con el alias de la plantilla del Dorneda
 */
function matchPlayerNameToDornedaAlias(officialName, currentSquad = []) {
  if (!officialName) return '';
  const normOfficial = normalizeNameStr(officialName);

  // 1. Buscar en diccionario estático de alias conocidos
  for (const item of DORNEDA_PLAYER_ALIASES) {
    if (item.names.some(n => normOfficial.includes(n) || n.includes(normOfficial))) {
      return item.alias;
    }
  }

  // 2. Buscar por coincidencia con la lista actual de jugadores
  if (currentSquad && currentSquad.length > 0) {
    for (const j of currentSquad) {
      const normJ = normalizeNameStr(j.nombre);
      const normOf = normalizeNameStr(j.nombreOficial || '');
      if (normOfficial.includes(normJ) || (normOf && normOfficial.includes(normOf))) {
        return j.nombre;
      }
    }
  }

  // 3. Si no coincide, formatear el nombre original (Nombre + Primer Apellido)
  const parts = officialName.split(',').map(s => s.trim());
  if (parts.length === 2) {
    const firstName = parts[1].split(' ')[0];
    const lastName = parts[0].split(' ')[0];
    return `${firstName} ${lastName}`;
  }
  return officialName.trim();
}

const SPANISH_NAME_DIACRITICS = {
  // Nombres
  "ruben": "Rubén", "ivan": "Iván", "martin": "Martín", "oscar": "Óscar", "adrian": "Adrián",
  "jesus": "Jesús", "angel": "Ángel", "raul": "Raúl", "alvaro": "Álvaro", "inigo": "Íñigo",
  "jose": "José", "ramon": "Ramón", "victor": "Víctor", "hector": "Héctor", "andres": "Andrés",
  "damian": "Damián", "julian": "Julián", "joaquin": "Joaquín", "tomas": "Tomás", "moises": "Moisés",
  "cesar": "César", "felix": "Félix", "german": "Germán", "agustin": "Agustín", "matias": "Matías",
  "xoan": "Xoán", "anxo": "Anxo", "reider": "Reider", "humberto": "Humberto", "elisardo": "Elisardo",
  "senar": "Senar", "yannick": "Yannick", "cote": "Coté", "manu": "Manu", "felipe": "Felipe",
  "cata": "Cata", "nolas": "Nolas", "boliche": "Boliche", "suso": "Suso", "carro": "Carro",
  "nacho": "Nacho", "fran": "Fran", "manuly": "Manuly", "pena": "Pena", "fonato": "Fonato",
  "brais": "Brais", "javi": "Javi", "casti": "Casti", "borja": "Borja", "hugo": "Hugo",

  // Apellidos
  "fernandez": "Fernández", "rodriguez": "Rodríguez", "gonzalez": "González", "perez": "Pérez",
  "gomez": "Gómez", "sanchez": "Sánchez", "lopez": "López", "martinez": "Martínez",
  "alvarez": "Álvarez", "vazquez": "Vázquez", "diaz": "Díaz", "garcia": "García",
  "suarez": "Suárez", "nunez": "Núñez", "nuñez": "Núñez", "gimenez": "Giménez", "gutierrez": "Gutiérrez",
  "dominguez": "Domínguez", "hernandez": "Hernández", "dieguez": "Diéguez", "menendez": "Menéndez",
  "patino": "Patiño", "patiño": "Patiño", "castineiras": "Castiñeiras", "castiñeiras": "Castiñeiras",
  "remuinan": "Remuiñán", "remuiñan": "Remuiñán", "remuiñán": "Remuiñán", "branas": "Brañas",
  "brañas": "Brañas", "fandino": "Fandiño", "fandiño": "Fandiño", "meilan": "Meilán",
  "penas": "Peñas", "valino": "Valiño", "valiño": "Valiño", "marina": "Mariña", "mariña": "Mariña",
  "grana": "Graña", "graña": "Graña", "munoz": "Muñoz", "muñoz": "Muñoz", "bano": "Baño",
  "baño": "Baño", "magan": "Magán", "padin": "Padín", "anon": "Añón", "narahio": "Narahío",
  "sigras": "Sigrás", "naron": "Narón", "rios": "Ríos", "santiso": "Santiso", "aneiros": "Aneiros",
  "dorado": "Dorado", "monteagudo": "Monteagudo", "quiroga": "Quiroga", "barreiro": "Barreiro",
  "souto": "Souto", "pernas": "Pernas", "mallo": "Mallo", "segade": "Segade", "boo": "Boo",
  "pita": "Pita", "lomba": "Lomba", "mata": "Mata", "espido": "Espido", "kumor": "Kumor",
  "otero": "Otero", "mella": "Mella", "vicente": "Vicente", "hortelano": "Hortelano",
  "juncal": "Juncal", "belmonte": "Belmonte", "martell": "Martell", "fiuza": "Fiuza", "amor": "Amor",
  "picado": "Picado", "zas": "Zas", "paredes": "Paredes", "codesal": "Codesal", "crespo": "Crespo",
  "freire": "Freire", "deibe": "Deibe", "ruzo": "Ruzo", "ramos": "Ramos", "castro": "Castro",
  "malca": "Malca", "fasavi": "Fasavi", "mosteiro": "Mosteiro", "dopico": "Dopico", "germade": "Germade",
  "campos": "Campos", "bra": "Bra", "sar": "Sar", "varela": "Varela", "bertoa": "Bertoa",
  "seoane": "Seoane", "puente": "Puente", "longueira": "Longueira", "hermida": "Hermida", "iglesias": "Iglesias"
};

function fixMojibake(str) {
  if (!str) return '';
  return String(str)
    .replace(/Ã¡/g, 'á').replace(/Ã©/g, 'é').replace(/Ã­/g, 'í').replace(/Ã³/g, 'ó').replace(/Ãº/g, 'ú')
    .replace(/Ã /g, 'Á').replace(/Ã‰/g, 'É').replace(/Ã /g, 'Í').replace(/Ã“/g, 'Ó').replace(/Ãš/g, 'Ú')
    .replace(/Ã±/g, 'ñ').replace(/Ã‘/g, 'Ñ')
    .replace(/Â·/g, '·').replace(/Â/g, '')
    .replace(/\bAON\b/g, 'AÑÓN').replace(/\bAon\b/g, 'Añón')
    .replace(/H\.AON/gi, 'H.AÑÓN').replace(/H\.AÑON/gi, 'H.AÑÓN')
    .trim();
}

function formatWordWithAccents(word) {
  if (!word) return '';
  const w = fixMojibake(word);
  if (w.length === 1 && /^[a-zA-Z]$/.test(w)) return w.toUpperCase() + '.';
  if (w.length === 2 && w.endsWith('.')) return w.toUpperCase();

  const lower = w.toLowerCase();
  const unaccented = lower.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  if (SPANISH_NAME_DIACRITICS[unaccented]) {
    return SPANISH_NAME_DIACRITICS[unaccented];
  }
  if (SPANISH_NAME_DIACRITICS[lower]) {
    return SPANISH_NAME_DIACRITICS[lower];
  }

  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
}

function formatOfficialPersonName(rawName) {
  if (!rawName) return '';
  let str = fixMojibake(rawName);

  let prefix = '';
  const numMatch = str.match(/^([#]?\d{1,2}\s+)(.*)$/);
  if (numMatch) {
    prefix = numMatch[1];
    str = numMatch[2];
  }

  if (str.includes(',')) {
    const parts = str.split(',');
    const apellidos = parts[0].trim();
    const nombre = parts.slice(1).join(',').trim();

    const formattedNombre = nombre.split(/\s+/).filter(Boolean).map(formatWordWithAccents).join(' ');
    const formattedApellidos = apellidos.split(/\s+/).filter(Boolean).map(formatWordWithAccents).join(' ');

    const res = `${formattedNombre} ${formattedApellidos}`.trim();
    return (prefix + res).trim();
  } else {
    const words = str.split(/\s+/).filter(Boolean).map(formatWordWithAccents);
    return (prefix + words.join(' ')).trim();
  }
}

function formatCleanTeamName(teamName) {
  if (!teamName) return '';
  let name = fixMojibake(teamName);
  name = name.replace(/AON/gi, 'AÑÓN').replace(/H\.AON/gi, 'H.AÑÓN').replace(/H\.AÑON/gi, 'H.AÑÓN');
  name = name.replace(/SIGRAS/gi, 'SIGRÁS').replace(/NARAHIO/gi, 'NARAHÍO').replace(/NARON/gi, 'NARÓN');
  name = name.replace(/MARTIO/gi, 'MARTIÑO').replace(/VIA/gi, 'VIÑA').replace(/ROS/gi, 'RÍOS');
  return name;
}

function parseFutgalActaHtml(input) {
  if (!input || typeof input !== 'string') return null;
  // 1. Eliminar completamente etiquetas script y style con su contenido interno
  let str = input.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
                 .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
                 .trim();
  if (!str) return null;

  function clean(s) {
    if (!s) return '';
    return s.replace(/&nbsp;/gi, ' ')
            .replace(/&aacute;/gi, 'á').replace(/&Aacute;/gi, 'Á')
            .replace(/&eacute;/gi, 'é').replace(/&Eacute;/gi, 'É')
            .replace(/&iacute;/gi, 'í').replace(/&Iacute;/gi, 'Í')
            .replace(/&oacute;/gi, 'ó').replace(/&Oacute;/gi, 'Ó')
            .replace(/&uacute;/gi, 'ú').replace(/&Uacute;/gi, 'Ú')
            .replace(/&ntilde;/gi, 'ñ').replace(/&Ntilde;/gi, 'Ñ')
            .replace(/eval\(function[\s\S]*?\}\)\);?/gi, '')
            .replace(/ntype\(["'][^"']*["'],\s*\d+,\s*\d+[^)]*\);?/gi, '')
            .replace(/#[a-zA-Z0-9_-]+:[^{]*\{[^}]*\}/gi, '')
            .replace(/\s+/g, ' ').trim();
  }

  let localTeam = '';
  let visitTeam = '';
  let jornada = null;
  let fecha = '';
  let horaPartido = '';
  let arbitro = '';
  let campo = '';
  let ciudad = '';
  let codActa = '';
  let enlaceActa = '';
  
  let localTitulares = [];
  let localSuplentes = [];
  let visitTitulares = [];
  let visitSuplentes = [];

  let localStaff = [];
  let visitStaff = [];

  let localTarjetas = [];
  let visitTarjetas = [];

  let allGoles = [];

  const codActaMatch = str.match(/CodActa=(\d+)|cod_acta=(\d+)|codacta=(\d+)/i);
  if (codActaMatch) {
    codActa = codActaMatch[1] || codActaMatch[2] || codActaMatch[3];
    enlaceActa = `https://www.futgal.es/pnfg/NPcd/NFG_CmpPartido?cod_primaria=1000120&CodActa=${codActa}&cod_acta=${codActa}`;
  }

  const teamLMatch = str.match(/class=["']font_widgetL["'][^>]*>([\s\S]*?)<\//i) || str.match(/class=["']td_widgetL["'][^>]*><div[^>]*>([\s\S]*?)<\/div>/i);
  const teamVMatch = str.match(/class=["']font_widgetV["'][^>]*>([\s\S]*?)<\//i) || str.match(/class=["']td_widgetV["'][^>]*><div[^>]*>([\s\S]*?)<\/div>/i);
  if (teamLMatch) localTeam = formatCleanTeamName(clean(teamLMatch[1].replace(/<[^>]*>/g, '')));
  if (teamVMatch) visitTeam = formatCleanTeamName(clean(teamVMatch[1].replace(/<[^>]*>/g, '')));

  const jMatch = str.match(/Jornada\s*(\d+)/i);
  if (jMatch) jornada = parseInt(jMatch[1], 10);
  const fMatch = str.match(/(\d{2}[-/]\d{2}[-/]\d{4})/);
  if (fMatch) fecha = fMatch[1].replace(/-/g, '/');
  const hMatch = str.match(/(\d{2}:\d{2})\s*h/i) || str.match(/(\d{2}:\d{2})/);
  if (hMatch) horaPartido = hMatch[1];

  const arbMatch = str.match(/<strong>[^<]*rbitro[^<]*<\/strong>&nbsp;&nbsp;&nbsp;([^<]+)/i) || str.match(/&Aacute;rbitro[:\s]*<\/strong>\s*&nbsp;([^<]+)|Árbitro[:\s]*<strong>([^<]+)|&Aacute;rbitro:\s*([^<]+)/i);
  if (arbMatch) arbitro = formatOfficialPersonName(clean(arbMatch[1] || arbMatch[2] || arbMatch[3]));

  const campoMatch = str.match(/NFG_VisCampos[^>]*>([^<]+)<\/a>/i);
  if (campoMatch) campo = clean(campoMatch[1]);

  const ciudadMatch = str.match(/Ciudad:\s*([^<]+)/i);
  if (ciudadMatch) ciudad = clean(ciudadMatch[1]);

  // Helper para parsear filas de jugadores con dorsal y nombre formateado
  function parsePlayerRows(blockHtml) {
    if (!blockHtml) return [];
    const list = [];
    const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let trM;
    while ((trM = trRegex.exec(blockHtml)) !== null) {
      const row = trM[1];
      if (row.includes('<th')) continue;
      const playerM = row.match(/NFG_VisJugador\?cod_primaria=1000121&codigo_jugador=(\d+)[^>]*>([^<]+)<\/a>/i) || row.match(/<td[^>]*class=font_responsive[^>]*>([\s\S]*?)<\/td>/i);
      const id = playerM && playerM[1] && /^\d+$/.test(playerM[1]) ? playerM[1] : null;
      let rawName = playerM ? (playerM[2] || playerM[1]) : row;
      let nombre = clean(rawName.replace(/<[^>]*>/g, ''));

      const dorsalM = row.match(/<td[^>]*align=center[^>]*>\s*(\d{1,2})\s*<\/td>/i) || row.match(/<td[^>]*>\s*(\d{1,2})\s*<\/td>/i) || row.match(/(\d{1,2})\s*<a/i);
      const dorsal = dorsalM ? parseInt(dorsalM[1], 10) : null;
      nombre = nombre.replace(/^\d+\s*/, '').trim();

      if (nombre) {
        list.push({ id, dorsal, nombre: formatOfficialPersonName(nombre) });
      }
    }
    return list;
  }

  // Helper para parsear cuerpo técnico
  function parseStaff(blockHtml) {
    if (!blockHtml) return [];
    const staff = [];
    const tableM = blockHtml.match(/<strong>Cuerpo T[eé]cnico<\/strong><\/h5>\s*<table[^>]*>([\s\S]*?)<\/table>/i);
    if (tableM) {
      const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
      let trM;
      while ((trM = trRegex.exec(tableM[1])) !== null) {
        const row = trM[1];
        if (row.includes('<th')) continue;
        const tds = row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi);
        if (tds && tds.length >= 2) {
          const cargo = clean(tds[0].replace(/<[^>]*>/g, ''));
          const nombre = formatOfficialPersonName(clean(tds[1].replace(/<[^>]*>/g, '')));
          if (nombre) staff.push({ cargo, nombre });
        }
      }
    }
    return staff;
  }

  // Helper para parsear tarjetas
  function parseCards(blockHtml) {
    if (!blockHtml) return [];
    const cards = [];
    const tableM = blockHtml.match(/Tarjetas<\/h4>\s*<table[^>]*>([\s\S]*?)<\/table>/i);
    if (tableM) {
      const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
      let trM;
      while ((trM = trRegex.exec(tableM[1])) !== null) {
        const row = trM[1];
        if (row.includes('<th')) continue;
        const minM = row.match(/\((\d+)[\'’]?\)/) || row.match(/(\d+)[\'’]/);
        const minuto = minM ? parseInt(minM[1], 10) : null;
        const isRed = /tarj_roja|roja|expulsi/i.test(row);
        let textCell = clean(row.replace(/<[^>]*>/g, ' ').replace(/\(\d+[\'’]?\)/g, ''));
        textCell = formatOfficialPersonName(textCell);
        if (textCell) {
          cards.push({
            minuto,
            tipo: isRed ? 'Roja' : 'Amarilla',
            nombre: textCell
          });
        }
      }
    }
    return cards;
  }

  // Dividir el HTML en bloques de local y visitante
  const firstTitIdx = str.indexOf("<strong>Titulares</strong>");
  const secondTitIdx = firstTitIdx !== -1 ? str.indexOf("<strong>Titulares</strong>", firstTitIdx + 20) : -1;

  let localHtml = str;
  let visitHtml = str;

  if (firstTitIdx !== -1 && secondTitIdx > firstTitIdx) {
    const localStart = Math.max(0, firstTitIdx - 200);
    localHtml = str.substring(localStart, secondTitIdx - localStart);
    visitHtml = str.substring(secondTitIdx - 200);
  }

  localTitulares = localHtml.match(/Titulares[\s\S]*?<\/table>/i) ? parsePlayerRows(localHtml.match(/Titulares[\s\S]*?<\/table>/i)[0]) : [];
  localSuplentes = localHtml.match(/Suplentes[\s\S]*?<\/table>/i) ? parsePlayerRows(localHtml.match(/Suplentes[\s\S]*?<\/table>/i)[0]) : [];
  visitTitulares = visitHtml.match(/Titulares[\s\S]*?<\/table>/i) ? parsePlayerRows(visitHtml.match(/Titulares[\s\S]*?<\/table>/i)[0]) : [];
  visitSuplentes = visitHtml.match(/Suplentes[\s\S]*?<\/table>/i) ? parsePlayerRows(visitHtml.match(/Suplentes[\s\S]*?<\/table>/i)[0]) : [];

  localStaff = parseStaff(localHtml);
  visitStaff = parseStaff(visitHtml);

  localTarjetas = parseCards(localHtml);
  visitTarjetas = parseCards(visitHtml);

  // Parsear todos los goles con progresiÃ³n y nombre limpio
  const golesSection = str.match(/<div[^>]*class=["'][^"']*number[^"']*["'][^>]*>Goles<\/div>\s*<div[^>]*class=desc[^>]*>\s*<table[^>]*>([\s\S]*?)<\/table>/i);
  if (golesSection) {
    const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let trM;
    while ((trM = trRegex.exec(golesSection[1])) !== null) {
      let row = trM[1];
      if (row.includes('<th')) continue;
      row = decodeNovanetString(row);
      const minM = row.match(/\((\d+)[\'â€™]?\)/) || row.match(/(\d+)[\'â€™]/);
      const minuto = minM ? parseInt(minM[1], 10) : null;
      const isPenalti = /penalti|\(p\)/i.test(row);
      const isOwnGoal = /propia puerta|\(p\.p\.\)|\(pp\)/i.test(row);
      const scoreProgM = row.match(/(\d+\s*-\s*\d+)/);
      const scoreProgression = scoreProgM ? scoreProgM[1].replace(/\s+/g, ' ') : '';
      let textCell = clean(row.replace(/<[^>]*>/g, ' ').replace(/\(\d+[\'â€™]?\)/g, '').replace(/penalti|\(p\)|\(p\.p\.\)|\(pp\)/gi, '').replace(/\d+\s*-\s*\d+/, ''));
      textCell = textCell.replace(/^[\d\s\-:;]+/, '').trim();
      const rawScorer = formatOfficialPersonName(textCell);
      if (rawScorer) {
        allGoles.push({
          minuto,
          scoreProgression,
          rawScorer,
          penalti: isPenalti,
          propiaPuerta: isOwnGoal,
          tipo: isPenalti ? 'Penalti' : (isOwnGoal ? 'Propia Puerta' : 'Jugada')
        });
      }
    }
  }

  const isLocalDorneda = isDornedaTeam(localTeam);
  const isVisitanteDorneda = isDornedaTeam(visitTeam);

  return {
    localTeam,
    visitTeam,
    jornada,
    fecha,
    horaPartido,
    arbitro,
    campo,
    ciudad,
    codActa,
    enlaceActa,
    isLocalDorneda,
    isVisitanteDorneda,
    localTitulares,
    localSuplentes,
    localStaff,
    localTarjetas,
    visitTitulares,
    visitSuplentes,
    visitStaff,
    visitTarjetas,
    allGoles
  };
}

// Exportar para Node.js o navegador
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    FUTGAL_COMPETITIONS,
    DORNEDA_INFO,
    NOVANET_D_ARRAY,
    DORNEDA_PLAYER_ALIASES,
    normalizeNameStr,
    isDornedaTeam,
    matchPlayerNameToDornedaAlias,
    decodeFutgalScoreSpan,
    parseFutgalJornadaHtml,
    parseFutgalClasificacionHtml,
    parseFutgalActaHtml,
    buildFutgalUrl,
    getMadridFormattedTimestamp,
    parseDateToISO,
    calcHoraQuedada,
    mergeFutgalDataIntoDB
  };
}


