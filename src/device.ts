/** Pure configuration validation; never discovers, connects or queries a device. */
export function localDeviceSerial(value: unknown): string {
  const serial = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(serial) || /_adb[.-]|_adb[-_]tls|_adb_secure|\._tcp\b/i.test(serial))
    throw new Error("PHONE_DEVICE must be a dedicated USB serial or local emulator; wireless ADB serials are not supported");
  return serial;
}
