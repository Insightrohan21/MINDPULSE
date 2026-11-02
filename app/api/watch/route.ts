import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

function publicSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)?.trim();
  if (!url || !key) throw new Error("Supabase URL or publishable key is missing.");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function serverSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)?.trim();
  if (!url || !key) throw new Error("Supabase URL or publishable key is missing.");
  const store = await cookies();
  return createServerClient(url, key, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (values) => {
        try { values.forEach(({ name, value, options }) => store.set(name, value, options)); } catch {}
      }
    }
  });
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function GET() {
  try {
    const supabase = await serverSupabase();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return json({ error: "Sign in first." }, 401);
    const { data, error } = await supabase.from("watch_devices")
      .select("device_id,device_name,is_active,last_seen_at,created_at")
      .eq("user_id", user.id).order("created_at", { ascending: false });
    if (error) return json({ error: "Could not load paired devices." }, 500);
    return json({ devices: data ?? [] });
  } catch (error) {
    console.error("MindPulse watch GET:", error);
    return json({ error: "Supabase configuration is missing." }, 503);
  }
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "Invalid JSON body." }, 400);
  } catch { return json({ error: "Send valid JSON." }, 400); }

  if (body.action === "pair") {
    try {
      const supabase = await serverSupabase();
      const { data: { user }, error: authError } = await supabase.auth.getUser();
      if (authError || !user) return json({ error: "Sign in to MindPulse before pairing." }, 401);
      const deviceId = String(body.device_id ?? "").trim().slice(0, 80);
      const deviceName = String(body.device_name ?? "MindPulse Watch").trim().slice(0, 80) || "MindPulse Watch";
      if (!/^[A-Za-z0-9._:-]{3,80}$/.test(deviceId)) return json({ error: "Device ID must be 3–80 letters, numbers, dots, underscores, colons or hyphens." }, 400);
      const token = Array.from(crypto.getRandomValues(new Uint8Array(32))).map((b) => b.toString(16).padStart(2, "0")).join("");
      const tokenHash = await sha256(token);
      const { error } = await supabase.from("watch_devices").insert({
        device_id: deviceId, user_id: user.id, token_hash: tokenHash,
        device_name: deviceName, is_active: true
      });
      if (error) {
        console.error("MindPulse watch pairing:", error);
        return json({ error: error.code === "23505" ? "This device ID is already paired. Choose a new ID or revoke the existing pairing first." : "Could not register this watch." }, 409);
      }
      return json({ paired: true, device_id: deviceId, device_token: token, message: "Copy this token now. It is shown only once." }, 201);
    } catch (error) {
      console.error("MindPulse watch pairing:", error);
      return json({ error: "Watch pairing is not configured correctly." }, 503);
    }
  }

  const deviceId = String(request.headers.get("x-device-id") ?? "").trim();
  const deviceToken = String(request.headers.get("x-device-token") ?? "").trim();
  if (!deviceId || deviceToken.length < 32) return json({ error: "Missing device credentials." }, 401);

  try {
    const supabase = publicSupabase();
    const { data, error } = await supabase.rpc("record_watch_telemetry", {
      p_device_id: deviceId,
      p_device_token: deviceToken,
      p_payload: body
    });
    if (error) {
      console.error("MindPulse telemetry RPC:", error.code, error.message);
      const denied = error.code === "28000" || /credentials|inactive/i.test(error.message);
      return json({ error: denied ? "Invalid or inactive watch credentials." : "Reading rejected: " + error.message.slice(0, 180) }, denied ? 401 : 400);
    }
    return json(data);
  } catch (error) {
    console.error("MindPulse watch telemetry:", error);
    return json({ error: "Watch API is not configured correctly." }, 503);
  }
}
