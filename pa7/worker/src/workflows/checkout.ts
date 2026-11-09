import {
  proxyActivities,
  ActivityFailure,
  ApplicationFailure,
  TimeoutFailure,
} from "@temporalio/workflow";
import type * as activities from "../activities";
import type { CanonicalItem, CanonicalOrder, CheckoutResult, TraceItem } from "../types";

// The retry policy from the README: three attempts, 200 ms, doubling.
const act = proxyActivities<typeof activities>({
  startToCloseTimeout: "2500 ms",
  retry: {
    maximumAttempts: 3,
    initialInterval: "200 ms",
    backoffCoefficient: 2,
  },
});

// ------------------------------------------------------------------ money --
// Ported from PA6: whole cents as integers, formatted once at the end.

function priceToCents(price: string): number {
  let text = price;
  let sign = 1;
  if (text.startsWith("-")) {
    sign = -1;
    text = text.slice(1);
  }
  const parts = text.split(".");
  const whole = Number(parts[0]);
  const fraction = Number(parts[1] ?? "0");
  return sign * (whole * 100 + fraction);
}

function centsToAmount(totalCents: number): string {
  let sign = "";
  let cents = totalCents;
  if (cents < 0) {
    sign = "-";
    cents = -cents;
  }
  const whole = Math.floor(cents / 100);
  const fraction = cents % 100;
  return `${sign}${whole}.${String(fraction).padStart(2, "0")}`;
}

function computeAmount(items: CanonicalItem[]): string {
  let totalCents = 0;
  for (const item of items) {
    totalCents += priceToCents(item.unitPrice) * item.quantity;
  }
  return centsToAmount(totalCents);
}

// ------------------------------------------------------------------ steps --

interface StepOutcome {
  ok: boolean;
  status: string; // success | failed | timeout
  code: string;
}

// Runs one activity and records exactly one trace entry (not one per attempt).
async function runStep(step: string, trace: TraceItem[], call: () => Promise<void>): Promise<StepOutcome> {
  const startedAt = new Date();
  let outcome: StepOutcome = { ok: true, status: "success", code: "" };

  try {
    await call();
  } catch (err) {
    if (err instanceof ActivityFailure && err.cause instanceof TimeoutFailure) {
      outcome = { ok: false, status: "timeout", code: "timeout" };
    } else if (err instanceof ActivityFailure && err.cause instanceof ApplicationFailure) {
      outcome = { ok: false, status: "failed", code: err.cause.type ?? `${step}_failed` };
    } else {
      outcome = { ok: false, status: "failed", code: `${step}_failed` };
    }
  }

  const finishedAt = new Date();
  trace.push({
    step,
    status: outcome.status,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
  });

  return outcome;
}

export async function checkout(order: CanonicalOrder): Promise<CheckoutResult> {
  const orderId = order.orderId;
  const trace: TraceItem[] = [];
  const amount = computeAmount(order.items);
  const recipient = order.customer.email;

  const forwardSteps = [
    { step: "payment", call: () => act.authorizePayment(orderId, amount) },
    { step: "inventory", call: () => act.reserveInventory(orderId, order.items) },
    { step: "shipping", call: () => act.createShipment(orderId) },
    { step: "notification", call: () => act.sendNotification(orderId, recipient) },
  ];

  // Strictly one after another. Stop at the first step that fails for good.
  const completed: string[] = [];
  let failure: StepOutcome | null = null;
  let failedStep = "";

  for (const forward of forwardSteps) {
    const outcome = await runStep(forward.step, trace, forward.call);
    if (outcome.ok) {
      completed.push(forward.step);
    } else {
      failure = outcome;
      failedStep = forward.step;
      break;
    }
  }

  if (failure === null) {
    return { orderId, status: "completed", trace };
  }

  // Compensate what completed, newest first. Shipping and notification
  // have nothing to undo.
  let compensationFailed = false;

  if (completed.includes("inventory")) {
    const release = await runStep("inventory_release", trace, () => act.releaseInventory(orderId));
    if (!release.ok) {
      compensationFailed = true;
    }
  }
  if (completed.includes("payment")) {
    const refund = await runStep("payment_refund", trace, () => act.refundPayment(orderId));
    if (!refund.ok) {
      compensationFailed = true;
    }
  }

  if (compensationFailed) {
    return { orderId, status: "failed", code: "compensation_failed", trace };
  }

  // Payment failed: nothing was done, so "failed". Later step: "compensated".
  const status = failedStep === "payment" ? "failed" : "compensated";
  return { orderId, status, code: failure.code, trace };
}