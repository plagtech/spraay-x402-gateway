/**
 * 💧 Spraay Webhook Routes
 *
 * Optional REST endpoints for agents to check webhook delivery status.
 * Mount these at /v1/webhooks or similar.
 *
 * USAGE:
 *   import { createWebhookRouter } from './webhooks/routes';
 *   app.use('/v1/webhooks', createWebhookRouter(webhookService));
 */

import { Router, Request, Response } from 'express';
import { WebhookService } from './service';

export function createWebhookRouter(service: WebhookService): Router {
  const router = Router();

  /**
   * GET /v1/webhooks/:id
   * Check delivery status of a specific webhook event.
   * Agents use this to verify their callback was received.
   */
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const event = await service.getEvent(req.params.id as string);

      if (!event) {
        return res.status(404).json({
          error: 'webhook_not_found',
          message: `No webhook event with id ${req.params.id}`,
        });
      }

      // Don't expose the HMAC secret in status responses
      const { hmac_secret: _, ...safeEvent } = event;

      return res.json({
        webhook: {
          ...safeEvent,
          // Include human-readable delivery info
          delivery_summary: {
            delivered: event.status === 'dispatched',
            attempts_made: event.attempts,
            attempts_remaining: Math.max(0, event.max_attempts - event.attempts),
            last_error: event.last_error,
            next_retry: event.status === 'failed' ? event.next_retry_at : null,
          },
        },
      });
    } catch (err) {
      console.error('[webhooks] Route error:', err);
      return res.status(500).json({ error: 'internal', message: 'Failed to fetch webhook status' });
    }
  });

  /**
   * GET /v1/webhooks/request/:requestId
   * List all webhook events for a given x-request-id.
   * Useful for tracing the full lifecycle of a batch payment.
   */
  router.get('/request/:requestId', async (req: Request, res: Response) => {
    try {
      const events = await service.getEventsByRequestId(req.params.requestId as string);

      // Strip secrets
      const safeEvents = events.map(({ hmac_secret: _, ...rest }) => rest);

      return res.json({ webhooks: safeEvents });
    } catch (err) {
      console.error('[webhooks] Route error:', err);
      return res.status(500).json({ error: 'internal', message: 'Failed to fetch webhooks' });
    }
  });

  /**
   * POST /v1/webhooks/:id/retry
   * Manually retry a webhook that exhausted its attempts.
   */
  router.post('/:id/retry', async (req: Request, res: Response) => {
    try {
      const success = await service.retryExhausted(req.params.id as string);

      if (!success) {
        return res.status(404).json({
          error: 'not_retriable',
          message: 'Webhook not found or not in exhausted status',
        });
      }

      return res.json({
        message: 'Webhook re-queued for delivery',
        webhook_id: req.params.id,
      });
    } catch (err) {
      console.error('[webhooks] Route error:', err);
      return res.status(500).json({ error: 'internal', message: 'Failed to retry webhook' });
    }
  });

  return router;
}
