#!/usr/bin/env python3
"""Run a command in a pseudo-terminal of a fixed size, relaying stdin to it and
its output to stdout. Used only to record the demo; standard library only."""
import fcntl
import os
import pty
import select
import struct
import sys
import termios


def main() -> int:
    cols, rows = int(sys.argv[1]), int(sys.argv[2])
    argv = sys.argv[3:]
    pid, fd = pty.fork()
    if pid == 0:
        # In the child, stdin is the terminal: give it its size before the program starts.
        fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        os.execvp(argv[0], argv)
    stdin_open = True
    while True:
        readable = [fd] + ([sys.stdin.fileno()] if stdin_open else [])
        ready, _, _ = select.select(readable, [], [])
        if fd in ready:
            try:
                data = os.read(fd, 65536)
            except OSError:
                data = b""
            if not data:
                break
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
        if stdin_open and sys.stdin.fileno() in ready:
            data = os.read(sys.stdin.fileno(), 1024)
            if data:
                os.write(fd, data)
            else:
                stdin_open = False
    _, status = os.waitpid(pid, 0)
    return os.waitstatus_to_exitcode(status)


if __name__ == "__main__":
    sys.exit(main())
