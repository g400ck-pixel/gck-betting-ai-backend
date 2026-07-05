export default {
  async fetch(request) {
    const url = new URL(request.url);

    return new Response(JSON.stringify({
      ok: true,
      message: "Worker is running",
      path: url.pathname,
      testRoutes: [
        "/",
        "/health",
        "/api/scan-games"
      ]
    }, null, 2), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      }
    });
  }
}
