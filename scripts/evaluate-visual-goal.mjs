// Explicit, read-only image evaluation. Does not connect to or wake a phone.
// The manifest and selected images are private input; only judgments are printed.
import fs from 'node:fs';
import path from 'node:path';
import { VisualJudge, decisionKey, visualFrame } from '../dist/decisions.js';

if (process.argv.length !== 4 || process.argv[2] !== '--send-selected-images')
  throw new Error('Usage: node scripts/evaluate-visual-goal.mjs --send-selected-images PRIVATE_MANIFEST.json');
const manifestPath = path.resolve(process.argv[3]);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (!Array.isArray(manifest.images) || manifest.images.length < 1 || manifest.images.length > 6)
  throw new Error('Select 1–6 images per explicit evaluation');
const load = item => visualFrame(fs.readFileSync(path.resolve(path.dirname(manifestPath), item.file)), manifest.expectedPackage, item.capturedAt);
const frames = manifest.images.map(load);
const reference = manifest.reference ? load(manifest.reference) : frames[0];
const judge = new VisualJudge(decisionKey());
for (const [index, frame] of frames.entries()) {
  const decision = await judge.evaluate(reference, frame, manifest.target, manifest.goal);
  console.log(JSON.stringify({ index, imageId: frame.id, width: frame.width, height: frame.height, decision }));
  if (/^http_|request_failed/.test(decision.reason)) break;
}
