import { useEffect, useRef, useState } from "react";
import type {
  ProductDetails,
  ProductPage,
} from "../../../packages/retailer-sdk/src/index";
import type { Snapshot } from "../../../packages/shared-types/src/index";
import { Button, Empty } from "../../../packages/ui/src/index";
import { useWorkspace } from "./store";
export function DiscoveryView({
  data,
  onCreated,
}: {
  data: Snapshot;
  onCreated: () => void;
}) {
  const adapters = data.retailers.filter(
    (retailer) =>
      retailer.capabilities.productLookup ||
      retailer.capabilities.productSearch,
  );
  const [retailer, setRetailer] = useState(adapters[0]?.id ?? "");
  const [text, setText] = useState("");
  const [page, setPage] = useState<ProductPage | null>(null);
  const [selected, setSelected] = useState<ProductDetails | null>(null);
  const [variant, setVariant] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [groupId, setGroupId] = useState("");
  const [groupName, setGroupName] = useState("Discovered products");
  const [intervalMs, setInterval] = useState(1000);
  const [workflow, setWorkflow] = useState<
    "MONITOR_ONLY" | "MONITOR_AND_NOTIFY"
  >("MONITOR_AND_NOTIFY");
  const current = useRef<string | null>(null);
  const adapter = adapters.find((item) => item.id === retailer);
  const groups = data.groups.filter((group) => group.retailer === retailer);
  const cancel = () => {
    if (current.current) {
      void window.retail.cancelDiscovery(current.current).catch(() => {});
      current.current = null;
    }
    setBusy(false);
  };
  useEffect(
    () => () => {
      if (current.current)
        void window.retail.cancelDiscovery(current.current).catch(() => {});
    },
    [],
  );
  const request = async (
    mode: "search" | "lookup",
    identifier = text,
    cursor: string | null = null,
  ) => {
    cancel();
    const id = crypto.randomUUID();
    current.current = id;
    setBusy(true);
    setError("");
    try {
      const result = await window.retail.discover({
        requestId: id,
        retailerId: retailer,
        mode,
        text: identifier,
        cursor,
        limit: 12,
      });
      if (current.current !== id) return;
      if (mode === "lookup") {
        setSelected(result.products[0] ?? null);
        setVariant("");
      } else {
        setPage(result);
        setSelected(null);
      }
    } catch (error) {
      if (current.current === id)
        setError(error instanceof Error ? error.message : "Discovery failed");
    } finally {
      if (current.current === id) {
        current.current = null;
        setBusy(false);
      }
    }
  };
  return (
    <div className="operations-stack">
      <section className="panel discovery-panel">
        <div className="panel-heading">
          <h2>Find a product</h2>
          <span className="token">Authorized inventory APIs</span>
        </div>
        <form
          className="discovery-controls"
          onSubmit={(event) => {
            event.preventDefault();
            void request(
              adapter?.capabilities.productSearch ? "search" : "lookup",
            );
          }}
        >
          <label>
            Discovery retailer
            <select
              aria-label="Discovery retailer"
              value={retailer}
              onChange={(event) => {
                cancel();
                setRetailer(event.target.value);
                setPage(null);
                setSelected(null);
                setError("");
                setGroupId("");
              }}
            >
              {adapters.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Product search or identifier
            <input
              aria-label="Product search or identifier"
              value={text}
              maxLength={200}
              required
              onChange={(event) => {
                cancel();
                setText(event.target.value);
                setPage(null);
                setSelected(null);
              }}
              placeholder="Search text, product handle or ID"
            />
          </label>
          <Button type="submit" disabled={busy || !text.trim() || !adapter}>
            {adapter?.capabilities.productSearch
              ? "Search products"
              : "Look up product"}
          </Button>
          {adapter?.capabilities.productLookup && (
            <Button
              type="button"
              disabled={busy || !text.trim()}
              onClick={() => void request("lookup")}
            >
              Look up identifier
            </Button>
          )}
          {busy && (
            <Button type="button" onClick={cancel}>
              Cancel discovery
            </Button>
          )}
        </form>
        {busy && (
          <p role="status" className="form-description">
            Loading products…
          </p>
        )}
        {error && (
          <div role="alert" className="alert">
            {error}
          </div>
        )}
        {!adapters.length && (
          <Empty>
            No registered adapter supports discovery. Create a task using a
            product identifier in Tasks.
          </Empty>
        )}
        {page && (
          <>
            <div className="product-grid">
              {page.products.map((product) => (
                <article className="product-card" key={product.id}>
                  <ProductImage product={product} />
                  <h3>{product.title}</h3>
                  <span className="muted">
                    {product.available === undefined
                      ? "Select for availability"
                      : product.available
                        ? "Available"
                        : "Unavailable"}
                  </span>
                  <p>{product.description}</p>
                  <small className="muted">
                    {product.handle ?? product.id}
                  </small>
                  <Button
                    disabled={busy}
                    onClick={() => void request("lookup", product.id)}
                  >
                    Select {product.title}
                  </Button>
                </article>
              ))}
            </div>
            {!page.products.length && (
              <Empty>No products found. Try a handle or ID lookup.</Empty>
            )}
            <div className="modal-footer">
              <Button
                disabled={busy || !page.nextCursor}
                onClick={() => void request("search", text, page.nextCursor)}
              >
                Next products
              </Button>
            </div>
          </>
        )}
      </section>
      {selected && (
        <section className="panel">
          <div className="panel-heading">
            <h2>{selected.title}</h2>
            <span className="muted">
              Observed{" "}
              {selected.observedAt
                ? new Date(selected.observedAt).toLocaleString()
                : "Unknown"}
            </span>
          </div>
          <div className="product-detail">
            <ProductImage product={selected} />
            <div>
              <p>{selected.description}</p>
              <p className="mono">{selected.id}</p>
              <label>
                Monitoring variant
                <select
                  aria-label="Monitoring variant"
                  value={variant}
                  onChange={(event) => setVariant(event.target.value)}
                >
                  <option value="">Any available variant</option>
                  {selected.variants.map((item) => (
                    <option value={item.id} key={item.id}>
                      {item.title} ·{" "}
                      {item.available ? "Available" : "Unavailable"}{" "}
                      {item.attributes
                        ?.map(
                          (attribute) =>
                            `${attribute.name}: ${attribute.value}`,
                        )
                        .join(" / ")}
                    </option>
                  ))}
                </select>
              </label>
              <ul className="variant-list">
                {selected.variants.map((item) => (
                  <li key={item.id}>
                    <strong>{item.title}</strong> ·{" "}
                    {item.available ? "Available" : "Unavailable"}
                    <small>
                      {item.attributes
                        ?.map(
                          (attribute) =>
                            `${attribute.name}: ${attribute.value}`,
                        )
                        .join(" · ")}
                    </small>
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              setSaving(true);
              setError("");
              try {
                let target = groupId || groups[0]?.id;
                if (!target) {
                  const snapshot = await window.retail.command({
                    type: "saveGroup",
                    data: { name: groupName, retailer },
                  });
                  useWorkspace.getState().setData(snapshot);
                  target = snapshot.groups.find(
                    (group) =>
                      group.name === groupName && group.retailer === retailer,
                  )!.id;
                }
                const name =
                  `${selected.title}${variant ? " · " + selected.variants.find((item) => item.id === variant)?.title : ""}`.slice(
                    0,
                    120,
                  );
                const ok = await useWorkspace.getState().command({
                  type: "saveTask",
                  data: {
                    name,
                    groupId: target,
                    product: selected.id,
                    variantId: variant || null,
                    workflow,
                    scenario: "available",
                    intervalMs,
                    maxRetries: 2,
                  },
                });
                if (ok) onCreated();
                else
                  setError(
                    useWorkspace.getState().error ?? "Could not create monitor",
                  );
              } catch (error) {
                setError(
                  error instanceof Error
                    ? error.message
                    : "Could not create monitor",
                );
              } finally {
                setSaving(false);
              }
            }}
          >
            <div className="form-grid monitoring-form">
              {groups.length ? (
                <label>
                  Monitoring group
                  <select
                    aria-label="Monitoring group"
                    value={groupId || groups[0]?.id}
                    onChange={(event) => setGroupId(event.target.value)}
                  >
                    {groups.map((group) => (
                      <option key={group.id} value={group.id}>
                        {group.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <label>
                  New monitoring group
                  <input
                    aria-label="New monitoring group"
                    value={groupName}
                    onChange={(event) => setGroupName(event.target.value)}
                    required
                    maxLength={120}
                  />
                </label>
              )}
              <label>
                Inventory workflow
                <select
                  aria-label="Inventory workflow"
                  value={workflow}
                  onChange={(event) =>
                    setWorkflow(event.target.value as typeof workflow)
                  }
                >
                  <option value="MONITOR_AND_NOTIFY">Monitor and notify</option>
                  <option value="MONITOR_ONLY">Monitor only</option>
                </select>
              </label>
              <label>
                Discovery monitoring interval (ms)
                <input
                  aria-label="Discovery monitoring interval (ms)"
                  type="number"
                  min={100}
                  max={60000}
                  value={intervalMs}
                  onChange={(event) => setInterval(Number(event.target.value))}
                />
              </label>
            </div>
            <div className="modal-footer">
              <Button variant="primary" type="submit" disabled={saving}>
                {saving ? "Creating…" : "Create monitoring task"}
              </Button>
            </div>
          </form>
        </section>
      )}
    </div>
  );
}
export function ProductImage({
  product,
}: {
  product: Pick<ProductDetails, "title" | "image">;
}) {
  return product.image ? (
    <img
      className="product-image"
      src={product.image.url}
      alt={product.image.alt ?? product.title}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={(event) => {
        event.currentTarget.style.display = "none";
      }}
    />
  ) : (
    <div
      className="product-image image-placeholder"
      aria-label="No product image"
    >
      No image
    </div>
  );
}
