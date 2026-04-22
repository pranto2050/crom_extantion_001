// Track if listeners have been initialized
let listenersInitialized = false;
const QUICK_SAVE_COMMAND_NAME = 'quick-save';
const SHORTCUTS_SETTINGS_URL = 'chrome://extensions/shortcuts';
const EXTENSIONS_SETTINGS_URL = 'chrome://extensions';
const SAVE_BUTTON_DEFAULT_LABEL = 'Save to Bookmarks';
const SAVE_ALL_BUTTON_DEFAULT_LABEL = 'Save All Tabs';
const SAVE_BUTTON_ICON = `<svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path><line x1="12" y1="7" x2="12" y2="13"></line><line x1="9" y1="10" x2="15" y2="10"></line></svg>`;
const SAVE_ALL_BUTTON_ICON = `<svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect></svg>`;
const WARNING_BUTTON_ICON = `<svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`;
const BUTTON_SPINNER = '<span class="spinner" aria-hidden="true"></span>';
const POPUP_LOGIN_SYNC_STATE_STORAGE_KEY = 'LumiList_login_sync_state';
const POPUP_SESSION_INVALIDATION_STORAGE_KEY = 'LumiList_session_invalidated';
const SELECT_PAGE_PLACEHOLDER_VALUE = '';
const SELECT_BOARD_PLACEHOLDER_VALUE = '';

let popupActiveTabId = null;
let popupCanSaveCurrentTab = true;

function showBoardSettingRow(visible) {
    const row = document.getElementById('boardSettingRow');
    if (!row) return;
    row.style.display = visible ? 'flex' : 'none';
}

function resetQuickSaveBoardDropdown(select, { disabled = true } = {}) {
    if (!select) return;
    select.innerHTML = '<option value="">Select board</option>';
    select.value = SELECT_BOARD_PLACEHOLDER_VALUE;
    select.disabled = disabled;
}

function updatePopupSaveButtonAvailability() {
    const pageSelect = document.getElementById('quickSavePage');
    const boardSelect = document.getElementById('quickSaveBoard');
    const selectedPageId = pageSelect?.value || SELECT_PAGE_PLACEHOLDER_VALUE;
    const selectedBoardId = boardSelect?.value || SELECT_BOARD_PLACEHOLDER_VALUE;
    const saveReady = popupCanSaveCurrentTab && !!selectedPageId && !!selectedBoardId;
    const label = popupCanSaveCurrentTab ? SAVE_BUTTON_DEFAULT_LABEL : 'Cannot save browser pages';
    const icon = popupCanSaveCurrentTab ? SAVE_BUTTON_ICON : WARNING_BUTTON_ICON;

    setSaveButtonState(icon, label, { disabled: !saveReady, saving: false });
}

function setPopupButtonState(buttonId, iconId, labelId, iconMarkup, labelText, options = {}) {
    const button = document.getElementById(buttonId);
    const iconSlot = document.getElementById(iconId);
    const label = document.getElementById(labelId);
    const { disabled, saving = false } = options;

    if (button) {
        if (typeof disabled === 'boolean') {
            button.disabled = disabled;
        }
        button.classList.toggle('saving', saving);
    }

    if (iconSlot) iconSlot.innerHTML = iconMarkup;
    if (label) label.textContent = labelText;
}

function setSaveButtonState(iconMarkup, labelText, options = {}) {
    setPopupButtonState('saveBtn', 'saveBtnIcon', 'saveBtnLabel', iconMarkup, labelText, options);
}

function setSaveAllButtonState(iconMarkup, labelText, options = {}) {
    setPopupButtonState('saveAllBtn', 'saveAllBtnIcon', 'saveAllBtnLabel', iconMarkup, labelText, options);
}

function normalizeThemeMode(mode) {
    return mode === 'light' ? 'light' : 'dark';
}

async function loadAndApplyThemeMode(options = {}) {
    let resolvedMode = 'dark';
    const trustAccountScopedTheme = options?.trustAccountScopedTheme !== false;

    if (trustAccountScopedTheme) {
        try {
            const result = await chrome.storage.local.get(['themeMode']);
            if (result && (result.themeMode === 'dark' || result.themeMode === 'light')) {
                resolvedMode = result.themeMode;
            } else {
                const cachedMode = localStorage.getItem('LumiList_theme_mode');
                if (cachedMode === 'dark' || cachedMode === 'light') {
                    resolvedMode = cachedMode;
                }
            }
        } catch (error) {
            console.warn('Failed to load popup theme mode from storage:', error);
            const cachedMode = localStorage.getItem('LumiList_theme_mode');
            if (cachedMode === 'dark' || cachedMode === 'light') {
                resolvedMode = cachedMode;
            }
        }
    }

    const normalized = normalizeThemeMode(resolvedMode);
    document.documentElement.setAttribute('data-theme', normalized);

    try {
        localStorage.setItem('LumiList_theme_mode', normalized);
    } catch (e) {
        // non-blocking local cache write
    }
}

async function refreshPopupThemeMode() {
    const popupAccountSyncState = await getPopupAccountSyncState();
    await loadAndApplyThemeMode({
        trustAccountScopedTheme: popupAccountSyncState.isLoggedIn && !popupAccountSyncState.loginSyncPending
    });
}

function isMacPlatform() {
    const platform = navigator.platform || '';
    const userAgent = navigator.userAgent || '';
    return platform.toUpperCase().includes('MAC') || userAgent.toUpperCase().includes('MAC');
}

function getFallbackShortcutLabel() {
    return isMacPlatform() ? 'Cmd+Shift+Y' : 'Ctrl+Shift+Y';
}

function createTab(url) {
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

function getQuickSaveCommand() {
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
            const quickSaveCommand = (commands || []).find(command => command.name === QUICK_SAVE_COMMAND_NAME) || null;
            resolve(quickSaveCommand);
        });
    });
}

function updateShortcutUi(shortcutValue, noteText) {
    const shortcutValueEl = document.getElementById('quickSaveShortcutValue');
    const shortcutNoteEl = document.getElementById('shortcutSettingNote');
    if (shortcutValueEl) shortcutValueEl.textContent = shortcutValue;
    if (shortcutNoteEl) shortcutNoteEl.textContent = noteText;
}

async function loadShortcutSettings() {
    try {
        const quickSaveCommand = await getQuickSaveCommand();
        if (quickSaveCommand && quickSaveCommand.shortcut) {
            updateShortcutUi(
                quickSaveCommand.shortcut,
                'Open browser shortcut settings to change this key.'
            );
        } else {
            updateShortcutUi(
                'Not set',
                'No shortcut assigned. Click Change to set one.'
            );
        }
    } catch (error) {
        console.error('Failed to load quick save shortcut:', error);
        updateShortcutUi(
            getFallbackShortcutLabel(),
            'Could not read shortcut. Click Change to manage it manually.'
        );
    }
}

async function openShortcutSettings() {
    const changeBtn = document.getElementById('changeShortcutBtn');
    const defaultLabel = changeBtn ? changeBtn.textContent : 'Change';

    if (changeBtn) {
        changeBtn.disabled = true;
        changeBtn.textContent = 'Opening...';
    }

    try {
        await createTab(SHORTCUTS_SETTINGS_URL);
        updateShortcutUi(
            document.getElementById('quickSaveShortcutValue')?.textContent || getFallbackShortcutLabel(),
            'Shortcut settings opened in a new tab.'
        );
    } catch (error) {
        console.warn('Failed to open shortcut settings directly:', error);
        try {
            await createTab(EXTENSIONS_SETTINGS_URL);
            updateShortcutUi(
                document.getElementById('quickSaveShortcutValue')?.textContent || getFallbackShortcutLabel(),
                'Opened extensions page. Use "Keyboard shortcuts" there.'
            );
        } catch (fallbackError) {
            console.error('Failed to open extensions page:', fallbackError);
            updateShortcutUi(
                document.getElementById('quickSaveShortcutValue')?.textContent || getFallbackShortcutLabel(),
                'Open chrome://extensions/shortcuts manually.'
            );
        }
    } finally {
        if (changeBtn) {
            changeBtn.disabled = false;
            changeBtn.textContent = defaultLabel;
        }
    }
}

// Get current tab info and display it
async function init() {
    try {
        await refreshPopupThemeMode();
        setSaveButtonState(SAVE_BUTTON_ICON, SAVE_BUTTON_DEFAULT_LABEL, { disabled: true, saving: false });
        setSaveAllButtonState(SAVE_ALL_BUTTON_ICON, SAVE_ALL_BUTTON_DEFAULT_LABEL, { disabled: false, saving: false });

        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        popupActiveTabId = Number.isInteger(tab?.id) ? tab.id : null;
        popupCanSaveCurrentTab = true;

        if (tab) {
            document.getElementById('pageTitle').textContent = tab.title || 'Untitled';
            document.getElementById('pageTitle').title = tab.title || '';
            document.getElementById('pageUrl').textContent = tab.url || '';
            document.getElementById('pageUrl').title = tab.url || '';

            // Check if it's a saveable URL
            if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('about:')) {
                popupCanSaveCurrentTab = false;
            }
        }

        updatePopupSaveButtonAvailability();

        // Count saveable tabs in current window
        const allTabs = await chrome.tabs.query({ currentWindow: true });
        const saveableTabs = allTabs.filter(t =>
            t.url &&
            !t.url.startsWith('chrome://') &&
            !t.url.startsWith('chrome-extension://') &&
            !t.url.startsWith('about:')
        );

        document.getElementById('tabCount').textContent = saveableTabs.length;

        if (saveableTabs.length === 0) {
            document.getElementById('saveAllBtn').disabled = true;
        }

        // Check and display login status
        await updateSyncStatus();

        // Load pages for dropdown after auth state is known so stale account rows do not flash
        await loadPagesDropdown();

        // Show current command shortcut (or unassigned state)
        await loadShortcutSettings();

        // Initialize event listeners only once
        if (!listenersInitialized) {
            initializeEventListeners();
            listenersInitialized = true;
        }

    } catch (error) {
        console.error('Init error:', error);
    }
}

function normalizePopupLoginSyncState(rawState) {
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

async function getPopupAccountSyncState() {
    const result = await chrome.storage.local.get([
        'LumiList_user',
        POPUP_SESSION_INVALIDATION_STORAGE_KEY,
        POPUP_LOGIN_SYNC_STATE_STORAGE_KEY
    ]);
    const activeUserId = (typeof result?.LumiList_user?.id === 'string' && result.LumiList_user.id.trim())
        ? result.LumiList_user.id.trim()
        : null;
    const loginSyncState = normalizePopupLoginSyncState(result?.[POPUP_LOGIN_SYNC_STATE_STORAGE_KEY]);
    const invalidation = result?.[POPUP_SESSION_INVALIDATION_STORAGE_KEY];
    const isLoggedIn = !!activeUserId && !invalidation;
    const loginSyncPending = isLoggedIn
        && loginSyncState?.userId === activeUserId
        && loginSyncState.phase === 'pending';

    return {
        isLoggedIn,
        loginSyncPending,
        activeUserId
    };
}

function resetQuickSavePageDropdown(select, { disabled = false } = {}) {
    if (!select) return;
    select.innerHTML = '<option value="">Select page</option>';
    select.value = SELECT_PAGE_PLACEHOLDER_VALUE;
    select.disabled = disabled;
}

function resetPopupSelectionFlow() {
    const pageSelect = document.getElementById('quickSavePage');
    const boardSelect = document.getElementById('quickSaveBoard');

    if (pageSelect) {
        pageSelect.value = SELECT_PAGE_PLACEHOLDER_VALUE;
    }

    resetQuickSaveBoardDropdown(boardSelect, { disabled: true });
    showBoardSettingRow(false);
    updatePopupSaveButtonAvailability();
}

function setSyncBannerState({ visible, message, showSignInLink }) {
    const banner = document.getElementById('syncBanner');
    const bannerText = banner?.querySelector('.sync-text');
    const signInLink = document.getElementById('signInLink');

    if (banner) {
        banner.classList.toggle('visible', visible);
    }
    if (bannerText && typeof message === 'string') {
        bannerText.textContent = message;
    }
    if (signInLink) {
        signInLink.style.display = showSignInLink ? '' : 'none';
    }
}

function loadBoardsDropdown(pageId) {
    return new Promise((resolve) => {
        const boardSelect = document.getElementById('quickSaveBoard');
        if (!boardSelect) {
            resolve();
            return;
        }

        if (!pageId) {
            resetQuickSaveBoardDropdown(boardSelect, { disabled: true });
            showBoardSettingRow(false);
            updatePopupSaveButtonAvailability();
            resolve();
            return;
        }

        showBoardSettingRow(true);
        resetQuickSaveBoardDropdown(boardSelect, { disabled: true });

        chrome.runtime.sendMessage({ action: 'getBoardsForPage', pageId }, (response) => {
            if (chrome.runtime.lastError) {
                console.error('Failed to load boards:', chrome.runtime.lastError.message);
                resetQuickSaveBoardDropdown(boardSelect, { disabled: true });
                updatePopupSaveButtonAvailability();
                resolve();
                return;
            }

            const boards = Array.isArray(response?.boards) ? response.boards : [];
            if (boards.length > 0) {
                boards.forEach((board) => {
                    const option = document.createElement('option');
                    option.value = board.id;
                    option.textContent = board.name;
                    boardSelect.appendChild(option);
                });

                boardSelect.value = SELECT_BOARD_PLACEHOLDER_VALUE;
                boardSelect.disabled = false;
                updatePopupSaveButtonAvailability();
                resolve();
                return;
            }

            // Fallback: in rare states page-specific query can be empty while boards exist.
            chrome.runtime.sendMessage({ action: 'getShortcutBoardPickerData' }, (fallbackResponse) => {
                if (chrome.runtime.lastError) {
                    console.error('Fallback board loading failed:', chrome.runtime.lastError.message);
                }

                const allBoards = Array.isArray(fallbackResponse?.boards) ? fallbackResponse.boards : [];
                const matchingBoards = allBoards.filter((board) => String(board?.pageId || '') === String(pageId));
                const finalBoards = matchingBoards.length > 0 ? matchingBoards : allBoards;

                if (finalBoards.length === 0) {
                    const option = document.createElement('option');
                    option.value = SELECT_BOARD_PLACEHOLDER_VALUE;
                    option.textContent = 'No board found';
                    boardSelect.appendChild(option);
                    boardSelect.value = SELECT_BOARD_PLACEHOLDER_VALUE;
                    boardSelect.disabled = true;
                    updatePopupSaveButtonAvailability();
                    resolve();
                    return;
                }

                finalBoards.forEach((board) => {
                    const option = document.createElement('option');
                    option.value = board.id;
                    option.textContent = board.name || 'Untitled Board';
                    boardSelect.appendChild(option);
                });

                boardSelect.value = SELECT_BOARD_PLACEHOLDER_VALUE;
                boardSelect.disabled = false;
                updatePopupSaveButtonAvailability();
                resolve();
            });
        });
    });
}

// Load available pages and populate dropdown
async function loadPagesDropdown() {
    const select = document.getElementById('quickSavePage');
    if (!select) return;

    resetPopupSelectionFlow();

    // Request pages list from background script
    chrome.runtime.sendMessage({ action: 'getPages' }, (response) => {
        // Check for lastError first
        if (chrome.runtime.lastError) {
            console.error('Failed to load pages:', chrome.runtime.lastError.message);
            resetQuickSavePageDropdown(select, { disabled: true });
            resetPopupSelectionFlow();
            return;
        }
        if (!response || !response.pages) {
            console.error('Failed to load pages: invalid response');
            resetQuickSavePageDropdown(select, { disabled: true });
            resetPopupSelectionFlow();
            return;
        }

        // Clear existing options (keep "Current Page")
        resetQuickSavePageDropdown(select, { disabled: false });

        // Add each page as an option
        response.pages.forEach(page => {
            const option = document.createElement('option');
            option.value = page.id;
            option.textContent = page.name;
            select.appendChild(option);
        });

        select.value = SELECT_PAGE_PLACEHOLDER_VALUE;
        updatePopupSaveButtonAvailability();
    });
}

// Check login status and update UI accordingly
async function updateSyncStatus() {
    const initialState = document.getElementById('initialState');
    
    // Always show save UI for local-only use
    setSyncBannerState({
        visible: false,
        message: '',
        showSignInLink: false
    });
    if (initialState) initialState.style.display = 'block';
}

// Initialize all event listeners (called once)
function initializeEventListeners() {
    const pageSelect = document.getElementById('quickSavePage');
    const boardSelect = document.getElementById('quickSaveBoard');
    const signInLink = document.getElementById('signInLink');
    const saveBtn = document.getElementById('saveBtn');
    const saveAllBtn = document.getElementById('saveAllBtn');
    const changeShortcutBtn = document.getElementById('changeShortcutBtn');

    // Save page preference when dropdown changes
    if (pageSelect) {
        pageSelect.addEventListener('change', async () => {
            const selectedPageId = pageSelect.value || SELECT_PAGE_PLACEHOLDER_VALUE;
            if (!selectedPageId) {
                showBoardSettingRow(false);
                resetQuickSaveBoardDropdown(boardSelect, { disabled: true });
                updatePopupSaveButtonAvailability();
                return;
            }

            try {
                await chrome.storage.local.set({ quickSavePageId: selectedPageId });
            } catch (error) {
                console.error('Failed to store selected page in popup:', error);
            }

            await loadBoardsDropdown(selectedPageId);
        });
    }

    if (boardSelect) {
        boardSelect.addEventListener('change', () => {
            updatePopupSaveButtonAvailability();
        });
    }

    // Sign in link opens newtab
    if (signInLink) {
        signInLink.addEventListener('click', (e) => {
            e.preventDefault();
            chrome.tabs.create({ url: chrome.runtime.getURL('newtab.html') });
            window.close();
        });
    }

    if (changeShortcutBtn) {
        changeShortcutBtn.addEventListener('click', async () => {
            await openShortcutSettings();
        });
    }

    window.addEventListener('focus', () => {
        loadShortcutSettings().catch(err => console.error('Failed to refresh shortcut on focus:', err));
        loadPagesDropdown().catch((err) => console.error('Failed to refresh popup pages on focus:', err));
    });

    // Handle save button click
    if (saveBtn) {
        saveBtn.addEventListener('click', async function () {
            const pageSelect = document.getElementById('quickSavePage');
            const boardSelect = document.getElementById('quickSaveBoard');
            const selectedPageId = pageSelect?.value || SELECT_PAGE_PLACEHOLDER_VALUE;
            const selectedBoardId = boardSelect?.value || SELECT_BOARD_PLACEHOLDER_VALUE;
            if (!popupCanSaveCurrentTab || !selectedPageId || !selectedBoardId) {
                updatePopupSaveButtonAvailability();
                return;
            }

            setSaveButtonState(BUTTON_SPINNER, 'Saving...', { disabled: true, saving: true });

            chrome.runtime.sendMessage({
                action: 'quickSaveToBoard',
                boardId: selectedBoardId,
                tabId: popupActiveTabId
            }, (response) => {
                document.getElementById('initialState').classList.remove('active');

                // Check for lastError first
                if (chrome.runtime.lastError) {
                    console.error('Quick save error:', chrome.runtime.lastError.message);
                    document.getElementById('errorState').classList.add('active');
                    document.getElementById('errorMessage').textContent = 'Extension error. Try reloading.';
                    updatePopupSaveButtonAvailability();
                    return;
                }
                if (!response) {
                    console.error('Quick save error: no response');
                    document.getElementById('errorState').classList.add('active');
                    document.getElementById('errorMessage').textContent = 'Extension error. Try reloading.';
                    updatePopupSaveButtonAvailability();
                    return;
                }

                if (response.success) {
                    if (response.message.includes('Already')) {
                        document.getElementById('alreadyState').classList.add('active');
                    } else {
                        document.getElementById('successState').classList.add('active');
                        const targetLabel = [response.boardName, response.pageName].filter(Boolean).join(' • ');
                        document.getElementById('pageName').textContent = targetLabel || response.pageName || 'selected board';
                    }
                    // Auto-close after success
                    setTimeout(() => window.close(), 1500);
                } else {
                    document.getElementById('errorState').classList.add('active');
                    document.getElementById('errorMessage').textContent = response.message;
                    updatePopupSaveButtonAvailability();
                }
            });
        });
    }

    // Handle Save All Tabs button click
    if (saveAllBtn) {
        saveAllBtn.addEventListener('click', async function () {
            setSaveAllButtonState(BUTTON_SPINNER, 'Saving all tabs...', { disabled: true, saving: true });

            chrome.runtime.sendMessage({ action: 'saveAllTabs' }, (response) => {
                document.getElementById('initialState').classList.remove('active');

                // Check for lastError first
                if (chrome.runtime.lastError) {
                    console.error('Save all tabs error:', chrome.runtime.lastError.message);
                    document.getElementById('errorState').classList.add('active');
                    document.getElementById('errorMessage').textContent = 'Extension error. Try reloading.';
                    // Re-enable button after error
                    setSaveAllButtonState(SAVE_ALL_BUTTON_ICON, SAVE_ALL_BUTTON_DEFAULT_LABEL, { disabled: false, saving: false });
                    return;
                }
                if (!response) {
                    console.error('Save all tabs error: no response');
                    document.getElementById('errorState').classList.add('active');
                    document.getElementById('errorMessage').textContent = 'Extension error. Try reloading.';
                    // Re-enable button after error
                    setSaveAllButtonState(SAVE_ALL_BUTTON_ICON, SAVE_ALL_BUTTON_DEFAULT_LABEL, { disabled: false, saving: false });
                    return;
                }

                if (response.success) {
                    document.getElementById('saveAllSuccessState').classList.add('active');
                    document.getElementById('savedTabCount').textContent = response.savedCount || 0;
                    document.getElementById('saveAllPageName').textContent = response.pageName || 'your page';
                    // Auto-close after success
                    setTimeout(() => window.close(), 2000);
                } else {
                    document.getElementById('errorState').classList.add('active');

                    if (response.exceedsLimit) {
                        document.getElementById('errorMessage').textContent =
                            `Too many tabs (${response.tabCount}). Maximum: ${response.limit}. Close some tabs and try again.`;
                    } else {
                        document.getElementById('errorMessage').textContent = response.message;
                    }

                    // Re-enable button after error
                    setSaveAllButtonState(SAVE_ALL_BUTTON_ICON, SAVE_ALL_BUTTON_DEFAULT_LABEL, { disabled: false, saving: false });
                }
            });
        });
    }
}

// Initialize on load
init();

if (chrome?.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local') return;

        const popupAccountBoundaryChanged =
            changes.LumiList_user
            || changes.LumiList_session_invalidated
            || changes[POPUP_LOGIN_SYNC_STATE_STORAGE_KEY];

        if (changes.themeMode || popupAccountBoundaryChanged) {
            refreshPopupThemeMode().catch((error) => {
                console.error('Failed to refresh popup theme mode after storage change:', error);
            });
        }

        if (popupAccountBoundaryChanged) {
            Promise.all([
                updateSyncStatus(),
                loadPagesDropdown()
            ]).catch((error) => {
                console.error('Failed to refresh popup sync state:', error);
            });
        }
    });
}
