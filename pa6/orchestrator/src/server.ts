import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import express, { type Request, type Response } from "express";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import type { CanonicalOrder } from "./canonical-order";

const app = express();
app.use(express.json());
app.use(express.static(path.join(process.cwd(), "public")));

interface Config {
  port: number;
  paymentUrl: string;
  inventoryUrl: string;
  shippingUrl: string;
  notificationUrl: string;
  requestTimeoutMs: number;
}

function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function loadConfig(): Config {
  return {
    port: Number(process.env.ORCHESTRATOR_PORT || 3000),
    paymentUrl: readRequiredEnv("PAYMENT_URL"),
    inventoryUrl: readRequiredEnv("INVENTORY_URL"),
    shippingUrl: readRequiredEnv("SHIPPING_URL"),
    notificationUrl: readRequiredEnv("NOTIFICATION_URL"),
    requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 2500),
  };
}

const config = loadConfig();

const DATA_DIR = "/data";
const IDEMPOTENCY_STORE_PATH = path.join(DATA_DIR, "idempotency-store.json");
const SAGA_STORE_PATH = path.join(DATA_DIR, "saga-store.json");

// Must match maxItems on CanonicalOrder.items in openapi.yaml.
const MAX_ITEMS = 20;

// ---------------------------------------------------------------- contract --

export interface TraceItem {
  step: string;
  status: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

export type SagaState = "completed" | "failed" | "compensated";
export type IdempotencyState = "in_progress" | "completed" | "failed" | "compensated";

interface IdempotencyRecord {
  requestHash: string;
  state: IdempotencyState;
  httpStatus: number;
  response: unknown;
  updatedAt: string;
}

interface IdempotencyStore {
  records: Record<string, IdempotencyRecord>;
}

interface SagaRecord {
  idempotencyKey: string;
  state: SagaState;
  steps: TraceItem[];
  updatedAt: string;
}

interface SagaStore {
  sagas: Record<string, SagaRecord>;
}

function ensureJsonFile(filePath: string, initialData: unknown): void {
  const dirPath = path.dirname(filePath);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(initialData, null, 2), "utf8");
  }
}

function readJsonFile<T>(filePath: string): T {
  ensureJsonFile(filePath, {});
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw || "{}") as T;
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function nowIso(): string {
  return new Date().toISOString();
}

function payloadHash(payload: unknown): string {
  const normalized = JSON.stringify(payload);
  const hash = crypto.createHash("sha256").update(normalized).digest("hex");
  return `sha256:${hash}`;
}

// ------------------------------------------------------------- validation --

const CANONICAL_SCHEMA_PATH = "/canonical/order.schema.json";

if (!fs.existsSync(CANONICAL_SCHEMA_PATH)) {
  throw new Error(
    `${CANONICAL_SCHEMA_PATH} not found. docker-compose.yml mounts ../canonical ` +
      "from your repository root: copy canonical/ next to pa6/, then run docker compose up again.",
  );
}

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const validateCanonicalOrder = ajv.compile(JSON.parse(fs.readFileSync(CANONICAL_SCHEMA_PATH, "utf8")));

function validateCheckoutPayload(payload: unknown): string | null {
  if (!validateCanonicalOrder(payload)) {
    return `Request body is not a canonical order: ${ajv.errorsText(validateCanonicalOrder.errors, { dataVar: "body" })}`;
  }
  // The canonical schema has no upper bound on items. The contract does.
  const order = payload as CanonicalOrder;
  if (order.items.length > MAX_ITEMS) {
    return `An order may contain at most ${MAX_ITEMS} items, got ${order.items.length}`;
  }
  return null;
}

function bootstrapStores(): void {
  ensureJsonFile(IDEMPOTENCY_STORE_PATH, { records: {} });
  ensureJsonFile(SAGA_STORE_PATH, { sagas: {} });
}

// ------------------------------------------------------------------ money --

// "22.50" -> 2250. Whole cents as an integer, never a float.
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

// 6390 -> "63.90". Formatted once, at the end.
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

function computeAmount(order: CanonicalOrder): string {
  let totalCents = 0;
  for (const item of order.items) {
    totalCents += priceToCents(item.unitPrice) * item.quantity;
  }
  return centsToAmount(totalCents);
}

// ------------------------------------------------------------- downstream --

interface StepResult {
  step: string;
  status: string; // success | failed | timeout
  code: string;
}

// One call to one downstream service. Records one trace entry, always.
async function runStep(step: string, url: string, body: unknown, trace: TraceItem[]): Promise<StepResult> {
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);

  let status = "success";
  let code = "";

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      status = "failed";
      code = `${step}_failed`;
      try {
        const data = JSON.parse(text) as { code?: unknown };
        if (data && typeof data.code === "string") {
          code = data.code;
        }
      } catch {
        // body was not JSON: keep the default code
      }
    }
  } catch (err) {
    if (controller.signal.aborted) {
      status = "timeout";
      code = "timeout";
    } else {
      status = "failed";
      code = `${step}_unreachable`;
    }
  } finally {
    clearTimeout(timer);
  }

  const finishedMs = Date.now();
  trace.push({
    step,
    status,
    startedAt,
    finishedAt: new Date(finishedMs).toISOString(),
    durationMs: finishedMs - startedMs,
  });

  return { step, status, code };
}

// ----------------------------------------------------------- persistence --

// Always re-read the stores right before writing: another request may have
// changed them while this one was waiting on a downstream call.
function saveIdempotencyRecord(key: string, record: IdempotencyRecord): void {
  const store = readJsonFile<IdempotencyStore>(IDEMPOTENCY_STORE_PATH);
  if (!store.records) {
    store.records = {};
  }
  store.records[key] = record;
  writeJsonFile(IDEMPOTENCY_STORE_PATH, store);
}

function saveSagaRecord(orderId: string, record: SagaRecord): void {
  const store = readJsonFile<SagaStore>(SAGA_STORE_PATH);
  if (!store.sagas) {
    store.sagas = {};
  }
  store.sagas[orderId] = record;
  writeJsonFile(SAGA_STORE_PATH, store);
}

// -------------------------------------------------------------- endpoints --

app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({ status: "ok" });
});

app.get("/debug/trace/:orderId", (req: Request, res: Response) => {
  const orderIdParam = req.params.orderId ?? "";
  const sagaStore = readJsonFile<SagaStore>(SAGA_STORE_PATH);
  const saga = sagaStore?.sagas?.[orderIdParam];
  if (!saga) {
    res.status(404).json({ code: "not_found", message: "No saga found for this orderId" });
    return;
  }
  res.status(200).json(saga);
});

app.post("/checkout", async (req: Request, res: Response) => {
  const idempotencyKey = req.header("Idempotency-Key");
  if (!idempotencyKey) {
    res.status(400).json({
      code: "validation_error",
      message: "Idempotency-Key header is required",
    });
    return;
  }

  const validationError = validateCheckoutPayload(req.body);
  if (validationError) {
    res.status(400).json({
      code: "validation_error",
      message: validationError,
    });
    return;
  }

  // ---- idempotency check. No await between this read and the in_progress
  // write below, so two requests with the same key cannot both pass it.
  const requestHash = payloadHash(req.body);
  const idempotencyStore = readJsonFile<IdempotencyStore>(IDEMPOTENCY_STORE_PATH);
  if (!idempotencyStore.records) {
    idempotencyStore.records = {};
  }

  const existing = idempotencyStore.records[idempotencyKey];
  if (existing) {
    if (existing.requestHash !== requestHash) {
      res.status(409).json({
        code: "idempotency_payload_mismatch",
        message: "This Idempotency-Key is already used for a different payload",
      });
      return;
    }
    if (existing.state === "in_progress") {
      res.status(409).json({
        code: "idempotency_conflict",
        message: "A request with this Idempotency-Key is still running",
      });
      return;
    }
    // Same key, same payload, finished: replay the stored result exactly.
    res.status(existing.httpStatus).json(existing.response);
    return;
  }

  const order = req.body as CanonicalOrder;
  const orderId = order.orderId;

  saveIdempotencyRecord(idempotencyKey, {
    requestHash,
    state: "in_progress",
    httpStatus: 202,
    response: { orderId, status: "in_progress" },
    updatedAt: nowIso(),
  });

  // ---- the saga
  const trace: TraceItem[] = [];
  const amount = computeAmount(order);

  const forwardSteps = [
    { step: "payment", url: `${config.paymentUrl}/payment/authorize`, body: { orderId, amount } },
    { step: "inventory", url: `${config.inventoryUrl}/inventory/reserve`, body: { orderId, items: order.items } },
    { step: "shipping", url: `${config.shippingUrl}/shipping/create`, body: { orderId } },
    { step: "notification", url: `${config.notificationUrl}/notification/send`, body: { orderId, recipient: order.customer.email } },
  ];

  const completedSteps: string[] = [];
  let failure: StepResult | null = null;

  for (const forward of forwardSteps) {
    const result = await runStep(forward.step, forward.url, forward.body, trace);
    if (result.status === "success") {
      completedSteps.push(forward.step);
    } else {
      failure = result;
      break;
    }
  }

  let httpStatus = 200;
  let sagaState: SagaState = "completed";
  let code: string | undefined = undefined;

  if (failure !== null) {
    // Compensate in reverse order, only what actually completed.
    // Shipping and notification have no compensating call.
    let compensationFailed = false;

    if (completedSteps.includes("inventory")) {
      const release = await runStep("inventory_release", `${config.inventoryUrl}/inventory/release`, { orderId }, trace);
      if (release.status !== "success") {
        compensationFailed = true;
      }
    }
    if (completedSteps.includes("payment")) {
      const refund = await runStep("payment_refund", `${config.paymentUrl}/payment/refund`, { orderId }, trace);
      if (refund.status !== "success") {
        compensationFailed = true;
      }
    }

    if (compensationFailed) {
      httpStatus = 422;
      sagaState = "failed";
      code = "compensation_failed";
    } else {
      httpStatus = failure.status === "timeout" ? 504 : 422;
      sagaState = failure.step === "payment" ? "failed" : "compensated";
      code = failure.code;
    }
  }

  const responseBody: Record<string, unknown> = { orderId, status: sagaState };
  if (code !== undefined) {
    responseBody.code = code;
  }
  responseBody.trace = trace;

  saveSagaRecord(orderId, {
    idempotencyKey,
    state: sagaState,
    steps: trace,
    updatedAt: nowIso(),
  });

  saveIdempotencyRecord(idempotencyKey, {
    requestHash,
    state: sagaState,
    httpStatus,
    response: responseBody,
    updatedAt: nowIso(),
  });

  res.status(httpStatus).json(responseBody);
});

bootstrapStores();

app.listen(config.port, () => {
  console.log(`[orchestrator] listening on port ${config.port}`);
  console.log("[orchestrator] downstream targets loaded from env", {
    paymentUrl: config.paymentUrl,
    inventoryUrl: config.inventoryUrl,
    shippingUrl: config.shippingUrl,
    notificationUrl: config.notificationUrl,
    requestTimeoutMs: config.requestTimeoutMs,
  });
});