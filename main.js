// Scale Auto-Tune (POC) — main thread
// Records mic audio into memory, then (after stop) does:
// 1) simple pitch detection over chunks (AMDF-ish) + gating
// 2) infer key as closest note to first voiced chunk
// 3) map each chunk pitch to nearest note in major scale
// 4) send audio to worker.js for RubberBand pitch shifting + overlap-add

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
  // Optional: if you later add a button with this id, it will work automatically
  btnPlayProcessed: $("btnPlayProcessed"),
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

// -------------------- Worker wiring --------------------

let rbWorker = null;
let rbReady = false;

// You said you don't have RubberBand bundle files.
// For a quick PoC, point to a published WASM bundle on jsDelivr.
// Package example: @echogarden/rubberband-wasm provides rubberband.js + rubberband.wasm. :contentReference[oaicite:1]{index=1}
const RB_JS_URL   = "https://cdn.jsdelivr.net/npm/@echogarden/rubberband-wasm@0.2.0/rubberband.js";
const RB_WASM_URL = "https://cdn.jsdelivr.net/npm/@echogarden/rubberband-wasm@0.2.0/rubberband.wasm";

function ensureWorker() {
  if (rbWorker) return;

  rbWorker = new Worker("./worker.js"); // classic worker
  rbReady = false;

  rbWorker.onmessage = (e) => {
    const msg = e.data;

    if (msg.type === "ready") {
      rbReady = true;
      log("Worker ready (RubberBand loaded).");
      setStatus("Ready");
      ui.btnProcess.disabled = false;
      return;
    }

    if (msg.type === "result") {
      // msg.audio is a Float32Array whose buffer was transferred back
      const out = msg.audio;
      processedBuffer = floatToAudioBuffer(out, sampleRate);
      log(`Processed audio received. frames=${msg?.debug?.frames?.length ?? "?"}`);
      setStatus("Processed");

      // Auto-play processed result for convenience
      playBuffer(processedBuffer, "processed");

      // Re-enable UI
      ui.btnProcess.disabled = false;
      return;
    }

    if (msg.type === "error") {
      log(`WORKER ERROR: ${msg.message}`);
      setStatus("Worker error");
      ui.btnProcess.disabled = false;
      return;
    }

    log(`Worker message: ${JSON.stringify(msg)}`);
  };

  rbWorker.onerror = (err) => {
    log(`WORKER CRASH: ${err.message || String(err)}`);
    setStatus("Worker crashed");
    ui.btnProcess.disabled = false;
  };
}

function initWorkerIfNeeded(settings) {
  ensureWorker();
  if (rbReady) return;

  setStatus("Loading RubberBand…");
  log("Initializing worker…");

  rbWorker.postMessage({
    type: "init",
    rbJsUrl: RB_JS_URL,
    rbWasmUrl: RB_WASM_URL,
    sampleRate,
    chunkMs: settings.chunkMs,
    overlapMs: settings.xfadeMs,
  });
}

// -------------------- UI handlers --------------------

ui.btnStart.addEventListener("click", startRecording);
ui.btnStop.addEventListener("click", stopRecording);
ui.btnPlayRaw.addEventListener("click", () => playBuffer(rawBuffer, "raw"));
ui.btnProcess.addEventListener("click", processRecording);

if (ui.btnPlayProcessed) {
  ui.btnPlayProcessed.addEventListener("click", () => playBuffer(processedBuffer, "processed"));
}

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

    src.connect(recorderNode);
    recorderNode.connect(audioCtx.destination);

    ui.btnStop.disabled = false;
    ui.btnPlayRaw.disabled = true;
    ui.btnProcess.disabled = true;
    if (ui.btnPlayProcessed) ui.btnPlayProcessed.disabled = true;

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

    // Pitch detection pass + key inference (preview only)
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

function playBuffer(buf, label) {
  if (!buf) return;
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
  log(`Playing ${label}…`);
  src.onended = () => ctx.close();
}

function getSettings() {
  return {
    chunkMs: clampInt(+ui.chunkMs.value || 120, 50, 200),
    xfadeMs: clampInt(+ui.xfadeMs.value || 20, 5, 100),
    gateDb: clampInt(+ui.gateDb.value || -45, -80, -10),
    minF0: clampInt(+ui.minF0.value || 70, 40, 200),
    maxF0: clampInt(+ui.maxF0.value || 900, 200, 1200),
  };
}

function renderAnalysis(a) {
  ui.firstNote.textContent = a.firstNoteName ?? "—";
  ui.keyMajor.textContent = a.keyName ?? "—";

  if (a.preview && a.preview.length) {
    ui.mapPreview.textContent = a.preview.join("  ");
  } else {
    ui.mapPreview.textContent = "—";
  }

  log(`Voiced chunks: ${a.voicedCount}/${a.totalChunks}`);
  if (a.firstHz) log(`First voiced f0: ${a.firstHz.toFixed(2)} Hz → ${a.firstNoteName}`);
  if (a.keyRootMidi != null) log(`Key inferred: ${a.keyName} (root MIDI ${a.keyRootMidi})`);
}

async function processRecording() {
  if (!rawBuffer) return;

  const settings = getSettings();

  // init worker (loads RubberBand) if needed
  initWorkerIfNeeded(settings);

  if (!rbWorker) return;

  ui.btnProcess.disabled = true;
  setStatus(rbReady ? "Processing…" : "Waiting for worker…");
  log(`Process requested: chunk=${settings.chunkMs}ms overlap=${settings.xfadeMs}ms`);

  // If worker isn't ready yet, we'll just wait; on "ready" we'll need user to click again.
  // (Keeping it simple for POC.)
  if (!rbReady) {
    log("Worker is still loading RubberBand. Click Process again once it says ready.");
    ui.btnProcess.disabled = false;
    return;
  }

  // Send audio to worker (transfer buffer for speed)
  const mono = rawBuffer.getChannelData(0);
  const send = new Float32Array(mono.length);
  send.set(mono);

  rbWorker.postMessage(
    { type: "process", audio: send },
    [send.buffer]
  );
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
    return {
      totalChunks,
      voicedCount,
      firstHz: null,
      firstNoteName: null,
      keyRootMidi: null,
      keyName: null,
      preview: [],
    };
  }

  const keyRootMidi = nearestMidi(firstMidi);
  const keyName = `${midiToPitchClassName(keyRootMidi)} major`;

  return {
    totalChunks,
    voicedCount,
    firstHz,
    firstNoteName: midiToNoteName(keyRootMidi),
    keyRootMidi,
    keyName,
    preview,
  };
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
    for (let i = 0; i < n; i++) {
      sum += Math.abs((x[i] - mean) - (x[i + lag] - mean));
    }
    const score = sum / n;
    if (score < bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }

  if (bestLag <= 0) return null;

  const rms = calcRms(frame);
  if (rms < 1e-6) return null;
  if (bestScore > rms * 2.0) return null;

  return sr / bestLag;
}

/* ------------------------------- Music utils -------------------------------- */

function hzToMidi(hz) {
  return 69 + 12 * Math.log2(hz / 440);
}
function nearestMidi(m) {
  return Math.round(m);
}

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

function dbToLin(db) {
  return Math.pow(10, db / 20);
}

function clampInt(v, a, b) {
  v = Math.round(v);
  return Math.max(a, Math.min(b, v));
}
