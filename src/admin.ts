/**
 * REST admin + dashboard facade.
 *
 * This is the surface the merchant (and the dashboard UI) uses to hand an agent
 * its scoped authority — the piece that makes the MCP tools usable at all: until
 * a grant exists, every `enforce()` returns `no_grant`. It also serves the three
 * read/bootstrap endpoints the dashboard renders from.
 *
 * Every route requires `Authorization: Bearer <ADMIN_KEY>` (CLAUDE.md). Auth is
 * checked once, up front. Responses always go out via `jsonResponse()`; failures
 * use the structured-error shape (hard-rule #4) so no raw exception ever leaks.
 *
 * Admin operations are the AUTHORITY that issues grants, so they call the Pinch
 * client and KV directly — they do NOT pass through the agent permissions engine
 * (an agent is scoped; the merchant is not).
 */

import { z } from "zod";

import { triggerOutboundCall } from "./elevenlabs";
import { getGrant, putGrant, writeAudit } from "./permissions";
import { warmVoiceInitCache, type VoiceInitPayload } from "./voice";
import {
  cancelScheduledPayment,
  createBankSource,
  createPayer,
  createScheduledPayment,
  listPaymentsForPayer,
  listScheduledPayments,
  type PinchPayment,
} from "./pinch";
import { TOOL_NAMES } from "./tools";
import { paymentStatusKey, type PaymentStatusRecord } from "./webhooks";
import type { AuditEntry, Env, Grant, StructuredError } from "./types";
import { isStructuredError } from "./types";
import {
  formatCents,
  jsonResponse,
  maskAccount,
  maskParams,
  newId,
  nowIso,
  structuredError,
  todayAU,
} from "./util";

/** Agent id under which dashboard-initiated admin mutations are audited. */
const ADMIN_AGENT_ID = "admin";

// ── auth ─────────────────────────────────────────────────────────────────────

/** Constant-ish bearer check against ADMIN_KEY. Returns true when authorised. */
function isAuthorised(request: Request, env: Env): boolean {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return !!token && !!env.ADMIN_KEY && token === env.ADMIN_KEY;
}

// ── grant validation ─────────────────────────────────────────────────────────

const centsField = z
  .number()
  .int("must be integer cents (no floats)")
  .positive("must be > 0");

const createGrantSchema = z.object({
  agentId: z.string().min(1),
  name: z.string().min(1),
  maxPerTransactionCents: centsField,
  maxDailyCents: centsField,
  allowedTools: z.array(z.string().min(1)).optional(),
  active: z.boolean().optional(),
});

const patchGrantSchema = z
  .object({
    name: z.string().min(1),
    maxPerTransactionCents: centsField,
    maxDailyCents: centsField,
    allowedTools: z.array(z.string().min(1)),
    active: z.boolean(),
  })
  .partial();

/** Parse a JSON body against a schema, returning a StructuredError on bad shape. */
async function parseBody<S extends z.ZodTypeAny>(
  request: Request,
  schema: S,
): Promise<z.infer<S> | StructuredError> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return structuredError("invalid_body", "Request body is not valid JSON.");
  }
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
    );
    return structuredError("invalid_arguments", issues.join("; "), { issues });
  }
  return parsed.data;
}

// ── KV list helper (bounded cursor walk) ─────────────────────────────────────

/** Collect all keys under a prefix, walking the cursor up to a page cap. */
async function listKeys(kv: KVNamespace, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  const MAX_PAGES = 20; // hackathon bound; 20 * 1000 keys is plenty
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await kv.list({ prefix, cursor, limit: 1000 });
    for (const k of res.keys) keys.push(k.name);
    if (res.list_complete) break;
    cursor = res.cursor;
  }
  return keys;
}

// ── grant routes ─────────────────────────────────────────────────────────────

async function createGrant(request: Request, env: Env): Promise<Response> {
  const body = await parseBody(request, createGrantSchema);
  if (isStructuredError(body)) return jsonResponse(body, 400);

  const now = nowIso();
  const grant: Grant = {
    agentId: body.agentId,
    name: body.name,
    maxPerTransactionCents: body.maxPerTransactionCents,
    maxDailyCents: body.maxDailyCents,
    allowedTools: body.allowedTools ?? [...TOOL_NAMES],
    active: body.active ?? true,
    createdAt: now,
    updatedAt: now,
  };
  await putGrant(env, grant);
  return jsonResponse({ grant }, 201);
}

async function listGrants(env: Env): Promise<Response> {
  const keys = await listKeys(env.GRANTS, "grant:");
  const grants: Grant[] = [];
  for (const key of keys) {
    const g = (await env.GRANTS.get(key, "json")) as Grant | null;
    if (g) grants.push(g);
  }
  grants.sort((a, b) => a.agentId.localeCompare(b.agentId));
  return jsonResponse({ count: grants.length, grants });
}

async function getOneGrant(env: Env, agentId: string): Promise<Response> {
  const grant = await getGrant(env, agentId);
  if (!grant) {
    return jsonResponse(
      structuredError("not_found", `No grant for agent "${agentId}".`),
      404,
    );
  }
  return jsonResponse({ grant });
}

async function patchGrant(
  request: Request,
  env: Env,
  agentId: string,
): Promise<Response> {
  const existing = await getGrant(env, agentId);
  if (!existing) {
    return jsonResponse(
      structuredError("not_found", `No grant for agent "${agentId}".`),
      404,
    );
  }
  const body = await parseBody(request, patchGrantSchema);
  if (isStructuredError(body)) return jsonResponse(body, 400);

  const updated: Grant = {
    ...existing,
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.maxPerTransactionCents !== undefined
      ? { maxPerTransactionCents: body.maxPerTransactionCents }
      : {}),
    ...(body.maxDailyCents !== undefined ? { maxDailyCents: body.maxDailyCents } : {}),
    ...(body.allowedTools !== undefined ? { allowedTools: body.allowedTools } : {}),
    ...(body.active !== undefined ? { active: body.active } : {}),
    updatedAt: nowIso(),
  };
  await putGrant(env, updated);
  return jsonResponse({ grant: updated });
}

// ── audit route (dashboard: newest-first + limit) ─────────────────────────────

async function readAudit(env: Env, url: URL): Promise<Response> {
  const limitRaw = Number(url.searchParams.get("limit"));
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 500) : 50;
  const agentId = url.searchParams.get("agentId")?.trim() || undefined;

  // Keys are `audit:<ISO-ts>:<rand>` — ISO timestamps sort lexicographically, so
  // reversing the ascending key list yields newest-first.
  const keys = (await listKeys(env.AUDIT, "audit:")).sort().reverse();

  const entries: AuditEntry[] = [];
  for (const key of keys) {
    if (entries.length >= limit) break;
    const entry = (await env.AUDIT.get(key, "json")) as AuditEntry | null;
    if (!entry) continue;
    if (agentId && entry.agentId !== agentId) continue;
    entries.push(entry);
  }
  return jsonResponse({ count: entries.length, limit, entries });
}

// ── recovered route (sum of settled == transferred) ───────────────────────────

/**
 * Sum settled (outcome "settled") payments from our own webhook-fed snapshot
 * (`pinch:payment:<id>`, written by src/webhooks.ts) rather than re-scanning
 * all of Pinch. Returns null when there's nothing recorded yet (e.g. the
 * webhook hasn't been registered, or no event has landed) — the caller falls
 * back to the live Pinch scan in that case. NOT a strict superset of the live
 * scan: a payment that settled before the webhook existed, or whose delivery
 * was missed, won't be counted here — "where possible", not authoritative.
 */
async function recoveredFromEventsSnapshot(
  env: Env,
  payerIdFilter: string | undefined,
): Promise<{ recoveredCents: number; count: number } | null> {
  const keys = await listKeys(env.GRANTS, "pinch:payment:");
  if (keys.length === 0) return null;

  let recoveredCents = 0;
  let count = 0;
  for (const key of keys) {
    let record: PaymentStatusRecord | null = null;
    try {
      record = (await env.GRANTS.get(key, "json")) as PaymentStatusRecord | null;
    } catch {
      continue; // one corrupted record must not sink the whole recovered total
    }
    if (!record || record.outcome !== "settled") continue;
    if (payerIdFilter && record.payerId !== payerIdFilter) continue;
    recoveredCents += record.amountCents;
    count++;
  }
  return { recoveredCents, count };
}

async function readRecovered(env: Env, url: URL): Promise<Response> {
  const agentId = url.searchParams.get("payerId")?.trim() || undefined;
  const scope = agentId ? { payerId: agentId } : "all-scheduled";

  const fromEvents = await recoveredFromEventsSnapshot(env, agentId);
  if (fromEvents) {
    return jsonResponse({
      recoveredCents: fromEvents.recoveredCents,
      recoveredDisplay: formatCents(fromEvents.recoveredCents),
      count: fromEvents.count,
      scope,
      source: "webhook-events",
    });
  }

  const collect = async (): Promise<PinchPayment[] | StructuredError> => {
    if (agentId) return listPaymentsForPayer(env, agentId);
    const out: PinchPayment[] = [];
    const MAX_PAGES = 5;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await listScheduledPayments(env, page, 100);
      if (isStructuredError(res)) return res;
      out.push(...res.data);
      if (page >= res.totalPages) break;
    }
    return out;
  };

  const payments = await collect();
  if (isStructuredError(payments)) return jsonResponse(payments, 502);

  const settled = payments.filter((p) => p.status === "transferred");
  const recoveredCents = settled.reduce(
    (sum, p) => sum + (typeof p.amount === "number" ? p.amount : 0),
    0,
  );
  return jsonResponse({
    recoveredCents,
    recoveredDisplay: formatCents(recoveredCents),
    count: settled.length,
    scope,
    source: "live-scan",
  });
}

// ── payments status route (dashboard: counts by status) ───────────────────────

/** GET /admin/payments/status — live count-by-status breakdown for the dashboard. */
async function readPaymentsStatus(env: Env): Promise<Response> {
  const collected: PinchPayment[] = [];
  const MAX_PAGES = 5;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await listScheduledPayments(env, page, 100);
    if (isStructuredError(res)) return jsonResponse(res, 502);
    collected.push(...res.data);
    if (page >= res.totalPages) break;
  }

  const counts = new Map<string, { count: number; totalCents: number }>();
  for (const p of collected) {
    const status = typeof p.status === "string" ? p.status : "unknown";
    const entry = counts.get(status) ?? { count: 0, totalCents: 0 };
    entry.count++;
    entry.totalCents += typeof p.amount === "number" ? p.amount : 0;
    counts.set(status, entry);
  }

  const statuses = [...counts.entries()]
    .map(([status, v]) => ({
      status,
      count: v.count,
      totalCents: v.totalCents,
      totalDisplay: formatCents(v.totalCents),
    }))
    .sort((a, b) => b.count - a.count);

  return jsonResponse({ totalPayments: collected.length, statuses });
}

// ── seed / reset helpers ──────────────────────────────────────────────────────

/** KV key that maps a stable name slug to a Pinch payer id across seeds. */
function payerRegistryKey(slug: string): string {
  return `seedpayer:${slug}`;
}

function nameSlug(firstName: string, lastName: string): string {
  return `${firstName}-${lastName}`.toLowerCase().replace(/[^a-z0-9-]/g, "");
}

/** Look up a previously-seeded payer id, or create a new payer and register it. */
async function resolveOrCreatePayer(
  env: Env,
  spec: DemoPayerSpec,
): Promise<{ id: string; created: boolean } | StructuredError> {
  const slug = nameSlug(spec.firstName, spec.lastName);
  const key = payerRegistryKey(slug);
  const existing = await env.GRANTS.get(key);
  if (existing) return { id: existing, created: false };

  const payer = await createPayer(env, {
    firstName: spec.firstName,
    emailAddress: spec.emailAddress,
    lastName: spec.lastName,
    mobileNumber: spec.mobileNumber,
  });
  if (isStructuredError(payer)) return payer;
  await env.GRANTS.put(key, payer.id);
  return { id: payer.id, created: true };
}

/** Delete all scheduled payments for a payer. Returns count deleted. */
async function deleteScheduledForPayer(env: Env, payerId: string): Promise<number> {
  const payments = await listPaymentsForPayer(env, payerId);
  if (isStructuredError(payments)) return 0;
  const scheduled = payments.filter((p) => p.status === "scheduled");
  let deleted = 0;
  for (const p of scheduled) {
    const res = await cancelScheduledPayment(env, p.id);
    if (!isStructuredError(res)) deleted++;
  }
  return deleted;
}

// ── seed route (demo bootstrap) ───────────────────────────────────────────────

const DEMO_AGENT_ID = "demo-agent";

interface DemoPayerSpec {
  firstName: string;
  lastName: string;
  emailAddress: string;
  mobileNumber: string;
  accountName: string;
  bsb: string;
  accountNumber: string;
  invoices: Array<{ amountCents: number; daysAgo: number; description: string }>;
}

// Tradie-flavoured demo customers with overdue invoices. Sandbox test bank
// details; account numbers are masked in the response (hard-rule #3).
const DEMO_PAYERS: DemoPayerSpec[] = [
  {
    firstName: "Dazza",
    lastName: "Fittings",
    emailAddress: "dazza@example.com",
    mobileNumber: "0400000001",
    accountName: "Dazza's Plumbing",
    bsb: "062-000",
    accountNumber: "12345678",
    invoices: [
      { amountCents: 45000, daysAgo: 14, description: "Hot water system install" },
      { amountCents: 12000, daysAgo: 5, description: "Callout + tap washer" },
    ],
  },
  {
    firstName: "Shazza",
    lastName: "Sparks",
    emailAddress: "shazza@example.com",
    mobileNumber: "0400000002",
    accountName: "Shazza Electrical",
    bsb: "062-001",
    accountNumber: "23456789",
    invoices: [
      { amountCents: 88000, daysAgo: 21, description: "Switchboard upgrade" },
    ],
  },
  {
    firstName: "Bluey",
    lastName: "Groundworks",
    emailAddress: "bluey@example.com",
    mobileNumber: "0400000003",
    accountName: "Bluey Landscaping",
    bsb: "062-002",
    accountNumber: "34567890",
    invoices: [
      { amountCents: 32000, daysAgo: 9, description: "Retaining wall — deposit" },
      { amountCents: 15050, daysAgo: 2, description: "Turf + delivery" },
    ],
  },
];

/** A YYYY-MM-DD date `days` before today (AU), for back-dating overdue demo invoices. */
function daysAgoDate(days: number): string {
  const [y, m, day] = todayAU().split("-").map(Number) as [number, number, number];
  // Anchor at UTC noon so the day subtraction never slips across a DST boundary.
  const base = new Date(Date.UTC(y, m - 1, day, 12));
  base.setUTCDate(base.getUTCDate() - days);
  return base.toISOString().slice(0, 10);
}

async function seedPayers(env: Env): Promise<{
  payers: Array<Record<string, unknown>>;
  invoices: Array<Record<string, unknown>>;
}> {
  const payers: Array<Record<string, unknown>> = [];
  const invoices: Array<Record<string, unknown>> = [];

  for (const spec of DEMO_PAYERS) {
    const resolved = await resolveOrCreatePayer(env, spec);
    if (isStructuredError(resolved)) {
      payers.push({ name: `${spec.firstName} ${spec.lastName}`, error: resolved });
      continue;
    }
    const { id: payerId, created } = resolved;

    // Only attach a bank source on first creation — re-seeding reuses the existing one.
    if (created) {
      await createBankSource(env, payerId, {
        bankAccountName: spec.accountName,
        bankAccountBsb: spec.bsb,
        bankAccountNumber: spec.accountNumber,
      });
    }

    payers.push({
      payerId,
      name: `${spec.firstName} ${spec.lastName}`,
      account: maskAccount(spec.accountNumber),
      reused: !created,
    });

    for (const inv of spec.invoices) {
      const dueDate = daysAgoDate(inv.daysAgo);
      const created2 = await createScheduledPayment(env, {
        payerId,
        amount: inv.amountCents,
        transactionDate: dueDate,
        description: inv.description,
      });
      invoices.push(
        isStructuredError(created2)
          ? { payerId, dueDate, description: inv.description, error: created2 }
          : {
              paymentId: created2.id,
              payerId,
              dueDate,
              amountCents: inv.amountCents,
              amountDisplay: formatCents(inv.amountCents),
              description: inv.description,
            },
      );
    }
  }

  return { payers, invoices };
}

async function seed(env: Env): Promise<Response> {
  const now = nowIso();

  const grant: Grant = {
    agentId: DEMO_AGENT_ID,
    name: "Demo Voice Agent",
    maxPerTransactionCents: 200_000,
    maxDailyCents: 500_000,
    allowedTools: [...TOOL_NAMES],
    active: true,
    createdAt: now,
    updatedAt: now,
  };
  await putGrant(env, grant);

  const { payers, invoices } = await seedPayers(env);

  return jsonResponse(
    {
      seeded: true,
      grant,
      payers,
      invoices,
      note: `Connect an MCP client with ?agentId=${DEMO_AGENT_ID} to drive the tools.`,
    },
    201,
  );
}

/**
 * POST /admin/reset — clean slate for demo mornings.
 * 1. Discover all demo payers (seed registry) + any Soapbox payer (a2a demo).
 * 2. Delete every scheduled payment for each.
 * 3. Re-seed invoices (payers are reused by registry, not re-created).
 */
async function reset(env: Env): Promise<Response> {
  // Collect all registered demo payer ids.
  const payerIds: string[] = [];
  for (const spec of DEMO_PAYERS) {
    const slug = nameSlug(spec.firstName, spec.lastName);
    const id = await env.GRANTS.get(payerRegistryKey(slug));
    if (id) payerIds.push(id);
  }
  // Also include Soapbox (created by a2a demo) if registered.
  const soapboxId = await env.GRANTS.get(payerRegistryKey("soapbox-pty-ltd"));
  if (soapboxId) payerIds.push(soapboxId);

  // Delete all scheduled payments for each payer.
  let totalDeleted = 0;
  const deleteSummary: Array<{ payerId: string; deleted: number }> = [];
  for (const payerId of payerIds) {
    const deleted = await deleteScheduledForPayer(env, payerId);
    totalDeleted += deleted;
    deleteSummary.push({ payerId, deleted });
  }

  // Re-seed invoices (payers reused via registry).
  const { payers, invoices } = await seedPayers(env);

  return jsonResponse({
    reset: true,
    paymentsDeleted: totalDeleted,
    deleteSummary,
    payers,
    invoices,
  });
}

// ── ad-hoc debtor creation (dashboard: "add a customer") ─────────────────────

const createPayerAdminSchema = z.object({
  name: z.string().min(1),
  email: z.string().email().optional(),
  mobile: z.string().min(1).optional(),
});

/** "Dazza Fittings" -> { firstName: "Dazza", lastName: "Fittings" }. */
function splitName(name: string): { firstName: string; lastName?: string } {
  const parts = name.trim().replace(/\s+/g, " ").split(" ");
  const firstName = parts[0]!;
  const lastName = parts.length > 1 ? parts.slice(1).join(" ") : undefined;
  return { firstName, lastName };
}

/** A stand-in email when the dashboard doesn't collect one. Unique per call. */
function placeholderEmail(name: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ".")
      .replace(/^\.+|\.+$/g, "") || "customer";
  return `${slug}.${newId().slice(0, 8)}@example.com`;
}

const DEMO_BANK_BSB = "062-000";

/** A plausible 8-digit AU account number for the demo bank source we attach. */
function randomAccountNumber(): string {
  const bytes = crypto.getRandomValues(new Uint32Array(1));
  return String(bytes[0]! % 100_000_000).padStart(8, "0");
}

/**
 * POST /admin/payers — dashboard "add a customer" action: creates a Pinch payer
 * and attaches a demo bank-account source (same fire-and-forget pattern as
 * `seedPayers` — a source failure doesn't block returning the created payer).
 * Bypasses the agent permissions engine (this IS the authority), but is still
 * audited under the "admin" actor so it shows up in the audit trail.
 */
async function createPayerAdmin(request: Request, env: Env): Promise<Response> {
  const body = await parseBody(request, createPayerAdminSchema);
  if (isStructuredError(body)) return jsonResponse(body, 400);

  const { firstName, lastName } = splitName(body.name);
  const emailAddress = body.email ?? placeholderEmail(body.name);
  const paramsSummary = maskParams({ name: body.name, email: body.email, mobile: body.mobile });

  const payer = await createPayer(env, {
    firstName,
    emailAddress,
    ...(lastName ? { lastName } : {}),
    ...(body.mobile ? { mobileNumber: body.mobile } : {}),
  });
  if (isStructuredError(payer)) {
    await writeAudit(env, {
      ts: nowIso(),
      agentId: ADMIN_AGENT_ID,
      tool: "admin_create_payer",
      paramsSummary,
      outcome: "error",
      reason: payer.code,
    });
    return jsonResponse(payer, 502);
  }

  await createBankSource(env, payer.id, {
    bankAccountName: body.name,
    bankAccountBsb: DEMO_BANK_BSB,
    bankAccountNumber: randomAccountNumber(),
  });

  await writeAudit(env, {
    ts: nowIso(),
    agentId: ADMIN_AGENT_ID,
    tool: "admin_create_payer",
    paramsSummary,
    outcome: "allowed",
    amountCents: 0,
    resultId: payer.id,
  });

  return jsonResponse({ payerId: payer.id, name: body.name }, 201);
}

// ── ad-hoc invoice creation (dashboard: "raise an invoice") ──────────────────

const createInvoiceAdminSchema = z.object({
  payerId: z.string().min(1),
  amountCents: centsField,
  description: z.string().min(1),
  // No "must be in the future" check: a past dueDate is the point — it lets
  // the dashboard raise an invoice that is immediately overdue for a demo.
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD"),
});

/**
 * POST /admin/invoices — schedules a payment for an existing payer. Same
 * bypass-the-engine + audit-as-admin shape as createPayerAdmin.
 */
async function createInvoiceAdmin(request: Request, env: Env): Promise<Response> {
  const body = await parseBody(request, createInvoiceAdminSchema);
  if (isStructuredError(body)) return jsonResponse(body, 400);

  const created = await createScheduledPayment(env, {
    payerId: body.payerId,
    amount: body.amountCents,
    transactionDate: body.dueDate,
    description: body.description,
  });

  if (isStructuredError(created)) {
    await writeAudit(env, {
      ts: nowIso(),
      agentId: ADMIN_AGENT_ID,
      tool: "admin_create_invoice",
      paramsSummary: body,
      outcome: "error",
      reason: created.code,
      amountCents: body.amountCents,
    });
    return jsonResponse(created, 502);
  }

  await writeAudit(env, {
    ts: nowIso(),
    agentId: ADMIN_AGENT_ID,
    tool: "admin_create_invoice",
    paramsSummary: body,
    outcome: "allowed",
    amountCents: body.amountCents,
    resultId: created.id,
  });

  return jsonResponse(
    {
      invoice: {
        paymentId: created.id,
        payerId: body.payerId,
        amountCents: body.amountCents,
        amountDisplay: formatCents(body.amountCents),
        dueDate: body.dueDate,
        description: body.description,
        status: created.status,
      },
    },
    201,
  );
}

// ── demo target payer (voice: which debtor "TARGET" resolves to) ────────────

/** KV key (GRANTS namespace): the payerId /voice/tool resolves "TARGET" to. */
const TARGET_KV_KEY = "demo:targetPayerId";

const setTargetSchema = z.object({ payerId: z.string().min(1) });

async function readTarget(env: Env): Promise<Response> {
  const targetPayerId = await env.GRANTS.get(TARGET_KV_KEY);
  return jsonResponse({ targetPayerId: targetPayerId ?? null });
}

/**
 * POST /admin/target — sets the demo target payer, then warms the /voice/init
 * cache for it right away (best-effort: a warm-cache failure here just means
 * the NEXT /voice/init falls back to its own cold-build-with-timeout path, so
 * it must never block or fail this response).
 */
async function setTarget(request: Request, env: Env): Promise<Response> {
  const body = await parseBody(request, setTargetSchema);
  if (isStructuredError(body)) return jsonResponse(body, 400);
  await env.GRANTS.put(TARGET_KV_KEY, body.payerId);
  await warmVoiceInitCache(env, body.payerId).catch(() => {});
  return jsonResponse({ targetPayerId: body.payerId });
}

/**
 * Resolve the demo target payer for /voice/tool: an explicit override set via
 * POST /admin/target, else the first seeded payer (DEMO_PAYERS[0], via the
 * same seed registry `reset()` reads) if it has been seeded. Null if neither
 * exists yet (e.g. before the first /admin/seed).
 */
export async function resolveTargetPayerId(env: Env): Promise<string | null> {
  const explicit = await env.GRANTS.get(TARGET_KV_KEY);
  if (explicit) return explicit;
  const first = DEMO_PAYERS[0];
  if (!first) return null;
  const slug = nameSlug(first.firstName, first.lastName);
  return env.GRANTS.get(payerRegistryKey(slug));
}

// ── outbound call (dashboard: "call this debtor") ────────────────────────────

// E.164: a leading '+', a non-zero first digit, up to 15 digits total.
const E164_REGEX = /^\+[1-9]\d{1,14}$/;

const triggerCallSchema = z.object({
  toNumber: z.string().regex(E164_REGEX, "must be E.164, e.g. +61412345678"),
  payerId: z.string().min(1).optional(),
});

/**
 * POST /admin/call — places an outbound call from our ElevenLabs agent (via
 * its Twilio-connected number) to `toNumber`. When `payerId` is given it's
 * set as the demo target payer FIRST — same TARGET_KV_KEY as /admin/target.
 *
 * The /voice/init payload for whichever payer the call will brief the agent
 * on (the one just set, or an existing target) is built and cached right
 * here via warmVoiceInitCache — the SAME fetchPayerOverdueContext code path
 * /voice/init itself uses — and its `dynamic_variables` are sent straight to
 * ElevenLabs as `conversation_initiation_client_data` on this same
 * outbound-call request. That's belt-and-braces alongside POST /voice/init
 * (which still fires when the call connects): the agent has payer context
 * from the moment the call is placed, not dependent on the webhook landing
 * in time. Building the payload here is best-effort — a Pinch failure must
 * never block the call itself from going out.
 *
 * Bypasses the agent permissions engine (this IS the authority) but is still
 * audited under "admin"; the destination number is masked to its last 3
 * digits in the audit trail, never logged in full (hard-rule #3 spirit —
 * applied here to a phone number, not a bank account).
 */
async function triggerCall(request: Request, env: Env): Promise<Response> {
  const body = await parseBody(request, triggerCallSchema);
  if (isStructuredError(body)) return jsonResponse(body, 400);

  if (body.payerId) {
    await env.GRANTS.put(TARGET_KV_KEY, body.payerId);
  }

  const effectiveTargetPayerId = await resolveTargetPayerId(env);
  let initPayload: VoiceInitPayload | undefined;
  if (effectiveTargetPayerId) {
    initPayload = await warmVoiceInitCache(env, effectiveTargetPayerId).catch(() => undefined);
  }

  const paramsSummary = {
    toNumber: maskAccount(body.toNumber),
    payerId: body.payerId ?? null,
  };

  const result = await triggerOutboundCall(env, body.toNumber, initPayload?.dynamic_variables);
  if (isStructuredError(result)) {
    await writeAudit(env, {
      ts: nowIso(),
      agentId: ADMIN_AGENT_ID,
      tool: "admin_trigger_call",
      paramsSummary,
      outcome: "error",
      reason: result.code,
    });
    return jsonResponse(result, 502);
  }

  await writeAudit(env, {
    ts: nowIso(),
    agentId: ADMIN_AGENT_ID,
    tool: "admin_trigger_call",
    paramsSummary,
    outcome: "allowed",
    resultId: result.conversationId,
  });

  return jsonResponse(
    {
      conversationId: result.conversationId,
      callSid: result.callSid,
      targetPayerId: body.payerId ?? null,
    },
    201,
  );
}

// ── router ─────────────────────────────────────────────────────────────────────

/**
 * Entry point wired to /admin/* and /rest/* (and /api/* dashboard aliases).
 * Every route is bearer-gated on ADMIN_KEY.
 */
export async function handleAdmin(request: Request, env: Env): Promise<Response> {
  if (!isAuthorised(request, env)) {
    return jsonResponse(
      structuredError("unauthorized", "Missing or invalid admin bearer token."),
      401,
      { "www-authenticate": "Bearer" },
    );
  }

  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  // Normalise the sub-path: strip the surface prefix so /admin/grants,
  // /rest/grants and /api/grants all resolve the same.
  const sub = url.pathname.replace(/^\/(admin|rest|api)\/?/, "");

  // ── grants ───────────────────────────────────────────────────────────────
  if (sub === "grants") {
    if (method === "POST") return createGrant(request, env);
    if (method === "GET") return listGrants(env);
    return methodNotAllowed(["GET", "POST"]);
  }
  const grantMatch = /^grants\/(.+)$/.exec(sub);
  if (grantMatch) {
    const agentId = decodeURIComponent(grantMatch[1]!);
    if (method === "GET") return getOneGrant(env, agentId);
    if (method === "PATCH") return patchGrant(request, env, agentId);
    return methodNotAllowed(["GET", "PATCH"]);
  }

  // ── dashboard reads + seed ─────────────────────────────────────────────────
  if (sub === "audit" && method === "GET") return readAudit(env, url);
  if (sub === "recovered" && method === "GET") return readRecovered(env, url);
  if (sub === "payments/status" && method === "GET") return readPaymentsStatus(env);
  if (sub === "seed" && method === "POST") return seed(env);
  if (sub === "reset" && method === "POST") return reset(env);

  // ── ad-hoc debtor + invoice creation ──────────────────────────────────────
  if (sub === "payers") {
    if (method === "POST") return createPayerAdmin(request, env);
    return methodNotAllowed(["POST"]);
  }
  if (sub === "invoices") {
    if (method === "POST") return createInvoiceAdmin(request, env);
    return methodNotAllowed(["POST"]);
  }

  // ── demo target payer ─────────────────────────────────────────────────────
  if (sub === "target") {
    if (method === "GET") return readTarget(env);
    if (method === "POST") return setTarget(request, env);
    return methodNotAllowed(["GET", "POST"]);
  }

  // ── outbound call ──────────────────────────────────────────────────────────
  if (sub === "call") {
    if (method === "POST") return triggerCall(request, env);
    return methodNotAllowed(["POST"]);
  }

  return jsonResponse(
    structuredError("not_found", `No admin route for ${method} /${sub}.`),
    404,
  );
}

function methodNotAllowed(allow: string[]): Response {
  return jsonResponse(
    structuredError("method_not_allowed", `Allowed: ${allow.join(", ")}.`),
    405,
    { allow: allow.join(", ") },
  );
}
