import { Request, Response, NextFunction } from "express";

// ============================================================
// Bazaar Service Identity Middleware
// ============================================================
// Injects serviceName, tags, and iconUrl into every HTTP 402
// response's `resource` object so Bazaar's indexer picks up
// Spraay's branding on first successful payment settlement.
//
// Spec: x402 v2 PaymentRequired resource metadata
// Ref:  https://x.com/0xyoussea/status/2057854102621602029
// ============================================================

const SPRAAY_SERVICE_IDENTITY = {
  serviceName: "Spraay Protocol",
  tags: [
    "batch-payments",
    "x402-gateway",
    "multi-chain",
    "ai-agents",
    "defi",
    "payments",
    "compute",
    "escrow",
    "payroll",
    "oracle",
    "robotics",
    "agent-wallet",
  ],
  iconUrl:
    "https://raw.githubusercontent.com/plagtech/spraay-x402-mcp/main/spraay-logo-1000x1000.png",
};

export function bazaarIdentityMiddleware(
  _req: Request,
  res: Response,
  next: NextFunction
) {
  // Intercept res.json so we can enrich 402 bodies before they leave
  const originalJson = res.json.bind(res);

  res.json = function (body: any) {
    // Only touch 402 Payment Required responses that have a resource object
    if (res.statusCode === 402 && body && typeof body === "object") {
      // x402 middleware may nest resource at body.resource or body.paymentRequirements.resource
      if (body.resource && typeof body.resource === "object") {
        body.resource = { ...body.resource, ...SPRAAY_SERVICE_IDENTITY };
      }
      // Some x402 versions put it at the top level alongside accepts[]
      // Add as top-level fields too so the facilitator/indexer can find them
      if (!body.serviceName) {
        body.serviceName = SPRAAY_SERVICE_IDENTITY.serviceName;
        body.tags = SPRAAY_SERVICE_IDENTITY.tags;
        body.iconUrl = SPRAAY_SERVICE_IDENTITY.iconUrl;
      }
    }
    return originalJson(body);
  } as any;

  next();
}
