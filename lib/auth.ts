import "server-only";

import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { getSql } from "@/lib/db";
import { ensureAuthSchema } from "@/db/schema";

export { getSql } from "@/lib/db";
export { ensureAuthSchema } from "@/db/schema";

export const SESSION_COOKIE = "monroe_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

export type AuthUser = {
  id: string;
  email: string | null;
  telegramId: string | null;
  telegramUsername: string | null;
  displayName: string | null;
  coinBalance: number;
  createdAt: string;
};

export type StoredUser = AuthUser & { passwordHash: string | null };

export type TelegramProfile = {
  id: string;
  username?: string | null;
  displayName: string;
};

export type TelegramAuthFlow = {
  nonce: string;
  verifier: string;
  nextPath: string;
  from: "login" | "register";
};

export function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

export function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
}

export function hashPassword(password: string) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string | null) {
  if (!stored) return false;
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function findUserByEmail(email: string): Promise<StoredUser | null> {
  await ensureAuthSchema();
  const sql = getSql();
  const rows = await sql<StoredUser[]>`
    SELECT id::text, email, password_hash AS "passwordHash",
      telegram_id::text AS "telegramId", telegram_username AS "telegramUsername",
      display_name AS "displayName", coin_balance::float8 AS "coinBalance",
      created_at::text AS "createdAt"
    FROM users WHERE email = ${normalizeEmail(email)} LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function createUser(email: string, password: string, countryCode: string | null = null): Promise<AuthUser> {
  await ensureAuthSchema();
  const sql = getSql();
  const id = randomUUID();
  const rows = await sql<AuthUser[]>`
    INSERT INTO users (id, email, password_hash, country_code)
    VALUES (${id}, ${normalizeEmail(email)}, ${hashPassword(password)}, ${countryCode})
    RETURNING id::text, email, telegram_id::text AS "telegramId",
      telegram_username AS "telegramUsername", display_name AS "displayName",
      coin_balance::float8 AS "coinBalance", created_at::text AS "createdAt"
  `;
  return rows[0];
}

export async function findOrCreateTelegramUser(profile: TelegramProfile, countryCode: string | null = null): Promise<AuthUser> {
  await ensureAuthSchema();
  const sql = getSql();
  const id = randomUUID();
  const username = profile.username?.replace(/^@/, "").trim() || null;
  const displayName = profile.displayName.trim().slice(0, 160) || `Telegram ${profile.id}`;
  const inserted = await sql<AuthUser[]>`
    INSERT INTO users (id, telegram_id, telegram_username, display_name, country_code)
    VALUES (${id}, ${profile.id}, ${username}, ${displayName}, ${countryCode})
    ON CONFLICT DO NOTHING
    RETURNING id::text, email, telegram_id::text AS "telegramId",
      telegram_username AS "telegramUsername", display_name AS "displayName",
      coin_balance::float8 AS "coinBalance", created_at::text AS "createdAt"
  `;
  if (inserted[0]) return inserted[0];

  const updated = await sql<AuthUser[]>`
    UPDATE users SET telegram_username = ${username}, display_name = ${displayName},
      country_code = COALESCE(country_code, ${countryCode})
    WHERE telegram_id = ${profile.id}
    RETURNING id::text, email, telegram_id::text AS "telegramId",
      telegram_username AS "telegramUsername", display_name AS "displayName",
      coin_balance::float8 AS "coinBalance", created_at::text AS "createdAt"
  `;
  if (!updated[0]) throw new Error("Telegram user upsert failed");
  return updated[0];
}

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export async function saveTelegramAuthFlow(state: string, flow: TelegramAuthFlow, ttlSeconds: number) {
  await ensureAuthSchema();
  const sql = getSql();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  await sql`DELETE FROM telegram_auth_flows WHERE expires_at <= NOW()`;
  await sql`
    INSERT INTO telegram_auth_flows (state_hash, nonce, code_verifier, next_path, auth_from, expires_at)
    VALUES (${tokenHash(state)}, ${flow.nonce}, ${flow.verifier}, ${flow.nextPath}, ${flow.from}, ${expiresAt})
    ON CONFLICT (state_hash) DO UPDATE SET
      nonce = EXCLUDED.nonce,
      code_verifier = EXCLUDED.code_verifier,
      next_path = EXCLUDED.next_path,
      auth_from = EXCLUDED.auth_from,
      expires_at = EXCLUDED.expires_at
  `;
}

export async function getTelegramAuthFlow(state: string): Promise<TelegramAuthFlow | null> {
  if (!state) return null;
  await ensureAuthSchema();
  const sql = getSql();
  const rows = await sql<TelegramAuthFlow[]>`
    SELECT nonce, code_verifier AS verifier, next_path AS "nextPath", auth_from AS "from"
    FROM telegram_auth_flows
    WHERE state_hash = ${tokenHash(state)} AND expires_at > NOW()
    LIMIT 1
  `;
  const flow = rows[0];
  if (!flow || (flow.from !== "login" && flow.from !== "register")) return null;
  return flow;
}

export async function deleteTelegramAuthFlow(state: string) {
  if (!state) return;
  await ensureAuthSchema();
  const sql = getSql();
  await sql`DELETE FROM telegram_auth_flows WHERE state_hash = ${tokenHash(state)}`;
}

export async function createSession(userId: string) {
  await ensureAuthSchema();
  const sql = getSql();
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  await sql`DELETE FROM sessions WHERE expires_at <= NOW()`;
  await sql`
    INSERT INTO sessions (token_hash, user_id, expires_at)
    VALUES (${tokenHash(token)}, ${userId}::uuid, ${expiresAt})
  `;
  return { token, maxAge: SESSION_TTL_SECONDS };
}

export async function deleteSession(token: string) {
  await ensureAuthSchema();
  const sql = getSql();
  await sql`DELETE FROM sessions WHERE token_hash = ${tokenHash(token)}`;
}

export async function getUserBySession(token: string): Promise<AuthUser | null> {
  await ensureAuthSchema();
  const sql = getSql();
  const rows = await sql<AuthUser[]>`
    SELECT users.id::text, users.email, users.telegram_id::text AS "telegramId",
      users.telegram_username AS "telegramUsername", users.display_name AS "displayName",
      users.coin_balance::float8 AS "coinBalance", users.created_at::text AS "createdAt"
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ${tokenHash(token)} AND sessions.expires_at > NOW()
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function getCurrentUser() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    return await getUserBySession(token);
  } catch {
    return null;
  }
}
