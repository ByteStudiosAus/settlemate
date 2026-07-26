/**
 * The permissions engine. Every state-changing (and, for audit completeness,
 * every read) tool call flows through `enforce()`:
 *
 *   grant exists -> active -> tool allowed -> per-transaction limit ->
 *   daily limit -> execute() -> audit (allowed | declined | error, ALWAYS)
 *
 * `execute` is a thunk so NONE of the underlying Pinch call fires until every
 * check has passed. `amountCents` is supplied by the caller (0 for non-spend
 * tools) so the engine stays tool-agnostic — it never guesses the spend field.
 */

import type { AuditEntry, Declined, Env, Grant, StructuredError } from "./types";
import { isStructuredError } from "./types";
import { declined, maskParams, newId, nowIso, todayAU } from "./util";

// ── grant + spend storage helpers ────────────────────────────────────────────

function grantKey(agentId: string): string {
  return `grant:${agentId}`;
}

function spendKey(agentId: string, dateYmd: string): string {
  return `spend:${agentId}:${dateYmd}`;
}

/** Read an agent's grant record, or null if none exists. */
export async function getGrant(env: Env, agentId: string): Promise<Grant | null> {
  return (await env.GRANTS.get(grantKey(agentId), "json")) as Grant | null;
}

/** Write/replace an agent's grant record. */
export async function putGrant(env: Env, grant: Grant): Promise<void> {
  await env.GRANTS.put(grantKey(grant.agentId), JSON.stringify(grant));
}

/** Today's spend total (integer cents) for an agent, defaulting to 0. */
export async function getSpentToday(env: Env, agentId: string): Promise<number> {
  const raw = await env.SPEND.get(spendKey(agentId, todayAU()));
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Add to today's spend counter. Read-modify-write on KV — eventually consistent,
 * which is acceptable for this hackathon (a tiny window could under-count under
 * bursty concurrent charges). Keyed by AU date so it self-rolls at midnight;
 * TTL'd to 48h so yesterday's counter self-cleans.
 *
 * Exported so create_payment_plan can add the WHOLE plan total in one call once
 * every instalment has succeeded, instead of one read-modify-write per
 * instalment — fewer KV round trips and a narrower race window.
 */
export async function addSpend(env: Env, agentId: string, cents: number): Promise<void> {
  const key = spendKey(agentId, todayAU());
  const current = await getSpentToday(env, agentId);
  await env.SPEND.put(key, String(current + cents), { expirationTtl: 60 * 60 * 48 });
}

/**
 * Append one audit entry. Never throws — auditing must not break a request.
 * Exported so callers that bypass `enforce()` (admin routes acting as the
 * authority, not a scoped agent) can still write to the same audit trail.
 */
export async function writeAudit(env: Env, entry: AuditEntry): Promise<void> {
  try {
    await env.AUDIT.put(`audit:${entry.ts}:${newId()}`, JSON.stringify(entry));
  } catch {
    // Best-effort: an audit write failure must not surface to the caller.
  }
}

// ── enforce ──────────────────────────────────────────────────────────────────

export interface EnforceArgs<T> {
  env: Env;
  agentId: string;
  /** Tool name, e.g. "createRealtimePayment". */
  tool: string;
  /** Raw tool params — summarised (and masked) into the audit entry. */
  params: Record<string, unknown>;
  /** Spend amount in integer cents. 0 for non-spend tools (reads, lookups). */
  amountCents: number;
  /** The actual work. Runs only after all checks pass. */
  execute: () => Promise<T | StructuredError>;
}

/**
 * Enforce an agent's grant over a single tool call.
 * Returns the execute() result on success, a Declined on a policy refusal, or a
 * StructuredError if the underlying work failed.
 */
export async function enforce<T>(
  args: EnforceArgs<T>,
): Promise<T | Declined | StructuredError> {
  const { env, agentId, tool, params, amountCents, execute } = args;
  const paramsSummary = maskParams(params);

  // A single audit sink used on every exit path.
  const audit = (
    outcome: AuditEntry["outcome"],
    extra?: Partial<Pick<AuditEntry, "reason" | "resultId">>,
  ): Promise<void> =>
    writeAudit(env, {
      ts: nowIso(),
      agentId,
      tool,
      paramsSummary,
      outcome,
      amountCents,
      ...extra,
    });

  // 1. grant exists
  const grant = await getGrant(env, agentId);
  if (!grant) {
    await audit("declined", { reason: "no_grant" });
    return declined("no_grant", `No grant exists for agent "${agentId}".`, { tool });
  }

  // 2. grant active
  if (!grant.active) {
    await audit("declined", { reason: "grant_inactive" });
    return declined("grant_inactive", `The grant for "${agentId}" is inactive.`, { tool });
  }

  // 3. tool allowed
  if (!grant.allowedTools.includes(tool)) {
    await audit("declined", { reason: "tool_not_allowed" });
    return declined(
      "tool_not_allowed",
      `Agent "${agentId}" is not permitted to use "${tool}".`,
      { tool },
    );
  }

  // 4. per-transaction limit (spend tools only)
  if (amountCents > 0 && amountCents > grant.maxPerTransactionCents) {
    await audit("declined", { reason: "exceeds_per_transaction_limit" });
    return declined(
      "exceeds_per_transaction_limit",
      `Amount exceeds the per-transaction limit.`,
      { tool, limitCents: grant.maxPerTransactionCents, attemptedCents: amountCents },
    );
  }

  // 5. daily limit (spend tools only)
  if (amountCents > 0) {
    const spentToday = await getSpentToday(env, agentId);
    if (spentToday + amountCents > grant.maxDailyCents) {
      await audit("declined", { reason: "exceeds_daily_limit" });
      return declined(
        "exceeds_daily_limit",
        `Amount would exceed the daily limit.`,
        {
          tool,
          limitCents: grant.maxDailyCents,
          attemptedCents: amountCents,
          spentTodayCents: spentToday,
        },
      );
    }
  }

  // 6. execute
  const result = await execute();

  if (isStructuredError(result)) {
    // The work failed downstream — do NOT count it against spend.
    await audit("error", { reason: result.code });
    return result;
  }

  // Success. Count the spend, then audit as allowed.
  if (amountCents > 0) {
    await addSpend(env, agentId, amountCents);
  }
  const resultId =
    result && typeof result === "object" && "id" in result
      ? String((result as { id: unknown }).id)
      : undefined;
  await audit("allowed", resultId ? { resultId } : undefined);
  return result;
}
