"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { requeueDeadLetterAction } from "@/app/dashboard/actions";
import { Button } from "@/components/ui/button";

/**
 * Requeues a Control Plane dead-letter task via a server action.
 *
 * @param props - Dead-letter task id.
 * @returns Button with inline operator feedback.
 */
export function RequeueButton(props: { taskId: string }) {
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  return (
    <div className="flex flex-col gap-2">
      <Button
        className="h-9 rounded-xl"
        disabled={isPending}
        onClick={() => {
          startTransition(async () => {
            const result = await requeueDeadLetterAction(props.taskId);
            setMessage(result.message);
            toast[result.ok ? "success" : "error"](result.message);
          });
        }}
        type="button"
        variant="outline"
      >
        {isPending ? "Requeueing" : "Requeue Task"}
      </Button>
      {message ? <p className="max-w-56 text-xs text-muted-foreground">{message}</p> : null}
    </div>
  );
}
