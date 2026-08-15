import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { getSetting, logAntiBan, setSetting } from "../db/index.js";

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, ent.name);
    const to = path.join(dest, ent.name);
    if (ent.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

export function backupSqliteIfDue(): { ran: boolean; path?: string } {
  const today = new Date().toISOString().slice(0, 10);
  if (getSetting("sqlite_backup_day", "") === today) {
    return { ran: false };
  }
  const src = config.databasePath;
  if (!fs.existsSync(src)) return { ran: false };
  const dir = path.join(path.dirname(src), "backups");
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `promo-${today}.db`);
  fs.copyFileSync(src, dest);
  try {
    if (fs.existsSync(config.authDir)) {
      copyDir(config.authDir, path.join(dir, `whatsapp-auth-${today}`));
      logAntiBan("baileys_backup", `whatsapp-auth-${today}`);
    }
  } catch (err) {
    logAntiBan(
      "baileys_backup_fail",
      err instanceof Error ? err.message : String(err),
    );
  }
  setSetting("sqlite_backup_day", today);
  logAntiBan("sqlite_backup", dest);
  return { ran: true, path: dest };
}
