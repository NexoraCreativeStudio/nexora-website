#!/usr/bin/env node
/* Nexora Proposal — safe template preview mechanism (PROP.2).
   Binds a validated Proposal fixture (PROP.1 schema) to the reusable template
   (template/proposal-template.html + proposal.css) for visual QA only.

   This is NOT the PROP.3 generator. It implements only the data-binding subset
   needed to render validated fixtures:
     {{path}}            value substitution (HTML-escaped)
     {{#if path}} ... {{/if}}           truthy block (empty arrays are falsy)
     {{#unless path}} ... {{/unless}}
     {{#each path}} ... {{/each}}       array loop; inside: {{.}} item, {{@index}} 1-based
   Presentation-only derived values (money formatting, milestone amounts, care/recurring
   display text) are computed here from validated data; no price is hard-coded anywhere.

   Usage:  node ops/proposals/preview-proposal.mjs [fixture.json]
   Default fixture: examples/sample-proposal.json
   Output: ops/proposals/out/proposal-preview.html (git-ignored). Never committed. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const proposalsDir = __dirname;
const root = path.join(__dirname, '..', '..');

const TEMPLATE_PATH = path.join(proposalsDir, 'template', 'proposal-template.html');
const CSS_PATH = path.join(proposalsDir, 'template', 'proposal.css');

/* ---- money / label formatting ---- */

export const fmtMoney = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return '£' + v.toLocaleString('en-GB');
  if (v && typeof v === 'object' && typeof v.from === 'number') return 'From £' + v.from.toLocaleString('en-GB');
  return null;
};

const statusLabel = (s) =>
  s ? String(s).toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : '';

/* ---- view model: bind validated data -> flat presentation context ---- */

export function buildViewModel(p) {
  const cs = p.commercial_schedule || {};
  const approved = cs.approved_final_project_price;
  const scheduleRows = Array.isArray(cs.payment_schedule)
    ? cs.payment_schedule.map((pct) => ({
        pct,
        amount_display: fmtMoney(Number.isFinite(approved) ? (approved * pct) / 100 : null)
      }))
    : null;
  const recurring = cs.recurring_fees || null;
  const care = cs.care || null;
  const warranty = cs.warranty || null;
  const client = p.client || {};
  const contact = client.contact || {};
  const project = p.project || {};
  const offering = p.offering || {};
  const scope = p.scope || {};
  const timeline = p.timeline || {};
  const acceptance = p.acceptance || {};

  return {
    proposal_id: p.proposal_id,
    version: p.version,
    status_label: statusLabel(p.status),
    issue_date: p.issue_date,
    valid_until: p.valid_until,
    client_name: client.name,
    client_company: client.company,
    client_contact_name: contact.name,
    client_email: contact.email,
    client_phone: contact.phone,
    project_title: project.title,
    project_summary: project.summary,
    project_objectives: Array.isArray(project.objectives) ? project.objectives : null,
    offering_code: offering.code,
    offering_category: offering.category,
    offering_name: offering.name,
    scope_included: Array.isArray(scope.included) ? scope.included : null,
    scope_deliverables: Array.isArray(scope.deliverables) ? scope.deliverables : null,
    scope_exclusions: Array.isArray(scope.exclusions) ? scope.exclusions : null,
    timeline_estimated_delivery: timeline.estimated_delivery,
    timeline_notes: timeline.notes,
    currency: cs.currency,
    reference_price_display: fmtMoney(cs.reference_price),
    approved_price_display: fmtMoney(approved),
    setup_fee_display: fmtMoney(cs.setup_fee),
    payment_schedule_rows: scheduleRows,
    recurring_monthly_display: recurring && fmtMoney(recurring.monthly_fee),
    recurring_start_display: recurring
      ? (recurring.starts_at === 'GO_LIVE' ? 'from Go-Live' : 'monthly in advance')
      : null,
    recurring_note: recurring
      ? (recurring.starts_at === 'GO_LIVE'
          ? 'Recurring billing begins at Go-Live — never before.'
          : 'Paid monthly in advance.')
      : null,
    care_plan_display: care && (care.plan || care.code),
    care_monthly_display: care && fmtMoney(care.monthly_fee),
    care_note: care && 'Paid monthly in advance; separately identifiable from the project price.',
    warranty_label: warranty && warranty.label,
    responsibilities: Array.isArray(p.client_responsibilities) ? p.client_responsibilities : null,
    assumptions: Array.isArray(p.assumptions) ? p.assumptions : null,
    next_steps: Array.isArray(p.next_steps) ? p.next_steps : null,
    acceptance_status: acceptance.status,
    acceptance_method: acceptance.method
  };
}

/* ---- minimal data-binding template engine ---- */

const truthy = (v) =>
  Array.isArray(v) ? v.length > 0 : v != null && v !== false && v !== '' && v !== 'false';

function tokenize(tpl) {
  const parts = tpl.split(/(\{\{[\s\S]*?\}\})/);
  return parts.map((part) => {
    if (part.startsWith('{{')) return { tag: part.slice(2, -2).trim() };
    return { text: part };
  });
}

function parse(tokens) {
  const root = { type: 'root', children: [] };
  const stack = [root];
  for (const tok of tokens) {
    if (tok.text !== undefined) { stack[stack.length - 1].children.push({ type: 'text', text: tok.text }); continue; }
    const tag = tok.tag;
    const open = tag.match(/^#(if|unless|each)\s+([A-Za-z0-9_.]+)$/);
    const close = tag.match(/^\/(if|unless|each)$/);
    if (open) {
      const node = { type: open[1], name: open[2], children: [], elseChildren: null };
      stack[stack.length - 1].children.push(node);
      stack.push(node);
    } else if (tag === 'else') {
      const node = stack[stack.length - 1];
      if (!node.elseChildren) node.elseChildren = [];
      node.children = node.elseChildren;
    } else if (close) {
      stack.pop();
    } else {
      stack[stack.length - 1].children.push({ type: 'var', name: tag });
    }
  }
  return root;
}

function resolve(name, ctx) {
  if (name === '.') return ctx['.'];
  if (name.startsWith('@')) return ctx[name];
  const cur = ctx['.'];
  if (cur != null && typeof cur === 'object' && !Array.isArray(cur) && name in cur) return cur[name];
  return ctx[name];
}

const escapeHtml = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

function renderNode(node, ctx) {
  switch (node.type) {
    case 'root':
      return node.children.map((c) => renderNode(c, ctx)).join('');
    case 'text':
      return node.text;
    case 'var': {
      const v = resolve(node.name, ctx);
      return v == null ? '' : escapeHtml(v);
    }
    case 'if': {
      const list = truthy(resolve(node.name, ctx)) ? node.children : node.elseChildren || [];
      return list.map((c) => renderNode(c, ctx)).join('');
    }
    case 'unless': {
      const list = truthy(resolve(node.name, ctx)) ? node.elseChildren || [] : node.children;
      return list.map((c) => renderNode(c, ctx)).join('');
    }
    case 'each': {
      const arr = resolve(node.name, ctx);
      if (!Array.isArray(arr)) return (node.elseChildren || []).map((c) => renderNode(c, ctx)).join('');
      return arr
        .map((item, i) => renderNode({ type: 'root', children: node.children }, { ...ctx, '.': item, '@index': i + 1 }))
        .join('');
    }
    default:
      return '';
  }
}

export function renderTemplate(tpl, ctx) {
  return renderNode(parse(tokenize(tpl)), ctx);
}

/* ---- full proposal render (inlines CSS for a self-contained preview) ---- */

export function renderProposal(proposalData) {
  const tpl = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  const css = fs.readFileSync(CSS_PATH, 'utf8');
  const vm = buildViewModel(proposalData);
  let html = renderTemplate(tpl, vm);
  html = html.replace('<link rel="stylesheet" href="proposal.css">', '<style>\n' + css + '\n</style>');
  return html;
}

/* ---- CLI ---- */

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fixture = process.argv[2] || path.join(proposalsDir, 'examples', 'sample-proposal.json');
  const data = JSON.parse(fs.readFileSync(fixture, 'utf8'));
  const outDir = path.join(proposalsDir, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'proposal-preview.html');
  const html = renderProposal(data);
  fs.writeFileSync(outPath, html);
  const leftover = (html.match(/\{\{[\s\S]*?\}\}/g) || []);
  console.log('Preview written to ' + path.relative(root, outPath));
  console.log(leftover.length ? 'LEFTOVER TOKENS: ' + leftover.join(', ') : 'No leftover tokens.');
}
