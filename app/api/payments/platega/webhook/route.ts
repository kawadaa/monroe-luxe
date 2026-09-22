import { NextRequest, NextResponse } from "next/server";
import { PaymentIntegrityError, recordPlategaStatus } from "@/lib/payments";
import {
  getPlategaTransactionStatus,
  PlategaError,
  verifyPlategaCallback,
} from "@/lib/platega";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type WebhookPayload = {
  id?: unknown;
  amount?: unknown;
  currency?: unknown;
  status?: unknown;
  paymentMethod?: unknown;
};

const CALLBACK_STATUSES = new Set(["PENDING", "CONFIRMED", "CANCELED", "CHARGEBACKED"]);

export async function POST(request: NextRequest) {
  const merchantId = request.headers.get("x-merchantid")?.trim() || "";
  const secret = request.headers.get("x-secret")?.trim() || "";
  if (!merchantId || !secret) return NextResponse.json({ error: "missing_credentials" }, { status: 401 });

  let payload: WebhookPayload;
  try {
    payload = await request.json() as WebhookPayload;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const transactionId = typeof payload.id === "string" ? payload.id.trim() : "";
  const status = typeof payload.status === "string" ? payload.status.trim().toUpperCase() : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(transactionId) || !CALLBACK_STATUSES.has(status)) {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  try {
    if (!verifyPlategaCallback(merchantId, secret)) {
      return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
    }

    if (status === "CONFIRMED") {
      const verified = await getPlategaTransactionStatus(transactionId);
      if (verified.status.toUpperCase() !== "CONFIRMED") {
        throw new PaymentIntegrityError("Platega callback reports success but the transaction status does not");
      }
      const result = await recordPlategaStatus({
        transactionId,
        status,
        payload: { webhook: payload, verified },
        verifiedAmount: verified.paymentDetails.amount,
        verifiedCurrency: verified.paymentDetails.currency,
      });
      return NextResponse.json({ received: true, matched: Boolean(result), credited: result?.credited || false });
    }

    const result = await recordPlategaStatus({ transactionId, status, payload });
    return NextResponse.json({ received: true, matched: Boolean(result) });
  } catch (error) {
    console.error("Failed to process Platega webhook", { transactionId, status, error });
    if (error instanceof PaymentIntegrityError) {
      return NextResponse.json({ error: "payment_verification_failed" }, { status: 409 });
    }
    if (error instanceof PlategaError) {
      return NextResponse.json({ error: "provider_verification_failed" }, { status: error.status });
    }
    return NextResponse.json({ error: "webhook_processing_failed" }, { status: 500 });
  }
}
