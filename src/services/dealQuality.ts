/**
 * Qualidade da oferta: só postar o que a pessoa consegue comprar.
 * Score alto = cupom válido + preço crível + link afiliado + desconto.
 */
import type { Deal, WaGroup } from "../db/index.js";
import { isPlausibleProductPrice } from "./priceSanity.js";
import { resolveDealPrices } from "./dealDisplay.js";
import {
  couponCodesMatch,
  getGroupFocusCoupon,
  recentAnnouncedCouponCodes,
} from "./couponCategories.js";
import {
  isExpensiveReprint,
  isGenericTcgSeller,
  isTcgCollectible,
  tcgPriorityScore,
} from "./tcgFilter.js";
import { gamesPriorityScore, isVideoGameDeal } from "./gamesFilter.js";
import { getPriceHistoryVerdict } from "./priceHistory.js";
import { demandScore, isLowDemandNicheTitle } from "./demandFilter.js";
import { evaluateCouponSavings } from "./couponSavings.js";
import { wasProductPostedRecently } from "./productDedupe.js";

/** Teto por nicho: valor alto demais não converte no WhatsApp. */
export function categoryPriceCap(category: string): number {
  const cat = String(category || "geral")
    .split(",")[0]
    .trim()
    .toLowerCase();
  switch (cat) {
    case "geral":
      return 499;
    case "moda":
    case "beleza":
      return 299;
    case "casa":
    case "tcg":
      return 499;
    case "esportes":
      return 799;
    case "games":
    case "eletronicos":
    case "celulares":
    case "informatica":
      return 2499;
    default:
      return 1499;
  }
}

export function isBuyableDeal(deal: Deal): boolean {
  const url = String(deal.affiliate_url || deal.product_url || "");
  if (!/^https?:\/\//i.test(url)) return false;
  if (/meli\.la\/$/.test(url) || url.length < 16) return false;
  const title = String(deal.title || "").trim();
  if (!title || /^produto mlb/i.test(title) || title.length < 8) return false;
  const listedOk = isPlausibleProductPrice(deal.price, {
    reference: deal.old_price,
  });
  const oldOk = isPlausibleProductPrice(deal.old_price);
  if (!listedOk && !oldOk) return false;
  return true;
}

export type PostSkip = {
  skip: boolean;
  reason: string;
  /** true = tira da fila (oferta ruim para qualquer grupo) */
  markSkipped: boolean;
};

/**
 * Gate do grupo: só posta com cupom testado (código ou clique-para-ativar).
 * Sem cupom não entra. Se não for o menor 30 dias, o post ainda vai —
 * só não fala que já esteve mais barato (isso é regra do composer).
 */
export function explainSkipDeal(
  deal: Deal,
  group?: WaGroup | null,
): PostSkip {
  const view = resolveDealPrices(deal);
  const groupCat = String(group?.categories || deal.category || "geral");
  const cap = categoryPriceCap(groupCat);
  if (view.pix > cap) {
    return {
      skip: true,
      reason: `preço ${view.pix} acima do teto ${cap} (${groupCat.split(",")[0]})`,
      markSkipped: false,
    };
  }

  const hasCoupon = view.hasTypedCoupon || view.clickCoupon;
  if (!hasCoupon) {
    return {
      skip: true,
      reason: "sem cupom testado — grupo só posta com cupom",
      markSkipped: false,
    };
  }
  if (isLowDemandNicheTitle(deal.title)) {
    return {
      skip: true,
      reason: "baixa procura / nicho fraco",
      markSkipped: true,
    };
  }

  // Cupom digitável sem economia real (mín. alto / só na lista / 0% OFF)
  if (view.hasTypedCoupon) {
    const savings = evaluateCouponSavings(deal);
    if (!savings.ok) {
      return {
        skip: true,
        reason: savings.reason,
        markSkipped: false,
      };
    }
  }

  if (group?.id) {
    const rep = wasProductPostedRecently(group.id, {
      dealId: deal.id,
      externalId: deal.external_id,
      title: deal.title,
    });
    if (rep.blocked) {
      return { skip: true, reason: rep.reason, markSkipped: false };
    }
  }

  return { skip: false, reason: "", markSkipped: false };
}

export function dealPostScore(deal: Deal, group?: WaGroup | null): number {
  let n = 0;
  const view = resolveDealPrices(deal);
  const title = String(deal.title || "");
  const t = title.toLowerCase();

  if (deal.coupon_status === "valid" && view.hasTypedCoupon) n += 40;
  else if (view.hasTypedCoupon && deal.coupon_status !== "invalid") n += 8;
  else if (view.clickCoupon) n += 22;
  if (view.pix > 0 && view.pix < view.listed) {
    n += 15;
  }
  if (view.de && view.de > view.pix * 1.08) n += 10;
  const discPct =
    view.de && view.de > view.pix
      ? Math.round((1 - view.pix / view.de) * 100)
      : 0;
  if (discPct >= 35) n += 22;
  else if (discPct >= 25) n += 12;
  if (discPct >= 40) n += 10;

  const comm = Number(deal.commission_pct);
  if (comm >= 20) n += 18;
  else if (comm >= 15) n += 12;
  else if (comm >= 12) n += 8;

  if (/meli\.la\//i.test(deal.affiliate_url || "")) n += 40;
  else n -= 25;
  if (deal.image_url) n += 4;
  const logistic = String(
    (deal as Deal & { shipping_logistic?: string | null }).shipping_logistic ||
      "",
  ).toLowerCase();
  if (logistic === "full" || logistic === "flex") n += 8;
  if (Number((deal as Deal & { official_store?: number }).official_store) === 1) {
    n += 10;
  }

  // Kits (10 meias, 3 camisetas, pack)
  if (
    /\b\d+\s*(unid|pcs|peças|pares|meias|camisetas|cuecas|kits?)\b/i.test(t) ||
    /\bkit\b|\bpack\b|\bcombo\b/.test(t)
  ) {
    n += 14;
  }

  // Marcas conhecidas
  if (
    /\bnike\b|\badidas\b|\blupo\b|\bmizuno\b|\btramontina\b|\bcopag\b|\bpokemon\b|\bsamsung\b|\bapple\b|\bxiaomi\b|\blogitech\b|\bsony\b|\bjbl\b|\banker\b|\bphilips\b|\btramontina\b|\bolympicus\b|\bpuma\b|\boakley\b|\bray[- ]?ban\b/.test(
      t,
    )
  ) {
    n += 16;
  } else if (
    /gen[eé]ric[oa]|sem marca|no brand|unbranded|resposta whatsapp|carregador universal barato/.test(
      t,
    )
  ) {
    n -= 18;
  }

  const stock = Number(deal.stock);
  if (Number.isFinite(stock) && stock > 0 && stock <= 8) n += 20; // urgência
  else if (Number.isFinite(stock) && stock > 0 && stock <= 20) n += 8;

  const sold = Number(
    (deal as Deal & { sold_quantity?: number | null }).sold_quantity,
  );
  if (sold >= 100) n += 20;
  else if (sold >= 50) n += 10;

  const verdict = getPriceHistoryVerdict(deal);
  if (verdict.isLowest === true) n += 24;
  if (verdict.isWorseThanHistory) n -= 40;

  // Premium vs filler: comissão+desconto+30d = premium
  const premium =
    (comm >= 15 ? 1 : 0) +
    (discPct >= 30 ? 1 : 0) +
    (verdict.isLowest ? 1 : 0) +
    (sold >= 100 ? 1 : 0);
  if (premium >= 3) n += 25; // fila premium
  else if (premium <= 0 && discPct < 15) n -= 8; // filler

  if (group) {
    const focus = getGroupFocusCoupon(group.id);
    if (focus && view.hasTypedCoupon && couponCodesMatch(focus, view.couponCode)) {
      n += 160;
    } else {
      const featured = recentAnnouncedCouponCodes(group.id);
      if (
        featured.length &&
        view.hasTypedCoupon &&
        featured.some((c) => couponCodesMatch(c, view.couponCode))
      ) {
        n += 40;
      }
    }
  }
  const groupCats = String(group?.categories || deal.category || "geral");
  const cap = categoryPriceCap(groupCats);
  if (view.pix > cap) n -= 35;

  // Eletrônicos: fones/smartwatch/cabo/SSD primeiro
  if (/eletronicos|celulares|informatica/.test(groupCats)) {
    if (
      /fone|buds|earbud|headset|smartwatch|rel[oó]gio inteligente|ssd|nvme|pendrive|cabo (usb|type[- ]?c)|carregador gan|power bank/.test(
        t,
      )
    ) {
      n += 18;
    }
  }

  // Achadinhos: diversificar (moda não sempre no topo)
  if (/(^|,)\s*geral\s*(,|$)/.test(groupCats) || /achadinhos/.test(groupCats)) {
    if (/legging|cropped|conjunto fitness|blusa feminina/.test(t)) n -= 6;
    if (/tramontina|panela|air fryer|liquidificador|ferramenta/.test(t)) n += 8;
  }

  if (isTcgCollectible(deal.title) && deal.category === "tcg") {
    n += tcgPriorityScore(deal.title, deal.product_url);
    if (/lacrado|selo|factory sealed/.test(t)) n += 12;
    if (
      isExpensiveReprint(deal.title, deal.price, deal.old_price) ||
      isGenericTcgSeller(
        (deal as Deal & { seller_name?: string | null }).seller_name,
      )
    ) {
      n -= 40;
    }
    // singles caros
    if (/single|carta avulsa|nm\/m|near mint/.test(t) && view.pix > 80) n -= 25;
  }
  if (isVideoGameDeal(deal.title) && deal.category === "games") {
    n += gamesPriorityScore(deal.title, deal.product_url);
  }
  n += demandScore({
    title: deal.title,
    soldQuantity: sold,
  });
  if (isLowDemandNicheTitle(deal.title)) n -= 100;
  if (!isBuyableDeal(deal)) n -= 80;
  return n;
}

/** Família de produto para anti-viés (moda/casa/tech). */
export function dealFamilyBucket(title: string): "moda" | "casa" | "tech" | "tcg" | "other" {
  const t = String(title || "").toLowerCase();
  if (/pok[eé]mon|yu-?gi|magic the|booster|etb|tcg/.test(t)) return "tcg";
  if (
    /fone|ssd|smartwatch|notebook|celular|cabo usb|carregador|monitor|mouse|teclado|gadget/.test(
      t,
    )
  ) {
    return "tech";
  }
  if (
    /panela|tramontina|cama|toalha|copo|garrafa|ferramenta|air fryer|liquidificador/.test(
      t,
    )
  ) {
    return "casa";
  }
  if (
    /legging|camiseta|cropped|tênis|tenis|meia|calça|blusa|vestido|cueca|sutiã/.test(
      t,
    )
  ) {
    return "moda";
  }
  return "other";
}
