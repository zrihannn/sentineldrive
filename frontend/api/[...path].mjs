export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Allow": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
          "Cache-Control": "no-store"
        }
      });
    }

    const backendBase = process.env.SENTINELDRIVE_BACKEND_URL;
    const apiKey = process.env.SENTINELDRIVE_API_KEY;

    if (!backendBase || !apiKey) {
      return Response.json(
        { detail: "Vercel is missing SENTINELDRIVE_BACKEND_URL or SENTINELDRIVE_API_KEY." },
        { status: 503 }
      );
    }

    const incoming = new URL(request.url);
    if (!incoming.pathname.startsWith("/api/")) {
      return Response.json({ detail: "Not found." }, { status: 404 });
    }

    let backend;
    try {
      backend = new URL(backendBase);
    } catch {
      return Response.json(
        { detail: "SENTINELDRIVE_BACKEND_URL must be a valid absolute URL." },
        { status: 500 }
      );
    }

    if (backend.protocol !== "https:") {
      return Response.json(
        { detail: "The configured Render backend URL must use HTTPS." },
        { status: 500 }
      );
    }

    const target = new URL(incoming.pathname + incoming.search, backend);
    const headers = new Headers();
    headers.set("X-SentinelDrive-Key", apiKey);

    for (const name of ["accept", "content-type"]) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }

    const options = {
      method: request.method,
      headers,
      redirect: "manual"
    };

    if (request.method !== "GET" && request.method !== "HEAD") {
      options.body = await request.arrayBuffer();
    }

    try {
      const upstream = await fetch(target, options);
      const responseHeaders = new Headers();

      for (const name of ["content-type", "content-disposition"]) {
        const value = upstream.headers.get(name);
        if (value) responseHeaders.set(name, value);
      }

      responseHeaders.set("Cache-Control", "no-store");

      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders
      });
    } catch {
      return Response.json(
        { detail: "Could not reach the SentinelDrive backend on Render." },
        { status: 502 }
      );
    }
  }
};
