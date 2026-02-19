#!/bin/bash
set -euo pipefail

WIDTH="${WIDTH:-1920}"
HEIGHT="${HEIGHT:-1080}"
FPS="${FPS:-30}"
VIDEO_BITRATE="${VIDEO_BITRATE:-8000k}"
AUDIO_BITRATE="${AUDIO_BITRATE:-256k}"

if [ -z "${RESTREAM_URL:-}" ]; then
  echo "FATAL: RESTREAM_URL required (e.g. rtmp://live.restream.io/live/YOUR_STREAM_KEY)"
  exit 1
fi

if [ -z "${STREAM_URL:-}" ]; then
  echo "FATAL: STREAM_URL required (URL of website to stream)"
  exit 1
fi

cleanup() {
  echo "Shutting down..."
  kill "$FFMPEG_PID" 2>/dev/null || true
  kill "$CHROME_PID" 2>/dev/null || true
  kill "$XVFB_PID" 2>/dev/null || true
  kill "$HEALTH_PID" 2>/dev/null || true
  pulseaudio --kill 2>/dev/null || true
  exit 0
}
trap cleanup SIGTERM SIGINT

# --- Health check server ---
python3 /app/health.py &
HEALTH_PID=$!

# --- PulseAudio with virtual sink for Chromium audio ---
export XDG_RUNTIME_DIR=/tmp/runtime-root
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

# Clean stale state from previous runs (Docker restart)
pulseaudio --kill 2>/dev/null || true
rm -rf "${XDG_RUNTIME_DIR}/pulse" /root/.config/pulse/*.lock /tmp/pulse-* 2>/dev/null || true
sleep 0.5

dbus-launch --sh-syntax > /tmp/dbus-env 2>/dev/null || true
eval "$(cat /tmp/dbus-env 2>/dev/null)" || true

pulseaudio --start --exit-idle-time=-1 --log-level=error 2>/dev/null || true
sleep 1

PULSE_SOCK="${XDG_RUNTIME_DIR}/pulse/native"
for i in $(seq 1 10); do
  [ -S "$PULSE_SOCK" ] && break
  echo "Waiting for PulseAudio socket... ($i)"
  sleep 0.5
done

if [ ! -S "$PULSE_SOCK" ]; then
  echo "WARN: PulseAudio socket not at $PULSE_SOCK, searching..."
  PULSE_SOCK=$(find /tmp /root /run -name native -path '*/pulse/*' 2>/dev/null | head -1)
  if [ -z "$PULSE_SOCK" ]; then
    echo "FATAL: Cannot find PulseAudio socket"
    exit 1
  fi
  echo "Found PulseAudio socket at $PULSE_SOCK"
fi

export PULSE_SERVER="unix:${PULSE_SOCK}"
echo "PULSE_SERVER=${PULSE_SERVER}"

# Retry pactl commands (PulseAudio may need a moment)
for attempt in $(seq 1 5); do
  if pactl load-module module-null-sink sink_name=virtual_speaker sink_properties=device.description="VirtualSpeaker" 2>/dev/null; then
    break
  fi
  echo "pactl load-module failed, retrying ($attempt/5)..."
  sleep 1
done

pactl set-default-sink virtual_speaker
echo "PulseAudio ready: default sink → virtual_speaker"
pactl info | grep "Default Sink"

# --- Virtual display ---
Xvfb :99 -screen 0 "${WIDTH}x${HEIGHT}x24" -ac +extension GLX +render -noreset &
XVFB_PID=$!
sleep 2
echo "Display :99 ready (${WIDTH}x${HEIGHT})"

# --- Chromium in kiosk mode ---
launch_chrome() {
  chromium \
    --no-sandbox \
    --disable-gpu \
    --disable-dev-shm-usage \
    --disable-software-rasterizer \
    --window-size="${WIDTH},${HEIGHT}" \
    --start-fullscreen \
    --kiosk \
    --autoplay-policy=no-user-gesture-required \
    --disable-features=AudioServiceOutOfProcess \
    --disable-infobars \
    --hide-scrollbars \
    --no-first-run \
    --disable-translate \
    --disable-extensions \
    --disable-background-networking \
    --disable-sync \
    --disable-default-apps \
    --metrics-recording-only \
    "${STREAM_URL}" &
}

launch_chrome
CHROME_PID=$!
echo "Chrome launched → ${STREAM_URL}"
echo "Waiting for page load..."
sleep 10

# Simulate a click at center of page to unlock any remaining audio gating
xdotool mousemove $((WIDTH / 2)) $((HEIGHT / 2)) click 1 2>/dev/null || true

# Verify Chrome is sending audio to PulseAudio
echo "PulseAudio sink inputs (should show Chromium):"
pactl list sink-inputs short 2>/dev/null || true

# --- Build FFmpeg command ---
FFMPEG_ARGS=(
  ffmpeg -y
  -f x11grab -framerate "${FPS}" -video_size "${WIDTH}x${HEIGHT}" -i :99
)

MONITOR="virtual_speaker.monitor"
echo "Audio source: ${MONITOR}"
FFMPEG_ARGS+=(-f pulse -i "${MONITOR}")

FFMPEG_ARGS+=(
  -map 0:v:0 -map 1:a:0
  -c:v libx264 -preset medium -profile:v high -level 4.2
  -b:v "${VIDEO_BITRATE}" -maxrate "$((${VIDEO_BITRATE%k} * 12 / 10))k" -bufsize "$((${VIDEO_BITRATE%k} * 2))k"
  -pix_fmt yuv420p
  -g "$((FPS * 2))" -keyint_min "${FPS}" -r "${FPS}"
  -x264-params "rc-lookahead=40:ref=4:bframes=3:aq-mode=2"
  -c:a aac -profile:a aac_low -b:a "${AUDIO_BITRATE}" -ar 48000 -ac 2
  -f flv "${RESTREAM_URL}"
)

echo "Streaming → ${RESTREAM_URL}"

"${FFMPEG_ARGS[@]}" &
FFMPEG_PID=$!

# --- Watchdog: restart crashed processes ---
while true; do
  if ! kill -0 "$FFMPEG_PID" 2>/dev/null; then
    echo "FFmpeg died, restarting in 5s..."
    sleep 5
    "${FFMPEG_ARGS[@]}" &
    FFMPEG_PID=$!
  fi

  if ! kill -0 "$CHROME_PID" 2>/dev/null; then
    echo "Chrome died, restarting in 5s..."
    sleep 5
    launch_chrome
    CHROME_PID=$!
    sleep 10
    xdotool mousemove $((WIDTH / 2)) $((HEIGHT / 2)) click 1 2>/dev/null || true
  fi

  sleep 5
done
