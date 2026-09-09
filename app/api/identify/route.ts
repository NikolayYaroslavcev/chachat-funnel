import { NextResponse, type NextRequest } from "next/server";
import { resolveVisitorSession } from "@/lib/visitor-session";
import { identifyVisitor, InvalidEmailError } from "@/lib/identify";
import { setVisitorCookie } from "@/lib/cookies";

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ status: "error", message: "invalid JSON body" }, { status: 400 });
  }

  const email =
    typeof body === "object" && body !== null && "email" in body
      ? (body as { email: unknown }).email
      : undefined;

  if (typeof email !== "string") {
    return NextResponse.json({ status: "error", message: "email is required" }, { status: 400 });
  }

  const { visitor, session } = await resolveVisitorSession(request);

  try {
    const result = await identifyVisitor(request, visitor, session, email);
    const response = NextResponse.json({ status: "ok", isNewUser: result.isNewUser });
    setVisitorCookie(response, request, result.visitor.id);
    return response;
  } catch (err) {
    if (err instanceof InvalidEmailError) {
      const response = NextResponse.json({ status: "error", message: "invalid email" }, { status: 400 });
      setVisitorCookie(response, request, visitor.id);
      return response;
    }
    throw err;
  }
}
