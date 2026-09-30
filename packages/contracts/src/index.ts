import { z } from 'zod';

export const Id = z.string().uuid();
const finite = z.number().finite();
export const SegmentSchema = z.object({ in: finite.min(0), out: finite.positive() }).strict().refine(s => s.out > s.in, 'Out must be greater than in');
export const TextStyleSchema = z.object({
  font: z.enum(['Playfair Display','Arial']).default('Playfair Display'),
  size: finite.min(8).max(400).default(120),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#FFFFFF'),
  align: z.enum(['left','center','right']).default('center'),
  x: finite.min(0).max(1).default(.5), y: finite.min(0).max(1).default(.5)
}).strict();
export const CueSchema = z.object({ in: finite.min(0), out: finite.positive(), text: z.string().max(4000), style: TextStyleSchema.optional() }).strict().refine(c => c.out > c.in);
export const RecipeSchema = z.object({
  schemaVersion: z.literal(1).default(1), sourceId: Id,
  segments: z.array(SegmentSchema).min(1).max(100),
  crop: z.object({ x: z.number().int().min(0), y: z.number().int().min(0), width: z.number().int().positive(), height: z.number().int().positive() }).strict().optional(),
  resize: z.object({ width: z.number().int().min(2).max(7680), height: z.number().int().min(2).max(7680) }).strict().optional(),
  rotate: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).default(0),
  text: z.array(CueSchema).max(100).default([]), captions: z.array(CueSchema).max(5000).default([]),
  subtitleMode: z.enum(['burn', 'soft']).default('burn'),
  audio: z.object({ mode: z.enum(['keep','mute','replace','mix']).default('keep'), track: z.number().int().min(0).max(32).default(0), volume: finite.min(0).max(10).default(1), fadeIn: finite.min(0).max(60).default(0), fadeOut: finite.min(0).max(60).default(0), normalize: z.boolean().default(false), sourceId: Id.optional() }).strict().default({mode:'keep',track:0,volume:1,fadeIn:0,fadeOut:0,normalize:false})
}).strict();
export type Recipe = z.infer<typeof RecipeSchema>;
export const ExportSchema = z.object({
  cut: z.enum(['auto','copy','exact']).default('auto'), mode: z.enum(['auto','quality','bitrate','size']).default('quality'),
  codec: z.enum(['h264','hevc','av1']).default('h264'), container: z.enum(['mp4','mkv']).default('mp4'),
  encoder: z.enum(['software','hardware','auto']).default('software'), allowSoftwareFallback: z.boolean().default(true),
  quality: z.number().int().min(0).max(51).default(23), bitrate: z.number().int().min(10000).max(200000000).default(2000000), frameRate:z.number().finite().min(1).max(240).optional(),
  maxBytes: z.number().int().min(1024).max(20000000000).optional(), speed: z.enum(['fast','balanced','quality']).default('balanced'),
  audioBitrate: z.number().int().min(16000).max(320000).default(128000), maxAttempts: z.number().int().min(1).max(3).default(3)
}).strict().refine(o => o.mode !== 'size' || o.maxBytes !== undefined, 'Size mode needs maxBytes');
export type ExportOptions = z.infer<typeof ExportSchema>;
export const DownloadSchema = z.object({ url: z.string().url().max(8192), format: z.string().regex(/^[a-zA-Z0-9_+./<>=?,\-\[\](): ]{1,200}$/).optional(), preference: z.enum(['compatible','original','audio']).default('compatible'), itemIndex:z.number().int().min(1).max(100).optional(), cookieId: Id.optional() }).strict();
export type DownloadRequest = z.infer<typeof DownloadSchema>;
export const JobRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('download'), download: DownloadSchema }).strict(),
  z.object({ type: z.literal('export'), recipe: RecipeSchema, options: ExportSchema, presetId: Id.optional() }).strict(),
  z.object({ type: z.literal('proxy'), sourceId: Id }).strict()
]);
export type JobRequest = z.infer<typeof JobRequestSchema>;
export type JobState = 'queued'|'preparing'|'downloading'|'processing'|'validating'|'completed'|'failed'|'cancelling'|'cancelled'|'interrupted';
export type MediaStream = { index:number; type:string; codec:string; width?:number; height?:number; sampleRate?:number; channels?:number; duration?:number; startTime?:number; timeBase?:string; frameRate?:string; rotation?:number; colorTransfer?:string };
export type MediaInfo = { duration:number; startTime:number; size:number; format:string; streams:MediaStream[]; hdr:boolean };
export type Artifact = { id:string; ownerId:string; sourceId?:string; jobId?:string; name:string; bytes:number; media:MediaInfo; kind:'original'|'download'|'export'|'proxy'; createdAt:string; pinned:boolean; expiresAt?:string; validated:boolean };
export type Source = { id:string; ownerId:string; artifactId:string; name:string; url?:string; createdAt:string };
export type Plan = { strategy:'copy'|'exact'; encoder:string; hardware:boolean; duration:number; reasons:string[]; warnings:string[]; segments:{in:number;out:number}[]; attempts:number; video:string; audio:string; [key:string]:unknown };
export type Job = { id:string; ownerId:string; batchId?:string; request:JobRequest; submittedRequest?:JobRequest; presetSnapshot?:{preset:Preset;original?:unknown}; state:JobState; progress:number; message?:string; error?:string; plan?:Plan; artifactId?:string; sourceId?:string; createdAt:string; updatedAt:string; position:number; attempt:number;toolVersions?:Record<string,string>;resourceUsage?:{elapsedMs:number} };
export type Role = 'owner'|'member'|'restricted-guest';
export type Policy = { upload:boolean; download:boolean; process:boolean; expensiveFilters:boolean; maxInputBytes:number; maxOutputBytes:number; maxDuration:number; maxPixels:number; maxQueued:number; concurrency:number; maxRuntimeSeconds:number; diskBytes:number; retentionHours:number; allowedSites:string[];allowedInputCodecs:string[];allowedOutputCodecs:string[];allowedEncoders:string[];maxCpuCores:number;maxMemoryMiB:number;bandwidthBytesPerSecond:number;maxTransferBytes:number };
export const PolicySchema=z.object({upload:z.boolean(),download:z.boolean(),process:z.boolean(),expensiveFilters:z.boolean(),maxInputBytes:z.number().int().min(1024).max(20*1024**3),maxOutputBytes:z.number().int().min(1024).max(20*1024**3),maxDuration:z.number().min(1).max(86400),maxPixels:z.number().int().min(4).max(7680*4320),maxQueued:z.number().int().min(1).max(1000),concurrency:z.number().int().min(1).max(4),maxRuntimeSeconds:z.number().int().min(1).max(86400),diskBytes:z.number().int().min(1024).max(1000*1024**3),retentionHours:z.number().min(1).max(87600),allowedSites:z.array(z.string().regex(/^[a-z0-9][a-z0-9.-]+$/)).max(200),allowedInputCodecs:z.array(z.string().regex(/^[a-zA-Z0-9_]+$/)).max(100),allowedOutputCodecs:z.array(z.string().regex(/^[a-zA-Z0-9_]+$/)).max(100),allowedEncoders:z.array(z.string().regex(/^[a-zA-Z0-9_]+$/)).max(100),maxCpuCores:z.number().min(.25).max(16),maxMemoryMiB:z.number().int().min(128).max(16384),bandwidthBytesPerSecond:z.number().int().min(1024).max(1024**3),maxTransferBytes:z.number().int().min(1024).max(100*1024**3)}).strict();
export type User = { id:string; name:string; role:Role; policy:Policy };
export type EncoderCapability = { name:string; codec:'h264'|'hevc'|'av1'; hardware:boolean; available:boolean; reason?:string; testedAt:string };
export type Capabilities = { mode:'local'|'shared'; user:User; features:string[]; tools:Record<string,string>; encoders:EncoderCapability[]; native:Record<string,{state:'available'|'unavailable'|'permission-denied'|'failing';reason?:string}>; sharedHosting:{enabled:boolean;reason?:string} };
export const PresetSchema = z.object({ schemaVersion:z.literal(1), id:z.string().regex(/^[a-z0-9-]{1,80}$/), revision:z.number().int().positive(), name:z.string().min(1).max(120), requires:z.array(z.string().max(80)).max(50), options:ExportSchema, maxHeight:z.number().int().min(2).max(7680).optional(), logicalAction:z.string().regex(/^[a-z0-9-]{1,80}$/).optional() }).strict();
export type Preset = z.infer<typeof PresetSchema>;
export type Project = { id:string; name:string; recipe:Recipe; options:ExportOptions; updatedAt:string };
export type ToolPaths = { ffmpeg:string; ffprobe:string; ytdlp:string; node?:string };
export type NativeRunOptions = {maxStdoutBytes?:number;maxStderrBytes?:number;outputPath?:string;duration?:number;stdin?:Buffer|string;cwd?:string;onOutputLine?:(line:string,stream:'stdout'|'stderr')=>void};
export type ExecutionContext = { signal:AbortSignal; workDir:string; onProgress?:(progress:number,message?:string)=>void; onStage?:(state:JobState)=>void; onPlan?:(plan:Plan)=>void; maxRuntimeSeconds?:number; maxBytes?:number;allowedEncoders?:string[];maxCpuCores?:number;maxMemoryMiB?:number;bandwidthBytesPerSecond?:number;maxTransferBytes?:number; runTool?:(binary:string,args:string[],options?:NativeRunOptions)=>Promise<{stdout:Buffer;stderr:string;exitCode:number}> };
export type NativeBridge = { capabilities:()=>Promise<Record<string,{state:string;reason?:string}>>; copyFile:(id:string)=>Promise<void>; copyPath:(id:string)=>Promise<void>; reveal:(id:string)=>Promise<void>; saveAs:(id:string)=>Promise<void>; dragOut:(id:string)=>void; listActions:()=>Promise<unknown[]>; runAction:(actionId:string,artifactId:string)=>Promise<unknown>; configureAction:(action:unknown)=>Promise<unknown> };
