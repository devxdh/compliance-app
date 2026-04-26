import { cn } from "@/lib/utils";

/**
 * Neutral shadcn-style loading placeholder.
 *
 * @param props - Optional className used to match the loaded layout.
 * @returns Animated placeholder block.
 */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("animate-pulse rounded-md bg-muted", className)} {...props} />;
}
