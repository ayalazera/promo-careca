/**
 * Progresso do Sync Hub (em memória) — o painel faz poll enquanto o POST roda.
 */
export type SyncStepStatus = "pending" | "running" | "done" | "error" | "skipped";

export type SyncStep = {
  id: string;
  label: string;
  status: SyncStepStatus;
  detail?: string;
};

export type SyncProgress = {
  running: boolean;
  percent: number;
  phase: string;
  steps: SyncStep[];
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  log: string[];
};

const DEFAULT_STEPS: Array<{ id: string; label: string }> = [
  { id: "hub", label: "Ler ganhos extras do Hub" },
  { id: "stores", label: "Buscar lojas oficiais (TCG / Pokémon…)" },
  { id: "filter", label: "Filtrar por comissão e categoria" },
  { id: "links", label: "Gerar links afiliados (createLink)" },
  { id: "save", label: "Gravar ofertas na fila" },
  { id: "lists", label: "Enviar às listas ML (se ligado)" },
  { id: "done", label: "Concluir" },
];

let progress: SyncProgress = idleProgress();

function idleProgress(): SyncProgress {
  return {
    running: false,
    percent: 0,
    phase: "Pronto",
    steps: DEFAULT_STEPS.map((s) => ({ ...s, status: "pending" as const })),
    startedAt: null,
    finishedAt: null,
    error: null,
    log: [],
  };
}

export function getSyncProgress(): SyncProgress {
  return {
    ...progress,
    steps: progress.steps.map((s) => ({ ...s })),
    log: [...progress.log],
  };
}

export function beginSyncProgress(label = "Sync Hub"): void {
  progress = {
    running: true,
    percent: 2,
    phase: label,
    steps: DEFAULT_STEPS.map((s) => ({ ...s, status: "pending" })),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    log: [`Início · ${label}`],
  };
}

export function setSyncStep(
  id: string,
  status: SyncStepStatus,
  detail?: string,
): void {
  const steps = progress.steps.map((s) =>
    s.id === id ? { ...s, status, detail: detail ?? s.detail } : s,
  );
  const done = steps.filter((s) => s.status === "done" || s.status === "skipped").length;
  const runningIdx = steps.findIndex((s) => s.status === "running");
  const pct = Math.min(
    96,
    Math.round((done / Math.max(steps.length, 1)) * 100) +
      (runningIdx >= 0 ? 6 : 0),
  );
  const current = steps.find((s) => s.status === "running");
  progress = {
    ...progress,
    steps,
    percent: pct,
    phase: current?.label || progress.phase,
  };
  if (detail) {
    progress.log = [...progress.log.slice(-40), detail];
  }
}

export function appendSyncLog(line: string): void {
  progress.log = [...progress.log.slice(-40), line];
  progress.phase = line;
}

export function finishSyncProgress(opts?: {
  error?: string;
  ok?: boolean;
}): void {
  const err = opts?.error || null;
  progress = {
    ...progress,
    running: false,
    percent: err ? progress.percent : 100,
    phase: err ? "Erro" : "Concluído",
    finishedAt: new Date().toISOString(),
    error: err,
    steps: progress.steps.map((s) =>
      s.status === "running" || s.status === "pending"
        ? {
            ...s,
            status: err ? (s.status === "running" ? "error" : "skipped") : "done",
          }
        : s,
    ),
    log: [
      ...progress.log,
      err ? `Erro: ${err}` : "Sync concluído",
    ].slice(-50),
  };
}
