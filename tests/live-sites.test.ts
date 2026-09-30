import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir,mkdtemp,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { discoverTools,toolVersions,validateMedia } from '../packages/media/src/index.ts';
import { inspectDownload,downloadMedia,redactError } from '../apps/server/src/download.ts';
import { defaultPolicy } from '../packages/core/src/policy.ts';
import { DownloadSchema } from '../packages/contracts/src/index.ts';

for(const site of ['YOUTUBE','X','REDDIT'])test(`opt-in live ${site} inspect, real download, probe and complete decode`,{skip:!process.env[`MW_LIVE_${site}_URL`],timeout:180000},async()=>{
 const root=path.resolve('test-output/live-sites');await mkdir(root,{recursive:true});const workDir=await mkdtemp(path.join(root,site.toLowerCase()+'-'));const tools=await discoverTools();
 const report:Record<string,unknown>={site,date:new Date().toISOString(),versions:await toolVersions(tools),status:'failed'};
 try{const request=DownloadSchema.parse({url:process.env[`MW_LIVE_${site}_URL`]});const ctx={signal:AbortSignal.timeout(160000),workDir,maxRuntimeSeconds:150,maxBytes:50*1024**2,policy:{...defaultPolicy('owner'),maxInputBytes:50*1024**2,maxDuration:600}};
  const metadata=await inspectDownload(request,tools,ctx);assert(metadata.entries.length);const file=await downloadMedia(request,tools,ctx);const media=await validateMedia(file.path,tools,ctx);assert(media.size>0);Object.assign(report,{status:'passed',media,inspectionEntries:metadata.entries.length});
 }catch(error){report.error=redactError(error);throw error;}finally{await writeFile(path.join(workDir,'support-status.json'),JSON.stringify(report,null,2));}
});
