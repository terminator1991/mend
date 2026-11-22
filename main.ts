// mend — a small command line tool that applies a model-written edit to a tree
// of text files. The patch it reads may be a unified diff, a set of
// SEARCH/REPLACE blocks, a V4A patch, or JSON editor calls; the format is
// either named on the command line or detected from the patch text. Every
// edit in a patch is tried in order against the tree the earlier edits left
// behind, and either all of them land or none of them does. Run it as
// `node main.ts [--format=NAME] [--check] [--strict] [PATCH]`, with PATCH
// read from standard input when it is absent or `-`. Node 22, standard
// library only.
//
// When MAKEFUN_ENV_URL is set, this file hands the run over to runner.ts,
// which drives it through a trial instead; see the last lines of this file.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const KNOWN_FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A patch that cannot be read in its format: exit 2 with `error: parse <line>`. */
class ParseFault extends Error {
  readonly lineNo: number;
  constructor(lineNo: number) {
    super(`parse ${lineNo}`);
    this.lineNo = lineNo;
  }
}

/** One edit that could not be applied: exit 1 with `error: <code> <path>`. */
class EditFault extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    super(`${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** Split patch text into lines: split at \n, one trailing \r off each line,
 * and drop the empty piece after a final \n. */
function splitPatchText(text: string): string[] {
  if (text === '') return [];
  const out = text.split('\n');
  if (text.endsWith('\n')) out.pop();
  return out.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, not absolute, holds no backslash,
 * and none of its slash-separated segments is empty, `.` or `..`. */
function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const stripTrailWs = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

/** One file's text, taken apart the way section 3 of the spec describes: its
 * line break is CRLF when its first line feed follows a carriage return,
 * its lines are the text split at that break, and it ends with a line break
 * exactly when its text ends with that break. */
interface FileDoc {
  eol: string;
  lines: string[];
  endsWithBreak: boolean;
}

function parseDoc(text: string): FileDoc {
  if (text === '') return { eol: '\n', lines: [], endsWithBreak: false };
  const firstNl = text.indexOf('\n');
  const eol = firstNl > 0 && text[firstNl - 1] === '\r' ? '\r\n' : '\n';
  const endsWithBreak = text.endsWith(eol);
  const lines = text.split(eol);
  if (endsWithBreak) lines.pop();
  return { eol, lines, endsWithBreak };
}

function renderDoc(doc: FileDoc): string {
  if (doc.lines.length === 0) return '';
  return doc.lines.join(doc.eol) + (doc.endsWithBreak ? doc.eol : '');
}

/** The tree as the edits leave it. `current` holds every path an edit has
 * touched (null means deleted); anything else is read from disk on demand
 * and remembered, so the original bytes are always at hand. */
class WorkTree {
  private readonly fromDisk = new Map<string, string | null>();
  readonly current = new Map<string, string | null>();

  original(p: string): string | null {
    if (!this.fromDisk.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.fromDisk.set(p, v);
    }
    return this.fromDisk.get(p) as string | null;
  }

  read(p: string): string | null {
    return this.current.has(p) ? (this.current.get(p) as string | null) : this.original(p);
  }

  write(p: string, text: string | null): void {
    this.current.set(p, text);
  }
}

type Edit = (tree: WorkTree) => void;

// ---------------------------------------------------------------------------
// Matching lines (spec section 5)
// ---------------------------------------------------------------------------

/** Do two lines count as equal at one tier? Tier 0 is exact; tier 1 ignores
 * trailing spaces and tabs on both sides; tier 2 ignores them on both ends. */
function linesEqualAt(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrailWs(a) === stripTrailWs(b);
  return stripBothWs(a) === stripBothWs(b);
}

/** Every 0-based position from `from` on where O's lines match the file's
 * lines at this tier; occurrences may overlap. */
function occurrencesAt(oldLines: string[], fileLines: string[], tier: number, from: number): number[] {
  const hits: number[] = [];
  const last = fileLines.length - oldLines.length;
  for (let i = Math.max(0, from); i <= last; i++) {
    let ok = true;
    for (let k = 0; k < oldLines.length; k++) {
      if (!linesEqualAt(oldLines[k] as string, fileLines[i + k] as string, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(i);
  }
  return hits;
}

/** The first tier at which O occurs at least once (from `from` on), with its
 * positions; null when it occurs at no tier. `--strict` tries tier 0 only. */
function locateOld(
  oldLines: string[],
  fileLines: string[],
  from: number,
  strict: boolean,
): { tier: number; spots: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const spots = occurrencesAt(oldLines, fileLines, tier, from);
    if (spots.length > 0) return { tier, spots };
  }
  return null;
}

/** One line of a replacement: a context line, taken from the file itself, or
 * a fresh line, written as the patch has it (re-indented at tier 2). */
interface NewPiece {
  fromFile: boolean;
  oldIndex: number; // index into O, for context lines
  text: string;
}

/** Build the lines a matched block is replaced with. Context lines come from
 * the file's own matched lines; at tier 2 every other line is re-indented:
 * its leading spaces and tabs are swapped from the patch's first old line
 * to the file's first matched line, when it starts with that prefix. */
function buildReplacement(
  pieces: NewPiece[],
  oldLines: string[],
  fileLines: string[],
  at: number,
  tier: number,
): string[] {
  const out: string[] = [];
  const fileLead = tier === 2 ? leadWs(fileLines[at] as string) : '';
  const patchLead = tier === 2 ? leadWs(oldLines[0] as string) : '';
  for (const piece of pieces) {
    if (piece.fromFile) {
      out.push(fileLines[at + piece.oldIndex] as string);
      continue;
    }
    const t = piece.text;
    if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(patchLead)) {
      out.push(fileLead + t.slice(patchLead.length));
    } else {
      out.push(t);
    }
  }
  return out;
}

/** Re-indent a lone replacement line at tier 2 (used by SEARCH/REPLACE,
 * which has no context lines). */
function reindentLine(t: string, fileLead: string, patchLead: string): string {
  if (t === '' || t.trim() === '' || !t.startsWith(patchLead)) return t;
  return fileLead + t.slice(patchLead.length);
}

// ---------------------------------------------------------------------------
// Unified diffs (spec section 6)
// ---------------------------------------------------------------------------

interface HunkLine {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  /** A `\` line follows this body line (no newline at end of file). */
  noNewlineAfter: boolean;
  /** The patch line this body line came from was blank. */
  fromBlankLine: boolean;
}

interface Hunk {
  oldStart: number;
  body: HunkLine[];
}

interface DiffSection {
  oldPath: string | null;
  newPath: string | null;
  fromPair: boolean;
  gitOld: string | null;
  gitNew: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const GIT_DIFF_HEAD = /^diff --git a\/(.+) b\/(.+)$/;

/** The path after `--- ` or `+++ `: the text past the four characters, up to
 * the first tab, with surrounding spaces removed. */
function headerPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  return (tab < 0 ? rest : rest.slice(0, tab)).trim();
}

/** A leading `a/` or `b/` is removed from either path. */
function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function trimTrailingBlankBody(hunk: Hunk): void {
  while (hunk.body.length > 0 && (hunk.body[hunk.body.length - 1] as HunkLine).fromBlankLine) {
    hunk.body.pop();
  }
}

/** Read every section of a unified diff. A section starts at a `diff --git`
 * line or at a `--- ` line followed by a `+++ ` line; hunks start at `@@`
 * headers; everything else outside a hunk body is ignored. */
function parseUnified(lines: string[]): DiffSection[] {
  const sections: DiffSection[] = [];
  let current: DiffSection | null = null;
  let hunk: Hunk | null = null;
  let i = 0;

  const finishHunk = (): void => {
    if (hunk !== null && current !== null) {
      trimTrailingBlankBody(hunk);
      current.hunks.push(hunk);
    }
    hunk = null;
  };

  const startSection = (): DiffSection => {
    const s: DiffSection = {
      oldPath: null,
      newPath: null,
      fromPair: false,
      gitOld: null,
      gitNew: null,
      isCreate: false,
      isDelete: false,
      hunks: [],
    };
    sections.push(s);
    return s;
  };

  while (i < lines.length) {
    const line = lines[i] as string;
    if (hunk !== null) {
      // Inside a hunk body: it ends at a `diff --git` line, at a `--- ` line
      // followed by a `+++ ` line, or at the first line that is none of
      // ` `, `-`, `+`, `\` and not empty.
      if (line.startsWith('diff --git ') || (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
        finishHunk();
        continue;
      }
      if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\') {
        if (line[0] === '\\') {
          const last = hunk.body[hunk.body.length - 1];
          if (last !== undefined) last.noNewlineAfter = true;
        } else {
          const kind = line === '' || line[0] === ' ' ? 'ctx' : line[0] === '-' ? 'old' : 'new';
          hunk.body.push({
            kind,
            text: line === '' ? '' : line.slice(1),
            noNewlineAfter: false,
            fromBlankLine: isBlank(line),
          });
        }
        i++;
        continue;
      }
      finishHunk();
      continue;
    }

    if (line.startsWith('diff --git ')) {
      const m = GIT_DIFF_HEAD.exec(line);
      if (m === null) throw new ParseFault(i + 1);
      current = startSection();
      current.gitOld = m[1] as string;
      current.gitNew = m[2] as string;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (current !== null && current.fromPair) current = startSection();
      if (current === null) current = startSection();
      current.oldPath = stripAB(headerPath(line));
      current.newPath = stripAB(headerPath(lines[i + 1] as string));
      current.fromPair = true;
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_HEAD.exec(line);
      if (m === null) throw new ParseFault(i + 1);
      if (current === null) throw new ParseFault(i + 1);
      hunk = { oldStart: Number(m[1]), body: [] };
      i++;
      continue;
    }
    if (current !== null && current.hunks.length === 0) {
      // Still in the section's header.
      if (line.startsWith('--- ')) throw new ParseFault(i + 2);
      if (line.startsWith('rename from ')) current.oldPath = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) current.newPath = line.slice('rename to '.length).trim();
      else if (line === 'new file mode' || line.startsWith('new file mode ')) current.isCreate = true;
      else if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) current.isDelete = true;
      // `index`, `old mode`, `new mode`, `similarity index`,
      // `dissimilarity index`, `Index:` and anything else: ignored.
      i++;
      continue;
    }
    // Prose or anything else outside a body: ignored.
    i++;
  }
  finishHunk();
  return sections;
}

/** The last body line that is a context or `+` line carries a `\` after it
 * when the result has no line break at the end. */
function lastNewishNoNewline(hunk: Hunk): boolean {
  for (let k = hunk.body.length - 1; k >= 0; k--) {
    const e = hunk.body[k] as HunkLine;
    if (e.kind === 'ctx' || e.kind === 'new') return e.noNewlineAfter;
  }
  return false;
}

/** Apply one section's hunks in order to a file's lines. `drift` carries the
 * running change in line count so the next hunk's `@@` number still lands
 * near its match. */
function applyHunks(doc: FileDoc, hunks: Hunk[], path: string, strict: boolean): FileDoc {
  let cur: FileDoc = { eol: doc.eol, lines: [...doc.lines], endsWithBreak: doc.endsWithBreak };
  let drift = 0;
  for (const hunk of hunks) {
    const oldLines: string[] = [];
    const pieces: NewPiece[] = [];
    for (const e of hunk.body) {
      if (e.kind === 'ctx') {
        oldLines.push(e.text);
        pieces.push({ fromFile: true, oldIndex: oldLines.length - 1, text: '' });
      } else if (e.kind === 'old') {
        oldLines.push(e.text);
      } else {
        pieces.push({ fromFile: false, oldIndex: -1, text: e.text });
      }
    }
    if (oldLines.length === 0) {
      let at = hunk.oldStart + drift;
      if (at < 0) at = 0;
      if (at > cur.lines.length) at = cur.lines.length;
      const fresh = pieces.map((p) => p.text);
      const wasAtEnd = at === cur.lines.length;
      cur = {
        eol: cur.eol,
        lines: [...cur.lines.slice(0, at), ...fresh, ...cur.lines.slice(at)],
        endsWithBreak: wasAtEnd ? !lastNewishNoNewline(hunk) : cur.endsWithBreak,
      };
      drift += fresh.length;
      continue;
    }
    const found = locateOld(oldLines, cur.lines, 0, strict);
    if (found === null) throw new EditFault('no-match', path);
    const target = hunk.oldStart - 1 + drift;
    let at = found.spots[0] as number;
    let best = Math.abs(at - target);
    for (const spot of found.spots) {
      const dist = Math.abs(spot - target);
      if (dist < best) {
        at = spot;
        best = dist;
      }
    }
    const replacement = buildReplacement(pieces, oldLines, cur.lines, at, found.tier);
    const runsToEnd = at + oldLines.length === cur.lines.length;
    cur = {
      eol: cur.eol,
      lines: [...cur.lines.slice(0, at), ...replacement, ...cur.lines.slice(at + oldLines.length)],
      endsWithBreak: runsToEnd ? !lastNewishNoNewline(hunk) : cur.endsWithBreak,
    };
    drift += replacement.length - oldLines.length;
  }
  return cur;
}

/** One unified-diff section as a single edit. `moves` collects the moves
 * that succeeded, so the final report can print them as `R` lines. */
function unifiedEdit(
  section: DiffSection,
  strict: boolean,
  moves: { oldPath: string; newPath: string }[],
): Edit {
  const oldPath = section.oldPath ?? section.gitOld;
  const newPath = section.newPath ?? section.gitNew;
  const isCreate = oldPath === '/dev/null' || section.isCreate;
  const isDelete = !isCreate && (newPath === '/dev/null' || section.isDelete);
  const isMove = !isCreate && !isDelete && oldPath !== null && newPath !== null && oldPath !== newPath;
  const path = isCreate || isMove ? (newPath as string) : (oldPath as string);
  return (tree) => {
    if (isCreate) {
      const target = newPath as string;
      if (!isSafePath(target)) throw new EditFault('unsafe', target);
      if (tree.read(target) !== null) throw new EditFault('exists', target);
      const added: string[] = [];
      let lastNoNl = false;
      for (const hunk of section.hunks) {
        for (const e of hunk.body) {
          if (e.kind === 'new') {
            added.push(e.text);
            lastNoNl = e.noNewlineAfter;
          }
        }
      }
      tree.write(target, added.length === 0 ? '' : added.join('\n') + (lastNoNl ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const target = oldPath as string;
      if (!isSafePath(target)) throw new EditFault('unsafe', target);
      if (tree.read(target) === null) throw new EditFault('missing', target);
      tree.write(target, null);
      return;
    }
    if (isMove) {
      const from = oldPath as string;
      const to = newPath as string;
      if (!isSafePath(from)) throw new EditFault('unsafe', from);
      if (!isSafePath(to)) throw new EditFault('unsafe', to);
      const before = tree.read(from);
      if (before === null) throw new EditFault('missing', from);
      if (tree.read(to) !== null) throw new EditFault('exists', to);
      const after = renderDoc(applyHunks(parseDoc(before), section.hunks, from, strict));
      tree.write(to, after);
      tree.write(from, null);
      moves.push({ oldPath: from, newPath: to });
      return;
    }
    const target = oldPath as string;
    if (!isSafePath(target)) throw new EditFault('unsafe', target);
    const before = tree.read(target);
    if (before === null) throw new EditFault('missing', target);
    tree.write(target, renderDoc(applyHunks(parseDoc(before), section.hunks, target, strict)));
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (spec section 7)
// ---------------------------------------------------------------------------

interface SearchBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

/** Read every SEARCH/REPLACE block. The path is the nearest line before the
 * `<<<<<<< SEARCH` line, after the previous block, that is not blank and
 * does not start with three backticks; a block with no such line takes the
 * previous block's path. */
function parseSearchReplace(lines: string[]): SearchBlock[] {
  const blocks: SearchBlock[] = [];
  let prevPath: string | null = null;
  let scanFrom = 0;
  let i = 0;
  while (i < lines.length) {
    if ((lines[i] as string).trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchAt = i;
    let path: string | null = null;
    for (let j = searchAt - 1; j >= scanFrom; j--) {
      const trimmed = (lines[j] as string).trim();
      if (trimmed === '' || trimmed.startsWith('```')) continue;
      path = trimmed;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new ParseFault(searchAt + 1);
    let sep = -1;
    let end = -1;
    for (let j = searchAt + 1; j < lines.length; j++) {
      const t = (lines[j] as string).trimEnd();
      if (t === '=======') {
        sep = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (sep < 0) throw new ParseFault(searchAt + 1);
    for (let j = sep + 1; j < lines.length; j++) {
      if ((lines[j] as string).trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end < 0) throw new ParseFault(searchAt + 1);
    blocks.push({
      path,
      oldLines: lines.slice(searchAt + 1, sep),
      newLines: lines.slice(sep + 1, end),
    });
    prevPath = path;
    scanFrom = end + 1;
    i = end + 1;
  }
  return blocks;
}

function searchReplaceEdit(block: SearchBlock, strict: boolean): Edit {
  return (tree) => {
    if (!isSafePath(block.path)) throw new EditFault('unsafe', block.path);
    if (block.oldLines.length === 0) {
      if (tree.read(block.path) !== null) throw new EditFault('exists', block.path);
      tree.write(block.path, block.newLines.length === 0 ? '' : block.newLines.join('\n') + '\n');
      return;
    }
    const before = tree.read(block.path);
    if (before === null) throw new EditFault('missing', block.path);
    const doc = parseDoc(before);
    const found = locateOld(block.oldLines, doc.lines, 0, strict);
    if (found === null) throw new EditFault('no-match', block.path);
    if (found.spots.length > 1) throw new EditFault('ambiguous', block.path);
    const at = found.spots[0] as number;
    let replacement = block.newLines;
    if (found.tier === 2) {
      const fileLead = leadWs(doc.lines[at] as string);
      const patchLead = leadWs(block.oldLines[0] as string);
      replacement = block.newLines.map((t) => reindentLine(t, fileLead, patchLead));
    }
    const lines = [...doc.lines.slice(0, at), ...replacement, ...doc.lines.slice(at + block.oldLines.length)];
    tree.write(block.path, renderDoc({ eol: doc.eol, lines, endsWithBreak: doc.endsWithBreak }));
  };
}

// ---------------------------------------------------------------------------
// V4A patches (spec section 8)
// ---------------------------------------------------------------------------

interface V4aChunk {
  anchor: string | null;
  endOfFile: boolean;
  body: HunkLine[];
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  addLines: string[];
  chunks: V4aChunk[];
}

const V4A_ADD = '*** Add File: ';
const V4A_DELETE = '*** Delete File: ';
const V4A_UPDATE = '*** Update File: ';
const V4A_MOVE = '*** Move to: ';

function isV4aSectionStart(line: string): boolean {
  return line.startsWith(V4A_ADD) || line.startsWith(V4A_DELETE) || line.startsWith(V4A_UPDATE);
}

function parseV4a(lines: string[]): V4aSection[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault(1);
  if ((lines[first] as string).trim() !== '*** Begin Patch') throw new ParseFault(first + 1);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!isBlank(lines[k] as string)) {
      last = k;
      break;
    }
  }
  if ((lines[last] as string).trim() !== '*** End Patch') throw new ParseFault(lines.length + 1);

  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i] as string;
    if (isBlank(line)) {
      i++;
      continue;
    }
    if (line.startsWith(V4A_ADD)) {
      const path = line.slice(V4A_ADD.length).trim();
      const added: { text: string; blank: boolean }[] = [];
      i++;
      while (i < last) {
        const l = lines[i] as string;
        if (isV4aSectionStart(l) || l.trim() === '*** End Patch') break;
        if (l.startsWith('+')) {
          added.push({ text: l.slice(1), blank: false });
          i++;
        } else if (isBlank(l)) {
          added.push({ text: '', blank: true });
          i++;
        } else {
          throw new ParseFault(i + 1);
        }
      }
      while (added.length > 0 && (added[added.length - 1] as { blank: boolean }).blank) added.pop();
      sections.push({ kind: 'add', path, moveTo: null, addLines: added.map((a) => a.text), chunks: [] });
      continue;
    }
    if (line.startsWith(V4A_DELETE)) {
      const path = line.slice(V4A_DELETE.length).trim();
      i++;
      while (i < last) {
        const l = lines[i] as string;
        if (isV4aSectionStart(l) || l.trim() === '*** End Patch') break;
        if (isBlank(l)) {
          i++;
          continue;
        }
        throw new ParseFault(i + 1);
      }
      sections.push({ kind: 'delete', path, moveTo: null, addLines: [], chunks: [] });
      continue;
    }
    if (line.startsWith(V4A_UPDATE)) {
      const path = line.slice(V4A_UPDATE.length).trim();
      const updateAt = i;
      const section: V4aSection = { kind: 'update', path, moveTo: null, addLines: [], chunks: [] };
      i++;
      let chunk: V4aChunk | null = null;
      let seenBody = false;
      let afterEndOfFile = false;
      const finishChunk = (): void => {
        if (chunk !== null) {
          while (chunk.body.length > 0 && (chunk.body[chunk.body.length - 1] as HunkLine).fromBlankLine) {
            chunk.body.pop();
          }
          section.chunks.push(chunk);
        }
        chunk = null;
      };
      while (i < last) {
        const l = lines[i] as string;
        if (isV4aSectionStart(l) || l.trim() === '*** End Patch') break;
        if (chunk === null && !seenBody && l.startsWith(V4A_MOVE)) {
          section.moveTo = l.slice(V4A_MOVE.length).trim();
          i++;
          continue;
        }
        if (l.startsWith('@@')) {
          finishChunk();
          chunk = { anchor: l.slice(2).trim(), endOfFile: false, body: [] };
          seenBody = true;
          afterEndOfFile = false;
          i++;
          continue;
        }
        if (l.trim() === '*** End of File') {
          if (chunk === null) throw new ParseFault(i + 1);
          chunk.endOfFile = true;
          finishChunk();
          afterEndOfFile = true;
          i++;
          continue;
        }
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (chunk === null) {
            if (afterEndOfFile) throw new ParseFault(i + 1);
            chunk = { anchor: null, endOfFile: false, body: [] };
            seenBody = true;
          }
          const kind = l === '' || l[0] === ' ' ? 'ctx' : l[0] === '-' ? 'old' : 'new';
          (chunk as V4aChunk).body.push({
            kind,
            text: l === '' ? '' : l.slice(1),
            noNewlineAfter: false,
            fromBlankLine: isBlank(l),
          });
          i++;
          continue;
        }
        throw new ParseFault(i + 1);
      }
      finishChunk();
      if (section.chunks.length === 0 && section.moveTo === null) throw new ParseFault(updateAt + 1);
      sections.push(section);
      continue;
    }
    throw new ParseFault(i + 1);
  }
  return sections;
}

/** Apply one V4A chunk to a file's lines, with the cursor the section
 * carries. An anchored chunk first finds its anchor at or after the cursor;
 * the chunk then takes the first occurrence of its old lines at or after
 * the cursor, and the cursor moves to just past the lines written. */
function applyV4aChunk(
  doc: FileDoc,
  chunk: V4aChunk,
  cursor: number,
  path: string,
  strict: boolean,
): { doc: FileDoc; cursor: number } {
  let cur = cursor;
  if (chunk.anchor !== null && chunk.anchor !== '') {
    const anchorAt = [0, 1, 2].filter((t) => !strict || t === 0).reduce<number | null>((found, tier) => {
      if (found !== null) return found;
      for (let k = cur; k < doc.lines.length; k++) {
        if (linesEqualAt(chunk.anchor as string, doc.lines[k] as string, tier)) return k;
      }
      return null;
    }, null);
    if (anchorAt === null) throw new EditFault('no-match', path);
    cur = anchorAt + 1;
  }
  const oldLines: string[] = [];
  const pieces: NewPiece[] = [];
  for (const e of chunk.body) {
    if (e.kind === 'ctx') {
      oldLines.push(e.text);
      pieces.push({ fromFile: true, oldIndex: oldLines.length - 1, text: '' });
    } else if (e.kind === 'old') {
      oldLines.push(e.text);
    } else {
      pieces.push({ fromFile: false, oldIndex: -1, text: e.text });
    }
  }
  if (oldLines.length === 0) {
    const at = chunk.endOfFile ? doc.lines.length : cur;
    const fresh = pieces.map((p) => p.text);
    return {
      doc: { eol: doc.eol, lines: [...doc.lines.slice(0, at), ...fresh, ...doc.lines.slice(at)], endsWithBreak: doc.endsWithBreak },
      cursor: at + fresh.length,
    };
  }
  const found = locateOld(oldLines, doc.lines, cur, strict);
  if (found === null) throw new EditFault('no-match', path);
  let at = found.spots[0] as number;
  if (chunk.endOfFile) {
    const fitting = found.spots.filter((s) => s + oldLines.length === doc.lines.length);
    if (fitting.length === 0) throw new EditFault('no-match', path);
    at = fitting[0] as number;
  }
  const replacement = buildReplacement(pieces, oldLines, doc.lines, at, found.tier);
  return {
    doc: {
      eol: doc.eol,
      lines: [...doc.lines.slice(0, at), ...replacement, ...doc.lines.slice(at + oldLines.length)],
      endsWithBreak: doc.endsWithBreak,
    },
    cursor: at + replacement.length,
  };
}

function v4aEdit(
  section: V4aSection,
  strict: boolean,
  moves: { oldPath: string; newPath: string }[],
): Edit {
  return (tree) => {
    if (section.kind === 'add') {
      if (!isSafePath(section.path)) throw new EditFault('unsafe', section.path);
      if (tree.read(section.path) !== null) throw new EditFault('exists', section.path);
      tree.write(section.path, section.addLines.length === 0 ? '' : section.addLines.join('\n') + '\n');
      return;
    }
    if (section.kind === 'delete') {
      if (!isSafePath(section.path)) throw new EditFault('unsafe', section.path);
      if (tree.read(section.path) === null) throw new EditFault('missing', section.path);
      tree.write(section.path, null);
      return;
    }
    if (!isSafePath(section.path)) throw new EditFault('unsafe', section.path);
    if (section.moveTo !== null && !isSafePath(section.moveTo)) throw new EditFault('unsafe', section.moveTo);
    const before = tree.read(section.path);
    if (before === null) throw new EditFault('missing', section.path);
    if (section.moveTo !== null && tree.read(section.moveTo) !== null) throw new EditFault('exists', section.moveTo);
    let doc = parseDoc(before);
    let cursor = 0;
    for (const chunk of section.chunks) {
      const done = applyV4aChunk(doc, chunk, cursor, section.path, strict);
      doc = done.doc;
      cursor = done.cursor;
    }
    const after = renderDoc(doc);
    if (section.moveTo !== null) {
      tree.write(section.moveTo, after);
      tree.write(section.path, null);
      moves.push({ oldPath: section.path, newPath: section.moveTo });
    } else {
      tree.write(section.path, after);
    }
  };
}

// ---------------------------------------------------------------------------
// JSON edits (spec section 9)
// ---------------------------------------------------------------------------

/** One JSON edit object, or null when it is not a valid one. A wrong command
 * or a missing or mistyped key is a parse fault, reported by the caller. */
function jsonEditObject(value: unknown): Edit | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  const path = o.path as string;

  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text as string;
    return (tree) => {
      if (!isSafePath(path)) throw new EditFault('unsafe', path);
      if (tree.read(path) !== null) throw new EditFault('exists', path);
      tree.write(path, text);
    };
  }
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    (o.old_str as string) !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str as string;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      if (!isSafePath(path)) throw new EditFault('unsafe', path);
      const before = tree.read(path);
      if (before === null) throw new EditFault('missing', path);
      const firstNl = before.indexOf('\n');
      const crlf = firstNl > 0 && before[firstNl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const text = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = text.indexOf(old); k >= 0; k = text.indexOf(old, k + 1)) count++;
      if (count === 0) throw new EditFault('no-match', path);
      if (count > 1) throw new EditFault('ambiguous', path);
      const at = text.indexOf(old);
      const out = text.slice(0, at) + toLf(newStr) + text.slice(at + old.length);
      tree.write(path, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const atLine = o.insert_line as number;
    const added = splitPatchText(o.new_str as string);
    return (tree) => {
      if (!isSafePath(path)) throw new EditFault('unsafe', path);
      const before = tree.read(path);
      if (before === null) throw new EditFault('missing', path);
      const doc = parseDoc(before);
      if (atLine < 0 || atLine > doc.lines.length) throw new EditFault('no-match', path);
      const lines = [...doc.lines.slice(0, atLine), ...added, ...doc.lines.slice(atLine)];
      tree.write(path, renderDoc({ eol: doc.eol, lines, endsWithBreak: doc.endsWithBreak }));
    };
  }
  return null;
}

/** Read the JSON edits of a patch: either one JSON array of edit objects,
 * or JSON Lines with one edit object a line. */
function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault(1);
  const edits: Edit[] = [];
  if ((lines[first] as string).trimStart().startsWith('[')) {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new ParseFault(first + 1);
    }
    if (!Array.isArray(value)) throw new ParseFault(first + 1);
    for (const item of value) {
      const edit = jsonEditObject(item);
      if (edit === null) throw new ParseFault(first + 1);
      edits.push(edit);
    }
    return edits;
  }
  lines.forEach((line, idx) => {
    if (isBlank(line)) return;
    let edit: Edit | null = null;
    try {
      edit = jsonEditObject(JSON.parse(line));
    } catch {
      edit = null;
    }
    if (edit === null) throw new ParseFault(idx + 1);
    edits.push(edit);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Format detection (spec section 4) and the run itself (sections 1, 2, 10)
// ---------------------------------------------------------------------------

/** With `--format=auto` the format is the first of these that holds. */
function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if ((lines[first] as string).trim() === '*** Begin Patch') return 'v4a';
  const firstChar = (lines[first] as string).trimStart()[0];
  if (firstChar === '[' || firstChar === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

function byteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

interface RunResult {
  code: number;
  out: string[];
}

function run(argv: string[]): RunResult {
  let format: string | null = null;
  let checkOnly = false;
  let strict = false;
  const positionals: string[] = [];
  let optionsEnded = false;
  for (const arg of argv) {
    if (!optionsEnded && arg === '--') {
      optionsEnded = true;
    } else if (!optionsEnded && arg.startsWith('-') && arg !== '-') {
      if (arg.startsWith('--format=') && format === null && KNOWN_FORMATS.includes(arg.slice('--format='.length))) {
        format = arg.slice('--format='.length);
      } else if (arg === '--check' && !checkOnly) {
        checkOnly = true;
      } else if (arg === '--strict' && !strict) {
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      positionals.push(arg);
    }
  }
  if (positionals.length > 1) return { code: 2, out: ['error: usage'] };

  const patchArg = positionals.length === 0 || positionals[0] === '-' ? null : (positionals[0] as string);
  let patchText = '';
  try {
    patchText = readFileSync(patchArg ?? 0, 'utf8');
  } catch {
    if (patchArg !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatchText(patchText);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };

  let edits: Edit[];
  // Moves that succeeded, collected while the edits run, so the final
  // report can print them as `R` lines instead of a `D` plus an `A`.
  const runMoves: { oldPath: string; newPath: string }[] = [];
  try {
    if (kind === 'json') edits = parseJson(patchText, lines);
    else if (kind === 'unified') {
      edits = parseUnified(lines).map((s) => unifiedEdit(s, strict, runMoves));
    } else if (kind === 'search-replace') {
      edits = parseSearchReplace(lines).map((b) => searchReplaceEdit(b, strict));
    } else {
      edits = parseV4a(lines).map((s) => v4aEdit(s, strict, runMoves));
    }
    if (edits.length === 0) throw new ParseFault(1);
  } catch (e) {
    if (e instanceof ParseFault) return { code: 2, out: [`error: parse ${e.lineNo}`] };
    throw e;
  }

  const tree = new WorkTree();
  const failures: EditFault[] = [];
  for (const edit of edits) {
    const snapshot = new Map(tree.current);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof EditFault)) throw e;
      tree.current.clear();
      for (const [k, v] of snapshot) tree.current.set(k, v);
      failures.push(e);
    }
  }
  if (failures.length > 0) {
    return {
      code: 1,
      out: [...failures.map((f) => `error: ${f.code} ${f.path}`), `failed: ${failures.length} of ${edits.length} edits`],
    };
  }

  const rows: { key: string; text: string }[] = [];
  const covered = new Set<string>();
  const moves = runMoves;
  for (const move of moves) {
    const wasOld = tree.original(move.oldPath);
    const nowOld = tree.read(move.oldPath);
    const wasNew = tree.original(move.newPath);
    const nowNew = tree.read(move.newPath);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: move.newPath, text: `R ${move.oldPath} -> ${move.newPath}` });
      covered.add(move.oldPath);
      covered.add(move.newPath);
    }
  }
  for (const p of [...tree.current.keys()].sort(byteOrder)) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.current.get(p) as string | null;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  // Writes are a separate pass from the report: a path covered by an `R`
  // row still has to be moved on disk, it just gets no `D`/`A` row.
  if (!checkOnly) {
    for (const p of [...tree.current.keys()].sort(byteOrder)) {
      const was = tree.original(p);
      const now = tree.current.get(p) as string | null;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  rows.sort((a, b) => byteOrder(a.key, b.key));
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

// ---------------------------------------------------------------------------

const trialUrl = process.env.MAKEFUN_ENV_URL;
if (trialUrl !== undefined && trialUrl !== '') {
  // A trial: the kit's runner reads the checks from the environment and runs
  // this file on each one, without this variable set.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialUrl);
} else {
  const result = run(process.argv.slice(2));
  writeSync(1, result.out.map((l) => `${l}\n`).join(''));
  process.exitCode = result.code;
}
