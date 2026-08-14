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

  GEMINI_API_KEY: process.env.GEMINI_API_KEY ?? '',
  GEMINI_FALLBACK_ENABLED: process.env.GEMINI_FALLBACK_ENABLED ?? 'true',
  GEMINI_FALLBACK_MODEL: process.env.GEMINI_FALLBACK_MODEL ?? 'gemini-3.1-flash-image',
  GOOGLE_AI_API_KEY: process.env.GOOGLE_AI_API_KEY ?? '',

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
