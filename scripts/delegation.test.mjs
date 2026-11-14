import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {PNG} from 'pngjs';
import {fixtureOwner} from './fixtures/owner.mjs';
import {OwnerSecurity} from '../dist/security.js';
import {Executor} from '../dist/executor.js';
import {DelegationHost} from '../dist/delegation.js';
import {delegationTools} from '../dist/delegation-tools.js';
import {modelBody,requestDecision} from '../dist/delegation-model.js';
import {bindFinding,textSource} from '../dist/delegation-evidence.js';
import {writePrivate} from '../dist/private-files.js';
import {withoutDeadline,withDeadline,remainingTime} from '../dist/deadline.js';

const json=value=>({content:[{type:'text',text:JSON.stringify(value)}]});
const data=r=>r.content.filter(c=>c.type==='text').flatMap(c=>{try{return [JSON.parse(c.text)]}catch{return []}});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}};
const png=PNG.sync.write({width:1,height:1,data:Buffer.alloc(4,255)});
const elements=[{type:'android.widget.TextView',text:'Synthetic article paragraph',identifier:'org.example.game:id/article',rect:{x:0,y:0,width:200,height:300}}];
const decision=(r,action='yield',extra={})=>({intentVersion:r.input.intentVersion,eventId:r.input.frame.eventId,action,
  targetIndex:null,value:null,reason:'Synthetic local observation',localNotes:'',finding:['yield','finish','blocked'].includes(action)?{
    summary:'A source-bound synthetic finding',question:'',uncertainty:'',references:[{readEventId:r.input.sources[0].eventId,spanIds:[0]}],visualEventIds:[]}:null,...extra});
let serial=0;
function harness() {
  fs.mkdirSync('.runtime',{recursive:true});const dir=fs.mkdtempSync(path.resolve('.runtime/delegation-'));
  const owner=fixtureOwner(dir,{gameGrants:[{package:'org.example.game',tools:['android_swipe'],disposableOfflineGame:true}]});
  const keyFile=path.join(dir,'owner-config','delegate.key');writePrivate(keyFile,'synthetic-fixture-credential-only');
  const cfg={...owner.config,delegation:{enabled:true,acceptsModelEgress:true,allowImages:false,keyFile,model:'fixture-model'}};
  fs.writeFileSync(owner.file,JSON.stringify(cfg));const security=new OwnerSecurity(owner.file);
  const common={expectedPackage:{type:'string'},expectedUrl:{type:'string'},requestId:{type:'string'},context:{type:'object'},imageMode:{type:'string'},approval:{type:'object'}};
  const tool=(name,props={})=>({name,inputSchema:{type:'object',properties:{...common,...props},additionalProperties:false}});
  const catalog=[...delegationTools,tool('android_take_screenshot'),tool('android_list_elements'),
    tool('android_swipe',{direction:{type:'string'},x:{type:'integer'},y:{type:'integer'},distance:{type:'integer'},duration:{type:'integer'}}),
    tool('android_press_key',{key:{type:'string'}}),tool('android_activity_open',{eventId:{type:'integer'},receiptOnly:{type:'boolean'},includeScreenshot:{type:'boolean'}})];
  const state={inputs:[],modelCalls:[],reads:0,model:async r=>({answer:decision(r),totalTokens:100}),onInput:async()=>{}};
  const executor=new Executor(security,'synthetic-device',{callTool:async r=>{
    if(r.name==='android_list_elements')return json({elements});
    state.inputs.push(r);await state.onInput(r);return json({acknowledged:true});
  }},catalog);
  executor.adb={getCurrentApp:()=>({packageName:'org.example.game',activity:'.Main'}),getFocusedPackage:()=>state.package??'org.example.game',
    adb:(_, ...args)=>{state.reads++;if(args[0]==='get-state')return Buffer.from('device');if(args.includes('screencap'))return png;throw Error('unexpected fixture ADB')},
    shell:(_, ...args)=>{state.reads++;if(args.join(' ')==='dumpsys window policy')return state.locked?'showing=true':'showing=false';
      if(args.join(' ')==='dumpsys power')return 'mWakefulness=Awake';throw Error('unexpected fixture shell')}};
  executor.ui={getElements:()=>elements,getLastCaptureInfo:()=>({backend:'synthetic'})};
  executor.delegation.model=async(r,key,signal)=>{assert.equal(key,'synthetic-fixture-credential-only');state.modelCalls.push(r);return state.model(r,signal)};
  const call=(name,args)=>executor.call('android_delegate_'+name,args);
  const start=async(extra={})=>{const r=await call('start',{requestId:'start-fixture-'+(++serial),app:'org.example.game',goal:'Synthetic question',...extra});assert(!r.isError,JSON.stringify(r));return data(r)[0].phoneDelegation};
  const status=async(runId)=>{const r=await call('status',{runId,waitMs:10000});assert(!r.isError,JSON.stringify(r));return data(r)[0].phoneDelegation};
  return {dir,owner,security,executor,state,call,start,status};
}

test('finite delegation uses the real public Executor and preserves grant, takeover and evidence semantics',async t=>{
  const h=harness();t.after(()=>h.executor.close());
  await t.test('matching owner grant admits one swipe and binds exact copied text; no model images by default',async()=>{
    h.state.model=async r=>({answer:decision(r,r.input.remaining.intentModelCalls===4?'scroll':'yield',r.input.remaining.intentModelCalls===4?{value:'up'}:{}),totalTokens:100});
    const j=await h.start();const s=await h.status(j.runId);assert.equal(s.status,'yielded');assert.equal(s.handoffReady,true);
    assert.equal(h.state.inputs.length,1);assert.equal(s.finding.evidence[0].spans[0].text,elements[0].text);
    assert.equal(h.state.modelCalls[0].image,undefined);assert.equal(s.usage.modelCalls,2);
    const persisted=JSON.stringify(h.executor.journal.meta('delegation-v1'));
    assert(!persisted.includes('Synthetic question'));assert(!persisted.includes(elements[0].text));assert(!persisted.includes('synthetic-fixture-credential'));
  });
  await t.test('BACK never inherits a game grant and returns a ready obstacle without input',async()=>{
    const before=h.state.inputs.length;h.state.model=async r=>({answer:decision(r,'back'),totalTokens:100});
    const j=await h.start(),s=await h.status(j.runId);assert.equal(s.status,'blocked');assert.equal(s.handoffReady,true);
    assert.match(s.obstacle,/OWNER_APPROVAL_REQUIRED/);assert.equal(h.state.inputs.length,before);
  });
  await t.test('stop/status stay reachable during model wait; stale decision cannot issue input',async()=>{
    const response=deferred(),entered=deferred();h.state.model=async r=>{entered.resolve(r);return response.promise};
    const before=h.state.inputs.length,j=await h.start({budget:{modelCalls:3,seconds:60,totalTokens:4000}}),r=await entered.promise;
    const direct=await h.executor.call('android_take_screenshot',{expectedPackage:'org.example.game'});assert(direct.isError);assert.match(JSON.stringify(direct),/OWNS_PHONE/);
    assert(!(await h.call('status',{runId:j.runId})).isError);
    const stop=await h.call('stop',{runId:j.runId,requestId:'stop-fixture-'+(++serial),expectedVersion:1});assert(!stop.isError);
    assert.equal(data(stop)[0].phoneDelegation.handoffReady,false);
    response.resolve({answer:decision(r,'scroll',{value:'up'}),totalTokens:100});
    const s=await h.status(j.runId);assert.equal(s.status,'stopped');assert.equal(s.handoffReady,true);assert.equal(h.state.inputs.length,before);
  });
  await t.test('goal update discards old response and recaptures, with cumulative counters',async()=>{
    const response=deferred(),entered=deferred();let first=true;
    h.state.model=async r=>{if(first){first=false;entered.resolve(r);return response.promise}return {answer:decision(r),totalTokens:100}};
    const before=h.state.inputs.length,j=await h.start({budget:{modelCalls:3,seconds:60,totalTokens:4000}}),r=await entered.promise;
    const update={runId:j.runId,requestId:'update-fixture-'+(++serial),expectedVersion:1,goal:'Changed synthetic question'};
    assert(!(await h.call('update',update)).isError);
    assert((await h.call('update',{...update,requestId:'conflict-fixture-'+serial})).isError);
    response.resolve({answer:decision(r,'scroll',{value:'up'}),totalTokens:100});
    const s=await h.status(j.runId);assert.equal(s.intentVersion,2);assert.equal(s.status,'yielded');assert.equal(s.usage.modelCalls,2);
    assert.equal(s.usage.totalTokens,200);assert.equal(h.state.inputs.length,before);assert.notEqual(s.lastFrame.eventId,r.input.frame.eventId);
    assert.deepEqual(s.budget,j.budget);
  });
  await t.test('takeover waits for an admitted input; its acknowledgement survives stop',async()=>{
    const pending=deferred(),entered=deferred();h.state.onInput=async()=>{entered.resolve();await pending.promise};
    h.state.model=async r=>({answer:decision(r,'scroll',{value:'up'}),totalTokens:100});
    const j=await h.start();await entered.promise;
    const stop=await h.call('stop',{runId:j.runId,requestId:'stop-inflight-'+(++serial),expectedVersion:1});
    assert.equal(data(stop)[0].phoneDelegation.handoffReady,false);assert.equal(data(stop)[0].phoneDelegation.inputSettled,false);
    pending.resolve();const s=await h.status(j.runId);assert.equal(s.status,'stopped');assert.equal(s.handoffReady,true);h.state.onInput=async()=>{};
  });
  await t.test('last of four model calls is report-only and an invalid report is an explicit obstacle',async()=>{
    const calls=[];h.state.model=async r=>{calls.push(r);return {answer:decision(r,'observe'),totalTokens:10}};
    const j=await h.start(),s=await h.status(j.runId);assert.equal(calls.length,4);assert.equal(calls[3].input.reportRequired,true);
    assert.match(s.obstacle,/FINAL_REPORT_REJECTED/);assert.equal(s.handoffReady,true);
  });
  await t.test('a goal update while input is queued refuses that stale admission and starts the new goal',async()=>{
    const queued=deferred(),release=deferred(),original=h.executor.delegation.ports.call;let first=true;
    h.state.model=async r=>({answer:decision(r,r.input.intentVersion===1?'scroll':'yield',r.input.intentVersion===1?{value:'up'}:{}),totalTokens:100});
    h.executor.delegation.ports.call=async(name,args,current)=>{
      if(name==='android_swipe'&&first){first=false;queued.resolve();await release.promise}
      return original(name,args,current);
    };
    const before=h.state.inputs.length,j=await h.start();await queued.promise;
    assert(!(await h.call('update',{runId:j.runId,requestId:'queued-update-'+(++serial),expectedVersion:1,goal:'A fresh question'})).isError);
    release.resolve();const s=await h.status(j.runId);assert.equal(s.status,'yielded');assert.equal(s.intentVersion,2);assert.equal(h.state.inputs.length,before);
    h.executor.delegation.ports.call=original;
  });
  await t.test('missing consent, key, private context and locked state do not reach the model',async()=>{
    const before=h.state.modelCalls.length,reads=h.state.reads;
    for(const field of ['enabled','acceptsModelEgress']){
      h.security.config.delegation[field]=false;assert((await h.call('start',{requestId:'disabled-'+(++serial),app:'org.example.game',goal:'x'})).isError);h.security.config.delegation[field]=true;
    }
    h.security.config.retainObservationText=false;assert((await h.call('start',{requestId:'retention-'+(++serial),app:'org.example.game',goal:'x'})).isError);h.security.config.retainObservationText=true;
    const key=h.security.config.delegation.keyFile;delete h.security.config.delegation.keyFile;
    assert((await h.call('start',{requestId:'nokey-fixture-'+(++serial),app:'org.example.game',goal:'x'})).isError);h.security.config.delegation.keyFile=key;
    assert((await h.call('start',{requestId:'private-fixture-'+(++serial),app:'org.example.game',goal:'x',context:{private:true}})).isError);
    assert.equal(h.state.reads,reads);h.state.locked=true;const j=await h.start();assert.equal((await h.status(j.runId)).status,'blocked');h.state.locked=false;
    assert.equal(h.state.modelCalls.length,before);
  });
  await t.test('request binding blocks changed replay, passive status cannot reserve an ID, evidence expiry is visible',async()=>{
    h.state.model=async r=>({answer:decision(r),totalTokens:100});const id='reuse-fixture-'+(++serial),j=await h.start({requestId:id});
    const s=await h.status(j.runId);assert(s.finding);
    const replay=await h.call('start',{requestId:id,app:'org.example.game',goal:'changed'});assert.match(JSON.stringify(replay),/BINDING_MISMATCH/);
    assert((await h.call('status',{runId:j.runId,requestId:'passive-fixture-id'})).isError);assert.equal(h.executor.journal.findRequest('passive-fixture-id'),null);
    h.executor.journal.db.prepare('DELETE FROM events WHERE id=?').run(s.finding.evidence[0].readEventId);
    const expired=await h.status(j.runId);assert.equal(expired.finding,null);assert.match(expired.findingStatus,/expired/);
  });
  await t.test('auxiliary latency failure cannot change input acknowledgement',async()=>{
    const saved=h.executor.latency.record;h.executor.latency.record=()=>{throw Error('synthetic cache failure')};
    const r=await h.executor.call('android_swipe',{direction:'up',requestId:'latency-failure-'+(++serial),expectedPackage:'org.example.game'});
    assert(!r.isError);assert.equal(data(r).find(o=>o.phoneReceipt).phoneReceipt.execution,'acknowledged');h.executor.latency.record=saved;
    const jobs=h.executor.journal.meta('delegation-v1');assert(jobs.length<=8);assert(Buffer.byteLength(JSON.stringify(jobs))<=16384);
  });
});

test('restart never resumes jobs; unresolved receipt identity withholds takeover and does not trust foreign receipts',async t=>{
  const h=harness();t.after(()=>h.executor.close());let calls=0;
  h.state.model=async r=>({answer:decision(r,'scroll',{value:'up'}),totalTokens:1});
  const original=h.executor.delegation.ports.call;
  h.executor.delegation.ports.call=async(name,...args)=>{
    if(name==='android_swipe')return json({phoneReceipt:{requestId:'another-request',requestBinding:{tool:name,argsDigest:'foreign'},callOutcome:'completed',execution:'acknowledged'}});
    return original(name,...args);
  };
  const j=await h.start(),s=await h.status(j.runId);assert.equal(s.status,'input_unresolved');assert.equal(s.handoffReady,false);
  const restored=new DelegationHost(h.security,h.executor.journal,{idle:()=>true,call:()=>{calls++;throw Error('no restart input')},imageAvailable:()=>false,latency:()=>null});
  const r=await restored.call('android_delegate_status',{runId:j.runId});assert.equal(data(r)[0].phoneDelegation.handoffReady,false);assert.equal(calls,0);
  assert.match(JSON.stringify(await restored.call('android_delegate_update',{runId:j.runId,requestId:'restart-update-id',expectedVersion:1,goal:'Do not resume'})),/INTERRUPTED/);
  await restored.close();
});

test('model protocol is opt-in image egress, bounded, store:false, no redirects or retry; refusal stays unknown',async()=>{
  const options={model:'fixture-model',allowImages:false};
  const request={input:{reportRequired:true},image:png.toString('base64'),maxOutputTokens:1000};
  const body=modelBody(options,request);assert.equal(body.store,false);assert.equal(body.reasoning,undefined);assert.equal(body.input[0].content.length,1);
  assert.deepEqual(body.tools[0].parameters.properties.action.enum,['yield','finish','blocked']);
  assert.equal(modelBody({...options,allowImages:true},request).input[0].content.length,2);
  let count=0;await assert.rejects(requestDecision(options,request,'synthetic-fixture-credential',new AbortController().signal,async(url,init)=>{
    count++;assert.equal(url,'https://api.openai.com/v1/responses');assert.equal(init.redirect,'error');
    return new Response(JSON.stringify({status:'completed',output:[{type:'refusal'}],usage:{total_tokens:1}}));
  }),/UNAVAILABLE_OR_INVALID/);assert.equal(count,1);
});

test('evidence binds exact source spans and distinguishes unsupported visual proof',()=>{
  const entry={id:10,startedAt:new Date().toISOString(),outcome:'completed',observation:{at:new Date().toISOString(),elements,foregroundApp:{packageName:'org.example.game'}}};
  const source=textSource(entry),sources=new Map([[10,source]]),r={input:{intentVersion:1,frame:{eventId:10},sources:[source]}};
  assert.equal(bindFinding(decision(r),sources,new Set(),()=>entry).evidence[0].spans[0].text,elements[0].text);
  const visual=decision(r);visual.finding.references=[];visual.finding.visualEventIds=[10];
  assert.throws(()=>bindFinding(visual,sources,new Set(),()=>entry),/VISUAL/);
  assert.match(bindFinding(visual,sources,new Set([10]),()=>entry).visualEvidence[0].interpretation,/not exact text/);
  const invalid=decision(r);invalid.finding.references[0].spanIds=[99];assert.throws(()=>bindFinding(invalid,sources,new Set(),()=>entry),/SPAN_UNKNOWN/);
});

test('finite background work detaches from the short start-RPC deadline',async()=>{
  await withDeadline(1,()=>withoutDeadline(async()=>{await new Promise(r=>setTimeout(r,10));assert(remainingTime()>100)}));
});
