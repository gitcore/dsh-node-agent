/**
 * Client half: registers the "集群" sidebar footer action and mounts the
 * clusterService remote with hand-written strict codecs (the client gateway
 * rejects src-json descriptors, so every codec is {mode:'strict'} with a
 * passthrough schema).
 */
import type { Context } from "@deepseek-ai/cordis";
import type { ClientContext } from "@deepseek-ai/dsh-client-runtime/client";
import type { InvocationDescriptor } from "@deepseek-ai/dsh-typert-protocol";
// Sidebar slot declarations (sidebar.footer.action) — a real type import forces
// the ambient SlotMap augmentation into the program.
import type { SidebarFooterActionOwnerProps } from "@deepseek-ai/dsh-client-ui-sidebar/client";
import type { ActiveTaskView, ClusterStatusView, MetricsView, RecentTaskView } from "./protocol.js";
import type { LogEntry } from "./services/log-buffer.js";
import { ClusterPanel, type ClusterPanelFace } from "./cluster-view.js";

declare module "@deepseek-ai/dsh-typert-protocol" {
  interface TypertRemoteNamespaceMap {
    clusterService: {
      getStatus(): Promise<RemoteResult<ClusterStatusView>>;
      getActiveTasks(): Promise<RemoteResult<ActiveTaskView[]>>;
      getRecentTasks(): Promise<RemoteResult<RecentTaskView[]>>;
      getLogs(level?: string): Promise<RemoteResult<LogEntry[]>>;
      getMetrics(): Promise<RemoteResult<MetricsView>>;
      connectToHub(): Promise<RemoteResult<{ state: string }>>;
    };
  }
}

/** The client gateway returns every remote call as a {ok, value} envelope. */
export interface RemoteResult<T> {
  ok: boolean;
  value?: T;
  error?: unknown;
}

/** Unwrap the gateway envelope; rejects on !ok (the RPC error or a clear text). */
async function unwrap<T>(result: Promise<RemoteResult<T>>): Promise<T> {
  const answered = await result;
  if (!answered.ok) {
    const detail =
      typeof answered.error === "object" && answered.error !== null && "message" in answered.error
        ? String((answered.error as { message: unknown }).message)
        : String(answered.error ?? "unknown error");
    throw new Error(`clusterService: ${detail}`);
  }
  return answered.value as T;
}

export const name = "dsh-node-agent";

/**
 * Official client-face hard dependencies, mirroring the official packages:
 *   - @deepseek-ai/dsh-client-ui-goal:
 *       const inject = ["slots", "sessions", "remote", "remote.goals",
 *                       "locale", "conversationEvents"];
 *   - @deepseek-ai/dsh-client-ui-plan:
 *       const inject = ["slots", "remote", "remote.commands", "locale"];
 *
 * The dotted Typert child key "remote.clusterService" is deliberately NOT
 * declared here. Official UI packages may declare "remote.<ns>" because their
 * namespaces are provided by @deepseek-ai/dsh-api-remotes' pre-generated
 * client assemblies before any UI plugin applies. This plugin instead
 * provides the namespace itself via remote.$mount inside apply() (a
 * third-party package has no generated client assembly), so hard-injecting
 * "remote.clusterService" would leave the Browser fiber pending forever,
 * waiting for a service only its own apply would register. The child
 * namespace is resolved lazily via ctx.get() at call time instead (see
 * cluster() below).
 */
export const inject = ["remote", "slots"];

const strict = (typeSymbol: string) => ({
  mode: "strict" as const,
  typeSymbol,
  schema: { parse: (value: unknown) => value },
});

const param = (name: string) => ({
  name,
  wire: name,
  source: "json" as const,
  codec: strict(`${name}Param`),
});

const direct = (method: string, parameters: InvocationDescriptor["parameters"] = []): InvocationDescriptor => ({
  id: `src:clusterService#clusterService/${method}`,
  service: "clusterService",
  namespace: "clusterService",
  method,
  invocation: { kind: "direct" },
  parameters,
  result: strict(`${method}Result`),
});

const descriptors: InvocationDescriptor[] = [
  direct("getStatus"),
  direct("getActiveTasks"),
  direct("getRecentTasks"),
  direct("getLogs", [param("level")]),
  direct("getMetrics"),
  direct("connectToHub"),
];

export function apply(ctx: ClientContext): void {
  const remote = ctx.get("remote") as ClientContext["remote"] | undefined;
  const slots = ctx.get("slots") as ClientContext["slots"] | undefined;
  if (!remote || !slots) {
    // Browser env always provides them via the dsh-client-* base packages
    // listed in package.dsh.client.inject; if not present this half is
    // simply not applicable.
    return;
  }

  // Mount the remote namespace (async; teardown waits for the disposer).
  // $mount registers the "remote.clusterService" service key on the client.
  ctx.effect(() => {
    const mounting = remote.$mount({ package: "dsh-node-agent", descriptors });
    return () => {
      void mounting.then((dispose) => dispose());
    };
  });

  // Lazy resolver for the mounted child namespace, read at CALL time via
  // ctx.get — per cordis-plugin-development SKILL.md L255, ctx.get() does
  // NOT require an inject declaration. Property access (remote.clusterService)
  // would instead hit the Typert ReflectProxy getter trap — the dotted key is
  // intentionally absent from our inject set — and throw
  // "cannot get property 'remote.clusterService' without inject".
  // NOTE: We MUST NOT synchronously throw here.
  // The `face` provider below (used in slots.inject) is evaluated by Cordis
  // during the *synchronous React render phase*. Any throw here would crash
  // the whole React tree (Sidebar and all), because the call site
  // (tick() inside useEffect) has not yet had a chance to await/catch.
  // Instead, we return a transparent proxy whose methods return Promises that
  // reject with the readiness error. The tick() function's try/catch then
  // handles this gracefully via setError(...) without crashing the UI.
  const cluster = (): ClientContext["remote"]["clusterService"] => {
    const service = ctx.get("remote.clusterService") as
      | ClientContext["remote"]["clusterService"]
      | undefined;
    if (!service) {
      const notReady = new Error("集群服务尚未就绪（命名空间挂载中），请稍后重试");
      // Return a faux service whose every method rejects.
      return {
        getStatus: async () => { throw notReady; },
        getActiveTasks: async () => { throw notReady; },
        getRecentTasks: async () => { throw notReady; },
        getLogs: async (level?: string) => { throw notReady; },
        getMetrics: async () => { throw notReady; },
        connectToHub: async () => { throw notReady; },
      } as ClientContext["remote"]["clusterService"];
    }
    return service;
  };

  const face = (): ClusterPanelFace => ({
    // The gateway returns {ok, value} envelopes — unwrap before handing the
    // data to the view (a raw envelope crashes the view: tasks.map is not a
    // function, and the slot system removes the crashed entry).
    getStatus: () => unwrap(cluster().getStatus()),
    getActiveTasks: () => unwrap(cluster().getActiveTasks()),
    getRecentTasks: () => unwrap(cluster().getRecentTasks()),
    getLogs: (level?: string) => unwrap(cluster().getLogs(level)),
    getMetrics: () => unwrap(cluster().getMetrics()),
    connectToHub: () => unwrap(cluster().connectToHub()),
  });

  slots.inject("sidebar.footer.action", () =>
    slots.register(
      {
        name: "sidebar.footer.action",
        id: "sunset-cluster",
        inject: face,
      },
      ClusterPanel,
    ),
  );
}
