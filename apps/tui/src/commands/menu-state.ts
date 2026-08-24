export type CommandMenuMode = "closed" | "slash" | "palette" | "help";

export interface CommandMenuState {
  mode: CommandMenuMode;
  query: string;
  draft: string;
  selectedIndex: number;
}

export type CommandMenuEvent =
  | { type: "open_slash"; draft: string }
  | { type: "open_palette"; draft: string }
  | { type: "open_help"; draft: string }
  | { type: "close" }
  | { type: "insert"; text: string }
  | { type: "backspace" }
  | { type: "delete" }
  | { type: "move"; delta: number; itemCount: number }
  | { type: "complete"; value: string };

export const initialCommandMenuState: CommandMenuState = {
  mode: "closed",
  query: "",
  draft: "",
  selectedIndex: 0,
};

export function reduceCommandMenu(state: CommandMenuState, event: CommandMenuEvent): CommandMenuState {
  switch (event.type) {
    case "open_slash":
      return { mode: "slash", query: "", draft: event.draft, selectedIndex: 0 };
    case "open_palette":
      return { mode: "palette", query: "", draft: event.draft, selectedIndex: 0 };
    case "open_help":
      return { mode: "help", query: "", draft: event.draft, selectedIndex: 0 };
    case "close":
      return initialCommandMenuState;
    case "insert":
      return state.mode === "slash"
        ? { ...state, draft: `${state.draft}${event.text}`, selectedIndex: 0 }
        : { ...state, query: `${state.query}${event.text}`, selectedIndex: 0 };
    case "backspace":
      return state.mode === "slash"
        ? { ...state, draft: state.draft.slice(0, -1), selectedIndex: 0 }
        : { ...state, query: state.query.slice(0, -1), selectedIndex: 0 };
    case "delete":
      return state.mode === "slash" ? state : { ...state, query: "", selectedIndex: 0 };
    case "move": {
      if (event.itemCount <= 0) return { ...state, selectedIndex: 0 };
      return {
        ...state,
        selectedIndex: (state.selectedIndex + event.delta + event.itemCount) % event.itemCount,
      };
    }
    case "complete":
      return state.mode === "slash"
        ? { ...state, draft: event.value, selectedIndex: 0 }
        : { ...state, query: event.value.replace(/^\//, ""), selectedIndex: 0 };
  }
}
