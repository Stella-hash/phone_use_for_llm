"""Synthetic compiler/signing sinks: verifies packaging, never creates a real APK."""
import importlib.util
import pathlib
import shutil
import tempfile
import types
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('helper_builder', pathlib.Path(__file__).with_name('build-android-helper.py'))
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class BuildTests(unittest.TestCase):
    def test_fresh_classes_explicit_signing_and_verification(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp) / 'source'
            root.mkdir()
            source = root / 'android-helper/src'
            source.mkdir(parents=True)
            (source.parent / 'AndroidManifest.xml').write_text('<application android:debuggable="false" />')
            for name in ['Keep', 'Removed']:
                (source / (name + '.java')).write_text('// synthetic compiler input')
            sdk = root / 'sdk'
            sdk.mkdir()
            (sdk / 'source.properties').write_text('Pkg.Revision=34.0.0\nAndroidVersion.ApiLevel=34\n')
            args = types.SimpleNamespace(jdk=root, platform=sdk, build_tools=sdk, output=root / 'first.apk',
                                         development=False, keystore=pathlib.Path(tmp) / 'owner.p12',
                                         storepass_file=pathlib.Path(tmp) / 'owner-password.key', key_alias='owner')
            commands, manifests, dex_inputs = [], [], []
            reject_verify = False

            def sink(command, cwd):
                command = [str(c) for c in command]
                commands.append(command)
                if '--version' in command:
                    return 'javac 17.0.1'
                if command[0] == 'node':
                    if 'privateDirectory' in command[3]:
                        pathlib.Path(command[-1]).mkdir(parents=True, exist_ok=True)
                    return ''
                if '-d' in command:
                    dest = pathlib.Path(command[command.index('-d') + 1])
                    for file in command:
                        if file.endswith('.java'):
                            (dest / (pathlib.Path(file).stem + '.class')).write_bytes(b'synthetic class')
                elif 'com.android.tools.r8.D8' in command:
                    inputs = sorted(pathlib.Path(c).name for c in command if c.endswith('.class'))
                    dex_inputs.append(inputs)
                    (pathlib.Path(command[command.index('--output') + 1]) / 'classes.dex').write_text(','.join(inputs))
                elif 'link' in command:
                    manifests.append(pathlib.Path(command[command.index('--manifest') + 1]).read_text())
                    with zipfile.ZipFile(command[command.index('-o') + 1], 'w'):
                        pass
                elif '-f' in command:
                    shutil.copyfile(command[-2], command[-1])
                elif 'sign' in command:
                    shutil.copyfile(command[-1], command[command.index('--out') + 1])
                elif 'verify' in command and reject_verify:
                    raise ValueError('synthetic verification failure')
                return ''

            original = builder.run
            builder.run = sink
            try:
                builder.build_helper(args, root)
                (source / 'Removed.java').unlink()
                args.output = root / 'second.apk'
                builder.build_helper(args, root)
                self.assertEqual(dex_inputs, [['Keep.class', 'Removed.class'], ['Keep.class']])
                self.assertTrue(all('debuggable="false"' in m for m in manifests))
                self.assertFalse(any('keytool' in c[0] or 'pass:android' in ' '.join(c) for c in commands))
                self.assertEqual(list((root / '.runtime/helper-builds').iterdir()), [])
                reject_verify = True
                args.output = root / 'failed.apk'
                with self.assertRaisesRegex(ValueError, 'verification failure'):
                    builder.build_helper(args, root)
                self.assertFalse(args.output.exists())
                args.keystore = None
                with self.assertRaisesRegex(ValueError, 'Release requires'):
                    builder.build_helper(args, root)
                (sdk / 'source.properties').write_text('Pkg.Revision=33.0.0\nAndroidVersion.ApiLevel=34\n')
                with self.assertRaisesRegex(ValueError, 'build-tools 34'):
                    builder.build_helper(args, root)
            finally:
                builder.run = original


if __name__ == '__main__':
    unittest.main()
