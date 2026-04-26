import type { ErasureRequestStatus } from "@/lib/api-schemas";

const statusTone: Record<ErasureRequestStatus | "DEAD_LETTER" | "QUEUED" | "DISPATCHED" | "COMPLETED" | "FAILED", string> = {
  WAITING_COOLDOWN: "border-border bg-muted text-muted-foreground",
  EXECUTING: "border-foreground/20 bg-foreground/5 text-foreground",
  VAULTED: "border-foreground/20 bg-foreground/5 text-foreground",
  NOTICE_SENT: "border-foreground/20 bg-foreground/5 text-foreground",
  SHREDDED: "border-foreground bg-foreground text-background",
  FAILED: "border-foreground bg-foreground text-background",
  CANCELLED: "border-border bg-background text-muted-foreground",
  DEAD_LETTER: "border-foreground bg-foreground text-background",
  QUEUED: "border-border bg-muted text-muted-foreground",
  DISPATCHED: "border-foreground/20 bg-foreground/5 text-foreground",
  COMPLETED: "border-foreground/20 bg-foreground/5 text-foreground",
};

/**
 * Renders lifecycle and task statuses with consistent operational severity colors.
 *
 * @param props - Status label to render.
 * @returns A compact badge suitable for dense tables.
 */
export function StatusBadge(props: { status: keyof typeof statusTone }) {
  return (
    <span className={`inline-flex rounded-md border px-2 py-1 font-mono text-[11px] font-medium ${statusTone[props.status]}`}>
      {props.status}
    </span>
  );
}
