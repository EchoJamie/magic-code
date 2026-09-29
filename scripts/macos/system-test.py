#!/usr/bin/env python3
"""Prepare a signed, isolated native system-test identity. No permission writes by default.

grant/restore require prior human authorization; preparing or inspecting cannot grant it.
"""
import argparse
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile
import time
import uuid


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.next')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n'); temporary.chmod(0o600)
    temporary.replace(path)


def prepare(output):
    assert not (output / 'manifest.json').exists(), 'preserve the existing identity; choose another output'
    native = Path('.artifacts/macos/DerivedData/Build/Products/Debug/Magic Code Dev.app').resolve()
    helper = Path('.artifacts/macos/Magic Code Dev.app/Contents/Helpers/magic-runtime').resolve()
    assert native.exists() and helper.exists(), 'build the native Debug target and helper first'
    root = Path(tempfile.mkdtemp(prefix='magic-system-test-', dir='/tmp')).resolve(); root.chmod(0o700)
    bundle = 'com.magiccode.validation.' + uuid.uuid4().hex + '.dev'
    app = output / 'Magic Code 系统验收.app'
    subprocess.run(['ditto', str(native), str(app)], check=True)
    (app / 'Contents/Helpers').mkdir(exist_ok=True)
    shutil.copy2(helper, app / 'Contents/Helpers/magic-runtime')
    fixture = app / 'Contents/Resources/controlled-helper.py'
    shutil.copy2('apps/macos/MagicCodeTests/Fixtures/controlled-helper.py', fixture); fixture.chmod(0o700)
    plist = app / 'Contents/Info.plist'
    info = plistlib.loads(plist.read_bytes())
    info.update({'CFBundleIdentifier': bundle, 'CFBundleName': 'Magic Code 系统验收',
                 'CFBundleDisplayName': 'Magic Code 系统验收', 'MagicSystemTestRoot': str(root)})
    plist.write_bytes(plistlib.dumps(info))
    write(root / 'control.json', {'systemTest': True, 'source': str(app / 'Contents/Helpers/magic-runtime'), 'works': []})
    with (output / 'signature.log').open('w') as log:
        subprocess.run(['codesign', '--force', '--options', 'runtime', '--timestamp=none', '--sign', '-', str(app)], stdout=log, stderr=log, check=True)
        subprocess.run(['codesign', '--verify', '--deep', '--strict', '--verbose=2', str(app)], stdout=log, stderr=log, check=True)
    write(output / 'manifest.json', {'app': str(app), 'bundle': bundle, 'root': str(root),
          'defaultCapabilities': [], 'realSystemActionsAuthorized': False, 'controlledHost': True,
          'terminalClickPort': 'collector; real compiled Terminal chain is verify-terminal.py',
          'nativeExecutableMtime': (native / 'Contents/MacOS/MagicCode').stat().st_mtime,
          'helperMtime': helper.stat().st_mtime})
    print(output / 'manifest.json')


def state(manifest):
    root = Path(manifest['root'])
    path = root / 'system-state.json'
    return json.loads(path.read_text()) if path.exists() else {'state': 'not-launched', 'defaultCapabilities': []}


def command(root, action): write(root / 'system-command.json', {'action': action, 'id': str(uuid.uuid4())})


def case(root, name):
    control = json.loads((root / 'control.json').read_text())
    now = int(time.time() * 1000)
    def row(letter, kind):
        session = 'system-notification-' + letter
        title = {'A': '通知验收 A：需要答复', 'B': '通知验收 B：失败', 'E': '通知验收 E：结果', 'F': '通知验收 F：勿扰'}.get(letter, '通知验收 ' + letter + '：结果')
        ids = [str(uuid.uuid4()) for _ in range(2 if letter == 'A' else 1)]
        return {'session': session, 'title': title, 'workspace': [str(root / '原生验收')],
                'state': 'waiting' if kind == 'needs-you' else 'idle', 'since': now, 'gen': 1 if kind == 'needs-you' else None,
                'affected': kind == 'needs-you', 'reason': '系统通知隔离验收',
                'notices': [{'id': n, 'session': session, 'kind': kind, 'at': now, 'unread': True, 'delivered': False, 'fact': 'event:' + n} for n in ids]}
    if name == 'empty': control['works'] = []
    elif name == 'A': control['works'] = [row('A', 'needs-you')]
    elif name == 'B': control['works'] = [row('B', 'failed')]
    elif name == 'CD': control['works'] = [row('C', 'done'), row('D', 'done')]
    elif name in ['E', 'F']: control['works'] = [row(name, 'done')]
    elif name == 'default-off': control['works'] = [row('默认关闭', 'done')]
    write(root / 'control.json', control)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'read-only', 'launch', 'status', 'grant', 'case', 'restore-notifications', 'restore-login', 'revoke', 'quit'])
    parser.add_argument('--output', default='.artifacts/macos/system-test')
    parser.add_argument('--allow', choices=['notifications', 'login', 'n7'], action='append', default=[])
    parser.add_argument('--authorization', help='exact prior human approval reference; never inferred from this script')
    parser.add_argument('--case', choices=['empty', 'default-off', 'A', 'B', 'CD', 'E', 'F'])
    parser.add_argument('--show-status', action='store_true')
    args = parser.parse_args(); output = Path(args.output).resolve(); output.mkdir(parents=True, exist_ok=True)
    if args.action == 'prepare': prepare(output)
    else:
        manifest = json.loads((output / 'manifest.json').read_text()); root = Path(manifest['root'])
        assert root.parent == Path('/private/tmp') and root.name.startswith('magic-system-test-')
        authorization = root / 'system-authorization.json'
        if args.action in ['read-only', 'launch']:
            if args.action == 'read-only': assert not authorization.exists(), 'read-only run requires no capability grant'
            flags = ['--validation-quit'] if args.action == 'read-only' else []
            if args.show_status: flags.append('--validation-show-status')
            with (output / (args.action + '.stdout.jsonl')).open('w') as stdout, (output / (args.action + '.stderr.log')).open('w') as stderr:
                process = subprocess.Popen([str(Path(manifest['app']) / 'Contents/MacOS/MagicCode'), *flags],
                    cwd=root, env={'HOME': str(root), 'PATH': '/usr/bin:/bin', 'SHELL': '/bin/zsh', 'LANG': 'zh_CN.UTF-8'}, stdout=stdout, stderr=stderr)
                if args.action == 'read-only':
                    try: assert process.wait(timeout=20) == 0
                    finally:
                        if process.poll() is None: process.kill(); process.wait(timeout=5)
                    found = state(manifest)
                    assert found.get('notificationWritesAllowed') is False and found.get('loginWritesAllowed') is False
                    # 两格各说各的：系统那格读原始授权（新身份 0=未问过）；偏好那格「提醒我」默认开。
                    assert found.get('notificationAuthorizationStatus') == 0
                    assert found.get('notificationPreference') is True
                    assert not (root / 'system-notification-requests.json').exists()
                    write(output / 'read-only-state.json', found)
                else:
                    write(output / 'launch.json', {'pid': process.pid})
                    try: process.wait()
                    finally:
                        if process.poll() is None: process.kill(); process.wait(timeout=5)
        elif args.action == 'status': print(json.dumps(state(manifest), ensure_ascii=False, indent=2))
        elif args.action == 'grant':
            assert args.authorization and args.allow, 'requires explicit prior authorization reference and bounded capabilities'
            write(authorization, {'bundle': manifest['bundle'], 'allow': args.allow, 'authorization': args.authorization})
            write(output / 'authorization-record.json', json.loads(authorization.read_text()))
        elif args.action == 'revoke':
            found = state(manifest)
            granted = json.loads(authorization.read_text()).get('allow', []) if authorization.exists() else []
            # 通知侧不再有「App 偏好」可核（权限是系统的状态，回收在系统设置里、只有用户能做）；
            # 这里只保留登录项那条可核的恢复前置。
            if 'login' in granted:
                assert found.get('loginStatus') in [0, 3], 'restore authorized login item before revoking'
            if authorization.exists(): authorization.unlink()
        elif args.action == 'case':
            assert args.case
            if args.case == 'F': assert 'n7' in json.loads(authorization.read_text())['allow'], 'N7 requires separate authorization'
            case(root, args.case)
        elif args.action.startswith('restore-'):
            capability = 'notifications' if args.action == 'restore-notifications' else 'login'
            assert capability in json.loads(authorization.read_text())['allow'], 'restore uses system APIs and requires the same explicit authorization'
            command(root, args.action)
        elif args.action == 'quit':
            case(root, 'empty'); time.sleep(0.5); command(root, 'quit')
