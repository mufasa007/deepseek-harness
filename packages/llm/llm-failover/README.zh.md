---
description: "面向用户与维护者的跨提供方模型降级说明：按路由有界重试，然后持久切换到下一条可用的备用路由，包括其他厂商的模型。"
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-failover

[English](README.md) | 中文

## 概述

挂载 `@deepseek-ai/dsh-llm-failover` 后，当某条模型路由停止服务——余额耗尽（`QUOTA`/`ACCOUNT_QUOTA`）、账户被封或凭据被拒（`AUTH`/`INVALID_CREDENTIAL`/`MISSING_CREDENTIAL`）、持续的网络或服务端故障——agent 轮次仍能继续。暂时性失败按 `maxRetries`（默认 5 次）在原地有界退避重试；永久性失败跳过等待。当路由的预算耗尽——或失败立即永久——插件会把 agent 持久切换到配置的降级链中下一条可用路由（可以属于另一家提供方），loop 再基于同一份持久历史重跑失败步骤。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

当部署配置了多个提供方、且希望 agent 运行在某一厂商宕机、额度耗尽或账户异常时自动迁移到备用路由时，选择本包。当部署只有一个提供方时跳过它——没有降级链时本插件不改变任何行为；只需要原地重试时请用 [dsh-llm-retry](../llm-retry/README.zh.md)。

### 最小配置

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

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxRetries` | `5` | 切换前每条路由的 failover 自有原地重试次数 |
| `retryCodes` | `EMPTY_RESPONSE`、`RATE_LIMIT`、`SERVER`、`TIMEOUT`、`TRANSPORT` | 消耗重试预算的暂时性失败码 |
| `switchCodes` | `AUTH`、`ACCOUNT_QUOTA`、`QUOTA`、`INVALID_CREDENTIAL`、`MISSING_CREDENTIAL` | 立即切换的永久性失败码 |
| `backoff` | `1000ms → 30000ms`，抖动 `0.2` | failover 自有重试的本地指数退避 |
| `chains` | `[]` | 有序降级链；精确 `from` 优先于仅提供方，再优先于默认链 |

### 你可以观察到什么

每个决策都先持久再生效：一次计划中的原地重试会追加非表层的 `llm/failover-retry` 事件，携带路由、重试序号、延迟与失败；一次路由切换会追加 `llm/failover` 事件，携带 `from` 与 `to` 路由。随后失败步骤重新经过提示词组装与请求路由，切换从下一次尝试起生效，并在会话剩余时间内保持。备用候选只有在提供方已注册适配器、非空模型目录包含该精确模型且 `resolveCallConfig` 校验通过时才算可用；不可用候选按顺序跳过。

### 失败与恢复

当没有链匹配失败路由、或所有候选都不可用时，插件委派下游，原始失败保持终止。取消或插件释放会中止进行中的等待并保持日志一致。插件从不改写模型可见内容：重试与降级事件、延迟与提供方错误都不进入模型表层；路由变化本身则像任何路由变化一样出现在下一条持久请求头中。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计理念

执行器遵循与 [dsh-llm-retry](../llm-retry/README.zh.md) 相同的规则：**先持久、后等待，打开步骤边界，下游优先。** 恢复运行在 agent loop 的 `agent/request-error` waterfall 上；监听器先结算下游恢复，因此已挂载的 `dsh-llm-retry` 会先消耗它自己的按提供方预算，然后 failover 才追加重试或切换。路由切换本身由 `agent/request` waterfall 上的第二个监听器应用——loop 每次重跑失败步骤都会重新经过它：监听器把提议的 provider/model 改写为持久记录的降级目标，并清除继承的路由自有推理强度，让备用模型解析自己的默认值。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 函数插件：两个 waterfall 监听器、链匹配、可用性检查、退避与持久事件追加 |
| [`src/types.ts`](src/types.ts) | 浏览器安全的 `llm/failover-retry` 与 `llm/failover` 事件载荷类型 |

### 状态

每会话状态存放在 `llmFailover` 会话投影中：当前步骤内每条路由的原地重试计数（`step/start` 与 `turn/end` 时重置），以及从每条被放弃路由到其替代路由的覆盖映射。覆盖链会被传递式跟随，因此某条备用路由自身再失败时会沿原始链前进到下一个候选，而不是成环。

### 与 dsh-llm-retry 的组合

同时挂载时，`dsh-llm-retry` 先按各提供方的 `retryPolicy` 重试暂时性失败；failover 只在该策略委派后才观察到失败。这种组合下请把 failover 的 `maxRetries` 设为 `0`，在重试插件预算耗尽后立即切换，而不是叠加第二份预算。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [dsh-llm 服务](../llm/README.zh.md)——本插件路由所依赖的提供方无关服务及其失败码。
- [dsh-llm-retry](../llm-retry/README.zh.md)——同一扩展点上的按提供方原地重试执行器。
- [LLM 流式子系统](../../../docs/subsystems/llm-streaming.zh.md)——`StreamChunk` 协议与终止失败约定。

-----

<a id="model-experience"></a>
## 模型体验

### 模型会看到什么

重试与降级事件、延迟与提供方错误从不对模型可见。路由切换记录在下一条请求头中，成功的 assistant 消息署名其真实的提供方与模型，因此会话记录始终可重建。

#### Token 影响

每次原地重试都是一次新的提供方请求，可能重复输入 token 计费；预算由 `maxRetries` 限定。切换后的步骤改为向备用提供方计费。

#### KV Cache 影响

重建的请求保留此前前缀，可按备用路由自身规则复用提供方缓存；跨提供方切换自然会开启全新缓存。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **agent 轮次是唯一降级边界**——直接 `ctx.llm.stream()` 消费方仍是单次尝试，因为原始流无法持久地区分已发出的分片。
- **切换在会话内是粘性的**——agent 一旦降级，后续步骤保持备用路由；主路由恢复后的自动回切属于延期工作。
- **不做跨 agent 协调**——每个 agent 在各自的第一次硬失败时独立降级；全局性宕机仍会让每个 agent 各付出一次可观察失败。
- **可用性检查停留在元数据层**——通过注册与校验的候选仍可能在请求时失败；该失败会重新进入同一恢复路径。
