// Modified 2026-10 by PLN: MSD mount and eject policy (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: expectImage, preflight, and MSD mutex (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: upload jobs, remove, and job lock (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: hashing jobs, bad-image cleanup, upload try-lock (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: URL fetch jobs and mount block during a transfer (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: fetch cleanup only after our progress line (GPL-3.0; see NOTICE).

/**
 * Policy for MSD status, mount, eject, upload, and remove.
 * Plain kvmd calls stay on the client. Echo-back checks, preflight,
 * and mount rollback live here.
 * Mount and eject share a per-device mutex so one session's rollback
 * cannot run in the middle of another's change. An upload takes a
 * fail-fast try-lock, so a second upload or URL fetch is refused and a
 * transfer does not queue mount or eject. Mount refuses an image that
 * already has an active transfer.
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
  type MsdWriteResult,
  type PiKVMClient,
} from './pikvm/client.js';
import {
  assertResolvedAddresses,
  inspectFetchUrl,
  MsdUrlPolicyError,
  redactUrlUserinfo,
  resolveFetchHost,
  type UrlAllowlist,
} from './url-policy.js';

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

/** A kvmd state check refused the upload or the removal before any POST. */
export class MsdPreflightError extends Error {
  readonly type: string;

  constructor(type: string, message: string) {
    super(message);
    this.name = type;
    this.type = type;
  }
}

/** Another upload or URL fetch already holds this device. The caller is not queued. */
export class MsdUploadBusyError extends Error {
  readonly type = 'MsdUploadBusyError';

  constructor() {
    super('upload already running');
    this.name = 'MsdUploadBusyError';
  }
}

/** Mount of an image that still has an upload or fetch job. No kvmd call is made. */
export class MsdImageTransferError extends Error {
  readonly type = 'MsdImageTransferError';
  readonly image: string;

  constructor(image: string) {
    super(`image ${JSON.stringify(image)} has an active transfer`);
    this.name = 'MsdImageTransferError';
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
      message: redactUrlUserinfo(err.message),
      endpoint: err.endpoint,
    };
  }
  if (
    err instanceof MsdExpectImageError
    || err instanceof MsdPreflightError
    || err instanceof MsdUploadBusyError
    || err instanceof MsdImageTransferError
    || err instanceof MsdUrlPolicyError
  ) {
    return {
      status: 0,
      type: err.type,
      message: redactUrlUserinfo(err.message),
      endpoint: '',
    };
  }
  return {
    status: 0,
    type: 'Error',
    message: redactUrlUserinfo(err instanceof Error ? err.message : 'MSD operation failed'),
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
  assertNoActiveTransfer(device, image);
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

/**
 * Devices with an upload in progress. A second upload fails immediately
 * instead of waiting behind a transfer. Mount and eject do not take this
 * set, and an upload does not take withMsdLock or BusyLock.
 */
const uploadHeld = new Set<string>();

function acquireUpload(device: string): void {
  if (uploadHeld.has(device)) throw new MsdUploadBusyError();
  uploadHeld.add(device);
}

function releaseUpload(device: string): void {
  uploadHeld.delete(device);
}

const UPLOAD_POLL_MS = 1500;
const JOB_TTL_MS = 24 * 60 * 60 * 1000;
const JOB_CAP = 64;

type JobState = 'hashing' | 'running' | 'done' | 'failed';

export interface MsdJobView {
  state: JobState;
  bytes: number;
  total: number;
  sha256?: string;
  error?: ErrorFields;
  /** Set when a post-check failure tried to delete the stored image. */
  removed?: boolean;
  removeError?: ErrorFields;
}

interface JobRecord {
  state: JobState;
  bytes: number;
  total: number;
  device: string;
  image: string;
  sha256?: string;
  error?: ErrorFields;
  removed?: boolean;
  removeError?: ErrorFields;
  finishedAt?: number;
}

const jobs = new Map<string, JobRecord>();

function assertNoActiveTransfer(device: string, image: string): void {
  for (const job of jobs.values()) {
    if (job.device !== device || job.image !== image) continue;
    if (job.state === 'hashing' || job.state === 'running') {
      throw new MsdImageTransferError(image);
    }
  }
}

function jobLimitOf(value: number | undefined): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : JOB_CAP;
}

function jobTtlOf(value: number | undefined): number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : JOB_TTL_MS;
}

/** Drop finished jobs older than the TTL, then the oldest finished jobs past the cap. */
function pruneJobs(limit: number, ttlMs: number): void {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.finishedAt !== undefined && now - job.finishedAt > ttlMs) jobs.delete(id);
  }
  if (jobs.size <= limit) return;
  const finished = [...jobs.entries()].filter(([, job]) => job.finishedAt !== undefined);
  finished.sort((a, b) => (a[1].finishedAt ?? 0) - (b[1].finishedAt ?? 0));
  for (const [id] of finished) {
    if (jobs.size <= limit) break;
    jobs.delete(id);
  }
}

export interface JobReadOptions {
  jobLimit?: number;
  jobTtlMs?: number;
}

export function readMsdJob(jobId: string, options: JobReadOptions = {}): MsdJobView | undefined {
  pruneJobs(jobLimitOf(options.jobLimit), jobTtlOf(options.jobTtlMs));
  const job = jobs.get(jobId);
  if (!job) return undefined;
  const view: MsdJobView = {
    state: job.state,
    bytes: job.bytes,
    total: job.total,
  };
  if (job.sha256 !== undefined) view.sha256 = job.sha256;
  if (job.error !== undefined) view.error = job.error;
  if (job.removed !== undefined) view.removed = job.removed;
  if (job.removeError !== undefined) view.removeError = job.removeError;
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
  /** Awaited in the job before the hash. Unset in production. */
  beforeHash?: () => Promise<void>;
  /** Awaited in the upload body before the file is read. Unset in production. */
  beforeUploadStream?: () => Promise<void>;
  /** Overrides the 1.5s storage.uploading poll. Unset in production. */
  uploadPollMs?: number;
  /** Retained-job cap. Default 64. Unset in production. */
  jobLimit?: number;
  /** Finished-job TTL in ms. Default 24h. Unset in production. */
  jobTtlMs?: number;
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
    fh = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
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
  if (!state.online) throw new MsdPreflightError('MsdOfflineError', 'kvmd MSD is offline');
  if (state.busy) throw new MsdPreflightError('MsdBusyError', 'kvmd MSD is busy');
  if (state.drive?.connected === true) throw new MsdPreflightError('MsdConnectedError', 'drive is connected');
  if (state.images[image]) throw new MsdPreflightError('MsdImageExistsError', 'image already exists');
  if (state.free === null || state.free < size) {
    throw new MsdPreflightError('MsdFreeSpaceError', 'free space is below the file size');
  }
}

function closeUpload(stream: Readable | undefined, fh: FileHandle): Promise<void> {
  stream?.destroy();
  return fh.close().catch(() => undefined);
}

async function removeUploadedImage(
  client: PiKVMClient,
  image: string,
  device: string,
): Promise<{ removed: boolean; removeError?: ErrorFields }> {
  try {
    await withMsdLock(device, () => client.msdRemove(image));
    return { removed: true };
  } catch (err) {
    if (err instanceof KvmdError && err.type === 'MsdUnknownImageError') {
      return { removed: true };
    }
    return { removed: false, removeError: errorFields(err) };
  }
}

function failJob(job: JobRecord, err: unknown): void {
  job.state = 'failed';
  job.finishedAt = Date.now();
  job.error = errorFields(err);
}

async function runUpload(
  client: PiKVMClient,
  request: UploadRequest,
  fh: FileHandle,
  size: number,
  expected: string | undefined,
  job: JobRecord,
): Promise<void> {
  const { device, file } = request;
  const pollMs = request.uploadPollMs !== undefined
    && Number.isSafeInteger(request.uploadPollMs)
    && request.uploadPollMs > 0
    ? request.uploadPollMs
    : UPLOAD_POLL_MS;
  let stream: Readable | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const signal = { bad: '' };
  const sent = { n: 0 };
  let wrote = false;
  try {
    if (request.beforeHash) await request.beforeHash();
    const prehash = await hashFd(fh, size);
    if (expected !== undefined && prehash !== expected) throw new Error('sha256 mismatch');
    await assertUploadAllowed(client, file, size);
    job.state = 'running';
    const hash = createHash('sha256');
    stream = createReadStream(file, {
      fd: fh.fd,
      autoClose: false,
      start: 0,
      end: size - 1,
    });
    const source = stream;
    const body = Readable.from((async function* () {
      if (request.beforeUploadStream) await request.beforeUploadStream();
      for await (const chunk of source) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        hash.update(buf);
        sent.n += buf.length;
        job.bytes = sent.n;
        yield buf;
      }
    })());
    timer = setInterval(() => {
      client.getMsdState().then((state) => {
        const up = state.uploading;
        if (!up) return;
        if (up.name !== file) signal.bad = 'storage.uploading name does not match';
        else if (up.size > 0 && up.size !== size) signal.bad = 'storage.uploading size does not match';
        else if (up.written > sent.n) signal.bad = 'storage.uploading is ahead of bytes sent';
      }).catch(() => undefined);
    }, pollMs);
    timer.unref();
    const result = await client.msdWrite(file, body, size, { removeIncomplete: true });
    wrote = true;
    const digest = hash.digest('hex');
    job.sha256 = digest;
    if (signal.bad) throw new Error(signal.bad);
    if (digest !== prehash) throw new Error('sha256 changed while uploading');
    if (result.written !== size) throw new Error('written does not match size');
    const after = await client.getMsdState();
    if (after.images[file]?.complete !== true) throw new Error('image is incomplete after upload');
    job.bytes = size;
    job.state = 'done';
    job.finishedAt = Date.now();
    logMsd('msd_upload', device, file, true, undefined, { bytes: size, sha256: digest });
  } catch (err) {
    if (wrote) {
      const cleanup = await removeUploadedImage(client, file, device);
      job.removed = cleanup.removed;
      if (cleanup.removeError) job.removeError = cleanup.removeError;
    }
    failJob(job, err);
    logMsd('msd_upload', device, file, false, job.error?.type ?? 'Error', {
      bytes: job.bytes,
      ...(job.sha256 ? { sha256: job.sha256 } : {}),
      ...(job.removed !== undefined ? { removed: job.removed } : {}),
    });
  } finally {
    if (timer) clearInterval(timer);
    await closeUpload(stream, fh);
    pruneJobs(jobLimitOf(request.jobLimit), jobTtlOf(request.jobTtlMs));
  }
}

/**
 * Confine the path, then return a jobId. Hashing and the kvmd pre-check
 * run in the job (state hashing, then running). A sha256 mismatch fails
 * the job and does not POST. A second upload while one is running throws
 * before it opens a file.
 */
export async function startMsdUpload(
  client: PiKVMClient,
  request: UploadRequest,
): Promise<{ jobId: string }> {
  const { device, file, confirmImage, sha256, maxBytes, extensions } = request;
  if (confirmImage !== file) throw new Error('confirmImage does not match image');
  assertBareName(file, extensions);
  const expected = sha256 === undefined ? undefined : normalizeSha256(sha256);
  acquireUpload(device);
  let opened: { fh: FileHandle; size: number };
  try {
    opened = await confine(request.localDir, file, maxBytes);
  } catch (err) {
    releaseUpload(device);
    throw err;
  }
  const job: JobRecord = {
    state: 'hashing',
    bytes: 0,
    total: opened.size,
    device,
    image: file,
  };
  const jobId = randomBytes(16).toString('hex');
  jobs.set(jobId, job);
  pruneJobs(jobLimitOf(request.jobLimit), jobTtlOf(request.jobTtlMs));
  void runUpload(client, request, opened.fh, opened.size, expected, job)
    .finally(() => releaseUpload(device));
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
      throw new MsdPreflightError('MsdConnectedError', 'drive is connected');
    }
    if (state.busy) throw new MsdPreflightError('MsdBusyError', 'kvmd MSD is busy');
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

export interface FetchRequest {
  device: string;
  url: string;
  image?: string;
  confirmImage: string;
  extensions: readonly string[];
  allow: UrlAllowlist;
  allowPrivate: boolean;
  /** kvmd downloader connect timeout in seconds. Not the job wall clock. */
  connectTimeoutSec: number;
  resolveUrl?: (hostname: string) => Promise<string[]>;
  /** Awaited in the job before DNS. Unset in production. */
  beforeFetch?: () => Promise<void>;
  jobLimit?: number;
  jobTtlMs?: number;
}

async function assertFetchAllowed(client: PiKVMClient, image: string): Promise<void> {
  const state = await client.getMsdState();
  if (!state.online) throw new MsdPreflightError('MsdOfflineError', 'kvmd MSD is offline');
  if (state.busy) throw new MsdPreflightError('MsdBusyError', 'kvmd MSD is busy');
  if (state.drive?.connected === true) throw new MsdPreflightError('MsdConnectedError', 'drive is connected');
  if (state.images[image]) throw new MsdPreflightError('MsdImageExistsError', 'image already exists');
}

function isStateUnknown(err: unknown): boolean {
  return err instanceof KvmdError && err.type === 'PIKVM_MSD_STATE_UNKNOWN';
}

async function runFetch(
  client: PiKVMClient,
  request: FetchRequest,
  inspected: { href: string; hostname: string },
  image: string,
  job: JobRecord,
): Promise<void> {
  const { device } = request;
  let sawOurImage = false;
  try {
    if (request.beforeFetch) await request.beforeFetch();
    const addresses = await resolveFetchHost(inspected.hostname, request.resolveUrl);
    assertResolvedAddresses(addresses, request.allow, request.allowPrivate);
    await assertFetchAllowed(client, image);
    let last: MsdWriteResult | undefined;
    for await (const row of client.msdWriteRemote(inspected.href, {
      image,
      removeIncomplete: true,
      timeout: request.connectTimeoutSec,
    })) {
      last = row;
      if (row.name === image) sawOurImage = true;
      job.bytes = row.written;
      job.total = row.size;
    }
    // msdWriteRemote throws PIKVM_MSD_STATE_UNKNOWN when the stream ends
    // with written !== size. That happens before this line, and the catch
    // below does not remove the image for that error.
    if (!last || !sawOurImage) {
      throw new Error('write_remote ended without progress for this image');
    }
    job.bytes = last.written;
    job.total = last.size;
    job.state = 'done';
    job.finishedAt = Date.now();
    logMsd('msd_fetch', device, image, true, undefined, { bytes: last.written });
  } catch (err) {
    if (sawOurImage && !isStateUnknown(err)) {
      const cleanup = await removeUploadedImage(client, image, device);
      job.removed = cleanup.removed;
      if (cleanup.removeError) job.removeError = cleanup.removeError;
    }
    failJob(job, err);
    logMsd('msd_fetch', device, image, false, job.error?.type ?? 'Error', {
      bytes: job.bytes,
      ...(job.removed !== undefined ? { removed: job.removed } : {}),
    });
  } finally {
    pruneJobs(jobLimitOf(request.jobLimit), jobTtlOf(request.jobTtlMs));
  }
}

/**
 * Accept the URL and image name, then return a jobId. DNS, the address
 * policy, the kvmd pre-check, and write_remote run in the job. A second
 * transfer while one is running throws before any kvmd call.
 */
export async function startMsdFetch(
  client: PiKVMClient,
  request: FetchRequest,
): Promise<{ jobId: string }> {
  const inspected = inspectFetchUrl(request.url, request.allow);
  const image = request.image ?? inspected.imageFromPath;
  assertBareName(image, request.extensions);
  if (request.confirmImage !== image) throw new Error('confirmImage does not match image');
  acquireUpload(request.device);
  const job: JobRecord = {
    state: 'running',
    bytes: 0,
    total: 0,
    device: request.device,
    image,
  };
  const jobId = randomBytes(16).toString('hex');
  jobs.set(jobId, job);
  pruneJobs(jobLimitOf(request.jobLimit), jobTtlOf(request.jobTtlMs));
  void runFetch(client, request, inspected, image, job)
    .finally(() => releaseUpload(request.device));
  return { jobId };
}
