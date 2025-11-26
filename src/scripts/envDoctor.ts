import { env, EXPECTED_PREVIEW_HOST, EXPECTED_PROD_HOST, extractHost } from '../env';

const host = extractHost(env.SUPABASE_URL);

console.log('--- Environment Doctor ---');
console.log(`ENVIRONMENT: ${env.ENVIRONMENT}`);
console.log(`NODE_ENV: ${env.NODE_ENV}`);
console.log(`Supabase host: ${host}`);
console.log(
  `Expected hosts => preview: ${EXPECTED_PREVIEW_HOST} | production: ${EXPECTED_PROD_HOST}`
);

