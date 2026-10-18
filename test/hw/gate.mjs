// Modified 2026-10 by PLN: hardware suite device gate (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: registry devices must set hwTest (GPL-3.0; see NOTICE).

/**
 * Which device the hardware suite may talk to.
 *
 * With no registry, only the legacy name "default" is accepted.
 * With a registry, the name must be a device whose hwTest is true.
 * hwSkipReason stays the unset check, so a process with no
 * PIKVM_HW_TEST_DEVICE still skips before any socket.
 */

import { loadDeviceRegistry } from '../../dist/registry.js';

export function hwSkipReason() {
  const name = process.env.PIKVM_HW_TEST_DEVICE;
  if (name === undefined || name === '') return 'PIKVM_HW_TEST_DEVICE is unset';
  return false;
}

export function hwDeviceRequest(env = process.env) {
  const name = env.PIKVM_HW_TEST_DEVICE;
  if (name === undefined || name === '') {
    return { skip: true, name: '' };
  }
  const registry = loadDeviceRegistry(env);
  if (!registry) {
    if (name !== 'default') {
      throw new Error(
        `PIKVM_HW_TEST_DEVICE=${JSON.stringify(name)} is refused. `
        + 'Only "default" is accepted until the device registry exists (Phase B item 10).',
      );
    }
    return { skip: false, name };
  }
  const device = registry.devices.get(name);
  if (!device) {
    const known = [...registry.devices.keys()].sort().join(', ');
    throw new Error(
      `PIKVM_HW_TEST_DEVICE=${JSON.stringify(name)} is not in the registry. Known devices: ${known}`,
    );
  }
  if (device.hwTest !== true) {
    throw new Error(
      `PIKVM_HW_TEST_DEVICE=${JSON.stringify(name)} is refused. Set hwTest true on that device.`,
    );
  }
  return { skip: false, name };
}
