import {
  getDb,
  getSetting,
  getSettingNum,
  setSetting,
  logAntiBan,
  type Deal,
  type WaGroup,
  type GroupFleet,
} from "../db/index.js";
import {
  canSendNow,
  effectiveGroupIntervalMin,
  getCadence,
  hashMessage,
  markWaveStarted,
  pauseSending,
  sleep,
  touchWaveClock,
  noteHttpBlockError,
  clearHttpBlockStreak,
} from "./antiBan.js";
import {
  listQueuedDealsForGroup,
  markDeal,
  markDealPostedForGroup,
  listPendingCouponDeals,
  listDealsNeedingRevalidation,
} from "./affiliates.js";
import { composePromo, composePromoMessage } from "./composer.js";
import { applyCouponTestToDeal } from "./couponTester.js";
import { notifyCouponExpired } from "./couponExpiryAlert.js";
import { ensureDealImage } from "./dealMedia.js";
import { groupLogoPath, watermarkProductImage } from "./imageWatermark.js";
import { getWaStatus, sendGroupImage, sendGroupText } from "./whatsapp.js";
import { isPlausibleProductPrice } from "./priceSanity.js";
import { explainSkipDeal, isBuyableDeal } from "./dealQuality.js";
import {
  enrichCouponMetaFromText,
  evaluateCouponSavings,
  resolveCouponRuleForDeal,
} from "./couponSavings.js";
import {
  formatCouponQtyDescBit,
  parseCouponPackFromDescription,
  quoteCouponCart,
  scrubCouponDescTips,
} from "./couponPricing.js";
import { wasProductPostedRecently } from "./productDedupe.js";
import { isExpensiveReprint, isGenericTcgSeller, isTcgCollectible } from "./tcgFilter.js";
import { isVideoGameDeal } from "./gamesFilter.js";
import { classifyProduct } from "./categories.js";
import { resolveGroupBrand } from "./groupBrand.js";
import { isCouponBlacklisted } from "./couponBlacklist.js";
import {
  couponCodesMatch,
  clearGroupFocusCoupon,
  getGroupFocusCoupon,
  getGroupFocusCouponStack,
  isGroupFocusCouponLive,
  pushGroupFocusCoupon,
  recentAnnouncedCouponCodes,
  shiftWaitingCoupon,
} from "./couponCategories.js";
import { resolveDealPrices } from "./dealDisplay.js";

function activeGroups(): WaGroup[] {
  return getDb()
    .prepare("SELECT * FROM wa_groups WHERE active = 1 ORDER BY id ASC")
    .all() as WaGroup[];
}

function randomBetween(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function groupDue(group: WaGroup, opts?: { ignoreInterval?: boolean }): boolean {
  if (opts?.ignoreInterval) return true;
  if (!group.last_posted_at) return true;
  const last = Date.parse(group.last_posted_at);
  if (!Number.isFinite(last)) return true;
  const stored = Number(getSetting(`group_next_gap_min_${group.id}`, "0")) || 0;
  const gapMin = stored > 0 ? stored : effectiveGroupIntervalMin(group);
  return Date.now() - last >= gapMin * 60_000;
}

function logPost(opts: {
  dealId: number | null;
  groupId: number | null;
  messageHash: string;
  ok: boolean;
  reason: string;
  waKey?: string | null;
  headlineVariant?: string | null;
}): void {
  getDb()
    .prepare(
      `INSERT INTO post_logs (deal_id, group_id, message_hash, ok, reason, wa_key, headline_variant)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.dealId,
      opts.groupId,
      opts.messageHash,
      opts.ok ? 1 : 0,
      opts.reason,
      opts.waKey || null,
      opts.headlineVariant || null,
    );
}

function touchGroup(id: number): void {
  const cadence = getCadence();
  const nextGap = Math.max(
    cadence.groupIntervalMin,
    Math.round(
      randomBetween(cadence.minDelaySec, cadence.maxDelaySec) / 60,
    ),
  );
  setSetting(`group_next_gap_min_${id}`, String(nextGap));
  getDb()
    .prepare(
      `UPDATE wa_groups SET last_posted_at = datetime('now') WHERE id = ?`,
    )
    .run(id);
}

function fleetForGroup(group: WaGroup): GroupFleet | undefined {
  if (!group.fleet_id) return undefined;
  return getDb()
    .prepare("SELECT * FROM group_fleets WHERE id = ?")
    .get(group.fleet_id) as GroupFleet | undefined;
}

/** Revalida cupons continuamente (expiram em minutos/horas). */
export async function revalidateCouponsContinuously(): Promise<{
  checked: number;
  stillValid: number;
  invalidated: number;
  removed: number;
  alertsSent: number;
  published: number;
}> {
  // Limpa hold já morto (cupom inválido/expirado ou sem código) — libera fila.
  const stale = getDb()
    .prepare(
      `SELECT id FROM deals
       WHERE status = 'hold_coupon'
         AND (
           coupon_status IN ('invalid', 'expired')
           OR coupon IS NULL
           OR trim(coupon) = ''
         )`,
    )
    .all() as Array<{ id: number }>;
  let removed = 0;
  if (stale.length) {
    const ph = stale.map(() => "?").join(",");
    getDb()
      .prepare(`DELETE FROM deals WHERE id IN (${ph}) AND status = 'hold_coupon'`)
      .run(...stale.map((r) => r.id));
    removed += stale.length;
    logAntiBan("hold_coupon_purge_stale", `removed=${stale.length}`);
  }

  const pending = listPendingCouponDeals(8);
  const aging = listDealsNeedingRevalidation(6);
  const ids = [...new Set([...pending, ...aging].map((d) => d.id))];
  let stillValid = 0;
  let invalidated = 0;
  let alertsSent = 0;
  let newlyValid = 0;

  for (const id of ids) {
    const before = getDb()
      .prepare("SELECT * FROM deals WHERE id = ?")
      .get(id) as Deal | undefined;
    if (!before) continue;

    // Hold com cupom digitável: confirma no PDP; se não aplica, remove.
    if (
      before.status === "hold_coupon" &&
      before.coupon &&
      before.coupon_status !== "valid"
    ) {
      try {
        const { confirmDigitableCouponOnPdp, isDigitableCouponCode } =
          await import("./mlCoupons.js");
        const { normalizeItemId } = await import("./mlHub.js");
        const itemId =
          normalizeItemId(before.external_id) ||
          normalizeItemId(before.product_url);
        if (
          itemId &&
          isDigitableCouponCode(before.coupon) &&
          isPlausibleProductPrice(before.price, { reference: before.old_price })
        ) {
          const conf = await confirmDigitableCouponOnPdp({
            itemId,
            unitPrice: before.price,
            code: String(before.coupon),
          });
          if (!conf.ok && !conf.inconclusive) {
            getDb()
              .prepare(`DELETE FROM deals WHERE id = ? AND status = 'hold_coupon'`)
              .run(id);
            removed += 1;
            invalidated += 1;
            logAntiBan(
              "hold_coupon_purge_pdp",
              `deal=${id} ${before.coupon} ${conf.detail}`,
            );
            continue;
          }
        }
      } catch {
        /* segue para applyCouponTest */
      }
    }

    const result = await applyCouponTestToDeal(id);
    if (result.ok && result.status === "valid") {
      stillValid += 1;
      if (
        before &&
        before.coupon_status !== "valid" &&
        before.status !== "posted"
      ) {
        newlyValid += 1;
      }
      continue;
    }
    if (result.status === "invalid" || result.status === "expired") {
      invalidated += 1;
      const { isTransientCouponFail } = await import("./couponLiveCheck.js");
      if (isTransientCouponFail(result.detail || "")) {
        continue;
      }
      const shouldAlert =
        result.transitionedToDead ||
        (before?.coupon_status === "valid" &&
          (before?.status === "posted" || before?.status === "queued"));
      if (shouldAlert && before?.coupon) {
        const fresh = getDb()
          .prepare("SELECT * FROM deals WHERE id = ?")
          .get(id) as Deal | undefined;
        if (fresh) {
          const alert = await notifyCouponExpired(fresh, result.detail);
          alertsSent += alert.notified;
        }
      }
      // Não ficou válido: tira do hold e abre espaço para produtos novos.
      if (before.status !== "posted") {
        getDb()
          .prepare(
            `DELETE FROM deals WHERE id = ? AND status IN ('hold_coupon','queued','skipped')`,
          )
          .run(id);
        removed += 1;
      } else {
        markDeal(id, "skipped");
      }
    }
  }

  let published = 0;
  if (
    newlyValid > 0 &&
    getSetting("auto_publish_on_coupon_valid", "1") === "1"
  ) {
    const wave = await runPublishWave({
      manual: true,
      ignoreGroupInterval: true,
      skipRevalidate: true,
    });
    published = wave.sent;
  }

  setSetting("coupon_watch_last_at", new Date().toISOString());

  return {
    checked: ids.length,
    stillValid,
    invalidated,
    removed,
    alertsSent,
    published,
  };
}

export { getCouponRevalidateSchedule } from "./dealPipeline.js";

let publishWaveLock: Promise<void> | null = null;

/**
 * Publica no máximo 1 grupo por onda (salvo rajada de cupom).
 * Intervalo 12–20 min é por grupo (last_posted_at); jitter de envio é curto.
 * Limite diário (40 na semana 1) é POR GRUPO.
 */
export async function runPublishWave(opts?: {
  /** Clique manual no painel: ignora cooldown de onda e acelera delay */
  manual?: boolean;
  /** Força envio mesmo fora do interval_minutes do grupo */
  ignoreGroupInterval?: boolean;
  /** Evita revalidar de novo (quando já veio do watcher de cupons) */
  skipRevalidate?: boolean;
  /** Só este grupo (após anúncio de cupom) */
  forceGroupId?: number;
  /** Só ofertas deste código */
  preferCoupon?: string;
  /** Quantas ofertas enviar nesta onda (1 no fluxo normal) */
  maxPosts?: number;
  /** Rajada logo após o aviso de cupom */
  couponBurst?: boolean;
}): Promise<{
  attempted: number;
  sent: number;
  blockedReason?: string;
  details?: string[];
}> {
  // Mutex: evita 2 ondas paralelas postarem o mesmo deal (Achadinhos x2)
  if (publishWaveLock) {
    return {
      attempted: 0,
      sent: 0,
      blockedReason: "Outra publicação em andamento — aguarde",
    };
  }
  let release!: () => void;
  publishWaveLock = new Promise<void>((r) => {
    release = r;
  });
  try {
    return await runPublishWaveInner(opts);
  } finally {
    publishWaveLock = null;
    release();
  }
}

async function runPublishWaveInner(opts?: {
  manual?: boolean;
  ignoreGroupInterval?: boolean;
  skipRevalidate?: boolean;
  forceGroupId?: number;
  preferCoupon?: string;
  maxPosts?: number;
  couponBurst?: boolean;
}): Promise<{
  attempted: number;
  sent: number;
  blockedReason?: string;
  details?: string[];
}> {
  const manual = Boolean(opts?.manual);
  if (!opts?.skipRevalidate) {
    await revalidateCouponsContinuously();
  }

  const wa = getWaStatus();
  if (!wa.connected) {
    return {
      attempted: 0,
      sent: 0,
      blockedReason: "WhatsApp offline — escaneie o QR em Início",
    };
  }
  if (!manual && getSetting("maintenance_mode", "0") === "1") {
    return {
      attempted: 0,
      sent: 0,
      blockedReason: "Modo manutenção — Sync segue, posts só no Enviar agora",
    };
  }

  const ignoreInterval = Boolean(opts?.ignoreGroupInterval || manual);
  const couponBurst = Boolean(opts?.couponBurst);
  const preferCoupon = String(opts?.preferCoupon || "").trim();
  // Rajada pós-cupom: até 8 ofertas afiliadas do mesmo código.
  const maxPosts = Math.max(
    1,
    Math.min(couponBurst ? 8 : 4, Number(opts?.maxPosts) || 1),
  );
  const due = activeGroups().filter((g) => {
    if (opts?.forceGroupId && g.id !== opts.forceGroupId) return false;
    return groupDue(g, { ignoreInterval });
  });
  if (due.length === 0) {
    const active = activeGroups();
    return {
      attempted: 0,
      sent: 0,
      blockedReason: active.length
        ? "Nenhuma comunidade/grupo no intervalo de postagem ainda"
        : "Nenhuma comunidade/grupo ativo cadastrado — vá em Grupos",
    };
  }

  // Só grupos com oferta na fila — evita queimar a onda no TCG vazio
  const withDeal = due.filter(
    (g) =>
      listQueuedDealsForGroup(g, 8, {
        coupon: preferCoupon || null,
      }).length > 0,
  );
  if (withDeal.length === 0) {
    return {
      attempted: 0,
      sent: 0,
      blockedReason:
        "Grupos no intervalo, mas sem ofertas na fila (cadastre Sync/lojas por categoria)",
      details: due.map(
        (g) => `${g.name}: sem oferta (categoria ${g.categories})`,
      ),
    };
  }

  // Sempre 1 grupo por onda — intercalação ~1 min (anti-ban com muitos grupos)
  const maxPerWave = 1;

  // Gate global (pausa / janela / gap curto) — sem groupId ainda
  const decision = canSendNow({
    groupsInWave: Math.min(withDeal.length, maxPerWave),
    manual,
    priorityCoupon: couponBurst,
    couponBurst,
  });
  if (!decision.allow) {
    return { attempted: 0, sent: 0, blockedReason: decision.reason };
  }

  // Prefere o grupo há mais tempo sem post (rodízio justo entre Eletrônicos / TCG / …)
  let ranked = [...withDeal].sort((a, b) => {
    const ta = a.last_posted_at ? Date.parse(a.last_posted_at) : 0;
    const tb = b.last_posted_at ? Date.parse(b.last_posted_at) : 0;
    return ta - tb;
  });
  if (!manual) {
    const lastCat = (
      getDb()
        .prepare(
          `SELECT g.categories AS categories
           FROM post_logs pl
           JOIN wa_groups g ON g.id = pl.group_id
           WHERE pl.ok = 1
           ORDER BY pl.id DESC LIMIT 1`,
        )
        .get() as { categories?: string } | undefined
    )?.categories || "";
    const lastWasTcg = /(^|,)\s*tcg\s*(,|$)/i.test(lastCat);
    if (lastWasTcg) {
      const elec = ranked.find(
        (g) =>
          /eletronicos/.test(g.categories || "") &&
          !/(^|,)\s*tcg\s*(,|$)/i.test(g.categories || ""),
      );
      if (
        elec &&
        /(^|,)\s*tcg\s*(,|$)/i.test(ranked[0]?.categories || "")
      ) {
        ranked = [elec, ...ranked.filter((g) => g.id !== elec.id)];
      }
    }
  }
  const recentCouponGroup = (
    getDb()
      .prepare(
        `SELECT group_id AS id FROM coupon_announcements
         WHERE kind = 'valid'
           AND created_at >= datetime('now', '-8 hours')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get() as { id?: number } | undefined
  )?.id;
  if (recentCouponGroup) {
    const hot = ranked.find((g) => g.id === recentCouponGroup);
    if (hot) ranked = [hot, ...ranked.filter((g) => g.id !== hot.id)];
  }
  // Até 3 grupos na fila da onda: se o 1º só tem cupom morto no PDP, tenta o próximo
  // (ainda 1 envio bem-sucedido por onda — anti-flood).
  const wave = ranked.slice(0, Math.min(3, ranked.length));

  let sent = 0;
  let groupsTried = 0;
  const details: string[] = [];
  for (const group of wave) {
    if (sent >= maxPosts) break;
    groupsTried += 1;
    // Cap de moda por hora (anti-viés Achadinhos)
    const fashionCap = getSettingNum("fashion_hourly_cap", 3, 1, 10);
    let fashionBlocked = false;
    try {
      const { fashionPostsLastHour } = await import("./internalPriceRef.js");
      if (
        /geral|achadinhos/.test(String(group.categories || "")) &&
        fashionPostsLastHour(group.id) >= fashionCap
      ) {
        fashionBlocked = true;
      }
    } catch {
      /* ignore */
    }

    // Foco exclusivo: só o cupom anunciado até esgotar.
    const focusCode =
      String(preferCoupon || "").trim().toUpperCase() ||
      getGroupFocusCoupon(group.id);
    const focusLive = focusCode
      ? preferCoupon
        ? true
        : isGroupFocusCouponLive(group.id)
      : false;
    let exclusive: string | null =
      focusCode && (preferCoupon || focusLive) ? focusCode : null;

    let candidates = exclusive
      ? listQueuedDealsForGroup(group, couponBurst ? 20 : 24, {
          coupon: exclusive,
        })
      : listQueuedDealsForGroup(group, couponBurst ? 16 : 20);

    if (fashionBlocked) {
      candidates = candidates.filter(
        (d) =>
          !/legging|camiseta|cropped|meia|calça|blusa|vestido|fitness/i.test(
            d.title || "",
          ),
      );
    }

    // Sem estoque do cupom em foco: colhe de novo — se ainda vazio, promove fila de espera.
    if (!candidates.length && exclusive && !couponBurst) {
      try {
        const { ingestDealsFromCouponLists } = await import(
          "./couponHarvest.js"
        );
        await ingestDealsFromCouponLists({
          maxCoupons: 1,
          maxItemsPerCoupon: 16,
          mintLinks: 12,
          preferCodes: [exclusive],
        });
        candidates = listQueuedDealsForGroup(group, 24, {
          coupon: exclusive,
        });
      } catch (err) {
        logAntiBan(
          "focus_coupon_reharvest_err",
          err instanceof Error ? err.message : String(err),
        );
      }
      if (!candidates.length) {
        // Gira a fila de espera até achar cupom com estoque (ou liberar foco).
        let current = exclusive;
        let guard = 0;
        while (guard++ < 8) {
          clearGroupFocusCoupon(group.id, current);
          const next = shiftWaitingCoupon(group.id);
          if (!next?.code) {
            logAntiBan(
              "focus_coupon_cleared",
              `${group.name}: ${current} sem estoque e sem fila de espera`,
            );
            exclusive = null;
            candidates = listQueuedDealsForGroup(group, 20);
            break;
          }
          pushGroupFocusCoupon(group.id, next.code, next.until);
          logAntiBan(
            "focus_coupon_rotate",
            `${group.name}: ${current} sem estoque → foco ${next.code}`,
          );
          current = next.code;
          exclusive = next.code;
          candidates = listQueuedDealsForGroup(group, 24, {
            coupon: next.code,
          });
          if (candidates.length) break;
        }
        if (!candidates.length) {
          clearGroupFocusCoupon(group.id);
          exclusive = null;
          candidates = listQueuedDealsForGroup(group, 20);
        }
      }
    }

    // Postáveis primeiro (meli.la) — evita gastar a onda em SKU sem link afiliado.
    const rankedPool = [...candidates].sort((a, b) => {
      const ma = /meli\.la\//i.test(a.affiliate_url || "") ? 1 : 0;
      const mb = /meli\.la\//i.test(b.affiliate_url || "") ? 1 : 0;
      if (mb !== ma) return mb - ma;
      const ca = a.coupon_status === "valid" ? 1 : 0;
      const cb = b.coupon_status === "valid" ? 1 : 0;
      return cb - ca;
    });
    const pool = rankedPool.slice(0, couponBurst ? 16 : 8);
    if (!pool.length) {
      details.push(
        exclusive
          ? `${group.name}: aguardando produtos de ${exclusive} (não posto outro cupom até esgotar)`
          : `${group.name}: sem oferta na fila (categoria ${group.categories})`,
      );
      continue;
    }
    const featuredCodes = exclusive
      ? [exclusive]
      : getGroupFocusCouponStack(group.id);
    /** Falhas PDP “não aplica” no cupom em foco → gira (anti-fila-morta). */
    let focusPdpMisses = 0;

    for (const queued of pool) {
    let deal = queued;

    let refreshedBefore = deal.price;
    let refreshedAfter: number | null = null;
    let pdpHtml: string | null = null;
    const sellerBefore = String(deal.seller_id || "");
    // Revalida preço vivo no ML antes de postar (evita Havaianas 27,32 vs 44,90)
    try {
      const { refreshDealLivePrice } = await import("./priceRefresh.js");
      const refreshed = await refreshDealLivePrice(deal.id);
      refreshedBefore = refreshed.before;
      refreshedAfter = refreshed.after;
      pdpHtml = refreshed.html || null;
      if (refreshed.changed) {
        details.push(
          `${group.name}: preço atualizado ${refreshed.before}→${refreshed.after}`,
        );
      }
      deal = getDb()
        .prepare("SELECT * FROM deals WHERE id = ?")
        .get(deal.id) as Deal;
      try {
        const { savePdpProof } = await import("./pdpProof.js");
        savePdpProof({ deal, html: refreshed.html });
      } catch {
        /* prova não bloqueia o post */
      }
    } catch (err) {
      logAntiBan(
        "pre_post_price_refresh_fail",
        err instanceof Error ? err.message : String(err),
      );
    }

    if (!isBuyableDeal(deal)) {
      markDeal(deal.id, "skipped");
      logPost({
        dealId: deal.id,
        groupId: group.id,
        messageHash: "",
        ok: false,
        reason: "oferta sem preço/link comprável",
      });
      details.push(`${group.name}: pulou “${deal.title.slice(0, 36)}” (não comprável)`);
      continue;
    }

    const groupCats = (group.categories || "")
      .toLowerCase()
      .split(",")
      .map((s) => s.trim());

    if (
      deal.source === "mercadolivre" &&
      !/meli\.la\//i.test(deal.affiliate_url || "") &&
      getSetting("require_meli_la", "1") === "1" &&
      getSetting("demo_mode", "1") !== "1"
    ) {
      details.push(`${group.name}: sem meli.la — não posta “${deal.title.slice(0, 36)}”`);
      continue;
    }

    if (
      groupCats.includes("tcg") &&
      (isExpensiveReprint(deal.title, deal.price, deal.old_price) ||
        isGenericTcgSeller(deal.seller_name))
    ) {
      markDeal(deal.id, "skipped");
      details.push(`${group.name}: reprint/vendedor genérico — pulou`);
      continue;
    }
    if (
      groupCats.includes("tcg") &&
      getSetting("tcg_official_only", "0") === "1" &&
      Number(deal.official_store) !== 1
    ) {
      details.push(`${group.name}: TCG só loja oficial — pulou`);
      continue;
    }
    if (
      sellerBefore &&
      deal.seller_id &&
      sellerBefore !== String(deal.seller_id)
    ) {
      logAntiBan(
        "seller_changed",
        `deal=${deal.id} ${sellerBefore}→${deal.seller_id} ${deal.seller_name || ""}`,
      );
      details.push(
        `${group.name}: vendedor trocou (${deal.seller_name || deal.seller_id})`,
      );
    }

    const risePct = getSettingNum("price_rise_skip_pct", 15, 5, 80) / 100;
    if (
      refreshedAfter &&
      refreshedBefore > 8 &&
      refreshedAfter > refreshedBefore * (1 + risePct) &&
      !(deal.old_price && refreshedBefore < deal.old_price * 0.5)
    ) {
      markDeal(deal.id, "skipped");
      logPost({
        dealId: deal.id,
        groupId: group.id,
        messageHash: "",
        ok: false,
        reason: `preço subiu >${Math.round(risePct * 100)}% desde a fila`,
      });
      details.push(
        `${group.name}: preço subiu ${refreshedBefore}→${refreshedAfter} — não posta`,
      );
      continue;
    }

    if (
      deal.old_price &&
      deal.price >= deal.old_price * 0.985 &&
      deal.coupon_status !== "valid"
    ) {
      markDeal(deal.id, "skipped");
      details.push(`${group.name}: Por ≈ De sem cupom — rebaixada`);
      continue;
    }

    if (isCouponBlacklisted(deal.coupon)) {
      markDeal(deal.id, "hold_coupon");
      details.push(`${group.name}: cupom ${deal.coupon} na blacklist`);
      continue;
    }

    if (
      groupCats.includes("geral") &&
      !groupCats.includes("tcg") &&
      (deal.category === "tcg" || isTcgCollectible(deal.title))
    ) {
      details.push(`${group.name}: TCG não vai em Achadinhos`);
      continue;
    }
    if (
      groupCats.includes("tcg") &&
      !groupCats.includes("geral") &&
      !isTcgCollectible(deal.title, deal.product_url)
    ) {
      let next = classifyProduct({
        title: deal.title,
        productUrl: deal.product_url,
      });
      if (next === "tcg") next = "geral";
      getDb()
        .prepare(`UPDATE deals SET category = ? WHERE id = ?`)
        .run(next, deal.id);
      details.push(
        `${group.name}: “${deal.title.slice(0, 36)}” não é TCG → ${next}`,
      );
      continue;
    }
    if (
      groupCats.includes("games") &&
      !groupCats.includes("geral") &&
      !isVideoGameDeal(deal.title, deal.product_url)
    ) {
      let next = classifyProduct({
        title: deal.title,
        productUrl: deal.product_url,
      });
      if (next === "games") next = "geral";
      getDb()
        .prepare(`UPDATE deals SET category = ? WHERE id = ?`)
        .run(next, deal.id);
      details.push(
        `${group.name}: “${deal.title.slice(0, 36)}” não é videogame → ${next}`,
      );
      continue;
    }

    if (
      groupCats.includes("eletronicos") &&
      !groupCats.includes("geral")
    ) {
      const { isHomeApplianceTitle, isToyOrKidsTitle, isClearlyNotElectronics } =
        await import("./electronicsFilter.js");
      if (
        isToyOrKidsTitle(deal.title, deal.product_url) ||
        (isClearlyNotElectronics(deal.title, deal.product_url) &&
          !isHomeApplianceTitle(deal.title, deal.product_url))
      ) {
        const next = classifyProduct({
          title: deal.title,
          productUrl: deal.product_url,
        });
        getDb()
          .prepare(`UPDATE deals SET category = ? WHERE id = ?`)
          .run(next === "eletronicos" ? "geral" : next, deal.id);
        details.push(
          `${group.name}: “${deal.title.slice(0, 36)}” não é eletrônico → ${next}`,
        );
        continue;
      }
      if (
        isHomeApplianceTitle(deal.title, deal.product_url) ||
        deal.category === "eletrodomesticos"
      ) {
        getDb()
          .prepare(
            `UPDATE deals SET category = 'eletrodomesticos' WHERE id = ?`,
          )
          .run(deal.id);
        // Grupo Eletrônicos sem eletrodomésticos na lista → Achadinhos cobre.
        if (!groupCats.includes("eletrodomesticos")) {
          details.push(
            `${group.name}: eletrodoméstico “${deal.title.slice(0, 36)}” → fora deste grupo`,
          );
          continue;
        }
      }
    }

    if (
      !isPlausibleProductPrice(deal.price, { reference: deal.old_price }) &&
      !isPlausibleProductPrice(deal.old_price)
    ) {
      markDeal(deal.id, "hold_coupon");
      logPost({
        dealId: deal.id,
        groupId: group.id,
        messageHash: "",
        ok: false,
        reason: "preço inválido (ex.: R$0,02) — aguardando correção",
      });
      details.push(`${group.name}: preço inválido em “${deal.title.slice(0, 36)}”`);
      continue;
    }

    // Limites POR GRUPO (40/dia na semana 1)
    const groupGate = canSendNow({
      groupId: group.id,
      groupsInWave: 1,
      manual,
      withinWave: true,
      couponBurst,
      priorityCoupon: couponBurst,
    });
    if (!groupGate.allow) {
      details.push(`${group.name}: ${groupGate.reason}`);
      break;
    }

    // Sempre reanalisa cupom no ML — EXCETO quando já está no cupom em foco.
    const alreadyFocused =
      Boolean(exclusive) && couponCodesMatch(exclusive, deal.coupon);
    if (
      !alreadyFocused &&
      (deal.source === "mercadolivre" || deal.source === "demo")
    ) {
      try {
        const { enrichDealWithBestCoupon } = await import("./mlCoupons.js");
        const enriched = await enrichDealWithBestCoupon(deal.id, {
          validate: true,
          syncIfEmpty: false,
          preferredCodes: featuredCodes.length
            ? featuredCodes
            : recentAnnouncedCouponCodes(group.id),
        });
        if (enriched.ok) {
          details.push(
            `${group.name}: cupom ${enriched.coupon || "loja"} → ${enriched.detail}`,
          );
        }
      } catch (err) {
        logAntiBan(
          "pre_post_coupon_enrich_fail",
          err instanceof Error ? err.message : String(err),
        );
      }
      deal = getDb()
        .prepare("SELECT * FROM deals WHERE id = ?")
        .get(deal.id) as Deal;
    }

    if (exclusive && !couponCodesMatch(deal.coupon, exclusive)) {
      details.push(
        `${group.name}: pulou “${deal.title.slice(0, 36)}” (foco ${exclusive})`,
      );
      continue;
    }

    if (deal.coupon) {
      // Confirma no PDP que o código realmente aplica (has_items + given_discount).
      try {
        const { confirmDigitableCouponOnPdp, isDigitableCouponCode } =
          await import("./mlCoupons.js");
        const { normalizeItemId } = await import("./mlHub.js");
        const itemId =
          normalizeItemId(deal.external_id) ||
          normalizeItemId(deal.product_url);
        if (
          itemId &&
          isDigitableCouponCode(deal.coupon) &&
          isPlausibleProductPrice(deal.price, { reference: deal.old_price })
        ) {
          const conf = await confirmDigitableCouponOnPdp({
            itemId,
            unitPrice: deal.price,
            code: String(deal.coupon),
          });
          if (!conf.ok) {
            // Sem tracking (rate-limit / só raw) → adia o post, NÃO demove.
            if (conf.inconclusive) {
              logPost({
                dealId: deal.id,
                groupId: group.id,
                messageHash: "",
                ok: false,
                reason: conf.detail,
              });
              details.push(
                `${group.name}: PDP inconclusivo (adia) — “${deal.title.slice(0, 36)}”`,
              );
              continue;
            }
            getDb()
              .prepare(
                `UPDATE deals SET
                   coupon_status = 'pending',
                   price_with_coupon = NULL,
                   status = 'hold_coupon'
                 WHERE id = ? AND status != 'posted'`,
              )
              .run(deal.id);
            logPost({
              dealId: deal.id,
              groupId: group.id,
              messageHash: "",
              ok: false,
              reason: conf.detail,
            });
            details.push(
              `${group.name}: ${conf.detail} — “${deal.title.slice(0, 36)}”`,
            );
            // Cupom em foco morto neste SKU: após 3 misses, gira a fila de espera.
            if (
              exclusive &&
              couponCodesMatch(deal.coupon, exclusive) &&
              /has_items=false|não aplic|sem given_discount|PDP sem /i.test(
                conf.detail || "",
              )
            ) {
              focusPdpMisses += 1;
              if (focusPdpMisses >= 3) {
                const dead = exclusive;
                clearGroupFocusCoupon(group.id, dead);
                const next = shiftWaitingCoupon(group.id);
                if (next?.code) {
                  pushGroupFocusCoupon(group.id, next.code, next.until);
                  exclusive = next.code;
                  logAntiBan(
                    "focus_coupon_pdp_rotate",
                    `${group.name}: ${dead} sem PDP válido → foco ${next.code}`,
                  );
                  details.push(
                    `${group.name}: foco ${dead} sem estoque real → ${next.code}`,
                  );
                } else {
                  clearGroupFocusCoupon(group.id);
                  exclusive = null;
                  logAntiBan(
                    "focus_coupon_pdp_cleared",
                    `${group.name}: ${dead} sem PDP e sem fila de espera`,
                  );
                }
                break;
              }
            }
            continue;
          }
          // Atualiza preço com o given real do PDP
          const unitAfter =
            Math.round(
              (deal.price - conf.coupon.givenDiscount / Math.max(1, conf.coupon.qty)) *
                100,
            ) / 100;
          if (unitAfter > 0 && unitAfter + 0.5 < deal.price) {
            getDb()
              .prepare(
                `UPDATE deals SET price_with_coupon = ?, coupon_status = 'valid' WHERE id = ?`,
              )
              .run(unitAfter, deal.id);
            deal = getDb()
              .prepare("SELECT * FROM deals WHERE id = ?")
              .get(deal.id) as Deal;
          }
        }
      } catch (err) {
        logAntiBan(
          "pre_post_pdp_coupon_confirm_err",
          err instanceof Error ? err.message : String(err),
        );
      }

      const retest = await applyCouponTestToDeal(deal.id);
      if (
        !retest.ok ||
        retest.status === "invalid" ||
        retest.status === "expired"
      ) {
        const { isTransientCouponFail } = await import("./couponLiveCheck.js");
        if (
          retest.status === "pending" ||
          isTransientCouponFail(retest.detail || "")
        ) {
          details.push(
            `${group.name}: cupom inconclusivo (${retest.detail}) — tenta outra oferta`,
          );
          continue;
        }
        markDeal(deal.id, "skipped");
        logPost({
          dealId: deal.id,
          groupId: group.id,
          messageHash: "",
          ok: false,
          reason: `cupom inválido/expirado: ${retest.detail}`,
        });
        const fresh = getDb()
          .prepare("SELECT * FROM deals WHERE id = ?")
          .get(deal.id) as Deal;
        await notifyCouponExpired(fresh, retest.detail);
        details.push(`${group.name}: cupom inválido`);
        continue;
      }
      deal = getDb()
        .prepare("SELECT * FROM deals WHERE id = ?")
        .get(deal.id) as Deal;
    }

    const gate = explainSkipDeal(deal, group);
    if (gate.skip) {
      if (gate.markSkipped) markDeal(deal.id, "skipped");
      logPost({
        dealId: deal.id,
        groupId: group.id,
        messageHash: "",
        ok: false,
        reason: gate.reason,
      });
      details.push(
        `${group.name}: ${gate.reason} — “${deal.title.slice(0, 36)}”`,
      );
      continue;
    }

    // Meta do cupom: só texto que cite o código (nunca description genérica do produto /
    // “R$10 OFF por seguir loja”, que contaminava MELIACHA).
    if (deal.coupon) {
      const code = String(deal.coupon).trim().toUpperCase();
      const blob = String(deal.description || "");
      if (blob.toUpperCase().includes(code)) {
        enrichCouponMetaFromText(code, blob);
      }
      const rule = resolveCouponRuleForDeal(deal);
      const savings = evaluateCouponSavings(deal);
      if (!savings.ok) {
        logPost({
          dealId: deal.id,
          groupId: group.id,
          messageHash: "",
          ok: false,
          reason: savings.reason,
        });
        details.push(
          `${group.name}: ${savings.reason} — “${deal.title.slice(0, 36)}”`,
        );
        continue;
      }
      if (rule && savings.ok && savings.qty > 1 && savings.unitAfter != null) {
        const quote = quoteCouponCart(resolveDealPrices(deal).listed, rule, {
          maxQty: 6,
        });
        if (quote.ok) {
          const tip = formatCouponQtyDescBit(quote);
          let description = scrubCouponDescTips(String(deal.description || ""));
          if (tip && !/leve\s+\d+\s+un/i.test(description)) {
            if (/Cupom ML:|Desconto ML/i.test(description)) {
              description = description.replace(
                /(Cupom ML:[^\n]*|Desconto ML[^\n]*)/i,
                `$1${tip}`,
              );
            } else {
              description = `${description}\nCupom ML: ${deal.coupon}${tip}`.trim();
            }
          }
          getDb()
            .prepare(
              `UPDATE deals SET description = ?, price_with_coupon = ? WHERE id = ?`,
            )
            .run(description, savings.unitAfter, deal.id);
        }
      } else if (savings.ok && savings.unitAfter != null) {
        getDb()
          .prepare(`UPDATE deals SET price_with_coupon = ? WHERE id = ?`)
          .run(savings.unitAfter, deal.id);
      }
    }

    // Última palavra no centavo: badge PDP “com Cupom” (qty 1).
    // Evita 89,90 calculado vs 89,91 exibido no ML.
    if (pdpHtml && deal.coupon) {
      try {
        const { extractMlComCupomPrice } = await import("./priceRefresh.js");
        const badge = extractMlComCupomPrice(pdpHtml);
        deal = getDb()
          .prepare("SELECT * FROM deals WHERE id = ?")
          .get(deal.id) as Deal;
        if (
          badge != null &&
          badge + 0.009 < deal.price &&
          badge >= deal.price * 0.55
        ) {
          const pack = parseCouponPackFromDescription(deal.description);
          const rule = resolveCouponRuleForDeal(deal);
          const q = rule
            ? quoteCouponCart(resolveDealPrices(deal).listed, rule, {
                maxQty: 6,
              })
            : null;
          const multi =
            (pack.qty > 1 ? pack.qty : 0) > 1 || (q?.ok && q.qty > 1);
          if (!multi) {
            getDb()
              .prepare(`UPDATE deals SET price_with_coupon = ? WHERE id = ?`)
              .run(badge, deal.id);
          }
        }
      } catch {
        /* badge opcional */
      }
    }

    const repost = wasProductPostedRecently(group.id, {
      dealId: deal.id,
      externalId: deal.external_id,
      title: deal.title,
    });
    if (repost.blocked) {
      logPost({
        dealId: deal.id,
        groupId: group.id,
        messageHash: "",
        ok: false,
        reason: repost.reason,
      });
      details.push(`${group.name}: ${repost.reason}`);
      continue;
    }

    await ensureDealImage(deal.id);
    const fresh = getDb()
      .prepare("SELECT * FROM deals WHERE id = ?")
      .get(deal.id) as Deal;
    if (!String(fresh.image_url || "").trim()) {
      markDeal(fresh.id, "skipped");
      logPost({
        dealId: fresh.id,
        groupId: group.id,
        messageHash: "",
        ok: false,
        reason: "oferta sem foto",
      });
      details.push(`${group.name}: sem foto — não posta “${fresh.title.slice(0, 36)}”`);
      continue;
    }
    const composed = composePromo(fresh, group);
    const text = composed.text;
    const messageHash = hashMessage(`${group.jid}:${text}`);

    const perMsg = canSendNow({
      messageHash,
      groupsInWave: 1,
      groupId: group.id,
      manual,
      withinWave: true,
      shortDelay: true,
      couponBurst,
      priorityCoupon: couponBurst,
    });
    if (!perMsg.allow) {
      details.push(`${group.name}: ${perMsg.reason}`);
      break;
    }

    // Jitter curto (segundos) — o intervalo 12–20 min vem do last_posted_at do grupo
    await sleep(perMsg.delayMs);

    try {
      const fleet = fleetForGroup(group);
      const brand = resolveGroupBrand({
        name: group.name,
        categories: group.categories,
        watermark_handle:
          group.watermark_handle || fleet?.watermark_handle || "",
        watermark_tagline:
          group.watermark_tagline || fleet?.watermark_tagline || "",
      });
      const handle = brand.handle;
      const tagline = brand.tagline;

      let sendMeta: { jid: string; redirectedFrom?: string; waKey?: string | null };
      let withImage = false;
      if (fresh.image_url) {
        try {
          const image = await watermarkProductImage({
            imageUrl: fresh.image_url,
            handle,
            tagline,
            groupName: group.name,
            category: group.categories,
            layout:
              String(
                (group as WaGroup & { image_layout?: string }).image_layout ||
                  "auto",
              ).trim() || "auto",
            discountPct: resolveDealPrices(fresh).discountPct,
            inviteUrl:
              String(
                (group as WaGroup & { promo_url?: string | null }).promo_url ||
                  "",
              ).trim() ||
              group.invite_link ||
              null,
            logoPath:
              groupLogoPath(group.id) || group.watermark_logo_path || null,
          });
          if (text.length > 280) await sleep(randomBetween(1800, 4200));
          sendMeta = await sendGroupImage(group.jid, image, text);
          withImage = true;
        } catch (imgErr) {
          const imgMsg =
            imgErr instanceof Error ? imgErr.message : String(imgErr);
          sendMeta = await sendGroupText(group.jid, text);
          details.push(
            `${group.name}: imagem falhou (${imgMsg.slice(0, 60)}) — texto ok`,
          );
        }
      } else {
        sendMeta = await sendGroupText(group.jid, text);
      }

      if (sendMeta.redirectedFrom && sendMeta.jid !== group.jid) {
        getDb()
          .prepare(
            `UPDATE wa_groups SET jid = ?, notes = ? WHERE id = ?`,
          )
          .run(
            sendMeta.jid,
            `Comunidade WhatsApp (community_announce) · auto-corrigido`,
            group.id,
          );
      }

      logPost({
        dealId: fresh.id,
        groupId: group.id,
        messageHash,
        ok: true,
        reason: sendMeta.redirectedFrom
          ? `enviado no Avisos ${sendMeta.jid}`
          : "enviado",
        waKey: sendMeta.waKey,
        headlineVariant: composed.headlineVariant,
      });
      markDealPostedForGroup(fresh, group.id);
      touchGroup(group.id);
      // Só marca onda APÓS envio OK (antes bloqueava o próprio send)
      markWaveStarted(1);
      sent += 1;
      clearHttpBlockStreak();
      details.push(
        `${group.name}: enviou “${fresh.title.slice(0, 40)}”${
          withImage ? " (com imagem)" : " (só texto)"
        }${sendMeta.redirectedFrom ? " → canal de Avisos" : ""}`,
      );
      if (sent >= maxPosts) break;
      continue;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      markDeal(deal.id, "failed");
      logPost({
        dealId: deal.id,
        groupId: group.id,
        messageHash,
        ok: false,
        reason: msg,
      });
      details.push(`${group.name}: erro — ${msg}`);
      touchWaveClock();
      if (/ban/i.test(msg)) {
        pauseSending(180, `erro de envio: ${msg}`);
        break;
      }
      const httpSt = /403/.test(msg) ? 403 : /429|rate/i.test(msg) ? 429 : 0;
      if (httpSt) noteHttpBlockError(httpSt, msg);
      break;
    }
    } // candidatos
    if (sent >= maxPosts) break;
    // Grupo sem envio (fila com cupom inválido no PDP): passa ao próximo sem rajada.
  }

  return { attempted: groupsTried, sent, details };
}

/** Depois do aviso de cupom: várias ofertas afiliadas daquele código no mesmo grupo. */
export async function publishCouponFollowups(opts: {
  group: WaGroup;
  couponCode: string;
  count?: number;
  manual?: boolean;
}): Promise<{ sent: number; details: string[] }> {
  const count = Math.max(3, Math.min(8, Number(opts.count) || 6));
  const result = await runPublishWave({
    manual: true,
    ignoreGroupInterval: true,
    skipRevalidate: true,
    forceGroupId: opts.group.id,
    preferCoupon: String(opts.couponCode || "").trim(),
    maxPosts: count,
    couponBurst: true,
  });
  logAntiBan(
    "coupon_followups",
    `${opts.couponCode} group=${opts.group.id} sent=${result.sent} ${result.blockedReason || result.details?.[0] || ""}`,
  );
  return { sent: result.sent, details: result.details || [] };
}

export function previewDealMessage(deal: Deal, group?: WaGroup | null): string {
  return composePromoMessage(deal, group);
}
