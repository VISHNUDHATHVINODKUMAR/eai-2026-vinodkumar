/**
 * The six activities — YOURS TO WRITE.
 *
 * An activity is ordinary Node code: it may do I/O, read the environment and
 * fail. Each one here makes one HTTP call to one mock service, exactly the
 * calls your PA6 orchestrator made. README.md §4 has the table.
 *
 * What an activity must add is a decision the PA6 orchestrator never had to
 * make: when a call fails, may Temporal try it again?
 *
 *   - A 4xx is the service saying no (payment_declined, inventory_unavailable).
 *     It will say no again. Throw ApplicationFailure.nonRetryable(message, code)
 *     with the mock's own `code` from the response body as the type.
 *   - No answer at all, or a 5xx, is temporary. Throw
 *     ApplicationFailure.retryable(message, code), or any ordinary Error, and
 *     the retry policy may try again.
 *   - A call that takes too long you do not handle here: Temporal fails the
 *     attempt itself when startToCloseTimeout runs out.
 *
 * The signatures are fixed: the workflow calls these by name, with these
 * arguments. Keep them.
 */
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

/** POST {PAYMENT_URL}/payment/authorize with { orderId, amount }. */
export async function authorizePayment(orderId: string, amount: string): Promise<void> {
  throw new Error(`TODO: authorizePayment is not implemented (${PAYMENT_URL})`);
}

/** POST {INVENTORY_URL}/inventory/reserve with { orderId, items }. */
export async function reserveInventory(orderId: string, items: CanonicalItem[]): Promise<void> {
  throw new Error(`TODO: reserveInventory is not implemented (${INVENTORY_URL})`);
}

/** POST {SHIPPING_URL}/shipping/create with { orderId }. */
export async function createShipment(orderId: string): Promise<void> {
  throw new Error(`TODO: createShipment is not implemented (${SHIPPING_URL})`);
}

/** POST {NOTIFICATION_URL}/notification/send with { orderId, recipient }. */
export async function sendNotification(orderId: string, recipient: string): Promise<void> {
  throw new Error(`TODO: sendNotification is not implemented (${NOTIFICATION_URL})`);
}

/** Compensates authorizePayment: POST {PAYMENT_URL}/payment/refund with { orderId }. */
export async function refundPayment(orderId: string): Promise<void> {
  throw new Error(`TODO: refundPayment is not implemented (${PAYMENT_URL})`);
}

/** Compensates reserveInventory: POST {INVENTORY_URL}/inventory/release with { orderId }. */
export async function releaseInventory(orderId: string): Promise<void> {
  throw new Error(`TODO: releaseInventory is not implemented (${INVENTORY_URL})`);
}
