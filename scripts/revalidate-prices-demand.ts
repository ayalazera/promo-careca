/**
 * Revalida preços com cupom na fila e remove baixa procura.
 * Uso: npx tsx scripts/revalidate-prices-demand.ts
 */
import { getDb, logAntiBan } from "../src/db/index.ts";
import { refreshDealLivePrice } from "../src/services/priceRefresh.ts";
import { sanitizeSyncedQueue, isUnwantedPromoTitle } from "../src/services/queueSanitize.ts";
import { isLowDemandNicheTitle } from "../src/services/demandFilter.ts";

async function main() {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, title, price, price_with_coupon, coupon, status
       FROM deals
       WHERE status IN ('queued','hold_coupon')
          OR id IN (2260, 2256, 2259, 2261)
       ORDER BY id DESC
       LIMIT 80`,
    )
    .all() as Array<{
    id: number;
    title: string;
    price: number;
    price_with_coupon: number | null;
    coupon: string | null;
    status: string;
  }>;

  let fixed = 0;
  let skippedDemand = 0;
  for (const row of rows) {
    if (isLowDemandNicheTitle(row.title) || isUnwantedPromoTitle(row.title)) {
      if (row.status === "queued" || row.status === "hold_coupon") {
        db.prepare(
          `UPDATE deals SET status = 'skipped', coupon_status = COALESCE(coupon_status, 'invalid')
           WHERE id = ?`,
        ).run(row.id);
        skippedDemand += 1;
        console.log("SKIP demanda", row.id, row.title.slice(0, 60));
      }
      continue;
    }
    try {
      const r = await refreshDealLivePrice(row.id);
      const after = db
        .prepare(
          `SELECT price, price_with_coupon FROM deals WHERE id = ?`,
        )
        .get(row.id) as { price: number; price_with_coupon: number | null };
      if (r.changed) {
        fixed += 1;
        console.log(
          "FIX",
          row.id,
          `${row.price}→${after.price}`,
          `cupom ${row.price_with_coupon}→${after.price_with_coupon}`,
          row.title.slice(0, 40),
        );
      }
    } catch (e) {
      console.log("ERR", row.id, e instanceof Error ? e.message : e);
    }
  }

  const sanitize = sanitizeSyncedQueue();
  logAntiBan(
    "revalidate_prices_demand",
    `fixed=${fixed} skipDemand=${skippedDemand} sanitizeDeleted=${sanitize.deleted}`,
  );
  console.log({
    scanned: rows.length,
    fixed,
    skippedDemand,
    sanitize,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
