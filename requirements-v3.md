# dsh 集群插件需求清单 v3

插件名暂定 `dsh-node-agent`，作为 out-of-tree Cordis 插件加载进 `dsh web` 的 Host 进程。

> **v3 变更说明（v2 → v3）**：基于真实 ClusterLinkHub 契约与实测结果全面改写协议相关部分。v3 之前的协议假设（RegisterNode/Heartbeat 带参/TaskAccepted/TaskRejected/TaskEvent/TaskCompleted/DispatchTask/CancelTask）**全部作废**，以本版 §3 为准。
>
> 1. **Hub 是 ClusterLinkHub**（ASP.NET Core SignalR，`<base>/cluster-link/hub`），方法名小驼峰且**大小写敏感**，JSON 字段 camelCase
> 2. **鉴权**：节点 Key（Bearer token，`access_token` 查询参数或 Authorization 头），**在 `registerNode` 时校验**（连接层不校验）；Key 禁止写入日志/遥测/异常文本
> 3. **`registerNode`** 载荷为 `{ nodeId(正整数串), link: { protocol: 'dsh', version } }`——**不再上报 capabilities/maxConcurrency**（v2 假设作废）
> 4. **`heartbeat` 无参数**（v2 的 `{activeTasks, ts}` 作废）
> 5. **没有 TaskAccepted/TaskRejected/TaskCompleted 方法**——接受/拒绝/进度/完成全部走 **`reportTaskEvent`（kind: started/progress/completed/failed）**
> 6. **没有 CancelTask**——hub 明确不支持任务取消，**插件取消功能删除**
> 7. **`taskDispatched`**（hub→节点）取代 DispatchTask；**`taskEventReceived`** 是 **hub 范围广播**（会收到所有节点事件，必须按 taskId 过滤）
> 8. **新增 A2A**：`sendA2AMessage` / `a2aMessageReceived`，文档示例的派发模式是 `type: "task.request"`——插件需支持 A2A 任务接入（与 taskDispatched 双通道）
> 9. **`SUNSET_NODE_ID` 必填**（管理端预配置的正整数），v2 的 `node-{pid}` 默认值作废

---

## 1. 功能需求

### 1.1 连接管理
- 插件启动（`apply`）即建立与 ClusterLinkHub 的 SignalR 连接（WebSockets + `skipNegotiation`，Node 22.4+ 原生 WebSocket，`@microsoft/signalr` 为插件自带依赖）
- 支持自动重连，**重连成功后必须重新 `registerNode`**（服务端连接映射不持久化，断开即离线）
- 提供连接状态查询（已连接/正在连接/已断开/重连中）
- 插件卸载（`ctx.effect` 清理）时主动断开连接
- 配置（环境变量）：`SUNSET_HUB_URL`、`SUNSET_NODE_TOKEN`（节点 Key，必填）、`SUNSET_NODE_ID`（必填，正整数串）、`SUNSET_MAX_CONCURRENCY`

### 1.2 节点注册与心跳
- 连接建立后调用 **`registerNode`**：`{ nodeId: SUNSET_NODE_ID, link: { protocol: 'dsh', version: <dsh 版本> } }`，成功返回 `ClusterNodeSnapshot`
- `link.protocol` 固定 `'dsh'`（大小写规范化小写，须与管理端配置一致）
- 定期（默认 30s，文档建议 30–60s）调用 **`heartbeat`（无参数）**，成功返回 `ClusterNodeSnapshot`
- `reportTaskEvent` 会隐式更新心跳，但插件仍独立发送 heartbeat（避免管理端显示长期未心跳）
- 节点信息变更（如 dsh 版本变化）时重注册（registerNode 的 `link.version` 非空会更新服务端保存的版本）
- **Key 处理**：Key 只经 `accessTokenFactory` 注入，绝不写入日志/遥测/异常文本/事件载荷；生产传输必须 HTTPS

### 1.3 任务接收与执行
- **双通道接入**（都需在 `start()` 前注册 handler）：
  - `taskDispatched`：`{ taskId, prompt, metadata? }`
  - `a2aMessageReceived`：`ClusterA2AMessageEnvelope`，`type === 'task.request'` 时按任务处理（`correlationId` 即任务关联 ID，`payload.prompt` 为指令）
- 收到任务后通过 `ctx.agents.create({ sessionId, meta, agentOptions, setup })` 创建 agent 会话（参考 `dsh-headless`），`sessionId` 直接复用 `taskId`；投递 prompt 用 `agent.followup(createUserMessage(...))`
- 接受/拒绝回执**不走 RPC**，统一 `reportTaskEvent`：
  - 开始执行 → `kind: 'started'`
  - 并发超限 → `kind: 'failed'`，`message: 'max concurrency reached'`（拒绝而非排队）
  - `agents.create` 失败 → `kind: 'failed'`，`message` 带失败原因
- **无任务取消**（hub 契约不支持）；任务只能由节点自己执行到终态
- 超并发计数：task-registry 中 `running` 状态任务数

### 1.4 事件回流
- 订阅 `session/event`（`(session, event)`），只转发本插件创建的会话（按 sessionId == taskId 过滤）
- **转发通道**：`reportTaskEvent` 单事件调用 `{ taskId, kind, message?, data?, timestampUtc? }`
  - kind 映射（调用方约定）：`started`（任务开始）/ `progress`（轮次/步骤/工具事件）/ `completed` / `failed`
  - **事件白名单**（转 progress）：`turn/start`、`turn/end`、`step/start`、`step/end`、`tool/call`、`tool/result`；可选 `agent/status`、`subagent/start`、`subagent/end`
  - **不转**：`assistant/chunk`（token 级）、`user/message` 正文（prompt 不出节点）
  - 批量与序号：聚合窗口内（默认 100ms）把多个事件放入 `data: { seq, events: [{type, ts, payload}] }`，`kind: 'progress'`；`seq` 为 per-task 转发序号，断线缓冲存原始事件+入队序号，重连后从断点续发
- **广播过滤**：`taskEventReceived` 是 hub 范围广播，插件会收到**所有节点**的任务事件——客户端（UI）与事件缓冲都须按本节点 taskId 过滤，不转发他人事件
- 事件节流后单任务每秒事件数 < 20 条（白名单 + 聚合天然满足）

### 1.5 任务完成判定
- 完成判定：`await agent.whenIdle()` 收敛后取最后一个 `turn/end` 的 `data.reason`
- 完成回执 = `reportTaskEvent`：
  - `kind: 'completed'`，`data: { finalResponse, finishReason: 'completed' }`
  - `kind: 'failed'`，`data: { finishReason: 'error'|'blocked'|'aborted', error? }`
  - finishReason 枚举：`completed` / `error`（turn/end reason.kind='error'）/ `blocked`（reason.kind='blocked'，approval 挂起、maxTokens 等）/ `aborted`（reason.kind='aborted'）
- 最终回复文本：最后一条 `assistant/message` 的 text 块聚合

### 1.6 全局侧栏 UI（Client 端）
- **入口**：注册 `sidebar.footer.action` 槽位（list 槽），参考 `dsh-client-ui-cordis` 的 cordis-panel；"集群"入口渲染自己的面板
- 页面内容：
  - **连接状态卡片**：hub 地址、连接状态、节点 ID（SUNSET_NODE_ID）、dsh 版本、最大并发
  - **活跃任务列表**：任务 ID、会话链接、已运行时长、当前步骤（来自 task-registry 的 started/progress 状态）
  - **实时日志**：连接事件、任务事件、错误日志（最近 500 条），支持按级别过滤（info/warn/error）
- **数据通道**：一律**轮询** Host 侧 `clusterService` remote 方法（500ms–1s）；`ctx.remote.$on` 白名单封闭，无法推送自定义事件
- **client 半场要求**：package.json `dsh.client = { platform:'web', inject:[...] }` + exports `./client`；esbuild 预构建 CJS bundle（`window.__ModuleLoader__.load`，react 与 `@deepseek-ai/*` external）；Host 的 `dsh-client-modules` 经 `/plugins/<name>/client.js` 提供
- **任务事件展示**：taskEventReceived 过滤后的本节点事件驱动日志与任务状态（经 clusterService 汇总）

---

## 2. 非功能需求

### 2.1 可靠性
- 网络闪断：进程存活前提下，进行中的 agent 会话不受连接影响；重连后重新 `registerNode`，断线期间事件进本地缓冲（`SUNSET_EVENT_BUFFER_SIZE` 条，超限丢最旧），重连后从 per-task seq 断点续发
- **服务端边界**：连接断开后服务端立即标节点离线；连接映射不持久化；同一 nodeId 新连接取代旧连接——插件重连即重注册即可
- **进程重启**：插件内存态（连接、task-registry、缓冲）丢失；被持久化的会话仍在但不再执行。重启后对曾派发但未完成的任务上报 `reportTaskEvent(kind:'failed', message:'node restarted')`（首版不做任务持久化恢复）
- 插件自身异常不影响 dsh Host：apply 只注册 effect，所有异步路径顶层 try/catch + 错误隔离；Cordis 对 listener 异常隔离，apply 同步抛错不隔离
- 事件发送失败本地缓冲补发（同上）

### 2.2 性能
- 单节点 ≥4 并发任务（默认值，可配）
- 事件回流延迟 < 200ms（dsh 事件发生 → hub 收到）
- 聚合后单任务每秒事件数 < 20 条

### 2.3 可观测性
- 结构化日志（节点 ID、任务 ID 上下文），复用 `ctx.logger`，同时写内存环形缓冲（UI 轮询）
- 关键指标：连接时长、已处理任务数、失败任务数、事件发送成功率

### 2.4 安全性
- 节点 Key（Bearer token）经 `accessTokenFactory` 注入；**禁止**写入日志、遥测、异常文本、A2A 消息、事件 data
- 生产环境 Hub 必须 HTTPS（access_token 走查询参数时不加密传输即泄露）
- 任务 prompt 不写入本地日志；`user/message` 正文不出节点（§1.4）
- 不暴露任何对外监听端口（只出站连 hub）

---

## 3. Hub 协议契约（真实 ClusterLinkHub，已实测）

Hub 路由：`<server-base-url>/cluster-link/hub`（实测 `http://192.168.31.188:5080/cluster-link/hub`）
方法名**大小写敏感**，JSON 字段 **camelCase**。节点协议：`dsh` / `index`。

### 3.1 节点 → hub（client 调用）

| 方法 | 载荷 | 返回 | 说明 |
|---|---|---|---|
| `registerNode` | `{ nodeId: "12", link: { protocol: "dsh", version?: "1.0.0", displayName?, content? } }` | `ClusterNodeSnapshot` | 每个新连接必须调用一次；Key 在此时校验 |
| `heartbeat` | 无参 | `ClusterNodeSnapshot` | 更新最后心跳时间 |
| `reportTaskEvent` | `{ taskId, kind, message?, data?, timestampUtc? }` | 无 | 上报任务事件；隐式更新心跳；广播给所有连接 |
| `sendA2AMessage` | `{ toNodeId, type, correlationId?, payload? }` | `ClusterA2AMessageEnvelope` | 目标须已配置且在线；成功投递才返回 |

### 3.2 hub → 节点（推送，start() 前注册 handler）

| 事件 | 载荷 | 说明 |
|---|---|---|
| `taskDispatched` | `{ taskId, prompt, metadata? }` | 协调器下发任务 |
| `taskEventReceived` | `ClusterTaskEvent`（同 reportTaskEvent 请求） | **hub 范围广播**，须按 taskId 过滤 |
| `a2aMessageReceived` | `ClusterA2AMessageEnvelope` | 定向 A2A；`type: "task.request"` 为文档示例派发模式 |

### 3.3 DTO（camelCase）

```text
LinkInfo                { protocol: string, displayName?: string|null, version?: string|null, content?: string|null }
ClusterNodeRegistration { nodeId: string(正整数), link: LinkInfo }
ClusterNodeSnapshot     { nodeId, link, connectionId: string|null, registeredAtUtc, lastHeartbeatUtc: datetime|null, key: string|null(敏感，勿用) }
ClusterTaskDispatch     { taskId, prompt, metadata?: object|null }
ClusterTaskEvent        { taskId, kind, message?: string|null, data?: object|null, timestampUtc: datetime }
ClusterA2AMessage       { toNodeId, type, correlationId?: string|null, payload?: object|null }
ClusterA2AMessageEnvelope { messageId, fromNodeId, toNodeId, type, correlationId: string|null, payload: object|null, timestampUtc }
```

### 3.4 失败边界（文档确认）

- 未带 Key / nodeId 不存在或非正整数 / Key 或 protocol 不匹配 → 注册失败
- 未注册就 heartbeat / reportTaskEvent / sendA2AMessage → 调用失败
- 目标节点不存在或离线 → sendA2AMessage 失败，不暂存
- 连接断开 → 节点立即离线，需重连后重注册
- **无**：任务 ack、取消、查询、重放、离线队列（取消功能不可实现）
- Hub 无机器可读错误码，客户端不解析异常消息驱动业务分支

---

## 4. 配置项

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `SUNSET_HUB_URL` | `http://localhost:5080/cluster-link/hub` | ClusterLinkHub 地址 |
| `SUNSET_NODE_TOKEN` | - | 节点 Key（Bearer token，**必填**；禁止日志化） |
| `SUNSET_NODE_ID` | - | 管理端预配置的**正整数**节点 ID（字符串，**必填**） |
| `SUNSET_MAX_CONCURRENCY` | `4` | 最大并发任务数（本地并发控制；不随注册上报） |
| `SUNSET_HEARTBEAT_INTERVAL_MS` | `30000` | 心跳间隔（文档建议 30–60s） |
| `SUNSET_EVENT_BATCH_MS` | `100` | 事件聚合窗口 |
| `SUNSET_EVENT_BUFFER_SIZE` | `1000` | 事件缓冲上限（断线时） |
| `SUNSET_LOG_BUFFER_SIZE` | `500` | UI 日志缓冲条数 |

---

## 5. 工程结构

```
dsh-node-agent/
├── package.json                # dsh.client 声明（platform: web, inject）+ @microsoft/signalr 依赖
├── tsconfig.json
├── cordis.yml                  # patch overlay 配置（条目 name 用插件绝对路径）
├── README.md                   # 安装与配置说明
├── build-client.mjs            # esbuild 预构建 client 半场为 CJS bundle
├── Dockerfile                  # 部署配方（版本锁定 + 依赖去重 + 预构建）
└── src/
    ├── index.ts                # Host 入口，插件 apply
    ├── client.tsx              # Client 入口，注册侧栏 UI（产物 lib/client.js）
    ├── cluster-view.tsx        # 侧栏页面组件
    ├── connection/
    │   ├── hub-connection.ts   # SignalR 连接管理（registerNode/heartbeat/reportTaskEvent/sendA2AMessage）
    │   └── reconnect-policy.ts # 重连策略（重连后自动重注册）
    ├── task/
    │   ├── task-intake.ts      # taskDispatched + a2a(task.request) 双通道接入，agents.create
    │   ├── task-registry.ts    # 任务-会话映射（sessionId == taskId）与并发计数
    │   └── task-completion.ts  # 完成判定（turn/end reason → finishReason）
    ├── events/
    │   ├── event-relay.ts      # session/event 订阅、白名单过滤、脱敏
    │   ├── event-batcher.ts    # 聚合进 reportTaskEvent(kind: progress) 的 data
    │   └── event-buffer.ts     # 断线缓冲（原始事件 + per-task seq）
    ├── services/
    │   ├── cluster-service.ts  # TypertRemoteService：供 UI 轮询（@Remote 方法）
    │   └── log-buffer.ts       # 日志环形缓冲区
    └── protocol.ts             # 真实契约类型定义（§3 DTO）
```

---

## 6. 部署与加载

### 6.1 加载方式
- `dsh web --patch <插件目录>/cordis.yml`；条目 `name` 用插件绝对路径
- 或写入 profile 的 `cordis.patch.yml` / `$DSH_HOME/cordis.patch.yml` 持久生效

### 6.2 Docker 组装（版本锁定 + 依赖身份去重）

```dockerfile
FROM node:22-slim
RUN npm i -g @deepseek-ai/dsh@0.1.0-rc.7        # 必须与开发版本一致
COPY dsh-node-agent /opt/dsh-node-agent
WORKDIR /opt/dsh-node-agent
RUN npm install --omit=dev && node build-client.mjs
RUN ln -s /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai \
          /opt/dsh-node-agent/node_modules/@deepseek-ai   # 依赖身份去重（@Remote WeakMap）
CMD ["dsh", "web", "--patch", "/opt/dsh-node-agent/cordis.yml"]
```

- `SUNSET_*` 环境变量经 docker-compose 注入；生产 Hub 用 HTTPS

---

## 7. 验收标准

- [ ] 插件加载无报错，启动后连接 hub 并 `registerNode` 成功（返回 ClusterNodeSnapshot）
- [ ] hub 下发任务（`taskDispatched` 或 A2A `task.request`）后，dsh web-ui 会话列表出现对应会话（sessionId == taskId）
- [ ] 会话正常执行 agent 循环，web-ui 实时可见
- [ ] 关键事件（轮次/步骤边界、工具调用）经 `reportTaskEvent` 按白名单回流；`taskEventReceived` 广播中只处理本节点任务，他人事件不转发
- [ ] 任务终态上报 `reportTaskEvent`（completed/failed + finishReason），hub 收到并广播
- [ ] 断开网络重连后，节点自动重注册，进行中的任务不受影响，断线期间事件按 seq 续发
- [ ] 超过并发上限时新任务 `reportTaskEvent(kind:'failed')` 拒绝，不排队阻塞；`agents.create` 失败同样上报 failed
- [ ] A2A 往返可用（sendA2AMessage 成功投递 + a2aMessageReceived 收到）
- [ ] 插件卸载时连接干净断开，存活任务先停止后 dispose，不残留
- [ ] web-ui 侧栏"集群"入口显示连接状态、活跃任务、实时日志（轮询）；Host 断开时 UI 离线态并自动恢复
- [ ] 进程重启后，插件如实上报未完成任务 failed（'node restarted'），不静默丢任务
- [ ] Key 不出现在任何日志/遥测/异常文本/事件载荷中

---

## 8. Spike 验证记录（真实 hub 实测完成）

> 实测目标：`http://192.168.31.188:5080/cluster-link/hub`，节点 nodeId=1（displayName "deepseek-1"，protocol dsh），Key `738af6...`，Node v24.19.0 + `@microsoft/signalr@8.0.7`。

| 验证项 | 结果 |
|---|---|
| `skipNegotiation + WebSockets` 连接（access_token 查询参数） | ✅ |
| `registerNode` → ClusterNodeSnapshot（nodeId/link/connectionId/时间戳/key 回显） | ✅ |
| `heartbeat`（无参）→ 快照，lastHeartbeatUtc 更新 | ✅ |
| `reportTaskEvent`（started/completed） | ✅ |
| `taskEventReceived` 广播回环（含发送者，收到自己上报的事件） | ✅ |
| `sendA2AMessage` 自环 → envelope + `a2aMessageReceived` 推送（messageId 生成） | ✅ |
| 方法名/字段 camelCase 契约 | ✅ |
| Key 未配置时 registerNode 失败（服务端内部错误）→ 配置后成功 | ✅ |
| `taskDispatched` 推送 | ⏳ 需协调器真实下发才能验证（handler 已注册，协议已确认） |

**结论：spike 全部通过**（除 taskDispatched 需协调器触发）。剩余两项开发期验证：client 端 `ctx.remote.$mount` strict codec 手写描述符（或退裸 RPC）、dsh web 加载插件后的端到端（开发实例 + patch）。
