import test from 'node:test';
import assert from 'node:assert/strict';
import { gestureSchema, performGesture } from '../dist/gesture.js';

const points = [{ x: 50, y: 60 }, { x: 90, y: 100 }, { x: 50, y: 60 }];
test('gesture validates bounded paths before launching the helper', () => {
  for (const invalid of [[], [points[0]], Array(65).fill(points[0]), [{x:-1,y:0},points[0]], [{x:1.5,y:2},points[0]]]) {
    assert.throws(() => performGesture({ shell: () => assert.fail('must not invoke helper') }, 'device', { points: invalid }));
  }
  for (const invalid of [{durationMs:0}, {durationMs:5001}, {holdMs:2001}, {expectedPackage:'org.example;bad'}, {device:'other'}]) {
    assert.equal(gestureSchema.safeParse({ points, ...invalid }).success, false);
  }
});

test('closed path and hold are transmitted once; injection acknowledgement stays distinct from app success', () => {
  let count = 0;
  const result = performGesture({ shell: (_, ...args) => {
    count++;
    assert.equal(args.at(-1), 'dev.gc.agentphone.helper/.GestureInstrumentation');
    const payload = JSON.parse(Buffer.from(args[args.indexOf('payload')+1], 'base64').toString());
    assert.deepEqual(payload, { points, durationMs:1200, holdMs:300, expectedPackage:'org.example' });
    return 'INSTRUMENTATION_RESULT: phone_result_b64=' + Buffer.from(JSON.stringify({ok:true,pointerReleased:true,terminalAction:'up',evidence:'injection only'})).toString('base64');
  } }, 'device', { points, durationMs:1200, holdMs:300, expectedPackage:'org.example' });
  assert.equal(count, 1);
  assert.equal(result.verified, undefined);
  assert.equal(result.evidence, 'injection only');
});

test('missing, refused or unreleased gesture results fail without automatic replay', () => {
  for (const payload of [null, {ok:false,error:'cancel attempted'}, {ok:true,pointerReleased:false}]) {
    let count=0;
    assert.throws(() => performGesture({ shell: () => {
      count++;
      return payload ? 'phone_result_b64='+Buffer.from(JSON.stringify(payload)).toString('base64') : 'Helper not installed';
    } }, 'device', {points}));
    assert.equal(count,1);
  }
});
