
import express from "express";
import amqp from "amqplib";
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getRetryCount } from "../../shared/pa5-rabbit.ts";
import { startHop, finishHop } from "../../shared/trace.js";

const PORT = Number(process.env.PORT || 8802);
const DATA_DIR = process.env.DATA_DIR || "/data";
const MAX_RETRIES = Number(process.env.MAX_RETRIES || 3);
const CONCURRENCY = Number(process.env.SAGA_CONCURRENCY || 5);
const RUN_ID = randomUUID();
const SAGA_STUCK_AFTER_MS = Number(process.env.SAGA_STUCK_AFTER_MS || 10000);
const TIMEOUT = Number(process.env.REQUEST_TIMEOUT_MS || 2500);

const URLS = {
  payment: process.env.PAYMENT_URL,
  inventory: process.env.INVENTORY_URL,
  shipping: process.env.SHIPPING_URL,
  notification: process.env.NOTIFICATION_URL,
};

mkdirSync(DATA_DIR, { recursive: true });
const storePath = path.join(DATA_DIR, "saga-store.json");

function loadStore() {
  try {
    return JSON.parse(readFileSync(storePath, "utf8"));
  } catch {
    return { sagas: {}, businessKeys: {} };
  }
}

const store = loadStore();

function saveStore() {
  const temp = `${storePath}.tmp`;
  writeFileSync(temp, JSON.stringify(store, null, 2));
  renameSync(temp, storePath);
}

function amount(order) {
  let cents = 0;

  for (const item of order.items) {
    const [whole, fraction] = String(item.unitPrice).split(".");
    cents += (Number(whole) * 100 + Number(fraction || 0)) * item.quantity;
  }

  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

let connection;
let channel;
let connected = false;
let consumerTag = null;

async function publish(exchange, routingKey, body, correlationId, causationId) {
  await new Promise((resolve, reject) => {
    channel.publish(
      exchange,
      routingKey,
      Buffer.from(JSON.stringify(body)),
      {
        persistent: true,
        contentType: "application/json",
        messageId: randomUUID(),
        correlationId,
        headers: { correlationId, causationId },
      },
      (error) => error ? reject(error) : resolve(),
    );
  });
}

async function publishTrace(hop, status = "success") {
  return finishHop(channel, hop, status);
}

async function traceHop(
  correlationId,
  causationId,
  operation,
  attempt = 1,
  status = "success",
  detail,
) {
  const hop = startHop({
    correlationId,
    causationId,
    service: "orchestrator",
    operation,
    attempt,
    detail,
  });

  const record = await publishTrace(hop, status);
  return record.hopId;
}

async function callProvider(
  step,
  endpoint,
  body,
  correlationId,
  key,
  causationId,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Correlation-Id": correlationId,
        "X-Causation-Id": causationId,
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      let code = `${step}_failed`;

      try {
        const data = await response.json();
        if (typeof data.code === "string") code = data.code;
      } catch {
        // The provider may return a non-JSON error response.
      }

      return {
        ok: false,
        temporary: response.status >= 500,
        code,
      };
    }

    return { ok: true };
  } catch {
    return {
      ok: false,
      temporary: true,
      code: controller.signal.aborted ? "timeout" : `${step}_unreachable`,
    };
  } finally {
    clearTimeout(timer);
  }
}

function recordStep(saga, step, status) {
  saga.steps.push({
    step,
    status,
    at: new Date().toISOString(),
  });

  saga.updatedAt = new Date().toISOString();
  saveStore();
}

async function outcome(
  order,
  correlationId,
  businessKey,
  state,
  extra = {},
  causationId = null,
) {
  const terminalStates = [
    "completed",
    "failed",
    "compensated",
    "compensation_failed",
    "needs_attention",
    "duplicate",
  ];

  let outcomeCausationId = causationId;

  if (terminalStates.includes(state)) {
    outcomeCausationId = await traceHop(
      correlationId,
      causationId,
      "saga.outcome",
      1,
      "success",
      { state },
    );
  }

  const envelope = {
    correlationId,
    businessKey,
    orderId: order.orderId,
    source: order.source,
    orderType: order.orderType,
    recipient: order.customer?.email,
    state,
    occurredAt: new Date().toISOString(),
    ...extra,
  };

  const saga = store.sagas[correlationId];
  saga.state = state;

  if (terminalStates.includes(state)) {
    saga.outcome = {
      routingKey: `order.${state}`,
      envelope,
    };
  }

  saga.updatedAt = new Date().toISOString();
  saveStore();

  await publish(
    "orders.outcome",
    `order.${state}`,
    envelope,
    correlationId,
    outcomeCausationId || randomUUID(),
  );
}

async function compensate(
  order,
  correlationId,
  businessKey,
  saga,
  failedCode,
  previousHopId,
) {
  saga.failureCode ??= failedCode;
  saveStore();

  const completed = saga.steps
    .filter((step) => step.status === "success")
    .map((step) => step.step);

  const reverse = [];

  if (completed.includes("inventory")) {
    reverse.push("inventory_release");
  }

  if (completed.includes("payment")) {
    reverse.push("payment_refund");
  }

  let lastHopId = previousHopId;

  for (const step of reverse) {
    if (saga.compensations.some((item) => item.step === step && item.status === "success")) continue;
    const isInventory = step === "inventory_release";

    const endpoint = isInventory
      ? `${URLS.inventory}/inventory/release`
      : `${URLS.payment}/payment/refund`;

    const key = `${isInventory ? "release" : "refund"}:${businessKey}`;

    const stepHop = startHop({
      correlationId,
      causationId: lastHopId,
      service: "orchestrator",
      operation: step,
      attempt: 1,
    });

    const result = await callProvider(
      step,
      endpoint,
      { orderId: order.orderId },
      correlationId,
      key,
      stepHop.hopId,
    );

    await publishTrace(
      stepHop,
      result.ok
        ? "success"
        : result.code === "timeout"
          ? "timeout"
          : "failed",
    );

    lastHopId = stepHop.hopId;

    saga.compensations.push({
      step,
      status: result.ok ? "success" : "failed",
      at: new Date().toISOString(),
    });

    saga.updatedAt = new Date().toISOString();
    saveStore();

    if (!result.ok) {
      await outcome(
        order,
        correlationId,
        businessKey,
        "compensation_failed",
        { code: result.code || failedCode },
        lastHopId,
      );
      return;
    }
  }

  await outcome(
    order,
    correlationId,
    businessKey,
    "compensated",
    { code: failedCode },
    lastHopId,
  );
}

async function markPreviousRunSagas() {
  for (const [correlationId, saga] of Object.entries(store.sagas)) {
    if (saga.state !== "processing" || saga.owner === RUN_ID || saga.outcome) {
      continue;
    }

    try {
      const order = saga.order || {
        orderId: saga.orderId,
        source: saga.source,
        orderType: saga.orderType,
        customer: {},
      };

      saga.stuckAt = new Date().toISOString();
      saveStore();

      const stuckHopId = await traceHop(
        correlationId,
        null,
        "saga.stuck",
        1,
        "success",
      );

      await outcome(
        order,
        correlationId,
        saga.businessKey,
        "needs_attention",
        {},
        stuckHopId,
      );
    } catch (error) {
      console.error("[orchestrator] Could not mark stuck saga:", correlationId, error);
    }
  }
}

async function quarantine(message) {
  await new Promise((resolve, reject) => {
    const options = {
      persistent: true,
      contentType:
        message.properties.contentType || "application/octet-stream",
      messageId: randomUUID(),
      headers: { ...(message.properties.headers || {}) },
    };

    if (message.properties.correlationId) {
      options.correlationId = message.properties.correlationId;
    }

    channel.publish(
      "orders.invalid.exchange",
      "",
      message.content,
      options,
      (error) => error ? reject(error) : resolve(),
    );
  });

  channel.ack(message);
}

async function processOrder(message) {
  let order;

  try {
    order = JSON.parse(message.content.toString("utf8"));

    if (
      !message.properties.headers?.correlationId ||
      !order.orderId ||
      !Array.isArray(order.items) ||
      !["standard", "express", "b2b"].includes(order.orderType)
    ) {
      throw new Error("Invalid order");
    }
  } catch {
    await quarantine(message);
    return;
  }

  const headers = message.properties.headers || {};
  const correlationId = headers.correlationId;
  const businessKey =
    headers.businessKey || `${order.source}:${order.orderId}`;

  const consumeHop = startHop({
    correlationId,
    causationId: headers.causationId || null,
    service: "orchestrator",
    operation: "saga.consume",
    attempt: getRetryCount(message) + 1,
    messageId: message.properties.messageId,
  });

  await publishTrace(consumeHop);

  let previousHopId = consumeHop.hopId;

  const existing = store.sagas[correlationId];

  if (existing?.outcome) {
    const dedupeHopId = await traceHop(
      correlationId,
      previousHopId,
      "saga.dedupe",
      1,
      "duplicate",
    );

    await publish(
      "orders.outcome",
      existing.outcome.routingKey,
      existing.outcome.envelope,
      correlationId,
      dedupeHopId,
    );

    channel.ack(message);
    return;
  }

  if (existing?.state === "processing" && existing.owner !== RUN_ID) {
    channel.ack(message);
    return;
  }

  const duplicateOf = store.businessKeys[businessKey];

  if (duplicateOf && duplicateOf !== correlationId) {
    store.sagas[correlationId] = {
      businessKey,
      order: order,
      orderId: order.orderId,
      source: order.source,
      orderType: order.orderType,
      state: "duplicate",
      steps: [],
      compensations: [],
      owner: RUN_ID,
      updatedAt: new Date().toISOString(),
    };

    saveStore();

    await outcome(
      order,
      correlationId,
      businessKey,
      "duplicate",
      { duplicateOf },
      previousHopId,
    );

    channel.ack(message);
    return;
  }

  let saga = existing;

  if (!saga) {
    saga = {
      businessKey,
      order: order,
      orderId: order.orderId,
      source: order.source,
      orderType: order.orderType,
      state: "processing",
      steps: [],
      compensations: [],
      owner: RUN_ID,
      updatedAt: new Date().toISOString(),
    };

    store.sagas[correlationId] = saga;
    store.businessKeys[businessKey] = correlationId;
    saveStore();
  }

  if (saga.state === "parked") {
    saga.state = "processing";
    saga.updatedAt = new Date().toISOString();
    saveStore();
  }

  await outcome(
    order,
    correlationId,
    businessKey,
    "processing",
    {},
    previousHopId,
  );

  const steps = [];

  if (order.orderType !== "b2b") {
    steps.push("payment");
  }

  steps.push("inventory", "shipping", "notification");

  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    const firstStep = index === 0;

    let endpoint;
    let body;
    let key;

    if (step === "payment") {
      endpoint = `${URLS.payment}/payment/authorize`;
      body = {
        orderId: order.orderId,
        amount: amount(order),
      };
      key = `authorize:${businessKey}`;
    } else if (step === "inventory") {
      endpoint = `${URLS.inventory}/inventory/reserve`;
      body = {
        orderId: order.orderId,
        items: order.items,
      };
      key = `reserve:${businessKey}`;
    } else if (step === "shipping") {
      endpoint = `${URLS.shipping}/shipping/create`;
      body = { orderId: order.orderId };
    } else {
      endpoint = {
        orderId: order.orderId,
        recipient: order.customer.email,
      };
      endpoint = `${URLS.notification}/notification/send`;
      body = {
        orderId: order.orderId,
        recipient: order.customer.email,
      };
    }

    const stepHop = startHop({
      correlationId,
      causationId: previousHopId,
      service: "orchestrator",
      operation: step,
      attempt: getRetryCount(message) + 1,
    });

    const result = await callProvider(
      step,
      endpoint,
      body,
      correlationId,
      key,
      stepHop.hopId,
    );

    await publishTrace(
      stepHop,
      result.ok
        ? "success"
        : result.code === "timeout"
          ? "timeout"
          : "failed",
    );

    previousHopId = stepHop.hopId;

    recordStep(saga, step, result.ok ? "success" : "failed");

    if (!result.ok) {
      if (firstStep && result.temporary) {
        const attempts = getRetryCount(message);

        if (attempts < MAX_RETRIES) {
          await traceHop(
            correlationId,
            previousHopId,
            "saga.retry",
            attempts + 1,
            "retried",
            { error: result.code },
          );

          channel.nack(message, false, false);
          return;
        }

        const deadLetterHopId = await traceHop(
          correlationId,
          previousHopId,
          "saga.dead_letter",
          attempts + 1,
          "dead_lettered",
          { error: result.code },
        );

        await outcome(
          order,
          correlationId,
          businessKey,
          "parked",
          { code: result.code },
          deadLetterHopId,
        );

        await publish(
          "orders.dlq.exchange",
          "",
          {
            original: message.content.toString("base64"),
            originQueue: "saga.queue",
            correlationId,
            messageId: message.properties.messageId || randomUUID(),
            headers: message.properties.headers || {},
            attempts: getRetryCount(message) + 1,
            lastError: result.code,
            deadLetteredAt: new Date().toISOString(),
          },
          correlationId,
          deadLetterHopId,
        );

        channel.ack(message);
        return;
      }

      if (firstStep) {
        await outcome(
          order,
          correlationId,
          businessKey,
          "failed",
          { code: result.code },
          previousHopId,
        );
      } else {
        await compensate(
          order,
          correlationId,
          businessKey,
          saga,
          result.code,
          previousHopId,
        );
      }

      channel.ack(message);
      return;
    }
  }

  await outcome(
    order,
    correlationId,
    businessKey,
    "completed",
    {},
    previousHopId,
  );

  channel.ack(message);
}

async function start() {
  connection = await amqp.connect(process.env.RABBITMQ_URL);
  channel = await connection.createConfirmChannel();

  await channel.prefetch(CONCURRENCY);

  setTimeout(() => void markPreviousRunSagas(), SAGA_STUCK_AFTER_MS);

  connection.on("close", () => {
    connected = false;
    console.error("[orchestrator] RabbitMQ connection closed");
  });

  channel.on("close", () => {
    connected = false;
    consumerTag = null;
  });

  const result = await channel.consume("saga.queue", (message) => {
    if (message) {
      void processOrder(message).catch((error) => {
        console.error("[orchestrator] Saga error:", error);

        try {
          channel.nack(message, false, true);
        } catch {
          // The channel may already be closed.
        }
      });
    }
  });

  consumerTag = result.consumerTag;
  connected = true;

  console.log("[orchestrator] Consuming saga.queue");

  const app = express();

  app.get("/health", (_req, res) => {
    const healthy = connected && Boolean(consumerTag);

    res.status(healthy ? 200 : 503).json({
      status: healthy ? "ok" : "degraded",
      checks: {
        broker: healthy ? "up" : "down",
        consumers: {
          "saga.queue": healthy ? 1 : 0,
        },
      },
    });
  });

  app.post("/sagas/:correlationId/compensate", async (req, res) => {
    const { correlationId } = req.params;
    const saga = store.sagas[correlationId];

    if (!saga) {
      return res.status(404).json({ code: "not_found" });
    }

    if (saga.operatorCompensation?.status === "running") {
      return res.status(409).json({ code: "compensation_in_progress" });
    }

    if (
      saga.state === "compensated" &&
      saga.operatorCompensation?.response
    ) {
      return res.json(saga.operatorCompensation.response);
    }

    if (!["needs_attention", "compensation_failed"].includes(saga.state)) {
      return res.status(409).json({ code: "saga_not_stuck" });
    }

    const order = saga.order || {
      orderId: saga.orderId,
      source: saga.source,
      orderType: saga.orderType,
      customer: {},
    };

    saga.operatorCompensation = {
      status: "running",
      startedAt: new Date().toISOString(),
    };
    saveStore();

    try {
      const hopId = await traceHop(
        correlationId,
        null,
        "saga.operator_compensate",
        1,
        "success",
      );

      const failureCode =
        saga.state === "needs_attention"
          ? "operator_compensated"
          : saga.failureCode || saga.outcome?.envelope?.code || "operator_compensated";

      await compensate(
        order,
        correlationId,
        saga.businessKey,
        saga,
        failureCode,
        hopId,
      );

      const response = {
        correlationId,
        state: saga.state,
      };

      saga.operatorCompensation = {
        status: saga.state === "compensated" ? "completed" : "failed",
        startedAt: saga.operatorCompensation.startedAt,
        finishedAt: new Date().toISOString(),
        response,
      };
      saveStore();

      return res.json(response);
    } catch (error) {
      saga.operatorCompensation.status = "failed";
      saga.operatorCompensation.error = String(error.message || error);
      saveStore();
      console.error("[orchestrator] Operator compensation failed:", error);
      return res.status(500).json({ code: "compensation_error" });
    }
  });

  app.get("/sagas/stuck", (_req, res) => {
    const sagas = Object.entries(store.sagas)
      .filter(([, saga]) =>
        ["needs_attention", "compensation_failed"].includes(saga.state),
      )
      .map(([correlationId, saga]) => ({
        correlationId,
        businessKey: saga.businessKey,
        state: saga.state,
        completedSteps: saga.steps
          .filter((step) => step.status === "success")
          .map((step) => step.step),
        compensatedSteps: saga.compensations
          .filter((item) => item.status === "success")
          .map((item) => item.step),
        since: saga.stuckAt || saga.updatedAt,
      }));

    res.json({ sagas });
  });

  app.get("/orders/:id", (req, res) => {
    const saga = store.sagas[req.params.id];

    if (!saga) {
      return res.status(404).json({ code: "not_found" });
    }

    res.json({
      correlationId: req.params.id,
      ...saga,
    });
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[orchestrator] Listening on ${PORT}`);
  });
}

start().catch((error) => {
  console.error("[orchestrator] Startup failed:", error);
  process.exit(1);
});
