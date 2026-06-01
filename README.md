# Downshift

A tiny Pi Coding Agent extension that switches from a premium model to an economy model when your context gets expensive.

Downshift is not a model router.
It does one thing: **start strong, then downshift when context pressure crosses a threshold.**

## Why

Long coding-agent sessions get increasingly expensive.

As the conversation grows, each new turn carries more accumulated context. That means the marginal cost of continuing on a premium model keeps rising, even when the hard planning work may already be done.

Downshift is built around a simple idea:

> Use the premium model while the task is ambiguous, the architecture is being discovered, and the plan is still forming. Once the direction is pinned down and the session context is large, switch to an economy model for cheaper execution.

The premium model creates the working context.
The economy model continues from it.

## Handoff note

When context pressure crosses the threshold, Downshift can ask the premium model to write a concise handoff note before switching to the economy model.

This note becomes normal conversation context. It gives the economy model the current goal, decisions, relevant files, remaining steps, constraints, and tests.

This keeps Downshift simple: premium handles orientation, economy handles continuation.

## What it does

- Starts sessions on a premium model, or captures the current model as premium
- Watches Pi's context usage
- Asks the premium model for a compact handoff note before switching
- Switches to a configured economy model after a token or percent threshold
- Supports token thresholds, percent thresholds, or both
- Preserves session state
- Pauses automatically after manual model changes
- Optionally switches back to premium after compaction
- Shows a compact status indicator in the UI
- Provides simple `/downshift` commands

## What it is not

Downshift does not classify prompts.
It does not benchmark models.
It does not run complex routing rules.
It does not try to be clever.

It is a deterministic context-cost governor.

## Install

```bash
pi install npm:<your-package-name>
```

Then reload Pi:

```text
/reload
```

## Configure

Run:

```text
/downshift config
```

You will be prompted to choose:

- Whether Downshift is enabled
- A context threshold
- An economy model
- Whether premium means the current session model or an explicit model
- Whether fresh sessions should start on premium
- Whether to upshift after compaction
- Whether to create a handoff note before downshifting

## Commands

```text
/downshift status
/downshift config
/downshift on
/downshift off
```

### `/downshift status`

Shows the current mode, context usage, remaining threshold budget, premium target, economy target, and last error if paused.

### `/downshift config`

Opens the interactive setup flow.

### `/downshift off`

Disables Downshift for the current session.

### `/downshift on`

Re-enables Downshift for the current session.

## Example config

Downshift stores its config in Pi's agent directory as `downshift.json`.

```json
{
  "enabled": true,
  "threshold": {
    "tokens": 100000,
    "percent": 60
  },
  "economy": {
    "provider": "openai",
    "model": "gpt-5.4-nano",
    "thinkingLevel": "off"
  },
  "premiumSource": "current",
  "startOnPremium": true,
  "upshiftAfterCompaction": true,
  "handoffBeforeDownshift": true
}
```

## Mental model

A coding session often has two phases:

1. **Orientation**
   The task is unclear. The model needs to inspect files, infer intent, make architectural decisions, and create a plan. Premium models are usually worth it here.

2. **Execution**
   The plan is visible in the context. The relevant files, constraints, and next steps are already known. Economy models can often continue effectively at lower cost.

Downshift automates that handoff with a threshold.

Model selection uses Pi's public model registry. Downshift no longer reads Pi's internal settings file or imports private resolver internals. The picker may show more available models than before, but the extension is now portable and does not depend on local install paths.

## Status indicator

Downshift adds a compact status label:

```text
⇣ 42k / 18% → eco
```

This means Downshift is active and will switch to the economy model when the configured context threshold is reached.

Other states:

```text
⇣ handoff
⇣ writing handoff
⇣ eco
⇣ paused
⇣ off
```

## Safety behavior

Downshift pauses instead of guessing when something changes unexpectedly.

It pauses when:

- The configured model cannot be found
- The selected thinking level is unsupported
- The target provider has no available API key
- You manually change models during the session

This keeps model switching explicit and predictable.

## Why not use a router?

Routers are useful when you want per-prompt model selection.

Downshift is for a narrower case:

> I already know which model I want to start with, and I already know which cheaper model I want to fall back to once the session gets large.

That narrower scope makes Downshift easier to reason about, easier to configure, and less surprising during long coding sessions.

## License

MIT
