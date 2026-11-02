import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    if (!supabaseUrl || !supabaseKey) return NextResponse.json({ error: "MindPulse authentication is not configured." }, { status: 503 });
    const supabase = createServerClient(supabaseUrl, supabaseKey, {
      cookies: {
        getAll() { return cookieStore.getAll(); },
        setAll(values) { try { values.forEach(({ name, value, options }) => cookieStore.set(name, value, options)); } catch {} }
      }
    });
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return NextResponse.json({ error: "Please sign in to generate your AI insights." }, { status: 401 });

    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) return NextResponse.json({ error: "Gemini is not configured on the server." }, { status: 503 });

    const body = await request.json();
    const entries = Array.isArray(body.entries) ? body.entries.slice(0, 10).map((x: any) => ({
      mood: String(x?.mood ?? "").slice(0, 40),
      note: String(x?.body ?? "").slice(0, 1800),
      date: String(x?.created_at ?? "").slice(0, 40)
    })) : [];
    const tasks = Array.isArray(body.tasks) ? body.tasks.slice(0, 30).map((x: any) => ({
      title: String(x?.title ?? "").slice(0, 120),
      completed: Boolean(x?.completed)
    })) : [];
    const activities = Array.isArray(body.activities) ? body.activities.slice(0, 30).map((x: any) => ({
      type: String(x?.activity_type ?? "").slice(0, 60),
      minutes: Math.max(0, Math.min(1440, Number(x?.duration_minutes) || 0)),
      steps: Math.max(0, Number(x?.steps) || 0)
    })) : [];
    if (!entries.length && !tasks.length && !activities.length) {
      return NextResponse.json({ error: "Add a journal entry, task or activity before generating insights." }, { status: 400 });
    }

    const prompt = `You are MindPulse AI, a supportive wellbeing reflection assistant. Based only on the user's voluntarily supplied journal moods/notes, task completion and activity summaries, create a non-clinical coaching snapshot. Never diagnose, infer a mental-health condition, or treat this score as a medical measurement. Do not make claims from missing data. Be kind, practical and specific. Return only valid JSON with this exact shape: {"growthIndex": number from 0 to 100, "summary": string, "moodReflection": string, "strengths": string array with up to 3 items, "nextStep": string}. The score is a reflective habit-and-self-awareness index, not a health score. Data: ${JSON.stringify({ entries, tasks, activities })}`;

    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: "You are MindPulse AI. Be supportive, privacy-conscious, non-diagnostic and honest about uncertainty." }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 700, responseMimeType: "application/json" }
      }),
      cache: "no-store"
    });
    const result = await response.json();
    if (!response.ok) {
      const providerMessage = typeof result?.error?.message === "string" ? result.error.message.replaceAll(apiKey, "[redacted]").slice(0, 240) : "No provider details returned.";
      console.error("MindPulse insights Gemini error:", response.status, providerMessage);
      return NextResponse.json({ error: response.status === 403 ? "Gemini rejected the API key or access. Check the key and Generative Language API access." : response.status === 429 ? "Gemini quota or rate limit reached. Try again shortly." : "Gemini insights error (" + response.status + "): " + providerMessage }, { status: 502 });
    }
    const output = result?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("").trim();
    if (!output) return NextResponse.json({ error: "Gemini returned no insight. Try again." }, { status: 502 });
    const parsed = JSON.parse(output.replace(/^\`\`\`json\s*/i, "").replace(/\`\`\`$/, "").trim());
    const growthIndex = Math.max(0, Math.min(100, Math.round(Number(parsed.growthIndex) || 0)));
    return NextResponse.json({
      growthIndex,
      summary: String(parsed.summary ?? "").slice(0, 500),
      moodReflection: String(parsed.moodReflection ?? "").slice(0, 400),
      strengths: Array.isArray(parsed.strengths) ? parsed.strengths.slice(0, 3).map((x: unknown) => String(x).slice(0, 160)) : [],
      nextStep: String(parsed.nextStep ?? "").slice(0, 300)
    });
  } catch (error) {
    console.error("MindPulse insights route error:", error);
    return NextResponse.json({ error: "Could not generate insights. Please try again." }, { status: 502 });
  }
}
