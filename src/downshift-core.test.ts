import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  CONTINUE_MARKER,
  HANDOFF_MARKER,
  forceDownshiftNow,
  handleAgentEnd,
  handleBeforeAgentStart,
  handleManualModelSelect,
  maybeDownshift,
  maybeUpshiftAfterCompaction,
  restoreStateFromEntries,
  statusText,
  type DownshiftConfig,
  type DownshiftState,
  type ModelTarget,
} from "./downshift-core";

const economy: ModelTarget = {
  provider: "test",
  model: "economy",
  thinkingLevel: "off",
};

const premium: ModelTarget = {
  provider: "test",
  model: "premium",
  thinkingLevel: "medium",
};

const baseConfig: DownshiftConfig = {
  enabled: true,
  threshold: { percent: 50 },
  economy,
  premiumSource: "current",
  startOnPremium: false,
  upshiftAfterCompaction: false,
  handoffBeforeDownshift: true,
};

type TestDeps = {
  readConfig: Mock<() => Promise<DownshiftConfig | undefined>>;
  saveState: Mock<(state: DownshiftState) => void>;
  sendUserMessage: Mock<
    (
      prompt: string,
      options?: { deliverAs: "steer" | "followUp" },
    ) => Promise<void>
  >;
  switchToTarget: Mock<
    (
      target: ModelTarget,
      position: "premium" | "economy",
      reason: string,
    ) => Promise<boolean>
  >;
  updateStatus: Mock<() => void>;
  notify: Mock<(message: string, level?: string) => void>;
};

function createDeps(config = baseConfig): TestDeps {
  return {
    readConfig: vi.fn(async () => config),
    saveState: vi.fn(),
    sendUserMessage: vi.fn(async () => undefined),
    switchToTarget: vi.fn(async () => true),
    updateStatus: vi.fn(),
    notify: vi.fn(),
  };
}

function createState(patch: Partial<DownshiftState> = {}): DownshiftState {
  return {
    sessionMode: "inherit",
    paused: false,
    position: "premium",
    handoff: "idle",
    continueAfterHandoff: false,
    ...patch,
  };
}

const ctx = {
  getContextUsage: () => ({ tokens: 101, percent: 51 }),
};

describe("downshift core", () => {
  beforeEach(() => vi.clearAllMocks());

  function expectPendingHandoff(
    runtime: { state: ReturnType<typeof createState> },
    continueAfterHandoff: boolean,
  ): void {
    expect(runtime.state.handoff).toBe("requested");
    expect(runtime.state.position).toBe("premium");
    expect(runtime.state.continueAfterHandoff).toBe(continueAfterHandoff);
  }

  function createUpshiftDeps(): TestDeps {
    return createDeps({
      ...baseConfig,
      premiumSource: "explicit",
      premium,
      upshiftAfterCompaction: true,
      threshold: { tokens: 1_000, percent: 50 },
    });
  }

  function createEconomyRuntime() {
    return { state: createState({ position: "economy" }) };
  }

  it("formats premium status with remaining token and percent budget", () => {
    expect(
      statusText(
        { ...baseConfig, threshold: { tokens: 100_000, percent: 50 } },
        createState(),
        { tokens: 58_000, percent: 32 },
      ),
    ).toBe("⇣ premium (42k | 18% left)");
  });

  it("formats status for disabled, paused, handoff, economy, and unknown usage states", () => {
    expect(
      statusText(
        { ...baseConfig, enabled: false },
        createState(),
        ctx.getContextUsage(),
      ),
    ).toBe("⇣ off");
    expect(
      statusText(
        { ...baseConfig, enabled: false },
        createState({ sessionMode: "on" }),
        ctx.getContextUsage(),
      ),
    ).toBe("⇣ premium (0% left)");
    expect(
      statusText(
        baseConfig,
        createState({ paused: true }),
        ctx.getContextUsage(),
      ),
    ).toBe("⇣ paused");
    expect(
      statusText(
        baseConfig,
        createState({ handoff: "requested" }),
        ctx.getContextUsage(),
      ),
    ).toBe("⇣ handoff");
    expect(
      statusText(
        baseConfig,
        createState({ handoff: "active" }),
        ctx.getContextUsage(),
      ),
    ).toBe("⇣ writing handoff");
    expect(
      statusText(
        baseConfig,
        createState({ position: "economy" }),
        ctx.getContextUsage(),
      ),
    ).toBe("⇣ economy");
    expect(
      statusText(baseConfig, createState(), { tokens: null, percent: null }),
    ).toBe("⇣ premium");
  });

  it("queues a steering handoff when threshold is reached during agent work", async () => {
    const deps = createDeps();
    const runtime = { state: createState() };

    await maybeDownshift(deps, runtime, ctx, "steer");

    expectPendingHandoff(runtime, true);
    expect(deps.sendUserMessage).toHaveBeenCalledOnce();
    const prompt = deps.sendUserMessage.mock.calls[0][0];
    expect(prompt).toContain(HANDOFF_MARKER);
    expect(prompt).toContain("Do not call tools.");
    expect(deps.sendUserMessage).toHaveBeenCalledWith(expect.any(String), {
      deliverAs: "steer",
    });
    expect(deps.switchToTarget).not.toHaveBeenCalled();
  });

  it("downshifts when the session explicitly overrides a disabled config", async () => {
    const deps = createDeps({ ...baseConfig, enabled: false });
    const runtime = { state: createState({ sessionMode: "on" }) };

    await maybeDownshift(deps, runtime, ctx, "steer");

    expectPendingHandoff(runtime, true);
    expect(deps.sendUserMessage).toHaveBeenCalledOnce();
  });

  it("stays off when config is disabled without a session override", async () => {
    const deps = createDeps({ ...baseConfig, enabled: false });
    const runtime = { state: createState() };

    await maybeDownshift(deps, runtime, ctx, "steer");

    expect(runtime.state.handoff).toBe("idle");
    expect(deps.sendUserMessage).not.toHaveBeenCalled();
    expect(deps.switchToTarget).not.toHaveBeenCalled();
  });

  it("sends an immediate handoff when threshold is reached while idle", async () => {
    const deps = createDeps();
    const runtime = { state: createState() };

    await maybeDownshift(deps, runtime, ctx, "immediate");

    expect(runtime.state.handoff).toBe("requested");
    expect(runtime.state.continueAfterHandoff).toBe(false);
    expect(deps.sendUserMessage).toHaveBeenCalledWith(expect.any(String));
    expect(deps.sendUserMessage.mock.calls[0][1]).toBeUndefined();
    expect(deps.switchToTarget).not.toHaveBeenCalled();
  });

  it("does not duplicate pending handoff requests", async () => {
    const deps = createDeps();
    const runtime = { state: createState({ handoff: "requested" }) };

    await maybeDownshift(deps, runtime, ctx, "steer");
    await maybeDownshift(deps, runtime, ctx, "steer");

    expect(deps.sendUserMessage).not.toHaveBeenCalled();
    expect(deps.switchToTarget).not.toHaveBeenCalled();
    expect(runtime.state.handoff).toBe("requested");
  });

  it("queues a steer handoff for manual now", async () => {
    const deps = createDeps();
    const runtime = { state: createState() };

    await forceDownshiftNow(deps, runtime, "steer");

    expectPendingHandoff(runtime, true);
    expect(deps.sendUserMessage).toHaveBeenCalledWith(expect.any(String), {
      deliverAs: "steer",
    });
    expect(deps.switchToTarget).not.toHaveBeenCalled();
  });

  it("sends manual now immediately when requested", async () => {
    const deps = createDeps();
    const runtime = { state: createState() };

    await forceDownshiftNow(deps, runtime, "immediate");

    expect(runtime.state.handoff).toBe("requested");
    expect(runtime.state.position).toBe("premium");
    expect(runtime.state.continueAfterHandoff).toBe(false);
    expect(deps.sendUserMessage).toHaveBeenCalledWith(expect.any(String));
    expect(deps.sendUserMessage.mock.calls[0][1]).toBeUndefined();
  });

  it("does not duplicate manual now while handoff is pending", async () => {
    const deps = createDeps();
    const runtime = { state: createState({ handoff: "requested" }) };

    await forceDownshiftNow(deps, runtime, "steer");

    expect(deps.sendUserMessage).not.toHaveBeenCalled();
    expect(deps.switchToTarget).not.toHaveBeenCalled();
  });

  it("switches to economy after handoff agent turn ends", async () => {
    const deps = createDeps();
    const runtime = { state: createState({ handoff: "requested" }) };

    await handleBeforeAgentStart(
      deps,
      runtime,
      { prompt: `${HANDOFF_MARKER}\n...` },
      ctx,
    );
    expect(runtime.state.handoff).toBe("active");

    await handleAgentEnd(deps, runtime, { messages: [] }, ctx);

    expect(runtime.state.handoff).toBe("done");
    expect(deps.switchToTarget).toHaveBeenCalledOnce();
    expect(deps.switchToTarget).toHaveBeenCalledWith(
      baseConfig.economy,
      "economy",
      "handoff complete",
    );
  });

  it("completes a requested handoff when agent end contains the marker", async () => {
    const deps = createDeps();
    const runtime = {
      state: createState({
        handoff: "requested",
        continueAfterHandoff: true,
      }),
    };

    await handleAgentEnd(
      deps,
      runtime,
      { messages: [{ role: "user", content: `${HANDOFF_MARKER}\n...` }] },
      ctx,
    );

    expect(runtime.state.handoff).toBe("done");
    expect(runtime.state.position).toBe("economy");
    expect(deps.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining(CONTINUE_MARKER),
      { deliverAs: "followUp" },
    );
  });

  it("continues with economy after a steered handoff completes", async () => {
    const deps = createDeps();
    const runtime = {
      state: createState({
        handoff: "active",
        continueAfterHandoff: true,
      }),
    };

    await handleAgentEnd(deps, runtime, { messages: [] }, ctx);

    expect(deps.switchToTarget).toHaveBeenCalledWith(
      baseConfig.economy,
      "economy",
      "handoff complete",
    );
    expect(runtime.state.position).toBe("economy");
    expect(runtime.state.handoff).toBe("done");
    expect(runtime.state.continueAfterHandoff).toBe(false);
    expect(deps.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining(CONTINUE_MARKER),
      { deliverAs: "followUp" },
    );
  });

  it("does not continue after an idle handoff completes", async () => {
    const deps = createDeps();
    const runtime = {
      state: createState({
        handoff: "active",
        continueAfterHandoff: false,
      }),
    };

    await handleAgentEnd(deps, runtime, { messages: [] }, ctx);

    expect(deps.switchToTarget).toHaveBeenCalledOnce();
    expect(runtime.state.position).toBe("economy");
    expect(runtime.state.handoff).toBe("done");
    expect(deps.sendUserMessage).not.toHaveBeenCalled();
  });

  it("does not continue when economy switch fails", async () => {
    const deps = createDeps();
    deps.switchToTarget.mockResolvedValue(false);
    const runtime = {
      state: createState({
        handoff: "active",
        continueAfterHandoff: true,
      }),
    };

    await handleAgentEnd(deps, runtime, { messages: [] }, ctx);

    expect(deps.switchToTarget).toHaveBeenCalledOnce();
    expect(deps.sendUserMessage).not.toHaveBeenCalled();
    expect(runtime.state.continueAfterHandoff).toBe(false);
  });

  it("switches directly when handoff is disabled", async () => {
    const deps = createDeps({ ...baseConfig, handoffBeforeDownshift: false });
    const runtime = { state: createState() };

    await maybeDownshift(deps, runtime, ctx, "steer");

    expect(deps.sendUserMessage).not.toHaveBeenCalled();
    expect(deps.switchToTarget).toHaveBeenCalledOnce();
    expect(runtime.state.handoff).toBe("done");
    expect(runtime.state.position).toBe("economy");
  });

  it("upshifts after compaction even when immediate usage is unknown", async () => {
    const deps = createUpshiftDeps();
    const runtime = createEconomyRuntime();

    await maybeUpshiftAfterCompaction(deps, runtime, {
      compactionEntry: {},
    });

    expect(deps.switchToTarget).toHaveBeenCalledWith(
      premium,
      "premium",
      "upshifted",
    );
    expect(runtime.state.position).toBe("premium");
    expect(runtime.state.handoff).toBe("idle");
  });

  it("does not upshift after compaction without a compaction entry", async () => {
    const deps = createUpshiftDeps();
    const runtime = createEconomyRuntime();

    await maybeUpshiftAfterCompaction(deps, runtime, {});

    expect(deps.switchToTarget).not.toHaveBeenCalled();
    expect(runtime.state.position).toBe("economy");
  });

  it("pauses upshift when the premium target is missing", async () => {
    const deps = createDeps({
      ...baseConfig,
      upshiftAfterCompaction: true,
      threshold: { percent: 50 },
    });
    const runtime = createEconomyRuntime();

    await maybeUpshiftAfterCompaction(deps, runtime, { compactionEntry: {} });

    expect(deps.switchToTarget).not.toHaveBeenCalled();
    expect(runtime.state.paused).toBe(true);
    expect(runtime.state.lastError).toBe("premium target is unset");
  });

  it("manual model change pauses downshift and clears handoff", async () => {
    const deps = createDeps();
    const runtime = { state: createState({ handoff: "requested" }) };

    await handleManualModelSelect(deps, runtime, { source: "restore" }, ctx);
    expect(runtime.state).toEqual(createState({ handoff: "requested" }));

    await handleManualModelSelect(deps, runtime, { source: "user" }, ctx);

    expect(runtime.state.paused).toBe(true);
    expect(runtime.state.handoff).toBe("idle");
    expect(runtime.state.position).toBe("premium");
    expect(runtime.state.lastError).toBe("manual model change");
  });

  it("restores interrupted handoff as paused instead of stranded", () => {
    for (const handoff of ["requested", "active"] as const) {
      const restored = restoreStateFromEntries(
        [
          {
            type: "custom",
            customType: "downshift-state",
            data: createState({ handoff }),
          },
        ],
        "session-1",
      );

      expect(restored?.handoff).toBe("idle");
      expect(restored?.paused).toBe(true);
      expect(restored?.continueAfterHandoff).toBe(false);
      expect(restored?.lastError).toBe("handoff interrupted by reload");
    }
  });

  it("restores captured premium targets and ignores invalid target shapes", () => {
    const restored = restoreStateFromEntries(
      [
        {
          type: "custom",
          customType: "downshift-state",
          data: createState({ capturedPremium: premium }),
        },
      ],
      "session-1",
    );
    const invalid = restoreStateFromEntries(
      [
        {
          type: "custom",
          customType: "downshift-state",
          data: { ...createState(), capturedPremium: { provider: "test" } },
        },
      ],
      "session-1",
    );

    expect(restored?.capturedPremium).toEqual(premium);
    expect(invalid?.capturedPremium).toBeUndefined();
  });
});
