import test from 'node:test';
import assert from 'node:assert/strict';
import { VisualJudge, decisionKey, parseVisualDecision, visualFrame } from '../dist/decisions.js';
import { runDragPilot, mapImagePoint } from '../dist/drag-assist.js';
import { withDeadline } from '../dist/deadline.js';

const png=Buffer.alloc(45);
Buffer.from([137,80,78,71,13,10,26,10]).copy(png);png.writeUInt32BE(13,8);png.write('IHDR',12);
png.writeUInt32BE(1440,16);png.writeUInt32BE(3200,20);png.write('IEND',37);
const frame=()=>visualFrame(png,'org.fixture');
const choice=(name,selected,values,confidence=.99)=>({type:'choice',name,choice:selected,confidence,
  probabilities:values.map(value=>({value,probability:value===selected?.98:.01}))});
const envelope=(goal='not_achieved',scene='same',confidence=.99)=>({answers:[
  choice('goal',goal,['achieved','not_achieved','unknown'],confidence),choice('scene',scene,['same','changed','unknown'])]});
const judged=(goal='not_achieved',scene='same',confidence=.99)=>parseVisualDecision(envelope(goal,scene,confidence));
const plan={target:'Movable square',goal:'Signal is green',expectedPackage:'org.fixture',imageSize:{width:922,height:2048},
  steps:[{from:{x:100,y:100},to:{x:200,y:100},durationMs:300},{from:{x:200,y:100},to:{x:300,y:100},durationMs:300}]};
function fixture(decisions,overrides={}) {
  let reads=0,moves=0,judgments=0;
  return {counts:()=>({reads,moves,judgments}),ports:{
    observe:async()=>{reads++;return frame();},
    judge:async()=>{judgments++;return decisions.shift()||judged();},
    drag:async(action,id)=>{moves++;assert.equal(id,frame().id);assert.equal(action.expectedPackage,'org.fixture');return {pointerReleased:true};},
    ...overrides,
  }};
}

test('Decisions validates distributions, refuses missing answers, and preserves uncertainty',()=>{
  assert.equal(judged('achieved').status,'achieved');
  assert.equal(judged('achieved','same',.72).status,'unknown');
  assert.equal(judged('achieved','changed').status,'scene_changed');
  assert.equal(judged('achieved','unknown').status,'unknown');
  assert.equal(judged('unknown').status,'unknown');
  for(const data of [{answers:[]},{answers:[{type:'refusal'},{}]},envelope()]) {
    if(data.answers[0]?.type==='choice')data.answers[0].probabilities[0].value='arbitrary';
    assert.equal(parseVisualDecision(data).status,'unknown');
  }
  const bad=envelope();bad.answers[0].probabilities[1].probability=NaN;
  assert.equal(parseVisualDecision(bad).reason,'invalid_response');
});

test('explicit Decisions call reuses a summary credential, sends only selected images, and does not retry errors',async()=>{
  assert.equal(decisionKey({PHONE_SUMMARY_API_KEY:'synthetic-summary-credential'}),'synthetic-summary-credential');
  assert.equal(decisionKey({PHONE_DECISION_API_KEY:'synthetic-decision-credential',PHONE_SUMMARY_API_KEY:'unused'}),'synthetic-decision-credential');
  let calls=0;
  const judge=new VisualJudge('synthetic-credential',async(url,options)=>{
    calls++;assert.equal(url,'https://api.openai.com/v1/decisions');
    const body=JSON.parse(options.body);assert.equal(body.model,'gpt-6-luna');
    assert.equal(body.questions.length,2);assert.equal(body.input[0].content.filter(c=>c.type==='input_image').length,1);
    assert.equal(typeof body.questions.find(q=>q.name==='goal').instructions,'string');
    assert.equal(body.questions.find(q=>q.name==='scene').instructions.filter(c=>c.type==='input_image').length,1);
    assert(!('store' in body));assert(options.signal);
    return new Response('sensitive response body',{status:403});
  });
  const result=await judge.evaluate(frame(),frame(),'square','green');
  assert.equal(calls,1);assert.equal(result.reason,'http_403');assert(!JSON.stringify(result).includes('sensitive'));
});

test('a request cannot escape an exhausted parent deadline',async()=>{
  let calls=0;
  const judge=new VisualJudge('synthetic-credential',async()=>{calls++;throw new Error('private data');});
  const result=await withDeadline(0,()=>judge.evaluate(frame(),frame(),'square','green'));
  assert.equal(result.status,'unknown');assert.equal(calls,0);
});

test('optional model transport accepts a bounded answer and rejects oversized data without echo or retry',async()=>{
  let calls=0;
  const judge=new VisualJudge('synthetic-credential',async()=>{
    calls++;return new Response(calls===1?JSON.stringify(envelope('achieved')):'x'.repeat(65537));
  });
  assert.equal((await judge.evaluate(frame(),frame(),'square','green')).status,'achieved');
  const oversized=await judge.evaluate(frame(),frame(),'square','green');
  assert.equal(oversized.status,'unknown');assert.equal(calls,2);
  assert(!JSON.stringify(oversized).includes('xxx'));
});

test('display coordinates map to the source PNG and reject crop, rotation and off-image points',()=>{
  assert.deepEqual(mapImagePoint({x:461,y:1024},plan.imageSize,frame()),{x:720,y:1600});
  assert.throws(()=>mapImagePoint({x:922,y:0},plan.imageSize,frame()));
  assert.throws(()=>mapImagePoint({x:10,y:10},{width:2048,height:922},frame()));
  assert.throws(()=>mapImagePoint({x:10,y:10},{width:500,height:500},frame()));
});

test('bounded pilot stops after the visible signal persists across a separate capture',async()=>{
  const f=fixture([judged(),judged(),judged('achieved'),judged('achieved')]);
  const result=await runDragPilot(plan,f.ports);
  assert.equal(result.status,'goal_observed_twice');assert.deepEqual(f.counts(),{reads:4,moves:2,judgments:4});
  assert(result.actions.every(a=>a.acknowledged));assert.equal(result.observations.at(-1).pixelsChanged,false);
});

test('an already achieved signal is confirmed without dragging',async()=>{
  const f=fixture([judged('achieved'),judged('achieved')]);
  assert.equal((await runDragPilot(plan,f.ports)).status,'goal_observed_twice');assert.equal(f.counts().moves,0);
});

test('reusing an old screenshot cannot count as a separate success confirmation',async()=>{
  const saved=frame();
  const f=fixture([judged('achieved'),judged('achieved')],{observe:async()=>saved});
  assert.equal((await runDragPilot(plan,f.ports)).status,'confirmation_not_fresh');
  assert.equal(f.counts().judgments,1);assert.equal(f.counts().moves,0);
});

test('low confidence and scene change stop before any correction',async()=>{
  for(const decision of [judged('achieved','same',.72),judged('not_achieved','changed')]) {
    const f=fixture([decision]);const result=await runDragPilot(plan,f.ports);
    assert(['judgment_unknown','scene_changed'].includes(result.status));assert.equal(f.counts().moves,0);
  }
});

test('persistent failure respects the two-step ceiling, without inventing success from input acknowledgements',async()=>{
  const f=fixture([]);const result=await runDragPilot(plan,f.ports);
  assert.equal(result.status,'step_limit');assert.equal(f.counts().moves,2);assert.equal(f.counts().judgments,3);
});

test('a disappearing success signal hands back instead of sending another drag',async()=>{
  const f=fixture([judged(),judged('achieved'),judged()]);
  assert.equal((await runDragPilot(plan,f.ports)).status,'success_signal_unstable');assert.equal(f.counts().moves,1);
});

test('app/geometry changes after an action stop before another paid judgment or action',async()=>{
  for(const change of [{packageName:'org.other'},{width:3200,height:1440}]) {
    let reads=0;
    const f=fixture([],{observe:async()=>({...frame(),...(reads++?change:{})})});
    const result=await runDragPilot(plan,f.ports);
    assert(['app_changed','geometry_changed'].includes(result.status));
    assert.equal(f.counts().moves,1);assert.equal(f.counts().judgments,1);
  }
});

test('uncertain injection and failed post-action observation retain attempted action evidence without replay',async()=>{
  let calls=0;
  const uncertain=fixture([],{drag:async()=>{calls++;throw new Error('missing acknowledgement');}});
  const result=await runDragPilot(plan,uncertain.ports);
  assert.equal(result.status,'action_uncertain');assert.equal(calls,1);assert.equal(result.actions[0].acknowledged,false);
  let reads=0;
  const noImage=fixture([],{observe:async()=>{if(reads++)throw new Error('capture failed');return frame();}});
  const captured=await runDragPilot(plan,noImage.ports);
  assert.equal(captured.status,'observe_failed_or_deadline');assert.equal(captured.actions[0].acknowledged,true);
  assert.equal(noImage.counts().moves,1);
});

test('invalid plans and inadequate remaining time cannot start a drag',async()=>{
  const f=fixture([]);
  await assert.rejects(runDragPilot({...plan,steps:Array(3).fill(plan.steps[0])},f.ports));
  await assert.rejects(runDragPilot({...plan,steps:[{...plan.steps[0],to:{x:10000,y:1}}]},f.ports));
  assert.equal(f.counts().reads,0);
  assert.equal((await runDragPilot({...plan,timeoutMs:1000},f.ports)).status,'insufficient_time_for_action_and_observation');
  assert.equal(f.counts().moves,0);
});
