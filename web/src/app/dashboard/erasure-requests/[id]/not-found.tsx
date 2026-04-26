import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function ErasureRequestNotFound() {
  return (
    <section className="rounded-xl border bg-card p-8">
      <p className="font-mono text-xs uppercase tracking-[0.22em] text-muted-foreground">Request not found</p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight">No lifecycle aggregate exists for this request.</h1>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
        The request may not exist, or the web BFF may not be configured to reach the Control Plane.
      </p>
      <Button asChild className="mt-6" variant="outline">
        <Link href="/dashboard/erasure-requests">Back to requests</Link>
      </Button>
    </section>
  );
}
