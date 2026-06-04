#!/usr/bin/env python3
import fcntl
import json
import os
import pty
import signal
import struct
import sys
import termios
import threading


write_lock = threading.Lock()
master_fd = None
child_pid = None


def emit(payload):
    with write_lock:
        sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
        sys.stdout.flush()


def set_winsize(fd, rows=24, cols=100):
    try:
        packed = struct.pack("HHHH", rows, cols, 0, 0)
        fcntl.ioctl(fd, termios.TIOCSWINSZ, packed)
    except Exception:
        pass


def read_loop():
    decoder_errors = "replace"
    while True:
        try:
            data = os.read(master_fd, 8192)
        except OSError as error:
            emit({"type": "error", "message": str(error)})
            return

        if not data:
            return

        text = data.decode("utf-8", decoder_errors)
        answer_terminal_queries(text)
        emit({"type": "output", "text": text})


def answer_terminal_queries(text):
    responses = []
    if "\x1b[6n" in text:
        responses.append("\x1b[1;1R")
    if "\x1b[c" in text:
        responses.append("\x1b[?1;2c")
    if "\x1b[>c" in text:
        responses.append("\x1b[>0;276;0c")
    if "\x1b]10;?" in text:
        responses.append("\x1b]10;rgb:ffff/ffff/ffff\x1b\\")
    if "\x1b]11;?" in text:
        responses.append("\x1b]11;rgb:0000/0000/0000\x1b\\")

    for response in responses:
        try:
            os.write(master_fd, response.encode("utf-8"))
        except OSError:
            return


def command_loop():
    global child_pid
    for line in sys.stdin:
        try:
            message = json.loads(line)
        except json.JSONDecodeError as error:
            emit({"type": "error", "message": f"invalid command json: {error}"})
            continue

        kind = message.get("type")
        if kind == "write":
            text = message.get("text", "")
            if master_fd is not None:
                os.write(master_fd, text.encode("utf-8"))
        elif kind == "resize":
            set_winsize(master_fd, int(message.get("rows", 24)), int(message.get("cols", 100)))
        elif kind == "stop":
            if child_pid:
                try:
                    os.killpg(child_pid, signal.SIGTERM)
                except Exception:
                    try:
                        os.kill(child_pid, signal.SIGTERM)
                    except Exception:
                        pass
            return


def main():
    global master_fd, child_pid
    args = sys.argv[1:]
    if args and args[0] == "--":
        args = args[1:]
    if not args:
        emit({"type": "error", "message": "missing command"})
        sys.exit(2)

    env = os.environ.copy()
    env["TERM"] = env.get("TERM") if env.get("TERM") and env.get("TERM") != "dumb" else "xterm-256color"
    env.setdefault("COLORTERM", "truecolor")

    child_pid, master_fd = pty.fork()
    if child_pid == 0:
        os.environ.clear()
        os.environ.update(env)
        os.execvpe(args[0], args, env)

    set_winsize(master_fd)
    flags = fcntl.fcntl(master_fd, fcntl.F_GETFL)
    fcntl.fcntl(master_fd, fcntl.F_SETFL, flags & ~os.O_NONBLOCK)
    emit({"type": "ready", "pid": child_pid})

    reader = threading.Thread(target=read_loop, daemon=True)
    reader.start()

    try:
        command_loop()
    finally:
        if child_pid:
            try:
                os.killpg(child_pid, signal.SIGTERM)
            except Exception:
                try:
                    os.kill(child_pid, signal.SIGTERM)
                except Exception:
                    pass
        try:
            _, status = os.waitpid(child_pid, 0)
            code = os.waitstatus_to_exitcode(status)
        except Exception:
            code = 0
        emit({"type": "exit", "code": code})


if __name__ == "__main__":
    main()
