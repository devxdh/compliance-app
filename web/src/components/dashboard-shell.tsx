"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ComponentType, type ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  Blocks,
  ChevronLeft,
  ChevronRight,
  FileClock,
  Fingerprint,
  LayoutDashboard,
  LogOut,
  Network,
  ShieldCheck,
  UserCircle,
} from "lucide-react";
import { AvantiiLogo } from "@/components/avantii-logo";
import { ModeToggle } from "@/components/mode-toggle";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

type DashboardShellProps = Readonly<{
  children: ReactNode;
  userName: string;
  userEmail: string;
}>;

type NavigationItem = Readonly<{
  href: string;
  label: string;
  icon: ComponentType<{ className?: string; "aria-hidden"?: "true" }>;
}>;

const navigation: readonly NavigationItem[] = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/dashboard/clients", label: "Clients", icon: ShieldCheck },
  { href: "/dashboard/erasure-requests", label: "Erasure Requests", icon: FileClock },
  { href: "/dashboard/audit-ledger", label: "WORM Ledger", icon: Fingerprint },
  { href: "/dashboard/workers", label: "Workers", icon: Network },
  { href: "/dashboard/dead-letters", label: "Dead Letters", icon: AlertTriangle },
] as const;

function Breadcrumbs({ pathname }: Readonly<{ pathname: string }>) {
  const parts = pathname.split("/").filter(Boolean);

  return (
    <nav aria-label="Breadcrumb" className="hidden items-center gap-2 font-mono text-xs text-muted-foreground md:flex">
      <Link className="hover:text-foreground" href="/dashboard">
        control-plane
      </Link>
      {parts.slice(1).map((part, index) => (
        <span className="flex items-center gap-2" key={`${part}-${index}`}>
          <ChevronRight className="size-3" aria-hidden="true" />
          <span>{part.replaceAll("-", "_")}</span>
        </span>
      ))}
    </nav>
  );
}

/**
 * Responsive dashboard shell with collapsible navigation and operator menu.
 *
 * @param props - Authenticated user metadata and dashboard content.
 * @returns The protected Control Plane application frame.
 */
export function DashboardShell({ children, userName, userEmail }: DashboardShellProps) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="min-h-screen bg-background">
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-30 hidden border-r bg-background transition-[width] duration-300 ease-out lg:block",
          collapsed ? "w-20" : "w-72"
        )}
      >
        <div className="flex h-16 items-center justify-between px-4">
          {!collapsed && <AvantiiLogo />}
          <Button
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className={cn(collapsed && "mx-auto")}
            size="icon"
            variant="ghost"
            onClick={() => setCollapsed((value) => !value)}
          >
            <ChevronLeft className={cn("size-4 transition", collapsed && "rotate-180")} />
          </Button>
        </div>

        <div className="px-3">
          <div className="mb-4 rounded-lg border bg-card p-3">
            <div className="flex items-center gap-2">
              <span className="relative flex size-2">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-foreground opacity-20" />
                <span className="relative inline-flex size-2 rounded-full bg-foreground" />
              </span>
              {!collapsed && (
                <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-foreground">Live Status</span>
              )}
            </div>
            {!collapsed && <p className="mt-2 text-xs text-muted-foreground">Zero-PII metadata stream active</p>}
          </div>

          <nav className="space-y-1" aria-label="Dashboard navigation">
            {navigation.map((item) => {
              const isActive = pathname === item.href || (item.href !== "/dashboard" && pathname.startsWith(item.href));
              const Icon = item.icon;

              return (
                <Link
                  className={cn(
                    "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground",
                    isActive && "bg-accent text-accent-foreground",
                    collapsed && "justify-center"
                  )}
                  href={item.href}
                  key={item.href}
                >
                  <Icon className="size-4 shrink-0" aria-hidden="true" />
                  {!collapsed && <span>{item.label}</span>}
                </Link>
              );
            })}
          </nav>
        </div>
      </aside>

      <div className={cn("transition-[padding] duration-300", collapsed ? "lg:pl-20" : "lg:pl-72")}>
        <header className="sticky top-0 z-20 border-b bg-background/90 supports-[backdrop-filter]:bg-background/70">
          <div className="flex h-16 items-center justify-between px-4 sm:px-6">
            <div className="flex items-center gap-4">
              <div className="lg:hidden">
                <AvantiiLogo />
              </div>
              <Breadcrumbs pathname={pathname} />
            </div>

            <div className="flex items-center gap-3">
              <ModeToggle />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button className="gap-2" variant="outline">
                    <UserCircle className="size-4" />
                    <span className="hidden sm:inline">{userName}</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>Operator</DropdownMenuLabel>
                  <div className="px-2 pb-2 font-mono text-xs text-muted-foreground">{userEmail}</div>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem>
                    <Activity className="mr-2 size-4" />
                    Session audit
                  </DropdownMenuItem>
                  <DropdownMenuItem>
                    <Blocks className="mr-2 size-4" />
                    Configuration
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem>
                    <LogOut className="mr-2 size-4" />
                    Sign out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
