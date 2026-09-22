import "server-only";

import { getSql } from "@/lib/db";

const schemaState = globalThis as unknown as {
  monroeSchema?: Promise<void>;
  monroePaymentsSchema?: Promise<void>;
};

export async function ensureAuthSchema() {
  if (!schemaState.monroeSchema) {
    schemaState.monroeSchema = (async () => {
      const sql = getSql();
      await sql`
        CREATE TABLE IF NOT EXISTS users (
          id UUID PRIMARY KEY,
          email TEXT UNIQUE,
          password_hash TEXT,
          telegram_id TEXT UNIQUE,
          telegram_username TEXT,
          display_name TEXT,
          country_code VARCHAR(2),
          coin_balance BIGINT NOT NULL DEFAULT 4 CHECK (coin_balance >= 0),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`ALTER TABLE users ALTER COLUMN email DROP NOT NULL`;
      await sql`ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL`;
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_id TEXT`;
      await sql`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'users'
              AND column_name = 'telegram_id'
              AND data_type <> 'text'
          ) THEN
            ALTER TABLE users ALTER COLUMN telegram_id TYPE TEXT USING telegram_id::text;
          END IF;
        END $$
      `;
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_username TEXT`;
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT`;
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS country_code VARCHAR(2)`;
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS coin_balance BIGINT NOT NULL DEFAULT 4 CHECK (coin_balance >= 0)`;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS users_telegram_id_idx ON users(telegram_id) WHERE telegram_id IS NOT NULL`;
      await sql`CREATE INDEX IF NOT EXISTS users_country_code_idx ON users(country_code) WHERE country_code IS NOT NULL`;
      await sql`
        CREATE TABLE IF NOT EXISTS sessions (
          token_hash TEXT PRIMARY KEY,
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          expires_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id)`;
      await sql`CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at)`;
      await sql`
        CREATE TABLE IF NOT EXISTS telegram_auth_flows (
          state_hash TEXT PRIMARY KEY,
          nonce TEXT NOT NULL,
          code_verifier TEXT NOT NULL,
          next_path TEXT NOT NULL,
          auth_from TEXT NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS telegram_auth_flows_expires_at_idx ON telegram_auth_flows(expires_at)`;
    })();
  }
  return schemaState.monroeSchema;
}

export async function ensurePaymentsSchema() {
  await ensureAuthSchema();
  if (!schemaState.monroePaymentsSchema) {
    schemaState.monroePaymentsSchema = (async () => {
      const sql = getSql();
      await sql`
        CREATE TABLE IF NOT EXISTS payments (
          id UUID PRIMARY KEY,
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
          provider TEXT NOT NULL,
          provider_payment_id TEXT,
          status TEXT NOT NULL,
          amount_minor BIGINT NOT NULL DEFAULT 0 CHECK (amount_minor >= 0),
          currency VARCHAR(3) NOT NULL,
          country_code VARCHAR(2),
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          checkout_url TEXT,
          coins_base INTEGER NOT NULL DEFAULT 0 CHECK (coins_base >= 0),
          bonus_percent INTEGER NOT NULL DEFAULT 0 CHECK (bonus_percent BETWEEN 0 AND 100),
          credited_coins INTEGER CHECK (credited_coins >= 0),
          credited_at TIMESTAMPTZ,
          provider_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
          paid_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS checkout_url TEXT`;
      await sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS coins_base INTEGER NOT NULL DEFAULT 0 CHECK (coins_base >= 0)`;
      await sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS bonus_percent INTEGER NOT NULL DEFAULT 0 CHECK (bonus_percent BETWEEN 0 AND 100)`;
      await sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS credited_coins INTEGER CHECK (credited_coins >= 0)`;
      await sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS credited_at TIMESTAMPTZ`;
      await sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS provider_payload JSONB NOT NULL DEFAULT '{}'::jsonb`;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS payments_provider_id_idx ON payments(provider, provider_payment_id) WHERE provider_payment_id IS NOT NULL`;
      await sql`CREATE INDEX IF NOT EXISTS payments_user_id_idx ON payments(user_id)`;
      await sql`CREATE INDEX IF NOT EXISTS payments_status_idx ON payments(status)`;
      await sql`CREATE INDEX IF NOT EXISTS payments_country_code_idx ON payments(country_code) WHERE country_code IS NOT NULL`;
      await sql`CREATE INDEX IF NOT EXISTS payments_created_at_idx ON payments(created_at)`;
    })();
  }

  await schemaState.monroePaymentsSchema;
}
