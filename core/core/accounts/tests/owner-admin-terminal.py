"""Exercise the real CLI with a controlling terminal; fixture credentials only."""
import errno
import fcntl
import os
import pty
import select
import subprocess
import sys
import termios
import time

binary, root = sys.argv[1:]

def invoke(action, entries, expected):
    master, slave = pty.openpty()
    original = termios.tcgetattr(slave)
    def controlling_terminal():
        os.setsid()
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    env = dict(os.environ, DISPATCH_LOCAL_ROOT=root)
    child = subprocess.Popen([binary, action], stdin=slave, stdout=slave, stderr=slave,
                             env=env, preexec_fn=controlling_terminal)
    transcript = b''
    position = 0
    deadline = time.monotonic() + 8
    try:
        while time.monotonic() < deadline:
            ready, _, _ = select.select([master], [], [], 0.1)
            if ready:
                try:
                    chunk = os.read(master, 8192)
                except OSError as error:
                    if error.errno == errno.EIO:
                        break
                    raise
                transcript += chunk
                if position < len(entries):
                    prompt, value = entries[position]
                    if prompt.encode() in transcript:
                        assert not termios.tcgetattr(slave)[3] & termios.ECHO, 'input echo enabled'
                        os.write(master, (value + '\n').encode())
                        position += 1
            if child.poll() is not None:
                break
        assert child.wait(timeout=1) == 0, transcript.decode()
        assert expected.encode() in transcript, transcript.decode()
        for _, value in entries:
            if value:
                assert value.encode() not in transcript, 'credential echoed'
        assert termios.tcgetattr(slave) == original, 'terminal mode not restored'
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
        os.close(slave)

invoke('owner-create', [('Owner email:', 'terminal@example.test'), ('First name:', 'Fixture'),
                       ('Last name:', 'Administrator'), ('New password (12', 'terminal fixture initial password'),
                       ('Confirm new password:', 'terminal fixture initial password')], 'platform_owner_created')
invoke('owner-recover', [('Current owner email:', 'terminal@example.test'), ('New owner email (', 'terminal-new@example.test'),
                        ('New password (12', 'terminal fixture replacement password'),
                        ('Confirm new password:', 'terminal fixture replacement password')], 'platform_owner_recovered')
