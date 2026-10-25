import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Descriptions,
  Form,
  InputNumber,
  Progress,
  Row,
  Space,
  Spin,
  Statistic,
  Typography,
} from 'antd';
import { ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import { api, mutate } from './api';
import { DeviceProfileSettings } from './device-profile-settings';

type Settings = {
  storage: { max_data_bytes: number; screenshot_retention_days: number };
  usage: {
    bytes: number;
    count: number;
    available_bytes: number;
    disk_available_bytes: number;
    by_kind: Record<string, { count: number; bytes: number }>;
  };
};
const gib = 1024 ** 3;
const size = (bytes: number) =>
  bytes >= gib ? `${(bytes / gib).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(2)} MB`;
const { Text, Paragraph } = Typography;
export function SettingsPage() {
  const [data, setData] = useState<Settings>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [form] = Form.useForm<{ quota_gb: number; screenshot_days: number }>();
  const initialized = useRef(false);
  const { message } = App.useApp();
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      setRefreshing(true);
      try {
        const value = await api<Settings>('/api/settings', signal);
        if (signal?.aborted) return;
        setData(value);
        setError(undefined);
        if (!initialized.current) {
          form.setFieldsValue({
            quota_gb: value.storage.max_data_bytes / gib,
            screenshot_days: value.storage.screenshot_retention_days,
          });
          initialized.current = true;
        }
      } catch (e) {
        if (!signal?.aborted) setError(e instanceof Error ? e.message : '无法读取设置');
      } finally {
        if (!signal?.aborted) setRefreshing(false);
      }
    },
    [form],
  );
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = setInterval(() => void refresh(controller.signal), 10000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [refresh]);
  const save = async (values: { quota_gb: number; screenshot_days: number }) => {
    setSaving(true);
    try {
      const value = await mutate<Settings>('/api/settings', 'PUT', {
        max_data_bytes: Math.round(values.quota_gb * gib),
        screenshot_retention_days: values.screenshot_days,
      });
      setData(value);
      setError(undefined);
      message.success('存储设置已保存并生效');
    } catch (e) {
      message.error(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="system-settings">
      <DeviceProfileSettings />
      {error && <Alert type="error" showIcon title={error} />}
      <Card
        className="section-card"
        title="存储用量"
        extra={
          <Button icon={<ReloadOutlined />} loading={refreshing} onClick={() => void refresh()}>
            刷新用量
          </Button>
        }
      >
        {!data ? (
          <Spin />
        ) : (
          <>
            <Row gutter={[24, 20]}>
              <Col xs={24} md={8}>
                <Statistic title="产物已使用" value={size(data.usage.bytes)} />
              </Col>
              <Col xs={24} md={8}>
                <Statistic title="产物存储配额" value={size(data.storage.max_data_bytes)} />
              </Col>
              <Col xs={24} md={8}>
                <Statistic title="服务器磁盘可用" value={size(data.usage.disk_available_bytes)} />
              </Col>
            </Row>
            <Progress
              percent={Math.min(
                100,
                Math.round((data.usage.bytes / data.storage.max_data_bytes) * 1000) / 10,
              )}
              status={data.usage.bytes >= data.storage.max_data_bytes ? 'exception' : 'normal'}
            />
            <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 4 }}>
              <Descriptions.Item label="产物数量">{data.usage.count}</Descriptions.Item>
              <Descriptions.Item label="截图 / 预览">
                {size(
                  (data.usage.by_kind.screenshot?.bytes ?? 0) +
                    (data.usage.by_kind.screenshot_preview?.bytes ?? 0),
                )}
              </Descriptions.Item>
              <Descriptions.Item label="下载文件">
                {size(data.usage.by_kind.download?.bytes ?? 0)}
              </Descriptions.Item>
              <Descriptions.Item label="登录态">
                {size(data.usage.by_kind.storage_state?.bytes ?? 0)}
              </Descriptions.Item>
            </Descriptions>
          </>
        )}
      </Card>
      <Card className="section-card" title="存储设置">
        <Paragraph type="secondary">
          配额用于截图、下载文件和登录态等产物，录屏单独管理。1 GB 按 1024 MB 计算。
        </Paragraph>
        <Form
          form={form}
          layout="vertical"
          onFinish={save}
          disabled={!data || saving}
          className="storage-settings-form"
        >
          <Form.Item
            label="产物存储配额（GB）"
            name="quota_gb"
            rules={[{ required: true, message: '请填写存储配额' }]}
            extra="默认 200 GB；这是应用上限，不会预先占用磁盘。"
          >
            <InputNumber
              min={1}
              max={8388607}
              precision={0}
              addonAfter="GB"
              aria-label="产物存储配额（GB）"
            />
          </Form.Item>
          <Form.Item
            label="截图保留天数"
            name="screenshot_days"
            rules={[{ required: true, message: '请填写保留天数' }]}
            extra="默认 7 天，同时适用于 PNG 原图和 JPEG 预览；不改变其他文件的保留期限。"
          >
            <InputNumber
              min={1}
              max={365}
              precision={0}
              addonAfter="天"
              aria-label="截图保留天数"
            />
          </Form.Item>
          <Alert
            type="info"
            showIcon
            title="保存后即时生效，容器重启后继续使用已保存的设置。"
            description="超期截图会自动清理；配额不足时优先清理过期文件，再按时间清理最旧的产物。缩短保留期限或降低配额可能使现有产物被清理。"
          />
          <Space className="storage-settings-actions">
            <Button type="primary" htmlType="submit" loading={saving} icon={<SaveOutlined />}>
              保存设置
            </Button>
            <Text type="secondary">无需重启浏览器实例</Text>
          </Space>
        </Form>
      </Card>
    </div>
  );
}
