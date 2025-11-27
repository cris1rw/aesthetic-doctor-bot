/// <reference path="../../../../src/global.d.ts" />
// deno-lint-ignore-file no-explicit-any
import postgres from 'https://deno.land/x/postgresjs@v3.4.3/mod.js';

const DB_URL = Deno.env.get('SUPABASE_DB_URL') ?? '';
const BOT_TOKEN = Deno.env.get('BOT_METRICS_TOKEN') ?? '';

if (!DB_URL) {
  throw new Error('Missing SUPABASE_DB_URL secret for preview-codes function');
}

if (!BOT_TOKEN) {
  throw new Error('Missing BOT_METRICS_TOKEN secret for preview-codes function');
}

function createSqlClient() {
  return postgres(DB_URL, {
    prepare: false,
    idle_timeout: 20,
    max: 1,
    ssl: 'require',
  });
}

function unauthorizedResponse(message = 'Unauthorized') {
  return new Response(JSON.stringify({ error: message }), {
    status: 401,
    headers: {
      'content-type': 'application/json',
    },
  });
}

type PreviewCodeRequest = {
  firstName: string;
  lastName: string;
  codes: string[];
  label: string;
  ttlDays: number;
};

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const url = new URL(req.url);
  if (url.pathname !== '/preview-codes') {
    return new Response('Not Found', { status: 404 });
  }

  const providedToken = req.headers.get('x-bot-token') ?? '';
  if (providedToken !== BOT_TOKEN) {
    return unauthorizedResponse();
  }

  let body: PreviewCodeRequest;
  try {
    body = await req.json();
  } catch (error) {
    return new Response(
      JSON.stringify({ error: 'Invalid JSON body', details: String(error) }),
      {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }
    );
  }

  if (!body.firstName || !body.lastName || !Array.isArray(body.codes) || body.codes.length === 0) {
    return new Response(
      JSON.stringify({
        error: 'Missing required fields: firstName, lastName, codes (array)',
      }),
      {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }
    );
  }

  const sql = createSqlClient();

  try {
    const expiresAt = new Date(Date.now() + (body.ttlDays ?? 45) * 24 * 60 * 60 * 1000).toISOString();
    const label = body.label ?? 'MED';
    const endMessage = `Codice generato per ${body.firstName} ${body.lastName}`;

    for (const code of body.codes) {
      await sql`
        INSERT INTO public.preview_one_time_codes (code_plain, label, expires_at, end_message)
        VALUES (${code}, ${label}, ${expiresAt}, ${endMessage})
      `;
    }

    return new Response(
      JSON.stringify({
        success: true,
        inserted: body.codes.length,
        codes: body.codes,
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('Preview codes function error', error);
    return new Response(
      JSON.stringify({ error: 'Failed to insert codes', details: String(error) }),
      {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }
    );
  } finally {
    await sql.end({ timeout: 5 }).catch((endErr: unknown) => {
      console.error('Error closing SQL connection', endErr);
    });
  }
});

