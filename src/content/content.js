/**
 * The part that actually blocks.
 *
 * Twitch is a single-page app that redraws its lists constantly, so there is no
 * "load" moment to hook: every pass re-reads the cards currently on screen, decides
 * on each, and stamps it so the next pass can skip it. A stamp carries the rules it
 * was made under, which is what makes a change in the settings take effect
 * everywhere without a reload.
 *
 * Cards are found through the links they contain rather than by class name.
 * Twitch's generated class names change every few weeks; `href="/lomaka"` does not.
 */
(function () {
  'use strict';

  /**
   * A card is marked with `data-as-state`, never with a class.
   *
   * Twitch's cards are React components with a `className` prop, and a re-render
   * that changes that prop rewrites the whole attribute — a class of ours in it is
   * simply gone, while the plate stays behind and stretches to whatever positioned
   * ancestor it can find. React leaves attributes it does not know about alone.
   */
  const PLATE_CLASS = 'as-plate';

  /**
   * Every link on the page is a candidate; the ones that point at a channel are
   * the cards.
   *
   * Deliberately not a list of Twitch's own selectors. `data-a-target` values come
   * and go — `side-nav-card` did — and each one that disappears takes a whole part
   * of the site out of the block silently. An address does not change shape.
   */
  const SEEDS = 'a[href]';

  /**
   * Chat is left alone, as in the app: a mention of a blocked channel is not a card,
   * and hiding the line it sits on would be a surprise.
   */
  const CHAT =
    '[data-a-target="chat-scroller"], [data-test-selector="chat-scrollable-area__message-container"],' +
    ' .chat-scrollable-area__message-container, [data-a-target="chat-input"], .chat-line__message';

  /**
   * The ascent from a link to its card never crosses one of these. They are the
   * containers that hold *several* cards, and blocking one would take the whole
   * row — which is exactly what a shelf of recommendations looks like when it is
   * the only channel on it.
   */
  const BOUNDARIES = [
    'section', 'nav', 'main', 'aside', 'ul', 'ol',
    '[role="list"]', '[role="region"]', '[role="main"]',
    '[class~="tw-tower"]',
    '[data-a-target*="shelf" i]', '[data-target*="shelf" i]',
  ].join(', ');

  /** First path segments that look like a channel but are not one. */
  const RESERVED = new Set([
    'directory', 'videos', 'video', 'clips', 'settings', 'search', 'subscriptions',
    'wallet', 'drops', 'prime', 'turbo', 'downloads', 'jobs', 'store', 'friends',
    'inventory', 'messages', 'u', 'popout', 'team', 'p', 'moderator', 'dashboard',
    'activate', 'login', 'signup', 'checkout', 'bits', 'following', 'followers',
    'collections', 'payments', 'products', 'subs', 'broadcast', 'creatorcamp',
    'security', 'legal', 'privacy', 'terms', 'about', 'help', 'redeem', 'gift',
  ]);

  const CHANNEL_PATH =
    /^\/([a-z0-9][a-z0-9_]{2,24})(?:\/(?:videos|clips|about|schedule|home|squad))?\/?$/i;

  let rules = null;
  let enabled = true;
  /** Signature of the rules a stamped card was judged under. */
  let token = '';
  /** Whether any card on the page carries a stamp worth clearing. */
  let stamped = false;
  let scanQueued = false;
  let lastUrl = location.href;

  // ---------------------------------------------------------------- rules

  async function loadRules() {
    const settings = await AS.loadSettings();
    const cache = await AS.loadTeamCache();
    const rosters = AS.rostersFrom(settings.teams, cache);

    enabled = settings.enabled;
    rules = AS.makeRules({ mode: settings.mode, words: settings.words, rosters: rosters });

    // Only a real change in the verdict a card would get is worth re-judging every
    // card on screen, so the stamp is a signature of the inputs, not a timestamp.
    const signature = JSON.stringify([
      enabled,
      settings.mode,
      settings.words,
      Object.keys(rosters).map((team) => team + ':' + rosters[team].length),
    ]);
    token = hash(signature);
    scan();
  }

  function hash(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
  }

  // ---------------------------------------------------------------- reading cards

  function loginFromHref(href) {
    if (!href) return null;
    let path = href;
    if (/^https?:\/\//i.test(href)) {
      let url;
      try {
        url = new URL(href);
      } catch (err) {
        return null;
      }
      if (!/(^|\.)twitch\.tv$/i.test(url.hostname)) return null;
      path = url.pathname;
    }
    if (path.charAt(0) !== '/') return null;
    const match = CHANNEL_PATH.exec(path.split(/[?#]/)[0]);
    if (!match) return null;
    const login = match[1].toLowerCase();
    return RESERVED.has(login) ? null : login;
  }

  /** True if [node] holds a link to some channel other than [login]. */
  function hasOtherChannel(node, login) {
    const links = node.querySelectorAll(SEEDS);
    for (const link of links) {
      const other = loginFromHref(link.getAttribute('href'));
      if (other && other !== login) return true;
    }
    return false;
  }

  const roots = new WeakMap();

  /** A card is never as wide as the page; a row of them is. */
  function tooWide(node, seed) {
    return node !== seed && node.offsetWidth > window.innerWidth * 0.5;
  }

  /** Whether something bigger is already marked around [node]. */
  function nested(node) {
    return !!(node.parentElement && node.parentElement.closest('[data-as-state]'));
  }

  /**
   * [cardRoot] for a link that is still where it was.
   *
   * Every pass walks every link on the page and the walk up from a link is the
   * expensive half, so the answer is kept — React holds on to its DOM nodes across
   * re-renders. It is dropped when the link moved, when the element it named has
   * since grown a second channel inside it, or when that element turns out to be
   * page-wide.
   *
   * Both of those re-checks earn their keep on the front page. A shelf below the
   * fold is laid out lazily: when it is first seen it can have a single card in it
   * and no size at all, and "the element with one channel in it" is then the whole
   * shelf. Its neighbours arrive and its size becomes real a moment later, and the
   * answer has to be allowed to change with them.
   */
  function resolveRoot(seed, login) {
    const known = roots.get(seed);
    if (
      known &&
      known.laid &&
      known.login === login &&
      known.card.isConnected &&
      known.card.parentElement === known.parent &&
      known.card.contains(seed) &&
      !nested(known.card) &&
      !tooWide(known.card, seed) &&
      !hasOtherChannel(known.card, login)
    ) {
      return known.card;
    }
    const card = cardRoot(seed, login);
    if (known && known.card !== card && known.card.isConnected) {
      // Whatever was marked under the old answer is not a card any more.
      clear(known.card);
      delete known.card.dataset.asToken;
    }
    // An answer reached before the browser laid the page out is a guess — every
    // element is the same size as every other one there. It is used, so that
    // nothing goes unblocked in the meantime, but it is re-taken next pass. The
    // entry is still kept: it is what lets the old mark be cleaned up.
    roots.set(seed, {
      login: login,
      card: card,
      parent: card.parentElement,
      laid: seed.offsetWidth > 0,
    });
    return card;
  }

  /**
   * The card a channel link belongs to: the largest ancestor that still describes
   * that channel and nothing else.
   *
   * Going one element too far up is what turns a plate over one card into a plate
   * over the whole row, and it is easy to do — Twitch wraps everything in half a
   * dozen anonymous layout `div`s. Three things stop the walk, and all three are
   * needed: a container that holds another channel, a landmark that holds several
   * cards by definition, and the shape of the thing itself. The last one is what
   * catches a row that happens to hold a single card at that moment: a wrapper is
   * as wide as what it wraps, a row is as wide as the page.
   */
  function cardRoot(seed, login) {
    const wide = window.innerWidth * 0.5;
    let node = seed;
    let width = node.offsetWidth;

    for (let depth = 0; depth < 8; depth++) {
      const parent = node.parentElement;
      if (!parent || parent === document.body || parent === document.documentElement) break;
      if (parent.matches(BOUNDARIES)) break;
      if (hasOtherChannel(parent, login)) break;

      const parentWidth = parent.offsetWidth;
      if (width > 0 && width < wide && parentWidth > wide) break;

      node = parent;
      width = parentWidth;
    }

    // The walk can still run past the card when only part of the page has been laid
    // out — an element with no size looks like every other. If what it settled on is
    // page-wide but something narrower on the way up is not, that narrower one is
    // the card. Nothing narrower means the card really is page-wide, as a row in a
    // list is, and the walk's answer stands.
    if (node !== seed && tooWide(node, seed)) {
      let narrowest = null;
      for (let up = seed.parentElement; up && up !== node; up = up.parentElement) {
        if (!tooWide(up, seed)) narrowest = up;
      }
      if (narrowest) node = narrowest;
    }
    return node;
  }

  /**
   * The text a card is matched against.
   *
   * Everything the card shows, plus the attributes that hold what it had to
   * truncate — `title`, `alt`, `aria-label`. In practice that is the stream title,
   * the tags, the category and the channel name.
   *
   * A wider net than the app's title-and-tags, on purpose. There is no reliable way
   * to point at "the title" in markup that renames itself every few weeks, a card in
   * the sidebar has no title at all, and a word list of one's own over-matching a
   * category is a far smaller problem than a rule that quietly stops firing.
   */
  function readCard(card) {
    const parts = [];
    const push = function (value) {
      const text = (value || '').trim();
      if (text && parts.indexOf(text) === -1) parts.push(text);
    };

    push(card.getAttribute('title'));
    push(card.getAttribute('aria-label'));
    card.querySelectorAll('[title], [alt], [aria-label]').forEach(function (node) {
      push(node.getAttribute('title'));
      push(node.getAttribute('alt'));
      push(node.getAttribute('aria-label'));
    });
    push((card.textContent || '').slice(0, 400));

    // Best effort, and only for the plate's second line: when the hit came from a
    // tag it reads better to name the tag the way the streamer wrote it.
    const tags = [];
    card
      .querySelectorAll('a[href*="/tags/"], [data-a-target*="tag" i], [class~="tw-tag"], [class*="ScTag" i]')
      .forEach(function (node) {
        const text = (node.textContent || '').trim();
        if (text && text.length < 40 && tags.indexOf(text) === -1) tags.push(text);
      });

    return { title: parts.join(' · '), tags: tags };
  }

  // ---------------------------------------------------------------- applying

  function scan() {
    if (!rules) return;
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      removePageBlock();
    }
    if (!enabled || rules.isEmpty) {
      clearAll();
      return;
    }

    // Two passes on purpose. Working out where a card ends measures elements, and
    // marking one changes them; interleaved, every card would make the browser lay
    // the page out again. Read everything first, write afterwards.
    const found = [];
    const seen = new Set();
    const seeds = document.querySelectorAll(SEEDS);
    for (const seed of seeds) {
      const login = loginFromHref(seed.getAttribute('href'));
      if (!login) continue;
      if (seed.closest(CHAT)) continue;

      const card = resolveRoot(seed, login);
      if (seen.has(card)) continue;
      seen.add(card);

      // The channel is part of the stamp because Twitch reuses a grid cell for
      // whatever stream lands in that slot next; the rest of the stamp catches a
      // change in the rules, and `needsRepair` a redraw that took our plate with it.
      const stamp = token + ':' + login;
      if (card.dataset.asToken === stamp && !needsRepair(card)) continue;

      found.push({
        card: card,
        login: login,
        stamp: stamp,
        height: card.offsetHeight,
        width: card.offsetWidth,
      });
    }

    for (const item of found) {
      // A root inside another root is a leftover from Twitch re-wrapping the card;
      // marking both would show one plate through the other. The outer one wins.
      if (found.some((other) => other !== item && other.card.contains(item.card))) continue;

      const info = readCard(item.card);
      apply(item.card, rules.check(item.login, info.title, info.tags), item.height, item.width);
      item.card.dataset.asToken = item.stamp;
      stamped = true;
    }

    sweepFillers();
    syncPageBlock();
  }

  function needsRepair(card) {
    return card.dataset.asState === 'covered' && !card.querySelector(':scope > .' + PLATE_CLASS);
  }

  function apply(card, verdict, height, width) {
    // A mark on something inside this card is an answer from before Twitch re-wrapped
    // it. Left alone it shows a second plate through this one.
    card.querySelectorAll('[data-as-state]').forEach(function (inner) {
      clear(inner);
      delete inner.dataset.asToken;
    });

    if (!verdict) {
      clear(card);
      return;
    }
    if (rules.mode === 'cover') {
      cover(card, verdict, height);
    } else {
      removePlate(card);
      restoreImages(card);
      delete card.dataset.asPos;
      card.dataset.asState = 'hidden';
      if (sharesWidth(card.parentElement)) addFiller(card, width);
      else dropFiller(card);
    }
  }

  /**
   * Containers that hand out their width to whatever is left in them: a grid, or a
   * row of flex items. A card taken out of one of those makes the rest grow, so
   * something has to stand in its place.
   */
  function sharesWidth(parent) {
    if (!parent) return false;
    const style = window.getComputedStyle(parent);
    if (style.display.indexOf('grid') !== -1) return true;
    return style.display.indexOf('flex') !== -1 && style.flexDirection.indexOf('row') === 0;
  }

  /** Card to the stand-in holding its slot, for the containers that need one. */
  const fillers = new WeakMap();
  const fillerOwners = new WeakMap();

  function addFiller(card, width) {
    const parent = card.parentElement;
    if (!parent) return;

    let filler = fillers.get(card);
    if (filler && filler.parentElement === parent) return;
    if (filler) filler.remove();

    filler = document.createElement('div');
    filler.dataset.asFiller = '';
    if (width > 0) filler.style.width = width + 'px';
    // Flex rows divide by what each item asks for, so the stand-in has to ask for
    // the same as the card it replaces.
    const style = window.getComputedStyle(card);
    filler.style.flexGrow = style.flexGrow;
    filler.style.flexShrink = style.flexShrink;
    filler.style.flexBasis = style.flexBasis;

    parent.appendChild(filler);
    fillers.set(card, filler);
    fillerOwners.set(filler, card);
  }

  function dropFiller(card) {
    const filler = fillers.get(card);
    if (filler) filler.remove();
    fillers.delete(card);
  }

  /**
   * Stand-ins whose card is gone — Twitch redrew the shelf, or the rules changed
   * under it. Cheap: there is one of these per blocked card, not per card.
   */
  function sweepFillers() {
    document.querySelectorAll('[data-as-filler]').forEach(function (filler) {
      const card = fillerOwners.get(filler);
      const alive =
        card &&
        card.isConnected &&
        card.dataset.asState === 'hidden' &&
        card.parentElement === filler.parentElement;
      if (!alive) filler.remove();
    });
  }

  function cover(card, verdict, height) {
    // Measured in the reading pass: a sidebar row is about 40 px tall and the full
    // caption has to shrink to fit it. Measuring beats guessing from the markup.
    const compact = height > 0 && height < 90;

    card.dataset.asState = 'covered';
    // The plate sizes itself against the card, so the card has to be a containing
    // block. Only ever asked of cards that are not positioned at all — overriding
    // one Twitch positions itself would move it.
    if (window.getComputedStyle(card).position === 'static') card.dataset.asPos = '1';
    else delete card.dataset.asPos;

    let plate = card.querySelector(':scope > .' + PLATE_CLASS);
    if (!plate) {
      plate = buildPlate();
      card.appendChild(plate);
    }
    plate.classList.toggle('as-plate--compact', compact);
    plate.firstChild.textContent = verdict.caption;
    plate.lastChild.textContent = verdict.detail;
    plate.lastChild.hidden = !verdict.detail;

    stripImages(card);
  }

  function buildPlate() {
    const plate = document.createElement('div');
    plate.className = PLATE_CLASS;
    plate.dataset.asPlate = '';

    const caption = document.createElement('div');
    caption.className = 'as-plate__caption';
    plate.appendChild(caption);

    // The second line names what actually fired — the team, or the tags and words
    // the title tripped over. A plate that only says "blocked" leaves the viewer
    // guessing which of their own rules to loosen.
    const detail = document.createElement('div');
    detail.className = 'as-plate__detail';
    plate.appendChild(detail);

    // A covered card keeps its place in the grid so the layout does not jump, but
    // opening it would defeat the block — and on the sidebar the plate sits inside
    // the card's own <a>, where a click would otherwise navigate.
    plate.addEventListener('click', swallow, true);
    plate.addEventListener('auxclick', swallow, true);
    return plate;
  }

  function swallow(event) {
    event.preventDefault();
    event.stopPropagation();
  }

  /**
   * Drops the thumbnails behind the plate.
   *
   * The request may already be in flight — unlike the Android client, an extension
   * only ever sees the page after Twitch has drawn it — but a dropped `src` still
   * saves the decode and the memory, and stops the picture reappearing if the plate
   * is ever late.
   */
  function stripImages(card) {
    card.querySelectorAll('img[src], img[srcset]').forEach(function (img) {
      const src = img.getAttribute('src');
      const srcset = img.getAttribute('srcset');
      if (src && !img.dataset.asSrc) img.dataset.asSrc = src;
      if (srcset && !img.dataset.asSrcset) img.dataset.asSrcset = srcset;
      img.removeAttribute('srcset');
      img.removeAttribute('src');
    });
  }

  function restoreImages(card) {
    card.querySelectorAll('img[data-as-src], img[data-as-srcset]').forEach(function (img) {
      if (img.dataset.asSrc) img.setAttribute('src', img.dataset.asSrc);
      if (img.dataset.asSrcset) img.setAttribute('srcset', img.dataset.asSrcset);
      delete img.dataset.asSrc;
      delete img.dataset.asSrcset;
    });
  }

  function removePlate(card) {
    const plate = card.querySelector(':scope > .' + PLATE_CLASS);
    if (plate) plate.remove();
  }

  function clear(card) {
    if (!card.dataset.asState) return;
    removePlate(card);
    restoreImages(card);
    dropFiller(card);
    delete card.dataset.asState;
    delete card.dataset.asPos;
  }

  function clearAll() {
    // The page still mutates while the extension is switched off, and every one of
    // those passes lands here; the flag keeps it from sweeping a clean document.
    if (stamped) {
      document.querySelectorAll('[data-as-token]').forEach(function (card) {
        clear(card);
        delete card.dataset.asToken;
      });
      document.querySelectorAll('[data-as-filler]').forEach(function (filler) {
        filler.remove();
      });
      stamped = false;
    }
    removePageBlock();
  }

  // ---------------------------------------------------------------- channel page

  let pageBlock = null;

  /**
   * A blocked channel opened by its address rather than by a card.
   *
   * Blocked in both modes: "hide" is about lists, and a viewer who lands on the
   * page anyway should not be shown the stream a rule of their own says to block.
   */
  function syncPageBlock() {
    const login = loginFromHref(location.pathname);
    if (!login) {
      removePageBlock();
      return;
    }
    const titleNode = document.querySelector('[data-a-target="stream-title"]');
    const tags = [];
    document
      .querySelectorAll('[data-a-target="stream-tag"], [data-a-target="channel-tags"] .tw-tag')
      .forEach(function (node) {
        const text = (node.textContent || '').trim();
        if (text) tags.push(text);
      });

    const verdict = rules.check(login, titleNode ? titleNode.textContent : '', tags);
    if (verdict) showPageBlock(login, verdict);
    else removePageBlock();
  }

  function showPageBlock(login, verdict) {
    if (!pageBlock) {
      pageBlock = document.createElement('div');
      pageBlock.className = 'as-page';
      pageBlock.innerHTML =
        '<div class="as-page__panel">' +
        '<div class="as-page__caption"></div>' +
        '<div class="as-page__detail"></div>' +
        '<div class="as-page__channel"></div>' +
        '<button type="button" class="as-page__back">Вернуться назад</button>' +
        '</div>';
      pageBlock.querySelector('.as-page__back').addEventListener('click', function () {
        if (history.length > 1) history.back();
        else location.assign('https://www.twitch.tv/directory/following');
      });
      (document.body || document.documentElement).appendChild(pageBlock);
      // Twitch starts the player as soon as it can, and will start it again after a
      // resolution change or an ad break.
      document.addEventListener('play', pauseEverything, true);
    }
    pageBlock.querySelector('.as-page__caption').textContent = verdict.caption;
    pageBlock.querySelector('.as-page__detail').textContent = verdict.detail;
    pageBlock.querySelector('.as-page__channel').textContent = 'twitch.tv/' + login;
    pauseEverything();
  }

  function removePageBlock() {
    if (!pageBlock) return;
    document.removeEventListener('play', pauseEverything, true);
    pageBlock.remove();
    pageBlock = null;
  }

  function pauseEverything() {
    // Paused, never muted: Twitch remembers a mute the viewer did not ask for.
    document.querySelectorAll('video, audio').forEach(function (media) {
      try {
        media.pause();
      } catch (err) {
        /* a media element that is mid-teardown; the next pass gets it */
      }
    });
  }

  // ---------------------------------------------------------------- driving

  function schedule() {
    if (scanQueued) return;
    scanQueued = true;
    setTimeout(function () {
      scanQueued = false;
      scan();
    }, 120);
  }

  // Attributes are left out on purpose: stamping a card is an attribute write, and
  // watching those would make every pass schedule the next one.
  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  // Navigation inside the app leaves no trace the isolated world can see — its copy
  // of `history` is not the one the page calls — so the address is compared instead.
  setInterval(function () {
    if (location.href !== lastUrl) schedule();
  }, 1000);

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) schedule();
  });

  AS.watch(function (changes) {
    loadRules();
    // A team added on another machine arrives through sync with no roster behind
    // it; without this it would only start blocking on the next page load.
    if (AS.KEYS.settings in changes) refreshTeams();
  });

  function refreshTeams() {
    // Stale rosters are re-read once a day; nothing else ever asks.
    AS.ensureTeams().catch(function (err) {
      console.warn('[AntiSquad] составы команд не обновились', err);
    });
  }

  loadRules();
  refreshTeams();
})();
