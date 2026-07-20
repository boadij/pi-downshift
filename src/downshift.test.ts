import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Model, ThinkingLevel } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { DownshiftConfig, DownshiftState } from "./downshift-core";

const fsMocks = vi.hoisted(() => ({
  config: null as unknown,
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  readFile: fsMocks.readFile,
  writeFile: fsMocks.writeFile,
}));

import downshift from "./downshift";

type EventHandler = (
  event: any,
  ctx: ExtensionContext,
) => void | Promise<void>;

type CommandHandler = (
  args: string,
  ctx: ExtensionCommandContext,
) => void | Promise<void>;

type ActiveTarget = {
  model: Model<any>;
  thinkingLevel: string;
};

type TestExtension = {
  active: ActiveTarget;
  handlers: Map<string, EventHandler>;
  commands: Map<string, CommandHandler>;
  pi: ExtensionAPI;
  setModel: ReturnType<typeof vi.fn>;
  setThinkingLevel: ReturnType<typeof vi.fn>;
};

const models = [
  testModel("premium-old"),
  testModel("premium-new"),
  testModel("economy-old"),
  testModel("economy-new"),
];

const defaultConfig: DownshiftConfig = {
  enabled: true,
  threshold: { percent: 50 },
  economy: target("economy-old", "off"),
  premiumSource: "current",
  startOnPremium: false,
  upshiftAfterCompaction: false,
  handoffBeforeDownshift: true,
};

function testModel(id: string): Model<any> {
  return { provider: "test", id, reasoning: true } as Model<any>;
}

function target(model: string, thinkingLevel: string) {
  return { provider: "test", model, thinkingLevel };
}

function setConfig(patch: Partial<DownshiftConfig> = {}): void {
  fsMocks.config = {
    ...defaultConfig,
    ...patch,
    threshold: patch.threshold ?? defaultConfig.threshold,
    economy: patch.economy ?? defaultConfig.economy,
  } satisfies DownshiftConfig;
}

function createExtension(active: ActiveTarget): TestExtension {
  const handlers = new Map<string, EventHandler>();
  const commands = new Map<string, CommandHandler>();
  const setModel = vi.fn(async (model: Model<any>) => {
    active.model = model;
    return true;
  });
  const setThinkingLevel = vi.fn((level: ThinkingLevel) => {
    active.thinkingLevel = level;
  });
  const pi = {
    on: (event: string, handler: EventHandler) => {
      handlers.set(event, handler);
    },
    registerCommand: (name: string, options: { handler: CommandHandler }) => {
      commands.set(name, options.handler);
    },
    appendEntry: vi.fn(),
    sendUserMessage: vi.fn(),
    setModel,
    getThinkingLevel: () => active.thinkingLevel as ThinkingLevel,
    setThinkingLevel,
  } as unknown as ExtensionAPI;
  downshift(pi);
  return { active, handlers, commands, pi, setModel, setThinkingLevel };
}

function createContext(
  usage: { current: { tokens: number; percent: number } },
  active: ActiveTarget = {
    model: models[0],
    thinkingLevel: "off",
  },
  sessionEntries: unknown[] = [],
  branchEntries: unknown[] = [],
) {
  const status = vi.fn();
  const select = vi.fn();
  const input = vi.fn();
  const notify = vi.fn();
  const ctx = {
    hasUI: true,
    get model() {
      return active.model;
    },
    getContextUsage: () => usage.current,
    isIdle: () => true,
    modelRegistry: {
      find: (provider: string, id: string) =>
        models.find((model) => model.provider === provider && model.id === id),
      refresh: vi.fn(),
      getAvailable: () => models,
    },
    sessionManager: {
      getEntries: () => sessionEntries,
      getBranch: () => branchEntries,
      getSessionId: () => "test-session",
    },
    ui: {
      setStatus: status,
      select,
      input,
      notify,
    },
  };
  return {
    active,
    commandContext: ctx as unknown as ExtensionCommandContext,
    context: ctx as unknown as ExtensionContext,
    input,
    notify,
    select,
    status,
  };
}

function latestState(pi: ExtensionAPI): DownshiftState {
  const appendEntry = vi.mocked(pi.appendEntry);
  return appendEntry.mock.calls.at(-1)?.[1] as DownshiftState;
}

async function pauseDownshift(
  extension: TestExtension,
  context: ExtensionContext,
): Promise<void> {
  await extension.handlers.get("session_start")?.({ reason: "new" }, context);
  await extension.handlers
    .get("model_select")
    ?.({ source: "cycle" }, context);
  expect(latestState(extension.pi).paused).toBe(true);
  extension.setModel.mockClear();
  extension.setThinkingLevel.mockClear();
  vi.mocked(extension.pi.sendUserMessage).mockClear();
}

describe("downshift lifecycle adapter", () => {
  beforeEach(() => {
    setConfig();
    fsMocks.readFile.mockClear();
    fsMocks.writeFile.mockClear();
    fsMocks.readFile.mockImplementation(async () =>
      JSON.stringify(fsMocks.config),
    );
    fsMocks.writeFile.mockResolvedValue(undefined);
  });

  it("refreshes status at turn_end and agent_settled without downshifting", async () => {
    const usage = { current: { tokens: 100, percent: 10 } };
    const fixture = createContext(usage);
    const { handlers, pi } = createExtension(fixture.active);

    await handlers.get("turn_end")?.({}, fixture.context);
    expect(fixture.status).toHaveBeenLastCalledWith(
      "downshift",
      "⇣ premium (40% left)",
    );

    usage.current = { tokens: 200, percent: 20 };
    await handlers.get("agent_settled")?.({}, fixture.context);
    expect(fixture.status).toHaveBeenLastCalledWith(
      "downshift",
      "⇣ premium (30% left)",
    );
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(pi.setModel).not.toHaveBeenCalled();
  });

  it("registers a thinking level select handler", () => {
    const fixture = createContext({ current: { tokens: 100, percent: 10 } });
    const { handlers } = createExtension(fixture.active);

    expect(handlers.has("thinking_level_select")).toBe(true);
  });

  it("registers a session tree handler", () => {
    const fixture = createContext({ current: { tokens: 100, percent: 10 } });
    const { handlers } = createExtension(fixture.active);

    expect(handlers.has("session_tree")).toBe(true);
  });

  it("reconciles the active branch phase after tree navigation", async () => {
    setConfig({
      premiumSource: "explicit",
      premium: target("premium-new", "high"),
      handoffBeforeDownshift: false,
    });
    const sessionEntries = [
      {
        type: "custom",
        customType: "downshift-state",
        data: {
          sessionId: "parent-session",
          sessionMode: "inherit",
          paused: false,
          position: "economy",
          handoff: "done",
        },
      },
    ];
    const branchEntries = [
      {
        type: "custom",
        customType: "downshift-state",
        data: { position: "economy", handoff: "done" },
      },
    ];
    const fixture = createContext(
      { current: { tokens: 100, percent: 10 } },
      { model: models[2], thinkingLevel: "off" },
      sessionEntries,
      branchEntries,
    );
    const extension = createExtension(fixture.active);

    await extension.handlers
      .get("session_start")
      ?.({ reason: "resume" }, fixture.context);
    expect(extension.setModel).not.toHaveBeenCalled();

    branchEntries.splice(0, branchEntries.length, {
      type: "custom",
      customType: "downshift-state",
      data: { position: "premium", handoff: "done" },
    });
    await extension.handlers.get("session_tree")?.({}, fixture.context);

    expect(extension.setModel).toHaveBeenCalledOnce();
    expect(extension.setModel).toHaveBeenCalledWith(models[1]);
    expect(extension.setThinkingLevel).toHaveBeenCalledWith("high");
    expect(extension.pi.sendUserMessage).not.toHaveBeenCalled();
    expect(fixture.notify).toHaveBeenCalledWith(
      "downshift: restored branch to test/premium-new:high",
      "info",
    );
  });

  it("reconciles from a premium branch to an economy branch", async () => {
    setConfig({
      premiumSource: "explicit",
      premium: target("premium-new", "high"),
      handoffBeforeDownshift: false,
    });
    const premiumEntry = {
      type: "custom",
      customType: "downshift-state",
      data: { position: "premium", handoff: "idle" },
    };
    const economyEntry = {
      type: "custom",
      customType: "downshift-state",
      data: { position: "economy", handoff: "done" },
    };
    const fixture = createContext(
      { current: { tokens: 100, percent: 10 } },
      { model: models[1], thinkingLevel: "high" },
      [premiumEntry],
      [premiumEntry],
    );
    const extension = createExtension(fixture.active);

    await extension.handlers
      .get("session_start")
      ?.({ reason: "resume" }, fixture.context);
    fixture.context.sessionManager.getBranch = () => [economyEntry] as any;

    await extension.handlers.get("session_tree")?.({}, fixture.context);

    expect(extension.setModel).toHaveBeenCalledWith(models[2]);
    expect(extension.setThinkingLevel).toHaveBeenCalledWith("off");
    expect(extension.pi.sendUserMessage).not.toHaveBeenCalled();
    expect(latestState(extension.pi)).toMatchObject({
      position: "economy",
      handoff: "done",
      continueAfterHandoff: false,
    });
  });

  it("pauses when a source handoff is pending during tree navigation", async () => {
    setConfig({ handoffBeforeDownshift: true });
    const premiumEntry = {
      type: "custom",
      customType: "downshift-state",
      data: { position: "premium", handoff: "idle" },
    };
    const economyEntry = {
      type: "custom",
      customType: "downshift-state",
      data: { position: "economy", handoff: "done" },
    };
    const fixture = createContext(
      { current: { tokens: 100, percent: 10 } },
      { model: models[0], thinkingLevel: "off" },
      [premiumEntry],
      [premiumEntry],
    );
    const extension = createExtension(fixture.active);

    await extension.handlers
      .get("session_start")
      ?.({ reason: "resume" }, fixture.context);
    await extension.commands.get("downshift")?.("now", fixture.commandContext);
    extension.setModel.mockClear();
    extension.setThinkingLevel.mockClear();
    vi.mocked(extension.pi.sendUserMessage).mockClear();
    fixture.context.sessionManager.getBranch = () => [economyEntry] as any;

    await extension.handlers.get("session_tree")?.({}, fixture.context);

    expect(latestState(extension.pi)).toMatchObject({
      paused: true,
      handoff: "done",
      continueAfterHandoff: false,
      lastError: "handoff interrupted by tree navigation",
    });
    expect(extension.setModel).not.toHaveBeenCalled();
    expect(extension.setThinkingLevel).not.toHaveBeenCalled();
    expect(extension.pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it.each(["requested", "active"] as const)(
    "pauses when the destination has an interrupted %s handoff",
    async (handoff) => {
      setConfig({ handoffBeforeDownshift: true });
      const premiumEntry = {
        type: "custom",
        customType: "downshift-state",
        data: { position: "premium", handoff: "idle" },
      };
      const interruptedEntry = {
        type: "custom",
        customType: "downshift-state",
        data: { position: "premium", handoff },
      };
      const fixture = createContext(
        { current: { tokens: 100, percent: 10 } },
        { model: models[0], thinkingLevel: "off" },
        [premiumEntry],
        [premiumEntry],
      );
      const extension = createExtension(fixture.active);

      await extension.handlers
        .get("session_start")
        ?.({ reason: "resume" }, fixture.context);
      extension.setModel.mockClear();
      extension.setThinkingLevel.mockClear();
      vi.mocked(extension.pi.sendUserMessage).mockClear();
      fixture.context.sessionManager.getBranch = () => [interruptedEntry] as any;

      await extension.handlers.get("session_tree")?.({}, fixture.context);

      expect(latestState(extension.pi)).toMatchObject({
        paused: true,
        handoff: "idle",
        continueAfterHandoff: false,
        lastError: "handoff interrupted by tree navigation",
      });
      expect(extension.setModel).not.toHaveBeenCalled();
      expect(extension.setThinkingLevel).not.toHaveBeenCalled();
      expect(extension.pi.sendUserMessage).not.toHaveBeenCalled();
    },
  );

  it("defaults an untracked branch to premium after tree navigation", async () => {
    setConfig({
      premiumSource: "explicit",
      premium: target("premium-new", "high"),
      handoffBeforeDownshift: false,
    });
    const sessionEntries = [
      {
        type: "custom",
        customType: "downshift-state",
        data: { position: "economy", handoff: "done" },
      },
    ];
    const fixture = createContext(
      { current: { tokens: 100, percent: 10 } },
      { model: models[2], thinkingLevel: "off" },
      sessionEntries,
      [
        {
          type: "custom",
          customType: "downshift-state",
          data: { position: "economy", handoff: "done" },
        },
      ],
    );
    const extension = createExtension(fixture.active);

    await extension.handlers
      .get("session_start")
      ?.({ reason: "resume" }, fixture.context);
    fixture.active.model = models[2];
    fixture.active.thinkingLevel = "off";
    extension.setModel.mockClear();
    extension.setThinkingLevel.mockClear();

    const branch = fixture.context.sessionManager.getBranch() as unknown[];
    branch.splice(0, branch.length);

    await extension.handlers.get("session_tree")?.({}, fixture.context);

    expect(extension.setModel).toHaveBeenCalledWith(models[1]);
    expect(extension.setThinkingLevel).toHaveBeenCalledWith("high");
    expect(extension.pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it.each(["reload", "resume", "fork", "clone"])(
    "reconciles an existing branch during %s session start",
    async (reason) => {
      setConfig({
        premiumSource: "explicit",
        premium: target("premium-new", "high"),
        handoffBeforeDownshift: false,
      });
      const stateEntry = {
        type: "custom",
        customType: "downshift-state",
        data: { sessionId: "parent-session", position: "premium", handoff: "idle" },
      };
      const fixture = createContext(
        { current: { tokens: 100, percent: 90 } },
        { model: models[2], thinkingLevel: "off" },
        [stateEntry],
        [stateEntry],
      );
      const extension = createExtension(fixture.active);

      await extension.handlers.get("session_start")?.(
        { reason } as any,
        fixture.context,
      );

      expect(extension.setModel).toHaveBeenCalledWith(models[1]);
      expect(extension.setThinkingLevel).toHaveBeenCalledWith("high");
      expect(extension.pi.sendUserMessage).not.toHaveBeenCalled();
      expect(fixture.notify).not.toHaveBeenCalledWith(
        expect.stringContaining("preparing handoff"),
        expect.anything(),
      );
    },
  );

  it("keeps fresh session startup behavior when no state exists", async () => {
    setConfig({
      premiumSource: "explicit",
      premium: target("premium-new", "high"),
      startOnPremium: true,
    });
    const fixture = createContext(
      { current: { tokens: 100, percent: 10 } },
      { model: models[0], thinkingLevel: "off" },
    );
    const extension = createExtension(fixture.active);

    await extension.handlers
      .get("session_start")
      ?.({ reason: "new" }, fixture.context);

    expect(extension.setModel).toHaveBeenCalledWith(models[1]);
    expect(extension.setThinkingLevel).toHaveBeenCalledWith("high");
  });

  it.each([
    ["disabled", { enabled: false }, { sessionMode: "inherit" }],
    ["off", {}, { sessionMode: "off" }],
    ["paused", {}, { paused: true }],
  ] as const)("does not switch a %s destination branch", async (_name, configPatch, statePatch) => {
    setConfig({
      ...configPatch,
      premiumSource: "explicit",
      premium: target("premium-new", "high"),
      handoffBeforeDownshift: false,
    });
    const stateEntry = {
      type: "custom",
      customType: "downshift-state",
      data: { position: "economy", handoff: "done", ...statePatch },
    };
    const destinationEntry = {
      type: "custom",
      customType: "downshift-state",
      data: { position: "premium", handoff: "idle" },
    };
    const fixture = createContext(
      { current: { tokens: 100, percent: 10 } },
      { model: models[2], thinkingLevel: "off" },
      [stateEntry],
      [destinationEntry],
    );
    const extension = createExtension(fixture.active);

    await extension.handlers
      .get("session_start")
      ?.({ reason: "resume" }, fixture.context);
    extension.setModel.mockClear();
    extension.setThinkingLevel.mockClear();
    vi.mocked(extension.pi.sendUserMessage).mockClear();

    await extension.handlers.get("session_tree")?.({}, fixture.context);

    expect(extension.setModel).not.toHaveBeenCalled();
    expect(extension.setThinkingLevel).not.toHaveBeenCalled();
    expect(extension.pi.sendUserMessage).not.toHaveBeenCalled();
    if (_name === "paused") {
      expect(fixture.status).toHaveBeenLastCalledWith("downshift", "⇣ paused");
    }
  });

  it("does not generate a handoff while restoring a branch", async () => {
    setConfig({
      premiumSource: "explicit",
      premium: target("premium-new", "high"),
      handoffBeforeDownshift: true,
    });
    const economyEntry = {
      type: "custom",
      customType: "downshift-state",
      data: { position: "economy", handoff: "done" },
    };
    const premiumEntry = {
      type: "custom",
      customType: "downshift-state",
      data: { position: "premium", handoff: "idle" },
    };
    const fixture = createContext(
      { current: { tokens: 100, percent: 90 } },
      { model: models[2], thinkingLevel: "off" },
      [economyEntry],
      [economyEntry],
    );
    const extension = createExtension(fixture.active);

    await extension.handlers
      .get("session_start")
      ?.({ reason: "resume" }, fixture.context);
    fixture.context.sessionManager.getBranch = () => [premiumEntry] as any;

    await extension.handlers.get("session_tree")?.({}, fixture.context);

    expect(extension.setModel).toHaveBeenCalledWith(models[1]);
    expect(extension.pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("preserves internal target changes during branch reconciliation", async () => {
    setConfig({
      premiumSource: "explicit",
      premium: target("premium-new", "high"),
      handoffBeforeDownshift: false,
    });
    const economyEntry = {
      type: "custom",
      customType: "downshift-state",
      data: { position: "economy", handoff: "done" },
    };
    const premiumEntry = {
      type: "custom",
      customType: "downshift-state",
      data: { position: "premium", handoff: "idle" },
    };
    const fixture = createContext(
      { current: { tokens: 100, percent: 90 } },
      { model: models[2], thinkingLevel: "off" },
      [economyEntry],
      [economyEntry],
    );
    const extension = createExtension(fixture.active);
    extension.setModel.mockImplementationOnce(async (model: Model<any>) => {
      const previousModel = fixture.active.model;
      fixture.active.model = model;
      await extension.handlers.get("model_select")?.(
        { model, previousModel, source: "set" },
        fixture.context,
      );
      return true;
    });
    extension.setThinkingLevel.mockImplementationOnce((level: ThinkingLevel) => {
      const previousLevel = fixture.active.thinkingLevel;
      fixture.active.thinkingLevel = level;
      void extension.handlers.get("thinking_level_select")?.(
        { level, previousLevel },
        fixture.context,
      );
    });

    await extension.handlers
      .get("session_start")
      ?.({ reason: "resume" }, fixture.context);
    fixture.context.sessionManager.getBranch = () => [premiumEntry] as any;

    await extension.handlers.get("session_tree")?.({}, fixture.context);

    expect(latestState(extension.pi)).toMatchObject({
      paused: false,
      position: "premium",
    });
    expect(fixture.notify).not.toHaveBeenCalledWith(
      "downshift paused: manual model change",
      "error",
    );
  });

  it("continues to downshift after restoring a premium branch", async () => {
    setConfig({
      premiumSource: "explicit",
      premium: target("premium-new", "high"),
      handoffBeforeDownshift: false,
    });
    const premiumEntry = {
      type: "custom",
      customType: "downshift-state",
      data: { position: "premium", handoff: "idle" },
    };
    const fixture = createContext(
      { current: { tokens: 100, percent: 90 } },
      { model: models[1], thinkingLevel: "high" },
      [premiumEntry],
      [premiumEntry],
    );
    const extension = createExtension(fixture.active);

    await extension.handlers
      .get("session_start")
      ?.({ reason: "resume" }, fixture.context);
    await extension.handlers.get("context")?.({}, fixture.context);

    expect(extension.setModel).toHaveBeenCalledWith(models[2]);
    expect(latestState(extension.pi)).toMatchObject({
      position: "economy",
      handoff: "done",
    });
  });

  it("continues to upshift after restoring an economy branch and compacting", async () => {
    setConfig({
      premiumSource: "explicit",
      premium: target("premium-new", "high"),
      upshiftAfterCompaction: true,
    });
    const economyEntry = {
      type: "custom",
      customType: "downshift-state",
      data: { position: "economy", handoff: "done" },
    };
    const fixture = createContext(
      { current: { tokens: 100, percent: 10 } },
      { model: models[2], thinkingLevel: "off" },
      [economyEntry],
      [economyEntry],
    );
    const extension = createExtension(fixture.active);

    await extension.handlers
      .get("session_start")
      ?.({ reason: "resume" }, fixture.context);
    await extension.handlers.get("session_compact")?.(
      { compactionEntry: {} },
      fixture.context,
    );

    expect(extension.setModel).toHaveBeenCalledWith(models[1]);
    expect(extension.setThinkingLevel).toHaveBeenCalledWith("high");
    expect(latestState(extension.pi)).toMatchObject({
      position: "premium",
      handoff: "idle",
    });
  });

  it("does nothing when branch reconciliation already matches the target", async () => {
    setConfig({
      premiumSource: "explicit",
      premium: target("premium-new", "high"),
      handoffBeforeDownshift: false,
    });
    const premiumEntry = {
      type: "custom",
      customType: "downshift-state",
      data: { position: "premium", handoff: "idle" },
    };
    const fixture = createContext(
      { current: { tokens: 100, percent: 10 } },
      { model: models[1], thinkingLevel: "high" },
      [premiumEntry],
      [premiumEntry],
    );
    const extension = createExtension(fixture.active);

    await extension.handlers
      .get("session_start")
      ?.({ reason: "resume" }, fixture.context);
    vi.mocked(extension.pi.appendEntry).mockClear();
    fixture.notify.mockClear();

    await extension.handlers.get("session_tree")?.({}, fixture.context);

    expect(extension.setModel).not.toHaveBeenCalled();
    expect(extension.setThinkingLevel).not.toHaveBeenCalled();
    expect(extension.pi.appendEntry).not.toHaveBeenCalled();
    expect(fixture.notify).not.toHaveBeenCalled();
  });

  it("opens configuration for the bare command", async () => {
    const usage = { current: { tokens: 100, percent: 10 } };
    const fixture = createContext(usage);
    const { commands } = createExtension(fixture.active);
    fixture.select
      .mockResolvedValueOnce("threshold: 50%")
      .mockResolvedValueOnce("percent")
      .mockResolvedValueOnce(undefined);
    fixture.input.mockResolvedValueOnce("60");

    await commands.get("downshift")?.("", fixture.commandContext);

    expect(fsMocks.writeFile).toHaveBeenCalledOnce();
    expect(fixture.status).toHaveBeenLastCalledWith(
      "downshift",
      "⇣ premium (50% left)",
    );
    expect(fsMocks.writeFile.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.status.mock.invocationCallOrder[0],
    );
  });

  it("warns with help for the unsupported config subcommand", async () => {
    const fixture = createContext({ current: { tokens: 100, percent: 10 } });
    const { commands } = createExtension(fixture.active);

    await commands.get("downshift")?.("config", fixture.commandContext);

    expect(fixture.notify).toHaveBeenCalledWith(
      expect.stringContaining("/downshift - configure Downshift"),
      "warning",
    );
    expect(fsMocks.writeFile).not.toHaveBeenCalled();
  });

  it("does not advertise the unsupported config subcommand in help or status", async () => {
    const fixture = createContext({ current: { tokens: 100, percent: 10 } });
    const { commands } = createExtension(fixture.active);

    await commands.get("downshift")?.("help", fixture.commandContext);
    expect(fixture.notify).toHaveBeenCalledWith(
      expect.not.stringContaining("/downshift config"),
      "info",
    );

    fixture.notify.mockClear();
    await commands.get("downshift")?.("status", fixture.commandContext);
    expect(fixture.notify).toHaveBeenCalledWith(
      expect.not.stringContaining("/downshift config"),
      "info",
    );
  });

  it("activates an updated explicit premium target below threshold", async () => {
    setConfig({
      premiumSource: "explicit",
      premium: target("premium-new", "high"),
    });
    const fixture = createContext(
      { current: { tokens: 100, percent: 10 } },
      { model: models[0], thinkingLevel: "low" },
    );
    const extension = createExtension(fixture.active);
    await pauseDownshift(extension, fixture.context);

    await extension.commands
      .get("downshift")
      ?.("on", fixture.commandContext);

    expect(extension.setModel).toHaveBeenCalledOnce();
    expect(extension.setModel).toHaveBeenCalledWith(models[1]);
    expect(extension.setThinkingLevel).toHaveBeenCalledOnce();
    expect(extension.setThinkingLevel).toHaveBeenCalledWith("high");
    expect(extension.pi.sendUserMessage).not.toHaveBeenCalled();
    expect(latestState(extension.pi)).toMatchObject({
      sessionMode: "on",
      paused: false,
      position: "premium",
      handoff: "idle",
    });
    expect(fixture.notify).toHaveBeenCalledWith(
      "downshift on for this session",
      "info",
    );
  });

  it("activates an updated economy target directly above threshold without handoff", async () => {
    setConfig({
      economy: target("economy-new", "medium"),
      handoffBeforeDownshift: false,
    });
    const fixture = createContext(
      { current: { tokens: 100, percent: 60 } },
      { model: models[0], thinkingLevel: "low" },
    );
    const extension = createExtension(fixture.active);
    await pauseDownshift(extension, fixture.context);

    await extension.commands
      .get("downshift")
      ?.("on", fixture.commandContext);

    expect(extension.setModel).toHaveBeenCalledOnce();
    expect(extension.setModel).toHaveBeenCalledWith(models[3]);
    expect(extension.setThinkingLevel).toHaveBeenCalledWith("medium");
    expect(extension.pi.sendUserMessage).not.toHaveBeenCalled();
    expect(latestState(extension.pi)).toMatchObject({
      paused: false,
      position: "economy",
      handoff: "idle",
    });
  });

  it("reconciles a changed economy target after disabling from economy", async () => {
    setConfig({ handoffBeforeDownshift: false });
    const fixture = createContext(
      { current: { tokens: 100, percent: 60 } },
      { model: models[0], thinkingLevel: "high" },
    );
    const extension = createExtension(fixture.active);

    await extension.handlers
      .get("session_start")
      ?.({ reason: "new" }, fixture.context);
    await extension.handlers.get("context")?.({}, fixture.context);
    expect(extension.setModel).toHaveBeenLastCalledWith(models[2]);
    expect(latestState(extension.pi)).toMatchObject({
      paused: false,
      position: "economy",
      handoff: "done",
    });

    await extension.commands
      .get("downshift")
      ?.("off", fixture.commandContext);
    expect(latestState(extension.pi)).toMatchObject({
      sessionMode: "off",
      position: "economy",
    });

    setConfig({
      economy: target("economy-new", "medium"),
      handoffBeforeDownshift: false,
    });
    extension.setModel.mockClear();
    extension.setThinkingLevel.mockClear();

    await extension.commands
      .get("downshift")
      ?.("on", fixture.commandContext);

    expect(extension.setModel).toHaveBeenCalledOnce();
    expect(extension.setModel).toHaveBeenCalledWith(models[3]);
    expect(extension.setThinkingLevel).toHaveBeenCalledWith("medium");
    expect(latestState(extension.pi)).toMatchObject({
      sessionMode: "on",
      paused: false,
      position: "economy",
      handoff: "idle",
    });
    expect(fixture.notify).toHaveBeenCalledWith(
      "downshift on for this session",
      "info",
    );
  });

  it("establishes updated premium before handing off to updated economy", async () => {
    setConfig({
      premiumSource: "explicit",
      premium: target("premium-new", "high"),
      economy: target("economy-new", "off"),
      handoffBeforeDownshift: true,
    });
    const fixture = createContext(
      { current: { tokens: 100, percent: 60 } },
      { model: models[0], thinkingLevel: "low" },
    );
    const extension = createExtension(fixture.active);
    await pauseDownshift(extension, fixture.context);

    await extension.commands
      .get("downshift")
      ?.("on", fixture.commandContext);

    expect(extension.setModel).toHaveBeenCalledTimes(1);
    expect(extension.setModel).toHaveBeenNthCalledWith(1, models[1]);
    expect(extension.pi.sendUserMessage).toHaveBeenCalledOnce();
    expect(latestState(extension.pi)).toMatchObject({
      paused: false,
      position: "premium",
      handoff: "requested",
    });

    await extension.handlers
      .get("before_agent_start")
      ?.({ prompt: "<!-- downshift:handoff:v1 -->" }, fixture.context);
    await extension.handlers.get("agent_end")?.({}, fixture.context);

    expect(extension.setModel).toHaveBeenCalledTimes(2);
    expect(extension.setModel).toHaveBeenNthCalledWith(2, models[3]);
    expect(latestState(extension.pi)).toMatchObject({
      paused: false,
      position: "economy",
      handoff: "done",
    });
  });

  it("captures the complete current premium target without redundant changes", async () => {
    setConfig({ premiumSource: "current" });
    const fixture = createContext(
      { current: { tokens: 100, percent: 10 } },
      { model: models[0], thinkingLevel: "high" },
    );
    const extension = createExtension(fixture.active);
    await pauseDownshift(extension, fixture.context);

    await extension.commands
      .get("downshift")
      ?.("on", fixture.commandContext);

    expect(extension.setModel).not.toHaveBeenCalled();
    expect(extension.setThinkingLevel).not.toHaveBeenCalled();
    expect(latestState(extension.pi)).toMatchObject({
      paused: false,
      position: "premium",
      capturedPremium: target("premium-old", "high"),
    });
  });

  it("is idempotent when repeatedly enabled on the configured target", async () => {
    setConfig({
      premiumSource: "explicit",
      premium: target("premium-old", "high"),
    });
    const fixture = createContext(
      { current: { tokens: 100, percent: 10 } },
      { model: models[0], thinkingLevel: "high" },
    );
    const extension = createExtension(fixture.active);

    await extension.commands
      .get("downshift")
      ?.("on", fixture.commandContext);
    await extension.commands
      .get("downshift")
      ?.("on", fixture.commandContext);

    expect(extension.setModel).not.toHaveBeenCalled();
    expect(extension.setThinkingLevel).not.toHaveBeenCalled();
    expect(extension.pi.sendUserMessage).not.toHaveBeenCalled();
    expect(latestState(extension.pi)).toMatchObject({
      paused: false,
      position: "premium",
      handoff: "idle",
    });
  });

  it("stays paused without success when a required explicit premium is missing", async () => {
    setConfig({
      premiumSource: "explicit",
      premium: undefined,
      handoffBeforeDownshift: true,
    });
    const fixture = createContext({ current: { tokens: 100, percent: 10 } });
    const extension = createExtension(fixture.active);

    await extension.commands
      .get("downshift")
      ?.("on", fixture.commandContext);

    expect(latestState(extension.pi)).toMatchObject({
      paused: true,
      lastError: "premium target is unset",
    });
    expect(fixture.notify).toHaveBeenCalledWith(
      "downshift paused: premium target is unset",
      "error",
    );
    expect(fixture.notify).not.toHaveBeenCalledWith(
      "downshift on for this session",
      "info",
    );
  });

  it("stays paused without success when model activation has no API key", async () => {
    setConfig({
      premiumSource: "explicit",
      premium: target("premium-new", "high"),
    });
    const fixture = createContext({ current: { tokens: 100, percent: 10 } });
    const extension = createExtension(fixture.active);
    extension.setModel.mockResolvedValueOnce(false);

    await extension.commands
      .get("downshift")
      ?.("on", fixture.commandContext);

    expect(latestState(extension.pi)).toMatchObject({
      paused: true,
      lastError: "no API key for test/premium-new",
    });
    expect(fixture.notify).not.toHaveBeenCalledWith(
      "downshift on for this session",
      "info",
    );
  });

  it("suppresses internally emitted target events but pauses on later manual changes", async () => {
    setConfig({
      premiumSource: "explicit",
      premium: target("premium-new", "high"),
    });
    const fixture = createContext(
      { current: { tokens: 100, percent: 10 } },
      { model: models[0], thinkingLevel: "low" },
    );
    const extension = createExtension(fixture.active);
    extension.setModel.mockImplementationOnce(async (model: Model<any>) => {
      const previousModel = fixture.active.model;
      fixture.active.model = model;
      await extension.handlers.get("model_select")?.(
        { model, previousModel, source: "set" },
        fixture.context,
      );
      return true;
    });
    extension.setThinkingLevel.mockImplementationOnce(
      (level: ThinkingLevel) => {
        const previousLevel = fixture.active.thinkingLevel;
        fixture.active.thinkingLevel = level;
        void extension.handlers.get("thinking_level_select")?.(
          { level, previousLevel },
          fixture.context,
        );
      },
    );

    await extension.commands
      .get("downshift")
      ?.("on", fixture.commandContext);

    expect(latestState(extension.pi)).toMatchObject({
      paused: false,
      position: "premium",
      lastError: undefined,
    });

    await extension.handlers
      .get("thinking_level_select")
      ?.({ level: "medium", previousLevel: "high" }, fixture.context);
    expect(latestState(extension.pi)).toMatchObject({
      paused: true,
      lastError: "manual thinking level change",
    });
  });
});
