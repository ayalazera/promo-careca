import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { getDb } from "./db/index.js";
import { api } from "./routes/api.js";
import { startScheduler } from "./jobs/scheduler.js";
import { startWhatsApp } from "./services/whatsapp.js";
import { resolveFleetInvite } from "./services/groupFleet.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "../public");

getDb();
// Seed de categorias (comunidades) na primeira subida
void import("./services/categories.js")
  .then((m) => {
    m.listCategories();
    m.recategorizeNonTcgDeals();
  })
  .catch(() => {
    /* ignore */
  });
void import("./services/groupBrand.js")
  .then((m) => m.backfillGroupBrands())
  .catch(() => {
    /* ignore */
  });
void import("./services/mlOfficialStores.js")
  .then((m) => m.seedOfficialStores())
  .catch(() => {
    /* ignore */
  });
void import("./services/priceHistory.js")
  .then((m) => m.seedSnapshotsFromLegacy())
  .catch(() => {
    /* ignore */
  });
void import("./services/antiBan.js").then(async (m) => {
  m.alignGroupIntervalsToCadence();
  const { getSetting, setSetting } = await import("./db/index.js");
  const n = Number(getSetting("sends_in_block", "0")) || 0;
  if (n >= 5) setSetting("sends_in_block", "0");
  setSetting("block_pause_until", "");
}).catch(() => {
  /* ignore */
});
void import("./services/competitorTargets.js")
  .then((m) => m.applyCadenceInterleaveBump())
  .catch(() => {
    /* ignore */
  });
void import("./services/mlLists.js")
  .then((m) => {
    const map = m.getListMap();
    const ids = new Set(
      Object.values(map)
        .map((x) => x?.id)
        .filter(Boolean),
    );
    // Se todas as categorias apontam para a mesma lista, remapeia pelos nomes
    if (ids.size <= 1) m.applySuggestedListMap();
  })
  .catch(() => {
    /* ignore */
  });
void import("./services/couponTester.js")
  .then((m) => m.repairAbsurdDealPrices())
  .catch(() => {
    /* ignore */
  });

const app = express();
// Logo em base64 no JSON estoura fácil — 50mb de folga; preferir /logo-bin
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use((req, res, next) => {
  if (
    req.path === "/" ||
    req.path.endsWith(".html") ||
    req.path.endsWith(".css") ||
    req.path.endsWith(".js")
  ) {
    res.setHeader("Cache-Control", "no-store, max-age=0");
  }
  next();
});
app.use(express.static(publicDir));
app.use("/api", api);

app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  const e = err as { type?: string; name?: string; status?: number; statusCode?: number };
  if (
    e?.type === "entity.too.large" ||
    e?.name === "PayloadTooLargeError" ||
    e?.status === 413 ||
    e?.statusCode === 413
  ) {
    res.status(413).json({
      error:
        "Arquivo grande demais. O painel agora envia o logo comprimido — atualize a página (Ctrl+Shift+R) e tente de novo.",
    });
    return;
  }
  next(err);
});

/** Link estável da série: se o grupo atual encheu, manda para o próximo automaticamente */
app.get("/r/:slug", async (req, res) => {
  try {
    const invite = await resolveFleetInvite(String(req.params.slug));
    res.redirect(302, invite);
  } catch (err) {
    res.status(404).send(
      err instanceof Error ? err.message : "Frota não disponível",
    );
  }
});

app.get("/{*path}", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

// Dual-stack (:: + IPv4) para localhost funcionar em IPv4 e IPv6 (::1).
// HOST=0.0.0.0 força só IPv4; HOST=127.0.0.1 restringe ao loopback.
const listenHost = process.env.HOST || "::";

const server = app.listen(
  {
    port: config.port,
    host: listenHost,
    ipv6Only: false,
  },
  () => {
    console.log("");
    console.log("========================================");
    console.log(`  Promo Autônomo no ar`);
    console.log(`  Painel:  http://127.0.0.1:${config.port}`);
    console.log(`  Painel:  http://localhost:${config.port}`);
    console.log(`  Health:  http://127.0.0.1:${config.port}/api/health`);
    console.log("========================================");
    console.log(
      "WhatsApp não oficial + anti-ban. Viola os termos do WhatsApp — use por sua conta e risco.",
    );
    console.log("");
    startScheduler();
    void startWhatsApp().catch((err) => {
      console.error("Falha ao iniciar WhatsApp:", err);
    });
  },
);

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error("");
    console.error(`Porta ${config.port} já está em uso.`);
    console.error("Feche o processo anterior ou rode:");
    console.error(`  npx kill-port ${config.port}`);
    console.error(`  # ou: fuser -k ${config.port}/tcp`);
    console.error("");
    process.exit(1);
  }
  console.error("Erro ao subir o servidor:", err);
  process.exit(1);
});
