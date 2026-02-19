from http.server import HTTPServer, BaseHTTPRequestHandler
import subprocess, json, os

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        procs = {"chromium": False, "ffmpeg": False, "xvfb": False}
        try:
            ps = subprocess.check_output(["ps", "aux"], text=True)
            procs["chromium"] = "chromium" in ps
            procs["ffmpeg"] = "ffmpeg" in ps
            procs["xvfb"] = "Xvfb" in ps
        except Exception:
            pass

        healthy = all(procs.values())
        body = json.dumps({
            "status": "streaming" if healthy else "degraded",
            "processes": procs,
            "target": os.environ.get("STREAM_URL", ""),
        })
        self.send_response(200 if healthy else 503)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body.encode())

    def log_message(self, *_): pass

HTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
