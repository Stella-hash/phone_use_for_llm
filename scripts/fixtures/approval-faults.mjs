// Test-only filesystem faults, loaded explicitly into the synthetic signer child.
// The production CLI has no fault-injection switches.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const scenario = process.env.PHONE_TEST_APPROVAL_FAULT;
const isReview = file => path.basename(path.dirname(String(file))).startsWith('approval-review-');
const isStage = file => path.basename(String(file)).startsWith('.approval-output-');
const write = fs.writeFileSync;
fs.writeFileSync = (file, ...args) => {
  const result = write(file, ...args);
  if ((scenario === 'review-write-failed' && isReview(file)) || (scenario === 'stage-write-failed' && isStage(file)))
    throw Error('Synthetic approval write failure');
  return result;
};
const unlink = fs.unlinkSync;
fs.unlinkSync = (file, ...args) => {
  if (scenario === 'review-cleanup-failed' && isReview(file)) throw Error('Synthetic review cleanup failure');
  return unlink(file, ...args);
};
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
  if (isStage(from)) {
    // At the sole publication point, review files are gone, the complete staged
    // approval exists, and the destination contains only our empty reservation.
    assert(!fs.readdirSync(path.dirname(to)).some(name => name.startsWith('approval-review-')));
    assert.equal(fs.readFileSync(to, 'utf8'), '');
    assert(JSON.parse(fs.readFileSync(from, 'utf8')).arguments.approval.signature);
    if (scenario === 'output-publish-failed') throw Error('Synthetic approval publication failure');
  }
  return rename(from, to);
};
