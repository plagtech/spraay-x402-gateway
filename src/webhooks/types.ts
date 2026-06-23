/**
 * 💧 Spraay Webhook Types
 *
 * Loop-native webhook system for agent callback delivery.
 * All types are additive — nothing here alters existing Spraay types.
 */

// ---------------------------------------------------------------------------
// Event types agents can subscribe to via callback_url
// ---------------------------------------------------------------------------
export type WebhookEventType =
  | 'batch.created'
  | 'batch.confirmed'
  | 'batch.settled'
  | 'batch.partial_failure'
  | 'batch.failed'
  | 'payment.confirmed'
  | 'payment.failed'
  | 'escrow.funded'
  | 'escrow.released'
  | 'escrow.disputed'
  | 'escrow.expired'
  | 'session.timeout'
  | 'health.degraded'
  | 'health.recovered';

// ---------------------------------------------------------------------------
// Database row shape (matches Supabase table)
// ---------------------------------------------------------------------------
export interface WebhookEvent {
  id: string;
  event_type: WebhookEventType;
  payload: Record<string, unknown>;
  callback_url: string;
  hmac_secret: string;
  status: WebhookStatus;
  attempts: number;
  max_attempts: number;
  next_retry_at: string;
  last_error: string | null;
  dispatched_at: string | null;
  source_endpoint: string | null;
  request_id: string | null;
  batch_id: string | null;
  created_at: string;
  updated_at: string;
}

export type WebhookStatus = 'pending' | 'dispatched' | 'failed' | 'exhausted';

// ---------------------------------------------------------------------------
// What agents pass in their request body (optional fields)
// ---------------------------------------------------------------------------
export interface WebhookCallbackParams {
  /** URL to receive the POST callback when the event resolves */
  callback_url: string;
  /** Optional: restrict which event types trigger a callback. Default: all relevant. */
  callback_events?: WebhookEventType[];
}

// ---------------------------------------------------------------------------
// What agents get back when callback_url is provided
// ---------------------------------------------------------------------------
export interface WebhookRegistrationResponse {
  webhook_id: string;
  /** The HMAC secret for verifying inbound webhook signatures. Store this. */
  webhook_secret: string;
  /** Which events will fire to the callback_url */
  subscribed_events: WebhookEventType[];
}

// ---------------------------------------------------------------------------
// The signed payload POSTed to the agent's callback_url
// ---------------------------------------------------------------------------
export interface WebhookDeliveryPayload {
  /** Unique event ID (idempotency key — agents should dedupe on this) */
  id: string;
  event_type: WebhookEventType;
  /** ISO-8601 timestamp of when the event occurred */
  timestamp: string;
  /** Attempt number (1-indexed) */
  attempt: number;
  /** Correlates back to the original Spraay request */
  request_id: string | null;
  /** The event-specific data */
  data: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Outbound delivery headers
// ---------------------------------------------------------------------------
export interface WebhookDeliveryHeaders {
  'Content-Type': 'application/json';
  'X-Spraay-Signature': string;      // HMAC-SHA256 hex digest
  'X-Spraay-Event': WebhookEventType;
  'X-Spraay-Delivery-Id': string;    // same as payload.id
  'X-Spraay-Timestamp': string;      // signing timestamp
  'User-Agent': 'Spraay-Webhooks/1.0';
}

// ---------------------------------------------------------------------------
// Worker configuration
// ---------------------------------------------------------------------------
export interface WebhookWorkerConfig {
  /** How often the worker polls for pending events (ms). Default: 5000 */
  pollIntervalMs: number;
  /** Max events to process per tick. Default: 25 */
  batchSize: number;
  /** Request timeout for outbound POSTs (ms). Default: 10000 */
  deliveryTimeoutMs: number;
  /** Base delay for exponential backoff (ms). Default: 30000 */
  retryBaseDelayMs: number;
  /** Max delay cap (ms). Default: 3600000 (1 hour) */
  retryMaxDelayMs: number;
}

export const DEFAULT_WORKER_CONFIG: WebhookWorkerConfig = {
  pollIntervalMs: 5_000,
  batchSize: 25,
  deliveryTimeoutMs: 10_000,
  retryBaseDelayMs: 30_000,
  retryMaxDelayMs: 3_600_000,
};
