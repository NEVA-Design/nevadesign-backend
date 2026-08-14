import { Elysia } from 'elysia'
import type Stripe from 'stripe'
import { getStripe, PLANS, TOPUPS } from '../lib/stripe'
import { requireUser, isResponse } from '../lib/require-auth'
import { createServiceClient } from '../lib/supabase'
import { ONE_SHOT_PACKS } from '../lib/resources'
import { env } from '../config/env'

type PaidPlan = Extract<(typeof PLANS)[keyof typeof PLANS], { priceId: string }>

function getPlanByPriceId(priceId: string | null | undefined) {
  if (!priceId) return null
  const plan = Object.values(PLANS).find(p => p.priceId === priceId)
  return plan && plan.id !== 'free' ? plan as PaidPlan : null
}

function getInvoiceSubscriptionId(invoice: Stripe.Invoice) {
  const direct = (invoice as { subscription?: string | Stripe.Subscription | null }).subscription
  if (typeof direct === 'string') return direct
  if (direct?.id) return direct.id

  const parent = invoice.parent
  if (parent?.type === 'subscription_details') {
    const subscription = parent.subscription_details?.subscription
    if (typeof subscription === 'string') return subscription
    if (subscription?.id) return subscription.id
  }

  const lineSubscription = invoice.lines?.data
    .map(line => line.subscription)
    .find(Boolean)

  if (typeof lineSubscription === 'string') return lineSubscription
  return lineSubscription?.id
}

async function addCreditsAndUpdatePlan(
  userId: string,
  credits: number,
  plan: string | null,
  type: string,
  description: string,
  subscriptionId?: string,
  subscriptionStatus?: string,
  skipIfSubscriptionAlreadyActive = false
) {
  const supabase = createServiceClient()

  if (skipIfSubscriptionAlreadyActive && subscriptionId) {
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('stripe_subscription_id, plan')
      .eq('id', userId)
      .maybeSingle()

    if (profileError) {
      console.error('[stripe/webhook] profile lookup error:', profileError)
      throw profileError
    }

    if (plan && profile?.stripe_subscription_id === subscriptionId && profile.plan === plan) {
      return
    }
  }

  const { error: creditError } = await supabase.rpc('increment_credits', {
    user_id: userId,
    amount: credits,
  })

  if (creditError) {
    console.error('[stripe/webhook] increment credits error:', creditError)
    throw creditError
  }

  const { error: profileUpdateError } = await supabase
    .from('profiles')
    .update({
      ...(plan ? { plan } : {}),
      ...(subscriptionId ? { stripe_subscription_id: subscriptionId } : {}),
      ...(subscriptionStatus ? { subscription_status: subscriptionStatus } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq('id', userId)

  if (profileUpdateError) {
    console.error('[stripe/webhook] profile update error:', profileUpdateError)
    throw profileUpdateError
  }

  const { error: transactionError } = await supabase.from('credit_transactions').insert({
    user_id: userId,
    amount: credits,
    type,
    description,
  })

  if (transactionError) {
    console.error('[stripe/webhook] transaction insert error:', transactionError)
    throw transactionError
  }
}

async function activateSubscriptionFromStripe(
  stripe: Stripe,
  subscriptionId: string,
  fallbackUserId: string | undefined,
  skipIfSubscriptionAlreadyActive: boolean
) {
  const subscription = await stripe.subscriptions.retrieve(subscriptionId)
  const userId = subscription.metadata?.supabase_user_id ?? fallbackUserId
  if (!userId) return

  const priceId = subscription.items.data[0]?.price?.id
  const plan = getPlanByPriceId(priceId)
  if (!plan) return

  await addCreditsAndUpdatePlan(
    userId,
    plan.credits,
    plan.id,
    'subscription',
    `Abonnement ${plan.name} — ${plan.credits} créations`,
    subscription.id,
    subscription.status,
    skipIfSubscriptionAlreadyActive
  )
}

export const stripeRoutes = new Elysia({ prefix: '/stripe' })
  .post('/checkout', async ({ request }) => {
    try {
      const auth = await requireUser(request)
      if (isResponse(auth)) return auth
      const { user, supabase } = auth

      const { priceId, mode } = await request.json() as { priceId?: string; mode?: string }

      if (!priceId || priceId.startsWith('price_REMPLACE') || priceId.startsWith('prod_')) {
        return Response.json({
          error: 'Price ID invalide. Va dans Stripe → ton produit → copie le price_xxx sous "Pricing".',
        }, { status: 400 })
      }

      const { data: profile } = await supabase
        .from('profiles')
        .select('stripe_customer_id')
        .eq('id', user.id)
        .single()

      let customerId = profile?.stripe_customer_id

      const stripe = getStripe()

      if (!customerId) {
        const customer = await stripe.customers.create({
          email: user.email!,
          metadata: { supabase_user_id: user.id },
        })
        customerId = customer.id
        await supabase
          .from('profiles')
          .update({ stripe_customer_id: customerId })
          .eq('id', user.id)
      }

      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        mode: mode === 'subscription' ? 'subscription' : 'payment',
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${env.SITE_URL}/dashboard/billing?success=true`,
        cancel_url: `${env.SITE_URL}/dashboard/billing`,
        metadata: { supabase_user_id: user.id },
        subscription_data: mode === 'subscription' ? {
          metadata: { supabase_user_id: user.id },
        } : undefined,
      })

      return Response.json({ url: session.url })
    } catch (err) {
      const e = err as { message?: string; statusCode?: number }
      console.error('[/stripe/checkout]', e?.message)
      return Response.json({ error: e?.message ?? 'Stripe error' }, { status: 500 })
    }
  })
  .post('/portal', async ({ request }) => {
    const auth = await requireUser(request)
    if (isResponse(auth)) return auth
    const { user, supabase } = auth

    const { data: profile } = await supabase
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', user.id)
      .single()

    if (!profile?.stripe_customer_id) {
      return Response.json({ error: 'No Stripe customer found' }, { status: 400 })
    }

    const stripe = getStripe()
    const session = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: `${env.SITE_URL}/dashboard/billing`,
    })

    return Response.json({ url: session.url })
  })
  .post('/resource-checkout', async ({ request }) => {
    try {
      const auth = await requireUser(request)
      if (isResponse(auth)) return auth
      const { user, supabase } = auth

      const { packId } = await request.json() as { packId?: string }
      if (!packId) return Response.json({ error: 'packId required' }, { status: 400 })

      const pack = ONE_SHOT_PACKS[packId]
      if (!pack) return Response.json({ error: 'Pack introuvable' }, { status: 404 })

      if (!pack.priceId || pack.priceId.startsWith('price_') === false) {
        return Response.json(
          { error: `Price ID non configuré pour "${pack.name}". Ajoute STRIPE_PRICE_${packId.toUpperCase().replace(/-/g, '_')} dans tes variables d'environnement.` },
          { status: 400 }
        )
      }

      const { data: existing } = await supabase
        .from('resource_purchases')
        .select('id')
        .eq('user_id', user.id)
        .eq('resource_id', packId)
        .maybeSingle()

      if (existing) {
        return Response.json({ alreadyOwned: true, redirect: '/dashboard/downloads' })
      }

      const { data: profile } = await supabase
        .from('profiles')
        .select('stripe_customer_id')
        .eq('id', user.id)
        .single()

      let customerId = profile?.stripe_customer_id
      const stripe = getStripe()

      if (!customerId) {
        const customer = await stripe.customers.create({
          email: user.email!,
          metadata: { supabase_user_id: user.id },
        })
        customerId = customer.id
        await supabase.from('profiles').update({ stripe_customer_id: customerId }).eq('id', user.id)
      }

      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        mode: 'payment',
        line_items: [{ price: pack.priceId, quantity: 1 }],
        success_url: `${env.SITE_URL}/dashboard/downloads?success=${packId}`,
        cancel_url: `${env.SITE_URL}/#resources`,
        metadata: {
          supabase_user_id: user.id,
          type: 'resource',
          resource_id: packId,
        },
      })

      return Response.json({ url: session.url })
    } catch (err) {
      const e = err as { message?: string }
      console.error('[/stripe/resource-checkout]', e?.message)
      return Response.json({ error: e?.message ?? 'Stripe error' }, { status: 500 })
    }
  })
  .post('/webhook', async ({ request }) => {
    const body = await request.text()
    const sig = request.headers.get('stripe-signature')

    if (!sig) {
      return Response.json({ error: 'Missing Stripe signature' }, { status: 400 })
    }

    let event: Stripe.Event
    let stripe: Stripe

    try {
      stripe = getStripe()
      event = stripe.webhooks.constructEvent(body, sig, env.STRIPE_WEBHOOK_SECRET)
    } catch (error) {
      console.error('[stripe/webhook] invalid signature:', error)
      return Response.json({ error: 'Invalid signature' }, { status: 400 })
    }

    const supabase = createServiceClient()

    try {
      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object as Stripe.Checkout.Session
          const userId = session.metadata?.supabase_user_id
          if (!userId) break

          if (session.mode === 'payment') {
            if (session.metadata?.type === 'resource' && session.metadata?.resource_id) {
              const resourceId = session.metadata.resource_id
              const { error } = await supabase.from('resource_purchases').upsert(
                {
                  user_id: userId,
                  resource_id: resourceId,
                  stripe_payment_intent_id: typeof session.payment_intent === 'string'
                    ? session.payment_intent
                    : null,
                },
                { onConflict: 'user_id,resource_id', ignoreDuplicates: true }
              )

              if (error) throw error
              break
            }

            const lineItems = await stripe.checkout.sessions.listLineItems(session.id)
            const priceId = lineItems.data[0]?.price?.id
            const topup = TOPUPS.find(t => t.priceId === priceId)

            if (topup) {
              await addCreditsAndUpdatePlan(
                userId,
                topup.credits,
                null,
                'topup',
                `Recharge ${topup.credits} creations`
              )
            }
          } else if (session.mode === 'subscription') {
            const subscriptionId = typeof session.subscription === 'string'
              ? session.subscription
              : session.subscription?.id

            if (subscriptionId) {
              await activateSubscriptionFromStripe(stripe, subscriptionId, userId, true)
            }
          }

          break
        }

        case 'invoice.payment_succeeded': {
          const invoice = event.data.object as Stripe.Invoice
          const subscriptionId = getInvoiceSubscriptionId(invoice)
          if (!subscriptionId) break

          const billingReason = (invoice as { billing_reason?: string }).billing_reason

          await activateSubscriptionFromStripe(
            stripe,
            subscriptionId,
            undefined,
            billingReason === 'subscription_create'
          )
          break
        }

        case 'customer.subscription.deleted': {
          const subscription = event.data.object as Stripe.Subscription
          const userId = subscription.metadata?.supabase_user_id
          if (!userId) break

          const { error } = await supabase.from('profiles').update({
            plan: 'free',
            subscription_status: 'canceled',
            stripe_subscription_id: null,
            updated_at: new Date().toISOString(),
          }).eq('id', userId)

          if (error) throw error
          break
        }

        case 'customer.subscription.updated': {
          const subscription = event.data.object as Stripe.Subscription
          const userId = subscription.metadata?.supabase_user_id
          if (!userId) break

          const { error } = await supabase.from('profiles').update({
            subscription_status: subscription.status,
            updated_at: new Date().toISOString(),
          }).eq('id', userId)

          if (error) throw error
          break
        }
      }
    } catch (error) {
      console.error('[stripe/webhook] handler error:', error)
      return Response.json({ error: 'Webhook handler failed' }, { status: 500 })
    }

    return Response.json({ received: true })
  })
