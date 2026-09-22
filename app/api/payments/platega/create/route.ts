import { isIP } from "node:net";
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import {
  attachPlategaTransaction,
  createPlategaTopUpPayment,
  markTopUpPaymentFailed,
} from "@/lib/payments";
import {
  createPlategaTransaction,
  isPlategaConfigured,
  PlategaError,
} from "@/lib/platega";
import { TOP_UP_PACKAGES } from "@/lib/pricing";
import { getPublicAppOrigin } from "@/lib/telegram-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type CreatePaymentBody = {
  packRub?: unknown;
};

function requestClientIp(request: NextRequest) {
  const candidates = [
    request.headers.get("cf-connecting-ip"),
    request.headers.get("x-real-ip"),
    request.headers.get("x-forwarded-for")?.split(",")[0],
  ];
  for (const value of candidates) {
    const candidate = value?.trim();
    if (candidate && isIP(candidate)) return candidate;
  }
  return undefined;
}

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "auth_required" }, { status: 401 });
  if (!isPlategaConfigured()) return NextResponse.json({ error: "payment_unavailable" }, { status: 503 });

  let body: CreatePaymentBody;
  try {
    body = await request.json() as CreatePaymentBody;
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const packRub = typeof body.packRub === "number" ? body.packRub : Number(body.packRub);
  const pack = TOP_UP_PACKAGES.find((item) => item.rub === packRub);
  if (!pack) return NextResponse.json({ error: "invalid_package" }, { status: 400 });

  let paymentId: string | null = null;
  try {
    paymentId = await createPlategaTopUpPayment({
      userId: user.id,
      amountRub: pack.rub,
      coins: pack.coins,
      bonusPercent: pack.firstTopUpBonusPercent,
    });
    const origin = getPublicAppOrigin(request.nextUrl.origin);
    const returnPaymentId = encodeURIComponent(paymentId);
    const transaction = await createPlategaTransaction({
      amountRub: pack.rub,
      paymentId,
      description: `Пополнение Monroe: ${pack.coins} монет`,
      returnUrl: `${origin}/account/top-up?payment=success&paymentId=${returnPaymentId}`,
      failedUrl: `${origin}/account/top-up?payment=failed&paymentId=${returnPaymentId}`,
      userId: user.id,
      userName: user.telegramUsername ? `@${user.telegramUsername.replace(/^@/, "")}` : undefined,
      clientIp: requestClientIp(request),
    });
    await attachPlategaTransaction(paymentId, transaction.transactionId, transaction.paymentUrl);
    return NextResponse.json({ paymentId, paymentUrl: transaction.paymentUrl });
  } catch (error) {
    if (paymentId) {
      await markTopUpPaymentFailed(paymentId, error instanceof Error ? error.message : "Unknown payment error").catch(() => undefined);
    }
    console.error("Failed to create Platega payment", { paymentId, error });
    const status = error instanceof PlategaError ? error.status : 500;
    return NextResponse.json({ error: "payment_unavailable" }, { status });
  }
}
