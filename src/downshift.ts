import { readFileSync } from "node:fs";
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
  handleManualThinkingLevelSelect,
  maybeDownshift,
  maybeUpshiftAfterCompaction,
  parseTarget,
  formatCompactNumber,
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

function readPackageVersion(): string {
  try {
    const raw = readFileSync(
      new URL("../package.json", import.meta.url),
      "utf8",
    );
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

const VERSION = readPackageVersion();

type StateEntry = Partial<DownshiftState> & { version?: number };

type Runtime = { state: DownshiftState };

type ConfigField =
  | "enabled"
  | "threshold"
  | "economy"
  | "premium"
  | "startOnPremium"
  | "upshiftAfterCompaction"
  | "handoffBeforeDownshift";

const CONFIG_FIELD_PREFIXES: Array<[string, ConfigField]> = [
  ["enabled:", "enabled"],
  ["threshold:", "threshold"],
  ["economy:", "economy"],
  ["premium:", "premium"],
  ["start on premium:", "startOnPremium"],
  ["upshift after compaction:", "upshiftAfterCompaction"],
  ["handoff note:", "handoffBeforeDownshift"],
];

const BOOLEAN_FIELD_PROMPTS: Record<
  Extract<
    ConfigField,
    | "enabled"
    | "startOnPremium"
    | "upshiftAfterCompaction"
    | "handoffBeforeDownshift"
  >,
  string
> = {
  enabled: "Enable downshift?",
  startOnPremium: "Start fresh sessions on premium?",
  upshiftAfterCompaction: "Upshift after compaction?",
  handoffBeforeDownshift: "Create handoff note before downshifting?",
};

type ConfigFieldEditor = (
  ctx: ExtensionCommandContext,
  config: DownshiftConfig,
) => Promise<DownshiftConfig | undefined>;

let runtime: Runtime = { state: createInitialState() };
let internalTargetChange = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
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

function getActiveTarget(
  pi: Pick<ExtensionAPI, "getThinkingLevel">,
  ctx: Pick<ExtensionContext, "model">,
): ModelTarget | undefined {
  if (!ctx.model) return undefined;
  return {
    provider: ctx.model.provider,
    model: ctx.model.id,
    thinkingLevel: pi.getThinkingLevel(),
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

async function refreshStatus(
  ctx: ExtensionContext,
): Promise<DownshiftConfig | undefined> {
  const config = await readConfig();
  updateStatus(ctx, config);
  return config;
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
    internalTargetChange = true;
    const active = getActiveTarget(pi, ctx);
    const modelChanged =
      active?.provider !== target.provider || active.model !== target.model;
    if (modelChanged) {
      const ok = await pi.setModel(model);
      if (!ok)
        return pause(
          pi,
          ctx,
          `no API key for ${target.provider}/${target.model}`,
        );
    }
    if (pi.getThinkingLevel() !== target.thinkingLevel) {
      pi.setThinkingLevel(target.thinkingLevel as ThinkingLevel);
    }
    saveState(pi, { position, lastError: undefined });
    ctx.ui.notify(`downshift: ${reason} to ${targetLabel(target)}`, "info");
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return pause(pi, ctx, message);
  } finally {
    internalTargetChange = false;
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
  const models = await sortedSelectableModels(ctx);
  if (models.length === 0) {
    ctx.ui.notify("No models available", "error");
    return undefined;
  }
  const selected = await ctx.ui.select(
    current ? `${title} (current: ${targetLabel(current)})` : title,
    orderedModelLabels(models, current),
  );
  if (!selected) return undefined;
  const { provider, modelId } = splitModelLabel(selected);
  const model = models.find(
    (item) => item.provider === provider && item.id === modelId,
  );
  if (!model) return undefined;
  const levels = getSupportedThinkingLevels(model);
  const selectedLevel = await ctx.ui.select(
    "Select thinking level",
    orderedThinkingLevels(levels, current),
  );
  if (!selectedLevel) return undefined;
  return { provider, model: modelId, thinkingLevel: selectedLevel };
}

async function sortedSelectableModels(
  ctx: Pick<ExtensionCommandContext, "modelRegistry">,
): Promise<Model<any>[]> {
  return (await getSelectableModels(ctx))
    .slice()
    .sort(
      (a, b) =>
        a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id),
    );
}

function orderedModelLabels(
  models: Model<any>[],
  current?: ModelTarget,
): string[] {
  const labels = models.map((model) => `${model.provider}/${model.id}`);
  const currentLabel = current
    ? `${current.provider}/${current.model}`
    : undefined;
  return currentLabel && labels.includes(currentLabel)
    ? [currentLabel, ...labels.filter((label) => label !== currentLabel)]
    : labels;
}

function splitModelLabel(label: string): { provider: string; modelId: string } {
  const slash = label.indexOf("/");
  return { provider: label.slice(0, slash), modelId: label.slice(slash + 1) };
}

function orderedThinkingLevels(
  levels: ReturnType<typeof getSupportedThinkingLevels>,
  current?: ModelTarget,
): ReturnType<typeof getSupportedThinkingLevels> {
  const currentLevel = current?.thinkingLevel as ThinkingLevel | undefined;
  return currentLevel && levels.includes(currentLevel)
    ? [currentLevel, ...levels.filter((level) => level !== currentLevel)]
    : levels;
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
    `premium: ${premiumSourceLabel(config)} (${premiumLabel(config)})`,
    `start on premium: ${yesNo(config.startOnPremium)}`,
    `upshift after compaction: ${yesNo(config.upshiftAfterCompaction)}`,
    `handoff note: ${yesNo(config.handoffBeforeDownshift)}`,
  ];
}

function configFieldFromMenuItem(item: string): ConfigField | undefined {
  return CONFIG_FIELD_PREFIXES.find(([prefix]) => item.startsWith(prefix))?.[1];
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

async function selectPremium(
  ctx: ExtensionCommandContext,
  previous?: DownshiftConfig,
): Promise<Pick<DownshiftConfig, "premiumSource" | "premium"> | undefined> {
  const premiumMode = await ctx.ui.select(
    premiumSourcePrompt(previous),
    orderedPremiumSourceOptions(previous),
  );
  if (!premiumMode) return undefined;
  const premiumSource = premiumSourceFromLabel(premiumMode);
  if (premiumSource === "current") {
    return { premiumSource, premium: previous?.premium };
  }
  const premium = await selectTarget(
    ctx,
    "Select premium model",
    previous?.premium,
  );
  return premium ? { premiumSource, premium } : undefined;
}

function premiumSourcePrompt(previous?: DownshiftConfig): string {
  const current = premiumSourceOptionLabel(previous);
  return previous ? `Premium source (current: ${current})` : "Premium source";
}

function orderedPremiumSourceOptions(previous?: DownshiftConfig): string[] {
  const current = premiumSourceOptionLabel(previous);
  const options = ["current session model", "explicit premium model"];
  return [current, ...options.filter((item) => item !== current)];
}

function premiumSourceOptionLabel(previous?: DownshiftConfig): string {
  return previous?.premiumSource === "explicit"
    ? "explicit premium model"
    : "current session model";
}

function premiumSourceFromLabel(label: string): "current" | "explicit" {
  return label === "explicit premium model" ? "explicit" : "current";
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
  return buildThreshold(ctx, previous, thresholdMode);
}

async function promptThresholdValue(
  ctx: ExtensionCommandContext,
  kind: "tokens" | "percent",
  previous: Threshold,
): Promise<number | undefined> {
  const value = await promptNumber(
    ctx,
    thresholdValueTitle(kind),
    thresholdValuePlaceholder(kind, previous),
  );
  if (!value) ctx.ui.notify(`Invalid ${kind} threshold`, "error");
  if (invalidPercentThreshold(kind, value)) {
    ctx.ui.notify("Percent threshold must be 100 or less", "error");
    return undefined;
  }
  return value;
}

function thresholdValueTitle(kind: "tokens" | "percent"): string {
  return kind === "tokens" ? "Token threshold" : "Percent threshold";
}

function thresholdValuePlaceholder(
  kind: "tokens" | "percent",
  previous: Threshold,
): string {
  return previous[kind]?.toString() ?? (kind === "tokens" ? "100000" : "60");
}

function invalidPercentThreshold(
  kind: "tokens" | "percent",
  value: number | undefined,
): boolean {
  return kind === "percent" && value !== undefined && value > 100;
}

async function buildThreshold(
  ctx: ExtensionCommandContext,
  previous: Threshold,
  mode: string,
): Promise<Threshold | undefined> {
  const threshold: Threshold = {};
  if (mode !== "percent") {
    const tokens = await promptThresholdValue(ctx, "tokens", previous);
    if (!tokens) return undefined;
    threshold.tokens = tokens;
  }
  if (mode !== "tokens") {
    const percent = await promptThresholdValue(ctx, "percent", previous);
    if (!percent) return undefined;
    threshold.percent = percent;
  }
  return threshold;
}

async function configureInitial(ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI) return;
  const enabled = await selectBoolean(ctx, "Enable downshift?", true);
  if (enabled === undefined) return;
  const premiumConfig = await selectPremium(ctx);
  if (!premiumConfig) return;
  const startOnPremium = await selectBoolean(
    ctx,
    "Start fresh sessions on premium?",
    true,
  );
  if (startOnPremium === undefined) return;
  const threshold = { tokens: 100000, percent: 50 };
  const economy = await selectTarget(ctx, "Select economy model");
  if (!economy) return;
  const config: DownshiftConfig = {
    enabled,
    threshold,
    economy,
    premiumSource: premiumConfig.premiumSource,
    premium: premiumConfig.premium,
    startOnPremium,
    upshiftAfterCompaction: false,
    handoffBeforeDownshift: true,
  };
  await writeConfig(config);
  updateStatus(ctx, config);
  ctx.ui.notify("downshift config created", "info");
}

async function configureMenu(
  ctx: ExtensionCommandContext,
  initial: DownshiftConfig,
): Promise<void> {
  let config = initial;
  while (true) {
    const selected = await ctx.ui.select(
      `⇣ Downshift v${VERSION}`,
      configMenuItems(config),
    );
    if (!selected) return;
    const field = configFieldFromMenuItem(selected);
    if (!field) return;
    const next = await editConfigField(ctx, config, field);
    if (!next) continue;
    config = next;
    await writeConfig(config);
    updateStatus(ctx, config);
    ctx.ui.notify("downshift config saved", "info");
  }
}

async function editConfigField(
  ctx: ExtensionCommandContext,
  config: DownshiftConfig,
  field: ConfigField,
): Promise<DownshiftConfig | undefined> {
  return CONFIG_FIELD_EDITORS[field](ctx, config);
}

const CONFIG_FIELD_EDITORS: Record<ConfigField, ConfigFieldEditor> = {
  enabled: (ctx, config) => editBooleanConfigField(ctx, config, "enabled"),
  threshold: editThresholdConfigField,
  economy: editEconomyConfigField,
  premium: editPremiumConfigField,
  startOnPremium: (ctx, config) =>
    editBooleanConfigField(ctx, config, "startOnPremium"),
  upshiftAfterCompaction: (ctx, config) =>
    editBooleanConfigField(ctx, config, "upshiftAfterCompaction"),
  handoffBeforeDownshift: (ctx, config) =>
    editBooleanConfigField(ctx, config, "handoffBeforeDownshift"),
};

async function editThresholdConfigField(
  ctx: ExtensionCommandContext,
  config: DownshiftConfig,
): Promise<DownshiftConfig | undefined> {
  const threshold = await editThreshold(ctx, config.threshold);
  return threshold ? { ...config, threshold } : undefined;
}

async function editEconomyConfigField(
  ctx: ExtensionCommandContext,
  config: DownshiftConfig,
): Promise<DownshiftConfig | undefined> {
  const economy = await selectTarget(
    ctx,
    "Select economy model",
    config.economy,
  );
  return economy ? { ...config, economy } : undefined;
}

async function editPremiumConfigField(
  ctx: ExtensionCommandContext,
  config: DownshiftConfig,
): Promise<DownshiftConfig | undefined> {
  const premiumConfig = await selectPremium(ctx, config);
  return premiumConfig ? { ...config, ...premiumConfig } : undefined;
}

async function editBooleanConfigField(
  ctx: ExtensionCommandContext,
  config: DownshiftConfig,
  field: keyof typeof BOOLEAN_FIELD_PROMPTS,
): Promise<DownshiftConfig | undefined> {
  const value = await selectBoolean(
    ctx,
    BOOLEAN_FIELD_PROMPTS[field],
    config[field],
  );
  return value === undefined ? undefined : { ...config, [field]: value };
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

function formatRemaining(
  usage: ContextUsage | undefined,
  threshold: Threshold,
): string {
  if (!usage) return "unknown";
  const parts = [
    remainingTokens(usage.tokens, threshold.tokens),
    remainingPercent(usage.percent, threshold.percent),
  ].filter((part) => part !== undefined);
  return parts.length > 0 ? parts.join(" / ") : "unknown";
}

function remainingTokens(
  usageTokens: number | null,
  thresholdTokens: number | undefined,
): string | undefined {
  if (thresholdTokens === undefined) return undefined;
  if (usageTokens === null)
    return `?/${thresholdTokens.toLocaleString("en-US")}`;
  return `${formatCompactNumber(Math.max(0, thresholdTokens - usageTokens))} left`;
}

function remainingPercent(
  usagePercent: number | null,
  thresholdPercent: number | undefined,
): string | undefined {
  if (thresholdPercent === undefined) return undefined;
  if (usagePercent === null) return `?/${thresholdPercent}%`;
  return `${Math.max(0, Math.round(thresholdPercent - usagePercent))}% left`;
}

async function showStatus(ctx: ExtensionCommandContext): Promise<void> {
  const config = await readConfig();
  const lines = buildStatusLines(config, runtime.state, ctx.getContextUsage());
  ctx.ui.notify(lines.join("\n"), "info");
}

function buildStatusLines(
  config: DownshiftConfig | undefined,
  state: DownshiftState,
  usage: ContextUsage | undefined,
): string[] {
  const lines = baseStatusLines(config, state, usage);
  if (state.lastError) lines.push(`last error: ${state.lastError}`);
  return lines;
}

function baseStatusLines(
  config: DownshiftConfig | undefined,
  state: DownshiftState,
  usage: ContextUsage | undefined,
): string[] {
  return STATUS_LINE_BUILDERS.map((build) => build(config, state, usage));
}

const STATUS_LINE_BUILDERS: Array<
  (
    config: DownshiftConfig | undefined,
    state: DownshiftState,
    usage: ContextUsage | undefined,
  ) => string
> = [
  (config, state, usage) => `mode: ${statusText(config, state, usage)}`,
  (_config, _state, usage) => `usage: ${formatUsage(usage)}`,
  (config, _state, usage) =>
    `remaining: ${formatOptionalRemaining(usage, config?.threshold)}`,
  (config) => `threshold: ${formatOptionalThreshold(config?.threshold)}`,
  (config) => `premium: ${targetLabel(resolveOptionalPremiumTarget(config))}`,
  (config) => `economy: ${targetLabel(config?.economy)}`,
  (config) => `handoff: ${yesNoMode(config?.handoffBeforeDownshift, "auto")}`,
  (_config, state) => `handoff state: ${state.handoff}`,
  (config) => `upshift: ${yesNoMode(config?.upshiftAfterCompaction, "on")}`,
  (config) => `source: ${config?.premiumSource ?? "current"}`,
  () => `version: ${VERSION}`,
  () => `commands: /downshift | status | now | on | off | help`,
];

function formatOptionalRemaining(
  usage: ContextUsage | undefined,
  threshold: Threshold | undefined,
): string {
  return threshold ? formatRemaining(usage, threshold) : "unset";
}

function formatOptionalThreshold(threshold: Threshold | undefined): string {
  return threshold ? formatThreshold(threshold) : "unset";
}

function resolveOptionalPremiumTarget(
  config: DownshiftConfig | undefined,
): ModelTarget | undefined {
  return config ? resolvePremiumTarget(config) : undefined;
}

function yesNoMode(value: boolean | undefined, yes: string): string {
  return value ? yes : "off";
}

function usageText(): string {
  return [
    `Downshift v${VERSION}`,
    "",
    "/downshift - configure Downshift",
    "/downshift status - show current mode, config, and version",
    "/downshift now - handoff now and switch to economy",
    "/downshift on - enable Downshift for this session",
    "/downshift off - disable Downshift for this session",
    "/downshift help - show this help",
  ].join("\n");
}

async function runDownshiftCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  command: string,
): Promise<void> {
  const actions: Record<string, () => Promise<void> | void> = {
    status: () => showStatus(ctx),
    help: () => ctx.ui.notify(usageText(), "info"),
    now: () => downshiftNow(pi, ctx),
    off: () => setSessionEnabled(pi, ctx, false),
    on: () => setSessionEnabled(pi, ctx, true),
  };
  const action = actions[command];
  if (action) return action();
  ctx.ui.notify(usageText(), "warning");
}

async function downshiftNow(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<void> {
  await forceDownshiftNow(
    coreDeps(pi, ctx),
    runtime,
    ctx.isIdle() ? "immediate" : "steer",
  );
  await refreshStatus(ctx);
}

async function setSessionEnabled(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  enabled: boolean,
): Promise<void> {
  return enabled ? enableSession(pi, ctx) : disableSession(pi, ctx);
}

async function disableSession(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<void> {
  saveState(pi, {
    sessionMode: "off",
    handoff: "idle",
    continueAfterHandoff: false,
  });
  await refreshStatus(ctx);
  ctx.ui.notify("downshift off for this session", "info");
}

async function enableSession(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const config = await readConfig();
  if (!config) {
    updateStatus(ctx, config);
    pause(pi, ctx, "config missing", {
      sessionMode: "on",
      handoff: "idle",
      continueAfterHandoff: false,
    });
    return;
  }
  saveState(pi, enabledSessionState(pi, ctx, config));
  const reconciled = await reconcileEnabledSession(pi, ctx, config);
  updateStatus(ctx, config);
  if (reconciled) ctx.ui.notify("downshift on for this session", "info");
}

function enabledSessionState(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  config: DownshiftConfig,
): Partial<DownshiftState> {
  return {
    sessionMode: "on",
    paused: false,
    lastError: undefined,
    handoff: "idle",
    continueAfterHandoff: false,
    capturedPremium: capturedPremiumForEnable(pi, ctx, config),
  };
}

function capturedPremiumForEnable(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  config: DownshiftConfig,
): ModelTarget | undefined {
  const current = getActiveTarget(pi, ctx);
  if (config.premiumSource !== "current" || !current)
    return runtime.state.capturedPremium;
  return current;
}

async function reconcileEnabledSession(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  config: DownshiftConfig,
): Promise<boolean> {
  const needsPremium =
    config.handoffBeforeDownshift ||
    !thresholdReached(ctx.getContextUsage(), config.threshold);
  if (!needsPremium) {
    return switchToTarget(pi, ctx, config.economy, "economy", "resumed");
  }
  const premium = resolvePremiumTarget(config);
  if (!premium) return pause(pi, ctx, "premium target is unset");
  const switched = await switchToTarget(
    pi,
    ctx,
    premium,
    "premium",
    "resumed",
  );
  if (!switched) return false;
  await maybeDownshift(
    coreDeps(pi, ctx),
    runtime,
    ctx,
    ctx.isIdle() ? "immediate" : "steer",
  );
  return !runtime.state.paused;
}

async function handleSessionStart(
  pi: ExtensionAPI,
  event: { reason?: string },
  ctx: ExtensionContext,
): Promise<void> {
  const hadState = restoreState(ctx);
  const config = await readConfig();
  if (!hadState) await initializeSessionState(pi, event, ctx, config);
  updateStatus(ctx, config);
}

async function initializeSessionState(
  pi: ExtensionAPI,
  event: { reason?: string },
  ctx: ExtensionContext,
  config: DownshiftConfig | undefined,
): Promise<void> {
  const current = getActiveTarget(pi, ctx);
  runtime.state = initialSessionState(ctx, current);
  saveState(pi);
  if (shouldStartOnPremium(config, event, ctx)) {
    await switchToTarget(pi, ctx, config.premium, "premium", "started");
  }
}

function initialSessionState(
  ctx: ExtensionContext,
  current: ModelTarget | undefined,
): DownshiftState {
  return {
    sessionId: ctx.sessionManager.getSessionId(),
    sessionMode: "inherit",
    paused: false,
    position: "premium",
    handoff: "idle",
    continueAfterHandoff: false,
    capturedPremium: current,
  };
}

function shouldStartOnPremium(
  config: DownshiftConfig | undefined,
  event: { reason?: string },
  ctx: ExtensionContext,
): config is DownshiftConfig & { premium: ModelTarget } {
  return (
    hasExplicitStartPremium(config) &&
    event.reason !== "resume" &&
    !thresholdReached(ctx.getContextUsage(), config.threshold)
  );
}

function hasExplicitStartPremium(
  config: DownshiftConfig | undefined,
): config is DownshiftConfig & { premium: ModelTarget } {
  return !!config?.enabled && config.startOnPremium && !!config.premium;
}

export default function downshift(pi: ExtensionAPI): void {
  pi.on("session_start", async (event, ctx) => {
    await handleSessionStart(pi, event, ctx);
  });

  pi.on("context", async (_event, ctx) => {
    await maybeDownshift(
      coreDeps(pi, ctx),
      runtime,
      ctx,
      ctx.isIdle() ? "immediate" : "steer",
    );
  });

  pi.on("turn_end", async (_event, ctx) => {
    await refreshStatus(ctx);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    await refreshStatus(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    await handleBeforeAgentStart(coreDeps(pi, ctx), runtime, event, ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    await handleAgentEnd(coreDeps(pi, ctx), runtime, _event, ctx);
  });

  pi.on("session_compact", async (event, ctx) => {
    await maybeUpshiftAfterCompaction(coreDeps(pi, ctx), runtime, event);
  });

  pi.on("model_select", async (event, ctx) => {
    if (internalTargetChange) return;
    await handleManualModelSelect(coreDeps(pi, ctx), runtime, event, ctx);
  });

  pi.on("thinking_level_select", async (event, ctx) => {
    if (internalTargetChange) return;
    await handleManualThinkingLevelSelect(
      coreDeps(pi, ctx),
      runtime,
      event,
      ctx,
    );
  });

  pi.registerCommand("downshift", {
    description: "Configure automatic model downshifting by context threshold",
    handler: async (args, ctx) => {
      const command = args.trim();
      if (!command) return configure(ctx);
      await runDownshiftCommand(pi, ctx, command);
    },
  });
}
