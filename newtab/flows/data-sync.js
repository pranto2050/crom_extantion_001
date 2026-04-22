// Add timestamps to a new record
function withTimestamps(record) {
    const now = getCurrentTimestamp();
    return {
        ...record,
        createdAt: record.createdAt || now,
        updatedAt: now,
        // FIX: Ensure deletedAt is explicitly set for consistent field initialization
        // Prevents undefined vs null issues during sync comparisons
        deletedAt: record.deletedAt !== undefined ? record.deletedAt : null
    };
}

// Add updatedAt to a record being updated
function withUpdatedAt(updateData) {
    return {
        ...updateData,
        updatedAt: getCurrentTimestamp()
    };
}

// These boot-time limits mirror the IndexedDB/history defaults in newtab.js.
// Keep them local here because this preloaded file executes before newtab.js.
const DATA_SYNC_UNDO_REDO_HISTORY_STATE_ID = 'main';
const DATA_SYNC_UNDO_REDO_HISTORY_MAX_DEPTH_DEFAULT = 200;
const DATA_SYNC_SYNC_QUEUE_CAPACITY_LIMIT = 120000;
const DATA_SYNC_UNDO_REDO_SYNC_QUEUE_LIMIT = 1000;
const DATA_SYNC_UNDO_REDO_SYNC_CHUNK_SIZE = 250;

let isApplyingUndoRedoHistory = false;
let undoRedoBlockedReason = null;
let undoRedoHistoryCache = {
    cursorSeq: 0,
    headSeq: 0,
    maxDepth: DATA_SYNC_UNDO_REDO_HISTORY_MAX_DEPTH_DEFAULT
};

function setUndoRedoBlockedReason(message) {
    if (typeof message !== 'string' || !message.trim()) {
        undoRedoBlockedReason = null;
        return;
    }
    undoRedoBlockedReason = message.trim();
}

function isNonUndoRedoHistoryKind(kind) {
    const normalizedKind = String(kind || '').toLowerCase();
    return normalizedKind.includes('permanent_delete') || normalizedKind === 'empty_trash';
}

function isUndoRedoHistoryAvailable() {
    return !!db.historyEntries && !!db.historyState;
}

function cloneUndoRedoSnapshot(value) {
    if (value === null || value === undefined) return null;
    try {
        if (typeof structuredClone === 'function') {
            return structuredClone(value);
        }
    } catch (error) {
        // Fallback to JSON clone below.
    }
    return JSON.parse(JSON.stringify(value));
}

function normalizeUndoRedoRowForCompare(row) {
    if (!row || typeof row !== 'object') return row;
    const copy = { ...row };
    delete copy.updatedAt;
    return copy;
}

function areUndoRedoRowsEquivalent(a, b) {
    if (a === null || a === undefined) return b === null || b === undefined;
    if (b === null || b === undefined) return false;
    return JSON.stringify(normalizeUndoRedoRowForCompare(a)) === JSON.stringify(normalizeUndoRedoRowForCompare(b));
}

function normalizeUndoRedoOps(ops) {
    if (!Array.isArray(ops) || ops.length === 0) return [];

    const tableByKey = new Map();
    const ordered = [];

    ops.forEach((op) => {
        if (!op || !op.table || !op.id) return;
        if (!['pages', 'boards', 'bookmarks', 'installedWallpapers'].includes(op.table)) return;
        const key = `${op.table}:${op.id}`;
        const mode = op.mode === 'patch' ? 'patch' : 'replace';
        const before = op.before === undefined ? null : cloneUndoRedoSnapshot(op.before);
        const after = op.after === undefined ? null : cloneUndoRedoSnapshot(op.after);

        if (tableByKey.has(key)) {
            const existing = tableByKey.get(key);
            existing.after = after;
            existing.mode = mode;
            return;
        }

        const normalized = { table: op.table, id: op.id, mode, before, after };
        tableByKey.set(key, normalized);
        ordered.push(normalized);
    });

    return ordered.filter((op) => !areUndoRedoRowsEquivalent(op.before, op.after));
}

function createUndoRedoSnapshotMap(rows) {
    const snapshotMap = new Map();
    if (!Array.isArray(rows)) return snapshotMap;
    rows.forEach((row) => {
        if (!row?.id) return;
        snapshotMap.set(row.id, cloneUndoRedoSnapshot(row));
    });
    return snapshotMap;
}

function buildUndoRedoOpsFromSnapshotMaps(table, beforeMap, afterMap) {
    const ops = [];
    const ids = new Set([
        ...Array.from(beforeMap?.keys?.() || []),
        ...Array.from(afterMap?.keys?.() || [])
    ]);

    ids.forEach((id) => {
        ops.push({
            table,
            id,
            before: beforeMap?.get(id) || null,
            after: afterMap?.get(id) || null
        });
    });

    return ops;
}

async function collectUndoRedoSnapshotsByIds(tableName, ids) {
    const table = getUndoRedoTable(tableName);
    const snapshotMap = new Map();
    if (!table) return snapshotMap;

    const uniqueIds = [...new Set((ids || []).filter(Boolean))];
    if (uniqueIds.length === 0) return snapshotMap;

    const rows = await table.bulkGet(uniqueIds);
    uniqueIds.forEach((id, idx) => {
        const row = rows[idx];
        if (!row) return;
        snapshotMap.set(id, cloneUndoRedoSnapshot(row));
    });

    return snapshotMap;
}

async function collectUndoRedoActiveBoardAndBookmarkSnapshotsForPage(pageId) {
    const result = {
        boardById: new Map(),
        bookmarkById: new Map()
    };
    if (!pageId) return result;

    const boards = await db.boards
        .where('pageId')
        .equals(pageId)
        .filter(board => !board.deletedAt)
        .toArray();
    result.boardById = createUndoRedoSnapshotMap(boards);

    const boardIds = boards.map(board => board.id);
    if (boardIds.length === 0) {
        return result;
    }

    const bookmarks = await db.bookmarks
        .where('boardId')
        .anyOf(boardIds)
        .filter(bookmark => !bookmark.deletedAt)
        .toArray();
    result.bookmarkById = createUndoRedoSnapshotMap(bookmarks);

    return result;
}

function getDefaultUndoRedoHistoryState() {
    return {
        id: DATA_SYNC_UNDO_REDO_HISTORY_STATE_ID,
        cursorSeq: 0,
        headSeq: 0,
        maxDepth: DATA_SYNC_UNDO_REDO_HISTORY_MAX_DEPTH_DEFAULT
    };
}

function setUndoRedoHistoryCache(state) {
    undoRedoHistoryCache = {
        cursorSeq: Number(state?.cursorSeq) || 0,
        headSeq: Number(state?.headSeq) || 0,
        maxDepth: Number(state?.maxDepth) || DATA_SYNC_UNDO_REDO_HISTORY_MAX_DEPTH_DEFAULT
    };
}

async function ensureUndoRedoHistoryStateRow(historyStateTable = db.historyState) {
    if (!isUndoRedoHistoryAvailable()) return getDefaultUndoRedoHistoryState();
    const existing = await historyStateTable.get(DATA_SYNC_UNDO_REDO_HISTORY_STATE_ID);
    if (existing) {
        const normalized = {
            ...existing,
            cursorSeq: Number(existing.cursorSeq) || 0,
            headSeq: Number(existing.headSeq) || 0,
            maxDepth: Number(existing.maxDepth) || DATA_SYNC_UNDO_REDO_HISTORY_MAX_DEPTH_DEFAULT
        };
        if (!existing.maxDepth) {
            await historyStateTable.put(normalized);
        }
        return normalized;
    }

    const fresh = getDefaultUndoRedoHistoryState();
    await historyStateTable.put(fresh);
    return fresh;
}

async function initializeUndoRedoHistoryState() {
    if (!isUndoRedoHistoryAvailable()) return;
    try {
        const state = await ensureUndoRedoHistoryStateRow(db.historyState);
        setUndoRedoHistoryCache(state);
    } catch (error) {
        console.warn('[Undo/Redo] Failed to initialize history state:', error);
    }
}

async function clearUndoRedoHistory() {
    if (!isUndoRedoHistoryAvailable()) return;
    try {
        await db.historyEntries.clear();
        await db.historyState.clear();
        const state = await ensureUndoRedoHistoryStateRow(db.historyState);
        setUndoRedoHistoryCache(state);
        setUndoRedoBlockedReason(null);
    } catch (error) {
        console.warn('[Undo/Redo] Failed to clear history:', error);
    }
}

async function recordUndoRedoHistoryEntry({ kind, label, ops, meta = null }) {
    if (isApplyingUndoRedoHistory || !isUndoRedoHistoryAvailable()) return;
    const normalizedOps = normalizeUndoRedoOps(ops);
    if (normalizedOps.length === 0) return;
    setUndoRedoBlockedReason(null);

    try {
        await db.transaction('rw', db.historyEntries, db.historyState, async () => {
            const state = await ensureUndoRedoHistoryStateRow(db.historyState);

            // New action after undo clears redo tail.
            if (state.cursorSeq < state.headSeq) {
                await db.historyEntries.where('seq').above(state.cursorSeq).delete();
                state.headSeq = state.cursorSeq;
            }

            const nextSeq = state.cursorSeq + 1;
            await db.historyEntries.put({
                id: generateId(),
                seq: nextSeq,
                createdAt: getCurrentTimestamp(),
                kind: kind || 'generic',
                label: label || 'Change',
                origin: 'local',
                groupId: null,
                ops: normalizedOps,
                meta: meta || null
            });

            state.cursorSeq = nextSeq;
            state.headSeq = nextSeq;
            state.maxDepth = Number(state.maxDepth) || DATA_SYNC_UNDO_REDO_HISTORY_MAX_DEPTH_DEFAULT;
            await db.historyState.put(state);

            const pruneBeforeSeq = nextSeq - state.maxDepth;
            if (pruneBeforeSeq > 0) {
                await db.historyEntries.where('seq').belowOrEqual(pruneBeforeSeq).delete();
            }

            setUndoRedoHistoryCache(state);
        });
    } catch (error) {
        console.warn('[Undo/Redo] Failed to record history entry:', error);
    }
}

async function clearRedoTailAfterNonUndoableMutation() {
    if (!isUndoRedoHistoryAvailable()) return;
    try {
        await db.transaction('rw', db.historyEntries, db.historyState, async () => {
            const state = await ensureUndoRedoHistoryStateRow(db.historyState);
            if (state.cursorSeq < state.headSeq) {
                await db.historyEntries.where('seq').above(state.cursorSeq).delete();
                state.headSeq = state.cursorSeq;
                await db.historyState.put(state);
                setUndoRedoHistoryCache(state);
            }
        });
    } catch (error) {
        console.warn('[Undo/Redo] Failed to clear redo tail for non-undoable mutation:', error);
    }
}

function buildUndoRedoEntityKey(table, id) {
    if (!table || !id) return null;
    return `${table}:${id}`;
}

async function pruneUndoRedoHistoryForEntityKeys(entityKeys) {
    if (!isUndoRedoHistoryAvailable()) return;

    const normalizedKeys = new Set(
        Array.from(entityKeys || [])
            .filter(Boolean)
            .map(key => String(key))
    );
    if (normalizedKeys.size === 0) return;

    try {
        await db.transaction('rw', db.historyEntries, db.historyState, async () => {
            const entries = await db.historyEntries.orderBy('seq').toArray();
            if (!entries || entries.length === 0) return;

            const keptEntries = [];
            let didMutateEntries = false;
            entries.forEach((entry) => {
                if (!Array.isArray(entry?.ops) || entry.ops.length === 0) {
                    keptEntries.push(entry);
                    return;
                }

                // Preserve undo-step atomicity: if any operation in an entry references
                // a permanently deleted entity, drop the whole entry instead of mutating
                // it into a partial action that no longer matches user intent.
                const hasDeletedEntityOp = entry.ops.some((op) => normalizedKeys.has(buildUndoRedoEntityKey(op?.table, op?.id)));
                if (!hasDeletedEntityOp) {
                    keptEntries.push(entry);
                    return;
                }

                didMutateEntries = true;
            });

            if (!didMutateEntries && keptEntries.length === entries.length) return;

            await db.historyEntries.clear();
            for (let i = 0; i < keptEntries.length; i++) {
                await db.historyEntries.put({
                    ...keptEntries[i],
                    seq: i + 1
                });
            }

            const state = await ensureUndoRedoHistoryStateRow(db.historyState);
            const maxSeq = keptEntries.length;
            state.headSeq = maxSeq;
            state.cursorSeq = Math.min(state.cursorSeq, maxSeq);
            await db.historyState.put(state);
            setUndoRedoHistoryCache(state);
        });
    } catch (error) {
        console.warn('[Undo/Redo] Failed to prune history for deleted entities:', error);
    }
}

function getUndoRedoTable(tableName) {
    if (tableName === 'pages') return db.pages;
    if (tableName === 'boards') return db.boards;
    if (tableName === 'bookmarks') return db.bookmarks;
    if (tableName === 'installedWallpapers') return db.installedWallpapers;
    return null;
}

function buildUndoRedoSyncOperations(changes) {
    if (!Array.isArray(changes) || changes.length === 0) return [];
    const uniqueChanges = new Map();
    for (const change of changes) {
        if (!change?.table || !change?.id) continue;
        if (!['pages', 'boards', 'bookmarks'].includes(change.table)) continue;
        uniqueChanges.set(`${change.table}:${change.id}`, change);
    }

    const upserts = [];
    const deletes = [];
    uniqueChanges.forEach((change) => {
        if (change.snapshot === null) {
            deletes.push(change);
        } else {
            upserts.push(change);
        }
    });

    const upsertOrder = { pages: 0, boards: 1, bookmarks: 2 };
    const deleteOrder = { bookmarks: 0, boards: 1, pages: 2 };
    upserts.sort((a, b) => {
        const tableDiff = (upsertOrder[a.table] ?? 99) - (upsertOrder[b.table] ?? 99);
        if (tableDiff !== 0) return tableDiff;
        return String(a.id).localeCompare(String(b.id));
    });
    deletes.sort((a, b) => {
        const tableDiff = (deleteOrder[a.table] ?? 99) - (deleteOrder[b.table] ?? 99);
        if (tableDiff !== 0) return tableDiff;
        return String(a.id).localeCompare(String(b.id));
    });

    const operations = [];
    for (const change of upserts) {
        operations.push({
            operation: 'upsert',
            tableName: change.table,
            recordId: change.id,
            data: change.snapshot
        });
    }
    for (const change of deletes) {
        operations.push({
            operation: 'delete',
            tableName: change.table,
            recordId: change.id,
            data: null
        });
    }

    return operations;
}

async function getSyncQueueCount() {
    try {
        return await db.syncQueue.count();
    } catch (error) {
        console.warn('[Undo/Redo] Failed to read sync queue count:', error);
        return 0;
    }
}

async function shouldUseChunkedUndoRedoSync(operationCount) {
    const normalizedCount = Math.max(0, Number(operationCount) || 0);
    if (normalizedCount > DATA_SYNC_UNDO_REDO_SYNC_QUEUE_LIMIT) {
        return true;
    }
    if (normalizedCount === 0) {
        return false;
    }

    const queueCount = await getSyncQueueCount();
    return (queueCount + normalizedCount) > DATA_SYNC_UNDO_REDO_SYNC_QUEUE_LIMIT;
}

async function queueUndoRedoSyncOperations(syncOperations, options = {}) {
    const operations = Array.isArray(syncOperations) ? syncOperations.filter(Boolean) : [];
    const result = {
        total: operations.length,
        processed: 0,
        flushedDuringQueueing: false,
        queueError: null,
        flushError: null
    };
    if (operations.length === 0) return result;

    const requestedChunkSize = Number(options.chunkSize);
    const chunkSize = Number.isFinite(requestedChunkSize) && requestedChunkSize > 0
        ? Math.max(1, Math.floor(requestedChunkSize))
        : operations.length;
    const flushEachChunk = !!options.flushEachChunk;
    const onProgress = (typeof options.onProgress === 'function') ? options.onProgress : null;
    const totalChunks = Math.ceil(operations.length / chunkSize);

    let shouldFlushEachChunk = flushEachChunk;
    if (flushEachChunk) {
        const preFlushResult = await flushSyncQueue();
        if (!preFlushResult || preFlushResult.success === false) {
            shouldFlushEachChunk = false;
            result.flushError = preFlushResult?.error || 'Unable to sync during chunked undo/redo. Remaining changes were queued for retry.';
            console.warn('[Undo/Redo] Pre-chunk flush failed, continuing queue-only chunking:', result.flushError);
            if (onProgress) {
                await onProgress({
                    phase: 'warning',
                    processed: 0,
                    total: operations.length,
                    chunkIndex: 0,
                    totalChunks
                });
            }
        }
    }

    const queueChunk = async (chunk) => {
        const queueResult = await queueBatchSyncToBackground(chunk, {
            scheduleFlush: !shouldFlushEachChunk,
            contextLabel: 'undoRedo'
        });
        if (queueResult && queueResult.success === false) {
            const queueError = new Error(queueResult.error || 'Failed to queue undo/redo sync operations.');
            if (queueResult.queueFull) {
                queueError.queueFull = true;
            }
            throw queueError;
        }
    };

    for (let start = 0; start < operations.length; start += chunkSize) {
        const chunkIndex = Math.floor(start / chunkSize) + 1;
        const chunk = operations.slice(start, start + chunkSize);
        let chunkQueued = false;

        try {
            await queueChunk(chunk);
            chunkQueued = true;
        } catch (error) {
            if (error?.queueFull) {
                const flushResult = await flushSyncQueue();
                if (flushResult && flushResult.success !== false) {
                    result.flushedDuringQueueing = true;
                    try {
                        await queueChunk(chunk);
                        chunkQueued = true;
                    } catch (retryError) {
                        result.queueError = retryError;
                        break;
                    }
                } else {
                    result.flushError = flushResult?.error || 'Unable to free sync queue space during undo/redo.';
                    result.queueError = error;
                    break;
                }
            } else {
                result.queueError = error;
                break;
            }
        }

        if (!chunkQueued) break;

        result.processed += chunk.length;
        if (onProgress) {
            await onProgress({
                phase: 'queued',
                processed: result.processed,
                total: operations.length,
                chunkIndex,
                totalChunks
            });
        }

        if (shouldFlushEachChunk) {
            const flushResult = await flushSyncQueue();
            if (!flushResult || flushResult.success === false) {
                shouldFlushEachChunk = false;
                result.flushError = flushResult?.error || 'Unable to sync a chunk during undo/redo. Remaining changes were queued for retry.';
                console.warn('[Undo/Redo] Chunk flush failed, switching to queue-only mode:', result.flushError);
            } else {
                result.flushedDuringQueueing = true;
                if (onProgress) {
                    await onProgress({
                        phase: 'synced',
                        processed: result.processed,
                        total: operations.length,
                        chunkIndex,
                        totalChunks
                    });
                }
            }
        }
    }

    if (onProgress) {
        await onProgress({
            phase: 'done',
            processed: result.processed,
            total: operations.length,
            chunkIndex: Math.ceil(result.processed / chunkSize),
            totalChunks
        });
    }

    return result;
}

function createAtomicSyncQueueError(errorOrResult, fallbackMessage = 'Failed to queue sync changes.') {
    const baseError = errorOrResult instanceof Error
        ? errorOrResult
        : null;
    const message = baseError?.message
        || errorOrResult?.error
        || errorOrResult?.message
        || fallbackMessage;
    const error = baseError || new Error(message);

    if (errorOrResult?.queueFull || errorOrResult?.queueError?.queueFull) {
        error.queueFull = true;
    }
    if (errorOrResult?.staleWorkspace || errorOrResult?.queueError?.staleWorkspace) {
        error.staleWorkspace = true;
    }
    if (errorOrResult?.queueError) {
        error.queueError = errorOrResult.queueError;
    }

    return error;
}

function normalizeAtomicSyncOperation(operation) {
    if (!operation) return null;

    const tableName = operation.tableName || operation.table;
    const recordId = operation.recordId || operation.id;
    const opName = operation.operation || operation.op;
    if (!tableName || !recordId || !opName) return null;

    return {
        operation: opName,
        tableName,
        recordId,
        data: operation.data === undefined ? null : operation.data,
        sourceUserId: normalizeSyncSourceUserId(operation.sourceUserId)
    };
}

async function capturePendingSyncQueueStateForOperations(syncOperations = []) {
    if (!db?.syncQueue || typeof db.syncQueue.where !== 'function') {
        return new Map();
    }

    const operations = syncOperations
        .map(normalizeAtomicSyncOperation)
        .filter(Boolean);
    if (operations.length === 0) {
        return new Map();
    }

    const relevantKeys = new Set(
        operations.map(op => getSyncQueueScopeKey(op.tableName, op.recordId, op.sourceUserId))
    );
    const snapshot = new Map(
        Array.from(relevantKeys).map(key => [key, []])
    );

    const pendingItems = await db.syncQueue.where('status').equals('pending').toArray();
    pendingItems.forEach((item) => {
        const key = getSyncQueueScopeKey(item.tableName, item.recordId, item.sourceUserId);
        if (!relevantKeys.has(key)) return;
        snapshot.get(key).push(cloneUndoRedoSnapshot(item));
    });

    return snapshot;
}

async function restorePendingSyncQueueState(snapshot = new Map()) {
    if (!db?.syncQueue || typeof db.syncQueue.where !== 'function' || !(snapshot instanceof Map) || snapshot.size === 0) {
        return;
    }

    const relevantKeys = new Set(snapshot.keys());
    const pendingItems = await db.syncQueue.where('status').equals('pending').toArray();
    const currentItemsForKeys = pendingItems.filter((item) =>
        relevantKeys.has(getSyncQueueScopeKey(item.tableName, item.recordId, item.sourceUserId))
    );

    await db.transaction('rw', db.syncQueue, async () => {
        for (const item of currentItemsForKeys) {
            await db.syncQueue.delete(item.id);
        }

        for (const rows of snapshot.values()) {
            if (!Array.isArray(rows) || rows.length === 0) continue;
            for (const row of rows) {
                await db.syncQueue.put(cloneUndoRedoSnapshot(row));
            }
        }
    });
}

async function rollbackLocalMutationOps(ops = []) {
    const normalizedOps = normalizeUndoRedoOps(ops);
    if (normalizedOps.length === 0) return;

    await db.transaction('rw', db.pages, db.boards, db.bookmarks, async () => {
        for (const op of [...normalizedOps].reverse()) {
            const table = getUndoRedoTable(op.table);
            if (!table) continue;

            const beforeSnapshot = cloneUndoRedoSnapshot(op.before);
            if (beforeSnapshot === null) {
                await table.delete(op.id);
                continue;
            }

            beforeSnapshot.id = op.id;
            await table.put(beforeSnapshot);
        }
    });

    await recalculateEntityCountCaches();
}

async function queuePreparedSyncOperationsInChunks(syncOperations, options = {}) {
    const operations = Array.isArray(syncOperations)
        ? syncOperations.map(normalizeAtomicSyncOperation).filter(Boolean)
        : [];
    const result = {
        total: operations.length,
        processed: 0,
        flushedDuringQueueing: false,
        queueError: null,
        flushError: null
    };
    if (operations.length === 0) return result;

    const syncOptions = normalizeSyncQueueOptions(options);
    const requestedChunkSize = Number(options.chunkSize);
    const chunkSize = Number.isFinite(requestedChunkSize) && requestedChunkSize > 0
        ? Math.max(1, Math.floor(requestedChunkSize))
        : operations.length;
    const flushEachChunk = !!options.flushEachChunk;
    const onProgress = (typeof options.onProgress === 'function') ? options.onProgress : null;
    const totalChunks = Math.ceil(operations.length / chunkSize);

    let shouldFlushEachChunk = flushEachChunk;
    if (flushEachChunk) {
        const preFlushResult = await flushSyncQueue();
        if (!preFlushResult || preFlushResult.success === false) {
            shouldFlushEachChunk = false;
            result.flushError = preFlushResult?.error || 'Unable to sync during chunked queueing. Remaining changes were queued for retry.';
            console.warn('[Sync] Pre-chunk flush failed, continuing queue-only chunking:', result.flushError);
            if (onProgress) {
                await onProgress({
                    phase: 'warning',
                    processed: 0,
                    total: operations.length,
                    chunkIndex: 0,
                    totalChunks
                });
            }
        }
    }

    const queueChunk = async (chunk) => {
        const queueResult = await queueBatchSyncToBackground(chunk, {
            scheduleFlush: !shouldFlushEachChunk && syncOptions.scheduleFlush,
            delayMs: syncOptions.delayMs,
            contextLabel: syncOptions.contextLabel,
            ensureBootstrapPages: false
        });
        if (queueResult && queueResult.success === false) {
            throw createAtomicSyncQueueError(queueResult, 'Failed to queue sync changes.');
        }
    };

    for (let start = 0; start < operations.length; start += chunkSize) {
        const chunkIndex = Math.floor(start / chunkSize) + 1;
        const chunk = operations.slice(start, start + chunkSize);
        let chunkQueued = false;

        try {
            await queueChunk(chunk);
            chunkQueued = true;
        } catch (error) {
            if (error?.queueFull) {
                const flushResult = await flushSyncQueue();
                if (flushResult && flushResult.success !== false) {
                    result.flushedDuringQueueing = true;
                    try {
                        await queueChunk(chunk);
                        chunkQueued = true;
                    } catch (retryError) {
                        result.queueError = createAtomicSyncQueueError(retryError);
                        break;
                    }
                } else {
                    result.flushError = flushResult?.error || 'Unable to free sync queue space during chunked queueing.';
                    result.queueError = createAtomicSyncQueueError(error);
                    break;
                }
            } else {
                result.queueError = createAtomicSyncQueueError(error);
                break;
            }
        }

        if (!chunkQueued) break;

        result.processed += chunk.length;
        if (onProgress) {
            await onProgress({
                phase: 'queued',
                processed: result.processed,
                total: operations.length,
                chunkIndex,
                totalChunks
            });
        }

        if (shouldFlushEachChunk) {
            const flushResult = await flushSyncQueue();
            if (!flushResult || flushResult.success === false) {
                shouldFlushEachChunk = false;
                result.flushError = flushResult?.error || 'Unable to sync a chunk during queueing. Remaining changes were queued for retry.';
                console.warn('[Sync] Chunk flush failed, switching to queue-only mode:', result.flushError);
            } else {
                result.flushedDuringQueueing = true;
                if (onProgress) {
                    await onProgress({
                        phase: 'synced',
                        processed: result.processed,
                        total: operations.length,
                        chunkIndex,
                        totalChunks
                    });
                }
            }
        }
    }

    if (onProgress) {
        await onProgress({
            phase: 'done',
            processed: result.processed,
            total: operations.length,
            chunkIndex: Math.ceil(result.processed / chunkSize),
            totalChunks
        });
    }

    return result;
}

async function queueSyncOperationsAtomically(syncOperations, options = {}) {
    const requestedOperations = Array.isArray(syncOperations)
        ? syncOperations.map(normalizeAtomicSyncOperation).filter(Boolean)
        : [];
    if (requestedOperations.length === 0) {
        return {
            success: true,
            queueResult: {
                total: 0,
                processed: 0,
                flushedDuringQueueing: false,
                queueError: null,
                flushError: null
            },
            operations: [],
            bootstrapPageIds: []
        };
    }

    const syncOptions = normalizeSyncQueueOptions(options);
    const syncScope = await resolveSyncQueueScope(syncOptions);
    if (!syncScope.allowed) {
        notifyStaleWorkspaceMutationBlocked(syncScope.message, {
            contextLabel: syncOptions.contextLabel,
            loadedWorkspaceUserId: syncScope.loadedWorkspaceUserId,
            storedUserId: syncScope.storedUserId
        });
        return {
            success: false,
            staleWorkspace: true,
            error: syncScope.message,
            queueResult: {
                total: requestedOperations.length,
                processed: 0,
                flushedDuringQueueing: false,
                queueError: createAtomicSyncQueueError({
                    staleWorkspace: true,
                    error: syncScope.message
                }, syncScope.message),
                flushError: null
            }
        };
    }

    const scopedOperations = attachSyncSourceUserIdToOperations(requestedOperations, syncScope.sourceUserId)
        .map(normalizeAtomicSyncOperation)
        .filter(Boolean);
    const preparedBundle = syncOptions.ensureBootstrapPages === false
        ? {
            operations: scopedOperations.map(op => ({
                ...op,
                data: stripLocalOnlySyncFields(op.tableName, op.data)
            })),
            bootstrapPageIds: Array.isArray(options?.bootstrapPageIds) ? options.bootstrapPageIds : []
        }
        : await prepareSyncOperationsForQueue(scopedOperations, {
            ...syncOptions,
            sourceUserId: syncScope.sourceUserId
        });

    const preparedOperations = Array.isArray(preparedBundle.operations)
        ? preparedBundle.operations.map(normalizeAtomicSyncOperation).filter(Boolean)
        : [];
    const bootstrapPageIds = Array.isArray(preparedBundle.bootstrapPageIds)
        ? preparedBundle.bootstrapPageIds.filter(Boolean)
        : [];
    if (preparedOperations.length === 0) {
        return {
            success: true,
            queueResult: {
                total: 0,
                processed: 0,
                flushedDuringQueueing: false,
                queueError: null,
                flushError: null
            },
            operations: [],
            bootstrapPageIds
        };
    }

    const queueSnapshot = await capturePendingSyncQueueStateForOperations(preparedOperations);
    const queueResult = await queuePreparedSyncOperationsInChunks(preparedOperations, {
        ...syncOptions,
        ensureBootstrapPages: false
    });

    if (queueResult.queueError) {
        await restorePendingSyncQueueState(queueSnapshot);
        return {
            success: false,
            queueFull: !!queueResult.queueError?.queueFull,
            staleWorkspace: !!queueResult.queueError?.staleWorkspace,
            error: queueResult.queueError?.message || 'Failed to queue sync changes.',
            queueResult,
            operations: preparedOperations,
            bootstrapPageIds
        };
    }

    await clearPendingStartupSyncFlags(bootstrapPageIds);

    return {
        success: true,
        queueResult,
        operations: preparedOperations,
        bootstrapPageIds
    };
}

async function queueSyncItemsAtomically(items, options = {}) {
    const operations = Array.isArray(items)
        ? items.map(item => normalizeAtomicSyncOperation({
            operation: item?.op || item?.operation,
            tableName: item?.table || item?.tableName,
            recordId: item?.id || item?.recordId,
            data: item?.data,
            sourceUserId: item?.sourceUserId
        })).filter(Boolean)
        : [];
    return queueSyncOperationsAtomically(operations, options);
}

async function recalculateEntityCountCaches() {
    try {
        const [nextPageCount, nextBoardCount, nextBookmarkCount] = await Promise.all([
            db.pages.count(),
            db.boards.count(),
            db.bookmarks.count()
        ]);
        pageCount = nextPageCount;
        boardCount = nextBoardCount;
        bookmarkCount = nextBookmarkCount;
    } catch (error) {
        console.warn('[Undo/Redo] Failed to recalculate entity count caches:', error);
    }
}

async function ensureCurrentPageAfterUndoRedo() {
    if (!currentPageId) {
        const pages = await db.pages.filter(p => !p.deletedAt).sortBy('order');
        if (pages.length > 0) {
            currentPageId = pages[0].id;
        }
        return;
    }

    const currentPage = await db.pages.get(currentPageId);
    if (currentPage && !currentPage.deletedAt) return;

    const pages = await db.pages.filter(p => !p.deletedAt).sortBy('order');
    currentPageId = pages.length > 0 ? pages[0].id : null;
}

async function syncCurrentPageToStorage() {
    if (!currentPageId) return;
    if (typeof chrome !== 'undefined' && chrome.storage) {
        chrome.storage.local.set({ currentPageId });
    } else {
        localStorage.setItem('current_page_id', currentPageId.toString());
    }
}

async function applyUndoRedoHistoryEntry(entry, direction) {
    if (!entry || !Array.isArray(entry.ops) || entry.ops.length === 0) return [];

    const orderedOps = direction === 'undo' ? [...entry.ops].reverse() : [...entry.ops];
    const appliedByKey = new Map();
    const mutationTimestamp = getCurrentTimestamp();

    await db.transaction('rw', db.pages, db.boards, db.bookmarks, db.installedWallpapers, db.historyState, async () => {
        for (const op of orderedOps) {
            if (!op?.table || !op?.id) continue;
            const table = getUndoRedoTable(op.table);
            if (!table) continue;

            const snapshot = direction === 'undo'
                ? cloneUndoRedoSnapshot(op.before)
                : cloneUndoRedoSnapshot(op.after);
            const mode = op.mode === 'patch' ? 'patch' : 'replace';

            let appliedSnapshot = snapshot;

            if (snapshot === null) {
                await table.delete(op.id);
            } else {
                if (mode === 'patch') {
                    const existingRow = await table.get(op.id);
                    if (!existingRow) {
                        continue;
                    }
                    const patch = {
                        ...snapshot,
                        updatedAt: mutationTimestamp
                    };
                    await table.update(op.id, patch);
                    appliedSnapshot = {
                        ...existingRow,
                        ...patch,
                        id: op.id
                    };
                } else {
                    snapshot.id = op.id;
                    // Treat undo/redo as a new local mutation so cross-device LWW sync
                    // resolves to this latest user action instead of stale snapshot time.
                    snapshot.updatedAt = mutationTimestamp;
                    await table.put(snapshot);
                    appliedSnapshot = snapshot;
                }
            }

            appliedByKey.set(`${op.table}:${op.id}`, {
                table: op.table,
                id: op.id,
                snapshot: appliedSnapshot
            });
        }

        const state = await ensureUndoRedoHistoryStateRow(db.historyState);
        if (direction === 'undo') {
            state.cursorSeq = Math.max(0, state.cursorSeq - 1);
        } else {
            state.cursorSeq = Math.min(state.headSeq, state.cursorSeq + 1);
        }
        await db.historyState.put(state);
        setUndoRedoHistoryCache(state);
    });

    return Array.from(appliedByKey.values());
}

function getUndoRedoProgressVerb(direction) {
    return direction === 'redo' ? 'redoing' : 'undoing';
}

function showUndoRedoProgressModal(direction, totalChanges = 0) {
    const modal = document.getElementById('undoRedoProgressModal');
    const titleEl = document.getElementById('undoRedoProgressTitle');
    const statusEl = document.getElementById('undoRedoProgressStatusText');
    const barEl = document.getElementById('undoRedoProgressBar');
    if (!modal || !titleEl || !statusEl || !barEl) return false;

    const verb = getUndoRedoProgressVerb(direction);
    titleEl.textContent = `Please wait. We are ${verb} your action.`;
    const totalLabel = Number(totalChanges) > 0
        ? totalChanges.toLocaleString()
        : 'all';
    statusEl.textContent = `Applying ${totalLabel} changes locally...`;
    barEl.style.width = '0%';
    modal.classList.add('active');
    return true;
}

function updateUndoRedoProgressModal(direction, processed, totalChanges, phase = 'syncing') {
    const titleEl = document.getElementById('undoRedoProgressTitle');
    const statusEl = document.getElementById('undoRedoProgressStatusText');
    const barEl = document.getElementById('undoRedoProgressBar');
    if (!titleEl || !statusEl || !barEl) return;

    const verb = getUndoRedoProgressVerb(direction);
    titleEl.textContent = `Please wait. We are ${verb} your action.`;

    const total = Math.max(0, Number(totalChanges) || 0);
    const done = Math.max(0, Math.min(total, Number(processed) || 0));
    const percent = total > 0 ? Math.round((done / total) * 100) : 100;
    barEl.style.width = `${percent}%`;

    if (phase === 'queueing') {
        statusEl.textContent = `Queued ${done.toLocaleString()} of ${total.toLocaleString()} changes...`;
    } else if (phase === 'syncing') {
        statusEl.textContent = `Synced ${done.toLocaleString()} of ${total.toLocaleString()} changes...`;
    } else if (phase === 'finalizing') {
        statusEl.textContent = 'Finalizing undo/redo...';
    } else {
        statusEl.textContent = `Applying ${total.toLocaleString()} changes locally...`;
    }
}

function hideUndoRedoProgressModal() {
    const modal = document.getElementById('undoRedoProgressModal');
    if (!modal) return;
    modal.classList.remove('active');
}

async function refreshTrashModalIfOpen(context = 'unknown') {
    const trashModal = document.getElementById('trashModal');
    if (!trashModal || !trashModal.classList.contains('active')) {
        return;
    }

    try {
        await refreshTrashModal();
    } catch (error) {
        console.warn(`[UI Refresh] Failed to refresh trash modal (${context}):`, error);
    }
}

async function refreshUiAfterUndoRedo(changes = []) {
    if (typeof resetModifierSweepSelectionState === 'function') {
        resetModifierSweepSelectionState();
    }
    if (typeof clearBookmarkSelection === 'function') {
        clearBookmarkSelection();
    }
    if (typeof isSelectionMode !== 'undefined' && isSelectionMode) {
        toggleSelectionMode();
    }

    await recalculateEntityCountCaches();
    await ensureCurrentPageAfterUndoRedo();
    await syncCurrentPageToStorage();
    await loadPagesNavigation({ scrollToActive: false });
    await loadBoardsFromDatabase();
    await refreshTrashModalIfOpen('undo-redo');

    const hasInstalledWallpaperChanges = Array.isArray(changes)
        && changes.some((change) => change?.table === 'installedWallpapers');
    if (!hasInstalledWallpaperChanges) {
        return;
    }

    if (typeof loadInstalledWallpaperCatalog === 'function') {
        try {
            await loadInstalledWallpaperCatalog({ apply: true });
        } catch (error) {
            console.warn('[UI Refresh] Failed to refresh installed wallpapers after undo/redo:', error);
        }
    } else {
        try {
            if (typeof applyActiveThemeWallpaper === 'function') {
                applyActiveThemeWallpaper();
            }
            if (typeof renderWallpaperPopup === 'function') {
                renderWallpaperPopup({ preserveScroll: true });
            }
        } catch (error) {
            console.warn('[UI Refresh] Failed to refresh wallpaper UI after undo/redo:', error);
        }
    }

    if (typeof broadcastInstalledWallpaperCatalogVersionChange === 'function') {
        try {
            await broadcastInstalledWallpaperCatalogVersionChange(getCurrentTimestamp());
        } catch (error) {
            console.warn('[UI Refresh] Failed to broadcast installed wallpaper change after undo/redo:', error);
        }
    }
}

async function undoLastHistoryCommand() {
    if (isApplyingUndoRedoHistory || !isUndoRedoHistoryAvailable()) return false;
    if (typeof canModify === 'function' && !canModify()) return false;

    if (undoRedoBlockedReason) {
        showGlassToast(undoRedoBlockedReason, 'info');
        setUndoRedoBlockedReason(null);
        return false;
    }

    const state = await ensureUndoRedoHistoryStateRow(db.historyState);
    if (state.cursorSeq <= 0) {
        showGlassToast('Nothing to undo', 'info');
        return false;
    }

    let entry = await db.historyEntries.where('seq').equals(state.cursorSeq).first();
    if (!entry) {
        const fallbackEntry = await db.historyEntries.where('seq').belowOrEqual(state.cursorSeq).last();
        if (!fallbackEntry) {
            state.cursorSeq = 0;
            await db.historyState.put(state);
            setUndoRedoHistoryCache(state);
            showGlassToast('Nothing to undo', 'info');
            return false;
        }
        state.cursorSeq = fallbackEntry.seq;
        await db.historyState.put(state);
        setUndoRedoHistoryCache(state);
        entry = fallbackEntry;
    }

    if (isNonUndoRedoHistoryKind(entry.kind)) {
        state.cursorSeq = Math.max(0, entry.seq - 1);
        await db.historyState.put(state);
        setUndoRedoHistoryCache(state);
        showGlassToast('You cannot undo this.', 'info');
        return false;
    }

    isApplyingUndoRedoHistory = true;
    let progressModalVisible = false;

    try {
        const changes = await applyUndoRedoHistoryEntry(entry, 'undo');
        const syncOperations = buildUndoRedoSyncOperations(changes);
        const useChunkedSync = await shouldUseChunkedUndoRedoSync(syncOperations.length);
        if (useChunkedSync && !progressModalVisible) {
            progressModalVisible = showUndoRedoProgressModal('undo', syncOperations.length);
        }
        if (progressModalVisible && !useChunkedSync) {
            hideUndoRedoProgressModal();
            progressModalVisible = false;
        }

        const syncResult = await queueUndoRedoSyncOperations(
            syncOperations,
            useChunkedSync ? {
                chunkSize: DATA_SYNC_UNDO_REDO_SYNC_CHUNK_SIZE,
                flushEachChunk: true,
                onProgress: progressModalVisible
                    ? async ({ phase, processed, total }) => {
                        if (phase === 'queued') {
                            updateUndoRedoProgressModal('undo', processed, total, 'queueing');
                            return;
                        }
                        if (phase === 'synced') {
                            updateUndoRedoProgressModal('undo', processed, total, 'syncing');
                            return;
                        }
                        if (phase === 'done') {
                            updateUndoRedoProgressModal('undo', processed, total, 'finalizing');
                        }
                    }
                    : null
            } : {}
        );

        let syncWarning = null;
        if (syncResult.queueError) {
            syncWarning = syncResult.queueError.queueFull
                ? 'Sync queue is full. Remaining changes will sync after pending items finish.'
                : 'Some changes could not be queued for cloud sync.';
            console.warn('[Undo/Redo] Queueing undo sync changes failed:', syncResult.queueError);
        } else if (syncResult.flushError) {
            syncWarning = syncResult.flushError;
            console.warn('[Undo/Redo] Flushing undo sync chunks failed:', syncResult.flushError);
        }

        await refreshUiAfterUndoRedo(changes);
        broadcastDataChange('undo');

        if (!syncResult.flushedDuringQueueing || syncWarning) {
            const flushResult = await flushSyncQueue();
            if (!flushResult || !flushResult.success) {
                syncWarning = flushResult?.error || 'Cloud sync failed after undo.';
            } else if (!syncResult.queueError) {
                syncWarning = null;
            }
        }

        if (syncWarning) {
            showGlassToast(`Undid: ${entry.label || 'Change'}. Cloud sync is pending and will retry.`, 'warning');
        } else {
            showGlassToast(`Undid: ${entry.label || 'Change'}`, 'success');
        }
        return true;
    } catch (error) {
        console.error('[Undo/Redo] Undo failed:', error);
        showGlassToast('Undo failed. Please try again.', 'error');
        return false;
    } finally {
        if (progressModalVisible) {
            hideUndoRedoProgressModal();
        }
        isApplyingUndoRedoHistory = false;
    }
}

async function redoLastHistoryCommand() {
    if (isApplyingUndoRedoHistory || !isUndoRedoHistoryAvailable()) return false;
    if (typeof canModify === 'function' && !canModify()) return false;

    const state = await ensureUndoRedoHistoryStateRow(db.historyState);
    if (state.cursorSeq >= state.headSeq) {
        showGlassToast('Nothing to redo', 'info');
        return false;
    }

    const nextSeq = state.cursorSeq + 1;
    let entry = await db.historyEntries.where('seq').equals(nextSeq).first();
    if (!entry) {
        const fallbackEntry = await db.historyEntries.where('seq').above(state.cursorSeq).first();
        if (!fallbackEntry) {
            showGlassToast('Nothing to redo', 'info');
            return false;
        }
        state.cursorSeq = Math.max(0, fallbackEntry.seq - 1);
        await db.historyState.put(state);
        setUndoRedoHistoryCache(state);
        entry = fallbackEntry;
    }

    if (isNonUndoRedoHistoryKind(entry.kind)) {
        state.cursorSeq = Math.min(state.headSeq, entry.seq);
        await db.historyState.put(state);
        setUndoRedoHistoryCache(state);
        showGlassToast('You cannot redo this.', 'info');
        return false;
    }

    isApplyingUndoRedoHistory = true;
    let progressModalVisible = false;

    try {
        const changes = await applyUndoRedoHistoryEntry(entry, 'redo');
        const syncOperations = buildUndoRedoSyncOperations(changes);
        const useChunkedSync = await shouldUseChunkedUndoRedoSync(syncOperations.length);
        if (useChunkedSync && !progressModalVisible) {
            progressModalVisible = showUndoRedoProgressModal('redo', syncOperations.length);
        }
        if (progressModalVisible && !useChunkedSync) {
            hideUndoRedoProgressModal();
            progressModalVisible = false;
        }

        const syncResult = await queueUndoRedoSyncOperations(
            syncOperations,
            useChunkedSync ? {
                chunkSize: DATA_SYNC_UNDO_REDO_SYNC_CHUNK_SIZE,
                flushEachChunk: true,
                onProgress: progressModalVisible
                    ? async ({ phase, processed, total }) => {
                        if (phase === 'queued') {
                            updateUndoRedoProgressModal('redo', processed, total, 'queueing');
                            return;
                        }
                        if (phase === 'synced') {
                            updateUndoRedoProgressModal('redo', processed, total, 'syncing');
                            return;
                        }
                        if (phase === 'done') {
                            updateUndoRedoProgressModal('redo', processed, total, 'finalizing');
                        }
                    }
                    : null
            } : {}
        );

        let syncWarning = null;
        if (syncResult.queueError) {
            syncWarning = syncResult.queueError.queueFull
                ? 'Sync queue is full. Remaining changes will sync after pending items finish.'
                : 'Some changes could not be queued for cloud sync.';
            console.warn('[Undo/Redo] Queueing redo sync changes failed:', syncResult.queueError);
        } else if (syncResult.flushError) {
            syncWarning = syncResult.flushError;
            console.warn('[Undo/Redo] Flushing redo sync chunks failed:', syncResult.flushError);
        }

        await refreshUiAfterUndoRedo(changes);
        broadcastDataChange('redo');

        if (!syncResult.flushedDuringQueueing || syncWarning) {
            const flushResult = await flushSyncQueue();
            if (!flushResult || !flushResult.success) {
                syncWarning = flushResult?.error || 'Cloud sync failed after redo.';
            } else if (!syncResult.queueError) {
                syncWarning = null;
            }
        }

        if (syncWarning) {
            showGlassToast(`Redid: ${entry.label || 'Change'}. Cloud sync is pending and will retry.`, 'warning');
        } else {
            showGlassToast(`Redid: ${entry.label || 'Change'}`, 'success');
        }
        return true;
    } catch (error) {
        console.error('[Undo/Redo] Redo failed:', error);
        showGlassToast('Redo failed. Please try again.', 'error');
        return false;
    } finally {
        if (progressModalVisible) {
            hideUndoRedoProgressModal();
        }
        isApplyingUndoRedoHistory = false;
    }
}

function isEditableUndoRedoTarget(target) {
    if (!target) return false;
    if (target.isContentEditable) return true;
    const editableSelector = 'input, textarea, select, [contenteditable="true"], [contenteditable="plaintext-only"]';
    return !!target.closest?.(editableSelector);
}

function isMacPlatformForUndoRedo() {
    const platform = navigator?.userAgentData?.platform || navigator?.platform || '';
    return /mac/i.test(platform);
}

function handleUndoRedoShortcutKeydown(event) {
    if (event.defaultPrevented) return;
    if (event.altKey) return;
    if (isEditableUndoRedoTarget(event.target)) return;

    const key = (event.key || '').toLowerCase();
    const isMac = isMacPlatformForUndoRedo();
    const hasPrimaryModifier = isMac ? event.metaKey : event.ctrlKey;
    if (!hasPrimaryModifier) return;

    const isUndo = key === 'z' && !event.shiftKey;
    const isRedo = (key === 'z' && event.shiftKey) || (!isMac && key === 'y' && !event.shiftKey);
    if (!isUndo && !isRedo) return;

    event.preventDefault();
    event.stopPropagation();

    if (isUndo) {
        void undoLastHistoryCommand();
    } else {
        void redoLastHistoryCommand();
    }
}

function isSyncQueueCapacityError(errorOrMessage) {
    const message = typeof errorOrMessage === 'string'
        ? errorOrMessage
        : (errorOrMessage?.message || '');
    return /sync queue is full|queue is full|queue full/i.test(message);
}

function isBackgroundSyncUnavailableError(errorOrMessage) {
    const message = typeof errorOrMessage === 'string'
        ? errorOrMessage
        : (errorOrMessage?.message || '');
    return /backgroundsync not available|background sync not available/i.test(message);
}

const BACKGROUND_SYNC_PENDING_STORAGE_KEY = 'syncPushPending';

function normalizeSyncQueueOptions(options = {}) {
    const delayMsRaw = Number(options?.delayMs);
    const sourceUserId = (typeof options?.sourceUserId === 'string' && options.sourceUserId.trim())
        ? options.sourceUserId.trim()
        : null;
    return {
        scheduleFlush: options?.scheduleFlush !== false,
        ensureBootstrapPages: options?.ensureBootstrapPages !== false,
        delayMs: Number.isFinite(delayMsRaw) && delayMsRaw >= 0
            ? Math.floor(delayMsRaw)
            : undefined,
        contextLabel: (typeof options?.contextLabel === 'string' && options.contextLabel.trim())
            ? options.contextLabel.trim()
            : 'mutation',
        sourceUserId
    };
}

function stripLocalOnlySyncFields(tableName, data) {
    if (!data || typeof data !== 'object') return data;
    if (tableName !== 'pages') return data;
    if (!Object.prototype.hasOwnProperty.call(data, 'pendingStartupSync')) return data;

    const sanitized = { ...data };
    delete sanitized.pendingStartupSync;
    return sanitized;
}

function normalizeSyncSourceUserId(userId) {
    return (typeof userId === 'string' && userId.trim()) ? userId.trim() : null;
}

function getSyncQueueScopeKey(tableName, recordId, sourceUserId = null) {
    const normalizedSourceUserId = normalizeSyncSourceUserId(sourceUserId) || '__legacy__';
    return `${normalizedSourceUserId}:${tableName}:${recordId}`;
}

function getLoadedWorkspaceOwnerUserId() {
    if (typeof window === 'undefined') return null;
    return normalizeSyncSourceUserId(window.__lumilistWorkspaceOwnerUserId);
}

async function getStoredSyncUserId() {
    if (!(typeof chrome !== 'undefined' && chrome.storage?.local?.get)) {
        return null;
    }

    try {
        const result = await chrome.storage.local.get('lumilist_user');
        return normalizeSyncSourceUserId(result?.lumilist_user?.id);
    } catch (error) {
        console.warn('[Sync] Failed to read stored user for queue scoping:', error);
        return null;
    }
}

function notifyStaleWorkspaceMutationBlocked(message, details = {}) {
    if (!message) return;

    try {
        if (typeof showGlassToast === 'function') {
            showGlassToast(message, 'warning');
        }
    } catch (toastError) {
        console.warn('[Sync] Failed to show stale workspace warning:', toastError);
    }

    try {
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
            window.dispatchEvent(new CustomEvent('lumilist-stale-workspace-blocked', {
                detail: {
                    message,
                    ...details,
                    timestamp: Date.now()
                }
            }));
        }
    } catch (eventError) {
        console.warn('[Sync] Failed to dispatch stale workspace event:', eventError);
    }
}

async function resolveSyncQueueScope(options = {}) {
    const explicitUserId = normalizeSyncSourceUserId(options?.sourceUserId);
    const loadedWorkspaceUserId = getLoadedWorkspaceOwnerUserId();
    const storedUserId = await getStoredSyncUserId();
    const sourceUserId = explicitUserId || loadedWorkspaceUserId || storedUserId || null;

    if (loadedWorkspaceUserId && storedUserId && loadedWorkspaceUserId !== storedUserId) {
        return {
            allowed: false,
            sourceUserId: loadedWorkspaceUserId,
            loadedWorkspaceUserId,
            storedUserId,
            message: 'This tab is out of date after an account change. Reload LumiList before editing.'
        };
    }

    if (loadedWorkspaceUserId && !storedUserId) {
        return {
            allowed: false,
            sourceUserId: loadedWorkspaceUserId,
            loadedWorkspaceUserId,
            storedUserId: null,
            message: 'You are signed out in this tab. Reload LumiList before editing.'
        };
    }

    return {
        allowed: true,
        sourceUserId,
        loadedWorkspaceUserId,
        storedUserId
    };
}

async function ensureLocalMutationSyncScopeAllowed(options = {}) {
    const syncScope = await resolveSyncQueueScope(options);
    if (!syncScope.allowed) {
        notifyStaleWorkspaceMutationBlocked(syncScope.message, {
            contextLabel: options?.contextLabel,
            loadedWorkspaceUserId: syncScope.loadedWorkspaceUserId,
            storedUserId: syncScope.storedUserId
        });
    }
    return syncScope;
}

function attachSyncSourceUserIdToOperations(operations, sourceUserId) {
    const normalizedSourceUserId = normalizeSyncSourceUserId(sourceUserId);
    return Array.isArray(operations)
        ? operations.filter(Boolean).map(op => ({
            ...op,
            sourceUserId: normalizeSyncSourceUserId(op?.sourceUserId) || normalizedSourceUserId
        }))
        : [];
}

async function collectPendingStartupPageSyncOperations() {
    if (!db?.pages || typeof db.pages.toArray !== 'function') return [];

    const allPages = await db.pages.toArray();
    const pendingPages = allPages.filter(page => page?.pendingStartupSync && !page.deletedAt);
    if (pendingPages.length === 0) return [];

    return {
        operations: pendingPages.map(page => ({
            operation: 'upsert',
            tableName: 'pages',
            recordId: page.id,
            data: stripLocalOnlySyncFields('pages', page)
        })),
        pageIds: pendingPages.map(page => page.id)
    };
}

async function prepareSyncOperationsForQueue(operations, options = {}) {
    const normalizedSourceUserId = normalizeSyncSourceUserId(options?.sourceUserId);
    const normalizedOperations = Array.isArray(operations)
        ? operations.filter(Boolean).map(op => ({
            ...op,
            sourceUserId: normalizeSyncSourceUserId(op?.sourceUserId) || normalizedSourceUserId,
            data: stripLocalOnlySyncFields(op.tableName, op.data)
        }))
        : [];

    if (options.ensureBootstrapPages === false) {
        return {
            operations: normalizedOperations,
            bootstrapPageIds: Array.isArray(options?.bootstrapPageIds) ? options.bootstrapPageIds : []
        };
    }

    const bootstrapBundle = await collectPendingStartupPageSyncOperations();
    if (!bootstrapBundle.operations || bootstrapBundle.operations.length === 0) {
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
    ).map(op => ({
        ...op,
        sourceUserId: normalizeSyncSourceUserId(op?.sourceUserId) || normalizedSourceUserId
    }));

    return {
        operations: [...missingBootstrapOps, ...normalizedOperations],
        bootstrapPageIds: bootstrapBundle.pageIds.filter(Boolean)
    };
}

async function clearPendingStartupSyncFlags(pageIds = []) {
    if (!db?.pages || typeof db.pages.get !== 'function' || typeof db.pages.update !== 'function') return;
    const uniquePageIds = [...new Set(pageIds.filter(Boolean))];
    if (uniquePageIds.length === 0) return;

    for (const pageId of uniquePageIds) {
        try {
            const page = await db.pages.get(pageId);
            if (!page?.pendingStartupSync) continue;
            await db.pages.update(pageId, { pendingStartupSync: false });
        } catch (error) {
            console.warn(`[Sync] Failed to clear pendingStartupSync for page ${pageId}:`, error);
        }
    }
}

async function markSyncPushPendingInStorage(options = {}) {
    const syncOptions = normalizeSyncQueueOptions(options);
    if (!syncOptions.scheduleFlush) return;
    if (!(typeof chrome !== 'undefined' && chrome.storage?.local)) return;

    try {
        await chrome.storage.local.set({
            [BACKGROUND_SYNC_PENDING_STORAGE_KEY]: {
                timestamp: Date.now(),
                scheduledAt: new Date().toISOString(),
                source: syncOptions.contextLabel,
                delayMs: syncOptions.delayMs ?? null
            }
        });
    } catch (error) {
        console.warn('[Sync] Failed to persist pending sync marker:', error);
    }
}

let hasLoggedBackgroundSyncFallbackInfo = false;
function logBackgroundSyncFallbackInfo(contextLabel) {
    if (hasLoggedBackgroundSyncFallbackInfo) return;
    hasLoggedBackgroundSyncFallbackInfo = true;
    console.info(`[Sync] ${contextLabel}: background sync unavailable, using IndexedDB fallback.`);
}

// NOTE: triggerSync() removed - all push operations now handled by BackgroundSync.
// queueSyncToBackground()/queueBatchSyncToBackground() schedule background sync by default.

// Queue a sync operation to background service worker
// This ensures the operation is persisted and will sync even if page closes
// FIX [Phase 4]: Added direct IndexedDB fallback when service worker is unavailable
async function queueSyncToBackground(operation, tableName, recordId, data, options = {}) {
    const syncOptions = normalizeSyncQueueOptions(options);
    const syncScope = await resolveSyncQueueScope(syncOptions);
    if (!syncScope.allowed) {
        notifyStaleWorkspaceMutationBlocked(syncScope.message, {
            contextLabel: syncOptions.contextLabel,
            loadedWorkspaceUserId: syncScope.loadedWorkspaceUserId,
            storedUserId: syncScope.storedUserId
        });
        return {
            success: false,
            staleWorkspace: true,
            error: syncScope.message
        };
    }
    const preparedBundle = await prepareSyncOperationsForQueue([{
        operation,
        tableName,
        recordId,
        data,
        sourceUserId: syncScope.sourceUserId
    }], {
        ...syncOptions,
        sourceUserId: syncScope.sourceUserId
    });
    const preparedOperations = preparedBundle.operations;
    const bootstrapPageIds = preparedBundle.bootstrapPageIds;
    const preparedOperation = preparedOperations[preparedOperations.length - 1];
    if (preparedOperations.length > 1) {
        return queueBatchSyncToBackground(preparedOperations, {
            ...syncOptions,
            bootstrapPageIds,
            ensureBootstrapPages: false
        });
    }
    // 🔍 DEBUG: Log every queue operation


    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        try {
            const response = await chrome.runtime.sendMessage({
                action: 'queueSync',
                payload: {
                    operation: preparedOperation.operation,
                    tableName: preparedOperation.tableName,
                    recordId: preparedOperation.recordId,
                    data: preparedOperation.data,
                    sourceUserId: preparedOperation.sourceUserId || null,
                    syncOptions: {
                        schedulePush: syncOptions.scheduleFlush,
                        delayMs: syncOptions.delayMs,
                        contextLabel: syncOptions.contextLabel
                    }
                }
            });

            if (response && response.success === false) {
                const errorMessage = response.error || 'Background queueSync rejected the operation.';
                if (isSyncQueueCapacityError(errorMessage)) {
                    return { success: false, queueFull: true, error: errorMessage };
                }
                throw new Error(errorMessage);
            }

            const result = response || { success: true };
            await clearPendingStartupSyncFlags(bootstrapPageIds);
            return result;
        } catch (error) {
            if (isSyncQueueCapacityError(error)) {
                console.warn('[Sync] queueSync rejected due to queue capacity:', error?.message || error);
                return { success: false, queueFull: true, error: error?.message || String(error) };
            }
            if (isBackgroundSyncUnavailableError(error)) {
                logBackgroundSyncFallbackInfo('queueSync');
            } else {
                console.warn('[Sync] Background queueSync failed, using IndexedDB fallback:', error);
            }
        }
    }

    // FIX [Phase 4]: FALLBACK - Write directly to syncQueue IndexedDB
    // This handles cases where:
    // 1. Service worker is not registered yet
    // 2. Service worker was terminated and hasn't restarted
    // 3. chrome.runtime is unavailable in certain contexts
    try {
        const scopeKey = getSyncQueueScopeKey(
            preparedOperation.tableName,
            preparedOperation.recordId,
            preparedOperation.sourceUserId
        );
        const existing = await db.syncQueue
            .where('tableName').equals(preparedOperation.tableName)
            .filter(item => item.status === 'pending'
                && getSyncQueueScopeKey(item.tableName, item.recordId, item.sourceUserId) === scopeKey)
            .first();

        if (existing) {
            // Update existing pending item with new data (latest wins)
            await db.syncQueue.update(existing.id, {
                operation: preparedOperation.operation,
                data: preparedOperation.data,
                timestamp: Date.now(),
                sourceUserId: preparedOperation.sourceUserId || null
            });
            await markSyncPushPendingInStorage(syncOptions);
            await clearPendingStartupSyncFlags(bootstrapPageIds);
            return { success: true, fallback: 'indexeddb', deduped: true };
        } else {
            const queueCount = await db.syncQueue.count();
            if (queueCount >= DATA_SYNC_SYNC_QUEUE_CAPACITY_LIMIT) {
                return {
                    success: false,
                    queueFull: true,
                    error: 'Sync queue is full. Please wait for pending changes to sync.'
                };
            }

            // Add new item to queue
            await db.syncQueue.add({
                operation: preparedOperation.operation,
                tableName: preparedOperation.tableName,
                recordId: preparedOperation.recordId,
                data: preparedOperation.data,
                sourceUserId: preparedOperation.sourceUserId || null,
                timestamp: Date.now(),
                status: 'pending',
                retryCount: 0
            });
            await markSyncPushPendingInStorage(syncOptions);
            await clearPendingStartupSyncFlags(bootstrapPageIds);
            return { success: true, fallback: 'indexeddb' };
        }
    } catch (dbError) {
        console.error('[Sync] CRITICAL: Failed to queue to IndexedDB:', dbError);
        // At this point, data may be lost if user closes the page
        // This should be extremely rare - both service worker AND IndexedDB failed
        return { success: false, error: dbError?.message || String(dbError) };
    }
}

// Queue multiple sync operations in a single IPC call (for bulk imports)
// FIX [Phase 4]: Added direct IndexedDB fallback when service worker is unavailable
async function queueBatchSyncToBackground(operations, options = {}) {
    if (!operations || operations.length === 0) return;
    const syncOptions = normalizeSyncQueueOptions(options);
    const syncScope = await resolveSyncQueueScope(syncOptions);
    if (!syncScope.allowed) {
        notifyStaleWorkspaceMutationBlocked(syncScope.message, {
            contextLabel: syncOptions.contextLabel,
            loadedWorkspaceUserId: syncScope.loadedWorkspaceUserId,
            storedUserId: syncScope.storedUserId
        });
        return {
            success: false,
            staleWorkspace: true,
            error: syncScope.message
        };
    }
    const scopedOperations = attachSyncSourceUserIdToOperations(operations, syncScope.sourceUserId);
    const preparedBundle = syncOptions.ensureBootstrapPages === false
        ? {
            operations: Array.isArray(scopedOperations)
                ? scopedOperations.filter(Boolean).map(op => ({
                    ...op,
                    data: stripLocalOnlySyncFields(op.tableName, op.data)
                }))
                : [],
            bootstrapPageIds: Array.isArray(options?.bootstrapPageIds) ? options.bootstrapPageIds : []
        }
        : await prepareSyncOperationsForQueue(scopedOperations, {
            ...syncOptions,
            sourceUserId: syncScope.sourceUserId
        });
    const preparedOperations = preparedBundle.operations;
    const bootstrapPageIds = preparedBundle.bootstrapPageIds;
    if (preparedOperations.length === 0) {
        return { success: true, skipped: true };
    }

    // 🔍 DEBUG: Log batch queue operation


    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        try {
            const response = await chrome.runtime.sendMessage({
                action: 'queueBatchSync',
                payload: {
                    operations: preparedOperations,
                    syncOptions: {
                        schedulePush: syncOptions.scheduleFlush,
                        delayMs: syncOptions.delayMs,
                        contextLabel: syncOptions.contextLabel
                    }
                }
            });

            if (response && response.success === false) {
                const errorMessage = response.error || 'Background queueBatchSync rejected the batch.';
                if (isSyncQueueCapacityError(errorMessage)) {
                    return { success: false, queueFull: true, error: errorMessage };
                }
                throw new Error(errorMessage);
            }

            const result = response || { success: true };
            await clearPendingStartupSyncFlags(bootstrapPageIds);
            return result;
        } catch (error) {
            if (isSyncQueueCapacityError(error)) {
                console.warn('[Sync] queueBatchSync rejected due to queue capacity:', error?.message || error);
                return { success: false, queueFull: true, error: error?.message || String(error) };
            }
            if (isBackgroundSyncUnavailableError(error)) {
                logBackgroundSyncFallbackInfo('queueBatchSync');
            } else {
                console.warn('[Sync] Background queueBatchSync failed, using IndexedDB fallback:', error);
            }
        }
    }

    // FIX [Phase 4]: FALLBACK - Write directly to syncQueue IndexedDB
    // Uses the same logic as individual queueSyncToBackground for consistency
    try {
        // Get all pending items for efficient deduplication
        const pendingItems = await db.syncQueue.where('status').equals('pending').toArray();
        const existingMap = new Map(
            pendingItems.map(item => [getSyncQueueScopeKey(item.tableName, item.recordId, item.sourceUserId), item])
        );

        const updates = [];
        const inserts = [];
        const pendingInserts = new Map(); // Track within-batch duplicates
        const now = Date.now();

        for (const op of preparedOperations) {
            const key = getSyncQueueScopeKey(op.tableName, op.recordId, op.sourceUserId);
            const existing = existingMap.get(key);
            const pendingIndex = pendingInserts.get(key);

            if (existing) {
                // Update existing DB item
                updates.push({
                    id: existing.id,
                    changes: {
                        operation: op.operation,
                        data: op.data,
                        timestamp: now,
                        sourceUserId: op.sourceUserId || null
                    }
                });
            } else if (pendingIndex !== undefined) {
                // Within-batch duplicate: update the pending insert (latest wins)
                inserts[pendingIndex] = {
                    ...inserts[pendingIndex],
                    operation: op.operation,
                    data: op.data,
                    sourceUserId: op.sourceUserId || null,
                    timestamp: now
                };
            } else {
                // New item to insert
                inserts.push({
                    operation: op.operation,
                    tableName: op.tableName,
                    recordId: op.recordId,
                    data: op.data,
                    sourceUserId: op.sourceUserId || null,
                    timestamp: now,
                    status: 'pending',
                    retryCount: 0
                });
                pendingInserts.set(key, inserts.length - 1);
            }
        }

        await db.transaction('rw', db.syncQueue, async () => {
            if (inserts.length > 0) {
                const currentCount = await db.syncQueue.count();
                const availableSpace = DATA_SYNC_SYNC_QUEUE_CAPACITY_LIMIT - currentCount;
                if (availableSpace < inserts.length) {
                    throw new Error('Sync queue is full. Please wait for pending changes to sync.');
                }
            }

            // Apply updates
            for (const { id, changes } of updates) {
                await db.syncQueue.update(id, changes);
            }

            // Bulk add new items
            if (inserts.length > 0) {
                await db.syncQueue.bulkAdd(inserts);
            }
        });

        await markSyncPushPendingInStorage(syncOptions);
        await clearPendingStartupSyncFlags(bootstrapPageIds);
        return { success: true, added: inserts.length, updated: updates.length, fallback: 'indexeddb' };
    } catch (dbError) {
        if (isSyncQueueCapacityError(dbError)) {
            return { success: false, queueFull: true, error: dbError?.message || String(dbError) };
        }

        console.error('[Sync] CRITICAL: Batch queue to IndexedDB failed:', dbError);
        // Last resort: try individual queuing
        console.error('[Sync] Attempting individual fallback queueing...');
        const fallbackErrors = [];
        for (const op of preparedOperations) {
            const result = await queueSyncToBackground(op.operation, op.tableName, op.recordId, op.data, {
                ...syncOptions,
                ensureBootstrapPages: false,
                scheduleFlush: false
            });
            if (result && result.success === false) {
                fallbackErrors.push(result);
            }
        }
        if (fallbackErrors.length > 0) {
            const queueFullError = fallbackErrors.find(item => item.queueFull);
            return {
                success: false,
                queueFull: !!queueFullError,
                error: queueFullError?.error || fallbackErrors[0].error || 'Failed to queue some sync operations.'
            };
        }
        await markSyncPushPendingInStorage(syncOptions);
        await clearPendingStartupSyncFlags(bootstrapPageIds);
        return { success: true, fallback: 'indexeddb-individual' };
    }
}

// Flush all queued sync operations to the server
// Call this AFTER all items are queued to ensure complete sync before page close
// FIX: Now waits for server push to complete before returning
async function flushSyncQueue() {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        try {
            const response = await chrome.runtime.sendMessage({ action: 'forcePush' });
            if (response && !response.success) {
                if (isBackgroundSyncUnavailableError(response.error)) {
                    logBackgroundSyncFallbackInfo('forcePush');
                } else {
                    console.warn('[Sync] Force push failed:', response.error);
                }
            }
            return response;
        } catch (error) {
            if (isBackgroundSyncUnavailableError(error)) {
                logBackgroundSyncFallbackInfo('flushSyncQueue');
            } else {
                console.warn('[Sync] Failed to flush queue:', error);
            }
        }
    }
}

// FIX [Critical #5]: Use unique broadcast ID instead of time-based boolean flag
// The old 500ms timeout could be bypassed if storage listener fired late due to latency
// Using a unique ID ensures we always correctly identify our own broadcasts
// FIX [Issue #2]: Use a Set instead of single ID to handle rapid consecutive broadcasts
// where the storage listener fires after a subsequent broadcast overwrites lastBroadcastId
const ownBroadcastIds = new Set();
const OWN_BROADCAST_CLEANUP_DELAY = 5000; // Clean up IDs after 5 seconds

// Broadcast data change to other tabs (they reload from IndexedDB, no server ping)
function broadcastDataChange(source = 'edit') {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        // Generate unique broadcast ID for this specific broadcast
        const broadcastId = Date.now() + '-' + Math.random().toString(36).slice(2, 11);

        // FIX [Issue #2]: Add to Set BEFORE storage.set to prevent timing race
        // The storage listener might fire immediately after set() returns
        ownBroadcastIds.add(broadcastId);

        chrome.storage.local.set({
            reloadBoardsSignal: {
                timestamp: Date.now(),
                source: source,
                broadcastId: broadcastId  // Unique ID to detect self-broadcast
            }
        });

        // Clean up old broadcast IDs after delay to prevent memory leak
        setTimeout(() => {
            ownBroadcastIds.delete(broadcastId);
        }, OWN_BROADCAST_CLEANUP_DELAY);


    }
}

// Helper function to detect and handle storage quota exceeded errors
function isQuotaExceededError(error) {
    if (!error) return false;
    // Check error name (standard QuotaExceededError)
    if (error.name === 'QuotaExceededError') return true;
    // Check for Dexie-wrapped quota errors
    if (error.inner?.name === 'QuotaExceededError') return true;
    // Check error message for quota/storage keywords
    const message = (error.message || '').toLowerCase();
    return message.includes('quota') || message.includes('storage') || message.includes('disk');
}

// Wrapper for db.pages.add with timestamps + auto-sync + cross-tab broadcast
async function addPage(pageData, options = {}) {
    // Check subscription status before modifying data
    if (typeof canModify === 'function' && !canModify()) return null;

    // Check page limit (instant local cache check)
    const limitCheck = checkPageLimit(1);
    if (!limitCheck.allowed) {
        console.warn('[Page Limit] Cannot add page:', limitCheck.warning);
        showGlassToast(limitCheck.warning, 'error');
        return null;
    }

    try {
        const syncScope = await ensureLocalMutationSyncScopeAllowed({
            ...options,
            contextLabel: options.contextLabel || 'addPage'
        });
        if (!syncScope.allowed) return null;

        // Generate UUID client-side (no ID remapping needed!)
        const id = generateId();
        const dataWithId = { 
            id, 
            ...withTimestamps({
                ...pageData,
                password: pageData.password || null
            }) 
        };
        await db.pages.add(dataWithId);

        // Increment local count cache
        pageCount++;

        // Queue to background sync (await ensures message is sent before function returns)
        const queueResult = await queueSyncToBackground('upsert', 'pages', id, dataWithId);
        if (queueResult?.success === false) {
            await db.pages.delete(id);
            pageCount = Math.max(0, pageCount - 1);
            if (queueResult.staleWorkspace) {
                return null;
            }
            throw createAtomicSyncQueueError(queueResult, queueResult.error || 'Failed to queue new page for sync.');
        }

        broadcastDataChange('addPage');

        // Show warning toast if approaching limit (only after first crossing threshold)
        if (limitCheck.warning && pageCount === PAGE_WARNING_THRESHOLD + 1) {
            showGlassToast(limitCheck.warning, 'info');
        } else if (limitCheck.warning && pageCount === PAGE_CRITICAL_THRESHOLD + 1) {
            showGlassToast(limitCheck.warning, 'warning');
        }

        if (!options.skipHistory && !isApplyingUndoRedoHistory) {
            await recordUndoRedoHistoryEntry({
                kind: options.historyKind || 'page_add',
                label: options.historyLabel || `Add page "${dataWithId.name || 'Untitled'}"`,
                ops: [{ table: 'pages', id, before: null, after: dataWithId }]
            });
        }

        return id;
    } catch (error) {
        console.error('addPage failed:', error);
        // SECURITY: Provide user feedback for quota exceeded errors
        if (isQuotaExceededError(error)) {
            console.error('[Storage] Quota exceeded while adding page');
            showGlassToast('Storage full. Please delete some data or clear browser storage.', 'error');
        }
        throw error;
    }
}


// Wrapper for db.boards.add with timestamps + auto-sync + cross-tab broadcast
async function addBoard(boardData, options = {}) {
    // Check subscription status before modifying data
    if (typeof canModify === 'function' && !canModify()) return null;

    // Check board limit (instant local cache check)
    const limitCheck = checkBoardLimit(1);
    if (!limitCheck.allowed) {
        console.warn('[Board Limit] Cannot add board:', limitCheck.warning);
        showGlassToast(limitCheck.warning, 'error');
        return null;
    }

    try {
        const syncScope = await ensureLocalMutationSyncScopeAllowed({
            ...options,
            contextLabel: options.contextLabel || 'addBoard'
        });
        if (!syncScope.allowed) return null;

        // Generate UUID client-side (no ID remapping needed!)
        const id = generateId();
        const dataWithId = { id, ...withTimestamps(boardData) };
        await db.boards.add(dataWithId);

        // Increment local count cache
        boardCount++;

        // Queue to background sync (await ensures message is sent before function returns)
        const queueResult = await queueSyncToBackground('upsert', 'boards', id, dataWithId);
        if (queueResult?.success === false) {
            await db.boards.delete(id);
            boardCount = Math.max(0, boardCount - 1);
            if (queueResult.staleWorkspace) {
                return null;
            }
            throw createAtomicSyncQueueError(queueResult, queueResult.error || 'Failed to queue new board for sync.');
        }

        broadcastDataChange('addBoard');

        // Show warning toast if approaching limit (only after first crossing threshold)
        if (limitCheck.warning && boardCount === BOARD_WARNING_THRESHOLD + 1) {
            showGlassToast(limitCheck.warning, 'info');
        } else if (limitCheck.warning && boardCount === BOARD_CRITICAL_THRESHOLD + 1) {
            showGlassToast(limitCheck.warning, 'warning');
        }

        if (!options.skipHistory && !isApplyingUndoRedoHistory) {
            await recordUndoRedoHistoryEntry({
                kind: options.historyKind || 'board_add',
                label: options.historyLabel || `Add board "${dataWithId.name || 'Untitled'}"`,
                ops: [{ table: 'boards', id, before: null, after: dataWithId }]
            });
        }

        return id;
    } catch (error) {
        console.error('addBoard failed:', error);
        // SECURITY: Provide user feedback for quota exceeded errors
        if (isQuotaExceededError(error)) {
            console.error('[Storage] Quota exceeded while adding board');
            showGlassToast('Storage full. Please delete some data or clear browser storage.', 'error');
        }
        throw error;
    }
}


function getBookmarkMetadata(url, title, description) {
    let folder = null;
    let tags = [];

    if (window.smartFoldersEnabled) {
        try {
            const urlObj = new URL(url);
            const domain = urlObj.hostname.toLowerCase();
            
            if (domain.includes('youtube.com') || domain.includes('vimeo.com') || domain.includes('netflix.com')) {
                folder = "Videos";
            } else if (domain.includes('github.com') || domain.includes('gitlab.com') || domain.includes('stackoverflow.com')) {
                folder = "Development";
            } else if (url.includes('docs') || url.includes('tutorial') || url.includes('learning')) {
                folder = "Learning";
            } else if (domain.includes('google.com') || domain.includes('bing.com')) {
                folder = "Search";
            } else if (domain.includes('facebook.com') || domain.includes('twitter.com') || domain.includes('linkedin.com')) {
                folder = "Social";
            }
        } catch (e) {
            // Invalid URL, skip smart folder
        }
    }

    if (window.taggingEnabled) {
        const text = ((title || '') + ' ' + (description || '')).toLowerCase();
        if (text.includes('work') || text.includes('office') || text.includes('job')) tags.push('work');
        if (text.includes('study') || text.includes('course') || text.includes('university')) tags.push('study');
        if (text.includes('tool') || text.includes('app') || text.includes('utility')) tags.push('tools');
        if (text.includes('video') || text.includes('movie') || text.includes('watch')) tags.push('video');
        if (text.includes('dev') || text.includes('code') || text.includes('program')) tags.push('dev');
        
        // Add domain as tag if no tags yet
        if (tags.length === 0 && url) {
            try {
                const domain = new URL(url).hostname.replace('www.', '').split('.')[0];
                if (domain.length > 2) tags.push(domain);
            } catch(e) {}
        }
    }

    return { folder, tags: tags.join(', ') };
}

async function getOrCreateSmartFolderBoard(folderName) {
    if (!folderName || !currentPageId) return null;

    try {
        // Try to find an existing board with this name on the current page
        const existingBoard = await db.boards
            .where('pageId').equals(currentPageId)
            .filter(b => b.name === folderName && !b.deletedAt)
            .first();

        if (existingBoard) return existingBoard.id;

        // If not found, create a new one
        const newBoard = await addBoard({
            name: folderName,
            pageId: currentPageId,
            columnIndex: 0, // Default to first column
            order: 0
        }, { skipHistory: true });

        return newBoard?.id;
    } catch (error) {
        console.error('Failed to get/create smart folder board:', error);
        return null;
    }
}

// Wrapper for db.bookmarks.add with timestamps + auto-sync + cross-tab broadcast
async function addBookmark(bookmarkData, options = {}) {
    // Check subscription status before modifying data
    if (typeof canModify === 'function' && !canModify()) return null;

    // Check bookmark limit (instant local cache check)
    const limitCheck = checkBookmarkLimit(1);
    if (!limitCheck.allowed) {
        console.warn('[Bookmark Limit] Cannot add bookmark:', limitCheck.warning);
        showGlassToast(limitCheck.warning, 'error');
        return null;
    }

    try {
        const syncScope = await ensureLocalMutationSyncScopeAllowed({
            ...options,
            contextLabel: options.contextLabel || 'addBookmark'
        });
        if (!syncScope.allowed) return null;

        // Generate UUID client-side (no ID remapping needed!)
        const id = generateId();
        
        // Apply Smart Folders and Tagging if enabled
        const metadata = getBookmarkMetadata(bookmarkData.url, bookmarkData.title, bookmarkData.description);
        
        let boardId = bookmarkData.boardId;
        if (window.smartFoldersEnabled && metadata.folder) {
            const smartBoardId = await getOrCreateSmartFolderBoard(metadata.folder);
            if (smartBoardId) {
                boardId = smartBoardId;
            }
        }

        const dataWithMetadata = {
            ...bookmarkData,
            boardId,
            folder: metadata.folder,
            tags: metadata.tags
        };

        const dataWithId = { id, ...withTimestamps(dataWithMetadata) };
        await db.bookmarks.add(dataWithId);

        // Increment local count cache
        bookmarkCount++;

        // Queue to background sync (await ensures message is sent before function returns)
        const queueResult = await queueSyncToBackground('upsert', 'bookmarks', id, dataWithId);
        if (queueResult?.success === false) {
            await db.bookmarks.delete(id);
            bookmarkCount = Math.max(0, bookmarkCount - 1);
            if (queueResult.staleWorkspace) {
                return null;
            }
            throw createAtomicSyncQueueError(queueResult, queueResult.error || 'Failed to queue new bookmark for sync.');
        }

        broadcastDataChange('addBookmark');

        // Show warning toast if approaching limit (only after first crossing threshold)
        if (limitCheck.warning && bookmarkCount === BOOKMARK_WARNING_THRESHOLD + 1) {
            showGlassToast(limitCheck.warning, 'info');
        } else if (limitCheck.warning && bookmarkCount === BOOKMARK_CRITICAL_THRESHOLD + 1) {
            showGlassToast(limitCheck.warning, 'warning');
        }

        if (!options.skipHistory && !isApplyingUndoRedoHistory) {
            await recordUndoRedoHistoryEntry({
                kind: options.historyKind || 'bookmark_add',
                label: options.historyLabel || `Add bookmark "${dataWithId.title || 'Untitled'}"`,
                ops: [{ table: 'bookmarks', id, before: null, after: dataWithId }]
            });
        }

        return id;
    } catch (error) {
        console.error('addBookmark failed:', error);
        // SECURITY: Provide user feedback for quota exceeded errors
        if (isQuotaExceededError(error)) {
            console.error('[Storage] Quota exceeded while adding bookmark');
            showGlassToast('Storage full. Please delete some bookmarks or clear browser storage.', 'error');
        }
        throw error;
    }
}

// Bulk add bookmarks with batched IndexedDB writes and IPC calls (for Chrome import)
// Does NOT call broadcastDataChange - caller should call it once after all bookmarks are added
// NOTE: Does NOT check bookmark limit - caller must check limit and potentially truncate list before calling
async function bulkAddBookmarks(bookmarksData, options = {}) {
    // Check subscription status before modifying data
    if (typeof canModify === 'function' && !canModify()) return [];
    if (!bookmarksData || bookmarksData.length === 0) return [];

    const syncScope = await ensureLocalMutationSyncScopeAllowed({
        ...options,
        contextLabel: options.contextLabel || 'bulkAddBookmarks'
    });
    if (!syncScope.allowed) return [];

    const now = getCurrentTimestamp();
    const preparedBookmarks = bookmarksData.map(data => {
        const metadata = getBookmarkMetadata(data.url, data.title, data.description);
        return {
            id: generateId(),
            ...data,
            folder: metadata.folder,
            tags: metadata.tags,
            createdAt: now,
            updatedAt: now,
            deletedAt: null
        };
    });
    const localOps = preparedBookmarks.map(bookmark => ({
        table: 'bookmarks',
        id: bookmark.id,
        before: null,
        after: bookmark
    }));

    // 🔍 DEBUG: Log created bookmark IDs


    try {
        // Single bulk IndexedDB write
        await db.bookmarks.bulkAdd(preparedBookmarks);


        // Update local count cache
        bookmarkCount += preparedBookmarks.length;

        // Queue sync operations in chunks so very large imports can scale without queue overflow.
        const syncOperations = preparedBookmarks.map(bm => ({
            operation: 'upsert',
            tableName: 'bookmarks',
            recordId: bm.id,
            data: bm
        }));
        const requestedChunkSize = Number(options.syncChunkSize);
        const syncChunkSize = Number.isFinite(requestedChunkSize) && requestedChunkSize > 0
            ? Math.max(1, Math.floor(requestedChunkSize))
            : Math.min(250, Math.max(1, syncOperations.length));
        const queueAttempt = await queueSyncOperationsAtomically(syncOperations, {
            chunkSize: syncChunkSize,
            contextLabel: options.contextLabel || 'bulkAddBookmarks',
            flushEachChunk: false
        });
        if (!queueAttempt.success) {
            await rollbackLocalMutationOps(localOps);
            throw createAtomicSyncQueueError(queueAttempt, queueAttempt.error || 'Failed to queue imported bookmarks for sync.');
        }
        if (queueAttempt.queueResult?.flushError) {
            console.warn('[bulkAddBookmarks] Chunked sync flush warning:', queueAttempt.queueResult.flushError);
        }

        if (!options.skipHistory && !isApplyingUndoRedoHistory) {
            await recordUndoRedoHistoryEntry({
                kind: options.historyKind || 'bookmark_bulk_add',
                label: options.historyLabel || (
                    preparedBookmarks.length === 1
                        ? 'Add 1 bookmark'
                        : `Add ${preparedBookmarks.length} bookmarks`
                ),
                ops: preparedBookmarks.map(bookmark => ({
                    table: 'bookmarks',
                    id: bookmark.id,
                    before: null,
                    after: bookmark
                }))
            });
        }


        return preparedBookmarks.map(bm => bm.id);
    } catch (error) {
        console.error('bulkAddBookmarks failed:', error);
        throw error;
    }
}


// Wrapper for db.pages.update with updatedAt + auto-sync + cross-tab broadcast
async function updatePage(pageId, updateData, options = {}) {
    // Check subscription status before modifying data
    if (typeof canModify === 'function' && !canModify()) return null;

    // Validate ID to prevent database errors (IDs are now UUIDs)
    if (!pageId) {
        console.error('updatePage called with invalid pageId:', pageId);
        return 0;
    }

    try {
        const syncScope = await ensureLocalMutationSyncScopeAllowed({
            ...options,
            contextLabel: options.contextLabel || 'updatePage'
        });
        if (!syncScope.allowed) return 0;

        const beforePage = await db.pages.get(pageId);
        const result = await db.pages.update(pageId, withUpdatedAt(updateData));

        // Only sync if update was successful (result > 0)
        if (result > 0) {
            const page = await db.pages.get(pageId);
            if (page) {
                const queueResult = await queueSyncToBackground('upsert', 'pages', pageId, page);
                if (queueResult?.success === false) {
                    if (beforePage) {
                        await db.pages.put(beforePage);
                    }
                    if (!queueResult.staleWorkspace) {
                        throw createAtomicSyncQueueError(queueResult, queueResult.error || 'Failed to queue page update for sync.');
                    }
                    return 0;
                }
            }
            broadcastDataChange('updatePage');

            if (!options.skipHistory && !isApplyingUndoRedoHistory && beforePage) {
                const historyLabel = options.historyLabel
                    || (Object.prototype.hasOwnProperty.call(updateData, 'name') ? `Rename page to "${page?.name || ''}"` : 'Edit page');
                await recordUndoRedoHistoryEntry({
                    kind: options.historyKind || 'page_update',
                    label: historyLabel,
                    ops: [{ table: 'pages', id: pageId, before: beforePage, after: page }]
                });
            }
        } else {
            console.warn('updatePage: Record not found for pageId:', pageId);
        }
        return result;
    } catch (error) {
        console.error('updatePage failed:', error);
        // SECURITY: Provide user feedback for quota exceeded errors
        if (isQuotaExceededError(error)) {
            console.error('[Storage] Quota exceeded while updating page');
            showGlassToast('Storage full. Please delete some data or clear browser storage.', 'error');
        }
        throw error;
    }
}

// Wrapper for db.boards.update with updatedAt + auto-sync + cross-tab broadcast
async function updateBoard(boardId, updateData, options = {}) {
    // Check subscription status before modifying data
    if (typeof canModify === 'function' && !canModify()) return null;

    // Validate ID to prevent database errors (IDs are now UUIDs)
    if (!boardId) {
        console.error('updateBoard called with invalid boardId:', boardId);
        return 0;
    }

    try {
        const syncScope = await ensureLocalMutationSyncScopeAllowed({
            ...options,
            contextLabel: options.contextLabel || 'updateBoard'
        });
        if (!syncScope.allowed) return 0;

        const beforeBoard = await db.boards.get(boardId);
        const result = await db.boards.update(boardId, withUpdatedAt(updateData));

        // Only sync if update was successful (result > 0)
        if (result > 0) {
            const board = await db.boards.get(boardId);
            if (board) {
                const queueResult = await queueSyncToBackground('upsert', 'boards', boardId, board);
                if (queueResult?.success === false) {
                    if (beforeBoard) {
                        await db.boards.put(beforeBoard);
                    }
                    if (!queueResult.staleWorkspace) {
                        throw createAtomicSyncQueueError(queueResult, queueResult.error || 'Failed to queue board update for sync.');
                    }
                    return 0;
                }
            }
            broadcastDataChange('updateBoard');

            if (!options.skipHistory && !isApplyingUndoRedoHistory && beforeBoard) {
                const historyLabel = options.historyLabel
                    || (Object.prototype.hasOwnProperty.call(updateData, 'name') ? `Rename board to "${board?.name || ''}"` : 'Edit board');
                await recordUndoRedoHistoryEntry({
                    kind: options.historyKind || 'board_update',
                    label: historyLabel,
                    ops: [{ table: 'boards', id: boardId, before: beforeBoard, after: board }]
                });
            }
        } else {
            console.warn('updateBoard: Record not found for boardId:', boardId);
        }
        return result;
    } catch (error) {
        console.error('updateBoard failed:', error);
        // SECURITY: Provide user feedback for quota exceeded errors
        if (isQuotaExceededError(error)) {
            console.error('[Storage] Quota exceeded while updating board');
            showGlassToast('Storage full. Please delete some data or clear browser storage.', 'error');
        }
        throw error;
    }
}

// Wrapper for db.bookmarks.update with updatedAt + auto-sync + cross-tab broadcast
async function updateBookmark(bookmarkId, updateData, options = {}) {
    // Check subscription status before modifying data
    if (typeof canModify === 'function' && !canModify()) return null;

    // Validate ID to prevent database errors (IDs are now UUIDs)
    if (!bookmarkId) {
        console.error('updateBookmark called with invalid bookmarkId:', bookmarkId);
        return 0;
    }

    try {
        const syncScope = await ensureLocalMutationSyncScopeAllowed({
            ...options,
            contextLabel: options.contextLabel || 'updateBookmark'
        });
        if (!syncScope.allowed) return 0;

        const beforeBookmark = await db.bookmarks.get(bookmarkId);
        const result = await db.bookmarks.update(bookmarkId, withUpdatedAt(updateData));

        // Only sync if update was successful (result > 0)
        if (result > 0) {
            const bookmark = await db.bookmarks.get(bookmarkId);
            if (bookmark) {
                const queueResult = await queueSyncToBackground('upsert', 'bookmarks', bookmarkId, bookmark);
                if (queueResult?.success === false) {
                    if (beforeBookmark) {
                        await db.bookmarks.put(beforeBookmark);
                    }
                    if (!queueResult.staleWorkspace) {
                        throw createAtomicSyncQueueError(queueResult, queueResult.error || 'Failed to queue bookmark update for sync.');
                    }
                    return 0;
                }
            }
            broadcastDataChange('updateBookmark');

            if (!options.skipHistory && !isApplyingUndoRedoHistory && beforeBookmark) {
                const historyLabel = options.historyLabel
                    || (Object.prototype.hasOwnProperty.call(updateData, 'title') || Object.prototype.hasOwnProperty.call(updateData, 'url')
                        ? `Edit bookmark "${bookmark?.title || ''}"`
                        : 'Edit bookmark');
                await recordUndoRedoHistoryEntry({
                    kind: options.historyKind || 'bookmark_update',
                    label: historyLabel,
                    ops: [{ table: 'bookmarks', id: bookmarkId, before: beforeBookmark, after: bookmark }]
                });
            }
        } else {
            console.warn('updateBookmark: Record not found for bookmarkId:', bookmarkId);
        }
        return result;
    } catch (error) {
        console.error('updateBookmark failed:', error);
        // SECURITY: Provide user feedback for quota exceeded errors
        if (isQuotaExceededError(error)) {
            console.error('[Storage] Quota exceeded while updating bookmark');
            showGlassToast('Storage full. Please delete some bookmarks or clear browser storage.', 'error');
        }
        throw error;
    }
}


// Listen for page ID remapping from sync.js
if (typeof chrome !== 'undefined' && chrome.storage) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
        try {
            if (areaName === 'local' && changes.pageIdRemapped) {
                const remapping = changes.pageIdRemapped.newValue;
                if (remapping && remapping.oldId && remapping.newId) {
                    const { oldId, newId } = remapping;
                    // Update currentPageId if it matches
                    if (currentPageId === oldId) {

                        currentPageId = newId;
                    }
                    // Also update dragOriginPageId if it matches (prevents cross-page detection bugs)
                    if (dragOriginPageId === oldId) {

                        dragOriginPageId = newId;
                    }
                }
            }
        } catch (error) {
            console.error('Error in pageIdRemapped handler:', error);
        }
    });
}
