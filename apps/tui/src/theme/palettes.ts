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

export const tuiThemes = [
  chiliDarkTheme,
  terminalDarkTheme,
] as const satisfies readonly TuiTheme[];
