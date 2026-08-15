import { getDb } from "./index.js";
import { config } from "../config.js";

export function seedDemoGroups(): void {
  const db = getDb();
  const count = db.prepare("SELECT COUNT(*) AS c FROM wa_groups").get() as {
    c: number;
  };
  if (count.c > 0) return;

  const insert = db.prepare(`
    INSERT INTO wa_groups (name, jid, categories, active, interval_minutes)
    VALUES (?, ?, ?, 0, ?)
  `);

  // Placeholders inativos — cadastre grupos reais pelo link na aba Grupos
  insert.run(
    "Promo Eletrônicos (exemplo)",
    "120363000000000000@g.us",
    "eletronicos",
    config.defaultIntervalMinutes,
  );
  insert.run(
    "Promo Games",
    "120363000000000001@g.us",
    "games,geral",
    config.defaultIntervalMinutes,
  );
  insert.run(
    "Promo TCG",
    "120363000000000002@g.us",
    "tcg",
    config.defaultIntervalMinutes,
  );

  console.log(
    "Grupos de exemplo criados (inativos). Após conectar o WhatsApp, importe JIDs reais no painel.",
  );
}

seedDemoGroups();
