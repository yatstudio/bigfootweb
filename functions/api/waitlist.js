export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const corsHeaders = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  };

  if (!env.WAITLIST_KV) {
    return json({ ok: false, error: 'WAITLIST_KV is not configured' }, 500, corsHeaders);
  }

  if (request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: 'Invalid JSON' }, 400, corsHeaders);
    }

    const email = String(body.email || '').trim().toLowerCase();
    const source = String(body.source || 'web').slice(0, 80);
    if (!isValidEmail(email)) {
      return json({ ok: false, error: 'Please enter a valid email address.' }, 400, corsHeaders);
    }

    const now = new Date().toISOString();
    const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || '';
    const ua = request.headers.get('user-agent') || '';
    const key = `email:${email}`;
    const existingRaw = await env.WAITLIST_KV.get(key);
    const record = existingRaw ? JSON.parse(existingRaw) : {
      email,
      createdAt: now,
      firstSource: source,
      firstIp: ip,
    };
    record.updatedAt = now;
    record.source = source;
    record.ip = ip;
    record.userAgent = ua.slice(0, 240);

    await env.WAITLIST_KV.put(key, JSON.stringify(record));
    await env.WAITLIST_KV.put(`index:${now}:${email}`, email);

    return json({ ok: true }, 200, corsHeaders);
  }

  if (request.method === 'GET' && url.searchParams.get('action') === 'list') {
    const configuredPassword = env.WAITLIST_ADMIN_PASSWORD;
    if (!configuredPassword) {
      return json({ ok: false, error: 'WAITLIST_ADMIN_PASSWORD is not configured' }, 500, corsHeaders);
    }
    const password = request.headers.get('x-admin-password') || url.searchParams.get('password') || '';
    if (password !== configuredPassword) {
      return json({ ok: false, error: 'Wrong password' }, 401, corsHeaders);
    }

    const listed = await env.WAITLIST_KV.list({ prefix: 'email:', limit: 1000 });
    const items = [];
    for (const key of listed.keys) {
      const raw = await env.WAITLIST_KV.get(key.name);
      if (!raw) continue;
      try { items.push(JSON.parse(raw)); } catch {}
    }
    items.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    return json({ ok: true, items }, 200, corsHeaders);
  }

  return json({ ok: false, error: 'Not found' }, 404, corsHeaders);
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers });
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}
