import { PresetSchema, ExportSchema, type Preset, type ExportOptions } from '../../contracts/src/index.ts';
const supported = new Set(['target-size-v1','exact-cut-v1','copy-cut-v1','crop-v1','captions-v1','audio-v1']);
export function migratePreset(input:unknown):{preset:Preset;original:unknown;changes:string[]} {
  let value=input; const changes:string[]=[];
  if(value && typeof value==='object' && (value as Record<string,unknown>).schemaVersion===0) {
    const v=value as Record<string,unknown>;
    if(Object.keys(v).some(k=>!['schemaVersion','id','name','maxBytes','codec'].includes(k)))throw Error('Unknown legacy preset fields');
    value={schemaVersion:1,id:v.id,name:v.name,revision:1,requires:['exact-cut-v1',...(v.maxBytes?['target-size-v1']:[])],options:ExportSchema.parse({codec:v.codec,cut:'exact',mode:v.maxBytes?'size':'quality',maxBytes:v.maxBytes})};
    changes.push('Migrated schema 0 to 1; legacy byte limit is a hard ceiling; exact cutting retained.');
  }
  const preset=PresetSchema.parse(value);
  if(preset.requires.includes('target-size-v1')&&!preset.options.maxBytes)throw Error('Required target size needs a hard maximum byte count');
  const missing=preset.requires.filter(f=>!supported.has(f));
  if(missing.length)throw Error(`Unsupported required capabilities: ${missing.join(', ')}`);
  return {preset,original:input,changes};
}
export const defaultPreset:Preset=PresetSchema.parse({schemaVersion:1,id:'shareable-clip',revision:1,name:'Shareable clip',requires:['exact-cut-v1','target-size-v1'],options:{cut:'exact',mode:'size',maxBytes:20000000}});
export function effectiveOptions(options:ExportOptions,preset?:Preset):ExportOptions {
  if(!preset)return options;
  if(preset.options.maxBytes && (!options.maxBytes||options.maxBytes>preset.options.maxBytes))throw Error('Preset hard byte ceiling may not be weakened');
  if(preset.requires.includes('exact-cut-v1')&&options.cut==='copy')throw Error('Preset requires exact cutting');
  return ExportSchema.parse({...options,...(preset.requires.includes('exact-cut-v1')?{cut:'exact'}:{}),...(preset.options.maxBytes?{mode:'size'}:{})});
}
