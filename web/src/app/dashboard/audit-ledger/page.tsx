import { HashChip } from "@/components/dashboard/hash-chip";
import { ConfigRequiredPanel, EmptyState } from "@/components/dashboard/state-panels";
import { Button } from "@/components/ui/button";
import { getControlPlaneSnapshot } from "@/lib/api-client";

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "medium" }).format(new Date(value));
}

export default async function AuditLedgerPage() {
  const snapshot = await getControlPlaneSnapshot();

  return (
    <section>
      <div className="mb-8 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.28em] text-foreground">WORM Explorer</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight">Audit ledger</h1>
          <p className="mt-3 max-w-2xl text-muted-foreground">
            Terminal-style inspection of append-only worker events. This page renders hashes and event metadata, never PII.
          </p>
        </div>
        <Button asChild variant="outline">
          <a href="/dashboard/audit-ledger/export">Download NDJSON</a>
        </Button>
      </div>

      {!snapshot.state.configured ? <div className="mb-6"><ConfigRequiredPanel reason={snapshot.state.reason} /></div> : null}

      <div className="rounded-xl border bg-card p-4 text-sm shadow-sm">
        <div className="mb-4 flex gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/40" />
          <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/30" />
          <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/20" />
        </div>
        <div className="space-y-4 font-mono">
          {snapshot.auditLedger.map((row) => (
            <article className="rounded-lg border bg-background p-4" key={row.id}>
              <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                <p className="text-foreground">#{row.ledger_seq} :: {row.event_type}</p>
                <p className="text-xs text-muted-foreground">{formatDate(row.created_at)}</p>
              </div>
              <div className="mt-4 grid gap-3 lg:grid-cols-2">
                <div>
                  <p className="mb-2 text-xs uppercase tracking-[0.18em] text-muted-foreground">Previous hash</p>
                  <HashChip value={row.previous_hash} visible={12} />
                </div>
                <div>
                  <p className="mb-2 text-xs uppercase tracking-[0.18em] text-muted-foreground">Current hash</p>
                  <HashChip value={row.current_hash} visible={12} />
                </div>
              </div>
            </article>
          ))}
        </div>
        {snapshot.auditLedger.length === 0 ? <div className="p-5"><EmptyState title="No WORM events" description="The audit export returned no ledger rows. No synthetic hashes are displayed." /></div> : null}
      </div>
    </section>
  );
}
