import { StrictMode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ApiClient, loadRuntimeConfig } from "./api";
import "./styles.css";
function Dashboard({ apiBase }: { apiBase: string }) {
  const [skipped, setSkipped] = useState(0);
  const client = useMemo(
    () =>
      new ApiClient({
        apiBase,
        onSkipped: (count) => setSkipped((old) => Math.max(old, count)),
      }),
    [apiBase],
  );
  return (
    <>
      {skipped > 0 && (
        <div className="schema-warning" role="status">
          A recent query skipped {skipped} or more records from a newer
          telemetry schema. This dashboard may show incomplete results.
        </div>
      )}
      <App client={client} />
    </>
  );
}
const root = createRoot(document.getElementById("root")!);
try {
  const config = loadRuntimeConfig();
  root.render(
    <StrictMode>
      <Dashboard apiBase={config.apiBase} />
    </StrictMode>,
  );
} catch {
  root.render(
    <main className="startup-error" role="alert">
      <h1>Dashboard configuration unavailable</h1>
      <p>
        The host must provide the Tracelet runtime configuration before this
        dashboard can request telemetry.
      </p>
    </main>,
  );
}
