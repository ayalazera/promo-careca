/**
 * Cotação de cupom com valor mínimo de compra.
 * Se 1 unidade não atinge o mínimo, sobe a quantidade (ex.: R$39,90 + mín. R$59 → 2 un.).
 * Vale para TODOS os cupons (digitáveis e de loja), em todas as categorias.
 */
import { applyPercentDiscount, roundMoney } from "./priceSanity.js";

export type CouponPriceRule = {
  discountType?: string | null;
  discountValue?: number | null;
  minAmount?: number | null;
  capAmount?: number | null;
  /** aliases do SQLite / API */
  discount_type?: string | null;
  discount_value?: number | null;
  min_amount?: number | null;
  cap_amount?: number | null;
};

function normalizeRule(rule: CouponPriceRule): {
  discountType: string;
  discountValue: number;
  minAmount: number | null;
  capAmount: number | null;
} {
  return {
    discountType: String(rule.discountType ?? rule.discount_type ?? ""),
    discountValue: Number(rule.discountValue ?? rule.discount_value) || 0,
    minAmount:
      rule.minAmount != null || rule.min_amount != null
        ? Number(rule.minAmount ?? rule.min_amount)
        : null,
    capAmount:
      rule.capAmount != null || rule.cap_amount != null
        ? Number(rule.capAmount ?? rule.cap_amount)
        : null,
  };
}

export type CouponCartQuote = {
  ok: boolean;
  qty: number;
  unitPrice: number;
  cartBefore: number;
  discount: number;
  cartAfter: number;
  /** Preço por unidade após ratear o desconto do carrinho. */
  unitAfter: number;
  minAmount: number | null;
  reason?: string;
};

function brlPlain(n: number): string {
  return n.toFixed(2).replace(".", ",");
}

/** Unidades necessárias para atingir o mínimo do cupom (1 = ok sozinho; 0 = inviável). */
export function minUnitsForCouponMin(
  unitPrice: number,
  minAmount: number | null | undefined,
  maxQty = 6,
): number {
  if (minAmount == null || !(Number(minAmount) > 0)) return 1;
  if (!(unitPrice > 0)) return 1;
  if (unitPrice + 0.009 >= Number(minAmount)) return 1;
  const qty = Math.ceil(Number(minAmount) / unitPrice);
  if (qty < 1) return 1;
  if (qty > Math.max(1, Math.min(12, maxQty))) return 0;
  return qty;
}

/** Desconto + totais do carrinho para a qty mínima que ativa o cupom. */
export function quoteCouponCart(
  unitPrice: number,
  rule: CouponPriceRule,
  opts?: { maxQty?: number },
): CouponCartQuote {
  const norm = normalizeRule(rule);
  const minAmount =
    norm.minAmount != null && Number(norm.minAmount) > 0
      ? Number(norm.minAmount)
      : null;
  const qty = minUnitsForCouponMin(unitPrice, minAmount, opts?.maxQty ?? 6);
  if (qty < 1) {
    return {
      ok: false,
      qty: 0,
      unitPrice: roundMoney(unitPrice),
      cartBefore: 0,
      discount: 0,
      cartAfter: 0,
      unitAfter: roundMoney(unitPrice),
      minAmount,
      reason: "mínimo do cupom exige unidades demais",
    };
  }
  const unit = roundMoney(unitPrice);
  const cartBefore = roundMoney(unit * qty);
  const dtype = String(norm.discountType || "").toLowerCase();
  const dval = Number(norm.discountValue) || 0;
  let cartAfter = cartBefore;
  if (dtype === "percent" && dval > 0) {
    cartAfter = applyPercentDiscount(cartBefore, dval, norm.capAmount);
  } else if (dtype === "fixed" && dval > 0) {
    cartAfter = roundMoney(Math.max(0, cartBefore - Math.min(dval, cartBefore * 0.9)));
  } else {
    return {
      ok: false,
      qty,
      unitPrice: unit,
      cartBefore,
      discount: 0,
      cartAfter: cartBefore,
      unitAfter: unit,
      minAmount,
      reason: "cupom sem desconto mensurável",
    };
  }
  const discount = roundMoney(cartBefore - cartAfter);
  const unitAfter = roundMoney(cartAfter / qty);
  return {
    ok: discount > 0.009 && cartAfter + 0.009 < cartBefore,
    qty,
    unitPrice: unit,
    cartBefore,
    discount,
    cartAfter,
    unitAfter,
    minAmount,
  };
}

/** Trecho padronizado na description do deal (composer/enrich leem isso). */
export function formatCouponQtyDescBit(quote: CouponCartQuote): string {
  if (!quote.ok || quote.qty <= 1) return "";
  const minBit =
    quote.minAmount != null
      ? `mín. R$ ${brlPlain(quote.minAmount)}`
      : "valor mínimo";
  return (
    ` · leve ${quote.qty} un. para ativar (${minBit})` +
    ` · carrinho R$${brlPlain(quote.cartBefore)} → R$${brlPlain(quote.cartAfter)}`
  );
}

/** Remove tips de qty/carrinho duplicados na description. */
export function scrubCouponDescTips(description: string): string {
  return String(description || "")
    .replace(/Cupom ML:[^\n]*/gi, (m) => m) // keep for now; cleaned below
    .replace(/(?:\n?Cupom ML:[^\n]*)+/gi, (block) => {
      const lines = block
        .split(/\n/)
        .map((l) => l.trim())
        .filter((l) => /^Cupom ML:/i.test(l));
      return lines.length ? `\n${lines[lines.length - 1]}` : "";
    })
    .replace(/(\s*·\s*leve\s+\d+\s+un\.[^·\n]*)+/gi, (m) => {
      const last = m.match(
        /\s*·\s*leve\s+\d+\s+un\.[^·\n]*(?:\s*·\s*carrinho[^·\n]*)?/i,
      );
      return last?.[0] || "";
    })
    .replace(/(\s*·\s*carrinho\s+R\$[^·\n]*){2,}/gi, (m) => {
      const parts = m.match(/\s*·\s*carrinho\s+R\$[^·\n]*/gi) || [];
      return parts[parts.length - 1] || "";
    })
    // Lixo tipo “carrinho RCupom ML: …1400668015,90”
    .replace(/·\s*carrinho\s+R(?!\$)[^\n]*/gi, "")
    .replace(/campanha\s+(\d+)(?=\d{2},\d{2})/gi, "campanha $1 · carrinho R$")
    .replace(/campanha\s+(\d+)·/gi, "campanha $1 ·")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function parseCouponPackFromDescription(desc: string | null | undefined): {
  qty: number;
  cartBefore: number | null;
  cartAfter: number | null;
  minAmount: number | null;
} {
  const text = String(desc || "");
  const qtyM = text.match(/leve\s+(\d+)\s+un/i);
  const qty = qtyM ? Math.max(1, Number(qtyM[1]) || 1) : 1;
  const cartM = text.match(
    /carrinho\s+R\$\s*([\d.]+,\d{2})\s*[→\-–]\s*R\$\s*([\d.]+,\d{2})/i,
  );
  const minM = text.match(/m[ií]n\.?\s*R\$\s*([\d.]+,\d{2})/i);
  const parseBr = (s: string) => {
    const n = Number(String(s).replace(/\./g, "").replace(",", "."));
    return Number.isFinite(n) ? roundMoney(n) : null;
  };
  return {
    qty,
    cartBefore: cartM ? parseBr(cartM[1]) : null,
    cartAfter: cartM ? parseBr(cartM[2]) : null,
    minAmount: minM ? parseBr(minM[1]) : null,
  };
}
