import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Empty, Select, Space, Table, Tag, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { api, displayTime } from './api';
type Event = {
  seq: number;
  time: string;
  page_id: string;
  navigation_id: string;
  hop_id: string;
  kind: string;
  url: string;
  to_url?: string;
  status?: number;
  error?: string;
  filename?: string;
  elapsed_ms?: number;
  url_truncated?: boolean;
  operation_id?: string;
};
type History = {
  recorded: boolean;
  entries: Event[];
  next_after_seq: number;
  has_more: boolean;
  history_truncated: boolean;
  dropped_events: number;
  write_errors: number;
};
const labels: Record<string, string> = {
  request: '发起请求',
  redirect: 'HTTP 跳转',
  response: '收到响应',
  committed: '页面落地',
  loaded: 'DOM 已加载',
  same_document: '页内地址变化',
  external_protocol: 'App / 商店链接',
  failed: '中止 / 失败',
  download: '触发下载',
  capture_warning: '采集不完整',
};
const { Text, Paragraph } = Typography;
export function NavigationHistory({
  instanceId,
  pages,
  active,
}: {
  instanceId: string;
  pages: { page_id: string; url: string }[];
  active: boolean;
}) {
  const [page, setPage] = useState<string>();
  const [rows, setRows] = useState<Event[]>([]);
  const [state, setState] = useState<History>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const cursor = useRef<number | undefined>(undefined);
  const busy = useRef(false);
  const serial = useRef(0);
  const load = useCallback(
    async (reset: boolean, signal?: AbortSignal) => {
      if (busy.current && !reset) return;
      const version = ++serial.current;
      busy.current = true;
      setLoading(true);
      try {
        const params = new URLSearchParams({ limit: '100' });
        if (page) params.set('page_id', page);
        if (!reset && cursor.current !== undefined) params.set('after_seq', String(cursor.current));
        const result = await api<History>(
          `/api/instances/${instanceId}/navigation?${params}`,
          signal,
        );
        if (signal?.aborted || version !== serial.current) return;
        cursor.current = result.next_after_seq;
        setRows((old) =>
          [
            ...new Map([...(reset ? [] : old), ...result.entries].map((e) => [e.seq, e])).values(),
          ].slice(-1000),
        );
        setState(result);
        setError(undefined);
      } catch (e) {
        if (!signal?.aborted && version === serial.current)
          setError(e instanceof Error ? e.message : '读取失败');
      } finally {
        if (version === serial.current) {
          busy.current = false;
          if (!signal?.aborted) setLoading(false);
        }
      }
    },
    [instanceId, page],
  );
  useEffect(() => {
    const controller = new AbortController();
    cursor.current = undefined;
    setRows([]);
    setState(undefined);
    void load(true, controller.signal);
    const timer = active ? setInterval(() => void load(false, controller.signal), 5000) : undefined;
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [load, active]);
  return (
    <Card
      className="section-card navigation-history-card"
      title="跳转历史"
      extra={
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load(true)}>
          刷新
        </Button>
      }
    >
      <Paragraph type="secondary">
        记录顶层页面的完整地址、HTTP
        重定向、页内地址变化、下载和中止。App／商店链接需要外部应用处理，不代表网页已成功打开。旧实例未采集的数据无法补回。
      </Paragraph>
      <Space wrap style={{ marginBottom: 16 }}>
        <Select
          aria-label="跳转历史标签页"
          allowClear
          placeholder="全部标签页"
          value={page}
          onChange={setPage}
          style={{ width: 240 }}
          options={pages.map((p) => ({
            value: p.page_id,
            label: `${p.page_id.replace('page_', '').slice(0, 8)} · ${p.url}`,
          }))}
        />
        <Text type="secondary">
          {rows.length} 条记录{active ? ' · 自动更新' : ''}
        </Text>
      </Space>
      {error && <Alert showIcon type="error" title={error} />}
      {state?.recorded &&
      (state.history_truncated ||
        state.dropped_events ||
        state.write_errors ||
        rows.length === 1000) ? (
        <Alert
          showIcon
          type="warning"
          title="部分历史可能已清理、截断或未写入"
          description="记录受日志保留时间和容量限制；界面最多显示最近加载的 1000 条，MCP 可继续分页读取保留范围内的事件。"
        />
      ) : null}
      {state && !state.recorded ? (
        <Empty description="此实例创建时尚未启用跳转历史；可查看原调用日志和录屏。" />
      ) : (
        <Table<Event>
          size="small"
          rowKey="seq"
          tableLayout="fixed"
          loading={loading && !rows.length}
          dataSource={rows}
          scroll={{ x: 920 }}
          pagination={{ pageSize: 20, showSizeChanger: false }}
          expandable={{
            expandedRowRender: (r) => (
              <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0 }}>
                {JSON.stringify(r, null, 2)}
              </pre>
            ),
          }}
          columns={[
            { title: '时间', dataIndex: 'time', width: 155, render: displayTime },
            {
              title: '标签页',
              dataIndex: 'page_id',
              width: 105,
              render: (id: string) => <Text title={id}>{id.replace('page_', '').slice(0, 8)}</Text>,
            },
            {
              title: '事件 / 状态',
              width: 145,
              render: (_, r) => (
                <Space wrap size={2}>
                  <Tag
                    color={
                      r.kind === 'failed'
                        ? 'error'
                        : r.kind === 'external_protocol'
                          ? 'purple'
                          : r.kind === 'loaded'
                            ? 'success'
                            : 'default'
                    }
                  >
                    {labels[r.kind] ?? r.kind}
                  </Tag>
                  {r.status && <Tag>{r.status}</Tag>}
                </Space>
              ),
            },
            {
              title: '地址 / 跳转到',
              width: 420,
              render: (_, r) => (
                <div style={{ minWidth: 0 }}>
                  <Paragraph
                    style={{ margin: 0 }}
                    ellipsis={{ rows: 1 }}
                    copyable={{ text: r.url }}
                    title={r.url}
                  >
                    {r.url}
                  </Paragraph>
                  {r.to_url && (
                    <Paragraph
                      style={{ margin: 0 }}
                      ellipsis={{ rows: 1 }}
                      copyable={{ text: r.to_url }}
                      title={r.to_url}
                    >
                      → {r.to_url}
                    </Paragraph>
                  )}
                  {r.error && <Text type="danger">{r.error}</Text>}
                  {r.url_truncated && <Tag color="warning">URL 超出记录上限</Tag>}
                </div>
              ),
            },
            {
              title: '耗时',
              width: 95,
              render: (_, r) => (r.elapsed_ms === undefined ? '—' : `${r.elapsed_ms} ms`),
            },
          ]}
        />
      )}
      {state?.has_more && (
        <Button onClick={() => void load(false)} loading={loading}>
          加载后续记录
        </Button>
      )}
    </Card>
  );
}
