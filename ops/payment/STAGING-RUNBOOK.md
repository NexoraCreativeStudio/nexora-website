# STAGING-RUNBOOK.md

**Nexora — STAGING_TEST Payment Backend Operator Runbook (PROP.15 §17)**

> **Classification:** INTERNAL — OPERATIONS ONLY
> **Version:** 1.0
> **Environment:** STAGING_TEST (Stripe TEST mode only)
> **Owner Approval Required:** Yes — for STAGING_PAYMENT_ENABLED=true

---

## 1. PURPOSE & SCOPE

This runbook governs the deployment, validation, operation, and rollback of the **STAGING_TEST** payment backend. It covers:

- **Pre-deployment** validation (checklist execution)
- **Deployment** steps (configuration, secrets, infrastructure)
- **Post-deployment** verification (health, readiness, smoke tests)
- **Ongoing operations** (monitoring, gate management, incident response)
- **Rollback** procedures (config, data, full)
- **Evidence recording** and operator sign-off

**Out of scope:** PRODUCTION_DISABLED and LIVE payments — these require separate Owner approval and are NOT covered here.

---

## 2. ENVIRONMENT BOUNDARIES (NON-NEGOTIABLE)

| Environment | Stripe Mode | Shared Storage | Payments Enabled | Owner Approval |
|-------------|-------------|----------------|------------------|----------------|
| `LOCAL_TEST` | TEST (deterministic) | Memory | `PAYMENTS_ENABLED=false` (default) | No |
| **`STAGING_TEST`** | **TEST only** | **Non-memory (Redis/PostgreSQL/DynamoDB)** | `STAGING_PAYMENT_ENABLED=false` (default) | **Yes — to enable** |
| `PRODUCTION_DISABLED` | TEST (default) / LIVE (with approval) | Non-memory | `PRODUCTION_PAYMENT_ENABLED=false` (default) | **Yes — explicit** |

**Critical Rules:**
- ❌ **NEVER** use `STRIPE_MODE=LIVE` in `STAGING_TEST`
- ❌ **NEVER** use `memory` storage provider in `STAGING_TEST`
- ❌ **NEVER** commit real secrets (keys, tokens, connection strings)
- ✅ **ALWAYS** use secret references (`*_REF` env vars)
- ✅ **ALWAYS** run checklist before deployment
- ✅ **ALWAYS** record evidence and obtain sign-off

---

## 3. KILL SWITCHES — DEFAULT FALSE

```bash
# Global kill switch (affects ALL environments)
PAYMENTS_ENABLED=false

# STAGING_TEST gate (must be explicitly enabled by operator)
STAGING_PAYMENT_ENABLED=false

# PRODUCTION_DISABLED gate (Owner approval ONLY)
PRODUCTION_PAYMENT_ENABLED=false
```

**Behavior:**
| Gate | Checkout Creation | Webhook Processing |
|------|-------------------|-------------------|
| `PAYMENTS_ENABLED=false` | ❌ Blocked (all envs) | ✅ Allowed (in-flight) |
| `STAGING_PAYMENT_ENABLED=false` | ❌ Blocked (STAGING_TEST) | ✅ Allowed (in-flight) |
| `PRODUCTION_PAYMENT_ENABLED=false` | ❌ Blocked (PROD_DISABLED) | ✅ Allowed (in-flight) |

> **Note:** Webhook processing is NEVER blocked by kill switches — in-flight transactions must complete.

---

## 4. PRE-DEPLOYMENT CHECKLIST (MANDATORY)

Run the automated checklist before ANY staging deployment:

```bash
# From repo root
node ops/payment/staging-deployment-checklist.mjs
```

### Checklist Categories

| Category | Required Items | Key Validations |
|----------|----------------|-----------------|
| **Configuration** | 6 | Schema, security, Stripe config, environment, kill switches |
| **Shared Storage** | 4 | Provider non-memory, namespace pattern, connectivity, CAS support |
| **Stripe** | 7 | Secret keys (test only), API version, SDK, call allowance |
| **URLs/CORS** | 3 | HTTPS, explicit origins, success URL template |
| **Webhook** | 3 | TEST verifier, tolerance, secret matches mode |
| **Idempotency/Recon** | 3 | TTL ≥60s, tolerance ≥0, exact match for PAID |
| **Logging** | 3 | Log level, deployment ID, release SHA |
| **Security** | 3 | No LIVE secrets, refs not committed, raw body adapter |
| **Deployment Manifest** | 2 | Manifest module, rollback tested |

### Gate Criteria

- ✅ **All required items PASS** → Deployment may proceed
- ❌ **Any required item FAIL** → Deployment BLOCKED
- ⚠️ **Optional items FAIL** → Warning only, deployment may proceed with operator acknowledgment

---

## 5. DEPLOYMENT PROCEDURE

### 5.1 Prerequisites

- [ ] Owner approval obtained for `STAGING_PAYMENT_ENABLED=true` (if enabling payments)
- [ ] Staging infrastructure provisioned (shared storage, DNS, TLS)
- [ ] Stripe TEST mode account configured with webhook endpoint
- [ ] Secret manager populated with references:
  - `STRIPE_SECRET_KEY_REF` → `sk_test_...`
  - `STRIPE_WEBHOOK_SECRET_REF` → `whsec_...`
  - `STRIPE_PUBLISHABLE_KEY_REF` → `pk_test_...`
  - `SHARED_STORAGE_URL_REF` → connection string
  - `SHARED_STORAGE_TOKEN_REF` → auth token (if required)

### 5.2 Configuration Deployment

Deploy environment variables to staging platform:

```bash
# Required for STAGING_TEST
DEPLOYMENT_ENV=STAGING_TEST
DEPLOYMENT_ID=staging-$(date +%s)-$(git rev-parse --short HEAD)
RELEASE_SHA=$(git rev-parse HEAD)

PAYMENTS_ENABLED=false
STAGING_PAYMENT_ENABLED=false  # Set to true ONLY with Owner approval
PRODUCTION_PAYMENT_ENABLED=false

STRIPE_MODE=TEST
STRIPE_API_VERSION=2024-06-20
WEBHOOK_TOLERANCE_SECONDS=300
IDEMPOTENCY_TTL_SECONDS=86400
RECONCILIATION_TOLERANCE_PENCE=0

PUBLIC_BASE_URL=https://staging.nexora.studio
PAYMENT_API_BASE_URL=https://api-staging.nexora.studio
STRIPE_SUCCESS_URL=https://staging.nexora.studio/payment/success?session_id={CHECKOUT_SESSION_ID}
STRIPE_CANCEL_URL=https://staging.nexora.studio/payment/cancel

SHARED_STORAGE_PROVIDER=redis  # or postgresql, dynamodb
SHARED_STORAGE_NAMESPACE=nexora/payment/STAGING_TEST

ALLOWED_ORIGINS=https://staging.nexora.studio
LOG_LEVEL=info
```

### 5.3 Deploy Application

```bash
# Deploy static files + API functions to staging platform
# (Platform-specific: Vercel, Netlify, Cloudflare Pages, etc.)

# Verify deployment
curl -s https://api-staging.nexora.studio/api/payment/health | jq .
curl -s https://api-staging.nexora.studio/api/payment/readiness | jq .
```

### 5.4 Configure Stripe Webhook

1. Go to Stripe Dashboard (TEST mode) → Developers → Webhooks
2. Add endpoint: `https://api-staging.nexora.studio/api/payment/webhook`
3. Select events:
   - `checkout.session.completed`
   - `payment_intent.succeeded`
   - `checkout.session.expired`
   - `payment_intent.payment_failed`
   - `charge.refunded`
   - `charge.dispute.created`
4. Copy **Signing Secret** (`whsec_...`) to secret manager as `STRIPE_WEBHOOK_SECRET_REF`

---

## 6. POST-DEPLOYMENT VERIFICATION

### 6.1 Health Endpoint

```bash
curl -s https://api-staging.nexora.studio/api/payment/health | jq .
```

**Expected (STAGING_PAYMENT_ENABLED=false):**
```json
{
  "ok": true,
  "status": "HEALTHY",
  "environment": "STAGING_TEST",
  "collection_enabled": "COLLECTION_DISABLED",
  "kill_switches": {
    "payments_enabled": false,
    "staging_payment_enabled": false,
    "production_payment_enabled": false
  }
}
```

### 6.2 Readiness Endpoint

```bash
curl -s https://api-staging.nexora.studio/api/payment/readiness | jq .
```

**Expected (STAGING_PAYMENT_ENABLED=false):**
```json
{
  "ok": false,
  "ready": false,
  "environment": "STAGING_TEST",
  "collection_enabled": "COLLECTION_DISABLED",
  "state": "NOT_READY",
  "reasons": ["STAGING_PAYMENT_ENABLED=false — staging payments disabled"]
}
```

### 6.3 Run Full Checklist (Again)

```bash
node ops/payment/staging-deployment-checklist.mjs
```

### 6.4 Smoke Tests (If STAGING_PAYMENT_ENABLED=true)

**Only run if Owner has approved payment enablement:**

```bash
# 1. Create test payment request (via internal tooling)
# 2. Generate payment token
# 3. Call checkout creation
curl -X POST https://api-staging.nexora.studio/api/payment/checkout \
  -H "Content-Type: application/json" \
  -d '{"token": "PAT-..."}'

# 4. Verify checkout URL returns Stripe TEST checkout page
# 5. Complete test payment with Stripe test card (4242 4242 4242 4242)
# 6. Verify webhook received and reconciliation triggered
# 7. Check portal session status
```

---

## 7. EVIDENCE RECORDING & SIGN-OFF

### 7.1 Create Evidence Record

```bash
node -e "
const { createEvidenceRecord, buildConfigFromEnv } = require('./ops/payment/deployment-config.mjs');
const { addChecklistEvidence, addHealthEvidence, addReadinessEvidence, recordSignOff, generateEvidenceReport } = require('./ops/payment/staging-evidence-record.mjs');

const config = buildConfigFromEnv(process.env);
const record = createEvidenceRecord(config, 'operator-name');

// Add evidence from checklist, health, readiness
// ... (automated via deployment pipeline)

console.log(generateEvidenceReport(record));
"
```

### 7.2 Required Evidence Sections

| Section | Source | Required |
|---------|--------|----------|
| `checklist` | `staging-deployment-checklist.mjs` | ✅ |
| `health_endpoint` | `GET /api/payment/health` | ✅ |
| `readiness_endpoint` | `GET /api/payment/readiness` | ✅ |
| `connectivity` | Storage/Stripe connectivity tests | ✅ |
| `webhook_verification` | Webhook signature test | ⚠️ |
| `checkout_test` | Test checkout creation | ⚠️ (if payments enabled) |
| `reconciliation_test` | Test reconciliation | ⚠️ (if payments enabled) |
| `rollback_test` | Rollback dry-run | ⚠️ |

### 7.3 Operator Sign-Off

```bash
# After all evidence collected and verified
node -e "
const { recordSignOff } = require('./ops/payment/staging-evidence-record.mjs');
recordSignOff(record, 'operator-name', 'APPROVE', 'All checks pass, staging ready for smoke testing');
"
```

**Sign-off decisions:**
- `APPROVE` — Deployment valid, evidence complete
- `REJECT` — Evidence incomplete or failed, requires re-deployment

---

## 8. ONGOING OPERATIONS

### 8.1 Monitoring Endpoints

| Endpoint | Frequency | Alert Threshold |
|----------|-----------|-----------------|
| `GET /api/payment/health` | Every 30s | Status ≠ HEALTHY |
| `GET /api/payment/readiness` | Every 60s | Ready = false (if payments enabled) |

### 8.2 Log Monitoring

Structured logs include:
- `correlation_id` for request tracing
- `deployment_id` for deployment identification
- Redacted secrets (auto-redacted by SafeLogger)

**Key log events to monitor:**
- `kill_switch` — Gate state changes
- `webhook_processed` — Successful webhook handling
- `reconciliation_outcome` — EXACT/PARTIAL/FAIL
- `error` — Any processing failures

### 8.3 Gate Management

**To enable staging payments (requires Owner approval):**

```bash
# 1. Update environment variable
STAGING_PAYMENT_ENABLED=true

# 2. Redeploy / restart payment API

# 3. Verify readiness
curl -s https://api-staging.nexora.studio/api/payment/readiness | jq '.ready'

# 4. Run smoke test
# 5. Update evidence record
# 6. Operator sign-off for payment enablement
```

**To disable staging payments (emergency):**

```bash
# 1. Update environment variable
STAGING_PAYMENT_ENABLED=false

# 2. Redeploy / restart payment API (immediate effect on new checkouts)

# 3. Verify health shows COLLECTION_DISABLED
curl -s https://api-staging.nexora.studio/api/payment/health | jq '.collection_enabled'
```

> **Note:** In-flight webhooks continue processing even when gate is disabled.

---

## 9. INCIDENT RESPONSE

### 9.1 Webhook Failures

**Symptoms:** Increased `webhook_processing_failed` logs, Stripe webhook retry alerts

**Actions:**
1. Check health/readiness endpoints
2. Review structured logs for `WEBHOOK_PROCESSING_FAILED`
3. Verify shared storage connectivity
4. Check Stripe Dashboard → Webhook delivery attempts
5. If signature verification failing: verify webhook secret matches
6. If idempotency conflicts: check for duplicate events

### 9.2 Reconciliation Mismatches

**Symptoms:** `reconciliation_outcome: FAIL` or `PARTIAL` in logs

**Actions:**
1. Check `reconciliation_tolerance_pence` config (should be 0 for STAGING_TEST)
2. Verify amount/currency match between invoice, request, and Stripe event
3. Review payment record evidence chain
4. Manual reconciliation via admin tooling if needed

### 9.3 Shared Storage Outage

**Symptoms:** Storage errors in logs, health check degradation

**Actions:**
1. Check storage provider status page
2. Verify connectivity from staging environment
3. If prolonged: consider read-only mode for webhook processing (requires code change)
4. Post-recovery: verify idempotency keys intact, no data loss

### 9.4 Emergency Rollback

See **Section 10: Rollback Procedures**.

---

## 10. ROLLBACK PROCEDURES

### 10.1 Config Rollback (Fastest — seconds)

```bash
# 1. Revert environment variables to previous known-good values
# 2. Redeploy / restart payment API
# 3. Verify health/readiness
# 4. Record rollback in evidence record
```

### 10.2 Data Rollback (If shared storage corrupted)

```bash
# 1. Stop payment API (scale to 0)
# 2. Restore shared storage from backup (point-in-time)
# 3. Verify data integrity (idempotency keys, payment records)
# 4. Restart payment API
# 5. Verify health/readiness
# 6. Process any missed webhooks (Stripe retries automatically)
```

### 10.3 Full Rollback (Code + Config + Data)

```bash
# 1. Revert to previous git commit / deployment artifact
# 2. Revert environment variables
# 3. Restore shared storage from backup
# 4. Deploy previous version
# 5. Run full checklist
# 6. Record rollback evidence
```

### 10.4 Rollback Validation

After ANY rollback:
- [ ] Health endpoint returns HEALTHY
- [ ] Readiness endpoint reflects correct gate state
- [ ] No orphaned payment records
- [ ] Idempotency keys intact (no duplicate processing)
- [ ] Evidence record updated with rollback details

---

## 11. ENABLING STAGING PAYMENTS (OPERATOR GUIDE)

### 11.1 Prerequisites

- [ ] Owner written approval (email/Slack/ticket reference)
- [ ] All checklist items PASS
- [ ] Evidence record COMPLETE and SIGNED_OFF
- [ ] Stripe TEST webhook configured and verified
- [ ] Smoke test plan reviewed

### 11.2 Enable Procedure

```bash
# 1. Document approval reference
APPROVAL_REF="OWNER-APPROVAL-2026-001"

# 2. Update environment
STAGING_PAYMENT_ENABLED=true

# 3. Deploy configuration change

# 4. Wait for readiness
while true; do
  READY=$(curl -s https://api-staging.nexora.studio/api/payment/readiness | jq -r '.ready')
  [ "$READY" = "true" ] && break
  sleep 5
done

# 5. Execute smoke test
./scripts/staging-smoke-test.sh

# 6. Update evidence record with payment enablement
# 7. Operator sign-off for payment enablement
```

### 11.3 Disable Procedure (Emergency or Scheduled)

```bash
# 1. Update environment
STAGING_PAYMENT_ENABLED=false

# 2. Deploy configuration change

# 3. Verify collection disabled
curl -s https://api-staging.nexora.studio/api/payment/health | jq '.collection_enabled'
# Should return: "COLLECTION_DISABLED"

# 4. Update evidence record
# 5. Notify stakeholders
```

---

## 12. VALIDATION SCRIPTS

| Script | Purpose | When to Run |
|--------|---------|-------------|
| `staging-deployment-checklist.mjs` | Pre-flight validation | Before every deployment |
| `validate-staging-integration.mjs` | End-to-end integration test | Post-deployment, pre-sign-off |
| `test-harness.mjs` | Offline positive/negative tests | CI/CD, local development |
| `validate-controlled-deployment.mjs` | Full PROP.14/15 regression | Pre-merge, release |

### Run Integration Validation

```bash
node ops/payment/validate-staging-integration.mjs
```

### Run Offline Tests

```bash
node ops/payment/test-harness.mjs
```

### Run Full Regression

```bash
node ops/payment/validate-controlled-deployment.mjs
node build.js && node verify.js
node ops/validate-ops.mjs
node ops/validate-website.mjs
```

---

## 13. CONTACT & ESCALATION

| Role | Contact | Escalation |
|------|---------|------------|
| **Primary Operator** | [Operator Name] | → Platform Lead |
| **Platform Lead** | [Lead Name] | → Engineering Director |
| **Owner (Payment Approval)** | [Owner Name] | — |
| **Stripe Support** | Stripe Dashboard → Support | For webhook/API issues |
| **Infrastructure Provider** | [Provider Support] | For storage/DNS/TLS issues |

---

## 14. CHANGE LOG

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-08-14 | PROP.15 Automation | Initial runbook for STAGING_TEST deployment |

---

## 15. APPENDIX: QUICK REFERENCE

### Environment Variables (STAGING_TEST)

```bash
DEPLOYMENT_ENV=STAGING_TEST
DEPLOYMENT_ID=staging-<timestamp>-<sha>
RELEASE_SHA=<git-sha>
PAYMENTS_ENABLED=false
STAGING_PAYMENT_ENABLED=false  # Owner approval to change
PRODUCTION_PAYMENT_ENABLED=false
STRIPE_MODE=TEST
STRIPE_API_VERSION=2024-06-20
WEBHOOK_TOLERANCE_SECONDS=300
IDEMPOTENCY_TTL_SECONDS=86400
RECONCILIATION_TOLERANCE_PENCE=0
PUBLIC_BASE_URL=https://staging.nexora.studio
PAYMENT_API_BASE_URL=https://api-staging.nexora.studio
STRIPE_SUCCESS_URL=https://staging.nexora.studio/payment/success?session_id={CHECKOUT_SESSION_ID}
STRIPE_CANCEL_URL=https://staging.nexora.studio/payment/cancel
SHARED_STORAGE_PROVIDER=redis|postgresql|dynamodb
SHARED_STORAGE_NAMESPACE=nexora/payment/STAGING_TEST
ALLOWED_ORIGINS=https://staging.nexora.studio
LOG_LEVEL=info
```

### Key Endpoints

```
GET  /api/payment/health        # Liveness + config parseable
GET  /api/payment/readiness     # Full dependency + gate check
POST /api/payment/checkout      # Create checkout session (gate-protected)
POST /api/payment/webhook       # Stripe webhook (never gate-blocked)
```

### Stripe Test Cards

| Scenario | Card Number |
|----------|-------------|
| Success | 4242 4242 4242 4242 |
| Decline | 4000 0000 0000 0002 |
| 3D Secure | 4000 0025 0000 3155 |
| Insufficient Funds | 4000 0000 0000 9995 |

---

**END OF RUNBOOK**

> This document is part of the PROP.15 controlled deployment artifacts. Changes require PR review and Owner approval for payment-affecting modifications.