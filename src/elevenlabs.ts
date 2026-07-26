/**
 * ElevenLabs Conversational AI client — outbound calling only.
 *
 * Contract mirrors pinch.ts (hard-rule #4): every exported function returns
 * `T | StructuredError`. We NEVER throw a raw exception at a caller — network
 * failures, non-2xx responses, and a call ElevenLabs didn't confirm all come
 * back as a structured error object.
 *
 * Endpoint verified against docs.elevenlabs.io (2026-07): outbound calling on a
 * Twilio-connected number is `POST /v1/convai/twilio/outbound-call`, auth via
 * `xi-api-key`, body `{ agent_id, agent_phone_number_id, to_number }`. Response
 * is `{ success, message, conversation_id, callSid }`.
 *
 * The request body also accepts an optional `conversation_initiation_client_data`
 * object (schema `ConversationInitiationClientDataRequest-Input`) — same shape
 * POST /voice/init returns, minus the `type` field (that's only on the webhook
 * RESPONSE, not this request). Its `dynamic_variables` is a flat object of
 * string/number/boolean values; nesting isn't supported. Populating it here
 * primes the agent for THIS call directly, instead of relying solely on the
 * initiation webhook firing in time when the call connects.
 */

import type { Env, StructuredError } from "./types";
import { structuredError } from "./util";

export interface OutboundCallResult {
  conversationId: string;
  callSid: string | null;
}

interface TwilioOutboundCallResponse {
  success?: boolean;
  message?: string;
  conversation_id?: string | null;
  callSid?: string | null;
}

/**
 * Place an outbound call from our Twilio-connected ElevenLabs agent to
 * `toNumber` (E.164 — validated by the caller). When `dynamicVariables` is
 * given, it's sent as `conversation_initiation_client_data.dynamic_variables`
 * on this same request, so the agent has payer context from the moment the
 * call is placed — belt-and-braces alongside POST /voice/init, not a
 * replacement for it (that webhook still fires, and still matters for calls
 * not triggered through /admin/call).
 */
export async function triggerOutboundCall(
  env: Env,
  toNumber: string,
  dynamicVariables?: Record<string, string | number | boolean>,
): Promise<OutboundCallResult | StructuredError> {
  try {
    const requestBody: Record<string, unknown> = {
      agent_id: env.ELEVENLABS_AGENT_ID,
      agent_phone_number_id: env.ELEVENLABS_PHONE_NUMBER_ID,
      to_number: toNumber,
    };
    if (dynamicVariables) {
      requestBody.conversation_initiation_client_data = { dynamic_variables: dynamicVariables };
    }

    const res = await fetch(`${env.ELEVENLABS_API_BASE}/v1/convai/twilio/outbound-call`, {
      method: "POST",
      headers: {
        "xi-api-key": env.ELEVENLABS_API_KEY,
        "content-type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text };
    }

    if (!res.ok) {
      return structuredError(
        "elevenlabs_call_failed",
        "ElevenLabs outbound-call request failed",
        { status: res.status, body: parsed },
      );
    }

    const body = parsed as TwilioOutboundCallResponse;
    if (!body.success || !body.conversation_id) {
      return structuredError(
        "elevenlabs_call_failed",
        body.message ?? "ElevenLabs did not confirm the call",
        { body: parsed },
      );
    }

    return { conversationId: body.conversation_id, callSid: body.callSid ?? null };
  } catch (err) {
    return structuredError("network_error", "Failed to reach ElevenLabs API", {
      cause: String(err),
    });
  }
}
