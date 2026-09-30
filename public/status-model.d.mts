export type ComponentId = 'website' | 'api' | 'database' | 'cache';
export type StatusState = 'operational' | 'degraded' | 'outage' | 'unknown';

export interface ComponentObservation {
  id: ComponentId;
  status: StatusState;
  latencyMs: number | null;
  reason: string | null;
}

export interface CurrentComponent extends ComponentObservation {
  name: string;
  checkedAt: string | null;
}

export interface DailyComponent {
  id: ComponentId;
  status: StatusState;
  checks: number;
  passed: number;
  failed: number;
  unknown: number;
}

export interface StatusIncident {
  id: string;
  componentId: ComponentId;
  title: string;
  startedAt: string;
  resolvedAt: string | null;
  updates: Array<{ at: string; message: string }>;
}

export interface StatusSnapshot {
  schemaVersion: 1;
  generatedAt: string;
  monitor: { startedAt: string; intervalSeconds: number; staleAfterSeconds: number };
  components: CurrentComponent[];
  history: Array<{ checkedAt: string; components: ComponentObservation[] }>;
  days: Array<{ date: string; components: DailyComponent[] }>;
  incidents: StatusIncident[];
}

export interface ComponentDay {
  date: string;
  status: StatusState;
  checks: number;
  passed: number;
  failed: number;
  unknown: number;
}

export interface ComponentView extends CurrentComponent {
  state: StatusState;
  statusLabel: string;
  days: ComponentDay[];
  observedChecks: number;
  availabilityPercent: number | null;
}

export interface StatusView {
  overall: StatusState;
  statusLabel: string;
  description: string;
  updatedAt: string | null;
  startedAt: string | null;
  components: ComponentView[];
  incidents: StatusIncident[];
}

export const COMPONENTS: Readonly<Record<ComponentId, string>>;
export const STATES: readonly StatusState[];
export function worstStatus(states: readonly StatusState[]): StatusState;
export function validateSnapshot(input: unknown): StatusSnapshot | null;
export function buildView(snapshot: unknown, now?: number, updateFailed?: boolean): StatusView;
