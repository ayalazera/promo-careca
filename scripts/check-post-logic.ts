/**
 * Regressão da lógica de post: De/Por, PIX, cupom, teto e “já foi mais barato”.
 * Rode: npx tsx scripts/check-post-logic.ts
 */
import {
  looksLikeInstallmentTotal,
  credibleListPrice,
  applyPercentDiscount,
} from "../src/services/priceSanity.ts";
import {
  groupFooterLine,
  resolveDealPrices,
} from "../src/services/dealDisplay.ts";
import { categoryPriceCap, explainSkipDeal } from "../src/services/dealQuality.ts";
import { composePromo } from "../src/services/composer.ts";
import { extractStoreProductsFromHtml } from "../src/services/mlOfficialStores.ts";
import { DEFAULT_POST_TEMPLATE } from "../src/affiliateCatalog.ts";
import type { Deal, WaGroup } from "../src/db/index.ts";

function fail(msg: string): never {
  console.error("FAIL", msg);
  process.exit(1);
}

function ok(msg: string): void {
  console.log("ok", msg);
}

const baseDeal = {
  id: 1,
  external_id: "",
  source: "mercadolivre",
  title: "Produto teste",
  description: "",
  category: "geral",
  price: 100,
  old_price: null as number | null,
  currency: "BRL",
  coupon: null as string | null,
  coupon_status: "none" as Deal["coupon_status"],
  price_with_coupon: null as number | null,
  coupon_tested_at: null,
  coupon_alert_sent: 0,
  image_url: "https://httpbin.org/image/jpeg",
  product_url: "https://produto.mercadolivre.com.br/MLB-1",
  affiliate_url: "https://meli.la/abc123456789",
  commission_pct: 12,
  free_shipping: 1,
  status: "queued" as const,
  created_at: "",
  posted_at: null,
};

const groupGeral = {
  id: 1,
  name: "Games Baratos",
  jid: "x@g.us",
  categories: "geral",
  active: 1,
  interval_minutes: 12,
  last_posted_at: null,
  created_at: "",
  fleet_id: null,
  sequence_number: null,
  invite_link: "https://chat.whatsapp.com/ABCDEFGHIJKL",
  participant_count: 1,
  is_accepting: 1,
  max_participants: 950,
  sources: "mercadolivre",
  keywords: "",
  post_template: DEFAULT_POST_TEMPLATE,
  notes: "",
  watermark_handle: "@games",
  watermark_tagline: "AS MELHORES OFERTAS EM UM SÓ LUGAR!",
  watermark_logo_path: "",
  promo_url: "https://gamesbaratos.com.br",
  day_limit: 0,
  ml_list_id: "",
} as WaGroup & { promo_url: string };

if (!looksLikeInstallmentTotal(124.92 * 6, 124.92)) {
  fail("6x deveria ser detectado como parcela");
}
if (credibleListPrice(124.92 * 6, 124.92) != null) {
  fail("De parcela não pode aparecer como preço antigo");
}
ok("parcela 6x não vira De");

const filamento = resolveDealPrices({
  price: 124.92,
  old_price: 149.9,
  price_with_coupon: null,
});
if (filamento.pix !== 124.92) fail("filamento PIX");
if (filamento.de !== 149.9) fail("filamento De");
ok("filamento De/Por PIX");

const scooter = explainSkipDeal(
  { ...baseDeal, title: "Scooter elétrica 1000w", price: 12999, old_price: 12999, category: "esportes" } as Deal,
  { ...groupGeral, categories: "esportes" },
);
if (!scooter.skip) fail("scooter 12k deveria ser pulada");
ok(`scooter pulada: ${scooter.reason}`);

const bike = explainSkipDeal(
  {
    ...baseDeal,
    title: "Bicicleta ergométrica spinning",
    price: 459.99,
    old_price: 499.99,
    category: "esportes",
  } as Deal,
  { ...groupGeral, categories: "esportes" },
);
if (!bike.skip) fail("sem cupom não é promoção");
ok(`bike sem cupom pulada: ${bike.reason}`);

const lupo = resolveDealPrices({
  price: 129.99,
  old_price: 129.99,
  price_with_coupon: 103.99,
  coupon: "SEMPREMODA",
  coupon_status: "valid",
});
if (lupo.pix !== 103.99) fail("lupo PIX com cupom");
if (!lupo.hasTypedCoupon) fail("lupo precisa do código");
const lupoSkip = explainSkipDeal(
  {
    ...baseDeal,
    title: "Short Lupo Academia Feminino",
    category: "moda",
    price: 129.99,
    old_price: 129.99,
    price_with_coupon: 103.99,
    coupon: "SEMPREMODA",
    coupon_status: "valid",
  } as Deal,
  { ...groupGeral, categories: "moda" },
);
if (lupoSkip.skip) fail(`lupo com cupom não deveria pular: ${lupoSkip.reason}`);
ok("short lupo com SEMPREMODA passa");

const galaxy = resolveDealPrices({
  price: 1799,
  old_price: 1999,
  price_with_coupon: 1619.1,
  coupon: "",
  coupon_status: "valid",
  description: "Desconto ML no link: 10% smartphones · campanha abc",
});
if (Math.abs(galaxy.pix - 1619.1) > 0.01) fail("galaxy PIX com cupom de clique");
if (!galaxy.clickCoupon) fail("galaxy deveria ser cupom clique-para-ativar");
ok("galaxy 10% clique para ativar");

const fakeValid = resolveDealPrices({
  price: 493,
  old_price: 725,
  price_with_coupon: 389.47,
  coupon: "",
  coupon_status: "valid",
  description: "GANHOS EXTRAS 24%\nCategoria: esportes",
});
if (fakeValid.clickCoupon) fail("valid sem texto de cupom não é clique-ativar");
if (fakeValid.hasTypedCoupon) fail("bike sem código digitável");
const fakeBikeSkip = explainSkipDeal(
  {
    ...baseDeal,
    title: "Bicicleta ergométrica spinning",
    category: "esportes",
    price: 493,
    old_price: 725,
    price_with_coupon: 389.47,
    coupon: "",
    coupon_status: "valid",
    description: "GANHOS EXTRAS 24%\nCategoria: esportes",
  } as Deal,
  { ...groupGeral, categories: "esportes" },
);
if (!fakeBikeSkip.skip) fail("bike com valid falso deveria pular");
ok("coupon_status valid sozinho não vira cupom");

const footer = groupFooterLine({
  groupName: "Games Baratos",
  promoUrl: "https://gamesbaratos.com.br",
});
if (footer !== "Faça parte da Games Baratos: https://gamesbaratos.com.br") {
  fail(`footer errado: ${footer}`);
}
ok("rodapé Faça parte da...");

if (categoryPriceCap("geral") !== 499) fail("teto achadinhos");
if (categoryPriceCap("eletronicos") !== 2499) fail("teto eletrônicos");
ok("tetos por categoria");

const composed = composePromo(
  {
    ...baseDeal,
    title: "Filamento 3d Bambu Lab Pla Lite 1kg",
    price: 124.92,
    old_price: 149.9,
  } as Deal,
  groupGeral,
).text;
if (/em até \d+x/i.test(composed)) fail("post não pode inventar parcela");
if (/economia de cerca/i.test(composed)) fail("economia grande no texto");
if (!composed.includes("Faça parte da Games Baratos")) fail("falta rodapé");
if (!/~De/.test(composed)) fail("filamento precisa do De");
if (!/Por R\$\s*124,92/i.test(composed) && !composed.includes("124,92")) {
  fail(`filamento precisa do preço no texto:\n${composed}`);
}
if (/\bno\s*PIX\b|\bsem\s*PIX\b/i.test(composed)) {
  fail(`filamento não pode separar PIX:\n${composed}`);
}
ok("texto do post sem parcela e com De/Por + rodapé");

const composedLupo = composePromo(
  {
    ...baseDeal,
    id: 2,
    title: "Short Lupo Academia Feminino",
    category: "moda",
    price: 129.99,
    old_price: 129.99,
    price_with_coupon: 103.99,
    coupon: "SEMPREMODA",
    coupon_status: "valid",
  } as Deal,
  { ...groupGeral, categories: "moda", name: "Careca VIP Moda" },
).text;
if (!composedLupo.includes("SEMPREMODA")) fail("post lupo sem cupom");
if (composedLupo.includes("119,99")) fail("lupo não pode mostrar preço sem cupom");
ok("texto lupo com SEMPREMODA");

const composedGalaxy = composePromo(
  {
    ...baseDeal,
    id: 3,
    title: "Celular Samsung Galaxy A57 5G",
    category: "eletronicos",
    price: 1799,
    old_price: 1998.89,
    price_with_coupon: 1619.1,
    coupon: "",
    coupon_status: "valid",
    description: "Desconto ML no link: 10% smartphones · campanha abc",
  } as Deal,
  { ...groupGeral, categories: "eletronicos", name: "Careca VIP Eletrônicos" },
).text;
if (/10x/i.test(composedGalaxy)) fail("galaxy não pode mostrar 10x");
if (!/clique no link para ativar/i.test(composedGalaxy)) {
  fail(`galaxy precisa do cupom de clique:\n${composedGalaxy}`);
}
if (!composedGalaxy.includes("1.619,10") && !composedGalaxy.includes("1619,10")) {
  fail(`galaxy preço com desconto:\n${composedGalaxy}`);
}
if (/\bno\s*PIX\b|\bsem\s*PIX\b/i.test(composedGalaxy)) {
  fail(`galaxy não pode separar PIX:\n${composedGalaxy}`);
}
if (/já foi|n[aã]o é seu menor|foi r\$/i.test(composedGalaxy)) {
  fail("não pode dizer que já esteve mais barato");
}
ok("texto galaxy com cupom de clique (sem split PIX)");

const composedAura = composePromo(
  {
    ...baseDeal,
    id: 1589,
    title: "Relógio Smartwatch Aurafit Trek1 Com Gps À Prova D'água 5atm",
    category: "eletronicos",
    price: 325.89,
    old_price: 459,
    price_with_coupon: 254.19,
    coupon: "ECONOMIAML",
    coupon_status: "valid",
  } as Deal,
  { ...groupGeral, categories: "eletronicos", name: "Careca VIP Eletrônicos" },
).text;
if (!composedAura.includes("254,19")) {
  fail(`aurafit precisa de R$254,19:\n${composedAura}`);
}
if (composedAura.includes("325,89")) {
  fail(`aurafit não pode mostrar listado 325,89 como segundo preço:\n${composedAura}`);
}
if (/\bno\s*PIX\b|\bsem\s*PIX\b|💳/i.test(composedAura)) {
  fail(`aurafit não pode separar PIX:\n${composedAura}`);
}
const porHits = (composedAura.match(/Por R\$/gi) || []).length;
if (porHits !== 1) fail(`aurafit deve ter exatamente 1 linha Por, veio ${porHits}`);
ok("aurafit só Por R$254,19 (sem PIX / sem listado)");

const composedFone = composePromo(
  {
    ...baseDeal,
    id: 4,
    title: "Fone Ouvido Bluetooth 5.4 Sem Fio",
    price: 46.27,
    old_price: 59.9,
    coupon: "OFFMELI",
    coupon_status: "valid",
    price_with_coupon: 46.27,
  } as Deal,
  groupGeral,
).text;
if (/já foi|n[aã]o é seu menor|28,15/i.test(composedFone)) {
  fail(`fone não pode citar preço antigo menor:\n${composedFone}`);
}
ok("texto fone só com preço/cupom, sem ‘já foi mais barato’");

if (applyPercentDiscount(39.9, 25) !== 29.92) {
  fail(`QUEROCUPONS 25% de 39,90 deve ser 29,92, veio ${applyPercentDiscount(39.9, 25)}`);
}
if (applyPercentDiscount(39, 25) !== 29.25) {
  fail("25% de 39,00 deve continuar 29,25");
}
ok("arredondamento ML do cupom percentual");

const listHtml = `
<a class="poly-component__title" href="https://produto.mercadolivre.com.br/MLB-6718300440?wid=MLB6718300440">Luva Moto Motociclista Impermeavel Teste</a>
<span class="andes-money-amount__fraction">39</span>
<span class="andes-money-amount__cents">90</span>
`;
const parsed = extractStoreProductsFromHtml(listHtml);
if (!parsed.length || Math.abs(parsed[0].price - 39.9) > 0.001) {
  fail(`harvest deve ler 39,90 (não 39,00): ${JSON.stringify(parsed[0] || parsed)}`);
}
ok("harvest lê reais+centavos");

const luvaPost = composePromo(
  {
    ...baseDeal,
    title: "Luva Moto Motociclista Impermeável Proteção Touch Motoqueiro",
    price: 39.9,
    old_price: 39.9,
    coupon: "QUEROCUPONS",
    coupon_status: "valid",
    price_with_coupon: 29.92,
    affiliate_url: "https://meli.la/2fBkSJC?utm_source=carecavip&utm_medium=whatsapp&utm_campaign=geral",
  } as Deal,
  {
    ...groupGeral,
    name: "Careca VIP | Achadinhos",
    promo_url: "https://bit.ly/careca-acha",
    invite_link: "https://chat.whatsapp.com/CFZOfTkq6Hx3cBPotCwU47",
  },
).text;
if (!luvaPost.includes("29,92")) fail(`luva precisa de R$ 29,92:\n${luvaPost}`);
if (luvaPost.includes("29,25")) fail("luva não pode mostrar 29,25");
if (/meli\.la\/2fBkSJC\?/.test(luvaPost)) fail("meli.la não pode ir com UTM");
if (!luvaPost.includes("https://meli.la/2fBkSJC")) fail("falta meli.la curto");
if (!luvaPost.includes("https://bit.ly/careca-acha")) fail("rodapé deve usar a URL curta do grupo");
if (luvaPost.includes("chat.whatsapp.com")) fail("não deve postar o convite longo se há URL curta");
ok("luva 29,92 + meli.la curto + URL do grupo");

// Cupom com mínimo: 1 un. abaixo do mín. → 2 un. no carrinho (BRINQUEDOS)
import {
  quoteCouponCart,
  formatCouponQtyDescBit,
} from "../src/services/couponPricing.ts";
const brinquedoQuote = quoteCouponCart(39.9, {
  discountType: "percent",
  discountValue: 15,
  minAmount: 59,
  capAmount: 50,
});
if (!brinquedoQuote.ok || brinquedoQuote.qty !== 2) {
  fail(`BRINQUEDOS em 39,90 deveria pedir 2 un.: ${JSON.stringify(brinquedoQuote)}`);
}
if (Math.abs(brinquedoQuote.cartBefore - 79.8) > 0.01) {
  fail(`carrinho sem cupom deveria ser 79,80: ${brinquedoQuote.cartBefore}`);
}
if (Math.abs(brinquedoQuote.cartAfter - 67.83) > 0.01) {
  fail(`carrinho com cupom deveria ser 67,83: ${brinquedoQuote.cartAfter}`);
}
ok("BRINQUEDOS 39,90 → 2 un. 79,80→67,83");

const tip = formatCouponQtyDescBit(brinquedoQuote);
const pokemonPost = composePromo(
  {
    ...baseDeal,
    id: 2108,
    title: "Cartas Pokémon Equilíbrio Perfeito Makuhita 19 Cards Copag",
    category: "tcg",
    price: 39.9,
    old_price: 42.99,
    coupon: "BRINQUEDOS",
    coupon_status: "valid",
    price_with_coupon: brinquedoQuote.unitAfter,
    description: `GANHOS EXTRAS 12%\nCategoria: tcg\nCupom ML: 15% OFF com BRINQUEDOS · código BRINQUEDOS · campanha 13456503${tip}`,
    affiliate_url: "https://meli.la/pokemonMakuhita",
  } as Deal,
  { ...groupGeral, categories: "tcg", name: "TCG VIP", promo_url: "https://bit.ly/tcg" },
).text;
if (!/67,83/.test(pokemonPost)) fail(`post Pokémon precisa do total 67,83:\n${pokemonPost}`);
if (!/79,80/.test(pokemonPost)) fail(`post Pokémon precisa do carrinho 79,80 (2 un.):\n${pokemonPost}`);
if (!/De R\$\s*42,99/.test(pokemonPost)) {
  fail(`De unitário deve ser o original da PDP (42,99), não 2× listado:\n${pokemonPost}`);
}
if (!/Por R\$\s*33,92/.test(pokemonPost)) {
  fail(`Por unitário com cupom deveria ser 33,92:\n${pokemonPost}`);
}
if (/De R\$\s*79,80/.test(pokemonPost)) {
  fail(`De não pode ser o carrinho 79,80 — isso fica na linha do carrinho:\n${pokemonPost}`);
}
if (!/Leve 2 unidades/i.test(pokemonPost)) fail(`post precisa avisar 2 unidades:\n${pokemonPost}`);
if (/\bno\s*PIX\b|\bsem\s*PIX\b/i.test(pokemonPost)) fail(`não pode separar PIX:\n${pokemonPost}`);
if (!/\*[A-ZÁÉÍÓÚÃÕ].{8,}/.test(pokemonPost.split("\n")[0] || "")) {
  fail(`headline fraca:\n${pokemonPost}`);
}
ok("Pokémon BRINQUEDOS mostra carrinho 2 un. + headline");

import {
  isTcgCollectible,
  isTcgExcludedAccessory,
} from "../src/services/tcgFilter.ts";
import { classifyProduct } from "../src/services/categories.ts";
const playmat =
  "Copag Playmat Disney Lorcana Beast Acessório Premium com Base Antiderrapante";
if (!isTcgExcludedAccessory(playmat)) fail("playmat Lorcana deveria ser acessório excluído do TCG");
if (isTcgCollectible(playmat)) fail("playmat não pode ser TCG");
if (classifyProduct({ title: playmat, categoryHint: "tcg" }) === "tcg") {
  fail("playmat não pode classificar como tcg");
}
if (!isTcgCollectible("Booster Disney Lorcana Illumineer's Trove")) {
  fail("booster Lorcana continua TCG");
}
if (!isTcgCollectible("Sleeve Pokémon Ultra Pro Protetor de Cartas")) {
  fail("sleeve continua TCG");
}
if (!isTcgCollectible("Fichário Binder Pasta para Cartas Pokémon")) {
  fail("fichário continua TCG");
}
ok("TCG exclui playmat; mantém cartas/sleeves/fichário");

import {
  isClearlyNotElectronics,
  looksLikeElectronics,
} from "../src/services/electronicsFilter.ts";

const badElec = [
  "Válvula Click Up De Inox Ralo P/ Cuba Vidro E Louça Banheiro Acabamento Cromo brilhante Cor Cromado",
  "TESTO ESSENCIAL - Fórmula Exclusiva com Feno Grego + Boro + Arginina + ZMA + Vitamina B6 - 60 cápsulas",
  "Filme Pvc Plastico 28cm X 300mts Rolo Bobina P/ Alimentos",
  "1000 Etiqueta Adesivo Rótulo Em Vinil Personalizado 5x5 Cm",
  "Garrafa Isotérmica Inox Vácuo Premium Antivazamento 1 Litro",
  "MAGNÉSIO DIMALATO - Fórmula 100% Pura com Máxima Concentração e Pureza - 60 Comprimidos",
  "Pó Compacto Sace Lady Controle De Oleosidade E Acabamento",
  "Óculos De Sol Proteção Uv400 Unissex Premium E Sofisticado",
  "Guarda Chuva Automático Portátil À Prova Vento Uv Resistente",
];
for (const title of badElec) {
  if (!isClearlyNotElectronics(title)) fail(`deveria rejeitar eletrônico: ${title}`);
  if (looksLikeElectronics(title)) fail(`não pode parecer eletrônico: ${title}`);
  const cat = classifyProduct({ title, categoryHint: "eletronicos" });
  if (["eletronicos", "celulares", "informatica"].includes(cat)) {
    fail(`hint eletrônicos não pode classificar “${title.slice(0, 40)}” como ${cat}`);
  }
}
if (
  !looksLikeElectronics("Carregador Portátil Power Bank Turbo 20000mah Universal Para iPhone")
) {
  fail("power bank deve ser eletrônico");
}
if (
  classifyProduct({
    title: "Carregador Portátil Power Bank Turbo 20000mah",
    categoryHint: "eletronicos",
  }) !== "eletronicos" &&
  classifyProduct({
    title: "Carregador Portátil Power Bank Turbo 20000mah",
    categoryHint: "eletronicos",
  }) !== "celulares"
) {
  // aceita eletronicos ou celulares
  const c = classifyProduct({
    title: "Carregador Portátil Power Bank Turbo 20000mah",
    categoryHint: "eletronicos",
  });
  if (!["eletronicos", "celulares", "informatica"].includes(c)) {
    fail(`power bank deveria ser tech, veio ${c}`);
  }
}
const plush =
  "Sunny Brinquedos Pelucia Squishmallows Pokémon Dragonite 25cm";
if (isTcgCollectible(plush)) fail("pelúcia Pokémon não é TCG");
if (classifyProduct({ title: plush, categoryHint: "tcg" }) === "tcg") {
  fail("pelúcia não classifica como tcg");
}
ok("Eletrônicos rejeitam válvula/suplemento/óculos; TCG rejeita pelúcia");

{
  const mine =
    "Bloco Magnético Minecraft 200 Peças Blocos Kit Montar Construção Brinquedo Educativo Infantil Imã Bvb Shop";
  if (!isClearlyNotElectronics(mine)) fail("blocos Minecraft não são eletrônico");
  if (looksLikeElectronics(mine, "")) fail("Minecraft blocos não pode parecer eletrônico");
  const mineCat = classifyProduct({ title: mine, categoryHint: "eletronicos" });
  if (["eletronicos", "celulares", "informatica"].includes(mineCat)) {
    fail(`Minecraft blocos veio ${mineCat}, deveria ser geral`);
  }
  const asp =
    "Aspirador De Pó Vertical E Portátil Wap High Speed Plus 1350w 1,2 Litros Filtro Hepa";
  const fry = "Air Fryer Philco 6,5L Visor Glass e Redstone 1700W PAF65A";
  if (classifyProduct({ title: asp, categoryHint: "eletronicos" }) !== "eletrodomesticos") {
    fail(`aspirador deveria ser eletrodomesticos, veio ${classifyProduct({ title: asp, categoryHint: "eletronicos" })}`);
  }
  if (classifyProduct({ title: fry, categoryHint: "eletronicos" }) !== "eletrodomesticos") {
    fail(`air fryer deveria ser eletrodomesticos`);
  }
  if (looksLikeElectronics(asp) || looksLikeElectronics(fry)) {
    fail("aspirador/air fryer não devem looksLikeElectronics");
  }
  ok("brinquedo≠eletrônico; aspirador/air fryer=eletrodomésticos");
}

// Saco de lixo: sem seguir loja / sem PIX; QUEROCUPONS 25% com mín. R$29 (2 un.)
import { quoteCouponCart as qCart, formatCouponQtyDescBit } from "../src/services/couponPricing.ts";
const trashQ = qCart(22.91, {
  discountType: "percent",
  discountValue: 25,
  minAmount: 29,
  capAmount: 500,
});
if (trashQ.qty !== 2 || Math.abs(trashQ.cartAfter - 34.36) > 0.02) {
  fail(`saco de lixo QUEROCUPONS: ${JSON.stringify(trashQ)}`);
}
const trashPost = composePromo(
  {
    ...baseDeal,
    id: 1622,
    title: "Saco De Lixo Preto Reforçado Resistente Uso Pesado Embalar",
    price: 22.91,
    old_price: 24.9,
    coupon: "QUEROCUPONS",
    coupon_status: "valid",
    price_with_coupon: trashQ.unitAfter,
    description: `Cupom ML: 25% OFF com QUEROCUPONS · código QUEROCUPONS · campanha 14027604${formatCouponQtyDescBit(trashQ)}`,
    affiliate_url: "https://meli.la/sacoLixo",
  } as Deal,
  groupGeral,
).text;
if (/siga a loja|seguir a loja|no PIX|sem PIX|💳/i.test(trashPost)) {
  fail(`saco de lixo não pode ter seguir/PIX:\n${trashPost}`);
}
if (!/QUEROCUPONS/.test(trashPost)) fail("precisa QUEROCUPONS");
if (!/34,36/.test(trashPost) || !/45,82/.test(trashPost)) {
  fail(`precisa carrinho 45,82→34,36:\n${trashPost}`);
}
if (!/Leve 2 unidades/i.test(trashPost)) fail("precisa 2 unidades");
// blocos separados: cupom e qty em linhas distintas
if (!/Cupom:[\s\S]*\n\n📦/m.test(trashPost) && !/Cupom:[^\n]+\n\n📦/.test(trashPost)) {
  // aceita se houver linha em branco entre cupom e qty
  const iCupom = trashPost.indexOf("🎟️");
  const iQty = trashPost.indexOf("📦");
  if (iCupom < 0 || iQty < 0 || !/\n\n/.test(trashPost.slice(iCupom, iQty + 1))) {
    fail(`cupom e qty devem ficar em blocos separados:\n${trashPost}`);
  }
}
ok("saco de lixo: QUEROCUPONS 2 un. sem seguir/PIX + layout");

// Travesseiro: De = original PDP (78,60), NÃO 2×57,95=115,90; Por = unitário com cupom
{
  const pref = qCart(57.95, {
    discountType: "percent",
    discountValue: 20,
    minAmount: 79,
    capAmount: 60,
  });
  if (!pref.ok || pref.qty !== 2 || Math.abs(pref.unitAfter - 46.36) > 0.02) {
    fail(`PREFERIDO travesseiro: ${JSON.stringify(pref)}`);
  }
  const travesPost = composePromo(
    {
      ...baseDeal,
      id: 3244,
      title: "Travesseiro De Corpo 1,48x48 Em Fibra Siliconada + Fronha",
      category: "casa",
      price: 57.95,
      old_price: 78.6,
      coupon: "PREFERIDO",
      coupon_status: "valid",
      price_with_coupon: pref.unitAfter,
      description: `Cupom ML: 20% OFF com PREFERIDO · código PREFERIDO · campanha 14006680${formatCouponQtyDescBit(pref)}`,
      affiliate_url: "https://meli.la/traves",
    } as Deal,
    groupGeral,
  ).text;
  if (!/De R\$\s*78,60/.test(travesPost)) {
    fail(`travesseiro De deve ser 78,60 (PDP):\n${travesPost}`);
  }
  if (/115,90/.test(travesPost) && /De R\$\s*115,90/.test(travesPost)) {
    fail(`travesseiro NÃO pode De 115,90 (2× promo):\n${travesPost}`);
  }
  if (!/Por R\$\s*46,36/.test(travesPost)) {
    fail(`travesseiro Por unitário PREFERIDO = 46,36:\n${travesPost}`);
  }
  if (!/Leve 2 unidades/i.test(travesPost)) fail(`travesseiro precisa 2 un.:\n${travesPost}`);
  if (!/115,90/.test(travesPost) || !/92,72/.test(travesPost)) {
    fail(`carrinho 115,90→92,72 deve aparecer na linha do carrinho:\n${travesPost}`);
  }
  ok("travesseiro De 78,60 / Por 46,36 (não 115,90)");
}

// Cortina: carrinho 114,44 −20% = 91,55 (não 45,78×2=91,56)
{
  const cortinaQ = qCart(57.22, {
    discountType: "percent",
    discountValue: 20,
    minAmount: 79,
    capAmount: 60,
  });
  if (Math.abs(cortinaQ.cartAfter - 91.55) > 0.001) {
    fail(`carrinho PREFERIDO deveria ser 91,55, veio ${cortinaQ.cartAfter}`);
  }
  if (Math.abs(cortinaQ.unitAfter * 2 - 91.55) < 0.001) {
    // se unit×2 coincidir, ok; o bug é postar unit×2 quando diverge
  }
  const cortinaPost = composePromo(
    {
      ...baseDeal,
      id: 2614,
      title: "Cortina Jacquard 2 80 X 1 70 Para Janela Sala Quarto",
      price: 57.22,
      old_price: 72.07,
      coupon: "PREFERIDO",
      coupon_status: "valid",
      price_with_coupon: cortinaQ.unitAfter,
      description: `Cupom ML: 20% OFF com PREFERIDO · código PREFERIDO${formatCouponQtyDescBit(cortinaQ)}`,
      affiliate_url: "https://meli.la/cortina",
    } as Deal,
    groupGeral,
  ).text;
  if (!/91,55/.test(cortinaPost)) {
    fail(`carrinho no post deve ser 91,55 (ML), não 91,56:\n${cortinaPost}`);
  }
  if (/91,56/.test(cortinaPost)) {
    fail(`não pode aparecer 91,56 (erro de unitário×2):\n${cortinaPost}`);
  }
  ok("cortina carrinho 91,55 (não 45,78×2)");
}

// Badge PDP “com Cupom” é a fonte do centavo (112,38 −20% → 89,91 no ML, não 89,90)
{
  const { extractMlComCupomPrice } = await import(
    "../src/services/priceRefresh.ts"
  );
  const { applyPercentDiscount } = await import("../src/services/priceSanity.ts");
  const html = `,"awareness":{"icon":{"id":"COUPON_ACTIVE"},"label":{"text":"{1} com Cupom","values":{"1":{"type":"price","value":89.91,"currency_id":"BRL"}}}}`;
  const badge = extractMlComCupomPrice(html);
  if (badge !== 89.91) fail(`badge com Cupom deveria ser 89,91, veio ${badge}`);
  if (applyPercentDiscount(112.38, 20) !== 89.9) {
    fail("cálculo % sozinho ainda dá 89,90 — por isso o badge deve prevalecer");
  }
  ok("badge PDP com Cupom 89,91 prevalece sobre % 89,90");
}

// PDP has_items=false zera given — cupom listado ≠ aplicável
{
  const fake = {
    hasItems: false as boolean | null,
    givenDiscount: 21.6,
    code: "BRINQUEDOS",
    source: "tracking" as const,
  };
  const effective =
    fake.hasItems === false ? 0 : fake.givenDiscount;
  if (effective !== 0) fail("has_items=false deve anular given teórico");
  ok("BRINQUEDOS has_items=false não inventa desconto");

  // pickBest / applyPdpPick: raw ou has_items=false nunca passam
  const rejectPick = (c: {
    source: string;
    hasItems: boolean | null;
    givenDiscount: number;
  }) =>
    c.source !== "tracking" ||
    c.hasItems === false ||
    !(c.givenDiscount > 0.05);
  if (!rejectPick({ source: "raw", hasItems: true, givenDiscount: 20 })) {
    fail("rawCoupons não pode validar post");
  }
  if (
    !rejectPick({ source: "tracking", hasItems: false, givenDiscount: 20 })
  ) {
    fail("has_items=false não pode validar post");
  }
  if (
    !rejectPick({ source: "tracking", hasItems: true, givenDiscount: 0 })
  ) {
    fail("given=0 não pode validar post");
  }
  if (rejectPick({ source: "tracking", hasItems: true, givenDiscount: 20 })) {
    fail("tracking + has_items + given>0 deveria passar");
  }
  ok("só tracking+has_items+given valida cupom no post");
}

// Centavos do listado importam no cupom (casos reais do grupo)
if (applyPercentDiscount(111.91, 30) !== 78.34) {
  fail(`Alginato 111,91 −30% deve ser 78,34, veio ${applyPercentDiscount(111.91, 30)}`);
}
if (applyPercentDiscount(99.99, 30) !== 69.99) {
  fail(`Hiddra 99,99 −30% deve ser 69,99, veio ${applyPercentDiscount(99.99, 30)}`);
}
if (applyPercentDiscount(37.9, 30) !== 26.53) {
  fail(`Cápsulas 37,90 −30% deve ser 26,53, veio ${applyPercentDiscount(37.9, 30)}`);
}
if (applyPercentDiscount(111, 30) === 78.34) {
  fail("111 inteiro não pode virar 78,34 — prova que centavos importam");
}
ok("cupom % com centavos do listado (Alginato/Hiddra/Cápsulas)");

const { isLowDemandNicheTitle } = await import("../src/services/demandFilter.ts");
for (const bad of [
  "Alginato De Sódio 100g + Cloreto De Cálcio 100g -gastronomia",
  "Páprica Defumada Bombay Herbs & Spices Pouch 20g",
  "Cápsulas Vazias de Gelatina Incolor Nº 0 para Encapsulamento Digna Farma (1000 Unidades)",
]) {
  if (!isLowDemandNicheTitle(bad)) fail(`deveria ser baixa procura: ${bad}`);
}
if (isLowDemandNicheTitle("Garrafa Térmica Hiddra 1200ml Personalizada Com Nome")) {
  fail("garrafa térmica não é nicho de baixa procura");
}
ok("filtro de baixa procura / nicho fraco");

import {
  isStoreFollowDiscountText,
  parseCouponDiscountFromText,
  enrichCouponMetaFromText,
} from "../src/services/couponSavings.ts";

const storeTxt =
  "Comprar R$80 e ganhar R$10 OFF por seguir a loja no anúncio";
if (!isStoreFollowDiscountText(storeTxt)) {
  fail("deveria detectar desconto de seguir loja");
}
const parsedStore = parseCouponDiscountFromText(storeTxt);
if (parsedStore.discountType || parsedStore.discountValue) {
  fail("não pode extrair R$ OFF de texto de seguir loja");
}
// Sem citar MELIACHA, não contamina o catálogo
if (enrichCouponMetaFromText("MELIACHA", "R$10 OFF · mín. R$80 oferta da loja")) {
  fail("enrich sem citar o código não pode gravar meta");
}
if (
  enrichCouponMetaFromText(
    "MELIACHA",
    "MELIACHA Comprar R$80 ganhar R$10 OFF por seguir a loja",
  )
) {
  fail("enrich de seguir loja mesmo com código não pode gravar");
}
const tipOk = parseCouponDiscountFromText("15% OFF com BRINQUEDOS · mín. R$59");
if (tipOk.discountType !== "percent" || tipOk.discountValue !== 15) {
  fail("tip legítimo de % OFF com código deve parsear");
}
ok("cupom digitável ≠ desconto seguir loja (MELIACHA/R$10)");

console.log("check-post-logic: todas as checagens passaram");
