import * as vscode from 'vscode';
import { THEMES } from './themes';
import { CustomThemeStore, CUSTOM_THEMES_SYNC_KEY, NULL_LOGGER, type InkyLogger } from './customThemes';

const STORE_KEY = 'inky.mappings';

const BUILTIN_PREFIX = 'builtin:';
const CUSTOM_PREFIX = 'custom:';

// folder name → themeId  (e.g. "builtin:Obsidian" | "custom:MyNavy")
type InkyStore = Record<string, string>;

// ─── helpers ────────────────────────────────────────────────────────────────

function workspaceKey(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.name;
}

function getStore(ctx: vscode.ExtensionContext): InkyStore {
  const raw = ctx.globalState.get<Record<string, unknown>>(STORE_KEY) ?? {};
  const store: InkyStore = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string') { store[k] = v; }
  }
  return store;
}

async function saveStore(ctx: vscode.ExtensionContext, store: InkyStore): Promise<void> {
  await ctx.globalState.update(STORE_KEY, store);
}

function resolveColors(
  themeId: string,
  customStore: CustomThemeStore,
): Record<string, string> | undefined {
  if (themeId.startsWith(BUILTIN_PREFIX)) {
    const name = themeId.slice(BUILTIN_PREFIX.length);
    return THEMES.find(t => t.name === name)?.colorCustomizations;
  }
  if (themeId.startsWith(CUSTOM_PREFIX)) {
    const name = themeId.slice(CUSTOM_PREFIX.length);
    return customStore.get()[name]?.colorCustomizations;
  }
  return undefined;
}

function currentColors(): Record<string, string> {
  return {
    ...(vscode.workspace
      .getConfiguration('workbench')
      .get<Record<string, string>>('colorCustomizations') ?? {}),
  };
}

async function applyColors(
  newColors: Record<string, string>,
  oldColorKeys?: string[],
): Promise<void> {
  const current = currentColors();
  if (oldColorKeys) {
    for (const key of oldColorKeys) { delete current[key]; }
  }
  const merged = { ...current, ...newColors };
  await vscode.workspace.getConfiguration().update(
    'workbench.colorCustomizations',
    Object.keys(merged).length > 0 ? merged : undefined,
    vscode.ConfigurationTarget.Global,
  );
}

/** Remove only the specified keys from colorCustomizations. */
async function removeColors(keysToRemove: string[]): Promise<void> {
  const current = currentColors();
  for (const key of keysToRemove) { delete current[key]; }
  await vscode.workspace.getConfiguration().update(
    'workbench.colorCustomizations',
    Object.keys(current).length > 0 ? current : undefined,
    vscode.ConfigurationTarget.Global,
  );
}

/** Show a quick pick using createQuickPick to avoid VS Code proxy issues with showQuickPick. */
function pickOne(
  items: vscode.QuickPickItem[],
  placeholder: string,
): Promise<vscode.QuickPickItem | undefined> {
  return new Promise(resolve => {
    const qp = vscode.window.createQuickPick();
    qp.items = items;
    qp.placeholder = placeholder;
    let accepted = false;
    qp.onDidAccept(() => { accepted = true; const item = qp.activeItems[0]; qp.dispose(); resolve(item); });
    qp.onDidHide(() => { if (!accepted) { resolve(undefined); } });
    qp.show();
  });
}

// ─── activate ───────────────────────────────────────────────────────────────

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  // Register ALL synced keys in one call — setKeysForSync replaces, not appends
  ctx.globalState.setKeysForSync([STORE_KEY, CUSTOM_THEMES_SYNC_KEY]);

  // ── logger (opt-in, zero footprint when disabled) ───────────────────────────
  let channel: vscode.LogOutputChannel | undefined;
  let log: InkyLogger = NULL_LOGGER;

  const applyLoggingConfig = () => {
    const enabled = vscode.workspace.getConfiguration('inky').get<boolean>('logging', false);
    if (enabled && !channel) {
      channel = vscode.window.createOutputChannel('Inky', { log: true });
      ctx.subscriptions.push(channel);
      log = channel;
    } else if (!enabled && channel) {
      // Dispose the channel; null out references so it disappears from the Output list
      channel.dispose();
      channel = undefined;
      log = NULL_LOGGER;
    }
  };

  applyLoggingConfig();
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('inky.logging')) { applyLoggingConfig(); }
    }),
  );

  log.info('Inky activating');
  // ── custom theme store (file-based, synced via globalState) ───────────────
  const customStore = new CustomThemeStore(ctx.globalStorageUri, ctx.globalState, log);
  ctx.subscriptions.push(customStore);

  await customStore.load();

  // ── apply stored theme for this workspace ─────────────────────────────────
  const wsKey = workspaceKey();
  if (wsKey) {
    const store = getStore(ctx);
    const themeId = store[wsKey];
    if (themeId) {
      const colors = resolveColors(themeId, customStore);
      if (colors) {
        log.info(`Applying stored theme "${themeId}" for workspace "${wsKey}"`);
        await applyColors(colors);
      } else {
        log.warn(`Stored theme "${themeId}" for workspace "${wsKey}" could not be resolved — removing dangling reference`);
        delete store[wsKey];
        await saveStore(ctx, store);
      }
    } else {
      log.debug(`No theme stored for workspace "${wsKey}"`);
    }
  }

  // ── file watcher: re-apply if active custom theme changes on disk ─────────
  ctx.subscriptions.push(
    customStore.watch((_updatedMap) => {
      const key = workspaceKey();
      if (!key) { return; }
      const store = getStore(ctx);
      const themeId = store[key];
      if (!themeId?.startsWith(CUSTOM_PREFIX)) { return; }

      const colors = resolveColors(themeId, customStore);
      if (colors) {
        log.info(`Custom theme "${themeId}" updated — re-applying to workspace "${key}"`);
        applyColors(colors).catch(err => {
          log.error(`Failed to re-apply theme after edit: ${err}`);
          vscode.window.showErrorMessage(`Inky: failed to re-apply theme after edit — ${err}`);
        });
      }
    }),
  );

  // ── polling: pick up workspace mapping changes pushed by Settings Sync ────
  // (custom theme polling is handled inside CustomThemeStore.watch())
  let mappingPollTimer: ReturnType<typeof setInterval> | undefined;

  const startMappingPoll = () => {
    if (mappingPollTimer !== undefined) { clearInterval(mappingPollTimer); mappingPollTimer = undefined; }
    const cfg = vscode.workspace.getConfiguration('inky.syncPolling');
    if (!cfg.get<boolean>('enabled', true)) { return; }
    const intervalMs = cfg.get<number>('intervalSeconds', 30) * 1000;
    mappingPollTimer = setInterval(async () => {
      const key = workspaceKey();
      if (!key) { return; }
      const store = getStore(ctx);
      const themeId = store[key];
      if (!themeId) {
        log.debug(`Mapping poll: no theme stored for workspace "${key}"`);
        return;
      }
      log.debug(`Mapping poll: checking theme "${themeId}" for workspace "${key}"`);
      const colors = resolveColors(themeId, customStore);
      if (colors) {
        await applyColors(colors);
      }
    }, intervalMs);
  };

  startMappingPoll();
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('inky.syncPolling')) { startMappingPoll(); }
    }),
    new vscode.Disposable(() => { if (mappingPollTimer !== undefined) { clearInterval(mappingPollTimer); } }),
  );

  // window focus: re-apply this workspace's theme when the window gains focus ──
  ctx.subscriptions.push(
    vscode.window.onDidChangeWindowState(async (state) => {
      if (!state.focused) { return; }
      const key = workspaceKey();
      if (!key) { return; }
      const store = getStore(ctx);
      const themeId = store[key];
      if (!themeId) { return; }
      const colors = resolveColors(themeId, customStore);
      if (colors) {
        log.debug(`Window focused — re-applying theme "${themeId}" for workspace "${key}"`);
        await applyColors(colors);
      }
    }),
  );

  // ── command: set theme ───────────────────────────────────────────────────
  ctx.subscriptions.push(
    vscode.commands.registerCommand('inky.setTheme', async () => {
      const key = workspaceKey();
      if (!key) {
        vscode.window.showWarningMessage('Inky: no workspace folder is open.');
        return;
      }

      const store = getStore(ctx);
      const activeId = store[key];

      const SAVE_LABEL = '$(add) Save current colors as custom theme\u2026';
      const EDIT_LABEL = '$(edit) Edit custom themes file\u2026';

      const items: vscode.QuickPickItem[] = [];
      const themeIdByLabel = new Map<string, string>();

      // ── custom themes ──
      const customEntries = Object.entries(customStore.get());
      if (customEntries.length > 0) {
        items.push({ label: 'Custom', kind: vscode.QuickPickItemKind.Separator });
        for (const [name] of customEntries) {
          const id = `${CUSTOM_PREFIX}${name}`;
          themeIdByLabel.set(name, id);
          items.push({ label: name, description: activeId === id ? '\u25cf active' : '' });
        }
      }

      // ── actions ──
      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
      items.push({ label: SAVE_LABEL });
      items.push({ label: EDIT_LABEL });

      // ── built-in themes ──
      items.push({ label: 'Built-in', kind: vscode.QuickPickItemKind.Separator });
      for (const t of THEMES) {
        const id = `${BUILTIN_PREFIX}${t.name}`;
        themeIdByLabel.set(t.name, id);
        items.push({ label: t.name, description: activeId === id ? '\u25cf active' : '' });
      }

      // Snapshot colors before preview; strip active Inky keys to get the non-Inky base
      const originalColors = currentColors();
      const nonInkyColors = { ...originalColors };
      for (const k of Object.keys(resolveColors(activeId ?? '', customStore) ?? {})) {
        delete nonInkyColors[k];
      }

      const picked = await new Promise<vscode.QuickPickItem | undefined>(resolve => {
        const qp = vscode.window.createQuickPick();
        qp.items = items;
        qp.placeholder = 'Pick a theme \u2014 or save / edit your custom themes';

        // Pre-highlight the currently active theme
        if (activeId) {
          const activeItem = items.find(item => themeIdByLabel.get(item.label) === activeId);
          if (activeItem) { qp.activeItems = [activeItem]; }
        }

        let accepted = false;

        qp.onDidChangeActive(active => {
          const themeId = active[0] ? themeIdByLabel.get(active[0].label) : undefined;
          const previewColors = themeId ? resolveColors(themeId, customStore) : undefined;
          const toWrite = previewColors ? { ...nonInkyColors, ...previewColors } : originalColors;
          void vscode.workspace.getConfiguration().update(
            'workbench.colorCustomizations',
            Object.keys(toWrite).length > 0 ? toWrite : undefined,
            vscode.ConfigurationTarget.Global,
          );
        });

        qp.onDidAccept(() => {
          accepted = true;
          const item = qp.activeItems[0];
          qp.dispose();
          resolve(item);
        });

        qp.onDidHide(() => {
          if (!accepted) {
            void vscode.workspace.getConfiguration().update(
              'workbench.colorCustomizations',
              Object.keys(originalColors).length > 0 ? originalColors : undefined,
              vscode.ConfigurationTarget.Global,
            );
            resolve(undefined);
          }
        });

        qp.show();
      });

      if (!picked) { return; }

      // ── edit custom themes ──
      if (picked.label === EDIT_LABEL) {
        await vscode.commands.executeCommand('inky.editCustomThemes');
        return;
      }

      // ── save current colors as new custom theme ──
      if (picked.label === SAVE_LABEL) {
        const name = await vscode.window.showInputBox({
          prompt: 'Name for this theme',
          placeHolder: 'e.g. My Navy',
          validateInput: v => v.trim() ? undefined : 'Name cannot be empty',
        });
        if (!name) { return; }

        const trimmed = name.trim();
        // Use pre-picker snapshot to avoid reading back preview-modified config
        const allColors = originalColors;
        if (Object.keys(allColors).length === 0) {
          vscode.window.showWarningMessage('Inky: no colorCustomizations found in current settings.');
          return;
        }

        let colorsToSave = allColors;

        // Check if settings contain colors beyond the active Inky theme
        if (activeId) {
          const activeColors = resolveColors(activeId, customStore);
          if (activeColors) {
            const inkyKeys = new Set(Object.keys(activeColors));
            const extraKeys = Object.keys(allColors).filter(k => !inkyKeys.has(k));

            if (extraKeys.length > 0) {
              const SAVE_ALL_LABEL = '$(file) Save all color customizations';
              const THEME_ONLY_LABEL = '$(filter) Save only active theme colors';
              const choice = await pickOne([
                {
                  label: SAVE_ALL_LABEL,
                  description: `${Object.keys(allColors).length} keys`,
                  detail: [
                    'Your settings contain colors beyond the active Inky theme',
                    `(e.g. ${extraKeys.slice(0, 3).join(', ')}${extraKeys.length > 3 ? ', \u2026' : ''}).`,
                    'This option saves everything as one theme.',
                  ].join(' '),
                },
                {
                  label: THEME_ONLY_LABEL,
                  description: `${Object.keys(activeColors).length} keys`,
                  detail: 'Saves only the colors from the currently active Inky theme, excluding your manual customizations.',
                },
              ], 'Which colors should be included in the new theme?');
              if (!choice) { return; }
              if (choice.label === THEME_ONLY_LABEL) {
                colorsToSave = Object.fromEntries(
                  Object.entries(allColors).filter(([k]) => inkyKeys.has(k)),
                );
              }
            }
          }
        }

        const updated = customStore.get();
        updated[trimmed] = { name: trimmed, colorCustomizations: colorsToSave };
        await customStore.save(updated);

        const id = `${CUSTOM_PREFIX}${trimmed}`;
        store[key] = id;
        await saveStore(ctx, store);
        vscode.window.showInformationMessage(`Inky: "${trimmed}" saved and applied.`);
        return;
      }

      // ── apply chosen theme ──
      const pickedThemeId = themeIdByLabel.get(picked.label);
      if (!pickedThemeId) { return; }

      const oldColors = activeId ? resolveColors(activeId, customStore) : undefined;
      store[key] = pickedThemeId;
      await saveStore(ctx, store);

      const colors = resolveColors(pickedThemeId, customStore);
      if (colors) {
        await applyColors(colors, oldColors ? Object.keys(oldColors) : undefined);
        log.info(`Applied theme "${pickedThemeId}" to workspace "${key}"`);
        vscode.window.showInformationMessage(`Inky: "${picked.label}" applied.`);
      }
    }),
  );

  // ── command: edit custom themes ──────────────────────────────────────────
  ctx.subscriptions.push(
    vscode.commands.registerCommand('inky.editCustomThemes', async () => {
      await customStore.openInEditor();
    }),
  );

  // ── command: clear theme ─────────────────────────────────────────────────
  ctx.subscriptions.push(
    vscode.commands.registerCommand('inky.clearTheme', async () => {
      const key = workspaceKey();
      if (!key) {
        vscode.window.showWarningMessage('Inky: no workspace folder is open.');
        return;
      }

      const store = getStore(ctx);
      const themeId = store[key];
      if (!themeId) {
        vscode.window.showInformationMessage('Inky: no theme set for this workspace.');
        return;
      }

      const colors = resolveColors(themeId, customStore);
      delete store[key];
      await saveStore(ctx, store);
      if (colors) {
        await removeColors(Object.keys(colors));
      }
      vscode.window.showInformationMessage('Inky: theme cleared.');
    }),
  );

  // ── command: list all mappings ───────────────────────────────────────────
  ctx.subscriptions.push(
    vscode.commands.registerCommand('inky.listMappings', async () => {
      const store = getStore(ctx);
      const entries = Object.entries(store);

      if (entries.length === 0) {
        vscode.window.showInformationMessage('Inky: no workspace themes saved yet.');
        return;
      }

      const pathByLabel = new Map<string, string>();
      const items = entries.map(([path, themeId]) => {
        const label = path === workspaceKey() ? `$(check) ${path}` : path;
        pathByLabel.set(label, path);
        return { label, description: themeId, detail: path === workspaceKey() ? 'current workspace' : '' };
      });

      const picked = await pickOne(items, 'Saved workspace themes \u2014 pick one to remove it');
      if (!picked) { return; }

      const pickedPath = pathByLabel.get(picked.label);
      if (!pickedPath) { return; }

      const confirm = await pickOne(
        [{ label: 'Yes, remove it' }, { label: 'Cancel' }],
        `Remove theme for "${pickedPath}"?`,
      );
      if (confirm?.label !== 'Yes, remove it') { return; }

      delete store[pickedPath];
      await saveStore(ctx, store);

      if (pickedPath === workspaceKey() && picked.description) {
        const colors = resolveColors(picked.description, customStore);
        if (colors) {
          await removeColors(Object.keys(colors));
        }
      }

      vscode.window.showInformationMessage(`Inky: removed theme for "${pickedPath}".`);
    }),
  );

  // ── command: debug ───────────────────────────────────────────────────────
  ctx.subscriptions.push(
    vscode.commands.registerCommand('inky.debug', () => {
      const data = {
        mappings: getStore(ctx),
        customThemes: customStore.get(),
        themesFile: ctx.globalStorageUri.fsPath + '/themes.json',
      };
      console.log('[inky]', JSON.stringify(data, null, 2));
      vscode.window.showInformationMessage('Inky: state dumped to Developer Console (Help → Toggle Developer Tools).');
    }),
  );

  // ── command: reset all ───────────────────────────────────────────────────
  ctx.subscriptions.push(
    vscode.commands.registerCommand('inky.resetAll', async () => {
      const confirm = await pickOne(
        [{ label: 'Yes, wipe everything' }, { label: 'Cancel' }],
        'Deletes all mappings, custom themes file, and applied colors.',
      );
      if (confirm?.label !== 'Yes, wipe everything') { return; }

      await ctx.globalState.update(STORE_KEY, undefined);
      await ctx.globalState.update(CUSTOM_THEMES_SYNC_KEY, undefined);
      try {
        await vscode.workspace.getConfiguration().update(
          'workbench.colorCustomizations',
          undefined,
          vscode.ConfigurationTarget.Global,
        );
        await vscode.workspace.fs.delete(
          vscode.Uri.joinPath(ctx.globalStorageUri, 'themes.json'),
        );
      } catch { /* already gone */ }
      vscode.window.showInformationMessage('Inky: all data cleared.');
    }),
  );
}

export function deactivate(): void { }