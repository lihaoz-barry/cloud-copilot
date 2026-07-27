/* eslint-disable no-var */
// ---------------------------------------------------------------------------
// CCChat — the one markdown/streaming renderer shared by every surface that
// streams Copilot CLI output: the PR chat panel, the pre-issue chat panel, the
// Admin Terminal and the pipeline log panels.
//
// Why this exists (see issue #24): every surface used to append one DOM text
// node per SSE chunk into a monospace <div>, so a turn was unreadable raw text
// until it finished, and a long turn built thousands of sibling nodes plus a
// forced reflow each chunk. This module instead re-parses the accumulated raw
// string on a throttled cadence and patches only the markdown blocks that
// actually changed.
//
// Library stack (all vendored under /vendor, nothing is fetched from a CDN at
// runtime — the app is used over LAN and must work with no internet):
//   marked       markdown -> HTML (CommonMark + GFM: tables, task lists, ...)
//   DOMPurify    sanitizes that HTML; model output is untrusted
//   highlight.js syntax highlighting for code fences
// ---------------------------------------------------------------------------
(function (global) {
  'use strict';

  var marked = global.marked;
  var DOMPurify = global.DOMPurify;
  var hljs = global.hljs;

  // How close to the bottom (px) still counts as "the user is following along".
  var STICK_SLOP = 40;
  // Streaming re-render cadence. One frame is too fast to be worth it and 100ms
  // feels laggy; ~60ms lands on "continuous" without burning the main thread.
  var RENDER_MS = 60;
  // Code/log blocks longer than this get folded behind a "Show more".
  var COLLAPSE_LINES = 40;

  if (marked && marked.setOptions) {
    marked.setOptions({
      gfm: true,
      breaks: true,   // CLI output uses hard line breaks, not blank lines
      pedantic: false,
    });
  }

  // Model output is untrusted: no scripts, no inline styles, no event handlers,
  // no embedded frames. DOMPurify strips on*/javascript: URLs by default; the
  // explicit lists below close off the rest.
  var PURIFY_CFG = {
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form',
      'button', 'select', 'textarea', 'link', 'meta', 'base'],
    FORBID_ATTR: ['style', 'srcset', 'formaction', 'ping'],
    ALLOW_DATA_ATTR: false,
  };

  if (DOMPurify && DOMPurify.addHook) {
    DOMPurify.addHook('afterSanitizeAttributes', function (node) {
      // Links in an answer point at GitHub/docs — open them away from the app
      // so a stray tap never drops an in-flight turn, and never leak referrers.
      if (node.tagName === 'A' && node.getAttribute('href')) {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer nofollow');
      }
      // GFM task lists need <input>, which is otherwise the one tag worth
      // fearing here. Allow exactly the inert checkbox marked emits and throw
      // away every other input (and every attribute it came with).
      if (node.tagName === 'INPUT') {
        var checked = node.hasAttribute('checked');
        if ((node.getAttribute('type') || '').toLowerCase() !== 'checkbox') {
          if (node.parentNode) node.parentNode.removeChild(node);
          return;
        }
        while (node.attributes.length) node.removeAttribute(node.attributes[0].name);
        node.setAttribute('type', 'checkbox');
        node.setAttribute('disabled', '');
        if (checked) node.setAttribute('checked', '');
      }
    });
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function sanitize(html) {
    if (!DOMPurify || !DOMPurify.sanitize) return escapeHtml(html);
    return DOMPurify.sanitize(html, PURIFY_CFG);
  }

  // --- markdown -----------------------------------------------------------

  // Mid-stream the tail of the buffer is almost always half-written markdown.
  // The one case worth repairing is an unterminated code fence: without this
  // the whole rest of the answer renders as paragraphs and then snaps into a
  // <pre> the moment the closing fence arrives. Close it so it reads as code
  // from the first line. Everything else (a half-typed **bold**, a table with
  // no delimiter row yet) degrades to literal text on its own, which is fine.
  function closeOpenFence(src) {
    var lines = String(src || '').split('\n');
    var fence = null;
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].match(/^\s{0,3}(`{3,}|~{3,})/);
      if (!m) continue;
      if (!fence) fence = m[1].charAt(0) === '`' ? '```' : '~~~';
      else if (m[1].charAt(0) === (fence.charAt(0))) fence = null;
    }
    if (!fence) return src;
    return src + (/\n$/.test(src) ? '' : '\n') + fence;
  }

  function renderMarkdown(src, streaming) {
    var text = String(src == null ? '' : src);
    if (streaming) text = closeOpenFence(text);
    var html;
    try {
      html = marked && marked.parse ? marked.parse(text) : '<pre>' + escapeHtml(text) + '</pre>';
    } catch (e) {
      html = '<pre>' + escapeHtml(text) + '</pre>';
    }
    return sanitize(html);
  }

  // --- block splitting ----------------------------------------------------
  // Streaming re-parses the whole buffer, but only the *tail* actually changes.
  // Splitting the source into top-level blocks lets us keep the DOM for every
  // block whose source text is byte-identical to last time and rebuild only the
  // last one — so a 5k-token answer costs one small parse per frame instead of
  // rebuilding (and re-highlighting) the entire message.

  function splitRawBlocks(src) {
    var lines = String(src || '').split('\n');
    var blocks = [];
    var cur = [];
    var fenceChar = null;

    function flush() { if (cur.length) { blocks.push(cur.join('\n')); cur = []; } }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (fenceChar) {
        cur.push(line);
        var close = line.match(/^\s{0,3}(`{3,}|~{3,})\s*$/);
        if (close && close[1].charAt(0) === fenceChar) { fenceChar = null; flush(); }
        continue;
      }
      var open = line.match(/^\s{0,3}(`{3,}|~{3,})/);
      if (open) { flush(); cur.push(line); fenceChar = open[1].charAt(0); continue; }
      if (line.trim() === '') { cur.push(line); flush(); continue; }
      cur.push(line);
    }
    flush();
    return blocks;
  }

  function blockKind(block) {
    var first = '';
    var lines = block.split('\n');
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].trim() !== '') { first = lines[i]; break; }
    }
    if (/^\s{0,3}(`{3,}|~{3,})/.test(first)) return 'code';
    if (/^\s{0,3}([-*+]|\d+[.)])\s/.test(first)) return 'list';
    if (/^\s{0,3}>/.test(first)) return 'quote';
    if (/^\s{0,3}\|/.test(first)) return 'table';
    if (/^\s{4,}\S/.test(first)) return 'indent';
    return 'para';
  }

  // A loose list (blank lines between items) or an indented continuation must
  // stay in one block or marked would emit a separate <ul> per item.
  function splitBlocks(src) {
    var raw = splitRawBlocks(src);
    var out = [];
    var kinds = [];
    for (var i = 0; i < raw.length; i++) {
      var k = blockKind(raw[i]);
      var prevK = kinds.length ? kinds[kinds.length - 1] : null;
      var mergeable = (k === prevK && (k === 'list' || k === 'quote' || k === 'table'))
        || (k === 'indent' && prevK && prevK !== 'code');
      if (mergeable) {
        out[out.length - 1] += '\n' + raw[i];
      } else {
        out.push(raw[i]);
        kinds.push(k);
      }
    }
    return out.length ? out : [''];
  }

  // --- post-render enhancement (highlight, copy, collapse) ----------------

  function copyText(text, btn) {
    var done = function (ok) {
      var old = btn.textContent;
      btn.textContent = ok ? '✓ Copied' : '✗ Failed';
      btn.disabled = true;
      setTimeout(function () { btn.textContent = old; btn.disabled = false; }, 1200);
    };
    if (global.navigator && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(fallbackCopy(text)); });
    } else {
      done(fallbackCopy(text));
    }
  }

  // Safari denies navigator.clipboard on plain-HTTP LAN origins, which is
  // exactly how this app is served — so keep the execCommand path around.
  function fallbackCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }

  function makeCopyBtn(label, getText) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'cc-copy';
    b.textContent = label;
    b.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      copyText(getText(), b);
    });
    return b;
  }

  function collapseIfLong(wrap, codeEl) {
    var lines = codeEl.textContent.split('\n').length;
    if (lines <= COLLAPSE_LINES) return;
    wrap.classList.add('cc-collapsed');
    var more = document.createElement('button');
    more.type = 'button';
    more.className = 'cc-more';
    more.textContent = 'Show all ' + lines + ' lines';
    more.addEventListener('click', function () {
      var collapsed = wrap.classList.toggle('cc-collapsed');
      more.textContent = collapsed ? 'Show all ' + lines + ' lines' : 'Show less';
    });
    wrap.appendChild(more);
  }

  // Decorate every <pre><code> produced by marked: highlight it, wrap it so a
  // copy button can float over it, and fold very long tool/terminal dumps.
  // `finalize` is false for the block still being streamed — highlighting
  // half-written code every frame is wasted work and flickers.
  function enhanceCode(root, finalize) {
    var pres = root.querySelectorAll('pre');
    for (var i = 0; i < pres.length; i++) {
      var pre = pres[i];
      if (pre.parentNode && pre.parentNode.classList && pre.parentNode.classList.contains('cc-pre')) continue;
      var code = pre.querySelector('code');
      var wrap = document.createElement('div');
      wrap.className = 'cc-pre';
      pre.parentNode.insertBefore(wrap, pre);
      wrap.appendChild(pre);
      (function (c) {
        wrap.appendChild(makeCopyBtn('Copy', function () { return c ? c.textContent : pre.textContent; }));
      }(code));
      if (finalize && code) {
        if (hljs && hljs.highlightElement) {
          try { hljs.highlightElement(code); } catch (e) { /* unknown language — leave as plain */ }
        }
        collapseIfLong(wrap, code);
      }
    }
  }

  // --- sticky-bottom scrolling -------------------------------------------
  // Autoscroll used to be unconditional, so scrolling up to read earlier output
  // during a live turn yanked you back on the next token. Now we only pin to the
  // bottom while the user is already there, and surface a "jump to latest" pill
  // otherwise.
  function getSticky(scrollEl, opts) {
    if (!scrollEl) return null;
    if (scrollEl.__ccSticky) return scrollEl.__ccSticky;
    opts = opts || {};

    var state = { stuck: true, active: false };

    function atBottom() {
      return scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight <= STICK_SLOP;
    }

    var pill = null;
    // The pill must not scroll with the content, so it needs a positioned,
    // non-scrolling ancestor sized like the scroll box — hence the wrapper.
    // Only the chat surfaces opt in; the pipeline log panels get sticky
    // autoscroll without the extra DOM so their layout is untouched.
    if (opts.pill && scrollEl.parentNode) {
      var host = document.createElement('div');
      host.className = 'cc-scrollhost';
      scrollEl.parentNode.insertBefore(host, scrollEl);
      host.appendChild(scrollEl);
      pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'cc-jump';
      pill.hidden = true;
      pill.textContent = '↓ Jump to latest';
      pill.addEventListener('click', function () {
        state.stuck = true;
        scrollEl.scrollTop = scrollEl.scrollHeight;
        update();
      });
      host.appendChild(pill);
    }

    function update() {
      if (pill) pill.hidden = !(state.active && !state.stuck);
    }

    scrollEl.addEventListener('scroll', function () {
      state.stuck = atBottom();
      update();
    }, { passive: true });

    var api = {
      isStuck: function () { return state.stuck; },
      // Called after every content change: honour the user's scroll position.
      follow: function () {
        if (state.stuck) scrollEl.scrollTop = scrollEl.scrollHeight;
        update();
      },
      pin: function () { state.stuck = true; scrollEl.scrollTop = scrollEl.scrollHeight; update(); },
      setActive: function (on) {
        state.active = !!on;
        if (on && atBottom()) state.stuck = true;
        update();
      },
    };
    scrollEl.__ccSticky = api;
    return api;
  }

  // --- markdown container -------------------------------------------------

  // Patch `el` to show `src`, reusing the DOM of every leading block whose
  // source text hasn't changed. Returns nothing; state lives on the element.
  function patchBlocks(el, src, streaming) {
    var blocks = splitBlocks(src);
    var prev = el.__ccBlocks || [];
    // The previously-last block may have been rendered with a synthesised
    // closing fence, so it can never be treated as stable.
    var stableLimit = Math.max(0, prev.length - 1);
    var i = 0;
    while (i < stableLimit && i < blocks.length && prev[i] === blocks[i]) i++;
    while (el.children.length > i) el.removeChild(el.lastChild);
    for (var j = i; j < blocks.length; j++) {
      var isTail = j === blocks.length - 1;
      var div = document.createElement('div');
      div.className = 'cc-blk';
      div.innerHTML = renderMarkdown(blocks[j], streaming && isTail);
      el.appendChild(div);
      enhanceCode(div, !(streaming && isTail));
    }
    el.__ccBlocks = blocks;
  }

  // One-shot render of a finished message (chat history, recovered transcripts).
  // `trailingHtml` is app-generated markup (the footer chip strip, an [aborted]
  // note) that is appended verbatim after the answer body.
  function renderInto(el, src, opts) {
    opts = opts || {};
    el.classList.add('cc-md');
    el.__ccBlocks = null;
    el.innerHTML = '';
    if (String(src || '').trim()) patchBlocks(el, src, false);
    if (opts.trailingHtml) el.insertAdjacentHTML('beforeend', opts.trailingHtml);
    if (opts.copyRaw !== false && String(src || '').trim()) {
      el.appendChild(makeCopyBtn('⧉ Copy', function () { return String(src || ''); }));
      el.classList.add('cc-hascopy');
    }
    return el;
  }

  // --- streaming sinks ----------------------------------------------------

  // Markdown stream: chunks accumulate into `raw`, and the DOM is patched on a
  // throttled cadence instead of once per chunk.
  function createStream(el, opts) {
    opts = opts || {};
    var sticky = getSticky(opts.scrollEl || null, { pill: opts.pill !== false });
    var raw = '';
    var dirty = false;
    var timer = null;
    var closed = false;

    el.classList.add('cc-md', 'cc-streaming');
    el.innerHTML = '';
    el.__ccBlocks = null;
    var cursor = document.createElement('span');
    cursor.className = 'cc-cursor';
    el.appendChild(cursor);
    if (sticky) sticky.setActive(true);

    function paint() {
      timer = null;
      if (closed || !dirty) return;
      dirty = false;
      if (cursor.parentNode === el) el.removeChild(cursor);
      patchBlocks(el, raw, true);
      el.appendChild(cursor);
      if (sticky) sticky.follow();
    }

    function schedule() {
      dirty = true;
      if (timer || closed) return;
      timer = setTimeout(function () {
        if (global.requestAnimationFrame) requestAnimationFrame(paint);
        else paint();
      }, RENDER_MS);
    }

    return {
      el: el,
      getRaw: function () { return raw; },
      push: function (text) {
        if (closed || !text) return;
        raw += text;
        schedule();
      },
      // A job re-subscribe replays the whole transcript as one chunk, so the
      // buffer and the DOM both have to be thrown away first.
      reset: function () {
        raw = '';
        el.__ccBlocks = null;
        while (el.firstChild) el.removeChild(el.firstChild);
        el.appendChild(cursor);
        dirty = false;
      },
      // Final render. `body` (defaults to the accumulated raw) lets callers
      // strip the CLI footer first; `trailingHtml` is trusted app markup.
      finish: function (o) {
        o = o || {};
        closed = true;
        if (timer) { clearTimeout(timer); timer = null; }
        var body = o.body != null ? o.body : raw;
        el.classList.remove('cc-streaming');
        renderInto(el, body, {
          trailingHtml: o.trailingHtml || '',
          copyRaw: o.copyRaw !== false,
        });
        if (!String(body || '').trim() && !o.trailingHtml && o.emptyHtml) {
          el.insertAdjacentHTML('afterbegin', o.emptyHtml);
        }
        if (sticky) { sticky.setActive(false); sticky.follow(); }
      },
      // Abandon a turn without rendering it (the user switched conversations).
      // Must still tear the stream down or the pending repaint keeps firing and
      // the scroller stays in "a turn is live" mode, showing the jump pill over
      // a static transcript.
      dispose: function () {
        closed = true;
        if (timer) { clearTimeout(timer); timer = null; }
        el.classList.remove('cc-streaming');
        if (cursor.parentNode === el) el.removeChild(cursor);
        if (sticky) sticky.setActive(false);
      },
    };
  }

  // Plain-text stream for the pipeline log panels. Same sticky-scroll and
  // batching guarantees, but CLI logs (interleaved stdout/stderr, progress
  // spinners) are not markdown, so they stay verbatim. Consecutive chunks of the
  // same stream extend one text node rather than adding a node each.
  function appendText(panelEl, text, cls, opts) {
    if (!panelEl || !text) return;
    opts = opts || {};
    var sticky = opts.scrollEl === false ? null : getSticky(opts.scrollEl || panelEl, { pill: !!opts.pill });
    var last = panelEl.__ccLastRun;
    // `container` is what actually sits under the panel: the text node itself
    // for stdout, or the wrapping <span class="stderr"> for a classed run.
    if (last && last.cls === (cls || null) && last.container.parentNode === panelEl) {
      last.node.appendData(text);
    } else {
      var node = document.createTextNode(text);
      var container = node;
      if (cls) {
        container = document.createElement('span');
        container.className = cls;
        container.appendChild(node);
      }
      panelEl.appendChild(container);
      panelEl.__ccLastRun = { cls: cls || null, node: node, container: container };
    }
    if (sticky) sticky.follow();
  }

  function resetText(panelEl) {
    if (!panelEl) return;
    panelEl.__ccLastRun = null;
    panelEl.innerHTML = '';
  }

  global.CCChat = {
    renderMarkdown: renderMarkdown,
    renderInto: renderInto,
    createStream: createStream,
    sticky: getSticky,
    appendText: appendText,
    resetText: resetText,
    escapeHtml: escapeHtml,
    splitBlocks: splitBlocks,
    closeOpenFence: closeOpenFence,
  };
}(typeof window !== 'undefined' ? window : this));
