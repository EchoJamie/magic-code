#!/usr/bin/env python3
"""Signed installation profiles and legacy conversion in disposable user roots."""
import argparse
import http.server
import json
import os
from pathlib import Path
import plistlib
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import time
import uuid
from verify import environment, running


def call(command, room, success=True):
    result = subprocess.run([str(value) for value in command], cwd=room, env=environment(room), capture_output=True, text=True, timeout=60)
    assert (result.returncode == 0) == success, result.stdout + result.stderr
    return json.loads(result.stdout) if result.stdout.startswith('{') else result.stdout


def wait_for(check):
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        value = check()
        if value: return value
        time.sleep(.025)
    raise TimeoutError('isolated component state did not arrive')


def profiles(payload):
    with tempfile.TemporaryDirectory(prefix='magic-components-', dir='/tmp') as temporary:
        root = Path(temporary).resolve(); room = root / 'home'; room.mkdir()
        copied = root / 'Installation.app/Contents/Helpers'; copied.mkdir(parents=True)
        for kind in ['engine', 'cli']: shutil.copy2(payload / ('magic-' + kind), copied / ('magic-' + kind))
        installer = copied / 'magic-engine'
        install = lambda profile, *args: call([installer, 'install', '--profile', profile, '--payload', copied, '--home', room, *args], room)
        installed = install('engine')['components']; engine = Path(installed['engine'])
        control = lambda action, *args: call([engine, 'service', action, '--home', room, *args], room)
        try:
            assert 'cli' not in installed and not (room / '.local/bin/magic').exists()
            assert control('status')['state'] == 'stopped'
            original = control('start')['record']; assert running(original['pid'])
            assert 'app' not in original and '.app/' not in original['source']
            parent = room / 'selected'; parent.mkdir()
            control('switch', '--parent', parent)
            selected = control('status')['record']; inode = engine.stat().st_ino
            terminal = install('terminal'); cli = Path(terminal['components']['cli'])
            assert terminal['reused'] == ['engine'] and terminal['installed'] == ['cli']
            app = install('app')
            assert app['reused'] == ['engine', 'cli'] and app['installed'] == []
            assert engine.stat().st_ino == inode and control('status')['record']['serviceInstance'] == selected['serviceInstance']
            assert Path(app['command']).resolve() == cli
            # Explicit client upgrade keeps the running Engine and data target.
            install('terminal', '--upgrade-cli')
            assert engine.stat().st_ino == inode and control('status')['record']['pid'] == selected['pid']
            # Remove the installer App; all further operations use the registered independent paths.
            shutil.rmtree(root / 'Installation.app')
            requests = []
            class Model(http.server.BaseHTTPRequestHandler):
                def log_message(self, *_): pass
                def do_POST(self):
                    requests.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
                    frame = {'id': 'independent', 'object': 'chat.completion.chunk', 'created': 1, 'model': 'probe',
                             'choices': [{'index': 0, 'delta': {'content': 'INDEPENDENT_COMPONENT_COMPLETE'}, 'finish_reason': 'stop'}]}
                    data = ('data: ' + json.dumps(frame) + '\n\ndata: [DONE]\n\n').encode()
                    self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)
            server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Model)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            try:
                config = parent / '.magic/config.json'
                config.write_text(json.dumps({'future': {'retained': True}, 'workspaceRoots': [str(room)],
                    'providers': {'local': {'protocol': 'chat-completions', 'apiKey': 'synthetic-only', 'baseURL': f'http://127.0.0.1:{server.server_port}/v1'}},
                    'models': {'default': {'provider': 'local', 'model': 'probe'}}}))
                script = room / 'script.json'; script.write_text(json.dumps({'inputs': ['Run after App removal.'], 'timeoutMs': 10000}))
                env = environment(room); env.pop('MAGIC_HOME')
                result = subprocess.run([str(room / '.local/bin/magic'), '--script', str(script)], cwd=room, env=env, capture_output=True, text=True, timeout=20)
                assert result.returncode == 0 and len(requests) == 1, result.stdout + result.stderr
                assert control('status')['record']['serviceInstance'] == selected['serviceInstance']
                db = sqlite3.connect(parent / '.magic/records.db')
                try: session = db.execute('SELECT id FROM sessions').fetchone()[0]
                finally: db.close()
                script.write_text(json.dumps({'inputs': []}))
                resumed = subprocess.run([str(cli), 'resume', session, '--script', str(script)], cwd=room, env=env, capture_output=True, text=True, timeout=20)
                assert resumed.returncode == 0 and len(requests) == 1, resumed.stdout + resumed.stderr
                # The independent Engine can install its own replacement from a separately delivered payload.
                upgraded = call([engine, 'install', '--profile', 'engine', '--payload', payload, '--home', room, '--upgrade-engine'], room)
                assert upgraded['installed'] == ['engine'] and not running(selected['pid'])
                assert control('status')['state'] == 'stopped' and json.loads(config.read_text())['future'] == {'retained': True}
                assert control('start')['record']['base'] == str(parent / '.magic')
                call([engine, 'uninstall', '--component', 'cli', '--home', room], room)
                assert not cli.exists() and control('status')['state'] == 'ready'
                call([engine, 'install', '--profile', 'terminal', '--payload', payload, '--home', room], room)
                call([engine, 'uninstall', '--component', 'engine', '--home', room], room)
                assert not engine.exists() and cli.exists() and config.exists()
            finally: server.shutdown(); server.server_close()
        finally:
            if engine.exists(): control('remove')
        print(json.dumps({'profiles': ['engine', 'terminal', 'app'], 'reuseRunningEngine': True, 'appRemovalPreservedTerminal': True,
                          'explicitClientUpgradePreservedEngine': True, 'scriptAndResume': True, 'engineUpgradeStoppedOldInstance': True,
                          'componentUninstallPreservedData': True}))


def legacy(payload, source):
    with tempfile.TemporaryDirectory(prefix='magic-legacy-', dir='/tmp') as temporary:
        room = Path(temporary).resolve(); app = room / 'Old.app'; helper = app / 'Contents/Helpers/magic-runtime'
        helper.parent.mkdir(parents=True); shutil.copy2(source / 'Contents/Helpers/magic-runtime', helper)
        parent = room / 'selected'; (parent / '.magic').mkdir(parents=True)
        config = parent / '.magic/config.json'; config.write_text('{"future":{"retained":true}}')
        directory = room / 'Library/Application Support/Magic Code/runtime'; directory.mkdir(parents=True)
        discovery = directory / 'host.json'; plist = directory / 'engine.plist'
        label = 'com.magiccode.validation.' + uuid.uuid4().hex + '.engine'
        domain = f'gui/{os.getuid()}'
        definition = {'Label': label, 'ProgramArguments': [str(helper), '--internal-engine', '--home', str(room), '--parent', str(parent),
            '--source', str(helper), '--app', str(app), '--discovery', str(discovery), '--lifecycle', str(uuid.uuid4())],
            'RunAtLoad': True, 'KeepAlive': {'SuccessfulExit': False}, 'WorkingDirectory': str(room)}
        plist.write_bytes(plistlib.dumps(definition)); plist.chmod(0o600)
        command = room / '.local/bin/magic'; command.parent.mkdir(parents=True); command.symlink_to(helper)
        engine = None
        try:
            subprocess.run(['/bin/launchctl', 'bootstrap', domain, str(plist)], check=True)
            old = wait_for(lambda: (record if discovery.exists() and (record := json.loads(discovery.read_text()))['state'] == 'ready' else None))
            args = [payload / 'magic-engine', 'install', '--profile', 'terminal', '--payload', payload, '--home', room, '--legacy-parent', parent]
            refused = call(args, room, success=False)
            assert '明确升级' in refused['error'] and running(old['pid']) and command.resolve() == helper
            installed = call([*args, '--upgrade-engine', '--upgrade-cli'], room)
            engine = Path(installed['components']['engine'])
            assert not running(old['pid']) and command.resolve() == Path(installed['components']['cli'])
            assert json.loads(config.read_text()) == {'future': {'retained': True}}
            shutil.rmtree(app)
            current = call([engine, 'service', 'start', '--home', room], room)['record']
            assert current['base'] == str(parent / '.magic') and current['source'] == str(engine)
            assert 'app' not in current and current['serviceInstance'] != old['serviceInstance']
        finally:
            if engine and engine.exists(): call([engine, 'service', 'remove', '--home', room], room)
            subprocess.run(['/bin/launchctl', 'bootout', domain + '/' + label], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        print(json.dumps({'signedLegacyConversion': True, 'explicitUpgradeRequired': True, 'oldTaskStopped': True, 'selectionAndDataPreserved': True}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('app'); parser.add_argument('--legacy-app')
    args = parser.parse_args(); payload = Path(args.app).resolve() / 'Contents/Helpers'
    profiles(payload)
    if args.legacy_app: legacy(payload, Path(args.legacy_app).resolve())
