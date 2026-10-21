const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD || (await new Promise((resolve, reject) => {
  let value = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    value += chunk;
    if (/\r?\n/.test(value)) {
      process.stdin.pause();
      resolve(value.split(/\r?\n/, 1)[0].trim());
    }
  });
  process.stdin.on('end', () => resolve(value.trim()));
  process.stdin.on('error', reject);
}));
const name = String(process.env.ADMIN_NAME || 'Administrador master').trim();
const supabaseUrl = process.env.SUPABASE_URL;
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;

if (!email || !password || !supabaseUrl || !publishableKey) {
  throw new Error('Missing master credentials or Supabase public configuration.');
}

const response = await fetch(`${supabaseUrl}/auth/v1/signup`, {
  method: 'POST',
  headers: {
    apikey: publishableKey,
    Authorization: `Bearer ${publishableKey}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ email, password, data: { name } })
});

const payload = await response.json().catch(() => ({}));
if (!response.ok && !String(payload?.msg || payload?.message || '').toLowerCase().includes('already')) {
  throw new Error(`Supabase Auth signup failed (${response.status}): ${payload?.msg || payload?.message || 'unknown error'}`);
}

console.log(JSON.stringify({
  status: response.status,
  userId: payload?.user?.id || null,
  email: payload?.user?.email || email,
  sessionCreated: Boolean(payload?.session),
  existing: !response.ok
}));
