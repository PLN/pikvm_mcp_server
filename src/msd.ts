// Modified 2026-10 by PLN: MSD mount and eject policy (GPL-3.0; see NOTICE).

/**
 * Policy for MSD status, mount, and eject.
 * Plain kvmd calls stay on the client. Echo-back checks and mount
 * rollback live here. Jobs and uploads are a later change.
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
}

export interface MountSuccess {
  drive: MsdDriveState | null;
}

export interface MountFailure {
  error: ErrorFields;
  restored: MsdDriveState | null;
  rollbackError?: ErrorFields;
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
  return {
    status: 0,
    type: 'Error',
    message: err instanceof Error ? err.message : 'MSD operation failed',
    endpoint: '',
  };
}

function logImage(image: string): string {
  if (image.includes('/') || image.includes('\\') || image.includes('\0')) return '';
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

async function rollback(
  client: PiKVMClient,
  snap: DriveSnapshot,
): Promise<{ drive: MsdDriveState | null; rollbackError?: ErrorFields }> {
  let rollbackError: ErrorFields | undefined;
  const note = (err: unknown) => {
    if (!rollbackError) rollbackError = errorFields(err);
  };
  try {
    await disconnect(client);
  } catch (err) {
    note(err);
  }
  try {
    await client.msdSetParams({
      image: snap.image,
      cdrom: snap.cdrom,
      rw: snap.rw,
    });
  } catch (err) {
    note(err);
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
  return rollbackError ? { drive, rollbackError } : { drive };
}

export async function ejectMsd(
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

export async function mountMsd(client: PiKVMClient, request: MountRequest): Promise<MountResult> {
  const { device, image, confirmImage, mode, rw, connect } = request;
  if (confirmImage !== image) {
    throw new Error('confirmImage does not match image');
  }
  const snap = snapshotOf((await client.getMsdState()).drive);
  let started = false;
  try {
    if (snap.connected) {
      const again = imageName((await client.getMsdState()).drive);
      if (again !== snap.image) {
        throw new Error(`expectImage mismatch: drive image is ${JSON.stringify(again)}`);
      }
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
