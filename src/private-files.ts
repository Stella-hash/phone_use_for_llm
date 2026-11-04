import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

// Storage is private to the host OS account. That account (and host administrators)
// remains trusted; this is not a sandbox against processes running as the owner.
export function noLinks(target: string) {
  for (let p = path.resolve(target); ; p = path.dirname(p)) {
    if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) throw new Error("Storage links are not allowed");
    if (path.dirname(p) === p) break;
  }
}

function windowsAcl(target: string, set: boolean) {
  const script = `$ErrorActionPreference='Stop'
$p=$env:PHONE_ACL_TARGET
$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system=[System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
if ([System.IO.File]::GetAttributes($p) -band [System.IO.FileAttributes]::ReparsePoint) { throw 'links forbidden' }
${set ? `$acl=[System.Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true,$false)
foreach ($who in @($sid,$system)) {
  $rule=[System.Security.AccessControl.FileSystemAccessRule]::new($who,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
  $acl.AddAccessRule($rule)
}
[System.IO.Directory]::SetAccessControl($p,$acl)` : ""}
$acl=if ([System.IO.Directory]::Exists($p)) { [System.IO.Directory]::GetAccessControl($p) } else { [System.IO.File]::GetAccessControl($p) }
foreach ($rule in $acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin @($sid.Value,$system.Value)) { throw 'not private' }
}
if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'wrong owner' }
`;
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: { ...process.env, PHONE_ACL_TARGET: path.resolve(target) }, windowsHide: true, timeout: 10000, stdio: "pipe",
    });
  } catch { throw new Error("Private Windows ACL required; use the owner setup command"); }
}

export function assertPrivate(target: string) {
  noLinks(target);
  const stat = fs.statSync(target);
  if (process.platform === "win32") windowsAcl(target, false);
  else if ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error("Owner-only permissions required");
}

export function privateDirectory(target: string) {
  noLinks(target);
  if (!fs.existsSync(target) || (fs.statSync(target).isDirectory() && fs.readdirSync(target).length === 0)) {
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    if (process.platform === "win32") windowsAcl(target, true);
    else fs.chmodSync(target, 0o700);
  }
  assertPrivate(target);
  return path.resolve(target);
}

export function writePrivate(target: string, value: string | Buffer, fresh = true) {
  noLinks(target);
  fs.writeFileSync(target, value, { mode: 0o600, flag: fresh ? "wx" : "w" });
}

export function readPrivate(target: string, maxBytes: number) {
  return readPrivateSnapshot(target, maxBytes).text;
}

export function readPrivateSnapshot(target: string, maxBytes: number) {
  assertPrivate(target);
  const identity = (s: fs.BigIntStats) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(":");
  const before = fs.lstatSync(target, { bigint: true });
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.size > BigInt(maxBytes) || stat.nlink !== 1n || identity(before) !== identity(stat)) throw new Error("Invalid private file");
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0, bytes: number;
    while (length < buffer.length && (bytes = fs.readSync(fd, buffer, length, buffer.length - length, null)) > 0) length += bytes;
    if (length > maxBytes || identity(stat) !== identity(fs.fstatSync(fd, { bigint: true }))
      || identity(stat) !== identity(fs.lstatSync(target, { bigint: true }))) throw new Error("Private file changed during read");
    assertPrivate(target);
    const data = buffer.subarray(0, length);
    return { text: data.toString("utf8"), identity: identity(stat), digest: createHash("sha256").update(data).digest("hex") };
  } finally { fs.closeSync(fd); }
}
