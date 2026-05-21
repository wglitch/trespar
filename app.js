const trackDefaults = ["Spår ett", "Spår två", "Spår tre"];
const preferredMimes = [
  "audio/webm;codecs=opus",
  "audio/ogg;codecs=opus",
  "audio/webm",
  "audio/mp4",
];

const tracksRoot = document.querySelector("#tracks");
const trackTemplate = document.querySelector("#trackTemplate");
const armMicButton = document.querySelector("#armMicButton");
const playButton = document.querySelector("#playButton");
const stopButton = document.querySelector("#stopButton");
const exportButton = document.querySelector("#exportButton");
const resetButton = document.querySelector("#resetButton");
const clockValue = document.querySelector("#clockValue");
const lengthValue = document.querySelector("#lengthValue");
const timelineFill = document.querySelector("#timelineFill");
const statusText = document.querySelector("#statusText");
const syncSlider = document.querySelector("#syncSlider");
const syncValue = document.querySelector("#syncValue");

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
  tracks: [],
};

function chooseMimeType() {
  if (!window.MediaRecorder) return "";
  return preferredMimes.find((mime) => MediaRecorder.isTypeSupported(mime)) || "";
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
  armMicButton.classList.add("ready");
  armMicButton.innerHTML = '<span aria-hidden="true"></span>Mikrofon klar';
  return state.micStream;
}

async function decodeBlob(blob) {
  const context = await ensureAudioContext();
  return context.decodeAudioData(await blob.arrayBuffer());
}

function renderTracks() {
  state.tracks = trackDefaults.map((name, index) => {
    const fragment = trackTemplate.content.cloneNode(true);
    const card = fragment.querySelector(".track-card");
    const nameLabel = fragment.querySelector(".track-name");
    const trackState = fragment.querySelector(".track-state");
    const recordButton = fragment.querySelector(".record-button");
    const recordLabel = recordButton.querySelector("b");
    const progress = fragment.querySelector(".take-progress");
    const waveform = fragment.querySelector(".waveform");
    const playTrackButton = fragment.querySelector(".play-track-button");
    const muteButton = fragment.querySelector(".mute-button");
    const clearButton = fragment.querySelector(".clear-button");

    nameLabel.textContent = name;
    card.dataset.track = index;
    recordButton.addEventListener("click", () => toggleRecording(track));
    playTrackButton.addEventListener("click", () => playTrack(track));
    muteButton.addEventListener("click", () => toggleMute(track));
    clearButton.addEventListener("click", () => clearTrack(track));
    const track = {
      index,
      name,
      blob: null,
      buffer: null,
      url: "",
      muted: false,
      livePeaks: [],
      syncOffset: 0,
      elements: {
        card,
        nameLabel,
        trackState,
        recordButton,
        recordLabel,
        progress,
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
  lengthValue.textContent = state.baseDuration
    ? `Längd ${formatTime(state.baseDuration)}`
    : "Spår ett sätter längden";

  state.tracks.forEach((track) => {
    const readyForOverdub = track.index === 0 || state.baseDuration > 0;
    const busyElsewhere = !!state.activeTrack && state.activeTrack !== track;
    const { recordButton, recordLabel, trackState, playTrackButton, muteButton, clearButton, progress } =
      track.elements;
    recordButton.disabled =
      !readyForOverdub ||
      busyElsewhere ||
      (state.isPlaying && state.activeTrack !== track) ||
      state.exportBusy;
    recordButton.classList.toggle("recording", state.activeTrack === track);
    recordButton.classList.toggle("armed", !track.blob && readyForOverdub);
    recordLabel.textContent = state.activeTrack === track
      ? "Stoppa"
      : track.blob
        ? "Ta om"
        : "Spela in";
    trackState.textContent = state.activeTrack === track
      ? "spelar in"
      : track.blob
        ? track.muted
          ? "tyst"
          : "klar"
        : readyForOverdub
          ? "tom"
          : "vantar";
    muteButton.disabled = !track.blob;
    playTrackButton.disabled = !track.blob || !!state.activeTrack || state.exportBusy;
    clearButton.disabled = !track.blob || !!state.activeTrack;
    if (!state.isPlaying && state.activeTrack !== track) {
      progress.style.width = "0";
    }
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
  track.elements.progress.style.width = "0";
  track.muted = false;
  track.livePeaks = [];
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
    clockValue.textContent = "00:00.0";
    animateRecordClock(track);
    setStatus("Spår ett spelar in fritt.");
    return;
  }

  await playAll({ excludeTrack: track, forRecording: true });
  state.recordLimitTimer = window.setTimeout(
    stopRecording,
    (state.baseDuration + getOverdubSyncOffset() + 0.08) * 1000,
  );
  setStatus(`${track.name} spelar in mot de andra spåren.`);
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

  clockValue.textContent = formatTime(track.index === 0 ? state.baseDuration : Math.min(duration, state.baseDuration));
    setStatus(`${track.name} sparad.`);
}

function clearTrack(track, announce = true) {
  if (state.activeTrack === track) return;
  if (track.url) URL.revokeObjectURL(track.url);
  track.blob = null;
  track.buffer = null;
  track.livePeaks = [];
  track.syncOffset = 0;
  track.url = "";
  track.muted = false;
  track.elements.muteButton.setAttribute("aria-pressed", "false");
  drawEmptyWaveform(track);

  if (track.index === 0) {
    state.baseDuration = 0;
    state.tracks.slice(1).forEach((overdub) => clearTrack(overdub, false));
    clockValue.textContent = "00:00.0";
    timelineFill.style.width = "0";
  }

  if (announce) setStatus(`${track.name} raderad.`);
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
  timelineFill.style.width = "0";
  updateUi();
}

function animateTransport(duration) {
  window.cancelAnimationFrame(state.transportFrame);
  const tick = () => {
    if (!state.isPlaying) return;
    const elapsed = Math.max(0, state.audioContext.currentTime - state.transportStartedAt);
    const bounded = Math.min(duration, elapsed);
    clockValue.textContent = formatTime(bounded);
    timelineFill.style.width = `${Math.min(100, (bounded / duration) * 100)}%`;
    state.transportTracks.forEach((track) => {
      track.elements.progress.style.width = `${Math.min(100, (bounded / duration) * 100)}%`;
    });
    if (state.activeTrack) state.activeTrack.elements.progress.style.width = `${Math.min(100, (bounded / duration) * 100)}%`;
    state.transportFrame = window.requestAnimationFrame(tick);
  };
  tick();
}

function animateRecordClock(track) {
  const tick = () => {
    if (state.activeTrack !== track) return;
    const elapsed = (performance.now() - state.recordStartedAt) / 1000;
    clockValue.textContent = formatTime(elapsed);
    track.elements.progress.style.width = state.baseDuration
      ? `${Math.min(100, (elapsed / state.baseDuration) * 100)}%`
      : "100%";
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
    track.livePeaks.push(Math.max(0.025, peak));
    if (track.livePeaks.length > 720) track.livePeaks.shift();
    drawPeakWaveform(track, normalizePeaks(track.livePeaks), "live");
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
  context.strokeStyle = "rgba(245, 242, 233, 0.16)";
  context.beginPath();
  context.moveTo(0, middle);
  context.lineTo(width, middle);
  context.stroke();
}

function drawBufferWaveform(track) {
  if (!track.buffer) {
    drawEmptyWaveform(track);
    return;
  }

  const channel = track.buffer.getChannelData(0);
  const barCount = 360;
  const sampleWindow = Math.max(1, Math.floor(channel.length / barCount));
  const peaks = Array.from({ length: barCount }, (_, index) => {
    let peak = 0;
    const start = index * sampleWindow;
    const end = Math.min(channel.length, start + sampleWindow);
    for (let sample = start; sample < end; sample += 1) {
      peak = Math.max(peak, Math.abs(channel[sample]));
    }
    return Math.max(0.018, peak);
  });
  drawPeakWaveform(track, normalizePeaks(peaks), track.index === 0 ? "base" : "take");
}

function drawPeakWaveform(track, peaks, tone) {
  const { waveform } = track.elements;
  const context = waveform.getContext("2d");
  const { width, height, ratio } = resizeCanvas(waveform);
  const center = height / 2;
  const gap = Math.max(1.5 * ratio, width / Math.max(peaks.length, 1) * 0.18);
  const barWidth = Math.max(1.2 * ratio, width / Math.max(peaks.length, 1) - gap);
  const colors = {
    base: "#55d5a4",
    live: "#ff796d",
    take: "#6db8ff",
  };

  context.clearRect(0, 0, width, height);
  context.strokeStyle = "rgba(245, 242, 233, 0.08)";
  context.lineWidth = ratio;
  context.beginPath();
  context.moveTo(0, center);
  context.lineTo(width, center);
  context.stroke();
  context.fillStyle = colors[tone];

  peaks.forEach((peak, index) => {
    const x = index * (width / Math.max(peaks.length, 1));
    const amplitude = Math.max(3 * ratio, peak * height * 0.44);
    context.fillRect(x, center - amplitude, barWidth, amplitude * 2);
  });
}

function normalizePeaks(peaks) {
  const ceiling = Math.max(0.06, ...peaks);
  return peaks.map((peak) => Math.max(0.03, Math.sqrt(peak / ceiling)));
}

async function exportMix() {
  const mixTracks = state.tracks.filter((track) => track.buffer && !track.muted);
  if (!mixTracks.length) return;

  try {
    state.exportBusy = true;
    updateUi();
    setStatus("Exporterar mixen i realtid...");
    const context = await ensureAudioContext();
    const destination = context.createMediaStreamDestination();
    const outputGain = context.createGain();
    outputGain.gain.value = 0.82 / Math.max(1, mixTracks.length * 0.72);
    outputGain.connect(destination);
    outputGain.connect(context.destination);

    const mimeType = chooseMimeType();
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
    downloadBlob(blob, `trespar.${fileExtension(blob.type)}`);
    setStatus(`Mixen är klar som ${fileExtension(blob.type).toUpperCase()}.`);
  } catch (error) {
    setStatus(error.message || "Exporten gick inte att göra.", true);
  } finally {
    state.exportBusy = false;
    updateUi();
  }
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

armMicButton.addEventListener("click", async () => {
  try {
    await prepareMicrophone();
    setStatus("Mikrofonen är redo.");
  } catch (error) {
    setStatus(error.message || "Mikrofonen kunde inte startas.", true);
  }
});

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
    setStatus("Alla spår är tomma igen.");
});
syncSlider.addEventListener("input", () => {
  state.manualSyncOffset = Number(syncSlider.value) / 1000;
  syncValue.textContent = state.manualSyncOffset ? `+${syncSlider.value} ms` : "auto";
});

renderTracks();
window.addEventListener("resize", () => {
  state.tracks.forEach((track) => {
    if (track.buffer) {
      drawBufferWaveform(track);
    } else if (state.activeTrack === track && track.livePeaks.length) {
      drawPeakWaveform(track, track.livePeaks, "live");
    } else {
      drawEmptyWaveform(track);
    }
  });
});
