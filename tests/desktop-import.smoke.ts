import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {_electron as electron} from 'playwright';

await mkdir('test-output/native',{recursive:true});const root=await mkdtemp(path.resolve('test-output/native/import-')),folder=path.join(root,'Downloads');await mkdir(folder);
const env=Object.fromEntries(Object.entries({...process.env,MW_DATA_DIR:path.join(root,'service')}).filter((pair):pair is [string,string]=>pair[1]!==undefined));delete env.ELECTRON_RUN_AS_NODE;
const desktop=await electron.launch({args:['apps/desktop/main.cjs',`--user-data-dir=${path.join(root,'profile')}`],env,timeout:70000});
try{
 const page=await desktop.firstWindow();await page.getByRole('banner').getByRole('button',{name:'Import',exact:true}).click();await page.getByRole('button',{name:'From a link',exact:true}).click();
 await desktop.evaluate('globalThis.__name = fn => fn');
 await desktop.evaluate(({Menu,dialog},folder)=>{
  dialog.showOpenDialog=async()=>({canceled:false,filePaths:[folder]});
  const original=Menu.buildFromTemplate;Menu.buildFromTemplate=function(template){(globalThis as any).contextRoles=template.map(item=>item.role).filter(Boolean);const menu=original.call(Menu,template);menu.popup=()=>{};return menu;};
 },folder);
 await page.getByLabel('Video or audio links',{exact:true}).click({button:'right'});
 for(let i=0;i<20;i++){if(await desktop.evaluate('Boolean(globalThis.contextRoles)'))break;await new Promise(r=>setTimeout(r,100));}
 const roles=await desktop.evaluate('globalThis.contextRoles') as string[];assert(roles.includes('paste'));assert(roles.includes('copy'));assert(roles.includes('selectAll'));
 const selected=await page.evaluate(()=>window.mediaWorkbench!.chooseDownloadFolder!());assert.equal(selected!.label,folder);assert.match(selected!.id,/^[0-9a-f-]{36}$/);
 await writeFile(path.join(root,'evidence.json'),JSON.stringify({passed:true,contextMenuRoles:roles,pairedFolderSelection:true,nativeDialog:'Stubbed OS selection; real preload, IPC, pairing and server registration exercised'},null,2));console.log(JSON.stringify({passed:true,contextMenuRoles:roles,pairedFolderSelection:true}));
}finally{await desktop.close();}
