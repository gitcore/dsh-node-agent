/**
 * Cluster panel: the "集群" sidebar footer action and its polling dialog.
 * Polls the host clusterService every second; shows connection status, active
 * tasks, and a level-filterable log view.
 */
import { useEffect, useState } from "react";
import type { InjectFace, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
// Sidebar slot declarations (sidebar.footer.action) — a real type import forces
// the ambient SlotMap augmentation into the program.
import type { SidebarFooterActionOwnerProps } from "@deepseek-ai/dsh-client-ui-sidebar/client";
import type { ActiveTaskView, ClusterStatusView, MetricsView, RecentTaskView } from "./protocol.js";
import type { LogEntry } from "./services/log-buffer.js";

export interface ClusterPanelFace {
  getStatus(): Promise<ClusterStatusView>;
  getActiveTasks(): Promise<ActiveTaskView[]>;
  getRecentTasks(): Promise<RecentTaskView[]>;
  getLogs(level?: string): Promise<LogEntry[]>;
  getMetrics(): Promise<MetricsView>;
}

export type ClusterPanelProps = PropsRuntime<"sidebar.footer.action"> & InjectFace<ClusterPanelFace>;

const C = {
  bg: "var(--dsw-alias-bg-base, #16181d)",
  panel: "var(--dsw-alias-bg-overlay, #1d2026)",
  border: "var(--dsw-alias-border-l1, #2a2e37)",
  text: "var(--dsw-alias-label-primary, #e8eaed)",
  dim: "var(--dsw-alias-label-tertiary, #9aa0aa)",
  accent: "var(--dsw-alias-state-business-primary, #4c8dff)",
  ok: "#3fb950",
  warn: "#d29922",
  err: "#f85149",
};

function fmtElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function fmtClock(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

const triggerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  height: 32,
  padding: "0 12px",
  background: "transparent",
  border: "none",
  borderRadius: 8,
  color: C.dim,
  fontSize: 13,
  cursor: "pointer",
  width: "100%",
};

export function ClusterPanel({ wide, getStatus, getActiveTasks, getRecentTasks, getLogs, getMetrics }: ClusterPanelProps): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={triggerStyle}
        title="集群"
        aria-label="集群"
        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--dsw-alias-interactive-bg-hover, #23272f)")}
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
      >
        <span style={{ fontSize: 14, lineHeight: 1 }}>◎</span>
        {wide && <span>集群</span>}
      </button>
      {open && <ClusterDialog getStatus={getStatus} getActiveTasks={getActiveTasks} getRecentTasks={getRecentTasks} getLogs={getLogs} getMetrics={getMetrics} onClose={() => setOpen(false)} />}
    </>
  );
}

interface ClusterDialogProps extends ClusterPanelFace {
  onClose(): void;
}

/** One recent-task row: summary line; click to expand the final response. */
function TaskHistoryRow({ task }: { task: RecentTaskView }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const response = task.finalResponse ?? "";
  return (
    <div style={{ borderBottom: `1px solid ${C.border}`, padding: "4px 0" }}>
      <div
        role="button"
        tabIndex={0}
        onClick={() => setExpanded((v) => !v)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setExpanded((v) => !v); } }}
        style={{ display: "flex", justifyContent: "space-between", gap: 8, cursor: "pointer", alignItems: "baseline" }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }} title={task.taskId}>
          {task.taskId.slice(0, 16)}
        </span>
        <span style={{ color: task.finishReason === "completed" ? C.ok : C.err, flexShrink: 0 }}>{task.finishReason}</span>
        <span style={{ color: C.dim, flexShrink: 0 }}>{fmtElapsed(task.durationMs)}</span>
        <span style={{ color: C.dim, flexShrink: 0 }}>{fmtClock(task.finishedAt)}</span>
      </div>
      {expanded && (
        <div style={{ marginTop: 4, color: C.text, fontSize: 12, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-all", background: C.panel, borderRadius: 6, padding: 8 }}>
          {response.length > 0 ? response : "（无最终回复文本）"}
        </div>
      )}
    </div>
  );
}

function ClusterDialog({ getStatus, getActiveTasks, getRecentTasks, getLogs, getMetrics, onClose }: ClusterDialogProps): React.JSX.Element | null {
  const [status, setStatus] = useState<ClusterStatusView | null>(null);
  const [tasks, setTasks] = useState<ActiveTaskView[]>([]);
  const [recent, setRecent] = useState<RecentTaskView[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [metrics, setMetrics] = useState<MetricsView | null>(null);
  const [level, setLevel] = useState<string>("all");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const filter = level === "all" ? undefined : level;
        const [s, t, r, l, m] = await Promise.all([getStatus(), getActiveTasks(), getRecentTasks(), getLogs(filter), getMetrics()]);
        if (!alive) return;
        setStatus(s);
        setTasks(t);
        setRecent(r);
        setLogs(l);
        setMetrics(m);
        setError(null);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 1000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [getStatus, getActiveTasks, getRecentTasks, getLogs, getMetrics, level]);

  const levelColor = (lv: string) => (lv === "error" ? C.err : lv === "warn" ? C.warn : C.dim);
  const stateColor = status ? (status.connected ? C.ok : status.registered ? C.accent : status.state === "reconnecting" ? C.warn : C.err) : C.dim;

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        right: 0,
        bottom: 0,
        width: 380,
        background: C.panel,
        borderLeft: `1px solid ${C.border}`,
        color: C.text,
        zIndex: 1000,
        display: "flex",
        flexDirection: "column",
        fontFamily: "var(--dsw-font-sans, system-ui)",
        fontSize: 13,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", borderBottom: `1px solid ${C.border}` }}>
        <strong>集群</strong>
        <button type="button" onClick={onClose} style={{ background: "transparent", border: "none", color: C.dim, cursor: "pointer", fontSize: 15 }} aria-label="关闭">
          ✕
        </button>
      </div>

      <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10, overflowY: "auto", flex: 1 }}>
        {error && <div style={{ color: C.err, padding: 8, background: "rgba(248,81,73,.08)", borderRadius: 8 }}>Host 服务不可用：{error}</div>}

        <div style={{ background: C.bg, borderRadius: 8, padding: 10, border: `1px solid ${C.border}` }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ color: C.dim }}>连接状态</span>
            <span style={{ color: stateColor, fontWeight: 600 }}>{status ? status.state : "…"}</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 12px", marginTop: 8, color: C.text }}>
            <span style={{ color: C.dim }}>Hub</span><span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{status?.hubUrl ?? "-"}</span>
            <span style={{ color: C.dim }}>节点 ID</span><span>{status?.nodeId ?? "-"}</span>
            <span style={{ color: C.dim }}>dsh 版本</span><span>{status?.dshVersion ?? "-"}</span>
            <span style={{ color: C.dim }}>最大并发</span><span>{status?.maxConcurrency ?? "-"}</span>
            <span style={{ color: C.dim }}>活跃任务</span><span>{status?.activeTasks ?? 0} / {status?.totalTasks ?? 0}</span>
            <span style={{ color: C.dim }}>已连接</span><span>{fmtElapsed(status?.connectedForMs ?? 0)}</span>
          </div>
          {metrics && (
            <div style={{ marginTop: 8, color: C.dim, fontSize: 12 }}>
              已处理 {metrics.processedTasks} · 失败 {metrics.failedTasks} · 事件上报 {metrics.reportsSent}（失败 {metrics.reportsFailed}）· 缓冲 {metrics.bufferSize}（丢弃 {metrics.droppedEvents}）
            </div>
          )}
        </div>

        <div style={{ background: C.bg, borderRadius: 8, padding: 10, border: `1px solid ${C.border}` }}>
          <div style={{ color: C.dim, marginBottom: 6 }}>活跃任务</div>
          {tasks.length === 0 && <div style={{ color: C.dim }}>无</div>}
          {tasks.map((t) => (
            <div key={t.taskId} style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "4px 0", borderBottom: `1px solid ${C.border}` }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }} title={t.taskId}>{t.taskId}</span>
              <span style={{ color: C.accent, flexShrink: 0 }}>{t.lastEventType ?? t.status}</span>
              <span style={{ color: C.dim, flexShrink: 0 }}>{fmtElapsed(t.elapsedMs)}</span>
            </div>
          ))}
        </div>

        <div style={{ background: C.bg, borderRadius: 8, padding: 10, border: `1px solid ${C.border}` }}>
          <div style={{ color: C.dim, marginBottom: 6 }}>最近任务</div>
          {recent.length === 0 && <div style={{ color: C.dim }}>无</div>}
          {recent.slice(0, 10).map((t) => (
            <TaskHistoryRow key={t.taskId} task={t} />
          ))}
        </div>

        <div style={{ background: C.bg, borderRadius: 8, padding: 10, border: `1px solid ${C.border}`, flex: 1, minHeight: 120 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
            <span style={{ color: C.dim }}>日志（{logs.length}）</span>
            <span style={{ display: "flex", gap: 4 }}>
              {["all", "info", "warn", "error"].map((lv) => (
                <button
                  key={lv}
                  type="button"
                  onClick={() => setLevel(lv)}
                  style={{
                    background: level === lv ? C.accent : "transparent",
                    color: level === lv ? "#fff" : C.dim,
                    border: `1px solid ${C.border}`,
                    borderRadius: 6,
                    padding: "1px 7px",
                    fontSize: 11,
                    cursor: "pointer",
                  }}
                >
                  {lv}
                </button>
              ))}
            </span>
          </div>
          <div style={{ fontFamily: "var(--dsw-font-mono, ui-monospace, monospace)", fontSize: 11, lineHeight: 1.6, maxHeight: 260, overflowY: "auto" }}>
            {[...logs].reverse().map((entry, i) => (
              <div key={`${entry.ts}-${i}`} style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                <span style={{ color: C.dim }}>{fmtClock(entry.ts)}</span>{" "}
                <span style={{ color: levelColor(entry.level) }}>[{entry.level}]</span>{" "}
                <span style={{ color: C.dim }}>{entry.scope}</span>{" "}
                <span style={{ color: C.text }}>{entry.message}</span>
              </div>
            ))}
            {logs.length === 0 && <div style={{ color: C.dim }}>（空）</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
