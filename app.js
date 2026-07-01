/* app.js
 * Wires up the UI: PDF parsing, group/territory selection, config editing,
 * report generation, search/filter, and HTML download.
 */

// Color palette cycled across product groups
const GROUP_COLORS = [
  { bg: '#dbeeff', sub: '#b3d4f5', text: '#042C53' },
  { bg: '#fff3d6', sub: '#fad98a', text: '#412402' },
  { bg: '#eaf6dc', sub: '#bedd97', text: '#173404' },
  { bg: '#e0f7ee', sub: '#9fe1cb', text: '#04342C' },
  { bg: '#eeeeff', sub: '#c8c5f5', text: '#26215C' },
  { bg: '#fde8e8', sub: '#f5b8b8', text: '#501313' },
  { bg: '#fce8f2', sub: '#f0bad3', text: '#4B1528' },
  { bg: '#c8e6ff', sub: '#80bfff', text: '#003366' },
  { bg: '#ffd6e0', sub: '#ff8fab', text: '#5c001a' },
  { bg: '#d6f5d6', sub: '#6dbf6d', text: '#1a4d1a' },
  { bg: '#e8d5f5', sub: '#b36bd4', text: '#3d0066' },
  { bg: '#d5f0ff', sub: '#66c2ff', text: '#003d5c' },
  { bg: '#ffe6cc', sub: '#ff9933', text: '#5c2e00' },
  { bg: '#e6ffe6', sub: '#66ff66', text: '#006600' },
  { bg: '#ffd9d9', sub: '#ff6666', text: '#660000' },
  { bg: '#e0e0ff', sub: '#8080ff', text: '#000066' },
  { bg: '#d9f2e6', sub: '#4dbb8a', text: '#003322' },
  { bg: '#fff5e6', sub: '#ffb347', text: '#5c3300' },
  { bg: '#f0e6ff', sub: '#9966ff', text: '#2d0066' },
  { bg: '#e6f9ff', sub: '#33ccff', text: '#004d66' },
  { bg: '#ffe6f0', sub: '#ff66aa', text: '#660033' }
];

// ---- Global state ----
let parsedSections = null;       // output of SalesParser.parse()
let groupTerrMap = null;         // { groups: [...], byGroup: {group: [terrIds]} }
let currentConfig = ConfigStore.load();
let currentReportData = null;    // { groups: [...], meta: {...} } for rendering/download

// ---- DOM refs ----
const $ = (id) => document.getElementById(id);
const dropzone = $('dropzone');
const fileInput = $('fileInput');
const dropzoneText = $('dropzoneText');
const fnameEl = $('fname');
const parseStatus = $('parseStatus');
const progressBar = $('progressBar');
const progressFill = $('progressFill');
const groupSelect = $('groupSelect');
const terrSelect = $('terrSelect');
const generateBtn = $('generateBtn');
const genStatus = $('genStatus');
const reportContainer = $('reportContainer');
const reportBody = $('reportBody');
const reportTitle = $('reportTitle');
const reportSubtitle = $('reportSubtitle');
const configToggle = $('configToggle');
const configBody = $('configBody');
const separateChips = $('separateChips');
const mergeRulesEl = $('mergeRules');
const excludeZeroEl = $('excludeZero');

// ===========================================================================
// Date tag
// ===========================================================================
$('dateTag').textContent = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

// ===========================================================================
// STEP 1: File handling + PDF parsing
// ===========================================================================
fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) handleFile(file);
});

dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('has-file'); });
dropzone.addEventListener('dragleave', () => { dropzone.classList.remove('has-file'); });
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});

async function handleFile(file) {
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    setStatus(parseStatus, 'দুঃখিত, শুধু PDF ফাইল সাপোর্ট করে।', 'error');
    return;
  }

  fnameEl.textContent = file.name;
  dropzone.classList.add('has-file');
  dropzoneText.textContent = 'ফাইল লোড হয়েছে:';
  setStatus(parseStatus, 'PDF পড়া হচ্ছে...', '');
  showProgress(true, 5);

  try {
    const arrayBuffer = await file.arrayBuffer();
    const text = await extractTextFromPdf(arrayBuffer, (pct) => showProgress(true, pct));

    setStatus(parseStatus, 'ডাটা বিশ্লেষণ করা হচ্ছে...', '');
    parsedSections = SalesParser.parse(text);
    groupTerrMap = SalesParser.listGroupsAndTerritories(parsedSections);

    const totalItems = Object.values(parsedSections).reduce((s, sec) => s + sec.items.length, 0);
    const totalSections = Object.keys(parsedSections).length;

    if (totalSections === 0) {
      setStatus(parseStatus, 'কোনো ডাটা পাওয়া যায়নি। PDF format ঠিক আছে কিনা চেক করুন।', 'error');
      showProgress(false);
      return;
    }

    populateGroupSelect();
    setStatus(parseStatus, `✓ সফল! ${totalSections} টি Group+Territory সেকশন, মোট ${totalItems} টি পণ্য লাইন পাওয়া গেছে।`, 'ok');
    showProgress(false);
  } catch (err) {
    console.error(err);
    setStatus(parseStatus, 'ভুল হয়েছে: ' + err.message, 'error');
    showProgress(false);
  }
}

async function extractTextFromPdf(arrayBuffer, onProgress) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const numPages = pdf.numPages;
  let fullText = '';

  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();

    // Group text items by their Y position (line), preserving X order,
    // to reconstruct the row-based layout similar to `pdftotext -layout`.
    const lineMap = new Map();
    content.items.forEach(item => {
      const y = Math.round(item.transform[5]);
      if (!lineMap.has(y)) lineMap.set(y, []);
      lineMap.get(y).push(item);
    });

    // Sort lines top-to-bottom (PDF y-axis is bottom-up, so descending y = top-to-bottom)
    const sortedYs = Array.from(lineMap.keys()).sort((a, b) => b - a);

    const pageLines = sortedYs.map(y => {
      const items = lineMap.get(y).sort((a, b) => a.transform[4] - b.transform[4]);
      let line = '';
      let lastX = null;
      let lastWidth = 0;
      items.forEach(item => {
        const x = item.transform[4];
        if (lastX !== null) {
          const gap = x - (lastX + lastWidth);
          // Insert spaces proportional to the gap to preserve column alignment
          const spaceCount = Math.max(1, Math.round(gap / (item.height * 0.5 || 4)));
          line += ' '.repeat(Math.min(spaceCount, 20));
        }
        line += item.str;
        lastX = x;
        lastWidth = item.width;
      });
      return line;
    });

    fullText += pageLines.join('\n') + '\n';

    if (onProgress) onProgress(5 + Math.round((pageNum / numPages) * 90));
  }

  return fullText;
}

function showProgress(active, pct) {
  if (!active) {
    progressBar.classList.remove('active');
    progressFill.style.width = '0%';
    return;
  }
  progressBar.classList.add('active');
  progressFill.style.width = (pct || 0) + '%';
}

function setStatus(el, msg, cls) {
  el.textContent = msg;
  el.className = 'status' + (cls ? ' ' + cls : '');
}

// ===========================================================================
// STEP 2: Group / Territory selectors
// ===========================================================================
function populateGroupSelect() {
  groupSelect.innerHTML = '';
  groupTerrMap.groups.forEach(g => {
    const opt = document.createElement('option');
    opt.value = g;
    opt.textContent = g;
    groupSelect.appendChild(opt);
  });
  groupSelect.disabled = false;
  // trigger territory population for first group
  populateTerrSelect(groupSelect.value);
  generateBtn.disabled = false;
  // Also sync to search tab
  syncPdfToSearchTab();
}

function populateTerrSelect(group) {
  terrSelect.innerHTML = '';
  const terrs = (groupTerrMap.byGroup[group] || []);
  terrs.forEach(t => {
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = t;
    terrSelect.appendChild(opt);
  });
  terrSelect.disabled = terrs.length === 0;
}

groupSelect.addEventListener('change', () => populateTerrSelect(groupSelect.value));

// ===========================================================================
// STEP 3: Config UI
// ===========================================================================
configToggle.addEventListener('click', () => {
  configBody.classList.toggle('open');
});

function renderConfigUI() {
  // Separate chips
  separateChips.innerHTML = '';
  currentConfig.forceSeparate.forEach((name, idx) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.innerHTML = `${escapeHtml(name)} <button data-idx="${idx}" title="Remove">×</button>`;
    chip.querySelector('button').addEventListener('click', () => {
      currentConfig.forceSeparate.splice(idx, 1);
      ConfigStore.save(currentConfig);
      renderConfigUI();
    });
    separateChips.appendChild(chip);
  });

  // Merge rules
  mergeRulesEl.innerHTML = '';
  Object.entries(currentConfig.mergeRules).forEach(([from, to]) => {
    const row = document.createElement('div');
    row.className = 'split-rule';
    row.innerHTML = `<code>${escapeHtml(from)}</code> <span class="arrow">→</span> <code>${escapeHtml(to)}</code>
      <button class="btn-danger btn btn-small" style="margin-left:auto;" data-from="${escapeHtml(from)}">Remove</button>`;
    row.querySelector('button').addEventListener('click', () => {
      delete currentConfig.mergeRules[from];
      ConfigStore.save(currentConfig);
      renderConfigUI();
    });
    mergeRulesEl.appendChild(row);
  });

  excludeZeroEl.checked = currentConfig.excludeZero;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

$('addSeparateBtn').addEventListener('click', () => {
  const input = $('separateInput');
  const val = input.value.trim();
  if (!val) return;
  if (!currentConfig.forceSeparate.some(x => x.toLowerCase() === val.toLowerCase())) {
    currentConfig.forceSeparate.unshift(val.toUpperCase());
    ConfigStore.save(currentConfig);
    renderConfigUI();
  }
  input.value = '';
});

$('addMergeBtn').addEventListener('click', () => {
  const fromInput = $('mergeFromInput');
  const intoInput = $('mergeIntoInput');
  const from = fromInput.value.trim().toUpperCase();
  const into = intoInput.value.trim().toUpperCase();
  if (!from || !into) return;
  currentConfig.mergeRules[from] = into;
  ConfigStore.save(currentConfig);
  renderConfigUI();
  fromInput.value = '';
  intoInput.value = '';
});

excludeZeroEl.addEventListener('change', () => {
  currentConfig.excludeZero = excludeZeroEl.checked;
  ConfigStore.save(currentConfig);
});

$('resetConfigBtn').addEventListener('click', () => {
  if (confirm('সব custom rules মুছে default rules-এ ফিরে যাবেন?')) {
    currentConfig = ConfigStore.reset();
    renderConfigUI();
  }
});

renderConfigUI();

// ===========================================================================
// STEP 4: Generate report
// ===========================================================================
generateBtn.addEventListener('click', () => {
  if (!parsedSections) {
    setStatus(genStatus, 'প্রথমে একটি PDF আপলোড করুন।', 'error');
    return;
  }
  const group = groupSelect.value;
  const terr = terrSelect.value;
  const key = group + '|||' + terr;
  const sec = parsedSections[key];

  if (!sec) {
    setStatus(genStatus, 'এই Group/Territory এর জন্য কোনো ডাটা পাওয়া যায়নি।', 'error');
    return;
  }

  setStatus(genStatus, 'রিপোর্ট তৈরি হচ্ছে...', '');
  currentReportData = buildReportData(sec, currentConfig);
  renderReport(currentReportData);
  setStatus(genStatus, `✓ রিপোর্ট তৈরি হয়েছে — ${currentReportData.groups.length} টি group, ${currentReportData.totalItems} টি পণ্য।`, 'ok');
  reportContainer.classList.add('visible');
  reportContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

// ===========================================================================
// Grouping engine
// ===========================================================================

/**
 * Derive the "natural" base group name from a brand name: simply the first
 * word of the name (before any space, strength number, or "--SIZE" suffix).
 * e.g. "BISOPRO A 2.5/5 TABLET 30'S--30'S" -> "BISOPRO"
 *      "LINATAB M 2.5/500 TABLET 30'S"     -> "LINATAB"
 *      "ACUREN 25 TAB 100'S--100S"         -> "ACUREN"
 *
 * Brands that need their second word to stay distinct (e.g. "LINATAB E")
 * are handled via forceSeparate, which is checked BEFORE this function.
 */
function deriveBaseGroup(name) {
  let n = name.replace(/--.*$/, '').trim();
  const words = n.split(/\s+/);
  return words[0] || n;
}

/**
 * Find the matching forceSeparate entry for a brand name, if any.
 * Returns the matched prefix string, or null.
 * Longer (more specific) prefixes are checked first.
 */
function findForceSeparateMatch(name, forceSeparateList) {
  const upperName = name.toUpperCase();
  const sorted = [...forceSeparateList].sort((a, b) => b.length - a.length);
  for (const prefix of sorted) {
    if (upperName.startsWith(prefix.toUpperCase())) {
      return prefix.toUpperCase();
    }
  }
  return null;
}

/**
 * Apply merge rules to a group name (after force-separate / base-group
 * derivation). Returns the final group name.
 */
function applyMergeRules(groupName, mergeRules) {
  const upper = groupName.toUpperCase();
  for (const [from, to] of Object.entries(mergeRules)) {
    if (upper === from.toUpperCase()) {
      return to.toUpperCase();
    }
  }
  return groupName;
}

/**
 * Build the final grouped report data structure from raw section items.
 */
function buildReportData(section, config) {
  // Step 1: assign each item to a group name
  const itemsWithGroup = section.items.map(item => {
    let groupName = findForceSeparateMatch(item.name, config.forceSeparate);
    if (!groupName) {
      groupName = deriveBaseGroup(item.name);
    }
    groupName = applyMergeRules(groupName, config.mergeRules);

    const total = round2(item.soldVal + item.intVal);
    return { ...item, groupName, total };
  });

  // Step 2: optionally exclude zero rows
  const filtered = config.excludeZero
    ? itemsWithGroup.filter(it => !isZeroRow(it))
    : itemsWithGroup;

  // Step 3: group, preserving first-seen order of group names
  const groupOrder = [];
  const groupMap = {};
  filtered.forEach(item => {
    if (!groupMap[item.groupName]) {
      groupMap[item.groupName] = [];
      groupOrder.push(item.groupName);
    }
    groupMap[item.groupName].push(item);
  });

  // Step 4: build group objects with subtotals and colors
  let totalItems = 0;
  let grand = { tgtBox: 0, soldBox: 0, intBox: 0, tgtVal: 0, soldVal: 0, intVal: 0, total: 0 };

  const groups = groupOrder.map((gname, idx) => {
    const items = groupMap[gname];
    const color = GROUP_COLORS[idx % GROUP_COLORS.length];
    const sub = { tgtBox: 0, soldBox: 0, intBox: 0, tgtVal: 0, soldVal: 0, intVal: 0, total: 0 };
    items.forEach(it => {
      sub.tgtBox += it.tgtBox;
      sub.soldBox += it.soldBox;
      sub.intBox += it.intBox;
      sub.tgtVal += it.tgtVal;
      sub.soldVal += it.soldVal;
      sub.intVal += it.intVal;
      sub.total += it.total;
      totalItems++;
    });
    grand.tgtBox += sub.tgtBox;
    grand.soldBox += sub.soldBox;
    grand.intBox += sub.intBox;
    grand.tgtVal += sub.tgtVal;
    grand.soldVal += sub.soldVal;
    grand.intVal += sub.intVal;
    grand.total += sub.total;

    return { name: gname, color, items, subtotal: sub };
  });

  return {
    meta: { group: section.group, terrId: section.terrId },
    groups,
    grand,
    totalItems
  };
}

function isZeroRow(it) {
  return it.tgtBox === 0 && it.soldBox === 0 && it.intBox === 0 &&
         it.tgtVal === 0 && it.soldVal === 0 && it.intVal === 0;
}

function round2(n) {
  return Math.round(n);
}

// ===========================================================================
// Rendering
// ===========================================================================
function fmt(n) {
  if (n === null || n === undefined) return '—';
  if (n === 0) return '0';
  return Math.round(n).toLocaleString('en-IN');
}

function renderReport(data) {
  reportTitle.textContent = `Territory Wise Sale (Qty & Value) — Group: ${data.meta.group} | Terr ID: ${data.meta.terrId}`;
  reportSubtitle.textContent = `All values in BDT (৳) · Total = Sold Value + In-transit Value · Generated ${new Date().toLocaleString('en-GB')}`;

  reportBody.innerHTML = '';

  data.groups.forEach(g => {
    // Section header
    const hdr = document.createElement('tr');
    hdr.className = 'section-header';
    hdr.style.background = g.color.sub;
    hdr.innerHTML = `<td colspan="8" style="color:${g.color.text}">${escapeHtml(g.name)}</td>`;
    reportBody.appendChild(hdr);

    // Item rows
    g.items.forEach(it => {
      const tr = document.createElement('tr');
      tr.style.background = g.color.bg;
      if (isZeroRow(it)) tr.classList.add('zero-row');
      tr.innerHTML = `
        <td>${escapeHtml(it.name)}</td>
        <td>${fmt(it.tgtBox)}</td>
        <td>${fmt(it.soldBox)}</td>
        <td>${fmt(it.intBox)}</td>
        <td>${fmt(it.tgtVal)}</td>
        <td>${fmt(it.soldVal)}</td>
        <td>${fmt(it.intVal)}</td>
        <td>${fmt(it.total)}</td>`;
      reportBody.appendChild(tr);
    });

    // Subtotal
    const sub = document.createElement('tr');
    sub.className = 'subtotal';
    sub.style.background = g.color.sub;
    const s = g.subtotal;
    sub.innerHTML = `
      <td style="color:${g.color.text}">Subtotal — ${escapeHtml(g.name)}</td>
      <td style="color:${g.color.text}">${fmt(s.tgtBox)}</td>
      <td style="color:${g.color.text}">${fmt(s.soldBox)}</td>
      <td style="color:${g.color.text}">${fmt(s.intBox)}</td>
      <td style="color:${g.color.text}">${fmt(s.tgtVal)}</td>
      <td style="color:${g.color.text}">${fmt(s.soldVal)}</td>
      <td style="color:${g.color.text}">${fmt(s.intVal)}</td>
      <td style="color:${g.color.text}">${fmt(s.total)}</td>`;
    reportBody.appendChild(sub);
  });

  // Grand total
  const gt = document.createElement('tr');
  gt.className = 'grand-total';
  const gr = data.grand;
  gt.innerHTML = `
    <td>GRAND TOTAL — ${escapeHtml(data.meta.terrId)} (${escapeHtml(data.meta.group)})</td>
    <td>${fmt(gr.tgtBox)}</td>
    <td>${fmt(gr.soldBox)}</td>
    <td>${fmt(gr.intBox)}</td>
    <td>৳${fmt(gr.tgtVal)}</td>
    <td>৳${fmt(gr.soldVal)}</td>
    <td>৳${fmt(gr.intVal)}</td>
    <td>৳${fmt(gr.total)}</td>`;
  reportBody.appendChild(gt);

  // reset search
  $('searchBox').value = '';
  $('matchCount').textContent = '';
}

// ===========================================================================
// Search / filter
// ===========================================================================
$('searchBox').addEventListener('input', (e) => filterTable(e.target.value));
$('clearSearchBtn').addEventListener('click', () => {
  $('searchBox').value = '';
  filterTable('');
});

function filterTable(q) {
  q = q.trim().toLowerCase();
  const rows = Array.from(reportBody.querySelectorAll('tr'));

  if (!q) {
    rows.forEach(r => { r.style.display = ''; r.style.outline = ''; });
    $('matchCount').textContent = '';
    return;
  }

  // Tag section headers with group index
  let gid = -1;
  const rowGid = [];
  rows.forEach(r => {
    if (r.classList.contains('section-header')) gid++;
    rowGid.push(gid);
  });

  // Find matching groups
  const matchGroups = new Set();
  let matchCount = 0;
  rows.forEach((r, i) => {
    if (r.classList.contains('section-header') || r.classList.contains('subtotal') || r.classList.contains('grand-total')) return;
    const name = (r.cells[0]?.textContent || '').toLowerCase();
    const matched = name.includes(q);
    r.dataset.matched = matched ? '1' : '0';
    if (matched) {
      matchCount++;
      matchGroups.add(rowGid[i]);
    }
  });

  // Show/hide
  rows.forEach((r, i) => {
    const g = rowGid[i];
    if (r.classList.contains('grand-total')) {
      r.style.display = '';
    } else if (r.classList.contains('section-header') || r.classList.contains('subtotal')) {
      r.style.display = matchGroups.has(g) ? '' : 'none';
    } else {
      if (r.dataset.matched === '1') {
        r.style.display = '';
        r.style.outline = '2px solid #e63946';
        r.style.outlineOffset = '-1px';
      } else {
        r.style.display = matchGroups.has(g) ? '' : 'none';
        r.style.outline = '';
      }
    }
  });

  $('matchCount').textContent = matchCount ? `${matchCount} টি product পাওয়া গেছে` : 'কোনো product পাওয়া যায়নি';
}

// ===========================================================================
// Print & Download
// ===========================================================================
$('printBtn').addEventListener('click', () => window.print());

$('downloadBtn').addEventListener('click', () => {
  if (!currentReportData) return;
  const html = buildStandaloneHtml(currentReportData);
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const safeGroup = currentReportData.meta.group.replace(/[^a-zA-Z0-9]/g, '');
  const safeTerr = currentReportData.meta.terrId.replace(/[^a-zA-Z0-9-]/g, '');
  a.href = url;
  a.download = `${safeTerr}_${safeGroup}_Sales_Report.html`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

/**
 * Build a fully self-contained HTML report (no external dependencies)
 * matching the same visual style as the in-app preview.
 */
function buildStandaloneHtml(data) {
  const rowsHtml = [];

  data.groups.forEach(g => {
    rowsHtml.push(`<tr class="section-header" style="background:${g.color.sub}"><td colspan="8" style="color:${g.color.text}">${escapeHtml(g.name)}</td></tr>`);

    g.items.forEach(it => {
      const zeroClass = isZeroRow(it) ? ' class="zero-row"' : '';
      rowsHtml.push(`<tr style="background:${g.color.bg}"${zeroClass}>
        <td>${escapeHtml(it.name)}</td>
        <td>${fmt(it.tgtBox)}</td>
        <td>${fmt(it.soldBox)}</td>
        <td>${fmt(it.intBox)}</td>
        <td>${fmt(it.tgtVal)}</td>
        <td>${fmt(it.soldVal)}</td>
        <td>${fmt(it.intVal)}</td>
        <td>${fmt(it.total)}</td>
      </tr>`);
    });

    const s = g.subtotal;
    rowsHtml.push(`<tr class="subtotal" style="background:${g.color.sub}">
      <td style="color:${g.color.text}">Subtotal — ${escapeHtml(g.name)}</td>
      <td style="color:${g.color.text}">${fmt(s.tgtBox)}</td>
      <td style="color:${g.color.text}">${fmt(s.soldBox)}</td>
      <td style="color:${g.color.text}">${fmt(s.intBox)}</td>
      <td style="color:${g.color.text}">${fmt(s.tgtVal)}</td>
      <td style="color:${g.color.text}">${fmt(s.soldVal)}</td>
      <td style="color:${g.color.text}">${fmt(s.intVal)}</td>
      <td style="color:${g.color.text}">${fmt(s.total)}</td>
    </tr>`);
  });

  const gr = data.grand;
  rowsHtml.push(`<tr class="grand-total">
    <td>GRAND TOTAL — ${escapeHtml(data.meta.terrId)} (${escapeHtml(data.meta.group)})</td>
    <td>${fmt(gr.tgtBox)}</td>
    <td>${fmt(gr.soldBox)}</td>
    <td>${fmt(gr.intBox)}</td>
    <td>৳${fmt(gr.tgtVal)}</td>
    <td>৳${fmt(gr.soldVal)}</td>
    <td>৳${fmt(gr.intVal)}</td>
    <td>৳${fmt(gr.total)}</td>
  </tr>`);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(data.meta.terrId)} ${escapeHtml(data.meta.group)} Sales Report</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; background: #f5f5f5; padding: 20px; font-size: 12px; }
  .container { max-width: 1100px; margin: 0 auto; background: #fff; border-radius: 8px; padding: 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
  .header { background: #1a1a2e; color: #fff; padding: 14px 18px; border-radius: 6px; margin-bottom: 16px; }
  .header h1 { font-size: 16px; font-weight: bold; margin-bottom: 4px; }
  .header p { font-size: 11px; color: #ccc; }
  .toolbar { margin-bottom:14px; display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  .print-btn { padding: 8px 18px; background: #1a1a2e; color: #fff; border: none; border-radius: 5px; cursor: pointer; font-size: 12px; }
  #searchBox { flex:1; min-width:220px; padding:8px 12px; border:1.5px solid #ccc; border-radius:5px; font-size:12px; }
  #clearBtn { padding: 8px 14px; background: #e0e0e0; border: none; border-radius: 5px; cursor: pointer; font-size: 12px; }
  #matchCount { font-size: 11px; color: #666; }
  @media print {
  * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; color-adjust: exact !important; }
  body { background: #fff !important; padding: 0 !important; margin: 0 !important; }
  .toolbar, .print-btn, #searchBox, #clearBtn, #matchCount, .download-btn { display: none !important; }
  .container { box-shadow: none !important; padding: 8px !important; max-width: 100% !important; }
  table { width: 100% !important; border-collapse: collapse !important; table-layout: auto !important; }
  thead { display: table-header-group !important; }
  tbody { display: table-row-group !important; }
  tr { page-break-inside: avoid !important; break-inside: avoid !important; }
  .section-header { page-break-after: avoid !important; break-after: avoid !important; }
  .subtotal { page-break-before: avoid !important; break-before: avoid !important; }
  .grand-total { page-break-before: avoid !important; break-before: avoid !important; }
  td, th { overflow-wrap: break-word !important; word-break: break-word !important; font-size: 9pt !important; padding: 3px 5px !important; }
  th { font-size: 8pt !important; }
  .section-header td { font-size: 8pt !important; }
  .table-scroll { overflow: visible !important; max-height: none !important; height: auto !important; }
  .report-wrap { border: none !important; overflow: visible !important; }
  .report-header { padding: 8px 12px !important; }
  .report-header h2 { font-size: 12pt !important; }
  .report-header p { font-size: 8pt !important; }
  @page { margin: 8mm; size: A4 landscape; }
}
  table { width: 100%; border-collapse: collapse; }
  thead th { background: #2c2c2c; color: #fff; padding: 8px 10px; text-align: right; font-size: 11px; white-space: nowrap; border: 1px solid #444; }
  thead th:first-child { text-align: left; width: 34%; }
  td { padding: 5px 10px; border: 0.5px solid #ddd; text-align: right; }
  td:first-child { text-align: left; }
  .section-header td { font-weight: bold; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; padding: 6px 10px; }
  .subtotal td { font-weight: bold; font-size: 11.5px; border-top: 1.5px solid rgba(0,0,0,0.2); }
  .grand-total td { font-weight: bold; font-size: 13px; background: #1a1a2e !important; color: #fff !important; border-top: 2px solid #000; padding: 9px 10px; }
  .zero-row td { color: #aaa; font-style: italic; }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>Territory Wise Sale (Qty &amp; Value) — Group: ${escapeHtml(data.meta.group)} | Terr ID: ${escapeHtml(data.meta.terrId)}</h1>
    <p>All values in BDT (৳) · Total = Sold Value + In-transit Value · Generated ${new Date().toLocaleString('en-GB')}</p>
  </div>
  <div class="toolbar">
    <button class="print-btn" onclick="window.print()">🖨️ Print / Save as PDF</button>
    <input type="text" id="searchBox" placeholder="🔍 Product name লিখুন..." oninput="filterTable(this.value)">
    <button id="clearBtn" onclick="document.getElementById('searchBox').value='';filterTable('')">✕ Clear</button>
    <span id="matchCount"></span>
  </div>
  <table>
    <thead>
      <tr>
        <th>Brand Name</th>
        <th>Tgt Box</th>
        <th>Sold Box</th>
        <th>Int Box</th>
        <th>Tgt Value (৳)</th>
        <th>Sold Value (৳)</th>
        <th>Int Value (৳)</th>
        <th>Total (৳)</th>
      </tr>
    </thead>
    <tbody id="tbody">
${rowsHtml.join('\n')}
    </tbody>
  </table>
</div>
<script>
function filterTable(q){
  q = q.trim().toLowerCase();
  const rows = Array.from(document.querySelectorAll('#tbody tr'));
  if(!q){
    rows.forEach(r=>{ r.style.display=''; r.style.outline=''; });
    document.getElementById('matchCount').textContent='';
    return;
  }
  let gid=-1; const rowGid=[];
  rows.forEach(r=>{ if(r.classList.contains('section-header')) gid++; rowGid.push(gid); });
  const matchGroups=new Set(); let matchCount=0;
  rows.forEach((r,i)=>{
    if(r.classList.contains('section-header')||r.classList.contains('subtotal')||r.classList.contains('grand-total')) return;
    const name=(r.cells[0]?.textContent||'').toLowerCase();
    const matched=name.includes(q);
    r.dataset.matched=matched?'1':'0';
    if(matched){ matchCount++; matchGroups.add(rowGid[i]); }
  });
  rows.forEach((r,i)=>{
    const g=rowGid[i];
    if(r.classList.contains('grand-total')){ r.style.display=''; }
    else if(r.classList.contains('section-header')||r.classList.contains('subtotal')){ r.style.display=matchGroups.has(g)?'':'none'; }
    else {
      if(r.dataset.matched==='1'){ r.style.display=''; r.style.outline='2px solid #e63946'; r.style.outlineOffset='-1px'; }
      else { r.style.display=matchGroups.has(g)?'':'none'; r.style.outline=''; }
    }
  });
  document.getElementById('matchCount').textContent = matchCount ? matchCount+' টি product পাওয়া গেছে' : 'কোনো product পাওয়া যায়নি';
}
</script>
</body>
</html>`;
}

// ===========================================================================
// TAB NAVIGATION
// ===========================================================================
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.tab).classList.add('active');
    // Sync PDF state to search tab when switching
    if (btn.dataset.tab === 'searchTab') syncPdfToSearchTab();
  });
});

// ===========================================================================
// PRODUCT SEARCH TAB
// ===========================================================================
const psGroupSelect   = $('psGroupSelect');
const psTerrSelect    = $('psTerrSelect');
const psProductInput  = $('psProductInput');
const psAddProductBtn = $('psAddProductBtn');
const psProductTags   = $('psProductTags');
const psSearchBtn     = $('psSearchBtn');
const psClearBtn      = $('psClearBtn');
const psStatus        = $('psStatus');
const psResults       = $('psResults');
const psFileStatus    = $('psFileStatus');

let psProducts = []; // list of product search terms

// Sync parsed PDF data to search tab selects
function syncPdfToSearchTab() {
  if (!parsedSections || !groupTerrMap) {
    psFileStatus.textContent = 'Full Report tab এ প্রথমে PDF লোড করুন।';
    psFileStatus.className = 'status';
    return;
  }
  psFileStatus.textContent = '✓ PDF লোড হয়েছে — Group ও Territory select করুন।';
  psFileStatus.className = 'status ok';

  // Populate group select
  psGroupSelect.innerHTML = '';
  groupTerrMap.groups.forEach(g => {
    const opt = document.createElement('option');
    opt.value = g; opt.textContent = g;
    psGroupSelect.appendChild(opt);
  });
  psGroupSelect.disabled = false;
  psSyncTerrSelect(psGroupSelect.value);

  psProductInput.disabled = false;
  psAddProductBtn.disabled = false;
  psSearchBtn.disabled = false;
}

function psSyncTerrSelect(group) {
  psTerrSelect.innerHTML = '';
  (groupTerrMap.byGroup[group] || []).forEach(t => {
    const opt = document.createElement('option');
    opt.value = t; opt.textContent = t;
    psTerrSelect.appendChild(opt);
  });
  psTerrSelect.disabled = false;
}

psGroupSelect.addEventListener('change', () => psSyncTerrSelect(psGroupSelect.value));

// Also auto-sync when PDF is loaded (user may already be on search tab)
const _origPopulateGroupSelect = populateGroupSelect;

// Add product tags
function addProduct(name) {
  const n = name.trim().toUpperCase();
  if (!n || psProducts.includes(n)) return;
  psProducts.push(n);
  renderProductTags();
}

function renderProductTags() {
  psProductTags.innerHTML = '';
  psProducts.forEach((p, i) => {
    const tag = document.createElement('span');
    tag.className = 'product-tag';
    tag.innerHTML = `${escapeHtml(p)} <button data-i="${i}" title="Remove">×</button>`;
    tag.querySelector('button').addEventListener('click', () => {
      psProducts.splice(i, 1);
      renderProductTags();
    });
    psProductTags.appendChild(tag);
  });
}

psAddProductBtn.addEventListener('click', () => {
  const val = psProductInput.value;
  // Support comma-separated input
  val.split(',').forEach(v => addProduct(v));
  psProductInput.value = '';
  psProductInput.focus();
});

psProductInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault();
    const val = psProductInput.value.replace(/,$/, '');
    if (val.trim()) addProduct(val);
    psProductInput.value = '';
  }
});

psClearBtn.addEventListener('click', () => {
  psProducts = [];
  renderProductTags();
  psResults.innerHTML = '';
  psProductInput.value = '';
  setStatus(psStatus, '', '');
});

// Search
psSearchBtn.addEventListener('click', () => {
  if (!parsedSections) {
    setStatus(psStatus, 'Full Report tab এ PDF লোড করুন।', 'error');
    return;
  }
  if (psProducts.length === 0) {
    setStatus(psStatus, 'অন্তত একটি product name add করুন।', 'error');
    return;
  }

  const group  = psGroupSelect.value;
  const terr   = psTerrSelect.value;
  const key    = group + '|||' + terr;
  const sec    = parsedSections[key];
  const excludeZero   = $('psExcludeZero').checked;
  const partialMatch  = $('psShowAllVariants').checked;

  if (!sec) {
    setStatus(psStatus, 'এই Group/Territory এর জন্য কোনো ডাটা নেই।', 'error');
    return;
  }

  // Find matching items per product
  const results = psProducts.map((prod, idx) => {
    const items = sec.items.filter(it => {
      const name = it.name.toUpperCase();
      return partialMatch ? name.includes(prod) : name.startsWith(prod);
    }).filter(it => {
      if (!excludeZero) return true;
      return !(it.tgtBox===0 && it.soldBox===0 && it.intBox===0 &&
               it.tgtVal===0 && it.soldVal===0 && it.intVal===0);
    });
    const color = GROUP_COLORS[idx % GROUP_COLORS.length];
    const sub = items.reduce((s, it) => {
      s.tgtBox += it.tgtBox; s.soldBox += it.soldBox; s.intBox += it.intBox;
      s.tgtVal += it.tgtVal; s.soldVal += it.soldVal; s.intVal += it.intVal;
      s.total  += it.soldVal + it.intVal;
      return s;
    }, { tgtBox:0, soldBox:0, intBox:0, tgtVal:0, soldVal:0, intVal:0, total:0 });
    return { prod, items, color, sub };
  });

  const found = results.filter(r => r.items.length > 0);
  const notFound = results.filter(r => r.items.length === 0).map(r => r.prod);

  if (found.length === 0) {
    setStatus(psStatus, `"${psProducts.join(', ')}" — কোনো product পাওয়া যায়নি।`, 'error');
    psResults.innerHTML = '';
    return;
  }

  setStatus(psStatus,
    `✓ ${found.reduce((s,r)=>s+r.items.length,0)} টি variant পাওয়া গেছে।` +
    (notFound.length ? ` (পাওয়া যায়নি: ${notFound.join(', ')})` : ''),
    'ok'
  );

  renderSearchResults(found, { group, terr });
});

function renderSearchResults(results, meta) {
  // Grand totals
  const grand = results.reduce((g, r) => {
    g.tgtBox += r.sub.tgtBox; g.soldBox += r.sub.soldBox; g.intBox += r.sub.intBox;
    g.tgtVal += r.sub.tgtVal; g.soldVal += r.sub.soldVal; g.intVal += r.sub.intVal;
    g.total  += r.sub.total;
    return g;
  }, { tgtBox:0, soldBox:0, intBox:0, tgtVal:0, soldVal:0, intVal:0, total:0 });

  const rowsHtml = [];
  results.forEach(r => {
    if (!r.items.length) return;
    rowsHtml.push(`<tr class="section-header" style="background:${r.color.sub}"><td colspan="8" style="color:${r.color.text}">${escapeHtml(r.prod)}</td></tr>`);
    r.items.forEach(it => {
      const tot = it.soldVal + it.intVal;
      rowsHtml.push(`<tr style="background:${r.color.bg}">
        <td>${escapeHtml(it.name)}</td>
        <td>${fmt(it.tgtBox)}</td><td>${fmt(it.soldBox)}</td><td>${fmt(it.intBox)}</td>
        <td>${fmt(it.tgtVal)}</td><td>${fmt(it.soldVal)}</td><td>${fmt(it.intVal)}</td>
        <td>${fmt(tot)}</td></tr>`);
    });
    const s = r.sub;
    rowsHtml.push(`<tr class="subtotal" style="background:${r.color.sub}">
      <td style="color:${r.color.text}">Subtotal — ${escapeHtml(r.prod)}</td>
      <td style="color:${r.color.text}">${fmt(s.tgtBox)}</td>
      <td style="color:${r.color.text}">${fmt(s.soldBox)}</td>
      <td style="color:${r.color.text}">${fmt(s.intBox)}</td>
      <td style="color:${r.color.text}">${fmt(s.tgtVal)}</td>
      <td style="color:${r.color.text}">${fmt(s.soldVal)}</td>
      <td style="color:${r.color.text}">${fmt(s.intVal)}</td>
      <td style="color:${r.color.text}">${fmt(s.total)}</td></tr>`);
  });

  rowsHtml.push(`<tr class="grand-total">
    <td>GRAND TOTAL — ${escapeHtml(meta.terr)} (${escapeHtml(meta.group)})</td>
    <td>${fmt(grand.tgtBox)}</td><td>${fmt(grand.soldBox)}</td><td>${fmt(grand.intBox)}</td>
    <td>৳${fmt(grand.tgtVal)}</td><td>৳${fmt(grand.soldVal)}</td><td>৳${fmt(grand.intVal)}</td>
    <td>৳${fmt(grand.total)}</td></tr>`);

  psResults.innerHTML = `
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px;">
      <button class="btn" id="psDownloadBtn">⬇ HTML ডাউনলোড</button>
      <button class="btn btn-secondary" id="psPrintBtn">🖨 Print / PDF</button>
    </div>
    <div class="report-wrap">
      <div class="report-header">
        <h2>Product Search — ${escapeHtml(meta.group)} | ${escapeHtml(meta.terr)}</h2>
        <p>Products: ${escapeHtml(results.map(r=>r.prod).join(', '))} · Total = Sold Value + Int Value</p>
      </div>
      <div class="table-scroll">
        <table class="report-table">
          <thead><tr>
            <th>Brand Name</th><th>Tgt Box</th><th>Sold Box</th><th>Int Box</th>
            <th>Tgt Value (৳)</th><th>Sold Value (৳)</th><th>Int Value (৳)</th><th>Total (৳)</th>
          </tr></thead>
          <tbody>${rowsHtml.join('')}</tbody>
        </table>
      </div>
    </div>`;

  $('psDownloadBtn').addEventListener('click', () => {
    const html = buildStandaloneHtml({
      meta,
      groups: results.filter(r=>r.items.length).map(r => ({
        name: r.prod, color: r.color,
        items: r.items.map(it => ({...it, total: it.soldVal+it.intVal})),
        subtotal: r.sub
      })),
      grand
    });
    const blob = new Blob([html], { type: 'text/html' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = `${meta.terr}_${results.map(r=>r.prod).join('_')}_Search.html`;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  $('psPrintBtn').addEventListener('click', () => window.print());

  psResults.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Auto-sync when PDF loads (hook into existing populateGroupSelect)
const _origGenerateBtnListener = generateBtn.onclick;
// After PDF loads, also update search tab if it's been visited
const originalHandleFile = handleFile;
