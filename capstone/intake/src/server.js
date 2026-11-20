
import express from "express";
import amqp from "amqplib";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
} from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { translateRequest, detectSource } from "./translator.js";
import { startHop, finishHop } from "../../shared/trace.js";

const app = express();
app.use(express.raw({ type: () => true, limit: "2mb" }));

const PORT = Number(process.env.PORT || 8800);
const DATA_DIR = process.env.DATA_DIR || "/data";
const MAX_ITEMS = Number(process.env.ORDER_ITEMS_MAX || 50);
const PRICING_URL = process.env.PRICING_URL || "http://pricing:4100";
const PRICING_API_KEY = process.env.PRICING_API_KEY || "pa4-pricing-key-2026";
const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL || "http://orchestrator:8802";

mkdirSync(DATA_DIR, { recursive: true });

const idempotencyPath = path.join(DATA_DIR, "idempotency.json");
const ordersPath = path.join(DATA_DIR, "orders.json");
const dlqPath = path.join(DATA_DIR, "dlq-entries.json");

function loadStore(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function saveStore(file, data) {
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, JSON.stringify(data, null, 2));
  renameSync(temporary, file);
}

const idempotency = loadStore(idempotencyPath);
const orders = loadStore(ordersPath);
const inFlight = new Map();

let dlqEntries = (() => {
  try {
    return JSON.parse(readFileSync(dlqPath, "utf8"));
  } catch {
    return [];
  }
})();

let dlqConnection;
let dlqChannel;
let brokerConnection;
let publisher;
let server;

let brokerConnecting = null;
let dlqConnecting = null;
let brokerReconnectTimer = null;
let dlqReconnectTimer = null;
let dlqConsumerTag = null;
let shuttingDown = false;

function saveDlq() {
  const temporary = `${dlqPath}.tmp`;
  writeFileSync(temporary, JSON.stringify(dlqEntries, null, 2));
  renameSync(temporary, dlqPath);
}

function scheduleBrokerReconnect() {
  if (shuttingDown || brokerReconnectTimer) return;

  brokerReconnectTimer = setTimeout(() => {
    brokerReconnectTimer = null;
    connectBroker().catch((error) => {
      console.error("[intake] Publisher reconnect failed:", error.message);
    });
  }, 3000);
}

async function connectBroker() {
  if (publisher) return publisher;
  if (brokerConnecting) return brokerConnecting;

  brokerConnecting = (async () => {
    let newConnection;

    try {
      newConnection = await amqp.connect(process.env.RABBITMQ_URL);
      const newPublisher = await newConnection.createConfirmChannel();

      brokerConnection = newConnection;
      publisher = newPublisher;

      newConnection.on("close", () => {
        if (brokerConnection !== newConnection) return;

        brokerConnection = null;
        publisher = null;
        scheduleBrokerReconnect();
      });

      newConnection.on("error", (error) => {
        console.error("[intake] Publisher connection error:", error.message);
      });

      newPublisher.on("close", () => {
        if (publisher !== newPublisher) return;

        publisher = null;
        scheduleBrokerReconnect();
      });

      return newPublisher;
    } catch (error) {
      try {
        await newConnection?.close();
      } catch {}
      throw error;
    }
  })();

  try {
    return await brokerConnecting;
  } catch (error) {
    scheduleBrokerReconnect();
    throw error;
  } finally {
    brokerConnecting = null;
  }
}

async function publishTrace(hop, status = "success") {
  const channel = await connectBroker();
  return finishHop(channel, hop, status);
}

function scheduleDlqReconnect() {
  if (shuttingDown || dlqReconnectTimer) return;

  dlqReconnectTimer = setTimeout(() => {
    dlqReconnectTimer = null;
    startDlqConsumer().catch((error) => {
      console.error("[intake] DLQ reconnect failed:", error.message);
    });
  }, 3000);
}

async function startDlqConsumer() {
  if (dlqChannel && dlqConsumerTag) return;
  if (dlqConnecting) return dlqConnecting;

  dlqConnecting = (async () => {
    const newConnection = await amqp.connect(process.env.RABBITMQ_URL);
    let newChannel;

    try {
      newChannel = await newConnection.createChannel();
      await newChannel.prefetch(10);

      const result = await newChannel.consume("orders.dlq", (message) => {
        if (!message) return;

        try {
          const data = JSON.parse(message.content.toString("utf8"));
          const messageHeaders = message.properties.headers || {};
          const originQueue =
            data.originQueue || messageHeaders.originQueue;

          if (!["saga.queue", "notifications.queue"].includes(originQueue)) {
            console.error("[intake] Ignoring invalid DLQ origin:", originQueue);
            newChannel.ack(message);
            return;
          }

          const correlationId =
            data.correlationId ||
            data.headers?.correlationId ||
            messageHeaders.correlationId ||
            message.properties.correlationId;

          const entry = {
            id: randomUUID(),
            messageId: data.messageId || message.properties.messageId || randomUUID(),
            correlationId: correlationId || "",
            originQueue,
            attempts: Number(data.attempts) || 1,
            lastError: String(
              data.lastError || messageHeaders.lastError || "unknown_error",
            ),
            deadLetteredAt: data.deadLetteredAt || new Date().toISOString(),
            original:
              data.original || message.content.toString("base64"),
            headers: {
              ...messageHeaders,
              ...(data.headers || {}),
            },
          };

          if (!entry.correlationId) {
            console.error("[intake] Ignoring incomplete DLQ entry");
            newChannel.ack(message);
            return;
          }

          dlqEntries.push(entry);
          saveDlq();
          newChannel.ack(message);
        } catch (error) {
          console.error("[intake] Could not store DLQ message:", error.message);
          try {
            newChannel.nack(message, false, true);
          } catch {}
        }
      });

      dlqConnection = newConnection;
      dlqChannel = newChannel;
      dlqConsumerTag = result.consumerTag;

      newConnection.on("close", () => {
        if (dlqConnection !== newConnection) return;

        dlqConnection = null;
        dlqChannel = null;
        dlqConsumerTag = null;
        scheduleDlqReconnect();
      });

      newConnection.on("error", (error) => {
        console.error("[intake] DLQ connection error:", error.message);
      });

      newChannel.on("close", () => {
        if (dlqChannel !== newChannel) return;

        dlqChannel = null;
        dlqConsumerTag = null;
        scheduleDlqReconnect();
      });

      console.log("[intake] Consuming orders.dlq");
    } catch (error) {
      try {
        await newConnection.close();
      } catch {}
      throw error;
    }
  })();

  try {
    await dlqConnecting;
  } catch (error) {
    scheduleDlqReconnect();
    throw error;
  } finally {
    dlqConnecting = null;
  }
}

const schema = JSON.parse(
  readFileSync("/canonical/order.schema.json", "utf8"),
);
const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const validateOrder = ajv.compile(schema);

async function publishOrder(order, correlationId, causationId, businessKey) {
  const channel = await connectBroker();
  const messageId = randomUUID();

  await new Promise((resolve, reject) => {
    channel.publish(
      "orders.exchange",
      "",
      Buffer.from(JSON.stringify(order)),
      {
        persistent: true,
        contentType: "application/json",
        messageId,
        correlationId,
        headers: { correlationId, causationId, businessKey },
      },
      (error) => error ? reject(error) : resolve(),
    );
  });

  return messageId;
}

function replyError(res, status, code, extra = {}) {
  return res.status(status).json({ code, ...extra });
}

app.get("/health", (_req, res) => {
  const publisherReady = Boolean(publisher);
  const dlqReady = Boolean(dlqChannel && dlqConsumerTag);
  const healthy = publisherReady && dlqReady;

  return res.status(healthy ? 200 : 503).json({
    status: healthy ? "ok" : "degraded",
    checks: {
      broker: healthy ? "up" : "down",
      consumers: {
        "orders.dlq": dlqReady ? 1 : 0,
      },
    },
  });
});

app.post("/orders", async (req, res) => {
  const body = req.body;

  if (!Buffer.isBuffer(body) || body.length === 0) {
    return replyError(res, 400, "validation_error");
  }

  const key = req.get("Idempotency-Key");
  if (!key || !/^[A-Za-z0-9._:-]{1,128}$/.test(key)) {
    return replyError(res, 400, "validation_error");
  }

  const hash = createHash("sha256").update(body).digest("hex");

  const existing = idempotency[key];
  if (existing) {
    if (existing.hash !== hash) {
      return replyError(res, 409, "idempotency_payload_mismatch");
    }
    return res.status(existing.status).json(existing.body);
  }

  if (inFlight.has(key)) {
    if (inFlight.get(key) !== hash) {
      return replyError(res, 409, "idempotency_payload_mismatch");
    }
    return replyError(res, 409, "idempotency_conflict");
  }

  inFlight.set(key, hash);

  try {
    const correlationId = randomUUID();

    const receiveHop = startHop({
      correlationId,
      causationId: null,
      service: "intake",
      operation: "intake.receive",
      detail: { contentType: req.get("Content-Type") || "" },
    });
    await publishTrace(receiveHop);

    const source = detectSource(req.get("Content-Type"), body);

    const result = await translateRequest(source, body, {
      pricingBaseUrl: PRICING_URL,
      apiKey: PRICING_API_KEY,
      now: () => new Date(),
    });

    const translateHop = startHop({
      correlationId,
      causationId: receiveHop.hopId,
      service: "intake",
      operation: "intake.translate",
    });
    await publishTrace(translateHop);

    if (result.unknownProducts?.length) {
      const responseBody = {
        code: "unknown_product",
        productIds: result.unknownProducts,
      };
      idempotency[key] = { hash, status: 422, body: responseBody };
      saveStore(idempotencyPath, idempotency);
      return res.status(422).json(responseBody);
    }

    const order = result.order;

    if (
      !order ||
      !Array.isArray(order.items) ||
      order.items.length > MAX_ITEMS ||
      !validateOrder(order)
    ) {
      return replyError(res, 400, "validation_error");
    }

    const businessKey = `${source}:${order.orderId}`;

    const publishHop = startHop({
      correlationId,
      causationId: translateHop.hopId,
      service: "intake",
      operation: "intake.publish",
    });
    await publishTrace(publishHop);

    try {
      await publishOrder(order, correlationId, publishHop.hopId, businessKey);
    } catch (error) {
      console.error("[intake] Publish failed:", error.message);
      res.set("Retry-After", "2");
      return replyError(res, 503, "broker_unavailable");
    }

    const responseBody = { correlationId, status: "accepted" };

    idempotency[key] = { hash, status: 202, body: responseBody };
    orders[correlationId] = order;

    saveStore(idempotencyPath, idempotency);
    saveStore(ordersPath, orders);

    return res.status(202).json(responseBody);
  } catch (error) {
    if (error.code === "unsupported_media_type") {
      return replyError(res, 415, error.code);
    }

    if (error.code === "pricing_unavailable") {
      res.set("Retry-After", "2");
      return replyError(res, 503, error.code);
    }

    console.error("[intake] Validation/translation error:", error.message);
    return replyError(res, 400, "validation_error");
  } finally {
    inFlight.delete(key);
  }
});

app.get("/orders/:correlationId", async (req, res) => {
  const correlationId = req.params.correlationId;
  const order = orders[correlationId];
  if (!order) return replyError(res, 404, "not_found");

  const base = {
    correlationId,
    businessKey: `${order.source}:${order.orderId}`,
    orderId: order.orderId,
    source: order.source,
    orderType: order.orderType,
    state: "accepted",
    updatedAt: order.receivedAt,
  };

  try {
    const response = await fetch(`${ORCHESTRATOR_URL}/orders/${correlationId}`);
    if (response.ok) {
      const saga = await response.json();
      return res.json({
        ...base,
        state: saga.state,
        updatedAt: saga.updatedAt,
        ...(saga.outcome?.envelope?.code ? { code: saga.outcome.envelope.code } : {}),
        ...(saga.outcome?.envelope?.duplicateOf ? { duplicateOf: saga.outcome.envelope.duplicateOf } : {}),
      });
    }
  } catch (error) {
    console.error("[intake] Orchestrator status unavailable:", error.message);
  }

  return res.json(base);
});

app.get("/dlq", (_req, res) => {
  const entries = dlqEntries.map((entry) => ({
    messageId: entry.messageId,
    correlationId: entry.correlationId,
    originQueue: entry.originQueue,
    attempts: entry.attempts,
    lastError: entry.lastError,
    deadLetteredAt: entry.deadLetteredAt,
  }));
  res.json({ count: entries.length, entries });
});

app.post("/dlq/replay", async (req, res) => {
  let body = {};
  try {
    if (Buffer.isBuffer(req.body) && req.body.length) {
      body = JSON.parse(req.body.toString("utf8"));
    }
  } catch {
    return replyError(res, 400, "validation_error");
  }

  if (body.correlationId !== undefined &&
      typeof body.correlationId !== "string") {
    return replyError(res, 400, "validation_error");
  }

  try {
    const channel = await connectBroker();
    let replayed = 0;
    const selected = dlqEntries.filter((entry) =>
      !body.correlationId || entry.correlationId === body.correlationId
    );

    for (const entry of selected) {
      const headers = { ...(entry.headers || {}) };
      for (const key of Object.keys(headers)) {
        if (
          key === "x-death" ||
          key.startsWith("x-first-death") ||
          key.startsWith("x-last-death")
        ) {
          delete headers[key];
        }
      }

      const replayHop = startHop({
        correlationId: entry.correlationId,
        causationId: headers.causationId || null,
        service: "intake",
        operation: "dlq.replay",
      });
      await publishTrace(replayHop);

      headers.correlationId = entry.correlationId;
      headers.causationId = replayHop.hopId;

      const original = Buffer.from(entry.original, "base64");

      await new Promise((resolve, reject) => {
        channel.publish(
          "orders.return.exchange",
          entry.originQueue,
          original,
          {
            persistent: true,
            contentType: "application/json",
            messageId: randomUUID(),
            correlationId: entry.correlationId,
            headers,
          },
          (error) => error ? reject(error) : resolve(),
        );
      });

      dlqEntries = dlqEntries.filter((item) => item.id !== entry.id);
      saveDlq();
      replayed++;
    }

    return res.json({ replayed, remaining: dlqEntries.length });
  } catch (error) {
    console.error("[intake] DLQ replay failed:", error.message);
    return replyError(res, 503, "broker_unavailable");
  }
});

async function start() {
  server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`[intake] Listening on ${PORT}`);
  });

  connectBroker().catch((error) => {
    console.error("[intake] Initial publisher connection failed:", error.message);
  });

  startDlqConsumer().catch((error) => {
    console.error("[intake] Initial DLQ connection failed:", error.message);
  });
}

async function shutdown() {
  shuttingDown = true;
  clearTimeout(brokerReconnectTimer);
  clearTimeout(dlqReconnectTimer);

  server?.close();

  try {
    await brokerConnection?.close();
  } catch {}

  try {
    await dlqConnection?.close();
  } catch {}

  process.exit(0);
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

start();
