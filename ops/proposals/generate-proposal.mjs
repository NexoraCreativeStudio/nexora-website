#!/usr/bin/env node
/* Nexora Proposal Generator (PROP.3).
   Converts a validated Nexora Proposal JSON instance (PROP.1 schema) into a
   client-facing HTML Proposal document through the governed PROP.2 template.

   Flow:
     validated proposal JSON
       -> fail-closed PROP.1 validation (shared core, proposal-validation.mjs)
       -> commercial resolution against ops/billing-source-of-truth.json (validator)
       -> deterministic milestone amounts from the Approved Final Project Price
       -> PROP.2 presentation template (preview-proposal.mjs)
       -> self-contained HTML (CSS inlined) with safe audit metadata
       -> ops/proposals/out/ (gitignored) | --output

   This is generation ONLY. It does NOT implement Agreement execution,
   e-signature, invoice generation, payment collection, or Phase 5.
   The generated document is a Proposal — "Subject to the applicable Nexora
   Agreement." It is not a contract.

   Usage:  node ops/proposals/generate-proposal.mjs <proposal.json> [options]
           node ops/proposals/generate-proposal.mjs --example [options]
   Options:
     --output <path>   write to <path> (default: ops/proposals/out/{proposal_id}-v{version}.html)
     --overwrite       allow replacing an existing output for the same proposal_id + version
     --check           validate only, no render (exit 0 = generation-safe)
     --help            show usage

   Input safety:
     Real proposals   -> ops/proposals/private/  (gitignored; no _example marker required)
     Synthetic tests  -> ops/proposals/examples/ (must be marked "_example": true)
     Any other path   -> REFUSED (unsafe tracked/arbitrary data)

   PDF path: the HTML is fully print-ready — use browser Print -> Save as PDF.
   No external PDF engine or SaaS is required. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validatePackageMapping, validateProposal } from './proposal-validation.mjs';
import { buildViewModel, renderTemplate, fmtMoney } from './preview-proposal.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const proposalsDir = __dirname;
const root = path.join(__dirname, '..', '..');

const GENERATOR_VERSION = '1.0';
const TEMPLATE_PATH = path.join(proposalsDir, 'template', 'proposal-template.html');
const CSS_PATH = path.join(proposalsDir, 'template', 'proposal.css');
const OUT_DIR = path.join(proposalsDir, 'out');
const EXAMPLES_DIR = path.join(proposalsDir, 'examples');
const PRIVATE_DIR = path.join(proposalsDir, 'private');

/* ------------------------------------------------------------------ */
/* Milestone amount calculation (Step 10).                            */
/*                                                                     */
/* Amounts are derived from the APPROVED FINAL PROJECT PRICE, never    */
/* the public/reference price. Non-final tranches are rounded to whole */
/* pounds (Math.round — half up). The FINAL tranche absorbs any        */
/* rounding residual so the total of displayed milestone amounts       */
/* equals the Approved Final Project Price EXACTLY.                    */
/*                                                                     */
/* Milestone labels are neutral tranche numbering ("Tranche 1..n") —   */
/* no invented due dates or label vocabulary.                          */
/* ------------------------------------------------------------------ */
export function computeScheduleRows(approved, schedule) {
  if (!(typeof approved === 'number' && Number.isFinite(approved))) return null;
  if (!Array.isArray(schedule) || schedule.length === 0) return null;
  const rows = [];
  let accrued = 0;
  schedule.forEach((pct, i) => {
    let amount;
    if (i === schedule.length - 1) {
      amount = approved - accrued; /* final tranche absorbs the rounding residual */
    } else {
      amount = Math.round((approved * pct) / 100);
      accrued += amount;
    }
    rows.push({ pct, amount_display: fmtMoney(amount) });
  });
  return rows;
}

/* ------------------------------------------------------------------ */
/* Output naming (Step 16) — deterministic, sanitised.                */
/* ------------------------------------------------------------------ */
function cleanSegment(s) {
  const clean = String(s)
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return clean || 'proposal';
}

export function safeOutputFilename(proposalId, version) {
  return `${cleanSegment(proposalId)}-v${cleanSegment(version)}.html`;
}

export function defaultOutputPath(proposalId, version) {
  return path.join(OUT_DIR, safeOutputFilename(proposalId, version));
}

/* ------------------------------------------------------------------ */
/* Input location policy (Step 6) — real proposals are private.       */
/* ------------------------------------------------------------------ */
export function classifyInput(filePath) {
  const abs = path.resolve(filePath);
  if (abs.startsWith(path.resolve(PRIVATE_DIR) + path.sep)) return 'PRIVATE';
  if (abs.startsWith(path.resolve(EXAMPLES_DIR) + path.sep)) return 'EXAMPLES';
  return 'UNSAFE';
}

/* ------------------------------------------------------------------ */
/* Rendering (Step 17) — self-contained HTML with audit metadata.     */
/* ------------------------------------------------------------------ */
export function renderProposalDocument(data, opts = {}) {
  const sourceLabel = opts.sourceLabel || 'proposal';
  const tpl = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  const css = fs.readFileSync(CSS_PATH, 'utf8');

  const vm = buildViewModel(data);
  const cs = (data && data.commercial_schedule) || {};
  if (Array.isArray(cs.payment_schedule)) {
    vm.payment_schedule_rows = computeScheduleRows(cs.approved_final_project_price, cs.payment_schedule);
  }

  let html = renderTemplate(tpl, vm);
  html = html.replace('<link rel="stylesheet" href="proposal.css">', '<style>\n' + css + '\n</style>');

  const audit = [
    '<!--',
    `  Nexora Proposal Generator v${GENERATOR_VERSION} · schema nexora-proposal-schema-v1`,
    `  source: ${path.basename(sourceLabel)} · proposal_id: ${data.proposal_id} · version: ${data.version}`,
    `  generated: ${opts.generatedStamp || new Date().toISOString()}`,
    '  This document is a Proposal and is not a contract.',
    '-->'
  ].join('\n');
  html = html.replace('<!DOCTYPE html>', '<!DOCTYPE html>\n' + audit);

  return html;
}

/* ------------------------------------------------------------------ */
/* CLI                                                                */
/* ------------------------------------------------------------------ */
function usage(out) {
  out.write(`Nexora Proposal Generator (PROP.3) — v${GENERATOR_VERSION}
Usage:
  node ops/proposals/generate-proposal.mjs <proposal.json> [options]
  node ops/proposals/generate-proposal.mjs --example [options]

Options:
  --example        Render the synthetic B2 example (examples/sample-proposal.json)
  --output <path>  Write to <path> (default: ops/proposals/out/{proposal_id}-v{version}.html)
  --overwrite      Allow replacing an existing output for the same proposal_id + version
  --generated-at <ISO>  Deterministic timestamp override (document output system, tests)
  --check          Validate only (no render); exit 0 if the proposal is generation-safe
  --help           Show this help

Input safety:
  Real proposals   -> ops/proposals/private/  (gitignored) — validated, no _example needed
  Synthetic tests  -> ops/proposals/examples/ — must be marked "_example": true
  Any other path   -> refused (unsafe tracked/arbitrary data)

Validation before generation (fails closed): structure, offering identity,
commercial references vs ops/billing-source-of-truth.json, payment schedule,
setup fee, recurring semantics, Care, Warranty, validity, VAT UNDETERMINED,
and no obsolete legacy commercial language. No invalid Proposal is rendered.

PDF path: HTML -> browser Print -> Save as PDF (no external engine required).`);
}

function main() {
  const args = process.argv.slice(2);
  let inputPath = null;
  let output = null;
  let overwrite = false;
  let checkOnly = false;
  let wantExample = false;
  let help = false;
  let generatedAt = null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--example') wantExample = true;
    else if (a === '--output') { output = args[++i]; }
    else if (a === '--overwrite') overwrite = true;
    else if (a === '--generated-at') { generatedAt = args[++i]; }
    else if (a === '--check') checkOnly = true;
    else if (a === '--help' || a === '-h') help = true;
    else if (a.startsWith('-')) { usage(process.stderr); return 2; }
    else inputPath = a;
  }

  if (help) { usage(process.stdout); return 0; }
  if (!inputPath && !wantExample) { usage(process.stderr); return 2; }
  if (inputPath && wantExample) {
    process.stderr.write('Give either a proposal path or --example, not both.\n');
    return 2;
  }
  if (!output && wantExample) output = null; /* default naming from the example fixture */

  const sourcePath = wantExample ? path.join(EXAMPLES_DIR, 'sample-proposal.json') : path.resolve(inputPath);

  const kind = classifyInput(sourcePath);
  if (kind === 'UNSAFE') {
    process.stderr.write(`Refusing unsafe input: ${sourcePath}\n` +
      'Proposals must come from ops/proposals/private/ (real client proposals) or ' +
      'ops/proposals/examples/ (synthetic fixtures marked "_example": true).\n');
    return 1;
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  } catch (e) {
    process.stderr.write(`Cannot read proposal: ${e.message}\n`);
    return 1;
  }

  /* Fail-closed validation before generation (Step 7). */
  const mapping = validatePackageMapping();
  const proposal = validateProposal(data, { label: path.basename(sourcePath), requireExampleMarker: false });
  const failures = mapping.failures.concat(proposal.failures);
  if (kind === 'EXAMPLES' && data._example !== true) {
    failures.push(`${path.basename(sourcePath)} · unsafe committed fixture — examples/ must be marked "_example": true`);
  }

  if (failures.length > 0) {
    process.stderr.write(`VALIDATION FAILED — ${failures.length} issue(s). No Proposal generated.\n`);
    for (const f of failures) process.stderr.write(`  FAIL ${f}\n`);
    return 1;
  }

  if (checkOnly) {
    process.stdout.write(`VALID: ${path.basename(sourcePath)} (${proposal.checks.length} checks, 0 failures)\n`);
    return 0;
  }

  const html = renderProposalDocument(data, { sourceLabel: sourcePath, generatedStamp: generatedAt || undefined });
  const outPath = output ? path.resolve(output) : defaultOutputPath(data.proposal_id, data.version);

  if (fs.existsSync(outPath) && !overwrite) {
    process.stderr.write(`Refusing to overwrite existing output: ${path.relative(root, outPath)}\n` +
      'An output already exists for this proposal_id + version. Use --overwrite to replace.\n' +
      '(Accepted-proposal immutability enforcement belongs to PROP.4; generation never silently destroys history.)\n');
    return 1;
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html);
  const leftover = (html.match(/\{\{[\s\S]*?\}\}/g) || []);
  process.stdout.write(`Proposal generated: ${path.relative(root, outPath)}\n`);
  process.stdout.write(leftover.length ? `LEFTOVER TOKENS: ${leftover.join(', ')}\n` : 'No leftover tokens.\n');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = main();
  process.exit(code);
}
