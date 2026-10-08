/**
 * Cross-provider model failover on the agent loop's request recovery extension
 * point. After a route's retry budget is exhausted, or immediately for permanent
 * failures (auth, quota, credential), the plugin durably switches the agent onto
 * the next usable route from a configured fallback chain — including routes owned
 * by a different provider — and lets the loop re-run the failed step.
 *
 * @module @deepseek-ai/dsh-llm-failover
 */

import type { Context, Events } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { Agent, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig, LlmFailure, LlmRuntime } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { LlmFailoverRoute } from './types.ts'

export type { LlmFailoverEventData, LlmFailoverRetryEventData, LlmFailoverRoute } from './types.ts'

export const name = 'llm-failover'
export const inject = ['llm', 'sessionProjections']

/** One exact provider/model candidate in a fallback chain. */
export interface FailoverRouteConfig {
  /** Registered LLM provider id. */
  readonly provider: string
  /** Provider-owned exact model id. */
  readonly model: string
  /** Optional adapter-owned reasoning effort for this route. */
  readonly reasoningEffort?: string
}

/** Route selector owning one fallback chain. */
export interface FailoverChainFrom {
  /** Provider id this chain applies to; absent together with `model` makes a default chain. */
  readonly provider?: string
  /** Exact model id this chain applies to; omission matches every model of the provider. */
  readonly model?: string
}

/** One ordered fallback chain: when `from` fails, try each `to` route in order. */
export interface FailoverChainConfig {
  /** Owning route selector; omit for the default chain used when no specific chain matches. */
  readonly from?: FailoverChainFrom
  /** Ordered fallback candidates; the first usable one wins. */
  readonly to: FailoverRouteConfig[]
}

/** Bounded local backoff for failover-owned retries. */
export interface FailoverBackoffConfig {
  /** Initial local exponential-backoff delay in milliseconds (default 1000). */
  readonly initialDelayMs?: number
  /** Maximum locally scheduled delay in milliseconds (default 30000). */
  readonly maxDelayMs?: number
  /** Symmetric random multiplier range around one (default 0.2). */
  readonly jitterRatio?: number
}

/** Failover executor configuration. */
export interface Config {
  /**
   * Failover-owned retries per route before switching to a fallback (default 5).
   * Only transient `retryCodes` failures consume this budget; permanent
   * `switchCodes` failures switch immediately. When `dsh-llm-retry` is mounted
   * it retries first, so set `maxRetries: 0` to switch as soon as that budget
   * is exhausted instead of adding a second one.
   */
  readonly maxRetries?: number
  /** Transient failure codes retried in place before switching (network, rate limit, server). */
  readonly retryCodes?: string[]
  /** Permanent failure codes that switch immediately (quota, auth, credential). */
  readonly switchCodes?: string[]
  /** Local backoff for failover-owned retries. */
  readonly backoff?: FailoverBackoffConfig
  /** Ordered fallback chains; the most specific matching chain wins. */
  readonly chains?: FailoverChainConfig[]
}

const DEFAULT_MAX_RETRIES = 5
const DEFAULT_RETRY_CODES = Object.freeze(['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'])
const DEFAULT_SWITCH_CODES = Object.freeze(['AUTH', 'ACCOUNT_QUOTA', 'QUOTA', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL'])
const DEFAULT_INITIAL_DELAY_MS = 1000
const DEFAULT_MAX_DELAY_MS = 30_000
const DEFAULT_JITTER_RATIO = 0.2

const RouteSchema: z<FailoverRouteConfig> = z.object({
  provider: z.string().min(1).required(),
  model: z.string().min(1).required(),
  reasoningEffort: z.string().min(1),
})

/** Loader schema for {@link Config}. */
export const Config: z<Config> = z.object({
  maxRetries: z.number().step(1).min(0).default(DEFAULT_MAX_RETRIES),
  retryCodes: z.array(z.string().min(1)).default([...DEFAULT_RETRY_CODES]),
  switchCodes: z.array(z.string().min(1)).default([...DEFAULT_SWITCH_CODES]),
  backoff: z.object({
    initialDelayMs: z.number().min(0).default(DEFAULT_INITIAL_DELAY_MS),
    maxDelayMs: z.number().min(0).default(DEFAULT_MAX_DELAY_MS),
    jitterRatio: z.number().min(0).max(1).default(DEFAULT_JITTER_RATIO),
  }).default({}),
  chains: z.array(z.object({
    from: z.object({
      provider: z.string().min(1),
      model: z.string().min(1),
    }),
    to: z.array(RouteSchema).min(1).required(),
  })).default([]),
})

/** Fully resolved executor configuration. */
interface ResolvedConfig {
  readonly maxRetries: number
  readonly retryCodes: readonly string[]
  readonly switchCodes: readonly string[]
  readonly backoff: Required<FailoverBackoffConfig>
  readonly chains: readonly FailoverChainConfig[]
}

/** Non-serializable hooks used to make timing policy deterministic in tests. */
export interface FailoverInternals {
  /** Random sample in the inclusive zero-to-one range used for jitter. */
  random?: () => number
}

/** Durable per-session failover state owned by the `llmFailover` projection. */
interface LlmFailoverState {
  /** Failover-owned scheduled-retry counts per route key within the current step. */
  readonly attempts: Readonly<Record<string, number>>
  /** Active route overrides: failing route key → replacement route. */
  readonly overrides: Readonly<Record<string, LlmFailoverRoute>>
}

const failoverRouteSchema = zod.object({
  provider: zod.string(),
  model: zod.string(),
  reasoningEffort: zod.string().optional(),
})

// The cast bridges the optional route effort, which Zod cannot express under exactOptionalPropertyTypes.
const llmFailoverStateSchema = zod.object({
  attempts: zod.record(zod.string(), zod.number().int().nonnegative()),
  overrides: zod.record(zod.string(), failoverRouteSchema),
}) as unknown as zod.ZodType<LlmFailoverState>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Failover retry counters and active route overrides for one Session. */
    llmFailover: LlmFailoverState
  }
}

function routeKey(route: { provider: string; model: string }): string {
  return `${route.provider}\0${route.model}`
}

function sameRoute(left: { provider: string; model: string }, right: { provider: string; model: string }): boolean {
  return left.provider === right.provider && left.model === right.model
}

/**
 * Follow the override chain from one route to its current replacement.
 * @param overrides - Durable override map.
 * @param route - Route proposed for the upcoming request.
 * @param limit - Maximum chain hops; cycles settle on the last visited route.
 * @returns the effective replacement, or `undefined` when the route is not overridden.
 */
function resolveOverride(
  overrides: Readonly<Record<string, LlmFailoverRoute>>,
  route: { provider: string; model: string },
  limit = 16,
): LlmFailoverRoute | undefined {
  let current: { provider: string; model: string } = route
  let target: LlmFailoverRoute | undefined
  for (let hop = 0; hop < limit; hop++) {
    const next: LlmFailoverRoute | undefined = overrides[routeKey(current)]
    if (next === undefined || sameRoute(next, current)) return target
    target = next
    current = next
  }
  return target
}

/**
 * Collect the override chain that led to one route, oldest first.
 * @returns the route chain ending at `current`, or `[current]` when unchained.
 */
function overrideChain(
  overrides: Readonly<Record<string, LlmFailoverRoute>>,
  current: { provider: string; model: string },
): Array<{ provider: string; model: string }> {
  const chain = [current]
  let cursor = current
  for (let hop = 0; hop < 16; hop++) {
    const predecessor = Object.entries(overrides).find(([, target]) => sameRoute(target, cursor))
    if (predecessor === undefined) break
    const [provider, ...rest] = predecessor[0].split('\0')
    const source = { provider: provider ?? '', model: rest.join('\0') }
    if (source.provider.length === 0 || chain.some(route => sameRoute(route, source))) break
    chain.push(source)
    cursor = source
  }
  return chain.reverse()
}

/**
 * Pick the fallback chain owning one route: an exact provider+model `from`
 * wins over a provider-only `from`, which wins over the default chain.
 * @param chains - Configured chains in declaration order.
 * @param route - Route whose requests are failing.
 */
function matchingChain(
  chains: readonly FailoverChainConfig[],
  route: { provider: string; model: string },
): FailoverChainConfig | undefined {
  return chains.find(chain => chain.from?.provider === route.provider && chain.from?.model === route.model)
    ?? chains.find(chain => chain.from?.provider === route.provider && chain.from?.model === undefined)
    ?? chains.find(chain => chain.from === undefined || (chain.from.provider === undefined && chain.from.model === undefined))
}

/**
 * Whether one fallback route is usable in the current composition: its provider
 * has a live registered adapter, a non-empty model catalog contains the exact
 * model, and the route validates through the adapter without I/O.
 * @param llm - Live LLM runtime.
 * @param route - Candidate fallback route.
 * @param signal - Turn abort signal.
 */
async function routeUsable(llm: LlmRuntime, route: FailoverRouteConfig, signal: AbortSignal): Promise<boolean> {
  if (!llm.listProviders().some(provider => provider.id === route.provider)) return false
  try {
    const models = await llm.listModels(route.provider)
    if (models.length > 0 && !models.some(model => model.id === route.model)) return false
    await llm.resolveCallConfig({
      provider: route.provider,
      model: route.model,
      ...route.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(route.reasoningEffort) },
    }, signal)
    return true
  } catch {
    return false
  }
}

function localDelay(config: ResolvedConfig, retry: number, random: () => number): number {
  const exponent = Math.min(retry - 1, 1024)
  const exponential = Math.min(config.backoff.initialDelayMs * 2 ** exponent, config.backoff.maxDelayMs)
  const jitter = 1 - config.backoff.jitterRatio + 2 * config.backoff.jitterRatio * random()
  return Math.min(exponential * jitter, config.backoff.maxDelayMs)
}

function cancellableDelay(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, delayMs)
    function onAbort(): void {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

type DownstreamOutcome =
  | { readonly type: 'decision'; readonly decision: RequestErrorAction }
  | { readonly type: 'error'; readonly error: unknown }

async function settleDownstream(
  next: () => Promise<RequestErrorAction>,
): Promise<DownstreamOutcome> {
  try {
    return { type: 'decision', decision: await next() }
  } catch (error: unknown) {
    return { type: 'error', error }
  }
}

/**
 * Install cross-provider model failover.
 * @param ctx - plugin context that owns the listeners and active waits.
 * @param config - executor configuration; empty config disables failover.
 * @param internals - non-serializable deterministic hooks for tests.
 */
export function apply(ctx: Context, config: Config = {}, internals: FailoverInternals = {}): void {
  const resolved: ResolvedConfig = {
    maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
    retryCodes: config.retryCodes ?? DEFAULT_RETRY_CODES,
    switchCodes: config.switchCodes ?? DEFAULT_SWITCH_CODES,
    backoff: {
      initialDelayMs: config.backoff?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS,
      maxDelayMs: config.backoff?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
      jitterRatio: config.backoff?.jitterRatio ?? DEFAULT_JITTER_RATIO,
    },
    chains: config.chains ?? [],
  }

  ctx.sessionProjections.register({
    key: 'llmFailover',
    stateVersion: 1,
    stateSchema: llmFailoverStateSchema,
    init: () => ({ attempts: {}, overrides: {} }),
    apply: (state, event) => {
      if (event.type === 'step/start' || event.type === 'turn/end') return { ...state, attempts: {} }
      if (event.type === 'llm/failover-retry') {
        const key = routeKey(event.data.route)
        if (state.attempts[key] === event.data.retry) return state
        return { ...state, attempts: { ...state.attempts, [key]: event.data.retry } }
      }
      if (event.type === 'llm/failover') {
        return {
          attempts: {},
          overrides: { ...state.overrides, [routeKey(event.data.from)]: event.data.to },
        }
      }
      return state
    },
  })

  const random = internals.random ?? Math.random
  const lifetime = new AbortController()
  const active = new Set<Promise<RequestErrorAction>>()

  function track(operation: Promise<RequestErrorAction>): Promise<RequestErrorAction> {
    const tracked = operation.finally(() => active.delete(tracked))
    active.add(tracked)
    return tracked
  }

  function stateOf(agent: Agent): LlmFailoverState {
    return ctx.sessionProjections.stateOf(agent.session, 'llmFailover') as LlmFailoverState
  }

  /**
   * Switch the agent onto the first usable fallback route for its failing
   * route. Returns `{ kind: 'retry' }` after recording the switch durably, or
   * `undefined` when no chain matches or no candidate is usable.
   */
  async function trySwitch(
    agent: Agent,
    turn: number,
    step: number,
    current: { provider: string; model: string },
    failure: LlmFailure,
    signal: AbortSignal,
  ): Promise<RequestErrorAction> {
    const state = stateOf(agent)
    const chainSoFar = overrideChain(state.overrides, current)
    const original = chainSoFar[0] ?? current
    const chain = matchingChain(resolved.chains, original) ?? matchingChain(resolved.chains, current)
    if (chain === undefined) return undefined
    for (const candidate of chain.to) {
      if (chainSoFar.some(route => sameRoute(route, candidate))) continue
      if (!await routeUsable(ctx.llm, candidate, signal)) continue
      if (signal.aborted || lifetime.signal.aborted) return undefined
      agent.session.append('llm/failover', { turn, step, from: { ...current }, to: { ...candidate }, failure })
      return { kind: 'retry' }
    }
    return undefined
  }

  async function recover(
    { agent, turn, step, provider, failure, signal }: Parameters<Events['agent/request-error']>[0],
    next: () => Promise<RequestErrorAction>,
  ): Promise<RequestErrorAction> {
    const fusedSignal = AbortSignal.any([signal, lifetime.signal])
    if (fusedSignal.aborted) return undefined
    // Downstream recovery owns the failure first: a mounted dsh-llm-retry
    // consumes its own budget before failover adds retries or switches.
    const downstream = await settleDownstream(next)
    if (fusedSignal.aborted) return undefined
    if (downstream.type === 'error') {
      ctx.logger.warn(
        `llm-failover: provider "${provider}" failover ignored a downstream recovery failure: %o`,
        downstream.error,
      )
    }
    if (downstream.type === 'decision' && downstream.decision?.kind === 'retry') {
      return downstream.decision
    }
    const model = agent.session.requestHeader()?.config.model
    if (model === undefined) return downstream.type === 'decision' ? downstream.decision : undefined
    const current = { provider, model }

    if (resolved.switchCodes.includes(failure.code)) {
      return await trySwitch(agent, turn, step, current, failure, fusedSignal)
    }
    if (!resolved.retryCodes.includes(failure.code)) {
      return downstream.type === 'decision' ? downstream.decision : undefined
    }
    const attempts = stateOf(agent).attempts[routeKey(current)] ?? 0
    if (attempts >= resolved.maxRetries) {
      return await trySwitch(agent, turn, step, current, failure, fusedSignal)
    }
    const retry = attempts + 1
    const delayMs = localDelay(resolved, retry, random)
    agent.session.append('llm/failover-retry', {
      turn,
      step,
      route: { ...current },
      retry,
      maxRetries: resolved.maxRetries,
      delayMs,
      failure,
    })
    if (!await cancellableDelay(delayMs, fusedSignal)) return undefined
    return { kind: 'retry' }
  }

  const disposeErrorListener = ctx.on('agent/request-error', (
    payload,
    next: () => Promise<RequestErrorAction>,
  ) => {
    // A waterfall may have captured this callback before its registration was
    // removed. Lifetime cancellation must prevent that stale callback from
    // entering a downstream policy after disposal.
    if (lifetime.signal.aborted) return Promise.resolve<RequestErrorAction>(undefined)
    return track(recover(payload, next))
  })

  // Rewrite the upcoming request's route onto the durably recorded failover
  // target. The loop re-runs this waterfall for every retried step, so the
  // recorded switch takes effect on the very next attempt.
  const disposeRequestListener = ctx.on('agent/request', async (payload, next): Promise<LlmCallConfig> => {
    const resolvedConfig = await next()
    const target = resolveOverride(
      stateOf(payload.agent).overrides,
      { provider: resolvedConfig.provider, model: resolvedConfig.model },
    )
    if (target === undefined) return resolvedConfig
    const { reasoningEffort: _inheritedEffort, ...withoutInheritedEffort } = resolvedConfig
    return {
      ...withoutInheritedEffort,
      provider: target.provider,
      model: target.model,
      ...target.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(target.reasoningEffort) },
    }
  })

  ctx.effect(() => async () => {
    disposeErrorListener()
    disposeRequestListener()
    lifetime.abort(new Error('llm-failover plugin disposed'))
    await Promise.allSettled([...active])
  }, 'llm-failover: abort and drain active recovery')
}
