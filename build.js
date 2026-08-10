#!/usr/bin/env node
/**
 * build.js — zero-dependency static page generator (A4).
 *
 * Reads src/templates/page.html, substitutes partial slots from src/partials and
 * src/templates, then substitutes {{token}} content tokens from
 * src/content/<lang>.json. Emits dist/index.html (English) or dist/<lang>/index.html.
 *
 * Safety guarantees:
 *   - writes ONLY under dist/ (validated as a strict child of the repo root)
 *   - hard-blocked from ever writing repo-root index.html
 *   - fails on any unresolved {{token}} or missing translation key
 *   - UTF-8, byte-faithful: partial content is inserted verbatim (single trailing
 *     newline stripped so surrounding layout controls line breaks).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname);
const DIST = path.join(ROOT, 'dist');
const PAGE = path.join(ROOT, 'src', 'templates', 'page.html');
const PARTIAL_DIR = path.join(ROOT, 'src', 'partials');
const TEMPLATE_DIR = path.join(ROOT, 'src', 'templates');
const CONTENT_DIR = path.join(ROOT, 'src', 'content');

const LANG = (process.argv[2] || 'en').toLowerCase();
const OUTPUT = LANG === 'en'
  ? path.join(DIST, 'index.html')
  : path.join(DIST, LANG, 'index.html');

/* ---------------- guards ---------------- */
function fail(msg) {
  console.error('[build.js] ERROR: ' + msg);
  process.exit(1);
}

if (DIST === ROOT) fail('refusing to build into the repo root');
if (!DIST.startsWith(ROOT + path.sep)) fail('dist is not a child of the repo root');

if (OUTPUT === DIST || !OUTPUT.startsWith(DIST + path.sep)) {
  fail('output path escapes dist/: ' + OUTPUT);
}
if (OUTPUT === path.join(ROOT, 'index.html')) {
  fail('refusing to overwrite the live homepage at repo root');
}

const read = p => fs.readFileSync(p, 'utf8');

/* ---------------- dictionary ---------------- */
const dictPath = path.join(CONTENT_DIR, LANG + '.json');
if (!fs.existsSync(dictPath)) fail('missing content dictionary: ' + dictPath);

let dict;
try {
  dict = JSON.parse(read(dictPath));
} catch (e) {
  fail('cannot parse ' + dictPath + ': ' + e.message);
}

const flat = {};
(function flatten(obj, prefix) {
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    const p = prefix ? prefix + '.' + k : k;
    if (typeof v === 'string') flat[p] = v;
    else if (v && typeof v === 'object') flatten(v, p);
    else fail('unexpected dictionary value at "' + p + '"');
  }
})(dict, '');

/* ---------------- language registry ---------------- */
// Central registry for every language the build can emit. The order of
// LANGUAGE_ORDER is the order languages appear in the switcher menu; only
// entries present here (and in src/content/<code>.json) are active. Future
// languages (fr, ar, fa…) extend this list — Persian must stay last.
const LANGUAGES = {
  en: {
    code: 'en',
    label: 'English',
    lang: 'en',
    hreflang: 'en',
    url: '/',
    canonical: 'https://nexorastudio.uk/',
    og_locale: 'en_GB',
  },
  de: {
    code: 'de',
    label: 'Deutsch',
    lang: 'de',
    hreflang: 'de',
    url: '/de/',
    canonical: 'https://nexorastudio.uk/de/',
    og_locale: 'de_DE',
  },
};

// Menu order for the language switcher. English and German are the only
// active languages this phase. Do not add inactive fake entries.
const LANGUAGE_ORDER = ['en', 'de'];

/* ---------------- localized document metadata (non-English only) ---------------- */
// English builds keep the template's document metadata verbatim (lang="en",
// root canonical), so the English output stays byte-identical to the verified
// baseline. Non-English builds apply the language's document settings as a
// final pass after content substitution. Only these settings are localized —
// asset URLs, analytics IDs and all other configuration stay untouched.
function localizeDocument(html) {
  const doc = LANGUAGES[LANG];
  if (!doc) fail('no document settings defined for language "' + LANG + '"');
  const root = LANGUAGES.en.canonical;
  const swaps = [
    ['<html lang="en">', '<html lang="' + doc.lang + '">'],
    ['<link rel="canonical" href="' + root + '">', '<link rel="canonical" href="' + doc.canonical + '">'],
    ['<meta property="og:url" content="' + root + '">', '<meta property="og:url" content="' + doc.canonical + '">'],
    ['<meta property="og:locale" content="en_GB">', '<meta property="og:locale" content="' + doc.og_locale + '">'],
    ['"url": "' + root + '"', '"url": "' + doc.canonical + '"'], // JSON-LD url
  ];
  for (const [from, to] of swaps) {
    if (!html.includes(from)) fail('localized document pass could not find: ' + from);
    html = html.split(from).join(to);
  }
  return html;
}

/* ---------------- language switcher + hreflang generation ---------------- */
// Both are injected after content substitution via [[...]] markers placed in
// the partials. The switcher shows only ACTIVE languages (LANGUAGE_ORDER); the
// active language is rendered as a non-link element with aria-current="page"
// (best practice: never link a page to itself). Hreflang alternates list the
// same active set plus x-default, which resolves to the English homepage.
function langItem(entry, isActive) {
  const cls = 'lang-switcher-item ' + (isActive ? 'lang-switcher-active' : 'lang-switcher-link');
  const langAttr = 'lang="' + entry.lang + '"';
  if (isActive) {
    return '<span class="' + cls + '" aria-current="page" ' + langAttr + '>' + entry.label + '</span>';
  }
  return '<a class="' + cls + '" href="' + entry.url + '" hreflang="' + entry.hreflang + '" ' + langAttr + '>' + entry.label + '</a>';
}

function renderSwitcher(current) {
  const label = flat['a11y.language_selector'] || 'Language';
  const sep = '<span class="lang-switcher-sep" aria-hidden="true">/</span>';
  const items = LANGUAGE_ORDER.map(code => {
    const entry = LANGUAGES[code];
    if (!entry) fail('missing language registry entry: ' + code);
    return langItem(entry, code === current);
  });
  return '<div class="lang-switcher" role="group" aria-label="' + label + '">'
    + items.join(sep)
    + '</div>';
}

function renderHreflang() {
  const links = LANGUAGE_ORDER.map(code => {
    const entry = LANGUAGES[code];
    if (!entry) fail('missing language registry entry: ' + code);
    return '<link rel="alternate" hreflang="' + entry.hreflang + '" href="' + entry.canonical + '">';
  });
  links.push('<link rel="alternate" hreflang="x-default" href="' + LANGUAGES.en.canonical + '">');
  return links.join('\n');
}

/* ---------------- assemble ---------------- */
if (!fs.existsSync(PAGE)) fail('missing page template: ' + PAGE);
let html = read(PAGE);

// pass 1: substitute partial slots (partials dir, then templates dir).
// Full replacement passes so a content token inside an early partial never
// blocks later slots; loops until a pass makes no change.
{
  let out = html;
  let changed = true;
  while (changed) {
    changed = false;
    out = out.replace(/\{\{([^{}]+)\}\}/g, (all, name) => {
      for (const dir of [PARTIAL_DIR, TEMPLATE_DIR]) {
        const f = path.join(dir, name + '.html');
        if (f !== PAGE && fs.existsSync(f)) {
          changed = true;
          return read(f).replace(/\n$/, ''); // single trailing newline
        }
      }
      return all; // content token — leave for pass 2
    });
  }
  html = out;
}

// pass 2: substitute translation tokens
const unresolved = [];
html = html.replace(/\{\{([^{}]+)\}\}/g, (all, name) => {
  if (Object.prototype.hasOwnProperty.call(flat, name)) return flat[name];
  unresolved.push(name);
  return all;
});

// fail on any missing/unresolved token
if (unresolved.length) {
  fail('unresolved token(s): ' + [...new Set(unresolved)].map(t => '{{' + t + '}}').join(', '));
}
const leftovers = html.match(/\{\{[^{}]+\}\}/g);
if (leftovers) fail('unresolved token(s): ' + [...new Set(leftovers)].join(', '));

// pass 3: apply language-level document metadata (lang attr, canonical, og:locale, JSON-LD url)
if (LANG !== 'en') html = localizeDocument(html);

// pass 4: inject generated build output (language switcher, hreflang alternates).
// Markers use [[...]] so neither pass 1 ({{...}} partials) nor pass 2
// (content tokens) touch them.
html = html.split('[[hreflang-alternates]]').join(renderHreflang());
html = html.split('[[lang-switcher]]').join(renderSwitcher(LANG));
const leftoverMarkers = html.match(/\[\[[^\]\[]+\]\]/g);
if (leftoverMarkers) {
  fail('unresolved build marker(s): ' + [...new Set(leftoverMarkers)].join(', '));
}

/* ---------------- write ---------------- */
fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
fs.writeFileSync(OUTPUT, html, 'utf8');

console.log('[build.js] OK  ' + LANG + ' -> ' + path.relative(ROOT, OUTPUT));
console.log('[build.js]     ' + Object.keys(flat).length + ' translation keys, output '
  + Buffer.byteLength(html, 'utf8') + ' bytes');
