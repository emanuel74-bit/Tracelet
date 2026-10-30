import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type {
  ErrorGroupPage,
  Flamegraph,
  Health,
  InstanceList,
  MethodStatsList,
  Overview,
  Page,
  ObserveTrace,
  ProfileSummaryPage,
  ServiceList,
  TraceDetail,
} from "@tracelet/contracts";
import type { ApiClient } from "./api";
import type { Query } from "./api";
import { queryFor, readState, updateUrl } from "./state";
import type { DashboardState } from "./state";
import {
  Empty,
  ErrorState,
  FlameView,
  Loading,
  Panel,
  Status,
  Trend,
  Waterfall,
  ms,
  number,
  time,
} from "./components";

function useData<T>(
  client: ApiClient,
  path: string,
  query: Query,
  revision: number,
) {
  const key = JSON.stringify([path, query, revision]);
  const [value, setValue] = useState<{ key: string; data?: T; error?: Error }>({
    key: "",
  });
  useEffect(() => {
    const controller = new AbortController();
    let alive = true;
    setValue({ key });
    client
      .request<T>(path, query, controller.signal)
      .then((data) => {
        if (!alive) return;

        setValue({ key, data });
      })
      .catch((error) => {
        if (alive && !controller.signal.aborted)
          setValue({
            key,
            error: error instanceof Error ? error : new Error("Request failed"),
          });
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [key, client]);
  return value.key === key ? value : { key };
}
function Result<T>({
  result,
  retry,
  children,
}: {
  result: { data?: T; error?: Error };
  retry: () => void;
  children: (data: T) => ReactNode;
}) {
  return result.error ? (
    <ErrorState error={result.error} retry={retry} />
  ) : result.data === undefined ? (
    <Loading />
  ) : (
    children(result.data)
  );
}
const views = {
  overview: [
    "Dashboard",
    "Recorded executions and diagnostic evidence across your services.",
  ],
  methods: [
    "Services & methods",
    "Find the methods spending time in sampled executions.",
  ],
  traces: [
    "Executions",
    "Follow each execution through its nested method calls.",
  ],
  profiler: [
    "CPU profiler",
    "Continuous sampled stacks, independent of execution traces.",
  ],
  errors: ["Errors", "Sanitized exception groups from retained error traces."],
  health: [
    "Collector health",
    "Read-only state reported by each process heartbeat.",
  ],
} as const;
type View = keyof typeof views;
interface PageProps {
  client: ApiClient;
  state: DashboardState;
  revision: number;
  retry: () => void;
  change: (patch: Partial<DashboardState>) => void;
}
function TraceTable({
  items,
  open,
}: {
  items: ObserveTrace[];
  open: (id: string) => void;
}) {
  return items.length ? (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th scope="col">OPERATION</th>
            <th scope="col">SERVICE / INSTANCE</th>
            <th scope="col">STARTED</th>
            <th scope="col" className="right">
              DURATION
            </th>
            <th scope="col">STATUS</th>
            <th scope="col">TRACE</th>
          </tr>
        </thead>
        <tbody>
          {items.map((trace) => (
            <tr key={trace.traceId}>
              <td>
                <span className="kind">{trace.kind}</span>
                <button
                  className="text-link"
                  onClick={() => open(trace.traceId)}
                >
                  {trace.operation}
                </button>
              </td>
              <td>
                {trace.serviceName}
                <small>{trace.instanceId}</small>
              </td>
              <td className="mono">{time(trace.startedAt)}</td>
              <td className="mono right">{ms(trace.durationMs)}</td>
              <td>
                <Status value={trace.status} />
              </td>
              <td>
                <button
                  className="text-link mono"
                  onClick={() => open(trace.traceId)}
                  aria-label={`Open trace ${trace.traceId}`}
                >
                  {trace.traceId.slice(0, 10)}…
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <Empty />
  );
}
function OverviewPage(p: PageProps) {
  const query = queryFor(p.state);
  const overview = useData<Overview>(p.client, "/overview", query, p.revision);
  const recent = useData<Page<ObserveTrace>>(
    p.client,
    "/traces",
    { ...query, limit: "5" },
    p.revision,
  );
  return (
    <>
      <Result result={overview} retry={p.retry}>
        {(data) => (
          <>
            <div className="chart-pair">
              <Trend
                data={data.series}
                field="executions"
                title="Executions"
                meta={
                  <>
                    <b>{number(data.totals.executions)}</b> settled roots
                  </>
                }
              />
              <Trend
                data={data.series}
                field="p95Ms"
                title="Duration"
                meta={
                  <>
                    P95 <b>{ms(data.totals.p95Ms)}</b>
                  </>
                }
              />
            </div>
            <div className="overview-bottom">
              <Trend
                data={data.series}
                field="errors"
                title="Failed executions"
                meta={
                  <>
                    <b>{number(data.totals.errors)}</b> ·{" "}
                    {number(data.totals.errorRate * 100)}%
                  </>
                }
              />
              <Panel title="Performance outliers" meta="P95 · APPROXIMATE">
                <div className="operation-list">
                  {data.slowestOperations.length ? (
                    data.slowestOperations.map((op, index) => (
                      <button
                        key={index}
                        onClick={() =>
                          p.change({
                            view: "traces",
                            search: op.operation,
                            id: undefined,
                          })
                        }
                      >
                        <span>
                          <span className="kind">{op.kind}</span>
                          {op.operation}
                          <small>
                            {number(op.executions)} executions ·{" "}
                            {number(op.errors)} failures
                          </small>
                        </span>
                        <b>{ms(op.p95Ms)}</b>
                      </button>
                    ))
                  ) : (
                    <Empty title="No operation rollups" />
                  )}
                </div>
              </Panel>
            </div>
            <p className="note">
              Execution counts include all settled roots; trace and method
              details are sampled. Percentiles use approximate histogram
              buckets.
              {data.dataNotes.flushLagHintMs !== undefined
                ? ` Flush lag hint: ${ms(data.dataNotes.flushLagHintMs)}.`
                : ""}
            </p>
          </>
        )}
      </Result>
      <div className="section-title">
        <h2>Recent activity</h2>
        <button
          className="text-link"
          onClick={() => p.change({ view: "traces", id: undefined })}
        >
          View all executions →
        </button>
      </div>
      <Panel title="Retained trace evidence" meta="SAMPLED">
        <Result result={recent} retry={p.retry}>
          {(data) => (
            <TraceTable
              items={data.items}
              open={(id) => p.change({ view: "traces", id })}
            />
          )}
        </Result>
      </Panel>
    </>
  );
}
function MethodsPage(p: PageProps) {
  const data = useData<MethodStatsList>(
    p.client,
    "/methods",
    { ...queryFor(p.state), search: p.state.search },
    p.revision,
  );
  return (
    <>
      <p className="note">
        Sampled calls only. “Calls ending in error” includes rethrowing
        ancestors; do not sum these values along a call chain. Self duration is
        shown only when computable. Method-to-trace correlation is unavailable
        in v1; service links browse root executions without a method filter.
      </p>
      <Panel title="Method performance" meta="SORTED BY TOTAL DURATION">
        <Result result={data} retry={p.retry}>
          {(result) =>
            result.items.length ? (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">METHOD</th>
                      <th scope="col" className="right">
                        CALLS
                      </th>
                      <th scope="col" className="right">
                        AVG
                      </th>
                      <th scope="col" className="right">
                        P95 ≈
                      </th>
                      <th scope="col" className="right">
                        SELF AVG
                      </th>
                      <th scope="col" className="right">
                        CALLS ENDING IN ERROR
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.items.map((row, i) => (
                      <tr key={i}>
                        <td>
                          <span className="mono">{row.operation}</span>
                          <small>
                            {row.serviceName ?? "Across selected services"}
                          </small>
                          <button
                            className="text-link"
                            onClick={() =>
                              p.change({
                                view: "traces",
                                service: row.serviceName ?? p.state.service,
                                search: undefined,
                                status: undefined,
                                id: undefined,
                              })
                            }
                          >
                            Browse service executions →
                          </button>
                        </td>
                        <td className="right mono">{number(row.calls)}</td>
                        <td className="right mono">{ms(row.avgMs)}</td>
                        <td className="right mono">{ms(row.p95Ms)}</td>
                        <td className="right mono">
                          {ms(row.selfAvgMs)}
                          <small>
                            {number(row.selfSampleCount)} valid samples
                          </small>
                        </td>
                        <td className="right mono">{number(row.errors)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty title="No sampled method statistics" />
            )
          }
        </Result>
      </Panel>
    </>
  );
}
function usePagination(state: DashboardState) {
  const key = JSON.stringify([
    state.view,
    queryFor(state),
    state.search,
    state.status,
  ]);
  const [page, setPage] = useState<{
    key: string;
    history: (string | undefined)[];
  }>({ key, history: [undefined] });
  const history = page.key === key ? page.history : [undefined];
  return {
    cursor: history[history.length - 1],
    page: history.length,
    next: (cursor: string) => setPage({ key, history: [...history, cursor] }),
    previous: () => setPage({ key, history: history.slice(0, -1) }),
  };
}
function Pager({
  page,
  nextCursor,
  next,
  previous,
}: {
  page: number;
  nextCursor: string | null;
  next: (cursor: string) => void;
  previous: () => void;
}) {
  return (
    <div className="pager">
      <span>Page {page} · current filtered window</span>
      <div>
        <button disabled={page === 1} onClick={previous}>
          Previous
        </button>
        <button
          disabled={!nextCursor}
          onClick={() => nextCursor && next(nextCursor)}
        >
          Next page →
        </button>
      </div>
    </div>
  );
}
function TracesPage(p: PageProps) {
  const pagination = usePagination(p.state);
  const list = useData<Page<ObserveTrace>>(
    p.client,
    "/traces",
    {
      ...queryFor(p.state),
      status: p.state.status,
      search: p.state.search,
      cursor: pagination.cursor,
      limit: "50",
    },
    p.revision,
  );
  const detail = useData<TraceDetail>(
    p.client,
    p.state.id ? `/traces/${encodeURIComponent(p.state.id)}` : "/traces",
    p.state.id ? {} : { ...queryFor(p.state), limit: "1" },
    p.revision,
  );
  return p.state.id ? (
    <>
      <button
        className="text-link back"
        onClick={() => p.change({ id: undefined })}
      >
        ← All executions
      </button>
      <Result result={detail} retry={p.retry}>
        {(data) => (
          <>
            <div className="trace-banner">
              <div>
                <Status value={data.trace.status} />
                <span className="kind">{data.trace.kind}</span>
                <h2>{data.trace.operation}</h2>
                <p>
                  {data.trace.serviceName} · {data.trace.instanceId} ·{" "}
                  {new Date(data.trace.startedAt).toLocaleString()} ·{" "}
                  {data.trace.traceId}
                </p>
              </div>
              <strong>
                {ms(data.trace.durationMs)}
                <small>WALL TIME</small>
              </strong>
            </div>
            {(data.trace.detail === "rootOnly" ||
              !data.trace.isComplete ||
              (data.trace.droppedSpanCount ?? 0) > 0 ||
              (data.trace.unfinishedSpanCount ?? 0) > 0) && (
              <p className="notice">
                Partial trace evidence: {data.trace.detail ?? "full"} detail ·{" "}
                {data.trace.droppedSpanCount ?? 0} dropped spans ·{" "}
                {data.trace.unfinishedSpanCount ?? 0} unfinished spans ·
                complete: {String(data.trace.isComplete)}.
              </p>
            )}
            <Waterfall key={data.trace.traceId} detail={data} />
          </>
        )}
      </Result>
    </>
  ) : (
    <Panel title="Recorded executions" meta="SAMPLED TRACE DETAILS">
      <Result result={list} retry={p.retry}>
        {(data) => (
          <>
            <TraceTable items={data.items} open={(id) => p.change({ id })} />
            <Pager {...pagination} nextCursor={data.nextCursor} />
          </>
        )}
      </Result>
    </Panel>
  );
}
function ProfilerPage(p: PageProps) {
  const pagination = usePagination(p.state);
  const list = useData<ProfileSummaryPage>(
    p.client,
    "/profiles",
    { ...queryFor(p.state), cursor: pagination.cursor, limit: "50" },
    p.revision,
  );
  const graph = useData<Flamegraph>(
    p.client,
    p.state.id
      ? `/profiles/${encodeURIComponent(p.state.id)}/flamegraph`
      : "/flamegraph",
    p.state.id
      ? {}
      : {
          ...queryFor(p.state),
          from: new Date(
            Math.max(
              Date.parse(p.state.from),
              Date.parse(p.state.to) - 6 * 3600000,
            ),
          ).toISOString(),
        },
    p.revision,
  );
  return (
    <>
      <p className="note">
        CPU profiles are samples of process activity, independent of trace wall
        time. Aggregated graph covers at most the last 6 hours of the selected
        window; select a retained profile for its exact interval.
      </p>
      {p.state.id && (
        <button
          className="text-link back"
          onClick={() => p.change({ id: undefined })}
        >
          ← Merged CPU profile
        </button>
      )}
      <Result result={graph} retry={p.retry}>
        {(data) => (
          <>
            <div className="profile-meta">
              <div>
                <span>ACTIVE SAMPLES</span>
                <strong>{number(data.sampleCount)}</strong>
              </div>
              <div>
                <span>RETAINED WINDOWS</span>
                <strong>{number(data.profileCount)}</strong>
              </div>
              <div>
                <span>RECORDED SAMPLE RATE</span>
                <strong>
                  {data.sampleRateHz === undefined
                    ? "Mixed / unavailable"
                    : `${number(data.sampleRateHz)} Hz`}
                </strong>
              </div>
              <div>
                <span>PROFILE INTERVAL</span>
                <strong>
                  {time(data.window.from)} — {time(data.window.to)}
                </strong>
              </div>
            </div>
            <FlameView
              key={JSON.stringify([p.state.id, data.window, p.revision])}
              data={data}
            />
          </>
        )}
      </Result>
      <div className="section-title">
        <h2>Retained profile windows</h2>
      </div>
      <Panel title="Continuous sampling periods" meta="SELECT A WINDOW">
        <Result result={list} retry={p.retry}>
          {(data) => (
            <>
              {data.items.length ? (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">PERIOD START</th>
                        <th scope="col">SERVICE / INSTANCE</th>
                        <th scope="col" className="right">
                          ACTIVE SAMPLES
                        </th>
                        <th scope="col" className="right">
                          RATE
                        </th>
                        <th scope="col">PROFILE</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.items.map((profile) => (
                        <tr key={profile.profileId}>
                          <td className="mono">
                            {new Date(profile.periodStart).toLocaleString()}
                          </td>
                          <td>
                            {profile.serviceName}
                            <small>{profile.instanceId}</small>
                          </td>
                          <td className="right mono">
                            {number(profile.sampleCount)}
                          </td>
                          <td className="right mono">
                            {number(profile.sampleRateHz)} Hz
                          </td>
                          <td>
                            <button
                              className="text-link"
                              onClick={() =>
                                p.change({ id: profile.profileId })
                              }
                            >
                              Inspect samples →
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty title="No retained CPU profiles">
                  The profiler may be disabled or unavailable. Collector health
                  shows its recorded state and reason.
                </Empty>
              )}
              <Pager {...pagination} nextCursor={data.nextCursor} />
            </>
          )}
        </Result>
      </Panel>
    </>
  );
}
function ErrorsPage(p: PageProps) {
  const pagination = usePagination(p.state);
  const result = useData<ErrorGroupPage>(
    p.client,
    "/errors",
    { ...queryFor(p.state), cursor: pagination.cursor },
    p.revision,
  );
  return (
    <Panel title="Sanitized exception groups" meta="RETAINED ERROR TRACES">
      <Result result={result} retry={p.retry}>
        {(data) => (
          <>
            {data.truncated && (
              <p className="notice">
                Results are truncated after scanning{" "}
                {number(data.scannedTraces)} traces. Narrow the time window for
                more precise counts.
              </p>
            )}
            {data.items.length ? (
              data.items.map((error) => (
                <article className="error-group" key={error.fingerprint}>
                  <div>
                    <h3>{error.name}</h3>
                    <span className="error-count">{number(error.count)}</span>
                  </div>
                  {error.message && <p>{error.message}</p>}
                  <p className="mono">
                    {error.operation} · {error.serviceName}
                  </p>
                  <footer>
                    <span>
                      Last seen {new Date(error.lastSeenAt).toLocaleString()}
                    </span>
                    <button
                      className="text-link"
                      onClick={() =>
                        p.change({
                          view: "traces",
                          id: error.sampleTraceId,
                          search: undefined,
                          status: undefined,
                        })
                      }
                    >
                      Inspect example trace →
                    </button>
                  </footer>
                </article>
              ))
            ) : (
              <Empty title="No recorded error groups" />
            )}
            <Pager {...pagination} nextCursor={data.nextCursor} />
            <p className="panel-note">
              Counts reflect retained error traces, which can be sampled; they
              are not total application failures. Messages may be omitted by
              production sanitization.
            </p>
          </>
        )}
      </Result>
    </Panel>
  );
}
function HealthPage(p: PageProps) {
  const health = useData<Health>(p.client, "/health", {}, p.revision);
  return (
    <Result result={health} retry={p.retry}>
      {(data) => {
        const filtered = data.items.filter(
          (item) =>
            (!p.state.service ||
              item.heartbeat.serviceName === p.state.service) &&
            (!p.state.instanceId || item.instance === p.state.instanceId),
        );
        return (
          <>
            <div className="notice">
              Serving instance {data.servedBy.instanceId} · Mongo{" "}
              <Status
                value={
                  data.servedBy.mongoConnected ? "connected" : "unavailable"
                }
              />{" "}
              · Schema {data.servedBy.schemaVersion ?? "unknown"}. Configuration
              is read-only.
            </div>
            <Panel title="Process heartbeats" meta="LIVE = LAST 90 SECONDS">
              {filtered.map((item) => (
                <article className="health-item" key={item.instance}>
                  <header>
                    <h3>
                      {item.heartbeat.serviceName}{" "}
                      <small>{item.instance}</small>
                    </h3>
                    <Status value={item.isLive ? "live" : "stale"} />
                  </header>
                  <dl>
                    <dt>Last heartbeat</dt>
                    <dd>
                      {new Date(item.heartbeat.lastSeenAt).toLocaleString()}
                    </dd>
                    <dt>Tracing</dt>
                    <dd>
                      {item.heartbeat.tracing.enabled ? "Enabled" : "Disabled"}{" "}
                      · {number(item.heartbeat.tracing.sampleRate * 100)}%
                      samples
                    </dd>
                    <dt>CPU profiler</dt>
                    <dd>
                      <Status value={item.heartbeat.profiler.state} />{" "}
                      {item.heartbeat.profiler.reason}
                    </dd>
                    <dt>Achieved sample rate</dt>
                    <dd>
                      {item.heartbeat.profiler.achievedSampleRateHz ===
                      undefined
                        ? "Unavailable"
                        : `${number(item.heartbeat.profiler.achievedSampleRateHz)} Hz`}
                    </dd>
                    <dt>Queue depth</dt>
                    <dd>{number(item.heartbeat.buffer.queueDepth)}</dd>
                    <dt>Dropped traces / profiles</dt>
                    <dd>
                      {number(item.heartbeat.buffer.droppedTraces)} /{" "}
                      {number(item.heartbeat.buffer.droppedProfiles)}
                    </dd>
                    <dt>Storage connection</dt>
                    <dd>
                      {item.heartbeat.storage.connected
                        ? "Connected"
                        : "Unavailable"}
                    </dd>
                    <dt>Runtime</dt>
                    <dd>
                      Node {item.heartbeat.versions.node} · Tracelet{" "}
                      {item.heartbeat.versions.tracelet}
                    </dd>
                  </dl>
                </article>
              ))}
              {!filtered.length && (
                <Empty title="No process heartbeats for these filters" />
              )}
            </Panel>
            <p className="note">
              Storage uses expireAt TTL indexes. Deletion is eventual; the
              retention policy is configured by the host and is not reported by
              this API.
            </p>
          </>
        );
      }}
    </Result>
  );
}

export default function App({ client }: { client: ApiClient }) {
  const [state, setState] = useState<DashboardState>(() =>
    readState(location.search),
  );
  const [revision, setRevision] = useState(0);
  const [menu, setMenu] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const initialState = useRef(state);
  useEffect(() => {
    updateUrl(initialState.current, true);
  }, []);
  const change = (patch: Partial<DashboardState>) =>
    setState((old) => {
      const next = { ...old, ...patch };
      if (
        next.view === "errors" &&
        Date.parse(next.to) - Date.parse(next.from) > 86400000
      )
        next.from = new Date(Date.parse(next.to) - 86400000).toISOString();
      if (patch.view && patch.view !== old.view && patch.id === undefined)
        next.id = undefined;
      updateUrl(next);
      return next;
    });
  useEffect(() => {
    const pop = () => setState(readState(location.search));
    const keys = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        change({ view: "traces", id: undefined });
        setTimeout(() => searchRef.current?.focus(), 0);
      }
      if (event.key === "Escape") {
        setMenu(false);
        if (state.id) change({ id: undefined });
      }
    };
    addEventListener("popstate", pop);
    addEventListener("keydown", keys);
    return () => {
      removeEventListener("popstate", pop);
      removeEventListener("keydown", keys);
    };
  }, [state.id]);
  const retry = () => {
    client.invalidate();
    setRevision((x) => x + 1);
  };
  const services = useData<ServiceList>(client, "/services", {}, revision);
  const instances = useData<InstanceList>(
    client,
    "/instances",
    { service: state.service },
    revision,
  );
  const health = useData<Health>(client, "/health", {}, revision);
  const view = views[state.view as View] ?? views.overview;
  const hours = Math.round(
    (Date.parse(state.to) - Date.parse(state.from)) / 3600000,
  );
  const setHours = (n: number) => {
    const to = Date.now();
    change({
      from: new Date(to - n * 3600000).toISOString(),
      to: new Date(to).toISOString(),
      id: undefined,
    });
  };
  const props: PageProps = { client, state, revision, retry, change };
  return (
    <div className="shell">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <aside className="rail" aria-label="Quick navigation">
        <a
          href="?view=overview"
          className="brand"
          onClick={(e) => {
            e.preventDefault();
            change({ view: "overview", id: undefined });
          }}
          aria-label="Tracelet overview"
        >
          t
        </a>
        <button
          aria-label="Dashboard"
          onClick={() => change({ view: "overview" })}
        >
          D
        </button>
        <button
          aria-label="CPU profiler"
          onClick={() => change({ view: "profiler" })}
        >
          P
        </button>
        <button
          aria-label="Collector health"
          onClick={() => change({ view: "health" })}
        >
          H
        </button>
      </aside>
      <aside className={`sidebar ${menu ? "open" : ""}`}>
        <div className="sidebar-title">
          <b>TRACELET</b> / OBSERVE
        </div>
        <nav aria-label="Dashboard pages">
          {Object.entries(views).map(([key, value]) => (
            <button
              key={key}
              className={state.view === key ? "active" : ""}
              aria-current={state.view === key ? "page" : undefined}
              onClick={() => {
                change({
                  view: key as View,
                  id: undefined,
                  search: undefined,
                  status: undefined,
                });
                setMenu(false);
              }}
            >
              {value[0]}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className="live-dot" />{" "}
          {health.data
            ? `${health.data.items.filter((x) => x.isLive).length} live instances`
            : "Awaiting collector state"}
          <p>Shared MongoDB storage</p>
          <div className="local-label">
            <b>Tracelet / Internal</b>
            <small>Embedded diagnostics</small>
          </div>
        </div>
      </aside>
      <main className="workspace" id="main">
        <header className="topbar">
          <button
            className="menu-toggle"
            aria-expanded={menu}
            onClick={() => setMenu(!menu)}
          >
            Pages
          </button>
          <button
            className="global-search"
            onClick={() => {
              change({ view: "traces", id: undefined });
              setTimeout(() => searchRef.current?.focus(), 0);
            }}
          >
            Search executions <kbd>Ctrl K</kbd>
          </button>
          <span className="top-meta">LOCAL COLLECTION · SHARED STORAGE</span>
        </header>
        <div className="page-top">
          <div>
            <h1>{view[0]}</h1>
            <p>{view[1]}</p>
          </div>
          <div className="controls">
            <label>
              <span className="sr-only">Service</span>
              <select
                aria-label="Service"
                value={state.service ?? ""}
                onChange={(e) =>
                  change({
                    service: e.target.value || undefined,
                    instanceId: undefined,
                    id: undefined,
                  })
                }
              >
                <option value="">All services</option>
                {state.service &&
                  !services.data?.items.some(
                    (x) => x.serviceName === state.service,
                  ) && <option value={state.service}>{state.service}</option>}
                {services.data?.items.map((service) => (
                  <option key={service.serviceName}>
                    {service.serviceName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="sr-only">Instance</span>
              <select
                aria-label="Instance"
                value={state.instanceId ?? ""}
                onChange={(e) =>
                  change({
                    instanceId: e.target.value || undefined,
                    id: undefined,
                  })
                }
              >
                <option value="">All instances</option>
                {state.instanceId &&
                  !instances.data?.items.some(
                    (x) => x.instanceId === state.instanceId,
                  ) && (
                    <option value={state.instanceId}>{state.instanceId}</option>
                  )}
                {instances.data?.items.map((instance) => (
                  <option key={instance.instanceId} value={instance.instanceId}>
                    {instance.instanceId}
                    {instance.isLive ? "" : " · stale"}
                  </option>
                ))}
              </select>
            </label>
            <div className="time-group" aria-label="Time range">
              {(state.view === "errors" ? [1, 6, 24] : [1, 6, 24, 72, 168]).map(
                (n) => (
                  <button
                    key={n}
                    aria-pressed={hours === n}
                    onClick={() => setHours(n)}
                  >
                    {n < 24 ? `${n}H` : `${n / 24}D`}
                  </button>
                ),
              )}
            </div>
            <button aria-label="Refresh recorded data" onClick={retry}>
              Refresh
            </button>
          </div>
        </div>
        <div className="window-note">
          <span>
            {new Date(state.from).toLocaleString()} —{" "}
            {new Date(state.to).toLocaleString()}
          </span>
          <span>Fixed window · refresh reloads this interval</span>
        </div>
        {(services.error || instances.error) && (
          <p className="notice" role="status">
            Service or instance choices could not be loaded. Existing URL
            filters remain active.
          </p>
        )}
        {(state.view === "traces" || state.view === "methods") && !state.id && (
          <form
            className="filterbar"
            onSubmit={(e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              change({
                search: String(form.get("search") ?? "").trim() || undefined,
              });
            }}
          >
            <label>
              Search{" "}
              {state.view === "methods"
                ? "methods (literal substring)"
                : "executions (operation prefix or trace ID)"}
              <input
                ref={searchRef}
                name="search"
                key={`${state.view}:${state.search ?? ""}`}
                defaultValue={state.search}
                maxLength={128}
                placeholder="Class.method or trace ID"
              />
            </label>
            {state.view === "traces" && (
              <label>
                Status
                <select
                  aria-label="Execution status"
                  value={state.status ?? ""}
                  onChange={(e) =>
                    change({
                      status: (e.target.value ||
                        undefined) as DashboardState["status"],
                    })
                  }
                >
                  <option value="">Any status</option>
                  <option value="ok">Success</option>
                  <option value="error">Error</option>
                  <option value="incomplete">Incomplete</option>
                </select>
              </label>
            )}
            <button type="submit">Apply search</button>
            {state.search && (
              <button
                type="button"
                onClick={() => change({ search: undefined })}
              >
                Clear
              </button>
            )}
          </form>
        )}
        {state.view === "overview" && <OverviewPage {...props} />}
        {state.view === "methods" && <MethodsPage {...props} />}
        {state.view === "traces" && <TracesPage {...props} />}
        {state.view === "profiler" && <ProfilerPage {...props} />}
        {state.view === "errors" && <ErrorsPage {...props} />}
        {state.view === "health" && <HealthPage {...props} />}
        <footer className="app-footer">
          Tracelet · Internal diagnostics · Real persisted telemetry only
        </footer>
      </main>
    </div>
  );
}
