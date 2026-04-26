import Link from "next/link";
import { ArrowRight, DatabaseZap, FileCheck2, Fingerprint, LockKeyhole, ShieldCheck, Terminal } from "lucide-react";
import { AvantiiLogo } from "@/components/avantii-logo";
import { ModeToggle } from "@/components/mode-toggle";
import { Button } from "@/components/ui/button";

const assuranceCards = [
  {
    title: "Pseudonymization",
    description: "Deterministic HMAC tokens preserve joins without rendering real identifiers.",
    icon: Fingerprint,
    metric: "Opaque IDs only",
  },
  {
    title: "Envelope Encryption",
    description: "Retained PII is sealed locally; the Control Plane never receives decryptable personal data.",
    icon: LockKeyhole,
    metric: "AES-256-GCM",
  },
  {
    title: "WORM Ledger",
    description: "Hash-chained worker events produce a defensible certificate trail for auditors.",
    icon: FileCheck2,
    metric: "Signed CoE",
  },
] as const;

const terminalRows = [
  ["01", "BEGIN REPEATABLE READ"],
  ["02", "LOCK root subject row"],
  ["03", "VAULT + PSEUDONYMIZE"],
  ["04", "APPEND WORM OUTBOX"],
] as const;

export default function HomePage() {
  return (
    <main className="min-h-screen bg-background px-6 py-6 text-foreground">
      <nav className="mx-auto flex max-w-6xl items-center justify-between border-b pb-5">
        <AvantiiLogo />
        <div className="flex items-center gap-2">
          <ModeToggle />
          <Button asChild variant="outline">
            <Link href="/dashboard">Dashboard</Link>
          </Button>
        </div>
      </nav>

      <section className="mx-auto grid max-w-6xl items-center gap-12 py-20 lg:grid-cols-[1.05fr_0.95fr] lg:py-28">
        <div>
          <div className="mb-6 inline-flex items-center gap-2 rounded-md border bg-card px-3 py-1.5 font-mono text-xs text-muted-foreground">
            <span className="size-1.5 rounded-full bg-foreground compliance-pulse" />
            SYSTEM STATUS: COMPLIANT
          </div>

          <h1 className="max-w-4xl text-5xl font-semibold tracking-tight sm:text-7xl">
            Zero-Trust Compliance Engineered for DPDP.
          </h1>

          <p className="mt-6 max-w-2xl text-base leading-7 text-muted-foreground sm:text-lg">
            Avantii is a minimal control surface for a two-plane erasure engine. The API schedules and certifies legal state.
            The worker mutates PII inside the client VPC.
          </p>

          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Button asChild>
              <Link href="/dashboard">
                Inspect Control Plane
                <ArrowRight className="size-4" aria-hidden="true" />
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="#proof">View execution flow</Link>
            </Button>
          </div>

          <div className="mt-10 grid max-w-xl grid-cols-3 gap-3">
            {[
              ["0", "raw PII egress"],
              ["5s", "lock timeout"],
              ["100", "shadow runs"],
            ].map(([value, label]) => (
              <div className="rounded-lg border bg-card p-4" key={label}>
                <p className="font-mono text-2xl font-semibold">{value}</p>
                <p className="mt-1 text-xs text-muted-foreground">{label}</p>
              </div>
            ))}
          </div>
        </div>

        <div id="proof" className="rounded-xl border bg-card p-3 shadow-sm">
          <div className="rounded-lg border bg-background">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <div className="flex items-center gap-1.5">
                <span className="size-2.5 rounded-full bg-muted-foreground/40" />
                <span className="size-2.5 rounded-full bg-muted-foreground/30" />
                <span className="size-2.5 rounded-full bg-muted-foreground/20" />
              </div>
              <div className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
                <Terminal className="size-4" aria-hidden="true" />
                worker-sidecar
              </div>
            </div>

            <div className="space-y-4 p-5 font-mono text-sm">
              <p>$ avantii execute --job erq_8f41 --zero-pii</p>
              {terminalRows.map(([index, label]) => (
                <div className="grid grid-cols-[2rem_1fr] gap-3" key={label}>
                  <span className="text-muted-foreground">{index}</span>
                  <span>{label}</span>
                </div>
              ))}
              <div className="rounded-lg border bg-muted p-4">
                <p className="text-muted-foreground">current_hash</p>
                <p className="mt-2 break-all text-xs">
                  8adf7e8c2c9b4f6d019b7b2f0cdd5e9f12a7d8e3c0aaf91e5b6213d40791bbcd
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl border-t py-20">
        <div className="mb-8 flex flex-col justify-between gap-4 md:flex-row md:items-end">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.22em] text-muted-foreground">Liability Shield</p>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-5xl">Small surface. Hard guarantees.</h2>
          </div>
          <p className="max-w-xl text-sm leading-6 text-muted-foreground">
            The UI follows the engine’s legal posture: opaque identifiers, immutable evidence, and operational state only.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          {assuranceCards.map((card) => {
            const Icon = card.icon;

            return (
              <article className="rounded-xl border bg-card p-6 transition-colors hover:bg-muted/50" key={card.title}>
                <div className="flex size-10 items-center justify-center rounded-md border bg-background">
                  <Icon className="size-5" aria-hidden="true" />
                </div>
                <h3 className="mt-6 text-xl font-semibold tracking-tight">{card.title}</h3>
                <p className="mt-3 text-sm leading-6 text-muted-foreground">{card.description}</p>
                <div className="mt-6 inline-flex rounded-md border bg-background px-2.5 py-1 font-mono text-xs text-muted-foreground">
                  {card.metric}
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section className="mx-auto grid max-w-6xl gap-4 border-t py-20 lg:grid-cols-[0.8fr_1.2fr]">
        <div className="rounded-xl border bg-card p-6">
          <ShieldCheck className="size-8" aria-hidden="true" />
          <h2 className="mt-5 text-3xl font-semibold tracking-tight">Zero-PII by construction.</h2>
          <p className="mt-4 text-sm leading-6 text-muted-foreground">
            The dashboard is a cockpit for hashes, task state, worker health, and certificates. Sensitive mutation stays in
            the Data Plane Worker.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {[
            ["Control Plane", "Schedules cooldowns, stores WORM receipts, signs certificates."],
            ["Data Plane", "Locks rows, vaults PII, shreds DEKs, purges configured blobs."],
            ["Legal Guardrails", "DPDP/PMLA retention is evaluated from physical database evidence."],
            ["Operational Safety", "Retries, DLQs, schema drift checks, and shadow burn-in are visible."],
          ].map(([title, description]) => (
            <div className="rounded-xl border bg-card p-6" key={title}>
              <DatabaseZap className="size-5" aria-hidden="true" />
              <h3 className="mt-4 font-semibold tracking-tight">{title}</h3>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
