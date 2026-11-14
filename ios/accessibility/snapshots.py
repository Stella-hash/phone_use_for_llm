"""Private, bounded cache of complete AX observations for local detail readers.

Only capture-UUID.json files belong to this cache. Existing historical AX
archives in the same directory are never removed or rewritten.
"""
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import uuid

MAX_RAW_BYTES = 256 * 1024 + 4096
MAX_FILES = 256
MAX_CACHE_BYTES = 64 * 1024 * 1024
ID_PATTERN = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
OWNED_NAME = re.compile(r"capture-(" + ID_PATTERN + r")\.json\Z")
DEFAULT_DIRECTORY = Path(__file__).resolve().parents[2] / ".runtime/iphone-use/ax"


class SnapshotError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def directory(environment=None):
    state = (environment if environment is not None else os.environ).get("IPHONE_USE_STATE_DIR")
    if state is not None:
        if not isinstance(state, str) or not os.path.isabs(state) or "\0" in state:
            raise SnapshotError("invalid_archive_directory")
        return Path(state).parent / "ax"
    return DEFAULT_DIRECTORY


def _id(value):
    if not isinstance(value, str) or re.fullmatch(ID_PATTERN, value) is None:
        raise SnapshotError("invalid_snapshot_id")
    return value


def _json_bytes(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")


@contextmanager
def _locked(root):
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if root.is_symlink() or not root.is_dir():
        raise SnapshotError("invalid_archive_directory")
    os.chmod(root, 0o700)
    fd = os.open(root / "capture-cache.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        # A stale held lock cannot delay a phone read indefinitely.
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(fd)


def _prune(root, keep):
    entries = []
    for file in root.iterdir():
        if OWNED_NAME.fullmatch(file.name):
            info = file.lstat()
            if stat.S_ISREG(info.st_mode):
                entries.append((info.st_mtime_ns, file, info.st_size))
    entries.sort(key=lambda item: (item[0], item[1].name))
    total = sum(item[2] for item in entries)
    count = len(entries)
    for _, file, size in entries:
        if count <= MAX_FILES and total <= MAX_CACHE_BYTES:
            break
        if file.name == keep:
            continue
        file.unlink()
        count -= 1
        total -= size


def save_snapshot(raw, root=None):
    root = Path(root) if root is not None else directory()
    try:
        if not isinstance(raw, dict) or raw.get("source") != "ios-native-ax" or raw.get("status") not in ("ok", "unavailable"):
            raise SnapshotError("invalid_native_source")
        snapshot_id = str(uuid.uuid4())
        stored = dict(raw)
        stored["local_snapshot"] = {"id": snapshot_id, "captured_at": datetime.now(timezone.utc).isoformat()}
        data = _json_bytes(stored)
        if len(data) > MAX_RAW_BYTES:
            raise SnapshotError("archive_size_limit")
        name = f"capture-{snapshot_id}.json"
        with _locked(root):
            fd = os.open(root / name, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
            try:
                with os.fdopen(fd, "wb") as stream:
                    stream.write(data)
                _prune(root, name)
            except Exception:
                # This path belongs only to the still-unpublished new snapshot.
                (root / name).unlink(missing_ok=True)
                raise
        return {"status": "saved", "snapshot_id": snapshot_id,
                "raw_path": str((root / name).absolute()), "raw_bytes": len(data)}
    except (OSError, ValueError, TypeError, SnapshotError) as exc:
        return {"status": "failed", "raw_path": None,
                "error_code": exc.code if isinstance(exc, SnapshotError) else "archive_write_failed"}


def read_snapshot(snapshot_id, root=None):
    snapshot_id = _id(snapshot_id)
    root = Path(root) if root is not None else directory()
    file = root / f"capture-{snapshot_id}.json"
    try:
        fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_RAW_BYTES:
                raise SnapshotError("invalid_snapshot_file")
            data = stream.read(MAX_RAW_BYTES + 1)
        if len(data) > MAX_RAW_BYTES:
            raise SnapshotError("invalid_snapshot_file")
        raw = json.loads(data)
        if (not isinstance(raw, dict) or raw.get("local_snapshot", {}).get("id") != snapshot_id
                or raw.get("source") != "ios-native-ax" or raw.get("status") not in ("ok", "unavailable")):
            raise SnapshotError("invalid_snapshot_file")
        return raw, {"status": "saved", "snapshot_id": snapshot_id,
                     "raw_path": str(file.absolute()), "raw_bytes": len(data)}
    except FileNotFoundError:
        raise SnapshotError("snapshot_unavailable") from None
    except (OSError, ValueError, TypeError, AttributeError):
        raise SnapshotError("invalid_snapshot_file") from None
