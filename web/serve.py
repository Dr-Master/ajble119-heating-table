#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AJBLE119 取暖桌 Web 控制 Demo —— 本地静态服务器（仅使用 Python 标准库）。

用法：
    python serve.py              # 默认 8000，被占用则依次尝试 8001-8010
    python serve.py 8123         # 指定端口（被占用会直接报错退出）
    python serve.py --help       # 显示帮助

说明：
    * 以本脚本所在目录（demo/）为网站根目录，只提供静态文件；
    * 所有响应都带 Cache-Control: no-store，改完源码刷新即可生效；
    * 目录访问优先返回 index.html，没有 index.html 的目录返回干净的 404；
    * 必须通过 http://localhost:<port>/ 访问：ES module 与 Web Bluetooth
      都要求安全上下文（localhost 属于安全上下文），file:// 直接打开不可用。
"""

from __future__ import annotations

import os
import socket
import socketserver
import sys
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

# 网站根目录 = 本脚本所在目录（demo/）
ROOT = os.path.dirname(os.path.abspath(__file__))

DEFAULT_PORT = 8000
FALLBACK_PORTS = list(range(8001, 8011))  # 8001 - 8010
# 只监听本机回环地址：避免 Windows 防火墙弹窗，也避免把调试服务暴露到局域网
HOST = "127.0.0.1"


class DemoRequestHandler(SimpleHTTPRequestHandler):
    """静态文件处理器：no-store、无目录列表、干净的 404。"""

    server_version = "AJBLE119Demo/1.0"

    def end_headers(self):
        # 开发用服务器：禁止缓存，避免改了 js/css 还看到旧版本
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def list_directory(self, path):
        # 不提供目录浏览；没有 index.html 的目录一律 404
        self.send_error(HTTPStatus.NOT_FOUND)
        return None

    def send_error(self, code, message=None, explain=None):
        # 覆盖默认的英文 HTML 错误页，返回简短纯文本（404 等更干净）
        try:
            phrase = self.responses.get(code, ("Error",))[0]
        except Exception:  # pragma: no cover - 极端防御
            phrase = "Error"
        if code == HTTPStatus.NOT_FOUND:
            text = "404 未找到：%s\n本服务器只提供 demo/ 目录下的静态文件。\n" % self.path
        elif message:
            text = "%d %s：%s\n" % (code, phrase, message)
        else:
            text = "%d %s\n" % (code, phrase)
        body = text.encode("utf-8")
        try:
            # 注意：send_response 的状态行只能放 ASCII，说明文字只放正文
            self.send_response(code)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if self.command != "HEAD" and code >= 200 and code not in (204, 205, 304):
                self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):  # pragma: no cover
            pass


class DemoServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def server_bind(self):
        # 跳过 HTTPServer.server_bind() 里的 socket.getfqdn() 反向 DNS 解析：
        # 部分 Windows 环境下该调用会卡住数秒，拖慢启动（这里不需要 FQDN）。
        socketserver.TCPServer.server_bind(self)
        _host, port = self.server_address[:2]
        self.server_name = "localhost"
        self.server_port = port


def port_is_free(port: int) -> bool:
    """用不带 SO_REUSEADDR 的裸 socket 探测端口是否可用。

    Windows 下 SO_REUSEADDR 语义宽松（可能绑定到已被监听的端口），
    所以这里先做一次独占式探测，再由 DemoServer 真正监听。
    """
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        probe.bind((HOST, port))
        return True
    except OSError:
        return False
    finally:
        probe.close()


def parse_port(argv) -> int | None:
    args = [a for a in argv[1:]]
    if any(a in ("-h", "--help", "/?") for a in args):
        print(__doc__)
        raise SystemExit(0)
    if len(args) > 1:
        print("参数过多。用法：python serve.py [port]")
        raise SystemExit(2)
    if not args:
        return None
    try:
        port = int(args[0])
    except ValueError:
        print("端口必须是整数，例如：python serve.py 8123")
        raise SystemExit(2)
    if not (1 <= port <= 65535):
        print("端口范围必须是 1-65535。")
        raise SystemExit(2)
    return port


def main() -> int:
    # Windows 控制台/重定向时避免中文编码报错
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    requested = parse_port(sys.argv)
    candidates = [requested] if requested is not None else [DEFAULT_PORT] + FALLBACK_PORTS

    httpd = None
    chosen = None
    for port in candidates:
        if not port_is_free(port):
            continue
        try:
            httpd = DemoServer((HOST, port), partial(DemoRequestHandler, directory=ROOT))
        except OSError:
            continue
        chosen = port
        break

    if httpd is None:
        if requested is not None:
            print("错误：端口 %d 已被占用，请换一个端口，例如：python serve.py %d"
                  % (requested, min(requested + 1, 65535)))
        else:
            print("错误：端口 8000-8010 均被占用，请关闭占用端口的程序，"
                  "或手动指定端口：python serve.py 9000")
        return 1

    base = "http://localhost:%d/" % chosen
    print("=" * 64)
    print("AJBLE119 取暖桌 Web 控制 Demo —— 本地服务器已启动")
    print("  根目录  : %s" % ROOT)
    print("  监听端口: %d" % chosen)
    if requested is None and chosen != DEFAULT_PORT:
        print("  （默认端口 %d 被占用，已自动改用 %d）" % (DEFAULT_PORT, chosen))
    print()
    print("  真机模式: %s" % base)
    print("  演示模式: %s?mock=1   （无需硬件，使用模拟设备）" % base)
    print()
    print("  按 Ctrl+C 停止服务器")
    print("=" * 64)
    print("提示：必须通过 http://localhost 访问；直接双击 index.html（file://）"
          "无法使用 ES module 与 Web Bluetooth。")
    if not os.path.isfile(os.path.join(ROOT, "index.html")):
        print("注意：当前目录还没有 index.html，页面尚未就绪（其他文件仍可访问）。")
    sys.stdout.flush()

    try:
        httpd.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        print("\n收到 Ctrl+C，正在关闭服务器 ...")
    finally:
        try:
            httpd.server_close()
        except Exception:  # pragma: no cover
            pass
    print("服务器已停止。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
