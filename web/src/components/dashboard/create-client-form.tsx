"use client";

import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { createWorkerClientAction } from "@/app/dashboard/actions";
import { HashChip } from "@/components/dashboard/hash-chip";

/**
 * Creates worker clients and displays the one-time bearer token in-place.
 *
 * @returns Accessible client creation form with server-action feedback.
 */
export function CreateClientForm() {
  const formRef = useRef<HTMLFormElement>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [bearerToken, setBearerToken] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  return (
    <form
      className="rounded-xl border bg-card p-6"
      onSubmit={(event) => {
        event.preventDefault();
        const form = formRef.current;
        if (!form) {
          return;
        }

        startTransition(async () => {
          const result = await createWorkerClientAction(new FormData(form));
          setMessage(result.message);
          setBearerToken(result.bearerToken ?? null);
          toast[result.ok ? "success" : "error"](result.message);
          if (result.ok) {
            form.reset();
          }
        });
      }}
      ref={formRef}
    >
      <h2 className="text-lg font-semibold tracking-tight">Create worker client</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        The raw bearer token is shown once after creation. Store it in the client VPC secret manager.
      </p>
      <div className="mt-6 space-y-4">
        <label className="block text-sm">
          <span className="font-medium">Client name</span>
          <input
            className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm outline-none ring-offset-background transition focus-visible:ring-1 focus-visible:ring-ring"
            name="name"
            placeholder="tenant-bank-prod"
            required
          />
        </label>
        <label className="block text-sm">
          <span className="font-medium">Display name</span>
          <input
            className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm outline-none ring-offset-background transition focus-visible:ring-1 focus-visible:ring-ring"
            name="display_name"
            placeholder="Tenant Bank Production"
          />
        </label>
        <button
          className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
          disabled={isPending}
          type="submit"
        >
          {isPending ? "Creating" : "Create Client"}
        </button>
      </div>
      {message ? <p className="mt-4 text-sm text-muted-foreground">{message}</p> : null}
      {bearerToken ? (
        <div className="mt-4 rounded-lg border bg-muted p-3">
          <p className="mb-2 font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">One-time token</p>
          <HashChip value={bearerToken} visible={14} />
        </div>
      ) : null}
    </form>
  );
}
