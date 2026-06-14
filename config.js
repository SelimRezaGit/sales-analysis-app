/* config.js
 * Default grouping configuration for the report.
 *
 * GROUPING LOGIC:
 *  - Each item's "base group" is derived from its brand name by taking the
 *    leading word(s) before the first number/size token (e.g.
 *    "BISOPRO 2.5 TABLET 50'S" -> base group "BISOPRO").
 *  - FORCE_SEPARATE: a list of "prefix strings". If an item's name starts
 *    with one of these (case-insensitive), it gets its OWN group named
 *    exactly as the prefix, regardless of its natural base group. Longer
 *    prefixes are matched first (most specific wins).
 *  - MERGE_RULES: maps a base-group name -> target group name. Used to
 *    combine multiple natural base-groups into one (e.g. LINATAB M -> LINATAB).
 *  - EXCLUDE_ZERO: if true, rows where tgtBox=soldBox=intBox=tgtVal=soldVal=intVal=0
 *    are dropped entirely. If false, they're shown greyed out.
 *
 * All of this is editable in the UI (Step 3) and persisted to localStorage
 * so the same rules apply next month automatically.
 */

const DEFAULT_CONFIG = {
  // Brands that must ALWAYS be their own separate group, even if another
  // brand name starts similarly (e.g. "GLYMIRA 500" vs "GLYSET").
  // Order matters: longer/more specific prefixes should come first.
  forceSeparate: [
    "GLYMIRA 500",
    "LINATAB E",
    "PEMAFATE",
    "REUCENT XR 15",
    "UROBEN XR",
    "CONVIPEN",
    "DUPALAKI",
    "EPLERON",
    "ELTROPAG",
    "EMBELIN",
    "INDAPRIL",
    "INOSPIRON",
    "LARCADIP",
    "NODIA",
    "NOFIATE",
    "ORSEMA",
    "PRESONIL",
    "STK",
    "TICAREL",
    "TROCER",
    "VERACAL",
    "WATARIS",
    "WINOLIP",
    "VALSARTIL",
    "PENFINE",
    "PIXOREL",
    "PIODAR",
    "ROCOVAS",
    "GLYSET"
  ],

  // Merge rules: base-group-name (as derived naturally, or after forceSeparate
  // matching) -> target group name (display rename / combine).
  // With first-word grouping, "LINATAB 5..." and "LINATAB M 2.5/500..." both
  // naturally derive to "LINATAB" already - we just rename the combined
  // group for clarity. "LINATAB E" is kept separate via forceSeparate above.
  mergeRules: {
    "LINATAB": "LINATAB + LINATAB M"
  },

  // Whether to exclude rows where everything is zero
  excludeZero: false
};

const ConfigStore = (function () {
  const STORAGE_KEY = 'ipl_sales_report_config_v1';

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
      const parsed = JSON.parse(raw);
      // shallow-merge with defaults to handle older saved configs missing keys
      return {
        forceSeparate: Array.isArray(parsed.forceSeparate) ? parsed.forceSeparate : DEFAULT_CONFIG.forceSeparate.slice(),
        mergeRules: parsed.mergeRules || JSON.parse(JSON.stringify(DEFAULT_CONFIG.mergeRules)),
        excludeZero: typeof parsed.excludeZero === 'boolean' ? parsed.excludeZero : DEFAULT_CONFIG.excludeZero
      };
    } catch (e) {
      console.warn('Config load failed, using defaults', e);
      return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    }
  }

  function save(config) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    } catch (e) {
      console.warn('Config save failed', e);
    }
  }

  function reset() {
    const fresh = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    save(fresh);
    return fresh;
  }

  return { load, save, reset, DEFAULT_CONFIG };
})();
