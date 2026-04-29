import type { TuiTheme } from "./types.js";

export const chiliDarkTheme: TuiTheme = {
  id: "chili-dark",
  name: "Chili Dark",
  colors: {
    background: "#050505",
    panel: "#0b0f14",
    overlay: "#0b0f14",
    text: {
      primary: "#f8f8f2",
      secondary: "#d8dee9",
      muted: "#8f9baa",
      disabled: "#6e7681",
      inverse: "#050505",
    },
    border: {
      subtle: "#1f242d",
      default: "#30363d",
      focus: "#7ee7c8",
      warning: "#544a20",
      danger: "#7f1d1d",
    },
    accent: {
      primary: "#7ee7c8",
      secondary: "#79c0ff",
      muted: "#3a6f66",
    },
    status: {
      success: "#a3be8c",
      warning: "#ffd166",
      error: "#ff7b72",
      info: "#79c0ff",
      pending: "#ffd166",
    },
    input: {
      background: "#050505",
      text: "#f8f8f2",
      placeholder: "#6e7681",
      cursor: "#f8f8f2",
      disabledText: "#8f9baa",
      disabledBorder: "#262b33",
    },
    menu: {
      background: "#0b0f14",
      selectedBackground: "#10241f",
      selectedText: "#f8f8f2",
      text: "#8f9baa",
      muted: "#6e7681",
    },
  },
};

export const terminalDarkTheme: TuiTheme = {
  id: "terminal-dark",
  name: "Terminal Dark",
  colors: {
    background: "#000000",
    panel: "#0a0a0a",
    overlay: "#101010",
    text: {
      primary: "#eeeeee",
      secondary: "#c7c7c7",
      muted: "#9a9a9a",
      disabled: "#666666",
      inverse: "#000000",
    },
    border: {
      subtle: "#222222",
      default: "#3a3a3a",
      focus: "#8fd7d0",
      warning: "#5c4b1d",
      danger: "#6f2525",
    },
    accent: {
      primary: "#8fd7d0",
      secondary: "#b8c7ff",
      muted: "#4d7774",
    },
    status: {
      success: "#a8c07d",
      warning: "#e6c45c",
      error: "#f07178",
      info: "#83aaff",
      pending: "#e6c45c",
    },
    input: {
      background: "#000000",
      text: "#eeeeee",
      placeholder: "#666666",
      cursor: "#eeeeee",
      disabledText: "#9a9a9a",
      disabledBorder: "#282828",
    },
    menu: {
      background: "#101010",
      selectedBackground: "#18302e",
      selectedText: "#eeeeee",
      text: "#9a9a9a",
      muted: "#666666",
    },
  },
};

export const chiliLightTheme: TuiTheme = {
  id: "chili-light",
  name: "Chili Light",
  colors: {
    background: "#fbfbf8",
    panel: "#f2f4f7",
    overlay: "#ffffff",
    text: {
      primary: "#1f2328",
      secondary: "#3f4652",
      muted: "#6b7280",
      disabled: "#9ca3af",
      inverse: "#ffffff",
    },
    border: {
      subtle: "#e5e7eb",
      default: "#d0d7de",
      focus: "#0f766e",
      warning: "#d8b76a",
      danger: "#e2a09b",
    },
    accent: {
      primary: "#0f766e",
      secondary: "#2563eb",
      muted: "#99c7c0",
    },
    status: {
      success: "#2f855a",
      warning: "#b7791f",
      error: "#b42318",
      info: "#2563eb",
      pending: "#b7791f",
    },
    input: {
      background: "#ffffff",
      text: "#1f2328",
      placeholder: "#9ca3af",
      cursor: "#1f2328",
      disabledText: "#6b7280",
      disabledBorder: "#e5e7eb",
    },
    menu: {
      background: "#ffffff",
      selectedBackground: "#dff5f1",
      selectedText: "#1f2328",
      text: "#3f4652",
      muted: "#9ca3af",
    },
  },
};

export const warmLightTheme: TuiTheme = {
  id: "warm-light",
  name: "Warm Light",
  colors: {
    background: "#faf6ee",
    panel: "#f1eadf",
    overlay: "#fffaf2",
    text: {
      primary: "#292524",
      secondary: "#57534e",
      muted: "#78716c",
      disabled: "#a8a29e",
      inverse: "#fffaf2",
    },
    border: {
      subtle: "#e7ded2",
      default: "#d6cabc",
      focus: "#0f766e",
      warning: "#c6a35a",
      danger: "#dfa199",
    },
    accent: {
      primary: "#0f766e",
      secondary: "#3b6f9d",
      muted: "#9fc4ba",
    },
    status: {
      success: "#3f7f4c",
      warning: "#a16207",
      error: "#b91c1c",
      info: "#3b6f9d",
      pending: "#a16207",
    },
    input: {
      background: "#fffaf2",
      text: "#292524",
      placeholder: "#a8a29e",
      cursor: "#292524",
      disabledText: "#78716c",
      disabledBorder: "#e7ded2",
    },
    menu: {
      background: "#fffaf2",
      selectedBackground: "#deeee8",
      selectedText: "#292524",
      text: "#57534e",
      muted: "#a8a29e",
    },
  },
};

export const tuiThemes = [
  chiliDarkTheme,
  terminalDarkTheme,
  chiliLightTheme,
  warmLightTheme,
] as const satisfies readonly TuiTheme[];
