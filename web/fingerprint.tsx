import { useEffect, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Collapse,
  Descriptions,
  Space,
  Spin,
  Tag,
  Typography,
} from 'antd';
import { CopyOutlined, DownloadOutlined, ReloadOutlined } from '@ant-design/icons';
import { bootstrap, copyText } from './api.js';
import {
  collectFingerprint,
  fingerprintFindings,
  type FingerprintReport,
} from './fingerprint-probes.js';
const { Title, Text, Paragraph } = Typography;
const display = (value: unknown) =>
  value === null || value === undefined
    ? '未提供'
    : typeof value === 'object'
      ? JSON.stringify(value, null, 2)
      : String(value);
function DataCard({ title, value }: { title: string; value: Record<string, unknown> }) {
  return (
    <Card title={title} className="fingerprint-data-card">
      <Descriptions
        column={1}
        size="small"
        items={Object.entries(value).map(([key, value]) => ({
          key,
          label: key,
          children: <span className="fingerprint-value">{display(value)}</span>,
        }))}
      />
    </Card>
  );
}
export function FingerprintPage() {
  const { message } = App.useApp();
  const [report, setReport] = useState<FingerprintReport>();
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError('');
    void collectFingerprint(bootstrap.base)
      .then((r) => {
        if (current) setReport(r);
      })
      .catch(() => {
        if (current) setError('部分检测未能完成，请刷新重试。');
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [refresh]);
  const raw = report ? JSON.stringify(report, null, 2) : '';
  const request = report?.request.status === 'measured' ? (report.request.value as any) : null;
  const hints = report?.navigator.client_hints;
  const findings = report ? fingerprintFindings(report) : [];
  const download = () => {
    const url = URL.createObjectURL(new Blob([raw], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `cloudbrowser-fingerprint-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <main className="fingerprint-page">
      <header className="fingerprint-header">
        <a href={`${bootstrap.base}/`} className="fingerprint-brand">
          cloudbrowser
        </a>
        <Space>
          <Tag color="blue">公开检测 · 无需登录</Tag>
          <a href={`${bootstrap.base}/docs/agent-guide.md`} target="_blank" rel="noreferrer">
            接入文档
          </a>
        </Space>
      </header>
      <section className="fingerprint-intro">
        <div>
          <Title level={1}>设备指纹检测</Title>
          <Paragraph type="secondary">
            查看当前浏览器向网站暴露的信息，比较设备配置与实际返回值。
          </Paragraph>
        </div>
        <Space wrap>
          <Button
            icon={<ReloadOutlined />}
            loading={loading}
            onClick={() => setRefresh((n) => n + 1)}
          >
            重新检测
          </Button>
          <Button
            icon={<CopyOutlined />}
            disabled={!report || loading}
            onClick={async () => {
              try {
                await copyText(raw);
                message.success('检测结果已复制');
              } catch {
                message.error('复制失败，请下载 JSON');
              }
            }}
          >
            复制 JSON
          </Button>
          <Button
            type="primary"
            icon={<DownloadOutlined />}
            disabled={!report || loading}
            onClick={download}
          >
            下载 JSON
          </Button>
        </Space>
      </section>
      <Paragraph className="fingerprint-privacy">
        完整报告在当前页面计算，不提交服务端保存；本站请求会正常携带 UA 和 Client
        Hints。不申请设备权限，不播放声音，不连接第三方检测服务。
      </Paragraph>
      {error && <Alert type="error" showIcon title={error} />}
      {loading && !report && (
        <div className="fingerprint-loading">
          <Spin />
          <p>正在读取浏览器信息与渲染指纹…</p>
        </div>
      )}
      {report && (
        <>
          <div className="fingerprint-summary">
            <Card>
              <Text type="secondary">HTTP 来源 IP</Text>
              <strong>{request?.ip || '未获取'}</strong>
              <Text type="secondary">
                {request?.ip_source === 'cloudflare_tunnel_header'
                  ? 'Cloudflare 隧道转发'
                  : 'HTTP 连接对端'}
              </Text>
            </Card>
            <Card>
              <Text type="secondary">浏览器声明的平台</Text>
              <strong>{hints?.low?.platform || report.navigator.platform || '未提供'}</strong>
              <Text type="secondary">{hints?.high?.model || report.navigator.platform}</Text>
            </Card>
            <Card>
              <Text type="secondary">浏览器声明的版本</Text>
              <strong>
                {hints?.high?.fullVersionList?.find((b: any) => b.brand === 'Chromium')?.version ||
                  report.navigator.user_agent.match(/(?:Chrome|Firefox|Version)\/([\d.]+)/)?.[1] ||
                  '未提供'}
              </strong>
              <Text type="secondary">网页可见值，不代表已核验真实内核</Text>
            </Card>
            <Card>
              <Text type="secondary">视口 / 缩放</Text>
              <strong>
                {report.window.inner_width} × {report.window.inner_height}
              </strong>
              <Text type="secondary">
                DPR {report.window.device_pixel_ratio} · 触点{' '}
                {report.navigator.max_touch_points ?? '未知'}
              </Text>
            </Card>
          </div>
          <Alert
            className="fingerprint-findings"
            type={findings.length ? 'warning' : 'info'}
            showIcon
            title="字段一致性观察"
            description={
              <>
                <ul>
                  {(findings.length
                    ? findings
                    : ['本次可读取的字段中未发现直接差异；未提供或无法读取的字段不能视为一致。']
                  ).map((text) => (
                    <li key={text}>{text}</li>
                  ))}
                </ul>
                <span>这里不提供“真人／机器人”评分，也不能证明物理设备身份。</span>
              </>
            }
          />
          <div className="fingerprint-grid">
            <DataCard
              title="浏览器与 Navigator"
              value={Object.fromEntries(
                Object.entries(report.navigator).filter(([key]) => key !== 'client_hints'),
              )}
            />
            <DataCard title="User-Agent Client Hints" value={hints} />
            <DataCard title="服务端看到的请求" value={request ?? report.request} />
            <DataCard
              title="屏幕与视口"
              value={{ screen: report.screen, window: report.window, media_queries: report.media }}
            />
            <DataCard title="语言与时区" value={report.intl} />
            <DataCard title="Worker 中的声明" value={report.worker} />
            <DataCard title="Canvas 指纹" value={report.canvas} />
            <DataCard title="音频指纹（离线计算）" value={report.audio} />
            <DataCard title="WebGL / GPU" value={report.webgl} />
            <DataCard title="WebGL 2" value={report.webgl2} />
            <DataCard title="蓝牙" value={report.hardware.bluetooth} />
            <DataCard title="摄像头、麦克风与扬声器" value={report.hardware.media_devices} />
            <DataCard title="USB（已授权设备）" value={report.hardware.usb} />
            <DataCard title="HID（已授权设备）" value={report.hardware.hid} />
            <DataCard title="串口（已授权端口）" value={report.hardware.serial} />
            <DataCard title="游戏手柄" value={report.hardware.gamepads} />
            <DataCard title="音频输出参数" value={report.hardware.audio_output} />
            <DataCard title="WebGPU 适配器" value={report.hardware.webgpu} />
            <DataCard title="传感器与硬件接口" value={report.hardware.sensors} />
            <DataCard title="当前网站权限状态" value={report.hardware.permissions} />
            <DataCard
              title="浏览器能力与 WebRTC"
              value={{ ...report.capabilities, webrtc_test: report.webrtc }}
            />
            <DataCard
              title="网络与电池声明"
              value={{ connection: report.connection, battery: report.battery }}
            />
            <DataCard
              title="插件与 MIME 类型"
              value={{ plugins: report.plugins, mime_types: report.mime_types }}
            />
            <DataCard
              title="系统语音"
              value={{
                count: report.voices.length,
                voices: report.voices,
                note: '仅查询当前已加载的语音列表，不播放；空列表可能表示尚未加载或不支持。',
              }}
            />
          </div>
          <Collapse
            className="fingerprint-raw"
            items={[{ key: 'json', label: '完整 JSON 检测结果', children: <pre>{raw}</pre> }]}
          />
          <script id="fingerprint-report" type="application/json">
            {raw.replace(/</g, '\\u003c')}
          </script>
          <footer className="fingerprint-footer">
            <Text type="secondary">检测时间：{new Date(report.collected_at).toLocaleString()}</Text>
            {report.notes.map((note) => (
              <p key={note}>{note}</p>
            ))}
          </footer>
        </>
      )}
    </main>
  );
}
