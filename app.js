const preferredMimes = [
  "audio/webm;codecs=opus",
  "audio/ogg;codecs=opus",
  "audio/webm",
  "audio/mp4",
];
const waveformBars = 360;
const syncStorageKey = "trespar-sync-offset-ms";

const tracksRoot = document.querySelector("#tracks");
const trackTemplate = document.querySelector("#trackTemplate");
const playButton = document.querySelector("#playButton");
const stopButton = document.querySelector("#stopButton");
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
const openMixInput = document.querySelector("#openMixInput");
const mixFormat = document.querySelector("#mixFormat");

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
  isPlaying: false,
  exportBusy: false,
  baseDuration: 0,
  manualSyncOffset: 0,
  mixBlob: null,
  mixUrl: "",
  mixMimeType: "",
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

function formatTime(seconds) {
  const safeSeconds = Math.max(0, seconds || 0);
  const minutes = Math.floor(safeSeconds / 60).toString().padStart(2, "0");
  const wholeSeconds = Math.floor(safeSeconds % 60).toString().padStart(2, "0");
  const tenths = Math.floor((safeSeconds % 1) * 10);
  return `${minutes}:${wholeSeconds}.${tenths}`;
}

function ensureAudioContext() {
  if (!state.audioContext) {
    state.audioContext = new AudioContext({ latencyHint: "interactive" });
  }
  return state.audioContext.resume().then(() => state.audioContext);
}

async function prepareMicrophone() {
  if (state.micStream) return state.micStream;
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

  const context = await ensureAudioContext();
  state.meterSource = context.createMediaStreamSource(state.micStream);
  state.analyser = context.createAnalyser();
  state.analyser.fftSize = 256;
  state.meterSource.connect(state.analyser);
  return state.micStream;
}

async function decodeBlob(blob) {
  const context = await ensureAudioContext();
  return context.decodeAudioData(await blob.arrayBuffer());
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
    const clearButton = fragment.querySelector(".clear-button");

    card.dataset.track = index;
    recordButton.addEventListener("click", () => toggleRecording(track));
    playTrackButton.addEventListener("click", () => playTrack(track));
    muteButton.addEventListener("click", () => toggleMute(track));
    clearButton.addEventListener("click", () => clearTrack(track));
    const track = {
      index,
      blob: null,
      buffer: null,
      url: "",
      muted: false,
      livePeaks: [],
      livePeakCursor: 0,
      syncOffset: 0,
      playFraction: 0,
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
  playButton.disabled = !hasTake || state.isPlaying || !!state.activeTrack || state.exportBusy;
  stopButton.disabled = !state.isPlaying && !state.activeTrack;
  exportButton.disabled = !hasTake || !!state.activeTrack || state.isPlaying || state.exportBusy;
  resetButton.disabled = !hasTake || !!state.activeTrack || state.exportBusy;
  state.tracks.forEach((track) => {
    const readyForOverdub = track.index === 0 || state.baseDuration > 0;
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
  stopTransport();

  if (track.index > 0 && !state.baseDuration) {
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
      updateUi();
    }
  });

  state.recorder.start(250);
  updateUi();
  startLiveWaveform(track);

  if (track.index === 0) {
    animateRecordClock(track);
    setStatus("Första inspelningen sätter längden.");
    return;
  }

  await playAll({ excludeTrack: track, forRecording: true });
  state.recordLimitTimer = window.setTimeout(
    stopRecording,
    (state.baseDuration + getOverdubSyncOffset() + 0.08) * 1000,
  );
  setStatus("Ny inspelning lägger sig mot de andra.");
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
  track.buffer = await decodeBlob(blob);
  track.elements.clearButton.disabled = false;
  drawBufferWaveform(track);

  if (track.index === 0) {
    state.baseDuration = duration;
    state.tracks.slice(1).forEach((overdub) => clearTrack(overdub, false));
  }

  setStatus("Inspelningen är klar.");
}

function clearTrack(track, announce = true) {
  if (state.activeTrack === track) return;
  if (track.url) URL.revokeObjectURL(track.url);
  track.blob = null;
  track.buffer = null;
  track.livePeaks = [];
  track.livePeakCursor = 0;
  track.syncOffset = 0;
  track.url = "";
  track.muted = false;
  track.elements.muteButton.setAttribute("aria-pressed", "false");
  drawEmptyWaveform(track);

  if (track.index === 0) {
    state.baseDuration = 0;
    state.tracks.slice(1).forEach((overdub) => clearTrack(overdub, false));
  }

  if (announce) setStatus("Inspelningen raderades.");
  updateUi();
}

function toggleMute(track) {
  track.muted = !track.muted;
  track.elements.muteButton.setAttribute("aria-pressed", String(track.muted));
  updateUi();
}

function getReportedLatency() {
  const outputLatency = state.audioContext?.outputLatency || 0;
  const baseLatency = state.audioContext?.baseLatency || 0;
  const micLatency = state.micStream?.getAudioTracks()[0]?.getSettings().latency || 0;
  return Math.max(0, outputLatency + baseLatency + micLatency);
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
  await playAll({ soloTrack: track });
}

async function playAll({ excludeTrack = null, soloTrack = null, forRecording = false } = {}) {
  const playableTracks = state.tracks.filter((track) => {
    return track !== excludeTrack && track.buffer && !track.muted && (!soloTrack || track === soloTrack);
  });
  if (!playableTracks.length) return;

  const context = await ensureAudioContext();
  stopTransport();
  state.isPlaying = true;
  state.transportStartedAt = context.currentTime + 0.04;
  state.transportTracks = playableTracks;
  state.transportSources = playableTracks.map((track) => {
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = track.buffer;
    gain.gain.value = 1;
    source.connect(gain).connect(context.destination);
    const offset = getTrackOffset(track);
    source.start(
      state.transportStartedAt,
      offset,
      Math.max(0.02, Math.min(state.baseDuration || track.buffer.duration, track.buffer.duration - offset)),
    );
    return source;
  });

  const duration = state.baseDuration || Math.max(...playableTracks.map((track) => track.buffer.duration));
  state.transportStopTimer = window.setTimeout(stopTransport, duration * 1000 + 80);
  animateTransport(duration);
  if (!forRecording) setStatus("Spelar upp alla aktiva spår.");
  updateUi();
}

function stopTransport() {
  state.transportSources.forEach((source) => {
    try {
      source.stop();
    } catch {
      // Source already ended.
    }
  });
  state.transportSources = [];
  state.transportTracks = [];
  state.isPlaying = false;
  window.clearTimeout(state.transportStopTimer);
  window.cancelAnimationFrame(state.transportFrame);
  state.transportStopTimer = 0;
  state.tracks.forEach((track) => {
    track.playFraction = 0;
    drawTrackWaveform(track);
  });
  updateUi();
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
    state.transportFrame = window.requestAnimationFrame(tick);
  };
  tick();
}

function animateRecordClock(track) {
  const tick = () => {
    if (state.activeTrack !== track) return;
    const elapsed = (performance.now() - state.recordStartedAt) / 1000;
    track.playFraction = state.baseDuration ? elapsed / state.baseDuration : 1;
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
  context.lineWidth = ratio;
  context.strokeStyle = getTrackColor(track, 0.55);
  context.beginPath();
  context.moveTo(0, middle);
  context.lineTo(width, middle);
  context.stroke();
}

function getBufferPeaks(track) {
  if (!track.buffer) {
    return [];
  }

  const channel = track.buffer.getChannelData(0);
  const firstSample = Math.floor(getTrackOffset(track) * track.buffer.sampleRate);
  const visibleSamples = state.baseDuration
    ? Math.min(channel.length - firstSample, Math.floor(state.baseDuration * track.buffer.sampleRate))
    : channel.length - firstSample;
  const barCount = waveformBars;
  const naturalBars = state.baseDuration && track.index > 0
    ? Math.max(1, Math.min(barCount, Math.round((visibleSamples / track.buffer.sampleRate / state.baseDuration) * barCount)))
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
  return normalizePeaks(peaks);
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
  context.strokeStyle = getTrackColor(track, 0.92);
  context.lineWidth = ratio;
  context.beginPath();
  context.moveTo(0, center);
  context.lineTo(width, center);
  context.stroke();
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
    context.strokeStyle = getTrackColor(track, 0.18);
    context.beginPath();
    context.moveTo(futureX, center);
    context.lineTo(width, center);
    context.stroke();
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

function normalizePeaks(peaks) {
  const audiblePeaks = peaks.filter((peak) => peak > 0.025);
  const ceiling = Math.max(0.08, ...audiblePeaks);
  return peaks.map((peak) => {
    if (peak <= 0.025) return 0;
    return Math.sqrt((peak - 0.025) / Math.max(0.001, ceiling - 0.025));
  });
}

function captureLivePeak(track, peak) {
  if (track.index > 0 && state.baseDuration) {
    if (!track.livePeaks.length) track.livePeaks = Array(waveformBars).fill(0);
    const elapsed = (performance.now() - state.recordStartedAt) / 1000;
    const index = Math.min(waveformBars - 1, Math.floor((elapsed / state.baseDuration) * waveformBars));
    track.livePeaks[index] = Math.max(track.livePeaks[index], peak);
    track.livePeakCursor = Math.max(track.livePeakCursor, index + 1);
    return;
  }

  track.livePeaks.push(peak);
  if (track.livePeaks.length > waveformBars) track.livePeaks.shift();
  track.livePeakCursor = track.livePeaks.length;
}

function getLiveFraction(track) {
  if (track.index > 0 && state.baseDuration) {
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
  const mixTracks = state.tracks.filter((track) => track.buffer && !track.muted);
  if (!mixTracks.length) return;

  try {
    state.exportBusy = true;
    updateUi();
    setStatus("Gör färdig mixen...");
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
    const duration = state.baseDuration || Math.max(...mixTracks.map((track) => track.buffer.duration));
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
    setStatus("Mixen är klar.");
  } catch (error) {
    setStatus(error.message || "Exporten gick inte att göra.", true);
  } finally {
    state.exportBusy = false;
    updateUi();
  }
}

function setReadyMix(blob) {
  if (state.mixUrl) URL.revokeObjectURL(state.mixUrl);
  state.mixBlob = blob;
  state.mixMimeType = blob.type;
  state.mixUrl = URL.createObjectURL(blob);
  mixPlayer.src = state.mixUrl;
  mixPanel.hidden = false;
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

playButton.addEventListener("click", () => playAll());
stopButton.addEventListener("click", () => {
  stopTransport();
  stopRecording();
  setStatus("Stopp.");
});
exportButton.addEventListener("click", exportMix);
resetButton.addEventListener("click", () => {
  stopTransport();
  state.tracks.forEach((track) => clearTrack(track, false));
    setStatus("");
});
saveMixButton.addEventListener("click", () => {
  if (!state.mixBlob) return;
  downloadBlob(state.mixBlob, `${safeFileName(mixName.value)}.${fileExtension(state.mixMimeType)}`);
});
openMixInput.addEventListener("change", () => {
  const [file] = openMixInput.files;
  if (!file) return;
  setReadyMix(file);
  mixName.value = file.name.replace(/\.[^.]+$/, "");
  mixFormat.textContent = file.type || "ljudfil";
  setStatus("Ljudfilen är öppen.");
});
syncSlider.addEventListener("input", () => {
  setManualSyncOffset(Number(syncSlider.value) / 1000);
});

renderTracks();
syncSlider.value = String(Math.round(state.manualSyncOffset * 1000));
syncValue.textContent = state.manualSyncOffset ? `+${syncSlider.value} ms` : "auto";
updateTimingWaves();
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

function setManualSyncOffset(seconds) {
  state.manualSyncOffset = Math.max(0, Math.min(0.6, seconds));
  syncSlider.value = String(Math.round(state.manualSyncOffset * 1000 / 10) * 10);
  syncValue.textContent = state.manualSyncOffset ? `+${syncSlider.value} ms` : "auto";
  updateTimingWaves();
  saveSyncOffset();
  state.tracks.forEach((track) => {
    if (track.buffer) drawBufferWaveform(track);
  });
}
