import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { jj } from "../server/process.ts";
import { ReviewService, type Selection } from "../server/service.ts";
import { createDemo } from "./fixtures.ts";
import { metadataSelectionId } from "../src/file-selection.ts";

for (const api of ["direct", "legacy"] as const) {
  test(`${api} executable text squash preserves contents, modes, renames and exact undo`, async (t) => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "jj-stamp-executable-"),
    );
    t.after(() => rm(directory, { recursive: true, force: true }));
    const root = await createDemo(directory);
    const renamedBase = Array.from(
      { length: 30 },
      (_, i) => `echo rename-${i}\n`,
    ).join("");
    const pureBase = Array.from(
      { length: 30 },
      (_, i) => `echo pure-${i}\n`,
    ).join("");
    const base: Record<string, string> = {
      "modified.sh": "#!/bin/sh\necho old\necho keep\n",
      "deleted.sh": "#!/bin/sh\necho gone\necho retain\n",
      "removed.sh": "#!/bin/sh\necho remove\n",
      "rename-old.sh": renamedBase,
      "pure-old.sh": pureBase,
      "nonexec.sh": "echo old\n",
      "mode-only.sh": "echo mode\n",
    };
    const put = async (
      name: string,
      contents: string | Buffer,
      executable = true,
    ) => {
      await writeFile(path.join(root, name), contents);
      await chmod(path.join(root, name), executable ? 0o755 : 0o644);
    };
    for (const [name, contents] of Object.entries(base))
      await put(
        name,
        contents,
        name !== "nonexec.sh" && name !== "mode-only.sh",
      );
    await jj(root, ["commit", "-m", "Script base"]);
    const source = {
      "modified.sh": "#!/bin/sh\necho new\necho keep\n",
      "added.sh": "#!/bin/sh\necho added\necho remaining\n",
      "rename-new.sh": renamedBase.replace(
        "echo rename-15\n",
        "echo renamed\n",
      ),
      "pure-new.sh": pureBase,
      "nonexec.sh": "echo new\n",
    };
    await rename(
      path.join(root, "rename-old.sh"),
      path.join(root, "rename-new.sh"),
    );
    await rename(
      path.join(root, "pure-old.sh"),
      path.join(root, "pure-new.sh"),
    );
    for (const [name, contents] of Object.entries(source))
      await put(name, contents, name !== "nonexec.sh");
    for (const name of ["deleted.sh", "removed.sh"])
      await rm(path.join(root, name));
    await put("binary.sh", Buffer.from("#!/bin/sh\nbinary\0data\n"));
    await put(
      "invalid.sh",
      Buffer.from([0x65, 0x63, 0x68, 0x6f, 0x20, 0xff, 10]),
    );
    await chmod(path.join(root, "mode-only.sh"), 0o755);
    await symlink("modified.sh", path.join(root, "symlink.sh"));

    const service = new ReviewService({ repoPath: root });
    const state = await service.getState();
    const tree = async (revision: string, name?: string) =>
      (
        await jj(root, [
          "diff",
          "--git",
          "--from",
          "root()",
          "--to",
          revision,
          "--ignore-working-copy",
          ...(name ? ["--", name] : []),
        ])
      ).stdout;
    const sourceTree = await tree("@");
    const parentTree = await tree("@-");
    for (const name of ["binary.sh", "symlink.sh"])
      assert.ok(
        state.files.find((file) => file.path === name)?.unsupported,
        name,
      );
    await assert.rejects(
      service.getFile({ version: state.version, path: "invalid.sh" }),
      { code: "UNSUPPORTED_DIFF" },
    );
    const expected: Record<string, string | null> = {
      ...source,
      "added.sh": "#!/bin/sh\necho added\n",
      "deleted.sh": "#!/bin/sh\necho retain\n",
      "removed.sh": null,
      "rename-old.sh": null,
      "pure-old.sh": null,
      "mode-only.sh": base["mode-only.sh"],
    };
    const selections: Selection[] = [];
    for (const name of Object.keys(expected)) {
      if (name === "rename-old.sh" || name === "pure-old.sh") continue;
      const file = state.files.find((file) => file.path === name)!;
      assert.ok(file, name);
      assert.equal(file.unsupported, undefined, name);
      await service.getFile({ version: state.version, path: name });
      await service.getCommitFile({
        commitId: state.source.commitId,
        path: name,
      });
      if (name === "pure-new.sh") assert.equal(file.oldPath, "pure-old.sh");
      if (name === "mode-only.sh") {
        assert.equal(file.oldMode, "100644");
        assert.equal(file.newMode, "100755");
        assert.deepEqual(file.hunks, []);
      }
      const metadataId = metadataSelectionId(file);
      if (metadataId !== undefined) {
        selections.push({ id: metadataId, lines: [] });
        continue;
      }
      if (name === "rename-new.sh") assert.equal(file.oldPath, "rename-old.sh");
      for (const hunk of file.hunks) {
        const rows = hunk.rows.filter(
          (row) =>
            /^[+-]/.test(row.raw) &&
            (name !== "added.sh" || row.raw !== "+echo remaining") &&
            (name !== "deleted.sh" || row.raw === "-echo gone"),
        );
        selections.push({ id: hunk.id, lines: rows.map((row) => row.index) });
      }
    }
    const preview =
      api === "legacy"
        ? await service.preview({
            version: state.version,
            target: state.parent!.changeId,
            selections,
          })
        : null;
    if (preview) {
      assert.match(
        preview.patch,
        /diff --git a\/added\.sh b\/added\.sh\nnew file mode 100755\n/,
      );
      assert.match(
        preview.patch,
        /diff --git a\/removed\.sh b\/removed\.sh\ndeleted file mode 100755\n/,
      );
      assert.match(
        preview.patch,
        /diff --git a\/deleted\.sh b\/deleted\.sh\n--- a\/deleted\.sh\n/,
      );
    }
    const result = preview
      ? await service.squash(preview.token)
      : await service.squashLines({ version: state.version, selections });
    assert.equal(result.warning, undefined);
    assert.equal(result.state.canUndo, true);
    assert.equal(
      await tree("@"),
      sourceTree,
      "source bytes, paths and modes remain unchanged",
    );
    for (const [name, contents] of Object.entries(expected)) {
      const diff = await tree("@-", name);
      if (contents === null) {
        assert.equal(diff, "", name);
      } else {
        assert.equal(
          (await jj(root, ["file", "show", "-r", "@-", "--", name])).stdout,
          contents,
          name,
        );
        assert.match(
          diff,
          name === "nonexec.sh"
            ? /new file mode 100644/
            : /new file mode 100755/,
        );
      }
    }
    for (const [name, contents] of Object.entries(source)) {
      assert.equal(
        await readFile(path.join(root, name), "utf8"),
        contents,
        name,
      );
      assert.equal(
        (await stat(path.join(root, name))).mode & 0o111,
        name === "nonexec.sh" ? 0 : 0o111,
      );
    }
    assert.equal(
      await readFile(path.join(root, "mode-only.sh"), "utf8"),
      base["mode-only.sh"],
    );
    assert.equal(
      (await stat(path.join(root, "mode-only.sh"))).mode & 0o111,
      0o111,
    );
    const undone = await service.undo(result.state.version);
    assert.equal(undone.state.source.commitId, state.source.commitId);
    assert.deepEqual(undone.state.files, state.files);
    assert.equal(await tree("@-"), parentTree);
    assert.equal(await tree("@"), sourceTree);
  });
}
