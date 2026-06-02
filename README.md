# 🕹️ Downshift

A tiny Pi Coding Agent extension that switches from a premium model to an economy model when your context gets expensive.

Downshift is not a model router.
It does one thing: **start strong, then downshift when context pressure crosses a threshold.**

## Why 💸

Long coding-agent sessions get increasingly expensive.

As the conversation grows, each new turn carries more accumulated context. That means the marginal cost of continuing on a premium model keeps rising, even when the hard planning work may already be done.

Downshift is built around a simple idea:

> Use the premium model while the task is ambiguous, the architecture is being discovered, and the plan is still forming. Once the direction is pinned down and the session context is large, switch to an economy model for cheaper execution.

The premium model creates the working context.
The economy model continues from it.

## Handoff note 📝

When context pressure crosses the threshold, Downshift can ask the premium model to write a concise handoff note before switching to the economy model.

If the agent is already running, Downshift uses Pi steering so the handoff is delivered at the next safe interruption point instead of waiting for the entire task to finish. After the handoff note is written, Downshift switches to the configured economy model and queues a continuation message so the economy model can resume the original work.

This note becomes normal conversation context. It gives the economy model the current goal, decisions, relevant files, remaining steps, constraints, and tests.

The handoff request itself is also sent as a normal user message so the resulting assistant note becomes durable conversation context.

This keeps Downshift simple: premium handles orientation, economy handles continuation.

## What it does ✅

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

## What it is not 🚫

Downshift does not classify prompts.
It does not benchmark models.
It does not run complex routing rules.
It does not try to be clever.

It is a deterministic context-cost governor.

## Install 📦

```bash
pi install npm:@boadij/pi-downshift
```

Then reload Pi:

```text
/reload
```

## Configure ⚙️

Run:

```text
/downshift config
```

If no config exists yet, Downshift launches the guided setup using safe defaults for opt-in behavior and thresholds. After that, the command opens a small menu showing the current values so you can edit individual settings. The config menu title includes the installed Downshift version.

## Commands ⌨️

```text
/downshift status
/downshift now
/downshift config
/downshift on
/downshift off
/downshift help
```

### `/downshift status`

Shows the current mode, context usage, remaining threshold budget, premium target, economy target, installed version, and last error if paused.

### `/downshift config`

Opens the interactive config menu. Existing configs can be edited one setting at a time without reselecting everything. On first setup, Downshift runs a guided setup flow.

### `/downshift now`

Starts the handoff immediately, regardless of the configured threshold.

If the agent is idle, Downshift asks the current model to write the handoff note now, then switches to the configured economy model. If the agent is already running, Downshift uses Pi steering to inject the handoff before the next model call. After the handoff note is written, Downshift switches to economy and queues a continuation message so work can resume on the cheaper model.

### `/downshift off`

Disables Downshift for the current session.

### `/downshift on`

Re-enables Downshift for the current session.

### `/downshift help`

Shows the available Downshift commands and the installed version.

## Example config 🧩

Downshift stores its config in Pi's agent directory as `downshift.json`.

```json
{
  "enabled": true,
  "threshold": {
    "tokens": 100000,
    "percent": 50
  },
  "economy": {
    "provider": "openai",
    "model": "gpt-5.4-nano",
    "thinkingLevel": "off"
  },
  "premiumSource": "current",
  "startOnPremium": true,
  "upshiftAfterCompaction": false,
  "handoffBeforeDownshift": true
}
```

## Mental model 🧠

A coding session often has two phases:

1. **Orientation**
   The task is unclear. The model needs to inspect files, infer intent, make architectural decisions, and create a plan. Premium models are usually worth it here.

2. **Execution**
   The plan is visible in the context. The relevant files, constraints, and next steps are already known. Economy models can often continue effectively at lower cost.

Downshift automates that handoff with a threshold.

## Prompt caching 💾

Downshift works best with providers that support prompt caching. The premium model creates the expensive shared context once, then the economy model continues from the same conversation after the threshold is reached.

Prompt caching can reduce the cost of repeatedly sending that accumulated context, while Downshift reduces the cost of future generation by moving execution to a cheaper model. The two optimizations are complementary: caching helps pay less for the context you must keep, and Downshift helps pay less for the work that remains.

Model selection uses Pi's public model registry. Downshift no longer reads Pi's internal settings file or imports private resolver internals. The picker may show more available models than before, but the extension is now portable and does not depend on local install paths.

## Status indicator 📊

Downshift adds a compact status label:

```text
⇣ 42k | 18% → eco
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

## Safety behavior 🛟

Downshift pauses instead of guessing when something changes unexpectedly.

It pauses when:

- The configured model cannot be found
- The selected thinking level is unsupported
- The target provider has no available API key
- You manually change models during the session

This keeps model switching explicit and predictable.

## Why not use a router? 🧭

Routers are useful when you want per-prompt model selection.

Downshift is for a narrower case:

> I already know which model I want to start with, and I already know which cheaper model I want to fall back to once the session gets large.

That narrower scope makes Downshift easier to reason about, easier to configure, and less surprising during long coding sessions.

## Changelog 🗒️

Release notes are generated from Conventional Commits.

See [GitHub Releases](https://github.com/boadij/pi-downshift/releases) or [CHANGELOG.md](https://github.com/boadij/pi-downshift/blob/main/CHANGELOG.md).

## Release channels 🚦

Stable releases are published to npm and can be installed with:

```bash
pi install npm:@boadij/pi-downshift
```

Development builds are tested locally with `pi -e .`, `pi install .`, or a local packed tarball before publishing.

## Local development 🛠️

Run the checks:

```bash
npm run check
```

Test locally without publishing:

```bash
pi -e .
```

Or install from the local package path:

```bash
pi install .
```

Then reload Pi:

```text
/reload
```

## License 📄

Apache-2.0
