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
      options?: { deliverAs: "followUp" | "steer" },
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
  const selected = await ctx.ui.select(
    current ? `${title} (current: ${targetLabel(current)})` : title,
    models.map((model) => `${model.provider}/${model.id}`),
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
  const selectedLevel = await ctx.ui.select("Select thinking level", levels);
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

async function configure(ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI) return;
  const previous = await readConfig();
  const enabled = await ctx.ui.confirm("Downshift", "Enable downshift?");
  const thresholdMode = await ctx.ui.select("Threshold", [
    "tokens",
    "percent",
    "both",
  ]);
  if (!thresholdMode) return;
  const threshold: Threshold = {};
  if (thresholdMode === "tokens" || thresholdMode === "both") {
    const tokens = await promptNumber(
      ctx,
      "Token threshold",
      previous?.threshold.tokens?.toString() ?? "100000",
    );
    if (!tokens) return ctx.ui.notify("Invalid token threshold", "error");
    threshold.tokens = tokens;
  }
  if (thresholdMode === "percent" || thresholdMode === "both") {
    const percent = await promptNumber(
      ctx,
      "Percent threshold",
      previous?.threshold.percent?.toString() ?? "60",
    );
    if (!percent) return ctx.ui.notify("Invalid percent threshold", "error");
    threshold.percent = percent;
  }
  const economy = await selectTarget(
    ctx,
    "Select economy model",
    previous?.economy,
  );
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
      ? await selectTarget(ctx, "Select premium model", previous?.premium)
      : undefined;
  if (premiumSource === "explicit" && !premium) return;
  const startOnPremium = await ctx.ui.confirm(
    "Start on premium",
    "Switch fresh sessions to premium automatically?",
  );
  const upshiftAfterCompaction = await ctx.ui.confirm(
    "Upshift",
    "Upshift after compaction when below threshold?",
  );
  const previousHandoff = previous?.handoffBeforeDownshift ?? true;
  const handoffChoice = await ctx.ui.select(
    `Handoff (current: ${previousHandoff ? "yes" : "no"})`,
    ["yes", "no"],
  );
  if (!handoffChoice) return;
  await writeConfig({
    enabled,
    threshold,
    economy,
    premiumSource,
    premium,
    startOnPremium,
    upshiftAfterCompaction,
    handoffBeforeDownshift: handoffChoice === "yes",
  });
  ctx.ui.notify("downshift config saved", "info");
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
    await maybeDownshift(coreDeps(pi, ctx), runtime, ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    await handleBeforeAgentStart(coreDeps(pi, ctx), runtime, event, ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    await handleAgentEnd(coreDeps(pi, ctx), runtime, ctx);
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
        saveState(pi, { sessionEnabled: false, handoff: "idle" });
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
          capturedPremium:
            config?.premiumSource === "current" && current
              ? { ...current, thinkingLevel: pi.getThinkingLevel() }
              : runtime.state.capturedPremium,
        });
        await maybeDownshift(coreDeps(pi, ctx), runtime, ctx);
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
