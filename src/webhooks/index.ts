/**
 * 💧 Spraay Webhooks — Loop-Native Agent Callbacks
 *
 * Usage:
 *   import { WebhookService, webhookMiddleware, startWebhookWorker, createWebhookRouter } from './webhooks';
 */

export { WebhookService } from './service';
export { webhookMiddleware } from './middleware';
export { startWebhookWorker } from './worker';
export type { WebhookWorkerHandle } from './worker';
export { createWebhookRouter } from './routes';
export { generateWebhookSecret, signPayload, verifySignature } from './signing';
export type {
  WebhookEvent,
  WebhookEventType,
  WebhookStatus,
  WebhookCallbackParams,
  WebhookRegistrationResponse,
  WebhookDeliveryPayload,
  WebhookDeliveryHeaders,
  WebhookWorkerConfig,
} from './types';
