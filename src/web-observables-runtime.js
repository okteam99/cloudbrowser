// @ts-nocheck
// Serialized into isolated page/worker realms. No module state, network access,
// hardware connection or expected fingerprint/hash substitution.
export function installWebObservables(config) {
  if (!config || !globalThis.navigator) return;
  const n = navigator,
    page = typeof document !== 'undefined';
  const clone = (value) => structuredClone(value);
  const getter = (target, key, value) => {
    if (!target) return;
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: true,
      get: typeof value === 'function' ? value : () => value,
    });
  };
  const remove = (target, key) => {
    for (let p = target; p; p = Object.getPrototypeOf(p)) {
      if (Object.hasOwn(p, key)) {
        if (Object.getOwnPropertyDescriptor(p, key)?.configurable) delete p[key];
        break;
      }
    }
  };
  const error = (name, message) =>
    ['TypeError', 'Error'].includes(name)
      ? new globalThis[name](message)
      : new DOMException(message, name);
  const ioError = () =>
    Promise.reject(
      error('NotSupportedError', 'Device I/O is unavailable in this simulated environment.'),
    );
  const result = (outcome, transform = clone) => {
    if (outcome.status === 'reported' || outcome.status === 'measured')
      return Promise.resolve(transform(outcome.value));
    return Promise.reject(
      error(outcome.error_name ?? 'NotSupportedError', outcome.error ?? 'API unavailable'),
    );
  };
  const fn = (target, key, implementation) => {
    if (!target) return;
    const callable = {
      [key](...args) {
        if (this !== target) throw new TypeError('Illegal invocation');
        return implementation(...args);
      },
    }[key];
    Object.defineProperty(callable, 'length', { value: implementation.length });
    Object.defineProperty(target, key, {
      value: callable,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  };
  const method = (target, key, outcome, transform) => {
    if (!outcome) return;
    if (outcome.status === 'unsupported') remove(target, key);
    else fn(target, key, () => result(outcome, transform));
  };
  const eventObject = (type, properties) => {
    const object = new EventTarget();
    if (globalThis[type]?.prototype) Object.setPrototypeOf(object, globalThis[type].prototype);
    Object.defineProperty(object, Symbol.toStringTag, { configurable: true, value: type });
    for (const [key, value] of Object.entries(properties)) getter(object, key, value);
    return object;
  };
  const eventProperty = (target, name) => {
    let callback = null;
    Object.defineProperty(target, 'on' + name, {
      configurable: true,
      enumerable: true,
      get: () => callback,
      set(value) {
        if (callback) target.removeEventListener(name, callback);
        callback = typeof value === 'function' ? value : null;
        if (callback) target.addEventListener(name, callback);
      },
    });
  };
  const policy = (feature) =>
    !page ||
    !document.permissionsPolicy?.allowsFeature ||
    document.permissionsPolicy.allowsFeature(feature);
  const secure = globalThis.isSecureContext !== false;
  const navProto = Object.getPrototypeOf(n);
  const ns = config.navigator ?? {};
  const navNames = {
    device_memory: 'deviceMemory',
    webdriver: 'webdriver',
    pdf_viewer_enabled: 'pdfViewerEnabled',
    max_touch_points: 'maxTouchPoints',
    vendor: 'vendor',
    product_sub: 'productSub',
  };
  for (const [key, field] of Object.entries(navNames)) {
    if (
      ns[key] !== undefined &&
      (page || field === 'deviceMemory') &&
      (field !== 'deviceMemory' || secure) &&
      n[field] !== ns[key]
    )
      getter(navProto, field, ns[key]);
  }
  if (config.connection !== undefined) {
    if (config.connection === null) remove(n, 'connection');
    else {
      const c = config.connection;
      const values = {
        effectiveType: c.effective_type,
        downlink: c.downlink,
        rtt: c.rtt,
        saveData: c.save_data,
      };
      // Accessing the native Worker connection getter before startup can crash Blink.
      const info = (page ? n.connection : undefined) ?? eventObject('NetworkInformation', {});
      for (const [key, value] of Object.entries(values)) getter(info, key, value);
      if (c.type !== null) getter(info, 'type', c.type);
      else remove(info, 'type');
      eventProperty(info, 'change');
      getter(navProto, 'connection', info);
    }
  }
  if (page && config.screen) {
    const s = config.screen,
      proto = Object.getPrototypeOf(screen);
    for (const [key, value] of Object.entries({
      availWidth: s.available_width,
      availHeight: s.available_height,
      colorDepth: s.color_depth,
      pixelDepth: s.pixel_depth,
    }))
      getter(proto, key, value);
    getter(screen.orientation, 'type', s.orientation);
    getter(screen.orientation, 'angle', s.orientation_angle);
  }
  if (page && config.window) {
    getter(globalThis, 'outerWidth', config.window.outer_width);
    getter(globalThis, 'outerHeight', config.window.outer_height);
  }
  if (page && config.battery && secure) {
    let battery;
    method(n, 'getBattery', config.battery, (v) => {
      if (!battery) {
        battery = eventObject('BatteryManager', {
          charging: v.charging,
          level: v.level,
          chargingTime: v.charging_time ?? Infinity,
          dischargingTime: v.discharging_time ?? Infinity,
        });
        for (const event of [
          'chargingchange',
          'levelchange',
          'chargingtimechange',
          'dischargingtimechange',
        ])
          eventProperty(battery, event);
      }
      return battery;
    });
  }
  const hw = config.hardware ?? {};
  const api = (name, type, definition, windowOnly = true) => {
    if (!definition || (windowOnly && !page)) return null;
    if (!page && !(name in n)) return null;
    if (!definition.api_supported || !secure) {
      remove(n, name);
      return null;
    }
    const object = n[name] ?? eventObject(type, {});
    getter(navProto, name, object);
    return object;
  };
  const bluetooth = api('bluetooth', 'Bluetooth', hw.bluetooth);
  if (bluetooth) {
    method(bluetooth, 'getAvailability', hw.bluetooth.availability);
    if (hw.bluetooth.availability && hw.bluetooth.availability.status !== 'unsupported')
      fn(bluetooth, 'getAvailability', () =>
        policy('bluetooth') ? result(hw.bluetooth.availability) : Promise.resolve(false),
      );
    method(bluetooth, 'getDevices', hw.bluetooth.granted_devices, (v) =>
      v.devices.map((d) => {
        const gatt = eventObject('BluetoothRemoteGATTServer', {
          connected: d.gatt_connected ?? false,
        });
        fn(gatt, 'connect', ioError);
        fn(gatt, 'disconnect', () => {});
        const device = eventObject('BluetoothDevice', {
          id: d.id,
          name: d.name ?? undefined,
          gatt,
        });
        getter(gatt, 'device', device);
        eventProperty(device, 'gattserverdisconnected');
        return device;
      }),
    );
    fn(bluetooth, 'requestDevice', ioError);
    if ('requestLEScan' in bluetooth) fn(bluetooth, 'requestLEScan', ioError);
    eventProperty(bluetooth, 'availabilitychanged');
  }
  const originalMedia = n.mediaDevices;
  const originalConstraints = originalMedia?.getSupportedConstraints?.bind(originalMedia);
  const media = api('mediaDevices', 'MediaDevices', hw.media_devices);
  if (media) {
    method(media, 'enumerateDevices', hw.media_devices.enumeration, (v) =>
      v.devices
        .filter((d) =>
          policy(
            d.kind === 'audioinput'
              ? 'microphone'
              : d.kind === 'videoinput'
                ? 'camera'
                : 'speaker-selection',
          ),
        )
        .map((d) => {
          const props = {
            deviceId: d.device_id ?? '',
            groupId: d.group_id ?? '',
            kind: d.kind,
            label: d.label ?? '',
          };
          const type = d.kind === 'audiooutput' ? 'MediaDeviceInfo' : 'InputDeviceInfo';
          const item = Object.create(
            globalThis[type]?.prototype ??
              globalThis.MediaDeviceInfo?.prototype ??
              Object.prototype,
          );
          for (const [key, value] of Object.entries(props)) getter(item, key, value);
          Object.defineProperty(item, Symbol.toStringTag, { value: type });
          fn(item, 'toJSON', () => ({ ...props }));
          if (type === 'InputDeviceInfo') fn(item, 'getCapabilities', () => ({}));
          return item;
        }),
    );
    for (const name of ['getUserMedia', 'getDisplayMedia', 'selectAudioOutput'])
      fn(media, name, ioError);
    if (originalConstraints) fn(media, 'getSupportedConstraints', originalConstraints);
    eventProperty(media, 'devicechange');
  }
  for (const [name, type, methodName, resultName, listKey] of [
    ['usb', 'USB', 'getDevices', 'granted_devices', 'devices'],
    ['hid', 'HID', 'getDevices', 'granted_devices', 'devices'],
    ['serial', 'Serial', 'getPorts', 'granted_ports', 'devices'],
  ]) {
    const object = api(name, type, hw[name], false);
    if (!object) continue;
    method(object, methodName, hw[name][resultName], (v) =>
      v[listKey].map((d) => {
        const device = eventObject(
          name === 'usb' ? 'USBDevice' : name === 'hid' ? 'HIDDevice' : 'SerialPort',
          {},
        );
        if (name === 'serial') {
          fn(device, 'getInfo', () => clone(d.info));
          getter(device, 'connected', d.connected ?? undefined);
        } else
          for (const [key, value] of Object.entries({
            vendorId: d.vendor_id,
            productId: d.product_id,
            productName: d.product_name,
            manufacturerName: d.manufacturer,
            serialNumber: d.serial_number,
            opened: d.opened ?? false,
          }))
            if (value !== undefined) getter(device, key, value);
        if (name === 'usb') {
          for (const [key, value] of Object.entries({
            usbVersionMajor: d.usb_version?.[0],
            usbVersionMinor: d.usb_version?.[1],
            usbVersionSubminor: d.usb_version?.[2],
            deviceVersionMajor: d.device_version?.[0],
            deviceVersionMinor: d.device_version?.[1],
            deviceVersionSubminor: d.device_version?.[2],
            deviceClass: d.device_class,
            deviceSubclass: d.device_subclass,
          }))
            getter(device, key, value);
        }
        if (name === 'hid')
          getter(device, 'collections', () =>
            (d.collections ?? []).map((c) => ({
              usagePage: c.usage_page,
              usage: c.usage,
              type: c.type,
            })),
          );
        for (const operation of [
          'open',
          'close',
          'transferIn',
          'transferOut',
          'sendReport',
          'sendFeatureReport',
          'receiveFeatureReport',
          'selectConfiguration',
          'claimInterface',
        ])
          fn(device, operation, ioError);
        return device;
      }),
    );
    fn(object, name === 'serial' ? 'requestPort' : 'requestDevice', ioError);
    eventProperty(object, 'connect');
    eventProperty(object, 'disconnect');
  }
  if (page && hw.gamepads?.enumeration) {
    const entry = hw.gamepads.enumeration;
    if (entry.status === 'unsupported') remove(n, 'getGamepads');
    else
      fn(n, 'getGamepads', () => {
        if (!['reported', 'measured'].includes(entry.status))
          throw error(entry.error_name, entry.error);
        const pads = [null, null, null, null];
        for (const d of entry.value.devices)
          pads[d.index] = eventObject('Gamepad', {
            id: d.id,
            index: d.index,
            connected: d.connected,
            mapping: d.mapping,
            timestamp: 0,
            axes: new Array(d.axes_count).fill(0),
            buttons: Array.from({ length: d.button_count }, () => ({
              pressed: false,
              touched: false,
              value: 0,
            })),
          });
        return pads;
      });
  }
  if (hw.permissions && n.permissions) {
    const original = n.permissions.query.bind(n.permissions);
    fn(n.permissions, 'query', (descriptor) => {
      if (!descriptor || typeof descriptor.name !== 'string') return original(descriptor);
      const configured = hw.permissions[descriptor.name];
      if (!configured || Object.keys(descriptor).some((k) => k !== 'name' && descriptor[k]))
        return original(descriptor);
      if (configured.status === 'unsupported')
        return Promise.reject(new TypeError(`Unsupported permission: ${descriptor.name}`));
      return result(configured, (v) => {
        const status = eventObject('PermissionStatus', { state: v.state, name: descriptor.name });
        eventProperty(status, 'change');
        return status;
      });
    });
  }
  if (page && hw.audio_output?.parameters?.value && typeof AudioContext === 'function') {
    const a = hw.audio_output.parameters.value,
      Native = AudioContext;
    const Wrapped = new Proxy(Native, {
      construct(target, args, newTarget) {
        const options = {
          ...(args[0] ?? {}),
          sampleRate: args[0]?.sampleRate ?? a.sample_rate,
          sinkId: { type: 'none' },
        };
        const context = Reflect.construct(target, [options], newTarget);
        if (a.state === 'suspended' && context.state === 'running') {
          const state = Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, 'state').get;
          const resume = context.resume.bind(context),
            close = context.close.bind(context);
          let initial = true;
          const suspended = context
            .suspend()
            .catch(() => {})
            .finally(() => {
              initial = false;
            });
          getter(context, 'state', () => (initial ? 'suspended' : state.call(context)));
          fn(context, 'resume', () => suspended.then(() => resume()));
          fn(context, 'close', () => {
            initial = false;
            return close();
          });
        }
        if (!args[0]?.sampleRate) {
          if (a.base_latency_seconds !== null)
            getter(context, 'baseLatency', a.base_latency_seconds);
          if (a.output_latency_seconds !== null)
            getter(context, 'outputLatency', a.output_latency_seconds);
          getter(context.destination, 'maxChannelCount', a.max_channels);
        }
        if (typeof context.setSinkId === 'function') fn(context, 'setSinkId', ioError);
        return context;
      },
    });
    Object.defineProperty(globalThis, 'AudioContext', {
      value: Wrapped,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(Native.prototype, 'constructor', {
      value: Wrapped,
      writable: true,
      configurable: true,
    });
    if (globalThis.webkitAudioContext === Native)
      Object.defineProperty(globalThis, 'webkitAudioContext', {
        value: Wrapped,
        writable: true,
        configurable: true,
      });
  }
  if (page && config.voices && globalThis.speechSynthesis) {
    const voices = config.voices.map((v) => {
      const voice = Object.create(globalThis.SpeechSynthesisVoice?.prototype ?? Object.prototype);
      for (const [key, value] of Object.entries({
        name: v.name,
        lang: v.lang,
        localService: v.local_service,
        default: v.default,
        voiceURI: v.name,
      }))
        getter(voice, key, value);
      return voice;
    });
    fn(speechSynthesis, 'getVoices', () => [...voices]);
    fn(speechSynthesis, 'speak', (utterance) => {
      queueMicrotask(() => {
        if (utterance?.dispatchEvent)
          utterance.dispatchEvent(
            new SpeechSynthesisErrorEvent('error', { utterance, error: 'synthesis-unavailable' }),
          );
      });
    });
  }
  if (page && config.web_share !== undefined) {
    if (!config.web_share || !secure) {
      remove(n, 'share');
      remove(n, 'canShare');
    } else {
      fn(
        n,
        'canShare',
        (data) =>
          !!data &&
          ['text', 'title', 'url', 'files'].some((k) => data[k] !== undefined) &&
          (!data.url ||
            (() => {
              try {
                return ['http:', 'https:'].includes(new URL(data.url, location.href).protocol);
              } catch {
                return false;
              }
            })()),
      );
      fn(n, 'share', () =>
        Promise.reject(error('AbortError', 'Share dismissed in this simulated environment.')),
      );
    }
  }
  if (page && hw.sensors) {
    for (const [name, supported] of Object.entries(hw.sensors.constructors)) {
      if (!supported) remove(globalThis, name);
      else if (!globalThis[name]) {
        const Type = {
          [name]: class extends EventTarget {
            constructor() {
              super();
              this.activated = false;
              this.hasReading = false;
              this.timestamp = null;
            }
            start() {
              queueMicrotask(() => this.dispatchEvent(new Event('error')));
            }
            stop() {}
          },
        }[name];
        Object.defineProperty(globalThis, name, {
          value: Type,
          writable: true,
          configurable: true,
        });
      }
      if (supported && globalThis[name]?.prototype?.start)
        Object.defineProperty(globalThis[name].prototype, 'start', {
          configurable: true,
          value() {
            queueMicrotask(() => {
              try {
                this.dispatchEvent(new Event('error'));
              } catch {}
            });
          },
        });
    }
    for (const [name, key] of [
      ['DeviceMotionEvent', 'motion_permission_request_supported'],
      ['DeviceOrientationEvent', 'orientation_permission_request_supported'],
    ]) {
      if (globalThis[name] && hw.sensors[key])
        fn(globalThis[name], 'requestPermission', () =>
          n.userActivation?.isActive
            ? Promise.resolve('granted')
            : Promise.reject(error('NotAllowedError', 'A user gesture is required.')),
        );
      else if (globalThis[name]) remove(globalThis[name], 'requestPermission');
    }
    if (!hw.sensors.nfc_api_supported) remove(globalThis, 'NDEFReader');
    if (!hw.sensors.midi_api_supported) remove(n, 'requestMIDIAccess');
    else fn(n, 'requestMIDIAccess', ioError);
  }
  for (const [type, declaration] of [
    ['WebGLRenderingContext', config.webgl],
    ['WebGL2RenderingContext', config.webgl2],
  ]) {
    const proto = globalThis[type]?.prototype;
    if (!proto || !declaration) continue;
    const original = proto.getParameter;
    const extensions = proto.getSupportedExtensions;
    const extension = proto.getExtension;
    Object.defineProperty(proto, 'getSupportedExtensions', {
      configurable: true,
      writable: true,
      value: function getSupportedExtensions() {
        const available = extensions.call(this);
        return available === null
          ? null
          : declaration.extensions.filter((name) => available.includes(name));
      },
    });
    Object.defineProperty(proto, 'getExtension', {
      configurable: true,
      writable: true,
      value: function getExtension(name) {
        const requested = String(name);
        if (
          !declaration.extensions.some((value) => value.toLowerCase() === requested.toLowerCase())
        )
          return null;
        return extension.call(this, requested);
      },
    });
    Object.defineProperty(proto, 'getParameter', {
      configurable: true,
      writable: true,
      value: function getParameter(parameter) {
        const value = original.call(this, parameter);
        const map = {
          7936: 'vendor',
          7937: 'renderer',
          7938: 'version',
          35724: 'shading_language_version',
          37445: 'unmasked_vendor',
          37446: 'unmasked_renderer',
        };
        if (parameter === 3379 && typeof value === 'number')
          return Math.min(value, declaration.max_texture_size);
        if (parameter === 34024 && typeof value === 'number')
          return Math.min(value, declaration.max_renderbuffer_size);
        if ((parameter === 37445 || parameter === 37446) && value === null) return null;
        return map[parameter] && declaration[map[parameter]] !== null
          ? declaration[map[parameter]]
          : value;
      },
    });
    // Expose only native-supported target extensions/limits. Rendering and
    // extension objects stay native; never fabricate a successful GPU operation.
  }
  if (hw.webgpu?.adapter && n.gpu) {
    const original = n.gpu.requestAdapter.bind(n.gpu),
      entry = hw.webgpu.adapter;
    fn(n.gpu, 'requestAdapter', async (options) => {
      if (!['reported', 'measured'].includes(entry.status)) return result(entry);
      if (entry.value.adapter_available === false) return null;
      const adapter = await original(options);
      if (!adapter) return null;
      const v = entry.value,
        info =
          adapter.info ?? Object.create(globalThis.GPUAdapterInfo?.prototype ?? Object.prototype);
      for (const key of ['vendor', 'architecture', 'device', 'description'])
        getter(info, key, v[key] ?? '');
      if (v.fallback_adapter !== undefined) getter(info, 'isFallbackAdapter', v.fallback_adapter);
      getter(adapter, 'info', info);
      if (Array.isArray(v.features)) {
        const native = adapter.features;
        const selected = new Set(v.features.filter((name) => native.has(name)));
        const features = Object.create(Object.getPrototypeOf(native));
        getter(features, 'size', () => selected.size);
        fn(features, 'has', (name) => selected.has(name));
        fn(features, 'keys', () => selected.keys());
        fn(features, 'values', () => selected.values());
        fn(features, 'entries', () => selected.entries());
        fn(features, 'forEach', (callback, thisArg) =>
          selected.forEach((value) => callback.call(thisArg, value, value, features)),
        );
        Object.defineProperty(features, Symbol.iterator, {
          configurable: true,
          value: () => selected.values(),
        });
        getter(adapter, 'features', features);
      }
      if (v.limits)
        for (const [key, maximum] of Object.entries(v.limits)) {
          if (typeof adapter.limits[key] === 'number' && typeof maximum === 'number')
            getter(adapter.limits, key, Math.min(adapter.limits[key], maximum));
        }
      return adapter;
    });
  }
}
