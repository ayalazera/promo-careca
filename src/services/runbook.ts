import { getDb, getSetting } from "../db/index.js";
import { getWaStatus } from "./whatsapp.js";
import { brazilHolidayName } from "./holidaysBr.js";
import { getMercadoLivreCreds } from "./credentialVault.js";

export type RunbookItem = {
  id: string;
  ok: boolean;
  title: string;
  detail: string;
  action: string;
};

export function buildRunbook(): {
  ok: boolean;
  holiday: string | null;
  items: RunbookItem[];
} {
  const wa = getWaStatus();
  const creds = getMercadoLivreCreds();
  const lastCookieFail = getDb()
    .prepare(
      `SELECT detail, created_at FROM antiban_events
       WHERE event_type LIKE '%cookie%' OR event_type LIKE '%csrf%'
          OR event_type LIKE '%session%'
          OR (detail LIKE '%csrf%' OR detail LIKE '%hub cookie%' OR detail LIKE '%401 Unauthorized%')
       ORDER BY id DESC LIMIT 1`,
    )
    .get() as { detail?: string; created_at?: string } | undefined;
  const tcgQueued = (
    getDb()
      .prepare(
        `SELECT COUNT(*) AS c FROM deals WHERE status = 'queued' AND category = 'tcg'`,
      )
      .get() as { c: number }
  ).c;
  const paused = getSetting("paused_until", "");
  const pausedOn = paused !== "" && Date.parse(paused) > Date.now();
  const holiday = brazilHolidayName();

  const hubMin = Number(getSetting("ml_hub_sync_interval_minutes", "360")) || 360;
  const hubLimit = Number(getSetting("ml_hub_sync_limit", "24")) || 24;
  const cadMin = Math.round(
    Number(getSetting("cadence_interval_min_sec", "240")) / 60,
  );
  const cadMax = Math.round(
    Number(getSetting("cadence_interval_max_sec", "480")) / 60,
  );
  const queuedReady = (
    getDb()
      .prepare(
        `SELECT COUNT(*) AS c FROM deals
         WHERE status IN ('queued','valid')
           AND coupon_status = 'valid'
           AND coupon IS NOT NULL AND trim(coupon) != ''
           AND affiliate_url LIKE '%meli.la%'`,
      )
      .get() as { c: number }
  ).c;

  const items: RunbookItem[] = [
    {
      id: "wa",
      ok: Boolean(wa.connected),
      title: wa.connected
        ? "WhatsApp conectado"
        : "WhatsApp offline — posts parados",
      detail: wa.connected
        ? "Sessão ativa. Cadência humana segue (1 grupo/onda)."
        : `Fila com ofertas, mas nada sai sem sessão. Isso não é falha de Sync.`,
      action: "Início → Gerar QR → WhatsApp → Aparelhos conectados.",
    },
    {
      id: "ready",
      ok: queuedReady >= 3,
      title: "Fila pronta (meli.la + cupom)",
      detail: `${queuedReady} ofertas postáveis agora (link afiliado + cupom válido).`,
      action:
        queuedReady >= 3
          ? "Publicação → Fila: colunas por destino, filtre “Só prontas”."
          : "Sync Hub / harvest com createLink · aguarde ritmo humano ML.",
    },
    {
      id: "cookie",
      ok: Boolean(creds.hubCookie && creds.hubCsrf) && !getSetting("hub_session_alert", ""),
      title: "Cookie / CSRF do Hub expirou",
      detail: getSetting("hub_session_alert", "")
        ? getSetting("hub_session_alert", "")
        : lastCookieFail?.detail
          ? `Último sinal: ${lastCookieFail.detail}`
          : creds.hubCookie
            ? "Cookie cadastrado."
            : "Sem Cookie no painel.",
      action:
        "Contas → F12 no Hub afiliados → copie Cookie e x-csrf-token → salvar.",
    },
    {
      id: "pace",
      ok: hubMin >= 360 && hubLimit <= 24 && cadMin >= 4 && cadMax <= 10,
      title: "Ritmo humano (anti-ban WA/ML)",
      detail: `Hub ${hubLimit}/sync a cada ${hubMin} min · posts ${cadMin}–${cadMax} min/grupo · 1 grupo por onda. Não espelha extensão Chrome 24/7.`,
      action:
        "Mantenha ≥360 min e ≤24 createLink. Flood tipo Achadinho Pro aumenta ban.",
    },
    {
      id: "tcg",
      ok: tcgQueued >= 8,
      title: "Lista / fila TCG vazia",
      detail: `${tcgQueued} ofertas TCG na fila (alvo 12–20).`,
      action:
        "Promoções → Sync Hub + lojas Pokémon/Copag/Asmodee. Meta: ≥12 itens.",
    },
    {
      id: "pause",
      ok: !pausedOn,
      title: "Anti-ban pausou os envios",
      detail: pausedOn ? `Pausado até ${paused}` : "Sem pausa ativa.",
      action: "Promoções → cadência → ou aguarde a pausa acabar. Não force rajada.",
    },
    {
      id: "holiday",
      ok: !holiday,
      title: "Feriado (só Enviar agora)",
      detail: holiday
        ? `Hoje é ${holiday}. Envios automáticos ficam desligados se a opção estiver marcada.`
        : "Dia útil (ou feriado desmarcado).",
      action: "Use Enviar agora se quiser postar mesmo assim.",
    },
  ];

  return { ok: items.every((i) => i.ok), holiday, items };
}
