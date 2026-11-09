import { ApplicationFailure } from "@temporalio/activity";
import type { CanonicalItem } from "../types";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

// docker-compose.yml sets these. Never hardcode a downstream URL.
const PAYMENT_URL = requiredEnv("PAYMENT_URL");
const INVENTORY_URL = requiredEnv("INVENTORY_URL");
const SHIPPING_URL = requiredEnv("SHIPPING_URL");
const NOTIFICATION_URL = requiredEnv("NOTIFICATION_URL");

// One POST to one mock. Decides whether Temporal may try again:
//   2xx            -> return
//   4xx            -> the service said no, it will say no again: non-retryable
//   5xx / no reply -> temporary: retryable
// A call that takes too long is handled by startToCloseTimeout, not here.
async function post(name: string, url: string, body: unknown): Promise<void> {
  let status = 0;
  let text = "";

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    status = response.status;
    text = await response.text();
  } catch (err) {
    throw ApplicationFailure.retryable(`${name}: no answer from ${url}`, `${name}_unreachable`);
  }

  if (status >= 200 && status < 300) {
    return;
  }

  // Use the mock's own error code when the body has one.
  let code = `${name}_http_${status}`;
  try {
    const data = JSON.parse(text) as { code?: unknown };
    if (data && typeof data.code === "string") {
      code = data.code;
    }
  } catch {
    // body was not JSON: keep the default code
  }

  if (status >= 400 && status < 500) {
    throw ApplicationFailure.nonRetryable(`${name} refused: ${code}`, code);
  }
  throw ApplicationFailure.retryable(`${name} failed: ${code}`, code);
}

/** POST {PAYMENT_URL}/payment/authorize with { orderId, amount }. */
export async function authorizePayment(orderId: string, amount: string): Promise<void> {
  await post("payment", `${PAYMENT_URL}/payment/authorize`, { orderId, amount });
}

/** POST {INVENTORY_URL}/inventory/reserve with { orderId, items }. */
export async function reserveInventory(orderId: string, items: CanonicalItem[]): Promise<void> {
  await post("inventory", `${INVENTORY_URL}/inventory/reserve`, { orderId, items });
}

/** POST {SHIPPING_URL}/shipping/create with { orderId }. */
export async function createShipment(orderId: string): Promise<void> {
  await post("shipping", `${SHIPPING_URL}/shipping/create`, { orderId });
}

/** POST {NOTIFICATION_URL}/notification/send with { orderId, recipient }. */
export async function sendNotification(orderId: string, recipient: string): Promise<void> {
  await post("notification", `${NOTIFICATION_URL}/notification/send`, { orderId, recipient });
}

/** Compensates authorizePayment: POST {PAYMENT_URL}/payment/refund with { orderId }. */
export async function refundPayment(orderId: string): Promise<void> {
  await post("payment_refund", `${PAYMENT_URL}/payment/refund`, { orderId });
}

/** Compensates reserveInventory: POST {INVENTORY_URL}/inventory/release with { orderId }. */
export async function releaseInventory(orderId: string): Promise<void> {
  await post("inventory_release", `${INVENTORY_URL}/inventory/release`, { orderId });
}