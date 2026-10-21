import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  App,
  Alert,
  Button,
  Card,
  Col,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  Tooltip,
  Flex,
} from 'antd';
import {
  CopyOutlined,
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
  DeleteOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import { api, copyText, mutate, type SavedProxy, type ProxyMonitor } from './api';

const codes =
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW ZZ'.split(
    ' ',
  );
const names = new Intl.DisplayNames(['zh-CN'], { type: 'region' });
const countries = codes
  .map((code) => ({ value: code, label: `${names.of(code)} (${code})` }))
  .sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'));

const statuses = {
  healthy: { label: '正常', color: 'success' },
  unhealthy: { label: '异常', color: 'error' },
  unknown: { label: '待检测', color: 'default' },
  checking: { label: '检测中', color: 'processing' },
  disabled: { label: '已停用', color: 'default' },
};
const proxyTitle = (p: SavedProxy) => {
  for (const prefix of [names.of(p.country), p.country]) {
    if (prefix && p.name.startsWith(prefix + ' · ')) return p.name.slice(prefix.length + 3);
  }
  return p.name;
};
const shortId = (id: string) => (id.length > 24 ? `${id.slice(0, 12)}...${id.slice(-6)}` : id);
function ProxyState({ p }: { p: SavedProxy }) {
  const info = statuses[p.status],
    h = p.health;
  const time = h.checked_at
    ? new Date(h.checked_at).toLocaleTimeString('zh-CN', { hour12: false })
    : '';
  const detail = [
    h.checked_at ? `上次检测：${new Date(h.checked_at).toLocaleString('zh-CN')}` : '等待检测',
    h.error_code ? `失败原因：${h.error_code}` : '',
    h.http_status ? `HTTP ${h.http_status}` : '',
    h.observed_ip ? `出口 IP：${h.observed_ip}` : '',
    h.next_check_at ? `下次检测：${new Date(h.next_check_at).toLocaleString('zh-CN')}` : '',
  ]
    .filter(Boolean)
    .join('；');
  return (
    <Tooltip title={detail}>
      <div className="proxy-state">
        <Tag color={info.color}>{info.label}</Tag>
        {time && (
          <span>
            {h.latency_ms !== undefined ? `${h.latency_ms}ms · ` : ''}
            {time}
          </span>
        )}
      </div>
    </Tooltip>
  );
}

export function ProxiesPage() {
  const { message } = App.useApp();
  const [rows, setRows] = useState<SavedProxy[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<SavedProxy>();
  const [error, setError] = useState<string>();
  const [form] = Form.useForm();
  const [monitor, setMonitor] = useState<ProxyMonitor>();
  const [query, setQuery] = useState('');
  const [country, setCountry] = useState<string>();
  const [status, setStatus] = useState<string>();
  const [protocol, setProtocol] = useState<string>();
  const inFlight = useRef(false);
  const refresh = useCallback(async (quiet = false) => {
    if (inFlight.current) return;
    inFlight.current = true;
    if (!quiet) setLoading(true);
    try {
      const [list, state] = await Promise.all([
        api<SavedProxy[]>('/api/proxies'),
        api<ProxyMonitor>('/api/proxy-health'),
      ]);
      setRows(list);
      setMonitor(state);
      setError(undefined);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      inFlight.current = false;
      if (!quiet) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(true), 5000);
    return () => clearInterval(timer);
  }, [refresh]);
  const checkAll = async () => {
    try {
      setMonitor(await mutate<ProxyMonitor>('/api/proxies/check', 'POST'));
      await refresh(true);
    } catch (e) {
      void message.error((e as Error).message);
    }
  };
  const filtered = rows.filter(
    (p) =>
      (!country || p.country === country) &&
      (!status || p.status === status) &&
      (!protocol || p.protocol === protocol) &&
      (!query ||
        [p.name, proxyTitle(p), p.host, String(p.port), p.proxy_id, p.username].some((v) =>
          v.toLowerCase().includes(query.toLowerCase().trim()),
        )),
  );
  const busy = !!monitor && monitor.checking + monitor.queued > 0;
  const edit = (record?: SavedProxy) => {
    setEditing(record);
    form.resetFields();
    form.setFieldsValue(
      record
        ? { ...record, name: proxyTitle(record) }
        : {
            protocol: 'socks5',
            port: 1080,
            country: 'US',
            enabled: true,
            username: '',
            password: '',
          },
    );
    setOpen(true);
  };
  const fields = (p: SavedProxy) => ({
    name: p.name,
    protocol: p.protocol,
    host: p.host,
    port: p.port,
    country: p.country,
    username: p.username,
    password: p.password,
    enabled: p.enabled,
  });
  const save = async () => {
    const input = await form.validateFields().catch(() => undefined);
    if (!input) return;
    setSaving(true);
    try {
      await mutate(
        '/api/proxies' + (editing ? '/' + encodeURIComponent(editing.proxy_id) : ''),
        editing ? 'PUT' : 'POST',
        { ...input, name: input.name?.trim() || input.host },
      );
      setOpen(false);
      void message.success('代理已保存');
      await refresh();
    } catch (e) {
      void message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const change = async (p: SavedProxy, enabled: boolean) => {
    try {
      await mutate(`/api/proxies/${encodeURIComponent(p.proxy_id)}`, 'PUT', {
        ...fields(p),
        enabled,
      });
      await refresh();
    } catch (e) {
      void message.error((e as Error).message);
    }
  };
  const remove = async (p: SavedProxy) => {
    try {
      await mutate(`/api/proxies/${encodeURIComponent(p.proxy_id)}`, 'DELETE');
      void message.success('代理已删除');
      await refresh();
    } catch (e) {
      void message.error((e as Error).message);
    }
  };
  return (
    <>
      {error && <Alert type="error" showIcon title={error} className="service-alert" />}
      <Card
        className="proxy-card"
        title={
          <Space>
            代理列表<Tag>{rows.length} 个</Tag>
          </Space>
        }
        extra={
          <Space>
            <Tooltip title="刷新列表">
              <Button
                aria-label="刷新代理"
                icon={<ReloadOutlined />}
                loading={loading}
                onClick={() => void refresh()}
              />
            </Tooltip>
            <Button
              icon={<SafetyCertificateOutlined />}
              loading={busy}
              onClick={() => void checkAll()}
            >
              立即检测
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => edit()}>
              添加代理
            </Button>
          </Space>
        }
      >
        <Flex wrap gap={8} className="proxy-filters">
          <Input.Search
            aria-label="搜索代理"
            placeholder="搜索名称、IP、ID 或用户名"
            allowClear
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <Select
            aria-label="筛选国家"
            placeholder="全部国家 / 地区"
            allowClear
            showSearch
            optionFilterProp="label"
            value={country}
            onChange={setCountry}
            options={countries.filter((c) => rows.some((p) => p.country === c.value))}
          />
          <Select
            aria-label="筛选状态"
            placeholder="全部状态"
            allowClear
            value={status}
            onChange={setStatus}
            options={Object.entries(statuses).map(([value, s]) => ({ value, label: s.label }))}
          />
          <Select
            aria-label="筛选协议"
            placeholder="全部协议"
            allowClear
            value={protocol}
            onChange={setProtocol}
            options={['socks5', 'http', 'https'].map((value) => ({
              value,
              label: value.toUpperCase(),
            }))}
          />
          <Button
            disabled={!query && !country && !status && !protocol}
            onClick={() => {
              setQuery('');
              setCountry(undefined);
              setStatus(undefined);
              setProtocol(undefined);
            }}
          >
            重置筛选
          </Button>
        </Flex>
        <Flex justify="space-between" wrap gap={8} className="proxy-check-summary">
          <Typography.Text type="secondary">
            自动检测 · 每 {Math.round((monitor?.interval_seconds ?? 300) / 60)} 分钟
            {busy ? ` · 检测中 ${monitor!.checking}，排队 ${monitor!.queued}` : ''}
          </Typography.Text>
          <Space size={10}>
            <Typography.Text type="success">
              正常 {rows.filter((p) => p.status === 'healthy').length}
            </Typography.Text>
            <Typography.Text type="danger">
              异常 {rows.filter((p) => p.status === 'unhealthy').length}
            </Typography.Text>
            <Typography.Text type="secondary">
              显示 {filtered.length} / {rows.length}
            </Typography.Text>
          </Space>
        </Flex>
        <Table<SavedProxy>
          className="proxy-table"
          size="small"
          rowKey="proxy_id"
          dataSource={filtered}
          loading={loading}
          scroll={{ x: 1000 }}
          pagination={{
            defaultPageSize: 20,
            hideOnSinglePage: rows.length <= 20,
            showSizeChanger: true,
            pageSizeOptions: [20, 50, 100],
          }}
          locale={{
            emptyText: rows.length
              ? '没有符合筛选条件的代理'
              : '还没有代理，点击“添加代理”开始配置',
          }}
          columns={[
            {
              title: '名称 / 代理 ID',
              width: 200,
              render: (_, p) => (
                <>
                  <Tooltip title={proxyTitle(p)}>
                    <Typography.Text strong className="proxy-name">
                      {proxyTitle(p)}
                    </Typography.Text>
                  </Tooltip>
                  <div className="proxy-id-line">
                    <Tooltip title={p.proxy_id}>
                      <Typography.Text type="secondary" className="proxy-id">
                        {shortId(p.proxy_id)}
                      </Typography.Text>
                    </Tooltip>
                    <Button
                      type="text"
                      size="small"
                      icon={<CopyOutlined />}
                      aria-label={`复制代理 ID ${proxyTitle(p)}`}
                      onClick={() =>
                        void copyText(p.proxy_id)
                          .then(() => message.success('代理 ID 已复制'))
                          .catch(() => message.error('复制失败'))
                      }
                    />
                  </div>
                </>
              ),
            },
            {
              title: '国家 / 地区',
              width: 105,
              render: (_, p) => (
                <Tooltip title={`${names.of(p.country)} (${p.country})`}>
                  <span className="proxy-nowrap">
                    {p.country} · {names.of(p.country)}
                  </span>
                </Tooltip>
              ),
            },
            {
              title: '代理地址',
              width: 180,
              render: (_, p) => (
                <div className="proxy-address">
                  <Tooltip title={`${p.protocol}://${p.host}:${p.port}`}>
                    <span>
                      {p.host}:{p.port}
                    </span>
                  </Tooltip>
                  <Tag>{p.protocol.toUpperCase()}</Tag>
                </div>
              ),
            },
            { title: '状态', width: 130, render: (_, p) => <ProxyState p={p} /> },
            {
              title: '用户名',
              dataIndex: 'username',
              width: 100,
              render: (v) => (
                <Tooltip title={v}>
                  <span className="proxy-secret">{v || '—'}</span>
                </Tooltip>
              ),
            },
            {
              title: '密码',
              dataIndex: 'password',
              width: 135,
              render: (v) => (
                <Tooltip title={v}>
                  <span className="proxy-secret">{v || '—'}</span>
                </Tooltip>
              ),
            },
            {
              title: '启用',
              width: 60,
              render: (_, p) => (
                <Switch
                  size="small"
                  checked={p.enabled}
                  aria-label={`启用代理 ${proxyTitle(p)}`}
                  onChange={(value) => void change(p, value)}
                />
              ),
            },
            {
              title: '操作',
              width: 90,
              fixed: 'right',
              render: (_, p) => (
                <Space size={2}>
                  <Tooltip title="编辑">
                    <Button
                      type="text"
                      size="small"
                      icon={<EditOutlined />}
                      aria-label={`编辑代理 ${proxyTitle(p)}`}
                      onClick={() => edit(p)}
                    />
                  </Tooltip>
                  <Popconfirm
                    title="删除这个代理？"
                    description="已创建的浏览器保持原有代理配置。"
                    onConfirm={() => remove(p)}
                  >
                    <Tooltip title="删除">
                      <Button
                        type="text"
                        size="small"
                        danger
                        icon={<DeleteOutlined />}
                        aria-label={`删除代理 ${proxyTitle(p)}`}
                      />
                    </Tooltip>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
        <Typography.Paragraph type="secondary" className="proxy-footnote">
          国家为手动标记；状态表示到检测目标的最近一次 HTTPS
          连通结果。悬停查看时间和失败原因。密码在管理页明文显示，MCP 列表不返回凭据。
        </Typography.Paragraph>
      </Card>
      <Modal
        title={editing ? '编辑代理' : '添加代理'}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => void save()}
        confirmLoading={saving}
        okText="保存代理"
        cancelText="取消"
        width={620}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" autoComplete="off" preserve={false}>
          <Form.Item name="name" label="名称（可选）">
            <Input placeholder="例如：测试线路 A" maxLength={100} />
          </Form.Item>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="protocol" label="协议" rules={[{ required: true }]}>
                <Select
                  options={[
                    { value: 'socks5', label: 'SOCKS5' },
                    { value: 'http', label: 'HTTP' },
                    { value: 'https', label: 'HTTPS' },
                  ]}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="country" label="国家 / 地区" rules={[{ required: true }]}>
                <Select showSearch optionFilterProp="label" options={countries} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={16}>
              <Form.Item
                name="host"
                label="服务器 IP / 域名"
                rules={[{ required: true, message: '请输入服务器 IP 或域名' }]}
              >
                <Input placeholder="203.0.113.10" maxLength={253} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                name="port"
                label="端口"
                rules={[{ required: true, message: '请输入端口' }]}
              >
                <InputNumber min={1} max={65535} precision={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="username" label="用户名">
            <Input maxLength={512} autoComplete="off" />
          </Form.Item>
          <Form.Item name="password" label="密码（明文）">
            <Input type="text" maxLength={512} autoComplete="off" />
          </Form.Item>
          <Form.Item name="enabled" label="启用代理" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
