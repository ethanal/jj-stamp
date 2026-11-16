import { api, errorMessage } from "./api.ts";
import { configSchema, defaultConfig, type Config } from "./config.ts";

interface ConfigTransport {
  save(patch: Partial<Config>): Promise<Config>;
  listen(
    receive: (config: Config) => void,
    fail: (message: string) => void,
  ): () => void;
}

const browserTransport: ConfigTransport = {
  save: async (patch) => configSchema.parse(await api("config", patch)),
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
        fail(String(JSON.parse((event as MessageEvent).data).error));
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
  private generation = 0;
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
          this.generation++;
          this.confirmed = config;
          this.syncError = "";
          this.loaded = true;
          this.publish();
        },
        (message) => {
          this.syncError = message;
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
    } catch (error) {
      // A failed write is not replayed. Revert just its optimistic overlay and
      // leave any newer, explicit edits queued independently.
      this.saveError = `Settings save could not be confirmed: ${errorMessage(error)}`;
    } finally {
      this.inFlight = {};
      this.syncing = false;
      this.publish();
      if (!this.timer) void this.flush();
    }
  }
}

export const configStore = new ConfigStore();
