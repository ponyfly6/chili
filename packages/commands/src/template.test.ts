import { expect, test } from "bun:test";
import { expandPromptTemplate, splitCommandArguments } from "./template.js";

test("template expands full and positional arguments", () => {
  const output = expandPromptTemplate("All=$ARGUMENTS One=$1 Two=$2 Three=$3", "alpha beta");

  expect(output).toBe("All=alpha beta One=alpha Two=beta Three=");
});

test("argument splitting handles quoted values", () => {
  expect(splitCommandArguments("one \"two words\" 'three words'")).toEqual([
    "one",
    "two words",
    "three words",
  ]);
});

