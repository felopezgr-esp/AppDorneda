const fs=require('fs');
const path=require('path');
const actual='competicion.json';
const previo=path.resolve(__dirname,'../../competicion.json');
if(!fs.existsSync(actual)) process.exit(1);
const n=JSON.parse(fs.readFileSync(actual,'utf8'));
if(fs.existsSync(previo)){
  const a=JSON.parse(fs.readFileSync(previo,'utf8'));
  if(a.fuenteClasificacionOficial==='FUTGAL' && Array.isArray(a.clasificacionOficial) && a.clasificacionOficial.length===16){
    n.clasificacionOficial=a.clasificacionOficial;
    n.fechaClasificacionOficial=a.fechaClasificacionOficial||null;
    n.fuenteClasificacionOficial='FUTGAL';
    fs.writeFileSync(actual,JSON.stringify(n,null,2)+'\n','utf8');
    console.log('Clasificación oficial preservada durante la súper rápida.');
  }
}
