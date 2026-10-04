import { build, Platform } from 'electron-builder';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
const pkg=JSON.parse(await readFile('package.json','utf8'));
const unpacked=(await readdir('release')).filter(name=>name.startsWith('Media Workbench-win32-')).map(name=>path.join('release',name));
if(!unpacked.length)throw Error('No packaged Windows app found in release/. Run npm run package:desktop first.');
const files=await build({targets:Platform.WINDOWS.createTarget('nsis'),prepackaged:path.resolve(unpacked[0]),publish:'never',config:{
 appId:'com.arkiental.mediaworkbench',productName:'Media Workbench',directories:{output:'release/installer'},
 artifactName:'Media-Workbench-Setup-${version}.exe',
 nsis:{oneClick:false,allowToChangeInstallationDirectory:true,perMachine:false,createDesktopShortcut:true,createStartMenuShortcut:true},
 compression:'normal'}});
console.log(JSON.stringify({version:pkg.version,installers:files},null,2));
