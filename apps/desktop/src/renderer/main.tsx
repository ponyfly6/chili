import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { createElectronTransport } from "./electron-transport.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing Chili desktop root");

createRoot(root).render(
  <StrictMode>
    <App transport={createElectronTransport(window.chiliDesktop)} />
  </StrictMode>,
);
