import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { createElectronTransport } from "./electron-transport.js";
import { applyDesktopTheme } from "./theme.js";
import "./styles.css";
import "./conversation-design.css";
import "./work-presentation.css";
import "./desktop-workspace.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing Chili desktop root");

async function start(): Promise<void> {
  const { theme } = await window.chiliDesktop.invoke({ type: "appearance.get" });
  applyDesktopTheme(theme);
}

void start().catch(() => undefined).finally(() => {
  createRoot(root).render(
    <StrictMode>
      <App transport={createElectronTransport(window.chiliDesktop)} />
    </StrictMode>,
  );
});
