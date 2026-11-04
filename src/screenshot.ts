import { ActionableError } from "./adb.js";

const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function requirePng(bytes: Buffer): Buffer {
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(signature)
    || bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR"
    || bytes.readUInt32BE(16) === 0 || bytes.readUInt32BE(20) === 0
    || bytes.toString("ascii", bytes.length - 8, bytes.length - 4) !== "IEND") {
    throw new ActionableError("Screenshot unavailable: the device did not return a complete PNG. A protected or unavailable surface is possible; the cause is unconfirmed. No image is claimed.");
  }
  return bytes;
}
