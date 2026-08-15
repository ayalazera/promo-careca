/**
 * Preços que o post mostra: De (antes) + um único valor final (com cupom).
 * Nunca inventa parcela, nunca inventa desconto PIX e nunca posta
 * “no PIX” / “sem PIX” como duas linhas.
 */
import { getDb } from "../db/index.js";
import {
  credibleListPrice,
  discountPercent,
  isPlausibleProductPrice,
  roundMoney,
} from "./priceSanity.js";
import {
  parseCouponPackFromDescription,
  quoteCouponCart,
} from "./couponPricing.js";

export type DealPriceLike = {
  price: number;
  old_price?: number | null;
  price_with_coupon?: number | null;
  coupon?: string | null;
  coupon_status?: string | null;
  description?: string | null;
  source?: string | null;
};

export type DealPriceView = {
  listed: number;
  /** @deprecated alias de `final` — não há preço PIX separado. */
  semPix: number;
  /** @deprecated alias de `final` — não há preço PIX separado. */
  pix: number;
  /** Preço único postado (com cupom válido, senão o listado). */
  final: number;
  de: number | null;
  /** % vs De (ou listed) usando o preço final. */
  discountPct: number | null;
  /** Sempre null — desconto PIX artificial desligado. */
  pixExtraPct: number | null;
  couponCode: string;
  hasTypedCoupon: boolean;
  clickCoupon: boolean;
  clickCouponPct: number | null;
  /** Unidades no carrinho quando o cupom exige mínimo. */
  packQty: number;
  packBefore: number | null;
  packAfter: number | null;
  packMinAmount: number | null;
};

function isTypedCouponCode(code: string | null | undefined): boolean {
  if (!code) return false;
  const c = code.trim().toUpperCase().replace(/\s+/g, "");
  if (c.length < 3 || c.length > 40) return false;
  if (/^\d+%?OFF$/.test(c)) return false;
  if (/^R\$?\d+OFF$/.test(c)) return false;
  if (/^\d+%$/.test(c)) return false;
  if (c.includes("=")) return false;
  return /^[A-Z][A-Z0-9_]{2,39}$/.test(c);
}

function listedPrice(deal: DealPriceLike): number {
  const listedOk = isPlausibleProductPrice(deal.price, {
    reference: deal.old_price,
  });
  if (listedOk) return roundMoney(deal.price);
  if (isPlausibleProductPrice(deal.old_price)) {
    return roundMoney(Number(deal.old_price));
  }
  return roundMoney(Number(deal.price) || 0);
}

function couponFinal(deal: DealPriceLike, listed: number): number | null {
  const withCoupon = Number(deal.price_with_coupon);
  if (
    !isPlausibleProductPrice(withCoupon, { reference: listed }) ||
    withCoupon <= 0
  ) {
    return null;
  }
  if (withCoupon + 0.009 >= listed) return null;
  // Desconto >40% do preço listado = suspeito (ex.: aspirador 173→87,90).
  // Só aceita se houver cupom digitável marcado como valid.
  const typedOk =
    deal.coupon_status === "valid" && isTypedCouponCode(deal.coupon);
  if (withCoupon < listed * 0.6 && !typedOk) return null;
  // Se o próprio listado já veio com desconto forte vs De (preço estimado da PDP),
  // não empilha outro % de cupom por cima (157→117,75).
  const old = Number(deal.old_price);
  if (
    isPlausibleProductPrice(old) &&
    listed < old * 0.7 &&
    deal.coupon_status !== "valid"
  ) {
    return null;
  }
  return roundMoney(withCoupon);
}

function parseClickCouponPct(
  deal: DealPriceLike,
  listed: number,
  final: number,
): number | null {
  const desc = String(deal.description || "");
  const m =
    desc.match(/(\d{1,2}(?:[.,]\d+)?)\s*%/) ||
    desc.match(/cupom de\s+(\d{1,2})/i);
  if (m) {
    const n = Number(String(m[1]).replace(",", "."));
    if (n >= 3 && n <= 80) return Math.round(n);
  }
  const pct = discountPercent(listed, final);
  return pct != null && pct >= 3 ? pct : null;
}

export function resolveDealPrices(deal: DealPriceLike): DealPriceView {
  const listed = listedPrice(deal);
  const typed =
    deal.coupon &&
    deal.coupon_status !== "invalid" &&
    deal.coupon_status !== "expired" &&
    isTypedCouponCode(deal.coupon)
      ? deal.coupon.trim().toUpperCase()
      : "";
  const fromCoupon = couponFinal(deal, listed);
  const desc = String(deal.description || "");
  // Só é cupom de clique se o anúncio disser desconto no link (não “seguir loja”).
  const clickHint =
    /desconto ml no link/i.test(desc) &&
    !/seguir loja|siga a loja|seguidor|cupom por seguir/i.test(desc);
  const clickCoupon = Boolean(
    !typed &&
      fromCoupon != null &&
      clickHint &&
      // Clique-para-ativar: no máximo ~35% off do listado (acima disso costuma ser parse errado)
      fromCoupon >= listed * 0.65,
  );
  // Um único valor postado = cupom (se válido) ou listado. Sem linha PIX extra.
  const final = fromCoupon != null ? fromCoupon : listed;
  const de = credibleListPrice(deal.old_price, final);
  const discountPct = de
    ? discountPercent(de, final)
    : discountPercent(listed, final);
  const pack = parseCouponPackFromDescription(desc);
  let packQty = pack.qty > 1 ? pack.qty : 1;
  let packBefore = pack.cartBefore;
  let packAfter = pack.cartAfter;
  let packMinAmount = pack.minAmount;

  // Carrinho: nunca unitário_arredondado × qty (45,78×2=91,56 ≠ 91,55 do ML).
  // Recalcula o % no total do carrinho, como o checkout.
  if (typed) {
    const rule = getDb()
      .prepare(
        `SELECT discount_type, discount_value, min_amount, cap_amount
         FROM ml_coupons
         WHERE upper(COALESCE(code,'')) = ?
         ORDER BY CASE WHEN status = 'ACTIVE' THEN 0 ELSE 1 END
         LIMIT 1`,
      )
      .get(typed) as
      | {
          discount_type: string | null;
          discount_value: number | null;
          min_amount: number | null;
          cap_amount: number | null;
        }
      | undefined;
    if (
      rule &&
      rule.discount_type &&
      rule.discount_type !== "unknown" &&
      Number(rule.discount_value) > 0
    ) {
      const quote = quoteCouponCart(listed, {
        discountType: rule.discount_type,
        discountValue: Number(rule.discount_value),
        minAmount: rule.min_amount,
        capAmount: rule.cap_amount,
      });
      if (quote.ok && quote.qty > 1) {
        packQty = quote.qty;
        packBefore = quote.cartBefore;
        packAfter = quote.cartAfter;
        packMinAmount = quote.minAmount;
      } else if (quote.ok) {
        packQty = 1;
        packBefore = null;
        packAfter = null;
        packMinAmount = quote.minAmount;
      }
    } else if (packQty > 1 && fromCoupon != null) {
      // Sem meta no catálogo: só confia no tip parseado; senão omite total.
      if (packBefore == null) packBefore = roundMoney(listed * packQty);
      // NÃO: packAfter = final * packQty
      if (packAfter != null && packAfter >= packBefore) packAfter = null;
    } else {
      packQty = 1;
      packBefore = null;
      packAfter = null;
    }
  } else {
    packQty = 1;
    packBefore = null;
    packAfter = null;
  }
  return {
    listed,
    semPix: final,
    pix: final,
    final,
    de,
    discountPct,
    pixExtraPct: null,
    couponCode: typed,
    hasTypedCoupon: Boolean(typed),
    clickCoupon,
    clickCouponPct: clickCoupon
      ? parseClickCouponPct(deal, listed, final)
      : null,
    packQty,
    packBefore,
    packAfter,
    packMinAmount,
  };
}

export function groupFooterLine(opts: {
  groupName?: string | null;
  promoUrl?: string | null;
  inviteUrl?: string | null;
}): string {
  const name = String(opts.groupName || "").trim();
  const url = String(opts.promoUrl || opts.inviteUrl || "").trim();
  if (!name && !url) return "";
  if (name && url) return `Faça parte da ${name}: ${url}`;
  if (url) return `Faça parte: ${url}`;
  return `Faça parte da ${name}`;
}
