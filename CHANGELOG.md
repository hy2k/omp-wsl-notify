# Changelog

## Unreleased

### Changed

- Documented that an unsandboxed `omp` notifies through the direct Windows
  interop path. That path was previously described as untested and unsupported;
  it is now tested, and no bridge or launcher is needed for it.
- Corrected the Tern claim. Tern renders omp's OSC 99 turn-end notification
  as a real Windows toast itself, unfocused included, when its "Needs
  attention" and "Tern finished" settings are both enabled, so the plugin is
  optional for Tern. It remains the supported path for terminals that do not
  surface omp notifications as Windows toasts. The README now states that
  running both is expected to produce duplicate toasts, and documents how to
  uninstall the plugin and clean up the launcher, bridge sockets, and nono
  grant.

## 0.1.1 — 2026-10-23

### Fixed

- The toast bridge no longer exits 15 minutes after the last notification. It
  now runs for as long as its `nono` launcher and shuts down when the session
  ends, so notifications keep working for long sessions.
- Each sandboxed session gets its own bridge socket
  (`$HOME/.cache/omp/notify/notify-<launcher-pid>.sock` by default). Concurrent
  sessions no longer share one bridge, and a session no longer goes mute when
  the session that owned the shared bridge exits.
