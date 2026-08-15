-- Neva Design — schéma complet, appliqué automatiquement au démarrage du
-- backend (voir src/db/apply-schema.ts). Entièrement idempotent : chaque
-- instruction peut être rejouée sans erreur (CREATE ... IF NOT EXISTS,
-- DROP POLICY IF EXISTS avant chaque CREATE POLICY, ON CONFLICT DO NOTHING).
-- Consolidé depuis nevadesign-frontend/src/lib/supabase/schema.sql +
-- migrations/002 (profils étendus + bucket avatars), 004 (style pool),
-- 008 (character_profiles final).

-- ── Profiles (liée à auth.users) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS profiles (
  id UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  credits INTEGER NOT NULL DEFAULT 0,
  plan TEXT NOT NULL DEFAULT 'free',
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  subscription_status TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS display_name TEXT,
  ADD COLUMN IF NOT EXISTS avatar_url TEXT,
  ADD COLUMN IF NOT EXISTS discord_handle TEXT,
  ADD COLUMN IF NOT EXISTS bio TEXT,
  ADD COLUMN IF NOT EXISTS notification_prefs JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Discord lié via notre propre app OAuth (voir src/lib/discord.ts),
  -- indépendant des "linked identities" Supabase.
  ADD COLUMN IF NOT EXISTS discord_id TEXT,
  ADD COLUMN IF NOT EXISTS discord_username TEXT,
  ADD COLUMN IF NOT EXISTS discord_avatar_url TEXT;

-- ── Credit transactions (journal d'audit) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS credit_transactions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  amount INTEGER NOT NULL,
  type TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chat_histories (
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  messages JSONB NOT NULL DEFAULT '[]',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Achats de ressources (produits digitaux one-shot) ───────────────────────
CREATE TABLE IF NOT EXISTS resource_purchases (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  resource_id TEXT NOT NULL,
  stripe_payment_intent_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, resource_id)
);

ALTER TABLE resource_purchases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users read own resource purchases" ON resource_purchases;
DROP POLICY IF EXISTS "Service role full access resource purchases" ON resource_purchases;
CREATE POLICY "Users read own resource purchases" ON resource_purchases FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Service role full access resource purchases" ON resource_purchases FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── Annonces du site ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS site_announcements (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'info' CHECK (kind IN ('promo', 'new', 'update', 'info')),
  badge TEXT,
  cta_label TEXT,
  href TEXT,
  accent TEXT NOT NULL DEFAULT 'orange' CHECK (accent IN ('coral', 'orange', 'yellow', 'green')),
  is_active BOOLEAN NOT NULL DEFAULT true,
  priority INTEGER NOT NULL DEFAULT 0,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE site_announcements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated read active site announcements" ON site_announcements;
DROP POLICY IF EXISTS "Service role full access site announcements" ON site_announcements;
CREATE POLICY "Authenticated read active site announcements" ON site_announcements
  FOR SELECT TO authenticated
  USING (
    is_active = true
    AND (starts_at IS NULL OR starts_at <= NOW())
    AND (ends_at IS NULL OR ends_at >= NOW())
  );
CREATE POLICY "Service role full access site announcements" ON site_announcements FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── Maintenance du site ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS site_maintenance (
  id TEXT PRIMARY KEY DEFAULT 'global' CHECK (id = 'global'),
  enabled BOOLEAN NOT NULL DEFAULT false,
  title TEXT NOT NULL DEFAULT 'Maintenance en cours',
  message TEXT NOT NULL DEFAULT 'Neva AI revient dans quelques minutes. Merci pour ta patience.',
  allow_admin_access BOOLEAN NOT NULL DEFAULT true,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  updated_by TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE site_maintenance ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read site maintenance" ON site_maintenance;
DROP POLICY IF EXISTS "Service role full access site maintenance" ON site_maintenance;
CREATE POLICY "Public read site maintenance" ON site_maintenance FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Service role full access site maintenance" ON site_maintenance FOR ALL TO service_role USING (true) WITH CHECK (true);

INSERT INTO site_maintenance (id)
VALUES ('global')
ON CONFLICT (id) DO NOTHING;

-- ── Portfolio Neva Design ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS neva_design_portfolio (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('Logos', 'Packs', 'Branding', 'Affiches', 'FiveM')),
  tag TEXT NOT NULL DEFAULT 'FiveM',
  image_path TEXT,
  description TEXT,
  is_featured BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  priority INTEGER NOT NULL DEFAULT 0,
  layout TEXT NOT NULL DEFAULT 'normal' CHECK (layout IN ('normal', 'tall', 'wide')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE neva_design_portfolio ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read active Neva Design portfolio" ON neva_design_portfolio;
DROP POLICY IF EXISTS "Service role full access Neva Design portfolio" ON neva_design_portfolio;
CREATE POLICY "Public read active Neva Design portfolio" ON neva_design_portfolio
  FOR SELECT TO anon, authenticated
  USING (is_active = true);
CREATE POLICY "Service role full access Neva Design portfolio" ON neva_design_portfolio FOR ALL TO service_role USING (true) WITH CHECK (true);

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'neva-design-portfolio',
  'neva-design-portfolio',
  true,
  12582912,
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Public read Neva Design portfolio images" ON storage.objects;
DROP POLICY IF EXISTS "Service role full access Neva Design portfolio images" ON storage.objects;
CREATE POLICY "Public read Neva Design portfolio images" ON storage.objects
  FOR SELECT TO public
  USING (bucket_id = 'neva-design-portfolio');
CREATE POLICY "Service role full access Neva Design portfolio images" ON storage.objects
  FOR ALL TO service_role
  USING (bucket_id = 'neva-design-portfolio')
  WITH CHECK (bucket_id = 'neva-design-portfolio');

-- ── Bucket avatars ───────────────────────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'avatars',
  'avatars',
  true,
  4194304,
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Users upload own avatar" ON storage.objects;
DROP POLICY IF EXISTS "Public avatar read" ON storage.objects;
DROP POLICY IF EXISTS "Users update own avatar" ON storage.objects;
DROP POLICY IF EXISTS "Users delete own avatar" ON storage.objects;

CREATE POLICY "Users upload own avatar"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "Public avatar read"
  ON storage.objects FOR SELECT TO public
  USING (bucket_id = 'avatars');

CREATE POLICY "Users update own avatar"
  ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "Users delete own avatar"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text);

-- ── Admins ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_users (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE admin_users ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role full access admin users" ON admin_users;
CREATE POLICY "Service role full access admin users" ON admin_users FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── Neva Brain (contexte créatif) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS neva_brain_entries (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  category TEXT NOT NULL CHECK (category IN (
    'composition_template',
    'camera_style',
    'environment_style',
    'fivem_location',
    'marketing_structure',
    'lighting_style',
    'character_scenario'
  )),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  prompt_context TEXT NOT NULL,
  tags TEXT[] NOT NULL DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT true,
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(category, name)
);

ALTER TABLE neva_brain_entries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated read active Neva Brain entries" ON neva_brain_entries;
DROP POLICY IF EXISTS "Service role full access Neva Brain entries" ON neva_brain_entries;
CREATE POLICY "Authenticated read active Neva Brain entries" ON neva_brain_entries
  FOR SELECT TO authenticated
  USING (is_active = true);
CREATE POLICY "Service role full access Neva Brain entries" ON neva_brain_entries FOR ALL TO service_role USING (true) WITH CHECK (true);

INSERT INTO neva_brain_entries (category, name, description, prompt_context, tags, priority)
VALUES
  ('composition_template', 'FiveM promotional hero', 'Hero subject, readable negative space, strong marketing hierarchy.', 'Use a clear FiveM promotional composition: one dominant hero subject, readable background depth, clean negative space for branding, strong focal point, and no clutter around the face.', ARRAY['poster','banner','marketing'], 100),
  ('camera_style', 'Rockstar Editor hero angle', 'Game-cinematic lensing for FiveM characters and vehicles.', 'Favor Rockstar Editor-inspired camera language: low or three-quarter angle, 35mm to 50mm lens feel, believable GTA V / FiveM proportions, cinematic but still game-authentic.', ARRAY['character','vehicle','cinematic'], 90),
  ('environment_style', 'Los Santos production depth', 'Layered urban depth without distracting from the subject.', 'Build depth with foreground detail, midground subject clarity, and softly defocused Los Santos-style background elements. Keep the environment recognizable but secondary.', ARRAY['depth','los-santos'], 80),
  ('fivem_location', 'Premium RP city mix', 'Useful FiveM locations for marketing visuals.', 'Use fitting FiveM / GTA-inspired locations when relevant: Vinewood Hills for luxury, Legion Square for city identity, Davis for street RP, Mission Row for police, La Mesa for mechanics, Vespucci for lifestyle.', ARRAY['location'], 70),
  ('marketing_structure', 'Server owner conversion layout', 'Readable ad structure for social and server promotion.', 'Make the image sell the concept quickly: instant roleplay category recognition, premium polish, clear subject priority, high contrast where the viewer should look first, and space for logo or CTA when requested.', ARRAY['marketing','social'], 60),
  ('lighting_style', 'Premium practical lighting', 'Natural cinematic lighting without fake neon defaults.', 'Use motivated practical lighting: golden hour, street lamps, storefront light, office window light, garage work lights, or police vehicle spill. Avoid generic cyberpunk glow unless explicitly requested.', ARRAY['lighting'], 50),
  ('character_scenario', 'Strict identity preservation', 'Preserve uploaded FiveM character identity.', 'When a character reference is uploaded, preserve identity first: same face, facial structure, skin tone, hairstyle, facial hair, tattoos, jewelry, body proportions, outfit silhouette, and signature accessories. Do not redesign the person.', ARRAY['character','identity'], 40)
ON CONFLICT (category, name) DO NOTHING;

-- ── Sécurité inscription ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS signup_attempts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ip TEXT,
  email TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE signup_attempts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow public read signup attempts" ON signup_attempts;
DROP POLICY IF EXISTS "Allow public insert signup attempts" ON signup_attempts;
DROP POLICY IF EXISTS "Service role full access signup attempts" ON signup_attempts;
CREATE POLICY "Service role full access signup attempts" ON signup_attempts FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS signup_security_events (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  email TEXT NOT NULL,
  ip_address TEXT NOT NULL,
  matching_user_ids UUID[] NOT NULL DEFAULT '{}',
  risk_score INTEGER NOT NULL DEFAULT 0 CHECK (risk_score >= 0 AND risk_score <= 100),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'allowed' CHECK (status IN (
    'allowed',
    'blocked',
    'pending_review',
    'approved_by_admin',
    'rejected_by_admin'
  )),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ
);

ALTER TABLE signup_security_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role full access signup security events" ON signup_security_events;
CREATE POLICY "Service role full access signup security events" ON signup_security_events FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS signup_security_events_status_idx ON signup_security_events(status);
CREATE INDEX IF NOT EXISTS signup_security_events_user_id_idx ON signup_security_events(user_id);
CREATE INDEX IF NOT EXISTS signup_security_events_ip_address_idx ON signup_security_events(ip_address);
CREATE INDEX IF NOT EXISTS signup_attempts_ip_user_idx ON signup_attempts(ip, user_id);

-- ── Personnages (Neva Character) ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS character_profiles (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  image_preview TEXT,
  role TEXT,
  server TEXT,
  style TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE character_profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users manage own characters" ON character_profiles;
CREATE POLICY "Users manage own characters"
  ON character_profiles FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ── Style pool anonymisé (alimente le moteur de composition) ────────────────
CREATE TABLE IF NOT EXISTS character_style_pool (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  archetype TEXT NOT NULL,
  style_tags TEXT[] NOT NULL DEFAULT '{}',
  description TEXT NOT NULL,
  times_used INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE character_style_pool ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role only on style pool" ON character_style_pool;
CREATE POLICY "Service role only on style pool"
  ON character_style_pool FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_style_pool_archetype ON character_style_pool (archetype);
CREATE INDEX IF NOT EXISTS idx_style_pool_tags ON character_style_pool USING GIN (style_tags);

-- ── RLS profils / crédits / chat ─────────────────────────────────────────────
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_histories ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own profile" ON profiles;
DROP POLICY IF EXISTS "Users update own profile" ON profiles;
DROP POLICY IF EXISTS "Service role full access profiles" ON profiles;
CREATE POLICY "Users read own profile" ON profiles FOR SELECT TO authenticated USING (auth.uid() = id);
CREATE POLICY "Users update own profile" ON profiles FOR UPDATE TO authenticated USING (auth.uid() = id) WITH CHECK (auth.uid() = id);
CREATE POLICY "Service role full access profiles" ON profiles FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Users read own transactions" ON credit_transactions;
DROP POLICY IF EXISTS "Service role full access transactions" ON credit_transactions;
CREATE POLICY "Users read own transactions" ON credit_transactions FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Service role full access transactions" ON credit_transactions FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Users read own chat history" ON chat_histories;
DROP POLICY IF EXISTS "Users update own chat history" ON chat_histories;
DROP POLICY IF EXISTS "Users insert own chat history" ON chat_histories;
DROP POLICY IF EXISTS "Service role full access chat histories" ON chat_histories;
CREATE POLICY "Users read own chat history" ON chat_histories FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users update own chat history" ON chat_histories FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users insert own chat history" ON chat_histories FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Service role full access chat histories" ON chat_histories FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Auto-création du profil sans crédits ; le module signup-security du
-- backend accorde les crédits gratuits après évaluation anti-abus.
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO profiles (id, credits, plan)
  VALUES (NEW.id, 0, 'free')
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- Incrément atomique (évite les races entre déductions/ajouts concurrents)
CREATE OR REPLACE FUNCTION increment_credits(user_id UUID, amount INTEGER)
RETURNS VOID AS $$
  UPDATE profiles SET credits = credits + amount, updated_at = NOW()
  WHERE id = user_id;
$$ LANGUAGE SQL SECURITY DEFINER SET search_path = public;

-- Profils manquants pour les comptes auth déjà existants
INSERT INTO profiles (id, credits, plan)
SELECT id, 0, 'free' FROM auth.users
ON CONFLICT (id) DO NOTHING;

-- ── Projets (run 5, LOT 1) — la colonne vertébrale de la cohérence ──────────
-- Un projet = un serveur client : son nom, son secteur, son ambiance
-- (réponses du questionnaire), sa palette et son logo master. Tout asset
-- créé dans le projet HÉRITE de ces éléments — le logo n'est jamais
-- régénéré, toujours composé.
CREATE TABLE IF NOT EXISTS projects (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sector TEXT NOT NULL DEFAULT 'fivem',
  -- { universe: "l'univers en une phrase", chips: ["Luxe","Sombre"], references: [urls] }
  ambiance JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- 5-6 couleurs hex, la première est dominante
  palette JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- { url, whiteUrl, blackUrl, width, height } — PNG alpha 4K + déclinaisons
  logo_master JSONB,
  -- étape B (run 5.4) : { fondUrl, carreUrl, banniereUrl, alphaUrl, at } —
  -- le fond validé + déclinaisons composées (carré 1:1, bannière 16:9)
  logo_scene JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Migration run 5.4 (bases existantes) :
ALTER TABLE projects ADD COLUMN IF NOT EXISTS logo_scene JSONB;

CREATE INDEX IF NOT EXISTS projects_user_idx ON projects(user_id, updated_at DESC);

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users manage own projects" ON projects;
DROP POLICY IF EXISTS "Service role full access projects" ON projects;
CREATE POLICY "Users manage own projects" ON projects FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Service role full access projects" ON projects FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── Assets d'un projet — piles de calques éditables ─────────────────────────
CREATE TABLE IF NOT EXISTS project_assets (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  title TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'ready', 'exported')),
  -- dimensions de composition du canvas (px)
  width INTEGER NOT NULL DEFAULT 1920,
  height INTEGER NOT NULL DEFAULT 1080,
  -- pile ordonnée : [{id, type: scene|effect|logo|text|grain, ...transform, ...}]
  layers JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- réponses du wizard pour cet asset (rejouables pour régénérer)
  wizard_answers JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- historique des prompts compilés envoyés au moteur
  compiled_prompts JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- 5 retouches incluses par création, la 6e reprend 1 création
  retouches_used INTEGER NOT NULL DEFAULT 0,
  preview_url TEXT,
  -- [{ url, resolution, at }]
  exports JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS project_assets_project_idx ON project_assets(project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS project_assets_user_idx ON project_assets(user_id, updated_at DESC);

ALTER TABLE project_assets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users manage own project assets" ON project_assets;
DROP POLICY IF EXISTS "Service role full access project assets" ON project_assets;
CREATE POLICY "Users manage own project assets" ON project_assets FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Service role full access project assets" ON project_assets FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── Bucket des fichiers projets (logos, calques, exports) ───────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'neva-projects',
  'neva-projects',
  true,
  52428800,
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Public read neva projects files" ON storage.objects;
DROP POLICY IF EXISTS "Service role full access neva projects files" ON storage.objects;
CREATE POLICY "Public read neva projects files" ON storage.objects
  FOR SELECT TO public
  USING (bucket_id = 'neva-projects');
CREATE POLICY "Service role full access neva projects files" ON storage.objects
  FOR ALL TO service_role
  USING (bucket_id = 'neva-projects')
  WITH CHECK (bucket_id = 'neva-projects');

-- ── Journal de coût des générations IA (run 5, LOT 0) ───────────────────────
-- Chaque appel image/vision est loggé : modèle, résolution, tokens, coût
-- estimé. Sert aussi de compteur pour le plafond quotidien par compte
-- (somme des images_out du jour). Accès service_role uniquement.
CREATE TABLE IF NOT EXISTS generation_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  project_id UUID,
  asset_id UUID,
  kind TEXT NOT NULL,
  model TEXT NOT NULL,
  resolution TEXT,
  images_out INTEGER NOT NULL DEFAULT 0,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost_eur NUMERIC(9, 4),
  refused BOOLEAN NOT NULL DEFAULT false,
  retried BOOLEAN NOT NULL DEFAULT false,
  duration_ms INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS generation_logs_user_created_idx ON generation_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS generation_logs_project_idx ON generation_logs(project_id);

ALTER TABLE generation_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role full access generation logs" ON generation_logs;
CREATE POLICY "Service role full access generation logs" ON generation_logs FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── Réglages moteur : kill-switch + plafond, sans redéploiement ─────────────
-- generations_enabled=false coupe toutes les générations IA immédiatement
-- (cache mémoire 30 s côté backend). Modifiable via PATCH /admin/engine ou
-- directement en SQL depuis le dashboard Supabase.
CREATE TABLE IF NOT EXISTS engine_settings (
  id TEXT PRIMARY KEY DEFAULT 'global' CHECK (id = 'global'),
  generations_enabled BOOLEAN NOT NULL DEFAULT true,
  daily_cap_per_user INTEGER NOT NULL DEFAULT 80,
  updated_by TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE engine_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role full access engine settings" ON engine_settings;
CREATE POLICY "Service role full access engine settings" ON engine_settings FOR ALL TO service_role USING (true) WITH CHECK (true);

INSERT INTO engine_settings (id)
VALUES ('global')
ON CONFLICT (id) DO NOTHING;

-- PostgREST met en cache le schéma : on force un rechargement immédiat
-- pour que les colonnes/tables neuves soient visibles sans attendre.
NOTIFY pgrst, 'reload schema';
