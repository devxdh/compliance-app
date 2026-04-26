import { NextResponse } from "next/server";

function getConfig(): { baseUrl: string; token: string } | null {
  const token = process.env.ADMIN_API_TOKEN;
  if (!token) {
    return null;
  }

  const baseUrl = process.env.AVANTII_API_BASE_URL ?? process.env.CONTROL_PLANE_API_URL ?? "http://localhost:3000";
  return { baseUrl: baseUrl.replace(/\/+$/, ""), token };
}

export async function GET() {
  const config = getConfig();
  if (!config) {
    return NextResponse.json(
      {
        error: "ADMIN_API_TOKEN is not configured for the web BFF.",
      },
      { status: 503 }
    );
  }

  const response = await fetch(`${config.baseUrl}/api/v1/admin/audit/export`, {
    headers: {
      accept: "application/x-ndjson",
      authorization: `Bearer ${config.token}`,
    },
    cache: "no-store",
  });

  if (!response.ok) {
    return NextResponse.json(
      {
        error: `Control Plane audit export failed with HTTP ${response.status}.`,
      },
      { status: response.status }
    );
  }

  return new Response(await response.text(), {
    headers: {
      "content-disposition": `attachment; filename="avantii-audit-ledger-${new Date().toISOString()}.ndjson"`,
      "content-type": "application/x-ndjson; charset=utf-8",
    },
  });
}
