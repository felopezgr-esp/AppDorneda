const { chromium } = require('playwright');
const fs = require('fs');

const EN_CI = process.env.GITHUB_ACTIONS === 'true' || process.env.CI === 'true';
const URL_J1 =
  'https://www.futgal.es/pnfg/NPcd/NFG_CmpJornada?' +
  'cod_primaria=1000120&CodCompeticion=26991153&CodGrupo=28251751&CodTemporada=22' +
  '&cod_agrupacion=1&CodJornada=1&Sch_Codigo_Delegacion=1&Sch_Tipo_Juego=1';

function clean(s){ return String(s||'').replace(/\s+/g,' ').trim(); }
function norm(s){ return clean(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase()
  .replace(/\./g,'').replace(/[^A-Z0-9Ñ]+/g,' ').replace(/\s+/g,' ').trim(); }
function n(v){ const m=clean(v).replace(',','.').match(/-?\d+(?:\.\d+)?/); return m?Number(m[0]):null; }
function read(p){ return JSON.parse(fs.readFileSync(p,'utf8')); }
function write(p,v){ fs.writeFileSync(p,JSON.stringify(v,null,2)+'\n','utf8'); }

function equipos(c){
  const m=new Map();
  for(const j of c.jornadas||[]) for(const p of j.partidos||[])
    for(const x of [p.local,p.visitante]){
      const k=norm(x);
      if(k && !/^ULTIMA ACTUALIZACION\b/.test(k) && !m.has(k)) m.set(k,clean(x));
    }
  return [...m.values()];
}

function calculados(c){
  const out=new Map();
  function e(name){
    const k=norm(name);
    if(!out.has(k)) out.set(k,{pts:0,pj:0,g:0,e:0,p:0,gf:0,gc:0});
    return out.get(k);
  }
  for(const j of c.jornadas||[]) for(const p of j.partidos||[]){
    if(!p.resultado) continue;
    const gl=Number(p.resultado.local), gv=Number(p.resultado.visitante);
    if(!Number.isFinite(gl)||!Number.isFinite(gv)) continue;
    const a=e(p.local), b=e(p.visitante);
    a.pj++; b.pj++; a.gf+=gl; a.gc+=gv; b.gf+=gv; b.gc+=gl;
    if(gl>gv){a.g++;b.p++;a.pts+=3;} else if(gv>gl){b.g++;a.p++;b.pts+=3;}
    else {a.e++;b.e++;a.pts++;b.pts++;}
  }
  return out;
}

async function abrir(page,eqs,jornada){
  const urlJornada = URL_J1.replace(/CodJornada=1\b/, 'CodJornada=' + jornada);
  await page.goto(urlJornada,{waitUntil:'domcontentloaded',timeout:15000});
  await page.waitForTimeout(500);

  const els=page.locator('a,button,[role="button"]');
  for(let i=0;i<await els.count();i++){
    const el=els.nth(i);
    if(!await el.isVisible().catch(()=>false)) continue;
    const meta=clean([
      await el.innerText().catch(()=>''),
      await el.getAttribute('title').catch(()=>null),
      await el.getAttribute('aria-label').catch(()=>null)
    ].filter(Boolean).join(' '));
    if(!/clasificaci[oó]n/i.test(meta)) continue;
    try{
      const href=await el.getAttribute('href').catch(()=>null);
      if(href && href!=='#' && !/^javascript:/i.test(href))
        await page.goto(new URL(href,page.url()).href,{waitUntil:'domcontentloaded',timeout:15000});
      else await el.click({timeout:5000});
      await page.waitForTimeout(500);
      const body=norm(await page.locator('body').innerText().catch(()=>''));
      if(eqs.filter(x=>body.includes(norm(x))).length>=14) return;
    }catch{}
  }

  for(const prim of ['1000110','1000120']){
    const u='https://www.futgal.es/pnfg/NPcd/NFG_VisClasificacion?cod_primaria='+prim+
      '&CodCompeticion=26991153&CodGrupo=28251751&CodTemporada=22&cod_agrupacion=1'+
      '&Sch_Codigo_Delegacion=1&Sch_Tipo_Juego=1&CodJornada='+jornada;
    try{
      await page.goto(u,{waitUntil:'domcontentloaded',timeout:15000});
      await page.waitForTimeout(500);
      const body=norm(await page.locator('body').innerText().catch(()=>''));
      if(eqs.filter(x=>body.includes(norm(x))).length>=14) return;
    }catch{}
  }
  throw new Error('No pude abrir la clasificación oficial FUTGAL.');
}

async function filas(page){
  return page.evaluate(()=>{
    const c=s=>String(s||'').replace(/\s+/g,' ').trim();
    return [...document.querySelectorAll('tr')].map(tr=>
      [...tr.querySelectorAll(':scope > th,:scope > td')].map(td=>c(td.innerText||td.textContent||''))
    ).filter(r=>r.filter(Boolean).length>=2);
  });
}

function matchEquipo(cells,eqs){
  for(let i=0;i<cells.length;i++){
    const k=norm(cells[i]);
    for(const e of eqs) if(k===norm(e)) return {equipo:e,indice:i};
  }
  for(let i=0;i<cells.length;i++){
    const k=norm(cells[i]);
    for(const e of eqs){
      const ek=norm(e);
      if((k.includes(ek)||ek.includes(k)) && Math.min(k.length,ek.length)>=6) return {equipo:e,indice:i};
    }
  }
  return null;
}

function detectarPts(rows,calc){
  const max=Math.max(...rows.map(r=>r.cells.length));
  const cand=[];

  for(let col=0;col<max;col++){
    let valid=0, err=0, errN=0, team=false;
    const vals=[];

    for(const r of rows){
      if(r.hit.indice===col){ team=true; break; }
      const v=n(r.cells[col]);
      if(v==null) continue;

      valid++;
      vals.push(v);

      const cc=calc.get(norm(r.hit.equipo));
      if(cc && Number.isFinite(Number(cc.pts))){
        err += Math.abs(v-Number(cc.pts));
        errN++;
      }
    }

    if(team || valid<14 || errN<14) continue;

    const parecePosicion =
      vals.length===16 &&
      vals.every((v,i)=>Number.isInteger(v) && v===i+1);

    if(parecePosicion) continue;

    const avgErr=err/errN;
    const maxVal=Math.max(...vals);
    const minVal=Math.min(...vals);

    if(minVal < -20 || maxVal > 60) continue;
    if(maxVal < 10) continue;
    if(!vals.every(Number.isInteger)) continue;

    cand.push({col,avgErr,maxVal,minVal});
  }

  cand.sort((a,b)=>a.avgErr-b.avgErr);

  if(!cand.length){
    console.error('No hay columnas candidatas. Filas detectadas:');
    rows.forEach(r=>console.error(JSON.stringify(r.cells)));
    return null;
  }

  if(cand[0].avgErr > 5){
    throw new Error(
      'La mejor columna de puntos sigue siendo poco fiable. Error medio: ' +
      cand[0].avgErr.toFixed(3)
    );
  }

  console.log(
    'Columna de puntos detectada:',
    cand[0].col,
    'error medio:',
    cand[0].avgErr.toFixed(3)
  );

  return cand[0].col;
}

(async()=>{
  const comp=read('competicion.json');
  const eqs=equipos(comp);
  if(eqs.length!==16) throw new Error(`Calendario: ${eqs.length}/16 equipos.`);
  const calc=calculados(comp);

  const objetivoRapido =
    comp.modoActualizacion === 'fast' &&
    Array.isArray(comp.jornadasObjetivoRapido) &&
    comp.jornadasObjetivoRapido.length === 1 &&
    Number.isInteger(Number(comp.jornadasObjetivoRapido[0]))
      ? Number(comp.jornadasObjetivoRapido[0])
      : null;

  const jornadasConResultados = (comp.jornadas || [])
    .filter(j => (j.partidos || []).some(p =>
      p.resultado &&
      Number.isFinite(Number(p.resultado.local)) &&
      Number.isFinite(Number(p.resultado.visitante))
    ))
    .map(j => Number(j.numero))
    .filter(Number.isFinite);

  const jornadaClasificacion = objetivoRapido ||
    (jornadasConResultados.length
      ? Math.max(...jornadasConResultados)
      : 1);

  console.log('Clasificación oficial solicitada para jornada:', jornadaClasificacion);

  const browser=await chromium.launch(
    EN_CI
      ? {channel:'chrome',headless:true}
      : {channel:'chrome',headless:false}
  );

  const page=await (await browser.newContext({
    locale:'es-ES',
    timezoneId:'Europe/Madrid'
  })).newPage();

  try{
    await abrir(page,eqs,jornadaClasificacion);
    const raw=await filas(page);
    const rows=[],seen=new Set();

    for(const cells of raw){
      const hit=matchEquipo(cells,eqs);
      if(!hit) continue;
      const k=norm(hit.equipo);
      if(seen.has(k)) continue;
      seen.add(k);
      rows.push({cells,hit});
    }

    if(rows.length!==16) throw new Error(`Clasificación: ${rows.length}/16 equipos detectados.`);

    const ptsCol=detectarPts(rows,calc);
    if(ptsCol==null) throw new Error('No pude identificar la columna de puntos oficiales.');

    const clasif=rows.map((r,i)=>{
      const c=calc.get(norm(r.hit.equipo))||{};
      const pts=n(r.cells[ptsCol]);
      if(pts==null) throw new Error('Puntos no legibles para '+r.hit.equipo);

      return {
        pos:i+1,equipo:r.hit.equipo,pts,
        pj:c.pj||0,g:c.g||0,e:c.e||0,p:c.p||0,gf:c.gf||0,gc:c.gc||0,
        dg:(c.gf||0)-(c.gc||0),puntosCalculados:c.pts||0,
        ajustePuntos:pts-(c.pts||0),fuente:'FUTGAL_OFICIAL'
      };
    });

    const liceo=clasif.find(x=>norm(x.equipo)===norm('LICEO DE MONELOS S.D.'));
    console.log('Liceo de Monelos:',liceo?`${liceo.pts} pts (ajuste ${liceo.ajustePuntos})`:'no detectado');

    comp.clasificacionOficial=clasif;
    comp.fechaClasificacionOficial=new Date().toISOString();
    comp.fuenteClasificacionOficial='FUTGAL';

    write('competicion.json',comp);
    write('clasificacion-oficial.json',{
      fechaExtraccion:comp.fechaClasificacionOficial,
      fuente:'FUTGAL',
      jornada:jornadaClasificacion,
      filas:clasif
    });

    console.log('Clasificación oficial FUTGAL: 16/16 OK');
  }catch(e){
    try{await page.screenshot({path:'error-clasificacion.png',fullPage:true});}catch{}
    throw e;
  }finally{
    await browser.close();
  }
})().catch(e=>{
  console.error(e.stack||e.message);
  process.exit(1);
});
