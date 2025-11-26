## `metrics` Edge Function

Endpoint serverless che esegue le query aggregate richieste dal bot/ dashboard senza esporre la service-role key.

### ✅ Cosa fa
* Esegue tutte le query di analytics (trattamenti/die, pazienti, foto, comparisons, export, ecc.) direttamente sul DB.
* Restituisce un payload JSON unico con timestamp, risultati e l’elenco delle metriche attualmente non disponibili (app-open e incompletezza flussi).
* Supporta il filtro opzionale `?metrics=...` per richiedere solo un sottoinsieme (`treatments_daily,patients_totals,...`).

### 🔐 Autenticazione
* L’handler richiede l’header `x-bot-token`.
* Il valore deve combaciare con il secret `BOT_METRICS_TOKEN` impostato nel progetto Supabase.
* In questo modo il bot non deve conoscere la service key.

### 🔧 Setup
1. **Configurare i secret**
   ```bash
   supabase secrets set \
     SUPABASE_DB_URL="postgresql://postgres:<SERVICE_PASSWORD>@db.<ref>.supabase.co:5432/postgres" \
     BOT_METRICS_TOKEN="super-long-random-token"
   ```
2. **Deploy funzione**
   ```bash
   supabase functions deploy metrics --project-ref <ref-prod>
   ```
3. **Invocazione (dal bot o terminale)**
   ```bash
   curl -X GET "https://<ref>.functions.supabase.co/metrics?metrics=treatments_daily,comparisons_summary" \
     -H "x-bot-token: $BOT_METRICS_TOKEN"
   ```

### 📌 Note
* Le query sono limitate temporalmente (60 giorni per serie giornaliere, 30 per export) e con `LIMIT 100` dove necessario per evitare payload enormi.
* Gli indicatori non tracciabili oggi vengono restituiti nel campo `unavailable` e sono documentati anche in `ZZ/ANALYTICS_GAPS.md`.
* Se in futuro serviranno nuove metriche basta estendere `metricRunners` nel file `index.ts` senza modificare il bot.

