import { build, Platform } from 'electron-builder';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
// Wraps the Docker-built Linux bundle (release/Media Workbench-linux-x64) in an AppImage.
const bundle=(await readdir('release')).find(name=>name.startsWith('Media Workbench-linux-'));
if(!bundle)throw Error('No Linux bundle in release/. Extract media-workbench-linux-x64-debian13.tar.gz there first.');
const files=await build({targets:Platform.LINUX.createTarget('AppImage'),prepackaged:path.resolve('release',bundle),publish:'never',config:{
 appId:'com.arkiental.mediaworkbench',productName:'Media Workbench',directories:{output:'release/appimage'},
 artifactName:'Media-Workbench-${version}-x86_64.AppImage',
 linux:{executableName:'media-workbench',category:'AudioVideo',target:'AppImage'}}});
console.log(JSON.stringify({appimages:files},null,2));
