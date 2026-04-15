/**
 * Type-check-only file. Not executed by the test runner — its job is to
 * ensure the TypeScript compiler rejects `ChannelDefinition` constructions
 * that omit any of the security-critical fields
 * (`verifyWebhook`, `parseWebhook`, `sendReply`, `rateLimit.perSender`,
 * `rateLimit.perAccount`, `webhookPathPattern`, `getAccount`,
 * `listAccounts`).
 *
 * Each `@ts-expect-error` below acts as a compile-time assertion: if the
 * type definition ever relaxes a required field, the expected error will
 * disappear and the file will fail to type-check.
 */

import type { ChannelDefinition } from "../types.js";

interface A {
  id: string;
}
interface I {
  chatId: number;
}

// Baseline: a fully-valid construction must type-check without errors.
const valid: ChannelDefinition<A, I> = {
  id: "ch",
  getAccount: async () => null,
  listAccounts: async () => [],
  webhookPathPattern: "/wh/:accountId",
  verifyWebhook: () => true,
  parseWebhook: async () => null,
  rateLimit: {
    perSender: { perMinute: 10 },
    perAccount: { perMinute: 60 },
  },
  sendReply: async () => {},
};
void valid;

// Missing verifyWebhook.
// @ts-expect-error verifyWebhook is required by the type
const missingVerify: ChannelDefinition<A, I> = {
  id: "ch",
  getAccount: async () => null,
  listAccounts: async () => [],
  webhookPathPattern: "/wh/:accountId",
  parseWebhook: async () => null,
  rateLimit: {
    perSender: { perMinute: 10 },
    perAccount: { perMinute: 60 },
  },
  sendReply: async () => {},
};
void missingVerify;

// Missing parseWebhook.
// @ts-expect-error parseWebhook is required by the type
const missingParse: ChannelDefinition<A, I> = {
  id: "ch",
  getAccount: async () => null,
  listAccounts: async () => [],
  webhookPathPattern: "/wh/:accountId",
  verifyWebhook: () => true,
  rateLimit: {
    perSender: { perMinute: 10 },
    perAccount: { perMinute: 60 },
  },
  sendReply: async () => {},
};
void missingParse;

// Missing sendReply.
// @ts-expect-error sendReply is required by the type
const missingReply: ChannelDefinition<A, I> = {
  id: "ch",
  getAccount: async () => null,
  listAccounts: async () => [],
  webhookPathPattern: "/wh/:accountId",
  verifyWebhook: () => true,
  parseWebhook: async () => null,
  rateLimit: {
    perSender: { perMinute: 10 },
    perAccount: { perMinute: 60 },
  },
};
void missingReply;

// Missing rateLimit.perSender.
const missingPerSender: ChannelDefinition<A, I> = {
  id: "ch",
  getAccount: async () => null,
  listAccounts: async () => [],
  webhookPathPattern: "/wh/:accountId",
  verifyWebhook: () => true,
  parseWebhook: async () => null,
  // @ts-expect-error rateLimit.perSender is required by the type
  rateLimit: {
    perAccount: { perMinute: 60 },
  },
  sendReply: async () => {},
};
void missingPerSender;

// Missing rateLimit.perAccount.
const missingPerAccount: ChannelDefinition<A, I> = {
  id: "ch",
  getAccount: async () => null,
  listAccounts: async () => [],
  webhookPathPattern: "/wh/:accountId",
  verifyWebhook: () => true,
  parseWebhook: async () => null,
  // @ts-expect-error rateLimit.perAccount is required by the type
  rateLimit: {
    perSender: { perMinute: 10 },
  },
  sendReply: async () => {},
};
void missingPerAccount;

// Missing webhookPathPattern.
// @ts-expect-error webhookPathPattern is required by the type
const missingPattern: ChannelDefinition<A, I> = {
  id: "ch",
  getAccount: async () => null,
  listAccounts: async () => [],
  verifyWebhook: () => true,
  parseWebhook: async () => null,
  rateLimit: {
    perSender: { perMinute: 10 },
    perAccount: { perMinute: 60 },
  },
  sendReply: async () => {},
};
void missingPattern;

// Missing getAccount.
// @ts-expect-error getAccount is required by the type
const missingGetAccount: ChannelDefinition<A, I> = {
  id: "ch",
  listAccounts: async () => [],
  webhookPathPattern: "/wh/:accountId",
  verifyWebhook: () => true,
  parseWebhook: async () => null,
  rateLimit: {
    perSender: { perMinute: 10 },
    perAccount: { perMinute: 60 },
  },
  sendReply: async () => {},
};
void missingGetAccount;
