const BOARD_DEFAULT_STORAGE_KEY = 'shortcutDefaultBoardId';
const BOARD_LAST_USED_STORAGE_KEY = 'shortcutLastBoardId';
const BOARD_USE_LAST_STORAGE_KEY = 'shortcutUseLastBoard';

function parseTabIdFromQuery() {
    const params = new URLSearchParams(window.location.search || '');
    const raw = params.get('tabId');
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function setStatus(message, type = '') {
    const statusEl = document.getElementById('statusText');
    if (!statusEl) return;
    statusEl.textContent = message || '';
    statusEl.classList.remove('error', 'success');
    if (type) statusEl.classList.add(type);
}

function isSaveableUrl(url) {
    if (!url || typeof url !== 'string') return false;
    const lower = url.toLowerCase();
    return !(
        lower.startsWith('chrome://') ||
        lower.startsWith('chrome-extension://') ||
        lower.startsWith('about:') ||
        lower.startsWith('edge://') ||
        lower.startsWith('devtools://')
    );
}

async function getTargetTab(tabIdFromQuery) {
    if (Number.isInteger(tabIdFromQuery)) {
        try {
            const tab = await chrome.tabs.get(tabIdFromQuery);
            if (tab) return tab;
        } catch (error) {
            console.warn('Failed to resolve tab from query id:', error);
        }
    }

    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return activeTab || null;
}

function renderBoards(select, boards) {
    select.innerHTML = '';

    if (!Array.isArray(boards) || boards.length === 0) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'No boards found';
        select.appendChild(option);
        select.disabled = true;
        return;
    }

    const groups = new Map();
    boards.forEach((board) => {
        const pageName = board.pageName || 'Untitled Page';
        if (!groups.has(pageName)) groups.set(pageName, []);
        groups.get(pageName).push(board);
    });

    groups.forEach((pageBoards, pageName) => {
        const optgroup = document.createElement('optgroup');
        optgroup.label = pageName;

        pageBoards.forEach((board) => {
            const option = document.createElement('option');
            option.value = board.id;
            option.textContent = board.name || 'Untitled Board';
            optgroup.appendChild(option);
        });

        select.appendChild(optgroup);
    });

    select.disabled = false;
}

async function loadShortcutBoardPreference(validBoardIds) {
    const storage = await chrome.storage.local.get([
        BOARD_DEFAULT_STORAGE_KEY,
        BOARD_LAST_USED_STORAGE_KEY,
        BOARD_USE_LAST_STORAGE_KEY
    ]);

    const useLast = storage?.[BOARD_USE_LAST_STORAGE_KEY] === true;
    const lastId = storage?.[BOARD_LAST_USED_STORAGE_KEY];
    const defaultId = storage?.[BOARD_DEFAULT_STORAGE_KEY];

    if (useLast && typeof lastId === 'string' && validBoardIds.has(lastId)) {
        return lastId;
    }

    if (typeof defaultId === 'string' && validBoardIds.has(defaultId)) {
        return defaultId;
    }

    return null;
}

async function initialize() {
    const boardSelect = document.getElementById('boardSelect');
    const saveBtn = document.getElementById('saveBtn');
    const cancelBtn = document.getElementById('cancelBtn');
    const tabTitleEl = document.getElementById('tabTitle');
    const tabUrlEl = document.getElementById('tabUrl');
    const tabIdFromQuery = parseTabIdFromQuery();

    let targetTab = null;

    cancelBtn?.addEventListener('click', () => window.close());

    try {
        targetTab = await getTargetTab(tabIdFromQuery);
        if (targetTab) {
            tabTitleEl.textContent = targetTab.title || 'Untitled';
            tabUrlEl.textContent = targetTab.url || '';
        }

        if (!targetTab || !isSaveableUrl(targetTab.url)) {
            setStatus('This page cannot be saved from a browser internal tab.', 'error');
            boardSelect.disabled = true;
            saveBtn.disabled = true;
            return;
        }

        const response = await chrome.runtime.sendMessage({ action: 'getShortcutBoardPickerData' });
        if (!response?.success) {
            throw new Error(response?.message || 'Failed to load boards');
        }

        renderBoards(boardSelect, response.boards || []);

        const validBoardIds = new Set((response.boards || []).map((board) => board.id));
        const preferredBoardId = await loadShortcutBoardPreference(validBoardIds);

        if (preferredBoardId && validBoardIds.has(preferredBoardId)) {
            boardSelect.value = preferredBoardId;
        } else if (boardSelect.options.length > 0) {
            boardSelect.selectedIndex = 0;
        }

        saveBtn.disabled = !boardSelect.value;
        setStatus('');
    } catch (error) {
        console.error('Failed to initialize shortcut board picker:', error);
        setStatus(error?.message || 'Failed to load board picker.', 'error');
        boardSelect.disabled = true;
        saveBtn.disabled = true;
    }

    boardSelect?.addEventListener('change', () => {
        saveBtn.disabled = !boardSelect.value;
        setStatus('');
    });

    boardSelect?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !saveBtn.disabled) {
            event.preventDefault();
            saveBtn.click();
        }
    });

    saveBtn?.addEventListener('click', async () => {
        const boardId = boardSelect.value;
        if (!boardId) {
            setStatus('Please choose a board first.', 'error');
            return;
        }

        saveBtn.disabled = true;
        boardSelect.disabled = true;
        setStatus('Saving...', '');

        try {
            const response = await chrome.runtime.sendMessage({
                action: 'quickSaveToBoard',
                boardId,
                tabId: targetTab?.id
            });

            if (!response?.success) {
                throw new Error(response?.message || 'Failed to save bookmark');
            }

            await chrome.storage.local.set({
                [BOARD_LAST_USED_STORAGE_KEY]: boardId
            });

            setStatus(response.message || 'Saved successfully.', 'success');
            setTimeout(() => {
                window.close();
            }, 650);
        } catch (error) {
            console.error('Shortcut save failed:', error);
            setStatus(error?.message || 'Failed to save bookmark.', 'error');
            boardSelect.disabled = false;
            saveBtn.disabled = !boardSelect.value;
        }
    });
}

document.addEventListener('DOMContentLoaded', () => {
    initialize().catch((error) => {
        console.error('Shortcut save window failed to initialize:', error);
        setStatus('Could not initialize shortcut save window.', 'error');
    });
});