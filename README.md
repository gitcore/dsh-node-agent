# dsh-node-agent

dsh 集群节点插件：将 `dsh web` Host 接入 sunset `ClusterLinkHub`（SignalR），接收任务 → 在进程内创建 dsh agent 会话执行 → 事件/结果经 `reportTaskEvent` 回流。附带 web-ui 侧栏"集群"面板。

- 需求文档：`requirements-v3.md`
- 协议契约：ClusterLinkHub（camelCase，方法名大小写敏感，见 requirements-v3 §3）
- Spike 验证记录：`spike/signalr-report.md`（真实 hub 实测通过）

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `SUNSET_HUB_URL` | `http://localhost:5080/cluster-link/hub` | ClusterLinkHub 地址 |
| `SUNSET_NODE_TOKEN` | -（必填） | 节点 Key（Bearer token）；**禁止日志化** |
| `SUNSET_NODE_ID` | -（必填） | 管理端预配置的正整数节点 ID（字符串） |
| `SUNSET_MAX_CONCURRENCY` | `4` | 最大并发任务数 |
| `SUNSET_HEARTBEAT_INTERVAL_MS` | `30000` | 心跳间隔 |
| `SUNSET_EVENT_BATCH_MS` | `100` | 事件聚合窗口（也是断线缓冲重试间隔） |
| `SUNSET_EVENT_BUFFER_SIZE` | `1000` | 事件缓冲上限（断线时，超出丢最旧） |
| `SUNSET_LOG_BUFFER_SIZE` | `500` | UI 日志缓冲条数 |
| `SUNSET_WORKSPACE` | `process.cwd()` | agent 会话工作目录 |
| `SUNSET_DSH_VERSION` | `0.1.0-rc.8` | 注册上报的 link.version |

## 构建

```bash
npm install --legacy-peer-deps   # 仅 @microsoft/signalr 等自有依赖（peers 由 Host 提供）
npm run build                    # tsc 编译 Host + esbuild 构建 client bundle
```

## 部署（依赖身份关键）

插件运行时 import 的 `@deepseek-ai/*`（cordis、dsh-session、dsh-typert-protocol…）**必须与 Host 是同一物理模块**（`@Remote` 装饰器的标记表是模块私有 WeakMap，重复实例会导致 Remote 方法发现失败且无报错）。两个必要条件：

1. **dsh 版本锁定**：开发/部署用同一版本（`npm i -g @deepseek-ai/dsh@<同版本>`）
2. **解析锚点**（cordis.yml 用 bare 名 `dsh-node-agent`，需要两处可解析）：
   ```bash
   ln -s /opt/dsh-node-agent /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/dsh-node-agent   # Host loader
   ln -s /opt/dsh-node-agent <DSH_HOME>/profiles/web/node_modules/dsh-node-agent                       # client-modules
   ```
   ⚠️ 插件自身 `node_modules` 里**不要**放指向宿主树的 `@deepseek-ai` 符号链接——npm install 会跟随它并修剪宿主树（本项目的 `scripts/sync-to-tree.sh` 已按此规避）。插件放进宿主树后，其 `@deepseek-ai/*` 天然从父级 `node_modules` 解析到宿主副本。

启动：`dsh web --patch /opt/dsh-node-agent/cordis.yml`（**不要加 `--no-open`**，它会导致 commander 参数解析失败），`SUNSET_*` 经环境注入。生产 Hub 必须 HTTPS。

## 生产加载步骤（Step by step）

> 注意：`--no-open` 是未知选项，会破坏 `dsh web` 的参数解析（报 `unknown option '--patch'`），不要使用。容器无显示环境下浏览器打开失败是静默的，无影响。

1. **获取插件**：`git clone https://github.com/gitcore/dsh-node-agent /opt/dsh-node-agent`
2. **dsh 版本锁定**：`npm i -g @deepseek-ai/dsh@0.1.0-rc.7`（与开发验证版本一致；子包为 rc.8）
3. **构建**：
   ```bash
   cd /opt/dsh-node-agent
   npm install --legacy-peer-deps --omit=dev   # 仅 @microsoft/signalr 等自有依赖（--legacy-peer-deps 防 npm 自动装 peer 并踩符号链接）
   node build-client.mjs                        # 预构建 client bundle
   ```
4. **依赖身份**（关键，见上）：把插件放进宿主树或符号链接两处锚点：
   ```bash
   ln -sfn /opt/dsh-node-agent /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/dsh-node-agent      # Host loader（也解决 @deepseek-ai 身份）
   mkdir -p <DSH_HOME>/profiles/web/node_modules
   ln -sfn /opt/dsh-node-agent <DSH_HOME>/profiles/web/node_modules/dsh-node-agent                            # client-modules（UI 半场）
   ```
   `<DSH_HOME>` 默认 `/data/dsh-home`；若是挂载卷，把第二条链接放进容器 entrypoint。
5. **环境变量**：`SUNSET_HUB_URL`（生产 HTTPS 地址）、`SUNSET_NODE_ID`（管理端正整数）、`SUNSET_NODE_TOKEN`（节点 Key）、可选 `SUNSET_MAX_CONCURRENCY` 等。
6. **启动**：`dsh web --patch /opt/dsh-node-agent/cordis.yml`（首次验证用 `--dump-config` 确认条目已合成）。
7. **持久加载**（重启容器也生效）：把 `cordis.yml` 的内容（`- insert: [...]`）合并进 `$DSH_HOME/cordis.patch.yml`，再重启 dsh web。注意 `name: dsh-node-agent` 的解析锚点（第 4 步）必须同时就位。

Docker 一键方案见仓库根 `Dockerfile`。

## 指定工作区（A2A / taskDispatched）

任务可以指定会话归属的工作区（否则出现在侧栏"未分组"）。会话 cwd 用工作区路径并 attach 到工作区账目，侧栏即按工作区分组显示。

- **A2A `a2aMessageReceived`**：信封 `message` 是官方 A2A v1 `Message`，用官方 SDK `@a2a-js/sdk` 解析；提示放在 `message.metadata.workspace`，prompt 取全部 text parts 拼接：
  ```json
  { "messageId": "delivery-01", "fromNodeId": "12", "correlationId": "task-01",
    "message": { "role": "ROLE_USER", "parts": [{ "text": "..." }],
                 "messageId": "msg-01", "contextId": "ctx-01",
                 "metadata": { "workspace": "/path/to/dir" } } }
  ```
  taskId 优先取 `correlationId`，其次 `message.messageId`；`message.contextId` 会随本节点后续所有 `reportTaskEvent` 回传。
- **taskDispatched**：`metadata.workspace` 字段（同上）；`dispatch.contextId` 同样回传。

`workspace` 可以是：工作区 **id**、**标题**，或**目录路径**（已有工作区直接复用；未注册的绝对路径会先 `mkdir -p` 再自动注册为工作区，保证会话 cwd 可解析、attach 校验通过）。

按 ClusterLink 契约（§8），可用 `SUNSET_WORKSPACE_ROOTS`（`:` 分隔）或配置文件 `workspaceRoots` 限制路径提示只允许落在指定根目录内；未配置时不限制。

## 卸载清理

插件卸载（fiber dispose）时：停止 SignalR 连接、取消并 dispose 所有进行中的 agent、清空事件/日志缓冲。

## 工程结构

```
src/
├── index.ts                 Host 入口（装配 + 清理 + 错误隔离）
├── client.tsx               Client 入口（sidebar.footer.action + strict-codec remote mount）
├── cluster-view.tsx         集群面板组件（轮询）
├── protocol.ts              真实契约类型 + 配置 + 事件白名单
├── connection/              hub-connection（连接/注册/心跳/上报/A2A）+ reconnect-policy
├── task/                    task-intake（双通道接入）+ task-registry + task-completion
├── events/                  event-relay（订阅/白名单/脱敏）+ event-buffer（聚合/断线缓冲）
└── services/                cluster-service（TypertRemoteService）+ log-buffer
```
