/**
 * Check bookmark limit from IndexedDB
 * @returns {Promise<{ allowed: boolean, count: number, limit: number, remaining: number }>}
 */
const BACKGROUND_LOGIN_SYNC_STATE_STORAGE_KEY = 'lumilist_login_sync_state';
const CLOSE_TABS_AFTER_SAVE_ALL_STORAGE_KEY = 'closeTabsAfterSaveAllTabs';
const QUICK_SAVE_COMMAND_NAME = 'quick-save';
const SAVE_THIS_PAGE_CONTEXT_MENU_ID = 'saveThisPage';
const SAVE_PAGE_LINKS_CONTEXT_MENU_ID = 'savePageLinks';
const SAVE_THIS_LINK_CONTEXT_MENU_ID = 'saveThisLink';
const SAVE_THIS_LINK_CONTEXT_MENU_TITLE = 'Save This Link to LumiList';
const SAVE_ALL_LINKS_FROM_PAGE_CONTEXT_MENU_TITLE = 'Save All Links From This Page to LumiList';

function shouldCloseTabsAfterSaveAll(storageData) {
    return storageData?.[CLOSE_TABS_AFTER_SAVE_ALL_STORAGE_KEY] === true;
}

function buildBackgroundRefreshedSubscriptionSnapshot(existingStorageData, refreshedSubscriptionState) {
    const nextStorageData = {
        ...(existingStorageData && typeof existingStorageData === 'object' ? existingStorageData : {})
    };

    const refreshedStatus = refreshedSubscriptionState?.status || null;
    const refreshedDaysLeft = Number.isFinite(refreshedSubscriptionState?.daysLeft)
        ? refreshedSubscriptionState.daysLeft
        : 0;
    const refreshedSubscription = refreshedSubscriptionState?.subscription || null;

    nextStorageData.subscriptionStatus = refreshedStatus;
    nextStorageData.subscriptionDaysLeft = refreshedDaysLeft;
    nextStorageData.subscriptionData = refreshedSubscription;
    nextStorageData.subscriptionLastKnownState = isKnownSubscriptionStatus(refreshedStatus)
        ? {
            status: refreshedStatus,
            daysLeft: refreshedDaysLeft,
            subscription: refreshedSubscription,
            savedAt: new Date().toISOString()
        }
        : null;

    return nextStorageData;
}

async function resolveBackgroundSubscriptionWriteAccess(storageData = {}) {
    let nextStorageData = storageData && typeof storageData === 'object' ? { ...storageData } : {};
    let subscriptionStatus = resolveEffectiveSubscriptionStatus(nextStorageData);
    let subAccess = evaluateSubscriptionWriteAccess(subscriptionStatus);

    if (!subAccess.allowed && typeof refreshBackgroundSubscriptionStatus === 'function') {
        const refreshedState = await refreshBackgroundSubscriptionStatus(true);
        if (refreshedState) {
            nextStorageData = buildBackgroundRefreshedSubscriptionSnapshot(nextStorageData, refreshedState);
            subscriptionStatus = resolveEffectiveSubscriptionStatus(nextStorageData);
            subAccess = evaluateSubscriptionWriteAccess(subscriptionStatus);
        }
    }

    return {
        storageData: nextStorageData,
        subscriptionStatus,
        subAccess
    };
}

async function closeTabsAfterSaveAll(tabIds) {
    const normalizedTabIds = Array.from(new Set(
        Array.isArray(tabIds)
            ? tabIds.filter((tabId) => Number.isInteger(tabId) && tabId >= 0)
            : []
    ));

    if (normalizedTabIds.length === 0 || !chrome?.tabs?.remove) {
        return 0;
    }

    let closedCount = 0;
    for (const tabId of normalizedTabIds) {
        try {
            await chrome.tabs.remove(tabId);
            closedCount += 1;
        } catch (error) {
            console.warn('[SaveAllTabs] Failed to close tab after save:', tabId, error);
        }
    }

    return closedCount;
}

async function checkBookmarkLimitFromDB() {
    try {
        const count = await db.bookmarks.count();
        return {
            allowed: count < BOOKMARK_LIMIT,
            count,
            limit: BOOKMARK_LIMIT,
            remaining: BOOKMARK_LIMIT - count
        };
    } catch (error) {
        console.error('[Background] Failed to check bookmark limit:', error);
        // Allow operation on error (fail open) - server will enforce limit
        return { allowed: true, count: 0, limit: BOOKMARK_LIMIT, remaining: BOOKMARK_LIMIT };
    }
}

/**
 * Ensure database is ready before performing operations
 * Service workers can wake up and receive messages before DB is fully initialized
 */
async function ensureDbReady() {
    if (typeof db === 'undefined') {
        _dbReady = false;
        console.error('[Background] db is undefined');
        return false;
    }

    if (_dbReady && db.isOpen()) return true;

    if (!db.isOpen()) {
        _dbReady = false;
    }

    if (_dbInitPromise) {
        return _dbInitPromise;
    }

    _dbInitPromise = (async () => {
        try {
            if (!db.isOpen()) {
                await db.open();
            }

            _dbReady = db.isOpen();
            if (!_dbReady) {
                console.error('[Background] Database did not report an open state after open()');
            }
            return _dbReady;
        } catch (e) {
            _dbReady = false;
            console.error('[Background] Failed to open database:', e);
            return false;
        } finally {
            _dbInitPromise = null;
        }
    })();

    return _dbInitPromise;
}

// UUID generator for client-side ID creation (must match newtab.js)
function generateId() {
    return crypto.randomUUID();
}

// FIX [H11]: Escape HTML using pure string replacement (no DOM API)
// Service workers don't have document object, so DOM-based escaping is fragile
function escapeHtml(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// FIX [Phase 3]: Normalize URLs for duplicate detection
// Ensures example.com and example.com/ are treated as the same URL
function normalizeUrl(url) {
    if (!url) return '';
    try {
        const parsed = new URL(url);
        // Remove trailing slash from pathname (except for root /)
        let pathname = parsed.pathname;
        if (pathname.length > 1 && pathname.endsWith('/')) {
            pathname = pathname.slice(0, -1);
        }
        // Reconstruct URL with lowercase hostname, normalized pathname, and sorted search params
        let normalized = `${parsed.protocol}//${parsed.hostname.toLowerCase()}${pathname}`;
        // Preserve search params (sorted for consistency)
        if (parsed.search) {
            const params = new URLSearchParams(parsed.search);
            params.sort();
            normalized += '?' + params.toString();
        }
        // Preserve hash
        if (parsed.hash) {
            normalized += parsed.hash;
        }
        return normalized;
    } catch (e) {
        // If URL parsing fails, return as-is
        return url;
    }
}

function normalizeQuickSaveShortcutLabel(shortcut) {
    if (typeof shortcut !== 'string') return '';
    return shortcut.trim();
}

function buildSaveThisPageContextMenuTitle(shortcut = '') {
    const baseTitle = 'Save This Page to LumiList';
    const normalizedShortcut = normalizeQuickSaveShortcutLabel(shortcut);
    return normalizedShortcut ? `${baseTitle} (${normalizedShortcut})` : baseTitle;
}

async function resolveQuickSaveCommandShortcut() {
    if (!chrome?.commands || typeof chrome.commands.getAll !== 'function') {
        return '';
    }

    return new Promise((resolve) => {
        try {
            chrome.commands.getAll((commands) => {
                if (chrome.runtime?.lastError) {
                    console.warn('[ContextMenus] Failed to read quick-save shortcut:', chrome.runtime.lastError.message);
                    resolve('');
                    return;
                }

                const quickSaveCommand = Array.isArray(commands)
                    ? commands.find((command) => command?.name === QUICK_SAVE_COMMAND_NAME)
                    : null;
                resolve(normalizeQuickSaveShortcutLabel(quickSaveCommand?.shortcut));
            });
        } catch (error) {
            console.warn('[ContextMenus] Failed to resolve quick-save shortcut:', error);
            resolve('');
        }
    });
}

async function refreshContextMenus() {
    const quickSaveShortcut = await resolveQuickSaveCommandShortcut();

    chrome.contextMenus.removeAll(() => {
        if (chrome.runtime.lastError) {
            console.warn('[ContextMenus] Failed to clear existing items:', chrome.runtime.lastError.message);
        }

        chrome.contextMenus.create({
            id: SAVE_THIS_PAGE_CONTEXT_MENU_ID,
            title: buildSaveThisPageContextMenuTitle(quickSaveShortcut),
            contexts: ['page'],
            documentUrlPatterns: ['http://*/*', 'https://*/*']
        }, () => {
            if (chrome.runtime.lastError) {
                console.warn('[ContextMenus] Failed to create saveThisPage menu:', chrome.runtime.lastError.message);
            }
        });

        chrome.contextMenus.create({
            id: SAVE_PAGE_LINKS_CONTEXT_MENU_ID,
            title: SAVE_ALL_LINKS_FROM_PAGE_CONTEXT_MENU_TITLE,
            contexts: ['page'],
            documentUrlPatterns: ['http://*/*', 'https://*/*']
        }, () => {
            if (chrome.runtime.lastError) {
                console.warn('[ContextMenus] Failed to create savePageLinks menu:', chrome.runtime.lastError.message);
            }
        });

        chrome.contextMenus.create({
            id: SAVE_THIS_LINK_CONTEXT_MENU_ID,
            title: SAVE_THIS_LINK_CONTEXT_MENU_TITLE,
            contexts: ['link'],
            documentUrlPatterns: ['http://*/*', 'https://*/*']
        }, () => {
            if (chrome.runtime.lastError) {
                console.warn('[ContextMenus] Failed to create saveThisLink menu:', chrome.runtime.lastError.message);
            }
        });
    });
}

chrome.runtime.onInstalled.addListener((details) => {
    ensureReviewPromptInstallTimestamp().catch(error =>
        console.warn('[ReviewPrompt] Failed to initialize install timestamp on install/update:', error)
    );

    // Refresh menus so extension updates/reloads do not fail on duplicate IDs.
    void refreshContextMenus();

    // Open LumiList new tab page on first install
    if (details && details.reason === 'install') {
        chrome.tabs.create({ url: chrome.runtime.getURL('newtab.html') });
    }
    
});

// Also create alarm on startup (in case extension was updated but not reinstalled)
chrome.runtime.onStartup.addListener(() => {
    ensureReviewPromptInstallTimestamp().catch(error =>
        console.warn('[ReviewPrompt] Failed to initialize install timestamp on startup:', error)
    );

    void refreshContextMenus();
});

// Keep review prompt install metadata present even if extension predates this feature.
(async function ensureReviewPromptInstallMetadata() {
    try {
        await ensureReviewPromptInstallTimestamp();
    } catch (error) {
        console.warn('[ReviewPrompt] Failed to ensure install metadata on wake:', error);
    }
})();

// Refresh menus on service-worker wake so titles can follow the currently assigned shortcut.
void refreshContextMenus();

// ========================================
// CONTEXT MENU HANDLERS
// ========================================

/**
 * Extract all links from a page by injecting a content script
 * @returns {Array<{url: string, title: string, heading: string|null}>}
 */
function extractPageLinks() {
    // Only extract from body, not head
    const body = document.body;
    if (!body) return [];

    // Keep helper logic inside injected function to avoid context/closure issues.
    function normalizePapalyText(value) {
        if (typeof value !== 'string') return '';
        return value.replace(/\s+/g, ' ').trim();
    }

    function isPapalyTextTruncated(value) {
        return /(\.\.\.|\u2026)$/.test(value);
    }

    function decodeHtmlEntities(value) {
        if (typeof value !== 'string' || !value) return '';
        const textarea = document.createElement('textarea');
        textarea.innerHTML = value;
        return textarea.value;
    }

    function extractPapalyTooltipTitle(value) {
        if (typeof value !== 'string' || !value) return '';

        const boldMatch = value.match(/<b[^>]*>([\s\S]*?)<\/b>/i);
        const preferred = boldMatch ? boldMatch[1] : value.split(/<br\s*\/?>/i)[0];
        const withoutTags = preferred.replace(/<[^>]*>/g, ' ');
        return normalizePapalyText(decodeHtmlEntities(withoutTags));
    }

    function resolvePapalyLinkTitle(linkEl, itemEl, fallbackUrl) {
        const itemNameEl = linkEl?.querySelector('.item-name') || itemEl?.querySelector('.item-name');
        const tooltipTitle =
            extractPapalyTooltipTitle(itemNameEl?.getAttribute('tooltip')) ||
            extractPapalyTooltipTitle(linkEl?.getAttribute('tooltip')) ||
            extractPapalyTooltipTitle(itemEl?.getAttribute('tooltip'));

        const candidates = [
            itemNameEl?.getAttribute('title'),
            itemNameEl?.getAttribute('aria-label'),
            linkEl?.getAttribute('title'),
            linkEl?.getAttribute('aria-label'),
            itemEl?.getAttribute('title'),
            itemEl?.getAttribute('aria-label'),
            itemEl?.getAttribute('data-title'),
            itemEl?.getAttribute('data-name'),
            tooltipTitle,
            itemNameEl?.textContent,
            linkEl?.textContent,
            itemEl?.textContent
        ].map(normalizePapalyText).filter(Boolean);

        if (candidates.length === 0) return fallbackUrl;

        const primary = candidates[0];
        if (!isPapalyTextTruncated(primary)) return primary;

        const primaryBase = primary.replace(/(\.\.\.|\u2026)+$/, '').trim().toLowerCase();
        const better = candidates.find(candidate => {
            if (!candidate || isPapalyTextTruncated(candidate)) return false;
            const normalized = candidate.toLowerCase();
            if (primaryBase && normalized.startsWith(primaryBase) && candidate.length > primary.length) {
                return true;
            }
            return candidate.length >= primary.length + 5;
        });

        return better || primary;
    }

    // Papaly-specific extraction: group links by category + preserve column placement
    const boards = body.querySelectorAll('.board');
    let activeBoard = null;
    if (boards && boards.length > 0) {
        activeBoard = Array.from(boards).find(board => board.style && board.style.display === 'block') || boards[boards.length - 1];
    }

    const papalyContainers = activeBoard
        ? activeBoard.querySelectorAll('.cards-container.theme-card')
        : body.querySelectorAll('.cards-container.theme-card');
    const papalyRoot = papalyContainers.length > 0 ? papalyContainers[papalyContainers.length - 1] : null;
    const papalySlots = papalyRoot ? papalyRoot.querySelectorAll('.category-slot') : null;

    if (papalySlots && papalySlots.length > 0) {
        const papalyGroups = [];
        const seenPapalyLinks = new Map();

        papalySlots.forEach(slot => {
            const classMatch = Array.from(slot.classList || []).find(cls => cls.startsWith('slot-'));
            const slotIndex = classMatch ? parseInt(classMatch.replace('slot-', ''), 10) : 0;

            const cards = slot.querySelectorAll('.card[category-index], .card[childcategory-index], .card[child-category-index]');
            let cardIndex = 0;

            cards.forEach(card => {
                const titleEl = card.querySelector('.card-title');
                const rawName = (titleEl?.textContent ||
                    card.getAttribute('category-name') ||
                    card.getAttribute('childcategory-name') ||
                    card.getAttribute('child-category-name') ||
                    '').trim();
                const name = rawName || `Papaly Category ${cardIndex + 1}`;

                const orderKey = cardIndex;

                const items = Array.from(card.querySelectorAll('ol.item-container li.item-bookmark'));
                const links = [];

                items.forEach((item, idx) => {
                    const linkEl = item.querySelector('a[href]');
                    const href = linkEl?.getAttribute('href') || item.getAttribute('url');
                    if (!href) return;

                    let fullUrl;
                    try { fullUrl = new URL(href, window.location.href).href; } catch { return; }

                    if (!fullUrl.startsWith('http')) return;
                    if (fullUrl.includes('#') && fullUrl.split('#')[0] === window.location.href.split('#')[0]) return;

                    const noteText = normalizePapalyText(item.querySelector('.item-bookmark-note')?.textContent || '');
                    const normalized = fullUrl.toLowerCase().replace(/\/$/, '');
                    if (seenPapalyLinks.has(normalized)) {
                        const existingLink = seenPapalyLinks.get(normalized);
                        if (existingLink && !existingLink.context && noteText) {
                            existingLink.context = noteText;
                        }
                        return;
                    }

                    const titleText = resolvePapalyLinkTitle(linkEl, item, fullUrl);

                    const rawItemPosition = parseFloat(item.getAttribute('item-position'));
                    const itemOrder = Number.isFinite(rawItemPosition) ? rawItemPosition : idx;

                    const linkData = {
                        url: fullUrl,
                        title: (titleText || fullUrl).substring(0, 500),
                        context: noteText,
                        _order: itemOrder
                    };
                    links.push(linkData);
                    seenPapalyLinks.set(normalized, linkData);
                });

                if (links.length > 0) {
                    links.sort((a, b) => (a._order || 0) - (b._order || 0));
                    links.forEach(link => { delete link._order; });
                    papalyGroups.push({ name, links, columnIndex: slotIndex, orderKey });
                }

                cardIndex++;
            });
        });

        if (papalyGroups.length > 0) {
            papalyGroups.sort((a, b) => {
                const colA = Number.isFinite(a.columnIndex) ? a.columnIndex : 0;
                const colB = Number.isFinite(b.columnIndex) ? b.columnIndex : 0;
                if (colA !== colB) return colA - colB;
                const ordA = Number.isFinite(a.orderKey) ? a.orderKey : 0;
                const ordB = Number.isFinite(b.orderKey) ? b.orderKey : 0;
                return ordA - ordB;
            });
            return { groups: papalyGroups, source: 'papaly' };
        }
    }

    const links = body.querySelectorAll('a[href]');
    const results = [];
    const seenUrls = new Set();

    function findNearestHeading(el) {
        while (el && el.tagName !== 'BODY') {
            let sibling = el.previousElementSibling;
            while (sibling) {
                if (/^H[1-6]$/.test(sibling.tagName)) {
                    return sibling.textContent.trim().substring(0, 50);
                }
                sibling = sibling.previousElementSibling;
            }
            el = el.parentElement;
        }
        return null;
    }

    // Check if link is inside a navigation area
    function isNavigationLink(el) {
        return el.closest('header, nav, [role="navigation"], [role="banner"], .navbar, .nav, .header, .navigation, .menu, .top-bar, .site-header');
    }

    // Container tracking for proximity grouping
    let currentContainerId = 0;
    let lastContainerKey = null;

    // Get a "container key" - identifies the significant container for grouping
    // Walks up 3 levels to find a significant parent element
    function getContainerKey(el) {
        let container = el.parentElement;
        for (let i = 0; i < 2 && container && container !== body; i++) {
            container = container.parentElement;
        }
        return container ? container : body;
    }

    links.forEach(link => {
        const href = link.getAttribute('href');
        if (!href) return;

        // Skip links in header/navigation areas
        if (isNavigationLink(link)) return;

        let fullUrl;
        try { fullUrl = new URL(href, window.location.href).href; } catch { return; }

        if (!fullUrl.startsWith('http')) return;
        if (fullUrl.includes('#') && fullUrl.split('#')[0] === window.location.href.split('#')[0]) return;

        const normalized = fullUrl.toLowerCase().replace(/\/$/, '');
        if (seenUrls.has(normalized)) return;
        seenUrls.add(normalized);

        // Determine container for proximity grouping
        const containerKey = getContainerKey(link);
        if (containerKey !== lastContainerKey) {
            currentContainerId++;
            lastContainerKey = containerKey;
        }

        results.push({
            url: fullUrl,
            // Clean up whitespace: trim + collapse internal whitespace/newlines to single space
            title: ((link.textContent || '').trim().replace(/\s+/g, ' ') || link.title || fullUrl).substring(0, 500),
            heading: findNearestHeading(link),
            containerId: currentContainerId
        });
    });

    return results;
}

/**
 * Quick save a specific link to the "Quick Saved" board
 * Similar to quickSaveCurrentTab but for a specific URL/title pair
 */
async function quickSaveLink(url, title) {
    

    // Mutex check
    if (_isQuickSaving) {
        
        return { success: false, message: 'Save already in progress' };
    }
    _isQuickSaving = true;

    try {
        const dbReady = await ensureDbReady();
        if (!dbReady) {
            return { success: false, message: 'Database not ready. Please try again.' };
        }

        // Check login and subscription
        const storageData = await chrome.storage.local.get([
            'lumilist_user',
            'subscriptionStatus',
            'subscriptionData',
            'subscriptionLastKnownState',
            BACKGROUND_LOGIN_SYNC_STATE_STORAGE_KEY,
            CLOSE_TABS_AFTER_SAVE_ALL_STORAGE_KEY,
            'quickSavePageId',
            'currentPageId'
        ]);

        if (!storageData.lumilist_user) {
            return { success: false, message: 'Please login to save bookmarks', requiresLogin: true };
        }

        const subscriptionAccess = await resolveBackgroundSubscriptionWriteAccess(storageData);
        const effectiveSubscriptionStatus = subscriptionAccess.subscriptionStatus;
        const subAccess = subscriptionAccess.subAccess;
        if (!subAccess.allowed) {
            return {
                success: false,
                message: subAccess.message,
                requiresSubscription: !!subAccess.requiresSubscription,
                requiresStatusRefresh: !!subAccess.requiresStatusRefresh
            };
        }
        Object.assign(storageData, subscriptionAccess.storageData);

        const saveGuard = getBackgroundSaveGuardResult(storageData);
        if (!saveGuard.allowed) {
            return { success: false, message: saveGuard.message, loginSyncPending: true };
        }

        // Check bookmark limit
        const limitCheck = await checkBookmarkLimitFromDB();
        if (!limitCheck.allowed) {
            return { success: false, message: `Bookmark limit reached (${limitCheck.count.toLocaleString()}/${limitCheck.limit.toLocaleString()}). Delete some bookmarks to add more.` };
        }

        // Validate URL
        if (!url || !url.startsWith('http')) {
            return { success: false, message: 'Invalid URL' };
        }

        const { pageId, pageName } = await resolveQuickSaveTargetPage(storageData);
        if (!pageId) {
            return { success: false, message: 'No pages found. Open LumiList first.' };
        }

        // Use transaction to find/create top-left board and save bookmark
        const saveResult = await db.transaction('rw', [db.pages, db.boards, db.bookmarks], async () => {
            const targetPage = await db.pages.get(pageId);
            if (!targetPage || targetPage.deletedAt) {
                return { missingPage: true };
            }

            const {
                quickBoardId,
                boardIsNew,
                shiftedBoardIds,
                shiftedBoardsBefore
            } = await ensureQuickSavedBoardAtTopLeft(pageId);

            // Check for duplicate URL
            const allBookmarks = await db.bookmarks.where('boardId').equals(quickBoardId).toArray();
            const normalizedUrl = normalizeUrl(url);
            const existingBookmark = allBookmarks.filter(b => !b.deletedAt).find(b => normalizeUrl(b.url) === normalizedUrl);

            if (existingBookmark) {
                return { alreadySaved: true };
            }

            // Increment order of existing bookmarks
            const activeBookmarks = allBookmarks.filter(b => !b.deletedAt);
            const updatedBookmarksBeforeRows = activeBookmarks.map(bookmark => cloneBackgroundHistorySnapshot(bookmark));
            const nowIso = new Date().toISOString();
            const updatePromises = activeBookmarks.map(bookmark =>
                db.bookmarks.update(bookmark.id, { order: (bookmark.order || 0) + 1, updatedAt: nowIso })
            );
            await Promise.all(updatePromises);

            // Add new bookmark at the top
            const newBookmarkId = generateId();
            await db.bookmarks.add({
                id: newBookmarkId,
                boardId: quickBoardId,
                title: title || 'Untitled',
                url: url,
                description: null,
                order: 0,
                createdAt: new Date(),
                updatedAt: nowIso
            });

            return {
                alreadySaved: false,
                newBookmarkId: newBookmarkId,
                updatedBookmarkIds: activeBookmarks.map(b => b.id),
                quickBoardId: quickBoardId,
                boardIsNew: boardIsNew,
                shiftedBoardIds: shiftedBoardIds,
                shiftedBoardsBefore: shiftedBoardsBefore || [],
                updatedBookmarksBeforeRows
            };
        });

        if (saveResult.missingPage) {
            return {
                success: false,
                message: 'The selected page is no longer available. Open LumiList and choose a page again.'
            };
        }

        if (saveResult.alreadySaved) {
            await showBadge('info');
            return { success: true, message: 'Already saved!', pageName: pageName };
        }

        let syncQueueResult = { success: true };
        // Queue sync operations
        if (typeof BackgroundSync !== 'undefined') {
            try {
                const syncOperations = [];

                const newBookmark = await db.bookmarks.get(saveResult.newBookmarkId);
                if (newBookmark) {
                    syncOperations.push({
                        operation: 'upsert',
                        tableName: 'bookmarks',
                        recordId: newBookmark.id,
                        data: newBookmark
                    });
                }

                for (const bookmarkId of saveResult.updatedBookmarkIds) {
                    const bookmark = await db.bookmarks.get(bookmarkId);
                    if (bookmark) {
                        syncOperations.push({
                            operation: 'upsert',
                            tableName: 'bookmarks',
                            recordId: bookmark.id,
                            data: bookmark
                        });
                    }
                }

                if (saveResult.boardIsNew) {
                    const board = await db.boards.get(saveResult.quickBoardId);
                    if (board) {
                        syncOperations.push({
                            operation: 'upsert',
                            tableName: 'boards',
                            recordId: board.id,
                            data: board
                        });
                    }
                }

                if (saveResult.shiftedBoardIds?.length) {
                    for (const boardId of saveResult.shiftedBoardIds) {
                        const board = await db.boards.get(boardId);
                        if (board) {
                            syncOperations.push({
                                operation: 'upsert',
                                tableName: 'boards',
                                recordId: board.id,
                                data: board
                            });
                        }
                    }
                }

                syncQueueResult = await queueBackgroundSyncOpsWithRetry(syncOperations, 'QuickSaveLink');
                if (syncQueueResult.success) {
                    BackgroundSync.forcePush().catch(err =>
                        console.error('[ContextMenu] Background sync failed:', err)
                    );
                } else {
                    console.warn('[ContextMenu] Queueing sync ops failed after retry:', syncQueueResult.error);
                }
            } catch (syncError) {
                syncQueueResult = { success: false, error: syncError };
                console.error('[ContextMenu] Failed to queue sync:', syncError);
            }
        } else {
            syncQueueResult = { success: false, error: new Error('BackgroundSync not available') };
        }

        if (!syncQueueResult.success) {
            try {
                await rollbackBackgroundMutationChanges({
                    createdBoardId: saveResult.boardIsNew ? saveResult.quickBoardId : null,
                    createdBookmarkIds: [saveResult.newBookmarkId],
                    restoredBoardsBefore: saveResult.shiftedBoardsBefore || [],
                    restoredBookmarksBefore: saveResult.updatedBookmarksBeforeRows || []
                });
            } catch (rollbackError) {
                console.error('[ContextMenu] Failed to roll back quick-save mutation after queue failure:', rollbackError);
            }
            await showBadge('error');
            return { success: false, message: 'Failed to save right now. Please try again.' };
        }

        await showBadge('success');

        const historyOps = [];
        if (saveResult.boardIsNew) {
            const createdBoard = await db.boards.get(saveResult.quickBoardId);
            if (createdBoard) {
                historyOps.push({
                    table: 'boards',
                    id: createdBoard.id,
                    before: null,
                    after: createdBoard
                });
            }
        }

        if (saveResult.shiftedBoardIds?.length) {
            const shiftedBoardAfterRows = (await db.boards.bulkGet(saveResult.shiftedBoardIds)).filter(Boolean);
            const shiftedBoardAfterById = new Map(shiftedBoardAfterRows.map(board => [board.id, board]));
            for (const beforeBoard of saveResult.shiftedBoardsBefore || []) {
                if (!beforeBoard?.id) continue;
                historyOps.push({
                    table: 'boards',
                    id: beforeBoard.id,
                    before: beforeBoard,
                    after: shiftedBoardAfterById.get(beforeBoard.id) || null
                });
            }
        }

        if (saveResult.updatedBookmarkIds?.length) {
            const updatedBookmarkAfterRows = (await db.bookmarks.bulkGet(saveResult.updatedBookmarkIds)).filter(Boolean);
            const updatedBookmarkBeforeById = new Map(
                (saveResult.updatedBookmarksBeforeRows || [])
                    .filter(bookmark => !!bookmark?.id)
                    .map(bookmark => [bookmark.id, bookmark])
            );
            updatedBookmarkAfterRows.forEach((bookmark) => {
                historyOps.push({
                    table: 'bookmarks',
                    id: bookmark.id,
                    before: updatedBookmarkBeforeById.get(bookmark.id) || null,
                    after: bookmark
                });
            });
        }

        const createdBookmark = await db.bookmarks.get(saveResult.newBookmarkId);
        if (createdBookmark) {
            historyOps.push({
                table: 'bookmarks',
                id: createdBookmark.id,
                before: null,
                after: createdBookmark
            });
        }

        if (historyOps.length > 0) {
            await recordBackgroundHistoryEntry({
                kind: 'bookmark_quick_save_link',
                label: `Quick save link "${(title || createdBookmark?.title || 'Untitled').toString().slice(0, 80)}"`,
                ops: historyOps
            });
        }

        try {
            await trackReviewPromptManualBookmarks(storageData.lumilist_user?.id, 1);
        } catch (reviewTrackError) {
            console.warn('[ReviewPrompt] Failed to track quick-save link bookmark count:', reviewTrackError);
        }

        refreshLumiListTabs().catch(err =>
            console.error('[ContextMenu] Failed to refresh tabs:', err)
        );

        return { success: true, message: `Saved to "${pageName}"!`, pageName: pageName };

    } catch (error) {
        console.error('[ContextMenu] Quick save link error:', error);
        await showBadge('error');
        return { success: false, message: 'Failed to save: ' + error.message };
    } finally {
        _isQuickSaving = false;
    }
}

// Context menu click handler
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    

    // Check login status
    const storageData = await chrome.storage.local.get(['lumilist_user', 'subscriptionStatus', 'subscriptionData', 'subscriptionLastKnownState']);
    const { lumilist_user } = storageData;

    if (!lumilist_user) {
        
        if (tab && tab.id) {
            showSaveNotification({ success: false, message: 'Please login to save', requiresLogin: true }, tab.id, tab.url);
        }
        return;
    }

    // Check subscription status
    const subscriptionAccess = await resolveBackgroundSubscriptionWriteAccess(storageData);
    const subAccess = subscriptionAccess.subAccess;
    if (!subAccess.allowed) {
        
        if (tab && tab.id) {
            showSaveNotification({
                success: false,
                message: subAccess.message,
                requiresSubscription: !!subAccess.requiresSubscription,
                requiresStatusRefresh: !!subAccess.requiresStatusRefresh
            }, tab.id, tab.url);
        }
        return;
    }
    Object.assign(storageData, subscriptionAccess.storageData);

    if (info.menuItemId === SAVE_THIS_LINK_CONTEXT_MENU_ID) {
        // Quick save the specific link
        const linkUrl = info.linkUrl;
        // Try to get link text (not available in context menu API, use URL as fallback title)
        let linkTitle = linkUrl;
        try {
            const urlObj = new URL(linkUrl);
            linkTitle = urlObj.hostname + urlObj.pathname;
        } catch (e) {
            // Keep original
        }

        const result = await quickSaveLink(linkUrl, linkTitle);
        if (tab && tab.id) {
            showSaveNotification(result, tab.id, tab.url);
        }

    } else if (info.menuItemId === SAVE_THIS_PAGE_CONTEXT_MENU_ID) {
        const result = await quickSaveTab(tab);
        if (tab && tab.id) {
            showSaveNotification(result, tab.id, tab.url);
        }

    } else if (info.menuItemId === SAVE_PAGE_LINKS_CONTEXT_MENU_ID) {
        // Extract all links from page and open newtab with import modal
        try {
            const parseExtractionResults = (injectionResults) => {
                let bestGrouped = null;
                const flatLinks = [];
                const flatIndexByKey = new Map();

                const getContextScore = (link) => {
                    const context = (typeof link?.context === 'string') ? link.context.trim() : '';
                    return context.length;
                };

                const isTruncatedText = (value) => /(\.\.\.|\u2026)$/.test(value || '');

                const getTitleQualityScore = (link) => {
                    const title = typeof link?.title === 'string' ? link.title.trim() : '';
                    if (!title) return 0;
                    const truncatedPenalty = isTruncatedText(title) ? 40 : 0;
                    return Math.min(title.length, 500) - truncatedPenalty;
                };

                const looksLikeUrlText = (title, url) => {
                    if (!title || !url) return false;
                    const safeTitle = title.trim().toLowerCase();
                    if (!safeTitle) return false;
                    try {
                        const normalizedUrl = normalizeUrl(url).toLowerCase().replace(/\/$/, '');
                        return safeTitle === normalizedUrl || safeTitle === url.trim().toLowerCase();
                    } catch (e) {
                        return safeTitle === url.trim().toLowerCase();
                    }
                };

                const shouldPreferIncomingTitle = (existingLink, incomingLink) => {
                    const existingTitle = typeof existingLink?.title === 'string' ? existingLink.title.trim() : '';
                    const incomingTitle = typeof incomingLink?.title === 'string' ? incomingLink.title.trim() : '';
                    const url = incomingLink?.url || existingLink?.url || '';

                    if (!incomingTitle) return false;
                    if (!existingTitle) return true;

                    const existingTruncated = isTruncatedText(existingTitle);
                    const incomingTruncated = isTruncatedText(incomingTitle);
                    if (existingTruncated && !incomingTruncated) return true;
                    if (!existingTruncated && incomingTruncated) return false;

                    const existingLooksLikeUrl = looksLikeUrlText(existingTitle, url);
                    const incomingLooksLikeUrl = looksLikeUrlText(incomingTitle, url);
                    if (existingLooksLikeUrl && !incomingLooksLikeUrl) return true;
                    if (!existingLooksLikeUrl && incomingLooksLikeUrl) return false;

                    return incomingTitle.length > existingTitle.length + 5;
                };

                const addDedupedLink = (link) => {
                    if (!link || !link.url) return;
                    const key = normalizeUrl(link.url).toLowerCase().replace(/\/$/, '');
                    const existingIndex = flatIndexByKey.get(key);

                    if (existingIndex === undefined) {
                        flatIndexByKey.set(key, flatLinks.length);
                        flatLinks.push(link);
                        return;
                    }

                    const existingLink = flatLinks[existingIndex];
                    const existingContextScore = getContextScore(existingLink);
                    const incomingContextScore = getContextScore(link);
                    const preferIncomingContext = incomingContextScore > existingContextScore;
                    const preferIncomingTitle = shouldPreferIncomingTitle(existingLink, link);

                    if (!preferIncomingContext && !preferIncomingTitle) return;

                    const mergedLink = { ...existingLink };
                    if (preferIncomingContext) {
                        mergedLink.context = link.context;
                    }
                    if (preferIncomingTitle) {
                        mergedLink.title = link.title;
                    }

                    // Preserve useful metadata if previously missing.
                    if (!mergedLink.heading && link.heading) mergedLink.heading = link.heading;
                    if ((mergedLink.containerId === undefined || mergedLink.containerId === null) &&
                        (link.containerId !== undefined && link.containerId !== null)) {
                        mergedLink.containerId = link.containerId;
                    }

                    flatLinks[existingIndex] = mergedLink;
                };

                (injectionResults || []).forEach(entry => {
                    const frameResult = entry?.result;
                    if (!frameResult) return;

                    const hasGroups = !Array.isArray(frameResult) && Array.isArray(frameResult.groups);
                    const frameLinks = hasGroups
                        ? (frameResult.links || frameResult.groups.flatMap(group => group.links || []))
                        : (Array.isArray(frameResult) ? frameResult : []);

                    frameLinks.forEach(addDedupedLink);

                    if (hasGroups && frameLinks.length > 0) {
                        const noteCount = frameLinks.reduce((count, link) => (
                            count + (getContextScore(link) > 0 ? 1 : 0)
                        ), 0);
                        const titleQualityScore = frameLinks.reduce((sum, link) => (
                            sum + getTitleQualityScore(link)
                        ), 0);

                        const shouldReplace = !bestGrouped
                            || frameLinks.length > bestGrouped.links.length
                            || (frameLinks.length === bestGrouped.links.length && noteCount > bestGrouped.noteCount)
                            || (frameLinks.length === bestGrouped.links.length &&
                                noteCount === bestGrouped.noteCount &&
                                titleQualityScore > (bestGrouped.titleQualityScore || 0));

                        if (shouldReplace) {
                            bestGrouped = {
                                groups: frameResult.groups,
                                source: frameResult.source,
                                links: frameLinks,
                                noteCount,
                                titleQualityScore
                            };
                        }
                    }
                });

                if (bestGrouped) {
                    // If grouped extraction misses links found in other frames,
                    // prefer complete flat extraction over partial grouping.
                    if (bestGrouped.links.length < flatLinks.length) {
                        return {
                            hasGroups: false,
                            groups: undefined,
                            source: undefined,
                            links: flatLinks
                        };
                    }
                    return {
                        hasGroups: true,
                        groups: bestGrouped.groups,
                        source: bestGrouped.source,
                        links: bestGrouped.links
                    };
                }

                return {
                    hasGroups: false,
                    groups: undefined,
                    source: undefined,
                    links: flatLinks
                };
            };

            const targetForClickedFrame = (typeof info.frameId === 'number')
                ? { tabId: tab.id, frameIds: [info.frameId] }
                : { tabId: tab.id };

            let executionResults = await chrome.scripting.executeScript({
                target: targetForClickedFrame,
                func: extractPageLinks
            });

            let { hasGroups, groups, source, links } = parseExtractionResults(executionResults);

            // Some pages (including web apps) render content in subframes.
            // If clicked-frame extraction is empty, retry across all frames.
            if (links.length === 0) {
                executionResults = await chrome.scripting.executeScript({
                    target: { tabId: tab.id, allFrames: true },
                    func: extractPageLinks
                });
                ({ hasGroups, groups, source, links } = parseExtractionResults(executionResults));
            }

            if (links.length === 0) {
                if (tab && tab.id) {
                    showSaveNotification({ success: false, message: 'No links found on this page' }, tab.id, tab.url);
                }
                return;
            }

            // Store links temporarily for newtab to pick up
            await chrome.storage.local.set({
                contextMenuImportData: {
                    links: links,
                    groups: hasGroups ? groups : undefined,
                    source: hasGroups ? source : undefined,
                    sourceUrl: tab.url,
                    sourceTitle: tab.title,
                    timestamp: Date.now()
                }
            });

            // Open newtab with import flag
            await chrome.tabs.create({
                url: chrome.runtime.getURL('newtab.html?contextMenuImport=true')
            });

        } catch (error) {
            console.error('[ContextMenu] Failed to extract links:', error);
            if (tab && tab.id) {
                showSaveNotification({ success: false, message: 'Failed to extract links from this page' }, tab.id, tab.url);
            }
        }
    }
});

// Database setup (same schema as newtab.js)
let db;
try {
    db = new Dexie('BookmarkManager');
    const UNDO_REDO_HISTORY_STATE_ID = 'main';
    const UNDO_REDO_HISTORY_MAX_DEPTH_DEFAULT = 200;
    // Version 21: Add tags, isPinned, and folder fields for bookmarks - MUST match newtab.js
    db.version(21).stores({
        pages: 'id, name, order, createdAt, isDefault, deletedAt, updatedAt, shareId',
        boards: 'id, pageId, name, columnIndex, order, createdAt, [pageId+columnIndex+order], deletedAt, updatedAt, shareId',
        bookmarks: 'id, boardId, title, url, description, order, createdAt, deletedAt, updatedAt, visitCount, lastVisited, tags, isPinned, folder',
        favicons: 'id, data, url, timestamp',
        syncQueue: '++id, operation, tableName, recordId, timestamp, status, retryCount',
        historyEntries: 'id, seq, createdAt, kind, label, origin, groupId',
        historyState: 'id, cursorSeq, headSeq, maxDepth',
        installedWallpapers: '&id, theme, remoteId, updatedAt, installedAt, archivedAt'
    });

    // Version 20: Add visit tracking fields for bookmarks - MUST match newtab.js
    db.version(20).stores({
        pages: 'id, name, order, createdAt, isDefault, deletedAt, updatedAt, shareId',
        boards: 'id, pageId, name, columnIndex, order, createdAt, [pageId+columnIndex+order], deletedAt, updatedAt, shareId',
        bookmarks: 'id, boardId, title, url, description, order, createdAt, deletedAt, updatedAt, visitCount, lastVisited',
        favicons: 'id, data, url, timestamp',
        syncQueue: '++id, operation, tableName, recordId, timestamp, status, retryCount',
        historyEntries: 'id, seq, createdAt, kind, label, origin, groupId',
        historyState: 'id, cursorSeq, headSeq, maxDepth',
        installedWallpapers: '&id, theme, remoteId, updatedAt, installedAt, archivedAt'
    });
    // Version 19: Add archive metadata for locally installed wallpaper assets - MUST match newtab.js
    db.version(19).stores({
        pages: 'id, name, order, createdAt, isDefault, deletedAt, updatedAt, shareId',
        boards: 'id, pageId, name, columnIndex, order, createdAt, [pageId+columnIndex+order], deletedAt, updatedAt, shareId',
        bookmarks: 'id, boardId, title, url, description, order, createdAt, deletedAt, updatedAt',
        favicons: 'id, data, url, timestamp',
        syncQueue: '++id, operation, tableName, recordId, timestamp, status, retryCount',
        historyEntries: 'id, seq, createdAt, kind, label, origin, groupId',
        historyState: 'id, cursorSeq, headSeq, maxDepth',
        installedWallpapers: '&id, theme, remoteId, updatedAt, installedAt, archivedAt'
    }).upgrade(async tx => {
        const historyStateTable = tx.table('historyState');
        const existing = await historyStateTable.get(UNDO_REDO_HISTORY_STATE_ID);
        if (!existing) {
            await historyStateTable.put({
                id: UNDO_REDO_HISTORY_STATE_ID,
                cursorSeq: 0,
                headSeq: 0,
                maxDepth: UNDO_REDO_HISTORY_MAX_DEPTH_DEFAULT
            });
        }
    });
    // Version 18: Add locally installed wallpaper asset storage - MUST match newtab.js
    db.version(18).stores({
        pages: 'id, name, order, createdAt, isDefault, deletedAt, updatedAt, shareId',
        boards: 'id, pageId, name, columnIndex, order, createdAt, [pageId+columnIndex+order], deletedAt, updatedAt, shareId',
        bookmarks: 'id, boardId, title, url, description, order, createdAt, deletedAt, updatedAt',
        favicons: 'id, data, url, timestamp',
        syncQueue: '++id, operation, tableName, recordId, timestamp, status, retryCount',
        historyEntries: 'id, seq, createdAt, kind, label, origin, groupId',
        historyState: 'id, cursorSeq, headSeq, maxDepth',
        installedWallpapers: '&id, theme, remoteId, updatedAt, installedAt'
    }).upgrade(async tx => {
        const historyStateTable = tx.table('historyState');
        const existing = await historyStateTable.get(UNDO_REDO_HISTORY_STATE_ID);
        if (!existing) {
            await historyStateTable.put({
                id: UNDO_REDO_HISTORY_STATE_ID,
                cursorSeq: 0,
                headSeq: 0,
                maxDepth: UNDO_REDO_HISTORY_MAX_DEPTH_DEFAULT
            });
        }
    });
    // Version 17: Add undo/redo history tables - MUST match newtab.js
    db.version(17).stores({
        pages: 'id, name, order, createdAt, isDefault, deletedAt, updatedAt, shareId',
        boards: 'id, pageId, name, columnIndex, order, createdAt, [pageId+columnIndex+order], deletedAt, updatedAt, shareId',
        bookmarks: 'id, boardId, title, url, description, order, createdAt, deletedAt, updatedAt',
        favicons: 'id, data, url, timestamp',
        syncQueue: '++id, operation, tableName, recordId, timestamp, status, retryCount',
        historyEntries: 'id, seq, createdAt, kind, label, origin, groupId',
        historyState: 'id, cursorSeq, headSeq, maxDepth'
    }).upgrade(async tx => {
        const historyStateTable = tx.table('historyState');
        const existing = await historyStateTable.get(UNDO_REDO_HISTORY_STATE_ID);
        if (!existing) {
            await historyStateTable.put({
                id: UNDO_REDO_HISTORY_STATE_ID,
                cursorSeq: 0,
                headSeq: 0,
                maxDepth: UNDO_REDO_HISTORY_MAX_DEPTH_DEFAULT
            });
        }
    });
    // Version 16: Add Base64 data caching for favicons (instant loading) - MUST match newtab.js
    db.version(16).stores({
        pages: 'id, name, order, createdAt, isDefault, deletedAt, updatedAt, shareId',
        boards: 'id, pageId, name, columnIndex, order, createdAt, [pageId+columnIndex+order], deletedAt, updatedAt, shareId',
        bookmarks: 'id, boardId, title, url, description, order, createdAt, deletedAt, updatedAt',
        favicons: 'id, data, url, timestamp',  // 'id' is hostname, 'data' is Base64
        syncQueue: '++id, operation, tableName, recordId, timestamp, status, retryCount'
    });
    // Version 15: Switch to client-generated UUIDs (eliminates ID remapping complexity) - MUST match newtab.js
    db.version(15).stores({
        pages: 'id, name, order, createdAt, isDefault, deletedAt, updatedAt, shareId',
        boards: 'id, pageId, name, columnIndex, order, createdAt, [pageId+columnIndex+order], deletedAt, updatedAt, shareId',
        bookmarks: 'id, boardId, title, url, description, order, createdAt, deletedAt, updatedAt',
        favicons: 'id, hostname, url, timestamp',
        syncQueue: '++id, operation, tableName, recordId, timestamp, status, retryCount'
        // idMappings table removed - no longer needed with UUIDs!
    }).upgrade(async tx => {
        // FIX [Critical #3]: Add upgrade handler matching newtab.js to prevent data corruption
        // If background.js opens DB first without this handler, integer IDs won't be migrated to UUIDs
        

        // Create ID mapping for migration
        const pageIdMap = new Map();
        const boardIdMap = new Map();

        // Step 1: Migrate pages
        const pages = await tx.table('pages').toArray();
        for (const page of pages) {
            const oldId = page.id;
            const newId = generateId();
            pageIdMap.set(oldId, newId);

            await tx.table('pages').delete(oldId);
            await tx.table('pages').add({ ...page, id: newId });
        }
        

        // Step 2: Migrate boards (update pageId references)
        const boards = await tx.table('boards').toArray();
        for (const board of boards) {
            const oldId = board.id;
            const newId = generateId();
            const newPageId = pageIdMap.get(board.pageId) || board.pageId;
            boardIdMap.set(oldId, newId);

            await tx.table('boards').delete(oldId);
            await tx.table('boards').add({ ...board, id: newId, pageId: newPageId });
        }
        

        // Step 3: Migrate bookmarks (update boardId references)
        const bookmarks = await tx.table('bookmarks').toArray();
        for (const bookmark of bookmarks) {
            const oldId = bookmark.id;
            const newId = generateId();
            const newBoardId = boardIdMap.get(bookmark.boardId) || bookmark.boardId;

            await tx.table('bookmarks').delete(oldId);
            await tx.table('bookmarks').add({ ...bookmark, id: newId, boardId: newBoardId });
        }
        

        // Step 4: Clear old idMappings table (no longer needed)
        try {
            await tx.table('idMappings').clear();
            
        } catch (e) {
            // Table might not exist, ignore
        }

        // Step 5: Clear sync queue (old numeric IDs would cause issues)
        await tx.table('syncQueue').clear();
        

        
    });
    // Version 14: Add idMappings table for tracking local→server ID remaps - MUST match newtab.js
    db.version(14).stores({
        pages: '++id, name, order, createdAt, isDefault, deletedAt, updatedAt, shareId',
        boards: '++id, pageId, name, columnIndex, order, createdAt, [pageId+columnIndex+order], deletedAt, updatedAt, shareId',
        bookmarks: '++id, boardId, title, url, description, order, createdAt, deletedAt, updatedAt',
        favicons: 'id, hostname, url, timestamp',
        syncQueue: '++id, operation, tableName, recordId, timestamp, status, retryCount',
        idMappings: '[tableName+localId], tableName, localId, serverId, createdAt'
    });
    // Version 13: Add shareId to pages and boards for simplified sharing - MUST match newtab.js
    db.version(13).stores({
        pages: '++id, name, order, createdAt, isDefault, deletedAt, updatedAt, shareId',
        boards: '++id, pageId, name, columnIndex, order, createdAt, [pageId+columnIndex+order], deletedAt, updatedAt, shareId',
        bookmarks: '++id, boardId, title, url, description, order, createdAt, deletedAt, updatedAt',
        favicons: 'id, hostname, url, timestamp',
        syncQueue: '++id, operation, tableName, recordId, timestamp, status, retryCount'
    });
    // Version 12: Remove lock page feature fields - MUST match newtab.js
    db.version(12).stores({
        pages: '++id, name, order, createdAt, isDefault, deletedAt, updatedAt',
        boards: '++id, pageId, name, columnIndex, order, createdAt, [pageId+columnIndex+order], deletedAt, updatedAt',
        bookmarks: '++id, boardId, title, url, description, order, createdAt, deletedAt, updatedAt',
        favicons: 'id, hostname, url, timestamp',
        syncQueue: '++id, operation, tableName, recordId, timestamp, status, retryCount'
    });
    // Version 11: Add syncQueue for background sync - MUST match newtab.js
    db.version(11).stores({
        pages: '++id, name, order, createdAt, isDefault, isPrivate, passcodeHash, encryptionSalt, encryptedKeyBackup, recoveryKeyId, deletedAt, updatedAt',
        boards: '++id, pageId, name, columnIndex, order, createdAt, [pageId+columnIndex+order], deletedAt, updatedAt',
        bookmarks: '++id, boardId, title, url, description, order, createdAt, deletedAt, updatedAt',
        favicons: 'id, hostname, url, timestamp',
        syncQueue: '++id, operation, tableName, recordId, timestamp, status, retryCount'
    });
    // Version 10: Re-add lock page feature with OTP recovery support - MUST match newtab.js
    db.version(10).stores({
        pages: '++id, name, order, createdAt, isDefault, isPrivate, passcodeHash, encryptionSalt, encryptedKeyBackup, recoveryKeyId, deletedAt',
        boards: '++id, pageId, name, columnIndex, order, createdAt, [pageId+columnIndex+order], deletedAt',
        bookmarks: '++id, boardId, title, url, description, order, createdAt, deletedAt',
        favicons: 'id, hostname, url, timestamp'
    });
    // Version 9: Remove lock folder feature (no more encryption/private pages) - MUST match newtab.js
    db.version(9).stores({
        pages: '++id, name, order, createdAt, isDefault, deletedAt',
        boards: '++id, pageId, name, columnIndex, order, createdAt, [pageId+columnIndex+order], deletedAt',
        bookmarks: '++id, boardId, title, url, description, order, createdAt, deletedAt',
        favicons: 'id, hostname, url, timestamp'
    });
    // Version 8: Add passcode recovery support (encryptedKeyBackup) - MUST match newtab.js
    db.version(8).stores({
        pages: '++id, name, order, createdAt, isDefault, isPrivate, passcodeHash, encryptionSalt, encryptedKeyBackup, deletedAt',
        boards: '++id, pageId, name, columnIndex, order, createdAt, [pageId+columnIndex+order], deletedAt',
        bookmarks: '++id, boardId, title, url, description, order, createdAt, deletedAt',
        favicons: 'id, hostname, url, timestamp'
    });
    // Version 7: Add encryption support for private pages - MUST match newtab.js
    db.version(7).stores({
        pages: '++id, name, order, createdAt, isDefault, isPrivate, passcodeHash, encryptionSalt, deletedAt',
        boards: '++id, pageId, name, columnIndex, order, createdAt, [pageId+columnIndex+order], deletedAt',
        bookmarks: '++id, boardId, title, url, description, order, createdAt, deletedAt',
        favicons: 'id, hostname, url, timestamp'
    });
    // Version 6: Add soft delete support (deletedAt for trash feature) - MUST match newtab.js
    db.version(6).stores({
        pages: '++id, name, order, createdAt, isDefault, isPrivate, passcodeHash, deletedAt',
        boards: '++id, pageId, name, columnIndex, order, createdAt, [pageId+columnIndex+order], deletedAt',
        bookmarks: '++id, boardId, title, url, description, order, createdAt, deletedAt',
        favicons: 'id, hostname, url, timestamp'
    });
    // Version 5: Add private page support (MUST match newtab.js)
    db.version(5).stores({
        pages: '++id, name, order, createdAt, isDefault, isPrivate, passcodeHash',
        boards: '++id, pageId, name, columnIndex, order, createdAt, [pageId+columnIndex+order]',
        bookmarks: '++id, boardId, title, url, description, order, createdAt',
        favicons: 'id, hostname, url, timestamp'
    });
    // Version 4: Add favicons cache
    db.version(4).stores({
        pages: '++id, name, order, createdAt, isDefault',
        boards: '++id, pageId, name, columnIndex, order, createdAt, [pageId+columnIndex+order]',
        bookmarks: '++id, boardId, title, url, description, order, createdAt',
        favicons: 'id, hostname, url, timestamp'
    });
    // Version 3: Add pages support
    db.version(3).stores({
        pages: '++id, name, order, createdAt, isDefault',
        boards: '++id, pageId, name, columnIndex, order, createdAt, [pageId+columnIndex+order]',
        bookmarks: '++id, boardId, title, url, description, order, createdAt'
    });

    // FIX [Issue #5]: Add event handlers for IndexedDB schema upgrade blocking
    // When multiple tabs are open and one tries to upgrade, others may block the upgrade
    db.on('blocked', () => {
        console.warn('[Background] Database upgrade blocked - other tabs may need to close');
        // In background script, we can't show UI alerts, just log
    });

    db.on('versionchange', () => {
        _dbReady = false;
        _dbInitPromise = null;
        db.close();
        // Background scripts don't need to reload, they'll reconnect on next database operation
    });

    db.on('close', () => {
        _dbReady = false;
        _dbInitPromise = null;
    });
} catch (e) {
    console.error('Failed to setup database:', e);
}

const QUICK_SAVE_BOARD_NAME = 'Quick Saved';
const BACKGROUND_HISTORY_STATE_ID = 'main';
const BACKGROUND_HISTORY_MAX_DEPTH_DEFAULT = 200;

function cloneBackgroundHistorySnapshot(value) {
    if (value === null || value === undefined) return null;
    try {
        if (typeof structuredClone === 'function') {
            return structuredClone(value);
        }
    } catch (error) {
        // Fall back to JSON clone.
    }
    return JSON.parse(JSON.stringify(value));
}

function normalizeBackgroundHistoryRowForCompare(row) {
    if (!row || typeof row !== 'object') return row;
    const copy = { ...row };
    delete copy.updatedAt;
    return copy;
}

function areBackgroundHistoryRowsEquivalent(a, b) {
    if (a === null || a === undefined) return b === null || b === undefined;
    if (b === null || b === undefined) return false;
    return JSON.stringify(normalizeBackgroundHistoryRowForCompare(a)) === JSON.stringify(normalizeBackgroundHistoryRowForCompare(b));
}

function normalizeBackgroundHistoryOps(ops) {
    if (!Array.isArray(ops) || ops.length === 0) return [];

    const byKey = new Map();
    const ordered = [];
    ops.forEach((op) => {
        if (!op || !op.table || !op.id) return;
        if (!['pages', 'boards', 'bookmarks'].includes(op.table)) return;
        const key = `${op.table}:${op.id}`;
        const before = op.before === undefined ? null : cloneBackgroundHistorySnapshot(op.before);
        const after = op.after === undefined ? null : cloneBackgroundHistorySnapshot(op.after);
        if (byKey.has(key)) {
            byKey.get(key).after = after;
            return;
        }
        const normalized = { table: op.table, id: op.id, before, after };
        byKey.set(key, normalized);
        ordered.push(normalized);
    });

    return ordered.filter(op => !areBackgroundHistoryRowsEquivalent(op.before, op.after));
}

async function ensureBackgroundHistoryStateRow(historyStateTable = db.historyState) {
    if (!historyStateTable) return null;
    const existing = await historyStateTable.get(BACKGROUND_HISTORY_STATE_ID);
    if (existing) {
        const normalized = {
            ...existing,
            cursorSeq: Number(existing.cursorSeq) || 0,
            headSeq: Number(existing.headSeq) || 0,
            maxDepth: Number(existing.maxDepth) || BACKGROUND_HISTORY_MAX_DEPTH_DEFAULT
        };
        if (!existing.maxDepth) {
            await historyStateTable.put(normalized);
        }
        return normalized;
    }
    const fresh = {
        id: BACKGROUND_HISTORY_STATE_ID,
        cursorSeq: 0,
        headSeq: 0,
        maxDepth: BACKGROUND_HISTORY_MAX_DEPTH_DEFAULT
    };
    await historyStateTable.put(fresh);
    return fresh;
}

async function recordBackgroundHistoryEntry({ kind, label, ops, meta = null }) {
    if (!db?.historyEntries || !db?.historyState) return;
    const normalizedOps = normalizeBackgroundHistoryOps(ops);
    if (normalizedOps.length === 0) return;

    try {
        await db.transaction('rw', db.historyEntries, db.historyState, async () => {
            const state = await ensureBackgroundHistoryStateRow(db.historyState);
            if (!state) return;

            if (state.cursorSeq < state.headSeq) {
                await db.historyEntries.where('seq').above(state.cursorSeq).delete();
                state.headSeq = state.cursorSeq;
            }

            const nextSeq = state.cursorSeq + 1;
            await db.historyEntries.put({
                id: generateId(),
                seq: nextSeq,
                createdAt: new Date().toISOString(),
                kind: kind || 'background_change',
                label: label || 'Background change',
                origin: 'local',
                groupId: null,
                ops: normalizedOps,
                meta: meta || null
            });

            state.cursorSeq = nextSeq;
            state.headSeq = nextSeq;
            state.maxDepth = Number(state.maxDepth) || BACKGROUND_HISTORY_MAX_DEPTH_DEFAULT;
            await db.historyState.put(state);

            const pruneBeforeSeq = nextSeq - state.maxDepth;
            if (pruneBeforeSeq > 0) {
                await db.historyEntries.where('seq').belowOrEqual(pruneBeforeSeq).delete();
            }
        });
    } catch (error) {
        console.warn('[Background] Failed to record history entry:', error);
    }
}

/**
 * Ensure a "Quick Saved" board exists at the top-left (column 0, topmost order).
 * If the topmost board in column 0 is "Quick Saved", reuse it.
 * Otherwise create a new "Quick Saved" board at order 0 and shift column-0 boards down.
 * Must be called inside a Dexie transaction.
 * Returns { quickBoardId, boardIsNew, shiftedBoardIds, shiftedBoardsBefore }.
 */
async function ensureQuickSavedBoardAtTopLeft(pageId) {
    const allBoards = await db.boards.where('pageId').equals(pageId).toArray();
    const activeBoards = allBoards.filter(b => !b.deletedAt);

    const toInt = (value, fallback = 0) => {
        const parsed = parseInt(value, 10);
        return Number.isFinite(parsed) ? parsed : fallback;
    };

    const column0Boards = activeBoards.filter(b => toInt(b.columnIndex, 0) === 0);
    if (column0Boards.length > 0) {
        const minOrder = Math.min(...column0Boards.map(b => toInt(b.order, 0)));
        const topQuickSaved = column0Boards.find(b =>
            b.name === QUICK_SAVE_BOARD_NAME && toInt(b.order, 0) === minOrder
        );
        if (topQuickSaved) {
            return { quickBoardId: topQuickSaved.id, boardIsNew: false, shiftedBoardIds: [], shiftedBoardsBefore: [] };
        }
    }

    const nowIso = new Date().toISOString();
    const shiftedBoardIds = [];
    const shiftedBoardsBefore = [];

    if (column0Boards.length > 0) {
        const minOrder = Math.min(...column0Boards.map(b => toInt(b.order, 0)));
        // Only shift when a board already occupies order 0 or when there are negative orders.
        // If minOrder >= 1, there's already space at order 0.
        const shiftDelta = minOrder <= 0 ? (1 - minOrder) : 0;
        if (shiftDelta !== 0) {
            await Promise.all(column0Boards.map(b =>
                Promise.resolve().then(() => {
                    shiftedBoardsBefore.push(cloneBackgroundHistorySnapshot(b));
                }).then(() =>
                db.boards.update(b.id, { order: toInt(b.order, 0) + shiftDelta, updatedAt: nowIso })
                    .then(() => shiftedBoardIds.push(b.id))
                )
            ));
        }
    }

    const newBoardId = generateId();
    await db.boards.add({
        id: newBoardId,
        pageId: pageId,
        name: QUICK_SAVE_BOARD_NAME,
        columnIndex: 0,
        order: 0,
        createdAt: new Date(),
        updatedAt: nowIso
    });

    return { quickBoardId: newBoardId, boardIsNew: true, shiftedBoardIds, shiftedBoardsBefore };
}

/**
 * Resolve the effective page target for quick-save flows.
 * Handles deleted/invalid page preferences and falls back to default/first page.
 */
function normalizeBackgroundLoginSyncState(rawState) {
    if (!rawState || typeof rawState !== 'object') return null;
    const userId = normalizeBackgroundSyncSourceUserId(rawState.userId);
    const phase = (typeof rawState.phase === 'string' && rawState.phase.trim())
        ? rawState.phase.trim()
        : null;
    if (!userId || !phase) return null;
    return {
        userId,
        phase
    };
}

function getBackgroundSaveGuardResult(storageData = {}) {
    const activeUserId = normalizeBackgroundSyncSourceUserId(storageData?.lumilist_user?.id);
    const loginSyncState = normalizeBackgroundLoginSyncState(
        storageData?.[BACKGROUND_LOGIN_SYNC_STATE_STORAGE_KEY]
    );

    if (activeUserId && loginSyncState?.userId === activeUserId && loginSyncState.phase === 'pending') {
        return {
            allowed: false,
            message: 'LumiList is still syncing this account. Please wait a moment and try again.',
            loginSyncPending: true
        };
    }

    return { allowed: true };
}

async function resolveQuickSaveTargetPage(storageData = {}) {
    const preferredQuickSavePageId = storageData.quickSavePageId;
    let pageId = null;
    let shouldResetQuickSavePreference = false;

    if (preferredQuickSavePageId && preferredQuickSavePageId !== 'current') {
        pageId = preferredQuickSavePageId;
    } else {
        pageId = storageData.currentPageId || null;
    }

    if (pageId) {
        const configuredPage = await db.pages.get(pageId);
        if (!configuredPage || configuredPage.deletedAt) {
            if (preferredQuickSavePageId && preferredQuickSavePageId !== 'current' && preferredQuickSavePageId === pageId) {
                shouldResetQuickSavePreference = true;
            }
            pageId = null;
        }
    }

    if (!pageId) {
        const pages = await db.pages.filter(p => !p.deletedAt).toArray();
        const defaultPage = pages.find(p => p.isDefault === true || p.isDefault === 1);
        if (defaultPage) {
            pageId = defaultPage.id;
        } else if (pages.length > 0) {
            pageId = pages[0].id;
        }
    }

    if (!pageId) {
        return { pageId: null, pageName: null };
    }

    if (shouldResetQuickSavePreference) {
        try {
            await chrome.storage.local.set({ quickSavePageId: 'current' });
        } catch (error) {
            console.warn('[QuickSave] Failed to heal invalid quickSavePageId preference:', error);
        }
    }

    const page = await db.pages.get(pageId);
    return {
        pageId,
        pageName: page ? page.name : 'Unknown'
    };
}

// Listen for keyboard shortcut
chrome.commands.onCommand.addListener(async (command) => {
    
    if (command === 'quick-save') {
        // Get the active tab for toast notification
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const result = await quickSaveCurrentTab();
        // Show toast notification on the page (fire-and-forget for instant feedback)
        if (tab && tab.id) {
            showSaveNotification(result, tab.id, tab.url).catch(err =>
                console.error('[QuickSave] Toast notification failed:', err)
            );
        }
    }
});

function isRestrictedScriptUrl(url) {
    if (!url || typeof url !== 'string') return false;
    const lowerUrl = url.toLowerCase();

    return lowerUrl.startsWith('chrome://') ||
        lowerUrl.startsWith('chrome-extension://') ||
        lowerUrl.startsWith('edge://') ||
        lowerUrl.startsWith('about:') ||
        lowerUrl.startsWith('devtools://') ||
        lowerUrl.startsWith('view-source:');
}

function isRestrictedInjectionError(error) {
    const message = (error?.message || String(error || '')).toLowerCase();
    return message.includes('cannot access contents of url') ||
        message.includes('must request permission to access this host') ||
        message.includes('cannot access a chrome');
}

// Show an in-page toast notification for keyboard shortcut saves
async function showSaveNotification(result, tabId, tabUrl = null) {
    // Check if scripting API is available (requires extension reload after permission added)
    if (!chrome.scripting || !chrome.scripting.executeScript) {
        
        await showNotificationFallback(result);
        return;
    }

    try {
        let targetUrl = tabUrl;
        if (!targetUrl && chrome.tabs?.get) {
            const tab = await chrome.tabs.get(tabId);
            targetUrl = tab?.url || '';
        }

        if (isRestrictedScriptUrl(targetUrl)) {
            console.warn(`[QuickSave] Toast skipped on restricted page: ${targetUrl}`);
            await showNotificationFallback(result);
            return;
        }

        const themeData = await chrome.storage.local.get(['themeMode']);
        const activeTheme = themeData.themeMode === 'light' ? 'light' : 'dark';
        const themePalette = activeTheme === 'light'
            ? {
                background: 'rgba(248, 251, 255, 0.96)',
                textPrimary: '#182130',
                textSecondary: 'rgba(24, 33, 48, 0.72)',
                insetBorder: 'rgba(15, 23, 42, 0.08)',
                shadow: '0 8px 28px rgba(15, 23, 42, 0.18)'
            }
            : {
                background: 'rgba(33, 37, 49, 0.85)',
                textPrimary: '#ffffff',
                textSecondary: 'rgba(255, 255, 255, 0.7)',
                insetBorder: 'rgba(255, 255, 255, 0.05)',
                shadow: '0 8px 32px rgba(0, 0, 0, 0.4)'
            };

        // Inject toast into the active tab
        await chrome.scripting.executeScript({
            target: { tabId: tabId },
            func: (result, themePalette) => {
                // Remove existing toast if any
                const existingToast = document.getElementById('lumilist-toast');
                if (existingToast) existingToast.remove();

                // FIX [Critical #10]: Define escapeHtml INSIDE the injected function
                // The service worker's escapeHtml is not available in page context
                const escapeHtml = (text) => {
                    if (!text) return '';
                    return String(text)
                        .replace(/&/g, '&amp;')
                        .replace(/</g, '&lt;')
                        .replace(/>/g, '&gt;')
                        .replace(/"/g, '&quot;')
                        .replace(/'/g, '&#039;');
                };

                // Create toast container
                const toast = document.createElement('div');
                toast.id = 'lumilist-toast';

                // Determine toast type
                const isSuccess = result.success;
                const isAlreadySaved = result.message && result.message.includes('Already');

                // SVG icons for glass style
                const icons = {
                    lock: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#5b7cfa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>`,
                    star: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffc107" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>`,
                    error: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ff6b7a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>`,
                    check: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#00ff88" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="9 12 12 15 16 10"></polyline></svg>`,
                    checkBlue: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#5b7cfa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="9 12 12 15 16 10"></polyline></svg>`,
                    bookmark: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#00ff88" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path><line x1="12" y1="7" x2="12" y2="13"></line><line x1="9" y1="10" x2="15" y2="10"></line></svg>`
                };

                // Set content based on result
                let icon, title, message, borderColor, glowColor;
                if (!isSuccess && result.requiresLogin) {
                    icon = icons.lock;
                    title = 'Login Required';
                    message = 'Please login to save bookmarks';
                    borderColor = 'rgba(91, 124, 250, 0.3)';
                    glowColor = 'rgba(91, 124, 250, 0.5)';
                } else if (!isSuccess && result.requiresSubscription) {
                    icon = icons.star;
                    title = 'Subscription Required';
                    message = 'Subscribe to save bookmarks';
                    borderColor = 'rgba(255, 193, 7, 0.3)';
                    glowColor = 'rgba(255, 193, 7, 0.5)';
                } else if (!isSuccess) {
                    icon = icons.error;
                    title = 'Cannot Save';
                    message = result.message || 'Unknown error';
                    borderColor = 'rgba(255, 107, 122, 0.3)';
                    glowColor = 'rgba(255, 107, 122, 0.5)';
                } else if (isAlreadySaved) {
                    icon = icons.checkBlue;
                    title = 'Already Saved';
                    message = 'This page is in your bookmarks';
                    borderColor = 'rgba(91, 124, 250, 0.3)';
                    glowColor = 'rgba(91, 124, 250, 0.5)';
                } else {
                    icon = icons.bookmark;
                    title = 'Saved to LumiList!';
                    message = `Added to "${result.pageName || 'Quick Saved'}"`;
                    borderColor = 'rgba(0, 255, 136, 0.3)';
                    glowColor = 'rgba(0, 255, 136, 0.5)';
                }

                toast.innerHTML = `
                    <div style="display: flex; align-items: center; gap: 12px;">
                        <div style="filter: drop-shadow(0 0 8px ${glowColor});">${icon}</div>
                        <div>
                            <div style="font-weight: 600; font-size: 14px; margin-bottom: 2px; color: ${themePalette.textPrimary};">${escapeHtml(title)}</div>
                            <div style="font-size: 12px; color: ${themePalette.textSecondary};">${escapeHtml(message)}</div>
                        </div>
                    </div>
                `;

                // Apply glass styles
                Object.assign(toast.style, {
                    position: 'fixed',
                    top: '20px',
                    right: '20px',
                    background: themePalette.background,
                    backdropFilter: 'blur(16px) saturate(120%)',
                    webkitBackdropFilter: 'blur(16px) saturate(120%)',
                    color: themePalette.textPrimary,
                    padding: '16px 20px',
                    borderRadius: '14px',
                    border: `1px solid ${borderColor}`,
                    boxShadow: `${themePalette.shadow}, 0 0 0 1px ${themePalette.insetBorder} inset`,
                    zIndex: '2147483647',
                    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
                    transform: 'translateX(120%)',
                    transition: 'transform 0.3s cubic-bezier(0.68, -0.55, 0.265, 1.55)',
                    maxWidth: '300px'
                });

                document.body.appendChild(toast);

                // Animate in
                requestAnimationFrame(() => {
                    toast.style.transform = 'translateX(0)';
                });

                // Animate out and remove
                setTimeout(() => {
                    toast.style.transform = 'translateX(120%)';
                    setTimeout(() => toast.remove(), 300);
                }, 3000);
            },
            args: [result, themePalette]
        });
    } catch (e) {
        if (isRestrictedInjectionError(e)) {
            console.warn('Toast injection skipped on restricted page:', e?.message || e);
        } else {
            console.error('Toast injection error:', e);
        }
        // Fallback to notification
        await showNotificationFallback(result);
    }
}

// Fallback to browser notification when scripting API is not available
async function showNotificationFallback(result) {
    // Always show badge as immediate visual feedback
    await showBadge(result.success ? 'success' : 'error');

    // Also try to show a system notification
    try {
        const isAlreadySaved = result.message && result.message.includes('Already');
        const notificationId = await chrome.notifications.create({
            type: 'basic',
            iconUrl: 'icons/icon-128.png',
            title: result.success
                ? (isAlreadySaved ? 'Already Saved' : '🔖 Saved to LumiList!')
                : 'Cannot Save',
            message: result.success
                ? (isAlreadySaved ? 'This page is in your bookmarks' : `Added to "${result.pageName}"`)
                : result.message,
            silent: false  // Make it audible for visibility
        });
        
    } catch (e) {
        console.error('Notification error (system may be blocking):', e);
    }
}

// Show badge on extension icon
async function showBadge(type) {
    const config = {
        success: { text: '✓', color: '#00ff88' },
        error: { text: '✗', color: '#ff6b7a' },
        info: { text: '✓', color: '#5bc0de' }
    };

    try {
        await chrome.action.setBadgeText({ text: config[type].text });
        await chrome.action.setBadgeBackgroundColor({ color: config[type].color });

        setTimeout(async () => {
            try { await chrome.action.setBadgeText({ text: '' }); } catch (e) { }
        }, 2000);
    } catch (e) {
        console.error('Badge error:', e);
    }
}

// Notify any open LumiList newtab pages to reload their data
// Uses storage event which is more reliable than direct messaging
async function refreshLumiListTabs() {
    try {
        // Trigger a storage event that newtab.js listens for
        await chrome.storage.local.set({
            reloadBoardsSignal: {
                timestamp: Date.now(),
                source: 'quickSave'
            }
        });
        
    } catch (e) {
        console.error('Error sending reload signal:', e);
    }
}

function isBackgroundSyncQueueFullError(errorOrMessage) {
    const message = typeof errorOrMessage === 'string'
        ? errorOrMessage
        : (errorOrMessage?.message || '');
    return /sync queue is full|queue is full|queue full/i.test(message);
}

function normalizeBackgroundSyncSourceUserId(userId) {
    return (typeof userId === 'string' && userId.trim()) ? userId.trim() : null;
}

function stripBackgroundLocalOnlySyncFields(tableName, data) {
    if (!data || typeof data !== 'object') return data;
    if (tableName !== 'pages') return data;
    if (!Object.prototype.hasOwnProperty.call(data, 'pendingStartupSync')) return data;

    const sanitized = { ...data };
    delete sanitized.pendingStartupSync;
    return sanitized;
}

async function collectBackgroundPendingStartupPageSyncOperations() {
    if (!db?.pages || typeof db.pages.toArray !== 'function') {
        return {
            operations: [],
            pageIds: []
        };
    }

    const allPages = await db.pages.toArray();
    const pendingPages = allPages.filter(page => page?.pendingStartupSync && !page.deletedAt);
    if (pendingPages.length === 0) {
        return {
            operations: [],
            pageIds: []
        };
    }

    return {
        operations: pendingPages.map(page => ({
            operation: 'upsert',
            tableName: 'pages',
            recordId: page.id,
            data: stripBackgroundLocalOnlySyncFields('pages', page)
        })),
        pageIds: pendingPages.map(page => page.id).filter(Boolean)
    };
}

async function prepareBackgroundSyncOperationsForQueue(operations = []) {
    const normalizedOperations = Array.isArray(operations)
        ? operations.filter(Boolean).map(op => ({
            ...op,
            data: stripBackgroundLocalOnlySyncFields(op.tableName, op.data)
        }))
        : [];

    const bootstrapBundle = await collectBackgroundPendingStartupPageSyncOperations();
    if (!bootstrapBundle.operations.length) {
        return {
            operations: normalizedOperations,
            bootstrapPageIds: []
        };
    }

    const existingKeys = new Set(
        normalizedOperations.map(op => `${op.tableName}:${op.recordId}`)
    );
    const missingBootstrapOps = bootstrapBundle.operations.filter(
        op => !existingKeys.has(`${op.tableName}:${op.recordId}`)
    );

    return {
        operations: [...missingBootstrapOps, ...normalizedOperations],
        bootstrapPageIds: bootstrapBundle.pageIds
    };
}

async function clearBackgroundPendingStartupSyncFlags(pageIds = []) {
    if (!db?.pages || typeof db.pages.get !== 'function' || typeof db.pages.update !== 'function') return;

    const uniquePageIds = [...new Set((pageIds || []).filter(Boolean))];
    if (uniquePageIds.length === 0) return;

    for (const pageId of uniquePageIds) {
        try {
            const page = await db.pages.get(pageId);
            if (!page?.pendingStartupSync) continue;
            await db.pages.update(pageId, { pendingStartupSync: false });
        } catch (error) {
            console.warn(`[QuickSave] Failed to clear pendingStartupSync for page ${pageId}:`, error);
        }
    }
}

async function rollbackBackgroundMutationChanges(changeSet = {}) {
    if (!db?.transaction || !db?.boards || !db?.bookmarks) return;

    const createdBookmarkIds = [...new Set((changeSet.createdBookmarkIds || []).filter(Boolean))];
    const restoredBookmarksBefore = (changeSet.restoredBookmarksBefore || []).filter(row => !!row?.id);
    const restoredBoardsBefore = (changeSet.restoredBoardsBefore || []).filter(row => !!row?.id);
    const createdBoardId = changeSet.createdBoardId || null;

    await db.transaction('rw', [db.boards, db.bookmarks], async () => {
        if (createdBookmarkIds.length > 0) {
            await db.bookmarks.bulkDelete(createdBookmarkIds);
        }

        for (const beforeBookmark of restoredBookmarksBefore) {
            await db.bookmarks.put(cloneBackgroundHistorySnapshot(beforeBookmark));
        }

        if (createdBoardId) {
            await db.boards.delete(createdBoardId);
        }

        for (const beforeBoard of restoredBoardsBefore) {
            await db.boards.put(cloneBackgroundHistorySnapshot(beforeBoard));
        }
    });
}

async function attachBackgroundSyncUserScope(operations) {
    if (!Array.isArray(operations) || operations.length === 0) {
        return [];
    }

    let sourceUserId = null;
    try {
        const storageData = await chrome.storage.local.get(['lumilist_user']);
        sourceUserId = normalizeBackgroundSyncSourceUserId(storageData?.lumilist_user?.id);
    } catch (error) {
        console.warn('[QuickSave] Failed to resolve sync queue user scope:', error);
    }

    return operations.map(op => ({
        ...op,
        sourceUserId: normalizeBackgroundSyncSourceUserId(op?.sourceUserId) || sourceUserId
    }));
}

async function queueBackgroundSyncOpsWithRetry(operations, contextLabel = 'BackgroundSync') {
    if (!Array.isArray(operations) || operations.length === 0) {
        return { success: true, queued: 0, retried: false, bootstrapPageIds: [] };
    }

    if (typeof BackgroundSync === 'undefined') {
        return { success: false, error: new Error('BackgroundSync not available') };
    }

    const prepared = await prepareBackgroundSyncOperationsForQueue(operations);
    const scopedOperations = await attachBackgroundSyncUserScope(prepared.operations);

    const queueBatch = async () => {
        const added = await BackgroundSync.addBatchToSyncQueue(scopedOperations);
        if (added === false) {
            const err = new Error('Sync queue is full. Please wait for pending changes to sync.');
            err.queueFull = true;
            throw err;
        }
        return Number.isFinite(added) ? added : scopedOperations.length;
    };

    try {
        const queued = await queueBatch();
        await clearBackgroundPendingStartupSyncFlags(prepared.bootstrapPageIds);
        return { success: true, queued, retried: false, bootstrapPageIds: prepared.bootstrapPageIds };
    } catch (error) {
        const queueFull = isBackgroundSyncQueueFullError(error) || error?.queueFull;
        if (!queueFull) {
            return { success: false, error };
        }

        try {
            const pushResult = await BackgroundSync.forcePush();
            if (pushResult && pushResult.success === false) {
                const pushError = new Error(pushResult.error || 'Unable to free sync queue space.');
                pushError.queueFull = true;
                return { success: false, error: pushError, queueFull: true };
            }
        } catch (pushError) {
            pushError.queueFull = true;
            return { success: false, error: pushError, queueFull: true };
        }

        try {
            const queued = await queueBatch();
            await clearBackgroundPendingStartupSyncFlags(prepared.bootstrapPageIds);
            return { success: true, queued, retried: true, bootstrapPageIds: prepared.bootstrapPageIds };
        } catch (retryError) {
            return {
                success: false,
                error: retryError,
                queueFull: !!(retryError?.queueFull || isBackgroundSyncQueueFullError(retryError))
            };
        }
    }
}

async function quickSaveTab(tab) {
    // FIX [Critical #1]: Mutex lock to prevent concurrent quick saves
    // Prevents duplicate bookmarks when user rapidly presses Ctrl+Shift+Y or clicks popup multiple times
    if (_isQuickSaving) {
        
        return { success: false, message: 'Save already in progress' };
    }
    _isQuickSaving = true;

    try {
        // FIX [H12]: Ensure database is ready before proceeding
        const dbReady = await ensureDbReady();
        if (!dbReady) {
            console.error('Database not ready for quickSaveTab');
            return { success: false, message: 'Database not ready. Please try again.' };
        }

        const storageData = await chrome.storage.local.get([
            'lumilist_user',
            'subscriptionStatus',
            'subscriptionData',
            'subscriptionLastKnownState',
            BACKGROUND_LOGIN_SYNC_STATE_STORAGE_KEY,
            'quickSavePageId',
            'currentPageId'
        ]);

        // Check if user is logged in first
        if (!storageData.lumilist_user) {
            
            return { success: false, message: 'Please login to save bookmarks', requiresLogin: true };
        }

        // Check subscription status
        const subscriptionAccess = await resolveBackgroundSubscriptionWriteAccess(storageData);
        const subAccess = subscriptionAccess.subAccess;
        if (!subAccess.allowed) {
            
            return {
                success: false,
                message: subAccess.message,
                requiresSubscription: !!subAccess.requiresSubscription,
                requiresStatusRefresh: !!subAccess.requiresStatusRefresh
            };
        }
        Object.assign(storageData, subscriptionAccess.storageData);

        const saveGuard = getBackgroundSaveGuardResult(storageData);
        if (!saveGuard.allowed) {
            return { success: false, message: saveGuard.message, loginSyncPending: true };
        }

        // Check bookmark limit
        const limitCheck = await checkBookmarkLimitFromDB();
        if (!limitCheck.allowed) {
            
            return { success: false, message: `Bookmark limit reached (${limitCheck.count.toLocaleString()}/${limitCheck.limit.toLocaleString()}). Delete some bookmarks to add more.` };
        }

        

        if (!tab || !tab.url) {
            return { success: false, message: 'No tab to save' };
        }

        // Don't save browser internal pages
        if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('about:')) {
            return { success: false, message: 'Cannot save browser pages' };
        }

        const { pageId, pageName } = await resolveQuickSaveTargetPage(storageData);
        if (!pageId) {
            return { success: false, message: 'No pages found. Open LumiList first.' };
        }

        // FIX [Critical #2]: Use transaction for board check+create AND bookmark save
        // Without transaction, two concurrent saves can both create "Quick Saved" boards
        const saveResult = await db.transaction('rw', [db.pages, db.boards, db.bookmarks], async () => {
            const targetPage = await db.pages.get(pageId);
            if (!targetPage || targetPage.deletedAt) {
                return { missingPage: true };
            }

            // Find or create "Quick Saved" board at top-left (exclude deleted boards)
            const {
                quickBoardId,
                boardIsNew,
                shiftedBoardIds,
                shiftedBoardsBefore
            } = await ensureQuickSavedBoardAtTopLeft(pageId);

            // Check if URL already exists in this board (FIX [Critical #4]: filter deleted)
            // FIX [Phase 3]: Use normalized URLs to treat example.com and example.com/ as same
            const allBookmarks = await db.bookmarks.where('boardId').equals(quickBoardId).toArray();
            const normalizedTabUrl = normalizeUrl(tab.url);
            const existingBookmark = allBookmarks.filter(b => !b.deletedAt).find(b => normalizeUrl(b.url) === normalizedTabUrl);

            if (existingBookmark) {
                return { alreadySaved: true };
            }

            // Increment order of existing non-deleted bookmarks atomically
            const activeBookmarks = allBookmarks.filter(b => !b.deletedAt);
            const updatedBookmarksBeforeRows = activeBookmarks.map(bookmark => cloneBackgroundHistorySnapshot(bookmark));
            const nowIso = new Date().toISOString();
            const updatePromises = activeBookmarks.map(bookmark =>
                db.bookmarks.update(bookmark.id, { order: (bookmark.order || 0) + 1, updatedAt: nowIso })
            );
            await Promise.all(updatePromises);

            // Add new bookmark at the top with updatedAt for sync
            const newBookmarkId = generateId();
            await db.bookmarks.add({
                id: newBookmarkId,
                boardId: quickBoardId,
                title: tab.title || 'Untitled',
                url: tab.url,
                description: null,
                order: 0,
                createdAt: new Date(),
                updatedAt: nowIso
            });

            // Return the updated bookmarks for sync queueing
            return {
                alreadySaved: false,
                newBookmarkId: newBookmarkId,
                updatedBookmarkIds: activeBookmarks.map(b => b.id),
                quickBoardId: quickBoardId,
                boardIsNew: boardIsNew,
                shiftedBoardIds: shiftedBoardIds,
                shiftedBoardsBefore: shiftedBoardsBefore || [],
                updatedBookmarksBeforeRows
            };
        });

        if (saveResult.missingPage) {
            return {
                success: false,
                message: 'The selected page is no longer available. Open LumiList and choose a page again.'
            };
        }

        if (saveResult.alreadySaved) {
            await showBadge('info');
            return { success: true, message: 'Already saved!', pageName: pageName };
        }

        
        let syncQueueResult = { success: true };
        // Queue sync operations for background sync
        if (typeof BackgroundSync !== 'undefined') {
            try {
                const syncOperations = [];

                // Get the new bookmark record for sync
                const newBookmark = await db.bookmarks.get(saveResult.newBookmarkId);
                if (newBookmark) {
                    syncOperations.push({
                        operation: 'upsert',
                        tableName: 'bookmarks',
                        recordId: newBookmark.id,
                        data: newBookmark
                    });
                }

                // Also queue the updated bookmarks (order changes)
                for (const bookmarkId of saveResult.updatedBookmarkIds) {
                    const bookmark = await db.bookmarks.get(bookmarkId);
                    if (bookmark) {
                        syncOperations.push({
                            operation: 'upsert',
                            tableName: 'bookmarks',
                            recordId: bookmark.id,
                            data: bookmark
                        });
                    }
                }

                // If board was newly created, queue it too
                if (saveResult.boardIsNew) {
                    const board = await db.boards.get(saveResult.quickBoardId);
                    if (board) {
                        syncOperations.push({
                            operation: 'upsert',
                            tableName: 'boards',
                            recordId: board.id,
                            data: board
                        });
                    }
                }

                if (saveResult.shiftedBoardIds?.length) {
                    for (const boardId of saveResult.shiftedBoardIds) {
                        const board = await db.boards.get(boardId);
                        if (board) {
                            syncOperations.push({
                                operation: 'upsert',
                                tableName: 'boards',
                                recordId: board.id,
                                data: board
                            });
                        }
                    }
                }

                syncQueueResult = await queueBackgroundSyncOpsWithRetry(syncOperations, 'QuickSave');
                if (syncQueueResult.success) {
                    // Trigger sync in background (non-blocking for instant user feedback)
                    BackgroundSync.forcePush().catch(err =>
                        console.error('[QuickSave] Background sync failed:', err)
                    );
                } else {
                    console.warn('[QuickSave] Queueing sync ops failed after retry:', syncQueueResult.error);
                }
            } catch (syncError) {
                syncQueueResult = { success: false, error: syncError };
                console.error('[QuickSave] Failed to queue sync:', syncError);
                // Continue - local save succeeded and refreshLumiListTabs will update UI
            }
        } else {
            syncQueueResult = { success: false, error: new Error('BackgroundSync not available') };
        }

        if (!syncQueueResult.success) {
            try {
                await rollbackBackgroundMutationChanges({
                    createdBoardId: saveResult.boardIsNew ? saveResult.quickBoardId : null,
                    createdBookmarkIds: [saveResult.newBookmarkId],
                    restoredBoardsBefore: saveResult.shiftedBoardsBefore || [],
                    restoredBookmarksBefore: saveResult.updatedBookmarksBeforeRows || []
                });
            } catch (rollbackError) {
                console.error('[QuickSave] Failed to roll back mutation after queue failure:', rollbackError);
            }
            await showBadge('error');
            return { success: false, message: 'Failed to save right now. Please try again.' };
        }

        await showBadge('success');

        const historyOps = [];
        if (saveResult.boardIsNew) {
            const createdBoard = await db.boards.get(saveResult.quickBoardId);
            if (createdBoard) {
                historyOps.push({
                    table: 'boards',
                    id: createdBoard.id,
                    before: null,
                    after: createdBoard
                });
            }
        }

        if (saveResult.shiftedBoardIds?.length) {
            const shiftedBoardAfterRows = (await db.boards.bulkGet(saveResult.shiftedBoardIds)).filter(Boolean);
            const shiftedBoardAfterById = new Map(shiftedBoardAfterRows.map(board => [board.id, board]));
            for (const beforeBoard of saveResult.shiftedBoardsBefore || []) {
                if (!beforeBoard?.id) continue;
                historyOps.push({
                    table: 'boards',
                    id: beforeBoard.id,
                    before: beforeBoard,
                    after: shiftedBoardAfterById.get(beforeBoard.id) || null
                });
            }
        }

        if (saveResult.updatedBookmarkIds?.length) {
            const updatedBookmarkAfterRows = (await db.bookmarks.bulkGet(saveResult.updatedBookmarkIds)).filter(Boolean);
            const updatedBookmarkBeforeById = new Map(
                (saveResult.updatedBookmarksBeforeRows || [])
                    .filter(bookmark => !!bookmark?.id)
                    .map(bookmark => [bookmark.id, bookmark])
            );
            updatedBookmarkAfterRows.forEach((bookmark) => {
                historyOps.push({
                    table: 'bookmarks',
                    id: bookmark.id,
                    before: updatedBookmarkBeforeById.get(bookmark.id) || null,
                    after: bookmark
                });
            });
        }

        const createdBookmark = await db.bookmarks.get(saveResult.newBookmarkId);
        if (createdBookmark) {
            historyOps.push({
                table: 'bookmarks',
                id: createdBookmark.id,
                before: null,
                after: createdBookmark
            });
        }

        if (historyOps.length > 0) {
            await recordBackgroundHistoryEntry({
                kind: 'bookmark_quick_save_tab',
                label: `Quick save tab "${(tab.title || createdBookmark?.title || 'Untitled').toString().slice(0, 80)}"`,
                ops: historyOps
            });
        }

        try {
            await trackReviewPromptManualBookmarks(storageData.lumilist_user?.id, 1);
        } catch (reviewTrackError) {
            console.warn('[ReviewPrompt] Failed to track quick-save tab bookmark count:', reviewTrackError);
        }

        // Refresh any open LumiList tabs (fire-and-forget for instant feedback)
        refreshLumiListTabs().catch(err =>
            console.error('[QuickSave] Failed to refresh tabs:', err)
        );

        return { success: true, message: `Saved to "${pageName}"!`, pageName: pageName };

    } catch (error) {
        console.error('Quick save error:', error);
        await showBadge('error');
        return { success: false, message: 'Failed to save: ' + error.message };
    } finally {
        // FIX [Critical #1]: Always release mutex, even on error or early return
        _isQuickSaving = false;
    }
}

// Quick save the current tab
async function quickSaveCurrentTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return quickSaveTab(tab);
}

// Save all open tabs in current window
async function saveAllTabs() {
    

    // FIX [Critical #1]: Mutex lock to prevent concurrent Save All operations
    // Prevents duplicate boards/bookmarks when user double-clicks the button
    if (_isSaveAllRunning) {
        
        return { success: false, message: 'Save already in progress' };
    }
    _isSaveAllRunning = true;

    // FIX [Issue #3]: Wrap entire function body in try/finally to ensure mutex is always released
    // Previously, early returns for login/subscription checks would leave mutex locked forever
    try {
        // FIX [H12]: Ensure database is ready before proceeding
        const dbReady = await ensureDbReady();
        if (!dbReady) {
            console.error('Database not ready for saveAllTabs');
            return { success: false, message: 'Database not ready. Please try again.' };
        }

        // Check if user is logged in first
        const storageData = await chrome.storage.local.get([
            'lumilist_user',
            'subscriptionStatus',
            'subscriptionData',
            'subscriptionLastKnownState',
            BACKGROUND_LOGIN_SYNC_STATE_STORAGE_KEY,
            CLOSE_TABS_AFTER_SAVE_ALL_STORAGE_KEY,
            'quickSavePageId',
            'currentPageId'
        ]);
        if (!storageData.lumilist_user) {
            
            return { success: false, message: 'Please login to save bookmarks', requiresLogin: true };
        }

        // Check subscription status - block if grace or expired
        const subscriptionAccess = await resolveBackgroundSubscriptionWriteAccess(storageData);
        const subAccess = subscriptionAccess.subAccess;
        if (!subAccess.allowed) {
            
            await showBadge('error');
            return {
                success: false,
                message: subAccess.message,
                requiresSubscription: !!subAccess.requiresSubscription,
                requiresStatusRefresh: !!subAccess.requiresStatusRefresh
            };
        }
        Object.assign(storageData, subscriptionAccess.storageData);

        const saveGuard = getBackgroundSaveGuardResult(storageData);
        if (!saveGuard.allowed) {
            return { success: false, message: saveGuard.message, loginSyncPending: true };
        }
        // Get all tabs in the current window
        const tabs = await chrome.tabs.query({ currentWindow: true });

        // Filter out browser internal pages
        const saveableTabs = tabs.filter(tab =>
            tab.url &&
            !tab.url.startsWith('chrome://') &&
            !tab.url.startsWith('chrome-extension://') &&
            !tab.url.startsWith('about:')
        );

        if (saveableTabs.length === 0) {
            return { success: false, message: 'No saveable tabs found' };
        }

        // Hard limit check to prevent abuse and sync queue overflow
        if (saveableTabs.length > MAX_SAVE_ALL_TABS) {
            
            return {
                success: false,
                message: `Cannot save ${saveableTabs.length} tabs. Maximum is ${MAX_SAVE_ALL_TABS} tabs at once.`,
                tabCount: saveableTabs.length,
                limit: MAX_SAVE_ALL_TABS,
                exceedsLimit: true
            };
        }

        // Check bookmark limit before saving
        const limitCheck = await checkBookmarkLimitFromDB();
        if (!limitCheck.allowed) {
            
            return {
                success: false,
                message: `Bookmark limit reached (${limitCheck.count.toLocaleString()}/${limitCheck.limit.toLocaleString()}). Delete some bookmarks to add more.`
            };
        }

        // Check if tabs would exceed limit
        if (saveableTabs.length > limitCheck.remaining) {
            
            return {
                success: false,
                message: `Cannot save ${saveableTabs.length} tabs. You have ${limitCheck.remaining.toLocaleString()} bookmark slots remaining (${limitCheck.count.toLocaleString()}/${limitCheck.limit.toLocaleString()}).`
            };
        }

        const shouldCloseSavedTabs = shouldCloseTabsAfterSaveAll(storageData);
        const { pageId, pageName } = await resolveQuickSaveTargetPage(storageData);
        if (!pageId) {
            return { success: false, message: 'No pages found. Open LumiList first.' };
        }

        // FIX [Critical #2 & #9]: Wrap board check+create AND bulk bookmark creation in transaction
        // Without transaction, two concurrent saves can create duplicate boards/bookmarks
        // Also prevents partial saves if service worker terminates mid-loop
        const saveResult = await db.transaction('rw', [db.pages, db.boards, db.bookmarks], async () => {
            const targetPage = await db.pages.get(pageId);
            if (!targetPage || targetPage.deletedAt) {
                return { missingPage: true };
            }

            // Find or create "Quick Saved" board at top-left (exclude deleted boards)
            const {
                quickBoardId,
                boardIsNew,
                shiftedBoardIds,
                shiftedBoardsBefore
            } = await ensureQuickSavedBoardAtTopLeft(pageId);

            // Get existing bookmarks in the board to check for duplicates (exclude deleted)
            const existingBookmarks = await db.bookmarks
                .where('boardId').equals(quickBoardId)
                .filter(b => !b.deletedAt)
                .toArray();
            // FIX [Phase 3]: Use normalized URLs to treat example.com and example.com/ as same
            const existingUrls = new Set(existingBookmarks.map(b => normalizeUrl(b.url)));

            // Filter out already saved tabs
            const newTabs = saveableTabs.filter(tab => !existingUrls.has(normalizeUrl(tab.url)));

            if (newTabs.length === 0) {
                return { allAlreadySaved: true, savedCount: 0 };
            }

            // Get current max order
            let maxOrder = existingBookmarks.reduce((max, b) => Math.max(max, b.order || 0), -1);

            // Add all new tabs as bookmarks with timestamps (atomically within transaction)
            const now = new Date().toISOString();
            const createdBookmarkIds = [];
            for (const tab of newTabs) {
                maxOrder++;
                const newBookmarkId = generateId();
                await db.bookmarks.add({
                    id: newBookmarkId,
                    boardId: quickBoardId,
                    title: tab.title || 'Untitled',
                    url: tab.url,
                    description: null,
                    order: maxOrder,
                    createdAt: new Date(),
                    updatedAt: now
                });
                createdBookmarkIds.push(newBookmarkId);
            }

            return {
                allAlreadySaved: false,
                savedCount: newTabs.length,
                createdBookmarkIds: createdBookmarkIds,
                quickBoardId: quickBoardId,
                newBoardCreated: boardIsNew,
                shiftedBoardIds: shiftedBoardIds,
                shiftedBoardsBefore: shiftedBoardsBefore || []
            };
        });

        if (saveResult.missingPage) {
            return {
                success: false,
                message: 'The selected page is no longer available. Open LumiList and choose a page again.'
            };
        }

        // Handle early return if all tabs were already saved
        if (saveResult.allAlreadySaved) {
            await showBadge('success');
            const closedCount = shouldCloseSavedTabs
                ? await closeTabsAfterSaveAll(saveableTabs.map((tab) => tab.id))
                : 0;
            const closeSuffix = closedCount > 0
                ? ` Closed ${closedCount} tab${closedCount === 1 ? '' : 's'}.`
                : '';
            return {
                success: true,
                message: `All tabs already saved!${closeSuffix}`,
                savedCount: 0,
                closedCount,
                pageName: pageName
            };
        }

        let syncQueueResult = { success: true };
        // FIX [H18]: Queue created items to BackgroundSync for server sync (batched)
        if (typeof BackgroundSync !== 'undefined') {
            const operations = [];

            // Queue the board if newly created
            if (saveResult.newBoardCreated) {
                const board = await db.boards.get(saveResult.quickBoardId);
                if (board) {
                    operations.push({
                        operation: 'upsert',
                        tableName: 'boards',
                        recordId: board.id,
                        data: board
                    });
                }
            }

            if (saveResult.shiftedBoardIds?.length) {
                for (const boardId of saveResult.shiftedBoardIds) {
                    const board = await db.boards.get(boardId);
                    if (!board) continue;
                    operations.push({
                        operation: 'upsert',
                        tableName: 'boards',
                        recordId: board.id,
                        data: board
                    });
                }
            }

            // Queue all created bookmarks in a single batch
            if (saveResult.createdBookmarkIds?.length) {
                const bookmarks = await db.bookmarks.bulkGet(saveResult.createdBookmarkIds);
                for (const bookmark of bookmarks) {
                    if (!bookmark) continue;
                    operations.push({
                        operation: 'upsert',
                        tableName: 'bookmarks',
                        recordId: bookmark.id,
                        data: bookmark
                    });
                }
            }

            syncQueueResult = await queueBackgroundSyncOpsWithRetry(operations, 'SaveAllTabs');
            if (syncQueueResult.success) {
                // Trigger sync in background (non-blocking for instant user feedback)
                BackgroundSync.forcePush().catch(err =>
                    console.error('[SaveAllTabs] Background sync failed:', err)
                );
            } else {
                console.warn('[SaveAllTabs] Queueing sync ops failed after retry:', syncQueueResult.error);
            }
        } else {
            syncQueueResult = { success: false, error: new Error('BackgroundSync not available') };
            console.warn('[SaveAllTabs] BackgroundSync not available, changes may not sync');
        }

        if (!syncQueueResult.success) {
            try {
                await rollbackBackgroundMutationChanges({
                    createdBoardId: saveResult.newBoardCreated ? saveResult.quickBoardId : null,
                    createdBookmarkIds: saveResult.createdBookmarkIds || [],
                    restoredBoardsBefore: saveResult.shiftedBoardsBefore || []
                });
            } catch (rollbackError) {
                console.error('[SaveAllTabs] Failed to roll back mutation after queue failure:', rollbackError);
            }
            await showBadge('error');
            return { success: false, message: 'Failed to save tabs right now. Please try again.' };
        }

        const historyOps = [];
        if (saveResult.newBoardCreated) {
            const createdBoard = await db.boards.get(saveResult.quickBoardId);
            if (createdBoard) {
                historyOps.push({
                    table: 'boards',
                    id: createdBoard.id,
                    before: null,
                    after: createdBoard
                });
            }
        }

        if (saveResult.shiftedBoardIds?.length) {
            const shiftedBoardAfterRows = (await db.boards.bulkGet(saveResult.shiftedBoardIds)).filter(Boolean);
            const shiftedBoardAfterById = new Map(shiftedBoardAfterRows.map(board => [board.id, board]));
            for (const beforeBoard of saveResult.shiftedBoardsBefore || []) {
                if (!beforeBoard?.id) continue;
                historyOps.push({
                    table: 'boards',
                    id: beforeBoard.id,
                    before: beforeBoard,
                    after: shiftedBoardAfterById.get(beforeBoard.id) || null
                });
            }
        }

        if (saveResult.createdBookmarkIds?.length) {
            const createdBookmarks = (await db.bookmarks.bulkGet(saveResult.createdBookmarkIds)).filter(Boolean);
            createdBookmarks.forEach((bookmark) => {
                historyOps.push({
                    table: 'bookmarks',
                    id: bookmark.id,
                    before: null,
                    after: bookmark
                });
            });
        }

        if (historyOps.length > 0) {
            await recordBackgroundHistoryEntry({
                kind: 'bookmark_save_all_tabs',
                label: saveResult.savedCount === 1 ? 'Save 1 tab' : `Save ${saveResult.savedCount} tabs`,
                ops: historyOps
            });
        }

        try {
            await trackReviewPromptManualBookmarks(storageData.lumilist_user?.id, saveResult.savedCount || 0);
        } catch (reviewTrackError) {
            console.warn('[ReviewPrompt] Failed to track save-all-tabs bookmark count:', reviewTrackError);
        }
        await showBadge('success');
        try {
            await refreshLumiListTabs();
        } catch (refreshError) {
            console.error('[SaveAllTabs] Failed to refresh tabs:', refreshError);
        }

        const closedCount = shouldCloseSavedTabs
            ? await closeTabsAfterSaveAll(saveableTabs.map((tab) => tab.id))
            : 0;

        const closeSuffix = closedCount > 0
            ? ` Closed ${closedCount} tab${closedCount === 1 ? '' : 's'}.`
            : '';
        return {
            success: true,
            message: `Saved ${saveResult.savedCount} tabs!${closeSuffix}`,
            savedCount: saveResult.savedCount,
            closedCount,
            pageName: pageName
        };

    } catch (error) {
        console.error('Save all tabs error:', error);
        await showBadge('error');
        return { success: false, message: 'Failed to save: ' + error.message };
    } finally {
        // FIX [Critical #1]: Always release mutex, even on error or early return
        _isSaveAllRunning = false;
    }
}

// Shared hostname safety check for extension-side network fetches
