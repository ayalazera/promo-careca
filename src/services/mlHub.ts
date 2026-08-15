/**
 * Automação do Hub de Afiliados do Mercado Livre.
 *
 * O ML não publica API oficial de "GANHOS EXTRAS". Ferramentas reais usam a
 * sessão do navegador (Cookie + x-csrf-token + etiqueta) contra endpoints
 * internos do affiliate-program — o mesmo fluxo do Gerador de Links / Hub.
 *
 * Fluxo:
 * 1) Listar produtos do Hub (comissão / ganhos extras)
 * 2) Ordenar pelos maiores ganhos
 * 3) Gerar meli.la via createLink/createUrls
 * 4) Enfileirar para WhatsApp
 */
import {
  getMercadoLivreCreds,
} from "./credentialVault.js";
import { upsertDeals } from "./affiliates.js";
import { logAntiBan, getSetting, setSetting } from "../db/index.js";
import type { IncomingDeal } from "../types.js";
import {
  getListItems,
  getMlListId,
  pushElectronicsToList,
  pushProductsToMappedLists,
} from "./mlLists.js";
import {
  classifyProduct,
  isElectronicsLike,
  listCategories,
} from "./categories.js";
import {
  beginSyncProgress,
  setSyncStep,
  appendSyncLog,
  finishSyncProgress,
} from "./syncProgress.js";
import { pickSanePrices } from "./priceSanity.js";

export type HubProduct = {
  /** ID do anúncio (wid) — MLB123... usado na lista de afiliados */
  itemId: string;
  productId?: string | null;
  title: string;
  price: number;
  oldPrice: number | null;
  imageUrl: string | null;
  productUrl: string;
  commissionPct: number;
  badge: string | null;
  category?: string | null;
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

/** Pausa humana entre chamadas ao ML (evita logout por atividade suspeita). */
async function hubSleep(
  kind: "light" | "link" | "heavy" = "light",
): Promise<void> {
  try {
    const { mlHumanPause, mlCoolingMs } = await import(
      "./mlHumanPace.js"
    );
    if (mlCoolingMs() > 60_000) {
      // em cooldown longo, ainda espera um pouco mas não bloqueia 35 min no Sync
      await new Promise((r) => setTimeout(r, 8_000 + Math.random() * 4_000));
    }
    await mlHumanPause(
      kind === "link" ? "link" : kind === "heavy" ? "hub" : "hub",
    );
    return;
  } catch {
    /* fallback abaixo */
  }
  const base =
    kind === "link"
      ? Math.max(
          9000,
          Number(getSetting("ml_hub_link_delay_ms", "9000")) || 9000,
        )
      : kind === "heavy"
        ? 5000
        : 1800;
  const jitter = Math.floor(Math.random() * (kind === "link" ? 5000 : 1200));
  await new Promise((r) => setTimeout(r, Math.max(800, base + jitter)));
}

function sessionExpiredError(): string {
  return "Sessão do Hub expirada (redirecionou para login). Abra Contas → cole de novo o Cookie e o x-csrf-token do Hub (F12 → Rede → createLink ou /afiliados/hub), salve e tente Sync Hub outra vez.";
}

const LIST_CANDIDATES = [
  "https://www.mercadolivre.com.br/affiliate-program/api/v2/affiliates/recommendations",
  "https://www.mercadolivre.com.br/affiliate-program/api/v2/hub/recommendations",
  "https://www.mercadolivre.com.br/affiliate-program/api/v2/hub/home",
  "https://www.mercadolivre.com.br/affiliate-program/api/v2/affiliates/catalog",
  "https://www.mercadolivre.com.br/affiliate-program/api/v2/affiliates/products",
  "https://www.mercadolivre.com.br/affiliate-program/api/v2/creators/recommendations",
  "https://www.mercadolivre.com.br/affiliate-program/api/v2/affiliates/items",
];

const CREATE_LINK_URLS = [
  "https://www.mercadolivre.com.br/affiliate-program/api/v2/affiliates/createLink",
  "https://www.mercadolivre.com.br/affiliate-program/api/v2/affiliates/createUrls",
  "https://www.mercadolivre.com.br/affiliate-program/api/affiliates/v1/createUrls",
];

function hubHeaders(extra: Record<string, string> = {}): HeadersInit {
  const c = getMercadoLivreCreds();
  return {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "pt-BR,pt;q=0.9",
    "User-Agent": UA,
    Origin: "https://www.mercadolivre.com.br",
    Referer: "https://www.mercadolivre.com.br/afiliados/hub?is_affiliate=true",
    Cookie: c.hubCookie,
    "x-csrf-token": c.hubCsrf,
    ...extra,
  };
}

export function hubSessionReady(): boolean {
  const c = getMercadoLivreCreds();
  return Boolean(c.hubCookie && c.hubCsrf && (c.hubTag || c.affiliateTag));
}

/** Marca Cookie/CSRF morto para o runbook e o banner do painel. */
export function noteHubSessionDead(detail: string): void {
  const msg = String(detail || "sessão Hub inválida").slice(0, 240);
  setSetting("hub_session_alert", msg);
  logAntiBan("cookie_expired", msg);
  void import("./mlHumanPace.js")
    .then((m) => m.noteMlSessionDead(msg))
    .catch(() => undefined);
}

function asNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace("%", "").replace(",", ".").trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function pickCommission(obj: Record<string, unknown>): number {
  const keys = [
    "commission",
    "commission_rate",
    "commissionRate",
    "commission_percentage",
    "commissionPercentage",
    "extra_earnings",
    "extraEarnings",
    "earnings",
    "earning",
    "rate",
    "percentage",
    "percent",
    "ganhos",
    "ganhos_extras",
    "ganhosExtras",
    "affiliate_commission",
    "affiliateCommission",
  ];
  for (const k of keys) {
    const n = asNum(obj[k]);
    if (n != null && n > 0 && n <= 100) return n;
  }
  // nested
  for (const nestKey of ["commission_info", "earnings_info", "affiliate", "metrics"]) {
    const nest = obj[nestKey];
    if (nest && typeof nest === "object") {
      const n = pickCommission(nest as Record<string, unknown>);
      if (n > 0) return n;
    }
  }
  return 0;
}

function pickStr(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function normalizeProduct(raw: unknown): HubProduct | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const item =
    (o.item && typeof o.item === "object" ? (o.item as Record<string, unknown>) : null) ||
    (o.product && typeof o.product === "object"
      ? (o.product as Record<string, unknown>)
      : null) ||
    o;

  const itemId =
    pickStr(item, ["id", "item_id", "itemId", "mlb_id", "catalog_product_id"]) ||
    pickStr(o, ["id", "item_id", "itemId"]);
  const title = pickStr(item, ["title", "name", "permalink_title"]) || "";
  const productUrl =
    pickStr(item, ["permalink", "url", "product_url", "link", "deeplink"]) ||
    (itemId && /^MLB/i.test(itemId)
      ? `https://www.mercadolivre.com.br/wid/${itemId}`
      : null);
  if (!productUrl && !itemId) return null;

  const price =
    asNum(item.price) ??
    asNum(item.amount) ??
    asNum((item.price as { value?: unknown } | undefined)?.value) ??
    0;
  const oldPrice =
    asNum(item.original_price) ??
    asNum(item.originalPrice) ??
    asNum(item.list_price) ??
    null;
  const imageUrl =
    pickStr(item, ["thumbnail", "picture", "image", "image_url", "secure_thumbnail"]) ||
    null;
  const commissionPct = pickCommission(o) || pickCommission(item);
  const badge =
    pickStr(o, ["badge", "label", "tag", "highlight"]) ||
    pickStr(item, ["badge", "label"]);

  const url =
    productUrl ||
    `https://produto.mercadolivre.com.br/${String(itemId).replace(/^MLB/i, "MLB-")}`;

  const sane = pickSanePrices({ price: price || 0, oldPrice });

  return {
    itemId: String(itemId || url),
    title: title || `Produto ML ${itemId || ""}`.trim(),
    price: sane.price,
    oldPrice: sane.oldPrice,
    imageUrl,
    productUrl: url,
    commissionPct,
    badge,
  };
}

/** Percorre JSON arbitrário em busca de objetos que pareçam produtos do Hub. */
export function extractHubProductsFromJson(data: unknown): HubProduct[] {
  const out: HubProduct[] = [];
  const seen = new Set<string>();

  const visit = (node: unknown, depth: number) => {
    if (depth > 10 || node == null) return;
    if (Array.isArray(node)) {
      for (const x of node) visit(x, depth + 1);
      return;
    }
    if (typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    const looksLikeProduct =
      ("title" in o || "permalink" in o || "item_id" in o || "itemId" in o) &&
      ("price" in o ||
        "commission" in o ||
        "commission_rate" in o ||
        "extra_earnings" in o ||
        "ganhos" in o ||
        "thumbnail" in o ||
        "original_price" in o);
    if (looksLikeProduct) {
      const p = normalizeProduct(o);
      if (p && !seen.has(p.itemId)) {
        seen.add(p.itemId);
        out.push(p);
      }
    }
    for (const v of Object.values(o)) visit(v, depth + 1);
  };

  visit(data, 0);
  return out;
}

async function fetchJson(url: string, init?: RequestInit): Promise<{
  ok: boolean;
  status: number;
  json: unknown;
  text: string;
}> {
  const res = await fetch(url, init);
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json, text };
}

/** Extrai cards do HTML SSR do Hub (ganhos + preço + URL do produto). */
export function extractHubProductsFromHtml(html: string): HubProduct[] {
  const text = html
    .replace(/\\u002F/gi, "/")
    .replace(/\\\//g, "/")
    .replace(/\\"/g, '"');

  const products: HubProduct[] = [];
  const seen = new Set<string>();

  // Cada card traz metadata com url + card_type grid-card
  const cardRe =
    /"url"\s*:\s*"(?<url>(?:https:\/\/)?(?:www\.)?(?:produto\.)?mercadolivre\.com\.br\/[^"]+)"[^]{0,500}?"card_type"\s*:\s*"grid-card"/g;

  let m: RegExpExecArray | null;
  const starts: Array<{ index: number; url: string }> = [];
  while ((m = cardRe.exec(text))) {
    const rawUrl = m.groups?.url || "";
    if (!rawUrl) continue;
    starts.push({ index: m.index, url: rawUrl });
  }

  for (let i = 0; i < starts.length; i++) {
    const rawUrl = starts[i].url;
    const productUrl = rawUrl.startsWith("http")
      ? rawUrl
      : `https://${rawUrl}`;
    if (seen.has(productUrl)) continue;

    const from = starts[i].index;
    const to = i + 1 < starts.length ? starts[i + 1].index : from + 8000;
    // metadata do card fica um pouco ANTES do "url"
    const metaStart = Math.max(0, from - 350);
    const slice = text.slice(metaStart, to);
    const metaWindow = text.slice(metaStart, from + 200);

    // Comissão: chip affiliates_commission_chip → label "22%"
    let commissionPct = 0;
    const chipIdx = slice.indexOf("affiliates_commission_chip");
    if (chipIdx >= 0) {
      const afterChip = slice.slice(chipIdx, chipIdx + 900);
      const pct =
        afterChip.match(
          /"label"\s*:\s*\{\s*"text"\s*:\s*"(\d+(?:[.,]\d+)?)\s*%?"/,
        ) ||
        afterChip.match(/"text"\s*:\s*"GANHOS\s*(\d+(?:[.,]\d+)?)\s*%"/i) ||
        afterChip.match(/"text"\s*:\s*"(\d+(?:[.,]\d+)?)\s*%"/);
      if (pct?.[1]) commissionPct = Number(pct[1].replace(",", "."));
    }
    if (!commissionPct) {
      const g = slice.match(/"text"\s*:\s*"GANHOS\s*(\d+(?:[.,]\d+)?)\s*%"/i);
      if (g?.[1]) commissionPct = Number(g[1].replace(",", "."));
    }

    const priceMatch = slice.match(
      /"current_price"\s*:\s*\{[^}]{0,120}?"value"\s*:\s*([0-9.]+)/,
    );
    const oldMatch = slice.match(
      /"previous_price"\s*:\s*\{[^}]{0,120}?"value"\s*:\s*([0-9.]+)/,
    );
    // candidatos extras (evita pegar só um 0.02 solto no card)
    const candidateNums = [
      ...slice.matchAll(
        /"(?:current_price|previous_price|price|amount)"\s*:\s*(?:\{[^}]{0,80}?"value"\s*:\s*)?([0-9]+(?:\.[0-9]+)?)/g,
      ),
    ]
      .map((x) => Number(x[1]))
      .filter((n) => Number.isFinite(n) && n >= 1);

    const titles = [...slice.matchAll(/"text"\s*:\s*"([^"\\]{18,200})"/g)].map(
      (x) => x[1],
    );
    const bad =
      /OFF|GANHOS|Classifica|vendidos|Pix|juros|outros meios|saldo|Mercado Pago|Compartilh|\{|estrelas|produtos selecionados/i;
    const title =
      titles.find((t) => !bad.test(t)) ||
      titles[0] ||
      `Produto ML ${productUrl.split("/").pop()}`;

    // ID do anúncio fica no metadata junto do url (antes do card_type)
    const listingId =
      normalizeItemId(
        metaWindow.match(
          /"id"\s*:\s*"(MLB\d{6,})"\s*,\s*"product_id"\s*:\s*"(MLB[^"]+)"/,
        )?.[1],
      ) ||
      normalizeItemId(metaWindow.match(/wid=(MLB\d{6,})/i)?.[1]) ||
      normalizeItemId(productUrl) ||
      null;
    const productId =
      normalizeItemId(
        metaWindow.match(/"product_id"\s*:\s*"(MLB[^"]+)"/)?.[1],
      ) ||
      normalizeItemId(productUrl.match(/\/p\/(MLB[\d]+)/i)?.[1]) ||
      null;

    const imgMatch = slice.match(
      /https:\/\/http2\.mlstatic\.com\/D_[^"\\]+\.(?:jpg|webp|png)/i,
    );

    const extra = /"extra_commission"\s*:\s*"true"/.test(metaWindow);
    const sane = pickSanePrices({
      price: priceMatch ? Number(priceMatch[1]) : 0,
      oldPrice: oldMatch ? Number(oldMatch[1]) : null,
      candidates: candidateNums,
    });

    seen.add(productUrl);
    products.push({
      itemId: String(listingId || productId || productUrl),
      productId,
      title: title.replace(/\\u[\dA-Fa-f]{4}/g, (u) =>
        String.fromCharCode(parseInt(u.slice(2), 16)),
      ),
      price: sane.price,
      oldPrice: sane.oldPrice,
      imageUrl: imgMatch?.[0] || null,
      productUrl,
      commissionPct,
      badge: extra ? "GANHOS EXTRAS" : commissionPct ? "GANHOS" : null,
    });
  }

  return products.sort((a, b) => b.commissionPct - a.commissionPct);
}

/** Tenta listar produtos com comissão via endpoints internos + HTML do Hub. */
export async function fetchHubProducts(): Promise<{
  products: HubProduct[];
  source: string;
  error?: string;
}> {
  if (!hubSessionReady()) {
    return {
      products: [],
      source: "none",
      error:
        "Configure Cookie + CSRF + etiqueta do Hub (Contas). Sem sessão logada não dá para ler GANHOS EXTRAS.",
    };
  }

  // 1) HTML SSR do Hub — contém os cards com GANHOS EXTRAS (caso real MLB)
  try {
    const r = await fetchJson(
      "https://www.mercadolivre.com.br/afiliados/hub?is_affiliate=true",
      {
        method: "GET",
        headers: hubHeaders({ Accept: "text/html,application/xhtml+xml" }),
        redirect: "manual",
      },
    );
    if (r.status >= 300 && r.status < 400) {
      return {
        products: [],
        source: "hub_html",
        error:
          "Sessão do Hub expirada (redirecionou para login). Abra Contas → cole de novo o Cookie e o x-csrf-token do Hub (F12 → Rede → createLink ou /afiliados/hub), salve e tente Sync Hub outra vez.",
      };
    }
    const html = r.text || "";
    const fromHtml = extractHubProductsFromHtml(html).filter(
      (p) => p.productUrl && p.commissionPct > 0,
    );
    if (fromHtml.length) {
      return { products: fromHtml, source: "hub_html_ssr" };
    }

    // fallback: blobs JSON embutidos
    const blobs: string[] = [];
    const next = html.match(
      /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i,
    );
    if (next?.[1]) blobs.push(next[1]);
    const scriptJson = [
      ...html.matchAll(
        /<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi,
      ),
    ];
    for (const sm of scriptJson) blobs.push(sm[1]);
    for (const b of blobs) {
      try {
        const products = extractHubProductsFromJson(JSON.parse(b));
        if (products.length) {
          return { products, source: "hub_html_embed" };
        }
      } catch {
        /* ignore */
      }
    }
  } catch (err) {
    return {
      products: [],
      source: "hub_html",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // 2) Endpoints JSON internos (quando existirem)
  const saved = getSetting("ml_hub_list_url", "");
  const urls = saved
    ? [saved, ...LIST_CANDIDATES.filter((u) => u !== saved)]
    : LIST_CANDIDATES;

  for (const url of urls) {
    try {
      const r = await fetchJson(url, {
        method: "GET",
        headers: hubHeaders(),
        redirect: "manual",
      });
      if (r.status === 301 || r.status === 302 || r.status === 401 || r.status === 403) {
        continue;
      }
      if (!r.ok || !r.json) continue;
      const products = extractHubProductsFromJson(r.json).filter(
        (p) => p.commissionPct > 0 || p.productUrl,
      );
      if (products.length) {
        setSetting("ml_hub_list_url", url);
        return { products, source: url };
      }
    } catch {
      /* try next */
    }
  }

  return {
    products: [],
    source: "none",
    error:
      "Não achei cards com GANHOS no Hub. Atualize Cookie/CSRF ou, em Promoções → avançado, cole o HTML/JSON da página do Hub.",
  };
}

/** Normaliza MLB123456 (sem hífen) a partir de URL/id solto. */
export function normalizeItemId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = String(raw);
  const m =
    s.match(/\b(MLB)-?(\d{6,})\b/i) ||
    s.match(/[?&#]wid=(MLB)(\d{6,})/i) ||
    s.match(/\/p\/(MLB)(\d{6,})/i);
  if (!m) return null;
  return `${m[1].toUpperCase()}${m[2]}`;
}

function urlCandidatesForItem(
  productUrl: string,
  itemId?: string | null,
): string[] {
  const id = normalizeItemId(itemId) || normalizeItemId(productUrl);
  const out: string[] = [];
  const push = (u: string | null | undefined) => {
    if (u && !out.includes(u)) out.push(u);
  };
  push(productUrl);
  if (id) {
    const dashed = id.replace(/^(MLB)/i, "MLB-");
    push(`https://produto.mercadolivre.com.br/${dashed}`);
    push(`https://www.mercadolivre.com.br/wid/${id}`);
  }
  return out;
}

function shortFromCreatePayload(json: Record<string, unknown>): string | null {
  const urlsArr = (json.urls || json.links || json.data) as unknown;
  if (Array.isArray(urlsArr) && urlsArr[0]) {
    const first = urlsArr[0] as Record<string, unknown>;
    const short =
      pickStr(first, [
        "short_url",
        "shortUrl",
        "affiliate_url",
        "url",
        "link",
        "meli_la",
      ]) || null;
    if (short) return short;
    if (typeof urlsArr[0] === "string") return urlsArr[0];
  }
  return pickStr(json, ["short_url", "shortUrl", "url", "link"]);
}

/** Gera meli.la 1 a 1, com pausa longa — lotes grandes derrubam a sessão do ML. */
export async function createAffiliateLinksBatch(
  productUrls: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!productUrls.length || !hubSessionReady()) return map;

  // Sempre 1 URL por request (chunk>1 + fallback rápido = padrão de bot)
  for (let i = 0; i < productUrls.length; i++) {
    const u = productUrls[i];
    const one = await createAffiliateLink(u);
    if (one.error && /expirada|login/i.test(one.error)) {
      logAntiBan("ml_hub_session_dead", `createLink batch stop at ${i + 1}/${productUrls.length}`);
      break;
    }
    if (one.shortUrl) map.set(u, one.shortUrl);
    if (i + 1 < productUrls.length) await hubSleep("link");
  }
  return map;
}

/** Anexa coupon_campaign_id na URL do produto antes do createLink (meli.la não aceita query). */
export function withCouponCampaign(url: string, campaignId?: string | null): string {
  if (!url || !campaignId) return url;
  if (url.includes("coupon_campaign_id=")) return url;
  if (url.includes("meli.la")) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}coupon_campaign_id=${campaignId}`;
}

export async function createAffiliateLink(
  productUrl: string,
  opts?: { couponCampaignId?: string | null },
): Promise<{
  shortUrl: string | null;
  error?: string;
  raw?: unknown;
}> {
  if (!hubSessionReady()) {
    return { shortUrl: null, error: "Sessão do Hub incompleta" };
  }
  const c = getMercadoLivreCreds();
  const tag = (c.hubTag || c.affiliateTag || "").trim();
  const baseUrl = withCouponCampaign(productUrl, opts?.couponCampaignId);
  // Modo conservador: 1 URL + 1 endpoint. O fan-out 3×3 parece bot e derruba a sessão.
  const aggressive = getSetting("ml_hub_link_aggressive", "0") === "1";
  const candidates = aggressive
    ? urlCandidatesForItem(baseUrl)
    : [baseUrl];
  const preferred = getSetting("ml_hub_create_url", "") || CREATE_LINK_URLS[0];
  const endpoints = aggressive
    ? CREATE_LINK_URLS
    : [preferred, ...CREATE_LINK_URLS.filter((u) => u !== preferred)].slice(0, 2);

  for (const candidate of candidates) {
    const withCamp = withCouponCampaign(candidate, opts?.couponCampaignId);
    const body = { urls: [withCamp], tag };
    for (const url of endpoints) {
      try {
        const r = await fetchJson(url, {
          method: "POST",
          headers: hubHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify(body),
          redirect: "manual",
        });
        if (r.status === 301 || r.status === 302) {
          return { shortUrl: null, error: sessionExpiredError() };
        }
        if (!r.ok) {
          await hubSleep("light");
          continue;
        }

        const json = r.json as Record<string, unknown> | null;
        if (!json) continue;
        const short = shortFromCreatePayload(json);
        if (short) {
          setSetting("ml_hub_create_url", url);
          return { shortUrl: short, raw: json };
        }
      } catch {
        /* next */
      }
      await hubSleep("light");
    }
    if (!aggressive) break;
  }

  return {
    shortUrl: null,
    error:
      "createLink falhou. Cookie/CSRF podem ter expirado — gere um link no Hub e copie Cookie + x-csrf-token de novo.",
  };
}

/**
 * Catálogo extra por categorias ativas (mais vendidos ML) para complementar
 * os cards do Hub — alimenta várias comunidades, não só eletrônicos.
 */
export async function fetchCategoryCatalog(limit = 50): Promise<HubProduct[]> {
  if (!hubSessionReady()) return [];
  const cats = listCategories({ activeOnly: true }).filter(
    (c) => c.mlCategoryIds.length > 0,
  );
  const pages: Array<{ url: string; category: string }> = [];
  for (const c of cats.slice(0, 8)) {
    for (const ml of c.mlCategoryIds.slice(0, 1)) {
      pages.push({
        url: `https://www.mercadolivre.com.br/mais-vendidos/${ml}`,
        category: c.id,
      });
    }
  }
  if (!pages.length) {
    pages.push(
      { url: "https://www.mercadolivre.com.br/mais-vendidos/MLB1000", category: "eletronicos" },
      { url: "https://www.mercadolivre.com.br/mais-vendidos/MLB1051", category: "celulares" },
    );
  }

  const seen = new Set<string>();
  const out: HubProduct[] = [];
  const perCat = Math.max(6, Math.ceil(limit / Math.max(pages.length, 1)));

  for (const page of pages) {
    let addedHere = 0;
    try {
      const r = await fetchJson(page.url, {
        method: "GET",
        headers: hubHeaders({ Accept: "text/html,application/xhtml+xml" }),
        redirect: "follow",
      });
      const html = r.text || "";
      for (const p of extractListingProductsFromHtml(html)) {
        const id = normalizeItemId(p.itemId);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const category = classifyProduct({
          title: p.title,
          productUrl: p.productUrl,
          categoryHint: page.category,
        });
        out.push({
          ...p,
          itemId: id,
          category,
          commissionPct: p.commissionPct || 0,
          badge: p.badge || `Catálogo ${category}`,
        });
        addedHere += 1;
        if (out.length >= limit || addedHere >= perCat) break;
      }
    } catch {
      /* next page */
    }
    await new Promise((res) => setTimeout(res, 200));
    if (out.length >= limit) break;
  }
  return out;
}

/** @deprecated use fetchCategoryCatalog */
export async function fetchElectronicsCatalog(limit = 40): Promise<HubProduct[]> {
  return fetchCategoryCatalog(limit);
}

/** Extrai anúncios de páginas de listagem / mais vendidos (wid=MLB…). */
export function extractListingProductsFromHtml(html: string): HubProduct[] {
  const text = html
    .replace(/\\u002F/gi, "/")
    .replace(/\\\//g, "/")
    .replace(/\\"/g, '"');
  const products: HubProduct[] = [];
  const seen = new Set<string>();

  // padrão comum: #polycard...&wid=MLB123
  const widRe = /wid=(MLB\d{6,})/gi;
  let m: RegExpExecArray | null;
  while ((m = widRe.exec(text))) {
    const itemId = m[1].toUpperCase();
    if (seen.has(itemId)) continue;
    const from = Math.max(0, m.index - 400);
    const slice = text.slice(from, m.index + 1200);
    const title =
      slice.match(/"text"\s*:\s*"([^"\\]{16,160})"/)?.[1] ||
      slice.match(/alt="([^"]{16,160})"/)?.[1] ||
      `Eletrônico ${itemId}`;
    const bad =
      /OFF|GANHOS|Classifica|vendidos|Pix|juros|Mercado Pago|Compartilh|estrelas|Ir para|Acessibilidade/i;
    const cleanTitle = bad.test(title)
      ? `Eletrônico ${itemId}`
      : title.replace(/\\u[\dA-Fa-f]{4}/g, (u) =>
          String.fromCharCode(parseInt(u.slice(2), 16)),
        );
    const price =
      asNum(slice.match(/"price"\s*:\s*([0-9.]+)/)?.[1]) ||
      asNum(slice.match(/"amount"\s*:\s*([0-9.]+)/)?.[1]) ||
      0;
    const img =
      slice.match(
        /https:\/\/http2\.mlstatic\.com\/D_[^"\\]+\.(?:jpg|webp|png)/i,
      )?.[0] || null;
    const urlFromMeta =
      slice.match(
        /"url"\s*:\s*"((?:https:\/\/)?(?:www\.)?(?:produto\.)?mercadolivre\.com\.br\/[^"]+)"/,
      )?.[1] || null;
    const productUrl = urlFromMeta
      ? urlFromMeta.startsWith("http")
        ? urlFromMeta
        : `https://${urlFromMeta}`
      : `https://produto.mercadolivre.com.br/${itemId.replace(/^MLB/i, "MLB-")}`;

    seen.add(itemId);
    products.push({
      itemId,
      title: cleanTitle,
      price: price || 0,
      oldPrice: null,
      imageUrl: img,
      productUrl,
      commissionPct: 0,
      badge: null,
      category: "geral",
    });
  }
  return products;
}

export async function syncTopCommissionDeals(opts?: {
  minCommission?: number;
  limit?: number;
  productsFromJson?: unknown;
  pushToList?: boolean;
  /** Se false, não roda enrich de cupons (padrão: desligado — evita rajada no ML). */
  enrichCoupons?: boolean;
}): Promise<{
  ok: boolean;
  listed: number;
  linked: number;
  inserted: number;
  minCommission: number;
  source: string;
  electronicsListed: number;
  catalogAdded: number;
  storesAdded?: number;
  byCategory: Record<string, number>;
  top: Array<{ title: string; commissionPct: number; affiliate_url: string; category?: string }>;
  listPush?: {
    attempted: number;
    added: number;
    skipped: number;
    listUrl: string;
    errors: string[];
  };
  coupons?: {
    matched: number;
    failed: number;
    synced?: { stored: number; active: number; totalReported: number };
  };
  published?: { attempted: number; sent: number; blockedReason?: string };
  error?: string;
  paceNote?: string;
}> {
  const { syncCreateLinkLimit, syncCategoryQuotas, isElectronicsFamily, offerAttractScore } =
    await import("./queueVolume.js");
  const minCommission =
    opts?.minCommission ??
    Number(getSetting("ml_hub_min_commission", "20")) ??
    20;
  // Volume alinhado aos canais BR (~60–90 posts/dia): Sync pode mintar até 48 links
  const limit = syncCreateLinkLimit(opts?.limit);
  const pushToList =
    opts?.pushToList ?? getSetting("ml_list_push_products", "0") === "1";
  const enrichCoupons =
    opts?.enrichCoupons ??
    getSetting("ml_hub_enrich_coupons_on_sync", "0") === "1";
  const paceNote =
    `Modo conservador: até ${limit} links, ~6–10s entre createLink` +
    (pushToList ? ", push lista ligado" : ", sem push lista") +
    (enrichCoupons ? ", com cupons" : ", sem enrich de cupons");

  beginSyncProgress("Sync Hub + lojas oficiais");
  const syncStartedAt = new Date().toISOString();
  let storesAdded = 0;

  let products: HubProduct[] = [];
  let source = "json_paste";
  let catalogAdded = 0;
  let listImported = 0;

  try {
  setSyncStep("hub", "running", "Lendo Hub de afiliados…");
  if (opts?.productsFromJson) {
    if (typeof opts.productsFromJson === "string") {
      const raw = opts.productsFromJson.trim();
      if (raw.startsWith("<") || raw.includes("affiliates_commission_chip")) {
        products = extractHubProductsFromHtml(raw);
        source = "html_paste";
      } else {
        try {
          products = extractHubProductsFromJson(JSON.parse(raw));
          source = "json_paste";
        } catch {
          products = extractHubProductsFromHtml(raw);
          source = "html_paste";
        }
      }
    } else {
      products = extractHubProductsFromJson(opts.productsFromJson);
    }
    setSyncStep("hub", "done", `${products.length} produtos do Hub`);
    appendSyncLog(`Hub: ${products.length} itens (${source})`);
  } else {
    const listed = await fetchHubProducts();
    products = listed.products;
    source = listed.source;
    if (listed.error && !products.length) {
      // Hub vazio/expirado — continua com lojas oficiais (TCG/Pokémon etc.)
      setSyncStep("hub", "error", listed.error);
      appendSyncLog(
        `Hub falhou: ${listed.error} — seguindo com lojas oficiais`,
      );
    } else {
      setSyncStep(
        "hub",
        "done",
        listed.error
          ? `${products.length} produtos (aviso: ${listed.error})`
          : `${products.length} produtos do Hub`,
      );
      appendSyncLog(
        listed.error
          ? `Hub: ${products.length} itens · aviso ${listed.error}`
          : `Hub: ${products.length} itens (${source})`,
      );
    }
  }

  // classifica em categorias (várias comunidades) + normaliza itemId
  products = products.map((p) => {
    const itemId =
      normalizeItemId(p.itemId) || normalizeItemId(p.productUrl) || p.itemId;
    const next = { ...p, itemId };
    return {
      ...next,
      category: classifyProduct({
        title: next.title,
        productUrl: next.productUrl,
      }),
    };
  });
  // Remove nicho de baixa aceitação (toner, interfone, mini compressor…)
  {
    const { isLowDemandNicheTitle } = await import("./demandFilter.js");
    const before = products.length;
    products = products.filter((p) => !isLowDemandNicheTitle(p.title));
    const dropped = before - products.length;
    if (dropped > 0) {
      appendSyncLog(`Filtro demanda: removeu ${dropped} nicho(s) (toner/interfone/compressor…)`);
    }
  }

  const seenIds = new Set(
    products.map((p) => normalizeItemId(p.itemId) || p.itemId).filter(Boolean),
  );

  // Hub SSR costuma trazer ~18 cards — complementa com mais vendidos + lista ML
  const wantSupplement = getSetting("ml_hub_supplement_catalog", "0") === "1";
  if (wantSupplement && hubSessionReady()) {
    const need = Math.max(limit - products.length, Math.ceil(limit * 0.6));
    const catalog = await fetchCategoryCatalog(Math.min(80, need + 20));
    for (const p of catalog) {
      const id = normalizeItemId(p.itemId) || p.itemId;
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);
      products.push(p);
      catalogAdded += 1;
    }
    if (catalogAdded) source = `${source}+catalog`;
  }

  const wantList =
    getSetting("ml_hub_import_list", "1") === "1" && hubSessionReady();
  if (wantList) {
    try {
      const listItems = await getListItems(getMlListId());
      for (const it of listItems) {
        const id = normalizeItemId(it.itemId);
        if (!id || seenIds.has(id)) continue;
        seenIds.add(id);
        const productUrl =
          it.url ||
          `https://produto.mercadolivre.com.br/${id.replace(/^MLB/i, "MLB-")}`;
        products.push({
          itemId: id,
          title: it.title,
          price: it.price || 0,
          oldPrice: null,
          imageUrl: null,
          productUrl,
          commissionPct: 0,
          badge: "Lista ML",
          category: classifyProduct({ title: it.title, productUrl }),
        });
        listImported += 1;
      }
      if (listImported) source = `${source}+list`;
    } catch (err) {
      logAntiBan(
        "ml_hub_list_import_fail",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Lojas oficiais (Pokémon → TCG etc.) — fonte quando o Hub não traz o nicho
  setSyncStep("stores", "running", "Lendo lojas oficiais…");
  try {
    const { fetchAllOfficialStoreProducts } = await import(
      "./mlOfficialStores.js"
    );
    const storeProducts = await fetchAllOfficialStoreProducts({
      onStore: (store, count, error) => {
        appendSyncLog(
          error
            ? `Loja ${store.name}: erro — ${error}`
            : `Loja ${store.name} → ${count} produtos (${store.category}, ~${store.commission_hint}%)`,
        );
      },
    });
    for (const p of storeProducts) {
      const id = normalizeItemId(p.itemId) || p.itemId;
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);
      products.push(p);
      storesAdded += 1;
    }
    if (storesAdded) source = `${source}+stores`;
    setSyncStep(
      "stores",
      "done",
      storesAdded
        ? `+${storesAdded} de lojas oficiais`
        : "Nenhum item novo das lojas",
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setSyncStep("stores", "error", msg);
    logAntiBan("official_stores_fail", msg);
  }

  // Busca profunda TCG — entra no pool junto com o resto, sem prioridade no createLink
  try {
    const { fetchTcgDeepCatalog } = await import("./mlOfficialStores.js");
    const deep = await fetchTcgDeepCatalog({ maxQueries: 8, maxPerQuery: 10 });
    let deepAdded = 0;
    for (const p of deep) {
      const id = normalizeItemId(p.itemId) || p.itemId;
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);
      products.push(p);
      deepAdded += 1;
    }
    if (deepAdded) {
      storesAdded += deepAdded;
      source = `${source}+tcg_search`;
      appendSyncLog(`Busca TCG: +${deepAdded} itens (Pokémon/Magic/YGO/sleeves…)`);
    }
  } catch (err) {
    logAntiBan(
      "tcg_deep_fail",
      err instanceof Error ? err.message : String(err),
    );
  }

  setSyncStep("filter", "running", "Separando por categoria…");
  const byCategory: Record<string, number> = {};
  for (const p of products) {
    const c = p.category || "geral";
    byCategory[c] = (byCategory[c] || 0) + 1;
  }

  const electronicsListed = products.filter((p) =>
    isElectronicsLike(p.category || "geral"),
  ).length;

  const byAttract = (a: HubProduct, b: HubProduct) =>
    offerAttractScore({
      commissionPct: b.commissionPct,
      price: b.price,
      oldPrice: b.oldPrice,
      title: b.title,
    }) -
    offerAttractScore({
      commissionPct: a.commissionPct,
      price: a.price,
      oldPrice: a.oldPrice,
      title: a.title,
    });

  const hubPool = products
    .filter((p) => p.commissionPct >= minCommission)
    .sort(byAttract);

  const storePool = products
    .filter(
      (p) =>
        (String(p.badge || "").startsWith("Loja") ||
          String(p.badge || "").startsWith("Busca TCG")) &&
        p.commissionPct > 0 &&
        p.commissionPct < minCommission,
    )
    .sort(byAttract);

  // Buckets + quotas mínimas TCG / eletrônicos (concorrentes saturam nicho)
  const buckets = new Map<string, HubProduct[]>();
  const pushBucket = (p: HubProduct) => {
    const cat = p.category || "geral";
    const arr = buckets.get(cat) || [];
    arr.push(p);
    buckets.set(cat, arr);
  };
  for (const p of storePool) pushBucket(p);
  for (const p of hubPool) pushBucket(p);
  for (const p of products) {
    const id = normalizeItemId(p.itemId) || p.itemId;
    if (!id) continue;
    const already = [...buckets.values()].some((arr) =>
      arr.some((x) => (normalizeItemId(x.itemId) || x.itemId) === id),
    );
    if (!already) pushBucket(p);
  }
  for (const arr of buckets.values()) arr.sort(byAttract);

  const quotas = syncCategoryQuotas(limit);
  const pool: HubProduct[] = [];
  const seenPool = new Set<string>();
  const takeFrom = (pred: (p: HubProduct) => boolean, n: number) => {
    let got = 0;
    for (const cat of buckets.keys()) {
      const arr = buckets.get(cat) || [];
      for (let i = 0; i < arr.length && got < n && pool.length < limit; i++) {
        const p = arr[i];
        if (!pred(p)) continue;
        const id = normalizeItemId(p.itemId) || p.itemId;
        if (!id || seenPool.has(id)) continue;
        seenPool.add(id);
        pool.push(p);
        got += 1;
      }
    }
  };
  takeFrom((p) => (p.category || "") === "tcg", quotas.tcg);
  takeFrom((p) => isElectronicsFamily(p.category || "geral"), quotas.electronics);

  const catOrder = [...buckets.keys()].sort(
    (a, b) => (buckets.get(b)?.length || 0) - (buckets.get(a)?.length || 0),
  );
  let progressed = true;
  while (pool.length < limit && progressed) {
    progressed = false;
    for (const cat of catOrder) {
      if (pool.length >= limit) break;
      const arr = buckets.get(cat) || [];
      while (arr.length) {
        const p = arr.shift()!;
        const id = normalizeItemId(p.itemId) || p.itemId;
        if (!id || seenPool.has(id)) continue;
        seenPool.add(id);
        pool.push(p);
        progressed = true;
        break;
      }
    }
  }

  if (pool.length < limit) {
    const used = new Set(
      pool.map((p) => normalizeItemId(p.itemId) || p.itemId),
    );
    const fillers = products
      .filter((p) => {
        const id = normalizeItemId(p.itemId) || p.itemId;
        return id && !used.has(id);
      })
      .sort(byAttract);
    for (const p of fillers) {
      if (pool.length >= limit) break;
      pool.push(p);
    }
    if (fillers.length && hubPool.length < limit) {
      logAntiBan(
        "ml_hub_fill_pool",
        `hub>=${minCommission}%=${hubPool.length} preenchido até ${pool.length} (catálogo=${catalogAdded} lista=${listImported} lojas=${storesAdded})`,
      );
    }
  }
  logAntiBan(
    "ml_hub_quota",
    `limit=${limit} tcgQuota=${quotas.tcg} elecQuota=${quotas.electronics} poolTcg=${pool.filter((p) => p.category === "tcg").length} poolElec=${pool.filter((p) => isElectronicsFamily(p.category || "")).length}`,
  );

  if (!pool.length && products.length) {
    pool.push(
      ...[...products]
        .filter((p) => p.commissionPct > 0 || p.productUrl)
        .sort((a, b) => b.commissionPct - a.commissionPct)
        .slice(0, limit),
    );
    logAntiBan(
      "ml_hub_fallback_min",
      `nenhum produto >= ${minCommission}% — usando top disponíveis`,
    );
  }

  setSyncStep(
    "filter",
    "done",
    `Fila: ${pool.length} de ${products.length} (Hub+lojas)`,
  );

  const deals: IncomingDeal[] = [];
  const top: Array<{
    title: string;
    commissionPct: number;
    affiliate_url: string;
    category?: string;
  }> = [];

  // Gera links 1 a 1 com pausa (nunca lote de 8)
  setSyncStep("links", "running", `Gerando até ${pool.length} links afiliados…`);
  const linkMap = await createAffiliateLinksBatch(pool.map((p) => p.productUrl));
  let sessionDead = false;

  for (const p of pool) {
    let short = linkMap.get(p.productUrl) || null;
    if (!short) {
      for (const alt of urlCandidatesForItem(p.productUrl, p.itemId)) {
        if (linkMap.has(alt)) {
          short = linkMap.get(alt)!;
          break;
        }
      }
    }
    if (!short) {
      // Sem retry agressivo: se o batch falhou, não martela createLink de novo
      logAntiBan("ml_hub_link_fail", `${p.itemId}: sem link (sem retry)`);
      continue;
    }
    const pctLabel =
      p.commissionPct > 0
        ? `GANHOS EXTRAS ${p.commissionPct}%`
        : "Catálogo ML";
    const extId = normalizeItemId(p.itemId) || p.itemId;
    deals.push({
      external_id: `hubauto-${extId}`,
      source: "mercadolivre",
      title: p.title,
      description: `${pctLabel}${p.badge ? ` · ${p.badge}` : ""}\nCategoria: ${p.category || "geral"}`,
      category: p.category || "geral",
      price: p.price,
      old_price: p.oldPrice,
      currency: "BRL",
      coupon: null,
      image_url: p.imageUrl,
      product_url: p.productUrl,
      affiliate_url: short,
      commission_pct: p.commissionPct > 0 ? p.commissionPct : null,
    });
    top.push({
      title: p.title,
      commissionPct: p.commissionPct,
      affiliate_url: short,
      category: p.category || "geral",
    });
  }

  if (!deals.length && pool.length) {
    // Provável sessão morta no batch
    sessionDead = true;
  }

  setSyncStep(
    "links",
    sessionDead ? "error" : "done",
    sessionDead
      ? "Sessão expirada no createLink"
      : `${deals.length} links gerados`,
  );

  setSyncStep("save", "running", "Gravando na fila local…");
  const inserted = upsertDeals(deals);

  // Preenche imagens faltantes (lista/catálogo vêm sem thumbnail) — poucas
  try {
    const { backfillMissingDealImages } = await import("./dealMedia.js");
    await backfillMissingDealImages(Math.min(3, Math.max(deals.length, 1)));
  } catch (err) {
    logAntiBan(
      "deal_image_backfill_fail",
      err instanceof Error ? err.message : String(err),
    );
  }

  setSyncStep("save", "done", `${inserted} ofertas gravadas`);

  // Melhores cupons — DESLIGADO no Sync padrão (era a maior rajada de requests)
  let coupons:
    | {
        matched: number;
        failed: number;
        synced?: { stored: number; active: number; totalReported: number };
      }
    | undefined;
  if (enrichCoupons && !sessionDead) {
    try {
      const { enrichQueuedDealsWithCoupons } = await import("./mlCoupons.js");
      const matchLimit = Math.min(Math.max(deals.length, 1), limit);
      const couponResult = await enrichQueuedDealsWithCoupons({
        limit: matchLimit,
        syncFirst: true,
      });
      coupons = {
        matched: couponResult.matched,
        failed: couponResult.failed,
        synced: couponResult.synced
          ? {
              stored: couponResult.synced.stored,
              active: couponResult.synced.active,
              totalReported: couponResult.synced.totalReported,
            }
          : undefined,
      };
    } catch (err) {
      logAntiBan(
        "ml_coupons_enrich_fail",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Cupom validado → posta nos grupos (Avisos) assim que possível
  let published:
    | { attempted: number; sent: number; blockedReason?: string }
    | undefined;
  if (
    getSetting("auto_publish_on_coupon_valid", "1") === "1" &&
    (coupons?.matched || 0) > 0
  ) {
    try {
      const { runPublishWave } = await import("./publisher.js");
      published = await runPublishWave({
        manual: true,
        ignoreGroupInterval: true,
      });
    } catch (err) {
      logAntiBan(
        "ml_auto_publish_fail",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  let listPush:
    | {
        attempted: number;
        added: number;
        skipped: number;
        listUrl: string;
        errors: string[];
      }
    | undefined;

  if (pushToList && hubSessionReady() && !sessionDead) {
    setSyncStep("lists", "running", "Enviando às listas ML…");
    const forList = pool
      .map((p) => ({
        ...p,
        itemId: normalizeItemId(p.itemId) || p.itemId,
      }))
      .filter((p) => /^MLB\d{6,}/i.test(p.itemId));
    // Separa por categoria → cada lista ML do mapa recebe o nicho certo
    listPush = await pushProductsToMappedLists(forList);
    setSyncStep(
      "lists",
      "done",
      `+${listPush.added} nas listas (pulados ${listPush.skipped})`,
    );
  } else {
    setSyncStep("lists", "skipped", "Push de listas desligado");
  }

  logAntiBan(
    "ml_hub_sync",
    `source=${source} listed=${products.length} elec=${electronicsListed} catalog=${catalogAdded} listImport=${listImported} stores=${storesAdded} linked=${deals.length} inserted=${inserted} min=${minCommission} listAdded=${listPush?.added ?? 0} coupons=${coupons?.matched ?? 0}`,
  );

  const { recordSyncRun } = await import("./syncRuns.js");

  if (!deals.length) {
    const error =
      products.length === 0
        ? "Nenhum produto listado."
        : sessionDead
          ? sessionExpiredError()
          : "Produtos listados, mas createLink não gerou meli.la (atualize Cookie/CSRF ou reduza a quantidade).";
    setSyncStep("done", "error", error);
    finishSyncProgress({ error });
    recordSyncRun({
      source,
      ok: false,
      listed: products.length,
      linked: 0,
      inserted: 0,
      listAdded: listPush?.added ?? 0,
      error,
      detail: `elec=${electronicsListed} stores=${storesAdded}`,
      startedAt: syncStartedAt,
    });
    return {
      ok: false,
      listed: products.length,
      linked: 0,
      inserted: 0,
      minCommission,
      source,
      electronicsListed,
      catalogAdded,
      storesAdded,
      byCategory,
      top: [],
      listPush,
      paceNote,
      error,
    };
  }

  setSyncStep("done", "done", "Sync concluído");
  finishSyncProgress({ ok: true });
  recordSyncRun({
    source,
    ok: true,
    listed: products.length,
    linked: deals.length,
    inserted,
    listAdded: listPush?.added ?? 0,
    detail: `elec=${electronicsListed} stores=${storesAdded} coupons=${coupons?.matched ?? 0}`,
    startedAt: syncStartedAt,
  });
  return {
    ok: true,
    listed: products.length,
    linked: deals.length,
    inserted,
    minCommission,
    source,
    electronicsListed,
    catalogAdded,
    storesAdded,
    byCategory,
    top,
    listPush,
    coupons,
    published,
    paceNote,
  };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    finishSyncProgress({ error: msg });
    try {
      const { recordSyncRun } = await import("./syncRuns.js");
      recordSyncRun({
        source: "hub",
        ok: false,
        error: msg,
        startedAt: syncStartedAt,
      });
    } catch {
      /* ignore */
    }
    throw err;
  }
}

export async function testHubSession(): Promise<{
  ok: boolean;
  detail: string;
  shortUrl?: string | null;
  tag?: string | null;
}> {
  if (!hubSessionReady()) {
    return {
      ok: false,
      detail:
        "Faltam Cookie, CSRF ou etiqueta. Salve os 3 campos em Contas → Sessão do Hub.",
    };
  }

  const c = getMercadoLivreCreds();
  const tag = (c.hubTag || c.affiliateTag || "").trim();
  // Produto real (do seu exemplo) — prova de ponta a ponta
  const sample =
    "https://www.mercadolivre.com.br/ar-condicionado-split-hi-wall-tcl-t-pro-20-inverter-9000-btus-frio-r-32/p/MLB44302915";

  const link = await createAffiliateLink(sample);
  if (link.shortUrl) {
    return {
      ok: true,
      detail: `OK — gerou link afiliado com a tag "${tag}". Sessão válida.`,
      shortUrl: link.shortUrl,
      tag,
    };
  }

  // Diagnóstico mais fino se createLink falhou
  const r = await fetchJson(CREATE_LINK_URLS[0], {
    method: "POST",
    headers: hubHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ urls: [sample], tag }),
    redirect: "manual",
  });
  if (r.status === 301 || r.status === 302) {
    return {
      ok: false,
      detail: "Cookie expirado (redirecionou para login). Gere de novo no Hub (F12).",
      tag,
    };
  }
  if (r.status === 401 || r.status === 403) {
    return {
      ok: false,
      detail: `CSRF/Cookie rejeitados (${r.status}). Copie de novo o x-csrf-token e o Cookie da mesma requisição createLink.`,
      tag,
    };
  }
  return {
    ok: false,
    detail:
      link.error ||
      `Não gerou meli.la (HTTP ${r.status}). Confira se a tag é a do JSON (ex.: carecavip), não o @perfil.`,
    tag,
  };
}
