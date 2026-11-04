"""Build from a fresh directory; never install or discover devices.

Requires JDK 17, Android API 34 and build-tools 34. Release builds require an
owner-supplied keystore and password file outside the source tree. Development
mode is explicit and uses an ephemeral signing identity, unsuitable for updates.
"""
import argparse
import os
import pathlib
import re
import secrets
import subprocess
import tempfile
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]


def run(command, root=ROOT):
    return subprocess.run([str(x) for x in command], check=True, cwd=root,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True).stdout


def private_file(target, root=ROOT):
    run(['node', '--input-type=module', '-e',
         "import {readPrivate} from './dist/private-files.js'; readPrivate(process.argv[1], 65536);", target], root)


def build_helper(args, root=ROOT):
    exe = '.exe' if os.name == 'nt' else ''
    java = lambda name: args.jdk / 'bin' / (name + exe)
    if not re.match(r'javac 17(?:\.|\s|$)', run([java('javac'), '--version'], root).strip()):
        raise ValueError('JDK 17 required')
    props = (args.build_tools / 'source.properties').read_text()
    platform = (args.platform / 'source.properties').read_text()
    if not re.search(r'^Pkg.Revision\s*=\s*34\.', props, re.M) or not re.search(r'^AndroidVersion.ApiLevel\s*=\s*34\s*$', platform, re.M):
        raise ValueError('Android platform 34 and build-tools 34 required')
    runtime = root / '.runtime'
    run(['node', '--input-type=module', '-e',
         "import {privateDirectory} from './dist/private-files.js'; privateDirectory(process.argv[1]);", runtime / 'helper-builds'], root)
    output = args.output.resolve()
    if output.exists():
        raise ValueError('Output already exists; choose a fresh output filename')
    run(['node', '--input-type=module', '-e',
         "import {assertPrivate} from './dist/private-files.js'; assertPrivate(process.argv[1]);", output.parent], root)
    if not args.development:
        if not args.keystore or not args.storepass_file or not args.key_alias:
            raise ValueError('Release requires --keystore, --storepass-file and --key-alias')
        for file in [args.keystore, args.storepass_file]:
            if file.resolve().is_relative_to(root.resolve()):
                raise ValueError('Release signing material must be outside the source tree')
            private_file(file, root)
    with tempfile.TemporaryDirectory(prefix='build-', dir=runtime / 'helper-builds') as temp:
        build = pathlib.Path(temp)
        classes, dex = build / 'classes', build / 'dex'
        classes.mkdir()
        dex.mkdir()
        android = args.platform / 'android.jar'
        sources = sorted((root / 'android-helper/src').rglob('*.java'))
        if not sources:
            raise ValueError('No helper source files')
        run([java('javac'), '-encoding', 'UTF-8', '-source', '8', '-target', '8', '-classpath', android, '-d', classes, *sources], root)
        run([java('java'), '-cp', args.build_tools / 'lib/d8.jar', 'com.android.tools.r8.D8', '--lib', android, '--min-api', '26', '--output', dex, *sorted(classes.rglob('*.class'))], root)
        manifest = build / 'AndroidManifest.xml'
        xml = (root / 'android-helper/AndroidManifest.xml').read_text()
        if 'android:debuggable="false"' not in xml:
            raise ValueError('Release manifest must disable debugging')
        manifest.write_text(xml.replace('android:debuggable="false"', 'android:debuggable="true"') if args.development else xml)
        unsigned, aligned, signed = build / 'unsigned.apk', build / 'aligned.apk', build / 'signed.apk'
        run([args.build_tools / ('aapt2' + exe), 'link', '-I', android, '--manifest', manifest, '-o', unsigned], root)
        with zipfile.ZipFile(unsigned, 'a') as archive:
            archive.write(dex / 'classes.dex', 'classes.dex')
        run([args.build_tools / ('zipalign' + exe), '-f', '4', unsigned, aligned], root)
        key, password, alias = args.keystore, args.storepass_file, args.key_alias
        if args.development:
            key, password, alias = build / 'development.p12', build / 'password.key', 'local-development'
            password.write_text(secrets.token_urlsafe(32))
            password.chmod(0o600)
            run([java('keytool'), '-genkeypair', '-keystore', key, '-storepass:file', password, '-keypass:file', password,
                 '-alias', alias, '-keyalg', 'RSA', '-keysize', '2048', '-validity', '365', '-dname', 'CN=Disposable Local Development'], root)
        signer = [java('java'), '-jar', args.build_tools / 'lib/apksigner.jar']
        run([*signer, 'sign', '--ks', key, '--ks-key-alias', alias, '--ks-pass', 'file:' + str(password), '--out', signed, aligned], root)
        run([*signer, 'verify', '--verbose', signed], root)
        with output.open('xb') as target:
            output.chmod(0o600)
            target.write(signed.read_bytes())
    print('Verified local development APK:' if args.development else 'Verified locally signed APK:', output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['jdk', 'platform', 'build-tools', 'output']:
        parser.add_argument('--' + name, type=pathlib.Path, required=True)
    parser.add_argument('--development', action='store_true')
    parser.add_argument('--keystore', type=pathlib.Path)
    parser.add_argument('--storepass-file', type=pathlib.Path)
    parser.add_argument('--key-alias')
    try:
        build_helper(parser.parse_args())
    except subprocess.CalledProcessError:
        raise SystemExit('Helper build tool failed; no verified APK was published')


if __name__ == '__main__':
    main()
