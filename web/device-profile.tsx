import React, { useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Collapse,
  Empty,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import { CopyOutlined } from '@ant-design/icons';
import { copyText, displayTime, type DeviceProfileView, type DeviceVerificationView } from './api';
const { Text, Paragraph } = Typography;
const status: Record<string, { label: string; color: string }> = {
  match: { label: '一致', color: 'success' },
  mismatch: { label: '有差异', color: 'error' },
  unavailable: { label: '无法读取', color: 'warning' },
  passed: { label: '执行通过', color: 'success' },
  failed: { label: '执行失败', color: 'error' },
  unsupported: { label: '不支持', color: 'default' },
  blocked: { label: '受限 / 超时', color: 'warning' },
  reported: { label: '仅查询可用性', color: 'blue' },
};
const names: Record<string, string> = {
  canvas_2d: 'Canvas 绘制与读取',
  webgl: 'WebGL 绘制与读取',
  audio_processing: '音频处理',
  bluetooth: '蓝牙',
  speech: '系统语音',
  pdf_viewer: 'PDF 查看器',
  web_share: '系统分享',
  dedicated_worker: 'Worker 执行',
};
const value = (v: unknown) =>
  v === null || v === undefined ? '未读取' : typeof v === 'string' ? v : JSON.stringify(v);
export function DeviceProfileCard({
  profile,
  report,
  browserVersion,
  browserMode,
}: {
  profile?: DeviceProfileView | null;
  report?: DeviceVerificationView | null;
  browserVersion?: string;
  browserMode?: string;
}) {
  const [differencesOnly, setDifferencesOnly] = useState(true);
  const { message } = App.useApp();
  const copy = async () => {
    try {
      await copyText(JSON.stringify(profile, null, 2));
      message.success('设备配置档已复制');
    } catch {
      message.error('复制失败');
    }
  };
  return (
    <Card
      className="section-card device-profile-card"
      title="设备配置与核验"
      extra={
        profile && (
          <Button icon={<CopyOutlined />} onClick={() => void copy()}>
            复制设备配置档
          </Button>
        )
      }
    >
      <Space wrap>
        <Text strong>{profile?.name ?? '未指定设备配置档'}</Text>
        <Tag>实际内核 {browserVersion ?? report?.browser_version ?? '未记录'}</Tag>
        {browserMode === 'chromium_new_headless' && <Tag>完整 Chromium · 新版无头模式</Tag>}
      </Space>
      <Paragraph type="secondary">
        配置值用于浏览器模拟；能力期望只做实测比较。字段一致不代表实际硬件相同。
      </Paragraph>
      {profile && (
        <Collapse
          size="small"
          items={[
            {
              key: 'profile',
              label: '查看完整配置 JSON',
              children: (
                <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                  {JSON.stringify(profile, null, 2)}
                </pre>
              ),
            },
          ]}
        />
      )}
      {!report ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="尚未核验。Agent 可在打开测试页面后调用 verify_device_profile。"
        />
      ) : (
        <>
          <Space wrap style={{ margin: '16px 0' }}>
            <Tag color="success">一致 {report.summary.matched}</Tag>
            <Tag color="error">差异 {report.summary.mismatched}</Tag>
            <Tag color="warning">无法读取 {report.summary.unavailable}</Tag>
            <Text type="secondary">核验于 {displayTime(report.checked_at)}</Text>
          </Space>
          <Paragraph type="secondary" ellipsis={{ rows: 2, expandable: true }}>
            {report.url}
          </Paragraph>
          <Tabs
            items={[
              {
                key: 'fields',
                label: '逐字段对比',
                children: (
                  <>
                    <Space style={{ marginBottom: 12 }}>
                      <Switch checked={differencesOnly} onChange={setDifferencesOnly} />
                      <Text>只看差异及无法读取</Text>
                    </Space>
                    <Table
                      size="small"
                      rowKey={(r) => r.scope + ':' + r.field}
                      pagination={{ pageSize: 12 }}
                      scroll={{ x: 850 }}
                      dataSource={report.fields.filter(
                        (r) => !differencesOnly || r.status !== 'match',
                      )}
                      locale={{ emptyText: '当前筛选下没有差异' }}
                      columns={[
                        {
                          title: '范围',
                          dataIndex: 'scope',
                          width: 80,
                          render: (v) => (v === 'worker' ? 'Worker' : '页面'),
                        },
                        { title: '字段', dataIndex: 'field', width: 230 },
                        {
                          title: '目标值',
                          dataIndex: 'expected',
                          render: (v) => (
                            <Text style={{ overflowWrap: 'anywhere' }}>{value(v)}</Text>
                          ),
                        },
                        {
                          title: '实测值',
                          dataIndex: 'actual',
                          render: (v) => (
                            <Text style={{ overflowWrap: 'anywhere' }}>{value(v)}</Text>
                          ),
                        },
                        {
                          title: '类型',
                          dataIndex: 'mode',
                          width: 100,
                          render: (v) => (v === 'expectation' ? '能力期望' : '模拟字段'),
                        },
                        {
                          title: '结果',
                          dataIndex: 'status',
                          width: 110,
                          render: (v) => (
                            <Tag color={status[v]?.color}>{status[v]?.label ?? v}</Tag>
                          ),
                        },
                      ]}
                    />
                  </>
                ),
              },
              {
                key: 'capabilities',
                label: '实际能力',
                children: (
                  <>
                    <Alert
                      type="info"
                      showIcon
                      title="执行验证与可用性查询分开展示"
                      description="绘制、音频处理、Worker 和隔离页面中的本地 PDF 渲染会实际执行；蓝牙、语音及分享只查询可用性，不弹权限窗口，也不声称已完成设备连接或声音输出。"
                    />
                    <Table
                      size="small"
                      rowKey="name"
                      pagination={false}
                      dataSource={report.capabilities}
                      expandable={{
                        expandedRowRender: (r) => (
                          <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                            {JSON.stringify(r.details, null, 2)}
                          </pre>
                        ),
                      }}
                      columns={[
                        { title: '能力', dataIndex: 'name', render: (v) => names[v] ?? v },
                        {
                          title: '检测方式',
                          dataIndex: 'method',
                          render: (v) =>
                            v === 'execution'
                              ? '实际执行'
                              : v === 'availability'
                                ? '接口可用性'
                                : '浏览器报告',
                        },
                        {
                          title: '结果',
                          dataIndex: 'status',
                          render: (v) => (
                            <Tag color={status[v]?.color}>{status[v]?.label ?? v}</Tag>
                          ),
                        },
                      ]}
                    />
                  </>
                ),
              },
            ]}
          />
        </>
      )}
    </Card>
  );
}
