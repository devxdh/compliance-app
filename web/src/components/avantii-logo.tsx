import { ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Avantii wordmark with a shield glyph for compliance positioning.
 *
 * @param props - Optional className for layout-specific sizing.
 * @returns SVG/icon-backed brand mark.
 */
export function AvantiiLogo({ className }: Readonly<{ className?: string }>) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <div className="flex size-9 items-center justify-center rounded-md border bg-background">
        <ShieldCheck className="size-4 text-foreground" aria-hidden="true" />
      </div>
      <div>
        <p className="text-lg font-semibold tracking-tight">Avantii</p>
        <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">Zero-PII Control</p>
      </div>
    </div>
  );
}
