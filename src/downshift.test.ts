import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const fsMocks = vi.hoisted(() => ({
  config: {
    enabled: true,
    threshold: { percent: 50 },
    economy: { provider: "test", model: "economy", thinkingLevel: "off" },
    premiumSource: "current",
    startOnPremium: false,
    upshiftAfterCompaction: false,
    handoffBeforeDownshift: true,
  },
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  readFile: fsMocks.readFile,
  writeFile: fsMocks.writeFile,
}));

import downshift from "./downshift";

type EventHandler = (
  event: unknown,
  ctx: ExtensionContext,
) => void | Promise<void>;

type CommandHandler = (
  args: string,
  ctx: ExtensionCommandContext,
) => void | Promise<void>;

type TestExtension = {
  handlers: Map<string, EventHandler>;
  commands: Map<string, CommandHandler>;
  pi: ExtensionAPI;
};

function createExtension(): TestExtension {
  const handlers = new Map<string, EventHandler>();
  const commands = new Map<string, CommandHandler>();
  const pi = {
    on: (event: string, handler: EventHandler) => {
      handlers.set(event, handler);
    },
    registerCommand: (name: string, options: { handler: CommandHandler }) => {
      commands.set(name, options.handler);
    },
    appendEntry: vi.fn(),
    sendUserMessage: vi.fn(),
    setModel: vi.fn(),
    setThinkingLevel: vi.fn(),
  } as unknown as ExtensionAPI;
  downshift(pi);
  return { handlers, commands, pi };
}

function createContext(usage: {
  current: { tokens: number; percent: number };
}) {
  const status = vi.fn();
  const select = vi.fn();
  const input = vi.fn();
  const ctx = {
    hasUI: true,
    getContextUsage: () => usage.current,
    ui: {
      setStatus: status,
      select,
      input,
      notify: vi.fn(),
    },
  };
  return {
    commandContext: ctx as unknown as ExtensionCommandContext,
    context: ctx as unknown as ExtensionContext,
    input,
    select,
    status,
  };
}

describe("downshift lifecycle adapter", () => {
  beforeEach(() => {
    fsMocks.readFile.mockClear();
    fsMocks.writeFile.mockClear();
    fsMocks.readFile.mockImplementation(async () =>
      JSON.stringify(fsMocks.config),
    );
    fsMocks.writeFile.mockResolvedValue(undefined);
  });

  it("refreshes status at turn_end and agent_settled without downshifting", async () => {
    const usage = { current: { tokens: 100, percent: 10 } };
    const { handlers, pi } = createExtension();
    const { context, status } = createContext(usage);

    await handlers.get("turn_end")?.({}, context);
    expect(status).toHaveBeenLastCalledWith(
      "downshift",
      "⇣ premium (40% left)",
    );

    usage.current = { tokens: 200, percent: 20 };
    await handlers.get("agent_settled")?.({}, context);
    expect(status).toHaveBeenLastCalledWith(
      "downshift",
      "⇣ premium (30% left)",
    );
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(pi.setModel).not.toHaveBeenCalled();
  });

  it("registers a thinking level select handler", () => {
    const { handlers } = createExtension();

    expect(handlers.has("thinking_level_select")).toBe(true);
  });

  it("refreshes status immediately after saving configuration", async () => {
    const usage = { current: { tokens: 100, percent: 10 } };
    const { commands } = createExtension();
    const { commandContext, select, input, status } = createContext(usage);
    select
      .mockResolvedValueOnce("threshold: 50%")
      .mockResolvedValueOnce("percent")
      .mockResolvedValueOnce(undefined);
    input.mockResolvedValueOnce("60");

    await commands.get("downshift")?.("", commandContext);

    expect(fsMocks.writeFile).toHaveBeenCalledOnce();
    expect(status).toHaveBeenLastCalledWith(
      "downshift",
      "⇣ premium (50% left)",
    );
    expect(fsMocks.writeFile.mock.invocationCallOrder[0]).toBeLessThan(
      status.mock.invocationCallOrder[0],
    );
  });
});
