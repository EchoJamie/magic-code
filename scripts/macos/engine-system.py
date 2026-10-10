#!/usr/bin/env python3
"""Prepare a unique Debug App, then explicitly run real launchd/CLI checks."""
import argparse
import json
import os
from pathlib import Path
import plistlib
import signal
import subprocess
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from verify import environment, prepare_app, running, stop_engine


def wait_for(check, seconds=25):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        value = check()
        if value: return value
        time.sleep(.05)
    raise TimeoutError('required lifecycle state did not arrive')


def run(room):
    app = room / 'Magic Code.app'
    info = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
    assert info['CFBundleIdentifier'].startswith('com.magiccode.validation.')
    assert info['MagicSystemTestRoot'] == str(room)
    helper = app / 'Contents/Helpers/magic-runtime'
    native = app / 'Contents/MacOS/MagicCode'
    env = environment(room)
    # MAGIC_HOME is explicit only for the first default-instance checks.
    def control(action, *args):
        result = subprocess.run([str(native), '--internal-engine-control', action, '--validation-root', str(room), *args],
            cwd=room, env=env, text=True, capture_output=True, timeout=60)
        value = json.loads(result.stdout)
        assert result.returncode == (1 if value['state'] == 'failed' else 0), result.stdout + result.stderr
        return value
    def cli(action):
        result = subprocess.run([str(helper), 'engine', action], cwd=room, env=env, text=True, capture_output=True, timeout=60)
        assert result.returncode == 0, result.stdout + result.stderr
        return result.stdout
    try:
        assert control('status')['state'] == 'stopped'
        cli('status')
        assert control('status')['state'] == 'stopped'
        with ThreadPoolExecutor(max_workers=3) as pool:
            list(pool.map(cli, ['start', 'start', 'start']))
        first = control('status'); assert first['state'] == 'ready'
        first = first['record']; assert first['base'] == str(room / '.magic')
        definition = plistlib.loads((room / 'Library/Application Support/Magic Code/runtime/engine.plist').read_bytes())
        assert definition['Label'] == info['CFBundleIdentifier'] + '.engine'
        assert definition['KeepAlive'] == {'SuccessfulExit': False}
        assert definition['ProgramArguments'][0] == str(helper)
        assert 'EnvironmentVariables' not in definition
        assert not (room / 'Library/LaunchAgents').exists()
        os.kill(first['pid'], signal.SIGKILL)
        recovered = wait_for(lambda: (value if (value := control('status'))['state'] == 'ready' and value['record']['serviceInstance'] != first['serviceInstance'] else None))
        assert recovered['record']['base'] == first['base']
        assert control('stop', '--expected', json.dumps({key: first[key] for key in ['protocol', 'version', 'source', 'serviceInstance', 'base']}))['state'] == 'failed'
        assert control('status')['record']['serviceInstance'] == recovered['record']['serviceInstance']
        cli('stop'); assert control('status')['state'] == 'stopped'
        assert not running(recovered['record']['pid'])
        cli('status'); assert control('status')['state'] == 'stopped'
        other = room / 'selected'; other.mkdir()
        switched = control('switch', '--parent', str(other))
        assert switched['state'] == 'stopped' and switched['base'] == str(other / '.magic')
        env.pop('MAGIC_HOME')
        cli('start')
        selected = control('status')['record']; assert selected['base'] == str(other / '.magic')
        definition = plistlib.loads((room / 'Library/Application Support/Magic Code/runtime/engine.plist').read_bytes())
        assert definition['ProgramArguments'][definition['ProgramArguments'].index('--parent') + 1] == str(other)
        os.kill(selected['pid'], signal.SIGKILL)
        after = wait_for(lambda: (value if (value := control('status'))['state'] == 'ready' and value['record']['serviceInstance'] != selected['serviceInstance'] else None))
        assert after['record']['base'] == selected['base']
        cli('stop')
        config = other / '.magic/config.json'; config.write_text('{broken')
        failed = control('start'); assert failed['state'] == 'failed' and failed.get('error')
        pid = failed['record'].get('pid')
        if pid: wait_for(lambda: not running(pid))
        assert control('status')['state'] == 'failed'
        config.write_text('{}')
        cli('start'); assert control('status')['state'] == 'ready'
        cli('stop')
        print(json.dumps({'parallelCLIStart': True, 'noGraphicalApp': True, 'idleCrashRecovery': True,
                          'oldGenerationRejected': True, 'nonDefaultInstanceRecovery': True,
                          'startupErrorAndRepair': True, 'explicitStop': True}))
    finally:
        stop_engine(app, room)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--prepare', metavar='DEBUG_APP'); mode.add_argument('--run', metavar='PREPARED_ROOT')
    args = parser.parse_args()
    if args.prepare:
        room = Path(tempfile.mkdtemp(prefix='magic-system-test-', dir='/tmp')).resolve()
        prepare_app(Path(args.prepare).resolve(), room)
        print(room)
    else:
        run(Path(args.run).resolve())
