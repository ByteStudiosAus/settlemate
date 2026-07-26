/**
 * Agent-to-agent demo: two Claude agents transacting through agentrails.
 *
 * Agent A (Byte Studios billing) — creates a payer, adds a bank account,
 *   creates an invoice for the agreed amount.
 * Agent B (Soapbox finance) — calls get_agent_limits, verifies policy,
 *   then pays (charge_now) or relays the structured decline in natural language.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... ADMIN_KEY=... npm run a2a
 *   ANTHROPIC_API_KEY=... ADMIN_KEY=... npm run a2a -- --scenario=blocked
 *
 * Requires a running `wrangler dev` (default http://localhost:8787) with a
 * seeded demo-agent grant (POST /admin/seed first, or the script seeds itself).
 */

import Anthropic from "@anthropic-ai/sdk";
import chalk from "chalk";

// ── config ────────────────────────────────────────────────────────────────────

const BASE = process.env.BASE_URL ?? "http://localhost:8787";
const ADMIN_KEY = process.env.ADMIN_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const SCENARIO = process.argv.includes("--scenario=blocked") ? "blocked" : "normal";

// normal: $1,200 — within demo-agent's $2,000 per-tx limit. blocked: $9,000 — exceeds it.
const INVOICE_CENTS = SCENARIO === "blocked" ? 900_000 : 120_000;
const INVOICE_DISPLAY = SCENARIO === "blocked" ? "$9,000.00" : "$1,200.00";

const AGENT_A_ID = "demo-agent"; // Byte Studios billing
const AGENT_B_ID = "demo-agent"; // Soapbox finance (same grant for demo simplicity)

if (!ADMIN_KEY) {
  console.error(chalk.red("✘ ADMIN_KEY env var required"));
  process.exit(1);
}
if (!ANTHROPIC_API_KEY) {
  console.error(chalk.red("✘ ANTHROPIC_API_KEY env var required"));
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ── MCP helpers ───────────────────────────────────────────────────────────────

async function mcpCall(agentId: string, toolName: string, args: unknown): Promise<unknown> {
  const res = await fetch(`${BASE}/mcp?agentId=${agentId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
  });
  const body = (await res.json()) as {
    result?: { content?: Array<{ text: string }>; isError?: boolean };
    error?: unknown;
  };
  if (body.error) throw new Error(`MCP error: ${JSON.stringify(body.error)}`);
  const text = body.result?.content?.[0]?.text ?? "{}";
  return JSON.parse(text);
}

async function mcpToolsList(agentId: string): Promise<Array<{ name: string; description: string; inputSchema: unknown }>> {
  const res = await fetch(`${BASE}/mcp?agentId=${agentId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const body = (await res.json()) as { result?: { tools: Array<{ name: string; description: string; inputSchema: unknown }> } };
  return body.result?.tools ?? [];
}

// ── admin helpers ─────────────────────────────────────────────────────────────

async function ensureSeeded() {
  const res = await fetch(`${BASE}/admin/grants/${AGENT_A_ID}`, {
    headers: { authorization: `Bearer ${ADMIN_KEY}` },
  });
  if (res.status === 404) {
    console.log(chalk.dim("  (no grant found — seeding demo data…)"));
    await fetch(`${BASE}/admin/seed`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_KEY}`, "content-type": "application/json" },
    });
  }
}

// ── Claude agent runner ───────────────────────────────────────────────────────

interface AgentTask {
  agentId: string;
  systemPrompt: string;
  userMessage: string;
  label: string;
  color: (s: string) => string;
}

async function runAgent(task: AgentTask): Promise<string> {
  const tools = await mcpToolsList(task.agentId);

  // Convert MCP tool list to Anthropic tool format
  const anthropicTools: Anthropic.Tool[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool["input_schema"],
  }));

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: task.userMessage },
  ];

  console.log(task.color(`\n[${task.label}] `) + chalk.dim(task.userMessage));

  // Agentic loop
  for (let turn = 0; turn < 10; turn++) {
    const response = await anthropic.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 1024,
      system: task.systemPrompt,
      tools: anthropicTools,
      messages,
    });

    // Collect text and tool uses
    const textBlocks = response.content.filter((b) => b.type === "text");
    const toolUses = response.content.filter((b) => b.type === "tool_use");

    for (const tb of textBlocks) {
      if (tb.type === "text" && tb.text.trim()) {
        console.log(task.color(`[${task.label}] `) + tb.text);
      }
    }

    if (response.stop_reason === "end_turn" || toolUses.length === 0) {
      const finalText = textBlocks.map((b) => (b.type === "text" ? b.text : "")).join("\n").trim();
      return finalText;
    }

    // Execute tool calls via MCP
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      if (tu.type !== "tool_use") continue;
      console.log(chalk.dim(`  → ${tu.name}(${JSON.stringify(tu.input).slice(0, 80)}…)`));
      try {
        const result = await mcpCall(task.agentId, tu.name, tu.input);
        const resultText = JSON.stringify(result, null, 2);
        console.log(chalk.dim(`  ← ${resultText.slice(0, 120)}${resultText.length > 120 ? "…" : ""}`));
        toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: resultText });
      } catch (err) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify({ error: true, code: "tool_call_failed", message: String(err) }),
          is_error: true,
        });
      }
    }

    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user", content: toolResults });
  }

  return "(max turns reached)";
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(chalk.bold.white(`\nagentrails A2A demo — scenario: ${chalk.bold(SCENARIO)}\n`));
  console.log(chalk.dim(`Worker: ${BASE}  |  Invoice: ${INVOICE_DISPLAY}`));

  await ensureSeeded();

  // ── Agent A: Byte Studios billing ─────────────────────────────────────────
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Australia/Sydney" });

  const agentAResult = await runAgent({
    agentId: AGENT_A_ID,
    label: "Agent A · Byte Studios",
    color: chalk.bold.blue,
    systemPrompt:
      "You are the billing agent for Byte Studios. Your job is to onboard a new client " +
      "called Soapbox Pty Ltd and create an invoice for services rendered. " +
      "Use the available tools to: 1) create a payer for Soapbox, 2) add their bank account " +
      "(BSB 062-000, account 98765432, account name 'Soapbox Pty Ltd'), " +
      `3) create an invoice for ${INVOICE_DISPLAY} due today (${today}) with description ` +
      "'Byte Studios — web platform build Q3'. " +
      "Report the payer id, source id, and payment id at the end.",
    userMessage: `Onboard Soapbox Pty Ltd (email: accounts@soapbox.example, mobile: 0411000001) and invoice them ${INVOICE_DISPLAY} for the Q3 web platform build, due today.`,
  });

  // Extract payer id from Agent A's result for Agent B to use
  const payerIdMatch = /pyr_[a-zA-Z0-9_-]+/.exec(agentAResult);
  const payerId = payerIdMatch?.[0];

  // ── Agent B: Soapbox finance ──────────────────────────────────────────────
  await runAgent({
    agentId: AGENT_B_ID,
    label: "Agent B · Soapbox Finance",
    color: chalk.bold.magenta,
    systemPrompt:
      "You are the finance agent for Soapbox Pty Ltd. Your job is to verify payment policy " +
      "and settle invoices. Always call get_agent_limits first to check your authority. " +
      "If a payment would exceed your limits, explain the decline clearly in plain English " +
      "— include the limit, the attempted amount, and suggest the merchant contact the admin " +
      "to raise the limit. " +
      "If within limits, choose the settlement method by the payer's payment source: " +
      "for a CARD source, use charge_now for an immediate realtime charge; " +
      "for a BANK ACCOUNT source, use create_invoice scheduled for today instead of charge_now, " +
      "because Australian bank debits settle via batch and do not support realtime charges. " +
      "State your choice out loud before you act — e.g. 'bank debits settle via batch, so I'm " +
      "scheduling the debit for today rather than a realtime charge.' " +
      "Always complete the settlement by creating a payment, then confirm the outcome and payment id.",
    userMessage: payerId
      ? `We have received an invoice for ${INVOICE_DISPLAY} from Byte Studios. The payer id is ${payerId} and it is paid by an Australian bank account. Today's date is ${today} (Australia/Sydney) — use it for any scheduling. Please check your payment authority and settle this invoice if permitted.`
      : `We have received an invoice for ${INVOICE_DISPLAY} from Byte Studios. Today's date is ${today} (Australia/Sydney). Check your payment authority and advise whether this payment can proceed.`,
  });

  console.log(chalk.bold.green(`\n✅  A2A demo complete (scenario: ${SCENARIO})\n`));
}

main().catch((err) => {
  console.error(chalk.red(`\n✘ ${String(err)}\n`));
  process.exit(1);
});
