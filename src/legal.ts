// The edition of the user agreement and of the consent to the processing of personal data that the app
// asks to accept. Must match server/legal.mjs (tests/legal-acceptance.test.mjs checks it).
export const LEGAL_VERSION = '2026-10-22';

export const legalLinks = {
  terms: '/terms/',
  consent: '/consent/',
  privacy: '/privacy/',
  licenses: '/licenses/'
} as const;
