import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * Cluster panel: the "集群" sidebar footer action and its polling dialog.
 * Polls the host clusterService every second; shows connection status, active
 * tasks, and a level-filterable log view.
 */
import { useEffect, useState } from "react";
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
function fmtElapsed(ms) {
    if (!Number.isFinite(ms) || ms < 0)
        return "-";
    const s = Math.floor(ms / 1000);
    if (s < 60)
        return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60)
        return `${m}m ${s % 60}s`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
}
function fmtClock(ts) {
    return new Date(ts).toLocaleTimeString();
}
const triggerStyle = {
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
triggerStyle.hover = undefined; // (CSSProperties has no hover; keep simple)
export function ClusterPanel({ wide, getStatus, getActiveTasks, getLogs, getMetrics }) {
    const [open, setOpen] = useState(false);
    return (_jsxs(_Fragment, { children: [_jsxs("button", { type: "button", onClick: () => setOpen((v) => !v), style: triggerStyle, title: "\u96C6\u7FA4", "aria-label": "\u96C6\u7FA4", onMouseEnter: (e) => (e.currentTarget.style.background = "var(--dsw-alias-interactive-bg-hover, #23272f)"), onMouseLeave: (e) => (e.currentTarget.style.background = "transparent"), children: [_jsx("span", { style: { fontSize: 14, lineHeight: 1 }, children: "\u25CE" }), wide && _jsx("span", { children: "\u96C6\u7FA4" })] }), open && _jsx(ClusterDialog, { getStatus: getStatus, getActiveTasks: getActiveTasks, getLogs: getLogs, getMetrics: getMetrics, onClose: () => setOpen(false) })] }));
}
function ClusterDialog({ getStatus, getActiveTasks, getLogs, getMetrics, onClose }) {
    const [status, setStatus] = useState(null);
    const [tasks, setTasks] = useState([]);
    const [logs, setLogs] = useState([]);
    const [metrics, setMetrics] = useState(null);
    const [level, setLevel] = useState("all");
    const [error, setError] = useState(null);
    useEffect(() => {
        let alive = true;
        const tick = async () => {
            try {
                const filter = level === "all" ? undefined : level;
                const [s, t, l, m] = await Promise.all([getStatus(), getActiveTasks(), getLogs(filter), getMetrics()]);
                if (!alive)
                    return;
                setStatus(s);
                setTasks(t);
                setLogs(l);
                setMetrics(m);
                setError(null);
            }
            catch (e) {
                if (alive)
                    setError(e instanceof Error ? e.message : String(e));
            }
        };
        void tick();
        const timer = setInterval(() => void tick(), 1000);
        return () => {
            alive = false;
            clearInterval(timer);
        };
    }, [getStatus, getActiveTasks, getLogs, getMetrics, level]);
    const levelColor = (lv) => (lv === "error" ? C.err : lv === "warn" ? C.warn : C.dim);
    const stateColor = status ? (status.connected ? C.ok : status.registered ? C.accent : status.state === "reconnecting" ? C.warn : C.err) : C.dim;
    return (_jsxs("div", { style: {
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
        }, children: [_jsxs("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", borderBottom: `1px solid ${C.border}` }, children: [_jsx("strong", { children: "\u96C6\u7FA4" }), _jsx("button", { type: "button", onClick: onClose, style: { background: "transparent", border: "none", color: C.dim, cursor: "pointer", fontSize: 15 }, "aria-label": "\u5173\u95ED", children: "\u2715" })] }), _jsxs("div", { style: { padding: 12, display: "flex", flexDirection: "column", gap: 10, overflowY: "auto", flex: 1 }, children: [error && _jsxs("div", { style: { color: C.err, padding: 8, background: "rgba(248,81,73,.08)", borderRadius: 8 }, children: ["Host \u670D\u52A1\u4E0D\u53EF\u7528\uFF1A", error] }), _jsxs("div", { style: { background: C.bg, borderRadius: 8, padding: 10, border: `1px solid ${C.border}` }, children: [_jsxs("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" }, children: [_jsx("span", { style: { color: C.dim }, children: "\u8FDE\u63A5\u72B6\u6001" }), _jsx("span", { style: { color: stateColor, fontWeight: 600 }, children: status ? status.state : "…" })] }), _jsxs("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 12px", marginTop: 8, color: C.text }, children: [_jsx("span", { style: { color: C.dim }, children: "Hub" }), _jsx("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: status?.hubUrl ?? "-" }), _jsx("span", { style: { color: C.dim }, children: "\u8282\u70B9 ID" }), _jsx("span", { children: status?.nodeId ?? "-" }), _jsx("span", { style: { color: C.dim }, children: "dsh \u7248\u672C" }), _jsx("span", { children: status?.dshVersion ?? "-" }), _jsx("span", { style: { color: C.dim }, children: "\u6700\u5927\u5E76\u53D1" }), _jsx("span", { children: status?.maxConcurrency ?? "-" }), _jsx("span", { style: { color: C.dim }, children: "\u6D3B\u8DC3\u4EFB\u52A1" }), _jsxs("span", { children: [status?.activeTasks ?? 0, " / ", status?.totalTasks ?? 0] }), _jsx("span", { style: { color: C.dim }, children: "\u5DF2\u8FDE\u63A5" }), _jsx("span", { children: fmtElapsed(status?.connectedForMs ?? 0) })] }), metrics && (_jsxs("div", { style: { marginTop: 8, color: C.dim, fontSize: 12 }, children: ["\u5DF2\u5904\u7406 ", metrics.processedTasks, " \u00B7 \u5931\u8D25 ", metrics.failedTasks, " \u00B7 \u4E8B\u4EF6\u4E0A\u62A5 ", metrics.reportsSent, "\uFF08\u5931\u8D25 ", metrics.reportsFailed, "\uFF09\u00B7 \u7F13\u51B2 ", metrics.bufferSize, "\uFF08\u4E22\u5F03 ", metrics.droppedEvents, "\uFF09"] }))] }), _jsxs("div", { style: { background: C.bg, borderRadius: 8, padding: 10, border: `1px solid ${C.border}` }, children: [_jsx("div", { style: { color: C.dim, marginBottom: 6 }, children: "\u6D3B\u8DC3\u4EFB\u52A1" }), tasks.length === 0 && _jsx("div", { style: { color: C.dim }, children: "\u65E0" }), tasks.map((t) => (_jsxs("div", { style: { display: "flex", justifyContent: "space-between", gap: 8, padding: "4px 0", borderBottom: `1px solid ${C.border}` }, children: [_jsx("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }, title: t.taskId, children: t.taskId }), _jsx("span", { style: { color: C.accent, flexShrink: 0 }, children: t.lastEventType ?? t.status }), _jsx("span", { style: { color: C.dim, flexShrink: 0 }, children: fmtElapsed(t.elapsedMs) })] }, t.taskId)))] }), _jsxs("div", { style: { background: C.bg, borderRadius: 8, padding: 10, border: `1px solid ${C.border}`, flex: 1, minHeight: 120 }, children: [_jsxs("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }, children: [_jsxs("span", { style: { color: C.dim }, children: ["\u65E5\u5FD7\uFF08", logs.length, "\uFF09"] }), _jsx("span", { style: { display: "flex", gap: 4 }, children: ["all", "info", "warn", "error"].map((lv) => (_jsx("button", { type: "button", onClick: () => setLevel(lv), style: {
                                                background: level === lv ? C.accent : "transparent",
                                                color: level === lv ? "#fff" : C.dim,
                                                border: `1px solid ${C.border}`,
                                                borderRadius: 6,
                                                padding: "1px 7px",
                                                fontSize: 11,
                                                cursor: "pointer",
                                            }, children: lv }, lv))) })] }), _jsxs("div", { style: { fontFamily: "var(--dsw-font-mono, ui-monospace, monospace)", fontSize: 11, lineHeight: 1.6, maxHeight: 260, overflowY: "auto" }, children: [[...logs].reverse().map((entry, i) => (_jsxs("div", { style: { whiteSpace: "pre-wrap", wordBreak: "break-all" }, children: [_jsx("span", { style: { color: C.dim }, children: fmtClock(entry.ts) }), " ", _jsxs("span", { style: { color: levelColor(entry.level) }, children: ["[", entry.level, "]"] }), " ", _jsx("span", { style: { color: C.dim }, children: entry.scope }), " ", _jsx("span", { style: { color: C.text }, children: entry.message })] }, `${entry.ts}-${i}`))), logs.length === 0 && _jsx("div", { style: { color: C.dim }, children: "\uFF08\u7A7A\uFF09" })] })] })] })] }));
}
