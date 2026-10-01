import { expect, test } from "bun:test";
import * as commands from "@chili/commands";
import * as compatibility from "./commands.js";

test("server command exports preserve the shared command implementation and error identity", () => {
  expect(compatibility.createFilesystemPromptCommandControl).toBe(commands.createFilesystemPromptCommandControl);
  expect(compatibility.PromptCommandNotFoundError).toBe(commands.PromptCommandNotFoundError);
  expect(compatibility.PromptCommandUsageError).toBe(commands.PromptCommandUsageError);
});
