/**
 * Gera meli.la para ofertas da fila que ainda estão no link do produto.
 * Uso: npx tsx scripts/mint-queued-links.ts
 */
import { getDb } from "../src/db/index.ts";
import { createAffiliateLink } from "../src/services/mlHub.ts";

async function main() {
  const rows = getDb()
    .prepare(
      `SELECT id, title, product_url, affiliate_url, coupon FROM deals
       WHERE status = 'queued'
         AND coupon_status = 'valid'
         AND affiliate_url NOT LIKE '%meli.la%'
       ORDER BY CASE
         WHEN category IN ('eletronicos','celulares','informatica','eletrodomesticos','tcg') THEN 0
         WHEN coupon IN ('SEMPREMODA','ECONOMIAML','BRINQUEDOS','OFFMELI') THEN 1
         ELSE 2
       END, id
       LIMIT 3`,
    )
    .all() as Array<{
    id: number;
    title: string;
    product_url: string;
    affiliate_url: string;
    coupon: string | null;
  }>;

  const campaign = getDb()
    .prepare(`SELECT code, campaign_id FROM ml_coupons WHERE code IS NOT NULL`)
    .all() as Array<{ code: string; campaign_id: string }>;
  const campByCode = new Map(
    campaign.map((c) => [c.code.toUpperCase(), c.campaign_id]),
  );

  for (const row of rows) {
    const campaignId = row.coupon
      ? campByCode.get(row.coupon.toUpperCase())
      : null;
    console.log("mint", row.id, row.coupon, row.title.slice(0, 48));
    const link = await createAffiliateLink(row.product_url, { couponCampaignId: campaignId });
    if (link.shortUrl) {
      getDb()
        .prepare(`UPDATE deals SET affiliate_url = ? WHERE id = ?`)
        .run(link.shortUrl, row.id);
      console.log("  ok", link.shortUrl);
    } else {
      console.log("  fail", link.error || "sem shortUrl");
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
