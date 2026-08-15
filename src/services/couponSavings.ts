/**
 * Detecta se o cupom realmente gera economia neste preço
 * (inclui compra mínima / R$X OFF / % OFF).
 *
 * Importante: desconto de “seguir a loja” / oferta da loja NÃO é cupom digitável.
 * Só postamos quando o código (MELIACHA, BRINQUEDOS…) gera economia mensurável.
 */
import { getDb } from "../db/index.js";
import {
  quoteCouponCart,
  type CouponPriceRule,
  parseCouponPackFromDescription,
} from "./couponPricing.js";
import { resolveDealPrices } from "./dealDisplay.js";
import type { Deal } from "../db/index.js";
import { isPlausibleProductPrice } from "./priceSanity.js";

export type CouponRuleResolved = CouponPriceRule & {
  code: string;
  source: string;
};

/** Texto de desconto por seguir loja / compra mínima da loja (não é cupom digitável). */
export function isStoreFollowDiscountText(text: string): boolean {
  const t = String(text || "").toLowerCase();
  return (
    /seguidor|seguir a loja|siga a loja|novo seguidor|cupom por seguir|follow(er)?\s*coupon|follow the shop/.test(
      t,
    ) ||
    /comprar?\s+r\$\s*\d+.{0,40}(?:ganh[ae]r?|leve)\s+r\$\s*\d+.{0,30}off/.test(
      t,
    ) ||
    /(?:ganhe|ganha|leve)\s+r\$\s*\d+\s*off.{0,40}seguir/.test(t) ||
    /r\$\s*\d+\s*off.{0,40}(?:por\s+)?seguir/.test(t)
  );
}

/** Extrai "R$10 OFF" / "10% OFF" / "mín. R$80" de textos do ML. */
export function parseCouponDiscountFromText(text: string): {
  discountType: "percent" | "fixed" | null;
  discountValue: number | null;
  minAmount: number | null;
  capAmount: number | null;
} {
  const t = String(text || "");
  // Nunca parsear meta de cupom digitável a partir de texto de “seguir loja”.
  if (isStoreFollowDiscountText(t)) {
    return {
      discountType: null,
      discountValue: null,
      minAmount: null,
      capAmount: null,
    };
  }

  let discountType: "percent" | "fixed" | null = null;
  let discountValue: number | null = null;
  let minAmount: number | null = null;
  let capAmount: number | null = null;

  const pct =
    t.match(/(\d{1,2}(?:[.,]\d+)?)\s*%\s*(?:off|de\s+desconto)?/i) ||
    t.match(/(?:off|desconto)\s+de\s+(\d{1,2}(?:[.,]\d+)?)\s*%/i);
  if (pct) {
    discountType = "percent";
    discountValue = Number(String(pct[1]).replace(",", "."));
  }

  const fixed =
    t.match(/R\$\s*(\d+(?:[.,]\d+)?)\s*OFF/i) ||
    t.match(/(\d+(?:[.,]\d+)?)\s*reais?\s+off/i) ||
    t.match(/desconto\s+de\s+R\$\s*(\d+(?:[.,]\d+)?)/i);
  if (fixed && discountType !== "percent") {
    discountType = "fixed";
    discountValue = Number(String(fixed[1]).replace(",", "."));
  }

  const min =
    t.match(
      /(?:compra\s+m[ií]nima|m[ií]nimo|m[ií]n\.?|a\s+partir\s+de)\s*(?:de\s*)?R\$\s*(\d+(?:[.,]\d+)?)/i,
    ) || t.match(/min(?:imum)?(?:\s*amount)?\s*[:=]?\s*R?\$?\s*(\d+(?:[.,]\d+)?)/i);
  if (min) minAmount = Number(String(min[1]).replace(",", "."));

  const cap =
    t.match(/(?:teto|m[aá]ximo|at[eé])\s*R\$\s*(\d+(?:[.,]\d+)?)/i) ||
    t.match(/cap\s*[:=]?\s*R?\$?\s*(\d+(?:[.,]\d+)?)/i);
  if (cap) capAmount = Number(String(cap[1]).replace(",", "."));

  return { discountType, discountValue, minAmount, capAmount };
}

export function resolveCouponRuleForDeal(deal: Deal): CouponRuleResolved | null {
  const code = String(deal.coupon || "").trim().toUpperCase();
  if (!code) return null;

  const row = getDb()
    .prepare(
      `SELECT code, discount_type, discount_value, min_amount, cap_amount, title, subtitle
       FROM ml_coupons
       WHERE upper(COALESCE(code,'')) = ?
       ORDER BY CASE WHEN status = 'ACTIVE' THEN 0 ELSE 1 END
       LIMIT 1`,
    )
    .get(code) as
    | {
        code: string;
        discount_type: string | null;
        discount_value: number | null;
        min_amount: number | null;
        cap_amount: number | null;
        title: string | null;
        subtitle: string | null;
      }
    | undefined;

  // Só textos do CATÁLOGO do cupom (title/subtitle). Nunca description do produto
  // (mistura “seguir loja” / preço cheio da loja).
  const fromCatalogText = parseCouponDiscountFromText(
    `${row?.title || ""} ${row?.subtitle || ""}`,
  );

  let discountType =
    row?.discount_type && row.discount_type !== "unknown"
      ? row.discount_type
      : fromCatalogText.discountType;
  let discountValue =
    row?.discount_value && Number(row.discount_value) > 0
      ? Number(row.discount_value)
      : fromCatalogText.discountValue;
  let minAmount =
    row?.min_amount != null && Number(row.min_amount) > 0
      ? Number(row.min_amount)
      : fromCatalogText.minAmount;
  let capAmount =
    row?.cap_amount != null && Number(row.cap_amount) > 0
      ? Number(row.cap_amount)
      : fromCatalogText.capAmount;

  // Pack “leve N un.” na description só se o texto citar o próprio código.
  const desc = String(deal.description || "");
  if (new RegExp(`\\b${code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(desc)) {
    const pack = parseCouponPackFromDescription(desc);
    if (pack.minAmount != null && !(minAmount != null && minAmount > 0)) {
      minAmount = pack.minAmount;
    }
  }

  if (!discountType || !(Number(discountValue) > 0)) {
    // Match na lista sem meta de desconto → tenta só o título/detalhe do match do cupom
    const match = getDb()
      .prepare(
        `SELECT title, detail FROM deal_coupon_matches
         WHERE deal_id = ? AND upper(COALESCE(code,'')) = ?
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(deal.id, code) as { title?: string; detail?: string } | undefined;
    const parsed = parseCouponDiscountFromText(
      `${match?.title || ""} ${match?.detail || ""}`,
    );
    if (parsed.discountType && parsed.discountValue) {
      discountType = parsed.discountType;
      discountValue = parsed.discountValue;
      if (parsed.minAmount != null) minAmount = parsed.minAmount;
      if (parsed.capAmount != null) capAmount = parsed.capAmount;
    }
  }

  if (!discountType || !(Number(discountValue) > 0)) {
    return {
      code,
      source: "unknown",
      discountType: null,
      discountValue: null,
      minAmount,
      capAmount,
    };
  }

  return {
    code,
    source: row ? "catalog+text" : "text",
    discountType,
    discountValue,
    minAmount,
    capAmount,
  };
}

export type CouponSavingsVerdict = {
  ok: boolean;
  reason: string;
  qty: number;
  unitAfter: number | null;
  discount: number;
  minAmount: number | null;
};

/**
 * Cupom só é postável se gera economia real neste preço
 * (1 un. ou carrinho N un. dentro do limite).
 * “Só está na lista do cupom” sem %/R$ OFF conhecidos → não posta.
 * price_with_coupon igual ao listado (oferta da loja) NÃO conta.
 */
export function evaluateCouponSavings(deal: Deal): CouponSavingsVerdict {
  const view = resolveDealPrices(deal);
  const listed = view.listed;
  if (!isPlausibleProductPrice(listed)) {
    return {
      ok: false,
      reason: "preço listado inválido para avaliar cupom",
      qty: 1,
      unitAfter: null,
      discount: 0,
      minAmount: null,
    };
  }

  const withC = Number(deal.price_with_coupon);
  const storedDrop =
    isPlausibleProductPrice(withC, { reference: listed }) &&
    withC + 0.5 < listed;

  const rule = resolveCouponRuleForDeal(deal);
  if (!rule || !rule.discountType || !(Number(rule.discountValue) > 0)) {
    // Sem regra de cupom: só aceita queda já gravada (ex.: PDP com givenDiscount do código).
    if (storedDrop) {
      return {
        ok: true,
        reason: "economia já gravada em price_with_coupon",
        qty: 1,
        unitAfter: withC,
        discount: listed - withC,
        minAmount: null,
      };
    }
    return {
      ok: false,
      reason:
        "cupom sem desconto mensurável (na lista ou oferta da loja ≠ desconto do código)",
      qty: 1,
      unitAfter: null,
      discount: 0,
      minAmount: rule?.minAmount ?? null,
    };
  }

  const quote = quoteCouponCart(listed, rule, { maxQty: 6 });
  if (!quote.ok || quote.discount < 0.5) {
    const min = rule.minAmount;
    if (min != null && listed + 0.009 < min) {
      return {
        ok: false,
        reason: `cupom exige mín. R$${Number(min).toFixed(2)} e 1 un. custa R$${listed.toFixed(2)} — sem economia neste post`,
        qty: quote.qty || 1,
        unitAfter: null,
        discount: 0,
        minAmount: min,
      };
    }
    return {
      ok: false,
      reason: quote.reason || "cupom não gera desconto neste preço",
      qty: quote.qty || 1,
      unitAfter: null,
      discount: 0,
      minAmount: rule.minAmount ?? null,
    };
  }

  // Economia irrelevante (< R$1 ou <1%)
  if (quote.discount < 1 && quote.discount / Math.max(quote.cartBefore, 1) < 0.01) {
    return {
      ok: false,
      reason: "desconto do cupom irrelevante neste preço",
      qty: quote.qty,
      unitAfter: quote.unitAfter,
      discount: quote.discount,
      minAmount: rule.minAmount ?? null,
    };
  }

  return {
    ok: true,
    reason:
      quote.qty > 1
        ? `economia com ${quote.qty} un. (mín. R$${Number(rule.minAmount || 0).toFixed(2)})`
        : "economia com 1 un.",
    qty: quote.qty,
    unitAfter: quote.unitAfter,
    discount: quote.discount,
    minAmount: rule.minAmount ?? null,
  };
}

/**
 * Persiste meta descoberta no catálogo.
 * Só aceita texto que cite o código e NÃO seja desconto de “seguir loja”.
 */
export function enrichCouponMetaFromText(code: string, text: string): boolean {
  const clean = String(code || "").trim().toUpperCase();
  if (!clean) return false;
  const raw = String(text || "");
  if (isStoreFollowDiscountText(raw)) return false;
  // Exige menção ao código (evita R$10 OFF da loja virar meta do MELIACHA).
  const codeRe = new RegExp(
    `\\b${clean.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
    "i",
  );
  if (!codeRe.test(raw)) return false;
  const parsed = parseCouponDiscountFromText(raw);
  if (!parsed.discountType || !(Number(parsed.discountValue) > 0)) return false;
  const info = getDb()
    .prepare(
      `UPDATE ml_coupons SET
         discount_type = CASE
           WHEN discount_type IS NULL OR discount_type = '' OR discount_type = 'unknown'
                OR COALESCE(discount_value,0) <= 0
             THEN ?
           ELSE discount_type END,
         discount_value = CASE
           WHEN COALESCE(discount_value,0) <= 0 THEN ?
           ELSE discount_value END,
         min_amount = CASE
           WHEN min_amount IS NULL OR min_amount <= 0 THEN ?
           ELSE min_amount END,
         cap_amount = CASE
           WHEN cap_amount IS NULL OR cap_amount <= 0 THEN ?
           ELSE cap_amount END,
         code = CASE WHEN code IS NULL OR trim(code) = '' THEN ? ELSE code END
       WHERE upper(COALESCE(code,'')) = ? OR campaign_id IN (
         SELECT campaign_id FROM ml_coupons WHERE upper(COALESCE(code,'')) = ?
       )`,
    )
    .run(
      parsed.discountType,
      parsed.discountValue,
      parsed.minAmount,
      parsed.capAmount,
      clean,
      clean,
      clean,
    );
  return info.changes > 0;
}

/** Zera meta de desconto claramente suspeita / inventada (ex.: MELIACHA R$10/mín.80). */
export function clearUntrustedFixedCouponMeta(code: string): boolean {
  const clean = String(code || "").trim().toUpperCase();
  if (!clean) return false;
  const info = getDb()
    .prepare(
      `UPDATE ml_coupons SET
         discount_type = 'unknown',
         discount_value = 0,
         min_amount = NULL,
         cap_amount = NULL,
         title = CASE
           WHEN title IS NULL OR trim(title) = '' THEN ?
           WHEN title LIKE '%R$%OFF%' OR title LIKE '%mín%' THEN ?
           ELSE title END,
         subtitle = COALESCE(subtitle, 'meta reset — aguardar %/R$ confiável do cupom')
       WHERE upper(COALESCE(code,'')) = ?`,
    )
    .run(`Cupom ${clean}`, `Cupom ${clean}`, clean);
  return info.changes > 0;
}
