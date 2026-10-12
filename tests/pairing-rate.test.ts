import test from 'node:test';
import assert from 'node:assert/strict';
import { PairingLimiter } from '../apps/server/src/pairing-rate.ts';

test('pairing admission bounds anonymous client tracking and expires abandoned addresses',()=>{
 const limiter=new PairingLimiter(3,1000,2);
 for(const client of ['first','second','third'])limiter.check(client,0);
 for(let n=0;n<10000;n++)assert.throws(()=>limiter.check(`rotating-${n}`,1),/capacity reached/i);
 limiter.check('first',2);assert.throws(()=>limiter.check('first',3),/Too many pairing attempts/);
 for(const client of ['fresh-first','fresh-second','fresh-third'])limiter.check(client,1000);
 assert.throws(()=>limiter.check('fourth',1001),/capacity reached/i);
});

test('pairing limits preserve the complete attempt window for a single address',()=>{
 const limiter=new PairingLimiter(3,1000,2);
 limiter.check('first',100);limiter.check('first',101);
 assert.throws(()=>limiter.check('first',1099),/Too many pairing attempts/);
 limiter.check('first',1100);limiter.check('first',1101);
 assert.throws(()=>limiter.check('first',1102),/Too many pairing attempts/);
});
