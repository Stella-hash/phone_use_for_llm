import fs from 'node:fs';
import path from 'node:path';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { privateDirectory, writePrivate } from '../../dist/private-files.js';
import { signApproval, readTools } from '../../dist/security.js';

export function fixtureOwner(directory, overrides = {}) {
  privateDirectory(directory);
  const root = privateDirectory(path.join(directory, 'owner-config'));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const token = randomBytes(32).toString('base64url');
  const config = { version: 1, ownerId: 'synthetic-owner', tokenFile: 'token.key', dataDirectory: '../journal',
    approvalPublicKey: publicKey.export({ format: 'pem', type: 'spki' }),
    allowedApps: ['com.android.chrome', 'org.example.game'], allowedDomains: ['fixture.example'], retainObservationText: true,
    ...overrides };
  writePrivate(path.join(root, 'token.key'), token);
  const file = path.join(root, 'security.json');
  writePrivate(file, JSON.stringify(config));
  const headers = { Authorization: `Bearer ${token}` };
  const authorize = request => {
    const name = request.name, args = { ...request.arguments };
    if (!readTools.has(name) || (name === 'android_device_info' && args.wake)) {
      args.requestId ||= randomUUID();
      if (name !== 'android_device_info') args.expectedPackage ||= 'com.android.chrome';
      if (name !== 'android_device_info' && name !== 'android_press_key') args.expectedUrl ||= 'https://fixture.example/page';
      args.approval = signApproval(privateKey, config.ownerId, name, args, Date.now() + 120000);
    } else if (!name.startsWith('android_activity_') && !['android_device_info','android_power_status'].includes(name)) {
      args.expectedUrl ||= 'https://fixture.example/page';
    }
    return { ...request, arguments: args };
  };
  const wrap = client => {
    const original = client.callTool.bind(client);
    client.callTool = (request, ...rest) => original(authorize(request), ...rest);
    return client;
  };
  return { file, headers, privateKey, config, authorize, wrap, token };
}
