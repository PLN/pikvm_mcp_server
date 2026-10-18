// Modified 2026-10 by PLN: MSD mount and eject policy (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: expectImage, preflight, and MSD mutex (GPL-3.0; see NOTICE).

/**
 * Policy for MSD status, mount, and eject.
 * Plain kvmd calls stay on the client. Echo-back checks, preflight,
 * and mount rollback live here. Jobs and uploads are a later change.
 * Mount and eject share a per-device mutex so one session's rollback
 * cannot run in the middle of another's change. Job code can reuse
 * withMsdLock.
 */

import {
  KvmdError,
  type MsdDriveState,
  type MsdState,
  type PiKVMClient,
} from './pikvm/client.js';

export interface ResolvedDevice {
  name: string;
  client: PiKVMClient;
}

/**
 * Until the fleet registry exists, every MSD tool uses the one device.
 * `device` is accepted and ignored so later wiring stays mechanical.
 */
export function resolveDevice(
  _args: { device?: unknown },
  client: PiKVMClient,
): ResolvedDevice {
  return { name: 'default', client };
}

const msdLockTail = new Map<string, Promise<void>>();

/**
 * One MSD mutation at a time for a device. Separate from BusyLock, which
 * only covers auto-calibration and is not shared the same way across
 * HTTP sessions. The tail is the device key from resolveDevice.
 */
export function withMsdLock<T>(device: string, run: () => Promise<T>): Promise<T> {
  const previous = msdLockTail.get(device) ?? Promise.resolve();
  let settled!: Promise<void>;
  const runPromise = previous.then(run, run);
  settled = runPromise.then(() => {
    if (msdLockTail.get(device) === settled) msdLockTail.delete(device);
  }, () => {
    if (msdLockTail.get(device) === settled) msdLockTail.delete(device);
  });
  msdLockTail.set(device, settled);
  return runPromise;
}

export interface DriveSnapshot {
  image: string;
  cdrom: boolean;
  rw: boolean;
  connected: boolean;
}

export interface ErrorFields {
  status: number;
  type: string;
  message: string;
  endpoint: string;
}

/**
 * The drive is already connected and the caller did not name that image.
 * Mount must not disconnect it.
 */
export class MsdExpectImageError extends Error {
  readonly type = 'MsdExpectImageError';
  readonly image: string;

  constructor(image: string) {
    super(`drive is connected to ${JSON.stringify(image)}; expectImage must equal that name`);
    this.name = 'MsdExpectImageError';
    this.image = image;
  }
}

export interface EjectResult {
  drive: MsdDriveState | null;
  alreadyDisconnected: boolean;
}

export interface MountRequest {
  device: string;
  image: string;
  confirmImage: string;
  mode: 'cdrom' | 'flash';
  rw: boolean;
  connect: boolean;
  /** Required when the drive is already connected. Compared to the snapshot image. */
  expectImage?: string;
}

export interface MountSuccess {
  drive: MsdDriveState | null;
}

export interface MountFailure {
  error: ErrorFields;
  restored: MsdDriveState | null;
  /** Every rollback step that failed, in order. Omitted when rollback succeeded. */
  rollbackError?: ErrorFields[];
}

export type MountResult = MountSuccess | MountFailure;

/** Fields the status tool returns. `enabled` is not part of that result. */
export function publicMsdState(state: MsdState): Omit<MsdState, 'enabled'> {
  return {
    online: state.online,
    busy: state.busy,
    drive: state.drive,
    images: state.images,
    parts: state.parts,
    free: state.free,
    uploading: state.uploading,
    downloading: state.downloading,
  };
}

function imageName(drive: MsdDriveState | null): string {
  return drive?.image?.name ?? '';
}

function snapshotOf(drive: MsdDriveState | null): DriveSnapshot {
  return {
    image: imageName(drive),
    cdrom: drive?.cdrom === true,
    rw: drive?.rw === true,
    connected: drive?.connected === true,
  };
}

function errorFields(err: unknown): ErrorFields {
  if (err instanceof KvmdError) {
    return {
      status: err.status,
      type: err.type,
      message: err.message,
      endpoint: err.endpoint,
    };
  }
  if (err instanceof MsdExpectImageError) {
    return {
      status: 0,
      type: err.type,
      message: err.message,
      endpoint: '',
    };
  }
  return {
    status: 0,
    type: 'Error',
    message: err instanceof Error ? err.message : 'MSD operation failed',
    endpoint: '',
  };
}

function logImage(image: string): string {
  if (image.includes('/') || image.includes('\\') || image.includes('\0') || image.includes('://')) {
    return '';
  }
  return image;
}

function logMsd(event: string, device: string, image: string, ok: boolean, error?: string): void {
  const line: Record<string, unknown> = {
    event,
    device,
    image: logImage(image),
    ok,
  };
  if (error) line.error = error;
  console.error(JSON.stringify(line));
}

/**
 * Disconnect. kvmd raises MsdDisconnectedError when the drive is already
 * disconnected. That is success when a re-read shows connected === false.
 */
async function disconnect(client: PiKVMClient): Promise<void> {
  try {
    await client.msdSetConnected(false);
  } catch (err) {
    if (err instanceof KvmdError && err.type === 'MsdDisconnectedError') {
      const state = await client.getMsdState();
      if (state.drive == null || state.drive.connected === false) return;
    }
    throw err;
  }
}

/**
 * Restores the snapshot. An NBD or other URL selected as the drive image
 * cannot be restored: msdSetParams refuses any name containing '://' and
 * does not send it. That refusal is recorded with any later rollback
 * errors; the previous URL image stays unrestored.
 */
async function rollback(
  client: PiKVMClient,
  snap: DriveSnapshot,
): Promise<{ drive: MsdDriveState | null; rollbackError?: ErrorFields[] }> {
  const rollbackError: ErrorFields[] = [];
  const note = (err: unknown) => {
    rollbackError.push(errorFields(err));
  };
  try {
    await disconnect(client);
  } catch (err) {
    note(err);
  }
  if (snap.image.includes('://')) {
    note(new Error(
      `cannot restore snapshot image ${JSON.stringify(snap.image)}; msdSetParams refuses URLs`,
    ));
  } else {
    try {
      await client.msdSetParams({
        image: snap.image,
        cdrom: snap.cdrom,
        rw: snap.rw,
      });
    } catch (err) {
      note(err);
    }
  }
  if (snap.connected) {
    try {
      await client.msdSetConnected(true);
    } catch (err) {
      note(err);
    }
  }
  let drive: MsdDriveState | null = null;
  try {
    drive = (await client.getMsdState()).drive;
  } catch (err) {
    note(err);
  }
  return rollbackError.length > 0 ? { drive, rollbackError } : { drive };
}

async function ejectMsdLocked(
  client: PiKVMClient,
  expectImage: string,
  device: string,
): Promise<EjectResult> {
  const state = await client.getMsdState();
  const current = imageName(state.drive);
  if (current !== expectImage) {
    throw new Error(`expectImage mismatch: drive image is ${JSON.stringify(current)}`);
  }
  try {
    await client.msdSetConnected(false);
  } catch (err) {
    if (err instanceof KvmdError && err.type === 'MsdDisconnectedError') {
      const again = await client.getMsdState();
      if (again.drive == null || again.drive.connected === false) {
        logMsd('msd_eject', device, expectImage, true);
        return { drive: again.drive, alreadyDisconnected: true };
      }
    }
    logMsd('msd_eject', device, expectImage, false, errorFields(err).type);
    throw err;
  }
  const after = await client.getMsdState();
  logMsd('msd_eject', device, expectImage, true);
  return { drive: after.drive, alreadyDisconnected: false };
}

export function ejectMsd(
  client: PiKVMClient,
  expectImage: string,
  device: string,
): Promise<EjectResult> {
  return withMsdLock(device, () => ejectMsdLocked(client, expectImage, device));
}

async function mountMsdLocked(client: PiKVMClient, request: MountRequest): Promise<MountResult> {
  const { device, image, confirmImage, mode, rw, connect, expectImage } = request;
  if (confirmImage !== image) {
    throw new Error('confirmImage does not match image');
  }
  if (image.includes('://')) {
    throw new Error('image must not contain ://');
  }
  const state = await client.getMsdState();
  const snap = snapshotOf(state.drive);
  if (snap.connected && expectImage !== snap.image) {
    throw new MsdExpectImageError(snap.image);
  }
  if (!state.online) {
    throw new Error('kvmd MSD is offline');
  }
  if (state.busy) {
    throw new Error('kvmd MSD is busy');
  }
  const stored = state.images[image];
  if (!stored) {
    throw new Error(`image ${JSON.stringify(image)} is not in storage`);
  }
  if (stored.complete !== true) {
    throw new Error(`image ${JSON.stringify(image)} is incomplete`);
  }
  let started = false;
  try {
    if (snap.connected) {
      started = true;
      await disconnect(client);
    }
    started = true;
    // Send rw as requested. kvmd forces it false for cdrom and for an
    // image that is not writable. The re-read below is that result.
    await client.msdSetParams({
      image,
      cdrom: mode === 'cdrom',
      rw,
    });
    if (connect) await client.msdSetConnected(true);
    const drive = (await client.getMsdState()).drive;
    logMsd('msd_mount', device, image, true);
    return { drive };
  } catch (err) {
    if (!started) throw err;
    const rolled = await rollback(client, snap);
    logMsd('msd_mount', device, image, false, errorFields(err).type);
    const failure: MountFailure = {
      error: errorFields(err),
      restored: rolled.drive,
    };
    if (rolled.rollbackError) failure.rollbackError = rolled.rollbackError;
    return failure;
  }
}

export function mountMsd(client: PiKVMClient, request: MountRequest): Promise<MountResult> {
  return withMsdLock(request.device, () => mountMsdLocked(client, request));
}
