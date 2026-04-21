(function registerLumiListQuickSaveSettingsFeature(global) {
    const modules = global.LumiListModules || (global.LumiListModules = {});
    const features = modules.features || (modules.features = {});

    features.quickSaveSettings = function createQuickSaveSettingsFeature(options) {
        const {
            db,
            quickSaveCommandName,
            shortcutsSettingsUrl,
            extensionsSettingsUrl
        } = options;
        const QUICK_SAVE_SETTINGS_LOGIN_SYNC_STATE_STORAGE_KEY = 'lumilist_login_sync_state';
        const QUICK_SAVE_SETTINGS_SESSION_INVALIDATED_STORAGE_KEY = 'lumilist_session_invalidated';

        function normalizeQuickSaveSettingsLoginSyncState(rawState) {
            if (!rawState || typeof rawState !== 'object') return null;
            const userId = (typeof rawState.userId === 'string' && rawState.userId.trim())
                ? rawState.userId.trim()
                : null;
            const phase = (typeof rawState.phase === 'string' && rawState.phase.trim())
                ? rawState.phase.trim()
                : null;

            if (!userId || !phase) return null;

            return {
                userId,
                phase
            };
        }

        async function getQuickSaveSettingsAccountState() {
            const result = await chrome.storage.local.get([
                'lumilist_user',
                QUICK_SAVE_SETTINGS_SESSION_INVALIDATED_STORAGE_KEY,
                QUICK_SAVE_SETTINGS_LOGIN_SYNC_STATE_STORAGE_KEY
            ]);
            const activeUserId = (typeof result?.lumilist_user?.id === 'string' && result.lumilist_user.id.trim())
                ? result.lumilist_user.id.trim()
                : null;
            const loginSyncState = normalizeQuickSaveSettingsLoginSyncState(
                result?.[QUICK_SAVE_SETTINGS_LOGIN_SYNC_STATE_STORAGE_KEY]
            );
            const isLoggedIn = !!activeUserId && !result?.[QUICK_SAVE_SETTINGS_SESSION_INVALIDATED_STORAGE_KEY];
            const loginSyncPending = isLoggedIn
                && loginSyncState?.userId === activeUserId
                && loginSyncState.phase === 'pending';

            return {
                isLoggedIn,
                loginSyncPending
            };
        }

        function resetSettingsQuickSaveDestinationOptions(select, { disabled = false } = {}) {
            if (!select) return;
            select.innerHTML = '<option value="current">Current Page</option>';
            select.value = 'current';
            select.disabled = disabled;
        }

        function isMacPlatformForQuickSaveSettings() {
            const platform = navigator.platform || '';
            const userAgent = navigator.userAgent || '';
            return platform.toUpperCase().includes('MAC') || userAgent.toUpperCase().includes('MAC');
        }

        function getQuickSaveFallbackShortcutLabel() {
            return isMacPlatformForQuickSaveSettings() ? 'Cmd+Shift+Y' : 'Ctrl+Shift+Y';
        }

        function updateSettingsQuickSaveShortcutUi(shortcutValue, noteText) {
            const shortcutValueEl = document.getElementById('settingsQuickSaveShortcutValue');
            const shortcutNoteEl = document.getElementById('settingsQuickSaveShortcutNote');
            if (shortcutValueEl) shortcutValueEl.textContent = shortcutValue;
            if (shortcutNoteEl) shortcutNoteEl.textContent = noteText;
        }

        function createSettingsTab(url) {
            return new Promise((resolve, reject) => {
                chrome.tabs.create({ url }, (tab) => {
                    if (chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message));
                        return;
                    }
                    resolve(tab);
                });
            });
        }

        function getQuickSaveCommandDetails() {
            return new Promise((resolve, reject) => {
                if (!chrome.commands || !chrome.commands.getAll) {
                    resolve(null);
                    return;
                }

                chrome.commands.getAll((commands) => {
                    if (chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message));
                        return;
                    }

                    const quickSaveCommand = (commands || []).find((command) => command.name === quickSaveCommandName) || null;
                    resolve(quickSaveCommand);
                });
            });
        }

        async function loadSettingsQuickSaveShortcut() {
            try {
                const quickSaveCommand = await getQuickSaveCommandDetails();
                if (quickSaveCommand && quickSaveCommand.shortcut) {
                    updateSettingsQuickSaveShortcutUi(
                        quickSaveCommand.shortcut,
                        'Open browser shortcut settings to change this key.'
                    );
                } else {
                    updateSettingsQuickSaveShortcutUi(
                        'Not set',
                        'No shortcut assigned. Click Change to set one.'
                    );
                }
            } catch (error) {
                console.error('Failed to load quick save shortcut in settings:', error);
                updateSettingsQuickSaveShortcutUi(
                    getQuickSaveFallbackShortcutLabel(),
                    'Could not read shortcut. Click Change to manage it manually.'
                );
            }
        }

        async function openQuickSaveShortcutSettings() {
            const button = document.getElementById('settingsChangeShortcutBtn');
            const originalText = button ? button.textContent : 'Change';

            if (button) {
                button.disabled = true;
                button.textContent = 'Opening...';
            }

            try {
                await createSettingsTab(shortcutsSettingsUrl);
                updateSettingsQuickSaveShortcutUi(
                    document.getElementById('settingsQuickSaveShortcutValue')?.textContent || getQuickSaveFallbackShortcutLabel(),
                    'Shortcut settings opened in a new tab.'
                );
            } catch (error) {
                console.warn('Failed to open shortcut settings directly:', error);
                try {
                    await createSettingsTab(extensionsSettingsUrl);
                    updateSettingsQuickSaveShortcutUi(
                        document.getElementById('settingsQuickSaveShortcutValue')?.textContent || getQuickSaveFallbackShortcutLabel(),
                        'Opened extensions page. Use "Keyboard shortcuts" there.'
                    );
                } catch (fallbackError) {
                    console.error('Failed to open extensions settings page:', fallbackError);
                    updateSettingsQuickSaveShortcutUi(
                        document.getElementById('settingsQuickSaveShortcutValue')?.textContent || getQuickSaveFallbackShortcutLabel(),
                        'Open chrome://extensions/shortcuts manually.'
                    );
                }
            } finally {
                if (button) {
                    button.disabled = false;
                    button.textContent = originalText;
                }
            }
        }

        async function loadSettingsQuickSaveDestinationOptions() {
            const select = document.getElementById('settingsQuickSavePage');
            if (!select) return;

            const accountState = await getQuickSaveSettingsAccountState();
            if (!accountState.isLoggedIn || accountState.loginSyncPending) {
                resetSettingsQuickSaveDestinationOptions(select, { disabled: true });
                return;
            }

            let pages = [];
            try {
                pages = await db.pages.orderBy('order').filter((page) => !page.deletedAt).toArray();
            } catch (error) {
                console.error('Failed to load pages for quick save destination setting:', error);
            }

            const latestAccountState = await getQuickSaveSettingsAccountState();
            if (!latestAccountState.isLoggedIn || latestAccountState.loginSyncPending) {
                resetSettingsQuickSaveDestinationOptions(select, { disabled: true });
                return;
            }

            resetSettingsQuickSaveDestinationOptions(select, { disabled: false });

            const validPageIds = new Set();
            pages.forEach((page) => {
                validPageIds.add(page.id);
                const option = document.createElement('option');
                option.value = page.id;
                option.textContent = page.name;
                select.appendChild(option);
            });

            try {
                const result = await chrome.storage.local.get(['quickSavePageId']);
                const storedId = result.quickSavePageId;

                if (storedId && storedId !== 'current' && validPageIds.has(storedId)) {
                    select.value = storedId;
                } else {
                    select.value = 'current';
                    if (storedId && storedId !== 'current') {
                        await chrome.storage.local.set({ quickSavePageId: 'current' });
                    }
                }
            } catch (error) {
                console.error('Failed to load quickSavePageId in settings:', error);
                select.value = 'current';
            }
        }

        async function refreshSettingsQuickSaveControls() {
            await Promise.all([
                loadSettingsQuickSaveShortcut(),
                loadSettingsQuickSaveDestinationOptions()
            ]);
        }

        return {
            isMacPlatformForQuickSaveSettings,
            getQuickSaveFallbackShortcutLabel,
            updateSettingsQuickSaveShortcutUi,
            createSettingsTab,
            getQuickSaveCommandDetails,
            loadSettingsQuickSaveShortcut,
            openQuickSaveShortcutSettings,
            getQuickSaveSettingsAccountState,
            loadSettingsQuickSaveDestinationOptions,
            refreshSettingsQuickSaveControls
        };
    };
})(window);
