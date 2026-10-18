// Modified 2026-10 by PLN: MSD mount and eject policy (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: expectImage, preflight, and MSD mutex (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: upload jobs, remove, and job lock (GPL-3.0; see NOTICE).

/**
 * Policy for MSD status, mount, and eject.
 * Plain kvmd calls stay on the client. Echo-back checks, preflight,
 * and mount rollback live here. Jobs and uploads are a later change.
 * Mount and eject share a per-device mutex so one session's rollback
 * cannot run in the middle of another's change. Uploads use
 * withMsdJobLock instead, so a long transfer does not queue mount
 * or eject.
 */

import { createHash, randomBytes } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
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
 * expectImage does not match the snapshot image. That includes a value
 * supplied while the drive is disconnected. Mount must not change the drive.
 */
export class MsdExpectImageError extends Error {
  readonly type = 'MsdExpectImageError';
  readonly image: string;

  constructor(image: string) {
    super(`drive image is ${JSON.stringify(image)}; expectImage must equal that name`);
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

function logMsd(
  event: string,
  device: string,
  image: string,
  ok: boolean,
  error?: string,
  extra?: Record<string, string | number | boolean>,
): void {
  const line: Record<string, unknown> = {
    event,
    device,
    image: logImage(image),
    ok,
  };
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (key === 'path' || key === 'file' || key === 'url') continue;
      line[key] = value;
    }
  }
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
  // Offline hides the drive, so there is no snapshot image to compare.
  if (!state.online) {
    throw new Error('kvmd MSD is offline');
  }
  const snap = snapshotOf(state.drive);
  // A connected drive always requires expectImage. A supplied expectImage
  // is also checked when nothing is connected, so it is not ignored.
  if ((snap.connected || expectImage !== undefined) && expectImage !== snap.image) {
    throw new MsdExpectImageError(snap.image);
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

const msdJobLockTail = new Map<string, Promise<void>>();

/**
 * One MSD upload at a time for a device. Separate from withMsdLock and
 * from BusyLock. Mount and eject do not take this lock, so they are not
 * queued behind a transfer. Later URL downloads can reuse it.
 */
export function withMsdJobLock<T>(device: string, run: () => Promise<T>): Promise<T> {
  const previous = msdJobLockTail.get(device) ?? Promise.resolve();
  let settled!: Promise<void>;
  const runPromise = previous.then(run, run);
  settled = runPromise.then(() => {
    if (msdJobLockTail.get(device) === settled) msdJobLockTail.delete(device);
  }, () => {
    if (msdJobLockTail.get(device) === settled) msdJobLockTail.delete(device);
  });
  msdJobLockTail.set(device, settled);
  return runPromise;
}

/** Test-only pause after kvmd accepts the body and before the file is read. */
let beforeUploadStream: (() => Promise<void>) | undefined;

export function setBeforeUploadStream(hook: (() => Promise<void>) | undefined): void {
  beforeUploadStream = hook;
}

export interface MsdJobView {
  state: 'running' | 'done' | 'failed';
  bytes: number;
  total: number;
  sha256?: string;
  error?: ErrorFields;
}

interface JobRecord {
  state: 'running' | 'done' | 'failed';
  bytes: number;
  total: number;
  sha256?: string;
  error?: ErrorFields;
}

const jobs = new Map<string, JobRecord>();

export function readMsdJob(jobId: string): MsdJobView | undefined {
  const job = jobs.get(jobId);
  if (!job) return undefined;
  const view: MsdJobView = {
    state: job.state,
    bytes: job.bytes,
    total: job.total,
  };
  if (job.sha256 !== undefined) view.sha256 = job.sha256;
  if (job.error !== undefined) view.error = job.error;
  return view;
}

export interface UploadRequest {
  device: string;
  localDir: string;
  maxBytes: number;
  extensions: readonly string[];
  file: string;
  confirmImage: string;
  sha256?: string;
}

export interface RemoveResult {
  removed: true;
  drive: MsdDriveState | null;
}

function assertBareName(file: string, extensions: readonly string[]): void {
  if (file.length === 0 || file.length > 255 || file !== file.trim()) {
    throw new Error('file must be a bare image name');
  }
  if (
    file.includes('/')
    || file.includes('\\')
    || file.includes('\0')
    || file.startsWith('.')
    || file === 'lost+found'
  ) {
    throw new Error('file must be a bare image name');
  }
  for (let i = 0; i < file.length; i += 1) {
    const code = file.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) throw new Error('file must be a bare image name');
  }
  const lower = file.toLowerCase();
  if (!extensions.some((ext) => lower.endsWith(ext))) {
    throw new Error('file suffix is not allowed');
  }
}

function normalizeSha256(value: string): string {
  const hex = value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('sha256 must be 64 hex characters');
  return hex;
}

async function hashFd(fh: FileHandle, size: number): Promise<string> {
  const hash = createHash('sha256');
  const buf = Buffer.alloc(64 * 1024);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, size - offset), offset);
    if (bytesRead === 0) break;
    hash.update(buf.subarray(0, bytesRead));
    offset += bytesRead;
  }
  if (offset !== size) throw new Error('short read while hashing');
  return hash.digest('hex');
}

async function confine(
  localDir: string,
  file: string,
  maxBytes: number,
): Promise<{ fh: FileHandle; size: number }> {
  let root: string;
  try {
    root = await realpath(localDir);
  } catch {
    throw new Error('upload directory is not available');
  }
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory()) throw new Error('upload directory is not available');
  const candidate = path.join(root, file);
  let listed;
  try {
    listed = await lstat(candidate);
  } catch {
    throw new Error('file is not in the upload directory');
  }
  if (listed.isSymbolicLink()) throw new Error('symlink rejected');
  if (listed.isDirectory()) throw new Error('directory rejected');
  if (!listed.isFile()) throw new Error('not a regular file');
  let fh: FileHandle;
  try {
    fh = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new Error('upload path rejected');
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new Error('not a regular file');
    if (st.size <= 0) throw new Error('file is empty');
    if (st.size > maxBytes) throw new Error('file exceeds PIKVM_MSD_MAX_BYTES');
    const resolved = await realpath(candidate);
    if (path.relative(root, resolved) !== file) throw new Error('upload path rejected');
    return { fh, size: st.size };
  } catch (err) {
    await fh.close().catch(() => undefined);
    throw err;
  }
}

async function assertUploadAllowed(client: PiKVMClient, image: string, size: number): Promise<void> {
  const state = await client.getMsdState();
  if (!state.online) throw new Error('kvmd MSD is offline');
  if (state.busy) throw new Error('kvmd MSD is busy');
  if (state.drive?.connected === true) throw new Error('MsdConnectedError: drive is connected');
  if (state.images[image]) throw new Error('MsdImageExistsError: image already exists');
  if (state.free === null || state.free < size) throw new Error('free space is below the file size');
}

function closeUpload(stream: Readable | undefined, fh: FileHandle): Promise<void> {
  stream?.destroy();
  return fh.close().catch(() => undefined);
}

async function runUpload(
  client: PiKVMClient,
  request: UploadRequest,
  fh: FileHandle,
  size: number,
  prehash: string,
  job: JobRecord,
): Promise<void> {
  const { device, file } = request;
  let stream: Readable | undefined;
  const signal = { bad: '' };
  const sent = { n: 0 };
  const timer = setInterval(() => {
    client.getMsdState().then((state) => {
      const up = state.uploading;
      if (!up) return;
      if (up.name !== file) signal.bad = 'storage.uploading name does not match';
      else if (up.size > 0 && up.size !== size) signal.bad = 'storage.uploading size does not match';
      else if (up.written > sent.n) signal.bad = 'storage.uploading is ahead of bytes sent';
    }).catch(() => undefined);
  }, 100);
  timer.unref();
  try {
    await assertUploadAllowed(client, file, size);
    const hash = createHash('sha256');
    stream = createReadStream(file, {
      fd: fh.fd,
      autoClose: false,
      start: 0,
      end: size - 1,
    });
    const source = stream;
    const body = Readable.from((async function* () {
      const hook = beforeUploadStream;
      if (hook) {
        beforeUploadStream = undefined;
        await hook();
      }
      for await (const chunk of source) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        hash.update(buf);
        sent.n += buf.length;
        job.bytes = sent.n;
        yield buf;
      }
    })());
    const result = await client.msdWrite(file, body, size, { removeIncomplete: true });
    const digest = hash.digest('hex');
    job.sha256 = digest;
    if (signal.bad) throw new Error(signal.bad);
    if (digest !== prehash) throw new Error('sha256 changed while uploading');
    if (result.written !== size) throw new Error('written does not match size');
    const after = await client.getMsdState();
    if (after.images[file]?.complete !== true) throw new Error('image is incomplete after upload');
    job.bytes = size;
    job.state = 'done';
    logMsd('msd_upload', device, file, true, undefined, { bytes: size, sha256: digest });
  } catch (err) {
    job.state = 'failed';
    job.error = errorFields(err);
    logMsd('msd_upload', device, file, false, job.error.type, {
      bytes: job.bytes,
      ...(job.sha256 ? { sha256: job.sha256 } : {}),
    });
  } finally {
    clearInterval(timer);
    await closeUpload(stream, fh);
  }
}

/**
 * Hash and pre-check before any job is returned. A mismatch or a path
 * rejection throws here and does not call kvmd. The transfer itself
 * runs under the job lock and does not block the caller.
 */
export async function startMsdUpload(
  client: PiKVMClient,
  request: UploadRequest,
): Promise<{ jobId: string }> {
  const { device, file, confirmImage, sha256, maxBytes, extensions } = request;
  if (confirmImage !== file) throw new Error('confirmImage does not match image');
  assertBareName(file, extensions);
  const expected = sha256 === undefined ? undefined : normalizeSha256(sha256);
  const opened = await confine(request.localDir, file, maxBytes);
  let prehash: string;
  try {
    prehash = await hashFd(opened.fh, opened.size);
    if (expected !== undefined && prehash !== expected) throw new Error('sha256 mismatch');
    await assertUploadAllowed(client, file, opened.size);
  } catch (err) {
    await opened.fh.close().catch(() => undefined);
    throw err;
  }
  const job: JobRecord = {
    state: 'running',
    bytes: 0,
    total: opened.size,
    sha256: prehash,
  };
  const jobId = randomBytes(16).toString('hex');
  jobs.set(jobId, job);
  void withMsdJobLock(device, () => runUpload(client, request, opened.fh, opened.size, prehash, job));
  return { jobId };
}

export async function removeMsd(
  client: PiKVMClient,
  image: string,
  confirmImage: string,
  device: string,
): Promise<RemoveResult> {
  if (confirmImage !== image) throw new Error('confirmImage does not match image');
  if (
    image.length === 0
    || image.includes('/')
    || image.includes('\\')
    || image.includes('\0')
    || image.includes('://')
  ) {
    throw new Error('image must be a storage name');
  }
  return withMsdLock(device, async () => {
    const state = await client.getMsdState();
    if (state.drive?.connected === true) {
      throw new Error('MsdConnectedError: drive is connected');
    }
    if (state.busy) throw new Error('kvmd MSD is busy');
    try {
      await client.msdRemove(image);
      const drive = (await client.getMsdState()).drive;
      logMsd('msd_remove', device, image, true);
      return { removed: true, drive };
    } catch (err) {
      logMsd('msd_remove', device, image, false, errorFields(err).type);
      throw err;
    }
  });
}
