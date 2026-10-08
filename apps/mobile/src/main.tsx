import { createRoot } from "react-dom/client";
import { App } from "../../control-web/src/App.js";
import { createMobilePlatform } from "./platform.js";
import "../../control-web/src/styles.css";
import "./mobile.css";

const root = document.getElementById("root");
if (!root) throw new Error("The mobile app root is missing.");
try {
  createRoot(root).render(<App platform={createMobilePlatform()} />);
} catch {
  root.textContent = "请在已安装的 Chili App 中打开。若 App 无法启动，请重新安装最新版本。";
}
