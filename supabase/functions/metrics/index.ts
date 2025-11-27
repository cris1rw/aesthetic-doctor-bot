/// <reference path="./src/global.d.ts" />
// deno-lint-ignore-file no-explicit-any
import postgres from 'https://deno.land/x/postgresjs@v3.4.3/mod.js';

type MetricKey =
  | 'treatments_daily'
  | 'patients_totals'
  | 'treatments_per_patient'
  | 'photos_per_treatment'
  | 'comparisons_summary'
  | 'comparisons_daily'
  | 'comparisons_exports_recent'
  | 'doctor_activity';

type MetricRunner = (sql: ReturnType<typeof postgres>) => Promise<any>;

const DB_URL = Deno.env.get('SUPABASE_DB_URL') ?? '';
const BOT_TOKEN = Deno.env.get('BOT_METRICS_TOKEN') ?? '';

if (!DB_URL) {
  throw new Error('Missing SUPABASE_DB_URL secret for metrics function');
}

if (!BOT_TOKEN) {
  throw new Error('Missing BOT_METRICS_TOKEN secret for metrics function');
}

const metricRunners: Record<MetricKey, MetricRunner> = {
  async treatments_daily(sql) {
    return sql/*sql*/`
      SELECT
        u.id        AS medico_id,
        u.nome      AS nome,
        u.cognome   AS cognome,
        DATE(t.created_at) AS giorno,
        COUNT(*)::int AS trattamenti
      FROM public.treatments t
      JOIN public.users u ON u.id = t.owner_user_id
      WHERE t.created_at >= NOW() - INTERVAL '60 days'
      GROUP BY u.id, u.nome, u.cognome, giorno
      ORDER BY giorno DESC, trattamenti DESC;
    `;
  },

  async patients_totals(sql) {
    return sql/*sql*/`
      SELECT
        u.id      AS medico_id,
        u.nome    AS nome,
        u.cognome AS cognome,
        COUNT(*)::int AS pazienti_totali
      FROM public.patients p
      JOIN public.users u ON u.id = p.owner_user_id
      GROUP BY u.id, u.nome, u.cognome
      ORDER BY pazienti_totali DESC;
    `;
  },

  async treatments_per_patient(sql) {
    return sql/*sql*/`
      SELECT
        p.id         AS patient_id,
        p.nome       AS paziente_nome,
        p.cognome    AS paziente_cognome,
        u.id         AS medico_id,
        u.nome       AS nome,
        u.cognome    AS cognome,
        COUNT(t.*)::int AS trattamenti_per_paziente
      FROM public.patients p
      LEFT JOIN public.treatments t ON t.patient_id = p.id
      JOIN public.users u ON u.id = p.owner_user_id
      GROUP BY p.id, p.nome, p.cognome, u.id, u.nome, u.cognome
      ORDER BY trattamenti_per_paziente DESC
      LIMIT 100;
    `;
  },

  async photos_per_treatment(sql) {
    return sql/*sql*/`
      SELECT
        t.id         AS treatment_id,
        u.id         AS medico_id,
        u.nome       AS nome,
        u.cognome    AS cognome,
        COUNT(ph.*)::int AS foto_totali,
        COUNT(*) FILTER (WHERE ph.tag = 'before')::int AS foto_before,
        COUNT(*) FILTER (WHERE ph.tag = 'after')::int  AS foto_after,
        COUNT(*) FILTER (WHERE ph.tag = 'other')::int  AS foto_other
      FROM public.treatments t
      LEFT JOIN public.photos ph ON ph.treatment_id = t.id
      JOIN public.users u ON u.id = t.owner_user_id
      GROUP BY t.id, u.id, u.nome, u.cognome
      ORDER BY foto_totali DESC
      LIMIT 100;
    `;
  },

  async comparisons_summary(sql) {
    return sql/*sql*/`
      SELECT
        c.owner_user_id AS medico_id,
        u.nome,
        u.cognome,
        COUNT(*)::int AS comparisons_totali,
        COUNT(*) FILTER (WHERE c.status = 'draft')::int AS comparisons_incomplete,
        COUNT(*) FILTER (WHERE c.status = 'final')::int AS comparisons_complete,
        COALESCE(SUM(COALESCE((c.export_meta->>'exportCount')::int, 0)), 0)::int AS export_totali,
        MAX((c.export_meta->>'lastExportTs')::timestamptz) AS ultimo_export
      FROM public.comparisons c
      JOIN public.users u ON u.id = c.owner_user_id
      GROUP BY c.owner_user_id, u.nome, u.cognome
      ORDER BY comparisons_totali DESC;
    `;
  },

  async comparisons_daily(sql) {
    return sql/*sql*/`
      SELECT
        DATE(created_at) AS giorno,
        COUNT(*)::int    AS comparisons_creati
      FROM public.comparisons
      WHERE created_at >= NOW() - INTERVAL '60 days'
      GROUP BY giorno
      ORDER BY giorno DESC;
    `;
  },

  async comparisons_exports_recent(sql) {
    return sql/*sql*/`
      SELECT
        c.id                  AS comparison_id,
        c.owner_user_id       AS medico_id,
        u.nome,
        u.cognome,
        COALESCE((c.export_meta->>'exportCount')::int, 0)::int AS export_count,
        (c.export_meta->>'lastExportTs')::timestamptz AS last_export_ts
      FROM public.comparisons c
      JOIN public.users u ON u.id = c.owner_user_id
      WHERE (c.export_meta->>'lastExportTs')::timestamptz >= NOW() - INTERVAL '30 days'
      ORDER BY last_export_ts DESC NULLS LAST
      LIMIT 100;
    `;
  },

  async doctor_activity(sql) {
    return sql/*sql*/`
      WITH patient_counts AS (
        SELECT owner_user_id, COUNT(*) AS total_pazienti
        FROM public.patients
        GROUP BY owner_user_id
      ),
      treatment_counts AS (
        SELECT owner_user_id, COUNT(*) AS total_trattamenti
        FROM public.treatments
        GROUP BY owner_user_id
      ),
      photo_counts AS (
        SELECT owner_user_id, COUNT(*) AS total_foto
        FROM public.photos
        GROUP BY owner_user_id
      )
      SELECT
        COALESCE(u.nome, '—')    AS nome,
        COALESCE(u.cognome, '—') AS cognome,
        COALESCE(u.nome, u.email, '—') AS medico,
        COALESCE(pc.total_pazienti, 0)::int    AS pazienti_aggiunti,
        COALESCE(tc.total_trattamenti, 0)::int AS trattamenti_aggiunti,
        COALESCE(fc.total_foto, 0)::int        AS foto_caricate
      FROM public.users u
      LEFT JOIN patient_counts  pc ON pc.owner_user_id  = u.id
      LEFT JOIN treatment_counts tc ON tc.owner_user_id = u.id
      LEFT JOIN photo_counts    fc ON fc.owner_user_id  = u.id
      WHERE COALESCE(pc.total_pazienti, 0)
          + COALESCE(tc.total_trattamenti, 0)
          + COALESCE(fc.total_foto, 0) > 0
      ORDER BY foto_caricate DESC, trattamenti_aggiunti DESC, pazienti_aggiunti DESC
      LIMIT 100;
    `;
  },
};

const unavailableMetrics = [
  'app_opens_per_day (nessun evento di sessione registrato)',
  'patients_or_treatments_incomplete (manca stato draft/completion)',
];

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

Deno.serve(async (req) => {
  if (req.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const url = new URL(req.url);
  if (url.pathname !== '/metrics') {
    return new Response('Not Found', { status: 404 });
  }

  const providedToken = req.headers.get('x-bot-token') ?? '';
  if (providedToken !== BOT_TOKEN) {
    return unauthorizedResponse();
  }

  const requested = url.searchParams.get('metrics');
  const metricKeys: MetricKey[] = requested
    ? Array.from(
        new Set(
          requested
            .split(',')
            .map((key) => key.trim())
            .filter((key): key is MetricKey => key in metricRunners),
        ),
      )
    : (Object.keys(metricRunners) as MetricKey[]);

  if (metricKeys.length === 0) {
    return new Response(
      JSON.stringify({
        error: 'No valid metrics requested',
        allowed: Object.keys(metricRunners),
      }),
      {
        status: 400,
        headers: { 'content-type': 'application/json' },
      },
    );
  }

  const sql = createSqlClient();

  try {
    const results: Record<string, unknown> = {};

    for (const key of metricKeys) {
      const runner = metricRunners[key];
      results[key] = await runner(sql);
    }

    return new Response(
      JSON.stringify({
        generated_at: new Date().toISOString(),
        metrics: results,
        unavailable: unavailableMetrics,
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    );
  } catch (error) {
    console.error('Metrics function error', error);
    return new Response(
      JSON.stringify({ error: 'Metrics query failed', details: String(error) }),
      {
        status: 500,
        headers: { 'content-type': 'application/json' },
      },
    );
  } finally {
    await sql.end({ timeout: 5 }).catch((endErr: unknown) => {
      console.error('Error closing SQL connection', endErr);
    });
  }
});

