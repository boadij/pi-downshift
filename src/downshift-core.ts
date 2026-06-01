export type ModelTarget = {
  provider: string;
  model: string;
  thinkingLevel: string;
};

export type Threshold = {
  tokens?: number;
  percent?: number;
};

export type DownshiftConfig = {
  enabled: boolean;
  threshold: Threshold;
  economy: ModelTarget;
  premiumSource: "current" | "explicit";
  premium?: ModelTarget;
  startOnPremium: boolean;
  upshiftAfterCompaction: boolean;
  handoffBeforeDownshift: boolean;
};

export type Position = "premium" | "economy";
export type HandoffState = "idle" | "requested" | "active" | "done";

export type DownshiftState = {
  sessionId?: string;
  sessionEnabled: boolean;
  paused: boolean;
  position: Position;
  handoff: HandoffState;
  capturedPremium?: ModelTarget;
  lastError?: string;
};

export type ContextUsageLike = {
  tokens: number | null;
  percent: number | null;
};

type StateEntry = Partial<DownshiftState> & { version?: number };

export type Runtime = { state: DownshiftState };

export type HandoffDelivery = "immediate" | "steer";

export type CoreDeps = {
  readConfig: () => Promise<DownshiftConfig | undefined>;
  saveState: (state: DownshiftState) => void;
  sendUserMessage: (
    prompt: string,
    options?: { deliverAs: Exclude<HandoffDelivery, "immediate"> },
  ) => void | Promise<void>;
  switchToTarget: (
    target: ModelTarget,
    position: Position,
    reason: string,
  ) => Promise<boolean>;
  updateStatus: (config?: DownshiftConfig) => void;
  notify: (message: string, level?: string) => void;
};

type UsageContext = { getContextUsage: () => ContextUsageLike | undefined };

export const HANDOFF_MARKER = "<!-- downshift:handoff:v1 -->";

export function createInitialState(): DownshiftState {
  return {
    sessionEnabled: true,
    paused: false,
    position: "premium",
    handoff: "idle",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTarget(value: unknown): ModelTarget | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.provider !== "string" || !value.provider) return undefined;
  if (typeof value.model !== "string" || !value.model) return undefined;
  if (typeof value.thinkingLevel !== "string" || !value.thinkingLevel)
    return undefined;
  return {
    provider: value.provider,
    model: value.model,
    thinkingLevel: value.thinkingLevel,
  };
}

export function restoreStateFromEntries(
  entries: Array<{ type?: string; customType?: string; data?: unknown }>,
  sessionId: string,
): DownshiftState | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry.type !== "custom" ||
      entry.customType !== "downshift-state" ||
      !isRecord(entry.data)
    )
      continue;
    const data = entry.data as StateEntry;
    const interrupted =
      data.handoff === "requested" || data.handoff === "active";
    return {
      sessionId:
        typeof data.sessionId === "string" ? data.sessionId : sessionId,
      sessionEnabled: data.sessionEnabled !== false,
      paused: interrupted || data.paused === true,
      position: data.position === "economy" ? "economy" : "premium",
      handoff: data.handoff === "done" ? "done" : "idle",
      capturedPremium: parseTarget(data.capturedPremium),
      lastError: interrupted
        ? "handoff interrupted by reload"
        : typeof data.lastError === "string"
          ? data.lastError
          : undefined,
    };
  }
  return undefined;
}

export function thresholdReached(
  usage: ContextUsageLike | undefined,
  threshold: Threshold,
): boolean {
  if (!usage) return false;
  if (
    threshold.tokens &&
    usage.tokens !== null &&
    usage.tokens >= threshold.tokens
  )
    return true;
  if (
    threshold.percent &&
    usage.percent !== null &&
    usage.percent >= threshold.percent
  )
    return true;
  return false;
}

export function belowThreshold(
  usage: ContextUsageLike | undefined,
  threshold: Threshold,
): boolean {
  if (!usage) return false;
  if (
    threshold.tokens &&
    (usage.tokens === null || usage.tokens >= threshold.tokens)
  )
    return false;
  if (
    threshold.percent &&
    (usage.percent === null || usage.percent >= threshold.percent)
  )
    return false;
  return true;
}

function formatCompactNumber(value: number): string {
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000) return `${Math.round(value / 1_000_000)}m`;
  if (absolute >= 1_000) return `${Math.round(value / 1_000)}k`;
  return `${Math.round(value)}`;
}

export function statusText(
  config: DownshiftConfig | undefined,
  state: DownshiftState,
  usage: ContextUsageLike | undefined,
): string {
  if (!config?.enabled || !state.sessionEnabled) return "⇣ off";
  if (state.paused) return "⇣ paused";
  if (state.handoff === "requested") return "⇣ handoff";
  if (state.handoff === "active") return "⇣ writing handoff";
  if (state.position === "economy") return "⇣ eco";

  const parts: string[] = [];
  if (
    config.threshold.tokens !== undefined &&
    usage?.tokens !== null &&
    usage?.tokens !== undefined
  ) {
    parts.push(
      formatCompactNumber(Math.max(0, config.threshold.tokens - usage.tokens)),
    );
  }
  if (
    config.threshold.percent !== undefined &&
    usage?.percent !== null &&
    usage?.percent !== undefined
  ) {
    parts.push(
      `${Math.round(Math.max(0, config.threshold.percent - usage.percent))}%`,
    );
  }

  return parts.length === 0 ? "⇣ ? → eco" : `⇣ ${parts.join(" / ")} → eco`;
}

function setState(
  deps: CoreDeps,
  runtime: Runtime,
  patch: Partial<DownshiftState>,
): void {
  runtime.state = { ...runtime.state, ...patch };
  deps.saveState(runtime.state);
}

function buildHandoffPrompt(): string {
  return `${HANDOFF_MARKER}\n\nYou are preparing a handoff note before Downshift switches this session from the premium model to the economy model.\n\nWrite a compact, practical handoff note for the next model. Do not continue implementation. Do not ask questions. Do not call tools. Use only the current conversation context.\n\nInclude:\n\n1. Goal\n2. Current state\n3. Relevant files, symbols, commands, and decisions\n4. Remaining steps\n5. Constraints and pitfalls\n6. Tests or checks to run\n\nKeep it concise, concrete, and execution-oriented.`;
}

export async function requestHandoff(
  deps: CoreDeps,
  runtime: Runtime,
  delivery: HandoffDelivery,
  config?: DownshiftConfig,
): Promise<DownshiftState> {
  setState(deps, runtime, { handoff: "requested", lastError: undefined });
  deps.updateStatus(config);
  deps.notify("downshift: preparing handoff before economy switch", "info");
  try {
    const prompt = buildHandoffPrompt();
    if (delivery === "immediate") {
      await deps.sendUserMessage(prompt);
    } else {
      await deps.sendUserMessage(prompt, { deliverAs: delivery });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setState(deps, runtime, {
      handoff: "idle",
      paused: true,
      lastError: message,
    });
    deps.notify(`downshift paused: ${message}`, "error");
  }
  return runtime.state;
}

export async function forceDownshiftNow(
  deps: CoreDeps,
  runtime: Runtime,
  delivery: HandoffDelivery,
): Promise<DownshiftState> {
  const config = await deps.readConfig();
  deps.updateStatus(config);
  if (!config) {
    deps.notify("downshift: config missing", "warning");
    return runtime.state;
  }
  if (!config.enabled) {
    deps.notify("downshift: disabled in config", "warning");
    return runtime.state;
  }
  if (!runtime.state.sessionEnabled || runtime.state.paused) {
    setState(deps, runtime, {
      sessionEnabled: true,
      paused: false,
      lastError: undefined,
    });
  }
  if (runtime.state.position === "economy") {
    deps.notify("downshift: already on economy", "info");
    return runtime.state;
  }
  if (
    runtime.state.handoff === "requested" ||
    runtime.state.handoff === "active"
  ) {
    deps.notify("downshift: handoff already pending", "info");
    return runtime.state;
  }
  return requestHandoff(deps, runtime, delivery, config);
}

export async function completeHandoffAndSwitch(
  deps: CoreDeps,
  runtime: Runtime,
): Promise<DownshiftState> {
  const config = await deps.readConfig();
  if (
    !config?.enabled ||
    !runtime.state.sessionEnabled ||
    runtime.state.paused ||
    runtime.state.position === "economy"
  ) {
    if (!runtime.state.paused && runtime.state.position !== "economy") {
      setState(deps, runtime, { handoff: "idle" });
    }
    deps.updateStatus(config);
    return runtime.state;
  }
  setState(deps, runtime, { handoff: "done" });
  const switched = await deps.switchToTarget(
    config.economy,
    "economy",
    "handoff complete",
  );
  if (switched)
    setState(deps, runtime, { position: "economy", lastError: undefined });
  deps.updateStatus(config);
  return runtime.state;
}

export async function maybeDownshift(
  deps: CoreDeps,
  runtime: Runtime,
  ctx: UsageContext,
  delivery: HandoffDelivery,
): Promise<DownshiftState> {
  const config = await deps.readConfig();
  deps.updateStatus(config);
  if (
    !config?.enabled ||
    !runtime.state.sessionEnabled ||
    runtime.state.paused ||
    runtime.state.position === "economy"
  )
    return runtime.state;
  if (
    runtime.state.handoff === "requested" ||
    runtime.state.handoff === "active"
  )
    return runtime.state;
  if (!thresholdReached(ctx.getContextUsage(), config.threshold))
    return runtime.state;
  if (config.handoffBeforeDownshift && runtime.state.handoff === "idle") {
    return requestHandoff(deps, runtime, delivery, config);
  }
  const switched = await deps.switchToTarget(
    config.economy,
    "economy",
    "switched",
  );
  if (switched)
    setState(deps, runtime, {
      position: "economy",
      handoff: "done",
      lastError: undefined,
    });
  deps.updateStatus(config);
  return runtime.state;
}

export async function maybeUpshift(
  deps: CoreDeps,
  runtime: Runtime,
  ctx: UsageContext,
): Promise<DownshiftState> {
  const config = await deps.readConfig();
  deps.updateStatus(config);
  if (
    !config?.enabled ||
    !config.upshiftAfterCompaction ||
    !runtime.state.sessionEnabled ||
    runtime.state.paused ||
    runtime.state.position !== "economy" ||
    !belowThreshold(ctx.getContextUsage(), config.threshold)
  )
    return runtime.state;
  const premium =
    config.premiumSource === "explicit"
      ? config.premium
      : runtime.state.capturedPremium;
  if (!premium) {
    setState(deps, runtime, {
      paused: true,
      lastError: "premium target is unset",
    });
    deps.notify("downshift paused: premium target is unset", "error");
    return runtime.state;
  }
  const switched = await deps.switchToTarget(premium, "premium", "upshifted");
  if (switched)
    setState(deps, runtime, {
      position: "premium",
      handoff: "idle",
      lastError: undefined,
    });
  deps.updateStatus(config);
  return runtime.state;
}

export async function handleBeforeAgentStart(
  deps: CoreDeps,
  runtime: Runtime,
  event: { prompt?: unknown },
  _ctx: UsageContext,
): Promise<DownshiftState> {
  if (
    typeof event.prompt === "string" &&
    event.prompt.includes(HANDOFF_MARKER) &&
    runtime.state.handoff === "requested"
  ) {
    setState(deps, runtime, { handoff: "active" });
    deps.updateStatus();
  }
  return runtime.state;
}

export async function handleAgentEnd(
  deps: CoreDeps,
  runtime: Runtime,
  _ctx: UsageContext,
): Promise<DownshiftState> {
  if (runtime.state.handoff === "active") {
    return completeHandoffAndSwitch(deps, runtime);
  }
  return runtime.state;
}

export async function handleManualModelSelect(
  deps: CoreDeps,
  runtime: Runtime,
  event: { source?: string },
  _ctx: UsageContext,
): Promise<DownshiftState> {
  if (event.source === "restore") return runtime.state;
  const config = await deps.readConfig();
  if (!config?.enabled || !runtime.state.sessionEnabled) {
    deps.updateStatus(config);
    return runtime.state;
  }
  setState(deps, runtime, {
    paused: true,
    position: "premium",
    handoff: "idle",
    lastError: "manual model change",
  });
  deps.updateStatus(config);
  return runtime.state;
}
