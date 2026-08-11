#!/usr/bin/env node
/* Nexora Document Output System — shared PROP.6 core.
   The governed document-output layer turns governed Proposal (PROP.1–PROP.4) and
   Agreement (PROP.5) documents into polished, deterministic, client-ready final
   outputs: self-contained HTML, optional PDF (headless Chrome print-to-PDF),
   a machine-readable manifest and SHA-256 checksums.

   This module is PRESENTATION / OUTPUT only. It performs no pricing, no legal
   decision-making, no acceptance, no execution, no e-signature, no invoicing and
   no payment. It never writes back to any input. It never calls process.exit —
   CLI tools decide how to print/exit.

   PDF engine: prefers an existing local headless browser (Chrome/Chromium).
   If none is found, HTML remains authoritative and the manual workflow is:
   browser Print -> Save as PDF. A PDF checksum is an integrity aid, NOT a
   digital signature. Checksum ≠ signature. Final document output ≠ e-signature.
   Agreement READY_FOR_EXECUTION ≠ SIGNED.

   Node built-ins only (node:fs/path/url/crypto/zlib/child_process). */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DOC_OUTPUT_VERSION = '1.0';
export const MANIFEST_SCHEMA = 'nexora-document-manifest/v1';
export const OUTPUT_SYSTEM = 'nexora-document-output/v1';
export const root = path.join(__dirname, '..', '..');

export const PROPOSAL_OUT_DIR = path.join(__dirname, 'out', 'proposals');
export const AGREEMENT_OUT_DIR = path.join(__dirname, 'out', 'agreements');

/* ------------------------------------------------------------------ */
/* Checksums (node:crypto). A checksum proves byte integrity — it is  */
/* NOT a digital signature and provides no signer authenticity.       */
/* ------------------------------------------------------------------ */
export function sha256hex(input) {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return createHash('sha256').update(buf).digest('hex');
}

/* ------------------------------------------------------------------ */
/* Deterministic, sanitised filenames. Derived ONLY from governed     */
/* document metadata (IDs, version, status). No client names.         */
/* ------------------------------------------------------------------ */
function cleanSegment(s) {
  const clean = String(s)
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return clean || 'document';
}

const SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ID_RE = {
  proposal: /^PRP-\d{4}-\d{4}$/,
  agreement: /^AGR-\d{4}-\d{4}$/
};

export function safeProposalFilename(proposalId, version, ext = 'html') {
  const id = cleanSegment(proposalId);
  const ver = cleanSegment(version);
  return `${id}-v${ver}.${ext}`;
}

export function safeAgreementFilename(agreementId, version, status, ext = 'html') {
  const id = cleanSegment(agreementId);
  const ver = cleanSegment(version);
  const st = cleanSegment(String(status || 'DRAFT').toUpperCase());
  return `${id}-v${ver}-${st}.${ext}`;
}

export function validateDerivedName(name) {
  if (typeof name !== 'string' || !SAFE_NAME_RE.test(name)) {
    return `unsafe filename "${name}" — only [A-Za-z0-9._-] allowed, no slashes, dots or control characters`;
  }
  if (name.includes('..')) return `unsafe filename "${name}" — no path segments`;
  if (name.startsWith('.')) return `unsafe filename "${name}" — must not start with a dot`;
  return null;
}

export function defaultOutputDir(docType) {
  return docType === 'agreement' ? AGREEMENT_OUT_DIR : PROPOSAL_OUT_DIR;
}

/* Output must stay within the repository root. */
export function assertSafeOutputDir(dir) {
  const resolved = path.resolve(dir);
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return `Unsafe output directory: ${dir} — output must stay within the repository root.`;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Legacy / VAT / token / path-leakage scanners (output-layer QA).     */
/* These are the frozen obsolete-commercial vocabulary. A final        */
/* document that leaks any of these is defective and must not archive. */
/* ------------------------------------------------------------------ */
const LEGACY_PATTERNS = [
  /£250/, /£250\s+secures?/i, /\b250\s+deposit\b/i, /\bpay\s+£250\b/i,
  /buy\.stripe\.com/i, /paypal\.com/i, /\bStarter\b/, /\bElite\b/, /\bAI\s+Care\b/i
];
const VAT_ASSERTIONS = [
  /\bVAT\s+registered\b/i, /\bregistered\s+for\s+VAT\b/i,
  /\b20\s*%\s*VAT\b/i, /\bVAT\s+at\s+\d+\s*%/i,
  /\bVAT\s+included\b/i, /\bVAT\s+excluded\b/i, /\bVAT\s+inclusive\b/i, /\bVAT\s+exclusive\b/i, /\btax\s+amount\b/i
];

export function scanLegacy(text) {
  const violations = [];
  for (const re of LEGACY_PATTERNS) if (re.test(text)) violations.push(`legacy: ${re}`);
  return violations;
}

export function scanVatAssertions(text) {
  const violations = [];
  for (const re of VAT_ASSERTIONS) if (re.test(text)) violations.push(`VAT assertion: ${re}`);
  return violations;
}

export function scanTokens(text) {
  const matches = (String(text).match(/\{\{[\s\S]*?\}\}/g) || []);
  return [...new Set(matches)];
}

/* Absolute private-machine paths and file:// URLs must never leak into
   client-facing HTML or manifests. */
export function scanPathLeakage(text) {
  const violations = [];
  if (/file:\/\/\//i.test(text)) violations.push('file:// URL present');
  if (/\/Users\/[^/]+\//.test(text)) violations.push('absolute user path present');
  if (new RegExp(path.sep === '/' ? '\\/' : '\\\\').test(text)) {
    /* Windows drive letters */
  }
  if (/\b([A-Za-z]:[\\/])/.test(text)) violations.push('drive-letter absolute path present');
  if (text.includes(root)) violations.push('absolute repository path present');
  return violations;
}

/* ------------------------------------------------------------------ */
/* PDF engine — local headless Chrome/Chromium print-to-PDF.           */
/* ------------------------------------------------------------------ */
export const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/opt/homebrew/bin/chromium',
  '/usr/local/bin/chromium'
];

export function findChrome() {
  if (process.env.NEXORA_CHROME_BIN && fs.existsSync(process.env.NEXORA_CHROME_BIN)) {
    return process.env.NEXORA_CHROME_BIN;
  }
  for (const c of CHROME_CANDIDATES) if (fs.existsSync(c)) return c;
  return null;
}

export function pdfAvailable() {
  const chromePath = findChrome();
  return chromePath ? { available: true, chromePath } : { available: false, chromePath: null };
}

export function htmlToPdf(htmlPath, pdfPath, opts = {}) {
  const chromePath = opts.chromePath || findChrome();
  if (!chromePath) {
    return { ok: false, reason: 'AUTOMATED PDF: NOT AVAILABLE — SAFE HTML/PRINT WORKFLOW ONLY', code: 'NO_BROWSER' };
  }
  const timeoutMs = opts.timeoutMs || 60000;
  const args = [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    '--no-pdf-header-footer', '--run-all-compositor-stages-before-draw',
    '--virtual-time-budget=3000',
    `--print-to-pdf=${pdfPath}`,
    pathToFileURL(htmlPath).href
  ];
  return new Promise((resolve) => {
    const child = spawn(chromePath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ ok: false, reason: 'PDF generation timed out', code: 'TIMEOUT' }); }, timeoutMs);
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, reason: err.message, code: 'SPAWN' }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      let pdfOk = false;
      try { pdfOk = fs.existsSync(pdfPath) && fs.readFileSync(pdfPath).slice(0, 5).toString() === '%PDF-'; } catch (e) { pdfOk = false; }
      if (code === 0 && pdfOk) resolve({ ok: true });
      else resolve({ ok: false, reason: `Chrome exited ${code} (pdf=${pdfOk})`, code: 'RENDER', stderr });
    });
  });
}

/* ------------------------------------------------------------------ */
/* PDF inspection — page count + readable text extraction.             */
/* Pure Node: parses PDF objects, inflates FlateDecode streams and     */
/* decodes glyphs through each font's ToUnicode CMap. Works on         */
/* Chrome/Chromium-generated PDFs without any external library.        */
/* ------------------------------------------------------------------ */
function parsePdfObjects(buf) {
  const s = buf.toString('latin1');
  const re = /(\d+)\s+0\s+obj\n?([\s\S]*?)(?=\nendobj\n)/g;
  const out = new Map();
  let m;
  while ((m = re.exec(s)) !== null) out.set(Number(m[1]), m[2]);
  return out;
}

function pdfStreamOf(objText) {
  const mm = objText.match(/stream\r?\n([\s\S]*?)endstream/);
  if (!mm) return null;
  return Buffer.from(mm[1].replace(/\r?\n$/, ''), 'latin1');
}

function pdfInflate(b) {
  try { return zlib.inflateSync(b).toString('latin1'); } catch (e) { return null; }
}

function pdfHexToUtf8(h) {
  if (!h) return '';
  const groups = String(h).trim().split(/\s+/).filter(Boolean);
  if (groups.length > 0 && groups.every((g) => g.length === 4)) {
    let out = '';
    for (const g of groups) {
      const v = parseInt(g, 16);
      if (Number.isFinite(v) && v >= 0 && v <= 0x10FFFF) {
        try { out += String.fromCodePoint(v); } catch (e) { /* skip invalid */ }
      }
    }
    return out;
  }
  const v = parseInt(h, 16);
  if (Number.isFinite(v) && v >= 0 && v <= 0x10FFFF) {
    try { return String.fromCodePoint(v); } catch (e) { return ''; }
  }
  return '';
}

function pdfParseCMap(text) {
  const map = new Map();
  for (const c of text.matchAll(/(\d+)\s+beginbfchar\s*\n?([\s\S]*?)endbfchar/g)) {
    for (const line of c[2].split('\n')) {
      const m = line.match(/^\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f\s]+)>\s*$/);
      if (m) map.set(parseInt(m[1], 16), pdfHexToUtf8(m[2]));
    }
  }
  for (const r of text.matchAll(/(\d+)\s+beginbfrange\s*\n?([\s\S]*?)endbfrange/g)) {
    for (const line of r[2].split('\n')) {
      const arr = line.match(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/);
      if (arr) {
        const lo = parseInt(arr[1], 16), hi = parseInt(arr[2], 16), start = parseInt(arr[3], 16);
        for (let c = lo; c <= hi; c++) {
          const cp = start + (c - lo);
          if (cp >= 0 && cp <= 0x10FFFF) { try { map.set(c, String.fromCodePoint(cp)); } catch (e) { /* skip */ } }
        }
      } else {
        const arr2 = line.match(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/);
        if (arr2) {
          const lo = parseInt(arr2[1], 16);
          const dsts = [...arr2[3].matchAll(/<([0-9A-Fa-f]*)>/g)].map((x) => pdfHexToUtf8(x[1]));
          dsts.forEach((d, k) => map.set(lo + k, d));
        }
      }
    }
  }
  return map;
}

function pdfDecodeString(hexStr, map) {
  const bytes = String(hexStr).match(/.{2}/g).map((b) => parseInt(b, 16));
  let out = '';
  for (let i = 0; i < bytes.length; ) {
    const two = i + 1 < bytes.length ? (bytes[i] << 8) | bytes[i + 1] : -1;
    if (two !== -1 && map.has(two)) { out += map.get(two); i += 2; }
    else if (map.has(bytes[i])) { out += map.get(bytes[i]); i += 1; }
    else { i += 1; }
  }
  return out;
}

export function pdfPageCount(buf) {
  const s = buf.toString('latin1');
  const m = s.match(/\/Type\s*\/Pages\b[\s\S]*?\/Count\s+(\d+)/);
  if (m) return Number(m[1]);
  const m2 = s.match(/\/Count\s+(\d+)/);
  return m2 ? Number(m2[1]) : null;
}

export function extractPdfText(buf) {
  const s = buf.toString('latin1');
  const objs = parsePdfObjects(buf);
  const pages = [];
  for (const [num, text] of objs) {
    if (/\/Type\s*\/Page(?![s])/.test(text)) pages.push(text);
  }
  const fontsByPage = pages.map((pg) => {
    const m = pg.match(/\/Resources\s*<<[\s\S]*?\/Font\s*<<([\s\S]*?)>>/);
    const dict = m ? m[1] : '';
    const fmap = new Map();
    for (const ref of dict.matchAll(/\/([A-Za-z0-9]+)\s+(\d+)\s+0\s+R/g)) fmap.set(ref[1], Number(ref[2]));
    return fmap;
  });
  const toU = new Map();
  for (const [num, text] of objs) {
    const m = text.match(/\/ToUnicode\s+(\d+)\s+0\s+R/);
    if (m) toU.set(num, Number(m[1]));
  }
  const cmaps = new Map();
  for (const [fontNum, toNum] of toU) {
    const raw = objs.get(toNum);
    if (!raw) continue;
    const stream = pdfStreamOf(raw);
    const text = stream ? pdfInflate(stream) : null;
    if (text) cmaps.set(fontNum, pdfParseCMap(text));
  }
  const contentNums = (pgText) => {
    const arr = pgText.match(/\/Contents\s+\[([\s\S]*?)\]/);
    if (arr) return [...arr[1].matchAll(/(\d+)\s+0\s+R/g)].map((x) => Number(x[1]));
    const single = pgText.match(/\/Contents\s+(\d+)\s+0\s+R/);
    return single ? [Number(single[1])] : [];
  };
  const out = [];
  pages.forEach((pg, pi) => {
    const fmap = fontsByPage[pi] || new Map();
    for (const cnum of contentNums(pg)) {
      const raw = objs.get(cnum);
      if (!raw) continue;
      const stream = pdfStreamOf(raw);
      const content = stream ? pdfInflate(stream) : null;
      if (!content) continue;
      const tokens = content.split(/\s+/);
      let font = null;
      for (let t = 0; t < tokens.length; t++) {
        const tok = tokens[t];
        if (/^\/[A-Za-z0-9]+$/.test(tok) && tokens[t + 2] === 'Tf') { font = tok.slice(1); t += 2; continue; }
        if (tok.startsWith('<') && tok.endsWith('>')) {
          const cm = font && cmaps.get(fmap.get(font));
          if (cm) out.push(pdfDecodeString(tok.slice(1, -1), cm));
        } else if (tok.startsWith('[')) {
          let arrStr = tok.slice(1);
          let k = t;
          while (!arrStr.includes(']') && k < tokens.length - 1) arrStr += tokens[++k];
          const hexes = [...arrStr.matchAll(/<([0-9A-Fa-f]+)>/g)].map((x) => x[1]);
          const cm = font && cmaps.get(fmap.get(font));
          if (cm) for (const hx of hexes) out.push(pdfDecodeString(hx, cm));
        }
      }
    }
  });
  return out.join('');
}

/* Whitespace- and case-insensitive match for PDF glyph runs (letter-spaced
   text, kerning gaps, Title Case rendering). Strips whitespace and lowercases
   BOTH sides before comparing. */
export function pdfTextContains(pdfText, needle) {
  const norm = (t) => String(t).replace(/\s+/g, '').toLowerCase();
  return norm(pdfText).includes(norm(needle));
}

/* ------------------------------------------------------------------ */
/* Manifest. Non-sensitive, machine-readable per-document metadata.   */
/* ------------------------------------------------------------------ */
export function buildManifest({ docType, documentId, version, status, generatedAt, sourceProposalId, sourceAgreementId, htmlFilename, htmlChecksum, pdfFilename, pdfChecksum, generatorSchema }) {
  const m = {
    schema: MANIFEST_SCHEMA,
    document_type: docType,
    document_id: documentId,
    version,
    status,
    generated_at: generatedAt,
    source_proposal_id: sourceProposalId || null,
    source_agreement_id: sourceAgreementId || null,
    html_filename: htmlFilename,
    html_checksum_sha256: htmlChecksum,
    generator_schema: generatorSchema,
    output_system: OUTPUT_SYSTEM,
    checksum_note: 'SHA-256 checksums are integrity aids only. A checksum is NOT a digital signature, and a PDF checksum is NOT an e-signature.'
  };
  if (pdfFilename) {
    m.pdf_filename = pdfFilename;
    m.pdf_checksum_sha256 = pdfChecksum || null;
  }
  return m;
}
