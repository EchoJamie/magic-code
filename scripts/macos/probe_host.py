"""Direct isolated Engine for compiled helper checks; no launchd or graphical App."""
from contextlib import contextmanager
import json
import subprocess
import time
import threading
import uuid


@contextmanager
def isolated_host(helper, room, env):
    app = helper.parent.parent.parent
    discovery = room / 'Library/Application Support/Magic Code/runtime/host.json'
    identity = {'home': str(room), 'parent': str(room), 'source': str(helper),
                'app': str(app), 'discovery': str(discovery)}
    with (room / 'engine.stderr.log').open('w') as error:
        process = subprocess.Popen([str(helper), '--internal-engine', '--home', str(room),
            '--parent', str(room), '--source', str(helper), '--app', str(app),
            '--discovery', str(discovery), '--lifecycle', str(uuid.uuid4())],
            cwd=room, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=error)
        threading.Thread(target=process.wait, daemon=True).start()
        record = None
        try:
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                if discovery.exists():
                    record = json.loads(discovery.read_text())
                    if record['state'] == 'ready': break
                if process.poll() is not None: raise RuntimeError('isolated Engine exited before ready')
                time.sleep(0.025)
            assert record and record['state'] == 'ready' and record['pid'] == process.pid, record
            yield record
        finally:
            try:
                if discovery.exists():
                    record = json.loads(discovery.read_text())
                    request = {**identity, 'action': 'stop' if process.poll() is None else 'reclaim',
                               'request': 'probe-close', 'expected': record}
                    result = subprocess.run([str(helper), '--internal-engine-call'], input=json.dumps(request),
                        text=True, capture_output=True, env=env, cwd=room, timeout=55)
                    assert result.returncode == 0 and json.loads(result.stdout)['state'] == 'stopped', result.stdout + result.stderr
                assert process.wait(timeout=20) == 0, 'isolated Engine failed to reclaim its work'
            finally:
                if process.poll() is None: process.kill(); process.wait(timeout=5)
