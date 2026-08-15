/**
 * Games & Consoles = o que o grupo realmente vende no ML:
 * consoles (atuais e retrô), jogos, controles, headset, gift card,
 * memória/SSD, VR, volante, case e acessórios de videogame.
 * Fora: Dobble/UNO/tabuleiro, TCG, cadeira/mesa gamer, som/TV.
 */
import { isPartyCardGame, isTcgCollectible } from "./tcgFilter.js";

const CONSOLE =
  /\bps[345]\b|\bps5\b|\bps4\b|\bps3\b|playstation|ps.?portal|psp\b|ps vita|xbox(?:\s+(?:one|series|360))?|\bxseries\b|\bnintendo\b|\bswitch\b|switch oled|switch lite|steam\s?deck|rog ally|legion go|wii u?\b|gamecube|mega drive|super nintendo|\bsnes\b|\bnes\b|game boy|nintendo 3ds|new 3ds|videogame|video game|console retr[oô]|console port[aá]til|game stick/;

const GAME_MEDIA =
  /m[ií]dia f[ií]sica|midia fisica|m[ií]dia digital|jogo (?:ps|xbox|nintendo|switch|de (?:ps|xbox|videogame))|game (?:ps[345]|xbox)|pr[ée][- ]?venda.{0,48}(ps|xbox|switch|nintendo)|collector'?s? edition|edi[cç][aã]o (?:de )?colecionador|bundle (?:ps|xbox|switch)/;

const CONTROLLER =
  /dualsense|dualshock|dual shock|edge controller|elite series|joy-?con|pro controller|8bitdo|controle (?:ps|xbox|nintendo|sem fio|gamer|semfio)|gamepad|joystick|fight ?stick|arcade stick|\bg29\b|\bg923\b|\bg920\b|volante.{0,24}(gamer|g29|g923|logitech|thrustmaster|\bps|\bxbox)|pedais? gamer|dire[cç][aã]o gamer/;

const GIFT =
  /gift\s?card|cart[aã]o[- ]presente|vale[- ]presente|\bpsn\b|playstation plus|ps plus|xbox live|game pass|nintendo (?:eshop|online)|microsoft points|carteira steam|saldo steam|gift steam|\bsteam\b.{0,24}(carteira|gift|saldo|wallet)|roblox.{0,16}(gift|card|carteira)|gift.{0,16}roblox|free fire.{0,16}(gift|diamante|recarga)|recarga free fire|riot points|ea play/;

const CHARGER =
  /carregador (?:de )?controle|base (?:de )?carreg|dock (?:nintendo|switch)|charging station|carregador (?:ps[45]|xbox|dualsense|joy-?con)/;

const AUDIO_VR =
  /headset gamer|headphone gamer|fone gamer|pulse 3d|astro a[0-9]|hyperx cloud|steelseries|turtle beach|logitech g pro|psvr|playstation vr|meta quest|\boculus\b/;

const MEMORY_CAPTURE =
  /ssd.{0,24}ps5|ps5.{0,24}ssd|nvme.{0,16}ps5|cart[aã]o (?:de )?mem[oó]ria.{0,20}(nintendo|switch|ps)|memory card|hd externo.{0,16}(xbox|ps|playstation)|expansion card xbox|placa de captura|elgato|capture card/;

const ACCESSORIES =
  /suporte vertical|base (?:vertical|do console)|cooler (?:ps5|ps4|xbox)|capa (?:ps|xbox|nintendo|switch|silicone)|case (?:nintendo|switch|ps|xbox|steam)|bolsa (?:nintendo|switch)|protetor de tela (?:nintendo|switch)|analogico|anal[oó]gico|grip (?:switch|controle)|amiibo|ring-?con|joycon|webcam gamer/;

const PC_GAMING =
  /teclado gamer|mouse gamer|mousepad gamer|mouse pad gamer|kit gamer(?! cadeira)|monitor gamer|monitor (?:144|165|180|240)\s*hz/;

const FURNITURE_OR_AUDIO_HOME =
  /cadeira gamer|poltrona gamer|mesa gamer|escrivaninha|soundbar|console de som|home theater|\bsmart tv\b|\btv 5[0-9]|\btv [4-8][0-9]/;

const BOARD_OR_PARTY =
  /tabuleiro|board game|jogo de mesa|quebra[- ]?cabe[cç]a|\bpuzzle\b|banco imobili[aá]rio|jogo da vida|detetive|\bwar\b|monopoly(?!\s*deal)/;

export function isVideoGameDeal(title: string, extra = ""): boolean {
  const hay = `${title} ${extra}`.toLowerCase();
  if (isPartyCardGame(hay) || BOARD_OR_PARTY.test(hay)) return false;
  if (FURNITURE_OR_AUDIO_HOME.test(hay)) return false;
  if (isTcgCollectible(title, extra) && !CONSOLE.test(hay) && !GAME_MEDIA.test(hay)) {
    return false;
  }
  return (
    CONSOLE.test(hay) ||
    GAME_MEDIA.test(hay) ||
    CONTROLLER.test(hay) ||
    GIFT.test(hay) ||
    CHARGER.test(hay) ||
    AUDIO_VR.test(hay) ||
    MEMORY_CAPTURE.test(hay) ||
    ACCESSORIES.test(hay) ||
    PC_GAMING.test(hay)
  );
}

/** Consoles e jogos na frente; headset/SSD/acessório em seguida. */
export function gamesPriorityScore(title: string, extra = ""): number {
  const hay = `${title} ${extra}`.toLowerCase();
  if (!isVideoGameDeal(title, extra)) return 0;
  let n = 8;
  if (CONSOLE.test(hay) && GAME_MEDIA.test(hay)) n += 22;
  else if (CONSOLE.test(hay)) n += 16;
  else if (GAME_MEDIA.test(hay)) n += 18;
  if (CONTROLLER.test(hay) || CHARGER.test(hay)) n += 12;
  if (GIFT.test(hay)) n += 10;
  if (AUDIO_VR.test(hay) || MEMORY_CAPTURE.test(hay)) n += 8;
  if (ACCESSORIES.test(hay) || PC_GAMING.test(hay)) n += 6;
  return n;
}
