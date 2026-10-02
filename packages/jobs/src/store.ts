import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash, randomBytes } from 'node:crypto';
import { mkdirSync, lstatSync, realpathSync, writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { Artifact, Job, JobRequest, User, Role, Policy, Source, Project } from '../../contracts/src/index.ts';
import { defaultPolicy } from '../../core/src/policy.ts';
export const hashToken=(token:string)=>createHash('sha256').update(token).digest('hex');
export class Store {
 private reservations=new Map<string,number>();
 private deleting=new Set<string>();
 private holds=new Map<string,number>();
 private lockFile:string;
 readonly db:DatabaseSync; readonly dataDir:string;
 constructor(dataDir:string){
  mkdirSync(dataDir,{recursive:true,mode:0o700});if(lstatSync(dataDir).isSymbolicLink())throw Error('Data directory may not be a symlink');
  this.dataDir=realpathSync(dataDir);
  if(process.platform==='win32')execFileSync(path.join(process.env.SystemRoot||'C:\\Windows','System32','icacls.exe'),[this.dataDir,'/inheritance:r','/grant:r',`${process.env.USERDOMAIN}\\${process.env.USERNAME}:(OI)(CI)(F)`],{windowsHide:true,stdio:'pipe'});
  this.lockFile=path.join(this.dataDir,'service.lock');
  if(existsSync(this.lockFile)){if(lstatSync(this.lockFile).isSymbolicLink())throw Error('Unsafe service lock');const pid=Number(readFileSync(this.lockFile,'utf8'));let live=true;try{process.kill(pid,0);}catch(error){live=(error as NodeJS.ErrnoException).code!=='ESRCH';}if(live)throw Error('Another service owns this data directory; reuse its port or choose a separate MW_DATA_DIR');unlinkSync(this.lockFile);}
  writeFileSync(this.lockFile,String(process.pid),{flag:'wx',mode:0o600});
  for(const d of ['artifacts','work','cache','credentials','handoffs']){const dir=path.join(this.dataDir,d);mkdirSync(dir,{recursive:true,mode:0o700});if(lstatSync(dir).isSymbolicLink()){unlinkSync(this.lockFile);throw Error('Managed directories may not be symlinks');}}
  this.db=new DatabaseSync(path.join(this.dataDir,'workbench.sqlite'));
  this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, policy TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tokens(id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, owner TEXT NOT NULL REFERENCES users(id), scopes TEXT NOT NULL, name TEXT NOT NULL, expires TEXT);
    CREATE TABLE IF NOT EXISTS objects(kind TEXT NOT NULL,id TEXT NOT NULL,owner TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(kind,id));
    CREATE INDEX IF NOT EXISTS objects_owner ON objects(kind,owner);
    CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,owner TEXT NOT NULL,idem TEXT NOT NULL,signature TEXT NOT NULL,payload TEXT NOT NULL,UNIQUE(owner,idem));
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS leases(id TEXT PRIMARY KEY,until TEXT NOT NULL);
    PRAGMA user_version=1;`);
  // Upgrade old preview locks after exclusive startup: no previous service can
  // still be reading. Native handoff files retain their persistent leases.
  if(!this.db.prepare('SELECT 1 FROM settings WHERE key=?').get('scoped-preview-holds-v1')){
   this.db.exec("BEGIN IMMEDIATE; DELETE FROM leases WHERE id NOT IN (SELECT id FROM objects WHERE kind='handoff'); INSERT INTO settings(key,value) VALUES('scoped-preview-holds-v1','true'); COMMIT;");
  }
  // Handoffs are separate files. Preserve their expiry, but release legacy locks
  // on the library original after exclusive startup (no copy can still be running).
  if(!this.db.prepare('SELECT 1 FROM settings WHERE key=?').get('independent-handoffs-v1')){
   this.db.exec(`BEGIN IMMEDIATE;
    UPDATE objects SET payload=json_set(payload,'$.expiresAt',MAX(COALESCE(json_extract(payload,'$.expiresAt'),''),(SELECT until FROM leases WHERE leases.id=objects.id))) WHERE kind='handoff' AND id IN (SELECT id FROM leases);
    DELETE FROM leases WHERE id IN (SELECT id FROM objects WHERE kind='handoff');
    INSERT INTO settings(key,value) VALUES('independent-handoffs-v1','true'); COMMIT;`);
  }
 }
 close(){this.db.close();if(existsSync(this.lockFile)&&readFileSync(this.lockFile,'utf8')===String(process.pid))unlinkSync(this.lockFile);}
 user(id:string):User|undefined {const u=this.db.prepare('SELECT * FROM users WHERE id=?').get(id) as any;return u?{id:u.id,name:u.name,role:u.role,policy:{...defaultPolicy(u.role),...JSON.parse(u.policy)}}:undefined;}
 users():User[]{return (this.db.prepare('SELECT id FROM users').all() as {id:string}[]).map(x=>this.user(x.id)!);}
 createUser(name:string,role:Role,policy:Policy=defaultPolicy(role)):User {const id=randomUUID();this.db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(id,name,role,JSON.stringify(policy));return this.user(id)!;}
 updateUser(id:string,policy:Policy){this.db.prepare('UPDATE users SET policy=? WHERE id=?').run(JSON.stringify(policy),id);return this.user(id)!;}
 token(userId:string,name:string,scopes:string[]=['read','submit','manage'],value=randomBytes(32).toString('base64url'),expires?:string){
  const id=randomUUID();this.db.prepare('INSERT INTO tokens VALUES(?,?,?,?,?,?)').run(id,hashToken(value),userId,JSON.stringify(scopes),name,expires||null);return {id,token:value,name,scopes,expires};
 }
 auth(token:string):{user:User;scopes:string[];id:string}|undefined {if(!token||token.length>512)return;const row=this.db.prepare('SELECT * FROM tokens WHERE hash=?').get(hashToken(token)) as any;if(!row||row.expires&&row.expires<new Date().toISOString())return;const user=this.user(row.owner);return user?{user,scopes:JSON.parse(row.scopes),id:row.id}:undefined;}
 tokens(owner:string){return (this.db.prepare('SELECT id,name,scopes,expires FROM tokens WHERE owner=?').all(owner) as any[]).map(t=>({...t,scopes:JSON.parse(t.scopes)}));}
 revoke(owner:string,id:string){this.db.prepare('DELETE FROM tokens WHERE owner=? AND id=?').run(owner,id);}
 put<T>(kind:string,id:string,owner:string,payload:T){this.db.prepare('INSERT INTO objects VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload WHERE objects.owner=excluded.owner').run(kind,id,owner,JSON.stringify(payload));return payload;}
 get<T>(kind:string,id:string,owner:string):T|undefined {const r=this.db.prepare('SELECT payload FROM objects WHERE kind=? AND id=? AND owner=?').get(kind,id,owner) as any;return r?JSON.parse(r.payload):undefined;}
 all<T>(kind:string,owner?:string):T[] {const rows=owner?this.db.prepare('SELECT payload FROM objects WHERE kind=? AND owner=?').all(kind,owner):this.db.prepare('SELECT payload FROM objects WHERE kind=?').all(kind);return (rows as any[]).map(r=>JSON.parse(r.payload));}
 delete(kind:string,id:string,owner:string){this.db.prepare('DELETE FROM objects WHERE kind=? AND id=? AND owner=?').run(kind,id,owner);}
 setting<T>(key:string,fallback:T):T {const r=this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as any;return r?JSON.parse(r.value):fallback;}
 setSetting(key:string,value:unknown){this.db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));}
 jobs(owner?:string):Job[]{const rows=owner?this.db.prepare('SELECT payload FROM jobs WHERE owner=?').all(owner):this.db.prepare('SELECT payload FROM jobs').all();return (rows as any[]).map(x=>JSON.parse(x.payload)).sort((a,b)=>a.position-b.position);}
 job(id:string,owner?:string):Job|undefined {const row=(owner?this.db.prepare('SELECT payload FROM jobs WHERE id=? AND owner=?').get(id,owner):this.db.prepare('SELECT payload FROM jobs WHERE id=?').get(id)) as any;return row?JSON.parse(row.payload):undefined;}
 submissionByKey(owner:string,idem:string):Job|undefined {const row=this.db.prepare('SELECT payload FROM jobs WHERE owner=? AND idem=?').get(owner,idem) as any;return row?JSON.parse(row.payload):undefined;}
 existingSubmission(owner:string,request:JobRequest,idem:string):Job|undefined {const row=this.db.prepare('SELECT signature,payload FROM jobs WHERE owner=? AND idem=?').get(owner,idem) as any;if(!row)return;if(row.signature!==hashToken(JSON.stringify(request)))throw Error('Idempotency key reused with different request');return JSON.parse(row.payload);}
 submit(owner:string,request:JobRequest,idem:string,batchId?:string,presetSnapshot?:Job['presetSnapshot'],submittedRequest?:JobRequest):{job:Job;created:boolean}{
  const signature=hashToken(JSON.stringify(request));const existing=this.db.prepare('SELECT signature,payload FROM jobs WHERE owner=? AND idem=?').get(owner,idem) as any;
  if(existing){if(existing.signature!==signature)throw Error('Idempotency key reused with different request');return {job:JSON.parse(existing.payload),created:false};}
  const now=new Date().toISOString();const job:Job={id:randomUUID(),ownerId:owner,request,submittedRequest:submittedRequest||request,...(presetSnapshot?{presetSnapshot}:{}),state:'queued',progress:0,createdAt:now,updatedAt:now,position:Date.now()+Math.random(),attempt:1,...(batchId?{batchId}:{})};
  this.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?)').run(job.id,owner,idem,signature,JSON.stringify(job));return {job,created:true};
 }
 updateJob(id:string,change:Partial<Job>){const job=this.job(id);if(!job)throw Error('Job missing');Object.assign(job,change,{updatedAt:new Date().toISOString()});this.db.prepare('UPDATE jobs SET payload=? WHERE id=?').run(JSON.stringify(job),id);return job;}
 deleteJob(id:string,owner:string){this.db.prepare('DELETE FROM jobs WHERE id=? AND owner=?').run(id,owner);}
 deletingArtifact(id:string){return this.deleting.has(id);}
 beginArtifactDelete(id:string){if(this.deleting.has(id)||this.leased(id))throw Error('Artifact is protected by an active transfer or native handoff lease');this.deleting.add(id);}
 endArtifactDelete(id:string){this.deleting.delete(id);}
 lease(id:string,milliseconds:number){if(this.deleting.has(id))throw Error('Artifact deletion is in progress');this.db.prepare('INSERT INTO leases VALUES(?,?) ON CONFLICT(id) DO UPDATE SET until=MAX(until,excluded.until)').run(id,new Date(Date.now()+milliseconds).toISOString());}
 holdArtifact(id:string){if(this.deleting.has(id))throw Error('Artifact deletion is in progress');this.holds.set(id,(this.holds.get(id)||0)+1);let released=false;return()=>{if(released)return;released=true;const remaining=(this.holds.get(id)||1)-1;if(remaining)this.holds.set(id,remaining);else this.holds.delete(id);};}
 leased(id:string){if(this.holds.has(id))return true;const r=this.db.prepare('SELECT until FROM leases WHERE id=?').get(id) as any;return !!r&&r.until>new Date().toISOString();}
  diskUsage(owner:string){return this.all<Artifact>('artifact',owner).reduce((n,a)=>n+a.bytes,0)+this.all<{bytes:number}>('handoff',owner).reduce((n,a)=>n+a.bytes,0);}
 availableBytes(owner:string){return (this.user(owner)?.policy.diskBytes||0)-this.diskUsage(owner)-(this.reservations.get(owner)||0);}
 reserve(owner:string){let amount=0,closed=false;return {add:(bytes:number)=>{if(closed||!Number.isSafeInteger(bytes)||bytes<0)throw Error('Invalid storage reservation');if(bytes>this.availableBytes(owner))throw Error('Storage quota exceeded');amount+=bytes;this.reservations.set(owner,(this.reservations.get(owner)||0)+bytes);},release:()=>{if(closed)return;closed=true;this.reservations.set(owner,Math.max(0,(this.reservations.get(owner)||0)-amount));},get bytes(){return amount;}};}
}
