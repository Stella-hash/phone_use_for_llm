# Optional helper source build

No prebuilt APK is distributed. Synthetic packaging tests do not validate Android
compatibility, real SDK compilation, installation or instrumented input.

Build the TypeScript service first (`pnpm build`). Use Python 3.11+, JDK 17,
Android platform API 34 and build-tools 34. The script validates version metadata
and creates a fresh temporary classes/dex directory each time. It signs and
verifies before copying to a new output filename. Failed verification produces
no output APK. Old build directories are never inputs.

The owner creates a signing keystore and password file in a private directory
outside the checkout, using the platform's signing tools. These files are not
agent configuration or repository files. Use a private, existing output directory:

```sh
python scripts/build-android-helper.py --jdk JDK_DIR --platform PLATFORM_DIR --build-tools BUILD_TOOLS_DIR --keystore /private/owner.p12 --storepass-file /private/store-password.key --key-alias OWNER_ALIAS --output /private/helper-v1.apk
```

The password is read by the signing tool from its file, never passed as a literal
command-line secret. Release manifests disable debugging. Protect and retain the
signing identity for intentional updates; no project-wide signing key exists.

For disposable local experiments only, replace the three signing arguments with
`--development`. This explicitly enables debugging and generates a fresh random
password and ephemeral key in the private temporary directory. Those files are
removed when the build exits. Such an APK cannot update an installation signed
by an earlier ephemeral identity. Do not publish it or treat it as a release.

The script never invokes ADB, enumerates devices or installs an APK. Installation
and device acceptance need their own owner-authorized check.

The public companion also includes `UiSnapshotInstrumentation`, a one-shot
read-only active-root snapshot for explicitly configured `uiSnapshotApps`.
It retains the non-debuggable release manifest and existing signing rules.
No idle-screen guarantee, persistent accessibility service or private-development
helper version is implied. See [dynamic native pages](SHORT-DELEGATION.md#dynamic-native-pages).
