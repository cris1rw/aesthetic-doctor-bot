import { createClient } from '@supabase/supabase-js';

import { env, extractHost } from './env';
import { logger } from './logger';

export const supabaseClient = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
  auth: { persistSession: false }
});

const host = extractHost(env.SUPABASE_URL);
logger.info({ environment: env.ENVIRONMENT, host }, 'Supabase client configured');

