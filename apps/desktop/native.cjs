'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

function validateId(id) { if(typeof id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('Expected an opaque artifact or action ID.'); return id; }
function runProcess(executable,args,{input,timeoutMs=30000,maxOutputBytes=1024*1024}={}) {
  return new Promise((resolve,reject)=> {
    const child=spawn(executable,args,{shell:false,windowsHide:true,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});
    let out='',err='',total=0,settled=false;
    const terminate=()=>{if(process.platform==='win32'&&child.pid)spawn(path.join(process.env.SystemRoot||'C:\\Windows','System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{shell:false,windowsHide:true,stdio:'ignore'});else if(child.pid){try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}}};
    const fail=error=>{if(settled)return;settled=true;clearTimeout(timer);terminate();reject(error);};
    const timer=setTimeout(()=>fail(new Error('Native action exceeded its time limit.')),timeoutMs);
    child.on('error',fail);
    child.stdout.on('data',data=>{total+=data.length;if(total>maxOutputBytes)fail(new Error('Native action exceeded its output limit.'));else out+=data.toString();});
    child.stderr.on('data',data=>{total+=data.length;if(total>maxOutputBytes)fail(new Error('Native action exceeded its output limit.'));else err+=data.toString();});
    child.on('close',code=>{clearTimeout(timer);if(settled)return;settled=true;if(code===0)resolve({stdout:out,stderr:err,code});else reject(new Error(`Native action failed with exit ${code}. ${err.slice(-1500)}`));});
    child.stdin.on('error',()=>{});child.stdin.end(input||'');
  });
}
async function managedFile(filePath) {
  if(typeof filePath!=='string'||!path.isAbsolute(filePath))throw new Error('Bridge returned an invalid local path.');
  const stat=await fs.lstat(filePath); if(!stat.isFile()||stat.isSymbolicLink())throw new Error('Native actions require a regular managed file.');
  return fs.realpath(filePath);
}
const clipboardScript=path.join(__dirname,'windows-clipboard.ps1');
async function windowsFileClipboard(filePath,operation='copy') {
  if(process.platform!=='win32')throw new Error('Windows file clipboard is unavailable on this platform.');
  const executable=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const result=await runProcess(executable,['-NoLogo','-NoProfile','-NonInteractive','-STA','-ExecutionPolicy','Bypass','-File',clipboardScript],{input:JSON.stringify({operation,path:filePath})});
  const data=JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
  if(operation==='copy'&&(!data.fileDrop||!data.paths?.includes(filePath)))throw new Error('Windows did not retain the expected file-transfer clipboard representation.');
  return data;
}
function validateAction(input) {
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Action must be an object.');
  const allowed=new Set(['name','args','uploads','timeoutSeconds','mediaTypes','adapter']);for(const key of Object.keys(input))if(!allowed.has(key))throw new Error(`Unexpected action field: ${key}`);
  if(typeof input.name!=='string'||!input.name.trim()||input.name.length>80)throw new Error('Action name must be 1–80 characters.');
  if(!Array.isArray(input.args)||input.args.length>64||input.args.some(a=>typeof a!=='string'||a.length>8192||a.includes('\0')))throw new Error('Arguments must be an array of bounded strings.');
  for(const arg of input.args)if(/\{[^}]*\}/g.test(arg.replaceAll('{file}','').replaceAll('{filename}','').replaceAll('{directory}','')))throw new Error('Unknown argument placeholder.');
  if(typeof input.uploads!=='boolean'||!Number.isInteger(input.timeoutSeconds)||input.timeoutSeconds<1||input.timeoutSeconds>300)throw new Error('Declare upload behavior and a timeout of 1–300 seconds.');
  if(input.mediaTypes!==undefined&&(!Array.isArray(input.mediaTypes)||input.mediaTypes.some(v=>!['video','audio'].includes(v))))throw new Error('Media types must be video and/or audio.');
  if(input.adapter!==undefined&&!['executable','sharex'].includes(input.adapter))throw new Error('Unknown local action adapter.');
  if(input.adapter==='sharex'&&(!input.uploads||input.args.length!==3||input.args[0]!=='{file}'||input.args[1]!=='-task'||!input.args[2].trim()||/[\0\r\n{}]/.test(input.args[2])))throw new Error('ShareX requires an upload-marked file/task handoff.');
  return {name:input.name.trim(),args:[...input.args],uploads:input.uploads,timeoutSeconds:input.timeoutSeconds,mediaTypes:input.mediaTypes||['video','audio'],adapter:input.adapter||'executable'};
}
function expandArguments(args,filePath) {const values={file:filePath,filename:path.basename(filePath),directory:path.dirname(filePath)};return args.map(arg=>arg.replace(/\{(file|filename|directory)\}/g,(_,key)=>values[key]));}
async function loadBindings(configPath) {try {const data=JSON.parse(await fs.readFile(configPath,'utf8'));if(!Array.isArray(data))throw new Error('Invalid local action store.');return data;}catch(error){if(error.code==='ENOENT')return [];throw error;}}
async function saveBinding(configPath,input,executable) {
  const action=validateAction(input);if(!path.isAbsolute(executable))throw new Error('An absolute local executable must be chosen.');
  const stat=await fs.lstat(executable);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('Choose a regular executable file.');
  if(process.platform==='win32'&&path.extname(executable).toLowerCase()!=='.exe')throw new Error('Choose a Windows .exe file; scripts are not executable bindings.');
  if(action.adapter==='sharex'&&path.basename(executable).toLowerCase()!=='sharex.exe')throw new Error('The ShareX adapter requires a locally selected ShareX.exe.');
  if(process.platform!=='win32'&&(stat.mode&0o111)===0)throw new Error('The selected file is not executable.');
  const actions=await loadBindings(configPath);const item={id:crypto.randomUUID(),...action,executable};actions.push(item);await fs.mkdir(path.dirname(configPath),{recursive:true});
  const temp=`${configPath}.${crypto.randomUUID()}.tmp`;await fs.writeFile(temp,JSON.stringify(actions,null,2),{mode:0o600,flag:'wx'});await fs.rename(temp,configPath);return publicAction(item);
}
function publicAction({executable,args,...action}) {return action;}
module.exports={validateId,runProcess,managedFile,windowsFileClipboard,validateAction,expandArguments,loadBindings,saveBinding,publicAction};
