// Central place to read environment variables.

function required(name: string) {
  const value = process.env[name]
  if (!value) {
    console.warn(`[env] Missing environment variable: ${name}`)
  }
  return value ?? ''
}

export const env = {
  PORT: Number(process.env.PORT ?? 4000),
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  CORS_ORIGIN: process.env.CORS_ORIGIN ?? 'http://localhost:3000',
  SITE_URL: process.env.SITE_URL ?? process.env.CORS_ORIGIN ?? 'http://localhost:3000',

  SUPABASE_URL: required('SUPABASE_URL'),
  SUPABASE_ANON_KEY: required('SUPABASE_ANON_KEY'),
  SUPABASE_SERVICE_ROLE_KEY: required('SUPABASE_SERVICE_ROLE_KEY'),
  // Direct Postgres connection string (Project Settings → Database →
  // Connection string in the Supabase dashboard). Only needed for
  // auto-applying src/db/schema.sql on startup — the REST API keys above
  // can't run arbitrary DDL.
  SUPABASE_DB_URL: process.env.SUPABASE_DB_URL ?? '',

  // Clé Gemini — UNIQUE clé IA du produit, ne vit que côté serveur.
  // Jamais dans le frontend, jamais commitée (voir .env.example).
  GEMINI_API_KEY: process.env.GEMINI_API_KEY ?? '',
  GEMINI_FALLBACK_ENABLED: process.env.GEMINI_FALLBACK_ENABLED ?? 'true',
  GEMINI_FALLBACK_MODEL: process.env.GEMINI_FALLBACK_MODEL ?? 'gemini-3.1-flash-image',

  // Run 6 (§8) : clé Anthropic — OPTIONNELLE et dormante. Tant qu'elle est
  // vide, l'étage DA reste sur Gemini ; posée, elle bascule le directeur
  // artistique v6 sur Claude Opus 5 (facturation SÉPARÉE du ledger Gemini).
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '',

  // Discord OAuth — notre propre app Discord Developer Portal, flux géré
  // entièrement par ce backend (pas de passage par Supabase Auth).
  DISCORD_CLIENT_ID: process.env.DISCORD_CLIENT_ID ?? '',
  DISCORD_CLIENT_SECRET: process.env.DISCORD_CLIENT_SECRET ?? '',
  // Doit correspondre exactement à une "Redirect URI" enregistrée sur
  // https://discord.com/developers/applications — ex: http://localhost:4000/profile/discord/callback
  DISCORD_REDIRECT_URI: process.env.DISCORD_REDIRECT_URI ?? '',

  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY ?? '',
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET ?? '',
  STRIPE_PRICE_CREATOR_MONTHLY: process.env.STRIPE_PRICE_CREATOR_MONTHLY ?? '',
  STRIPE_PRICE_STUDIO_MONTHLY: process.env.STRIPE_PRICE_STUDIO_MONTHLY ?? '',
  STRIPE_PRICE_PRO_MONTHLY: process.env.STRIPE_PRICE_PRO_MONTHLY ?? '',
  STRIPE_PRICE_TOPUP_10: process.env.STRIPE_PRICE_TOPUP_10 ?? '',
  STRIPE_PRICE_TOPUP_30: process.env.STRIPE_PRICE_TOPUP_30 ?? '',
  STRIPE_PRICE_TOPUP_100: process.env.STRIPE_PRICE_TOPUP_100 ?? '',
  STRIPE_PRICE_PACK_BRUSH: process.env.STRIPE_PRICE_PACK_BRUSH ?? '',
  STRIPE_PRICE_NEVA_PACK: process.env.STRIPE_PRICE_NEVA_PACK ?? '',
  PACK_BRUSH_DOWNLOAD_URL: process.env.PACK_BRUSH_DOWNLOAD_URL ?? '',
  NEVA_PACK_DOWNLOAD_URL: process.env.NEVA_PACK_DOWNLOAD_URL ?? '',
  STRIPE_PRICE_PACK_IDENTITE: process.env.STRIPE_PRICE_PACK_IDENTITE ?? '',
  STRIPE_PRICE_PACK_LANCEMENT: process.env.STRIPE_PRICE_PACK_LANCEMENT ?? '',
  STRIPE_PRICE_PACK_MARQUE: process.env.STRIPE_PRICE_PACK_MARQUE ?? '',
  PACK_IDENTITE_DOWNLOAD_URL: process.env.PACK_IDENTITE_DOWNLOAD_URL ?? '',
  PACK_LANCEMENT_DOWNLOAD_URL: process.env.PACK_LANCEMENT_DOWNLOAD_URL ?? '',
  PACK_MARQUE_DOWNLOAD_URL: process.env.PACK_MARQUE_DOWNLOAD_URL ?? '',

  RESEND_API_KEY: process.env.RESEND_API_KEY ?? '',
  NEWSLETTER_FROM_EMAIL: process.env.NEWSLETTER_FROM_EMAIL ?? '',
  NEWSLETTER_REPLY_TO_EMAIL: process.env.NEWSLETTER_REPLY_TO_EMAIL ?? '',

  ADMIN_EMAILS: process.env.ADMIN_EMAILS ?? '',
}
