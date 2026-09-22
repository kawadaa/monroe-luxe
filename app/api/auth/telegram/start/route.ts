import { NextRequest, NextResponse } from "next/server";
import { saveTelegramAuthFlow } from "@/lib/auth";
import { createCodeChallenge, getPublicAppOrigin, getTelegramOidcConfig, randomOidcValue, safeNextPath } from "@/lib/telegram-auth";

export const runtime = "nodejs";

const COOKIE_TTL = 10 * 60;

export async function GET(request: NextRequest) {
  const nextPath = safeNextPath(request.nextUrl.searchParams.get("next"));
  const from = request.nextUrl.searchParams.get("from") === "register" ? "register" : "login";
  const publicOrigin = getPublicAppOrigin(request.nextUrl.origin);
  const config = getTelegramOidcConfig(publicOrigin);

  if (!config) {
    const fallback = new URL(`/${from}`, publicOrigin);
    fallback.searchParams.set("next", nextPath);
    fallback.searchParams.set("telegramError", "not_configured");
    return NextResponse.redirect(fallback);
  }

  const state = randomOidcValue();
  const nonce = randomOidcValue();
  const verifier = randomOidcValue(48);
  await saveTelegramAuthFlow(state, { nonce, verifier, nextPath, from }, COOKIE_TTL);
  const authorizationUrl = new URL("https://oauth.telegram.org/auth");
  authorizationUrl.searchParams.set("client_id", config.clientId);
  authorizationUrl.searchParams.set("redirect_uri", config.redirectUri);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("scope", "openid profile");
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("nonce", nonce);
  authorizationUrl.searchParams.set("code_challenge", createCodeChallenge(verifier));
  authorizationUrl.searchParams.set("code_challenge_method", "S256");

  const response = NextResponse.redirect(authorizationUrl);
  const cookieOptions = {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: config.redirectUri.startsWith("https://"),
    path: "/api/auth/telegram",
    maxAge: COOKIE_TTL,
  };
  response.cookies.set("monroe_tg_state", state, cookieOptions);
  response.cookies.set("monroe_tg_nonce", nonce, cookieOptions);
  response.cookies.set("monroe_tg_verifier", verifier, cookieOptions);
  response.cookies.set("monroe_tg_next", nextPath, cookieOptions);
  response.cookies.set("monroe_tg_from", from, cookieOptions);
  return response;
}
