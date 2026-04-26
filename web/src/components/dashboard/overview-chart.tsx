"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { UsageSummary } from "@/lib/api-schemas";

interface ChartRow {
  eventType: string;
  units: number;
}

function toChartRows(usage: UsageSummary[]): ChartRow[] {
  const grouped = new Map<string, number>();
  for (const row of usage) {
    grouped.set(row.event_type, (grouped.get(row.event_type) ?? 0) + row.total_units);
  }

  return Array.from(grouped, ([eventType, units]) => ({ eventType, units }));
}

/**
 * Visualizes billable Control Plane events without exposing subject-level data.
 *
 * @param props - Usage rows already aggregated by the server-side API client.
 * @returns Responsive bar chart for the overview dashboard.
 */
export function OverviewChart(props: { usage: UsageSummary[] }) {
  const data = toChartRows(props.usage);

  if (data.length === 0) {
    return (
    <div className="flex h-72 items-center justify-center rounded-xl border bg-card text-sm text-muted-foreground">
        No usage events recorded yet.
      </div>
    );
  }

  return (
    <div className="h-72 rounded-xl border bg-card p-4">
      <ResponsiveContainer height="100%" width="100%">
        <BarChart data={data} margin={{ left: 0, right: 16, top: 12, bottom: 0 }}>
          <CartesianGrid stroke="var(--border)" vertical={false} />
          <XAxis dataKey="eventType" stroke="var(--muted-foreground)" tick={{ fontSize: 11 }} />
          <YAxis stroke="var(--muted-foreground)" tick={{ fontSize: 11 }} width={36} />
          <Tooltip
            contentStyle={{
              background: "var(--background)",
              border: "1px solid var(--border)",
              borderRadius: "8px",
              color: "var(--foreground)",
            }}
            cursor={{ fill: "var(--muted)" }}
          />
          <Bar dataKey="units" fill="var(--primary)" radius={[10, 10, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
