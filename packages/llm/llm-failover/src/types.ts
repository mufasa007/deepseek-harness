import type { LlmFailure } from '@deepseek-ai/dsh-llm/types'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Durable, non-surface record of one failover-owned retry scheduled after a failed request attempt. */
    'llm/failover-retry': LlmFailoverRetryEventData
    /** Durable, non-surface record of one provider/model route switch after repeated or permanent failure. */
    'llm/failover': LlmFailoverEventData
  }
}

/** One exact provider/model route carried by failover events. */
export interface LlmFailoverRoute {
  provider: string
  model: string
  reasoningEffort?: string
}

/** Durable payload recorded before one failover-owned retry wait. */
export interface LlmFailoverRetryEventData {
  turn: number
  step: number
  /** The route whose request failed and is being retried. */
  route: LlmFailoverRoute
  /** One-based retry ordinal for the route within the current step. */
  retry: number
  /** Configured per-route retry budget. */
  maxRetries: number
  delayMs: number
  failure: LlmFailure
}

/** Durable payload recorded when the plugin switches an agent onto a fallback route. */
export interface LlmFailoverEventData {
  turn: number
  step: number
  /** The route abandoned after repeated or permanent failure. */
  from: LlmFailoverRoute
  /** The fallback route selected from the configured chain. */
  to: LlmFailoverRoute
  failure: LlmFailure
}
