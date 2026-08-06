import { test } from "node:test";
import assert from "node:assert/strict";
import { createBudget } from "./budget.ts";
import { NO_RATE_INFO } from "./transport.ts";

const NOW = 1_000_000;

test("a bucket with room stays affordable", () => {
  const budget = createBudget();

  assert.equal(budget.affordable(NOW), true, "nothing observed yet means nothing known to block");
  budget.observe({ remaining: 3, resetAfterMs: 5_000, retryAfterMs: null }, NOW);
  assert.equal(budget.affordable(NOW), true);
});

test("an emptied bucket blocks until it reports itself refilled", () => {
  const budget = createBudget();

  budget.observe({ remaining: 0, resetAfterMs: 5_000, retryAfterMs: null }, NOW);

  assert.equal(budget.affordable(NOW), false);
  assert.equal(budget.affordable(NOW + 4_999), false);
  assert.equal(budget.affordable(NOW + 5_000), true);
});

test("a 429 blocks for the wait it reported", () => {
  const budget = createBudget();

  budget.observe({ remaining: 0, resetAfterMs: 1_000, retryAfterMs: 30_000 }, NOW);

  assert.equal(budget.affordable(NOW + 29_999), false, "retry_after outranks the reset header");
  assert.equal(budget.affordable(NOW + 30_000), true);
});

test("an emptied bucket that reported no reset still backs off", () => {
  const budget = createBudget();

  budget.observe({ remaining: 0, resetAfterMs: null, retryAfterMs: null }, NOW);

  assert.equal(budget.affordable(NOW), false);
  assert.equal(budget.affordable(NOW + 5_000), true);
});

test("a response that said nothing about the bucket leaves a standing block alone", () => {
  // A transport error carries no headers. Reading that as "the bucket is fine" would spend the
  // whole wait retrying into a 429.
  const budget = createBudget();
  budget.observe({ remaining: 0, resetAfterMs: 10_000, retryAfterMs: null }, NOW);

  budget.observe(NO_RATE_INFO, NOW + 1_000);

  assert.equal(budget.affordable(NOW + 1_000), false);
  assert.equal(budget.blockedUntil(), NOW + 10_000);
});

test("a later response with room clears an earlier block", () => {
  const budget = createBudget();
  budget.observe({ remaining: 0, resetAfterMs: 10_000, retryAfterMs: null }, NOW);

  budget.observe({ remaining: 2, resetAfterMs: 10_000, retryAfterMs: null }, NOW + 1_000);

  assert.equal(budget.affordable(NOW + 1_000), true);
  assert.equal(budget.blockedUntil(), 0);
});
