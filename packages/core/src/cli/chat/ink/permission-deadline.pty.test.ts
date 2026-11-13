import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const hasPython = spawnSync("python3", ["--version"]).status === 0;
for (const mode of ["ink", "basic"]) {
  test(
    `real PTY ${mode} permission timeout releases a hidden small-window prompt`,
    {
      skip: process.platform === "win32" || !hasPython,
      timeout: 20_000,
    },
    async () => {
      const script = String.raw`
import os, pty, subprocess, sys, tempfile, select, time, fcntl, termios, struct, signal
node, fixture, mode = sys.argv[1:]
with tempfile.TemporaryDirectory(prefix='roll-deadline-pty-') as d:
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 35, 120, 0, 0))
    env = dict(os.environ, HC_TERMINAL_ID='t-deadline-pty', TERM='xterm-256color', NODE_ENV='test')
    env.pop('CI', None)
    proc = subprocess.Popen([node, '--experimental-strip-types', '--experimental-sqlite', fixture, mode, 'permission', d], stdin=slave, stdout=slave, stderr=slave, env=env)
    os.close(slave)
    data, history = bytearray(), bytearray()
    def expect(needle):
        deadline = time.monotonic() + 10
        while needle not in data:
            assert time.monotonic() < deadline, repr(bytes(data[-2000:]))
            if select.select([master], [], [], .05)[0]:
                chunk = os.read(master, 65536)
                assert chunk, 'PTY closed unexpectedly'
                data.extend(chunk); history.extend(chunk)
        del data[:data.index(needle)+len(needle)]
    def status(fields): expect(('\x1b]7501;'+fields+'\x1b\\').encode())
    def resize(rows, cols):
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0)); os.kill(proc.pid, signal.SIGWINCH)
    try:
        status('state=idle:app=roll')
        expect(('Enter ' if mode == 'ink' else '› ').encode())
        os.write(master, b'wait')
        expect(b'wait'); os.write(master, b'\r')
        status('state=blocked:kind=permission:app=roll')
        resize(8, 35)
        status('state=error:app=roll')
        assert b'state=done:app=roll' not in history
        assert history.count(b'state=idle:app=roll') == 1
        resize(35, 120)
        expect(('Enter ' if mode == 'ink' else '› ').encode())
        os.write(master, ('/exit\r' if mode == 'ink' else 'exit\r').encode())
        status('state=clear')
        assert proc.wait(timeout=5) == 0
        print(mode+' real permission deadline: error, tool not executed, clean exit')
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
          fileURLToPath(new URL("./fixtures/herdr-review.e2e-harness.ts", import.meta.url)),
          mode,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      assert.equal(code, 0, output);
    },
  );
}
