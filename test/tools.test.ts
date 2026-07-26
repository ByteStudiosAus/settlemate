/**
 * Tests for the agent-facing tool layer. Pinch is stubbed at the `fetch` level
 * (the tools call the real pinch.ts client, which we point at a fake). KV is the
 * same in-memory mock shape used by the permissions tests. Run: `npm run test:tools`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { getTool, inputJsonSchema, TOOL_NAMES, TOOLS } from "../src/tools";
import { isDeclined, isStructuredError } from "../src/types";
import type { Env, Grant } from "../src/types";
import { formatCents, todayAU } from "../src/util";

// ── formatCents (human edge) ──────────────────────────────────────────────────

test("formatCents renders integer cents as AUD", () => {
  assert.equal(formatCents(1245), "$12.45");
  assert.equal(formatCents(0), "$0.00");
  assert.equal(formatCents(5), "$0.05");
  assert.equal(formatCents(100000), "$1,000.00");
  assert.equal(formatCents(-1245), "-$12.45");
});

// ── the registry is exactly the nine spec'd tools ─────────────────────────────

test("exactly the nine agent-facing tools are registered", () => {
  assert.deepEqual(
    [...TOOL_NAMES].sort(),
    [
      "add_bank_account",
      "cancel_payment_plan",
      "charge_now",
      "check_payment_status",
      "create_invoice",
      "create_payer",
      "create_payment_plan",
      "get_agent_limits",
      "list_overdue",
    ],
  );
});

test("no raw endpoint wrappers leak into the tool surface", () => {
  // Names an agent must never see (raw pinch.ts wrappers stay internal).
  const forbidden = ["getPayment", "listEvents", "getEvent", "listScheduledPayments"];
  for (const name of forbidden) assert.equal(getTool(name), undefined);
});

test("every tool has an LLM description and a derivable JSON Schema", () => {
  for (const t of TOOLS) {
    assert.ok(t.description.length > 40, `${t.name} needs a real description`);
    const schema = inputJsonSchema(t) as { type?: string };
    assert.equal(schema.type, "object", `${t.name} schema should be an object`);
  }
});

// ── KV mock + env (mirrors permissions.test.ts) ───────────────────────────────

function makeKV(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed));
  const puts: Array<{ key: string; value: string }> = [];
  const kv = {
    async get(key: string, type?: "text" | "json") {
      const raw = store.get(key);
      if (raw === undefined || raw === null) return null;
      return type === "json" ? JSON.parse(raw) : raw;
    },
    async put(key: string, value: string) {
      store.set(key, value);
      puts.push({ key, value });
    },
    async delete(key: string) {
      store.delete(key);
    },
    _store: store,
    _puts: puts,
  };
  return kv as unknown as KVNamespace & {
    _store: Map<string, string>;
    _puts: Array<{ key: string; value: string }>;
  };
}

function baseGrant(overrides: Partial<Grant> = {}): Grant {
  return {
    agentId: "agent-1",
    name: "Test Agent",
    maxPerTransactionCents: 10_000,
    maxDailyCents: 50_000,
    allowedTools: [...TOOL_NAMES],
    active: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeEnv(grant?: Grant) {
  const grants = makeKV(grant ? { "grant:agent-1": JSON.stringify(grant) } : {});
  const spend = makeKV();
  const audit = makeKV();
  const env = {
    GRANTS: grants,
    SPEND: spend,
    AUDIT: audit,
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
    VOICE_SECRET: "voice",
  } as unknown as Env;
  return { env, grants, spend, audit };
}

/** Stub global fetch; return one canned JSON body per call, recording requests. */
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
 * Stubs the native Plan+Subscription flow create_payment_plan uses:
 *   GET  /payments/payer/{id}  — overdue sanity check (1st call to this URL)
 *   POST /plans                — create the plan
 *   POST /subscriptions        — bind it to the payer
 *   GET  /payments/payer/{id}  — look up the generated payment ids (2nd+ call)
 * DELETE always succeeds (plan/subscription cleanup or cancel_payment_plan).
 * Each step's status/body is overridable so tests can simulate a failure at
 * any point in the flow.
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

const CTX = (env: Env) => ({ env, agentId: "agent-1" });

// ── create_payment_plan: split with remainder on the last instalment ──────────

test("create_payment_plan splits total, remainder on final instalment, sums exactly", async () => {
  const { env } = makeEnv(baseGrant());
  const fx = stubPlanFlow({
    subscriptionId: "sub_split",
    generatedPayments: [
      { id: "pmt_1", subscription: { id: "sub_split" }, description: "Test plan (instalment 1/3)" },
      { id: "pmt_2", subscription: { id: "sub_split" }, description: "Test plan (instalment 2/3)" },
      { id: "pmt_3", subscription: { id: "sub_split" }, description: "Test plan (instalment 3/3)" },
    ],
  });
  try {
    const plan = getTool("create_payment_plan")!;
    const res = (await plan.run(CTX(env), {
      payerId: "pyr_1",
      totalAmountCents: 10_000,
      instalments: 3,
      frequency: "weekly",
      startDate: "2026-08-01",
      description: "Test plan",
    })) as {
      schedule: Array<{ amountCents: number; date: string; paymentId?: string }>;
      totalAmountCents: number;
      planId: string;
      subscriptionId: string;
    };
    assert.ok(!isDeclined(res) && !isStructuredError(res));
    const amounts = res.schedule.map((s) => s.amountCents);
    assert.deepEqual(amounts, [3333, 3333, 3334]);
    assert.equal(amounts.reduce((a, b) => a + b, 0), res.totalAmountCents);
    // weekly cadence, 3 dates a week apart
    assert.deepEqual(
      res.schedule.map((s) => s.date),
      ["2026-08-01", "2026-08-08", "2026-08-15"],
    );
    assert.deepEqual(
      res.schedule.map((s) => s.paymentId),
      ["pmt_1", "pmt_2", "pmt_3"],
    );
    assert.equal(res.subscriptionId, "sub_split");

    // ONE Pinch round trip per logical step regardless of instalment count:
    // overdue GET, POST /plans, POST /subscriptions, payment-id GET.
    assert.equal(fx.calls.length, 4);

    // The plan carries the EXACT per-instalment amounts (remainder preserved)
    // as day offsets from the subscription's startDate — not a single
    // repeating amount (Pinch's recurringPayment can't represent a remainder).
    const planCall = fx.calls.find((c) => c.method === "POST" && c.url.endsWith("/plans"))!;
    const planBody = JSON.parse(planCall.body!) as {
      fixedPayments: Array<{ amountInCents: number; scheduledDateOffset: number; scheduledDateInterval: string }>;
    };
    assert.deepEqual(planBody.fixedPayments.map((f) => f.amountInCents), [3333, 3333, 3334]);
    assert.deepEqual(planBody.fixedPayments.map((f) => f.scheduledDateOffset), [0, 7, 14]);
    assert.ok(planBody.fixedPayments.every((f) => f.scheduledDateInterval === "days"));
  } finally {
    fx.restore();
  }
});

// ── create_payment_plan: preflight refuses the WHOLE plan, no partial create ──

test("create_payment_plan refuses up front when an instalment exceeds per-tx limit — zero POSTs", async () => {
  const { env } = makeEnv(baseGrant({ maxPerTransactionCents: 3_000 }));
  const fx = stubFetch([{ id: "should_not_be_used" }]);
  try {
    const plan = getTool("create_payment_plan")!;
    // 10000/3 -> 3334 max instalment > 3000 limit.
    const res = await plan.run(CTX(env), {
      payerId: "pyr_1",
      totalAmountCents: 10_000,
      instalments: 3,
      frequency: "monthly",
      startDate: "2026-08-01",
      description: "Too big",
    });
    assert.ok(isDeclined(res));
    assert.equal((res as { reason: string }).reason, "exceeds_per_transaction_limit");
    // The whole point: NOTHING was created.
    assert.equal(fx.calls.length, 0);
  } finally {
    fx.restore();
  }
});

test("create_payment_plan refuses when plan total exceeds daily limit — zero POSTs", async () => {
  const { env } = makeEnv(baseGrant({ maxDailyCents: 5_000, maxPerTransactionCents: 5_000 }));
  const fx = stubFetch([{ id: "nope" }]);
  try {
    const plan = getTool("create_payment_plan")!;
    const res = await plan.run(CTX(env), {
      payerId: "pyr_1",
      totalAmountCents: 6_000,
      instalments: 2,
      frequency: "weekly",
      startDate: "2026-08-01",
      description: "Over daily",
    });
    assert.ok(isDeclined(res));
    assert.equal((res as { reason: string }).reason, "exceeds_daily_limit");
    assert.equal(fx.calls.length, 0);
  } finally {
    fx.restore();
  }
});

// ── create_payment_plan: startDate guardrail ──────────────────────────────────

/** `ymd` shifted by `days` (UTC-noon anchored, mirrors util.ts's own date maths). */
function ymdOffset(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d, 12));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

test("create_payment_plan refuses a startDate before today AU — zero Pinch calls", async () => {
  const { env } = makeEnv(baseGrant());
  const fx = stubFetch([{ id: "should_not_be_used" }]);
  try {
    const plan = getTool("create_payment_plan")!;
    const res = await plan.run(CTX(env), {
      payerId: "pyr_1",
      totalAmountCents: 6_000,
      instalments: 2,
      frequency: "weekly",
      startDate: ymdOffset(todayAU(), -1), // yesterday
      description: "Backdated plan",
    });
    assert.ok(isStructuredError(res));
    assert.equal((res as { code: string }).code, "invalid_start_date");
    assert.equal(fx.calls.length, 0, "nothing is created, and Pinch is never even called");
  } finally {
    fx.restore();
  }
});

test("create_payment_plan accepts a startDate of today AU (not just future dates)", async () => {
  const { env } = makeEnv(baseGrant());
  const fx = stubPlanFlow();
  try {
    const plan = getTool("create_payment_plan")!;
    const res = await plan.run(CTX(env), {
      payerId: "pyr_1",
      totalAmountCents: 6_000,
      instalments: 2,
      frequency: "weekly",
      startDate: todayAU(),
      description: "Starts today",
    });
    assert.ok(!isDeclined(res) && !isStructuredError(res), `expected success, got ${JSON.stringify(res)}`);
  } finally {
    fx.restore();
  }
});

// ── create_payment_plan: overdue-balance sanity check ─────────────────────────

test("create_payment_plan flags a >20% mismatch against the payer's overdue balance, creates nothing", async () => {
  const { env } = makeEnv(baseGrant({ maxPerTransactionCents: 100_000, maxDailyCents: 200_000 }));
  // Payer's real overdue balance is $880; the requested plan totals $570 — off by ~35%.
  const fx = stubFetch([
    [
      {
        id: "pmt_overdue1",
        status: "dishonoured",
        amount: 88_000,
        transactionDate: "2026-06-01T00:00:00.0000000Z",
        payer: { id: "pyr_mismatch" },
      },
    ],
  ]);
  try {
    const plan = getTool("create_payment_plan")!;
    const res = await plan.run(CTX(env), {
      payerId: "pyr_mismatch",
      totalAmountCents: 57_000,
      instalments: 2,
      frequency: "weekly",
      startDate: todayAU(),
      description: "Wrong amount plan",
    });
    assert.ok(isStructuredError(res));
    assert.equal((res as { code: string }).code, "plan_total_mismatch");
    const details = (res as { details?: { planTotalDisplay?: string; overdueTotalDisplay?: string } }).details;
    assert.equal(details?.planTotalDisplay, "$570.00");
    assert.equal(details?.overdueTotalDisplay, "$880.00");
    // Only the overdue-balance GET happened — no instalments were created.
    assert.equal(fx.calls.length, 1);
  } finally {
    fx.restore();
  }
});

test("create_payment_plan proceeds when the total is within 20% of the overdue balance", async () => {
  const { env } = makeEnv(baseGrant({ maxPerTransactionCents: 100_000, maxDailyCents: 200_000 }));
  // Overdue balance $1,000; plan total $900 — 10% off, within tolerance.
  const fx = stubPlanFlow({
    overdue: [
      {
        id: "pmt_overdue1",
        status: "dishonoured",
        amount: 100_000,
        transactionDate: "2026-06-01T00:00:00.0000000Z",
        payer: { id: "pyr_close" },
      },
    ],
  });
  try {
    const plan = getTool("create_payment_plan")!;
    const res = await plan.run(CTX(env), {
      payerId: "pyr_close",
      totalAmountCents: 90_000,
      instalments: 2,
      frequency: "weekly",
      startDate: todayAU(),
      description: "Close enough",
    });
    assert.ok(!isDeclined(res) && !isStructuredError(res), `expected success, got ${JSON.stringify(res)}`);
    assert.equal(fx.calls.length, 4, "overdue GET + plan + subscription + payment-id GET");
  } finally {
    fx.restore();
  }
});

// ── create_payment_plan: ONE native plan+subscription, not N payments ─────────

test("create_payment_plan makes a CONSTANT number of Pinch calls regardless of instalment count", async () => {
  const { env, spend, audit } = makeEnv(baseGrant({ maxPerTransactionCents: 100_000, maxDailyCents: 500_000 }));
  const fx = stubPlanFlow({ subscriptionId: "sub_speed" });
  try {
    const plan = getTool("create_payment_plan")!;
    const started = Date.now();
    const res = await plan.run(CTX(env), {
      payerId: "pyr_speed",
      totalAmountCents: 50_000,
      instalments: 6, // the max allowed
      frequency: "weekly",
      startDate: todayAU(),
      description: "Speed test",
    });
    const elapsedMs = Date.now() - started;
    assert.ok(!isDeclined(res) && !isStructuredError(res), `expected success, got ${JSON.stringify(res)}`);
    // 4 calls whether it's 2 instalments or 6 — the whole point of native plans
    // (the old N-scheduled-payments approach would have made up to 2N+1 here).
    assert.equal(fx.calls.length, 4);
    assert.ok(elapsedMs < 200, `should be a handful of round trips, not N; took ${elapsedMs}ms`);

    // ONE spend addition for the whole total, ONE audit entry — not N.
    assert.equal(spend._store.get(`spend:agent-1:${todayAU()}`), "50000");
    const entries = audit._puts.map(
      (p) => JSON.parse(p.value) as { outcome: string; amountCents?: number; resultId?: string },
    );
    const allowed = entries.filter((e) => e.outcome === "allowed");
    assert.equal(allowed.length, 1);
    assert.equal(allowed[0]!.amountCents, 50_000);
    assert.equal(allowed[0]!.resultId, "sub_speed");
  } finally {
    fx.restore();
  }
});

// ── create_payment_plan: failure modes ─────────────────────────────────────────

test("create_payment_plan returns the Pinch error and audits it when plan creation itself fails", async () => {
  const { env, audit } = makeEnv(baseGrant());
  const fx = stubPlanFlow({
    planStatus: 400,
    planBody: { errors: [{ message: "Simulated plan failure" }] },
  });
  try {
    const plan = getTool("create_payment_plan")!;
    const res = await plan.run(CTX(env), {
      payerId: "pyr_fail",
      totalAmountCents: 6_000,
      instalments: 2,
      frequency: "weekly",
      startDate: todayAU(),
      description: "Plan will fail to create",
    });
    assert.ok(isStructuredError(res));
    assert.equal((res as { code: string }).code, "pinch_error");
    // Only the overdue GET + the failed POST /plans — nothing else attempted.
    assert.equal(fx.calls.length, 2);
    assert.equal(fx.calls.filter((c) => c.method === "DELETE").length, 0);

    const entries = audit._puts.map((p) => JSON.parse(p.value) as { outcome: string });
    assert.ok(entries.some((e) => e.outcome === "error"));
    assert.ok(!entries.some((e) => e.outcome === "allowed"));
  } finally {
    fx.restore();
  }
});

test("create_payment_plan cleans up the orphaned plan and returns a speakable failure when the subscription fails", async () => {
  const { env, audit } = makeEnv(baseGrant());
  const fx = stubPlanFlow({
    planId: "pln_orphan",
    subscriptionStatus: 400,
    subscriptionBody: { errors: [{ message: "Simulated subscription failure" }] },
  });
  try {
    const plan = getTool("create_payment_plan")!;
    const res = await plan.run(CTX(env), {
      payerId: "pyr_fail2",
      totalAmountCents: 6_000,
      instalments: 2,
      frequency: "weekly",
      startDate: todayAU(),
      description: "Subscription will fail",
    });
    assert.ok(isStructuredError(res));
    assert.equal((res as { code: string }).code, "plan_creation_failed");
    const message = (res as { message: string }).message;
    assert.ok(!message.includes("could not be cleaned up"), `plan delete should have succeeded: "${message}"`);

    // overdue GET, POST /plans, POST /subscriptions (fails), DELETE /plans/{id}.
    assert.equal(fx.calls.length, 4);
    const deletePlanCall = fx.calls.find((c) => c.method === "DELETE" && c.url.includes("pln_orphan"));
    assert.ok(deletePlanCall, "the orphaned plan must be cleaned up");

    const entries = audit._puts.map((p) => JSON.parse(p.value) as { outcome: string; reason?: string });
    assert.ok(entries.some((e) => e.outcome === "error" && e.reason === "plan_creation_failed"));
    assert.ok(!entries.some((e) => e.outcome === "allowed"));
  } finally {
    fx.restore();
  }
});

// ── add_bank_account: account number masked in the audit entry ────────────────

test("add_bank_account masks the account number in the audit trail", async () => {
  const { env, audit } = makeEnv(baseGrant());
  const fx = stubFetch([{ id: "src_1", sourceType: "bank-account" }]);
  try {
    const tool = getTool("add_bank_account")!;
    await tool.run(CTX(env), {
      payerId: "pyr_1",
      accountName: "Jane Doe",
      bsb: "062-000",
      accountNumber: "12345678",
    });
    const entry = JSON.parse(audit._puts[0]!.value) as {
      paramsSummary: { accountNumber: string; bsb: string };
    };
    assert.equal(entry.paramsSummary.accountNumber, "•••••678");
    assert.equal(entry.paramsSummary.bsb, "062-000"); // BSB not masked
  } finally {
    fx.restore();
  }
});

// ── get_agent_limits: reports headroom without a Pinch call ───────────────────

test("get_agent_limits reports remaining daily headroom, no network call", async () => {
  const { env, spend } = makeEnv(baseGrant());
  await spend.put("spend:agent-1:" + todayAU(), "12000");
  const fx = stubFetch([{ should: "not be called" }]);
  try {
    const tool = getTool("get_agent_limits")!;
    const res = (await tool.run(CTX(env), {})) as {
      active: boolean;
      remainingTodayCents: number;
      remainingTodayDisplay: string;
      allowedTools: string[];
    };
    assert.equal(res.active, true);
    assert.equal(res.remainingTodayCents, 38_000); // 50000 - 12000
    assert.equal(res.remainingTodayDisplay, "$380.00");
    assert.ok(res.allowedTools.includes("charge_now"));
    assert.equal(fx.calls.length, 0);
  } finally {
    fx.restore();
  }
});

// ── charge_now: resolves the payer's default bank source when none given ──────

test("charge_now looks up the payer's default bank source and charges it", async () => {
  const { env } = makeEnv(baseGrant());
  // 1st fetch: GET /payers/{id} -> payer with two sources (a card + a bank acct).
  // 2nd fetch: POST /payments/realtime -> the charge.
  const fx = stubFetch([
    {
      id: "pyr_1",
      sources: [
        { id: "src_card", sourceType: "credit-card", supportsRealtime: true },
        { id: "src_bank", sourceType: "bank-account", supportsRealtime: true, isAuthorised: true },
      ],
    },
    { id: "pmt_rt", status: "approved", amount: 5000 },
  ]);
  try {
    const tool = getTool("charge_now")!;
    const res = await tool.run(CTX(env), {
      payerId: "pyr_1",
      amountCents: 5000,
      description: "Realtime charge",
    });
    assert.ok(!isDeclined(res) && !isStructuredError(res));
    assert.equal((res as { id: string }).id, "pmt_rt");

    // Two Pinch calls: the payer GET, then the realtime POST.
    assert.equal(fx.calls.length, 2);
    assert.match(fx.calls[0]!.url, /\/payers\/pyr_1$/);
    assert.equal(fx.calls[0]!.method, "GET");

    const realtime = fx.calls[1]!;
    assert.match(realtime.url, /\/payments\/realtime$/);
    assert.equal(realtime.method, "POST");
    // The resolved bank-account source id must be passed explicitly.
    const sent = JSON.parse(realtime.body!) as { sourceId?: string; amount: number };
    assert.equal(sent.sourceId, "src_bank");
    assert.equal(sent.amount, 5000);
  } finally {
    fx.restore();
  }
});

test("charge_now returns no_payment_source when the payer has no bank account", async () => {
  const { env } = makeEnv(baseGrant());
  // GET /payers/{id} -> payer with only a credit-card source (no bank account).
  const fx = stubFetch([
    { id: "pyr_1", sources: [{ id: "src_card", sourceType: "credit-card" }] },
  ]);
  try {
    const tool = getTool("charge_now")!;
    const res = await tool.run(CTX(env), {
      payerId: "pyr_1",
      amountCents: 5000,
      description: "No source",
    });
    assert.ok(isStructuredError(res));
    assert.equal((res as { code: string }).code, "no_payment_source");
    // Only the payer GET happened — no realtime POST.
    assert.equal(fx.calls.length, 1);
  } finally {
    fx.restore();
  }
});

test("charge_now uses an explicit sourceId without a payer lookup", async () => {
  const { env } = makeEnv(baseGrant());
  const fx = stubFetch([{ id: "pmt_rt", status: "approved", amount: 5000 }]);
  try {
    const tool = getTool("charge_now")!;
    const res = await tool.run(CTX(env), {
      payerId: "pyr_1",
      amountCents: 5000,
      description: "Explicit source",
      sourceId: "src_explicit",
    });
    assert.ok(!isDeclined(res) && !isStructuredError(res));
    // No payer GET — went straight to the realtime POST with the given source.
    assert.equal(fx.calls.length, 1);
    assert.match(fx.calls[0]!.url, /\/payments\/realtime$/);
    const sent = JSON.parse(fx.calls[0]!.body!) as { sourceId?: string };
    assert.equal(sent.sourceId, "src_explicit");
  } finally {
    fx.restore();
  }
});

// ── create_payment_plan: idempotency — second identical call returns cached result ──

test("create_payment_plan: second identical call returns cached result, zero extra Pinch calls", async () => {
  const { env, audit } = makeEnv(baseGrant());
  const fx = stubPlanFlow({
    subscriptionId: "sub_idem",
    generatedPayments: [
      { id: "pmt_1", subscription: { id: "sub_idem" }, description: "Idem test (instalment 1/3)" },
      { id: "pmt_2", subscription: { id: "sub_idem" }, description: "Idem test (instalment 2/3)" },
      { id: "pmt_3", subscription: { id: "sub_idem" }, description: "Idem test (instalment 3/3)" },
    ],
  });
  try {
    const plan = getTool("create_payment_plan")!;
    const args = {
      payerId: "pyr_idem",
      totalAmountCents: 30_000,
      instalments: 3,
      frequency: "weekly",
      startDate: "2026-08-01",
      description: "Idem test",
    };

    // First call — creates the plan + subscription.
    const first = (await plan.run(CTX(env), args)) as {
      schedule: Array<{ paymentId?: string }>;
      totalAmountCents: number;
      subscriptionId: string;
    };
    assert.ok(!isDeclined(first) && !isStructuredError(first));
    assert.equal(first.schedule.length, 3);
    assert.equal(first.subscriptionId, "sub_idem");
    assert.equal(fx.calls.length, 4);

    // Second identical call — must return the SAME result, zero new Pinch calls
    // (the idempotency cache hit short-circuits before the overdue check too).
    const second = (await plan.run(CTX(env), args)) as typeof first;
    assert.ok(!isDeclined(second) && !isStructuredError(second));
    assert.equal(second.totalAmountCents, first.totalAmountCents);
    assert.equal(second.subscriptionId, first.subscriptionId);
    assert.deepEqual(
      second.schedule.map((s) => s.paymentId),
      first.schedule.map((s) => s.paymentId),
      "second call must return the original payment ids",
    );
    // Still only 4 Pinch calls total — the second call hit the cache.
    assert.equal(fx.calls.length, 4, "no extra Pinch calls on duplicate call");

    // Audit log must contain a duplicate_suppressed entry.
    const entries = audit._puts.map((p) => JSON.parse(p.value) as { outcome: string });
    assert.ok(
      entries.some((e) => e.outcome === "duplicate_suppressed"),
      "audit must record duplicate_suppressed",
    );
  } finally {
    fx.restore();
  }
});

// ── cancel_payment_plan ─────────────────────────────────────────────────────

test("cancel_payment_plan calls DELETE /subscriptions/{id} exactly once", async () => {
  const { env, audit } = makeEnv(baseGrant());
  const fx = stubFetch([{}]);
  try {
    const tool = getTool("cancel_payment_plan")!;
    const res = await tool.run(CTX(env), { subscriptionId: "sub_cancel_me" });
    assert.ok(!isDeclined(res) && !isStructuredError(res), `expected success, got ${JSON.stringify(res)}`);
    assert.equal(fx.calls.length, 1);
    assert.equal(fx.calls[0]!.method, "DELETE");
    assert.ok(fx.calls[0]!.url.includes("sub_cancel_me"));

    const entries = audit._puts.map((p) => JSON.parse(p.value) as { outcome: string; tool: string });
    assert.ok(entries.some((e) => e.outcome === "allowed" && e.tool === "cancel_payment_plan"));
  } finally {
    fx.restore();
  }
});

test("cancel_payment_plan rejects a missing subscriptionId, zero Pinch calls", async () => {
  const { env } = makeEnv(baseGrant());
  const fx = stubFetch([{}]);
  try {
    const tool = getTool("cancel_payment_plan")!;
    const res = await tool.run(CTX(env), {});
    assert.ok(isStructuredError(res));
    assert.equal((res as { code: string }).code, "invalid_arguments");
    assert.equal(fx.calls.length, 0);
  } finally {
    fx.restore();
  }
});

test("charge_now with a float amount is rejected before any Pinch call", async () => {
  const { env } = makeEnv(baseGrant());
  const fx = stubFetch([{ id: "nope" }]);
  try {
    const tool = getTool("charge_now")!;
    const res = await tool.run(CTX(env), {
      payerId: "pyr_1",
      amountCents: 12.5, // not an integer
      description: "bad",
    });
    assert.ok(isStructuredError(res));
    assert.equal((res as { code: string }).code, "invalid_arguments");
    assert.equal(fx.calls.length, 0);
  } finally {
    fx.restore();
  }
});
