import test from 'node:test';
import assert from 'node:assert/strict';
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
