import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const cliRequire = createRequire(require.resolve("@capacitor/cli/package.json"));
const xcode = cliRequire("xcode");
const path = resolve(root, "ios/App/App.xcodeproj/project.pbxproj");
const project = xcode.project(path).parseSync();
const objects = project.hash.project.objects;
let target = Object.entries(objects.PBXNativeTarget).find(([, value]) => typeof value === "object" && value.name === '"ChiliNativeTests"');
let testId = target?.[0];
const appId = "504EC3031FED79650016851F";
if (!testId) {
  const appDependencies = [...objects.PBXNativeTarget[appId].dependencies];
  objects.PBXTargetDependency ??= {};
  objects.PBXContainerItemProxy ??= {};
  const added = project.addTarget("ChiliNativeTests", "unit_test_bundle", "ChiliNativeTests", "dev.chili.mobile.tests");
  testId = added.uuid;
  // xcode's helper defaults to app -> target for app extensions. Unit tests
  // need the opposite direction so normal app builds never build tests.
  objects.PBXNativeTarget[appId].dependencies = appDependencies;
  project.addTargetDependency(testId, [appId]);
  project.addBuildPhase([], "PBXSourcesBuildPhase", "Sources", testId);
  project.addBuildPhase([], "PBXResourcesBuildPhase", "Resources", testId);
  project.addBuildPhase([], "PBXFrameworksBuildPhase", "Frameworks", testId);
  const group = project.addPbxGroup([], "ChiliNativeTests", "../../native/ios/Tests");
  project.addToPbxGroup(group.uuid, project.getFirstProject().firstProject.mainGroup);
  project.addSourceFile("ChiliNativeTests.swift", { target: testId }, group.uuid);
  const fixture = project.addFile("FixtureConfig.json", group.uuid);
  fixture.target = testId;
  fixture.uuid = project.generateUuid();
  project.addToPbxBuildFileSection(fixture);
  project.addToPbxResourcesBuildPhase(fixture);
  const settingsList = objects.XCConfigurationList[added.pbxNativeTarget.buildConfigurationList];
  for (const entry of settingsList.buildConfigurations) {
    const settings = objects.XCBuildConfiguration[entry.value].buildSettings;
    delete settings.INFOPLIST_FILE;
    Object.assign(settings, { GENERATE_INFOPLIST_FILE: "YES", IPHONEOS_DEPLOYMENT_TARGET: "17.0", SWIFT_VERSION: "5.0",
      TARGETED_DEVICE_FAMILY: '"1,2"', TEST_HOST: '"$(BUILT_PRODUCTS_DIR)/App.app/App"', BUNDLE_LOADER: '"$(TEST_HOST)"',
      CODE_SIGN_STYLE: "Automatic", SWIFT_EMIT_LOC_STRINGS: "NO" });
  }
  const packageProduct = "4D22ABE82AF431CB00220026";
  added.pbxNativeTarget.packageProductDependencies = [{ value: packageProduct, comment: "CapApp-SPM" }];
  const buildId = project.generateUuid();
  objects.PBXBuildFile[buildId] = { isa: "PBXBuildFile", productRef: packageProduct, productRef_comment: "CapApp-SPM" };
  objects.PBXBuildFile[buildId + "_comment"] = "CapApp-SPM in Frameworks";
  const framework = project.pbxFrameworksBuildPhaseObj(testId);
  framework.files.push({ value: buildId, comment: "CapApp-SPM in Frameworks" });
}
objects.PBXTargetDependency ??= {};
objects.PBXContainerItemProxy ??= {};
if (objects.PBXNativeTarget[testId].dependencies.length === 0) project.addTargetDependency(testId, [appId]);
const productId = objects.PBXNativeTarget[testId].productReference;
objects.PBXFileReference[productId].name = '"ChiliNativeTests.xctest"';
objects.PBXFileReference[productId].path = '"ChiliNativeTests.xctest"';
objects.PBXFileReference[productId].explicitFileType = '"wrapper.cfbundle"';
objects.PBXFileReference[productId + "_comment"] = "ChiliNativeTests.xctest";
for (const section of Object.values(objects)) for (const object of Object.values(section)) {
  if (object && typeof object === "object") for (const [key, value] of Object.entries(object)) if (value === undefined || value === "undefined") delete object[key];
}
writeFileSync(path, project.writeSync());
const schemes = resolve(root, "ios/App/App.xcodeproj/xcshareddata/xcschemes");
mkdirSync(schemes, { recursive: true });
writeFileSync(resolve(schemes, "ChiliNativeTests.xcscheme"), `<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="2700" version="1.7">
  <BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES">
    <BuildActionEntries>
      <BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="NO" buildForArchiving="NO" buildForAnalyzing="YES">
        <BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="${appId}" BuildableName="App.app" BlueprintName="App" ReferencedContainer="container:App.xcodeproj" />
      </BuildActionEntry>
      <BuildActionEntry buildForTesting="YES" buildForRunning="NO" buildForProfiling="NO" buildForArchiving="NO" buildForAnalyzing="YES">
        <BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="${testId}" BuildableName="ChiliNativeTests.xctest" BlueprintName="ChiliNativeTests" ReferencedContainer="container:App.xcodeproj" />
      </BuildActionEntry>
    </BuildActionEntries>
  </BuildAction>
  <TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES">
    <Testables><TestableReference skipped="NO" parallelizable="NO"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="${testId}" BuildableName="ChiliNativeTests.xctest" BlueprintName="ChiliNativeTests" ReferencedContainer="container:App.xcodeproj" /></TestableReference></Testables>
  </TestAction>
  <LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" allowLocationSimulation="YES"><BuildableProductRunnable runnableDebuggingMode="0"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="${appId}" BuildableName="App.app" BlueprintName="App" ReferencedContainer="container:App.xcodeproj" /></BuildableProductRunnable></LaunchAction>
</Scheme>
`);
console.log("Native XCTest target is ready.");
