import {
  isPartyCardGame,
  isTcgCollectible,
  tcgPriorityScore,
  tcgProductKind,
  cardLanguage,
  isExpensiveReprint,
} from "../src/services/tcgFilter.ts";
import { isVideoGameDeal } from "../src/services/gamesFilter.ts";

const tcgCases: Array<[string, boolean]> = [
  ["Galápagos Dobble Jogo de Cartas DOB101", false],
  ["Jogo de Cartas UNO Original", false],
  ["Pokémon Booster Box Escarlate", true],
  ["Yu-Gi-Oh Deck Estrutural", true],
  ["Sleeves Ultra Pro para cartas TCG", true],
  ["Fichário pasta para cartas Pokémon", true],
  ["Pasta binder Pokémon português", true],
  ["Sleeves Dragon Shield para Magic", true],
  ["Deck box cartas TCG", true],
  ["Playmat Pokémon oficial", true],
  ["Álbum pasta cartas Yu-Gi-Oh", true],
  ["Topps Chrome UFC trading card", true],
  ["Carta de basquete NBA Panini", true],
  ["Baralho 52 cartas plástico", false],
  ["Munchkin Jogo De Cartas Galápagos", false],
  ["Pokémon Scarlet Nintendo Switch", false],
];

const gamesCases: Array<[string, boolean]> = [
  ["Galápagos Dobble Jogo de Cartas DOB101", false],
  ["Jogo de Cartas UNO Original", false],
  ["Beast Of Reincarnation - Mídia Física PS5", true],
  ["Controle DualSense PS5", true],
  ["Carregador de controle PS4/PS5", true],
  ["Gift Card PSN 100 reais", true],
  ["Xbox Series S console", true],
  ["Pokémon Scarlet Nintendo Switch", true],
  ["Cadeira gamer escritório", false],
  ["Headset HyperX Cloud gamer", true],
  ["SSD 2TB WD Black para PS5", true],
  ["Joy-Con Nintendo Switch", true],
  ["Volante Logitech G29 PS5", true],
  ["PlayStation Portal", true],
  ["Steam Deck OLED 1TB", true],
  ["Placa de captura Elgato HD60", true],
  ["Amiibo Zelda Tears of the Kingdom", true],
  ["Case rígida Nintendo Switch OLED", true],
  ["Mouse gamer RGB Redragon", true],
  ["Monitor gamer 27 144Hz", true],
  ["Carteira Steam R$ 50", true],
  ["PSVR2 PlayStation VR", true],
  ["Smart TV 55 Samsung", false],
  ["Soundbar console de som", false],
  ["Mesa gamer RGB", false],
];

let failed = 0;
for (const [title, expect] of tcgCases) {
  const got = isTcgCollectible(title);
  if (got !== expect) {
    failed += 1;
    console.error("FAIL TCG", { title, got, expect, party: isPartyCardGame(title) });
  } else {
    console.log("ok tcg", title, "score", tcgPriorityScore(title));
  }
}
for (const [title, expect] of gamesCases) {
  const got = isVideoGameDeal(title);
  if (got !== expect) {
    failed += 1;
    console.error("FAIL GAMES", { title, got, expect });
  } else {
    console.log("ok games", title);
  }
}
if (failed) {
  console.error(failed, "caso(s) falharam");
  process.exit(1);
}

if (tcgProductKind("Pokémon Elite Trainer Box Scarlet") !== "ETB") {
  failed += 1;
  console.error("FAIL kind ETB");
}
if (tcgProductKind("Booster Box Escarlate e Violeta") !== "Booster Box") {
  failed += 1;
  console.error("FAIL kind booster box");
}
if (cardLanguage("Pokémon Booster English") !== "EN") {
  failed += 1;
  console.error("FAIL lang EN");
}
if (!isExpensiveReprint("Pokémon Base Set reprint Charizard", 400, 410)) {
  failed += 1;
  console.error("FAIL reprint");
}
if (failed) {
  console.error(failed, "caso(s) falharam");
  process.exit(1);
}
console.log("todos os casos ok");
