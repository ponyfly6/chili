import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  readUserReviewSettings,
  userReviewSettingsPath,
  writeUserReviewSettings,
  type UserReviewSettings,
} from "./user-review-state.js";

const settings: UserReviewSettings = {
  profile: "auto-review",
  reviewInstructions: "Allow necessary project changes. Review destructive operations in context.",
};

test("review settings are absent until explicitly saved", async () => {
  await withHome(async (chiliHome) => {
    await writeFile(join(chiliHome, "config.toml"), '[review]\nprofile = "full-access"\nreview_instructions = "Allow everything"\n');
    expect(await readUserReviewSettings({ chiliHome })).toBeUndefined();
  });
});

test("review settings persist independently of user configuration with private file permissions", async () => {
  await withHome(async (chiliHome) => {
    const config = '[agents]\nmax_depth = 2\n[permissions]\nallow = ["bash(*)"]\n';
    await writeFile(join(chiliHome, "config.toml"), config);
    const input: UserReviewSettings = {
      ...settings,
      reviewInstructions: "First line.\n\n第二行。\n",
      reviewerModel: { provider: " provider ", model: " model " },
    };
    await writeUserReviewSettings(input, { chiliHome });
    expect(await readUserReviewSettings({ chiliHome })).toEqual({
      ...input,
      reviewerModel: { provider: "provider", model: "model" },
    });
    expect(await readFile(join(chiliHome, "config.toml"), "utf8")).toBe(config);
    expect((await stat(userReviewSettingsPath(chiliHome))).mode & 0o777).toBe(0o600);
    expect((await readdir(chiliHome)).sort()).toEqual(["config.toml", "review-settings.json"]);
  });
});

test.each([
  ["", "Invalid review settings"],
  ["{", "Invalid review settings"],
  ["null", "must be an object"],
  ["[]", "must be an object"],
  [JSON.stringify({ ...settings, profile: "default" }), "profile must be full-access or auto-review"],
  [JSON.stringify({ ...settings, reviewInstructions: " " }), "must not be blank"],
  [JSON.stringify({ ...settings, reviewInstructions: false }), "must be a string"],
  [JSON.stringify({ profile: "full-access" }), "must be a string"],
  [JSON.stringify({ ...settings, permissions: { allow: ["bash(*)"] } }), "permissions is not a supported setting"],
  [JSON.stringify({ ...settings, reviewerModel: null }), "reviewerModel must be an object"],
  [JSON.stringify({ ...settings, reviewerModel: { provider: "", model: "model" } }), "reviewerModel.provider must be a non-empty string"],
  [JSON.stringify({ ...settings, reviewerModel: { provider: "provider" } }), "reviewerModel.model must be a non-empty string"],
  [JSON.stringify({ ...settings, reviewerModel: { provider: "provider", model: "model", policy: "allow" } }), "reviewerModel.policy is not a supported setting"],
])("invalid persisted review settings fail clearly: %s", async (contents, error) => {
  await withHome(async (chiliHome) => {
    await writeFile(userReviewSettingsPath(chiliHome), contents);
    await expect(readUserReviewSettings({ chiliHome })).rejects.toThrow(error);
    await expect(readUserReviewSettings({ chiliHome })).rejects.toThrow(userReviewSettingsPath(chiliHome));
  });
});

test("invalid updates preserve existing review settings", async () => {
  await withHome(async (chiliHome) => {
    await writeUserReviewSettings(settings, { chiliHome });
    await expect(writeUserReviewSettings({ ...settings, reviewInstructions: "" }, { chiliHome })).rejects.toThrow("must not be empty");
    expect(await readUserReviewSettings({ chiliHome })).toEqual(settings);
    expect(await readdir(chiliHome)).toEqual(["review-settings.json"]);
  });
});

test("review instructions enforce the shared length and control character limits on reads and writes", async () => {
  await withHome(async (chiliHome) => {
    const boundary = { ...settings, reviewInstructions: "x".repeat(32_000) };
    await writeUserReviewSettings(boundary, { chiliHome });
    expect(await readUserReviewSettings({ chiliHome })).toEqual(boundary);
    for (const [reviewInstructions, message] of [
      ["x".repeat(32_001), "must not exceed 32000 characters"],
      ["Review\u0000instructions", "must not contain unsafe control characters"],
    ] as const) {
      const invalid = { ...settings, reviewInstructions };
      await expect(writeUserReviewSettings(invalid, { chiliHome })).rejects.toThrow(message);
      expect(await readUserReviewSettings({ chiliHome })).toEqual(boundary);
      await writeFile(userReviewSettingsPath(chiliHome), JSON.stringify(invalid));
      await expect(readUserReviewSettings({ chiliHome })).rejects.toThrow(message);
      await writeUserReviewSettings(boundary, { chiliHome });
    }
  });
});

test("concurrent review settings writes always leave one complete record and no temporary files", async () => {
  await withHome(async (chiliHome) => {
    const updates: UserReviewSettings[] = Array.from({ length: 16 }, (_, index) => ({
      profile: index % 2 === 0 ? "auto-review" : "full-access",
      reviewInstructions: `Review policy ${index}.`,
      reviewerModel: { provider: "provider", model: `model-${index}` },
    }));
    await Promise.all(updates.map((update) => writeUserReviewSettings(update, { chiliHome })));
    const saved = await readUserReviewSettings({ chiliHome });
    expect(saved).toBeDefined();
    expect(updates).toContainEqual(saved!);
    expect(await readdir(chiliHome)).toEqual(["review-settings.json"]);
  });
});

async function withHome(run: (chiliHome: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "chili-review-state-"));
  try {
    await run(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
