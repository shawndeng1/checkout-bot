import React, { useEffect, useState, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  LayoutDashboard,
  Layers,
  Users,
  Globe,
  Settings as SettingsIcon,
  Plus,
  Play,
  Square,
  RefreshCw,
  Copy,
  Trash2,
  Pencil,
  ChevronRight,
  Activity,
  Box,
  Check,
  X,
  Terminal,
  Orbit,
  Bell,
} from "lucide-react";
import { useWorkspace } from "./store";
import { Badge, Button, Empty } from "../../../packages/ui/src/index";
import {
  scenarios,
  type Task,
  type Command,
  type Snapshot,
} from "../../../packages/shared-types/src/index";
import {
  InventoryView,
  ReconciliationView,
  IntegrationSettings,
} from "./operations";
import "./style.css";
const views = [
  "Dashboard",
  "Inventory",
  "Reconciliation",
  "Tasks",
  "Profiles",
  "Proxies",
  "Settings",
] as const;
type View = (typeof views)[number];
type FormKind = "Group" | "Task" | "Profile" | "Proxy";
const icons = [
  LayoutDashboard,
  Activity,
  RefreshCw,
  Layers,
  Users,
  Globe,
  SettingsIcon,
];
const activeStates = [
  "MONITORING",
  "STOCK_DETECTED",
  "CARTING",
  "AWAITING_APPROVAL",
  "CHECKING_OUT",
];
function App() {
  const { data, error, setData, command, clearError } = useWorkspace();
  const [view, setView] = useState<View>("Dashboard");
  const startupApplied = useRef(false);
  const lastNotification = useRef<string | null>(null);
  const lastInventoryNotice = useRef<string | null>(null);
  const [group, setGroup] = useState<string>("all");
  const [selected, setSelected] = useState<string[]>([]);
  const [logs, setLogs] = useState<string | null>(null);
  const [form, setForm] = useState<{
    kind: FormKind;
    value?: Record<string, unknown>;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!window.retail) {
      useWorkspace.setState({
        error: "Open this workspace in Electron using pnpm dev or pnpm start.",
      });
      return;
    }
    let disposed = false;
    const unsubscribe = window.retail.subscribe((snapshot) => {
      setData(snapshot);
      const inventoryNotice = snapshot.notices[0];
      if (
        inventoryNotice &&
        inventoryNotice.id !== lastInventoryNotice.current &&
        snapshot.settings.inventoryNotifications
      )
        setNotice(inventoryNotice.message);
      lastInventoryNotice.current = inventoryNotice?.id ?? null;
      const latest = snapshot.logs[0];
      if (
        snapshot.settings.notifications &&
        latest?.state === "COMPLETED" &&
        latest.id !== lastNotification.current
      )
        setNotice("A simulation completed successfully.");
      lastNotification.current = latest?.id ?? null;
    });
    void window.retail
      .snapshot()
      .then((snapshot) => {
        if (disposed) return;
        setData(snapshot);
        lastNotification.current = snapshot.logs[0]?.id ?? null;
        lastInventoryNotice.current = snapshot.notices[0]?.id ?? null;
        if (!startupApplied.current) {
          setView(snapshot.settings.launchView);
          startupApplied.current = true;
        }
      })
      .catch((e) => useWorkspace.setState({ error: String(e) }));
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [setData]);
  const navigate = (next: View) => {
    startupApplied.current = true;
    setView(next);
    setSelected([]);
  };
  const perform = async (
    type: "start" | "stop" | "restart" | "deleteTask",
    ids: string[],
  ) => {
    for (const id of ids) await command({ type, id });
    setSelected([]);
  };
  const remove = (
    type: "deleteTask" | "deleteGroup" | "deleteProfile" | "deleteProxy",
    id: string,
  ) => {
    if (
      confirm(
        "Delete this item? Deleting a task group also deletes its tasks and execution history.",
      )
    )
      void command({ type, id });
  };
  const tasks =
    data?.tasks.filter((task) => group === "all" || task.groupId === group) ??
    [];
  const counts = {
    running:
      data?.tasks.filter((t) => activeStates.includes(t.state)).length ?? 0,
    stopped:
      data?.tasks.filter((t) => ["CREATED", "CANCELLED"].includes(t.state))
        .length ?? 0,
    failed: data?.tasks.filter((t) => t.state === "FAILED").length ?? 0,
    completed: data?.tasks.filter((t) => t.state === "COMPLETED").length ?? 0,
  };
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-symbol">
            <Orbit size={26} />
          </span>
          orbit<span className="brand-dot">.</span>
        </div>
        <div className="workspace-label">RETAIL WORKSPACE</div>
        <nav>
          {views.map((item, index) => {
            const Icon = icons[index];
            return (
              <button
                key={item}
                className={`nav-item ${view === item ? "active" : ""}`}
                onClick={() => navigate(item)}
              >
                <Icon size={18} />
                {item}
                {item === "Tasks" && (
                  <span className="nav-count">{data?.tasks.length ?? 0}</span>
                )}
              </button>
            );
          })}
        </nav>
        <div className="sidebar-bottom">
          <div className="sandbox-card">
            <span className="status-dot" /> Inventory & simulation
            <p>
              Inventory monitoring.
              <br />
              Simulated checkout only.
            </p>
          </div>
          <div className="user">
            <span className="avatar">LW</span>
            <div>
              Local workspace<small>Desktop · v0.1.0</small>
            </div>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <span>
            Workspace <ChevronRight size={14} /> <strong>{view}</strong>
          </span>
          <div>
            <span className="status-dot" /> Engine online{" "}
            <span className="top-divider" /> <span className="mono">LOCAL</span>
            <Bell size={17} />
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                YOUR RETAIL OPERATIONS, IN ONE PLACE
              </div>
              <h1>{view === "Dashboard" ? "Workspace overview" : view}</h1>
              <p>
                {
                  {
                    Dashboard:
                      "A live view of your tasks, activity, and simulation performance.",
                    Inventory:
                      "Continuous product and variant observations, with availability alerts.",
                    Reconciliation:
                      "Check uncertain simulated orders without submitting another checkout.",
                    Tasks:
                      "Organize, monitor, and manage your retailer workflows.",
                    Profiles:
                      "Shipping and contact details for your simulated workflows.",
                    Proxies:
                      "Manage connection configurations in your local workspace.",
                    Settings: "Make this workspace work the way you do.",
                  }[view]
                }
              </p>
            </div>
            {!["Settings", "Inventory", "Reconciliation"].includes(view) && (
              <Button
                variant="primary"
                onClick={() =>
                  view === "Dashboard"
                    ? (navigate("Tasks"), setForm({ kind: "Task" }))
                    : setForm({
                        kind:
                          view === "Tasks"
                            ? "Task"
                            : view === "Profiles"
                              ? "Profile"
                              : "Proxy",
                      })
                }
              >
                <Plus size={16} />
                {view === "Dashboard" || view === "Tasks"
                  ? "New task"
                  : view === "Profiles"
                    ? "New profile"
                    : "New proxy"}
              </Button>
            )}
          </div>
          {data?.tasks.some((task) => task.state === "UNKNOWN_OUTCOME") && (
            <div className="alert" role="alert">
              A checkout outcome is unknown. Automatic retries are blocked; open
              Reconciliation to check the order status.
            </div>
          )}
          {error && (
            <div className="alert" role="alert">
              {error}
              <button onClick={clearError}>
                <X size={16} />
              </button>
            </div>
          )}
          {notice && (
            <div className="notice" role="status">
              {notice}
              <button onClick={() => setNotice(null)}>
                <X size={16} />
              </button>
            </div>
          )}
          {!data ? (
            <Empty>Connecting to local workspace…</Empty>
          ) : (
            <>
              {view === "Dashboard" && (
                <>
                  <div className="stats-grid">
                    {[
                      ["Total tasks", data.tasks.length, Layers, "neutral"],
                      ["Running", counts.running, Activity, "green"],
                      ["Stopped", counts.stopped, Square, "neutral"],
                      ["Failed", counts.failed, X, "red"],
                      ["Completed", counts.completed, Check, "purple"],
                    ].map(([label, value, Icon, color]) => {
                      const I = Icon as typeof Layers;
                      return (
                        <div className="stat-card" key={String(label)}>
                          <div>
                            {String(label)}
                            <I size={18} className={String(color)} />
                          </div>
                          <strong>{String(value)}</strong>
                          <small>
                            {label === "Running"
                              ? `${data.queued.length} queued · ${data.settings.concurrency} concurrent`
                              : label === "Completed"
                                ? "Simulated checkouts"
                                : label === "Total tasks"
                                  ? `${data.groups.length} task groups`
                                  : "Current task status"}
                          </small>
                        </div>
                      );
                    })}
                  </div>
                  <div className="dashboard-grid">
                    <section className="panel">
                      <div className="panel-heading">
                        <h2>Execution performance</h2>
                        <span className="muted">Last 7 days</span>
                      </div>
                      <Performance data={data} />
                      <div className="chart-legend">
                        <span>
                          <i className="legend-dot" />
                          Completed runs
                        </span>
                        <span className="muted">
                          {data.runs.length} recorded runs ·{" "}
                          {
                            data.runs.filter((r) => r.outcome === "FAILED")
                              .length
                          }{" "}
                          failed
                        </span>
                      </div>
                    </section>
                    <section className="panel">
                      <div className="panel-heading">
                        <h2>Retailer connection</h2>
                        <Badge state="MONITORING" />
                      </div>
                      <div className="retailer-card">
                        <span className="retailer-icon">
                          <Box size={28} />
                        </span>
                        <h3>Mock Retailer</h3>
                        <p>Deterministic inventory & checkout simulation</p>
                        <div className="capabilities">
                          <span>Inventory</span>
                          <span>Cart</span>
                          <span>Checkout</span>
                        </div>
                      </div>
                      <div className="connection-row">
                        <span>Environment</span>
                        <strong>Simulation only</strong>
                      </div>
                      <div className="connection-row">
                        <span>Active task groups</span>
                        <strong>{data.groups.length}</strong>
                      </div>
                    </section>
                  </div>
                  <section className="panel">
                    <div className="panel-heading">
                      <h2>Recent activity</h2>
                      <Button onClick={() => navigate("Tasks")}>
                        View tasks <ChevronRight size={14} />
                      </Button>
                    </div>
                    {data.logs.length ? (
                      data.logs.slice(0, 6).map((log) => (
                        <div className="activity-row" key={log.id}>
                          <span className={`activity-icon ${log.level}`}>
                            <Activity size={16} />
                          </span>
                          <div>
                            <strong>
                              {data.tasks.find((t) => t.id === log.taskId)
                                ?.name ?? "Task"}
                            </strong>
                            <p>{log.message}</p>
                          </div>
                          <Badge state={log.state} />
                          <time>{new Date(log.at).toLocaleTimeString()}</time>
                        </div>
                      ))
                    ) : (
                      <Empty>
                        Your activity feed will appear when you start a task.
                      </Empty>
                    )}
                  </section>
                </>
              )}
              {view === "Inventory" && (
                <InventoryView data={data} command={command} />
              )}
              {view === "Reconciliation" && (
                <ReconciliationView data={data} command={command} />
              )}
              {view === "Tasks" && (
                <>
                  <div className="task-layout">
                    <aside className="group-panel">
                      <div className="panel-heading">
                        <h2>Task groups</h2>
                        <button
                          aria-label="New group"
                          onClick={() => setForm({ kind: "Group" })}
                        >
                          <Plus size={18} />
                        </button>
                      </div>
                      <button
                        className={`group-item ${group === "all" ? "active" : ""}`}
                        onClick={() => setGroup("all")}
                      >
                        <Layers size={16} />
                        All tasks<span>{data.tasks.length}</span>
                      </button>
                      {data.groups.map((g) => (
                        <div
                          className={`group-item ${group === g.id ? "active" : ""}`}
                          key={g.id}
                        >
                          <button
                            className="group-name"
                            onClick={() => setGroup(g.id)}
                          >
                            <Box size={16} />
                            <div>
                              {g.name}
                              <small>
                                {data.retailers.find((r) => r.id === g.retailer)
                                  ?.name ?? g.retailer}
                              </small>
                            </div>
                          </button>
                          <button
                            aria-label={`Edit group ${g.name}`}
                            onClick={() =>
                              setForm({ kind: "Group", value: { ...g } })
                            }
                          >
                            <Pencil size={13} />
                          </button>
                          <button
                            aria-label={`Delete group ${g.name}`}
                            onClick={() => remove("deleteGroup", g.id)}
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      ))}
                      {!data.groups.length && (
                        <p className="group-help">
                          Create a group to organize your first tasks.
                        </p>
                      )}
                    </aside>
                    <section className="panel tasks-panel">
                      <div className="panel-heading">
                        <h2>
                          {group === "all"
                            ? "All tasks"
                            : (data.groups.find((g) => g.id === group)?.name ??
                              "Tasks")}{" "}
                          <span className="muted">({tasks.length})</span>
                        </h2>
                        <div className="toolbar">
                          <Button
                            disabled={!selected.length}
                            onClick={() => void perform("start", selected)}
                          >
                            <Play size={14} />
                            Start
                          </Button>
                          <Button
                            disabled={!selected.length}
                            onClick={() => void perform("stop", selected)}
                          >
                            <Square size={14} />
                            Stop
                          </Button>
                          <Button
                            disabled={!selected.length}
                            onClick={() => void perform("restart", selected)}
                          >
                            <RefreshCw size={14} />
                            Restart
                          </Button>
                          <Button
                            disabled={!selected.length}
                            variant="danger"
                            onClick={() => {
                              if (confirm("Delete selected tasks?"))
                                void perform("deleteTask", selected);
                            }}
                          >
                            <Trash2 size={14} />
                          </Button>
                        </div>
                      </div>
                      <table>
                        <thead>
                          <tr>
                            <th>
                              <input
                                aria-label="Select all tasks"
                                type="checkbox"
                                checked={
                                  tasks.length > 0 &&
                                  tasks.every((t) => selected.includes(t.id))
                                }
                                onChange={(e) =>
                                  setSelected(
                                    e.target.checked
                                      ? tasks.map((t) => t.id)
                                      : [],
                                  )
                                }
                              />
                            </th>
                            <th>TASK / PRODUCT</th>
                            <th>PROFILE</th>
                            <th>STATUS</th>
                            <th className="right">ACTIONS</th>
                          </tr>
                        </thead>
                        <tbody>
                          {tasks.map((task) => (
                            <tr key={task.id}>
                              <td>
                                <input
                                  aria-label={`Select ${task.name}`}
                                  type="checkbox"
                                  checked={selected.includes(task.id)}
                                  onChange={(e) =>
                                    setSelected(
                                      e.target.checked
                                        ? [...selected, task.id]
                                        : selected.filter(
                                            (id) => id !== task.id,
                                          ),
                                    )
                                  }
                                />
                              </td>
                              <td>
                                <strong>{task.name}</strong>
                                <small>
                                  {task.product} · {task.scenario}
                                </small>
                              </td>
                              <td>
                                {data.profiles.find(
                                  (p) => p.id === task.profileId,
                                )?.name ?? "Unassigned"}
                              </td>
                              <td>
                                <Badge
                                  state={
                                    data.queued.includes(task.id)
                                      ? "QUEUED"
                                      : task.state
                                  }
                                />
                              </td>
                              <td>
                                <div className="row-actions">
                                  {task.state === "AWAITING_APPROVAL" && (
                                    <Button
                                      variant="primary"
                                      onClick={() =>
                                        void command({
                                          type: "approve",
                                          id: task.id,
                                        })
                                      }
                                    >
                                      Approve
                                    </Button>
                                  )}
                                  <button
                                    aria-label={`Start ${task.name}`}
                                    disabled={
                                      activeStates.includes(task.state) ||
                                      data.queued.includes(task.id)
                                    }
                                    onClick={() =>
                                      void command({
                                        type: "start",
                                        id: task.id,
                                      })
                                    }
                                  >
                                    <Play size={15} />
                                  </button>
                                  <button
                                    aria-label={`Stop ${task.name}`}
                                    onClick={() =>
                                      void command({
                                        type: "stop",
                                        id: task.id,
                                      })
                                    }
                                  >
                                    <Square size={15} />
                                  </button>
                                  <button
                                    aria-label={`Restart ${task.name}`}
                                    onClick={() =>
                                      void command({
                                        type: "restart",
                                        id: task.id,
                                      })
                                    }
                                  >
                                    <RefreshCw size={15} />
                                  </button>
                                  <button
                                    aria-label={`Edit ${task.name}`}
                                    onClick={() =>
                                      setForm({
                                        kind: "Task",
                                        value: taskConfig(task),
                                      })
                                    }
                                  >
                                    <Pencil size={15} />
                                  </button>
                                  <button
                                    aria-label={`Duplicate ${task.name}`}
                                    onClick={() =>
                                      void command({
                                        type: "duplicateTask",
                                        id: task.id,
                                      })
                                    }
                                  >
                                    <Copy size={15} />
                                  </button>
                                  <button
                                    aria-label={`Logs ${task.name}`}
                                    onClick={() => setLogs(task.id)}
                                  >
                                    <Terminal size={15} />
                                  </button>
                                  <button
                                    aria-label={`Delete ${task.name}`}
                                    onClick={() =>
                                      remove("deleteTask", task.id)
                                    }
                                  >
                                    <Trash2 size={15} />
                                  </button>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {!tasks.length && (
                        <Empty>
                          <Box size={32} />
                          <h3>No tasks yet</h3>
                          <p>
                            Create a task group, then add your first simulated
                            workflow.
                          </p>
                          <Button
                            onClick={() =>
                              setForm({
                                kind: data.groups.length ? "Task" : "Group",
                              })
                            }
                          >
                            <Plus size={15} />
                            {data.groups.length
                              ? "Create task"
                              : "Create group"}
                          </Button>
                        </Empty>
                      )}
                    </section>
                  </div>
                </>
              )}
              {(view === "Profiles" || view === "Proxies") && (
                <section className="panel">
                  <div className="panel-heading">
                    <h2>
                      {view === "Profiles"
                        ? "Purchasing profiles"
                        : "Proxy configurations"}
                    </h2>
                    <span className="muted">
                      {view === "Profiles"
                        ? data.profiles.length
                        : data.proxies.length}{" "}
                      saved locally
                    </span>
                  </div>
                  <table>
                    <thead>
                      <tr>
                        <th>NAME</th>
                        <th>GROUP</th>
                        <th>
                          {view === "Profiles"
                            ? "CONTACT / SHIPPING"
                            : "CONNECTION"}
                        </th>
                        <th>{view === "Profiles" ? "PAYMENT" : "PROTOCOL"}</th>
                        <th className="right">ACTIONS</th>
                      </tr>
                    </thead>
                    <tbody>
                      {view === "Profiles"
                        ? data.profiles.map((p) => (
                            <tr key={p.id}>
                              <td>
                                <strong>{p.name}</strong>
                              </td>
                              <td>{p.group}</td>
                              <td>
                                {p.email}
                                <small>
                                  {p.address}, {p.city} {p.postalCode} ·{" "}
                                  {p.country}
                                </small>
                              </td>
                              <td>
                                <span className="token">Placeholder token</span>
                              </td>
                              <td>
                                <div className="row-actions">
                                  <button
                                    aria-label={`Edit profile ${p.name}`}
                                    onClick={() =>
                                      setForm({
                                        kind: "Profile",
                                        value: { ...p },
                                      })
                                    }
                                  >
                                    <Pencil size={16} />
                                  </button>
                                  <button
                                    aria-label={`Delete profile ${p.name}`}
                                    onClick={() =>
                                      remove("deleteProfile", p.id)
                                    }
                                  >
                                    <Trash2 size={16} />
                                  </button>
                                </div>
                              </td>
                            </tr>
                          ))
                        : data.proxies.map((p) => (
                            <tr key={p.id}>
                              <td>
                                <strong>{p.name}</strong>
                              </td>
                              <td>{p.group}</td>
                              <td className="mono">
                                {p.host}:{p.port}
                              </td>
                              <td>
                                <Badge state={p.protocol} />
                              </td>
                              <td>
                                <div className="row-actions">
                                  <button
                                    aria-label={`Edit proxy ${p.name}`}
                                    onClick={() =>
                                      setForm({
                                        kind: "Proxy",
                                        value: { ...p },
                                      })
                                    }
                                  >
                                    <Pencil size={16} />
                                  </button>
                                  <button
                                    aria-label={`Delete proxy ${p.name}`}
                                    onClick={() => remove("deleteProxy", p.id)}
                                  >
                                    <Trash2 size={16} />
                                  </button>
                                </div>
                              </td>
                            </tr>
                          ))}
                    </tbody>
                  </table>
                  {!(view === "Profiles"
                    ? data.profiles.length
                    : data.proxies.length) && (
                    <Empty>
                      {view === "Profiles"
                        ? "Add a profile with shipping details and a mock_ payment placeholder."
                        : "Add an HTTP or SOCKS5 configuration. Proxies are stored but are not used by mock tasks."}
                    </Empty>
                  )}
                </section>
              )}
              {view === "Settings" && (
                <>
                  <SettingsForm data={data} save={command} />
                  <IntegrationSettings data={data} />
                </>
              )}
            </>
          )}
          <footer>
            <span>
              <span className="status-dot" /> All changes saved locally
            </span>
            <span>
              ORBIT WORKSPACE <span className="muted">/</span> SIMULATED
              CHECKOUT
            </span>
          </footer>
        </main>
      </div>
      {data && form && (
        <EntityForm
          kind={form.kind}
          initial={form.value}
          data={data}
          group={group}
          close={() => setForm(null)}
          save={command}
        />
      )}
      {data && logs && (
        <div className="modal-backdrop" onClick={() => setLogs(null)}>
          <section
            className="modal log-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Execution log"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="panel-heading">
              <h2>
                <Terminal size={18} />{" "}
                {data.tasks.find((t) => t.id === logs)?.name} · Execution log
              </h2>
              <button aria-label="Close logs" onClick={() => setLogs(null)}>
                <X size={20} />
              </button>
            </div>
            <div className="log-list">
              {data.logs
                .filter((l) => l.taskId === logs)
                .reverse()
                .map((l) => (
                  <div className={`log-line ${l.level}`} key={l.id}>
                    <time>{new Date(l.at).toLocaleTimeString()}</time>
                    <span>{l.state}</span>
                    <p>{l.message}</p>
                  </div>
                ))}
              {!data.logs.some((l) => l.taskId === logs) && (
                <Empty>No execution events yet.</Empty>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
function taskConfig({ state, runId, updatedAt, ...config }: Task) {
  return { ...config };
}
function Performance({ data }: { data: Snapshot }) {
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - 6 + i);
    return d;
  });
  const values = days.map(
    (d) =>
      data.runs.filter(
        (r) =>
          r.outcome === "COMPLETED" &&
          r.endedAt &&
          new Date(r.endedAt).toDateString() === d.toDateString(),
      ).length,
  );
  const max = Math.max(2, Math.ceil(Math.max(...values) / 2) * 2);
  return (
    <div className="chart">
      <div className="chart-y">
        <span>{max}</span>
        <span>{Math.round(max / 2)}</span>
        <span>0</span>
      </div>
      <div className="chart-bars">
        {days.map((d, i) => (
          <div className="chart-column" key={i}>
            <div className="bar-track">
              <div
                className="bar"
                style={{ height: `${(values[i] / max) * 100}%` }}
                title={`${values[i]} completed runs`}
              />
            </div>
            <span>{d.toLocaleDateString(undefined, { weekday: "short" })}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
type Field = {
  key: string;
  label: string;
  type?: "number" | "email";
  options?: { value: string; label: string }[];
};
function EntityForm({
  kind,
  initial,
  data,
  group,
  close,
  save,
}: {
  kind: FormKind;
  initial?: Record<string, unknown>;
  data: Snapshot;
  group: string;
  close: () => void;
  save: (cmd: Command) => Promise<boolean>;
}) {
  const defaults: Record<FormKind, Record<string, unknown>> = {
    Group: { name: "", retailer: "mock" },
    Task: {
      name: "",
      workflow:
        data.retailers.find(
          (r) =>
            r.id ===
            data.groups.find(
              (g) => g.id === (group !== "all" ? group : data.groups[0]?.id),
            )?.retailer,
        )?.capabilities.checkout === false
          ? "MONITOR_AND_NOTIFY"
          : "MONITOR_AND_CHECKOUT",
      product: "",
      variantId: "",
      groupId: group !== "all" ? group : (data.groups[0]?.id ?? ""),
      profileId: "",
      proxyId: "",
      scenario: "available",
      intervalMs: 1000,
      maxRetries: 3,
    },
    Profile: {
      name: "",
      group: "Default",
      email: "",
      phone: "",
      address: "",
      city: "",
      postalCode: "",
      country: "CA",
      paymentToken: "mock_demo",
    },
    Proxy: {
      name: "",
      group: "Default",
      protocol: "http",
      host: "",
      port: 8080,
    },
  };
  const [value, setValue] = useState<Record<string, unknown>>(
    initial
      ? kind === "Task"
        ? {
            ...initial,
            profileId: initial.profileId ?? "",
            proxyId: initial.proxyId ?? "",
          }
        : { ...initial }
      : defaults[kind],
  );
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const fields: Record<FormKind, Field[]> = {
    Group: [
      { key: "name", label: "Group name" },
      {
        key: "retailer",
        label: "Retailer",
        options: data.retailers.map((r) => ({
          value: r.id,
          label:
            r.name +
            (r.capabilities.simulated ? " · Simulation" : " · Inventory only"),
        })),
      },
    ],
    Task: [
      { key: "name", label: "Task name" },
      {
        key: "workflow",
        label: "Workflow",
        options: [
          { value: "MONITOR_ONLY", label: "Monitor continuously" },
          { value: "MONITOR_AND_NOTIFY", label: "Monitor and notify" },
          {
            value: "MONITOR_AND_CHECKOUT",
            label: "Monitor and simulated checkout",
          },
        ],
      },
      { key: "product", label: "Product identifier" },
      { key: "variantId", label: "Variant identifier (optional)" },
      {
        key: "groupId",
        label: "Task group",
        options: data.groups.map((g) => ({ value: g.id, label: g.name })),
      },
      {
        key: "profileId",
        label: "Profile",
        options: [
          { value: "", label: "Unassigned" },
          ...data.profiles.map((p) => ({ value: p.id, label: p.name })),
        ],
      },
      {
        key: "proxyId",
        label: "Proxy configuration",
        options: [
          { value: "", label: "Unassigned" },
          ...data.proxies.map((p) => ({ value: p.id, label: p.name })),
        ],
      },
      {
        key: "scenario",
        label: "Simulation scenario",
        options: scenarios.map((s) => ({
          value: s,
          label: s.replaceAll("-", " "),
        })),
      },
      { key: "intervalMs", label: "Monitor interval (ms)", type: "number" },
      { key: "maxRetries", label: "Maximum retries", type: "number" },
    ],
    Profile: [
      { key: "name", label: "Profile name" },
      { key: "group", label: "Profile group" },
      { key: "email", label: "Email", type: "email" },
      { key: "phone", label: "Phone" },
      { key: "address", label: "Shipping address" },
      { key: "city", label: "City" },
      { key: "postalCode", label: "Postal code" },
      { key: "country", label: "Country (2-letter code)" },
      { key: "paymentToken", label: "Payment placeholder (mock_…)" },
    ],
    Proxy: [
      { key: "name", label: "Proxy name" },
      { key: "group", label: "Proxy group" },
      {
        key: "protocol",
        label: "Protocol",
        options: [
          { value: "http", label: "HTTP" },
          { value: "socks5", label: "SOCKS5" },
        ],
      },
      { key: "host", label: "Hostname / IP (no credentials)" },
      { key: "port", label: "Port", type: "number" },
    ],
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    const payload = { ...value };
    if (kind === "Task") {
      payload.variantId = payload.variantId || null;
      payload.profileId = payload.profileId || null;
      payload.proxyId = payload.proxyId || null;
    }
    const ok = await save({ type: `save${kind}`, data: payload } as Command);
    setSaving(false);
    if (ok) close();
    else setFormError(useWorkspace.getState().error ?? "Unable to save");
  };
  return (
    <div className="modal-backdrop">
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={`${initial ? "Edit" : "New"} ${kind.toLowerCase()}`}
        onSubmit={(e) => void submit(e)}
      >
        <div className="panel-heading">
          <h2>
            {initial ? "Edit" : "New"} {kind.toLowerCase()}
          </h2>
          <button type="button" aria-label="Close form" onClick={close}>
            <X size={20} />
          </button>
        </div>
        <p className="form-description">
          {kind === "Task"
            ? "Monitor continuously or run an approved simulated checkout. Configure inventory integrations in Settings."
            : kind === "Profile"
              ? "Only contact details and placeholder payment tokens are accepted."
              : kind === "Proxy"
                ? "Configurations are syntax-validated and stored locally."
                : "Keep related tasks together in a retailer workspace."}
        </p>
        {kind === "Task" && !data.groups.length && (
          <div className="alert">Create a task group first.</div>
        )}
        <div className="form-grid">
          {fields[kind].map((field) => (
            <label key={field.key}>
              {field.label}
              {field.options ? (
                <select
                  aria-label={field.label}
                  value={String(value[field.key] ?? "")}
                  onChange={(e) =>
                    setValue({
                      ...value,
                      [field.key]: e.target.value,
                      ...(field.key === "groupId" &&
                      !data.retailers.find(
                        (r) =>
                          r.id ===
                          data.groups.find((g) => g.id === e.target.value)
                            ?.retailer,
                      )?.capabilities.checkout
                        ? { workflow: "MONITOR_AND_NOTIFY" }
                        : {}),
                    })
                  }
                  required={!["profileId", "proxyId"].includes(field.key)}
                >
                  {field.options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  aria-label={field.label}
                  type={field.type ?? "text"}
                  value={String(value[field.key] ?? "")}
                  onChange={(e) =>
                    setValue({
                      ...value,
                      [field.key]:
                        field.type === "number"
                          ? Number(e.target.value)
                          : e.target.value,
                    })
                  }
                  required={
                    ![
                      "phone",
                      "address",
                      "city",
                      "postalCode",
                      "variantId",
                    ].includes(field.key)
                  }
                  maxLength={field.type ? undefined : 200}
                />
              )}
            </label>
          ))}
        </div>
        {formError && (
          <div className="alert" role="alert">
            {formError}
          </div>
        )}
        <div className="modal-footer">
          <Button type="button" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            disabled={saving || (kind === "Task" && !data.groups.length)}
          >
            {saving ? "Saving…" : "Save " + kind.toLowerCase()}
          </Button>
        </div>
      </form>
    </div>
  );
}
function SettingsForm({
  data,
  save,
}: {
  data: Snapshot;
  save: (cmd: Command) => Promise<boolean>;
}) {
  const [settings, setSettings] = useState(data.settings);
  const [saved, setSaved] = useState(false);
  return (
    <form
      className="panel settings-panel"
      onSubmit={async (e) => {
        e.preventDefault();
        setSaved(await save({ type: "settings", data: settings }));
      }}
    >
      <div className="panel-heading">
        <h2>Workspace preferences</h2>
      </div>
      <div className="setting-row">
        <div>
          <strong>Resume interrupted monitoring</strong>
          <p>
            Resume inventory monitoring after restart. Checkout is never
            automatically retried.
          </p>
        </div>
        <input
          aria-label="Resume interrupted monitoring"
          type="checkbox"
          checked={settings.resumeMonitoring}
          onChange={(e) => {
            setSaved(false);
            setSettings({ ...settings, resumeMonitoring: e.target.checked });
          }}
        />
      </div>
      <div className="setting-row">
        <div>
          <strong>Task concurrency</strong>
          <p>
            Maximum concurrent monitoring, cart, and checkout operations.
            Approval waits release capacity.
          </p>
        </div>
        <input
          aria-label="Task concurrency"
          type="number"
          min={1}
          max={20}
          value={settings.concurrency}
          onChange={(e) => {
            setSaved(false);
            setSettings({ ...settings, concurrency: Number(e.target.value) });
          }}
        />
      </div>
      <div className="setting-row">
        <div>
          <strong>Startup view</strong>
          <p>Choose the screen shown when opening the app.</p>
        </div>
        <select
          aria-label="Startup view"
          value={settings.launchView}
          onChange={(e) =>
            setSettings({ ...settings, launchView: e.target.value as View })
          }
        >
          {views.map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
      </div>
      <div className="setting-row">
        <div>
          <strong>Completion notifications</strong>
          <p>Show an in-app notice when a simulated checkout completes.</p>
        </div>
        <input
          aria-label="Completion notifications"
          type="checkbox"
          checked={settings.notifications}
          onChange={(e) =>
            setSettings({ ...settings, notifications: e.target.checked })
          }
        />
      </div>
      {(
        [
          [
            "inventoryNotifications",
            "Inventory notifications",
            "Show in-app alerts for monitor-and-notify tasks.",
          ],
          [
            "nativeNotifications",
            "Native desktop notifications",
            "Also send inventory alerts through the operating system.",
          ],
        ] as const
      ).map(([key, label, description]) => (
        <div className="setting-row" key={key}>
          <div>
            <strong>{label}</strong>
            <p>{description}</p>
          </div>
          <input
            aria-label={label}
            type="checkbox"
            checked={settings[key]}
            onChange={(e) =>
              setSettings({ ...settings, [key]: e.target.checked })
            }
          />
        </div>
      ))}
      <div className="setting-row">
        <div>
          <strong>Logging detail</strong>
          <p>Debug mode also records out-of-stock inventory checks.</p>
        </div>
        <select
          aria-label="Logging detail"
          value={settings.logLevel}
          onChange={(e) =>
            setSettings({
              ...settings,
              logLevel: e.target.value as "info" | "debug",
            })
          }
        >
          <option value="info">Info</option>
          <option value="debug">Debug</option>
        </select>
      </div>
      <div className="modal-footer">
        {saved && (
          <span className="green" role="status">
            Preferences saved
          </span>
        )}
        <Button type="submit" variant="primary">
          Save preferences
        </Button>
      </div>
    </form>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
