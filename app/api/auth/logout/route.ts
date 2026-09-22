import { NextResponse } from "next/server";
import { deleteSession, SESSION_COOKIE } from "@/lib/auth";
import { getPublicAppOrigin } from "@/lib/telegram-auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const token = request.headers.get("cookie")
    ?.split(";")
    .map(value => value.trim().split("="))
    .find(([name]) => name === SESSION_COOKIE)?.[1];
  if (token) {
    try {
      await deleteSession(decodeURIComponent(token));
    } catch (error) {
      console.error("Logout database error", error);
    }
  }

  const response = NextResponse.redirect(new URL("/", getPublicAppOrigin(new URL(request.url).origin)), 303);
  response.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return response;
}
