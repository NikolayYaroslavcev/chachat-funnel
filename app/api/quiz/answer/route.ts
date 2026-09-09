import { NextResponse, type NextRequest } from "next/server";
import { resolveVisitorSession } from "@/lib/visitor-session";
import { setVisitorCookie } from "@/lib/cookies";
import { submitQuizAnswer, InvalidQuizAnswerError } from "@/lib/quiz";

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ status: "error", message: "invalid JSON body" }, { status: 400 });
  }

  const questionKey =
    typeof body === "object" && body !== null ? (body as Record<string, unknown>).questionKey : undefined;
  const answerValue =
    typeof body === "object" && body !== null ? (body as Record<string, unknown>).answerValue : undefined;

  if (typeof questionKey !== "string" || typeof answerValue !== "string") {
    return NextResponse.json(
      { status: "error", message: "questionKey and answerValue are required" },
      { status: 400 },
    );
  }

  const { visitor, session } = await resolveVisitorSession(request);

  try {
    const { completed } = await submitQuizAnswer(session, visitor, questionKey, answerValue);
    const response = NextResponse.json({ status: "ok", completed });
    setVisitorCookie(response, request, visitor.id);
    return response;
  } catch (err) {
    if (err instanceof InvalidQuizAnswerError) {
      const response = NextResponse.json({ status: "error", message: "invalid question/answer" }, { status: 400 });
      setVisitorCookie(response, request, visitor.id);
      return response;
    }
    throw err;
  }
}
