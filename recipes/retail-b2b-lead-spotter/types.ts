// Shapes from docs/R1_CONTRACT.md sections 2 and 3. Erasable TypeScript only.

export interface OrderPaidEvent {
  orderId: string;
  orderName: string;
  currency: string;
  total: number;
  productTitles: string[];
  customer: {
    id: string | null;
    email: string | null;
    lastName: string | null;
    marketingConsent: boolean;
  };
  billingCompany: string | null;
}

export type ExistingByEmail =
  | { type: 'Lead'; id: string }
  | { type: 'Contact'; id: string; accountId: string | null; ownerId: string };

export interface Context {
  accountByDomain: { id: string; ownerId: string } | null;
  existingByEmail: ExistingByEmail | null;
}

export interface Config {
  allowDomains: string[];
  denyDomains: string[];
  freeEmailBlocklist: string[];
  minOrderTotal: number;
  requireConsent: boolean;
  existingLeadAction: 'update' | 'skip';
  leadSource: string;
  companyOverride: string | null;
  leadOwnerId: string | null; // explicit OwnerId for new Leads; null = Salesforce default (the running user)
}

export type SkipReason =
  | 'no_email'
  | 'free_or_denied_domain'
  | 'below_minimum'
  | 'no_consent'
  | 'existing_lead_skipped';

export interface LeadFields {
  Company: string;
  LastName: string;
  Email: string;
  LeadSource: string;
  Description: string;
  OwnerId?: string; // present only when config.leadOwnerId is set
}

export interface TaskFields {
  Subject: string;
  Description: string;
}

export type SalesforceOp =
  | { kind: 'createLead'; matchKey: string; fields: LeadFields }
  | { kind: 'updateLead'; matchKey: string; targetId: string; fields: { Description: string } }
  | {
      kind: 'createTask';
      matchKey: string;
      ownerId: string;
      accountId: string | null; // -> WhatId
      contactId: string | null; // -> WhoId
      fields: TaskFields;
    };

export type Decision = { skip: SkipReason } | { ops: SalesforceOp[] };
