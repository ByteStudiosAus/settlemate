/**
 * Shared types and the Cloudflare Worker environment binding surface.
 * Everything the Worker touches (KV namespaces, vars, secrets) is declared here.
 */

export interface Env {
  // KV namespaces
  GRANTS: KVNamespace;
  SPEND: KVNamespace;
  AUDIT: KVNamespace;
  TOKENS: KVNamespace;
  /** create_payment_plan idempotency keys — TTL 10 min. key = idem:plan:<sha256> */
  IDEMPOTENCY: KVNamespace;

  // Non-secret vars (wrangler.toml [vars])
  PINCH_API_BASE: string;
  PINCH_AUTH_URL: string;
  PINCH_VERSION: string;
  ENABLE_TWILIO: string;
  ELEVENLABS_API_BASE: string;

  // Secrets (wrangler secret put ...)
  PINCH_SECRET_KEY: string;
  PINCH_PUBLISHABLE_KEY: string;
  PINCH_MERCHANT_ID: string;
  ADMIN_KEY: string;
  VOICE_SECRET: string;
  /** ElevenLabs API key (xi-api-key) — outbound calling only. */
  ELEVENLABS_API_KEY: string;
  /** The ElevenLabs Conversational AI agent to place the call as. */
  ELEVENLABS_AGENT_ID: string;
  /** The Twilio-connected ElevenLabs phone number to call FROM. */
  ELEVENLABS_PHONE_NUMBER_ID: string;
  /** Signing secret ("whsec_...") from POST /webhooks — verifies the pinch-signature header. */
  PINCH_WEBHOOK_SECRET: string;
}

/** Structured, readable error object. We RETURN these; we never throw stack traces at clients. */
export interface StructuredError {
  error: true;
  code: string;
  message: string;
  details?: unknown;
}

/** A permission refusal an agent can relay in natural language. */
export interface Declined {
  declined: true;
  reason:
    | "no_grant"
    | "grant_inactive"
    | "tool_not_allowed"
    | "exceeds_per_transaction_limit"
    | "exceeds_daily_limit";
  message: string;
  limitCents?: number;
  attemptedCents?: number;
  spentTodayCents?: number;
  tool?: string;
}

/** A grant record: an agent's scoped authority over the merchant's real Pinch account. */
export interface Grant {
  agentId: string;
  name: string;
  maxPerTransactionCents: number;
  maxDailyCents: number;
  allowedTools: string[];
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

/** One audit entry — every attempt, allowed or declined. */
export interface AuditEntry {
  ts: string;
  agentId: string;
  tool: string;
  paramsSummary: Record<string, unknown>;
  /**
   * "settled" | "failed" | "processing" are written by the Pinch webhook
   * handler (src/webhooks.ts) to record a payment's settlement lifecycle —
   * not an agent-permission outcome, but the same append-only audit trail.
   */
  outcome: "allowed" | "declined" | "error" | "duplicate_suppressed" | "settled" | "failed" | "processing";
  reason?: string;
  amountCents?: number;
  resultId?: string;
}

export function isDeclined(x: unknown): x is Declined {
  return typeof x === "object" && x !== null && (x as Declined).declined === true;
}

export function isStructuredError(x: unknown): x is StructuredError {
  return typeof x === "object" && x !== null && (x as StructuredError).error === true;
}
