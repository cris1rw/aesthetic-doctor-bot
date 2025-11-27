import { createBot } from './bot';
import { env } from './env';
import { logger } from './logger';

async function bootstrap(): Promise<void> {
  const bot = createBot();
  logger.info(
    {
      environment: env.ENVIRONMENT,
      nodeEnv: env.NODE_ENV
    },
    'Starting Telegram bot with long polling'
  );

  await bot.start({
    drop_pending_updates: env.NODE_ENV === 'production'
  });

  logger.info('Bot is running');
}

bootstrap().catch((error) => {
  logger.error({ err: error }, 'Failed to bootstrap bot');
  process.exit(1);
});


