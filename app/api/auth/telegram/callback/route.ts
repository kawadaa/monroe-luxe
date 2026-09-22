import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  createSession,
  deleteTelegramAuthFlow,
  findOrCreateTelegramUser,
  getTelegramAuthFlow,
  SESSION_COOKIE,
  type TelegramAuthFlow,
} from "@/lib/auth";
import { countryCodeFromHeaders } from "@/lib/country";
import { getPublicAppOrigin, getTelegramOidcConfig, safeNextPath, verifyTelegramIdToken } from "@/lib/telegram-auth";

export const runtime = "nodejs";

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function clearTelegramCookies(response: NextResponse) {
  for (const name of ["monroe_tg_state", "monroe_tg_nonce", "monroe_tg_verifier", "monroe_tg_next", "monroe_tg_from"]) {
    response.cookies.set(name, "", { httpOnly: true, sameSite: "lax", path: "/api/auth/telegram", maxAge: 0 });
  }
  return response;
}

function errorRedirect(request: NextRequest, code: string, flow?: TelegramAuthFlow | null) {
  const nextPath = safeNextPath(flow?.nextPath || request.cookies.get("monroe_tg_next")?.value);
  const from = flow?.from || (request.cookies.get("monroe_tg_from")?.value === "register" ? "register" : "login");
  const target = new URL(`/${from}`, getPublicAppOrigin(request.nextUrl.origin));
  target.searchParams.set("next", nextPath);
  target.searchParams.set("telegramError", code);
  return clearTelegramCookies(NextResponse.redirect(target));
}

export async function GET(request: NextRequest) {
  const config = getTelegramOidcConfig(request.nextUrl.origin);
  if (!config) return errorRedirect(request, "not_configured");

  const state = request.nextUrl.searchParams.get("state") || "";
  let flow: TelegramAuthFlow | null = null;
  if (state) {
    try {
      flow = await getTelegramAuthFlow(state);
    } catch (error) {
      console.error("Telegram auth flow lookup error", error);
    }
  }

  const providerError = request.nextUrl.searchParams.get("error");
  if (providerError) return errorRedirect(request, providerError === "access_denied" ? "cancelled" : "provider_error", flow);

  const code = request.nextUrl.searchParams.get("code") || "";
  const expectedState = request.cookies.get("monroe_tg_state")?.value || "";
  const cookieStateMatches = Boolean(expectedState && safeEqual(state, expectedState));
  const nonce = flow?.nonce || request.cookies.get("monroe_tg_nonce")?.value || "";
  const verifier = flow?.verifier || request.cookies.get("monroe_tg_verifier")?.value || "";
  const nextPath = safeNextPath(flow?.nextPath || request.cookies.get("monroe_tg_next")?.value);
  const hasValidState = Boolean(flow || cookieStateMatches);
  const hasConflictingCookie = Boolean(expectedState && !cookieStateMatches);
  if (!code || !state || !nonce || !verifier || !hasValidState || hasConflictingCookie) {
    return errorRedirect(request, "invalid_state", flow);
  }

  try {
    const tokenResponse = await fetch("https://oauth.telegram.org/token", {
      method: "POST",
      cache: "no-store",
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: config.redirectUri,
        client_id: config.clientId,
        code_verifier: verifier,
      }),
    });
    const tokens = await tokenResponse.json().catch(() => null) as { id_token?: string; error?: string; error_description?: string } | null;
    if (!tokenResponse.ok || !tokens?.id_token) {
      throw new Error(tokens?.error_description || tokens?.error || `Telegram token exchange failed (${tokenResponse.status})`);
    }

    const identity = await verifyTelegramIdToken(tokens.id_token, config.clientId, nonce);
    const user = await findOrCreateTelegramUser({
      id: identity.id,
      username: identity.username,
      displayName: identity.displayName,
    }, countryCodeFromHeaders(request.headers));
    const session = await createSession(user.id);
    try {
      await deleteTelegramAuthFlow(state);
    } catch (error) {
      console.error("Telegram auth flow cleanup error", error);
    }
    const publicOrigin = getPublicAppOrigin(request.nextUrl.origin);
    const response = clearTelegramCookies(NextResponse.redirect(new URL(nextPath, publicOrigin)));
    response.cookies.set(SESSION_COOKIE, session.token, {
      httpOnly: true,
      sameSite: "lax",
      secure: publicOrigin.startsWith("https://"),
      path: "/",
      maxAge: session.maxAge,
      priority: "high",
    });
    return response;
  } catch (error) {
    console.error("Telegram authentication error", error);
    return errorRedirect(request, "verification_failed", flow);
  }
}
