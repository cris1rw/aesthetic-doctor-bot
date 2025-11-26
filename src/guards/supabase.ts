export const EXPECTED_PROD_HOST = 'mbyxybyisqbxgxdpdmav.supabase.co';
export const EXPECTED_PREVIEW_HOST = 'slxpygkptdrcgnssulqe.supabase.co';

export type GuardedEnv = {
  ENVIRONMENT: 'development' | 'preview' | 'production';
  SUPABASE_URL: string;
};

export function assertSupabaseHostMatchesEnv(config: GuardedEnv): void {
  const host = extractHost(config.SUPABASE_URL);

  if (config.ENVIRONMENT === 'production' && host !== EXPECTED_PROD_HOST) {
    throw new Error(
      `Production environment must use Supabase host ${EXPECTED_PROD_HOST}, received ${host}`
    );
  }

  if (config.ENVIRONMENT !== 'production' && host === EXPECTED_PROD_HOST) {
    throw new Error(`Non-production environment cannot target production host ${host}`);
  }

  if (config.ENVIRONMENT === 'preview' && host !== EXPECTED_PREVIEW_HOST) {
    throw new Error(
      `Preview environment must use Supabase host ${EXPECTED_PREVIEW_HOST}, received ${host}`
    );
  }
}

export function extractHost(urlString: string): string {
  try {
    return new URL(urlString).host;
  } catch {
    throw new Error(`Invalid SUPABASE_URL: ${urlString}`);
  }
}

