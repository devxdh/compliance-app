import { Skeleton } from "@/components/ui/skeleton";

/**
 * Dashboard loading shell used by App Router `loading.tsx` boundaries.
 *
 * @returns Layout-preserving skeleton blocks.
 */
export function DashboardSkeleton() {
  return (
    <section>
      <div className="mb-8 space-y-3">
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-10 w-80" />
        <Skeleton className="h-5 w-full max-w-2xl" />
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
      </div>
      <div className="mt-6 grid gap-4 lg:grid-cols-[1.15fr_0.85fr]">
        <Skeleton className="h-72" />
        <Skeleton className="h-72" />
      </div>
    </section>
  );
}
