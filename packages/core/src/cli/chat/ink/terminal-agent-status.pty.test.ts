import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const hasPython = spawnSync("python3", ["--version"]).status === 0;
for (const mode of ["ink", "basic"]) {
  test(
    `real PTY ${mode} status control survives rendering, resize and exit`,
    {
      skip: process.platform === "win32" || !hasPython,
      timeout: 30_000,
    },
    async () => {
      const script = String.raw`
import os, pty, subprocess, sys, tempfile, select, time, fcntl, termios, struct, signal
node, fixture, mode = sys.argv[1:]
with tempfile.TemporaryDirectory(prefix='roll-status-pty-') as d:
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 35, 120, 0, 0))
    env = dict(os.environ, HC_TERMINAL_ID='t-pty-fixture', TERM='xterm-256color')
    env.pop('CI', None)
    proc = subprocess.Popen([node, '--experimental-strip-types', '--experimental-sqlite', fixture, mode, d],
                            stdin=slave, stdout=slave, stderr=slave, env=env)
    os.close(slave)
    data = bytearray()
    all_data = bytearray()
    def until(fields):
        needle = ('\x1b]7501;' + fields + '\x1b\\').encode()
        deadline = time.monotonic() + 8
        while needle not in data:
            if time.monotonic() > deadline: raise AssertionError('Missing '+fields+' '+repr(bytes(data[-2500:])))
            if select.select([master], [], [], .1)[0]:
                try: chunk = os.read(master, 65536)
                except OSError: chunk = b''
                if not chunk: raise AssertionError('PTY closed before '+fields+' '+repr(bytes(data[-2500:])))
                data.extend(chunk); all_data.extend(chunk)
        pos = data.index(needle) + len(needle)
        del data[:pos]
    def send(text): os.write(master, text.encode())
    def text_until(text):
        needle = text.encode()
        deadline = time.monotonic() + 8
        while needle not in data:
            if time.monotonic() > deadline: raise AssertionError('Missing prompt '+text+' '+repr(bytes(data[-1500:])))
            if select.select([master], [], [], .1)[0]:
                chunk = os.read(master, 65536); data.extend(chunk); all_data.extend(chunk)
        del data[:data.index(needle)+len(needle)]
    def settle_frame():
        # Drain committed frames and let React install the newly mounted input effect.
        deadline = time.monotonic() + 1
        while time.monotonic() < deadline and select.select([master], [], [], .08)[0]:
            chunk = os.read(master, 65536); data.extend(chunk); all_data.extend(chunk)
    def line(text):
        text_until('Enter ' if mode == 'ink' else '› ')
        settle_frame()
        send(text)
        text_until(text)
        send('\r')
    def release(name): open(os.path.join(d, name), 'w').close()
    try:
        until('state=idle:app=roll')
        # Ink installs its input listeners during effects; read to an actual prompt frame.
        if mode == 'ink':
            deadline = time.monotonic() + 3
            while b'offline-status-fixture' not in all_data:
                if time.monotonic() > deadline: raise AssertionError('no Ink frame')
                if select.select([master], [], [], .1)[0]:
                    chunk = os.read(master, 65536); data.extend(chunk); all_data.extend(chunk)
        line('success')
        until('state=working:app=roll')
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 90, 0, 0))
        os.kill(proc.pid, signal.SIGWINCH)
        release('success')
        until('state=done:app=roll')
        line('permission')
        until('state=blocked:kind=permission:app=roll')
        text_until('fixture.noop')
        text_until('No')
        send('\r')
        until('state=working:app=roll')
        release('permission')
        until('state=done:app=roll')
        line('question')
        until('state=blocked:kind=question:app=roll')
        text_until('Answer')
        send('yes')
        text_until('yes')
        send('\r')
        if mode == 'ink':
            text_until('确认提交')
            send('\r')
        until('state=working:app=roll')
        release('question')
        until('state=done:app=roll')
        line('failure'); until('state=working:app=roll'); release('failure'); until('state=error:app=roll')
        line('cancel'); until('state=working:app=roll'); release('cancel'); until('state=idle:app=roll')
        line('/compact'); until('state=working:app=roll'); release('compact'); until('state=done:app=roll')
        line('exit' if mode == 'basic' else '/exit')
        until('state=clear')
        assert proc.wait(timeout=5) == 0
        assert all_data.count(b'\x1b]7501;state=clear\x1b\\') == 1
        print(mode+' PTY: idle/working/permission/question/done/error/cancel/compact/clear passed')
    finally:
        if proc.poll() is None: proc.kill(); proc.wait()
        os.close(master)
`;
      const child = spawn(
        "python3",
        [
          "-c",
          script,
          process.execPath,
          fileURLToPath(
            new URL("./fixtures/terminal-agent-status.e2e-harness.ts", import.meta.url),
          ),
          mode,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      child.stdout.on("data", (c: Buffer) => {
        output += c.toString();
      });
      child.stderr.on("data", (c: Buffer) => {
        output += c.toString();
      });
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      assert.equal(code, 0, output);
    },
  );
}
