import { NextResponse } from "next/server";
import { createSession, findUserByEmail, normalizeEmail, SESSION_COOKIE, verifyPassword } from "@/lib/auth";
import { authError } from "@/lib/auth-errors";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { email?: unknown; password?: unknown } | null;
  const email = normalizeEmail(typeof body?.email === "string" ? body.email : "");
  const password = typeof body?.password === "string" ? body.password : "";
  try {
    const user = await findUserByEmail(email);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      return NextResponse.json(authError("invalidCredentials"), { status: 401 });
    }

    const session = await createSession(user.id);
    const response = NextResponse.json({ user: { id: user.id, email: user.email } });
    response.cookies.set(SESSION_COOKIE, session.token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: session.maxAge,
    });
    return response;
  } catch (error) {
    console.error("Login database error", error);
    return NextResponse.json(authError("databaseUnavailable"), { status: 503 });
  }
}
