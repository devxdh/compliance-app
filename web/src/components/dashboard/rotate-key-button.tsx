"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { rotateWorkerKeyAction } from "@/app/dashboard/actions";
import { Button } from "@/components/ui/button";
import { HashChip } from "@/components/dashboard/hash-chip";

/**
 * Rotates a worker API key and displays the one-time replacement token.
 *
 * @param props - Stable worker client name.
 * @returns Operator action with explicit one-time-token handling.
 */
export function RotateKeyButton(props: { clientName: string }) {
  const [message, setMessage] = useState<string | null>(null);
  const [bearerToken, setBearerToken] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  return (
    <div className="flex flex-col gap-2">
      <Button
        className="h-9 rounded-xl"
        disabled={isPending}
        onClick={() => {
          startTransition(async () => {
            const result = await rotateWorkerKeyAction(props.clientName);
            setMessage(result.message);
            setBearerToken(result.bearerToken ?? null);
            toast[result.ok ? "success" : "error"](result.message);
          });
        }}
        type="button"
        variant="outline"
      >
        {isPending ? "Rotating" : "Rotate API Key"}
      </Button>
      {message ? <p className="max-w-72 text-xs text-muted-foreground">{message}</p> : null}
      {bearerToken ? <HashChip value={bearerToken} visible={12} /> : null}
    </div>
  );
}
