import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { discoverTools, runProcess, probe, findFont } from '../media/src/index.ts';
import type { ToolPaths } from '../contracts/src/index.ts';

export async function generateFixtures(directory=resolve('test-output/fixtures'),tools?:ToolPaths){
  tools??=await discoverTools();await mkdir(directory,{recursive:true});
  await copyFile(await findFont(),join(directory,'fixture-font.ttf'));
  const base=['-hide_banner','-loglevel','error','-y'];
  const numbered=join(directory,'numbered-cfr.mp4');
  // Real visible numbering plus a changing test pattern. Each exact-export frame can be hashed.
  await runProcess(tools.ffmpeg,[...base,'-f','lavfi','-i','testsrc2=size=320x180:rate=10:duration=4','-f','lavfi','-i',"aevalsrc=if(lt(mod(t\\,1)\\,0.08)\\,0.6*sin(2*PI*1000*t)\\,0):s=48000:d=4",'-vf',"drawtext=fontfile=fixture-font.ttf:text='%{n}':x=12:y=12:fontsize=32:fontcolor=white:box=1:boxcolor=black",'-c:v','libx264','-preset','veryfast','-crf','0','-g','20','-pix_fmt','yuv420p','-c:a','aac','-b:a','128000',numbered],undefined,{cwd:directory});
  const vfr=join(directory,'numbered-vfr.mkv');await runProcess(tools.ffmpeg,[...base,'-i',numbered,'-vf',"select='not(eq(mod(n,3),1))'",'-fps_mode','vfr','-c:v','ffv1','-an',vfr]);
  const offset=join(directory,'numbered-offset.mkv');await runProcess(tools.ffmpeg,[...base,'-i',vfr,'-vf','setpts=PTS+5/TB','-fps_mode','vfr','-c:v','ffv1','-an',offset]);
  const longGop=join(directory,'long-gop-bframes.mp4');await runProcess(tools.ffmpeg,[...base,'-i',numbered,'-c:v','libx264','-preset','medium','-crf','18','-g','20','-keyint_min','20','-sc_threshold','0','-bf','3','-c:a','copy',longGop]);
  const audio=join(directory,'replacement.wav');await runProcess(tools.ffmpeg,[...base,'-f','lavfi','-i','sine=frequency=440:sample_rate=44100:duration=1','-c:a','pcm_s16le',audio]);
  const multipleAudio=join(directory,'two-audio.mkv');await runProcess(tools.ffmpeg,[...base,'-i',numbered,'-i',audio,'-map','0:v','-map','0:a','-map','1:a','-c','copy',multipleAudio]);
  const rotated=join(directory,'rotated.mp4');await runProcess(tools.ffmpeg,[...base,'-display_rotation:v:0','90','-i',numbered,'-map','0','-c','copy',rotated]);
  const hostile=join(directory,'Unicode-雪 & dollar$ (test).mp4');await runProcess(tools.ffmpeg,[...base,'-i',numbered,'-c','copy',hostile]);
  const ntsc=join(directory,'rational-ntsc.mp4');await runProcess(tools.ffmpeg,[...base,'-f','lavfi','-i','testsrc2=size=320x180:rate=30000/1001:duration=2','-vf',"drawtext=fontfile=fixture-font.ttf:text='%{n}':x=12:y=12:fontsize=32:fontcolor=white:box=1:boxcolor=black",'-c:v','libx264','-crf','0','-pix_fmt','yuv420p',ntsc],undefined,{cwd:directory});
  const files={numbered,vfr,offset,longGop,audio,multipleAudio,rotated,hostile,ntsc};
  const info=Object.fromEntries(await Promise.all(Object.entries(files).map(async([key,path])=>[key,await probe(path,tools!)])));
  await writeFile(join(directory,'manifest.json'),JSON.stringify({generatedAt:new Date().toISOString(),files,media:info},null,2));return files;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)generateFixtures().then(files=>console.log(JSON.stringify(files,null,2))).catch(e=>{console.error(e);process.exitCode=1;});
