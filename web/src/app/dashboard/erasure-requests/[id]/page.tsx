import Link from "next/link";
import { notFound } from "next/navigation";
import { HashChip } from "@/components/dashboard/hash-chip";
import { ConfigRequiredPanel } from "@/components/dashboard/state-panels";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { Button } from "@/components/ui/button";
import { getCertificateDownloadUrl, getErasureRequest, isControlPlaneConfigured } from "@/lib/api-client";

interface PageProps {
  params: Promise<{ id: string }>;
}

function formatDate(value: string | null): string {
  return value ? new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "long" }).format(new Date(value)) : "Not set";
}

export default async function ErasureRequestDetailPage(props: PageProps) {
  const { id } = await props.params;

  if (!isControlPlaneConfigured()) {
    return (
      <section>
        <ConfigRequiredPanel reason="ADMIN_API_TOKEN is missing. Configure the BFF before opening lifecycle detail pages." />
      </section>
    );
  }

  const job = await getErasureRequest(id).catch(() => null);

  if (!job) {
    notFound();
  }

  const timeline = [
    { label: "Ingested", at: job.created_at, active: true },
    { label: "Vault due", at: job.vault_due_at, active: ["EXECUTING", "VAULTED", "NOTICE_SENT", "SHREDDED"].includes(job.status) },
    { label: "Notice due", at: job.notification_due_at, active: ["NOTICE_SENT", "SHREDDED"].includes(job.status) },
    { label: "Shred due", at: job.shred_due_at, active: job.status === "SHREDDED" },
    { label: "Shredded", at: job.shredded_at, active: job.status === "SHREDDED" },
  ];

  return (
    <section>
      <div className="mb-8 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.28em] text-foreground">Request Detail</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight">Lifecycle evidence</h1>
          <p className="mt-3 max-w-2xl text-muted-foreground">
            A single zero-PII state-machine aggregate with legal retention metadata and certificate access.
          </p>
        </div>
        <Button asChild className="rounded-xl">
          <Link href={getCertificateDownloadUrl(job.id)}>Download Signed Certificate</Link>
        </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[0.8fr_1.2fr]">
        <div className="rounded-xl border bg-card p-6">
          <p className="text-sm text-muted-foreground">Current status</p>
          <div className="mt-4">
            <StatusBadge status={job.status} />
          </div>
          <dl className="mt-6 space-y-4 text-sm">
            <div>
              <dt className="text-muted-foreground">Subject opaque ID</dt>
              <dd className="mt-2">
                <HashChip value={job.subject_opaque_id} />
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Request ID</dt>
              <dd className="mt-2">
                <HashChip value={job.id} visible={8} />
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Legal framework</dt>
              <dd className="mt-1 font-mono text-foreground">{job.legal_framework}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Applied rule</dt>
              <dd className="mt-1">{job.applied_rule_name ?? "Pending worker evidence evaluation"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Citation</dt>
              <dd className="mt-1 text-muted-foreground">{job.applied_rule_citation ?? "Pending rule citation"}</dd>
            </div>
          </dl>
        </div>

        <div className="rounded-xl border bg-card p-6">
          <p className="font-mono text-xs uppercase tracking-[0.24em] text-muted-foreground">Timeline</p>
          <div className="mt-6 space-y-4">
            {timeline.map((item) => (
              <div className="grid grid-cols-[1rem_1fr] gap-4" key={item.label}>
                <div className={`mt-1 h-3 w-3 rounded-full ${item.active ? "bg-foreground" : "bg-muted"}`} />
                <div>
                  <p className="font-semibold">{item.label}</p>
                  <p className="mt-1 font-mono text-xs text-muted-foreground">{formatDate(item.at)}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-4 rounded-xl border bg-card p-6">
        <p className="font-mono text-xs uppercase tracking-[0.24em] text-muted-foreground">S3 blob purge summary</p>
        <p className="mt-3 text-sm text-muted-foreground">
          No blob receipt is attached to this dashboard contract yet. When worker S3 receipts are present in terminal
          payloads, this section should render object version counts and provider deletion receipts only.
        </p>
      </div>
    </section>
  );
}
