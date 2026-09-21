import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { ApiError } from "./errors.ts";

/** Resolve an existing regular workspace file while rejecting every symlink. */
export async function resolveEditorPath(
  root: string,
  relative: string,
): Promise<string> {
  const absolute = path.resolve(root, relative);
  const contained = path.relative(root, absolute);
  if (
    !contained ||
    contained === ".." ||
    contained.startsWith(`..${path.sep}`) ||
    path.isAbsolute(contained)
  ) {
    throw new ApiError(
      400,
      "INVALID_PATH",
      "The editor file must be inside the workspace.",
    );
  }
  try {
    // Reject all symlinks, including directory links and links back inside the
    // workspace. The editor must open this exact regular workspace file.
    if ((await realpath(root)) !== root) {
      throw new ApiError(
        422,
        "EDITOR_FILE_UNAVAILABLE",
        "The workspace path is now a symlink; restart jj-stamp.",
      );
    }
    let current = root;
    for (const part of contained.split(path.sep)) {
      current = path.join(current, part);
      const entry = await lstat(current);
      if (
        entry.isSymbolicLink() ||
        (current === absolute ? !entry.isFile() : !entry.isDirectory())
      ) {
        throw new ApiError(
          422,
          "EDITOR_FILE_UNAVAILABLE",
          "The editor requires a regular workspace file without symlinks.",
        );
      }
    }
    if ((await realpath(absolute)) !== absolute) {
      throw new ApiError(
        422,
        "EDITOR_FILE_UNAVAILABLE",
        "The editor file resolves outside its workspace path.",
      );
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      422,
      "EDITOR_FILE_UNAVAILABLE",
      "The file is missing or inaccessible in the current workspace; historical files cannot be opened.",
    );
  }
  return absolute;
}

/** Build the data-only Neovim expression used by the loopback editor bridge. */
export function editorExpression(absolute: string, line: number): string {
  // Vim single-quoted strings escape an apostrophe by doubling it; backslashes
  // are literal. Never use :edit, --remote-send, or filename/key expansion.
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const lua =
    "(function(a) local b = vim.fn.bufadd(a[1]); vim.fn.bufload(b); vim.bo[b].buflisted = true; vim.api.nvim_set_current_buf(b); vim.api.nvim_win_set_cursor(0, {math.min(a[2], vim.api.nvim_buf_line_count(b)), 0}); return 1 end)(_A)";
  return `luaeval(${literal(lua)}, [${literal(absolute)}, ${line}])`;
}
