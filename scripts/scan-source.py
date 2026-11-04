"""Scan a precise Git tree export with two independent local secret detectors.

Usage: python scripts/scan-source.py HEAD GITLEAKS_BINARY
Use --index instead of HEAD for a staged, not yet committed tree.
Findings are summarized by location/type, never by secret value.
"""
import io
import hashlib
import json
import pathlib
import re
import subprocess
import sys
import tempfile
import zipfile

root = pathlib.Path(__file__).resolve().parents[1]
reference, scanner = sys.argv[1], pathlib.Path(sys.argv[2]).resolve()
tree = subprocess.check_output(['git', 'write-tree'] if reference == '--index' else ['git', 'rev-parse', reference + '^{tree}'], cwd=root, text=True).strip()
archive = subprocess.check_output(['git', 'archive', '--format=zip', tree], cwd=root)
runtime = root / '.runtime'
runtime.mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(prefix='source-scan-', dir=runtime) as tmp:
    directory = pathlib.Path(tmp)
    source = directory / 'source'
    source.mkdir()
    with zipfile.ZipFile(io.BytesIO(archive)) as zipped:
        for item in zipped.infolist():
            member = pathlib.PurePosixPath(item.filename)
            if member.is_absolute() or '..' in member.parts or (item.external_attr >> 16) & 0o170000 == 0o120000:
                raise SystemExit('Unsafe source archive entry')
        zipped.extractall(source)
    report = directory / 'gitleaks.json'
    leaks = subprocess.run([str(scanner), 'dir', str(source), '--no-banner', '--redact', '--report-format', 'json', '--report-path', str(report)], capture_output=True, text=True)
    findings = json.loads(report.read_text()) if report.exists() else []
    if leaks.returncode not in (0, 1):
        raise SystemExit('Gitleaks did not complete')
    if leaks.returncode or findings:
        print(json.dumps({'scanner': 'gitleaks', 'findings': [{'file': pathlib.Path(f['File']).name, 'line': f['StartLine'], 'rule': f['RuleID']} for f in findings]}))
        raise SystemExit(1)
    detect = subprocess.run([sys.executable, '-m', 'detect_secrets', 'scan', '--all-files', '--no-verify', '.'], cwd=source, capture_output=True, text=True)
    if detect.returncode:
        raise SystemExit('detect-secrets did not complete')
    data = json.loads(detect.stdout)
    # The baseline is a list of reviewed non-secret fingerprints, not raw values.
    baseline_file = source / 'scripts/secret-scan-baseline.json'
    baseline = json.loads(baseline_file.read_text()) if baseline_file.exists() else []
    allowed = {(f['file'], f['type'], f['hash']) for f in baseline}
    fingerprint_hashes = {hashlib.sha1(f['hash'].encode()).hexdigest() for f in baseline}
    def reviewed_nonsecret(file, finding):
        if (file, finding['type'], finding['hashed_secret']) in allowed:
            return True
        if file == 'scripts/secret-scan-baseline.json' and finding['type'] == 'Hex High Entropy String' and finding['hashed_secret'] in fingerprint_hashes:
            return True  # fingerprint of a reviewed literal, not a new value
        if file == 'pnpm-lock.yaml' and finding['type'] == 'Base64 High Entropy String':
            line = (source / file).read_text().splitlines()[finding['line_number'] - 1]
            return bool(re.fullmatch(r'\s+resolution: \{integrity: sha512-[A-Za-z0-9+/]{86}==\}', line))
        return False
    pending = [{'file': file.replace('\\', '/'), 'line': f['line_number'], 'type': f['type'], 'hash': f['hashed_secret']} for file, rows in data['results'].items() for f in rows
               if not reviewed_nonsecret(file.replace('\\', '/'), f)]
    print(json.dumps({'tree': tree, 'gitleaks': 'passed', 'detect_secrets_new_findings': pending, 'reviewed_nonsecret_fingerprints': len(baseline)}))
    if pending:
        raise SystemExit(1)
