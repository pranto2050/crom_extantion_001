function getBookmarkNoteText(rawDescription) {
    return sanitizeBookmarkNote(rawDescription);
}

// Generate HTML string for a single bookmark
function generateBookmarkHTML(bookmark) {
    return BookmarkComponent.render(bookmark);
}

// Generate HTML string for a single board with its bookmarks (used by Idiomorph morphing)
function generateBoardHTML(board, bookmarks) {
    return BoardComponent.render(board, bookmarks);
}

// Clean up board menus that no longer have a corresponding board in the DOM
function cleanupOrphanedBoardMenus(currentBoards) {
    const currentBoardIds = new Set(currentBoards.map(b => b.id));
    document.querySelectorAll('.board-menu').forEach(menu => {
        const menuId = menu.id; // Format: "board-menu-{id}"
        const boardId = menuId.replace('board-menu-', '');
        if (!currentBoardIds.has(boardId)) {
            menu.remove();
        }
    });
}

const BOARD_MENU_OPEN_ALL_ICON = `<svg xmlns="http://www.w3.org/2000/svg" class="board-menu-icon" width="16" height="16" viewBox="0 0 800 800" fill="none" aria-hidden="true"><path d="M166.667,66.667l166.667,-0c18.409,0 33.333,14.924 33.333,33.333c0,17.095 -12.868,31.184 -29.446,33.109l-3.887,0.224l-166.667,0c-17.095,0 -31.184,12.868 -33.109,29.446l-0.224,3.887l0,466.667c0,17.095 12.868,31.184 29.446,33.109l3.887,0.224l466.667,0c17.095,0 31.184,-12.868 33.109,-29.446l0.224,-3.887l-0,-166.667c0,-18.409 14.924,-33.333 33.333,-33.333c17.095,0 31.184,12.868 33.109,29.446l0.224,3.887l0,166.667c0,53.256 -41.631,96.789 -94.124,99.83l-5.876,0.17l-466.667,0c-53.256,0 -96.789,-41.631 -99.83,-94.124l-0.17,-5.876l0,-466.667c0,-53.256 41.631,-96.789 94.124,-99.83l5.876,-0.17l166.667,-0l-166.667,0Zm533.333,0l2.7,0.1l3.991,0.575l3.714,0.983l3.703,1.465l3.25,1.744l3.201,2.226l3.012,2.67l3.219,3.727l2.389,3.708l1.034,2.032l1.126,2.715l0.801,2.522l0.965,4.93l0.23,3.937l0,200c0,18.409 -14.924,33.333 -33.333,33.333c-18.409,0 -33.333,-14.924 -33.333,-33.333l0,-119.533l-209.763,209.77c-12.016,12.016 -30.924,12.94 -44,2.773l-3.14,-2.773c-12.016,-12.016 -12.94,-30.924 -2.773,-44l2.773,-3.14l209.704,-209.763l-119.467,0c-18.409,0 -33.333,-14.924 -33.333,-33.333c0,-18.409 14.924,-33.333 33.333,-33.333l200,0Z" fill="currentColor"/></svg>`;
const BOARD_MENU_FETCH_TITLES_ICON = `<svg xmlns="http://www.w3.org/2000/svg" class="board-menu-icon" width="16" height="16" viewBox="0 0 800 800" fill="none" aria-hidden="true"><path d="M100,400c0,165.687 134.313,300 300,300c76.835,0 146.924,-28.887 200,-76.39l100,-90.277m0,-133.333c0,-165.685 -134.315,-300 -300,-300c-76.837,0 -146.923,28.885 -200,76.389l-100,90.277m600,433.333l0,-166.667m0,0l-166.667,0m-433.333,-433.333l0,166.667m0,0l166.667,0" fill="none" stroke="currentColor" stroke-width="66.67" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const BOARD_MENU_EDIT_ICON = `<svg xmlns="http://www.w3.org/2000/svg" class="board-menu-icon" width="16" height="16" viewBox="0 0 800 800" fill="none" aria-hidden="true"><path d="M714.538,78.452c-24.259,-23.235 -50.988,-35.008 -79.542,-35.008c-44.645,0 -77.227,28.843 -86.129,37.679c-12.552,12.419 -440.35,440.395 -440.35,440.395c-2.804,2.804 -4.829,6.321 -5.875,10.149c-9.637,35.654 -57.976,193.847 -58.466,195.449c-2.493,8.101 -0.267,16.937 5.697,22.901c4.295,4.273 10.015,6.565 15.868,6.565c2.315,0 4.629,-0.356 6.899,-1.091c1.625,-0.534 164.914,-53.302 191.799,-61.337c3.539,-1.068 6.788,-2.982 9.414,-5.586c16.981,-16.781 415.98,-411.351 442.465,-438.703c27.397,-28.22 41.017,-57.642 40.483,-87.353c-0.556,-29.355 -14.778,-57.62 -42.308,-84.037l0.045,-0.022Zm-172.771,73.844c11.328,2.737 38.079,11.729 65.387,39.281c27.597,27.842 35.053,59.667 36.455,66.923c-87.509,87.064 -288.945,286.363 -368.353,364.904c-7.322,-17.07 -19.184,-37.657 -38.257,-56.863c-23.279,-23.457 -46.982,-36.7 -65.254,-44.155c78.585,-78.607 283.826,-283.915 370,-370.067l0.022,-0.022Zm-400.223,407.635c12.241,3.249 37.634,12.686 63.518,38.769c19.941,20.119 29.355,42.286 33.584,55.817c-30.935,9.948 -98.682,33.317 -141.702,47.204c12.752,-41.974 34.296,-107.317 44.6,-141.791Zm542.504,-341.891c-0.912,0.935 -2.426,2.448 -4.229,4.273c-7.033,-18.116 -19.362,-41.396 -40.75,-62.939c-21.833,-22.011 -43.977,-34.986 -61.715,-42.664c1.513,-1.491 2.671,-2.671 3.138,-3.116c2.537,-2.515 25.661,-24.615 54.46,-24.615c16.58,0 32.872,7.567 48.406,22.478c18.428,17.693 27.953,35.142 28.265,51.878c0.312,17.092 -8.991,35.498 -27.597,54.704l0.022,0Z" fill="currentColor"/></svg>`;
const BOARD_ADD_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/><line x1="5" y1="2" x2="5" y2="8"/><line x1="2" y1="5" x2="8" y2="5"/></svg>`;
const BOARD_MENU_DELETE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" class="board-menu-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>`;
const BOOKMARK_EDIT_ICON = BOARD_MENU_EDIT_ICON
    .replace('class="board-menu-icon"', 'class="bookmark-edit-icon"')
    .replace('width="16"', 'width="14"')
    .replace('height="16"', 'height="14"');
const BOOKMARK_DELETE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" class="bookmark-delete-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>`;
const BOOKMARK_PIN_ICON = `<svg xmlns="http://www.w3.org/2000/svg" class="bookmark-pin-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>`;
const BOOKMARK_UNPIN_ICON = `<svg xmlns="http://www.w3.org/2000/svg" class="bookmark-pin-icon" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>`;
const BOARD_MENU_SHARE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" class="board-menu-icon" width="16" height="16" viewBox="0 0 800 800" fill="none" aria-hidden="true"><path d="M176.151,250.186c44.306,0 83.451,20.301 110.085,51.579c1.277,1.5 3.443,1.874 5.149,0.889l186.802,-107.858c1.392,-0.804 2.183,-2.349 2.02,-3.948c-9.18,-90.205 61.311,-159.847 143.642,-159.847c80.16,0 145.151,64.991 145.151,145.151c0,80.16 -64.991,145.151 -145.151,145.151c-48.88,0 -91.877,-24.357 -118.186,-61.371c-1.22,-1.716 -3.545,-2.223 -5.368,-1.17l-179.9,103.866c-1.514,0.874 -2.303,2.615 -1.963,4.33c3.92,19.744 3.811,38.762 -0.327,58.47c-0.363,1.729 0.428,3.495 1.959,4.377l184.564,106.216c1.763,1.014 4.003,0.577 5.254,-1.027c26.561,-34.036 67.485,-56.294 113.967,-56.294c80.16,0 145.151,64.991 145.151,145.151c0,80.16 -64.991,145.151 -145.151,145.151c-85.707,0 -156.892,-75.192 -142.922,-166.959c0.253,-1.664 -0.541,-3.313 -2,-4.152l-188.63,-108.53c-1.691,-0.973 -3.834,-0.613 -5.114,0.858c-26.598,30.553 -65.344,50.27 -109.032,50.27c-80.16,0 -145.151,-64.991 -145.151,-145.151c0,-80.16 64.991,-145.151 145.151,-145.151Zm447.698,4.664c43.402,0 78.698,-35.296 78.698,-78.698c0,-43.402 -35.296,-78.698 -78.698,-78.698c-104,0 -104.039,157.397 0,157.397Zm-447.698,219.186c43.402,0 78.698,-35.296 78.698,-78.698c0,-43.402 -35.296,-78.698 -78.698,-78.698c-43.402,0 -78.698,35.296 -78.698,78.698c0,43.402 35.296,78.698 78.698,78.698Zm447.698,228.513c43.402,0 78.698,-35.296 78.698,-78.698c0,-43.402 -35.296,-78.698 -78.698,-78.698c-104,0 -104.039,157.397 0,157.397Z" fill="currentColor"/></svg>`;

function buildBoardMenuIconLabel(iconSvg, label) {
    return `${iconSvg}<span>${label}</span>`;
}

function getOpenAllBoardMenuLabel() {
    return buildBoardMenuIconLabel(BOARD_MENU_OPEN_ALL_ICON, 'Open All Links');
}

function getFetchAllTitlesBoardMenuLabel() {
    return buildBoardMenuIconLabel(BOARD_MENU_FETCH_TITLES_ICON, 'Fetch All Titles');
}

function getEditBoardMenuLabel() {
    return buildBoardMenuIconLabel(BOARD_MENU_EDIT_ICON, 'Edit Board');
}

function getShareBoardMenuLabel(isShared) {
    return buildBoardMenuIconLabel(BOARD_MENU_SHARE_ICON, isShared ? 'Manage Share' : 'Share Board');
}

function getDeleteBoardMenuLabel() {
    return buildBoardMenuIconLabel(BOARD_MENU_DELETE_ICON, 'Delete Board');
}

function getBoardMenuMarkup(boardId, isShared) {
    const escapedBoardId = escapeHTML(boardId);
    return `
        <button class="board-menu-item" data-action="open-all-links" data-board-id="${escapedBoardId}">${getOpenAllBoardMenuLabel()}</button>
        <button class="board-menu-item" data-action="fetch-all-titles" data-board-id="${escapedBoardId}">${getFetchAllTitlesBoardMenuLabel()}</button>
        <button class="board-menu-item" data-action="edit-board" data-board-id="${escapedBoardId}">${getEditBoardMenuLabel()}</button>
        <button class="board-menu-item" data-action="share-board" data-board-id="${escapedBoardId}">${getShareBoardMenuLabel(isShared)}</button>
        <div class="board-menu-divider"></div>
        <button class="board-menu-item danger" data-action="delete-board" data-board-id="${escapedBoardId}">${getDeleteBoardMenuLabel()}</button>
    `;
}

// Ensure board menu exists for a morphed board (create if missing)
function ensureBoardMenuExists(boardId, isShared) {
    let dropdown = document.getElementById(`board-menu-${boardId}`);

    if (!dropdown) {
        // Create dropdown menu for this board
        dropdown = document.createElement('div');
        dropdown.className = 'board-menu';
        dropdown.id = `board-menu-${boardId}`;
        document.body.appendChild(dropdown);
    }

    // Use data-action attributes for event delegation (CSP compliant)
    dropdown.innerHTML = getBoardMenuMarkup(boardId, isShared);
}

// Initialize favicons for elements that have placeholder spans (after morphing)
async function initializeNewFavicons() {
    const spans = Array.from(document.querySelectorAll('.favicon[data-url]:not([data-favicon-loaded])'));
    if (spans.length === 0) return;

    const CONCURRENCY = 6;
    let index = 0;

    async function worker() {
        while (index < spans.length) {
            const span = spans[index++];
            const url = span.dataset.url;
            if (!url) continue;
            // Mark as loaded to avoid re-processing
            span.dataset.faviconLoaded = 'true';
            try {
                // Create actual favicon element and replace placeholder (await cache check)
                const faviconEl = await createFaviconElement(url, span.dataset.title || '');
                span.replaceWith(faviconEl);
            } catch (e) {
                console.error('Favicon init error:', e);
            }
        }
    }

    const workers = Array.from({ length: Math.min(CONCURRENCY, spans.length) }, () => worker());
    await Promise.all(workers);
}

// Idiomorph-based board rendering (reduces visual flashing)
async function loadBoardsFromDatabaseMorph() {
    // Recover edge case where input DOM was removed but the guard flag stayed true.
    recoverStaleInlineInputState('loadBoardsFromDatabaseMorph:start');

    // If board drag is in progress on THIS page, defer rendering to prevent duplicates
    if (_isBoardDragInProgress && currentPageId === dragOriginPageId) {
        _loadBoardsPendingAfterDrag = true;
        void refreshTrashModalIfOpen('loadBoardsFromDatabaseMorph:deferred-board-drag');
        return;
    }

    // If bookmark drag is in progress on THIS page, defer rendering to prevent visual glitch
    if (_isBookmarkDragInProgress && currentPageId === dragOriginPageId) {
        _loadBoardsPendingAfterBookmarkDrag = true;
        void refreshTrashModalIfOpen('loadBoardsFromDatabaseMorph:deferred-bookmark-drag');
        return;
    }

    // If inline input is active, defer rendering to prevent wiping out user's input
    if (_isInlineInputActive) {
        _loadBoardsPendingAfterInput = true;
        void refreshTrashModalIfOpen('loadBoardsFromDatabaseMorph:deferred-inline-input');
        return;
    }

    // If already loading, mark pending and return to prevent duplicate renders
    if (_loadBoardsInProgress) {
        _loadBoardsPending = true;

        return;
    }

    _loadBoardsInProgress = true;
    _loadBoardsPending = false;
    const requestedPageId = currentPageId;

    try {
        // Only load boards for the current page
        if (!requestedPageId) {
            console.warn('No current page set, clearing boards');
            clearAllColumns();
            pageHasBoards = false;
            showAddBoardPlaceholder(0);
            await refreshTrashModalIfOpen('loadBoardsFromDatabaseMorph:no-current-page');
            _loadBoardsInProgress = false;
            return;
        }

        // Get boards for current page, excluding deleted ones
        let boards;
        try {
            boards = await db.boards
                .where('pageId').equals(requestedPageId)
                .filter(b => !b.deletedAt)
                .toArray();
            // Sort by columnIndex, then by order
            boards.sort((a, b) => {
                if (a.columnIndex !== b.columnIndex) return a.columnIndex - b.columnIndex;
                return a.order - b.order;
            });
        } catch (error) {
            console.error('Error loading boards for page:', error);
            boards = [];
        }

        // Group boards by column and fetch all bookmarks in a single query
        const columnBoards = [[], [], [], []];
        const bookmarksByBoard = new Map();
        if (boards.length > 0) {
            try {
                const boardIds = boards.map(b => b.id);
                const allBookmarks = await db.bookmarks
                    .where('boardId')
                    .anyOf(boardIds)
                    .toArray();

                for (const bookmark of allBookmarks) {
                    if (bookmark.deletedAt) continue;
                    const list = bookmarksByBoard.get(bookmark.boardId) || [];
                    list.push(bookmark);
                    bookmarksByBoard.set(bookmark.boardId, list);
                }

                // Sort bookmarks per board by order
                for (const list of bookmarksByBoard.values()) {
                    list.sort((a, b) => {
                        // 1. Pin Favorites (if enabled)
                        if (window.pinFavoritesEnabled) {
                            if (a.isPinned && !b.isPinned) return -1;
                            if (!a.isPinned && b.isPinned) return 1;
                        }

                        // 2. Sorting behavior
                        if (window.recentlyUsedEnabled) {
                            const timeA = a.lastVisited ? new Date(a.lastVisited).getTime() : 0;
                            const timeB = b.lastVisited ? new Date(b.lastVisited).getTime() : 0;
                            if (timeA !== timeB) return timeB - timeA;
                        } else if (window.frequentlyUsedEnabled) {
                            const countA = a.visitCount || 0;
                            const countB = b.visitCount || 0;
                            if (countA !== countB) return countB - countA;
                        }

                        // 3. Default order
                        return (a.order || 0) - (b.order || 0);
                    });
                }
            } catch (error) {
                console.error('Error loading bookmarks for page:', error);
            }
        }

        // If page switched during async fetch, skip stale render and queue a fresh load.
        if (currentPageId !== requestedPageId) {
            _loadBoardsPending = true;
            console.warn(`[Boards] Skipping stale morph render for page ${requestedPageId}; current page is ${currentPageId}`);
            return;
        }

        for (const board of boards) {
            const colIdx = validateColumnIndex(board.columnIndex);
            const bookmarks = bookmarksByBoard.get(board.id) || [];
            columnBoards[colIdx].push({ board, bookmarks });
        }

        // Morph each column
        for (let colIdx = 0; colIdx < 4; colIdx++) {
            const column = document.querySelector(`[data-column="${colIdx}"]`);
            if (!column) {
                console.error(`Column ${colIdx} not found`);
                continue;
            }

            // Generate HTML for all boards in this column
            const boardsHTML = columnBoards[colIdx]
                .map(({ board, bookmarks }) => generateBoardHTML(board, bookmarks))
                .join('');

            // Use outerHTML morphing to preserve flexbox gap
            // innerHTML morphing breaks the gap due to incremental DOM mutations
            const tempColumn = document.createElement('div');
            tempColumn.className = column.className;
            tempColumn.setAttribute('data-column', colIdx);
            tempColumn.innerHTML = boardsHTML;

            Idiomorph.morph(column, tempColumn, {
                morphStyle: 'outerHTML',
                ignoreActive: true,
                ignoreActiveValue: true
            });

            // Ensure board menus exist for all boards in this column
            for (const { board } of columnBoards[colIdx]) {
                ensureBoardMenuExists(board.id, !!board.shareId);
            }
        }

        // Clean up orphaned board menus (menus for boards that no longer exist)
        cleanupOrphanedBoardMenus(boards);

        // Initialize favicons for new elements (replaces placeholder spans)
        initializeNewFavicons();

        // Re-apply selection state after morph (preserves multi-select during cross-tab sync)
        reapplySelectionStateToDOM();

        // Re-attach event listeners (with deduplication)
        attachDragDropListeners();

        // Re-apply dragging state if a bookmark drag is still in progress after morph
        // This handles the case where morph replaced the DOM element mid-drag
        if (_isBookmarkDragInProgress && draggedBookmarkId) {
            const newDraggedEl = document.querySelector(`li[data-bookmark-id="${draggedBookmarkId}"]`);
            if (newDraggedEl) {
                newDraggedEl.classList.add('dragging');
                draggedBookmark = newDraggedEl;  // Update reference to new element

            }
        }

        // Re-apply dragging state if a board drag is still in progress after morph
        if (_isBoardDragInProgress && draggedBoardId) {
            const newDraggedBoard = document.querySelector(`.board[data-board-id="${draggedBoardId}"]`);
            if (newDraggedBoard) {
                newDraggedBoard.classList.add('dragging');
                draggedElement = newDraggedBoard;  // Update reference to new element

            }
        }

        // Apply open in new tab setting to newly rendered links
        applyOpenInNewTabSetting(openLinksInNewTab);

        // Track if page has boards
        pageHasBoards = boards.length > 0;

        // Show/hide placeholder based on page state
        if (!pageHasBoards) {
            showAddBoardPlaceholder(0);
        } else {
            // Hide any existing placeholder when page has boards
            hideAddBoardPlaceholder();
            // Cancel any pending placeholder timeout from createNewPage()
            if (_showPlaceholderTimeoutId) {
                clearTimeout(_showPlaceholderTimeoutId);
                _showPlaceholderTimeoutId = null;
            }
        }

        // Clear hover listener flags - Idiomorph preserves custom properties,
        // so we must reset them to ensure listeners get reattached after morph
        document.querySelectorAll('.column').forEach(col => {
            col._hoverListenersAttached = false;
        });

        // Initialize column hover listeners for placeholder movement
        initColumnHoverListeners();

        // Recalculate placeholder based on current mouse position
        // (mousemove doesn't fire automatically after DOM changes)
        recalculatePlaceholder();

        // Keep search overlay results in sync with latest board/bookmark state.
        await refreshSearchIfOpen();
        await refreshTrashModalIfOpen('loadBoardsFromDatabaseMorph');

    } catch (error) {
        console.error('Failed to load boards (morph):', error);
    } finally {
        _loadBoardsInProgress = false;

        // If another call was queued while we were running, run it now
        // Check all pending flags as a defensive measure
        if (_loadBoardsPending) {
            _loadBoardsPending = false;

            await loadBoardsFromDatabase();
        } else if (_loadBoardsPendingAfterDrag && !_isBoardDragInProgress) {
            // Safety net: if board drag ended but pending flag wasn't cleared
            _loadBoardsPendingAfterDrag = false;

            await loadBoardsFromDatabase();
        } else if (_loadBoardsPendingAfterBookmarkDrag && !_isBookmarkDragInProgress) {
            // Safety net: if bookmark drag ended but pending flag wasn't cleared
            _loadBoardsPendingAfterBookmarkDrag = false;

            await loadBoardsFromDatabase();
        } else if (_loadBoardsPendingAfterInput && !_isInlineInputActive) {
            // Safety net: if inline input ended but pending flag wasn't cleared
            _loadBoardsPendingAfterInput = false;

            await loadBoardsFromDatabase();
        }
    }
}

// Load boards from database and render them
async function loadBoardsFromDatabase() {
    // Use Idiomorph-based rendering if enabled
    if (USE_IDIOMORPH) {
        return loadBoardsFromDatabaseMorph();
    }

    // Recover edge case where input DOM was removed but the guard flag stayed true.
    recoverStaleInlineInputState('loadBoardsFromDatabase:start');

    // Legacy rendering (full DOM rebuild)
    // If board drag is in progress on THIS page, defer rendering to prevent duplicates
    // But allow rendering on OTHER pages (cross-page drag needs to show target page's boards)
    if (_isBoardDragInProgress && currentPageId === dragOriginPageId) {
        _loadBoardsPendingAfterDrag = true;
        void refreshTrashModalIfOpen('loadBoardsFromDatabase:deferred-board-drag');
        return;
    }

    // If bookmark drag is in progress on THIS page, defer rendering to prevent visual glitch
    if (_isBookmarkDragInProgress && currentPageId === dragOriginPageId) {
        _loadBoardsPendingAfterBookmarkDrag = true;
        void refreshTrashModalIfOpen('loadBoardsFromDatabase:deferred-bookmark-drag');
        return;
    }

    // If inline input is active, defer rendering to prevent wiping out user's input
    if (_isInlineInputActive) {
        _loadBoardsPendingAfterInput = true;
        void refreshTrashModalIfOpen('loadBoardsFromDatabase:deferred-inline-input');
        return;
    }

    // If already loading, mark pending and return to prevent duplicate renders
    if (_loadBoardsInProgress) {
        _loadBoardsPending = true;

        return;
    }

    _loadBoardsInProgress = true;
    _loadBoardsPending = false;
    const requestedPageId = currentPageId;

    try {
        // Only load boards for the current page
        if (!requestedPageId) {
            console.warn('No current page set, clearing boards');
            clearAllColumns();
            pageHasBoards = false;
            showAddBoardPlaceholder(0);
            await refreshTrashModalIfOpen('loadBoardsFromDatabase:no-current-page');
            _loadBoardsInProgress = false;
            return;
        }

        // Try to get boards for current page, excluding deleted ones
        let boards;
        try {
            boards = await db.boards
                .where('pageId').equals(requestedPageId)
                .filter(b => !b.deletedAt)  // Exclude soft-deleted boards
                .toArray();
            // Sort manually since we can't use compound index with where clause
            boards.sort((a, b) => {
                // First sort by columnIndex, then by order
                if (a.columnIndex !== b.columnIndex) {
                    return a.columnIndex - b.columnIndex;
                }
                return a.order - b.order;
            });
        } catch (error) {
            console.error('Error loading boards for page:', error);
            boards = [];
        }

        // If page switched during async fetch, skip stale render and queue a fresh load.
        if (currentPageId !== requestedPageId) {
            _loadBoardsPending = true;
            console.warn(`[Boards] Skipping stale legacy render for page ${requestedPageId}; current page is ${currentPageId}`);
            return;
        }

        // Clear existing content (including any placeholders)
        document.querySelectorAll('.column').forEach(column => {
            column.innerHTML = '';
        });

        // Remove old board menus from body (since they're appended to body)
        document.querySelectorAll('.board-menu').forEach(menu => menu.remove());

        // Render each board
        for (const board of boards) {
            await renderBoard(board);
        }

        // Track if page has boards
        pageHasBoards = boards.length > 0;

        // Show/hide placeholder based on page state
        if (!pageHasBoards) {
            showAddBoardPlaceholder(0);
        } else {
            // Hide any existing placeholder when page has boards
            hideAddBoardPlaceholder();
            // Cancel any pending placeholder timeout from createNewPage()
            if (_showPlaceholderTimeoutId) {
                clearTimeout(_showPlaceholderTimeoutId);
                _showPlaceholderTimeoutId = null;
            }
        }

        // Clear hover listener flags to ensure fresh listener attachment
        document.querySelectorAll('.column').forEach(col => {
            col._hoverListenersAttached = false;
        });

        // Initialize column hover listeners for placeholder movement
        initColumnHoverListeners();

        // Reattach event listeners to new elements
        attachDragDropListeners();

        // Apply open in new tab setting to newly rendered links
        applyOpenInNewTabSetting(openLinksInNewTab);

        // Note: Privacy blur class is now applied during board creation in renderBoard()
        // No need to apply it after rendering - the class is set when boardElement is created

        // Keep search overlay results in sync with latest board/bookmark state.
        await refreshSearchIfOpen();
        await refreshTrashModalIfOpen('loadBoardsFromDatabase');

    } catch (error) {
        console.error('Failed to load boards:', error);
    } finally {
        _loadBoardsInProgress = false;

        // If another call was queued while we were running, run it now
        if (_loadBoardsPending) {
            _loadBoardsPending = false;

            await loadBoardsFromDatabase();
        }
    }
}

// Track which column the placeholder is currently in
let currentPlaceholderColumn = null;
// Remember the last active placeholder column so guided flows can restore it.
let lastActivePlaceholderColumn = 0;
// Track if the current page has any boards
let pageHasBoards = false;
// Track pending placeholder timeout (from createNewPage)
let _showPlaceholderTimeoutId = null;
// Track last mouse position for recalculating placeholder after DOM changes
let lastMouseX = 0;
let lastMouseY = 0;
let hasMousePosition = false; // True once we've received at least one mousemove

// Suppress the add-board placeholder while board drag is active.
// Bookmark drag can show a special "drop to create board" placeholder mode.
function isPlaceholderDragActive() {
    return _isBoardDragInProgress ||
        draggedBoardId !== null ||
        draggedElement !== null;
}

function isBookmarkDragActive() {
    // IMPORTANT: only treat as active during an actual in-progress drag.
    // Do not use delayed cross-page IDs here (draggedBookmarkId), as they can
    // remain briefly after drag end and would incorrectly suppress placeholder hover.
    return isDraggingBookmark || _isBookmarkDragInProgress;
}

// Global mouse position tracker (for recalculating placeholder after morph/page load)
document.addEventListener('mousemove', (e) => {
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
    hasMousePosition = true;
});

// Recalculate placeholder visibility based on current mouse position
// Called after morph since mousemove doesn't fire automatically after DOM changes
function recalculatePlaceholder() {
    // Skip if we haven't received any mouse position yet (e.g., page just loaded)
    if (!hasMousePosition) return;

    // Bookmark drag uses dedicated placeholder positioning logic.
    if (isBookmarkDragActive()) {
        updateBookmarkDragPlaceholderPosition(lastMouseX, lastMouseY);
        return;
    }

    // Never show placeholder during drag operations
    if (isPlaceholderDragActive()) {
        hideAddBoardPlaceholder();
        return;
    }

    if (_isInlineInputActive) {
        hideAddBoardPlaceholder();
        return;
    }

    // Find which element the mouse is currently over
    const element = document.elementFromPoint(lastMouseX, lastMouseY);
    if (!element) return;

    const column = element.closest('.column');
    if (!column) return;

    const columnIndex = parseInt(column.dataset.column, 10);

    // Use same logic as mousemove handler
    if (pageHasBoards) {
        if (element.closest('.board')) {
            hideAddBoardPlaceholder();
            return;
        }

        const boards = column.querySelectorAll('.board');
        if (boards.length === 0) {
            showAddBoardPlaceholder(columnIndex);
            return;
        }

        const lastBoard = boards[boards.length - 1];
        const lastBoardRect = lastBoard.getBoundingClientRect();

        if (lastMouseY > lastBoardRect.bottom + 5) {
            showAddBoardPlaceholder(columnIndex);
        } else {
            hideAddBoardPlaceholder();
        }
    } else {
        showAddBoardPlaceholder(columnIndex);
    }
}

function setAddBoardPlaceholderMode(placeholder, bookmarkDragMode) {
    if (!placeholder) return;

    const subtitle = placeholder.querySelector('.add-board-placeholder-subtitle');
    if (bookmarkDragMode) {
        placeholder.classList.add('drag-bookmark-target');
        if (subtitle) subtitle.textContent = 'Drop bookmark(s) to create board';
        return;
    }

    placeholder.classList.remove('drag-bookmark-target');
    placeholder.classList.remove('drag-hover-active');
    if (subtitle) subtitle.textContent = 'Click to add a board here';
}

function setAddBoardPlaceholderDragHoverState(placeholder, isActive) {
    document.querySelectorAll('.add-board-placeholder.drag-hover-active').forEach(activeEl => {
        if (!isActive || activeEl !== placeholder) {
            activeEl.classList.remove('drag-hover-active');
        }
    });

    if (placeholder && isActive) {
        placeholder.classList.add('drag-hover-active');
    }
}

// Create the add board placeholder element
function createAddBoardPlaceholder(columnIndex, options = {}) {
    const bookmarkDragMode = options.bookmarkDragMode === true;
    const placeholder = document.createElement('div');
    placeholder.className = 'add-board-placeholder';
    placeholder.dataset.targetColumn = columnIndex;
    placeholder.innerHTML = `
        <div class="add-board-placeholder-icon">+</div>
        <div class="add-board-placeholder-title">Add Board</div>
        <div class="add-board-placeholder-subtitle">Click to add a board here</div>
    `;
    setAddBoardPlaceholderMode(placeholder, bookmarkDragMode);

    // Allow dropping bookmarks directly onto the placeholder to create a board.
    placeholder.addEventListener('dragover', handleAddBoardPlaceholderDragOver);
    placeholder.addEventListener('drop', handleAddBoardPlaceholderDrop);

    // Click handled via event delegation on container (prevents issues with Idiomorph morphing)

    return placeholder;
}

// Show the add board placeholder in a specific column
function showAddBoardPlaceholder(columnIndex, options = {}) {
    const bookmarkDragMode = options.bookmarkDragMode === true || isBookmarkDragActive();

    if (isPlaceholderDragActive()) {
        hideAddBoardPlaceholder();
        return;
    }

    if (_isInlineInputActive) {
        hideAddBoardPlaceholder();
        return;
    }

    // Fast path: same placeholder already in correct column, just update mode.
    const existingPlaceholder = document.querySelector('.add-board-placeholder');
    if (existingPlaceholder && currentPlaceholderColumn === columnIndex) {
        setAddBoardPlaceholderMode(existingPlaceholder, bookmarkDragMode);
        return;
    }

    // Remove existing placeholder from all columns
    document.querySelectorAll('.add-board-placeholder').forEach(p => p.remove());

    // Get the target column
    const column = document.querySelector(`.column[data-column="${columnIndex}"]`);
    if (!column) return;

    // Create and append placeholder
    const placeholder = createAddBoardPlaceholder(columnIndex, { bookmarkDragMode });
    column.appendChild(placeholder);
    currentPlaceholderColumn = columnIndex;
    lastActivePlaceholderColumn = columnIndex;
}

// Hide all add board placeholders
function hideAddBoardPlaceholder() {
    document.querySelectorAll('.add-board-placeholder').forEach(p => p.remove());
    currentPlaceholderColumn = null;
}

function shouldPreserveAddBoardPlaceholderForQuickTour(event) {
    if (!quickTourState?.active) return false;
    const currentStep = QUICK_TOUR_STEPS[quickTourState.stepIndex];
    if (currentStep?.id !== 'create_board') return false;
    return !!event?.relatedTarget?.closest?.('.quick-tour-popover');
}

function updateBookmarkDragPlaceholderPosition(clientX, clientY) {
    if (!isBookmarkDragActive()) {
        return;
    }

    const element = document.elementFromPoint(clientX, clientY);
    if (!element) {
        hideAddBoardPlaceholder();
        return;
    }

    const placeholder = element.closest('.add-board-placeholder');
    if (placeholder) {
        setAddBoardPlaceholderMode(placeholder, true);
        setAddBoardPlaceholderDragHoverState(placeholder, true);
        return;
    }
    setAddBoardPlaceholderDragHoverState(null, false);

    const column = element.closest('.column');
    if (!column) {
        hideAddBoardPlaceholder();
        return;
    }

    const columnIndex = parseInt(column.dataset.column, 10);
    if (isNaN(columnIndex)) {
        hideAddBoardPlaceholder();
        return;
    }

    if (pageHasBoards) {
        // Do not show placeholder while hovering actual board bodies.
        if (element.closest('.board')) {
            hideAddBoardPlaceholder();
            return;
        }

        const boards = column.querySelectorAll('.board');
        if (boards.length === 0) {
            showAddBoardPlaceholder(columnIndex, { bookmarkDragMode: true });
            return;
        }

        const lastBoard = boards[boards.length - 1];
        const lastBoardRect = lastBoard.getBoundingClientRect();
        if (clientY > lastBoardRect.bottom + 5) {
            showAddBoardPlaceholder(columnIndex, { bookmarkDragMode: true });
            return;
        }

        hideAddBoardPlaceholder();
        return;
    }

    showAddBoardPlaceholder(columnIndex, { bookmarkDragMode: true });
}

// Initialize column hover listeners for the add board placeholder
function initColumnHoverListeners() {
    const columns = document.querySelectorAll('.column');

    columns.forEach(column => {
        // Skip if already initialized on this element (prevents duplicates)
        if (column._hoverListenersAttached) return;
        column._hoverListenersAttached = true;

        const columnIndex = parseInt(column.dataset.column, 10);

        // Use mousemove to detect when cursor is below all boards
        column.addEventListener('mousemove', (e) => {
            if (_isInlineInputActive) {
                hideAddBoardPlaceholder();
                return;
            }

            if (isBookmarkDragActive()) {
                return;
            }

            if (isPlaceholderDragActive()) {
                hideAddBoardPlaceholder();
                return;
            }

            if (pageHasBoards) {
                // Skip if mouse is over a board or its children
                if (e.target.closest('.board')) {
                    // Mouse is over a board - hide placeholder if showing
                    if (currentPlaceholderColumn !== null) {
                        hideAddBoardPlaceholder();
                    }
                    return;
                }

                // Check if mouse is below all boards in this column
                const boards = column.querySelectorAll('.board');
                if (boards.length === 0) {
                    // No boards in this column - show placeholder if not already showing
                    if (currentPlaceholderColumn !== columnIndex) {
                        showAddBoardPlaceholder(columnIndex);
                    }
                    return;
                }

                // Get the bottom of the last board
                const lastBoard = boards[boards.length - 1];
                const lastBoardRect = lastBoard.getBoundingClientRect();
                const mouseY = e.clientY;

                // Only show if mouse is below the last board (with some margin)
                if (mouseY > lastBoardRect.bottom + 5) {
                    // Show placeholder only if not already showing in this column
                    if (currentPlaceholderColumn !== columnIndex) {
                        showAddBoardPlaceholder(columnIndex);
                    }
                } else {
                    // Hide if currently showing
                    if (currentPlaceholderColumn !== null) {
                        hideAddBoardPlaceholder();
                    }
                }
            } else {
                // Empty page - always show and follow column hover
                if (currentPlaceholderColumn !== columnIndex) {
                    showAddBoardPlaceholder(columnIndex);
                }
            }
        });

        // Hide placeholder when mouse leaves column (only for pages with boards)
        column.addEventListener('mouseleave', (e) => {
            if (_isInlineInputActive) {
                hideAddBoardPlaceholder();
                return;
            }

            if (isBookmarkDragActive()) {
                return;
            }

            if (isPlaceholderDragActive()) {
                hideAddBoardPlaceholder();
                return;
            }

            if (shouldPreserveAddBoardPlaceholderForQuickTour(e)) {
                return;
            }

            if (pageHasBoards) {
                hideAddBoardPlaceholder();
            }
        });
    });

    // When mouse leaves all columns, handle based on page state
    const container = document.querySelector('.container');
    if (container && !container._hoverListenerAttached) {
        container._hoverListenerAttached = true;
        container.addEventListener('mouseleave', (e) => {
            if (_isInlineInputActive) {
                hideAddBoardPlaceholder();
                return;
            }

            if (isBookmarkDragActive()) {
                return;
            }

            if (isPlaceholderDragActive()) {
                hideAddBoardPlaceholder();
                return;
            }

            if (shouldPreserveAddBoardPlaceholderForQuickTour(e)) {
                return;
            }

            if (!pageHasBoards) {
                // Empty page - reset to column 0
                showAddBoardPlaceholder(0);
            } else {
                // Page with boards - hide placeholder
                hideAddBoardPlaceholder();
            }
        });
    }
}

// Show inline board input for a specific column (replaces modal)
function showInlineBoardInput(columnIndex) {
    // Block in read-only mode (grace/expired status)
    if (!canModify()) return;

    if (_inlineBoardOutsideDismissHandler) {
        document.removeEventListener('pointerdown', _inlineBoardOutsideDismissHandler, true);
        _inlineBoardOutsideDismissHandler = null;
    }

    // Set flag to protect input from being wiped by loadBoardsFromDatabase
    _isInlineInputActive = true;

    // Remove any existing inline input
    document.querySelectorAll('.inline-board-input').forEach(el => el.remove());

    // Hide the placeholder while showing input
    hideAddBoardPlaceholder();

    // Get the target column
    const column = document.querySelector(`.column[data-column="${columnIndex}"]`);
    if (!column) {
        _isInlineInputActive = false;
        return;
    }

    // Create inline input element
    const inputContainer = document.createElement('div');
    inputContainer.className = 'inline-board-input';
    inputContainer.innerHTML = `
        <div class="inline-board-input-row">
            <input type="text" placeholder="Enter board name..." autofocus>
            <button class="inline-board-input-btn">Add</button>
            <button class="inline-board-input-cancel">×</button>
        </div>
    `;

    // Append to column
    column.appendChild(inputContainer);

    // Get elements
    const input = inputContainer.querySelector('input');
    const addBtn = inputContainer.querySelector('.inline-board-input-btn');
    const cancelBtn = inputContainer.querySelector('.inline-board-input-cancel');

    // Focus the input
    setTimeout(() => input.focus(), 50);

    let isClosingInlineBoardInput = false;
    async function closeInlineBoardInput(options = {}) {
        if (isClosingInlineBoardInput) return;
        isClosingInlineBoardInput = true;

        const restorePlaceholder = options.restorePlaceholder !== false;

        if (_inlineBoardOutsideDismissHandler) {
            document.removeEventListener('pointerdown', _inlineBoardOutsideDismissHandler, true);
            _inlineBoardOutsideDismissHandler = null;
        }

        inputContainer.remove();
        await completeInlineInput();
        if (restorePlaceholder && !document.querySelector('.inline-board-input')) {
            showAddBoardPlaceholder(columnIndex);
        }
    }

    // Handle adding the board
    async function addBoard() {
        const name = input.value.trim();
        if (!name) {
            input.focus();
            return;
        }

        try {
            // Create the board in this column (pass columnIndex directly to avoid race condition)
            await createNewBoard(name, null, columnIndex);
            await closeInlineBoardInput({ restorePlaceholder: false });
        } catch (error) {
            console.error('Error creating new board:', error);
            showGlassToast('Failed to create board. Please try again.', 'error');
            input.focus();
            input.select();
        }
    }

    // Handle cancel
    async function cancel() {
        await closeInlineBoardInput({ restorePlaceholder: true });
    }

    // Enter key to add
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            addBoard();
        } else if (e.key === 'Escape') {
            cancel();
        }
    });

    // Button clicks
    addBtn.addEventListener('click', addBoard);
    cancelBtn.addEventListener('click', cancel);

    const handleOutsidePointerDown = (event) => {
        if (!document.body.contains(inputContainer)) {
            if (_inlineBoardOutsideDismissHandler) {
                document.removeEventListener('pointerdown', _inlineBoardOutsideDismissHandler, true);
                _inlineBoardOutsideDismissHandler = null;
            }
            return;
        }

        if (inputContainer.contains(event.target)) {
            return;
        }

        void cancel();
    };

    _inlineBoardOutsideDismissHandler = handleOutsidePointerDown;
    setTimeout(() => {
        if (_inlineBoardOutsideDismissHandler === handleOutsidePointerDown) {
            document.addEventListener('pointerdown', handleOutsidePointerDown, true);
        }
    }, 0);

    // Prevent mousemove events from hiding this
    inputContainer.addEventListener('mousemove', (e) => {
        e.stopPropagation();
    });
}


// Render a single board with its bookmarks (with error boundaries)
async function renderBoard(board) {
    try {
        // Validate board data
        if (!board || !board.id) {
            console.error('Invalid board data:', board);
            return;
        }

        // Get bookmarks for this board (excluding deleted)
        let bookmarks = await db.bookmarks
            .where('boardId')
            .equals(board.id)
            .filter(b => !b.deletedAt)
            .toArray();

        // Sort bookmarks based on active feature flags
        bookmarks.sort((a, b) => {
            // 1. Pin Favorites (if enabled)
            if (window.pinFavoritesEnabled) {
                if (a.isPinned && !b.isPinned) return -1;
                if (!a.isPinned && b.isPinned) return 1;
            }

            // 2. Sorting behavior
            if (window.recentlyUsedEnabled) {
                const timeA = a.lastVisited ? new Date(a.lastVisited).getTime() : 0;
                const timeB = b.lastVisited ? new Date(b.lastVisited).getTime() : 0;
                if (timeA !== timeB) return timeB - timeA;
            } else if (window.frequentlyUsedEnabled) {
                const countA = a.visitCount || 0;
                const countB = b.visitCount || 0;
                if (countA !== countB) return countB - countA;
            }

            // 3. Default order
            return (a.order || 0) - (b.order || 0);
        });

        const visibleBookmarks = getVisibleBookmarksForBoard(board.id, bookmarks);
        const bookmarkToggleControl = getBoardBookmarkToggleControl(board.id, bookmarks.length);

        // Create board HTML
        const boardElement = document.createElement('div');
        // Add privacy-blur class DURING CREATION if privacy mode is enabled
        // This prevents the delay issue - board renders with blur already applied
        const isShared = !!board.shareId;
        let boardClasses = privacyModeEnabled ? 'board privacy-blur' : 'board';
        if (isShared) boardClasses += ' shared-board';
        boardElement.className = boardClasses;
        boardElement.setAttribute('data-board-id', board.id);

        // Create board title with add button (now the draggable element)
        const titleElement = document.createElement('div');
        titleElement.className = 'board-title';
        titleElement.draggable = true;
        titleElement.setAttribute('data-board-id', board.id);

        // Create text span for the title
        const titleText = document.createElement('span');
        titleText.className = 'board-title-text';
        titleText.textContent = board.name || 'Untitled Board';
        titleText.title = 'Double-click to open all links in new tabs';

        // Double-click on title opens all links in the board
        titleText.addEventListener('dblclick', async function (e) {
            e.stopPropagation();
            e.preventDefault();

            try {
                // Get all bookmarks for this board (excluding deleted)
                const boardId = board.id;
                const bookmarks = await db.bookmarks
                    .where('boardId').equals(boardId)
                    .filter(b => !b.deletedAt)
                    .toArray();

                if (bookmarks.length === 0) {
                    return;
                }

                // Confirm if there are many links
                if (bookmarks.length > 5) {
                    const confirmed = await showGlassConfirm(
                        'Open Multiple Links',
                        `Open ${bookmarks.length} links in new tabs?`,
                        { confirmText: 'Open All' }
                    );
                    if (!confirmed) return;
                }

                // Open all links (respects incognito mode)
                const urls = bookmarks.filter(b => b.url).map(b => b.url);
                openMultipleUrls(urls);
            } catch (error) {
                console.error('Error opening all board links:', error);
            }
        });

        titleElement.appendChild(titleText);

        // Add shared subtitle if board is shared
        if (isShared) {
            const sharedSubtitle = document.createElement('span');
            sharedSubtitle.className = 'shared-subtitle';
            sharedSubtitle.textContent = 'Shared';
            titleElement.appendChild(sharedSubtitle);
        }

        // Create button container
        const buttonContainer = document.createElement('div');
        buttonContainer.className = 'board-buttons';

        // Add "+" button for adding new bookmarks
        const addButton = document.createElement('button');
        addButton.className = 'board-add-btn';
        addButton.innerHTML = BOARD_ADD_ICON;
        addButton.title = 'Add new link';
        addButton.setAttribute('data-board-id', board.id);
        addButton.addEventListener('click', function (e) {
            e.stopPropagation();
            openAddBookmarkModal(board.id);
        });

        // Create menu container (for positioning dropdown)
        const menuContainer = document.createElement('div');
        menuContainer.className = 'board-menu-container';

        // Add 3-dot menu button
        const menuButton = document.createElement('button');
        menuButton.className = 'board-menu-btn';
        menuButton.innerHTML = '⋮';
        menuButton.title = 'Board options';
        menuButton.setAttribute('data-board-id', board.id);
        menuButton.addEventListener('click', function (e) {
            e.stopPropagation();
            toggleBoardMenu(board.id);
        });

        // Create dropdown menu
        const dropdown = document.createElement('div');
        dropdown.className = 'board-menu';
        dropdown.id = `board-menu-${board.id}`;

        // Open All Links option
        const openAllItem = document.createElement('button');
        openAllItem.className = 'board-menu-item';
        openAllItem.innerHTML = getOpenAllBoardMenuLabel();
        openAllItem.addEventListener('click', async function (e) {
            e.stopPropagation();
            try {
                await openAllBoardLinks(board.id);
            } catch (error) {
                console.error('Error opening all board links:', error);
            }
            closeBoardMenus();
        });

        // Fetch all titles option
        const fetchTitlesItem = document.createElement('button');
        fetchTitlesItem.className = 'board-menu-item';
        fetchTitlesItem.innerHTML = getFetchAllTitlesBoardMenuLabel();
        fetchTitlesItem.addEventListener('click', async function (e) {
            e.stopPropagation();
            closeBoardMenus();
            try {
                await fetchAllBoardLinkTitles(board.id);
            } catch (error) {
                console.error('Error fetching all board link titles:', error);
            }
        });

        // Edit option
        const editItem = document.createElement('button');
        editItem.className = 'board-menu-item';
        editItem.innerHTML = getEditBoardMenuLabel();
        editItem.addEventListener('click', async function (e) {
            e.stopPropagation();
            try {
                await openEditBoardModal(board.id);
            } catch (error) {
                console.error('Error opening edit board modal:', error);
            }
            closeBoardMenus();
        });

        // Share option
        const shareItem = document.createElement('button');
        shareItem.className = 'board-menu-item';
        shareItem.innerHTML = getShareBoardMenuLabel(isShared);
        shareItem.addEventListener('click', async function (e) {
            e.stopPropagation();
            try {
                await openShareModal('board', board.id);
            } catch (error) {
                console.error('Error opening share modal:', error);
            }
            closeBoardMenus();
        });

        // Divider
        const divider = document.createElement('div');
        divider.className = 'board-menu-divider';

        // Delete option
        const deleteItem = document.createElement('button');
        deleteItem.className = 'board-menu-item danger';
        deleteItem.innerHTML = getDeleteBoardMenuLabel();
        deleteItem.addEventListener('click', async function (e) {
            e.stopPropagation();
            try {
                await showDeleteConfirmation(board.name, 'board', board.id);
            } catch (error) {
                console.error('Error showing delete confirmation:', error);
            }
            closeBoardMenus();
        });

        dropdown.appendChild(openAllItem);
        dropdown.appendChild(fetchTitlesItem);
        dropdown.appendChild(editItem);
        dropdown.appendChild(shareItem);
        dropdown.appendChild(divider);
        dropdown.appendChild(deleteItem);

        menuContainer.appendChild(menuButton);
        // Append dropdown to body to avoid clipping by board's overflow:hidden
        document.body.appendChild(dropdown);

        buttonContainer.appendChild(addButton);
        buttonContainer.appendChild(menuContainer);
        titleElement.appendChild(buttonContainer);

        // Create bookmarks list with error boundaries
        const linksList = document.createElement('ul');
        linksList.className = 'board-links';

        for (const bookmark of visibleBookmarks) {
            try {
                // Validate bookmark data
                if (!bookmark || !bookmark.id || !bookmark.url) {
                    console.error('Invalid bookmark data in board', board.id, ':', bookmark);
                    continue; // Skip this bookmark
                }

                const listItem = document.createElement('li');
                listItem.draggable = true;
                listItem.setAttribute('data-bookmark-id', bookmark.id);

                // FIX [Issue #2]: Removed duplicate click handler here - selection mode is now handled
                // by the event delegation handler on container (lines ~1196-1221)
                // Having both handlers caused double-toggle: selection would toggle twice (select then deselect)

                const link = document.createElement('a');
                link.href = bookmark.url;

                // Apply openInNewTab setting during link creation
                if (openLinksInNewTab) {
                    link.setAttribute('target', '_blank');
                    link.setAttribute('rel', 'noopener noreferrer');
                }

                // Create content container for bookmark
                const bookmarkContent = document.createElement('div');
                bookmarkContent.className = 'bookmark-content';

                // Create and add favicon (await cache check for faster load)
                const favicon = await createFaviconElement(bookmark.url, bookmark.title);
                bookmarkContent.appendChild(favicon);

                // Create text stack for title + optional note
                const bookmarkText = document.createElement('span');
                bookmarkText.className = 'bookmark-text';

                // Create text span for the title
                const titleSpan = document.createElement('span');
                titleSpan.className = 'bookmark-title';
                titleSpan.textContent = bookmark.title || 'Untitled';
                bookmarkText.appendChild(titleSpan);

                const noteText = getBookmarkNoteText(bookmark.description);
                if (noteText) {
                    const noteSpan = document.createElement('span');
                    noteSpan.className = 'bookmark-note';
                    noteSpan.textContent = noteText;
                    bookmarkText.appendChild(noteSpan);
                }

                bookmarkContent.appendChild(bookmarkText);

                // Create action buttons container
                const bookmarkActions = document.createElement('div');
                bookmarkActions.className = 'bookmark-actions';

                // Create pin button for bookmark
                const bookmarkPinBtn = document.createElement('button');
                bookmarkPinBtn.className = 'bookmark-pin-btn';
                bookmarkPinBtn.innerHTML = bookmark.isPinned ? BOOKMARK_UNPIN_ICON : BOOKMARK_PIN_ICON;
                bookmarkPinBtn.title = bookmark.isPinned ? 'Unpin bookmark' : 'Pin bookmark';
                bookmarkPinBtn.setAttribute('data-action', 'pin-bookmark');
                bookmarkPinBtn.setAttribute('data-bookmark-id', bookmark.id);
                bookmarkPinBtn.addEventListener('click', async function (e) {
                    e.preventDefault();
                    e.stopPropagation();
                    if (typeof toggleBookmarkPin === 'function') {
                        await toggleBookmarkPin(bookmark.id);
                    }
                });

                // Create edit button for bookmark
                const bookmarkEditBtn = document.createElement('button');
                bookmarkEditBtn.className = 'bookmark-edit-btn';
                bookmarkEditBtn.innerHTML = BOOKMARK_EDIT_ICON;
                bookmarkEditBtn.title = 'Edit bookmark';
                bookmarkEditBtn.addEventListener('click', async function (e) {
                    e.preventDefault();
                    e.stopPropagation();
                    try {
                        await openEditBookmarkModal(bookmark.id);
                    } catch (error) {
                        console.error('Error opening edit bookmark modal:', error);
                    }
                });

                // Create delete button for bookmark
                const bookmarkDeleteBtn = document.createElement('button');
                bookmarkDeleteBtn.className = 'bookmark-delete-btn';
                bookmarkDeleteBtn.innerHTML = BOOKMARK_DELETE_ICON;
                bookmarkDeleteBtn.title = 'Delete bookmark';
                bookmarkDeleteBtn.addEventListener('click', async function (e) {
                    e.preventDefault();
                    e.stopPropagation();
                    try {
                        await showDeleteConfirmation(bookmark.title, 'bookmark', bookmark.id);
                    } catch (error) {
                        console.error('Error showing delete confirmation:', error);
                    }
                });

                if (window.pinFavoritesEnabled) {
                    bookmarkActions.appendChild(bookmarkPinBtn);
                }
                bookmarkActions.appendChild(bookmarkEditBtn);
                bookmarkActions.appendChild(bookmarkDeleteBtn);

                link.appendChild(bookmarkContent);
                link.appendChild(bookmarkActions);

                listItem.appendChild(link);
                linksList.appendChild(listItem);
            } catch (error) {
                console.error('Error rendering bookmark:', bookmark, error);
                // Continue with other bookmarks even if one fails
            }
        }

        // Assemble board
        boardElement.appendChild(titleElement);
        boardElement.appendChild(linksList);

        if (bookmarkToggleControl) {
            const showRemainingButton = document.createElement('button');
            showRemainingButton.className = 'board-show-remaining-btn';
            showRemainingButton.textContent = bookmarkToggleControl.label;
            showRemainingButton.setAttribute('data-action', bookmarkToggleControl.action);
            showRemainingButton.setAttribute('data-board-id', board.id);
            boardElement.appendChild(showRemainingButton);
        }

        // Add to appropriate column (validate columnIndex to prevent silent failures)
        const validColumnIndex = validateColumnIndex(board.columnIndex);
        const column = document.querySelector(`[data-column="${validColumnIndex}"]`);
        if (column) {
            column.appendChild(boardElement);
        } else {
            console.error(`Column ${validColumnIndex} not found for board ${board.id}`);
        }

    } catch (error) {
        console.error('Failed to render board:', error);
    }
}
