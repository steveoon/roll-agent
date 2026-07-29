# Python Runtime Protocol smoke client

This example uses only the Python standard library and talks to the public
`Roll Runtime Protocol v1` over stdio.

```bash
python3 examples/python-runtime-client/client.py \
  --cwd /absolute/path/to/workspace
```

The `cwd` is mandatory because it controls Roll config discovery, Skills,
Shell access, Git context, and the local workspace boundary.
