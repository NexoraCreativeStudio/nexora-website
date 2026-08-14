# Nexora Payment Provider Capability Matrix (PROP.15 §4)

**Purpose:** Document capability requirements for each provider category to enable Owner decision-making without vendor lock-in. This matrix is provider-neutral — it specifies **what** capabilities are required, not **which** vendor provides them.

---

## 1. Shared Storage Provider (Required for STAGING_TEST)

### Required Capabilities (MUST)

| Capability | Description | Contract Method | Consistency Requirement |
| :--- | :--- | :--- | :--- |
| **Key-Value Get** | Retrieve value by key | `get(key) → string \| null` | Strong read-after-write |
| **Key-Value Set** | Store value by key | `set(key, value) → { ok: true }` | Strong write visibility |
| **Key-Value Delete** | Remove key | `delete(key) → { ok: true }` | Strong delete visibility |
| **Key Exists** | Check existence | `exists(key) → boolean` | Strong read-after-write |
| **Compare-and-Set** | Atomic conditional update | `compareAndSet(key, expected, newValue) → { ok: true, success: boolean }` | **Linearizable** — critical for idempotency |
| **Set-If-Absent** | Atomic create-if-not-exists | `setIfAbsent(key, value) → { ok: true, created: boolean }` | **Linearizable** — critical for idempotency |
| **List by Prefix** | Range scan for cleanup/debug | `listByPrefix(prefix) → string[]` | Eventual consistency acceptable |

### Required Operational Characteristics

| Characteristic | Minimum Requirement | Rationale |
| :--- | :--- | :--- |
| **Latency (p99)** | < 50ms within same region | Webhook processing SLA |
| **Availability** | ≥ 99.9% | Payment processing cannot tolerate storage unavailability |
| **Durability** | Synchronous replication to ≥ 2 zones | Idempotency keys must survive node failure |
| **Atomic Operations** | CAS and Set-If-Absent must be truly atomic | Prevents duplicate payment processing |
| **Namespace Isolation** | Logical namespace support (e.g., `nexora/payment/STAGING_TEST`) | Multi-environment isolation without separate clusters |
| **TLS in Transit** | Mandatory | Secret/token protection |
| **Encryption at Rest** | Mandatory | PCI DSS alignment |

### Viable Provider Categories (Owner Decision Required)

| Category | Example Technologies | Notes |
| :--- | :--- | :--- |
| **Managed Redis** | AWS ElastiCache, Azure Cache for Redis, Google Memorystore, Upstash | Native CAS via Lua scripts; low latency; pay-per-use options |
| **Managed PostgreSQL** | AWS RDS, Azure Database, Google Cloud SQL, Neon, Supabase | `SELECT ... FOR UPDATE` for CAS; ACID; familiar ops |
| **DynamoDB** | AWS DynamoDB | `ConditionExpression` for CAS; serverless; per-request pricing |
| **FoundationDB / etcd / Consul** | Self-managed or managed | Strong consistency; more operational overhead |
| **Custom HTTP KV API** | Internal service with above semantics | If organization has existing KV layer |

### Rejected Patterns (Anti-Patterns)

- ��� **Eventually consistent only** (e.g., DynamoDB eventual reads) — breaks idempotency
- ��� **No atomic CAS** — requires distributed locks (complexity, failure modes)
- ��� **Local filesystem / SQLite** — not shared across instances
- ��� **In-memory only** — data loss on restart (acceptable only for LOCAL_TEST)

---

## 2. Secret Management Provider (Required for STAGING_TEST)

### Required Capabilities (MUST)

| Capability | Description |
| :--- | :--- |
| **Secret References** | Store secrets by reference name (e.g., `STRIPE_SECRET_KEY_REF`) |
| **Runtime Injection** | Inject secrets as environment variables at deployment start |
| **Access Control** | Role-based access; deployment pipeline can read, developers cannot |
| **Audit Log** | Read access logging |
| **Rotation Support** | Ability to rotate secrets without redeployment |
| **Versioning** | Access to previous versions for rollback |

### Required Secret Types

| Secret Reference | Format | Rotation Frequency |
| :--- | :--- | :--- |
| `STRIPE_SECRET_KEY_REF` | `sk_test_...` / `sk_live_...` | Per Stripe policy / incident |
| `STRIPE_WEBHOOK_SECRET_REF` | `whsec_...` | Per Stripe policy / incident |
| `STRIPE_PUBLISHABLE_KEY_REF` | `pk_test_...` / `pk_live_...` | Per Stripe policy |
| `SHARED_STORAGE_URL_REF` | Connection string (e.g., `redis://...`) | Infrastructure rotation |
| `SHARED_STORAGE_TOKEN_REF` | Auth token / password | Per provider policy |

### Viable Provider Categories (Owner Decision Required)

| Category | Example Technologies | Notes |
| :--- | :--- | :--- |
| **Cloud Native** | AWS Secrets Manager, Azure Key Vault, GCP Secret Manager | Integrated with cloud deployment; IAM-based access |
| **HashiCorp Vault** | Self-managed or HCP Vault | Kubernetes integration; dynamic secrets; audit |
| **Doppler / 1Password Connect / Infisical** | SaaS secret management | Developer-friendly; GitOps integration |
| **GitOps Sealed Secrets** | Bitnami Sealed Secrets, Mozilla SOPS | Encrypted in repo; decrypted at deploy |
| **Platform Built-in** | Vercel Environment Variables, Netlify Build Environment, Cloudflare Workers Secrets | If deploying to specific platform |

### Rejected Patterns

- ��� **Plaintext in repository** — never commit real secrets
- ��� **Plaintext in CI/CD logs** — must mask in output
- ��� **Shared across environments** — STAGING_TEST and PRODUCTION must have separate secrets

---

## 3. Hosting / Compute Platform (Required for STAGING_TEST)

### Required Capabilities (MUST)

| Capability | Description |
| :--- | :--- |
| **HTTPS Termination** | TLS 1.2+ at edge |
| **Raw Body Access** | Webhook handler must receive exact request bytes (no pre-parsing) |
| **Environment Variables** | Inject configuration at runtime |
| **Custom Domains** | `api-staging.nexora.studio` or similar |
| **Health/Readiness Probes** | Kubernetes-style or platform-native |
| **Rollback / Previous Deployment Selection** | Traffic switch to previous version in < 30s |
| **Log Aggregation** | Structured JSON logs accessible for debugging |
| **Static IP / Egress Control** (Optional) | For Stripe IP allowlist if required |

### Viable Provider Categories (Owner Decision Required)

| Category | Example Technologies | Notes |
| :--- | :--- | :--- |
| **Serverless Functions** | Vercel Functions, Netlify Functions, Cloudflare Workers, AWS Lambda, Azure Functions, Google Cloud Functions | Pay-per-invocation; auto-scale; cold starts |
| **Container Platform** | AWS ECS/Fargate, Google Cloud Run, Azure Container Apps, Fly.io, Railway, Render | More control; predictable latency; always-warm options |
| **Kubernetes** | EKS, GKE, AKS, self-managed | Full control; highest operational burden |
| **VM / Bare Metal** | Traditional VMs | Not recommended for new workloads |

### Rejected Patterns

- ��� **Platforms that parse JSON body before handler** — breaks Stripe signature verification
- ��� **No raw body access** — cannot verify webhooks securely
- ��� **No rollback capability** — violates PROP.14 rollback contract

---

## 4. Stripe Integration (Required for STAGING_TEST)

### Required Capabilities (MUST)

| Capability | Description |
| :--- | :--- |
| **Test Mode API** | All calls to `api.stripe.com` with `sk_test_*` keys |
| **Webhook Signature Verification** | `stripe.webhooks.constructEvent(payload, sigHeader, secret)` |
| **Checkout Sessions** | `stripe.checkout.sessions.create()` with `mode: 'payment'` |
| **Payment Intent / Invoice Retrieval** | For reconciliation |
| **Idempotency Keys** | All mutating calls use idempotency keys |

### Version Pinning (Required)

| Dependency | Version Constraint | Rationale |
| :--- | :--- | :--- |
| **Stripe Node SDK** | `^16.0.0` (or latest LTS at deployment time) | Pin to major version; update via controlled process |
| **Node.js Runtime** | `>=20.x LTS` | Active LTS; matches deployment platform support |

### Network Boundaries (STAGING_TEST)

| Boundary | Enforcement |
| :--- | :--- |
| **Allowed Host** | `api.stripe.com` only (no `api.live.stripe.com`) |
| **Allowed Mode** | `TEST` only — SDK must be initialized with test key |
| **Blocked** | Any LIVE mode API call, any live key usage |

---

## 5. DNS / Networking (Required for STAGING_TEST)

### Required Records

| Record | Value | Purpose |
| :--- | :--- | :--- |
| `api-staging.nexora.studio` (or similar) | CNAME → hosting platform | Payment API base URL |
| `staging.nexora.studio` (or similar) | CNAME → static hosting | Frontend success/cancel URLs |

### Stripe Webhook Configuration

| Setting | Value |
| :--- | :--- |
| **Webhook URL** | `https://api-staging.nexora.studio/api/payment/webhook` |
| **Events** | `checkout.session.completed`, `checkout.session.expired`, `payment_intent.succeeded`, `payment_intent.payment_failed`, `invoice.payment_succeeded`, `invoice.payment_failed` |
| **Signing Secret** | From `STRIPE_WEBHOOK_SECRET_REF` (test mode secret) |

---

## 6. Decision Matrix Summary

| Decision | Required Before | Blocking Factor |
| :--- | :--- | :--- |
| **Shared Storage Provider** | STAGING_TEST deployment | STAGING_TEST cannot be `ready` without it |
| **Secret Management** | STAGING_TEST deployment | Secrets cannot be injected without it |
| **Hosting Platform** | STAGING_TEST deployment | No runtime without it |
| **Stripe Test Account** | STAGING_TEST deployment | No test credentials = no Stripe calls |
| **DNS Records** | STAGING_TEST deployment | No public endpoints without it |

---

## 7. Provider-Neutral Recommendation Criteria (For Owner Evaluation)

When evaluating specific vendors, score each candidate on:

| Criterion | Weight | Notes |
| :--- | :--- | :--- |
| **Capability Fit** | Critical | Must satisfy all "MUST" rows above |
| **Operational Familiarity** | High | Team expertise reduces incident response time |
| **Cost Predictability** | High | Prefer flat/usage-based over complex tiers |
| **Data Residency** | High | UK/EU required for GDPR |
| **Vendor Lock-in Risk** | Medium | Prefer standard protocols (Redis, PostgreSQL wire, S3 API) |
| **SLA / Support Tier** | Medium | Business-hours vs 24/7 |
| **Existing Contracts** | Medium | Leverage existing vendor relationships |
| **Compliance Certifications** | Medium | SOC2, ISO27001, PCI DSS scope |

---

**Next Step:** Owner reviews this matrix and selects providers for each category. Once decided, implementation of provider-specific adapters can proceed in `ops/payment/shared-storage-binding.mjs` and deployment manifests.

---

*This document is part of PROP.15 repository-side work. It contains no vendor selections, no credentials, and no deployment actions.*