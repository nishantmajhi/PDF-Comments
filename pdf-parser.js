/**
 * pdf-parser.js
 * Lightweight PDF annotation extractor — no external dependencies.
 *
 * Bytes in, comment threads out. Nothing in this file touches the DOM, the
 * `chrome` namespace or the network, which is what makes it testable; see
 * `tests/`.
 *
 * How a comment is found:
 *
 *   1. Scan the file for `N G obj` definitions. Objects that carry a stream
 *      are recorded with their data, because some of those streams are
 *      /Type /ObjStm containers holding more objects — since PDF 1.5 most
 *      writers put the page tree and the annotations in one.
 *   2. Inflate every object stream and add the objects inside it.
 *   3. Walk the /Pages tree from the catalog to get pages in document order.
 *   4. Read each page's /Annots array. That is the authoritative page
 *      attribution — far more reliable than /P back-references (often absent)
 *      or object-number ordering.
 *   5. Parse each annotation dictionary and thread replies under /IRT.
 *
 * The cross-reference table is deliberately not consulted. Damaged and
 * incrementally-updated files are common, their xref is the first thing to go
 * stale, and scanning finds objects that a correct xref walk would miss. The
 * cost is that when an object number is defined twice this parser cannot ask
 * the xref which one is live, so it applies the rule that matches how files
 * grow: a plainly-written object beats a copy inside an object stream, and
 * later beats earlier.
 */

const PDFParser = (() => {

  /* A page tree deeper than this is not a document, it is a malformed or
   * hostile file. Real PDFs nest a handful of levels; the largest balanced
   * trees in the wild are single digits deep. */
  const MAX_PAGE_TREE_DEPTH = 256;

  const latin1Decoder = new TextDecoder('latin1');
  const utf8Decoder   = new TextDecoder('utf-8', { fatal: true });

  // ── Character classes ─────────────────────────────────────────
  // PDF divides characters into whitespace, delimiters, and "regular".
  const WHITESPACE = ' \t\r\n\f\u0000';
  const DELIMITERS = '()<>[]{}/%';

  const isWhitespace = (c) => c !== undefined && WHITESPACE.includes(c);
  const isDelimiter  = (c) => c !== undefined && DELIMITERS.includes(c);
  const isRegular    = (c) => c !== undefined && !isWhitespace(c) && !isDelimiter(c);

  /** Advance past whitespace and comments. */
  function skipWhitespace(s, i) {
    while (i < s.length) {
      if (isWhitespace(s[i])) { i++; continue; }
      if (s[i] === '%') {
        while (i < s.length && s[i] !== '\n' && s[i] !== '\r') i++;
        continue;
      }
      break;
    }
    return i;
  }

  // ── String decoding ───────────────────────────────────────────

  /**
   * Reinterpret a string of latin-1 characters — one per byte — as text.
   *
   * PDF strings carry no declared encoding. In practice they are either UTF-8
   * (increasingly) or PDFDocEncoding, which agrees with latin-1 over the range
   * that matters here. UTF-8 is self-validating, so trying it strictly and
   * falling back costs nothing and gets both right.
   */
  function recodeBytes(chars) {
    const bytes = new Uint8Array(chars.length);
    for (let i = 0; i < chars.length; i++) bytes[i] = chars.charCodeAt(i) & 0xff;
    try { return utf8Decoder.decode(bytes); } catch (_) { return chars; }
  }

  /** Decode `<48656C6C6F>` — including the UTF-16BE form Acrobat writes. */
  function decodeHexString(raw) {
    let hex = raw.replace(/[^0-9A-Fa-f]/g, '');
    if (hex.length % 2) hex += '0'; // the spec pads a trailing nibble with zero

    if (/^feff/i.test(hex)) {
      // UTF-16BE. Lone surrogates are emitted as-is so that a correctly
      // written surrogate pair recombines in the resulting JS string.
      let str = '';
      for (let i = 4; i + 3 < hex.length; i += 4) {
        str += String.fromCharCode(parseInt(hex.substr(i, 4), 16));
      }
      return str;
    }

    let chars = '';
    for (let i = 0; i < hex.length; i += 2) {
      chars += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
    }
    return recodeBytes(chars);
  }

  /** Decode `(hello)`, resolving backslash escapes and octal codes. */
  function decodeLiteralString(raw) {
    const body = raw.slice(1, -1);
    let out = '';

    for (let i = 0; i < body.length; i++) {
      const c = body[i];
      if (c !== '\\') { out += c; continue; }

      const n = body[++i];
      if (n === undefined) break;

      switch (n) {
        case 'n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 't': out += '\t'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case '(': out += '('; break;
        case ')': out += ')'; break;
        case '\\': out += '\\'; break;
        // A backslash at end of line is a line continuation: both the
        // backslash and the newline vanish.
        case '\r':
          if (body[i + 1] === '\n') i++;
          break;
        case '\n':
          break;
        default:
          if (n >= '0' && n <= '7') {
            let oct = n;
            while (oct.length < 3 && body[i + 1] >= '0' && body[i + 1] <= '7') {
              oct += body[++i];
            }
            out += String.fromCharCode(parseInt(oct, 8) & 0xff);
          } else {
            // An unrecognised escape drops the backslash and keeps the char.
            out += n;
          }
      }
    }

    return recodeBytes(out);
  }

  function decodePDFString(raw) {
    raw = (raw || '').trim();
    if (raw.startsWith('<') && raw.endsWith('>')) return decodeHexString(raw.slice(1, -1));
    if (raw.startsWith('(') && raw.endsWith(')')) return decodeLiteralString(raw);
    return raw;
  }

  // ── Object syntax ─────────────────────────────────────────────

  /**
   * Index just past the `)` that closes the literal string starting at `i`.
   *
   * Parentheses inside a literal string may be unescaped so long as they
   * balance — `(fix this (see above) please)` is one string, not two — so this
   * has to count depth rather than stop at the first `)`.
   */
  function endOfLiteralString(s, i) {
    let depth = 0;
    for (; i < s.length; i++) {
      const c = s[i];
      if (c === '\\') { i++; continue; }
      if (c === '(') depth++;
      else if (c === ')' && --depth === 0) return i + 1;
    }
    return s.length;
  }

  /** Index just past the matching close of the array or dict starting at `i`. */
  function endOfComposite(s, i, open, close) {
    let depth = 0;
    while (i < s.length) {
      if (s[i] === '(') { i = endOfLiteralString(s, i); continue; }
      if (s.startsWith(open, i)) { depth++; i += open.length; continue; }
      if (s.startsWith(close, i)) { i += close.length; if (--depth === 0) return i; continue; }
      i++;
    }
    return s.length;
  }

  /** `#41` in a name means `A`. */
  function decodeName(name) {
    return name.replace(/#([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }

  /**
   * Read one object starting at `i`; returns `[rawText, indexAfter]`.
   * The raw text is returned verbatim so the caller can decide how to read it.
   */
  function readValue(s, i) {
    i = skipWhitespace(s, i);
    if (i >= s.length) return null;
    const c = s[i];

    if (c === '(') { const e = endOfLiteralString(s, i); return [s.slice(i, e), e]; }
    if (c === '<' && s[i + 1] === '<') { const e = endOfComposite(s, i, '<<', '>>'); return [s.slice(i, e), e]; }
    if (c === '<') { const e = s.indexOf('>', i); const j = e === -1 ? s.length : e + 1; return [s.slice(i, j), j]; }
    if (c === '[') { const e = endOfComposite(s, i, '[', ']'); return [s.slice(i, e), e]; }
    if (c === '/') { let j = i + 1; while (isRegular(s[j])) j++; return [s.slice(i, j), j]; }

    let j = i;
    while (isRegular(s[j])) j++;
    if (j === i) return [s[i], i + 1]; // an unexpected delimiter; step over it

    const token = s.slice(i, j);
    if (/^\d+$/.test(token)) {
      // `12 0 R` is one value, not three.
      const m = /^\s+(\d+)\s+R(?![^\s()<>[\]{}/%])/.exec(s.slice(j));
      if (m) return [`${token} ${m[1]} R`, j + m[0].length];
    }
    return [token, j];
  }

  /**
   * The top-level entries of a dictionary.
   *
   * This exists instead of a regex per key because a regex cannot tell the
   * difference between the `/T` that starts an author name and the `/T` in
   * `/Type`, nor between a `/Contents` key and the characters `/Contents`
   * appearing inside somebody's comment text.
   */
  function parseDict(body) {
    const entries = new Map();
    let i = body.indexOf('<<');
    if (i === -1) return entries;
    i += 2;

    while (i < body.length) {
      i = skipWhitespace(body, i);
      if (i >= body.length || body.startsWith('>>', i)) break;

      if (body[i] !== '/') {
        const stray = readValue(body, i);
        if (!stray || stray[1] <= i) break;
        i = stray[1];
        continue;
      }

      let j = i + 1;
      while (isRegular(body[j])) j++;
      const key = decodeName(body.slice(i + 1, j));

      const value = readValue(body, j);
      if (!value || value[1] <= j) break;
      // First definition wins, mirroring how readers treat a duplicated key.
      if (!entries.has(key)) entries.set(key, value[0]);
      i = value[1];
    }

    return entries;
  }

  function extractDictValue(dict, key) {
    return parseDict(dict).get(key) ?? null;
  }

  // ── Date parsing ──────────────────────────────────────────────

  /**
   * `D:YYYYMMDDHHmmSSOHH'mm'` — the trailing UTC offset matters. Dropping it
   * reads every timestamp as local time, which is silently wrong by up to
   * fourteen hours and shows as the wrong day for anything near midnight.
   */
  function parsePDFDate(raw) {
    if (!raw) return null;
    const s = String(raw).trim().replace(/^D:/, '');
    const m = s.match(
      /^(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:(Z)|([+-])(\d{2})'?(\d{2})?'?)?/,
    );
    if (!m) return null;

    const [, year, month, day, hour, minute, second, zulu, sign, offHour, offMin] = m;
    const parts = [
      Number(year), Number(month || 1) - 1, Number(day || 1),
      Number(hour || 0), Number(minute || 0), Number(second || 0),
    ];

    let dt;
    if (zulu || sign) {
      const offset = sign
        ? (sign === '-' ? -1 : 1) * (Number(offHour || 0) * 60 + Number(offMin || 0))
        : 0;
      dt = new Date(Date.UTC(...parts) - offset * 60_000);
    } else {
      // No offset means local time, per the spec.
      dt = new Date(...parts);
    }
    return isNaN(dt) ? null : dt;
  }

  // ── Object table ──────────────────────────────────────────────

  /** Find `keyword` at `from` or later, not as part of a longer word. */
  function findKeyword(text, keyword, from) {
    const re = new RegExp(`(?<![A-Za-z])${keyword}(?![A-Za-z])`, 'g');
    re.lastIndex = from;
    const m = re.exec(text);
    return m ? m.index : -1;
  }

  /**
   * The same, but stepping over literal strings.
   *
   * A comment reading "this endobj thing again" is ordinary text, and a scan
   * that does not know it is inside a string ends the object in the middle of
   * it and loses the comment.
   */
  function findKeywordOutsideStrings(text, keyword, from) {
    let i = from;
    while (i < text.length) {
      if (text[i] === '(') { i = endOfLiteralString(text, i); continue; }
      if (text.startsWith(keyword, i) &&
          !isRegular(text[i - 1]) && !isRegular(text[i + keyword.length])) {
        return i;
      }
      i++;
    }
    return -1;
  }

  /**
   * Scan the file for object definitions.
   *
   * Stream data is skipped over rather than searched, which matters more than
   * it sounds: compressed bytes are arbitrary and will eventually contain the
   * sequence `endobj`, or worse `3 0 obj`, and a scan that does not know where
   * a stream ends will truncate an object at the first and let the second
   * overwrite a real page.
   *
   * Returns `{ objs, streams }` — object bodies by number, and every stream
   * object's dictionary plus the byte range of its data.
   */
  function scanObjects(text) {
    const objs = {};
    const streams = [];
    const re = /(\d+)\s+(\d+)\s+obj(?![A-Za-z])/g;
    let m;

    while ((m = re.exec(text)) !== null) {
      const objNum = m[1];
      const start = re.lastIndex;

      // `stream` only counts where the syntax allows one: immediately after
      // the object's dictionary. Searching for the keyword anywhere in the
      // object finds it inside somebody's comment text instead.
      let streamAt = -1;
      const dictStart = skipWhitespace(text, start);
      if (text.startsWith('<<', dictStart)) {
        const after = skipWhitespace(text, endOfComposite(text, dictStart, '<<', '>>'));
        if (text.startsWith('stream', after) && !isRegular(text[after + 'stream'.length])) {
          streamAt = after;
        }
      }

      if (streamAt === -1) {
        const endObjAt = findKeywordOutsideStrings(text, 'endobj', start);
        const end = endObjAt === -1 ? text.length : endObjAt;
        objs[objNum] = text.slice(start, end).trim();
        re.lastIndex = endObjAt === -1 ? text.length : endObjAt + 'endobj'.length;
        continue;
      }

      const dict = text.slice(start, streamAt).trim();
      objs[objNum] = dict;

      // The stream keyword is followed by CRLF or LF, never by CR alone.
      let dataStart = streamAt + 'stream'.length;
      if (text[dataStart] === '\r') dataStart++;
      if (text[dataStart] === '\n') dataStart++;

      const dataEnd = findStreamEnd(text, dict, dataStart);
      streams.push({ objNum, dict, dataStart, dataEnd });

      const after = findKeyword(text, 'endobj', dataEnd);
      re.lastIndex = after === -1 ? dataEnd : after + 'endobj'.length;
    }

    return { objs, streams };
  }

  /**
   * Where a stream's data ends.
   *
   * /Length is the authoritative answer but is often an indirect reference and
   * is often simply wrong in damaged files, so it is used only when it lands
   * exactly on an `endstream`. Otherwise fall back to searching for one.
   */
  function findStreamEnd(text, dict, dataStart) {
    const declared = parseDict(dict).get('Length');
    if (/^\d+$/.test(declared || '')) {
      const candidate = dataStart + Number(declared);
      if (candidate <= text.length &&
          text.startsWith('endstream', skipWhitespace(text, candidate))) {
        return candidate;
      }
    }

    let end = findKeyword(text, 'endstream', dataStart);
    if (end === -1) return text.length;
    // The EOL immediately before `endstream` is a delimiter, not data.
    if (text[end - 1] === '\n') end--;
    if (text[end - 1] === '\r') end--;
    return end;
  }

  // ── Compressed object streams ─────────────────────────────────

  /**
   * Inflate zlib or raw-deflate data using the platform's own decompressor.
   * `DecompressionStream` is in the popup and in Node alike, so this needs no
   * bundled inflate implementation.
   */
  async function inflate(bytes) {
    for (const format of ['deflate', 'deflate-raw']) {
      try {
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      } catch (_) { /* try the next framing */ }
    }
    return null;
  }

  /** The declared filters of a stream, as a list of names. */
  function streamFilters(dictEntries) {
    const raw = dictEntries.get('Filter');
    if (!raw) return [];
    return (raw.match(/\/([^\s/[\]<>(){}%]+)/g) || []).map((n) => n.slice(1));
  }

  /** Decoded bytes of a stream, or null if this parser cannot decode it. */
  async function decodeStream(bytes, dictEntries) {
    const filters = streamFilters(dictEntries);
    if (filters.length === 0) return bytes;
    if (filters.length > 1) return null; // filter chains are not worth guessing at
    if (filters[0] !== 'FlateDecode' && filters[0] !== 'Fl') return null;

    // A predictor means the inflated bytes still need un-filtering row by row.
    // Object streams essentially never use one; cross-reference streams, which
    // this parser does not read, essentially always do.
    const parms = dictEntries.get('DecodeParms') || '';
    const predictor = parms.match(/\/Predictor\s+(\d+)/);
    if (predictor && Number(predictor[1]) > 1) return null;

    return inflate(bytes);
  }

  /**
   * Unpack every /Type /ObjStm container into `objs`.
   *
   * An object stream is a header of `objNum offset` integer pairs followed by
   * that many object bodies, all offsets relative to /First. Objects already
   * defined outside a stream are left alone: see the note at the top of this
   * file about which definition wins.
   *
   * Returns the number of object streams that could not be decoded, so the
   * caller can tell "this file has no comments" apart from "this file could
   * not be read".
   */
  async function expandObjectStreams(streams, objs, allBytes) {
    let unreadable = 0;

    for (const stream of streams) {
      const entries = parseDict(stream.dict);
      if (entries.get('Type') !== '/ObjStm') continue;

      const raw = allBytes.subarray(stream.dataStart, stream.dataEnd);
      const data = await decodeStream(raw, entries);
      if (!data) { unreadable++; continue; }

      const count = Number(entries.get('N'));
      const first = Number(entries.get('First'));
      if (!Number.isInteger(count) || !Number.isInteger(first) || first < 0) {
        unreadable++;
        continue;
      }

      const text = latin1Decoder.decode(data);
      const header = text.slice(0, first).trim();
      const numbers = header ? header.split(/\s+/).map(Number) : [];

      for (let k = 0; k < count; k++) {
        const objNum = numbers[2 * k];
        const offset = numbers[2 * k + 1];
        if (!Number.isFinite(objNum) || !Number.isFinite(offset)) break;

        // Each body runs to the start of the next one, or to the end.
        const nextOffset = numbers[2 * k + 3];
        const from = first + offset;
        const to = Number.isFinite(nextOffset) ? first + nextOffset : text.length;
        if (from >= text.length) break;

        const key = String(objNum);
        if (!(key in objs)) objs[key] = text.slice(from, Math.min(to, text.length)).trim();
      }
    }

    return unreadable;
  }

  // ── Resolve indirect ref "N G R" → object body ───────────────
  function resolveRef(token, objs) {
    const m = token && token.match(/^(\d+)\s+\d+\s+R$/);
    return (m && objs[m[1]]) ? objs[m[1]] : null;
  }

  /** The object numbers named by `12 0 R` references inside a raw array. */
  function refsIn(raw) {
    return (raw.match(/(\d+)\s+\d+\s+R/g) || []).map((r) => r.match(/^(\d+)/)[1]);
  }

  // ── Collect page object numbers in tree order ─────────────────

  /**
   * Walk the /Pages tree for the real page order.
   *
   * The visited set and the depth cap are not defensive decoration: the input
   * is arbitrary files from the open web, and a /Kids entry that points back
   * at its own parent — corrupt or deliberate — used to recurse until the
   * stack was exhausted and the popup showed an error instead of the comments.
   */
  function collectPageObjNums(objs) {
    const dicts = new Map();
    const dictOf = (objNum) => {
      if (!dicts.has(objNum)) dicts.set(objNum, parseDict(objs[objNum] || ''));
      return dicts.get(objNum);
    };

    const isPage = (objNum) => dictOf(objNum).get('Type') === '/Page';

    let rootPagesObjNum = null;
    for (const objNum of Object.keys(objs)) {
      const d = dictOf(objNum);
      if (d.get('Type') !== '/Catalog') continue;
      const pagesRef = (d.get('Pages') || '').match(/^(\d+)\s+\d+\s+R$/);
      if (pagesRef) { rootPagesObjNum = pagesRef[1]; break; }
    }

    const pageNums = [];
    const visited = new Set();

    function walk(objNum, depth) {
      if (depth > MAX_PAGE_TREE_DEPTH) return;
      if (visited.has(objNum)) return;
      visited.add(objNum);

      const body = objs[objNum];
      if (!body) return;

      if (isPage(objNum)) { pageNums.push(objNum); return; }

      const kids = dictOf(objNum).get('Kids');
      if (!kids) return;
      for (const kid of refsIn(kids)) walk(kid, depth + 1);
    }

    if (rootPagesObjNum) walk(rootPagesObjNum, 0);

    if (pageNums.length === 0) {
      // No catalog, or a page tree too broken to walk. Object numbers are a
      // poor proxy for page order but they are better than no pages at all.
      Object.keys(objs)
        .filter(isPage)
        .sort((a, b) => Number(a) - Number(b))
        .forEach((n) => pageNums.push(n));
    }

    return pageNums;
  }

  // ── Build annotation→page map by walking page /Annots arrays ─
  // Returns { annotObjNum → 1-based page number }
  function buildAnnotPageMap(pageObjNums, objs) {
    const map = {};

    pageObjNums.forEach((pageObjNum, idx) => {
      const pageNum = idx + 1;
      const body = objs[pageObjNum];
      if (!body) return;

      let annots = parseDict(body).get('Annots');
      if (!annots) return;

      // /Annots may be the array itself or an indirect reference to one.
      if (/^\d+\s+\d+\s+R$/.test(annots)) {
        const resolved = resolveRef(annots, objs);
        if (!resolved) return;
        annots = resolved;
      }

      for (const annotObjNum of refsIn(annots)) {
        if (annotObjNum === pageObjNum) continue; // a page is not its own annotation
        if (!(annotObjNum in map)) map[annotObjNum] = pageNum;
      }
    });

    return map;
  }

  // ── Parse one annotation dict ─────────────────────────────────
  const COMMENT_TYPES = [
    'Text', 'FreeText', 'Highlight', 'Underline', 'StrikeOut',
    'Ink', 'Stamp', 'Caret', 'Square', 'Circle',
  ];
  const COMMENT_TYPE_SET = new Set(COMMENT_TYPES);
  // Used to sweep up annotations no page lists. Built from the same array, so
  // the two can no longer disagree about whether a Square is a comment.
  const COMMENT_SUBTYPE_RE = new RegExp(`/Subtype\\s*/\\s*(?:${COMMENT_TYPES.join('|')})(?![A-Za-z])`);

  function parseAnnot(objNum, body) {
    const dict = parseDict(body || '');

    const subtypeRaw = dict.get('Subtype');
    const subtype = subtypeRaw && subtypeRaw.startsWith('/') ? subtypeRaw.slice(1) : 'Unknown';
    if (!COMMENT_TYPE_SET.has(subtype)) return null;

    const contents = decodeOrEmpty(dict.get('Contents'));
    const author   = decodeOrEmpty(dict.get('T'));
    const subject  = decodeOrEmpty(dict.get('Subj'));

    const dateRaw = dict.get('M') || dict.get('CreationDate');
    const date = dateRaw ? parsePDFDate(decodePDFString(dateRaw)) : null;

    const irt = (dict.get('IRT') || '').match(/^(\d+)\s+\d+\s+R$/);

    // Require at least an author or content — skip purely visual marks
    if (!author && !contents) return null;

    return {
      id: objNum, subtype,
      author: author || 'Unknown', subject, contents,
      date, color: parseColor(dict.get('C')), inReplyTo: irt ? irt[1] : null,
      replies: [],
      page: null, // filled in after
    };
  }

  function decodeOrEmpty(raw) {
    return raw ? decodePDFString(raw).trim() : '';
  }

  /** `/C [1 0 0]` → `rgb(255,0,0)`. Grey and CMYK arrays also occur. */
  function parseColor(raw) {
    if (!raw || !raw.startsWith('[')) return null;
    const parts = raw.slice(1, -1).trim().split(/\s+/).map(Number);
    if (parts.some(Number.isNaN)) return null;

    const to255 = (v) => Math.round(Math.min(Math.max(v, 0), 1) * 255);
    if (parts.length === 3) return `rgb(${to255(parts[0])},${to255(parts[1])},${to255(parts[2])})`;
    if (parts.length === 1) { const g = to255(parts[0]); return `rgb(${g},${g},${g})`; }
    if (parts.length === 4) {
      const [c, m, y, k] = parts;
      return `rgb(${to255((1 - c) * (1 - k))},${to255((1 - m) * (1 - k))},${to255((1 - y) * (1 - k))})`;
    }
    return null;
  }

  // ── Thread builder ────────────────────────────────────────────
  function buildThreads(annotations) {
    const byId = {};
    const roots = [];
    for (const a of annotations) byId[a.id] = a;
    for (const a of annotations) {
      // A reply whose parent was filtered out stands on its own rather than
      // disappearing with it.
      if (a.inReplyTo && a.inReplyTo !== a.id && byId[a.inReplyTo]) {
        byId[a.inReplyTo].replies.push(a);
      } else {
        roots.push(a);
      }
    }
    return roots;
  }

  // ── Main parse entry ──────────────────────────────────────────

  /**
   * @param {ArrayBuffer} arrayBuffer the whole PDF
   * @returns {Promise<{threads: Array, unreadableObjectStreams: number}>}
   */
  async function parse(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    // Latin-1 is the only decoding under which every byte maps to a distinct
    // character and string offsets stay equal to byte offsets, which is what
    // lets the stream ranges found here index back into `bytes`.
    const text = latin1Decoder.decode(bytes);

    const { objs, streams } = scanObjects(text);
    const unreadableObjectStreams = await expandObjectStreams(streams, objs, bytes);

    // 1. Determine page order by walking the Pages tree
    const pageObjNums = collectPageObjNums(objs);

    // 2. Map every annotation objNum → page number via page /Annots arrays
    const annotPageMap = buildAnnotPageMap(pageObjNums, objs);

    // 3. Collect all unique annotation obj numbers (from page /Annots + fallback scan)
    const seen = new Set();
    const annotObjNums = [];

    // Primary: anything that appeared in a page's /Annots array
    for (const objNum of Object.keys(annotPageMap)) {
      if (!seen.has(objNum) && objs[objNum]) {
        seen.add(objNum);
        annotObjNums.push(objNum);
      }
    }

    // Fallback: scan all objects for comment subtypes not found via page walk
    for (const [objNum, body] of Object.entries(objs)) {
      if (!seen.has(objNum) && COMMENT_SUBTYPE_RE.test(body)) {
        seen.add(objNum);
        annotObjNums.push(objNum);
      }
    }

    // 4. Parse each annotation and attach page number
    const annotations = [];
    for (const objNum of annotObjNums) {
      const annot = parseAnnot(objNum, objs[objNum]);
      if (!annot) continue;
      annot.page = annotPageMap[objNum] ?? null;
      annotations.push(annot);
    }

    // 5. Sort by page then date
    annotations.sort((a, b) => {
      const pa = a.page ?? 9999, pb = b.page ?? 9999;
      if (pa !== pb) return pa - pb;
      return (a.date ?? 0) - (b.date ?? 0);
    });

    return { threads: buildThreads(annotations), unreadableObjectStreams };
  }

  return { parse, decodePDFString, parsePDFDate, extractDictValue };
})();

// The popup loads this file with a <script> tag; the export is for the tests,
// which run the same code under `node --test`.
if (typeof module !== 'undefined') module.exports = PDFParser;
