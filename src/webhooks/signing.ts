/**
 * 💧 Spraay Webhook Signing
 *
 * HMAC-SHA256 signing for outbound webhook payloads.
 * Follows the Stripe/GitHub pattern: signature = HMAC(secret, timestamp + "." + body).
 * Agents verify by recomputing the signature with their stored webhook_secret.
 */

import crypto from 'crypto';

const SIGNATURE_PREFIX = 'sha256=';

/**
 * Generate a cryptographically random webhook signing secret.
 * Returned to the agent when they provide callback_url.
 * Format: whsec_<40 hex chars>
 */
export function generateWebhookSecret(): string {
  const random = crypto.randomBytes(20).toString('hex');
  return `whsec_${random}`;
}

/**
 * Sign a webhook payload.
 *
 * @param secret  - The per-event HMAC secret (whsec_xxx)
 * @param timestamp - ISO-8601 timestamp included in the signature base
 * @param body    - The raw JSON string being sent
 * @returns The full signature string: "sha256=<hex>"
 */
export function signPayload(
  secret: string,
  timestamp: string,
  body: string
): string {
  // Signature base: timestamp.body (prevents replay with different timestamps)
  const signatureBase = `${timestamp}.${body}`;
  const hmac = crypto
    .createHmac('sha256', secret)
    .update(signatureBase, 'utf8')
    .digest('hex');

  return `${SIGNATURE_PREFIX}${hmac}`;
}

/**
 * Verify an inbound webhook signature (for agents to use, or for testing).
 *
 * @param secret    - The stored webhook_secret
 * @param timestamp - Value of X-Spraay-Timestamp header
 * @param body      - Raw request body string
 * @param signature - Value of X-Spraay-Signature header
 * @param toleranceMs - Max age of the timestamp to accept (default: 5 min)
 * @returns true if valid
 */
export function verifySignature(
  secret: string,
  timestamp: string,
  body: string,
  signature: string,
  toleranceMs: number = 5 * 60 * 1000
): boolean {
  // Reject stale timestamps to prevent replay attacks
  const eventTime = new Date(timestamp).getTime();
  const now = Date.now();
  if (Math.abs(now - eventTime) > toleranceMs) {
    return false;
  }

  const expected = signPayload(secret, timestamp, body);

  // Constant-time comparison to prevent timing attacks
  if (expected.length !== signature.length) {
    return false;
  }

  return crypto.timingSafeEqual(
    Buffer.from(expected, 'utf8'),
    Buffer.from(signature, 'utf8')
  );
}
