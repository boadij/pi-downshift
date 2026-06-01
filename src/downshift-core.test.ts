import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  HANDOFF_MARKER,
  forceDownshiftNow,
  handleAgentEnd,
  handleBeforeAgentStart,
  handleManualModelSelect,
  maybeDownshift,
  restoreStateFromEntries,
  type DownshiftConfig,
  type DownshiftState,
  type ModelTarget,
} from "./downshift-core";

const economy: ModelTarget = {
  provider: "test",
  model: "economy",
  thinkingLevel: "off",
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
    (prompt: string, options?: { deliverAs: "steer" }) => Promise<void>
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
    sessionEnabled: true,
    paused: false,
    position: "premium",
    handoff: "idle",
    ...patch,
  };
}

const ctx = {
  getContextUsage: () => ({ tokens: 101, percent: 51 }),
};

describe("downshift core", () => {
  beforeEach(() => vi.clearAllMocks());

  it("queues a steering handoff when threshold is reached during agent work", async () => {
    const deps = createDeps();
    const runtime = { state: createState() };

    await maybeDownshift(deps, runtime, ctx, "steer");

    expect(runtime.state.handoff).toBe("requested");
    expect(runtime.state.position).toBe("premium");
    expect(deps.sendUserMessage).toHaveBeenCalledOnce();
    const prompt = deps.sendUserMessage.mock.calls[0][0];
    expect(prompt).toContain(HANDOFF_MARKER);
    expect(prompt).toContain("Do not call tools.");
    expect(deps.sendUserMessage).toHaveBeenCalledWith(expect.any(String), {
      deliverAs: "steer",
    });
    expect(deps.switchToTarget).not.toHaveBeenCalled();
  });

  it("sends an immediate handoff when threshold is reached while idle", async () => {
    const deps = createDeps();
    const runtime = { state: createState() };

    await maybeDownshift(deps, runtime, ctx, "immediate");

    expect(runtime.state.handoff).toBe("requested");
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

    expect(runtime.state.handoff).toBe("requested");
    expect(runtime.state.position).toBe("premium");
    expect(deps.sendUserMessage).toHaveBeenCalledWith(expect.any(String), {
      deliverAs: "steer",
    });
    expect(deps.switchToTarget).not.toHaveBeenCalled();
  });

  it("sends manual now immediately when requested", async () => {
    const deps = createDeps();
    const runtime = { state: createState() };

    await forceDownshiftNow(deps, runtime, "immediate");

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

    await handleAgentEnd(deps, runtime, ctx);

    expect(runtime.state.handoff).toBe("done");
    expect(deps.switchToTarget).toHaveBeenCalledOnce();
    expect(deps.switchToTarget).toHaveBeenCalledWith(
      baseConfig.economy,
      "economy",
      "handoff complete",
    );
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
      expect(restored?.lastError).toBe("handoff interrupted by reload");
    }
  });
});
