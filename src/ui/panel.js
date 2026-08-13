/**
 * The block list editor — the same page serves as the toolbar popup and as the
 * options page.
 *
 * Words and teams are separate lists because they answer different questions. A
 * word blocks *a broadcast* — the same channel is fine tomorrow with another title.
 * A team blocks *people*, and keeps them blocked whatever they are streaming.
 */
(function () {
  'use strict';

  const el = function (id) {
    return document.getElementById(id);
  };

  let settings = null;
  let cache = {};
  /** What the confirmation dialog is currently asking to remove. */
  let pending = null;

  // ---------------------------------------------------------------- rendering

  function render() {
    el('enabled').checked = settings.enabled;
    renderSummary();
    renderModes();
    renderList('words', settings.words, wordRow);
    renderList('teams', settings.teams, teamRow);
    renderTeamStatus();
  }

  function renderSummary() {
    if (!settings.enabled) {
      el('summary').textContent = 'Выключена — списки сохранены';
      return;
    }
    const logins = new Set();
    for (const name of settings.teams) {
      for (const login of (cache[name] || {}).logins || []) logins.add(login);
    }
    const parts = [];
    parts.push(settings.words.length ? 'слов: ' + settings.words.length : 'слов нет');
    parts.push(logins.size ? 'каналов по командам: ' + logins.size : 'команд нет');
    el('summary').textContent = parts.join(' · ');
  }

  function renderModes() {
    const box = el('modes');
    box.textContent = '';
    for (const mode of AS.MODES) {
      const row = buildRow(mode.label, mode.blurb, settings.mode === mode.id ? '✓' : '');
      row.classList.toggle('row--selected', settings.mode === mode.id);
      row.addEventListener('click', function () {
        save({ mode: mode.id });
      });
      box.appendChild(row);
    }
  }

  function renderList(id, values, rowFor) {
    const box = el(id);
    box.textContent = '';
    if (values.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent =
        id === 'words'
          ? 'Список пуст — по словам ничего не блокируется.'
          : 'Ни одной команды не заблокировано.';
      box.appendChild(empty);
      return;
    }
    for (const value of values) box.appendChild(rowFor(value));
  }

  function wordRow(word) {
    const row = buildRow(word, 'Нажмите, чтобы убрать из списка', '×');
    row.classList.add('row--removable');
    row.addEventListener('click', function () {
      ask(word, false);
    });
    return row;
  }

  function teamRow(team) {
    const known = cache[team];
    const size = known ? (known.logins || []).length : null;
    const subtitle =
      size === null
        ? 'Состав ещё не загружен'
        : size === 0
          ? 'Twitch не знает такой команды — проверьте имя'
          : 'Участников: ' + size + ' · нажмите, чтобы убрать';

    const row = buildRow(known && known.displayName ? known.displayName : team, subtitle, '×');
    row.classList.add('row--removable');
    row.addEventListener('click', function () {
      ask(team, true);
    });
    return row;
  }

  function buildRow(title, subtitle, mark) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'row';

    const body = document.createElement('div');
    body.className = 'row__body';

    const titleNode = document.createElement('div');
    titleNode.className = 'row__title';
    titleNode.textContent = title;
    body.appendChild(titleNode);

    if (subtitle) {
      const subtitleNode = document.createElement('div');
      subtitleNode.className = 'row__subtitle';
      subtitleNode.textContent = subtitle;
      body.appendChild(subtitleNode);
    }
    row.appendChild(body);

    const markNode = document.createElement('div');
    markNode.className = 'row__mark';
    markNode.textContent = mark;
    row.appendChild(markNode);
    return row;
  }

  function renderTeamStatus() {
    const stale = settings.teams.filter(function (name) {
      return !cache[name];
    });
    el('teams-status').textContent = stale.length
      ? 'Читаю составы: ' + stale.join(', ')
      : 'Составы обновляются раз в сутки';
  }

  // ---------------------------------------------------------------- editing

  async function save(patch) {
    settings = await AS.saveSettings(patch);
    render();
    // A new team has no roster yet, and a removed one leaves a stale entry behind.
    AS.ensureTeams().then(reload, warn);
  }

  function ask(value, isTeam) {
    pending = { value: value, team: isTeam };
    el('confirm-title').textContent = isTeam
      ? 'Разблокировать команду «' + value + '»?'
      : 'Убрать слово «' + value + '»?';
    el('confirm-text').textContent = isTeam
      ? 'Её участники снова появятся в списках и в поиске.'
      : 'Трансляции с этим словом снова будут показываться.';
    el('confirm').hidden = false;
    el('confirm-ok').focus();
  }

  function closeConfirm() {
    pending = null;
    el('confirm').hidden = true;
  }

  function add(input, isTeam) {
    const raw = input.value.trim();
    if (!raw) return;
    const value = isTeam ? AS.teamName(raw) : raw.toLowerCase();
    input.value = '';
    if (!value) return;

    const key = isTeam ? 'teams' : 'words';
    if (settings[key].indexOf(value) !== -1) return;
    const patch = {};
    patch[key] = settings[key].concat([value]);
    save(patch);
  }

  // ---------------------------------------------------------------- wiring

  async function reload() {
    settings = await AS.loadSettings();
    cache = await AS.loadTeamCache();
    render();
  }

  function warn(err) {
    console.warn('[AntiSquad]', err);
    el('teams-status').textContent = 'Не удалось прочитать составы — проверьте сеть';
  }

  el('enabled').addEventListener('change', function (event) {
    save({ enabled: event.target.checked });
  });

  el('word-form').addEventListener('submit', function (event) {
    event.preventDefault();
    add(el('word-input'), false);
  });

  el('team-form').addEventListener('submit', function (event) {
    event.preventDefault();
    add(el('team-input'), true);
  });

  el('confirm-cancel').addEventListener('click', closeConfirm);

  el('confirm-ok').addEventListener('click', function () {
    if (!pending) return;
    const key = pending.team ? 'teams' : 'words';
    const value = pending.value;
    const patch = {};
    patch[key] = settings[key].filter(function (item) {
      return item !== value;
    });
    closeConfirm();
    save(patch);
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !el('confirm').hidden) closeConfirm();
  });

  el('refresh').addEventListener('click', function () {
    const button = el('refresh');
    button.disabled = true;
    el('teams-status').textContent = 'Обновляю составы…';
    AS.ensureTeams(true)
      .then(reload, warn)
      .finally(function () {
        button.disabled = false;
      });
  });

  // The content script writes the roster cache; the popup may be open at the time.
  AS.watch(reload);

  // In the popup the body is 400 px wide and so is the viewport; in a tab it is not.
  if (window.innerWidth > 480) document.body.classList.add('wide');

  reload().then(function () {
    return AS.ensureTeams();
  }).then(reload, warn);
})();
