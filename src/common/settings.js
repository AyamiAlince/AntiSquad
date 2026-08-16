/**
 * Stored state: the two block lists and the mode, plus the cached team rosters.
 *
 * Ported from the Android client's `SettingsStore` / `TeamDirectory`, so the same
 * words and the same team names behave the same way in the browser.
 */
(function () {
  'use strict';

  const SETTINGS_KEY = 'settings';
  const TEAMS_KEY = 'teams';

  AS.KEYS = { settings: SETTINGS_KEY, teams: TEAMS_KEY };

  AS.DEFAULTS = {
    /** The master switch. Nothing else is consulted while this is off. */
    enabled: true,
    mode: 'hide',
    /** Lowercased; matched as substrings of a stream's title and tags. */
    words: ['89squad', 'pitomnik'],
    /** Team names as in `twitch.tv/team/<name>`; every member is blocked. */
    teams: ['89squad', 'pitomnik'],
    /** Default language for the plugin; English by default. */
    lang: 'en'
  };

  /** What happens to a stream that matches a block rule. */
  AS.MODES = [
    {
      id: 'hide',
      label: 'Скрывать',
      blurb: 'Заблокированное не появляется ни в списках, ни в чате',
    },
    {
      id: 'cover',
      label: 'Закрывать заглушкой',
      blurb: 'Карточка и сообщение остаются на месте под красной плашкой и не открываются',
    },
  ];

  /** Rosters are re-read once a day; team membership does not move faster. */
  AS.TEAM_TTL_MS = 24 * 60 * 60 * 1000;

  AS.cleanList = function (list) {
    const out = [];
    for (const raw of list || []) {
      const value = String(raw).trim().toLowerCase();
      if (value && out.indexOf(value) === -1) out.push(value);
    }
    return out;
  };

  /**
   * Team names are stored the way `twitch.tv/team/<name>` spells them. A pasted
   * link is reduced to that name: it is the obvious thing to paste, and the API
   * only accepts the bare name.
   */
  AS.teamName = function (input) {
    return String(input)
      .trim()
      .split(/[?#]/)[0]
      .replace(/\/+$/, '')
      .split('/')
      .pop()
      .toLowerCase();
  };

  /**
   * Settings go to `storage.sync` so a second machine picks up the same lists.
   * The roster cache stays in `storage.local`: it is derived data and would eat
   * the sync quota (8 KB per item) for nothing.
   */
  function syncArea() {
    return (AS.api.storage && AS.api.storage.sync) || AS.api.storage.local;
  }

  async function read(area, key) {
    const bag = await area.get(key);
    return bag ? bag[key] : undefined;
  }

  function normalize(raw) {
    const stored = Object.assign({}, AS.DEFAULTS, raw || {});
    
    // Scan for available languages
    const availableLangs = AS.LOCALES ? Object.keys(AS.LOCALES) : ['en'];
    const sysLang = navigator.language.slice(0, 2);
    const fallbackLang = availableLangs.indexOf(sysLang) !== -1 ? sysLang : 'en';

    const mode = AS.MODES.some((m) => m.id === stored.mode) ? stored.mode : AS.DEFAULTS.mode;
    return {
      enabled: stored.enabled !== false,
      mode: mode,
      lang: stored.lang || fallbackLang,
      words: AS.cleanList(Array.isArray(stored.words) ? stored.words : AS.DEFAULTS.words),
      teams: AS.cleanList(
        (Array.isArray(stored.teams) ? stored.teams : AS.DEFAULTS.teams).map(AS.teamName),
      ),
    };
  }

  AS.normalizeSettings = normalize;

  AS.loadSettings = async function () {
    let stored;
    try {
      stored = await read(syncArea(), SETTINGS_KEY);
    } catch (err) {
      // Firefox rejects storage.sync when the add-on has no id; fall back rather
      // than leaving the viewer with default rules they did not ask for.
      stored = await read(AS.api.storage.local, SETTINGS_KEY);
    }
    return normalize(stored);
  };

  /** Merges [patch] into the stored settings and returns the result. */
  AS.saveSettings = async function (patch) {
    const next = normalize(Object.assign({}, await AS.loadSettings(), patch));
    const bag = {};
    bag[SETTINGS_KEY] = next;
    try {
      await syncArea().set(bag);
    } catch (err) {
      await AS.api.storage.local.set(bag);
    }
    return next;
  };

  /** Team name to `{ name, displayName, logins, missing, fetchedAt }`. */
  AS.loadTeamCache = async function () {
    return (await read(AS.api.storage.local, TEAMS_KEY)) || {};
  };

  AS.saveTeamCache = function (cache) {
    const bag = {};
    bag[TEAMS_KEY] = cache;
    return AS.api.storage.local.set(bag);
  };

  /**
   * Blocked team name to its member logins, ready for the rules.
   *
   * Keyed by the name Twitch itself spells (`89SQUAD`, not `89squad`) because a
   * blocked card has to be able to say *which* team it belongs to. A team missing
   * from the map has not been read yet; an empty list means Twitch has no such team.
   */
  AS.rostersFrom = function (teams, cache) {
    const out = {};
    for (const name of teams || []) {
      const entry = (cache || {})[name];
      if (entry) out[entry.displayName || name] = entry.logins || [];
    }
    return out;
  };

  /** Calls [callback] whenever the settings or the roster cache change anywhere. */
  AS.watch = function (callback) {
    AS.api.storage.onChanged.addListener(function (changes) {
      if (SETTINGS_KEY in changes || TEAMS_KEY in changes) callback(changes);
    });
  };
})();
