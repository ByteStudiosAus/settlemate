/**
 * The agent-facing tool surface — the ONLY Pinch capabilities an MCP client ever
 * sees. There are exactly nine, each written for an LLM caller. The raw endpoint
 * wrappers in pinch.ts (getPayment, listEvents, listScheduledPayments, …) stay
 * internal: agents compose intent through these tools, never the bare REST calls.
 *
 * Every money-touching tool flows through `permissions.enforce()` so grant /
 * active / allowed-tool / per-transaction / daily checks and the audit trail all
 * happen in ONE place — EXCEPT create_payment_plan, which reuses a single
 * preflight snapshot of those same checks and then creates ONE native Pinch
 * Plan + Subscription (see its own comment below for why). Amounts are integer
 * cents end to end (hard-rule #2); dollars appear only in human-facing
 * `*Display` strings built with formatCents.
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import {
  addSpend,
  enforce,
  getGrant,
  getSpentToday,
  writeAudit,
} from "./permissions";
import {
  cancelSubscription,
  createBankSource,
  createPayer,
  createPlan,
  createRealtimePayment,
  createScheduledPayment,
  createSubscription,
  deletePlan,
  getPayment,
  listPaymentsForPayer,
  listScheduledPayments,
  resolveBankSourceId,
  type PinchFixedPayment,
  type PinchPayment,
} from "./pinch";
import type { AuditEntry, Declined, Env, StructuredError } from "./types";
import { isStructuredError } from "./types";
import {
  declined,
  formatCents,
  type Frequency,
  maskParams,
  newId,
  nextNDates,
  nowIso,
  structuredError,
  todayAU,
} from "./util";

// ── idempotency helpers (create_payment_plan only) ───────────────────────────

const IDEM_TTL_SECONDS = 600; // 10 minutes

/** Derive a stable KV key from the plan's identity fields. */
async function planIdemKey(
  agentId: string,
  payerId: string,
  totalAmountCents: number,
  instalments: number,
  frequency: string,
  startDate: string,
): Promise<string> {
  const raw = `${agentId}|${payerId}|${totalAmountCents}|${instalments}|${frequency}|${startDate}`;
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  const hex = Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `idem:plan:${hex}`;
}

/** Write a duplicate_suppressed audit entry. Best-effort — never throws. */
async function auditDuplicate(
  env: Env,
  agentId: string,
  params: Record<string, unknown>,
): Promise<void> {
  try {
    const entry: AuditEntry = {
      ts: nowIso(),
      agentId,
      tool: "create_payment_plan",
      paramsSummary: params,
      outcome: "duplicate_suppressed",
      reason: "idempotency_hit",
    };
    await env.AUDIT.put(`audit:${entry.ts}:${newId()}`, JSON.stringify(entry));
  } catch {
    // best-effort
  }
}

const payerId = z.string().min(1).describe('Pinch payer id, e.g. "pyr_abc123".');
const sourceId = z
  .string()
  .min(1)
  .optional()
  .describe(
    'Optional bank source id ("src_…"). Omit to use the payer\'s default source.',
  );
const amountCents = z
  .number()
  .int()
  .positive()
  .describe("Amount in INTEGER CENTS (1245 = $12.45). Never dollars, never a float.");
const ymd = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
  .describe("Date as YYYY-MM-DD (Australian calendar).");
const description = z
  .string()
  .min(1)
  .describe("Human-readable description shown on the payment / statement.");

// ── tool context + spec ──────────────────────────────────────────────────────

export interface ToolContext {
  env: Env;
  /** The calling agent, resolved from ?agentId= or x-agent-id by the MCP layer. */
  agentId: string;
}

/** A tool result is either domain data, a policy refusal, or a structured error. */
export type ToolResult = unknown | Declined | StructuredError;

export interface ToolSpec {
  name: string;
  /** LLM-facing description. Written for the model that decides to call this. */
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  run(ctx: ToolContext, rawArgs: unknown): Promise<ToolResult>;
}

/** JSON Schema for tools/list — derived from the zod schema, MCP-friendly. */
export function inputJsonSchema(spec: ToolSpec): Record<string, unknown> {
  return zodToJsonSchema(spec.schema, {
    target: "jsonSchema7",
    $refStrategy: "none",
  }) as Record<string, unknown>;
}

/** Parse args against the schema, returning a StructuredError on a bad shape. */
function parseArgs<S extends z.ZodTypeAny>(
  schema: S,
  raw: unknown,
): z.infer<S> | StructuredError {
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
    );
    return structuredError("invalid_arguments", issues.join("; "), { issues });
  }
  return parsed.data;
}

// ── payment presentation helper ───────────────────────────────────────────────

/** Shape a raw Pinch payment into an agent-friendly view with a $ display. */
function presentPayment(p: PinchPayment): Record<string, unknown> {
  const cents = typeof p.amount === "number" ? p.amount : undefined;
  return {
    id: p.id,
    status: p.status,
    amountCents: cents,
    amountDisplay: cents === undefined ? undefined : formatCents(cents),
    settled: p.status === "transferred",
    dishonoured: p.status === "dishonoured",
  };
}

// ── overdue-balance sanity check (create_payment_plan guardrail) ─────────────

/** A payment's transaction date as a bare YYYY-MM-DD (Pinch sends a full ISO datetime). */
function paymentDateYmd(p: PinchPayment): string | undefined {
  const raw = p.transactionDate;
  if (typeof raw !== "string") return undefined;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(raw);
  return m ? m[1] : undefined;
}

/** Sum of a payer's overdue balance: dishonoured debits, or scheduled ones whose date has passed. */
async function payerOverdueTotalCents(
  env: Env,
  payerId: string,
): Promise<number | StructuredError> {
  const payments = await listPaymentsForPayer(env, payerId);
  if (isStructuredError(payments)) return payments;
  const today = todayAU();
  return payments.reduce((sum, p) => {
    const date = paymentDateYmd(p);
    const overdue = p.status === "dishonoured" || (p.status === "scheduled" && date !== undefined && date < today);
    return overdue ? sum + (typeof p.amount === "number" ? p.amount : 0) : sum;
  }, 0);
}

// ── the nine tools ─────────────────────────────────────────────────────────────

const createPayerTool: ToolSpec = {
  name: "create_payer",
  description:
    "Create a customer (payer) in Pinch. Use this first, before adding a bank " +
    "account or taking any payment. Returns the payer id (pyr_…) you pass to " +
    "every later tool. Requires the customer's first name and email; last name " +
    "and mobile are optional but recommended.",
  schema: z.object({
    firstName: z.string().min(1).describe("Customer's first / given name."),
    emailAddress: z.string().email().describe("Customer's email address."),
    lastName: z.string().min(1).optional().describe("Customer's last / family name."),
    mobileNumber: z
      .string()
      .min(1)
      .optional()
      .describe("Customer's mobile number (AU format)."),
  }),
  run(ctx, raw) {
    const args = parseArgs(this.schema, raw);
    if (isStructuredError(args)) return Promise.resolve(args);
    return enforce({
      env: ctx.env,
      agentId: ctx.agentId,
      tool: this.name,
      params: args,
      amountCents: 0,
      execute: () =>
        createPayer(ctx.env, {
          firstName: args.firstName,
          emailAddress: args.emailAddress,
          ...(args.lastName ? { lastName: args.lastName } : {}),
          ...(args.mobileNumber ? { mobileNumber: args.mobileNumber } : {}),
        }),
    });
  },
};

const addBankAccountTool: ToolSpec = {
  name: "add_bank_account",
  description:
    "Attach an Australian bank account to a payer as a direct-debit source (the " +
    "mandate). Required before you can charge or schedule against that bank " +
    "account. Returns a source id (src_…). Provide the BSB and full account " +
    "number; the account number is masked to its last 3 digits everywhere it is " +
    "logged.",
  schema: z.object({
    payerId,
    accountName: z.string().min(1).describe("Name on the bank account."),
    bsb: z
      .string()
      .regex(/^\d{3}-?\d{3}$/, "BSB must be 6 digits, e.g. 062-000")
      .describe("6-digit BSB (branch code), e.g. 062-000."),
    accountNumber: z
      .string()
      .regex(/^\d{4,10}$/, "account number must be 4–10 digits")
      .describe("Bank account number (digits only)."),
  }),
  run(ctx, raw) {
    const args = parseArgs(this.schema, raw);
    if (isStructuredError(args)) return Promise.resolve(args);
    return enforce({
      env: ctx.env,
      agentId: ctx.agentId,
      tool: this.name,
      // maskParams masks `accountNumber` in the audit entry (hard-rule #3).
      params: args,
      amountCents: 0,
      execute: () =>
        createBankSource(ctx.env, args.payerId, {
          bankAccountName: args.accountName,
          bankAccountBsb: args.bsb,
          bankAccountNumber: args.accountNumber,
        }),
    });
  },
};

const createInvoiceTool: ToolSpec = {
  name: "create_invoice",
  description:
    "Schedule a single future direct-debit (an invoice) against a payer's bank " +
    "account for a specific due date. The amount counts against your per-" +
    "transaction and daily limits. For a series of instalments use " +
    "create_payment_plan instead. Returns the scheduled payment (pmt_…).",
  schema: z.object({
    payerId,
    amountCents,
    dueDate: ymd.describe("Date the debit should run (YYYY-MM-DD)."),
    description,
    sourceId,
  }),
  run(ctx, raw) {
    const args = parseArgs(this.schema, raw);
    if (isStructuredError(args)) return Promise.resolve(args);
    return enforce({
      env: ctx.env,
      agentId: ctx.agentId,
      tool: this.name,
      params: args,
      amountCents: args.amountCents,
      execute: () =>
        createScheduledPayment(ctx.env, {
          payerId: args.payerId,
          amount: args.amountCents,
          transactionDate: args.dueDate,
          description: args.description,
          ...(args.sourceId ? { sourceId: args.sourceId } : {}),
        }),
    });
  },
};

const chargeNowTool: ToolSpec = {
  name: "charge_now",
  description:
    "Charge a payer's bank account immediately (realtime debit). Use only when " +
    "the customer expects to be billed right now — otherwise schedule with " +
    "create_invoice. The amount counts against your per-transaction and daily " +
    "limits. Returns the payment (pmt_…) with an approved/… status and any " +
    "dishonour detail.",
  schema: z.object({
    payerId,
    amountCents,
    description,
    sourceId,
  }),
  run(ctx, raw) {
    const args = parseArgs(this.schema, raw);
    if (isStructuredError(args)) return Promise.resolve(args);
    return enforce({
      env: ctx.env,
      agentId: ctx.agentId,
      tool: this.name,
      params: args,
      amountCents: args.amountCents,
      execute: async () => {
        // Realtime charges need an explicit source: the sandbox rejects a
        // source-less realtime debit even though the docs say it defaults. Use
        // the caller's sourceId if given, else resolve the payer's default
        // bank-account source (returns a structured error if none exists).
        let sourceId = args.sourceId;
        if (!sourceId) {
          const resolved = await resolveBankSourceId(ctx.env, args.payerId);
          if (isStructuredError(resolved)) return resolved;
          sourceId = resolved;
        }
        return createRealtimePayment(ctx.env, {
          payerId: args.payerId,
          amount: args.amountCents,
          description: args.description,
          sourceId,
        });
      },
    });
  },
};

const createPaymentPlanTool: ToolSpec = {
  name: "create_payment_plan",
  description:
    "Split a total into 2–6 equal instalments and schedule them as a series of " +
    "direct debits (weekly, fortnightly, or monthly) starting on a given date. " +
    "The total is divided into whole cents with any remainder added to the final " +
    "instalment. Each instalment must be within your per-transaction limit and " +
    "the plan's total within your remaining daily limit — the whole plan is " +
    "refused up front if it would not fit, so no partial plan is ever created. " +
    "startDate must be today or later (Australia/Sydney) — a past date is refused. " +
    "The total is also sanity-checked against the payer's current overdue balance: " +
    "if it differs by more than 20%, nothing is created and you get back a " +
    "clarification to confirm with the customer before retrying. " +
    "Returns a human-readable schedule plus the created payment ids, a planId, " +
    "and a subscriptionId — pass the subscriptionId to cancel_payment_plan to " +
    "call off every remaining instalment in one action.",
  schema: z.object({
    payerId,
    totalAmountCents: z
      .number()
      .int()
      .positive()
      .describe("Total to collect across all instalments, in INTEGER CENTS."),
    instalments: z
      .number()
      .int()
      .min(2)
      .max(6)
      .describe("Number of instalments (2–6)."),
    frequency: z
      .enum(["weekly", "fortnightly", "monthly"])
      .describe("Cadence between instalments."),
    startDate: ymd.describe("Date of the FIRST instalment (YYYY-MM-DD)."),
    description,
    sourceId,
  }),
  async run(ctx, raw) {
    const args = parseArgs(this.schema, raw);
    if (isStructuredError(args)) return args;

    const { env, agentId } = ctx;
    const n = args.instalments;
    const total = args.totalAmountCents;
    if (total < n) {
      return structuredError(
        "invalid_arguments",
        `Total ${formatCents(total)} is too small to split into ${n} instalments of at least 1 cent.`,
      );
    }

    // ── guardrail: no starting a plan in the past ─────────────────────────────
    const today = todayAU();
    if (args.startDate < today) {
      return structuredError(
        "invalid_start_date",
        `startDate ${args.startDate} is before today (${today}, Australia/Sydney) — ` +
          `schedule the plan starting from today instead.`,
        { startDate: args.startDate, today },
      );
    }

    // Equal split in whole cents; remainder lands on the final instalment so the
    // instalments sum EXACTLY to the total (hard-rule #2 — no rounding drift).
    const base = Math.floor(total / n);
    const remainder = total - base * n;
    const amounts = Array.from({ length: n }, (_, i) =>
      i === n - 1 ? base + remainder : base,
    );
    const dates = nextNDates(args.startDate, args.frequency as Frequency, n);
    const maxInstalment = Math.max(...amounts);

    // ── idempotency check ─────────────────────────────────────────────────────
    // Derive a key from the plan's identity fields. If a successful result was
    // stored in the last 10 minutes, return it verbatim and write a
    // duplicate_suppressed audit entry instead of creating again.
    const idemKey = await planIdemKey(
      agentId,
      args.payerId,
      total,
      n,
      args.frequency,
      args.startDate,
    );
    const cached = await env.IDEMPOTENCY.get(idemKey, "json");
    if (cached !== null) {
      await auditDuplicate(env, agentId, {
        payerId: args.payerId,
        totalAmountCents: total,
        instalments: n,
        frequency: args.frequency,
        startDate: args.startDate,
      });
      return cached as Record<string, unknown>;
    }

    // ── "no partial plans" preflight ──────────────────────────────────────────
    // enforce() is still the authority on every instalment below; this guard only
    // exists so we never create instalments 1–3 and then trip a limit on #4. It
    // reuses the engine's own reasons/shape so the refusal is indistinguishable.
    const grant = await getGrant(env, agentId);
    if (!grant) {
      return declined("no_grant", `No grant exists for agent "${agentId}".`, {
        tool: this.name,
      });
    }
    if (!grant.active) {
      return declined("grant_inactive", `The grant for "${agentId}" is inactive.`, {
        tool: this.name,
      });
    }
    if (!grant.allowedTools.includes(this.name)) {
      return declined(
        "tool_not_allowed",
        `Agent "${agentId}" is not permitted to use "${this.name}".`,
        { tool: this.name },
      );
    }
    if (maxInstalment > grant.maxPerTransactionCents) {
      return declined(
        "exceeds_per_transaction_limit",
        `An instalment of ${formatCents(maxInstalment)} exceeds the per-transaction limit.`,
        {
          tool: this.name,
          limitCents: grant.maxPerTransactionCents,
          attemptedCents: maxInstalment,
        },
      );
    }
    const spentToday = await getSpentToday(env, agentId);
    if (spentToday + total > grant.maxDailyCents) {
      return declined(
        "exceeds_daily_limit",
        `The plan total ${formatCents(total)} would exceed the daily limit.`,
        {
          tool: this.name,
          limitCents: grant.maxDailyCents,
          attemptedCents: total,
          spentTodayCents: spentToday,
        },
      );
    }

    // ── guardrail: plan total vs the payer's actual overdue balance ───────────
    // A plan built from a misheard or misremembered figure is a real failure
    // mode for a voice agent — sanity-check against Pinch's own numbers before
    // committing to a schedule. Only fires when there IS an overdue balance to
    // compare against; a plan for a payer with nothing overdue (e.g. a fresh
    // payment arrangement) isn't second-guessed.
    const overdueTotal = await payerOverdueTotalCents(env, args.payerId);
    if (isStructuredError(overdueTotal)) return overdueTotal;
    if (overdueTotal > 0 && Math.abs(total - overdueTotal) / overdueTotal > 0.2) {
      return structuredError(
        "plan_total_mismatch",
        `Plan total ${formatCents(total)} differs from payer "${args.payerId}"'s overdue ` +
          `balance ${formatCents(overdueTotal)} by more than 20% — confirm before creating.`,
        {
          payerId: args.payerId,
          planTotalCents: total,
          planTotalDisplay: formatCents(total),
          overdueTotalCents: overdueTotal,
          overdueTotalDisplay: formatCents(overdueTotal),
        },
      );
    }

    // ── create ONE native Pinch Plan + Subscription, not N scheduled payments ──
    // Preflight above already re-checked everything a per-instalment enforce()
    // call would check (grant active, tool allowed, per-instalment + daily
    // limits) against this one snapshot. Pinch's Plans+Subscriptions API
    // (verified live against the sandbox) turns the whole plan into ONE
    // resource: `fixedPayments` carries the EXACT per-instalment amounts —
    // including the remainder-on-final-instalment split — as offsets from the
    // subscription's startDate, and Pinch generates every payment record
    // itself. This is what cuts plan creation to ~3 Pinch calls total
    // regardless of instalment count (create plan, create subscription, look
    // up the generated payment ids), instead of up to 2N+1. Cancellation is
    // now a single DELETE /subscriptions/{id} — see cancel_payment_plan.
    const offsetInterval: PinchFixedPayment["scheduledDateInterval"] =
      args.frequency === "monthly" ? "months" : "days";
    const offsetStep = args.frequency === "weekly" ? 7 : args.frequency === "fortnightly" ? 14 : 1;
    const fixedPayments: PinchFixedPayment[] = amounts.map((cents, i) => ({
      amountInCents: cents,
      description: `${args.description} (instalment ${i + 1}/${n})`,
      scheduledDateOffset: i * offsetStep,
      scheduledDateInterval: offsetInterval,
    }));

    const auditParamsSummary = maskParams({
      payerId: args.payerId,
      totalAmountCents: total,
      instalments: n,
      frequency: args.frequency,
      startDate: args.startDate,
    });

    const plan = await createPlan(env, {
      name: `${args.description} (${args.payerId})`,
      fixedPayments,
    });
    if (isStructuredError(plan)) {
      await writeAudit(env, {
        ts: nowIso(),
        agentId,
        tool: this.name,
        paramsSummary: auditParamsSummary,
        outcome: "error",
        reason: plan.code,
        amountCents: total,
      });
      return plan;
    }

    const subscription = await createSubscription(env, {
      planId: plan.id,
      payerId: args.payerId,
      startDate: args.startDate,
      ...(args.sourceId ? { sourceId: args.sourceId } : {}),
    });

    if (isStructuredError(subscription)) {
      // The plan has zero subscribers (creating the subscription is what
      // failed), so it's safe to delete — best-effort, never blocks the reply.
      const cleanup = await deletePlan(env, plan.id);
      await writeAudit(env, {
        ts: nowIso(),
        agentId,
        tool: this.name,
        paramsSummary: auditParamsSummary,
        outcome: "error",
        reason: "plan_creation_failed",
        amountCents: total,
      });
      return structuredError(
        "plan_creation_failed",
        `Could not create the subscription for this plan; nothing was scheduled.` +
          (isStructuredError(cleanup)
            ? ` WARNING: the orphaned plan ${plan.id} could not be cleaned up automatically — delete it manually in Pinch.`
            : ""),
        { failure: subscription, planId: plan.id },
      );
    }

    // The subscription response doesn't carry the generated pmt_… ids, so look
    // them up once by matching this subscription id + our own instalment
    // descriptions (which are unique per plan). Best-effort: if this lookup
    // fails, the plan and its payments still exist — schedule[].paymentId is
    // just left undefined (it's optional in the response shape).
    const paymentIdByDescription = new Map<string, string>();
    const payments = await listPaymentsForPayer(env, args.payerId);
    if (!isStructuredError(payments)) {
      for (const p of payments) {
        if (p.subscription?.id === subscription.id && typeof p.description === "string") {
          paymentIdByDescription.set(p.description, p.id);
        }
      }
    }

    const schedule = fixedPayments.map((fp, i) => ({
      instalment: i + 1,
      date: dates[i]!,
      amountCents: amounts[i]!,
      amountDisplay: formatCents(amounts[i]!),
      paymentId: paymentIdByDescription.get(fp.description),
    }));

    // The whole plan is ONE Pinch operation now, so it's ONE spend addition
    // and ONE audit entry — not N.
    await addSpend(env, agentId, total);
    await writeAudit(env, {
      ts: nowIso(),
      agentId,
      tool: this.name,
      paramsSummary: auditParamsSummary,
      outcome: "allowed",
      amountCents: total,
      resultId: subscription.id,
    });

    const planResult = {
      payerId: args.payerId,
      planId: plan.id,
      subscriptionId: subscription.id,
      instalments: n,
      frequency: args.frequency,
      totalAmountCents: total,
      totalDisplay: formatCents(total),
      schedule,
      summary:
        `${n} ${args.frequency} instalments of ${formatCents(base)}` +
        (remainder ? ` (final ${formatCents(base + remainder)})` : "") +
        ` from ${dates[0]} to ${dates[n - 1]}, totalling ${formatCents(total)}.`,
    };

    // Store the result under the idempotency key (TTL 10 min) so a duplicate
    // call within the window returns the original result without re-creating.
    try {
      await env.IDEMPOTENCY.put(idemKey, JSON.stringify(planResult), {
        expirationTtl: IDEM_TTL_SECONDS,
      });
    } catch {
      // best-effort — a KV write failure must not block the caller
    }

    return planResult;
  },
};

const cancelPaymentPlanTool: ToolSpec = {
  name: "cancel_payment_plan",
  description:
    "Cancel every remaining instalment of a payment plan created by " +
    "create_payment_plan, in ONE action — pass the subscriptionId (sub_…) it " +
    "returned. Only instalments that haven't run yet are affected; any that " +
    "already settled or failed are untouched. Use this when a customer pays " +
    "out early, disputes the arrangement, or the plan needs to be redone.",
  schema: z.object({
    subscriptionId: z
      .string()
      .min(1)
      .describe('Subscription id returned by create_payment_plan, e.g. "sub_abc123".'),
  }),
  run(ctx, raw) {
    const args = parseArgs(this.schema, raw);
    if (isStructuredError(args)) return Promise.resolve(args);
    return enforce({
      env: ctx.env,
      agentId: ctx.agentId,
      tool: this.name,
      params: args,
      amountCents: 0,
      execute: () => cancelSubscription(ctx.env, args.subscriptionId),
    });
  },
};

const checkPaymentStatusTool: ToolSpec = {
  name: "check_payment_status",
  description:
    "Look up the current status of one payment by its id (pmt_…). Returns the " +
    "status (scheduled, processing, approved, dishonoured, or transferred), the " +
    "amount, and convenience flags: `settled` (money transferred) and " +
    "`dishonoured` (the debit bounced).",
  schema: z.object({
    paymentId: z.string().min(1).describe('Payment id to look up, e.g. "pmt_abc123".'),
  }),
  async run(ctx, raw) {
    const args = parseArgs(this.schema, raw);
    if (isStructuredError(args)) return args;
    const result = await enforce({
      env: ctx.env,
      agentId: ctx.agentId,
      tool: this.name,
      params: args,
      amountCents: 0,
      execute: () => getPayment(ctx.env, args.paymentId),
    });
    if (isStructuredError(result) || (result as Declined).declined) return result;
    return presentPayment(result as PinchPayment);
  },
};

const listOverdueTool: ToolSpec = {
  name: "list_overdue",
  description:
    "List payments that need attention: scheduled debits whose date has already " +
    "passed but haven't run, plus any that were dishonoured (bounced). Pass a " +
    "payerId to scope to one customer, or omit it to scan all scheduled " +
    "payments. Amounts include a $ display string for reading back to a customer.",
  schema: z.object({
    payerId: z
      .string()
      .min(1)
      .optional()
      .describe("Optional payer id to scope the search to a single customer."),
  }),
  async run(ctx, raw) {
    const args = parseArgs(this.schema, raw);
    if (isStructuredError(args)) return args;
    const today = todayAU();

    const isOverdue = (p: PinchPayment): boolean => {
      if (p.status === "dishonoured") return true;
      const date = typeof p.transactionDate === "string" ? p.transactionDate : undefined;
      return p.status === "scheduled" && date !== undefined && date < today;
    };

    const result = await enforce({
      env: ctx.env,
      agentId: ctx.agentId,
      tool: this.name,
      params: args,
      amountCents: 0,
      execute: async (): Promise<PinchPayment[] | StructuredError> => {
        if (args.payerId) {
          // Bare array for a single payer.
          return listPaymentsForPayer(ctx.env, args.payerId);
        }
        // Wrapped, paged scheduled list — walk a bounded number of pages.
        const collected: PinchPayment[] = [];
        const MAX_PAGES = 5;
        for (let page = 1; page <= MAX_PAGES; page++) {
          const pageRes = await listScheduledPayments(ctx.env, page, 100);
          if (isStructuredError(pageRes)) return pageRes;
          collected.push(...pageRes.data);
          if (page >= pageRes.totalPages) break;
        }
        return collected;
      },
    });

    if (isStructuredError(result) || (result as Declined).declined) return result;

    const overdue = (result as PinchPayment[]).filter(isOverdue).map(presentPayment);
    return {
      count: overdue.length,
      scope: args.payerId ? { payerId: args.payerId } : "all-scheduled",
      asOf: today,
      overdue,
    };
  },
};

const getAgentLimitsTool: ToolSpec = {
  name: "get_agent_limits",
  description:
    "Report your own current authority: per-transaction and daily spend limits, " +
    "how much you've already spent today, how much headroom remains, and which " +
    "tools you're allowed to call. Call this when unsure whether a payment will " +
    "be permitted, before attempting it.",
  schema: z.object({}),
  async run(ctx, raw) {
    const args = parseArgs(this.schema, raw);
    if (isStructuredError(args)) return args;
    // Introspection of the agent's OWN grant — no Pinch call, no spend, so it does
    // not pass through enforce()'s allowed-tools gate (an agent can always ask what
    // it may do). Returns a clear "no active grant" note rather than a refusal.
    const grant = await getGrant(ctx.env, ctx.agentId);
    if (!grant || !grant.active) {
      return {
        agentId: ctx.agentId,
        active: false,
        message: grant
          ? "Your grant exists but is inactive; no payments will be permitted."
          : "No grant exists for this agent; no payments will be permitted.",
      };
    }
    const spentToday = await getSpentToday(ctx.env, ctx.agentId);
    const remainingToday = Math.max(0, grant.maxDailyCents - spentToday);
    return {
      agentId: ctx.agentId,
      active: true,
      maxPerTransactionCents: grant.maxPerTransactionCents,
      maxPerTransactionDisplay: formatCents(grant.maxPerTransactionCents),
      maxDailyCents: grant.maxDailyCents,
      maxDailyDisplay: formatCents(grant.maxDailyCents),
      spentTodayCents: spentToday,
      spentTodayDisplay: formatCents(spentToday),
      remainingTodayCents: remainingToday,
      remainingTodayDisplay: formatCents(remainingToday),
      allowedTools: grant.allowedTools,
    };
  },
};

// ── registry ───────────────────────────────────────────────────────────────────

export const TOOLS: ToolSpec[] = [
  createPayerTool,
  addBankAccountTool,
  createInvoiceTool,
  chargeNowTool,
  createPaymentPlanTool,
  cancelPaymentPlanTool,
  checkPaymentStatusTool,
  listOverdueTool,
  getAgentLimitsTool,
];

/** The nine tool names — handy for seeding a grant's allowedTools. */
export const TOOL_NAMES: string[] = TOOLS.map((t) => t.name);

const TOOLS_BY_NAME: Map<string, ToolSpec> = new Map(TOOLS.map((t) => [t.name, t]));

export function getTool(name: string): ToolSpec | undefined {
  return TOOLS_BY_NAME.get(name);
}
