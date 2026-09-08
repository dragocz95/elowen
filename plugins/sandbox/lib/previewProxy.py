import os
import selectors
import socket
import socketserver
import sys

port = int(sys.argv[1])
path = sys.argv[2]


class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        upstream = socket.create_connection(('127.0.0.1', port), timeout=10)
        try:
            upstream.settimeout(None)
            with selectors.DefaultSelector() as selector:
                selector.register(self.request, selectors.EVENT_READ, upstream)
                selector.register(upstream, selectors.EVENT_READ, self.request)
                while True:
                    ready = selector.select(timeout=300)
                    if not ready:
                        return
                    for key, _ in ready:
                        content = key.fileobj.recv(65536)
                        if not content:
                            return
                        key.data.sendall(content)
        finally:
            upstream.close()


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    request_queue_size = 128


with Server(path, Handler) as server:
    os.chmod(path, 0o600)
    server.serve_forever()
