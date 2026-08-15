import { Elysia } from 'elysia'
import { cors } from '@elysiajs/cors'
import { swagger } from '@elysiajs/swagger'

import { env } from './config/env'
import { applySchema } from './db/apply-schema'
import { healthRoutes } from './routes/health'
import { authRoutes } from './routes/auth'
import { meRoutes } from './routes/me'
import { dashboardRoutes } from './routes/dashboard'
import { publicRoutes } from './routes/public'
import { profileRoutes } from './routes/profile'
import { characterRoutes } from './routes/characters'
import { characterAssetsRoutes } from './routes/character-assets'
import { chatRoutes } from './routes/chat'
import { generateImageRoutes } from './routes/generate-image'
import { enhanceImageRoutes } from './routes/enhance-image'
import { auditImageRoutes } from './routes/audit-image'
import { stripeRoutes } from './routes/stripe'
import { debugRoutes } from './routes/debug'
import { adminAdminsRoutes } from './routes/admin/admins'
import { adminAnnouncementsRoutes } from './routes/admin/announcements'
import { adminMaintenanceRoutes } from './routes/admin/maintenance'
import { adminPortfolioRoutes } from './routes/admin/portfolio'
import { adminNewsletterRoutes } from './routes/admin/newsletter'
import { adminSecurityAlertsRoutes } from './routes/admin/security-alerts'
import { adminUsersRoutes } from './routes/admin/users'
import { adminOverviewRoutes } from './routes/admin/overview'
import { adminEngineRoutes } from './routes/admin/engine'
import { adminTestEngineRoutes } from './routes/admin/test-engine'
import { projectRoutes } from './routes/projects'
import { filesRoutes } from './routes/files'
import { engineRoutes } from './routes/engine'

const corsOrigins = env.CORS_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean)

await applySchema()

const app = new Elysia()
  .use(
    cors({
      origin: corsOrigins.length > 1 ? corsOrigins : corsOrigins[0],
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    })
  )
  .use(swagger({ path: '/docs' }))
  .use(healthRoutes)
  .use(authRoutes)
  .use(meRoutes)
  .use(dashboardRoutes)
  .use(publicRoutes)
  .use(profileRoutes)
  .use(characterRoutes)
  .use(characterAssetsRoutes)
  .use(chatRoutes)
  .use(generateImageRoutes)
  .use(enhanceImageRoutes)
  .use(auditImageRoutes)
  .use(stripeRoutes)
  .use(debugRoutes)
  .use(adminAdminsRoutes)
  .use(adminAnnouncementsRoutes)
  .use(adminMaintenanceRoutes)
  .use(adminPortfolioRoutes)
  .use(adminNewsletterRoutes)
  .use(adminSecurityAlertsRoutes)
  .use(adminUsersRoutes)
  .use(adminOverviewRoutes)
  .use(adminEngineRoutes)
  .use(adminTestEngineRoutes)
  .use(projectRoutes)
  .use(filesRoutes)
  .use(engineRoutes)
  .listen(env.PORT)

console.log(`nevadesign-backend running at http://${app.server?.hostname}:${app.server?.port}`)
console.log(`docs available at http://${app.server?.hostname}:${app.server?.port}/docs`)
