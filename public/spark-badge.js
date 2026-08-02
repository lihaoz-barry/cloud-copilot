/* eslint-disable no-var */
// ---------------------------------------------------------------------------
// CCSpark — the "this one went through the whole pipeline" badge (issue #68).
//
// A PR only earns the ✨ when BOTH halves of the promise held: the scheduler's
// review-and-improve pass completed at least once against some head commit
// (`review.lastReviewedSha`), and GitHub reports the PR as MERGED, i.e. the
// reviewed work actually landed on the default branch. Either half alone is
// not a finished result, so neither lights the badge.
//
// The decision lives in one pure function shared by the browser (via the
// `CCSpark` global) and the unit tests (via `module.exports`): the issue row
// and the PR row must never disagree about what "done" means. It reads only
// data already in the payload — no GitHub request, no state change.
// ---------------------------------------------------------------------------
(function (global) {
  'use strict';

  var ICON = '\u2728'; // ✨

  function reviewedSha(pr) {
    var sha = pr && pr.review && pr.review.lastReviewedSha;
    if (typeof sha !== 'string') return null;
    sha = sha.trim();
    return sha ? sha : null;
  }

  // A PR is "fully vetted" only when it was reviewed AND merged. `state` comes
  // straight from GitHub; a record written before that field existed holds
  // null, which correctly reads as "not known to be merged".
  function isReviewedAndMerged(pr) {
    return Boolean(pr) && pr.state === 'MERGED' && reviewedSha(pr) !== null;
  }

  function describe(pr) {
    var sha = reviewedSha(pr);
    var short = sha ? sha.slice(0, 7) : '';
    var num = pr && pr.prNumber != null ? '#' + pr.prNumber : null;
    var bits = [];
    if (num) bits.push('PR ' + num);
    if (short) bits.push('reviewed at ' + short);
    var suffix = bits.length ? ' (' + bits.join(', ') + ')' : '';
    return {
      text: ICON,
      prNumber: pr && pr.prNumber != null ? pr.prNumber : null,
      sha: sha,
      shortSha: short,
      title: 'Reviewed and merged into main' + suffix,
    };
  }

  // The badge for a single PR row. Returns null when the row has not earned it,
  // so callers render nothing (or an invisible placeholder) instead.
  function prSparkView(pr) {
    return isReviewedAndMerged(pr) ? describe(pr) : null;
  }

  // The badge for an issue row: an issue can carry several PRs (superseded
  // attempts, PRs merely referencing it), and one of them finishing the whole
  // pipeline is enough for the issue to count as delivered.
  function issueSparkView(prs) {
    var list = Array.isArray(prs) ? prs : [];
    for (var i = 0; i < list.length; i++) {
      if (isReviewedAndMerged(list[i])) return describe(list[i]);
    }
    return null;
  }

  var api = {
    ICON: ICON,
    isReviewedAndMerged: isReviewedAndMerged,
    prSparkView: prSparkView,
    issueSparkView: issueSparkView,
  };

  global.CCSpark = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
