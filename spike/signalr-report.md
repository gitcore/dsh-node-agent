# SignalR 连通性 spike 报告（spike 第 6 条）— 实测通过

- 目标：`http://192.168.31.188:5080/cluster-link/hub`（ClusterLinkHub，ASP.NET Core SignalR）
- 节点：nodeId=1（displayName "deepseek-1"，protocol dsh），Key `738af6...`
- 环境：Node v24.19.0，`@microsoft/signalr@8.0.7`
- 探针：`spike/signalr-probe6.mjs`（全链路）、`signalr-probe7.mjs`（A2A）、`signalr-wiretap.mjs`、`signalr-raw*.mjs`（协议调试）

## 实测结果

| 项 | 结果 | 说明 |
|---|---|---|
| 网络可达 + SignalR 服务端识别 | ✅ | negotiate 返回标准连接信息，WebSockets/SSE/LongPolling 可用 |
| `skipNegotiation + WebSockets` | ✅ | `connectionId=null` 属正常 |
| 连接层鉴权 | ✅ 不强制 | 空 token 也能建立连接 |
| `registerNode`（Key 未配置时） | ❌→✅ | Key 配置前报服务端错误；配置后成功返回 ClusterNodeSnapshot |
| `registerNode`（`{nodeId:"1", link:{protocol:"dsh",version}}`） | ✅ | 返回 nodeId/link/connectionId/registeredAtUtc/lastHeartbeatUtc/key |
| `heartbeat`（无参） | ✅ | lastHeartbeatUtc 更新 |
| `reportTaskEvent`（started/completed） | ✅ | 无返回；广播给所有连接 |
| `taskEventReceived` 广播回环 | ✅ | 发送者自己也收到（含 started/completed 两条） |
| `sendA2AMessage` 自环 | ✅ | 返回 envelope（messageId 生成），`a2aMessageReceived` 推送收到 |
| 方法名/字段 camelCase | ✅ | 按真实契约文档 |

## 关键过程发现

1. **官方客户端 vs 裸协议**：裸 WebSocket 手工握手只得到 `{}` 响应（非标准 type 6）——放弃裸协议路线，直接使用官方客户端（它内部处理握手细节），注册即成功
2. **早期失败原因**：probe6 首次运行失败（"error on the server"）是**服务端 Key 尚未配置**；用户配置后同脚本即成功
3. **方法面扫描**（Key 配置前）：`RegisterNode`/`registerNode`/`Heartbeat`/`ReportTaskEvent` 命中；`TaskAccepted`/`TaskRejected`/`TaskCompleted`/`DispatchTask`/`CancelTask` 均不存在——与真实契约文档一致（这些方法确实不存在）

## 未验证项

- `taskDispatched` 推送：需协调器真实下发任务到节点 1 才能验证（handler 已注册，协议已由文档确认）
- 多节点 A2A（自环已验证，跨节点语义同文档）

## 对需求文档的影响

真实契约与 v2 假设差异大，已全部并入 `requirements-v3.md`：方法名 camelCase、`registerNode` 载荷、`heartbeat` 无参、回执走 `reportTaskEvent`、无取消、`taskEventReceived` 广播过滤、新增 A2A、`SUNSET_NODE_ID` 必填正整数。
