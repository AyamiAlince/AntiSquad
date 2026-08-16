/**
 * The block list, resolved: user-entered words plus the roster of every blocked
 * team, ready to be checked against a card without further lookups.
 *
 * A direct port of `BlockRules.kt`, with one difference forced by the medium: the
 * web only ever shows channel logins (`twitch.tv/<login>`), never the numeric user
 * ids the Android client matches on, so rosters are kept as logins.
 */
(function () {
  'use strict';

  /**
   * @param {{mode: string, words: string[], rosters: Object<string, string[]>}} input
   */
  AS.makeRules = function (input) {
    const mode = input.mode || 'hide';
    const lang = input.lang || 'en';
    const words = AS.cleanList(input.words);

    /**
     * Login to the blocked teams it belongs to. Inverted once here rather than
     * searched per card: a card is drawn far more often than the rules change, and
     * a streamer can be in more than one blocked team.
     */
    const teamsByLogin = new Map();
    const rosters = input.rosters || {};
    for (const team of Object.keys(rosters)) {
      for (const login of rosters[team] || []) {
        const key = String(login).toLowerCase();
        if (!key) continue;
        const known = teamsByLogin.get(key);
        if (known) {
          if (known.indexOf(team) === -1) known.push(team);
        } else {
          teamsByLogin.set(key, [team]);
        }
      }
    }

    return {
      mode: mode,
      isEmpty: words.length === 0 && teamsByLogin.size === 0,

      /**
       * Why this channel or broadcast is blocked, or null if it is not.
       *
       * Team membership is checked first: it blocks the person rather than the
       * broadcast, so it stays true even when the title says nothing.
       *
       * @returns {{reason: string, caption: string, matched: string[], detail: string}|null}
       */
      check: function (login, title, tags) {
        const key = String(login || '').toLowerCase();
        if (key) {
          const teams = teamsByLogin.get(key);
          if (teams) return verdict('team', teams, lang);
        }
        if (words.length === 0) return null;

        // Titles change every stream and tags are free text, so both are searched
        // for the same words — "89SQUAD" lives in either depending on the streamer.
        const loweredTitle = String(title || '').toLowerCase();
        const cleanTags = (tags || []).filter(Boolean);
        const loweredTags = cleanTags.map((tag) => String(tag).toLowerCase());

        const matched = [];
        for (const word of words) {
          // Report the tag itself when the hit came from one: that is the thing
          // the viewer sees on Twitch, and it may be longer than the rule.
          const tagIndex = loweredTags.findIndex((tag) => tag.indexOf(word) !== -1);
          const hit =
            tagIndex >= 0 ? cleanTags[tagIndex] : loweredTitle.indexOf(word) !== -1 ? word : null;
          if (hit && matched.indexOf(hit) === -1) matched.push(hit);
        }
        return matched.length === 0 ? null : verdict('word', matched, lang);
      },

      /**
       * Why this chat message is blocked, or null if it is not.
       *
       * Three ways in, in the order they answer "why is this line here at all".
       * The author is on a blocked roster; the message names one of them; or it
       * trips over a word.
       *
       * Mentions are checked against rosters only. Blocking a team blocks people,
       * and a chat that says `@lomaka` twice a minute puts back exactly what the
       * viewer asked to be rid of; the word list needs no such help, since it is
       * already matched against the whole line, the author's name included.
       *
       * @returns {{reason: string, caption: string, matched: string[], detail: string}|null}
       */
      checkMessage: function (author, text, mentions) {
        const key = String(author || '').toLowerCase();
        if (key) {
          const teams = teamsByLogin.get(key);
          if (teams) return verdict('chat_team', teams, lang);
        }

        // The team, not the login that was mentioned: the team is the rule the
        // viewer would have to loosen, and one message can name two of its members.
        const named = [];
        for (const raw of mentions || []) {
          const teams = teamsByLogin.get(String(raw).toLowerCase());
          if (!teams) continue;
          for (const team of teams) if (named.indexOf(team) === -1) named.push(team);
        }
        if (named.length !== 0) return verdict('chat_mention', named, lang);

        if (words.length === 0) return null;

        const lowered = String(text || '').toLowerCase();
        const matched = [];
        for (const word of words) {
          if (lowered.indexOf(word) !== -1 && matched.indexOf(word) === -1) matched.push(word);
        }
        return matched.length === 0 ? null : verdict('chat_word', matched, lang);
      },
    };
  };

  /**
   * A verdict, with the evidence.
   *
   * [matched] is what actually fired — the team names, or the tags and words the
   * title tripped over. Without it the plate can only say that *something* is
   * blocked, which is no help at all when a card disappears and the viewer wants to
   * know which of their own rules to loosen.
   */
  function verdict(reason, matched, lang) {
    return {
      reason: reason,
      caption: AS.translate('caption_' + reason, lang),
      matched: matched,
      detail: matched.join(', '),
      lang: lang
    };
  }
})();
