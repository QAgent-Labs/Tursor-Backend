import 'dotenv/config';
import './playwright-env';

export const config = {
  port: Number(process.env.PORT) || 9090,
  tursorAiUrl: (process.env.TURSOR_AI_URL ?? 'http://127.0.0.1:8000').replace(
    /\/$/,
    '',
  ),
  cdpHeadless: process.env.CDP_HEADLESS === 'true',
  cdpSlowMo: Number(process.env.CDP_SLOW_MO ?? 0),
  cdpStepDelayMs: Number(process.env.CDP_STEP_DELAY_MS ?? 1000),
};
