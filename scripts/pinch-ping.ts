/**
 * Live sanity check against the Pinch SANDBOX. Run before deploying to confirm
 * the OAuth credentials work end-to-end. This runs in Node (tsx), NOT the Worker
 * runtime — there's no KV here, so it re-implements the token POST inline rather
 * than importing getToken().
 *
 *   PINCH_PUBLISHABLE_KEY=app_test_... PINCH_SECRET_KEY=sk_test_... npm run pinch:ping
 *
 * If OAuth 401s, the client_id is wrong: client_id must be the Application ID
 * (app_...), not the publishable key (pk_...). Put the app_... value into
 * PINCH_PUBLISHABLE_KEY.
 */

import chalk from "chalk";

const AUTH_URL =
  process.env.PINCH_AUTH_URL ?? "https://auth.getpinch.com.au/connect/token";
const API_BASE = process.env.PINCH_API_BASE ?? "https://api.getpinch.com.au/test";
const VERSION = process.env.PINCH_VERSION ?? "2020.1";
const CLIENT_ID = process.env.PINCH_PUBLISHABLE_KEY; // holds the Application ID
const CLIENT_SECRET = process.env.PINCH_SECRET_KEY;

function fail(msg: string): never {
  console.error(chalk.red(`✘ ${msg}`));
  process.exit(1);
}

async function main(): Promise<void> {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    fail(
      "Missing PINCH_PUBLISHABLE_KEY (Application ID) and/or PINCH_SECRET_KEY. " +
        "Export them or source .dev.vars.",
    );
  }
  if (!API_BASE.endsWith("/test")) {
    fail(`Refusing to run: API base is not the sandbox (/test): ${API_BASE}`);
  }

  console.log(chalk.dim(`auth : ${AUTH_URL}`));
  console.log(chalk.dim(`api  : ${API_BASE}`));
  console.log(chalk.dim(`client_id: ${CLIENT_ID}`));

  // 1. OAuth
  const tokenRes = await fetch(AUTH_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });

  if (!tokenRes.ok) {
    const body = await tokenRes.text();
    fail(`OAuth failed (HTTP ${tokenRes.status}): ${body}`);
  }

  const token = (await tokenRes.json()) as {
    access_token: string;
    expires_in: number;
    token_type: string;
    scope?: string;
  };
  console.log(
    chalk.green(
      `✔ OAuth ok — token ${token.access_token.slice(0, 6)}…(${token.access_token.length} chars), ` +
        `expires_in=${token.expires_in}, scope=${token.scope ?? "?"}`,
    ),
  );

  // 2. Authenticated read
  const listRes = await fetch(`${API_BASE}/payments/scheduled?page=1&pageSize=1`, {
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      "pinch-version": VERSION,
    },
  });

  if (!listRes.ok) {
    const body = await listRes.text();
    fail(`Authenticated read failed (HTTP ${listRes.status}): ${body}`);
  }

  const page = (await listRes.json()) as { totalItems?: number };
  console.log(
    chalk.green(
      `✔ Authenticated read ok — GET /payments/scheduled totalItems=${page.totalItems ?? "?"}`,
    ),
  );

  console.log(chalk.bold.green("\nPinch sandbox reachable. Credentials valid. ✅"));
}

main().catch((err) => fail(String(err)));
