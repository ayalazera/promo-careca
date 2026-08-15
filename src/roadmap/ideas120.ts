/**
 * 120 melhorias da análise dos 3 grupos concorrentes (Will / Clube / Rei TCG)
 * + gaps Careca VIP. Status atualizado conforme implementação.
 */
export type IdeaStatus = "done" | "partial" | "missing";

export type RoadmapIdea = {
  n: number;
  group: string;
  title: string;
  status: IdeaStatus;
};

export const IDEA_GROUPS_120 = [
  "Volume & cadência",
  "Seleção / procura",
  "Cupons & afiliação",
  "Copy / mensagem",
  "TCG",
  "Eletrônicos",
  "Ops / anti-ban / painel",
  "Diferenciais",
] as const;

export const IDEAS_120: RoadmapIdea[] = [
  // Volume & cadência (1–15)
  { n: 1, group: "Volume & cadência", title: "Meta 70–90 posts/dia em Achadinhos.", status: "done" },
  { n: 2, group: "Volume & cadência", title: "TCG meta alta (≥40/dia, acima dos 12–20).", status: "done" },
  { n: 3, group: "Volume & cadência", title: "Eletrônicos meta alta (≥55/dia, acima dos 25–40).", status: "done" },
  { n: 4, group: "Volume & cadência", title: "Rajada no pico 12h–14h e 18h–21h.", status: "done" },
  { n: 5, group: "Volume & cadência", title: "Intervalo 3–5 min no pico, 7–10 off-peak.", status: "done" },
  { n: 6, group: "Volume & cadência", title: "Intercalar grupos: 1 post/min, nunca no mesmo minuto.", status: "done" },
  { n: 7, group: "Volume & cadência", title: "Buffer de fila ≥3× o limite diário.", status: "done" },
  { n: 8, group: "Volume & cadência", title: "Reposição automática se fila <15.", status: "done" },
  { n: 9, group: "Volume & cadência", title: "Domingo ~50% do volume, não zero.", status: "done" },
  { n: 10, group: "Volume & cadência", title: "Contador “posts restantes hoje” no painel.", status: "done" },
  { n: 11, group: "Volume & cadência", title: "Pausar só o grupo saturado, não todos.", status: "done" },
  { n: 12, group: "Volume & cadência", title: "Burst pós-anúncio de cupom ampliado.", status: "done" },
  { n: 13, group: "Volume & cadência", title: "Não repetir MLB em 7 dias; permitir variante cor/kit.", status: "done" },
  { n: 14, group: "Volume & cadência", title: "Fila premium vs filler.", status: "done" },
  { n: 15, group: "Volume & cadência", title: "Score de urgência por estoque baixo.", status: "done" },

  // Seleção (16–35)
  { n: 16, group: "Seleção / procura", title: "Priorizar 100+ vendidos.", status: "done" },
  { n: 17, group: "Seleção / procura", title: "Priorizar 35%+ off.", status: "done" },
  { n: 18, group: "Seleção / procura", title: "Priorizar comissão ≥15–20%.", status: "done" },
  { n: 19, group: "Seleção / procura", title: "Score composto procura×desconto×comissão.", status: "done" },
  { n: 20, group: "Seleção / procura", title: "Banir nicho químico/tempero/cápsula.", status: "done" },
  { n: 21, group: "Seleção / procura", title: "Preferir kits (10 meias, 3 camisetas).", status: "done" },
  { n: 22, group: "Seleção / procura", title: "Preferir marcas conhecidas.", status: "done" },
  { n: 23, group: "Seleção / procura", title: "Evitar genérico sem marca no top.", status: "done" },
  { n: 24, group: "Seleção / procura", title: "Boost se preço ≤ menor 30d.", status: "done" },
  { n: 25, group: "Seleção / procura", title: "Penalizar preço pior que histórico.", status: "done" },
  { n: 26, group: "Seleção / procura", title: "Diversificar cores/tamanhos só 1x.", status: "done" },
  { n: 27, group: "Seleção / procura", title: "Alternar moda/casa/tech em Achadinhos.", status: "done" },
  { n: 28, group: "Seleção / procura", title: "Cap de moda por hora.", status: "done" },
  { n: 29, group: "Seleção / procura", title: "Eletrônicos: fones/smartwatch/cabo/SSD primeiro.", status: "done" },
  { n: 30, group: "Seleção / procura", title: "TCG: blister/box/ETB antes de sleeve.", status: "done" },
  { n: 31, group: "Seleção / procura", title: "Rejeitar playmat/tapete em TCG.", status: "done" },
  { n: 32, group: "Seleção / procura", title: "Detectar hype Pokémon (nova coleção).", status: "done" },
  { n: 33, group: "Seleção / procura", title: "Cross-sell: mesmo cupom, produto melhor.", status: "done" },
  { n: 34, group: "Seleção / procura", title: "Descartar frete caro vs preço.", status: "done" },
  { n: 35, group: "Seleção / procura", title: "Preferir full/oficial quando comissão ok.", status: "done" },

  // Cupons (36–50)
  { n: 36, group: "Cupons & afiliação", title: "Sempre meli.la.", status: "done" },
  { n: 37, group: "Cupons & afiliação", title: "Sempre cupom digitável testado.", status: "done" },
  { n: 38, group: "Cupons & afiliação", title: "Âncoras por nicho.", status: "done" },
  { n: 39, group: "Cupons & afiliação", title: "Rotacionar SEMPREMODA/MODANOMELI/OFFMELI.", status: "done" },
  { n: 40, group: "Cupons & afiliação", title: "TECHEMCASA/ECONOMIAML para eletrônicos.", status: "done" },
  { n: 41, group: "Cupons & afiliação", title: "BRINQUEDOS obrigatório no harvest TCG.", status: "done" },
  { n: 42, group: "Cupons & afiliação", title: "Não anunciar lista.mercadolivre.", status: "done" },
  { n: 43, group: "Cupons & afiliação", title: "Mint budget maior após cupom novo.", status: "done" },
  { n: 44, group: "Cupons & afiliação", title: "Re-testar cupom a cada 45 min.", status: "done" },
  { n: 45, group: "Cupons & afiliação", title: "Alertar cupom esgotado.", status: "done" },
  { n: 46, group: "Cupons & afiliação", title: "Follow-ups só com link afiliado.", status: "done" },
  { n: 47, group: "Cupons & afiliação", title: "Evitar “siga a loja”.", status: "done" },
  { n: 48, group: "Cupons & afiliação", title: "Mostrar qty mínima do cupom.", status: "done" },
  { n: 49, group: "Cupons & afiliação", title: "Carrinho N unidades quando precisar.", status: "done" },
  { n: 50, group: "Cupons & afiliação", title: "Priorizar cupom % alto no ranking.", status: "done" },

  // Copy (51–75)
  { n: 51, group: "Copy / mensagem", title: "Menor preço 30d na 1ª linha.", status: "done" },
  { n: 52, group: "Copy / mensagem", title: "Humor amarrado ao produto.", status: "done" },
  { n: 53, group: "Copy / mensagem", title: "Hooks tipo Clube (produto + humor).", status: "done" },
  { n: 54, group: "Copy / mensagem", title: "TCG: preço unitário “(N CADA)”.", status: "done" },
  { n: 55, group: "Copy / mensagem", title: "Sem “no PIX” inventado.", status: "done" },
  { n: 56, group: "Copy / mensagem", title: "Sem parcelas inventadas.", status: "done" },
  { n: 57, group: "Copy / mensagem", title: "Título ≤90 chars.", status: "done" },
  { n: 58, group: "Copy / mensagem", title: "Cupom em bloco destacado.", status: "done" },
  { n: 59, group: "Copy / mensagem", title: "Uma linha em branco entre blocos.", status: "done" },
  { n: 60, group: "Copy / mensagem", title: "CTA curto no TCG.", status: "done" },
  { n: 61, group: "Copy / mensagem", title: "Emoji 1–2 no máx.", status: "done" },
  { n: 62, group: "Copy / mensagem", title: "Variante A/B de headline.", status: "done" },
  { n: 63, group: "Copy / mensagem", title: "Flash template no pico.", status: "done" },
  { n: 64, group: "Copy / mensagem", title: "Aviso estoque baixo.", status: "done" },
  { n: 65, group: "Copy / mensagem", title: "Loja oficial quando for.", status: "done" },
  { n: 66, group: "Copy / mensagem", title: "Frete grátis quando for.", status: "done" },
  { n: 67, group: "Copy / mensagem", title: "Presale hint TCG.", status: "done" },
  { n: 68, group: "Copy / mensagem", title: "Hashtag opcional off por padrão.", status: "done" },
  { n: 69, group: "Copy / mensagem", title: "Rodapé do grupo.", status: "done" },
  { n: 70, group: "Copy / mensagem", title: "Não repetir mesma headline 3x seguidas.", status: "done" },
  { n: 71, group: "Copy / mensagem", title: "“Por R$X 👑” estilo Rei.", status: "done" },
  { n: 72, group: "Copy / mensagem", title: "De riscado sempre que old_price.", status: "done" },
  { n: 73, group: "Copy / mensagem", title: "Destacar % off se ≥40%.", status: "done" },
  { n: 74, group: "Copy / mensagem", title: "Zero texto de segurança/sistema.", status: "done" },
  { n: 75, group: "Copy / mensagem", title: "Preview no painel antes de postar.", status: "done" },

  // TCG (76–88)
  { n: 76, group: "TCG", title: "Deep catalog Pokémon/Magic/YGO maior.", status: "done" },
  { n: 77, group: "TCG", title: "Só collectible.", status: "done" },
  { n: 78, group: "TCG", title: "Idioma PT preferido.", status: "done" },
  { n: 79, group: "TCG", title: "Box/ETB/blister no topo.", status: "done" },
  { n: 80, group: "TCG", title: "Preço por booster quando pack.", status: "done" },
  { n: 81, group: "TCG", title: "Loja Copag/Pokémon oficial.", status: "done" },
  { n: 82, group: "TCG", title: "Harvest BRINQUEDOS+LIVROS quando TCG vazio.", status: "done" },
  { n: 83, group: "TCG", title: "Não misturar brinquedo genérico na fila TCG.", status: "done" },
  { n: 84, group: "TCG", title: "Alertar nova coleção ML.", status: "done" },
  { n: 85, group: "TCG", title: "Dedup por set name.", status: "done" },
  { n: 86, group: "TCG", title: "Priorizar lacrado.", status: "done" },
  { n: 87, group: "TCG", title: "Evitar singles avulsos caros.", status: "done" },
  { n: 88, group: "TCG", title: "Meta mínima 8 na fila TCG (runbook).", status: "done" },

  // Eletrônicos (89–95)
  { n: 89, group: "Eletrônicos", title: "Quota Sync dedicada.", status: "done" },
  { n: 90, group: "Eletrônicos", title: "ECONOMIAML/TECHEMCASA primeiro.", status: "done" },
  { n: 91, group: "Eletrônicos", title: "Smartwatch/fone/SSD no top.", status: "done" },
  { n: 92, group: "Eletrônicos", title: "Teto de preço por subcat.", status: "done" },
  { n: 93, group: "Eletrônicos", title: "Evitar acessório genérico sem marca.", status: "done" },
  { n: 94, group: "Eletrônicos", title: "Comparar vs menor 30d.", status: "done" },
  { n: 95, group: "Eletrônicos", title: "Alternar acessório vs gadget.", status: "done" },

  // Ops (96–110)
  { n: 96, group: "Ops / anti-ban / painel", title: "Barra Sync com %.", status: "done" },
  { n: 97, group: "Ops / anti-ban / painel", title: "Knobs de volume na UI.", status: "done" },
  { n: 98, group: "Ops / anti-ban / painel", title: "Log harvest no resultado do Sync.", status: "done" },
  { n: 99, group: "Ops / anti-ban / painel", title: "Health sempre vivo.", status: "done" },
  { n: 100, group: "Ops / anti-ban / painel", title: "Não matar fila no boot (cap ≤8 removido).", status: "done" },
  { n: 101, group: "Ops / anti-ban / painel", title: "Cookie Hub healthcheck.", status: "done" },
  { n: 102, group: "Ops / anti-ban / painel", title: "Retry createLink com jitter.", status: "done" },
  { n: 103, group: "Ops / anti-ban / painel", title: "Sanitize com motivos no log.", status: "done" },
  { n: 104, group: "Ops / anti-ban / painel", title: "Pipeline por grupo na home.", status: "done" },
  { n: 105, group: "Ops / anti-ban / painel", title: "Sparkline de preço.", status: "done" },
  { n: 106, group: "Ops / anti-ban / painel", title: "Export CSV da fila.", status: "done" },
  { n: 107, group: "Ops / anti-ban / painel", title: "Modo manutenção.", status: "done" },
  { n: 108, group: "Ops / anti-ban / painel", title: "Silêncio de almoço.", status: "done" },
  { n: 109, group: "Ops / anti-ban / painel", title: "Pausa 403/429.", status: "done" },
  { n: 110, group: "Ops / anti-ban / painel", title: "Backup DB automático.", status: "done" },

  // Diferenciais (111–120)
  { n: 111, group: "Diferenciais", title: "Score único procura×lucro×escassez.", status: "done" },
  { n: 112, group: "Diferenciais", title: "Interleave multi-grupo (1 min entre grupos).", status: "done" },
  { n: 113, group: "Diferenciais", title: "Headline automática de menor preço histórico.", status: "done" },
  { n: 114, group: "Diferenciais", title: "Copy humor por categoria treinada nos 3 chats.", status: "done" },
  { n: 115, group: "Diferenciais", title: "Harvest âncora por déficit de fila.", status: "done" },
  { n: 116, group: "Diferenciais", title: "Hold inteligente sem apagar Hub.", status: "done" },
  { n: 117, group: "Diferenciais", title: "Quotas anti-viés moda.", status: "done" },
  { n: 118, group: "Diferenciais", title: "Buffer 3× cadência.", status: "done" },
  { n: 119, group: "Diferenciais", title: "A/B headline por id.", status: "done" },
  { n: 120, group: "Diferenciais", title: "Painel de volume vs concorrente (meta diária).", status: "done" },
];

export function roadmap120Summary() {
  const ideas = IDEAS_120;
  const count = (s: IdeaStatus) => ideas.filter((i) => i.status === s).length;
  return {
    total: ideas.length,
    done: count("done"),
    partial: count("partial"),
    missing: count("missing"),
    groups: IDEA_GROUPS_120,
    ideas,
    targets: {
      achadinhos: { min: 70, max: 90, default: 90 },
      tcg: { min: 40, max: 60, default: 45 },
      eletronicos: { min: 50, max: 70, default: 55 },
      interGroupDelaySec: 60,
      maxGroupsPerWave: 1,
      note: "1 grupo por minuto — nunca postar em vários grupos no mesmo minuto (anti-ban WA).",
    },
  };
}
