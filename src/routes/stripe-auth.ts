import { Request, Response } from "express";
import Stripe from "stripe";
import { supabase } from "../db.js";
import { generateApiKey, hashApiKey } from "../middleware/apiKeyAuth.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: "2024-12-18.acacia" as any });

const BASE_URL = process.env.BASE_URL || "https://gateway.spraay.app";
const STARTER_PRICE_ID = process.env.STRIPE_STARTER_PRICE_ID!;
const PRO_PRICE_ID = process.env.STRIPE_PRO_PRICE_ID!;

/**
 * POST /v1/auth/register
 * Creates a Stripe Checkout session → redirects user to Stripe payment page.
 * After payment, the webhook generates the API key.
 */
export async function registerHandler(req: Request, res: Response) {
  try {
    const { plan, email } = req.body;

    if (!plan || !["starter", "pro"].includes(plan)) {
      return res.status(400).json({ error: "invalid_plan", message: "Plan must be 'starter' or 'pro'." });
    }
    if (!email) {
      return res.status(400).json({ error: "missing_email", message: "Email is required." });
    }

    const priceId = plan === "starter" ? STARTER_PRICE_ID : PRO_PRICE_ID;

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      customer_email: email,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${BASE_URL}/v1/auth/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/v1/auth/cancel`,
      metadata: { plan },
    });

    return res.json({ url: session.url, sessionId: session.id });
  } catch (err: any) {
    console.error("Register error:", err);
    return res.status(500).json({ error: "checkout_failed", message: err.message });
  }
}

/**
 * GET /v1/auth/success — landing page after Stripe checkout
 */
export function successHandler(_req: Request, res: Response) {
  res.json({
    status: "success",
    message: "Payment confirmed! Your API key has been sent to your email. Check your inbox (and spam folder).",
    docs: "https://docs.spraay.app",
  });
}

/**
 * GET /v1/auth/cancel — landing page if user cancels checkout
 */
export function cancelHandler(_req: Request, res: Response) {
  res.json({
    status: "cancelled",
    message: "Checkout was cancelled. You can try again at spraay.app/pricing.",
  });
}

/**
 * GET /v1/auth/usage — check daily usage (requires X-API-Key header)
 */
export async function usageHandler(req: Request, res: Response) {
  const apiKey = req.headers["x-api-key"] as string | undefined;
  if (!apiKey) {
    return res.status(401).json({ error: "missing_api_key", message: "Include your API key in the X-API-Key header." });
  }

  const keyHash = hashApiKey(apiKey);
  const { data: row, error } = await supabase
    .from("api_keys")
    .select("plan, status, daily_calls, daily_limit, last_reset, email, created_at")
    .eq("api_key_hash", keyHash)
    .single();

  if (error || !row) {
    return res.status(401).json({ error: "invalid_api_key", message: "API key not found." });
  }

  // Lazy reset check
  const today = new Date().toISOString().slice(0, 10);
  const calls = row.last_reset !== today ? 0 : row.daily_calls;

  return res.json({
    plan: row.plan,
    status: row.status,
    usage: { daily_calls: calls, daily_limit: row.daily_limit, remaining: row.daily_limit - calls },
    resetsAt: "midnight UTC",
    email: row.email,
    createdAt: row.created_at,
  });
}

/**
 * POST /v1/auth/rotate — rotate API key (requires current X-API-Key header)
 */
export async function rotateHandler(req: Request, res: Response) {
  const apiKey = req.headers["x-api-key"] as string | undefined;
  if (!apiKey) {
    return res.status(401).json({ error: "missing_api_key", message: "Include your current API key in the X-API-Key header." });
  }

  const keyHash = hashApiKey(apiKey);
  const { data: row, error } = await supabase
    .from("api_keys")
    .select("id, email")
    .eq("api_key_hash", keyHash)
    .single();

  if (error || !row) {
    return res.status(401).json({ error: "invalid_api_key", message: "API key not found." });
  }

  const newKey = generateApiKey();
  const newHash = hashApiKey(newKey);

  await supabase
    .from("api_keys")
    .update({ api_key_hash: newHash })
    .eq("id", row.id);

  // TODO: Send new key via Resend email to row.email

  return res.json({
    message: "API key rotated successfully. Your old key no longer works.",
    api_key: newKey,
    warning: "Save this key — it won't be shown again.",
  });
}

/**
 * POST /v1/auth/portal — redirect to Stripe customer portal (manage subscription, update card)
 */
export async function portalHandler(req: Request, res: Response) {
  const apiKey = req.headers["x-api-key"] as string | undefined;
  if (!apiKey) {
    return res.status(401).json({ error: "missing_api_key", message: "Include your API key in the X-API-Key header." });
  }

  const keyHash = hashApiKey(apiKey);
  const { data: row, error } = await supabase
    .from("api_keys")
    .select("stripe_customer_id")
    .eq("api_key_hash", keyHash)
    .single();

  if (error || !row) {
    return res.status(401).json({ error: "invalid_api_key", message: "API key not found." });
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: row.stripe_customer_id,
    return_url: `${BASE_URL}`,
  });

  return res.json({ url: session.url });
}

/**
 * POST /v1/webhooks/stripe — handle Stripe webhook events
 * IMPORTANT: This route must use express.raw() body parser, not express.json()
 */
export async function stripeWebhookHandler(req: Request, res: Response) {
  const sig = req.headers["stripe-signature"] as string;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!;

  let event: any;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err: any) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).json({ error: "webhook_signature_invalid" });
  }

  console.log(`📩 Stripe webhook: ${event.type}`);

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as any;
      const plan = session.metadata?.plan || "starter";
      const email = session.customer_email || session.customer_details?.email || "";
      const customerId = session.customer as string;
      const subscriptionId = session.subscription as string;

      // Generate API key
      const newKey = generateApiKey();
      const keyHash = hashApiKey(newKey);
      const dailyLimit = plan === "pro" ? 10000 : 1000;

      const { error } = await supabase.from("api_keys").insert({
        api_key_hash: keyHash,
        stripe_customer_id: customerId,
        stripe_subscription_id: subscriptionId,
        plan,
        status: "active",
        daily_calls: 0,
        daily_limit: dailyLimit,
        email,
      });

      if (error) {
        console.error("Failed to store API key:", error);
        return res.status(500).json({ error: "db_error" });
      }

      // TODO: Send API key via Resend to email
      // For now, log it (remove in production)
      console.log(`🔑 New ${plan} API key created for ${email}: ${newKey.slice(0, 12)}...`);

      break;
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object as any;
      const subId = invoice.subscription as string;
      if (subId) {
        await supabase
          .from("api_keys")
          .update({ status: "past_due" })
          .eq("stripe_subscription_id", subId);
        console.log(`⚠️ Payment failed for subscription ${subId}`);
      }
      break;
    }

    case "customer.subscription.deleted": {
      const sub = event.data.object as any;
      await supabase
        .from("api_keys")
        .update({ status: "cancelled" })
        .eq("stripe_subscription_id", sub.id);
      console.log(`❌ Subscription cancelled: ${sub.id}`);
      break;
    }

    case "invoice.payment_succeeded": {
      // Reactivate if previously past_due
      const invoice = event.data.object as any;
      const subId = invoice.subscription as string;
      if (subId) {
        await supabase
          .from("api_keys")
          .update({ status: "active" })
          .eq("stripe_subscription_id", subId);
      }
      break;
    }

    default:
      // Unhandled event type — that's fine
      break;
  }

  return res.json({ received: true });
}
