/**
 * The checkout workflow — YOURS TO WRITE.
 *
 * This is your PA6 saga, ported: the same four steps, the same reverse-order
 * compensation, the same outcomes (README.md §4). What you no longer write is
 * everything PA6 made you build around it — the timeout plumbing, the retry
 * loop, the in-progress record and the "where was I?" state. Temporal keeps
 * every step's result in the workflow's history.
 *
 * Workflow code runs in Temporal's deterministic sandbox, and is replayed
 * from that history whenever a worker has to rebuild the workflow's state:
 *
 *   - No I/O here. No fetch, no axios, no fs, no process.env. Every call to
 *     the outside world is an activity, through `act` below.
 *   - Import only types from ../activities, never the functions themselves.
 *   - `new Date()` is fine: inside a workflow it returns the workflow's own
 *     time, which is the same on every replay. Use it for the trace.
 *
 * An activity that fails for good reaches you as an ActivityFailure. Its
 * `cause` says why: a TimeoutFailure when the attempts timed out, or an
 * ApplicationFailure whose `type` is the code your activity threw.
 */
import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";
import type { CanonicalOrder, CheckoutResult } from "../types";

// TODO (student): add the retry policy from README.md §4. Without one,
// Temporal retries a failing activity forever.
const act = proxyActivities<typeof activities>({
  startToCloseTimeout: "2500 ms",
});

export async function checkout(order: CanonicalOrder): Promise<CheckoutResult> {
  // TODO (student): the saga.
  //   1) act.authorizePayment(orderId, amount)   amount: as in PA6, a two-digit
  //                                              decimal string summed in cents
  //   2) act.reserveInventory(orderId, items)
  //   3) act.createShipment(orderId)
  //   4) act.sendNotification(orderId, customer.email)
  // On a failure, compensate what completed, newest first:
  //   act.releaseInventory(orderId), then act.refundPayment(orderId).
  // Record every call in the trace, and return a CheckoutResult for every
  // outcome — success and failure alike. Do not throw.
  return { orderId: order.orderId, status: "failed", code: "not_implemented", trace: [] };
}
