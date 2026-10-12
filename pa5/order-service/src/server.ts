import express from "express";
import crypto from "crypto";
import { connectWithRetry, withoutRetryHistory } from "../../shared/rabbit";
import type { CanonicalOrder } from "../../shared/canonical-order";

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

const ORDERS_EXCHANGE = "orders.exchange";
const RETURN_EXCHANGE = "orders.return.exchange";
const DLQ_EXCHANGE = process.env.DLQ_EXCHANGE ?? "orders.dlq.exchange";
const DLQ_QUEUE = "orders.dlq";
const INVALID_EXCHANGE = "orders.invalid.exchange";
const INVALID_QUEUE = "orders.invalid";

// In-memory store of orders we've accepted, keyed by correlationId.
const orders = new Map<string, CanonicalOrder>();

// A handful of typeof checks (the README says this is enough for PA5).
// Returns null if the body looks like a canonical order, otherwise a
// short message saying what is wrong.
function validateOrder(body: any): string | null {
  if (body === null || body === undefined || typeof body !== "object") {
    return "body must be a JSON object";
  }
  if (typeof body.orderId !== "string" || body.orderId === "") {
    return "orderId must be a non-empty string";
  }
  if (body.customer === null || typeof body.customer !== "object") {
    return "customer must be an object";
  }
  if (typeof body.customer.email !== "string" || body.customer.email === "") {
    return "customer.email must be a non-empty string";
  }
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return "items must be a non-empty array";
  }
  return null;
}

async function main(): Promise<void> {
  const { channel } = await connectWithRetry(process.env.RABBITMQ_URL!);

  // Declare the dead letter channel (replay below reads from orders.dlq).
  await channel.assertExchange(DLQ_EXCHANGE, "fanout", { durable: true });
  await channel.assertQueue(DLQ_QUEUE, { durable: true });
  await channel.bindQueue(DLQ_QUEUE, DLQ_EXCHANGE, "");

  // Declare the invalid message channel too, with exactly the same
  // properties the other services use (idempotent - safe to repeat).
  await channel.assertExchange(INVALID_EXCHANGE, "fanout", { durable: true });
  await channel.assertQueue(INVALID_QUEUE, { durable: true });
  await channel.bindQueue(INVALID_QUEUE, INVALID_EXCHANGE, "");

  const app = express();
  app.use(express.json());

  app.post("/orders", (req, res) => {
    const problem: string | null = validateOrder(req.body);
    if (problem !== null) {
      res.status(400).json({ error: problem });
      return;
    }

    const order = req.body as CanonicalOrder;
    const correlationId = crypto.randomUUID();

    channel.publish(ORDERS_EXCHANGE, "", Buffer.from(JSON.stringify(order)), {
      headers: { correlationId },
      contentType: "application/json",
      persistent: true,
    });

    orders.set(correlationId, order);

    res.status(201).json({ correlationId, status: "accepted" });
  });

  app.get("/orders/:correlationId", (req, res) => {
    const correlationId = req.params.correlationId;
    const order = orders.get(correlationId);

    if (order) {
      res.status(200).json({ correlationId, order });
    } else {
      res.status(404).json({});
    }
  });

  app.post("/dlq/replay", async (req, res) => {
    let replayed = 0;

    while (true) {
      const msg = await channel.get(DLQ_QUEUE);
      if (!msg) {
        break;
      }

      const originQueue = msg.properties.headers?.["originQueue"] as string | undefined;
      const headers = withoutRetryHistory(msg.properties.headers);

      channel.publish(RETURN_EXCHANGE, originQueue ?? "", msg.content, {
        headers,
        persistent: true,
      });

      channel.ack(msg);
      replayed += 1;
    }

    res.status(200).json({ replayed });
  });

  app.get("/health", (req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.listen(PORT, () => {
    console.log(`[order-service] listening on ${PORT}`);
  });
}

main().catch(console.error);