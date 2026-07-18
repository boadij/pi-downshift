import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  CONTINUE_MARKER,
  HANDOFF_MARKER,
  forceDownshiftNow,
  handleAgentEnd,
  handleBeforeAgentStart,
  handleManualModelSelect,
  handleManualThinkingLevelSelect,
  maybeDownshift,
  maybeUpshiftAfterCompaction,
  reconcilePositionTarget,
  restoreBranchPhaseFromEntries,
  restoreStateFromEntries,
  statusText,
  thresholdReached,
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
  getActiveTarget: Mock<() => ModelTarget | undefined>;
  updateStatus: Mock<() => void>;
  notify: Mock<(message: string, level?: string) => void>;
};

function createDeps(config = baseConfig): TestDeps {
  return {
    readConfig: vi.fn(async () => config),
    saveState: vi.fn(),
    sendUserMessage: vi.fn(async () => undefined),
    switchToTarget: vi.fn(async () => true),
    getActiveTarget: vi.fn(() => undefined),
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

  describe("thresholdReached", () => {
    it("detects a token threshold independently of percent usage", () => {
      expect(
        thresholdReached({ tokens: 10_000, percent: 20 }, { tokens: 10_000 }),
      ).toBe(true);
      expect(
        thresholdReached(
          { tokens: 10_000, percent: 20 },
          { tokens: 10_000, percent: 50 },
        ),
      ).toBe(true);
    });

    it("detects a percent threshold independently of token usage", () => {
      expect(
        thresholdReached({ tokens: null, percent: 50 }, { percent: 50 }),
      ).toBe(true);
      expect(
        thresholdReached({ tokens: 10_000, percent: 51 }, { percent: 50 }),
      ).toBe(true);
    });

    it("does not reach a threshold when the relevant usage is null", () => {
      expect(
        thresholdReached({ tokens: null, percent: 99 }, { tokens: 100 }),
      ).toBe(false);
      expect(
        thresholdReached({ tokens: 100, percent: null }, { percent: 50 }),
      ).toBe(false);
    });

    it("does not reach a threshold when usage is missing", () => {
      expect(thresholdReached(undefined, { tokens: 100 })).toBe(false);
      expect(thresholdReached(undefined, { percent: 50 })).toBe(false);
    });
  });

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

  describe("restoreBranchPhaseFromEntries", () => {
    it("defaults to premium and idle without a state entry", () => {
      expect(restoreBranchPhaseFromEntries([])).toEqual({
        position: "premium",
        handoff: "idle",
        interrupted: false,
      });
    });

    it("ignores non-Downshift and invalid entries", () => {
      expect(
        restoreBranchPhaseFromEntries([
          { type: "message", data: {} },
          { type: "custom", customType: "downshift-state", data: "invalid" },
        ]),
      ).toEqual({
        position: "premium",
        handoff: "idle",
        interrupted: false,
      });
    });

    it("uses the newest valid state on the branch", () => {
      expect(
        restoreBranchPhaseFromEntries([
          {
            type: "custom",
            customType: "downshift-state",
            data: { position: "economy", handoff: "done" },
          },
          {
            type: "custom",
            customType: "downshift-state",
            data: { position: "premium", handoff: "done" },
          },
        ]),
      ).toEqual({
        position: "premium",
        handoff: "idle",
        interrupted: false,
      });
    });

    it("restores premium as idle", () => {
      expect(
        restoreBranchPhaseFromEntries([
          {
            type: "custom",
            customType: "downshift-state",
            data: { position: "premium", handoff: "done" },
          },
        ]),
      ).toEqual({
        position: "premium",
        handoff: "idle",
        interrupted: false,
      });
    });

    it("restores economy as done", () => {
      expect(
        restoreBranchPhaseFromEntries([
          {
            type: "custom",
            customType: "downshift-state",
            data: { position: "economy", handoff: "idle" },
          },
        ]),
      ).toEqual({
        position: "economy",
        handoff: "done",
        interrupted: false,
      });
    });

    it.each(["requested", "active"] as const)(
      "marks a %s handoff as interrupted and normalizes it",
      (handoff) => {
        expect(
          restoreBranchPhaseFromEntries([
            {
              type: "custom",
              customType: "downshift-state",
              data: { position: "premium", handoff, continueAfterHandoff: true },
            },
          ]),
        ).toEqual({
          position: "premium",
          handoff: "idle",
          interrupted: true,
        });
      },
    );

    it("does not restore continuation or session-wide fields", () => {
      expect(
        restoreBranchPhaseFromEntries([
          {
            type: "custom",
            customType: "downshift-state",
            data: {
              position: "economy",
              handoff: "done",
              continueAfterHandoff: true,
              sessionMode: "off",
              paused: true,
              capturedPremium: premium,
              lastError: "manual model change",
            },
          },
        ]),
      ).toEqual({
        position: "economy",
        handoff: "done",
        interrupted: false,
      });
    });
  });

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

  it("does nothing while paused even when the threshold is reached", async () => {
    const deps = createDeps();
    const runtime = { state: createState({ paused: true }) };

    await maybeDownshift(deps, runtime, ctx, "steer");

    expect(deps.sendUserMessage).not.toHaveBeenCalled();
    expect(deps.switchToTarget).not.toHaveBeenCalled();
    expect(runtime.state).toEqual(createState({ paused: true }));
  });

  it("does nothing while usage is below the configured threshold", async () => {
    const deps = createDeps({
      ...baseConfig,
      threshold: { tokens: 1_000, percent: 50 },
    });
    const runtime = { state: createState() };

    await maybeDownshift(
      deps,
      runtime,
      { getContextUsage: () => ({ tokens: 999, percent: 49 }) },
      "steer",
    );

    expect(deps.sendUserMessage).not.toHaveBeenCalled();
    expect(deps.switchToTarget).not.toHaveBeenCalled();
    expect(runtime.state).toEqual(createState());
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

  it("does not upshift after compaction when upshift is not configured", async () => {
    const deps = createDeps({
      ...baseConfig,
      premiumSource: "explicit",
      premium,
      upshiftAfterCompaction: false,
    });
    const runtime = createEconomyRuntime();

    await maybeUpshiftAfterCompaction(deps, runtime, {
      compactionEntry: {},
    });

    expect(deps.switchToTarget).not.toHaveBeenCalled();
    expect(runtime.state.position).toBe("economy");
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

    await handleManualModelSelect(deps, runtime, { source: "cycle" }, ctx);

    expect(runtime.state.paused).toBe(true);
    expect(runtime.state.handoff).toBe("idle");
    expect(runtime.state.position).toBe("premium");
    expect(runtime.state.lastError).toBe("manual model change");
  });

  it("manual thinking level change pauses downshift and clears handoff", async () => {
    const deps = createDeps();
    const runtime = { state: createState({ handoff: "active" }) };

    await handleManualThinkingLevelSelect(
      deps,
      runtime,
      { level: "high", previousLevel: "medium" },
      ctx,
    );

    expect(runtime.state.paused).toBe(true);
    expect(runtime.state.handoff).toBe("idle");
    expect(runtime.state.continueAfterHandoff).toBe(false);
    expect(runtime.state.lastError).toBe("manual thinking level change");
  });

  it("does not pause for a manual thinking level change when disabled", async () => {
    const deps = createDeps({ ...baseConfig, enabled: false });
    const runtime = { state: createState({ handoff: "requested" }) };

    await handleManualThinkingLevelSelect(
      deps,
      runtime,
      { level: "high", previousLevel: "medium" },
      ctx,
    );

    expect(runtime.state).toEqual(createState({ handoff: "requested" }));
    expect(deps.updateStatus).toHaveBeenCalledWith({
      ...baseConfig,
      enabled: false,
    });
  });

  describe("reconcilePositionTarget", () => {
    it("selects the configured economy target for economy position", async () => {
      const deps = createDeps();
      deps.getActiveTarget.mockReturnValue(premium);
      const runtime = { state: createState({ position: "economy" }) };

      await reconcilePositionTarget(deps, runtime, "restored branch");

      expect(deps.switchToTarget).toHaveBeenCalledWith(
        economy,
        "economy",
        "restored branch",
      );
    });

    it("selects an explicit premium target for premium position", async () => {
      const config = { ...baseConfig, premiumSource: "explicit" as const, premium };
      const deps = createDeps(config);
      deps.getActiveTarget.mockReturnValue(economy);
      const runtime = { state: createState() };

      await reconcilePositionTarget(deps, runtime, "restored session");

      expect(deps.switchToTarget).toHaveBeenCalledWith(
        premium,
        "premium",
        "restored session",
      );
    });

    it("selects the captured premium target for current premium source", async () => {
      const deps = createDeps();
      deps.getActiveTarget.mockReturnValue(economy);
      const runtime = { state: createState({ capturedPremium: premium }) };

      await reconcilePositionTarget(deps, runtime, "restored session");

      expect(deps.switchToTarget).toHaveBeenCalledWith(
        premium,
        "premium",
        "restored session",
      );
    });

    it("does not switch or persist when the complete target matches", async () => {
      const config = {
        ...baseConfig,
        premiumSource: "explicit" as const,
        premium,
      };
      const deps = createDeps(config);
      deps.getActiveTarget.mockReturnValue(premium);
      const runtime = { state: createState() };

      await reconcilePositionTarget(deps, runtime, "restored branch");

      expect(deps.switchToTarget).not.toHaveBeenCalled();
      expect(deps.saveState).not.toHaveBeenCalled();
      expect(deps.notify).not.toHaveBeenCalled();
      expect(deps.updateStatus).toHaveBeenCalledWith(config);
    });

    it.each([
      ["thinking level", premium, { ...premium, thinkingLevel: "high" }],
      ["model", premium, { ...premium, model: "premium-new" }],
    ] as const)("switches for a %s-only mismatch", async (_kind, expected, active) => {
      const config = {
        ...baseConfig,
        premiumSource: "explicit" as const,
        premium: expected,
      };
      const deps = createDeps(config);
      deps.getActiveTarget.mockReturnValue(active);
      const runtime = { state: createState() };

      await reconcilePositionTarget(deps, runtime, "restored branch");

      expect(deps.switchToTarget).toHaveBeenCalledWith(
        expected,
        "premium",
        "restored branch",
      );
      expect(deps.sendUserMessage).not.toHaveBeenCalled();
    });

    it.each([
      ["disabled config", { ...baseConfig, enabled: false }, createState()],
      ["off session", baseConfig, createState({ sessionMode: "off" })],
      ["paused runtime", baseConfig, createState({ paused: true })],
      ["pending handoff", baseConfig, createState({ handoff: "requested" })],
    ] as const)("does not switch for %s", async (_name, config, state) => {
      const deps = createDeps(config);
      deps.getActiveTarget.mockReturnValue(economy);
      const runtime = { state };

      await reconcilePositionTarget(deps, runtime, "restored branch");

      expect(deps.switchToTarget).not.toHaveBeenCalled();
      expect(deps.sendUserMessage).not.toHaveBeenCalled();
    });

    it("pauses when the premium target is missing", async () => {
      const config = {
        ...baseConfig,
        premiumSource: "explicit" as const,
        premium: undefined,
      };
      const deps = createDeps(config);
      const runtime = { state: createState() };

      await reconcilePositionTarget(deps, runtime, "restored session");

      expect(runtime.state.paused).toBe(true);
      expect(runtime.state.lastError).toBe("premium target is unset");
      expect(deps.switchToTarget).not.toHaveBeenCalled();
      expect(deps.sendUserMessage).not.toHaveBeenCalled();
    });

    it("returns the current runtime state after a successful switch", async () => {
      const config = {
        ...baseConfig,
        premiumSource: "explicit" as const,
        premium,
      };
      const deps = createDeps(config);
      deps.getActiveTarget.mockReturnValue(economy);
      const runtime = { state: createState() };

      const result = await reconcilePositionTarget(deps, runtime, "restored session");

      expect(result).toBe(runtime.state);
      expect(deps.updateStatus).toHaveBeenCalledWith(config);
    });
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

  it("restores the newest valid state entry", () => {
    const restored = restoreStateFromEntries(
      [
        {
          type: "custom",
          customType: "downshift-state",
          data: createState({ position: "premium" }),
        },
        {
          type: "custom",
          customType: "downshift-state",
          data: createState({ position: "economy", paused: true }),
        },
      ],
      "session-1",
    );

    expect(restored?.position).toBe("economy");
    expect(restored?.paused).toBe(true);
  });

  it("uses the current session ID instead of a persisted parent ID", () => {
    const restored = restoreStateFromEntries(
      [
        {
          type: "custom",
          customType: "downshift-state",
          data: { ...createState(), sessionId: "parent-session" },
        },
      ],
      "current-session",
    );

    expect(restored?.sessionId).toBe("current-session");
  });

  it("restores legacy session flags", () => {
    const restoredOverride = restoreStateFromEntries(
      [
        {
          type: "custom",
          customType: "downshift-state",
          data: { sessionOverride: true },
        },
      ],
      "session-1",
    );
    const restoredDisabled = restoreStateFromEntries(
      [
        {
          type: "custom",
          customType: "downshift-state",
          data: { sessionEnabled: false },
        },
      ],
      "session-1",
    );

    expect(restoredOverride?.sessionMode).toBe("on");
    expect(restoredDisabled?.sessionMode).toBe("off");
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
