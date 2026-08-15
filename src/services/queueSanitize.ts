/**
 * Limpa a fila sincronizada: só fica o que dá para postar
 * (cupom certo, categoria certa, preço crível, comprável).
 */
import { getDb, getSetting, logAntiBan, type Deal } from "../db/index.js";
import { recategorizeNonTcgDeals, classifyProduct } from "./categories.js";
import { couponAllowedForDealCategory } from "./couponCategories.js";
import { resolveDealPrices } from "./dealDisplay.js";
import { categoryPriceCap, isBuyableDeal } from "./dealQuality.js";
import { isVideoGameDeal } from "./gamesFilter.js";
import { scrubFakeCouponCodes } from "./mlCoupons.js";
import { isPlausibleProductPrice } from "./priceSanity.js";
import { isPartyCardGame, isTcgCollectible } from "./tcgFilter.js";
import {
  failsDemandGate,
  isLowDemandNicheTitle,
} from "./demandFilter.js";
import {
  isClearlyNotElectronics,
  isHomeApplianceTitle,
  looksLikeElectronics,
} from "./electronicsFilter.js";

export type SanitizeReport = {
  recategorized: number;
  fakeCoupons: number;
  deleted: number;
  reasons: Record<string, number>;
  kept: number;
};

function bump(reasons: Record<string, number>, key: string): void {
  reasons[key] = (reasons[key] || 0) + 1;
}

/** Motor de portão, mesa de churrasco 2m, nicho sem procura, etc. */
export function isUnwantedPromoTitle(title: string): boolean {
  const t = title.toLowerCase();
  if (
    /port[aã]o deslizante|motor (?:de )?port[aã]o|\bdz nano\b|\bdz stark\b|mesa r[uú]stica|churrasco 2/.test(
      t,
    )
  ) {
    return true;
  }
  return isLowDemandNicheTitle(title);
}

function deleteDeal(id: number): void {
  const db = getDb();
  db.prepare(`DELETE FROM post_logs WHERE deal_id = ?`).run(id);
  try {
    db.prepare(`DELETE FROM coupon_tests WHERE deal_id = ?`).run(id);
  } catch {
    /* tabela antiga */
  }
  try {
    db.prepare(`DELETE FROM deal_coupon_matches WHERE deal_id = ?`).run(id);
  } catch {
    /* opcional */
  }
  db.prepare(`DELETE FROM deals WHERE id = ?`).run(id);
}

export function sanitizeSyncedQueue(): SanitizeReport {
  const recategorized = recategorizeNonTcgDeals();
  const fakeCoupons = scrubFakeCouponCodes().cleared;
  const reasons: Record<string, number> = {};
  let deleted = 0;

  const rows = getDb()
    .prepare(
      `SELECT * FROM deals WHERE status IN ('queued', 'hold_coupon')`,
    )
    .all() as Deal[];

  const requireMeli = getSetting("require_meli_la", "1") === "1";
  const updCat = getDb().prepare(`UPDATE deals SET category = ? WHERE id = ?`);

  for (const deal of rows) {
    const classified = classifyProduct({
      title: deal.title,
      productUrl: deal.product_url,
      categoryHint: deal.category,
    });
    if (classified && classified !== deal.category) {
      updCat.run(classified, deal.id);
      deal.category = classified;
    }
    if (/pote herm|marmita|pote de vidro/i.test(deal.title)) {
      updCat.run("casa", deal.id);
      deal.category = "casa";
    }
    deal.title = deal.title
      .replace(/&#x27;/gi, "'")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"');
    getDb()
      .prepare(`UPDATE deals SET title = ? WHERE id = ?`)
      .run(deal.title, deal.id);

    const hay = `${deal.title} ${deal.product_url || ""}`;
    let reason = "";

    if (!isBuyableDeal(deal)) reason = "nao_compravel";
    else if (isUnwantedPromoTitle(deal.title)) {
      reason = "baixa_procura";
    } else if (
      failsDemandGate({
        title: deal.title,
        category: deal.category,
        soldQuantity: Number(
          (deal as Deal & { sold_quantity?: number | null }).sold_quantity,
        ),
      })
    ) {
      reason = "baixa_procura";
    } else if (isPartyCardGame(hay)) {
      reason = "jogo_de_mesa";
    } else if (deal.category === "tcg" && !isTcgCollectible(deal.title, deal.product_url)) {
      reason = "nao_e_tcg";
    } else if (
      deal.category === "games" &&
      !isVideoGameDeal(deal.title, deal.product_url)
    ) {
      reason = "nao_e_videogame";
    } else if (
      !isPlausibleProductPrice(deal.price, { reference: deal.old_price }) &&
      !isPlausibleProductPrice(deal.old_price)
    ) {
      reason = "preco_invalido";
    }

    const view = resolveDealPrices(deal);
    if (
      !reason &&
      requireMeli &&
      deal.source === "mercadolivre" &&
      !/meli\.la\//i.test(deal.affiliate_url || "") &&
      !view.hasTypedCoupon
    ) {
      // Sem cupom e sem meli.la: sai. Com código digitável espera o próximo createLink.
      reason = "sem_meli_la";
    }
    if (!reason && view.pix > categoryPriceCap(deal.category)) {
      reason = "acima_do_teto";
    }
    if (
      !reason &&
      deal.price_with_coupon &&
      deal.price > 0 &&
      Number(deal.price_with_coupon) < deal.price * 0.6
    ) {
      reason = "desconto_absurdo";
    }
    if (!reason && !view.hasTypedCoupon && !view.clickCoupon) {
      // Sync Hub gera meli.la sem cupom — não apagar: segura p/ enrich/harvest
      const isHub = /^hubauto-/i.test(String(deal.external_id || ""));
      if (isHub || deal.status === "hold_coupon") {
        if (deal.status !== "hold_coupon") {
          getDb()
            .prepare(`UPDATE deals SET status = 'hold_coupon' WHERE id = ?`)
            .run(deal.id);
        }
        bump(reasons, "hold_sem_cupom");
        continue;
      }
      reason = "sem_cupom";
    }
    if (
      !reason &&
      !view.hasTypedCoupon &&
      (deal.category === "esportes" || view.pix > 350) &&
      !["eletronicos", "celulares", "informatica", "games", "tcg"].includes(
        deal.category,
      )
    ) {
      reason = "sem_codigo_preco_alto";
    }
    if (
      !reason &&
      view.hasTypedCoupon &&
      !couponAllowedForDealCategory(
        { code: view.couponCode, title: deal.description || "" },
        deal.category,
      )
    ) {
      reason = "cupom_fora_da_categoria";
    }

    if (
      !reason &&
      ["eletronicos", "celulares", "informatica"].includes(deal.category) &&
      (isClearlyNotElectronics(deal.title, deal.product_url) ||
        !looksLikeElectronics(deal.title, deal.product_url))
    ) {
      const next = classifyProduct({
        title: deal.title,
        productUrl: deal.product_url,
        categoryHint: null,
      });
      if (!["eletronicos", "celulares", "informatica"].includes(next)) {
        updCat.run(next, deal.id);
        deal.category = next;
        bump(reasons, "recat_fora_eletronicos");
      } else if (isClearlyNotElectronics(deal.title, deal.product_url)) {
        reason = "nao_e_eletronico";
      }
    }

    // Eletrodoméstico mal rotulado como eletrônico/celular
    if (
      !reason &&
      ["eletronicos", "celulares", "informatica"].includes(deal.category)
    ) {
      if (isHomeApplianceTitle(deal.title, deal.product_url)) {
        updCat.run("eletrodomesticos", deal.id);
        deal.category = "eletrodomesticos";
        bump(reasons, "recat_eletrodomesticos");
      }
    }

    if (reason) {
      deleteDeal(deal.id);
      bump(reasons, reason);
      deleted += 1;
    }
  }

  const kept = (
    getDb()
      .prepare(
        `SELECT COUNT(*) AS c FROM deals WHERE status IN ('queued', 'hold_coupon')`,
      )
      .get() as { c: number }
  ).c;

  logAntiBan(
    "queue_sanitize",
    `recat=${recategorized} fake=${fakeCoupons} deleted=${deleted} kept=${kept} ${JSON.stringify(reasons)}`,
  );
  return { recategorized, fakeCoupons, deleted, reasons, kept };
}
