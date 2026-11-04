import path from "node:path";
import fs from "node:fs";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { privateDirectory, writePrivate } from "./private-files.js";

export function createOwnerSetup(directory: string, signerDirectory: string, ownerId: string) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(ownerId)) throw new Error("Invalid owner ID");
  const root = path.resolve(directory), signer = path.resolve(signerDirectory);
  const relative = path.relative(root, signer);
  if (!relative || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative))) throw new Error("Keep the approval signing key outside the service directory");
  if ([root, signer].some(p => fs.existsSync(p) && fs.readdirSync(p).length)) throw new Error("Setup requires two empty directories");
  privateDirectory(root); privateDirectory(signer);
  const pair = generateKeyPairSync("ed25519");
  writePrivate(path.join(root, "token.key"), randomBytes(32).toString("base64url"));
  writePrivate(path.join(signer, "approval.key"), pair.privateKey.export({ type: "pkcs8", format: "pem" }));
  writePrivate(path.join(root, "security.json"), JSON.stringify({ version: 1, ownerId, tokenFile: "token.key", dataDirectory: "data",
    approvalPublicKey: pair.publicKey.export({ type: "spki", format: "pem" }), allowedApps: [], allowedDomains: [],
    retainObservationText: false, allowModelSummary: false, gameGrants: [] }, null, 2) + "\n");
  return { securityFile: path.join(root, "security.json"), approvalKeyFile: path.join(signer, "approval.key") };
}
