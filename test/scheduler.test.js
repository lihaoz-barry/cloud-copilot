'use strict';

require('./helpers').sandbox('cc-sched-');

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const queue = require('../lib/queue');
const config = require('../lib/queueConfig');
const scheduler = require('../lib/scheduler');

function at(hour, minute = 0) {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d;
}

/** Freeze the clock at a given local time for the duration of `fn`. */
function withClock(hour, minute, fn) {
  const RealDate = Date;
  const frozen = at(hour, minute);
  // eslint-disable-next-line no-global-assign
  Date = class extends RealDate {
    constructor(...args) {
      if (!args.length) return new RealDate(frozen.getTime());
      return new RealDate(...args);
    }
    static now() {
      return frozen.getTime();
    }
  };
  try {
    return fn();
  } finally {
    // eslint-disable-next-line no-global-assign
    Date = RealDate;
  }
}

const today = () => queue.localDateKey();
const yesterday = () =>
  queue.localDateKey(new Date(Date.now() - 24 * 60 * 60 * 1000));

test('A6.1 a scheduled time that has passed today, not yet run, is due', () => {
  withClock(4, 0, () => {
    assert.equal(scheduler.isDue('03:00', yesterday()), true);
  });
});

test('A6.2 already run today → not due again', () => {
  withClock(4, 0, () => {
    assert.equal(scheduler.isDue('03:00', today()), false);
  });
});

test('A6.2b before the scheduled time → not due', () => {
  withClock(2, 59, () => {
    assert.equal(scheduler.isDue('03:00', yesterday()), false);
  });
  withClock(3, 0, () => {
    assert.equal(scheduler.isDue('03:00', yesterday()), true, 'due exactly on the minute');
  });
});

test('A6.3 a machine asleep at 03:00 catches up when it wakes', () => {
  // This is why the daily timers are "has it passed AND not run today?" rather
  // than one-shot setTimeouts: a missed window is caught, not skipped.
  withClock(10, 30, () => {
    assert.equal(scheduler.isDue('03:00', yesterday()), true);
  });
});

test('A6.4 a new calendar day re-arms the schedule', () => {
  withClock(9, 0, () => {
    assert.equal(scheduler.isDue('08:00', today()), false);
    assert.equal(scheduler.isDue('08:00', '2020-01-01'), true);
  });
});

test('A6 a malformed time is never due (rather than firing constantly)', () => {
  withClock(12, 0, () => {
    assert.equal(scheduler.isDue('nonsense', yesterday()), false);
    assert.equal(scheduler.isDue('', yesterday()), false);
  });
});

test('activeRepos honours both the master switch and per-repo settings', () => {
  fs.writeFileSync(
    process.env.CC_QUEUE_CONFIG,
    JSON.stringify({ enabled: false, repos: {} }),
  );
  scheduler.setDeps({ reposRoot: '/nonexistent' });
  assert.deepEqual(scheduler.activeRepos(), [], 'master switch off → nothing is active');

  fs.writeFileSync(process.env.CC_QUEUE_CONFIG, JSON.stringify({ enabled: true, repos: {} }));
  assert.deepEqual(scheduler.activeRepos(), [], 'no repos on disk → nothing to do, no crash');
});

test('config drives the schedule that isDue reads', () => {
  fs.writeFileSync(
    process.env.CC_QUEUE_CONFIG,
    JSON.stringify({ syncAt: '05:30', reportAt: '09:15' }),
  );
  const c = config.get();
  assert.equal(c.syncAt, '05:30');
  withClock(5, 29, () => assert.equal(scheduler.isDue(c.syncAt, yesterday()), false));
  withClock(5, 31, () => assert.equal(scheduler.isDue(c.syncAt, yesterday()), true));
});
