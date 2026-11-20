import {
  normalizeProductId,
  enrichItems,
  epochSecondsToIso,
  mapCurrencyCode,
  mapMobileStatus,
  mapB2BStatus,
  parseMobileAddress,
  decodeB2BXmlBytes,
} from "./pa4-transform.ts";

import { XMLParser } from "fast-xml-parser";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
});

export function detectSource(contentType, body) {
  const mediaType = (contentType || "").split(";")[0].trim().toLowerCase();

  if (mediaType === "application/xml" || mediaType === "text/xml") {
    return "b2b";
  }

  if (mediaType !== "application/json") {
    const error = new Error("Unsupported media type");
    error.code = "unsupported_media_type";
    throw error;
  }

  let raw;
  try {
    raw = JSON.parse(body.toString("utf8"));
  } catch {
    const error = new Error("Invalid JSON");
    error.code = "validation_error";
    throw error;
  }

  if (raw && typeof raw.orderId === "string" && raw.customer && typeof raw.customer === "object") {
    return "web";
  }

  if (raw && typeof raw.oid === "string") {
    return "mobile";
  }

  const error = new Error("Unrecognized JSON order format");
  error.code = "validation_error";
  throw error;
}

export async function translateRequest(source, body, options) {
  let raw;
  let order;
  let lines;
  let orderId;
  let orderType;
  let orderDate;
  let customer;
  let currency;
  let status;

  if (source === "web") {
    raw = JSON.parse(body.toString("utf8"));

    orderId = raw.orderId;
    orderType = raw.orderType;
    orderDate = new Date(raw.orderDate).toISOString();
    customer = {
      name: raw.customer.name,
      email: raw.customer.email,
      address: {
        street: raw.customer.address.street,
        city: raw.customer.address.city,
        postalCode: raw.customer.address.postalCode,
        country: raw.customer.address.country,
      },
    };
    currency = raw.currency;
    status = raw.status;

    if (!Array.isArray(raw.items)) {
      throw new Error("items must be an array");
    }

    lines = raw.items.map((item) => ({
      productId: normalizeProductId("web", item.productId),
      productName: item.productName,
      quantity: item.quantity,
    }));
  } else if (source === "mobile") {
    raw = JSON.parse(body.toString("utf8"));

    orderId = raw.oid;
    orderType = raw.ot;
    orderDate = epochSecondsToIso(raw.ts);
    customer = {
      name: raw.cust_name,
      email: raw.cust_email,
      address: parseMobileAddress(raw.addr),
    };
    currency = mapCurrencyCode(raw.cur);
    status = mapMobileStatus(raw.st);

    if (!Array.isArray(raw.items)) {
      throw new Error("items must be an array");
    }

    lines = raw.items.map((item) => ({
      productId: normalizeProductId("mobile", item.pid),
      productName: item.pname,
      quantity: item.qty,
    }));
  } else {
    const xmlText = decodeB2BXmlBytes(body);
    const parsed = xmlParser.parse(xmlText);
    const po = parsed?.PurchaseOrder;

    if (!po || !po.BuyerParty || !po.LineItems) {
      throw new Error("Invalid B2B purchase order");
    }

    orderId = po["@_orderId"];
    orderType = po["@_orderType"];
    orderDate = new Date(po["@_orderDate"]).toISOString();

    const address = po.BuyerParty.ShipToAddress;
    customer = {
      name: po.BuyerParty.Name,
      email: po.BuyerParty.ContactEmail,
      address: {
        street: address.Street,
        city: address.City,
        postalCode: address.PostalCode,
        country: address["@_country"],
      },
    };

    currency = po.LineItems["@_currency"];
    status = mapB2BStatus(po.Status);

    const rawItems = po.LineItems.LineItem;
    const itemArray = Array.isArray(rawItems) ? rawItems : [rawItems];

    lines = itemArray.map((item) => ({
      productId: normalizeProductId("b2b", String(item["@_sku"])),
      productName: String(item.Description),
      quantity: Number(item["@_quantity"]),
    }));
  }

  const { items, warnings } = await enrichItems(lines, options);

  const unknownProducts = warnings
    .filter((warning) => warning.code === "UNKNOWN_PRODUCT")
    .map((warning) => warning.productId);

  if (unknownProducts.length > 0) {
    return { unknownProducts };
  }

  if (warnings.length > 0) {
    const error = new Error("Pricing service unavailable");
    error.code = "pricing_unavailable";
    throw error;
  }

  order = {
    orderId,
    orderType,
    source,
    receivedAt: new Date().toISOString(),
    orderDate,
    customer,
    items,
    currency,
    status,
  };

  return { order };
}