"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type Device = { device_id: string; device_name: string; is_active: boolean; last_seen_at: string | null; created_at: string };
type Reading = { id: number; device_id: string; temperature_c: number | null; humidity_percent: number | null; bpm: number | null; spo2: number | null; battery_percent: number | null; wifi_rssi: number | null; recorded_at: string };

export default function WatchSetupPage() {
  const [user, setUser] = useState<any>(null);
  const [deviceId, setDeviceId] = useState("MINDPULSE-ESP32-01");
  const [deviceName, setDeviceName] = useState("MindPulse Watch");
  const [devices, setDevices] = useState<Device[]>([]);
  const [readings, setReadings] = useState<Reading[]>([]);
  const [token, setToken] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch("/api/watch", { cache: "no-store" });
    const result = await response.json();
    if (response.ok) setDevices(result.devices ?? []);
    else setMessage(result.error ?? "Could not load devices.");
  }, []);

  useEffect(() => {
    const supabase = createClient();
    if (!supabase) { setMessage("Supabase browser configuration is missing."); return; }
    supabase.auth.getUser().then(({ data }) => {
      setUser(data.user);
      if (data.user) load();
    });
  }, [load]);

  const loadReadings = useCallback(async () => {
    if (!user) return;
    const supabase = createClient();
    if (!supabase) return;
    const { data, error } = await supabase.from("watch_telemetry")
      .select("id,device_id,temperature_c,humidity_percent,bpm,spo2,battery_percent,wifi_rssi,recorded_at")
      .eq("user_id", user.id).order("recorded_at", { ascending: false }).limit(30);
    if (error) setMessage(error.message);
    else setReadings((data ?? []) as Reading[]);
  }, [user]);

  useEffect(() => {
    if (!user) return;
    loadReadings();
    const supabase = createClient();
    if (!supabase) return;
    const channel = supabase.channel("watch-telemetry-" + user.id)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "watch_telemetry", filter: "user_id=eq." + user.id }, () => loadReadings())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [user, loadReadings]);

  async function pair() {
    if (!user) { setMessage("Sign in to MindPulse first."); return; }
    setBusy(true); setMessage(""); setToken("");
    try {
      const response = await fetch("/api/watch", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "pair", device_id: deviceId, device_name: deviceName }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Pairing failed.");
      setToken(result.device_token);
      setMessage("Watch paired. Copy the token now; it will not be shown again.");
      await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Pairing failed."); }
    finally { setBusy(false); }
  }

  if (!user) return <main style={styles.wrap}><h1>MindPulse Watch</h1><p>Sign in to your MindPulse account on the main website, then open this page again.</p></main>;
  return <main style={styles.wrap}>
    <a href="/" style={styles.link}>← Back to MindPulse</a>
    <h1 style={styles.title}>Connect your MindPulse Watch</h1>
    <p style={styles.muted}>Pair your ESP32 once. The device token is displayed only once, so save it securely before leaving this page.</p>
    <section style={styles.card}>
      <label style={styles.label}>Device ID</label><input style={styles.input} value={deviceId} onChange={e => setDeviceId(e.target.value)} />
      <label style={styles.label}>Device name</label><input style={styles.input} value={deviceName} onChange={e => setDeviceName(e.target.value)} />
      <button style={styles.button} disabled={busy} onClick={pair}>{busy ? "Pairing…" : "Pair watch & generate token"}</button>
      {token && <><p style={styles.label}>One-time device token — copy it now</p><textarea readOnly value={token} style={{ ...styles.input, minHeight: 90, wordBreak: "break-all" }} /><button style={styles.secondary} onClick={() => navigator.clipboard.writeText(token)}>Copy token</button></>}
      {message && <p style={styles.message}>{message}</p>}
    </section>
    <section style={styles.card}><h2 style={styles.heading}>Paired devices</h2>
      {devices.length ? devices.map(d => <div key={d.device_id} style={styles.row}><div><strong>{d.device_name}</strong><div style={styles.muted}>{d.device_id}</div></div><span>{d.last_seen_at ? "Last seen " + new Date(d.last_seen_at).toLocaleString("en-IN") : "Waiting for first reading"}</span></div>) : <p style={styles.muted}>No paired devices yet.</p>}
    </section>
    <section style={styles.card}><h2 style={styles.heading}>Latest sensor readings</h2>
      {readings.length ? readings.map(r => <div key={r.id} style={styles.row}><div><strong>{r.device_id}</strong><div style={styles.muted}>{new Date(r.recorded_at).toLocaleString("en-IN")}</div></div><span>{r.temperature_c ?? "—"} °C · {r.humidity_percent ?? "—"}% humidity · {r.bpm ?? "—"} BPM · SpO₂ {r.spo2 ?? "—"}%</span></div>) : <p style={styles.muted}>Waiting for your watch to send its first reading.</p>}
    </section>
    <p style={styles.muted}>API endpoint: <code>/api/watch</code> · HTTPS POST · JSON</p>
  </main>;
}

const styles: Record<string, React.CSSProperties> = {
  wrap: { maxWidth: 900, margin: "0 auto", padding: "48px 22px", color: "#e8eee9", minHeight: "100vh", background: "#0b100e" },
  title: { fontSize: 34, margin: "18px 0 8px" }, heading: { fontSize: 21, marginTop: 0 },
  muted: { color: "#a4b3aa", lineHeight: 1.6 }, link: { color: "#9bd8ad", textDecoration: "none" },
  card: { background: "#151d19", border: "1px solid #2c3b32", borderRadius: 16, padding: 22, marginTop: 18 },
  label: { display: "block", fontSize: 13, margin: "12px 0 7px", color: "#c7d5cb" },
  input: { width: "100%", boxSizing: "border-box", background: "#0d1511", color: "#fff", border: "1px solid #3a4b40", borderRadius: 9, padding: 12 },
  button: { marginTop: 16, background: "#a4ddb2", color: "#102016", border: 0, borderRadius: 9, padding: "12px 18px", fontWeight: 700, cursor: "pointer" },
  secondary: { marginTop: 8, background: "transparent", color: "#a4ddb2", border: "1px solid #54745e", borderRadius: 9, padding: "9px 14px" },
  message: { color: "#b9e7c5", marginTop: 12 }, row: { display: "flex", justifyContent: "space-between", gap: 16, padding: "13px 0", borderBottom: "1px solid #2a3830", flexWrap: "wrap" }
};
