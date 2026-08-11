# Baseline (A0)

This file pins the immutable QA-verified baseline for the multilingual build work.
It exists so that no build step or refactor can silently alter the live English homepage.

## Pinned baseline

- **Commit:** `2291aa4` — "Add German multilingual support with build system and localization" (parent of the Phase C5 promotion)
- **SHA-256 of root `index.html`:** `e426c9da8466c2a4e08058f6462dd89b6897d389969f30d5e5f901c61c4895d5`
- Working tree was clean when this file was written.

## Previous baseline

- **Previous SHA-256 of root `index.html`:** `87454774d3ecf71910bd0f0dbc82da72478a386da014679d6ccdb7ec604573a1`
  (pinned at commit `2291aa4`, superseded by the Phase C5 homepage promotion)
- **Earlier SHA-256 of root `index.html`:** `46e2dbe8586ea30b726f3a53a94e5461e079613eae5b7f848c709698ca7b8c13`
  (pinned at commit `2291aa4`, superseded by the Phase C5 homepage promotion)

## Promotion log

### Phase C5 — English/German homepage promotion
- **Date:** 2026-08-10
- **Action:** promoted verified generated English homepage (`dist/index.html`) to root `index.html`.
- **Promotion adds only:**
  - reciprocal hreflang + x-default alternate links in `<head>`
  - the English/Deutsch language switcher in the topbar
- The promoted root `index.html` is byte-identical to `dist/index.html` (verified immediately after copy).

### Phase E1 — Commercial pricing + sales UX reconciliation (website implementation)
- **Date:** 2026-08-11
- **Action:** promoted verified generated English homepage (`dist/index.html`) to root `index.html` after the commercial pricing and sales-UX reconciliation (A1/A2/A3 pricing, Complete section, Brand Studio nav).
- The promoted root `index.html` is byte-identical to `dist/index.html` (verified immediately after copy).

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
- [x] A2 — extract English homepage into `src/content/en.json` + tokenized source
- [x] A3 — split into templates + partials
- [x] A4 — `build.js` (zero-dependency) + `verify.js`
- [x] A5 — generate `dist/index.html`
- [x] A6 — English validation matrix
- [x] B  — German content + validate `/de/`
- [x] C  — language switcher + reciprocal hreflang + sitemap + promotion decision
- [x] C5 — English/German homepage promotion (baseline updated to promoted root)
