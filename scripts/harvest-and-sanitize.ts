/**
 * Coleta produtos das listas de cupom, aplica o código e limpa a fila.
 * Uso: npx tsx scripts/harvest-and-sanitize.ts
 */
import { getDb } from "../src/db/index.ts";
import {
  applyListCouponToDeal,
  ingestDealsFromCouponLists,
} from "../src/services/couponHarvest.ts";
import { listStoredCoupons } from "../src/services/mlCoupons.ts";
import { sanitizeSyncedQueue } from "../src/services/queueSanitize.ts";

async function main() {
  console.log("harvest start", new Date().toISOString());
  const harvest = await ingestDealsFromCouponLists({
    maxCoupons: 4,
    maxItemsPerCoupon: 6,
    mintLinks: 4,
  });
  console.log("HARVEST", JSON.stringify(harvest, null, 2));

  const pending = getDb()
    .prepare(
      `SELECT id, coupon FROM deals
       WHERE status IN ('queued','hold_coupon')
         AND coupon IS NOT NULL AND trim(coupon) != ''
         AND coupon_status != 'valid'`,
    )
    .all() as Array<{ id: number; coupon: string }>;
  const byCode = new Map(
    listStoredCoupons(80).map((c) => [String(c.code || "").toUpperCase(), c]),
  );
  for (const row of pending) {
    const found = byCode.get(row.coupon.toUpperCase());
    if (!found) continue;
    const ok = applyListCouponToDeal(row.id, found);
    console.log("APPLY", row.id, row.coupon, ok);
  }

  const sanitized = sanitizeSyncedQueue();
  console.log("SANITIZE", JSON.stringify(sanitized));
  console.log("harvest done", new Date().toISOString());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
