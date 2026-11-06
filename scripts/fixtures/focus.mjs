import { AdbClient } from '../../dist/adb.js';

// Minimal synthetic Android 14 WMS protobufs. No device dump or real owner data.
const varint = number => {
  let value = BigInt(number); const result = [];
  do { const byte = Number(value & 127n); value >>= 7n; result.push(byte | (value ? 128 : 0)); } while (value);
  return Buffer.from(result);
};
export const pack = (...fields) => Buffer.concat(fields.flat());
export const scalar = (field, value) => pack(varint(field * 8), varint(value));
export const bytes = (field, value) => {
  const buffer = typeof value === 'string' ? Buffer.from(value) : value;
  return pack(varint(field * 8 + 2), varint(buffer.length), buffer);
};
export function identity({ hash = 0x1234, userId = 0, title = 'org.example.game/.MainActivity' } = {}) {
  return pack(scalar(1, hash), userId ? scalar(2, userId) : [], bytes(3, title));
}
export function focusProto(options = {}) {
  const displayId = options.displayId ?? 0;
  const window = bytes(1, bytes(6, options.displayFocus ?? identity(options.current)));
  const display = bytes(3, pack(displayId ? scalar(2, displayId) : [], scalar(26, 1),
    bytes(30, pack(window, displayId ? scalar(3, displayId) : []))));
  const root = bytes(2, bytes(1, pack(bytes(5, display), options.extraDisplay ? bytes(5, display) : [])));
  return pack(root, bytes(3, options.rootFocus ?? identity(options.current)), options.extraFocus ? bytes(3, identity()) : [],
    displayId ? scalar(9, displayId) : []);
}
export function windowDetails({ hash = 0x1234, userId = 0, title = 'org.example.game/.MainActivity',
  displayId = 0, uid = 10123, packageName = 'org.example.game' } = {}) {
  return 'WINDOW MANAGER WINDOWS (dumpsys window windows)\n' +
    `  Window #0 Window{${hash.toString(16)} u${userId} ${title}}:\n` +
    `    mDisplayId=${displayId} rootTaskId=7 mSession=Session{synthetic} mClient=synthetic\n` +
    `    mOwnerUid=${uid} showForAllUsers=false package=${packageName} appop=NONE\n` +
    '    mAttrs={synthetic}\n';
}
export function focusAdb(options = {}) {
  const adb = new AdbClient(), commands = []; let reads = 0;
  adb.adb = (_serial, ...command) => {
    commands.push(command);
    if (command.join(' ') === 'get-state') return Buffer.from('device\n');
    if (command.join(' ') !== 'exec-out dumpsys window --proto') throw Error('Unexpected binary focus query');
    if (options.fail === 'proto') throw Error('Synthetic focus query failure');
    return options.snapshots ? options.snapshots[Math.min(reads++, options.snapshots.length - 1)] : options.proto ?? focusProto(options);
  };
  adb.shell = (_serial, ...command) => {
    commands.push(command);
    if (command.length === 3 && command[0] === 'dumpsys' && command[1] === 'window' && /^[a-f0-9]+$/.test(command[2])) {
      if (options.fail === 'owner') throw Error('Synthetic owner query failure');
      return options.details ?? windowDetails({ ...options.current, ...options.owner });
    }
    if (command.slice(0, 4).join(' ') === 'cmd package list packages') {
      if (options.fail === 'packages') throw Error('Synthetic package query failure');
      return options.packages ?? `package:${options.owner?.packageName ?? 'org.example.game'} uid:${options.owner?.uid ?? 10123}\n`;
    }
    if (command.join(' ') === 'dumpsys power') return 'mWakefulness=Awake';
    if (command.join(' ') === 'dumpsys window policy') return 'showing=false';
    if (command.join(' ') === 'dumpsys input') return 'Viewport INTERNAL: displayId=0, orientation=0, logicalFrame=[0, 0, 100, 200], isActive=[1]';
    throw Error('Unexpected command in synthetic focus fixture');
  };
  return { adb, commands };
}
