import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
const root=path.resolve(process.argv[2]||'.tools');
const manifest=JSON.parse(await readFile(path.join(root,'manifest.json'),'utf8'));
for(const tool of manifest.tools){if(path.basename(tool.path)!==tool.path)throw Error('Invalid tool manifest path');const bytes=await readFile(path.join(root,tool.path));if(createHash('sha256').update(bytes).digest('hex')!==tool.sha256)throw Error(`${tool.name} integrity mismatch`);console.log(`${tool.name}: SHA256 verified`);}
