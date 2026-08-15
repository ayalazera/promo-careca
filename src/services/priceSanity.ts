/**
 * Sanidade de preços ML — evita R$0,02 falsos e descontos absurdos.
 */

export function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Preço de produto plausível em BRL. */
export function isPlausibleProductPrice(
  n: number | null | undefined,
  opts?: { reference?: number | null },
): boolean {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return false;
  if (v > 1_000_000) return false;
  const ref = Number(opts?.reference);
  // Centavos isolados em item caro = lixo de parse (ex.: 0.02 vs 249.99)
  if (v < 1 && Number.isFinite(ref) && ref >= 5) return false;
  if (v < 0.5) return false;
  if (Number.isFinite(ref) && ref > 20 && v < ref * 0.03) return false;
  return true;
}

/**
 * Escolhe preço atual / cheio a partir de candidatos do Hub/HTML.
 * Descarta valores minúsculos quando há referência maior.
 */
export function pickSanePrices(opts: {
  price?: number | null;
  oldPrice?: number | null;
  candidates?: number[];
}): { price: number; oldPrice: number | null } {
  const cand = [
    ...(opts.candidates || []),
    opts.price,
    opts.oldPrice,
  ]
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && n > 0);

  const uniq = [...new Set(cand.map((n) => roundMoney(n)))].sort((a, b) => a - b);
  const plausible = uniq.filter((n) => isPlausibleProductPrice(n));
  const pool = plausible.length ? plausible : uniq.filter((n) => n >= 1);

  let oldPrice =
    opts.oldPrice != null && isPlausibleProductPrice(opts.oldPrice)
      ? roundMoney(Number(opts.oldPrice))
      : pool.length >= 2
        ? pool[pool.length - 1]
        : null;

  let price =
    opts.price != null &&
    isPlausibleProductPrice(opts.price, { reference: oldPrice })
      ? roundMoney(Number(opts.price))
      : pool.find((n) => isPlausibleProductPrice(n, { reference: oldPrice })) ||
        pool[0] ||
        0;

  if (oldPrice != null && price > oldPrice) {
    // inverte se veio trocado
    const tmp = price;
    price = oldPrice;
    oldPrice = tmp;
  }
  if (oldPrice != null && Math.abs(oldPrice - price) < 0.009) oldPrice = null;
  if (!isPlausibleProductPrice(price, { reference: oldPrice })) {
    price = oldPrice && isPlausibleProductPrice(oldPrice) ? oldPrice : 0;
    if (price === oldPrice) oldPrice = null;
  }
  return { price: roundMoney(price || 0), oldPrice };
}

/** Preço base para aplicar % de cupom (nunca usa 0,02 sujo). */
export function basePriceForCoupon(opts: {
  listedPrice?: number | null;
  listedOldPrice?: number | null;
}): { base: number; original: number; sane: boolean } {
  const listed = Number(opts.listedPrice) || 0;
  const old = Number(opts.listedOldPrice) || 0;
  const original =
    old > 0 && (listed <= 0 || old >= listed) ? old : listed > 0 ? listed : old;
  let base = listed;
  if (!isPlausibleProductPrice(base, { reference: original || old || null })) {
    base = isPlausibleProductPrice(old) ? old : 0;
  }
  const sane = isPlausibleProductPrice(base, { reference: original || null });
  return {
    base: roundMoney(base),
    original: roundMoney(original || base),
    sane,
  };
}

/**
 * Preço “De” que na verdade é o total parcelado (6x, 10x…).
 * Ex.: PIX R$124,92 e “De” R$749 ≈ 6× — não usar como valor antigo.
 */
export function looksLikeInstallmentTotal(
  oldPrice: number | null | undefined,
  cashPrice: number | null | undefined,
): boolean {
  const old = Number(oldPrice);
  const cash = Number(cashPrice);
  if (!isPlausibleProductPrice(old) || !isPlausibleProductPrice(cash)) {
    return false;
  }
  if (old <= cash * 1.5) return false;
  const ratio = old / cash;
  for (const n of [3, 5, 6, 10, 12, 18, 24]) {
    if (Math.abs(ratio - n) / n <= 0.045) return true;
  }
  return false;
}

/**
 * Preço cheio crível para mostrar De/Por.
 * Exige desconto real (≥8%) e descarta parcela disfarçada de “De”.
 */
export function credibleListPrice(
  oldPrice: number | null | undefined,
  cashPrice: number | null | undefined,
): number | null {
  const old = Number(oldPrice);
  const cash = Number(cashPrice);
  if (!isPlausibleProductPrice(old) || !isPlausibleProductPrice(cash)) {
    return null;
  }
  if (old <= cash * 1.08) return null;
  if (looksLikeInstallmentTotal(old, cash)) return null;
  return roundMoney(old);
}

export function discountPercent(
  oldPrice: number | null | undefined,
  cashPrice: number | null | undefined,
): number | null {
  const old = Number(oldPrice);
  const cash = Number(cashPrice);
  if (!isPlausibleProductPrice(old) || !isPlausibleProductPrice(cash)) {
    return null;
  }
  if (old <= cash) return null;
  return Math.round((1 - cash / old) * 100);
}

/** Desconto percentual com teto; o ML arredonda o desconto em centavos e depois subtrai. */
export function applyPercentDiscount(
  base: number,
  percent: number,
  cap?: number | null,
): number {
  if (!isPlausibleProductPrice(base) || percent <= 0 || percent >= 95) {
    return base;
  }
  let d = roundMoney(base * (percent / 100));
  if (cap != null && Number.isFinite(Number(cap)) && Number(cap) > 0) {
    d = Math.min(d, roundMoney(Number(cap)));
  }
  const final = roundMoney(Math.max(0, base - d));
  if (!isPlausibleProductPrice(final, { reference: base })) return base;
  return final;
}
