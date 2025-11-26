import { describe, expect, it } from 'vitest';

import {
  assertSupabaseHostMatchesEnv,
  EXPECTED_PREVIEW_HOST,
  EXPECTED_PROD_HOST
} from '../guards/supabase';

const toUrl = (host: string) => `https://${host}`;

describe('assertSupabaseHostMatchesEnv', () => {
  it('allows production host only in production env', () => {
    expect(() =>
      assertSupabaseHostMatchesEnv({
        ENVIRONMENT: 'production',
        SUPABASE_URL: toUrl(EXPECTED_PROD_HOST)
      })
    ).not.toThrow();
  });

  it('blocks production host in preview', () => {
    expect(() =>
      assertSupabaseHostMatchesEnv({
        ENVIRONMENT: 'preview',
        SUPABASE_URL: toUrl(EXPECTED_PROD_HOST)
      })
    ).toThrow(/Non-production environment cannot target production host/);
  });

  it('enforces preview host for preview env', () => {
    expect(() =>
      assertSupabaseHostMatchesEnv({
        ENVIRONMENT: 'preview',
        SUPABASE_URL: toUrl(EXPECTED_PREVIEW_HOST)
      })
    ).not.toThrow();
  });
});

