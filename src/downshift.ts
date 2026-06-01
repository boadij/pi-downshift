import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Model, ThinkingLevel } from "@earendil-works/pi-ai";
import type {
  ContextUsage,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  HANDOFF_MARKER,
  createInitialState,
  forceDownshiftNow,
  handleAgentEnd,
  handleBeforeAgentStart,
  handleManualModelSelect,
  maybeDownshift,
  maybeUpshift,
  restoreStateFromEntries,
  statusText,
  thresholdReached,
  type DownshiftConfig,
  type DownshiftState,
  type ModelTarget,
  type Position,
  type Threshold,
} from "./downshift-core";

const CONFIG_PATH = join(getAgentDir(), "downshift.json");
const CUSTOM_TYPE = "downshift-state";

type StateEntry = Partial<DownshiftState> & { version?: number };

type Runtime = { state: DownshiftState };

type ConfigField =
  | "enabled"
  | "threshold"
  | "economy"
  | "premiumSource"
  | "premium"
  | "startOnPremium"
  | "upshiftAfterCompaction"
  | "handoffBeforeDownshift";

let runtime: Runtime = { state: createInitialState() };
let internalModelChange = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
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

function parseThreshold(value: unknown): Threshold | undefined {
  if (!isRecord(value)) return undefined;
  const tokens = toPositiveNumber(value.tokens);
  const percent = toPositiveNumber(value.percent);
  if (!tokens && !percent) return undefined;
  return { tokens, percent };
}

async function readConfig(): Promise<DownshiftConfig | undefined> {
  try {
    const raw = JSON.parse(await readFile(CONFIG_PATH, "utf8")) as unknown;
    if (!isRecord(raw)) return undefined;
    const threshold = parseThreshold(raw.threshold);
    const economy = parseTarget(raw.economy);
    if (!threshold || !economy) return undefined;
    return {
      enabled: raw.enabled === true,
      threshold,
      economy,
      premiumSource: raw.premiumSource === "explicit" ? "explicit" : "current",
      premium: parseTarget(raw.premium),
      startOnPremium: raw.startOnPremium === true,
      upshiftAfterCompaction: raw.upshiftAfterCompaction === true,
      handoffBeforeDownshift: raw.handoffBeforeDownshift !== false,
    };
  } catch {
    return undefined;
  }
}

async function writeConfig(config: DownshiftConfig): Promise<void> {
  await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function getSelectableModels(
  ctx: Pick<ExtensionCommandContext, "modelRegistry">,
): Promise<Model<any>[]> {
  ctx.modelRegistry.refresh();
  return ctx.modelRegistry.getAvailable();
}

function getCurrentTarget(
  ctx: Pick<ExtensionContext, "model">,
): ModelTarget | undefined {
  if (!ctx.model) return undefined;
  return {
    provider: ctx.model.provider,
    model: ctx.model.id,
    thinkingLevel: "off",
  };
}

function targetLabel(target: ModelTarget | undefined): string {
  return target
    ? `${target.provider}/${target.model}:${target.thinkingLevel}`
    : "unset";
}

function formatThreshold(threshold: Threshold): string {
  const parts = [];
  if (threshold.tokens)
    parts.push(`${threshold.tokens.toLocaleString("en-US")} tokens`);
  if (threshold.percent) parts.push(`${threshold.percent}%`);
  return parts.join(" or ");
}

function updateStatus(ctx: ExtensionContext, config?: DownshiftConfig): void {
  ctx.ui.setStatus(
    "downshift",
    statusText(config, runtime.state, ctx.getContextUsage()),
  );
}

function saveState(pi: ExtensionAPI, patch?: Partial<DownshiftState>): void {
  if (patch) runtime.state = { ...runtime.state, ...patch };
  pi.appendEntry<StateEntry>(CUSTOM_TYPE, { version: 1, ...runtime.state });
}

function restoreState(ctx: ExtensionContext): boolean {
  const restored = restoreStateFromEntries(
    ctx.sessionManager.getEntries(),
    ctx.sessionManager.getSessionId(),
  );
  if (!restored) return false;
  runtime.state = restored;
  return true;
}

function pause(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  message: string,
  patch?: Partial<DownshiftState>,
): false {
  saveState(pi, { ...patch, paused: true, lastError: message });
  ctx.ui.notify(`downshift paused: ${message}`, "error");
  ctx.ui.setStatus("downshift", "⇣ paused");
  return false;
}

async function switchToTarget(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  target: ModelTarget,
  position: Position,
  reason: string,
): Promise<boolean> {
  const model = ctx.modelRegistry.find(target.provider, target.model);
  if (!model) return pause(pi, ctx, `model not found: ${targetLabel(target)}`);
  const levels = getSupportedThinkingLevels(model);
  if (!levels.includes(target.thinkingLevel as ThinkingLevel)) {
    return pause(pi, ctx, `thinking level unsupported: ${targetLabel(target)}`);
  }
  try {
    internalModelChange = true;
    const ok = await pi.setModel(model);
    if (!ok)
      return pause(
        pi,
        ctx,
        `no API key for ${target.provider}/${target.model}`,
      );
    pi.setThinkingLevel(target.thinkingLevel as ThinkingLevel);
    saveState(pi, { position, lastError: undefined });
    ctx.ui.notify(`downshift: ${reason} to ${targetLabel(target)}`, "info");
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return pause(pi, ctx, message);
  } finally {
    internalModelChange = false;
  }
}

function coreDeps(pi: ExtensionAPI, ctx: ExtensionContext) {
  return {
    readConfig,
    saveState: (next: DownshiftState) => {
      runtime.state = next;
      saveState(pi);
    },
    sendUserMessage: (
      prompt: string,
      options?: { deliverAs: "steer" | "followUp" },
    ) => pi.sendUserMessage(prompt, options),
    switchToTarget: (target: ModelTarget, position: Position, reason: string) =>
      switchToTarget(pi, ctx, target, position, reason),
    updateStatus: (config?: DownshiftConfig) => updateStatus(ctx, config),
    notify: (message: string, level?: string) =>
      ctx.ui.notify(message, level as any),
  };
}

function resolvePremiumTarget(
  config: DownshiftConfig,
): ModelTarget | undefined {
  return config.premiumSource === "explicit"
    ? config.premium
    : runtime.state.capturedPremium;
}

async function selectTarget(
  ctx: ExtensionCommandContext,
  title: string,
  current?: ModelTarget,
): Promise<ModelTarget | undefined> {
  const models = (await getSelectableModels(ctx))
    .slice()
    .sort(
      (a, b) =>
        a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id),
    );
  if (models.length === 0) {
    ctx.ui.notify("No models available", "error");
    return undefined;
  }
  const labels = models.map((model) => `${model.provider}/${model.id}`);
  const currentModelLabel = current
    ? `${current.provider}/${current.model}`
    : undefined;
  const orderedLabels =
    currentModelLabel && labels.includes(currentModelLabel)
      ? [
          currentModelLabel,
          ...labels.filter((label) => label !== currentModelLabel),
        ]
      : labels;
  const selected = await ctx.ui.select(
    current ? `${title} (current: ${targetLabel(current)})` : title,
    orderedLabels,
  );
  if (!selected) return undefined;
  const slash = selected.indexOf("/");
  const provider = selected.slice(0, slash);
  const modelId = selected.slice(slash + 1);
  const model = models.find(
    (item) => item.provider === provider && item.id === modelId,
  );
  if (!model) return undefined;
  const levels = getSupportedThinkingLevels(model);
  const orderedLevels =
    current?.thinkingLevel &&
    levels.includes(current.thinkingLevel as ThinkingLevel)
      ? [
          current.thinkingLevel as ThinkingLevel,
          ...levels.filter((level) => level !== current.thinkingLevel),
        ]
      : levels;
  const selectedLevel = await ctx.ui.select(
    "Select thinking level",
    orderedLevels,
  );
  if (!selectedLevel) return undefined;
  return { provider, model: modelId, thinkingLevel: selectedLevel };
}

async function promptNumber(
  ctx: ExtensionCommandContext,
  title: string,
  placeholder: string,
): Promise<number | undefined> {
  const raw = await ctx.ui.input(title, placeholder);
  if (!raw?.trim()) return undefined;
  const value = Number(raw.replace(/,/g, ""));
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function yesNo(value: boolean | undefined): string {
  return value ? "yes" : "no";
}

function optionalTargetLabel(target: ModelTarget | undefined): string {
  return target ? targetLabel(target) : "unset";
}

function premiumSourceLabel(config: DownshiftConfig): string {
  return config.premiumSource === "explicit" ? "explicit" : "current";
}

function premiumLabel(config: DownshiftConfig): string {
  if (config.premiumSource === "current") return "current session model";
  return optionalTargetLabel(config.premium);
}

function configMenuItems(config: DownshiftConfig): string[] {
  return [
    `enabled: ${yesNo(config.enabled)}`,
    `threshold: ${formatThreshold(config.threshold)}`,
    `economy: ${targetLabel(config.economy)}`,
    `premium source: ${premiumSourceLabel(config)}`,
    `premium model: ${premiumLabel(config)}`,
    `start on premium: ${yesNo(config.startOnPremium)}`,
    `upshift after compaction: ${yesNo(config.upshiftAfterCompaction)}`,
    `handoff note: ${yesNo(config.handoffBeforeDownshift)}`,
    "done",
  ];
}

function configFieldFromMenuItem(
  item: string,
): ConfigField | "done" | undefined {
  if (item.startsWith("enabled:")) return "enabled";
  if (item.startsWith("threshold:")) return "threshold";
  if (item.startsWith("economy:")) return "economy";
  if (item.startsWith("premium source:")) return "premiumSource";
  if (item.startsWith("premium model:")) return "premium";
  if (item.startsWith("start on premium:")) return "startOnPremium";
  if (item.startsWith("upshift after compaction:"))
    return "upshiftAfterCompaction";
  if (item.startsWith("handoff note:")) return "handoffBeforeDownshift";
  if (item === "done") return "done";
  return undefined;
}

async function selectBoolean(
  ctx: ExtensionCommandContext,
  title: string,
  current: boolean,
): Promise<boolean | undefined> {
  const options = current ? ["yes", "no"] : ["no", "yes"];
  const selected = await ctx.ui.select(
    `${title} (current: ${yesNo(current)})`,
    options,
  );
  if (!selected) return undefined;
  return selected === "yes";
}

async function editThreshold(
  ctx: ExtensionCommandContext,
  previous: Threshold,
): Promise<Threshold | undefined> {
  const currentMode =
    previous.tokens !== undefined && previous.percent !== undefined
      ? "both"
      : previous.tokens !== undefined
        ? "tokens"
        : "percent";
  const thresholdMode = await ctx.ui.select(
    `Threshold (current: ${formatThreshold(previous)})`,
    [
      currentMode,
      ...["tokens", "percent", "both"].filter((mode) => mode !== currentMode),
    ],
  );
  if (!thresholdMode) return undefined;
  const threshold: Threshold = {};
  if (thresholdMode === "tokens" || thresholdMode === "both") {
    const tokens = await promptNumber(
      ctx,
      "Token threshold",
      previous.tokens?.toString() ?? "100000",
    );
    if (!tokens) {
      ctx.ui.notify("Invalid token threshold", "error");
      return undefined;
    }
    threshold.tokens = tokens;
  }
  if (thresholdMode === "percent" || thresholdMode === "both") {
    const percent = await promptNumber(
      ctx,
      "Percent threshold",
      previous.percent?.toString() ?? "60",
    );
    if (!percent) {
      ctx.ui.notify("Invalid percent threshold", "error");
      return undefined;
    }
    if (percent > 100) {
      ctx.ui.notify("Percent threshold must be 100 or less", "error");
      return undefined;
    }
    threshold.percent = percent;
  }
  return threshold;
}

async function configureInitial(ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI) return;
  const enabled = await selectBoolean(ctx, "Enable downshift?", true);
  if (enabled === undefined) return;
  const threshold = await editThreshold(ctx, { tokens: 100000, percent: 60 });
  if (!threshold) return;
  const economy = await selectTarget(ctx, "Select economy model");
  if (!economy) return;
  const premiumMode = await ctx.ui.select("Premium source", [
    "current session model",
    "explicit premium model",
  ]);
  if (!premiumMode) return;
  const premiumSource =
    premiumMode === "explicit premium model" ? "explicit" : "current";
  const premium =
    premiumSource === "explicit"
      ? await selectTarget(ctx, "Select premium model")
      : undefined;
  if (premiumSource === "explicit" && !premium) return;
  const startOnPremium = await selectBoolean(
    ctx,
    "Start fresh sessions on premium?",
    true,
  );
  if (startOnPremium === undefined) return;
  const upshiftAfterCompaction = await selectBoolean(
    ctx,
    "Upshift after compaction?",
    true,
  );
  if (upshiftAfterCompaction === undefined) return;
  const handoffBeforeDownshift = await selectBoolean(
    ctx,
    "Create handoff note before downshifting?",
    true,
  );
  if (handoffBeforeDownshift === undefined) return;
  await writeConfig({
    enabled,
    threshold,
    economy,
    premiumSource,
    premium,
    startOnPremium,
    upshiftAfterCompaction,
    handoffBeforeDownshift,
  });
  ctx.ui.notify("downshift config created", "info");
}

async function configureMenu(
  ctx: ExtensionCommandContext,
  initial: DownshiftConfig,
): Promise<void> {
  let config = initial;
  while (true) {
    const selected = await ctx.ui.select(
      "Downshift config",
      configMenuItems(config),
    );
    if (!selected) return;
    const field = configFieldFromMenuItem(selected);
    if (!field) return;
    if (field === "done") {
      ctx.ui.notify("downshift config closed", "info");
      return;
    }
    const next = await editConfigField(ctx, config, field);
    if (!next) continue;
    config = next;
    await writeConfig(config);
    ctx.ui.notify("downshift config saved", "info");
  }
}

async function editConfigField(
  ctx: ExtensionCommandContext,
  config: DownshiftConfig,
  field: ConfigField,
): Promise<DownshiftConfig | undefined> {
  switch (field) {
    case "enabled": {
      const enabled = await selectBoolean(
        ctx,
        "Enable downshift?",
        config.enabled,
      );
      return enabled === undefined ? undefined : { ...config, enabled };
    }
    case "threshold": {
      const threshold = await editThreshold(ctx, config.threshold);
      return threshold ? { ...config, threshold } : undefined;
    }
    case "economy": {
      const economy = await selectTarget(
        ctx,
        "Select economy model",
        config.economy,
      );
      return economy ? { ...config, economy } : undefined;
    }
    case "premiumSource": {
      const currentLabel =
        config.premiumSource === "explicit"
          ? "explicit premium model"
          : "current session model";
      const selected = await ctx.ui.select(
        `Premium source (current: ${currentLabel})`,
        [
          currentLabel,
          ...["current session model", "explicit premium model"].filter(
            (item) => item !== currentLabel,
          ),
        ],
      );
      if (!selected) return undefined;
      const premiumSource =
        selected === "explicit premium model" ? "explicit" : "current";
      if (premiumSource === "explicit" && !config.premium) {
        const premium = await selectTarget(ctx, "Select premium model");
        if (!premium) return undefined;
        return { ...config, premiumSource, premium };
      }
      return { ...config, premiumSource };
    }
    case "premium": {
      const premium = await selectTarget(
        ctx,
        "Select premium model",
        config.premium,
      );
      if (!premium) return undefined;
      return { ...config, premiumSource: "explicit", premium };
    }
    case "startOnPremium": {
      const startOnPremium = await selectBoolean(
        ctx,
        "Start fresh sessions on premium?",
        config.startOnPremium,
      );
      return startOnPremium === undefined
        ? undefined
        : { ...config, startOnPremium };
    }
    case "upshiftAfterCompaction": {
      const upshiftAfterCompaction = await selectBoolean(
        ctx,
        "Upshift after compaction?",
        config.upshiftAfterCompaction,
      );
      return upshiftAfterCompaction === undefined
        ? undefined
        : { ...config, upshiftAfterCompaction };
    }
    case "handoffBeforeDownshift": {
      const handoffBeforeDownshift = await selectBoolean(
        ctx,
        "Create handoff note before downshifting?",
        config.handoffBeforeDownshift,
      );
      return handoffBeforeDownshift === undefined
        ? undefined
        : { ...config, handoffBeforeDownshift };
    }
  }
}

async function configure(ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI) return;
  const previous = await readConfig();
  if (!previous) return configureInitial(ctx);
  return configureMenu(ctx, previous);
}

function formatUsage(usage: ContextUsage | undefined): string {
  if (!usage) return "unknown";
  const tokens =
    usage.tokens === null ? "unknown" : usage.tokens.toLocaleString("en-US");
  const percent =
    usage.percent === null ? "unknown" : `${Math.round(usage.percent)}%`;
  return `${tokens} tokens (${percent})`;
}

function formatCompactNumber(value: number): string {
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000) return `${Math.round(value / 1_000_000)}m`;
  if (absolute >= 1_000) return `${Math.round(value / 1_000)}k`;
  return `${Math.round(value)}`;
}

function formatRemaining(
  usage: ContextUsage | undefined,
  threshold: Threshold,
): string {
  if (!usage) return "unknown";
  const parts: string[] = [];
  if (threshold.tokens !== undefined) {
    if (usage.tokens === null) {
      parts.push(`?/${threshold.tokens.toLocaleString("en-US")}`);
    } else {
      parts.push(
        `${formatCompactNumber(Math.max(0, threshold.tokens - usage.tokens))} left`,
      );
    }
  }
  if (threshold.percent !== undefined) {
    if (usage.percent === null) {
      parts.push(`?/${threshold.percent}%`);
    } else {
      parts.push(
        `${Math.max(0, Math.round(threshold.percent - usage.percent))}% left`,
      );
    }
  }
  return parts.length > 0 ? parts.join(" / ") : "unknown";
}

async function showStatus(ctx: ExtensionCommandContext): Promise<void> {
  const config = await readConfig();
  const usage = ctx.getContextUsage();
  const lines = [
    `mode: ${statusText(config, runtime.state, usage)}`,
    `usage: ${formatUsage(usage)}`,
    `remaining: ${config ? formatRemaining(usage, config.threshold) : "unset"}`,
    `threshold: ${config ? formatThreshold(config.threshold) : "unset"}`,
    `premium: ${config ? targetLabel(resolvePremiumTarget(config)) : "unset"}`,
    `economy: ${config ? targetLabel(config.economy) : "unset"}`,
    `handoff: ${config?.handoffBeforeDownshift ? "auto" : "off"}`,
    `handoff state: ${runtime.state.handoff}`,
    `upshift: ${config?.upshiftAfterCompaction ? "on" : "off"}`,
    `source: ${config?.premiumSource ?? "current"}`,
    `commands: /downshift status | now | on | off | config`,
  ];
  if (runtime.state.lastError)
    lines.push(`last error: ${runtime.state.lastError}`);
  ctx.ui.notify(lines.join("\n"), "info");
}

export default function downshift(pi: ExtensionAPI): void {
  pi.on("session_start", async (event, ctx) => {
    const hadState = restoreState(ctx);
    const config = await readConfig();
    if (!hadState) {
      const current = getCurrentTarget(ctx);
      runtime.state = {
        sessionId: ctx.sessionManager.getSessionId(),
        sessionEnabled: true,
        paused: false,
        position: "premium",
        handoff: "idle",
        continueAfterHandoff: false,
        capturedPremium: current
          ? { ...current, thinkingLevel: pi.getThinkingLevel() }
          : undefined,
      };
      saveState(pi);
      if (
        config?.enabled &&
        config.startOnPremium &&
        config.premium &&
        event.reason !== "resume" &&
        !thresholdReached(ctx.getContextUsage(), config.threshold)
      ) {
        await switchToTarget(pi, ctx, config.premium, "premium", "started");
      }
    }
    updateStatus(ctx, config);
  });

  pi.on("context", async (_event, ctx) => {
    await maybeDownshift(
      coreDeps(pi, ctx),
      runtime,
      ctx,
      ctx.isIdle() ? "immediate" : "steer",
    );
  });

  pi.on("before_agent_start", async (event, ctx) => {
    await handleBeforeAgentStart(coreDeps(pi, ctx), runtime, event, ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    await handleAgentEnd(coreDeps(pi, ctx), runtime, _event, ctx);
  });

  pi.on("session_compact", async (_event, ctx) => {
    await maybeUpshift(coreDeps(pi, ctx), runtime, ctx);
  });

  pi.on("model_select", async (event, ctx) => {
    if (internalModelChange) return;
    await handleManualModelSelect(coreDeps(pi, ctx), runtime, event, ctx);
  });

  pi.registerCommand("downshift", {
    description: "Configure automatic model downshifting by context threshold",
    handler: async (args, ctx) => {
      const command = args.trim() || "status";
      if (command === "config") return configure(ctx);
      if (command === "status") return showStatus(ctx);
      if (command === "now") {
        await forceDownshiftNow(
          coreDeps(pi, ctx),
          runtime,
          ctx.isIdle() ? "immediate" : "steer",
        );
        updateStatus(ctx, await readConfig());
        return;
      }
      if (command === "off") {
        saveState(pi, {
          sessionEnabled: false,
          handoff: "idle",
          continueAfterHandoff: false,
        });
        updateStatus(ctx, await readConfig());
        ctx.ui.notify("downshift off for this session", "info");
        return;
      }
      if (command === "on") {
        const config = await readConfig();
        const current = getCurrentTarget(ctx);
        saveState(pi, {
          sessionEnabled: true,
          paused: false,
          position: "premium",
          lastError: undefined,
          handoff: "idle",
          continueAfterHandoff: false,
          capturedPremium:
            config?.premiumSource === "current" && current
              ? { ...current, thinkingLevel: pi.getThinkingLevel() }
              : runtime.state.capturedPremium,
        });
        await maybeDownshift(
          coreDeps(pi, ctx),
          runtime,
          ctx,
          ctx.isIdle() ? "immediate" : "steer",
        );
        updateStatus(ctx, config);
        ctx.ui.notify("downshift on for this session", "info");
        return;
      }
      ctx.ui.notify(
        "Usage: /downshift status | now | on | off | config",
        "warning",
      );
    },
  });
}
