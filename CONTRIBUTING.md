# Contributing to bridge-recipes

Thanks for your interest! This project is **open source (MIT)** and a
**developer preview**: the core and recipe R1 exist and are tested, but nothing is deployed or released. `README.md`
says exactly what exists, and `docs/` holds the spec and build plan.

## How to help right now
- Open an issue for spec feedback, missing edge cases, or better approaches.
- Challenge the open decisions listed in `PROJECT_CONTEXT.md` — that is the most useful input.

## Once code lands
- Open an issue first for anything beyond a small fix.
- Keep PRs focused: one feature or fix per PR; branch names `feat/<short>` or `fix/<short>`.
- Only claim checks that are really wired up. CI, lint and tests will be added with the first
  implementation commit; the README's Verification section will list the real commands.
- Never commit secrets. `.env` is git-ignored; document every variable in `.env.example`.
- Every Shopify webhook handler must verify the HMAC signature before doing anything else.
- Every Salesforce write must be idempotent and retried with exponential backoff.
- Each recipe is an independent module; a new recipe must not change the core's contract without an issue first.
- Security-sensitive changes (auth, webhooks, token storage, permissions) get extra scrutiny.

See also the portfolio-level guide: `../CONTRIBUTING.md`.
