import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import {
  getPlategaPaymentsForReconciliation,
  PaymentIntegrityError,
  recordPlategaStatus,
} from "@/lib/payments";
import {
  getPlategaTransactionStatus,
  isPlategaConfigured,
  PlategaError,
} from "@/lib/platega";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PAYMENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function localStatus(providerStatus: string) {
  return ({
    PENDING: "pending",
    CONFIRMED: "succeeded",
    CANCELED: "canceled",
    CHARGEBACKED: "chargebacked",
  } as Record<string, string>)[providerStatus] || "pending";
}

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "auth_required" }, { status: 401 });
  if (!isPlategaConfigured()) return NextResponse.json({ error: "payment_unavailable" }, { status: 503 });

  const rawPaymentId = request.nextUrl.searchParams.get("paymentId")?.trim();
  if (rawPaymentId && !PAYMENT_ID_PATTERN.test(rawPaymentId)) {
    return NextResponse.json({ error: "invalid_payment_id" }, { status: 400 });
  }

  try {
    const payments = await getPlategaPaymentsForReconciliation(user.id, rawPaymentId);
    let status = "none";

    for (const payment of payments) {
      if (payment.creditedAt) {
        status = "succeeded";
        continue;
      }

      const verified = await getPlategaTransactionStatus(payment.providerPaymentId);
      const providerStatus = verified.status.trim().toUpperCase();
      const result = await recordPlategaStatus({
        transactionId: payment.providerPaymentId,
        status: providerStatus,
        payload: { reconciliation: true, verified },
        verifiedAmount: providerStatus === "CONFIRMED" ? verified.paymentDetails.amount : undefined,
        verifiedCurrency: providerStatus === "CONFIRMED" ? verified.paymentDetails.currency : undefined,
      });
      const nextStatus = localStatus(providerStatus);
      if (nextStatus === "succeeded" || status === "none" || status === "pending") status = nextStatus;
      if (result?.credited) status = "succeeded";
    }

    const refreshedUser = await getCurrentUser();
    return NextResponse.json({ status, coinBalance: refreshedUser?.coinBalance ?? user.coinBalance });
  } catch (error) {
    console.error("Failed to reconcile Platega payment", { userId: user.id, paymentId: rawPaymentId, error });
    if (error instanceof PaymentIntegrityError) {
      return NextResponse.json({ error: "payment_verification_failed" }, { status: 409 });
    }
    if (error instanceof PlategaError) {
      return NextResponse.json({ error: "provider_verification_failed" }, { status: error.status });
    }
    return NextResponse.json({ error: "payment_reconciliation_failed" }, { status: 500 });
  }
}
