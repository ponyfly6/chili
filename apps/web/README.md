# Chili website

The official marketing site for Chili. It is a single-route Vinext application
deployed through OpenAI Sites and lives inside the repository's Bun workspace.

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
