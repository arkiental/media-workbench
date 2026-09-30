import {z} from 'zod';
import {JobRequestSchema,RecipeSchema,ExportSchema,DownloadSchema,PolicySchema,PresetSchema} from '../../../packages/contracts/src/index.ts';
export function buildOpenAPI(routes:{method:string;url:string}[]){
 const paths:Record<string,any>={};
 const bodies:Record<string,unknown>={'POST /jobs':JobRequestSchema,'POST /sources/inspect':DownloadSchema,'POST /export/plan':z.object({recipe:RecipeSchema,options:ExportSchema,presetId:z.string().uuid().optional()}),'POST /presets/import':PresetSchema,'POST /presets/validate':PresetSchema,'PATCH /admin/users/:id':z.object({policy:PolicySchema}),'POST /session':z.object({token:z.string()}),'POST /pairings':z.object({name:z.string(),scopes:z.array(z.enum(['read','submit','manage']))}),'POST /batches':z.object({items:z.array(DownloadSchema)}),'POST /projects':z.object({id:z.string().uuid().optional(),name:z.string(),recipe:RecipeSchema,options:ExportSchema})};
 const portable=z.union([PresetSchema,z.object({schemaVersion:z.literal(0),id:z.string(),name:z.string(),maxBytes:z.number().int().positive().optional(),codec:z.enum(['h264','hevc','av1']).optional()}).strict()]);
 Object.assign(bodies,{'POST /presets/import':portable,'POST /presets/validate':portable,'POST /jobs/reorder':z.object({ids:z.array(z.string().uuid()).max(1000)}).strict(),'PATCH /artifacts/:id':z.object({pinned:z.boolean().optional(),expiresAt:z.string().datetime().optional()}).strict(),'DELETE /artifacts/:id':z.object({confirmOriginal:z.boolean().optional()}).strict(),'PATCH /settings':z.object({concurrency:z.number().int().min(1).max(4)}).strict(),'POST /cookies/import':z.object({name:z.string().min(1).max(120),content:z.string().max(2*1024*1024)}).strict(),'POST /cookies/browser':z.object({browser:z.string(),profile:z.string().optional()}).strict(),'POST /admin/users':z.object({name:z.string().min(1).max(120),role:z.enum(['member','restricted-guest'])}).strict()});
 for(const r of routes){if(r.method==='HEAD')continue;const raw=r.url.slice('/api/v1'.length);const url=raw.replace(/:([a-z]+)/g,'{$1}');const parameters:any[]=[...raw.matchAll(/:([a-z]+)/g)].map(m=>({in:'path',name:m[1],required:true,schema:{type:'string',format:'uuid'}}));
  if(r.method==='POST'&&['/jobs','/batches'].includes(raw))parameters.push({in:'header',name:'Idempotency-Key',required:true,schema:{type:'string',minLength:8,maxLength:200}});
  if(raw.endsWith('/content'))parameters.push({in:'header',name:'Range',required:false,schema:{type:'string'},description:'One byte range, e.g. bytes=0-1023'});
  const query=(name:string,schema:unknown,required=false)=>parameters.push({in:'query',name,required,schema});
  if(raw.endsWith('/content'))query('download',{type:'string',enum:['1']});
  if(raw==='/history/export')query('format',{type:'string',enum:['json','csv'],default:'json'});
  if(raw.endsWith('/frames'))query('around',{type:'number',minimum:0,default:0});
  if(raw.endsWith('/frame'))query('pts',{type:'number',minimum:0},true);
  if(raw.endsWith('/waveform')){query('start',{type:'number',minimum:0});query('duration',{type:'number',exclusiveMinimum:0,maximum:60});query('points',{type:'integer',minimum:1,maximum:2000});query('track',{type:'integer',minimum:0,maximum:32});}
  if(raw==='/uploads')parameters.push({in:'header',name:'x-filename',required:false,schema:{type:'string',maxLength:600},description:'URI-encoded display filename; it is never used as a server path'});
  if(raw.startsWith('/desktop/'))parameters.push({in:'header',name:'x-desktop-secret',required:true,schema:{type:'string'},description:'Private desktop companion credential; local owner only'});
  const body=bodies[`${r.method} ${raw}`];const operation:any={operationId:r.method.toLowerCase()+raw.replace(/[^a-z0-9]/gi,'_'),summary:`${r.method} ${raw}`,parameters,responses:{'200':{description:'Successful operation; see docs/API.md for returned domain entity'},'400':{description:'Invalid request or failed operation'},'401':{description:'Missing or revoked credential'},'403':{description:'Scope, role, origin or policy denied'},'404':{description:'Object unavailable to current user'},'429':{description:'Queue or request capacity reached'}}};
  if(r.method==='POST'&&['/jobs','/batches'].includes(raw))operation.responses['202']={description:'Durable job/batch accepted'};
  if(raw.endsWith('/content'))operation.responses['206']={description:'Authenticated byte range'};
  if(body)operation.requestBody={required:r.method!=='DELETE',content:{'application/json':{schema:z.toJSONSchema(body as any)}}};
  operation.responses['408']={description:'Whole-operation deadline exceeded'};operation.responses['409']={description:'Active work or protected dependency prevents mutation'};operation.responses['413']={description:'Upload, storage or transfer byte policy exceeded'};
  if(raw==='/uploads')operation.requestBody={required:true,content:{'application/octet-stream':{schema:{type:'string',format:'binary'}}}};
  if(raw==='/session'&&r.method==='POST')operation.security=[];
  (paths[url]??={})[r.method.toLowerCase()]=operation;
 }
 return {openapi:'3.1.0',info:{title:'Media Workbench API',version:'1.0.0'},servers:[{url:'/api/v1'}],security:[{bearer:[]}],components:{securitySchemes:{bearer:{type:'http',scheme:'bearer'}},schemas:{JobRequest:z.toJSONSchema(JobRequestSchema),Recipe:z.toJSONSchema(RecipeSchema),ExportOptions:z.toJSONSchema(ExportSchema),Policy:z.toJSONSchema(PolicySchema),Preset:z.toJSONSchema(PresetSchema)}},paths};
}
