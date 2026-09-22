import "server-only";

import { randomUUID } from "node:crypto";
import { getSql } from "@/lib/db";
import { ensurePaymentsSchema } from "@/db/schema";

export { ensurePaymentsSchema } from "@/db/schema";

export type TopUpPayment = {
  id: string;
  status: string;
  amountMinor: number;
  currency: string;
  checkoutUrl: string | null;
  creditedCoins: number | null;
  creditedAt: string | null;
  createdAt: string;
};

type PaymentRow = TopUpPayment & {
  userId: string;
  providerPaymentId: string;
  coinsBase: number;
  bonusPercent: number;
};

export type PlategaPaymentForReconciliation = {
  id: string;
  providerPaymentId: string;
  status: string;
  creditedAt: string | null;
};

export class PaymentIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentIntegrityError";
  }
}

export function decimalAmountToMinor(value: string | number) {
  const normalized = String(value).trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(normalized);
  if (!match) throw new PaymentIntegrityError("Payment provider returned an invalid amount");
  const fraction = match[2] || "";
  if (fraction.slice(2).replace(/0/g, "")) {
    throw new PaymentIntegrityError("Payment provider returned an amount with unsupported precision");
  }
  const minor = BigInt(match[1]) * BigInt(100) + BigInt((fraction + "00").slice(0, 2));
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new PaymentIntegrityError("Payment provider amount is too large");
  return Number(minor);
}

async function createProviderTopUpPayment(input: {
  userId: string;
  provider: "transa" | "platega";
  amount: number;
  currency: "USD" | "RUB";
  coins: number;
  bonusPercent: number;
}) {
  await ensurePaymentsSchema();
  const sql = getSql();
  const id = randomUUID();
  const amountMinor = decimalAmountToMinor(input.amount);
  const rows = await sql<Array<{ id: string }>>`
    INSERT INTO payments (
      id, user_id, provider, status, amount_minor, currency, country_code, coins_base, bonus_percent
    )
    SELECT ${id}::uuid, u.id, ${input.provider}, 'creating', ${amountMinor}, ${input.currency}, u.country_code, ${input.coins}, ${input.bonusPercent}
    FROM users u
    WHERE u.id = ${input.userId}::uuid
    RETURNING id::text AS id
  `;
  if (!rows[0]) throw new Error("User not found");
  return id;
}

export function createTopUpPayment(input: {
  userId: string;
  amountUsd: number;
  coins: number;
  bonusPercent: number;
}) {
  return createProviderTopUpPayment({
    userId: input.userId,
    provider: "transa",
    amount: input.amountUsd,
    currency: "USD",
    coins: input.coins,
    bonusPercent: input.bonusPercent,
  });
}

export function createPlategaTopUpPayment(input: {
  userId: string;
  amountRub: number;
  coins: number;
  bonusPercent: number;
}) {
  return createProviderTopUpPayment({
    userId: input.userId,
    provider: "platega",
    amount: input.amountRub,
    currency: "RUB",
    coins: input.coins,
    bonusPercent: input.bonusPercent,
  });
}

async function attachProviderOrder(paymentId: string, provider: "transa" | "platega", providerPaymentId: string, paymentUrl: string) {
  await ensurePaymentsSchema();
  const sql = getSql();
  const rows = await sql<Array<{ id: string }>>`
    UPDATE payments
    SET provider_payment_id = ${providerPaymentId}, checkout_url = ${paymentUrl}, status = 'pending', updated_at = NOW()
    WHERE id = ${paymentId}::uuid AND provider = ${provider} AND status = 'creating'
    RETURNING id::text AS id
  `;
  if (!rows[0]) throw new Error("Payment order could not be attached");
}

export function attachTransaOrder(paymentId: string, uid: string, paymentUrl: string) {
  return attachProviderOrder(paymentId, "transa", uid, paymentUrl);
}

export function attachPlategaTransaction(paymentId: string, transactionId: string, paymentUrl: string) {
  return attachProviderOrder(paymentId, "platega", transactionId, paymentUrl);
}

export async function markTopUpPaymentFailed(paymentId: string, message: string) {
  await ensurePaymentsSchema();
  const sql = getSql();
  await sql`
    UPDATE payments
    SET status = 'failed', metadata = jsonb_set(metadata, '{error}', to_jsonb(${message.slice(0, 300)}::text)), updated_at = NOW()
    WHERE id = ${paymentId}::uuid AND credited_at IS NULL
  `;
}

function localStatus(statusId: number) {
  return ({
    1: "pending",
    2: "processing",
    3: "succeeded",
    4: "failed",
    5: "canceled",
    6: "hold",
  } as Record<number, string>)[statusId] || "pending";
}

async function recordProviderStatus(input: {
  provider: "transa" | "platega";
  providerPaymentId: string;
  status: string;
  successful: boolean;
  payload: unknown;
  verifiedAmount?: string | number;
  verifiedCurrency?: string;
}) {
  await ensurePaymentsSchema();
  const sql = getSql();
  const payloadJson = JSON.stringify(input.payload ?? {});

  return sql.begin(async (transaction) => {
    const rows = await transaction<PaymentRow[]>`
      SELECT id::text AS id, user_id::text AS "userId", provider_payment_id AS "providerPaymentId",
        status, amount_minor::float8 AS "amountMinor", currency, checkout_url AS "checkoutUrl",
        coins_base AS "coinsBase", bonus_percent AS "bonusPercent",
        credited_coins AS "creditedCoins", credited_at::text AS "creditedAt", created_at::text AS "createdAt"
      FROM payments
      WHERE provider = ${input.provider} AND provider_payment_id = ${input.providerPaymentId}
      LIMIT 1
      FOR UPDATE
    `;
    const payment = rows[0];
    if (!payment) return null;

    if (!input.successful) {
      await transaction`
        UPDATE payments
        SET status = CASE
            WHEN ${input.status} = 'chargebacked' THEN 'chargebacked'
            WHEN credited_at IS NULL THEN ${input.status}
            ELSE status
          END,
          provider_payload = ${payloadJson}::jsonb, updated_at = NOW()
        WHERE id = ${payment.id}::uuid
      `;
      return { paymentId: payment.id, credited: false, creditedCoins: payment.creditedCoins };
    }

    if (input.verifiedAmount === undefined || !input.verifiedCurrency) {
      throw new PaymentIntegrityError("A successful payment was not independently verified");
    }
    const verifiedAmountMinor = decimalAmountToMinor(input.verifiedAmount);
    const verifiedCurrency = input.verifiedCurrency.toUpperCase();
    if (verifiedAmountMinor !== payment.amountMinor || verifiedCurrency !== payment.currency) {
      throw new PaymentIntegrityError("Payment amount or currency does not match the order");
    }

    if (payment.creditedAt) {
      await transaction`
        UPDATE payments SET provider_payload = ${payloadJson}::jsonb, updated_at = NOW()
        WHERE id = ${payment.id}::uuid
      `;
      return { paymentId: payment.id, credited: false, creditedCoins: payment.creditedCoins };
    }

    await transaction`SELECT id FROM users WHERE id = ${payment.userId}::uuid FOR UPDATE`;
    const priorRows = await transaction<Array<{ hasPrior: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM payments
        WHERE user_id = ${payment.userId}::uuid AND credited_at IS NOT NULL AND id <> ${payment.id}::uuid
      ) AS "hasPrior"
    `;
    const bonusCoins = priorRows[0]?.hasPrior ? 0 : Math.floor(payment.coinsBase * payment.bonusPercent / 100);
    const creditedCoins = payment.coinsBase + bonusCoins;

    const credited = await transaction<Array<{ id: string }>>`
      UPDATE payments
      SET status = 'succeeded', paid_at = COALESCE(paid_at, NOW()), credited_at = NOW(),
        credited_coins = ${creditedCoins}, provider_payload = ${payloadJson}::jsonb, updated_at = NOW()
      WHERE id = ${payment.id}::uuid AND credited_at IS NULL
      RETURNING id::text AS id
    `;
    if (credited[0]) {
      await transaction`
        UPDATE users SET coin_balance = coin_balance + ${creditedCoins}
        WHERE id = ${payment.userId}::uuid
      `;
    }
    return { paymentId: payment.id, credited: Boolean(credited[0]), creditedCoins };
  });
}

export async function recordTransaStatus(input: {
  uid: string;
  statusId: number;
  payload: unknown;
  verifiedAmount?: string | number;
  verifiedCurrency?: string;
}) {
  const status = localStatus(input.statusId);
  return recordProviderStatus({
    provider: "transa",
    providerPaymentId: input.uid,
    status,
    successful: input.statusId === 3,
    payload: input.payload,
    verifiedAmount: input.verifiedAmount,
    verifiedCurrency: input.verifiedCurrency,
  });
}

export function recordPlategaStatus(input: {
  transactionId: string;
  status: string;
  payload: unknown;
  verifiedAmount?: string | number;
  verifiedCurrency?: string;
}) {
  const providerStatus = input.status.toUpperCase();
  const status = ({
    PENDING: "pending",
    CONFIRMED: "succeeded",
    CANCELED: "canceled",
    CHARGEBACKED: "chargebacked",
  } as Record<string, string>)[providerStatus] || "pending";
  return recordProviderStatus({
    provider: "platega",
    providerPaymentId: input.transactionId,
    status,
    successful: providerStatus === "CONFIRMED",
    payload: input.payload,
    verifiedAmount: input.verifiedAmount,
    verifiedCurrency: input.verifiedCurrency,
  });
}

export async function getPlategaPaymentsForReconciliation(userId: string, paymentId?: string) {
  await ensurePaymentsSchema();
  const sql = getSql();
  if (paymentId) {
    return sql<PlategaPaymentForReconciliation[]>`
      SELECT id::text AS id, provider_payment_id AS "providerPaymentId", status,
        credited_at::text AS "creditedAt"
      FROM payments
      WHERE id = ${paymentId}::uuid AND user_id = ${userId}::uuid
        AND provider = 'platega' AND provider_payment_id IS NOT NULL
      LIMIT 1
    `;
  }

  return sql<PlategaPaymentForReconciliation[]>`
    SELECT id::text AS id, provider_payment_id AS "providerPaymentId", status,
      credited_at::text AS "creditedAt"
    FROM payments
    WHERE user_id = ${userId}::uuid AND provider = 'platega'
      AND provider_payment_id IS NOT NULL AND credited_at IS NULL
      AND status IN ('creating', 'pending', 'processing')
      AND created_at > NOW() - INTERVAL '30 days'
    ORDER BY created_at DESC
    LIMIT 3
  `;
}

export async function getRecentTopUpPayments(userId: string, limit = 5): Promise<TopUpPayment[]> {
  await ensurePaymentsSchema();
  const sql = getSql();
  const safeLimit = Math.max(1, Math.min(10, Math.trunc(limit) || 5));
  return sql<TopUpPayment[]>`
    SELECT id::text AS id, status, amount_minor::float8 AS "amountMinor", currency,
      checkout_url AS "checkoutUrl", credited_coins AS "creditedCoins",
      credited_at::text AS "creditedAt", created_at::text AS "createdAt"
    FROM payments
    WHERE user_id = ${userId}::uuid AND provider IN ('transa', 'platega')
    ORDER BY created_at DESC
    LIMIT ${safeLimit}
  `;
}
