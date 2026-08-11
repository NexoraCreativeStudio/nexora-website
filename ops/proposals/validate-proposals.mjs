#!/usr/bin/env node
/* Nexora Proposal System validation (PROP.1).
   Thin CLI over the shared validation core in proposal-validation.mjs
   (same checks, same labels, same exit behaviour as before PROP.3).

   Usage:  node ops/proposals/validate-proposals.mjs [extra proposal files...]
   Default: validates every .json in ops/proposals/examples/ plus any files given.
   exit 0 = all checks pass.
   Real client proposal instances live in ops/proposals/private/ (gitignored) and are
   never validated here. Every committed fixture must be marked "_example": true. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePackageMapping, validateProposal } from './proposal-validation.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const proposalsDir = __dirname;
const root = path.join(__dirname, '..', '..');

let failureCount = 0;
const printChecks = (checks) => {
  for (const c of checks) {
    if (c.ok) console.log(`  ok   ${c.text}`);
    else { console.log(`  FAIL ${c.text}`); }
  }
};

/* ---- package mapping + architecture ---- */

console.log('Validating proposal package mapping against ops/billing-source-of-truth.json…');
const mapping = validatePackageMapping();
printChecks(mapping.checks);
failureCount += mapping.failures.length;

/* ---- proposal instances ---- */

const files = [];
const exampleDir = path.join(proposalsDir, 'examples');
if (fs.existsSync(exampleDir)) {
  for (const f of fs.readdirSync(exampleDir)) {
    if (f.endsWith('.json')) files.push(path.join(exampleDir, f));
  }
}
for (const arg of process.argv.slice(2)) files.push(path.resolve(arg));

if (files.length === 0) {
  console.log('\nNo proposal fixtures found to validate.');
} else {
  for (const file of files) {
    console.log(`\nValidating ${path.relative(root, file)}…`);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      failureCount += 1;
      console.log(`  FAIL ${file} · parse — malformed JSON — ${e.message}`);
      continue;
    }
    const result = validateProposal(data, { label: path.basename(file), requireExampleMarker: true });
    printChecks(result.checks);
    failureCount += result.failures.length;
  }
}

/* ---- summary ---- */

console.log(failureCount === 0 ? '\nALL PROPOSAL CHECKS PASSED' : `\n${failureCount} PROPOSAL CHECK(S) FAILED`);
process.exit(failureCount === 0 ? 0 : 1);
