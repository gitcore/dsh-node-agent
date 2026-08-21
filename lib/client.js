window.__ModuleLoader__.load({ id: "dsh-node-agent", factory: (require) => {
var module = { exports: {} };
var exports = module.exports;
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client.tsx
var client_exports = {};
__export(client_exports, {
  apply: () => apply,
  name: () => name
});
module.exports = __toCommonJS(client_exports);

// src/cluster-view.tsx
var import_react = require("react");
var import_jsx_runtime = require("react/jsx-runtime");
var C = {
  bg: "var(--dsw-alias-bg-base, #16181d)",
  panel: "var(--dsw-alias-bg-overlay, #1d2026)",
  border: "var(--dsw-alias-border-l1, #2a2e37)",
  text: "var(--dsw-alias-label-primary, #e8eaed)",
  dim: "var(--dsw-alias-label-tertiary, #9aa0aa)",
  accent: "var(--dsw-alias-state-business-primary, #4c8dff)",
  ok: "#3fb950",
  warn: "#d29922",
  err: "#f85149"
};
function fmtElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const s = Math.floor(ms / 1e3);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
function fmtClock(ts) {
  return new Date(ts).toLocaleTimeString();
}
var triggerStyle = {
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
  width: "100%"
};
function ClusterPanel({ wide, getStatus, getActiveTasks, getLogs, getMetrics }) {
  const [open, setOpen] = (0, import_react.useState)(false);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
      "button",
      {
        type: "button",
        onClick: () => setOpen((v) => !v),
        style: triggerStyle,
        title: "\u96C6\u7FA4",
        "aria-label": "\u96C6\u7FA4",
        onMouseEnter: (e) => e.currentTarget.style.background = "var(--dsw-alias-interactive-bg-hover, #23272f)",
        onMouseLeave: (e) => e.currentTarget.style.background = "transparent",
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { fontSize: 14, lineHeight: 1 }, children: "\u25CE" }),
          wide && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "\u96C6\u7FA4" })
        ]
      }
    ),
    open && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ClusterDialog, { getStatus, getActiveTasks, getLogs, getMetrics, onClose: () => setOpen(false) })
  ] });
}
function ClusterDialog({ getStatus, getActiveTasks, getLogs, getMetrics, onClose }) {
  const [status, setStatus] = (0, import_react.useState)(null);
  const [tasks, setTasks] = (0, import_react.useState)([]);
  const [logs, setLogs] = (0, import_react.useState)([]);
  const [metrics, setMetrics] = (0, import_react.useState)(null);
  const [level, setLevel] = (0, import_react.useState)("all");
  const [error, setError] = (0, import_react.useState)(null);
  (0, import_react.useEffect)(() => {
    let alive = true;
    const tick = async () => {
      try {
        const filter = level === "all" ? void 0 : level;
        const [s, t, l, m] = await Promise.all([getStatus(), getActiveTasks(), getLogs(filter), getMetrics()]);
        if (!alive) return;
        setStatus(s);
        setTasks(t);
        setLogs(l);
        setMetrics(m);
        setError(null);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 1e3);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [getStatus, getActiveTasks, getLogs, getMetrics, level]);
  const levelColor = (lv) => lv === "error" ? C.err : lv === "warn" ? C.warn : C.dim;
  const stateColor = status ? status.connected ? C.ok : status.registered ? C.accent : status.state === "reconnecting" ? C.warn : C.err : C.dim;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
    "div",
    {
      style: {
        position: "fixed",
        top: 0,
        right: 0,
        bottom: 0,
        width: 380,
        background: C.panel,
        borderLeft: `1px solid ${C.border}`,
        color: C.text,
        zIndex: 1e3,
        display: "flex",
        flexDirection: "column",
        fontFamily: "var(--dsw-font-sans, system-ui)",
        fontSize: 13
      },
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", borderBottom: `1px solid ${C.border}` }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: "\u96C6\u7FA4" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", onClick: onClose, style: { background: "transparent", border: "none", color: C.dim, cursor: "pointer", fontSize: 15 }, "aria-label": "\u5173\u95ED", children: "\u2715" })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { padding: 12, display: "flex", flexDirection: "column", gap: 10, overflowY: "auto", flex: 1 }, children: [
          error && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { color: C.err, padding: 8, background: "rgba(248,81,73,.08)", borderRadius: 8 }, children: [
            "Host \u670D\u52A1\u4E0D\u53EF\u7528\uFF1A",
            error
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { background: C.bg, borderRadius: 8, padding: 10, border: `1px solid ${C.border}` }, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" }, children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { color: C.dim }, children: "\u8FDE\u63A5\u72B6\u6001" }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { color: stateColor, fontWeight: 600 }, children: status ? status.state : "\u2026" })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 12px", marginTop: 8, color: C.text }, children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { color: C.dim }, children: "Hub" }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: status?.hubUrl ?? "-" }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { color: C.dim }, children: "\u8282\u70B9 ID" }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: status?.nodeId ?? "-" }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { color: C.dim }, children: "dsh \u7248\u672C" }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: status?.dshVersion ?? "-" }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { color: C.dim }, children: "\u6700\u5927\u5E76\u53D1" }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: status?.maxConcurrency ?? "-" }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { color: C.dim }, children: "\u6D3B\u8DC3\u4EFB\u52A1" }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { children: [
                status?.activeTasks ?? 0,
                " / ",
                status?.totalTasks ?? 0
              ] }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { color: C.dim }, children: "\u5DF2\u8FDE\u63A5" }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: fmtElapsed(status?.connectedForMs ?? 0) })
            ] }),
            metrics && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { marginTop: 8, color: C.dim, fontSize: 12 }, children: [
              "\u5DF2\u5904\u7406 ",
              metrics.processedTasks,
              " \xB7 \u5931\u8D25 ",
              metrics.failedTasks,
              " \xB7 \u4E8B\u4EF6\u4E0A\u62A5 ",
              metrics.reportsSent,
              "\uFF08\u5931\u8D25 ",
              metrics.reportsFailed,
              "\uFF09\xB7 \u7F13\u51B2 ",
              metrics.bufferSize,
              "\uFF08\u4E22\u5F03 ",
              metrics.droppedEvents,
              "\uFF09"
            ] })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { background: C.bg, borderRadius: 8, padding: 10, border: `1px solid ${C.border}` }, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { color: C.dim, marginBottom: 6 }, children: "\u6D3B\u8DC3\u4EFB\u52A1" }),
            tasks.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { color: C.dim }, children: "\u65E0" }),
            tasks.map((t) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", justifyContent: "space-between", gap: 8, padding: "4px 0", borderBottom: `1px solid ${C.border}` }, children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }, title: t.taskId, children: t.taskId }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { color: C.accent, flexShrink: 0 }, children: t.lastEventType ?? t.status }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { color: C.dim, flexShrink: 0 }, children: fmtElapsed(t.elapsedMs) })
            ] }, t.taskId))
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { background: C.bg, borderRadius: 8, padding: 10, border: `1px solid ${C.border}`, flex: 1, minHeight: 120 }, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }, children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { color: C.dim }, children: [
                "\u65E5\u5FD7\uFF08",
                logs.length,
                "\uFF09"
              ] }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { display: "flex", gap: 4 }, children: ["all", "info", "warn", "error"].map((lv) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                "button",
                {
                  type: "button",
                  onClick: () => setLevel(lv),
                  style: {
                    background: level === lv ? C.accent : "transparent",
                    color: level === lv ? "#fff" : C.dim,
                    border: `1px solid ${C.border}`,
                    borderRadius: 6,
                    padding: "1px 7px",
                    fontSize: 11,
                    cursor: "pointer"
                  },
                  children: lv
                },
                lv
              )) })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { fontFamily: "var(--dsw-font-mono, ui-monospace, monospace)", fontSize: 11, lineHeight: 1.6, maxHeight: 260, overflowY: "auto" }, children: [
              [...logs].reverse().map((entry, i) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { whiteSpace: "pre-wrap", wordBreak: "break-all" }, children: [
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { color: C.dim }, children: fmtClock(entry.ts) }),
                " ",
                /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { color: levelColor(entry.level) }, children: [
                  "[",
                  entry.level,
                  "]"
                ] }),
                " ",
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { color: C.dim }, children: entry.scope }),
                " ",
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { color: C.text }, children: entry.message })
              ] }, `${entry.ts}-${i}`)),
              logs.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { color: C.dim }, children: "\uFF08\u7A7A\uFF09" })
            ] })
          ] })
        ] })
      ]
    }
  );
}

// src/client.tsx
var name = "dsh-node-agent";
var strict = (typeSymbol) => ({
  mode: "strict",
  typeSymbol,
  schema: { parse: (value) => value }
});
var param = (name2) => ({
  name: name2,
  wire: name2,
  source: "json",
  codec: strict(`${name2}Param`)
});
var direct = (method, parameters = []) => ({
  id: `src:clusterService#clusterService/${method}`,
  service: "clusterService",
  namespace: "clusterService",
  method,
  invocation: { kind: "direct" },
  parameters,
  result: strict(`${method}Result`)
});
var descriptors = [
  direct("getStatus"),
  direct("getActiveTasks"),
  direct("getLogs", [param("level")]),
  direct("getMetrics")
];
function apply(ctx) {
  ctx.effect(() => {
    const mounting = ctx.remote.$mount({ package: "dsh-node-agent", descriptors });
    return () => {
      void mounting.then((dispose) => dispose());
    };
  });
  const face = () => ({
    getStatus: () => ctx.remote.clusterService.getStatus(),
    getActiveTasks: () => ctx.remote.clusterService.getActiveTasks(),
    getLogs: (level) => ctx.remote.clusterService.getLogs(level),
    getMetrics: () => ctx.remote.clusterService.getMetrics()
  });
  ctx.slots.inject(
    "sidebar.footer.action",
    () => ctx.slots.register(
      {
        name: "sidebar.footer.action",
        id: "sunset-cluster",
        inject: face
      },
      ClusterPanel
    )
  );
}

return module.exports;
} });

