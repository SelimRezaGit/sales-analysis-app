/* parser.js
 * Parses raw text extracted from the "Territory Wise Sale (Qty & Value)" PDF
 * into structured records, grouped by Group + Terr Id.
 *
 * Each data row in the source looks like (whitespace-separated, columns may
 * be blank when value is 0):
 *
 *   CODE  Brand Name...--Size   TgtBox SoldBox IntBox  TgtVal SoldVal IntVal Total
 *
 * Example:
 *   AC2 ACUREN 25 TAB 100'S--100S    13   13    0    684.73   682          682
 *   CDD CONVIPEN INSULIN DELIVERY DEVICE--1'S  10  3  2  6394.5  1890  1260  3150
 *
 * We don't rely on the printed "Total" column - app.js recomputes
 * Total = SoldValue + IntValue.
 */

const SalesParser = (function () {

  // Regex for a data row. Captures:
  //  1: code (3 alnum/symbol chars, no spaces)
  //  2: brand name (greedy, ends right before the numeric block)
  //  3: rest of line (numeric columns, space separated, may have blanks)
  //
  // Numeric tail: 3 integer-ish columns (tgt box, sold box, int box) then
  // up to 4 numeric/decimal columns (tgt val, sold val, int val, total),
  // any of which may be missing (blank => 0).
  const ROW_RE = /^\s*(\S{2,5})\s+(.+?)\s{2,}(.*)$/;

  // A "number token" - integer or decimal with optional commas
  const NUM_RE = /^-?[\d,]+(\.\d+)?$/;

  function isNumberToken(tok) {
    return NUM_RE.test(tok);
  }

  function toNumber(tok) {
    if (tok === undefined || tok === null || tok === '') return 0;
    return parseFloat(tok.replace(/,/g, '')) || 0;
  }

  // Parse the numeric tail into up to 7 numbers, left-aligned:
  // [tgtBox, soldBox, intBox, tgtVal, soldVal, intVal, total]
  // The PDF text extraction collapses missing columns, so the number of
  // tokens varies. We use heuristics:
  //  - First 3 tokens that look like plain integers (no decimal) are
  //    tgtBox / soldBox / intBox candidates.
  //  - Remaining tokens are value columns (tgtVal/soldVal/intVal/total),
  //    which can have decimals.
  //
  // Strategy: split all tokens. The line always has between 4 and 7 number
  // tokens. We know:
  //   - tgtBox and soldBox are basically always present (even if 0... but 0
  //     might also be dropped/blank in pdftotext -layout? In our sample
  //     they ARE present as "0"). tgtVal is always present (even as 0).
  //   - soldVal, intBox, intVal, total may be absent when their value is 0
  //     AND they're trailing/blank in that row.
  //
  // Because -layout mode pads with spaces (not literal zeros) when a column
  // is visually empty, and our ROW_RE splits on runs of 2+ spaces only
  // for the brand-name / numeric-tail boundary (not within the tail), we
  // instead re-derive the tail by re-splitting the ORIGINAL row on single
  // spaces but being careful. Simplify: split tail on whitespace -> tokens.
  // Use known total column counts: a full row has up to 7 numeric tokens.
  // Missing trailing columns (often intBox, soldVal/intVal/total when 0)
  // collapse naturally because pdftotext drops the blank field text
  // entirely - giving fewer tokens.
  //
  // Empirically (from sample data) zero rows look like:
  //   "0   0           0           0                     0"
  //   -> tokens: [0,0,0,0,0]  (5 tokens: tgtBox,soldBox,intBox,tgtVal,total)
  //      soldVal & intVal both 0/blank -> dropped
  //
  // Rows with sales but no int:
  //   "13   13          0      684.73    682            682"
  //   -> tokens: [13,13,0,684.73,682,682] (6 tokens)
  //      intVal blank/0 -> dropped, total present
  //
  // Rows with everything:
  //   "10   3           2      6394.5  1890    1260     3150"
  //   -> tokens: [10,3,2,6394.5,1890,1260,3150] (7 tokens) full
  //
  // Rows where soldBox=0 and tgtVal has a value but sold/total = 0:
  //   "2   0           0     9565.22                     0"
  //   -> tokens: [2,0,0,9565.22,0] (5 tokens) - tgtBox,soldBox,intBox,tgtVal,total(=0)
  //
  // So the mapping by token count:
  //   7 tokens -> [tgtBox,soldBox,intBox,tgtVal,soldVal,intVal,total]
  //   6 tokens -> [tgtBox,soldBox,intBox,tgtVal,soldVal,total]            (intVal=0)
  //   5 tokens -> [tgtBox,soldBox,intBox,tgtVal,total]                     (soldVal=0,intVal=0)
  //   4 tokens -> [tgtBox,soldBox,intBox,tgtVal] with total=0              (rare, all sales 0)
  //
  // total is always derivable as soldVal+intVal anyway, so for our purposes
  // we mainly need tgtBox, soldBox, intBox, tgtVal, soldVal, intVal.
  function parseNumericTail(tail) {
    const tokens = tail.trim().split(/\s+/).filter(t => t.length > 0 && isNumberToken(t));
    const n = tokens.map(toNumber);

    let tgtBox = 0, soldBox = 0, intBox = 0, tgtVal = 0, soldVal = 0, intVal = 0, total = 0;

    if (n.length >= 7) {
      [tgtBox, soldBox, intBox, tgtVal, soldVal, intVal, total] = n.slice(0, 7);
    } else if (n.length === 6) {
      [tgtBox, soldBox, intBox, tgtVal, soldVal, total] = n;
      intVal = 0;
    } else if (n.length === 5) {
      [tgtBox, soldBox, intBox, tgtVal, total] = n;
      soldVal = 0; intVal = 0;
    } else if (n.length === 4) {
      [tgtBox, soldBox, intBox, tgtVal] = n;
      soldVal = 0; intVal = 0; total = 0;
    } else if (n.length === 3) {
      [tgtBox, soldBox, intBox] = n;
    } else if (n.length === 2) {
      [tgtBox, soldBox] = n;
    } else if (n.length === 1) {
      [tgtBox] = n;
    }

    return { tgtBox, soldBox, intBox, tgtVal, soldVal, intVal, total };
  }

  // Clean a brand name: collapse multiple spaces, trim
  function cleanBrandName(name) {
    return name.replace(/\s+/g, ' ').trim();
  }

  /**
   * Main entry point.
   * @param {string} rawText - full text extracted from the PDF (pdf.js, line-joined)
   * @returns {Object} sections keyed by "GROUP|||TERRID" -> { group, terrId, items: [...] }
   */
  function parse(rawText) {
    const lines = rawText.split('\n');
    const sections = {};
    let currentKey = null;
    let currentGroup = null;
    let currentTerr = null;
    let pendingTerr = null;

    for (let raw of lines) {
      const line = raw.replace(/\r/g, '');
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Format 1: "Group:    XXXX    Terr Id:    YYYY" (same line, old format)
      const gm = trimmed.match(/^Group:\s*(.+?)\s+Terr Id:\s*(\S+)/i);
      if (gm) {
        currentGroup = gm[1].trim();
        currentTerr = gm[2].trim();
        currentKey = currentGroup + '|||' + currentTerr;
        if (!sections[currentKey]) {
          sections[currentKey] = { group: currentGroup, terrId: currentTerr, items: [] };
        }
        continue;
      }

      // Format 2: "Terr Id : XXXX" on one line, "Group : YYYY" on next line (new format)
      const tm = trimmed.match(/^Terr Id\s*:\s*(\S+)/i);
      if (tm) { pendingTerr = tm[1].trim(); continue; }
      const gm2 = trimmed.match(/^Group\s*:\s*(.+)/i);
      if (gm2 && pendingTerr) {
        currentGroup = gm2[1].trim();
        currentTerr = pendingTerr;
        pendingTerr = null;
        currentKey = currentGroup + '|||' + currentTerr;
        if (!sections[currentKey]) {
          sections[currentKey] = { group: currentGroup, terrId: currentTerr, items: [] };
        }
        continue;
      }

      // Skip header / footer / noise lines
      if (/^Code\s+Brand Name/i.test(trimmed)) continue;
      if (/^P Code\s+Brand Name/i.test(trimmed)) continue;
      if (/^Territory Wise Sale/i.test(trimmed)) continue;
      if (/^Page\s+\d+/i.test(trimmed)) continue;
      if (/^Total\s*:/i.test(trimmed)) continue;
      if (/^v:\d/i.test(trimmed)) continue;
      if (!currentKey) continue;

      // Try to parse as a data row
      const m = line.match(ROW_RE);
      if (!m) continue;

      const code = m[1];
      let brandNameRaw = m[2];
      const tail = m[3];

      // Guard: code shouldn't itself be purely numeric (that'd indicate
      // we matched a continuation/garbage line)
      if (/^[\d.,]+$/.test(code)) continue;

      const nums = parseNumericTail(tail);

      // Guard: a real data row must have at least tgtBox/soldBox parsed
      // and brand name non-empty
      const brandName = cleanBrandName(brandNameRaw);
      if (!brandName) continue;

      sections[currentKey].items.push({
        code: code,
        name: brandName,
        tgtBox: nums.tgtBox,
        soldBox: nums.soldBox,
        intBox: nums.intBox,
        tgtVal: nums.tgtVal,
        soldVal: nums.soldVal,
        intVal: nums.intVal
      });
    }

    return sections;
  }

  /**
   * Extract list of {group, terrId} combos available in parsed sections,
   * sorted for dropdowns.
   */
  function listGroupsAndTerritories(sections) {
    const groups = new Set();
    const byGroup = {}; // group -> Set of terrIds

    Object.values(sections).forEach(sec => {
      groups.add(sec.group);
      if (!byGroup[sec.group]) byGroup[sec.group] = new Set();
      byGroup[sec.group].add(sec.terrId);
    });

    const result = {};
    Object.keys(byGroup).forEach(g => {
      result[g] = Array.from(byGroup[g]).sort();
    });

    return { groups: Array.from(groups).sort(), byGroup: result };
  }

  return { parse, listGroupsAndTerritories, parseNumericTail, cleanBrandName };
})();
