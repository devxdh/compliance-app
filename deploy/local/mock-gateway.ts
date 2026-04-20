interface StoredEvent {
  id: string;
  type: "mail" | "webhook";
  received_at: string;
  payload: unknown;
}

const events: StoredEvent[] = [];

function jsonResponse(payload: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

function recordEvent(type: StoredEvent["type"], payload: unknown): StoredEvent {
  const event: StoredEvent = {
    id: crypto.randomUUID(),
    type,
    received_at: new Date().toISOString(),
    payload,
  };
  events.push(event);
  return event;
}

Bun.serve({
  port: Number(process.env.PORT ?? "8080"),
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/healthz") {
      return new Response("ok", { status: 200 });
    }

    if (request.method === "GET" && url.pathname === "/events") {
      return jsonResponse(events);
    }

    if (request.method === "DELETE" && url.pathname === "/events") {
      events.length = 0;
      return new Response(null, { status: 204 });
    }

    if (request.method === "POST" && (url.pathname === "/mail" || url.pathname === "/webhook")) {
      const payload = await request.json();
      const type = url.pathname === "/mail" ? "mail" : "webhook";
      const event = recordEvent(type, payload);
      return jsonResponse({ accepted: true, event_id: event.id }, 202);
    }

    return new Response("Not Found", { status: 404 });
  },
});

