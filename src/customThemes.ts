import * as vscode from 'vscode';
import { ColorTheme } from './themes';

export type CustomThemeMap = Record<string, ColorTheme>;

export interface InkyLogger {
  info(message: string): void;
  debug(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const NULL_LOGGER: InkyLogger = {
  info: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
};

const THEMES_FILE = 'themes.json';
export const CUSTOM_THEMES_SYNC_KEY = 'inky.customThemes';

const TEMPLATE: CustomThemeMap = {
  'Example Theme': {
    name: 'Example Theme',
    colorCustomizations: {
      'activityBar.activeBackground':   '#021f6299',
      'activityBar.background':         '#021f6299',
      'activityBar.foreground':         '#e7e7e7',
      'activityBar.inactiveForeground': '#e7e7e799',
      'activityBarBadge.background':    '#bb043b',
      'activityBarBadge.foreground':    '#e7e7e7',
      'commandCenter.border':           '#e7e7e799',
      'sash.hoverBorder':               '#021f6299',
      'statusBar.background':           '#010f3099',
      'statusBar.foreground':           '#e7e7e7',
      'statusBarItem.hoverBackground':  '#021f6299',
      'statusBarItem.remoteBackground': '#010f3099',
      'statusBarItem.remoteForeground': '#e7e7e7',
      'titleBar.activeBackground':      '#010f3099',
      'titleBar.activeForeground':      '#e7e7e7',
      'titleBar.inactiveBackground':    '#010f3099',
      'titleBar.inactiveForeground':    '#e7e7e799',
    },
  },
};

function getPollConfig(): { enabled: boolean; intervalMs: number } {
  const cfg = vscode.workspace.getConfiguration('inky.syncPolling');
  return {
    enabled: cfg.get<boolean>('enabled', true),
    intervalMs: cfg.get<number>('intervalSeconds', 30) * 1000,
  };
}

export class CustomThemeStore {
  private readonly fileUri: vscode.Uri;
  private cache: CustomThemeMap = {};
  private watcher: vscode.FileSystemWatcher | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly globalStorageUri: vscode.Uri,
    private readonly globalState: vscode.Memento & { setKeysForSync(keys: readonly string[]): void },
    private readonly log: InkyLogger = NULL_LOGGER,
  ) {
    this.fileUri = vscode.Uri.joinPath(globalStorageUri, THEMES_FILE);
    // setKeysForSync is called in extension.ts alongside STORE_KEY so both keys are registered in a single call (multiple calls overwrite each other)
  }

  // ── public API ─────────────────────────────────────────────────────────────

  /**
   * Load custom themes from globalState (synced) and write to local file.
   * Call once on activation — this is how synced data from another machine
   * gets materialized into the local editing file.
   */
  async load(): Promise<CustomThemeMap> {
    const stored = this.globalState.get<CustomThemeMap>(CUSTOM_THEMES_SYNC_KEY);
    if (stored && Object.keys(stored).length > 0) {
      this.cache = stored;
      this.log.info(`Loaded ${Object.keys(stored).length} custom theme(s) from sync storage — writing to local file`);
      await this.writeFile(this.cache);
    } else {
      try {
        const bytes = await vscode.workspace.fs.readFile(this.fileUri);
        this.cache = JSON.parse(Buffer.from(bytes).toString('utf8')) as CustomThemeMap;
        this.log.info(`No sync data found — loaded ${Object.keys(this.cache).length} custom theme(s) from local file, pushing to sync storage`);
        await this.globalState.update(CUSTOM_THEMES_SYNC_KEY, this.cache);
      } catch {
        this.log.debug('No custom themes found in sync storage or local file — starting empty');
        this.cache = {};
      }
    }
    return this.cache;
  }

  /** In-memory snapshot — always up to date after load() + watch(). */
  get(): CustomThemeMap {
    return this.cache;
  }

  /**
   * Persist map: writes to both globalState (for sync) and the local file
   * (so the editor view stays up to date).
   */
  async save(map: CustomThemeMap): Promise<void> {
    this.cache = map;
    this.log.info(`Saved ${Object.keys(map).length} custom theme(s) — pushing to sync storage and writing local file`);
    await this.globalState.update(CUSTOM_THEMES_SYNC_KEY, map);
    await this.writeFile(map);
  }

  /**
   * Open themes.json in the editor. Creates the file first if it doesn't
   * exist, seeding it with an example entry so the user has something to
   * work from.
   */
  async openInEditor(): Promise<void> {
    await this.ensureDir();
    try {
      await vscode.workspace.fs.stat(this.fileUri);
    } catch {
      const initial = Object.keys(this.cache).length > 0 ? this.cache : TEMPLATE;
      await this.save(initial);
    }
    await vscode.window.showTextDocument(this.fileUri);
  }

  /**
   * Watch themes.json for external changes (user editing it directly).
   * On save: updates globalState + in-memory cache, then calls onChange.
   * Also polls globalState so that Settings Sync changes on another machine
   * are picked up dynamically. Polling is controlled by inky.syncPolling settings.
   */
  watch(onChange: (map: CustomThemeMap) => void): vscode.Disposable {
    const pattern = new vscode.RelativePattern(this.globalStorageUri, THEMES_FILE);
    this.watcher  = vscode.workspace.createFileSystemWatcher(pattern);

    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    const reload = () => {
      if (debounceTimer !== undefined) { clearTimeout(debounceTimer); }
      debounceTimer = setTimeout(async () => {
        debounceTimer = undefined;
        try {
          const bytes = await vscode.workspace.fs.readFile(this.fileUri);
          const text  = Buffer.from(bytes).toString('utf8');
          const parsed = JSON.parse(text) as CustomThemeMap;
          this.cache = parsed;
          this.log.info(`themes.json changed on disk — updated cache (${Object.keys(parsed).length} theme(s)) and pushed to sync storage`);
          await this.globalState.update(CUSTOM_THEMES_SYNC_KEY, parsed);
          onChange(this.cache);
        } catch (err) {
          if (err instanceof SyntaxError) {
            this.log.warn(`themes.json has invalid JSON: ${(err as SyntaxError).message}`);
            vscode.window.showWarningMessage(
              `Inky: themes.json has invalid JSON — fix it and save again. (${(err as SyntaxError).message})`,
            );
          }
          // File deleted mid-session: keep last good cache, don't crash
        }
      }, 200);
    };

    this.watcher.onDidChange(reload);
    this.watcher.onDidCreate(reload);

    const poll = () => {
      const latest = this.globalState.get<CustomThemeMap>(CUSTOM_THEMES_SYNC_KEY);
      if (!latest) { return; }
      if (JSON.stringify(latest) !== JSON.stringify(this.cache)) {
        this.log.info(`Sync poll detected remote theme changes — pulling ${Object.keys(latest).length} theme(s) from sync storage`);
        this.cache = { ...latest };
        void this.writeFile(this.cache).then(() => onChange(this.cache));
      } else {
        this.log.debug('Sync poll: no custom theme changes detected');
      }
    };

    const startPoll = () => {
      this.stopPoll();
      const { enabled, intervalMs } = getPollConfig();
      if (enabled) { this.pollTimer = setInterval(poll, intervalMs); }
    };

    startPoll();

    // Re-configure the timer whenever the user changes the settings
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('inky.syncPolling')) { startPoll(); }
    });

    return new vscode.Disposable(() => this.dispose());
  }

  dispose(): void {
    this.watcher?.dispose();
    this.stopPoll();
  }

  // ── private ────────────────────────────────────────────────────────────────

  private stopPoll(): void {
    if (this.pollTimer !== undefined) { clearInterval(this.pollTimer); this.pollTimer = undefined; }
  }

  private async ensureDir(): Promise<void> {
    await vscode.workspace.fs.createDirectory(this.globalStorageUri);
  }

  private async writeFile(map: CustomThemeMap): Promise<void> {
    await this.ensureDir();
    const text = JSON.stringify(map, null, 2);
    await vscode.workspace.fs.writeFile(this.fileUri, Buffer.from(text, 'utf8'));
  }
}
