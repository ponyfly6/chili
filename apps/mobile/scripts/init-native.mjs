import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const edit = (file, transform) => {
  const path = resolve(root, file);
  const before = readFileSync(path, "utf8");
  const after = transform(before);
  if (after !== before) writeFileSync(path, after);
};
for (const platform of ["ios", "android"]) {
  if (!existsSync(resolve(root, platform))) execFileSync("bun", ["x", "cap", "add", platform], { cwd: root, stdio: "inherit" });
}
// Keep the native bridge source in one maintained location outside generated
// projects. A normal cap sync preserves these project references.
edit("ios/App/App.xcodeproj/project.pbxproj", (source) => {
  source = source.replaceAll("IPHONEOS_DEPLOYMENT_TARGET = 15.0;", "IPHONEOS_DEPLOYMENT_TARGET = 17.0;");
  if (source.includes("C11111111111111111111111")) return source;
  return source
    .replace("/* End PBXBuildFile section */", "\t\tC11111111111111111111111 /* ChiliNativePlugin.swift in Sources */ = {isa = PBXBuildFile; fileRef = C22222222222222222222222 /* ChiliNativePlugin.swift */; };\n/* End PBXBuildFile section */")
    .replace("/* End PBXFileReference section */", '\t\tC22222222222222222222222 /* ChiliNativePlugin.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; name = ChiliNativePlugin.swift; path = ../../../native/ios/ChiliNativePlugin.swift; sourceTree = "<group>"; };\n/* End PBXFileReference section */')
    .replace("504EC3071FED79650016851F /* AppDelegate.swift */,", "504EC3071FED79650016851F /* AppDelegate.swift */,\n\t\t\t\tC22222222222222222222222 /* ChiliNativePlugin.swift */,")
    .replace("504EC3081FED79650016851F /* AppDelegate.swift in Sources */,", "504EC3081FED79650016851F /* AppDelegate.swift in Sources */,\n\t\t\t\tC11111111111111111111111 /* ChiliNativePlugin.swift in Sources */,");
});
edit("ios/App/App/Base.lproj/Main.storyboard", (source) => source.replace('customClass="CAPBridgeViewController" customModule="Capacitor"', 'customClass="ChiliViewController" customModule="App" customModuleProvider="target"'));
edit("ios/App/App/SceneDelegate.swift", (source) => source.replace("window?.rootViewController = CAPBridgeViewController()", "window?.rootViewController = ChiliViewController()"));
edit("ios/App/App/AppDelegate.swift", (source) => source.replace("@UIApplicationMain", "@main"));
edit("ios/App/App/Info.plist", (source) => source.includes("NSLocalNetworkUsageDescription") ? source : source.replace("<dict>", "<dict>\n\t<key>NSLocalNetworkUsageDescription</key>\n\t<string>Chili connects to your paired desktop to view and continue your tasks.</string>"));
// Commit a shared app scheme: Xcode stops auto-generating App after adding the
// explicit XCTest scheme. Keep signing accounts and teams out of both schemes.
const appScheme = resolve(root, "ios/App/App.xcodeproj/xcshareddata/xcschemes/App.xcscheme");
if (!existsSync(appScheme)) {
  mkdirSync(dirname(appScheme), { recursive: true });
  writeFileSync(appScheme, `<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="2700" version="1.7">
  <BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES">
    <BuildActionEntries>
      <BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">
        <BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="504EC3031FED79650016851F" BuildableName="App.app" BlueprintName="App" ReferencedContainer="container:App.xcodeproj" />
      </BuildActionEntry>
    </BuildActionEntries>
  </BuildAction>
  <TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES">
    <Testables />
  </TestAction>
  <LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" allowLocationSimulation="YES">
    <BuildableProductRunnable runnableDebuggingMode="0"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="504EC3031FED79650016851F" BuildableName="App.app" BlueprintName="App" ReferencedContainer="container:App.xcodeproj" /></BuildableProductRunnable>
  </LaunchAction>
  <ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" savedToolIdentifier="" useCustomWorkingDirectory="NO" debugDocumentVersioning="YES">
    <BuildableProductRunnable runnableDebuggingMode="0"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="504EC3031FED79650016851F" BuildableName="App.app" BlueprintName="App" ReferencedContainer="container:App.xcodeproj" /></BuildableProductRunnable>
  </ProfileAction>
  <AnalyzeAction buildConfiguration="Debug" />
  <ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES" />
</Scheme>
`);
}
edit("android/app/src/main/java/dev/chili/mobile/MainActivity.java", (source) => source.includes("registerPlugin(ChiliNativePlugin.class)") ? source : source.replace("public class MainActivity extends BridgeActivity {}", `public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(ChiliNativePlugin.class);
        super.onCreate(savedInstanceState);
    }
}`));
edit("android/app/build.gradle", (source) => source.includes("../../native/android") ? source : source.replace("android {", "android {\n    sourceSets.main.java.srcDirs += '../../native/android'"));
edit("android/app/src/main/AndroidManifest.xml", (source) => {
  source = source.replace('android:allowBackup="true"', 'android:allowBackup="false"')
    .replace('android:usesCleartextTraffic="true"', 'android:usesCleartextTraffic="false"');
  if (!source.includes('android:usesCleartextTraffic="false"')) source = source.replace('<application\n', '<application\n        android:usesCleartextTraffic="false"\n');
  if (!source.includes("android:networkSecurityConfig=")) source = source.replace('<application\n', '<application\n        android:networkSecurityConfig="@xml/network_security_config"\n');
  return source;
});
const networkSecurityConfig = resolve(root, "android/app/src/main/res/xml/network_security_config.xml");
if (!existsSync(networkSecurityConfig)) writeFileSync(networkSecurityConfig, `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <!-- Private desktop hosts may use a CA explicitly installed by the user.
         The platform still validates certificate chains, validity and names. -->
    <base-config cleartextTrafficPermitted="false">
        <trust-anchors>
            <certificates src="system" />
            <certificates src="user" />
        </trust-anchors>
    </base-config>
</network-security-config>
`);
console.log("Chili native projects are ready; build the web bundle, then run cap sync.");
