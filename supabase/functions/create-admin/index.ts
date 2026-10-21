import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const jsonHeaders = { "Content-Type": "application/json; charset=utf-8" };

function response(status: number, payload: Record<string, unknown>) {
  return new Response(JSON.stringify(payload), { status, headers: jsonHeaders });
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return response(405, { error: "Método não permitido" });

  const authorization = request.headers.get("Authorization") || "";
  if (!authorization.startsWith("Bearer ")) return response(401, { error: "Sessão não autenticada" });

  const url = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const callerClient = createClient(url, anonKey, { global: { headers: { Authorization: authorization } } });
  const adminClient = createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: userData, error: userError } = await callerClient.auth.getUser();
  if (userError || !userData.user) return response(401, { error: "Sessão inválida ou expirada" });

  const { data: caller } = await adminClient.from("profiles").select("global_role,is_active").eq("id", userData.user.id).maybeSingle();
  if (!caller?.is_active || caller.global_role !== "master_admin") {
    return response(403, { error: "Somente um administrador master pode criar administradores" });
  }

  let body: Record<string, unknown>;
  try { body = await request.json(); }
  catch { return response(400, { error: "JSON inválido" }); }

  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  const name = String(body.name || "").trim();
  const accessLevel = body.accessLevel === "master_admin" ? "master_admin" : "company_admin";
  const companyId = String(body.companyId || "").trim();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return response(400, { error: "Informe um e-mail válido" });
  if (name.length < 2 || name.length > 120) return response(400, { error: "Informe o nome do administrador" });
  if (password.length < 10 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password)) {
    return response(400, { error: "A senha precisa ter 10 caracteres, letra maiúscula, minúscula e número" });
  }
  if (accessLevel === "company_admin" && !companyId) return response(400, { error: "Selecione a empresa do administrador" });

  const { data: created, error: createError } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { name }
  });
  if (createError || !created.user) return response(400, { error: createError?.message || "Não foi possível criar o administrador" });

  try {
    const { error: profileError } = await adminClient.from("profiles").update({
      name,
      global_role: accessLevel === "master_admin" ? "master_admin" : "user",
      is_active: true,
      updated_at: new Date().toISOString()
    }).eq("id", created.user.id);
    if (profileError) throw profileError;

    if (accessLevel === "company_admin") {
      const { error: memberError } = await adminClient.from("company_members").insert({
        company_id: companyId,
        user_id: created.user.id,
        role: "admin",
        is_active: true,
        invited_by: userData.user.id
      });
      if (memberError) throw memberError;
    }
  } catch (error) {
    await adminClient.auth.admin.deleteUser(created.user.id);
    return response(400, { error: error instanceof Error ? error.message : "Não foi possível atribuir o acesso" });
  }

  return response(201, {
    user: { id: created.user.id, email, name, accessLevel, companyId: companyId || null }
  });
});
