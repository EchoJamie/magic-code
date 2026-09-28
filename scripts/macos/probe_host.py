"""Private stdin host for signed helper probes; never asks LaunchServices to start an App."""
from contextlib import contextmanager
import json
from pathlib import Path
import plistlib
import queue
import subprocess
import threading
import uuid


@contextmanager
def isolated_host(helper, room, env):
    app = helper.parent.parent.parent
    bundle = plistlib.loads((app / 'Contents/Info.plist').read_bytes())['CFBundleIdentifier']
    host = str(uuid.uuid4())
    discovery = room / 'Library/Application Support' / ('Magic Code Dev' if bundle.endswith('.dev') else 'Magic Code') / 'runtime/host.json'
    events = queue.Queue()
    with (room / 'probe-host.stderr.log').open('w') as error:
        process = subprocess.Popen([str(helper), '--internal-manager', '--host-instance', host, '--app', str(app)],
            cwd=room, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=error, text=True)
        def collect():
            for line in process.stdout:
                events.put(json.loads(line))
        reader = threading.Thread(target=collect, daemon=True); reader.start()
        try:
            ready = events.get(timeout=20)
            assert ready['t'] == 'host.ready', ready
            assert ready['identity']['hostInstance'] == host and ready['identity']['source'] == str(helper)
            discovery.parent.mkdir(parents=True, mode=0o700)
            discovery.write_text(json.dumps({**ready['identity'], 'socket': ready['socket'], 'base': ready['base'], 'app': str(app)}))
            discovery.chmod(0o600)
            yield ready
        finally:
            # Pipe EOF is the host's real lifetime boundary, even after a failed probe.
            process.stdin.close()
            try:
                assert process.wait(timeout=20) == 0, 'probe host failed to reclaim its work'
                reader.join(timeout=2)
                stopped = []
                while not events.empty(): stopped.append(events.get_nowait())
                assert any(event['t'] == 'host.stopped' for event in stopped), stopped
            finally:
                if process.poll() is None: process.kill(); process.wait(timeout=5)
                if discovery.exists() and json.loads(discovery.read_text())['hostInstance'] == host: discovery.unlink()
