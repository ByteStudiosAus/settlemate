/**
 * Tests for the voice webhook surface (src/voice.ts). Same in-memory KV mock and
 * fetch-level Pinch stub as tools.test.ts. The voice layer runs the SAME
 * tool.run -> enforce() path as MCP, so these tests focus on what's voice-specific:
 * the X-Voice-Secret gate, the always-present `speech` string on success and on a
 * decline, and the flat-vs-nested params handling. Run: `npm run test:voice`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { handleVoice, INIT_BUILD_TIMEOUT_MS, warmVoiceInitCache } from "../src/voice";
import { TOOL_NAMES } from "../src/tools";
import type { Env, Grant } from "../src/types";
import { todayAU } from "../src/util";

// ── KV mock (mirrors tools.test.ts) ────────────────────────────────────────────

function makeKV(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed));
  const kv = {
    async get(key: string, type?: "text" | "json") {
      const raw = store.get(key);
      if (raw === undefined || raw === null) return null;
      return type === "json" ? JSON.parse(raw) : raw;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list(opts?: { prefix?: string }) {
      const prefix = opts?.prefix ?? "";
      const names = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      return { list_complete: true, keys: names.map((name) => ({ name })), cacheStatus: null };
    },
    _store: store,
  };
  return kv as unknown as KVNamespace & { _store: Map<string, string> };
}

function baseGrant(overrides: Partial<Grant> = {}): Grant {
  return {
    agentId: "demo-agent",
    name: "Demo Voice Agent",
    maxPerTransactionCents: 200_000, // $2,000
    maxDailyCents: 500_000, // $5,000
    allowedTools: [...TOOL_NAMES],
    active: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeEnv(grant?: Grant) {
  const env = {
    GRANTS: makeKV(grant ? { "grant:demo-agent": JSON.stringify(grant) } : {}),
    SPEND: makeKV(),
    AUDIT: makeKV(),
    TOKENS: makeKV({ "pinch:token": JSON.stringify({ access_token: "t", expires_at: 9e15 }) }),
    IDEMPOTENCY: makeKV(),
    PINCH_API_BASE: "https://api.getpinch.com.au/test",
    PINCH_AUTH_URL: "https://auth.getpinch.com.au/connect/token",
    PINCH_VERSION: "2020.1",
    ENABLE_TWILIO: "false",
    PINCH_SECRET_KEY: "sk_test_x",
    PINCH_PUBLISHABLE_KEY: "app_test_x",
    PINCH_MERCHANT_ID: "",
    ADMIN_KEY: "admin",
    VOICE_SECRET: "voice-secret",
  } as unknown as Env;
  return env;
}

function stubFetch(bodies: unknown[]) {
  const calls: Array<{ url: string; method: string; body: string | null }> = [];
  let i = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : null,
    });
    const body = bodies[Math.min(i, bodies.length - 1)];
    i++;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

/**
 * Stubs create_payment_plan's native Plan+Subscription flow (mirrors
 * tools.test.ts's stubPlanFlow): overdue GET, POST /plans, POST
 * /subscriptions, payment-id GET. Each step's status/body is overridable.
 */
function stubPlanFlow(opts: {
  overdue?: unknown[];
  planId?: string;
  planStatus?: number;
  planBody?: unknown;
  subscriptionId?: string;
  subscriptionStatus?: number;
  subscriptionBody?: unknown;
  generatedPayments?: unknown[];
} = {}) {
  const calls: Array<{ url: string; method: string; body: string | null }> = [];
  let overdueCallsSeen = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const bodyStr = typeof init?.body === "string" ? init.body : null;
    const url = new URL(String(input));
    calls.push({ url: url.pathname, method, body: bodyStr });
    const json = (obj: unknown, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

    if (method === "DELETE") return json({});

    if (method === "GET" && url.pathname.includes("/payments/payer/")) {
      overdueCallsSeen++;
      return overdueCallsSeen === 1 ? json(opts.overdue ?? []) : json(opts.generatedPayments ?? []);
    }
    if (method === "POST" && url.pathname.endsWith("/plans")) {
      return json(
        opts.planBody ?? { id: opts.planId ?? "pln_test", ...(bodyStr ? JSON.parse(bodyStr) : {}) },
        opts.planStatus ?? 201,
      );
    }
    if (method === "POST" && url.pathname.endsWith("/subscriptions")) {
      return json(
        opts.subscriptionBody ?? { id: opts.subscriptionId ?? "sub_test", status: "active" },
        opts.subscriptionStatus ?? 201,
      );
    }
    return json({});
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

/** Like stubFetch, but every response only resolves after `delayMs` — simulates a slow Pinch. */
function stubFetchDelayed(bodies: unknown[], delayMs: number) {
  const calls: Array<{ url: string; method: string; body: string | null }> = [];
  let i = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : null,
    });
    const body = bodies[Math.min(i, bodies.length - 1)];
    i++;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

/** Fake ExecutionContext: records waitUntil promises so the test can await them. */
function fakeExecutionContext() {
  const pending: Array<Promise<unknown>> = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } };
  return { ctx: ctx as unknown as ExecutionContext, drain: () => Promise.all(pending) };
}

const SECRET = { "x-voice-secret": "voice-secret" };

function req(
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: unknown } = {},
): Request {
  const init: RequestInit = { method, headers: opts.headers };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  return new Request(`https://worker.example${path}`, init);
}

// ── auth: 401 without the secret ────────────────────────────────────────────────

test("POST /voice/tool without X-Voice-Secret -> 401 structured unauthorized", async () => {
  const env = makeEnv(baseGrant());
  const res = await handleVoice(
    req("POST", "/voice/tool", { body: { agentId: "demo-agent", tool: "get_agent_limits" } }),
    env,
  );
  assert.equal(res.status, 401);
  const body = (await res.json()) as { error: boolean; code: string };
  assert.equal(body.error, true);
  assert.equal(body.code, "unauthorized");
});

test("wrong X-Voice-Secret -> 401", async () => {
  const env = makeEnv(baseGrant());
  const res = await handleVoice(
    req("POST", "/voice/tool", {
      headers: { "x-voice-secret": "nope" },
      body: { agentId: "demo-agent", tool: "get_agent_limits" },
    }),
    env,
  );
  assert.equal(res.status, 401);
});

// ── success: create_payment_plan speech contains the instalment amount ─────────

test("successful create_payment_plan returns a speech string with the instalment amount", async () => {
  const env = makeEnv(baseGrant());
  // 4 fortnightly instalments of $600 -> 240000 / 4 = 60000 each, via ONE
  // native plan + subscription.
  const fx = stubPlanFlow();
  try {
    const res = await handleVoice(
      req("POST", "/voice/tool", {
        headers: SECRET,
        body: {
          agentId: "demo-agent",
          tool: "create_payment_plan",
          params: {
            payerId: "pyr_1",
            totalAmountCents: 240_000,
            instalments: 4,
            frequency: "fortnightly",
            startDate: "2026-08-01",
            description: "Overdue balance",
          },
        },
      }),
      env,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; speech: string };
    assert.equal(body.ok, true);
    assert.ok(typeof body.speech === "string" && body.speech.length > 0);
    assert.ok(body.speech.includes("$600.00"), `speech should name the instalment amount: "${body.speech}"`);
    assert.ok(body.speech.includes("4 fortnightly"), `speech should describe the cadence: "${body.speech}"`);
  } finally {
    fx.restore();
  }
});

// ── decline: speech contains the limit ──────────────────────────────────────────

test("declined call returns a speech string containing the limit", async () => {
  // Per-transaction limit $2,000; a single $9,000 charge is over it.
  const env = makeEnv(baseGrant());
  const fx = stubFetch([{ id: "should_not_be_used" }]);
  try {
    const res = await handleVoice(
      req("POST", "/voice/tool", {
        headers: SECRET,
        body: {
          agentId: "demo-agent",
          tool: "charge_now",
          params: { payerId: "pyr_1", amountCents: 900_000, description: "Too big" },
        },
      }),
      env,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; declined?: { reason: string }; speech: string };
    assert.equal(body.ok, false);
    assert.equal(body.declined?.reason, "exceeds_per_transaction_limit");
    assert.ok(body.speech.includes("$2,000.00"), `speech should name the limit: "${body.speech}"`);
    // Nothing was charged.
    assert.equal(fx.calls.length, 0);
  } finally {
    fx.restore();
  }
});

// ── flat body: params inferred from top-level fields ────────────────────────────

test("POST /voice/tool accepts a FLAT body (no nested params)", async () => {
  const env = makeEnv(baseGrant());
  const fx = stubFetch([{ id: "pmt_flat", status: "scheduled" }]);
  try {
    const res = await handleVoice(
      req("POST", "/voice/tool", {
        headers: SECRET,
        body: {
          agentId: "demo-agent",
          tool: "create_invoice",
          // No `params` wrapper — these are top-level.
          payerId: "pyr_1",
          amountCents: 45_000,
          dueDate: "2026-08-10",
          description: "Flat body invoice",
        },
      }),
      env,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; speech: string };
    assert.equal(body.ok, true);
    assert.ok(body.speech.includes("$450.00"), `speech should name the amount: "${body.speech}"`);
    // Reached Pinch with the inferred params.
    assert.equal(fx.calls.length, 1);
    const sent = JSON.parse(fx.calls[0]!.body!) as { amount: number };
    assert.equal(sent.amount, 45_000);
  } finally {
    fx.restore();
  }
});

// ── GET /voice/context/:payerId ────────────────────────────────────────────────

test("GET /voice/context/:payerId returns name, natural date, overdue invoices, limits", async () => {
  const env = makeEnv(baseGrant());
  // Real sandbox shapes: payer nested under `payer`, transactionDate is a full
  // ISO datetime (NOT bare YYYY-MM-DD), no top-level payerId.
  // 1st fetch: GET /payers/{id}. 2nd: GET /payments/payer/{id} (bare array).
  const fx = stubFetch([
    { id: "pyr_1", firstName: "Dazza", lastName: "Fittings" },
    [
      {
        id: "pmt_1",
        status: "scheduled",
        amount: 45000,
        transactionDate: "2026-07-10T14:00:00.0000000Z",
        description: "Hot water",
        payer: { id: "pyr_1", firstName: "Dazza", lastName: "Fittings" },
      },
      {
        id: "pmt_2",
        status: "scheduled",
        amount: 12000,
        transactionDate: "2027-01-01T14:00:00.0000000Z",
        description: "Future",
        payer: { id: "pyr_1", firstName: "Dazza", lastName: "Fittings" },
      },
    ],
  ]);
  try {
    const res = await handleVoice(req("GET", "/voice/context/pyr_1", { headers: SECRET }), env);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      payerName: string;
      todayAU: string;
      invoices: Array<{ paymentId: string; amountDisplay: string; dueDate: string; daysOverdue: number }>;
      totalOverdueDisplay: string;
      agentLimits: { maxPerTransactionDisplay: string; remainingTodayDisplay: string };
    };
    assert.equal(body.payerName, "Dazza Fittings");
    assert.ok(body.todayAU.length > 0);
    // Only the past-dated scheduled payment is overdue.
    assert.equal(body.invoices.length, 1);
    assert.equal(body.invoices[0]!.paymentId, "pmt_1");
    assert.equal(body.invoices[0]!.amountDisplay, "$450.00");
    // The ISO datetime is normalised to a bare YYYY-MM-DD, and daysOverdue is a real number.
    assert.equal(body.invoices[0]!.dueDate, "2026-07-10");
    assert.ok(Number.isFinite(body.invoices[0]!.daysOverdue) && body.invoices[0]!.daysOverdue > 0);
    assert.equal(body.totalOverdueDisplay, "$450.00");
    assert.equal(body.agentLimits.maxPerTransactionDisplay, "$2,000.00");
  } finally {
    fx.restore();
  }
});

// ── GET /voice/payers ────────────────────────────────────────────────────────────

test("GET /voice/payers groups by embedded payer.id (regression: real sandbox shape)", async () => {
  const env = makeEnv(baseGrant());
  // The scheduled list embeds the payer under `payer` — there is NO top-level
  // `payerId`, and transactionDate is a full ISO datetime. A single page here,
  // and no per-payer GET (the name comes off the embedded object).
  const fx = stubFetch([
    {
      data: [
        {
          id: "pmt_1",
          status: "scheduled",
          amount: 45000,
          transactionDate: "2026-07-10T14:00:00.0000000Z",
          payer: { id: "pyr_1", firstName: "Dazza", lastName: "Fittings" },
        },
        {
          id: "pmt_2",
          status: "scheduled",
          amount: 12000,
          transactionDate: "2027-01-01T14:00:00.0000000Z",
          payer: { id: "pyr_1", firstName: "Dazza", lastName: "Fittings" },
        },
        {
          id: "pmt_3",
          status: "scheduled",
          amount: 88000,
          transactionDate: "2026-07-01T14:00:00.0000000Z",
          payer: { id: "pyr_2", firstName: "Shazza", lastName: "Sparks" },
        },
      ],
      page: 1,
      pageSize: 100,
      totalPages: 1,
      totalItems: 3,
    },
  ]);
  try {
    const res = await handleVoice(req("GET", "/voice/payers", { headers: SECRET }), env);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      count: number;
      payers: Array<{ id: string; name: string; totalOverdueDisplay: string }>;
    };
    // The bug: this was 0 because grouping keyed on p.payerId (absent).
    assert.equal(body.count, 2);
    assert.equal(body.payers[0]!.id, "pyr_1");
    assert.equal(body.payers[0]!.name, "Dazza Fittings");
    assert.equal(body.payers[0]!.totalOverdueDisplay, "$450.00"); // only the overdue one
    assert.equal(body.payers[1]!.id, "pyr_2");
    assert.equal(body.payers[1]!.name, "Shazza Sparks");
    assert.equal(body.payers[1]!.totalOverdueDisplay, "$880.00");
    // No per-payer GET was needed — one list call only.
    assert.equal(fx.calls.length, 1);
  } finally {
    fx.restore();
  }
});

test("GET /voice/payers sums correctly for payments generated by a native Plan+Subscription (real sandbox shape)", async () => {
  // Regression guard for a reported bug: after create_payment_plan moved from
  // N individual POST /payments to ONE Pinch Plan + Subscription, /voice/payers
  // appeared to show $0 for seeded debtors. Verified LIVE against the sandbox
  // that this was NOT actually an endpoint/shape problem: subscription-
  // generated payments show up in GET /payments/scheduled with the IDENTICAL
  // payer.{id,firstName,lastName} shape as directly-created ones — they just
  // carry an extra `subscription: {id,planId,planName}` object, which this
  // grouping logic already ignores. The real bug was unrelated stale/orphaned
  // duplicate payer records in the sandbox (Pinch does NOT enforce payer-name
  // uniqueness) — this test locks in that the overdue-walk itself handles the
  // native-plan shape correctly.
  const env = makeEnv(baseGrant());
  const fx = stubFetch([
    {
      data: [
        {
          id: "pmt_plan1",
          status: "scheduled",
          amount: 14250,
          transactionDate: "2026-07-10T14:00:00.0000000Z",
          description: "Overdue balance — agreed payment plan (instalment 1/4)",
          payer: { id: "pyr_1", firstName: "Dazza", lastName: "Fittings" },
          subscription: { id: "sub_abc123", planId: "pln_abc123", planName: "Overdue balance (pyr_1)" },
        },
        {
          id: "pmt_plan2",
          status: "scheduled",
          amount: 14250,
          transactionDate: "2026-08-10T14:00:00.0000000Z", // future — not overdue
          description: "Overdue balance — agreed payment plan (instalment 2/4)",
          payer: { id: "pyr_1", firstName: "Dazza", lastName: "Fittings" },
          subscription: { id: "sub_abc123", planId: "pln_abc123", planName: "Overdue balance (pyr_1)" },
        },
      ],
      page: 1,
      pageSize: 100,
      totalPages: 1,
      totalItems: 2,
    },
  ]);
  try {
    const res = await handleVoice(req("GET", "/voice/payers", { headers: SECRET }), env);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      count: number;
      payers: Array<{ id: string; name: string; totalOverdueCents: number; totalOverdueDisplay: string }>;
    };
    assert.equal(body.count, 1);
    assert.equal(body.payers[0]!.id, "pyr_1");
    assert.equal(body.payers[0]!.name, "Dazza Fittings");
    // Only the overdue (past-dated) instalment counts — the future one doesn't.
    assert.equal(body.payers[0]!.totalOverdueCents, 14250);
    assert.equal(body.payers[0]!.totalOverdueDisplay, "$142.50");
  } finally {
    fx.restore();
  }
});

// ── demo target payer resolution ────────────────────────────────────────────────

test("/voice/tool with payerId omitted resolves the explicit demo target", async () => {
  const env = makeEnv(baseGrant());
  await env.GRANTS.put("demo:targetPayerId", "pyr_target1");
  const fx = stubFetch([{ id: "pmt_t1", status: "scheduled" }]);
  try {
    const res = await handleVoice(
      req("POST", "/voice/tool", {
        headers: SECRET,
        body: {
          agentId: "demo-agent",
          tool: "create_invoice",
          params: { amountCents: 5000, dueDate: "2026-08-01", description: "No payerId given" },
        },
      }),
      env,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean };
    assert.equal(body.ok, true);
    const sent = JSON.parse(fx.calls[0]!.body!) as { payerId: string };
    assert.equal(sent.payerId, "pyr_target1");
  } finally {
    fx.restore();
  }
});

test('/voice/tool with payerId "TARGET" resolves the explicit demo target', async () => {
  const env = makeEnv(baseGrant());
  await env.GRANTS.put("demo:targetPayerId", "pyr_target2");
  const fx = stubFetch([{ id: "pmt_t2", status: "scheduled" }]);
  try {
    const res = await handleVoice(
      req("POST", "/voice/tool", {
        headers: SECRET,
        body: {
          agentId: "demo-agent",
          tool: "create_invoice",
          params: {
            payerId: "TARGET",
            amountCents: 5000,
            dueDate: "2026-08-01",
            description: "Explicit TARGET",
          },
        },
      }),
      env,
    );
    assert.equal(res.status, 200);
    const sent = JSON.parse(fx.calls[0]!.body!) as { payerId: string };
    assert.equal(sent.payerId, "pyr_target2");
  } finally {
    fx.restore();
  }
});

test('/voice/tool falls back to the first seeded payer when no explicit target is set', async () => {
  const env = makeEnv(baseGrant());
  // Simulates the seed registry: DEMO_PAYERS[0] is "Dazza Fittings" -> slug "dazza-fittings".
  await env.GRANTS.put("seedpayer:dazza-fittings", "pyr_seed_dazza");
  const fx = stubFetch([{ id: "pmt_t3", status: "scheduled" }]);
  try {
    const res = await handleVoice(
      req("POST", "/voice/tool", {
        headers: SECRET,
        body: {
          agentId: "demo-agent",
          tool: "create_invoice",
          params: { amountCents: 5000, dueDate: "2026-08-01", description: "No target set" },
        },
      }),
      env,
    );
    assert.equal(res.status, 200);
    const sent = JSON.parse(fx.calls[0]!.body!) as { payerId: string };
    assert.equal(sent.payerId, "pyr_seed_dazza");
  } finally {
    fx.restore();
  }
});

test("/voice/tool with an explicit payerId is left untouched even when a target is set", async () => {
  const env = makeEnv(baseGrant());
  await env.GRANTS.put("demo:targetPayerId", "pyr_target_ignored");
  const fx = stubFetch([{ id: "pmt_explicit", status: "scheduled" }]);
  try {
    await handleVoice(
      req("POST", "/voice/tool", {
        headers: SECRET,
        body: {
          agentId: "demo-agent",
          tool: "create_invoice",
          params: {
            payerId: "pyr_explicit",
            amountCents: 5000,
            dueDate: "2026-08-01",
            description: "Explicit payer",
          },
        },
      }),
      env,
    );
    const sent = JSON.parse(fx.calls[0]!.body!) as { payerId: string };
    assert.equal(sent.payerId, "pyr_explicit");
  } finally {
    fx.restore();
  }
});

test('/voice/tool with payerId "TARGET" and nothing to resolve returns a speakable error', async () => {
  const env = makeEnv(baseGrant());
  const res = await handleVoice(
    req("POST", "/voice/tool", {
      headers: SECRET,
      body: {
        agentId: "demo-agent",
        tool: "create_invoice",
        params: {
          payerId: "TARGET",
          amountCents: 5000,
          dueDate: "2026-08-01",
          description: "Nothing to resolve",
        },
      },
    }),
    env,
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; error?: { code: string }; speech: string };
  assert.equal(body.ok, false);
  assert.equal(body.error?.code, "no_target_payer");
  assert.ok(body.speech.length > 0);
});

// ── POST /voice/init (ElevenLabs conversation initiation webhook) ─────────────

test("POST /voice/init without X-Voice-Secret -> 401", async () => {
  const env = makeEnv(baseGrant());
  const res = await handleVoice(req("POST", "/voice/init", { body: {} }), env);
  assert.equal(res.status, 401);
});

test("POST /voice/init resolves the target payer and returns ElevenLabs' initiation shape", async () => {
  const env = makeEnv(baseGrant());
  await env.GRANTS.put("demo:targetPayerId", "pyr_1");
  // 1st fetch: GET /payers/{id}. 2nd: GET /payments/payer/{id} (bare array).
  const fx = stubFetch([
    { id: "pyr_1", firstName: "Dazza", lastName: "Fittings" },
    [
      {
        id: "pmt_1",
        status: "scheduled",
        amount: 45000,
        transactionDate: "2026-07-10T14:00:00.0000000Z",
        description: "Hot water",
        payer: { id: "pyr_1", firstName: "Dazza", lastName: "Fittings" },
      },
      {
        id: "pmt_2",
        status: "dishonoured",
        amount: 12000,
        transactionDate: "2026-06-01T14:00:00.0000000Z",
        description: "Older invoice",
        payer: { id: "pyr_1", firstName: "Dazza", lastName: "Fittings" },
      },
    ],
  ]);
  try {
    // ElevenLabs' own POST body — call metadata we don't need, agentId comes off the query string.
    const res = await handleVoice(
      req("POST", "/voice/init?agentId=demo-agent", {
        headers: SECRET,
        body: { caller_id: "+61400000000", agent_id: "agent_xyz", called_number: "+61299999999", call_sid: "CA123" },
      }),
      env,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      type: string;
      dynamic_variables: {
        payer_name: string;
        invoice_description: string;
        total_overdue: string;
        days_overdue: number;
        today_au: string;
        agent_limits: string;
      };
    };
    assert.equal(body.type, "conversation_initiation_client_data");
    const dv = body.dynamic_variables;
    assert.equal(dv.payer_name, "Dazza Fittings");
    // The older (dishonoured) invoice is the "top" overdue item — it has more days overdue.
    assert.equal(dv.invoice_description, "Older invoice");
    assert.equal(dv.total_overdue, "$570.00");
    assert.ok(dv.days_overdue > 0);
    assert.ok(dv.today_au.length > 0);
    assert.ok(dv.agent_limits.includes("$2,000.00"));
    assert.ok(dv.agent_limits.includes("$5,000.00"));
  } finally {
    fx.restore();
  }
});

test("POST /voice/init falls back to safe defaults when no target payer is set", async () => {
  const env = makeEnv(baseGrant());
  const res = await handleVoice(
    req("POST", "/voice/init", { headers: SECRET, body: {} }),
    env,
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { type: string; dynamic_variables: Record<string, unknown> };
  assert.equal(body.type, "conversation_initiation_client_data");
  assert.equal(body.dynamic_variables.payer_name, "");
  assert.equal(body.dynamic_variables.total_overdue, "$0.00");
  assert.equal(body.dynamic_variables.days_overdue, 0);
  assert.equal(typeof body.dynamic_variables.invoice_description, "string");
});

test("POST /voice/init falls back to safe defaults when Pinch fails, never leaking a raw error", async () => {
  const env = makeEnv(baseGrant());
  await env.GRANTS.put("demo:targetPayerId", "pyr_1");
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify({ errors: [{ message: "boom" }] }), { status: 500 });
  }) as typeof fetch;
  try {
    const res = await handleVoice(
      req("POST", "/voice/init", { headers: SECRET, body: {} }),
      env,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { type: string; dynamic_variables: Record<string, unknown> };
    assert.equal(body.type, "conversation_initiation_client_data");
    assert.equal(body.dynamic_variables.payer_name, "");
    assert.equal(body.dynamic_variables.total_overdue, "$0.00");
  } finally {
    globalThis.fetch = original;
  }
});

// ── POST /voice/init caching + speed ────────────────────────────────────────────

test("POST /voice/init serves a warm cache instantly, with ZERO fetch calls", async () => {
  const env = makeEnv(baseGrant());
  await env.GRANTS.put("demo:targetPayerId", "pyr_1");

  // Warm the cache exactly as admin.ts does, via a normal (unstubbed-timeout) fetch.
  const warmFx = stubFetch([
    { id: "pyr_1", firstName: "Dazza", lastName: "Fittings" },
    [
      {
        id: "pmt_1",
        status: "scheduled",
        amount: 45000,
        transactionDate: "2026-07-10T14:00:00.0000000Z",
        description: "Hot water",
        payer: { id: "pyr_1", firstName: "Dazza", lastName: "Fittings" },
      },
    ],
  ]);
  await warmVoiceInitCache(env, "pyr_1");
  warmFx.restore();

  // Now hit /voice/init with fetch stubbed to THROW if called at all — a cache
  // hit must never touch the network.
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("network should not be reached on a cache hit");
  }) as typeof fetch;
  try {
    const started = Date.now();
    const res = await handleVoice(req("POST", "/voice/init", { headers: SECRET, body: {} }), env);
    const elapsedMs = Date.now() - started;
    assert.equal(res.status, 200);
    const body = (await res.json()) as { dynamic_variables: { payer_name: string; invoice_description: string } };
    assert.equal(body.dynamic_variables.payer_name, "Dazza Fittings");
    assert.equal(body.dynamic_variables.invoice_description, "Hot water");
    assert.ok(elapsedMs < 100, `cache hit should be near-instant, took ${elapsedMs}ms`);
  } finally {
    globalThis.fetch = original;
  }
});

test("POST /voice/init on a cold build reuses the cached Pinch OAuth token — no auth call", async () => {
  const env = makeEnv(baseGrant());
  await env.GRANTS.put("demo:targetPayerId", "pyr_1");
  // TOKENS already seeded with a valid (unexpired) token in makeEnv.
  const fx = stubFetch([
    { id: "pyr_1", firstName: "Dazza", lastName: "Fittings" },
    [],
  ]);
  try {
    const res = await handleVoice(req("POST", "/voice/init", { headers: SECRET, body: {} }), env);
    assert.equal(res.status, 200);
    assert.equal(fx.calls.length, 2, "expected exactly getPayer + listPaymentsForPayer, no OAuth call");
    assert.ok(
      fx.calls.every((c) => !c.url.includes("/connect/token")),
      "should not re-fetch an OAuth token when a valid one is already cached",
    );
  } finally {
    fx.restore();
  }
});

test("POST /voice/init falls back to placeholders within the latency budget when Pinch is slow, then caches the finished build for next time", async () => {
  const env = makeEnv(baseGrant());
  await env.GRANTS.put("demo:targetPayerId", "pyr_1");
  const SLOW_MS = INIT_BUILD_TIMEOUT_MS + 200;
  const fx = stubFetchDelayed(
    [
      { id: "pyr_1", firstName: "Dazza", lastName: "Fittings" },
      [
        {
          id: "pmt_1",
          status: "scheduled",
          amount: 45000,
          transactionDate: "2026-07-10T14:00:00.0000000Z",
          description: "Hot water",
          payer: { id: "pyr_1", firstName: "Dazza", lastName: "Fittings" },
        },
      ],
    ],
    SLOW_MS,
  );
  const { ctx, drain } = fakeExecutionContext();
  try {
    const started = Date.now();
    const res = await handleVoice(
      req("POST", "/voice/init", { headers: SECRET, body: {} }),
      env,
      ctx,
    );
    const elapsedMs = Date.now() - started;
    assert.equal(res.status, 200);
    assert.ok(
      elapsedMs < INIT_BUILD_TIMEOUT_MS + 150,
      `should answer within the latency budget, took ${elapsedMs}ms`,
    );
    const body = (await res.json()) as { type: string; dynamic_variables: { payer_name: string } };
    assert.equal(body.type, "conversation_initiation_client_data");
    // Lost the race -> safe placeholder, not the real (still in-flight) name.
    assert.equal(body.dynamic_variables.payer_name, "");

    // Let the background build (wrapped in ctx.waitUntil) finish and cache.
    await drain();

    // A second call now hits the warm cache: fast, correct, zero extra fetches.
    const before = fx.calls.length;
    const started2 = Date.now();
    const res2 = await handleVoice(req("POST", "/voice/init", { headers: SECRET, body: {} }), env);
    const elapsed2Ms = Date.now() - started2;
    const body2 = (await res2.json()) as { dynamic_variables: { payer_name: string } };
    assert.equal(body2.dynamic_variables.payer_name, "Dazza Fittings");
    assert.ok(elapsed2Ms < 100, `warm cache should be near-instant, took ${elapsed2Ms}ms`);
    assert.equal(fx.calls.length, before, "second call should be served from cache, no new fetches");
  } finally {
    fx.restore();
  }
});

// ── create_payment_plan guardrails: speakable clarifications ──────────────────

/** `ymd` shifted by `days` (UTC-noon anchored, mirrors util.ts's own date maths). */
function ymdOffset(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d, 12));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

test("create_payment_plan with a backdated startDate returns a speakable ask-to-reschedule", async () => {
  const env = makeEnv(baseGrant());
  const fx = stubFetch([{ id: "should_not_be_used" }]);
  try {
    const res = await handleVoice(
      req("POST", "/voice/tool", {
        headers: SECRET,
        body: {
          agentId: "demo-agent",
          tool: "create_payment_plan",
          params: {
            payerId: "pyr_1",
            totalAmountCents: 6_000,
            instalments: 2,
            frequency: "weekly",
            startDate: ymdOffset(todayAU(), -1),
            description: "Backdated",
          },
        },
      }),
      env,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; error?: { code: string }; speech: string };
    assert.equal(body.ok, false);
    assert.equal(body.error?.code, "invalid_start_date");
    assert.ok(body.speech.toLowerCase().includes("today"), `speech should offer to start today: "${body.speech}"`);
    assert.equal(fx.calls.length, 0);
  } finally {
    fx.restore();
  }
});

test("create_payment_plan with a mismatched total returns a speakable clarification naming both figures", async () => {
  const env = makeEnv(baseGrant({ maxPerTransactionCents: 200_000, maxDailyCents: 500_000 }));
  // Real overdue balance $880 (Shazza's switchboard invoice); requested plan is $570.
  const fx = stubFetch([
    [
      {
        id: "pmt_switchboard",
        status: "dishonoured",
        amount: 88_000,
        transactionDate: "2026-06-01T00:00:00.0000000Z",
      },
    ],
  ]);
  try {
    const res = await handleVoice(
      req("POST", "/voice/tool", {
        headers: SECRET,
        body: {
          agentId: "demo-agent",
          tool: "create_payment_plan",
          params: {
            payerId: "pyr_shazza",
            totalAmountCents: 57_000,
            instalments: 2,
            frequency: "weekly",
            startDate: todayAU(),
            description: "Wrong amount",
          },
        },
      }),
      env,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; error?: { code: string }; speech: string };
    assert.equal(body.ok, false);
    assert.equal(body.error?.code, "plan_total_mismatch");
    assert.ok(body.speech.includes("$570.00"), `speech should name the plan total: "${body.speech}"`);
    assert.ok(body.speech.includes("$880.00"), `speech should name the actual balance: "${body.speech}"`);
    assert.ok(body.speech.includes("full amount"), `speech should offer the full-amount alternative: "${body.speech}"`);
  } finally {
    fx.restore();
  }
});

test("create_payment_plan whose subscription fails to create returns a speakable failure", async () => {
  const env = makeEnv(baseGrant());
  const fx = stubPlanFlow({
    subscriptionStatus: 400,
    subscriptionBody: { errors: [{ message: "Simulated subscription failure" }] },
  });
  try {
    const res = await handleVoice(
      req("POST", "/voice/tool", {
        headers: SECRET,
        body: {
          agentId: "demo-agent",
          tool: "create_payment_plan",
          params: {
            payerId: "pyr_1",
            totalAmountCents: 30_000,
            instalments: 3,
            frequency: "weekly",
            startDate: todayAU(),
            description: "Will fail",
          },
        },
      }),
      env,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; error?: { code: string }; speech: string };
    assert.equal(body.ok, false);
    assert.equal(body.error?.code, "plan_creation_failed");
    assert.ok(body.speech.includes("nothing was scheduled"), `speech should be honest that nothing survived: "${body.speech}"`);
  } finally {
    fx.restore();
  }
});

// ── unknown tool still yields a speakable response ──────────────────────────────

test("unknown tool returns ok:false with a speech string, not a thrown error", async () => {
  const env = makeEnv(baseGrant());
  const res = await handleVoice(
    req("POST", "/voice/tool", {
      headers: SECRET,
      body: { agentId: "demo-agent", tool: "not_a_real_tool", params: {} },
    }),
    env,
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; speech: string };
  assert.equal(body.ok, false);
  assert.ok(typeof body.speech === "string" && body.speech.length > 0);
});
