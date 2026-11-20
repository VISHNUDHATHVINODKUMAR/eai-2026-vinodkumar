
import express from "express";
import amqp from "amqplib";
import fs from "node:fs";
import path from "node:path";

const PORT = Number(process.env.PORT || 8801);
const DATA_DIR = process.env.DATA_DIR || "/data";
const TRACE_FILE = path.join(DATA_DIR, "trace-store.jsonl");
const QUEUES = [
  "saga.queue",
  "notifications.queue",
  "orders.dlq",
  "orders.invalid",
  "trace.store",
];
const LAG_THRESHOLD = 5;

fs.mkdirSync(DATA_DIR, { recursive: true });

let connection;
let channel;
let connected = false;

async function connect() {
  connection = await amqp.connect(process.env.RABBITMQ_URL);
  channel = await connection.createChannel();
  await channel.consume("trace.store", (message) => {
    if (!message) return;
    try {
      const hop = JSON.parse(message.content.toString("utf8"));
      fs.appendFileSync(TRACE_FILE, JSON.stringify(hop) + "\n");
      channel.ack(message);
    } catch (error) {
      console.error("[observer] Trace event error:", error.message);
      channel.nack(message, false, false);
    }
  });
  connected = true;
  connection.on("close", () => {
    connected = false;
    console.error("[observer] RabbitMQ connection closed");
  });
}

const app = express();

app.get("/health", (_req, res) => {
  const healthy = connected && channel;
  res.status(healthy ? 200 : 503).json({
    status: healthy ? "ok" : "degraded",
    checks: {
      broker: connected ? "up" : "down",
      consumers: { "trace.store": healthy ? 1 : 0 },
    },
  });
});

app.get("/trace/:correlationId", (req, res) => {
  if (!fs.existsSync(TRACE_FILE)) {
    return res.status(404).json({ error: "trace_not_found" });
  }

  const hops = fs.readFileSync(TRACE_FILE, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter((hop) => hop?.correlationId === req.params.correlationId)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));

  if (hops.length === 0) {
    return res.status(404).json({ error: "trace_not_found" });
  }

  res.json({ correlationId: req.params.correlationId, hops });
});

async function queueStats(queue) {
  const result = await channel.checkQueue(queue);
  const response = await fetch(
    `http://rabbitmq:15672/api/queues/%2F/${encodeURIComponent(queue)}`,
    {
      headers: {
        Authorization: "Basic " + Buffer.from("eai:eai-capstone").toString("base64"),
      },
    },
  );

  if (!response.ok) throw new Error(`RabbitMQ management API: ${response.status}`);
  const details = await response.json();

  return {
    ready: result.messageCount,
    unacked: details.messages_unacknowledged || 0,
    consumers: result.consumerCount,
  };
}

app.get("/ops/metrics", async (_req, res) => {
  try {
    const entries = await Promise.all(QUEUES.map(async (queue) => [
      queue,
      await queueStats(queue),
    ]));
    const queues = Object.fromEntries(entries);

    const storedDlqResponse = await fetch("http://intake:8800/dlq");
    if (!storedDlqResponse.ok) {
      throw new Error("Intake DLQ endpoint unavailable");
    }
    const storedDlq = await storedDlqResponse.json();

    const dlqDepth =
      queues["orders.dlq"].ready +
      queues["orders.dlq"].unacked +
      storedDlq.count;

    const invalidDepth =
      queues["orders.invalid"].ready +
      queues["orders.invalid"].unacked;

    const alerts = [
      { key: "dlq_not_empty", firing: dlqDepth > 0, value: dlqDepth, threshold: null },
      { key: "invalid_not_empty", firing: invalidDepth > 0, value: invalidDepth, threshold: null },
      { key: "saga_consumer_missing", firing: queues["saga.queue"].consumers === 0, value: queues["saga.queue"].consumers, threshold: null },
      { key: "notifier_consumer_missing", firing: queues["notifications.queue"].consumers === 0, value: queues["notifications.queue"].consumers, threshold: null },
      { key: "saga_consumer_lag", firing: queues["saga.queue"].ready > LAG_THRESHOLD, value: queues["saga.queue"].ready, threshold: LAG_THRESHOLD },
      { key: "notifier_consumer_lag", firing: queues["notifications.queue"].ready > LAG_THRESHOLD, value: queues["notifications.queue"].ready, threshold: LAG_THRESHOLD },
      { key: "stuck_sagas", firing: false, value: 0, threshold: null },
    ];

    res.json({
      generatedAt: new Date().toISOString(),
      queues,
      dlqDepth,
      invalidDepth,
      stuckSagas: 0,
      alerts,
    });
  } catch (error) {
    console.error("[observer] Metrics error:", error.message);
    res.status(503).json({ error: "metrics_unavailable" });
  }
});

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`[observer] Listening on ${PORT}`);
});

async function shutdown() {
  server.close();
  try { await connection?.close(); } catch {}
  process.exit(0);
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

connect().catch((error) => {
  console.error("[observer] RabbitMQ connection failed:", error);
  process.exit(1);
});
