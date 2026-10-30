import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import type {
  Flamegraph,
  ObserveSpan,
  Overview,
  TraceDetail,
} from "@tracelet/contracts";

export const number = (n: number | undefined) =>
  n === undefined || !Number.isFinite(n)
    ? "—"
    : new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(n);
export const ms = (n: number | undefined) =>
  n === undefined ? "—" : `${number(n)} ms`;
export const time = (s: string) =>
  new Date(s).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
export function Panel({
  title,
  meta,
  children,
  className = "",
}: {
  title: string;
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      <header className="panel-head">
        <h2>{title}</h2>
        <span>{meta}</span>
      </header>
      {children}
    </section>
  );
}
export function Status({ value }: { value: string }) {
  return (
    <span
      className={`status ${value === "ok" || value === "running" || value === "connected" ? "good" : value === "error" || value === "unavailable" ? "bad" : ""}`}
    >
      {value}
    </span>
  );
}
export function Empty({
  title = "No telemetry in this window",
  children,
}: {
  title?: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      <p>
        {children ??
          "Try another time range, service or instance. Data appears after the collector flushes."}
      </p>
    </div>
  );
}
export function Loading() {
  return (
    <div className="loading" role="status">
      <span className="loading-line" />
      Loading recorded telemetry…
    </div>
  );
}
export function ErrorState({
  error,
  retry,
}: {
  error: Error;
  retry: () => void;
}) {
  return (
    <div className="error-state" role="alert">
      <strong>
        {"status" in error && error.status === 403
          ? "Access denied"
          : "Telemetry could not be loaded"}
      </strong>
      <p>{error.message}</p>
      <button onClick={retry}>Try again</button>
    </div>
  );
}
export function Trend({
  data,
  field,
  title,
  meta,
}: {
  data: Overview["series"];
  field: "executions" | "errors" | "p95Ms";
  title: string;
  meta: ReactNode;
}) {
  const width = 600,
    height = 170;
  const max = Math.max(1, ...data.map((x) => x[field] ?? 0));
  const points = data
    .map((d, i) =>
      d[field] === undefined
        ? ""
        : `${i === 0 || data[i - 1]![field] === undefined ? "M" : "L"} ${(i * width) / Math.max(1, data.length - 1)},${height - (d[field]! / max) * (height - 12)}`,
    )
    .join(" ");
  return (
    <Panel title={title} meta={meta}>
      <div className="chart">
        <span className="chart-unit">
          {field === "p95Ms"
            ? "RESPONSE TIME / MS · APPROXIMATE HISTOGRAM P95"
            : "COUNT / RECORDED INTERVAL"}
        </span>
        {data.some((item) => item[field] !== undefined) ? (
          <>
            <svg
              viewBox={`0 0 ${width} ${height}`}
              role="img"
              aria-label={`${title}, ${data.length} recorded intervals; maximum ${number(max)}`}
              preserveAspectRatio="none"
            >
              {[0.25, 0.5, 0.75, 1].map((y) => (
                <line
                  key={y}
                  x1="0"
                  x2={width}
                  y1={height * y}
                  y2={height * y}
                  className="chart-grid"
                />
              ))}
              {field === "p95Ms" ? (
                <path
                  d={points}
                  fill="none"
                  stroke="#f34c7b"
                  strokeWidth="2"
                  vectorEffect="non-scaling-stroke"
                />
              ) : (
                data.map((d, i) => (
                  <rect
                    key={i}
                    x={(i * width) / data.length + 1}
                    y={height - ((d[field] ?? 0) / max) * (height - 12)}
                    width={Math.max(1, width / data.length - 3)}
                    height={((d[field] ?? 0) / max) * (height - 12)}
                    fill={field === "errors" ? "#cf5677" : "#997b8a"}
                  />
                ))
              )}
            </svg>
            <div className="chart-axis">
              <span>{time(data[0]!.t)}</span>
              <span>{time(data[data.length - 1]!.t)}</span>
            </div>
          </>
        ) : (
          <Empty
            title={
              field === "p95Ms"
                ? "No latency percentiles recorded"
                : "No recorded intervals"
            }
          />
        )}
      </div>
    </Panel>
  );
}

export function Waterfall({ detail }: { detail: TraceDetail }) {
  const [selectedId, select] = useState(detail.spans[0]?.spanId);
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [scroll, setScroll] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState(0);
  const rows = useMemo(() => {
    const ids = new Set(detail.spans.map((s) => s.spanId));
    const children = new Map<string, ObserveSpan[]>();
    const roots: ObserveSpan[] = [];
    for (const span of detail.spans) {
      if (!span.parentSpanId || !ids.has(span.parentSpanId)) roots.push(span);
      else {
        const list = children.get(span.parentSpanId) ?? [];
        list.push(span);
        children.set(span.parentSpanId, list);
      }
    }
    for (const list of [roots, ...children.values()])
      list.sort((a, b) => a.startOffsetMs - b.startOffsetMs);
    const result: {
      span: ObserveSpan;
      depth: number;
      hasChildren: boolean;
      orphan: boolean;
    }[] = [];
    const seen = new Set<string>();
    function walk(start: ObserveSpan, orphan: boolean) {
      const pending = [{ span: start, depth: 0, orphan }];
      while (pending.length) {
        const row = pending.pop()!;
        if (seen.has(row.span.spanId)) continue;
        seen.add(row.span.spanId);
        const nested = children.get(row.span.spanId) ?? [];
        result.push({ ...row, hasChildren: nested.length > 0 });
        if (!collapsed.has(row.span.spanId))
          for (let i = nested.length - 1; i >= 0; i--)
            pending.push({
              span: nested[i]!,
              depth: row.depth + 1,
              orphan: false,
            });
        else {
          const hidden = [...nested];
          while (hidden.length) {
            const item = hidden.pop()!;
            if (seen.has(item.spanId)) continue;
            seen.add(item.spanId);
            hidden.push(...(children.get(item.spanId) ?? []));
          }
        }
      }
    }
    for (const root of roots) walk(root, Boolean(root.parentSpanId));
    for (const span of detail.spans)
      if (!seen.has(span.spanId)) walk(span, true);
    return result;
  }, [detail, collapsed]);
  const selected = detail.spans.find((s) => s.spanId === selectedId);
  const duration = Math.max(0.001, detail.trace.durationMs);
  const visible = rows.slice(
    Math.max(0, Math.floor(scroll / 36) - 6),
    Math.floor(scroll / 36) + 22,
  );
  const start = Math.max(0, Math.floor(scroll / 36) - 6);
  const toggle = (id: string) =>
    setCollapsed((old) => {
      const next = new Set(old);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  if (!rows.length)
    return (
      <Panel title="Execution waterfall">
        <Empty title="No retained spans">
          This trace has no retained span details. Its summary is available
          above.
        </Empty>
      </Panel>
    );
  return (
    <div className="trace-layout">
      <Panel
        title="Execution waterfall"
        meta={
          <div className="timeline-tools">
            <label>
              Zoom{" "}
              <input
                aria-label="Waterfall zoom"
                type="range"
                min="1"
                max="8"
                value={zoom}
                onChange={(e) => setZoom(+e.target.value)}
              />
            </label>
            <label>
              Offset{" "}
              <input
                aria-label="Waterfall offset"
                type="range"
                min="0"
                max="100"
                value={pan}
                disabled={zoom === 1}
                onChange={(e) => setPan(+e.target.value)}
              />
            </label>
          </div>
        }
      >
        <div className="waterfall-scroll">
          <div className="waterfall-header">
            <span>OPERATION · {rows.length} VISIBLE SPANS</span>
            <span>
              {ms((pan / 100) * (duration - duration / zoom))} —{" "}
              {ms((pan / 100) * (duration - duration / zoom) + duration / zoom)}
            </span>
            <span>DURATION</span>
          </div>
          <div
            className="waterfall-viewport"
            style={{ height: Math.min(440, Math.max(72, rows.length * 36)) }}
            tabIndex={0}
            role="region"
            aria-label="Execution spans; scroll with arrow keys to explore additional rows"
            onScroll={(e) => setScroll(e.currentTarget.scrollTop)}
          >
            <div style={{ height: rows.length * 36, position: "relative" }}>
              {visible.map((row, index) => (
                <div
                  key={row.span.spanId}
                  className={`waterfall-row ${selectedId === row.span.spanId ? "selected" : ""}`}
                  style={{
                    position: "absolute",
                    top: (start + index) * 36,
                    width: "100%",
                  }}
                >
                  <div
                    className="span-name"
                    style={{ paddingLeft: Math.min(row.depth, 12) * 12 }}
                  >
                    {row.hasChildren && (
                      <button
                        className="disclosure"
                        aria-label={`${collapsed.has(row.span.spanId) ? "Expand" : "Collapse"} ${row.span.operation}`}
                        aria-expanded={!collapsed.has(row.span.spanId)}
                        onClick={() => toggle(row.span.spanId)}
                      >
                        {collapsed.has(row.span.spanId) ? "+" : "−"}
                      </button>
                    )}
                    <button
                      className="text-link"
                      onClick={() => select(row.span.spanId)}
                      title={row.span.operation}
                    >
                      {row.orphan ? "[orphan] " : ""}
                      {row.span.operation}
                    </button>
                    {(row.span.collapsedCount ?? 1) > 1 && (
                      <span className="collapsed-label">
                        ×{row.span.collapsedCount} collapsed calls
                      </span>
                    )}
                  </div>
                  <button
                    className="span-track"
                    aria-label={`Inspect ${row.span.operation}, offset ${ms(row.span.startOffsetMs)}, duration ${ms(row.span.durationMs)}`}
                    onClick={() => select(row.span.spanId)}
                  >
                    <span
                      className={
                        row.span.status === "error"
                          ? "span-bar error"
                          : "span-bar"
                      }
                      style={{
                        left: `${((row.span.startOffsetMs / duration) * 100 - pan * (1 - 1 / zoom)) * zoom}%`,
                        width: `${Math.max(0.3, (row.span.durationMs / duration) * 100 * zoom)}%`,
                      }}
                    />
                  </button>
                  <span className="mono duration">
                    {ms(row.span.durationMs)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
        <p className="panel-note">
          Bars use execution wall time. Overlapping spans can run concurrently.
          Only visible rows are rendered; collapse parents to explore large
          traces.
        </p>
      </Panel>
      <Panel
        title="Span inspector"
        meta={selected ? <Status value={selected.status} /> : undefined}
      >
        {selected ? (
          <div className="inspector">
            <h3>{selected.operation}</h3>
            <dl>
              <dt>Duration</dt>
              <dd>{ms(selected.durationMs)}</dd>
              <dt>Start offset</dt>
              <dd>{ms(selected.startOffsetMs)}</dd>
              <dt>Self duration</dt>
              <dd>{ms(selected.selfDurationMs)}</dd>
              <dt>
                {(selected.collapsedCount ?? 1) > 1
                  ? "Summed duration / trace wall time"
                  : "Share of trace"}
              </dt>
              <dd>{number((selected.durationMs / duration) * 100)}%</dd>
              <dt>Origin</dt>
              <dd>
                {selected.origin ?? (selected.parentSpanId ? "auto" : "root")}
              </dd>
              <dt>Collapsed calls</dt>
              <dd>{selected.collapsedCount ?? 1}</dd>
              <dt>Span ID</dt>
              <dd>{selected.spanId}</dd>
              <dt>Service</dt>
              <dd>{detail.trace.serviceName}</dd>
              <dt>Instance</dt>
              <dd>{detail.trace.instanceId}</dd>
            </dl>
            {selected.selfDurationMs === undefined && (
              <p className="note">Exclusive time unavailable for this span.</p>
            )}
            {(selected.collapsedCount ?? 1) > 1 && (
              <p className="note">
                This record combines repeated calls. Durations are sums; the bar
                starts at the earliest call and does not represent one
                continuous interval.
              </p>
            )}
            {selected.sanitizedError && (
              <pre>
                {selected.sanitizedError.name}
                {selected.sanitizedError.message
                  ? `: ${selected.sanitizedError.message}`
                  : ""}
                {selected.sanitizedError.stack?.length
                  ? "\n" + selected.sanitizedError.stack.join("\n")
                  : ""}
              </pre>
            )}
          </div>
        ) : (
          <Empty title="Select a span" />
        )}
      </Panel>
    </div>
  );
}

type FlameNode = {
  name: string;
  count: number;
  children: Map<string, FlameNode>;
};
export function FlameView({ data }: { data: Flamegraph }) {
  const built = useMemo(() => {
    const root: FlameNode = {
      name: "Retained CPU samples",
      count: 0,
      children: new Map(),
    };
    let nodes = 1;
    let limited = false;
    for (const stack of data.stacks) {
      let current = root;
      current.count += stack.samples;
      for (const frame of stack.stack.split(";").slice(0, 128)) {
        let child = current.children.get(frame);
        if (!child) {
          if (nodes >= 20000) {
            limited = true;
            break;
          }
          child = { name: frame, count: 0, children: new Map() };
          current.children.set(frame, child);
          nodes++;
        }
        child.count += stack.samples;
        current = child;
      }
    }
    return { root, limited };
  }, [data]);
  const tree = built.root;
  const [path, setPath] = useState<string[]>([]);
  let focus = tree;
  for (const name of path) focus = focus.children.get(name) ?? focus;
  const frames: {
    node: FlameNode;
    depth: number;
    x: number;
    width: number;
    path: string[];
  }[] = [];
  let maxDepth = 0;
  let capped = false;
  function layout(
    node: FlameNode,
    depth: number,
    x: number,
    width: number,
    names: string[],
  ) {
    if (frames.length >= 1500 || depth > 48) {
      capped = true;
      return;
    }
    frames.push({ node, depth, x, width, path: names });
    maxDepth = Math.max(depth, maxDepth);
    let offset = x;
    for (const child of node.children.values()) {
      const share = (width * child.count) / Math.max(1, node.count);
      if (share >= 0.1)
        layout(child, depth + 1, offset, share, [...names, child.name]);
      offset += share;
    }
  }
  layout(focus, 0, 0, 100, path);
  return (
    <Panel
      title="Continuous CPU profile"
      meta={
        <button onClick={() => setPath([])} disabled={!path.length}>
          Reset zoom
        </button>
      }
    >
      <div className="flame-summary">
        <span className="status">CPU SAMPLES</span>
        <span>{number(data.sampleCount)} active samples</span>
        <span>{number(data.idleSampleCount ?? 0)} idle</span>
        <span>{number(data.droppedSampleCount)} dropped</span>
        <span>{data.profileCount} windows</span>
      </div>
      {tree.count ? (
        <>
          <div className="flame-scroll">
            <div className="flame" style={{ height: (maxDepth + 1) * 29 }}>
              {frames.map((frame, index) => (
                <button
                  key={index}
                  className="flame-frame"
                  style={{
                    top: frame.depth * 29,
                    left: `${frame.x}%`,
                    width: `${frame.width}%`,
                    backgroundColor: [
                      "#a27d94",
                      "#b0809a",
                      "#c07896",
                      "#d0789a",
                      "#dc86a6",
                    ][frame.depth % 5],
                  }}
                  title={`${frame.node.name}: ${number(frame.node.count)} inclusive samples (${number((frame.node.count / tree.count) * 100)}% of retained samples)`}
                  onClick={() => setPath(frame.path)}
                >
                  {frame.node.name}
                </button>
              ))}
            </div>
          </div>
          <div className="frame-inspector">
            <strong>{focus.name}</strong>
            <span>
              {number(focus.count)} inclusive samples ·{" "}
              {number((focus.count / tree.count) * 100)}% of retained samples
            </span>
          </div>
        </>
      ) : (
        <Empty title="No sampled frames in this period">
          Profiling may be disabled or unavailable. Check collector health for
          the recorded state.
        </Empty>
      )}
      <p className="panel-note">
        Widths represent retained CPU sample counts, separate from execution
        wall time. Select a frame to zoom. Idle and dropped samples are excluded
        from the graph.
        {data.truncated ? " Backend merge limits truncated this profile." : ""}
        {built.limited
          ? " Display tree limited to 20,000 frame nodes. Omitted descendants remain in their nearest shown ancestor’s inclusive count; blank child space is not a measurement of self time."
          : ""}
        {capped
          ? " Display limited to 1,500 frames / 49 levels; zoom a frame to explore further."
          : ""}
      </p>
    </Panel>
  );
}
