# Chili Mobile

Installable iOS and Android companions using Capacitor 8.5.2. The app bundles
the same React control interface as `apps/control-web`; no remote page or
`server.url` is loaded into the privileged WebView. The desktop continues to own
the agent runtime and tasks.

## Develop and build

From the repository root:

```sh
bun install
bun run --cwd apps/mobile native:init
bun run --cwd apps/mobile typecheck
bun run --cwd apps/mobile test
bun run --cwd apps/mobile sync
bun run --cwd apps/mobile ios
```

`native:init` creates missing platforms and wires the maintained files under
`native/` into the native projects. It is idempotent and does not install a
remote URL or certificate exception. Commit the native projects with changes to
the bridge. `sync` rebuilds the local UI and updates Capacitor dependencies.

iOS requires macOS, Node 22+, Xcode 26+ and iOS 17+ for the protocol's WebCrypto
algorithms. Swift Package Manager is used
instead of CocoaPods. The project is `ios/App/App.xcodeproj`; the committed shared
`App` scheme builds and runs the app, while `ChiliNativeTests` runs native tests.
`native:init` recreates the shared app scheme if missing.
Use local ad-hoc signing for a simulator; it requires no Apple Developer account
and permits the simulator Keychain to recognize the app. An unsigned simulator
build can render the UI but cannot validate secure storage:

```sh
xcodebuild -project apps/mobile/ios/App/App.xcodeproj -scheme App \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath /tmp/chili-mobile-build \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- build
```

For a physical iPhone, select your own Apple Developer team and a unique bundle
ID in Xcode; the default is `dev.chili.mobile`. Device signing, TestFlight and
App Store publication are separate steps. No account or signing secrets are
included in this project.

For a paired physical device, a command-line development build can use your own
Team ID as an argument without saving it in the project. Automatic provisioning
requires a signed-in Xcode account with permission for that team and device:

```sh
xcodebuild -project apps/mobile/ios/App/App.xcodeproj -scheme App \
  -configuration Debug -destination 'id=<paired iPhone UDID>' \
  -derivedDataPath apps/mobile/ios/device-build \
  -allowProvisioningUpdates DEVELOPMENT_TEAM='<your Team ID>' \
  CODE_SIGN_IDENTITY='Apple Development' build
```

The signed app appears at
`apps/mobile/ios/device-build/Build/Products/Debug-iphoneos/App.app`. This command
builds the app; it does not install it. The device must trust this Mac and have
Developer Mode enabled before installation and launch. Build output and signing
profiles are not committed.

Android requires JDK 21, Android SDK platform 36, platform-tools and build-tools
36.0.0. Android Studio is optional for command-line builds. Set `ANDROID_HOME` to
your SDK, or create an ignored `android/local.properties` with `sdk.dir=...`.
Then run `./gradlew assembleDebug` inside `apps/mobile/android`. The debug APK is
written to `android/app/build/outputs/apk/debug/app-debug.apk`. Minimum Android
version for the native shell is API 24; the installed Android System WebView
must also support all protocol cryptography, including Ed25519. Pairing fails
closed if those algorithms are unavailable; a low Android API level alone is
not a compatibility guarantee. Release signing is intentionally not configured.

## Connect

Enter the private **HTTPS origin** shown in the desktop phone connection panel,
then the current one-time pairing code. Confirm the device on the desktop. The
phone must be able to reach that address, with its certificate trusted normally
by the operating system. A private network or VPN can provide reachability; the
app itself does not create a public relay or bypass certificate validation.

Android explicitly trusts both system CAs and CAs the user has installed in the
same Android profile as Chili. This app-wide declarative configuration supports
private desktop addresses chosen at runtime; every such installed CA is a trust
anchor for this app's HTTPS connections. Android apps targeting API 24+ otherwise
trust only system CAs by default. See the [Android network security configuration
reference](https://developer.android.com/privacy-and-security/security-config).
Chili installs no CA automatically and accepts no arbitrary self-signed server
certificate. Certificate chains, validity and the requested hostname/IP's SAN
must still pass platform validation, and cleartext traffic remains disabled.
Browser clients follow their own browser/profile certificate trust settings.

The trusted device record is stored securely so the app can request fresh
authorization after relaunch. Recovery remains bounded by the desktop grant's
expiry and host lifetime. It does not keep a desktop awake or resume tasks after
the desktop process exits. Removing authorization clears the secure record.

## Native boundaries

- `src/platform.ts` injects native transport, secure storage and foreground
  events into the shared control UI. Browser users keep their separate same
  origin, memory-only behavior.
- `native/ios/ChiliNativePlugin.swift` uses the iOS Keychain with
  `AfterFirstUnlockThisDeviceOnly`, no iCloud synchronization, and normal TLS
  validation via an ephemeral `URLSession`.
- `native/android/ChiliNativePlugin.java` uses a non-exportable Android Keystore
  AES-GCM key. Authenticated ciphertext is written atomically in
  `noBackupFilesDir`; authorization is never put in Capacitor Preferences,
  localStorage or plaintext files. App backup and cleartext traffic are disabled.
  `android/app/src/main/res/xml/network_security_config.xml` declares the system
  and user-installed CA sources used by normal platform TLS validation.
- HTTP is restricted to HTTPS POSTs under `/api/`, allowed protocol headers,
  bounded request/response sizes, and explicit cancellation. Redirects are
  rejected. The native bridge does not install a TLS trust override. The shared
  protocol additionally binds requests to the selected host origin.
- Uncertain write outcomes are saved before submission. Reopening or reconnecting
  retains a reminder to inspect the task; it does not automatically resend a
  prompt, answer, or stop request.
- The bundled page's CSP prevents browser fetches to remote origins and remote
  frames/scripts. Only the native HTTPS adapter performs control requests.

Current scope is task control and recovery. APNs/FCM push, audio capture, screen
streaming, whole-desktop control, public relays and store release are not part of
this build. Unit tests exercise the transport contract; native builds and
simulator checks are not a substitute for physical iOS/Android network, locked
screen, certificate and process-recovery testing.

Icons and launch graphics reuse `assets/brand` artwork. They are checked in.
After changing that source artwork, macOS maintainers can run
`node apps/mobile/scripts/brand-assets.mjs` to regenerate the required sizes.

## iOS native verification

`ChiliNativeTests` is a non-UI XCTest target. It checks the real Keychain across
plugin instances, update/delete, trusted and untrusted HTTPS, cookie omission,
redirect refusal, native response bounds and cancellation. It also checks the
actual SceneDelegate's controller, calls `ChiliNative` through that controller's
WKWebView, and exercises Ed25519 signatures, X25519 shared-secret agreement and
HKDF/AES-GCM in WebCrypto. There
is no debug command or test endpoint in the production app.

Use a **disposable simulator** that already trusts a temporary localhost test
CA (for example, one created with `scripts/mobile-native-fixture.ts`). Certificate
and key must match `127.0.0.1`. The runner creates separate trusted and untrusted
HTTPS fixtures and does not install any CA or modify system trust:

```sh
bun run --cwd apps/mobile sync
CHILI_TEST_SIMULATOR_ID='<disposable simulator UUID>' \
CHILI_NATIVE_TEST_CERT='<absolute path to localhost.pem>' \
CHILI_NATIVE_TEST_KEY='<absolute path to localhost-key.pem>' \
  bun run --cwd apps/mobile test:ios
```

The temporary fixture config is included only in the test bundle and is ignored
by Git. Results appear in `apps/mobile/ios/build/NativeTests-*.xcresult`.

Verified on 2026-10-07: TypeScript checking, the bundled Vite build, six transport
contract tests, and seven native XCTest cases on a disposable iOS 26.5 simulator
with local ad-hoc signing. An iPhoneOS development build also passed signature
verification with a provisioning profile containing the selected test device.
Physical iPhone installation and real-device background/network recovery are
unverified. Android project generation/sync is
complete, but an Android APK build and device run have not been verified because
this workstation has no Android SDK.

Official platform references: [Capacitor environment setup](https://capacitorjs.com/docs/getting-started/environment-setup),
[custom iOS plugin registration](https://capacitorjs.com/docs/ios/custom-code),
[Android Keystore](https://developer.android.com/privacy-and-security/keystore).
