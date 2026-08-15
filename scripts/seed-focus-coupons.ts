import { listStoredCoupons } from "../src/services/mlCoupons.ts";
import { seedDealsForCouponViaPdp } from "../src/services/couponHarvest.ts";
import { getDb } from "../src/db/index.ts";

const codes = ["SUPERPROMO", "SHOWDEPROMO", "OFERTASML", "MELIACHA"];
const all = listStoredCoupons(200);

for (const code of codes) {
  const c = all.find((x) => String(x.code).toUpperCase() === code);
  if (!c) {
    console.log(code, "missing");
    continue;
  }
  const r = await seedDealsForCouponViaPdp({
    coupon: c,
    maxScan: 40,
    maxApply: 12,
    mintLinks: 8,
  });
  console.log(code, r);
}

console.log("--- counts ---");
for (const code of codes) {
  const n = (
    getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM deals WHERE upper(coupon)=? AND status='queued' AND coupon_status='valid'`,
      )
      .get(code) as { n: number }
  ).n;
  console.log(code, n);
  const samples = getDb()
    .prepare(
      `SELECT id, substr(title,1,45) t, price_with_coupon FROM deals
       WHERE upper(coupon)=? AND status='queued' AND coupon_status='valid'
       ORDER BY id DESC LIMIT 3`,
    )
    .all(code);
  for (const s of samples) console.log(" ", s);
}
