import Stripe from 'stripe'
import { env } from '../config/env'
import { PLANS, TOPUPS, CREDIT_COSTS } from './plans'

let stripeInstance: Stripe | null = null

export function getStripe() {
  if (stripeInstance) return stripeInstance

  if (!env.STRIPE_SECRET_KEY) {
    throw new Error('Missing STRIPE_SECRET_KEY environment variable')
  }

  stripeInstance = new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: '2026-05-27.dahlia' as Stripe.LatestApiVersion,
  })

  return stripeInstance
}

export { PLANS, TOPUPS, CREDIT_COSTS }
