import "server-only";

import { createHash, createPublicKey, randomBytes, verify, type JsonWebKey } from "node:crypto";

const TELEGRAM_ISSUER = "https://oauth.telegram.org";
const TELEGRAM_JWKS_URL = `${TELEGRAM_ISSUER}/.well-known/jwks.json`;

type TelegramJwk = JsonWebKey & {
  kid?: string;
  alg?: string;
};

type TelegramJwtHeader = {
  alg?: string;
  kid?: string;
};

type TelegramJwtClaims = {
  iss?: string;
  aud?: string | string[];
  sub?: string;
  id?: string | number;
  iat?: number;
  exp?: number;
  nonce?: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  preferred_username?: string;
};

export type TelegramIdentity = {
  id: string;
  username: string | null;
  displayName: string;
};

export type TelegramOidcConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

const globalForTelegram = globalThis as unknown as {
  monroeTelegramJwks?: { expiresAt: number; keys: TelegramJwk[] };
};

export function getPublicAppOrigin(fallbackOrigin: string) {
  const configuredOrigin = process.env.MONROE_PUBLIC_URL?.trim();
  try {
    return new URL(configuredOrigin || fallbackOrigin).origin;
  } catch {
    return new URL(fallbackOrigin).origin;
  }
}

export function getTelegramOidcConfig(origin: string): TelegramOidcConfig | null {
  const clientId = process.env.TELEGRAM_CLIENT_ID?.trim();
  const clientSecret = process.env.TELEGRAM_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;

  const publicOrigin = getPublicAppOrigin(origin);
  const redirectUri = new URL("/api/auth/telegram/callback", publicOrigin).toString();
  return { clientId, clientSecret, redirectUri };
}

export function randomOidcValue(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function createCodeChallenge(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function safeNextPath(value: string | null | undefined) {
  return value?.startsWith("/") && !value.startsWith("//") ? value : "/account";
}

function decodeJsonSegment<T>(segment: string): T {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as T;
}

async function getTelegramJwks(forceRefresh = false) {
  const cached = globalForTelegram.monroeTelegramJwks;
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached.keys;

  const response = await fetch(TELEGRAM_JWKS_URL, { cache: "no-store" });
  if (!response.ok) throw new Error("Telegram не вернул ключи проверки");
  const body = await response.json() as { keys?: TelegramJwk[] };
  if (!Array.isArray(body.keys) || body.keys.length === 0) {
    throw new Error("Telegram вернул пустой набор ключей");
  }

  globalForTelegram.monroeTelegramJwks = {
    expiresAt: Date.now() + 60 * 60 * 1000,
    keys: body.keys,
  };
  return body.keys;
}

function verifyJwtSignature(alg: string, input: Buffer, signature: Buffer, key: TelegramJwk) {
  const publicKey = createPublicKey({ key, format: "jwk" });
  if (alg === "RS256") return verify("RSA-SHA256", input, publicKey, signature);
  if (alg === "ES256" || alg === "ES256K") {
    return verify("sha256", input, { key: publicKey, dsaEncoding: "ieee-p1363" }, signature);
  }
  if (alg === "EdDSA") return verify(null, input, publicKey, signature);
  throw new Error(`Алгоритм подписи Telegram ${alg} не поддерживается`);
}

export async function verifyTelegramIdToken(
  idToken: string,
  clientId: string,
  expectedNonce?: string,
): Promise<TelegramIdentity> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("Telegram вернул некорректный ID token");

  const [encodedHeader, encodedClaims, encodedSignature] = parts;
  const header = decodeJsonSegment<TelegramJwtHeader>(encodedHeader);
  const claims = decodeJsonSegment<TelegramJwtClaims>(encodedClaims);
  if (!header.alg || !header.kid) throw new Error("В ID token Telegram нет данных подписи");

  let keys = await getTelegramJwks();
  let jwk = keys.find((candidate) => candidate.kid === header.kid && (!candidate.alg || candidate.alg === header.alg));
  if (!jwk) {
    keys = await getTelegramJwks(true);
    jwk = keys.find((candidate) => candidate.kid === header.kid && (!candidate.alg || candidate.alg === header.alg));
  }
  if (!jwk) throw new Error("Ключ подписи Telegram не найден");

  const signingInput = Buffer.from(`${encodedHeader}.${encodedClaims}`);
  const signature = Buffer.from(encodedSignature, "base64url");
  if (!verifyJwtSignature(header.alg, signingInput, signature, jwk)) {
    throw new Error("Подпись Telegram не прошла проверку");
  }

  const now = Math.floor(Date.now() / 1000);
  const audience = (Array.isArray(claims.aud) ? claims.aud : [claims.aud]).filter(value => value != null).map(String);
  if (claims.iss !== TELEGRAM_ISSUER) throw new Error("Некорректный issuer Telegram");
  if (!audience.includes(clientId)) throw new Error("ID token выпущен для другого приложения");
  if (!claims.exp || claims.exp < now - 60) throw new Error("Сессия входа через Telegram истекла");
  if (!claims.iat || claims.iat > now + 60) throw new Error("Некорректное время входа через Telegram");
  if (claims.nonce && (!expectedNonce || claims.nonce !== expectedNonce)) {
    throw new Error("Проверка nonce Telegram не пройдена");
  }

  const telegramId = String(claims.sub || claims.id || "");
  if (!/^\d{1,20}$/.test(telegramId)) throw new Error("Telegram не вернул идентификатор пользователя");

  const username = claims.preferred_username?.replace(/^@/, "").trim().slice(0, 64) || null;
  const composedName = [claims.given_name, claims.family_name].filter(Boolean).join(" ").trim();
  const displayName = (claims.name?.trim() || composedName || (username ? `@${username}` : `Telegram ${telegramId}`)).slice(0, 160);
  return { id: telegramId, username, displayName };
}
