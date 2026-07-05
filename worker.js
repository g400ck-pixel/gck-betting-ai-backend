const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({
        ok: true,
        service: "GCK Betting AI Backend",
        status: "live",
      });
    }

    if (url.pathname === "/api/scan-games") {
      return json({
        ok: true,
        mode: "live-backend",
        message: "GCK scan-games route is working",
        worker: "g400ck",
        models: ["478", "475", "457", "461", "455", "500"],
        sampleResults: [
          {
            expert: "478",
            model: "Pitching Quality Divergence",
            sport: "MLB",
            bet: "Away F5 +1.5",
            status: "backend connected",
            note: "Odds/Data API scan will plug in here next."
          }
        ]
      });
    }

    return json({
      ok: false,
      error: "Route not found",
      path: url.pathname,
    }, 404);
  },
};
