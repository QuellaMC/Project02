import type {
  RuntimePluginSourceReference
} from '../plugin-types.ts';

export type MemoryOperationScope = {
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
};

export type MemoryRecallRequest = MemoryOperationScope & {
  readonly sessionId: string;
  readonly currentUserMessage: string;
  readonly maxItems: number;
};

export type MemoryRecallItem = {
  readonly id: string;
  readonly text: string;
  readonly sourceReferences: readonly RuntimePluginSourceReference[];
  readonly confidence?: number;
};

export type MemoryRecallResult = {
  readonly items: readonly MemoryRecallItem[];
};

export type MemoryCaptureTurn = MemoryOperationScope & {
  readonly sessionId: string;
  readonly userMessage: string;
  readonly characterMessage?: string;
  readonly sourceReferences: readonly RuntimePluginSourceReference[];
};

export type MemoryCaptureResult = {
  readonly captured: boolean;
  readonly summary: string;
  readonly sourceReferences?: readonly RuntimePluginSourceReference[];
};

export type MemorySearchRequest = MemoryOperationScope & {
  readonly sessionId: string;
  readonly query: string;
  readonly maxItems: number;
};

export type MemorySearchResult = {
  readonly items: readonly MemoryRecallItem[];
};

export type MemoryAddRequest = MemoryOperationScope & {
  readonly sessionId: string;
  readonly text: string;
  readonly sourceReferences: readonly RuntimePluginSourceReference[];
};

export type MemoryAddResult = {
  readonly id: string;
  readonly sourceReferences: readonly RuntimePluginSourceReference[];
};

export type MemoryHealthRequest = MemoryOperationScope & {
  readonly checkedAt: string;
};

export type MemoryHealthResult = {
  readonly status: 'ok' | 'degraded' | 'unavailable';
  readonly summary: string;
};

export type Project02MemoryProvider = {
  readonly id: string;
  readonly displayName: string;
  recall?(request: MemoryRecallRequest): Promise<MemoryRecallResult>;
  captureTurn?(turn: MemoryCaptureTurn): Promise<MemoryCaptureResult>;
  search?(request: MemorySearchRequest): Promise<MemorySearchResult>;
  add?(request: MemoryAddRequest): Promise<MemoryAddResult>;
  health?(request: MemoryHealthRequest): Promise<MemoryHealthResult>;
  endSession?(sessionId: string, scope: MemoryOperationScope): Promise<void>;
  close?(scope: MemoryOperationScope): Promise<void>;
};
