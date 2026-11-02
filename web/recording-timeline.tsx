import React from 'react';
import { Empty, Slider, Typography } from 'antd';
import { compactId, type Recording } from './api';
import { elapsedLabel } from './recording-timing';

export function RecordingTimeline({
  recordings,
  origin,
  end,
  selected,
  offset,
  onPick,
  onSeek,
}: {
  recordings: Recording[];
  origin: number;
  end: number;
  selected?: string;
  offset: number;
  onPick: (r: Recording, offset: number) => void;
  onSeek: (offset: number) => void;
}) {
  const duration = Math.max(1, end - origin);
  return (
    <section className="recording-timeline" aria-label="所有标签页统一时间轴">
      <div className="recording-timeline-heading">
        <Typography.Text strong>标签页时间轴</Typography.Text>
        <Typography.Text type="secondary">
          {elapsedLabel(offset)} / {elapsedLabel(duration)}
        </Typography.Text>
      </div>
      <Slider
        aria-label="实例时间轴定位"
        min={0}
        max={duration}
        step={250}
        value={Math.min(offset, duration)}
        onChange={onSeek}
        tooltip={{ formatter: (v) => elapsedLabel(v ?? 0) }}
      />
      {!recordings.length && (
        <Empty description="暂无录屏轨道" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      )}
      {[...recordings]
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .map((r) => {
          const start = r.started_offset_ms ?? Math.max(0, Date.parse(r.created_at) - origin);
          const finish =
            r.ended_offset_ms ?? (r.ended_at ? Date.parse(r.ended_at) - origin : duration);
          return (
            <div
              key={r.id}
              className={`recording-timeline-row ${selected === r.id ? 'selected' : ''}`}
            >
              <button
                className="recording-track-label"
                title={`${r.page_title ?? ''}\n${r.page_url ?? ''}`}
                onClick={() => onPick(r, Math.max(start, Math.min(offset, finish)))}
              >
                <strong>{r.page_id ? `Tab ${compactId(r.page_id)}` : '旧版混合录屏'}</strong>
                <span>{r.page_title || r.page_url || '空白页'}</span>
              </button>
              <div className="recording-track-rail">
                <button
                  aria-label={`定位 ${r.page_id ? `Tab ${compactId(r.page_id)}` : '旧版录屏'}`}
                  className={`recording-track-bar ${r.status === 'failed' ? 'failed' : ''}`}
                  style={{
                    left: `${(start / duration) * 100}%`,
                    width: `${Math.max(0.5, ((finish - start) / duration) * 100)}%`,
                  }}
                  onClick={(e) => {
                    const box = e.currentTarget.getBoundingClientRect();
                    onPick(
                      r,
                      start +
                        (finish - start) *
                          Math.max(0, Math.min(1, (e.clientX - box.left) / box.width)),
                    );
                  }}
                  title={`${elapsedLabel(start)}—${elapsedLabel(finish)} · ${r.status}`}
                />
                <span
                  className="recording-track-cursor"
                  style={{ left: `${(offset / duration) * 100}%` }}
                />
              </div>
              <span className="recording-track-state">
                {r.status === 'recording'
                  ? '录制中'
                  : r.status === 'finalizing'
                    ? '处理中'
                    : r.status === 'completed'
                      ? '可回放'
                      : r.status === 'empty'
                        ? '无画面'
                        : r.status === 'failed'
                          ? '失败'
                          : r.status === 'interrupted'
                            ? '中断'
                            : r.status === 'limit_reached'
                              ? '达上限'
                              : r.status}
              </span>
            </div>
          );
        })}
      <Typography.Text type="secondary">
        横轴为实例经过时间。点击轨道选择 Tab 和时刻；录制中的 Tab 显示直播，结束后可定位回放。
      </Typography.Text>
    </section>
  );
}
