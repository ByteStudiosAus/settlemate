/**
 * Tests for the Worker entry point (src/index.ts) — specifically the outer
 * try/catch that's supposed to guarantee hard-rule #4 (never leak a raw
 * exception). Every route call must be `await`ed: `try { return handleX(); }
 * catch {}` does NOT catch a rejection from an async handleX — the try block
 * completes (handing back the pending promise) before the rejection happens,
 * so the catch has nothing left to observe. Without `await`, a downstream
 * throw bypasses this safety net entirely and surfaces to Cloudflare as a raw
 * 1101, not our structured 500. Run: `npm run test:index`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import worker from "../src/index";
import type { Env } from "../src/types";

/** A KV whose every method throws — simulates a genuine Cloudflare KV outage,
 * which admin.ts's defensive per-record handling does NOT (and can't) guard
 * against, since it fails before any record is even read. */
function makeThrowingKV() {
  return {
    async get() {
      throw new Error("simulated KV outage");
    },
    async put() {
      throw new Error("simulated KV outage");
    },
    async delete() {
      throw new Error("simulated KV outage");
    },
    async list() {
      throw new Error("simulated KV outage");
    },
  } as unknown as KVNamespace;
}

function makeEnv(): Env {
  return {
    GRANTS: makeThrowingKV(),
    SPEND: makeThrowingKV(),
    AUDIT: makeThrowingKV(),
    TOKENS: makeThrowingKV(),
    IDEMPOTENCY: makeThrowingKV(),
    PINCH_API_BASE: "https://api.getpinch.com.au/test",
    PINCH_AUTH_URL: "https://auth.getpinch.com.au/connect/token",
    PINCH_VERSION: "2020.1",
    ENABLE_TWILIO: "false",
    PINCH_SECRET_KEY: "sk_test_x",
    PINCH_PUBLISHABLE_KEY: "app_test_x",
    PINCH_MERCHANT_ID: "",
    ADMIN_KEY: "admin-secret",
    VOICE_SECRET: "voice-secret",
    ELEVENLABS_API_BASE: "https://api.elevenlabs.io",
    ELEVENLABS_API_KEY: "xi_test_x",
    ELEVENLABS_AGENT_ID: "agent_test_x",
    ELEVENLABS_PHONE_NUMBER_ID: "phnum_test_x",
    PINCH_WEBHOOK_SECRET: "whsec_test_x",
  } as unknown as Env;
}

const fakeCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

async function callFetch(
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<Response> {
  const req = new Request(`https://worker.example${path}`, {
    headers,
    ...(body !== undefined ? { method: "POST", body } : {}),
  });
  // If index.ts regresses to `return handleX(...)` without `await`, this
  // rejects instead of resolving — surfacing here as an uncaught test failure,
  // exactly mirroring the raw-1101-instead-of-500 production symptom.
  return worker.fetch(req, makeEnv(), fakeCtx);
}

/** A validly-signed webhook body, so the request gets PAST signature
 * verification (pure crypto, no KV) into the KV-touching code that throws. */
async function signedWebhookBody(): Promise<{ body: string; signature: string }> {
  const body = JSON.stringify({ id: "evt_1", type: "payment-created", data: { id: "pmt_1" } });
  const t = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("whsec_test_x"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`));
  const hex = Array.from(new Uint8Array(sigBuf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return { body, signature: `t=${t},v2=${hex}` };
}

test("a downstream async exception on /admin/* never leaks as an unhandled rejection — becomes a structured 500", async () => {
  const res = await callFetch("/admin/grants", { authorization: "Bearer admin-secret" });
  assert.equal(res.status, 500);
  const body = (await res.json()) as { error: boolean; code: string };
  assert.equal(body.error, true);
  assert.equal(body.code, "internal_error");
});

test("a downstream async exception on /voice/* never leaks as an unhandled rejection — becomes a structured 500", async () => {
  // /voice/tool with no payerId resolves the demo target via
  // admin.ts's resolveTargetPayerId(), which reads GRANTS directly with no
  // try/catch of its own (unlike pinch.ts's functions, which defensively
  // convert failures into structured errors) — a clean async-throw path.
  const res = await callFetch(
    "/voice/tool",
    { "x-voice-secret": "voice-secret" },
    JSON.stringify({ agentId: "demo-agent", tool: "get_agent_limits", params: {} }),
  );
  assert.equal(res.status, 500);
  const body = (await res.json()) as { error: boolean; code: string };
  assert.equal(body.error, true);
});

test("a downstream async exception on /webhooks/* never leaks as an unhandled rejection — becomes a structured 500", async () => {
  const { body, signature } = await signedWebhookBody();
  const res = await callFetch("/webhooks/pinch", { "pinch-signature": signature }, body);
  assert.equal(res.status, 500);
  const responseBody = (await res.json()) as { error: boolean; code: string };
  assert.equal(responseBody.error, true);
});

test("/health stays open and unaffected", async () => {
  const res = await callFetch("/health");
  assert.equal(res.status, 200);
});
