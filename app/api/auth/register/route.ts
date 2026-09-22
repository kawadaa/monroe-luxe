import { NextResponse } from "next/server";
import { createSession, createUser, findUserByEmail, isValidEmail, normalizeEmail, SESSION_COOKIE } from "@/lib/auth";
import { authError } from "@/lib/auth-errors";
import { countryCodeFromHeaders } from "@/lib/country";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { email?: unknown; password?: unknown } | null;
  const email = normalizeEmail(typeof body?.email === "string" ? body.email : "");
  const password = typeof body?.password === "string" ? body.password : "";

  if (!isValidEmail(email)) return NextResponse.json(authError("invalidEmail"), { status: 400 });
  if (password.length < 8 || password.length > 128) return NextResponse.json(authError("passwordLength"), { status: 400 });
  try {
    if (await findUserByEmail(email)) return NextResponse.json(authError("accountExists"), { status: 409 });
    const user = await createUser(email, password, countryCodeFromHeaders(request.headers));
    const session = await createSession(user.id);
    const response = NextResponse.json({ user: { id: user.id, email: user.email } }, { status: 201 });
    response.cookies.set(SESSION_COOKIE, session.token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: session.maxAge,
    });
    return response;
  } catch (error) {
    console.error("Registration database error", error);
    return NextResponse.json(authError("databaseUnavailable"), { status: 503 });
  }
}
