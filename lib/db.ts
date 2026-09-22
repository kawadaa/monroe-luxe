import "server-only";

import postgres from "postgres";

type SqlClient = ReturnType<typeof postgres>;
const globalForDb = globalThis as unknown as {
  monroePostgres?: SqlClient;
};

export function getSql() {
  if (globalForDb.monroePostgres) return globalForDb.monroePostgres;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not configured");

  const sql = postgres(connectionString, {
    max: process.env.NODE_ENV === "production" ? 10 : 3,
    idle_timeout: 20,
    connect_timeout: 10,
  });
  globalForDb.monroePostgres = sql;
  return sql;
}
