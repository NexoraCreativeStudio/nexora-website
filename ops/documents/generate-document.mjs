#!/usr/bin/env node
/* Nexora Document Output System — CLI (PROP.6).
   Turns governed Proposal (PROP.1–PROP.4) and Agreement (PROP.5) documents into
   polished, deterministic, client-ready final outputs:

     proposal -> self-contained final HTML + manifest + SHA-256 checksums
                 (+ PDF via local headless Chrome where available)
     agreement -> same, honouring DRAFT | READY_FOR_EXECUTION status

   PROP.6 is PRESENTATION / OUTPUT only:
     - Proposal commercial data comes from PROP.3's governed render + validation.
     - Agreement legal decisions / provenance come from PROP.5's governed render +
       validation (handoff, accepted-Proposal fingerprint, READY gate).
     - No commercial data, legal decision, acceptance, or lifecycle status is
       created, modified, or re-derived here. Export is PURE.

   Rendering/export never modifies: Proposal status, Agreement status, acceptance
   status, commercial values, or legal decisions.

   Usage:
     node ops/documents/generate-document.mjs proposal <proposal.json> [options]
     node ops/documents/generate-document.mjs agreement <handoff.json> [options]
     node ops/documents/generate-document.mjs proposal --example [options]
     node ops/documents/generate-document.mjs agreement --example [options]

   Options:
     --html            Produce final HTML (default).
     --pdf             Also produce a PDF via headless Chrome (graceful fallback if
                       no local browser: HTML/print workflow only, still exit 0).
     --output <dir>    Output DIRECTORY (default: ops/documents/out/{proposals|agreements}).
     --overwrite       Allow replacing an existing output bundle for the same id+version.
     --check           Validate only (no render, no output); exit 0 = safe to generate.
     --generated-at <ISO>  Deterministic timestamp override (tests / archival).
     --example         Use the committed synthetic fixture for this document type.
     --help            Show this help.

   Agreement-only options (forwarded to the PROP.5 generator):
     --proposal <p>            accepted Proposal file (provenance re-verification)
     --acceptance-record <r>   acceptance record (provenance re-verification)
     --legal-decisions <p>     legal-decisions register (default: committed register)
     --status <DRAFT|READY_FOR_EXECUTION>   default DRAFT (no --force shortcut)

   Output bundles (deterministic, sanitised filenames, no client names):
     {ID}-v{version}.html                       proposal
     {ID}-v{version}-{STATUS}.html              agreement (DRAFT | READY_FOR_EXECUTION)
     {ID}-v{version}[-{STATUS}].pdf             optional
     {ID}-v{version}[-{STATUS}].manifest.json   machine-readable metadata + checksums

   Safety: generated outputs are never silently overwritten (require --overwrite);
   output must stay inside the repository root; final HTML is self-contained
   (CSS inlined), free of leftover {{tokens}}, legacy commercial content, VAT
   assertions, and absolute private paths. No real client data may be committed.

   PDF checksum ≠ digital signature. Final document output ≠ e-signature.
   Agreement READY_FOR_EXECUTION ≠ SIGNED. Document export ≠ invoice ≠ payment. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  DOC_OUTPUT_VERSION,
  PROPOSAL_OUT_DIR,
  AGREEMENT_OUT_DIR,
  sha256hex,
  safeProposalFilename,
  safeAgreementFilename,
  validateDerivedName,
  defaultOutputDir,
  assertSafeOutputDir,
  scanLegacy,
  scanVatAssertions,
  scanTokens,
  scanPathLeakage,
  findChrome,
  pdfAvailable,
  htmlToPdf,
  buildManifest
} from './document-output.mjs';
import { validatePackageMapping, validateProposal } from '../proposals/proposal-validation.mjs';
import { classifyInput as classifyProposalInput, renderProposalDocument } from '../proposals/generate-proposal.mjs';
import { proposalFingerprint, todayISO } from '../proposals/proposal-lifecycle.mjs';
import {
  AGREEMENT_VERSION,
  AGREEMENT_SCHEMA,
  AGREEMENT_ID_RE,
  AGREEMENT_STATUSES,
  classifyInput as classifyAgreementInput,
  validateAgreementHandoff,
  validateAgreement,
  loadLegalDecisions,
  isReadyForExecution
} from '../agreements/agreement-validation.mjs';
import {
  buildAgreement,
  renderAgreementDocument,
  resolveProvenanceFiles
} from '../agreements/generate-agreement.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..', '..');
const proposalsDir = path.join(root, 'ops', 'proposals');
const EXAMPLE_PROPOSAL = path.join(proposalsDir, 'examples', 'sample-proposal.json');
const EXAMPLE_HANDOFF = path.join(proposalsDir, 'examples', 'lifecycle', 'proposal-accepted.handoff.json');

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
function usage(out) {
  out.write(`Nexora Document Output System (PROP.6) — v${DOC_OUTPUT_VERSION}
Turns governed Proposal (PROP.1–PROP.4) and Agreement (PROP.5) documents into
final, deterministic, client-ready outputs (HTML + manifest + checksums, plus
optional PDF via a local headless Chrome). PRESENTATION/OUTPUT only.

Usage:
  node ops/documents/generate-document.mjs proposal <proposal.json> [options]
  node ops/documents/generate-document.mjs agreement <handoff.json> [options]
  node ops/documents/generate-document.mjs proposal --example [options]
  node ops/documents/generate-document.mjs agreement --example [options]

Options:
  --html                 Produce final HTML (default).
  --pdf                  Also produce a PDF via headless Chrome (graceful fallback
                         if no local browser — safe HTML/print workflow only).
  --output <dir>         Output DIRECTORY (default: ops/documents/out/{proposals|agreements}).
  --overwrite            Allow replacing an existing output bundle for the same id+version.
  --check                Validate only (no render, no output); exit 0 = safe to generate.
  --generated-at <ISO>   Deterministic timestamp override (tests / archival).
  --example              Use the committed synthetic fixture for this document type.
  --help                 Show this help.

Agreement-only options (forwarded to the PROP.5 generator):
  --proposal <p>            accepted Proposal file (provenance re-verification)
  --acceptance-record <r>   acceptance record (provenance re-verification)
  --legal-decisions <p>     legal-decisions register (default: committed register)
  --status <DRAFT|READY_FOR_EXECUTION>   default DRAFT (no --force shortcut)

Input safety (same as the generators):
  proposal  -> ops/proposals/private/ (real) | ops/proposals/examples/ (_example:true)
  agreement -> ops/proposals/private|examples/ + ops/agreements/private|examples/
  any other path -> refused.

PDF path: Governed HTML -> local headless Chrome -> Print-to-PDF.
If no local browser is available: browser Print -> Save as PDF (documented fallback).
A PDF checksum is an integrity aid, NOT a digital signature.`);
}

class CliError extends Error {}

function parseArgs(argv) {
  const o = { html: false, pdf: false, overwrite: false, check: false, example: false, help: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--html') o.html = true;
    else if (a === '--pdf') o.pdf = true;
    else if (a === '--output') o.output = argv[++i];
    else if (a === '--overwrite') o.overwrite = true;
    else if (a === '--check') o.check = true;
    else if (a === '--generated-at') o.generatedAt = argv[++i];
    else if (a === '--example') o.example = true;
    else if (a === '--proposal') o.proposal = argv[++i];
    else if (a === '--acceptance-record') o.acceptanceRecord = argv[++i];
    else if (a === '--legal-decisions') o.legalDecisions = argv[++i];
    else if (a === '--status') o.status = argv[++i];
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a.startsWith('-')) throw new CliError(`Unknown option: ${a}`);
    else positional.push(a);
  }
  o.positional = positional;
  return o;
}

/* Render + scan a final document. Scans are the archival layer's belt-and-braces:
   a final output that leaks a template token, legacy price, VAT claim or private
   path is defective and must not be archived. */
function finalizeHtml(html, docType, id) {
  const tokens = scanTokens(html);
  if (tokens.length > 0) throw new CliError(`LEFTOVER TEMPLATE TOKENS — ${tokens.join(', ')}. No ${docType} output written.`);
  const legacy = scanLegacy(html);
  if (legacy.length > 0) throw new CliError(`LEGACY COMMERCIAL CONTENT in final ${docType} (${id}): ${legacy.join('; ')}. Output refused.`);
  const vat = scanVatAssertions(html);
  if (vat.length > 0) throw new CliError(`UNSUPPORTED VAT ASSERTION in final ${docType} (${id}): ${vat.join('; ')}. Output refused.`);
  const leak = scanPathLeakage(html);
  if (leak.length > 0) throw new CliError(`PATH LEAKAGE in final ${docType} (${id}): ${leak.join('; ')}. Output refused.`);
  return html;
}

/* Shared bundle writer: HTML + optional PDF + manifest with overwrite protection. */
async function writeBundle({ docType, html, wantPdf, outputDir, baseName, documentId, version, status, generatedAt, sourceProposalId, sourceAgreementId, generatorSchema, overwrite }) {
  const dirErr = assertSafeOutputDir(outputDir);
  if (dirErr) throw new CliError(dirErr);

  const htmlFile = `${baseName}.html`;
  const pdfFile = `${baseName}.pdf`;
  const manifestFile = `${baseName}.manifest.json`;

  for (const f of [htmlFile, manifestFile, ...(wantPdf ? [pdfFile] : [])]) {
    const p = path.join(outputDir, f);
    if (fs.existsSync(p) && !overwrite) {
      throw new CliError(`Refusing to overwrite existing output: ${path.relative(root, p)} — use --overwrite to replace.\n(Generated documents are archived; generation never silently destroys history.)`);
    }
  }

  fs.mkdirSync(outputDir, { recursive: true });
  const htmlPath = path.join(outputDir, htmlFile);
  fs.writeFileSync(htmlPath, html);
  const htmlChecksum = sha256hex(html);

  let pdfChecksum = null;
  if (wantPdf) {
    const avail = pdfAvailable();
    if (!avail.available) {
      process.stdout.write('AUTOMATED PDF: NOT AVAILABLE — SAFE HTML/PRINT WORKFLOW ONLY\n');
      process.stdout.write('  Use browser Print -> Save as PDF on the generated HTML. HTML remains authoritative.\n');
    } else {
      const pdfPath = path.join(outputDir, pdfFile);
      let res;
      try {
        res = await htmlToPdf(htmlPath, pdfPath, { chromePath: avail.chromePath });
      } catch (e) {
        res = { ok: false, reason: `unexpected error: ${e.message}` };
      }
      if (!res.ok) {
        process.stdout.write(`AUTOMATED PDF: GENERATION FAILED — ${res.reason}\n`);
        process.stdout.write('  HTML remains authoritative; use browser Print -> Save as PDF.\n');
      } else {
        pdfChecksum = sha256hex(fs.readFileSync(pdfPath));
      }
    }
  }

  const manifest = buildManifest({
    docType,
    documentId,
    version,
    status,
    generatedAt,
    sourceProposalId,
    sourceAgreementId,
    htmlFilename: htmlFile,
    htmlChecksum,
    pdfFilename: pdfChecksum ? pdfFile : null,
    pdfChecksum,
    generatorSchema
  });
  fs.writeFileSync(path.join(outputDir, manifestFile), JSON.stringify(manifest, null, 2) + '\n');

  process.stdout.write(`${docType === 'agreement' ? 'Agreement' : 'Proposal'} final document generated: ${path.relative(root, htmlPath)}\n`);
  process.stdout.write(`  manifest:   ${path.relative(root, path.join(outputDir, manifestFile))}\n`);
  process.stdout.write(`  html sha256: ${htmlChecksum}\n`);
  if (pdfChecksum) process.stdout.write(`  pdf sha256:  ${pdfChecksum}\n`);
  return { htmlPath, manifest, pdfChecksum };
}

/* ------------------------------------------------------------------ */
/* PROPOSAL final document                                             */
/* ------------------------------------------------------------------ */
async function runProposal(opts) {
  const sourcePath = opts.example ? EXAMPLE_PROPOSAL : path.resolve(opts.positional[1]);
  const kind = classifyProposalInput(sourcePath);
  if (kind === 'UNSAFE') {
    throw new CliError(`Refusing unsafe input: ${sourcePath}\nProposals must come from ops/proposals/private/ (real) or ops/proposals/examples/ (synthetic, "_example": true).`);
  }

  let data;
  try { data = JSON.parse(fs.readFileSync(sourcePath, 'utf8')); }
  catch (e) { throw new CliError(`Cannot read proposal: ${e.message}`); }

  const mapping = validatePackageMapping();
  const proposal = validateProposal(data, { label: path.basename(sourcePath), requireExampleMarker: false });
  const failures = mapping.failures.concat(proposal.failures);
  if (kind === 'EXAMPLES' && data._example !== true) {
    failures.push(`${path.basename(sourcePath)} · unsafe committed fixture — examples/ must be marked "_example": true`);
  }
  if (failures.length > 0) {
    throw new CliError(`PROPOSAL VALIDATION FAILED — ${failures.length} issue(s). No final document generated.\n  ${failures.join('\n  ')}`);
  }

  if (opts.check) {
    process.stdout.write(`VALID: ${path.basename(sourcePath)} (${proposal.checks.length} checks, 0 failures)\n`);
    return;
  }

  const generatedStamp = opts.generatedAt || new Date().toISOString();
  const html = finalizeHtml(renderProposalDocument(data, { sourceLabel: sourcePath, generatedStamp }), 'proposal', data.proposal_id);

  const baseName = safeProposalFilename(data.proposal_id, data.version).replace(/\.html$/, '');
  const nameErr = validateDerivedName(baseName + '.html');
  if (nameErr) throw new CliError(nameErr);
  const outputDir = opts.output ? path.resolve(opts.output) : defaultOutputDir('proposal');

  await writeBundle({
    docType: 'proposal',
    html,
    wantPdf: opts.pdf,
    outputDir,
    baseName,
    documentId: data.proposal_id,
    version: data.version,
    status: data.status,
    generatedAt: generatedStamp,
    sourceProposalId: data.proposal_id,
    sourceAgreementId: null,
    generatorSchema: 'nexora-proposal-schema-v1',
    overwrite: opts.overwrite
  });
}

/* ------------------------------------------------------------------ */
/* AGREEMENT final document                                            */
/* ------------------------------------------------------------------ */
async function runAgreement(opts) {
  const handoffPath = opts.example ? EXAMPLE_HANDOFF : path.resolve(opts.positional[1]);
  const kind = classifyAgreementInput(handoffPath);
  if (kind === 'UNSAFE') {
    throw new CliError(`Refusing unsafe input: ${handoffPath}\nAgreement handoffs must come from ops/proposals/private|examples/ or ops/agreements/private|examples/.`);
  }

  if (opts.status && !AGREEMENT_STATUSES.includes(opts.status)) {
    throw new CliError(`Invalid --status "${opts.status}" — must be one of ${AGREEMENT_STATUSES.join(', ')} (SIGNED/EXECUTED is an external gate, not modelled).`);
  }

  let handoff;
  try { handoff = JSON.parse(fs.readFileSync(handoffPath, 'utf8')); }
  catch (e) { throw new CliError(`Cannot read handoff: ${e.message}`); }

  const h = validateAgreementHandoff(handoff, { label: path.basename(handoffPath) });
  if (h.failures.length > 0) {
    throw new CliError(`HANDOFF VALIDATION FAILED — ${h.failures.length} issue(s). No final document generated.\n  ${h.failures.join('\n  ')}`);
  }

  /* Provenance re-verification (same fail-closed chain as PROP.5). */
  const pid = handoff.proposal.proposal_id;
  const pver = handoff.proposal.version;
  const resolved = resolveProvenanceFiles(handoffPath, kind, { proposalId: pid, proposalVersion: pver, ...opts });

  if (!resolved.proposal || !fs.existsSync(resolved.proposal)) throw new CliError('PROVENANCE FAILED — accepted Proposal file not found. Supply --proposal <accepted proposal.json>.');
  if (classifyAgreementInput(resolved.proposal) === 'UNSAFE') throw new CliError(`Refusing unsafe --proposal path: ${resolved.proposal}`);
  if (!resolved.record || !fs.existsSync(resolved.record)) throw new CliError('PROVENANCE FAILED — acceptance record not found. Supply --acceptance-record <record.json>.');
  if (classifyAgreementInput(resolved.record) === 'UNSAFE') throw new CliError(`Refusing unsafe --acceptance-record path: ${resolved.record}`);

  let proposal;
  let record;
  try {
    proposal = JSON.parse(fs.readFileSync(resolved.proposal, 'utf8'));
    record = JSON.parse(fs.readFileSync(resolved.record, 'utf8'));
  } catch (e) { throw new CliError(`Cannot read provenance files: ${e.message}`); }

  const fp = proposalFingerprint(proposal);
  if (proposal.status !== 'CLIENT_ACCEPTED') {
    throw new CliError(`PROVENANCE FAILED — proposal is ${proposal.status}, not CLIENT_ACCEPTED. An Agreement may only derive from an accepted Proposal.`);
  }
  if (fp !== handoff.acceptance.content_sha256) {
    throw new CliError(`FINGERPRINT MISMATCH — the accepted Proposal does not match the handoff's recorded fingerprint.\n  recorded: ${handoff.acceptance.content_sha256}\n  current:  ${fp}`);
  }
  if (record.schema !== 'nexora-proposal-acceptance/v1' || record.proposal_id !== pid || record.version !== pver || record.content_sha256 !== fp) {
    throw new CliError('ACCEPTANCE RECORD MISMATCH — record does not match the accepted Proposal fingerprint.');
  }

  const snap = handoff.commercial_snapshot || {};
  const cs = proposal.commercial_schedule || {};
  const same = (a, b) => (a == null && b == null) || (a != null && b != null && JSON.stringify(a) === JSON.stringify(b));
  const snapKeys = ['currency', 'reference_price', 'approved_final_project_price', 'setup_fee', 'payment_schedule', 'recurring_fees', 'care', 'warranty', 'vat'];
  const drift = snapKeys.filter((k) => !same(snap[k], cs[k]));
  if (drift.length > 0) {
    throw new CliError(`COMMERCIAL DRIFT — handoff snapshot differs from accepted Proposal: ${drift.join(', ')}. Refusing to generate.`);
  }

  /* Build + validate the Agreement (PROP.5 authority), honouring DRAFT | READY. */
  const generatedStamp = opts.generatedAt || new Date().toISOString();
  const createdAt = /^\d{4}-\d{2}-\d{2}/.test(generatedStamp) ? generatedStamp.slice(0, 10) : todayISO();
  const status = opts.status || 'DRAFT';
  const agreementId = 'AGR-' + pid.slice(4);

  let decisions;
  try { decisions = loadLegalDecisions(opts.legalDecisions); }
  catch (e) { throw new CliError(e.message); }
  const agreement = buildAgreement({ handoff, proposal, record, decisions, status, createdAt, agreementId });

  const v = validateAgreement(agreement, { label: 'generated', requireExampleMarker: false, legalDecisionsPath: opts.legalDecisions });
  if (v.failures.length > 0) {
    throw new CliError(`AGREEMENT VALIDATION FAILED — ${v.failures.length} issue(s). No final document generated.\n  ${v.failures.join('\n  ')}`);
  }
  if (status === 'READY_FOR_EXECUTION') {
    const gate = isReadyForExecution(agreement, decisions);
    if (!gate.ready) {
      throw new CliError(`READY_FOR_EXECUTION REFUSED — unresolved decisions remain:\n  ${gate.reasons.join('\n  ')}\nResolve every mandatory decision through the approved register first. No force-ready shortcut.`);
    }
  }

  if (opts.check) {
    process.stdout.write(`VALID: ${path.basename(handoffPath)} -> ${agreementId} v${agreement.version} (${status})\n`);
    return;
  }

  const html = finalizeHtml(renderAgreementDocument(agreement, { sourceLabel: handoffPath, generatedStamp }), 'agreement', agreementId);

  const baseName = safeAgreementFilename(agreementId, agreement.version, status).replace(/\.html$/, '');
  const nameErr = validateDerivedName(baseName + '.html');
  if (nameErr) throw new CliError(nameErr);
  const outputDir = opts.output ? path.resolve(opts.output) : defaultOutputDir('agreement');

  await writeBundle({
    docType: 'agreement',
    html,
    wantPdf: opts.pdf,
    outputDir,
    baseName,
    documentId: agreementId,
    version: agreement.version,
    status,
    generatedAt: generatedStamp,
    sourceProposalId: pid,
    sourceAgreementId: agreementId,
    generatorSchema: AGREEMENT_SCHEMA,
    overwrite: opts.overwrite
  });
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); }
  catch (e) { process.stderr.write(`${e.message}\n`); usage(process.stderr); return 2; }

  if (opts.help) { usage(process.stdout); return 0; }
  const docType = opts.positional[0];
  if (docType !== 'proposal' && docType !== 'agreement') {
    process.stderr.write('Usage: node ops/documents/generate-document.mjs <proposal|agreement> <input> [options]\n');
    return 2;
  }
  const hasInput = opts.positional.length >= 2;
  if (!hasInput && !opts.example) { usage(process.stderr); return 2; }
  if (hasInput && opts.example) { process.stderr.write('Give either an input path or --example, not both.\n'); return 2; }

  try {
    if (docType === 'proposal') await runProposal(opts);
    else await runAgreement(opts);
    return 0;
  } catch (e) {
    if (e instanceof CliError) { process.stderr.write(`${e.message}\n`); return 1; }
    process.stderr.write(`ERROR: ${e.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code));
}
