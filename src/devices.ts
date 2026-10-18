// Modified 2026-10 by PLN: per-device client, lock, and arm (GPL-3.0; see NOTICE).

/**
 * One PiKVMClient, BusyLock, and arm state per registry device.
 * The environment arm flags are a ceiling. A device flag can only narrow it.
 * Omitted device flags leave the ceiling as it is.
 */

import type { Config } from './config.js';
import { BusyLock } from './pikvm/lock.js';
import { PiKVMClient } from './pikvm/client.js';
import type { DeviceRegistry } from './registry.js';
import type { TlsMode } from './tls.js';

export interface FleetDevice {
  name: string;
  host: string;
  client: PiKVMClient;
  lock: BusyLock;
  /** Ceiling and the device flag. False when either side disarms. */
  armHid: boolean;
  armMsd: boolean;
  msdLocalDir?: string;
  hwTest: boolean;
  tlsMode: TlsMode;
}

export interface Fleet {
  /** False for the single legacy device. Tool text then stays unchanged. */
  registryActive: boolean;
  defaultName: string;
  devices: Map<string, FleetDevice>;
  passwords: readonly string[];
}

export interface FleetCeiling {
  hid: boolean;
  msd: boolean;
}

export function buildFleet(config: Config, ceiling: FleetCeiling): Fleet {
  const registry: DeviceRegistry | undefined = config.registry;
  if (!registry) throw new Error('buildFleet requires a device registry');
  const devices = new Map<string, FleetDevice>();
  const passwords: string[] = [];
  for (const [name, device] of registry.devices) {
    const client = new PiKVMClient({
      host: device.host,
      username: device.username,
      password: device.password,
      verifySsl: device.tls.mode === 'verify',
      tls: { default: device.tls },
      defaultKeymap: config.pikvm.defaultKeymap,
      requestTimeoutMs: config.pikvm.requestTimeoutMs,
      msdJobTimeoutMs: config.pikvm.msdJobTimeoutMs,
      msdIdleTimeoutMs: config.pikvm.msdIdleTimeoutMs,
    });
    passwords.push(device.password);
    devices.set(name, {
      name,
      host: device.host,
      client,
      lock: new BusyLock(),
      armHid: ceiling.hid && device.armHid !== false,
      armMsd: ceiling.msd && device.armMsd !== false,
      msdLocalDir: device.msdLocalDir,
      hwTest: device.hwTest,
      tlsMode: device.tls.mode,
    });
  }
  return {
    registryActive: true,
    defaultName: registry.defaultName,
    devices,
    passwords,
  };
}

export function resolveFleetDevice(args: { device?: unknown }, fleet: Fleet): FleetDevice {
  const requested = args.device;
  const name = requested === undefined ? fleet.defaultName : requested;
  if (typeof name !== 'string' || !fleet.devices.has(name)) {
    const known = [...fleet.devices.keys()].sort().join(', ');
    const shown = typeof name === 'string' ? JSON.stringify(name) : typeof name;
    throw new Error(`unknown device ${shown}. Known devices: ${known}`);
  }
  return fleet.devices.get(name) as FleetDevice;
}

export async function closeFleet(fleet: Fleet): Promise<void> {
  for (const device of fleet.devices.values()) {
    await device.client.close();
  }
}
