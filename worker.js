const LIMITS = { name: 80, contact: 120, vehicle: 40, service: 40, date: 10, time: 40, notes: 600 };

const VEHICLES = ['Sedan / Coupe', 'SUV / Crossover', 'Truck / Minivan'];
const SERVICES = ['Wash & Shine', 'Deep Clean', 'Full Detail'];
const TIMES = ['Morning (8-11am)', 'Midday (11am-2pm)', 'Afternoon (2-5pm)', 'Evening (5-7pm)'];

const MAX_BODY = 8192;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/book') {
      if (request.method !== 'POST') {
        return json({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
      }
      return handleBooking(request, env);
    }

    return env.ASSETS.fetch(request);
  }
};

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers
    }
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

function formatDay(value) {
  const date = new Date(value + 'T12:00:00Z');
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC'
  });
}

async function handleBooking(request, env) {
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) {
    return json({ error: 'forbidden' }, 403);
  }

  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.includes('application/json')) {
    return json({ error: 'bad_content_type' }, 415);
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY) return json({ error: 'too_large' }, 413);

  let body;
  try {
    body = JSON.parse(raw);
  } catch (error) {
    return json({ error: 'bad_json' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'bad_json' }, 400);
  }

  const str = (value) => (typeof value === 'string' ? value.trim() : '');

  // Hidden honeypot: bots fill it, people never see it.
  if (str(body.company)) return json({ ok: true });

  const data = {
    name: str(body.name),
    contact: str(body.contact),
    vehicle: str(body.vehicle),
    service: str(body.service),
    date: str(body.date),
    time: str(body.time),
    notes: str(body.notes)
  };

  const errors = {};
  for (const key of Object.keys(LIMITS)) {
    if (data[key].length > LIMITS[key]) errors[key] = 'too_long';
  }
  if (!data.name) errors.name = 'required';
  if (!data.contact) errors.contact = 'required';
  if (!VEHICLES.includes(data.vehicle)) errors.vehicle = 'invalid';
  if (!SERVICES.includes(data.service)) errors.service = 'invalid';
  if (!TIMES.includes(data.time)) errors.time = 'invalid';

  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date) || Number.isNaN(Date.parse(data.date))) {
    errors.date = 'invalid';
  } else if (data.date < new Date().toISOString().slice(0, 10)) {
    errors.date = 'past';
  }

  if (Object.keys(errors).length) {
    return json({ error: 'invalid', fields: errors }, 422);
  }

  if (!env.RESEND_API_KEY || !env.BOOKING_EMAIL) {
    return json({ error: 'not_configured' }, 503);
  }

  const day = formatDay(data.date);
  const emailContact = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.contact) ? data.contact : null;

  const rows = [
    ['Name', data.name],
    ['Contact', data.contact],
    ['Vehicle', data.vehicle],
    ['Service', data.service],
    ['Preferred date', day],
    ['Preferred time', data.time]
  ];

  const text = [
    'New booking request',
    '',
    ...rows.map(([label, value]) => label + ': ' + value),
    ...(data.notes ? ['', 'Notes:', data.notes] : []),
    '',
    'Sent from the Clean Detailing booking form.'
  ].join('\n');

  const html = [
    '<div style="font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#0F151B">',
    '<h2 style="margin:0 0 16px;font-size:20px">New booking request</h2>',
    '<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse">',
    ...rows.map(([label, value]) =>
      '<tr><td style="padding:4px 16px 4px 0;color:#5b6670">' + escapeHtml(label) +
      '</td><td style="padding:4px 0;font-weight:600">' + escapeHtml(value) + '</td></tr>'
    ),
    '</table>',
    data.notes
      ? '<p style="margin:16px 0 0;white-space:pre-wrap">' + escapeHtml(data.notes) + '</p>'
      : '',
    '<p style="margin:24px 0 0;color:#5b6670;font-size:13px">Sent from the Clean Detailing booking form.</p>',
    '</div>'
  ].join('');

  const payload = {
    from: env.BOOKING_FROM || 'Clean Detailing <onboarding@resend.dev>',
    to: [env.BOOKING_EMAIL],
    subject: 'Booking request: ' + data.service + ' - ' + data.vehicle + ' - ' + day,
    text,
    html
  };
  if (emailContact) payload.reply_to = emailContact;

  let response;
  try {
    response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + env.RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
  } catch (error) {
    return json({ error: 'send_failed' }, 502);
  }

  if (!response.ok) {
    const status = response.status === 429 ? 429 : 502;
    return json({ error: response.status === 429 ? 'rate_limited' : 'send_failed' }, status);
  }

  return json({ ok: true });
}
