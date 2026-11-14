import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {LatencyProfiles} from '../dist/latency.js';

function fixture() {
  let data; const events=new Map();
  const store={meta:()=>structuredClone(data),setMeta:(_,v)=>{assert(Buffer.byteLength(JSON.stringify(v))<=16384);data=structuredClone(v)},open:id=>events.get(id)};
  const profile=new LatencyProfiles(store,'synthetic-device');
  const record=(id,patch={})=>{
    events.set(id,{id,callerClaim:{private:false}});
    profile.record({eventId:id,at:new Date().toISOString(),tool:'android_take_screenshot',queueMs:5,workMs:40,failed:false,
      observation:{foregroundApp:{packageName:'org.example.game'},uiCapture:{backend:'uiautomator'},preparation:{wakeRequested:false},
        timing:{clock:'host_monotonic_ms',uiSource:'fresh',uiMs:10,totalMs:30,screenshotCaptureAndVerifyMs:12}},...patch});
  };
  return {profile,record,events,store};
}
test('passive timings retain failed samples and separate supplied UI, wake/backend conditions',()=>{
  const f=fixture();f.record(1);f.record(2,{failed:true});
  f.record(3,{observation:{foregroundApp:{packageName:'org.example.game'},timing:{clock:'host_monotonic_ms',uiSource:'supplied',uiMs:0}}});
  const p=f.profile.read(undefined,true);assert.equal(p.failedCalls,1);assert.equal(p.uiRead.n,1);assert.equal(p.uiRead.medianMs,10);
  assert.equal(p.advisoryOnly,true);assert(p.unmeasured.includes('input-to-visible-change time'));
  f.record(4,{private:true});assert.equal(f.profile.read().sampledCalls,3);
  for(let n=5;n<200;n++)f.record(n);
  assert(f.profile.read().sampledCalls<=48);assert(f.profile.read().uiRead.n<=32);
});
test('profiles expire with their evidence and never inherit another device cache',()=>{
  const f=fixture();f.record(1,{at:new Date(Date.now()-8*86400000).toISOString()});f.record(2);f.record(3);
  f.events.delete(2);f.events.set(3,{callerClaim:{private:true}});
  f.profile.prune();assert.equal(f.profile.read().sampledCalls,0);
  f.record(4);assert.equal(new LatencyProfiles(f.store,'other-device').read().sampledCalls,0);
});
test('compact notices appear only when samples suffice or conditions materially change',()=>{
  const f=fixture();for(let n=1;n<=4;n++)f.record(n);
  assert.equal(f.profile.notice(undefined,{}),undefined);f.record(5);
  assert.equal(f.profile.notice(undefined,{}).reason,'initial_sample_ready');
  for(let n=6;n<20;n++)f.record(n);assert.equal(f.profile.notice(undefined,{}),undefined);
});

test('caller-derived notice cursors stay process-only and bounded; a restart can repeat a hint',()=>{
  const f=fixture();for(let n=1;n<=5;n++)f.record(n);
  const labels={actor:'synthetic-reader',session:'synthetic-session'};
  const before=f.store.meta();
  assert(f.profile.notice(undefined,labels));assert.equal(f.profile.notice(undefined,labels),undefined);
  assert.deepEqual(f.store.meta(),before);
  assert(new LatencyProfiles(f.store,'synthetic-device').notice(undefined,labels));
  for(let n=0;n<9;n++)assert(f.profile.notice(undefined,{actor:'synthetic-reader-'+n}));
  assert(f.profile.notice(undefined,labels)); // The oldest of eight process cursors was evicted.
  f.record(6);f.profile.prune();
  const persisted=JSON.stringify(f.store.meta());
  assert(!persisted.includes(labels.actor));assert(!persisted.includes(labels.session));
  assert(!persisted.includes(createHash('sha256').update(JSON.stringify([labels.actor,labels.session,'org.example.game'])).digest('hex')));
  assert(!Object.hasOwn(f.store.meta(),'deliveries'));
});
test('startup removes legacy persisted notice hashes while preserving measurement samples',()=>{
  const f=fixture();for(let n=1;n<=5;n++)f.record(n);
  const samples=f.store.meta().samples;
  f.store.setMeta('latency-v1',{...f.store.meta(),deliveries:{synthetic_old_hash:{at:Date.now(),revision:5}}});
  const restored=new LatencyProfiles(f.store,'synthetic-device');
  assert(!Object.hasOwn(f.store.meta(),'deliveries'));assert.deepEqual(f.store.meta().samples,samples);
  assert.equal(restored.read().sampledCalls,5);assert(restored.notice(undefined,{}));
});
test('temporarily unwritable legacy cleanup reports a fixed diagnostic and maintenance retries',t=>{
  const f=fixture();f.record(1);
  f.store.setMeta('latency-v1',{...f.store.meta(),deliveries:{synthetic_old_hash:{at:Date.now()}}});
  const write=f.store.setMeta;let fail=true,diagnostic='';
  f.store.setMeta=(...args)=>{if(fail)throw Error('synthetic private detail');return write(...args)};
  t.mock.method(process.stderr,'write',value=>{diagnostic+=value;return true});
  const restored=new LatencyProfiles(f.store,'synthetic-device');
  assert.match(diagnostic,/cleanup pending/);assert(!diagnostic.includes('synthetic private detail'));
  assert.equal(restored.read().sampledCalls,1);assert(Object.hasOwn(f.store.meta(),'deliveries'));
  fail=false;restored.prune();assert(!Object.hasOwn(f.store.meta(),'deliveries'));
});
