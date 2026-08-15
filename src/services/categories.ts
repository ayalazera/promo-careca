/**
 * Categorias de comunidades / roteamento de promoções.
 * Sugestões alinhadas às categorias fortes de afiliados no ML Brasil.
 */
import { getDb, getSetting, setSetting } from "../db/index.js";
import { isTcgCollectible } from "./tcgFilter.js";
import { isVideoGameDeal } from "./gamesFilter.js";
import {
  classifyNonElectronicsFallback,
  isClearlyNotElectronics,
  isHomeApplianceTitle,
  isToyOrKidsTitle,
  looksLikeElectronics,
} from "./electronicsFilter.js";

export type AppCategory = {
  id: string;
  label: string;
  emoji: string;
  mlCategoryIds: string[];
  keywords: string[];
  excludeKeywords: string[];
  active: boolean;
  sortOrder: number;
  /** Se true, produtos desta cat. vão à lista social ML configurada */
  pushToMlList: boolean;
};

/** Melhores categorias para afiliado ML no Brasil (volume + ganhos extras). */
export const SUGGESTED_CATEGORIES: AppCategory[] = [
  {
    id: "eletronicos",
    label: "Eletrônicos & Áudio",
    emoji: "🎧",
    mlCategoryIds: ["MLB1000"],
    keywords: [
      "fone",
      "headset",
      "tv",
      "smart tv",
      "tv box",
      "soundbar",
      "caixa de som",
      "alexa",
      "echo",
      "carregador",
      "power bank",
      "usb",
      "led",
      "drone",
      "camera",
      "câmera",
      "projetor",
      "smartwatch",
    ],
    excludeKeywords: [
      "perfume",
      "creatina",
      "chinelo",
      "camiseta",
      "short",
      "shorts",
      "creme",
      "hidratante",
      "whey",
      "tênis",
      "tenis",
      "cueca",
      "sandália",
    ],
    active: true,
    sortOrder: 10,
    pushToMlList: true,
  },
  {
    id: "celulares",
    label: "Celulares & Acessórios",
    emoji: "📱",
    mlCategoryIds: ["MLB1051"],
    keywords: [
      "iphone",
      "samsung",
      "xiaomi",
      "motorola",
      "celular",
      "smartphone",
      "capinha",
      "pelicula",
      "película",
    ],
    excludeKeywords: [],
    active: true,
    sortOrder: 20,
    pushToMlList: true,
  },
  {
    id: "informatica",
    label: "Informática",
    emoji: "💻",
    mlCategoryIds: ["MLB1648"],
    keywords: [
      "notebook",
      "laptop",
      "mouse",
      "teclado",
      "monitor",
      "ssd",
      "hd ",
      "roteador",
      "wifi",
      "impressora",
      "processador",
      "placa de video",
      "gpu",
    ],
    excludeKeywords: [],
    active: true,
    sortOrder: 30,
    pushToMlList: true,
  },
  {
    id: "games",
    label: "Games & Consoles",
    emoji: "🎮",
    mlCategoryIds: ["MLB1144"],
    keywords: [
      "playstation",
      "xbox",
      "nintendo",
      "switch",
      "ps4",
      "ps5",
      "ps3",
      "psp",
      "ps vita",
      "steam deck",
      "dualsense",
      "dualshock",
      "joy-con",
      "pro controller",
      "controle ps",
      "controle xbox",
      "videogame",
      "mídia física",
      "midia fisica",
      "gift card",
      "giftcard",
      "cartão presente",
      "psn",
      "xbox live",
      "game pass",
      "steam",
      "carregador controle",
      "base carregadora",
      "headset gamer",
      "fone gamer",
      "pulse 3d",
      "ssd ps5",
      "volante gamer",
      "placa de captura",
      "psvr",
      "meta quest",
      "amiibo",
      "case switch",
      "teclado gamer",
      "mouse gamer",
      "monitor gamer",
    ],
    excludeKeywords: [
      "dobble",
      "dob101",
      "uno",
      "baralho",
      "jogo de cartas",
      "tabuleiro",
      "galapagos",
      "galápagos",
      "yu-gi",
      "yugioh",
      "booster",
      "tcg",
      "cadeira gamer",
      "mesa gamer",
      "soundbar",
      "console de som",
    ],
    active: true,
    sortOrder: 40,
    pushToMlList: true,
  },
  {
    id: "eletrodomesticos",
    label: "Eletrodomésticos",
    emoji: "🧺",
    mlCategoryIds: ["MLB5726"],
    keywords: [
      "ar-condicionado",
      "ar condicionado",
      "aspirador",
      "robô aspir",
      "lava jato",
      "geladeira",
      "fogão",
      "micro-ondas",
      "air fryer",
      "cafeteira",
      "inverter",
    ],
    excludeKeywords: [],
    active: true,
    sortOrder: 50,
    pushToMlList: true,
  },
  {
    id: "casa",
    label: "Casa & Decoração",
    emoji: "🏠",
    mlCategoryIds: ["MLB1574"],
    keywords: [
      "organizador",
      "panela",
      "jogo de cama",
      "cortina",
      "luminaria",
      "luminária",
      "lençol",
      "travesseiro",
      "pote",
      "marmita",
      "edredom",
      "toalha",
    ],
    excludeKeywords: [],
    active: true,
    sortOrder: 60,
    pushToMlList: true,
  },
  {
    id: "beleza",
    label: "Beleza & Cuidados",
    emoji: "✨",
    mlCategoryIds: ["MLB1246"],
    keywords: [
      "perfume",
      "eau de",
      "creme",
      "shampoo",
      "barbeador",
      "aparador de pelos",
      "secador",
      "chapinha",
    ],
    excludeKeywords: [],
    active: true,
    sortOrder: 70,
    pushToMlList: false,
  },
  {
    id: "moda",
    label: "Moda & Calçados",
    emoji: "👟",
    mlCategoryIds: ["MLB1430"],
    keywords: ["tênis", "tenis", "chinelo", "havaianas", "camiseta", "short", "vestido", "bola"],
    excludeKeywords: [],
    active: true,
    sortOrder: 80,
    pushToMlList: false,
  },
  {
    id: "esportes",
    label: "Esportes & Fitness",
    emoji: "🏋️",
    mlCategoryIds: ["MLB1276"],
    keywords: [
      "bicicleta",
      "ergom",
      "scooter",
      "halter",
      "creatina",
      "whey",
      "suplemento",
      "esteira",
    ],
    excludeKeywords: [],
    active: true,
    sortOrder: 90,
    pushToMlList: true,
  },
  {
    id: "bebes",
    label: "Bebês",
    emoji: "🍼",
    mlCategoryIds: ["MLB1384"],
    keywords: ["fralda", "carrinho de bebê", "mamadeira", "berço"],
    excludeKeywords: [],
    active: false,
    sortOrder: 100,
    pushToMlList: false,
  },
  {
    id: "pet",
    label: "Pet Shop",
    emoji: "🐾",
    mlCategoryIds: ["MLB1071"],
    keywords: ["ração", "pet ", "cachorro", "gato ", "coleira"],
    excludeKeywords: [],
    active: false,
    sortOrder: 110,
    pushToMlList: false,
  },
  {
    id: "tcg",
    label: "Cartas TCG & Colecionáveis",
    emoji: "🃏",
    mlCategoryIds: ["MLB1132"],
    keywords: [
      "pokemon",
      "pokémon",
      "pikachu",
      "charizard",
      "booster",
      "yu-gi",
      "yu-gi-oh",
      "yugioh",
      "magic the gathering",
      "tcg",
      "league battle",
      "elite trainer",
      "one piece card",
      "lorcana",
      "disney lorcana",
      "sleeve",
      "sleeves",
      "fichario",
      "fichário",
      "binder",
      "toploader",
      "pasta para cartas",
      "pasta de cartas",
      "pasta pokemon",
      "pasta pokémon",
      "álbum pokemon",
      "album pokemon",
      "protetor de carta",
      "protetor pokemon",
      "deck box",
      "porta cartas",
      "card saver",
      "ultra pro",
      "dragon shield",
      "konami",
      "wizards",
      "escudo e espada",
      "coroa estelar",
      "destino de paldea",
      "topps",
      "panini",
      "ufc card",
      "nba card",
      "carta de basquete",
      "produto brasileiro carta",
      "pokemon portugues",
      "pokémon português",
      "yugioh portugues",
    ],
    excludeKeywords: [
      "dobble",
      "dob101",
      "uno",
      "baralho",
      "exploding",
      "super trunfo",
      "galapagos dobble",
      "galápagos dobble",
      "spot it",
      "playmat",
      "play mat",
      "tapete",
      "antiderrapante",
      "mousepad",
      "mouse pad",
      "life counter",
      "contador de vida",
    ],
    active: true,
    sortOrder: 120,
    pushToMlList: true,
  },
  {
    id: "geral",
    label: "Geral / Achadinhos",
    emoji: "🔥",
    mlCategoryIds: [],
    keywords: [],
    excludeKeywords: [],
    active: true,
    sortOrder: 999,
    pushToMlList: false,
  },
];

function ensureCategoriesTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      emoji TEXT NOT NULL DEFAULT '',
      ml_category_ids TEXT NOT NULL DEFAULT '',
      keywords TEXT NOT NULL DEFAULT '',
      exclude_keywords TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 100,
      push_to_ml_list INTEGER NOT NULL DEFAULT 0
    );
  `);
  const count = getDb()
    .prepare("SELECT COUNT(*) AS c FROM categories")
    .get() as { c: number };
  if (count.c === 0) {
    const ins = getDb().prepare(`
      INSERT INTO categories (
        id, label, emoji, ml_category_ids, keywords, exclude_keywords,
        active, sort_order, push_to_ml_list
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const c of SUGGESTED_CATEGORIES) {
      ins.run(
        c.id,
        c.label,
        c.emoji,
        c.mlCategoryIds.join(","),
        c.keywords.join(","),
        c.excludeKeywords.join(","),
        c.active ? 1 : 0,
        c.sortOrder,
        c.pushToMlList ? 1 : 0,
      );
    }
  } else {
    // Migração leve: TCG precisa ir às listas ML (antes ficava off → 1–2 itens)
    const tcg = SUGGESTED_CATEGORIES.find((c) => c.id === "tcg");
    if (tcg) {
      getDb()
        .prepare(
          `UPDATE categories
           SET push_to_ml_list = 1,
               keywords = ?,
               exclude_keywords = ?,
               active = 1
           WHERE id = 'tcg'`,
        )
        .run(tcg.keywords.join(","), tcg.excludeKeywords.join(","));
    }
    const games = SUGGESTED_CATEGORIES.find((c) => c.id === "games");
    if (games) {
      getDb()
        .prepare(
          `UPDATE categories
           SET keywords = ?,
               exclude_keywords = ?,
               active = 1,
               push_to_ml_list = 1
           WHERE id = 'games'`,
        )
        .run(games.keywords.join(","), games.excludeKeywords.join(","));
    }
    getDb()
      .prepare(`UPDATE categories SET push_to_ml_list = 1 WHERE id IN ('casa')`)
      .run();
  }
}

/** TCG de verdade vs jogo de mesa; Games só videogame; Eletrônicos só tech. */
export function recategorizeNonTcgDeals(): number {
  ensureCategoriesTable();
  const rows = getDb()
    .prepare(
      `SELECT id, title, product_url, category FROM deals
       WHERE status IN ('queued','hold_coupon','posted')`,
    )
    .all() as Array<{
    id: number;
    title: string;
    product_url: string;
    category: string;
  }>;
  let n = 0;
  const upd = getDb().prepare(`UPDATE deals SET category = ? WHERE id = ?`);
  for (const r of rows) {
    const shouldTcg = isTcgCollectible(r.title, r.product_url);
    const shouldGames = isVideoGameDeal(r.title, r.product_url);
    let next = r.category;
    if (shouldTcg) next = "tcg";
    else if (shouldGames) next = "games";
    else if (r.category === "tcg" || r.category === "games") next = "geral";
    else {
      // Reavalia eletrônicos / celulares / informática mal rotulados.
      const reclass = classifyProduct({
        title: r.title,
        productUrl: r.product_url,
        categoryHint: null,
      });
      const elecLike = ["eletronicos", "celulares", "informatica", "eletrodomesticos"];
      if (elecLike.includes(r.category) && !elecLike.includes(reclass)) {
        next = reclass;
      } else if (
        elecLike.includes(r.category) &&
        isClearlyNotElectronics(r.title, r.product_url)
      ) {
        next = classifyNonElectronicsFallback(r.title, r.product_url);
      }
    }
    if (next !== r.category) {
      upd.run(next, r.id);
      n += 1;
    }
  }
  return n;
}

function rowToCat(r: Record<string, unknown>): AppCategory {
  const split = (s: unknown) =>
    String(s || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  return {
    id: String(r.id),
    label: String(r.label),
    emoji: String(r.emoji || ""),
    mlCategoryIds: split(r.ml_category_ids),
    keywords: split(r.keywords),
    excludeKeywords: split(r.exclude_keywords),
    active: Number(r.active) === 1,
    sortOrder: Number(r.sort_order) || 100,
    pushToMlList: Number(r.push_to_ml_list) === 1,
  };
}

export function listCategories(opts?: { activeOnly?: boolean }): AppCategory[] {
  ensureCategoriesTable();
  const rows = getDb()
    .prepare(
      opts?.activeOnly
        ? `SELECT * FROM categories WHERE active = 1 ORDER BY sort_order ASC`
        : `SELECT * FROM categories ORDER BY sort_order ASC`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map(rowToCat);
}

export function upsertCategory(input: Partial<AppCategory> & { id: string }): AppCategory {
  ensureCategoriesTable();
  const id = input.id
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-|-$/g, "");
  if (!id) throw new Error("id inválido");

  const existing = getDb()
    .prepare("SELECT * FROM categories WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;

  const base = existing
    ? rowToCat(existing)
    : SUGGESTED_CATEGORIES.find((c) => c.id === id) || {
        id,
        label: id,
        emoji: "📦",
        mlCategoryIds: [] as string[],
        keywords: [] as string[],
        excludeKeywords: [] as string[],
        active: true,
        sortOrder: 200,
        pushToMlList: false,
      };

  const next: AppCategory = {
    ...base,
    ...input,
    id,
    label: (input.label && String(input.label).trim()) || base.label,
    emoji: input.emoji != null ? String(input.emoji) : base.emoji,
    mlCategoryIds: input.mlCategoryIds ?? base.mlCategoryIds,
    keywords: input.keywords ?? base.keywords,
    excludeKeywords: input.excludeKeywords ?? base.excludeKeywords,
    active: input.active ?? base.active,
    sortOrder:
      input.sortOrder != null && Number.isFinite(Number(input.sortOrder))
        ? Number(input.sortOrder)
        : base.sortOrder,
    pushToMlList: input.pushToMlList ?? base.pushToMlList,
  };

  getDb()
    .prepare(
      `INSERT INTO categories (
         id, label, emoji, ml_category_ids, keywords, exclude_keywords,
         active, sort_order, push_to_ml_list
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         label = excluded.label,
         emoji = excluded.emoji,
         ml_category_ids = excluded.ml_category_ids,
         keywords = excluded.keywords,
         exclude_keywords = excluded.exclude_keywords,
         active = excluded.active,
         sort_order = excluded.sort_order,
         push_to_ml_list = excluded.push_to_ml_list`,
    )
    .run(
      next.id,
      next.label,
      next.emoji,
      next.mlCategoryIds.join(","),
      next.keywords.join(","),
      next.excludeKeywords.join(","),
      next.active ? 1 : 0,
      next.sortOrder,
      next.pushToMlList ? 1 : 0,
    );

  return next;
}

export function deleteCategory(id: string): void {
  ensureCategoriesTable();
  if (id === "geral") throw new Error("categoria geral não pode ser removida");
  getDb().prepare("DELETE FROM categories WHERE id = ?").run(id);
}

export function seedSuggestedCategories(activateAll = false): number {
  ensureCategoriesTable();
  let n = 0;
  for (const c of SUGGESTED_CATEGORIES) {
    upsertCategory({
      ...c,
      active: activateAll ? true : c.active,
    });
    n += 1;
  }
  return n;
}

/** Classifica título/URL na melhor categoria ativa. */
export function classifyProduct(input: {
  title: string;
  productUrl?: string;
  categoryHint?: string | null;
}): string {
  const cats = listCategories({ activeOnly: true }).filter((c) => c.id !== "geral");
  const hay = `${input.title} ${input.productUrl || ""}`.toLowerCase();
  const url = input.productUrl || "";

  if (isTcgCollectible(input.title, url)) {
    return "tcg";
  }
  if (isVideoGameDeal(input.title, url)) {
    return "games";
  }

  // Anti-eletrônico explícito (válvula, suplemento, óculos, PVC, brinquedo…)
  if (isClearlyNotElectronics(input.title, url)) {
    return classifyNonElectronicsFallback(input.title, url);
  }

  // Eletrodomésticos de casa (aspirador, air fryer…) — nunca “eletrônicos”
  if (isHomeApplianceTitle(input.title, url)) {
    return "eletrodomesticos";
  }
  if (isToyOrKidsTitle(input.title, url)) {
    return "geral";
  }

  // Suplementos = esportes (não moda)
  if (/creatina|whey|suplemento|pr[eé][- ]?treino|col[aá]geno|bcaa|termog[eê]nico/.test(hay)) {
    return "esportes";
  }

  // Roupa / calçado / jaqueta com “fone” no bolso — é moda, não eletrônico
  const clothingHit =
    /jaqueta|bobojaco|casaco|agasalho|abrigo esportivo|legging|cueca|camiseta|camisa |henley|meia |meias|sapatilha|sapato|bota |coturno|t[eê]nis|chinelo|havaianas|short|shorts|bermuda|vestido|blusa|moletom|cal[cç]a|sand[aá]lia|kit \d+ cuecas?|kit \d+ camisetas?|kit \d+ pares? meia/.test(
      hay,
    );
  if (clothingHit) return "moda";

  const fashionHit =
    /perfume|chinelo|havaianas|camiseta|short|shorts|creme |hidratante|t[eê]nis |tenis |cueca|sand[aá]lia|cal[cç]a|meia |sapatilha|sapato|bota |coturno|henley|agasalho|abrigo esportivo|len[cç]ol|lencol|travesseiro/.test(
      hay,
    );

  if (/port[aã]o deslizante|motor (?:de )?port[aã]o|\bdz nano\b|\bdz stark\b/.test(hay)) {
    return "casa";
  }
  // Eletrodomésticos (legado / reforço de keywords)
  if (
    /lavadora|lava[- ]?e[- ]?seca|secadora de roupa|geladeira|refrigerador|fog[aã]o|cooktop|micro[- ]?ondas|lava[- ]?lou[cç]as|purificador de [aá]gua|filtro de [aá]gua|air.?fryer|fritadeira|aspirador/.test(
      hay,
    )
  ) {
    return "eletrodomesticos";
  }

  // Potes / marmita / utensílio de cozinha — mesmo citando airfryer
  if (
    /pote(?:s)?(?:\s+de)?(?:\s+vidro)?|marmita|kit \d+ potes|utens[ií]lio|jogo de panelas|panela |travessa|marinex/.test(
      hay,
    )
  ) {
    return "casa";
  }
  if (fashionHit) {
    if (/len[cç]ol|travesseiro|jogo de cama/.test(hay)) return "casa";
    if (/perfume|creme |hidratante|shampoo/.test(hay)) return "beleza";
    return "moda";
  }
  // Toner/cartucho = nicho (demanda baixa) — não empurrar para Informática
  if (/toner|cartucho(?: de tinta)?/.test(hay)) return "geral";
  if (
    /aparador de pelos|barbeador|m[aá]quina(?: de)? barbear|aparelho de barbear/.test(
      hay,
    )
  ) {
    return "beleza";
  }
  if (
    /interfone|porteiro eletr[oô]nico|mini\s*compressor|compressor de ar|bomba el[eé]trica|inflador/.test(
      hay,
    )
  ) {
    return "casa";
  }
  if (/smartwatch|smart watch/.test(hay)) return "eletronicos";
  if (/chave de impacto|parafusadeira|furadeira|esmerilhadeira/.test(hay)) {
    return "casa";
  }

  if (input.categoryHint) {
    const hint = input.categoryHint.toLowerCase();
    if (
      ["eletronicos", "celulares", "informatica", "eletrodomesticos"].includes(
        hint,
      ) &&
      isHomeApplianceTitle(input.title, url)
    ) {
      return "eletrodomesticos";
    }
    if (isToyOrKidsTitle(input.title, url)) {
      return "geral";
    }
    const techHints = ["eletronicos", "celulares", "informatica", "eletrodomesticos"];
    // Hub/categoria de origem NÃO força tech se o título não parecer eletrônico.
    if (techHints.includes(hint)) {
      if (isClearlyNotElectronics(input.title, url)) {
        return classifyNonElectronicsFallback(input.title, url);
      }
      if (!looksLikeElectronics(input.title, url) && hint !== "eletrodomesticos") {
        // Sem sinal tech: ignora hint e segue heurística.
      } else if (
        !(
          fashionHit &&
          ["eletronicos", "celulares", "informatica"].includes(hint)
        ) &&
        cats.some((c) => c.id === hint)
      ) {
        return hint;
      }
    } else if (
      !(hint === "tcg" && !isTcgCollectible(input.title, url)) &&
      !(hint === "games" && !isVideoGameDeal(input.title, url)) &&
      cats.some((c) => c.id === hint)
    ) {
      return hint;
    }
  }

  let best: { id: string; score: number } | null = null;
  for (const c of cats) {
    if (c.id === "tcg" && !isTcgCollectible(input.title, url)) {
      continue;
    }
    if (c.id === "games" && !isVideoGameDeal(input.title, url)) {
      continue;
    }
    // Não pontuar eletrônicos se o título é anti-tech.
    if (
      ["eletronicos", "celulares", "informatica"].includes(c.id) &&
      (isClearlyNotElectronics(input.title, url) || !looksLikeElectronics(input.title, url))
    ) {
      // Ainda permite keyword hit se looksLikeElectronics — senão pula.
      if (isClearlyNotElectronics(input.title, url)) continue;
      if (!looksLikeElectronics(input.title, url)) continue;
    }
    if (c.excludeKeywords.some((k) => hay.includes(k.toLowerCase()))) continue;
    let score = 0;
    for (const k of c.keywords) {
      if (hay.includes(k.toLowerCase())) score += k.length > 4 ? 2 : 1;
    }
    for (const ml of c.mlCategoryIds) {
      if (hay.includes(ml.toLowerCase())) score += 5;
    }
    if (score > 0 && (!best || score > best.score)) {
      best = { id: c.id, score };
    }
  }
  return best?.id || "geral";
}

export function categoriesForMeta() {
  return {
    categories: listCategories(),
    suggestions: SUGGESTED_CATEGORIES.map((c) => ({
      id: c.id,
      label: c.label,
      emoji: c.emoji,
      reason:
        c.id === "eletronicos" || c.id === "celulares" || c.id === "informatica"
          ? "Alto volume + ganhos extras frequentes no Hub"
          : c.id === "beleza" || c.id === "moda"
            ? "Ticket recorrente e cupons fortes"
            : c.id === "games" || c.id === "tcg"
              ? "Comunidade engajada (ótimo para grupos nicho)"
              : "Boa para série de grupos temáticos",
      mlCategoryIds: c.mlCategoryIds,
      recommended: c.active,
    })),
  };
}

export function isElectronicsLike(categoryId: string): boolean {
  return ["eletronicos", "celulares", "informatica", "eletrodomesticos"].includes(
    categoryId,
  );
}

/** Mantém compat com código antigo que lia CATEGORIES do config. */
export function getActiveCategoryIds(): string[] {
  return listCategories({ activeOnly: true }).map((c) => c.id);
}

export function brandDefaultsFromSettings() {
  return {
    handle: getSetting("brand_handle", "@carecavip"),
    tagline: getSetting(
      "brand_tagline",
      "O melhor grupo de promoções da internet",
    ),
    groupName: getSetting("brand_group_name", "Careca VIP"),
  };
}

export function saveBrandDefaults(input: {
  handle?: string;
  tagline?: string;
  groupName?: string;
}): void {
  if (input.handle != null) setSetting("brand_handle", String(input.handle));
  if (input.tagline != null) setSetting("brand_tagline", String(input.tagline));
  if (input.groupName != null)
    setSetting("brand_group_name", String(input.groupName));
}
