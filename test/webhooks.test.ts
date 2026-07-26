/**
 * Tests for the Pinch webhook receiver (src/webhooks.ts). Signatures are
 * constructed with the SAME HMAC-SHA256 scheme the handler verifies with, so
 * these tests exercise the real crypto path, not a mocked one. Pinch itself
 * (GET /payments/{id}, called to look up a payment's canonical status) is
 * stubbed at the `fetch` level. Run: `npm run test:webhooks`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { handleWebhooks } from "../src/webhooks";
import type { AuditEntry, Env } from "../src/types";

const SECRET = "whsec_test_abc123";

// ── KV mock ─────────────────────────────────────────────────────────────────

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

function makeEnv() {
  const env = {
    GRANTS: makeKV(),
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
    VOICE_SECRET: "voice",
    ELEVENLABS_API_BASE: "https://api.elevenlabs.io",
    ELEVENLABS_API_KEY: "xi_test_x",
    ELEVENLABS_AGENT_ID: "agent_test_x",
    ELEVENLABS_PHONE_NUMBER_ID: "phnum_test_x",
    PINCH_WEBHOOK_SECRET: SECRET,
  } as unknown as Env;
  return env;
}

function readAuditEntries(env: Env): AuditEntry[] {
  const store = (env.AUDIT as unknown as { _store: Map<string, string> })._store;
  return [...store.entries()].filter(([k]) => k.startsWith("audit:")).map(([, v]) => JSON.parse(v) as AuditEntry);
}

// ── real HMAC-SHA256 signing, mirroring src/webhooks.ts's verification ────────

async function sign(rawBody: string, secret: string, timestampSeconds = Math.floor(Date.now() / 1000)): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestampSeconds}.${rawBody}`));
  const hex = Array.from(new Uint8Array(sigBuf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `t=${timestampSeconds},v2=${hex}`;
}

function req(body: string, signatureHeader?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signatureHeader !== undefined) headers["pinch-signature"] = signatureHeader;
  return new Request("https://worker.example/webhooks/pinch", { method: "POST", headers, body });
}

function stubFetch(bodies: unknown[]) {
  const calls: Array<{ url: string; method: string }> = [];
  let i = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? "GET" });
    const body = bodies[Math.min(i, bodies.length - 1)];
    i++;
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

// ── signature verification ────────────────────────────────────────────────────

test("POST /webhooks/pinch with no pinch-signature header -> 401", async () => {
  const env = makeEnv();
  const res = await handleWebhooks(req(JSON.stringify({ id: "evt_1", type: "payment-created", data: {} })), env);
  assert.equal(res.status, 401);
  const body = (await res.json()) as { error: boolean; code: string };
  assert.equal(body.error, true);
  assert.equal(body.code, "unauthorized");
});

test("POST /webhooks/pinch with a wrong signature -> 401", async () => {
  const env = makeEnv();
  const rawBody = JSON.stringify({ id: "evt_1", type: "payment-created", data: {} });
  const res = await handleWebhooks(req(rawBody, "t=1234567890,v2=deadbeef"), env);
  assert.equal(res.status, 401);
});

test("POST /webhooks/pinch with a valid signature but a STALE timestamp -> 401", async () => {
  const env = makeEnv();
  const rawBody = JSON.stringify({ id: "evt_1", type: "payment-created", data: {} });
  const tenMinutesAgo = Math.floor(Date.now() / 1000) - 10 * 60;
  const sig = await sign(rawBody, SECRET, tenMinutesAgo);
  const res = await handleWebhooks(req(rawBody, sig), env);
  assert.equal(res.status, 401);
});

test("POST /webhooks/pinch with a signature computed against a DIFFERENT body -> 401", async () => {
  const env = makeEnv();
  const sig = await sign(JSON.stringify({ id: "evt_tampered" }), SECRET);
  const rawBody = JSON.stringify({ id: "evt_1", type: "payment-created", data: {} });
  const res = await handleWebhooks(req(rawBody, sig), env);
  assert.equal(res.status, 401);
});

test("POST /webhooks/pinch with a correctly signed body is accepted", async () => {
  const env = makeEnv();
  const rawBody = JSON.stringify({
    id: "evt_ok1",
    type: "payment-created",
    data: { id: "pmt_1", amount: 5000, status: "scheduled", payer: { id: "pyr_1" } },
  });
  const fx = stubFetch([{ id: "pmt_1", amount: 5000, status: "scheduled", payer: { id: "pyr_1" } }]);
  try {
    const sig = await sign(rawBody, SECRET);
    const res = await handleWebhooks(req(rawBody, sig), env);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; eventId: string };
    assert.equal(body.ok, true);
    assert.equal(body.eventId, "evt_ok1");
  } finally {
    fx.restore();
  }
});

// ── payload casing (Pinch supports PascalCase and camelCase) ──────────────────

test("POST /webhooks/pinch accepts PascalCase field names (Id/Type/Data)", async () => {
  const env = makeEnv();
  const rawBody = JSON.stringify({
    Id: "evt_pascal1",
    Type: "realtime-payment",
    EventDate: "2026-07-26T00:00:00Z",
    Data: { Id: "pmt_pascal", Amount: 5000, Status: "approved" },
  });
  const fx = stubFetch([{ id: "pmt_pascal", amount: 5000, status: "approved" }]);
  try {
    const sig = await sign(rawBody, SECRET);
    const res = await handleWebhooks(req(rawBody, sig), env);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; updated: Array<{ paymentId: string; outcome: string }> };
    assert.equal(body.ok, true);
    assert.equal(body.updated[0]?.paymentId, "pmt_pascal");
  } finally {
    fx.restore();
  }
});

// ── payment status -> outcome mapping + KV snapshot + audit ───────────────────

test("a 'transferred' payment is recorded as outcome 'settled', in KV and the audit log", async () => {
  const env = makeEnv();
  const rawBody = JSON.stringify({
    id: "evt_settle1",
    type: "bank-results",
    data: { payments: [{ id: "pmt_settled1" }] },
  });
  const fx = stubFetch([{ id: "pmt_settled1", amount: 12000, status: "transferred", payer: { id: "pyr_9" } }]);
  try {
    const sig = await sign(rawBody, SECRET);
    const res = await handleWebhooks(req(rawBody, sig), env);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { updated: Array<{ paymentId: string; status: string; outcome: string }> };
    assert.equal(body.updated[0]?.outcome, "settled");

    const snapshot = (await env.GRANTS.get("pinch:payment:pmt_settled1", "json")) as {
      outcome: string;
      amountCents: number;
      payerId: string;
    } | null;
    assert.ok(snapshot);
    assert.equal(snapshot!.outcome, "settled");
    assert.equal(snapshot!.amountCents, 12000);
    assert.equal(snapshot!.payerId, "pyr_9");

    const entries = readAuditEntries(env);
    const entry = entries.find((e) => e.resultId === "pmt_settled1");
    assert.ok(entry);
    assert.equal(entry!.outcome, "settled");
    assert.equal(entry!.agentId, "pinch-webhook");
  } finally {
    fx.restore();
  }
});

test("a 'dishonoured' payment is recorded as outcome 'failed'", async () => {
  const env = makeEnv();
  const rawBody = JSON.stringify({
    id: "evt_fail1",
    type: "bank-results",
    data: { payments: [{ id: "pmt_failed1" }] },
  });
  const fx = stubFetch([{ id: "pmt_failed1", amount: 5000, status: "dishonoured" }]);
  try {
    const sig = await sign(rawBody, SECRET);
    const res = await handleWebhooks(req(rawBody, sig), env);
    const body = (await res.json()) as { updated: Array<{ outcome: string }> };
    assert.equal(body.updated[0]?.outcome, "failed");
  } finally {
    fx.restore();
  }
});

test("a 'scheduled' payment is recorded as outcome 'processing'", async () => {
  const env = makeEnv();
  const rawBody = JSON.stringify({
    id: "evt_proc1",
    type: "scheduled-process",
    data: { payments: [{ id: "pmt_proc1" }] },
  });
  const fx = stubFetch([{ id: "pmt_proc1", amount: 5000, status: "scheduled" }]);
  try {
    const sig = await sign(rawBody, SECRET);
    const res = await handleWebhooks(req(rawBody, sig), env);
    const body = (await res.json()) as { updated: Array<{ outcome: string }> };
    assert.equal(body.updated[0]?.outcome, "processing");
  } finally {
    fx.restore();
  }
});

// ── events unrelated to a specific payment are logged, not status-tracked ─────

test("a subscription-cancelled event is accepted with zero payment-status updates", async () => {
  const env = makeEnv();
  const rawBody = JSON.stringify({
    id: "evt_sub_cancel1",
    type: "subscription-cancelled",
    data: { id: "sub_1", status: "cancelled" },
  });
  const fx = stubFetch([{}]);
  try {
    const sig = await sign(rawBody, SECRET);
    const res = await handleWebhooks(req(rawBody, sig), env);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; updated: unknown[] };
    assert.equal(body.ok, true);
    assert.equal(body.updated.length, 0);
    assert.equal(fx.calls.length, 0, "no GET /payments/{id} lookup for a non-payment event");
  } finally {
    fx.restore();
  }
});

// ── idempotency: Pinch may redeliver the same event ────────────────────────────

test("a redelivered event (same id) is a no-op duplicate, not reprocessed", async () => {
  const env = makeEnv();
  const rawBody = JSON.stringify({
    id: "evt_dup1",
    type: "bank-results",
    data: { payments: [{ id: "pmt_dup1" }] },
  });
  const fx = stubFetch([{ id: "pmt_dup1", amount: 5000, status: "transferred" }]);
  try {
    const sig1 = await sign(rawBody, SECRET);
    const first = await handleWebhooks(req(rawBody, sig1), env);
    assert.equal(first.status, 200);
    assert.equal(fx.calls.length, 1);

    // Redelivery: same event id, freshly (re)signed as Pinch would on retry.
    const sig2 = await sign(rawBody, SECRET);
    const second = await handleWebhooks(req(rawBody, sig2), env);
    assert.equal(second.status, 200);
    const body = (await second.json()) as { ok: boolean; duplicate: boolean };
    assert.equal(body.duplicate, true);
    assert.equal(fx.calls.length, 1, "no new GET /payments/{id} lookup on a duplicate delivery");
  } finally {
    fx.restore();
  }
});

// ── malformed input ──────────────────────────────────────────────────────────

test("POST /webhooks/pinch with a validly-signed but non-JSON body -> 400", async () => {
  const env = makeEnv();
  const rawBody = "not json";
  const sig = await sign(rawBody, SECRET);
  const res = await handleWebhooks(req(rawBody, sig), env);
  assert.equal(res.status, 400);
});

test("POST /webhooks/pinch with a signed body missing id/type -> 400", async () => {
  const env = makeEnv();
  const rawBody = JSON.stringify({ data: {} });
  const sig = await sign(rawBody, SECRET);
  const res = await handleWebhooks(req(rawBody, sig), env);
  assert.equal(res.status, 400);
});

// ── routing ──────────────────────────────────────────────────────────────────

test("GET /webhooks/pinch -> 405 (POST only)", async () => {
  const env = makeEnv();
  const res = await handleWebhooks(
    new Request("https://worker.example/webhooks/pinch", { method: "GET" }),
    env,
  );
  assert.equal(res.status, 405);
});

test("POST /webhooks/unknown -> 404", async () => {
  const env = makeEnv();
  const res = await handleWebhooks(
    new Request("https://worker.example/webhooks/unknown", { method: "POST" }),
    env,
  );
  assert.equal(res.status, 404);
});
