/**
 * Smoke test against a running `wrangler dev` instance.
 * Steps: seed → create_payment_plan (4x fortnightly, $2400) → list_overdue
 *        → GET /admin/recovered → GET /admin/audit?limit=10
 *
 * Usage:
 *   ADMIN_KEY=<key> npm run smoke
 *   ADMIN_KEY=<key> BASE_URL=http://localhost:8787 npm run smoke
 */

import chalk from "chalk";

const BASE = process.env.BASE_URL ?? "http://localhost:8787";
const ADMIN_KEY = process.env.ADMIN_KEY;
const AGENT_ID = "demo-agent";

if (!ADMIN_KEY) {
  console.error(chalk.red("✘ ADMIN_KEY env var required"));
  process.exit(1);
}

const adminHeaders = {
  "content-type": "application/json",
  authorization: `Bearer ${ADMIN_KEY}`,
};

// ── helpers ───────────────────────────────────────────────────────────────────

function step(label: string) {
  console.log("\n" + chalk.bold.cyan(`▶ ${label}`));
}

function ok(label: string, detail?: string) {
  console.log(chalk.green(`  ✔ ${label}`) + (detail ? chalk.dim(`  ${detail}`) : ""));
}

function fail(label: string, body: unknown): never {
  console.error(chalk.red(`  ✘ ${label}`));
  console.error(chalk.dim(JSON.stringify(body, null, 2)));
  process.exit(1);
}

async function adminGet(path: string) {
  const res = await fetch(`${BASE}${path}`, { headers: adminHeaders });
  const body = await res.json();
  if (!res.ok) fail(`GET ${path} → ${res.status}`, body);
  return body as Record<string, unknown>;
}

async function adminPost(path: string, payload?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: adminHeaders,
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
  });
  const body = await res.json();
  if (res.status !== 200 && res.status !== 201) fail(`POST ${path} → ${res.status}`, body);
  return body as Record<string, unknown>;
}

async function mcp(method: string, params?: unknown) {
  const res = await fetch(`${BASE}/mcp?agentId=${AGENT_ID}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as {
    result?: { content?: Array<{ text: string }>; isError?: boolean };
    error?: unknown;
  };
  if (body.error) fail(`MCP ${method}`, body.error);
  const content = body.result?.content?.[0]?.text;
  if (!content) fail(`MCP ${method} — no content`, body);
  const parsed = JSON.parse(content!) as Record<string, unknown>;
  if (body.result?.isError) fail(`MCP ${method} tool error`, parsed);
  return parsed;
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(chalk.bold.white(`\nagentrails smoke test → ${BASE}\n`));

  // 1. Seed
  step("1 / 5  POST /admin/seed");
  const seed = await adminPost("/admin/seed");
  const payers = seed.payers as Array<{ payerId?: string; name: string }>;
  const firstPayer = payers.find((p) => p.payerId);
  if (!firstPayer?.payerId) fail("seed returned no payers with payerId", seed);
  ok(`grant created for ${AGENT_ID}`);
  ok(`${payers.filter((p) => p.payerId).length} payers seeded`);
  const payerId = firstPayer.payerId!;
  ok(`using payerId ${payerId} for payment plan`);

  // 2. create_payment_plan — 4x fortnightly, matched to the payer's ACTUAL
  // overdue balance (create_payment_plan refuses a total that differs from it
  // by more than 20%, so we look the real figure up first rather than guess).
  step("2 / 5  MCP tools/call create_payment_plan  (4× fortnightly, matched to overdue balance)");
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Australia/Sydney" });
  const payerOverdue = await mcp("tools/call", { name: "list_overdue", arguments: { payerId } });
  const overdueItems = payerOverdue.overdue as Array<{ amountCents?: number }>;
  const overdueTotalCents = overdueItems.reduce((sum, o) => sum + (o.amountCents ?? 0), 0);
  const planTotalCents = overdueTotalCents > 0 ? overdueTotalCents : 240000;
  ok(`payer's overdue balance is ${(overdueTotalCents / 100).toLocaleString("en-AU", { style: "currency", currency: "AUD" })}`);
  const plan = await mcp("tools/call", {
    name: "create_payment_plan",
    arguments: {
      payerId,
      totalAmountCents: planTotalCents,
      instalments: 4,
      frequency: "fortnightly",
      startDate: today,
      description: "Smoke test plan",
    },
  });
  const schedule = plan.schedule as Array<{ instalment: number; date: string; amountDisplay: string; paymentId: string }>;
  ok(`plan created — ${plan.totalDisplay}`, plan.summary as string);
  for (const s of schedule) {
    ok(`  instalment ${s.instalment}  ${s.date}  ${s.amountDisplay}  ${s.paymentId}`);
  }

  // 3. list_overdue
  step("3 / 5  MCP tools/call list_overdue");
  const overdue = await mcp("tools/call", { name: "list_overdue", arguments: {} });
  ok(`list_overdue → ${overdue.count} overdue item(s) (scope: ${JSON.stringify(overdue.scope)})`);
  if ((overdue.count as number) > 0) {
    const items = overdue.overdue as Array<{ id: string; amountDisplay: string; status: string }>;
    for (const item of items.slice(0, 5)) {
      ok(`  ${item.id}  ${item.amountDisplay}  ${item.status}`);
    }
    if ((overdue.count as number) > 5) ok(`  … and ${(overdue.count as number) - 5} more`);
  }

  // 4. /admin/recovered  (scope: scheduled payments only — use ?payerId= for payer-scoped)
  step("4 / 5  GET /admin/recovered");
  const recovered = await adminGet("/admin/recovered");
  ok(
    `recovered → ${recovered.recoveredDisplay} across ${recovered.count} transferred payment(s)`,
    `(scope: ${JSON.stringify(recovered.scope)})`,
  );

  // 5. /admin/audit last 10
  step("5 / 5  GET /admin/audit?limit=10");
  const audit = await adminGet("/admin/audit?limit=10");
  const entries = audit.entries as Array<{ ts: string; agentId: string; tool: string; outcome: string }>;
  ok(`${audit.count} entries returned (newest first)`);
  for (const e of entries) {
    const outcome =
      e.outcome === "allowed"
        ? chalk.green(e.outcome)
        : e.outcome === "declined"
          ? chalk.yellow(e.outcome)
          : chalk.red(e.outcome);
    console.log(
      chalk.dim(`  ${e.ts}`) +
        `  ${chalk.bold(e.agentId)}  ${e.tool}  ` +
        outcome,
    );
  }

  console.log(chalk.bold.green("\n✅  Smoke test passed\n"));
}

main().catch((err) => {
  console.error(chalk.red(`\n✘ Unexpected error: ${String(err)}\n`));
  process.exit(1);
});
