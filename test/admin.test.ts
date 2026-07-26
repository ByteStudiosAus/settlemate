/**
 * Tests for the REST admin + dashboard facade (src/admin.ts). KV is an in-memory
 * mock that also implements `list({ prefix, cursor })` (the admin routes need it).
 * Pinch is stubbed at the `fetch` level for the /recovered route. Run:
 * `npm run test:admin`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { handleAdmin } from "../src/admin";
import type { AuditEntry, Env, Grant } from "../src/types";
import { maskAccount } from "../src/util";

/** Read every audit entry currently in the AUDIT KV mock (test-only helper). */
function readAuditEntries(env: Env): AuditEntry[] {
  const store = (env.AUDIT as unknown as { _store: Map<string, string> })._store;
  return [...store.entries()]
    .filter(([k]) => k.startsWith("audit:"))
    .map(([, v]) => JSON.parse(v) as AuditEntry);
}

// ── KV mock WITH list() ────────────────────────────────────────────────────────

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
    async list(opts?: { prefix?: string; cursor?: string; limit?: number }) {
      const prefix = opts?.prefix ?? "";
      const names = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      return { list_complete: true, keys: names.map((name) => ({ name })), cacheStatus: null };
    },
    _store: store,
  };
  return kv as unknown as KVNamespace & { _store: Map<string, string> };
}

function makeEnv(seed: {
  grants?: Record<string, string>;
  audit?: Record<string, string>;
} = {}) {
  const env = {
    GRANTS: makeKV(seed.grants),
    SPEND: makeKV(),
    AUDIT: makeKV(seed.audit),
    TOKENS: makeKV({
      "pinch:token": JSON.stringify({ access_token: "t", expires_at: 9e15 }),
    }),
    IDEMPOTENCY: makeKV(),
    PINCH_API_BASE: "https://api.getpinch.com.au/test",
    PINCH_AUTH_URL: "https://auth.getpinch.com.au/connect/token",
    PINCH_VERSION: "2020.1",
    ENABLE_TWILIO: "false",
    PINCH_SECRET_KEY: "sk_test_x",
    PINCH_PUBLISHABLE_KEY: "app_test_x",
    PINCH_MERCHANT_ID: "",
    ADMIN_KEY: "admin-secret",
    VOICE_SECRET: "voice",
    ELEVENLABS_API_BASE: "https://api.elevenlabs.io",
    ELEVENLABS_API_KEY: "xi_test_x",
    ELEVENLABS_AGENT_ID: "agent_test_x",
    ELEVENLABS_PHONE_NUMBER_ID: "phnum_test_x",
  } as unknown as Env;
  return env;
}

const AUTH = { authorization: "Bearer admin-secret" };

function req(
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: unknown } = {},
): Request {
  const init: RequestInit = { method, headers: opts.headers };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  return new Request(`https://worker.example${path}`, init);
}

function stubFetch(bodies: unknown[]) {
  const calls: Array<{ url: string; method: string }> = [];
  let i = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? "GET" });
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
 * Route-aware Pinch stub for the seed/reset flows (which hit several endpoints).
 * Dispatches on `${METHOD} ${pathname}` with a `:id` wildcard segment, records
 * every call, and mints stable ids so re-seeds can be compared.
 */
function stubPinch() {
  const calls: Array<{ method: string; url: string; body: string | null }> = [];
  const original = globalThis.fetch;
  let payerSeq = 0;
  let sourceSeq = 0;
  let paymentSeq = 0;
  // payerId -> scheduled payments currently "on file" (so reset can list+delete them).
  const scheduledByPayer = new Map<string, Array<{ id: string; status: string }>>();

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : null;
    // Strip the /test base so path matching works regardless of PINCH_API_BASE.
    const path = url.pathname.replace(/^\/test/, "");
    calls.push({ method, url: path, body });

    const json = (obj: unknown, status = 200) =>
      new Response(JSON.stringify(obj), {
        status,
        headers: { "content-type": "application/json" },
      });

    // POST /payers -> new payer with a stable, incrementing id
    if (method === "POST" && path === "/payers") {
      const id = `pyr_seed${++payerSeq}`;
      scheduledByPayer.set(id, []);
      return json({ id, sources: [] });
    }
    // POST /payers/{id}/sources -> a bank source
    if (method === "POST" && /^\/payers\/[^/]+\/sources$/.test(path)) {
      return json({ id: `src_${++sourceSeq}`, sourceType: "bank-account" });
    }
    // POST /payments -> a scheduled payment, tracked for its payer
    if (method === "POST" && path === "/payments") {
      const payerId = body ? (JSON.parse(body) as { payerId: string }).payerId : "";
      const pmt = { id: `pmt_${++paymentSeq}`, status: "scheduled" };
      const list = scheduledByPayer.get(payerId) ?? [];
      list.push(pmt);
      scheduledByPayer.set(payerId, list);
      return json(pmt);
    }
    // GET /payments/payer/{id} -> BARE array of that payer's payments
    const payerListMatch = /^\/payments\/payer\/([^/]+)$/.exec(path);
    if (method === "GET" && payerListMatch) {
      return json(scheduledByPayer.get(decodeURIComponent(payerListMatch[1]!)) ?? []);
    }
    // DELETE /payments/{id} -> remove from whichever payer holds it
    const delMatch = /^\/payments\/([^/]+)$/.exec(path);
    if (method === "DELETE" && delMatch) {
      const pmtId = decodeURIComponent(delMatch[1]!);
      for (const [payer, list] of scheduledByPayer) {
        scheduledByPayer.set(payer, list.filter((p) => p.id !== pmtId));
      }
      return json({});
    }
    return json({}, 200);
  }) as typeof fetch;

  return {
    calls,
    scheduledByPayer,
    restore: () => { globalThis.fetch = original; },
  };
}

// ── auth ───────────────────────────────────────────────────────────────────────

test("missing / wrong bearer -> 401 structured unauthorized", async () => {
  const env = makeEnv();
  const noAuth = await handleAdmin(req("GET", "/admin/grants"), env);
  assert.equal(noAuth.status, 401);
  const body = (await noAuth.json()) as { error: boolean; code: string };
  assert.equal(body.error, true);
  assert.equal(body.code, "unauthorized");

  const badAuth = await handleAdmin(
    req("GET", "/admin/grants", { headers: { authorization: "Bearer nope" } }),
    env,
  );
  assert.equal(badAuth.status, 401);
});

// ── grant create -> get round-trip ───────────────────────────────────────────

test("POST /admin/grants creates a grant, GET reads it back", async () => {
  const env = makeEnv();
  const created = await handleAdmin(
    req("POST", "/admin/grants", {
      headers: AUTH,
      body: {
        agentId: "agent-x",
        name: "Agent X",
        maxPerTransactionCents: 5000,
        maxDailyCents: 20000,
      },
    }),
    env,
  );
  assert.equal(created.status, 201);
  const { grant } = (await created.json()) as { grant: Grant };
  assert.equal(grant.agentId, "agent-x");
  assert.equal(grant.active, true);
  assert.ok(grant.allowedTools.includes("charge_now"), "defaults to all tools");
  assert.ok(grant.createdAt && grant.updatedAt);

  const fetched = await handleAdmin(
    req("GET", "/admin/grants/agent-x", { headers: AUTH }),
    env,
  );
  assert.equal(fetched.status, 200);
  const back = (await fetched.json()) as { grant: Grant };
  assert.equal(back.grant.maxDailyCents, 20000);
});

test("POST /admin/grants rejects a float amount (integer cents only)", async () => {
  const env = makeEnv();
  const res = await handleAdmin(
    req("POST", "/admin/grants", {
      headers: AUTH,
      body: { agentId: "a", name: "A", maxPerTransactionCents: 12.5, maxDailyCents: 100 },
    }),
    env,
  );
  assert.equal(res.status, 400);
  const body = (await res.json()) as { code: string };
  assert.equal(body.code, "invalid_arguments");
});

test("PATCH /admin/grants/:id deactivates without touching other fields", async () => {
  const grant: Grant = {
    agentId: "agent-x",
    name: "Agent X",
    maxPerTransactionCents: 5000,
    maxDailyCents: 20000,
    allowedTools: ["charge_now"],
    active: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const env = makeEnv({ grants: { "grant:agent-x": JSON.stringify(grant) } });
  const res = await handleAdmin(
    req("PATCH", "/admin/grants/agent-x", { headers: AUTH, body: { active: false } }),
    env,
  );
  assert.equal(res.status, 200);
  const { grant: updated } = (await res.json()) as { grant: Grant };
  assert.equal(updated.active, false);
  assert.equal(updated.maxDailyCents, 20000);
  assert.notEqual(updated.updatedAt, grant.updatedAt);
});

test("GET /admin/grants/:id -> 404 when absent", async () => {
  const env = makeEnv();
  const res = await handleAdmin(req("GET", "/admin/grants/ghost", { headers: AUTH }), env);
  assert.equal(res.status, 404);
});

// ── audit: newest-first + limit ───────────────────────────────────────────────

test("GET /admin/audit returns newest-first, respects limit and agentId filter", async () => {
  const mk = (ts: string, agentId: string): [string, string] => {
    const entry: AuditEntry = { ts, agentId, tool: "charge_now", paramsSummary: {}, outcome: "allowed" };
    return [`audit:${ts}:r`, JSON.stringify(entry)];
  };
  const env = makeEnv({
    audit: Object.fromEntries([
      mk("2026-07-20T10:00:00.000Z", "agent-1"),
      mk("2026-07-21T10:00:00.000Z", "agent-2"),
      mk("2026-07-22T10:00:00.000Z", "agent-1"),
    ]),
  });

  const res = await handleAdmin(req("GET", "/admin/audit?limit=2", { headers: AUTH }), env);
  const body = (await res.json()) as { count: number; entries: AuditEntry[] };
  assert.equal(body.count, 2);
  assert.equal(body.entries[0]!.ts, "2026-07-22T10:00:00.000Z", "newest first");
  assert.equal(body.entries[1]!.ts, "2026-07-21T10:00:00.000Z");

  const filtered = await handleAdmin(
    req("GET", "/admin/audit?agentId=agent-1", { headers: AUTH }),
    env,
  );
  const fb = (await filtered.json()) as { count: number; entries: AuditEntry[] };
  assert.equal(fb.count, 2);
  assert.ok(fb.entries.every((e) => e.agentId === "agent-1"));
});

// ── recovered: sums only transferred ──────────────────────────────────────────

test("GET /admin/recovered sums only transferred payments", async () => {
  const env = makeEnv();
  const fx = stubFetch([
    {
      data: [
        { id: "pmt_1", status: "transferred", amount: 45000 },
        { id: "pmt_2", status: "scheduled", amount: 12000 },
        { id: "pmt_3", status: "transferred", amount: 5000 },
        { id: "pmt_4", status: "dishonoured", amount: 9999 },
      ],
      page: 1,
      pageSize: 100,
      totalPages: 1,
      totalItems: 4,
    },
  ]);
  try {
    const res = await handleAdmin(req("GET", "/admin/recovered", { headers: AUTH }), env);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      recoveredCents: number;
      recoveredDisplay: string;
      count: number;
    };
    assert.equal(body.recoveredCents, 50000);
    assert.equal(body.recoveredDisplay, "$500.00");
    assert.equal(body.count, 2);
    assert.equal((body as { source?: string }).source, "live-scan");
  } finally {
    fx.restore();
  }
});

test("GET /admin/recovered prefers the webhook-events snapshot when one exists — zero Pinch calls", async () => {
  const env = makeEnv({
    grants: {
      "pinch:payment:pmt_a": JSON.stringify({
        paymentId: "pmt_a",
        status: "transferred",
        outcome: "settled",
        amountCents: 30000,
        payerId: "pyr_1",
        eventType: "bank-results",
        updatedAt: "2026-07-01T00:00:00.000Z",
      }),
      "pinch:payment:pmt_b": JSON.stringify({
        paymentId: "pmt_b",
        status: "dishonoured",
        outcome: "failed",
        amountCents: 9999,
        payerId: "pyr_1",
        eventType: "bank-results",
        updatedAt: "2026-07-01T00:00:00.000Z",
      }),
      "pinch:payment:pmt_c": JSON.stringify({
        paymentId: "pmt_c",
        status: "transferred",
        outcome: "settled",
        amountCents: 5000,
        payerId: "pyr_2",
        eventType: "bank-results",
        updatedAt: "2026-07-02T00:00:00.000Z",
      }),
    },
  });
  const fx = stubFetch([{ data: [], page: 1, pageSize: 100, totalPages: 1, totalItems: 0 }]);
  try {
    const res = await handleAdmin(req("GET", "/admin/recovered", { headers: AUTH }), env);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { recoveredCents: number; count: number; source?: string };
    // Only the two "settled" records count — the "failed" one is excluded.
    assert.equal(body.recoveredCents, 35000);
    assert.equal(body.count, 2);
    assert.equal(body.source, "webhook-events");
    assert.equal(fx.calls.length, 0, "snapshot path must not touch Pinch at all");
  } finally {
    fx.restore();
  }
});

test("GET /admin/recovered?payerId=... filters the webhook-events snapshot by payer", async () => {
  const env = makeEnv({
    grants: {
      "pinch:payment:pmt_a": JSON.stringify({
        paymentId: "pmt_a", status: "transferred", outcome: "settled", amountCents: 30000,
        payerId: "pyr_1", eventType: "bank-results", updatedAt: "2026-07-01T00:00:00.000Z",
      }),
      "pinch:payment:pmt_c": JSON.stringify({
        paymentId: "pmt_c", status: "transferred", outcome: "settled", amountCents: 5000,
        payerId: "pyr_2", eventType: "bank-results", updatedAt: "2026-07-02T00:00:00.000Z",
      }),
    },
  });
  const res = await handleAdmin(req("GET", "/admin/recovered?payerId=pyr_2", { headers: AUTH }), env);
  const body = (await res.json()) as { recoveredCents: number; count: number };
  assert.equal(body.recoveredCents, 5000);
  assert.equal(body.count, 1);
});

// ── GET /admin/payments/status ──────────────────────────────────────────────

test("GET /admin/payments/status summarises counts and totals by status", async () => {
  const env = makeEnv();
  const fx = stubFetch([
    {
      data: [
        { id: "pmt_1", status: "transferred", amount: 45000 },
        { id: "pmt_2", status: "scheduled", amount: 12000 },
        { id: "pmt_3", status: "transferred", amount: 5000 },
        { id: "pmt_4", status: "dishonoured", amount: 9999 },
        { id: "pmt_5", status: "scheduled", amount: 1000 },
      ],
      page: 1,
      pageSize: 100,
      totalPages: 1,
      totalItems: 5,
    },
  ]);
  try {
    const res = await handleAdmin(req("GET", "/admin/payments/status", { headers: AUTH }), env);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      totalPayments: number;
      statuses: Array<{ status: string; count: number; totalCents: number; totalDisplay: string }>;
    };
    assert.equal(body.totalPayments, 5);
    const scheduled = body.statuses.find((s) => s.status === "scheduled");
    assert.equal(scheduled?.count, 2);
    assert.equal(scheduled?.totalCents, 13000);
    assert.equal(scheduled?.totalDisplay, "$130.00");
    const transferred = body.statuses.find((s) => s.status === "transferred");
    assert.equal(transferred?.count, 2);
    assert.equal(transferred?.totalCents, 50000);
    const dishonoured = body.statuses.find((s) => s.status === "dishonoured");
    assert.equal(dishonoured?.count, 1);
    assert.equal(dishonoured?.totalCents, 9999);
  } finally {
    fx.restore();
  }
});

// ── /api alias resolves the same routes ────────────────────────────────────────

// ── seed idempotency: second call reuses payer ids ────────────────────────────

test("POST /admin/seed is idempotent: second call reuses existing payer ids", async () => {
  const env = makeEnv();
  const fx = stubPinch();
  try {
    const res1 = await handleAdmin(req("POST", "/admin/seed", { headers: AUTH }), env);
    assert.equal(res1.status, 201);
    const body1 = (await res1.json()) as { payers: Array<{ payerId: string; reused?: boolean }> };
    const ids1 = body1.payers.map((p) => p.payerId);
    assert.equal(ids1.length, 3);
    assert.ok(body1.payers.every((p) => !p.reused), "first seed: all payers are new");

    const res2 = await handleAdmin(req("POST", "/admin/seed", { headers: AUTH }), env);
    assert.equal(res2.status, 201);
    const body2 = (await res2.json()) as { payers: Array<{ payerId: string; reused?: boolean }> };
    const ids2 = body2.payers.map((p) => p.payerId);

    assert.deepEqual(ids2, ids1, "second seed must return the same payer ids");
    assert.ok(body2.payers.every((p) => p.reused), "second seed: all payers are reused");

    // No extra POST /payers calls on the second seed.
    const payerCreates = fx.calls.filter((c) => c.method === "POST" && c.url === "/payers");
    assert.equal(payerCreates.length, 3, "only 3 payer creates total across both seeds");
  } finally {
    fx.restore();
  }
});

// ── reset: deletes scheduled payments then re-seeds invoices ─────────────────

test("POST /admin/reset deletes all scheduled payments and re-creates invoices", async () => {
  const env = makeEnv();
  const fx = stubPinch();
  try {
    // Seed first so payers + invoices exist.
    await handleAdmin(req("POST", "/admin/seed", { headers: AUTH }), env);

    const paymentsBefore = fx.calls.filter((c) => c.method === "POST" && c.url === "/payments").length;
    assert.ok(paymentsBefore > 0, "seed must have created some payments");

    const res = await handleAdmin(req("POST", "/admin/reset", { headers: AUTH }), env);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      reset: boolean;
      paymentsDeleted: number;
      invoices: Array<{ paymentId: string }>;
    };
    assert.equal(body.reset, true);
    assert.equal(body.paymentsDeleted, paymentsBefore, "reset must delete every scheduled payment");
    assert.ok(body.invoices.length > 0, "reset must re-create invoices");

    // All re-created invoices have fresh payment ids.
    const allPaymentIds = fx.calls
      .filter((c) => c.method === "POST" && c.url === "/payments")
      .map((_, i) => i);
    assert.ok(allPaymentIds.length === paymentsBefore * 2, "total payments = seed + reset re-seed");

    // Payer ids are stable — no new POST /payers after the initial seed.
    const payerCreates = fx.calls.filter((c) => c.method === "POST" && c.url === "/payers");
    assert.equal(payerCreates.length, 3, "reset must not create new payers");
  } finally {
    fx.restore();
  }
});

// ── /api alias resolves the same routes ────────────────────────────────────────

test("/api/grants aliases /admin/grants", async () => {
  const env = makeEnv();
  const res = await handleAdmin(req("GET", "/api/grants", { headers: AUTH }), env);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { count: number; grants: Grant[] };
  assert.equal(body.count, 0);
});

// ── POST /admin/payers — dashboard "add a customer" ──────────────────────────

test("POST /admin/payers creates a payer + demo bank source, returns {payerId, name}", async () => {
  const env = makeEnv();
  const fx = stubPinch();
  try {
    const res = await handleAdmin(
      req("POST", "/admin/payers", {
        headers: AUTH,
        body: { name: "Kev Concreting", email: "kev@example.com", mobile: "0400111222" },
      }),
      env,
    );
    assert.equal(res.status, 201);
    const body = (await res.json()) as { payerId: string; name: string };
    assert.ok(body.payerId.startsWith("pyr_"));
    assert.equal(body.name, "Kev Concreting");

    // A payer and a bank source were both created.
    assert.ok(fx.calls.some((c) => c.method === "POST" && c.url === "/payers"));
    assert.ok(fx.calls.some((c) => c.method === "POST" && /\/payers\/[^/]+\/sources$/.test(c.url)));

    // Audited under the admin actor.
    const entries = readAuditEntries(env);
    const entry = entries.find((e) => e.tool === "admin_create_payer");
    assert.ok(entry, "admin_create_payer must be audited");
    assert.equal(entry!.agentId, "admin");
    assert.equal(entry!.outcome, "allowed");
    assert.equal(entry!.resultId, body.payerId);
  } finally {
    fx.restore();
  }
});

test("POST /admin/payers works without email/mobile (synthesises a placeholder email)", async () => {
  const env = makeEnv();
  const fx = stubPinch();
  try {
    const res = await handleAdmin(
      req("POST", "/admin/payers", { headers: AUTH, body: { name: "Solo" } }),
      env,
    );
    assert.equal(res.status, 201);
    const body = (await res.json()) as { payerId: string; name: string };
    assert.equal(body.name, "Solo");
    const payerCreate = fx.calls.find((c) => c.method === "POST" && c.url === "/payers");
    const sent = JSON.parse(payerCreate!.body!) as { firstName: string; emailAddress: string };
    assert.equal(sent.firstName, "Solo");
    assert.ok(sent.emailAddress.includes("@"), "a placeholder email must be sent to Pinch");
  } finally {
    fx.restore();
  }
});

test("POST /admin/payers rejects a missing name", async () => {
  const env = makeEnv();
  const res = await handleAdmin(
    req("POST", "/admin/payers", { headers: AUTH, body: { email: "a@b.com" } }),
    env,
  );
  assert.equal(res.status, 400);
  const body = (await res.json()) as { code: string };
  assert.equal(body.code, "invalid_arguments");
});

// ── POST /admin/invoices — dashboard "raise an invoice" ──────────────────────

test("POST /admin/invoices schedules a payment with a past dueDate (immediately overdue)", async () => {
  const env = makeEnv();
  const fx = stubPinch();
  try {
    const res = await handleAdmin(
      req("POST", "/admin/invoices", {
        headers: AUTH,
        body: {
          payerId: "pyr_existing",
          amountCents: 15000,
          description: "Overdue callout",
          dueDate: "2020-01-01",
        },
      }),
      env,
    );
    assert.equal(res.status, 201);
    const body = (await res.json()) as {
      invoice: { paymentId: string; amountCents: number; amountDisplay: string; dueDate: string };
    };
    assert.ok(body.invoice.paymentId.startsWith("pmt_"));
    assert.equal(body.invoice.amountCents, 15000);
    assert.equal(body.invoice.amountDisplay, "$150.00");
    assert.equal(body.invoice.dueDate, "2020-01-01");

    const paymentCreate = fx.calls.find((c) => c.method === "POST" && c.url === "/payments");
    const sent = JSON.parse(paymentCreate!.body!) as { payerId: string; amount: number; transactionDate: string };
    assert.equal(sent.payerId, "pyr_existing");
    assert.equal(sent.amount, 15000);
    assert.equal(sent.transactionDate, "2020-01-01");

    const entries = readAuditEntries(env);
    const entry = entries.find((e) => e.tool === "admin_create_invoice");
    assert.ok(entry, "admin_create_invoice must be audited");
    assert.equal(entry!.agentId, "admin");
    assert.equal(entry!.amountCents, 15000);
  } finally {
    fx.restore();
  }
});

test("POST /admin/invoices rejects a float amountCents", async () => {
  const env = makeEnv();
  const res = await handleAdmin(
    req("POST", "/admin/invoices", {
      headers: AUTH,
      body: { payerId: "pyr_1", amountCents: 12.5, description: "x", dueDate: "2026-01-01" },
    }),
    env,
  );
  assert.equal(res.status, 400);
  const body = (await res.json()) as { code: string };
  assert.equal(body.code, "invalid_arguments");
});

test("POST /admin/invoices rejects a malformed dueDate", async () => {
  const env = makeEnv();
  const res = await handleAdmin(
    req("POST", "/admin/invoices", {
      headers: AUTH,
      body: { payerId: "pyr_1", amountCents: 100, description: "x", dueDate: "01/01/2026" },
    }),
    env,
  );
  assert.equal(res.status, 400);
});

// ── GET/POST /admin/target — demo target payer ───────────────────────────────

test("GET /admin/target is null before anything is set", async () => {
  const env = makeEnv();
  const res = await handleAdmin(req("GET", "/admin/target", { headers: AUTH }), env);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { targetPayerId: string | null };
  assert.equal(body.targetPayerId, null);
});

test("POST /admin/target sets the target payer; GET reads it back", async () => {
  const env = makeEnv();
  const fx = stubFetch([{ id: "pyr_abc", firstName: "Abc", lastName: "Payer" }, []]);
  try {
    const set = await handleAdmin(
      req("POST", "/admin/target", { headers: AUTH, body: { payerId: "pyr_abc" } }),
      env,
    );
    assert.equal(set.status, 200);
    const setBody = (await set.json()) as { targetPayerId: string };
    assert.equal(setBody.targetPayerId, "pyr_abc");

    const got = await handleAdmin(req("GET", "/admin/target", { headers: AUTH }), env);
    const gotBody = (await got.json()) as { targetPayerId: string };
    assert.equal(gotBody.targetPayerId, "pyr_abc");
  } finally {
    fx.restore();
  }
});

test("POST /admin/target warms the /voice/init cache for the new target payer", async () => {
  const env = makeEnv();
  const fx = stubFetch([
    { id: "pyr_abc", firstName: "Abc", lastName: "Payer" },
    [
      {
        id: "pmt_1",
        status: "dishonoured",
        amount: 9900,
        transactionDate: "2026-07-01T00:00:00.0000000Z",
        description: "Overdue callout",
        payer: { id: "pyr_abc", firstName: "Abc", lastName: "Payer" },
      },
    ],
  ]);
  try {
    const res = await handleAdmin(
      req("POST", "/admin/target", { headers: AUTH, body: { payerId: "pyr_abc" } }),
      env,
    );
    assert.equal(res.status, 200);

    // Cache is warm BEFORE the response even returns — a single KV read away.
    const cached = (await env.GRANTS.get("init:context:pyr_abc", "json")) as {
      type: string;
      dynamic_variables: {
        payer_name: string;
        invoice_description: string;
        total_overdue: string;
      };
    } | null;
    assert.ok(cached, "expected the /voice/init cache to be warmed by /admin/target");
    assert.equal(cached!.type, "conversation_initiation_client_data");
    assert.equal(cached!.dynamic_variables.payer_name, "Abc Payer");
    assert.equal(cached!.dynamic_variables.invoice_description, "Overdue callout");
    assert.equal(cached!.dynamic_variables.total_overdue, "$99.00");

    // Confirms the warm build hit Pinch exactly twice (getPayer, listPaymentsForPayer).
    assert.equal(fx.calls.length, 2);
  } finally {
    fx.restore();
  }
});

test("POST /admin/target rejects a missing payerId", async () => {
  const env = makeEnv();
  const res = await handleAdmin(
    req("POST", "/admin/target", { headers: AUTH, body: {} }),
    env,
  );
  assert.equal(res.status, 400);
});

// ── POST /admin/call — ElevenLabs outbound call ───────────────────────────────

/**
 * Stub the ElevenLabs Twilio outbound-call endpoint, recording every call.
 * POST /admin/call ALSO warms the /voice/init cache (a Pinch getPayer +
 * listPaymentsForPayer) whenever it resolves a target payer, so anything that
 * isn't the outbound-call URL gets a benign Pinch-shaped response instead —
 * otherwise fetchPayerOverdueContext would choke on an ElevenLabs-shaped body.
 */
function stubElevenLabs(
  status = 200,
  body: unknown = {
    success: true,
    message: "Call initiated",
    conversation_id: "conv_abc123",
    callSid: "CA_abc123",
  },
  pinch: { payer?: unknown; payments?: unknown } = {},
) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });

    if (url.includes("/v1/convai/twilio/outbound-call")) {
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }
    // Cache-warming Pinch calls.
    if (url.includes("/payments/payer/")) {
      return new Response(JSON.stringify(pinch.payments ?? []), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify(pinch.payer ?? { id: "pyr_warm", firstName: "Warm", lastName: "Payer" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test("POST /admin/call rejects a non-E.164 number, zero ElevenLabs calls", async () => {
  const env = makeEnv();
  const fx = stubElevenLabs();
  try {
    const res = await handleAdmin(
      req("POST", "/admin/call", { headers: AUTH, body: { toNumber: "0412345678" } }),
      env,
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, "invalid_arguments");
    assert.equal(fx.calls.length, 0);
  } finally {
    fx.restore();
  }
});

test("POST /admin/call places the call, sets the target payer first, and audits the masked number", async () => {
  const env = makeEnv();
  const fx = stubElevenLabs();
  try {
    const res = await handleAdmin(
      req("POST", "/admin/call", {
        headers: AUTH,
        body: { toNumber: "+61412345678", payerId: "pyr_target1" },
      }),
      env,
    );
    assert.equal(res.status, 201);
    const body = (await res.json()) as {
      conversationId: string;
      callSid: string | null;
      targetPayerId: string | null;
    };
    assert.equal(body.conversationId, "conv_abc123");
    assert.equal(body.callSid, "CA_abc123");
    assert.equal(body.targetPayerId, "pyr_target1");

    // Target payer was set BEFORE the call, so /voice/init would already see it.
    assert.equal(await env.GRANTS.get("demo:targetPayerId"), "pyr_target1");

    // The /voice/init cache was warmed for that payer, right here, before the
    // call went out — so the webhook is a KV read by the time the phone rings.
    const cached = await env.GRANTS.get("init:context:pyr_target1", "json") as {
      type: string;
      dynamic_variables: { payer_name: string };
    } | null;
    assert.ok(cached, "expected the /voice/init cache to be warmed");
    assert.equal(cached!.type, "conversation_initiation_client_data");
    assert.equal(cached!.dynamic_variables.payer_name, "Warm Payer");

    // Exactly one call to the outbound-call endpoint, with our agent/phone-number ids
    // (plus the cache-warming Pinch calls, asserted above via their effect).
    const outboundCalls = fx.calls.filter((c) => c.url.includes("/v1/convai/twilio/outbound-call"));
    assert.equal(outboundCalls.length, 1);
    const call = outboundCalls[0]!;
    assert.ok(call.url.endsWith("/v1/convai/twilio/outbound-call"));
    assert.equal(call.method, "POST");
    assert.equal(call.headers["xi-api-key"], "xi_test_x");
    // The SAME warmed payload above is sent straight to ElevenLabs on this request.
    assert.deepEqual(call.body, {
      agent_id: "agent_test_x",
      agent_phone_number_id: "phnum_test_x",
      to_number: "+61412345678",
      conversation_initiation_client_data: { dynamic_variables: cached!.dynamic_variables },
    });

    // Audit trail has the number masked to its last 3 digits — never in full.
    const entries = readAuditEntries(env);
    const entry = entries.find((e) => e.tool === "admin_trigger_call");
    assert.ok(entry, "expected an admin_trigger_call audit entry");
    assert.equal(entry!.outcome, "allowed");
    assert.equal(entry!.resultId, "conv_abc123");
    const summary = entry!.paramsSummary as { toNumber: string; payerId: string | null };
    assert.equal(summary.toNumber, maskAccount("+61412345678"));
    assert.ok(summary.toNumber.endsWith("678") && !summary.toNumber.includes("412345"));
    assert.ok(!JSON.stringify(entry).includes("+61412345678"));
  } finally {
    fx.restore();
  }
});

test("POST /admin/call sends populated dynamic_variables straight to ElevenLabs on the outbound-call request", async () => {
  // "demo-agent" is DEFAULT_VOICE_AGENT_ID — warmVoiceInitCache always prices
  // agent_limits against it (same as /voice/init's own default).
  const grant: Grant = {
    agentId: "demo-agent",
    name: "Demo Voice Agent",
    maxPerTransactionCents: 200_000,
    maxDailyCents: 500_000,
    allowedTools: [],
    active: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const env = makeEnv({ grants: { "grant:demo-agent": JSON.stringify(grant) } });
  const fx = stubElevenLabs(200, undefined, {
    payer: { id: "pyr_dazza", firstName: "Dazza", lastName: "Fittings" },
    payments: [
      {
        id: "pmt_old",
        status: "dishonoured",
        amount: 45000,
        transactionDate: "2026-06-01T00:00:00.0000000Z",
        description: "Hot water system install",
        payer: { id: "pyr_dazza", firstName: "Dazza", lastName: "Fittings" },
      },
      {
        id: "pmt_recent",
        status: "scheduled",
        amount: 12000,
        transactionDate: "2026-07-20T00:00:00.0000000Z",
        description: "Callout + tap washer",
        payer: { id: "pyr_dazza", firstName: "Dazza", lastName: "Fittings" },
      },
    ],
  });
  try {
    const res = await handleAdmin(
      req("POST", "/admin/call", {
        headers: AUTH,
        body: { toNumber: "+61412345678", payerId: "pyr_dazza" },
      }),
      env,
    );
    assert.equal(res.status, 201);

    const outboundCall = fx.calls.find((c) => c.url.includes("/v1/convai/twilio/outbound-call"));
    assert.ok(outboundCall, "expected an outbound-call request");
    const sent = outboundCall!.body as {
      conversation_initiation_client_data: {
        dynamic_variables: {
          payer_name: string;
          invoice_description: string;
          total_overdue: string;
          days_overdue: number;
          today_au: string;
          agent_limits: string;
        };
      };
    };
    const vars = sent.conversation_initiation_client_data.dynamic_variables;
    assert.equal(vars.payer_name, "Dazza Fittings");
    // Oldest (dishonoured, June) overdue item wins over the more recent one.
    assert.equal(vars.invoice_description, "Hot water system install");
    assert.equal(vars.total_overdue, "$570.00"); // both are overdue: 450 + 120
    assert.ok(vars.days_overdue > 0);
    assert.ok(vars.today_au.length > 0);
    assert.equal(vars.agent_limits, "authorised up to $2,000.00 per payment, with $5,000.00 remaining today");
  } finally {
    fx.restore();
  }
});

test("POST /admin/call without payerId leaves the target payer untouched", async () => {
  const env = makeEnv();
  await env.GRANTS.put("demo:targetPayerId", "pyr_existing");
  const fx = stubElevenLabs();
  try {
    const res = await handleAdmin(
      req("POST", "/admin/call", { headers: AUTH, body: { toNumber: "+61412345678" } }),
      env,
    );
    assert.equal(res.status, 201);
    assert.equal(await env.GRANTS.get("demo:targetPayerId"), "pyr_existing");
  } finally {
    fx.restore();
  }
});

test("POST /admin/call surfaces an ElevenLabs failure as a structured 502 and audits it", async () => {
  const env = makeEnv();
  const fx = stubElevenLabs(200, { success: false, message: "No available outbound line" });
  try {
    const res = await handleAdmin(
      req("POST", "/admin/call", { headers: AUTH, body: { toNumber: "+61412345678" } }),
      env,
    );
    assert.equal(res.status, 502);
    const body = (await res.json()) as { error: boolean; code: string };
    assert.equal(body.error, true);
    assert.equal(body.code, "elevenlabs_call_failed");

    const entries = readAuditEntries(env);
    const entry = entries.find((e) => e.tool === "admin_trigger_call");
    assert.ok(entry);
    assert.equal(entry!.outcome, "error");
  } finally {
    fx.restore();
  }
});
