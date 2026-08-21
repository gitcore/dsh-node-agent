# dsh 集群插件需求清单 v2

插件名暂定 `dsh-node-agent`，作为 out-of-tree Cordis 插件加载进 `dsh web` 的 Host 进程。

> **v2 变更说明**（基于 dsh 0.1.0-rc.7 源码逐条验证后的修订，v1 → v2）：
>
> 1. **§1.6 数据通道改为轮询**：`ctx.remote.$on` 的 host→client 事件转发是封闭白名单（`API_REMOTE_FORWARDED_EVENTS`，定义在第一方包 `dsh-api-remotes`，out-of-tree 插件无法扩展）。UI 的实时数据一律**轮询** `clusterService` remote 方法（500ms–1s）。
> 2. **§1.3/§1.5 任务接受与完成语义细化**：create 成功后才回 `TaskAccepted`；`finishReason` 扩展为 `completed / aborted(cancelled|other) / blocked / error`；CancelTask 后等 agent 收敛再发完成事件。
> 3. **§1.4 事件白名单 + 脱敏**：显式排除 token 级事件；`user/message` 正文默认不回传 hub。
> 4. **§1.4 seq 语义**：per-task 转发序号，断线缓冲存原始事件+入队序号，重连后续发。
> 5. **§2.1 重启边界**：进程重启后任务必然丢失（会话持久化但不再执行），须如实上报 hub。
> 6. **§5/§6 client 半场构建链路**：esbuild 预构建 CJS bundle + package.json `dsh.client` 声明 + `sidebar.footer.action` 槽位注册；`@microsoft/signalr` 为插件自带依赖。
> 7. **§8 spike 状态更新**：4 条已由源码验证确认，剩 2 条需实测（client 端 strict codec、SignalR 对 hub 实测）。

---

## 1. 功能需求

### 1.1 连接管理
- 插件启动（`apply`）即建立与 sunset `AgentHub` 的 SignalR 连接
- 支持自动重连，重连后自动重新注册节点
- 提供连接状态查询（已连接/正在连接/已断开/重连中）
- 插件卸载（`ctx.effect` 清理）时主动断开连接
- 连接参数通过环境变量配置：
  - `SUNSET_HUB_URL`：hub 地址
  - `SUNSET_NODE_TOKEN`：节点鉴权 token
  - `SUNSET_NODE_ID`：节点唯一标识
  - `SUNSET_MAX_CONCURRENCY`：最大并发任务数
- **v2**：`@microsoft/signalr` 不在 dsh 依赖树中，必须作为插件自身依赖安装（loader 以绝对路径加载插件时，Node 以插件位置为基准解析依赖）；Node 22.4+ 有全局 `WebSocket`，用 `skipNegotiation: true` + WebSockets 传输（需 hub 支持该模式，spike 实测）

### 1.2 节点注册与心跳
- 连接建立后向 hub 发送 `RegisterNode`，上报：
  - 节点 ID
  - dsh 版本
  - 能力标签（`web-ui`）
  - 最大并发数
- 定期（默认 30s）发送心跳，捎带当前负载（活跃任务数）
- 节点信息变更时主动上报

### 1.3 任务接收与执行
- 监听 hub 推送的 `DispatchTask` 消息
- 收到任务后通过 `ctx.agents.create({ sessionId, meta, agentOptions, setup })` 在进程内创建 agent 会话（官方参考：`dsh-headless` 的 `run()`），投递 prompt 用 `agent.followup(createUserMessage(...))`
- **v2**：`agents.create` 成功后才回 `TaskAccepted`（带 sessionId）；create 失败（含并发超限）回 `TaskRejected`（带 reason），避免"接受了但会话没建出来"
- **v2**：sessionId 直接复用 hub 的 taskId（`agents.create` 支持指定 id），省去映射，会话链接天然对应
- 超过最大并发数时拒绝任务（回 `TaskRejected`）
- 支持 `CancelTask` 取消进行中的任务：`agent.cancel({kind:'user'})` → `await agent.whenIdle()` → 发 `TaskCompleted(finishReason: 'cancelled')`（见 §1.5）

### 1.4 事件回流
- 订阅 `session/event`（回调签名 `(session, event)`），只转发本插件创建的会话（按 sessionId 过滤；root ctx 上的订阅是全局的，必须过滤）
- **v2 事件白名单**（显式过滤，防事件风暴）：
  - 必转：`turn/start`、`turn/end`、`step/start`、`step/end`、`tool/call`、`tool/result`
  - 应转：`agent/status`（`{agent, status:'idle'|'running'}`）
  - 可转：`subagent/start`、`subagent/end`
  - **不转**：`assistant/chunk`（token 级）、`assistant/message`、`user/message` 正文
- **v2 脱敏**：`user/message` 事件即使转发也只带元信息（`source.kind` 等），**prompt 正文默认不回传 hub**（与 §2.4 一致；若 hub 业务需要轮次内文，需显式配置开启，默认关）
- 事件节流：50-100ms 窗口聚合批量发送（`SUNSET_EVENT_BATCH_MS` 默认 100）
- **v2 seq 语义**：`TaskEvent.seq` 为 **per-task 单调转发序号**，在转发时分配；断线缓冲存"原始事件 + 入队序号"，重连后从断点续发。注意 dsh 会话日志的 seq 是 per-session 的，不能直接当任务级 seq 用

### 1.5 任务完成判定
- 完成判定：`await agent.whenIdle()` 收敛后，取最后一个 `turn/end` 事件的 `data.reason`
- 完成时推送 `TaskCompleted`，含：
  - 任务 ID
  - 最终回复文本（取最后一条 `assistant/message` 的 text 块聚合）
  - **v2 finishReason 枚举**：`completed`（reason.kind='completed'）/ `cancelled`（reason.kind='aborted' 且由 CancelTask 触发）/ `aborted`（reason.kind='aborted' 其他原因）/ `blocked`（reason.kind='blocked'，如 approval 挂起、maxTokens）/ `error`（reason.kind='error'，携带结构化错误码）
- **v2**：CancelTask 路径的完成事件归属明确——取消后由插件发 `TaskCompleted(finishReason:'cancelled')`，hub 无需单独等回执

### 1.6 全局侧栏 UI（Client 端）
- **v2 入口**：注册 `sidebar.footer.action` 槽位（list 槽，可加条目；`sidebar` 本体是 single occupant 被 ui-sidebar 占据，不可直接注册）。参考实现：`dsh-client-ui-cordis` 的 cordis-panel（`ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({name, id, inject}, ClusterPanel))`）。"集群"入口渲染自己的面板（弹层/模态均可，参考 CordisPanel）
- 页面内容：
  - **连接状态卡片**：hub 地址、连接状态、节点 ID、dsh 版本、最大并发
  - **活跃任务列表**：任务 ID、会话链接、已运行时长、当前步骤
  - **实时日志**：滚动显示连接事件、任务事件、错误日志（最近 500 条）
- 日志支持按级别过滤（info/warn/error）
- **v2 数据通道**：一律**轮询** Host 侧 `clusterService` remote 方法（500ms–1s，UI 卸载时停止轮询；Host 断开时 UI 显示离线态并继续重试）。原因：`ctx.remote.$on` 白名单封闭，无法推送插件自定义事件
- **v2 client 半场要求**：package.json 声明 `dsh.client = { platform:'web', inject:[...] }` + exports `./client`；bundle 必须用 esbuild 预构建为 CJS 格式（`window.__ModuleLoader__.load({id, factory})`，react 与 `@deepseek-ai/*` 全部 external）；Host 的 `dsh-client-modules` 会自动经 `/plugins/<name>/client.js` 提供并注入 `window.__DSH_BOOT__`

---

## 2. 非功能需求

### 2.1 可靠性
- 网络闪断不丢失任务状态：重连后重新注册；**进程存活**前提下，进行中的 agent 会话不受连接影响（agent 与连接解耦），断线期间事件进本地缓冲，重连后续发（最多缓冲 `SUNSET_EVENT_BUFFER_SIZE` 条，超出丢最旧）
- **v2 重启边界**：dsh 进程重启后，插件内存态（连接、task-registry、缓冲）全部丢失；被持久化的会话仍在但不再执行。重启后须向 hub 上报所有"未确认完成"的任务为 `TaskCompleted(finishReason:'error')` 或明确的重启标记（首版不设计任务持久化恢复，成本高）
- 插件自身异常不能影响 dsh Host 进程：apply 只做 effect 注册，所有异步路径（连接、任务处理、事件发送）顶层 try/catch + 错误隔离，异常记日志不抛出（Cordis 对 listener 异常有隔离，但对 apply 同步抛错不隔离，故 apply 必须全程异步安全）
- 事件发送失败时本地缓冲，重连后补发（最多缓冲 N 条，超出丢弃最旧的）

### 2.2 性能
- 单节点支持至少 4 个并发任务（默认值，可配）
- 事件回流延迟 < 200ms（从 dsh 事件发生到 hub 收到）
- 事件聚合后单任务每秒事件数 < 20 条（白名单过滤 + 聚合后天然满足）

### 2.3 可观测性
- 结构化日志（带节点 ID、任务 ID 上下文），复用 `ctx.logger`（Cordis logger 带 scope 前缀），同时写入内存环形缓冲区（供 UI 轮询查询）
- 关键指标：连接时长、已处理任务数、失败任务数、事件发送成功率

### 2.4 安全性
- SignalR 连接使用 token 鉴权（access_token 查询参数，hub 需支持）
- 任务内容不写入本地日志（防 prompt 泄露）
- **v2**：`user/message` 正文默认不回传 hub（§1.4 脱敏）
- 不暴露任何对外监听端口（只出站连 hub）

---

## 3. Hub 协议契约

| 方向 | 方法名 | 载荷 | 说明 |
|---|---|---|---|
| 节点→hub | `RegisterNode` | `{ nodeId, dshVersion, capabilities[], maxConcurrency }` | 连接/重连后注册 |
| 节点→hub | `Heartbeat` | `{ activeTasks, ts }` | 心跳 + 负载 |
| 节点→hub | `TaskAccepted` | `{ taskId, sessionId }` | 任务已接受（create 成功后才发） |
| 节点→hub | `TaskRejected` | `{ taskId, reason }` | 任务被拒绝（并发超限 / create 失败） |
| 节点→hub | `TaskEvent` | `{ taskId, seq, events: [{ type, ts, payload }] }` | 批量事件（per-task 转发序号，白名单过滤） |
| 节点→hub | `TaskCompleted` | `{ taskId, finalResponse, finishReason }` | 任务完成（finishReason: completed/cancelled/aborted/blocked/error） |
| hub→节点 | `DispatchTask` | `{ id, prompt, metadata? }` | 下发任务 |
| hub→节点 | `CancelTask` | `{ taskId }` | 取消任务（取消结果经 TaskCompleted 回执） |

---

## 4. 配置项

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `SUNSET_HUB_URL` | `http://localhost:5080/index/hub/agent` | AgentHub 地址 |
| `SUNSET_NODE_TOKEN` | - | 节点鉴权 token（必填） |
| `SUNSET_NODE_ID` | `node-{pid}` | 节点唯一标识 |
| `SUNSET_MAX_CONCURRENCY` | `4` | 最大并发任务数 |
| `SUNSET_HEARTBEAT_INTERVAL_MS` | `30000` | 心跳间隔 |
| `SUNSET_EVENT_BATCH_MS` | `100` | 事件聚合窗口 |
| `SUNSET_EVENT_BUFFER_SIZE` | `1000` | 事件缓冲上限（断线时） |
| `SUNSET_LOG_BUFFER_SIZE` | `500` | UI 日志缓冲条数 |

---

## 5. 工程结构

```
dsh-node-agent/
├── package.json                # 含 dsh.client 声明（platform: web, inject）
├── tsconfig.json
├── cordis.yml                  # patch overlay 配置
├── README.md                   # 安装与配置说明
├── build-client.mjs            # v2 新增：esbuild 预构建 client 半场为 CJS bundle
└── src/
    ├── index.ts                # Host 入口，插件 apply
    ├── client.tsx              # Client 入口，注册侧栏 UI（构建产物为 lib/client.js）
    ├── cluster-view.tsx        # 侧栏页面组件
    ├── connection/
    │   ├── hub-connection.ts   # SignalR 连接管理
    │   └── reconnect-policy.ts # 重连策略
    ├── task/
    │   ├── task-intake.ts      # 任务接收与会话创建（agents.create）
    │   ├── task-registry.ts    # 任务-会话映射（sessionId == taskId 时退化为簿记）
    │   └── task-completion.ts  # 任务完成判定（turn/end reason → finishReason）
    ├── events/
    │   ├── event-relay.ts      # 事件订阅与转发（白名单过滤 + 脱敏）
    │   ├── event-batcher.ts    # 事件聚合（per-task seq 分配）
    │   └── event-buffer.ts     # 断线缓冲（原始事件 + 入队序号）
    ├── services/
    │   ├── cluster-service.ts  # TypertRemoteService：供 UI 轮询（@Remote 方法）
    │   └── log-buffer.ts       # 日志环形缓冲区
    └── protocol.ts             # 类型定义与契约
```

---

## 6. 部署与加载

### 6.1 加载方式
- 通过 `--patch` 参数加载（Docker 方案推荐）
- 或写入 profile 的 `cordis.patch.yml` 持久生效
- **v2**：loader 条目 `name` 用插件绝对路径（如 `/opt/dsh-node-agent`），保证 `require` 以插件位置解析其自身依赖（`@microsoft/signalr` 等）

### 6.2 Docker 组装
- 基础镜像：`node:22-slim`（22.4+，原生 WebSocket）+ 全局安装指定版本 dsh
- 插件代码复制到 `/opt/dsh-node-agent/`，**先执行 `npm install`（含 `@microsoft/signalr`）和 `node build-client.mjs`（预构建 client bundle）**
- 启动命令：`dsh web --no-open --patch /opt/dsh-node-agent/cordis.yml`
- 环境变量通过 docker-compose 注入

---

## 7. 验收标准

- [ ] 插件加载无报错，启动后自动连接 hub 并注册节点
- [ ] hub 下发任务后，dsh web-ui 会话列表里出现对应会话（sessionId == taskId）
- [ ] 会话正常执行 agent 循环，web-ui 实时可见
- [ ] 关键事件（轮次/步骤边界、工具调用）按白名单实时回流到 hub，`user/message` 正文不出节点
- [ ] 任务完成后 hub 收到 `TaskCompleted`（finishReason 正确区分 completed/blocked/error）
- [ ] 断开网络重连后，节点自动重新注册，进行中的任务不受影响，断线期间事件补发
- [ ] 超过并发上限时新任务被拒绝（`TaskRejected`），而不是排队阻塞；`agents.create` 失败同样拒绝
- [ ] 取消任务能正常终止执行中的会话，并回 `TaskCompleted(finishReason:'cancelled')`
- [ ] 插件卸载时连接干净断开，存活任务先取消后 dispose，不残留
- [ ] **v2** web-ui 侧栏"集群"入口显示连接状态、活跃任务、实时日志（轮询）；Host 断开时 UI 离线态并自动恢复
- [ ] **v2** 进程重启后，插件如实向 hub 上报未完成任务失败，不静默丢任务

---

## 8. Spike 前置验证（开工前必须确认）

> **v2 状态更新**（依据本机 dsh 0.1.0-rc.7 源码验证）：
>
> - ✅ **已验证（源码级确认）**：
>   1. `ctx.agents.create({ sessionId, meta, agentOptions, setup })` + `agent.followup()` + `agent.whenIdle()` + `turn/end` 判定——完整参考实现 `dsh-headless/lib/index.js`
>   2. `session/event` 回调签名 `(session, event)`；`agent/status`、`subagent/start|end` 事件存在
>   3. Typert Remote Host 侧注册：`TypertRemoteService` + `@Remote` 装饰器，gateway SRC-mode 运行时发现，无需编译器
>   4. Client 插件机制：`dsh.client` 声明 + exports `./client` + `dsh-client-modules` 扫描 + `sidebar.footer.action` 槽位注册（参考 `dsh-client-ui-cordis`）
> - 🔴 **需实测（开工第一个做）**：
>   5. client 端 `ctx.remote.$mount` 要求 strict codec（`{mode:'strict', typeSymbol, schema}`）——spike 确认手写 zod strict 描述符可行，否则退回裸 RPC（`ctx.connection`）
>   6. Node 下 `@microsoft/signalr` + `skipNegotiation + WebSockets` 连通真实 AgentHub：方法名/载荷/`access_token` 查询参数/hub 是否支持 skipNegotiation——**hub 已存在，直接实测**
