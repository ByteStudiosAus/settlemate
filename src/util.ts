/**
 * Pure helpers — no network, no KV, no side effects.
 * Everything here is safe to call from any layer (pinch, permissions, index, scripts).
 */

import type { Declined, StructuredError } from "./types";

// ── error / declined constructors ────────────────────────────────────────────

/** Build the structured error object we RETURN to clients. We never throw stack traces. */
export function structuredError(
  code: string,
  message: string,
  details?: unknown,
): StructuredError {
  const err: StructuredError = { error: true, code, message };
  if (details !== undefined) err.details = details;
  return err;
}

/** Build a permission-refusal object an agent can relay in natural language. */
export function declined(
  reason: Declined["reason"],
  message: string,
  extra?: Partial<
    Pick<Declined, "limitCents" | "attemptedCents" | "spentTodayCents" | "tool">
  >,
): Declined {
  return { declined: true, reason, message, ...extra };
}

// ── masking (hard-rule #3: never log full bank numbers) ──────────────────────

/**
 * Mask an account number to its last 3 digits. Non-digit characters are stripped
 * before counting. Returns "***" when there are fewer than 3 digits to show.
 * BSB is a branch code, not an account — do NOT pass BSB through here.
 */
export function maskAccount(acct: string | number | null | undefined): string {
  if (acct === null || acct === undefined) return "***";
  const digits = String(acct).replace(/\D/g, "");
  if (digits.length < 3) return "***";
  return "•".repeat(digits.length - 3) + digits.slice(-3);
}

/**
 * Sanitise a params object for audit/log output: mask any key that looks like an
 * account number to its last 3 digits. Leaves bsb, amount, ids, etc. intact.
 * Shallow — our tool params are flat.
 */
export function maskParams(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (/account.*number|bankaccountnumber|accountno\b/i.test(key)) {
      out[key] = maskAccount(value as string);
    } else {
      out[key] = value;
    }
  }
  return out;
}

// ── human edge: cents -> display dollars ─────────────────────────────────────

/**
 * Format integer cents as an AUD display string, e.g. 1245 -> "$12.45".
 * HUMAN EDGE ONLY (hard-rule #2): use this for agent prose / schedule text —
 * never feed the result back into an amount code path. Negative cents are
 * rendered as "-$12.45".
 */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(cents));
  const dollars = Math.floor(abs / 100);
  const remainder = (abs % 100).toString().padStart(2, "0");
  return `${sign}$${dollars.toLocaleString("en-AU")}.${remainder}`;
}

// ── ids / time ───────────────────────────────────────────────────────────────

/** Short unique id. `newId("audit")` -> "audit_<uuid>". */
export function newId(prefix?: string): string {
  const id = crypto.randomUUID();
  return prefix ? `${prefix}_${id}` : id;
}

/** Current instant as an ISO-8601 string (UTC). */
export function nowIso(): string {
  return new Date().toISOString();
}

// ── AU dates ─────────────────────────────────────────────────────────────────

/**
 * Today's date in Australia/Sydney as YYYY-MM-DD. The en-CA locale formats as
 * ISO date parts, and the Sydney time zone pins the "business day" for spend
 * counters and scheduling. Optionally pass a Date to format a specific instant.
 */
export function todayAU(d: Date = new Date()): string {
  return toAUDateString(d);
}

/** Format a Date as YYYY-MM-DD in the Australia/Sydney time zone. */
export function toAUDateString(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);

  let year = "";
  let month = "";
  let day = "";
  for (const p of parts) {
    if (p.type === "year") year = p.value;
    else if (p.type === "month") month = p.value;
    else if (p.type === "day") day = p.value;
  }
  return `${year}-${month}-${day}`;
}

export type Frequency = "weekly" | "fortnightly" | "monthly";

/**
 * Advance a YYYY-MM-DD date by one billing period.
 * weekly +7d, fortnightly +14d, monthly +1 calendar month (end-of-month clamped:
 * Jan 31 + 1mo -> Feb 28/29). We anchor at UTC noon so day arithmetic never
 * slips across a DST boundary, then re-format in the AU zone.
 */
export function addFrequency(dateYmd: string, freq: Frequency): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateYmd);
  if (!m) throw new RangeError(`addFrequency: invalid date "${dateYmd}"`);
  const year = Number(m[1]);
  const month = Number(m[2]); // 1-based
  const day = Number(m[3]);

  if (freq === "weekly" || freq === "fortnightly") {
    const days = freq === "weekly" ? 7 : 14;
    const base = new Date(Date.UTC(year, month - 1, day, 12));
    base.setUTCDate(base.getUTCDate() + days);
    return toAUDateString(base);
  }

  // monthly: move to the same day-of-month next month, clamped to that month's length.
  const targetMonthIndex = month; // 0-based index of *next* month == (month-1)+1
  const targetYear = year + Math.floor(targetMonthIndex / 12);
  const normalizedMonth = targetMonthIndex % 12;
  const lastDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0, 12)).getUTCDate();
  const clampedDay = Math.min(day, lastDay);
  const result = new Date(Date.UTC(targetYear, normalizedMonth, clampedDay, 12));
  return toAUDateString(result);
}

/** Generate the next `count` scheduling dates starting AT `startYmd` (inclusive). */
export function nextNDates(
  startYmd: string,
  freq: Frequency,
  count: number,
): string[] {
  const dates: string[] = [];
  let cursor = startYmd;
  for (let i = 0; i < count; i++) {
    dates.push(cursor);
    cursor = addFrequency(cursor, freq);
  }
  return dates;
}

// ── http ─────────────────────────────────────────────────────────────────────

/** JSON Response with the right content-type. Used for every Worker reply. */
export function jsonResponse(
  body: unknown,
  status = 200,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}
