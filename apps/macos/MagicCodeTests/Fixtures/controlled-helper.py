#!/usr/bin/python3
"""Native state-machine fixture. Only synthetic protocol, socket and trace files."""
import json
import os
from pathlib import Path
import socket
import sys
import threading
import time

import subprocess
import uuid

base = Path(sys.argv[sys.argv.index('--home') + 1])
options = json.loads((base / 'control.json').read_text())
state_file = base / 'engine.json'
if sys.argv[1] == 'service':
    action = sys.argv[2]
    def status():
        return json.loads(state_file.read_text()) if state_file.exists() else {'state': 'stopped', 'base': str(base / '.magic'), 'alive': False}
    current = status()
    if action == 'start' and current['state'] == 'stopped':
        (base / 'stop-request').unlink(missing_ok=True)
        subprocess.Popen([sys.executable, sys.argv[0], '--serve', '--home', str(base)], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        deadline = time.monotonic() + 5
        while current['state'] != 'ready' and time.monotonic() < deadline:
            time.sleep(.01); current = status()
    elif action == 'switch':
        if any(work.get('affected') for work in options.get('works', [])):
            current = {**current, 'state': 'failed', 'error': '仍有所属工作责任，无法切换基础路径'}
    elif action in ['stop', 'remove'] and current.get('alive'):
        request = sys.argv[sys.argv.index('--request') + 1]
        if options.get('stop') == 'error' and not (base / 'failed-once').exists():
            (base / 'failed-once').touch()
            current = {**current, 'state': 'failed', 'error': '受控核销失败'}
        else:
            (base / 'stop-request').write_text(request)
            deadline = time.monotonic() + 5
            while current['state'] != 'stopped' and time.monotonic() < deadline:
                time.sleep(.01); current = status()
    print(json.dumps(current)); sys.exit(0)
host = str(uuid.uuid4())
identity = {'protocol': 1, 'version': options.get('version', '0.0.0'), 'source': options.get('source', str(Path(sys.argv[0]).resolve())),
            'serviceInstance': 'controlled-' + host, 'base': str(base / '.magic')}
endpoint = '/tmp/magic-native-' + host[:12] + '.sock'
record = {**identity, 'socket': endpoint, 'lifecycle': host, 'state': 'ready', 'pid': os.getpid()}
def publish(state):
    value = {'state': state, 'base': identity['base'], 'alive': state != 'stopped', 'record': {**record, 'state': state}}
    temporary = base / 'engine.tmp'; temporary.write_text(json.dumps(value)); os.replace(temporary, state_file)
mutex = threading.Lock()
clients = []
accepting = True
revision = 0


def trace(event, **values):
    with mutex:
        with (base / 'trace.jsonl').open('a') as out:
            out.write(json.dumps({'event': event, **values}) + '\n')


def emit(message):
    print(json.dumps(message), flush=True)


def work():
    return {'session': 'session-completed', 'title': '已经处理的事项', 'workspace': [str(base)],
            'state': 'idle', 'since': 1, 'gen': None, 'affected': False, 'archived': False, 'canArchive': True, 'terminalOpen': False,
            'currentNotice': {'id': 'notice-completed', 'session': 'session-completed', 'kind': 'done',
                         'at': 1, 'unread': False, 'delivered': True, 'fact': 'event:1', 'source': {'session': 'session-completed', 'entry': 1}}}


def projection():
    global revision
    revision += 1
    return {'serviceInstance': identity['serviceInstance'], 'revision': options.get('revision', revision),
            'accepting': accepting, 'works': options.get('works', [work()] if options.get('notice') else [])}


def send(client, message):
    try: client.sendall((json.dumps(message) + '\n').encode())
    except OSError: pass


def observe(client):
    clients.append(client)
    try:
        for line in client.makefile('rb'):
            message = json.loads(line)
            trace('observer', message=message)
            if message['t'] == 'hello':
                value = projection()
                trace('welcome-sent', projection=value)
                send(client, {'t': 'native.welcome', 'identity': identity, 'projection': value})
            elif message['t'] == 'native.sessions':
                rows = options.get('works', [work()] if options.get('notice') else [])
                sessions = [{'id': row['session'], 'title': row['title'], 'at': row['since'], 'workspace': row['workspace'],
                             'state': row['state'], 'archived': row['archived'], 'canArchive': row['canArchive'], 'terminalOpen': row['terminalOpen']}
                            for row in rows if row['archived'] == message.get('archived', False)
                            and message.get('search', '').lower() in row['title'].lower()
                            and (not message.get('workspace') or message['workspace'] == row['workspace'])]
                send(client, {'t': 'native.sessions.result', 'request': message['request'], 'serviceInstance': identity['serviceInstance'], 'sessions': sessions})
            elif message['t'] == 'native.history':
                send(client, {'t': 'native.history.result', 'request': message['request'], 'serviceInstance': identity['serviceInstance'], 'session': message['session'],
                              'entries': options.get('entries', [{'id': 1, 'kind': 'assistant', 'content': {'text': '保存的完整回复'}, 'at': 1}]), 'events': options.get('events', []), 'done': True})
            elif message['t'] == 'native.session.manage':
                results = []
                rows = options.get('works', [])
                for item in message['items']:
                    row = next((row for row in rows if row['session'] == item['session']), None)
                    ok = row is not None and message['serviceInstance'] == identity['serviceInstance']
                    if ok and item['action'] == 'archive': ok = row['canArchive']
                    if ok:
                        if item['action'] == 'rename': row['title'] = item['title']
                        else: row['archived'] = item['action'] == 'archive'
                    results.append({**item, 'ok': ok, **({'archived': row['archived']} if ok else {'error': '资格已变化'})})
                send(client, {'t': 'native.session.managed', 'request': message['request'], 'serviceInstance': identity['serviceInstance'], 'results': results})
            elif message['t'] == 'native.inspect':
                target = next((row for row in options.get('works', [work()]) if row['session'] == message['session']), None)
                if options.get('inspectGate'):
                    trace('inspect-waiting')
                    deadline = time.monotonic() + 5
                    while not (base / 'allow-inspect').exists() and time.monotonic() < deadline: time.sleep(.01)
                    target = options.get('inspectWork', target)
                    if options.get('systemTest') and target:
                        options['works'] = [target if row['session'] == message['session'] else row for row in options['works']]
                        temporary = base / 'control-inspect.json'
                        temporary.write_text(json.dumps(options)); os.replace(temporary, base / 'control.json')
                target = options.get('inspectWork', target)
                if target and (options.get('uncheckedInspect') or message.get('notice') is None or target.get('currentNotice', {}).get('id') == message['notice']):
                    send(client, {'t': 'native.inspected', 'request': message['request'], 'work': target})
                    trace('inspected-sent', request=message['request'])
                else:
                    send(client, {'t': 'native.inspected', 'request': message['request'], 'error': '事项已不可达'})
                    trace('inspected-sent', request=message['request'])
            elif message['t'] in ['native.read', 'native.delivered'] and options.get('systemTest'):
                key = 'unread' if message['t'] == 'native.read' else 'delivered'
                for row in options.get('works', []):
                    notice = row.get('currentNotice')
                    if notice and notice['id'] in message['ids']: notice[key] = key == 'delivered'
                temporary = base / 'control-ack.json'
                temporary.write_text(json.dumps(options)); os.replace(temporary, base / 'control.json')
                for observer in clients: send(observer, {'t': 'native.projection', 'projection': projection()})
    finally:
        client.close()


server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
server.bind(endpoint)
server.listen()


def accept():
    while True:
        try: client, _ = server.accept()
        except OSError: return
        threading.Thread(target=observe, args=(client,), daemon=True).start()


threading.Thread(target=accept, daemon=True).start()

def watch_control():
    global options
    while True:
        time.sleep(0.2)
        command_file = base / 'observer-command.json'
        if options.get('observerControl') and command_file.exists():
            command = json.loads(command_file.read_text()); command_file.unlink()
            trace('observer-command', command=command)
            for observer in clients:
                if command.get('disconnect'):
                    try: observer.shutdown(socket.SHUT_RDWR)
                    except OSError: pass
                elif 'messages' in command:
                    for message in command['messages']: send(observer, message)
                elif 'message' in command: send(observer, command['message'])
        try: latest = json.loads((base / 'control.json').read_text())
        except (OSError, ValueError): continue
        if latest != options:
            options = latest
            for observer in clients: send(observer, {'t': 'native.projection', 'projection': projection()})

if options.get('systemTest') or options.get('observerControl'): threading.Thread(target=watch_control, daemon=True).start()
trace('started', identity=identity)
publish('ready')
try:
    while not (base / 'stop-request').exists(): time.sleep(.01)
    trace('shutdown', message={'request': (base / 'stop-request').read_text()})
    accepting = False
finally:
    server.close()
    for client in clients:
        try: client.shutdown(socket.SHUT_RDWR)
        except OSError: pass
    os.unlink(endpoint)
    publish('stopped')
    trace('exiting')
