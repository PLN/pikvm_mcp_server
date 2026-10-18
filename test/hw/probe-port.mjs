// Modified 2026-10 by PLN: reject fetch bad ports (GPL-3.0; see NOTICE).

/**
 * Closed-port probe for the read-only hardware check.
 * The default port is 65000. 0 and skip disable the probe.
 * Ports on the Fetch bad-port list are rejected here because fetch
 * refuses them before a connection. The set matches Node's fetch
 * (undici) block list, including the Fetch standard ports.
 */

const FETCH_BAD_PORTS = new Set([
  '1', '7', '9', '11', '13', '15', '17', '19', '20', '21', '22', '23', '25', '37', '42', '43', '53', '69', '77', '79',
  '87', '95', '101', '102', '103', '104', '109', '110', '111', '113', '115', '117', '119', '123', '135', '137',
  '139', '143', '161', '179', '389', '427', '465', '512', '513', '514', '515', '526', '530', '531', '532',
  '540', '548', '554', '556', '563', '587', '601', '636', '989', '990', '993', '995', '1719', '1720', '1723',
  '2049', '3659', '4045', '4190', '5060', '5061', '6000', '6566', '6665', '6666', '6667', '6668', '6669', '6679',
  '6697', '10080',
]);

export function unreachableProbePort(raw) {
  if (raw === '0' || raw === 'skip') {
    return { skip: true, reason: 'PIKVM_HW_TEST_UNREACHABLE_PORT disables the closed-port probe' };
  }
  const port = raw === undefined || raw === '' ? 65000 : Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PIKVM_HW_TEST_UNREACHABLE_PORT must be a port, 0, or skip');
  }
  if (FETCH_BAD_PORTS.has(String(port))) {
    throw new Error(
      `PIKVM_HW_TEST_UNREACHABLE_PORT=${port} is on the fetch bad-port list and is refused before a connection`,
    );
  }
  return { skip: false, port };
}
