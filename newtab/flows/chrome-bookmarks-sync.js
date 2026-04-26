/**
 * Chrome Bookmarks Auto-Sync Logic
 * Automatically organizes Chrome bookmarks into Pages and Boards.
 */

const ChromeBookmarksSync = (function() {
    let isSyncing = false;

    // Root folder IDs in Chrome
    const ROOT_FOLDERS = {
        BOOKMARKS_BAR: '1',
        OTHER_BOOKMARKS: '2',
        MOBILE_BOOKMARKS: '3'
    };

    const ROOT_NAMES = {
        [ROOT_FOLDERS.BOOKMARKS_BAR]: 'Bookmarks Bar',
        [ROOT_FOLDERS.OTHER_BOOKMARKS]: 'Other Bookmarks',
        [ROOT_FOLDERS.MOBILE_BOOKMARKS]: 'Mobile Bookmarks'
    };

    /**
     * Main entry point to sync Chrome bookmarks to the workspace
     */
    async function syncToWorkspace() {
        if (isSyncing) return;
        isSyncing = true;

        try {
            console.log('[ChromeSync] Starting auto-sync...');
            const tree = await new Promise(resolve => chrome.bookmarks.getTree(resolve));
            if (!tree || !tree[0]) return;

            const rootNodes = tree[0].children || [];
            
            let pageOrder = 0;
            for (const rootNode of rootNodes) {
                if (ROOT_NAMES[rootNode.id]) {
                    await syncRootFolder(rootNode, pageOrder++);
                }
            }
            
            console.log('[ChromeSync] Auto-sync complete.');
            // Refresh the navigation and current page
            if (typeof loadPagesNavigation === 'function') {
                await loadPagesNavigation();
            }
            if (typeof loadBoardsFromDatabase === 'function') {
                await loadBoardsFromDatabase();
            }
        } catch (error) {
            console.error('[ChromeSync] Sync failed:', error);
        } finally {
            isSyncing = false;
        }
    }

    /**
     * Syncs a root folder (e.g., Bookmarks Bar) to a Page
     */
    async function syncRootFolder(rootNode, order) {
        const pageName = ROOT_NAMES[rootNode.id];
        
        // 1. Find or create the page
        let page = await db.pages
            .filter(p => p.name === pageName && !p.deletedAt)
            .first();
            
        let pageId;
        if (!page) {
            console.log(`[ChromeSync] Creating page: ${pageName}`);
            pageId = await addPage({
                name: pageName,
                order: order,
                isDefault: false
            }, { skipHistory: true });
        } else {
            pageId = page.id;
            // Update order if needed to keep them at the beginning
            if (page.order !== order) {
                await db.pages.update(pageId, { order: order });
            }
        }

        if (!pageId) return;

        // 2. Process children of the root folder
        const children = rootNode.children || [];
        
        // Group bookmarks directly in the root folder into a "General" board
        const directBookmarks = children.filter(node => node.url);
        if (directBookmarks.length > 0) {
            await syncToBoard(pageId, pageName, directBookmarks, 0);
        }

        // Folders become separate boards
        const subFolders = children.filter(node => !node.url && node.children);
        let boardOrder = directBookmarks.length > 0 ? 1 : 0;
        for (const folder of subFolders) {
            await syncToBoard(pageId, folder.title || 'Untitled Folder', folder.children || [], boardOrder++);
        }
    }

    /**
     * Syncs a list of Chrome bookmark nodes to a Board on a specific Page
     */
    async function syncToBoard(pageId, boardName, bookmarkNodes, order) {
        // 1. Find or create the board
        let board = await db.boards
            .filter(b => b.pageId === pageId && b.name === boardName && !b.deletedAt)
            .first();
            
        let boardId;
        if (!board) {
            console.log(`[ChromeSync] Creating board: ${boardName} on page ${pageId}`);
            boardId = await addBoard({
                name: boardName,
                pageId: pageId,
                columnIndex: getNextColumnIndex(pageId, order),
                order: order
            }, { skipHistory: true });
        } else {
            boardId = board.id;
            // Update order and column index if needed
            const targetColumn = getNextColumnIndex(pageId, order);
            if (board.order !== order || board.columnIndex !== targetColumn) {
                await db.boards.update(boardId, { order, columnIndex: targetColumn });
            }
        }

        if (!boardId) return;

        // 2. Sync bookmarks to this board
        const existingBookmarks = await db.bookmarks
            .where('boardId').equals(boardId)
            .filter(b => !b.deletedAt)
            .toArray();
            
        const existingUrls = new Set(existingBookmarks.map(b => b.url));

        for (let i = 0; i < bookmarkNodes.length; i++) {
            const node = bookmarkNodes[i];
            if (node.url && !existingUrls.has(node.url)) {
                await addBookmark({
                    boardId: boardId,
                    title: node.title || 'Untitled',
                    url: node.url,
                    order: i
                }, { skipHistory: true });
            }
        }
    }

    function getNextColumnIndex(pageId, order) {
        // Simple distribution across 4 columns based on order
        return order % 4;
    }

    return {
        syncToWorkspace
    };
})();

// Export to global scope if needed
window.ChromeBookmarksSync = ChromeBookmarksSync;
