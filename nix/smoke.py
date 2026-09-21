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
# Only the Nix wrapper may supply node, jj and jj-hunk-tool.
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
    selection = urllib.request.Request(
        url + "api/revision",
        data=json.dumps({"version": state["version"], "changeId": parent}).encode(),
        headers={"Content-Type": "application/json", "X-Fold-Request": "1"},
        method="POST")
    with urllib.request.urlopen(selection, timeout=10) as response:
        selected = json.load(response)["state"]
    assert selected["source"]["changeId"] == parent, selected
    assert selected["parent"] is None, selected  # Its immediate parent is root.
    assert "immutable" in selected["squashUnavailable"], selected
    assert not (Path(package) / "lib" / "node_modules").exists()
    process.send_signal(signal.SIGTERM)
    assert process.wait(timeout=15) == 0
    print("Installed CLI, bundled runtime tools, browser assets, API and shutdown passed")
finally:
    selector.close()
    if process.poll() is None:
        process.kill()
        process.wait()
    print(output.decode(), end="")
