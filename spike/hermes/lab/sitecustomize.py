"""Lab-only shim for the zero-model stub runs of the Hermes spike (spike/hermes/stub-probe.mjs).

Loaded by Python at startup when $LAB/stubpy is on PYTHONPATH (only stub runs set it).
It does two things and nothing else:

1. Redirects every http.client.HTTPSConnection to api.anthropic.com to the local stub upstream
   (PULT_LAB_STUB_UPSTREAM=host:port) over plain HTTP. The directsdk plugin's admission relay
   builds exactly such a connection for its single upstream request, so the real `claude`
   binary, the real relay and the real Hermes loop run end to end while no request reaches
   Anthropic. The relay rejects an http:// upstream unless it is loopback, and Hermes rejects
   ANTHROPIC_BASE_URL in its own environment, hence a connection-level redirect.
2. Logs every HTTPSConnection host and every set_tunnel() call to PULT_LAB_HTTPS_LOG, which
   answers S6's question whether the relay honours HTTPS_PROXY (a proxied connection calls
   set_tunnel; a direct one does not). Header values are never logged.
"""
import http.client
import json
import os
import socket
import threading
import time

_STUB = os.environ.get("PULT_LAB_STUB_UPSTREAM", "")
_LOG = os.environ.get("PULT_LAB_HTTPS_LOG", "")
_lock = threading.Lock()


def _log(**row):
    if not _LOG:
        return
    row.update(t=time.time(), pid=os.getpid(), thread=threading.current_thread().name)
    with _lock:
        with open(_LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps(row) + "\n")


_Orig = http.client.HTTPSConnection
# Patch methods in place: http.client's own __init__ calls super(HTTPSConnection, self) by module
# name, so rebinding the name to a subclass would recurse into the original __init__ twice.
_orig_init, _orig_connect, _orig_set_tunnel = _Orig.__init__, _Orig.connect, _Orig.set_tunnel


def _init(self, host, *args, **kwargs):
    _orig_init(self, host, *args, **kwargs)
    self._lab_redirect = bool(_STUB) and self.host == "api.anthropic.com"
    _log(ev="https_connection", host=self.host, port=self.port, redirect=self._lab_redirect)


def _set_tunnel(self, host, port=None, headers=None):
    _log(ev="set_tunnel", proxy=self.host, target=host, target_port=port)
    return _orig_set_tunnel(self, host, port, headers)


def _connect(self):
    if getattr(self, "_lab_redirect", False) and not getattr(self, "_tunnel_host", None):
        h, _, p = _STUB.rpartition(":")
        self.sock = socket.create_connection((h, int(p)), self.timeout)
        _log(ev="redirected", to=_STUB)
        return
    return _orig_connect(self)


if _STUB or _LOG:
    _Orig.__init__, _Orig.connect, _Orig.set_tunnel = _init, _connect, _set_tunnel
