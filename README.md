# nevadesign-backend

Backend API pour NevaDesign, en Bun + Elysia. Séparé du frontend Next.js
(`nevadesign-frontend`) — communication uniquement via API HTTP + Bearer
token. Le front ne touche jamais Supabase directement (ni côté navigateur,
ni côté serveur) : ce backend est le seul point de contact avec la base.

## Stack

- [Bun](https://bun.sh) — runtime (utilise aussi `Bun.SQL`, client Postgres natif)
- [Elysia](https://elysiajs.com) — framework HTTP
- `@elysiajs/swagger` — docs auto sur `/docs`
- `@elysiajs/cors`
- `@supabase/supabase-js` — DB + auth (même projet Supabase que le frontend)
- `stripe`, `sharp`

Moteur IA : **Gemini uniquement** (`src/lib/ai/gemini.ts`) — texte, chat en
streaming, vision et génération/édition d'image passent tous par l'API
Gemini (`GEMINI_API_KEY`). Aucune dépendance OpenAI.

## Démarrer

```bash
bun install
cp .env.example .env   # renseigne les clés Supabase/Gemini/Stripe/...
bun run dev
```

Le serveur démarre sur `http://localhost:4000` (configurable via `PORT`).
Docs Swagger : `http://localhost:4000/docs`.

## Base de données — création automatique du schéma

Au démarrage, le serveur applique automatiquement `src/db/schema.sql`
(tables, policies RLS, fonctions, triggers) sur la base Supabase — voir
`src/db/apply-schema.ts`. Le script est idempotent (`CREATE ... IF NOT
EXISTS`, `DROP POLICY IF EXISTS` avant chaque `CREATE POLICY`) : il peut
tourner à chaque démarrage sans casser les données existantes.

Ça nécessite `SUPABASE_DB_URL` (connexion Postgres **directe**, différente
des clés API) — dans le dashboard Supabase : **Project Settings → Database
→ Connection string** (mode "Session pooler" recommandé). Sans cette
variable, l'auto-création est simplement sautée (log d'avertissement) et il
faut appliquer `src/db/schema.sql` toi-même dans le SQL Editor Supabase.

## Auth

Le frontend n'a plus de client Supabase du tout — l'auth passe entièrement
par ce backend :

- `POST /auth/signup`, `POST /auth/login` — retournent `{ session, user }`
- `POST /auth/refresh` — renouvelle un access token expiré depuis le refresh token
- `POST /auth/forgot-password` — envoie l'e-mail de réinitialisation
- `GET /auth/google` — redirige vers le flux OAuth hébergé par Supabase ;
  revient sur le front avec les tokens dans le fragment d'URL (`#access_token=...`)
- `POST /auth/oauth-complete` — à appeler juste après un login Google, déclenche
  la même évaluation anti-abus que l'inscription classique

Le front stocke `access_token`/`refresh_token` en cookies et les envoie en
`Authorization: Bearer <token>` sur chaque requête protégée. Chaque requête
crée un client Supabase scopé à ce token, donc les policies RLS s'appliquent
normalement (`auth.uid()` résolu depuis le JWT).

Les routes `/admin/**` nécessitent en plus d'être admin (`ADMIN_EMAILS` ou
table `admin_users`).

## Mode dev local (sans Supabase)

`DEV_LOCAL_MODE=1` dans `.env` (ignoré si `NODE_ENV=production`) émule
Supabase sur `data/dev-store.json` : auth factice (`dev@neva.local`, tout
mot de passe accepté), profil Studio avec 25 créations, storage sur disque
servi par `GET /files/*`. Tout le produit tourne — wizard, générations,
crédits, exports. À retirer dès que les vraies clés sont renseignées.

## Le moteur projets (run 5)

- **Entraînement one-shot** : `bun run scripts/train-fivem.ts` analyse le
  dossier de références du client et écrit les guides de style compacts
  dans `src/engine/styles/fivem/` (versionnés — ne se repaie jamais).
  `scripts/parse-scene-templates.ts` transforme les prompts du client en
  templates paramétrés (`src/engine/templates/fivem/scenes.json`).
- **Compilateur** (`lib/engine/compiler.ts`) : assemble secteur + guide +
  DA projet + réponses wizard + template ; règle no-text absolue en fin de
  prompt. L'utilisateur ne voit jamais un prompt.
- **Génération** (`lib/engine/generation.ts`) : propositions logo en
  `gemini-3.1-flash-image` 1K, scènes/masters en `gemini-3-pro-image` ;
  UNE reformulation adoucie sur refus safety, tout loggé dans
  `generation_logs` (tokens réels, coût estimé, refus, durée).
- **Détourage** (`lib/engine/cutout.ts`) : flood-fill local sur fond plat
  imposé par le compilateur — zéro appel API, déclinaisons blanc/noir.
- **Export** (`lib/engine/composite.ts`) : compositing serveur miroir de
  l'éditeur ; texte rendu par satori (5 TTF dans `src/engine/fonts/`),
  effets maison dans `src/engine/effects/` (générés par
  `scripts/generate-effects.ts`, zéro API).
- **Garde-fous** (`lib/engine/guards.ts`) : kill-switch et plafond
  quotidien par compte dans `engine_settings` (modifiables à chaud via
  `PATCH /admin/engine`, cache 30 s), journal de coût systématique.

## Structure

```
src/
  config/env.ts         # variables d'env centralisées
  db/
    schema.sql            # schéma complet, idempotent
    apply-schema.ts        # l'applique via Bun.SQL au démarrage
  engine/                # artefacts d'entraînement versionnés
    styles/fivem/          # guides de style par catégorie (JSON ≤ 800 tokens)
    templates/fivem/       # templates de scène paramétrés
    fonts/                 # TTF des calques texte (satori)
    effects/               # overlays maison (grain, vignette, glows…)
  lib/                   # logique métier (credits, admin, ia, stripe, security...)
    ai/                    # client Gemini, modèles Neva, aspect ratios
    engine/                # compilateur, génération, calques, détourage, export
  routes/                # routes Elysia, un fichier par domaine
    admin/                  # routes /admin/**
  index.ts               # point d'entrée, assemble l'app
scripts/                 # one-shots : entraînement, vignettes, effets, démos
```

## Endpoints

- `POST /auth/signup`, `POST /auth/login`, `POST /auth/refresh`,
  `POST /auth/forgot-password`, `GET /auth/google`, `POST /auth/oauth-complete`
- `GET /me` — profil + crédits + plan de l'utilisateur courant
- `GET /dashboard/overview`, `GET /dashboard/downloads`
- `GET /maintenance`, `GET /portfolio` — publics, sans auth
- `GET/PATCH /profile`, `POST /profile/avatar`, `POST /profile/password`
- `GET/POST /characters`, `GET/PATCH/DELETE /characters/:id`
- `POST /character-assets`
- `POST /chat`, `GET/POST /chat/history`
- `POST /generate-image`, `POST /enhance-image`, `POST /audit-image`
- `GET/POST/PATCH/DELETE /projects[/:id]` — modèle Projet (DA héritée)
- `POST/GET/PATCH/DELETE /projects/:id/assets[/:assetId]` — calques, autosave
- `POST /projects/uploads/reference` — références du wizard (768px webp)
- `POST /engine/logo/proposals`, `POST /engine/logo/master` — wizard logo
- `POST /engine/scene`, `POST /engine/scene/regenerate` — calque scène
- `POST /engine/export` — compositing serveur à la résolution du plan
- `GET /engine/templates`, `GET /engine/effects[/:file]`
- `GET/PATCH /admin/engine` — kill-switch + plafond quotidien
- `POST /stripe/checkout`, `POST /stripe/portal`, `POST /stripe/resource-checkout`, `POST /stripe/webhook`
- `GET /debug/models`
- `GET /admin/verify`, `GET /admin/overview`
- `GET/POST /admin/admins`, `DELETE /admin/admins/:id`
- `GET/POST/PATCH/DELETE /admin/announcements[/:id]`
- `GET/PATCH /admin/maintenance`
- `GET/POST/PATCH/DELETE /admin/neva-design/portfolio[/:id]`, `POST /admin/neva-design/portfolio/upload`
- `GET/POST /admin/newsletter`
- `GET /admin/security-alerts`, `POST /admin/security-alerts/:id`
- `GET /admin/users`, `POST /admin/users/:id/credits`, `POST /admin/users/:id/plan`

## État actuel

Séparation complète front/back opérationnelle : le front (Next.js) n'a plus
aucune dépendance Supabase (`@supabase/ssr`, `@supabase/supabase-js`
retirés), toutes ses pages SSR et son middleware appellent ce backend. La
base est amorcée automatiquement au démarrage du backend.

Limite connue : les crédits en direct sur le dashboard ne se synchronisent
plus entre onglets/appareils (l'abonnement Supabase Realtime a été retiré du
front) — seul l'événement local `neva:credits-updated` reste, donc la mise à
jour est instantanée dans l'onglet actif mais pas ailleurs.
