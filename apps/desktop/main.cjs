'use strict';
const { app,BrowserWindow,ipcMain,dialog,shell,clipboard,nativeImage,Menu }=require('electron');
const { spawn }=require('node:child_process');
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const native=require('./native.cjs');
let mainWindow,service,origin,token,desktopSecret,quitting=false,shutdownComplete=false;
const root=path.resolve(__dirname,'../..');
const readyTimeout=60000;
function trusted(event) {if(!mainWindow||event.sender!==mainWindow.webContents||event.senderFrame!==mainWindow.webContents.mainFrame||new URL(event.senderFrame.url).origin!==origin)throw new Error('Native IPC denied for this sender.');}
function register(name,fn) {ipcMain.handle(name,async(event,...args)=>{trusted(event);return fn(...args);});}
async function resolveArtifact(id) {
  native.validateId(id);const response=await fetch(`${origin}/api/v1/desktop/artifacts/${id}`,{headers:{authorization:`Bearer ${token}`,'x-desktop-secret':desktopSecret}});
  if(!response.ok)throw new Error('The local owner cannot access this completed artifact.');const item=await response.json();return {...item,path:await native.managedFile(item.path)};
}
function capability(state,reason) {return {state,...(reason?{reason}:{})};}
function capabilities() {return {fileClipboard:process.platform==='win32'?capability('available'):capability('unavailable','Linux file clipboard transfer has not passed desktop-specific testing.'),nativeDragOut:process.platform==='win32'?capability('available'):capability('unavailable','Linux drag out has not passed desktop-specific testing.'),revealFile:capability('available'),externalActions:capability('available')};}
async function startService() {
  const nodePath=path.join(root,'.tools',process.platform==='win32'?'node.exe':'node');
  await fs.access(nodePath).catch(()=>{throw new Error('Pinned Node runtime is missing. Run npm run tools:setup before launching the desktop.');});
  await fs.access(path.join(root,'dist/server/main.js')).catch(()=>{throw new Error('Service build is missing. Run npm run build before launching the desktop.');});
  token=crypto.randomBytes(32).toString('hex');desktopSecret=crypto.randomBytes(32).toString('hex');
  const bundledFont=path.join(root,'.tools','fonts','DejaVuSans.ttf');const fontEnv=process.platform==='linux'&&await fs.access(bundledFont).then(()=>true,()=>false)?{MW_FONT:bundledFont}:{};
  service=spawn(nodePath,[path.join(root,'dist/server/main.js')],{cwd:root,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,...fontEnv,MW_PORT:'0',MW_HOST:'127.0.0.1',MW_SHARED:'0',MW_OWNER_TOKEN:token,MW_DESKTOP_SECRET:desktopSecret,MW_DATA_DIR:process.env.MW_DATA_DIR||path.join(app.getPath('userData'),'media-service')}});
  let tail='';service.stderr.on('data',data=>{tail=(tail+data.toString()).slice(-2000);});
  const port=await new Promise((resolve,reject)=>{let lines='';const timer=setTimeout(()=>reject(new Error('Local service did not become ready within 60 seconds.')),readyTimeout);service.on('error',error=>{clearTimeout(timer);reject(error);});service.on('exit',code=>{clearTimeout(timer);reject(new Error(`Local service exited (${code}). ${tail}`));});service.stdout.on('data',data=>{lines+=data.toString();const records=lines.split('\n');lines=records.pop()||'';for(const line of records){try{const event=JSON.parse(line);if(Number.isInteger(event.port)&&event.port>0){clearTimeout(timer);resolve(event.port);}}catch{}}});});
  origin=`http://127.0.0.1:${port}`;
  service.on('exit',()=>{if(!quitting){dialog.showErrorBox('Media service stopped','The local service exited. Reopen the application to recover durable jobs.');app.quit();}});
}
async function installSession() {
  const response=await fetch(`${origin}/api/v1/session`,{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify({token})});
  if(!response.ok)throw new Error('Desktop session authentication failed.');
  const cookie=response.headers.get('set-cookie');if(!cookie)throw new Error('Service did not set a session cookie.');
  const match=cookie.match(/^([^=]+)=([^;]+)/);if(!match)throw new Error('Service session cookie could not be read.');
  await mainWindow.webContents.session.cookies.set({url:origin,name:match[1],value:match[2],httpOnly:true,sameSite:'strict',path:'/'});
}
function installIPC() {
  const bindingsPath=path.join(app.getPath('userData'),'local-actions.json');
  register('native:capabilities',capabilities);
  mainWindow.webContents.on('context-menu',(_event,params)=>{if(params.isEditable)Menu.buildFromTemplate([{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{type:'separator'},{role:'selectAll'}]).popup({window:mainWindow});});
  register('native:choose-download-folder',async()=>{
    const selected=await dialog.showOpenDialog(mainWindow,{title:'Choose download folder',properties:['openDirectory','createDirectory']});
    if(selected.canceled||!selected.filePaths[0])return;
    const response=await fetch(`${origin}/api/v1/desktop/download-folder`,{method:'POST',headers:{authorization:`Bearer ${token}`,'x-desktop-secret':desktopSecret,'content-type':'application/json'},body:JSON.stringify({path:selected.filePaths[0]})});
    if(!response.ok)throw Error('Cannot use this download folder');return response.json();
  });
  register('native:copy-file',async id=>{const item=await resolveArtifact(id);await native.windowsFileClipboard(item.path);});
  register('native:copy-path',async id=>{const item=await resolveArtifact(id);await clipboard.writeText(item.path);if(await clipboard.readText()!==item.path)throw new Error('Clipboard did not retain the path.');});
  register('native:reveal',async id=>{const item=await resolveArtifact(id);shell.showItemInFolder(item.path);});
  register('native:save-as',async id=>{const item=await resolveArtifact(id);const result=await dialog.showSaveDialog(mainWindow,{title:'Save validated media',defaultPath:item.name});if(result.canceled||!result.filePath)return;await fs.copyFile(item.path,result.filePath);const [src,dest]=await Promise.all([fs.stat(item.path),fs.stat(result.filePath)]);if(src.size!==dest.size)throw new Error('Saved file size did not match the source.');});
  register('native:actions',async()=> (await native.loadBindings(bindingsPath)).map(native.publicAction));
  register('native:configure-action',async input=>{const validated=native.validateAction(input);const result=await dialog.showOpenDialog(mainWindow,{title:`Choose local executable for ${validated.name}`,properties:['openFile'],...(process.platform==='win32'?{filters:[{name:'Executable',extensions:['exe']}]}:{})});if(result.canceled)return;const confirm=await dialog.showMessageBox(mainWindow,{type:'question',title:'Register local executable',message:`Allow “${validated.name}” to launch the chosen executable?`,detail:`Executable: ${result.filePaths[0]}\nArguments: ${JSON.stringify(validated.args)}\nUploads data: ${validated.uploads?'YES — confirmation required each run':'No'}\nThis binding belongs only to this local machine.`,buttons:['Cancel','Register'],defaultId:0,cancelId:0});if(confirm.response!==1)return;return native.saveBinding(bindingsPath,validated,result.filePaths[0]);});
  register('native:run-action',async(actionId,artifactId)=>{native.validateId(actionId);const action=(await native.loadBindings(bindingsPath)).find(a=>a.id===actionId);if(!action)throw new Error('Unknown local action.');const item=await resolveArtifact(artifactId);if(!Array.isArray(item.mediaTypes)||!item.mediaTypes.some(type=>(action.mediaTypes||['video','audio']).includes(type)))throw new Error('This action does not support the artifact media type.');const confirm=await dialog.showMessageBox(mainWindow,{type:'question',title:action.uploads?'Confirm media upload handoff':'Confirm external application',message:`Run “${action.name}” with “${item.name}”?`,detail:action.uploads?'This hands your media file to the configured application, which may upload it. Handoff does not confirm upload success.':'The local application receives this validated artifact.',buttons:['Cancel','Run action'],defaultId:0,cancelId:0});if(confirm.response!==1)return {cancelled:true};const result=await native.runProcess(action.executable,native.expandArguments(action.args,item.path),{timeoutMs:action.timeoutSeconds*1000});return {handoff:'process-exited',exitCode:result.code,uploadStatus:'unconfirmed'};});
  ipcMain.on('native:drag-out',async(event,id)=>{try{trusted(event);if(capabilities().nativeDragOut.state!=='available')throw new Error('Native drag out unavailable.');const item=await resolveArtifact(id);const icon=await app.getFileIcon(item.path,{size:'normal'});if(!event.sender.isDestroyed())event.sender.startDrag({file:item.path,icon:icon.isEmpty()?nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1kAAAAASUVORK5CYII='):icon});}catch(error){dialog.showErrorBox('Drag out failed',error.message);}});
}
if(!app.requestSingleInstanceLock())app.quit();else {
  app.on('second-instance',()=>{if(mainWindow){if(mainWindow.isMinimized())mainWindow.restore();mainWindow.show();mainWindow.focus();}});
  app.whenReady().then(async()=>{await startService();mainWindow=new BrowserWindow({width:1320,height:930,minWidth:760,minHeight:600,show:false,title:'Media Workbench',webPreferences:{preload:path.join(__dirname,'preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,allowRunningInsecureContent:false,webviewTag:false,partition:'media-workbench'}});mainWindow.webContents.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));mainWindow.webContents.session.setPermissionCheckHandler(()=>false);mainWindow.webContents.setWindowOpenHandler(()=>({action:'deny'}));mainWindow.webContents.on('will-navigate',(event,url)=>{if(new URL(url).origin!==origin)event.preventDefault();});mainWindow.webContents.on('will-attach-webview',event=>event.preventDefault());installIPC();await installSession();await mainWindow.loadURL(origin);mainWindow.show();}).catch(error=>{dialog.showErrorBox('Media Workbench could not start',error.message);app.quit();});
  app.on('window-all-closed',()=>app.quit());
  app.on('before-quit',event=>{if(shutdownComplete||!service||service.exitCode!==null)return;event.preventDefault();if(quitting)return;quitting=true;const finish=()=>{shutdownComplete=true;app.quit();};service.once('exit',finish);service.stdin.on('error',()=>{});service.stdin.end('shutdown\n');setTimeout(()=>{if(service.exitCode===null&&service.pid){if(process.platform==='win32'){const killer=spawn(path.join(process.env.SystemRoot||'C:\\Windows','System32','taskkill.exe'),['/PID',String(service.pid),'/T','/F'],{shell:false,windowsHide:true,stdio:'ignore'});killer.once('exit',finish);}else {service.kill('SIGKILL');}}else finish();},6000).unref();});
}
