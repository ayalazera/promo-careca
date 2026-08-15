/**
 * Atualiza preço do deal a partir do anúncio vivo no ML (PDP/HTML).
 * Só confia em pares price/original_price (evita lixo tipo 6400 de parcela).
 */
import { getMercadoLivreCreds } from "./credentialVault.js";
import { getDb, logAntiBan } from "../db/index.js";
import {
  applyPercentDiscount,
  isPlausibleProductPrice,
  looksLikeInstallmentTotal,
  roundMoney,
} from "./priceSanity.js";
import { normalizeItemId } from "./mlHub.js";
import { extractLowest30dFromHtml, ingestLiveHistory } from "./priceHistory.js";
import {
  ensureSoldQuantityColumn,
  extractSoldQuantityFromHtml,
} from "./demandFilter.js";
import { quoteCouponCart } from "./couponPricing.js";
import { isDigitableCouponCode } from "./mlCoupons.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

export type LivePrice = {
  price: number;
  oldPrice: number | null;
  source: string;
  lowest30d?: number | null;
  freeShipping?: boolean;
  stock?: number | null;
  sellerId?: string | null;
  sellerName?: string | null;
  logistic?: string | null;
  officialStore?: boolean;
  soldQuantity?: number | null;
  html?: string;
  /** Preço do badge ML “R$ X com Cupom” (fonte da verdade do centavo). */
  comCupomPrice?: number | null;
};

/**
 * Lê o valor do badge “{1} com Cupom” / COUPON_ACTIVE na PDP.
 * É o preço que o ML exibe com o cupom ativo — não recalcular com %.
 */
export function extractMlComCupomPrice(html: string): number | null {
  const text = String(html || "");
  if (text.length < 40) return null;
  const patterns = [
    /COUPON_ACTIVE[\s\S]{0,480}?"value"\s*:\s*(\d+(?:\.\d+)?)/i,
    /\{1\}\s*com Cupom[\s\S]{0,280}?"value"\s*:\s*(\d+(?:\.\d+)?)/i,
    /"value"\s*:\s*(\d+(?:\.\d+)?)[\s\S]{0,200}?com Cupom/i,
    /accessibility_text"\s*:\s*"Activaste el cup[oó]n"[\s\S]{0,120}?"value"\s*:\s*(\d+(?:\.\d+)?)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;
    const n = roundMoney(Number(m[1]));
    if (isPlausibleProductPrice(n)) return n;
  }
  return null;
}

function plausibleComCupom(
  comCupom: number | null | undefined,
  listed: number,
): number | null {
  const v = Number(comCupom);
  if (!isPlausibleProductPrice(v, { reference: listed })) return null;
  if (!(listed > 0) || v + 0.009 >= listed) return null;
  if (v < listed * 0.55) return null;
  return roundMoney(v);
}

function couponHeaders(): HeadersInit {
  const c = getMercadoLivreCreds();
  return {
    Accept: "text/html,application/xhtml+xml",
    "Accept-Language": "pt-BR,pt;q=0.9",
    "User-Agent": UA,
    Cookie: c.hubCookie || "",
    "x-csrf-token": c.hubCsrf || "",
    Referer: "https://www.mercadolivre.com.br/",
  };
}

/** Extrai só pares confiáveis ligados ao item — nunca o menor preço da página. */
function extractLivePrice(html: string, itemId?: string | null): LivePrice | null {
  const id = itemId ? String(itemId).toUpperCase().replace(/[^A-Z0-9]/g, "") : "";

  const parsePair = (
    chunk: string,
  ): { price: number; old: number | null } | null => {
    // UI VIP (bloco de preço VISÍVEL): value + original_value
    const ui = chunk.match(
      /"value"\s*:\s*(\d+(?:\.\d+)?)\s*,\s*"original_value"\s*:\s*(\d+(?:\.\d+)?)/,
    );
    if (ui) return { price: Number(ui[1]), old: Number(ui[2]) };
    const uiRev = chunk.match(
      /"original_value"\s*:\s*(\d+(?:\.\d+)?)\s*,\s*"value"\s*:\s*(\d+(?:\.\d+)?)/,
    );
    if (uiRev) return { price: Number(uiRev[2]), old: Number(uiRev[1]) };
    const a = chunk.match(
      /"price"\s*:\s*(\d+(?:\.\d+)?)\s*,\s*"original_price"\s*:\s*(\d+(?:\.\d+)?)/,
    );
    if (a) return { price: Number(a[1]), old: Number(a[2]) };
    const b = chunk.match(
      /"original_price"\s*:\s*(\d+(?:\.\d+)?)\s*,\s*"price"\s*:\s*(\d+(?:\.\d+)?)/,
    );
    if (b) return { price: Number(b[2]), old: Number(b[1]) };
    const c = chunk.match(
      /"currency_id"\s*:\s*"BRL"\s*,\s*"price"\s*:\s*(\d+(?:\.\d+)?)/,
    );
    if (c) return { price: Number(c[1]), old: null };
    const d = chunk.match(
      /"price"\s*:\s*(\d+(?:\.\d+)?)\s*,\s*"currency_id"\s*:\s*"BRL"/,
    );
    if (d) return { price: Number(d[1]), old: null };
    return null;
  };

  const candidates: Array<{ price: number; old: number | null; score: number }> =
    [];

  // Preferência: bloco de preço VISÍVEL da PDP (value/original_value)
  const visibleBlocks = [
    ...html.matchAll(
      /"id"\s*:\s*"price"\s*,\s*"type"\s*:\s*"price"\s*,\s*"state"\s*:\s*"VISIBLE"([\s\S]{0,900})/g,
    ),
  ];
  for (const m of visibleBlocks.slice(0, 4)) {
    const p = parsePair(m[1] || "");
    if (!p || !isPlausibleProductPrice(p.price, { reference: p.old })) continue;
    const old =
      p.old && isPlausibleProductPrice(p.old) ? roundMoney(p.old) : null;
    const price = roundMoney(p.price);
    if (old && looksLikeInstallmentTotal(old, price)) continue;
    candidates.push({
      price,
      old: old && !looksLikeInstallmentTotal(old, price) ? old : null,
      score: 200,
    });
  }

  if (id) {
    const upper = html.toUpperCase();
    let from = 0;
    let hits = 0;
    while (hits < 8) {
      const idx = upper.indexOf(id, from);
      if (idx < 0) break;
      const chunk = html.slice(Math.max(0, idx - 500), idx + 900);
      const p = parsePair(chunk);
      if (p && isPlausibleProductPrice(p.price, { reference: p.old })) {
        let score = 100 - hits;
        const old =
          p.old && isPlausibleProductPrice(p.old) ? roundMoney(p.old) : null;
        const price = roundMoney(p.price);
        if (old && looksLikeInstallmentTotal(old, price)) score -= 80;
        else if (old && old > price * 2.4) score -= 20;
        else if (old && old > price * 1.08 && old < price * 1.45) score += 12;
        candidates.push({
          price,
          old: old && !looksLikeInstallmentTotal(old, price) ? old : null,
          score,
        });
      }
      from = idx + id.length;
      hits += 1;
    }
  }

  // Fallback: primeiro par price/original no documento (produto principal do VIP)
  if (!candidates.length) {
    const p = parsePair(html.slice(0, Math.min(html.length, 180_000)));
    if (p && isPlausibleProductPrice(p.price, { reference: p.old })) {
      candidates.push({
        price: roundMoney(p.price),
        old: p.old && isPlausibleProductPrice(p.old) ? roundMoney(p.old) : null,
        score: 10,
      });
    }
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  const lowest30d = extractLowest30dFromHtml(html);
  const freeShipping =
    /"free_shipping"\s*:\s*true/.test(html) ||
    /"freeShipping"\s*:\s*true/.test(html);
  const stockM = html.match(/"available_quantity"\s*:\s*(\d+)/);
  const sellerIdM = html.match(/"seller_id"\s*:\s*(\d+)/);
  const sellerNameM = html.match(/"official_store_id"[^}]{0,200}"nickname"\s*:\s*"([^"]+)"/)
    || html.match(/"seller":\{[^}]{0,180}"nickname"\s*:\s*"([^"]+)"/);
  const logistic = /"logistic_type"\s*:\s*"fulfillment"|mercado\s*envios?\s*full|"fulfillment"\s*:\s*true/i.test(
    html,
  )
    ? "full"
    : /"logistic_type"\s*:\s*"xd_drop_off"|self_service|flex/i.test(html)
      ? "flex"
      : null;
  const officialStore = /"official_store_id"\s*:\s*[1-9]\d*/.test(html);
  const soldQuantity = extractSoldQuantityFromHtml(html);
  return {
    price: best.price,
    oldPrice: best.old,
    source: best.old != null ? "json_price_pair" : "json_price_only",
    lowest30d,
    freeShipping,
    stock: stockM ? Number(stockM[1]) : null,
    sellerId: sellerIdM ? sellerIdM[1] : null,
    sellerName: sellerNameM ? sellerNameM[1] : null,
    logistic,
    officialStore,
    soldQuantity,
  };
}

/** Aceita novo preço só se a variação for crível vs o que tínhamos. */
export function shouldAcceptLivePrice(opts: {
  before: number;
  after: number;
  oldPrice?: number | null;
  source: string;
}): boolean {
  const { before, after, oldPrice, source } = opts;
  if (!isPlausibleProductPrice(after, { reference: oldPrice })) return false;
  if (!(after > 0)) return false;

  // Sem histórico útil
  if (!isPlausibleProductPrice(before)) return true;

  const ratio = after / before;
  const beforeWasSuspicious =
    oldPrice != null &&
    isPlausibleProductPrice(oldPrice) &&
    before < oldPrice * 0.5;

  // html_candidates nunca (já nem geramos mais)
  if (source === "html_candidates") return false;

  // Preço antigo claramente defasado pra baixo (ex.: 27 vs 78) → aceita correção
  if (beforeWasSuspicious && ratio >= 1.05 && ratio <= 4) return true;

  // Hub deixou preço baixo demais sem old_price (ex.: 138 vs 460 real)
  if (
    source.startsWith("json_") &&
    ratio > 1.85 &&
    ratio <= 4.5 &&
    before > 0 &&
    after > before
  ) {
    return true;
  }

  // Variação normal de promo (±45%)
  if (ratio >= 0.55 && ratio <= 1.85) return true;

  // Subiu muito ou despencou demais → rejeita (provável parse errado)
  return false;
}

/** Tenta a API pública/oficial de itens (docs ML: GET /items/:id). */
async function fetchLivePriceFromItemsApi(
  itemId: string,
): Promise<LivePrice | null> {
  const id = normalizeItemId(itemId);
  if (!id) return null;
  const creds = getMercadoLivreCreds();
  const headers: HeadersInit = {
    Accept: "application/json",
    "User-Agent": UA,
  };
  if (creds.accessToken) {
    (headers as Record<string, string>).Authorization =
      `Bearer ${creds.accessToken}`;
  }
  try {
    const res = await fetch(`https://api.mercadolibre.com/items/${id}`, {
      headers,
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const item = (await res.json()) as {
      price?: number;
      base_price?: number;
      original_price?: number | null;
      available_quantity?: number;
      sold_quantity?: number;
      shipping?: { free_shipping?: boolean; logistic_type?: string };
      seller_id?: number;
      official_store_id?: number | null;
      status?: string;
    };
    if (item.status && item.status !== "active") return null;
    const price = Number(item.price ?? item.base_price);
    if (!isPlausibleProductPrice(price)) return null;
    const oldRaw = Number(item.original_price);
    const oldPrice =
      Number.isFinite(oldRaw) && oldRaw > price + 0.009
        ? roundMoney(oldRaw)
        : null;
    const logistic = String(item.shipping?.logistic_type || "").toLowerCase();
    return {
      price: roundMoney(price),
      oldPrice,
      source: "items_api",
      freeShipping: Boolean(item.shipping?.free_shipping),
      stock:
        item.available_quantity != null
          ? Number(item.available_quantity)
          : null,
      sellerId: item.seller_id != null ? String(item.seller_id) : null,
      logistic:
        logistic === "fulfillment"
          ? "full"
          : /flex|self_service|xd_drop_off/.test(logistic)
            ? "flex"
            : null,
      officialStore: Boolean(item.official_store_id),
      soldQuantity:
        item.sold_quantity != null ? Number(item.sold_quantity) : null,
    };
  } catch {
    return null;
  }
}

async function fetchProductHtml(opts: {
  productUrl?: string | null;
  externalId?: string | null;
}): Promise<{ html: string; itemId: string | null } | null> {
  const itemId =
    normalizeItemId(opts.externalId) || normalizeItemId(opts.productUrl);
  const urls: string[] = [];
  if (opts.productUrl) {
    urls.push(
      String(opts.productUrl)
        .replace(/[?&]coupon_campaign_id=[^&]+/g, "")
        .replace(/\?&/, "?")
        .replace(/\?$/, ""),
    );
  }
  if (itemId) {
    const dashed = itemId.replace(/^MLB/i, "MLB-");
    urls.push(`https://produto.mercadolivre.com.br/${dashed}`);
    urls.push(
      `https://www.mercadolivre.com.br/p/${itemId}?pdp_filters=item_id:${itemId}`,
    );
  }
  const seen = new Set<string>();
  for (const url of urls) {
    const u = url.split("#")[0];
    if (!u || seen.has(u)) continue;
    seen.add(u);
    try {
      const res = await fetch(u, {
        headers: couponHeaders(),
        redirect: "follow",
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) continue;
      const html = await res.text();
      if (html.length < 2000) continue;
      return { html, itemId };
    } catch {
      /* next */
    }
  }
  return null;
}

export async function fetchLiveMlPrice(opts: {
  productUrl?: string | null;
  externalId?: string | null;
  /** Se true, busca HTML mesmo com API (para ler “com Cupom”). */
  needHtml?: boolean;
}): Promise<LivePrice | null> {
  const itemId =
    normalizeItemId(opts.externalId) || normalizeItemId(opts.productUrl);

  // 1) API oficial (centavos corretos + sold_quantity quando disponível)
  let fromApi: LivePrice | null = null;
  if (itemId) {
    fromApi = await fetchLivePriceFromItemsApi(itemId);
  }

  const needHtml = opts.needHtml === true || !fromApi;
  if (!needHtml && fromApi) return fromApi;

  const page = await fetchProductHtml(opts);
  if (page) {
    const fromHtml = extractLivePrice(page.html, page.itemId || itemId);
    const comCupom = extractMlComCupomPrice(page.html);
    if (fromApi) {
      fromApi.html = page.html;
      fromApi.comCupomPrice = comCupom;
      return fromApi;
    }
    if (fromHtml) {
      fromHtml.html = page.html;
      fromHtml.comCupomPrice = comCupom;
      return fromHtml;
    }
  }
  return fromApi;
}

function loadCouponRule(
  dealId: number,
  couponCode?: string | null,
): {
  discountType: string;
  discountValue: number;
  minAmount: number | null;
  capAmount: number | null;
} | null {
  const match = getDb()
    .prepare(
      `SELECT c.discount_type, c.discount_value, c.cap_amount, c.min_amount, c.code
       FROM deal_coupon_matches m
       LEFT JOIN ml_coupons c ON c.campaign_id = m.campaign_id
       WHERE m.deal_id = ? AND m.validated = 1
       ORDER BY m.updated_at DESC LIMIT 1`,
    )
    .get(dealId) as
    | {
        discount_type: string | null;
        discount_value: number | null;
        cap_amount: number | null;
        min_amount: number | null;
        code: string | null;
      }
    | undefined;

  let rule = match;
  if ((!rule?.discount_type || !rule.discount_value) && couponCode) {
    const code = String(couponCode).trim().toUpperCase();
    if (isDigitableCouponCode(code)) {
      rule = getDb()
        .prepare(
          `SELECT discount_type, discount_value, cap_amount, min_amount, code
           FROM ml_coupons
           WHERE upper(trim(code)) = ? AND upper(status) = 'ACTIVE'
           ORDER BY updated_at DESC LIMIT 1`,
        )
        .get(code) as typeof match;
    }
  }
  if (!rule?.discount_type || !rule.discount_value) return null;
  return {
    discountType: String(rule.discount_type),
    discountValue: Number(rule.discount_value),
    minAmount: rule.min_amount != null ? Number(rule.min_amount) : null,
    capAmount: rule.cap_amount != null ? Number(rule.cap_amount) : null,
  };
}

function reestimateCouponQuote(
  dealId: number,
  price: number,
  couponCode?: string | null,
) {
  const rule = loadCouponRule(dealId, couponCode);
  if (!rule) return null;
  if (rule.discountType !== "percent" && rule.discountType !== "fixed") {
    return null;
  }
  const quote = quoteCouponCart(price, rule);
  return quote.ok ? quote : null;
}

function reestimateCouponPrice(
  dealId: number,
  price: number,
  couponCode?: string | null,
): number | null {
  const quote = reestimateCouponQuote(dealId, price, couponCode);
  if (quote) return quote.unitAfter;
  const rule = loadCouponRule(dealId, couponCode);
  if (!rule) return null;
  if (rule.discountType === "percent") {
    return applyPercentDiscount(price, rule.discountValue, rule.capAmount);
  }
  if (rule.discountType === "fixed") {
    return roundMoney(Math.max(0.01, price - rule.discountValue));
  }
  return null;
}

export async function refreshDealLivePrice(dealId: number): Promise<{
  ok: boolean;
  dealId: number;
  before: number;
  after: number | null;
  oldPrice: number | null;
  changed: boolean;
  detail: string;
  html?: string | null;
}> {
  const deal = getDb()
    .prepare(
      `SELECT id, price, old_price, price_with_coupon, product_url, external_id, coupon
       FROM deals WHERE id = ?`,
    )
    .get(dealId) as
    | {
        id: number;
        price: number;
        old_price: number | null;
        price_with_coupon: number | null;
        product_url: string;
        external_id: string;
        coupon: string | null;
      }
    | undefined;

  if (!deal) {
    return {
      ok: false,
      dealId,
      before: 0,
      after: null,
      oldPrice: null,
      changed: false,
      detail: "deal não encontrado",
    };
  }

  const live = await fetchLiveMlPrice({
    productUrl: deal.product_url,
    externalId: deal.external_id,
    // Com cupom: precisa do HTML do badge “com Cupom” (centavo exato do ML).
    needHtml: Boolean(deal.coupon && String(deal.coupon).trim()),
  });
  if (!live) {
    return {
      ok: false,
      dealId,
      before: deal.price,
      after: null,
      oldPrice: deal.old_price,
      changed: false,
      detail: "não foi possível ler preço vivo",
    };
  }

  const before = deal.price;
  const after = live.price;
  const accept = shouldAcceptLivePrice({
    before,
    after,
    oldPrice: live.oldPrice ?? deal.old_price,
    source: live.source,
  });
  if (!accept) {
    return {
      ok: true,
      dealId,
      before,
      after,
      oldPrice: live.oldPrice,
      changed: false,
      detail: `ignorado ${before}→${after} (${live.source})`,
      html: live.html || null,
    };
  }

  // Qualquer diferença de centavo conta (antes: 2,5% engolia 111→111,91).
  const absDelta = Math.abs(after - before);
  const priceChanged = !(before > 0) || absDelta >= 0.009;
  const oldPrice =
    live.oldPrice && live.oldPrice > after + 0.009
      ? live.oldPrice
      : deal.old_price && deal.old_price > after + 0.009
        ? deal.old_price
        : null;

  const oldMissing =
    (deal.old_price == null || !(deal.old_price > after + 0.009)) &&
    oldPrice != null &&
    oldPrice > after + 0.009;

  // Sempre recalcula cupom com o preço vivo aceito (centavos corretos).
  let priceWithCoupon = deal.price_with_coupon;
  const alreadyDeep =
    oldPrice != null &&
    isPlausibleProductPrice(oldPrice) &&
    after < oldPrice * 0.7;
  if (alreadyDeep) {
    // Preço vivo já é o “Por” da PDP — não reaplica % do cupom
    priceWithCoupon = null;
  } else {
    // 1) Badge ML “com Cupom” (ex.: 112,38 −20% → 89,91, não 89,90).
    const fromBadge = plausibleComCupom(live.comCupomPrice, after);
    const ruleQuote = reestimateCouponQuote(dealId, after, deal.coupon);
    const est = ruleQuote?.unitAfter ?? reestimateCouponPrice(dealId, after, deal.coupon);
    if (fromBadge != null && (!ruleQuote || ruleQuote.qty <= 1)) {
      priceWithCoupon = fromBadge;
    } else if (est != null && est < after - 0.009 && est >= after * 0.55) {
      priceWithCoupon = est;
    } else if (fromBadge != null) {
      priceWithCoupon = fromBadge;
    } else if (priceWithCoupon != null && priceWithCoupon >= after) {
      priceWithCoupon = null;
    }
  }

  const couponDelta =
    priceWithCoupon != null &&
    deal.price_with_coupon != null &&
    Math.abs(Number(priceWithCoupon) - Number(deal.price_with_coupon)) >= 0.009;
  const changed = priceChanged || oldMissing || Boolean(couponDelta);

  ensureSoldQuantityColumn();
  if (live.freeShipping) {
    getDb()
      .prepare(`UPDATE deals SET free_shipping = 1 WHERE id = ?`)
      .run(dealId);
  }
  getDb()
    .prepare(
      `UPDATE deals SET
         stock = COALESCE(?, stock),
         seller_id = COALESCE(?, seller_id),
         seller_name = COALESCE(?, seller_name),
         shipping_logistic = COALESCE(?, shipping_logistic),
         official_store = CASE WHEN ? = 1 THEN 1 ELSE official_store END,
         sold_quantity = COALESCE(?, sold_quantity)
       WHERE id = ?`,
    )
    .run(
      live.stock != null ? live.stock : null,
      live.sellerId || null,
      live.sellerName || null,
      live.logistic || null,
      live.officialStore ? 1 : 0,
      live.soldQuantity ?? null,
      dealId,
    );

  if (changed) {
    getDb()
      .prepare(
        `UPDATE deals SET
           price = ?,
           old_price = ?,
           price_with_coupon = ?,
           coupon_status = CASE
             WHEN ? = 1 AND coupon IS NOT NULL AND trim(coupon) != '' AND coupon_status = 'valid'
               THEN 'pending'
             ELSE coupon_status
           END
         WHERE id = ?`,
      )
      .run(
        after,
        oldPrice,
        priceWithCoupon,
        // Só força reteste se o cupom ainda não bate no preço vivo
        priceChanged &&
          (priceWithCoupon == null ||
            Math.abs(Number(priceWithCoupon) - after) < 0.009)
          ? 1
          : 0,
        dealId,
      );
    logAntiBan(
      "price_refresh",
      `deal=${dealId} ${before}→${after} cupom=${priceWithCoupon ?? "—"} (${live.source})`,
    );
  }

  const fresh = getDb()
    .prepare(
      `SELECT id, external_id, product_url, affiliate_url, price, price_with_coupon, coupon, old_price
       FROM deals WHERE id = ?`,
    )
    .get(dealId) as {
    id: number;
    external_id: string;
    product_url: string;
    affiliate_url: string;
    price: number;
    price_with_coupon: number | null;
    coupon: string | null;
    old_price: number | null;
  };
  if (fresh) {
    ingestLiveHistory(
      { ...fresh, seller_id: live.sellerId },
      {
        lowest30d: live.lowest30d,
        source: "price_refresh",
      },
    );
  }

  return {
    ok: true,
    dealId,
    before,
    after,
    oldPrice,
    changed,
    html: live.html || null,
    detail: priceChanged
      ? `atualizado ${before}→${after}`
      : oldMissing
        ? `old_price preenchido ${oldPrice}`
        : `ok ${after} (sem mudança relevante)`,
  };
}

/** Reverte updates ruins gravados como html_candidates (ou saltos absurdos). */
export function revertBadPriceRefreshes(): { reverted: number; ids: number[] } {
  const rows = getDb()
    .prepare(
      `SELECT detail FROM antiban_events
       WHERE event_type = 'price_refresh'
         AND (
           detail LIKE '%html_candidates%'
           OR detail LIKE '%→6400%'
           OR detail LIKE '%→4299%'
           OR detail LIKE '%→1620%'
           OR detail LIKE '%→561%'
         )
       ORDER BY id DESC LIMIT 80`,
    )
    .all() as Array<{ detail: string }>;

  const ids: number[] = [];
  const upd = getDb().prepare(
    `UPDATE deals SET price = ?, old_price = COALESCE(old_price, ?), price_with_coupon = NULL
     WHERE id = ?`,
  );

  for (const row of rows) {
    const m = row.detail.match(
      /deal=(\d+)\s+(\d+(?:\.\d+)?)→(\d+(?:\.\d+)?)/,
    );
    if (!m) continue;
    const id = Number(m[1]);
    const before = Number(m[2]);
    const after = Number(m[3]);
    if (!id || !(before > 0)) continue;
    // só reverte se ainda está no valor “depois” errado
    const cur = getDb()
      .prepare(`SELECT price FROM deals WHERE id = ?`)
      .get(id) as { price: number } | undefined;
    if (!cur) continue;
    if (Math.abs(cur.price - after) > 0.05) continue;
    upd.run(before, before, id);
    ids.push(id);
    logAntiBan("price_refresh_revert", `deal=${id} ${after}→${before}`);
  }
  return { reverted: ids.length, ids: [...new Set(ids)] };
}

/** Prioriza fila e deals com desconto suspeito (>55% vs old_price). */
export async function refreshQueuedDealPrices(opts?: {
  limit?: number;
}): Promise<{
  checked: number;
  updated: number;
  failed: number;
  skipped: number;
  results: Array<Awaited<ReturnType<typeof refreshDealLivePrice>>>;
}> {
  const limit = Math.max(1, Math.min(opts?.limit ?? 40, 80));
  const rows = getDb()
    .prepare(
      `SELECT id FROM deals
       WHERE status IN ('queued', 'hold_coupon')
       ORDER BY
         CASE
           WHEN old_price IS NULL AND price > 0 THEN 0
           WHEN old_price IS NOT NULL AND old_price > 0 AND price > 0
                AND price < old_price * 0.45 THEN 1
           WHEN coupon_status = 'valid' THEN 2
           ELSE 3
         END,
         id ASC
       LIMIT ?`,
    )
    .all(limit) as Array<{ id: number }>;

  const results: Array<Awaited<ReturnType<typeof refreshDealLivePrice>>> = [];
  let updated = 0;
  let failed = 0;
  let skipped = 0;
  for (const row of rows) {
    const r = await refreshDealLivePrice(row.id);
    results.push(r);
    if (!r.ok) failed += 1;
    else if (r.changed) updated += 1;
    else if (r.detail.startsWith("ignorado")) skipped += 1;
    await new Promise((res) => setTimeout(res, 350));
  }
  return { checked: rows.length, updated, failed, skipped, results };
}
