# CLI release

The CLI and `npm/usechili/package.json` share the same version. `apps/cli` and the
internal `@chili/*` workspaces stay private. Publish only the staged `usechili`
package; it contains a Node launcher and pinned release checksums, no workspace
dependencies or development files.

## Build and validate

Use the repository's pinned Bun version and a clean checkout:

```sh
bun install --frozen-lockfile
bun run typecheck
bun test --only-failures
bun run smoke:all
bun run audit
bun run release:build
bun run release:smoke
bun run release:npm
```

Outputs go to `dist/releases/v<version>/`: one archive per supported target,
`SHA256SUMS`, `manifest.json`, `install.sh`, and the npm tarball. Build uses the
version in `apps/cli/package.json`; set the matching version in `npm/usechili` and
`apps/web/app/release.ts` when releasing a new version. The release smoke tests
the host platform and, with Docker available, both Linux targets in disposable
containers. It uses fake models and temporary workspaces only.

The initial release supports macOS arm64 and Linux glibc arm64/x64. Linux x64
uses Bun's baseline CPU target. Windows, macOS Intel, and musl are not advertised.
The CLI embeds Bun, SQLite, Code Mode WASM/workers, schema validation workers,
and process guardian entry points. It does not include the Electron desktop app
or the separate OpenTUI client. Binaries are not Developer ID notarized.

## Publish

The release workflow builds, validates, and stages a **draft** GitHub Release on a
`v*` tag. Complete the local gates first when hosted Actions cannot start. In that
case, publish the locally validated artifacts using `gh release create --draft`
and the exact committed revision. Inspect the staged files before making it public.

Publish the GitHub Release before npm, so postinstall URLs exist. Never overwrite
assets of a published version: npm embeds their SHA-256 values. A fix needs a new
version. Run `node verify.cjs` in the staged npm directory and publish that directory
with `npm publish --access public` after authenticating the owning npm account.

After publication, test a fresh install from the public GitHub URLs and an npm
global install with an isolated prefix. Then deploy the website. Enable its npm
installation option only once `npm view usechili@<version>` confirms publication.

The shell installer verifies the archive against the same release's SHA256SUMS,
runs `--version` before replacing the installed binary, and uses an atomic rename.
It never needs sudo. Set `CHILI_INSTALL_DIR` for an alternate writable directory,
or `CHILI_VERSION` for a pinned release. Uninstalling the binary preserves user data.
