import { Bot, Context, InputFile } from 'grammy';

import { env } from './env';
import { logger } from './logger';

const METRIC_KEYS = [
  'treatments_daily',
  'patients_totals',
  'treatments_per_patient',
  'photos_per_treatment',
  'comparisons_summary',
  'comparisons_daily',
  'comparisons_exports_recent'
] as const;

type MetricKey = (typeof METRIC_KEYS)[number];

type MetricsResponse = {
  generated_at: string;
  metrics: Record<string, unknown>;
  unavailable?: unknown;
};
type MetricRow = Record<string, any>;

const METRICS_FORMATS = ['json', 'text', 'csv', 'chart'] as const;
type MetricsFormat = (typeof METRICS_FORMATS)[number];

const CHARTABLE_METRICS = new Set<MetricKey>(['treatments_daily', 'comparisons_daily']);

export function createBot(): Bot<Context> {
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

  bot.api
    .setMyCommands([
      {
        command: 'metrics_text',
        description: 'Ti invio un mini-report leggibile con i trend principali'
      },
      {
        command: 'metrics_csv',
        description: 'Scarica un CSV pronto per Excel con i dataset richiesti'
      },
      {
        command: 'metrics_chart',
        description: 'Genera il grafico giornaliero di trattamenti o comparisons'
      }
    ])
    .catch((error) => logger.error({ err: error }, 'Failed to set bot commands'));

  bot.command('start', async (ctx) => {
    await ctx.reply('Benvenuto nel bot Aesthetic Doctor. Usa /ping per il check.');
  });

  bot.command('ping', async (ctx) => {
    await ctx.reply('pong');
  });

  bot.command('metrics', (ctx) => handleMetricsCommand(ctx));
  bot.command('metrics_text', (ctx) => handleMetricsCommand(ctx, { forcedFormat: 'text' }));
  bot.command('metrics_csv', (ctx) => handleMetricsCommand(ctx, { forcedFormat: 'csv' }));
  bot.command('metrics_chart', (ctx) => handleMetricsCommand(ctx, { forcedFormat: 'chart' }));

  bot.on('message', async (ctx) => {
    const username = ctx.from?.username ? `@${ctx.from.username}` : ctx.from?.first_name ?? 'utente';
    await ctx.reply(
      [
        `Ciao ${username}!`,
        '(al momento i dati sono di test e le view sono worki in progress, lo so che è tutto un po\' da sistemare)',
        'Puoi usare i comandi: ',
        '- /metrics_text → mini-report leggibile',
        '- /metrics_csv → CSV per Excel',
        '- /metrics_chart → grafico giornaliero'
      ].join('\n')
    );
  });

  bot.catch((error) => {
    logger.error(
      {
        update: error.ctx.update,
        err: error.error
      },
      'Telegram bot error'
    );
  });

  return bot;
}

async function handleMetricsCommand(
  ctx: Context,
  options?: {
    forcedFormat?: MetricsFormat;
  }
): Promise<void> {
    const metricsEndpoint = env.METRICS_ENDPOINT;
    const metricsToken = env.METRICS_BOT_TOKEN;

    if (!metricsEndpoint || !metricsToken) {
      await ctx.reply(
        'La funzione metrics non è configurata (METRICS_ENDPOINT / METRICS_BOT_TOKEN mancanti).'
      );
      return;
    }

    const rawMatch = ctx.match;
    const matchInput = typeof rawMatch === 'string' ? rawMatch : rawMatch?.[0] ?? '';
    const { format, metrics } = parseCommandOptions(matchInput, options?.forcedFormat);
    const requestedKeys = metrics.length > 0 ? metrics : [...METRIC_KEYS];

    try {
      const payload = await fetchMetrics(metricsEndpoint, metricsToken, requestedKeys);
      if (format === 'text') {
        const summary = formatTextSummary(payload, requestedKeys);
        await ctx.reply(summary);
        return;
      }

      if (format === 'csv') {
        const { buffer, fileName } = buildCsvDocument(payload, requestedKeys);
        await ctx.replyWithDocument(new InputFile(buffer, fileName), {
          caption: `CSV metriche: ${requestedKeys.join(', ')}`
        });
        return;
      }

      if (format === 'chart') {
        const chartMetric = requestedKeys.find((key) => CHARTABLE_METRICS.has(key));
        if (!chartMetric) {
          await ctx.reply(
            `Per il formato chart specifica una metrica supportata (${Array.from(CHARTABLE_METRICS).join(', ')})`
          );
          return;
        }
        const chart = await generateChart(chartMetric, payload);
        await ctx.replyWithPhoto(new InputFile(chart.buffer, chart.fileName), {
          caption: chart.caption
        });
        return;
      }

      const pretty = JSON.stringify(payload, null, 2);
      const buffer = Buffer.from(pretty, 'utf-8');
      const timestamp = payload.generated_at ?? new Date().toISOString();
      const fileName = `metrics-${timestamp.replace(/[:.]/g, '-')}.json`;

      await ctx.replyWithDocument(new InputFile(buffer, fileName), {
        caption: [
          `Metriche richieste: ${requestedKeys.join(', ')}`,
          `Formato: JSON`,
          `Generato: ${new Date(timestamp).toLocaleString('it-IT')}`
        ].join('\n')
      });
    } catch (error) {
      logger.error({ err: error }, 'Failed to fetch metrics');
      await ctx.reply('Impossibile recuperare le metriche al momento, riprova più tardi.');
    }
}

function parseCommandOptions(
  rawInput: string,
  forcedFormat?: MetricsFormat
): { format: MetricsFormat; metrics: MetricKey[] } {
  const tokens = rawInput
    .split(/[,\s]+/)
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);

  let format: MetricsFormat = forcedFormat ?? 'json';
  const metricTokens: string[] = [];

  for (const token of tokens) {
    if (!forcedFormat && format === 'json' && METRICS_FORMATS.includes(token as MetricsFormat)) {
      format = token as MetricsFormat;
      continue;
    }
    metricTokens.push(token);
  }

  const metrics = parseMetricTokens(metricTokens);
  return { format, metrics };
}

function parseMetricTokens(tokens: string[]): MetricKey[] {
  const deduped = Array.from(new Set(tokens));
  const valid = deduped.filter((token): token is MetricKey => METRIC_KEYS.includes(token as MetricKey));
  return valid;
}

async function fetchMetrics(
  endpoint: string,
  token: string,
  keys: MetricKey[]
): Promise<MetricsResponse> {
  const url = new URL(endpoint);
  if (keys.length > 0) {
    url.searchParams.set('metrics', keys.join(','));
  }

  const response = await fetch(url.toString(), {
    headers: {
      'x-bot-token': token,
      Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`
    }
  });

  if (!response.ok) {
    throw new Error(`Metrics endpoint responded with ${response.status}`);
  }

  return (await response.json()) as MetricsResponse;
}

function formatTextSummary(payload: MetricsResponse, metrics: MetricKey[]): string {
  const lines: string[] = [];
  const data = payload.metrics;

  for (const metric of metrics) {
    const rows = (data[metric] as MetricRow[]) ?? [];
    if (!rows.length) {
      lines.push(`${metric}: nessun dato disponibile`);
      continue;
    }

    switch (metric) {
      case 'treatments_daily': {
        lines.push('📅 Trattamenti giornalieri (ultimi 5):');
        const subset = rows.slice(0, 5);
        subset.forEach((row) => {
          const date = formatDate(row.giorno);
          lines.push(`  • ${date}: ${displayName(row)} → ${row.trattamenti ?? 0}`);
        });
        break;
      }
      case 'patients_totals': {
        lines.push('👩‍⚕️ Pazienti gestiti (top 5):');
        rows
          .slice(0, 5)
          .forEach((row) =>
            lines.push(`  • ${displayName(row)} → ${row.pazienti_totali ?? 0}`)
          );
        break;
      }
      case 'treatments_per_patient': {
        lines.push('🙋‍♀️ Trattamenti per paziente (top 5):');
        rows.slice(0, 5).forEach((row) => {
          lines.push(
            `  • ${row.paziente_nome ?? 'N/D'} ${row.paziente_cognome ?? ''} (${displayName(row)}) → ${row.trattamenti_per_paziente ?? 0}`
          );
        });
        break;
      }
      case 'photos_per_treatment': {
        lines.push('📷 Foto per trattamento (top 3):');
        rows.slice(0, 3).forEach((row) => {
          lines.push(
            `  • ${row.treatment_id}: tot ${row.foto_totali ?? 0} (before ${row.foto_before ?? 0}, after ${
              row.foto_after ?? 0
            })`
          );
        });
        break;
      }
      case 'comparisons_summary': {
        lines.push('🆚 Comparisons per medico (top 5):');
        rows.slice(0, 5).forEach((row) => {
          lines.push(
            `  • ${displayName(row)} → tot ${row.comparisons_totali ?? 0} (final ${row.comparisons_complete ?? 0}, draft ${row.comparisons_incomplete ?? 0})`
          );
        });
        break;
      }
      case 'comparisons_daily': {
        lines.push('📈 Comparisons giornaliere (ultimi 7 giorni):');
        rows.slice(0, 7).forEach((row) => {
          lines.push(`  • ${formatDate(row.giorno)} → ${row.comparisons_creati ?? 0}`);
        });
        break;
      }
      case 'comparisons_exports_recent': {
        lines.push('📤 Export comparisons recenti (top 5):');
        rows.slice(0, 5).forEach((row) => {
          lines.push(`  • ${displayName(row)} → ${row.last_export_ts ? formatDateTime(row.last_export_ts) : '–'}`);
        });
        break;
      }
      default:
        lines.push(`${metric}: ${rows.length} righe`);
    }

    lines.push('');
  }

  return lines.join('\n').trim() || 'Nessun dato disponibile.';
}

function buildCsvDocument(payload: MetricsResponse, metrics: MetricKey[]): {
  buffer: Buffer;
  fileName: string;
} {
  const sections: string[] = [];

  for (const metric of metrics) {
    const rows = (payload.metrics[metric] as MetricRow[]) ?? [];
    sections.push(`# ${metric}`);
    sections.push(rowsToCsv(rows));
    sections.push('');
  }

  const content = sections.join('\n').trim() || 'metric,data\nN/A,0';
  const buffer = Buffer.from(content, 'utf-8');
  const fileName = `metrics-${Date.now()}.csv`;
  return { buffer, fileName };
}

function rowsToCsv(rows: MetricRow[]): string {
  if (!rows.length) return 'n/a';
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')];

  for (const row of rows) {
    const values = headers.map((header) => serializeCsvValue(row[header]));
    lines.push(values.join(','));
  }

  return lines.join('\n');
}

function serializeCsvValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = String(value).replace(/"/g, '""');
  return `"${str}"`;
}

async function generateChart(metric: MetricKey, payload: MetricsResponse): Promise<{
  buffer: Buffer;
  caption: string;
  fileName: string;
}> {
  const rows = (payload.metrics[metric] as MetricRow[]) ?? [];
  if (!rows.length) {
    throw new Error(`Nessun dato per ${metric}`);
  }

  const { labels, data, title } = buildChartData(metric, rows);

  const chartConfig = {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: title,
          data,
          fill: true,
          borderColor: '#6366F1',
          backgroundColor: 'rgba(99,102,241,0.15)',
          tension: 0.3
        }
      ]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        title: { display: true, text: title }
      },
      scales: {
        y: { beginAtZero: true, ticks: { precision: 0 } }
      }
    }
  };

  const response = await fetch('https://quickchart.io/chart', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chart: chartConfig })
  });

  if (!response.ok) {
    throw new Error('QuickChart generation failed');
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const fileName = `${metric}-chart.png`;
  const caption = `${title} (${labels.at(-1) ?? ''})`;

  return { buffer, fileName, caption };
}

function buildChartData(metric: MetricKey, rows: MetricRow[]): {
  labels: string[];
  data: number[];
  title: string;
} {
  if (metric === 'comparisons_daily') {
    const labels = rows
      .slice()
      .reverse()
      .map((row) => formatShortDate(row.giorno as string));
    const data = rows
      .slice()
      .reverse()
      .map((row) => Number(row.comparisons_creati ?? 0));
    return { labels, data, title: 'Comparisons per giorno' };
  }

  // treatments_daily -> aggregate per giorno
  const aggregate = new Map<string, number>();
  rows.forEach((row) => {
    const day = formatShortDate(row.giorno as string);
    const current = aggregate.get(day) ?? 0;
    aggregate.set(day, current + Number(row.trattamenti ?? 0));
  });

  const entries = Array.from(aggregate.entries()).slice(-20);
  const labels = entries.map(([day]) => day);
  const data = entries.map(([, count]) => count);

  return { labels, data, title: 'Trattamenti per giorno (totali)' };
}

function displayName(row: Record<string, unknown>): string {
  const nome = row.nome ?? row.paziente_nome ?? '';
  const cognome = row.cognome ?? row.paziente_cognome ?? '';
  const fallback = row.medico_id ?? row.patient_id ?? 'N/D';
  const composed = `${nome ?? ''} ${cognome ?? ''}`.trim();
  return composed || String(fallback);
}

function formatDate(value: string | undefined): string {
  if (!value) return 'N/D';
  return new Date(value).toLocaleDateString('it-IT');
}

function formatShortDate(value: string | undefined): string {
  if (!value) return 'N/D';
  const date = new Date(value);
  return `${date.getDate()}/${date.getMonth() + 1}`;
}

function formatDateTime(value: string | undefined): string {
  if (!value) return 'N/D';
  return new Date(value).toLocaleString('it-IT');
}

