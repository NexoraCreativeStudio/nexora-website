# Nexora — Final Document Output System (PROP.6)

The governed **presentation / output layer** that turns a validated **Proposal**
(PROP.1–PROP.4) or **Agreement** (PROP.5) into polished, deterministic,
client-ready final documents:

```
Proposal (PROP.1–PROP.4)  ─┐
                           ├─►  PROP.6 final output  ──►  self-contained HTML
Agreement (PROP.5)  ───────┘                              + manifest + SHA-256
                                                          + optional PDF (local
                                                            headless Chrome)
```

PROP.6 is **output only**. It performs **no** pricing, **no** legal
decision-making, **no** acceptance, **no** execution, **no** e-signature, **no**
invoicing, and **no** payment collection. Every commercial value and legal
classification is inherited in-process from the governed PROP.1–PROP.5 shared
modules — nothing is re-derived or invented here.

## What PROP.6 does

- Renders a validated Proposal into a final self-contained HTML document through
  the governed PROP.2 template + PROP.3 renderer, preserving the Approved Final
  Project Price / reference-price distinction, payment schedule, AI Go-Live,
  Care, Warranty, VAT-neutral and document-control sections.
- Renders a governed Agreement through the PROP.5 renderer, honouring the status
  gate:
  - `DRAFT` — carries the banner **“DRAFT — NOT FOR EXECUTION”** and marks every
    unresolved legal provision **“To be confirmed”**.
  - `READY_FOR_EXECUTION` — carries the banner **“READY FOR EXECUTION — NOT YET
    SIGNED”** and is produced **only** when every mandatory legal/commercial
    decision is resolved through an approved source (no `--force-ready`).
  - `SIGNED` / `EXECUTED` are **external gates — never modelled here**. PROP.6
    never renders a signed Agreement.
- Emits, per document, a deterministic bundle: `{ID}-v{version}[-{STATUS}].html`,
  the same `.pdf` when requested, and a machine-readable `{…}.manifest.json`
  with SHA-256 checksums.
- Scans every final document **before it is archived** and refuses output that
  leaks a leftover `{{template token}}`, legacy commercial content (Starter,
  Elite, £250 deposit, AI Care, obsolete checkout), an unsupported VAT claim, or
  an absolute private filesystem path / `file://` URL.

## What PROP.6 does NOT do

- Does **not** modify any Proposal or Agreement status, acceptance state,
  commercial value, or legal decision (pure export — generation never mutates
  its inputs).
- Does **not** implement e-signature, invoice generation, or payment collection.
- Does **not** commit real client data. Real generated client documents live
  under `ops/documents/out/` (gitignored); real private inputs live under
  `ops/documents/private/` (gitignored). Only synthetic `_example: true`
  fixtures are committed.
- Does **not** silently overwrite archived output (see below).

## HTML / PDF architecture

**HTML is authoritative.** It is fully self-contained (CSS inlined into the
document), print-ready, and free of `file://` / absolute private-machine paths.
Fallback font stacks are built into the shared stylesheets so documents remain
readable even if external Google Fonts fail.

**PDF is a print of the governed HTML**, produced by an installed local headless
browser (Chrome/Chromium) via `--headless=new --print-to-pdf` when one is
available. If no local browser is found, PROP.6 reports:

```
AUTOMATED PDF: NOT AVAILABLE — SAFE HTML/PRINT WORKFLOW ONLY
```

and the documented manual workflow is: open the generated HTML in a browser →
**Print → Save as PDF**. HTML remains authoritative in both cases. PROP.6 never
produces a fake PDF (no renaming HTML to `.pdf`).

## Output directories

```
ops/documents/out/proposals/   final generated Proposal bundles (gitignored)
ops/documents/out/agreements/  final generated Agreement bundles (gitignored)
ops/documents/private/         real private inputs / staging (gitignored)
```

Output must stay inside the repository root — a `--output` directory outside the
repo is refused.

## Deterministic filenames

Filenames are derived **only** from governed document metadata — never from
client names:

- Proposal:  `PRP-2026-0012-v1.0.html`
- Agreement: `AGR-2026-0012-v1.0-DRAFT.html`
- PDF:       `…-v1.0.pdf` / `…-v1.0-DRAFT.pdf`
- Manifest:  `…-v1.0.manifest.json` / `…-v1.0-DRAFT.manifest.json`

All segments are sanitised to `[A-Za-z0-9._-]`; `..`, leading dots, slashes and
metacharacters are rejected or neutralised, so path traversal is impossible.

## Checksums and manifests

Every bundle carries a `.manifest.json`:

```json
{
  "schema": "nexora-document-manifest/v1",
  "document_type": "proposal",
  "document_id": "PRP-2026-0012",
  "version": "1.0",
  "status": "SENT",
  "html_filename": "PRP-2026-0012-v1.0.html",
  "html_checksum_sha256": "…",
  "pdf_filename": "PRP-2026-0012-v1.0.pdf",
  "pdf_checksum_sha256": "…",
  "output_system": "nexora-document-output/v1",
  "checksum_note": "SHA-256 checksums are integrity aids only. …"
}
```

**A SHA-256 checksum proves byte integrity only. A checksum is NOT a digital
signature and provides no signer authenticity. A PDF checksum is NOT an
e-signature.**

## Overwrite behaviour

Generated output is archived and **never silently overwritten**. Re-running the
generator for the same `id + version` (and same status) fails unless you pass
`--overwrite` explicitly. Accepted-proposal immutability is enforced upstream;
this layer never silently destroys document history.

## CLI usage

```
node ops/documents/generate-document.mjs proposal <proposal.json> [options]
node ops/documents/generate-document.mjs agreement <handoff.json>  [options]
node ops/documents/generate-document.mjs proposal --example [options]
node ops/documents/generate-document.mjs agreement --example [options]
```

Options:

| Option | Meaning |
| --- | --- |
| `--html` | Produce final HTML (default). |
| `--pdf` | Also produce a PDF via local headless Chrome (graceful HTML/print fallback). |
| `--output <dir>` | Output directory (default `ops/documents/out/{proposals\|agreements}`). |
| `--overwrite` | Allow replacing an existing bundle for the same id+version. |
| `--check` | Validate only — no render, no output; exit 0 = generation-safe. |
| `--generated-at <ISO>` | Deterministic timestamp override (tests / archival). |
| `--example` | Use the committed synthetic fixture for this document type. |
| `--help` | Show help. |

Agreement-only options (forwarded to the PROP.5 provenance chain):

| Option | Meaning |
| --- | --- |
| `--proposal <p>` | Accepted Proposal file (provenance re-verification). |
| `--acceptance-record <r>` | Acceptance record (provenance re-verification). |
| `--legal-decisions <p>` | Legal-decisions register (default: committed register). |
| `--status <DRAFT\|READY_FOR_EXECUTION>` | Default `DRAFT`; READY opens only when every mandatory decision resolves. |

### Examples

```bash
# Proposal: validate only
node ops/documents/generate-document.mjs proposal ops/proposals/private/acme.json --check

# Proposal: final HTML + PDF + manifest
node ops/documents/generate-document.mjs proposal ops/proposals/private/acme.json --pdf

# Agreement: final DRAFT bundle from a PROP.4 handoff
node ops/documents/generate-document.mjs agreement ops/proposals/private/acme.handoff.json \
  --proposal ops/proposals/private/acme.json \
  --acceptance-record ops/proposals/private/acceptance/acme.acceptance.json \
  --pdf

# READY_FOR_EXECUTION (only through an approved, resolved register)
node ops/documents/generate-document.mjs agreement <handoff> \
  --status READY_FOR_EXECUTION --legal-decisions <resolved-register.json> --pdf
```

### Input safety

Same fail-closed policy as the generators:

- Proposal → `ops/proposals/private/` (real) or `ops/proposals/examples/`
  (synthetic, must carry `"_example": true`).
- Agreement → handoff/proposal/record from `ops/proposals/private|examples/` or
  `ops/agreements/private|examples/`.
- Any other path is refused as unsafe.

## Validation

```
node ops/documents/validate-document-output.mjs
```

The PROP.6 validator (exit 0 = all checks pass) covers:

- static safety (CLI/core present, gitignore coverage, no hard-coded prices, no
  `--force-ready`, Node built-ins only);
- deterministic filenames, SHA-256 determinism, manifest correctness;
- PDF engine discovery (graceful HTML/print fallback is **not** a failure);
- positive QA: B2 / A2 / Complete final Proposal documents and B2 / AI /
  Complete final Agreement DRAFT documents (HTML + PDF), plus a
  `READY_FOR_EXECUTION` Agreement opened **only** via a synthetic resolved
  legal-decisions register (mechanism proof — never a real decision);
- PDF QA: `%PDF-` magic, non-zero size, page count > 0, readable text
  extraction, expected document ID and Approved price present, DRAFT/READY
  marker, no leftover tokens, no `file://` leakage, no unsupported VAT claim,
  no legacy commercial content;
- HTML QA: well-formed, no leftover tokens, no path leakage, no stale
  commercial values, no commercial divergence from the Source of Truth;
- 18 fail-closed negative tests (unsafe filename, path traversal, overwrite
  without permission, malformed Proposal / invalid Agreement input, commercial
  drift, Starter / Elite / £250 legacy deposit / AI Care / unsupported VAT /
  leftover template token, client file outside allowed paths, output outside
  safe directory, status-mutation attempt, stale Approved Final Project Price,
  invalid Agreement readiness, private filesystem path leakage);
- privacy + cleanup of all temporary fixtures (all under gitignored locations).

## Archival workflow

1. Accept + hand off the Proposal through PROP.4 (never here).
2. `--check` the Proposal or handoff for generation-safety.
3. Generate the final bundle with `--pdf` into `ops/documents/out/…`.
4. Read the `.manifest.json` checksums — these attest byte integrity, **not**
   signature.
5. Store the bundle as the client-facing artifact; keep inputs under the
   `private/` areas.

## Explicit boundaries

- **A PDF checksum is NOT a digital signature.**
- **Final document output is NOT an e-signature.**
- **Agreement `READY_FOR_EXECUTION` is NOT `SIGNED`.**
- **Document export does not issue an invoice and does not collect payment.**
- This layer never changes pricing, legal decisions, Proposal/Agreement status,
  acceptance state, or any Source-of-Truth content.
