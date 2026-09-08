#!/usr/bin/env python3
# -*- coding: utf-8 -*-

# 作品名：系统之美——展陈图像服务器 / The Beauty of Systems — Exhibition Image Server
# 日期：2026.9.3 / Date: 2026.9.3
# 作者：袁征 / Author: Yuan Zheng
#
# 说明：接收作品导出的 PNG，保存临时图像并返回可用于二维码分享的地址；可选公网隧道方便观众使用手机流量访问。
# Description: Receives exported PNGs, stores temporary images and returns shareable URLs for QR codes; an optional public tunnel enables mobile access over cellular data.
#
# 使用：python3 serve.py --tunnel（展览公网模式）或 python3 serve.py（本机/同一 Wi-Fi）。
# Usage: python3 serve.py --tunnel (public exhibition mode) or python3 serve.py (local/same Wi-Fi).
#
# 可选工具：cloudflared 或 localhost.run，用于建立临时公网隧道。
# Optional tools: cloudflared or localhost.run for a temporary public tunnel.

import argparse
import http.server
import json
import os
import random
import re
import shutil
import socket
import socketserver
import subprocess
import threading
import time

# 配置：定义作品目录、临时图片目录、容量限制与公网地址。
# Configuration: defines project paths, temporary image limits and the public base URL.
ROOT = os.path.dirname(os.path.abspath(__file__))
SHOTS = os.path.join(ROOT, 'shots')
KEEP = 400
MAX_BYTES = 16 * 1024 * 1024
ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

PUBLIC = {'base': None}


# 工具：获取局域网地址并清理过期导出图片。
# Helpers: resolve the LAN address and remove older exported images.
def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('8.8.8.8', 80))
        return s.getsockname()[0]
    except Exception:
        return '127.0.0.1'
    finally:
        s.close()


def sweep():
    try:
        files = [os.path.join(SHOTS, f) for f in os.listdir(SHOTS) if f.endswith('.png')]
        if len(files) <= KEEP:
            return
        files.sort(key=os.path.getmtime)
        for f in files[:len(files) - KEEP]:
            os.remove(f)
    except Exception:
        pass


def _pump(proc, pattern, found):


    rx = re.compile(pattern)
    for raw in iter(proc.stdout.readline, b''):
        line = raw.decode('utf-8', 'replace')
        m = rx.search(line)
        if m and not found['url']:
            found['url'] = m.group(0)


# 公网隧道：优先尝试 cloudflared，失败后尝试 localhost.run。
# Public tunnel: tries cloudflared first, then localhost.run.
def start_tunnel(port, timeout=25):


    attempts = []

    if shutil.which('cloudflared'):
        attempts.append((
            'cloudflared',
            ['cloudflared', 'tunnel', '--url', 'http://localhost:%d' % port,
             '--no-autoupdate'],
            r'https://[a-z0-9-]+\.trycloudflare\.com'))

    if shutil.which('ssh'):
        attempts.append((
            'localhost.run',
            ['ssh', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
             '-o', 'ServerAliveInterval=30', '-T',
             '-R', '80:localhost:%d' % port, 'nokey@localhost.run'],
            r'https://[a-z0-9-]+\.lhr\.life'))

    if not attempts:
        return None, None

    for name, cmd, pattern in attempts:
        print('  正在开隧道（%s）… / opening a tunnel via %s ...' % (name, name))
        try:
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
        except Exception:
            continue

        found = {'url': None}
        threading.Thread(target=_pump, args=(proc, pattern, found), daemon=True).start()

        t0 = time.time()
        while time.time() - t0 < timeout:
            if found['url']:
                return found['url'].rstrip('/'), proc
            if proc.poll() is not None:
                break
            time.sleep(0.3)

        try:
            proc.terminate()
        except Exception:
            pass
        print('    没成 / no luck')

    return None, None


# HTTP 服务：接收 PNG、返回分享地址，并提供静态文件访问。
# HTTP service: receives PNGs, returns share URLs and serves static files.
class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def do_POST(self):
        if self.path.rstrip('/').split('/')[-1] != 'save':
            return self.send_error(404)
        try:
            n = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            return self.send_error(400)
        if n <= 0 or n > MAX_BYTES:
            return self.send_error(413)

        data = self.rfile.read(n)
        if not data.startswith(b'\x89PNG'):
            return self.send_error(415)

        os.makedirs(SHOTS, exist_ok=True)
        name = ''.join(random.choice(ALPHABET) for _ in range(6)) + '.png'
        with open(os.path.join(SHOTS, name), 'wb') as f:
            f.write(data)
        sweep()


        path = '/shots/' + name
        url = (PUBLIC['base'] + path) if PUBLIC['base'] else path
        self._json({'url': url})

    def do_GET(self):
        if self.path.rstrip('/').split('/')[-1] == 'base':
            return self._json({'base': PUBLIC['base']})
        return super().do_GET()

    def _json(self, obj):
        body = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, *a):
        pass


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


# 启动：解析端口与公网选项，启动多线程 HTTP 服务器。
# Startup: parses port/public options and launches the threaded HTTP server.
def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument('port', nargs='?', type=int, default=8000)
    ap.add_argument('--tunnel', action='store_true',
                    help='开一条临时隧道，观众用流量就能扫 / open a temporary public tunnel')
    ap.add_argument('--public', metavar='URL', default=None,
                    help='已经有公网地址就直接指过去 / use this public base instead')
    args = ap.parse_args()

    os.makedirs(SHOTS, exist_ok=True)
    proc = None

    print('')
    print('  系统之美 · THE BEAUTY OF SYSTEMS')
    print('  ' + '─' * 58)

    if args.public:
        PUBLIC['base'] = args.public.rstrip('/')
    elif args.tunnel:
        url, proc = start_tunnel(args.port)
        if url:
            PUBLIC['base'] = url
        else:
            print('')
            print('  隧道没开起来。两条路任选其一：')
            print('    brew install cloudflared     （之后再跑一次 --tunnel）')
            print('    或者把作品发布到网上，用 --public https://你的网址')
            print('  现在退回局域网模式 —— 只有同一个 Wi-Fi 下的手机能扫。')
            print('  No tunnel. Install cloudflared and retry, or publish the piece and')
            print('  pass --public. Falling back to the local network only.')

    print('')
    print('  这台机器上打开   →  http://localhost:%d/?tour' % args.port)
    if PUBLIC['base']:
        print('  观众扫码会到     →  %s/shots/…' % PUBLIC['base'])
        print('')
        print('  ✓ 观众用自己的流量就能扫，不需要连 Wi-Fi。')
        print('  ✓ Visitors scan over cellular; no Wi-Fi needed.')
    else:
        print('  观众扫码会到     →  http://%s:%d/shots/…' % (lan_ip(), args.port))
        print('')
        print('  ! 这是局域网地址，只有连着同一个 Wi-Fi 的手机才够得着。')
        print('    展览现场请改用：python3 serve.py --tunnel')
        print('  ! Local address — same Wi-Fi only. At a show use --tunnel.')
    print('')
    print('  观众按 EXPORT，弹出的二维码指向的就是刚刚那张图，')
    print('  扫开长按即可存进相册。Ctrl-C 停止。')
    print('')

    try:
        with Server(('', args.port), Handler) as httpd:
            httpd.serve_forever()
    except KeyboardInterrupt:
        print('\n  停了。/ stopped.\n')
    finally:
        if proc:
            try:
                proc.terminate()
            except Exception:
                pass


if __name__ == '__main__':
    main()
