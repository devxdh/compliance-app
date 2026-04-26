/**
 * Minimal placeholder for future dashboard phases.
 *
 * @param props - Copy that explains which phase owns the page.
 * @returns A build-safe route placeholder that avoids pretending Phase 4 is complete.
 */
export function PhasePlaceholder({
  eyebrow,
  title,
  description,
}: Readonly<{
  eyebrow: string;
  title: string;
  description: string;
}>) {
  return (
    <section className="rounded-xl border bg-card p-8 backdrop-blur">
      <p className="font-mono text-xs uppercase tracking-[0.28em] text-primary">{eyebrow}</p>
      <h1 className="mt-3 text-4xl font-black tracking-tighter">{title}</h1>
      <p className="mt-4 max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p>
    </section>
  );
}
