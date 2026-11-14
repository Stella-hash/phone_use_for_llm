#!/usr/bin/env node
// Test the production ownership component from the canonical patch stack.
// No app build, host launch, IOKit operation or phone is involved.
import { execFileSync } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { locations, upstream } from './phone.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = locations(repo).source;
const scratch = await mkdtemp(path.join(os.tmpdir(), 'phone-use-capture-check-'));
const git = args => execFileSync('git', args, {
  cwd: source, env: { ...process.env, GIT_INDEX_FILE: path.join(scratch, 'index') },
});
let passed = false;
try {
  git(['read-tree', upstream.commit]);
  for (const patch of (await readdir(path.join(repo, 'ios/patches'))).filter(n => n.endsWith('.patch')).sort()) {
    git(['apply', '--cached', path.join(repo, 'ios/patches', patch)]);
  }
  const tree = git(['write-tree']).toString().trim();
  await mkdir(path.join(scratch, 'Sources/iPhoneUse'), { recursive: true });
  await mkdir(path.join(scratch, 'Tests/iPhoneUseTests'), { recursive: true });
  await writeFile(path.join(scratch, 'Sources/iPhoneUse/CaptureLifecycleOwnership.swift'),
    git(['show', `${tree}:Sources/iPhoneUse/Capture/CaptureLifecycleOwnership.swift`]));
  await cp(path.join(repo, 'ios/validation/CaptureLifecycleOwnershipTests.swift'),
    path.join(scratch, 'Tests/iPhoneUseTests/CaptureLifecycleOwnershipTests.swift'));
  await writeFile(path.join(scratch, 'Package.swift'), `// swift-tools-version: 6.0
import PackageDescription
let package = Package(name: "CaptureLifecycleCheck", platforms: [.macOS(.v14)], targets: [
  .target(name: "iPhoneUse", swiftSettings: [.swiftLanguageMode(.v5)]),
  .testTarget(name: "iPhoneUseTests", dependencies: ["iPhoneUse"], swiftSettings: [.swiftLanguageMode(.v5)])
])
`);
  const swiftc = await realpath(execFileSync('xcrun', ['--find', 'swiftc'], { encoding: 'utf8' }).trim());
  const plugin = path.resolve(path.dirname(swiftc), '../lib/swift/host/plugins/testing/libTestingMacros.dylib');
  await access(plugin); // Fail explicitly if this selected toolchain lacks Swift Testing macros.
  console.log(`Production capture ownership source tree: ${tree}`);
  execFileSync('swift', ['test', '--disable-sandbox', '-Xswiftc', '-load-plugin-library', '-Xswiftc', plugin], {
    cwd: scratch, stdio: 'inherit',
    env: { ...process.env, CLANG_MODULE_CACHE_PATH: path.join(scratch, 'clang-cache'),
      SWIFT_MODULECACHE_PATH: path.join(scratch, 'swift-cache') },
  });
  passed = true;
} finally {
  if (passed) await rm(scratch, { recursive: true });
  else console.error(`Failed capture lifecycle check retained at ${scratch}`);
}
