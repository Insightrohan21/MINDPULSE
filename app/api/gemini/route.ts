import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

type ChatMessage = { role: "user" | "assistant"; content: string };

export async function POST(request: NextRequest) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "Gemini is not configured on the server. Add GEMINI_API_KEY in Vercel." }, { status: 503 });
    }

    const body = await request.json();
    const messages = body.messages as ChatMessage[];
    if (!Array.isArray(messages) || messages.length === 0 || messages.length > 30) {
      return NextResponse.json({ error: "Send between 1 and 30 chat messages." }, { status: 400 });
    }

    const contents = messages.map((message) => {
      if (!message || !["user", "assistant"].includes(message.role) || typeof message.content !== "string") {
        throw new Error("Invalid chat message.");
      }
      return { role: message.role === "assistant" ? "model" : "user", parts: [{ text: message.content.slice(0, 8000) }] };
    });

    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: "You are MindPulse AI, a friendly and supportive wellbeing companion. Help users reflect on mood, habits, activity, and general wellbeing. Be practical and non-judgmental. Do not diagnose medical or mental health conditions, interpret wearable readings as a diagnosis, or replace professional care. For urgent symptoms or risk of harm, encourage immediate help from local emergency services or a qualified professional." }] },
        contents,
        generationConfig: { temperature: 0.7, maxOutputTokens: 900 }
      }),
      cache: "no-store"
    });

    const result = await response.json();
    if (!response.ok) {
      console.error("Gemini API error:", response.status, result?.error?.message);
      return NextResponse.json({ error: response.status === 429 ? "Gemini is busy or the API quota is exhausted. Please try again shortly." : "Gemini could not answer right now. Please try again." }, { status: response.status === 429 ? 429 : 502 });
    }

    const text = result?.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text ?? "").join("").trim();
    if (!text) return NextResponse.json({ error: "Gemini returned an empty response. Please try again." }, { status: 502 });
    return NextResponse.json({ reply: text });
  } catch (error) {
    console.error("MindPulse Gemini route error:", error);
    return NextResponse.json({ error: "Could not process that message. Please try again." }, { status: 400 });
  }
}
