"use client";

import { Button } from "@/components/ui/button";

export default function DashboardError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <section className="rounded-xl border bg-card p-8">
      <p className="font-mono text-xs uppercase tracking-[0.22em] text-muted-foreground">Dashboard error</p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight">The dashboard could not render safely.</h1>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">{props.error.message}</p>
      {props.error.digest ? <p className="mt-3 font-mono text-xs text-muted-foreground">Digest: {props.error.digest}</p> : null}
      <Button className="mt-6" onClick={props.reset} type="button">
        Retry
      </Button>
    </section>
  );
}
