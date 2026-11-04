import { AdbClient } from "./adb.js";
import { withDeadline } from "./deadline.js";

const thermalLabels = ["none", "light", "moderate", "severe", "critical", "emergency", "shutdown"];
const numberField = (text: string, key: string): number | null => {
  const value = text.match(new RegExp(`^\\s*${key}:\\s*(-?\\d+(?:\\.\\d+)?)\\s*$`, "m"))?.[1];
  return value === undefined ? null : Number(value);
};
const booleanField = (text: string, key: string): boolean | null => {
  const value = text.match(new RegExp(`^\\s*${key}:\\s*(true|false)\\s*$`, "m"))?.[1];
  return value === undefined ? null : value === "true";
};

export function parsePower(power: string, battery: string, thermal: string) {
  const level = numberField(battery, "level");
  const scale = numberField(battery, "scale");
  const temperature = numberField(battery, "temperature");
  const thermalStatus = numberField(thermal, "Thermal Status");
  const lastWake = power.match(/^\s*mLastWakeTime=(\d+)/m)?.[1];
  return {
    power: { source: "dumpsys power", wakefulness: power.match(/^\s*mWakefulness=(\w+)/m)?.[1] ?? null,
      lastWakeUptimeMs: lastWake === undefined ? null : Number(lastWake) },
    battery: { source: "dumpsys battery", level, scale,
      percent: level !== null && scale !== null && scale > 0 ? level / scale * 100 : null,
      temperatureC: temperature === null ? null : temperature / 10,
      status: numberField(battery, "status"), health: numberField(battery, "health"),
      acPowered: booleanField(battery, "AC powered"), usbPowered: booleanField(battery, "USB powered"),
      wirelessPowered: booleanField(battery, "Wireless powered"),
      updatesStopped: battery.trim() ? /UPDATES STOPPED/.test(battery) : null },
    thermal: { source: "dumpsys thermalservice", status: thermalStatus,
      label: thermalStatus === null ? null : thermalLabels[thermalStatus] ?? "unknown",
      statusOverride: booleanField(thermal, "IsStatusOverride"),
      note: "Framework throttling report, not a temperature measurement or proof that an earlier heat warning is resolved." },
  };
}

/** No input, window dismissal, UI automation, screenshot or instrumentation. */
export function readPowerStatus(adb: AdbClient, device: string) {
  const startedAt = new Date().toISOString();
  const errors: { source: string; error: string }[] = [];
  const read = (service: string) => {
    try { return withDeadline(3000, () => adb.shell(device, "dumpsys", service)); }
    catch { errors.push({ source: service, error: "unavailable" }); return ""; }
  };
  const data = parsePower(read("power"), read("battery"), read("thermalservice"));
  for (const [source, missing] of [["power", data.power.wakefulness === null],
    ["battery", data.battery.temperatureC === null], ["thermalservice", data.thermal.status === null]] as const) {
    if (missing && !errors.some(error => error.source === source)) errors.push({ source, error: "Requested reading was not reported" });
  }
  return { startedAt, at: new Date().toISOString(), wakeRequested: false, ...data, errors };
}
