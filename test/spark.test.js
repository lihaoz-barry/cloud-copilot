'use strict';

/**
 * Tests for the ✨ "reviewed and merged into main" badge (issue #68).
 *
 * The badge is a claim about quality: it says this issue's work was reviewed by
 * the scheduler's review-and-improve pass AND actually landed on the default
 * branch. Lighting it on half a pipeline would be worse than not having it at
 * all, so every "one condition only" case is pinned down here.
 *
 * Run with `npm test`.
 */

const test = require('node:test');
const assert = require('node:assert');

const CCSpark = require('../public/spark-badge.js');

const SHA = 'abcdef1234567890';

function pr(prNumber, state, lastReviewedSha) {
  return { prNumber, state, review: { lastReviewedSha } };
}

test('reviewed + merged lights the spark', () => {
  const view = CCSpark.prSparkView(pr(123, 'MERGED', SHA));
  assert.ok(view, 'expected a badge');
  assert.strictEqual(view.text, '\u2728');
  assert.strictEqual(view.prNumber, 123);
  assert.strictEqual(view.shortSha, 'abcdef1');
  assert.match(view.title, /Reviewed and merged into main/);
  assert.match(view.title, /PR #123/);
  assert.match(view.title, /abcdef1/);
  // The title must not leak the full sha — the badge is a hint, not a log line.
  assert.ok(!view.title.includes(SHA));
});

test('merged but never reviewed stays dark', () => {
  assert.strictEqual(CCSpark.prSparkView(pr(1, 'MERGED', null)), null);
  assert.strictEqual(CCSpark.prSparkView(pr(1, 'MERGED', '')), null);
  assert.strictEqual(CCSpark.prSparkView(pr(1, 'MERGED', '   ')), null);
  assert.strictEqual(CCSpark.prSparkView({ prNumber: 1, state: 'MERGED' }), null);
});

test('reviewed but not merged stays dark', () => {
  assert.strictEqual(CCSpark.prSparkView(pr(1, 'OPEN', SHA)), null);
  assert.strictEqual(CCSpark.prSparkView(pr(1, 'CLOSED', SHA)), null);
  // A record written before `state` existed holds null: unknown is not merged.
  assert.strictEqual(CCSpark.prSparkView(pr(1, null, SHA)), null);
});

test('bad input never throws', () => {
  assert.strictEqual(CCSpark.prSparkView(null), null);
  assert.strictEqual(CCSpark.prSparkView(undefined), null);
  assert.strictEqual(CCSpark.prSparkView({}), null);
  assert.strictEqual(CCSpark.issueSparkView(null), null);
  assert.strictEqual(CCSpark.issueSparkView(undefined), null);
  assert.strictEqual(CCSpark.issueSparkView([]), null);
  assert.strictEqual(CCSpark.issueSparkView([null, undefined]), null);
  // A non-string sha (corrupt record) must not blow up the whole list render.
  assert.strictEqual(CCSpark.prSparkView({ prNumber: 1, state: 'MERGED', review: { lastReviewedSha: 42 } }), null);
});

test('an issue lights up when ANY of its PRs qualifies', () => {
  const prs = [
    pr(9, 'OPEN', SHA),          // reviewed, still open
    pr(8, 'MERGED', null),       // merged, never reviewed
    pr(7, 'MERGED', SHA),        // the one that counts
  ];
  const view = CCSpark.issueSparkView(prs);
  assert.ok(view);
  assert.strictEqual(view.prNumber, 7);
  assert.match(view.title, /PR #7/);
});

test('an issue with no qualifying PR stays dark', () => {
  assert.strictEqual(CCSpark.issueSparkView([pr(2, 'OPEN', SHA), pr(1, 'MERGED', null)]), null);
});

test('the issue badge names the first qualifying PR in list order', () => {
  // The list is sorted newest-first, so the newest finished PR wins.
  const view = CCSpark.issueSparkView([pr(12, 'MERGED', 'ffffffffff'), pr(3, 'MERGED', SHA)]);
  assert.strictEqual(view.prNumber, 12);
  assert.strictEqual(view.shortSha, 'fffffff');
});

test('a qualifying PR without a number still describes itself', () => {
  const view = CCSpark.prSparkView({ state: 'MERGED', review: { lastReviewedSha: SHA } });
  assert.ok(view);
  assert.strictEqual(view.prNumber, null);
  assert.ok(!view.title.includes('PR #'));
  assert.match(view.title, /abcdef1/);
});

test('isReviewedAndMerged is the single shared predicate', () => {
  assert.strictEqual(CCSpark.isReviewedAndMerged(pr(1, 'MERGED', SHA)), true);
  assert.strictEqual(CCSpark.isReviewedAndMerged(pr(1, 'OPEN', SHA)), false);
  assert.strictEqual(CCSpark.isReviewedAndMerged(pr(1, 'MERGED', null)), false);
});
