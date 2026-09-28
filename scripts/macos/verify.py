#!/usr/bin/env python3
"""Isolated native App lifecycle. Never launches Terminal or sends real notifications."""
import json
import os
from pathlib import Path
import selectors
import signal
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


def verify(app, output):
    evidence = []
    for scenario in ['shutdown', 'force-kill']:
        with tempfile.TemporaryDirectory(prefix='magic-native-verify-') as room:
            room = str(Path(room).resolve())
            env = {'HOME': room, 'MAGIC_HOME': room, 'PATH': '/usr/bin:/bin', 'SHELL': '/bin/zsh', 'LANG': 'en_US.UTF-8'}
            args = [str(app / 'Contents/MacOS/MagicCode'), '--validation-root', room]
            if scenario == 'shutdown': args.append('--validation-quit')
            manager_pid = None
            error_path = output / f'app-{scenario}.stderr.log'
            with error_path.open('w') as stderr:
                process = subprocess.Popen(args, env=env, cwd=room, stdout=subprocess.PIPE, stderr=stderr)
                try:
                    event = wait_line(process)
                    discovery_path = Path(event['host'])
                    discovery = json.loads(discovery_path.read_text())
                    manager = json.loads((Path(discovery['socket']).parent / 'manager.json').read_text())
                    manager_pid = manager['pid']
                    assert running(manager_pid)
                    assert discovery['app'] == str(app)
                    assert discovery['dataDir'].startswith(room)
                    assert discovery_path.stat().st_mode & 0o777 == 0o600
                    # A real read-only observer proves protocol and zero-session idle state.
                    if scenario == 'force-kill':
                        observer = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                        observer.settimeout(5)
                        observer.connect(discovery['socket'])
                        observer.sendall((json.dumps({'t': 'hello', 'role': 'observer', **{k: discovery[k] for k in ['protocol', 'version', 'source', 'dataDir']}})+'\n').encode())
                        welcome = json.loads(observer.makefile('rb').readline())
                        assert welcome['t'] == 'native.welcome' and welcome['projection']['works'] == []
                        process.kill()
                        process.wait(timeout=5)
                        deadline = time.monotonic() + 10
                        while running(manager_pid) and time.monotonic() < deadline:
                            time.sleep(0.05)
                        observer.close()
                    else:
                        assert process.wait(timeout=15) == 0
                        assert not discovery_path.exists(), 'normal quit must remove only its generation'
                    assert not running(manager_pid), 'manager survived App lifetime EOF'
                    evidence.append({'scenario': scenario, 'appPID': process.pid, 'managerPID': manager_pid,
                                     'managerExited': True, 'privateDiscovery': True, 'isolatedData': True})
                finally:
                    if process.poll() is None:
                        process.kill(); process.wait(timeout=5)
                    output.joinpath(f'app-{scenario}.stdout.log').write_bytes(process.stdout.read())
                    # Cleanup only a PID started and recorded by this isolated harness.
                    if manager_pid and running(manager_pid):
                        os.kill(manager_pid, signal.SIGTERM)
    output.joinpath('native-lifecycle.json').write_text(json.dumps(evidence, indent=2)+'\n')
    print(json.dumps(evidence))


if __name__ == '__main__':
    verify(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve())
