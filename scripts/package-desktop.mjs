import { packager } from '@electron/packager';
import { mkdtemp, cp, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const sourceServerSha256=sha256(await readFile('dist/server/main.js'));
const staging=await mkdtemp(path.resolve('test-output/package-'));
for(const item of ['apps/desktop','dist','packages/contracts','LICENSE','THIRD_PARTY_NOTICES.md','README.md','.tools','docs','SECURITY.md','CONTRIBUTING.md','toolchain.lock.json','deploy/LINUX_PACKAGE_README.md'])await cp(item,path.join(staging,item),{recursive:true});
const pkg=JSON.parse(await readFile('package.json','utf8'));
await writeFile(path.join(staging,'package.json'),JSON.stringify({name:pkg.name,version:pkg.version,main:'apps/desktop/main.cjs',type:'module',dependencies:pkg.dependencies}));
await cp('node_modules',path.join(staging,'node_modules'),{recursive:true,filter:p=>!/[\\/](electron|@electron|playwright|playwright-core|typescript|tsx|esbuild|@esbuild)([\\/]|$)/.test(p)});
const result=await packager({dir:staging,out:'release',name:'Media Workbench',platform:process.platform,arch:process.arch,electronVersion:'44.3.0',asar:false,overwrite:true,prune:true,appCopyright:'MIT original application; separate tool licenses',executableName:'media-workbench'});
for(const output of result){
 const appRoot=path.join(output,'resources','app'),packagedServerSha256=sha256(await readFile(path.join(appRoot,'dist/server/main.js'))),finalServerSha256=sha256(await readFile('dist/server/main.js'));
 if(packagedServerSha256!==sourceServerSha256||finalServerSha256!==sourceServerSha256)throw Error('Packaged server does not match the final dist build; rebuild from stable source.');
 const provenance={builtAt:new Date().toISOString(),version:pkg.version,platform:process.platform,arch:process.arch,electronVersion:'44.3.0',sourceServerPath:'dist/server/main.js',sourceServerSha256,packagedServerSha256,serverMatchesFinalBuild:true};
 await writeFile(path.join(output,'package-provenance.json'),JSON.stringify(provenance,null,2));await writeFile(path.join(appRoot,'package-provenance.json'),JSON.stringify(provenance,null,2));
}
console.log(JSON.stringify({outputs:result,distribution:'Personal local build only. Tool redistribution/source-license review remains required.'},null,2));
