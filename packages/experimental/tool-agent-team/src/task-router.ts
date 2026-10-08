/**
 * Task-type-aware child LLM routing for teammate delegation.
 *
 * When the deployment declares a routing table, `spawn_teammate` classifies the
 * delegated task — by an explicit `task_type` hint first, then by keyword rules
 * over the description and prompt — and picks the first configured route that is
 * actually usable in the current Harness composition: its provider has a live
 * registered adapter and its exact model resolves through `resolveCallConfig`.
 * Tasks that match no rule fall back to `fallbackRoutes`; when no candidate is
 * available the teammate inherits the Lead's route, exactly as before.
 *
 * @module @deepseek-ai/dsh-experimental-tool-agent-team/task-router
 */

import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'

/** One exact provider/model candidate considered for a task type. */
export interface TaskRouteCandidate {
  /** Registered LLM provider id. */
  readonly provider: string
  /** Provider-owned exact model id. */
  readonly model: string
  /** Optional adapter-owned reasoning effort for this route. */
  readonly reasoningEffort?: string
}

/** Schema shared by the plugin config and its documentation. */
export const TaskRouteCandidateSchema: z<TaskRouteCandidate> = z.object({
  provider: z.string().min(1).required(),
  model: z.string().min(1).required(),
  reasoningEffort: z.string().min(1),
})

/**
 * One keyword rule mapping a task type onto ordered route candidates.
 * The first rule whose `taskType` equals the model's `task_type` hint, or whose
 * any keyword appears in the delegation text, wins; its `routes` are then tried
 * in order and the first usable route is selected.
 */
export interface TaskRouteRule {
  /** Stable rule name matched against the `task_type` tool argument. */
  readonly taskType: string
  /** Case-insensitive substrings looked up in the delegation description and prompt. */
  readonly keywords: string[]
  /** Ordered exact-route candidates; the first usable one wins. */
  readonly routes: TaskRouteCandidate[]
}

/** Schema for {@link TaskRouteRule}. */
export const TaskRouteRuleSchema: z<TaskRouteRule> = z.object({
  taskType: z.string().min(1).required(),
  keywords: z.array(z.string().min(1)).default([]),
  routes: z.array(TaskRouteCandidateSchema).min(1).required(),
})

/** Deployment-owned task routing table for `spawn_teammate`. */
export interface TaskRoutingConfig {
  /** Ordered keyword rules; the first match wins. */
  readonly rules: TaskRouteRule[]
  /** Candidates tried when no rule matched, or a matched rule has no usable route. */
  readonly fallbackRoutes: TaskRouteCandidate[]
}

/** Schema for {@link TaskRoutingConfig}; the shipped default disables routing. */
export const TaskRoutingSchema: z<TaskRoutingConfig> = z.object({
  rules: z.array(TaskRouteRuleSchema).default([]),
  fallbackRoutes: z.array(TaskRouteCandidateSchema).default([]),
})

/** Whether one routing table can select any route at all. */
export function taskRoutingEnabled(routing: TaskRoutingConfig): boolean {
  return routing.rules.length > 0 || routing.fallbackRoutes.length > 0
}

/**
 * Find the rule for one delegation. An explicit `task_type` hint matches
 * `taskType` exactly (case-insensitive) before any keyword scan; otherwise the
 * first rule with a keyword contained in the delegation text wins.
 * @param routing - Deployment routing table.
 * @param taskTypeHint - Optional model-supplied `task_type` argument.
 * @param text - Lowercased delegation description and prompt.
 * @returns the matching rule, if any.
 */
export function matchTaskRule(
  routing: TaskRoutingConfig,
  taskTypeHint: string | undefined,
  text: string,
): TaskRouteRule | undefined {
  const hint = taskTypeHint?.trim().toLowerCase()
  if (hint !== undefined && hint.length > 0) {
    const byHint = routing.rules.find(rule => rule.taskType.toLowerCase() === hint)
    if (byHint !== undefined) return byHint
  }
  return routing.rules.find(rule =>
    rule.keywords.some(keyword => keyword.length > 0 && text.includes(keyword.toLowerCase())))
}

/**
 * Whether one candidate route is usable in the current composition: its
 * provider has a live registered adapter and its exact model resolves through
 * the adapter without I/O.
 * @param llm - Live LLM runtime.
 * @param candidate - Exact route candidate.
 * @param signal - Tool-call cancellation signal.
 */
export async function routeAvailable(
  llm: LlmRuntime,
  candidate: TaskRouteCandidate,
  signal: AbortSignal,
): Promise<boolean> {
  if (!llm.listProviders().some(provider => provider.id === candidate.provider)) return false
  try {
    await llm.resolveCallConfig({
      provider: candidate.provider,
      model: candidate.model,
      ...candidate.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: ReasoningEffortId(candidate.reasoningEffort) },
    }, signal)
    return true
  } catch {
    return false
  }
}

/**
 * Resolve the child LLM route for one delegation. The matched rule's routes are
 * tried in declaration order, then `fallbackRoutes`; the first usable candidate
 * wins. Returns `undefined` when routing is disabled or no candidate is usable,
 * preserving the inherited Lead route.
 * @param llm - Live LLM runtime.
 * @param routing - Deployment routing table.
 * @param taskTypeHint - Optional model-supplied `task_type` argument.
 * @param text - Delegation description and prompt used for keyword matching.
 * @param signal - Tool-call cancellation signal.
 */
export async function resolveTaskRoute(
  llm: LlmRuntime,
  routing: TaskRoutingConfig,
  taskTypeHint: string | undefined,
  text: string,
  signal: AbortSignal,
): Promise<TaskRouteCandidate | undefined> {
  if (!taskRoutingEnabled(routing)) return undefined
  const rule = matchTaskRule(routing, taskTypeHint, text.toLowerCase())
  const candidates = [
    ...rule === undefined ? [] : rule.routes,
    ...routing.fallbackRoutes,
  ]
  for (const candidate of candidates) {
    if (await routeAvailable(llm, candidate, signal)) return candidate
  }
  return undefined
}

/**
 * Convert one selected candidate into child Agent options.
 * @param candidate - Selected exact route.
 * @returns Child Agent options for the continuable-subagent provider.
 */
export function candidateAgentOptions(candidate: TaskRouteCandidate): AgentOptions {
  return {
    provider: candidate.provider,
    model: candidate.model,
    ...candidate.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: ReasoningEffortId(candidate.reasoningEffort) },
  }
}
