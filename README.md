# Aesthetic Doctor Telegram Bot

Companion bot for the Aesthetic Doctor mobile app. It shares the same Supabase infrastructure while keeping a strict separation of environments and credentials.

## Getting Started

1. Copy `.env.example` to one of the following (all gitignored):
   - `.env.local` → local development (defaults to preview database host)
   - `.env.preview` → remote staging/preview deployment
   - `.env.production` → production deployment

2. Fill the placeholders:
   - `ENVIRONMENT` must be `development`, `preview`, or `production`.
   - `SUPABASE_URL` must match the allowed host for the chosen environment:
     - preview hosts: `https://slxpygkptdrcgnssulqe.supabase.co`
     - production host: `https://mbyxybyisqbxgxdpdmav.supabase.co`
   - `SUPABASE_ANON_KEY`: use the anon key for that environment (never commit service-role keys).
   - `TELEGRAM_BOT_TOKEN`: retrieve from @BotFather.
   - `METRICS_ENDPOINT` / `METRICS_BOT_TOKEN`: required if you want the `/metrics` Telegram command to proxy the Supabase Edge Function.

3. Install dependencies and run the bot with long polling:

```bash
npm install
npm run dev
```

The guard rails in `src/env.ts` will throw if you attempt to connect a non-production environment to the production Supabase host or if preview is misconfigured.

## Scripts

- `npm run dev` – start the bot with `tsx watch` for local development.
- `npm run build` / `npm start` – compile to `dist/` and run the compiled bot (production).
- `npm run env:doctor` – print the currently configured environment and Supabase host.
- `npm run env:test-guard` – execute the guard-rail test suite.
- `npm test` – run all Vitest suites.

## Deployment Notes

- **Development**: run locally with polling. Only preview/staging data should be used here.
- **Preview**: deploy to your staging hosting provider (Railway/Fly/etc.) with `ENVIRONMENT=preview` and the preview Supabase anon key.
- **Production**: separate deployment pointing to `mbyxybyisqbxgxdpdmav.supabase.co`. Ensure CI/CD pipelines export the correct env vars; never mix hosts across environments.

Future steps (dashboard integration, RPC calls, webhook deployments) can reuse the guard-rail utilities and Supabase client defined here. Update the README when you introduce additional workflows (e.g., GitHub Actions, Cloud Run, or Telegram webhooks).

## Metrics Edge Function

1. Deploy the Supabase Edge Function defined at the project root (`index.ts`) with a service-role connection string exported as `SUPABASE_DB_URL` and the shared secret `BOT_METRICS_TOKEN` (`supabase functions deploy metrics ...`).
2. Set `METRICS_ENDPOINT` to the deployed URL (e.g. `https://<project>.functions.supabase.co/metrics`) and reuse the same `BOT_METRICS_TOKEN` value in your bot environment as `METRICS_BOT_TOKEN`.
3. In Telegram, usa i comandi rapidi (impostati tramite `setMyCommands`):
   - `/metrics` → JSON completo (opzionalmente limita le metriche scrivendole dopo il comando).
   - `/metrics_text` → riassunto testuale.
   - `/metrics_csv` → CSV allegato.
   - `/metrics_chart` → grafico PNG per `treatments_daily` o `comparisons_daily`.
   - `/doctor_activity` → mostra per ogni medico pazienti/trattamenti/foto caricati.

Tutti i comandi (tranne `/doctor_activity`, che è già focalizzato) accettano parametri aggiuntivi (es. `/metrics_csv treatments_daily comparisons_summary`) per includere solo i dataset desiderati.

