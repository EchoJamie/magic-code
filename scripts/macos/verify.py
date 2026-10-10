#!/usr/bin/env python3
"""Isolated native App lifecycle. Never launches Terminal or sends real notifications."""
import json
import os
from pathlib import Path
import selectors
import plistlib
import shutil
import uuid
from contextlib import contextmanager
import socket
import subprocess
import sys
import tempfile
import time


def wait_line(process, timeout=25):
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    try:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if selector.select(max(0, deadline - time.monotonic())):
                line = process.stdout.readline()
                if not line:
                    raise RuntimeError('App stdout closed before ready')
                event = json.loads(line)
                if event['event'] == 'app.error':
                    raise RuntimeError(event['reason'])
                if event['event'] == 'app.ready':
                    return event
        raise TimeoutError('App ready did not arrive')
    finally:
        selector.close()


def running(pid):
    try:
        os.kill(pid, 0)
        # A reaped-by-launchd zombie is no longer executing.
        return not subprocess.check_output(['ps', '-o', 'stat=', '-p', str(pid)], text=True).strip().startswith('Z')
    except (ProcessLookupError, subprocess.CalledProcessError):
        return False


def prepare_app(source, room):
    """Create a reviewable copy without launching or registering it."""
    room = room.resolve()
    assert room.parent == Path('/private/tmp') and room.name.startswith('magic-system-test-')
    app = room / 'Magic Code.app'
    shutil.copytree(source, app)
    info = app / 'Contents/Info.plist'
    data = plistlib.loads(info.read_bytes())
    data['CFBundleIdentifier'] = 'com.magiccode.validation.' + uuid.uuid4().hex + '.dev'
    data['MagicSystemTestRoot'] = str(room)
    info.write_bytes(plistlib.dumps(data))
    assert not (app / 'Contents/Resources/controlled-helper.py').exists(), 'real Engine required'
    subprocess.run(['codesign', '--force', '--options', 'runtime', '--timestamp=none', '--sign',
                    os.environ.get('MAGIC_SIGN_IDENTITY', 'Apple Development: echojamieee@outlook.com (9JHY98AJMC)'), str(app)], check=True)
    return app


@contextmanager
def isolated_app(source):
    """Unique bundle/launchd identity; callers authorize system use."""
    with tempfile.TemporaryDirectory(prefix='magic-system-test-', dir='/tmp') as temporary:
        room = Path(temporary).resolve()
        app = prepare_app(source, room)
        try:
            yield app, room
        finally:
            stop_engine(app, room)


def environment(room):
    return {'HOME': str(room), 'MAGIC_HOME': str(room), 'PATH': '/usr/bin:/bin', 'SHELL': '/bin/zsh', 'LANG': 'en_US.UTF-8'}


def stop_engine(app, room):
    info = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
    assert info['CFBundleIdentifier'].startswith('com.magiccode.validation.') and info['MagicSystemTestRoot'] == str(room)
    result = subprocess.run([str(app / 'Contents/MacOS/MagicCode'), '--internal-engine-control', 'stop', '--validation-root', str(room)],
                            env=environment(room), cwd=room, capture_output=True, text=True, timeout=40)
    assert result.returncode == 0 and json.loads(result.stdout)['state'] == 'stopped', result.stdout + result.stderr


def verify(source):
    evidence = []
    with isolated_app(source) as (app, room):
        for scenario in ['shutdown', 'force-kill']:
            args = [str(app / 'Contents/MacOS/MagicCode')]
            if scenario == 'shutdown': args.append('--validation-quit')
            with (room / 'app.stderr.log').open('w') as stderr:
                process = subprocess.Popen(args, env=environment(room), cwd=room, stdout=subprocess.PIPE, stderr=stderr)
                second = None
                try:
                    event = wait_line(process)
                    discovery_path = Path(event['host'])
                    discovery = json.loads(discovery_path.read_text())
                    engine = discovery['pid']
                    assert running(engine) and discovery['app'] == str(app)
                    assert discovery['base'].startswith(str(room) + '/')
                    assert discovery_path.stat().st_mode & 0o777 == 0o600
                    if scenario == 'force-kill': process.kill()
                    process.wait(timeout=15)
                    assert running(engine), 'App exit stopped Engine'
                    second = subprocess.Popen([str(app / 'Contents/MacOS/MagicCode')], env=environment(room), cwd=room, stdout=subprocess.PIPE, stderr=stderr)
                    next_record = json.loads(Path(wait_line(second)['host']).read_text())
                    assert next_record['pid'] == engine and next_record['serviceInstance'] == discovery['serviceInstance']
                    stop_engine(app, room)
                    assert not running(engine), 'explicit Engine stop did not finish'
                    evidence.append({'scenario': scenario, 'appExitPreservedEngine': True, 'reopenReusedEngine': True, 'explicitStopFinished': True})
                finally:
                    for child in [process, second]:
                        if child and child.poll() is None: child.kill(); child.wait(timeout=5)
    print(json.dumps(evidence))


if __name__ == '__main__':
    verify(Path(sys.argv[1]).resolve())
