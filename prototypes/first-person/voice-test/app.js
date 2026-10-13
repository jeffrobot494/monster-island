const commands = ['pray', 'attack', 'heal', 'north', 'south', 'east', 'west', 'stop', 'help', 'run'];
const $ = id => document.getElementById(id);
$('words').textContent = commands.join(' · ');
const records = [];
let model, recognizer, stream, context, source, processor, gain, timer, active = false;
function log(event, detail = '') {
  const entry = { time: new Date().toISOString(), event, detail };
  records.push(entry);
  if (records.length > 500) records.shift();
  $('log').textContent = records.map(e => `${e.time} ${e.event}: ${e.detail}`).join('\n');
  $('log').scrollTop = $('log').scrollHeight;
  console.log('[voice-test]', event, detail);
}
function status(text) { $('status').textContent = text; }
function emitCommands(text, phase) {
  const heardCommands = text.toLowerCase().trim().split(/\s+/).filter(word => commands.includes(word));
  for (const command of heardCommands) log('COMMAND', `${command} (${phase})`);
  if (heardCommands.length) $('command').textContent = heardCommands.join(' → ');
}
async function cleanup() {
  clearTimeout(timer);
  active = false;
  if (processor) processor.onaudioprocess = null;
  for (const node of [source, processor, gain]) node?.disconnect();
  stream?.getTracks().forEach(track => track.stop());
  recognizer?.remove();
  model?.terminate();
  if (context) await context.close().catch(() => {});
  model = recognizer = stream = context = source = processor = gain = undefined;
  $('start').disabled = false;
  $('stop').disabled = true;
  $('grammar').disabled = false;
}
async function fail(error) {
  if (!active) return;
  log('ERROR', error?.message || String(error));
  status('Failed — see diagnostics. Check microphone permission, iframe policy, worker/WASM CSP, and the bundled model.');
  await cleanup();
}
async function probe() {
  // Exercise WASM inside a blob worker, where Vosk executes, as well as on the page.
  const bytes = [0,97,115,109,1,0,0,0];
  await WebAssembly.compile(new Uint8Array(bytes));
  log('WASM page', 'PASS');
  const url = URL.createObjectURL(new Blob([`WebAssembly.compile(new Uint8Array(${JSON.stringify(bytes)})).then(()=>postMessage('PASS')).catch(e=>postMessage(e.message));`], { type: 'text/javascript' }));
  let worker;
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { reject(new Error('Worker/WASM probe timed out')); }, 10000);
      try {
        worker = new Worker(url);
        worker.onmessage = e => { clearTimeout(timeout); e.data === 'PASS' ? resolve() : reject(new Error(e.data)); };
        worker.onerror = e => { clearTimeout(timeout); reject(new Error(e.message || 'Blob worker blocked')); };
      } catch (error) { clearTimeout(timeout); reject(error); }
    });
    log('WASM blob worker', 'PASS');
  } finally { worker?.terminate(); URL.revokeObjectURL(url); }
}
$('start').onclick = async () => {
  active = true;
  $('start').disabled = true;
  $('grammar').disabled = true;
  $('command').textContent = $('partial').textContent = '—';
  $('meter').textContent = 'Microphone level: —';
  status('Checking runtime and microphone permission…');
  log('Environment', JSON.stringify({ secureContext: isSecureContext, iframe: window !== window.top, userAgent: navigator.userAgent, crossOriginIsolated }));
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone API unavailable: use HTTPS or localhost');
    // Create/resume audio while the click still supplies a user gesture.
    context = new AudioContext();
    await context.resume();
    await probe();
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
    log('Microphone', JSON.stringify(stream.getAudioTracks()[0].getSettings()));
    log('Audio sample rate', context.sampleRate);
    status('Loading bundled English model — this can take a minute…');
    if (!window.Vosk) throw new Error('Bundled vosk.js failed to load');
    model = new Vosk.Model(new URL('./vendor/model.tar.gz', location.href).href, 0);
    model.on('error', message => { void fail(new Error(message.error || 'Vosk worker/model error')); });
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Model load timed out after 120 seconds')), 120000);
      model.on('load', message => { clearTimeout(timer); message.result ? resolve() : reject(new Error('Model load failed')); });
      model.on('error', message => { clearTimeout(timer); reject(new Error(message.error || 'Model worker failed')); });
    });
    if (!active) return;
    log('Model', 'PASS: loaded in memory without IndexedDB');
    recognizer = new model.KaldiRecognizer(context.sampleRate, $('grammar').checked ? JSON.stringify([...commands, '[unk]']) : undefined);
    let previousPartial = '';
    recognizer.on('result', message => {
      const text = message.result?.text || '';
      log('Final transcript', text);
      $('partial').textContent = text || '—';
      emitCommands(text, 'final');
      previousPartial = '';
    });
    recognizer.on('partialresult', message => {
      const text = message.result?.partial || '';
      $('partial').textContent = text || '—';
      // Act immediately on each changed hypothesis. Replay its words rather than
      // waiting to stabilize them: duplicate commands are acceptable for this test.
      if (text !== previousPartial) {
        previousPartial = text;
        emitCommands(text, 'partial');
      }
    });
    source = context.createMediaStreamSource(stream);
    // Match upstream's simple test pipeline. A silent destination keeps callbacks running without mic feedback.
    processor = context.createScriptProcessor(1024, 1, 1);
    gain = context.createGain();
    gain.gain.value = 0;
    let frames = 0;
    processor.onaudioprocess = event => {
      if (!active) return;
      try {
        recognizer.acceptWaveform(event.inputBuffer);
        if (++frames % 8 === 0) {
          const samples = event.inputBuffer.getChannelData(0);
          const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
          $('meter').textContent = `Microphone level: ${(rms * 100).toFixed(1)}% · ${frames} audio buffers sent`;
        }
      } catch (error) { void fail(error); }
    };
    source.connect(processor); processor.connect(gain); gain.connect(context.destination);
    $('stop').disabled = false;
    status('Listening — commands fire during speech. Repeats and duplicates are allowed.');
    log('Recognition', 'Listening');
  } catch (error) { await fail(error); }
};
$('stop').onclick = async () => { await cleanup(); status('Stopped. Microphone released.'); log('Recognition', 'Stopped'); };
$('download').onclick = () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(records, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'vosk-diagnostics.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
window.addEventListener('pagehide', () => { void cleanup(); });
window.addEventListener('securitypolicyviolation', e => log('CSP BLOCK', `${e.violatedDirective}: ${e.blockedURI}`));
