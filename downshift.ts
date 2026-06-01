import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Model, ThinkingLevel } from "@earendil-works/pi-ai";
import type { ContextUsage, ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { resolveModelScope } from "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/model-resolver.js";

type ModelTarget = {
	provider: string;
	model: string;
	thinkingLevel: ThinkingLevel;
};

type Threshold = {
	tokens?: number;
	percent?: number;
};

type DownshiftConfig = {
	enabled: boolean;
	threshold: Threshold;
	economy: ModelTarget;
	premiumSource: "current" | "explicit";
	premium?: ModelTarget;
	startOnPremium: boolean;
	upshiftAfterCompaction: boolean;
};

type DownshiftState = {
	sessionId?: string;
	sessionEnabled: boolean;
	paused: boolean;
	position: "premium" | "economy";
	capturedPremium?: ModelTarget;
	lastError?: string;
};

type StateEntry = Partial<DownshiftState> & { version?: number };

const CONFIG_PATH = join(getAgentDir(), "downshift.json");
const SETTINGS_PATH = join(getAgentDir(), "settings.json");
const CUSTOM_TYPE = "downshift-state";

let state: DownshiftState = {
	sessionEnabled: true,
	paused: false,
	position: "premium",
};
let internalModelChange = false;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toPositiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function parseTarget(value: unknown): ModelTarget | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.provider !== "string" || !value.provider) return undefined;
	if (typeof value.model !== "string" || !value.model) return undefined;
	if (typeof value.thinkingLevel !== "string" || !value.thinkingLevel) return undefined;
	return { provider: value.provider, model: value.model, thinkingLevel: value.thinkingLevel as ThinkingLevel };
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
		};
	} catch {
		return undefined;
	}
}

async function writeConfig(config: DownshiftConfig): Promise<void> {
	await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function readEnabledModelPatterns(): Promise<string[] | undefined> {
	try {
		const raw = JSON.parse(await readFile(SETTINGS_PATH, "utf8")) as { enabledModels?: unknown };
		if (Array.isArray(raw.enabledModels) && raw.enabledModels.every((value) => typeof value === "string")) {
			return raw.enabledModels.length > 0 ? raw.enabledModels : undefined;
		}
	} catch {
		// Missing or unreadable settings.
	}
	return undefined;
}

async function getSelectableModels(ctx: Pick<ExtensionCommandContext, "modelRegistry">): Promise<Model<any>[]> {
	ctx.modelRegistry.refresh();
	const patterns = await readEnabledModelPatterns();
	if (!patterns) return ctx.modelRegistry.getAvailable();
	const scoped = await resolveModelScope(patterns, ctx.modelRegistry);
	return scoped.map((item) => item.model);
}

function currentTarget(ctx: Pick<ExtensionContext, "model">): ModelTarget | undefined {
	if (!ctx.model) return undefined;
	return {
		provider: ctx.model.provider,
		model: ctx.model.id,
		thinkingLevel: "off" as ThinkingLevel,
	};
}

function targetLabel(target: ModelTarget | undefined): string {
	return target ? `${target.provider}/${target.model}:${target.thinkingLevel}` : "unset";
}

function formatThreshold(threshold: Threshold): string {
	const parts = [];
	if (threshold.tokens) parts.push(`${threshold.tokens.toLocaleString("en-US")} tokens`);
	if (threshold.percent) parts.push(`${threshold.percent}%`);
	return parts.join(" or ");
}

function thresholdReached(usage: ContextUsage | undefined, threshold: Threshold): boolean {
	if (!usage) return false;
	if (threshold.tokens && usage.tokens !== null && usage.tokens >= threshold.tokens) return true;
	if (threshold.percent && usage.percent !== null && usage.percent >= threshold.percent) return true;
	return false;
}

function belowThreshold(usage: ContextUsage | undefined, threshold: Threshold): boolean {
	if (!usage) return false;
	if (threshold.tokens && (usage.tokens === null || usage.tokens >= threshold.tokens)) return false;
	if (threshold.percent && (usage.percent === null || usage.percent >= threshold.percent)) return false;
	return true;
}

function formatCompactNumber(value: number): string {
	const absolute = Math.abs(value);
	if (absolute >= 1_000_000) return `${Math.round(value / 1_000_000)}m`;
	if (absolute >= 1_000) return `${Math.round(value / 1_000)}k`;
	return `${Math.round(value)}`;
}

function statusText(config: DownshiftConfig | undefined, usage: ContextUsage | undefined): string {
	if (!config?.enabled || !state.sessionEnabled) return "⇣ off";
	if (state.paused) return "⇣ paused";
	if (state.position === "economy") return "⇣ eco";

	const parts: string[] = [];
	if (config.threshold.tokens !== undefined && usage?.tokens !== null && usage?.tokens !== undefined) {
		const tokensLeft = Math.max(0, config.threshold.tokens - usage.tokens);
		parts.push(formatCompactNumber(tokensLeft));
	}
	if (config.threshold.percent !== undefined && usage?.percent !== null && usage?.percent !== undefined) {
		const percentLeft = Math.max(0, config.threshold.percent - usage.percent);
		parts.push(`${Math.round(percentLeft)}%`);
	}

	if (parts.length === 0) return "⇣ ? → eco";
	return `⇣ ${parts.join(" / ")} → eco`;
}

function updateStatus(ctx: ExtensionContext, config?: DownshiftConfig): void {
	ctx.ui.setStatus("downshift", statusText(config, ctx.getContextUsage()));
}

function appendState(pi: ExtensionAPI): void {
	pi.appendEntry<StateEntry>(CUSTOM_TYPE, { version: 1, ...state });
}

function restoreState(ctx: ExtensionContext): boolean {
	const entries = ctx.sessionManager.getEntries();
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry.type !== "custom" || entry.customType !== CUSTOM_TYPE || !isRecord(entry.data)) continue;
		const data = entry.data as StateEntry;
		state = {
			sessionId: typeof data.sessionId === "string" ? data.sessionId : ctx.sessionManager.getSessionId(),
			sessionEnabled: data.sessionEnabled !== false,
			paused: data.paused === true,
			position: data.position === "economy" ? "economy" : "premium",
			capturedPremium: parseTarget(data.capturedPremium),
			lastError: typeof data.lastError === "string" ? data.lastError : undefined,
		};
		return true;
	}
	return false;
}

async function validateAndSwitch(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	target: ModelTarget,
	position: "premium" | "economy",
	reason: string,
): Promise<boolean> {
	const model = ctx.modelRegistry.find(target.provider, target.model);
	if (!model) return pauseWithError(pi, ctx, `model not found: ${targetLabel(target)}`);
	const levels = getSupportedThinkingLevels(model);
	if (!levels.includes(target.thinkingLevel)) {
		return pauseWithError(pi, ctx, `thinking level unsupported: ${targetLabel(target)}`);
	}
	try {
		internalModelChange = true;
		const ok = await pi.setModel(model);
		if (!ok) return pauseWithError(pi, ctx, `no API key for ${target.provider}/${target.model}`);
		pi.setThinkingLevel(target.thinkingLevel);
		state.position = position;
		state.lastError = undefined;
		appendState(pi);
		ctx.ui.notify(`downshift: ${reason} to ${targetLabel(target)}`, "info");
		return true;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return pauseWithError(pi, ctx, message);
	} finally {
		internalModelChange = false;
	}
}

function pauseWithError(pi: ExtensionAPI, ctx: ExtensionContext, message: string): false {
	state.paused = true;
	state.lastError = message;
	appendState(pi);
	ctx.ui.notify(`downshift paused: ${message}`, "error");
	ctx.ui.setStatus("downshift", "⇣ paused");
	return false;
}

function getPremiumTarget(config: DownshiftConfig): ModelTarget | undefined {
	return config.premiumSource === "explicit" ? config.premium : state.capturedPremium;
}

async function maybeDownshift(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const config = await readConfig();
	updateStatus(ctx, config);
	if (!config?.enabled || !state.sessionEnabled || state.paused || state.position === "economy") return;
	if (!thresholdReached(ctx.getContextUsage(), config.threshold)) return;
	await validateAndSwitch(pi, ctx, config.economy, "economy", "switched");
	updateStatus(ctx, config);
}

async function maybeUpshift(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const config = await readConfig();
	updateStatus(ctx, config);
	if (!config?.enabled || !config.upshiftAfterCompaction || !state.sessionEnabled || state.paused) return;
	if (state.position !== "economy") return;
	if (!belowThreshold(ctx.getContextUsage(), config.threshold)) return;
	const premium = getPremiumTarget(config);
	if (!premium) {
		pauseWithError(pi, ctx, "premium target is unset");
		return;
	}
	await validateAndSwitch(pi, ctx, premium, "premium", "upshifted");
	updateStatus(ctx, config);
}

async function selectTarget(ctx: ExtensionCommandContext, title: string, current?: ModelTarget): Promise<ModelTarget | undefined> {
	const models = (await getSelectableModels(ctx)).slice().sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
	if (models.length === 0) {
		ctx.ui.notify("No models available", "error");
		return undefined;
	}
	const selected = await ctx.ui.select(current ? `${title} (current: ${targetLabel(current)})` : title, models.map((model) => `${model.provider}/${model.id}`));
	if (!selected) return undefined;
	const slash = selected.indexOf("/");
	const provider = selected.slice(0, slash);
	const modelId = selected.slice(slash + 1);
	const model = models.find((item) => item.provider === provider && item.id === modelId);
	if (!model) return undefined;
	const levels = getSupportedThinkingLevels(model);
	const selectedLevel = await ctx.ui.select("Select thinking level", levels);
	if (!selectedLevel) return undefined;
	return { provider, model: modelId, thinkingLevel: selectedLevel };
}

async function promptNumber(ctx: ExtensionCommandContext, title: string, placeholder: string): Promise<number | undefined> {
	const raw = await ctx.ui.input(title, placeholder);
	if (!raw?.trim()) return undefined;
	const value = Number(raw.replace(/,/g, ""));
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

async function configure(ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) return;
	const previous = await readConfig();
	const enabled = await ctx.ui.confirm("Downshift", "Enable downshift?");
	const thresholdMode = await ctx.ui.select("Threshold", ["tokens", "percent", "both"]);
	if (!thresholdMode) return;
	const threshold: Threshold = {};
	if (thresholdMode === "tokens" || thresholdMode === "both") {
		const tokens = await promptNumber(ctx, "Token threshold", previous?.threshold.tokens?.toString() ?? "100000");
		if (!tokens) return ctx.ui.notify("Invalid token threshold", "error");
		threshold.tokens = tokens;
	}
	if (thresholdMode === "percent" || thresholdMode === "both") {
		const percent = await promptNumber(ctx, "Percent threshold", previous?.threshold.percent?.toString() ?? "60");
		if (!percent) return ctx.ui.notify("Invalid percent threshold", "error");
		threshold.percent = percent;
	}
	const economy = await selectTarget(ctx, "Select economy model", previous?.economy);
	if (!economy) return;
	const premiumMode = await ctx.ui.select("Premium source", ["current session model", "explicit premium model"]);
	if (!premiumMode) return;
	const premiumSource = premiumMode === "explicit premium model" ? "explicit" : "current";
	const premium = premiumSource === "explicit" ? await selectTarget(ctx, "Select premium model", previous?.premium) : undefined;
	if (premiumSource === "explicit" && !premium) return;
	const startOnPremium = await ctx.ui.confirm("Start on premium", "Switch fresh sessions to premium automatically?");
	const upshiftAfterCompaction = await ctx.ui.confirm("Upshift", "Upshift after compaction when below threshold?");
	await writeConfig({ enabled, threshold, economy, premiumSource, premium, startOnPremium, upshiftAfterCompaction });
	ctx.ui.notify("downshift config saved", "info");
}

function formatUsage(usage: ContextUsage | undefined): string {
	if (!usage) return "unknown";
	const tokens = usage.tokens === null ? "unknown" : usage.tokens.toLocaleString("en-US");
	const percent = usage.percent === null ? "unknown" : `${Math.round(usage.percent)}%`;
	return `${tokens} tokens (${percent})`;
}

function formatRemaining(usage: ContextUsage | undefined, threshold: Threshold): string {
	if (!usage) return "unknown";
	const parts: string[] = [];
	if (threshold.tokens !== undefined) {
		if (usage.tokens === null) {
			parts.push(`?/${threshold.tokens.toLocaleString("en-US")}`);
		} else {
			parts.push(`${formatCompactNumber(Math.max(0, threshold.tokens - usage.tokens))} left`);
		}
	}
	if (threshold.percent !== undefined) {
		if (usage.percent === null) {
			parts.push(`?/${threshold.percent}%`);
		} else {
			parts.push(`${Math.max(0, Math.round(threshold.percent - usage.percent))}% left`);
		}
	}
	return parts.length > 0 ? parts.join(" / ") : "unknown";
}

async function showStatus(ctx: ExtensionCommandContext): Promise<void> {
	const config = await readConfig();
	const usage = ctx.getContextUsage();
	const lines = [
		`mode: ${statusText(config, usage)}`,
		`usage: ${formatUsage(usage)}`,
		`remaining: ${config ? formatRemaining(usage, config.threshold) : "unset"}`,
		`threshold: ${config ? formatThreshold(config.threshold) : "unset"}`,
		`premium: ${config ? targetLabel(getPremiumTarget(config)) : "unset"}`,
		`economy: ${config ? targetLabel(config.economy) : "unset"}`,
		`upshift: ${config?.upshiftAfterCompaction ? "on" : "off"}`,
		`source: ${config?.premiumSource ?? "current"}`,
		`commands: /downshift status | on | off | config`,
	];
	if (state.lastError) lines.push(`last error: ${state.lastError}`);
	ctx.ui.notify(lines.join("\n"), "info");
}

export default function downshift(pi: ExtensionAPI): void {
	pi.on("session_start", async (event, ctx) => {
		const hadState = restoreState(ctx);
		const config = await readConfig();
		if (!hadState) {
			const current = currentTarget(ctx);
			state = {
				sessionId: ctx.sessionManager.getSessionId(),
				sessionEnabled: true,
				paused: false,
				position: "premium",
				capturedPremium: current ? { ...current, thinkingLevel: pi.getThinkingLevel() } : undefined,
			};
			appendState(pi);
			if (config?.enabled && config.startOnPremium && config.premium && event.reason !== "resume" && !thresholdReached(ctx.getContextUsage(), config.threshold)) {
				await validateAndSwitch(pi, ctx, config.premium, "premium", "started");
			}
		}
		updateStatus(ctx, config);
	});

	pi.on("context", async (_event, ctx) => {
		await maybeDownshift(pi, ctx);
	});

	pi.on("session_compact", async (_event, ctx) => {
		await maybeUpshift(pi, ctx);
	});

	pi.on("model_select", async (event, ctx) => {
		if (internalModelChange || event.source === "restore") return;
		const config = await readConfig();
		if (!config?.enabled || !state.sessionEnabled) {
			updateStatus(ctx, config);
			return;
		}
		state.paused = true;
		state.position = "premium";
		state.lastError = "manual model change";
		appendState(pi);
		updateStatus(ctx, config);
	});

	pi.registerCommand("downshift", {
		description: "Configure automatic model downshifting by context threshold",
		handler: async (args, ctx) => {
			const command = args.trim() || "status";
			if (command === "config") return configure(ctx);
			if (command === "status") return showStatus(ctx);
			if (command === "off") {
				state.sessionEnabled = false;
				appendState(pi);
				updateStatus(ctx, await readConfig());
				ctx.ui.notify("downshift off for this session", "info");
				return;
			}
			if (command === "on") {
				state.sessionEnabled = true;
				state.paused = false;
				state.lastError = undefined;
				appendState(pi);
				await maybeDownshift(pi, ctx);
				updateStatus(ctx, await readConfig());
				ctx.ui.notify("downshift on for this session", "info");
				return;
			}
			ctx.ui.notify("Usage: /downshift status | on | off | config", "warning");
		},
	});
}
