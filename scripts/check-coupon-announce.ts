/**
 * Anúncio de cupom: só links afiliados (meli.la), sem lista.mercadolivre.
 * Uso: npx tsx scripts/check-coupon-announce.ts
 */
import fs from "node:fs";
import {
  composeCouponValidMessage,
  eligibleDealsForCoupon,
  groupsForCoupon,
} from "../src/services/couponBroadcast.ts";
import { generateCouponBanner } from "../src/services/imageWatermark.ts";
import { getStoredCoupon, listStoredCoupons } from "../src/services/mlCoupons.ts";

function fail(msg: string): never {
  console.error("FAIL", msg);
  process.exit(1);
}

const querocupons =
  listStoredCoupons(80).find((c) => String(c.code).toUpperCase() === "QUEROCUPONS") ||
  getStoredCoupon("14027604");
if (!querocupons) fail("QUEROCUPONS não está no catálogo");

const text = composeCouponValidMessage(querocupons, {
  groupName: "Careca VIP | Achadinhos",
  inviteUrl: "https://chat.whatsapp.com/CFZOfTkq6Hx3cB",
});
if (/lista\.mercadolivre\.com\.br/i.test(text)) {
  fail("não pode postar lista.mercadolivre (sem afiliação):\n" + text);
}
if (/_Container_/i.test(text)) {
  fail("não pode postar Container de lista sem afiliação:\n" + text);
}
if (/c6876896-8b3f-4088-beb9-3ca81d6238fb/i.test(text)) {
  fail("não pode linkar a lista Careca VIP Eletrônicos no QUEROCUPONS");
}
if (/Listas com produtos elegíveis/i.test(text)) {
  fail("não pode despejar listas sociais genéricas");
}
if (!/link de afiliado/i.test(text)) {
  fail("precisa avisar que as ofertas usam link de afiliado:\n" + text);
}
if (!/QUEROCUPONS/.test(text)) fail("falta o código");
const products = eligibleDealsForCoupon("QUEROCUPONS", 4);
for (const p of products) {
  if (/lista\.mercadolivre/i.test(p.url)) {
    fail("produto elegível não pode ser lista oficial: " + p.url);
  }
  if (!/meli\.la\/|click\d*\.mercadolivre|matt_tool=/i.test(p.url)) {
    fail("produto elegível precisa de URL afiliada: " + p.url);
  }
}
if (products.length && !text.includes(products[0].title.slice(0, 20))) {
  fail("texto deveria citar um produto testado com afiliado");
}
const groups = groupsForCoupon(querocupons);
if (groups.length !== 1 || !/achadinhos/i.test(groups[0].name)) {
  fail("QUEROCUPONS deve ir só ao Achadinhos, veio: " + groups.map((g) => g.name).join(", "));
}
if (groups.some((g) => /\btcg\b/i.test(g.categories || ""))) {
  fail("QUEROCUPONS não deve ir ao grupo TCG");
}
if (groups.some((g) => /eletronicos/i.test(g.categories || "") && !/geral/.test(g.categories || ""))) {
  fail("QUEROCUPONS não deve ir ao grupo só de eletrônicos");
}
console.log("ok QUEROCUPONS mensagem e grupos (sem lista oficial)");
console.log("--- texto ---");
console.log(text);
console.log("grupos:", groups.map((g) => g.name).join(" | ") || "(nenhum)");
console.log("produtos afiliados:", products.map((p) => p.title).join(" / ") || "(nenhum)");

const { listQueuedDealsForGroup } = await import("../src/services/affiliates.ts");
const acha = groups[0];
const follow = listQueuedDealsForGroup(acha, 8, { coupon: "QUEROCUPONS" });
if (follow.some((d) => String(d.coupon || "").toUpperCase() !== "QUEROCUPONS")) {
  fail("follow-up do QUEROCUPONS misturou outro cupom");
}
if (follow.some((d) => d.category === "tcg")) {
  fail("follow-up do QUEROCUPONS não pode ser TCG");
}
const { getDb } = await import("../src/db/index.ts");
const tcg = getDb()
  .prepare(`SELECT * FROM wa_groups WHERE categories LIKE '%tcg%' LIMIT 1`)
  .get();
if (tcg) {
  const tcgFollow = listQueuedDealsForGroup(tcg as typeof acha, 8, {
    coupon: "QUEROCUPONS",
  });
  if (tcgFollow.length) {
    fail("QUEROCUPONS não pode gerar ofertas no grupo TCG");
  }
}
console.log("follow-ups Achadinhos:", follow.map((d) => d.title.slice(0, 40)).join(" / ") || "(nenhum)");

const banner = await generateCouponBanner({
  kind: "valid",
  code: "QUEROCUPONS",
  headline: "SÓ EM PRODUTOS ELEGÍVEIS DO CUPOM",
  detail: "25% OFF, em R$ 29,00, Limite de R$ 500,00 OFF",
  groupName: "Careca VIP | Achadinhos",
  inviteUrl: "https://chat.whatsapp.com/KFTf7jBkEZk7GVpD5JlCw6",
  logoPath: "/agent/promo-autonomo/data/brand/logo.png",
  handle: "@carecavip",
  tagline: "OFERTAS COM LINK DE AFILIADO",
});
const bannerPath = "/tmp/coupon-banner-framed.jpg";
fs.writeFileSync(bannerPath, banner);
if (banner.length < 20_000) fail("banner de cupom muito pequeno");
console.log("arte:", bannerPath, banner.length, "bytes");
