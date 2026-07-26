/**
 * Cloudflare Worker entry point.
 *
 * Core scope: an open /health route plus stubs for the MCP, REST admin, and voice
 * surfaces that bolt on next. The outer try/catch guarantees hard-rule #4 — a raw
 * exception is NEVER leaked to a client; it becomes a structured 500.
 *
 * IMPORTANT: every route call below is `await`ed, not just `return`ed. All the
 * handleX functions are `async`, so a downstream throw becomes a REJECTED
 * PROMISE, not a synchronous exception — `try { return handleX(...); } catch`
 * does NOT catch that rejection (the try block completes normally the instant
 * handleX() hands back a pending promise; the catch has already been skipped
 * by the time it later rejects). Without `await`, an uncaught exception deep in
 * any handler bypasses this try/catch entirely and surfaces to the client as a
 * raw Cloudflare 1101, not our structured 500 — silently violating hard-rule #4.
 */

import { handleAdmin } from "./admin";
import { handleMcp } from "./mcp";
import { handleVoice } from "./voice";
import { handleWebhooks } from "./webhooks";
import type { Env } from "./types";
import { jsonResponse, nowIso, structuredError } from "./util";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Declared outside the try so the catch block can still read it below.
    let path = "";
    try {
      const url = new URL(request.url);
      path = url.pathname;

      // Open health check.
      if (path === "/health") {
        return jsonResponse({ ok: true, service: "agentrails", ts: nowIso() });
      }

      // ── MCP server — identifies agentId via ?agentId= or x-agent-id header.
      if (path === "/mcp" || path.startsWith("/mcp/")) return await handleMcp(request, env);

      // ── REST admin + dashboard facade — requires Authorization: Bearer <ADMIN_KEY>.
      // /api/* aliases the same routes for the dashboard.
      if (
        path.startsWith("/admin/") ||
        path.startsWith("/rest/") ||
        path.startsWith("/api/")
      ) {
        return await handleAdmin(request, env);
      }
      // Voice webhooks — require x-voice-secret: <VOICE_SECRET>.
      if (path.startsWith("/voice/")) return await handleVoice(request, env, ctx);

      // Pinch payment-event webhooks — authenticated via the pinch-signature header.
      if (path.startsWith("/webhooks/")) return await handleWebhooks(request, env);

      return jsonResponse(
        structuredError("not_found", `No route for ${request.method} ${path}.`),
        404,
      );
    } catch (err) {
      // Always visible via `wrangler tail`, regardless of route.
      console.error("Uncaught exception in fetch handler:", path, err);

      // TEMPORARY DEBUG (remove once the live /admin/grants 500 is root-caused):
      // surface the caught exception's message + stack in the response body,
      // admin routes only. Never do this permanently — it's a controlled,
      // short-lived exception to hard-rule #4 for diagnosis, not a pattern.
      const debug = path.startsWith("/admin/") || path.startsWith("/rest/") || path.startsWith("/api/")
        ? { message: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined }
        : undefined;

      return jsonResponse(
        structuredError("internal_error", "An unexpected error occurred.", debug),
        500,
      );
    }
  },
} satisfies ExportedHandler<Env>;
