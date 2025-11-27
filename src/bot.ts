import { Bot, Context, InputFile, session, SessionFlavor, GrammyError } from 'grammy';

import { env } from './env';
import { logger } from './logger';
import { supabaseClient } from './supabaseClient';

type ArcWizardStep = 'idle' | 'await_first_name' | 'await_last_name' | 'await_fallback_confirmation';

interface ArcWizardState {
  step: ArcWizardStep;
  firstName?: string;
  lastName?: string;
  primaryCodes?: string[];
  fallbackCodes?: string[];
}

interface SessionData {
  arc: ArcWizardState;
}

type BotContext = Context & SessionFlavor<SessionData>;

const METRIC_KEYS = [
  'treatments_daily',
  'patients_totals',
  'treatments_per_patient',
  'photos_per_treatment',
  'comparisons_summary',
  'comparisons_daily',
  'comparisons_exports_recent',
  'doctor_activity'
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
const ARC_CODES_TABLE = 'preview_one_time_codes';
const ARC_CODE_LABEL = 'MED';
const ARC_CODE_TTL_DAYS = 45;
const YES_VALUES = new Set(['si', 'sì', 'yes', 'y']);
const NO_VALUES = new Set(['no', 'n']);

export function createBot(): Bot<BotContext> {
  const bot = new Bot<BotContext>(env.TELEGRAM_BOT_TOKEN);
  bot.use(
    session({
      initial: (): SessionData => ({
        arc: { step: 'idle' }
      })
    })
  );

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
      },
      {
        command: 'doctor_activity',
        description: 'Mostra il contributo di ogni medico (pazienti/tratt/foto)'
      },
      {
        command: 'get_new_code',
        description: 'Genera due codici ARC per un medico'
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
  bot.command('doctor_activity', (ctx) =>
    handleMetricsCommand(ctx, { forcedFormat: 'text', forcedMetrics: ['doctor_activity'] })
  );
  bot.command('get_new_code', async (ctx) => {
    ctx.session.arc = { step: 'await_first_name' };
    await ctx.reply('Inserisci il nome del medico:');
  });

  bot.on('message', async (ctx) => {
    const handled = await handleArcWizardMessage(ctx);
    if (handled) return;

    const username = ctx.from?.username ? `@${ctx.from.username}` : ctx.from?.first_name ?? 'utente';
    await ctx.reply(
      [
        `Ciao ${username}!`,
        '(al momento i dati sono di test e le view sono worki in progress, lo so che è tutto un po\' da sistemare)',
        'Puoi usare i comandi: ',
        '- /metrics_text → mini-report leggibile',
        '- /metrics_csv → CSV per Excel',
        '- /metrics_chart → grafico giornaliero',
        '- /doctor_activity → attività per medico',
        '- /get_new_code → genera codici ARC'
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

async function handleArcWizardMessage(ctx: BotContext): Promise<boolean> {
  const arc = ctx.session.arc ?? { step: 'idle' };
  if (arc.step === 'idle') {
    return false;
  }
  const messageText = ctx.message?.text?.trim();

  switch (arc.step) {
    case 'await_first_name': {
      if (!messageText) {
        await ctx.reply('Per favore inserisci un nome valido.');
        return true;
      }
      ctx.session.arc = { step: 'await_last_name', firstName: messageText };
      await ctx.reply('Perfetto, ora inserisci il cognome del medico:');
      return true;
    }
    case 'await_last_name': {
      if (!messageText) {
        await ctx.reply('Per favore inserisci un cognome valido.');
        return true;
      }
      const firstName = arc.firstName ?? '';
      const lastName = messageText;
      const primaryCodes = buildArcCodes(firstName, lastName, { useFirstInitial: false });
      const fallbackCodes = buildArcCodes(firstName, lastName, { useFirstInitial: true });
      const conflicts = await findExistingCodes(primaryCodes);

      if (conflicts.length === 0) {
        await respondWithArcCodes(ctx, firstName, lastName, primaryCodes);
        resetArcWizard(ctx);
        return true;
      }

      ctx.session.arc = {
        step: 'await_fallback_confirmation',
        firstName,
        lastName,
        primaryCodes,
        fallbackCodes
      };
      await ctx.reply(
        `I codici ${primaryCodes.join(', ')} risultano già esistenti. Vuoi generare i codici alternativi ${fallbackCodes.join(', ')}? Rispondi "sì" o "no".`
      );
      return true;
    }
    case 'await_fallback_confirmation': {
      if (!messageText) {
        await ctx.reply('Rispondi con "sì" o "no".');
        return true;
      }
      const normalized = messageText.toLowerCase();
      const firstName = arc.firstName ?? '';
      const lastName = arc.lastName ?? '';

      if (YES_VALUES.has(normalized)) {
        const fallbackCodes = arc.fallbackCodes ?? [];
        const conflicts = await findExistingCodes(fallbackCodes);
        if (conflicts.length > 0) {
          await ctx.reply(
            `Anche i codici alternativi ${fallbackCodes.join(', ')} esistono già. Genera manualmente un prefisso diverso.`
          );
          resetArcWizard(ctx);
          return true;
        }
        await respondWithArcCodes(ctx, firstName, lastName, fallbackCodes);
        resetArcWizard(ctx);
        return true;
      }

      if (NO_VALUES.has(normalized)) {
        await ctx.reply('Operazione annullata. Puoi ripartire con /arc.');
        resetArcWizard(ctx);
        return true;
      }

      await ctx.reply('Rispondi con "sì" oppure "no".');
      return true;
    }
    default:
      if (ctx.chat?.id) {
        try {
          await ctx.api.sendMessage(
            ctx.chat.id,
            'Workflow ARC interrotto. Usa /get_new_code per ripartire.'
          );
        } catch (error) {
          logger.warn({ err: error }, 'Failed to notify user about ARC wizard fallback');
        }
      }
      resetArcWizard(ctx);
      return true;
  }
}

function resetArcWizard(ctx: BotContext): void {
  ctx.session.arc = { step: 'idle' };
}

function buildArcCodes(firstName: string, lastName: string, options: { useFirstInitial: boolean }): string[] {
  const normalizedLast = normalizeForCode(lastName);
  const normalizedFirst = normalizeForCode(firstName);
  const base =
    options.useFirstInitial && normalizedFirst
      ? `${normalizedFirst[0]}${normalizedLast}`.replace(/^-/, '')
      : normalizedLast;
  const prefix = base || (options.useFirstInitial ? normalizedFirst || 'ARC' : 'ARC');
  return [`ARC-${prefix}-1`, `ARC-${prefix}-2`];
}

function normalizeForCode(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase();
}

async function findExistingCodes(codes: string[]): Promise<string[]> {
  if (!codes.length) return [];
  const { data, error } = await supabaseClient
    .from(ARC_CODES_TABLE)
    .select('code')
    .in('code', codes);

  if (error) {
    logger.warn({ err: error }, 'Impossibile verificare i codici ARC su Supabase');
    return [];
  }

  return (data ?? []).map((row) => row.code as string);
}

async function respondWithArcCodes(
  ctx: BotContext,
  firstName: string,
  lastName: string,
  codes: string[]
): Promise<void> {
  const payload = {
    label: ARC_CODE_LABEL,
    codes,
    ttl_days: ARC_CODE_TTL_DAYS
  };

  await ctx.reply(
    [
      `Codici generati per ${firstName} ${lastName}:`,
      JSON.stringify(payload, null, 2),
      'Copia il JSON sopra per la tua query.'
    ].join('\n')
  );

  await saveGeneratedCodes(firstName, lastName, codes);
}

async function saveGeneratedCodes(firstName: string, lastName: string, codes: string[]): Promise<void> {
  const expiresAt = new Date(Date.now() + ARC_CODE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const rows = codes.map((code) => ({
    code_plain: code,
    label: ARC_CODE_LABEL,
    expires_at: expiresAt,
    end_message: `Codice generato per ${firstName} ${lastName}`
  }));

  const { error } = await supabaseClient.from(ARC_CODES_TABLE).insert(rows);
  if (error) {
    logger.warn({ err: error }, 'Impossibile salvare i codici ARC su Supabase');
  }
}

async function handleMetricsCommand(
  ctx: BotContext,
  options?: {
    forcedFormat?: MetricsFormat;
    forcedMetrics?: MetricKey[];
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
    const requestedKeys = options?.forcedMetrics ?? (metrics.length > 0 ? metrics : [...METRIC_KEYS]);

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
  const generatedAt = payload.generated_at ? formatDateTime(payload.generated_at) : formatDateTime();

  lines.push(`📊 Snapshot generato il ${generatedAt}`);
  lines.push('');

  const data = payload.metrics;

  for (const metric of metrics) {
    const rows = (data[metric] as MetricRow[]) ?? [];
    if (!rows.length) {
      lines.push(sectionTitle(metric));
      lines.push('  • Nessun dato disponibile');
      lines.push('');
      continue;
    }

    switch (metric) {
      case 'treatments_daily': {
        lines.push('📅 Trattamenti (ultimi 7 giorni):');
        const subset = rows.slice(0, 7);
        const grouped = subset.reduce<Record<string, number>>((acc, row) => {
          const key = formatDate(row.giorno);
          acc[key] = (acc[key] ?? 0) + Number(row.trattamenti ?? 0);
          return acc;
        }, {});
        Object.entries(grouped).forEach(([day, value]) => {
          lines.push(`  • ${day}: ${value} trattamenti totali`);
        });
        break;
      }
      case 'patients_totals': {
        lines.push('👩‍⚕️ Pazienti gestiti (Top 5):');
        rows
          .slice(0, 5)
          .forEach((row) =>
            lines.push(`  • ${displayName(row)} → ${row.pazienti_totali ?? 0}`)
          );
        break;
      }
      case 'treatments_per_patient': {
        lines.push('🙋‍♀️ Trattamenti per paziente (Top 5):');
        rows.slice(0, 5).forEach((row) => {
          lines.push(
            `  • ${formatFullName(row.paziente_nome, row.paziente_cognome)} (${displayName(row)}) → ${row.trattamenti_per_paziente ?? 0}`
          );
        });
        break;
      }
      case 'photos_per_treatment': {
        lines.push('📷 Foto per trattamento (Top 3):');
        rows.slice(0, 3).forEach((row) => {
          const owner = displayName(row);
          const label = owner ? `${owner} (${shortenId(row.treatment_id)})` : shortenId(row.treatment_id);
          lines.push(
            `  • ${label}: tot ${row.foto_totali ?? 0} (before ${row.foto_before ?? 0}, after ${
              row.foto_after ?? 0
            })`
          );
        });
        break;
      }
      case 'comparisons_summary': {
        lines.push('🆚 Comparisons per medico (Top 5):');
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
        lines.push('📤 Export comparisons recenti (Top 5):');
        rows.slice(0, 5).forEach((row) => {
          lines.push(`  • ${displayName(row)} → ${row.last_export_ts ? formatDateTime(row.last_export_ts) : '–'}`);
        });
        break;
      }
      case 'doctor_activity': {
        lines.push('🧑‍⚕️ Attività per medico (Top 5 per foto):');
        rows.slice(0, 5).forEach((row) => {
          lines.push(
            `  • ${displayName(row)} → pazienti ${row.pazienti_aggiunti ?? 0}, trattamenti ${row.trattamenti_aggiunti ?? 0}, foto ${row.foto_caricate ?? 0}`
          );
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
  const nome = row.nome ?? '';
  const cognome = row.cognome ?? '';
  const fallback = row.medico_id ?? row.patient_id ?? 'N/D';
  const composed = `${nome ?? ''} ${cognome ?? ''}`.trim();
  return composed || String(fallback);
}

function formatFullName(nome: unknown, cognome: unknown): string {
  const composed = `${nome ?? ''} ${cognome ?? ''}`.trim();
  return composed || 'N/D';
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

function formatDateTime(value?: string): string {
  if (!value) return 'N/D';
  return new Date(value).toLocaleString('it-IT');
}

function shortenId(value: string | undefined, keep = 4): string {
  if (!value) return 'N/D';
  if (value.length <= keep * 2) return value;
  return `${value.slice(0, keep)}…${value.slice(-keep)}`;
}

function sectionTitle(metric: MetricKey): string {
  switch (metric) {
    case 'treatments_daily':
      return '📅 Trattamenti';
    case 'patients_totals':
      return '👩‍⚕️ Pazienti';
    case 'treatments_per_patient':
      return '🙋‍♀️ Trattamenti per paziente';
    case 'photos_per_treatment':
      return '📷 Foto per trattamento';
    case 'comparisons_summary':
      return '🆚 Comparisons per medico';
    case 'comparisons_daily':
      return '📈 Comparisons giornaliere';
    case 'comparisons_exports_recent':
      return '📤 Export Comparisons';
    default:
      return metric;
  }
}

