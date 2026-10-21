"""Entry point. Spawned by the Tauri shell as a sidecar; never launched by the user directly.

Startup order is deliberate: integrity first, before importing anything that serves requests
or touches the network, so a tampered bundle never gets to run business logic.
"""

from __future__ import annotations

import logging
import os
import socket
import sys

from .integrity import EXIT_TAMPER, IntegrityError, verify_bundle


def main() -> None:
    from .device import data_dir

    # The shell spawns us without a console; log to a file next to the cache.
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
        filename=str(data_dir() / "daemon.log"),
    )
    log = logging.getLogger("droplet.daemon")

    dev = os.environ.get("DROPLET_DEV") == "1"
    try:
        report = verify_bundle()
    except IntegrityError as e:
        log.critical("integrity manifest unusable: %s", e)
        sys.exit(EXIT_TAMPER)

    if not report.ok and not dev:
        # The shell already ran the same check and reported to the cloud with its own signature.
        # Defence in depth: refuse to serve even if the shell check was bypassed.
        log.critical("integrity failure: signature_valid=%s mismatches=%d", report.signature_valid, len(report.mismatches))
        sys.exit(EXIT_TAMPER)

    launch_secret = os.environ.pop("DROPLET_LAUNCH_SECRET", "")
    if len(launch_secret) < 32:
        log.critical("missing launch secret - must be started by the DROPLET shell")
        sys.exit(64)

    import uvicorn  # noqa: PLC0415 - deferred until integrity has passed

    from .app import create_app  # noqa: PLC0415
    from .profiles import ProfileManager  # noqa: PLC0415

    profiles = ProfileManager(data_dir(), os.environ.get("DROPLET_API", "http://localhost:8080"))

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    # The shell reads this single line from stdout to learn the port.
    print(f"DROPLET_DAEMON_PORT={port}", flush=True)

    app = create_app(profiles=profiles, report=report, launch_secret=launch_secret, port=port)
    config = uvicorn.Config(app, log_level="warning", access_log=False, log_config=None)
    uvicorn.Server(config).run(sockets=[sock])


if __name__ == "__main__":
    main()
