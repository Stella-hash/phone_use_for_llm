#!/usr/bin/env python3
"""Give the Linux recorder line-buffered output without a shell or extra packages.

scrcpy's static build buffers stdout when piped; a PTY makes its recorder-open
message observable before input. This is not proof that a video frame arrived.
Only the child started here receives forwarded signals. Video stays in its file.
"""
import errno
import os
import pty
import select
import signal
import subprocess
import sys
import time


def main():
    if len(sys.argv) < 2 or not os.path.isabs(sys.argv[1]):
        raise SystemExit("Expected an absolute recorder executable")
    master, slave = pty.openpty()
    child = None
    interrupted = None

    def stop(_signal, _frame):
        nonlocal interrupted
        interrupted = interrupted or time.monotonic()
        if child and child.poll() is None:
            child.send_signal(signal.SIGINT)

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    try:
        child = subprocess.Popen(sys.argv[1:], stdin=subprocess.DEVNULL, stdout=slave,
                                 stderr=slave, start_new_session=True, close_fds=True)
        os.close(slave)
        slave = None
        while True:
            # scrcpy finalizes the MKV promptly, then gives its Android server
            # about one second to stop. Allow that real teardown before escalation.
            if interrupted and time.monotonic() - interrupted > 1.4 and child.poll() is None:
                child.kill()
            if select.select([master], [], [], .1)[0]:
                try:
                    chunk = os.read(master, 8192)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    break
                if not chunk:
                    break
                sys.stdout.buffer.write(chunk)
                sys.stdout.buffer.flush()
            elif child.poll() is not None:
                break
        return child.wait(timeout=2)
    finally:
        if slave is not None:
            os.close(slave)
        os.close(master)
        if child and child.poll() is None:
            child.send_signal(signal.SIGINT)
            try:
                child.wait(timeout=1.4)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=1)


if __name__ == "__main__":
    sys.exit(main())
