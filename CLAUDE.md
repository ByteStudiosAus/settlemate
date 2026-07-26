# CLAUDE.md — agentrails project rules

**agentrails** is an MCP server + permissions engine giving AI agents scoped, guardrailed
access to the **Pinch Payments** API (Australian payment rails), plus a REST facade for a
dashboard and webhook endpoints for voice agents. Hackathon build: **working end-to-end beats
perfect**. TypeScript, Cloudflare Workers, deployed with `wrangler`.

## Hard rules (do not violate)

1. **TypeScript strict.** `tsc` must pass with `strict` + `noUncheckedIndexedAccess`.
2. **Amounts are always integer cents.** Never floats, never dollars in code paths. Pinch's
   API is natively in cents (`amount: 1245` = $12.45), so we pass cents straight through.
   Any dollar value only exists at the human-facing edge (display strings, agent prose).
3. **Never log full bank numbers.** Mask account numbers to the last 3 digits everywhere —
   logs, audit entries, error objects, API responses we relay. Use `maskAccount()` from
   `src/util.ts`. BSB may be logged in full (it's a branch code, not an account).
4. **All errors are returned as structured, readable objects — never thrown stack traces.**
   Shape: `{ error: true, code: string, message: string, details?: unknown }`. Permission
   refusals use the declined shape: `{ declined: true, reason, limitCents, attemptedCents }`.
   The Worker never leaks a raw exception to a client.
5. **Sandbox only.** Base URL is `https://api.getpinch.com.au/test`. Never point at `/live`.

## Pinch API facts (verified against docs.getpinch.com.au, do not re-derive from memory)

- **OAuth token:** `POST https://auth.getpinch.com.au/connect/token`,
  `Content-Type: application/x-www-form-urlencoded`,
  body `grant_type=client_credentials&client_id=<APPLICATION_ID>&client_secret=<SECRET_KEY>`.
  Response `{ access_token, expires_in (3600), token_type: "Bearer" }`. **Merchant ID is
  deprecated for auth** — authenticate with the **Application ID** (`app_...`) as `client_id`,
  NOT the publishable key (`pk_...`). Verified against docs.getpinch.com.au + a live sandbox
  200. We currently store the Application ID in the `PINCH_PUBLISHABLE_KEY` secret; rename to
  `PINCH_APPLICATION_ID` if convenient.
- **Every API call:** header `Authorization: Bearer <token>` + `pinch-version: 2020.1`,
  base `https://api.getpinch.com.au/test`.
- **Token caching:** cache in KV (`TOKENS` binding), refresh ~60s before `expires_in`.
- **Create/Update payer:** `POST /payers`. Required: `firstName`, `emailAddress`. Also
  `lastName`, `mobileNumber`. Returns `{ id: "pyr_...", sources[], ... }`.
- **Create bank source (the mandate):** `POST /payers/{id}/sources` with
  `{ sourceType: "bank-account", bankAccountName, bankAccountBsb, bankAccountNumber }`.
  Returns `{ id: "src_...", ... }`.
- **Scheduled payment (invoice / plan installment):** `POST /payments` with
  `{ payerId, amount (cents), transactionDate (YYYY-MM-DD), description, sourceId? }`.
  Returns `{ id: "pmt_...", status: "scheduled", ... }`.
- **Realtime payment (charge now):** `POST /payments/realtime` with
  `{ amount (cents), payerId, sourceId?, description }`. Returns `{ id: "pmt_...",
  status: "approved" | ... , dishonour }`.
- **Get payment:** `GET /payments/{id}` -> `{ status, amount, ... }`.
  Statuses: `scheduled` | `processing` | `dishonoured` | `transferred` (also `approved`
  on realtime). "settled/recovered" == `transferred`.
- **List scheduled payments:** `GET /payments/scheduled?page&pageSize` -> WRAPPED
  `{ data[], page, pageSize, totalPages, totalItems }`.
- **List payments for payer:** `GET /payments/payer/{id}` -> BARE ARRAY of payments.
- **List events:** `GET /events?page&pageSize&eventType` -> WRAPPED `{ data[], ... }`.
  Event object: `{ id: "evt_...", type, eventDate, metadata }`.
- **Get event:** `GET /events/{id}`.
- **Transfer line items:** `GET /transfers/items/{id}?page&pageSize` -> WRAPPED `{ data[], ... }`.
- **Error bodies vary:** some endpoints return `{ errors: [{ message, field }] }`, others a
  bare array of `{ propertyName, errorMessage, ... }`. `pinch.ts` normalises BOTH into our
  structured error shape.
- **Plans + Subscriptions (native recurring payments) — verified LIVE against the sandbox
  2026-07, see `probe-plans.ts` in that session's scratchpad for the full request/response
  trace:**
  - `POST /plans` — create a schedule template (no payer yet). Body: `{ name, fixedPayments?:
    [{ amountInCents, description, scheduledDateOffset, scheduledDateInterval:
    "days"|"months"|"years", cancelPlanOnFailure? }], recurringPayment? }`. Use `fixedPayments`
    (not `recurringPayment`) when instalments need DIFFERENT amounts (e.g. a remainder on the
    final one) — `recurringPayment` only supports ONE repeating `amountInCents`. Returns
    `{ id: "pln_...", ..., subscriberCount: 0, requiresTotalAmount }`.
  - `DELETE /plans/{id}` — only works while `subscriberCount` is 0.
  - `POST /subscriptions` — bind a plan to a payer: `{ planId, payerId, startDate (YYYY-MM-DD),
    sourceId? }`. THIS is what actually generates the individual `pmt_...` payment records
    (creating the plan alone does not). Returns `{ id: "sub_...", status: "active", ... }` —
    the response does NOT include the generated payment ids.
  - Generated payments: `GET /payments/payer/{id}` afterwards shows them, each embedding
    `subscription: { id, planId, planName }` — match by that + your own instalment
    `description` strings to recover the `pmt_...` ids.
  - `DELETE /subscriptions/{id}` — cancels the WHOLE plan for that payer in one call; confirmed
    live that every not-yet-taken payment it generated disappears from
    `GET /payments/payer/{id}` immediately after.
- **Webhooks** (`docs/webhooks.md`, `docs/events.md`):
  - Register: `POST /webhooks` with `{ uri, eventTypes?: [...], webhookFormat?:
    "pascal-case"|"camel-case" }`. **No portal/dashboard UI for this — API only.** Returns
    `{ id: "wbk_...", uri, secret: "whsec_..." }` — the secret is shown ONCE, store it as
    `PINCH_WEBHOOK_SECRET`.
  - Delivery payload: `{ Id, Type, EventDate, Metadata, Data }` (or camelCase — both
    supported; we accept either in `src/webhooks.ts`). `Data`'s shape depends on `Type`; the
    ones with a payment reference are `payment-created` / `realtime-payment` (Data IS the
    Payment) and `bank-results` / `scheduled-process` (Data.payments[] array). ~16 event types
    total (subscription-*, payer-*, refund-*, dispute-*, transfer, merchant-updated,
    compliance-updated cover everything else — not payment-status events).
  - Signature: header `pinch-signature: t=<unix_seconds>,v2=<hex>`, where
    `v2 = HMAC-SHA256("{t}.{raw body}", <whsec_ secret>)`. Reject if the timestamp is more
    than 5 minutes old (matches the .NET SDK's default replay window).
- **Date validation on writes (verified live — these 400 with a structured Pinch error, not
  silently clamped):** `POST /payments` rejects a `transactionDate` more than 30 days in the
  past ("Date can be any time in the future or up to 30 days in the past"). `POST
  /subscriptions` rejects a `startDate` more than 1 month in the past. Demo seed data
  (`daysAgo` in admin.ts's `DEMO_PAYERS`) must stay within these windows or seeding 400s.
- **Pinch does NOT enforce payer-name uniqueness.** `POST /payers` with the same name twice
  happily creates two distinct `pyr_...` records. The ONLY thing preventing duplicate demo
  payers is OUR OWN `seedpayer:<slug>` registry (GRANTS KV) — if a payer is ever created
  outside that registry's lookup-or-create path (a stray script, a payer created before the
  registry existed, etc.), it becomes a permanent orphan: same display name, no future
  invoices, and nothing (including `/admin/reset`) will ever clean it up automatically,
  because reset only touches registry-known ids. `GET /voice/payers` walks ALL scheduled
  payments and groups by whatever payer ids it finds — it has no way to know which
  same-named payer is "the real one", so orphans show up as extra, usually-$0 duplicates. If
  this happens, find and cancel the orphan's scheduled payments directly (Pinch payer ids are
  permanent — there's no payer-delete endpoint).

## Conventions

- KV keys: `grant:<agentId>`, `spend:<agentId>:<YYYY-MM-DD>`, `audit:<ts>:<rand>`, `pinch:token`,
  `seedpayer:<name-slug>` (name -> stable payerId, GRANTS binding — makes seed idempotent),
  `demo:targetPayerId` (GRANTS binding — the payerId `/voice/tool` resolves "TARGET" to),
  `init:context:<payerId>` (GRANTS binding, 60s TTL — cached `POST /voice/init` payload;
  warmed by `POST /admin/target` and `POST /admin/call` so ElevenLabs' call-start webhook
  never waits on a live Pinch fetch), `pinch:event:<eventId>` (GRANTS binding — webhook
  delivery dedup log), `pinch:payment:<paymentId>` (GRANTS binding — latest
  settlement-status snapshot written by `src/webhooks.ts`; read by
  `GET /admin/payments/status` and `GET /admin/recovered`'s "prefer webhook events" path).
- Dates for scheduling: `YYYY-MM-DD` (AU). Frequencies: weekly (+7d), fortnightly (+14d),
  monthly (+1 calendar month). See "Date validation on writes" above for Pinch's own past-date
  limits on `POST /payments` and `POST /subscriptions`.
- Every tool call flows through `permissions.enforce()`: grant exists -> active -> tool
  allowed -> per-tx limit -> daily limit -> execute -> audit (allowed or declined, always) —
  EXCEPT `create_payment_plan`, which re-checks the same things once against a single
  preflight snapshot rather than per-instalment (see `src/tools.ts`).
- MCP connection identifies its `agentId` via `?agentId=` query param or `x-agent-id` header.
- REST admin routes require `Authorization: Bearer <ADMIN_KEY>`. Voice routes require
  `x-voice-secret: <VOICE_SECRET>`. `/webhooks/pinch` is authenticated via the
  `pinch-signature` header (see above), not a shared secret. `/health` is open.
- **`src/index.ts`'s route dispatch MUST `await` every `handleX(...)` call inside the outer
  try/catch.** `try { return handleX(request, env); } catch { ... }` does NOT catch an
  exception thrown asynchronously inside `handleX` — the `try` block completes (handing back
  the still-pending promise) before the rejection happens, so the `catch` has already been
  skipped by the time it fires. This silently defeats hard-rule #4: any unguarded downstream
  throw (e.g. a KV read that isn't wrapped in its own try/catch) surfaces to the client as a
  raw Cloudflare error 1101 instead of our structured 500. `pinch.ts`'s functions defend
  against this themselves (every KV/network call is try/catched, converted to a
  `StructuredError`); plenty of other call sites (e.g. `permissions.getGrant`,
  `admin.resolveTargetPayerId`) do not, so the outer `await` is the only backstop. Covered by
  `test/index.test.ts`.
- `GET /admin/recovered`'s webhook-events snapshot path wraps each `env.GRANTS.get(key,
  "json")` in a local try/catch (real Cloudflare KV **throws**, not returns null, when the
  stored value isn't valid JSON) so one corrupted `pinch:payment:` record can't sink the whole
  recovered total. `GET /admin/grants` and `GET /admin/audit` do NOT do this (a prior
  `safeGetJson()` shared helper was tried and reverted — it coincided with both routes
  returning `internal_error` in production and couldn't be root-caused quickly against real
  prod KV data; `wrangler dev --remote` is blocked by unconfigured `preview_id`s in
  wrangler.toml, and `wrangler kv key list --remote` hit the CLI's daily rate limit mid-diagnosis).
  If you reintroduce per-record resilience there, verify against a `wrangler dev --remote`
  session (fix the preview namespace ids first) or real prod data, not just local dev's
  separately-seeded simulated KV — that's what let the bug slip through the first time.

## Deploy / secrets

Set secrets before deploy:
```
wrangler secret put PINCH_SECRET_KEY
wrangler secret put PINCH_PUBLISHABLE_KEY
wrangler secret put PINCH_MERCHANT_ID
wrangler secret put ADMIN_KEY
wrangler secret put VOICE_SECRET
wrangler secret put ELEVENLABS_API_KEY
wrangler secret put ELEVENLABS_AGENT_ID
wrangler secret put ELEVENLABS_PHONE_NUMBER_ID
wrangler secret put PINCH_WEBHOOK_SECRET
```
`ANTHROPIC_API_KEY` is only for the local `agents/` harness (put in a local `.env`, not a
Worker secret).
