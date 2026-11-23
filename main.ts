// mend: one patch tool for every AI edit format, implementing SPEC.md.
//
//   node main.ts [--format=NAME] [--check] [--strict] [PATCH]
//
// The patch is read in one of four formats (unified diff, SEARCH/REPLACE
// blocks, V4A, JSON edits), each edit is applied to the tree as the earlier
// edits left it, and either every change is written or none is. Node 22, the
// standard library alone. In a trial the grader runs this file with
// MAKEFUN_ENV_URL set; the last lines then hand over to runner.ts, which runs
// this same file once per check without that variable.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/** An exit-2 failure: the single line it prints is the whole output. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit failed: a code and the path the failure concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A safe path (SPEC.md section 3): relative, no backslash, no empty, `.` or `..` segment. */
function isSafe(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: `now` holds the paths an edit has touched (null: deleted). */
class Tree {
  private readonly orig = new Map<string, string | null>();
  /** Paths that exist on disk but are not files: a directory is not a file
   *  (changes to it are `missing`), yet a creation there is `exists`. */
  private readonly dirs = new Set<string>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, in the order the edits made them: [old path, new path]. */
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
        else this.dirs.add(p);
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  /** Whether the path is a directory on disk, as the patch found it. */
  isDir(p: string): boolean {
    this.original(p);
    return this.dirs.has(p);
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

/** One edit, applied to the tree; it throws Fail when it cannot be done. */
type Edit = (tree: Tree, strict: boolean) => void;

/** A file as lines: its own line break, and whether its text ends with one. */
interface FileLines {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let fin = false;
  if (text.endsWith(br)) {
    fin = true;
    parts.pop();
  }
  return { lines: parts, br, final: fin };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** A created file's text: LF breaks, a final one unless the format said otherwise. */
function createdText(lines: string[], finalBreak: boolean): string {
  if (lines.length === 0) return '';
  return lines.join('\n') + (finalBreak ? '\n' : '');
}

// Section 5: matching lines at three tiers.

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];

function tierEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

/** Every position at which O occurs in lines at one tier; occurrences may overlap. */
function occurrences(lines: string[], O: string[], tier: number): number[] {
  const out: number[] = [];
  if (O.length === 0 || O.length > lines.length) return out;
  for (let i = 0; i + O.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < O.length; j += 1) {
      if (!tierEq(lines[i + j]!, O[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once, and its occurrences there. */
function findTier(lines: string[], O: string[], strict: boolean): { tier: number; occ: number[] } | null {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    const occ = occurrences(lines, O, tier);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

/** One body line of a unified hunk or a V4A chunk: context, deletion, addition, or a `\` note. */
interface BodyLine {
  k: 'c' | 'd' | 'a' | 'b';
  s: string;
  /** V4A only: the raw patch line was blank (empty or only whitespace). */
  blankRaw?: boolean;
}

/** The old lines a body names (context and deletions), in order. */
const oldOf = (body: BodyLine[]): string[] => body.filter((e) => e.k === 'c' || e.k === 'd').map((e) => e.s);
/** How many lines the body writes (context and additions). */
const newCount = (body: BodyLine[]): number => body.filter((e) => e.k === 'c' || e.k === 'a').length;

/**
 * Splice a body into lines at pos, where the body's old lines matched there at
 * the given tier: context lines are written as the file's own matched lines,
 * and at tier 2 every other written line is re-indented from the patch's first
 * old line's indentation to the file's first matched line's.
 */
function splice(lines: string[], body: BodyLine[], pos: number, tier: number): string[] {
  const olen = oldOf(body).length;
  let f = '';
  let p = '';
  if (tier === 2) {
    f = leadWs(lines[pos] ?? '');
    const first = body.find((e) => e.k === 'c' || e.k === 'd');
    p = leadWs(first?.s ?? '');
  }
  const out = lines.slice(0, pos);
  let j = pos;
  for (const e of body) {
    if (e.k === 'c') {
      out.push(lines[j]!);
      j += 1;
    } else if (e.k === 'd') {
      j += 1;
    } else if (e.k === 'a') {
      let s = e.s;
      if (tier === 2 && s !== '' && !/^[ \t]+$/.test(s) && s.startsWith(p)) s = f + s.slice(p.length);
      out.push(s);
    }
  }
  return out.concat(lines.slice(pos + olen));
}

/** Whether a `\` line follows the body's last context or addition line. */
function backslashAfterLast(body: BodyLine[]): boolean {
  for (let i = body.length - 1; i >= 0; i -= 1) {
    if (body[i]!.k === 'c' || body[i]!.k === 'a') return body[i + 1]?.k === 'b';
  }
  return false;
}

/** Format detection (section 4), the first rule that holds. */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs.

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface Section {
  oldPath: string | null | undefined;
  newPath: string | null | undefined;
  sawPair: boolean;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

/** The path a `--- ` or `+++ ` header line names: after the four characters, to the first tab, trimmed. */
function headerPath(line: string): string | null {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

/** The two paths of a `diff --git a/<X> b/<Y>` line; anything else of that shape is a parse error. */
function gitPaths(line: string, lineNo: number): [string, string] {
  const rest = line.slice('diff --git '.length);
  const sep = rest.startsWith('a/') ? rest.indexOf(' b/', 2) : -1;
  if (sep < 0 || rest.slice(2, sep) === '' || rest.slice(sep + 3) === '') throw new Exit2(`error: parse ${lineNo}`);
  return [rest.slice(2, sep), rest.slice(sep + 3)];
}

function parseUnified(lines: string[]): Edit[] {
  const sections: Section[] = [];
  let sec: Section | null = null;
  const fresh = (): Section => {
    const s: Section = { oldPath: undefined, newPath: undefined, sawPair: false, newFile: false, delFile: false, hunks: [] };
    sections.push(s);
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const [x, y] = gitPaths(line, i + 1);
      sec = fresh();
      sec.oldPath = x;
      sec.newPath = y;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const pairOld = headerPath(line);
      const pairNew = headerPath(lines[i + 1]!);
      // A pair that names no file on either side names no edit at all.
      if (pairOld === null && pairNew === null) throw new Exit2(`error: parse ${i + 1}`);
      if (sec === null || sec.hunks.length > 0 || sec.sawPair) sec = fresh();
      sec.oldPath = pairOld;
      sec.newPath = pairNew;
      sec.sawPair = true;
      i += 2;
      continue;
    }
    if (sec !== null && sec.hunks.length === 0) {
      // The section's header, before its first hunk.
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ')) {
        sec.newPath = headerPath(line);
        i += 1;
        continue;
      }
      if (line.startsWith('rename from ')) {
        // The ---/+++ pair names the paths when there is one; rename lines
        // only name them when no pair does, whatever order they come in.
        if (!sec.sawPair) sec.oldPath = line.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        if (!sec.sawPair) sec.newPath = line.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        sec.newFile = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        sec.delFile = true;
        i += 1;
        continue;
      }
    }
    if (line.startsWith('@@')) {
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
      // A deletion's hunks are not read (section 6): skip the header and the
      // body-shaped lines after it without interpreting any of them, so even a
      // malformed `@@` line there cannot fail the parse.
      const isCreateSec = (sec.oldPath === null || sec.newFile) && typeof (sec.newPath ?? sec.oldPath) === 'string';
      if (!isCreateSec && (sec.newPath === null || sec.delFile)) {
        let j = i + 1;
        while (j < lines.length) {
          const l = lines[j]!;
          if (l.startsWith('diff --git ')) break;
          if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
          if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
            j += 1;
            continue;
          }
          break;
        }
        i = j;
        continue;
      }
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const body: (BodyLine & { emptyRaw: boolean })[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j]!;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (l === '') body.push({ k: 'c', s: '', emptyRaw: true });
        else if (l[0] === ' ') body.push({ k: 'c', s: l.slice(1), emptyRaw: false });
        else if (l[0] === '-') body.push({ k: 'd', s: l.slice(1), emptyRaw: false });
        else if (l[0] === '+') body.push({ k: 'a', s: l.slice(1), emptyRaw: false });
        else if (l[0] === '\\') body.push({ k: 'b', s: '', emptyRaw: false });
        else break;
        j += 1;
      }
      while (body.length > 0 && body[body.length - 1]!.emptyRaw) body.pop();
      sec.hunks.push({ a: Number(m[1]), body });
      i = j;
      continue;
    }
    i += 1; // Outside bodies and headers, lines are ignored.
  }
  return sections.map((s) => unifiedEdit(s));
}

function unifiedEdit(sec: Section): Edit {
  return (tree, strict) => {
    const oldP = sec.oldPath ?? sec.newPath;
    const newP = sec.newPath ?? sec.oldPath;
    const isCreate = (sec.oldPath === null || sec.newFile) && typeof newP === 'string';
    const isDelete = !isCreate && (sec.newPath === null || sec.delFile);
    if (isCreate) {
      const p = newP!;
      if (!isSafe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null || tree.isDir(p)) throw new Fail('exists', p);
      const flat: BodyLine[] = sec.hunks.flatMap((h) => h.body);
      const texts = flat.filter((e) => e.k === 'a').map((e) => e.s);
      tree.now.set(p, createdText(texts, !backslashAfterLast(flat)));
      return;
    }
    if (isDelete) {
      const p = oldP!;
      if (!isSafe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const from = oldP!;
    const to = newP!;
    if (!isSafe(from)) throw new Fail('unsafe', from);
    if (!isSafe(to)) throw new Fail('unsafe', to);
    const before = tree.get(from);
    if (before === null) throw new Fail('missing', from);
    const moving = from !== to;
    if (moving && (tree.get(to) !== null || tree.isDir(to))) throw new Fail('exists', to);
    const f = splitFile(before);
    let d = 0;
    for (const hunk of sec.hunks) {
      const O = oldOf(hunk.body);
      if (O.length === 0) {
        const pos = Math.max(0, Math.min(hunk.a + d, f.lines.length));
        const adds = hunk.body.filter((e) => e.k === 'a');
        if (adds.length > 0) {
          const atEnd = pos === f.lines.length;
          f.lines = splice(f.lines, hunk.body, pos, 0);
          if (atEnd) f.final = !backslashAfterLast(hunk.body);
        }
      } else {
        const found = findTier(f.lines, O, strict);
        if (found === null) throw new Fail('no-match', from);
        const target = hunk.a - 1 + d;
        let pos = found.occ[0]!;
        for (const o of found.occ) {
          if (Math.abs(o - target) < Math.abs(pos - target)) pos = o;
        }
        const atEnd = pos + O.length === f.lines.length;
        f.lines = splice(f.lines, hunk.body, pos, found.tier);
        if (atEnd) f.final = !backslashAfterLast(hunk.body);
      }
      d += newCount(hunk.body) - O.length;
    }
    tree.now.set(to, joinFile(f));
    if (moving) {
      tree.now.set(from, null);
      tree.moves.push([from, to]);
    }
  };
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks.

interface Block {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): Edit[] {
  const blocks: Block[] = [];
  let prevEnd = 0;
  let prevPath: string | undefined;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    let path: string | undefined;
    for (let k = i - 1; k >= prevEnd; k -= 1) {
      const t = lines[k]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === undefined) {
      if (prevPath === undefined) throw new Exit2(`error: parse ${i + 1}`);
      path = prevPath;
    }
    const oldLines: string[] = [];
    let j = i + 1;
    while (j < lines.length && lines[j]!.trimEnd() !== '=======') {
      oldLines.push(lines[j]!);
      j += 1;
    }
    if (j >= lines.length) throw new Exit2(`error: parse ${i + 1}`);
    const newLines: string[] = [];
    let k2 = j + 1;
    while (k2 < lines.length && lines[k2]!.trimEnd() !== '>>>>>>> REPLACE') {
      newLines.push(lines[k2]!);
      k2 += 1;
    }
    if (k2 >= lines.length) throw new Exit2(`error: parse ${i + 1}`);
    blocks.push({ path, oldLines, newLines });
    prevPath = path;
    prevEnd = k2 + 1;
    i = k2 + 1;
  }
  return blocks.map((b) => searchReplaceEdit(b));
}

function searchReplaceEdit(b: Block): Edit {
  return (tree, strict) => {
    const p = b.path;
    if (!isSafe(p)) throw new Fail('unsafe', p);
    if (b.oldLines.length === 0) {
      if (tree.get(p) !== null || tree.isDir(p)) throw new Fail('exists', p);
      tree.now.set(p, createdText(b.newLines, true));
      return;
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const f = splitFile(before);
    const found = findTier(f.lines, b.oldLines, strict);
    if (found === null) throw new Fail('no-match', p);
    if (found.occ.length > 1) throw new Fail('ambiguous', p);
    const body: BodyLine[] = [
      ...b.oldLines.map((s): BodyLine => ({ k: 'd', s })),
      ...b.newLines.map((s): BodyLine => ({ k: 'a', s })),
    ];
    f.lines = splice(f.lines, body, found.occ[0]!, found.tier);
    tree.now.set(p, joinFile(f));
  };
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches.

interface Chunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
  /** True when the chunk was opened by a body line rather than an `@@` line. */
  implicit?: boolean;
}

interface VSection {
  kind: 'add' | 'del' | 'upd';
  path: string;
  lineNo: number;
  addLines: { s: string; blankRaw: boolean; wsLine?: number }[];
  moveTo: string | undefined;
  chunks: Chunk[];
}

function parseV4a(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last > first && isBlank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let sec: VSection | null = null;
  let inChunk = false;
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ')) {
      const kind = line.startsWith('*** Add File: ') ? 'add' : line.startsWith('*** Delete File: ') ? 'del' : 'upd';
      const head = kind === 'add' ? '*** Add File: ' : kind === 'del' ? '*** Delete File: ' : '*** Update File: ';
      sec = { kind, path: line.slice(head.length).trim(), lineNo: i + 1, addLines: [], moveTo: undefined, chunks: [] };
      sections.push(sec);
      inChunk = false;
      i += 1;
      continue;
    }
    if (sec === null) {
      if (isBlank(line)) {
        i += 1;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (sec.kind === 'add') {
      if (line === '') sec.addLines.push({ s: '', blankRaw: true });
      else if (line.startsWith('+')) sec.addLines.push({ s: line.slice(1), blankRaw: false });
      // A line of only whitespace is neither a `+` line nor an empty one. It is
      // collected as a blank for now: at the end of the section it is dropped
      // like any blank there; anywhere else it is a parse error, named below.
      else if (isBlank(line)) sec.addLines.push({ s: line, blankRaw: true, wsLine: i + 1 });
      else throw new Exit2(`error: parse ${i + 1}`);
      i += 1;
      continue;
    }
    if (sec.kind === 'del') {
      if (isBlank(line)) {
        i += 1;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    // An Update File section.
    if (line.startsWith('*** Move to: ')) {
      if (sec.moveTo !== undefined || sec.chunks.length > 0) throw new Exit2(`error: parse ${i + 1}`);
      sec.moveTo = line.slice('*** Move to: '.length).trim();
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      const anchor = line.slice(2).trim();
      sec.chunks.push({ anchor: anchor === '' ? null : anchor, body: [], eof: false });
      inChunk = true;
      i += 1;
      continue;
    }
    if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+') {
      if (!inChunk) {
        if (sec.chunks.length > 0) throw new Exit2(`error: parse ${i + 1}`);
        sec.chunks.push({ anchor: null, body: [], eof: false, implicit: true });
        inChunk = true;
      }
      const chunk = sec.chunks[sec.chunks.length - 1]!;
      const blankRaw = line.trim() === '';
      if (line === '') chunk.body.push({ k: 'c', s: '', blankRaw });
      else if (line[0] === ' ') chunk.body.push({ k: 'c', s: line.slice(1), blankRaw });
      else if (line[0] === '-') chunk.body.push({ k: 'd', s: line.slice(1), blankRaw });
      else chunk.body.push({ k: 'a', s: line.slice(1), blankRaw });
      i += 1;
      continue;
    }
    if (line.trim() === '*** End of File') {
      if (sec.chunks.length === 0) sec.chunks.push({ anchor: null, body: [], eof: true });
      else sec.chunks[sec.chunks.length - 1]!.eof = true;
      inChunk = false;
      i += 1;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  for (const s of sections) {
    // Blank lines at the end of a section are not part of it.
    if (s.kind === 'add') {
      while (s.addLines.length > 0 && s.addLines[s.addLines.length - 1]!.blankRaw) s.addLines.pop();
      const stray = s.addLines.find((l) => l.wsLine !== undefined);
      if (stray !== undefined) throw new Exit2(`error: parse ${stray.wsLine}`);
    }
    if (s.kind === 'upd') {
      const lastChunk = s.chunks[s.chunks.length - 1];
      if (lastChunk !== undefined) {
        while (lastChunk.body.length > 0 && lastChunk.body[lastChunk.body.length - 1]!.blankRaw === true) lastChunk.body.pop();
        // A chunk opened by a body line whose lines were all end-of-section
        // blanks held no body line at all: the section has no chunk.
        if (lastChunk.implicit === true && lastChunk.anchor === null && !lastChunk.eof && lastChunk.body.length === 0) s.chunks.pop();
      }
      if (s.chunks.length === 0 && s.moveTo === undefined) throw new Exit2(`error: parse ${s.lineNo}`);
    }
  }
  return sections.map((s) => v4aEdit(s));
}

function v4aEdit(sec: VSection): Edit {
  return (tree, strict) => {
    const p = sec.path;
    if (!isSafe(p)) throw new Fail('unsafe', p);
    if (sec.kind === 'add') {
      if (tree.get(p) !== null || tree.isDir(p)) throw new Fail('exists', p);
      tree.now.set(p, createdText(sec.addLines.map((l) => l.s), true));
      return;
    }
    if (sec.kind === 'del') {
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const to = sec.moveTo;
    if (to !== undefined && !isSafe(to)) throw new Fail('unsafe', to);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (to !== undefined && (tree.get(to) !== null || tree.isDir(to))) throw new Fail('exists', to);
    const f = splitFile(before);
    let cursor = 0;
    for (const chunk of sec.chunks) {
      if (chunk.anchor !== null) {
        let at = -1;
        for (const tier of strict ? [0] : [0, 1, 2]) {
          for (let k = cursor; k < f.lines.length; k += 1) {
            if (tierEq(f.lines[k]!, chunk.anchor, tier)) {
              at = k;
              break;
            }
          }
          if (at >= 0) break;
        }
        if (at < 0) throw new Fail('no-match', p);
        cursor = at + 1;
      }
      const O = oldOf(chunk.body);
      if (O.length === 0) {
        const pos = chunk.eof ? f.lines.length : Math.min(cursor, f.lines.length);
        f.lines = splice(f.lines, chunk.body, pos, 0);
        cursor = pos + newCount(chunk.body);
        continue;
      }
      let placed: { tier: number; pos: number } | null = null;
      for (const tier of strict ? [0] : [0, 1, 2]) {
        let occ = occurrences(f.lines, O, tier).filter((o) => o >= cursor);
        if (chunk.eof) occ = occ.filter((o) => o + O.length === f.lines.length);
        if (occ.length > 0) {
          placed = { tier, pos: occ[0]! };
          break;
        }
      }
      if (placed === null) throw new Fail('no-match', p);
      f.lines = splice(f.lines, chunk.body, placed.pos, placed.tier);
      cursor = placed.pos + newCount(chunk.body);
    }
    if (to !== undefined) {
      tree.now.set(to, joinFile(f));
      tree.now.set(p, null);
      tree.moves.push([p, to]);
    } else {
      tree.now.set(p, joinFile(f));
    }
  };
}

// ---------------------------------------------------------------------------
// Section 9: JSON edits.

function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const readExisting = (tree: Tree): string => {
    if (!isSafe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!isSafe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null || tree.isDir(p)) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = readExisting(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = readExisting(tree);
      const f = splitFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      f.lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(f));
    };
  }
  return null;
}

function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, idx) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${idx + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Sections 1, 2 and 10: the command line, the output, all or nothing.

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMAT_NAMES.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = parseJson(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines);
    else edits = parseV4a(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree, strict);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const state = (p: string): string | null => (tree.now.has(p) ? tree.now.get(p)! : tree.original(p));
  const renames = tree.moves.filter(([o, n]) => tree.original(o) !== null && state(o) === null && tree.original(n) === null && state(n) !== null);
  const goneCovered = new Set(renames.map(([o]) => o));
  const bornCovered = new Set(renames.map(([, n]) => n));
  const rows: { key: string; text: string }[] = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (now === null && goneCovered.has(p)) continue;
    if (was === null && bornCovered.has(p)) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [o, n] of renames) rows.push({ key: n, text: `R ${o} -> ${n}` });
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key), Buffer.from(y.key)));
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
