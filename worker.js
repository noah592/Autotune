// worker.js
// Monophonic chunk-based pitch correction using RubberBand (WASM) + overlap/crossfade.
//
// Protocol:
//   postMessage({ type:'init', rbJsUrl, rbWasmUrl, sampleRate, chunkMs, overlapMs })
//   postMessage({ type:'process', audio: Float32Array }, [audio.buffer])
// Replies:
//   { type:'ready' }
//   { type:'result', audio: Float32Array, debug }
//
// Notes:
// - RubberBand loader varies by build. This expects rbJsUrl to expose a global `RubberBandWasm`
//   with an async `create({ wasmURL })` that returns { pitchShift(input, ratio): Float32Array }.
//   If your RubberBand bundle differs, adapt `loadRubberBand()` accordingly.

let SR = 48000;
let CHUNK_MS = 120;     // 50–200ms recommended
let OVERLAP_MS = 20;    // crossfade overlap
let rb = null;          // rubberband instance
let rbReady = false;

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === "init") {
      SR = msg.sampleRate ?? SR;
      CHUNK_MS = clamp(msg.chunkMs ?? CHUNK_MS, 50, 200);
      OVERLAP_MS = clamp(msg.overlapMs ?? OVERLAP_MS, 5, Math.floor(CHUNK_MS / 2));

      rb = await loadRubberBand(msg.rbJsUrl, msg.rbWasmUrl);
      rbReady = true;
      self.postMessage({ type: "ready" });
      return;
    }

    if (msg.type === "process") {
      if (!rbReady) throw new Error("Worker not initialized. Send {type:'init', ...} first.");
      const input = msg.audio; // Float32Array (mono)
      const { out, debug } = processAudio(input);
      // Transfer output buffer back
      self.postMessage({ type: "result", audio: out, debug }, [out.buffer]);
      return;
    }
  } catch (err) {
    self.postMessage({ type: "error", message: String(err?.message || err) });
  }
};

async function loadRubberBand(rbJsUrl, rbWasmUrl) {
  if (!rbJsUrl) throw new Error("Missing rbJsUrl in init message.");
  if (!rbWasmUrl) throw new Error("Missing rbWasmUrl in init message.");

  // Classic workers can use importScripts.
  if (typeof importScripts === "function") {
    importScripts(rbJsUrl);
  } else {
    // Module worker fallback
    await import(rbJsUrl);
  }

  // Expect a global RubberBandWasm
  const g = self;
  const api = g.RubberBandWasm || g.rubberbandWasm || g.RubberBand;
  if (!api) {
    throw new Error(
      "RubberBand JS loaded, but no global RubberBandWasm/RubberBand found. " +
      "Adjust loadRubberBand() for your bundle's API."
    );
  }

  // Expect api.create({ wasmURL }) -> instance with pitchShift(input, ratio)
  if (typeof api.create !== "function") {
    throw new Error("RubberBand global found, but missing expected create({wasmURL}).");
  }

  const inst = await api.create({ wasmURL: rbWasmUrl, sampleRate: SR });
  if (typeof inst.pitchShift !== "function") {
    throw new Error("RubberBand instance missing pitchShift(input, ratio).");
  }
  return inst;
}

function processAudio(input) {
  const chunkN = Math.max(1, Math.round((CHUNK_MS / 1000) * SR));
  const overlapN = Math.max(1, Math.round((OVERLAP_MS / 1000) * SR));
  const hopN = Math.max(1, chunkN - overlapN);

  // Decide scale root from the first "confident" detected pitch.
  const pitches = [];
  const confs = [];
  for (let start = 0; start < input.length; start += hopN) {
    const chunk = slicePadded(input, start, chunkN);
    const { f0, confidence } = detectPitch(chunk, SR);
    pitches.push(f0);
    confs.push(confidence);
  }

  const rootMidi = pickRootMidi(pitches, confs);
  const scale = buildMajorScaleMidi(rootMidi);

  // Process each chunk with rubberband pitch shift and overlap-add crossfade.
  const out = new Float32Array(input.length);
  const debug = {
    sampleRate: SR,
    chunkMs: CHUNK_MS,
    overlapMs: OVERLAP_MS,
    chunkN,
    overlapN,
    hopN,
    rootMidi,
    rootHz: midiToHz(rootMidi),
    frames: []
  };

  let outWrite = 0;
  let prevTail = new Float32Array(overlapN); // last overlapN samples of previous processed chunk

  for (let i = 0, start = 0; start < input.length; i++, start += hopN) {
    const raw = slicePadded(input, start, chunkN);

    const { f0, confidence } = detectPitch(raw, SR);
    let ratio = 1.0;
    let targetMidi = null;

    if (f0 > 0 && confidence >= 0.35) {
      const midi = hzToMidi(f0);
      targetMidi = nearestInScale(midi, scale);
      ratio = midiToHz(targetMidi) / f0;
    }

    // RubberBand pitch shift (keeps duration the same).
    const shifted = rb.pitchShift(raw, ratio);

    // Ensure length chunkN (some implementations may differ by a few samples)
    const proc = fitLength(shifted, chunkN);

    // Crossfade overlap with previous tail, then write hopN new samples.
    // Layout:
    //   [overlapN crossfaded samples] + [hopN non-overlapped samples]
    // We write into out starting at current "outWrite" which equals start for 1:1 duration.
    const writeStart = start;
    const end = Math.min(writeStart + chunkN, out.length);

    // Crossfade region
    const fadeEnd = Math.min(overlapN, end - writeStart);
    for (let n = 0; n < fadeEnd; n++) {
      const t = n / Math.max(1, fadeEnd - 1);
      const a = prevTail[n] * (1 - t);
      const b = proc[n] * t;
      out[writeStart + n] += (a + b);
    }

    // Non-overlap region (rest of chunk)
    for (let n = fadeEnd; n < end - writeStart; n++) {
      out[writeStart + n] += proc[n];
    }

    // Update prevTail from end of proc
    prevTail = proc.slice(chunkN - overlapN, chunkN);

    debug.frames.push({
      frame: i,
      startSample: start,
      f0,
      confidence,
      ratio,
      targetMidi
    });

    outWrite += hopN;
  }

  // Soft clip just in case overlap-add pushes peaks
  softClipInPlace(out, 0.98);

  return { out, debug };
}

/* -------------------- Pitch detection (monophonic) -------------------- */
// Simple autocorrelation-based f0 detector with a confidence heuristic.
// Good enough for a PoC; YIN can be swapped in later if needed.
function detectPitch(x, sr) {
  // Remove DC + apply Hann
  const buf = new Float32Array(x.length);
  let mean = 0;
  for (let i = 0; i < x.length; i++) mean += x[i];
  mean /= x.length;

  for (let i = 0; i < x.length; i++) {
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (x.length - 1)));
    buf[i] = (x[i] - mean) * w;
  }

  // Energy gate
  let rms = 0;
  for (let i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / buf.length);
  if (rms < 0.01) return { f0: 0, confidence: 0 };

  // Search lag bounds ~80Hz..1000Hz (voice/instrument-ish)
  const minF = 80;
  const maxF = 1000;
  const minLag = Math.floor(sr / maxF);
  const maxLag = Math.min(buf.length - 2, Math.floor(sr / minF));

  let bestLag = -1;
  let bestVal = -Infinity;

  // Autocorrelation (unnormalized) — PoC simplicity
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i < buf.length - lag; i++) {
      sum += buf[i] * buf[i + lag];
    }
    if (sum > bestVal) {
      bestVal = sum;
      bestLag = lag;
    }
  }

  if (bestLag <= 0) return { f0: 0, confidence: 0 };

  // Parabolic interpolation around bestLag
  const lag = bestLag;
  const y0 = ac(buf, lag - 1);
  const y1 = ac(buf, lag);
  const y2 = ac(buf, lag + 1);
  const denom = (y0 - 2 * y1 + y2);
  const shift = denom !== 0 ? 0.5 * (y0 - y2) / denom : 0;
  const refinedLag = lag + shift;

  const f0 = refinedLag > 0 ? sr / refinedLag : 0;

  // Confidence heuristic: peak vs zero-lag energy
  const zero = ac(buf, 0);
  const confidence = zero > 0 ? clamp01(y1 / zero) : 0;

  // Keep within bounds
  if (f0 < minF || f0 > maxF) return { f0: 0, confidence: 0.1 * confidence };

  return { f0, confidence };
}

function ac(buf, lag) {
  if (lag < 0) return 0;
  let sum = 0;
  for (let i = 0; i < buf.length - lag; i++) sum += buf[i] * buf[i + lag];
  return sum;
}

/* -------------------- Scale logic -------------------- */
function pickRootMidi(pitches, confs) {
  // Find first reasonably confident pitch; use nearest MIDI note as root.
  for (let i = 0; i < pitches.length; i++) {
    if (pitches[i] > 0 && confs[i] >= 0.4) return Math.round(hzToMidi(pitches[i]));
  }
  // Fallback: A4
  return 69;
}

function buildMajorScaleMidi(rootMidi) {
  // Represent scale as pitch classes relative to root: 0,2,4,5,7,9,11
  const pcs = [0, 2, 4, 5, 7, 9, 11];
  const rootPc = mod(rootMidi, 12);
  const set = new Set(pcs.map((d) => mod(rootPc + d, 12)));
  return set; // pitch-class set
}

function nearestInScale(midiFloat, scalePcSet) {
  // Search nearest integer MIDI note whose pitch class is in the scale.
  const m0 = Math.round(midiFloat);
  let best = m0;
  let bestDist = Infinity;

  for (let d = -12; d <= 12; d++) {
    const m = m0 + d;
    if (scalePcSet.has(mod(m, 12))) {
      const dist = Math.abs(m - midiFloat);
      if (dist < bestDist) {
        bestDist = dist;
        best = m;
      }
    }
  }
  return best;
}

/* -------------------- Utilities -------------------- */
function slicePadded(x, start, len) {
  const out = new Float32Array(len);
  const end = Math.min(x.length, start + len);
  if (start < x.length) out.set(x.subarray(start, end), 0);
  return out;
}

function fitLength(x, len) {
  if (x.length === len) return x;
  const out = new Float32Array(len);
  if (x.length > len) {
    out.set(x.subarray(0, len));
  } else {
    out.set(x, 0);
  }
  return out;
}

function softClipInPlace(x, limit = 0.98) {
  // Smooth saturation to avoid harsh clipping
  const a = limit;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    // tanh-like soft clip: v / (1 + |v|/a)
    x[i] = v / (1 + Math.abs(v) / a);
  }
}

function hzToMidi(hz) {
  return 69 + 12 * Math.log2(hz / 440);
}
function midiToHz(m) {
  return 440 * Math.pow(2, (m - 69) / 12);
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
function clamp01(v) {
  return clamp(v, 0, 1);
}
function mod(n, m) {
  return ((n % m) + m) % m;
}
