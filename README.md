# omp-wsl-notify

Windows toast notifications for oh-my-pi (`omp`) sessions running under WSL2:
sandboxed through `bin/nono`, unsandboxed over SSH, and unsandboxed in a local
session launched from Windows with `wsl.exe`.

This is an **oh-my-pi (`omp`) extension only**. It is not a `pi` extension and
does not claim `pi` compatibility; `package.json` declares only `omp`.

## Do you need this?

- **Tern:** no, provided Tern's "Needs attention" and "Tern finished" settings
  are both enabled. With both on, Tern renders omp's OSC 99 turn-end
  notification as a real Windows toast by itself, unfocused included. Either
  setting alone is not enough; both must be on.
- **A terminal that does not surface omp notifications as Windows toasts:**
  yes. This is the case the plugin was written for.
- **Anything else:** test it. Run a turn, switch focus away from the terminal,
  and see whether a Windows toast appears. Only Tern is verified. No other
  terminal was tried, and a terminal that draws notifications only inside its
  own window still needs this plugin.

The plugin posts its own toast on `agent_end` regardless of terminal, so
running it next to a terminal that already notifies is expected to give you one
Windows toast per event, twice. That duplicate is expected from the two
independent notifiers, not separately measured. `PI_NOTIFICATIONS=off`
disables both at once: omp suppresses its own notification, and the plugin
mirrors that setting.

## What it does

omp normally leaves desktop notifications to the terminal. Terminals that do
not surface omp's OSC 99 notifications as Windows toasts draw them only inside
their own window, so nothing appears while that window is unfocused, and omp has
no Windows notification path of its own.

This plugin posts a Windows toast when:

- a turn completes (`agent_end`), and
- omp is waiting for input (`tool_execution_start` followed by `ask`).

The toast title is the omp session title. Nerd Font glyphs are stripped from
that title because omp session titles use them; that behavior is
OMP-specific, not a generic text filter.

## Sandboxed and unsandboxed paths

Under nono the sandbox hides `/mnt/c` and `/run/WSL`, so the sandboxed process
cannot call Windows interop directly: `powershell.exe` is not resolvable and
`/init` is unreachable. The launcher (`bin/nono`) therefore starts a small
bridge **outside** the sandbox and exports `OMP_NOTIFY_SOCKET`; the extension
posts toast payloads to that native Unix socket instead.

Without a sandbox the extension needs neither the Unix socket nor the bridge: it
reaches Windows interop itself. If `OMP_NOTIFY_SOCKET` is set but its socket is
gone, the extension falls back to that direct path, so an unsandboxed `omp`
still notifies.

The direct path prefers `/init` and names an interop socket explicitly instead
of executing the `powershell.exe` PE, because the extension does not rely on
the kernel being able to exec a PE on the 9P `/mnt/c` mount; `/init` asks
Windows to open it. It uses `WSL_INTEROP` when the environment provides one and
otherwise falls back to the stable `/run/WSL/1_interop`, which covers sessions
whose parent chain `/init` cannot read. Without the binfmt marker it spawns
`powershell.exe` from `PATH` instead. Either branch works with no bridge and no
launcher.

### Bridge lifetime and sockets

The bridge lives exactly as long as its launcher. `bin/nono` passes
`--parent-pid "$$"` and the bridge polls that PID every 30 s; when the launcher
is gone the bridge shuts down and its socket file goes with it. There is no idle
timer, so a long session keeps notifying. Starting the bridge by hand without
`--parent-pid` exits 2.

Each launcher binds `notify-<launcher-pid>.sock`, so concurrent sessions never
share a bridge and no session goes mute when another one exits.

A hard kill (SIGKILL, OOM) leaves the socket file behind with no owner. That is
recovered automatically: a later launcher that reuses the PID hits
`EADDRINUSE`, probes the socket, finds it dead, unlinks it and rebinds, so
leftover files do not accumulate. To sweep them by hand, stop every omp session
first, confirm `pgrep -af notify-bridge` prints nothing, then
`rm -f "$HOME/.cache/omp/notify"/notify-*.sock`. Deleting a live session's
socket silences that session until its next `nono run`.

## Borrowed AppUserModelID

WinRT silently drops a toast whose AppUserModelID has no Start-menu
registration. Instead of inventing one, `toastScript` borrows Windows
PowerShell's own registered AppUserModelID. Set `OMP_WSL_TOAST_AUMID` to
override it on hosts where that identity is unavailable.

## Tested environment

- `omp` under nono on WSL2, including SSH into WSL and starting `omp` there.
- `omp` on WSL2 with no sandbox, using the direct interop path (no bridge, no
  `bin/nono`). Toasts arrive both over SSH and in a local session launched from
  Windows with `wsl.exe` (no SSH).

Other WSL or nono variants may work but are not tested.

## Install

```sh
omp plugin install github:hy2k/omp-wsl-notify
```

Then restart omp. Ambient extension discovery runs once at startup, and
`/reload-plugins` does not rescan the extension tree.

The bare form `git:hy2k/omp-wsl-notify` is rejected by omp 18.12.2
(`Error: Invalid package name: ...`), and
`git:github.com/hy2k/omp-wsl-notify` fails during install in bun 1.4.2, which
parses it as host `git`. Use the `github:` form above.

The plugin has no runtime dependencies. Its `@oh-my-pi/pi-coding-agent` import
is type-only because `omp plugin install` does not install devDependencies for
git plugins.

## Launcher

Only the sandboxed path needs this. An unsandboxed `omp` notifies without it.

`bin/nono` wraps the real `nono`: it starts the toast bridge, exports
`OMP_NOTIFY_SOCKET`, refuses a working directory under `/mnt/c`, and enters a
private mount namespace that masks `/mnt/c` and `/run/WSL`.

`omp plugin install` does not put the launcher on `PATH`. Link it yourself from
the installed plugin (requires `jq`):

```sh
plugin_root=$(omp plugin list --json | jq -r '.npm[] | select(.name=="omp-wsl-notify") | .path')
ln -sfn "$plugin_root/bin/nono" ~/.local/bin/nono
```

From a git checkout, link `$PWD/bin/nono` instead; the resolved directory must
contain `notify-bridge.ts`.

Use a symlink, never a copy. The launcher resolves its own real path with
`readlink -f "$0"` and runs `notify-bridge.ts` from that directory, so a copy
has no sibling bridge and silently starts no notifier.

`~/.local/bin` must precede the mise shims. `mise activate` prepends its shims,
and its shell hooks re-prepend tool installs on every prompt and directory
change, so a one-time `PATH` edit is overwritten. Re-prepend `~/.local/bin` (or
the checkout's `bin`) **after** activation, or use the function below. Shell
init does not cover non-interactive launches such as systemd or editor tasks.

Bash users can make PATH order irrelevant by defining a function after mise
activation. This works in zsh too:

```bash
nono() { "$HOME/.local/bin/nono" "$@"; }
```

The function bypasses PATH lookup for interactive commands. `command nono`
reaches the real mise-managed binary when needed. Keep the symlink for scripts,
which do not inherit shell functions.

Verify:

```sh
command -v nono   # symlink path, or "nono" when using the function
nono --version
```

With the zsh function, `command -v` reports the function; `whence -p nono`
prints the external launcher path.

Invoking the mise-managed `nono` binary directly bypasses the mount mask and
the bridge.

## Uninstall

This removes everything the plugin writes. It writes only user state: its own
package under the omp plugin directory, a bridge socket under
`~/.cache/omp/notify/`, and whatever `PATH` link or shell function you created
by hand. Nothing else on the machine belongs to it.

1. Uninstall the plugin itself:

   ```sh
   omp plugin uninstall omp-wsl-notify
   ```

   Verify it is gone from the plugin list:

   ```sh
   omp plugin list --json | jq -r '.npm[].name'   # no omp-wsl-notify line
   ```

   The CLI also removes the entry from the plugin `package.json` and its
   lockfile. Do not hand-edit those files; the CLI owns them.

2. Remove the launcher, if you created one. First check what the `nono` you run
   actually resolves to:

   ```sh
   readlink -f "$HOME/.local/bin/nono"
   ```

   Delete `~/.local/bin/nono` **only** if that path is inside this plugin's
   installed directory (the `plugin_root` from the Launcher section above). If
   you added the `nono() { ... }` shell function instead, there is no symlink to
   delete; remove that function from your shell init file.

   Verify `nono` resolves to the real sandbox binary again:

   ```sh
   command -v nono      # the mise-managed nono
   nono --version
   ```

   `~/.local/bin` may hold unrelated links. Never delete the directory itself.

3. Restart omp. Extensions are discovered once at startup, and
   `/reload-plugins` does not rescan the extension tree, so the plugin keeps
   running until omp restarts.

4. After every omp session has exited, check for a bridge that outlived its
   launcher and remove the socket directory:

   ```sh
   pgrep -af notify-bridge                       # expect no output
   rm -rf "$HOME/.cache/omp/notify"
   ```

   A hard-killed session (SIGKILL, OOM) leaves a socket file with no owner.
   That socket is inert, but it accumulates. Removing the `notify/`
   subdirectory is enough; never remove all of `~/.cache/omp`, which also holds
   omp's own state.

5. Remove the nono profile grant added for sandboxed sessions, since nothing
   listens there any more:

   ```jsonc
   "filesystem": {
     "unix_socket_dir": ["$HOME/.cache/omp/notify"]
   }
   ```

   If you also set `linux.sandbox_policy: "landlock"` solely to keep AF_VSOCK
   available for the bridge, revert that setting too: the plugin no longer
   needs it.

6. Nothing else needs removing. Windows keeps the notification history of the
   toasts already posted under the borrowed AppUserModelID; that history is
   Windows' own and harmless. Once the socket grant is gone, a sandboxed
   profile has no trace of the plugin.

## nono profile (sandboxed sessions only)

Grant the bridge socket directory in your nono profile:

```jsonc
"filesystem": {
  "unix_socket_dir": ["$HOME/.cache/omp/notify"]
}
```

## Environment

- `OMP_NOTIFY_SOCKET` — bridge socket path. The launcher exports
  `$HOME/.cache/omp/notify/notify-<launcher-pid>.sock`, so concurrent sessions
  do not share a bridge. Unset, the extension tries
  `$HOME/.cache/omp/notify/notify.sock` and otherwise uses the direct path.
- `OMP_WSL_TOAST_AUMID` — optional AppUserModelID override.
- `PI_NOTIFICATIONS=off` (or `0`, `false`) — suppresses notifications, matching
  omp's own semantics.

## Prerequisites

- WSL2
- Bun (runs the extension, and the bridge when sandboxed)
- nono 0.80+ — only for sandboxed sessions; an unsandboxed `omp` needs no nono
  and no bridge
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
bun test
bun build ./index.ts --target=bun
```

## License

No license is granted.
