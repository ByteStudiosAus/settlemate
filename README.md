# SettleMate

**An AI collections agent for Australian tradies and SMEs, built on Pinch Payments.**

SettleMate lets an AI agent — voice or text, autonomous or human-in-the-loop — chase
overdue invoices, set up payment plans, and take payments on a business's behalf,
without ever holding a raw credential or an unbounded blank cheque. Every action a
model can take is expressed as a small, typed tool; every tool call is checked against
a per-agent spending grant (per-transaction limit, daily limit, allowed-tool list)
*before* it touches money; every attempt — allowed or refused — is written to an
append-only audit log. The agent can propose and act; it can never exceed what the
business owner explicitly authorised.

It's built end-to-end on **Pinch Payments** (`getpinch.com.au`), an Australian direct-debit
and card payment processor: payer/mandate management, scheduled payments, native
recurring payment plans, and a signed webhook feed for settlement events — see
["How Pinch is used"](#how-pinch-is-used) below.

## The problem

Chasing overdue invoices is one of the most common, most annoying jobs in a small
business — and one of the most natural to hand to an AI agent (a voice caller, a chat
assistant, an autonomous biller). But "let an LLM touch our merchant account" is a
correct and immediate objection: LLMs hallucinate, misread numbers, and can be talked
into things by a plausible-sounding customer on the phone. SettleMate's answer isn't
"trust the model" — it's a **permissions engine** the model cannot reason its way
around, sitting between every tool call and Pinch's real payment rails.

## Architecture

```
┌─────────────────┐   ┌──────────────────┐   ┌───────────────────────┐
│  MCP client      │   │  ElevenLabs      │   │  Dashboard / any      │
│  (Claude, etc.)  │   │  voice agent     │   │  REST client          │
└────────┬─────────┘   └────────┬─────────┘   └───────────┬───────────┘
         │ POST /mcp            │ POST /voice/*            │ /admin/*, /api/*
         ▼                      ▼                          ▼
┌──────────────────────────────────────────────────────────────────────┐
│                     Cloudflare Worker (this repo)                    │
│                                                                        │
│   9 agent-facing tools  ──────────►  permissions.enforce()           │
│   (src/tools.ts)                     grant exists → active →        │
│                                       tool allowed → per-tx limit →   │
│                                       daily limit → execute → audit   │
│                                              │                        │
│                                              ▼                        │
│                                        src/pinch.ts                  │
│                                  (typed Pinch API client)             │
└───────────────────────────────────┬──────────────────────────────────┘
                                     │ OAuth client-credentials
                                     ▼
                        ┌─────────────────────────┐
                        │   Pinch Payments API      │
                        │   (AU direct debit/card)  │
                        └────────────┬──────────────┘
                                     │ signed webhook events
                                     ▼
                        POST /webhooks/pinch (this repo)
                        → settlement lifecycle → audit log
```

**Cloudflare Workers**, TypeScript strict throughout, zero servers to manage, KV for all
state (no separate database). Five KV namespaces (`GRANTS`, `SPEND`, `AUDIT`, `TOKENS`,
`IDEMPOTENCY`) hold everything: agent grants, daily spend counters, the audit trail,
a cached Pinch OAuth token, and idempotency guards.

### The permissions engine (`src/permissions.ts`)

The whole trust model in one function, `enforce()`:

```
grant exists? → grant active? → tool in allowedTools? → amount ≤ per-tx limit?
→ amount + today's spend ≤ daily limit? → execute() → record spend → audit
```

Every money-touching tool goes through this — no exceptions, no bypass. A refusal at
any step returns a structured `{ declined: true, reason, limitCents, attemptedCents }`
object the calling agent can relay in plain language ("that's over my $2,000 per-payment
authority") instead of a stack trace. `create_payment_plan` re-checks the same chain
once against a single preflight snapshot rather than per-instalment (it creates one
native Pinch recurring-payment object, not N separate payments — see below) but the
guarantee is identical: nothing is created that the grant wouldn't allow.

### Four surfaces, one tool layer

- **MCP server** (`POST /mcp`) — the 9 tools over JSON-RPC 2.0, for any MCP-speaking
  client (Claude Desktop, Claude Code, a custom agent harness).
- **Voice webhooks** (`/voice/*`) — the bridge for an **ElevenLabs Conversational AI**
  phone agent: a generic tool-invocation endpoint that runs the exact same
  `enforce()` path as MCP and always returns a read-aloud `speech` string, plus
  call-start context injection so the agent never has to guess a customer's name,
  balance, or its own spending authority.
- **REST admin / dashboard facade** (`/admin/*`, `/rest/*`, `/api/*`) — grant
  management, the audit log, recovered-payments totals, ad-hoc debtor/invoice
  creation, and (via ElevenLabs) triggering an outbound collections call.
- **Pinch webhooks** (`POST /webhooks/pinch`) — receives signed settlement events
  from Pinch and turns them into audit-log entries (`settled` / `failed` /
  `processing`), so the dashboard shows real payment lifecycle, not just agent
  actions.

Every surface bottoms out in the **same nine tools** — an agent never gets a wider
blast radius by switching transport.

### The 9 agent-facing tools

| Tool | What it does |
|---|---|
| `create_payer` | Create a customer in Pinch |
| `add_bank_account` | Attach a bank-account direct-debit mandate to a payer |
| `create_invoice` | Schedule a single future debit |
| `charge_now` | Charge a payer's account immediately (realtime) |
| `create_payment_plan` | Split a total into 2–6 instalments — ONE native Pinch Plan + Subscription |
| `cancel_payment_plan` | Cancel every remaining instalment of a plan in one call |
| `check_payment_status` | Look up a payment's current status |
| `list_overdue` | List overdue/dishonoured payments, scoped to a payer or global |
| `get_agent_limits` | Introspect the calling agent's own remaining authority |

Guardrails baked into `create_payment_plan` specifically (the highest-risk tool, since
it commits to a recurring schedule): a `startDate` in the past is refused outright, and
the requested total is sanity-checked against the payer's actual overdue balance —
if it's off by more than 20%, nothing is created and the agent gets back a speakable
clarification ("that plan totals $570 but the balance is $880 — should I set it for
the full amount?") instead of silently committing to the wrong figure.

## How Pinch is used

Pinch (`docs.getpinch.com.au`) is an Australian payment processor — direct debit
(bank account) and card, OAuth client-credentials auth, sandbox base
`https://api.getpinch.com.au/test`. This project is built directly on top of it, not
alongside it:

- **Payers** (`POST /payers`) — every customer SettleMate can act on is a Pinch payer
  record (`pyr_...`).
- **Bank-account mandates** (`POST /payers/{id}/sources`) — the direct-debit
  authorisation (`src_...`) a payer must have before any charge or scheduled payment
  can run against them.
- **Scheduled payments** (`POST /payments`) — a single future-dated debit, used for
  one-off invoices (`create_invoice`).
- **Realtime payments** (`POST /payments/realtime`) — an immediate charge
  (`charge_now`), with the sandbox's dishonour outcome surfaced back to the agent.
- **Native recurring payment plans** (`POST /plans` + `POST /subscriptions`) —
  `create_payment_plan` doesn't loop N individual `POST /payments` calls; it creates
  ONE Pinch **Plan** (a `fixedPayments` schedule template — verified live that this,
  not `recurringPayment`, is what's needed to preserve an exact per-instalment amount
  with a remainder on the final instalment) and ONE **Subscription** binding it to the
  payer. Pinch generates every instalment payment itself. Cancelling the whole
  remaining schedule is a single `DELETE /subscriptions/{id}` call
  (`cancel_payment_plan`) instead of N individual cancellations.
- **Webhooks** (`POST /webhooks`, registered once via the API — Pinch has no
  dashboard UI for this) — SettleMate's `POST /webhooks/pinch` verifies Pinch's
  `pinch-signature: t=<ts>,v2=<hmac-sha256>` header, maps each payment-referencing
  event to a settlement outcome (`transferred` → **settled**, `dishonoured` →
  **failed**, anything else → **processing**), and writes it to both a KV snapshot
  and the audit log. `GET /admin/recovered` prefers this webhook-fed snapshot when
  one exists (cheaper, reflects real settlement events) and falls back to a live
  Pinch scan otherwise.
- **Events / transfers** (`GET /events`, `GET /transfers/items/{id}`) — the raw
  primitives behind the webhook feed and reconciliation, wrapped by `src/pinch.ts`.

Every Pinch fact this codebase relies on (auth quirks, response shapes, status
vocabulary, date-validation limits, the Plans/Subscriptions behaviour above) was
verified live against the sandbox — not taken on faith from the docs alone.

## Test suite

103 tests across 6 suites, `node:test` + `tsx`, no test framework dependency. Pinch
and ElevenLabs are stubbed at the `fetch` level with response shapes captured from
real sandbox calls; KV is an in-memory mock. `test/webhooks.test.ts` exercises the
**real** HMAC-SHA256 signing/verification path (constructs actual signatures with
`crypto.subtle`, not a mock). `test/index.test.ts` proves the outer Worker try/catch
actually catches async exceptions, not just synchronous ones — every route handler
call is `await`ed specifically so a downstream throw can't leak past it as a raw
exception.

```bash
npm test              # everything
npm run test:perms    # permissions engine
npm run test:tools    # the 9 tools + guardrails
npm run test:admin    # REST admin / dashboard facade
npm run test:voice    # ElevenLabs voice webhooks
npm run test:webhooks # Pinch webhook signature verification + event handling
npm run test:index    # Worker entry-point error handling
npm run typecheck     # tsc --strict, must pass clean
```

## Setup

```bash
# 1. Install
npm install

# 2. Local secrets
cp .dev.vars.example .dev.vars
# then fill in real SANDBOX values — see .dev.vars.example for where each one
# comes from (Pinch dashboard, ElevenLabs dashboard, or generate your own).

# 3. Start the worker
npm run dev

# 4. Seed demo data (creates a grant + 3 payers + overdue invoices)
curl -X POST http://localhost:8787/admin/seed \
  -H "Authorization: Bearer <your ADMIN_KEY from .dev.vars>"

# 5. Run the test suite
npm test

# 6. Run the smoke test against your local worker
ADMIN_KEY=<your ADMIN_KEY> npm run smoke

# 7. Run the agent-to-agent demo (two Claude agents transacting through MCP)
ANTHROPIC_API_KEY=<your key> ADMIN_KEY=<your ADMIN_KEY> npm run a2a
ANTHROPIC_API_KEY=<your key> ADMIN_KEY=<your ADMIN_KEY> npm run a2a -- --scenario=blocked
```

`ANTHROPIC_API_KEY` is read directly from the shell (not `.dev.vars`) — it's only used
by the local `agents/a2a.ts` demo harness, never by the deployed Worker.

## Demo Day Runbook

Exact, copy-pasteable sequence for demo mornings: **deploy → reset → verify**. Run top
to bottom. Replace `<PLACEHOLDERS>`.

### 1. Deploy

```bash
wrangler deploy
# Note the production URL it prints, e.g. https://<your-worker-name>.<subdomain>.workers.dev
export PROD_URL=https://<your-worker-name>.<subdomain>.workers.dev
```

### 2. Set production secrets (skip any already set)

```bash
wrangler secret put PINCH_SECRET_KEY               # paste sk_test_...
wrangler secret put PINCH_PUBLISHABLE_KEY           # paste the Application ID (app_test_...)
wrangler secret put PINCH_MERCHANT_ID               # paste merchant id (reference only)
wrangler secret put VOICE_SECRET                    # paste any strong shared secret
wrangler secret put ELEVENLABS_API_KEY              # xi-api-key
wrangler secret put ELEVENLABS_AGENT_ID             # agent_...
wrangler secret put ELEVENLABS_PHONE_NUMBER_ID      # phnum_...
wrangler secret put PINCH_WEBHOOK_SECRET            # whsec_... from POST /webhooks

# ADMIN_KEY — generate a fresh one, NEVER a dev default:
openssl rand -hex 24                                 # copy the output
wrangler secret put ADMIN_KEY                       # paste the generated value
export ADMIN_KEY=<the-value-you-just-generated>
```

### 3. Reset demo state (ALWAYS, after every deploy)

Stale grants from a previous deploy silently break every tool (`no_grant`). The reset
command cancels all scheduled payments for the demo payers (including any Soapbox
invoices from the A2A demo), then re-seeds fresh overdue invoices. Payer IDs are
stable across resets — the registry is preserved in KV so payerIds never change
between runs.

```bash
curl -X POST "$PROD_URL/admin/reset" -H "Authorization: Bearer $ADMIN_KEY"
```

> First deploy ever (no payers registered yet)? Use `/admin/seed` instead — it creates
> the payers and registers them. Every subsequent run uses `/admin/reset`.

```bash
# First deploy only:
curl -X POST "$PROD_URL/admin/seed" -H "Authorization: Bearer $ADMIN_KEY"
```

### 4. Verify in 60 seconds

```bash
# a) health (open route)
curl "$PROD_URL/health"

# b) get_agent_limits via MCP — confirms the seeded grant is live
curl -X POST "$PROD_URL/mcp?agentId=demo-agent" \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_agent_limits","arguments":{}}}'

# c) recovered total
curl "$PROD_URL/admin/recovered" -H "Authorization: Bearer $ADMIN_KEY"

# d) payments-by-status breakdown
curl "$PROD_URL/admin/payments/status" -H "Authorization: Bearer $ADMIN_KEY"

# e) voice surface — list seeded debtors (confirms VOICE_SECRET is live)
curl "$PROD_URL/voice/payers" -H "X-Voice-Secret: $VOICE_SECRET"
```

> Optional — voice demo without hardcoding a payerId: `/voice/tool` already defaults
> `"TARGET"`/omitted `payerId` to the first seeded payer (Dazza Fittings). To point it at
> someone else instead: `curl -X POST "$PROD_URL/admin/target" -H "Authorization: Bearer $ADMIN_KEY" -H "content-type: application/json" -d '{"payerId":"pyr_..."}'`.

### 5. Run smoke against production

```bash
BASE_URL="$PROD_URL" ADMIN_KEY="$ADMIN_KEY" npm run smoke
```

### 6. A2A demo (both scenarios)

```bash
export ANTHROPIC_API_KEY=<your-key>

# normal — $1,200, within limits, charge succeeds
BASE_URL="$PROD_URL" ADMIN_KEY="$ADMIN_KEY" ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  npx tsx agents/a2a.ts --scenario=normal

# blocked — $9,000, exceeds limit, Agent B relays the decline in natural language
BASE_URL="$PROD_URL" ADMIN_KEY="$ADMIN_KEY" ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  npx tsx agents/a2a.ts --scenario=blocked
```

> The daily limit is cumulative across runs. If `--scenario=normal` starts declining on
> the daily limit after several demo runs, re-seed (step 3) to reset the spend counter.

### 7. Outbound voice call demo (ElevenLabs)

```bash
curl -X POST "$PROD_URL/admin/call" \
  -H "Authorization: Bearer $ADMIN_KEY" -H "content-type: application/json" \
  -d '{"toNumber":"+614XXXXXXXX","payerId":"pyr_..."}'
```

Sets the target payer, primes the ElevenLabs agent's `dynamic_variables` (payer name,
overdue balance, oldest overdue item, today's date, the agent's own spending
authority) directly on the outbound-call request, and places the call.

### 8. Troubleshooting

| Symptom | Cause / Fix |
|---|---|
| Tool returns `no_grant` | Grant missing/stale → **re-seed** (step 3) |
| `401` on `/admin/*` | Wrong/missing `ADMIN_KEY` → check the `Authorization: Bearer` header matches the deployed secret |
| `charge_now` → "Bank Account required…" | Payer has no saved source → **re-seed** (or run `add_bank_account` for that payer first) |
| `/admin/recovered` empty / `$0.00` | Payments not settled yet → use sandbox time-travel to advance settlement, or scope with `?payerId=<pyr_...>` to include realtime charges |
| `GET /voice/payers` shows `$0` / duplicate names | An orphaned duplicate payer record from earlier testing — Pinch doesn't enforce payer-name uniqueness; find and cancel its scheduled payments directly |

### 9. Do NOT touch on demo day

- ❌ No dependency updates (`npm install`/`npm update` of anything)
- ❌ No refactors
- ❌ No new features
- ✅ Only fixes to a **broken demo path**, nothing else

## API reference

All `/admin/*` routes require `Authorization: Bearer <ADMIN_KEY>`. All `/voice/*`
routes require `X-Voice-Secret: <VOICE_SECRET>`. `POST /webhooks/pinch` is
authenticated via Pinch's own `pinch-signature` header, not a shared secret.
`/health` is open.

### `POST /admin/payers` — add a customer

```bash
curl -X POST "$PROD_URL/admin/payers" \
  -H "Authorization: Bearer $ADMIN_KEY" -H "content-type: application/json" \
  -d '{"name":"Kev Concreting","email":"kev@example.com","mobile":"0400111222"}'
# -> { "payerId": "pyr_...", "name": "Kev Concreting" }
```

### `POST /admin/invoices` — raise an invoice

A **past** `dueDate` is allowed on purpose — it's how you raise a demo invoice that's
already overdue.

```bash
curl -X POST "$PROD_URL/admin/invoices" \
  -H "Authorization: Bearer $ADMIN_KEY" -H "content-type: application/json" \
  -d '{"payerId":"pyr_...","amountCents":15000,"description":"Overdue callout","dueDate":"2026-07-01"}'
```

### `GET`/`POST /admin/target` — the demo target payer

Which payer `/voice/tool` resolves to when a voice script omits `payerId` or passes
the literal string `"TARGET"`.

```bash
curl "$PROD_URL/admin/target" -H "Authorization: Bearer $ADMIN_KEY"
curl -X POST "$PROD_URL/admin/target" \
  -H "Authorization: Bearer $ADMIN_KEY" -H "content-type: application/json" \
  -d '{"payerId":"pyr_..."}'
```

### `POST /admin/call` — trigger an outbound voice call

See [step 7 of the runbook](#7-outbound-voice-call-demo-elevenlabs) above.

### `GET /admin/payments/status` — counts by status

```bash
curl "$PROD_URL/admin/payments/status" -H "Authorization: Bearer $ADMIN_KEY"
# -> { "totalPayments": 22, "statuses": [
#       { "status": "scheduled", "count": 18, "totalCents": 412300, "totalDisplay": "$4,123.00" },
#       { "status": "transferred", "count": 4, "totalCents": 88000, "totalDisplay": "$880.00" } ] }
```

### `GET /admin/recovered` — settled-payments total

Sums `status === "transferred"` payments. Prefers the webhook-fed snapshot
(`source: "webhook-events"`) when one exists, falls back to a live Pinch scan
(`source: "live-scan"`) otherwise. Without `?payerId=`, the live-scan fallback walks
scheduled payments only (not realtime charges) — pass `?payerId=<pyr_...>` to include
a specific payer's `charge_now` results too.

### `POST /voice/tool` — generic tool invocation

Runs the exact same `tool.run → permissions.enforce()` path as MCP. Response
**always** carries a `speech` string. Body: `{ agentId, tool, params }` — `params`
may be nested or the body may be flat.

```bash
curl -X POST "$PROD_URL/voice/tool" \
  -H "X-Voice-Secret: $VOICE_SECRET" -H "content-type: application/json" \
  -d '{"agentId":"demo-agent","tool":"create_payment_plan","params":{
        "payerId":"pyr_...","totalAmountCents":240000,"instalments":4,
        "frequency":"fortnightly","startDate":"2026-07-25","description":"Overdue balance"}}'
```

Response shapes: success → `{ ok: true, result, speech }`; decline → `{ ok: false,
declined, speech }`; error → `{ ok: false, error, speech }`.

### `POST /voice/init` — ElevenLabs conversation-initiation webhook

Called by ElevenLabs before a call connects; returns `dynamic_variables` (payer name,
top overdue item, total overdue, days overdue, today's date, the agent's own
authority) for the agent's system prompt. Served from a 60-second KV cache (warmed by
`/admin/target` and `/admin/call`) so it responds well under ElevenLabs' latency
budget instead of waiting on a live Pinch fetch.

### `GET /voice/context/:payerId`, `GET /voice/payers`

Call-start context for a specific payer, and a list of seeded debtors with overdue
totals — see `src/voice.ts` for full response shapes.

### `POST /webhooks/pinch` — Pinch settlement events

Registered once via `POST https://api.getpinch.com.au/test/webhooks` (Pinch has no
dashboard UI for this — it's API-only: `{ uri, eventTypes? }`, returns a `whsec_...`
signing secret you store as `PINCH_WEBHOOK_SECRET`). Verifies the `pinch-signature`
header, writes a KV snapshot + audit entry for every event that references a payment.

## KV namespaces

| Binding | Key pattern | Purpose |
|---|---|---|
| `GRANTS` | `grant:<agentId>` | Agent authority records |
| `GRANTS` | `seedpayer:<name-slug>` | Name → stable payerId, so seed/reset reuse payers |
| `GRANTS` | `demo:targetPayerId` | The payerId `/voice/tool` resolves `"TARGET"` to |
| `GRANTS` | `init:context:<payerId>` | Cached `/voice/init` payload (60s TTL) |
| `GRANTS` | `pinch:event:<eventId>` | Webhook delivery dedup log |
| `GRANTS` | `pinch:payment:<paymentId>` | Latest settlement-status snapshot from webhooks |
| `SPEND` | `spend:<agentId>:<YYYY-MM-DD>` | Daily spend counters |
| `AUDIT` | `audit:<ISO-ts>:<rand>` | Append-only audit log (agent actions + webhook events) |
| `TOKENS` | `pinch:token` | Cached Pinch OAuth token |
| `IDEMPOTENCY` | `idem:plan:<sha256>` | `create_payment_plan` replay guard (10 min TTL) |

## Auth notes

- Pinch OAuth: `client_id` must be the **Application ID** (`app_...`), stored in
  `PINCH_PUBLISHABLE_KEY`. The publishable key (`pk_...`) and merchant ID are **not**
  valid for OAuth.
- Admin routes: `Authorization: Bearer <ADMIN_KEY>`.
- Voice routes: `X-Voice-Secret: <VOICE_SECRET>`.
- Pinch webhook: `pinch-signature: t=<unix_seconds>,v2=<hmac-sha256>` (verified, not a
  shared secret).
- MCP: `?agentId=<id>` query param or `x-agent-id` header.

## Hard rules

1. TypeScript strict + `noUncheckedIndexedAccess` — `tsc` must pass clean.
2. Amounts are always **integer cents** — never floats, never dollars in code paths.
3. Never log full bank account numbers — masked to last 3 digits everywhere.
4. All errors are structured objects — no raw stack traces to clients (every route
   handler call in the Worker entry point is `await`ed inside the outer try/catch,
   specifically so this holds for async exceptions too, not just synchronous ones).
5. Sandbox only — base URL is always `https://api.getpinch.com.au/test`.
