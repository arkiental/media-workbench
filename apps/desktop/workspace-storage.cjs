'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');

function desktopStorage(directory) {
  const fileFor=key=>{if(typeof key!=='string'||!/^mw:(draft:|last:|export:|theme$)/.test(key)||key.length>1000)throw Error('Unsupported workspace key');return path.join(directory,crypto.createHash('sha256').update(key).digest('hex')+'.json');};
  const get=key=>{try{return fs.readFileSync(fileFor(key),'utf8');}catch(error){if(error.code==='ENOENT')return null;throw error;}};
  return {get,set(key,value,expected){
    if(typeof value!=='string'||Buffer.byteLength(value)>16*1024*1024)throw Error('Workspace draft is too large');
    const file=fileFor(key),current=get(key);
    if(current!==expected)throw Error('A newer workspace draft exists. Reopen this source before saving further edits.');
    fs.mkdirSync(directory,{recursive:true});
    const temporary=file+'.'+crypto.randomUUID()+'.tmp';
    try{fs.writeFileSync(temporary,value,{flag:'wx',flush:true});fs.renameSync(temporary,file);}finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
  }};
}
module.exports={desktopStorage};
