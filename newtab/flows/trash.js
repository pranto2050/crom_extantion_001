// Soft-delete item (move to trash)
// IMPORTANT (UI-FIRST CONTRACT):
// - This function ONLY performs local DB updates and queues sync operations.
// - It DOES NOT broadcast UI changes on purpose.
// - The caller must refresh the visible UI after the local mutation.
// - Queued mutations schedule background sync automatically.
// - Rationale: waiting on network here blocks the visible delete action and makes
//   pages appear to linger before disappearing.
function getTrashMissingItemError() {
    return 'This item no longer exists. Refresh and try again.';
}

function getTrashAlreadyDeletedError() {
    return 'This item is already in trash. Refresh and try again.';
}

function getTrashNotDeletedError() {
    return 'This item is no longer in trash. Refresh and try again.';
}

function uniqueTrashIds(ids = []) {
    return [...new Set((ids || []).filter(Boolean))];
}

function buildDeleteSyncItems({ bookmarkIds = [], boardIds = [], pageIds = [] } = {}) {
    const items = [];
    uniqueTrashIds(bookmarkIds).forEach((bookmarkId) => {
        items.push({ op: 'delete', table: 'bookmarks', id: bookmarkId, data: null });
    });
    uniqueTrashIds(boardIds).forEach((boardId) => {
        items.push({ op: 'delete', table: 'boards', id: boardId, data: null });
    });
    uniqueTrashIds(pageIds).forEach((pageId) => {
        items.push({ op: 'delete', table: 'pages', id: pageId, data: null });
    });
    return items;
}

function wasDeletedAtOrAfterParent(childDeletedAt, parentDeletedAt) {
    if (!childDeletedAt || !parentDeletedAt) return false;
    const childDeletedTime = new Date(childDeletedAt).getTime();
    const parentDeletedTime = new Date(parentDeletedAt).getTime();
    if (!Number.isFinite(childDeletedTime) || !Number.isFinite(parentDeletedTime)) {
        return false;
    }
    return childDeletedTime >= parentDeletedTime;
}

async function moveToTrash(itemType, itemId) {
    // Check subscription status before modifying data
    if (typeof canModify === 'function' && !canModify()) {
        return { success: false, error: 'Subscription required to delete items' };
    }

    const now = getCurrentTimestamp();

    try {
        // Track items to queue for sync (captured during transaction, queued after)
        const itemsToSync = [];
        const rollbackOps = [];

        if (itemType === 'page') {
            // SAFETY CHECK: Prevent deleting the last page
            if (await isLastActivePage(itemId)) {
                console.warn('Cannot delete the last page');
                return {
                    success: false,
                    error: 'Cannot delete the last page. You must have at least one page.'
                };
            }

            const pageBefore = await db.pages.get(itemId);
            if (!pageBefore) {
                return { success: false, error: getTrashMissingItemError() };
            }
            if (pageBefore.deletedAt) {
                return { success: false, error: getTrashAlreadyDeletedError() };
            }
            const childBoardsBefore = await db.boards.where('pageId').equals(itemId).filter(b => !b.deletedAt).toArray();
            const childBoardIds = childBoardsBefore.map(board => board.id);
            const childBookmarksBefore = childBoardIds.length > 0
                ? await db.bookmarks.where('boardId').anyOf(childBoardIds).filter(b => !b.deletedAt).toArray()
                : [];
            const boardBeforeById = createUndoRedoSnapshotMap(childBoardsBefore);
            const bookmarkBeforeById = createUndoRedoSnapshotMap(childBookmarksBefore);

            // FIX [Issue #3]: Atomic transaction for all cascade soft-delete operations
            await db.transaction('rw', [db.pages, db.boards, db.bookmarks], async () => {
                // Soft-delete the page
                await db.pages.update(itemId, {
                    deletedAt: now,
                    updatedAt: now
                });

                // FIX [Issue #8]: Cascade soft-delete to child boards (and their bookmarks)
                // Without this, child boards become orphaned when page is trashed
                const childBoards = await db.boards.where('pageId').equals(itemId).filter(b => !b.deletedAt).toArray();
                for (const board of childBoards) {
                    await db.boards.update(board.id, {
                        deletedAt: now,
                        updatedAt: now
                    });

                    // Also cascade to bookmarks in this board
                    const childBookmarks = await db.bookmarks.where('boardId').equals(board.id).filter(b => !b.deletedAt).toArray();
                    for (const bookmark of childBookmarks) {
                        await db.bookmarks.update(bookmark.id, {
                            deletedAt: now,
                            updatedAt: now
                        });
                    }
                }
            });

            if (pageBefore) {
                const pageAfter = await db.pages.get(itemId);
                const childBoardsAfter = childBoardIds.length > 0 ? (await db.boards.bulkGet(childBoardIds)).filter(Boolean) : [];
                const childBookmarksAfter = childBookmarksBefore.length > 0
                    ? (await db.bookmarks.bulkGet(childBookmarksBefore.map(bookmark => bookmark.id))).filter(Boolean)
                    : [];
                const boardAfterById = createUndoRedoSnapshotMap(childBoardsAfter);
                const bookmarkAfterById = createUndoRedoSnapshotMap(childBookmarksAfter);
                rollbackOps.push(
                    { table: 'pages', id: itemId, before: pageBefore, after: pageAfter || null },
                    ...buildUndoRedoOpsFromSnapshotMaps('boards', boardBeforeById, boardAfterById),
                    ...buildUndoRedoOpsFromSnapshotMaps('bookmarks', bookmarkBeforeById, bookmarkAfterById)
                );
            }

            // Queue items for sync (outside transaction to avoid blocking)
            const page = await db.pages.get(itemId);
            if (page) itemsToSync.push({ op: 'upsert', table: 'pages', id: itemId, data: page });

            const childBoards = await db.boards.where('pageId').equals(itemId).filter(b => b.deletedAt === now).toArray();
            for (const board of childBoards) {
                itemsToSync.push({ op: 'upsert', table: 'boards', id: board.id, data: board });
                const childBookmarks = await db.bookmarks.where('boardId').equals(board.id).filter(b => b.deletedAt === now).toArray();
                removeBookmarkIdsFromSelection(childBookmarks.map(bookmark => bookmark.id));
                for (const bookmark of childBookmarks) {
                    itemsToSync.push({ op: 'upsert', table: 'bookmarks', id: bookmark.id, data: bookmark });
                }
            }


        } else if (itemType === 'board') {
            const boardBefore = await db.boards.get(itemId);
            if (!boardBefore) {
                return { success: false, error: getTrashMissingItemError() };
            }
            if (boardBefore.deletedAt) {
                return { success: false, error: getTrashAlreadyDeletedError() };
            }
            const boardBookmarksBefore = await db.bookmarks.where('boardId').equals(itemId).filter(b => !b.deletedAt).toArray();
            const boardBookmarksBeforeById = createUndoRedoSnapshotMap(boardBookmarksBefore);

            // FIX [Issue #3]: Atomic transaction for board + bookmarks soft-delete
            await db.transaction('rw', [db.boards, db.bookmarks], async () => {
                // CASCADE: Soft-delete all bookmarks in this board first
                const boardBookmarks = await db.bookmarks.where('boardId').equals(itemId).filter(b => !b.deletedAt).toArray();
                for (const bm of boardBookmarks) {
                    await db.bookmarks.update(bm.id, { deletedAt: now, updatedAt: now });
                }
                if (boardBookmarks.length > 0) {

                }

                // Soft-delete the board
                await db.boards.update(itemId, {
                    deletedAt: now,
                    updatedAt: now
                });
            });

            if (boardBefore) {
                const boardAfter = await db.boards.get(itemId);
                const boardBookmarksAfter = boardBookmarksBefore.length > 0
                    ? (await db.bookmarks.bulkGet(boardBookmarksBefore.map(bookmark => bookmark.id))).filter(Boolean)
                    : [];
                const boardBookmarksAfterById = createUndoRedoSnapshotMap(boardBookmarksAfter);
                rollbackOps.push(
                    { table: 'boards', id: itemId, before: boardBefore, after: boardAfter || null },
                    ...buildUndoRedoOpsFromSnapshotMaps('bookmarks', boardBookmarksBeforeById, boardBookmarksAfterById)
                );
            }

            // Queue items for sync (outside transaction)
            const board = await db.boards.get(itemId);
            if (board) itemsToSync.push({ op: 'upsert', table: 'boards', id: itemId, data: board });
            const boardBookmarks = await db.bookmarks.where('boardId').equals(itemId).filter(b => b.deletedAt === now).toArray();
            removeBookmarkIdsFromSelection(boardBookmarks.map(bookmark => bookmark.id));
            for (const bm of boardBookmarks) {
                itemsToSync.push({ op: 'upsert', table: 'bookmarks', id: bm.id, data: bm });
            }

        } else if (itemType === 'bookmark') {
            const bookmarkBefore = await db.bookmarks.get(itemId);
            if (!bookmarkBefore) {
                return { success: false, error: getTrashMissingItemError() };
            }
            if (bookmarkBefore.deletedAt) {
                return { success: false, error: getTrashAlreadyDeletedError() };
            }
            await db.bookmarks.update(itemId, {
                deletedAt: now,
                updatedAt: now
            });
            // Queue to background sync
            const bookmark = await db.bookmarks.get(itemId);
            if (bookmark) itemsToSync.push({ op: 'upsert', table: 'bookmarks', id: itemId, data: bookmark });
            // Keep selection state consistent after single-bookmark trash.
            removeBookmarkIdsFromSelection([itemId]);

            if (bookmarkBefore) {
                rollbackOps.push({
                    table: 'bookmarks',
                    id: itemId,
                    before: bookmarkBefore,
                    after: bookmark || null
                });
            }
        }

        const queueAttempt = await queueSyncItemsAtomically(itemsToSync, {
            contextLabel: `moveToTrash:${itemType}`
        });
        if (!queueAttempt.success) {
            await rollbackLocalMutationOps(rollbackOps);
            return {
                success: false,
                error: queueAttempt.error || 'Failed to move this item to trash. Please try again.'
            };
        }

        if (!isApplyingUndoRedoHistory && rollbackOps.length > 0) {
            const label = itemType === 'page'
                ? 'Move page to trash'
                : itemType === 'board'
                    ? 'Move board to trash'
                    : 'Move bookmark to trash';
            await recordUndoRedoHistoryEntry({
                kind: `${itemType}_trash`,
                label,
                ops: rollbackOps
            });
        }

        return { success: true };
    } catch (error) {
        console.error(`Failed to trash ${itemType}:`, error);
        return { success: false, error: error.message };
    }
}

// Restore item from trash
// FIX [H15]: Wrap order shifting in transaction to prevent inconsistent state
// FIX [Issue #3]: Wrap cascade restore operations in transaction
async function restoreFromTrash(itemType, itemId) {
    // Check subscription status before modifying data
    if (typeof canModify === 'function' && !canModify()) {
        return { success: false, error: 'Subscription required to restore items' };
    }

    const now = getCurrentTimestamp();

    try {
        // Track items to queue for sync (captured during transaction, queued after)
        const itemsToSync = [];
        const rollbackOps = [];

        if (itemType === 'page') {
            // Get the page's deletedAt timestamp BEFORE restoring (for cascade restore)
            const pageToRestore = await db.pages.get(itemId);
            if (!pageToRestore) {
                return { success: false, error: getTrashMissingItemError() };
            }
            const pageDeletedAt = pageToRestore?.deletedAt;
            if (!pageDeletedAt) {
                return { success: false, error: getTrashNotDeletedError() };
            }
            const pageBefore = pageToRestore ? cloneUndoRedoSnapshot(pageToRestore) : null;
            let orphanedBoardsBefore = [];
            let orphanedBookmarksBefore = [];

            if (pageDeletedAt) {
                orphanedBoardsBefore = await db.boards
                    .where('pageId').equals(itemId)
                    .filter(b => wasDeletedAtOrAfterParent(b.deletedAt, pageDeletedAt))
                    .toArray();
                const orphanedBoardIdsBefore = orphanedBoardsBefore.map(board => board.id);
                orphanedBookmarksBefore = orphanedBoardIdsBefore.length > 0
                    ? await db.bookmarks
                        .where('boardId')
                        .anyOf(orphanedBoardIdsBefore)
                        .filter(bm => wasDeletedAtOrAfterParent(bm.deletedAt, pageDeletedAt))
                        .toArray()
                    : [];
            }
            const orphanedBoardsBeforeById = createUndoRedoSnapshotMap(orphanedBoardsBefore);
            const orphanedBookmarksBeforeById = createUndoRedoSnapshotMap(orphanedBookmarksBefore);

            // Track boards and bookmarks to restore (for sync queue after transaction)
            let orphanedBoardIds = [];
            let orphanedBookmarkIds = [];

            // FIX [Issue #3]: Atomic transaction for page + cascade restore
            await db.transaction('rw', [db.pages, db.boards, db.bookmarks], async () => {
                // Restore the page
                await db.pages.update(itemId, {
                    deletedAt: null,
                    updatedAt: now
                });

                // CASCADE RESTORE: Restore boards (and their bookmarks) that were deleted at the same time
                // FIX [Issue #2]: Only restore items deleted AT or AFTER the parent (not before)
                // Items deleted before the parent were manually deleted and should stay in trash
                if (pageDeletedAt) {
                    const orphanedBoards = await db.boards
                        .where('pageId').equals(itemId)
                        .filter(b => wasDeletedAtOrAfterParent(b.deletedAt, pageDeletedAt))
                        .toArray();

                    for (const board of orphanedBoards) {
                        // Restore board
                        await db.boards.update(board.id, {
                            deletedAt: null,
                            updatedAt: now
                        });
                        orphanedBoardIds.push(board.id);

                        // Restore bookmarks in this board (deleted at or after the page deletion)
                        const orphanedBookmarks = await db.bookmarks
                            .where('boardId').equals(board.id)
                            .filter(bm => wasDeletedAtOrAfterParent(bm.deletedAt, pageDeletedAt))
                            .toArray();

                        for (const bookmark of orphanedBookmarks) {
                            await db.bookmarks.update(bookmark.id, {
                                deletedAt: null,
                                updatedAt: now
                            });
                            orphanedBookmarkIds.push(bookmark.id);
                        }
                    }
                }
            });

            // Queue items for sync (outside transaction)
            const page = await db.pages.get(itemId);
            if (page) itemsToSync.push({ op: 'upsert', table: 'pages', id: itemId, data: page });

            for (const boardId of orphanedBoardIds) {
                const restoredBoard = await db.boards.get(boardId);
                if (restoredBoard) itemsToSync.push({ op: 'upsert', table: 'boards', id: boardId, data: restoredBoard });
            }

            for (const bookmarkId of orphanedBookmarkIds) {
                const restoredBookmark = await db.bookmarks.get(bookmarkId);
                if (restoredBookmark) itemsToSync.push({ op: 'upsert', table: 'bookmarks', id: bookmarkId, data: restoredBookmark });
            }

            if (pageBefore) {
                const pageAfter = await db.pages.get(itemId);
                const orphanedBoardsAfter = orphanedBoardIds.length > 0
                    ? (await db.boards.bulkGet(orphanedBoardIds)).filter(Boolean)
                    : [];
                const orphanedBookmarksAfter = orphanedBookmarkIds.length > 0
                    ? (await db.bookmarks.bulkGet(orphanedBookmarkIds)).filter(Boolean)
                    : [];
                const orphanedBoardsAfterById = createUndoRedoSnapshotMap(orphanedBoardsAfter);
                const orphanedBookmarksAfterById = createUndoRedoSnapshotMap(orphanedBookmarksAfter);
                rollbackOps.push(
                    { table: 'pages', id: itemId, before: pageBefore, after: pageAfter || null },
                    ...buildUndoRedoOpsFromSnapshotMaps('boards', orphanedBoardsBeforeById, orphanedBoardsAfterById),
                    ...buildUndoRedoOpsFromSnapshotMaps('bookmarks', orphanedBookmarksBeforeById, orphanedBookmarksAfterById)
                );
            }



        } else if (itemType === 'board') {
            // Check if parent page exists and is not deleted
            const board = await db.boards.get(itemId);
            if (!board) {
                return { success: false, error: getTrashMissingItemError() };
            }
            // Capture deletedAt BEFORE restoring (for cascade restore)
            const boardDeletedAt = board?.deletedAt;
            if (!boardDeletedAt) {
                return { success: false, error: getTrashNotDeletedError() };
            }
            const boardBefore = board ? cloneUndoRedoSnapshot(board) : null;

            if (board) {
                const parentPage = await db.pages.get(board.pageId);
                if (!parentPage) {
                    return {
                        success: false,
                        error: 'Parent page was permanently deleted. This board cannot be restored.'
                    };
                }
                if (parentPage.deletedAt) {
                    return {
                        success: false,
                        error: 'Parent page is in trash. Restore the page first.'
                    };
                }

                // Get boards that need order shifting
                const activeBoardsInColumn = await db.boards
                    .where('pageId').equals(board.pageId)
                    .filter(b => !b.deletedAt && b.columnIndex === board.columnIndex)
                    .toArray();
                const parsedBoardOrder = Number(board.order);
                const boardRestoreOrder = Number.isFinite(parsedBoardOrder)
                    ? Math.max(0, parsedBoardOrder)
                    : activeBoardsInColumn.length;
                const existingBoards = activeBoardsInColumn.filter(b => {
                    const order = Number(b.order);
                    return Number.isFinite(order) && order >= boardRestoreOrder;
                });
                const existingBoardsBeforeById = createUndoRedoSnapshotMap(existingBoards);
                const orphanedBookmarksBefore = boardDeletedAt
                    ? await db.bookmarks
                        .where('boardId').equals(itemId)
                        .filter(b => wasDeletedAtOrAfterParent(b.deletedAt, boardDeletedAt))
                        .toArray()
                    : [];
                const orphanedBookmarksBeforeById = createUndoRedoSnapshotMap(orphanedBookmarksBefore);

                // Track bookmark IDs for cascade restore (for sync queue after transaction)
                let orphanedBookmarkIds = [];

                // FIX [H15]: Atomic transaction for order shifting + restore + cascade
                // FIX [Issue #3]: Include cascade bookmark restore in same transaction
                await db.transaction('rw', [db.boards, db.bookmarks], async () => {
                    // Shift existing boards down
                    for (const b of existingBoards) {
                        await db.boards.update(b.id, {
                            order: b.order + 1,
                            updatedAt: now
                        });
                    }
                    // Restore the board
                    await db.boards.update(itemId, {
                        order: boardRestoreOrder,
                        deletedAt: null,
                        updatedAt: now
                    });

                    // CASCADE RESTORE: Restore bookmarks that were deleted at or after the board
                    // FIX [Issue #2]: Only restore items deleted AT or AFTER parent (not before)
                    // Items deleted before the parent were manually deleted and should stay in trash
                    if (boardDeletedAt) {
                        const orphanedBookmarks = await db.bookmarks
                            .where('boardId').equals(itemId)
                            .filter(b => wasDeletedAtOrAfterParent(b.deletedAt, boardDeletedAt))
                            .toArray();

                        for (const bookmark of orphanedBookmarks) {
                            await db.bookmarks.update(bookmark.id, {
                                deletedAt: null,
                                updatedAt: now
                            });
                            orphanedBookmarkIds.push(bookmark.id);
                        }
                    }
                });

                // Queue shifted boards for sync (outside transaction)
                for (const b of existingBoards) {
                    const shiftedBoard = await db.boards.get(b.id);
                    if (shiftedBoard) itemsToSync.push({ op: 'upsert', table: 'boards', id: b.id, data: shiftedBoard });
                }

                // Queue restored board for sync
                const restoredBoard = await db.boards.get(itemId);
                if (restoredBoard) itemsToSync.push({ op: 'upsert', table: 'boards', id: itemId, data: restoredBoard });

                // Queue cascade-restored bookmarks for sync
                for (const bookmarkId of orphanedBookmarkIds) {
                    const restoredBookmark = await db.bookmarks.get(bookmarkId);
                    if (restoredBookmark) itemsToSync.push({ op: 'upsert', table: 'bookmarks', id: bookmarkId, data: restoredBookmark });
                }

                if (boardBefore) {
                    const shiftedBoardIds = existingBoards.map(b => b.id);
                    const shiftedBoardsAfter = shiftedBoardIds.length > 0
                        ? (await db.boards.bulkGet(shiftedBoardIds)).filter(Boolean)
                        : [];
                    const restoredBoardAfter = await db.boards.get(itemId);
                    const orphanedBookmarksAfter = orphanedBookmarkIds.length > 0
                        ? (await db.bookmarks.bulkGet(orphanedBookmarkIds)).filter(Boolean)
                        : [];
                    const shiftedBoardsAfterById = createUndoRedoSnapshotMap(shiftedBoardsAfter);
                    const orphanedBookmarksAfterById = createUndoRedoSnapshotMap(orphanedBookmarksAfter);
                    rollbackOps.push(
                        ...buildUndoRedoOpsFromSnapshotMaps('boards', existingBoardsBeforeById, shiftedBoardsAfterById),
                        { table: 'boards', id: itemId, before: boardBefore, after: restoredBoardAfter || null },
                        ...buildUndoRedoOpsFromSnapshotMaps('bookmarks', orphanedBookmarksBeforeById, orphanedBookmarksAfterById)
                    );
                }

            }

        } else if (itemType === 'bookmark') {
            // Check if parent board exists and is not deleted
            const bookmark = await db.bookmarks.get(itemId);
            if (!bookmark) {
                return { success: false, error: getTrashMissingItemError() };
            }
            if (!bookmark.deletedAt) {
                return { success: false, error: getTrashNotDeletedError() };
            }
            const bookmarkBefore = bookmark ? cloneUndoRedoSnapshot(bookmark) : null;
            let shiftedBookmarksBeforeById = new Map();
            let shiftedBookmarkIds = [];
            let restoreOrder = 0;
            if (bookmark) {
                const parentBoard = await db.boards.get(bookmark.boardId);
                if (!parentBoard) {
                    return {
                        success: false,
                        error: 'Parent board was permanently deleted. This bookmark cannot be restored.'
                    };
                }
                if (parentBoard.deletedAt) {
                    return {
                        success: false,
                        error: 'Parent board is in trash. Restore the board first.'
                    };
                }

                // FIX [Phase 8C]: Check if same URL already exists in this board (active, non-deleted)
                // Prevents duplicates when user adds same URL while original was in trash
                const normalizedUrl = normalizeUrlForDedup(bookmark.url);
                const existingByUrl = await db.bookmarks
                    .filter(b =>
                        !b.deletedAt &&
                        b.id !== itemId &&  // Exclude self
                        b.boardId === bookmark.boardId
                    )
                    .toArray();

                const duplicate = existingByUrl.find(b =>
                    normalizeUrlForDedup(b.url) === normalizedUrl
                );

                if (duplicate) {
                    return {
                        success: false,
                        error: 'This URL already exists in this board. Delete the duplicate first or leave this in trash.'
                    };
                }

                const activeBookmarksInBoard = await db.bookmarks
                    .where('boardId')
                    .equals(bookmark.boardId)
                    .filter(b => !b.deletedAt && b.id !== itemId)
                    .toArray();
                const parsedBookmarkOrder = Number(bookmark.order);
                restoreOrder = Number.isFinite(parsedBookmarkOrder)
                    ? Math.max(0, parsedBookmarkOrder)
                    : activeBookmarksInBoard.length;

                const bookmarksToShift = activeBookmarksInBoard.filter(b => {
                    const order = Number(b.order);
                    return Number.isFinite(order) && order >= restoreOrder;
                });
                shiftedBookmarksBeforeById = createUndoRedoSnapshotMap(bookmarksToShift);
                shiftedBookmarkIds = bookmarksToShift.map(b => b.id);

                await db.transaction('rw', db.bookmarks, async () => {
                    for (const b of bookmarksToShift) {
                        await db.bookmarks.update(b.id, {
                            order: Number(b.order) + 1,
                            updatedAt: now
                        });
                    }

                    await db.bookmarks.update(itemId, {
                        deletedAt: null,
                        order: restoreOrder,
                        updatedAt: now
                    });
                });
            }

            for (const shiftedId of shiftedBookmarkIds) {
                const shiftedBookmark = await db.bookmarks.get(shiftedId);
                if (shiftedBookmark) {
                    itemsToSync.push({ op: 'upsert', table: 'bookmarks', id: shiftedId, data: shiftedBookmark });
                }
            }

            // Queue for sync
            const restoredBookmark = await db.bookmarks.get(itemId);
            if (restoredBookmark) itemsToSync.push({ op: 'upsert', table: 'bookmarks', id: itemId, data: restoredBookmark });
            if (bookmarkBefore) {
                const shiftedBookmarksAfter = shiftedBookmarkIds.length > 0
                    ? (await db.bookmarks.bulkGet(shiftedBookmarkIds)).filter(Boolean)
                    : [];
                const shiftedBookmarksAfterById = createUndoRedoSnapshotMap(shiftedBookmarksAfter);
                rollbackOps.push(
                    ...buildUndoRedoOpsFromSnapshotMaps('bookmarks', shiftedBookmarksBeforeById, shiftedBookmarksAfterById)
                );
                rollbackOps.push({
                    table: 'bookmarks',
                    id: itemId,
                    before: bookmarkBefore,
                    after: restoredBookmark || null
                });
            }
        }

        const queueAttempt = await queueSyncItemsAtomically(itemsToSync, {
            contextLabel: `restoreFromTrash:${itemType}`
        });
        if (!queueAttempt.success) {
            await rollbackLocalMutationOps(rollbackOps);
            return {
                success: false,
                error: queueAttempt.error || 'Failed to restore this item. Please try again.'
            };
        }

        if (!isApplyingUndoRedoHistory && rollbackOps.length > 0) {
            const label = itemType === 'page'
                ? 'Restore page from trash'
                : itemType === 'board'
                    ? 'Restore board from trash'
                    : 'Restore bookmark from trash';
            await recordUndoRedoHistoryEntry({
                kind: `${itemType}_restore`,
                label,
                ops: rollbackOps
            });
        }

        return { success: true };
    } catch (error) {
        console.error(`Failed to restore ${itemType}:`, error);
        return { success: false, error: error.message };
    }
}

// Permanently delete item (hard delete with cascade)
// FIX [C7]: Wrap database operations in transaction to prevent orphaned records on crash
// IMPORTANT (UI-FIRST CONTRACT):
// - This function ONLY performs local DB deletes and queues sync operations.
// - It DOES NOT broadcast UI changes on purpose.
// - The caller must refresh the visible UI after the local mutation.
// - Queued mutations schedule background sync automatically.
// - Rationale: waiting on network here blocks the trash UI and leaves "ghost" items visible.
// - If you add a new call site, ensure it refreshes the UI immediately after the local delete.
async function permanentlyDelete(itemType, itemId) {
    // Block permanent deletion in read-only mode
    if (!canModify()) return { success: false, error: 'Read-only mode' };

    const parsedId = itemId;

    // Track IDs for sync queue (captured before deletion)
    let deletedBookmarkIds = [];
    let deletedBoardIds = [];
    let deletedPageIds = [];
    const sharesToStop = [];

    try {
        if (itemType === 'page') {
            const page = await db.pages.get(parsedId);
            if (!page) {
                return { success: false, error: getTrashMissingItemError() };
            }
            if (!page.deletedAt) {
                return { success: false, error: getTrashNotDeletedError() };
            }

            // SAFETY CHECK: Ensure at least one active page exists
            // If no active pages exist, don't allow deleting trashed pages
            const activePageCount = await db.pages.filter(p => !p.deletedAt).count();
            if (activePageCount === 0) {
                console.warn('Cannot permanently delete - no active pages exist');
                return {
                    success: false,
                    error: 'Cannot delete this page. Restore a page first, or this is your only remaining page.'
                };
            }

            const boards = await db.boards.where('pageId').equals(parsedId).toArray();

            deletedBoardIds = boards.map(b => b.id);
            for (const board of boards) {
                const boardBookmarks = await db.bookmarks.where('boardId').equals(board.id).toArray();
                deletedBookmarkIds.push(...boardBookmarks.map(bookmark => bookmark.id));
            }
            deletedPageIds = [parsedId];

            if (page?.shareId) {
                sharesToStop.push({ type: 'page', id: parsedId });
            }
            for (const board of boards) {
                if (board.shareId) {
                    sharesToStop.push({ type: 'board', id: board.id });
                }
            }

            const queueAttempt = await queueSyncItemsAtomically(buildDeleteSyncItems({
                bookmarkIds: deletedBookmarkIds,
                boardIds: deletedBoardIds,
                pageIds: deletedPageIds
            }), {
                contextLabel: `permanentlyDelete:${itemType}`,
                ensureBootstrapPages: false
            });
            if (!queueAttempt.success) {
                return {
                    success: false,
                    error: queueAttempt.error || 'Failed to permanently delete this item. Please try again.'
                };
            }

            for (const share of sharesToStop) {
                try {
                    await stopShare(share.type, share.id, { skipLocalUpdate: true });
                } catch (e) {
                    console.warn(`Failed to stop ${share.type} share:`, e);
                }
            }

            await db.transaction('rw', [db.pages, db.boards, db.bookmarks], async () => {
                const boardIds = boards.map(b => b.id);
                for (const boardId of boardIds) {
                    await db.bookmarks.where('boardId').equals(boardId).delete();
                }
                await db.boards.where('pageId').equals(parsedId).delete();
                await db.pages.delete(parsedId);
            });

        } else if (itemType === 'board') {
            const board = await db.boards.get(parsedId);
            if (!board) {
                return { success: false, error: getTrashMissingItemError() };
            }
            if (!board.deletedAt) {
                return { success: false, error: getTrashNotDeletedError() };
            }
            if (board?.shareId) {
                sharesToStop.push({ type: 'board', id: parsedId });
            }

            const boardBookmarks = await db.bookmarks.where('boardId').equals(parsedId).toArray();
            deletedBookmarkIds = boardBookmarks.map(bookmark => bookmark.id);
            deletedBoardIds = [parsedId];

            const queueAttempt = await queueSyncItemsAtomically(buildDeleteSyncItems({
                bookmarkIds: deletedBookmarkIds,
                boardIds: deletedBoardIds
            }), {
                contextLabel: `permanentlyDelete:${itemType}`,
                ensureBootstrapPages: false
            });
            if (!queueAttempt.success) {
                return {
                    success: false,
                    error: queueAttempt.error || 'Failed to permanently delete this item. Please try again.'
                };
            }

            for (const share of sharesToStop) {
                try {
                    await stopShare(share.type, share.id, { skipLocalUpdate: true });
                } catch (e) {
                    console.warn(`Failed to stop ${share.type} share:`, e);
                }
            }

            await db.transaction('rw', [db.boards, db.bookmarks], async () => {
                await db.bookmarks.where('boardId').equals(parsedId).delete();
                await db.boards.delete(parsedId);
            });

        } else if (itemType === 'bookmark') {
            const bookmark = await db.bookmarks.get(parsedId);
            if (!bookmark) {
                return { success: false, error: getTrashMissingItemError() };
            }
            if (!bookmark.deletedAt) {
                return { success: false, error: getTrashNotDeletedError() };
            }
            deletedBookmarkIds = [parsedId];

            const queueAttempt = await queueSyncItemsAtomically(buildDeleteSyncItems({
                bookmarkIds: deletedBookmarkIds
            }), {
                contextLabel: `permanentlyDelete:${itemType}`,
                ensureBootstrapPages: false
            });
            if (!queueAttempt.success) {
                return {
                    success: false,
                    error: queueAttempt.error || 'Failed to permanently delete this item. Please try again.'
                };
            }

            await db.bookmarks.delete(parsedId);
        }

        // Update count caches (cascade deletes + direct deletes)
        const uniqueDeletedBookmarkIds = uniqueTrashIds(deletedBookmarkIds);
        const totalBookmarksDeleted = uniqueDeletedBookmarkIds.length;
        if (totalBookmarksDeleted > 0) {
            bookmarkCount = Math.max(0, bookmarkCount - totalBookmarksDeleted);

        }

        // Update board count cache
        const uniqueDeletedBoardIds = uniqueTrashIds(deletedBoardIds);
        const totalBoardsDeleted = uniqueDeletedBoardIds.length;
        if (totalBoardsDeleted > 0) {
            boardCount = Math.max(0, boardCount - totalBoardsDeleted);

        }

        // Remove permanently deleted boards from expanded-state cache.
        if (itemType === 'board') {
            collapseBoardBookmarks(parsedId);
        }
        for (const boardId of uniqueDeletedBoardIds) {
            collapseBoardBookmarks(boardId);
        }
        if (totalBoardsDeleted > 0) {
            await saveExpandedBoardIdsToStorage();
        }

        // Update page count cache
        if (deletedPageIds.length > 0) {
            pageCount = Math.max(0, pageCount - deletedPageIds.length);
        }

        const deletedEntityKeys = new Set();
        for (const bookmarkId of uniqueDeletedBookmarkIds) {
            deletedEntityKeys.add(buildUndoRedoEntityKey('bookmarks', bookmarkId));
        }
        for (const boardId of uniqueDeletedBoardIds) {
            deletedEntityKeys.add(buildUndoRedoEntityKey('boards', boardId));
        }
        for (const pageId of deletedPageIds) {
            deletedEntityKeys.add(buildUndoRedoEntityKey('pages', pageId));
        }

        await pruneUndoRedoHistoryForEntityKeys(deletedEntityKeys);

        // Permanent deletes are intentionally non-undoable.
        await clearRedoTailAfterNonUndoableMutation();
        setUndoRedoBlockedReason('You cannot undo this.');

        return { success: true };
    } catch (error) {
        console.error(`Failed to permanently delete ${itemType}:`, error);
        return { success: false, error: error.message };
    }
}

// Helper: Check if deleting a page would leave zero pages
async function isLastActivePage(pageId) {
    const activePages = await db.pages.filter(p => !p.deletedAt).toArray();
    // If only one active page and it's the one being deleted, it's the last
    return activePages.length === 1 && activePages[0].id === pageId;
}

// Get all trashed items for trash modal
async function getTrashItems() {
    const trashedPages = await db.pages
        .filter(p => p.deletedAt !== null && p.deletedAt !== undefined)
        .toArray();

    const trashedBoards = await db.boards
        .filter(b => b.deletedAt !== null && b.deletedAt !== undefined)
        .toArray();

    const trashedBookmarks = await db.bookmarks
        .filter(b => b.deletedAt !== null && b.deletedAt !== undefined)
        .toArray();

    // Get sets of trashed parent IDs for quick lookup
    const trashedPageIds = new Set(trashedPages.map(p => p.id));
    const trashedBoardIds = new Set(trashedBoards.map(b => b.id));

    // Filter boards: exclude those whose parent page is also in trash
    // (they will cascade-restore with the page)
    const visibleBoards = trashedBoards.filter(board => !trashedPageIds.has(board.pageId));

    // Filter bookmarks: exclude those whose parent board is also in trash
    // (they will cascade-restore with the board)
    const visibleBookmarks = trashedBookmarks.filter(bookmark => !trashedBoardIds.has(bookmark.boardId));

    // Build context maps for restore destination metadata (page/board names)
    const bookmarkBoardIds = [...new Set(visibleBookmarks.map(b => b.boardId).filter(Boolean))];
    const bookmarkBoards = bookmarkBoardIds.length > 0
        ? (await db.boards.bulkGet(bookmarkBoardIds)).filter(Boolean)
        : [];
    const boardById = new Map(bookmarkBoards.map(board => [board.id, board]));

    const contextPageIds = new Set();
    visibleBoards.forEach(board => {
        if (board.pageId) contextPageIds.add(board.pageId);
    });
    bookmarkBoards.forEach(board => {
        if (board.pageId) contextPageIds.add(board.pageId);
    });

    const contextPages = contextPageIds.size > 0
        ? (await db.pages.bulkGet([...contextPageIds])).filter(Boolean)
        : [];
    const pageById = new Map(contextPages.map(page => [page.id, page]));

    const resolvePageName = (pageId) => {
        const pageName = pageById.get(pageId)?.name;
        return pageName && pageName.trim() ? pageName.trim() : 'Unknown page';
    };

    const resolveBoardName = (boardId) => {
        const boardName = boardById.get(boardId)?.name;
        return boardName && boardName.trim() ? boardName.trim() : 'Unknown board';
    };

    const visibleBoardsWithContext = visibleBoards.map(board => ({
        ...board,
        restoreContext: `Page: ${resolvePageName(board.pageId)}`
    }));

    const visibleBookmarksWithContext = visibleBookmarks.map(bookmark => {
        const parentBoard = boardById.get(bookmark.boardId);
        const pageName = parentBoard?.pageId ? resolvePageName(parentBoard.pageId) : 'Unknown page';
        return {
            ...bookmark,
            restoreContext: `Board: ${resolveBoardName(bookmark.boardId)} · Page: ${pageName}`
        };
    });

    // Sort by deletion date, newest first
    const sortByDeletedAt = (a, b) => new Date(b.deletedAt) - new Date(a.deletedAt);

    return {
        pages: trashedPages.sort(sortByDeletedAt),
        boards: visibleBoardsWithContext.sort(sortByDeletedAt),
        bookmarks: visibleBookmarksWithContext.sort(sortByDeletedAt)
    };
}

// Empty all trash (permanent delete everything)
// FIX [H17]: Wrap database operations in transaction to prevent partial deletes
// IMPORTANT (UI-FIRST CONTRACT):
// - This function ONLY performs local DB deletes and queues sync operations.
// - It DOES NOT broadcast UI changes on purpose.
// - The caller must refresh the visible UI after the local mutation.
// - Queued mutations schedule background sync automatically.
// - Rationale: waiting on network here blocks the trash modal and lets users interact
//   with items that are already deleted locally.
// - If you add a new call site, ensure it refreshes the UI immediately after the local delete.
async function emptyTrash() {
    // FIX [Issue #38]: Return proper result object in read-only mode to prevent TypeError
    if (!canModify()) {
        return { success: false, error: 'Cannot empty trash in read-only mode' };
    }

    try {
        const trashItems = await getTrashItems();

        // SAFETY CHECK: Check active page count before starting
        const activePageCount = await db.pages.filter(p => !p.deletedAt).count();

        // Determine which pages can be deleted (skip if no active pages would remain)
        const pagesToDelete = [];
        let pagesSkipped = 0;
        for (const page of trashItems.pages) {
            if (activePageCount === 0) {
                console.warn('Skipping page deletion in emptyTrash - no active pages exist');
                pagesSkipped++;
            } else {
                pagesToDelete.push(page);
            }
        }

        const boardsFromPages = [];
        for (const page of pagesToDelete) {
            const pageBoards = await db.boards.where('pageId').equals(page.id).toArray();
            boardsFromPages.push(...pageBoards);
        }
        const allBoardsToDelete = [...trashItems.boards, ...boardsFromPages];

        const bookmarkIdsToDelete = trashItems.bookmarks.map(b => b.id);
        const boardIdsToDelete = trashItems.boards.map(b => b.id);
        const pageIdsToDelete = pagesToDelete.map(p => p.id);

        // Also capture child IDs that will be cascade-deleted
        const childBookmarkIds = [];
        const childBoardIds = [];

        // Get bookmark IDs from trashed boards
        for (const board of trashItems.boards) {
            const bookmarks = await db.bookmarks.where('boardId').equals(board.id).toArray();
            childBookmarkIds.push(...bookmarks.map(b => b.id));
        }

        // Get board/bookmark IDs from trashed pages
        for (const page of pagesToDelete) {
            const boards = await db.boards.where('pageId').equals(page.id).toArray();
            childBoardIds.push(...boards.map(b => b.id));
            for (const board of boards) {
                const bookmarks = await db.bookmarks.where('boardId').equals(board.id).toArray();
                childBookmarkIds.push(...bookmarks.map(b => b.id));
            }
        }

        const allBookmarkIds = [...new Set([...bookmarkIdsToDelete, ...childBookmarkIds])];
        const allBoardIds = [...new Set([...boardIdsToDelete, ...childBoardIds])];

        const queueAttempt = await queueSyncItemsAtomically(buildDeleteSyncItems({
            bookmarkIds: allBookmarkIds,
            boardIds: allBoardIds,
            pageIds: pageIdsToDelete
        }), {
            contextLabel: 'emptyTrash',
            ensureBootstrapPages: false
        });
        if (!queueAttempt.success) {
            return {
                success: false,
                error: queueAttempt.error || 'Failed to permanently delete all trash items. Please try again.'
            };
        }

        for (const board of allBoardsToDelete) {
            if (board.shareId) {
                try {
                    await stopShare('board', board.id, { skipLocalUpdate: true });
                } catch (e) {
                    console.warn('Failed to stop board share:', e);
                }
            }
        }
        for (const page of pagesToDelete) {
            if (page.shareId) {
                try {
                    await stopShare('page', page.id, { skipLocalUpdate: true });
                } catch (e) {
                    console.warn('Failed to stop page share:', e);
                }
            }
        }

        await db.transaction('rw', [db.pages, db.boards, db.bookmarks], async () => {
            // Delete bookmarks first (avoid FK issues)
            for (const bookmark of trashItems.bookmarks) {
                await db.bookmarks.delete(bookmark.id);
            }

            // Delete trashed boards and their child bookmarks
            for (const board of trashItems.boards) {
                await db.bookmarks.where('boardId').equals(board.id).delete();
                await db.boards.delete(board.id);
            }

            // Delete pages and their children
            for (const page of pagesToDelete) {
                const boards = await db.boards.where('pageId').equals(page.id).toArray();
                for (const board of boards) {
                    await db.bookmarks.where('boardId').equals(board.id).delete();
                }
                await db.boards.where('pageId').equals(page.id).delete();
                await db.pages.delete(page.id);
            }
        });

        // Update count caches (all entity types)
        if (allBookmarkIds.length > 0) {
            bookmarkCount = Math.max(0, bookmarkCount - allBookmarkIds.length);

        }

        if (allBoardIds.length > 0) {
            for (const boardId of allBoardIds) {
                collapseBoardBookmarks(boardId);
            }
            await saveExpandedBoardIdsToStorage();
        }

        // Update board count cache
        if (allBoardIds.length > 0) {
            boardCount = Math.max(0, boardCount - allBoardIds.length);

        }

        const deletedEntityKeys = new Set();
        for (const bookmarkId of allBookmarkIds) {
            deletedEntityKeys.add(buildUndoRedoEntityKey('bookmarks', bookmarkId));
        }
        for (const boardId of allBoardIds) {
            deletedEntityKeys.add(buildUndoRedoEntityKey('boards', boardId));
        }
        for (const pageId of pageIdsToDelete) {
            deletedEntityKeys.add(buildUndoRedoEntityKey('pages', pageId));
        }

        await pruneUndoRedoHistoryForEntityKeys(deletedEntityKeys);

        // Empty trash is intentionally non-undoable.
        await clearRedoTailAfterNonUndoableMutation();
        setUndoRedoBlockedReason('You cannot undo this.');

        // Update page count cache
        if (pageIdsToDelete.length > 0) {
            pageCount = Math.max(0, pageCount - pageIdsToDelete.length);

        }

        if (pagesSkipped > 0) {
            return {
                success: true,
                warning: `${pagesSkipped} page(s) kept to ensure at least one page remains.`
            };
        }
        return { success: true };
    } catch (error) {
        console.error('Failed to empty trash:', error);
        return { success: false, error: error.message };
    }
}

// Run local 30-day cleanup (call on page load)
// FIX [Issue #7]: Sync hard deletions to server to prevent items reappearing on other devices
// FIX [Issue #3]: Wrap database operations in transaction to prevent partial deletes
async function cleanupExpiredTrash() {
    const cutoffDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    try {
        // Find expired items BEFORE transaction
        const expiredPages = await db.pages
            .filter(p => p.deletedAt && p.deletedAt < cutoffDate)
            .toArray();
        const expiredBoards = await db.boards
            .filter(b => b.deletedAt && b.deletedAt < cutoffDate)
            .toArray();
        const expiredBookmarks = await db.bookmarks
            .filter(b => b.deletedAt && b.deletedAt < cutoffDate)
            .toArray();

        // Track IDs for server sync (populated during transaction)
        const deletedBookmarkIds = [];
        const deletedBoardIds = [];
        const deletedPageIds = [];

        // Determine which pages can be deleted (check active count before transaction)
        const activePageCount = await db.pages.filter(p => !p.deletedAt).count();
        const pagesToDelete = activePageCount > 0 ? expiredPages : [];
        const preservedExpiredPageIds = new Set(
            expiredPages
                .filter(page => !pagesToDelete.find(candidate => candidate.id === page.id))
                .map(page => page.id)
        );
        const expiredBoardsToDelete = expiredBoards.filter(board => !preservedExpiredPageIds.has(board.pageId));
        const preservedExpiredBoardIds = new Set(
            expiredBoards
                .filter(board => preservedExpiredPageIds.has(board.pageId))
                .map(board => board.id)
        );
        const expiredBookmarksToDelete = expiredBookmarks.filter(
            bookmark => !preservedExpiredBoardIds.has(bookmark.boardId)
        );
        if (expiredPages.length > 0 && pagesToDelete.length === 0) {
            console.warn('Skipping expired page cleanup - no active pages exist');
        }

        // Collect all IDs to delete BEFORE transaction (for accurate tracking)
        for (const bookmark of expiredBookmarksToDelete) {
            deletedBookmarkIds.push(bookmark.id);
        }
        for (const board of expiredBoardsToDelete) {
            const childBookmarks = await db.bookmarks.where('boardId').equals(board.id).toArray();
            for (const bookmark of childBookmarks) {
                deletedBookmarkIds.push(bookmark.id);
            }
            deletedBoardIds.push(board.id);
        }
        for (const page of pagesToDelete) {
            const boards = await db.boards.where('pageId').equals(page.id).toArray();
            for (const board of boards) {
                const childBookmarks = await db.bookmarks.where('boardId').equals(board.id).toArray();
                for (const bookmark of childBookmarks) {
                    deletedBookmarkIds.push(bookmark.id);
                }
                deletedBoardIds.push(board.id);
            }
            deletedPageIds.push(page.id);
        }

        const uniqueDeletedBookmarkIds = uniqueTrashIds(deletedBookmarkIds);
        const uniqueDeletedBoardIds = uniqueTrashIds(deletedBoardIds);
        if (uniqueDeletedBookmarkIds.length === 0 && uniqueDeletedBoardIds.length === 0 && deletedPageIds.length === 0) {
            return;
        }
        const queueAttempt = await queueSyncItemsAtomically(buildDeleteSyncItems({
            bookmarkIds: uniqueDeletedBookmarkIds,
            boardIds: uniqueDeletedBoardIds,
            pageIds: deletedPageIds
        }), {
            contextLabel: 'cleanupExpiredTrash',
            ensureBootstrapPages: false
        });
        if (!queueAttempt.success) {
            console.warn('[Trash Cleanup] Failed to durably queue expired-trash deletes:', queueAttempt.error);
            return;
        }

        for (const board of expiredBoardsToDelete) {
            if (board.shareId) {
                try { await stopShare('board', board.id, { skipLocalUpdate: true }); } catch (e) { console.warn('Failed to stop board share:', e); }
            }
        }
        for (const page of pagesToDelete) {
            if (page.shareId) {
                try { await stopShare('page', page.id, { skipLocalUpdate: true }); } catch (e) { console.warn('Failed to stop page share:', e); }
            }
            const pageBoards = await db.boards.where('pageId').equals(page.id).toArray();
            for (const board of pageBoards) {
                if (board.shareId) {
                    try { await stopShare('board', board.id, { skipLocalUpdate: true }); } catch (e) { console.warn('Failed to stop board share:', e); }
                }
            }
        }

        // FIX [Issue #3]: Atomic transaction for all database deletes
        if (deletedBookmarkIds.length > 0 || deletedBoardIds.length > 0 || deletedPageIds.length > 0) {
            await db.transaction('rw', [db.pages, db.boards, db.bookmarks], async () => {
                // Delete expired bookmarks
                for (const bookmark of expiredBookmarksToDelete) {
                    await db.bookmarks.delete(bookmark.id);
                }

                // Delete expired boards and their child bookmarks
                for (const board of expiredBoardsToDelete) {
                    await db.bookmarks.where('boardId').equals(board.id).delete();
                    await db.boards.delete(board.id);
                }

                // Delete pages and their children
                for (const page of pagesToDelete) {
                    const boards = await db.boards.where('pageId').equals(page.id).toArray();
                    for (const board of boards) {
                        await db.bookmarks.where('boardId').equals(board.id).delete();
                    }
                    await db.boards.where('pageId').equals(page.id).delete();
                    await db.pages.delete(page.id);
                }
            });

            // Update count caches (deduplicate IDs since same item could be counted multiple times)
            if (uniqueDeletedBookmarkIds.length > 0) {
                bookmarkCount = Math.max(0, bookmarkCount - uniqueDeletedBookmarkIds.length);

            }

            if (uniqueDeletedBoardIds.length > 0) {
                boardCount = Math.max(0, boardCount - uniqueDeletedBoardIds.length);

            }

            if (deletedPageIds.length > 0) {
                pageCount = Math.max(0, pageCount - deletedPageIds.length);

            }

            const deletedEntityKeys = new Set();
            for (const bookmarkId of uniqueDeletedBookmarkIds) {
                deletedEntityKeys.add(buildUndoRedoEntityKey('bookmarks', bookmarkId));
            }
            for (const boardId of uniqueDeletedBoardIds) {
                deletedEntityKeys.add(buildUndoRedoEntityKey('boards', boardId));
            }
            for (const pageId of deletedPageIds) {
                deletedEntityKeys.add(buildUndoRedoEntityKey('pages', pageId));
            }
            await pruneUndoRedoHistoryForEntityKeys(deletedEntityKeys);

            broadcastDataChange('cleanupExpiredTrash');
        }
    } catch (error) {
        console.error('Trash cleanup error:', error);
    }
}

/*
========================================
TRASH MODAL FUNCTIONS
========================================
Functions for opening, closing, and managing the trash modal UI
*/

// Open trash modal
async function openTrashModal() {
    const modal = document.getElementById('trashModal');
    modal.classList.add('active');
    await refreshTrashModal();
}

// Flag to prevent closing modal during operations
let isTrashOperationInProgress = false;

// Close trash modal
function closeTrashModal() {
    if (isTrashOperationInProgress) return; // Prevent close during operation
    const modal = document.getElementById('trashModal');
    modal.classList.remove('active');
}

// Refresh trash modal content
async function refreshTrashModal() {
    const trashItems = await getTrashItems();
    const trashList = document.getElementById('trashList');
    const emptyState = document.getElementById('trashEmptyState');
    const emptyBtn = document.getElementById('emptyTrashBtn');

    const totalItems = trashItems.pages.length + trashItems.boards.length + trashItems.bookmarks.length;

    if (totalItems === 0) {
        trashList.style.display = 'none';
        emptyState.style.display = 'block';
        emptyBtn.style.display = 'none';
        return;
    }

    trashList.style.display = 'block';
    emptyState.style.display = 'none';
    emptyBtn.style.display = 'block';

    let html = '';

    // Pages section
    if (trashItems.pages.length > 0) {
        html += '<div class="trash-section-header">Pages</div>';
        for (const page of trashItems.pages) {
            html += renderTrashItem('page', page.id, page.name, page.deletedAt);
        }
    }

    // Boards section
    if (trashItems.boards.length > 0) {
        html += '<div class="trash-section-header">Boards</div>';
        for (const board of trashItems.boards) {
            html += renderTrashItem('board', board.id, board.name, board.deletedAt, board.restoreContext);
        }
    }

    // Bookmarks section
    if (trashItems.bookmarks.length > 0) {
        html += '<div class="trash-section-header">Bookmarks</div>';
        for (const bookmark of trashItems.bookmarks) {
            html += renderTrashItem('bookmark', bookmark.id, bookmark.title, bookmark.deletedAt, bookmark.restoreContext);
        }
    }

    trashList.innerHTML = html;
}

// Render single trash item
function renderTrashItem(type, id, name, deletedAt, restoreContext = '') {
    const deletedDate = new Date(deletedAt);
    const daysAgo = Math.floor((Date.now() - deletedDate.getTime()) / (24 * 60 * 60 * 1000));
    const daysRemaining = Math.max(0, 30 - daysAgo);
    const dateStr = deletedDate.toLocaleDateString();
    const escapedType = escapeHtml(type);
    const escapedId = escapeHtml(id);
    const contextLine = restoreContext
        ? `<div class="trash-item-context">${escapeHtml(restoreContext)}</div>`
        : '';

    return `
        <div class="trash-item" data-type="${escapedType}" data-id="${escapedId}">
            <div class="trash-item-info">
                <div class="trash-item-details">
                    <div class="trash-item-name">${escapeHtml(name || 'Untitled')}</div>
                    <div class="trash-item-meta">Deleted ${dateStr} · ${daysRemaining} days remaining</div>
                    ${contextLine}
                </div>
            </div>
            <div class="trash-item-actions">
                <button class="trash-item-btn restore" data-action="restore" data-type="${escapedType}" data-id="${escapedId}">Restore</button>
                <button class="trash-item-btn delete-permanent" data-action="delete" data-type="${escapedType}" data-id="${escapedId}">Delete</button>
            </div>
        </div>
    `;
}

// Handle restore button click
async function handleRestoreItem(type, id, btn) {
    // Show loading state on the clicked button
    const originalText = btn?.textContent || 'Restore';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner-small"></span>';
    }
    isTrashOperationInProgress = true;

    try {
        const result = await restoreFromTrash(type, id);
        if (result.success) {
            // Update UI immediately (before sync)
            await refreshTrashModal();
            // IMPORTANT: If restoring a board or page, explicitly set pageHasBoards and hide placeholder
            // Prevents race condition where placeholder could still be clickable during render
            // Pages may contain boards, so we need to handle both types
            if (type === 'board' || type === 'page') {
                pageHasBoards = true;
                hideAddBoardPlaceholder();
            }
            await loadBoardsFromDatabase();
            await loadPagesNavigation();
            broadcastDataChange('restoreFromTrash');
        } else {
            showGlassToast(result.error || 'Failed to restore item', 'error');
            // Restore button on error
            if (btn) {
                btn.disabled = false;
                btn.textContent = originalText;
            }
        }
    } catch (error) {
        // Restore button on exception
        if (btn) {
            btn.disabled = false;
            btn.textContent = originalText;
        }
        throw error;
    } finally {
        isTrashOperationInProgress = false;
    }
}

// Handle permanent delete button click
async function handlePermanentDelete(type, id, btn) {
    const confirmed = await showGlassConfirm(
        'Permanently Delete',
        'Permanently delete this item? You cannot undo this action.',
        { confirmText: 'Delete Forever', confirmClass: 'btn-danger' }
    );
    if (!confirmed) {
        return;
    }

    // Show loading state after confirmation
    const originalText = btn?.textContent || 'Delete';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner-small"></span>';
    }
    isTrashOperationInProgress = true;

    try {
        const result = await permanentlyDelete(type, id);
        if (result.success) {
            await refreshTrashModal();
            // Reload page state to reflect permanent deletion
            // (e.g., if last board was permanently deleted, placeholder should appear)
            await loadBoardsFromDatabase();
            await loadPagesNavigation();
            broadcastDataChange('permanentlyDelete');
            const feedback = window.LumiListModules?.feedback;
            if (typeof feedback?.showDeleteSuccessToast === 'function') {
                feedback.showDeleteSuccessToast('Deleted successfully.');
            } else {
                showGlassToast('Deleted successfully.', 'success');
            }
        } else {
            showGlassToast(result.error || 'Failed to delete item', 'error');
            // Restore button on error
            if (btn) {
                btn.disabled = false;
                btn.textContent = originalText;
            }
        }
    } catch (error) {
        // Restore button on exception
        if (btn) {
            btn.disabled = false;
            btn.textContent = originalText;
        }
        throw error;
    } finally {
        isTrashOperationInProgress = false;
    }
}

// Handle empty trash button click
async function handleEmptyTrash() {
    const confirmed = await showGlassConfirm(
        'Empty Trash',
        'Permanently delete all items in trash? You cannot undo this action.',
        { confirmText: 'Empty Trash', confirmClass: 'btn-danger' }
    );
    if (!confirmed) {
        return;
    }

    // Show loading state after confirmation
    const emptyBtn = document.getElementById('emptyTrashBtn');
    const originalText = emptyBtn?.textContent || 'Empty Trash';
    if (emptyBtn) {
        emptyBtn.disabled = true;
        emptyBtn.innerHTML = '<span class="spinner-small"></span> Emptying...';
    }
    isTrashOperationInProgress = true;

    try {
        const result = await emptyTrash();
        if (result.success) {
            await refreshTrashModal();
            // Reload page state to reflect emptied trash
            // (e.g., if boards were permanently deleted, page layout may change)
            await loadBoardsFromDatabase();
            await loadPagesNavigation();
            broadcastDataChange('emptyTrash');
        } else {
            showGlassToast(result.error || 'Failed to empty trash', 'error');
        }
    } finally {
        // Restore button state (modal may close on success, but button should reset either way)
        if (emptyBtn) {
            emptyBtn.disabled = false;
            emptyBtn.textContent = originalText;
        }
        isTrashOperationInProgress = false;
    }
}

// Initialize trash button and modal
let trashFeatureInitialized = false;
function initTrashFeature() {
    if (trashFeatureInitialized) return;
    trashFeatureInitialized = true;

    // Floating trash button
    const trashBtn = document.getElementById('floatingTrashBtn');
    if (trashBtn) {
        trashBtn.addEventListener('click', async () => {
            await openTrashModal();
        });
    }

    // Close button
    const closeBtn = document.getElementById('closeTrashBtn');
    if (closeBtn) {
        closeBtn.addEventListener('click', closeTrashModal);
    }

    // Empty trash button
    const emptyBtn = document.getElementById('emptyTrashBtn');
    if (emptyBtn) {
        emptyBtn.addEventListener('click', async () => {
            await handleEmptyTrash();
        });
    }

    // Close on overlay click (safe drag-outside handling)
    const modal = document.getElementById('trashModal');
    setupModalClickOutside(modal, closeTrashModal);

    // Event delegation for trash item buttons (restore/delete)
    const trashList = document.getElementById('trashList');
    if (trashList) {
        trashList.addEventListener('click', async (e) => {
            const btn = e.target.closest('button[data-action]');
            if (!btn) return;
            if (isTrashOperationInProgress) return; // Prevent concurrent operations

            const action = btn.dataset.action;
            const type = btn.dataset.type;
            const id = btn.dataset.id;

            if (action === 'restore') {
                await handleRestoreItem(type, id, btn);
            } else if (action === 'delete') {
                await handlePermanentDelete(type, id, btn);
            }
        });
    }

}

/*
========================================
DELETE FUNCTIONS
========================================
Delete board and bookmark functions - now use soft delete (move to trash)
*/

// Delete board function (soft delete - moves to trash)
async function deleteBoard(boardId) {
    if (!boardId) return;
    // Block in read-only mode
    if (!canModify()) return;

    try {
        const now = getCurrentTimestamp();
        const boardBefore = await db.boards.get(boardId);
        if (!boardBefore) {
            console.warn(`[deleteBoard] Board not found with ID: ${boardId}`);
            return;
        }
        const columnBoardsBefore = await db.boards
            .where('pageId')
            .equals(boardBefore.pageId)
            .filter(board => !board.deletedAt && board.columnIndex === boardBefore.columnIndex)
            .toArray();
        const columnBoardsBeforeById = createUndoRedoSnapshotMap(columnBoardsBefore);

        // CASCADE: Soft-delete all bookmarks in this board first
        const childBookmarks = await db.bookmarks.where('boardId').equals(boardId).toArray();
        const childBookmarksToDelete = childBookmarks.filter(bookmark => !bookmark.deletedAt);
        const childBookmarkBeforeById = createUndoRedoSnapshotMap(childBookmarksToDelete);
        const childBookmarkIdsToDelete = childBookmarksToDelete.map(bookmark => bookmark.id);
        await db.transaction('rw', [db.boards, db.bookmarks], async () => {
            for (const bookmark of childBookmarks) {
                if (!bookmark.deletedAt) {
                    await db.bookmarks.update(bookmark.id, { deletedAt: now, updatedAt: now });
                }
            }

            // Soft delete: set deletedAt instead of removing
            await db.boards.update(boardId, {
                deletedAt: now,
                updatedAt: now
            });
        });

        for (const bookmark of childBookmarks) {
            if (!bookmark.deletedAt) {
                const updatedBookmark = await db.bookmarks.get(bookmark.id);
                if (updatedBookmark) await queueSyncToBackground('upsert', 'bookmarks', bookmark.id, updatedBookmark);
            }
        }


        // Queue for background sync
        const deletedBoard = await db.boards.get(boardId);
        if (deletedBoard) {
            await queueSyncToBackground('upsert', 'boards', boardId, deletedBoard);

        } else {
            console.warn(`[deleteBoard] FAILED: Could not get board ${boardId} after update`);
        }

        broadcastDataChange('deleteBoard');

        // Remove board element from DOM
        const boardElement = document.querySelector(`[data-board-id="${boardId}"]`);
        if (boardElement) {
            const parentColumn = boardElement.parentNode;
            boardElement.remove();

            // Update board orders in the column (with validation)
            const columnAttr = parentColumn?.getAttribute?.('data-column');
            if (columnAttr !== null && columnAttr !== undefined) {
                const columnIndex = parseInt(columnAttr);
                if (!isNaN(columnIndex)) {
                    await updateColumnBoardOrders(columnIndex);
                }
            }

            // Check if page is now empty and show placeholder
            const container = document.querySelector('.container');
            const remainingBoards = container ? container.querySelectorAll('.board') : [];
            if (remainingBoards.length === 0) {
                pageHasBoards = false;
                showAddBoardPlaceholder(0);
            }
        }
        await refreshSearchIfOpen();

        if (!isApplyingUndoRedoHistory && deletedBoard) {
            const columnBoardsAfterById = await collectUndoRedoSnapshotsByIds('boards', Array.from(columnBoardsBeforeById.keys()));
            const childBookmarksAfterDelete = childBookmarkIdsToDelete.length > 0
                ? (await db.bookmarks.bulkGet(childBookmarkIdsToDelete)).filter(Boolean)
                : [];
            const childBookmarkAfterById = createUndoRedoSnapshotMap(childBookmarksAfterDelete);
            const ops = [
                ...buildUndoRedoOpsFromSnapshotMaps('boards', columnBoardsBeforeById, columnBoardsAfterById),
                ...buildUndoRedoOpsFromSnapshotMaps('bookmarks', childBookmarkBeforeById, childBookmarkAfterById)
            ];

            await recordUndoRedoHistoryEntry({
                kind: 'board_delete',
                label: `Delete board "${boardBefore.name || 'Untitled'}"`,
                ops
            });
        }



    } catch (error) {
        console.error('Failed to delete board:', error);
        throw error;
    }
}

// Delete bookmark function (soft delete - moves to trash)
async function deleteBookmark(bookmarkId) {
    if (!bookmarkId) return;
    // Block in read-only mode
    if (!canModify()) return;

    try {
        const now = getCurrentTimestamp();

        // Get bookmark details before deletion for order updates
        const bookmark = await db.bookmarks.get(bookmarkId);
        if (!bookmark) {
            console.warn(`[deleteBookmark] Bookmark not found with ID: ${bookmarkId}`);
            return;
        }
        const boardBookmarksBefore = await db.bookmarks
            .where('boardId')
            .equals(bookmark.boardId)
            .filter(b => !b.deletedAt)
            .toArray();
        const boardBookmarksBeforeById = createUndoRedoSnapshotMap(boardBookmarksBefore);

        // Soft delete: set deletedAt instead of removing
        const updateResult = await db.bookmarks.update(bookmarkId, {
            deletedAt: now,
            updatedAt: now
        });


        // Queue to background sync (ensures delete syncs even if user navigates away)
        const updatedBookmark = await db.bookmarks.get(bookmarkId);


        if (updatedBookmark) {
            await queueSyncToBackground('upsert', 'bookmarks', bookmarkId, updatedBookmark);

        } else {
            console.warn(`[deleteBookmark] FAILED: Could not get bookmark ${bookmarkId} after update`);
        }

        broadcastDataChange('deleteBookmark');

        // Remove bookmark element from DOM
        const bookmarkElement = document.querySelector(`li[data-bookmark-id="${bookmarkId}"]`);
        if (bookmarkElement) {
            bookmarkElement.remove();
        }

        // Update bookmark orders in the board
        await updateBoardBookmarkOrders(bookmark.boardId);
        if (!isApplyingUndoRedoHistory && updatedBookmark) {
            const boardBookmarksAfterById = await collectUndoRedoSnapshotsByIds('bookmarks', Array.from(boardBookmarksBeforeById.keys()));
            await recordUndoRedoHistoryEntry({
                kind: 'bookmark_delete',
                label: `Delete bookmark "${bookmark.title || 'Untitled'}"`,
                ops: buildUndoRedoOpsFromSnapshotMaps('bookmarks', boardBookmarksBeforeById, boardBookmarksAfterById)
            });
        }
        if (largeBoardCollapseEnabled) {
            await loadBoardsFromDatabase();
        }
        await refreshSearchIfOpen();



    } catch (error) {
        console.error('Failed to delete bookmark:', error);
        throw error;
    }
}

/*
========================================
DELETE CONFIRMATION MODAL
========================================
Functions for showing and handling delete confirmation
*/

// Show delete confirmation modal
async function showDeleteConfirmation(itemName, itemType, itemId) {
    // Block in read-only mode (grace/expired status)
    if (!canModify()) return;

    try {
        // Store item info for deletion
        pendingDeleteItem = itemId;
        pendingDeleteType = itemType;

        const modal = document.getElementById('deleteConfirmModal');
        const titleElement = document.getElementById('deleteConfirmTitle');
        const messageElement = document.getElementById('deleteConfirmMessage');
        const detailsElement = document.getElementById('deleteConfirmDetails');

        if (itemType === 'board') {
            // FIX [Issue #32]: Count only active bookmarks (exclude already-deleted ones)
            const bookmarkCount = await db.bookmarks
                .where('boardId')
                .equals(itemId)
                .filter(b => !b.deletedAt)
                .count();

            titleElement.textContent = 'Move to Trash';
            messageElement.textContent = `Move "${itemName}" to trash?`;
            detailsElement.textContent = `The board and its ${bookmarkCount} bookmarks will be moved to trash. You can restore them within 30 days.`;

        } else if (itemType === 'bookmark') {
            titleElement.textContent = 'Move to Trash';
            messageElement.textContent = `Move "${itemName}" to trash?`;
            detailsElement.textContent = 'This bookmark will be moved to trash. You can restore it within 30 days.';
        }

        // Show modal
        modal.classList.add('active');

        // Focus on cancel button for keyboard accessibility
        document.getElementById('cancelDeleteBtn').focus();

    } catch (error) {
        console.error('Failed to show delete confirmation:', error);
        showGlassToast('Failed to show confirmation dialog. Please try again.', 'error');
    }
}

// Hide delete confirmation modal
function hideDeleteConfirmation() {
    const modal = document.getElementById('deleteConfirmModal');
    modal.classList.remove('active');
}

// Confirm deletion - execute the actual delete
async function confirmDeletion() {
    // Store item info before clearing state
    const itemType = pendingDeleteType;
    const itemId = pendingDeleteItem;

    // Close modal immediately for responsive UX (don't wait for network sync)
    cleanupDeletionState();

    if (!itemType || !itemId) return;

    try {
        const result = await moveToTrash(itemType, itemId);
        if (!result?.success) {
            showGlassToast(result?.error || 'Failed to delete item. Please try again.', 'error');
            return;
        }

        await loadBoardsFromDatabase();
        await refreshSearchIfOpen();
        if (itemType === 'board') {
            await loadPagesNavigation();
        }
        broadcastDataChange('moveToTrash');
        const feedback = window.LumiListModules?.feedback;
        if (typeof feedback?.showDeleteSuccessToast === 'function') {
            feedback.showDeleteSuccessToast('Deleted successfully.');
        } else {
            showGlassToast('Deleted successfully.', 'success');
        }

    } catch (error) {
        console.error('Failed to delete item:', error);
        showGlassToast('Failed to delete item. Please try again.', 'error');
    }
}

// Cancel deletion - restore item to original position
function cancelDeletion() {
    try {
        if (originalItemPosition) {
            if (pendingDeleteType === 'board') {
                // Restore board to original column position
                if (originalItemPosition.nextSibling) {
                    originalItemPosition.parentColumn.insertBefore(
                        originalItemPosition.element,
                        originalItemPosition.nextSibling
                    );
                } else {
                    originalItemPosition.parentColumn.appendChild(originalItemPosition.element);
                }
            } else if (pendingDeleteType === 'bookmark') {
                // Restore bookmark to original list position
                if (originalItemPosition.nextSibling) {
                    originalItemPosition.parentList.insertBefore(
                        originalItemPosition.element,
                        originalItemPosition.nextSibling
                    );
                } else {
                    originalItemPosition.parentList.appendChild(originalItemPosition.element);
                }
            }
        }



    } catch (error) {
        console.error('Failed to restore item position:', error);
        // Don't show alert here as it's not critical - item might have already been removed
    } finally {
        // Clean up deletion state
        cleanupDeletionState();
    }
}

// Clean up all deletion-related state
function cleanupDeletionState() {
    // Hide confirmation modal
    hideDeleteConfirmation();

    // Reset deletion state variables
    pendingDeleteItem = null;
    pendingDeleteType = null;
    originalItemPosition = null;

    // Clean up drag state
    cleanupAllDragIndicators();
    draggedElement = null;
    draggedBookmark = null;
}
