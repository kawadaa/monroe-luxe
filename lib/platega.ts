import "server-only";

import { timingSafeEqual } from "node:crypto";

const DEFAULT_API_URL = "https://app.platega.io";
const DEFAULT_PAYMENT_URLS = ["https://pay.platega.io", "https://pay.1fin.io"];

export type PlategaTransaction = {
  transactionId: string;
  paymentUrl: string;
};

export type PlategaTransactionStatus = {
  id: string;
  status: string;
  paymentDetails: {
    amount: string | number;
    currency: string;
  };
  payload?: string | null;
};

export class PlategaError extends Error {
  constructor(message: string, public readonly status = 502) {
    super(message);
    this.name = "PlategaError";
  }
}

function credentials() {
  const merchantId = process.env.PLATEGA_MERCHANT_ID?.trim();
  const secret = process.env.PLATEGA_SECRET?.trim();
  if (!merchantId || !secret) throw new PlategaError("Platega is not configured", 503);
  return { merchantId, secret };
}

function apiUrl() {
  const value = (process.env.PLATEGA_API_URL || DEFAULT_API_URL).trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PlategaError("PLATEGA_API_URL is invalid", 503);
  }
  if (url.protocol !== "https:" && process.env.NODE_ENV === "production") {
    throw new PlategaError("PLATEGA_API_URL must use HTTPS", 503);
  }
  return url.toString().replace(/\/$/, "");
}

function paymentOrigins() {
  const configured = process.env.PLATEGA_PAYMENT_URL?.trim();
  const values = [...DEFAULT_PAYMENT_URLS, ...(configured ? configured.split(",") : [])];
  const origins = new Set<string>();
  for (const value of values) {
    try {
      const url = new URL(value.trim());
      if (url.protocol !== "https:" && process.env.NODE_ENV === "production") throw new Error("HTTPS required");
      origins.add(url.origin);
    } catch {
      throw new PlategaError("PLATEGA_PAYMENT_URL is invalid", 503);
    }
  }
  return origins;
}

function checkoutUrl(value: unknown) {
  if (typeof value !== "string" || !value) throw new PlategaError("Platega returned no payment URL");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PlategaError("Platega returned an invalid payment URL");
  }
  const expectedOrigins = paymentOrigins();
  if (!expectedOrigins.has(url.origin)) {
    throw new PlategaError(`Platega returned an unexpected payment URL origin: ${url.origin} (expected one of ${[...expectedOrigins].join(", ")})`);
  }
  return url.toString();
}

function providerMessage(payload: unknown) {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  for (const key of ["message", "error", "detail", "title"]) {
    if (typeof record[key] === "string" && record[key]) return record[key].slice(0, 300);
  }
  return null;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { merchantId, secret } = credentials();
  let response: Response;
  try {
    response = await fetch(`${apiUrl()}${path}`, {
      ...init,
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "X-MerchantId": merchantId,
        "X-Secret": secret,
        ...init.headers,
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new PlategaError(error instanceof Error ? `Platega request failed: ${error.message}` : "Platega request failed");
  }

  const payload = await response.json().catch(() => null) as T | null;
  if (!response.ok) {
    throw new PlategaError(providerMessage(payload) || `Platega request failed (${response.status})`);
  }
  if (!payload) throw new PlategaError("Platega returned an empty response");
  return payload;
}

function secureEquals(received: string, expected: string) {
  const receivedBuffer = Buffer.from(received, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return receivedBuffer.length === expectedBuffer.length && timingSafeEqual(receivedBuffer, expectedBuffer);
}

export function isPlategaConfigured() {
  return Boolean(process.env.PLATEGA_MERCHANT_ID?.trim() && process.env.PLATEGA_SECRET?.trim());
}

export function verifyPlategaCallback(merchantId: string, secret: string) {
  const expected = credentials();
  return secureEquals(merchantId, expected.merchantId) && secureEquals(secret, expected.secret);
}

export async function createPlategaTransaction(input: {
  amountRub: number;
  paymentId: string;
  description: string;
  returnUrl: string;
  failedUrl: string;
  userId: string;
  userName?: string;
  clientIp?: string;
}): Promise<PlategaTransaction> {
  const metadata: Record<string, string> = { userId: input.userId };
  if (input.userName) metadata.userName = input.userName;
  if (input.clientIp) metadata.clientIp = input.clientIp;

  const payload = await request<Record<string, unknown>>("/v2/transaction/process", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      paymentDetails: { amount: input.amountRub, currency: "RUB" },
      description: input.description,
      return: input.returnUrl,
      failedUrl: input.failedUrl,
      payload: input.paymentId,
      metadata,
    }),
  });

  const transactionId = typeof payload.transactionId === "string" ? payload.transactionId.trim() : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(transactionId)) {
    throw new PlategaError("Platega returned an invalid transaction ID");
  }
  return { transactionId, paymentUrl: checkoutUrl(payload.url) };
}

export async function getPlategaTransactionStatus(transactionId: string): Promise<PlategaTransactionStatus> {
  const payload = await request<PlategaTransactionStatus>(`/transaction/${encodeURIComponent(transactionId)}`, { method: "GET" });
  if (
    !payload || payload.id !== transactionId || typeof payload.status !== "string" ||
    !payload.paymentDetails || !["string", "number"].includes(typeof payload.paymentDetails.amount) ||
    typeof payload.paymentDetails.currency !== "string"
  ) {
    throw new PlategaError("Platega returned an invalid transaction status");
  }
  return payload;
}
