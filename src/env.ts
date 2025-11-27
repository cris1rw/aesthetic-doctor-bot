import fs from 'node:fs';
import path from 'node:path';

import { config as loadEnv } from 'dotenv';
import { expand } from 'dotenv-expand';
import { z } from 'zod';

import {
  assertSupabaseHostMatchesEnv,
  EXPECTED_PREVIEW_HOST,
  EXPECTED_PROD_HOST,
  extractHost
} from './guards/supabase';

loadAndExpandEnv();

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  ENVIRONMENT: z.enum(['development', 'preview', 'production']).default('development'),
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1, 'SUPABASE_ANON_KEY must not be empty'),
  TELEGRAM_BOT_TOKEN: z.string().min(1, 'TELEGRAM_BOT_TOKEN must not be empty'),
  METRICS_ENDPOINT: z.string().url().optional(),
  METRICS_BOT_TOKEN: z.string().min(1, 'METRICS_BOT_TOKEN must not be empty').optional(),
  PREVIEW_CODES_ENDPOINT: z.string().url().optional(),
  PREVIEW_CODES_BOT_TOKEN: z.string().min(1, 'PREVIEW_CODES_BOT_TOKEN must not be empty').optional()
});

export type Env = z.infer<typeof EnvSchema>;

export const env: Env = (() => {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Invalid environment variables:\n${parsed.error.toString()}`);
  }
  assertSupabaseHostMatchesEnv(parsed.data);
  return parsed.data;
})();

export { EXPECTED_PREVIEW_HOST, EXPECTED_PROD_HOST, assertSupabaseHostMatchesEnv, extractHost };

function loadAndExpandEnv(): void {
  const candidateFiles = new Set<string>(['.env']);
  const explicit = process.env.ENV_FILE ?? process.env.BOT_ENV_FILE;
  if (explicit) {
    candidateFiles.add(explicit);
  }

  const nodeEnv = process.env.NODE_ENV ?? 'development';
  if (nodeEnv === 'development') candidateFiles.add('.env.local');
  if (nodeEnv === 'test') candidateFiles.add('.env.test');
  if (nodeEnv === 'production') candidateFiles.add('.env.production');

  (process.env.ENVIRONMENT ?? '').toLowerCase() === 'preview' &&
    candidateFiles.add('.env.preview');

  for (const file of candidateFiles) {
    const absolute = path.resolve(process.cwd(), file);
    if (!fs.existsSync(absolute)) continue;
    const loaded = loadEnv({ path: absolute });
    expand(loaded);
  }
}

