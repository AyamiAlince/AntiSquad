/**
 * The whole compatibility layer, in two lines.
 *
 * Chrome exposes only `chrome`, Firefox exposes both `browser` and `chrome`. The
 * handful of APIs used here — `storage` and `runtime.getURL` — have the same
 * promise-returning shape in either, so one alias is enough and no polyfill is
 * pulled in.
 *
 * Everything shared lives on one global rather than in ES modules: the same files
 * are loaded as content scripts (isolated world, classic scripts) and as plain
 * `<script>` tags on the settings page, and a namespace is the only shape both
 * accept unchanged.
 */
var AS = globalThis.AS || (globalThis.AS = {});

AS.api = globalThis.browser || globalThis.chrome;
