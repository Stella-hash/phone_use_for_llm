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
$directory=[System.IO.Directory]::Exists($p)
${set ? `$acl=if ($directory) { [System.Security.AccessControl.DirectorySecurity]::new() } else { [System.Security.AccessControl.FileSecurity]::new() }
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true,$false)
foreach ($who in @($sid,$system)) {
  $inherit=if ($directory) { 'ContainerInherit,ObjectInherit' } else { 'None' }
  $rule=[System.Security.AccessControl.FileSystemAccessRule]::new($who,'FullControl',$inherit,'None','Allow')
  $acl.AddAccessRule($rule)
}
if ($directory) { [System.IO.Directory]::SetAccessControl($p,$acl) } else { [System.IO.File]::SetAccessControl($p,$acl) }` : ""}
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
  if (!fresh && fs.existsSync(target)) assertPrivate(target);
  fs.writeFileSync(target, value, { mode: 0o600, flag: fresh ? "wx" : "w" });
  // Elevated Windows tokens can default new files to the Administrators owner.
  // Set the individual owner explicitly, keeping the same restricted DACL.
  if (process.platform === "win32") windowsAcl(target, true);
}

/** Tighten files created by SQLite inside the already validated owner directory. */
export function protectDatabaseFiles(directory: string) {
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = path.join(directory, "activity.sqlite3" + suffix);
    noLinks(file);
    if (!fs.existsSync(file)) continue;
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("Invalid database file");
    if (process.platform === "win32") windowsAcl(file, true);
    else fs.chmodSync(file, 0o600);
  }
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
