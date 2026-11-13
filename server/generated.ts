/**
 * Advisory, versioned linguist-generated attributes. No Git installation,
 * workspace/global attributes, filesystem traversal, or repository writes.
 */
export const maxAttributeFiles = 256;
export const maxAttributeBytes = 256 * 1024;

/** null means unsafe/over budget: leave everything visible. */
export function parseAttributeFiles(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > maxAttributeFiles) return null;
  const paths: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.startsWith("file:")) return null;
    const name = entry.slice(5);
    if (
      name.length > 4096 ||
      /[\x00-\x1f\x7f\\]/.test(name) ||
      name.split("/").some((part) => !part || part === "." || part === "..") ||
      name.split("/").at(-1) !== ".gitattributes"
    )
      return null;
    paths.push(name);
  }
  return paths;
}

interface Rule {
  directory: string;
  directoryBytes: number;
  pattern: string;
  generated: boolean;
}
interface Budget {
  remaining: number;
}
function spend(budget: Budget) {
  if (--budget.remaining < 0) throw new Error("Attribute matching limit");
}

/** Git wildmatch's ordinary segment syntax, without regex backtracking. */
function segmentMatch(pattern: string, name: string, budget: Budget): boolean {
  const memo = new Map<string, boolean>();
  function match(p: number, n: number): boolean {
    const key = `${p}:${n}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    spend(budget);
    let result = false;
    const token = pattern[p];
    if (p === pattern.length) result = n === name.length;
    else if (token === "*")
      result = match(p + 1, n) || (n < name.length && match(p, n + 1));
    else if (token === "?") result = n < name.length && match(p + 1, n + 1);
    else if (token === "\\")
      result =
        n < name.length && pattern[p + 1] === name[n] && match(p + 2, n + 1);
    else if (token === "[") {
      let end = p + 1;
      if (pattern[end] === "!" || pattern[end] === "^") end++;
      if (pattern[end] === "]") end++;
      while (end < pattern.length && pattern[end] !== "]") {
        if (pattern[end] === "\\") end++;
        end++;
      }
      if (end === pattern.length)
        result = name[n] === "[" && match(p + 1, n + 1);
      else if (n < name.length) {
        let i = p + 1;
        const negate = pattern[i] === "!" || pattern[i] === "^";
        if (negate) i++;
        let found = false;
        const character = () =>
          pattern[i] === "\\" ? pattern[(i += 2) - 1] : pattern[i++];
        while (i < end) {
          const first = character();
          if (pattern[i] === "-" && i + 1 < end) {
            i++;
            const last = character();
            found ||= first <= name[n] && name[n] <= last;
          } else found ||= first === name[n];
        }
        result = found !== negate && match(end + 1, n + 1);
      }
    } else result = name[n] === token && match(p + 1, n + 1);
    memo.set(key, result);
    return result;
  }
  return match(0, 0);
}

function matches(pattern: string, name: string, budget: Budget): boolean {
  if (pattern.endsWith("/")) return false; // Attributes do not recurse directories.
  const anchored = pattern.startsWith("/");
  if (anchored) pattern = pattern.slice(1);
  if (!anchored && !pattern.includes("/"))
    return segmentMatch(pattern, name.split("/").at(-1)!, budget);
  const patterns = pattern.split("/");
  const names = name.split("/");
  const memo = new Map<string, boolean>();
  function match(p: number, n: number): boolean {
    const key = `${p}:${n}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    spend(budget);
    let result: boolean;
    if (p === patterns.length) result = n === names.length;
    else if (patterns[p] === "**") {
      // A trailing /** matches entries inside the directory, not the directory.
      result =
        p === patterns.length - 1
          ? n < names.length
          : match(p + 1, n) || (n < names.length && match(p, n + 1));
    } else
      result =
        n < names.length &&
        segmentMatch(patterns[p], names[n], budget) &&
        match(p + 1, n + 1);
    memo.set(key, result);
    return result;
  }
  return match(0, 0);
}

function patternAndAttributes(line: string): [string, string[]] | null {
  line = line.replace(/^[ \t\r\n\v\f]+/, "");
  if (!line || line.startsWith("#")) return null;
  let pattern: string;
  if (line.startsWith('"')) {
    const quoted = /^("(?:[^"\\]|\\.)*")(?=[ \t\r\n\v\f]|$)/.exec(line);
    if (!quoted) throw new Error("Unsupported quoted attribute pattern");
    // Git's C quoting includes octal UTF-8 bytes, not just JSON escapes.
    const bytes: number[] = [];
    const text = quoted[1].slice(1, -1);
    for (let i = 0; i < text.length; i++) {
      if (text[i] !== "\\") {
        const point = String.fromCodePoint(text.codePointAt(i)!);
        bytes.push(...Buffer.from(point));
        i += point.length - 1;
      } else {
        const octal = /^[0-7]{1,3}/.exec(text.slice(i + 1));
        if (octal) {
          const value = parseInt(octal[0], 8);
          if (value > 255) throw new Error("Invalid octal byte");
          bytes.push(value);
          i += octal[0].length;
        } else {
          const escape: Record<string, string> = {
            a: "\x07",
            b: "\b",
            t: "\t",
            n: "\n",
            v: "\v",
            f: "\f",
            r: "\r",
            "\\": "\\",
            '"': '"',
          };
          const value = escape[text[++i]];
          if (value === undefined) throw new Error("Unknown C escape");
          bytes.push(...Buffer.from(value));
        }
      }
    }
    pattern = Buffer.from(bytes).toString("utf8");
    line = line.slice(quoted[0].length);
  } else {
    const token = /^[^ \t\r\n\v\f]+/.exec(line)!;
    pattern = token[0];
    line = line.slice(pattern.length);
  }
  return [pattern, line.split(/[ \t\r\n\v\f]+/).filter(Boolean)];
}

/** Unsupported macros/POSIX classes fail open (visible), never hide uncertain files. */
export function generatedPaths(
  files: string[],
  attributes: Array<{ path: string; contents: string }>,
): Set<string> {
  try {
    if (attributes.length > maxAttributeFiles) return new Set();
    const rules: Rule[] = [];
    let bytes = 0;
    for (const attribute of attributes.sort(
      (a, b) => a.path.split("/").length - b.path.split("/").length,
    )) {
      bytes += Buffer.byteLength(attribute.contents);
      if (bytes > maxAttributeBytes) return new Set();
      const directory = attribute.path.slice(0, -".gitattributes".length);
      for (const line of attribute.contents.split(/\r?\n/)) {
        const parsed = patternAndAttributes(line);
        if (!parsed) continue;
        const [pattern, assignments] = parsed;
        if (
          pattern.startsWith("[attr]") ||
          pattern.includes("[:") ||
          pattern.length > 1024 ||
          pattern.endsWith("\\")
        )
          return new Set();
        // Negative patterns are forbidden in .gitattributes, not exclusions.
        if (pattern.startsWith("!")) continue;
        for (const assignment of assignments) {
          let generated: boolean;
          if (
            assignment === "linguist-generated" ||
            assignment === "linguist-generated=true"
          )
            generated = true;
          else if (
            assignment === "-linguist-generated" ||
            assignment === "!linguist-generated" ||
            assignment.startsWith("linguist-generated=")
          )
            generated = false;
          else continue;
          rules.push({
            directory,
            directoryBytes: Buffer.byteLength(directory),
            // Git wildmatch operates on UTF-8 bytes, including ? and ranges.
            pattern: Buffer.from(pattern).toString("latin1"),
            generated,
          });
          if (rules.length > 4096) return new Set();
        }
      }
    }
    const result = new Set<string>();
    const budget = { remaining: 2_000_000 };
    for (const file of files) {
      if (file.length > 4096) return new Set();
      const fileBytes = Buffer.from(file).toString("latin1");
      let generated = false;
      for (const rule of rules) {
        spend(budget);
        if (
          file.startsWith(rule.directory) &&
          matches(rule.pattern, fileBytes.slice(rule.directoryBytes), budget)
        )
          generated = rule.generated;
      }
      if (generated) result.add(file);
    }
    return result;
  } catch {
    return new Set();
  }
}
