import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, LlmAdapter, LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, ResolvedRetryPolicy, RetryPolicyConfig, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as retry from '../../llm-retry/src/index.ts'
import * as failover from '../src/index.ts'

type ScriptEntry = Error | Iterable<StreamChunk> | AsyncIterable<StreamChunk>

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private retryPolicies: Readonly<Record<string, ResolvedRetryPolicy | undefined>> = {}

  constructor(private readonly entries: ScriptEntry[]) {
    super()
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.entries.shift()
    if (entry === undefined) throw new Error('failover test script exhausted')
    if (entry instanceof Error) throw entry
    yield* entry
  }

  configureRetryPolicies(
    policies: Readonly<Record<string, RetryPolicyConfig | undefined>>,
  ): void {
    this.retryPolicies = Object.fromEntries(Object.entries(policies).map(([provider, policy]) => [
      provider,
      policy === undefined
        ? undefined
        : resolveRetryPolicy(policy, `failover test provider "${provider}" retryPolicy`),
    ]))
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    return this.retryPolicies[provider]
  }
}

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

async function harness(
  adapters: Readonly<Record<string, ScriptedAdapter>>,
  config: failover.Config,
  internals: failover.FailoverInternals = {},
  withRetryPlugin = false,
): Promise<{ ctx: Context }> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  if (withRetryPlugin) {
    await ctx.plugin(Object.assign((inner: Context) => {
      retry.apply(inner, {})
    }, { inject: retry.inject }))
  }
  await ctx.plugin(Object.assign((inner: Context) => {
    failover.apply(inner, config, internals)
  }, { inject: failover.inject }))
  await ctx.plugin(AgentLoop, { agents: [] })
  for (const [provider, adapter] of Object.entries(adapters)) {
    ctx.llm.registerAdapter([provider], adapter)
  }
  return { ctx }
}

function waitForEvent<T extends SessionEvent['type']>(
  ctx: Context,
  agent: Agent,
  type: T,
): Promise<Extract<SessionEvent, { type: T }>> {
  return new Promise((resolve) => {
    const dispose = ctx.on('session/event', (session, event) => {
      if (session === agent.session && event.type === type) {
        dispose()
        resolve(event as Extract<SessionEvent, { type: T }>)
      }
    })
  })
}

function followup(agent: Agent, text: string): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

let context: Context | undefined

afterEach(async () => {
  vi.useRealTimers()
  await context?.fiber.dispose()
  context = undefined
})

describe('llm-failover', () => {
  it('switches to a fallback provider immediately on a permanent failure', async () => {
    const primary = new ScriptedAdapter([new LlmError('account suspended', 'AUTH', { status: 401 })])
    const backup = new ScriptedAdapter([textResponse('done')])
    ;({ ctx: context } = await harness({ primary, backup }, {
      chains: [{ from: { provider: 'primary' }, to: [{ provider: 'backup', model: 'backup-model' }] }],
    }))
    const agent = await context.agentLoop.create(SessionId('failover-auth'), {
      provider: 'primary',
      model: 'primary-model',
    })
    const switched = waitForEvent(context, agent, 'llm/failover')

    followup(agent, 'go')
    const event = await switched
    await agent.whenIdle()

    expect(event.data).toMatchObject({
      turn: 1,
      step: 1,
      from: { provider: 'primary', model: 'primary-model' },
      to: { provider: 'backup', model: 'backup-model' },
      failure: { code: 'AUTH' },
    })
    expect(primary.requests).toHaveLength(1)
    expect(backup.requests).toHaveLength(1)
    expect(backup.requests[0]?.provider).toBe('backup')
    expect(backup.requests[0]?.model).toBe('backup-model')
    expect(agent.session.deriveMessages().at(-1)).toMatchObject({
      role: 'assistant',
      source: { provider: 'backup', model: 'backup-model' },
    })
    expect(agent.session.snapshotEvents().filter(item => item.type === 'llm/failover-retry')).toHaveLength(0)
  })

  it('retries a transient failure up to maxRetries before switching', async () => {
    vi.useFakeTimers()
    const primary = new ScriptedAdapter([
      new LlmError('network down', 'TRANSPORT'),
      new LlmError('network down', 'TRANSPORT'),
      new LlmError('network down', 'TRANSPORT'),
    ])
    const backup = new ScriptedAdapter([textResponse('recovered')])
    ;({ ctx: context } = await harness({ primary, backup }, {
      maxRetries: 2,
      backoff: { initialDelayMs: 10, maxDelayMs: 10, jitterRatio: 0 },
      chains: [{ from: { provider: 'primary', model: 'primary-model' }, to: [{ provider: 'backup', model: 'backup-model' }] }],
    }, { random: () => 0.5 }))
    const agent = await context.agentLoop.create(SessionId('failover-transient'), {
      provider: 'primary',
      model: 'primary-model',
    })
    const firstRetry = waitForEvent(context, agent, 'llm/failover-retry')

    followup(agent, 'go')
    expect((await firstRetry).data).toMatchObject({ retry: 1, maxRetries: 2, delayMs: 10 })
    expect(primary.requests).toHaveLength(1)

    const secondRetry = waitForEvent(context, agent, 'llm/failover-retry')
    await vi.advanceTimersByTimeAsync(10)
    expect((await secondRetry).data.retry).toBe(2)
    expect(primary.requests).toHaveLength(2)

    const switched = waitForEvent(context, agent, 'llm/failover')
    const idle = agent.whenIdle()
    await vi.advanceTimersByTimeAsync(10)
    await switched
    await idle

    expect(primary.requests).toHaveLength(3)
    expect(backup.requests).toHaveLength(1)
    expect(agent.session.deriveMessages().at(-1)).toMatchObject({
      role: 'assistant',
      source: { provider: 'backup', model: 'backup-model' },
    })
  })

  it('skips fallback candidates whose provider is not registered', async () => {
    const primary = new ScriptedAdapter([new LlmError('quota exhausted', 'ACCOUNT_QUOTA', { status: 402 })])
    const backup = new ScriptedAdapter([textResponse('done')])
    ;({ ctx: context } = await harness({ primary, backup }, {
      chains: [{
        from: { provider: 'primary' },
        to: [
          { provider: 'ghost', model: 'ghost-model' },
          { provider: 'backup', model: 'backup-model' },
        ],
      }],
    }))
    const agent = await context.agentLoop.create(SessionId('failover-skip'), {
      provider: 'primary',
      model: 'primary-model',
    })
    const switched = waitForEvent(context, agent, 'llm/failover')

    followup(agent, 'go')
    const event = await switched
    await agent.whenIdle()

    expect(event.data.to).toEqual({ provider: 'backup', model: 'backup-model' })
    expect(backup.requests).toHaveLength(1)
  })

  it('leaves the failure terminal when no chain matches', async () => {
    const primary = new ScriptedAdapter([new LlmError('account suspended', 'AUTH')])
    ;({ ctx: context } = await harness({ primary }, {
      chains: [{ from: { provider: 'other' }, to: [{ provider: 'backup', model: 'backup-model' }] }],
    }))
    const agent = await context.agentLoop.create(SessionId('failover-terminal'), {
      provider: 'primary',
      model: 'primary-model',
    })

    followup(agent, 'go')
    await agent.whenIdle()

    expect(primary.requests).toHaveLength(1)
    expect(agent.session.snapshotEvents().filter(item => item.type === 'llm/failover')).toHaveLength(0)
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'error', error: { message: 'account suspended', code: 'AUTH' } } },
    })
  })

  it('keeps the fallback route for later turns once switched', async () => {
    const primary = new ScriptedAdapter([new LlmError('quota exhausted', 'QUOTA', { status: 402 })])
    const backup = new ScriptedAdapter([textResponse('first'), textResponse('second')])
    ;({ ctx: context } = await harness({ primary, backup }, {
      chains: [{ to: [{ provider: 'backup', model: 'backup-model' }] }],
    }))
    const agent = await context.agentLoop.create(SessionId('failover-sticky'), {
      provider: 'primary',
      model: 'primary-model',
    })

    followup(agent, 'go')
    await agent.whenIdle()
    followup(agent, 'again')
    await agent.whenIdle()

    expect(primary.requests).toHaveLength(1)
    expect(backup.requests).toHaveLength(2)
    expect(backup.requests[1]?.provider).toBe('backup')
    expect(agent.session.snapshotEvents().filter(item => item.type === 'llm/failover')).toHaveLength(1)
  })

  it('composes with dsh-llm-retry: provider retries run first, failover switches after exhaustion', async () => {
    vi.useFakeTimers()
    const primary = new ScriptedAdapter([
      new LlmError('busy', 'RATE_LIMIT', { status: 429 }),
      new LlmError('busy', 'RATE_LIMIT', { status: 429 }),
      new LlmError('busy', 'RATE_LIMIT', { status: 429 }),
    ])
    primary.configureRetryPolicies({
      primary: {
        mode: 'normal',
        maxRetries: 2,
        backoff: { initialDelayMs: 500, maxDelayMs: 10_000, jitterRatio: 0 },
      },
    })
    const backup = new ScriptedAdapter([textResponse('done')])
    ;({ ctx: context } = await harness({ primary, backup }, {
      maxRetries: 0,
      chains: [{ from: { provider: 'primary' }, to: [{ provider: 'backup', model: 'backup-model' }] }],
    }, { random: () => 0.5 }, true))
    const agent = await context.agentLoop.create(SessionId('failover-composed'), {
      provider: 'primary',
      model: 'primary-model',
    })
    const firstRetry = waitForEvent(context, agent, 'llm/retry')

    followup(agent, 'go')
    await firstRetry
    const secondRetry = waitForEvent(context, agent, 'llm/retry')
    await vi.advanceTimersByTimeAsync(500)
    await secondRetry
    const switched = waitForEvent(context, agent, 'llm/failover')
    const idle = agent.whenIdle()
    await vi.advanceTimersByTimeAsync(1_000)
    await switched
    await idle

    expect(agent.session.snapshotEvents().filter(item => item.type === 'llm/retry')).toHaveLength(2)
    expect(agent.session.snapshotEvents().filter(item => item.type === 'llm/failover-retry')).toHaveLength(0)
    expect(primary.requests).toHaveLength(3)
    expect(backup.requests).toHaveLength(1)
    expect(agent.session.deriveMessages().at(-1)).toMatchObject({
      role: 'assistant',
      source: { provider: 'backup', model: 'backup-model' },
    })
  })
})
