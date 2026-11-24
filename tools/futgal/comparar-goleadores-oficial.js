const { chromium } = require('playwright');
const fs = require('fs');

const EN_CI = process.env.GITHUB_ACTIONS === 'true' || process.env.CI === 'true';
const URL =
  'https://www.futgal.es/pnfg/NPcd/NFG_CmpJornada?' +
  'cod_primaria=1000120&CodCompeticion=26991153&CodGrupo=28251751' +
  '&CodTemporada=22&cod_agrupacion=1&CodJornada=11' +
  '&Sch_Codigo_Delegacion=1&Sch_Tipo_Juego=1';

const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
const norm = s => clean(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'')
  .toUpperCase().replace(/[’']/g,'').replace(/[^A-Z0-9Ñ ]+/g,' ')
  .replace(/\s+/g,' ').trim();

const load = p => JSON.parse(fs.readFileSync(p,'utf8'));
const save = (p,o) => fs.writeFileSync(p,JSON.stringify(o,null,2)+'\n','utf8');

function hasPlayer(team,name){
  const k=norm(name);
  return [...(team?.titulares||[]),...(team?.suplentes||[])]
    .some(x=>norm(x?.jugador)===k);
}

function tablaActas(comp){
  const m=new Map();
  for(const j of comp.jornadas||[]) for(const p of j.partidos||[]){
    const a=p?.acta;
    if(!a?.goles) continue;
    for(const g of a.goles){
      const jugador=clean(g?.jugador);
      if(!jugador) continue;
      const k=norm(jugador);
      let equipo='';
      if(hasPlayer(a.equipo_local,jugador)) equipo=clean(p.local);
      else if(hasPlayer(a.equipo_visitante,jugador)) equipo=clean(p.visitante);
      if(!m.has(k)) m.set(k,{jugador,equipo,goles:0});
      const r=m.get(k); r.goles++; if(!r.equipo&&equipo) r.equipo=equipo;
    }
  }
  return [...m.values()].sort((a,b)=>b.goles-a.goles||a.jugador.localeCompare(b.jugador,'es'));
}

async function abrirGoleadores(page){
  await page.goto(URL,{waitUntil:'domcontentloaded',timeout:60000});
  await page.waitForTimeout(1200);

  const els=page.locator('a,button,input[type="button"],input[type="submit"],[role="button"]');
  const meta=await els.evaluateAll(nodes=>nodes.map((el,index)=>({
    index,
    textos:[
      el.innerText||'',el.textContent||'',el.getAttribute('value')||'',
      el.getAttribute('title')||'',el.getAttribute('aria-label')||'',
      el.querySelector('img')?.getAttribute('alt')||'',
      el.querySelector('img')?.getAttribute('title')||''
    ].map(x=>(x||'').replace(/\s+/g,' ').trim()).filter(Boolean),
    href:el.getAttribute('href')||''
  })));

  const c=meta.find(x=>x.textos.some(t=>/^goleadores$/i.test(t)));
  if(!c) throw new Error('No encontré el control Goleadores en FUTGAL.');

  if(c.href && c.href!=='#' && !/^javascript:/i.test(c.href)){
    await page.goto(new URL(c.href,page.url()).href,{waitUntil:'domcontentloaded',timeout:60000});
  }else{
    await els.nth(c.index).click({force:true,timeout:10000});
  }
  await page.waitForTimeout(1500);
}

async function extraer(page){
  const tables=await page.locator('table').evaluateAll(ts=>ts.map(t=>[...t.querySelectorAll('tr')].map(tr=>
    [...tr.querySelectorAll('th,td')].map(td=>(td.innerText||td.textContent||'').replace(/\s+/g,' ').trim())
  )));

  for(const rows of tables){
    let hi=-1,h=[];
    for(let i=0;i<Math.min(rows.length,8);i++){
      const x=rows[i].map(v=>v.toLowerCase());
      if(x.some(v=>/jugador|xogador|nombre|nome/.test(v)) &&
         x.some(v=>/goles|gols|^gol$/.test(v))){ hi=i; h=x; break; }
    }
    if(hi<0) continue;
    const ij=h.findIndex(v=>/jugador|xogador|nombre|nome/.test(v));
    const ie=h.findIndex(v=>/equipo|club|team/.test(v));
    const ig=h.findIndex(v=>/goles|gols|^gol$/.test(v));
    if(ij<0||ig<0) continue;

    const out=[];
    for(const c of rows.slice(hi+1)){
      const jugador=clean(c[ij]), raw=clean(c[ig]);
      const mm=raw.match(/\d+/);
      if(jugador&&mm) out.push({jugador,equipo:ie>=0?clean(c[ie]):'',goles:Number(mm[0])});
    }
    if(out.length>=3) return out;
  }
  throw new Error('No pude reconocer la tabla oficial de goleadores de FUTGAL.');
}

function comparar(oficial,actas){
  const mo=new Map(oficial.map(x=>[norm(x.jugador),x]));
  const ma=new Map(actas.map(x=>[norm(x.jugador),x]));
  const keys=[...new Set([...mo.keys(),...ma.keys()])];

  const filas=keys.map(k=>{
    const o=mo.get(k),a=ma.get(k);
    const gf=o?Number(o.goles):0, ga=a?Number(a.goles):0;
    return {
      jugador:clean(o?.jugador||a?.jugador),
      equipoFutgal:clean(o?.equipo),
      equipoActas:clean(a?.equipo),
      golesFutgal:gf,golesActas:ga,diferencia:gf-ga,
      coincide:!!o&&!!a&&gf===ga,soloFutgal:!!o&&!a,soloActas:!!a&&!o
    };
  }).sort((a,b)=>Math.max(b.golesFutgal,b.golesActas)-Math.max(a.golesFutgal,a.golesActas)
    ||a.jugador.localeCompare(b.jugador,'es'));

  return {
    totalFutgal:oficial.length,totalActas:actas.length,
    coincidencias:filas.filter(x=>x.coincide).length,
    diferencias:filas.filter(x=>!x.coincide).length,
    filas,detalleDiferencias:filas.filter(x=>!x.coincide)
  };
}

(async()=>{
  let browser;
  try{
    const comp=load('competicion.json');
    const actas=tablaActas(comp);

    browser=await chromium.launch({headless:true});
    const page=await browser.newPage({viewport:{width:1440,height:1000}});
    await abrirGoleadores(page);
    const oficial=await extraer(page);

    save('goleadores-oficial.json',{
      fecha:new Date().toISOString(),fuente:'FUTGAL',
      competicion:comp.competicion,grupo:comp.grupo,url:page.url(),
      total:oficial.length,goleadores:oficial
    });

    const c={fecha:new Date().toISOString(),fuenteOficial:'FUTGAL',
      fuenteLocal:'ACTAS_FUTGAL',...comparar(oficial,actas)};
    save('comparacion-goleadores.json',c);

    console.log('==========================================');
    console.log(' COMPARACIÓN GOLEADORES FUTGAL');
    console.log(` FUTGAL: ${c.totalFutgal}`);
    console.log(` Actas: ${c.totalActas}`);
    console.log(` Coincidencias: ${c.coincidencias}`);
    console.log(` Diferencias: ${c.diferencias}`);
    console.log('==========================================');

    for(const d of c.detalleDiferencias.slice(0,50))
      console.log(` - ${d.jugador}: FUTGAL ${d.golesFutgal} | ACTAS ${d.golesActas} | DIF ${d.diferencia>=0?'+':''}${d.diferencia}`);

    if(c.diferencias) console.log('AVISO: diferencias registradas; no bloquean la auditoría.');
    else console.log('GOLEADORES FUTGAL: 100% COINCIDENTES');

  }catch(err){
    console.error('ERROR COMPARANDO GOLEADORES FUTGAL');
    console.error(err.stack||err.message||err);
    save('comparacion-goleadores.json',{
      fecha:new Date().toISOString(),fuenteOficial:'FUTGAL',
      fuenteLocal:'ACTAS_FUTGAL',ok:false,error:String(err?.message||err)
    });
    console.error('AVISO: la auditoría continuará sin bloquearse.');
    process.exitCode=0;
  }finally{
    if(browser) await browser.close();
  }
})();
