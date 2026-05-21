const preferredMimes = [
  "audio/webm;codecs=opus",
  "audio/ogg;codecs=opus",
  "audio/webm",
  "audio/mp4",
];
const waveformBars = 360;
const syncStorageKey = "trespar-sync-offset-ms";
const sketchDbName = "trespar-sketches";
const sketchStoreName = "active-sketch";
const activeSketchKey = "current";

const tracksRoot = document.querySelector("#tracks");
const trackTemplate = document.querySelector("#trackTemplate");
const playButton = document.querySelector("#playButton");
const exportButton = document.querySelector("#exportButton");
const resetButton = document.querySelector("#resetButton");
const statusText = document.querySelector("#statusText");
const syncSlider = document.querySelector("#syncSlider");
const syncValue = document.querySelector("#syncValue");
const timingShift = document.querySelector("#timingShift");
const timingWaves = document.querySelector(".timing-waves");
const mixPanel = document.querySelector("#mixPanel");
const mixName = document.querySelector("#mixName");
const mixPlayer = document.querySelector("#mixPlayer");
const saveMixButton = document.querySelector("#saveMixButton");
const openMixButton = document.querySelector("#openMixButton");
const openMixInput = document.querySelector("#openMixInput");
const mixFormat = document.querySelector("#mixFormat");
const mixProgress = document.querySelector("#mixProgress");
const mixProgressFill = document.querySelector("#mixProgressFill");
const audioWarning = document.querySelector("#audioWarning");
const audioWarningText = document.querySelector("#audioWarningText");
const wakeAudioButton = document.querySelector("#wakeAudioButton");
const ignoreAudioButton = document.querySelector("#ignoreAudioButton");
const reloadAudioButton = document.querySelector("#reloadAudioButton");

const state = {
  audioContext: null,
  micStream: null,
  analyser: null,
  meterSource: null,
  waveformFrame: 0,
  recorder: null,
  activeTrack: null,
  recordStartedAt: 0,
  recordLimitTimer: 0,
  transportSources: [],
  transportStopTimer: 0,
  transportFrame: 0,
  transportStartedAt: 0,
  transportTracks: [],
  transportAnalyser: null,
  transportMeterSamples: null,
  transportSilenceStartedAt: 0,
  audioWarningIgnored: false,
  soloTrack: null,
  isPlaying: false,
  exportBusy: false,
  manualSyncOffset: 0,
  mixBlob: null,
  mixUrl: "",
  mixMimeType: "",
  openedMix: false,
  wakeLock: null,
  mixProgressFrame: 0,
  audioRecoveryNeeded: false,
  audioRecoveryPromise: null,
  sketchDbPromise: null,
  storagePersistRequested: false,
  tracks: [],
};

state.manualSyncOffset = loadSavedSyncOffset();

function chooseMimeType() {
  if (!window.MediaRecorder) return "";
  return preferredMimes.find((mime) => MediaRecorder.isTypeSupported(mime)) || "";
}

function chooseMixMimeType() {
  if (!window.MediaRecorder) return "";
  const mixes = [
    "audio/mp4;codecs=mp4a.40.2",
    "audio/mp4",
    "audio/webm;codecs=opus",
    "audio/ogg;codecs=opus",
    "audio/webm",
  ];
  return mixes.find((mime) => MediaRecorder.isTypeSupported(mime)) || "";
}

function fileExtension(mimeType) {
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("mp4")) return "m4a";
  return "webm";
}

function setStatus(message, isError = false) {
  statusText.textContent = message;
  statusText.classList.toggle("error", isError);
}

function loadSavedSyncOffset() {
  try {
    return Math.max(0, Math.min(0.6, Number(localStorage.getItem(syncStorageKey)) / 1000 || 0));
  } catch {
    return 0;
  }
}

function saveSyncOffset() {
  try {
    localStorage.setItem(syncStorageKey, String(Math.round(state.manualSyncOffset * 1000)));
  } catch {
    // Local storage may be blocked.
  }
}

function openSketchDb() {
  if (!window.indexedDB) return Promise.resolve(null);
  if (state.sketchDbPromise) return state.sketchDbPromise;

  state.sketchDbPromise = new Promise((resolve) => {
    const request = indexedDB.open(sketchDbName, 1);
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(sketchStoreName)) {
        request.result.createObjectStore(sketchStoreName);
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => resolve(null));
  });

  return state.sketchDbPromise;
}

async function withSketchStore(mode, action) {
  const db = await openSketchDb();
  if (!db) return null;

  return new Promise((resolve) => {
    const transaction = db.transaction(sketchStoreName, mode);
    const store = transaction.objectStore(sketchStoreName);
    let result = null;
    try {
      result = action(store);
    } catch {
      resolve(null);
      return;
    }
    transaction.addEventListener("complete", () => resolve(result));
    transaction.addEventListener("error", () => resolve(null));
    transaction.addEventListener("abort", () => resolve(null));
  });
}

async function saveActiveSketch() {
  requestSketchPersistence();
  const tracks = state.tracks
    .filter((track) => track.blob)
    .map((track) => ({
      index: track.index,
      blob: track.blob,
      duration: track.duration,
      muted: track.muted,
      syncOffset: track.syncOffset,
    }));

  if (!tracks.length) {
    await clearSavedSketch();
    return;
  }

  await withSketchStore("readwrite", (store) => {
    store.put({
      savedAt: Date.now(),
      manualSyncOffset: state.manualSyncOffset,
      tracks,
    }, activeSketchKey);
  });
}

function requestSketchPersistence() {
  if (state.storagePersistRequested || !navigator.storage?.persist) return;
  state.storagePersistRequested = true;
  navigator.storage.persist().catch(() => {
    // Browser storage may stay best effort.
  });
}

async function loadSavedSketch() {
  return withSketchStore("readonly", (store) => new Promise((resolve) => {
    const request = store.get(activeSketchKey);
    request.addEventListener("success", () => resolve(request.result || null));
    request.addEventListener("error", () => resolve(null));
  })).then((result) => result instanceof Promise ? result : result);
}

async function clearSavedSketch() {
  await withSketchStore("readwrite", (store) => {
    store.delete(activeSketchKey);
  });
}

async function restoreSavedSketch() {
  const sketch = await loadSavedSketch();
  if (!sketch?.tracks?.length || state.tracks.some((track) => track.blob)) return;

  if (typeof sketch.manualSyncOffset === "number") {
    setManualSyncOffset(sketch.manualSyncOffset, { saveSketch: false });
  }

  await Promise.all(sketch.tracks.map(async (savedTrack) => {
    const track = state.tracks[savedTrack.index];
    if (!track || !savedTrack.blob) return;
    track.blob = savedTrack.blob;
    track.url = URL.createObjectURL(savedTrack.blob);
    track.duration = savedTrack.duration || 0;
    track.muted = !!savedTrack.muted;
    track.syncOffset = savedTrack.syncOffset || 0;
    track.cachedPeaks = null;
    track.elements.muteButton.setAttribute("aria-pressed", String(track.muted));

    try {
      const context = state.audioContext || await replaceAndGetDecodeContext();
      track.buffer = await decodeBlobWithContext(track.blob, context);
      drawTrackWaveform(track);
    } catch {
      track.buffer = null;
      drawEmptyWaveform(track);
    }
  }));

  updateUi();
}

async function replaceAndGetDecodeContext() {
  await replaceAudioContext();
  return state.audioContext;
}

function formatTime(seconds) {
  const safeSeconds = Math.max(0, seconds || 0);
  const minutes = Math.floor(safeSeconds / 60).toString().padStart(2, "0");
  const wholeSeconds = Math.floor(safeSeconds % 60).toString().padStart(2, "0");
  const tenths = Math.floor((safeSeconds % 1) * 10);
  return `${minutes}:${wholeSeconds}.${tenths}`;
}

async function ensureAudioContext({ fresh = false } = {}) {
  if (fresh || !state.audioContext || state.audioContext.state === "closed") {
    await replaceAudioContext();
  }

  try {
    await state.audioContext.resume();
  } catch {
    if (!fresh) return ensureAudioContext({ fresh: true });
    throw new Error("Ljudet vilar. Tryck en gang till.");
  }

  if (state.audioContext.state === "closed") {
    return ensureAudioContext({ fresh: true });
  }
  if (state.audioContext.state === "interrupted" && !fresh) {
    return ensureAudioContext({ fresh: true });
  }
  return state.audioContext;
}

async function replaceAudioContext() {
  const oldContext = state.audioContext;
  disconnectMeter();
  state.audioContext = new AudioContext({ latencyHint: "interactive" });
  state.audioContext.addEventListener("statechange", () => {
    if (state.audioContext?.state === "interrupted") {
      state.audioRecoveryNeeded = true;
    }
  });
  if (oldContext && oldContext.state !== "closed") {
    oldContext.close().catch(() => {
      // Interrupted contexts may refuse to close cleanly.
    });
  }
}

function disconnectMeter() {
  try {
    state.meterSource?.disconnect();
  } catch {
    // The old graph may already be gone.
  }
  try {
    state.analyser?.disconnect();
  } catch {
    // The old graph may already be gone.
  }
  state.meterSource = null;
  state.analyser = null;
}

function hasLiveMicrophone() {
  return !!state.micStream?.getAudioTracks().some((track) => track.readyState === "live");
}

function forgetMicrophone({ stopTracks = false } = {}) {
  disconnectMeter();
  if (stopTracks) {
    state.micStream?.getTracks().forEach((track) => track.stop());
  }
  state.micStream = null;
}

function connectMicrophoneMeter(context) {
  disconnectMeter();
  state.meterSource = context.createMediaStreamSource(state.micStream);
  state.analyser = context.createAnalyser();
  state.analyser.fftSize = 256;
  state.meterSource.connect(state.analyser);
}

async function prepareMicrophone() {
  if (state.audioRecoveryNeeded) await recoverAudioSession({ freshContext: false });
  if (state.micStream && !hasLiveMicrophone()) forgetMicrophone();
  if (state.micStream && hasLiveMicrophone()) {
    const context = await ensureAudioContext();
    if (!state.analyser) connectMicrophoneMeter(context);
    return state.micStream;
  }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    throw new Error("Den här webbläsaren saknar mikrofoninspelning.");
  }

  state.micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: false,
      latency: { ideal: 0 },
    },
    video: false,
  });
  state.micStream.getAudioTracks().forEach((track) => {
    track.addEventListener("ended", () => {
      state.audioRecoveryNeeded = true;
      forgetMicrophone();
    });
  });

  const context = await ensureAudioContext();
  connectMicrophoneMeter(context);
  return state.micStream;
}

async function decodeBlob(blob) {
  try {
    const context = await ensureAudioContext();
    return await decodeBlobWithContext(blob, context);
  } catch {
    await recoverAudioSession({ freshContext: true, redecodeTracks: false });
    try {
      const context = await ensureAudioContext();
      return await decodeBlobWithContext(blob, context);
    } catch {
      throw new Error("Ljudet vaknade inte riktigt. Tryck igen.");
    }
  }
}

async function decodeBlobWithContext(blob, context) {
  return context.decodeAudioData(await blob.arrayBuffer());
}

async function recoverAudioSession({ freshContext = false, redecodeTracks = true } = {}) {
  if (state.audioRecoveryPromise) return state.audioRecoveryPromise;

  state.audioRecoveryPromise = (async () => {
    if (state.micStream && !hasLiveMicrophone()) forgetMicrophone();
    const context = await ensureAudioContext({ fresh: freshContext });

    if (hasLiveMicrophone()) {
      connectMicrophoneMeter(context);
    }

    if (redecodeTracks) {
      await Promise.all(state.tracks.map(async (track) => {
        if (!track.blob || track.buffer) return;
        try {
          track.buffer = await decodeBlobWithContext(track.blob, context);
          drawTrackWaveform(track);
        } catch {
          // Keep the visible take and try again on the next user gesture.
        }
      }));
    }

    state.audioRecoveryNeeded = false;
    updateUi();
    return context;
  })().finally(() => {
    state.audioRecoveryPromise = null;
  });

  return state.audioRecoveryPromise;
}

async function requestScreenWakeLock() {
  if (!navigator.wakeLock?.request || state.wakeLock) return;
  try {
    state.wakeLock = await navigator.wakeLock.request("screen");
    state.wakeLock.addEventListener("release", () => {
      state.wakeLock = null;
    });
  } catch {
    state.wakeLock = null;
  }
}

async function releaseScreenWakeLock() {
  if (!state.wakeLock) return;
  const lock = state.wakeLock;
  state.wakeLock = null;
  try {
    await lock.release();
  } catch {
    // Wake lock may already be released by the browser.
  }
}

function renderTracks() {
  state.tracks = Array.from({ length: 3 }, (_, index) => {
    const fragment = trackTemplate.content.cloneNode(true);
    const card = fragment.querySelector(".track-card");
    const recordButton = fragment.querySelector(".record-button");
    const recordLabel = recordButton.querySelector("b");
    const waveform = fragment.querySelector(".waveform");
    const playTrackButton = fragment.querySelector(".play-track-button");
    const muteButton = fragment.querySelector(".mute-button");
    const muteGlyph = fragment.querySelector(".mute-glyph");
    const clearButton = fragment.querySelector(".clear-button");

    card.dataset.track = index;
    muteGlyph.src = `mute-${index + 1}.png`;
    recordButton.addEventListener("click", () => toggleRecording(track));
    playTrackButton.addEventListener("click", () => playTrack(track));
    muteButton.addEventListener("click", () => toggleMute(track));
    clearButton.addEventListener("click", () => clearTrack(track));
    const track = {
      index,
      blob: null,
      buffer: null,
      duration: 0,
      url: "",
      muted: false,
      livePeaks: [],
      livePeakCursor: 0,
      syncOffset: 0,
      playFraction: 0,
      cachedPeaks: null,
      elements: {
        card,
        recordButton,
        recordLabel,
        waveform,
        playTrackButton,
        muteButton,
        clearButton,
      },
    };

    tracksRoot.append(fragment);
    return track;
  });

  updateUi();
  window.requestAnimationFrame(() => state.tracks.forEach(drawEmptyWaveform));
}

function updateUi() {
  const hasTake = state.tracks.some((track) => track.blob);
  const globalStopping = state.isPlaying || !!state.activeTrack;
  playButton.disabled = (!hasTake && !globalStopping) || state.exportBusy;
  playButton.classList.toggle("stopping", globalStopping);
  playButton.setAttribute("aria-label", globalStopping ? "Stoppa" : "Spela alla spår");
  playButton.title = playButton.getAttribute("aria-label");
  exportButton.disabled = !hasTake || !!state.activeTrack || state.isPlaying || state.exportBusy;
  resetButton.disabled = !hasTake || !!state.activeTrack || state.exportBusy;
  state.tracks.forEach((track) => {
    const readyForOverdub = track.index === 0 || getIdeaDuration() > 0;
    const busyElsewhere = !!state.activeTrack && state.activeTrack !== track;
    const { recordButton, recordLabel, playTrackButton, muteButton, clearButton } =
      track.elements;
    recordButton.disabled =
      !readyForOverdub ||
      busyElsewhere ||
      (state.isPlaying && state.activeTrack !== track) ||
      state.exportBusy;
    recordButton.classList.toggle("recording", state.activeTrack === track);
    recordButton.classList.toggle("armed", !track.blob && readyForOverdub);
    recordButton.classList.toggle("has-take", !!track.blob);
    recordLabel.textContent = state.activeTrack === track
      ? "Stoppa"
      : track.blob
        ? "Ta om"
        : "Spela in";
    recordButton.setAttribute("aria-label", recordLabel.textContent);
    muteButton.disabled = !track.blob;
    playTrackButton.disabled = !track.blob || !!state.activeTrack || state.exportBusy;
    playTrackButton.classList.toggle("playing", state.isPlaying && state.soloTrack === track);
    playTrackButton.querySelector("span").textContent =
      state.isPlaying && state.soloTrack === track ? "■" : "▶";
    playTrackButton.setAttribute(
      "aria-label",
      state.isPlaying && state.soloTrack === track ? "Stoppa spår" : "Spela spår",
    );
    playTrackButton.title = playTrackButton.getAttribute("aria-label");
    clearButton.disabled = !track.blob || !!state.activeTrack;
    if (!state.isPlaying && state.activeTrack !== track) drawTrackWaveform(track);
  });
}

async function toggleRecording(track) {
  if (state.activeTrack === track) {
    stopRecording();
    return;
  }

  try {
    await startRecording(track);
  } catch (error) {
    setStatus(error.message || "Inspelningen gick inte att starta.", true);
  }
}

async function startRecording(track) {
  await prepareMicrophone();
  await ensureAudioContext();
  await requestScreenWakeLock();
  stopTransport();

  if (track.index > 0 && !getIdeaDuration()) {
    setStatus("Spela in spår ett först.");
    return;
  }

  const chunks = [];
  const mimeType = chooseMimeType();
  state.recorder = mimeType
    ? new MediaRecorder(state.micStream, { mimeType })
    : new MediaRecorder(state.micStream);
  state.activeTrack = track;
  state.recordStartedAt = performance.now();
  track.muted = false;
  track.livePeaks = [];
  track.livePeakCursor = 0;
  track.syncOffset = track.index === 0 ? 0 : getReportedLatency();
  track.elements.muteButton.setAttribute("aria-pressed", "false");
  drawEmptyWaveform(track);

  state.recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size) chunks.push(event.data);
  });

  state.recorder.addEventListener("stop", async () => {
    try {
      const blob = new Blob(chunks, { type: state.recorder.mimeType || mimeType || "audio/webm" });
      await saveTake(track, blob);
    } catch (error) {
      setStatus(error.message || "Tagningen kunde inte sparas.", true);
    } finally {
      state.recorder = null;
      state.activeTrack = null;
      window.clearTimeout(state.recordLimitTimer);
      state.recordLimitTimer = 0;
      stopLiveWaveform();
      stopTransport();
      releaseScreenWakeLock();
      updateUi();
    }
  });

  state.recorder.start(250);
  updateUi();
  startLiveWaveform(track);

  if (track.index === 0) {
    animateRecordClock(track);
    setStatus("");
    return;
  }

  await playAll({ excludeTrack: track, forRecording: true });
  state.recordLimitTimer = window.setTimeout(
    stopRecording,
    (getIdeaDuration() + getOverdubSyncOffset() + 0.08) * 1000,
  );
  setStatus("");
}

function stopRecording() {
  if (state.recorder?.state === "recording") {
    state.recorder.stop();
  }
}

async function saveTake(track, blob) {
  const duration = Math.max(0.15, (performance.now() - state.recordStartedAt) / 1000);
  if (track.url) URL.revokeObjectURL(track.url);
  track.blob = blob;
  track.url = URL.createObjectURL(blob);
  track.duration = duration;
  track.cachedPeaks = null;
  track.elements.clearButton.disabled = false;
  await saveActiveSketch();

  try {
    track.buffer = await decodeBlob(blob);
    drawBufferWaveform(track);
    setStatus("");
  } catch {
    track.buffer = null;
    drawEmptyWaveform(track);
    setStatus("Tagningen sparades lokalt. Tryck igen om ljudet vilar.", true);
  }
}

function clearTrack(track) {
  if (state.activeTrack === track) return;
  if (track.url) URL.revokeObjectURL(track.url);
  track.blob = null;
  track.buffer = null;
  track.duration = 0;
  track.livePeaks = [];
  track.livePeakCursor = 0;
  track.syncOffset = 0;
  track.url = "";
  track.muted = false;
  track.cachedPeaks = null;
  track.elements.muteButton.setAttribute("aria-pressed", "false");
  drawEmptyWaveform(track);

  setStatus("");
  updateUi();
  saveActiveSketch();
}

function toggleMute(track) {
  track.muted = !track.muted;
  track.elements.muteButton.setAttribute("aria-pressed", String(track.muted));
  state.transportSources
    .filter((transport) => transport.track === track)
    .forEach((transport) => {
      transport.gain.gain.setTargetAtTime(
        track.muted ? 0 : 1,
        state.audioContext?.currentTime || 0,
        0.012,
      );
    });
  updateUi();
}

function getReportedLatency() {
  const outputLatency = state.audioContext?.outputLatency || 0;
  const baseLatency = state.audioContext?.baseLatency || 0;
  const micLatency = state.micStream?.getAudioTracks()[0]?.getSettings().latency || 0;
  return Math.max(0, outputLatency + baseLatency + micLatency);
}

function getIdeaDuration() {
  return Math.max(0, ...state.tracks.map((track) => track.duration || 0));
}

function getOverdubSyncOffset() {
  return Math.min(0.9, getReportedLatency() + state.manualSyncOffset);
}

function getTrackOffset(track) {
  if (track.index === 0 || !track.buffer) return 0;
  const totalOffset = (track.syncOffset || 0) + state.manualSyncOffset;
  return Math.min(totalOffset, Math.max(0, track.buffer.duration - 0.02));
}

async function playTrack(track) {
  if (state.isPlaying && state.soloTrack === track) {
    stopTransport();
    return;
  }
  await playAll({ soloTrack: track });
}

async function playAll({ excludeTrack = null, soloTrack = null, forRecording = false } = {}) {
  if (state.audioRecoveryNeeded || state.tracks.some((track) => track.blob && !track.buffer)) {
    try {
      await recoverAudioSession();
    } catch {
      setStatus("Ljudet vilar. Tryck en gang till.", true);
      return;
    }
  }

  const playableTracks = state.tracks.filter((track) => {
    return track !== excludeTrack && track.buffer && (!soloTrack || track === soloTrack);
  });
  if (!playableTracks.length) return;

  const context = await ensureAudioContext();
  stopTransport();
  state.isPlaying = true;
  state.transportStartedAt = context.currentTime + 0.04;
  state.transportTracks = playableTracks;
  state.soloTrack = soloTrack;
  state.audioWarningIgnored = false;
  hideAudioWarning();
  const transportBus = context.createGain();
  state.transportAnalyser = context.createAnalyser();
  state.transportAnalyser.fftSize = 256;
  state.transportMeterSamples = new Uint8Array(state.transportAnalyser.fftSize);
  transportBus.connect(state.transportAnalyser).connect(context.destination);
  state.transportSources = playableTracks.map((track) => {
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = track.buffer;
    gain.gain.value = track.muted ? 0 : 1;
    source.connect(gain).connect(transportBus);
    const offset = getTrackOffset(track);
    source.start(
      state.transportStartedAt,
      offset,
      Math.max(0.02, Math.min(getIdeaDuration() || track.buffer.duration, track.buffer.duration - offset)),
    );
    return { source, gain, track };
  });

  const duration = getIdeaDuration() || Math.max(...playableTracks.map((track) => track.buffer.duration));
  state.transportStopTimer = window.setTimeout(stopTransport, duration * 1000 + 80);
  animateTransport(duration);
  if (!forRecording) setStatus("");
  updateUi();
}

function stopTransport() {
  state.transportSources.forEach(({ source }) => {
    try {
      source.stop();
    } catch {
      // Source already ended.
    }
  });
  state.transportSources = [];
  state.transportTracks = [];
  try {
    state.transportAnalyser?.disconnect();
  } catch {
    // The transport graph may already be gone.
  }
  state.transportAnalyser = null;
  state.transportMeterSamples = null;
  state.transportSilenceStartedAt = 0;
  state.soloTrack = null;
  state.isPlaying = false;
  hideAudioWarning();
  window.clearTimeout(state.transportStopTimer);
  window.cancelAnimationFrame(state.transportFrame);
  state.transportStopTimer = 0;
  state.tracks.forEach((track) => {
    track.playFraction = 0;
    drawTrackWaveform(track);
  });
  updateUi();
  saveActiveSketch();
}

function animateTransport(duration) {
  window.cancelAnimationFrame(state.transportFrame);
  const tick = () => {
    if (!state.isPlaying) return;
    const elapsed = Math.max(0, state.audioContext.currentTime - state.transportStartedAt);
    const bounded = Math.min(duration, elapsed);
    state.transportTracks.forEach((track) => {
      track.playFraction = bounded / duration;
      drawTrackWaveform(track);
    });
    if (state.activeTrack) {
      state.activeTrack.playFraction = bounded / duration;
      drawLiveWaveform(state.activeTrack);
    }
    watchTransportAudio(bounded, duration);
    state.transportFrame = window.requestAnimationFrame(tick);
  };
  tick();
}

function watchTransportAudio(elapsed, duration) {
  if (
    state.activeTrack ||
    state.audioWarningIgnored ||
    !state.transportAnalyser ||
    !state.transportMeterSamples ||
    elapsed < 0.35 ||
    elapsed >= duration
  ) {
    return;
  }

  if (state.audioContext?.state && state.audioContext.state !== "running") {
    showAudioWarning();
    return;
  }

  const shouldSound = state.transportTracks.some((track) => {
    return !track.muted && trackHasSignalNear(track, elapsed, duration);
  });
  const hasOutputSignal = readTransportPeak() > 0.018;

  if (!shouldSound || hasOutputSignal) {
    state.transportSilenceStartedAt = 0;
    return;
  }

  if (!state.transportSilenceStartedAt) {
    state.transportSilenceStartedAt = performance.now();
    return;
  }

  if (performance.now() - state.transportSilenceStartedAt > 900) {
    showAudioWarning();
  }
}

function readTransportPeak() {
  state.transportAnalyser.getByteTimeDomainData(state.transportMeterSamples);
  return state.transportMeterSamples.reduce((peak, sample) => {
    return Math.max(peak, Math.abs(sample - 128) / 128);
  }, 0);
}

function trackHasSignalNear(track, elapsed, duration) {
  const peaks = track.cachedPeaks || getBufferPeaks(track);
  if (!peaks.length) return false;
  const center = Math.min(peaks.length - 1, Math.floor((elapsed / Math.max(0.05, duration)) * peaks.length));
  const start = Math.max(0, center - 4);
  const end = Math.min(peaks.length, center + 5);
  return peaks.slice(start, end).some((peak) => peak > 0.09);
}

function showAudioWarning(reloadStep = false) {
  if (state.audioWarningIgnored) return;
  audioWarning.hidden = false;
  audioWarningText.textContent = reloadStep
    ? "Ljudet vaknade inte. Allt ar sparat."
    : "Ljudet verkar ha somnat.";
  wakeAudioButton.hidden = reloadStep;
  reloadAudioButton.hidden = !reloadStep;
}

function hideAudioWarning({ ignore = false } = {}) {
  audioWarning.hidden = true;
  state.transportSilenceStartedAt = 0;
  if (ignore) state.audioWarningIgnored = true;
}

function animateRecordClock(track) {
  const tick = () => {
    if (state.activeTrack !== track) return;
    const elapsed = (performance.now() - state.recordStartedAt) / 1000;
    track.playFraction = getIdeaDuration() ? elapsed / getIdeaDuration() : 1;
    drawLiveWaveform(track);
    state.transportFrame = window.requestAnimationFrame(tick);
  };
  tick();
}

function startLiveWaveform(track) {
  if (!state.analyser) return;
  const samples = new Uint8Array(state.analyser.fftSize);
  const tick = () => {
    if (state.activeTrack !== track) return;
    state.analyser.getByteTimeDomainData(samples);
    const peak = samples.reduce((highest, sample) => {
      return Math.max(highest, Math.abs(sample - 128) / 128);
    }, 0);
    captureLivePeak(track, peak);
    drawLiveWaveform(track);
    state.waveformFrame = window.requestAnimationFrame(tick);
  };
  tick();
}

function stopLiveWaveform() {
  window.cancelAnimationFrame(state.waveformFrame);
  state.waveformFrame = 0;
}

function resizeCanvas(canvas) {
  const box = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(box.width * ratio));
  const height = Math.max(1, Math.floor(box.height * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  return { width, height, ratio };
}

function drawEmptyWaveform(track) {
  const { waveform } = track.elements;
  const context = waveform.getContext("2d");
  const { width, height, ratio } = resizeCanvas(waveform);
  const middle = height / 2;
  context.clearRect(0, 0, width, height);
  drawStringLine(context, width, middle, ratio, getTrackColor(track, 0.55));
}

function getBufferPeaks(track) {
  if (!track.buffer) {
    return [];
  }

  const channel = track.buffer.getChannelData(0);
  const firstSample = Math.floor(getTrackOffset(track) * track.buffer.sampleRate);
  const ideaDuration = getIdeaDuration();
  const visibleSamples = ideaDuration
    ? Math.min(channel.length - firstSample, Math.floor(ideaDuration * track.buffer.sampleRate))
    : channel.length - firstSample;
  const barCount = waveformBars;
  const naturalBars = ideaDuration
    ? Math.max(1, Math.min(barCount, Math.round((visibleSamples / track.buffer.sampleRate / ideaDuration) * barCount)))
    : barCount;
  const sampleWindow = Math.max(1, Math.floor(visibleSamples / naturalBars));
  const peaks = Array.from({ length: naturalBars }, (_, index) => {
    let peak = 0;
    const start = firstSample + index * sampleWindow;
    const end = Math.min(channel.length, start + sampleWindow);
    for (let sample = start; sample < end; sample += 1) {
      peak = Math.max(peak, Math.abs(channel[sample]));
    }
    return peak;
  });
  while (peaks.length < barCount) peaks.push(0);
  track.cachedPeaks = normalizePeaks(peaks);
  return track.cachedPeaks;
}

function drawTrackWaveform(track) {
  if (track.buffer) {
    drawPeakWaveform(track, getBufferPeaks(track), { playFraction: track.playFraction || 0 });
    return;
  }
  drawEmptyWaveform(track);
}

function drawBufferWaveform(track) {
  drawTrackWaveform(track);
}

function drawLiveWaveform(track) {
  drawPeakWaveform(track, normalizePeaks(track.livePeaks), {
    activeFraction: getLiveFraction(track),
    playFraction: track.playFraction || 0,
  });
}

function drawPeakWaveform(track, peaks, { activeFraction = 1, playFraction = 0 } = {}) {
  const { waveform } = track.elements;
  const context = waveform.getContext("2d");
  const { width, height, ratio } = resizeCanvas(waveform);
  const center = height / 2;
  const gap = Math.max(1.5 * ratio, width / Math.max(peaks.length, 1) * 0.18);
  const barWidth = Math.max(1.2 * ratio, width / Math.max(peaks.length, 1) - gap);

  context.clearRect(0, 0, width, height);
  drawStringLine(context, width, center, ratio, getTrackColor(track, 0.92));
  context.fillStyle = getTrackColor(track, 1);

  peaks.forEach((peak, index) => {
    const x = index * (width / Math.max(peaks.length, 1));
    const amplitude = peak * height * 0.43;
    if (amplitude > 1.4 * ratio) {
      context.fillRect(x, center - amplitude, barWidth, amplitude * 2);
    }
  });

  if (activeFraction < 1) {
    const futureX = Math.max(0, Math.min(width, width * activeFraction));
    context.fillStyle = "rgba(9, 12, 17, 0.88)";
    context.fillRect(futureX, 0, width - futureX, height);
    drawStringLine(context, width - futureX, center, ratio, getTrackColor(track, 0.18), futureX);
  }

  if (playFraction > 0 && playFraction < 1) {
    const playX = width * playFraction;
    const glowWidth = Math.max(26 * ratio, width * 0.065);
    const glow = context.createLinearGradient(playX - glowWidth, 0, playX + glowWidth, 0);
    glow.addColorStop(0, getTrackColor(track, 0));
    glow.addColorStop(0.5, getTrackColor(track, 0.7));
    glow.addColorStop(1, getTrackColor(track, 0));
    context.globalCompositeOperation = "screen";
    context.fillStyle = glow;
    context.fillRect(playX - glowWidth, 0, glowWidth * 2, height);
    context.globalCompositeOperation = "source-over";
  }
}

function drawStringLine(context, width, center, ratio, color, startX = 0) {
  const endX = startX + width;
  const segment = Math.max(18 * ratio, width / 20);
  context.strokeStyle = color;
  context.lineWidth = Math.max(ratio, 1.15 * ratio);
  context.lineCap = "round";
  context.lineJoin = "round";
  context.beginPath();
  context.moveTo(startX, center);
  for (let x = startX + segment; x < endX; x += segment) {
    const wobble = (
      Math.sin(x * 0.013) * 0.7 +
      Math.sin(x * 0.041 + center * 0.09) * 0.46
    ) * ratio;
    const controlX = x - segment / 2;
    context.quadraticCurveTo(controlX, center + wobble, x, center);
  }
  context.lineTo(endX, center);
  context.stroke();
}

function normalizePeaks(peaks) {
  const audiblePeaks = peaks.filter((peak) => peak > 0.025);
  const ceiling = Math.max(0.08, ...audiblePeaks);
  return peaks.map((peak) => {
    if (peak <= 0.025) return 0;
    return Math.sqrt((peak - 0.025) / Math.max(0.001, ceiling - 0.025));
  });
}

function captureLivePeak(track, peak) {
  const ideaDuration = getIdeaDuration();
  if (track.index > 0 && ideaDuration) {
    if (!track.livePeaks.length) track.livePeaks = Array(waveformBars).fill(0);
    const elapsed = (performance.now() - state.recordStartedAt) / 1000;
    const index = Math.min(waveformBars - 1, Math.floor((elapsed / ideaDuration) * waveformBars));
    track.livePeaks[index] = Math.max(track.livePeaks[index], peak);
    track.livePeakCursor = Math.max(track.livePeakCursor, index + 1);
    return;
  }

  track.livePeaks.push(peak);
  if (track.livePeaks.length > waveformBars) track.livePeaks.shift();
  track.livePeakCursor = track.livePeaks.length;
}

function getLiveFraction(track) {
  if (track.index > 0 && getIdeaDuration()) {
    return Math.min(1, track.livePeakCursor / waveformBars);
  }
  return 1;
}

function getTrackColor(track, alpha) {
  const colors = [
    [88, 211, 194],
    [255, 193, 73],
    [255, 88, 95],
  ];
  const [red, green, blue] = colors[track.index] || colors[0];
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

async function exportMix() {
  if (state.audioRecoveryNeeded || state.tracks.some((track) => track.blob && !track.buffer)) {
    try {
      await recoverAudioSession();
    } catch {
      setStatus("Ljudet vilar. Tryck en gang till.", true);
      return;
    }
  }

  const mixTracks = state.tracks.filter((track) => track.buffer && !track.muted);
  if (!mixTracks.length) return;

  try {
    state.exportBusy = true;
    updateUi();
    setStatus("");
    await requestScreenWakeLock();
    const context = await ensureAudioContext();
    const destination = context.createMediaStreamDestination();
    const outputGain = context.createGain();
    outputGain.gain.value = 0.82 / Math.max(1, mixTracks.length * 0.72);
    outputGain.connect(destination);

    const mimeType = chooseMixMimeType();
    const recorder = mimeType
      ? new MediaRecorder(destination.stream, { mimeType })
      : new MediaRecorder(destination.stream);
    const chunks = [];
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size) chunks.push(event.data);
    });

    const sources = mixTracks.map((track) => {
      const source = context.createBufferSource();
      source.buffer = track.buffer;
      source.connect(outputGain);
      return { source, track };
    });
    const duration = getIdeaDuration() || Math.max(...mixTracks.map((track) => track.buffer.duration));
    const startAt = context.currentTime + 0.08;
    const stopped = new Promise((resolve) => recorder.addEventListener("stop", resolve, { once: true }));
    recorder.start(250);
    sources.forEach(({ source, track }) => {
      const offset = getTrackOffset(track);
      source.start(
        startAt,
        offset,
        Math.max(0.02, Math.min(duration, track.buffer.duration - offset)),
      );
    });
    startMixProgress(duration);
    await wait((duration + 0.18) * 1000);
    sources.forEach(({ source }) => {
      try {
        source.stop();
      } catch {
        // Source already ended.
      }
    });
    recorder.stop();
    await stopped;
    outputGain.disconnect();

    const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/webm" });
    if (!mixName.value) mixName.value = nextMixName();
    setReadyMix(blob);
    setStatus("");
  } catch (error) {
    setStatus(error.message || "Exporten gick inte att göra.", true);
  } finally {
    stopMixProgress();
    releaseScreenWakeLock();
    state.exportBusy = false;
    updateUi();
  }
}

function startMixProgress(duration) {
  mixProgress.hidden = false;
  mixProgressFill.style.width = "0";
  const startedAt = performance.now();
  const tick = () => {
    const elapsed = (performance.now() - startedAt) / 1000;
    mixProgressFill.style.width = `${Math.min(100, (elapsed / Math.max(0.05, duration)) * 100)}%`;
    if (state.exportBusy && elapsed < duration) {
      state.mixProgressFrame = window.requestAnimationFrame(tick);
    }
  };
  tick();
}

function stopMixProgress() {
  window.cancelAnimationFrame(state.mixProgressFrame);
  state.mixProgressFrame = 0;
  mixProgressFill.style.width = "100%";
  window.setTimeout(() => {
    if (!state.exportBusy) mixProgress.hidden = true;
  }, 360);
}

function setReadyMix(blob, { opened = false } = {}) {
  if (state.mixUrl) URL.revokeObjectURL(state.mixUrl);
  state.mixBlob = blob;
  state.mixMimeType = blob.type;
  state.openedMix = opened;
  state.mixUrl = URL.createObjectURL(blob);
  mixPlayer.src = state.mixUrl;
  mixPanel.hidden = false;
  openMixButton.classList.toggle("opened", opened);
  mixFormat.textContent = fileExtension(blob.type).toUpperCase();
}

function nextMixName() {
  const storageKey = "trespar-next-take-number";
  let number = 1;
  try {
    number = Math.max(1, Number(localStorage.getItem(storageKey)) || 1);
    localStorage.setItem(storageKey, String(number + 1));
  } catch {
    number = 1;
  }
  return `Trespår tagning ${number}`;
}

function safeFileName(name) {
  return (name.trim() || "Trespår tagning")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function downloadBlob(blob, filename) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

playButton.addEventListener("click", () => {
  if (state.activeTrack) {
    stopRecording();
    return;
  }
  if (state.isPlaying) {
    stopTransport();
    return;
  }
  playAll();
});
exportButton.addEventListener("click", exportMix);
resetButton.addEventListener("click", () => {
  stopTransport();
  state.tracks.forEach((track) => clearTrack(track));
  clearSavedSketch();
  setStatus("");
});
saveMixButton.addEventListener("click", () => {
  if (!state.mixBlob) return;
  downloadBlob(state.mixBlob, `${safeFileName(mixName.value)}.${fileExtension(state.mixMimeType)}`);
});
openMixButton.addEventListener("click", () => {
  if (state.openedMix && !mixPanel.hidden) {
    mixPlayer.pause();
    mixPanel.hidden = true;
    openMixButton.classList.remove("opened");
    return;
  }
  openMixInput.click();
});
openMixInput.addEventListener("change", () => {
  const [file] = openMixInput.files;
  if (!file) return;
  setReadyMix(file, { opened: true });
  mixName.value = file.name.replace(/\.[^.]+$/, "");
  mixFormat.textContent = file.type || "ljudfil";
  openMixButton.classList.add("opened");
  openMixInput.value = "";
  setStatus("Ljudfilen är öppen.");
});
wakeAudioButton.addEventListener("click", async () => {
  try {
    await recoverAudioSession({ freshContext: true });
    hideAudioWarning();
    setStatus("");
  } catch {
    showAudioWarning(true);
  }
});
ignoreAudioButton.addEventListener("click", () => {
  hideAudioWarning({ ignore: true });
});
reloadAudioButton.addEventListener("click", () => {
  window.location.reload();
});
syncSlider.addEventListener("input", () => {
  setManualSyncOffset(Number(syncSlider.value) / 1000);
});

renderTracks();
syncSlider.value = String(Math.round(state.manualSyncOffset * 1000));
syncValue.textContent = state.manualSyncOffset ? `+${syncSlider.value} ms` : "auto";
updateTimingWaves();
restoreSavedSketch();
window.addEventListener("resize", () => {
  state.tracks.forEach((track) => {
    if (track.buffer) {
      drawTrackWaveform(track);
    } else if (state.activeTrack === track && track.livePeaks.length) {
      drawLiveWaveform(track);
    } else {
      drawEmptyWaveform(track);
    }
  });
});

function markAudioInterrupted() {
  state.audioRecoveryNeeded = true;
  stopTransport();
  if (state.activeTrack) {
    stopRecording();
  } else if (state.micStream) {
    forgetMicrophone({ stopTracks: true });
  }
  releaseScreenWakeLock();
}

function recoverAfterReturn() {
  if (document.visibilityState === "hidden" || !state.audioRecoveryNeeded) return;
  setStatus("");
  updateUi();
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    markAudioInterrupted();
    return;
  }
  recoverAfterReturn();
});
window.addEventListener("pageshow", recoverAfterReturn);
window.addEventListener("focus", recoverAfterReturn);

function updateTimingWaves() {
  const shift = Math.round(24 - (state.manualSyncOffset / 0.6) * 48);
  timingShift.setAttribute("transform", `translate(${shift} 0)`);
}

let timingDrag = null;

timingWaves.addEventListener("pointerdown", (event) => {
  timingDrag = {
    id: event.pointerId,
    startX: event.clientX,
    startOffset: state.manualSyncOffset,
  };
  timingWaves.setPointerCapture(event.pointerId);
});

timingWaves.addEventListener("pointermove", (event) => {
  if (!timingDrag || timingDrag.id !== event.pointerId) return;
  const box = timingWaves.getBoundingClientRect();
  const delta = timingDrag.startX - event.clientX;
  const next = timingDrag.startOffset + (delta / Math.max(1, box.width)) * 0.6;
  setManualSyncOffset(next);
});

function stopTimingDrag(event) {
  if (!timingDrag || timingDrag.id !== event.pointerId) return;
  timingDrag = null;
}

timingWaves.addEventListener("pointerup", stopTimingDrag);
timingWaves.addEventListener("pointercancel", stopTimingDrag);

function setManualSyncOffset(seconds, { saveSketch = true } = {}) {
  state.manualSyncOffset = Math.max(0, Math.min(0.6, seconds));
  syncSlider.value = String(Math.round(state.manualSyncOffset * 1000 / 10) * 10);
  syncValue.textContent = state.manualSyncOffset ? `+${syncSlider.value} ms` : "auto";
  updateTimingWaves();
  saveSyncOffset();
  state.tracks.forEach((track) => {
    if (track.buffer) drawBufferWaveform(track);
  });
  if (saveSketch) saveActiveSketch();
}
