import { NextRequest, NextResponse } from "next/server";
import { PaymentIntegrityError, recordTransaStatus } from "@/lib/payments";
import {
  getTransaOrderStatus,
  TransaError,
  verifyTransaSignature,
} from "@/lib/transa";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type WebhookPayload = {
  uid?: unknown;
  signature?: unknown;
  status?: {
    id?: unknown;
    name?: unknown;
  };
};

export async function POST(request: NextRequest) {
  let payload: WebhookPayload;
  try {
    payload = await request.json() as WebhookPayload;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const uid = typeof payload.uid === "string" ? payload.uid.trim() : "";
  const signature = typeof payload.signature === "string" ? payload.signature.trim() : "";
  const statusId = Number(payload.status?.id);
  if (!uid || uid.length > 160 || !signature || !Number.isInteger(statusId)) {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  try {
    if (!verifyTransaSignature(uid, signature)) {
      return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
    }

    if (statusId === 3) {
      const verified = await getTransaOrderStatus(uid);
      if (Number(verified.status.id) !== 3) {
        throw new PaymentIntegrityError("Transa webhook reports success but the order status does not");
      }
      const result = await recordTransaStatus({
        uid,
        statusId,
        payload: { webhook: payload, verified },
        verifiedAmount: verified.amount,
        verifiedCurrency: verified.currency.name,
      });
      return NextResponse.json({ received: true, matched: Boolean(result), credited: result?.credited || false });
    }

    const result = await recordTransaStatus({ uid, statusId, payload });
    return NextResponse.json({ received: true, matched: Boolean(result) });
  } catch (error) {
    console.error("Failed to process Transa webhook", { uid, statusId, error });
    if (error instanceof PaymentIntegrityError) {
      return NextResponse.json({ error: "payment_verification_failed" }, { status: 409 });
    }
    if (error instanceof TransaError) {
      return NextResponse.json({ error: "provider_verification_failed" }, { status: error.status });
    }
    return NextResponse.json({ error: "webhook_processing_failed" }, { status: 500 });
  }
}
