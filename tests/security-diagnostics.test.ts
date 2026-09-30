import test from 'node:test';
import assert from 'node:assert/strict';
import { runProcess } from '../packages/media/src/process.ts';
import { redactError } from '../apps/server/src/download.ts';

test('real native exit status survives long diagnostic-tail redaction',async()=>{
 let failure:unknown;try{await runProcess(process.execPath,['-e',"process.stderr.write('ordinary diagnostic line\\n'.repeat(400)+'https://example.invalid/private?session=synthetic\\nAuthorization: synthetic-value\\nfinal-observable-marker\\n');process.exitCode=17;"]);}catch(error){failure=error;}
 assert(failure,'real native child must fail');const redacted=redactError(failure);assert.match(redacted,/Native tool failed \(17\)/);assert.match(redacted,/final-observable-marker/);assert(!redacted.includes('synthetic-value'));assert(!redacted.includes('example.invalid'));assert(redacted.length<=1800);
});
