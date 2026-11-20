import { randomUUID } from "node:crypto";

export function startHop({
  correlationId,
  causationId = null,
  service,
  operation,
  attempt = 1,
  messageId,
  detail,
}) {
  return {
    hopId: randomUUID(),
    correlationId,
    causationId,
    service,
    operation,
    status: "success",
    attempt,
    ...(messageId ? { messageId } : {}),
    startedAt: new Date().toISOString(),
    ...(detail ? { detail } : {}),
  };
}

export async function finishHop(channel, hop, status = "success") {
  const finishedAt = new Date();
  const startedAt = new Date(hop.startedAt);

  const record = {
    ...hop,
    status,
    finishedAt: finishedAt.toISOString(),
    durationMs: Math.max(0, Math.floor(finishedAt - startedAt)),
  };

  await new Promise((resolve, reject) => {
    channel.publish(
      "trace.events",
      "",
      Buffer.from(JSON.stringify(record)),
      {
        persistent: true,
        contentType: "application/json",
        messageId: randomUUID(),
        headers: {
          correlationId: hop.correlationId,
          causationId: hop.hopId,
        },
      },
      (error) => error ? reject(error) : resolve(),
    );
  });

  return record;
}
