import type { userAgentMetadata } from './user-agent.js';
import type { AppliedDeviceProfile } from './device-profile.js';
import type { DeviceVerification } from './device-verification.js';

export type BrowserEnvironment = {
  captured_at: string;
  user_agent: string | null;
  browser_version?: string;
  browser_mode?: string;
  user_agent_metadata?: ReturnType<typeof userAgentMetadata> | null;
  device_profile?: AppliedDeviceProfile | null;
  device_profile_id?: string | null;
  device_profile_source?: string;
  device_verification?: DeviceVerification | null;
  os: string | null;
  country: string | null;
  country_source: 'proxy_config' | 'unknown';
  egress: {
    ip: string | null;
    source: 'unknown' | 'proxy_check' | 'instance_check';
    checked_at: string | null;
  };
};

// This describes the identity advertised by the UA, not the server's operating system.
export function operatingSystem(ua: string | null): string | null {
  if (!ua) return null;
  if (/Android/i.test(ua)) return 'Android';
  if (/(iPhone|iPad|iPod)/i.test(ua)) return 'iOS';
  if (/Windows (NT|Phone)/i.test(ua)) return 'Windows';
  if (/CrOS/i.test(ua)) return 'ChromeOS';
  if (/(Macintosh|Mac OS X)/i.test(ua)) return 'macOS';
  if (/Linux/i.test(ua)) return 'Linux';
  return null;
}
