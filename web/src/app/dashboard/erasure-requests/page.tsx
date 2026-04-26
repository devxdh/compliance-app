import Link from "next/link";
import { HashChip } from "@/components/dashboard/hash-chip";
import { ConfigRequiredPanel, EmptyState } from "@/components/dashboard/state-panels";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { Button } from "@/components/ui/button";
import { getControlPlaneSnapshot } from "@/lib/api-client";

function formatDate(value: string | null): string {
  return value ? new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "Not set";
}

export default async function ErasureRequestsPage() {
  const snapshot = await getControlPlaneSnapshot();

  return (
    <section>
      <div className="mb-8 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.28em] text-foreground">Lifecycle Queue</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight">Erasure requests</h1>
          <p className="mt-3 max-w-2xl text-muted-foreground">
            Opaque subject identifiers only. The Control Plane owns the calendar; the worker owns local mutation.
          </p>
        </div>
        <p className="rounded-full border bg-card px-4 py-2 font-mono text-xs text-muted-foreground">
          Showing {snapshot.erasureRequests.length} latest rows
        </p>
      </div>

      {!snapshot.state.configured ? <div className="mb-6"><ConfigRequiredPanel reason={snapshot.state.reason} /></div> : null}

      <div className="overflow-hidden rounded-xl border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-left text-sm">
            <thead className="border-b bg-muted/50 text-xs uppercase tracking-[0.18em] text-muted-foreground">
              <tr>
                <th className="px-5 py-4">Subject</th>
                <th className="px-5 py-4">Status</th>
                <th className="px-5 py-4">Framework</th>
                <th className="px-5 py-4">Applied rule</th>
                <th className="px-5 py-4">Vault due</th>
                <th className="px-5 py-4">Shred due</th>
                <th className="px-5 py-4 text-right">Detail</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.erasureRequests.map((job) => (
                <tr className="border-b last:border-0" key={job.id}>
                  <td className="px-5 py-4">
                    <HashChip value={job.subject_opaque_id} />
                  </td>
                  <td className="px-5 py-4">
                    <StatusBadge status={job.status} />
                  </td>
                  <td className="px-5 py-4 font-mono text-xs text-muted-foreground">{job.legal_framework}</td>
                  <td className="px-5 py-4 text-muted-foreground">{job.applied_rule_name ?? "Pending evidence"}</td>
                  <td className="px-5 py-4 text-muted-foreground">{formatDate(job.vault_due_at)}</td>
                  <td className="px-5 py-4 text-muted-foreground">{formatDate(job.shred_due_at)}</td>
                  <td className="px-5 py-4 text-right">
                    <Button asChild className="h-9 rounded-xl" variant="outline">
                      <Link href={`/dashboard/erasure-requests/${job.id}`}>Open</Link>
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {snapshot.erasureRequests.length === 0 ? <div className="p-5"><EmptyState title="No erasure requests" description="No lifecycle aggregates were returned by the Control Plane. The ingestion API remains the source of truth." /></div> : null}
      </div>
    </section>
  );
}
