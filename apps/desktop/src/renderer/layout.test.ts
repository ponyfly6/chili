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

test("defines real desktop, tablet, and narrow-phone layout gates without horizontal minimums", async () => {
  const styles = await readFile(stylesPath, "utf8");

  expect(rule(styles, ".workspace-grid")).toContain("grid-template-columns: 260px minmax(460px, 1fr) 316px;");
  expect(styles).toContain("@media (max-width: 1080px)");
  expect(styles).toContain("grid-template-columns: 224px minmax(440px, 1fr) 0;");
  expect(styles).toContain("@media (max-width: 640px)");
  expect(styles).toContain([
    ".workspace-grid,",
    "  .workspace-grid.inspector-collapsed,",
    "  .workspace-grid.sidebar-collapsed,",
    "  .workspace-grid.sidebar-collapsed.inspector-collapsed {",
    "    grid-template-columns: 0 minmax(0, 1fr) 0;",
  ].join("\n"));
  expect(styles).toContain("grid-template-columns: 0 minmax(0, 1fr) 0;");
  expect(styles).toContain("@media (max-width: 420px)");
  expect(styles).toContain("width: min(286px, calc(100% - 28px));");
  expect(styles).toContain(".modal-card,");
  expect(styles).toContain("width: 100%;");
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
