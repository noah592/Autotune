// Scale Auto-Tune (POC) — main thread
// Records mic audio into memory, then (after stop) does:
// 1) simple pitch detection over chunks (AMDF-ish) + gating
// 2) infer key as closest note to first voiced chunk
// 3) map each chunk pitch to nearest note on the major scale
// 4) send audio to worker.js for RubberBand pitch shifting + overlap-add crossfade

const $ = (id) => document.getElementById(id);

const ui = {
  btnStart: $("btnStart"),
  btnStop: $("btnStop"),
  btnPlayRaw: $("btnPlayRaw"),
  btnProcess: $("btnProcess"),
  status: $("status"),
  sr: $("sr"),
  dur: $("dur"),
  firstNote: $("firstNote"),
  keyMajor: $("keyMajor"),
  mapPreview: $("mapPreview"),
  log: $("log"),
  chunkMs: $("chunkMs"),
  xfadeMs: $("xfadeMs"),
  gateDb: $("gateDb"),
  minF0: $("minF0"),
  maxF0: $("maxF0"),
};

function log(line) {
  ui.log.textContent += line + "\n";
  ui.log.scrollTop = ui.log.scrollHeight;
}
function setStatus(s) { ui.status.textContent = s; }

let audioCtx = null;
let mediaStream = null;
let recorderNode = null;

// We collect Float32 chunks and stitch at the end
let recordedChunks = [];
let recordedLength = 0;
let sampleRate = 0;
let rawBuffer = null;
let processedBuffer = null;

/* ------------------------------ Worker wiring ------------------------------ */

// If CDN fails for you, download these two files and place them next to index.html,
// then set RB_JS_URL="./rubberband.js" and RB_WASM_URL="./rubberband.wasm".
//
// jsDelivr lists these exact files under @echogarden/rubberband-wasm@0.2.0. :contentReference[oaicite:1]{index=1}
const RB_JS_URL = "https://cdn.jsdelivr.net/npm/@echogarden/rubberband-wasm@0.2.0/rubberband.js";
const RB_WASM_URL = "https://cdn.jsdelivr.net/npm/@echogarden/rubberband-wasm@0.2.0/rubberband.wasm";

let worker = null;
let workerReady = false;
let workerBusy = false;

// Promise-style “wait until worker says ready”
let workerReadyPromise = null;
let workerReadyResolve = null;

function ensureWorker(settings) {
  if (worker) return;

  worker = new Worker("worker.js"); // classic worker (importScripts supported)

  worker.onmessage = (e) => {
    const msg = e.data;

    if (msg.type === "ready") {
      workerReady = true;
      log("Worker: ready");
      if (workerReadyResolve) workerReadyResolve();
      workerReadyResolve = null;
      return;
    }

    if (msg.type === "result") {
      workerBusy = false;
      const out = msg.audio; // Float32Array
      processedBuffer = floatToAudioBuffer(out, sampleRate);

      log(`Worker: result received. samples=${out.length}`);
      if (msg.debug) {
        log(
          `Debug: rootMidi=${msg.debug.rootMidi} chunkMs=${msg.debug.chunkMs} overlapMs=${msg.debug.overlapMs}`
        );
      }
      setStatus("Processed (ready to play)");
      // Auto-play processed for convenience
      playProcessed();
      ui.btnProcess.disabled = false;
      return;
    }

    if (msg.type === "error") {
      workerBusy = false;
      log(`WORKER ERROR: ${msg.message}`);
      setStatus("Worker error (see log)");
      ui.btnProcess.disabled = false;
      return;
    }
  };

  worker.onerror = (err) => {
    workerBusy = false;
    log(`WORKER CRASH: ${err.message || String(err)}`);
    setStatus("Worker crashed (see log)");
    ui.btnProcess.disabled = false;
  };

  // Init handshake
  workerReadyPromise = new Promise((resolve) => (workerReadyResolve = resolve));
  worker.postMessage({
    type: "init",
    rbJsUrl: RB_JS_URL,
    rbWasmUrl: RB_WASM_URL,
    sampleRate,
    chunkMs: settings.chunkMs,
    overlapMs: settings.xfadeMs, // your UI calls it xfade; worker calls it overlap
  });

  log("Worker: init sent");
}

async function waitForWorkerReady() {
  if (workerReady) return;
  if (workerReadyPromise) await workerReadyPromise;
}

/* ------------------------------ UI handlers ------------------------------ */

ui.btnStart.addEventListener("click", startRecording);
ui.btnStop.addEventListener("click", stopRecording);
ui.btnPlayRaw.addEventListener("click", playRaw);
ui.btnProcess.addEventListener("click", processWithWorker);

async function startRecording() {
  try {
    setStatus("Requesting mic…");
    ui.btnStart.disabled = true;

    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      }
    });

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    sampleRate = audioCtx.sampleRate;
    ui.sr.textContent = `${sampleRate} Hz`;

    const src = audioCtx.createMediaStreamSource(mediaStream);

    // ScriptProcessor is deprecated but fine for a quick POC.
    const bufSize = 4096;
    recorderNode = audioCtx.createScriptProcessor(bufSize, 1, 1);

    recordedChunks = [];
    recordedLength = 0;
    rawBuffer = null;
    processedBuffer = null;

    recorderNode.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      const copy = new Float32Array(input.length);
      copy.set(input);
      recordedChunks.push(copy);
      recordedLength += copy.length;
    };

    // Must connect in many browsers.
    src.connect(recorderNode);
    recorderNode.connect(audioCtx.destination);

    ui.btnStop.disabled = false;
    ui.btnPlayRaw.disabled = true;
    ui.btnProcess.disabled = true;

    ui.firstNote.textContent = "—";
    ui.keyMajor.textContent = "—";
    ui.mapPreview.textContent = "—";
    ui.dur.textContent = "—";
    ui.log.textContent = "";

    setStatus("Recording…");
    log(`Recording started. sampleRate=${sampleRate}`);
  } catch (err) {
    console.error(err);
    log(`ERROR: ${err?.message || String(err)}`);
    setStatus("Idle");
    ui.btnStart.disabled = false;
    ui.btnStop.disabled = true;
  }
}

async function stopRecording() {
  try {
    setStatus("Stopping…");
    ui.btnStop.disabled = true;

    if (recorderNode) {
      recorderNode.disconnect();
      recorderNode.onaudioprocess = null;
    }
    if (mediaStream) {
      mediaStream.getTracks().forEach(t => t.stop());
    }
    if (audioCtx) {
      await audioCtx.close();
    }

    recorderNode = null;
    mediaStream = null;
    audioCtx = null;

    // Stitch chunks
    const mono = new Float32Array(recordedLength);
    let off = 0;
    for (const c of recordedChunks) {
      mono.set(c, off);
      off += c.length;
    }

    rawBuffer = floatToAudioBuffer(mono, sampleRate);
    ui.dur.textContent = `${(mono.length / sampleRate).toFixed(2)} s`;

    setStatus("Analyzing (pitch detect)…");
    log(`Recording stopped. samples=${mono.length}`);

    // Pitch detection pass + key inference
    const analysis = analyzeMonophonicPitch(mono, sampleRate, getSettings());
    renderAnalysis(analysis);

    ui.btnPlayRaw.disabled = false;
    ui.btnProcess.disabled = false;
    ui.btnStart.disabled = false;
    setStatus("Ready");
  } catch (err) {
    console.error(err);
    log(`ERROR: ${err?.message || String(err)}`);
    setStatus("Idle");
    ui.btnStart.disabled = false;
  }
}

function playRaw() {
  if (!rawBuffer) return;
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const src = ctx.createBufferSource();
  src.buffer = rawBuffer;
  src.connect(ctx.destination);
  src.start();
  log("Playing raw recording…");
  src.onended = () => ctx.close();
}

function playProcessed() {
  if (!processedBuffer) {
    log("No processed audio yet.");
    return;
  }
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const src = ctx.createBufferSource();
  src.buffer = processedBuffer;
  src.connect(ctx.destination);
  src.start();
  log("Playing processed audio…");
  src.onended = () => ctx.close();
}

function getSettings() {
  return {
    chunkMs: clampInt(+ui.chunkMs.value || 120, 50, 200),
    xfadeMs: clampInt(+ui.xfadeMs.value || 12, 5, 40),
    gateDb: clampInt(+ui.gateDb.value || -45, -80, -10),
    minF0: clampInt(+ui.minF0.value || 70, 40, 200),
    maxF0: clampInt(+ui.maxF0.value || 900, 200, 1200),
  };
}

function renderAnalysis(a) {
  ui.firstNote.textContent = a.firstNoteName ?? "—";
  ui.keyMajor.textContent = a.keyName ?? "—";

  if (a.preview && a.preview.length) ui.mapPreview.textContent = a.preview.join("  ");
  else ui.mapPreview.textContent = "—";

  log(`Voiced chunks: ${a.voicedCount}/${a.totalChunks}`);
  if (a.firstHz) log(`First voiced f0: ${a.firstHz.toFixed(2)} Hz → ${a.firstNoteName}`);
  if (a.keyRootMidi != null) log(`Key inferred: ${a.keyName} (root MIDI ${a.keyRootMidi})`);
}

async function processWithWorker() {
  if (!rawBuffer) return;
  if (workerBusy) return;

  const settings = getSettings();

  // Create/init worker (once) using current settings
  ensureWorker(settings);
  setStatus("Worker init…");
  await waitForWorkerReady();

  // Send audio to worker for processing
  const mono = rawBuffer.getChannelData(0);
  const copy = new Float32Array(mono.length);
  copy.set(mono);

  workerBusy = true;
  ui.btnProcess.disabled = true;
  setStatus("Processing (worker)…");
  log(`Process: sending ${copy.length} samples to worker (chunk=${settings.chunkMs}ms overlap=${settings.xfadeMs}ms)`);

  // Transfer buffer for speed
  worker.postMessage({ type: "process", audio: copy }, [copy.buffer]);
}

/* ---------------------------- Analysis & mapping ---------------------------- */

function analyzeMonophonicPitch(mono, sr, settings) {
  const chunkSize = Math.floor(sr * (settings.chunkMs / 1000));
  const hop = chunkSize; // analysis hop = chunk size for simplicity
  const gateLin = dbToLin(settings.gateDb);

  const minLag = Math.floor(sr / settings.maxF0);
  const maxLag = Math.floor(sr / settings.minF0);

  let firstHz = null;
  let firstMidi = null;

  let voicedCount = 0;
  let totalChunks = 0;

  const preview = [];

  for (let i = 0; i + chunkSize <= mono.length; i += hop) {
    totalChunks++;
    const slice = mono.subarray(i, i + chunkSize);

    const rms = calcRms(slice);
    if (rms < gateLin) continue;

    const hz = estimateF0_AMDF(slice, sr, minLag, maxLag);
    if (!hz || !isFinite(hz)) continue;
    if (hz < settings.minF0 || hz > settings.maxF0) continue;

    voicedCount++;
    if (firstHz == null) {
      firstHz = hz;
      firstMidi = hzToMidi(firstHz);
    }
    if (preview.length < 10 && firstMidi != null) {
      const keyRoot = nearestMidi(firstMidi);
      const inKey = nearestMidiInMajorScale(hzToMidi(hz), keyRoot);
      preview.push(`${midiToNoteName(nearestMidi(hzToMidi(hz)))}→${midiToNoteName(inKey)}`);
    }
  }

  if (firstMidi == null) {
    return { totalChunks, voicedCount, firstHz: null, firstNoteName: null, keyRootMidi: null, keyName: null, preview: [] };
  }

  const keyRootMidi = nearestMidi(firstMidi);
  const keyName = `${midiToPitchClassName(keyRootMidi)} major`;

  return { totalChunks, voicedCount, firstHz, firstNoteName: midiToNoteName(keyRootMidi), keyRootMidi, keyName, preview };
}

/* ------------------------------ Pitch detection ----------------------------- */

function estimateF0_AMDF(frame, sr, minLag, maxLag) {
  let bestLag = -1;
  let bestScore = Infinity;

  const x = frame;
  let mean = 0;
  for (let i = 0; i < x.length; i++) mean += x[i];
  mean /= x.length;

  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    const n = x.length - lag;
    for (let i = 0; i < n; i++) sum += Math.abs((x[i] - mean) - (x[i + lag] - mean));
    const score = sum / n;
    if (score < bestScore) { bestScore = score; bestLag = lag; }
  }

  if (bestLag <= 0) return null;

  const rms = calcRms(frame);
  if (rms < 1e-6) return null;
  if (bestScore > rms * 2.0) return null;

  return sr / bestLag;
}

/* ------------------------------- Music utils -------------------------------- */

function hzToMidi(hz) { return 69 + 12 * Math.log2(hz / 440); }
function nearestMidi(m) { return Math.round(m); }

const PITCH_CLASS = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
const MAJOR_SCALE_STEPS = new Set([0,2,4,5,7,9,11]);

function midiToPitchClassName(midi) {
  const pc = ((midi % 12) + 12) % 12;
  return PITCH_CLASS[pc];
}
function midiToNoteName(midi) {
  const pc = ((midi % 12) + 12) % 12;
  const oct = Math.floor(midi / 12) - 1;
  return `${PITCH_CLASS[pc]}${oct}`;
}

function nearestMidiInMajorScale(midiFloat, rootMidiInt) {
  const rootPc = ((rootMidiInt % 12) + 12) % 12;
  const center = Math.round(midiFloat);
  for (let d = 0; d <= 12; d++) {
    const up = center + d;
    const dn = center - d;
    if (isInMajorScale(up, rootPc)) return up;
    if (isInMajorScale(dn, rootPc)) return dn;
  }
  return center;
}

function isInMajorScale(midiInt, rootPc) {
  const pc = ((midiInt % 12) + 12) % 12;
  const rel = (pc - rootPc + 12) % 12;
  return MAJOR_SCALE_STEPS.has(rel);
}

/* -------------------------------- DSP utils -------------------------------- */

function floatToAudioBuffer(mono, sr) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: sr });
  const buf = ctx.createBuffer(1, mono.length, sr);
  buf.copyToChannel(mono, 0);
  ctx.close();
  return buf;
}

function calcRms(x) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / x.length);
}

function dbToLin(db) { return Math.pow(10, db / 20); }

function clampInt(v, a, b) {
  v = Math.round(v);
  return Math.max(a, Math.min(b, v));
}
