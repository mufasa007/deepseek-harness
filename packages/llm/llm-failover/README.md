---
description: "Cross-provider model failover for user and maintainer: bounded per-route retries, then a durable switch to the next usable fallback route, including another vendor's models."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-failover

English | [中文](README.zh.md)

## Overview

Mount `@deepseek-ai/dsh-llm-failover` to keep agent turns alive when a model route stops serving: an exhausted balance (`QUOTA`/`ACCOUNT_QUOTA`), a suspended or rejected account (`AUTH`/`INVALID_CREDENTIAL`/`MISSING_CREDENTIAL`), or persistent network and server failures. Transient failures are retried in place up to `maxRetries` (default 5) with bounded backoff; permanent failures skip the wait. Once a route's budget is spent — or the failure is immediately permanent — the plugin durably switches the agent onto the next usable route from the configured fallback chain, which may belong to a different provider, and the loop re-runs the failed step from the same persisted history.

## Table of contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further exploration](#further-exploration)
- [Model experience](#model-experience)
- [Known limitations and deferred work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Choose this package when a deployment has more than one provider configured and agent runs should survive one vendor's outage, quota exhaustion, or account failure by moving to a standby route. Skip it when a single provider is all the deployment has — with no fallback chain the plugin changes nothing — or when in-place retries are all you need (that is [dsh-llm-retry](../llm-retry/README.md)).

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-llm-failover'
  config:
    maxRetries: 5
    chains:
      - from: { provider: deepseek-official, model: deepseek-v4-flash }
        to:
          - { provider: openrouter, model: deepseek/deepseek-v4 }
          - { provider: siliconflow, model: deepseek-ai/DeepSeek-V4 }
      - to:
          - { provider: openrouter, model: deepseek/deepseek-v4 }
```

| Field | Default | Meaning |
|---|---|---|
| `maxRetries` | `5` | Failover-owned in-place retries per route before switching |
| `retryCodes` | `EMPTY_RESPONSE`, `RATE_LIMIT`, `SERVER`, `TIMEOUT`, `TRANSPORT` | Transient failure codes that consume the retry budget |
| `switchCodes` | `AUTH`, `ACCOUNT_QUOTA`, `QUOTA`, `INVALID_CREDENTIAL`, `MISSING_CREDENTIAL` | Permanent failure codes that switch immediately |
| `backoff` | `1000ms → 30000ms`, jitter `0.2` | Local exponential backoff for failover-owned retries |
| `chains` | `[]` | Ordered fallback chains; exact `from` wins over provider-only, which wins over the default chain |

### What you can observe

Every decision is durable before it takes effect: a scheduled in-place retry appends a non-surface `llm/failover-retry` event with the route, retry ordinal, delay, and failure; a route switch appends `llm/failover` with the `from` and `to` routes. The retried step then re-enters prompt assembly and request routing, so the switch applies to the very next attempt and persists for the rest of the session. A fallback candidate counts as usable only when its provider has a live registered adapter, its non-empty model catalog contains the exact model, and `resolveCallConfig` validates the route; unusable candidates are skipped in order.

### Failures and recovery

When no chain matches the failing route, or every candidate is unusable, the plugin delegates and the original failure stays terminal. Cancellation or plugin disposal aborts an in-progress wait and leaves the log consistent. The plugin never rewrites model-visible content: retry and failover events, delays, and provider errors stay off the model surface, while the route change itself appears in the next persisted request header like any other route change.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details — click to expand</summary>

### Design philosophy

The executor follows the same rule as [dsh-llm-retry](../llm-retry/README.md): **durable before wait, open-step boundaries, downstream first.** Recovery runs on the agent loop's `agent/request-error` waterfall; the listener settles downstream recovery first, so a mounted `dsh-llm-retry` consumes its own per-provider budget before failover adds retries or switches. The route switch itself is applied by a second listener on the `agent/request` waterfall, which the loop re-runs for every retried step: the listener rewrites the proposed provider/model onto the durably recorded failover target, clearing any inherited route-owned reasoning effort so the fallback model resolves its own default.

### Source map

| File | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Function plugin: both waterfall listeners, chain matching, availability checks, backoff, durable event appends |
| [`src/types.ts`](src/types.ts) | Browser-safe `llm/failover-retry` and `llm/failover` event payload types |

### State

Per-session state lives in the `llmFailover` session projection: in-place retry counts per route within the current step (reset on `step/start` and `turn/end`), and the override map from each abandoned route to its replacement. Override chains are followed transitively, so a fallback route that itself fails advances to the next candidate of the original chain instead of looping.

### Composition with dsh-llm-retry

Mounted together, `dsh-llm-retry` retries transient failures under each provider's `retryPolicy` first; failover observes the failure only after that policy delegates. Set failover's `maxRetries: 0` in that composition to switch as soon as the retry plugin's budget is exhausted, rather than adding a second budget.

</details>

-----

<a id="further-exploration"></a>
## Further exploration

- [dsh-llm service](../llm/README.md) — the provider-neutral service whose adapters and failure codes this plugin routes on.
- [dsh-llm-retry](../llm-retry/README.md) — in-place per-provider retry execution at the same extension point.
- [LLM streaming subsystem](../../../docs/subsystems/llm-streaming.md) — the `StreamChunk` protocol and terminal failure contract.

-----

<a id="model-experience"></a>
## Model experience

### What the model sees

Retry and failover events, delays, and provider errors are never model-visible. A route switch is recorded in the next request header, and the assistant message that succeeds names its actual provider and model, so the transcript stays reconstructable.

#### Token effect

Each in-place retry is a new provider request and may re-bill input tokens; the budget is bounded by `maxRetries`. A switched step bills the fallback provider instead.

#### KV Cache effect

The rebuilt request keeps its earlier prefix and is eligible for provider cache reuse under the fallback route's own rules; cross-provider switches naturally start a fresh cache.

## Known limitations and deferred work

<a id="known-limitations-and-deferred-work"></a>

- **Agent turns are the only failover boundary** — direct `ctx.llm.stream()` consumers stay single-attempt, because a raw stream cannot durably separate already-emitted chunks.
- **Switches are sticky within a session** — once an agent fails over, later steps keep the fallback route; automatic switch-back on primary recovery is deferred work.
- **No cross-agent coordination** — each agent fails over independently on its own first hard failure; a fleet-wide outage still costs one observed failure per agent.
- **Availability checks are metadata-level** — a candidate whose provider registers and validates can still fail at request time; that failure then re-enters this same recovery path.
