// Modified 2026-10 by PLN: hardware suite device gate (GPL-3.0; see NOTICE).

/**
 * Which device the hardware suite may talk to.
 *
 * TODO(registry): Phase B item 10 replaces this with the device registry
 * (PIKVM_DEVICES_FILE / PIKVM_DEVICES). Until that exists, resolveDevice
 * is the single-device stub and only the legacy name "default" is accepted.
 * Credentials stay the legacy PIKVM_HOST / PIKVM_USERNAME / PIKVM_PASSWORD
 * variables. This module does not open a socket.
 */

export function hwSkipReason() {
  const name = process.env.PIKVM_HW_TEST_DEVICE;
  if (name === undefined || name === '') return 'PIKVM_HW_TEST_DEVICE is unset';
  return false;
}

export function hwDeviceRequest() {
  const name = process.env.PIKVM_HW_TEST_DEVICE;
  if (name === undefined || name === '') {
    return { skip: true, name: '' };
  }
  if (name !== 'default') {
    throw new Error(
      `PIKVM_HW_TEST_DEVICE=${JSON.stringify(name)} is refused. `
      + 'Only "default" is accepted until the device registry exists (Phase B item 10).',
    );
  }
  return { skip: false, name };
}
