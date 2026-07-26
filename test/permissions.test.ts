/**
 * Unit tests for the permissions engine. No network, no real KV — an in-memory
 * KV mock stands in for GRANTS / SPEND / AUDIT. Run: `npm run test:perms`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { enforce } from "../src/permissions";
import { isDeclined, isStructuredError } from "../src/types";
import type { Declined, Env, Grant, StructuredError } from "../src/types";
import { structuredError, todayAU } from "../src/util";

// ── narrowing assertion helpers (a type guard behind assert.ok does not narrow
//    the subject; an `asserts x is T` wrapper does) ────────────────────────────

function assertDeclined(x: unknown): asserts x is Declined {
  assert.ok(isDeclined(x), `expected Declined, got ${JSON.stringify(x)}`);
}

function assertStructuredError(x: unknown): asserts x is StructuredError {
  assert.ok(isStructuredError(x), `expected StructuredError, got ${JSON.stringify(x)}`);
}

function assertOk(x: unknown): void {
  assert.ok(
    !isDeclined(x) && !isStructuredError(x),
    `expected success, got ${JSON.stringify(x)}`,
  );
}

// ── in-memory KV mock ─────────────────────────────────────────────────────────

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
    // test-only accessors
    _store: store,
    _puts: puts,
  };
  return kv as unknown as KVNamespace & {
    _store: Map<string, string>;
    _puts: Array<{ key: string; value: string }>;
  };
}

function makeEnv(opts: {
  grant?: Grant;
  spendToday?: number;
  agentId?: string;
}): {
  env: Env;
  grants: ReturnType<typeof makeKV>;
  spend: ReturnType<typeof makeKV>;
  audit: ReturnType<typeof makeKV>;
} {
  const agentId = opts.agentId ?? "agent-1";
  const grants = makeKV(
    opts.grant ? { [`grant:${agentId}`]: JSON.stringify(opts.grant) } : {},
  );
  const spend = makeKV(
    opts.spendToday !== undefined
      ? { [`spend:${agentId}:${todayAU()}`]: String(opts.spendToday) }
      : {},
  );
  const audit = makeKV();
  const env = {
    GRANTS: grants,
    SPEND: spend,
    AUDIT: audit,
    TOKENS: makeKV(),
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

function baseGrant(overrides: Partial<Grant> = {}): Grant {
  return {
    agentId: "agent-1",
    name: "Test Agent",
    maxPerTransactionCents: 10_000, // $100
    maxDailyCents: 50_000, // $500
    allowedTools: ["createRealtimePayment", "listEvents"],
    active: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** An execute thunk that records whether it ran and returns a canned result. */
function spyExecute<T>(result: T) {
  const state = { calls: 0 };
  const fn = async (): Promise<T> => {
    state.calls++;
    return result;
  };
  return { fn, state };
}

function auditOutcomes(audit: ReturnType<typeof makeKV>): string[] {
  return audit._puts.map((p) => (JSON.parse(p.value) as { outcome: string }).outcome);
}

// ── tests ──────────────────────────────────────────────────────────────────────

test("no grant -> declined no_grant, execute never runs, audit declined", async () => {
  const { env, audit } = makeEnv({});
  const exec = spyExecute({ id: "pmt_1" });
  const res = await enforce({
    env,
    agentId: "agent-1",
    tool: "createRealtimePayment",
    params: { amount: 5000 },
    amountCents: 5000,
    execute: exec.fn,
  });
  assertDeclined(res);
  assert.equal(res.reason, "no_grant");
  assert.equal(exec.state.calls, 0);
  assert.deepEqual(auditOutcomes(audit), ["declined"]);
});

test("inactive grant -> declined grant_inactive", async () => {
  const { env } = makeEnv({ grant: baseGrant({ active: false }) });
  const exec = spyExecute({ id: "pmt_1" });
  const res = await enforce({
    env,
    agentId: "agent-1",
    tool: "createRealtimePayment",
    params: {},
    amountCents: 5000,
    execute: exec.fn,
  });
  assertDeclined(res);
  assert.equal(res.reason, "grant_inactive");
  assert.equal(exec.state.calls, 0);
});

test("tool not in allowedTools -> declined tool_not_allowed", async () => {
  const { env } = makeEnv({ grant: baseGrant() });
  const exec = spyExecute({ id: "pmt_1" });
  const res = await enforce({
    env,
    agentId: "agent-1",
    tool: "createBankSource",
    params: {},
    amountCents: 0,
    execute: exec.fn,
  });
  assertDeclined(res);
  assert.equal(res.reason, "tool_not_allowed");
  assert.equal(res.tool, "createBankSource");
  assert.equal(exec.state.calls, 0);
});

test("over per-transaction limit -> declined with limit/attempted", async () => {
  const { env } = makeEnv({ grant: baseGrant({ maxPerTransactionCents: 10_000 }) });
  const exec = spyExecute({ id: "pmt_1" });
  const res = await enforce({
    env,
    agentId: "agent-1",
    tool: "createRealtimePayment",
    params: { amount: 20_000 },
    amountCents: 20_000,
    execute: exec.fn,
  });
  assertDeclined(res);
  assert.equal(res.reason, "exceeds_per_transaction_limit");
  assert.equal(res.limitCents, 10_000);
  assert.equal(res.attemptedCents, 20_000);
  assert.equal(exec.state.calls, 0);
});

test("over daily limit -> declined with spentTodayCents", async () => {
  const { env } = makeEnv({
    grant: baseGrant({ maxDailyCents: 50_000, maxPerTransactionCents: 50_000 }),
    spendToday: 48_000,
  });
  const exec = spyExecute({ id: "pmt_1" });
  const res = await enforce({
    env,
    agentId: "agent-1",
    tool: "createRealtimePayment",
    params: { amount: 5_000 },
    amountCents: 5_000, // 48k + 5k = 53k > 50k
    execute: exec.fn,
  });
  assertDeclined(res);
  assert.equal(res.reason, "exceeds_daily_limit");
  assert.equal(res.limitCents, 50_000);
  assert.equal(res.spentTodayCents, 48_000);
  assert.equal(exec.state.calls, 0);
});

test("happy path -> returns result, increments spend, audit allowed w/ resultId", async () => {
  const { env, spend, audit } = makeEnv({ grant: baseGrant(), spendToday: 1_000 });
  const exec = spyExecute({ id: "pmt_42", status: "approved" });
  const res = await enforce({
    env,
    agentId: "agent-1",
    tool: "createRealtimePayment",
    params: { amount: 5_000 },
    amountCents: 5_000,
    execute: exec.fn,
  });
  assertOk(res);
  assert.equal((res as { id: string }).id, "pmt_42");
  assert.equal(exec.state.calls, 1);
  // spend incremented 1000 -> 6000
  assert.equal(await spend.get(`spend:agent-1:${todayAU()}`), "6000");
  const outcomes = auditOutcomes(audit);
  assert.ok(outcomes.includes("allowed"));
  const allowedEntry = audit._puts
    .map((p) => JSON.parse(p.value) as { outcome: string; resultId?: string })
    .find((e) => e.outcome === "allowed");
  assert.equal(allowedEntry?.resultId, "pmt_42");
});

test("execute returns StructuredError -> propagated, spend NOT incremented, audit error", async () => {
  const { env, spend, audit } = makeEnv({ grant: baseGrant(), spendToday: 1_000 });
  const exec = spyExecute(structuredError("pinch_error", "boom"));
  const res = await enforce({
    env,
    agentId: "agent-1",
    tool: "createRealtimePayment",
    params: { amount: 5_000 },
    amountCents: 5_000,
    execute: exec.fn,
  });
  assertStructuredError(res);
  assert.equal(res.code, "pinch_error");
  // unchanged
  assert.equal(await spend.get(`spend:agent-1:${todayAU()}`), "1000");
  assert.deepEqual(auditOutcomes(audit), ["error"]);
});

test("zero-amount read tool -> limits skipped, allowed, spend unchanged", async () => {
  const { env, spend } = makeEnv({
    grant: baseGrant({ maxPerTransactionCents: 1, maxDailyCents: 1 }),
  });
  const exec = spyExecute({ data: [], totalItems: 0 });
  const res = await enforce({
    env,
    agentId: "agent-1",
    tool: "listEvents",
    params: { pageSize: 10 },
    amountCents: 0,
    execute: exec.fn,
  });
  assertOk(res);
  assert.equal(exec.state.calls, 1);
  assert.equal(await spend.get(`spend:agent-1:${todayAU()}`), null);
});

test("audit is written on declined, error, and allowed paths", async () => {
  // declined
  {
    const { env, audit } = makeEnv({});
    await enforce({
      env,
      agentId: "agent-1",
      tool: "createRealtimePayment",
      params: {},
      amountCents: 100,
      execute: spyExecute({ id: "x" }).fn,
    });
    assert.equal(audit._puts.length, 1);
  }
  // error
  {
    const { env, audit } = makeEnv({ grant: baseGrant() });
    await enforce({
      env,
      agentId: "agent-1",
      tool: "createRealtimePayment",
      params: {},
      amountCents: 100,
      execute: spyExecute(structuredError("pinch_error", "x")).fn,
    });
    assert.equal(audit._puts.length, 1);
  }
  // allowed
  {
    const { env, audit } = makeEnv({ grant: baseGrant() });
    await enforce({
      env,
      agentId: "agent-1",
      tool: "createRealtimePayment",
      params: {},
      amountCents: 100,
      execute: spyExecute({ id: "y" }).fn,
    });
    assert.equal(audit._puts.length, 1);
  }
});
