"""Build the tiny Android helper using JDK 17 and Android SDK build-tools 34.

Usage: python scripts/build-android-helper.py --jdk DIR --platform DIR --build-tools DIR
The signing key and output APK remain in .runtime; no Gradle or external Java libraries.
"""
import argparse, os, pathlib, subprocess, zipfile
root = pathlib.Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--jdk', type=pathlib.Path, required=True)
parser.add_argument('--platform', type=pathlib.Path, required=True)
parser.add_argument('--build-tools', type=pathlib.Path, required=True)
args = parser.parse_args()
runtime = root / '.runtime'
build = runtime / 'helper-build'
classes, dex = build / 'classes', build / 'dex'
classes.mkdir(parents=True, exist_ok=True)
dex.mkdir(exist_ok=True)
exe = '.exe' if os.name == 'nt' else ''
def java(name): return str(args.jdk / 'bin' / (name + exe))
def run(command): subprocess.run([str(x) for x in command], check=True, cwd=root)
android = args.platform / 'android.jar'
sources = sorted((root / 'android-helper/src').rglob('*.java'))
run([java('javac'), '-encoding', 'UTF-8', '-source', '8', '-target', '8', '-classpath', android, '-d', classes, *sources])
run([java('java'), '-cp', args.build_tools / 'lib/d8.jar', 'com.android.tools.r8.D8', '--lib', android, '--min-api', '26', '--output', dex, *sorted(classes.rglob('*.class'))])
unsigned, aligned, final = build / 'unsigned.apk', build / 'aligned.apk', runtime / 'agent-phone-input.apk'
run([args.build_tools / ('aapt2' + exe), 'link', '-I', android, '--manifest', root / 'android-helper/AndroidManifest.xml', '-o', unsigned])
with zipfile.ZipFile(unsigned, 'a') as archive: archive.write(dex / 'classes.dex', 'classes.dex')
run([args.build_tools / ('zipalign' + exe), '-f', '4', unsigned, aligned])
key = runtime / 'helper-signing.p12'
if not key.exists():
    run([java('keytool'), '-genkeypair', '-keystore', key, '-storepass', 'android', '-keypass', 'android', '-alias', 'agent-phone', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000', '-dname', 'CN=Agent Phone Local Development'])
signer = [java('java'), '-jar', args.build_tools / 'lib/apksigner.jar']
run([*signer, 'sign', '--ks', key, '--ks-pass', 'pass:android', '--out', final, aligned])
run([*signer, 'verify', final])
print('Verified APK:', final)
