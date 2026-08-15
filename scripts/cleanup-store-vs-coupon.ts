/**
 * Limpa meta falsa de cupom (ex.: MELIACHA R$10/mín.80 = oferta de loja)
 * e demove da fila produtos sem desconto mensurável do código digitável.
 */
import { getDb, logAntiBan } from "../src/db/index.js";
import {
  clearUntrustedFixedCouponMeta,
  evaluateCouponSavings,
  isStoreFollowDiscountText,
} from "../src/services/couponSavings.js";
import type { Deal } from "../src/db/index.js";

// MELIACHA e quaisquer fixed sem título “R$X OFF com CODE”
const fixedRows = getDb()
  .prepare(
    `SELECT code, discount_type, discount_value, min_amount, title, subtitle
     FROM ml_coupons
     WHERE lower(COALESCE(discount_type,'')) = 'fixed'
       AND COALESCE(discount_value,0) > 0`,
  )
  .all() as Array<{
  code: string;
  discount_type: string;
  discount_value: number;
  min_amount: number | null;
  title: string | null;
  subtitle: string | null;
}>;

let clearedMeta = 0;
for (const r of fixedRows) {
  const code = String(r.code || "").toUpperCase();
  const hay = `${r.title || ""} ${r.subtitle || ""}`;
  const declares =
    new RegExp(`R\\$\\s*${Number(r.discount_value)}\\s*OFF`, "i").test(hay) &&
    new RegExp(code, "i").test(hay);
  const storeLike =
    isStoreFollowDiscountText(hay) ||
    (Number(r.min_amount) >= 50 && Number(r.discount_value) <= 15 && !declares);
  if (!declares || storeLike || code === "MELIACHA") {
    if (clearUntrustedFixedCouponMeta(code)) clearedMeta += 1;
    console.log("cleared meta", code, r.discount_value, r.min_amount, r.title);
  }
}

const queued = getDb()
  .prepare(
    `SELECT * FROM deals
     WHERE status IN ('queued','hold_coupon')
       AND coupon IS NOT NULL AND trim(coupon) != ''`,
  )
  .all() as Deal[];

let demoted = 0;
let kept = 0;
for (const d of queued) {
  const v = evaluateCouponSavings(d);
  if (v.ok) {
    kept += 1;
    continue;
  }
  getDb()
    .prepare(
      `UPDATE deals SET
         coupon_status = 'pending',
         price_with_coupon = NULL,
         status = 'hold_coupon'
       WHERE id = ? AND status != 'posted'`,
    )
    .run(d.id);
  demoted += 1;
  console.log("demote", d.id, d.coupon, v.reason.slice(0, 80), d.title.slice(0, 40));
}

logAntiBan(
  "coupon_store_vs_code_cleanup",
  `clearedMeta=${clearedMeta} demoted=${demoted} kept=${kept}`,
);
console.log(JSON.stringify({ clearedMeta, demoted, kept }, null, 2));
