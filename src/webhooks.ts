/**
 * Pinch webhook receiver — POST /webhooks/pinch.
 *
 * Verified against docs.getpinch.com.au (2026-07): Pinch signs every webhook
 * delivery with header `pinch-signature: t=<unix_ts>,v2=<hex>`, where
 * `v2 = HMAC-SHA256("{t}.{raw body}", <webhook secret>)` and the secret
 * (`whsec_...`) is returned once when the webhook is registered
 * (`POST /webhooks` — see CLAUDE.md for exactly where to run that). We reject
 * anything with a missing/wrong signature or a stale timestamp (>5 min, same
 * default the Pinch .NET SDK uses) before touching the body at all.
 *
 * Payload envelope (Pinch supports both casings; we accept either):
 *   { Id, Type, EventDate, Metadata, Data } / { id, type, eventDate, ... }
 * `Data`'s shape depends on `Type` — see docs/events. We only care about
 * events that reference a payment (bank-results, scheduled-process,
 * realtime-payment, payment-created); for each payment id found, we re-fetch
 * it from Pinch directly (GET /payments/{id}) rather than trying to parse a
 * status out of every event shape — one canonical lookup is far more robust
 * than modelling 16+ event payloads by hand. Every other event type is still
 * recorded (for the audit/event log) but doesn't touch payment-status state.
 *
 * On each referenced payment we:
 *   1. Write/refresh `pinch:payment:<id>` (GRANTS binding) — a snapshot GET
 *      /admin/payments/status and the "recompute recovered from settled
 *      events" path in admin.ts's readRecovered() both read.
 *   2. Append an audit entry with outcome "settled" | "failed" | "processing"
 *      (mapped from Pinch's own status: transferred -> settled, dishonoured
 *      -> failed, everything else -> processing) so the dashboard's audit
 *      feed shows the real settlement lifecycle, not just agent actions.
 *
 * Idempotent: Pinch (like most webhook senders) may redeliver the same event,
 * so `pinch:event:<id>` is checked first and a duplicate is a 200 no-op.
 */

import { writeAudit } from "./permissions";
import { getPayment } from "./pinch";
import type { Env, StructuredError } from "./types";
import { isStructuredError } from "./types";
import { jsonResponse, nowIso, structuredError } from "./util";

// ── signature verification ────────────────────────────────────────────────────

const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000; // 5 minutes, matching Pinch's .NET SDK default

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function parseSignatureHeader(header: string): { t?: string; v2?: string } {
  const out: { t?: string; v2?: string } = {};
  for (const part of header.split(",")) {
    const [key, value] = part.split("=");
    if (key === "t" || key === "v2") out[key] = value;
  }
  return out;
}

/** Verify `pinch-signature: t=<unix_ts>,v2=<hex hmac>` against the raw body. */
async function verifyPinchSignature(
  rawBody: string,
  header: string | null,
  secret: string,
): Promise<boolean> {
  if (!header || !secret) return false;
  const { t, v2 } = parseSignatureHeader(header);
  if (!t || !v2) return false;

  const tsMs = Number(t) * 1000;
  if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > MAX_SIGNATURE_AGE_MS) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${rawBody}`));
  const computedHex = Array.from(new Uint8Array(sigBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return timingSafeEqualHex(computedHex, v2.toLowerCase());
}

// ── event payload parsing (Pinch supports PascalCase and camelCase) ──────────

interface PinchWebhookEvent {
  id?: string;
  type?: string;
  eventDate?: string;
  data: unknown;
}

function normaliseEvent(raw: unknown): PinchWebhookEvent {
  const o = (raw ?? {}) as Record<string, unknown>;
  const pick = (pascal: string, camel: string): unknown => o[pascal] ?? o[camel];
  return {
    id: pick("Id", "id") as string | undefined,
    type: pick("Type", "type") as string | undefined,
    eventDate: pick("EventDate", "eventDate") as string | undefined,
    data: pick("Data", "data"),
  };
}

/**
 * Pull every `pmt_...` id referenced by an event's Data, whichever of the
 * documented shapes it is: a single Payment object directly (payment-created,
 * realtime-payment), or an array under `payments`/`Payments` (bank-results,
 * scheduled-process). Anything else (payer/subscription/refund/dispute/
 * transfer/merchant events) yields no ids and is simply logged, not
 * status-tracked.
 */
function extractPaymentIds(data: unknown): string[] {
  if (!data || typeof data !== "object") return [];
  const ids = new Set<string>();

  const addFrom = (obj: unknown) => {
    if (!obj || typeof obj !== "object") return;
    const o = obj as Record<string, unknown>;
    const id = o.Id ?? o.id ?? o.PaymentId ?? o.paymentId;
    if (typeof id === "string" && id.startsWith("pmt_")) ids.add(id);
  };

  const d = data as Record<string, unknown>;
  addFrom(d); // Data IS the payment (payment-created, realtime-payment)
  const list = d.Payments ?? d.payments;
  if (Array.isArray(list)) for (const item of list) addFrom(item);

  return [...ids];
}

// ── outcome mapping ────────────────────────────────────────────────────────────

type SettlementOutcome = "settled" | "failed" | "processing";

/** Pinch's own payment status -> our settlement-lifecycle vocabulary. */
function outcomeForStatus(status: string): SettlementOutcome {
  if (status === "transferred") return "settled";
  if (status === "dishonoured") return "failed";
  return "processing";
}

// ── KV keys (GRANTS binding — same "misc state" bucket as demo:/seedpayer:/init:) ──

function eventKey(eventId: string): string {
  return `pinch:event:${eventId}`;
}

/** Exported so admin.ts can list/read the same snapshot for the dashboard. */
export function paymentStatusKey(paymentId: string): string {
  return `pinch:payment:${paymentId}`;
}

export interface PaymentStatusRecord {
  paymentId: string;
  status: string;
  outcome: SettlementOutcome;
  amountCents: number;
  payerId?: string;
  eventType: string;
  updatedAt: string;
}

// ── handler ──────────────────────────────────────────────────────────────────

async function handlePinchWebhook(request: Request, env: Env): Promise<Response> {
  const rawBody = await request.text();
  const verified = await verifyPinchSignature(
    rawBody,
    request.headers.get("pinch-signature"),
    env.PINCH_WEBHOOK_SECRET,
  );
  if (!verified) {
    return jsonResponse(
      structuredError("unauthorized", "Missing or invalid pinch-signature header."),
      401,
    );
  }

  let parsedBody: unknown;
  try {
    parsedBody = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return jsonResponse(structuredError("invalid_body", "Request body is not valid JSON."), 400);
  }

  const evt = normaliseEvent(parsedBody);
  if (!evt.id || !evt.type) {
    return jsonResponse(
      structuredError("invalid_body", "Event is missing id/type."),
      400,
    );
  }

  // Idempotent: Pinch may redeliver — don't reprocess/re-audit the same event.
  const alreadyProcessed = await env.GRANTS.get(eventKey(evt.id));
  if (alreadyProcessed) {
    return jsonResponse({ ok: true, duplicate: true, eventId: evt.id, type: evt.type });
  }
  await env.GRANTS.put(
    eventKey(evt.id),
    JSON.stringify({ id: evt.id, type: evt.type, eventDate: evt.eventDate, receivedAt: nowIso() }),
  );

  const paymentIds = extractPaymentIds(evt.data);
  const updated: Array<{ paymentId: string; status: string; outcome: SettlementOutcome }> = [];

  for (const paymentId of paymentIds) {
    const payment = await getPayment(env, paymentId);
    if (isStructuredError(payment)) continue; // best-effort — a lookup failure doesn't fail the webhook

    const status = typeof payment.status === "string" ? payment.status : "unknown";
    const outcome = outcomeForStatus(status);
    const amountCents = typeof payment.amount === "number" ? payment.amount : 0;
    const payerId = payment.payer?.id;

    const record: PaymentStatusRecord = {
      paymentId,
      status,
      outcome,
      amountCents,
      ...(payerId ? { payerId } : {}),
      eventType: evt.type,
      updatedAt: nowIso(),
    };
    await env.GRANTS.put(paymentStatusKey(paymentId), JSON.stringify(record));

    await writeAudit(env, {
      ts: nowIso(),
      agentId: "pinch-webhook",
      tool: "webhook_payment_status",
      paramsSummary: { paymentId, eventType: evt.type, status, ...(payerId ? { payerId } : {}) },
      outcome,
      amountCents,
      resultId: paymentId,
    });

    updated.push({ paymentId, status, outcome });
  }

  return jsonResponse({ ok: true, eventId: evt.id, type: evt.type, updated });
}

// ── router ─────────────────────────────────────────────────────────────────────

/** Entry point wired to /webhooks/*. Auth IS the pinch-signature verification. */
export async function handleWebhooks(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const sub = url.pathname.replace(/^\/webhooks\/?/, "");

  if (sub === "pinch") {
    if (method === "POST") return handlePinchWebhook(request, env);
    return jsonResponse(
      structuredError("method_not_allowed", "Allowed: POST."),
      405,
      { allow: "POST" },
    );
  }

  return jsonResponse(
    structuredError("not_found", `No webhook route for ${method} /webhooks/${sub}.`),
    404,
  );
}
