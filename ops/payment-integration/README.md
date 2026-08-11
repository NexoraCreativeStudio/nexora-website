# Nexora — Payment integration architecture (safe scaffold)

**Status: NOT OPERATIONAL.** No payment provider is configured or activated. This directory is a safe, non-secret scaffold for the future integration. Nothing here can charge a card, create a subscription, or send a payment.

## Architecture principle

- The website is static and hosts **no** payment logic. Payments use **provider-hosted flows** (Stripe Checkout, Payment Links, hosted subscription billing) so Nexora never handles raw card data (PCI).
- A serverless function (e.g. Netlify Function) is the only place server-side Stripe logic would live: creating Checkout Sessions / subscriptions / Payment Links, verifying webhooks.
- Secrets live in **environment variables only** — `.env` is git-ignored; `.env.example` holds placeholders.

## Files

| File | Purpose |
|---|---|
| `.env.example` | Env-var placeholders (no secrets). Copy to `.env` locally / provider env vars when activated. |
| `stripe-example.js` | Reference-only, **test-mode** example of a Netlify Function pattern. Not executed, not wired to any route, no real keys. |

## What it would take to go live (OWNER ACTIONS)

1. Create/confirm the Stripe account and complete **KYC / identity verification**.
2. Confirm the **settlement bank account**.
3. Confirm **legal entity + billing address** details.
4. Confirm **VAT / tax status** with accounting (VAT is UNDETERMINED).
5. Choose **accounting/invoicing platform** (becomes authoritative for invoice numbering when active).
6. Activate **production** keys and **webhook endpoint**; set the production env vars.
7. Approved commercial decision on **payment methods to offer** (card / bank transfer / payment link / recurring card).

Until 1–7 are complete, the payment method table in `../PAYMENT-OPERATIONS.md` governs: **bank transfer only**, with everything else marked owner-activated.

## Environment variables (placeholders)

See `.env.example`. Variables are intentionally empty. Real keys are never committed.

## Security rules

- No secret keys in the repository, in `src/`, or in public JS.
- No card numbers / CVV stored anywhere.
- No custom card storage.
- No fabricated PCI compliance claims — compliance status requires external validation.
