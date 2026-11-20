import express from "express";
import amqp from "amqplib";
import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  appendFileSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT || 8803);
const DATA_DIR = process.env.DATA_DIR || "/data";
const MAX_RETRIES = Number(process.env.MAX_RETRIES || 3);
const TIMEOUT = Number(process.env.REQUEST_TIMEOUT_MS || 2500);
const NOTIFICATION_URL = process.env.NOTIFICATION_URL;

mkdirSync(DATA_DIR, { recursive: true });

const idsPath = path.join(DATA_DIR, "processed-ids.json");
const logPath = path.join(DATA_DIR, "notification.log");

function loadIds() {
  try {
    return JSON.parse(readFileSync(idsPath, "utf8"));
  } catch {
    return {};
  }
}

const processed = loadIds();
const inFlight = new Set();

function saveIds() {
  const temp = `${idsPath}.tmp`;
  writeFileSync(temp, JSON.stringify(processed, null, 2));
  renameSync(temp, idsPath);
}

let connection;
let channel;
let connected = false;

function confirmPublish(exchange, routingKey, content, options) {
  return new Promise((resolve, reject) => {
    channel.publish(exchange, routingKey, content, options, (error) =>
      error ? reject(error) : resolve(),
    );
  });
}

async function quarantine(message) {
  await confirmPublish(
    "orders.invalid.exchange",
    "",
    message.content,
    {
      persistent: true,
      contentType: message.properties.contentType || "application/octet-stream",
      messageId: randomUUID(),
      correlationId: message.properties.correlationId,
      headers: { ...(message.properties.headers || {}) },
    },
  );
  channel.ack(message);
}

async function sendNotice(event, correlationId, causationId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);

  try {
    const response = await fetch(`${NOTIFICATION_URL}/notification/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Correlation-Id": correlationId,
        "X-Causation-Id": causationId,
      },
      body: JSON.stringify({
        orderId: event.orderId,
        recipient: event.recipient,
        kind: "order_not_completed",
        reason: event.code || "order_not_completed",
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      let code = `notification_http_${response.status}`;
      try {
        const body = await response.json();
        if (typeof body.code === "string") code = body.code;
      } catch {}
      throw new Error(code);
    }
  } finally {
    clearTimeout(timer);
  }
}

function retryCount(message) {
  const deaths = message.properties.headers?.["x-death"];
  if (!Array.isArray(deaths)) return 0;
  return deaths
    .filter((entry) => entry?.reason === "rejected")
    .reduce((sum, entry) => sum + (Number(entry.count) || 0), 0);
}

async function deadLetter(message, event, correlationId, error, attempts) {
  const headers = { ...(message.properties.headers || {}) };
  await confirmPublish(
    "orders.dlq.exchange",
    "",
    Buffer.from(JSON.stringify({
      original: message.content.toString("base64"),
      originQueue: "notifications.queue",
      correlationId,
      messageId: message.properties.messageId || null,
      headers,
      attempts,
      lastError: String(error.message || error),
      deadLetteredAt: new Date().toISOString(),
    })),
    {
      persistent: true,
      contentType: "application/json",
      messageId: randomUUID(),
      correlationId,
      headers: {
        ...headers,
        correlationId,
        causationId: randomUUID(),
      },
    },
  );
  channel.ack(message);
}

async function processMessage(message) {
  let event;
  try {
    event = JSON.parse(message.content.toString("utf8"));
    if (
      !event ||
      typeof event !== "object" ||
      !event.correlationId ||
      !event.orderId ||
      !event.recipient ||
      !["failed", "compensated"].includes(event.state)
    ) {
      throw new Error("Invalid notification event");
    }
  } catch {
    await quarantine(message);
    return;
  }

  const correlationId = event.correlationId;

  if (processed[correlationId]) {
    channel.ack(message);
    return;
  }

  if (inFlight.has(correlationId)) {
    channel.nack(message, false, true);
    return;
  }

  inFlight.add(correlationId);

  try {
    await sendNotice(
      event,
      correlationId,
      randomUUID(),
    );

    processed[correlationId] = {
      orderId: event.orderId,
      processedAt: new Date().toISOString(),
    };
    saveIds();

    appendFileSync(
      logPath,
      JSON.stringify({
        correlationId,
        orderId: event.orderId,
        recipient: event.recipient,
        kind: "order_not_completed",
        reason: event.code || "order_not_completed",
        sentAt: new Date().toISOString(),
      }) + "\n",
    );

    channel.ack(message);
  } catch (error) {
    const attempts = retryCount(message) + 1;
    console.error("[notifier] Send failed:", error.message);

    if (attempts < MAX_RETRIES) {
      channel.nack(message, false, false);
    } else {
      await deadLetter(message, event, correlationId, error, attempts);
    }
  } finally {
    inFlight.delete(correlationId);
  }
}

async function start() {
  connection = await amqp.connect(process.env.RABBITMQ_URL);
  channel = await connection.createConfirmChannel();
  await channel.prefetch(1);

  connection.on("close", () => {
    connected = false;
    console.error("[notifier] RabbitMQ connection closed");
  });

  channel.on("close", () => {
    connected = false;
  });

  await channel.consume("notifications.queue", (message) => {
    if (message) {
      void processMessage(message).catch((error) => {
        console.error("[notifier] Consumer error:", error);
        try {
          channel.nack(message, false, true);
        } catch {}
      });
    }
  });

  connected = true;

  const app = express();
  app.get("/health", (_req, res) => {
    res.status(connected ? 200 : 503).json({
      status: connected ? "ok" : "degraded",
      checks: {
        broker: connected ? "up" : "down",
        consumers: { "notifications.queue": connected ? 1 : 0 },
      },
    });
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[notifier] Listening on ${PORT}`);
  });
}

start().catch((error) => {
  console.error("[notifier] Startup failed:", error);
  process.exit(1);
});
