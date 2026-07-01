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
export type SessionMode = "inherit" | "on" | "off";

export type DownshiftState = {
  sessionId?: string;
  sessionMode: SessionMode;
  paused: boolean;
  position: Position;
  handoff: HandoffState;
  continueAfterHandoff: boolean;
  capturedPremium?: ModelTarget;
  lastError?: string;
};

export type ContextUsageLike = {
  tokens: number | null;
  percent: number | null;
};

type StateEntry = Partial<DownshiftState> & {
  version?: number;
  sessionEnabled?: boolean;
  sessionOverride?: boolean;
};

type PersistedStateEntry = {
  type?: string;
  customType?: string;
  data?: unknown;
};

export type Runtime = { state: DownshiftState };

export type HandoffDelivery = "immediate" | "steer";
export type UserMessageDelivery = "steer" | "followUp";

export type CoreDeps = {
  readConfig: () => Promise<DownshiftConfig | undefined>;
  saveState: (state: DownshiftState) => void;
  sendUserMessage: (
    prompt: string,
    options?: { deliverAs: UserMessageDelivery },
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

export type CompactionEventLike = { compactionEntry?: unknown };

export const HANDOFF_MARKER = "<!-- downshift:handoff:v1 -->";
export const CONTINUE_MARKER = "<!-- downshift:continue:v1 -->";

export function createInitialState(): DownshiftState {
  return {
    sessionMode: "inherit",
    paused: false,
    position: "premium",
    handoff: "idle",
    continueAfterHandoff: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseTarget(value: unknown): ModelTarget | undefined {
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
  entries: PersistedStateEntry[],
  sessionId: string,
): DownshiftState | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const data = parseStateEntry(entries[index]);
    if (data) return restoredState(data, sessionId);
  }
  return undefined;
}

function parseStateEntry(entry: PersistedStateEntry): StateEntry | undefined {
  return entry.type === "custom" &&
    entry.customType === "downshift-state" &&
    isRecord(entry.data)
    ? (entry.data as StateEntry)
    : undefined;
}

function restoredState(data: StateEntry, sessionId: string): DownshiftState {
  const interrupted = data.handoff === "requested" || data.handoff === "active";
  return {
    sessionId: typeof data.sessionId === "string" ? data.sessionId : sessionId,
    sessionMode: restoredSessionMode(data),
    paused: interrupted || data.paused === true,
    position: data.position === "economy" ? "economy" : "premium",
    handoff: data.handoff === "done" ? "done" : "idle",
    continueAfterHandoff: false,
    capturedPremium: parseTarget(data.capturedPremium),
    lastError: restoredLastError(data, interrupted),
  };
}

function restoredSessionMode(data: StateEntry): SessionMode {
  if (data.sessionMode === "on" || data.sessionMode === "off")
    return data.sessionMode;
  if (data.sessionOverride === true) return "on";
  if (data.sessionEnabled === false) return "off";
  return "inherit";
}

function restoredLastError(
  data: StateEntry,
  interrupted: boolean,
): string | undefined {
  if (interrupted) return "handoff interrupted by reload";
  return typeof data.lastError === "string" ? data.lastError : undefined;
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

export function formatCompactNumber(value: number): string {
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
  if (!isDownshiftEnabled(config, state)) return "⇣ off";
  if (state.paused) return "⇣ paused";
  if (state.handoff === "requested") return "⇣ handoff";
  if (state.handoff === "active") return "⇣ writing handoff";
  if (state.position === "economy") return "⇣ economy";

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

  return parts.length === 0
    ? "⇣ premium"
    : `⇣ premium (${parts.join(" | ")} left)`;
}

function isDownshiftEnabled(
  config: DownshiftConfig | undefined,
  state: DownshiftState,
): config is DownshiftConfig {
  return (
    !!config &&
    state.sessionMode !== "off" &&
    (config.enabled || state.sessionMode === "on")
  );
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

function buildContinuePrompt(): string {
  return `${CONTINUE_MARKER}

Continue the original task from the Downshift handoff note using the current model.

Do not repeat the handoff note.
Do not restate the plan unless needed.
Pick up with the next concrete step and continue execution.`;
}

async function requestHandoff(
  deps: CoreDeps,
  runtime: Runtime,
  delivery: HandoffDelivery,
  config?: DownshiftConfig,
): Promise<DownshiftState> {
  setState(deps, runtime, {
    handoff: "requested",
    continueAfterHandoff: delivery === "steer",
    lastError: undefined,
  });
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
      continueAfterHandoff: false,
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
  if (!config.enabled && runtime.state.sessionMode !== "on") {
    deps.notify("downshift: disabled in config", "warning");
    return runtime.state;
  }
  if (runtime.state.sessionMode === "off" || runtime.state.paused) {
    setState(deps, runtime, {
      sessionMode: "on",
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

async function completeHandoffAndSwitch(
  deps: CoreDeps,
  runtime: Runtime,
): Promise<DownshiftState> {
  const config = await deps.readConfig();
  if (!canCompleteHandoff(config, runtime.state)) {
    clearPendingHandoffIfNeeded(deps, runtime);
    deps.updateStatus(config);
    return runtime.state;
  }
  const shouldContinue = runtime.state.continueAfterHandoff;
  setState(deps, runtime, {
    handoff: "done",
    continueAfterHandoff: false,
  });
  const switched = await deps.switchToTarget(
    config.economy,
    "economy",
    "handoff complete",
  );
  if (switched) {
    setState(deps, runtime, { position: "economy", lastError: undefined });
    if (shouldContinue) await continueOnEconomy(deps, runtime);
  }
  deps.updateStatus(config);
  return runtime.state;
}

function canCompleteHandoff(
  config: DownshiftConfig | undefined,
  state: DownshiftState,
): config is DownshiftConfig {
  return (
    isDownshiftEnabled(config, state) &&
    !state.paused &&
    state.position !== "economy"
  );
}

function clearPendingHandoffIfNeeded(deps: CoreDeps, runtime: Runtime): void {
  if (runtime.state.paused || runtime.state.position === "economy") return;
  setState(deps, runtime, { handoff: "idle", continueAfterHandoff: false });
}

async function continueOnEconomy(
  deps: CoreDeps,
  runtime: Runtime,
): Promise<void> {
  try {
    await deps.sendUserMessage(buildContinuePrompt(), {
      deliverAs: "followUp",
    });
    deps.notify("downshift: continuing on economy", "info");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setState(deps, runtime, {
      paused: true,
      lastError: `continue failed: ${message}`,
    });
    deps.notify(`downshift paused: continue failed: ${message}`, "error");
  }
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
    !isDownshiftEnabled(config, runtime.state) ||
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
      continueAfterHandoff: false,
      lastError: undefined,
    });
  deps.updateStatus(config);
  return runtime.state;
}

export async function maybeUpshiftAfterCompaction(
  deps: CoreDeps,
  runtime: Runtime,
  event: CompactionEventLike,
): Promise<DownshiftState> {
  const config = await deps.readConfig();
  deps.updateStatus(config);
  if (!canUpshiftAfterCompaction(config, runtime.state, event))
    return runtime.state;
  const premium = resolvePremium(config, runtime.state);
  if (!premium) {
    pauseForMissingPremium(deps, runtime);
    return runtime.state;
  }
  const switched = await deps.switchToTarget(premium, "premium", "upshifted");
  if (switched) setUpshifted(deps, runtime);
  deps.updateStatus(config);
  return runtime.state;
}

function canUpshiftAfterCompaction(
  config: DownshiftConfig | undefined,
  state: DownshiftState,
  event: CompactionEventLike,
): config is DownshiftConfig {
  return (
    event.compactionEntry !== undefined &&
    isDownshiftEnabled(config, state) &&
    config.upshiftAfterCompaction &&
    !state.paused &&
    state.position === "economy"
  );
}

function resolvePremium(
  config: DownshiftConfig,
  state: DownshiftState,
): ModelTarget | undefined {
  return config.premiumSource === "explicit"
    ? config.premium
    : state.capturedPremium;
}

function pauseForMissingPremium(deps: CoreDeps, runtime: Runtime): void {
  setState(deps, runtime, {
    paused: true,
    continueAfterHandoff: false,
    lastError: "premium target is unset",
  });
  deps.notify("downshift paused: premium target is unset", "error");
}

function setUpshifted(deps: CoreDeps, runtime: Runtime): void {
  setState(deps, runtime, {
    position: "premium",
    handoff: "idle",
    continueAfterHandoff: false,
    lastError: undefined,
  });
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
    deps.updateStatus(await deps.readConfig());
  }
  return runtime.state;
}

function containsText(value: unknown, text: string): boolean {
  if (typeof value === "string") return value.includes(text);
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value))
    return value.some((item) => containsText(item, text));
  return Object.values(value).some((item) => containsText(item, text));
}

export async function handleAgentEnd(
  deps: CoreDeps,
  runtime: Runtime,
  event: { messages?: unknown[] },
  _ctx: UsageContext,
): Promise<DownshiftState> {
  const completedHandoff =
    runtime.state.handoff === "active" ||
    (runtime.state.handoff === "requested" &&
      containsText(event.messages, HANDOFF_MARKER));
  if (completedHandoff) {
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
  if (!isDownshiftEnabled(config, runtime.state)) {
    deps.updateStatus(config);
    return runtime.state;
  }
  setState(deps, runtime, {
    paused: true,
    position: "premium",
    handoff: "idle",
    continueAfterHandoff: false,
    lastError: "manual model change",
  });
  deps.updateStatus(config);
  return runtime.state;
}
