"""Fetch a pinned official scanner binary; verify SHA-256 before writing it."""
import hashlib
import io
import os
import pathlib
import platform
import sys
import tarfile
import urllib.request
import zipfile

assets = {
    'Windows': ('windows_x64.zip', 'd29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e', 'gitleaks.exe'),
    'Linux': ('linux_x64.tar.gz', '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb', 'gitleaks'),
}
if platform.machine().lower() not in ['amd64', 'x86_64']:
    raise SystemExit('Pinned installer supports x64 only')
asset, digest, name = assets[platform.system()]
url = 'https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_' + asset
data = urllib.request.urlopen(url, timeout=60).read()
if hashlib.sha256(data).hexdigest() != digest:
    raise SystemExit('Scanner checksum mismatch')
if asset.endswith('.zip'):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        binary = archive.read(name)
else:
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        binary = archive.extractfile(name).read()
target = pathlib.Path(sys.argv[1]).resolve()
target.mkdir(parents=True, exist_ok=True)
with (target / name).open('wb') as output:
    output.write(binary)
os.chmod(target / name, 0o700)
print('Installed checksum-verified Gitleaks 8.30.1')
