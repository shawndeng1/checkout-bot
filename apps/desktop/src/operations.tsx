import { useEffect, useState } from "react";
import type {
  Command,
  Snapshot,
} from "../../../packages/shared-types/src/index";
import { Badge, Button, Empty } from "../../../packages/ui/src/index";
import { useWorkspace } from "./store";

type Props = { data: Snapshot; command: (input: Command) => Promise<boolean> };
const time = (value?: string) =>
  value ? new Date(value).toLocaleString() : "Never";
export function InventoryView({ data, command }: Props) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const tasks = data.tasks.filter(
    (task) => task.workflow !== "MONITOR_AND_CHECKOUT",
  );
  return (
    <div className="operations-stack">
      <section className="panel">
        <div className="panel-heading">
          <h2>Inventory watches</h2>
          <span className="muted">Intervals honor retailer limits</span>
        </div>
        <table>
          <thead>
            <tr>
              <th>PRODUCT / VARIANT</th>
              <th>WORKFLOW</th>
              <th>AVAILABILITY</th>
              <th>LAST OBSERVED</th>
              <th>ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => {
              const row = data.latestInventory.find(
                (item) => item.taskId === task.id,
              );
              const observation = row?.observation;
              const expired =
                observation &&
                (observation.expiresAt ?? observation.observedAt + 30000) <=
                  now;
              const active = ["MONITORING", "STOCK_DETECTED"].includes(
                task.state,
              );
              return (
                <tr key={task.id}>
                  <td>
                    <strong>{task.name}</strong>
                    <small>
                      {task.product}{" "}
                      {task.variantId
                        ? `· ${task.variantId}`
                        : "· All variants"}
                    </small>
                  </td>
                  <td>
                    {task.workflow === "MONITOR_AND_NOTIFY"
                      ? "Monitor and notify"
                      : "Monitor only"}
                    <small>
                      <Badge state={task.state} />
                    </small>
                  </td>
                  <td>
                    <span
                      className={
                        observation?.availability === "in-stock" && !expired
                          ? "green"
                          : "muted"
                      }
                    >
                      {expired
                        ? "Expired observation"
                        : (observation?.availability ?? "Not observed")}
                    </span>
                  </td>
                  <td>
                    {observation
                      ? time(new Date(observation.observedAt).toISOString())
                      : "Never"}
                  </td>
                  <td>
                    <Button
                      onClick={() =>
                        void command({
                          type: active ? "stop" : "start",
                          id: task.id,
                        })
                      }
                    >
                      {active ? "Stop" : "Start"} {task.name}
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!tasks.length && (
          <Empty>
            Create a task with the Monitor continuously or Monitor and notify
            workflow in Tasks.
          </Empty>
        )}
      </section>
      <section className="panel">
        <div className="panel-heading">
          <h2>Inventory notifications</h2>
          <span className="muted">
            Availability alerts · no contact or payment information
          </span>
        </div>
        {data.notices.map((notice) => (
          <div className="activity-row" key={notice.id}>
            <div>
              <strong>{notice.message}</strong>
              <p>
                {notice.retailer} · {notice.product}
                {notice.variant ? ` · ${notice.variant}` : ""}
              </p>
            </div>
            <time>{time(notice.at)}</time>
          </div>
        ))}
        {!data.notices.length && (
          <Empty>
            Monitor-and-notify tasks alert when inventory becomes available.
          </Empty>
        )}
      </section>
      <section className="panel">
        <div className="panel-heading">
          <h2>Observation history</h2>
          <span className="muted">
            Latest 100 events · repeated heartbeats omitted
          </span>
        </div>
        {data.inventory.slice(0, 100).map((row) => (
          <div className="activity-row" key={row.id}>
            <div>
              <strong>
                {data.tasks.find((task) => task.id === row.taskId)?.name ??
                  row.taskId}
              </strong>
              <p>
                {row.observation.product.productId} ·{" "}
                {row.observation.product.variantId ?? "All variants"} ·{" "}
                {row.observation.availability}
              </p>
            </div>
            <time>{time(row.receivedAt)}</time>
          </div>
        ))}
        {!data.inventory.length && (
          <Empty>No inventory observations recorded.</Empty>
        )}
      </section>
    </div>
  );
}
export function ReconciliationView({ data, command }: Props) {
  const [pending, setPending] = useState<string[]>([]);
  const attempts = data.attempts.filter(
    (attempt) =>
      data.tasks.some(
        (task) =>
          task.id === attempt.taskId &&
          task.runId === attempt.id &&
          task.state === "UNKNOWN_OUTCOME",
      ) || data.reconciliations.some((row) => row.attemptId === attempt.id),
  );
  return (
    <div className="operations-stack">
      {attempts.map((attempt) => {
        const task = data.tasks.find((task) => task.id === attempt.taskId);
        const retailer =
          attempt.retailerId ??
          data.groups.find((group) => group.id === task?.groupId)?.retailer;
        const history = data.reconciliations.filter(
          (row) => row.attemptId === attempt.id,
        );
        const current = task?.runId === attempt.id;
        const busy =
          pending.includes(attempt.id) ||
          history.some((row) => row.status === "started");
        return (
          <section className="panel" key={attempt.id}>
            <div className="panel-heading">
              <h2>{task?.name ?? "Task"}</h2>
              <Badge
                state={
                  attempt.lastStatus?.status === "completed"
                    ? "COMPLETED"
                    : attempt.lastStatus?.status === "failed"
                      ? "FAILED"
                      : "UNKNOWN_OUTCOME"
                }
              />
            </div>
            <dl className="detail-grid">
              <dt>Task identifier</dt>
              <dd>{attempt.taskId}</dd>
              <dt>Retailer</dt>
              <dd>{retailer}</dd>
              <dt>Product / variant</dt>
              <dd>
                {attempt.cart.product.productId} ·{" "}
                {attempt.cart.product.variantId ?? "All variants"}
              </dd>
              <dt>Checkout attempt</dt>
              <dd>{attempt.id}</dd>
              <dt>Submitted</dt>
              <dd>{time(attempt.submittedAt)}</dd>
              <dt>Last reconciliation</dt>
              <dd>{time(history[0]?.at)}</dd>
              <dt>Last reported result</dt>
              <dd>
                {attempt.lastStatus?.status ?? "Unknown"}
                {attempt.lastStatus?.status === "completed"
                  ? ` · Order ${attempt.lastStatus.orderId}`
                  : ""}
              </dd>
            </dl>
            <div className="panel-heading">
              <p className="muted">
                Status checks never submit an order. Inconclusive results remain
                blocked.
              </p>
              <Button
                variant="primary"
                disabled={busy || !current || task?.state !== "UNKNOWN_OUTCOME"}
                onClick={async () => {
                  setPending((ids) => [...ids, attempt.id]);
                  try {
                    await command({ type: "reconcile", id: attempt.taskId });
                  } finally {
                    setPending((ids) => ids.filter((id) => id !== attempt.id));
                  }
                }}
              >
                {busy ? "Checking…" : "Check Order Status"}
              </Button>
            </div>
            <div className="panel-heading">
              <h3>Reconciliation history</h3>
            </div>
            {history.map((row) => (
              <div className="activity-row" key={row.id}>
                <div>
                  <strong>{row.status}</strong>
                  <p>{row.message}</p>
                </div>
                <time>{time(row.at)}</time>
              </div>
            ))}
            {!history.length && <Empty>No status checks yet.</Empty>}
          </section>
        );
      })}
      {!attempts.length && (
        <section className="panel">
          <Empty>No uncertain simulated orders to reconcile.</Empty>
        </section>
      )}
    </div>
  );
}
export function IntegrationSettings({ data }: { data: Snapshot }) {
  return (
    <div className="operations-stack integration-settings">
      {data.retailers
        .filter((retailer) => retailer.configurationFields.length)
        .map((retailer) => (
          <IntegrationForm key={retailer.id} retailer={retailer} />
        ))}
    </div>
  );
}
function IntegrationForm({
  retailer,
}: {
  retailer: Snapshot["retailers"][number];
}) {
  const [config, setConfig] = useState<Record<string, unknown>>(() => ({
    ...Object.fromEntries(
      retailer.configurationFields.map((field) => [
        field.key,
        field.defaultValue ?? "",
      ]),
    ),
    ...retailer.config,
  }));
  const [credential, setCredential] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  return (
    <form
      className="panel settings-panel"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setMessage("");
        try {
          const snapshot = await window.retail.configureIntegration({
            retailerId: retailer.id,
            config,
            ...(credential ? { credential } : {}),
          });
          useWorkspace.getState().setData(snapshot);
          setCredential("");
          setMessage("Integration saved");
        } catch (error) {
          setMessage(
            error instanceof Error ? error.message : "Configuration failed",
          );
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="panel-heading">
        <h2>{retailer.name}</h2>
        <span className="token">Inventory only</span>
      </div>
      <p className="form-description">
        Use a local fixture or an authorized developer store. Stop this
        retailer’s tasks before changing configuration. Storefront inventory
        access never enables checkout.
      </p>
      <div className="form-grid">
        {retailer.configurationFields.map((field) => (
          <label key={field.key}>
            {field.label}
            {field.type === "checkbox" ? (
              <input
                aria-label={field.label}
                type="checkbox"
                checked={config[field.key] === true}
                onChange={(event) =>
                  setConfig({ ...config, [field.key]: event.target.checked })
                }
              />
            ) : field.type === "select" ? (
              <select
                aria-label={field.label}
                value={String(config[field.key] ?? "")}
                onChange={(event) =>
                  setConfig({ ...config, [field.key]: event.target.value })
                }
              >
                {field.options?.map((option) => (
                  <option value={option.value} key={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                aria-label={field.label}
                value={String(config[field.key] ?? "")}
                required
                onChange={(event) =>
                  setConfig({ ...config, [field.key]: event.target.value })
                }
              />
            )}
          </label>
        ))}
        <label>
          Storefront access token
          <input
            aria-label="Storefront access token"
            type="password"
            autoComplete="off"
            value={credential}
            placeholder={
              retailer.credentialConfigured
                ? "Stored securely · leave blank to keep"
                : "Optional for fixture; required for authorized store"
            }
            onChange={(event) => setCredential(event.target.value)}
          />
        </label>
      </div>
      <p className="form-description">
        Tokens are encrypted using the OS credential service. There is no
        plaintext fallback. Tokens never appear in snapshots or the application
        database.
      </p>
      <div className="modal-footer">
        {message && <span role="status">{message}</span>}
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? "Saving…" : "Save integration"}
        </Button>
      </div>
    </form>
  );
}
