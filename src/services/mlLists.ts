/**
 * Listas públicas de afiliado no perfil social (ex.: Careca VIP Eletrônicos).
 * Usa a mesma sessão do Hub (Cookie + CSRF) contra
 * myaccount.mercadolivre.com.br/gz/navigation/api/wishlist/...
 */
import { getMercadoLivreCreds } from "./credentialVault.js";
import { getSetting, setSetting, logAntiBan, getDb } from "../db/index.js";
import type { HubProduct } from "./mlHub.js";
import { classifyProduct } from "./categories.js";
import { isTcgCollectible } from "./tcgFilter.js";
import { isVideoGameDeal } from "./gamesFilter.js";
import { categoryPriceCap } from "./dealQuality.js";
import {
  isClearlyNotElectronics,
  looksLikeElectronics,
} from "./electronicsFilter.js";
import { isLowDemandNicheTitle } from "./demandFilter.js";

const LIST_API =
  "https://myaccount.mercadolivre.com.br/gz/navigation/api";

const DEFAULT_LIST_ID = "c6876896-8b3f-4088-beb9-3ca81d6238fb";
const DEFAULT_LIST_NAME = "Careca VIP Eletrônicos";
const DEFAULT_PROFILE = "ocarafmz";

export type MlListItem = {
  itemId: string;
  productId: string | null;
  title: string;
  bookmarksId: string | null;
  url: string | null;
  price: number | null;
  originalPrice?: number | null;
  discountPct?: number | null;
  officialStore?: boolean;
};

function listHeaders(): HeadersInit {
  const c = getMercadoLivreCreds();
  const listId = getMlListId();
  return {
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    Cookie: c.hubCookie,
    "x-csrf-token": c.hubCsrf,
    Origin: "https://myaccount.mercadolivre.com.br",
    Referer: `https://myaccount.mercadolivre.com.br/bookmarks/wishlist/hub/detail/${listId}`,
  };
}

export function getMlListId(): string {
  return getSetting("ml_social_list_id", DEFAULT_LIST_ID) || DEFAULT_LIST_ID;
}

export function getMlListName(): string {
  return (
    getSetting("ml_social_list_name", DEFAULT_LIST_NAME) || DEFAULT_LIST_NAME
  );
}

export function getMlProfilePath(): string {
  const c = getMercadoLivreCreds();
  return (
    c.creatorUsername ||
    getSetting("ml_social_profile", DEFAULT_PROFILE) ||
    DEFAULT_PROFILE
  );
}

export function getMlListPublicUrl(): string {
  return `https://www.mercadolivre.com.br/social/${getMlProfilePath()}/lists/${getMlListId()}`;
}

/** Não-eletrônicos que NÃO podem ir para a lista Careca VIP Eletrônicos. */
const FASHION_BEAUTY_SUPPLEMENT = [
  "creatina",
  "suplemento",
  "whey",
  "pre treino",
  "pré-treino",
  "perfume",
  "eau de",
  "chinelo",
  "havaianas",
  "tênis",
  "tenis ",
  "tenis-",
  "short",
  "shorts",
  "bermuda",
  "camiseta",
  "camisa ",
  "calça",
  "calca",
  "roupa",
  "sandália",
  "sandalia",
  "creme ",
  "hidratante",
  "maquiagem",
  "batom",
  "shampoo",
  "condicionador",
  "cueca",
  "sutiã",
  "sutia",
  "biquíni",
  "biquini",
  "vestido",
  "blusa",
  "moletom",
  "meia ",
  "meias",
  "boné",
  "bone ",
  "fralda",
  "fraldas",
  "gel creme",
  "gel hidrat",
  "jaqueta",
  "bobojaco",
  "casaco",
  "legging",
  "henley",
  "sapatilha",
  "pote herm",
  "potes herm",
  "marmita",
];

/** Roupa / moda — nunca entra em lista de eletrônico/informática. */
export function isFashionOrBeautyTitle(title: string, url = ""): boolean {
  const t = `${title} ${url}`.toLowerCase();
  if (FASHION_BEAUTY_SUPPLEMENT.some((k) => t.includes(k))) return true;
  return /jaqueta|bobojaco|casaco|legging|henley|sapatilha|cueca|camiseta|kit \d+ (?:cuecas?|camisetas?|pares? meia)/.test(
    t,
  );
}

/**
 * O produto cabe nesta categoria de lista?
 * Usado no push e na limpeza — evita moda em Informática, tabuleiro em TCG, etc.
 */
export function productFitsListCategory(
  title: string,
  category: string,
  productUrl = "",
): boolean {
  if (isLowDemandNicheTitle(title)) return false;
  const cat = String(category || "geral")
    .split(",")[0]
    .trim()
    .toLowerCase();
  const hay = `${title} ${productUrl}`.toLowerCase();
  const got = classifyProduct({ title, productUrl, categoryHint: cat });

  if (cat === "tcg") {
    return isTcgCollectible(title, productUrl);
  }
  if (cat === "games") {
    return got === "games" || isVideoGameDeal(title, productUrl);
  }
  if (["eletronicos", "celulares", "eletrodomesticos"].includes(cat)) {
    if (isFashionOrBeautyTitle(title, productUrl)) return false;
    if (isClearlyNotElectronics(title, productUrl)) return false;
    if (/pote(?:s)? herm|marmita|jaqueta|bobojaco|casaco|legging|cueca|jogo de tabuleiro/.test(hay)) {
      return false;
    }
    // Scooter cara / bike ergométrica → esportes, não eletrônicos
    if (/bicicleta ergom|scooter el[eé]tric|bomba el[eé]trica port[aá]til/.test(hay)) {
      return false;
    }
    return (
      ["eletronicos", "celulares", "eletrodomesticos", "informatica"].includes(got) &&
      isElectronicsProduct({ title, productUrl, category: got })
    );
  }
  if (cat === "informatica") {
    if (isFashionOrBeautyTitle(title, productUrl)) return false;
    if (
      /toner|cartucho|interfone|porteiro|aparador de pelos|barbeador|m[aá]quina(?: de)? barbear/.test(
        hay,
      )
    ) {
      return false;
    }
    // Só informática de uso comum (PC/periféricos) — não toner/impressora niche
    return (
      got === "informatica" &&
      /notebook|ssd|mem[oó]ria|mouse|teclado|monitor|roteador|webcam|hub usb|dock|processador|placa de v[ií]deo/.test(
        hay,
      )
    );
  }
  if (cat === "esportes") {
    if (/scooters?\s*el[eé]tric/.test(hay)) return false;
    // Compressor / bomba / inflador NÃO é fitness
    if (
      /compressor|bomba el[eé]tric|inflador|mini\s*compressor|interfone|porteiro/.test(
        hay,
      )
    ) {
      return false;
    }
    return (
      got === "esportes" ||
      /creatina|whey|suplemento|bicicleta|ergom|halter|esteira|colchonete|corda de pular|kettlebell/.test(
        hay,
      )
    );
  }
  if (cat === "casa") {
    return got === "casa" || got === "eletrodomesticos";
  }
  if (cat === "moda") {
    return got === "moda";
  }
  if (cat === "geral") return true;
  return got === cat;
}

/** Heurística: produtos para a lista de eletrônicos. Exclusões vencem a categoria. */
export function isElectronicsProduct(p: {
  title: string;
  productUrl: string;
  category?: string | null;
}): boolean {
  const t = `${p.title} ${p.productUrl}`.toLowerCase();
  if (isClearlyNotElectronics(p.title, p.productUrl)) return false;
  if (isFashionOrBeautyTitle(p.title, p.productUrl)) return false;
  if (/pote(?:s)? herm|marmita|jaqueta|bobojaco|casaco|legging|jogo de tabuleiro|bicicleta ergom|scooter el[eé]tric/.test(t)) {
    return false;
  }
  // “jaqueta com fones” não é fone de ouvido
  if (/jaqueta|casaco|bobojaco|camiseta|cueca/.test(t) && /fone/.test(t)) {
    return false;
  }

  // Preferência: sinal positivo explícito de tech.
  if (looksLikeElectronics(p.title, p.productUrl)) return true;

  const keys = [
    "eletronic",
    "celular",
    "smartphone",
    "iphone",
    "samsung",
    "xiaomi",
    "motorola",
    "fone",
    "headset",
    "earbud",
    "airpod",
    "tv ",
    "smart tv",
    "tv-box",
    "tv box",
    "notebook",
    "laptop",
    "carregador",
    "usb",
    "caixa de som",
    "soundbar",
    "mouse",
    "teclado",
    "monitor",
    "tablet",
    "camera",
    "câmera",
    "drone",
    "console",
    "playstation",
    "xbox",
    "nintendo",
    "ssd",
    "hd externo",
    "roteador",
    "wifi",
    "smartwatch",
    "bomba elétr",
    "bomba eletr",
    "inflador",
    "lava jato",
    "aspirador",
    "robô aspir",
    "robo aspir",
    "processador",
    "placa de video",
    "gpu",
    "ar-condicionado",
    "ar condicionado",
    "inverter",
    "aparador de pelos",
    "barbeador",
    "impressora",
    "multifuncional",
    "power bank",
    "pendrive",
    "alexa",
    "echo ",
    "kindle",
    "projetor",
    "webcam",
  ];
  if (keys.some((k) => t.includes(k))) return true;
  // Categoria já classificada como tech — só se não for anti-padrão.
  if (
    p.category &&
    ["eletronicos", "celulares", "informatica", "eletrodomesticos"].includes(
      p.category,
    )
  ) {
    return looksLikeElectronics(p.title, p.productUrl);
  }
  return false;
}

async function api(
  path: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {
  const res = await fetch(LIST_API + path, {
    ...init,
    headers: { ...listHeaders(), ...(init?.headers || {}) },
    redirect: "manual",
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ignore */
  }
  return { ok: res.ok, status: res.status, json, text };
}

function tidyListName(id: string, name: string): string {
  const n = String(name || "").trim();
  if (
    !n ||
    /^ir para a lista$/i.test(n) ||
    /^lista ml$/i.test(n) ||
    n === "Lista" ||
    /^careca vip$/i.test(n)
  ) {
    if (id === getMlListId()) {
      const stored = getSetting("ml_social_list_name", DEFAULT_LIST_NAME);
      if (stored && !/^careca vip$/i.test(stored) && !/^ir para/i.test(stored)) {
        return stored;
      }
      return DEFAULT_LIST_NAME;
    }
    return "Lista ML";
  }
  return n.slice(0, 80);
}

let listsCache: {
  at: number;
  data: Array<{ id: string; name: string; total: number; type: string }>;
} | null = null;
const LIST_CACHE_MS = 90_000;
const itemsCache = new Map<string, { at: number; items: MlListItem[] }>();
const ITEMS_CACHE_MS = 45_000;

export async function listAffiliateLists(opts?: {
  force?: boolean;
}): Promise<
  Array<{ id: string; name: string; total: number; type: string }>
> {
  if (
    !opts?.force &&
    listsCache &&
    Date.now() - listsCache.at < LIST_CACHE_MS
  ) {
    return listsCache.data;
  }
  const byId = new Map<
    string,
    { id: string; name: string; total: number; type: string }
  >();
  const put = (
    l: { id: string; name: string; total?: number; type?: string },
    preferName = false,
  ) => {
    if (!l.id) return;
    const prev = byId.get(l.id);
    const name = tidyListName(l.id, l.name || prev?.name || "Lista ML");
    byId.set(l.id, {
      id: l.id,
      name: preferName && l.name ? tidyListName(l.id, l.name) : name,
      total: Math.max(Number(l.total) || 0, prev?.total || 0),
      type: l.type || prev?.type || "public",
    });
  };

  const r = await api("/wishlist/lists/all");
  if (r.ok && r.json) {
    const lists =
      ((r.json as { lists?: Array<Record<string, unknown>> })?.lists) || [];
    for (const l of lists) {
      put({
        id: String(l.id || ""),
        name: String(l.name || ""),
        total: Number(
          (l.elements as { total?: number } | undefined)?.total || 0,
        ),
        type: String(l.type || "hub"),
      });
    }
  }

  for (const l of await fetchPublicProfileLists()) put(l);
  for (const l of readManualLists()) put(l, true);
  for (const [cat, entry] of Object.entries(getListMap())) {
    if (entry?.id) {
      put({
        id: entry.id,
        name: entry.name || `Lista (${cat})`,
        total: 0,
        type: "mapped",
      });
    }
  }

  // default list always present
  put({ id: getMlListId(), name: getMlListName(), type: "default" }, true);

  const mapped = [...byId.values()].sort((a, b) =>
    a.name.localeCompare(b.name, "pt-BR"),
  );
  if (mapped.length) {
    setSetting("ml_lists_cache", JSON.stringify(mapped));
  }
  listsCache = { at: Date.now(), data: mapped };
  return mapped;
}

function readManualLists(): Array<{
  id: string;
  name: string;
  total: number;
  type: string;
}> {
  try {
    const raw = getSetting("ml_lists_manual", "[]");
    const arr = JSON.parse(raw) as Array<{
      id: string;
      name: string;
      total?: number;
    }>;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x) => x?.id)
      .map((x) => ({
        id: String(x.id),
        name: String(x.name || "Lista ML"),
        total: Number(x.total) || 0,
        type: "manual",
      }));
  } catch {
    return [];
  }
}

function saveManualLists(
  lists: Array<{ id: string; name: string; total: number; type?: string }>,
): void {
  setSetting(
    "ml_lists_manual",
    JSON.stringify(
      lists.map((l) => ({
        id: l.id,
        name: l.name,
        total: l.total || 0,
      })),
    ),
  );
}

export function parseListIdFromInput(input: string): string | null {
  const m = String(input || "").match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  );
  return m ? m[0].toLowerCase() : null;
}

/** Cadastra lista pelo link público (necessário quando Hub expirou ou lista nova ainda não indexou no perfil). */
export async function registerListByUrl(
  input: string,
  nameHint?: string,
): Promise<{ id: string; name: string; total: number; url: string }> {
  const id = parseListIdFromInput(input);
  if (!id) {
    throw new Error(
      "Cole o link completo da lista (…/lists/uuid) ou o UUID da lista",
    );
  }
  const page = await fetchPublicListPage(id, 1);
  if (!page.ok) {
    throw new Error(
      "Não abriu a lista no ML. Confira se o link é público (perfil social).",
    );
  }
  const extracted =
    extractListNameFromHtml(page.html, id) ||
    nameHint?.trim() ||
    "Lista ML";
  const total =
    extractTotalResultsFromHtml(page.html) ?? page.items.length ?? 0;
  const name = tidyListName(id, extracted);
  const manual = readManualLists().filter((l) => l.id !== id);
  manual.push({ id, name, total, type: "manual" });
  saveManualLists(manual);

  try {
    const cache = JSON.parse(getSetting("ml_lists_cache", "[]")) as Array<{
      id: string;
      name: string;
      total: number;
      type: string;
    }>;
    const next = Array.isArray(cache) ? cache.filter((l) => l.id !== id) : [];
    next.push({ id, name, total, type: "manual" });
    setSetting("ml_lists_cache", JSON.stringify(next));
  } catch {
    /* ignore */
  }

  logAntiBan("ml_list_register", `id=${id} name=${name} total=${total}`);
  return {
    id,
    name,
    total,
    url: `https://www.mercadolivre.com.br/social/${getMlProfilePath()}/lists/${id}`,
  };
}

export async function checkHubListsSession(): Promise<{
  ok: boolean;
  status: number;
  hint?: string;
}> {
  const r = await api("/wishlist/lists/all");
  if (r.ok && r.json) return { ok: true, status: r.status };
  if (r.status === 302 || r.status === 401 || r.status === 403) {
    return {
      ok: false,
      status: r.status,
      hint: "Sessão do Hub expirada — atualize Cookie e CSRF em Contas para listar listas privadas e empurrar produtos.",
    };
  }
  return {
    ok: false,
    status: r.status,
    hint: "Hub não retornou listas. Use o link público da lista para cadastrar manualmente.",
  };
}

async function fetchPublicProfileLists(): Promise<
  Array<{ id: string; name: string; total: number; type: string }>
> {
  const profile = getMlProfilePath();
  try {
    const res = await fetch(
      `https://www.mercadolivre.com.br/social/${profile}/lists`,
      {
        headers: {
          Accept: "text/html",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        },
        redirect: "follow",
        signal: AbortTimeout(15000),
      },
    );
    if (!res.ok) return [];
    const html = await res.text();
    const out: Array<{ id: string; name: string; total: number; type: string }> =
      [];
    const seen = new Set<string>();

    // JSON embutido: "lists":[{"id":"…","name":"…"}]
    for (const m of html.matchAll(
      /"id"\s*:\s*"([0-9a-f-]{36})"\s*,\s*"name"\s*:\s*"((?:\\.|[^"\\])*)"/gi,
    )) {
      const id = m[1].toLowerCase();
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        name: tidyListName(id, decodeMlText(m[2])),
        total: 0,
        type: "public",
      });
    }

    const re =
      /\/social\/[^/]+\/lists\/([0-9a-f-]{20,})[^"]*"[^>]*>[\s\S]{0,200}?([A-Za-zÁ-ú0-9][^<]{3,80})/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
      const id = m[1].toLowerCase();
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        name: tidyListName(id, m[2].trim()),
        total: 0,
        type: "public",
      });
    }
    for (const id of [
      ...html.matchAll(/\/lists\/([0-9a-f-]{20,})/gi),
    ].map((x) => x[1].toLowerCase())) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        name: tidyListName(id, "Lista ML"),
        total: 0,
        type: "public",
      });
    }
    return out.slice(0, 40);
  } catch {
    return [];
  }
}

function AbortTimeout(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}

export function getListMap(): Record<string, { id: string; name: string }> {
  try {
    const raw = getSetting("ml_list_map", "");
    if (!raw) {
      return {
        eletronicos: { id: getMlListId(), name: getMlListName() },
        celulares: { id: getMlListId(), name: getMlListName() },
        informatica: { id: getMlListId(), name: getMlListName() },
      };
    }
    return JSON.parse(raw) as Record<string, { id: string; name: string }>;
  } catch {
    return { eletronicos: { id: getMlListId(), name: getMlListName() } };
  }
}

export function saveListMap(map: Record<string, { id: string; name: string }>): void {
  setSetting("ml_list_map", JSON.stringify(map));
}

export function listIdForCategory(category: string): string {
  const cat = category || "geral";
  const pinned = getDb()
    .prepare(
      `SELECT ml_list_id FROM wa_groups
       WHERE ml_list_id IS NOT NULL AND TRIM(ml_list_id) != ''
         AND (categories = ? OR categories LIKE ? OR categories LIKE ? OR categories LIKE ?)
       ORDER BY id ASC LIMIT 1`,
    )
    .get(cat, `${cat},%`, `%,${cat}`, `%,${cat},%`) as
    | { ml_list_id?: string }
    | undefined;
  if (pinned?.ml_list_id) return String(pinned.ml_list_id).trim();
  const map = getListMap();
  if (map[cat]?.id) return map[cat].id;
  // Moda/beleza → Achadinhos (nunca Informática, que é o default antigo)
  if (["moda", "beleza"].includes(cat) && map.geral?.id) {
    return map.geral.id;
  }
  if (
    ["eletronicos", "celulares", "eletrodomesticos"].includes(cat) &&
    map.eletronicos?.id
  ) {
    return map.eletronicos.id;
  }
  // informatica tem lista própria — não herdar Eletrônicos
  if (cat === "informatica" && map.informatica?.id) {
    return map.informatica.id;
  }
  if (map.geral?.id) return map.geral.id;
  return getMlListId();
}

function logListEvent(
  action: string,
  opts: { listId?: string; itemId?: string; ok: boolean; detail?: string },
): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO ml_list_events (list_id, item_id, action, ok, detail)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        opts.listId || "",
        opts.itemId || "",
        action,
        opts.ok ? 1 : 0,
        (opts.detail || "").slice(0, 240),
      );
  } catch {
    /* tabela criada no boot */
  }
  logAntiBan(
    `ml_list_${action}`,
    `list=${opts.listId || ""} item=${opts.itemId || ""} ok=${opts.ok ? 1 : 0} ${opts.detail || ""}`.slice(0, 240),
  );
}

function parseListCards(json: unknown): MlListItem[] {
  const root = json as {
    list?: {
      elements?: {
        polycards?: Array<{
          metadata?: Record<string, string>;
          components?: Array<{
            id?: string;
            title?: { text?: string };
            price?: { current_price?: { value?: number } };
          }>;
        }>;
        total?: number;
      };
    };
  };
  const cards = root.list?.elements?.polycards || [];
  const fromCards = cards.map((card) => {
    const meta = card.metadata || {};
    const title =
      card.components?.find((c) => c.id === "title")?.title?.text ||
      meta.id ||
      "";
    const price =
      card.components?.find((c) => c.id === "price")?.price?.current_price
        ?.value ?? null;
    const url = meta.url
      ? meta.url.startsWith("http")
        ? meta.url
        : `https://${meta.url}`
      : null;
    return {
      itemId: String(meta.id || meta.origin_id || ""),
      productId: meta.product_id || null,
      title,
      bookmarksId: meta.bookmarks_id || null,
      url,
      price,
    };
  });
  if (fromCards.length) return fromCards.filter((x) => x.itemId);

  const ids = [
    ...new Set(
      [...JSON.stringify(json || {}).matchAll(/"(MLB\d{8,})"/g)].map((m) => m[1]),
    ),
  ];
  return ids.map((itemId) => ({
    itemId,
    productId: null,
    title: itemId,
    bookmarksId: null,
    url: `https://produto.mercadolivre.com.br/${itemId.replace(/^MLB/i, "MLB-")}`,
    price: null,
  }));
}

async function hydrateItemsFromPublicApi(
  items: MlListItem[],
): Promise<MlListItem[]> {
  const ids = [
    ...new Set(
      items
        .map((it) => {
          const m = String(it.itemId || "").match(/\bMLB-?(\d{6,})\b/i);
          return m ? `MLB${m[1]}` : "";
        })
        .filter(Boolean),
    ),
  ];
  if (!ids.length) return items;

  const byId = new Map<
    string,
    {
      title: string;
      price: number | null;
      url: string | null;
      originalPrice: number | null;
      officialStore: boolean;
    }
  >();

  for (let i = 0; i < ids.length; i += 20) {
    const batch = ids.slice(i, i + 20);
    try {
      const res = await fetch(
        `https://api.mercadolibre.com/items?ids=${batch.join(",")}`,
        {
          headers: {
            Accept: "application/json",
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          },
          signal: AbortTimeout(20000),
        },
      );
      if (!res.ok) continue;
      const json = (await res.json()) as Array<{
        code?: number;
        body?: {
          id?: string;
          title?: string;
          price?: number;
          original_price?: number | null;
          permalink?: string;
          official_store_id?: number | null;
        };
      }>;
      for (const row of Array.isArray(json) ? json : []) {
        const b = row.body;
        if (!b?.id) continue;
        const orig =
          typeof b.original_price === "number" && b.original_price > 0
            ? b.original_price
            : null;
        byId.set(String(b.id).toUpperCase(), {
          title: b.title || "",
          price: typeof b.price === "number" ? b.price : null,
          url: b.permalink || null,
          originalPrice: orig,
          officialStore: Number(b.official_store_id) > 0,
        });
      }
    } catch {
      /* segue com o que tiver */
    }
    if (i + 20 < ids.length) {
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  return items.map((it) => {
    const key = String(it.itemId || "")
      .replace(/-/g, "")
      .toUpperCase();
    const h = byId.get(key);
    if (!h) return it;
    const disc =
      h.originalPrice && h.price && h.originalPrice > h.price + 0.009
        ? Math.round(((h.originalPrice - h.price) / h.originalPrice) * 100)
        : null;
    return {
      ...it,
      itemId: key,
      title: h.title || it.title,
      price: h.price ?? it.price,
      url: h.url || it.url,
      originalPrice: h.originalPrice ?? it.originalPrice,
      discountPct: disc,
      officialStore: h.officialStore,
    };
  });
}

export async function getListItems(
  listId = getMlListId(),
  opts?: { force?: boolean },
): Promise<MlListItem[]> {
  const cached = itemsCache.get(listId);
  if (
    !opts?.force &&
    cached &&
    Date.now() - cached.at < ITEMS_CACHE_MS
  ) {
    return cached.items;
  }
  // Hub devolve ~16/página; tentar offsets de 16 (quando a sessão estiver válida).
  const pageSize = 16;
  const hubItems: MlListItem[] = [];
  const hubSeen = new Set<string>();
  let apiOk = false;
  for (let offset = 0; offset < 500; offset += pageSize) {
    const r = await api(
      `/wishlist/list/details/${listId}?offset=${offset}&limit=${pageSize}`,
    );
    if (!r.ok || r.json == null) break;
    apiOk = true;
    const batch = parseListCards(r.json);
    if (!batch.length) break;
    let added = 0;
    for (const it of batch) {
      const key = it.itemId || it.bookmarksId || it.title;
      if (!key || hubSeen.has(key)) continue;
      hubSeen.add(key);
      hubItems.push(it);
      added++;
    }
    if (added === 0 || batch.length < pageSize) break;
    await new Promise((r) => setTimeout(r, 400 + Math.random() * 400));
  }

  // Página pública social é a fonte completa (várias ?page=); Hub às vezes só 1 página.
  const publicItems = await fetchPublicListItems(listId);
  const byId = new Map<string, MlListItem>();
  for (const it of publicItems) {
    if (it.itemId) byId.set(it.itemId, it);
  }
  for (const it of hubItems) {
    if (!it.itemId) continue;
    const prev = byId.get(it.itemId);
    byId.set(it.itemId, {
      ...(prev || it),
      ...it,
      title: it.title && it.title !== it.itemId ? it.title : prev?.title || it.title,
      price: it.price ?? prev?.price ?? null,
      url: it.url || prev?.url || null,
      bookmarksId: it.bookmarksId || prev?.bookmarksId || null,
      discountPct: it.discountPct ?? prev?.discountPct ?? null,
      originalPrice: it.originalPrice ?? prev?.originalPrice ?? null,
    });
  }
  const collected =
    byId.size > 0
      ? [...byId.values()]
      : hubItems.length
        ? hubItems
        : publicItems;

  // Ordenar por desconto desc (não pela ordem de insert)
  collected.sort((a, b) => {
    const da = Number(a.discountPct) || 0;
    const db = Number(b.discountPct) || 0;
    if (db !== da) return db - da;
    const pa = Number(a.price) || Number.POSITIVE_INFINITY;
    const pb = Number(b.price) || Number.POSITIVE_INFINITY;
    return pa - pb;
  });

  if (!collected.length && apiOk) {
    logAntiBan("ml_list_empty", `list=${listId} hubOk mas sem polycards`);
  }
  const hydrated = await hydrateItemsFromPublicApi(collected);
  itemsCache.set(listId, { at: Date.now(), items: hydrated });
  return hydrated;
}

function decodeMlText(s: string): string {
  return s
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) =>
      String.fromCharCode(parseInt(h, 16)),
    )
    .replace(/\\\//g, "/")
    .replace(/\\"/g, '"');
}

function parsePolycardsFromHtml(html: string): MlListItem[] {
  const unescaped = html.replace(/\\u002F/gi, "/");
  const items: MlListItem[] = [];
  const seen = new Set<string>();

  // Página 1 (e às vezes outras): polycards embutidos em JSON no HTML
  const chunks = unescaped.split(/"metadata"\s*:\s*\{/);
  for (const chunk of chunks) {
    const idM = chunk.match(/"id"\s*:\s*"(MLB\d{6,})"/i);
    if (!idM) continue;
    const itemId = idM[1].toUpperCase();
    if (seen.has(itemId)) continue;
    const titleM = chunk.match(
      /"title"\s*:\s*\{\s*"text"\s*:\s*"((?:\\.|[^"\\])*)"/,
    );
    const priceM = chunk.match(
      /"current_price"\s*:\s*\{\s*"value"\s*:\s*([0-9.]+)/,
    );
    const urlM = chunk.match(/"url"\s*:\s*"([^"]+)"/);
    const bmM = chunk.match(/"bookmark_id"\s*:\s*"([^"]+)"/);
    const title = titleM ? decodeMlText(titleM[1]) : "";
    if (!title && !priceM) continue;
    seen.add(itemId);
    const rawUrl = urlM ? decodeMlText(urlM[1]).replace(/\\\//g, "/") : "";
    const url = rawUrl
      ? rawUrl.startsWith("http")
        ? rawUrl
        : `https://${rawUrl}`
      : `https://produto.mercadolivre.com.br/${itemId.replace(/^MLB/i, "MLB-")}`;
    items.push({
      itemId,
      productId: null,
      title: title || itemId,
      bookmarksId: bmM?.[1] || null,
      url,
      price: priceM ? Number(priceM[1]) : null,
    });
  }
  if (items.length) return items;

  // Páginas 2+: SSR com <a class="poly-component__title"> e wid=MLB…
  const htmlPairs = [
    ...html.matchAll(
      /wid=(MLB\d{6,})[^"]*"[^>]*class="poly-component__title">([^<]{3,200})</gi,
    ),
  ];
  for (const m of htmlPairs) {
    const itemId = m[1].toUpperCase();
    if (seen.has(itemId)) continue;
    seen.add(itemId);
    const after = html.slice(m.index ?? 0, (m.index ?? 0) + 1600);
    const priceM = after.match(
      /andes-money-amount__fraction[^>]*>\s*([\d.]+)/i,
    );
    const centsM = after.match(
      /andes-money-amount__cents[^>]*>\s*(\d{1,2})/i,
    );
    let price: number | null = null;
    if (priceM) {
      price = Number(priceM[1].replace(/\./g, ""));
      if (centsM) price += Number(centsM[1]) / 100;
    }
    items.push({
      itemId,
      productId: null,
      title: decodeMlText(m[2]).trim() || itemId,
      bookmarksId: null,
      url: `https://produto.mercadolivre.com.br/${itemId.replace(/^MLB/i, "MLB-")}`,
      price,
    });
  }
  return items;
}

function extractTotalResultsFromHtml(html: string): number | null {
  const m = html.match(/"total_results"\s*:\s*(\d+)/i);
  if (m) return Number(m[1]);
  return null;
}

function extractListNameFromHtml(html: string, listId: string): string | null {
  const unescaped = html.replace(/\\u002F/gi, "/");
  // Nome real da lista no perfil social (ex.: Careca VIP Eletrônicos)
  const patterns = [
    /"list_name"\s*:\s*"([^"\\]{3,80})"/i,
    /"name"\s*:\s*"(Careca VIP[^"\\]{0,60})"/i,
    /"title"\s*:\s*"(Careca VIP[^"\\]{0,60})"/i,
    /Careca VIP Eletr[oô]nicos/i,
  ];
  for (const re of patterns) {
    const m = unescaped.match(re);
    if (!m) continue;
    const name = (m[1] || m[0] || "").trim();
    if (
      name &&
      !/^ir para/i.test(name) &&
      !/perfil social/i.test(name) &&
      name.length >= 3
    ) {
      return name.slice(0, 80);
    }
  }
  if (/Careca VIP Eletr/i.test(unescaped) && listId === getMlListId()) {
    return DEFAULT_LIST_NAME;
  }
  return null;
}

async function fetchPublicListPage(
  listId: string,
  page: number,
): Promise<{ items: MlListItem[]; html: string; ok: boolean }> {
  const base = `https://www.mercadolivre.com.br/social/${getMlProfilePath()}/lists/${listId}`;
  const url = page <= 1 ? base : `${base}?page=${page}`;
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "text/html",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      },
      signal: AbortTimeout(20000),
    });
    if (!res.ok) return { items: [], html: "", ok: false };
    const html = await res.text();
    const fromCards = parsePolycardsFromHtml(html);
    return { items: fromCards, html, ok: true };
  } catch {
    return { items: [], html: "", ok: false };
  }
}

async function fetchPublicListItems(listId: string): Promise<MlListItem[]> {
  const all: MlListItem[] = [];
  const seen = new Set<string>();
  const maxPages = 20;
  let expectedTotal: number | null = null;
  for (let page = 1; page <= maxPages; page++) {
    const { items, html, ok } = await fetchPublicListPage(listId, page);
    if (!ok) break;
    if (page === 1) {
      expectedTotal = extractTotalResultsFromHtml(html);
      const name = extractListNameFromHtml(html, listId);
      if (name) {
        const current = getSetting("ml_social_list_name", "");
        if (
          listId === getMlListId() &&
          (!current ||
            /^careca vip$/i.test(current) ||
            /^ir para/i.test(current) ||
            /^lista ml$/i.test(current))
        ) {
          setSetting("ml_social_list_name", name);
        }
      }
      // Atualiza total no cache da lista para o select do painel
      try {
        const cached = JSON.parse(getSetting("ml_lists_cache", "[]")) as Array<{
          id: string;
          name: string;
          total: number;
          type: string;
        }>;
        if (Array.isArray(cached) && expectedTotal != null) {
          const next = cached.map((l) =>
            l.id === listId
              ? {
                  ...l,
                  name: tidyListName(l.id, name || l.name),
                  total: expectedTotal as number,
                }
              : { ...l, name: tidyListName(l.id, l.name) },
          );
          setSetting("ml_lists_cache", JSON.stringify(next));
        }
      } catch {
        /* ignore */
      }
    }
    let added = 0;
    for (const it of items) {
      if (!it.itemId || seen.has(it.itemId)) continue;
      seen.add(it.itemId);
      all.push(it);
      added++;
    }
    // página cheia no ML social costuma ter 16 itens; menos = última
    if (items.length === 0 || added === 0) break;
    if (expectedTotal != null && all.length >= expectedTotal) break;
    if (items.length < 16) break;
    await new Promise((r) => setTimeout(r, 180));
  }

  if (all.length) {
    logAntiBan(
      "ml_list_public_pages",
      `list=${listId} items=${all.length}`,
    );
    return all;
  }

  // fallback: só IDs na 1ª página
  const first = await fetchPublicListPage(listId, 1);
  const items: MlListItem[] = [];
  const re = /(?:wid=|\"id\"\s*:\s*\")(MLB-?\d{6,})/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(first.html))) {
    const num = m[1].replace(/-/g, "").toUpperCase();
    const itemId = num.startsWith("MLB") ? num : `MLB${num}`;
    if (seen.has(itemId)) continue;
    seen.add(itemId);
    items.push({
      itemId,
      productId: null,
      title: itemId,
      bookmarksId: null,
      url: `https://produto.mercadolivre.com.br/${itemId.replace(/^MLB/i, "MLB-")}`,
      price: null,
    });
    if (items.length >= 80) break;
  }
  return items;
}

export async function addItemToList(
  itemId: string,
  listId = getMlListId(),
): Promise<{ ok: boolean; detail: string }> {
  if (!/^MLB\d+/i.test(itemId)) {
    return { ok: false, detail: `itemId inválido: ${itemId}` };
  }
  const r = await api("/wishlist/elements/add", {
    method: "POST",
    body: JSON.stringify({
      entity_id: itemId,
      entity_type: "item",
      platform: "marketplace",
      platform_id: 1,
      list_ids: [listId],
    }),
  });
  const msg =
    (r.json as { component?: { message?: string } })?.component?.message ||
    r.text.slice(0, 120);
  if (!r.ok) {
    logListEvent("add", { listId, itemId, ok: false, detail: msg });
    return { ok: false, detail: msg };
  }
  logListEvent("add", { listId, itemId, ok: true, detail: msg || "adicionado" });
  return { ok: true, detail: msg || "adicionado" };
}

export async function removeItemFromList(
  itemId: string,
  opts?: { listId?: string; bookmarksId?: string | null },
): Promise<{ ok: boolean; detail: string }> {
  const listId = opts?.listId || getMlListId();
  const mlbMatch = String(itemId || "").match(/\bMLB-?(\d{6,})\b/i);
  const mlb = mlbMatch ? `MLB${mlbMatch[1]}` : String(itemId || "").trim().toUpperCase();
  const bmRaw = String(opts?.bookmarksId || "").trim();
  // Só confia no bookmarksId se ele apontar para o MESMO MLB (senão remove outro item
  // e o painel acha que deu certo — playmat “Apagar” sem sumir).
  const bmOk =
    bmRaw &&
    (!mlb || new RegExp(`\\b${mlb.replace(/^MLB/i, "MLB-?")}\\b`, "i").test(bmRaw))
      ? bmRaw
      : "";

  const attempts: Array<{ path: string; body: Record<string, unknown> }> = [];
  // MLB primeiro — é o identificador estável do anúncio na lista.
  if (mlb) {
    attempts.push(
      { path: `/wishlist/elements/delete/${mlb}`, body: { list_ids: [listId] } },
      {
        path: `/wishlist/elements/delete/${mlb}`,
        body: { list_id: listId, list_ids: [listId] },
      },
      { path: `/wishlist/elements/delete/${mlb}`, body: {} },
    );
  }
  if (bmOk) {
    attempts.push({
      path: `/wishlist/elements/delete/${encodeURIComponent(bmOk)}`,
      body: { list_ids: [listId] },
    });
  }

  let last = "falhou";
  for (const a of attempts) {
    const r = await api(a.path, {
      method: "DELETE",
      body: JSON.stringify(a.body),
    });
    const msg =
      (r.json as { component?: { message?: string } })?.component?.message ||
      r.text.slice(0, 160);
    if (r.ok) {
      logListEvent("remove", {
        listId,
        itemId: mlb || bmOk,
        ok: true,
        detail: msg || "removido",
      });
      return { ok: true, detail: msg || "removido" };
    }
    last = msg || `HTTP ${r.status}`;
  }
  logListEvent("remove", {
    listId,
    itemId: mlb || bmOk,
    ok: false,
    detail: last,
  });
  return { ok: false, detail: last };
}

/** Remove um MLB de todas as listas conhecidas (mapa + cache). */
export async function removeItemFromAllKnownLists(
  itemId: string,
): Promise<{ removed: number; tried: number; details: string[] }> {
  const mlbMatch = String(itemId || "").match(/\bMLB-?(\d{6,})\b/i);
  const mlb = mlbMatch ? `MLB${mlbMatch[1]}` : "";
  if (!mlb) return { removed: 0, tried: 0, details: ["sem MLB"] };

  const ids = new Set<string>();
  ids.add(getMlListId());
  for (const v of Object.values(getListMap())) {
    if (v?.id) ids.add(v.id);
  }
  try {
    const cached = JSON.parse(getSetting("ml_lists_cache", "[]")) as Array<{
      id: string;
    }>;
    for (const l of cached) if (l?.id) ids.add(l.id);
  } catch {
    /* ignore */
  }

  let removed = 0;
  let tried = 0;
  const details: string[] = [];
  for (const listId of ids) {
    tried++;
    const res = await removeItemFromList(mlb, { listId });
    if (res.ok) {
      removed++;
      details.push(`${listId}: ok`);
    } else {
      details.push(`${listId}: ${res.detail}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return { removed, tried, details: details.slice(0, 20) };
}

export async function removeItemsFromList(
  items: Array<{ itemId: string; bookmarksId?: string | null }>,
  listId = getMlListId(),
): Promise<{ removed: number; failed: number; errors: string[] }> {
  let removed = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const it of items) {
    if (!it.itemId && !it.bookmarksId) {
      failed++;
      continue;
    }
    const res = await removeItemFromList(it.itemId || "", {
      listId,
      bookmarksId: it.bookmarksId,
    });
    if (res.ok) removed++;
    else {
      failed++;
      errors.push(`${it.itemId}: ${res.detail}`);
    }
    await new Promise((r) => setTimeout(r, 250 + Math.random() * 250));
  }
  logAntiBan(
    "ml_list_remove",
    `list=${listId} removed=${removed} failed=${failed}`,
  );
  return { removed, failed, errors: errors.slice(0, 12) };
}

export async function pushElectronicsToList(
  products: HubProduct[],
  opts?: { listId?: string; onlyElectronics?: boolean; maxPush?: number },
): Promise<{
  attempted: number;
  added: number;
  skipped: number;
  errors: string[];
  listUrl: string;
}> {
  const listId = opts?.listId || getMlListId();
  const onlyElectronics = opts?.onlyElectronics !== false;
  const pool = onlyElectronics
    ? products.filter((p) => isElectronicsProduct(p))
    : products;

  const maxPush = Math.max(
    1,
    Math.min(
      16,
      opts?.maxPush ??
        (Number(getSetting("ml_list_push_max_per_sync", "6")) || 6),
    ),
  );

  const existing = new Set(
    (await getListItems(listId)).map((x) => x.itemId).filter(Boolean),
  );

  let added = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const p of pool) {
    if (added >= maxPush) {
      skipped += 1;
      continue;
    }
    const m = String(p.itemId || "").match(/\bMLB-?(\d{6,})\b/i);
    const itemId = m ? `MLB${m[1]}` : "";
    if (!/^MLB\d{6,}/i.test(itemId)) {
      skipped++;
      continue;
    }
    if (existing.has(itemId)) {
      skipped++;
      continue;
    }
    const res = await addItemToList(itemId, listId);
    if (res.ok) {
      added++;
      existing.add(itemId);
    } else {
      errors.push(`${itemId}: ${res.detail}`);
    }
    await new Promise((r) => setTimeout(r, 1200 + Math.random() * 800));
  }

  logAntiBan(
    "ml_list_push",
    `list=${listId} attempted=${pool.length} added=${added} skipped=${skipped} max=${maxPush}`,
  );

  return {
    attempted: pool.length,
    added,
    skipped,
    errors: errors.slice(0, 8),
    listUrl: getMlListPublicUrl(),
  };
}

/** Remove da lista ML itens pausados/fechados/inativos. */
export async function pruneUnavailableListItems(
  listId = getMlListId(),
): Promise<{ checked: number; removed: number; details: string[] }> {
  const items = await getListItems(listId);
  let removed = 0;
  const details: string[] = [];
  const creds = getMercadoLivreCreds();

  for (const it of items) {
    if (!it.itemId) continue;
    try {
      const headers: Record<string, string> = {
        Accept: "application/json",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      };
      if (creds.accessToken) {
        headers.Authorization = `Bearer ${creds.accessToken}`;
      } else if (creds.hubCookie) {
        headers.Cookie = creds.hubCookie;
        if (creds.hubCsrf) headers["x-csrf-token"] = creds.hubCsrf;
      }
      const res = await fetch(
        `https://api.mercadolibre.com/items/${it.itemId}`,
        { headers, signal: AbortTimeout(15000) },
      );
      if (res.status === 404) {
        const del = await removeItemFromList(it.itemId, { listId });
        if (del.ok) {
          removed++;
          details.push(`${it.itemId} não existe — removido`);
        }
        continue;
      }
      if (!res.ok) {
        details.push(`${it.itemId}: HTTP ${res.status}`);
        continue;
      }
      const json = (await res.json()) as { status?: string; title?: string };
      const st = String(json.status || "").toLowerCase();
      if (st && st !== "active") {
        const del = await removeItemFromList(it.itemId, {
          listId,
          bookmarksId: it.bookmarksId,
        });
        if (del.ok) {
          removed++;
          details.push(
            `${it.itemId} status=${st} — removido (${(it.title || "").slice(0, 40)})`,
          );
        } else {
          details.push(`${it.itemId} status=${st} — falha ao remover: ${del.detail}`);
        }
      }
    } catch (err) {
      details.push(
        `${it.itemId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  logAntiBan(
    "ml_list_prune",
    `list=${listId} checked=${items.length} removed=${removed}`,
  );
  return { checked: items.length, removed, details: details.slice(0, 30) };
}

/** Todas as listas do mapa (e a lista padrão). */
export function allMappedListIds(): Array<{ id: string; name: string; category?: string }> {
  const map = getListMap();
  const byId = new Map<string, { id: string; name: string; category?: string }>();
  byId.set(getMlListId(), { id: getMlListId(), name: getMlListName(), category: "default" });
  for (const [cat, entry] of Object.entries(map)) {
    if (!entry?.id) continue;
    const prev = byId.get(entry.id);
    byId.set(entry.id, {
      id: entry.id,
      name: entry.name || prev?.name || cat,
      category: prev?.category && prev.category !== "default"
        ? `${prev.category},${cat}`
        : cat,
    });
  }
  return [...byId.values()];
}

/** Todas as listas conhecidas: mapa + manuais + cache (para prune completo). */
export function allKnownListIds(): Array<{ id: string; name: string; category?: string }> {
  const byId = new Map<string, { id: string; name: string; category?: string }>();
  for (const l of allMappedListIds()) byId.set(l.id, l);

  const merge = (raw: string, type: string) => {
    try {
      const arr = JSON.parse(raw || "[]") as Array<{ id?: string; name?: string }>;
      for (const x of arr) {
        if (!x?.id) continue;
        const prev = byId.get(x.id);
        byId.set(x.id, {
          id: x.id,
          name: x.name || prev?.name || type,
          category: prev?.category || type,
        });
      }
    } catch {
      /* ignore */
    }
  };
  merge(getSetting("ml_lists_manual", "[]"), "manual");
  merge(getSetting("ml_lists_cache", "[]"), "cache");
  return [...byId.values()];
}

/**
 * Sugere mapa categoria→lista a partir dos nomes das listas cadastradas.
 */
export function suggestListMapFromNames(
  lists?: Array<{ id: string; name: string }>,
  opts?: { force?: boolean },
): Record<string, { id: string; name: string }> {
  const pool =
    lists && lists.length
      ? lists
      : (() => {
          try {
            return JSON.parse(getSetting("ml_lists_manual", "[]")) as Array<{
              id: string;
              name: string;
            }>;
          } catch {
            return [] as Array<{ id: string; name: string }>;
          }
        })();

  const rules: Array<{ cat: string; test: RegExp }> = [
    { cat: "eletronicos", test: /eletr[oô]nic/i },
    { cat: "games", test: /\bgames?\b|jogo/i },
    { cat: "tcg", test: /\btcg\b|pok[eé]mon|carta|colecion/i },
    { cat: "esportes", test: /esporte|fitness|academia/i },
    { cat: "casa", test: /\bcasa\b|m[oó]ve|cozinha|decor/i },
    { cat: "geral", test: /achadinho|geral|misto/i },
    { cat: "moda", test: /\bmoda\b|roupa|vestu/i },
    { cat: "beleza", test: /beleza|perfume|cosm/i },
  ];

  const prev = getListMap();
  const uniqueIds = new Set(
    Object.values(prev)
      .map((x) => x?.id)
      .filter(Boolean),
  );
  const collapsed = uniqueIds.size <= 1;
  const force = Boolean(opts?.force) || collapsed;

  const map: Record<string, { id: string; name: string }> = force ? {} : { ...prev };
  for (const rule of rules) {
    const hit = pool.find((l) => rule.test.test(l.name || ""));
    if (!hit?.id) continue;
    if (!force && map[rule.cat]?.id) continue;
    map[rule.cat] = { id: hit.id, name: hit.name };
  }
  if (map.eletronicos?.id) {
    for (const alias of ["celulares", "informatica", "eletrodomesticos"]) {
      if (!map[alias]?.id) map[alias] = { ...map.eletronicos };
    }
  }
  // TCG só herda Games se NÃO existir lista com nome TCG/cartas/pokémon
  const hasTcgList = pool.some((l) =>
    /\btcg\b|pok[eé]mon|carta|colecion/i.test(l.name || ""),
  );
  if (!map.tcg?.id && map.games?.id && !hasTcgList) {
    map.tcg = { ...map.games };
  }
  return map;
}

export function applySuggestedListMap(
  lists?: Array<{ id: string; name: string }>,
): Record<string, { id: string; name: string }> {
  const map = suggestListMapFromNames(lists, { force: true });
  saveListMap(map);
  const preferred =
    map.eletronicos ||
    map.geral ||
    Object.values(map).find((x) => x?.id);
  if (preferred?.id) {
    setSetting("ml_social_list_id", preferred.id);
    setSetting("ml_social_list_name", preferred.name || "Lista ML");
  }
  logAntiBan("ml_list_map_suggest", JSON.stringify(Object.keys(map)));
  return map;
}

export async function pruneAllMappedLists(): Promise<{
  lists: number;
  checked: number;
  removed: number;
  details: string[];
}> {
  const lists = allKnownListIds();
  let checked = 0;
  let removed = 0;
  const details: string[] = [];
  for (const l of lists) {
    const r = await pruneUnavailableListItems(l.id);
    checked += r.checked;
    removed += r.removed;
    for (const d of r.details) details.push(`[${l.name}] ${d}`);
    // pausa entre listas — evita rajada no Hub
    await new Promise((r) => setTimeout(r, 800 + Math.random() * 600));
  }
  setSetting("ml_list_prune_last_at", new Date().toISOString());
  logAntiBan(
    "ml_list_prune_all",
    `lists=${lists.length} checked=${checked} removed=${removed}`,
  );
  return { lists: lists.length, checked, removed, details: details.slice(0, 40) };
}

/** Deve rodar prune agora? Baseado em vezes/dia (ex.: 1 = a cada 24h). */
export function shouldRunListPrune(now = new Date()): boolean {
  if (getSetting("ml_list_prune_enabled", "1") !== "1") return false;
  const times = Math.max(
    1,
    Math.min(24, Number(getSetting("ml_list_prune_times_per_day", "1")) || 1),
  );
  const last = getSetting("ml_list_prune_last_at", "");
  if (!last) return true;
  const lastMs = Date.parse(last);
  if (!Number.isFinite(lastMs)) return true;
  const gapMs = (24 / times) * 3600_000;
  return now.getTime() - lastMs >= gapMs;
}

export async function runScheduledListPrune(): Promise<{
  ran: boolean;
  reason?: string;
  result?: Awaited<ReturnType<typeof pruneAllMappedLists>>;
}> {
  if (!shouldRunListPrune()) {
    return {
      ran: false,
      reason: `aguarda intervalo (${getSetting("ml_list_prune_times_per_day", "1")}x/dia)`,
    };
  }
  const result = await pruneAllMappedLists();
  return { ran: true, result };
}

/**
 * Empurra produtos para a lista ML da categoria (ml_list_map).
 * Cada lista recebe só o nicho ligado a ela.
 */
export async function pushProductsToMappedLists(
  products: HubProduct[],
): Promise<{
  attempted: number;
  added: number;
  skipped: number;
  errors: string[];
  byList: Array<{ listId: string; category: string; added: number; skipped: number }>;
  listUrl: string;
}> {
  const maxPerList = Math.max(
    1,
    Math.min(
      10,
      Number(getSetting("ml_list_push_max_per_sync", "6")) || 6,
    ),
  );
  const byListId = new Map<
    string,
    { category: string; products: HubProduct[] }
  >();

  for (const p of products) {
    const cat = p.category || "geral";
    const listId = listIdForCategory(cat);
    if (!listId) continue;
    if (!productFitsListCategory(p.title, cat, p.productUrl || "")) {
      continue;
    }
    // eletrônicos: só produtos de eletrônicos na lista de eletrônicos
    if (
      ["eletronicos", "celulares", "informatica", "eletrodomesticos"].includes(
        cat,
      ) &&
      !isElectronicsProduct(p)
    ) {
      continue;
    }
    const bucket = byListId.get(listId) || { category: cat, products: [] };
    bucket.products.push(p);
    byListId.set(listId, bucket);
  }

  let attempted = 0;
  let added = 0;
  let skipped = 0;
  const errors: string[] = [];
  const byList: Array<{
    listId: string;
    category: string;
    added: number;
    skipped: number;
  }> = [];

  for (const [listId, bucket] of byListId) {
    const res = await pushElectronicsToList(bucket.products, {
      listId,
      onlyElectronics: [
        "eletronicos",
        "celulares",
        "informatica",
        "eletrodomesticos",
      ].includes(bucket.category),
      maxPush: maxPerList,
    });
    attempted += res.attempted;
    added += res.added;
    skipped += res.skipped;
    errors.push(...res.errors.map((e) => `[${bucket.category}] ${e}`));
    byList.push({
      listId,
      category: bucket.category,
      added: res.added,
      skipped: res.skipped,
    });
  }

  return {
    attempted,
    added,
    skipped,
    errors: errors.slice(0, 12),
    byList,
    listUrl: getMlListPublicUrl(),
  };
}

function itemIdFromDeal(row: {
  external_id?: string | null;
  product_url?: string | null;
  affiliate_url?: string | null;
}): string | null {
  const blob = `${row.external_id || ""} ${row.product_url || ""} ${row.affiliate_url || ""}`;
  const m = blob.match(/\bMLB-?(\d{6,})\b/i);
  return m ? `MLB${m[1]}` : null;
}

/**
 * Empurra ofertas da fila local para as listas ML mapeadas (sem Sync Hub / createLink).
 * Conservador: poucos itens por lista, pausa entre adds.
 */
export async function pushQueuedDealsToMappedLists(opts?: {
  maxPerList?: number;
  listId?: string;
  category?: string;
  statuses?: string[];
}): Promise<{
  attempted: number;
  added: number;
  skipped: number;
  errors: string[];
  byList: Array<{ listId: string; category: string; name: string; added: number; skipped: number }>;
  listMap: Record<string, { id: string; name: string }>;
}> {
  const maxPerList = Math.max(
    1,
    Math.min(
      10,
      opts?.maxPerList ??
        (Number(getSetting("ml_list_push_max_per_sync", "6")) || 6),
    ),
  );
  const statuses = opts?.statuses || ["queued", "hold_coupon"];
  const placeholders = statuses.map(() => "?").join(",");
  const requireCoupon = getSetting("ml_list_require_coupon", "1") === "1";
  let sql = `SELECT id, external_id, title, category, price, old_price, price_with_coupon, product_url, affiliate_url, image_url, commission_pct, official_store, coupon, coupon_status
             FROM deals
             WHERE status IN (${placeholders}) AND source = 'mercadolivre'`;
  const params: Array<string | number> = [...statuses];
  if (opts?.category) {
    sql += ` AND category = ?`;
    params.push(opts.category);
  }
  if (requireCoupon) {
    sql += ` AND coupon IS NOT NULL AND TRIM(coupon) != '' AND coupon_status = 'valid'`;
  }
  sql += ` ORDER BY
             CASE WHEN price_with_coupon IS NOT NULL AND price_with_coupon > 0 THEN price_with_coupon ELSE price END ASC,
             id DESC
           LIMIT 300`;
  const rows = getDb().prepare(sql).all(...params) as Array<{
    id: number;
    external_id: string;
    title: string;
    category: string;
    price: number;
    old_price: number | null;
    price_with_coupon: number | null;
    product_url: string;
    affiliate_url: string;
    image_url: string | null;
    commission_pct: number | null;
    official_store?: number;
    coupon?: string | null;
    coupon_status?: string | null;
  }>;

  const officialOnly = getSetting("tcg_official_only", "0") === "1";
  const products: HubProduct[] = [];
  for (const row of rows) {
    const itemId = itemIdFromDeal(row);
    if (!itemId) continue;
    const cat = classifyProduct({
      title: row.title,
      productUrl: row.product_url || row.affiliate_url,
      categoryHint: row.category || "geral",
    });
    // corrige categoria local se estiver errada
    if (cat !== row.category) {
      try {
        getDb()
          .prepare(`UPDATE deals SET category = ? WHERE id = ?`)
          .run(cat, row.id);
      } catch {
        /* ignore */
      }
    }
    if (officialOnly && cat === "tcg" && Number(row.official_store) !== 1) {
      continue;
    }
    if (!productFitsListCategory(row.title, cat, row.product_url || "")) {
      continue;
    }
    const price =
      Number(row.price_with_coupon) > 0
        ? Number(row.price_with_coupon)
        : Number(row.price) || 0;
    if (price > categoryPriceCap(cat)) continue;

    const targetCat = opts?.category || cat;
    if (opts?.category && cat !== opts.category) continue;

    products.push({
      itemId,
      title: row.title,
      price,
      oldPrice: row.old_price,
      imageUrl: row.image_url,
      productUrl: row.product_url || row.affiliate_url,
      commissionPct: Number(row.commission_pct) || 0,
      badge: null,
      category: targetCat,
    });
  }

  // Se pediu uma lista específica, empurra só nela
  if (opts?.listId) {
    const onlyElectronics = [
      "eletronicos",
      "celulares",
      "informatica",
      "eletrodomesticos",
    ].includes(opts.category || "");
    const res = await pushElectronicsToList(products, {
      listId: opts.listId,
      onlyElectronics,
      maxPush: maxPerList,
    });
    const name =
      allKnownListIds().find((l) => l.id === opts.listId)?.name || opts.listId;
    return {
      attempted: res.attempted,
      added: res.added,
      skipped: res.skipped,
      errors: res.errors,
      byList: [
        {
          listId: opts.listId,
          category: opts.category || "—",
          name,
          added: res.added,
          skipped: res.skipped,
        },
      ],
      listMap: getListMap(),
    };
  }

  const pushed = await pushProductsToMappedLists(
    products.map((p) => ({ ...p, category: p.category || "geral" })),
  );
  const known = allKnownListIds();
  return {
    attempted: pushed.attempted,
    added: pushed.added,
    skipped: pushed.skipped,
    errors: pushed.errors,
    byList: pushed.byList.map((b) => ({
      ...b,
      name: known.find((k) => k.id === b.listId)?.name || b.listId,
    })),
    listMap: getListMap(),
  };
}

export function saveMlListSettings(input: {
  listId?: string;
  listName?: string;
  pushToList?: boolean;
  pushElectronics?: boolean;
  category?: string;
}): { listMap: Record<string, { id: string; name: string }> } {
  if (input.listId) setSetting("ml_social_list_id", input.listId.trim());
  if (input.listName) setSetting("ml_social_list_name", input.listName.trim());
  if (input.listId && input.category) {
    const map = getListMap();
    map[input.category] = {
      id: input.listId.trim(),
      name: (input.listName || getMlListName()).trim(),
    };
    // aliases comuns do nicho eletrônico
    if (input.category === "eletronicos") {
      for (const alias of ["celulares", "informatica", "eletrodomesticos"]) {
        if (!map[alias]) {
          map[alias] = { ...map.eletronicos };
        }
      }
    }
    saveListMap(map);
  }
  const push =
    input.pushToList != null
      ? input.pushToList
      : input.pushElectronics != null
        ? input.pushElectronics
        : null;
  if (push != null) {
    setSetting("ml_list_push_products", push ? "1" : "0");
  }
  return { listMap: getListMap() };
}

/** Remove ofertas locais por id (e dependências: post_logs, cupons).
 * Também tenta tirar o MLB das listas sociais mapeadas. */
export async function deleteDeals(
  ids: number[],
): Promise<{ deleted: number; listRemoved: number }> {
  if (!ids.length) return { deleted: 0, listRemoved: 0 };
  const db = getDb();
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT id, external_id, product_url, title FROM deals WHERE id IN (${placeholders})`,
    )
    .all(...ids) as Array<{
    id: number;
    external_id: string;
    product_url: string;
    title: string;
  }>;

  const tx = db.transaction((dealIds: number[]) => {
    db.prepare(
      `DELETE FROM post_logs WHERE deal_id IN (${placeholders})`,
    ).run(...dealIds);
    try {
      db.prepare(
        `DELETE FROM coupon_tests WHERE deal_id IN (${placeholders})`,
      ).run(...dealIds);
    } catch {
      /* tabela pode não existir em DBs antigos */
    }
    try {
      db.prepare(
        `DELETE FROM deal_coupon_matches WHERE deal_id IN (${placeholders})`,
      ).run(...dealIds);
    } catch {
      /* opcional */
    }
    return db
      .prepare(`DELETE FROM deals WHERE id IN (${placeholders})`)
      .run(...dealIds).changes;
  });
  const deleted = tx(ids);

  let listRemoved = 0;
  for (const r of rows) {
    const blob = `${r.external_id || ""} ${r.product_url || ""}`;
    const m = blob.match(/\bMLB-?(\d{6,})\b/i);
    if (!m) continue;
    try {
      const res = await removeItemFromAllKnownLists(`MLB${m[1]}`);
      listRemoved += res.removed;
    } catch (err) {
      logAntiBan(
        "ml_list_remove_on_deal_delete",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return { deleted, listRemoved };
}

/** Remove locais já postados / inválidos / sem link afiliado. */
export function pruneLocalDeals(): {
  deleted: number;
  reasons: Record<string, number>;
} {
  const db = getDb();
  const reasons: Record<string, number> = {};
  let deleted = 0;

  const q = (sql: string, key: string) => {
    const info = db.prepare(sql).run();
    reasons[key] = info.changes;
    deleted += info.changes;
  };

  q(
    `DELETE FROM deals WHERE status IN ('posted','skipped','failed') AND created_at < datetime('now','-3 days')`,
    "old_done",
  );
  q(
    `DELETE FROM deals WHERE coupon_status IN ('invalid','expired') AND status != 'queued'`,
    "dead_coupon",
  );
  q(
    `DELETE FROM deals WHERE affiliate_url IS NULL OR trim(affiliate_url) = ''`,
    "no_link",
  );

  logAntiBan("deals_prune_local", JSON.stringify(reasons));
  return { deleted, reasons };
}

/**
 * Enche listas ML com produtos de lojas oficiais (sem createLink).
 * Ideal para TCG/Pokémon: volume nas listas sem gastar cota de afiliado.
 * createLink continua só no Sync Hub (WhatsApp).
 */
export async function fillMappedListsFromOfficialStores(opts?: {
  category?: string;
  maxPerList?: number;
  listId?: string;
}): Promise<{
  scraped: number;
  attempted: number;
  added: number;
  skipped: number;
  errors: string[];
  byList: Array<{
    listId: string;
    category: string;
    name: string;
    added: number;
    skipped: number;
  }>;
  stores: Array<{ name: string; count: number; error?: string }>;
}> {
  const { fetchAllOfficialStoreProducts } = await import(
    "./mlOfficialStores.js"
  );
  const category = opts?.category?.trim() || undefined;
  const maxPerList = Math.max(
    1,
    Math.min(
      16,
      opts?.maxPerList ??
        Math.max(
          8,
          Number(getSetting("ml_list_push_max_per_sync", "6")) || 6,
        ),
    ),
  );

  const stores: Array<{ name: string; count: number; error?: string }> = [];
  let products = await fetchAllOfficialStoreProducts({
    category,
    onStore: (store, count, error) => {
      stores.push({ name: store.name, count, error });
    },
  });

  if (!category || category === "tcg") {
    try {
      const { fetchTcgDeepCatalog } = await import("./mlOfficialStores.js");
      const deep = await fetchTcgDeepCatalog({
        maxQueries: category === "tcg" ? 10 : 6,
        maxPerQuery: 10,
      });
      const seen = new Set(
        products.map((p) => String(p.itemId || "").toUpperCase()).filter(Boolean),
      );
      for (const p of deep) {
        const id = String(p.itemId || "").toUpperCase();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        products.push(p);
      }
      if (deep.length) {
        stores.push({ name: "Buscas TCG (Pokémon/Magic/YGO…)", count: deep.length });
      }
    } catch {
      /* busca profunda é opcional */
    }
  }

  // Preferir nichos com pushToMlList (TCG, eletrônicos…)
  let pool = products;
  if (category) {
    pool = products.filter((p) => (p.category || "") === category);
    // lojas oficiais da categoria já vêm filtradas; se classificação falhar, usa scrapado
    if (!pool.length) pool = products;
  }

  const map = getListMap();
  const targetListId = opts?.listId?.trim() || undefined;

  if (targetListId) {
    const matchCat =
      Object.entries(map).find(([, v]) => v.id === targetListId)?.[0] ||
      category ||
      "tcg";
    const res = await pushElectronicsToList(pool, {
      listId: targetListId,
      onlyElectronics: false,
      maxPush: maxPerList,
    });
    const name =
      allKnownListIds().find((l) => l.id === targetListId)?.name ||
      map[matchCat]?.name ||
      targetListId;
    logAntiBan(
      "ml_list_fill_stores",
      `cat=${category || "*"} list=${targetListId} scraped=${products.length} +${res.added}`,
    );
    return {
      scraped: products.length,
      attempted: res.attempted,
      added: res.added,
      skipped: res.skipped,
      errors: res.errors,
      byList: [
        {
          listId: targetListId,
          category: matchCat,
          name,
          added: res.added,
          skipped: res.skipped,
        },
      ],
      stores,
    };
  }

  // Sem listId: empurrar por mapa (todas as categorias, ordem alfabética estável)
  const order = category
    ? [category]
    : Object.keys(getListMap()).sort();
  const byCat = new Map<string, HubProduct[]>();
  for (const p of pool) {
    const cat = p.category || "geral";
    const arr = byCat.get(cat) || [];
    arr.push(p);
    byCat.set(cat, arr);
  }

  let attempted = 0;
  let added = 0;
  let skipped = 0;
  const errors: string[] = [];
  const byList: Array<{
    listId: string;
    category: string;
    name: string;
    added: number;
    skipped: number;
  }> = [];

  const seenList = new Set<string>();
  for (const cat of order) {
    const listId = listIdForCategory(cat);
    if (!listId || seenList.has(listId)) continue;
    seenList.add(listId);
    const bucket = byCat.get(cat) || [];
    if (!bucket.length) continue;
    const res = await pushElectronicsToList(bucket, {
      listId,
      onlyElectronics: [
        "eletronicos",
        "celulares",
        "informatica",
        "eletrodomesticos",
      ].includes(cat),
      maxPush: maxPerList,
    });
    attempted += res.attempted;
    added += res.added;
    skipped += res.skipped;
    errors.push(...res.errors.map((e) => `[${cat}] ${e}`));
    byList.push({
      listId,
      category: cat,
      name: map[cat]?.name || listId,
      added: res.added,
      skipped: res.skipped,
    });
  }

  logAntiBan(
    "ml_list_fill_stores",
    `cat=${category || "*"} scraped=${products.length} +${added} lists=${byList.length}`,
  );

  return {
    scraped: products.length,
    attempted,
    added,
    skipped,
    errors: errors.slice(0, 12),
    byList,
    stores,
  };
}

/**
 * Varre todas as listas mapeadas e remove itens fora da categoria.
 * Deduplica títulos iguais (mantém o mais barato).
 */
export async function sanitizeMappedLists(opts?: {
  categories?: string[];
}): Promise<{
  lists: Array<{
    category: string;
    name: string;
    checked: number;
    removed: number;
    kept: number;
    samples: string[];
  }>;
  removedTotal: number;
}> {
  const map = getListMap();
  const cats =
    opts?.categories ||
    Object.keys(map).filter(
      (c, i, arr) => arr.findIndex((x) => map[x]?.id === map[c]?.id) === i,
    );
  // Prefer canonical cats for shared list IDs
  const prefer = [
    "eletronicos",
    "informatica",
    "tcg",
    "esportes",
    "casa",
    "games",
    "geral",
  ];
  const ordered = [
    ...prefer.filter((c) => map[c]?.id),
    ...cats.filter((c) => !prefer.includes(c)),
  ];
  const seenList = new Set<string>();
  const lists: Array<{
    category: string;
    name: string;
    checked: number;
    removed: number;
    kept: number;
    samples: string[];
  }> = [];
  let removedTotal = 0;

  for (const cat of ordered) {
    const entry = map[cat];
    if (!entry?.id || seenList.has(entry.id)) continue;
    seenList.add(entry.id);
    const items = await getListItems(entry.id);
    const toRemove: Array<{ itemId: string; bookmarksId: string | null }> = [];
    const samples: string[] = [];
    const byTitle = new Map<string, { item: MlListItem; price: number }>();

    for (const it of items) {
      const title = String(it.title || "");
      const price = Number(it.price) || Number.POSITIVE_INFINITY;
      const key = title.toLowerCase().replace(/\s+/g, " ").trim();
      if (isLowDemandNicheTitle(title)) {
        toRemove.push({ itemId: it.itemId, bookmarksId: it.bookmarksId });
        if (samples.length < 8) samples.push(`${title.slice(0, 60)} (nicho)`);
        continue;
      }
      if (!productFitsListCategory(title, cat, it.url || "")) {
        toRemove.push({ itemId: it.itemId, bookmarksId: it.bookmarksId });
        if (samples.length < 8) samples.push(`${title.slice(0, 60)} (cat)`);
        continue;
      }
      const prev = byTitle.get(key);
      if (prev) {
        // duplicata: remove o mais caro
        if (price >= prev.price) {
          toRemove.push({ itemId: it.itemId, bookmarksId: it.bookmarksId });
          if (samples.length < 8) samples.push(`${title.slice(0, 60)} (dup)`);
        } else {
          toRemove.push({
            itemId: prev.item.itemId,
            bookmarksId: prev.item.bookmarksId,
          });
          byTitle.set(key, { item: it, price });
          if (samples.length < 8) samples.push(`${title.slice(0, 60)} (dup)`);
        }
      } else {
        byTitle.set(key, { item: it, price });
      }
    }

    // Cap esportes: remove scooter / preços absurdos
    if (cat === "esportes") {
      for (const it of items) {
        const title = String(it.title || "");
        const price = Number(it.price) || 0;
        if (
          /scooters?\s*el[eé]tric/i.test(title) ||
          price > categoryPriceCap("esportes")
        ) {
          if (!toRemove.some((r) => r.itemId === it.itemId)) {
            toRemove.push({ itemId: it.itemId, bookmarksId: it.bookmarksId });
            if (samples.length < 8) samples.push(`${title.slice(0, 60)} (preço)`);
          }
        }
      }
    }

    let removed = 0;
    if (toRemove.length) {
      const res = await removeItemsFromList(toRemove, entry.id);
      removed = res.removed;
      removedTotal += removed;
    }
    lists.push({
      category: cat,
      name: entry.name,
      checked: items.length,
      removed,
      kept: Math.max(0, items.length - removed),
      samples,
    });
    await new Promise((r) => setTimeout(r, 800));
  }

  logAntiBan(
    "ml_list_sanitize",
    `lists=${lists.length} removed=${removedTotal}`,
  );
  return { lists, removedTotal };
}
