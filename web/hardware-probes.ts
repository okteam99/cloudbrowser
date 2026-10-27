type Observation = {
  status: 'reported' | 'unsupported' | 'blocked' | 'timeout' | 'unavailable';
  value?: unknown;
  error?: string;
  error_name?: string;
};
async function observe(
  supported: boolean,
  read: () => unknown | Promise<unknown>,
  timeout = 2000,
): Promise<Observation> {
  if (!supported) return { status: 'unsupported' };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      Promise.resolve().then(read),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const e = new Error('读取超时');
          e.name = 'TimeoutError';
          reject(e);
        }, timeout);
      }),
    ]);
    return { status: 'reported', value };
  } catch (error) {
    const e = error as Error;
    return {
      status:
        e?.name === 'TimeoutError'
          ? 'timeout'
          : ['NotAllowedError', 'SecurityError'].includes(e?.name)
            ? 'blocked'
            : 'unavailable',
      error_name: e?.name ?? 'Error',
      error: String(e?.message ?? error).slice(0, 500),
    };
  } finally {
    clearTimeout(timer);
  }
}
const method = (api: any, name: string) => typeof api?.[name] === 'function';
const items = (devices: any[], map: (item: any) => unknown) => ({
  count: devices.length,
  truncated: devices.length > 100,
  devices: devices.slice(0, 100).map(map),
});

// Passive reads only: no requestDevice/requestPort/getUserMedia, connections,
// sensor activation, MIDI access, device transfers or audible output.
export async function collectHardware(n: any = navigator, scope: any = globalThis) {
  const [
    bluetoothAvailability,
    bluetoothDevices,
    media,
    usb,
    hid,
    serial,
    gamepads,
    audioOutput,
    webgpu,
    permissions,
  ] = await Promise.all([
    observe(method(n.bluetooth, 'getAvailability'), () => n.bluetooth.getAvailability()),
    observe(method(n.bluetooth, 'getDevices'), async () =>
      items(await n.bluetooth.getDevices(), (d) => ({
        id: d.id,
        name: d.name ?? null,
        gatt_connected: d.gatt?.connected ?? null,
      })),
    ),
    observe(method(n.mediaDevices, 'enumerateDevices'), async () =>
      items(await n.mediaDevices.enumerateDevices(), (d) => ({
        kind: d.kind,
        label: d.label || null,
        device_id: d.deviceId || null,
        group_id: d.groupId || null,
      })),
    ),
    observe(method(n.usb, 'getDevices'), async () =>
      items(await n.usb.getDevices(), (d) => ({
        vendor_id: d.vendorId,
        product_id: d.productId,
        manufacturer: d.manufacturerName ?? null,
        product_name: d.productName ?? null,
        serial_number: d.serialNumber ?? null,
        usb_version: [d.usbVersionMajor, d.usbVersionMinor, d.usbVersionSubminor],
        device_version: [d.deviceVersionMajor, d.deviceVersionMinor, d.deviceVersionSubminor],
        device_class: d.deviceClass,
        device_subclass: d.deviceSubclass,
        opened: d.opened,
      })),
    ),
    observe(method(n.hid, 'getDevices'), async () =>
      items(await n.hid.getDevices(), (d) => ({
        vendor_id: d.vendorId,
        product_id: d.productId,
        product_name: d.productName,
        opened: d.opened,
        collections: (d.collections ?? [])
          .slice(0, 100)
          .map((c: any) => ({ usage_page: c.usagePage, usage: c.usage, type: c.type })),
      })),
    ),
    observe(method(n.serial, 'getPorts'), async () =>
      items(await n.serial.getPorts(), (p) => ({
        info: p.getInfo(),
        connected: p.connected ?? null,
      })),
    ),
    observe(method(n, 'getGamepads'), () =>
      items([...n.getGamepads()].filter(Boolean), (g) => ({
        id: g.id,
        index: g.index,
        connected: g.connected,
        mapping: g.mapping,
        axes_count: g.axes.length,
        button_count: g.buttons.length,
        vibration_actuator_type: g.vibrationActuator?.type ?? null,
      })),
    ),
    observe(typeof scope.AudioContext === 'function', async () => {
      const context = new scope.AudioContext();
      try {
        return {
          sample_rate: context.sampleRate,
          state: context.state,
          base_latency_seconds: context.baseLatency ?? null,
          output_latency_seconds: context.outputLatency ?? null,
          max_channels: context.destination.maxChannelCount,
          channel_count: context.destination.channelCount,
          audible_output: false,
        };
      } finally {
        await context.close();
      }
    }),
    observe(method(n.gpu, 'requestAdapter'), async () => {
      const adapter = await n.gpu.requestAdapter();
      if (!adapter) return { adapter_available: false };
      const info =
        adapter.info ??
        (method(adapter, 'requestAdapterInfo') ? await adapter.requestAdapterInfo() : {});
      return {
        adapter_available: true,
        vendor: info.vendor ?? null,
        architecture: info.architecture ?? null,
        device: info.device ?? null,
        description: info.description ?? null,
        fallback_adapter: info.isFallbackAdapter ?? adapter.isFallbackAdapter ?? null,
        features: [...adapter.features],
        limits: Object.fromEntries(
          [
            'maxTextureDimension2D',
            'maxBufferSize',
            'maxBindGroups',
            'maxStorageBufferBindingSize',
            'maxComputeWorkgroupSizeX',
          ].map((k) => [k, adapter.limits[k] ?? null]),
        ),
      };
    }),
    Promise.all(
      [
        'camera',
        'microphone',
        'speaker-selection',
        'geolocation',
        'accelerometer',
        'gyroscope',
        'magnetometer',
        'ambient-light-sensor',
        'midi',
      ].map(async (name) => [
        name,
        await observe(method(n.permissions, 'query'), async () => ({
          state: (await n.permissions.query({ name })).state,
        })),
      ]),
    ).then((entries) => Object.fromEntries(entries)),
  ]);
  return {
    collection_mode: 'passive_no_permission_prompts',
    page_visibility: scope.document?.visibilityState ?? null,
    bluetooth: {
      api_supported: !!n.bluetooth,
      availability: bluetoothAvailability,
      granted_devices: bluetoothDevices,
      note: '可用状态是浏览器报告，不等于证明蓝牙芯片存在或开启；只列出本站已获授权设备，不扫描周边、不连接设备，不读取蓝牙 MAC。',
    },
    media_devices: {
      api_supported: !!n.mediaDevices,
      enumeration: media,
      note: '不调用 getUserMedia。未授权或页面不可见时，列表、名称和 ID 可能为空或受限；空列表不能证明没有摄像头、麦克风或扬声器。设备 ID 可能随网站和会话变化。',
    },
    usb: {
      api_supported: !!n.usb,
      granted_devices: usb,
      note: '只查询浏览器允许本站访问的设备，不申请授权、不打开连接。空列表不代表电脑没有 USB 设备。',
    },
    hid: {
      api_supported: !!n.hid,
      granted_devices: hid,
      note: '只查询本站已授权设备；键鼠等受保护 HID 可能不向网页开放，不读取输入报告。',
    },
    serial: {
      api_supported: !!n.serial,
      granted_ports: serial,
      note: '只查询本站已授权端口，不打开串口、不读写设备。',
    },
    gamepads: {
      enumeration: gamepads,
      note: '浏览器可能要求用户先与手柄交互才公开列表；仅读取设备描述和按键数量，不记录按键状态。',
    },
    audio_output: {
      parameters: audioOutput,
      note: '只读取 AudioContext 默认处理参数后关闭；不播放声音，参数不保证等于声卡的全部硬件规格。',
    },
    webgpu: {
      adapter: webgpu,
      note: '只查询默认适配器，不创建 GPUDevice；浏览器可能隐藏型号，软件适配器不代表物理 GPU。',
    },
    sensors: {
      constructors: Object.fromEntries(
        [
          'Accelerometer',
          'LinearAccelerationSensor',
          'GravitySensor',
          'Gyroscope',
          'Magnetometer',
          'AbsoluteOrientationSensor',
          'RelativeOrientationSensor',
          'AmbientLightSensor',
          'DeviceMotionEvent',
          'DeviceOrientationEvent',
        ].map((name) => [name, typeof scope[name] === 'function']),
      ),
      motion_permission_request_supported: method(scope.DeviceMotionEvent, 'requestPermission'),
      orientation_permission_request_supported: method(
        scope.DeviceOrientationEvent,
        'requestPermission',
      ),
      nfc_api_supported: typeof scope.NDEFReader === 'function',
      midi_api_supported: method(n, 'requestMIDIAccess'),
      note: '仅显示 API 和权限状态，不启动传感器、NFC 扫描或 MIDI 访问；API 存在不等于传感器硬件存在。',
    },
    permissions,
  };
}
