import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { DashboardShell } from "@/components/dashboard-shell";

export default async function DashboardLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const session = await auth();

  if (!session?.user) {
    redirect("/login");
  }

  return (
    <DashboardShell
      userEmail={session.user.email ?? "operator@avantii.local"}
      userName={session.user.name ?? "Compliance Operator"}
    >
      {children}
    </DashboardShell>
  );
}
