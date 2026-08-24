import { expect, test } from "bun:test";
import { initialCommandMenuState, reduceCommandMenu } from "./menu-state.js";

test("palette query is independent from the composer draft", () => {
  const opened = reduceCommandMenu(initialCommandMenuState, { type: "open_palette", draft: "unfinished prompt" });
  const typed = reduceCommandMenu(opened, { type: "insert", text: "model" });
  const closed = reduceCommandMenu(typed, { type: "close" });

  expect(typed).toMatchObject({ mode: "palette", query: "model", draft: "unfinished prompt" });
  expect(closed).toEqual(initialCommandMenuState);
});

test("selection wraps and resets when the query changes", () => {
  let state = reduceCommandMenu(initialCommandMenuState, { type: "open_palette", draft: "" });
  state = reduceCommandMenu(state, { type: "move", delta: -1, itemCount: 3 });
  expect(state.selectedIndex).toBe(2);
  state = reduceCommandMenu(state, { type: "move", delta: 1, itemCount: 3 });
  expect(state.selectedIndex).toBe(0);
  state = reduceCommandMenu(state, { type: "insert", text: "m" });
  expect(state.selectedIndex).toBe(0);
});

test("slash descent keeps the menu open and backspace ascends naturally", () => {
  let state = reduceCommandMenu(initialCommandMenuState, { type: "open_slash", draft: "/mo" });
  state = reduceCommandMenu(state, { type: "complete", value: "/model " });
  expect(state).toMatchObject({ mode: "slash", draft: "/model ", selectedIndex: 0 });
  state = reduceCommandMenu(state, { type: "backspace" });
  expect(state.draft).toBe("/model");
});

test("help uses the same searchable menu mode", () => {
  const state = reduceCommandMenu(initialCommandMenuState, { type: "open_help", draft: "keep me" });
  expect(state).toEqual({ mode: "help", query: "", draft: "keep me", selectedIndex: 0 });
});
