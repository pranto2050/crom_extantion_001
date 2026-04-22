const BOARD_DEFAULT_STORAGE_KEY = 'shortcutDefaultBoardId';
const BOARD_LAST_USED_STORAGE_KEY = 'shortcutLastBoardId';
const BOARD_USE_LAST_STORAGE_KEY = 'shortcutUseLastBoard';
const PAGE_PLACEHOLDER = '';
const BOARD_PLACEHOLDER = '';

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
        option.value = BOARD_PLACEHOLDER;
        option.textContent = 'No boards found';
        select.appendChild(option);
        select.disabled = true;
        return;
    }

    const placeholderOption = document.createElement('option');
    placeholderOption.value = BOARD_PLACEHOLDER;
    placeholderOption.textContent = 'Select board';
    select.appendChild(placeholderOption);

    boards.forEach((board) => {
        const option = document.createElement('option');
        option.value = board.id;
        option.textContent = board.name || 'Untitled Board';
        select.appendChild(option);
    });

    select.value = BOARD_PLACEHOLDER;
    select.disabled = false;
}

function renderPages(select, pages) {
    select.innerHTML = '';

    const placeholderOption = document.createElement('option');
    placeholderOption.value = PAGE_PLACEHOLDER;
    placeholderOption.textContent = 'Select page';
    select.appendChild(placeholderOption);

    if (!Array.isArray(pages) || pages.length === 0) {
        select.disabled = true;
        return;
    }

    pages.forEach((page) => {
        const option = document.createElement('option');
        option.value = page.id;
        option.textContent = page.name || 'Untitled Page';
        select.appendChild(option);
    });

    select.value = PAGE_PLACEHOLDER;
    select.disabled = false;
}

function resetBoardsForPageChange(select) {
    select.innerHTML = '';
    const option = document.createElement('option');
    option.value = BOARD_PLACEHOLDER;
    option.textContent = 'Select page first';
    select.appendChild(option);
    select.value = BOARD_PLACEHOLDER;
    select.disabled = true;
}

function updateSaveButtonState() {
    const pageSelect = document.getElementById('pageSelect');
    const boardSelect = document.getElementById('boardSelect');
    const saveBtn = document.getElementById('saveBtn');
    if (!saveBtn) return;

    const selectedPage = pageSelect?.value || PAGE_PLACEHOLDER;
    const selectedBoard = boardSelect?.value || BOARD_PLACEHOLDER;
    saveBtn.disabled = !selectedPage || !selectedBoard;
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
    const pageSelect = document.getElementById('pageSelect');
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
            if (pageSelect) pageSelect.disabled = true;
            boardSelect.disabled = true;
            saveBtn.disabled = true;
            return;
        }

        const pagesResponse = await chrome.runtime.sendMessage({ action: 'getPages' });
        const pages = Array.isArray(pagesResponse?.pages) ? pagesResponse.pages : [];
        renderPages(pageSelect, pages);
        resetBoardsForPageChange(boardSelect);

        if (pages.length === 0) {
            setStatus('Create a page and board first in LumiList.', 'error');
            updateSaveButtonState();
            return;
        }

        pageSelect?.addEventListener('change', async () => {
            const selectedPageId = pageSelect.value || PAGE_PLACEHOLDER;
            resetBoardsForPageChange(boardSelect);
            setStatus('');
            updateSaveButtonState();

            if (!selectedPageId) {
                return;
            }

            try {
                const boardsResponse = await chrome.runtime.sendMessage({ action: 'getBoardsForPage', pageId: selectedPageId });
                const boards = Array.isArray(boardsResponse?.boards) ? boardsResponse.boards : [];
                renderBoards(boardSelect, boards);

                if (boards.length === 0) {
                    setStatus('No board found on this page. Create one in LumiList.', 'error');
                    updateSaveButtonState();
                    return;
                }

                const validBoardIds = new Set(boards.map((board) => board.id));
                const preferredBoardId = await loadShortcutBoardPreference(validBoardIds);
                if (preferredBoardId && validBoardIds.has(preferredBoardId)) {
                    boardSelect.value = preferredBoardId;
                }
            } catch (error) {
                console.error('Failed to load boards for selected page:', error);
                setStatus('Failed to load boards for this page.', 'error');
            }

            updateSaveButtonState();
        });

        boardSelect?.addEventListener('change', () => {
            setStatus('');
            updateSaveButtonState();
        });

        boardSelect?.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && !saveBtn.disabled) {
                event.preventDefault();
                saveBtn.click();
            }
        });

        // Restore preferred page/board if available.
        try {
            const saved = await chrome.storage.local.get(['quickSavePageId']);
            const preferredPageId = typeof saved?.quickSavePageId === 'string' ? saved.quickSavePageId : '';
            const validPageIds = new Set(pages.map((page) => page.id));
            if (preferredPageId && validPageIds.has(preferredPageId)) {
                pageSelect.value = preferredPageId;
                pageSelect.dispatchEvent(new Event('change'));
            }
        } catch (error) {
            console.warn('Failed to restore preferred page in shortcut save window:', error);
        }

        setStatus('');
        updateSaveButtonState();
    } catch (error) {
        console.error('Failed to initialize shortcut board picker:', error);
        setStatus(error?.message || 'Failed to load board picker.', 'error');
        if (pageSelect) pageSelect.disabled = true;
        boardSelect.disabled = true;
        saveBtn.disabled = true;
    }

    saveBtn?.addEventListener('click', async () => {
        const selectedPageId = pageSelect?.value || PAGE_PLACEHOLDER;
        const boardId = boardSelect.value;
        if (!selectedPageId || !boardId) {
            setStatus('Please choose page and board first.', 'error');
            return;
        }

        saveBtn.disabled = true;
        if (pageSelect) pageSelect.disabled = true;
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
            if (pageSelect) pageSelect.disabled = false;
            boardSelect.disabled = false;
            updateSaveButtonState();
        }
    });
}

document.addEventListener('DOMContentLoaded', () => {
    initialize().catch((error) => {
        console.error('Shortcut save window failed to initialize:', error);
        setStatus('Could not initialize shortcut save window.', 'error');
    });
});