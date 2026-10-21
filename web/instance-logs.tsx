import React, { useEffect, useState } from 'react';
import { Alert, Button, Drawer, Empty, Select, Space, Table, Tabs, Tag, Typography } from 'antd';
import { FileTextOutlined, ReloadOutlined } from '@ant-design/icons';
import type { TableColumnsType } from 'antd';
import { api, compactId, displayTime, type InstanceLogEvent, type InstanceLogs } from './api';

const { Text, Paragraph } = Typography;
const tools: Record<string, string> = {
  get_page: '查看页面',
  select_page: '切换标签页',
  evaluate: '执行页面脚本',
  read_element: '读取元素',
  list_network_requests: '查询网络请求',
  get_network_request: '读取请求详情',
  get_console_logs: '读取 Console',
  pointer: '鼠标操作',
  keyboard: '键盘操作',
  save_storage_state: '保存登录态',
  restore_storage_state: '恢复登录态',
  create_instance: '创建实例',
  close_instance: '关闭实例',
  get_instance: '读取实例',
  inspect_instance: '检查实例',
  verify_environment: '验证环境',
  create_page: '新建标签页',
  list_pages: '查询标签页',
  close_page: '关闭标签页',
  navigate: '网页导航',
  snapshot: '读取页面',
  screenshot: '截屏',
  interact: '页面交互',
  wait_for: '等待页面',
  handle_dialog: '处理弹窗',
  upload_file: '上传文件',
  list_downloads: '查询下载',
  get_diagnostics: '读取诊断',
  create_share_link: '创建分享链接',
  list_recordings: '查询录屏',
};
const actions: Record<string, string> = {
  double_click: '双击',
  right_click: '右键点击',
  drag: '拖拽',
  move: '移动鼠标',
  down: '按下',
  up: '抬起',
  wheel: '滚轮',
  type: '输入文字',
  goto: '打开网页',
  reload: '刷新网页',
  back: '后退',
  forward: '前进',
  click: '点击',
  fill: '输入',
  press: '按键',
  select: '选择选项',
  check: '勾选',
  hover: '悬停',
  scroll: '滚动',
};
type Call = {
  key: string;
  seq: number;
  time: string;
  tool: string;
  action?: string;
  status: 'running' | 'succeeded' | 'failed' | 'unfinished';
  elapsed?: number;
  url?: string;
  operationId?: string;
  pageId?: string;
  error?: string;
  errorMessage?: string;
  arguments?: Record<string, unknown>;
};
function callsFrom(entries: InstanceLogEvent[], ended: boolean) {
  const calls = new Map<string, Call>();
  for (const e of entries) {
    if (e.component !== 'operation') continue;
    const key = e.operation_id ?? `seq_${e.seq}`;
    const previous = calls.get(key);
    const f = e.fields ?? {};
    const tool = String(f.tool ?? 'unknown');
    calls.set(key, {
      key,
      seq: previous?.seq ?? e.seq,
      time: previous?.time ?? e.time,
      tool,
      action: typeof f.action === 'string' ? f.action : undefined,
      status:
        e.code === 'operation_succeeded'
          ? 'succeeded'
          : e.code === 'operation_failed'
            ? 'failed'
            : ended
              ? 'unfinished'
              : 'running',
      elapsed: typeof f.elapsed_ms === 'number' ? f.elapsed_ms : undefined,
      url: typeof f.url === 'string' ? f.url : undefined,
      operationId: e.operation_id,
      pageId: e.page_id,
      error: typeof f.error_code === 'string' ? f.error_code : undefined,
      errorMessage: typeof f.error_message === 'string' ? f.error_message : undefined,
      arguments: e.arguments ?? previous?.arguments,
    });
  }
  return [...calls.values()].sort((a, b) => b.seq - a.seq);
}
const statusTag = (status: Call['status']) => {
  const labels = { running: '执行中', succeeded: '成功', failed: '失败', unfinished: '无结束记录' };
  const colors = {
    running: 'processing',
    succeeded: 'success',
    failed: 'error',
    unfinished: 'default',
  };
  return <Tag color={colors[status]}>{labels[status]}</Tag>;
};
const callColumns: TableColumnsType<Call> = [
  { title: '调用时间', dataIndex: 'time', width: 135, render: displayTime },
  {
    title: '功能',
    key: 'tool',
    width: 150,
    render: (_, r) => (
      <div>
        <Text strong>{actions[r.action ?? ''] ?? tools[r.tool] ?? r.tool}</Text>
        <div className="cell-secondary">{r.tool}</div>
      </div>
    ),
  },
  { title: '结果', dataIndex: 'status', width: 100, render: statusTag },
  {
    title: '耗时',
    dataIndex: 'elapsed',
    width: 80,
    render: (v) => (v === undefined ? '—' : `${v} ms`),
  },
  {
    title: '目标 / 错误',
    key: 'detail',
    ellipsis: true,
    render: (_, r) => r.error ?? r.url ?? '—',
  },
];
const eventColumns: TableColumnsType<InstanceLogEvent> = [
  { title: '时间', dataIndex: 'time', width: 135, render: displayTime },
  {
    title: '级别',
    dataIndex: 'level',
    width: 80,
    render: (v) => (
      <Tag color={v === 'error' ? 'error' : v === 'warn' ? 'warning' : 'default'}>{v}</Tag>
    ),
  },
  { title: '事件', dataIndex: 'code', width: 230 },
  { title: '来源', dataIndex: 'component', width: 90 },
];

export function InstanceLogDrawer({
  instance,
  onClose,
}: {
  instance?: { instance_id: string; task_description?: string };
  onClose: () => void;
}) {
  const [kind, setKind] = useState('operation');
  const [status, setStatus] = useState('all');
  const [revision, setRevision] = useState(0);
  const [data, setData] = useState<InstanceLogs>();
  const [events, setEvents] = useState<InstanceLogEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    setKind('operation');
    setStatus('all');
  }, [instance?.instance_id]);
  useEffect(() => {
    setEvents([]);
    setData(undefined);
    setError('');
    if (!instance) return;
    const controller = new AbortController();
    let cursor: number | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ limit: '200' });
        if (kind === 'operation') params.set('component', 'operation');
        if (cursor !== undefined) params.set('after_seq', String(cursor));
        const next = await api<InstanceLogs>(
          `/api/instances/${instance.instance_id}/logs?${params}`,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        cursor = next.next_after_seq;
        setData((previous) => ({
          ...next,
          history_truncated: next.history_truncated || !!previous?.history_truncated,
        }));
        setEvents((previous) => [...previous, ...next.entries].slice(-1000));
        setError('');
        timer = setTimeout(() => void poll(), next.has_more ? 100 : 5000);
      } catch (e) {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : '无法读取日志');
        timer = setTimeout(() => void poll(), 5000);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [instance?.instance_id, kind, revision]);
  const calls = callsFrom(events, !!data?.instance.ended_at).filter(
    (r) => status === 'all' || r.status === status,
  );
  const task = data?.instance.task_description ?? instance?.task_description;
  return (
    <Drawer
      title={
        <Space>
          <FileTextOutlined />
          实例调用日志{instance && <Text type="secondary">{compactId(instance.instance_id)}</Text>}
        </Space>
      }
      open={!!instance}
      onClose={onClose}
      size={920}
      destroyOnHidden
    >
      <div className="instance-log-heading">
        <Text type="secondary">任务目标</Text>
        <Paragraph className="instance-task-full">{task ?? '未填写任务描述'}</Paragraph>
        <Text type="secondary" className="instance-log-id">
          {instance?.instance_id}
        </Text>
      </div>
      {error && <Alert type="warning" showIcon title={error} />}
      {(data?.history_truncated || !!data?.write_errors || !!data?.dropped_events) && (
        <Alert type="warning" showIcon title="部分历史日志可能已过期、轮转或未能写入。" />
      )}
      <Tabs
        activeKey={kind}
        onChange={setKind}
        items={[
          { key: 'operation', label: '功能调用' },
          { key: 'all', label: '全部事件' },
        ]}
      />
      <div className="table-toolbar">
        {kind === 'operation' && (
          <Select
            aria-label="筛选调用结果"
            value={status}
            onChange={setStatus}
            options={[
              { value: 'all', label: '全部结果' },
              { value: 'failed', label: '失败' },
              { value: 'succeeded', label: '成功' },
              { value: 'running', label: '执行中' },
              { value: 'unfinished', label: '无结束记录' },
            ]}
          />
        )}
        <Button
          icon={<ReloadOutlined />}
          loading={loading}
          onClick={() => setRevision((v) => v + 1)}
        >
          刷新日志
        </Button>
      </div>
      {kind === 'operation' ? (
        <Table
          className="instance-call-table"
          rowKey="key"
          size="small"
          loading={loading && !data}
          columns={callColumns}
          dataSource={calls}
          scroll={{ x: 720 }}
          pagination={{ pageSize: 20, showSizeChanger: false, hideOnSinglePage: true }}
          locale={{
            emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无调用记录" />,
          }}
          expandable={{
            expandedRowRender: (r) => (
              <div className="instance-log-detail">
                <div>操作 ID：{r.operationId ?? '—'}</div>
                <div>页面 ID：{r.pageId ?? '—'}</div>
                {r.url && <div>目标：{r.url}</div>}
                {r.error && <div>错误码：{r.error}</div>}
                {r.errorMessage && (
                  <pre className="instance-log-detail">
                    {r.errorMessage.replace(/\x1b\[[0-9;]*m/g, '')}
                  </pre>
                )}
                {r.arguments && (
                  <>
                    <Text type="secondary">调用参数</Text>
                    <pre className="instance-log-detail">
                      {JSON.stringify(r.arguments, null, 2)}
                    </pre>
                  </>
                )}
              </div>
            ),
          }}
        />
      ) : (
        <Table
          rowKey="seq"
          size="small"
          columns={eventColumns}
          dataSource={[...events].reverse()}
          scroll={{ x: 650 }}
          pagination={{ pageSize: 20, showSizeChanger: false, hideOnSinglePage: true }}
          expandable={{
            expandedRowRender: (r) => (
              <pre className="instance-log-detail">
                {JSON.stringify(
                  {
                    operation_id: r.operation_id,
                    page_id: r.page_id,
                    ...r.fields,
                    arguments: r.arguments,
                  },
                  null,
                  2,
                )}
              </pre>
            ),
          }}
        />
      )}
      <Paragraph type="secondary" className="table-footnote">
        每 5 秒自动更新；首次展示最近 200 条事件，最多保留本次查看的 1000 条。更多记录可通过 MCP
        get_logs 查询，默认保留 7 天。调用参数、完整 URL 和错误信息按原文保留。
      </Paragraph>
    </Drawer>
  );
}
