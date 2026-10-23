import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Input,
  Row,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import { CopyOutlined, LinkOutlined } from '@ant-design/icons';
import { api, type Connection } from './api.js';

const { Text, Paragraph } = Typography;
type Tool = {
  name: string;
  description: string;
  url: string;
  inputSchema: any;
  annotations?: { readOnlyHint?: boolean };
};
export function ApiDocs({
  connection,
  onCopy,
}: {
  connection: Connection;
  onCopy: (value: string) => void;
}) {
  const [tools, setTools] = useState<Tool[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState('create_instance');
  useEffect(() => {
    const controller = new AbortController();
    void api<{ tools: Tool[] }>('/api/tools', controller.signal)
      .then((data) => setTools(data.tools))
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);
  const token = connection.mcp_config.mcpServers.cloudbrowser.headers.Authorization.replace(
    /^Bearer /,
    '',
  );
  const endpoint = `${connection.api_base_url}/tools/create_instance`;
  const args = { task_description: '检查网页功能', viewport: { width: 1440, height: 900 } };
  const shellQuote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
  const curl = `# TOKEN 使用从控制台复制的访问 Token\ncurl --fail-with-body ${shellQuote(endpoint)} \\\n  -H "Authorization: Bearer $TOKEN" \\\n  -H 'Content-Type: application/json' \\\n  --data ${shellQuote(JSON.stringify(args))}`;
  const python = `import json, os, urllib.request\n\nrequest = urllib.request.Request(\n    ${JSON.stringify(endpoint)},\n    data=json.dumps(${JSON.stringify(args)}).encode(),\n    headers={"Authorization": "Bearer " + os.environ["TOKEN"],\n             "Content-Type": "application/json"},\n    method="POST",\n)\nwith urllib.request.urlopen(request, timeout=180) as response:\n    result = json.load(response)\nprint(result)  # instance_id 位于 result["data"]`;
  const js = `// Node.js；TOKEN 从环境变量读取\nconst response = await fetch(${JSON.stringify(endpoint)}, {\n  method: "POST",\n  headers: { Authorization: \`Bearer \${process.env.TOKEN}\`,\n             "Content-Type": "application/json" },\n  body: JSON.stringify(${JSON.stringify(args)}),\n});\nconst result = await response.json();\nif (!response.ok || result.status !== "succeeded") throw new Error(JSON.stringify(result));\nconsole.log(result.data);`;
  const tool = tools.find((item) => item.name === selected);
  const required = new Set(tool?.inputSchema.required ?? []);
  const params = Object.entries(tool?.inputSchema.properties ?? {}).map(
    ([name, schema]: [string, any]) => ({ name, schema, required: required.has(name) }),
  );
  return (
    <Space orientation="vertical" size={20} style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        title="MCP 与 API，共用一套浏览器能力"
        description="工具名称、参数、实例和调用日志保持一致。Agent 可通过 MCP 发现并调用工具，也可直接发送 HTTP JSON 请求。两种方式共用同一份公开 Markdown 接入文档。"
      />
      <Row gutter={[20, 20]} style={{ width: '100%', margin: 0 }}>
        <Col xs={24} xl={14}>
          <Card title="API 连接信息" className="section-card">
            <div className="field-label">
              <Text strong>API 地址</Text>
              <Tag color="blue">HTTP JSON</Tag>
            </div>
            <Space.Compact block>
              <Input
                aria-label="API 地址"
                readOnly
                value={connection.api_base_url}
                className="mono-input"
              />
              <Button
                aria-label="复制 API 地址"
                icon={<CopyOutlined />}
                onClick={() => onCopy(connection.api_base_url)}
              />
            </Space.Compact>
            <div className="field-label field-spaced">
              <Text strong>访问 Token</Text>
              <Text type="secondary">与 MCP 相同</Text>
            </div>
            <Space.Compact block>
              <Input.Password
                aria-label="API 访问 Token"
                readOnly
                value={token}
                className="mono-input"
              />
              <Button
                aria-label="复制 API Token"
                icon={<CopyOutlined />}
                onClick={() => onCopy(token)}
              />
            </Space.Compact>
            <Space wrap className="field-spaced">
              <Button
                type="primary"
                icon={<CopyOutlined />}
                onClick={() => onCopy(connection.api_instructions)}
              >
                复制 API 接入信息
              </Button>
              <Button href={connection.agent_guide_url} target="_blank" icon={<LinkOutlined />}>
                统一 MD 文档
              </Button>
              <Button href={connection.openapi_url} target="_blank">
                OpenAPI JSON
              </Button>
            </Space>
          </Card>
        </Col>
        <Col xs={24} xl={10}>
          <Card title="调用方式" className="section-card">
            <pre className="code-block">POST /api/tools/工具名</pre>
            <Paragraph>
              使用 <Text code>Authorization: Bearer &lt;Token&gt;</Text> 和{' '}
              <Text code>Content-Type: application/json</Text>，请求体直接填写工具参数。
            </Paragraph>
            <Paragraph>
              从 <Text code>GET /api/tools</Text> 获取 {connection.tool_count}{' '}
              项能力和参数。成功返回 <Text code>status: succeeded</Text>，结果在{' '}
              <Text code>data</Text>；失败检查 <Text code>error</Text>。
            </Paragraph>
            <Text type="secondary">
              操作返回 operation_id，可查询执行结果。客户端超时后先确认状态，再决定是否重试。
            </Text>
          </Card>
        </Col>
      </Row>
      <Card title="快速开始 · 创建浏览器实例" className="section-card">
        <Tabs
          items={[
            { key: 'curl', label: 'cURL', source: curl },
            { key: 'python', label: 'Python', source: python },
            { key: 'js', label: 'JavaScript', source: js },
          ].map(({ key, label, source }) => ({
            key,
            label,
            children: (
              <>
                <pre className="code-block">{source}</pre>
                <Button icon={<CopyOutlined />} onClick={() => onCopy(source)}>
                  复制 {label} 示例
                </Button>
              </>
            ),
          }))}
        />
        <Paragraph className="field-spaced" type="secondary">
          创建后取 data.instance_id，再调用 navigate、screenshot 等接口。完成后调用
          close_instance；data.details_url 可查看直播、录屏、属性和日志。
        </Paragraph>
      </Card>
      <Card
        title={`接口参考 · ${tools.length || connection.tool_count} 项能力`}
        className="section-card"
        loading={loading}
      >
        {error ? (
          <Alert type="error" title={error} />
        ) : (
          <>
            <Space wrap style={{ marginBottom: 16 }}>
              <Input.Search
                aria-label="搜索 API"
                placeholder="搜索工具名称或用途"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                allowClear
              />
              <Select
                aria-label="选择 API"
                style={{ width: 280, maxWidth: '100%' }}
                value={selected}
                onChange={setSelected}
                showSearch
                optionFilterProp="label"
                options={tools
                  .filter((item) =>
                    `${item.name} ${item.description}`.toLowerCase().includes(query.toLowerCase()),
                  )
                  .map((item) => ({ value: item.name, label: item.name }))}
              />
            </Space>
            {tool && (
              <>
                <Paragraph>
                  <Tag color="blue">POST</Tag>
                  <Text code>{`/api/tools/${tool.name}`}</Text>
                </Paragraph>
                <Paragraph>{tool.description}</Paragraph>
                <Table
                  size="small"
                  rowKey="name"
                  pagination={false}
                  scroll={{ x: 600 }}
                  dataSource={params}
                  columns={[
                    {
                      title: '参数',
                      dataIndex: 'name',
                      render: (name) => <Text code>{name}</Text>,
                    },
                    {
                      title: '必填',
                      dataIndex: 'required',
                      render: (value) => (value ? <Tag color="orange">必填</Tag> : '可选'),
                    },
                    {
                      title: '类型 / 约束',
                      dataIndex: 'schema',
                      render: (schema) => (
                        <Text>
                          {schema.type ?? (schema.$ref ? '参见完整 Schema' : '复合类型')}
                          {schema.enum ? ` · ${schema.enum.join(' / ')}` : ''}
                          {schema.default !== undefined
                            ? ` · 默认 ${JSON.stringify(schema.default)}`
                            : ''}
                        </Text>
                      ),
                    },
                    {
                      title: '说明',
                      dataIndex: 'schema',
                      render: (schema) => schema.description || '详见统一 MD 文档与参数 Schema',
                    },
                  ]}
                />
                <details className="field-spaced">
                  <summary>完整参数 Schema</summary>
                  <pre className="code-block">{JSON.stringify(tool.inputSchema, null, 2)}</pre>
                </details>
              </>
            )}
          </>
        )}
      </Card>
    </Space>
  );
}
