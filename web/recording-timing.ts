export type RecordingTiming = {
  recorded: boolean;
  fps?: number;
  complete?: boolean;
  frame_offsets_ms: number[];
};
// The media stream may omit samples. Map wall-clock time to the actual encoded frame.
export function recordingSeek(offset: number, timing: RecordingTiming) {
  const times = timing.frame_offsets_ms;
  if (!times.length || !timing.fps) return null;
  let low = 0,
    high = times.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (times[mid] <= offset) low = mid + 1;
    else high = mid;
  }
  const frame = Math.max(0, low - 1);
  return {
    seconds: frame / timing.fps,
    sampled: times[frame],
    gap: offset < times[0] || offset - times[frame] > 1500 / timing.fps,
  };
}
export function elapsedLabel(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
