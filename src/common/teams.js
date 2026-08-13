/**
 * Resolves blocked team names into the channel logins that actually appear on
 * cards.
 *
 * Rosters are cached in `storage.local` and read back before anything is fetched.
 * That order matters: a block that only takes effect once a network round-trip
 * lands would show the blocked channels for the first second of every page load,
 * which is exactly the second the viewer is looking at the screen.
 *
 * The lookup goes to the web player's own GraphQL endpoint with its public client
 * id — the same anonymous request the Twitch site makes for its team pages. Helix
 * (`/helix/teams`, what the Android client uses) would need an OAuth token and an
 * app of your own; nothing here does. The endpoint answers with
 * `Access-Control-Allow-Origin: *`, so no host permission is needed either.
 */
(function () {
  'use strict';

  const GQL_URL = 'https://gql.twitch.tv/gql';
  const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
  const PAGE_SIZE = 100;
  /** 20 pages of 100 is more members than any real team has. */
  const MAX_PAGES = 20;

  const QUERY = [
    'query TeamRoster($name: String!, $first: Int!, $after: Cursor) {',
    '  team(name: $name) {',
    '    name',
    '    displayName',
    '    members(first: $first, after: $after) {',
    '      edges { cursor node { login } }',
    '      pageInfo { hasNextPage }',
    '    }',
    '  }',
    '}',
  ].join('\n');

  async function page(name, after) {
    const response = await fetch(GQL_URL, {
      method: 'POST',
      headers: { 'Client-Id': CLIENT_ID, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: QUERY,
        variables: { name: name, first: PAGE_SIZE, after: after || null },
      }),
    });
    if (!response.ok) throw new Error('gql ' + response.status);
    const json = await response.json();
    if (json.errors && json.errors.length) throw new Error(json.errors[0].message || 'gql error');
    return json.data ? json.data.team : null;
  }

  /** The team's logins, or null when Twitch has no team by that name. */
  async function fetchRoster(name) {
    const logins = [];
    let displayName = name;
    let after = null;

    for (let i = 0; i < MAX_PAGES; i++) {
      const team = await page(name, after);
      if (!team) return null;
      displayName = team.displayName || team.name || name;

      const members = team.members || {};
      const edges = members.edges || [];
      for (const edge of edges) {
        const login = edge && edge.node && edge.node.login;
        if (login) logins.push(String(login).toLowerCase());
      }

      // Only the last edge of a page carries a usable cursor. Without one there is
      // no way to ask for the next page, so stop rather than re-read this one.
      const cursor = edges.length ? edges[edges.length - 1].cursor : null;
      if (!members.pageInfo || !members.pageInfo.hasNextPage || !cursor) break;
      after = cursor;
    }

    return { displayName: displayName, logins: Array.from(new Set(logins)) };
  }

  let inFlight = null;

  /**
   * Brings the roster cache in line with the blocked-team list and returns it.
   *
   * Cheap to call: a team read less than [AS.TEAM_TTL_MS] ago is left alone, so the
   * common case does no network at all. Pass true to re-read everything.
   */
  AS.ensureTeams = function (force) {
    if (!inFlight) {
      inFlight = run(force === true).finally(function () {
        inFlight = null;
      });
    }
    return inFlight;
  };

  async function run(force) {
    const settings = await AS.loadSettings();
    const stored = await AS.loadTeamCache();
    const wanted = settings.teams;

    // Rosters of teams that are no longer blocked have no reason to sit on disk;
    // re-adding a team simply reads it again.
    const cache = {};
    for (const name of wanted) if (stored[name]) cache[name] = stored[name];
    let changed = Object.keys(cache).length !== Object.keys(stored).length;

    for (const name of wanted) {
      const known = cache[name];
      if (!force && known && Date.now() - known.fetchedAt < AS.TEAM_TTL_MS) continue;

      let roster;
      try {
        roster = await fetchRoster(name);
      } catch (err) {
        // Leave the previous roster in place: a stale block list is far better
        // than none, and the next page load will try again.
        console.warn('[AntiSquad] не удалось прочитать команду «' + name + '»', err);
        continue;
      }

      cache[name] = {
        name: name,
        displayName: (roster && roster.displayName) || name,
        logins: roster ? roster.logins : [],
        // An unknown team is cached as an empty roster so the settings page can say
        // so instead of spinning, and so a typo does not cost a request every time.
        missing: roster === null,
        fetchedAt: Date.now(),
      };
      changed = true;
      // Written per team, so the first roster starts blocking without waiting for
      // the rest of the list.
      await AS.saveTeamCache(cache);
    }

    if (changed) await AS.saveTeamCache(cache);
    return cache;
  }
})();
