import React, { useEffect, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  Row,
  Select,
  Space,
  Spin,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import { ArrowLeftOutlined, CopyOutlined, ReloadOutlined } from '@ant-design/icons';
import {
  api,
  ApiError,
  bootstrap,
  compactId,
  copyText,
  displayTime,
  fileSize,
  instancePath,
  privateMediaUrl,
  type InstanceDetails,
  type Recording,
} from './api';
import { InstanceLogsPanel } from './instance-logs';
import { LiveImage } from './live-image';
import { DeviceProfileCard } from './device-profile';
const { Text, Paragraph } = Typography;
const pageStates: Record<string, string> = {
  ready: '已加载',
  loading: '加载中',
  closed: '已关闭',
  crashed: '崩溃',
};
const statuses: Record<string, { text: string; color: string }> = {
  ready: { text: '运行中', color: 'success' },
  active: { text: '运行中', color: 'success' },
  starting: { text: '启动中', color: 'processing' },
  busy: { text: '执行中', color: 'processing' },
  closing: { text: '关闭中', color: 'processing' },
  closed: { text: '已结束', color: 'default' },
  crashed: { text: '崩溃', color: 'error' },
  failed: { text: '失败', color: 'error' },
  interrupted: { text: '意外中断', color: 'warning' },
  unknown: { text: '历史状态未保留', color: 'default' },
};
const time = (value?: string) => (value ? new Date(value).toLocaleString('zh-CN') : '未记录');
const country = (code?: string | null) =>
  code && /^[A-Z]{2}$/.test(code) && code !== 'ZZ'
    ? `${new Intl.DisplayNames(['zh-CN'], { type: 'region' }).of(code)} (${code})`
    : '国家未知';
const reasons: Record<string, string> = {
  requested: '调用方主动关闭',
  service_shutdown: '服务重启或停止',
  idle_timeout: '空闲超时',
  max_lifetime: '达到最大存活时间',
  browser_disconnected: '浏览器连接断开',
  creation_failed: '实例创建失败',
};
export function InstanceDetailsPage({ instanceId }: { instanceId: string }) {
  const [data, setData] = useState<InstanceDetails>();
  const [error, setError] = useState('');
  const [missing, setMissing] = useState(false);
  const [revision, setRevision] = useState(0);
  const { message } = App.useApp();
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await api<InstanceDetails>(`/api/instances/${instanceId}`, controller.signal);
        if (controller.signal.aborted) return;
        setData(value);
        setMissing(false);
        setError('');
      } catch (e) {
        if (controller.signal.aborted) return;
        setMissing(e instanceof ApiError && e.status === 404);
        setError(e instanceof Error ? e.message : '无法读取实例');
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 3000);
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [instanceId, revision]);
  if (missing)
    return (
      <Card className="section-card">
        <Empty description="实例不存在或历史记录已过期" />
        <Button href={`${bootstrap.base}/#history`}>返回历史列表</Button>
      </Card>
    );
  if (!data)
    return error ? (
      <Alert showIcon type="error" title={error} />
    ) : (
      <Spin aria-label="正在加载实例详情" />
    );
  const r = data.instance,
    p = data.current ?? r.properties,
    e = r.environment;
  const status =
    data.current?.status === 'ready' && data.current.busy
      ? 'busy'
      : (data.current?.status ?? r.status);
  const state = statuses[status] ?? { text: status, color: 'default' };
  const ip = data.current?.egress ?? e?.egress;
  const code = data.current?.country ?? e?.country;
  const ua = data.current?.user_agent ?? e?.user_agent;
  const copy = async () => {
    try {
      await copyText(data.details_url ?? `${window.location.origin}${instancePath(instanceId)}`);
      message.success('实例详情链接已复制');
    } catch (err) {
      message.error(err instanceof Error ? err.message : '复制失败');
    }
  };
  return (
    <div className="instance-detail-page">
      {error && <Alert showIcon type="warning" title="更新暂时失败，正在展示上次读取的数据" />}
      <Card
        className="section-card"
        title={
          <Space wrap>
            <Text strong>实例 {compactId(instanceId)}</Text>
            <Tag color={state.color}>{state.text}</Tag>
          </Space>
        }
        extra={
          <Space wrap>
            <Button icon={<CopyOutlined />} onClick={() => void copy()}>
              复制详情链接
            </Button>
            <Button icon={<ReloadOutlined />} onClick={() => setRevision((n) => n + 1)}>
              刷新详情
            </Button>
            <Button href={`${bootstrap.base}/#history`} icon={<ArrowLeftOutlined />}>
              历史列表
            </Button>
          </Space>
        }
      >
        <Paragraph className="instance-detail-id" copyable={{ text: instanceId }}>
          {instanceId}
        </Paragraph>
        <Paragraph className="instance-detail-task">
          {r.task_description ?? '未填写任务描述'}
        </Paragraph>
        <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 3 }}>
          <Descriptions.Item label="创建时间">{time(r.created_at)}</Descriptions.Item>
          <Descriptions.Item label="结束时间">
            {r.ended_at ? time(r.ended_at) : data.current ? '运行中' : '未记录'}
          </Descriptions.Item>
          <Descriptions.Item label="关闭原因">
            {r.close_reason ? (reasons[r.close_reason] ?? r.close_reason) : '—'}
          </Descriptions.Item>
          <Descriptions.Item label="当前调用">
            {data.current?.active_operation?.tool ?? '—'}
          </Descriptions.Item>
          <Descriptions.Item label="退出码">{r.exit_code ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="退出信号">{r.exit_signal ?? '—'}</Descriptions.Item>
        </Descriptions>
      </Card>
      <Row gutter={[20, 20]}>
        <Col xs={24} xl={14}>
          <InstanceMedia data={data} />
        </Col>
        <Col xs={24} xl={10}>
          <Card title="实例属性" className="section-card instance-detail-properties">
            <Descriptions column={1} size="small">
              <Descriptions.Item label="出口 IP">
                <Space wrap>
                  <Text className="detail-egress">{ip?.ip ?? (e ? '未检测' : '未记录')}</Text>
                  <Text>{country(code)}</Text>
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label="出口来源">
                {ip?.source === 'instance_check'
                  ? '实例检测'
                  : ip?.source === 'proxy_check'
                    ? '代理检测样本'
                    : '未检测'}
                {ip?.checked_at && ` · ${time(ip.checked_at)}`}
              </Descriptions.Item>
              <Descriptions.Item label="国家来源">
                {code ? '创建实例时的代理配置' : '未记录'}
              </Descriptions.Item>
              <Descriptions.Item label="OS（UA 识别）">{e?.os ?? '未记录'}</Descriptions.Item>
              <Descriptions.Item label="完整 UA">
                <Paragraph className="detail-user-agent" copyable={ua ? { text: ua } : false}>
                  {ua ?? '未记录'}
                </Paragraph>
              </Descriptions.Item>
              <Descriptions.Item label="视口">
                {p?.viewport ? `${p.viewport.width} × ${p.viewport.height}` : '未记录'}
              </Descriptions.Item>
              <Descriptions.Item label="代理地址">
                {p?.proxy === null ? '直连' : (p?.proxy?.server ?? '未记录')}
              </Descriptions.Item>
              <Descriptions.Item label="代理 ID">{p?.proxy?.proxy_id ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="语言 / 时区">
                {p ? `${p.locale} / ${p.timezone}` : '未记录'}
              </Descriptions.Item>
              <Descriptions.Item label="设备模式">
                {p ? (p.mobile?.enabled ? '移动设备' : '桌面') : '未记录'}
              </Descriptions.Item>
              <Descriptions.Item label="触控 / 缩放">
                {p
                  ? `${p.mobile?.touch ? '支持' : '不支持'} / ${p.mobile?.device_scale_factor ?? 1}×`
                  : '未记录'}
              </Descriptions.Item>
              <Descriptions.Item label="空闲 / 最大存活">
                {p ? `${p.idle_timeout_seconds} / ${p.max_lifetime_seconds} 秒` : '未记录'}
              </Descriptions.Item>
            </Descriptions>
          </Card>
        </Col>
      </Row>
      <DeviceProfileCard
        profile={data.current?.device_profile ?? e?.device_profile}
        report={data.current?.device_verification ?? e?.device_verification}
        browserVersion={data.current?.browser_version ?? e?.browser_version}
        browserMode={data.current?.browser_mode ?? e?.browser_mode}
      />
      <Card title={data.current ? '标签页' : '标签页（最后快照）'} className="section-card">
        <Table
          rowKey="page_id"
          size="small"
          dataSource={data.pages}
          pagination={false}
          scroll={{ x: 680 }}
          locale={{ emptyText: '未保留标签页快照' }}
          columns={[
            {
              title: '页面',
              dataIndex: 'title',
              width: 160,
              render: (value: string) => value || '未命名页面',
            },
            {
              title: 'URL',
              dataIndex: 'url',
              render: (url: string) => (
                <Paragraph className="detail-page-url" copyable={{ text: url }}>
                  {url}
                </Paragraph>
              ),
            },
            {
              title: data.current ? '状态' : '最后状态',
              dataIndex: 'state',
              width: 100,
              render: (value: string) => pageStates[value] ?? value,
            },
            {
              title: '页面 ID',
              dataIndex: 'page_id',
              width: 130,
              render: (id: string) => <Text copyable={{ text: id }}>{id.slice(0, 12)}…</Text>,
            },
          ]}
        />
      </Card>
      <Card title="调用日志" className="section-card">
        {data.logs_available ? (
          <InstanceLogsPanel
            instance={{ instance_id: instanceId, task_description: r.task_description }}
          />
        ) : (
          <Empty description="调用日志已过期或未保留" />
        )}
      </Card>
      <Text type="secondary" className="table-footnote">
        详情与日志每隔数秒自动更新，不操作浏览器或延长实例存活时间。历史内容按平台保留规则清理。
      </Text>
    </div>
  );
}
function InstanceMedia({ data }: { data: InstanceDetails }) {
  const [mode, setMode] = useState('live');
  const [recordingId, setRecordingId] = useState<string>();
  const [liveLoaded, setLiveLoaded] = useState(false);
  const [liveError, setLiveError] = useState(false);
  const [playbackError, setPlaybackError] = useState(false);
  useEffect(() => {
    if (!data.current) setMode('recordings');
  }, [data.instance.instance_id, !!data.current]);
  const playable = (r: Recording) => r.bytes > 0 && !['recording', 'finalizing'].includes(r.status);
  const selected =
    data.recordings.find((r) => r.id === recordingId) ??
    data.recordings.find(playable) ??
    data.recordings[0];
  const active = data.current;
  useEffect(() => setPlaybackError(false), [selected?.id]);
  return (
    <Card title="直播与录屏" className="section-card instance-detail-media">
      <Tabs
        activeKey={mode}
        onChange={setMode}
        items={[
          {
            key: 'live',
            label: (
              <Space>
                直播
                {active && (
                  <Tag color={active.status === 'crashed' ? 'error' : 'success'}>
                    {active.status === 'crashed' ? '连接异常' : 'LIVE'}
                  </Tag>
                )}
              </Space>
            ),
          },
          { key: 'recordings', label: `录屏（${data.recordings.length}）` },
        ]}
      />
      {mode === 'live' ? (
        active ? (
          <>
            <div className="instance-detail-media-stage">
              {(!liveLoaded || liveError) && (
                <div className="detail-media-message">
                  {liveError ? '实时画面暂时不可用，正在重连…' : '正在连接实时画面…'}
                </div>
              )}
              <LiveImage
                key={active.instance_id}
                src={privateMediaUrl(`${bootstrap.base}/api/instances/${active.instance_id}/frame`)}
                alt="实例实时画面"
                className="instance-detail-live-image"
                onLoad={() => {
                  setLiveLoaded(true);
                  setLiveError(false);
                }}
                onError={() => setLiveError(true)}
              />
            </div>
            {active.status === 'crashed' && (
              <Alert type="warning" showIcon title="浏览器连接异常，显示的可能是最后捕获的画面。" />
            )}
          </>
        ) : (
          <Empty description="实例已结束，直播不可用；可切换到录屏查看" />
        )
      ) : (
        <>
          {data.recordings.length > 1 && (
            <Select
              aria-label="选择实例录屏"
              value={selected?.id}
              onChange={setRecordingId}
              options={data.recordings.map((r) => ({
                value: r.id,
                label: `${displayTime(r.created_at)} · ${r.status}`,
              }))}
            />
          )}
          {selected && playable(selected) ? (
            <>
              {playbackError && (
                <Alert type="warning" showIcon title="录屏暂时无法播放，可能尚未写完或已被清理。" />
              )}
              <video
                key={selected.id}
                className="instance-detail-video"
                aria-label="实例录屏播放器"
                src={privateMediaUrl(`${bootstrap.base}/api/recordings/${selected.id}/video`)}
                controls
                autoPlay
                muted
                playsInline
                onError={() => setPlaybackError(true)}
                onLoadedData={() => setPlaybackError(false)}
              />
              <Paragraph type="secondary">
                {displayTime(selected.created_at)} · {Math.round(selected.frames / selected.fps)} 秒
                · {fileSize(selected.bytes)} · {selected.status}
              </Paragraph>
            </>
          ) : (
            <Empty
              description={
                selected && ['recording', 'finalizing'].includes(selected.status)
                  ? '录屏正在生成，实例结束后可播放'
                  : '没有可播放的录屏，可能未开启录屏或已过期'
              }
            />
          )}
        </>
      )}
    </Card>
  );
}
