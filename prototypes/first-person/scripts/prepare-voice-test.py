"""Fetch pinned assets at build time; runtime uses only same-origin files."""
from pathlib import Path
import base64
import hashlib
import re
import shutil
import tarfile
import tempfile
import urllib.request
import zipfile

root = Path(__file__).resolve().parent.parent / 'voice-test' / 'vendor'
root.mkdir(parents=True, exist_ok=True)
url = 'https://unpkg.com/vosk-browser@0.0.8/'
raw = urllib.request.urlopen(url + 'dist/vosk.js', timeout=120).read()
if base64.b64encode(hashlib.sha256(raw).digest()).decode() != 'KVBFFVJul09MsFPPCIEcTeX7KnQAfApalX21DqqNXQw=':
    raise RuntimeError('Pinned library checksum mismatch')
library = raw.decode()
match = re.search(r"var WorkerFactory = createBase64WorkerFactory\('([^']+)'", library)
if not match:
    raise RuntimeError('Pinned worker layout changed')
worker = base64.b64decode(match[1]).decode()
# Keep Emscripten's default MEMFS. Do not mount or sync persistent IDBFS.
for before, after in [
    ('this.Vosk.FS.mount(this.Vosk.IDBFS, {}, storagePath);', '// In-memory model: no persistent mount.'),
    ('this.Vosk.syncFilesystem(true)', 'Promise.resolve()'),
    ('this.Vosk.syncFilesystem(false)', 'Promise.resolve()'),
]:
    if worker.count(before) != 1:
        raise RuntimeError('Unexpected storage implementation: ' + before)
    worker = worker.replace(before, after)
library = library[:match.start(1)] + base64.b64encode(worker.encode()).decode() + library[match.end(1):]
(root / 'vosk.js').write_text(library, encoding='utf-8')
(root / 'VOSK-BROWSER-LICENSE').write_bytes(urllib.request.urlopen('https://raw.githubusercontent.com/ccoreilly/vosk-browser/master/COPYING', timeout=120).read())
model = root / 'model.tar.gz'
if not model.exists():
    print('Downloading official small English model (~40 MB)...', flush=True)
    with tempfile.TemporaryDirectory() as temp:
        archive = Path(temp) / 'model.zip'
        urllib.request.urlretrieve('https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip', archive)
        packed = Path(temp) / 'model.tar.gz'
        with zipfile.ZipFile(archive) as source, tarfile.open(packed, 'w:gz') as target:
            for entry in source.infolist():
                # Vosk expects a single top-level model directory.
                name = 'model/' + entry.filename.split('/', 1)[1]
                info = tarfile.TarInfo(name)
                info.size = entry.file_size
                info.mode = 0o755 if entry.is_dir() else 0o644
                if entry.is_dir():
                    info.type = tarfile.DIRTYPE
                    target.addfile(info)
                    continue
                with source.open(entry) as data:
                    target.addfile(info, data)
        # Pack locally before copying, so WSL network paths don't receive tiny gzip writes.
        with packed.open('rb') as source, model.with_suffix('.tmp').open('wb') as target:
            shutil.copyfileobj(source, target, length=1024 * 1024)
        model.with_suffix('.tmp').replace(model)
print('Prepared memory-only Vosk 0.0.8; model SHA256:', hashlib.sha256(model.read_bytes()).hexdigest())
