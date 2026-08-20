# Managed DSH Host Policy

`ManagedDshHost` owns one evaluation at a time. A second `start()` call is rejected with `DshHostBusyError` until the first call settles and its private temporary directory has been removed.

Each run creates a platform-owned temporary root and sets `DSH_HOME` to a child `dsh-home` directory. The host never reads or writes the caller's personal `DSH_HOME`. The selected plugin paths and the packaged headless bundle are installed into a per-run profile before the headless CLI is invoked.

The timeout applies independently to installation and evaluation child processes. Timeout and explicit termination send `SIGTERM` to the detached process group on POSIX, then to the child directly. Results expose exit status and redacted output; environment values and bearer credentials are never returned verbatim.

Runtime resolution is intentionally narrow: callers provide `PLATFORM_DSH_ROOT`, or packaging provides a JSON declaration with `root` and optional `cli` / `headlessBundle` relative to that declaration. The resolver validates the CLI and headless bundle before any child is spawned; it does not discover arbitrary installations.
