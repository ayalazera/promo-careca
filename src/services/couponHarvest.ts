/**
 * Coleta cupom-primeiro: pega produtos que JÁ estão na lista do cupom,
 * grava preço vivo, testa o código e só então entra na fila de post.
 *
 * Por que essa ordem: produto-primeiro (Hub) e “torcer” para o cupom
 * aplicar gerava posts sem cupom ou com código que não caía no checkout.
 */
import { getDb, logAntiBan } from "../db/index.js";
import { upsertDeals } from "./affiliates.js";
import { classifyProduct } from "./categories.js";
import {
  couponTargetCategories,
  recentAnnouncedCouponCodes,
} from "./couponCategories.js";
import { getMercadoLivreCreds } from "./credentialVault.js";
import {
  isDigitableCouponCode,
  listStoredCoupons,
  type MlCoupon,
} from "./mlCoupons.js";
import { createAffiliateLink, withCouponCampaign } from "./mlHub.js";
import { extractStoreProductsFromHtml } from "./mlOfficialStores.js";
import {
  isPlausibleProductPrice,
} from "./priceSanity.js";
import {
  formatCouponQtyDescBit,
  quoteCouponCart,
} from "./couponPricing.js";
import { refreshDealLivePrice } from "./priceRefresh.js";
import { categoryPriceCap } from "./dealQuality.js";
import { isUnwantedPromoTitle } from "./queueSanitize.js";
import { isPartyCardGame } from "./tcgFilter.js";
import { isLowDemandNicheTitle } from "./demandFilter.js";
import { recentTipNewCodes } from "./couponTipDiscovery.js";
import {
  harvestMaxCoupons,
  harvestMaxItems,
  harvestMintLinks,
  isElectronicsFamily,
  offerAttractScore,
} from "./queueVolume.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

function listHeaders(): HeadersInit {
  const c = getMercadoLivreCreds();
  return {
    Accept: "text/html,application/xhtml+xml",
    "Accept-Language": "pt-BR,pt;q=0.9",
    "User-Agent": UA,
    Cookie: c.hubCookie || "",
    "x-csrf-token": c.hubCsrf || "",
    Referer: "https://www.mercadolivre.com.br/cupons",
  };
}

function couponListUrl(coupon: MlCoupon): string {
  if (coupon.listUrl) return coupon.listUrl;
  return `https://lista.mercadolivre.com.br/_Container_${coupon.campaignId}?coupon_campaign_id=${coupon.campaignId}`;
}

/** URLs candidatas — tips (SUPERPROMO etc.) costumam ter Container vazio. */
function couponListUrlCandidates(coupon: MlCoupon): string[] {
  const id = String(coupon.campaignId || "").trim();
  const out: string[] = [];
  const push = (u: string | null | undefined) => {
    const s = String(u || "").trim();
    if (s && !out.includes(s)) out.push(s);
  };
  push(coupon.listUrl);
  if (id) {
    push(
      `https://lista.mercadolivre.com.br/_Container_${id}?coupon_campaign_id=${id}`,
    );
    push(
      `https://lista.mercadolivre.com.br/_Container_aff-list?coupon_campaign_id=${id}`,
    );
  }
  return out;
}

/**
 * Cupons tip (“produtos selecionados”) não têm lista HTML.
 * Varre ofertas + fila e aplica só se o código aparecer no PDP do item.
 */
export async function seedDealsForCouponViaPdp(opts: {
  coupon: MlCoupon;
  maxScan?: number;
  maxApply?: number;
  mintLinks?: number;
}): Promise<{ scanned: number; applied: number; linked: number; detail: string }> {
  const code = String(opts.coupon.code || "").toUpperCase();
  const campaignId = String(opts.coupon.campaignId || "");
  if (!code || !campaignId) {
    return { scanned: 0, applied: 0, linked: 0, detail: "cupom sem código" };
  }
  const maxScan = Math.max(8, Math.min(60, opts.maxScan ?? 36));
  const maxApply = Math.max(2, Math.min(24, opts.maxApply ?? 12));
  let mintLeft = Math.max(0, Math.min(24, opts.mintLinks ?? 10));

  const { fetchPdpItemCoupons } = await import("./mlCoupons.js");
  const { extractStoreProductsFromHtml } = await import("./mlOfficialStores.js");
  const candidates: Array<{
    itemId: string;
    title: string;
    price: number;
    oldPrice: number | null;
    productUrl: string;
    imageUrl: string | null;
  }> = [];
  const seen = new Set<string>();

  const pushCand = (c: {
    itemId: string;
    title?: string;
    price?: number | null;
    oldPrice?: number | null;
    productUrl?: string;
    imageUrl?: string | null;
  }) => {
    const id = String(c.itemId || "")
      .replace(/^hubauto-/i, "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
    if (!/^MLB\d{6,}$/.test(id) || seen.has(id)) return;
    if (isLowDemandNicheTitle(c.title || "")) return;
    seen.add(id);
    candidates.push({
      itemId: id,
      title: String(c.title || `Produto ${id}`).slice(0, 180),
      price: Number(c.price) || 0,
      oldPrice: c.oldPrice != null ? Number(c.oldPrice) : null,
      productUrl:
        c.productUrl ||
        `https://produto.mercadolivre.com.br/${id.replace(/^MLB/i, "MLB-")}`,
      imageUrl: c.imageUrl || null,
    });
  };

  // 1) Ofertas ML (pool amplo para achar “selecionados”)
  try {
    const res = await fetch(
      "https://www.mercadolivre.com.br/ofertas",
      {
        headers: listHeaders(),
        redirect: "follow",
        signal: AbortSignal.timeout(20000),
      },
    );
    if (res.ok) {
      for (const p of extractStoreProductsFromHtml(await res.text())) {
        pushCand(p);
      }
    }
  } catch {
    /* segue com a fila local */
  }

  // 2) Fila local com meli.la (já postáveis se o cupom bater no PDP)
  try {
    const rows = getDb()
      .prepare(
        `SELECT external_id, title, price, old_price, product_url, image_url
         FROM deals
         WHERE source = 'mercadolivre'
           AND status IN ('queued', 'hold_coupon')
           AND affiliate_url LIKE '%meli.la%'
         ORDER BY id DESC
         LIMIT 80`,
      )
      .all() as Array<{
      external_id: string;
      title: string;
      price: number;
      old_price: number | null;
      product_url: string;
      image_url: string | null;
    }>;
    for (const r of rows) {
      pushCand({
        itemId: r.external_id,
        title: r.title,
        price: r.price,
        oldPrice: r.old_price,
        productUrl: r.product_url,
        imageUrl: r.image_url,
      });
    }
  } catch {
    /* ignore */
  }

  let scanned = 0;
  let applied = 0;
  let linked = 0;

  for (const cand of candidates.slice(0, maxScan)) {
    if (applied >= maxApply) break;
    scanned += 1;
    const unitPrice =
      cand.price > 0
        ? cand.price
        : cand.oldPrice && cand.oldPrice > 0
          ? cand.oldPrice
          : 0;
    if (!(unitPrice > 0)) continue;
    let hits: Awaited<ReturnType<typeof fetchPdpItemCoupons>> = [];
    try {
      hits = await fetchPdpItemCoupons({
        itemId: cand.itemId,
        unitPrice,
      });
    } catch {
      continue;
    }
    const hit = hits.find(
      (c) =>
        c.source === "tracking" &&
        (String(c.code || "").toUpperCase() === code ||
          String(c.campaignId || "") === campaignId) &&
        c.hasItems !== false &&
        Number(c.givenDiscount) > 0,
    );
    if (!hit) {
      continue;
    }

    const productUrl = withCouponCampaign(cand.productUrl, campaignId);
    upsertDeals([
      {
        external_id: cand.itemId,
        source: "mercadolivre",
        title: cand.title,
        description: `Cupom ML: ${code} · campanha ${campaignId} · via PDP`,
        category: categoryForCouponProduct(
          opts.coupon,
          cand.title,
          productUrl,
        ),
        price: unitPrice,
        old_price: cand.oldPrice,
        currency: "BRL",
        coupon: code,
        image_url: cand.imageUrl,
        product_url: productUrl,
        affiliate_url: productUrl,
        commission_pct: null,
      },
    ]);
    const deal = getDb()
      .prepare(
        `SELECT id, price FROM deals WHERE source = 'mercadolivre' AND external_id = ?`,
      )
      .get(cand.itemId) as { id: number; price: number } | undefined;
    if (!deal) continue;

    try {
      await refreshDealLivePrice(deal.id);
    } catch {
      /* ok */
    }
    const live = getDb()
      .prepare(`SELECT price, old_price FROM deals WHERE id = ?`)
      .get(deal.id) as { price: number; old_price: number | null } | undefined;
    const price = live?.price || deal.price || unitPrice;
    const qty = Math.max(1, Number(hit.qty) || 1);
    const unitAfter =
      Math.round((price - Number(hit.givenDiscount) / qty) * 100) / 100;
    if (
      !(unitAfter > 0) ||
      unitAfter + 0.009 >= price ||
      unitAfter < price * 0.55
    ) {
      continue;
    }

    getDb()
      .prepare(
        `UPDATE deals SET
           coupon = ?,
           coupon_status = 'valid',
           price_with_coupon = ?,
           coupon_tested_at = datetime('now'),
           product_url = ?,
           description = ?,
           status = 'queued'
         WHERE id = ?`,
      )
      .run(
        code,
        unitAfter,
        productUrl,
        `Cupom ML: ${hit.title || code} · código ${code} · campanha ${campaignId} · PDP`,
        deal.id,
      );
    applied += 1;

    const fresh = getDb()
      .prepare(`SELECT affiliate_url, product_url FROM deals WHERE id = ?`)
      .get(deal.id) as
      | { affiliate_url: string; product_url: string }
      | undefined;
    if (
      mintLeft > 0 &&
      fresh &&
      !/meli\.la\//i.test(fresh.affiliate_url || "")
    ) {
      try {
        const link = await createAffiliateLink(fresh.product_url, {
          couponCampaignId: campaignId,
        });
        if (link.shortUrl) {
          getDb()
            .prepare(`UPDATE deals SET affiliate_url = ? WHERE id = ?`)
            .run(link.shortUrl, deal.id);
          linked += 1;
          mintLeft -= 1;
        }
      } catch {
        /* próxima onda */
      }
    }
    await new Promise((r) => setTimeout(r, 120));
  }

  const detail = `pdp-scan scan=${scanned} apply=${applied} link=${linked}`;
  logAntiBan("coupon_pdp_seed", `${code} ${detail}`);
  return { scanned, applied, linked, detail };
}

/** Cupons âncora por nicho — garante fila TCG/eletrônicos/moda/casa. */
const NICHE_ANCHORS: string[][] = [
  ["BRINQUEDOS", "BRINCAR", "JOGOS"],
  ["TECHEMCASA", "ECONOMIAML", "CASAINTELIGENTE", "TECHTUDO"],
  ["SEMPREMODA", "SEMPRENAMODA", "MODANOMELI", "MODACUPONEIRA"],
  ["COMPRINHASPRACASA", "OFFMELI"],
];

function pickCouponsToHarvest(
  limit: number,
  preferCodes?: string[],
): MlCoupon[] {
  const active = listStoredCoupons(120).filter(
    (c) =>
      String(c.status).toUpperCase() === "ACTIVE" &&
      isDigitableCouponCode(c.code) &&
      c.testedOk !== 0,
  );
  const prefer = new Set(
    (preferCodes || [])
      .map((c) => String(c || "").trim().toUpperCase())
      .filter(Boolean),
  );
  if (prefer.size) {
    const forced = active.filter((c) =>
      prefer.has(String(c.code || "").toUpperCase()),
    );
    if (forced.length) return forced.slice(0, limit);
  }
  const featured = new Set<string>();
  try {
    const groups = getDb()
      .prepare(`SELECT id FROM wa_groups WHERE active = 1`)
      .all() as Array<{ id: number }>;
    for (const g of groups) {
      for (const code of recentAnnouncedCouponCodes(g.id, 48)) {
        featured.add(code.toUpperCase());
      }
    }
  } catch {
    /* tabela pode não existir ainda */
  }
  const tipNew = new Set(recentTipNewCodes());
  const rank = (c: MlCoupon): number => {
    const code = String(c.code || "").toUpperCase();
    if (tipNew.has(code)) return -1;
    if (featured.has(code)) return 0;
    if (/^LIBROS|^LIVROS|^JOGOS|^GAMES|^LEITOR/i.test(code)) return 0;
    if (
      [
        "SEMPREMODA",
        "SEMPRENAMODA",
        "BRINQUEDOS",
        "OFFMELI",
        "COMPRINHASPRACASA",
        "ECONOMIAML",
        "PREFERIDO",
        "APROVEITA",
        "CORREPROMELI",
        "CASAINTELIGENTE",
        "TECHEMCASA",
        "MODANOMELI",
      ].includes(code)
    ) {
      return 1;
    }
    return 2;
  };
  const sorted = [...active].sort((a, b) => rank(a) - rank(b));
  const out: MlCoupon[] = [];
  const seen = new Set<string>();
  const push = (c: MlCoupon | undefined) => {
    if (!c || out.length >= limit) return;
    const code = String(c.code || "").toUpperCase();
    if (!code || seen.has(code)) return;
    seen.add(code);
    out.push(c);
  };
  // 1º: um cupom por nicho (TCG / tech / moda / casa)
  for (const group of NICHE_ANCHORS) {
    const hit = sorted.find((c) =>
      group.includes(String(c.code || "").toUpperCase()),
    );
    push(hit);
  }
  for (const c of sorted) push(c);
  return out;
}

/** Produto veio da lista do cupom — aplica a regra oficial e marca valid. */
export function applyListCouponToDeal(dealId: number, coupon: MlCoupon): boolean {
  const deal = getDb()
    .prepare(
      `SELECT id, price, old_price, title, description FROM deals WHERE id = ?`,
    )
    .get(dealId) as
    | {
        id: number;
        price: number;
        old_price: number | null;
        title: string;
        description: string;
      }
    | undefined;
  if (
    !deal ||
    !isPlausibleProductPrice(deal.price, { reference: deal.old_price })
  ) {
    return false;
  }
  const quote = quoteCouponCart(deal.price, coupon, { maxQty: 6 });
  if (!quote.ok) return false;
  const code = String(coupon.code || "").toUpperCase();
  const final = quote.unitAfter;
  if (!isPlausibleProductPrice(final, { reference: deal.price })) return false;
  if (final + 0.009 >= deal.price) return false;

  const qtyTip = formatCouponQtyDescBit(quote);
  const descExtra = `Cupom ML: ${coupon.title} · código ${code} · campanha ${coupon.campaignId}${qtyTip}`;
  const description = /Cupom ML:|Desconto ML/i.test(deal.description)
    ? deal.description
        .replace(/Cupom ML:.*$/m, descExtra)
        .replace(/Desconto ML.*$/m, descExtra)
    : `${deal.description}\n${descExtra}`.trim();

  getDb()
    .prepare(
      `UPDATE deals SET
         coupon = ?,
         coupon_status = 'valid',
         price_with_coupon = ?,
         coupon_tested_at = datetime('now'),
         description = ?,
         status = CASE WHEN status = 'posted' THEN status ELSE 'queued' END
       WHERE id = ?`,
    )
    .run(code, final, description, dealId);

  try {
    getDb()
      .prepare(
        `INSERT INTO deal_coupon_matches (deal_id, campaign_id, code, title, score, validated, detail, updated_at)
         VALUES (?, ?, ?, ?, 95, 1, ?, datetime('now'))
         ON CONFLICT(deal_id) DO UPDATE SET
           campaign_id=excluded.campaign_id,
           code=excluded.code,
           title=excluded.title,
           score=excluded.score,
           validated=1,
           detail=excluded.detail,
           updated_at=datetime('now')`,
      )
      .run(
        dealId,
        coupon.campaignId,
        code,
        coupon.title,
        `lista contém id do produto (${coupon.campaignId}); harvest ${code}`,
      );
  } catch {
    /* tabela opcional */
  }
  return true;
}

function categoryForCouponProduct(coupon: MlCoupon, title: string, url: string): string {
  const targets = couponTargetCategories(coupon);
  const classified = classifyProduct({
    title,
    productUrl: url,
    categoryHint: targets[0] || null,
  });
  if (targets.length && targets.includes(classified)) return classified;
  if (targets.length === 1) return targets[0];
  return classified || "geral";
}

export async function ingestDealsFromCouponLists(opts?: {
  maxCoupons?: number;
  maxItemsPerCoupon?: number;
  mintLinks?: number;
  /** Colhe só estes códigos (ex.: logo após anunciar APROVEITA). */
  preferCodes?: string[];
}): Promise<{
  coupons: number;
  products: number;
  tested: number;
  linked: number;
  details: string[];
}> {
  const maxCoupons = harvestMaxCoupons(opts?.maxCoupons);
  const maxItems = harvestMaxItems(opts?.maxItemsPerCoupon);
  const mintBudget = harvestMintLinks(
    opts?.mintLinks ??
      (opts?.preferCodes?.length ? Math.max(8, harvestMintLinks() / 2) : undefined),
  );
  const coupons = pickCouponsToHarvest(maxCoupons, opts?.preferCodes);
  const details: string[] = [];
  let products = 0;
  let tested = 0;
  let linked = 0;
  let mintLeft = mintBudget;

  const queuedByCat = (() => {
    try {
      const rows = getDb()
        .prepare(
          `SELECT lower(category) AS c, COUNT(*) AS n FROM deals
           WHERE status = 'queued' AND coupon_status = 'valid'
           GROUP BY lower(category)`,
        )
        .all() as Array<{ c: string; n: number }>;
      const m = new Map<string, number>();
      for (const r of rows) m.set(r.c || "geral", r.n);
      return m;
    } catch {
      return new Map<string, number>();
    }
  })();
  const mintPriority = (cat: string): number => {
    const c = String(cat || "geral").toLowerCase();
    const n = queuedByCat.get(c) || 0;
    if (c === "tcg") return n < 12 ? 0 : 3;
    if (isElectronicsFamily(c)) return n < 12 ? 1 : 3;
    return n < 20 ? 2 : 4;
  };

  for (const coupon of coupons) {
    const code = String(coupon.code || "").toUpperCase();
    let items: ReturnType<typeof extractStoreProductsFromHtml> = [];
    let listSource = "";
    for (const url of couponListUrlCandidates(coupon)) {
      try {
        const res = await fetch(url, {
          headers: listHeaders(),
          redirect: "follow",
          signal: AbortSignal.timeout(20000),
        });
        if (!res.ok) continue;
        const html = await res.text();
        const found = extractStoreProductsFromHtml(html)
          .filter((p) => p.itemId && p.title && p.title.length >= 8);
        if (found.length) {
          items = found;
          listSource = url.includes("aff-list")
            ? "aff-list"
            : url.includes("Container")
              ? "container"
              : "lista";
          break;
        }
      } catch {
        /* tenta próxima URL */
      }
    }
    items = items
      .sort(
        (a, b) =>
          offerAttractScore({
            price: b.price,
            oldPrice: b.oldPrice,
            title: b.title,
          }) -
          offerAttractScore({
            price: a.price,
            oldPrice: a.oldPrice,
            title: a.title,
          }),
      )
      .slice(0, maxItems);

    // Tips sem lista: chove produtos via PDP (código no anúncio)
    if (!items.length) {
      try {
        const seeded = await seedDealsForCouponViaPdp({
          coupon,
          maxScan: Math.max(24, maxItems * 2),
          maxApply: maxItems,
          mintLinks: Math.min(mintLeft, Math.max(6, Math.ceil(maxItems * 0.7))),
        });
        products += seeded.applied;
        tested += seeded.applied;
        linked += seeded.linked;
        mintLeft = Math.max(0, mintLeft - seeded.linked);
        details.push(
          seeded.applied
            ? `${code}: ${seeded.detail}`
            : `${code}: lista vazia e PDP sem hit (${seeded.detail})`,
        );
      } catch (err) {
        details.push(
          `${code}: lista vazia · seed falhou (${err instanceof Error ? err.message : String(err)})`,
        );
      }
      continue;
    }

    const incoming = items
      .map((p) => {
      const productUrl = withCouponCampaign(
        p.productUrl ||
          `https://produto.mercadolivre.com.br/${p.itemId.replace(/^MLB/i, "MLB-")}`,
        coupon.campaignId,
      );
      return {
        external_id: p.itemId,
        source: "mercadolivre",
        title: p.title,
        description: `Cupom ML: ${code} · campanha ${coupon.campaignId}`,
        category: categoryForCouponProduct(coupon, p.title, productUrl),
        price: p.price || 0,
        old_price: p.oldPrice,
        currency: "BRL",
        coupon: code,
        image_url: p.imageUrl,
        product_url: productUrl,
        affiliate_url: productUrl,
        commission_pct: null,
      };
    })
      .filter((row) => {
        if (
          isUnwantedPromoTitle(row.title) ||
          isLowDemandNicheTitle(row.title) ||
          isPartyCardGame(row.title)
        ) {
          return false;
        }
        // Preço 0 = lista sem valor no HTML; refreshDealLivePrice completa depois.
        if (row.price > 0) {
          if (!isPlausibleProductPrice(row.price, { reference: row.old_price })) {
            return false;
          }
          if (row.price > categoryPriceCap(row.category)) {
            return false;
          }
        }
        return true;
      });
    if (!incoming.length) {
      details.push(`${code}: lista sem produto postável`);
      continue;
    }
    upsertDeals(incoming);
    products += incoming.length;

    const ordered = [...incoming].sort(
      (a, b) => mintPriority(a.category) - mintPriority(b.category),
    );

    for (const row of ordered) {
      const deal = getDb()
        .prepare(
          `SELECT id, affiliate_url FROM deals
           WHERE source = 'mercadolivre' AND external_id = ?`,
        )
        .get(row.external_id) as { id: number; affiliate_url: string } | undefined;
      if (!deal) continue;
      try {
        await refreshDealLivePrice(deal.id);
      } catch {
        /* preço vivo não bloqueia o teste */
      }
      const live = getDb()
        .prepare(`SELECT price, old_price FROM deals WHERE id = ?`)
        .get(deal.id) as { price: number; old_price: number | null } | undefined;
      if (!live || !isPlausibleProductPrice(live.price, { reference: live.old_price })) {
        continue;
      }
      try {
        if (applyListCouponToDeal(deal.id, coupon)) tested += 1;
      } catch (err) {
        logAntiBan(
          "coupon_harvest_test_err",
          err instanceof Error ? err.message : String(err),
        );
      }
      const fresh = getDb()
        .prepare(`SELECT affiliate_url, product_url FROM deals WHERE id = ?`)
        .get(deal.id) as { affiliate_url: string; product_url: string } | undefined;
      if (
        mintLeft > 0 &&
        fresh &&
        !/meli\.la\//i.test(fresh.affiliate_url || "")
      ) {
        try {
          const link = await createAffiliateLink(fresh.product_url, {
            couponCampaignId: coupon.campaignId,
          });
          if (link.shortUrl) {
            getDb()
              .prepare(`UPDATE deals SET affiliate_url = ? WHERE id = ?`)
              .run(link.shortUrl, deal.id);
            linked += 1;
            mintLeft -= 1;
          }
        } catch {
          /* anti-ban: próxima onda tenta de novo */
        }
      }
    }
    details.push(`${code}: +${items.length} da lista (${listSource || "ok"})`);
  }

  logAntiBan(
    "coupon_harvest",
    `coupons=${coupons.length} products=${products} tested=${tested} linked=${linked}`,
  );
  return {
    coupons: coupons.length,
    products,
    tested,
    linked,
    details,
  };
}
