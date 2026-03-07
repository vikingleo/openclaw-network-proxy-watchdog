import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { ensureParentDir } from "./config.js";

const PANEL_STORE_VERSION = 1;
const DEFAULT_PANEL_TTL_MS = 24 * 60 * 60 * 1000;

export interface WatchdogPanelRecord {
  panelId: string;
  chatId: string;
  threadId: number | null;
  messageId: number;
  ownerSenderId: string;
  createdAtMs: number;
  updatedAtMs: number;
}

interface WatchdogPanelStoreFile {
  version: number;
  panels: Record<string, WatchdogPanelRecord>;
}

export class WatchdogPanelStore {
  constructor(
    private readonly filePath: string,
    private readonly ttlMs = DEFAULT_PANEL_TTL_MS,
  ) {}

  create(params: {
    chatId: string;
    threadId: number | null;
    ownerSenderId: string;
  }): WatchdogPanelRecord {
    const state = this.read();
    this.pruneExpired(state);
    const now = Date.now();
    const record: WatchdogPanelRecord = {
      panelId: randomPanelId(),
      chatId: params.chatId,
      threadId: params.threadId,
      messageId: 0,
      ownerSenderId: params.ownerSenderId,
      createdAtMs: now,
      updatedAtMs: now,
    };
    state.panels[record.panelId] = record;
    this.write(state);
    return record;
  }

  get(panelId: string): WatchdogPanelRecord | null {
    const state = this.read();
    this.pruneExpired(state);
    const record = state.panels[panelId];
    if (!record) {
      this.write(state);
      return null;
    }
    return record;
  }

  update(panelId: string, updater: (current: WatchdogPanelRecord) => WatchdogPanelRecord): WatchdogPanelRecord | null {
    const state = this.read();
    this.pruneExpired(state);
    const current = state.panels[panelId];
    if (!current) {
      this.write(state);
      return null;
    }
    const next = updater(current);
    state.panels[panelId] = {
      ...next,
      updatedAtMs: Date.now(),
    };
    this.write(state);
    return state.panels[panelId] ?? null;
  }

  delete(panelId: string): void {
    const state = this.read();
    if (state.panels[panelId]) {
      delete state.panels[panelId];
      this.write(state);
    }
  }

  private read(): WatchdogPanelStoreFile {
    if (!fs.existsSync(this.filePath)) {
      return emptyStore();
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<WatchdogPanelStoreFile>;
      return {
        version: PANEL_STORE_VERSION,
        panels: isPlainObject(parsed.panels)
          ? Object.fromEntries(
              Object.entries(parsed.panels).filter(([, value]) => isPanelRecord(value)),
            )
          : {},
      };
    } catch {
      return emptyStore();
    }
  }

  private write(state: WatchdogPanelStoreFile): void {
    ensureParentDir(this.filePath);
    fs.writeFileSync(this.filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  private pruneExpired(state: WatchdogPanelStoreFile): void {
    const deadline = Date.now() - this.ttlMs;
    for (const [panelId, record] of Object.entries(state.panels)) {
      if (record.updatedAtMs < deadline) {
        delete state.panels[panelId];
      }
    }
  }
}

export function derivePanelStorePath(stateFile: string): string {
  return path.join(path.dirname(stateFile), "panels.json");
}

function randomPanelId(): string {
  return crypto.randomBytes(4).toString("hex");
}

function emptyStore(): WatchdogPanelStoreFile {
  return {
    version: PANEL_STORE_VERSION,
    panels: {},
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPanelRecord(value: unknown): value is WatchdogPanelRecord {
  if (!isPlainObject(value)) {
    return false;
  }
  return typeof value.panelId === "string"
    && typeof value.chatId === "string"
    && (typeof value.threadId === "number" || value.threadId === null)
    && typeof value.messageId === "number"
    && typeof value.ownerSenderId === "string"
    && typeof value.createdAtMs === "number"
    && typeof value.updatedAtMs === "number";
}
