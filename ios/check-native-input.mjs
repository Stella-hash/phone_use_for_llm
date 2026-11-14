#!/usr/bin/env node
// Offline production-source acceptance for Macs whose CLT omits XCTest.
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { locations } from './phone.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const paths = locations(repo);
const git = args => execFileSync('git', args, { cwd: paths.source });
// Test the exact assembled index; never silently omit an uncommitted source edit.
git(['diff', '--quiet']);
if (git(['ls-files', '--others', '--exclude-standard']).length) throw Error('Untracked native source must be accounted for before this check.');
const tree = git(['write-tree']).toString().trim();
const scratch = await mkdtemp(path.join(await realpath(os.tmpdir()), 'phone-use-native-check-'));
let passed = false;
try {
  const archive = path.join(scratch, 'native-source.tar');
  git(['archive', '--output', archive, tree]);
  execFileSync('tar', ['-xf', archive, '-C', scratch]);
  await rm(archive);
  const tests = path.join(scratch, 'Tests/iPhoneUseTests');
  await rm(tests, { recursive: true });
  await mkdir(tests);
  for (const name of await readdir(path.join(repo, 'ios/validation'))) {
    if (name.endsWith('.swift')) await cp(path.join(repo, 'ios/validation', name), path.join(tests, name));
  }
  const developer = execFileSync('xcode-select', ['-p'], { encoding: 'utf8' }).trim();
  const plugin = path.join(developer, 'usr/lib/swift/host/plugins/testing/libTestingMacros.dylib');
  console.log(`Offline native source tree: ${tree}`);
  execFileSync('swift', ['test', '--disable-sandbox', '--scratch-path', path.join(scratch, '.build'),
    '-Xswiftc', '-load-plugin-library', '-Xswiftc', plugin], {
    cwd: scratch, stdio: 'inherit',
    env: { ...process.env, PHONE_USE_TEST_PYTHON: paths.usbPython,
      CLANG_MODULE_CACHE_PATH: path.join(scratch, 'clang-cache'), SWIFT_MODULECACHE_PATH: path.join(scratch, 'swift-cache') },
  });
  passed = true;
} finally {
  if (passed) await rm(scratch, { recursive: true });
  else console.error(`Failed offline check retained at ${scratch}`);
}
