import { decide } from './decide.ts';
import { buildContext } from './buildContext.ts';
import { mapOrderPaid } from './mapOrderPaid.ts';
import { minimizeOrderPaid } from './minimizeOrderPaid.ts';
import type { Recipe } from '../../core/worker/recipe.ts';
import type { Config, Context, OrderPaidEvent } from './types.ts';

export const R1_ID = 'r1-retail-b2b-lead-spotter';

export const r1Recipe: Recipe<OrderPaidEvent, Context, Config> = {
  id: R1_ID,
  topics: ['orders/paid'],
  mapEvent: mapOrderPaid,
  minimize: minimizeOrderPaid,
  objectIdOf: (e) => e.orderId,
  emptyContext: () => ({ accountByDomain: null, existingByEmail: null }),
  buildContext,
  decide,
};

// Contract defaults (docs/R1_CONTRACT.md section 2). The free-email list here is a short stand-in for the shipped list.
export const R1_DEFAULT_CONFIG: Config = {
  allowDomains: [],
  denyDomains: [],
  freeEmailBlocklist: ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'aol.com'],
  minOrderTotal: 0,
  requireConsent: true,
  existingLeadAction: 'update',
  leadSource: 'Shopify Order',
  companyOverride: null,
  leadOwnerId: null,
};
