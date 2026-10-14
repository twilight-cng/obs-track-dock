/* Shared by the dock page (classic script) and node:test (CommonJS). */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.TrackConfig = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const TRACK_COUNT = 6;

  const defaultConfig = () => ({
    host: "127.0.0.1",
    port: 4455,
    password: "",
    trackNames: ["配信", "録画", "トラック3", "トラック4", "トラック5", "トラック6"],
  });

  function trackNameAt(saved, index, fallback) {
    if (!Array.isArray(saved) || index >= saved.length) return fallback;
    const name = saved[index];
    if (typeof name !== "string") return fallback;
    const trimmed = name.trim();
    return trimmed ? trimmed : fallback;
  }

  /**
   * Keep connection fields and any track names the user already saved.
   * Older docks stored five names; the sixth is filled from the default
   * without shifting the existing ones. Blank entries stay on their index.
   */
  function migrateConfig(parsed) {
    const defaults = defaultConfig();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return defaults;
    }

    const merged = { ...defaults, ...parsed };
    merged.trackNames = defaults.trackNames.map((name, index) =>
      trackNameAt(parsed.trackNames, index, name),
    );
    return merged;
  }

  return { TRACK_COUNT, defaultConfig, migrateConfig };
});
