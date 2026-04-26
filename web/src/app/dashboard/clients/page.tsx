import { DeactivateClientButton } from "@/components/dashboard/client-actions";
import { CreateClientForm } from "@/components/dashboard/create-client-form";
import { HashChip } from "@/components/dashboard/hash-chip";
import { RotateKeyButton } from "@/components/dashboard/rotate-key-button";
import { ConfigRequiredPanel, EmptyState } from "@/components/dashboard/state-panels";
import { getControlPlaneSnapshot } from "@/lib/api-client";

function formatDate(value: string | null): string {
  return value ? new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "Never";
}

export default async function ClientsPage() {
  const snapshot = await getControlPlaneSnapshot();

  return (
    <section>
      <div className="mb-8">
        <p className="font-mono text-xs uppercase tracking-[0.22em] text-muted-foreground">SaaS Tenancy</p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight">Client management</h1>
        <p className="mt-3 max-w-2xl text-muted-foreground">
          Register worker clients, issue one-time sidecar tokens, rotate credentials, and disable access without deleting
          immutable audit history.
        </p>
      </div>

      {!snapshot.state.configured ? <div className="mb-6"><ConfigRequiredPanel reason={snapshot.state.reason} /></div> : null}

      <div className="grid gap-4 lg:grid-cols-[0.8fr_1.2fr]">
        <CreateClientForm />

        <div className="rounded-xl border bg-card">
          <div className="border-b p-5">
            <h2 className="text-lg font-semibold tracking-tight">Registered clients</h2>
            <p className="mt-1 text-sm text-muted-foreground">{snapshot.clients.length} clients known to the Control Plane.</p>
          </div>
          <div className="divide-y">
            {snapshot.clients.map((client) => (
              <article className="p-5" key={client.id}>
                <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
                  <div>
                    <div className="flex flex-wrap items-center gap-3">
                      <h3 className="font-semibold">{client.display_name ?? client.name}</h3>
                      <span className="rounded-md border bg-muted px-2 py-1 font-mono text-[11px] text-muted-foreground">
                        {client.is_active ? "ACTIVE" : "DISABLED"}
                      </span>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2 text-sm text-muted-foreground">
                      <HashChip value={client.id} visible={8} />
                      <HashChip value={client.current_key_id} visible={8} />
                      <span>Last auth: {formatDate(client.last_authenticated_at)}</span>
                    </div>
                  </div>
                  <div className="flex flex-col gap-3 sm:flex-row">
                    <RotateKeyButton clientName={client.name} />
                    {client.is_active ? <DeactivateClientButton clientName={client.name} /> : null}
                  </div>
                </div>
              </article>
            ))}
          </div>
          {snapshot.clients.length === 0 ? <div className="p-5"><EmptyState title="No clients registered" description="Create a worker client after configuring the BFF admin token. Client records come only from the Control Plane API." /></div> : null}
        </div>
      </div>
    </section>
  );
}
