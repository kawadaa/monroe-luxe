import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import {
  attachTransaOrder,
  createTopUpPayment,
  markTopUpPaymentFailed,
} from "@/lib/payments";
import { TOP_UP_PACKAGES } from "@/lib/pricing";
import { createTransaOrder, isTransaConfigured, TransaError } from "@/lib/transa";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type CreatePaymentBody = {
  packUsd?: unknown;
};

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "auth_required" }, { status: 401 });
  if (!isTransaConfigured()) return NextResponse.json({ error: "payment_unavailable" }, { status: 503 });

  let body: CreatePaymentBody;
  try {
    body = await request.json() as CreatePaymentBody;
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const packUsd = typeof body.packUsd === "number" ? body.packUsd : Number(body.packUsd);
  const pack = TOP_UP_PACKAGES.find((item) => item.usd === packUsd);
  if (!pack) return NextResponse.json({ error: "invalid_package" }, { status: 400 });

  let paymentId: string | null = null;
  try {
    paymentId = await createTopUpPayment({
      userId: user.id,
      amountUsd: pack.usd,
      coins: pack.coins,
      bonusPercent: pack.firstTopUpBonusPercent,
    });
    const order = await createTransaOrder(pack.usd, "USD");
    await attachTransaOrder(paymentId, order.uid, order.paymentUrl);
    return NextResponse.json({ paymentId, paymentUrl: order.paymentUrl });
  } catch (error) {
    if (paymentId) {
      await markTopUpPaymentFailed(paymentId, error instanceof Error ? error.message : "Unknown payment error").catch(() => undefined);
    }
    console.error("Failed to create Transa payment", { paymentId, error });
    const status = error instanceof TransaError ? error.status : 500;
    return NextResponse.json({ error: "payment_unavailable" }, { status });
  }
}
