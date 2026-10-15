import { useEffect, useState } from "react";
import type {
  CredentialStatus,
  Diagnostics,
} from "../../../packages/shared-types/src/index";
import { Button } from "../../../packages/ui/src/index";
export function BackendHealth({
  onStatus,
}: {
  onStatus: (available: boolean) => void;
}) {
  useEffect(() => {
    let alive = true;
    const check = () => {
      void window.retail
        ?.diagnostics()
        .then((result) => {
          if (alive) onStatus(result.workerAvailable);
        })
        .catch(() => {
          if (alive) onStatus(false);
        });
    };
    check();
    const timer = setInterval(check, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [onStatus]);
  return null;
}
export function DiagnosticsPanel() {
  const [data, setData] = useState<Diagnostics | null>(null);
  const [credentials, setCredentials] = useState<CredentialStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = async () => {
    setBusy(true);
    const result = await Promise.allSettled([
      window.retail.diagnostics(),
      window.retail.credentialStatus(),
    ]);
    if (result[0].status === "fulfilled") setData(result[0].value);
    else setError("Backend diagnostics unavailable");
    if (result[1].status === "fulfilled") setCredentials(result[1].value);
    setBusy(false);
  };
  useEffect(() => {
    void load();
  }, []);
  return (
    <section className="panel integration-settings">
      <div className="panel-heading">
        <h2>Worker diagnostics</h2>
        <Button disabled={busy} onClick={() => void load()}>
          Refresh diagnostics
        </Button>
      </div>
      {error && <p role="alert">{error}</p>}
      {credentials?.loadFailed && (
        <div className="alert" role="alert">
          Encrypted credentials are inaccessible. Replace or delete the affected
          credentials before starting monitoring.
        </div>
      )}
      {data && (
        <>
          <dl className="detail-grid">
            <dt>Backend worker</dt>
            <dd>
              {data.workerAvailable
                ? "Available"
                : "Unavailable · restart Orbit"}
            </dd>
            <dt>Active tasks / operations</dt>
            <dd>
              {data.activeTasks} / {data.activeOperations}
            </dd>
            <dt>Queued operations</dt>
            <dd>{data.queued}</dd>
            <dt>Subscriptions / subscribers</dt>
            <dd>
              {data.subscriptions} / {data.subscribers}
            </dd>
            <dt>Inventory polls</dt>
            <dd>{data.inventoryPolls}</dd>
            <dt>Database</dt>
            <dd>
              {data.database.available
                ? `${data.database.journalMode} · foreign keys ${data.database.foreignKeys} · ${data.database.integrity}`
                : "Unavailable"}
            </dd>
            <dt>Observation-to-persistence p50 / p95</dt>
            <dd>
              {data.eventLatency.p50Ms} / {data.eventLatency.p95Ms} ms ·{" "}
              {data.eventLatency.samples} samples
            </dd>
            <dt>Worker heap</dt>
            <dd>{(data.workerHeapBytes / 2 ** 20).toFixed(1)} MiB</dd>
            <dt>OS credential encryption</dt>
            <dd>
              {credentials
                ? credentials.encryptionAvailable
                  ? "Available"
                  : "Unavailable · no plaintext fallback"
                : "Status unavailable"}
            </dd>
            {credentials?.entries.map((entry) => (
              <div className="credential-status-row" key={entry.retailerId}>
                <dt>{entry.retailerId} credential</dt>
                <dd>{entry.status}</dd>
              </div>
            ))}
          </dl>
          <div className="panel-heading">
            <h3>Recent error classifications</h3>
          </div>
          {data.recentErrors.length ? (
            data.recentErrors.map((row, index) => (
              <div className="activity-row" key={index}>
                <strong>{row.code}</strong>
                <time>{new Date(row.at).toLocaleString()}</time>
              </div>
            ))
          ) : (
            <p className="form-description">
              No recent errors in this worker session.
            </p>
          )}
        </>
      )}
    </section>
  );
}
