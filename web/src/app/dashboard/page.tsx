import { getControlPlaneSnapshot } from "@/lib/api-client";
import { OverviewChart } from "@/components/dashboard/overview-chart";
import { ConfigRequiredPanel } from "@/components/dashboard/state-panels";

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en", { maximumFractionDigits: 0 }).format(value);
}

export default async function DashboardPage() {
  const snapshot = await getControlPlaneSnapshot();
  const requestsProcessed = snapshot.usage.reduce((sum, row) => sum + row.total_units, 0);
  const activeWorkers = snapshot.clients.filter((client) => client.is_active).length;
  const latestLedgerRow = snapshot.auditLedger.at(-1);
  const cards = [
    { label: "Requests processed", value: formatNumber(requestsProcessed), tone: "text-foreground" },
    { label: "Dead letters", value: formatNumber(snapshot.deadLetters.length), tone: "text-foreground" },
    { label: "Active workers", value: formatNumber(activeWorkers), tone: "text-muted-foreground" },
  ] as const;

  return (
    <section>
      <div className="mb-8">
        <p className="font-mono text-xs uppercase tracking-[0.28em] text-foreground">Control Plane</p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight">Operational overview</h1>
        <p className="mt-3 max-w-2xl text-muted-foreground">
          Server-rendered telemetry from the Control Plane. Admin tokens stay inside the BFF and never reach the browser.
        </p>
      </div>

      {!snapshot.state.configured ? (
        <div className="mb-6">
          <ConfigRequiredPanel reason={snapshot.state.reason} />
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-3">
        {cards.map((card) => (
          <article className="rounded-xl border bg-card p-6" key={card.label}>
            <p className="text-sm text-muted-foreground">{card.label}</p>
            <p className={`mt-4 font-mono text-4xl font-semibold ${card.tone}`}>{card.value}</p>
          </article>
        ))}
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-[1.15fr_0.85fr]">
        <div>
          <p className="mb-3 font-mono text-xs uppercase tracking-[0.24em] text-muted-foreground">Usage by event type</p>
          <OverviewChart usage={snapshot.usage} />
        </div>
        <div className="rounded-xl border bg-card p-6">
          <p className="font-mono text-xs uppercase tracking-[0.24em] text-muted-foreground">Zero-PII assertion</p>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            This dashboard renders opaque subject identifiers, hashes, task IDs, and legal metadata only. Real emails,
            names, KYC object keys, and raw PII are intentionally out of scope.
          </p>
        </div>
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-[1.15fr_0.85fr]">
        <div className="rounded-xl border bg-card p-6">
          <p className="font-mono text-xs uppercase tracking-[0.24em] text-muted-foreground">Recent erasure request</p>
          <p className="mt-3 font-mono text-sm text-foreground">
            {snapshot.erasureRequests[0]?.subject_opaque_id ?? "No requests available"}
          </p>
          <p className="mt-2 text-sm text-muted-foreground">{snapshot.erasureRequests[0]?.status ?? "Awaiting ingestion"}</p>
        </div>
        <div className="rounded-xl border bg-card p-6">
          <p className="font-mono text-xs uppercase tracking-[0.24em] text-muted-foreground">Latest WORM hash</p>
          <p className="mt-3 break-all font-mono text-sm text-foreground">
            {latestLedgerRow?.current_hash ?? "No ledger entries available"}
          </p>
        </div>
      </div>
    </section>
  );
}
