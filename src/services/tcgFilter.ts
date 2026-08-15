/**
 * TCG = cartas colecionáveis + proteção/armazenamento de cartas
 * (sleeves, fichário/binder, toploader, deck box…).
 * NÃO inclui playmat/tapete, jogos de mesa (Dobble/UNO) nem videogame.
 */
import { getSettingNum } from "../db/index.js";
export function isPartyCardGame(hay: string): boolean {
  const t = hay.toLowerCase();
  return /dobble|dob101|spot it|gal[áa]pagos dobble|\buno\b|munchkin|exploding kitten|the mind\b|super trunfo|\bbaralho\b|jogo de cartas do|monopoly deal|snap card|\bcoup\b|codenames|lig-?4|imagem e a[cç][aã]o|quem sou eu|jogo da mem[oó]ria|cartas do dobble|hist[oó]rias? sinistras|black stories|ticket to ride|pandemic|the resistance|\bazul\b.*(?:jogo|tabuleiro)|jogo de tabuleiro|tabuleiro gal[áa]pagos|gal[áa]pagos jogos|z-?man games|board ?game/.test(
    t,
  );
}

/** Jogos de mesa / party games — nunca vão para a lista TCG. */
export function isBoardOrPartyGame(title: string, extra = ""): boolean {
  const hay = `${title} ${extra}`.toLowerCase();
  if (isPartyCardGame(hay)) return true;
  if (/jogo de tabuleiro|board ?game|party game/.test(hay) && !TCG_BRANDS.test(hay)) {
    return true;
  }
  return false;
}

/**
 * Acessórios que NÃO são TCG do grupo (tapete/playmat, display decorativo…).
 * Mesmo com “Pokémon/Lorcana” no título, vão para geral/brinquedos.
 */
export function isTcgExcludedAccessory(title: string, extra = ""): boolean {
  const hay = `${title} ${extra}`.toLowerCase();
  return (
    /play\s*-?\s*mat|\bplaymat\b/.test(hay) ||
    /tapete(?:\s+(?:de|para|do|da))?\s*(?:jogo|tcg|cartas?|mesa|jogo)|tapete antiderrap|tapete premium/.test(
      hay,
    ) ||
    (/antiderrapante/.test(hay) &&
      /(?:acess[oó]rio|tapete|mat\b|base)/.test(hay) &&
      !/(?:sleeve|fich[aá]rio|binder|booster|carta)/.test(hay)) ||
    /mouse\s*-?\s*pad/.test(hay) ||
    /life\s*counter|contador de vida|dice\s*tower|torre de dados/.test(hay) ||
    /card\s*stand|suporte (?:de|para) cartas? (?:de mesa|decor)/.test(hay) ||
    // Pelúcia / plush (mesmo com “Pokémon” no título) não é carta TCG.
    /pel[uú]cia|plush|squishmallow|boneco de pel|almofada pokemon|almofada pokémon/.test(
      hay,
    )
  );
}

/** Marcas/linhas que realmente pertencem ao grupo TCG. */
const TCG_CORE =
  /pok[eé]mon|pikachu|charizard|eevee|yu-?gi-?oh|\byugioh\b|magic the gathering|\bmtg\b|konami|wizards of the coast/;

const TCG_BRANDS =
  /pok[eé]mon|pikachu|charizard|eevee|yu-?gi-?oh|\byugioh\b|magic the gathering|\bmtg\b|lorcana|disney lorcana|one piece card|flesh and blood|digimon tcg|\btcg\b|booster|elite trainer|league battle|\betb\b|deck box|toploader|topps|panini|nba card|nfl card|ufc card|mlb card|carta de basquete|carta de futebol|trading card|colecion[aá]ve|copa panini|figurinha da copa|upper deck|donruss|\bprizm\b|chrom[eé] topps|escudo e espada|tempestade prateada|coroa estelar|destino de paldea|evolu[cç][oõ]es prism[aá]ticas/;

/** Só proteção / guarda de cartas — sem playmat. */
const TCG_ACCESSORIES =
  /sleeve|sleeves|protetor(?:es)? de cartas?|capinha de carta|fich[aá]rio|binder|pasta (?:para |de )?cartas|pasta pokemon|pasta pokémon|álbum de figurinha|album de figurinha|album de carta|[aá]lbum pokemon|[aá]lbum pokémon|ultra pro|dragon shield|kmc sleeve|toploader|deck ?box|card saver|porta[- ]cartas|protetor pokemon|protetor pokémon|sleeve pokemon|sleeve pokémon|sleeve yugioh|sleeve yu-?gi|sleeve magic|pasta binder|fich[aá]rio pokemon|fich[aá]rio pokémon|fich[aá]rio yugioh/;

/** Jogo de videogame (Switch/PS/Xbox) — mesmo com “Pokémon” no título, não é TCG. */
export function isVideoGameHardwareTitle(hay: string): boolean {
  const t = hay.toLowerCase();
  if (/booster|\btcg\b|sleeve|fich[aá]rio|carta colecion|trading card/.test(t)) {
    return false;
  }
  return /(\bps[345]\b|\bps5\b|\bps4\b|playstation|ps.?portal|xbox(?:\s+(?:one|series))?|\bnintendo\b|\bswitch\b|steam\s?deck|rog ally|m[ií]dia f[ií]sica|psp\b|ps vita|wii u?\b)/.test(
    t,
  );
}

export function isTcgCollectible(title: string, extra = ""): boolean {
  const hay = `${title} ${extra}`.toLowerCase();
  if (isTcgExcludedAccessory(title, extra)) return false;
  if (isBoardOrPartyGame(title, extra)) return false;
  if (isPartyCardGame(hay) && !TCG_BRANDS.test(hay)) return false;
  if (isVideoGameHardwareTitle(hay)) return false;
  if (TCG_BRANDS.test(hay)) return true;
  if (TCG_ACCESSORIES.test(hay)) return true;
  return false;
}

/** Título genérico “carta” sem marca TCG — não é nicho. */
export function looksLikeWeakCardTitle(title: string): boolean {
  const hay = title.toLowerCase();
  if (isTcgCollectible(hay)) return false;
  return /\bcartas?\b|jogo de carta/.test(hay);
}

/**
 * Quanto mais “de verdade” o TCG, maior o score.
 * Pokémon / Yu-Gi-Oh / sleeves / fichário > outras cartas (Topps, UFC, NBA).
 */
export function tcgPriorityScore(title: string, extra = ""): number {
  const hay = `${title} ${extra}`.toLowerCase();
  if (!isTcgCollectible(title, extra)) return 0;
  let n = 8;
  if (TCG_CORE.test(hay)) n += 22;
  if (TCG_ACCESSORIES.test(hay)) n += 18;
  if (/topps|ufc|nba|nfl|mlb|panini|figurinha|basquete|futebol/.test(hay)) {
    n += 10;
  }
  return n;
}

export type TcgKind =
  | "ETB"
  | "Mega Box"
  | "Booster Box"
  | "Booster"
  | "Tin"
  | "Acessório"
  | "";

export function tcgProductKind(title: string): TcgKind {
  const t = title.toLowerCase();
  if (/elite trainer|\betb\b|box do treinador|box treinador elite/.test(t)) {
    return "ETB";
  }
  if (/mega box|ultra premium|\bupc\b/.test(t)) return "Mega Box";
  if (/booster box|display booster|caixa booster/.test(t)) return "Booster Box";
  if (/booster pack|pacote booster|sobre booster|\bbooster\b/.test(t)) {
    return "Booster";
  }
  if (/\btin\b|\blata\b/.test(t)) return "Tin";
  if (TCG_ACCESSORIES.test(t)) return "Acessório";
  return "";
}

export function cardLanguage(title: string): "PT-BR" | "EN" | "JP" | "" {
  const t = title.toLowerCase();
  if (/portugu[eê]s|\bpt-?br\b/.test(t)) return "PT-BR";
  if (/\bjapon[eê]s\b|\bjapanese\b|\bjp\b/.test(t)) return "JP";
  if (/\benglish\b|\bingl[eê]s\b|\ben-?us\b|\beng\b/.test(t)) return "EN";
  return "";
}

export function presaleHint(title: string, extra = ""): string {
  const hay = `${title} ${extra}`;
  const m = hay.match(
    /pr[eé]-?venda[^\d]{0,24}(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)/i,
  );
  if (m) return `Pré-venda · ${m[1]}`;
  if (/pr[eé]-?venda|lançamento em \d/i.test(hay)) {
    return "Pré-venda — confira a data no anúncio";
  }
  return "";
}

/** Reprint caro sem desconto visível — não parece achadinho. */
export function isExpensiveReprint(
  title: string,
  price: number,
  oldPrice: number | null,
): boolean {
  const hay = title.toLowerCase();
  if (
    !/reprint|reimpress|unlimited edition|classic collection|base set|celebrations reprint/.test(
      hay,
    )
  ) {
    return false;
  }
  const minPrice = getSettingNum("reprint_min_price", 180, 50, 5000);
  const minDisc = getSettingNum("reprint_min_discount_pct", 8, 0, 90) / 100;
  const disc =
    oldPrice && oldPrice > price ? 1 - price / oldPrice : 0;
  return price >= minPrice && disc < minDisc;
}

export function isGenericTcgSeller(name: string | null | undefined): boolean {
  const n = String(name || "");
  if (!n) return false;
  return /importados?|atacad[oa]|da china|shopping china|sem loja oficial|full import|generica/.test(
    n.toLowerCase(),
  );
}
