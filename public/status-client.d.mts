import type { StatusSnapshot, StatusView } from './status-model.mjs';

export interface SnapshotResponse {
  ok: boolean;
  json(): Promise<unknown>;
}

export interface SnapshotRequestOptions {
  cache: 'no-store';
  credentials: 'omit';
  redirect: 'error';
  signal: AbortSignal;
}

export interface SnapshotMonitor {
  generatedAt?: string | null;
  monitor?: { intervalSeconds?: number };
}

export interface StatusControllerOptions<Snapshot extends SnapshotMonitor, View, TimerId> {
  fetchSnapshot(url: string, options: SnapshotRequestOptions): PromiseLike<SnapshotResponse>;
  validateSnapshot(input: unknown): Snapshot | null;
  buildView(snapshot: Snapshot | null, now: number, updateFailed: boolean): View;
  renderView(view: View): void;
  setFeedback?(message: string): void;
  setBusy?(busy: boolean): void;
  setIntervalLabel?(seconds: number): void;
  now?(): number;
  setTimer?(callback: () => void, delay: number): TimerId;
  clearTimer?(timer: TimerId): void;
  getHidden?(): boolean;
  dataUrl?: string;
  dataUrls?: string[];
}

export interface StatusController {
  start(): void;
  refresh(): Promise<boolean>;
  pause(): void;
  resume(): void;
  destroy(): void;
}

export interface StatusModel {
  validateSnapshot(input: unknown): StatusSnapshot | null;
  buildView(snapshot: unknown, now?: number, updateFailed?: boolean): StatusView;
}

export function resolveStatusDataUrl(document: Pick<Document, 'querySelector'>): string;
export function resolveStatusDataUrls(document: Pick<Document, 'querySelector'>): string[];
export function renderStatusView(document: Document, view: StatusView): void;
export function createStatusController<Snapshot extends SnapshotMonitor = StatusSnapshot, View = StatusView, TimerId = ReturnType<typeof setTimeout>>(
  options: StatusControllerOptions<Snapshot, View, TimerId>,
): StatusController;
export function mountStatusPage(window: Window, document: Document, model: StatusModel): () => void;
