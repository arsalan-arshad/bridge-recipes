# Bridge Recipes

Open-source (MIT) Shopify -> Salesforce bridge: a tiny reliable core (webhooks in, Salesforce auth out,
idempotency, audit log) plus narrow recipes shipped one at a time. R1 Retail-to-B2B Lead Spotter first.
Start with `PROJECT_CONTEXT.md` (state, open decisions, working agreements), then `docs/SPEC.md`,
`docs/BUILD_PLAN.md` and `docs/R1_CONTRACT.md`. The README describes only what exists.

## Hard rules
- The recipe contract is the boundary. `decide()` is pure (no network, no clock, no randomness, no env,
  no AI) and unit-tested; the executor is the only code that writes. A request that would turn the core
  into a generic sync engine becomes a new recipe instead.
- Safety: verify the Shopify HMAC over the raw body before parsing; every handler is idempotent; a new
  recipe is dry-run by default; per-recipe kill switch; a log with replay.
- Privacy: minimum personal data in the log and database; emails redacted in logs (`a***@domain`);
  consent filter on by default for R1; compliance webhooks must really redact.
- Scopes: request only what enabled recipes need. Any new Shopify scope or Salesforce permission needs the
  owner's explicit sign-off with justification.
- Salesforce integrations use External Client Apps, never Connected Apps. Re-verify platform facts against
  current docs and cite the URL.
- README/docs claim only what exists. CI gates only on checks that really run.
- Never print or commit secrets; reference variable names only. Send output of any CLI that may print
  credentials to `>/dev/null 2>&1`.
- ASK the owner before: commit, push, tag, deploy, release, open/merge a PR, submit for review.
- Never touch `../salesforce`.
- One public contact email: arsalanarshad.dev@gmail.com.

## Conventions
- D3 is closed (`PROJECT_CONTEXT.md` section 12): TypeScript, tests with `node --test`, no build step.
  Erasable syntax only (no enums, namespaces, parameter properties); `import type` for types; `.ts` import
  extensions. Start with the pure `decide()` and its fixtures; no network code until the core milestones.
- Fixtures are plain JSON in `recipes/<recipe-id>/fixtures/` so they survive the language choice.
- Follow `../OPEN_SOURCE_APP_PLAYBOOK.md` (repo hygiene, honest README, compliance webhooks).

## Agent teams (experimental; flag is in the git-ignored `.claude/settings.local.json`)
- Default is one session. Use a team only for read-only research or review, or for modules with disjoint
  file ownership. Never for the core (gateway, queue, executor): sequential, shared files.
- Teammates do not see the lead's conversation. The spawn prompt must carry the task, the files the
  teammate owns, and these rules. No secrets or customer data in a spawn prompt.
- Record each team run in `PROJECT_CONTEXT.md`: shape, rough cost, what worked, verdict.

## Who does what (effective 2026-10-19)
- Terminal Claude (Claude Code in this repo): all coding (source, tests, scripts, `npm test`), running scripts
  against the owner's `.env`, Shopify/Salesforce CLI work, and git (ask first).
- Desktop Claude (Claude app + Chrome): browser work in the owner's Shopify and Salesforce accounts, platform
  doc research, syncing the Claude project docs, reviews and write-ups, listing/marketing material.
- Never edit a file at the same time as the other Claude; re-read before editing. `PROJECT_CONTEXT.md` stays
  append-only: whoever finishes something appends the next numbered section and says who wrote it.
- Secrets: never print, paste or log values; Desktop Claude never copies a credential; the owner pastes them into `.env`.
- Any write to the dev store or Developer org (even test data) needs the owner's OK per item, with the undo stated.

## Session end
After material progress, append a numbered section to `PROJECT_CONTEXT.md` (append-only), update its
snapshot header and punch list, and tick `docs/BUILD_PLAN.md` only for what is really done.
