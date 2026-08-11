/* Nexora operational validation — asserts the frozen billing invariants against
   ops/billing-source-of-truth.json so the operational layer cannot silently drift.
   Usage: node ops/validate-ops.mjs   (expect exit 0 + "ALL CHECKS PASSED"). */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = JSON.parse(fs.readFileSync(path.join(__dirname, 'billing-source-of-truth.json'), 'utf8'));

const failures = [];
const pass = (label) => console.log(`  ok   ${label}`);
const fail = (label, detail) => { failures.push(label); console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); };

console.log('Validating Nexora billing source of truth…');

/* 1. Frozen AI amounts and separation. */
for (const [k, p] of Object.entries(src.ai.plans)) {
  const impl = typeof p.implementation_fee === 'object' ? p.implementation_fee.from : p.implementation_fee;
  const mo = typeof p.monthly_fee === 'object' ? p.monthly_fee.from : p.monthly_fee;
  if (typeof impl !== 'number' || impl <= 0) fail(`ai.${k}.implementation_fee`, 'must be a positive number');
  else pass(`ai.${k} implementation fee positive`);
  if (typeof mo !== 'number' || mo <= 0) fail(`ai.${k}.monthly_fee`, 'must be a positive number');
  else pass(`ai.${k} monthly fee positive`);
}
if (src.ai.recurring_start === 'GO_LIVE') pass('AI recurring billing starts at Go-Live');
else fail('ai.recurring_start', 'must be GO_LIVE');
if (src.ai.ai_care === false) pass('No AI Care');
else fail('ai.ai_care', 'must be false — AI Care does not exist');

/* 2. Web schedule correctness. */
for (const [k, p] of Object.entries(src.web.packages)) {
  if (k === 'B3') {
    if (p.schedule === 'BESPOKE_MILESTONE_SCHEDULE' && p.price.bespoke === true) pass('B3 is bespoke with no invented percentage schedule');
    else fail('web.B3', 'must be bespoke with no numeric schedule');
  } else {
    if (Array.isArray(p.schedule) && p.schedule.reduce((a, b) => a + b, 0) === 100) pass(`web.${k} schedule sums to 100`);
    else fail(`web.${k}.schedule`, 'must sum to 100');
  }
}
if (src.web.final_handover === 'AFTER_PROJECT_BALANCE_PAID') pass('Final handover after project balance paid');
else fail('web.final_handover', 'must be AFTER_PROJECT_BALANCE_PAID');

/* 3. Brand schedule correctness. */
for (const [k, p] of Object.entries(src.brand.packages)) {
  if (Array.isArray(p.schedule) && p.schedule.reduce((a, b) => a + b, 0) === 100) pass(`brand.${k} schedule sums to 100`);
  else fail(`brand.${k}.schedule`, 'must sum to 100');
}

/* 4. Complete — 30/30/30/10 = 100, first tranche is part of the total, no extra deposit. */
if (Array.isArray(src.complete.schedule) && src.complete.schedule.reduce((a, b) => a + b, 0) === 100) pass('Complete schedule sums to 100');
else fail('complete.schedule', 'must sum to 100');
if (src.complete.schedule[0] !== 30) fail('complete.schedule[0]', 'must be 30');
else pass('Complete first tranche is 30% of the total (not a separate deposit)');

/* 5. Care — monthly amounts positive and separated. */
for (const [k, c] of Object.entries(src.care.web)) {
  const fee = typeof c.monthly_fee === 'object' ? c.monthly_fee.from : c.monthly_fee;
  if (typeof fee === 'number' && fee > 0) pass(`care.web.${k} monthly fee positive`);
  else fail(`care.web.${k}.monthly_fee`, 'must be positive');
}
for (const [k, c] of Object.entries(src.care.brand)) {
  const fee = typeof c.monthly_fee === 'object' ? c.monthly_fee.from : c.monthly_fee;
  if (typeof fee === 'number' && fee > 0) pass(`care.brand.${k} monthly fee positive`);
  else fail(`care.brand.${k}.monthly_fee`, 'must be positive');
}

/* 6. Invoice terms — 7-day due, 30-day proposal validity, distinct concepts. */
if (src.invoice_terms.project_invoice_due_days === 7) pass('Project invoice due = 7 calendar days');
else fail('invoice_terms.project_invoice_due_days', 'must be 7');
if (src.invoice_terms.proposal_validity_days === 30) pass('Proposal validity = 30 days');
else fail('invoice_terms.proposal_validity_days', 'must be 30');

/* 7. Change request billing policy present. */
for (const tier of ['immaterial', 'material', 'large']) {
  if (src.change_requests[tier]) pass(`change_requests.${tier} policy present`);
  else fail(`change_requests.${tier}`, 'must be present');
}

/* 8. VAT — must remain undetermined (no invented tax status). */
if (src.vat.status === 'UNDETERMINED') pass('VAT status remains UNDETERMINED (external validation required)');
else fail('vat.status', 'must be UNDETERMINED');

/* 9. Currency GBP. */
if (src.currency === 'GBP') pass('Currency GBP');
else fail('currency', 'must be GBP');

console.log(failures.length === 0 ? '\nALL CHECKS PASSED' : `\n${failures.length} CHECK(S) FAILED`);
process.exit(failures.length === 0 ? 0 : 1);
