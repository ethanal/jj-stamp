/** jj-hunk-tool emits bare unified sections; add Git framing for display only.
 * The original server preview remains untouched and is the patch we validate.
 */
export function displayPatch(patch: string): string {
  if (patch.startsWith("diff --git ")) return patch;
  return patch.replace(
    /^--- (a\/[^\n]+|\/dev\/null)\n\+\+\+ (b\/[^\n]+|\/dev\/null)\n/gm,
    (headers, oldPath: string, newPath: string) => {
      const old = oldPath === "/dev/null" ? `a/${newPath.slice(2)}` : oldPath;
      const next = newPath === "/dev/null" ? `b/${oldPath.slice(2)}` : newPath;
      return `diff --git ${old} ${next}\n${headers}`;
    },
  );
}
