import { getDb, getSetting, logAntiBan } from "../db/index.js";
import { getMercadoLivreCreds } from "./credentialVault.js";
import {
  canCallProvider,
  cacheGet,
  cacheSet,
  jitterDelayMs,
  recordProviderResult,
} from "./pulseGuard.js";
import {
  applyPercentDiscount,
  basePriceForCoupon,
  isPlausibleProductPrice,
  pickSanePrices,
  roundMoney,
} from "./priceSanity.js";
import { quoteCouponCart } from "./couponPricing.js";
import { isConfirmedDeadCouponText, isTransientCouponFail } from "./couponLiveCheck.js";

export type CouponTestResult = {
  ok: boolean;
  coupon: string | null;
  originalPrice: number;
  finalPrice: number;
  detail: string;
  status: "none" | "valid" | "invalid" | "expired" | "pending";
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function round2(n: number): number {
  return roundMoney(n);
}

/**
 * Testa cupom no produto ML antes de postar.
 * 1) Busca preço atual do item
 * 2) Tenta descobrir desconto do cupom (listagens / atributos / regras conhecidas)
 * 3) Só marca valid se o preço final for menor que o preço cheio
 */
export async function testMercadoLivreCoupon(opts: {
  itemId: string;
  coupon?: string | null;
  listedPrice?: number;
  listedOldPrice?: number | null;
  dealId?: number;
}): Promise<CouponTestResult> {
  const demo = getSetting("demo_mode", "1") === "1";
  const coupon = (opts.coupon || "").trim().toUpperCase() || null;

  if (demo) {
    const original =
      opts.listedOldPrice && opts.listedOldPrice > 0
        ? opts.listedOldPrice
        : opts.listedPrice || 169.99;
    const final =
      coupon
        ? round2(original * 0.6)
        : opts.listedPrice || round2(original * 0.75);
    const result: CouponTestResult = {
      ok: true,
      coupon,
      originalPrice: original,
      finalPrice: final,
      detail: coupon
        ? `demo: cupom ${coupon} aplicado`
        : "demo: preço promocional sem cupom",
      status: coupon ? "valid" : "none",
    };
    return result;
  }

  const creds = getMercadoLivreCreds();
  if (!creds.accessToken) {
    // Sem OAuth: ainda aceita match já validado via /cupons/api + lista
    const fromMatch = estimateFromCouponMatch(opts.dealId, opts.itemId, coupon, {
      listedPrice: opts.listedPrice,
      listedOldPrice: opts.listedOldPrice,
    });
    if (fromMatch) return fromMatch;
    return {
      ok: false,
      coupon,
      originalPrice: opts.listedOldPrice || opts.listedPrice || 0,
      finalPrice: opts.listedPrice || 0,
      detail: "sem token ML",
      status: "pending",
    };
  }

  const cacheKey = `ml:coupon:${opts.itemId}:${coupon || "-"}`;
  const cached = cacheGet(cacheKey) as CouponTestResult | null;
  if (cached) return cached;

  const gate = canCallProvider("mercadolivre");
  if (!gate.ok) {
    return {
      ok: false,
      coupon,
      originalPrice: opts.listedOldPrice || opts.listedPrice || 0,
      finalPrice: opts.listedPrice || 0,
      detail: gate.reason || "pulse block",
      status: "pending",
    };
  }

  await sleep(jitterDelayMs("mercadolivre"));
  try {
    const { mlHumanPause } = await import("./mlHumanPace.js");
    await mlHumanPause("api");
  } catch {
    /* pace opcional */
  }
  const started = Date.now();

  try {
    const res = await fetch(`https://api.mercadolibre.com/items/${opts.itemId}`, {
      headers: { Authorization: `Bearer ${creds.accessToken}` },
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      recordProviderResult("mercadolivre", {
        ok: false,
        status: res.status,
        latencyMs,
        detail: `item ${opts.itemId}`,
      });
      return {
        ok: false,
        coupon,
        originalPrice: opts.listedOldPrice || opts.listedPrice || 0,
        finalPrice: opts.listedPrice || 0,
        detail: `item HTTP ${res.status}`,
        status: res.status === 404 ? "expired" : "pending",
      };
    }

    const item = (await res.json()) as {
      price?: number;
      original_price?: number | null;
      status?: string;
      available_quantity?: number;
      permalink?: string;
    };

    recordProviderResult("mercadolivre", {
      ok: true,
      status: 200,
      latencyMs,
      detail: `coupon-test ${opts.itemId}`,
    });

    if (item.status && item.status !== "active") {
      return {
        ok: false,
        coupon,
        originalPrice: item.original_price || item.price || 0,
        finalPrice: item.price || 0,
        detail: `item status=${item.status}`,
        status: "expired",
      };
    }

    if ((item.available_quantity ?? 1) <= 0) {
      return {
        ok: false,
        coupon,
        originalPrice: item.original_price || item.price || 0,
        finalPrice: item.price || 0,
        detail: "sem estoque",
        status: "expired",
      };
    }

    const current = item.price || opts.listedPrice || 0;
    const original =
      item.original_price && item.original_price > current
        ? item.original_price
        : opts.listedOldPrice && opts.listedOldPrice > current
          ? opts.listedOldPrice
          : current;

    // Tenta enriquecer com preço de "deal" / desconto visível
    let finalPrice = current;
    let detail = "preço atual da API";

    if (coupon) {
      const couponMeta = await probeCouponDiscount(opts.itemId, coupon, current);
      if (couponMeta.applied && couponMeta.finalPrice < current) {
        finalPrice = couponMeta.finalPrice;
        detail = couponMeta.detail;
      } else if (original > current) {
        // Cupom informado mas API não detalha: usa preço promocional listado
        // só se ainda houver desconto real vs original
        finalPrice = current;
        detail = couponMeta.detail || "cupom informado; usando preço promocional listado";
      } else {
        // Fallback: match na página /cupons (campaign + lista) já validado
        let match:
          | {
              validated: number;
              detail: string;
              title: string;
              discount_type: string | null;
              discount_value: number | null;
              cap_amount: number | null;
              min_amount: number | null;
            }
          | undefined;
        try {
          const dealId =
            opts.dealId ||
            (
              getDb()
                .prepare(
                  `SELECT id FROM deals WHERE external_id = ? OR external_id = ? LIMIT 1`,
                )
                .get(opts.itemId, `hubauto-${opts.itemId}`) as
                | { id: number }
                | undefined
            )?.id;
          if (dealId) {
            match = getDb()
              .prepare(
                `SELECT m.validated, m.detail, m.title, c.discount_type, c.discount_value, c.cap_amount, c.min_amount
                 FROM deal_coupon_matches m
                 LEFT JOIN ml_coupons c ON c.campaign_id = m.campaign_id
                 WHERE m.deal_id = ?
                 ORDER BY m.updated_at DESC LIMIT 1`,
              )
              .get(dealId) as typeof match;
          }
        } catch {
          match = undefined;
        }

        if (match?.validated) {
          // Se o catálogo não tem %/R$, tenta ler do título do cupom
          if (
            (!match.discount_type ||
              match.discount_type === "unknown" ||
              !(Number(match.discount_value) > 0)) &&
            match.title
          ) {
            try {
              const { parseCouponDiscountFromText, enrichCouponMetaFromText } =
                await import("./couponSavings.js");
              const parsed = parseCouponDiscountFromText(match.title);
              if (parsed.discountType && parsed.discountValue) {
                match.discount_type = parsed.discountType;
                match.discount_value = parsed.discountValue;
                if (parsed.minAmount != null) match.min_amount = parsed.minAmount;
                if (parsed.capAmount != null) match.cap_amount = parsed.capAmount;
                if (coupon) enrichCouponMetaFromText(coupon, match.title);
              }
            } catch {
              /* ignore */
            }
          }
          let estimated = current;
          if (match.discount_type === "percent" && match.discount_value) {
            const quote = quoteCouponCart(
              current,
              {
                discountType: "percent",
                discountValue: Number(match.discount_value),
                minAmount: match.min_amount,
                capAmount: match.cap_amount,
              },
              { maxQty: 6 },
            );
            if (quote.ok) {
              estimated = quote.unitAfter;
              detail = `cupons/api match: ${match.title || coupon} (${match.detail}${quote.qty > 1 ? `; leve ${quote.qty} un.` : ""})`;
            } else if (
              match.min_amount &&
              current + 0.009 < Number(match.min_amount)
            ) {
              return {
                ok: false,
                coupon,
                originalPrice: original,
                finalPrice: current,
                detail: `cupom ${coupon} exige mín. R$${Number(match.min_amount).toFixed(2)} (unidade R$${current.toFixed(2)})`,
                status: "invalid",
              };
            } else {
              estimated = applyPercentDiscount(
                current,
                Number(match.discount_value),
                match.cap_amount,
              );
              detail = `cupons/api match: ${match.title || coupon} (${match.detail})`;
            }
          } else if (match.discount_type === "fixed" && match.discount_value) {
            const quote = quoteCouponCart(
              current,
              {
                discountType: "fixed",
                discountValue: Number(match.discount_value),
                minAmount: match.min_amount,
                capAmount: match.cap_amount,
              },
              { maxQty: 6 },
            );
            if (quote.ok) {
              estimated = quote.unitAfter;
              detail = `cupons/api match: ${match.title || coupon} (${match.detail}${quote.qty > 1 ? `; leve ${quote.qty} un.` : ""})`;
            } else {
              estimated = round2(
                Math.max(0, current - Number(match.discount_value)),
              );
              detail = `cupons/api match: ${match.title || coupon} (${match.detail})`;
            }
          }
          if (estimated < current) {
            finalPrice = estimated;
            if (!/cupons\/api match/i.test(detail)) {
              detail = `cupons/api match: ${match.title || coupon} (${match.detail})`;
            }
          } else {
            // Lista contém o item, mas cupom não reduz o preço unitário (mín. alto / 0 OFF)
            return {
              ok: false,
              coupon,
              originalPrice: original,
              finalPrice: current,
              detail: `cupom na lista sem desconto neste preço (${match.detail}${
                match.min_amount
                  ? `; mín. R$${Number(match.min_amount).toFixed(2)}`
                  : ""
              })`,
              status: "pending",
            };
          }
        } else {
          return {
            ok: false,
            coupon,
            originalPrice: original,
            finalPrice: current,
            detail: couponMeta.detail || "cupom sem desconto confirmado",
            status: "pending",
          };
        }
      }
    }

    const couponSaves =
      Boolean(coupon) && finalPrice + 0.5 < current && finalPrice > 0;
    const result: CouponTestResult = {
      ok: finalPrice > 0 && (!coupon || couponSaves),
      coupon,
      originalPrice: round2(original),
      finalPrice: round2(finalPrice),
      detail,
      status: coupon ? (couponSaves ? "valid" : "pending") : "none",
    };

    cacheSet(cacheKey, result, 20); // cupons curtos: cache curto
    return result;
  } catch (err) {
    recordProviderResult("mercadolivre", {
      ok: false,
      latencyMs: Date.now() - started,
      detail: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      coupon,
      originalPrice: opts.listedOldPrice || opts.listedPrice || 0,
      finalPrice: opts.listedPrice || 0,
      detail: err instanceof Error ? err.message : String(err),
      status: "pending",
    };
  }
}

function estimateFromCouponMatch(
  dealId: number | undefined,
  itemId: string,
  coupon: string | null,
  opts: { listedPrice?: number; listedOldPrice?: number | null },
): CouponTestResult | null {
  try {
    const id =
      dealId ||
      (
        getDb()
          .prepare(
            `SELECT id FROM deals WHERE external_id = ? OR external_id = ? LIMIT 1`,
          )
          .get(itemId, `hubauto-${itemId}`) as { id: number } | undefined
      )?.id;
    if (!id) return null;
    const match = getDb()
      .prepare(
        `SELECT m.validated, m.detail, m.title, m.code,
                c.discount_type, c.discount_value, c.cap_amount, c.min_amount
         FROM deal_coupon_matches m
         LEFT JOIN ml_coupons c ON c.campaign_id = m.campaign_id
         WHERE m.deal_id = ? AND m.validated = 1
         ORDER BY m.updated_at DESC LIMIT 1`,
      )
      .get(id) as
      | {
          validated: number;
          detail: string;
          title: string;
          code: string | null;
          discount_type: string | null;
          discount_value: number | null;
          cap_amount: number | null;
          min_amount: number | null;
        }
      | undefined;
    if (!match) return null;

    const { base, original, sane } = basePriceForCoupon({
      listedPrice: opts.listedPrice,
      listedOldPrice: opts.listedOldPrice,
    });
    if (!sane || base <= 0) {
      return {
        ok: false,
        coupon,
        originalPrice: original || 0,
        finalPrice: 0,
        detail:
          "preço listado inválido (ex.: R$0,02) — não aplicar cupom até corrigir o preço",
        status: "pending",
      };
    }

    let finalPrice = base;
    let qtyNote = "";
    if (match.discount_type === "percent" && match.discount_value) {
      const quote = quoteCouponCart(
        base,
        {
          discountType: "percent",
          discountValue: Number(match.discount_value),
          minAmount: match.min_amount,
          capAmount: match.cap_amount,
        },
        { maxQty: 6 },
      );
      if (quote.ok) {
        finalPrice = quote.unitAfter;
        if (quote.qty > 1) qtyNote = `; leve ${quote.qty} un.`;
      } else if (
        match.min_amount &&
        base + 0.009 < Number(match.min_amount)
      ) {
        // Cupom AINDA VIVO — produto abaixo do mínimo. Não marcar como morto.
        return {
          ok: false,
          coupon,
          originalPrice: round2(original || base),
          finalPrice: round2(base),
          detail: `cupom exige mín. R$${Number(match.min_amount).toFixed(2)} (código ainda pode valer em outros itens)`,
          status: "pending",
        };
      } else {
        finalPrice = applyPercentDiscount(
          base,
          Number(match.discount_value),
          match.cap_amount,
        );
      }
    } else if (match.discount_type === "fixed" && match.discount_value) {
      const quote = quoteCouponCart(
        base,
        {
          discountType: "fixed",
          discountValue: Number(match.discount_value),
          minAmount: match.min_amount,
          capAmount: match.cap_amount,
        },
        { maxQty: 6 },
      );
      if (quote.ok) {
        finalPrice = quote.unitAfter;
        if (quote.qty > 1) qtyNote = `; leve ${quote.qty} un.`;
      } else {
        finalPrice = round2(Math.max(0, base - Number(match.discount_value)));
        if (!isPlausibleProductPrice(finalPrice, { reference: base })) {
          finalPrice = base;
        }
      }
    }

    const digitable =
      coupon && !/^\d+%?OFF$/i.test(coupon.replace(/\s+/g, ""))
        ? coupon
        : match.code && !/^\d+%?OFF$/i.test(String(match.code).replace(/\s+/g, ""))
          ? match.code
          : null;
    const hasDiscount =
      isPlausibleProductPrice(finalPrice, { reference: base }) &&
      base > finalPrice + 0.5;

    // Matches antigos por “amostra/overlap” eram falso positivo (ex.: ECONOMIAML no DualSense)
    const detail = String(match.detail || "");
    const untrusted =
      /amostra do cupom alinhada|overlap=\d+/i.test(detail) ||
      (!/lista contém id|lista com \d+ tokens/i.test(detail) &&
        Boolean(digitable));
    if (untrusted) {
      return {
        ok: false,
        coupon: digitable,
        originalPrice: round2(original || finalPrice),
        finalPrice: round2(base),
        detail: `match antigo não confiável (${detail || "sem evidência na lista"}) — revalidar`,
        status: "pending",
      };
    }

    // Estar na lista do cupom ≠ desconto do cupom (pode ser só preço/oferta da loja).
    if (!hasDiscount) {
      return {
        ok: false,
        coupon: digitable,
        originalPrice: round2(original || base),
        finalPrice: round2(base),
        detail: `cupom na lista sem desconto mensurável neste preço (${detail || "lista"}) — não confundir com oferta da loja`,
        status: "pending",
      };
    }

    return {
      ok: true,
      coupon: digitable,
      originalPrice: round2(original || finalPrice),
      finalPrice: round2(finalPrice),
      detail: digitable
        ? `cupons/api: ${match.title || digitable} (${match.detail}${qtyNote})`
        : `cupons/api desconto no link: ${match.title || "campanha"} (${match.detail}${qtyNote})`,
      status: "valid",
    };
  } catch {
    return null;
  }
}

async function probeCouponDiscount(
  itemId: string,
  coupon: string,
  currentPrice: number,
): Promise<{ applied: boolean; finalPrice: number; detail: string }> {
  // Heurística + endpoint auxiliar: alguns anúncios expõem descontos em /prices
  try {
    const creds = getMercadoLivreCreds();
    const res = await fetch(
      `https://api.mercadolibre.com/items/${itemId}/prices`,
      {
        headers: { Authorization: `Bearer ${creds.accessToken}` },
      },
    );
    if (res.ok) {
      const json = (await res.json()) as {
        prices?: Array<{
          amount?: number;
          regular_amount?: number;
          type?: string;
        }>;
      };
      const best = (json.prices || [])
        .map((p) => p.amount || currentPrice)
        .filter((n) => n > 0)
        .sort((a, b) => a - b)[0];
      if (best && best < currentPrice) {
        return {
          applied: true,
          finalPrice: best,
          detail: `prices API + cupom ${coupon}`,
        };
      }
    }
  } catch {
    /* ignore */
  }

  // Cupons percentuais comuns em canais (fallback só se nome sugerir %)
  const pct = coupon.match(/(\d{1,2})$/);
  if (pct) {
    const n = Number(pct[1]);
    if (n >= 5 && n <= 40) {
      return {
        applied: true,
        finalPrice: round2(currentPrice * (1 - n / 100)),
        detail: `heurística ${n}% no cupom ${coupon}`,
      };
    }
  }

  return {
    applied: false,
    finalPrice: currentPrice,
    detail: `cupom ${coupon} sem desconto mensurável na API`,
  };
}

export async function applyCouponTestToDeal(dealId: number): Promise<
  CouponTestResult & { previousStatus?: string; transitionedToDead?: boolean }
> {
  const deal = getDb()
    .prepare("SELECT * FROM deals WHERE id = ?")
    .get(dealId) as {
    id: number;
    external_id: string;
    source: string;
    price: number;
    old_price: number | null;
    coupon: string | null;
    coupon_status: string;
    status: string;
  } | undefined;

  if (!deal) {
    return {
      ok: false,
      coupon: null,
      originalPrice: 0,
      finalPrice: 0,
      detail: "deal não encontrado",
      status: "invalid",
    };
  }

  const previousStatus = deal.coupon_status;

  let result: CouponTestResult;
  if (deal.source === "demo") {
    const original =
      deal.old_price && deal.old_price > 0 ? deal.old_price : deal.price;
    // Se já foi forçado como morto, mantém
    if (previousStatus === "invalid" || previousStatus === "expired") {
      result = {
        ok: false,
        coupon: deal.coupon,
        originalPrice: original,
        finalPrice: deal.price,
        detail: `demo: cupom ${deal.coupon || ""} já inválido`,
        status: previousStatus as CouponTestResult["status"],
      };
    } else {
      result = {
        ok: true,
        coupon: deal.coupon,
        originalPrice: original,
        finalPrice: deal.price,
        detail: deal.coupon
          ? `demo: cupom ${deal.coupon} validado`
          : "demo sem cupom",
        status: deal.coupon ? "valid" : "none",
      };
    }
  } else if (deal.source === "mercadolivre") {
    const itemId = deal.external_id.replace(/^hubauto-/i, "");
    const listedOk = isPlausibleProductPrice(deal.price, {
      reference: deal.old_price,
    });
    result = await testMercadoLivreCoupon({
      itemId,
      coupon: deal.coupon,
      listedPrice: listedOk ? deal.price : deal.old_price || deal.price,
      listedOldPrice: deal.old_price,
      dealId: deal.id,
    });
  } else if (deal.source === "shopee" || deal.source === "magalu") {
    // Fontes com cupom de plataforma: se API não confirma, marca pending
    const listedOk = isPlausibleProductPrice(deal.price, {
      reference: deal.old_price,
    });
    result = await testMercadoLivreCoupon({
      itemId: deal.external_id.replace(/^hubauto-/i, ""),
      coupon: deal.coupon,
      listedPrice: listedOk ? deal.price : deal.old_price || deal.price,
      listedOldPrice: deal.old_price,
      dealId: deal.id,
    });
    if (getSetting("demo_mode", "1") === "1" && deal.coupon) {
      result = {
        ok: true,
        coupon: deal.coupon,
        originalPrice: deal.old_price || deal.price,
        finalPrice: deal.price,
        detail: `demo ${deal.source}: cupom ok`,
        status: "valid",
      };
    }
  } else {
    result = {
      ok: true,
      coupon: deal.coupon,
      originalPrice: deal.old_price || deal.price,
      finalPrice: deal.price,
      detail: "fonte sem teste de cupom ML",
      status: deal.coupon ? "valid" : "none",
    };
  }

  getDb()
    .prepare(
      `INSERT INTO coupon_tests (deal_id, item_id, coupon, ok, original_price, final_price, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      deal.id,
      deal.external_id,
      result.coupon || "",
      result.ok ? 1 : 0,
      result.originalPrice,
      result.finalPrice,
      result.detail,
    );

  const dead =
    result.status === "invalid" || result.status === "expired";
  const couponLooksDead =
    dead &&
    /cupom|expir|inválid|invalid|esgot|não existe|nao existe/i.test(
      result.detail || "",
    );
  const { noteCouponTestResult } = await import("./couponBlacklist.js");
  if (result.ok && result.status === "valid") {
    noteCouponTestResult(result.coupon, true);
  } else if (couponLooksDead) {
    noteCouponTestResult(result.coupon, false);
  }

  // Falha transitória (sem token, pulse, rate limit…): NÃO demota deal já validado.
  const transient =
    result.status === "pending" && isTransientCouponFail(result.detail || "");
  if (transient) {
    const lastOk = getDb()
      .prepare(
        `SELECT detail, original_price, final_price, coupon
         FROM coupon_tests
         WHERE deal_id = ? AND ok = 1
         ORDER BY id DESC LIMIT 1`,
      )
      .get(deal.id) as
      | {
          detail: string;
          original_price: number;
          final_price: number;
          coupon: string;
        }
      | undefined;
    const keepValid =
      previousStatus === "valid" ||
      deal.status === "queued" ||
      Boolean(lastOk);
    if (keepValid && deal.coupon) {
      logAntiBan(
        "coupon_test_transient_keep",
        `deal=${deal.id} detail=${result.detail} keep=${previousStatus || deal.status}`,
      );
      // Restaura status postável sem sobrescrever preço com lixo do teste falho.
      getDb()
        .prepare(
          `UPDATE deals SET
             coupon_status = 'valid',
             coupon_tested_at = datetime('now'),
             status = CASE
               WHEN status = 'posted' THEN 'posted'
               WHEN status = 'skipped' THEN 'skipped'
               ELSE 'queued'
             END
           WHERE id = ?`,
        )
        .run(deal.id);
      return {
        ...result,
        ok: true,
        status: "valid",
        detail: `${result.detail} (mantido valid — teste anterior OK / status prévio)`,
        originalPrice: lastOk?.original_price || result.originalPrice,
        finalPrice:
          lastOk && lastOk.final_price > 0
            ? lastOk.final_price
            : result.finalPrice,
        previousStatus,
        transitionedToDead: false,
      };
    }
    // Sem histórico válido: fica pending/hold, mas não marca invalid.
    logAntiBan(
      "coupon_test_transient",
      `deal=${deal.id} detail=${result.detail}`,
    );
  }

  const requireTest = getSetting("require_coupon_test", "1") === "1";
  let nextStatus: string;
  if (dead) {
    nextStatus = "skipped";
  } else if (transient) {
    // Sem evidência anterior: segura, mas não “mata” o cupom.
    nextStatus =
      deal.status === "posted"
        ? "posted"
        : deal.status === "queued"
          ? "queued"
          : "hold_coupon";
  } else if (result.coupon && requireTest) {
    nextStatus =
      result.ok && result.status === "valid"
        ? "queued"
        : result.status === "invalid" || result.status === "expired"
          ? "skipped"
          : "hold_coupon";
  } else if (deal.status === "posted") {
    nextStatus = "posted";
  } else {
    nextStatus = "queued";
  }

  // Evita gravar de novo rótulos falsos (25%OFF) vindos de testes antigos
  const couponToStore =
    result.coupon && !/^\d+%?OFF$/i.test(String(result.coupon).replace(/\s+/g, ""))
      ? result.coupon
      : null;

  // Nunca sobrescrever price com price_with_coupon (era a origem do R$0,02).
  const saneListed = pickSanePrices({
    price: deal.price,
    oldPrice: result.originalPrice || deal.old_price,
  });
  let listedPrice = saneListed.price;
  let listedOld = saneListed.oldPrice;
  if (
    result.originalPrice > 0 &&
    isPlausibleProductPrice(result.originalPrice) &&
    (!listedOld || result.originalPrice > listedOld)
  ) {
    listedOld = result.originalPrice;
  }
  // Se o preço listado ainda é lixo mas temos original, usa original como listado
  if (
    !isPlausibleProductPrice(listedPrice, { reference: listedOld }) &&
    isPlausibleProductPrice(listedOld)
  ) {
    listedPrice = listedOld!;
    listedOld = listedOld! > result.finalPrice ? listedOld : null;
  }

  let priceWithCoupon: number | null = null;
  if (
    result.status === "valid" &&
    isPlausibleProductPrice(result.finalPrice, {
      reference: listedOld || listedPrice,
    }) &&
    result.finalPrice + 0.009 < (listedOld || listedPrice)
  ) {
    priceWithCoupon = result.finalPrice;
  } else if (
    result.status === "valid" &&
    isPlausibleProductPrice(result.finalPrice, { reference: listedPrice })
  ) {
    // cupom validado mas sem queda vs listado — mantém listado
    priceWithCoupon = null;
    listedPrice = isPlausibleProductPrice(result.finalPrice)
      ? result.finalPrice
      : listedPrice;
  }

  getDb()
    .prepare(
      `UPDATE deals SET
         coupon = CASE
           WHEN ? IS NOT NULL THEN ?
           WHEN coupon GLOB '*[0-9]%OFF' OR coupon GLOB 'R$*OFF' THEN NULL
           ELSE coupon
         END,
         coupon_status = ?,
         price_with_coupon = ?,
         old_price = COALESCE(?, old_price),
         price = ?,
         coupon_tested_at = datetime('now'),
         status = ?
       WHERE id = ?`,
    )
    .run(
      couponToStore,
      couponToStore,
      result.status === "pending" && !isPlausibleProductPrice(deal.price, { reference: deal.old_price })
        ? "pending"
        : result.status,
      priceWithCoupon,
      listedOld,
      listedPrice > 0 ? listedPrice : deal.price,
      // Sem preço sanável → segura na fila de cupom
      !isPlausibleProductPrice(listedPrice, { reference: listedOld }) && !dead
        ? "hold_coupon"
        : nextStatus,
      deal.id,
    );

  // Garante tip de unidades mínimas na description (todos os cupons com min_amount)
  try {
    const code = String(couponToStore || deal.coupon || "").toUpperCase();
    if (code && result.status === "valid" && priceWithCoupon != null) {
      const { formatCouponQtyDescBit } = await import("./couponPricing.js");
      const row = getDb()
        .prepare(
          `SELECT discount_type, discount_value, min_amount, cap_amount
           FROM ml_coupons WHERE UPPER(code) = ? LIMIT 1`,
        )
        .get(code) as
        | {
            discount_type: string;
            discount_value: number;
            min_amount: number | null;
            cap_amount: number | null;
          }
        | undefined;
      if (row) {
        const quote = quoteCouponCart(listedPrice > 0 ? listedPrice : deal.price, {
          discountType: row.discount_type,
          discountValue: row.discount_value,
          minAmount: row.min_amount,
          capAmount: row.cap_amount,
        });
        const tip = formatCouponQtyDescBit(quote);
        if (tip) {
          const cur = getDb()
            .prepare(`SELECT description FROM deals WHERE id = ?`)
            .get(deal.id) as { description: string };
          let description = String(cur?.description || "");
          description = description
            .replace(/\s*·\s*leve\s+\d+\s+un\.[^\n]*/gi, "")
            .replace(/\s*·\s*carrinho\s+R\$[^\n]*/gi, "");
          if (/Cupom ML:|Desconto ML/i.test(description)) {
            description = description.replace(
              /(Cupom ML:[^\n]*|Desconto ML[^\n]*)/i,
              `$1${tip}`,
            );
          } else {
            description = `${description}\nCupom ML: ${code}${tip}`.trim();
          }
          description = description.replace(/campanha\s+(\d+)·/gi, "campanha $1 ·");
          getDb()
            .prepare(`UPDATE deals SET description = ? WHERE id = ?`)
            .run(description, deal.id);
        }
      }
    }
  } catch {
    /* tip é best-effort */
  }

  const wasAlive =
    previousStatus === "valid" ||
    previousStatus === "pending" ||
    deal.status === "posted" ||
    deal.status === "queued";
  const transitionedToDead = Boolean(
    dead &&
      wasAlive &&
      deal.coupon &&
      !isTransientCouponFail(result.detail || "") &&
      isConfirmedDeadCouponText(result.detail || ""),
  );

  logAntiBan(
    "coupon_test",
    `deal=${deal.id} coupon=${result.coupon || "-"} ok=${result.ok} ${result.detail}`,
  );

  try {
    const { recordDealSnapshot } = await import("./priceHistory.js");
    const fresh = getDb()
      .prepare(
        `SELECT id, external_id, product_url, affiliate_url, price, price_with_coupon, coupon
         FROM deals WHERE id = ?`,
      )
      .get(deal.id) as {
      id: number;
      external_id: string;
      product_url: string;
      affiliate_url: string;
      price: number;
      price_with_coupon: number | null;
      coupon: string | null;
    };
    if (fresh) recordDealSnapshot(fresh, "coupon_test");
  } catch {
    /* ignore */
  }

  return { ...result, previousStatus, transitionedToDead };
}

/** Força esgotamento (útil em demo / painel) e dispara alerta. */
export function forceExpireCoupon(dealId: number, detail = "forçado no painel"): void {
  getDb()
    .prepare(
      `UPDATE deals SET
         coupon_status = 'expired',
         status = 'skipped',
         coupon_tested_at = datetime('now')
       WHERE id = ?`,
    )
    .run(dealId);
  getDb()
    .prepare(
      `INSERT INTO coupon_tests (deal_id, item_id, coupon, ok, original_price, final_price, detail)
       SELECT id, external_id, COALESCE(coupon,''), 0, old_price, price, ?
       FROM deals WHERE id = ?`,
    )
    .run(detail, dealId);
  logAntiBan("coupon_force_expire", `deal=${dealId} ${detail}`);
}

/**
 * Corrige ofertas com preço absurdo (ex.: R$0,02 com old_price R$249).
 * Restaura price a partir de old_price e reestima cupom %.
 */
export function repairAbsurdDealPrices(): {
  scanned: number;
  repaired: number;
  ids: number[];
} {
  const rows = getDb()
    .prepare(
      `SELECT id, price, old_price, price_with_coupon, coupon, coupon_status, status
       FROM deals
       WHERE status IN ('queued','hold_coupon','posted','skipped')
         AND (
           (old_price IS NOT NULL AND old_price > 5 AND price > 0 AND price < old_price * 0.05)
           OR (price > 0 AND price < 0.5 AND (old_price IS NULL OR old_price > 5))
           OR (price_with_coupon IS NOT NULL AND price_with_coupon > 0 AND price_with_coupon < 0.5
               AND old_price IS NOT NULL AND old_price > 5)
         )`,
    )
    .all() as Array<{
    id: number;
    price: number;
    old_price: number | null;
    price_with_coupon: number | null;
    coupon: string | null;
    coupon_status: string;
    status: string;
  }>;

  const ids: number[] = [];
  for (const row of rows) {
    const sane = pickSanePrices({
      price: row.price,
      oldPrice: row.old_price,
    });
    let price = sane.price;
    let oldPrice = sane.oldPrice ?? row.old_price;
    // Preço atual lixo + cheio ok → restaura listado = cheio, mantém cheio em old_price
    if (
      row.old_price != null &&
      isPlausibleProductPrice(row.old_price) &&
      !isPlausibleProductPrice(row.price, { reference: row.old_price })
    ) {
      price = Number(row.old_price);
      oldPrice = Number(row.old_price);
    }
    if (!isPlausibleProductPrice(price)) continue;

    // Reestima cupom % se houver match
    let priceWithCoupon: number | null = null;
    try {
      const match = getDb()
        .prepare(
          `SELECT c.discount_type, c.discount_value, c.cap_amount
           FROM deal_coupon_matches m
           LEFT JOIN ml_coupons c ON c.campaign_id = m.campaign_id
           WHERE m.deal_id = ? AND m.validated = 1
           ORDER BY m.updated_at DESC LIMIT 1`,
        )
        .get(row.id) as
        | {
            discount_type: string | null;
            discount_value: number | null;
            cap_amount: number | null;
          }
        | undefined;
      if (match?.discount_type === "percent" && match.discount_value) {
        const final = applyPercentDiscount(
          price,
          Number(match.discount_value),
          match.cap_amount,
        );
        if (
          isPlausibleProductPrice(final, { reference: oldPrice || price }) &&
          final + 0.009 < price
        ) {
          priceWithCoupon = final;
        }
      }
    } catch {
      /* ignore */
    }

    getDb()
      .prepare(
        `UPDATE deals SET
           price = ?,
           old_price = ?,
           price_with_coupon = ?,
           coupon_status = CASE
             WHEN ? IS NOT NULL THEN 'valid'
             WHEN coupon IS NOT NULL AND coupon != '' THEN 'pending'
             ELSE coupon_status
           END,
           status = CASE
             WHEN status IN ('skipped') THEN status
             WHEN ? IS NOT NULL THEN 'queued'
             WHEN coupon IS NOT NULL AND coupon != '' THEN 'hold_coupon'
             ELSE 'queued'
           END
         WHERE id = ?`,
      )
      .run(
        price,
        oldPrice,
        priceWithCoupon,
        priceWithCoupon,
        priceWithCoupon,
        row.id,
      );
    ids.push(row.id);
  }

  if (ids.length) {
    logAntiBan(
      "price_repair",
      `repaired=${ids.length} ids=${ids.slice(0, 20).join(",")}`,
    );
  }
  return { scanned: rows.length, repaired: ids.length, ids };
}
