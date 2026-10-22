import { createMaxAdapter } from './max.mjs';
import { maxFetch } from './max-fetch.mjs';
import { createTelegramAdapter } from './telegram.mjs';

/** Messenger bots enabled through TELEGRAM_BOT_TOKEN and MAX_BOT_TOKEN. */
export function messengersFromEnv(env = process.env) {
  const adapters = [];
  if (env.TELEGRAM_BOT_TOKEN) adapters.push(createTelegramAdapter({ token: env.TELEGRAM_BOT_TOKEN }));
  if (env.MAX_BOT_TOKEN) adapters.push(createMaxAdapter({ token: env.MAX_BOT_TOKEN, fetchImpl: maxFetch }));
  return adapters;
}

/** DEMO_AUTH=false disables the built-in demo tokens; any other value keeps the createDetailFlowServer defaults. */
export function demoAuthOptions(env = process.env) {
  return env.DEMO_AUTH === 'false' ? { authTokens: new Map() } : {};
}
