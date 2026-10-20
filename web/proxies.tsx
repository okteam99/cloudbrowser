import React, { useEffect, useState } from 'react';
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
} from 'antd';
import { CopyOutlined, EditOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { api, copyText, mutate, type SavedProxy } from './api';

const codes =
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW ZZ'.split(
    ' ',
  );
const names = new Intl.DisplayNames(['zh-CN'], { type: 'region' });
const countries = codes
  .map((code) => ({ value: code, label: `${names.of(code)} (${code})` }))
  .sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'));

export function ProxiesPage() {
  const { message } = App.useApp();
  const [rows, setRows] = useState<SavedProxy[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<SavedProxy>();
  const [error, setError] = useState<string>();
  const [form] = Form.useForm();
  const refresh = async () => {
    setLoading(true);
    try {
      setRows(await api<SavedProxy[]>('/api/proxies'));
      setError(undefined);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void refresh();
  }, []);
  const edit = (record?: SavedProxy) => {
    setEditing(record);
    form.resetFields();
    form.setFieldsValue(
      record ?? {
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
        { ...input, name: input.name?.trim() || `${input.country} · ${input.host}` },
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
      <Alert
        type="info"
        showIcon
        title="给 Agent 一份可选代理列表"
        description="保存后，Agent 调用 list_proxies 获取代理 ID，再通过 create_instance 或 proxy_curl 使用。国家是你填写的标记；启用状态不代表已验证出口或连通性。"
        className="service-alert"
      />
      {error && <Alert type="error" showIcon title={error} className="service-alert" />}
      <Card
        title={
          <Space>
            可用代理<Tag>{rows.length} 个</Tag>
          </Space>
        }
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void refresh()}>
              刷新代理
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => edit()}>
              添加代理
            </Button>
          </Space>
        }
      >
        <Table<SavedProxy>
          rowKey="proxy_id"
          dataSource={rows}
          loading={loading}
          scroll={{ x: 1000 }}
          pagination={{ pageSize: 10, hideOnSinglePage: true }}
          locale={{ emptyText: '还没有代理，点击“添加代理”开始配置' }}
          columns={[
            {
              title: '名称 / 代理 ID',
              width: 230,
              render: (_, p) => (
                <>
                  <Typography.Text strong>{p.name}</Typography.Text>
                  <div>
                    <Typography.Text type="secondary" className="proxy-id">
                      {p.proxy_id}
                    </Typography.Text>
                    <Button
                      type="text"
                      size="small"
                      icon={<CopyOutlined />}
                      aria-label={`复制代理 ID ${p.name}`}
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
              width: 120,
              render: (_, p) => `${names.of(p.country)} (${p.country})`,
            },
            {
              title: '代理地址',
              width: 180,
              render: (_, p) => (
                <>
                  <Tag>{p.protocol.toUpperCase()}</Tag>
                  <div className="mono-input">
                    {p.host}:{p.port}
                  </div>
                </>
              ),
            },
            {
              title: '用户名',
              dataIndex: 'username',
              width: 100,
              render: (v) => <span className="proxy-secret">{v || '—'}</span>,
            },
            {
              title: '密码',
              dataIndex: 'password',
              width: 150,
              render: (v) => <span className="proxy-secret">{v || '—'}</span>,
            },
            {
              title: '启用',
              width: 75,
              render: (_, p) => (
                <Switch
                  checked={p.enabled}
                  aria-label={`启用代理 ${p.name}`}
                  onChange={(value) => void change(p, value)}
                />
              ),
            },
            {
              title: '操作',
              width: 135,
              fixed: 'right',
              render: (_, p) => (
                <Space>
                  <Button
                    type="link"
                    icon={<EditOutlined />}
                    aria-label={`编辑代理 ${p.name}`}
                    onClick={() => edit(p)}
                  >
                    编辑
                  </Button>
                  <Popconfirm
                    title="删除这个代理？"
                    description="已创建的浏览器保持原有代理配置。"
                    onConfirm={() => remove(p)}
                  >
                    <Button type="link" danger>
                      删除
                    </Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
        <Typography.Paragraph type="secondary" style={{ marginTop: 16, marginBottom: 0 }}>
          密码在此管理页明文显示，MCP
          代理列表不返回凭据。配置保存在数据卷，修改仅影响后续创建的浏览器和 HTTP 请求。
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
            <Input placeholder="例如：美国测试线路" maxLength={100} />
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
