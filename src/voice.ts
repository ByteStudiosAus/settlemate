/**
 * Voice webhook surface — the bridge between an ElevenLabs Conversational AI agent
 * and our permissions engine.
 *
 * Four routes, all gated on the shared secret header `X-Voice-Secret` (===
 * env.VOICE_SECRET). A missing/wrong secret is a 401 structured error; nothing
 * else runs.
 *
 *   POST /voice/tool           — generic tool invocation. Runs the EXACT same
 *                                tool.run -> permissions.enforce() path as MCP,
 *                                and ALWAYS returns a `speech` string a voice
 *                                agent can read aloud verbatim.
 *   GET  /voice/context/:payer — call-start context injection (name, today's date
 *                                in AU English, overdue invoices, the agent's own
 *                                authority) so the voice agent never guesses.
 *   POST /voice/init            — ElevenLabs conversation-initiation client-data
 *                                webhook. Same context as /voice/context, resolved
 *                                for the demo target payer and reshaped into
 *                                ElevenLabs' `conversation_initiation_client_data`
 *                                response with flat `dynamic_variables`. Answers
 *                                from a 60s KV cache (warmed by admin.ts) when
 *                                available; a cold build races a 750ms budget and
 *                                falls back to placeholders rather than miss
 *                                ElevenLabs' sub-1s latency requirement.
 *   GET  /voice/payers         — seeded payers (id + name + total overdue) for
 *                                quickly picking a demo debtor.
 *
 * Amounts are integer cents end to end (hard-rule #2); dollars only ever appear in
 * the human-facing `*Display` / `speech` strings, built with formatCents. Errors
 * are structured objects, never thrown stack traces (hard-rule #4).
 */

import { resolveTargetPayerId } from "./admin";
import { getGrant, getSpentToday } from "./permissions";
import {
  getPayer,
  listPaymentsForPayer,
  listScheduledPayments,
  type PinchPayment,
} from "./pinch";
import { getTool, type ToolContext } from "./tools";
import type { Declined, Env, StructuredError } from "./types";
import { isDeclined, isStructuredError } from "./types";
import { formatCents, jsonResponse, structuredError, todayAU } from "./util";

/** The voice agent's identity when a route doesn't carry an explicit agentId. */
const DEFAULT_VOICE_AGENT_ID = "demo-agent";

// ── auth ─────────────────────────────────────────────────────────────────────

/** True when the request carries the correct X-Voice-Secret shared header. */
function isVoiceAuthorised(request: Request, env: Env): boolean {
  const supplied = request.headers.get("x-voice-secret")?.trim();
  return !!supplied && !!env.VOICE_SECRET && supplied === env.VOICE_SECRET;
}

// ── AU natural-language date helpers (human edge only) ────────────────────────

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** 1 -> "1st", 2 -> "2nd", 25 -> "25th". */
function ordinal(day: number): string {
  const rem100 = day % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${day}th`;
  switch (day % 10) {
    case 1: return `${day}st`;
    case 2: return `${day}nd`;
    case 3: return `${day}rd`;
    default: return `${day}th`;
  }
}

/** "2026-07-25" -> "the 25th of July" (no year — natural for spoken prose). */
function naturalDate(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  const month = Number(m[2]);
  const day = Number(m[3]);
  const name = MONTHS[month - 1] ?? "";
  return `the ${ordinal(day)} of ${name}`;
}

/** As naturalDate, but prefixes "today, " when the date IS today (AU). */
function naturalDateRelative(ymd: string): string {
  return ymd === todayAU() ? `today, ${naturalDate(ymd)}` : naturalDate(ymd);
}

/** "Friday 25 July 2026" in the Australia/Sydney zone (for prompt injection). */
function todayNaturalAU(): string {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Sydney",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).formatToParts(new Date());
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("weekday")} ${get("day")} ${get("month")} ${get("year")}`;
}

/** Whole days a YYYY-MM-DD due date is behind today (AU). Never negative. */
function daysOverdue(dueYmd: string, todayYmd: string): number {
  const toUtc = (ymd: string): number => {
    const [y, mo, d] = ymd.split("-").map(Number) as [number, number, number];
    return Date.UTC(y, mo - 1, d, 12);
  };
  const diff = Math.round((toUtc(todayYmd) - toUtc(dueYmd)) / 86_400_000);
  return Math.max(0, diff);
}

// ── overdue helpers ───────────────────────────────────────────────────────────

/**
 * The payer id for a payment. Pinch nests it under `payer.id` — there is NO
 * top-level `payerId` on list/get responses. Returns undefined if absent.
 */
function paymentPayerId(p: PinchPayment): string | undefined {
  const id = p.payer?.id;
  return typeof id === "string" && id ? id : undefined;
}

/**
 * A payment's transaction date as a bare YYYY-MM-DD. Pinch sends a full ISO
 * datetime ("2026-06-22T14:00:00.0000000Z"); we slice off the date part so date
 * maths and display never choke on the time/zone suffix.
 */
function paymentDateYmd(p: PinchPayment): string | undefined {
  const raw = p.transactionDate;
  if (typeof raw !== "string") return undefined;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(raw);
  return m ? m[1] : undefined;
}

/** Overdue == a dishonoured debit, or a scheduled one whose date has passed. */
function isOverdue(p: PinchPayment, today: string): boolean {
  if (p.status === "dishonoured") return true;
  const date = paymentDateYmd(p);
  return p.status === "scheduled" && date !== undefined && date < today;
}

function paymentAmount(p: PinchPayment): number {
  return typeof p.amount === "number" ? p.amount : 0;
}

// ── speech: SUCCESS per tool ───────────────────────────────────────────────────

/**
 * One natural sentence a voice agent reads aloud verbatim on a successful call.
 * Built from the caller's params (reliable inputs) and the tool result.
 */
function successSpeech(
  tool: string,
  params: Record<string, unknown>,
  result: unknown,
): string {
  const r = (result ?? {}) as Record<string, unknown>;

  switch (tool) {
    case "create_payer": {
      const first = (r.firstName as string) ?? (params.firstName as string) ?? "";
      const last = (r.lastName as string) ?? (params.lastName as string) ?? "";
      const name = [first, last].filter(Boolean).join(" ").trim();
      return name
        ? `Done — I've set up ${name} as a customer.`
        : `Done — I've set up the customer.`;
    }

    case "add_bank_account":
      return `Done — the bank account is linked and ready for direct debit.`;

    case "create_invoice": {
      const amt = formatCents(Number(params.amountCents) || 0);
      const due = typeof params.dueDate === "string" ? params.dueDate : todayAU();
      return `Done — I've scheduled a payment of ${amt} for ${naturalDateRelative(due)}.`;
    }

    case "charge_now": {
      const amt = formatCents(Number(params.amountCents) || 0);
      const dishonoured = r.status === "dishonoured" || Boolean(r.dishonour);
      return dishonoured
        ? `The charge of ${amt} was declined by the bank, so nothing was taken.`
        : `Done — I've charged ${amt} to the account just now.`;
    }

    case "create_payment_plan": {
      const schedule = Array.isArray(r.schedule)
        ? (r.schedule as Array<Record<string, unknown>>)
        : [];
      const n = Number(r.instalments) || schedule.length;
      const freq = (r.frequency as string) ?? "";
      const first = schedule[0];
      const per =
        (first?.amountDisplay as string) ??
        formatCents(Number(first?.amountCents) || 0);
      const firstDate =
        typeof first?.date === "string" ? (first.date as string) : todayAU();
      return (
        `Done — ${n} ${freq} instalments of ${per}, ` +
        `first debit scheduled for ${naturalDateRelative(firstDate)}.`
      );
    }

    case "cancel_payment_plan":
      return `Done — I've cancelled the payment plan. Nothing further will be debited.`;

    case "check_payment_status": {
      const amt = (r.amountDisplay as string) ?? "the payment";
      if (r.settled || r.status === "transferred") {
        return `That payment of ${amt} has settled — the money's come through.`;
      }
      if (r.dishonoured || r.status === "dishonoured") {
        return `That payment of ${amt} bounced — the debit was dishonoured.`;
      }
      if (r.status === "scheduled") {
        return `That payment of ${amt} is scheduled and hasn't run yet.`;
      }
      return `That payment of ${amt} is currently ${(r.status as string) ?? "pending"}.`;
    }

    case "list_overdue": {
      const overdue = Array.isArray(r.overdue)
        ? (r.overdue as Array<Record<string, unknown>>)
        : [];
      const count = Number(r.count) || overdue.length;
      if (count === 0) return `Good news — there's nothing overdue on that account.`;
      const totalCents = overdue.reduce(
        (sum, o) => sum + (Number(o.amountCents) || 0),
        0,
      );
      const total = formatCents(totalCents);
      return count === 1
        ? `There's 1 overdue payment, totalling ${total}.`
        : `There are ${count} overdue payments, totalling ${total}.`;
    }

    case "get_agent_limits": {
      if (r.active === false) {
        return `I don't have an active payment authority at the moment, so I can't take payments.`;
      }
      const perTx = (r.maxPerTransactionDisplay as string) ?? "my limit";
      const remaining = (r.remainingTodayDisplay as string) ?? "my daily limit";
      return `My authority is up to ${perTx} per payment, with ${remaining} left to spend today.`;
    }

    default:
      return `Done.`;
  }
}

// ── speech: DECLINE per reason ─────────────────────────────────────────────────

/** One natural sentence for a permission refusal, flagging it for the owner. */
function declineSpeech(d: Declined): string {
  const flag = `so I'll flag it for the business owner instead`;
  switch (d.reason) {
    case "no_grant":
      return `I can't do that — I don't have an active payment authority set up, ${flag}.`;
    case "grant_inactive":
      return `I can't do that — my payment authority has been paused, ${flag}.`;
    case "tool_not_allowed":
      return `I'm not authorised to do that particular action, ${flag}.`;
    case "exceeds_per_transaction_limit":
      return (
        `I can't set that up — it's over my ${formatCents(d.limitCents ?? 0)} ` +
        `per-payment authority, ${flag}.`
      );
    case "exceeds_daily_limit":
      return (
        `I can't set that up — it would take me over my ${formatCents(d.limitCents ?? 0)} ` +
        `daily limit, ${flag}.`
      );
    default:
      return `I can't do that right now, ${flag}.`;
  }
}

// ── speech: ERROR per code ─────────────────────────────────────────────────────

/** One natural sentence for a downstream/validation error. */
function errorSpeech(err: StructuredError): string {
  const flag = `so I'll flag it for the business owner instead`;
  switch (err.code) {
    case "no_payment_source":
      return `I couldn't find a bank account on file for that customer, ${flag}.`;
    case "no_target_payer":
      return `I don't have a customer selected for that yet, ${flag}.`;
    case "invalid_arguments":
      return `I didn't quite catch the details for that — could you say them again?`;
    case "unknown_tool":
      return `I don't know how to do that — I'll flag it for the business owner instead.`;
    case "plan_creation_failed":
      return `Something went wrong setting up that payment plan, so nothing was scheduled, ${flag}.`;
    case "invalid_start_date":
      return `I can't start a payment plan in the past — should I schedule it starting from today instead?`;
    case "plan_total_mismatch": {
      const d = (err.details ?? {}) as {
        planTotalDisplay?: string;
        overdueTotalDisplay?: string;
      };
      if (d.planTotalDisplay && d.overdueTotalDisplay) {
        return (
          `That plan totals ${d.planTotalDisplay} but the balance is ` +
          `${d.overdueTotalDisplay} — should I set it for the full amount?`
        );
      }
      return `That plan total doesn't match the customer's overdue balance — should I set it for the full amount instead?`;
    }
    default:
      return `Sorry, something went wrong on our end and I couldn't complete that, ${flag}.`;
  }
}

// ── POST /voice/tool ───────────────────────────────────────────────────────────

interface VoiceToolBody {
  agentId?: unknown;
  tool?: unknown;
  params?: unknown;
  [k: string]: unknown;
}

/**
 * Extract the tool params. Nested `{ params: {...} }` is used verbatim; when
 * `params` is absent we accept a FLAT body and treat every top-level field other
 * than `agentId` and `tool` as the params object.
 */
function extractParams(body: VoiceToolBody): Record<string, unknown> {
  if (body.params && typeof body.params === "object" && !Array.isArray(body.params)) {
    return body.params as Record<string, unknown>;
  }
  const { agentId: _a, tool: _t, params: _p, ...rest } = body;
  return rest;
}

async function handleVoiceTool(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(
      structuredError("invalid_body", "Request body is not valid JSON."),
      400,
    );
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return jsonResponse(
      structuredError("invalid_body", "Request body must be a JSON object."),
      400,
    );
  }

  const b = body as VoiceToolBody;
  const agentId = typeof b.agentId === "string" ? b.agentId.trim() : "";
  const toolName = typeof b.tool === "string" ? b.tool.trim() : "";
  if (!agentId) {
    return jsonResponse(
      structuredError("invalid_arguments", "A string `agentId` is required."),
      400,
    );
  }
  if (!toolName) {
    return jsonResponse(
      structuredError("invalid_arguments", "A string `tool` is required."),
      400,
    );
  }

  let params = extractParams(b);

  // Resolve the demo target payer when the caller omits payerId or hands us
  // the literal "TARGET" — lets a voice script say "the target customer"
  // without knowing which payer that is right now.
  const rawPayerId = params.payerId;
  if (rawPayerId === undefined || rawPayerId === "TARGET") {
    const target = await resolveTargetPayerId(env);
    if (target) {
      params = { ...params, payerId: target };
    } else if (rawPayerId === "TARGET") {
      const err = structuredError(
        "no_target_payer",
        "No demo target payer is set, and no seeded payer exists yet.",
      );
      return jsonResponse({ ok: false, error: err, speech: errorSpeech(err) });
    }
  }

  const tool = getTool(toolName);
  if (!tool) {
    const err = structuredError("unknown_tool", `Unknown tool "${toolName}".`);
    // Voice-readable: a wrong tool pick is fed back, not thrown as a transport fault.
    return jsonResponse({ ok: false, error: err, speech: errorSpeech(err) });
  }

  const ctx: ToolContext = { env, agentId };
  let result: unknown;
  try {
    // The SAME path MCP uses: tool.run -> permissions.enforce() -> Pinch.
    result = await tool.run(ctx, params);
  } catch {
    const err = structuredError("internal_error", "The tool call failed unexpectedly.");
    return jsonResponse({ ok: false, error: err, speech: errorSpeech(err) });
  }

  if (isDeclined(result)) {
    return jsonResponse({ ok: false, declined: result, speech: declineSpeech(result) });
  }
  if (isStructuredError(result)) {
    return jsonResponse({ ok: false, error: result, speech: errorSpeech(result) });
  }
  return jsonResponse({
    ok: true,
    result,
    speech: successSpeech(toolName, params, result),
  });
}

// ── GET /voice/context/:payerId ────────────────────────────────────────────────

/** Compute the calling agent's live authority (per-tx + remaining-today display). */
async function agentLimits(
  env: Env,
  agentId: string,
): Promise<{ maxPerTransactionDisplay: string; remainingTodayDisplay: string }> {
  const grant = await getGrant(env, agentId);
  if (!grant || !grant.active) {
    return { maxPerTransactionDisplay: "$0.00", remainingTodayDisplay: "$0.00" };
  }
  const spentToday = await getSpentToday(env, agentId);
  const remaining = Math.max(0, grant.maxDailyCents - spentToday);
  return {
    maxPerTransactionDisplay: formatCents(grant.maxPerTransactionCents),
    remainingTodayDisplay: formatCents(remaining),
  };
}

interface OverdueInvoice {
  paymentId: string;
  description: string;
  amountCents: number;
  amountDisplay: string;
  dueDate: string;
  daysOverdue: number;
}

interface PayerOverdueContext {
  payerName: string;
  invoices: OverdueInvoice[];
  totalOverdueCents: number;
}

/**
 * Fetch a payer + their overdue invoices from Pinch and shape them for the
 * voice surface. Shared by GET /voice/context/:payerId and POST /voice/init.
 */
async function fetchPayerOverdueContext(
  env: Env,
  payerId: string,
): Promise<StructuredError | PayerOverdueContext> {
  const today = todayAU();

  const payer = await getPayer(env, payerId);
  if (isStructuredError(payer)) return payer;

  const payments = await listPaymentsForPayer(env, payerId);
  if (isStructuredError(payments)) return payments;

  const overdue = payments.filter((p) => isOverdue(p, today));
  const invoices = overdue.map((p): OverdueInvoice => {
    const cents = paymentAmount(p);
    const dueDate = paymentDateYmd(p) ?? today;
    return {
      paymentId: p.id,
      description: typeof p.description === "string" ? p.description : "Invoice",
      amountCents: cents,
      amountDisplay: formatCents(cents),
      dueDate,
      daysOverdue: daysOverdue(dueDate, today),
    };
  });
  const totalOverdueCents = overdue.reduce((sum, p) => sum + paymentAmount(p), 0);

  const firstName = typeof payer.firstName === "string" ? payer.firstName : "";
  const lastName = typeof payer.lastName === "string" ? payer.lastName : "";
  const payerName = [firstName, lastName].filter(Boolean).join(" ").trim() || payer.id;

  return { payerName, invoices, totalOverdueCents };
}

async function handleVoiceContext(
  request: Request,
  env: Env,
  payerId: string,
): Promise<Response> {
  const url = new URL(request.url);
  const agentId = url.searchParams.get("agentId")?.trim() || DEFAULT_VOICE_AGENT_ID;

  const ctx = await fetchPayerOverdueContext(env, payerId);
  if (isStructuredError(ctx)) return jsonResponse(ctx, 502);

  return jsonResponse({
    payerName: ctx.payerName,
    todayAU: todayNaturalAU(),
    invoices: ctx.invoices,
    totalOverdueDisplay: formatCents(ctx.totalOverdueCents),
    agentLimits: await agentLimits(env, agentId),
  });
}

// ── POST /voice/init (ElevenLabs conversation initiation webhook) ─────────────

/**
 * ElevenLabs measures call-start webhook latency and expects a response well
 * under a second; a cold build (Pinch OAuth + 2 sequential API calls) can run
 * ~3s, which is too slow. We cache the finished payload in KV keyed only by
 * payerId (`init:context:<payerId>`, GRANTS binding, 60s TTL — Cloudflare KV's
 * TTL floor) and warm it proactively from admin.ts whenever the target payer
 * changes, so by the time a call actually connects this is a single KV read.
 */
const INIT_CACHE_TTL_SECONDS = 60;
/** Hard latency budget for a cold build; past this we answer with placeholders. */
export const INIT_BUILD_TIMEOUT_MS = 750;

function initCacheKey(payerId: string): string {
  return `init:context:${payerId}`;
}

export interface VoiceInitPayload {
  type: "conversation_initiation_client_data";
  dynamic_variables: {
    payer_name: string;
    invoice_description: string;
    total_overdue: string;
    days_overdue: number;
    today_au: string;
    agent_limits: string;
  };
}

type AgentLimitsDisplay = Awaited<ReturnType<typeof agentLimits>>;

async function getCachedInitPayload(
  env: Env,
  payerId: string,
): Promise<VoiceInitPayload | null> {
  return (await env.GRANTS.get(initCacheKey(payerId), "json")) as VoiceInitPayload | null;
}

/** Best-effort cache write — a KV failure here must never surface to the caller. */
async function cacheInitPayload(
  env: Env,
  payerId: string,
  payload: VoiceInitPayload,
): Promise<void> {
  try {
    await env.GRANTS.put(initCacheKey(payerId), JSON.stringify(payload), {
      expirationTtl: INIT_CACHE_TTL_SECONDS,
    });
  } catch {
    // best-effort
  }
}

function initPayload(fields: {
  payerName: string;
  invoiceDescription: string;
  totalOverdueCents: number;
  oldestDaysOverdue: number;
  limits: AgentLimitsDisplay;
}): VoiceInitPayload {
  return {
    type: "conversation_initiation_client_data",
    dynamic_variables: {
      payer_name: fields.payerName,
      invoice_description: fields.invoiceDescription,
      total_overdue: formatCents(fields.totalOverdueCents),
      days_overdue: fields.oldestDaysOverdue,
      today_au: todayNaturalAU(),
      agent_limits:
        `authorised up to ${fields.limits.maxPerTransactionDisplay} per payment, ` +
        `with ${fields.limits.remainingTodayDisplay} remaining today`,
    },
  };
}

/** Safe defaults when there's nothing to say yet — never a broken webhook shape. */
function placeholderInitPayload(limits: AgentLimitsDisplay): VoiceInitPayload {
  return initPayload({
    payerName: "",
    invoiceDescription: "no overdue invoices on file",
    totalOverdueCents: 0,
    oldestDaysOverdue: 0,
    limits,
  });
}

function buildPayloadFromOverdueCtx(
  ctx: StructuredError | PayerOverdueContext,
  limits: AgentLimitsDisplay,
): VoiceInitPayload {
  if (isStructuredError(ctx)) return placeholderInitPayload(limits);
  const oldest = [...ctx.invoices].sort((a, b) => b.daysOverdue - a.daysOverdue)[0];
  return initPayload({
    payerName: ctx.payerName,
    invoiceDescription: oldest ? oldest.description : "no overdue invoices on file",
    totalOverdueCents: ctx.totalOverdueCents,
    oldestDaysOverdue: oldest ? oldest.daysOverdue : 0,
    limits,
  });
}

/**
 * Build and cache the /voice/init payload for `payerId` right now, keyed the
 * same way handleVoiceInit reads it, and return it. Called from admin.ts
 * whenever the demo target payer changes (POST /admin/target, POST
 * /admin/call) so the cache is already warm by the time the phone call
 * actually connects — and, for /admin/call, so the SAME build can be handed
 * straight to ElevenLabs as `conversation_initiation_client_data` on the
 * outbound-call request itself, without a second Pinch round trip.
 */
export async function warmVoiceInitCache(env: Env, payerId: string): Promise<VoiceInitPayload> {
  const limits = await agentLimits(env, DEFAULT_VOICE_AGENT_ID);
  const ctx = await fetchPayerOverdueContext(env, payerId);
  const payload = buildPayloadFromOverdueCtx(ctx, limits);
  await cacheInitPayload(env, payerId, payload);
  return payload;
}

/**
 * ElevenLabs' conversation-initiation client-data webhook. Called before a call
 * connects; the incoming body carries THEIR call metadata (caller_id, agent_id,
 * called_number, call_sid — none of which is our agentId), so we ignore it and
 * resolve the demo target payer the same way /voice/tool does. The response
 * MUST match ElevenLabs' `conversation_initiation_client_data` contract — never
 * our own structured-error shape — so on any internal failure we fall back to
 * safe placeholder values rather than breaking the call.
 *
 * Auth: ElevenLabs has no built-in signature scheme for this webhook type (that
 * exists only for post-call webhooks); instead you configure custom secret
 * headers per agent in their dashboard. That's exactly the X-Voice-Secret
 * pattern this surface already uses, so we reuse it as-is.
 *
 * Latency: agentLimits() is a couple of fast KV reads, done eagerly outside the
 * race below. The slow part is the Pinch-backed overdue-context fetch, so ONLY
 * that is raced against INIT_BUILD_TIMEOUT_MS. `ctx` (Cloudflare's
 * ExecutionContext) lets a build that loses the race keep running in the
 * background via waitUntil and still populate the cache for next time — the
 * worker would otherwise be torn down the moment we respond.
 */
async function handleVoiceInit(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const agentId = url.searchParams.get("agentId")?.trim() || DEFAULT_VOICE_AGENT_ID;

  const targetPayerId = await resolveTargetPayerId(env);

  if (targetPayerId) {
    const cached = await getCachedInitPayload(env, targetPayerId);
    if (cached) return jsonResponse(cached);
  }

  const limits = await agentLimits(env, agentId);

  if (!targetPayerId) {
    // Nothing to fetch from Pinch, and nothing to key a cache entry on.
    return jsonResponse(placeholderInitPayload(limits));
  }

  const overduePromise = fetchPayerOverdueContext(env, targetPayerId);
  const buildAndCache = overduePromise.then(async (overdueCtx) => {
    const payload = buildPayloadFromOverdueCtx(overdueCtx, limits);
    await cacheInitPayload(env, targetPayerId, payload);
    return payload;
  });

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timeoutHandle = setTimeout(() => resolve("timeout"), INIT_BUILD_TIMEOUT_MS);
  });

  const winner = await Promise.race([buildAndCache, timeout]);

  if (winner === "timeout") {
    // The build lost the race — let it finish in the background so the NEXT
    // call is instant, then answer THIS one with safe placeholders now.
    const settle = buildAndCache.catch(() => {});
    if (ctx) ctx.waitUntil(settle);
    else void settle;
    return jsonResponse(placeholderInitPayload(limits));
  }

  clearTimeout(timeoutHandle);
  return jsonResponse(winner);
}

// ── GET /voice/payers ──────────────────────────────────────────────────────────

/**
 * List seeded payers with a total-overdue figure, for picking a demo debtor.
 * Walks the scheduled-payments list (bounded) and groups by payer id. Each
 * payment already embeds `payer.{id,firstName,lastName}`, so the name comes
 * straight off the list — no per-payer GET needed.
 */
async function handleVoicePayers(env: Env): Promise<Response> {
  const today = todayAU();

  // 1. Collect scheduled payments across a bounded number of pages.
  const collected: PinchPayment[] = [];
  const MAX_PAGES = 5;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await listScheduledPayments(env, page, 100);
    if (isStructuredError(res)) return jsonResponse(res, 502);
    collected.push(...res.data);
    if (page >= res.totalPages) break;
  }

  // 2. Group overdue totals by payer id (preserving first-seen order), pulling
  //    the display name from the embedded payer object.
  const order: string[] = [];
  const names = new Map<string, string>();
  const overdueByPayer = new Map<string, number>();
  for (const p of collected) {
    const pid = paymentPayerId(p);
    if (!pid) continue;
    if (!overdueByPayer.has(pid)) {
      overdueByPayer.set(pid, 0);
      order.push(pid);
      const name = [p.payer?.firstName, p.payer?.lastName]
        .filter((s): s is string => typeof s === "string" && s.length > 0)
        .join(" ")
        .trim();
      names.set(pid, name || pid);
    }
    if (isOverdue(p, today)) {
      overdueByPayer.set(pid, (overdueByPayer.get(pid) ?? 0) + paymentAmount(p));
    }
  }

  // 3. Shape the response.
  const payers = order.map((pid) => {
    const cents = overdueByPayer.get(pid) ?? 0;
    return {
      id: pid,
      name: names.get(pid) ?? pid,
      totalOverdueCents: cents,
      totalOverdueDisplay: formatCents(cents),
    };
  });

  return jsonResponse({ count: payers.length, payers });
}

// ── router ─────────────────────────────────────────────────────────────────────

/**
 * Entry point wired to /voice/*. Every route is gated on X-Voice-Secret. `ctx`
 * (Cloudflare's ExecutionContext) is optional — passed through from index.ts in
 * production for /voice/init's background cache-fill; tests can omit it.
 */
export async function handleVoice(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  if (!isVoiceAuthorised(request, env)) {
    return jsonResponse(
      structuredError("unauthorized", "Missing or invalid X-Voice-Secret header."),
      401,
    );
  }

  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const sub = url.pathname.replace(/^\/voice\/?/, "");

  if (sub === "tool") {
    if (method === "POST") return handleVoiceTool(request, env);
    return methodNotAllowed(["POST"]);
  }

  if (sub === "init") {
    if (method === "POST") return handleVoiceInit(request, env, ctx);
    return methodNotAllowed(["POST"]);
  }

  const ctxMatch = /^context\/(.+)$/.exec(sub);
  if (ctxMatch) {
    if (method === "GET") {
      return handleVoiceContext(request, env, decodeURIComponent(ctxMatch[1]!));
    }
    return methodNotAllowed(["GET"]);
  }

  if (sub === "payers") {
    if (method === "GET") return handleVoicePayers(env);
    return methodNotAllowed(["GET"]);
  }

  return jsonResponse(
    structuredError("not_found", `No voice route for ${method} /voice/${sub}.`),
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
