# Desktop voice command feasibility test

An isolated build of Vosk Browser 0.0.8 with the official `vosk-model-small-en-us-0.15` English model. It does not change game input or the game build.

```sh
npm run voice:prepare
npm run voice:build
npm run voice
```

Open http://127.0.0.1:5203 and click **Start microphone**. Allow microphone access, wait for the model to load, then say any of the ten displayed commands, including repeated commands without pauses. Stop releases the microphone and model; restarting reloads the model. Download diagnostics to preserve results. Commands fire immediately from each changed partial transcript and again from final transcripts. Repeated words are preserved. Earlier words are replayed when a partial transcript changes: duplicates and recognition revisions are deliberately accepted to prioritize latency. Identical consecutive partial transcripts are ignored to avoid continuously replaying stale speech. Commands are matched as whole words; unknown words are ignored. Audio is submitted in 1024-frame buffers (about 21 ms at 48 kHz); the recognizer still adds processing and recognition latency. `[unk]` lets the grammar reject unrelated speech; it is not an eleventh command. Restricted grammar can still produce false matches, which this test helps measure.

Preparation downloads assets; the running test makes only same-origin requests. The embedded blob worker and WASM ship inside `vendor/vosk.js`. Upstream requires IndexedDB, so preparation replaces its IDBFS mount and two persistent synchronization calls with in-memory operation. Assertions pin the patch to the expected source layout, and the original library SHA256 is verified. The upstream license is included in the build; the English model is Apache 2.0 per https://alphacephei.com/vosk/models. The model is pinned by version and downloaded over HTTPS; preparation prints its SHA256 for comparison.

`npm run voice:test` runs Chrome with a synthetic microphone and denies IndexedDB inside every worker. It verifies model startup, audio processing, stopping/restarting, and absence of external runtime requests. It does not measure recognition accuracy with a human speaker.

## Run iframe test

Upload **dist-voice/** as the build for a separate Run test game. The build includes the existing Run SDK as a standalone module, matching this repository's established deployment workaround. Point that test game's Run config at `dist-voice`. Do not use `game.config.prod.json`, which targets the main game. No deployment is performed by these scripts.

On the deployed desktop iframe, start the microphone and download diagnostics. Success requires both WASM probes, model loading, increasing audio buffer counts, and correct final command transcripts. A local pass does not prove the Run iframe permits the same operations. The page reports CSP violations and stage failures, and model loading times out after two minutes. Microphone access requires HTTPS/localhost and the host iframe's microphone permission. Browser HTTP caching may reuse assets, but no IndexedDB or Cache API is used.

Vosk 0.0.8's generated Emscripten bindings also require JavaScript string evaluation. The local server allows `unsafe-eval`; Run's actual CSP may block it even if the minimal WASM probes pass. The model error diagnostics report that failure. No host security policy is bypassed by the test.

The audio pipeline uses upstream's deprecated ScriptProcessorNode for a minimal compatibility test. Production integration should use an AudioWorklet and measure performance, command accuracy, and false activations before binding game actions.
