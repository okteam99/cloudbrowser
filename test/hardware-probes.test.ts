import test from 'node:test';
import assert from 'node:assert/strict';
import { collectHardware } from '../web/hardware-probes.js';

test('hardware collection reads only allowed passive metadata and distinguishes unsupported, blocked and empty results', async () => {
  const forbidden: string[] = [];
  const deny = (name: string) => () => {
    forbidden.push(name);
    throw new Error(name);
  };
  let audioClosed = false;
  const n = {
    bluetooth: {
      getAvailability: async () => false,
      getDevices: async () => [],
      requestDevice: deny('bluetooth.requestDevice'),
      requestLEScan: deny('bluetooth.requestLEScan'),
    },
    usb: {
      getDevices: async () => [
        {
          vendorId: 123,
          productId: 456,
          productName: 'Authorized device',
          serialNumber: 'authorized-only',
          open: deny('usb.open'),
        },
      ],
      requestDevice: deny('usb.requestDevice'),
    },
    hid: {
      getDevices: async () => {
        throw new DOMException('blocked by policy', 'SecurityError');
      },
      requestDevice: deny('hid.requestDevice'),
    },
    serial: { getPorts: async () => [], requestPort: deny('serial.requestPort') },
    mediaDevices: {
      enumerateDevices: async () => [{ kind: 'audioinput', label: '', deviceId: '', groupId: '' }],
      getUserMedia: deny('getUserMedia'),
    },
    getGamepads: () => [
      null,
      {
        id: 'Gamepad',
        index: 1,
        mapping: 'standard',
        connected: true,
        axes: [0, 1],
        buttons: [{ pressed: true }],
      },
    ],
    requestMIDIAccess: deny('requestMIDIAccess'),
    gpu: { requestAdapter: async () => null },
    permissions: {
      query: async ({ name }: { name: string }) => ({
        state: name === 'camera' ? 'prompt' : 'denied',
      }),
    },
  };
  const scope = {
    AudioContext: class {
      sampleRate = 48000;
      state = 'suspended';
      destination = { maxChannelCount: 2, channelCount: 2 };
      close() {
        audioClosed = true;
      }
    },
    Accelerometer: class {
      constructor() {
        forbidden.push('sensor.start');
      }
    },
    document: { visibilityState: 'visible' },
  };
  const report = await collectHardware(n, scope);
  assert.deepEqual(forbidden, []);
  assert.equal(audioClosed, true);
  assert.equal(report.bluetooth.api_supported, true);
  assert.deepEqual(report.bluetooth.availability, { status: 'reported', value: false });
  assert.deepEqual(report.bluetooth.granted_devices.value, {
    count: 0,
    truncated: false,
    devices: [],
  });
  assert.equal(report.hid.granted_devices.status, 'blocked');
  assert.equal((report.media_devices.enumeration.value as any).devices[0].label, null);
  assert.equal(
    (report.usb.granted_devices.value as any).devices[0].serial_number,
    'authorized-only',
  );
  assert.equal((report.audio_output.parameters.value as any).sample_rate, 48000);
  assert.equal((report.permissions.camera.value as any).state, 'prompt');
  assert.equal(report.sensors.constructors.Accelerometer, true);
  assert.ok(!JSON.stringify(report.gamepads).includes('pressed'));
  const absent = await collectHardware({}, {});
  assert.equal(absent.bluetooth.api_supported, false);
  assert.equal(absent.bluetooth.availability.status, 'unsupported');
  assert.equal(absent.media_devices.enumeration.status, 'unsupported');
  assert.equal(absent.audio_output.parameters.status, 'unsupported');
  assert.equal(absent.sensors.constructors.Accelerometer, false);
  const timeout = await collectHardware(
    { bluetooth: { getAvailability: () => new Promise(() => {}) } },
    {},
  );
  assert.equal(timeout.bluetooth.availability.status, 'timeout');
  assert.equal(timeout.bluetooth.availability.value, undefined);
});
