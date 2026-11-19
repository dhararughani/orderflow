"""OrderFlow desktop launcher (run with pythonw.exe: no console window).
Starts the data server hidden, opens the app window once the server answers, stops the server when the window closes (unless the background recorder is on).
--background: start only the server (used by the Windows startup entry)."""
import ctypes, os, pathlib, shutil, subprocess, sys, time, urllib.request

HERE = pathlib.Path(__file__).resolve().parent
URL = "http://127.0.0.1:8770/"
NO_WINDOW = 0x08000000  # CREATE_NO_WINDOW


def up():
    try:
        urllib.request.urlopen(URL + "flow.js", timeout=1).close()
        return True
    except OSError:
        return False


def fail(msg):
    ctypes.windll.user32.MessageBoxW(None, msg, "OrderFlow", 0x10)
    sys.exit(1)


if not up():
    uv = next((p for p in (os.path.expandvars(r"%LOCALAPPDATA%\hermes\bin\uv.exe"), os.path.expandvars(r"%USERPROFILE%\.local\bin\uv.exe"), shutil.which("uv")) if p and os.path.exists(p)), None)
    if not uv:
        fail("uv.exe not found - it is needed to run the data server.")
    log = open(HERE / "server.log", "w")
    subprocess.Popen([uv, "run", str(HERE / "server.py")], cwd=HERE, stdout=log, stderr=log, stdin=subprocess.DEVNULL, creationflags=NO_WINDOW)
    for _ in range(240):  # first run may need to install aiohttp/async_rithmic
        if up():
            break
        time.sleep(0.5)
    else:
        fail(f"The data server did not start. Details: {HERE / 'server.log'}")

if "--background" in sys.argv:  # Windows startup: run only the background recorder, no window
    sys.exit(0)

browser = next((p for p in (os.path.expandvars(r"%ProgramFiles%\Google\Chrome\Application\chrome.exe"), os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
                            os.path.expandvars(r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe")) if os.path.exists(p)), None)
if not browser:
    fail("Google Chrome or Microsoft Edge is required.")
t0 = time.time()
subprocess.call([browser, "--app=" + URL, f"--user-data-dir={HERE / '.orderflow-profile'}", "--start-maximized", "--force-dark-mode",
                 "--no-first-run", "--no-default-browser-check", "--disable-features=Translate"])
if time.time() - t0 < 5:  # Chrome handed off to an already-open OrderFlow window: keep the server for it
    sys.exit(0)
try:
    urllib.request.urlopen(URL + "shutdown", timeout=2).close()
except OSError:
    pass
