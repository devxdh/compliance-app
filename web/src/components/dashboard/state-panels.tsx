import Link from "next/link";
import { Button } from "@/components/ui/button";

/**
 * Explains why live Control Plane data is unavailable.
 *
 * @param props - Human-readable configuration or request failure reason.
 * @returns Operator-facing fail-closed state panel.
 */
export function ConfigRequiredPanel(props: { reason?: string }) {
  return (
    <div className="rounded-xl border bg-card p-6">
      <p className="font-mono text-xs uppercase tracking-[0.22em] text-muted-foreground">Configuration required</p>
      <h2 className="mt-3 text-2xl font-semibold tracking-tight">Live Control Plane data is unavailable.</h2>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
        {props.reason ?? "Configure ADMIN_API_TOKEN and AVANTII_API_BASE_URL for the web BFF."}
      </p>
      <div className="mt-5">
        <Button asChild variant="outline">
          <Link href="/dashboard/clients">Open client management</Link>
        </Button>
      </div>
    </div>
  );
}

/**
 * Reusable empty state for real API responses that contain no rows.
 *
 * @param props - Empty-state title and explanation.
 * @returns Minimal empty-state panel.
 */
export function EmptyState(props: { title: string; description: string }) {
  return (
    <div className="rounded-xl border bg-card p-8 text-center">
      <h2 className="text-lg font-semibold tracking-tight">{props.title}</h2>
      <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-muted-foreground">{props.description}</p>
    </div>
  );
}
