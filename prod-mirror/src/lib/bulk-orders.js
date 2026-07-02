// Bulk order import — PURE parsing + column-mapping helpers (no React, no DOM, no network).
// The Bulk Add screen uses these to turn a pasted block / CSV / xlsx sheet into order rows,
// then hands each row to callWrite('createStop', …) exactly like the single New Order form.

// The order fields a bulk row can carry. `key` matches the single-order row model (StopRow in
// nuvizz-write-ops.mts → buildStopPayload); `required` gates a row as ready-to-create. `aliases`
// drive header auto-mapping (matched case/space/punctuation-insensitively).
export const BULK_FIELDS = [
  { key: 'name', label: 'Consignee / business', required: true, aliases: ['name', 'consignee', 'business', 'customer', 'company', 'shipto', 'ship to', 'deliver to', 'destination', 'account'] },
  { key: 'addr1', label: 'Address', required: true, aliases: ['addr', 'addr1', 'address', 'address1', 'street', 'ship to address', 'delivery address'] },
  { key: 'addr2', label: 'Suite / unit', required: false, aliases: ['addr2', 'address2', 'suite', 'unit', 'apt', 'ste', 'line2'] },
  { key: 'city', label: 'City', required: true, aliases: ['city', 'town'] },
  { key: 'state', label: 'State', required: true, aliases: ['state', 'st', 'province', 'region'] },
  { key: 'zip', label: 'ZIP', required: true, aliases: ['zip', 'zipcode', 'postal', 'postalcode', 'zip postal'] },
  { key: 'itemDesc', label: 'Item description', required: false, aliases: ['item', 'items', 'description', 'desc', 'commodity', 'product', 'goods', 'contents', 'item description'] },
  { key: 'stopNbr', label: 'Order #', required: false, aliases: ['order', 'order no', 'order number', 'ordernbr', 'po', 'po number', 'reference', 'ref'] },
  { key: 'pro', label: 'PRO / shipment #', required: false, aliases: ['pro', 'pro number', 'shipment', 'shipment number', 'bol', 'tracking'] },
  { key: 'pallets', label: 'Pallets', required: false, aliases: ['pallet', 'pallets', 'plt', 'plts', 'skids', 'skid'] },
  { key: 'cartons', label: 'Cartons', required: false, aliases: ['carton', 'cartons', 'ctn', 'ctns', 'cases', 'pieces', 'pcs', 'qty', 'quantity'] },
  { key: 'weight', label: 'Weight (lbs)', required: false, aliases: ['weight', 'wt', 'lbs', 'pounds'] },
];

export const BULK_FIELD_KEYS = BULK_FIELDS.map((f) => f.key);
const FIELD_BY_KEY = Object.fromEntries(BULK_FIELDS.map((f) => [f.key, f]));

// Normalize a cell for alias matching: lowercase, collapse non-alphanumerics to single spaces.
function norm(s) { return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

// Does any of `field`'s aliases match `cellNorm`? A short alias (e.g. "st", "ste", "po") must
// match a WHOLE TOKEN — never a fragment inside a word ("st" must not hit "mystery"/"street").
// A longer alias (>=4 chars) may also match as a substring so "shiptoaddress" resolves. `minToken`
// is the shortest alias length allowed to match as a token (2 for mapping, 3 for header-sniffing —
// stricter there so a data cell like "500 Main St" isn't mistaken for a header via the "st" token).
function aliasHit(field, cellNorm, minToken) {
  const tokens = cellNorm.split(' ');
  return field.aliases.some((a) => {
    const na = norm(a);
    if (na === cellNorm) return true;                              // exact
    if (na.length >= minToken && tokens.includes(na)) return true; // whole-token
    return na.length >= 4 && cellNorm.includes(na);               // long-substring
  });
}
const aliasExact = (field, cellNorm) => field.aliases.some((a) => norm(a) === cellNorm);

// Detect the delimiter of a pasted/CSV block. A copy from Excel/Google Sheets is TAB-separated;
// a CSV export is comma-separated. Tab wins if present in the first few lines.
export function detectDelimiter(text) {
  const head = String(text ?? '').split(/\r?\n/).slice(0, 5).join('\n');
  return head.includes('\t') ? '\t' : ',';
}

// Parse a delimited block into an array of string-cell rows. Handles RFC-4180-ish quoted CSV
// fields: "a,b" keeps the comma, "" is an escaped quote, and newlines inside quotes stay in-cell.
// Fully-blank trailing rows are dropped.
export function parseDelimited(text, delimiter) {
  const s = String(text ?? '');
  const delim = delimiter || detectDelimiter(s);
  const rows = [];
  let row = [], cell = '', i = 0, inQuotes = false;
  while (i < s.length) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { cell += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      cell += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === delim) { row.push(cell); cell = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; continue; }
    cell += c; i++;
  }
  row.push(cell); rows.push(row);
  while (rows.length && rows[rows.length - 1].every((x) => String(x).trim() === '')) rows.pop();
  return rows;
}

// Heuristic: does the first row look like a HEADER (field labels) rather than data? True when at
// least two of its non-empty cells match a known field alias. Lets the importer skip a header row
// automatically while still handling header-less sheets (positional mapping).
export function looksLikeHeader(row) {
  if (!Array.isArray(row)) return false;
  const cells = row.map(norm).filter(Boolean);
  if (cells.length < 2) return false;
  let hits = 0;
  for (const cell of cells) if (BULK_FIELDS.some((f) => aliasHit(f, cell, 3))) hits++;
  return hits >= 2;
}

// Auto-map header cells → field keys. Returns { [colIndex]: fieldKey }. Exact alias matches are
// assigned first (a column labelled exactly "state" beats one merely containing "state"), then
// substring matches fill the rest. Each field is used at most once; each column maps to one field.
export function autoMapColumns(headerRow) {
  const cells = (headerRow || []).map(norm);
  const map = {};
  const usedFields = new Set();
  const assign = (idx, key) => { map[idx] = key; usedFields.add(key); };
  // Pass 1 — exact alias equality (a column labelled exactly "state" wins over one merely
  // containing it).
  cells.forEach((cell, idx) => {
    if (!cell || map[idx] != null) return;
    for (const f of BULK_FIELDS) {
      if (usedFields.has(f.key)) continue;
      if (aliasExact(f, cell)) { assign(idx, f.key); break; }
    }
  });
  // Pass 2 — whole-token / long-substring match (see aliasHit); short aliases match only as
  // whole tokens, so "ST" → state but "Mystery Column" stays unmapped.
  cells.forEach((cell, idx) => {
    if (!cell || map[idx] != null) return;
    for (const f of BULK_FIELDS) {
      if (usedFields.has(f.key)) continue;
      if (aliasHit(f, cell, 2)) { assign(idx, f.key); break; }
    }
  });
  return map;
}

// A stable signature for a header row, so a remembered mapping can be re-applied to the same sheet
// layout next time (persisted by the screen in localStorage). Null when there's no usable header.
export function headerSignature(headerRow) {
  const cells = (headerRow || []).map(norm).filter(Boolean);
  return cells.length ? cells.join('|') : null;
}

// Turn data rows + a column→field mapping into order-row objects (StopRow-shaped, all strings).
// mapping: { [colIndex]: fieldKey }. Cells are trimmed; unmapped columns are ignored; a mapping to
// '' or an unknown key is skipped.
export function mappedRowsToOrders(dataRows, mapping) {
  const entries = Object.entries(mapping || {}).filter(([, key]) => key && FIELD_BY_KEY[key]);
  return (dataRows || []).map((cells) => {
    const o = {};
    for (const [idx, key] of entries) o[key] = String(cells[Number(idx)] ?? '').trim();
    return o;
  });
}

// Which REQUIRED fields (name, addr1, city, state, zip) are missing from an order row.
export function bulkRowMissing(o) {
  return BULK_FIELDS.filter((f) => f.required && !String(o?.[f.key] ?? '').trim()).map((f) => f.key);
}

// A row is BLANK (skip silently, don't flag as an error) when it has no field values at all.
export function bulkRowIsBlank(o) {
  return BULK_FIELD_KEYS.every((k) => !String(o?.[k] ?? '').trim());
}
