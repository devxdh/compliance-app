import { HashChip } from "@/components/dashboard/hash-chip";
import { RequeueButton } from "@/components/dashboard/requeue-button";
import { ConfigRequiredPanel, EmptyState } from "@/components/dashboard/state-panels";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { getControlPlaneSnapshot } from "@/lib/api-client";

function formatDate(value: string | null): string {
  return value ? new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "Not set";
}

export default async function DeadLettersPage() {
  const snapshot = await getControlPlaneSnapshot();

  return (
    <section>
      <div className="mb-8">
        <p className="font-mono text-xs uppercase tracking-[0.28em] text-foreground">Recovery Queue</p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight">Dead letters</h1>
        <p className="mt-3 max-w-2xl text-muted-foreground">
          Failed tasks stay explicit and operator-controlled. Requeue actions run through server actions with admin-token isolation.
        </p>
      </div>

      {!snapshot.state.configured ? <div className="mb-6"><ConfigRequiredPanel reason={snapshot.state.reason} /></div> : null}

      <div className="grid gap-4">
        {snapshot.deadLetters.map((task) => (
          <article className="rounded-xl border bg-card p-6" key={task.id}>
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <div className="flex flex-wrap items-center gap-3">
                  <StatusBadge status={task.status} />
                  <p className="font-mono text-sm text-muted-foreground">{task.task_type}</p>
                  <HashChip value={task.id} visible={8} />
                </div>
                <p className="mt-4 text-sm text-muted-foreground">
                  Attempts: {task.attempt_count} | Next attempt: {formatDate(task.next_attempt_at)}
                </p>
              </div>
              <RequeueButton taskId={task.id} />
            </div>

            <div className="mt-5 grid gap-4 lg:grid-cols-2">
              <pre className="max-h-72 overflow-auto rounded-lg border bg-muted/50 p-4 font-mono text-xs text-muted-foreground">
                {JSON.stringify(task.payload, null, 2)}
              </pre>
              <pre className="max-h-72 overflow-auto rounded-lg border border-border bg-muted/50 p-4 font-mono text-xs text-foreground">
                {task.error_text ?? "No error payload recorded."}
              </pre>
            </div>
          </article>
        ))}
      </div>
      {snapshot.deadLetters.length === 0 ? (
        <EmptyState title="No dead letters" description="No failed tasks require operator recovery." />
      ) : null}
    </section>
  );
}
