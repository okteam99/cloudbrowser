import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Alert,
  App,
  Avatar,
  Badge,
  Button,
  Card,
  Col,
  ConfigProvider,
  Descriptions,
  Drawer,
  Empty,
  Flex,
  Form,
  Grid,
  Input,
  Layout,
  Menu,
  Modal,
  Popover,
  Progress,
  Row,
  Select,
  Skeleton,
  Space,
  Statistic,
  Steps,
  Table,
  Tag,
  Tabs,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import type { TableColumnsType } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import {
  ApiOutlined,
  ArrowRightOutlined,
  CheckCircleFilled,
  CodeOutlined,
  CopyOutlined,
  DesktopOutlined,
  DisconnectOutlined,
  ExportOutlined,
  FileTextOutlined,
  FullscreenOutlined,
  HistoryOutlined,
  InfoCircleOutlined,
  KeyOutlined,
  LinkOutlined,
  LockOutlined,
  LogoutOutlined,
  MenuOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  ThunderboltOutlined,
  VideoCameraOutlined,
} from '@ant-design/icons';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  api,
  bootstrap,
  compactId,
  copyText,
  displayTime,
  fileSize,
  type BrowserInstance,
  type Connection,
  type Recording,
  instancePath,
} from './api';
import 'antd/dist/reset.css';
import './styles.css';
import { ProxiesPage } from './proxies';
import { InstanceLogDrawer } from './instance-logs';
import { SettingsPage } from './settings';
import { InstanceDetailsPage } from './instance-details';
import { LiveImage } from './live-image';

const { Title, Text, Paragraph } = Typography;
type Section = 'overview' | 'instances' | 'history' | 'proxies' | 'connect' | 'docs' | 'settings';
const navItems = [
  { key: 'overview', icon: <DesktopOutlined />, label: '工作台' },
  { key: 'instances', icon: <VideoCameraOutlined />, label: '实时实例' },
  { key: 'history', icon: <HistoryOutlined />, label: '历史录屏' },
  { key: 'proxies', icon: <SafetyCertificateOutlined />, label: '代理管理' },
  { key: 'connect', icon: <ApiOutlined />, label: 'MCP 接入' },
  { key: 'settings', icon: <SettingOutlined />, label: '系统设置' },
  { key: 'docs', icon: <FileTextOutlined />, label: '使用文档' },
];
const sectionTitles: Record<Section, { title: string; description: string }> = {
  overview: { title: '工作台', description: '连接你的 Agent，在这里观察浏览器的每一步。' },
  instances: { title: '实时实例', description: '选择一个实例，实时查看当前活动标签页。' },
  history: { title: '历史录屏', description: '回看已结束的浏览器会话，定位问题、还原过程。' },
  proxies: { title: '代理管理', description: '配置国家和代理线路，由 Agent 按代理 ID 选择使用。' },
  connect: { title: 'MCP 接入', description: '复制接入说明，把远程浏览器交给 Agent。' },
  docs: { title: '使用文档', description: '从首次连接到日常使用，你需要的信息都在这里。' },
  settings: { title: '系统设置', description: '查看存储用量，调整配额和截图保留期限。' },
};
function Brand({ light = false }: { light?: boolean }) {
  return (
    <div className={`brand ${light ? 'brand-light' : ''}`}>
      <span className="brand-icon">
        <DesktopOutlined />
      </span>
      <div>
        <strong>cloudbrowser</strong>
        <span>MCP CONSOLE</span>
      </div>
    </div>
  );
}
function Login() {
  const [submitting, setSubmitting] = useState(false);
  return (
    <main className="login-layout">
      <section className="login-story">
        <Brand light />
        <div className="login-intro">
          <Tag icon={<ThunderboltOutlined />} bordered={false}>
            AI 浏览器 · 直播与录屏
          </Tag>
          <h1>
            AI 操作浏览器，
            <br />
            全过程看得见。
          </h1>
          <p>实时直播 AI 的操作过程，全程录屏，随时回放。</p>
          <div className="login-capabilities">
            <div>
              <ApiOutlined />
              <strong>AI 操作</strong>
              <span>通过 MCP 接入你的 AI Agent</span>
            </div>
            <div>
              <VideoCameraOutlined />
              <strong>实时直播</strong>
              <span>实时查看 AI 的每一步操作</span>
            </div>
            <div>
              <HistoryOutlined />
              <strong>全程录屏</strong>
              <span>自动录制会话，随时回看过程</span>
            </div>
          </div>
        </div>
        <Text className="login-story-footer">AI 操作 · 实时直播 · 全程录屏</Text>
      </section>
      <section className="login-form-side">
        <div className="login-card">
          <div className="login-lock">
            <LockOutlined />
          </div>
          <Title level={2}>欢迎回来</Title>
          <Paragraph type="secondary">输入部署时设置的访问密码，进入浏览器控制台。</Paragraph>
          {bootstrap.error && (
            <Alert type="error" showIcon title={bootstrap.error} className="login-alert" />
          )}
          <form
            method="post"
            action={`${bootstrap.base}/login`}
            onSubmit={() => setSubmitting(true)}
          >
            {bootstrap.return_to && (
              <input type="hidden" name="return_to" value={bootstrap.return_to} />
            )}
            <Form component={false} layout="vertical">
              <Form.Item label={<label htmlFor="access-password">访问密码</label>}>
                <Input.Password
                  id="access-password"
                  name="password"
                  placeholder="请输入访问密码"
                  aria-label="访问密码"
                  autoComplete="current-password"
                  size="large"
                  required
                  prefix={<KeyOutlined />}
                />
              </Form.Item>
              <Button size="large" type="primary" htmlType="submit" block loading={submitting}>
                登录
              </Button>
            </Form>
          </form>
          <div className="login-note">
            <SafetyCertificateOutlined />
            <span>密码用于网页访问，Agent 使用独立的访问 Token。</span>
          </div>
        </div>
        <Text type="secondary" className="login-footer">
          cloudbrowser · 你的远程浏览器工作台
        </Text>
      </section>
    </main>
  );
}
function useService() {
  const [connection, setConnection] = useState<Connection>();
  const [instances, setInstances] = useState<BrowserInstance[]>([]);
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [capacity, setCapacity] = useState<number>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [lastUpdated, setLastUpdated] = useState<Date>();
  const pending = useRef(false);
  const cachedConnection = useRef<Connection | undefined>(undefined);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (pending.current) return;
    pending.current = true;
    try {
      const [live, history, conn] = await Promise.all([
        api<{ instances: BrowserInstance[]; max_instances: number }>('/api/instances', signal),
        api<Recording[]>('/api/recordings', signal),
        cachedConnection.current
          ? Promise.resolve(cachedConnection.current)
          : api<Connection>('/api/connection', signal),
      ]);
      if (!cachedConnection.current) {
        cachedConnection.current = conn;
        setConnection(conn);
      }
      setInstances(live.instances);
      setCapacity(live.max_instances);
      setRecordings(history);
      setError(undefined);
      setLastUpdated(new Date());
    } catch (e) {
      if (!signal?.aborted) setError(e instanceof Error ? e.message : '连接暂时不可用');
    } finally {
      pending.current = false;
      if (!signal?.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = setInterval(() => void refresh(controller.signal), 3000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [refresh]);
  return { connection, instances, recordings, capacity, loading, error, lastUpdated, refresh };
}
function StatusTag({ status }: { status: string }) {
  const states: Record<string, { color: string; text: string }> = {
    ready: { color: 'success', text: '运行中' },
    crashed: { color: 'error', text: '异常' },
    recording: { color: 'processing', text: '录制中' },
    completed: { color: 'success', text: '已完成' },
    interrupted: { color: 'warning', text: '意外中断' },
    failed: { color: 'error', text: '失败' },
    limit_reached: { color: 'warning', text: '达到上限' },
    live_only: { color: 'default', text: '仅直播' },
    finalizing: { color: 'processing', text: '生成中' },
  };
  const v = states[status] ?? { color: 'default', text: status };
  return (
    <Tag color={v.color} bordered={false}>
      {v.text}
    </Tag>
  );
}
function Dashboard() {
  const initial = window.location.hash.slice(1) as Section;
  const [section, setSection] = useState<Section>(initial in sectionTitles ? initial : 'overview');
  const [mobileMenu, setMobileMenu] = useState(false);
  const screens = Grid.useBreakpoint();
  const detailId = bootstrap.instance_id;
  const pageTitle = detailId ? '实例详情' : sectionTitles[section].title;
  const service = useService();
  const [watching, setWatching] = useState<string>();
  const [playing, setPlaying] = useState<Recording>();
  const [logging, setLogging] = useState<{ instance_id: string; task_description?: string }>();
  const [guideOpen, setGuideOpen] = useState(false);
  const { message } = App.useApp();
  const choose = useCallback((key: string) => {
    if (!(key in sectionTitles)) return;
    if (bootstrap.instance_id) {
      window.location.assign(`${bootstrap.base}/#${key}`);
      return;
    }
    setSection(key as Section);
    window.history.replaceState(null, '', `#${key}`);
    setMobileMenu(false);
    window.scrollTo({ top: 0 });
  }, []);
  useEffect(() => {
    const changed = () => {
      const key = window.location.hash.slice(1);
      if (key in sectionTitles) setSection(key as Section);
    };
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  useEffect(() => {
    if (watching && !service.instances.some((i) => i.instance_id === watching))
      setWatching(undefined);
  }, [service.instances, watching]);
  const copy = async (text: string) => {
    try {
      await copyText(text);
      void message.success('已复制，可以粘贴给 Agent');
    } catch (e) {
      void message.error(e instanceof Error ? e.message : '复制失败');
    }
  };
  const copyGuide = () => service.connection && copy(service.connection.agent_instructions);
  const watch = (id: string) => {
    setWatching(id);
    choose('instances');
  };
  const menu = (
    <Menu
      theme="dark"
      mode="inline"
      selectedKeys={[detailId ? 'instances' : section]}
      items={navItems}
      onClick={({ key }) => choose(key)}
    />
  );
  return (
    <>
      <Layout className="app-layout">
        {screens.lg && (
          <Layout.Sider width={232} theme="dark" className="app-sidebar">
            <Brand light />
            <div className="nav-label">控制台</div>
            {menu}
            <div className="sidebar-footer">
              <div className="sidebar-environment">
                <span className="status-dot" />
                远程浏览器服务
              </div>
              <Text>cloudbrowser · v0.12.0</Text>
            </div>
          </Layout.Sider>
        )}
        <Drawer
          open={mobileMenu}
          onClose={() => setMobileMenu(false)}
          placement="left"
          width={260}
          title={<Brand />}
          styles={{ body: { padding: 0, background: '#0b1427' } }}
        >
          {menu}
        </Drawer>
        <Layout className={`main-layout ${screens.lg ? 'with-sidebar' : ''}`}>
          <Layout.Header className="topbar">
            <Space size={14}>
              {!screens.lg && (
                <Button
                  type="text"
                  aria-label="打开导航"
                  icon={<MenuOutlined />}
                  onClick={() => setMobileMenu(true)}
                />
              )}
              <Text className="topbar-product">浏览器控制台</Text>
              <span className="topbar-divider" />
              <Text type="secondary">{pageTitle}</Text>
            </Space>
            <Space size={20}>
              <Badge
                status={service.error ? 'warning' : service.lastUpdated ? 'success' : 'processing'}
                text={service.error ? '连接异常' : service.lastUpdated ? '服务已连接' : '正在连接'}
              />
              {bootstrap.access_token ? (
                <Button href={`${bootstrap.base}/`} icon={<LockOutlined />}>
                  登录控制台
                </Button>
              ) : (
                <form method="post" action={`${bootstrap.base}/logout`}>
                  <input type="hidden" name="csrf" value={bootstrap.csrf} />
                  <Button type="text" htmlType="submit" icon={<LogoutOutlined />}>
                    退出
                  </Button>
                </form>
              )}
            </Space>
          </Layout.Header>
          <Layout.Content className="page-content">
            <div className="page-heading">
              <div>
                <Title level={2}>{pageTitle}</Title>
                <Paragraph type="secondary">
                  {detailId
                    ? '在同一地址查看实例直播、录屏、状态、属性与日志。'
                    : sectionTitles[section].description}
                </Paragraph>
              </div>
              <Space>
                <Text type="secondary" className="updated-time">
                  {service.lastUpdated
                    ? `更新于 ${service.lastUpdated.toLocaleTimeString('zh-CN', { hour12: false })}`
                    : ''}
                </Text>
                <Button
                  icon={<ReloadOutlined />}
                  loading={service.loading}
                  onClick={() => void service.refresh()}
                >
                  刷新
                </Button>
              </Space>
            </div>
            {service.error && (
              <Alert
                type="warning"
                showIcon
                title={service.error}
                description="已展示的数据仍会保留，连接恢复后会自动更新。"
                className="service-alert"
              />
            )}
            {detailId ? (
              <InstanceDetailsPage instanceId={detailId} />
            ) : (
              <>
                {section === 'overview' && (
                  <>
                    <Row gutter={[20, 20]} className="stats-row">
                      <Col xs={24} md={8}>
                        <Metric
                          label="活跃浏览器"
                          value={service.instances.length}
                          suffix={service.capacity !== undefined ? ` / ${service.capacity}` : ''}
                          icon={<DesktopOutlined />}
                          color="blue"
                          note="每个实例使用独立浏览器会话"
                          loading={service.loading}
                        />
                      </Col>
                      <Col xs={24} md={8}>
                        <Metric
                          label="历史录屏"
                          value={service.recordings.filter((r) => r.status !== 'recording').length}
                          icon={<HistoryOutlined />}
                          color="purple"
                          note="随时回看已结束的执行过程"
                          loading={service.loading}
                        />
                      </Col>
                      <Col xs={24} md={8}>
                        <Metric
                          label="可用 MCP 工具"
                          value={service.connection?.tool_count}
                          icon={<ApiOutlined />}
                          color="green"
                          note="覆盖页面操作、下载和诊断"
                          loading={!service.connection}
                        />
                      </Col>
                    </Row>
                    <Card className="welcome-card" bordered={false}>
                      <div className="welcome-copy">
                        <Tag icon={<CheckCircleFilled />} color="blue" bordered={false}>
                          你的远程浏览器已就绪
                        </Tag>
                        <Title level={3}>从连接 Agent 开始</Title>
                        <Paragraph>
                          复制接入信息，Agent 按公开文档即可操作浏览器。
                          <br />
                          你可以在这里实时观看，也可以稍后回看录像。
                        </Paragraph>
                        <Space wrap>
                          <Button
                            type="primary"
                            icon={<CopyOutlined />}
                            size="large"
                            disabled={!service.connection}
                            onClick={copyGuide}
                            aria-label="复制 Agent 接入信息"
                          >
                            复制 Agent 接入信息
                          </Button>
                          <Button
                            size="large"
                            icon={<ArrowRightOutlined />}
                            onClick={() => choose('connect')}
                          >
                            查看接入配置
                          </Button>
                        </Space>
                      </div>
                      <div className="welcome-visual" aria-hidden="true">
                        <div className="mini-window">
                          <div className="mini-window-bar">
                            <i />
                            <i />
                            <i />
                          </div>
                          <div className="mini-window-content">
                            <div className="mini-agent">
                              <ThunderboltOutlined />
                            </div>
                            <div className="mini-connector" />
                            <div className="mini-browser">
                              <DesktopOutlined />
                            </div>
                          </div>
                          <span>Agent 指令 · 浏览器执行</span>
                        </div>
                      </div>
                    </Card>
                    <Row gutter={[20, 20]}>
                      <Col xs={24} xl={16}>
                        <Card
                          title={
                            <Space>
                              <VideoCameraOutlined />
                              运行中的实例
                            </Space>
                          }
                          extra={
                            <Button type="link" onClick={() => choose('instances')}>
                              查看全部 <ArrowRightOutlined />
                            </Button>
                          }
                          className="section-card"
                        >
                          <InstanceTable
                            instances={service.instances}
                            loading={service.loading}
                            watching={watching}
                            onWatch={watch}
                            onLogs={setLogging}
                            compact
                          />
                        </Card>
                      </Col>
                      <Col xs={24} xl={8}>
                        <Card title="快速开始" className="section-card quickstart-card">
                          <Steps
                            direction="vertical"
                            size="small"
                            current={service.instances.length ? 2 : 0}
                            items={[
                              {
                                title: '复制接入说明',
                                description: '包含服务地址、鉴权和操作文档',
                              },
                              {
                                title: '交给你的 Agent',
                                description: '描述目标，由 Agent 创建并操作浏览器',
                              },
                              {
                                title: '观看或回看',
                                description: '在实时实例和历史录屏中查看过程',
                              },
                            ]}
                          />
                          <Button block icon={<FileTextOutlined />} onClick={() => choose('docs')}>
                            查看使用文档
                          </Button>
                        </Card>
                      </Col>
                    </Row>
                    <Card
                      title={
                        <Space>
                          <HistoryOutlined />
                          最近录屏
                        </Space>
                      }
                      extra={
                        <Button type="link" onClick={() => choose('history')}>
                          全部录屏 <ArrowRightOutlined />
                        </Button>
                      }
                      className="section-card spaced-card"
                    >
                      <RecordingTable
                        recordings={service.recordings.slice(0, 5)}
                        loading={service.loading}
                        onPlay={setPlaying}
                        onLogs={setLogging}
                        compact
                      />
                    </Card>
                  </>
                )}
                {section === 'instances' && (
                  <>
                    <Card className="instance-summary" bordered={false}>
                      <Flex justify="space-between" align="center" gap={24} wrap>
                        <Space size={14}>
                          <Avatar shape="square" size={48} className="soft-icon blue">
                            <DesktopOutlined />
                          </Avatar>
                          <div>
                            <Text type="secondary">当前实例容量</Text>
                            <div className="capacity-number">
                              {service.instances.length}
                              <small> / {service.capacity ?? '—'}</small>
                            </div>
                          </div>
                        </Space>
                        <div className="capacity-progress">
                          <Progress
                            percent={
                              service.capacity
                                ? Math.round((service.instances.length / service.capacity) * 100)
                                : 0
                            }
                            showInfo={false}
                          />
                          <Text type="secondary">由 Agent 创建实例，结束后自动释放资源</Text>
                        </div>
                        <Tag color="blue" icon={<VideoCameraOutlined />}>
                          低帧率实时预览
                        </Tag>
                      </Flex>
                    </Card>
                    <Row gutter={[20, 20]}>
                      <Col xs={24} xl={11}>
                        <Card
                          title="浏览器实例"
                          extra={<Tag>{service.instances.length} 个</Tag>}
                          className="section-card"
                        >
                          <InstanceTable
                            instances={service.instances}
                            loading={service.loading}
                            watching={watching}
                            onWatch={setWatching}
                            onLogs={setLogging}
                          />
                        </Card>
                      </Col>
                      <Col xs={24} xl={13}>
                        <LiveViewer
                          instance={service.instances.find((i) => i.instance_id === watching)}
                          onCopy={copy}
                        />
                      </Col>
                    </Row>
                  </>
                )}
                {section === 'history' && (
                  <HistoryPage
                    recordings={service.recordings}
                    loading={service.loading}
                    onPlay={setPlaying}
                    onLogs={setLogging}
                  />
                )}
                {section === 'proxies' && <ProxiesPage />}
                {section === 'settings' && <SettingsPage />}
                {section === 'connect' && (
                  <ConnectionPage
                    connection={service.connection}
                    onCopy={copy}
                    onGuide={() => setGuideOpen(true)}
                  />
                )}
                {section === 'docs' && <DocsPage onConnect={() => choose('connect')} />}
              </>
            )}
            <footer className="page-footer">
              <Text type="secondary">cloudbrowser</Text>
              <Space split={<span>·</span>}>
                <a href={`${bootstrap.base}/docs/README.md`} target="_blank" rel="noreferrer">
                  完整文档 <ExportOutlined />
                </a>
                <a href={`${bootstrap.base}/docs/mcp-api.md`} target="_blank" rel="noreferrer">
                  接口参考 <ExportOutlined />
                </a>
              </Space>
            </footer>
          </Layout.Content>
        </Layout>
      </Layout>
      <InstanceLogDrawer instance={logging} onClose={() => setLogging(undefined)} />
      <Modal
        title="Agent 接入信息"
        open={guideOpen}
        onCancel={() => setGuideOpen(false)}
        width={820}
        footer={
          <Space>
            <Button onClick={() => setGuideOpen(false)}>关闭</Button>
            <Button type="primary" icon={<CopyOutlined />} onClick={copyGuide}>
              复制接入信息
            </Button>
          </Space>
        }
      >
        <Paragraph type="secondary">内容包含访问 Token，请仅分享给可信的 Agent。</Paragraph>
        <Input.TextArea
          readOnly
          autoSize={{ minRows: 6, maxRows: 12 }}
          value={service.connection?.agent_instructions}
          aria-label="Agent 接入说明"
          className="mono-input"
        />
      </Modal>
      <Drawer
        title={
          <Space>
            <PlayCircleOutlined />
            录像回放
          </Space>
        }
        open={!!playing}
        onClose={() => setPlaying(undefined)}
        size="large"
        styles={{ body: { padding: 24 } }}
        destroyOnHidden
      >
        {playing && (
          <>
            <div className="replay-stage">
              <video
                key={playing.id}
                controls
                autoPlay
                playsInline
                src={`${bootstrap.base}/api/recordings/${playing.id}/video`}
                aria-label="历史录像播放器"
              />
            </div>
            <Descriptions
              title="录像信息"
              column={1}
              bordered
              size="small"
              className="replay-details"
              items={[
                {
                  key: 'instance',
                  label: '浏览器实例',
                  children: (
                    <Text code copyable>
                      {playing.instance_id}
                    </Text>
                  ),
                },
                {
                  key: 'task',
                  label: '任务目标',
                  children: (
                    <span className="instance-task-full">
                      {playing.task_description ?? '未填写任务描述'}
                    </span>
                  ),
                },
                { key: 'created', label: '开始时间', children: displayTime(playing.created_at) },
                { key: 'status', label: '状态', children: <StatusTag status={playing.status} /> },
                {
                  key: 'duration',
                  label: '采样 / 大小',
                  children: `${playing.fps} FPS · ${playing.width} × ${playing.height} · ${fileSize(playing.bytes)}`,
                },
              ]}
            />
            {playing.status !== 'completed' && (
              <Alert
                type="warning"
                showIcon
                title="该录像未正常结束，可能不完整。"
                className="spaced-card"
              />
            )}
          </>
        )}
      </Drawer>
    </>
  );
}
function Metric({
  label,
  value,
  suffix,
  icon,
  color,
  note,
  loading,
}: {
  label: string;
  value?: number;
  suffix?: string;
  icon: React.ReactNode;
  color: string;
  note: string;
  loading: boolean;
}) {
  return (
    <Card className="metric-card">
      <div className="metric-top">
        <Text type="secondary">{label}</Text>
        <span className={`metric-icon ${color}`}>{icon}</span>
      </div>
      {loading ? (
        <Skeleton.Input active size="small" />
      ) : (
        <Statistic value={value ?? 0} suffix={<span className="stat-suffix">{suffix}</span>} />
      )}
      <Text type="secondary" className="metric-note">
        {note}
      </Text>
    </Card>
  );
}
function instanceUa(i: BrowserInstance) {
  return i.user_agent === 'browser default' ? '浏览器默认（未指定 UA）' : i.user_agent;
}
function proxyAddress(i: BrowserInstance) {
  if (!i.proxy) return '直连';
  try {
    return new URL(i.proxy.server).host;
  } catch {
    return i.proxy.server;
  }
}
function egressSource(i: BrowserInstance) {
  return i.egress?.source === 'instance_check'
    ? '实例检测'
    : i.egress?.source === 'proxy_check'
      ? '代理检测'
      : '未检测';
}
function networkHint(i: BrowserInstance) {
  return [
    i.proxy ? `代理地址：${i.proxy.server}` : '未使用代理，直接连接',
    `出口 IP：${i.egress?.ip ?? '未检测'} ${countryLabel(i.country)}`,
    `来源：${egressSource(i)}`,
    i.egress?.checked_at
      ? `检测时间：${new Date(i.egress.checked_at).toLocaleString('zh-CN')}`
      : '',
  ]
    .filter(Boolean)
    .join('；');
}
function InstanceEnvironment({ instance: i }: { instance: BrowserInstance }) {
  return (
    <div className="instance-environment">
      <Tooltip title={networkHint(i)}>
        <div className="instance-environment-line instance-network-line">
          <span className="instance-env-label">
            {i.egress?.ip ? '出口' : i.proxy ? '代理' : '网络'}
          </span>
          <span className="instance-env-value">{i.egress?.ip ?? proxyAddress(i)}</span>
          <Tooltip title="创建实例时的代理配置国家">
            <span className="instance-egress-country">{countryLabel(i.country)}</span>
          </Tooltip>
        </div>
      </Tooltip>
      <Tooltip title={instanceUa(i)}>
        <div className="instance-environment-line">
          <span className="instance-env-label">UA</span>
          <span className="instance-env-value">{instanceUa(i)}</span>
        </div>
      </Tooltip>
    </div>
  );
}
function LiveInstanceDetails({
  instance: i,
  onCopy,
}: {
  instance: BrowserInstance;
  onCopy: (value: string) => void;
}) {
  const ua = instanceUa(i),
    ip = i.egress?.ip;
  return (
    <div className="live-instance-details">
      <div className="live-instance-detail">
        <Text type="secondary">代理地址</Text>
        <div className="live-instance-detail-value">
          <Text className="instance-proxy-address">{i.proxy?.server ?? '直连（未使用代理）'}</Text>
          {i.proxy && (
            <Button
              type="text"
              size="small"
              icon={<CopyOutlined />}
              aria-label="复制代理地址"
              onClick={() => onCopy(i.proxy!.server)}
            />
          )}
        </div>
      </div>
      <div className="live-instance-detail">
        <Text type="secondary">出口 IP</Text>
        <Space size={8} wrap>
          <Text className="instance-egress">{ip ?? '未检测'}</Text>
          <Tooltip title="创建实例时的代理配置国家">
            <Text className="instance-egress-country">{countryLabel(i.country)}</Text>
          </Tooltip>
          {ip && (
            <>
              <Button
                type="text"
                size="small"
                icon={<CopyOutlined />}
                aria-label="复制出口 IP"
                onClick={() => onCopy(ip)}
              />
              <Tooltip title={networkHint(i)}>
                <Tag bordered={false}>{egressSource(i)}</Tag>
              </Tooltip>
            </>
          )}
        </Space>
      </div>
      <div className="live-instance-detail live-instance-ua">
        <Text type="secondary">UA</Text>
        <div className="live-instance-detail-value">
          <Paragraph className="instance-user-agent">{ua}</Paragraph>
          <Tooltip title="复制完整 UA">
            <Button
              type="text"
              size="small"
              icon={<CopyOutlined />}
              aria-label="复制 UA"
              onClick={() => onCopy(ua)}
            />
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
function TaskDescription({ value }: { value?: string }) {
  return (
    <Tooltip title={value ?? '未填写任务描述'}>
      <div className="instance-task-summary">{value ?? '未填写任务描述'}</div>
    </Tooltip>
  );
}
function InstanceTable({
  instances,
  loading,
  watching,
  onWatch,
  onLogs,
  compact = false,
}: {
  instances: BrowserInstance[];
  loading: boolean;
  watching?: string;
  onWatch: (id: string) => void;
  onLogs: (instance: BrowserInstance) => void;
  compact?: boolean;
}) {
  const columns: TableColumnsType<BrowserInstance> = [
    {
      title: '浏览器实例',
      dataIndex: 'instance_id',
      render: (_, i) => (
        <div className="instance-table-identity">
          <Avatar shape="square" className="soft-icon blue" icon={<DesktopOutlined />} />
          <div className="instance-table-text">
            <Text strong>
              <a href={instancePath(i.instance_id)}>实例 {compactId(i.instance_id)}</a>
            </Text>
            <TaskDescription value={i.task_description} />
            <div className="cell-secondary">
              <Text type="secondary">
                {i.viewport.width} × {i.viewport.height}
              </Text>
              {!compact && <Text type="secondary"> · {i.pages.length} 个标签页</Text>}
            </div>
            <InstanceEnvironment instance={i} />
          </div>
        </div>
      ),
    },
    { title: '状态', dataIndex: 'status', width: 88, render: (s) => <StatusTag status={s} /> },
    {
      title: '操作',
      key: 'action',
      width: 126,
      align: 'right',
      render: (_, i) => (
        <Space size={0}>
          <Button
            type={watching === i.instance_id ? 'default' : 'link'}
            size="small"
            icon={<PlayCircleOutlined />}
            aria-label={`观看实例 ${i.instance_id}`}
            onClick={() => onWatch(i.instance_id)}
          >
            {watching === i.instance_id ? '观看中' : '观看'}
          </Button>
          <Tooltip title="查看调用日志">
            <Button
              type="text"
              size="small"
              icon={<FileTextOutlined />}
              aria-label={`查看实例日志 ${i.instance_id}`}
              onClick={() => onLogs(i)}
            />
          </Tooltip>
        </Space>
      ),
    },
  ];
  return (
    <Table
      className="instance-table"
      tableLayout="fixed"
      rowKey="instance_id"
      columns={columns}
      dataSource={instances}
      loading={loading}
      pagination={false}
      size="middle"
      locale={{
        emptyText: (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <span>
                暂无运行中的实例
                <br />
                <Text type="secondary">让 Agent 创建一个浏览器后，就会显示在这里</Text>
              </span>
            }
          />
        ),
      }}
    />
  );
}
function LiveViewer({
  instance,
  onCopy,
}: {
  instance?: BrowserInstance;
  onCopy: (value: string) => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setLoaded(false);
    setError(false);
  }, [instance?.instance_id]);
  return (
    <Card
      className="section-card live-card"
      title={
        <Space>
          <VideoCameraOutlined />
          实时预览
          {instance && (
            <Tag color="success" bordered={false}>
              <span className="live-dot" /> LIVE
            </Tag>
          )}
        </Space>
      }
      extra={
        <Tooltip title="全屏观看">
          <Button
            type="text"
            aria-label="全屏观看"
            icon={<FullscreenOutlined />}
            disabled={!instance}
            onClick={() => void stage.current?.requestFullscreen()}
          />
        </Tooltip>
      }
    >
      <div className="live-stage" ref={stage}>
        {instance ? (
          <>
            {!loaded && !error && (
              <div className="live-loading">
                <VideoCameraOutlined />
                <span>正在连接实时画面…</span>
              </div>
            )}
            {error && (
              <div className="live-loading">
                <DisconnectOutlined />
                <span>预览暂时不可用，请重新选择实例</span>
              </div>
            )}
            <LiveImage
              key={instance.instance_id}
              className={loaded ? 'live-image' : 'live-image pending'}
              src={`${bootstrap.base}/api/instances/${instance.instance_id}/frame`}
              alt="浏览器实例直播"
              onLoad={() => {
                setLoaded(true);
                setError(false);
              }}
              onError={() => setError(true)}
            />
          </>
        ) : (
          <Empty
            image={<DesktopOutlined className="preview-empty-icon" />}
            description={
              <>
                <strong>选择一个实例开始观看</strong>
                <p>Agent 的每一步操作都会显示在这里</p>
              </>
            }
          />
        )}
      </div>
      <div className="live-caption">
        {instance ? (
          <>
            <Text strong>实例 {compactId(instance.instance_id)}</Text>
            <Text type="secondary">
              {instance.viewport.width} × {instance.viewport.height} ·{' '}
              {instance.proxy ? '代理连接' : '直连'}
            </Text>
          </>
        ) : (
          <Text type="secondary">实时画面仅供查看，操作由 Agent 执行</Text>
        )}
      </div>
      {instance && (
        <>
          <div className="live-instance-task">
            <Text type="secondary">任务目标</Text>
            <Paragraph className="instance-task-full">
              {instance.task_description ?? '未填写任务描述'}
            </Paragraph>
          </div>
          <LiveInstanceDetails instance={instance} onCopy={onCopy} />
        </>
      )}
    </Card>
  );
}
function RecordingTable({
  recordings,
  loading,
  onPlay,
  onLogs,
  compact = false,
}: {
  recordings: Recording[];
  loading: boolean;
  onPlay: (r: Recording) => void;
  onLogs: (r: Recording) => void;
  compact?: boolean;
}) {
  const columns: TableColumnsType<Recording> = [
    {
      title: '浏览器实例',
      dataIndex: 'instance_id',
      render: (id, r) => (
        <Space>
          <span className="table-record-icon">
            <VideoCameraOutlined />
          </span>
          <div className="recording-task-cell">
            <Text strong>
              <a href={instancePath(id)}>实例 {compactId(id)}</a>
            </Text>
            <TaskDescription value={r.task_description} />
          </div>
        </Space>
      ),
    },
    ...(!compact
      ? [
          {
            title: '出口 IP',
            key: 'egress',
            width: 270,
            render: (_: unknown, r: Recording) => (
              <Tooltip title={recordingNetworkHint(r)}>
                <Space size={6} wrap>
                  <Text className="history-egress">
                    {r.environment?.egress.ip ?? (r.environment ? '未检测' : '未记录')}
                  </Text>
                  <Text type="secondary" className="history-country">
                    {recordingCountry(r)}
                  </Text>
                </Space>
              </Tooltip>
            ),
          },
          {
            title: 'OS / UA',
            key: 'os',
            width: 135,
            render: (_: unknown, r: Recording) => (
              <Space size={4} className="history-os">
                <Tooltip title="根据当时浏览器实际 UA 识别的系统">
                  <Text>{r.environment?.os ?? (r.environment ? '未知' : '未记录')}</Text>
                </Tooltip>
                <Popover
                  trigger="click"
                  title="实例环境信息"
                  content={<RecordingEnvironment recording={r} />}
                >
                  <Button
                    type="text"
                    size="small"
                    icon={<InfoCircleOutlined />}
                    aria-label={`查看完整 UA ${r.id}`}
                    title="查看完整 UA"
                  />
                </Popover>
              </Space>
            ),
          },
        ]
      : []),
    {
      title: '开始时间',
      dataIndex: 'created_at',
      width: 160,
      render: displayTime,
      responsive: ['md'],
    },
    { title: '状态', dataIndex: 'status', width: 110, render: (s) => <StatusTag status={s} /> },
    ...(!compact
      ? [
          {
            title: '时长 / 大小',
            key: 'size',
            width: 150,
            render: (_: unknown, r: Recording) => (
              <div>
                {Math.round(r.frames / r.fps)} 秒
                <div className="cell-secondary">{fileSize(r.bytes)}</div>
              </div>
            ),
            responsive: ['lg'] as 'lg'[],
          },
        ]
      : []),
    {
      title: '操作',
      key: 'action',
      width: compact ? 150 : 210,
      align: 'right',
      render: (_, r) => (
        <Space size={0}>
          <Tooltip
            title={
              r.status === 'recording'
                ? '实例结束后可播放'
                : r.bytes === 0
                  ? '暂无可播放内容'
                  : undefined
            }
          >
            <Button
              type="link"
              size="small"
              icon={<PlayCircleOutlined />}
              disabled={r.bytes === 0 || ['recording', 'finalizing'].includes(r.status)}
              onClick={() => onPlay(r)}
            >
              播放录像
            </Button>
          </Tooltip>
          <Tooltip title="查看调用日志">
            <Button
              type="link"
              size="small"
              icon={<FileTextOutlined />}
              aria-label={`查看实例日志 ${r.instance_id}`}
              onClick={() => onLogs(r)}
            >
              {!compact && '调用日志'}
            </Button>
          </Tooltip>
        </Space>
      ),
    },
  ];
  return (
    <Table
      rowKey="id"
      className="recording-table"
      scroll={compact ? undefined : { x: 1100 }}
      columns={columns}
      dataSource={recordings}
      loading={loading}
      pagination={
        compact
          ? false
          : {
              pageSize: 10,
              showSizeChanger: false,
              hideOnSinglePage: true,
              showTotal: (total) => `共 ${total} 条录像`,
            }
      }
      locale={{
        emptyText: (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <span>
                暂无历史录屏
                <br />
                <Text type="secondary">实例结束后，录像会自动保存在这里</Text>
              </span>
            }
          />
        ),
      }}
    />
  );
}
function recordingCountry(r: Recording) {
  return countryLabel(r.environment?.country, r.environment ? '国家未知' : '国家未记录');
}
function countryLabel(code?: string | null, missing = '国家未知') {
  if (!code || !/^[A-Z]{2}$/.test(code) || code === 'ZZ') return missing;
  const name = new Intl.DisplayNames(['zh-CN'], { type: 'region' }).of(code);
  return `${name ?? code} (${code})`;
}
function recordingNetworkHint(r: Recording) {
  const e = r.environment?.egress;
  if (!e) return '此历史记录未保存环境信息';
  return [
    e.source === 'instance_check'
      ? '来源：实例检测'
      : e.source === 'proxy_check'
        ? '来源：代理检测样本，未验证当时浏览器连接的出口'
        : '未检测出口 IP',
    e.checked_at ? `检测时间：${new Date(e.checked_at).toLocaleString('zh-CN')}` : '',
    r.environment?.country ? '国家来自创建实例时的代理配置，未经出口 IP 地理验证' : '',
  ]
    .filter(Boolean)
    .join('；');
}
function RecordingEnvironment({ recording: r }: { recording: Recording }) {
  return (
    <div className="recording-environment-details">
      <Descriptions column={1} size="small">
        <Descriptions.Item label="出口 IP">
          {r.environment?.egress.ip ?? (r.environment ? '未检测' : '未记录')} {recordingCountry(r)}
        </Descriptions.Item>
        <Descriptions.Item label="OS（UA 识别）">
          {r.environment?.os ?? (r.environment ? '未知' : '未记录')}
        </Descriptions.Item>
      </Descriptions>
      <Text type="secondary">完整 UA</Text>
      <Paragraph
        className="history-user-agent"
        copyable={r.environment?.user_agent ? { text: r.environment.user_agent } : false}
      >
        {r.environment?.user_agent ?? '未记录'}
      </Paragraph>
      <Text type="secondary" className="recording-environment-note">
        {recordingNetworkHint(r)}
      </Text>
    </div>
  );
}
function HistoryPage({
  recordings,
  loading,
  onPlay,
  onLogs,
}: {
  recordings: Recording[];
  loading: boolean;
  onPlay: (r: Recording) => void;
  onLogs: (r: Recording) => void;
}) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const filtered = recordings.filter(
    (r) =>
      (status === 'all' || r.status === status) &&
      `${r.instance_id} ${r.id} ${r.task_description ?? ''} ${r.environment?.egress.ip ?? ''} ${recordingCountry(r)} ${r.environment?.os ?? ''} ${r.environment?.user_agent ?? ''}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  return (
    <Card
      className="section-card"
      title={
        <Space>
          <HistoryOutlined />
          录像记录<Tag>{recordings.length}</Tag>
        </Space>
      }
    >
      <div className="table-toolbar">
        <Input.Search
          allowClear
          placeholder="搜索任务、ID、IP、国家或 OS"
          aria-label="搜索录像"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Select
          aria-label="筛选录像状态"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'all', label: '全部状态' },
            { value: 'completed', label: '已完成' },
            { value: 'recording', label: '录制中' },
            { value: 'interrupted', label: '意外中断' },
            { value: 'failed', label: '失败' },
            { value: 'limit_reached', label: '达到上限' },
          ]}
        />
      </div>
      <RecordingTable recordings={filtered} loading={loading} onPlay={onPlay} onLogs={onLogs} />
      <Text type="secondary" className="table-footnote">
        录像记录当前活动页面；异常结束的录像可能不完整。
      </Text>
    </Card>
  );
}
function ConnectionPage({
  connection,
  onCopy,
  onGuide,
}: {
  connection?: Connection;
  onCopy: (value: string) => void;
  onGuide: () => void;
}) {
  const [reveal, setReveal] = useState(false);
  if (!connection)
    return (
      <Card>
        <Skeleton active />
      </Card>
    );
  const server = connection.mcp_config.mcpServers['cloudbrowser'];
  const token = server.headers.Authorization.replace(/^Bearer /, '');
  const masked = JSON.stringify(connection.mcp_config, null, 2).replace(
    token,
    '••••••••（点击复制获取完整配置）',
  );
  const toml = `[mcp_servers.cloudbrowser]\nurl = "${connection.mcp_url}"\n\n[mcp_servers.cloudbrowser.http_headers]\nAuthorization = "Bearer ${reveal ? token : '••••••••'}"`;
  return (
    <>
      <Card className="connection-banner" bordered={false}>
        <div>
          <Title level={4}>一步，把云浏览器连接到你的 Agent</Title>
          <Paragraph type="secondary">
            一句话、MCP 地址、认证信息和一个公开文档链接。
            <br />
            <Typography.Link href={connection.agent_guide_url} target="_blank" rel="noreferrer">
              查看公开接入文档
            </Typography.Link>
          </Paragraph>
        </div>
        <Space wrap>
          <Button icon={<FileTextOutlined />} onClick={onGuide}>
            预览说明
          </Button>
          <Button
            type="primary"
            icon={<CopyOutlined />}
            onClick={() => onCopy(connection.agent_instructions)}
            aria-label="复制 Agent 接入信息"
          >
            复制 Agent 接入信息
          </Button>
        </Space>
      </Card>
      <Row gutter={[20, 20]}>
        <Col xs={24} xl={15}>
          <Card
            title={
              <Space>
                <LinkOutlined />
                连接信息
              </Space>
            }
            className="section-card"
          >
            <div className="field-label">
              <Text strong>MCP 地址</Text>
              <Tag color="blue" bordered={false}>
                Streamable HTTP
              </Tag>
            </div>
            <Space.Compact block>
              <Input
                id="mcp-endpoint"
                aria-label="MCP 地址"
                readOnly
                value={connection.mcp_url}
                className="mono-input"
              />
              <Button
                icon={<CopyOutlined />}
                aria-label="复制 MCP 地址"
                onClick={() => onCopy(connection.mcp_url)}
              />
            </Space.Compact>
            <div className="field-label field-spaced">
              <Text strong>访问 Token</Text>
              <Text type="secondary">Authorization: Bearer</Text>
            </div>
            <Space.Compact block>
              <Input.Password
                aria-label="访问 Token"
                readOnly
                value={token}
                className="mono-input"
                visibilityToggle={{ visible: reveal, onVisibleChange: setReveal }}
              />
              <Button
                icon={<CopyOutlined />}
                aria-label="复制访问 Token"
                onClick={() => onCopy(token)}
              />
            </Space.Compact>
            <Alert
              className="token-note"
              type="info"
              showIcon
              title="Token 与网页密码独立"
              description="更换部署密码并重启后，旧 Token 会失效。请只把接入信息交给可信 Agent。"
            />
          </Card>
          <Card
            title={
              <Space>
                <CodeOutlined />
                客户端配置
              </Space>
            }
            extra={
              <Button
                icon={<CopyOutlined />}
                onClick={() => onCopy(JSON.stringify(connection.mcp_config, null, 2))}
              >
                复制 MCP 配置
              </Button>
            }
            className="section-card spaced-card"
          >
            <Tabs
              items={[
                {
                  key: 'json',
                  label: '通用 JSON',
                  children: (
                    <pre id="config" className="code-block">
                      {reveal ? JSON.stringify(connection.mcp_config, null, 2) : masked}
                    </pre>
                  ),
                },
                {
                  key: 'codex',
                  label: 'Codex TOML',
                  children: (
                    <>
                      <pre className="code-block">{toml}</pre>
                      <Button
                        size="small"
                        icon={<CopyOutlined />}
                        onClick={() =>
                          onCopy(
                            `[mcp_servers.cloudbrowser]\nurl = ${JSON.stringify(connection.mcp_url)}\n\n[mcp_servers.cloudbrowser.http_headers]\nAuthorization = ${JSON.stringify(server.headers.Authorization)}`,
                          )
                        }
                      >
                        复制完整 TOML
                      </Button>
                    </>
                  ),
                },
              ]}
            />
          </Card>
        </Col>
        <Col xs={24} xl={9}>
          <Card title="接入检查" className="section-card">
            <Steps
              direction="vertical"
              size="small"
              items={[
                { title: '复制接入信息', description: '地址、认证与公开文档一次复制' },
                {
                  title: '配置到 Agent 的 MCP 客户端',
                  description: '支持 Streamable HTTP 和自定义请求头',
                },
                { title: '让 Agent 检查连接', description: '调用 health 后即可创建浏览器实例' },
              ]}
            />
            <div className="connection-facts">
              <div>
                <Text type="secondary">可用工具</Text>
                <Text strong>{connection.tool_count} 个</Text>
              </div>
              <div>
                <Text type="secondary">实例上限</Text>
                <Text strong>{connection.max_instances} 个</Text>
              </div>
              <div>
                <Text type="secondary">鉴权方式</Text>
                <Text strong>Bearer Token</Text>
              </div>
            </div>
          </Card>
        </Col>
      </Row>
    </>
  );
}
function DocsPage({ onConnect }: { onConnect: () => void }) {
  const [document, setDocument] = useState('README.md');
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    void fetch(`${bootstrap.base}/docs/${document}`, { signal: controller.signal })
      .then(async (r) => {
        if (!r.ok) throw Error('读取失败');
        setContent(await r.text());
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [document]);
  return (
    <Card
      className="section-card docs-card"
      title={
        <Space>
          <FileTextOutlined />
          文档中心
        </Space>
      }
      extra={
        <Button type="primary" size="small" icon={<ApiOutlined />} onClick={onConnect}>
          获取接入配置
        </Button>
      }
    >
      <Tabs
        activeKey={document}
        onChange={setDocument}
        items={[
          { key: 'README.md', label: '部署与使用' },
          { key: 'agent-workflow.md', label: 'Agent 工作流程' },
          { key: 'mcp-api.md', label: 'MCP 接口参考' },
        ]}
      />
      {loading ? (
        <Skeleton active paragraph={{ rows: 12 }} />
      ) : error ? (
        <Empty description="文档暂时不可用，请稍后重试" />
      ) : (
        <article className="markdown-body">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              img: ({ src, alt }) => (
                <img
                  src={
                    src === 'docs/assets/getting-started.svg'
                      ? `${bootstrap.base}/assets/getting-started.svg`
                      : src
                  }
                  alt={alt}
                  style={{ maxWidth: '100%' }}
                />
              ),
              a: ({ children, ...props }) => (
                <a
                  {...props}
                  href={
                    props.href?.startsWith('http') || props.href?.startsWith('#')
                      ? props.href
                      : `https://github.com/okteam99/cloudbrowser/blob/main/${props.href ?? 'README.md'}`
                  }
                  target="_blank"
                  rel="noreferrer"
                >
                  {children}
                </a>
              ),
            }}
          >
            {content}
          </ReactMarkdown>
        </article>
      )}
    </Card>
  );
}
function PublicViewer() {
  const [view, setView] = useState(bootstrap.share);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!bootstrap.share) return;
    let cancelled = false;
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const response = await fetch(bootstrap.share!.status_url, {
          cache: 'no-store',
          credentials: 'omit',
          signal: controller.signal,
        });
        if (cancelled) return;
        if (response.status === 404) {
          setView(undefined);
          setError('');
          return;
        }
        if (!response.ok) throw Error();
        const next = await response.json();
        if (!cancelled) {
          setView(next);
          setError('');
        }
      } catch {
        if (!cancelled) setError('暂时无法连接，请刷新重试');
      }
    };
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(timer);
    };
  }, []);
  const active = view && ['live', 'ready'].includes(view.state);
  return (
    <main className="public-viewer">
      <Flex align="center" justify="space-between" wrap gap={16} className="public-viewer-heading">
        <Space size={12}>
          <Avatar
            shape="square"
            size={44}
            icon={<DesktopOutlined />}
            style={{ background: '#2463eb' }}
          />
          <div>
            <Title level={4} style={{ margin: 0 }}>
              cloudbrowser
            </Title>
            <Text type="secondary">AI 浏览器 · 公开观看</Text>
          </div>
        </Space>
        <Tag icon={<LockOutlined />}>仅可观看</Tag>
      </Flex>
      <Card className="public-viewer-card">
        <Flex justify="space-between" align="center" wrap gap={12}>
          <Title level={3} style={{ margin: 0 }}>
            {view?.kind === 'recording' ? '操作录像' : '浏览器直播'}
          </Title>
          <Badge
            status={active ? (view?.kind === 'live' ? 'processing' : 'success') : 'default'}
            text={active ? (view?.kind === 'live' ? '正在直播' : '可回放') : '已结束'}
          />
        </Flex>
        <div className="public-viewer-media">
          {active ? (
            view.kind === 'live' ? (
              <>
                <LiveImage
                  src={view.frame_url!}
                  alt="浏览器实时画面"
                  onLoad={() => {
                    setLoaded(true);
                    setError('');
                  }}
                  onError={() => setError('直播暂时中断，请刷新重试')}
                />
                {!loaded && <Text className="public-viewer-waiting">正在连接直播画面…</Text>}
              </>
            ) : (
              <video
                src={view.media_url}
                controls
                playsInline
                preload="metadata"
                onError={() => setError('录像暂时无法播放，请刷新重试')}
              />
            )
          ) : (
            <Empty
              description={
                !view
                  ? '链接已失效、已过期或已撤销'
                  : view.state === 'ended'
                    ? '本次直播已结束'
                    : '录像已清理或暂不可用'
              }
            />
          )}
        </div>
        {error && <Alert type="warning" showIcon title={error} style={{ marginBottom: 16 }} />}
        <Flex justify="space-between" wrap gap={8}>
          <Text type="secondary">
            {view?.kind === 'live' ? '实时观看 AI 的浏览器操作' : '回看 AI 的完整操作过程'}
          </Text>
          {view && (
            <Text type="secondary">
              链接有效期至 {new Date(view.expires_at).toLocaleString('zh-CN')}
            </Text>
          )}
        </Flex>
      </Card>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  <ConfigProvider
    locale={zhCN}
    theme={{
      algorithm: theme.defaultAlgorithm,
      token: {
        colorPrimary: '#2463eb',
        colorInfo: '#2463eb',
        borderRadius: 9,
        fontFamily:
          'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
        colorBgLayout: '#f4f6fa',
      },
      components: {
        Card: { paddingLG: 24 },
        Menu: {
          darkItemBg: '#0b1427',
          darkItemSelectedBg: '#234ed0',
          darkItemColor: '#9caecb',
          darkItemSelectedColor: '#fff',
          itemHeight: 46,
        },
        Table: { headerBg: '#f8fafc', cellPaddingBlock: 17 },
        Button: { controlHeight: 36 },
      },
    }}
  >
    <App>
      {bootstrap.screen === 'login' ? (
        <Login />
      ) : bootstrap.screen === 'share' ? (
        <PublicViewer />
      ) : (
        <Dashboard />
      )}
    </App>
  </ConfigProvider>,
);
