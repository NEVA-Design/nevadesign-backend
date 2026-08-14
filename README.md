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

## Structure

```
src/
  config/env.ts         # variables d'env centralisées
  db/
    schema.sql            # schéma complet, idempotent
    apply-schema.ts        # l'applique via Bun.SQL au démarrage
  lib/                   # logique métier (credits, admin, ia, stripe, security...)
    ai/                    # modèles Neva, orchestrateur de modules, aspect ratios
  routes/                # routes Elysia, un fichier par domaine
    admin/                  # routes /admin/**
  index.ts               # point d'entrée, assemble l'app
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
