import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";

const DEFAULT_API_URL = "https://api.transa.my/api";
const DEFAULT_PAYMENT_URL = "https://pay.transa.my";

export type TransaOrder = {
  uid: string;
  paymentUrl: string;
};

export type TransaOrderStatus = {
  uid: string;
  amount: string | number;
  expires_at?: string | null;
  currency: {
    id?: number;
    name: string;
  };
  status: {
    id: number;
    name: string;
  };
};

export class TransaError extends Error {
  constructor(message: string, public readonly status = 502) {
    super(message);
    this.name = "TransaError";
  }
}

function apiKey() {
  const value = process.env.TRANSA_API_KEY?.trim();
  if (!value) throw new TransaError("Transa is not configured", 503);
  return value;
}

function apiUrl() {
  const value = (process.env.TRANSA_API_URL || DEFAULT_API_URL).trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TransaError("TRANSA_API_URL is invalid", 503);
  }
  if (url.protocol !== "https:" && process.env.NODE_ENV === "production") {
    throw new TransaError("TRANSA_API_URL must use HTTPS", 503);
  }
  return url.toString().replace(/\/$/, "");
}

function paymentOrigin() {
  const value = (process.env.TRANSA_PAYMENT_URL || DEFAULT_PAYMENT_URL).trim();
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && process.env.NODE_ENV === "production") {
      throw new Error("HTTPS required");
    }
    return url.origin;
  } catch {
    throw new TransaError("TRANSA_PAYMENT_URL is invalid", 503);
  }
}

function checkoutUrl(value: unknown) {
  if (typeof value !== "string" || !value) throw new TransaError("Transa returned no payment URL");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TransaError("Transa returned an invalid payment URL");
  }
  const expectedOrigin = paymentOrigin();
  if (url.origin !== expectedOrigin) {
    throw new TransaError(`Transa returned an unexpected payment URL origin: ${url.origin} (expected ${expectedOrigin})`);
  }
  return url.toString();
}

function providerMessage(payload: unknown) {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  for (const key of ["message", "error", "detail"]) {
    if (typeof record[key] === "string" && record[key]) return record[key].slice(0, 300);
  }
  return null;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${apiUrl()}${path}`, {
      ...init,
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "api-key": apiKey(),
        ...init.headers,
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new TransaError(error instanceof Error ? `Transa request failed: ${error.message}` : "Transa request failed");
  }

  const payload = await response.json().catch(() => null) as T | null;
  if (!response.ok) {
    throw new TransaError(providerMessage(payload) || `Transa request failed (${response.status})`);
  }
  if (!payload) throw new TransaError("Transa returned an empty response");
  return payload;
}

export function isTransaConfigured() {
  return Boolean(process.env.TRANSA_API_KEY?.trim());
}

export async function createTransaOrder(amount: number, currency = "USD"): Promise<TransaOrder> {
  const payload = await request<Record<string, unknown>>("/v2/order/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ amount, currency }),
  });
  const uid = typeof payload.uid === "string" ? payload.uid.trim() : "";
  if (!uid || uid.length > 160) throw new TransaError("Transa returned an invalid order UID");
  return { uid, paymentUrl: checkoutUrl(payload.payment_url) };
}

export async function getTransaOrderStatus(uid: string): Promise<TransaOrderStatus> {
  const payload = await request<TransaOrderStatus>(`/v2/order/status/${encodeURIComponent(uid)}`, { method: "GET" });
  if (
    !payload || payload.uid !== uid || !payload.status || !Number.isInteger(Number(payload.status.id)) ||
    !payload.currency || typeof payload.currency.name !== "string"
  ) {
    throw new TransaError("Transa returned an invalid order status");
  }
  return payload;
}

export function verifyTransaSignature(uid: string, signature: string) {
  if (!/^[a-f\d]{32}$/i.test(signature)) return false;
  const expected = createHash("md5").update(`${uid}:${apiKey()}`, "utf8").digest();
  const received = Buffer.from(signature, "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}
