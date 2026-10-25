import React, { useEffect, useState } from 'react';
import { Alert, App, Button, Card, Input, Popconfirm, Space, Spin, Tag, Typography } from 'antd';
import { CopyOutlined, ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import { api, bootstrap, copyText } from './api';

type Catalog = {
  revision: string;
  profiles: {
    profile_id: string;
    enabled: boolean;
    profile: { name: string; [key: string]: unknown };
  }[];
};
const { Paragraph, Text } = Typography;
const format = (value: unknown) => JSON.stringify(value, null, 2);

export function DeviceProfileSettings() {
  const [catalog, setCatalog] = useState<Catalog>();
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const { message } = App.useApp();
  const dirty = !!catalog && draft !== format(catalog.profiles);
  const load = async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const value = await api<Catalog>('/api/settings/device-profiles', signal);
      if (signal?.aborted) return;
      setCatalog(value);
      setDraft(format(value.profiles));
      setError(undefined);
    } catch (e) {
      if (!signal?.aborted) setError(e instanceof Error ? e.message : '读取失败');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  };
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, []);
  const save = async () => {
    if (!catalog) return;
    setSaving(true);
    setError(undefined);
    try {
      const profiles = JSON.parse(draft);
      if (!Array.isArray(profiles)) throw Error('请填写 JSON 数组，每个元素是一份设备档案。');
      const response = await fetch(bootstrap.base + '/api/settings/device-profiles', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-csrf-token': bootstrap.csrf },
        body: JSON.stringify({ revision: catalog.revision, profiles }),
      });
      if (response.status === 401) throw Error('登录已过期，请重新登录后保存。');
      if (response.status === 409)
        throw Error('档案已被其他窗口修改。请先复制当前 JSON，再重新加载并合并修改。');
      const value = await response.json();
      if (!response.ok)
        throw Error(
          value.issues
            ?.map((issue: { path: string; message: string }) => `${issue.path}: ${issue.message}`)
            .join('\n') || '保存失败，请检查 JSON 或登录状态。',
        );
      setCatalog(value);
      setDraft(format(value.profiles));
      message.success('设备档案已保存，新实例立即可用');
    } catch (e) {
      setError(
        e instanceof SyntaxError
          ? `JSON 格式错误：${e.message}`
          : e instanceof Error
            ? e.message
            : '保存失败',
      );
    } finally {
      setSaving(false);
    }
  };
  const refreshButton = (
    <Button
      icon={<ReloadOutlined />}
      loading={loading}
      disabled={saving}
      onClick={dirty ? undefined : () => void load()}
    >
      重新加载
    </Button>
  );
  return (
    <Card
      className="section-card"
      title={<Space>设备档案 {dirty && <Tag color="orange">未保存</Tag>}</Space>}
      extra={
        dirty ? (
          <Popconfirm title="重新加载会放弃未保存的 JSON，是否继续？" onConfirm={() => void load()}>
            {refreshButton}
          </Popconfirm>
        ) : (
          refreshButton
        )
      }
    >
      <Paragraph>
        在下方 JSON 中新增、修改或删除设备档案。每项包含唯一的 <Text code>profile_id</Text>、
        <Text code>enabled</Text> 和完整的 <Text code>profile</Text>。可复制已有档案修改，最多 100
        份。
      </Paragraph>
      <Paragraph type="secondary">
        Agent 调用 list_device_profiles（支持按系统筛选）或 get_device_profile 读取档案，然后将 ID
        传入 create_instance.device_profile_id。档案内包含 UA 和 Client Hints，不会仅凭单独的 UA
        自动选择档案。
      </Paragraph>
      {error && (
        <Alert
          type="error"
          showIcon
          title="设备档案未保存"
          description={
            <span style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{error}</span>
          }
        />
      )}
      {!catalog ? (
        <Spin spinning={loading} />
      ) : (
        <>
          <Input.TextArea
            aria-label="设备档案 JSON"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={saving || loading}
            autoSize={{ minRows: 16, maxRows: 30 }}
            spellCheck={false}
            style={{
              margin: '16px 0',
              fontFamily: 'ui-monospace, SFMono-Regular, monospace',
              fontSize: 13,
            }}
          />
          <Space wrap>
            <Button
              aria-label="保存设备档案"
              type="primary"
              icon={<SaveOutlined />}
              loading={saving}
              disabled={loading || !dirty}
              onClick={() => void save()}
            >
              保存设备档案
            </Button>
            <Button
              disabled={saving || loading}
              onClick={() => {
                try {
                  setDraft(format(JSON.parse(draft)));
                  setError(undefined);
                } catch (e) {
                  setError(`JSON 格式错误：${e instanceof Error ? e.message : ''}`);
                }
              }}
            >
              格式化 JSON
            </Button>
            <Button
              icon={<CopyOutlined />}
              onClick={() =>
                void copyText(draft)
                  .then(() => message.success('已复制设备档案 JSON'))
                  .catch(() => message.error('复制失败，请手动复制'))
              }
            >
              复制 JSON
            </Button>
            <Text type="secondary">
              已保存 {catalog.profiles.length} 份 · 启用{' '}
              {catalog.profiles.filter((p) => p.enabled).length} 份
            </Text>
          </Space>
          <Paragraph type="secondary" style={{ marginTop: 16, marginBottom: 0 }}>
            保存后即时生效，重启后保留。修改、停用或删除档案只影响后续创建；已运行实例及历史记录保留创建时的配置。UA
            与 Client Hints 的版本和系统必须一致，保存时会逐项校验。
          </Paragraph>
        </>
      )}
    </Card>
  );
}
