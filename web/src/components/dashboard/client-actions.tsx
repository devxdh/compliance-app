"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { deactivateWorkerClientAction } from "@/app/dashboard/actions";
import { Button } from "@/components/ui/button";

/**
 * Operator action for disabling a worker client without deleting its history.
 *
 * @param props - Stable client name.
 * @returns Client-side action button with server-action feedback.
 */
export function DeactivateClientButton(props: { clientName: string }) {
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  return (
    <div className="flex flex-col gap-2">
      <Button
        disabled={isPending}
        onClick={() => {
          startTransition(async () => {
            const result = await deactivateWorkerClientAction(props.clientName);
            setMessage(result.message);
            toast[result.ok ? "success" : "error"](result.message);
          });
        }}
        type="button"
        variant="outline"
      >
        {isPending ? "Deactivating" : "Deactivate"}
      </Button>
      {message ? <p className="max-w-72 text-xs text-muted-foreground">{message}</p> : null}
    </div>
  );
}
