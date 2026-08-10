# Baseline (A0)

This file pins the immutable QA-verified baseline for the multilingual build work.
It exists so that no build step or refactor can silently alter the live English homepage.

## Pinned baseline

- **Commit:** `73d680d` — "Fix homepage horizontal overflow" (current HEAD, branch `feature/phase-4-next`)
- **SHA-256 of root `index.html`:** `46e2dbe8586ea30b726f3a53a94e5461e079613eae5b7f848c709698ca7b8c13`
- Working tree was clean when this file was written.

## Immutable rule

- The build system (`build.js`, Phase A4) **never writes to the repo root** and never writes to
  `index.html`. Its only output directory is `dist/` (gitignored).
- Root `index.html` is replaced **only** via an explicit, reviewed, separately-committed
  promotion step (Phase C5) — never automatically.
- `verify.js` (Phase A4) re-checks the SHA-256 of root `index.html` against the fingerprint above
  before comparing generated output, so any drift to the baseline aborts the check.

## Phase plan (current state)

- [x] A0 — baseline pin + `.gitignore`
- [x] A1 — source directory structure
- [ ] A2 — extract English homepage into `src/content/en.json` + tokenized source
- [ ] A3 — split into templates + partials
- [ ] A4 — `build.js` (zero-dependency) + `verify.js`
- [ ] A5 — generate `dist/index.html`
- [ ] A6 — English validation matrix
- [ ] B  — German content + validate `/de/`
- [ ] C  — language switcher + reciprocal hreflang + sitemap + promotion decision
