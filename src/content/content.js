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
   * Chat is judged as messages, not as cards, so the card walk stops at its door.
   *
   * A link to a channel inside a message is not a card — the walk up from it would
   * mark the line, or the block of lines around it, as though it were one. What
   * happens to that message is decided in the chat pass instead, which runs first
   * and leaves `data-as-chat` behind on every line it has looked at.
   */
  const CHAT =
    '[data-as-chat], [data-a-target="chat-scroller"],' +
    ' [data-test-selector="chat-scrollable-area__message-container"],' +
    ' .chat-scrollable-area__message-container, [data-a-target="chat-input"], .chat-line__message,' +
    ' [data-a-target="chat-line-message"], .video-chat__message-list-wrapper';

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
    rules = AS.makeRules({
      mode: settings.mode,
      words: settings.words,
      rosters: rosters,
      lang: settings.lang,
    });

    // Only a real change in the verdict a card would get is worth re-judging every
    // card on screen, so the stamp is a signature of the inputs, not a timestamp.
    // The language is one of those inputs — it is the text on the plate — so a
    // switch in the settings has to invalidate every stamp, or the plates already
    // on screen would keep the wording they were drawn with.
    const signature = JSON.stringify([
      enabled,
      settings.mode,
      settings.lang,
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
    push(ownText(card));

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

  /**
   * The text of [node] without the plate we may have put on it.
   *
   * A covered card is read again whenever the rules change, and the plate is a
   * child of it by then: left in, its own caption and the words it names would be
   * matched as though the card said them, and a card could go on being blocked by
   * the very plate that says it is blocked. The cap is what a chat message can be
   * at its longest, a little over Twitch's 500 characters.
   */
  function ownText(node) {
    const plate = node.querySelector(':scope > .' + PLATE_CLASS);
    if (!plate) return (node.textContent || '').slice(0, 600);

    let text = '';
    for (let part = node.firstChild; part && text.length < 600; part = part.nextSibling) {
      if (part !== plate) text += part.textContent || '';
    }
    return text.slice(0, 600);
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

    // Chat first: it marks the lines it has looked at, and the card walk is told to
    // stop at those. A message with a link to a channel in it would otherwise be
    // read as a card and taken away by the wrong rule.
    scanChat();

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
      });
    }

    for (const item of found) {
      // A root inside another root is a leftover from Twitch re-wrapping the card;
      // marking both would show one plate through the other. The outer one wins.
      if (found.some((other) => other !== item && other.card.contains(item.card))) continue;

      const info = readCard(item.card);
      apply(item.card, rules.check(item.login, info.title, info.tags), item.height);
      item.card.dataset.asToken = item.stamp;
      stamped = true;
    }

    syncFillers();
    syncPageBlock();
  }

  function needsRepair(card) {
    return card.dataset.asState === 'covered' && !card.querySelector(':scope > .' + PLATE_CLASS);
  }

  function apply(card, verdict, height) {
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
    }
  }

  // ---------------------------------------------------------------- chat

  /**
   * Chat lines, judged one by one.
   *
   * Nothing here can lean on an address the way the card pass does: a line names
   * its author in an attribute, not in a link, so Twitch's own analytics
   * attributes are the anchor — `data-a-user` on the line and on the name, and
   * the message containers as a second way in. Between the two a rename on either
   * side still leaves the other one finding the line.
   */
  const CHAT_NAMES =
    '[data-a-target="chat-message-username"], .chat-author__display-name,' +
    ' .video-chat__message-author, [data-test-selector="message-username"]';

  const CHAT_SEEDS = '[data-a-user], ' + CHAT_NAMES;

  /** Containers whose element children are one message each. */
  const CHAT_LISTS =
    '.chat-scrollable-area__message-container,' +
    ' [data-test-selector="chat-scrollable-area__message-container"],' +
    ' .video-chat__message-list-wrapper ul, [data-test-selector="video-chat"] ul';

  /** The walk from a name up to its line never crosses one of these. */
  const CHAT_STOPS =
    CHAT_LISTS +
    ', section, main, aside, ul, ol, [role="log"], [role="list"],' +
    ' [data-a-target="chat-scroller"], .chat-list--default, .chat-list--other';

  /**
   * Things that sit beside the message list and never inside a message. An
   * element with one of them in it is the chat room, not a line in it — which is
   * what stops the walk in a room that happens to hold a single message.
   */
  const CHAT_FURNITURE =
    '[data-a-target="chat-input"], .chat-input, [data-a-target="chat-scroller"],' +
    ' .chat-scrollable-area__message-container,' +
    ' [data-test-selector="chat-scrollable-area__message-container"]';

  /**
   * Chat, however Twitch spells it today.
   *
   * `data-a-user` is the anchor a line is found by, and it is not chat's alone —
   * a viewer card carries one too, and nothing says the next redesign will not put
   * one somewhere in the middle of a channel page. A name found outside chat would
   * send the walk up through a page that has no messages in it, so a line is only
   * looked for inside something that says it is chat. Twitch names its own
   * markup `chat-line__message`, `chat-room__content`, `video-chat__message-list`:
   * the word survives the renames, which is why it is matched and not a class.
   */
  const CHAT_REGION = '[class*="chat" i], [data-a-target*="chat" i], [data-test-selector*="chat" i]';

  /** A mention as chat writes it; logins are 3–25 characters of ASCII. */
  const MENTION = /@([a-z0-9][a-z0-9_]{2,24})/gi;

  function scanChat() {
    const found = [];
    const seen = new Set();

    for (const seed of chatSeeds()) {
      // A line is judged once and stamped, and in a busy chat almost every seed a
      // pass sees has been judged already. The stamp is looked for before anything
      // is measured or walked, since that is the whole of the work here.
      const known = seed.closest('[data-as-chat]');
      if (known && known.dataset.asChat === chatStamp(known) && !needsRepair(known)) continue;

      if (known) {
        // Judged under rules that have changed since — or it has changed shape,
        // which is the more interesting half. If a selector below goes stale, the
        // walk can settle on a message container that happened to hold a single
        // line, and every line that arrives afterwards would land inside something
        // already hidden. A container fills up and a message does not, so the
        // answer is taken again from the name up as soon as one does.
        clear(known);
        delete known.dataset.asChat;
      }

      if (!seed.closest(CHAT_REGION)) continue;

      const row = chatRow(seed);
      if (!row || seen.has(row)) continue;
      seen.add(row);
      found.push({ row: row, height: row.offsetHeight });
    }

    for (const item of found) {
      if (found.some((other) => other !== item && other.row.contains(item.row))) continue;

      const author = authorOf(item.row);
      const info = readCard(item.row);
      const verdict = rules.checkMessage(author, info.title, mentionsIn(item.row, info.title));
      apply(item.row, verdict, item.height);
      // Stamped after, not before: covering a line puts the plate inside it, and the
      // count has to be the one the next pass will see.
      item.row.dataset.asChat = chatStamp(item.row);
      stamped = true;
    }
  }

  /**
   * The rules a line was judged under, and the shape it had at the time. A message
   * is not a grid cell — Twitch appends a line and drops it later rather than
   * putting another message into the same one — so nothing else has to be in here.
   */
  function chatStamp(row) {
    return token + ':' + row.childElementCount;
  }

  function chatSeeds() {
    const seeds = [];
    document.querySelectorAll(CHAT_SEEDS).forEach(function (node) {
      seeds.push(node);
    });
    document.querySelectorAll(CHAT_LISTS).forEach(function (list) {
      for (let row = list.firstElementChild; row; row = row.nextElementSibling) seeds.push(row);
    });
    return seeds;
  }

  /**
   * The line a seed belongs to: the largest ancestor that is still one message.
   *
   * Every test is about the element being considered and never about where the
   * walk started, so the same line found through the name inside it and found as a
   * child of the message container stops in the same place — and is judged once
   * instead of twice, with one plate instead of two.
   */
  function chatRow(seed) {
    const author = authorOf(seed);
    let node = seed;

    for (let depth = 0; depth < 6; depth++) {
      const parent = node.parentElement;
      if (!parent || parent === document.body || parent === document.documentElement) break;
      if (parent.matches(CHAT_STOPS)) break;
      if (!isRow(parent, author)) break;
      node = parent;
    }
    // A container child that turns out to be the list itself — a selector below has
    // gone stale — is better left alone than covered whole.
    return isRow(node, author) ? node : null;
  }

  function isRow(node, author) {
    if (hasOtherAuthor(node, author)) return false;
    if (node.querySelector(CHAT_FURNITURE)) return false;
    // A line is a line even in a popout window three of them tall, so the ceiling
    // is the taller of a screenful's worth and what a long message can reach.
    return node.offsetHeight <= Math.max(400, window.innerHeight * 0.6);
  }

  /**
   * True if [node] holds a name other than [author] — that is, more than the one
   * message. With no author to compare against, two different names inside are the
   * same answer.
   */
  function hasOtherAuthor(node, author) {
    let only = '';
    for (const name of node.querySelectorAll(CHAT_SEEDS)) {
      const other = authorOf(name);
      if (!other) continue;
      if (author) {
        if (other !== author) return true;
      } else if (!only) {
        only = other;
      } else if (only !== other) {
        return true;
      }
    }
    return false;
  }

  /** The login behind a chat name, or '' when the markup does not say. */
  function authorOf(node) {
    const owner = node.closest('[data-a-user]') || node.querySelector('[data-a-user]');
    if (owner) {
      const login = (owner.getAttribute('data-a-user') || '').trim().toLowerCase();
      if (login) return login;
    }

    // Nothing to read the login off, so the name it is. A localized display name
    // carries the login after it in brackets, which is the one to take: it is what
    // a roster is keyed by.
    const intl = node.querySelector('.chat-author__intl-login');
    const label = intl || (node.matches(CHAT_NAMES) ? node : node.querySelector(CHAT_NAMES));
    if (!label) return '';

    const text = (label.textContent || '').replace(/[()\s]/g, '').toLowerCase();
    return /^[a-z0-9][a-z0-9_]{2,24}$/.test(text) ? text : '';
  }

  /** The channels a message names — by `@login`, or by a link to one. */
  function mentionsIn(row, text) {
    const logins = [];
    MENTION.lastIndex = 0;
    let hit;
    while ((hit = MENTION.exec(text)) !== null) {
      const login = hit[1].toLowerCase();
      if (logins.indexOf(login) === -1) logins.push(login);
    }
    row.querySelectorAll(SEEDS).forEach(function (link) {
      const login = loginFromHref(link.getAttribute('href'));
      if (login && logins.indexOf(login) === -1) logins.push(login);
    });
    return logins;
  }

  // ---------------------------------------------------------------- empty slots

  /**
   * How much wider the cards that stay may become before anything stands in for
   * the one that went: a quarter each.
   *
   * The two obvious answers are both wrong on their own. Letting the row close up
   * hands the freed width to whatever is left, and a shelf with all but one card
   * blocked ends up as a single preview across the page; holding the whole slot
   * back keeps every card its own size but leaves an empty gap where the card was.
   * So the cards that stay take a quarter more width each, and only what is over
   * that goes to a stand-in: one card blocked out of a shelf closes up with no gap
   * at all, and four out of five still leave the fifth one card-sized.
   */
  const GIVE = 0.25;

  /** Containers already asked whether they hand a hidden card's width out. */
  let spread = new WeakMap();

  // Which they do depends on how wide the window is — Twitch lays a shelf out
  // differently at every breakpoint — so the answers do not outlive a resize.
  window.addEventListener('resize', function () {
    spread = new WeakMap();
  });

  /**
   * The stand-ins holding open what the hidden cards gave up.
   *
   * Worked out per container rather than per card: how much of the freed width has
   * to be held back depends on how many cards went and how many are left, and both
   * change with every pass.
   */
  function syncFillers() {
    const groups = new Map();
    // Chat is a column: a hidden line closes up behind itself and there is no width
    // for anyone to hand out, so the stand-ins have no business there.
    document.querySelectorAll('[data-as-state="hidden"]:not([data-as-chat])').forEach(function (card) {
      const parent = card.parentElement;
      if (!parent) return;
      const group = groups.get(parent);
      if (group) group.push(card);
      else groups.set(parent, [card]);
    });

    // Nothing hidden in there any more: Twitch redrew the shelf, or the rules
    // changed under it.
    document.querySelectorAll('[data-as-filler]').forEach(function (filler) {
      if (!groups.has(filler.parentElement)) filler.remove();
    });

    groups.forEach(holdSlots);
  }

  function holdSlots(hidden, parent) {
    const style = window.getComputedStyle(parent);
    const grid = style.display.indexOf('grid') !== -1;
    const row = style.display.indexOf('flex') !== -1 && style.flexDirection.indexOf('row') === 0;

    // Everything else — a column, a plain block, a list — simply closes up, and a
    // stand-in in it would be a hole and nothing else.
    if ((!grid && !row) || !spreadsWidth(parent, hidden[0])) {
      keepFillers(parent, 0);
      return;
    }

    if (grid) {
      // A column is dropped when nothing is left in it, so every hidden card needs
      // something of its own standing in the cell. Size does not come into it:
      // an empty box holds the track as well as a card does.
      keepFillers(parent, hidden.length).forEach(function (filler) {
        filler.style.flex = '';
      });
      return;
    }

    // A flex row divides the freed width in proportion to what its items ask for,
    // so one stand-in asking for enough of it is all a row ever needs. It asks for
    // nothing of its own (`flex-basis: 0`): with no width to give away it takes up
    // no room, and the row looks exactly as if nothing had been blocked.
    // Read off a card that is still there: it is their growth that is being
    // capped, and with none left there is nothing to hold the row open for.
    const live = liveChildren(parent);
    const grow = live.length ? parseFloat(window.getComputedStyle(live[0]).flexGrow) || 0 : 0;
    const share = grow * (hidden.length / GIVE - live.length);
    keepFillers(parent, share > 0 ? 1 : 0).forEach(function (filler) {
      filler.style.flex = share + ' 0 0px';
    });
  }

  /**
   * Whether [parent] hands the width of a hidden card to the ones that stay.
   *
   * A grid with a fixed number of columns does not — the cards after the gap move
   * up and each keeps its width — while `auto-fit` drops the column left empty and
   * shares it out. Nothing in the markup tells those two apart, so the page is
   * asked instead: the card goes back for the length of one measurement, with
   * nothing painted in between. Asked once per container, since the answer is a
   * property of how the container is laid out rather than of the card.
   */
  function spreadsWidth(parent, card) {
    const known = spread.get(parent);
    if (known !== undefined) return known;

    const neighbour = liveChildren(parent)[0];
    // Everything in there is blocked, so there is nothing to measure against and
    // nothing to protect either; ask again when a card comes back.
    if (!neighbour) return false;

    const shared = neighbour.offsetWidth;
    delete card.dataset.asState;
    const natural = neighbour.offsetWidth;
    card.dataset.asState = 'hidden';

    const answer = shared > natural + 1;
    spread.set(parent, answer);
    return answer;
  }

  /** The children of [parent] that still take up a slot in it. */
  function liveChildren(parent) {
    const live = [];
    for (let node = parent.firstElementChild; node; node = node.nextElementSibling) {
      if (node.dataset.asState === 'hidden' || 'asFiller' in node.dataset) continue;
      if (node.offsetWidth > 0) live.push(node);
    }
    return live;
  }

  /** Leaves exactly [count] stand-ins in [parent], all of them last, and returns them. */
  function keepFillers(parent, count) {
    const kept = [];
    parent.querySelectorAll(':scope > [data-as-filler]').forEach(function (filler) {
      if (kept.length < count) kept.push(filler);
      else filler.remove();
    });
    while (kept.length < count) {
      const filler = document.createElement('div');
      filler.dataset.asFiller = '';
      kept.push(filler);
    }

    // Last, and kept there. Twitch appends the next page of cards to the same
    // container, and a stand-in that was at the end when it was made ends up
    // between two cards a scroll later — which is a hole in the middle of the
    // grid, exactly what it was there to prevent.
    let tail = parent.lastElementChild;
    let trailing = true;
    for (let i = kept.length - 1; i >= 0; i--) {
      if (kept[i] !== tail) {
        trailing = false;
        break;
      }
      tail = tail.previousElementSibling;
    }
    if (!trailing) {
      kept.forEach(function (filler) {
        parent.appendChild(filler);
      });
    }
    return kept;
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
    plate.querySelector('.as-plate__caption').textContent = verdict.caption;
    plate.querySelector('.as-plate__detail').textContent = verdict.detail;
    plate.querySelector('.as-plate__detail').hidden = !verdict.detail;

    stripImages(card);
  }

  function buildPlate() {
    const plate = document.createElement('div');
    plate.className = PLATE_CLASS;
    plate.dataset.asPlate = '';

    const icon = document.createElement('div');
    icon.className = 'icon-cover as-plate__icon';
    plate.appendChild(icon);

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
      document.querySelectorAll('[data-as-chat]').forEach(function (row) {
        clear(row);
        delete row.dataset.asChat;
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
        '<div class="icon-cover as-page__icon"></div>' +
        '<div class="as-page__caption"></div>' +
        '<div class="as-page__detail"></div>' +
        '<div class="as-page__channel"></div>' +
        '<button type="button" class="as-page__back"></button>' +
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
    // The panel outlives a change in the settings — it is only torn down when the
    // address changes — so its own label is re-read on every pass, not just once.
    pageBlock.querySelector('.as-page__back').textContent = AS.translate('btn_go_back', verdict.lang);
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
