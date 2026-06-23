/**
 * 💧 Spraay Webhook Service
 *
 * Core logic for queueing, dispatching, and retrying webhook events.
 * Sits on top of Supabase — uses the existing client from your gateway.
 *
 * INTEGRATION NOTE:
 * Replace the supabase import below with your actual Supabase client path.
 * e.g. import { supabase } from '../lib/supabase';
 */

import { SupabaseClient } from '@supabase/supabase-js';
import { generateWebhookSecret, signPayload } from './signing';
import {
  WebhookEvent,
  WebhookEventType,
  WebhookDeliveryPayload,
  WebhookDeliveryHeaders,
  WebhookRegistrationResponse,
  WebhookWorkerConfig,
  DEFAULT_WORKER_CONFIG,
} from './types';

// ---------------------------------------------------------------------------
// Service class
// ---------------------------------------------------------------------------
export class WebhookService {
  private supabase: SupabaseClient;
  private config: WebhookWorkerConfig;

  constructor(supabase: SupabaseClient, config?: Partial<WebhookWorkerConfig>) {
    this.supabase = supabase;
    this.config = { ...DEFAULT_WORKER_CONFIG, ...config };
  }

  // -------------------------------------------------------------------------
  // 1. QUEUE — called by endpoint handlers when callback_url is present
  // -------------------------------------------------------------------------

  /**
   * Register a webhook callback for a request.
   * Call this inside any endpoint handler where the agent passed callback_url.
   *
   * @returns Registration response to include in the endpoint's JSON response.
   *
   * @example
   * // Inside your batch pay endpoint handler:
   * if (req.body.callback_url) {
   *   const webhook = await webhookService.queueEvent({
   *     eventType: 'batch.created',
   *     callbackUrl: req.body.callback_url,
   *     payload: { batch_id: batch.id, recipients: batch.recipients.length },
   *     sourceEndpoint: '/v1/batch/pay',
   *     requestId: req.headers['x-request-id'] as string,
   *   });
   *   // Merge webhook info into your existing response
   *   res.json({ ...batchResult, webhook });
   * }
   */
  async queueEvent(params: {
    eventType: WebhookEventType;
    callbackUrl: string;
    payload: Record<string, unknown>;
    sourceEndpoint?: string;
    requestId?: string;
    batchId?: string;
    maxAttempts?: number;
  }): Promise<WebhookRegistrationResponse> {
    const secret = generateWebhookSecret();

    const { data, error } = await this.supabase
      .from('webhook_events')
      .insert({
        event_type: params.eventType,
        callback_url: params.callbackUrl,
        payload: params.payload,
        hmac_secret: secret,
        source_endpoint: params.sourceEndpoint ?? null,
        request_id: params.requestId ?? null,
        batch_id: params.batchId ?? null,
        max_attempts: params.maxAttempts ?? 3,
        status: 'pending',
        next_retry_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (error) {
      throw new Error(`Failed to queue webhook: ${error.message}`);
    }

    return {
      webhook_id: data.id,
      webhook_secret: secret,
      subscribed_events: [params.eventType],
    };
  }

  /**
   * Queue a follow-up event for an existing webhook registration.
   * Use when a batch progresses through states (created → settled).
   * Reuses the same callback_url and hmac_secret from the original event.
   */
  async queueFollowUp(params: {
    originalWebhookId: string;
    eventType: WebhookEventType;
    payload: Record<string, unknown>;
  }): Promise<string> {
    // Look up original to inherit callback_url and secret
    const { data: original, error: fetchError } = await this.supabase
      .from('webhook_events')
      .select('callback_url, hmac_secret, request_id, batch_id, source_endpoint')
      .eq('id', params.originalWebhookId)
      .single();

    if (fetchError || !original) {
      throw new Error(`Original webhook ${params.originalWebhookId} not found`);
    }

    const { data, error } = await this.supabase
      .from('webhook_events')
      .insert({
        event_type: params.eventType,
        callback_url: original.callback_url,
        hmac_secret: original.hmac_secret,
        payload: params.payload,
        source_endpoint: original.source_endpoint,
        request_id: original.request_id,
        batch_id: original.batch_id,
        status: 'pending',
        next_retry_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (error) {
      throw new Error(`Failed to queue follow-up webhook: ${error.message}`);
    }

    return data.id;
  }

  // -------------------------------------------------------------------------
  // 2. DISPATCH — called by the background worker
  // -------------------------------------------------------------------------

  /**
   * Fetch pending events that are due for dispatch.
   */
  async fetchPendingEvents(): Promise<WebhookEvent[]> {
    const { data, error } = await this.supabase
      .from('webhook_events')
      .select('*')
      .in('status', ['pending', 'failed'])
      .lte('next_retry_at', new Date().toISOString())
      .order('next_retry_at', { ascending: true })
      .limit(this.config.batchSize);

    if (error) {
      console.error('[webhooks] Failed to fetch pending events:', error.message);
      return [];
    }

    return (data ?? []) as WebhookEvent[];
  }

  /**
   * Attempt to deliver a single webhook event.
   * Returns true if delivery succeeded (2xx response).
   */
  async deliverEvent(event: WebhookEvent): Promise<boolean> {
    const timestamp = new Date().toISOString();
    const deliveryPayload: WebhookDeliveryPayload = {
      id: event.id,
      event_type: event.event_type as WebhookEventType,
      timestamp,
      attempt: event.attempts + 1,
      request_id: event.request_id,
      data: event.payload,
    };

    const body = JSON.stringify(deliveryPayload);
    const signature = signPayload(event.hmac_secret, timestamp, body);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Spraay-Signature': signature,
      'X-Spraay-Event': event.event_type as WebhookEventType,
      'X-Spraay-Delivery-Id': event.id,
      'X-Spraay-Timestamp': timestamp,
      'User-Agent': 'Spraay-Webhooks/1.0',
    };

    try {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        this.config.deliveryTimeoutMs
      );

      const response = await fetch(event.callback_url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (response.ok) {
        // SUCCESS — mark as dispatched
        await this.markDispatched(event.id);
        console.log(
          `[webhooks] ✅ Delivered ${event.event_type} to ${event.callback_url} (attempt ${event.attempts + 1})`
        );
        return true;
      }

      // Non-2xx — treat as failure
      const errorBody = await response.text().catch(() => '(no body)');
      await this.markFailed(
        event,
        `HTTP ${response.status}: ${errorBody.slice(0, 500)}`
      );
      return false;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.markFailed(event, message);
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // 3. STATE TRANSITIONS
  // -------------------------------------------------------------------------

  private async markDispatched(eventId: string): Promise<void> {
    await this.supabase
      .from('webhook_events')
      .update({
        status: 'dispatched',
        dispatched_at: new Date().toISOString(),
      })
      .eq('id', eventId);

    // Increment attempts via raw SQL to avoid race conditions
    await this.supabase.rpc('increment_webhook_attempts', { event_id: eventId });
  }

  private async markFailed(event: WebhookEvent, errorMessage: string): Promise<void> {
    const newAttempts = event.attempts + 1;
    const exhausted = newAttempts >= event.max_attempts;

    // Exponential backoff: base * 2^(attempt-1), capped at max
    const backoffMs = Math.min(
      this.config.retryBaseDelayMs * Math.pow(2, newAttempts - 1),
      this.config.retryMaxDelayMs
    );
    const nextRetry = new Date(Date.now() + backoffMs).toISOString();

    await this.supabase
      .from('webhook_events')
      .update({
        status: exhausted ? 'exhausted' : 'failed',
        attempts: newAttempts,
        last_error: errorMessage.slice(0, 2000),
        next_retry_at: exhausted ? event.next_retry_at : nextRetry,
      })
      .eq('id', event.id);

    if (exhausted) {
      console.warn(
        `[webhooks] ❌ Exhausted ${event.event_type} → ${event.callback_url} after ${newAttempts} attempts: ${errorMessage}`
      );
    } else {
      console.log(
        `[webhooks] ⏳ Retry ${newAttempts}/${event.max_attempts} for ${event.event_type} → ${event.callback_url} at ${nextRetry}`
      );
    }
  }

  // -------------------------------------------------------------------------
  // 4. QUERY — for status checks and management routes
  // -------------------------------------------------------------------------

  async getEvent(eventId: string): Promise<WebhookEvent | null> {
    const { data, error } = await this.supabase
      .from('webhook_events')
      .select('*')
      .eq('id', eventId)
      .single();

    if (error || !data) return null;
    return data as WebhookEvent;
  }

  async getEventsByRequestId(requestId: string): Promise<WebhookEvent[]> {
    const { data, error } = await this.supabase
      .from('webhook_events')
      .select('*')
      .eq('request_id', requestId)
      .order('created_at', { ascending: true });

    if (error) return [];
    return (data ?? []) as WebhookEvent[];
  }

  /**
   * Manually retry an exhausted event (resets status to pending).
   */
  async retryExhausted(eventId: string): Promise<boolean> {
    const { error } = await this.supabase
      .from('webhook_events')
      .update({
        status: 'pending',
        attempts: 0,
        last_error: null,
        next_retry_at: new Date().toISOString(),
      })
      .eq('id', eventId)
      .eq('status', 'exhausted');

    return !error;
  }
}
