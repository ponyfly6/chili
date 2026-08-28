import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const stylesPath = new URL("./styles.css", import.meta.url);

test("keeps the workspace in the flexible shell row when the status stack is empty", async () => {
  const styles = await readFile(stylesPath, "utf8");

  expect(rule(styles, ".app-shell")).toContain([
    "grid-template-areas:",
    '"titlebar"',
    '"status"',
    '"workspace"',
  ].join("\n"));
  expect(rule(styles, ".titlebar")).toContain("grid-area: titlebar;");
  expect(rule(styles, ".status-stack")).toContain("grid-area: status;");
  expect(rule(styles, ".workspace-grid")).toContain("grid-area: workspace;");
  expect(rule(styles, ".status-stack:empty")).toContain("display: none;");
});

function rule(styles: string, selector: string): string {
  const start = styles.indexOf(`${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = styles.indexOf("}", start);
  expect(end).toBeGreaterThan(start);
  return styles.slice(start, end + 1)
    .split("\n")
    .map((line) => line.trim())
    .join("\n");
}
