import type { IncomingMessage, ServerResponse } from 'node:http';
import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import type { BrowserManager } from './browser.js';
import type { Config } from './config.js';
const json = (res: ServerResponse, value: unknown, status: number) => {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(value));
};
export function frameMedia(
  manager: BrowserManager,
  res: ServerResponse,
  instanceId: string,
  pageId?: string,
) {
  const recorder = manager.recordings.active.get(instanceId);
  if (!recorder) {
    json(res, { error: 'Instance not active' }, 404);
    return;
  }
  if (pageId && !recorder.pages.has(pageId)) {
    json(res, { error: 'Unknown tab for this instance' }, 404);
    return;
  }
  const frame = recorder.frame(pageId);
  if (!frame) {
    res.statusCode = 204;
    res.end();
    return;
  }
  res.setHeader('content-type', 'image/jpeg');
  res.setHeader('content-length', frame.bytes.length);
  res.end(frame.bytes);
}
export function liveMedia(
  manager: BrowserManager,
  cfg: Config,
  res: ServerResponse,
  streams: Set<ServerResponse>,
  instanceId: string,
  allowed: () => boolean,
) {
  if (!manager.recordings.active.has(instanceId)) {
    json(res, { error: 'Instance not active' }, 404);
    return;
  }
  if (streams.size >= 50) {
    json(res, { error: 'Too many live viewers' }, 429);
    return;
  }
  streams.add(res);
  res.setHeader('content-type', 'multipart/x-mixed-replace; boundary=frame');
  res.setHeader('x-accel-buffering', 'no');
  res.flushHeaders();
  let last = 0;
  const tick = () => {
    if (!allowed()) {
      res.end();
      return;
    }
    const recorder = manager.recordings.active.get(instanceId);
    if (!recorder) {
      res.end();
      return;
    }
    const f = recorder.latest;
    if (!f || f.time === last) return;
    if (res.writableLength > 1048576) {
      res.destroy();
      return;
    }
    last = f.time;
    res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${f.bytes.length}\r\n\r\n`);
    res.write(f.bytes);
    res.write('\r\n');
  };
  const timer = setInterval(tick, Math.min(1000, Math.max(100, 1000 / cfg.videoFps)));
  timer.unref();
  res.once('close', () => {
    clearInterval(timer);
    streams.delete(res);
  });
  tick();
  return;
}
export async function videoMedia(
  manager: BrowserManager,
  req: IncomingMessage,
  res: ServerResponse,
  recordingId: string,
  allowed: () => boolean,
) {
  const { meta, path: file } = await manager.recordings.get(recordingId);
  if (['recording', 'finalizing'].includes(meta.status)) {
    json(res, { error: 'Recording is still active' }, 409);
    return;
  }
  const info = await stat(file).catch(() => null);
  if (!info || !info.size) {
    json(res, { error: 'Recording file unavailable' }, 404);
    return;
  }
  let start = 0,
    end = info.size - 1;
  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) {
      res.setHeader('content-range', `bytes */${info.size}`);
      res.statusCode = 416;
      res.end();
      return;
    }
    if (!match[1]) start = Math.max(0, info.size - Number(match[2]));
    else {
      start = Number(match[1]);
      if (match[2]) end = Math.min(end, Number(match[2]));
    }
    if (!Number.isSafeInteger(start) || start > end || start >= info.size) {
      res.setHeader('content-range', `bytes */${info.size}`);
      res.statusCode = 416;
      res.end();
      return;
    }
    res.statusCode = 206;
    res.setHeader('content-range', `bytes ${start}-${end}/${info.size}`);
  }
  res.setHeader('content-type', 'video/webm');
  res.setHeader('accept-ranges', 'bytes');
  res.setHeader('content-length', end - start + 1);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  if (!allowed()) {
    res.destroy();
    return;
  }
  const stream = createReadStream(file, { start, end });
  const timer = setInterval(() => {
    if (!allowed()) res.destroy();
  }, 500);
  timer.unref();
  stream.on('error', () => res.destroy());
  res.once('close', () => {
    clearInterval(timer);
    stream.destroy();
  });
  stream.pipe(res);
  return;
}
