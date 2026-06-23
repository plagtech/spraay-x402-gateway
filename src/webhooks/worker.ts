/**
 * 💧 Spraay Webhook Worker
 *
 * Background loop that polls the webhook_events table and dispatches pending events.
 * Designed to run as part of your existing Railway Express process —
 * starts a setInterval loop that won't block the event loop.
 *
 * INTEGRATION:
 * Call `startWebhookWorker(supabase)` once during server startup.
 * Call the returned `stop()` function during graceful shutdown.
 */

import { SupabaseClient } from '@supabase/supabase-js';
import { WebhookService } from './service';
import { WebhookWorkerConfig, DEFAULT_WORKER_CONFIG } from './types';

export interface WebhookWorkerHandle {
  /** Stops the polling loop. Safe to call multiple times. */
  stop: () => void;
  /** Whether the worker is currently running. */
  isRunning: () => boolean;
}

export function startWebhookWorker(
  supabase: SupabaseClient,
  config?: Partial<WebhookWorkerConfig>
): WebhookWorkerHandle {
  const mergedConfig = { ...DEFAULT_WORKER_CONFIG, ...config };
  const service = new WebhookService(supabase, mergedConfig);
  let running = true;
  let processing = false;

  console.log(
    `[webhooks] 💧 Worker started (poll: ${mergedConfig.pollIntervalMs}ms, batch: ${mergedConfig.batchSize})`
  );

  const intervalId = setInterval(async () => {
    // Skip if previous tick is still running (prevents overlap)
    if (processing) return;
    processing = true;

    try {
      const events = await service.fetchPendingEvents();

      if (events.length > 0) {
        console.log(`[webhooks] Processing ${events.length} pending event(s)`);

        // Dispatch concurrently with a concurrency limit
        const CONCURRENCY = 5;
        for (let i = 0; i < events.length; i += CONCURRENCY) {
          const batch = events.slice(i, i + CONCURRENCY);
          await Promise.allSettled(
            batch.map((event) => service.deliverEvent(event))
          );
        }
      }
    } catch (err) {
      console.error('[webhooks] Worker tick error:', err);
    } finally {
      processing = false;
    }
  }, mergedConfig.pollIntervalMs);

  return {
    stop: () => {
      if (running) {
        clearInterval(intervalId);
        running = false;
        console.log('[webhooks] Worker stopped');
      }
    },
    isRunning: () => running,
  };
}
