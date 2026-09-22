"""Exercise the installed Nix output without a checkout or ambient PATH tools."""

import json
import os
from pathlib import Path
import re
import selectors
import shlex
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request


package, jj = sys.argv[1:]
root = Path.cwd()
repo = root / "repo"
repo.mkdir()
home = root / "home"
home.mkdir()
env = dict(os.environ, HOME=str(home), JJ_CONFIG="", JJ_USER="Nix check",
           JJ_EMAIL="nix-check@example.invalid", XDG_STATE_HOME=str(root / "state"))


def run_jj(*args):
    return subprocess.check_output([jj, *args], cwd=repo, env=env, text=True).strip()


run_jj("git", "init")
(repo / "example.txt").write_text("before\n")
partial_base = "".join(f"line {i}\n" for i in range(1, 51))
(repo / "partial.txt").write_text(partial_base)
run_jj("describe", "-m", "parent")
run_jj("new", "-m", "review me")
(repo / "example.txt").write_text("after\n")
change = run_jj("log", "--no-graph", "-r", "@", "-T", "change_id")
# Only the Nix wrappers may supply node, jj, jj-hunk-tool and GNU patch.
# Listing/preview does not invoke patch: a real mutation below must succeed too.
env["PATH"] = ""
# The launcher must override any ambient tool choice with the patched store wrapper.
env["JJ_STAMP_HUNK_TOOL"] = "/not-the-packaged-hunk-tool"
env.pop("NODE_PATH", None)
process = subprocess.Popen([f"{package}/bin/jj-stamp", "--no-open", change],
                           cwd=repo, env=env, stdout=subprocess.PIPE,
                           stderr=subprocess.STDOUT)
selector = selectors.DefaultSelector()
selector.register(process.stdout, selectors.EVENT_READ)
output = b""
try:
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if not selector.select(timeout=1):
            continue
        chunk = os.read(process.stdout.fileno(), 65536)
        if not chunk:
            raise AssertionError(f"CLI exited before startup: {output.decode()}")
        output += chunk
        match = re.search(rb"http://127\.0\.0\.1:\d+/", output)
        if match:
            url = match[0].decode()
            break
    else:
        raise AssertionError(f"CLI startup timed out: {output.decode()}")

    def get(path):
        with urllib.request.urlopen(url + path, timeout=10) as response:
            return response.read()

    def post(path, body, expected_status=200):
        request = urllib.request.Request(
            url + path, data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json", "X-Fold-Request": "1"},
            method="POST")
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                assert response.status == expected_status, response.status
                return json.load(response)
        except urllib.error.HTTPError as error:
            if error.code == expected_status:
                return json.load(error)
            raise AssertionError(
                f"{path}: HTTP {error.code}: {error.read().decode()}") from error

    html = get("").decode()
    assert '<div id="root">' in html, html
    asset = re.search(r'src="(/assets/[^\"]+\.js)"', html)
    assert asset, html
    assert len(get(asset[1].lstrip("/"))) > 100
    state = json.loads(get("api/state"))
    assert state["source"]["changeId"] == change, state
    assert state["source"]["description"] == "review me", state
    assert state["files"][0]["path"] == "example.txt", state
    assert state["files"][0]["hunks"], state
    graph = json.loads(get("api/log"))
    assert any(row.get("revision", {}).get("changeId") == change and row.get("mutable")
               for row in graph["rows"]), graph
    parent = state["parent"]["changeId"]
    hunk = state["files"][0]["hunks"][0]
    changed_lines = [row["index"] for row in hunk["rows"]
                     if row["raw"].startswith(("+", "-"))]
    assert len(changed_lines) == 2, hunk
    preview = post("api/preview", {
        "version": state["version"], "target": parent,
        "selections": [{"id": hunk["id"], "lines": changed_lines}],
    })
    assert json.loads(get("api/state"))["version"] == state["version"]
    squashed = post("api/squash", {"token": preview["token"]})["state"]
    assert squashed["source"]["changeId"] == change, squashed
    assert squashed["parent"]["changeId"] == parent, squashed
    assert squashed["parent"]["description"] == "parent", squashed
    assert squashed["files"] == [], squashed
    assert squashed["canUndo"], squashed
    assert run_jj("file", "show", "-r", "@-", "example.txt") == "after"
    assert (repo / "example.txt").read_text() == "after\n"

    # Verify actual history recovery as well as the successful mutation response.
    undone = post("api/undo", {"version": squashed["version"]})["state"]
    assert undone["source"]["commitId"] == state["source"]["commitId"], undone
    assert undone["parent"]["commitId"] == state["parent"]["commitId"], undone
    assert not undone["canUndo"], undone
    assert undone["files"][0]["hunks"], undone
    assert run_jj("file", "show", "-r", "@-", "example.txt") == "before"
    assert (repo / "example.txt").read_text() == "after\n"

    # Selecting only a late replacement neutralizes the earlier deletion block
    # into >3 leading context rows. Upstream's patch then incorrectly requires
    # EOF; the file deliberately continues well past the selected hunk.
    partial_source = partial_base.replace(
        "".join(f"line {i}\n" for i in range(6, 16)), "early replacement\n"
    ).replace("line 18\n", "changed 18\n")
    (repo / "partial.txt").write_text(partial_source)
    partial = json.loads(get("api/state"))
    partial_file = next(f for f in partial["files"] if f["path"] == "partial.txt")
    assert len(partial_file["hunks"]) == 1, partial_file
    hunk = partial_file["hunks"][0]
    picked = [row["index"] for row in hunk["rows"]
              if row["raw"] in ("-line 18", "+changed 18")]
    assert len(picked) == 2, hunk
    partial_squash = post("api/squash-lines", {
        "version": partial["version"],
        "selections": [{"id": hunk["id"], "lines": picked}],
    })["state"]
    assert run_jj("file", "show", "-r", "@-", "partial.txt") == partial_base.replace(
        "line 18\n", "changed 18\n").strip()
    assert (repo / "partial.txt").read_text() == partial_source
    assert partial_squash["canUndo"], partial_squash
    undone = post("api/undo", {"version": partial_squash["version"]})["state"]
    assert run_jj("file", "show", "-r", "@-", "partial.txt") == partial_base.strip()
    assert undone["source"]["commitId"] == partial["source"]["commitId"], undone

    # Force a real, non-mutating tool failure at commit signing, after all
    # preview checks. Verify the HTTP diagnostic identifies the absolute Nix
    # wrapper that actually ran, with complete pinned squash arguments.
    signing = {
        "signing.behavior": "own",
        "signing.backend": "ssh",
        "signing.key": "/nonexistent-jj-stamp-test-key",
        "signing.backends.ssh.program": "/nonexistent-jj-stamp-test-signer",
    }
    for key, value in signing.items():
        run_jj("config", "set", "--repo", key, value)
    failing = json.loads(get("api/state"))
    hunk = next(f for f in failing["files"] if f["path"] == "example.txt")["hunks"][0]
    picked = [row["index"] for row in hunk["rows"] if row["raw"].startswith(("+", "-"))]
    failed = post("api/squash-lines", {
        "version": failing["version"],
        "selections": [{"id": hunk["id"], "lines": picked}],
    }, expected_status=500)
    assert failed["code"] == "TOOL_FAILED", failed
    assert "Signing error" in failed["output"], failed
    command = shlex.split(failed["output"].split("Failed command:\n", 1)[1].splitlines()[0])
    assert command[0].startswith("/nix/store/"), command
    assert command[0].endswith("/bin/jj-hunk-tool"), command
    assert Path(command[0]).is_file(), command
    assert command[1:] == ["squash", hunk["id"], "--from", failing["source"]["commitId"],
                           "--into", failing["parent"]["commitId"],
                           "--use-destination-message", "--keep-emptied"], command
    assert json.loads(get("api/state"))["operation"] == failing["operation"]
    for key in signing:
        run_jj("config", "unset", "--repo", key)
    undone = json.loads(get("api/state"))

    selected = post("api/revision", {
        "version": undone["version"], "changeId": parent,
    })["state"]
    assert selected["source"]["changeId"] == parent, selected
    assert selected["parent"] is None, selected  # Its immediate parent is root.
    assert "immutable" in selected["squashUnavailable"], selected
    assert not (Path(package) / "lib" / "node_modules").exists()
    process.send_signal(signal.SIGTERM)
    assert process.wait(timeout=15) == 0
    # Review, squash, undo and shutdown must not create backend app state.
    assert not (root / "state" / "jj-stamp").exists()
    assert not (home / ".local" / "state" / "jj-stamp").exists()
    print("Installed CLI, pinned patched runtime, full Nix command diagnostics, asymmetric-context partial squash, browser assets, preview, squash, undo, stateless operation, revision selection and shutdown passed")
finally:
    selector.close()
    if process.poll() is None:
        process.kill()
        process.wait()
    print(output.decode(), end="")
