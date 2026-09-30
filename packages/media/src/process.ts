import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { stat } from 'node:fs/promises';
import type { ExecutionContext, NativeRunOptions } from '../../contracts/src/index.ts';
import { StringDecoder } from 'node:string_decoder';

export type ProcessOptions = NativeRunOptions;
async function stopWindowsTree(pid:number){
 const system=path.join(process.env.SystemRoot||'C:\\Windows','System32');let ids=[pid];
 // Snapshot descendants before the graceful request: a parent may exit while a
 // child refuses it. Only numeric process identifiers cross this helper boundary.
 const script=`$rows=Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId; $ids=[System.Collections.Generic.List[int]]::new(); $ids.Add(${pid}); for($i=0;$i -lt $ids.Count;$i++){foreach($row in $rows){if($row.ParentProcessId -eq $ids[$i] -and -not $ids.Contains([int]$row.ProcessId)){$ids.Add([int]$row.ProcessId)}}}; ConvertTo-Json -Compress -InputObject @($ids.ToArray())`;
 try{const result=await promisify(execFile)(path.join(system,'WindowsPowerShell','v1.0','powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:2500,maxBuffer:32768});const found=JSON.parse(result.stdout);if(Array.isArray(found)&&found.every(id=>Number.isSafeInteger(id)&&id>0)&&found.includes(pid))ids=found;}catch{}
 const args=ids.flatMap(id=>['/PID',String(id)]);
 await promisify(execFile)(path.join(system,'taskkill.exe'),[...args,'/T'],{windowsHide:true,timeout:1500}).catch(()=>{});
 await new Promise(resolve=>setTimeout(resolve,1000));
 await promisify(execFile)(path.join(system,'taskkill.exe'),[...args,'/T','/F'],{windowsHide:true,timeout:3000}).catch(()=>{});
}

/** Every tool is invoked without a shell. Cancellation owns the process group/tree. */
export async function runProcess(binary:string, args:string[], ctx?:ExecutionContext, options:ProcessOptions={}):Promise<{stdout:Buffer;stderr:string;exitCode:number}> {
  if (ctx?.signal.aborted) throw new Error('Operation cancelled');
  if (ctx?.runTool) {
    const result=await ctx.runTool(binary,args,options);
    return {...result,stdout:Buffer.from(result.stdout)};
  }
  return new Promise((resolve,reject)=>{
    const child=spawn(binary,args,{shell:false,windowsHide:true,detached:process.platform!=='win32',cwd:options.cwd??ctx?.workDir,stdio:['pipe','pipe','pipe'],env:{...process.env,AV_LOG_FORCE_NOCOLOR:'1'}});
    let chunks:Buffer[]=[], bytes=0, stderr='', failed:Error|undefined, finished=false, killing=false;let cleanup:Promise<void>|undefined;
    const fail=(error:Error)=>{if(!failed)failed=error;kill();};
    const kill=()=>{if(killing||finished||!child.pid)return;killing=true;
      if(process.platform==='win32') {
        cleanup=stopWindowsTree(child.pid).finally(()=>{if(!finished)child.kill('SIGKILL');});
      } else {const group=child.pid;try{process.kill(-group,'SIGTERM');}catch{child.kill('SIGTERM');}setTimeout(()=>{try{process.kill(-group,'SIGKILL');}catch{}},1500).unref();}
    };
    const aborted=()=>fail(new Error('Operation cancelled'));
    const lineReaders=Object.fromEntries(['stdout','stderr'].map(stream=>[stream,{decoder:new StringDecoder('utf8'),pending:''}])) as Record<'stdout'|'stderr',{decoder:StringDecoder;pending:string}>;
    const outputLines=(stream:'stdout'|'stderr',data?:Buffer)=>{
      if(!options.onOutputLine)return;const reader=lineReaders[stream];reader.pending+=data?reader.decoder.write(data):reader.decoder.end();
      const end=data&&reader.pending.endsWith('\r')?reader.pending.length-1:reader.pending.length;
      const lines=reader.pending.slice(0,end).split(/\r\n|[\r\n]/);reader.pending=lines.pop()!+reader.pending.slice(end);
      if(!data&&reader.pending){lines.push(reader.pending);reader.pending='';}
      if(reader.pending.length>65536||lines.some(line=>line.length>65536)){fail(new Error('Native tool output line exceeded limit'));return;}
      try{for(const line of lines)options.onOutputLine(line,stream);}catch(error){fail(error instanceof Error?error:new Error('Native tool output handler failed'));}
    };
    ctx?.signal.addEventListener('abort',aborted,{once:true});
    const timeout=setTimeout(()=>fail(new Error('Native tool exceeded runtime limit')),Math.min(ctx?.maxRuntimeSeconds??600,86400)*1000);
    const monitor=options.outputPath&&ctx?.maxBytes?setInterval(()=>{void stat(options.outputPath!).then(s=>{if(s.size>ctx!.maxBytes!)fail(new Error('Output exceeded resource byte limit'));}).catch(()=>{});},200):undefined;
    child.stdout.on('data',(data:Buffer)=>{bytes+=data.length;if(bytes>(options.maxStdoutBytes??16*1024*1024)){fail(new Error('Native tool output exceeded limit'));return;}chunks.push(data);outputLines('stdout',data);});
    child.stderr.on('data',(data:Buffer)=>{stderr=(stderr+data.toString('utf8')).slice(-(options.maxStderrBytes??32768));
      outputLines('stderr',data);
      const matches=[...data.toString().matchAll(/out_time_us=(-?\d+)/g)];if(matches.length&&options.duration)ctx?.onProgress?.(Math.min(.98,Math.max(0,(Number(matches.at(-1)![1])/1e6-(options.progressOffset||0))/options.duration)));
    });
    child.on('error',e=>{failed=e;});
    child.on('close',async code=>{outputLines('stdout');outputLines('stderr');finished=true;clearTimeout(timeout);if(monitor)clearInterval(monitor);ctx?.signal.removeEventListener('abort',aborted);await cleanup;
      if(failed)return reject(failed);if(code!==0)return reject(new Error(`Native tool failed (${code}): ${stderr.slice(-6000)}`));resolve({stdout:Buffer.concat(chunks),stderr,exitCode:code});});
    child.stdin.on('error',()=>{});child.stdin.end(options.stdin);
  });
}
