/**
 * O que É eletrônico / celular / informática (para grupos nicho).
 * Rejeita suplemento, casa, moda, beleza, papelaria, brinquedo etc. mesmo se o Hub
 * mandar categoryHint=eletronicos.
 */

/** Aspirador, air fryer, geladeira… → eletrodomésticos (não celular/áudio). */
export function isHomeApplianceTitle(title: string, extra = ""): boolean {
  const hay = `${title} ${extra}`.toLowerCase();
  return (
    /aspirador|rob[oô]\s*aspir|air.?fryer|fritadeira|liquidificador|batedeira|cafeteira|sanduicheira|multiprocessador/.test(
      hay,
    ) ||
    /geladeira|refrigerador|fog[aã]o|cooktop|micro[- ]?ondas|lava[- ]?(?:lou[cç]as|roupa)|lava[- ]?e[- ]?seca|secadora de roupa/.test(
      hay,
    ) ||
    /purificador de [aá]gua|filtro de [aá]gua|ferro de passar|vaporizador|panela el[eé]tric|grill el[eé]tric|forno el[eé]tric/.test(
      hay,
    ) ||
    /ar[- ]?condicionado|climatizador|umidificador|desumidificador|aquecedor/.test(
      hay,
    )
  );
}

/** Brinquedo / montar / infantil — nunca eletrônico. */
export function isToyOrKidsTitle(title: string, extra = ""): boolean {
  const hay = `${title} ${extra}`.toLowerCase();
  return (
    /brinquedo|blocos?\s+magn|bloco magn[eé]tico|kit montar|pe[cç]as?\s+blocos|educativo infantil|lego\b|boneco|boneca|pel[uú]cia|quebra[- ]?cabe[cç]a|massinha|play[- ]?doh|hot wheels|barbie|funko/.test(
      hay,
    ) || /minecraft.*(?:bloco|pe[cç]as|montar|constru)/.test(hay)
  );
}

export function isClearlyNotElectronics(title: string, extra = ""): boolean {
  const hay = `${title} ${extra}`.toLowerCase();
  return (
    isToyOrKidsTitle(title, extra) ||
    /v[aá]lvula|ralo\b|cuba (?:de )?(?:vidro|lou[cç]a)|torneira|acabamento cromo|click up|interfone|porteiro eletr[oô]nico/.test(
      hay,
    ) ||
    /aparador de pelos|barbeador el[eé]tric|m[aá]quina(?: de)? barbear|aparelho de barbear/.test(
      hay,
    ) ||
    /mini\s*compressor|compressor de ar|bomba el[eé]trica(?: de)?(?: ar|pneu)?|inflador (?:de )?pneu/.test(
      hay,
    ) ||
    /testosterona|testo essencial|feno grego|arginina|\bzma\b|precursor da testosterona|ghmuscle|gh[- ]?dro|gh[- ]?muscle/.test(
      hay,
    ) ||
    /magn[eé]sio|dimalato|c[aá]psulas?|comprimidos?|suplemento|creatina|whey|col[aá]geno|bcaa|vitamina/.test(
      hay,
    ) ||
    /filme pvc|bobina|rolo bobina|pl[aá]stico.*alimentos|etiqueta adesivo|r[oó]tulo em vinil|vinil personalizado/.test(
      hay,
    ) ||
    /garrafa isot|garrafa t[eé]rmica|squeeze|antivazamento|inox v[aá]cuo/.test(
      hay,
    ) ||
    /p[oó] compacto|maquiagem|batom|r[ií]mel|blush|base l[ií]quida|sace lady|oleosidade|acabamento matte/.test(
      hay,
    ) ||
    /[oó]culos de sol|prote[cç][aã]o uv400|guarda[- ]?chuva|sombrinha/.test(
      hay,
    ) ||
    /len[cç]ol|travesseiro|panela|tramontina|sabonete|shampoo|perfume|chinelo|camiseta|legging/.test(
      hay,
    ) ||
    /cadeado|ferramenta manual|chave phillips|fita isolante(?!.*el[eé]tric)/.test(
      hay,
    )
  );
}

/** Sinais positivos de eletrônico / tech (sem eletrodoméstico de casa). */
export function looksLikeElectronics(title: string, extra = ""): boolean {
  const hay = `${title} ${extra}`.toLowerCase();
  if (isClearlyNotElectronics(title, extra)) return false;
  if (isHomeApplianceTitle(title, extra)) return false;
  return (
    /smartwatch|smart watch|rel[oó]gio inteligente|fone|earbuds|earbud|headset|airpods|\bbuds\b/.test(
      hay,
    ) ||
    /\bssd\b|nvme|hd externo|pendrive|pen drive|mem[oó]ria (?:usb|ram|ddr)|placa de v[ií]deo|placa[- ]m[aã]e|processador|cooler|water cooler|fonte atx|nobreak/.test(
      hay,
    ) ||
    /notebook|laptop|chromebook|ultrabook|tablet|ipad|kindle|e-?reader/.test(
      hay,
    ) ||
    /smartphone|iphone|galaxy|motorola|xiaomi|redmi|poco\b|celular(?!\s+carro)/.test(
      hay,
    ) ||
    /carregador|power bank|carregador port[aá]til|cabo (?:usb|type[- ]?c|lightning|hdmi)|adaptador usb|hub usb/.test(
      hay,
    ) ||
    /monitor|smart tv|tv\s*\d+|fire stick|chromecast|roku|projetor|webcam|roteador|modem|mesh wifi/.test(
      hay,
    ) ||
    /impressora|multifuncional|toner|cartucho(?: de tinta)?|scanner/.test(
      hay,
    ) ||
    /mouse|teclado|headset gamer|controle (?:xbox|ps[45]|nintendo)|joystick|volante gamer/.test(
      hay,
    ) ||
    /c[aâ]mera|action cam|gopro|drone|ring light|microfone (?:usb|condensador)|placa de captura/.test(
      hay,
    ) ||
    /console|playstation|xbox|nintendo switch|steam deck|vr\b|oculus|meta quest/.test(
      hay,
    ) ||
    /echo\b|alexa|google nest|home pod/.test(hay) ||
    // Aparador de pelos / barbeador = beleza (não informática/eletrônicos de lista tech)
    /suporte celular|suporte veicular|power bank|carregador turbo|cabo type[- ]?c/.test(
      hay,
    ) ||
    /cabo flex[ií]vel|fio el[eé]tric|disjuntor|tomada inteligente|interruptor wifi|l[aâ]mpada smart|l[aâ]mpada led wifi/.test(
      hay,
    )
  );
}

export function looksLikeCellPhoneAccessory(title: string, extra = ""): boolean {
  const hay = `${title} ${extra}`.toLowerCase();
  if (isClearlyNotElectronics(title, extra)) return false;
  if (isHomeApplianceTitle(title, extra)) return false;
  return (
    /capinha|pel[ií]cula|suporte celular|carregador veicular|power bank|cabo type[- ]?c|fone bluetooth/.test(
      hay,
    ) || /iphone|samsung|xiaomi|motorola/.test(hay)
  );
}

export function looksLikeInformatica(title: string, extra = ""): boolean {
  const hay = `${title} ${extra}`.toLowerCase();
  if (isClearlyNotElectronics(title, extra)) return false;
  if (isHomeApplianceTitle(title, extra)) return false;
  // Toner/cartucho/interfone/aparador NÃO são informática de consumo geral
  if (
    /toner|cartucho|interfone|porteiro|aparador de pelos|barbeador|m[aá]quina(?: de)? barbear/.test(
      hay,
    )
  ) {
    return false;
  }
  return /notebook|ssd|mem[oó]ria ram|mouse|teclado|monitor|roteador|placa de v[ií]deo|processador|webcam|hub usb|dock station/.test(
    hay,
  );
}

/** Melhor categoria quando o título claramente NÃO é tech (Hub errou o hint). */
export function classifyNonElectronicsFallback(
  title: string,
  extra = "",
): string {
  const hay = `${title} ${extra}`.toLowerCase();
  if (isHomeApplianceTitle(title, extra)) return "eletrodomesticos";
  if (isToyOrKidsTitle(title, extra)) return "geral";
  if (
    /testosterona|testo essencial|magn[eé]sio|dimalato|creatina|whey|suplemento|arginina|\bzma\b|ghmuscle|gh[- ]?dro|c[aá]psulas?|comprimidos?|vitamina|col[aá]geno|bcaa/.test(
      hay,
    )
  ) {
    return "esportes";
  }
  if (
    /p[oó] compacto|maquiagem|batom|r[ií]mel|blush|base l[ií]quida|sace lady|shampoo|perfume|creme |hidratante|aparador de pelos|barbeador|m[aá]quina(?: de)? barbear|aparelho de barbear/.test(
      hay,
    )
  ) {
    return "beleza";
  }
  if (
    /interfone|porteiro eletronico|mini\s*compressor|compressor de ar|bomba el[eé]trica|inflador/.test(
      hay,
    )
  ) {
    return "casa";
  }
  if (
    /[oó]culos de sol|chinelo|camiseta|legging|t[eê]nis|vestido|cueca|meia /.test(
      hay,
    )
  ) {
    return "moda";
  }
  if (
    /v[aá]lvula|ralo\b|torneira|cuba|acabamento cromo|filme pvc|bobina|etiqueta|r[oó]tulo|garrafa|guarda[- ]?chuva|len[cç]ol|travesseiro|panela/.test(
      hay,
    )
  ) {
    return "casa";
  }
  return "geral";
}
