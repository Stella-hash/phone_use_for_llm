import test from 'node:test';
import assert from 'node:assert/strict';
import { delayObservation } from '../dist/observation-delay.js';
import { withDeadline, remainingTime } from '../dist/deadline.js';

test('observation delay waits within the parent deadline and reports actual elapsed time',async()=>{
  await withDeadline(12000,async()=>{
    const before=remainingTime();
    const result=await delayObservation(35);
    assert.equal(result.status,'elapsed'); assert.equal(result.requestedMs,35);
    assert(result.elapsedMs>=30);
    assert(remainingTime()<before);
  });
});

test('a constrained or expired parent preserves the observation budget rather than resetting it',async()=>{
  await withDeadline(10025,async()=>{
    const result=await delayObservation(5000);
    assert.equal(result.status,'budget_limited');
    assert(result.elapsedMs<250); assert(remainingTime()>9500);
  });
  const expired=await withDeadline(-1,()=>delayObservation(2000));
  assert.equal(expired.status,'budget_limited'); assert.equal(expired.elapsedMs,0);
});

test('zero delay succeeds without sleeping; invalid durations are rejected',async()=>{
  assert.deepEqual(await delayObservation(0),{requestedMs:0,elapsedMs:0,status:'elapsed'});
  for(const value of [-1,0.5,5001,NaN,'2000',null])
    await assert.rejects(()=>delayObservation(value),/integer between 0 and 5000/);
});
