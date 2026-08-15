/**
 * Revalida cupons digitáveis na fila via PDP (has_items + given_discount).
 * Demove só com evidência tracking: has_items=false ou given=0.
 * PDP vazio / só raw → inconclusivo (não demove).
 */
import { getDb, logAntiBan, type Deal } from "../src/db/index.js";
import {
  confirmDigitableCouponOnPdp,
  isDigitableCouponCode,
} from "../src/services/mlCoupons.js";
import { normalizeItemId, hubSessionReady } from "../src/services/mlHub.js";
import { isPlausibleProductPrice } from "../src/services/priceSanity.js";

async function main() {
  if (!hubSessionReady()) {
    console.log("Hub offline — abort");
    process.exit(1);
  }
  const rows = getDb()
    .prepare(
      `SELECT * FROM deals
       WHERE status IN ('queued','hold_coupon')
         AND coupon IS NOT NULL AND trim(coupon) != ''
         AND coupon_status = 'valid'`,
    )
    .all() as Deal[];

  let checked = 0;
  let demoted = 0;
  let kept = 0;
  let deferred = 0;
  for (const d of rows) {
    if (!isDigitableCouponCode(d.coupon)) continue;
    const itemId =
      normalizeItemId(d.external_id) || normalizeItemId(d.product_url);
    const unit = isPlausibleProductPrice(d.price, { reference: d.old_price })
      ? d.price
      : Number(d.old_price) || 0;
    if (!itemId || !(unit > 0)) continue;
    checked += 1;
    const conf = await confirmDigitableCouponOnPdp({
      itemId,
      unitPrice: unit,
      code: String(d.coupon),
    });
    if (conf.ok) {
      kept += 1;
      const unitAfter =
        Math.round(
          (unit - conf.coupon.givenDiscount / Math.max(1, conf.coupon.qty)) *
            100,
        ) / 100;
      if (unitAfter > 0 && unitAfter + 0.5 < unit) {
        getDb()
          .prepare(
            `UPDATE deals SET price_with_coupon = ?, coupon_status = 'valid' WHERE id = ?`,
          )
          .run(unitAfter, d.id);
      }
      console.log("KEEP", d.id, d.coupon, conf.detail, d.title.slice(0, 40));
    } else if (conf.inconclusive) {
      deferred += 1;
      console.log("DEFER", d.id, d.coupon, conf.detail, d.title.slice(0, 40));
    } else {
      demoted += 1;
      getDb()
        .prepare(
          `UPDATE deals SET
             coupon_status = 'pending',
             price_with_coupon = NULL,
             status = 'hold_coupon'
           WHERE id = ?`,
        )
        .run(d.id);
      console.log("DEMOTE", d.id, d.coupon, conf.detail, d.title.slice(0, 40));
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  logAntiBan(
    "pdp_coupon_revalidate",
    `checked=${checked} kept=${kept} demoted=${demoted} deferred=${deferred}`,
  );
  console.log(JSON.stringify({ checked, kept, demoted, deferred }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
