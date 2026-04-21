// Database initialization and default data seeding
async function initializeDatabase(options = {}) {
    const resolvedOptions = (typeof options === 'object' && options !== null)
        ? options
        : { shouldLoadBoards: options !== false };
    const shouldLoadBoards = resolvedOptions.shouldLoadBoards !== false;
    const startupStorage = (resolvedOptions.startupStorage && typeof resolvedOptions.startupStorage === 'object')
        ? resolvedOptions.startupStorage
        : null;
    const isLoggedIn = resolvedOptions.isLoggedIn === true;
    const deferBootstrap = resolvedOptions.deferBootstrap === true;

    try {
        // Check if we need to migrate from old schema
        await handleDatabaseMigration();

        // Initialize pages system
        await initializePagesSystem({
            startupStorage,
            isLoggedIn,
            deferBootstrap
        });

        // Load pages navigation
        await loadPagesNavigation();

        // Load startup UI preferences before rendering boards so the first paint
        // uses the right shell and bookmark visibility settings.
        await Promise.all([
            syncPrivacyModeFromStorage(startupStorage),
            loadIncognitoModeFromStorage(startupStorage),
            loadCompactModeFromStorage(startupStorage),
            loadTruncateTitlesSetting(startupStorage),
            loadOpenInNewTabSetting(startupStorage),
            loadLargeBoardCollapseSetting(startupStorage),
            loadShowBookmarkNotesSetting(startupStorage)
        ]);

        // Load clock separately so it doesn't block the main database initialization
        if (typeof loadShowClockSetting === 'function') {
            loadShowClockSetting(startupStorage).catch(err => {
                console.error('Failed to initialize clock:', err);
            });
        }

        // Load and render boards for current page ONLY if logged in
        // This prevents boards from appearing in DOM when user is logged out
        if (shouldLoadBoards) {
            await loadBoardsFromDatabase();
        }

    } catch (error) {
        console.error('Database initialization failed:', error);
        // Fallback to showing empty state or error message
    }
}

// Handle migration from version 2 to version 3 (adding pages support)
async function handleDatabaseMigration() {
    try {
        const pageCount = await db.pages.count();
        const boardCount = await db.boards.count();

        // If we have boards but no pages, we need to migrate
        if (boardCount > 0 && pageCount === 0) {


            // Create default "Home" page
            const homePageId = generateId();
            await db.pages.add({
                id: homePageId,
                name: 'Home',
                order: 0,
                createdAt: new Date(),
                isDefault: true
            });


            // Update all existing boards to belong to the Home page
            const allBoards = await db.boards.toArray();
            for (const board of allBoards) {
                await db.boards.update(board.id, { pageId: homePageId });
            }



            // Sync migrated data to server if user is logged in
        }
    } catch (error) {
        console.error('Migration failed:', error);
    }
}

// Initialize pages system and set current page
async function initializePagesSystem(options = {}) {
    const startupStorage = (options.startupStorage && typeof options.startupStorage === 'object')
        ? options.startupStorage
        : null;
    const resolvedIsLoggedIn = options.isLoggedIn === true;
    const shouldDeferBootstrap = options.deferBootstrap === true;

    try {
        const [pageCount, boardCount] = await Promise.all([
            db.pages.filter(p => !p.deletedAt).count(),
            db.boards.count()
        ]);

        // Check initialization flag using Chrome storage
        const result = startupStorage || await new Promise((resolve) => {
            if (typeof chrome !== 'undefined' && chrome.storage) {
                chrome.storage.local.get(['initialized', 'currentPageId'], resolve);
            } else {
                // Fallback to localStorage for development
                resolve({
                    initialized: localStorage.getItem('bookmark_manager_initialized'),
                    currentPageId: localStorage.getItem('current_page_id')
                });
            }
        });

        const isInitialized = normalizeBooleanValue(result.initialized);

        if (pageCount === 0 && boardCount === 0 && !isInitialized) {
            // Check if user is logged in - if so, DON'T create Home here
            // Let the server sync logic handle it (in DOMContentLoaded handler)
            const isLoggedIn = resolvedIsLoggedIn || await SyncManager.isLoggedIn();
            if (isLoggedIn) {

                // Don't create Home page - the server sync code will handle it
                // Just set the initialized flag so we don't keep checking
                if (typeof chrome !== 'undefined' && chrome.storage) {
                    chrome.storage.local.set({ initialized: true });
                }
                return; // Let server sync create/import data
            }

            if (shouldDeferBootstrap) {
                return;
            }

            // First time user (NOT logged in) - create Home page


            const homePageId = generateId();
            await db.pages.add({
                id: homePageId,
                name: 'Home',
                order: 0,
                createdAt: new Date(),
                isDefault: true
            });


            currentPageId = homePageId;
            // No longer seeding default data - start with empty page

            // Set initialization flag and current page
            if (typeof chrome !== 'undefined' && chrome.storage) {
                chrome.storage.local.set({
                    initialized: true,
                    currentPageId: homePageId
                });
            } else {
                localStorage.setItem('bookmark_manager_initialized', 'true');
                localStorage.setItem('current_page_id', homePageId.toString());
            }
        } else {
            // Load current page from storage or use default
            if (result.currentPageId) {
                currentPageId = result.currentPageId || null;
            } else {
                // Find default page or first page (excluding deleted)
                const defaultPage = await db.pages
                    .filter(p => p.isDefault && !p.deletedAt)
                    .first();
                if (defaultPage) {
                    currentPageId = defaultPage.id;
                } else {
                    const firstPage = await db.pages
                        .filter(p => !p.deletedAt)
                        .first();
                    if (firstPage) {
                        currentPageId = firstPage.id;
                    }
                }
            }
        }

        // Ensure we have a valid current page (not deleted)
        if (currentPageId) {
            const currentPage = await db.pages.get(currentPageId);
            if (!currentPage || currentPage.deletedAt) {
                // Current page doesn't exist or was deleted, fallback to first available page
                const firstPage = await db.pages.filter(p => !p.deletedAt).first();
                if (firstPage) {
                    currentPageId = firstPage.id;
                    // Update stored current page
                    if (typeof chrome !== 'undefined' && chrome.storage) {
                        chrome.storage.local.set({ currentPageId: currentPageId });
                    } else {
                        localStorage.setItem('current_page_id', currentPageId.toString());
                    }
                }
            }
        }

    } catch (error) {
        console.error('Pages system initialization failed:', error);
    }
}

// Load and render enhanced page navigation
// options.scrollToActive: if true, scroll to show the active tab (default: true)
async function loadPagesNavigation(options = { scrollToActive: true }) {
    try {
        // Get all pages, excluding deleted ones
        const pages = await db.pages
            .filter(p => !p.deletedAt)  // Exclude soft-deleted pages
            .toArray();
        pages.sort((a, b) => a.order - b.order);  // Sort by order

        // Render horizontal tabs
        renderPageTabs(pages);

        // Setup arrow navigation (Chrome-style dynamic visibility)
        setupArrowNavigation();

        // Attach drag listeners to the newly rendered page tabs
        attachPageTabDragListeners();

        // Re-attach bookmark drag listeners after page tab operations
        // This is needed because SortableJS may interfere with HTML5 drag listeners
        attachDragDropListeners();

        // Scroll the active tab into view after rendering (skip on sync refresh to prevent jerk)
        if (options.scrollToActive) {
            const pageTabsContainer = document.getElementById('pageTabs');
            const activeTab = pageTabsContainer?.querySelector('.page-tab.active');
            if (activeTab) {
                // Use setTimeout to ensure the DOM is fully rendered before scrolling
                setTimeout(() => {
                    activeTab.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
                }, 100);
            }
        }

        // Keep Settings > Quick Save destination list in sync when pages change.
        const settingsModal = document.getElementById('settingsModal');
        if (settingsModal && settingsModal.classList.contains('active')) {
            loadSettingsQuickSaveDestinationOptions().catch((error) => {
                console.error('Failed to refresh quick save destination options after page navigation update:', error);
            });
        }

        // Keep search results accurate for page-only mutations (rename/reorder/delete page).
        await refreshSearchIfOpen();

        // Keep trash list in sync for page-only refresh paths (for example, non-active page delete).
        await refreshTrashModalIfOpen('loadPagesNavigation');

    } catch (error) {
        console.error('Failed to load page navigation:', error);
    }
}

// RAF-based auto-scroll state for tab drag
let _tabDragAutoScrollRAF = null;
let _lastPointerX = 0;
let _pointerTracker = null;  // Store reference for cleanup

// Start RAF-based auto-scroll for tab drag
function startTabDragAutoScroll() {
    function scrollLoop() {
        const pageTabs = document.getElementById('pageTabs');
        if (!pageTabs || !_isTabDragInProgress) {
            _tabDragAutoScrollRAF = null;
            return;
        }

        const containerRect = pageTabs.getBoundingClientRect();
        const edgeThreshold = 200;
        const scrollStep = 5;

        const nearLeftEdge = _lastPointerX < containerRect.left + edgeThreshold && _lastPointerX >= containerRect.left;
        const nearRightEdge = _lastPointerX > containerRect.right - edgeThreshold && _lastPointerX <= containerRect.right;

        if (nearLeftEdge) {
            const proximity = 1 - ((_lastPointerX - containerRect.left) / edgeThreshold);
            const speed = Math.ceil(scrollStep * proximity);
            pageTabs.scrollLeft = Math.max(0, pageTabs.scrollLeft - speed);
        } else if (nearRightEdge) {
            const proximity = 1 - ((containerRect.right - _lastPointerX) / edgeThreshold);
            const speed = Math.ceil(scrollStep * proximity);
            const maxScroll = pageTabs.scrollWidth - pageTabs.clientWidth;
            pageTabs.scrollLeft = Math.min(maxScroll, pageTabs.scrollLeft + speed);
        }

        _tabDragAutoScrollRAF = requestAnimationFrame(scrollLoop);
    }

    _tabDragAutoScrollRAF = requestAnimationFrame(scrollLoop);
}

// Stop RAF-based auto-scroll
function stopTabDragAutoScroll() {
    if (_tabDragAutoScrollRAF) {
        cancelAnimationFrame(_tabDragAutoScrollRAF);
        _tabDragAutoScrollRAF = null;
    }
}

// Render horizontal page tabs
function renderPageTabs(pages) {
    // Defer rendering if a tab is being dragged to prevent SortableJS crash
    if (_isTabDragInProgress) {
        _renderTabsPendingAfterDrag = true;
        return;
    }

    const pageTabsContainer = document.getElementById('pageTabs');

    if (!pageTabsContainer) {
        console.error('Page tabs container not found');
        return;
    }

    // Clear existing tabs
    pageTabsContainer.innerHTML = '';

    // Create tab for each page
    pages.forEach(page => {
        const tab = document.createElement('button');
        tab.className = 'page-tab';
        tab.dataset.pageId = page.id;

        // Mark active page
        if (page.id === currentPageId) {
            tab.classList.add('active');
        }

        // Mark shared page with purple styling
        if (page.shareId) {
            tab.classList.add('shared');
        }

        // Create tab name span for inline editing support
        const tabName = document.createElement('span');
        tabName.className = 'tab-name';
        tabName.textContent = page.name;
        tabName.dataset.text = page.name;  // For pseudo-element to prevent layout shift on bold
        tab.appendChild(tabName);

        // Add share icon if page is shared (corner badge)
        if (page.shareId) {
            const shareIcon = document.createElement('span');
            shareIcon.className = 'share-icon';
            shareIcon.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72"><path d="M 48.730469 10.037109 C 43.199469 10.037109 38.699219 14.536359 38.699219 20.068359 C 38.699219 20.437847 38.720642 20.802863 38.759766 21.162109 L 26.601562 27.328125 C 25.073599 26.394326 23.285065 25.847656 21.367188 25.847656 C 15.810188 25.847656 11.287109 30.367781 11.287109 35.925781 C 11.287109 41.483781 15.810188 46.005859 21.367188 46.005859 C 23.359628 46.005859 25.213692 45.415871 26.779297 44.414062 L 39.017578 51.464844 C 39.006915 51.653493 38.990234 51.83998 38.990234 52.03125 C 38.990234 57.54025 43.471469 62.023438 48.980469 62.023438 C 54.489469 62.023437 58.972656 57.54025 58.972656 52.03125 C 58.972656 46.52225 54.488469 42.041016 48.980469 42.041016 C 46.546917 42.041016 44.317171 42.919248 42.582031 44.371094 L 31.255859 37.847656 C 31.376646 37.224963 31.445312 36.583265 31.445312 35.925781 C 31.445312 35.278544 31.378857 34.646813 31.261719 34.033203 L 42.832031 28.164062 C 44.490112 29.375707 46.524474 30.101562 48.730469 30.101562 C 54.261469 30.101562 58.763672 25.600359 58.763672 20.068359 C 58.763672 14.536359 54.261469 10.037109 48.730469 10.037109 z"/></svg>';
            shareIcon.title = 'This page is shared';
            tab.appendChild(shareIcon);
        }

        // Add dropdown menu button
        const menuBtn = document.createElement('button');
        menuBtn.className = 'tab-menu-btn';
        menuBtn.innerHTML = '▾';
        menuBtn.title = 'Page options';
        menuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            showTabContextMenu(e, page);
        });
        tab.appendChild(menuBtn);

        // Click to switch page
        tab.addEventListener('click', async (e) => {
            try {
                await switchToPage(page.id);
            } catch (error) {
                console.error('Error switching page:', error);
            }
        });

        pageTabsContainer.appendChild(tab);
    });

    // Initialize SortableJS for page tabs drag-and-drop reordering
    if (pageTabsSortableInstance) {
        pageTabsSortableInstance.destroy();
    }

    // Check if read-only mode (grace/expired status)
    const isReadOnly = false; // Bypassed as per user request

    pageTabsSortableInstance = Sortable.create(pageTabsContainer, {
        animation: 400,
        draggable: '.page-tab',
        filter: 'input',  // Don't initiate drag from input elements (tab rename)
        preventOnFilter: false,  // Allow input events to proceed normally
        ghostClass: 'sortable-ghost',
        chosenClass: 'sortable-chosen',
        dragClass: 'sortable-drag',
        delay: 150, // Small delay to distinguish from click
        delayOnTouchOnly: true,
        disabled: isReadOnly,  // Disable drag in read-only mode
        scroll: true,  // Enable auto-scroll during drag
        forceAutoScrollFallback: true,  // Force SortableJS autoscroll (bypasses native browser DnD scroll)
        scrollSensitivity: 200,  // pixels from edge to trigger scroll
        scrollSpeed: 10,  // scroll speed

        onStart: function (evt) {
            // Block drag in read-only mode (double-check)
            if (!canModify()) {
                evt.preventDefault();
                return false;
            }
            // Set flag to prevent renderPageTabs from destroying SortableJS mid-drag
            _isTabDragInProgress = true;
            // Initialize pointer position from start event
            _lastPointerX = evt.originalEvent?.clientX || 0;
            // Add pointermove listener directly to the dragged element (it has pointer capture)
            const draggedEl = evt.item;
            if (draggedEl) {
                _pointerTracker = (e) => { _lastPointerX = e.clientX; };
                draggedEl.addEventListener('pointermove', _pointerTracker);
            }
            startTabDragAutoScroll();
        },

        onMove: function (evt, originalEvent) {
            // Update pointer position on every move (SortableJS provides this reliably)
            if (originalEvent && originalEvent.clientX !== undefined) {
                _lastPointerX = originalEvent.clientX;
            }
        },

        onEnd: function (evt) {
            // Stop auto-scroll and remove pointer tracker from dragged element
            stopTabDragAutoScroll();
            if (_pointerTracker && evt.item) {
                evt.item.removeEventListener('pointermove', _pointerTracker);
                _pointerTracker = null;
            }


            // Clear drag flag immediately (before defer)
            _isTabDragInProgress = false;

            // Capture indices before deferring (evt may not be valid later)
            const capturedOldIndex = evt.oldIndex;
            const capturedNewIndex = evt.newIndex;

            // CRITICAL: Defer all async work (reorderPages, loadPagesNavigation)
            // to AFTER SortableJS finishes its internal cleanup.
            // This prevents "Cannot read properties of null (reading 'removeEventListener')"
            // crash that occurs when we destroy DOM elements SortableJS still references.
            setTimeout(async () => {
                // Block reorder in read-only mode (revert visual change)
                if (!canModify()) {
                    try {
                        await loadPagesNavigation();
                    } catch (error) {
                        console.error('Error reloading pages navigation:', error);
                    }
                    // Process any pending tab render
                    if (_renderTabsPendingAfterDrag) {
                        _renderTabsPendingAfterDrag = false;
                        renderPageTabs(await db.pages.filter(p => !p.deletedAt).sortBy('order'));
                        // CRITICAL: Attach listeners to NEW tab elements after deferred render
                        attachPageTabDragListeners();
                        attachDragDropListeners();
                    }

                    return;
                }
                // Reorder pages in database
                try {

                    await reorderPages(capturedOldIndex, capturedNewIndex);

                } catch (error) {
                    console.error('Error reordering pages:', error);
                }
                // Process any pending tab render that was deferred during drag
                if (_renderTabsPendingAfterDrag) {
                    _renderTabsPendingAfterDrag = false;
                    renderPageTabs(await db.pages.filter(p => !p.deletedAt).sortBy('order'));
                    // CRITICAL: Attach listeners to NEW tab elements after deferred render
                    attachPageTabDragListeners();
                    attachDragDropListeners();
                }

            }, 0);
        }
    });
}

// Setup arrow navigation buttons (Chrome-style dynamic visibility)
let arrowNavigationInitialized = false;
function setupArrowNavigation() {
    const scrollLeftBtn = document.getElementById('scrollLeft');
    const scrollRightBtn = document.getElementById('scrollRight');
    const pageTabs = document.getElementById('pageTabs');

    if (!pageTabs) return;

    // Only initialize once to prevent duplicate listeners
    if (arrowNavigationInitialized) {
        // Just update the navigation state (use requestAnimationFrame to ensure layout is calculated)
        requestAnimationFrame(() => updateTabNavigation());
        return;
    }
    arrowNavigationInitialized = true;

    // Left arrow click
    if (scrollLeftBtn) {
        scrollLeftBtn.addEventListener('click', () => {
            pageTabs.scrollBy({ left: -200, behavior: 'smooth' });
        });
    }

    // Right arrow click
    if (scrollRightBtn) {
        scrollRightBtn.addEventListener('click', () => {
            pageTabs.scrollBy({ left: 200, behavior: 'smooth' });
        });
    }

    // Update on scroll
    pageTabs.addEventListener('scroll', updateTabNavigation);

    // Update on resize
    window.addEventListener('resize', updateTabNavigation);

    // Initial update
    updateTabNavigation();
}

// Update tab navigation visibility based on overflow and scroll position
function updateTabNavigation() {
    const pageTabs = document.getElementById('pageTabs');
    const scrollLeftBtn = document.getElementById('scrollLeft');
    const navRightGroup = document.getElementById('navRightGroup');
    const addPageBtn = document.getElementById('addPageBtn');
    const pageTabsContainer = document.getElementById('pageTabsContainer');

    if (!pageTabs) return;

    const hasOverflow = pageTabs.scrollWidth > pageTabs.clientWidth + 5; // 5px tolerance
    const scrollLeft = pageTabs.scrollLeft;
    const maxScroll = pageTabs.scrollWidth - pageTabs.clientWidth;
    const isScrolledRight = scrollLeft > 5; // 5px tolerance
    const canScrollMore = scrollLeft < maxScroll - 5;

    // Left arrow: show when overflow exists (same as right arrow)
    if (scrollLeftBtn) {
        scrollLeftBtn.classList.toggle('hidden', !hasOverflow);
    }

    // Right group (arrow + plus): show only when overflow exists
    // Right arrow stays visible always (unlike left) to keep layout stable
    if (navRightGroup) {
        navRightGroup.classList.toggle('hidden', !hasOverflow);
    }

    // Inside plus button: show only when NO overflow
    if (addPageBtn) {
        addPageBtn.classList.toggle('hidden', hasOverflow);
    }

    // Show edge fade only where content is clipped.
    if (pageTabsContainer) {
        pageTabsContainer.classList.toggle('show-left-fade', hasOverflow && isScrolledRight);
        pageTabsContainer.classList.toggle('show-right-fade', hasOverflow && canScrollMore);
    }
}

// Open rename page modal
function openRenamePageModal(page) {
    // Block in read-only mode (grace/expired status)
    if (!canModify()) return;

    currentPageToRename = page;
    document.getElementById('renamePageInput').value = page.name;
    document.getElementById('renamePageModal').classList.add('active');
    document.getElementById('renamePageInput').focus();
    document.getElementById('renamePageInput').select();
}

// Close rename page modal
function closeRenamePageModal() {
    document.getElementById('renamePageModal').classList.remove('active');
    currentPageToRename = null;
    document.getElementById('renamePageForm').reset();
}

function closeTabContextMenu() {
    const menu = document.getElementById('tabMenuDropdown');
    if (menu) {
        menu.classList.remove('active');
    }
}

// Show right-click context menu for tab
function showTabContextMenu(event, page) {
    const menu = document.getElementById('tabMenuDropdown');

    if (!menu) return;

    // Keep board and page dropdown systems in sync
    closeBoardMenus();

    // Close menu if already open
    if (menu.classList.contains('active')) {
        closeTabContextMenu();
        return;
    }

    // Update share menu item text based on shared status
    const shareMenuItem = menu.querySelector('[data-action="share"] span:last-child');
    if (shareMenuItem) {
        const isPageShared = !!page.shareId;
        shareMenuItem.textContent = isPageShared ? 'Manage Share' : 'Share Page';
    }

    menu.classList.add('active');

    // Position menu at cursor - use actual menu dimensions
    const menuRect = menu.getBoundingClientRect();
    const menuWidth = menuRect.width || 160;  // Fallback to 160 if not rendered yet
    const menuHeight = menuRect.height || 120; // Fallback to 120 if not rendered yet

    let left = event.clientX;
    let top = event.clientY;

    // Adjust if menu would go off-screen
    if (left + menuWidth > window.innerWidth) {
        left = window.innerWidth - menuWidth - 10;
    }
    if (top + menuHeight > window.innerHeight) {
        top = window.innerHeight - menuHeight - 10;
    }
    // Ensure menu doesn't go off left or top edge
    left = Math.max(10, left);
    top = Math.max(10, top);

    menu.style.left = left + 'px';
    menu.style.top = top + 'px';

    // Handle menu actions
    const handleAction = async (action) => {
        closeTabContextMenu();
        await handleTabAction(action, page);
    };

    // Add click handlers to menu items (remove old listeners by cloning)
    menu.querySelectorAll('.tab-menu-item').forEach(item => {
        const newItem = item.cloneNode(true);
        item.replaceWith(newItem);
        newItem.addEventListener('click', () => handleAction(newItem.dataset.action));
    });
}

// Close context menu when clicking outside
document.addEventListener('click', (e) => {
    if (!e.target.closest('.tab-menu-dropdown')) {
        closeTabContextMenu();
    }
});

// Handle tab context menu actions
async function handleTabAction(action, page) {
    // Block in read-only mode (grace/expired status)
    if (!canModify()) return;

    try {
        if (action === 'rename') {
            openRenamePageModal(page);
        } else if (action === 'share') {
            await openShareModal('page', page.id);
        } else if (action === 'delete') {
            // Don't allow deleting the last page (only count non-deleted pages)
            const activePages = await db.pages.filter(p => !p.deletedAt).toArray();
            if (activePages.length === 1) {
                showGlassToast('Cannot delete the last page. At least one page must exist.', 'warning');
                return;
            }

            // Confirm deletion
            const boardCount = await db.boards
                .where('pageId').equals(page.id)
                .filter(b => !b.deletedAt)
                .count();
            const confirmed = await showGlassConfirm(
                `Delete "${page.name}"?`,
                `This will move the page and all ${boardCount} boards to trash. You can restore them within 30 days.`,
                { confirmText: 'Delete', confirmClass: 'btn-danger' }
            );

            if (!confirmed) {
                return;
            }

            const result = await moveToTrash('page', page.id);
            if (!result?.success) {
                showGlassToast(result?.error || 'Failed to move page to trash', 'error');
                return;
            }

            // If deleted page was active, switch to first active page
            if (page.id === currentPageId) {
                const firstPage = await db.pages
                    .filter(p => !p.deletedAt)
                    .first();
                if (firstPage) {
                    await switchToPage(firstPage.id);
                } else {
                    currentPageId = null;
                }
            }

            // Refresh navigation
            await loadPagesNavigation();
            broadcastDataChange('moveToTrash');
        }
    } catch (error) {
        console.error('Failed to handle tab action:', error);
        showGlassToast('An error occurred. Please try again.', 'error');
    }
}

// Reorder pages after drag-and-drop
async function reorderPages(oldIndex, newIndex) {
    // Block reorder in read-only mode (grace/expired status)
    if (!canModify()) return;

    // No-op if position didn't change
    if (oldIndex === newIndex) return;

    try {
        const syncScope = await ensureLocalMutationSyncScopeAllowed({
            contextLabel: 'reorderPages'
        });
        if (!syncScope.allowed) {
            return;
        }

        // Get all non-deleted pages in current order
        const pages = await db.pages
            .filter(p => !p.deletedAt)
            .toArray();
        pages.sort((a, b) => a.order - b.order);
        const pageBeforeById = new Map(pages.map(page => [page.id, cloneUndoRedoSnapshot(page)]));

        // Store old orders for comparison
        const oldOrders = new Map(pages.map(p => [p.id, p.order]));

        // Move page from oldIndex to newIndex
        const [movedPage] = pages.splice(oldIndex, 1);
        pages.splice(newIndex, 0, movedPage);

        // Only update pages whose order actually changed
        const now = getCurrentTimestamp();
        let changedCount = 0;
        const changedPageIds = [];
        for (let i = 0; i < pages.length; i++) {
            const page = pages[i];
            const previousOrder = oldOrders.get(page.id);

            // Skip if order hasn't changed
            if (previousOrder === i) continue;

            await db.pages.update(page.id, { order: i, updatedAt: now });
            changedCount++;
            changedPageIds.push(page.id);
        }

        const changedPagesAfter = await db.pages.bulkGet(changedPageIds);
        const ops = changedPagesAfter
            .filter(page => !!page)
            .map(page => ({
                table: 'pages',
                id: page.id,
                before: pageBeforeById.get(page.id) || null,
                after: page
            }));
        const queueAttempt = await queueSyncItemsAtomically(
            ops
                .filter(op => op.after)
                .map(op => ({
                    op: 'upsert',
                    table: 'pages',
                    id: op.id,
                    data: op.after
                })),
            { contextLabel: 'reorderPages' }
        );
        if (!queueAttempt.success) {
            await rollbackLocalMutationOps(ops);
            showGlassToast(queueAttempt.error || 'Failed to reorder pages. Please try again.', 'error');
            await loadPagesNavigation();
            return;
        }

        if (!isApplyingUndoRedoHistory && changedPageIds.length > 0) {
            await recordUndoRedoHistoryEntry({
                kind: 'page_reorder',
                label: changedCount === 1 ? 'Reorder 1 page' : `Reorder ${changedCount} pages`,
                ops
            });
        }


        // Refresh navigation
        await loadPagesNavigation();
        broadcastDataChange('reorderPages');

    } catch (error) {
        console.error('Failed to reorder pages:', error);
    }
}

// Switch to a different page
// Session-based set of unlocked page IDs
const unlockedPages = new Set();

async function switchToPage(pageId, options = {}) {
    try {
        // Cancel any pending placeholder timeout from previous page
        // This prevents placeholder from appearing on wrong page during rapid page switches
        if (_showPlaceholderTimeoutId) {
            clearTimeout(_showPlaceholderTimeoutId);
            _showPlaceholderTimeoutId = null;
        }

        // SAFETY: Clear any stuck drag flags that could block board loading
        // This ensures page tab clicks always work, even if a previous drag left flags stuck
        // (dragend event may not fire in some edge cases, leaving flags true)
        // Note: Don't warn during legitimate cross-page drags (isPageSwitchingDuringDrag)
        if (_isBoardDragInProgress) {
            if (!isPageSwitchingDuringDrag) {
                console.warn('switchToPage: Clearing stuck _isBoardDragInProgress flag');
            }
            _isBoardDragInProgress = false;
            _loadBoardsPendingAfterDrag = false;
        }
        if (_isBookmarkDragInProgress) {
            if (!isPageSwitchingDuringDrag) {
                console.warn('switchToPage: Clearing stuck _isBookmarkDragInProgress flag');
            }
            _isBookmarkDragInProgress = false;
            _loadBoardsPendingAfterBookmarkDrag = false;
        }
        // Recover stale inline input state before making page-switch decisions.
        recoverStaleInlineInputState('switchToPage');

        // If user explicitly switches page while inline input is open, dismiss it so
        // board rendering does not stay blocked on _isInlineInputActive.
        if (!isPageSwitchingDuringDrag && currentPageId && pageId !== currentPageId && _isInlineInputActive) {
            dismissInlineInputs('page_switch');
        }

        // Note: Don't clear _loadBoardsInProgress - it has proper finally cleanup

        // Exit selection mode when switching pages (but NOT during drag - preserve selection for cross-page move)
        if (!isDraggingBookmark) {
            if (isSelectionMode) {
                toggleSelectionMode();
            }
            // Clear any bookmark selection when switching pages
            clearBookmarkSelection();
        }

        // Verify page exists and is not in trash
        const page = await db.pages.get(pageId);
        if (!page || page.deletedAt) {
            console.error('Page not found or deleted:', pageId);
            return;
        }

        // Check if page is locked and not yet unlocked in this session
        if (page.password && !unlockedPages.has(pageId) && !options.bypassLock) {
            showPagePasswordPrompt(pageId);
            return;
        }

        // Update current page
        currentPageId = pageId;

        // Save to storage
        if (typeof chrome !== 'undefined' && chrome.storage) {
            chrome.storage.local.set({ currentPageId: pageId });
        } else {
            localStorage.setItem('current_page_id', pageId.toString());
        }

        // Update UI
        updateActivePageTab();

        // Load page content
        await loadBoardsFromDatabase();

    } catch (error) {
        console.error('Failed to switch page:', error);
    }
}

// Show password prompt for locked page
let pendingLockedPageId = null;

function showPagePasswordPrompt(pageId) {
    pendingLockedPageId = pageId;
    const modal = document.getElementById('pagePasswordModal');
    const input = document.getElementById('accessPagePassword');
    const error = document.getElementById('passwordError');
    
    if (modal && input) {
        input.value = '';
        error.classList.add('hidden');
        modal.classList.add('active');
        setTimeout(() => input.focus(), 100);
    }
}

// Initialize Password Prompt Modal
function initializePasswordPrompt() {
    const modal = document.getElementById('pagePasswordModal');
    const form = document.getElementById('pagePasswordForm');
    const cancelBtn = document.getElementById('cancelPasswordBtn');
    const error = document.getElementById('passwordError');

    if (form) {
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const password = document.getElementById('accessPagePassword').value;
            
            if (!pendingLockedPageId) return;
            
            const page = await db.pages.get(pendingLockedPageId);
            if (page && page.password === password) {
                // Success!
                unlockedPages.add(pendingLockedPageId);
                modal.classList.remove('active');
                await switchToPage(pendingLockedPageId, { bypassLock: true });
                pendingLockedPageId = null;
            } else {
                // Fail
                error.classList.remove('hidden');
            }
        });
    }

    if (cancelBtn) {
        cancelBtn.addEventListener('click', () => {
            modal.classList.remove('active');
            pendingLockedPageId = null;
        });
    }

    setupModalClickOutside(modal, () => {
        modal.classList.remove('active');
        pendingLockedPageId = null;
    });
}

// Load security settings (populated dropdown and locked list)
async function loadSettingsSecurityOptions() {
    const select = document.getElementById('lockPageSelect');
    const list = document.getElementById('lockedPagesList');
    const section = document.getElementById('lockedPagesSection');
    
    if (!select || !list) return;
    
    const pages = await db.pages.filter(p => !p.deletedAt).toArray();
    pages.sort((a, b) => a.order - b.order);
    
    // Populate select dropdown (exclude already locked pages)
    select.innerHTML = '<option value="">Select a page...</option>';
    const lockedPages = [];
    
    pages.forEach(page => {
        if (!page.password) {
            const option = document.createElement('option');
            option.value = page.id;
            option.textContent = page.name;
            select.appendChild(option);
        } else {
            lockedPages.push(page);
        }
    });
    
    // Populate locked pages list
    list.innerHTML = '';
    if (lockedPages.length > 0) {
        section.style.display = 'block';
        lockedPages.forEach(page => {
            const item = document.createElement('div');
            item.className = 'locked-page-item';
            const safeName = LumiListModules.coreUtils.escapeHtml(page.name);
            item.innerHTML = `
                <span class="locked-page-name">${safeName}</span>
                <button class="btn btn-secondary btn-sm unlock-page-btn" data-page-id="${page.id}">
                    Unlock / Remove Password
                </button>
            `;
            list.appendChild(item);
        });
        
        // Add listeners for unlock buttons
        list.querySelectorAll('.unlock-page-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const pageId = btn.dataset.pageId;
                await removePagePassword(pageId);
            });
        });
    } else {
        section.style.display = 'none';
    }
}

// Lock a page with password
async function lockPage(pageId, password) {
    if (!pageId || !password) return;
    
    try {
        await db.pages.update(pageId, { password });
        unlockedPages.add(pageId); // Consider it unlocked for current session since user just set it
        showGlassToast('Page locked successfully.', 'success');
        await loadSettingsSecurityOptions();
    } catch (error) {
        console.error('Failed to lock page:', error);
        showGlassToast('Failed to lock page.', 'error');
    }
}

// Remove password from a page
async function removePagePassword(pageId) {
    try {
        await db.pages.update(pageId, { password: null });
        unlockedPages.delete(pageId);
        showGlassToast('Password removed from page.', 'success');
        await loadSettingsSecurityOptions();
    } catch (error) {
        console.error('Failed to remove password:', error);
        showGlassToast('Failed to remove password.', 'error');
    }
}

// Update active page tab styling
function updateActivePageTab() {
    // Update horizontal tabs
    document.querySelectorAll('.page-tab').forEach(tab => {
        tab.classList.remove('active');
        if (tab.dataset.pageId === currentPageId) {
            tab.classList.add('active');
        }
    });

    // Update Quick Access dropdown items
    document.querySelectorAll('.dropdown-item').forEach(item => {
        item.classList.remove('active');
        if (item.dataset.pageId === currentPageId) {
            item.classList.add('active');
        }
    });

    // Scroll the active tab into view
    const activeTab = document.querySelector('.page-tab.active');
    if (activeTab) {
        setTimeout(() => {
            activeTab.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
        }, 50);
    }
}

// Create new page
async function createNewPage(name, password = null) {
    // Block in read-only mode
    if (!canModify()) return;

    // Guard against multiple concurrent calls (user hitting Enter repeatedly)
    if (isCreatingPage) {
        console.warn('Page creation already in progress');
        return;
    }
    isCreatingPage = true;

    try {
        // Get next order value
        const lastPage = await db.pages.orderBy('order').reverse().first();
        const nextOrder = lastPage ? lastPage.order + 1 : 0;

        // Create page using addPage() wrapper (handles limit check, timestamps, sync)
        const pageId = await addPage({
            name: name.trim(),
            order: nextOrder,
            isDefault: false,
            password: password
        });

        // Check if addPage returned null (limit reached or subscription blocked)
        if (!pageId) {
            return; // addPage already showed the error toast
        }

        // Set the new page as current BEFORE refreshing navigation
        // This ensures the new tab is marked active when rendered and scrolled into view
        currentPageId = pageId;

        // Save to storage
        if (typeof chrome !== 'undefined' && chrome.storage) {
            chrome.storage.local.set({ currentPageId: pageId });
        } else {
            localStorage.setItem('current_page_id', pageId.toString());
        }

        // SAFETY: Clear stuck drag flag (edge case protection)
        // The _isTabDragInProgress flag can get stuck if user cancels drag with Escape,
        // or if an error occurs in SortableJS onEnd callback
        if (_isTabDragInProgress) {
            console.warn('createNewPage: Clearing stuck _isTabDragInProgress flag');
            _isTabDragInProgress = false;
            _renderTabsPendingAfterDrag = false;
        }

        // Refresh navigation (will scroll to the new active tab)
        await loadPagesNavigation();

        // Load boards for the new page (empty)
        await loadBoardsFromDatabase();

        broadcastDataChange('createNewPage');

        // Show placeholder after storage listener completes to avoid race conditions
        // The broadcastDataChange triggers storage listeners with 300ms delay that reload boards,
        // so we defer placeholder display to 400ms (> 300ms) to ensure it persists
        // Store timeout ID so it can be cancelled if boards are imported before timeout fires
        _showPlaceholderTimeoutId = setTimeout(() => {
            _showPlaceholderTimeoutId = null;
            if (!pageHasBoards) {
                showAddBoardPlaceholder(0);
            }
        }, 400);

        return pageId;

    } catch (error) {
        console.error('Failed to create page:', error);
        throw error;
    } finally {
        isCreatingPage = false;
    }
}

// Mutex flags to prevent duplicate board rendering during concurrent calls
let _loadBoardsInProgress = false;
let _loadBoardsPending = false;
// Flag to defer rendering while a board is being dragged
let _isBoardDragInProgress = false;
let _loadBoardsPendingAfterDrag = false;
// Flag to defer rendering while a bookmark is being dragged
let _isBookmarkDragInProgress = false;
let _loadBoardsPendingAfterBookmarkDrag = false;
// Flag to defer rendering while an inline input is active (add link/board)
let _isInlineInputActive = false;
let _loadBoardsPendingAfterInput = false;
let _inlineBoardOutsideDismissHandler = null;
// Flag to defer page tab rendering while a tab is being dragged
let _isTabDragInProgress = false;
let _renderTabsPendingAfterDrag = false;

function hasInlineInputInDom() {
    return !!document.querySelector('.inline-link-input, .inline-board-input');
}

function recoverStaleInlineInputState(context = 'unknown') {
    if (_isInlineInputActive && !hasInlineInputInDom()) {
        console.warn(`[InlineInput] Stale active flag recovered during ${context}`);
        _isInlineInputActive = false;
        _loadBoardsPendingAfterInput = false;
        if (_inlineBoardOutsideDismissHandler) {
            document.removeEventListener('pointerdown', _inlineBoardOutsideDismissHandler, true);
            _inlineBoardOutsideDismissHandler = null;
        }
        return true;
    }
    return false;
}

function dismissInlineInputs(reason = 'unknown') {
    const inlineInputs = document.querySelectorAll('.inline-link-input, .inline-board-input');
    if (inlineInputs.length === 0) {
        return recoverStaleInlineInputState(`dismiss:${reason}`);
    }

    inlineInputs.forEach(el => el.remove());
    currentBoardId = null;
    _isInlineInputActive = false;
    _loadBoardsPendingAfterInput = false;
    if (_inlineBoardOutsideDismissHandler) {
        document.removeEventListener('pointerdown', _inlineBoardOutsideDismissHandler, true);
        _inlineBoardOutsideDismissHandler = null;
    }
    console.info(`[InlineInput] Dismissed ${inlineInputs.length} inline input(s) due to ${reason}`);
    return true;
}

// Helper to complete inline input and process pending reload
async function completeInlineInput() {
    _isInlineInputActive = false;
    if (_inlineBoardOutsideDismissHandler && !document.querySelector('.inline-board-input')) {
        document.removeEventListener('pointerdown', _inlineBoardOutsideDismissHandler, true);
        _inlineBoardOutsideDismissHandler = null;
    }
    if (_loadBoardsPendingAfterInput) {
        _loadBoardsPendingAfterInput = false;
        await loadBoardsFromDatabase();
    }
}

/*
========================================
IDIOMORPH DOM MORPHING FUNCTIONS
========================================
Functions for generating HTML strings to be used with Idiomorph morphing.
This reduces visual flashing by updating only changed elements instead of rebuilding the entire DOM.
*/

// Generate HTML string for a single bookmark (used by Idiomorph morphing)
