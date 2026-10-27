import { navigatorInfo } from './fingerprint-probes.js';
void navigatorInfo(navigator)
  .then((value) => self.postMessage(value))
  .catch(() => self.postMessage({ error: 'Worker 信息读取失败' }));
