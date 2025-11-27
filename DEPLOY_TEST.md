# Deploy Edge Function Preview Codes - Test Environment

## 1. Configura i secret nella Edge Function

Prima di deployare, assicurati di avere i secret configurati. Se non li hai ancora:

```bash
# Imposta il secret per la connection string (service-role)
supabase secrets set SUPABASE_DB_URL="postgresql://postgres:[PASSWORD]@db.slxpygkptdrcgnssulqe.supabase.co:5432/postgres" --project-ref slxpygkptdrcgnssulqe

# Imposta il token di autenticazione (puoi riutilizzare lo stesso di metrics)
supabase secrets set BOT_METRICS_TOKEN="bot_metrics_preview_6e9b0f8d1c2a" --project-ref slxpygkptdrcgnssulqe
```

**Nota**: Sostituisci `[PASSWORD]` con la password del database service-role. Puoi trovarla nel dashboard Supabase → Settings → Database → Connection string (service_role).

## 2. Deploy della Edge Function

```bash
supabase functions deploy preview-codes --project-ref slxpygkptdrcgnssulqe
```

## 3. Test dell'endpoint

Dopo il deploy, testa l'endpoint:

```bash
curl -X POST https://slxpygkptdrcgnssulqe.functions.supabase.co/preview-codes \
  -H "x-bot-token: bot_metrics_preview_6e9b0f8d1c2a" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer [SUPABASE_ANON_KEY]" \
  -d '{
    "firstName": "Test",
    "lastName": "Medico",
    "codes": ["ARC-TEST-1", "ARC-TEST-2"],
    "label": "MED",
    "ttlDays": 45
  }'
```

Dovresti ricevere una risposta JSON con `{"success": true, "inserted": 2, "codes": [...]}`.

## 4. Aggiorna le variabili del bot

Nel file `.env.local` (o `.env.preview` se usi quello) aggiungi:

```env
PREVIEW_CODES_ENDPOINT=https://slxpygkptdrcgnssulqe.functions.supabase.co/preview-codes
PREVIEW_CODES_BOT_TOKEN=bot_metrics_preview_6e9b0f8d1c2a
```

## 5. Riavvia il bot

Se stai testando in locale:
```bash
npm run dev
```

Se è su Railway, fai un redeploy o riavvia il servizio.

## 6. Test dal bot Telegram

Invia al bot:
```
/get_new_code
```

Poi segui il wizard inserendo nome e cognome. I codici dovrebbero essere salvati correttamente nella tabella `preview_one_time_codes`.

