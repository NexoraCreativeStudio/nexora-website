/* Nexora Proposal template-layer validation (PROP.2).
   Checks the reusable template does not become a second pricing source, contains no
   obsolete/legacy commercial content, makes no unsupported VAT claim, carries no real
   client data, exposes the required data-binding hooks, and actually renders every
   committed synthetic fixture without leftover tokens (conditionals applied).

   Usage:  node ops/proposals/validate-proposal-template.mjs
   exit 0 = all checks pass. Does NOT modify or weaken validate-proposals.mjs. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderProposal } from './preview-proposal.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const proposalsDir = __dirname;
const root = path.join(__dirname, '..', '..');

const TPL = fs.readFileSync(path.join(proposalsDir, 'template', 'proposal-template.html'), 'utf8');
const CSS = fs.readFileSync(path.join(proposalsDir, 'template', 'proposal.css'), 'utf8');

const failures = [];
const pass = (l) => console.log(`  ok   ${l}`);
const fail = (l, d) => { failures.push(l); console.log(`  FAIL ${l}${d ? ' — ' + d : ''}`); };

console.log('Validating proposal template layer…');

/* 1. No hard-coded prices / no second pricing source. */
if (/£\s*\d/.test(TPL)) fail('template · hard-coded price', 'template must contain no literal £ amounts');
else pass('template · no hard-coded prices');

/* 2. No literal schedule percentages. */
if (/\b\d{1,3}\s*%/.test(TPL)) fail('template · hard-coded schedule %', 'template must contain no literal percentages');
else pass('template · no hard-coded schedule percentages');

/* 3. No obsolete / legacy commercial content. */
for (const re of [/\bStarter\b/i, /\bElite\b/i, /£250/i, /\bdeposit\b/i, /buy\.stripe\.com/i, /paypal\.com/i, /\bAI\s+Care\b/i]) {
  if (re.test(TPL)) fail('template · legacy content', `matched ${re}`);
}
if (/\b(Starter|Elite|deposit|£250|AI Care|buy\.stripe|paypal)/i.test(TPL) || /£\s*\d/.test(TPL)) {
  /* already flagged above */
} else {
  pass('template · no legacy / obsolete commercial content');
}

/* 4. No invented VAT claim. */
const vatAssertions = [
  /\bVAT\s+registered\b/i, /\bregistered\s+for\s+VAT\b/i,
  /\b20\s*%\s*VAT\b/i, /\bVAT\s+at\s+\d+\s*%/i,
  /\bVAT\s+included\b/i, /\bVAT\s+excluded\b/i, /\bVAT\s+inclusive\b/i, /\bVAT\s+exclusive\b/i,
  /\btax\s+amount\b/i
];
if (vatAssertions.some((re) => re.test(TPL))) fail('template · VAT assertion', 'unsupported tax claim in template');
else pass('template · no unsupported VAT assertion (neutral tax note only)');

/* 5. No real client data in the template. */
const emailRe = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const phoneRe = /\b0\d{3}\s*\d{3}\s*\d{3}\b/;
if (emailRe.test(TPL)) fail('template · real contact data', 'template must not contain literal email addresses');
if (phoneRe.test(TPL)) fail('template · real contact data', 'template must not contain literal phone numbers');
if (/Example Aesthetics|example\.com|01234/.test(TPL)) fail('template · fixture data', 'template must not embed fixture/client data');
if (!emailRe.test(TPL) && !phoneRe.test(TPL) && !/Example Aesthetics|example\.com|01234/.test(TPL)) pass('template · no real client data');

/* 6. Required data-binding hooks present. */
const requiredTokens = [
  '{{proposal_id}}', '{{version}}', '{{status_label}}', '{{issue_date}}', '{{valid_until}}',
  '{{client_company}}', '{{project_title}}', '{{project_summary}}',
  '{{offering_code}}', '{{offering_category}}', '{{offering_name}}',
  '{{currency}}', '{{approved_price_display}}', '{{acceptance_status}}'
];
for (const tok of requiredTokens) {
  (TPL.includes(tok) ? pass : fail)(`template · hook ${tok}`);
}

const requiredBlocks = [
  '{{#if reference_price_display}}', '{{#if setup_fee_display}}',
  '{{#if payment_schedule_rows}}', '{{#each payment_schedule_rows}}',
  '{{#if recurring_monthly_display}}', '{{#if care_plan_display}}', '{{#if warranty_label}}'
];
for (const tok of requiredBlocks) {
  (TPL.includes(tok) ? pass : fail)(`template · conditional ${tok}`);
}

/* 7. Balanced tokens. */
const count = (needle) => TPL.split(needle).length - 1;
if (count('{{') !== count('}}')) fail('template · token balance', `{{ ${count('{{')} vs }} ${count('}}')}`);
if (count('{{#if') !== count('{{/if')) fail('template · if balance', `${count('{{#if')} opens vs ${count('{{/if')} closes`);
if (count('{{#unless') !== count('{{/unless')) fail('template · unless balance', `${count('{{#unless')} opens vs ${count('{{/unless')} closes`);
if (count('{{#each') !== count('{{/each')) fail('template · each balance', `${count('{{#each')} opens vs ${count('{{/each')} closes`);
if (count('{{') === count('}}') && count('{{#if') === count('{{/if') && count('{{#unless') === count('{{/unless') && count('{{#each') === count('{{/each')) {
  pass('template · token balance');
}

/* 8. Render smoke test — every committed fixture must render with no leftover tokens. */
const examplesDir = path.join(proposalsDir, 'examples');
const fixtures = fs.existsSync(examplesDir)
  ? fs.readdirSync(examplesDir).filter((f) => f.endsWith('.json'))
  : [];
if (fixtures.length === 0) {
  fail('template · fixtures', 'no example fixtures found to render');
}

for (const f of fixtures) {
  const data = JSON.parse(fs.readFileSync(path.join(examplesDir, f), 'utf8'));
  const html = renderProposal(data);
  const leftover = html.match(/\{\{[\s\S]*?\}\}/g) || [];
  if (leftover.length > 0) {
    fail(`render · ${f}`, `leftover tokens: ${leftover.join(', ')}`);
  } else {
    pass(`render · ${f} · no leftover tokens`);
  }
  /* Conditional behaviour spot-checks per fixture (synthetic, validated data only). */
  if (data.offering && data.offering.code === 'B2') {
    (html.includes('Approved Final Project Price') ? pass : fail)('render · B2 shows Approved Final Project Price');
    (html.includes('£5,100') ? pass : fail)('render · B2 shows approved £5,100');
    (html.includes('From £4,250') ? pass : fail)('render · B2 shows reference From £4,250');
    (html.includes('90-day Web Launch Warranty') ? pass : fail)('render · B2 shows warranty');
    (html.includes('does not automatically equal') ? pass : fail)('render · B2 reference distinct from final');
  }
  if (data.offering && data.offering.code === 'A2') {
    (!html.includes('Reference / public starting price') ? pass : fail)('render · A2 hides invented reference price');
    (html.includes('Recurring billing begins at Go-Live') ? pass : fail)('render · A2 recurring starts at Go-Live');
    (html.includes('£697') ? pass : fail)('render · A2 shows monthly £697');
    (html.includes('Web Care Plus') ? pass : fail)('render · A2 shows Care plan');
    (html.includes('£329') ? pass : fail)('render · A2 shows Care monthly £329');
  }
}

/* 9. Stylesheet present and sane. */
if (CSS.includes('@page') && CSS.includes('A4')) pass('css · print-ready (@page A4)');
else fail('css · print rules', '@page A4 missing');
if (CSS.includes('@media (max-width: 640px)')) pass('css · responsive breakpoint present');
else fail('css · responsive', 'narrow-viewport rules missing');

console.log(failures.length === 0 ? '\nALL TEMPLATE CHECKS PASSED' : `\n${failures.length} TEMPLATE CHECK(S) FAILED`);
process.exit(failures.length === 0 ? 0 : 1);
