// Scale Auto-Tune (POC) — main thread
// Records mic audio into memory, then (after stop) does:
// 1) simple pitch detection over chunks (AMDF-ish) + gating
// 2) infer key as closest note to first voiced chunk
// 3) map each chunk pitch to nearest note on major scale
// 4) send chunk plan to worker.js for RubberBand pitch shifting + overlap-add

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

// Processed audio
let processedBuffer = null;

// --------------------------- Worker wiring (NEW) -----------------------------

let worker = null;
let pendingProcess = false;

function initWorker() {
  if (worker) return;

  try {
    worker = new Worker("worker.js");
  } catch (e) {
    // Some setups require module workers; if your worker uses ES modules,
    // switch to: new Worker("worker.js", { type: "module" })
    log("ERROR: Failed to create worker.js. If your worker is an ES module, set type:'module'.");
    throw e;
  }

  worker.onmessage = (ev) => {
    const msg = ev.data || {};
    if (msg.type === "log") {
      log(`[worker] ${msg.line}`);
      return;
    }

    if (msg.type === "error") {
      pendingProcess = false;
      ui.btnProcess.disabled = false;
      setStatus("Worker error");
      log(`WORKER ERROR: ${msg.message || "Unknown error"}`);
      if (msg.stack) log(msg.stack);
      return;
    }

    if (msg.type === "processed") {
      pendingProcess = false;
      ui.btnProcess.disabled = false;

      const outSr = msg.sr || sampleRate;

      if (!msg.outBuffer) {
        setStatus("Processed (but no audio returned)");
        log("Worker returned type=processed but outBuffer was missing.");
        return;
      }

      // outBuffer is transferred ArrayBuffer containing Float32 PCM mono
      const out = new Float32Array(msg.outBuffer);
      processedBuffer = floatToAudioBuffer(out, outSr);

      setStatus("Processed");
      log(`Processed audio received: samples=${out.length} sr=${outSr}`);

      // Reuse the existing play button without requiring index.html changes:
      ui.btnPlayRaw.textContent = "Play Processed";
      ui.btnPlayRaw.disabled = false;

      return;
    }

    // Unknown message types are logged for debugging
    log(`[worker] (unknown msg) ${JSON.stringify(msg).slice(0, 500)}`);
  };

  worker.onerror = (err) => {
    pendingProcess = false;
    ui.btnProcess.disabled = false;
    setStatus("Worker crashed");
    log(`WORKER CRASH: ${err.message || String(err)}`);
  };

  log("worker.js initialized.");
}

// ---------------------------------------------------------------------------

ui.btnStart.addEventListener("click", startRecording);
ui.btnStop.addEventListener("click", stopRecording);
ui.btnPlayRaw.addEventListener("click", playRawOrProcessed);
ui.btnProcess.addEventListener("click", processRecording);

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
    ui.btnPlayRaw.textContent = "Play Raw";

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

function playRawOrProcessed() {
  // If processed exists, play it; otherwise play raw
  const buf = processedBuffer || rawBuffer;
  if (!buf) return;

  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();

  log(processedBuffer ? "Playing processed audio…" : "Playing raw recording…");
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

  if (a.preview && a.preview.length) {
    ui.mapPreview.textContent = a.preview.join("  ");
  } else {
    ui.mapPreview.textContent = "—";
  }

  log(`Voiced chunks: ${a.voicedCount}/${a.totalChunks}`);
  if (a.firstHz) log(`First voiced f0: ${a.firstHz.toFixed(2)} Hz → ${a.firstNoteName}`);
  if (a.keyRootMidi != null) log(`Key inferred: ${a.keyName} (root MIDI ${a.keyRootMidi})`);
}

// -------------------------- Processing (UPDATED) -----------------------------

async function processRecording() {
  if (!rawBuffer) return;
  if (pendingProcess) return;

  initWorker();

  const settings = getSettings();
  log(`Process requested: chunk=${settings.chunkMs}ms xfade=${settings.xfadeMs}ms`);

  // Build chunk plan with target semitone shifts
  const mono = rawBuffer.getChannelData(0);
  const plan = buildChunkPitchPlan(mono, sampleRate, settings);

  // Build a worker-friendly payload:
  // - transfer mono PCM as ArrayBuffer
  // - keep plan as plain JSONable data
  const monoCopy = new Float32Array(mono.length);
  monoCopy.set(mono);

  // If your worker expects slightly different field names, adjust here.
  const payload = {
    type: "process",
    sr: sampleRate,
    settings,
    plan: {
      keyRootMidi: plan.keyRootMidi,
      chunks: plan.chunks.map(c => ({
        start: c.start,
        length: c.length,
        xfade: c.xfade,
        voiced: c.voiced,
        shiftSemis: c.shiftSemis,
      })),
    },
    monoBuffer: monoCopy.buffer, // transferred
  };

  pendingProcess = true;
  ui.btnProcess.disabled = true;
  ui.btnPlayRaw.disabled = true;
  setStatus("Processing (worker)…");

  // Transfer monoBuffer so we don't clone big audio data
  worker.postMessage(payload, [payload.monoBuffer]);

  log(`Sent to worker: samples=${monoCopy.length}, chunks=${payload.plan.chunks.length}`);
}

// ---------------------------- Analysis & mapping ----------------------------

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

  // mapping preview: "C#4→D4" etc for first voiced items
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

function buildChunkPitchPlan(mono, sr, settings) {
  const chunkSize = Math.floor(sr * (settings.chunkMs / 1000));
  const xfade = Math.floor(sr * (settings.xfadeMs / 1000));
  const hop = chunkSize; // Later, we can do hop = chunkSize - xfade for nicer continuity.

  const gateLin = dbToLin(settings.gateDb);
  const minLag = Math.floor(sr / settings.maxF0);
  const maxLag = Math.floor(sr / settings.minF0);

  // First pass: find first voiced chunk and set key root
  let keyRoot = null;
  for (let i = 0; i + chunkSize <= mono.length; i += hop) {
    const slice = mono.subarray(i, i + chunkSize);
    if (calcRms(slice) < gateLin) continue;
    const hz = estimateF0_AMDF(slice, sr, minLag, maxLag);
    if (!hz) continue;
    const midi = hzToMidi(hz);
    keyRoot = nearestMidi(midi);
    break;
  }

  const chunks = [];
  for (let i = 0; i + chunkSize <= mono.length; i += hop) {
    const slice = mono.subarray(i, i + chunkSize);
    const rms = calcRms(slice);
    const voiced = rms >= gateLin && keyRoot != null;

    let hz = null, midi = null, targetMidi = null, shiftSemis = 0;

    if (voiced) {
      hz = estimateF0_AMDF(slice, sr, minLag, maxLag);
      if (hz && hz >= settings.minF0 && hz <= settings.maxF0) {
        midi = hzToMidi(hz);
        targetMidi = nearestMidiInMajorScale(midi, keyRoot);
        shiftSemis = (targetMidi - midi);
      } else {
        hz = null;
      }
    }

    chunks.push({
      start: i,
      length: chunkSize,
      xfade,
      voiced: Boolean(hz) && keyRoot != null,
      f0Hz: hz,
      midi,
      targetMidi,
      shiftSemis,
    });
  }

  return { keyRootMidi: keyRoot, chunks };
}

// ------------------------------ Pitch detection -----------------------------

function estimateF0_AMDF(frame, sr, minLag, maxLag) {
  let bestLag = -1;
  let bestScore = Infinity;

  // DC removal
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

// ------------------------------- Music utils --------------------------------

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

// -------------------------------- DSP utils --------------------------------

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

