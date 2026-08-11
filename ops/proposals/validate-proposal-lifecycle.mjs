#!/usr/bin/env node
/* Nexora Proposal Lifecycle validation (PROP.4).
   Verifies the governed lifecycle layer comprehensively:

   - static safety of ops/proposals/proposal-lifecycle.mjs
   - the canonical status/transition model (PROP.1 enum extended with DECLINED)
   - deterministic canonical SHA-256 fingerprinting
   - positive CLI flows: issue, accept (fingerprint + acceptance record), decline,
     expire, supersede, verify, and Agreement handoff from an ACCEPTED Proposal
   - negative flows that must FAIL CLOSED: invalid transitions, acceptance of an
     expired/declined/DRAFT proposal, backwards transitions, tampering with an
     accepted Proposal, overwriting an accepted version, handoff from non-accepted
     states, invalid supersession, legacy Starter/£250 language, unsupported VAT,
     and commercial Source-of-Truth drift
   - privacy: only synthetic fixtures (_example: true) are committed; no real client
     data; acceptance records and handoffs stay under gitignored private/

   Temporary fixtures are created ONLY under ops/proposals/private/.tmp-tests/lifecycle/
   (gitignored) and removed after the run. exit 0 = all checks pass.
   Never touches ops/billing-source-of-truth.json. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { validateProposal, STATUSES } from './proposal-validation.mjs';
import {
  LIFECYCLE_VERSION,
  CANONICAL_FORMAT,
  ACCEPTANCE_SCHEMA,
  HANDOFF_SCHEMA,
  TRANSITIONS,
  TERMINAL,
  canonicalProposal,
  proposalFingerprint,
  isExpired,
  versionGt
} from './proposal-lifecycle.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const proposalsDir = __dirname;
const root = path.join(__dirname, '..', '..');

const LIFECYCLE = path.join(proposalsDir, 'proposal-lifecycle.mjs');
const EXAMPLES_DIR = path.join(proposalsDir, 'examples');
const LIFECYCLE_EXAMPLES = path.join(EXAMPLES_DIR, 'lifecycle');
const PRIVATE_TMP = path.join(proposalsDir, 'private', '.tmp-tests', 'lifecycle');

const failures = [];
const pass = (l) => console.log(`  ok   ${l}`);
const fail = (l, d) => { failures.push(l); console.log(`  FAIL ${l}${d ? ' — ' + d : ''}`); };

const run = (args) => {
  try {
    const stdout = execFileSync(process.execPath, [LIFECYCLE, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, stdout };
  } catch (e) {
    return { status: typeof e.status === 'number' ? e.status : 1, stdout: String(e.stdout || '') + String(e.stderr || '') };
  }
};

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const writeJson = (p, obj) => fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
const tmpPath = (name) => path.join(PRIVATE_TMP, name);

/* Copy a committed lifecycle fixture into the gitignored tmp area. */
const copyFixture = (name, dest) => {
  const src = path.join(LIFECYCLE_EXAMPLES, name);
  const out = tmpPath(dest || name);
  fs.copyFileSync(src, out);
  return out;
};

const lifecycleSrc = fs.readFileSync(LIFECYCLE, 'utf8');
const schema = readJson(path.join(proposalsDir, 'proposal.schema.json'));

console.log('Validating proposal lifecycle layer (PROP.4)…');

/* ------------------------------------------------------------------ */
/* 1 · static safety                                                   */
/* ------------------------------------------------------------------ */
if (fs.existsSync(LIFECYCLE)) pass(`lifecycle · file present`);
else fail('lifecycle · file present', 'proposal-lifecycle.mjs missing');

if (fs.existsSync(path.join(proposalsDir, 'proposal-validation.mjs'))) pass('lifecycle · shared validation core present');
else fail('lifecycle · shared validation core present', 'proposal-validation.mjs missing');

const schemaStatus = (schema.properties.status && schema.properties.status.enum) || [];
if (schemaStatus.includes('DECLINED')) pass('schema · status enum includes DECLINED');
else fail('schema · status enum includes DECLINED');
if (JSON.stringify(schemaStatus) === JSON.stringify(STATUSES)) pass(`schema · status enum matches shared core (${STATUSES.join(', ')})`);
else fail('schema · status enum matches shared core', `schema ${JSON.stringify(schemaStatus)} vs core ${JSON.stringify(STATUSES)}`);
if (schema.properties.supersedes && schema.properties.superseded_by) pass('schema · supersedes + superseded_by present');
else fail('schema · supersedes + superseded_by present');

if (/£\s*\d/.test(lifecycleSrc)) fail('lifecycle · no hard-coded prices', 'proposal-lifecycle.mjs must contain no literal £ amounts');
else pass('lifecycle · no hard-coded prices');
for (const re of [/\bStarter\b/i, /\bElite\b/i, /£250/i, /\bbuy\.stripe\.com/i, /\bpaypal\.com/i, /\bAI\s+Care\b/i]) {
  if (re.test(lifecycleSrc)) fail('lifecycle · legacy content', `matched ${re}`);
}
if (!/(Starter|Elite|£250|buy\.stripe|paypal|AI Care)/i.test(lifecycleSrc)) pass('lifecycle · no legacy / obsolete commercial content');
const vatAssertions = [
  /\bVAT\s+registered\b/i, /\bregistered\s+for\s+VAT\b/i, /\b20\s*%\s*VAT\b/i, /\bVAT\s+at\s+\d+\s*%/i,
  /\bVAT\s+included\b/i, /\bVAT\s+excluded\b/i, /\bVAT\s+inclusive\b/i, /\bVAT\s+exclusive\b/i, /\btax\s+amount\b/i
];
if (vatAssertions.some((re) => re.test(lifecycleSrc))) fail('lifecycle · no VAT determination in source');
else pass('lifecycle · no VAT determination in source');

const importSpecifiers = [...lifecycleSrc.matchAll(/import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g)].map((m) => m[1]);
const nonBuiltin = importSpecifiers.filter((s) => !s.startsWith('node:') && !s.startsWith('./') && !s.startsWith('../'));
if (nonBuiltin.length === 0) pass(`lifecycle · Node built-ins only (${importSpecifiers.join(', ')})`);
else fail('lifecycle · Node built-ins only', `external imports: ${nonBuiltin.join(', ')}`);

const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
if (gitignore.includes('ops/proposals/private/') && gitignore.includes('ops/proposals/out/')) pass('lifecycle · private/ + out/ git-ignored');
else fail('lifecycle · private/ + out/ git-ignored', 'both must be present in .gitignore');

/* Committed lifecycle fixtures — every one must be a synthetic example. */
const lifecycleFixtureFiles = fs.existsSync(LIFECYCLE_EXAMPLES) ? fs.readdirSync(LIFECYCLE_EXAMPLES).filter((f) => f.endsWith('.json')) : [];
if (lifecycleFixtureFiles.length >= 4) pass(`fixtures · found (${lifecycleFixtureFiles.length})`);
else fail('fixtures · found', `expected at least 4 in examples/lifecycle/, got ${lifecycleFixtureFiles.length}`);
for (const f of lifecycleFixtureFiles) {
  const data = readJson(path.join(LIFECYCLE_EXAMPLES, f));
  (data._example === true ? pass : fail)(`fixture · ${f} _example`);
}

/* Committed lifecycle proposal fixtures must themselves pass the shared PROP.1 core. */
const lifecycleProposalFixtures = ['proposal-draft.json', 'proposal-issued.json', 'proposal-issued-expired.json', 'proposal-accepted.json'];
for (const f of lifecycleProposalFixtures) {
  const data = readJson(path.join(LIFECYCLE_EXAMPLES, f));
  const res = validateProposal(data, { label: f, requireExampleMarker: true });
  if (res.failures.length === 0) pass(`fixture · ${f} is a valid Proposal`);
  else fail(`fixture · ${f} is a valid Proposal`, res.failures.join('; '));
}

/* ------------------------------------------------------------------ */
/* 2 · transition model (unit)                                         */
/* ------------------------------------------------------------------ */
const canonicalStatuses = Object.keys(TRANSITIONS).sort();
if (JSON.stringify(canonicalStatuses) === JSON.stringify([...STATUSES].sort())) pass('transitions · covers every canonical status');
else fail('transitions · covers every canonical status', Object.keys(TRANSITIONS).join(', '));

const required = [['DRAFT', 'SENT'], ['SENT', 'CLIENT_ACCEPTED'], ['SENT', 'DECLINED'], ['SENT', 'EXPIRED'], ['SENT', 'SUPERSEDED']];
let reqMissing = false;
for (const [from, to] of required) {
  if (!(TRANSITIONS[from] || []).includes(to)) { reqMissing = true; fail(`transitions · ${from} -> ${to}`); }
}
if (!reqMissing) pass('transitions · all required moves present (issue, accept, decline, expire, supersede)');

let selfOk = true;
for (const s of canonicalStatuses) if ((TRANSITIONS[s] || []).includes(s)) { selfOk = false; fail(`transitions · no self-loop ${s}`); }
if (selfOk) pass('transitions · no self-loops');

let terminalOk = true;
for (const s of TERMINAL) if ((TRANSITIONS[s] || []).length !== 0) { terminalOk = false; fail(`transitions · ${s} terminal`); }
if (terminalOk) pass(`transitions · terminal states immutable (${TERMINAL.join(', ')})`);

let nextKnown = true;
for (const s of canonicalStatuses) for (const n of (TRANSITIONS[s] || [])) if (!canonicalStatuses.includes(n)) { nextKnown = false; fail(`transitions · ${s} -> unknown ${n}`); }
if (nextKnown) pass('transitions · every next state is a canonical status');

/* ------------------------------------------------------------------ */
/* 3 · canonical fingerprint (unit)                                    */
/* ------------------------------------------------------------------ */
const fpBase = readJson(path.join(LIFECYCLE_EXAMPLES, 'proposal-issued.json'));
const fpA = proposalFingerprint(fpBase);
if (fpA === proposalFingerprint(JSON.parse(JSON.stringify(fpBase)))) pass('fingerprint · deterministic');
else fail('fingerprint · deterministic');

const ordered = { b: 1, a: { d: 2, c: 3 } };
const reordered = { a: { c: 3, d: 2 }, b: 1 };
if (canonicalProposal(ordered) === canonicalProposal(reordered) && proposalFingerprint(ordered) === proposalFingerprint(reordered)) {
  pass('fingerprint · key-order independent');
} else fail('fingerprint · key-order independent');

const withMarker = { ...fpBase, _example: true, _comment: 'note' };
if (proposalFingerprint(withMarker) === proposalFingerprint(fpBase)) pass('fingerprint · fixture markers excluded');
else fail('fingerprint · fixture markers excluded');

const changed = { ...fpBase, commercial_schedule: { ...fpBase.commercial_schedule, approved_final_project_price: 5200 } };
if (proposalFingerprint(changed) !== fpA) pass('fingerprint · commercial change changes hash');
else fail('fingerprint · commercial change changes hash');

const sent = { ...fpBase, status: 'CLIENT_ACCEPTED' };
if (proposalFingerprint(sent) !== fpA) pass('fingerprint · status change changes hash (accepted state captured)');
else fail('fingerprint · status change changes hash (accepted state captured)');

if (versionGt('2.0', '1.0') === true && versionGt('1.1', '1.0') === true && versionGt('1.0', '1.0') === false && versionGt('0.9', '1.0') === false) {
  pass('versions · superseding version must be higher');
} else fail('versions · superseding version must be higher');
if (isExpired({ valid_until: '2026-07-01' }, '2026-08-11') === true && isExpired({ valid_until: '2026-08-14' }, '2026-08-11') === false) {
  pass('expiry · deterministic (as-of > valid_until)');
} else fail('expiry · deterministic (as-of > valid_until)');

/* Committed accepted fixture ↔ record ↔ handoff fingerprint agreement. */
const committedAccepted = readJson(path.join(LIFECYCLE_EXAMPLES, 'proposal-accepted.json'));
const committedRecord = readJson(path.join(LIFECYCLE_EXAMPLES, 'proposal-accepted.acceptance.json'));
const committedHandoff = readJson(path.join(LIFECYCLE_EXAMPLES, 'proposal-accepted.handoff.json'));
const committedFp = proposalFingerprint(committedAccepted);
if (committedRecord.content_sha256 === committedFp && committedHandoff.acceptance.content_sha256 === committedFp) {
  pass('fixtures · accepted fingerprint matches record + handoff');
} else fail('fixtures · accepted fingerprint matches record + handoff', `record ${committedRecord.content_sha256}, handoff ${committedHandoff.acceptance.content_sha256}, computed ${committedFp}`);
if (committedRecord.schema === ACCEPTANCE_SCHEMA && committedHandoff.schema === HANDOFF_SCHEMA) pass('fixtures · acceptance + handoff schemas');
else fail('fixtures · acceptance + handoff schemas');
if (committedHandoff.status === 'READY_FOR_AGREEMENT' && committedHandoff.proposal.proposal_id === 'PRP-2026-9104') pass('fixtures · handoff references accepted proposal');
else fail('fixtures · handoff references accepted proposal');

/* ------------------------------------------------------------------ */
/* 4 · positive CLI flows                                              */
/* ------------------------------------------------------------------ */
fs.mkdirSync(PRIVATE_TMP, { recursive: true });

/* 4a · issue (DRAFT -> SENT) */
const tIssue = copyFixture('proposal-draft.json', 'pos-issue.json');
const rIssue = run(['issue', tIssue]);
if (rIssue.status === 0 && readJson(tIssue).status === 'SENT') pass('positive · issue DRAFT -> SENT');
else fail('positive · issue DRAFT -> SENT', `exit ${rIssue.status}\n${rIssue.stdout}`);

/* 4b · accept (SENT -> CLIENT_ACCEPTED) + fingerprint + record + verify + handoff */
const tAccept = copyFixture('proposal-issued.json', 'pos-accept.json');
const recAccept = tmpPath('pos-accept.acceptance.json');
const handoffOut = tmpPath('pos-accept.handoff.json');
const rAccept = run(['accept', tAccept, '--by', 'Alex Sample', '--method', 'written', '--date', '2026-08-11', '--record', recAccept]);
if (rAccept.status === 0) {
  const acc = readJson(tAccept);
  if (acc.status === 'CLIENT_ACCEPTED' && acc.acceptance.status === 'ACCEPTED' && acc.acceptance.accepted_by === 'Alex Sample' && acc.acceptance.accepted_at === '2026-08-11') {
    pass('positive · accept SENT -> CLIENT_ACCEPTED (metadata recorded)');
  } else fail('positive · accept SENT -> CLIENT_ACCEPTED (metadata recorded)', JSON.stringify(acc.acceptance));
} else fail('positive · accept SENT -> CLIENT_ACCEPTED', `exit ${rAccept.status}\n${rAccept.stdout}`);

if (fs.existsSync(recAccept)) {
  const rec = readJson(recAccept);
  if (rec.schema === ACCEPTANCE_SCHEMA && rec.proposal_id === 'PRP-2026-9102' && rec.accepted_by_name === 'Alex Sample' && rec.content_sha256 === proposalFingerprint(readJson(tAccept))) {
    pass('positive · acceptance record written with matching fingerprint');
  } else fail('positive · acceptance record written with matching fingerprint', JSON.stringify(rec));
} else fail('positive · acceptance record written with matching fingerprint', 'record missing');

const rVerify = run(['verify', tAccept, '--record', recAccept]);
if (rVerify.status === 0 && rVerify.stdout.includes('VERIFIED')) pass('positive · verify accepted fingerprint');
else fail('positive · verify accepted fingerprint', `exit ${rVerify.status}\n${rVerify.stdout}`);

const rHandoff = run(['handoff', tAccept, '--record', recAccept, '--output', handoffOut]);
if (rHandoff.status === 0 && fs.existsSync(handoffOut)) {
  const h = readJson(handoffOut);
  if (h.schema === HANDOFF_SCHEMA && h.status === 'READY_FOR_AGREEMENT' && h.proposal.proposal_id === 'PRP-2026-9102' &&
      h.acceptance.content_sha256 === readJson(recAccept).content_sha256 &&
      h.commercial_snapshot.approved_final_project_price === 5100 && h.commercial_snapshot.vat.status === 'UNDETERMINED') {
    pass('positive · Agreement handoff from accepted Proposal (commercial snapshot + fingerprint)');
  } else fail('positive · Agreement handoff from accepted Proposal', JSON.stringify(h).slice(0, 200));
} else fail('positive · Agreement handoff from accepted Proposal', `exit ${rHandoff.status}\n${rHandoff.stdout}`);

/* 4c · decline (SENT -> DECLINED) */
const tDecline = copyFixture('proposal-issued.json', 'pos-decline.json');
const rDecline = run(['decline', tDecline]);
if (rDecline.status === 0 && readJson(tDecline).status === 'DECLINED') pass('positive · decline SENT -> DECLINED');
else fail('positive · decline SENT -> DECLINED', `exit ${rDecline.status}\n${rDecline.stdout}`);

/* 4d · expire (SENT -> EXPIRED), deterministic */
const tExpire = copyFixture('proposal-issued-expired.json', 'pos-expire.json');
const rExpire = run(['expire', tExpire, '--as-of', '2026-08-11']);
if (rExpire.status === 0 && readJson(tExpire).status === 'EXPIRED') pass('positive · expire past-validity -> EXPIRED');
else fail('positive · expire past-validity -> EXPIRED', `exit ${rExpire.status}\n${rExpire.stdout}`);

/* 4e · supersede (SENT -> SUPERSEDED, higher version required) */
const tSupersede = copyFixture('proposal-issued.json', 'pos-supersede.json');
const rSupersede = run(['supersede', tSupersede, '--by', 'PRP-2026-9199', '--version', '2.0', '--reason', 'revised scope']);
if (rSupersede.status === 0) {
  const s = readJson(tSupersede);
  if (s.status === 'SUPERSEDED' && s.superseded_by.proposal_id === 'PRP-2026-9199' && s.superseded_by.version === '2.0' && s.superseded_by.reason === 'revised scope') {
    pass('positive · supersede SENT -> SUPERSEDED (superseded_by recorded)');
  } else fail('positive · supersede SENT -> SUPERSEDED (superseded_by recorded)', JSON.stringify(s.superseded_by));
} else fail('positive · supersede SENT -> SUPERSEDED', `exit ${rSupersede.status}\n${rSupersede.stdout}`);

/* 4f · verify + handoff on the committed accepted pair */
const committedRecordPath = path.join(LIFECYCLE_EXAMPLES, 'proposal-accepted.acceptance.json');
const rVerifyC = run(['verify', path.join(LIFECYCLE_EXAMPLES, 'proposal-accepted.json'), '--record', committedRecordPath]);
if (rVerifyC.status === 0 && rVerifyC.stdout.includes('VERIFIED')) pass('positive · committed accepted fixture verifies');
else fail('positive · committed accepted fixture verifies', `exit ${rVerifyC.status}\n${rVerifyC.stdout}`);

const committedHandoffOut = tmpPath('pos-committed.handoff.json');
const rHandoffC = run(['handoff', path.join(LIFECYCLE_EXAMPLES, 'proposal-accepted.json'), '--record', committedRecordPath, '--output', committedHandoffOut]);
if (rHandoffC.status === 0) {
  const h = readJson(committedHandoffOut);
  if (h.proposal.proposal_id === 'PRP-2026-9104' && h.acceptance.content_sha256 === committedFp && h.commercial_snapshot.approved_final_project_price === 5100) {
    pass('positive · handoff from committed accepted pair');
  } else fail('positive · handoff from committed accepted pair', JSON.stringify(h).slice(0, 200));
} else fail('positive · handoff from committed accepted pair', `exit ${rHandoffC.status}\n${rHandoffC.stdout}`);

/* ------------------------------------------------------------------ */
/* 5 · negative tests — must FAIL CLOSED                               */
/* ------------------------------------------------------------------ */
const negatives = [];
const expectRefused = (label, res, detail) => {
  if (res.status !== 0) pass(`negative · ${label}`);
  else fail(`negative · ${label}`, detail || 'operation unexpectedly succeeded');
};

/* 5a · accept DRAFT directly */
const n1 = copyFixture('proposal-draft.json', 'neg-accept-draft.json');
expectRefused('accept DRAFT directly', run(['accept', n1, '--by', 'Alex Sample']));

/* 5b · accept expired Proposal */
const n2 = copyFixture('proposal-issued-expired.json', 'neg-accept-expired.json');
expectRefused('accept expired Proposal', run(['accept', n2, '--by', 'Alex Sample', '--date', '2026-08-11']));

/* 5c · accept already declined Proposal */
const n3 = copyFixture('proposal-issued.json', 'neg-accept-declined.json');
run(['decline', n3]);
expectRefused('accept already declined Proposal', run(['accept', n3, '--by', 'Alex Sample']));

/* 5d · backwards transitions */
const n4 = copyFixture('proposal-accepted.json', 'neg-backwards.json');
expectRefused('backwards transition (issue accepted)', run(['issue', n4]));
const n4b = copyFixture('proposal-issued.json', 'neg-backwards2.json');
run(['decline', n4b]);
expectRefused('backwards transition (expire declined)', run(['expire', n4b, '--as-of', '2026-08-11']));

/* 5e · mutate accepted commercial data -> fingerprint mismatch */
const n5 = copyFixture('proposal-accepted.json', 'neg-tamper.json');
const n5rec = tmpPath('neg-tamper.acceptance.json');
fs.copyFileSync(committedRecordPath, n5rec);
const n5data = readJson(n5);
n5data.commercial_schedule.approved_final_project_price = 5200;
writeJson(n5, n5data);
expectRefused('mutate accepted commercial data (verify)', run(['verify', n5, '--record', n5rec]), 'fingerprint must catch the edit');
expectRefused('mutate accepted commercial data (handoff)', run(['handoff', n5, '--record', n5rec, '--output', tmpPath('neg-tamper.handoff.json')]), 'handoff must refuse tampered content');

/* 5f · overwrite accepted version (re-accept) + record overwrite protection */
const n6 = copyFixture('proposal-issued.json', 'neg-overwrite.json');
const n6rec = tmpPath('neg-overwrite.acceptance.json');
run(['accept', n6, '--by', 'Alex Sample', '--date', '2026-08-11', '--record', n6rec]);
expectRefused('overwrite accepted version (re-accept)', run(['accept', n6, '--by', 'Alex Sample', '--date', '2026-08-11', '--record', n6rec]));

const n6b = copyFixture('proposal-accepted.json', 'neg-overwrite-handoff.json');
const n6brec = tmpPath('neg-overwrite-handoff.acceptance.json');
fs.copyFileSync(committedRecordPath, n6brec);
run(['handoff', n6b, '--record', n6brec, '--output', tmpPath('neg-overwrite-handoff.handoff.json')]);
expectRefused('overwrite existing handoff without --overwrite', run(['handoff', n6b, '--record', n6brec, '--output', tmpPath('neg-overwrite-handoff.handoff.json')]));

/* 5g · Agreement handoff from DRAFT / ISSUED / DECLINED */
const n7 = copyFixture('proposal-draft.json', 'neg-handoff-draft.json');
expectRefused('Agreement handoff from DRAFT', run(['handoff', n7]));
const n8 = copyFixture('proposal-issued.json', 'neg-handoff-issued.json');
expectRefused('Agreement handoff from ISSUED', run(['handoff', n8]));
const n9 = copyFixture('proposal-issued.json', 'neg-handoff-declined.json');
run(['decline', n9]);
expectRefused('Agreement handoff from DECLINED', run(['handoff', n9]));

/* 5h · invalid version / supersession */
const n10 = copyFixture('proposal-issued.json', 'neg-sup-same.json');
expectRefused('supersede with same version', run(['supersede', n10, '--by', 'PRP-2026-9199', '--version', '1.0']));
const n10b = copyFixture('proposal-draft.json', 'neg-sup-draft.json');
expectRefused('supersede a DRAFT', run(['supersede', n10b, '--by', 'PRP-2026-9199', '--version', '2.0']));
const n10c = copyFixture('proposal-issued.json', 'neg-sup-bad.json');
expectRefused('supersede with malformed proposal_id', run(['supersede', n10c, '--by', 'not-an-id', '--version', '2.0']));
const n10d = copyFixture('proposal-issued.json', 'neg-sup-missing.json');
expectRefused('supersede without --version', run(['supersede', n10d, '--by', 'PRP-2026-9199']));

/* 5i · SUPERSEDED status without a superseded_by reference is incoherent */
const n11 = copyFixture('proposal-draft.json', 'neg-sup-no-ref.json');
const n11d = readJson(n11);
n11d.status = 'SUPERSEDED';
writeJson(n11, n11d);
expectRefused('SUPERSEDED without superseded_by', run(['issue', n11]));

/* 5j · legacy Starter / £250 / VAT / commercial drift (shared core blocks lifecycle) */
const baseDraft = readJson(path.join(LIFECYCLE_EXAMPLES, 'proposal-draft.json'));
const mkInvalid = (name, mutate) => {
  const data = JSON.parse(JSON.stringify(baseDraft));
  mutate(data);
  const p = tmpPath(name);
  writeJson(p, data);
  return p;
};
expectRefused('legacy Starter tier', run(['issue', mkInvalid('neg-starter.json', (d) => { d.assumptions = [...(d.assumptions || []), 'Legacy Starter package option']; })]));
expectRefused('legacy £250 deposit language', run(['issue', mkInvalid('neg-250.json', (d) => { d.assumptions = [...(d.assumptions || []), 'Pay a 250 deposit to secure the project']; })]));
expectRefused('unsupported VAT assertion', run(['issue', mkInvalid('neg-vat.json', (d) => { d.commercial_schedule.vat = { status: 'INCLUDED', note: 'VAT included' }; })]));
expectRefused('commercial Source-of-Truth drift', run(['issue', mkInvalid('neg-drift.json', (d) => { d.commercial_schedule.reference_price = { from: 9999 }; })]));

/* 5k · verify with a record for a different proposal */
const n12 = copyFixture('proposal-issued.json', 'neg-wrong-record.json');
expectRefused('verify with wrong-proposal record', run(['verify', n12, '--record', committedRecordPath]));

/* 5l · unsafe / tracked input path is refused */
expectRefused('unsafe input path refused', run(['verify', path.join(proposalsDir, 'package-mapping.json')]));

/* ------------------------------------------------------------------ */
/* 6 · privacy                                                         */
/* ------------------------------------------------------------------ */
const allStrings = [];
const collect = (v) => {
  if (typeof v === 'string') { allStrings.push(v); return; }
  if (Array.isArray(v)) { for (const x of v) collect(x); return; }
  if (v !== null && typeof v === 'object') for (const k of Object.keys(v)) collect(v[k]);
};
for (const f of lifecycleFixtureFiles) collect(readJson(path.join(LIFECYCLE_EXAMPLES, f)));
const emails = [...new Set(allStrings.map((s) => (s.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [])).flat())];
if (emails.length === 0) pass('privacy · no emails in lifecycle fixtures');
else if (emails.every((e) => e.endsWith('@example.com'))) pass(`privacy · only synthetic @example.com contacts (${emails.join(', ')})`);
else fail('privacy · only synthetic @example.com contacts', emails.join(', '));

for (const dir of ['private/acceptance', 'private/handoffs']) {
  const rel = path.join('ops/proposals', dir);
  if (gitignore.includes('ops/proposals/private/')) pass(`privacy · ${rel} git-ignored (under private/)`);
  else fail(`privacy · ${rel} git-ignored`);
}

/* ------------------------------------------------------------------ */
/* 7 · cleanup (gitignored tmp dirs only)                              */
/* ------------------------------------------------------------------ */
fs.rmSync(PRIVATE_TMP, { recursive: true, force: true });
/* Also remove the shared gitignored parent if this run created it (generator
   validator reuses the same private/.tmp-tests/ location and cleans it too). */
fs.rmSync(path.join(proposalsDir, 'private', '.tmp-tests'), { recursive: true, force: true });

console.log(failures.length === 0 ? '\nALL LIFECYCLE CHECKS PASSED' : `\n${failures.length} LIFECYCLE CHECK(S) FAILED`);
process.exit(failures.length === 0 ? 0 : 1);
