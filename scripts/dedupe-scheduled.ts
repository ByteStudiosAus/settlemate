/**
 * Deduplicates scheduled payments for a given payer.
 * Groups by (amount, transactionDate, description), keeps the first, deletes the rest.
 * Dry-run by default; pass --apply to execute deletions.
 *
 * Usage:
 *   npx tsx scripts/dedupe-scheduled.ts [--apply]
 */

const PAYER_ID = "pyr_Qcnw8khEhA53Lh";
const BASE = process.env.PINCH_API_BASE ?? "https://api.getpinch.com.au/test";
const AUTH_URL = process.env.PINCH_AUTH_URL ?? "https://auth.getpinch.com.au/connect/token";
const CLIENT_ID = process.env.PINCH_PUBLISHABLE_KEY ?? "";
const CLIENT_SECRET = process.env.PINCH_SECRET_KEY ?? "";
const APPLY = process.argv.includes("--apply");

async function getToken(): Promise<string> {
  const res = await fetch(AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`Auth failed: ${res.status} ${await res.text()}`);
  const { access_token } = (await res.json()) as { access_token: string };
  return access_token;
}

async function pinchGet<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, "pinch-version": "2020.1" },
  });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function pinchDelete(token: string, path: string): Promise<void> {
  const res = await fetch(`${BASE}${path}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}`, "pinch-version": "2020.1" },
  });
  if (!res.ok) throw new Error(`DELETE ${path} -> ${res.status} ${await res.text()}`);
}

interface Payment {
  id: string;
  status?: string;
  amount?: number;
  transactionDate?: string;
  description?: string;
}

async function main() {
  const token = await getToken();

  // GET /payments/payer/{id} returns a bare array
  const payments = await pinchGet<Payment[]>(token, `/payments/payer/${PAYER_ID}`);

  const scheduled = payments.filter((p) => p.status === "scheduled");
  console.log(`Found ${scheduled.length} scheduled payments for ${PAYER_ID}`);

  // Group by (amount, date normalised to YYYY-MM-DD, description)
  const groups = new Map<string, Payment[]>();
  for (const p of scheduled) {
    const date = (p.transactionDate ?? "").slice(0, 10);
    const key = `${p.amount ?? ""}|${date}|${p.description ?? ""}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(p);
    groups.set(key, bucket);
  }

  const toDelete: Payment[] = [];
  for (const [key, bucket] of groups) {
    if (bucket.length > 1) {
      console.log(`  Duplicate group "${key}": ${bucket.length} payments, keeping ${bucket[0]!.id}`);
      toDelete.push(...bucket.slice(1));
    }
  }

  if (toDelete.length === 0) {
    console.log("No duplicates found.");
    return;
  }

  console.log(`\n${APPLY ? "Deleting" : "Would delete"} ${toDelete.length} duplicate(s):`);
  for (const p of toDelete) {
    console.log(`  ${p.id}  amount=${p.amount}  date=${(p.transactionDate ?? "").slice(0, 10)}  desc="${p.description ?? ""}"`);
    if (APPLY) {
      await pinchDelete(token, `/payments/${p.id}`);
      console.log(`    -> deleted`);
    }
  }

  if (!APPLY) {
    console.log("\nDry run — pass --apply to execute deletions.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
