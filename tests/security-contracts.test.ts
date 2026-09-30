import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ExportSchema, JobRequestSchema } from '../packages/contracts/src/index.ts';
import { defaultPolicy, enforceJob } from '../packages/core/src/policy.ts';
import { effectiveOptions, migratePreset } from '../packages/core/src/presets.ts';

const clean = { schemaVersion: 1, id: 'review-preset', revision: 1, name: 'Review preset', requires: ['exact-cut-v1'], options: { cut: 'exact' } };
test('portable preset import rejects executable, credential and machine-path payloads', () => {
  for (const payload of [
    { ...clean, command: 'cmd.exe /c calc' },
    { ...clean, executable: 'C:\\Windows\\System32\\cmd.exe' },
    { ...clean, cookie: 'session=secret' },
    { ...clean, options: { cut: 'exact', ffmpegArgs: ['-i', 'http://127.0.0.1/'] } },
    { ...clean, logicalAction: '../escape' },
    { schemaVersion: 0, id: 'old', name: 'old', codec: 'h264', command: 'cmd' }
  ]) assert.throws(() => migratePreset(payload));
  assert.throws(() => migratePreset({ ...clean, requires: ['unrecognized-required-filter-v999'] }), /Unsupported required/);
});

test('legacy hard size ceiling survives deterministic migration and cannot be weakened', () => {
  const original = { schemaVersion: 0, id: 'old-safe', name: 'Old safe', codec: 'h264', maxBytes: 1000000 };
  const first = migratePreset(original), second = migratePreset(original);
  assert.deepEqual(first, second);
  assert.deepEqual(first.original, original);
  assert.equal(first.preset.options.maxBytes, 1000000);
  assert.equal(first.preset.options.mode, 'size');
  assert.throws(() => effectiveOptions(ExportSchema.parse({mode:'size',maxBytes:1000001}), first.preset), /ceiling/);
});

test('restricted guest processing is rejected through export and proxy requests', () => {
  const policy = defaultPolicy('restricted-guest');
  const sourceId = randomUUID();
  for (const request of [
    { type: 'proxy', sourceId },
    { type: 'export', recipe: { sourceId, segments:[{in:0,out:1}] }, options: {} }
  ]) assert.throws(() => enforceJob(JobRequestSchema.parse(request), policy), /Processing permission/);
});

test('cheap-processing policy rejects proxy reencoding', () => {
  const policy = { ...defaultPolicy('member'), expensiveFilters: false };
  const request = JobRequestSchema.parse({type:'proxy',sourceId:randomUUID()});
  assert.throws(() => enforceJob(request, policy), /expensive|proxy|processing/i);
});

test('required exact preset cannot resolve to automatic stream copy', () => {
  const preset = migratePreset(clean).preset;
  const result = effectiveOptions(ExportSchema.parse({cut:'auto'}), preset);
  assert.equal(result.cut, 'exact', 'Required exact-cut intent must resolve to exact or reject before planning');
});

test('hard preset ceiling cannot be disabled by changing compression mode while retaining maxBytes',()=>{
  const preset=migratePreset({schemaVersion:0,id:'ceiling-review',name:'Ceiling',codec:'h264',maxBytes:90000}).preset;
  const result=effectiveOptions(ExportSchema.parse({cut:'exact',mode:'quality',maxBytes:90000,quality:0}),preset);
  assert.equal(result.mode,'size','hard ceiling must remain active in the execution mode');
});
