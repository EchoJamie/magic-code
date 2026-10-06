#!/usr/bin/python3
"""Native state-machine fixture. Only synthetic protocol, socket and trace files."""
import json
import os
from pathlib import Path
import socket
import sys
import threading
import time

base = Path(os.environ['MAGIC_HOME'])
options = json.loads((base / 'control.json').read_text())
host = sys.argv[sys.argv.index('--host-instance') + 1]
identity = {'protocol': 1, 'version': '0.0.0', 'source': options.get('source', os.path.realpath(sys.argv[0])),
            'hostInstance': host, 'serviceInstance': 'controlled-' + host, 'dataDir': str(base / 'data')}
endpoint = '/tmp/magic-native-' + host[:12] + '.sock'
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
            'state': 'idle', 'since': 1, 'gen': None, 'affected': False,
            'notices': [{'id': 'notice-completed', 'session': 'session-completed', 'kind': 'done',
                         'at': 1, 'unread': False, 'delivered': True, 'fact': 'event:1'}]}


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
                barrier = base / 'welcome-barrier.json'
                if barrier.exists(): send(client, {'t': 'native.attached', **json.loads(barrier.read_text())})
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
                if target and (options.get('uncheckedInspect') or message.get('notice') is None or any(n['id'] == message['notice'] for n in target['notices'])):
                    send(client, {'t': 'native.inspected', 'request': message['request'], 'work': target})
                    trace('inspected-sent', request=message['request'])
                else:
                    send(client, {'t': 'native.inspected', 'request': message['request'], 'error': '事项已不可达'})
                    trace('inspected-sent', request=message['request'])
            elif message['t'] in ['native.read', 'native.delivered'] and options.get('systemTest'):
                key = 'unread' if message['t'] == 'native.read' else 'delivered'
                for row in options.get('works', []):
                    for notice in row['notices']:
                        if notice['id'] in message['ids']: notice[key] = key == 'delivered'
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
try:
    time.sleep(0.1)
    emit({'t': 'host.ready', 'identity': identity, 'socket': endpoint,
          'base': str(base / '.magic'), 'config': str(base / '.magic/config.json')})
    if options.get('crash'):
        time.sleep(0.1)
        sys.exit(1)
    count = 0
    for line in sys.stdin:
        message = json.loads(line)
        if message['t'] != 'host.shutdown': continue
        count += 1
        accepting = False
        trace('shutdown', message=message, accepting=accepting)
        for client in clients: send(client, {'t': 'native.projection', 'projection': projection()})
        if options.get('stop') == 'crash': sys.exit(1)
        if count == 1 and options.get('stop') in ['error', 'timeout']:
            if options['stop'] == 'error': emit({'t': 'host.error', 'reason': '受控核销未确认，允许重试'})
            continue
        emit({'t': 'host.stopped', 'request': message['request']})
        trace('stopped-sent')
        if options.get('stop') == 'ack-crash': sys.exit(1)
        if options.get('gateExit'):
            deadline = time.monotonic() + 8
            while not (base / 'allow-exit').exists() and time.monotonic() < deadline: time.sleep(0.01)
        break
finally:
    server.close()
    os.unlink(endpoint)
    trace('exiting')
