"""Exercise the installed Nix output without a checkout or ambient PATH tools."""

import json
import os
from pathlib import Path
import re
import selectors
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
run_jj("describe", "-m", "parent")
run_jj("new", "-m", "review me")
(repo / "example.txt").write_text("after\n")
change = run_jj("log", "--no-graph", "-r", "@", "-T", "change_id")
# Only the Nix wrappers may supply node, jj, jj-hunk-tool and GNU patch.
# Listing/preview does not invoke patch: a real mutation below must succeed too.
env["PATH"] = ""
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

    def post(path, body):
        request = urllib.request.Request(
            url + path, data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json", "X-Fold-Request": "1"},
            method="POST")
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
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
    print("Installed CLI, bundled runtime tools, browser assets, preview, squash, undo, stateless operation, revision selection and shutdown passed")
finally:
    selector.close()
    if process.poll() is None:
        process.kill()
        process.wait()
    print(output.decode(), end="")
