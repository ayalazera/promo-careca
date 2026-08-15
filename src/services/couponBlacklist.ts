import { getDb } from "../db/index.js";

function ensureTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS coupon_fail_counts (
      code TEXT PRIMARY KEY,
      fails INTEGER NOT NULL DEFAULT 0,
      blacklisted INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

const NEVER_BLACKLIST = new Set([
  "BRINQUEDOS",
  "OFFMELI",
  "QUEROCUPONS",
  "ECONOMIAML",
]);

export function noteCouponTestResult(code: string | null | undefined, ok: boolean): void {
  const c = String(code || "").trim().toUpperCase();
  if (!c || NEVER_BLACKLIST.has(c)) return;
  ensureTable();
  if (ok) {
    getDb()
      .prepare(
        `INSERT INTO coupon_fail_counts (code, fails, blacklisted, updated_at)
         VALUES (?, 0, 0, datetime('now'))
         ON CONFLICT(code) DO UPDATE SET fails = 0, blacklisted = 0, updated_at = datetime('now')`,
      )
      .run(c);
    return;
  }
  getDb()
    .prepare(
      `INSERT INTO coupon_fail_counts (code, fails, blacklisted, updated_at)
       VALUES (?, 1, 0, datetime('now'))
       ON CONFLICT(code) DO UPDATE SET
         fails = fails + 1,
         blacklisted = CASE WHEN fails + 1 >= 3 THEN 1 ELSE blacklisted END,
         updated_at = datetime('now')`,
    )
    .run(c);
}

export function isCouponBlacklisted(code: string | null | undefined): boolean {
  const c = String(code || "").trim().toUpperCase();
  if (!c) return false;
  ensureTable();
  const row = getDb()
    .prepare(`SELECT blacklisted FROM coupon_fail_counts WHERE code = ?`)
    .get(c) as { blacklisted?: number } | undefined;
  return Number(row?.blacklisted) === 1;
}
