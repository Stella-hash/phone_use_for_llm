import fs from "node:fs";
import path from "node:path";
import { createHash, createPublicKey, timingSafeEqual, verify, sign, type KeyObject } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";
import { privateDirectory, readPrivate, writePrivate } from "./private-files.js";
import { strictJson } from "./json.js";
import { DEFAULT_KEEPSAKE_BYTES, DEFAULT_KEEPSAKE_COUNT } from "./keepsakes.js";
import { canonical, canonicalArguments, touchTools, expertGrantableTools, passiveTools, readTools, isInputOperation, isPowerKey } from "./operation.js";
export { canonical, touchTools, passiveTools, readTools } from "./operation.js";

export class PolicyError extends Error {
  constructor(public code: string) { super(code); }
}
export const deny = (code: string): never => { throw new PolicyError(code); };
const packageName = z.string().max(200).regex(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/);
const toolName = z.string().max(80).regex(/^android_[a-z_]+$/);
const configSchema = z.object({
  version: z.literal(1), ownerId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  tokenFile: z.string().min(1).max(1024), dataDirectory: z.string().min(1).max(1024),
  approvalPublicKey: z.string().min(40).max(2048),
  allowedApps: z.array(packageName).max(64).default([]),
  allowedDomains: z.array(z.string().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/)).max(64).default([]),
  browserPackage: z.literal("com.android.chrome").default("com.android.chrome"),
  retainObservationText: z.boolean().default(false),
  allowModelSummary: z.boolean().default(false),
  screenshotKeepsakes: z.object({ enabled: z.boolean().default(false),
    maxBytes: z.number().int().min(1).max(16 * 1024 * 1024 * 1024).default(DEFAULT_KEEPSAKE_BYTES),
    maxCount: z.number().int().min(1).max(10000).default(DEFAULT_KEEPSAKE_COUNT),
  }).strict().default({ enabled: false, maxBytes: DEFAULT_KEEPSAKE_BYTES, maxCount: DEFAULT_KEEPSAKE_COUNT }),
  gameGrants: z.array(z.object({ package: packageName, tools: z.array(toolName).max(7),
    disposableOfflineGame: z.literal(true) }).strict()).max(16).default([]),
  expertSandbox: z.object({
    trustedOperators: z.literal(true), disposablePhone: z.literal(true), isolatedEnvironment: z.literal(true),
    acceptsRisk: z.literal(true), grants: z.array(z.object({ package: packageName, tools: z.array(toolName).max(26) }).strict()).max(64),
  }).strict().optional(),
}).strict();
export type SecurityConfig = z.infer<typeof configSchema>;

export function approvalMessage(ownerId: string, tool: string, args: Record<string, unknown>, expiresAt: number) {
  const boundArgs = canonicalArguments(tool, args);
  return canonical({ version: 1, ownerId, tool, args: boundArgs, expiresAt });
}
export function signApproval(key: string | KeyObject, ownerId: string, tool: string, args: Record<string, unknown>, expiresAt: number) {
  return { expiresAt, signature: sign(null, Buffer.from(approvalMessage(ownerId, tool, args, expiresAt)), key).toString("base64url") };
}

export class OwnerSecurity {
  readonly config: SecurityConfig;
  readonly directory: string;
  private tokenHash: Buffer;
  private approvalKey: KeyObject;
  constructor(filename: string | undefined) {
    if (!filename) throw new Error("PHONE_SECURITY_FILE is required; run owner setup before starting");
    try {
      this.config = configSchema.parse(strictJson(readPrivate(filename, 32 * 1024)));
      const base = path.dirname(path.resolve(filename));
      const token = readPrivate(path.resolve(base, this.config.tokenFile), 256).trim();
      if (!/^[A-Za-z0-9_-]{43,128}$/.test(token)) throw new Error();
      this.tokenHash = createHash("sha256").update(token).digest();
      this.approvalKey = createPublicKey(this.config.approvalPublicKey);
      if (this.approvalKey.asymmetricKeyType !== "ed25519") throw new Error();
      for (const grant of this.config.gameGrants) {
        if (!this.config.allowedApps.includes(grant.package) || grant.package === this.config.browserPackage || grant.tools.some(t => !touchTools.has(t))) throw new Error();
      }
      for (const grant of this.config.expertSandbox?.grants || []) {
        if (!this.config.allowedApps.includes(grant.package) || grant.tools.some(t => !expertGrantableTools.has(t))) throw new Error();
      }
      this.directory = privateDirectory(path.resolve(base, this.config.dataDirectory));
      const marker = path.join(this.directory, "owner.json");
      if (!fs.existsSync(marker)) {
        if (fs.readdirSync(this.directory).length) throw new Error();
        writePrivate(marker, JSON.stringify({ ownerId: this.config.ownerId }));
      } else if (JSON.parse(readPrivate(marker, 512)).ownerId !== this.config.ownerId) throw new Error();
    } catch { throw new Error("Invalid owner security configuration, permissions or data ownership"); }
  }
  authenticate(header: string | undefined) {
    if (!header || !/^Bearer [A-Za-z0-9_-]{43,128}$/.test(header)) return false;
    return timingSafeEqual(createHash("sha256").update(header.slice(7)).digest(), this.tokenHash);
  }
  isInput(name: string, args: Record<string, unknown>) { return isInputOperation(name, args); }
  package(pkg: unknown) {
    if (typeof pkg !== "string" || !this.config.allowedApps.includes(pkg)) deny("APP_NOT_ALLOWED");
  }
  url(value: unknown) {
    let url: URL;
    try { url = new URL(String(value)); } catch { return deny("URL_NOT_ALLOWED"); }
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || isIP(url.hostname)
      || !this.config.allowedDomains.includes(url.hostname) || /(?:^|\.)(localhost|local|internal|lan|home|test|invalid)$/.test(url.hostname)) deny("URL_NOT_ALLOWED");
    return url.href;
  }
  authorize(name: string, args: Record<string, unknown>) {
    if (name === "android_screenshot_keep" || name === "android_screenshot_keepsakes") {
      if (!this.config.screenshotKeepsakes.enabled) deny("KEEPSAKES_DISABLED");
      if (name === "android_screenshot_keep") {
        if ((args.context as any)?.private === true) deny("PRIVATE_CALL_CANNOT_SAVE_KEEPSAKE");
        if (typeof args.requestId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(args.requestId)) deny("REQUEST_ID_REQUIRED");
      } else if (args.requestId !== undefined) deny("REQUEST_ID_INPUT_ONLY");
      return; // Local owner opt-in grants host archival only, never phone input.
    }
    if (!this.isInput(name, args)) {
      if (!name.startsWith("android_activity_") && args.requestId !== undefined) deny("REQUEST_ID_INPUT_ONLY");
      return;
    }
    if (typeof args.requestId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(args.requestId)) deny("REQUEST_ID_REQUIRED");
    // Power transitions have no app target, and always require explicit owner approval.
    const power = name === "android_device_info" || (name === "android_press_key" && isPowerKey(args.key));
    if (!power) this.package(args.expectedPackage);
    const preapproved = !power && expertGrantableTools.has(name) && [...this.config.gameGrants, ...(this.config.expertSandbox?.grants || [])]
      .some(g => g.package === args.expectedPackage && g.tools.includes(name));
    if (preapproved) return;
    const grant = args.approval as any;
    if (!grant || !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt < Date.now() || grant.expiresAt > Date.now() + 300000
      || typeof grant.signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(grant.signature)) deny("OWNER_APPROVAL_REQUIRED");
    if (!verify(null, Buffer.from(approvalMessage(this.config.ownerId, name, args, grant.expiresAt)), this.approvalKey, Buffer.from(grant.signature, "base64url"))) deny("OWNER_APPROVAL_INVALID");
  }
}
