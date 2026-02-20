import { Request, Response } from "express";

// In-memory stats (use Redis in production)
const stats: Record<string, number> = {
  ai_chat: 0,
  ai_models: 0,
  batch_execute: 0,
  batch_estimate: 0,
  swap_quote: 0,
  swap_tokens: 0,
};

let startTime = Date.now();

export function trackRequest(endpoint: string) {
  stats[endpoint] = (stats[endpoint] || 0) + 1;
}

/**
 * GET /health
 * Free endpoint - service health check
 */
export function healthHandler(_req: Request, res: Response) {
  const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);

  res.json({
    status: "healthy",
    uptime: formatUptime(uptimeSeconds),
    version: "1.0.0",
    services: {
      aiGateway: process.env.OPENROUTER_API_KEY ? "configured" : "needs_api_key",
      batchPayments: "ready",
      swapData: "ready",
    },
    network: process.env.X402_NETWORK || "eip155:84532",
    protocol: "x402",
  });
}

/**
 * GET /stats
 * Free endpoint - usage statistics
 */
export function statsHandler(_req: Request, res: Response) {
  const totalRequests = Object.values(stats).reduce((a, b) => a + b, 0);
  const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);

  // Calculate estimated revenue based on endpoint pricing
  const pricing: Record<string, number> = {
    ai_chat: 0.005,
    ai_models: 0.001,
    batch_execute: 0.01,
    batch_estimate: 0.001,
    swap_quote: 0.002,
    swap_tokens: 0.001,
  };

  const estimatedRevenue = Object.entries(stats).reduce(
    (total, [key, count]) => total + (pricing[key] || 0) * count,
    0
  );

  res.json({
    totalPaidRequests: totalRequests,
    estimatedRevenueUSDC: `$${estimatedRevenue.toFixed(4)}`,
    uptime: formatUptime(uptimeSeconds),
    breakdown: Object.entries(stats).map(([endpoint, count]) => ({
      endpoint,
      requests: count,
      revenueUSDC: `$${((pricing[endpoint] || 0) * count).toFixed(4)}`,
      pricePerRequest: `$${pricing[endpoint] || 0}`,
    })),
    _note:
      "Stats reset on server restart. Use a persistent store (Redis/DB) for production.",
  });
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m ${secs}s`;
  return `${minutes}m ${secs}s`;
}
