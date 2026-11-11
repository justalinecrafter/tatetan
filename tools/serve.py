# 実機確認用のサーバー。python tools/serve.py で起動し、同じ Wi-Fi のスマホから http://<PCのIP>:8765/ を開く。
# 古い JS や CSS が残らないよう、毎回サーバーに更新を確かめさせる(no-cache)。
import os
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()


if __name__ == '__main__':
    server = ThreadingHTTPServer(('0.0.0.0', 8765), partial(Handler, directory=ROOT))
    print('http://localhost:8765/')
    server.serve_forever()
