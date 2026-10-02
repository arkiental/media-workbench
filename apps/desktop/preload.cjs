'use strict';
const { contextBridge,ipcRenderer }=require('electron');
contextBridge.exposeInMainWorld('mediaWorkbench',Object.freeze({
  capabilities:()=>ipcRenderer.invoke('native:capabilities'),
  chooseDownloadFolder:()=>ipcRenderer.invoke('native:choose-download-folder'),
  copyFile:id=>ipcRenderer.invoke('native:copy-file',id),
  copyPath:id=>ipcRenderer.invoke('native:copy-path',id),
  reveal:id=>ipcRenderer.invoke('native:reveal',id),
  saveAs:id=>ipcRenderer.invoke('native:save-as',id),
  dragOut:id=>ipcRenderer.send('native:drag-out',id),
  listActions:()=>ipcRenderer.invoke('native:actions'),
  configureAction:action=>ipcRenderer.invoke('native:configure-action',action),
  runAction:(actionId,artifactId)=>ipcRenderer.invoke('native:run-action',actionId,artifactId)
}));
