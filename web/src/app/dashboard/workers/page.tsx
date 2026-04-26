import { HashChip } from "@/components/dashboard/hash-chip";
import { RotateKeyButton } from "@/components/dashboard/rotate-key-button";
import { getControlPlaneSnapshot } from "@/lib/api-client";

function progressPercent(count: number, required: number): number {
  if (required <= 0) {
    return 100;
  }
  return Math.min(100, Math.round((count / required) * 100));
}

function formatDate(value: string | null): string {
  return value ? new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "Never";
}

export default async function WorkersPage() {
  const snapshot = await getControlPlaneSnapshot();

  return (
    <section>
      <div className="mb-8">
        <p className="font-mono text-xs uppercase tracking-[0.28em] text-foreground">Sidecar Fleet</p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight">Worker sidecars</h1>
        <p className="mt-3 max-w-2xl text-muted-foreground">
          Manage worker authorization state and shadow-mode burn-in before live mutation is allowed.
        </p>
      </div>

      <div className="grid gap-4">
        {snapshot.clients.map((client) => {
          const pct = progressPercent(client.shadow_success_count, client.shadow_required_successes);
          return (
            <article className="rounded-xl border bg-card p-6" key={client.id}>
              <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-3">
                    <h2 className="text-2xl font-semibold tracking-tight">{client.display_name ?? client.name}</h2>
                    <span className={`rounded-full border px-3 py-1 font-mono text-xs ${client.is_active ? "border-border bg-muted text-foreground" : "border-border bg-muted text-foreground"}`}>
                      {client.is_active ? "ACTIVE" : "DISABLED"}
                    </span>
                    <span className={`rounded-full border px-3 py-1 font-mono text-xs ${client.live_mutation_enabled ? "border-border bg-muted text-foreground" : "border-border bg-muted text-muted-foreground"}`}>
                      {client.live_mutation_enabled ? "LIVE MUTATION ENABLED" : "SHADOW BURN-IN"}
                    </span>
                  </div>
                  <div className="mt-4 flex flex-wrap gap-3 text-sm text-muted-foreground">
                    <HashChip value={client.id} visible={8} />
                    <HashChip value={client.current_key_id} visible={8} />
                    <span>Last auth: {formatDate(client.last_authenticated_at)}</span>
                  </div>
                </div>
                <RotateKeyButton clientName={client.name} />
              </div>

              <div className="mt-6">
                <div className="mb-2 flex items-center justify-between font-mono text-xs text-muted-foreground">
                  <span>Shadow-mode successes</span>
                  <span>{client.shadow_success_count} / {client.shadow_required_successes}</span>
                </div>
                <div className="h-3 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
                </div>
              </div>
            </article>
          );
        })}
      </div>
      {snapshot.clients.length === 0 ? (
        <div className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">No worker clients registered.</div>
      ) : null}
    </section>
  );
}
