/**
 * Prova do anúncio no momento do post: JSON + trecho do HTML do PDP.
 * Não é screenshot (exigiria Chromium). Guarda preço, vendedor e cupom lidos.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { getDb, type Deal } from "../db/index.js";
import { logAntiBan } from "../db/index.js";

export function pdpProofDir(): string {
  return path.join(path.dirname(config.databasePath), "pdp-proof");
}

export function savePdpProof(opts: {
  deal: Deal;
  html?: string | null;
}): string | null {
  try {
    const dir = pdpProofDir();
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const base = `${opts.deal.id}-${stamp}`;
    const jsonPath = path.join(dir, `${base}.json`);
    const payload = {
      savedAt: new Date().toISOString(),
      dealId: opts.deal.id,
      externalId: opts.deal.external_id,
      title: opts.deal.title,
      price: opts.deal.price,
      oldPrice: opts.deal.old_price,
      priceWithCoupon: opts.deal.price_with_coupon,
      coupon: opts.deal.coupon,
      couponStatus: opts.deal.coupon_status,
      sellerId: opts.deal.seller_id,
      sellerName: opts.deal.seller_name,
      officialStore: opts.deal.official_store,
      stock: opts.deal.stock,
      productUrl: opts.deal.product_url,
      affiliateUrl: opts.deal.affiliate_url,
    };
    fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
    if (opts.html && opts.html.length > 500) {
      const htmlPath = path.join(dir, `${base}.html`);
      fs.writeFileSync(htmlPath, opts.html.slice(0, 250_000));
    }
    getDb()
      .prepare(`UPDATE deals SET pdp_proof_path = ? WHERE id = ?`)
      .run(jsonPath, opts.deal.id);
    return jsonPath;
  } catch (err) {
    logAntiBan(
      "pdp_proof_fail",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}
