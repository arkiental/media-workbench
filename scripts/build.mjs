import { build } from 'esbuild';
import { mkdir, copyFile, cp } from 'node:fs/promises';
await mkdir('dist/web', { recursive: true });
await build({entryPoints:['apps/server/src/main.ts'],outfile:'dist/server/main.js',bundle:true,platform:'node',format:'esm',packages:'external',sourcemap:true});
await build({entryPoints:['apps/web/src/main.tsx'],outdir:'dist/web',bundle:true,platform:'browser',external:['/fonts/*'],format:'esm',sourcemap:true,loader:{'.svg':'dataurl'},define:{'process.env.NODE_ENV':'"production"'}});
await copyFile('apps/web/index.html','dist/web/index.html');
await cp('apps/web/assets/fonts','dist/web/fonts',{recursive:true});
