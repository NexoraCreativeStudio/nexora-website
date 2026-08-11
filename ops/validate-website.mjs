/* Nexora website commercial-drift validation.
   Reads the AUTHORITATIVE source (ops/billing-source-of-truth.json) and asserts the
   published website pages still carry the frozen public prices and no obsolete items.
   Usage: node ops/validate-website.mjs   (exit 0 = all checks pass). */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const src = JSON.parse(fs.readFileSync(path.join(__dirname, 'billing-source-of-truth.json'), 'utf8'));
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const HOME_EN = 'index.html';
const HOME_DE = 'de/index.html';
const WEB = 'luxury-clinic-websites/index.html';
const BRAND = 'brand-studio/index.html';

const fmtFixed = (n) => '£' + n.toLocaleString('en-GB');
const fmtFrom = (v, fromWord = 'From') => (typeof v === 'object' ? fromWord + ' £' + v.from.toLocaleString('en-GB') : fmtFixed(v));

const failures = [];
const pass = (l) => console.log(`  ok   ${l}`);
const fail = (l, d) => { failures.push(l); console.log(`  FAIL ${l}${d ? ' — ' + d : ''}`); };
const expectIn = (label, content, needle) => (content.includes(needle) ? pass(`${label}: "${needle}" present`) : fail(`${label}: "${needle}"`, 'missing'));
const expectNotIn = (label, content, needle) => (content.includes(needle) ? fail(`${label}: "${needle}"`, 'must be absent') : pass(`${label}: "${needle}" absent`));

console.log('Validating website public pricing against ops/billing-source-of-truth.json…');

/* AI — homepage EN + DE. German renders the "from" implementation fee as "Ab £…";
   the monthly amount is hard-coded "From £…" in both languages. */
for (const [tag, file] of [['home-en', HOME_EN], ['home-de', HOME_DE]]) {
  const html = read(file);
  const fromWord = tag === 'home-de' ? 'Ab' : 'From';
  for (const [k, p] of Object.entries(src.ai.plans)) {
    const impl = typeof p.implementation_fee === 'object' ? fromWord + ' £' + p.implementation_fee.from.toLocaleString('en-GB') : fmtFixed(p.implementation_fee);
    const mo = fmtFrom(p.monthly_fee);
    expectIn(`${tag} · ${k}`, html, mo);
    expectIn(`${tag} · ${k} impl`, html, impl);
  }
  expectIn(`${tag} · Complete`, html, 'Nexora Complete');
  expectNotIn(`${tag} · old price`, html, '£1,200');
  expectNotIn(`${tag} · old tier`, html, 'Starter');
  expectNotIn(`${tag} · old tier`, html, 'Elite');
  expectNotIn(`${tag} · AI Care`, html, 'AI Care');
}

/* Web. */
{
  const html = read(WEB);
  for (const [k, p] of Object.entries(src.web.packages)) expectIn(`web · ${k}`, html, fmtFrom(p.price));
  for (const [k, c] of Object.entries(src.care.web)) expectIn(`web · ${k}`, html, fmtFrom(c.monthly_fee));
  expectIn('web · warranty', html, '90-day Web Launch Warranty');
  expectNotIn('web · deposit CTA', html, '£250 secures');
  expectNotIn('web · deposit CTA', html, 'Pay £250');
}

/* Brand. */
{
  const html = read(BRAND);
  for (const [k, p] of Object.entries(src.brand.packages)) expectIn(`brand · ${k}`, html, fmtFrom(p.price));
  for (const [k, c] of Object.entries(src.care.brand)) expectIn(`brand · ${k}`, html, fmtFrom(c.monthly_fee));
}

/* Obsolete checkout/payment-claim absence across all public pages. */
for (const [tag, file] of [['home-en', HOME_EN], ['home-de', HOME_DE], ['web', WEB], ['brand', BRAND]]) {
  const html = read(file);
  expectNotIn(`${tag} · stripe`, html, 'buy.stripe.com');
  expectNotIn(`${tag} · paypal`, html, 'paypal.com');
}

console.log(failures.length === 0 ? '\nALL WEBSITE CHECKS PASSED' : `\n${failures.length} WEBSITE CHECK(S) FAILED`);
process.exit(failures.length === 0 ? 0 : 1);
