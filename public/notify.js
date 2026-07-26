/* cloud-copilot — completion notifications (issue #15).
 *
 * One place that turns "a job reached a terminal state" into user-perceivable
 * feedback, in decreasing order of intrusiveness:
 *
 *   1. a short chime (distinct tone for success vs. failure),
 *   2. a system Notification — shown only when the tab is NOT visible+focused,
 *      so it doesn't spam the user while they're watching the log,
 *   3. navigator.vibrate() where supported,
 *   4. an in-page toast, which always fires and is the graceful degradation
 *      path when sound is muted or notification permission was denied.
 *
 * Platform notes:
 *   - iOS Safari will not play any audio until it has been unlocked from a user
 *     gesture, so we prime the <audio> elements (and an AudioContext) on the
 *     first tap/keypress anywhere in the app.
 *   - iOS only exposes `Notification` when the site is installed to the Home
 *     Screen (16.4+), and only via `registration.showNotification()`. In a plain
 *     Safari tab we detect that and the settings drawer shows an "Add to Home
 *     Screen" hint rather than silently doing nothing.
 *   - Real push while the app is fully closed needs Web Push (VAPID) — phase 2.
 */
(function () {
  'use strict';

  const LS_SOUND = 'cc.notify.sound';
  const LS_SYSTEM = 'cc.notify.system';
  const DEDUP_MS = 60000; // same job key can't notify twice within a minute
  const TOAST_MS = 6000;

  const ACTION_LABEL = {
    work: 'Create PR',
    deploy: 'Deploy',
    merge: 'Merge',
    'merge-main': 'Merge main',
    chat: 'PR chat',
    'admin-chat': 'Admin chat',
    'preissue-chat': 'Issue draft',
  };
  const STATUS_TEXT = {
    success: 'finished successfully',
    failed: 'failed',
    aborted: 'was aborted',
    conflict: 'hit merge conflicts',
  };

  // ---------------------------------------------------------------- settings
  function readFlag(key, dflt) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? dflt : v === '1';
    } catch {
      return dflt;
    }
  }
  function writeFlag(key, value) {
    try { localStorage.setItem(key, value ? '1' : '0'); } catch { /* private mode */ }
  }

  const soundEnabled = () => readFlag(LS_SOUND, true);
  const systemEnabled = () => readFlag(LS_SYSTEM, true);

  // ------------------------------------------------------------ capabilities
  const hasNotification = () => typeof window.Notification !== 'undefined';

  function isStandalone() {
    if (window.navigator.standalone === true) return true;
    try { return window.matchMedia('(display-mode: standalone)').matches; } catch { return false; }
  }

  function isIOS() {
    const ua = navigator.userAgent || '';
    return /iPad|iPhone|iPod/.test(ua) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  /** 'ok' | 'needs-install' | 'unsupported' */
  function support() {
    if (hasNotification()) return 'ok';
    if (isIOS() && !isStandalone()) return 'needs-install';
    return 'unsupported';
  }

  const permission = () => (hasNotification() ? Notification.permission : 'unsupported');

  // ------------------------------------------------------- service worker
  let swReg = null;

  function secureEnough() {
    return location.protocol === 'https:' ||
      ['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname);
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator) || !secureEnough()) return;
    navigator.serviceWorker.register('/sw.js').then((reg) => { swReg = reg; }).catch(() => { /* ignore */ });
    navigator.serviceWorker.ready.then((reg) => { swReg = reg; }).catch(() => { /* ignore */ });
  }

  async function registration() {
    if (swReg) return swReg;
    if (!('serviceWorker' in navigator)) return null;
    try { swReg = (await navigator.serviceWorker.getRegistration()) || null; } catch { swReg = null; }
    return swReg;
  }

  // -------------------------------------------------------------------- audio
  const audioEls = Object.create(null);
  let audioCtx = null;
  let audioUnlocked = false;

  function audioFor(name) {
    if (!audioEls[name]) {
      const a = new Audio(`/sounds/${name}.wav`);
      a.preload = 'auto';
      a.volume = 0.6;
      audioEls[name] = a;
    }
    return audioEls[name];
  }

  /**
   * Must run inside a user gesture. Plays both chimes muted so iOS marks the
   * elements as user-activated; later `play()` calls from a timer/stream then
   * work without a fresh gesture.
   */
  function unlockAudio() {
    if (audioUnlocked) return;
    audioUnlocked = true;
    for (const name of ['success', 'failure']) {
      const a = audioFor(name);
      const restore = () => { try { a.pause(); a.currentTime = 0; } catch { /* ignore */ } a.muted = false; };
      a.muted = true;
      try {
        const p = a.play();
        if (p && typeof p.then === 'function') p.then(restore).catch(restore);
        else restore();
      } catch {
        restore();
      }
    }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        audioCtx = audioCtx || new AC();
        if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => { /* ignore */ });
      }
    } catch { /* no WebAudio */ }
  }

  /** Last-resort synthesised chime when the .wav can't be played. */
  function beep(ok) {
    if (!audioCtx) return;
    try {
      const now = audioCtx.currentTime;
      const notes = ok ? [880, 1318.5] : [440, 329.6];
      notes.forEach((freq, i) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        const t0 = now + i * 0.16;
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(0.25, t0 + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.3);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(t0);
        osc.stop(t0 + 0.32);
      });
    } catch { /* ignore */ }
  }

  function playSound(ok) {
    if (!soundEnabled()) return;
    const a = audioFor(ok ? 'success' : 'failure');
    try { a.currentTime = 0; } catch { /* not seekable yet */ }
    try {
      const p = a.play();
      if (p && typeof p.catch === 'function') p.catch(() => beep(ok));
    } catch {
      beep(ok);
    }
  }

  function vibrate(ok) {
    if (!soundEnabled()) return;
    try {
      if (navigator.vibrate) navigator.vibrate(ok ? [60, 60, 60] : [180, 90, 180]);
    } catch { /* ignore */ }
  }

  // ------------------------------------------------------------ permission
  async function requestPermission() {
    if (!hasNotification()) return support();
    if (Notification.permission !== 'default') return Notification.permission;
    try {
      const result = Notification.requestPermission();
      if (result && typeof result.then === 'function') return await result;
      // Very old callback-only implementations.
      return await new Promise((resolve) => { Notification.requestPermission(resolve); });
    } catch {
      return Notification.permission;
    }
  }

  async function showSystemNotification(title, body, tag, url) {
    if (!systemEnabled() || !hasNotification()) return false;
    if (Notification.permission !== 'granted') return false;
    const options = {
      body,
      tag,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: url || location.href },
    };
    const reg = await registration();
    if (reg && typeof reg.showNotification === 'function') {
      try {
        await reg.showNotification(title, options);
        return true;
      } catch { /* fall through to the constructor */ }
    }
    try {
      const n = new Notification(title, options);
      n.onclick = () => { try { window.focus(); n.close(); } catch { /* ignore */ } };
      return true;
    } catch {
      return false; // iOS: constructor is not usable, SW path is the only one
    }
  }

  // -------------------------------------------------------------------- toast
  let toastHost = null;

  function ensureToastHost() {
    if (toastHost) return toastHost;
    const style = document.createElement('style');
    style.textContent = `
      #cc-toasts {
        position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%);
        z-index: 200; display: flex; flex-direction: column; gap: 8px;
        width: min(420px, calc(100vw - 24px)); pointer-events: none;
      }
      .cc-toast {
        pointer-events: auto; background: Canvas; color: CanvasText;
        border: 1px solid #8884; border-left: 4px solid #2563eb; border-radius: 12px;
        box-shadow: 0 8px 28px #0006; padding: 10px 12px; font-size: .85rem;
        animation: cc-toast-in .18s ease-out;
      }
      .cc-toast.ok { border-left-color: #16a34a; }
      .cc-toast.bad { border-left-color: #dc2626; }
      .cc-toast b { display: block; font-size: .86rem; margin-bottom: 2px; }
      .cc-toast span { color: #888; }
      @keyframes cc-toast-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
    `;
    document.head.appendChild(style);
    toastHost = document.createElement('div');
    toastHost.id = 'cc-toasts';
    document.body.appendChild(toastHost);
    return toastHost;
  }

  function toast(title, body, ok) {
    const host = ensureToastHost();
    const el = document.createElement('div');
    el.className = `cc-toast ${ok ? 'ok' : 'bad'}`;
    const t = document.createElement('b');
    t.textContent = title;
    const b = document.createElement('span');
    b.textContent = body;
    el.append(t, b);
    el.addEventListener('click', () => el.remove());
    host.appendChild(el);
    setTimeout(() => el.remove(), TOAST_MS);
  }

  // ---------------------------------------------------------------- de-dup
  const seen = new Map();
  const watched = new Set();

  function alreadyNotified(key) {
    const now = Date.now();
    for (const [k, t] of seen) if (now - t > DEDUP_MS) seen.delete(k);
    if (seen.has(key)) return true;
    seen.set(key, now);
    return false;
  }

  // ------------------------------------------------------------------- main
  function keyFor(info) {
    return info.key || `${info.action}:${info.repo || ''}#${info.issue || ''}:${info.pr || ''}`;
  }

  /** Record that this page has seen the given job actually running. */
  function watch(info) {
    if (info) watched.add(keyFor(info));
  }

  function describe(info) {
    const action = ACTION_LABEL[info.action] || info.action || 'Task';
    const where = info.repo
      ? `${info.repo}${info.pr ? ` PR #${info.pr}` : info.issue ? ` #${info.issue}` : ''}`
      : '';
    const title = where ? `${action} · ${where}` : action;
    const body = `${action} ${STATUS_TEXT[info.status] || info.status}.`;
    return { title, body };
  }

  /**
   * Announce a job that just reached a terminal state.
   *
   * `info.replayed` means the terminal state was learned from a replay of
   * server-side state rather than from watching the job run (a re-subscribe to
   * an already-finished job, or a status poll). Those only notify if this page
   * previously saw the very same job running — that's what keeps jobs which
   * completed before the page was opened silent.
   *
   * @param {{action:string, status:string, repo?:string, issue?:number,
   *          pr?:number, key?:string, url?:string, title?:string, body?:string,
   *          replayed?:boolean}} info
   */
  function jobFinished(info) {
    if (!info || !info.status) return;
    if (!Object.prototype.hasOwnProperty.call(STATUS_TEXT, info.status)) return;
    const key = keyFor(info);
    if (info.replayed && !watched.has(key)) return;
    if (alreadyNotified(key)) return;
    watched.delete(key);
    announce(info);
  }

  function announce(info) {
    const ok = info.status === 'success';
    const d = describe(info);
    const title = info.title || d.title;
    const body = info.body || d.body;
    playSound(ok);
    vibrate(ok);
    toast(title, body, ok);
    // Only bother the OS when the user isn't already looking at the page.
    const watching = document.visibilityState === 'visible' && document.hasFocus();
    if (!watching) showSystemNotification(title, body, info.key || title, info.url);
  }

  /** "Test notification" button — always fires, ignoring visibility + de-dup. */
  async function test() {
    unlockAudio();
    if (systemEnabled() && hasNotification() && Notification.permission === 'default') {
      await requestPermission();
    }
    const title = 'cloud-copilot · test';
    const body = 'Notifications are working. This is what a finished task looks like.';
    playSound(true);
    vibrate(true);
    toast(title, body, true);
    const shown = await showSystemNotification(title, body, 'cc-test', location.href);
    return { shown, support: support(), permission: permission() };
  }

  // ------------------------------------------------------- gesture bootstrap
  const GESTURES = ['pointerdown', 'touchend', 'keydown', 'click'];
  function onFirstGesture() {
    unlockAudio();
    for (const type of GESTURES) document.removeEventListener(type, onFirstGesture, true);
  }
  for (const type of GESTURES) document.addEventListener(type, onFirstGesture, true);

  registerServiceWorker();

  window.CCNotify = {
    jobFinished,
    watch,
    test,
    unlockAudio,
    requestPermission,
    support,
    permission,
    isIOS,
    isStandalone,
    soundEnabled,
    systemEnabled,
    setSoundEnabled: (v) => writeFlag(LS_SOUND, v),
    setSystemEnabled: (v) => writeFlag(LS_SYSTEM, v),
  };
})();
