import { Plugin, TFile } from "obsidian";
import { createEmptyMonthTaskData } from "./v2Defaults";
import { normalizeTaskFlowV2Data } from "./v2Normalize";
import { MonthTaskData, TaskFlowV2Data } from "./v2Schema";

type StoreListener = () => void;

export class TaskFlowV2Store {
  private data: TaskFlowV2Data | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private listeners = new Set<StoreListener>();

  constructor(private readonly plugin: Plugin) {}

  async load(): Promise<void> {
    const raw = await this.plugin.loadData();
    const normalized = normalizeTaskFlowV2Data(raw);
    this.data = normalized;
    if (
      isVersion2Data(raw)
      && JSON.stringify(raw) !== JSON.stringify(normalized)
    ) {
      normalized.updatedAt = new Date().toISOString();
      await this.plugin.saveData(normalized);
    }
  }

  async reloadExternal(): Promise<void> {
    await this.load();
    this.notify();
  }

  subscribe(listener: StoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async ensureMonth(file: TFile): Promise<MonthTaskData> {
    await this.ensureLoaded();
    const existing = this.data!.files[file.path];
    if (existing) {
      return cloneMonth(existing);
    }

    await this.mutate((data) => {
      if (data.files[file.path]) {
        return false;
      }
      data.files[file.path] = createEmptyMonthTaskData();
      return true;
    });
    return cloneMonth(this.data!.files[file.path]);
  }

  async getMonth(file: TFile): Promise<MonthTaskData | null> {
    await this.ensureLoaded();
    const month = this.data!.files[file.path];
    return month ? cloneMonth(month) : null;
  }

  async mutate(change: (data: TaskFlowV2Data) => boolean | void): Promise<void> {
    const operation = this.writeQueue.then(async () => {
      const latest = normalizeTaskFlowV2Data(await this.plugin.loadData());
      const changed = change(latest);
      this.data = latest;
      if (changed === false) {
        return;
      }
      latest.updatedAt = new Date().toISOString();
      await this.plugin.saveData(latest);
      this.notify();
    });

    this.writeQueue = operation.catch(() => undefined);
    await operation;
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.data) {
      await this.load();
    }
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

function isVersion2Data(value: unknown): value is TaskFlowV2Data {
  return typeof value === "object"
    && value !== null
    && "version" in value
    && value.version === 2;
}

function cloneMonth(month: MonthTaskData): MonthTaskData {
  return structuredClone(month);
}
