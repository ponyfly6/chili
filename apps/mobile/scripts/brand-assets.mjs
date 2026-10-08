import { readFileSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// Mechanical resizing of the existing Chili brand; no new artwork is created.
// Assets are checked in, so non-macOS builders do not need to run this script.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tile = resolve(root, "../../assets/brand/chili-icon-tile-512.png");
const icon = resolve(root, "../../assets/brand/chili-icon-512.png");
const resize = (source, size, target) => execFileSync("/usr/bin/sips", ["-z", String(size), String(size), source, "--out", resolve(root, target)], { stdio: "ignore" });
resize(tile, 1024, "ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png");
const splash = "ios/App/App/Assets.xcassets/Splash.imageset";
for (const name of readdirSync(resolve(root, splash))) if (name.startsWith("splash-") && name.endsWith(".png")) unlinkSync(resolve(root, splash, name));
for (const scale of [1, 2, 3]) resize(icon, 128 * scale, `${splash}/chili-splash@${scale}x.png`);
writeFileSync(resolve(root, splash, "Contents.json"), JSON.stringify({ images: [1, 2, 3].map((scale) => ({ idiom: "universal", filename: `chili-splash@${scale}x.png`, scale: `${scale}x` })), info: { author: "xcode", version: 1 } }, null, 2) + "\n");
const storyboard = resolve(root, "ios/App/App/Base.lproj/LaunchScreen.storyboard");
writeFileSync(storyboard, readFileSync(storyboard, "utf8").replace('contentMode="scaleAspectFill"', 'contentMode="center"').replace('width="1366" height="1366"', 'width="128" height="128"'));
for (const [density, factor] of [["mdpi", 1], ["hdpi", 1.5], ["xhdpi", 2], ["xxhdpi", 3], ["xxxhdpi", 4]]) {
  for (const name of ["ic_launcher", "ic_launcher_round"]) resize(tile, 48 * factor, `android/app/src/main/res/mipmap-${density}/${name}.png`);
  resize(icon, 108 * factor, `android/app/src/main/res/mipmap-${density}/ic_launcher_foreground.png`);
}
const resources = resolve(root, "android/app/src/main/res");
for (const entry of readdirSync(resources, { withFileTypes: true })) {
  if (!entry.isDirectory() || !/^drawable(?:-(?:land|port)-\w+)?$/.test(entry.name)) continue;
  const directory = resolve(resources, entry.name);
  for (const name of readdirSync(directory)) if (name === "splash.png") unlinkSync(resolve(directory, name));
}
writeFileSync(resolve(resources, "drawable/splash.xml"), '<?xml version="1.0" encoding="utf-8"?>\n<layer-list xmlns:android="http://schemas.android.com/apk/res/android">\n    <item android:drawable="@android:color/white" />\n    <item android:width="128dp" android:height="128dp" android:gravity="center" android:drawable="@mipmap/ic_launcher_foreground" />\n</layer-list>\n');
console.log("Mobile app assets now use the existing Chili brand.");
