import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

function json(status: number, payload: Record<string, unknown>) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function encodeBase64(bytes: Uint8Array) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function decodeBase64(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

Deno.serve(async request => {
  if (!["GET", "PUT", "POST", "DELETE"].includes(request.method)) return json(405, { error: "Método não permitido" });
  const suppliedKey = request.headers.get("x-atenva-sync-key") || "";
  if (suppliedKey.length < 32) return json(401, { error: "Credencial ausente" });

  const client = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const { data: credentials, error: credentialError } = await client
    .from("app_sync_credentials")
    .select("secret_hash")
    .in("id", ["vercel-primary", "cloudrun-primary"]);
  if (credentialError) return json(500, { error: "Falha ao validar credencial" });
  const suppliedHash = await sha256(suppliedKey);
  if (!credentials?.some(credential => credential.secret_hash === suppliedHash)) {
    return json(403, { error: "Credencial inválida" });
  }

  const company = new URL(request.url).searchParams.get("company")?.trim() || "atenva-demo";
  if (!/^[a-z0-9-]{2,80}$/.test(company)) return json(400, { error: "Empresa inválida" });
  const action = new URL(request.url).searchParams.get("action") || "";

  if (request.method === "POST" && action === "acquire") {
    const body = await request.json().catch(() => ({}));
    const owner = typeof body?.owner === "string" ? body.owner : crypto.randomUUID();
    const { data, error } = await client.rpc("acquire_snapshot_lease", {
      p_company_key: company,
      p_holder: owner,
      p_lease_seconds: 300
    });
    if (error) return json(500, { error: "Falha ao reservar snapshot" });
    const lease = data?.[0]?.lease_token;
    if (!lease) return json(423, { error: "Snapshot ocupado" });
    return json(200, { lease, version: data[0].snapshot_version });
  }

  const leaseToken = request.headers.get("x-atenva-snapshot-lease") || "";
  if (request.method === "DELETE" && action === "release") {
    if (!leaseToken) return json(400, { error: "Reserva ausente" });
    const { data, error } = await client.rpc("release_snapshot_lease", {
      p_company_key: company,
      p_lease_token: leaseToken
    });
    if (error) return json(500, { error: "Falha ao liberar snapshot" });
    return json(data ? 200 : 404, { released: Boolean(data) });
  }

  if (request.method === "GET") {
    let query = client.from("app_snapshots").select("database_base64,lock_token,lock_expires_at").eq("company_key", company);
    if (leaseToken) query = query.eq("lock_token", leaseToken).gt("lock_expires_at", new Date().toISOString());
    const { data, error } = await query.maybeSingle();
    if (error) return json(500, { error: error.message });
    if (!data) return json(404, { error: "Snapshot ainda não criado" });
    return new Response(decodeBase64(data.database_base64), { headers: { "content-type": "application/octet-stream", "cache-control": "no-store" } });
  }

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length < 100 || bytes.length > 15_000_000) return json(413, { error: "Tamanho de banco inválido" });
  const signature = new TextDecoder().decode(bytes.subarray(0, 15));
  if (signature !== "SQLite format 3") return json(400, { error: "Arquivo SQLite inválido" });
  if (!leaseToken) return json(409, { error: "Gravação sem reserva distribuída" });
  const { data: current, error: currentError } = await client.from("app_snapshots")
    .select("version").eq("company_key", company).eq("lock_token", leaseToken)
    .gt("lock_expires_at", new Date().toISOString()).maybeSingle();
  if (currentError) return json(500, { error: currentError.message });
  if (!current) return json(409, { error: "Reserva expirada ou inválida" });
  const { error } = await client.from("app_snapshots").update({
    database_base64: encodeBase64(bytes),
    byte_size: bytes.length,
    version: Number(current.version || 0) + 1,
    updated_at: new Date().toISOString()
  }).eq("company_key", company).eq("lock_token", leaseToken);
  if (error) return json(500, { error: error.message });
  return json(200, { saved: true, bytes: bytes.length });
});
