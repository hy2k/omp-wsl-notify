# omp-wsl-notify

Windows toast notifications for oh-my-pi (`omp`) sessions running under WSL2,
including omp started over SSH and inside the nono sandbox.

This is an **oh-my-pi (`omp`) extension only**. It is not a `pi` extension and
does not claim `pi` compatibility; `package.json` declares only `omp`.

## What it does

omp normally leaves desktop notifications to the terminal. Tern draws omp's
OSC 99 notifications inside its own window, so nothing surfaces while that
window is unfocused, and omp has no Windows notification path of its own.

This plugin posts a Windows toast when:

- a turn completes (`agent_end`), and
- omp is waiting for input (`tool_execution_start` followed by `ask`).

The toast title is the omp session title. Nerd Font glyphs are stripped from
that title because omp session titles use them; that behavior is
OMP-specific, not a generic text filter.

## Why a bridge

Under nono the sandbox hides `/mnt/c` and `/run/WSL`, so the sandboxed process
cannot call Windows interop directly: `powershell.exe` is not resolvable and
`/init` is unreachable. The launcher (`bin/nono`) therefore starts a small
bridge **outside** the sandbox and exports `OMP_NOTIFY_SOCKET`; the extension
posts toast payloads to that native Unix socket instead.

A simpler unsandboxed WSL notifier can call `powershell.exe` directly and may
need neither the Unix socket nor the bridge. This repository exists for the
nono case, and the bridge is part of it because nono hides the Windows interop
paths.

A direct `/init` fallback exists for an unsandboxed WSL session. It is
**untested and unsupported**; see [Tested environment](#tested-environment).

### Borrowed AppUserModelID

WinRT silently drops a toast whose AppUserModelID has no Start-menu
registration. Instead of inventing one, `toastScript` borrows Windows
PowerShell's own registered AppUserModelID. Set `OMP_WSL_TOAST_AUMID` to
override it on hosts where that identity is unavailable.

## Tested environment

- `omp` under nono on WSL2, including SSH into WSL and starting `omp` there.

The direct unsandboxed `/init` fallback is untested and unsupported. Other WSL
or nono variants may work but are not tested.

## Install

```sh
omp plugin install git:github.com/hy2k/omp-wsl-notify
```

Then restart omp. Ambient extension discovery runs once at startup, and
`/reload-plugins` does not rescan the extension tree.

`github:hy2k/omp-wsl-notify` is equivalent. The bare form
`git:hy2k/omp-wsl-notify` is rejected by omp 18.12.2
(`Error: Invalid package name: ...`); use the full form above.

The plugin has no runtime dependencies. Its `@oh-my-pi/pi-coding-agent` import
is type-only because `omp plugin install` does not install devDependencies for
git plugins.

## Launcher

`bin/nono` wraps the real `nono`: it starts the toast bridge, exports
`OMP_NOTIFY_SOCKET`, refuses a working directory under `/mnt/c`, and enters a
private mount namespace that masks `/mnt/c` and `/run/WSL`.

Put `<repo>/bin` on `PATH` **before** the mise/nono entry, for example by
adding it to your shell profile, or symlink it:

```sh
ln -sfn "$PWD/bin/nono" ~/.local/bin/nono
```

Invoking the mise-managed `nono` binary directly bypasses the mount mask and
the bridge.

## nono profile

Grant the bridge socket directory in your nono profile:

```jsonc
"filesystem": {
  "unix_socket_dir": ["$HOME/.cache/omp/notify"]
}
```

## Environment

- `OMP_NOTIFY_SOCKET` — bridge socket path. Defaults to
  `$HOME/.cache/omp/notify/notify.sock`; the launcher exports it.
- `OMP_WSL_TOAST_AUMID` — optional AppUserModelID override.
- `PI_NOTIFICATIONS=off` (or `0`, `false`) — suppresses notifications, matching
  omp's own semantics.

## Prerequisites

- WSL2
- Bun (runs the extension and the bridge)
- nono 0.80+
- `powershell.exe` at
  `/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe`
- Toast notifications enabled in Windows

## Security

The socket directory is `0700` and the socket is `0600`, so only the same Unix
user can connect. The bridge accepts a single `{v,tag,title,body}` JSON line,
limits its size, allowlists the tag, and constructs the PowerShell invocation
itself with a fixed interpreter path, fixed argv, and base64-encoded text. It
accepts no path, executable, command line, or file to read, and returns no data
to the caller.

## Development

```sh
bun install
bun run typecheck
bun build ./index.ts --target=bun
```

## License

No license is granted.
