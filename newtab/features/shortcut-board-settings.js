(function registerLumiListShortcutBoardSettingsFeature(global) {
    const modules = global.LumiListModules || (global.LumiListModules = {});
    const features = modules.features || (modules.features = {});

    features.shortcutBoardSettings = function createShortcutBoardSettingsFeature(options) {
        const {
            db,
            canMutateAccountScopedPreferences
        } = options;

        const SHORTCUT_DEFAULT_BOARD_STORAGE_KEY = 'shortcutDefaultBoardId';
        const SHORTCUT_LAST_USED_BOARD_STORAGE_KEY = 'shortcutLastBoardId';
        const SHORTCUT_USE_LAST_BOARD_STORAGE_KEY = 'shortcutUseLastBoard';

        function resetShortcutDefaultBoardOptions(select, disabled = false) {
            if (!select) return;
            select.innerHTML = '<option value="">Always choose manually</option>';
            select.disabled = disabled;
            select.value = '';
        }

        function sortBoardsForSettings(boards = [], pagesById = new Map()) {
            return boards.slice().sort((a, b) => {
                const pageA = pagesById.get(a.pageId);
                const pageB = pagesById.get(b.pageId);
                const pageOrderA = Number.isFinite(pageA?.order) ? pageA.order : 0;
                const pageOrderB = Number.isFinite(pageB?.order) ? pageB.order : 0;
                if (pageOrderA !== pageOrderB) return pageOrderA - pageOrderB;

                const pageNameA = (pageA?.name || '').toLowerCase();
                const pageNameB = (pageB?.name || '').toLowerCase();
                if (pageNameA !== pageNameB) return pageNameA.localeCompare(pageNameB);

                const columnA = Number.isFinite(a.columnIndex) ? a.columnIndex : 0;
                const columnB = Number.isFinite(b.columnIndex) ? b.columnIndex : 0;
                if (columnA !== columnB) return columnA - columnB;

                const orderA = Number.isFinite(a.order) ? a.order : 0;
                const orderB = Number.isFinite(b.order) ? b.order : 0;
                if (orderA !== orderB) return orderA - orderB;

                return (a.name || '').localeCompare(b.name || '');
            });
        }

        async function loadShortcutBoardSettingsControls() {
            const select = document.getElementById('settingsShortcutDefaultBoard');
            const useLastToggle = document.getElementById('settingsShortcutUseLastBoardToggle');
            if (!select || !useLastToggle) return;

            if (!canMutateAccountScopedPreferences()) {
                resetShortcutDefaultBoardOptions(select, true);
                useLastToggle.checked = false;
                useLastToggle.disabled = true;
                return;
            }

            useLastToggle.disabled = false;

            const pages = await db.pages.orderBy('order').filter((page) => !page.deletedAt).toArray();
            const pagesById = new Map(pages.map((page) => [page.id, page]));

            const boardsRaw = await db.boards.filter((board) => !board.deletedAt && pagesById.has(board.pageId)).toArray();
            const boards = sortBoardsForSettings(boardsRaw, pagesById);

            resetShortcutDefaultBoardOptions(select, boards.length === 0);
            if (boards.length > 0) {
                const groupsByPage = new Map();
                boards.forEach((board) => {
                    const page = pagesById.get(board.pageId);
                    const pageName = page?.name || 'Untitled Page';
                    if (!groupsByPage.has(pageName)) groupsByPage.set(pageName, []);
                    groupsByPage.get(pageName).push(board);
                });

                groupsByPage.forEach((pageBoards, pageName) => {
                    const optGroup = document.createElement('optgroup');
                    optGroup.label = pageName;
                    pageBoards.forEach((board) => {
                        const option = document.createElement('option');
                        option.value = board.id;
                        option.textContent = board.name || 'Untitled Board';
                        optGroup.appendChild(option);
                    });
                    select.appendChild(optGroup);
                });
            }

            const storage = await chrome.storage.local.get([
                SHORTCUT_DEFAULT_BOARD_STORAGE_KEY,
                SHORTCUT_LAST_USED_BOARD_STORAGE_KEY,
                SHORTCUT_USE_LAST_BOARD_STORAGE_KEY
            ]);

            const availableBoardIds = new Set(boards.map((board) => board.id));
            const defaultBoardId = typeof storage?.[SHORTCUT_DEFAULT_BOARD_STORAGE_KEY] === 'string'
                ? storage[SHORTCUT_DEFAULT_BOARD_STORAGE_KEY]
                : '';
            const lastBoardId = typeof storage?.[SHORTCUT_LAST_USED_BOARD_STORAGE_KEY] === 'string'
                ? storage[SHORTCUT_LAST_USED_BOARD_STORAGE_KEY]
                : '';
            const useLastBoard = storage?.[SHORTCUT_USE_LAST_BOARD_STORAGE_KEY] === true;

            useLastToggle.checked = useLastBoard;

            if (availableBoardIds.has(defaultBoardId)) {
                select.value = defaultBoardId;
            } else {
                select.value = '';
                if (defaultBoardId) {
                    await chrome.storage.local.set({ [SHORTCUT_DEFAULT_BOARD_STORAGE_KEY]: '' });
                }
            }

            if (lastBoardId && !availableBoardIds.has(lastBoardId)) {
                await chrome.storage.local.set({ [SHORTCUT_LAST_USED_BOARD_STORAGE_KEY]: '' });
            }
        }

        async function saveShortcutDefaultBoardSetting() {
            const select = document.getElementById('settingsShortcutDefaultBoard');
            if (!select) return;
            if (!canMutateAccountScopedPreferences()) {
                await loadShortcutBoardSettingsControls();
                return;
            }

            const value = typeof select.value === 'string' ? select.value : '';
            await chrome.storage.local.set({
                [SHORTCUT_DEFAULT_BOARD_STORAGE_KEY]: value
            });
        }

        async function saveShortcutUseLastBoardSetting() {
            const useLastToggle = document.getElementById('settingsShortcutUseLastBoardToggle');
            if (!useLastToggle) return;
            if (!canMutateAccountScopedPreferences()) {
                await loadShortcutBoardSettingsControls();
                return;
            }

            await chrome.storage.local.set({
                [SHORTCUT_USE_LAST_BOARD_STORAGE_KEY]: useLastToggle.checked === true
            });
        }

        return {
            loadShortcutBoardSettingsControls,
            saveShortcutDefaultBoardSetting,
            saveShortcutUseLastBoardSetting
        };
    };
})(window);
