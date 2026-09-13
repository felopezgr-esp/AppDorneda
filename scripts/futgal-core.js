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
function decodeFutgalScoreSpan(spanHtml, tableHtml) {
  if (!spanHtml) return null;

  // Extraer todos los IDs presentes en el span
  const idRegex = /id=["']?([a-zA-Z0-9_-]+)["']?/g;
  let match;
  let digits = "";

  while ((match = idRegex.exec(spanHtml)) !== null) {
    const elemId = match[1];

    // 1. Llamada a la función JS ntype("id", n, i, ...)
    const ntypeRegex = new RegExp(`ntype\\(["']${elemId}["'],\\s*(\\d+),\\s*(\\d+)`, 'i');
    const ntypeMatch = tableHtml.match(ntypeRegex);
    if (ntypeMatch) {
      const n = parseInt(ntypeMatch[1], 10);
      const i = parseInt(ntypeMatch[2], 10);
      const idx = (i * 10) + n;
      if (idx >= 0 && idx < NOVANET_D_ARRAY.length) {
        digits += String(NOVANET_D_ARRAY[idx]);
        continue;
      }
    }

    // 2. Estilos CSS pseudo-elementos #id:before o #id:after con content:"\003X" o content:"X"
    const cssRegex = new RegExp(`#${elemId}[^{]*\\{[^}]*content:\\s*["'](?:\\\\003)?(\\d)["']`, 'i');
    const cssMatch = tableHtml.match(cssRegex);
    if (cssMatch) {
      digits += String(cssMatch[1]);
      continue;
    }

    // 3. Texto inline dentro del elemento si no está oculto
    const inlineRegex = new RegExp(`<span\\s+id=["']?${elemId}["']?>(\\d+)<`, 'i');
    const inlineMatch = spanHtml.match(inlineRegex);
    if (inlineMatch) {
      digits += String(inlineMatch[1]);
      continue;
    }
  }

  // 4. Si no hubo IDs o es un valor directo <i class=fa-solid>DIGIT</i>
  if (digits === "") {
    const directMatch = spanHtml.match(/<i\s+class=["']?fa-solid["']?>(\d+)<\/i>/i);
    if (directMatch) {
      digits = directMatch[1];
    }
  }

  if (digits !== "") {
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

      // Actualizar partidos de la jornada
      tj.partidos = matchList.map(m => ({
        local: m.local,
        visitante: m.visitante,
        gl: m.gl,
        gv: m.gv,
        dorneda: m.dorneda,
        fecha: m.fecha || tj.fecha || '',
        hora: m.hora || '',
        campo: m.campo || '',
        enlaceActa: m.enlaceActa || '',
        estado: m.estado || 'Oficial'
      }));

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

      cj.partidos = matchList.map((m, pIdx) => ({
        id: (rondaNum * 100) + pIdx + 1,
        local: m.local,
        visitante: m.visitante,
        gl: m.gl,
        gv: m.gv,
        fecha: m.fecha,
        hora: m.hora,
        campo: m.campo,
        dorneda: m.dorneda,
        enlaceActa: m.enlaceActa,
        estado: m.estado
      }));

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
  // 3. Procesar Clasificación
  if (futgalResults.clasificacion && futgalResults.clasificacion.length > 0) {
    db.clasificacion = futgalResults.clasificacion;
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

function parseFutgalActaHtml(input) {
  if (!input || typeof input !== 'string') return null;
  const str = input.trim();
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
            .replace(/\s+/g, ' ').trim();
  }

  let localTeam = '';
  let visitTeam = '';
  let competition = '';
  let jornada = null;
  let fecha = '';
  let horaPartido = '';
  let arbitro = '';
  let campo = '';
  let ciudad = '';
  let codActa = '';
  let enlaceActa = '';
  
  let dornedaTitulares = [];
  let dornedaSuplentes = [];
  let dornedaTarjetas = [];
  let dornedaStaff = [];
  
  let rivalTitulares = [];
  let rivalSuplentes = [];
  let rivalTarjetas = [];
  let rivalStaff = [];

  let allGoles = [];

  const codActaMatch = str.match(/CodActa=(\d+)|cod_acta=(\d+)|codacta=(\d+)/i);
  if (codActaMatch) {
    codActa = codActaMatch[1] || codActaMatch[2] || codActaMatch[3];
    enlaceActa = `https://www.futgal.es/pnfg/NPcd/NFG_CmpPartido?cod_primaria=1000120&CodActa=${codActa}&cod_acta=${codActa}`;
  }

  const teamLMatch = str.match(/class=["']font_widgetL["'][^>]*>([\s\S]*?)<\//i);
  const teamVMatch = str.match(/class=["']font_widgetV["'][^>]*>([\s\S]*?)<\//i);
  if (teamLMatch) localTeam = clean(teamLMatch[1].replace(/<[^>]*>/g, ''));
  if (teamVMatch) visitTeam = clean(teamVMatch[1].replace(/<[^>]*>/g, ''));

  const jMatch = str.match(/Jornada\s*(\d+)/i);
  if (jMatch) jornada = parseInt(jMatch[1]);
  const fMatch = str.match(/(\d{2}[-/]\d{2}[-/]\d{4})/);
  if (fMatch) fecha = fMatch[1].replace(/-/g, '/');
  const hMatch = str.match(/(\d{2}:\d{2})\s*h/i) || str.match(/(\d{2}:\d{2})/);
  if (hMatch) horaPartido = hMatch[1];

  const arbMatch = str.match(/&Aacute;rbitro[:\s]*<\/strong>\s*&nbsp;([^<]+)|Árbitro[:\s]*<strong>([^<]+)/i);
  if (arbMatch) arbitro = clean(arbMatch[1] || arbMatch[2]);

  const campoMatch = str.match(/NFG_VisCampos[^>]*>([^<]+)<\/a>/i);
  if (campoMatch) campo = clean(campoMatch[1]);

  const ciudadMatch = str.match(/Ciudad:\s*([^<]+)/i);
  if (ciudadMatch) ciudad = clean(ciudadMatch[1]);

  // Extract goals
  const golBlockMatch = str.match(/<div[^>]*class=["'][^"']*dashboard-stat[^"']*["'][^>]*>[\s\S]*?Goles[\s\S]*?<\/table>/i);
  if (golBlockMatch) {
    const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let trM;
    while ((trM = trRegex.exec(golBlockMatch[0])) !== null) {
      const row = trM[1];
      const minM = row.match(/\((\d+)[\'’]?\)/);
      const minuto = minM ? parseInt(minM[1]) : null;
      const textCell = row.replace(/<[^>]*>/g, ' ').replace(/\(\d+[\'’]?\)/, '');
      const rawScorer = clean(textCell);
      if (minuto || rawScorer) {
        allGoles.push({ minuto, rawScorer, tipo: 'Jugada' });
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
    allGoles
  };
}

// Exportar para Node.js o navegador
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    FUTGAL_COMPETITIONS,
    DORNEDA_INFO,
    NOVANET_D_ARRAY,
    normalizeNameStr,
    isDornedaTeam,
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

