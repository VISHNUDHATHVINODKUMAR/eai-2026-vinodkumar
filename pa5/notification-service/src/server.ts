import type { ConsumeMessage } from "amqplib";
import * as fs from "fs";
import { connectWithRetry, getRetryCount } from "../../shared/rabbit";
import type { CanonicalOrder } from "../../shared/canonical-order";

const QUEUE: string = "notifications.queue";
const RESULTS_EXCHANGE: string = "results.notification";
const DLQ_EXCHANGE: string = process.env.DLQ_EXCHANGE ?? "orders.dlq.exchange";
const INVALID_EXCHANGE: string = "orders.invalid.exchange";
const MAX_RETRIES: number = Number(process.env.MAX_RETRIES ?? "3");
const FAIL_RATE: number = Number(process.env.NOTIFICATION_FAIL_RATE ?? "0");

const IDS_FILE: string = "/data/processed-ids.json";
const LOG_FILE: string = "/data/notification.log";

function loadProcessedIds(): Set<string> {
  if (!fs.existsSync(IDS_FILE)) {
    fs.writeFileSync(IDS_FILE, "[]");
    return new Set<string>();
  }
  const text: string = fs.readFileSync(IDS_FILE, "utf8");
  if (text.trim() === "") {
    return new Set<string>();
  }
  const list: string[] = JSON.parse(text);
  return new Set<string>(list);
}

function saveProcessedIds(ids: Set<string>): void {
  fs.writeFileSync(IDS_FILE, JSON.stringify(Array.from(ids)));
}

async function main(): Promise<void> {
  const { channel } = await connectWithRetry(process.env.RABBITMQ_URL!);
  await channel.prefetch(1);

  await channel.assertExchange(DLQ_EXCHANGE, "fanout", { durable: true });
  await channel.assertQueue("orders.dlq", { durable: true });
  await channel.bindQueue("orders.dlq", DLQ_EXCHANGE, "");

  await channel.assertExchange(INVALID_EXCHANGE, "fanout", { durable: true });
  await channel.assertQueue("orders.invalid", { durable: true });
  await channel.bindQueue("orders.invalid", INVALID_EXCHANGE, "");

  const processedIds: Set<string> = loadProcessedIds();
  console.log(`[Notification] Consuming from ${QUEUE}, known ids: ${processedIds.size}`);

  await channel.consume(QUEUE, async (msg: ConsumeMessage | null) => {
    if (!msg) return;

    const correlationId = msg.properties.headers?.["correlationId"] as string | undefined;
    const retryCount: number = getRetryCount(msg);

    // Permanent failure: no correlationId means we can never trace or dedupe it
    if (correlationId === undefined) {
      channel.publish(INVALID_EXCHANGE, "", msg.content, {
        headers: msg.properties.headers,
        persistent: true,
      });
      channel.ack(msg);
      console.log("[Notification] -> Invalid message: missing correlationId");
      return;
    }

    try {
      // Idempotent receiver: seen this order already? ack and do nothing.
      if (processedIds.has(correlationId)) {
        channel.ack(msg);
        console.log(`[Notification] duplicate skipped ${correlationId}`);
        return;
      }

      const order = JSON.parse(msg.content.toString()) as CanonicalOrder;

      const roll: number = Math.random() * 100;
      if (roll < FAIL_RATE) {
        throw new Error("Simulated notification failure");
      }

      const line: string = JSON.stringify({
        correlationId: correlationId,
        orderId: order.orderId,
        customerEmail: order.customer.email,
        timestamp: new Date().toISOString(),
        message: "Order received",
      });
      fs.appendFileSync(LOG_FILE, line + "\n");

      processedIds.add(correlationId);
      saveProcessedIds(processedIds);

      channel.ack(msg);
      channel.publish(
        RESULTS_EXCHANGE,
        "",
        Buffer.from(
          JSON.stringify({
            correlationId,
            source: "notification",
            status: "success",
            timestamp: new Date().toISOString(),
            details: { message: "Notification sent" },
          }),
        ),
        {
          headers: { correlationId },
          contentType: "application/json",
          persistent: true,
        },
      );
      console.log(`[Notification] Success for ${correlationId}`);
      return;
    } catch (err) {
      if (err instanceof SyntaxError) {
        channel.publish(INVALID_EXCHANGE, "", msg.content, {
          headers: msg.properties.headers,
          persistent: true,
        });
        channel.ack(msg);
        console.log(`[Notification] -> Invalid message: ${(err as Error).message}`);
        return;
      }

      // Retry / DLQ logic, copied unchanged from payment-service
      if (retryCount >= MAX_RETRIES - 1) {
        channel.publish(DLQ_EXCHANGE, "", msg.content, {
          headers: { ...msg.properties.headers, originQueue: QUEUE },
          persistent: true,
        });
        channel.ack(msg);
        console.log(`[Notification] -> DLQ after ${retryCount + 1} attempts: ${(err as Error).message}`);
      } else {
        channel.nack(msg, false, false);
        console.log(`[Notification] -> Retry (attempt ${retryCount + 1}): ${(err as Error).message}`);
      }
    }
  });
}

main().catch(console.error);