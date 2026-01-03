// Scale Auto-Tune (POC) — main thread
// Records mic audio into memory, then (after stop) does:
// 1) simple pitch detection over chunks (AMDF-ish) + gating
// 2) infer key as closest note to first voiced chunk
// 3) map each chunk pitch to nearest note on the major scale
// 4) send audio to worker.js for RubberBand pitch shifting + overlap-add

const $ = (id) => document.getElementById(id);

const ui = {
  btnStart: $("btnStart"),
  btnStop: $("btnStop"),
  btnPlayRaw: $("btnPlayRaw"),
  btnProcess: $("btnProcess"),
  // Optional (if your HTML has it). We'll use it if present.
  btnPlayProc: $("btnPlayProc"),

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

// -------- Worker / RubberBand wiring --------

// Put your RubberBand bundle files here.
// (These should be reachable by the worker via importScripts / fetch.)
const RB_JS_URL = "./rubberband.js";
const RB_WASM_URL = "./rubberband.wasm";

let worker = null;
let workerReady = false;
let processedBuffer = null; // AudioBuffer of processed result (for playback)

function ensureWorker() {
  if (worker) return;

  worker = new Worker("./worker.js"); // classic worker
  workerReady = false;

  worker.onmessage = (e) => {
    const msg = e.data;

    if (msg.type === "ready") {
      workerReady = true;
      log("Worker: ready (RubberBand loaded).");
      setStatus("Ready");
      return;
    }

    if (msg.type === "result") {
      // msg.audio is a Float32Array whose buffer was transferred back
      const out = msg.audio;
      processedBuffer = floatToAudioBuffer(out, sampleRate);

      log(`Worker: processed audio received. samples=${out.length}`);
      if (msg.debug) {
        log(
          `Debug: rootMidi=${msg.debug.rootMidi} rootHz=${(msg.debug.rootHz || 0).toFixed(2)} ` +
          `chunkN=${msg.debug.chunkN} overlapN=${msg.debug.overlapN}`
        );
      }

      // Enable optional processed playback button if present
      if (ui.btnPlayProc) ui.btnPlayProc.disabled = false;

      // Convenience: auto-play processed once
      playBuffer(processedBuffer);
      setStatus("Processed");
      ui.btnProcess.disabled = false;
      return;
    }

    if (msg.type === "error") {
      log(`WORKER ERROR: ${msg.message}`);
      setStatus("Worker error");
      ui.btnProcess.disabled = false;
      return;
    }
  };

  worker.onerror = (err) => {
    log(`WORKER ERROR (uncaught): ${err.message || err}`);
    setStatus("Worker error");
    ui.btnProcess.disabled = false;
  };
}

function initWorkerIfNeeded(settings) {
  ensureWorker();
  if (workerReady) return;

  // Important: worker needs SR and overlapMs (we use xfadeMs as overlap)
  worker.postMessage({
    type: "init",
    rbJsUrl: RB_JS_URL,
    rbWasmUrl: RB_WASM_URL,
    sampleRate,
    chunkMs: settings.chunkMs,
    overlapMs: settings.xfadeMs,
  });

  log(`Worker: init sent (rbJsUrl=${RB_JS_URL}, rbWasmUrl=${RB_WASM_URL})`);
  setStatus("Loading RubberBand…");
}

// -------- Recording/playback state --------

let audioCtx = null;
let mediaStream = null;
let recorderNode = null;

// We collect Float32 chunks and stitch at the end
let recordedChunks = [];
let recordedLength = 0;
let sampleRate = 0;
let rawBuffer = null;

ui.btnStart.addEventListener("click", startRecording);
ui.btnStop.addEventListener("click", stopRecording);
ui.btnPlayRaw.addEventListener("click", playRaw);
ui.btnProcess.addEventListener("click", processRecordingWithWorker);

if (ui.btnPlayProc) {
  ui.btnPlayProc.addEventListener("click", () => {
    if (processedBuffer) playBuffer(processedBuffer);
  });
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
    // If needed later, we'll swap to AudioWorklet for lower jitter.
    const bufSize = 4096;
    recorderNode = audioCtx.createScriptProcessor(bufSize, 1, 1);

    recordedChunks = [];
    recordedLength = 0;
    rawBuffer = null;
    processedBuffer = null;
    if (ui.btnPlayProc) ui.btnPlayProc.disabled = true;

    recorderNode.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      const copy = new Float32Array(input.length);
      copy.set(input);
      recordedChunks.push(copy);
      recordedLength += copy.length;
    };

    // We don't need to output audio while recording; still must connect in many browsers.
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

    // Pitch detection pass + key inference (for UI display only)
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
  log("Playing raw recording…");
  playBuffer(rawBuffer);
}

function playBuffer(buf) {
  if (!buf) return;
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
  src.onended = () => ctx.close();
}

function getSettings() {
  return {
    chunkMs: clampInt(+ui.chunkMs.value || 120, 50, 200),
    xfadeMs: clampInt(+ui.xfadeMs.value || 12, 5, 100),
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

// -------- NEW: Process using worker.js --------

async function processRecordingWithWorker() {
  if (!rawBuffer) return;

  const settings = getSettings();

  ui.btnProcess.disabled = true;
  setStatus("Processing…");

  initWorkerIfNeeded(settings);

  // If worker is still loading RubberBand, we'll still send process;
  // worker will error if not ready. So we wait until ready.
  if (!workerReady) {
    // Poll lightly (simple PoC). You can replace with a Promise handshake later.
    const t0 = performance.now();
    while (!workerReady && performance.now() - t0 < 10000) {
      await new Promise(r => setTimeout(r, 50));
    }
    if (!workerReady) {
      log("ERROR: Worker did not become ready (RubberBand not loaded).");
      setStatus("Worker not ready");
      ui.btnProcess.disabled = false;
      return;
    }
  }

  const mono = rawBuffer.getChannelData(0);

  // IMPORTANT: We transfer the buffer to the worker. That would detach it,
  // so we send a copy.
  const payload = new Float32Array(mono.length);
  payload.set(mono);

  log(`Sending to worker: samples=${payload.length}, chunk=${settings.chunkMs}ms overlap=${settings.xfadeMs}ms`);
  worker.postMessage({ type: "process", audio: payload }, [payload.buffer]);
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

  // We’ll also produce a small mapping preview: "C#4→D4" etc for first voiced items
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
      // For preview we need inferred key; we’ll set key as first note root
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

// Simple AMDF-based estimator: choose lag with minimum average absolute diff.
function estimateF0_AMDF(frame, sr, minLag, maxLag) {
  let bestLag = -1;
  let bestScore = Infinity;

  // Light pre-emphasis / DC removal
  const x = frame;
  let mean = 0;
  for (let i = 0; i < x.length; i++) mean += x[i];
  mean /= x.length;

  // AMDF over lags
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

  // Basic sanity check (heuristic)
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
const MAJOR_SCALE_STEPS = new Set([0,2,4,5,7,9,11]); // relative to root

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

  // Search outward from rounded midi
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
