import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

function env(name: string) {
  return process.env[name]?.trim() ?? "";
}

function adminClient() {
  const url = env("NEXT_PUBLIC_SUPABASE_URL");
  const key = env("SUPABASE_SECRET_KEY") || env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Server Supabase credentials are not configured.");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function signedInUser() {
  const url = env("NEXT_PUBLIC_SUPABASE_URL");
  const key = env("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY") || env("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  if (!url || !key) throw new Error("Supabase public credentials are not configured.");
  const store = await cookies();
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (values) => {
        try { values.forEach(({ name, value, options }) => store.set(name, value, options)); } catch {}
      }
    }
  });
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return null;
  return user;
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function validNumber(value: unknown, min: number, max: number) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
}

export async function GET() {
  try {
    const user = await signedInUser();
    if (!user) return json({ error: "Sign in first." }, 401);
    const admin = adminClient();
    const { data, error } = await admin.from("watch_devices")
      .select("device_id,device_name,is_active,last_seen_at,created_at")
      .eq("user_id", user.id).order("created_at", { ascending: false });
    if (error) return json({ error: "Could not load paired devices." }, 500);
    return json({ devices: data ?? [] });
  } catch (error) {
    console.error("MindPulse watch GET:", error);
    return json({ error: "Watch API is not configured correctly." }, 503);
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
      const user = await signedInUser();
      if (!user) return json({ error: "Sign in to MindPulse before pairing." }, 401);
      const deviceId = String(body.device_id ?? "").trim().slice(0, 80);
      const deviceName = String(body.device_name ?? "MindPulse Watch").trim().slice(0, 80) || "MindPulse Watch";
      if (!/^[A-Za-z0-9._:-]{3,80}$/.test(deviceId)) return json({ error: "Device ID must be 3–80 letters, numbers, dots, underscores, colons or hyphens." }, 400);
      const token = Array.from(crypto.getRandomValues(new Uint8Array(32))).map((b) => b.toString(16).padStart(2, "0")).join("");
      const tokenHash = await sha256(token);
      const admin = adminClient();
      const { error } = await admin.from("watch_devices").upsert({
        device_id: deviceId, user_id: user.id, token_hash: tokenHash, device_name: deviceName,
        is_active: true, last_seen_at: null
      }, { onConflict: "device_id" });
      if (error) {
        console.error("MindPulse watch pairing:", error);
        return json({ error: "Pairing failed. This device ID may already belong to another account." }, 409);
      }
      return json({ paired: true, device_id: deviceId, device_token: token, message: "Copy this token now. It is shown only once." }, 201);
    } catch (error) {
      console.error("MindPulse watch pairing config:", error);
      return json({ error: "Server credentials are missing. Configure the Supabase secret key in Vercel." }, 503);
    }
  }

  // Device telemetry: token is sent in a header, never in the URL or database in plaintext.
  const deviceId = String(request.headers.get("x-device-id") ?? "").trim();
  const deviceToken = String(request.headers.get("x-device-token") ?? "").trim();
  if (!deviceId || deviceToken.length < 32) return json({ error: "Missing device credentials." }, 401);

  try {
    const admin = adminClient();
    const tokenHash = await sha256(deviceToken);
    const { data: device, error: deviceError } = await admin.from("watch_devices")
      .select("device_id,user_id,is_active").eq("device_id", deviceId).eq("token_hash", tokenHash).maybeSingle();
    if (deviceError || !device || !device.is_active) return json({ error: "Invalid or inactive watch credentials." }, 401);

    const temperature = validNumber(body.temperature_c, -40, 125);
    const humidity = validNumber(body.humidity_percent, 0, 100);
    const bpm = validNumber(body.bpm, 25, 240);
    const spo2 = validNumber(body.spo2, 0, 100);
    const battery = validNumber(body.battery_percent, 0, 100);
    const rssi = validNumber(body.wifi_rssi, -127, 0);
    if ([temperature, humidity, bpm, spo2, battery, rssi].some((v) => v === undefined)) {
      return json({ error: "One or more sensor values are outside valid ranges." }, 400);
    }
    if ([temperature, humidity, bpm, spo2, battery, rssi].every((v) => v === null)) {
      return json({ error: "No sensor readings were supplied." }, 400);
    }

    const recordedAtRaw = body.recorded_at ? Date.parse(String(body.recorded_at)) : Date.now();
    if (!Number.isFinite(recordedAtRaw) || Math.abs(Date.now() - recordedAtRaw) > 24 * 60 * 60 * 1000) {
      return json({ error: "recorded_at must be a valid timestamp within the last 24 hours." }, 400);
    }
    const sensorStatus = body.sensor_status && typeof body.sensor_status === "object" && !Array.isArray(body.sensor_status)
      ? body.sensor_status : {};
    const row = {
      user_id: device.user_id, device_id: deviceId,
      temperature_c: temperature, humidity_percent: humidity, bpm, spo2,
      battery_percent: battery, wifi_rssi: rssi,
      wifi_connected: body.wifi_connected === true,
      sensor_status: sensorStatus,
      recorded_at: new Date(recordedAtRaw).toISOString()
    };
    const { data, error } = await admin.from("watch_telemetry").insert(row).select("id,received_at").single();
    if (error) {
      console.error("MindPulse telemetry insert:", error);
      return json({ error: "Database could not save this reading." }, 500);
    }

    if (bpm !== null) {
      const { error: heartError } = await admin.from("heart_readings").insert({
        user_id: device.user_id, bpm: Math.round(bpm), spo2, source: "watch",
        recorded_at: row.recorded_at
      });
      if (heartError) console.error("MindPulse heart history insert:", heartError);
    }
    await admin.from("watch_devices").update({ last_seen_at: new Date().toISOString() }).eq("device_id", deviceId);
    return json({ ok: true, id: data.id, received_at: data.received_at });
  } catch (error) {
    console.error("MindPulse watch telemetry:", error);
    return json({ error: "Watch API is not configured correctly." }, 503);
  }
}
