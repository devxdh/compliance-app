import { redirect } from "next/navigation";
import { auth, signIn } from "@/auth";
import { AvantiiLogo } from "@/components/avantii-logo";
import { Button } from "@/components/ui/button";

async function signInWithGoogle() {
  "use server";
  await signIn("google", { redirectTo: "/dashboard" });
}

export default async function LoginPage() {
  const session = await auth();
  const isGoogleConfigured = Boolean(
    (process.env.AUTH_GOOGLE_ID ?? process.env.GOOGLE_CLIENT_ID) &&
      (process.env.AUTH_GOOGLE_SECRET ?? process.env.GOOGLE_CLIENT_SECRET)
  );
  const isAllowlistConfigured = Boolean(
    (process.env.AVANTII_ADMIN_EMAILS ?? process.env.ADMIN_EMAIL_ALLOWLIST)?.trim()
  );

  if (session?.user) {
    redirect("/dashboard");
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <section className="w-full max-w-md rounded-xl border bg-card p-8 shadow-sm">
        <AvantiiLogo />
        <h1 className="mt-10 text-3xl font-semibold tracking-tight">Operator access</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          Dashboard access is protected by Auth.js encrypted HTTP-only session cookies. API tokens are never exposed to the browser.
        </p>

        {isGoogleConfigured && isAllowlistConfigured ? (
          <form action={signInWithGoogle} className="mt-8">
            <Button className="w-full" type="submit">
              Continue with Google
            </Button>
          </form>
        ) : (
          <div className="mt-8 rounded-lg border bg-muted p-4">
            <p className="font-mono text-xs uppercase tracking-[0.22em] text-foreground">Configuration required</p>
            <p className="mt-2 text-sm text-muted-foreground">
              Add OAuth credentials and an explicit <span className="font-mono">AVANTII_ADMIN_EMAILS</span> allowlist.
              The dashboard fails closed when either is missing.
            </p>
          </div>
        )}
      </section>
    </main>
  );
}
