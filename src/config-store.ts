import { api, errorMessage, RequestError } from "./api.ts";
import { configSchema, defaultConfig, type Config } from "./config.ts";

interface ConfigTransport {
  save(patch: Partial<Config>): Promise<Config>;
  resetInvalid(): Promise<{ config: Config; backup: string }>;
  listen(
    receive: (config: Config) => void,
    fail: (message: string, code?: string) => void,
  ): () => void;
}

const browserTransport: ConfigTransport = {
  save: async (patch) => configSchema.parse(await api("config", patch)),
  resetInvalid: async () => {
    const result = await api<{ config: unknown; backup: string }>(
      "config/reset-invalid",
      { confirm: true },
    );
    return { config: configSchema.parse(result.config), backup: result.backup };
  },
  listen(receive, fail) {
    const events = new EventSource("/api/config/events");
    events.addEventListener("config", (event) => {
      try {
        receive(configSchema.parse(JSON.parse((event as MessageEvent).data)));
      } catch {
        fail("Invalid settings response from the server.");
      }
    });
    events.addEventListener("config-error", (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data);
        fail(String(payload.error), payload.code);
      } catch {
        fail("Could not read the settings file.");
      }
    });
    events.onerror = () => fail("Settings sync disconnected; reconnecting…");
    return () => events.close();
  },
};

const initialSnapshot = {
  config: defaultConfig,
  error: "",
  saving: false,
  loaded: false,
  canReset: false,
};

/** One disk-backed snapshot for every preference hook in this window. */
export class ConfigStore {
  private confirmed = defaultConfig;
  private pending: Partial<Config> = {};
  private inFlight: Partial<Config> = {};
  private listeners = new Set<() => void>();
  private disconnect?: () => void;
  private timer?: ReturnType<typeof setTimeout>;
  private syncing = false;
  private loaded = false;
  private syncError = "";
  private saveError = "";
  private syncErrorCode?: string;
  private saveErrorCode?: string;
  private generation = 0;
  private syncGeneration = 0;
  private snapshot = initialSnapshot;

  constructor(
    private readonly transport: ConfigTransport = browserTransport,
    private readonly debounceMs = 100,
  ) {}

  getSnapshot = () => this.snapshot;
  getServerSnapshot = () => initialSnapshot;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (!this.disconnect) {
      this.disconnect = this.transport.listen(
        (config) => {
          this.syncGeneration++;
          this.generation++;
          this.confirmed = config;
          this.syncError = "";
          this.syncErrorCode = undefined;
          // A repaired file must also dismiss a previous invalid-file save
          // failure. The failed edit itself is never replayed.
          if (this.saveErrorCode === "CONFIG_INVALID") {
            this.saveError = "";
            this.saveErrorCode = undefined;
          }
          this.loaded = true;
          this.publish();
        },
        (message, code) => {
          this.syncGeneration++;
          this.syncError = message;
          this.syncErrorCode = code;
          this.publish();
        },
      );
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        this.disconnect?.();
        this.disconnect = undefined;
      }
    };
  };

  set<K extends keyof Config>(
    key: K,
    action: Config[K] | ((previous: Config[K]) => Config[K]),
  ) {
    const previous = this.snapshot.config[key];
    const value = typeof action === "function" ? action(previous) : action;
    if (value === previous) return;
    this.pending[key] = value;
    this.saveError = "";
    this.saveErrorCode = undefined;
    this.publish();
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.debounceMs);
  }

  private publish() {
    this.snapshot = {
      config: { ...this.confirmed, ...this.inFlight, ...this.pending },
      error: this.saveError || this.syncError,
      saving: this.syncing || Object.keys(this.pending).length > 0,
      loaded: this.loaded,
      canReset:
        !this.syncing &&
        Object.keys(this.pending).length === 0 &&
        (this.syncErrorCode === "CONFIG_INVALID" ||
          this.saveErrorCode === "CONFIG_INVALID"),
    };
    for (const listener of this.listeners) listener();
  }

  private async flush() {
    if (this.syncing || !Object.keys(this.pending).length) return;
    this.syncing = true;
    this.inFlight = this.pending;
    this.pending = {};
    const generation = this.generation;
    this.publish();
    try {
      const config = await this.transport.save(this.inFlight);
      // An SSE snapshot delivered during the request may be newer than its
      // response. Never replace it with an older full-document response.
      if (this.generation === generation) this.confirmed = config;
      this.saveError = "";
      this.saveErrorCode = undefined;
    } catch (error) {
      // A failed write is not replayed. Revert just its optimistic overlay and
      // leave any newer, explicit edits queued independently.
      const code = error instanceof RequestError ? error.code : undefined;
      const alreadyRepaired =
        code === "CONFIG_INVALID" &&
        this.generation !== generation &&
        !this.syncError;
      this.saveError = alreadyRepaired
        ? ""
        : `Settings save could not be confirmed: ${errorMessage(error)}`;
      this.saveErrorCode = alreadyRepaired ? undefined : code;
    } finally {
      this.inFlight = {};
      this.syncing = false;
      this.publish();
      if (!this.timer) void this.flush();
    }
  }

  async resetInvalid(): Promise<string> {
    if (!this.snapshot.canReset)
      throw new Error("Wait for settings saves to finish before resetting.");
    this.syncing = true;
    const generation = this.generation;
    const syncGeneration = this.syncGeneration;
    this.publish();
    try {
      const { config, backup } = await this.transport.resetInvalid();
      if (this.generation === generation) this.confirmed = config;
      this.saveError = "";
      this.saveErrorCode = undefined;
      // Another process/editor can invalidate the file again before this HTTP
      // response arrives. Keep any newer stream status, including failures.
      if (this.syncGeneration === syncGeneration) {
        this.syncError = "";
        this.syncErrorCode = undefined;
      }
      return backup;
    } catch (error) {
      this.saveError = `Settings reset could not be confirmed: ${errorMessage(error)}`;
      this.saveErrorCode =
        error instanceof RequestError ? error.code : undefined;
      throw error;
    } finally {
      this.syncing = false;
      this.publish();
      if (!this.timer) void this.flush();
    }
  }
}

export const configStore = new ConfigStore();
