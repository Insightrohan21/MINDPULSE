import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

export const runtime = "nodejs";
export const maxDuration = 30;

type ChatMessage = { role: "user" | "assistant"; content: string };
type GeminiResult = {
  response: Response;
  data: any;
  model: string;
};

const SYSTEM_PROMPT =
  "You are MindPulse AI, a friendly and supportive wellbeing companion. Help users reflect on mood, habits, activity, and general wellbeing. Be practical and non-judgmental. Do not diagnose medical or mental health conditions, interpret wearable readings as a diagnosis, or replace professional care. For urgent symptoms or risk of harm, encourage immediate help from local emergency services or a qualified professional.";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function callGemini(apiKey: string, model: string, contents: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }>): Promise<GeminiResult> {
  let response: Response;
  let data: any;
  try {
    response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents,
      generationConfig: { temperature: 0.7, maxOutputTokens: 900 }
    }),
    cache: "no-store",
      signal: AbortSignal.timeout(7000)
    });
    data = await response.json().catch(() => ({}));
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    const status = timedOut ? 504 : 502;
    data = { error: { message: timedOut ? "Gemini request timed out." : "Could not reach Gemini provider." } };
    response = new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  }
  return { response, data, model };
}

function isTemporaryProviderError(status: number) {
  return status === 500 || status === 502 || status === 503 || status === 504;
}

export async function POST(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    if (!supabaseUrl || !supabaseKey) {
      return NextResponse.json({ error: "MindPulse authentication is not configured on the server." }, { status: 503 });
    }
    const supabase = createServerClient(supabaseUrl, supabaseKey, {
      cookies: {
        getAll() { return cookieStore.getAll(); },
        setAll(cookiesToSet) {
          try { cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options)); } catch {}
        }
      }
    });
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return NextResponse.json({ error: "Please sign in to use MindPulse AI." }, { status: 401 });

    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) {
      return NextResponse.json({ error: "Gemini is not configured on the server. Add GEMINI_API_KEY in Vercel." }, { status: 503 });
    }

    const body = await request.json();
    const messages = body.messages as ChatMessage[];
    if (!Array.isArray(messages) || messages.length === 0 || messages.length > 30) {
      return NextResponse.json({ error: "Send between 1 and 30 chat messages." }, { status: 400 });
    }

    const contents: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> = [];
    for (const message of messages) {
      if (!message || !["user", "assistant"].includes(message.role) || typeof message.content !== "string") {
        return NextResponse.json({ error: "Invalid chat message." }, { status: 400 });
      }
      const text = message.content.trim().slice(0, 8000);
      if (!text) continue;
      const role = message.role === "assistant" ? "model" : "user";
      const previous = contents[contents.length - 1];
      if (previous?.role === role) previous.parts[0].text += "\n\n" + text;
      else contents.push({ role, parts: [{ text }] });
    }
    while (contents[0]?.role === "model") contents.shift();
    if (!contents.length) return NextResponse.json({ error: "Type a message to start the conversation." }, { status: 400 });

    // Retry the primary model once for transient overload, then fail over to a
    // stable lightweight model. The API key stays server-side throughout.
    let result = await callGemini(apiKey, "gemini-3.8-flash", contents);
    if (isTemporaryProviderError(result.response.status)) {
      console.warn("Gemini primary model temporarily unavailable; retrying once.", result.response.status);
      await sleep(450);
      result = await callGemini(apiKey, "gemini-3.8-flash", contents);
    }
    if (isTemporaryProviderError(result.response.status)) {
      console.warn("Gemini primary model still unavailable; trying fallback model.", result.response.status);
      result = await callGemini(apiKey, "gemini-3.5-flash-lite", contents);
    }

    if (!result.response.ok) {
      const providerMessage = typeof result.data?.error?.message === "string"
        ? result.data.error.message.replaceAll(apiKey, "[redacted]").slice(0, 240)
        : "No provider details were returned.";
      console.error("Gemini API error:", result.model, result.response.status, providerMessage);
      const status = result.response.status;
      const message = status === 400
        ? "Gemini rejected the request: " + providerMessage
        : status === 403
          ? "Gemini rejected the API key or access. Check that the key is active and the Generative Language API is enabled."
          : status === 404
            ? "The configured Gemini model is unavailable. Check the model name and API access."
            : status === 429
              ? "Gemini quota or rate limit reached. Please try again later."
              : isTemporaryProviderError(status)
                ? "MindPulse AI is temporarily busy with the AI provider. Please retry in a few seconds."
                : "MindPulse AI could not complete the request. Please try again.";
      return NextResponse.json({ error: message, providerStatus: status }, { status: status === 429 ? 429 : 502 });
    }

    const text = result.data?.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text ?? "").join("").trim();
    if (!text) return NextResponse.json({ error: "Gemini returned an empty response. Please try again." }, { status: 502 });
    return NextResponse.json({ reply: text, model: result.model });
  } catch (error) {
    console.error("MindPulse Gemini route error:", error);
    return NextResponse.json({ error: "Could not process that message. Please try again." }, { status: 400 });
  }
}
