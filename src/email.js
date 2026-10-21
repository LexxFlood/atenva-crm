function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

export async function sendInvitationEmail({ to, inviteUrl, inviterName, companyName, role, invitationId }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { sent: false, reason: 'email_provider_not_configured' };
  const from = process.env.EMAIL_FROM || 'Atenva <convites@atenva.com.br>';
  const roleLabel = { master: 'Master Atenva', admin: 'Administrador', manager: 'Gestor', agent: 'Atendente' }[role] || role;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': `atenva-invite-${invitationId}` },
    body: JSON.stringify({
      from, to: [to], subject: `${inviterName} convidou você para a Atenva`,
      html: `<!doctype html><html><body style="margin:0;background:#f3f7f1;font-family:Arial,sans-serif;color:#10261a"><div style="max-width:560px;margin:32px auto;background:#fff;border:1px solid #dce8dd;border-radius:18px;padding:36px"><div style="font-weight:800;font-size:24px;color:#123723">Atenva</div><p style="color:#557060">CRM IA</p><h1 style="font-size:26px">Seu acesso está pronto</h1><p><strong>${escapeHtml(inviterName)}</strong> convidou você para <strong>${escapeHtml(companyName || 'Atenva')}</strong> como ${escapeHtml(roleLabel)}.</p><p style="margin:28px 0"><a href="${escapeHtml(inviteUrl)}" style="display:inline-block;background:#123723;color:#fff;text-decoration:none;padding:14px 22px;border-radius:10px;font-weight:700">Aceitar convite</a></p><p style="font-size:13px;color:#6d7c72">Este link é individual e expira em 7 dias. Se você não esperava este convite, ignore esta mensagem.</p></div></body></html>`
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(payload.message || 'Não foi possível enviar o e-mail de convite.'), { statusCode: 502 });
  return { sent: true, id: payload.id || payload.data?.id || null };
}
