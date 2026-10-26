# Chili website

The official marketing site for Chili. It is a single-route Vinext application
that runs on Cloudflare Workers with Static Assets and lives inside the
repository's Bun workspace. The existing OpenAI Sites packaging remains available.

## Local development

From the repository root:

```bash
bun install
bun --cwd apps/web run dev
```

## Validation

```bash
bun --cwd apps/web run build
node --test apps/web/tests/rendered-html.mjs
```

The site is intentionally static: it does not use authentication, D1, R2, or
the local Chili runtime API. Product claims and setup instructions should stay
aligned with the repository root `README.md`.

The header and browser icons use the same transparent pepper in
`public/chili-icon.svg`. Keep `public/favicon.svg` identical to that source and
regenerate the 32px PNG, the ICO (16px, 32px, and 48px), and the 180px Apple touch
icon when it changes. The Apple touch icon uses the site's `#faf9f6` background.

## Cloudflare deployment

The production application is `chili-web`, served at <https://usechili.com/>
with `www.usechili.com` redirecting to it. The fallback hostname is
<https://chili-web.lc4174782.workers.dev/>. It uses the Free plan and serves
only static assets.

`next.config.ts` enables static export. Vite uses `wrangler.jsonc` for its build and
local runtime, then prerenders the homepage into `dist/client/index.html`. The
public deployment uses `wrangler.static.jsonc` and serves only `dist/client`;
it does not execute the rendering Worker for each request. Interactive demos
hydrate in the browser. Canonical and social URLs use `https://usechili.com`.

For dashboard deployment, choose **Workers & Pages → Create application → Upload
your static files**, upload the contents of `dist/client`, and name the application
`chili-web`. A ZIP also works: create it with `index.html` at the archive root,
and select it through the **file** upload button. Cloudflare expands the archive.
The bundle includes the homepage, 404 page, scripts, styles, and brand assets.
Do not upload repository source files or the server build.

Check the deployment bundle locally without publishing or logging in:

```bash
bun run --cwd apps/web deploy:check
```

After logging in to the intended Cloudflare account, deploy from the repository root:

```bash
cd apps/web
bunx wrangler login
bunx wrangler whoami
bun run deploy
```

The initial deployment uses the account's `workers.dev` hostname. Before deploying
to an account with an existing `chili-web` Worker, check that it is this project's
deployment. This site does not require a VPS, a database, R2, or a paid Images binding
for its current pages.

The `usechili.com` zone is active on Cloudflare. Spaceship uses
`celine.ns.cloudflare.com` and `darl.ns.cloudflare.com`; DNSSEC is enabled and
verified. Both hostnames are bound under the Worker's **Domains** tab.
The dashboard redirect rule `Redirect www to usechili.com` sends HTTP and HTTPS
requests from `www` to `https://usechili.com`, preserving paths and query strings
with a 301 response. Cloudflare manages the HTTPS certificates, and Always Use
HTTPS redirects unencrypted requests. HTTPS access and the `www` redirect were
verified in Chrome on 2026-10-15.
These domain settings are managed in the dashboard rather than by Wrangler.

## Downloads

Use GitHub Releases for the first public CLI/desktop installers. The public
repository is `https://github.com/ponyfly6/chili`. Keep versioned installers and
checksums in Releases, not in the website's `public` directory or Git history.
An installer is a release artifact; it does not require an application server.

When releases are ready, add a `/download` page with OS/architecture-specific links,
the version, checksums, and release notes. Only advertise `/install.sh` once an
installer exists and has been tested against published release assets. The current
site correctly offers source setup and says desktop installers are not yet released.

If downloads later need a dedicated host, mirror verified release artifacts to R2
at `downloads.usechili.com`, preserving versioned URLs. R2 stores the large files;
the website Worker only provides the page, version metadata, or redirects. Enable
R2 and its billing only when needed. Test download performance in the regions where
users actually are before choosing a mirror.
