import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import TeamService from '../../agent-team/src/index.ts'
import * as toolTeam from '../src/index.ts'
import {
  candidateAgentOptions,
  matchTaskRule,
  resolveTaskRoute,
  type TaskRoutingConfig,
} from '../src/task-router.ts'

const SIGNAL = new AbortController().signal

/** Minimal LLM runtime stub: the named providers are registered, `resolveCallConfig` rejects the given routes. */
function stubLlm(providers: string[], rejects: string[] = []): LlmRuntime {
  return {
    listProviders: () => providers.map(id => ({ id, name: id })),
    listModels: () => Promise.resolve([]),
    resolveCallConfig: (config: { provider: string; model: string }) => {
      if (rejects.includes(`${config.provider}/${config.model}`)) {
        return Promise.reject(new Error(`unknown model ${config.model}`))
      }
      return Promise.resolve(config)
    },
  } as unknown as LlmRuntime
}

const ROUTING: TaskRoutingConfig = {
  rules: [
    {
      taskType: 'coding',
      keywords: ['code', 'implement', 'bug'],
      routes: [
        { provider: 'unregistered', model: 'gone' },
        { provider: 'fast', model: 'fast-model', reasoningEffort: 'low' },
      ],
    },
    {
      taskType: 'research',
      keywords: ['research', 'survey'],
      routes: [{ provider: 'deep', model: 'deep-model' }],
    },
  ],
  fallbackRoutes: [{ provider: 'fast', model: 'fallback-model' }],
}

describe('task router', () => {
  it('prefers an exact task_type hint over keywords', () => {
    const rule = matchTaskRule(ROUTING, 'research', 'implement the parser')
    expect(rule?.taskType).toBe('research')
  })

  it('matches the first rule whose keyword appears in the delegation text', () => {
    expect(matchTaskRule(ROUTING, undefined, 'fix the bug in the parser')?.taskType).toBe('coding')
    expect(matchTaskRule(ROUTING, undefined, 'survey related work')?.taskType).toBe('research')
    expect(matchTaskRule(ROUTING, undefined, 'water the plants')).toBeUndefined()
  })

  it('skips candidates whose provider is not registered or whose model does not resolve', async () => {
    const llm = stubLlm(['fast', 'deep'])
    const route = await resolveTaskRoute(llm, ROUTING, undefined, 'implement the parser', SIGNAL)
    expect(route).toEqual({ provider: 'fast', model: 'fast-model', reasoningEffort: 'low' })
  })

  it('rejects candidates that fail exact-model resolution', async () => {
    const llm = stubLlm(['fast', 'deep'], ['fast/fast-model'])
    const route = await resolveTaskRoute(llm, ROUTING, undefined, 'implement the parser', SIGNAL)
    expect(route).toEqual({ provider: 'fast', model: 'fallback-model' })
  })

  it('falls back to fallbackRoutes when no rule matches', async () => {
    const llm = stubLlm(['fast'])
    const route = await resolveTaskRoute(llm, ROUTING, undefined, 'water the plants', SIGNAL)
    expect(route).toEqual({ provider: 'fast', model: 'fallback-model' })
  })

  it('returns undefined when routing is disabled or nothing is usable', async () => {
    const llm = stubLlm(['fast'])
    expect(await resolveTaskRoute(llm, { rules: [], fallbackRoutes: [] }, undefined, 'code', SIGNAL)).toBeUndefined()
    const none = stubLlm([])
    expect(await resolveTaskRoute(none, ROUTING, undefined, 'implement the parser', SIGNAL)).toBeUndefined()
  })

  it('converts a selected route into child agent options', () => {
    expect(candidateAgentOptions({ provider: 'fast', model: 'fast-model' })).toEqual({
      provider: 'fast',
      model: 'fast-model',
    })
    expect(candidateAgentOptions({ provider: 'fast', model: 'fast-model', reasoningEffort: 'low' })).toEqual({
      provider: 'fast',
      model: 'fast-model',
      reasoningEffort: 'low',
    })
  })
})

/** Session query implementation whose search faces are outside these tests. */
class TestSessionQuery extends SessionQueryEngine {
  override searchSessions(): Promise<never> {
    return Promise.reject(new Error('session search is not configured in this test'))
  }

  override searchEvents(): Promise<never> {
    return Promise.reject(new Error('event search is not configured in this test'))
  }
}

const roots: string[] = []
const contexts = new Set<Context>()
let callNumber = 0

afterEach(async () => {
  for (const ctx of contexts) await ctx.fiber.dispose()
  contexts.clear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function setup(script: ConstructorParameters<typeof MockAdapter>[0], config: toolTeam.Config = {}) {
  const ctx = new Context()
  contexts.add(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-tool-team-router-'))
  roots.push(storageRoot)
  await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(SubagentFork, { providerName: 'fork' })
  await ctx.plugin(TeamService)
  await ctx.plugin(toolTeam, config)
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock', 'fast'], adapter)
  const lead = await ctx.agentLoop.create(SessionId('router-lead'), { provider: 'mock', model: 'lead-model' })
  return { ctx, lead, adapter }
}

function execute(ctx: Context, agent: Agent, name: string, args: unknown) {
  return ctx.tools.execute({
    callId: ToolCallId(`router-call-${++callNumber}`),
    name,
    arguments: args,
    signal: SIGNAL,
    agent,
  })
}

describe('spawn_teammate task routing', () => {
  /** Wait until the teammate's first model request hits the shared adapter and return it. */
  async function childRequest(adapter: MockAdapter) {
    await vi.waitFor(() => { expect(adapter.requests.length).toBeGreaterThan(0) }, { timeout: 5_000 })
    return adapter.requests[0]!
  }

  it('creates the teammate on the routed model when a rule matches', async () => {
    const { ctx, lead, adapter } = await setup([textResponse('ok')], {
      taskRouting: {
        rules: [{
          taskType: 'coding',
          keywords: ['implement'],
          routes: [{ provider: 'fast', model: 'fast-model' }],
        }],
        fallbackRoutes: [],
      },
    })
    const spawned = await execute(ctx, lead, 'spawn_teammate', {
      name: 'coder',
      description: 'implement the parser',
      prompt: 'Implement the recursive descent parser.',
    })
    expect(spawned.isError).toBe(false)
    const request = await childRequest(adapter)
    expect(request.provider).toBe('fast')
    expect(request.model).toBe('fast-model')
  })

  it('inherits the Lead route when routing is not configured', async () => {
    const { ctx, lead, adapter } = await setup([textResponse('ok')])
    const spawned = await execute(ctx, lead, 'spawn_teammate', {
      name: 'helper',
      description: 'implement the parser',
      prompt: 'Implement the recursive descent parser.',
    })
    expect(spawned.isError).toBe(false)
    const request = await childRequest(adapter)
    expect(request.provider).toBe('mock')
    expect(request.model).toBe('lead-model')
  })

  it('uses the task_type hint when no keyword matches', async () => {
    const { ctx, lead, adapter } = await setup([textResponse('ok')], {
      taskRouting: {
        rules: [{
          taskType: 'research',
          keywords: ['survey'],
          routes: [{ provider: 'fast', model: 'fast-model' }],
        }],
        fallbackRoutes: [],
      },
    })
    const spawned = await execute(ctx, lead, 'spawn_teammate', {
      name: 'scout',
      description: 'look into prior art',
      prompt: 'Collect relevant prior art.',
      task_type: 'research',
    })
    expect(spawned.isError).toBe(false)
    const request = await childRequest(adapter)
    expect(request.provider).toBe('fast')
    expect(request.model).toBe('fast-model')
  })
})
