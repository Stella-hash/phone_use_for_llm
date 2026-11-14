# USB Python dependencies

`node ios/phone.mjs setup-usb` installs into the ignored
`.runtime/iphone-use/usb-venv` only. It refuses a running iPhone Use host and
checks that the interpreter belongs to that virtual environment. An existing
environment using another Python version is preserved and rejected; recreate it
with CPython 3.12 before retrying.

The supported package profiles are CPython 3.12 on macOS 14 or newer:

| Interpreter architecture | Frozen requirements |
| --- | --- |
| Apple Silicon `arm64` | [requirements-usb-macos-arm64.lock](requirements-usb-macos-arm64.lock) |
| Intel `x86_64` | [requirements-usb-macos-x86_64.lock](requirements-usb-macos-x86_64.lock) |

The launcher selects the lock from the interpreter's actual architecture.
Other Python minor versions, operating systems and architectures are rejected.
The locks do not establish iPhone model, iOS version or private API compatibility.

[requirements-usb.txt](requirements-usb.txt) is the direct dependency input,
not the install list. Each lock pins all 92 resolved packages and includes
artifact SHA-256 hashes. Setup uses `uv pip sync --require-hashes --no-build
--strict`, so it removes packages outside the selected lock, validates downloaded
artifacts and refuses source builds instead of fetching unlocked build tools.
It does not resolve new package versions. Hashes identify accepted artifact bytes;
they do not establish package safety or recheck files changed after installation.

The initial locks were generated with uv 0.12.18, preserving the existing
CPython 3.12 package baseline where wheels are available. The profiles differ:
arm64 uses `cryptography==50.0.2`; Intel uses `cryptography==48.0.1` because the
newer version has no usable Intel wheel for this target. Cross-platform resolution
checks wheel availability, not native execution; Intel execution belongs to the
hosted macOS Intel workflow. CI installs with the same managed setup command.

Python helpers are launched in isolated mode. The managed launcher removes
inherited `PYTHON*` settings; setup also removes ambient `UV_*`, `PIP_*` and
virtual-environment selectors and disables uv configuration discovery. Helpers
must add only their own trusted adjacent-module directory when needed. User-site
packages and a shell's `PYTHONPATH` are not extension points for this integration.

To regenerate, use uv 0.12.18 from the repository root with ambient `UV_*`, `PIP_*`
and `PYTHON*` overrides unset:

```sh
MACOSX_DEPLOYMENT_TARGET=14.0 uv --no-config pip compile ios/requirements-usb.txt --python-version 3.12 --python-platform aarch64-apple-darwin --generate-hashes --no-build --default-index https://pypi.org/simple --output-file ios/requirements-usb-macos-arm64.lock
MACOSX_DEPLOYMENT_TARGET=14.0 uv --no-config pip compile ios/requirements-usb.txt --python-version 3.12 --python-platform x86_64-apple-darwin --generate-hashes --no-build --default-index https://pypi.org/simple --output-file ios/requirements-usb-macos-x86_64.lock
```

Existing lock versions are retained by default. Use `--upgrade-package NAME`
only for an intentional dependency update, review both profile diffs, and run
the launcher/helper tests plus hash-checked sync in a disposable environment.
Do not edit hashes to make a failed installation pass.

See [uv's locking and sync documentation](https://docs.astral.sh/uv/pip/compile/)
for the distinction between installing direct requirements and syncing a complete
locked environment.
