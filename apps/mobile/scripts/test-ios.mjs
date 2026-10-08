import { spawn, execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const simulator = process.env.CHILI_TEST_SIMULATOR_ID;
if (!simulator || !process.env.CHILI_NATIVE_TEST_CERT || !process.env.CHILI_NATIVE_TEST_KEY) {
  throw new Error("Set CHILI_TEST_SIMULATOR_ID, CHILI_NATIVE_TEST_CERT and CHILI_NATIVE_TEST_KEY. The selected disposable simulator must already trust that fixture CA; this script never installs trust.");
}
execFileSync(process.execPath, [resolve(root, "scripts/init-native-tests.mjs")], { cwd: root, stdio: "inherit" });
const fixture = spawn("bun", ["scripts/native-test-fixture.ts"], { cwd: root, env: process.env, stdio: ["ignore", "pipe", "inherit"] });
try {
  await new Promise((accept, reject) => {
    let text = "";
    const timeout = setTimeout(() => reject(new Error("Native HTTPS fixture did not start")), 30_000);
    fixture.stdout.on("data", (chunk) => {
      text += String(chunk);
      if (text.includes("\n")) { clearTimeout(timeout); accept(); }
    });
    fixture.once("error", (error) => { clearTimeout(timeout); reject(error); });
    fixture.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Fixture exited (${code})`)); });
  });
  const resultPath = `ios/build/NativeTests-${Date.now()}.xcresult`;
  const build = spawn("xcodebuild", ["-project", "ios/App/App.xcodeproj", "-scheme", "ChiliNativeTests",
    "-destination", `platform=iOS Simulator,id=${simulator}`, "-derivedDataPath", "ios/build", "-resultBundlePath", resultPath,
    "CODE_SIGNING_ALLOWED=YES", "CODE_SIGN_IDENTITY=-", "test"], { cwd: root, stdio: "inherit" });
  const code = await new Promise((accept, reject) => { build.once("error", reject); build.once("exit", accept); });
  if (code !== 0) process.exitCode = typeof code === "number" ? code : 1;
} finally {
  fixture.kill("SIGTERM");
}
