# Chili

A local coding agent for your terminal. Install the `usechili` package, then run `chili`:

```sh
npm install -g usechili
chili --version
```

Node.js 20+ is required for the npm launcher. The CLI itself includes its Bun runtime.
Installation downloads the versioned executable from GitHub Releases and checks its
SHA-256 against the manifest embedded in this package. If install scripts were
disabled, run `npm rebuild usechili` before starting it.

Supports macOS Apple Silicon and Linux glibc 2.28+ on arm64/x64. Windows, Intel Macs,
and Alpine/musl are not included in this first release.

Configure a model provider and work from your project directory:

```sh
export MINIMAX_API_KEY='your-api-key'
cd your-project
chili "Summarize this repository"
```

Or set `DEEPSEEK_API_KEY` and run `chili --model deepseek "Summarize this repository"`.
For a local installation check without credentials: `chili --model fake "hello"`.
Run `chili` for an interactive CLI session; the separate desktop app and TUI are
not included in this package. Online model usage is billed by your model provider.

Update: `npm install -g usechili@latest`. Uninstall: `npm uninstall -g usechili`.
Uninstalling preserves your project sessions and `~/.chili` settings.

[Getting started](https://usechili.com/download) · [Source](https://github.com/ponyfly6/chili)
