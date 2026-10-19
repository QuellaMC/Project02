"""Runs the command on a pseudo-terminal: its stdin, stdout and stderr are
one terminal, relayed from this process's stdin and to its stdout, and
its exit code becomes this process's. The command stays in this process
group, so a signal to the group reaches it; this process leaves signals
to it. An end of this process's stdin closes the terminal."""

import os
import pty
import select
import signal
import sys

master, slave = pty.openpty()
pid = os.fork()
if pid == 0:
    os.close(master)
    os.dup2(slave, 0)
    os.dup2(slave, 1)
    os.dup2(slave, 2)
    os.close(slave)
    os.execvp(sys.argv[1], sys.argv[1:])
os.close(slave)
for name in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
    signal.signal(name, signal.SIG_IGN)
inputs = [master, 0]
while master in inputs:
    readable, _, _ = select.select(inputs, [], [])
    if 0 in readable:
        typed = os.read(0, 65536)
        if typed:
            os.write(master, typed)
        else:
            inputs.remove(0)
            os.close(master)
            inputs.remove(master)
            continue
    if master in readable:
        try:
            shown = os.read(master, 65536)
        except OSError:
            shown = b""
        if shown:
            os.write(1, shown)
        else:
            inputs.remove(master)
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
