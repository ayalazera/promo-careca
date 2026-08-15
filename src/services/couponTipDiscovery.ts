/**
 * Descoberta de cupons digitáveis que o feed /cupons/api NÃO lista
 * (LIBROS1208, tips do TechTudo/Cuponomia, códigos sazonais).
 *
 * Fluxo:
 * 1) Coleta códigos de fontes públicas + padrões datados (LIBROS{ddmm}…)
 * 2) Resolve via POST /cupons/api/input-code → campaign_id + status
 * 3) Busca card completo em "meus cupons" / landing quando ativou
 * 4) Upsert no catálogo e marca para harvest/anúncio
 */
import { getDb, getSetting, logAntiBan, setSetting } from "../db/index.js";
import { getMercadoLivreCreds } from "./credentialVault.js";
import {
  isDigitableCouponCode,
  type MlCoupon,
  upsertCouponRow,
  parseCouponFromApiCard,
  getStoredCoupon,
  fetchCouponsFiltered,
} from "./mlCoupons.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const BASE = "https://www.mercadolivre.com.br/cupons/api";

const TIP_FEED_URLS = [
  "https://www.cuponomia.com.br/desconto/mercado-livre",
  "https://www.techtudo.com.br/noticias/2026/08/cupom-do-mercado-livre-para-usar-hoje-veja-os-melhores-de-agosto-edqualcomprar.ghtml",
];

/** Prefixos sazonais comuns no ML (código + ddmmyy curto). */
const DATED_PREFIXES = [
  "LIBROS",
  "JOGOS",
  "GAMES",
  "LIVROS",
  "LEITOR",
  "PROMO",
  "MELI",
  "OFF",
];

const STATIC_WATCHLIST = [
  "CASAINTELIGENTE",
  "PREFERIDO",
  "APROVEITA",
  "CORREPROMELI",
  "CORREPRAPROMO",
  "ECONOMIAML",
  "BRINQUEDOS",
  "OFFMELI",
  "SEMPREMODA",
  "SEMPRENAMODA",
  "COMPRINHASPRACASA",
  "QUEROCUPONS",
  "CUPOMDASEMANA",
  "SUPERPROMO",
  "SHOWDEPROMO",
  "HORADOCUPOM",
  "OFERTASML",
  "MELIACHA",
  "TECHEMCASA",
  "CLIENTEML",
  "MELIHOUSE",
  "MELIHOUSE10",
  "MELIHOUSE15",
  "MELIBRINDE",
  "MELIBRINDE10",
  "MELIBRINDE15",
  "MELIFESTA",
  "PRIMEIRACOMPRA",
  "BEMVINDO",
  "BEMVINDOML",
  "DESCUBRAML",
  "ACHADOML",
  "PROMOMELI",
  "CUPOMML",
  "MELIDAY",
];

const NOISE = new Set([
  "HTTPS",
  "HTTP",
  "HTML",
  "DOCTYPE",
  "MERCADO",
  "LIVRE",
  "CUPOM",
  "DESCONTO",
  "OFERTAS",
  "COMPRAR",
  "TECHTUDO",
  "TELEGRAM",
  "PUBLICIDADE",
  "SETTINGS",
  "PROJECT",
  "PLAYER",
  "VIDEO",
  "DESKTOP",
  "MOBILE",
  "CHANNEL",
  "TITLE",
  "CATEGORIAS",
  "OPTIONS",
  "RESOURCE",
  "MODIFIED",
  "ISSUED",
  "ONESIGNAL",
  "CONTINUA",
  "GOLPE",
  "TRACKING",
  "COMPARADOR",
  "CELULAR",
  "BELEZA",
  "DECORA",
  "TECNOLOGIA",
  "FFFFFF",
  "FFFFFF80",
  "FFFFFFCC",
]);

function hubSessionReady(): boolean {
  const c = getMercadoLivreCreds();
  return Boolean(c.hubCookie && c.hubCsrf && (c.hubTag || c.affiliateTag));
}

function couponHeaders(): HeadersInit {
  const c = getMercadoLivreCreds();
  return {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "pt-BR,pt;q=0.9",
    "User-Agent": UA,
    Origin: "https://www.mercadolivre.com.br",
    Referer: "https://www.mercadolivre.com.br/cupons",
    Cookie: c.hubCookie || "",
    "x-csrf-token": c.hubCsrf || "",
    "Content-Type": "application/json",
  };
}

function ddmmyy(d: Date): string {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}${mm}`;
}

/** Gera candidatos datados dos últimos N dias (ex.: LIBROS1208, LIBROS1408). */
export function datedCouponCandidates(daysBack = 7): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = 0; i <= daysBack; i++) {
    const d = new Date(now.getTime() - i * 86400_000);
    const stamp = ddmmyy(d);
    for (const p of DATED_PREFIXES) out.push(`${p}${stamp}`);
  }
  return out;
}

function extractCodesFromText(text: string): string[] {
  const found = new Set<string>();
  const re = /\b([A-Z][A-Z0-9]{4,22})\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const code = m[1];
    if (NOISE.has(code)) continue;
    if (!isDigitableCouponCode(code)) continue;
    // evita IDs hex / tracking
    if (/^[A-F0-9]{8,}$/.test(code) && !/[G-Z]/.test(code)) continue;
    found.add(code);
  }
  return [...found];
}

/** Heurística de % / mín / teto a partir de texto de tip. */
export function parseTipDiscountMeta(blob: string, code: string): {
  title: string;
  discountType: MlCoupon["discountType"];
  discountValue: number;
  minAmount: number | null;
  capAmount: number | null;
} {
  const up = blob.toUpperCase();
  const idx = up.indexOf(code.toUpperCase());
  const window =
    idx >= 0 ? blob.slice(Math.max(0, idx - 40), idx + 220) : blob.slice(0, 400);
  const pct = window.match(/(\d{1,2})\s*%/);
  const min =
    window.match(/a\s*partir\s*(?:de\s*)?R\$\s*([\d.]+(?:,\d+)?)/i) ||
    window.match(/m[ií]n(?:ima)?[^\d]*R\$\s*([\d.]+(?:,\d+)?)/i) ||
    window.match(/compras?\s*a\s*partir\s*R\$\s*([\d.]+(?:,\d+)?)/i);
  const cap =
    window.match(/limitad[oa]\s*(?:a\s*)?R\$\s*([\d.]+(?:,\d+)?)/i) ||
    window.match(/teto\s*R\$\s*([\d.]+(?:,\d+)?)/i) ||
    window.match(/at[eé]\s*R\$\s*([\d.]+(?:,\d+)?)/i);
  const money = (s: string | undefined) => {
    if (!s) return null;
    const n = Number(s.replace(/\./g, "").replace(",", "."));
    return Number.isFinite(n) ? n : null;
  };
  const discountValue = pct ? Number(pct[1]) : 0;
  const title =
    discountValue > 0
      ? `${discountValue}% OFF com ${code.toUpperCase()}`
      : `Cupom ${code.toUpperCase()}`;
  return {
    title,
    discountType: discountValue > 0 ? "percent" : "unknown",
    discountValue,
    minAmount: money(min?.[1]),
    capAmount: money(cap?.[1]),
  };
}

export async function scrapePublicTipCodes(): Promise<{
  codes: string[];
  snippets: Record<string, string>;
}> {
  const codes = new Set<string>(STATIC_WATCHLIST);
  const snippets: Record<string, string> = {};

  for (const c of datedCouponCandidates(10)) codes.add(c);

  // watchlist persistida (códigos que o usuário/colou ou já vimos)
  try {
    const raw = getSetting("ml_coupon_tip_watchlist", "[]");
    const arr = JSON.parse(raw) as string[];
    for (const c of arr) {
      if (isDigitableCouponCode(c)) codes.add(String(c).toUpperCase());
    }
  } catch {
    /* ignore */
  }

  for (const url of TIP_FEED_URLS) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": UA,
          "Accept-Language": "pt-BR,pt;q=0.9",
          Accept: "text/html",
        },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) continue;
      const html = await res.text();
      for (const code of extractCodesFromText(html.toUpperCase())) {
        codes.add(code);
        if (!snippets[code]) {
          const i = html.toUpperCase().indexOf(code);
          if (i >= 0) snippets[code] = html.slice(Math.max(0, i - 60), i + 200);
        }
      }
    } catch (err) {
      logAntiBan(
        "coupon_tip_scrape_err",
        `${url} ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { codes: [...codes], snippets };
}

export type InputCodeResolve = {
  code: string;
  ok: boolean;
  campaignId: string | null;
  responseCode: string | null;
  responseType: string | null;
  message: string | null;
  usable: boolean;
};

/**
 * Resolve código digitável → campaign_id (mesmo se esgotado).
 * Endpoint oficial do widget "Inserir código do cupom".
 */
export async function resolveCouponByInputCode(
  code: string,
): Promise<InputCodeResolve> {
  const clean = String(code || "").trim().toUpperCase();
  if (!isDigitableCouponCode(clean)) {
    return {
      code: clean,
      ok: false,
      campaignId: null,
      responseCode: "INVALID_FORMAT",
      responseType: "error",
      message: "código inválido",
      usable: false,
    };
  }
  if (!hubSessionReady()) {
    return {
      code: clean,
      ok: false,
      campaignId: null,
      responseCode: "NO_SESSION",
      responseType: "error",
      message: "Sessão Hub necessária",
      usable: false,
    };
  }

  try {
    const res = await fetch(`${BASE}/input-code`, {
      method: "POST",
      headers: couponHeaders(),
      body: JSON.stringify({ coupon_input_code: clean }),
      signal: AbortSignal.timeout(20000),
    });
    const json = (await res.json()) as {
      responseMessage?: { type?: string; text?: string };
      coupon?: { campaignId?: string };
      tracking?: {
        event?: {
          eventData?: {
            response_code?: string;
            response_type?: string;
            coupon?: { campaign_id?: string };
          };
        };
      };
    };
    const campaignIdRaw =
      String(
        json.coupon?.campaignId ||
          json.tracking?.event?.eventData?.coupon?.campaign_id ||
          "",
      ).trim() || null;
    const campaignId =
      campaignIdRaw && campaignIdRaw !== "0" ? campaignIdRaw : null;
    const responseCode =
      json.tracking?.event?.eventData?.response_code || null;
    const responseType =
      json.responseMessage?.type ||
      json.tracking?.event?.eventData?.response_type ||
      null;
    const message = json.responseMessage?.text || null;
    // Rate-limit / erro genérico do ML
    if (/tivemos um problema|tente novamente|too many/i.test(String(message || ""))) {
      return {
        code: clean,
        ok: false,
        campaignId: null,
        responseCode: "RATE_LIMIT",
        responseType: "error",
        message,
        usable: false,
      };
    }
    const usable = ["VALID", "PENDING", "ALREADY_ACTIVATED"].includes(
      String(responseCode || "").toUpperCase(),
    ) ||
      String(responseType).toLowerCase() === "success" ||
      /j[aá] (foi )?adicionado|pronto!|ainda pode ser usado/i.test(
        String(message || ""),
      );
    // SOLD_OUT / EXPIRED ainda têm campaignId — úteis p/ catálogo + aviso
    return {
      code: clean,
      ok: Boolean(campaignId),
      campaignId,
      responseCode,
      responseType,
      message,
      usable,
    };
  } catch (err) {
    return {
      code: clean,
      ok: false,
      campaignId: null,
      responseCode: "ERROR",
      responseType: "error",
      message: err instanceof Error ? err.message : String(err),
      usable: false,
    };
  }
}

async function findCouponCardByCampaign(
  campaignId: string,
): Promise<MlCoupon | null> {
  const sources = [
    () => fetchCouponsFiltered({}),
    async () => {
      const { status, json } = await (async () => {
        const res = await fetch(`${BASE}/main-data/my-coupons`, {
          headers: couponHeaders(),
          signal: AbortSignal.timeout(20000),
        });
        const text = await res.text();
        try {
          return { status: res.status, json: JSON.parse(text) };
        } catch {
          return { status: res.status, json: null };
        }
      })();
      if (status !== 200 || !json) return { coupons: [] as MlCoupon[] };
      const raw: unknown[] = [];
      if (Array.isArray(json.coupons)) raw.push(...json.coupons);
      if (Array.isArray(json.groupings)) {
        for (const g of json.groupings) {
          for (const c of g.coupons || []) raw.push(c);
        }
      }
      const coupons: MlCoupon[] = [];
      for (const r of raw) {
        const p = parseCouponFromApiCard(r as Record<string, unknown>, "my_coupons");
        if (p) coupons.push(p);
      }
      return { coupons };
    },
  ];

  for (const load of sources) {
    try {
      const batch = await load();
      const hit = batch.coupons.find((c) => c.campaignId === campaignId);
      if (hit) return hit;
    } catch {
      /* next */
    }
  }
  return null;
}

function statusFromResponseCode(rc: string | null, usable: boolean): string {
  const u = String(rc || "").toUpperCase();
  if (usable || u === "VALID" || u === "PENDING") return "ACTIVE";
  if (u === "SOLD_OUT") return "SOLD_OUT";
  if (u.includes("EXPIRED")) return "EXPIRED";
  if (u.startsWith("INVALID")) return "INVALID";
  return usable ? "ACTIVE" : "UNKNOWN";
}

/**
 * Descobre tips, resolve via input-code, grava no catálogo.
 * Prioriza códigos ainda não conhecidos / sem card recente.
 */
export async function discoverAndIngestTipCoupons(opts?: {
  maxResolve?: number;
  forceCodes?: string[];
}): Promise<{
  ok: boolean;
  scraped: number;
  resolved: number;
  stored: number;
  newCodes: string[];
  usable: string[];
  soldOut: string[];
  details: string[];
  error?: string;
}> {
  if (!hubSessionReady()) {
    return {
      ok: false,
      scraped: 0,
      resolved: 0,
      stored: 0,
      newCodes: [],
      usable: [],
      soldOut: [],
      details: [],
      error: "Sessão Hub necessária",
    };
  }

  const maxResolve = Math.max(3, Math.min(opts?.maxResolve ?? 28, 40));
  const { codes: scraped, snippets } = await scrapePublicTipCodes();
  const forced = (opts?.forceCodes || [])
    .map((c) => String(c || "").trim().toUpperCase())
    .filter((c) => isDigitableCouponCode(c));

  const datedSet = new Set(datedCouponCandidates(10));
  const staticSet = new Set(STATIC_WATCHLIST);
  // Cuponomia/TechTudo: só códigos “de tip”, não ruído genérico
  const tipLike = scraped.filter(
    (c) =>
      staticSet.has(c) ||
      datedSet.has(c) ||
      /MELI|CUPOM|PROMO|OFF|CASA|MODA|BRINQ|ECONOM|QUERO|APROVE|PREFER|CORRE|LIBRO|LIVRO|JOGO|GAME|LEITOR|SHOW|HORA|OFERTA|TECH|CLIENTE|SEMPRE|ACHA/i.test(
        c,
      ),
  );
  const allCodes = [...new Set([...forced, ...tipLike, ...STATIC_WATCHLIST])];

  const known = new Set(
    (
      getDb()
        .prepare(
          `SELECT upper(code) AS c FROM ml_coupons
           WHERE code IS NOT NULL AND trim(code) != ''
             AND status IN ('ACTIVE','SOLD_OUT','EXPIRED')`,
        )
        .all() as Array<{ c: string }>
    ).map((r) => r.c),
  );

  const rank = (c: string): number => {
    let s = 0;
    if (forced.includes(c)) s += 200;
    if (staticSet.has(c)) s += 80;
    if (!known.has(c) && staticSet.has(c)) s += 40;
    if (!known.has(c) && !datedSet.has(c)) s += 35;
    if (datedSet.has(c) && !known.has(c)) s += 25;
    if (/^LIBROS|^JOGOS|^LIVROS|^GAMES|^LEITOR/i.test(c) && !known.has(c)) {
      s += 15;
    }
    // Já resolvidos recentemente: baixa prioridade
    if (known.has(c)) s -= 50;
    return s;
  };

  const ranked = [...allCodes].sort((a, b) => rank(b) - rank(a));

  // No máximo 8 códigos datados por rodada (evita lotar a fila com LIBROS* inválidos)
  const picked: string[] = [];
  let datedUsed = 0;
  for (const c of ranked) {
    if (picked.length >= maxResolve) break;
    if (datedSet.has(c) && !forced.includes(c) && !staticSet.has(c)) {
      if (datedUsed >= 8) continue;
      datedUsed += 1;
    }
    picked.push(c);
  }
  const toResolve = picked;
  const details: string[] = [];
  const newCodes: string[] = [];
  const usable: string[] = [];
  const soldOut: string[] = [];
  let resolved = 0;
  let stored = 0;

  for (const code of toResolve) {
    try {
      const { mlHumanPause, noteMlRateLimit } = await import("./mlHumanPace.js");
      await mlHumanPause("coupon");
      const r = await resolveCouponByInputCode(code);
      resolved += 1;
      if (!r.campaignId) {
        if (r.responseCode === "RATE_LIMIT") {
          details.push(`${code}: RATE_LIMIT — pausando descoberta`);
          logAntiBan("coupon_tip_rate_limit", r.message || "Tivemos um problema");
          noteMlRateLimit("tip input-code");
          break;
        }
        if (r.responseCode && !String(r.responseCode).startsWith("INVALID")) {
          details.push(`${code}: ${r.responseCode} ${r.message || ""}`.trim());
        }
        continue;
      }

      const wasKnown = Boolean(getStoredCoupon(r.campaignId) || known.has(code));
      let card = await findCouponCardByCampaign(r.campaignId);
      if (!card) {
        const tip = parseTipDiscountMeta(snippets[code] || "", code);
        // Defaults razoáveis p/ LIBROS* (Dia do Leitor / jogos)
        if (/^LIBROS|^LIVROS|^LEITOR/i.test(code) && tip.discountValue <= 0) {
          tip.discountType = "percent";
          tip.discountValue = 15;
          tip.minAmount = tip.minAmount ?? 69;
          tip.capAmount = tip.capAmount ?? 30;
          tip.title = `15% OFF com ${code}`;
        }
        card = {
          campaignId: r.campaignId,
          code,
          title: tip.title,
          subtitle: "Descoberto via tip / input-code",
          status: statusFromResponseCode(r.responseCode, r.usable),
          discountType: tip.discountType,
          discountValue: tip.discountValue,
          minAmount: tip.minAmount,
          capAmount: tip.capAmount,
          listUrl: `https://lista.mercadolivre.com.br/_Container_${r.campaignId}?coupon_campaign_id=${r.campaignId}`,
          expiresAt: null,
          startsAt: null,
          sampleTitles: [],
          verticalHint: /^LIBROS|^LIVROS|^JOGOS|^GAMES|^LEITOR/i.test(code)
            ? "et_vertical"
            : null,
          rawScoreBonus: 8,
        };
      } else {
        card = {
          ...card,
          code: card.code || code,
          status: statusFromResponseCode(r.responseCode, r.usable) || card.status,
        };
        if (!card.listUrl) {
          card.listUrl = `https://lista.mercadolivre.com.br/_Container_${r.campaignId}?coupon_campaign_id=${r.campaignId}`;
        }
      }

      upsertCouponRow(card);
      stored += 1;
      if (!wasKnown) newCodes.push(code);
      if (r.usable) usable.push(code);
      if (String(r.responseCode).toUpperCase() === "SOLD_OUT") soldOut.push(code);

      try {
        const { markCouponTested } = await import("./mlCoupons.js");
        if (r.usable) {
          markCouponTested(r.campaignId, true, r.message || r.responseCode || "ok");
        } else if (
          ["SOLD_OUT", "EXPIRED", "EXPIRED_ACTION"].includes(
            String(r.responseCode || "").toUpperCase(),
          )
        ) {
          markCouponTested(
            r.campaignId,
            false,
            r.message || r.responseCode || "esgotado",
          );
        }
      } catch {
        /* ignore */
      }

      details.push(
        `${code}: cid=${r.campaignId} rc=${r.responseCode || "?"} ${r.usable ? "USABLE" : "DEAD"}`,
      );
    } catch (err) {
      details.push(
        `${code}: err ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Persiste watchlist enxuta (novos + estáticos)
  const watch = [
    ...new Set([
      ...STATIC_WATCHLIST,
      ...newCodes,
      ...forced,
      ...datedCouponCandidates(3),
    ]),
  ].slice(0, 80);
  setSetting("ml_coupon_tip_watchlist", JSON.stringify(watch));
  setSetting("ml_coupon_tips_synced_at", new Date().toISOString());
  if (newCodes.length) {
    setSetting("ml_coupon_tips_new", JSON.stringify(newCodes));
  }

  logAntiBan(
    "coupon_tip_discover",
    `scraped=${allCodes.length} resolved=${resolved} stored=${stored} new=${newCodes.join(",") || "-"} usable=${usable.join(",") || "-"} soldOut=${soldOut.join(",") || "-"}`,
  );

  return {
    ok: stored > 0 || resolved > 0,
    scraped: allCodes.length,
    resolved,
    stored,
    newCodes,
    usable,
    soldOut,
    details,
  };
}

/** Lista códigos novos da última descoberta (p/ harvest prioritário). */
export function recentTipNewCodes(): string[] {
  try {
    const raw = getSetting("ml_coupon_tips_new", "[]");
    const arr = JSON.parse(raw) as string[];
    return arr.map((c) => String(c).toUpperCase()).filter(Boolean);
  } catch {
    return [];
  }
}
