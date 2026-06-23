/**
 * 💧 Spraay Webhook Middleware
 *
 * Express middleware that detects callback_url in request bodies
 * and attaches a helper to the request object for easy webhook queueing.
 *
 * NON-BREAKING: If callback_url is absent, does nothing.
 * Existing endpoint handlers continue to work untouched.
 *
 * USAGE:
 * 1. Mount the middleware globally or on specific routes:
 *    app.use('/v1', webhookMiddleware(webhookService));
 *
 * 2. In any endpoint handler, check for the helper:
 *    if (req.webhookCallback) {
 *      const registration = await req.webhookCallback('batch.settled', { batch_id: '...' });
 *      res.json({ ...result, webhook: registration });
 *    }
 */

import { Request, Response, NextFunction } from 'express';
import { WebhookService } from './service';
import {
  WebhookEventType,
  WebhookRegistrationResponse,
  WebhookCallbackParams,
} from './types';

// ---------------------------------------------------------------------------
// Extend Express Request type
// ---------------------------------------------------------------------------
declare global {
  namespace Express {
    interface Request {
      /**
       * Present only when the agent passed callback_url in the request body.
       * Call this to queue a webhook event for async delivery.
       */
      webhookCallback?: (
        eventType: WebhookEventType,
        payload: Record<string, unknown>,
        options?: { batchId?: string; maxAttempts?: number }
      ) => Promise<WebhookRegistrationResponse>;

      /** The raw callback_url from the request, if present. */
      callbackUrl?: string;
    }
  }
}

// ---------------------------------------------------------------------------
// URL validation (basic — just needs to be a reachable HTTPS endpoint)
// ---------------------------------------------------------------------------
function isValidCallbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    // Only allow HTTPS in production (HTTP ok for localhost/dev)
    if (parsed.protocol === 'https:') return true;
    if (
      parsed.protocol === 'http:' &&
      (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------
export function webhookMiddleware(service: WebhookService) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const callbackUrl = req.body?.callback_url;

    // No callback_url → pass through, existing behavior unchanged
    if (!callbackUrl || typeof callbackUrl !== 'string') {
      return next();
    }

    // Validate the URL
    if (!isValidCallbackUrl(callbackUrl)) {
      console.warn(`[webhooks] Invalid callback_url rejected: ${callbackUrl}`);
      return next(); // Don't block the request, just skip webhook setup
    }

    // Attach the URL and helper to the request
    req.callbackUrl = callbackUrl;

    req.webhookCallback = async (
      eventType: WebhookEventType,
      payload: Record<string, unknown>,
      options?: { batchId?: string; maxAttempts?: number }
    ): Promise<WebhookRegistrationResponse> => {
      return service.queueEvent({
        eventType,
        callbackUrl,
        payload,
        sourceEndpoint: `${req.method} ${req.baseUrl}${req.path}`,
        requestId: (req.headers['x-request-id'] as string) ?? undefined,
        batchId: options?.batchId,
        maxAttempts: options?.maxAttempts,
      });
    };

    next();
  };
}
