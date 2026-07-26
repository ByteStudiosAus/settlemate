/**
 * MCP surface for the nine agent-facing tools.
 *
 * A stateless JSON-RPC 2.0 handler over a single POST /mcp endpoint — the shape
 * MCP's streamable-HTTP transport uses for request/response (no SSE session is
 * needed for these tools, none of which stream). Handling the protocol directly
 * keeps agentId resolution and result serialisation in our control and avoids
 * standing up the SDK's stateful transport inside a Worker.
 *
 * Methods: `initialize`, `tools/list`, `tools/call`, `ping`. Notifications
 * (id absent) are acknowledged with 202 and no body, per JSON-RPC.
 *
 * agentId is resolved from `?agentId=` or the `x-agent-id` header.
 * A call with no agentId still lists tools, but `tools/call` refuses — the
 * permissions engine is keyed on a real agent.
 */

import { getTool, inputJsonSchema, TOOLS, type ToolContext } from "./tools";
import type { Env } from "./types";
import { isDeclined, isStructuredError } from "./types";
import { jsonResponse } from "./util";

const PROTOCOL_VERSION = "2024-11-05";

// ── JSON-RPC error codes (subset we use) ─────────────────────────────────────
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

function rpcResult(id: JsonRpcId, result: unknown): Response {
  return jsonResponse({ jsonrpc: "2.0", id, result });
}

function rpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): Response {
  const error: { code: number; message: string; data?: unknown } = { code, message };
  if (data !== undefined) error.data = data;
  return jsonResponse({ jsonrpc: "2.0", id, error });
}

/** Resolve the calling agentId from query param or header (query wins). */
function resolveAgentId(request: Request, url: URL): string | null {
  const q = url.searchParams.get("agentId");
  if (q && q.trim()) return q.trim();
  const h = request.headers.get("x-agent-id");
  if (h && h.trim()) return h.trim();
  return null;
}

/**
 * Wrap a tool result as MCP tool-call content. A Declined or StructuredError is
 * still a *successful* JSON-RPC response carrying `isError: true` — the agent
 * reads the structured body and relays it, rather than seeing a transport fault.
 */
function toolContent(result: unknown): {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
  structuredContent: unknown;
} {
  const isError = isStructuredError(result) || isDeclined(result);
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    isError,
    structuredContent: result,
  };
}

async function handleRpc(
  req: JsonRpcRequest,
  ctx: { env: Env; agentId: string | null },
): Promise<Response> {
  const id = req.id ?? null;

  switch (req.method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "agentrails", version: "0.1.0" },
      });

    case "ping":
      return rpcResult(id, {});

    case "tools/list":
      return rpcResult(id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: inputJsonSchema(t),
        })),
      });

    case "tools/call": {
      const params = (req.params ?? {}) as { name?: unknown; arguments?: unknown };
      if (typeof params.name !== "string") {
        return rpcError(id, INVALID_PARAMS, "tools/call requires a string `name`.");
      }
      const tool = getTool(params.name);
      if (!tool) {
        return rpcError(id, METHOD_NOT_FOUND, `Unknown tool "${params.name}".`);
      }
      if (!ctx.agentId) {
        // No identity -> no enforce() key. Surface as tool content so the agent
        // can read WHY, not as a bare transport error.
        return rpcResult(
          id,
          toolContent({
            declined: true,
            reason: "no_grant",
            message:
              "No agentId supplied. Connect with ?agentId=<id> or an x-agent-id header.",
            tool: params.name,
          }),
        );
      }
      const toolCtx: ToolContext = { env: ctx.env, agentId: ctx.agentId };
      const result = await tool.run(toolCtx, params.arguments);
      return rpcResult(id, toolContent(result));
    }

    default:
      // Unknown notification (no id) -> ack silently; unknown request -> error.
      if (req.id === undefined) return new Response(null, { status: 202 });
      return rpcError(id, METHOD_NOT_FOUND, `Unknown method "${req.method}".`);
  }
}

/** Entry point wired to POST /mcp. */
export async function handleMcp(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (request.method !== "POST") {
    // GET would open an SSE stream in full streamable-HTTP; none of our tools
    // stream, so we only accept POST. 405 signals "no server-initiated stream".
    return jsonResponse(
      { jsonrpc: "2.0", id: null, error: { code: INVALID_REQUEST, message: "MCP endpoint accepts POST only." } },
      405,
      { allow: "POST" },
    );
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return rpcError(null, PARSE_ERROR, "Request body is not valid JSON.");
  }

  const agentId = resolveAgentId(request, url);

  // Batch request: an array of rpc calls. Rare for these tools but valid.
  if (Array.isArray(payload)) {
    if (payload.length === 0) {
      return rpcError(null, INVALID_REQUEST, "Empty batch.");
    }
    const responses = await Promise.all(
      payload.map(async (item) => {
        if (!isRpcRequest(item)) return errorObj(null, INVALID_REQUEST, "Invalid request.");
        const res = await handleRpc(item, { env, agentId });
        // 202 (notification) contributes nothing to a batch body.
        if (res.status === 202) return null;
        return res.json();
      }),
    );
    const body = responses.filter((r) => r !== null);
    return jsonResponse(body);
  }

  if (!isRpcRequest(payload)) {
    return rpcError(null, INVALID_REQUEST, "Not a valid JSON-RPC 2.0 request.");
  }
  return handleRpc(payload, { env, agentId });
}

// ── narrowing + batch helpers ─────────────────────────────────────────────────

function isRpcRequest(x: unknown): x is JsonRpcRequest {
  return (
    typeof x === "object" &&
    x !== null &&
    (x as JsonRpcRequest).jsonrpc === "2.0" &&
    typeof (x as JsonRpcRequest).method === "string"
  );
}

function errorObj(id: JsonRpcId, code: number, message: string): unknown {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
