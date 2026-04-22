/**
 * LumiList Background Sync Module
 *
 * Handles all sync operations in the service worker context using direct REST API calls.
 * This ensures sync happens even when user navigates away from the newtab page.
 */

// Supabase Configuration (must match supabase.js)
const SUPABASE_URL = 'https://xbccmcszhnybxzlirjgk.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhiY2NtY3N6aG55Ynh6bGlyamdrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzAyMTY1MjQsImV4cCI6MjA4NTc5MjUyNH0.BIJgjvzh2XBWBphVgU4O6XWh3dm8Sk1G1ycqt0okY9w';

// Auth token storage key - derived from SUPABASE_URL to stay in sync with Supabase client
// Format: sb-{project-ref}-auth-token
const AUTH_TOKEN_KEY = `sb-${new URL(SUPABASE_URL).hostname.split('.')[0]}-auth-token`;

// Custom error for auth failures (401/403) - don't retry these
class AuthError extends Error {
    constructor(message, status) {
        super(message);
        this.name = 'AuthError';
        this.status = status;
    }
}

// Non-retryable authorization failure (for example RLS/subscription policy deny)
class AuthorizationPolicyError extends Error {
    constructor(message, status) {
        super(message);
        this.name = 'AuthorizationPolicyError';
        this.status = status;
    }
}

// Intentional sync cancellation (for example logout/account switch while a push is running)
class PushCancelledError extends Error {
    constructor(message) {
        super(message);
        this.name = 'PushCancelledError';
    }
}

// Sync configuration
const SYNC_DEBOUNCE_MS = 500;      // Debounce time before actual sync (reduced from 2000ms)
const MAX_RETRY_COUNT = 5;          // Max retries for failed sync
const MAX_QUEUE_SIZE = 120000;      // Must stay above supported import scale (100,000 bookmarks + metadata)
const MAX_QUEUE_ITEMS_PER_RUN = 1000; // Process queue in bounded slices so each push stays responsive
const UPSERT_CHUNK_SIZE = 250;      // Split large upsert payloads to avoid request timeouts
const BG_SYNC_DEBUG_LOGS = false;   // Set true only when diagnosing sync internals
const AUTH_ERROR_BACKOFF_MS = 10 * 60 * 1000; // Pause retries for same invalid token (10 min)
const TRANSIENT_RETRY_BASE_MS = 5000; // Initial retry delay for transient network/backend failures
const TRANSIENT_RETRY_MAX_MS = 60000; // Cap retry delay so recovery still happens promptly
const TRANSIENT_RETRY_JITTER_MS = 1000; // Add jitter to avoid retry synchronization bursts
const SYNC_AUTH_ERROR_STATE_KEY = 'syncAuthErrorState';
const SYNC_QUEUE_OWNER_STORAGE_KEY = 'syncQueueOwnerUserId';

// In-memory state (service worker context)
let _pushTimeout = null;
let _isPushing = false;
let _transientBackoffUntil = 0;
let _transientRetryDelayMs = TRANSIENT_RETRY_BASE_MS;

// FIX [Critical #11]: Promise-based lock to prevent concurrent processSyncQueue execution
// The boolean _isPushing check had a race condition where two concurrent calls could
// both pass the check before either set the flag. This Promise-based approach ensures
// subsequent callers wait for the current operation to complete.
let _pushPromise = null;
let _pushCancellationGeneration = 0;
const _activePushAbortControllers = new Set();

function debugLog(...args) {
    if (BG_SYNC_DEBUG_LOGS) {
        console.log(...args);
    }
}

function cancelActivePush(reason = 'cancelled') {
    _pushCancellationGeneration += 1;
    for (const controller of _activePushAbortControllers) {
        try {
            controller.abort(reason);
        } catch (error) {
            try {
                controller.abort();
            } catch (abortError) {
                console.warn('[BackgroundSync] Failed to abort active push controller:', abortError);
            }
        }
    }
}

function throwIfPushCancelled(pushGeneration, contextLabel = 'sync queue push') {
    if (pushGeneration !== _pushCancellationGeneration) {
        throw new PushCancelledError(`Push cancelled during ${contextLabel}`);
    }
}

function getTransientBackoffRemainingMs() {
    const remaining = _transientBackoffUntil - Date.now();
    return remaining > 0 ? remaining : 0;
}

function markTransientBackoff() {
    const jitter = Math.floor(Math.random() * TRANSIENT_RETRY_JITTER_MS);
    const delayMs = Math.min(TRANSIENT_RETRY_MAX_MS, _transientRetryDelayMs + jitter);
    _transientBackoffUntil = Date.now() + delayMs;
    _transientRetryDelayMs = Math.min(TRANSIENT_RETRY_MAX_MS, Math.max(TRANSIENT_RETRY_BASE_MS, _transientRetryDelayMs * 2));
    console.warn(`[BackgroundSync] Transient retry backoff enabled for ${Math.ceil(delayMs / 1000)}s`);
    return delayMs;
}

function clearTransientBackoff() {
    _transientBackoffUntil = 0;
    _transientRetryDelayMs = TRANSIENT_RETRY_BASE_MS;
}

async function ensureBackgroundSyncDbReady() {
    if (typeof db === 'undefined') {
        throw new Error('Background sync database is unavailable');
    }

    if (typeof db.isOpen === 'function' && db.isOpen()) {
        return true;
    }

    if (typeof ensureDbReady === 'function') {
        const ready = await ensureDbReady();
        if (!ready) {
            throw new Error('Background sync database could not be opened');
        }
        return true;
    }

    if (typeof db.open === 'function') {
        await db.open();
    }

    if (typeof db.isOpen === 'function' && !db.isOpen()) {
        throw new Error('Background sync database is unavailable');
    }

    return true;
}

function getTokenFingerprint(token) {
    if (!token || typeof token !== 'string') return null;
    if (token.length <= 24) return token;
    return `${token.slice(0, 12)}...${token.slice(-12)}`;
}

function summarizeAuthError(errorText, maxLength = 220) {
    if (!errorText || typeof errorText !== 'string') return '';
    const normalized = errorText.replace(/\s+/g, ' ').trim();
    return normalized.length > maxLength
        ? `${normalized.slice(0, maxLength)}...`
        : normalized;
}

async function setAuthErrorState(accessToken, status, errorText) {
    const tokenFingerprint = getTokenFingerprint(accessToken);
    if (!tokenFingerprint) return;

    try {
        await chrome.storage.local.set({
            [SYNC_AUTH_ERROR_STATE_KEY]: {
                tokenFingerprint,
                status,
                error: summarizeAuthError(errorText),
                timestamp: Date.now(),
                recordedAt: new Date().toISOString()
            }
        });
    } catch (error) {
        console.warn('[BackgroundSync] Failed to persist auth error state:', error?.message || error);
    }
}

function parseStoredSession(rawSession) {
    if (!rawSession) return null;
    if (typeof rawSession === 'object') return rawSession;
    if (typeof rawSession !== 'string') return null;

    try {
        return JSON.parse(rawSession);
    } catch (error) {
        console.error('[BackgroundSync] Failed to parse session JSON:', error);
        return null;
    }
}

function getSessionExpiryMs(session) {
    if (!session || !Number.isFinite(Number(session.expires_at))) return null;
    return Number(session.expires_at) * 1000;
}

function isTokenExpired(session) {
    const expiresMs = getSessionExpiryMs(session);
    if (!expiresMs) return false;
    return expiresMs <= Date.now();
}

function isLikelyRlsPolicyError(errorText) {
    const normalized = String(errorText || '').toLowerCase();
    return (
        normalized.includes('row-level security') ||
        normalized.includes('violates row level security') ||
        normalized.includes('violates row-level security') ||
        normalized.includes('new row violates') ||
        normalized.includes('permission denied for table') ||
        normalized.includes('insufficient_privilege')
    );
}

function extractStatusFromError(error) {
    if (!error) return null;

    const directStatus = Number(error.status || error.statusCode);
    if (Number.isFinite(directStatus)) return directStatus;

    const message = String(error?.message || error || '');
    const match = message.match(/\b(4\d{2}|5\d{2})\b/);
    if (match) {
        return Number(match[1]);
    }

    return null;
}

function isLikelyTransientSyncError(error) {
    if (!error) return false;
    if (error instanceof AuthError || error instanceof AuthorizationPolicyError) return false;

    const status = extractStatusFromError(error);
    if (status === 408 || status === 425 || status === 429) return true;
    if (status !== null && status >= 500 && status <= 599) return true;

    const message = String(error?.message || error || '').toLowerCase();
    return message.includes('failed to fetch') ||
        message.includes('networkerror') ||
        message.includes('network request failed') ||
        message.includes('network connection was lost') ||
        message.includes('timed out') ||
        message.includes('timeout') ||
        message.includes('service unavailable') ||
        message.includes('temporarily unavailable') ||
        message.includes('bad gateway') ||
        message.includes('gateway timeout') ||
        message.includes('too many requests') ||
        message.includes('connection reset') ||
        message.includes('connection aborted') ||
        message.includes('dns');
}

async function keepItemsPendingForTransientFailure(items, error, contextLabel = 'sync') {
    if (!Array.isArray(items) || items.length === 0) return 0;

    const summary = summarizeAuthError(String(error?.message || error || 'Transient sync error'), 260);
    const timestamp = new Date().toISOString();
    let updatedCount = 0;

    for (const item of items) {
        try {
            await db.syncQueue.update(item.queueId, {
                status: 'pending',
                lastError: summary,
                lastAttemptAt: timestamp
            });
            updatedCount++;
        } catch (updateError) {
            console.error(`[BackgroundSync] Failed to keep queue item ${item.queueId} pending:`, updateError);
        }
    }

    console.warn(`[BackgroundSync] ${contextLabel}: deferred ${updatedCount} item(s) due transient backend/network issue`);
    return updatedCount;
}

/**
 * Get auth token from chrome.storage
 * The page-side Supabase client owns refresh-token rotation. Background sync only
 * consumes the current access token and pauses when the session needs page-driven
 * re-authentication or refresh, which avoids multi-context refresh-token races.
 *
 * @returns {Promise<{accessToken: string, userId: string}|null>}
 */
async function getAuthInfo() {
    try {
        const result = await chrome.storage.local.get([AUTH_TOKEN_KEY, 'LumiList_user', SYNC_AUTH_ERROR_STATE_KEY]);
        const rawSession = result[AUTH_TOKEN_KEY];
        const session = parseStoredSession(rawSession);
        const user = result.LumiList_user || session?.user || null;
        const authErrorState = result[SYNC_AUTH_ERROR_STATE_KEY];

        if (!session?.access_token) {
            console.log('[BackgroundSync] Not authenticated - missing access token');
            return null;
        }

        let userId = user?.id || session?.user?.id || null;
        if (!userId) {
            console.log('[BackgroundSync] Not authenticated - missing user id in storage/session');
            return null;
        }

        const tokenFingerprint = getTokenFingerprint(session.access_token);

        // If the current token already failed auth, wait for the page context to refresh or re-auth.
        if (authErrorState?.tokenFingerprint) {
            if (authErrorState.tokenFingerprint !== tokenFingerprint) {
                await chrome.storage.local.remove(SYNC_AUTH_ERROR_STATE_KEY);
            } else {
                const ageMs = Date.now() - Number(authErrorState.timestamp || 0);
                if (Number.isFinite(ageMs) && ageMs < AUTH_ERROR_BACKOFF_MS) {
                    const remainingSec = Math.ceil((AUTH_ERROR_BACKOFF_MS - ageMs) / 1000);
                    console.log(`[BackgroundSync] Auth backoff active for current token (${remainingSec}s remaining), waiting for page session refresh`);
                    return null;
                } else {
                    await chrome.storage.local.remove(SYNC_AUTH_ERROR_STATE_KEY);
                }
            }
        }

        if (isTokenExpired(session)) {
            await setAuthErrorState(session.access_token, 401, 'Access token expired; waiting for page session refresh');
            console.log('[BackgroundSync] Access token expired; waiting for page context to refresh the session');
            return null;
        }

        return {
            accessToken: session.access_token,
            userId
        };
    } catch (error) {
        console.error('[BackgroundSync] Error getting auth info:', error);
        return null;
    }
}

/**
 * Convert local camelCase data to server snake_case format
 * @param {boolean} isUpsert - If true, includes created_at timestamp for UPSERT operations.
 * Note: updated_at is still client-authored for UX/display, but sync precedence now
 * uses server-issued sync_version returned after the write succeeds.
 * FIX [Phase 2]: Always include created_at for UPSERT to handle both INSERT and UPDATE
 */
function getLocalOrServerField(record, camelKey, snakeKey, fallback = undefined) {
    if (record && record[camelKey] !== undefined) {
        return record[camelKey];
    }
    if (snakeKey && record && record[snakeKey] !== undefined) {
        return record[snakeKey];
    }
    return fallback;
}

function convertPageToServerFormat(page, userId, isUpsert = false) {
    const updatedAt = getLocalOrServerField(page, 'updatedAt', 'updated_at', new Date().toISOString());
    const data = {
        id: getLocalOrServerField(page, 'id', 'id'),  // Client-generated UUID
        user_id: userId,
        name: getLocalOrServerField(page, 'name', 'name'),
        order: getLocalOrServerField(page, 'order', 'order', 0) ?? 0,
        is_default: getLocalOrServerField(page, 'isDefault', 'is_default', false) ?? false,
        deleted_at: getLocalOrServerField(page, 'deletedAt', 'deleted_at', null) ?? null,
        share_id: getLocalOrServerField(page, 'shareId', 'share_id', null) ?? null,
        // FIX: Always include updated_at - client is source of truth for timestamps
        // Server triggers have been removed to prevent overwriting local timestamps
        updated_at: updatedAt
    };

    // FIX [Phase 2]: Always include created_at for UPSERT operations
    // This is needed because UPSERT might INSERT (needs created_at) or UPDATE (ignores it)
    if (isUpsert) {
        data.created_at = getLocalOrServerField(page, 'createdAt', 'created_at', updatedAt);
    }

    return data;
}


/**
 * Convert board to server format
 * @param {boolean} isUpsert - If true, includes created_at for UPSERT operations
 * FIX [Phase 2]: Always include created_at for UPSERT to handle both INSERT and UPDATE
 */
function convertBoardToServerFormat(board, userId, isUpsert = false) {
    const updatedAt = getLocalOrServerField(board, 'updatedAt', 'updated_at', new Date().toISOString());
    const data = {
        id: getLocalOrServerField(board, 'id', 'id'),  // Client-generated UUID
        user_id: userId,
        page_id: getLocalOrServerField(board, 'pageId', 'page_id', null),
        name: getLocalOrServerField(board, 'name', 'name'),
        column_index: getLocalOrServerField(board, 'columnIndex', 'column_index', 0) ?? 0,
        order: getLocalOrServerField(board, 'order', 'order', 0) ?? 0,
        color: getLocalOrServerField(board, 'color', 'color', null) ?? null,
        deleted_at: getLocalOrServerField(board, 'deletedAt', 'deleted_at', null) ?? null,
        share_id: getLocalOrServerField(board, 'shareId', 'share_id', null) ?? null,
        // FIX: Always include updated_at - client is source of truth for timestamps
        updated_at: updatedAt
    };

    // FIX [Phase 2]: Always include created_at for UPSERT operations
    if (isUpsert) {
        data.created_at = getLocalOrServerField(board, 'createdAt', 'created_at', updatedAt);
    }

    return data;
}


/**
 * Convert bookmark to server format
 * @param {boolean} isUpsert - If true, includes created_at for UPSERT operations
 * FIX [Phase 2]: Always include created_at for UPSERT to handle both INSERT and UPDATE
 */
function convertBookmarkToServerFormat(bookmark, userId, isUpsert = false) {
    const updatedAt = getLocalOrServerField(bookmark, 'updatedAt', 'updated_at', new Date().toISOString());
    const data = {
        id: getLocalOrServerField(bookmark, 'id', 'id'),  // Client-generated UUID
        user_id: userId,
        board_id: getLocalOrServerField(bookmark, 'boardId', 'board_id', null),
        title: getLocalOrServerField(bookmark, 'title', 'title'),
        url: getLocalOrServerField(bookmark, 'url', 'url'),
        description: getLocalOrServerField(bookmark, 'description', 'description', null) ?? null,
        order: getLocalOrServerField(bookmark, 'order', 'order', 0) ?? 0,
        deleted_at: getLocalOrServerField(bookmark, 'deletedAt', 'deleted_at', null) ?? null,
        // FIX: Always include updated_at - client is source of truth for timestamps
        updated_at: updatedAt
    };

    // FIX [Phase 2]: Always include created_at for UPSERT operations
    if (isUpsert) {
        data.created_at = getLocalOrServerField(bookmark, 'createdAt', 'created_at', updatedAt);
    }

    return data;
}

function convertSyncMetadataToServerFormat(syncMetadata, userId) {
    const data = {
        user_id: userId
    };

    if (syncMetadata?.theme_mode === 'dark' || syncMetadata?.theme_mode === 'light') {
        data.theme_mode = syncMetadata.theme_mode;
    }

    if (syncMetadata && Object.prototype.hasOwnProperty.call(syncMetadata, 'wallpaper_selection')) {
        data.wallpaper_selection = syncMetadata.wallpaper_selection || { dark: null, light: null };
    }

    if (syncMetadata && Object.prototype.hasOwnProperty.call(syncMetadata, 'wallpaper_installs')) {
        data.wallpaper_installs = Array.isArray(syncMetadata.wallpaper_installs)
            ? syncMetadata.wallpaper_installs
            : [];
    }

    if (syncMetadata?.wallpaper_preferences_updated_at) {
        data.wallpaper_preferences_updated_at = syncMetadata.wallpaper_preferences_updated_at;
    }

    return data;
}

function normalizeSyncVersionValue(value) {
    if (value === null || value === undefined || value === '') {
        return null;
    }

    try {
        const normalized = BigInt(value);
        return normalized > 0n ? normalized.toString() : null;
    } catch (error) {
        return null;
    }
}

function getLocalTableForSync(tableName) {
    if (tableName === 'pages') return db.pages;
    if (tableName === 'boards') return db.boards;
    if (tableName === 'bookmarks') return db.bookmarks;
    return null;
}

function buildConfirmedRowMap(rows = []) {
    return new Map((rows || []).map((row) => [row.id, row]));
}

async function persistConfirmedUpsertMetadata(tableName, item, confirmedRow) {
    const table = getLocalTableForSync(tableName);
    if (!table || !item?.recordId || !confirmedRow) return;

    const localRow = await table.get(item.recordId);
    if (!localRow) return;

    const nextSyncVersion = normalizeSyncVersionValue(confirmedRow.sync_version ?? confirmedRow.syncVersion ?? null);
    const queuedUpdatedAt = getLocalOrServerField(item.data, 'updatedAt', 'updated_at', null);
    const localUpdatedAt = getLocalOrServerField(localRow, 'updatedAt', 'updated_at', null);
    const shouldRefreshWallClockFields = queuedUpdatedAt && localUpdatedAt === queuedUpdatedAt;

    const changes = {};
    if (nextSyncVersion) {
        changes.syncVersion = nextSyncVersion;
    }

    if (shouldRefreshWallClockFields) {
        const confirmedUpdatedAt = confirmedRow.updated_at ?? confirmedRow.updatedAt ?? null;
        const confirmedCreatedAt = confirmedRow.created_at ?? confirmedRow.createdAt ?? null;
        if (confirmedUpdatedAt) {
            changes.updatedAt = confirmedUpdatedAt;
        }
        if (confirmedCreatedAt) {
            changes.createdAt = confirmedCreatedAt;
        }
    }

    if (Object.keys(changes).length === 0) return;
    await table.update(item.recordId, changes);
}


/**
 * Make authenticated request to Supabase REST API
 * FIX [Issue #9]: Added 30-second timeout to prevent sync hanging forever
 * @param {string} endpoint - API endpoint (can include query params)
 * @param {string} method - HTTP method
 * @param {object|null} body - Request body
 * @param {string} accessToken - Auth token
 * @param {boolean} isUpsert - If true, uses resolution=merge-duplicates header
 */
const SUPABASE_REQUEST_TIMEOUT_MS = 30000; // 30 seconds

async function supabaseRequest(endpoint, method, body, accessToken, isUpsert = false, requestOptions = {}) {
    const url = `${SUPABASE_URL}/rest/v1/${endpoint}`;
    const externalAbortSignal = requestOptions.abortSignal || null;

    const headers = {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${accessToken}`,
        'Prefer': (method === 'POST' && isUpsert) ? 'resolution=merge-duplicates,return=representation' : 'return=representation'
    };

    // FIX [Issue #9]: Add AbortController for timeout
    const controller = new AbortController();
    let removeExternalAbortListener = null;
    const timeoutId = setTimeout(() => {
        controller.abort();
    }, SUPABASE_REQUEST_TIMEOUT_MS);

    if (externalAbortSignal) {
        if (externalAbortSignal.aborted) {
            controller.abort();
        } else {
            const forwardAbort = () => controller.abort();
            externalAbortSignal.addEventListener('abort', forwardAbort, { once: true });
            removeExternalAbortListener = () => {
                externalAbortSignal.removeEventListener('abort', forwardAbort);
            };
        }
    }

    const options = {
        method,
        headers,
        signal: controller.signal
    };

    if (body && (method === 'POST' || method === 'PATCH')) {
        options.body = JSON.stringify(body);
    }

    try {
        const response = await fetch(url, options);
        clearTimeout(timeoutId);
        if (removeExternalAbortListener) removeExternalAbortListener();

        if (!response.ok) {
            const errorText = await response.text();

            // Background sync does not rotate refresh tokens; page context owns session refresh.
            if (response.status === 401 || response.status === 403) {
                const isPolicyError = response.status === 403 && isLikelyRlsPolicyError(errorText);

                if (!isPolicyError) {
                    await setAuthErrorState(accessToken, response.status, errorText);
                    console.error(`[BackgroundSync] Auth error ${response.status} - waiting for page session refresh or re-auth`);
                } else {
                    const policySummary = summarizeAuthError(errorText, 220);
                    console.warn(`[BackgroundSync] Authorization policy denied ${method} ${endpoint}: ${policySummary}`);
                    throw new AuthorizationPolicyError(`Authorization policy denied: ${response.status} - ${errorText}`, response.status);
                }

                throw new AuthError(`Auth failed: ${response.status} - ${errorText}`, response.status);
            }

            throw new Error(`Supabase ${method} ${endpoint} failed: ${response.status} - ${errorText}`);
        }

        // FIX [Phase 5]: Parse DELETE response for server confirmation
        // Supabase with 'return=representation' returns array of deleted rows
        // This allows us to verify which items were actually deleted
        //
        // Handle empty responses gracefully (204 No Content or empty body)
        // JSON parse errors should NOT cause DELETE to fail - the HTTP 200 confirms success
        const text = await response.text();
        if (!text || text.trim() === '') {
            return [];  // Empty response = no rows affected (already deleted)
        }
        try {
            return JSON.parse(text);
        } catch (parseError) {
            console.warn(`[BackgroundSync] Failed to parse ${method} response as JSON, treating as empty:`, parseError.message);
            return [];  // Unparseable response for successful request = treat as empty
        }
    } catch (error) {
        clearTimeout(timeoutId);
        if (removeExternalAbortListener) removeExternalAbortListener();
        if (error.name === 'AbortError') {
            if (externalAbortSignal?.aborted) {
                throw new PushCancelledError(`Push cancelled during ${method} ${endpoint}`);
            }
            throw new Error(`Supabase ${method} ${endpoint} timed out after ${SUPABASE_REQUEST_TIMEOUT_MS / 1000}s`);
        }
        throw error;
    }
}

/**
 * Fetch existing IDs for a table that belong to the current user
 * This is needed to distinguish between "update existing" vs "insert new" operations
 * FIX [Phase 1]: Added AbortController with 30s timeout
 */
async function getServerIds(tableName, accessToken, userId) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SUPABASE_REQUEST_TIMEOUT_MS);

    try {
        const url = `${SUPABASE_URL}/rest/v1/${tableName}?select=id&user_id=eq.${userId}`;
        const response = await fetch(url, {
            headers: {
                'apikey': SUPABASE_ANON_KEY,
                'Authorization': `Bearer ${accessToken}`
            },
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
            console.error(`[BackgroundSync] Failed to fetch ${tableName} IDs:`, response.status);
            return new Set();
        }

        const data = await response.json();
        return new Set(data.map(item => item.id));
    } catch (error) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') {
            console.error(`[BackgroundSync] Timeout fetching ${tableName} IDs after ${SUPABASE_REQUEST_TIMEOUT_MS / 1000}s`);
        } else {
            console.error(`[BackgroundSync] Error fetching ${tableName} IDs:`, error);
        }
        return new Set();
    }
}

/**
 * Batch fetch all user's IDs in a single RPC call
 * Falls back to individual getServerIds() calls if RPC fails
 * FIX [Phase 1]: Added AbortController with 30s timeout
 */
async function getAllServerIds(accessToken, userId) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SUPABASE_REQUEST_TIMEOUT_MS);

    try {
        const url = `${SUPABASE_URL}/rest/v1/rpc/get_all_user_ids`;
        debugLog('[BackgroundSync] 🔍 Fetching all server IDs via RPC...');
        const startTime = Date.now();

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'apikey': SUPABASE_ANON_KEY,
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            body: '{}',
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        const elapsed = Date.now() - startTime;
        console.log(`[BackgroundSync] RPC response in ${elapsed}ms, status: ${response.status}`);

        if (!response.ok) {
            console.warn(`[BackgroundSync] RPC failed (${response.status}), falling back to individual calls`);
            return await getAllServerIdsFallback(accessToken, userId);
        }

        const data = await response.json();
        debugLog(`[BackgroundSync] 🔍 Server IDs fetched: ${data.pageIds?.length || 0} pages, ${data.boardIds?.length || 0} boards, ${data.bookmarkIds?.length || 0} bookmarks`);

        // DEBUG: Log first 10 bookmark IDs from server
        if (data.bookmarkIds && data.bookmarkIds.length > 0) {
            debugLog(`[BackgroundSync] Server bookmark IDs (first 10):`, data.bookmarkIds.slice(0, 10));
        }

        return {
            pageIds: Array.isArray(data.pageIds) ? data.pageIds : [],
            boardIds: Array.isArray(data.boardIds) ? data.boardIds : [],
            bookmarkIds: Array.isArray(data.bookmarkIds) ? data.bookmarkIds : []
        };
    } catch (error) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') {
            console.warn(`[BackgroundSync] RPC timeout after ${SUPABASE_REQUEST_TIMEOUT_MS / 1000}s, falling back to individual calls`);
        } else {
            console.warn('[BackgroundSync] RPC error, falling back to individual calls:', error.message);
        }
        return await getAllServerIdsFallback(accessToken, userId);
    }
}

/**
 * Fallback: fetch IDs using individual getServerIds() calls
 */
async function getAllServerIdsFallback(accessToken, userId) {
    console.log('[BackgroundSync] Using fallback (3 individual calls)...');
    const [pageIds, boardIds, bookmarkIds] = await Promise.all([
        getServerIds('pages', accessToken, userId),
        getServerIds('boards', accessToken, userId),
        getServerIds('bookmarks', accessToken, userId)
    ]);

    console.log(`[BackgroundSync] Fallback fetched: ${pageIds.size} pages, ${boardIds.size} boards, ${bookmarkIds.size} bookmarks`);

    return {
        pageIds: Array.from(pageIds),
        boardIds: Array.from(boardIds),
        bookmarkIds: Array.from(bookmarkIds)
    };
}

function normalizeQueueSourceUserId(userId) {
    return (typeof userId === 'string' && userId.trim()) ? userId.trim() : null;
}

function getQueueScopeKey(tableName, recordId, sourceUserId = null) {
    const normalizedSourceUserId = normalizeQueueSourceUserId(sourceUserId) || '__legacy__';
    return `${normalizedSourceUserId}:${tableName}:${recordId}`;
}

function resolveQueueItemSourceUserId(item, ownerHintUserId = null) {
    return normalizeQueueSourceUserId(item?.sourceUserId) || normalizeQueueSourceUserId(ownerHintUserId);
}

function isQueueItemForDifferentUser(item, activeUserId, ownerHintUserId = null) {
    const normalizedActiveUserId = normalizeQueueSourceUserId(activeUserId);
    const normalizedItemUserId = resolveQueueItemSourceUserId(item, ownerHintUserId);
    if (!normalizedActiveUserId || !normalizedItemUserId) return false;
    return normalizedItemUserId !== normalizedActiveUserId;
}

function partitionPendingItemsByUserScope(items, activeUserId, ownerHintUserId = null) {
    const allowedItems = [];
    const mismatchedItems = [];

    for (const item of Array.isArray(items) ? items : []) {
        if (isQueueItemForDifferentUser(item, activeUserId, ownerHintUserId)) {
            mismatchedItems.push(item);
            continue;
        }
        allowedItems.push(item);
    }

    return { allowedItems, mismatchedItems };
}

async function getSyncQueueOwnerUserId() {
    if (!(typeof chrome !== 'undefined' && chrome.storage?.local?.get)) {
        return null;
    }

    try {
        const result = await chrome.storage.local.get(SYNC_QUEUE_OWNER_STORAGE_KEY);
        return normalizeQueueSourceUserId(result?.[SYNC_QUEUE_OWNER_STORAGE_KEY]);
    } catch (error) {
        console.warn('[BackgroundSync] Failed to read queue owner user id:', error);
        return null;
    }
}

async function persistSyncQueueOwnerUserId(sourceUserId) {
    const normalizedSourceUserId = normalizeQueueSourceUserId(sourceUserId);
    if (!normalizedSourceUserId) return;
    if (!(typeof chrome !== 'undefined' && chrome.storage?.local)) return;

    try {
        const currentOwnerUserId = await getSyncQueueOwnerUserId();
        if (currentOwnerUserId && currentOwnerUserId !== normalizedSourceUserId) {
            console.warn('[BackgroundSync] Multiple queue owner candidates detected; clearing queue owner hint');
            await chrome.storage.local.remove(SYNC_QUEUE_OWNER_STORAGE_KEY);
            return;
        }

        await chrome.storage.local.set({
            [SYNC_QUEUE_OWNER_STORAGE_KEY]: normalizedSourceUserId
        });
    } catch (error) {
        console.warn('[BackgroundSync] Failed to persist queue owner user id:', error);
    }
}

async function clearSyncQueueOwnerUserId() {
    if (!(typeof chrome !== 'undefined' && chrome.storage?.local?.remove)) {
        return;
    }

    try {
        await chrome.storage.local.remove(SYNC_QUEUE_OWNER_STORAGE_KEY);
    } catch (error) {
        console.warn('[BackgroundSync] Failed to clear queue owner user id:', error);
    }
}

async function maybeClearSyncQueueOwnerUserId() {
    try {
        const [pending, processing] = await Promise.all([
            db.syncQueue.where('status').equals('pending').count(),
            db.syncQueue.where('status').equals('processing').count()
        ]);

        if (pending === 0 && processing === 0) {
            await clearSyncQueueOwnerUserId();
        }
    } catch (error) {
        console.warn('[BackgroundSync] Failed to clear queue owner hint after drain:', error);
    }
}

async function markItemsAsUserScopeFailed(items, activeUserId, ownerHintUserId = null) {
    if (!Array.isArray(items) || items.length === 0) return;

    const failedAt = new Date().toISOString();
    const normalizedActiveUserId = normalizeQueueSourceUserId(activeUserId);

    for (const item of items) {
        const queueId = item?.queueId || item?.id;
        if (!queueId) continue;

        try {
            await db.syncQueue.update(queueId, {
                status: 'failed',
                retryCount: MAX_RETRY_COUNT,
                lastError: `Queue item belongs to a different account session and was blocked. Active user: ${normalizedActiveUserId || 'unknown'}.`,
                failedAt,
                sourceUserId: resolveQueueItemSourceUserId(item, ownerHintUserId)
            });
        } catch (error) {
            console.error(`[BackgroundSync] Failed to mark mismatched queue item ${queueId} as failed:`, error);
        }
    }

    console.warn(`[BackgroundSync] Blocked ${items.length} queue item(s) from a different account session`);
}

/**
 * Compact pending sync queue items by keeping only the latest per record.
 * Returns the number of items removed.
 */
async function compactPendingSyncQueue() {
    try {
        const pendingItems = await db.syncQueue.where('status').equals('pending').toArray();
        if (pendingItems.length <= 1) return 0;

        const latestByKey = new Map();
        const idsToDelete = [];

        for (const item of pendingItems) {
            const key = getQueueScopeKey(item.tableName, item.recordId, item.sourceUserId);
            const existing = latestByKey.get(key);
            if (!existing) {
                latestByKey.set(key, item);
                continue;
            }
            const existingTs = existing.timestamp || 0;
            const itemTs = item.timestamp || 0;
            if (itemTs >= existingTs) {
                idsToDelete.push(existing.id);
                latestByKey.set(key, item);
            } else {
                idsToDelete.push(item.id);
            }
        }

        if (idsToDelete.length > 0) {
            await db.syncQueue.bulkDelete(idsToDelete);
        }

        return idsToDelete.length;
    } catch (error) {
        console.warn('[BackgroundSync] Failed to compact pending queue:', error);
        return 0;
    }
}

/**
 * Add operation to sync queue with deduplication
 * If a pending item with the same tableName and recordId exists, update it instead of creating a new one.
 * This prevents race conditions when the same record is queued multiple times during drag operations.
 * @param {Object} operation - { operation: 'upsert'|'delete', tableName: string, recordId: number, data: object }
 */
async function addToSyncQueue(operation) {
    // 🔍 DEBUG: Log every queue addition
    debugLog('🔍 [DEBUG addToSyncQueue] Adding to queue:', {
        operation: operation.operation,
        tableName: operation.tableName,
        recordId: operation.recordId,
        dataTitle: operation.data?.title || operation.data?.name || '(no title)'
    });

    try {
        await ensureBackgroundSyncDbReady();
        const sourceUserId = normalizeQueueSourceUserId(operation?.sourceUserId);
        const scopeKey = getQueueScopeKey(operation.tableName, operation.recordId, sourceUserId);
        // FIX [C6, H3]: Only deduplicate against 'pending' items, NOT 'processing'
        // Updating 'processing' items causes data loss because:
        // 1. processSyncQueue() loads items and marks them 'processing'
        // 2. If we update a 'processing' item here, the in-memory copy in processSyncQueue() still has OLD data
        // 3. The OLD data gets synced to server, new data is lost
        // The deduplicateByRecordId() in processSyncQueue handles batched items safely
        const existing = await db.syncQueue
            .where('tableName')
            .equals(operation.tableName)
            .filter(item => item.status === 'pending'
                && getQueueScopeKey(item.tableName, item.recordId, item.sourceUserId) === scopeKey)
            .first();

        if (existing) {
            // Update existing pending item with new data (latest wins)
            await db.syncQueue.update(existing.id, {
                operation: operation.operation,
                data: operation.data,
                timestamp: Date.now(),
                sourceUserId
            });
            await persistSyncQueueOwnerUserId(sourceUserId);
            console.log(`[BackgroundSync] Updated pending ${operation.operation} for ${operation.tableName}:${operation.recordId}`);
            return true;
        }

        // Check queue size limit
        const queueCount = await db.syncQueue.count();
        if (queueCount >= MAX_QUEUE_SIZE) {
            console.warn('[BackgroundSync] Queue full, compacting pending items');
            const removed = await compactPendingSyncQueue();
            if (removed > 0) {
                console.log(`[BackgroundSync] Compacted ${removed} duplicate pending items`);
            }

            const newCount = await db.syncQueue.count();
            if (newCount >= MAX_QUEUE_SIZE) {
                try {
                    chrome.runtime.sendMessage({
                        action: 'syncQueueOverflow',
                        message: 'Sync queue is full. Please go online to sync pending changes.',
                        droppedCount: 0
                    }).catch(() => { }); // Ignore if no listener
                } catch (e) {
                    // Ignore messaging errors
                }
                return false;
            }
        }

        // Add new item to queue
        await db.syncQueue.add({
            operation: operation.operation,
            tableName: operation.tableName,
            recordId: operation.recordId,
            data: operation.data,
            sourceUserId,
            timestamp: Date.now(),
            status: 'pending',
            retryCount: 0
        });
        await persistSyncQueueOwnerUserId(sourceUserId);

        console.log(`[BackgroundSync] Queued ${operation.operation} for ${operation.tableName}:${operation.recordId}`);
        return true;
    } catch (error) {
        console.error('[BackgroundSync] Failed to add to queue:', error);
        return false;
    }
}

/**
 * Batch add multiple operations to the sync queue (for bulk imports)
 * Efficiently handles deduplication and uses bulk IndexedDB operations
 * @param {Array} operations - Array of { operation, tableName, recordId, data }
 * @returns {number} Number of new items added
 */
async function addBatchToSyncQueue(operations) {
    if (!operations || operations.length === 0) return 0;

    // 🔍 DEBUG: Log batch queue addition
    debugLog('🔍 [DEBUG addBatchToSyncQueue] Adding batch to queue:', {
        count: operations.length,
        recordIds: operations.map(op => op.recordId),
        tables: [...new Set(operations.map(op => op.tableName))]
    });

    try {
        await ensureBackgroundSyncDbReady();
        // Get all pending items for efficient deduplication
        const pendingItems = await db.syncQueue.where('status').equals('pending').toArray();
        const existingMap = new Map(
            pendingItems.map(item => [getQueueScopeKey(item.tableName, item.recordId, item.sourceUserId), item])
        );

        const updates = [];
        const inserts = [];
        const pendingInserts = new Map(); // Track within-batch duplicates: key -> index in inserts array
        const now = Date.now();
        const batchSourceUserIds = new Set();

        for (const op of operations) {
            const sourceUserId = normalizeQueueSourceUserId(op?.sourceUserId);
            if (sourceUserId) {
                batchSourceUserIds.add(sourceUserId);
            }
            const key = getQueueScopeKey(op.tableName, op.recordId, sourceUserId);
            const existing = existingMap.get(key);
            const pendingIndex = pendingInserts.get(key);

            if (existing) {
                // Update existing DB item
                updates.push({
                    id: existing.id,
                    changes: { operation: op.operation, data: op.data, timestamp: now, sourceUserId }
                });
            } else if (pendingIndex !== undefined) {
                // Within-batch duplicate: update the pending insert (latest wins)
                inserts[pendingIndex] = {
                    ...inserts[pendingIndex],
                    operation: op.operation,
                    data: op.data,
                    sourceUserId,
                    timestamp: now
                };
            } else {
                // New item to insert
                inserts.push({
                    operation: op.operation,
                    tableName: op.tableName,
                    recordId: op.recordId,
                    data: op.data,
                    sourceUserId,
                    timestamp: now,
                    status: 'pending',
                    retryCount: 0
                });
                pendingInserts.set(key, inserts.length - 1);
            }
        }

        if (inserts.length > 0) {
            const currentCount = await db.syncQueue.count();
            if (currentCount + inserts.length > MAX_QUEUE_SIZE) {
                const removed = await compactPendingSyncQueue();
                if (removed > 0) {
                    console.log(`[BackgroundSync] Compacted ${removed} duplicate pending items`);
                }
            }
        }

        // Wrap all operations in a single transaction for atomicity
        await db.transaction('rw', db.syncQueue, async () => {
            // Update existing items
            for (const { id, changes } of updates) {
                await db.syncQueue.update(id, changes);
            }

            // Check queue size before bulk insert
            if (inserts.length > 0) {
                const currentCount = await db.syncQueue.count();
                const availableSpace = MAX_QUEUE_SIZE - currentCount;

                if (availableSpace < inserts.length) {
                    throw new Error('Sync queue full');
                }

                await db.syncQueue.bulkAdd(inserts);
            }
        });

        if (batchSourceUserIds.size === 1) {
            await persistSyncQueueOwnerUserId([...batchSourceUserIds][0]);
        } else if (batchSourceUserIds.size > 1) {
            await clearSyncQueueOwnerUserId();
        }

        console.log(`[BackgroundSync] Batch queued: ${inserts.length} new, ${updates.length} updated`);
        return inserts.length;
    } catch (error) {
        if (error?.message === 'Sync queue full') {
            try {
                chrome.runtime.sendMessage({
                    action: 'syncQueueOverflow',
                    message: 'Sync queue is full. Please go online to sync pending changes.',
                    droppedCount: 0
                }).catch(() => { });
            } catch (e) { }
        }
        console.error('[BackgroundSync] Failed to batch add to queue:', error);
        throw error;
    }
}

/**
 * Deduplicate items by recordId, keeping the latest version (highest timestamp)
 * This prevents "ON CONFLICT DO UPDATE command cannot affect row a second time" errors
 */
function deduplicateByRecordId(items) {
    const latestByRecordId = new Map();
    for (const item of items) {
        const existing = latestByRecordId.get(item.recordId);
        if (!existing || item.timestamp >= existing.timestamp) {
            latestByRecordId.set(item.recordId, item);
        }
    }
    return Array.from(latestByRecordId.values());
}

// Delete records in chunks to avoid URL length limits
async function deleteIdsInChunks(tableName, ids, accessToken, chunkSize = 100, requestOptions = {}) {
    for (let i = 0; i < ids.length; i += chunkSize) {
        const chunk = ids.slice(i, i + chunkSize);
        await supabaseRequest(`${tableName}?id=in.(${chunk.join(',')})`, 'DELETE', null, accessToken, false, requestOptions);
    }
}

// Note: ID mapping functions (storeIdMapping, resolveIdMapping, cleanupOldIdMappings)
// have been removed - no longer needed with client-generated UUIDs!

/**

 * Process all pending items in the sync queue
 * FIX [Critical #11]: Uses Promise-based lock to prevent concurrent execution
 */
async function processSyncQueue() {
    await ensureBackgroundSyncDbReady();

    const backoffRemainingMs = getTransientBackoffRemainingMs();
    if (backoffRemainingMs > 0) {
        const pendingCount = await db.syncQueue.where('status').equals('pending').count();
        if (pendingCount === 0) {
            clearTransientBackoff();
            return { success: true, processed: 0, reason: 'no_pending_items' };
        }
        return {
            success: false,
            reason: 'transient_backoff',
            hasMorePending: true,
            retryAfterMs: backoffRemainingMs
        };
    }

    // Check connectivity first
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
        console.log('[BackgroundSync] Offline - skipping sync attempt');
        return { success: false, reason: 'offline', counts: { upserts: 0, deletes: 0 } };
    }

    // If already pushing, wait for it to complete
    if (_pushPromise) {
        console.log('[BackgroundSync] Already pushing, waiting for completion');
        await _pushPromise;
        // FIX: Don't return here - fall through to check for NEW items
        // that may have been added while we were waiting
    }

    // Check if there are pending items (could be new ones added while waiting)
    const pendingCount = await db.syncQueue.where('status').equals('pending').count();
    if (pendingCount === 0) {
        await maybeClearSyncQueueOwnerUserId();
        return { success: true, processed: 0, reason: 'no_pending_items' };
    }

    // Create the promise BEFORE any async operations to prevent race condition
    _pushPromise = _doProcessSyncQueue();

    try {
        return await _pushPromise;
    } finally {
        _pushPromise = null;
    }
}

/**
 * Internal implementation of sync queue processing
 */
async function _doProcessSyncQueue() {
    _isPushing = true;
    const pushGeneration = _pushCancellationGeneration;
    const pushAbortController = new AbortController();
    _activePushAbortControllers.add(pushAbortController);

    try {
        // FIX [Issue #10]: Reset stuck 'processing' items before processing new items
        // If service worker was terminated mid-operation, items can get stuck in 'processing' status
        // Reset them back to 'pending' so they can be retried
        try {
            const stuckItems = await db.syncQueue.where('status').equals('processing').toArray();
            if (stuckItems.length > 0) {
                console.log(`[BackgroundSync] Resetting ${stuckItems.length} stuck 'processing' items to pending`);
                for (const item of stuckItems) {
                    await db.syncQueue.update(item.id, { status: 'pending' });
                }
            }
        } catch (e) {
            console.warn('[BackgroundSync] Failed to reset stuck items:', e);
        }

        // Check auth
        const authInfo = await getAuthInfo();
        if (!authInfo) {
            console.log('[BackgroundSync] Not authenticated, skipping queue processing');
            return { success: false, reason: 'not_authenticated' };
        }
        throwIfPushCancelled(pushGeneration, 'auth check');

        // Get all pending items
        const [pendingItems, queueOwnerUserId] = await Promise.all([
            db.syncQueue
                .where('status')
                .equals('pending')
                .limit(MAX_QUEUE_ITEMS_PER_RUN)
                .toArray(),
            getSyncQueueOwnerUserId()
        ]);

        if (pendingItems.length === 0) {
            console.log('[BackgroundSync] No pending items in queue');
            await maybeClearSyncQueueOwnerUserId();
            return { success: true, processed: 0 };
        }
        throwIfPushCancelled(pushGeneration, 'queue snapshot');

        const { allowedItems, mismatchedItems } = partitionPendingItemsByUserScope(
            pendingItems,
            authInfo.userId,
            queueOwnerUserId
        );

        if (mismatchedItems.length > 0) {
            await markItemsAsUserScopeFailed(mismatchedItems, authInfo.userId, queueOwnerUserId);
        }

        if (allowedItems.length === 0) {
            await maybeClearSyncQueueOwnerUserId();
            return {
                success: true,
                processed: 0,
                failed: mismatchedItems.length,
                remainingPending: 0,
                hasMorePending: false,
                reason: 'user_scope_mismatch'
            };
        }

        console.log(`[BackgroundSync] Processing ${allowedItems.length} queued items (max ${MAX_QUEUE_ITEMS_PER_RUN} per run)`);
        const requestOptions = { abortSignal: pushAbortController.signal };

        // Group by table for batch processing
        const byTable = {
            pages: { upserts: [], deletes: [] },
            boards: { upserts: [], deletes: [] },
            bookmarks: { upserts: [], deletes: [] },
            sync_metadata: { upserts: [], deletes: [] }
        };

        // 🔍 DEBUG: Log all pending items before processing
        debugLog('🔍 [DEBUG processSyncQueue] Pending items to process:', {
            count: allowedItems.length,
            recordIds: allowedItems.map(i => i.recordId),
            tables: [...new Set(allowedItems.map(i => i.tableName))],
            blockedQueueIds: mismatchedItems.map(i => i.id)
        });

        for (const item of allowedItems) {
            const resolvedSourceUserId = resolveQueueItemSourceUserId(item, queueOwnerUserId);
            // Mark as processing
            await db.syncQueue.update(item.id, {
                status: 'processing',
                sourceUserId: resolvedSourceUserId || item.sourceUserId || null
            });
            debugLog('🔍 [DEBUG processSyncQueue] Marked as PROCESSING:', {
                queueId: item.id,
                recordId: item.recordId,
                tableName: item.tableName
            });

            const scopedItem = resolvedSourceUserId && item.sourceUserId !== resolvedSourceUserId
                ? { ...item, sourceUserId: resolvedSourceUserId }
                : item;

            if (scopedItem.operation === 'upsert' && scopedItem.data) {
                byTable[scopedItem.tableName]?.upserts.push({ queueId: scopedItem.id, ...scopedItem });
            } else if (scopedItem.operation === 'delete') {
                byTable[scopedItem.tableName]?.deletes.push({
                    queueId: scopedItem.id,
                    recordId: scopedItem.recordId,
                    sourceUserId: scopedItem.sourceUserId
                });
            }
        }
        throwIfPushCancelled(pushGeneration, 'queue staging');

        let successCount = 0;
        let failCount = mismatchedItems.length;
        let transientDeferredCount = 0;

        // FIX [Phase 2]: UPSERT-Only Simplification
        // Instead of fetching server IDs and splitting into INSERT/UPDATE,
        // we now use UPSERT (on_conflict=id) for ALL operations.
        // This eliminates the race condition where getAllServerIds() could return
        // stale data if items were created between the fetch and the sync.
        //
        // Note: getAllServerIds() is kept for backwards compatibility but not called here.

        // Process each table (order: pages -> boards -> bookmarks for upserts, reverse for deletes)

        // 1. Process pages with UPSERT
        if (byTable.pages.upserts.length > 0) {
            // Deduplicate to prevent "ON CONFLICT DO UPDATE command cannot affect row a second time" errors
            const allPages = deduplicateByRecordId(byTable.pages.upserts);
            console.log(`[BackgroundSync] Upserting ${allPages.length} pages...`);

            let pageSuccess = 0;
            let pageFail = 0;
            let processedIndex = 0;
            try {
                const totalChunks = Math.ceil(allPages.length / UPSERT_CHUNK_SIZE);
                for (let start = 0; start < allPages.length; start += UPSERT_CHUNK_SIZE) {
                    throwIfPushCancelled(pushGeneration, 'pages upsert');
                    const chunk = allPages.slice(start, start + UPSERT_CHUNK_SIZE);
                    const chunkNumber = Math.floor(start / UPSERT_CHUNK_SIZE) + 1;
                    processedIndex = start;

                    const upsertData = chunk.map(item =>
                        convertPageToServerFormat(item.data, authInfo.userId, true)
                    );
                    console.log(`[BackgroundSync] Upserting pages chunk ${chunkNumber}/${totalChunks} (${chunk.length} pages)...`);

                    const response = await supabaseRequest('pages?on_conflict=id&select=id,sync_version,updated_at,created_at', 'POST', upsertData, authInfo.accessToken, true, requestOptions);
                    const confirmedRows = buildConfirmedRowMap(response);
                    const confirmedIds = new Set(confirmedRows.keys());

                    for (const item of chunk) {
                        if (confirmedIds.has(item.recordId)) {
                            await persistConfirmedUpsertMetadata('pages', item, confirmedRows.get(item.recordId));
                            await db.syncQueue.delete(item.queueId);
                            successCount++;
                            pageSuccess++;
                        } else {
                            console.warn(`[BackgroundSync] Page ${item.recordId} not confirmed by server, keeping for retry`);
                            await db.syncQueue.update(item.queueId, { status: 'pending' });
                            failCount++;
                            pageFail++;
                        }
                    }

                    processedIndex = start + chunk.length;
                }
                console.log(`[BackgroundSync] ✅ Upserted pages: ${pageSuccess} confirmed, ${pageFail} pending retry`);
            } catch (error) {
                const remainingPages = allPages.slice(processedIndex);
                if (error instanceof AuthorizationPolicyError) {
                    await markItemsAsPolicyFailed(remainingPages, error.message, 'pages upsert');
                    failCount += remainingPages.length;
                    pageFail += remainingPages.length;
                } else if (error instanceof AuthError) {
                    // Don't retry auth errors - leave in queue for when user re-authenticates
                    console.log(`[BackgroundSync] Auth error for pages - not retrying, waiting for re-auth`);
                    for (const item of remainingPages) {
                        await db.syncQueue.update(item.queueId, { status: 'pending' });
                    }
                } else if (isLikelyTransientSyncError(error)) {
                    transientDeferredCount += await keepItemsPendingForTransientFailure(remainingPages, error, 'pages upsert');
                } else {
                    console.error('[BackgroundSync] ❌ Failed to upsert pages:', error);
                    for (const item of remainingPages) {
                        await handleFailedItem(item.queueId);
                        failCount++;
                        pageFail++;
                    }
                }
            }
        }

        // 2. Process boards with UPSERT
        if (byTable.boards.upserts.length > 0) {
            // Deduplicate to prevent "ON CONFLICT DO UPDATE command cannot affect row a second time" errors
            const allBoards = deduplicateByRecordId(byTable.boards.upserts);
            console.log(`[BackgroundSync] Upserting ${allBoards.length} boards...`);

            let boardSuccess = 0;
            let boardFail = 0;
            let processedIndex = 0;
            try {
                const totalChunks = Math.ceil(allBoards.length / UPSERT_CHUNK_SIZE);
                for (let start = 0; start < allBoards.length; start += UPSERT_CHUNK_SIZE) {
                    throwIfPushCancelled(pushGeneration, 'boards upsert');
                    const chunk = allBoards.slice(start, start + UPSERT_CHUNK_SIZE);
                    const chunkNumber = Math.floor(start / UPSERT_CHUNK_SIZE) + 1;
                    processedIndex = start;

                    const upsertData = chunk.map(item =>
                        convertBoardToServerFormat(item.data, authInfo.userId, true)
                    );
                    console.log(`[BackgroundSync] Upserting boards chunk ${chunkNumber}/${totalChunks} (${chunk.length} boards)...`);

                    const response = await supabaseRequest('boards?on_conflict=id&select=id,sync_version,updated_at,created_at', 'POST', upsertData, authInfo.accessToken, true, requestOptions);
                    const confirmedRows = buildConfirmedRowMap(response);
                    const confirmedIds = new Set(confirmedRows.keys());

                    for (const item of chunk) {
                        if (confirmedIds.has(item.recordId)) {
                            await persistConfirmedUpsertMetadata('boards', item, confirmedRows.get(item.recordId));
                            await db.syncQueue.delete(item.queueId);
                            successCount++;
                            boardSuccess++;
                        } else {
                            console.warn(`[BackgroundSync] Board ${item.recordId} not confirmed by server, keeping for retry`);
                            await db.syncQueue.update(item.queueId, { status: 'pending' });
                            failCount++;
                            boardFail++;
                        }
                    }

                    processedIndex = start + chunk.length;
                }
                console.log(`[BackgroundSync] ✅ Upserted boards: ${boardSuccess} confirmed, ${boardFail} pending retry`);
            } catch (error) {
                const remainingBoards = allBoards.slice(processedIndex);
                if (error instanceof AuthorizationPolicyError) {
                    await markItemsAsPolicyFailed(remainingBoards, error.message, 'boards upsert');
                    failCount += remainingBoards.length;
                    boardFail += remainingBoards.length;
                } else if (error instanceof AuthError) {
                    // Don't retry auth errors - leave in queue for when user re-authenticates
                    console.log(`[BackgroundSync] Auth error for boards - not retrying, waiting for re-auth`);
                    for (const item of remainingBoards) {
                        await db.syncQueue.update(item.queueId, { status: 'pending' });
                    }
                } else if (isLikelyTransientSyncError(error)) {
                    transientDeferredCount += await keepItemsPendingForTransientFailure(remainingBoards, error, 'boards upsert');
                } else {
                    console.error('[BackgroundSync] ❌ Failed to upsert boards:', error);
                    for (const item of remainingBoards) {
                        await handleFailedItem(item.queueId);
                        failCount++;
                        boardFail++;
                    }
                }
            }
        }

        // 3. Process bookmarks with UPSERT
        if (byTable.bookmarks.upserts.length > 0) {
            // DEBUG LOGGING: Track bookmark processing
            console.log(`[BackgroundSync] 📊 BOOKMARK PROCESSING START`);
            console.log(`[BackgroundSync] Total bookmark upserts in queue: ${byTable.bookmarks.upserts.length}`);

            // Group by boardId for debugging
            const byBoard = {};
            for (const item of byTable.bookmarks.upserts) {
                const boardId = item.data?.boardId || 'unknown';
                byBoard[boardId] = (byBoard[boardId] || 0) + 1;
            }
            console.log(`[BackgroundSync] Bookmarks per board (queued):`, JSON.stringify(byBoard));

            // Deduplicate to prevent "ON CONFLICT DO UPDATE command cannot affect row a second time" errors
            const allBookmarks = deduplicateByRecordId(byTable.bookmarks.upserts);
            console.log(`[BackgroundSync] After deduplication: ${allBookmarks.length} unique bookmarks`);

            let bookmarkSuccess = 0;
            let bookmarkFail = 0;
            let processedIndex = 0;
            const confirmedRecordIds = [];
            try {
                const totalChunks = Math.ceil(allBookmarks.length / UPSERT_CHUNK_SIZE);
                for (let start = 0; start < allBookmarks.length; start += UPSERT_CHUNK_SIZE) {
                    throwIfPushCancelled(pushGeneration, 'bookmarks upsert');
                    const chunk = allBookmarks.slice(start, start + UPSERT_CHUNK_SIZE);
                    const chunkNumber = Math.floor(start / UPSERT_CHUNK_SIZE) + 1;
                    processedIndex = start;

                    const upsertData = chunk.map(item =>
                        convertBookmarkToServerFormat(item.data, authInfo.userId, true)
                    );
                    console.log(`[BackgroundSync] Sending bookmarks upsert chunk ${chunkNumber}/${totalChunks} (${upsertData.length} bookmarks)...`);

                    const response = await supabaseRequest('bookmarks?on_conflict=id&select=id,sync_version,updated_at,created_at', 'POST', upsertData, authInfo.accessToken, true, requestOptions);
                    const confirmedRows = buildConfirmedRowMap(response);
                    const confirmedIds = new Set(confirmedRows.keys());

                    for (const item of chunk) {
                        if (confirmedIds.has(item.recordId)) {
                            await persistConfirmedUpsertMetadata('bookmarks', item, confirmedRows.get(item.recordId));
                            await db.syncQueue.delete(item.queueId);
                            confirmedRecordIds.push(item.recordId);
                            successCount++;
                            bookmarkSuccess++;
                        } else {
                            console.warn(`[BackgroundSync] Bookmark ${item.recordId} not confirmed by server, keeping for retry`);
                            await db.syncQueue.update(item.queueId, { status: 'pending' });
                            failCount++;
                            bookmarkFail++;
                        }
                    }

                    processedIndex = start + chunk.length;
                }

                // 🔍 DEBUG: Log all confirmed bookmark IDs that were removed from queue
                debugLog('🔍 [DEBUG processSyncQueue] REMOVED from queue (confirmed by server):', {
                    count: confirmedRecordIds.length,
                    recordIds: confirmedRecordIds
                });
                console.log(`[BackgroundSync] ✅ Upserted bookmarks: ${bookmarkSuccess} confirmed, ${bookmarkFail} pending retry`);
            } catch (error) {
                const remainingBookmarks = allBookmarks.slice(processedIndex);
                if (error instanceof AuthorizationPolicyError) {
                    await markItemsAsPolicyFailed(remainingBookmarks, error.message, 'bookmarks upsert');
                    failCount += remainingBookmarks.length;
                    bookmarkFail += remainingBookmarks.length;
                } else if (error instanceof AuthError) {
                    // Don't retry auth errors - leave in queue for when user re-authenticates
                    console.log(`[BackgroundSync] Auth error for bookmarks - not retrying, waiting for re-auth`);
                    for (const item of remainingBookmarks) {
                        await db.syncQueue.update(item.queueId, { status: 'pending' });
                    }
                } else if (isLikelyTransientSyncError(error)) {
                    transientDeferredCount += await keepItemsPendingForTransientFailure(remainingBookmarks, error, 'bookmarks upsert');
                } else {
                    console.error('[BackgroundSync] ❌ Failed to upsert bookmarks:', error);
                    console.error('[BackgroundSync] Upsert error details:', error.message);
                    for (const item of remainingBookmarks) {
                        await handleFailedItem(item.queueId);
                        failCount++;
                        bookmarkFail++;
                    }
                }
            }

            console.log(`[BackgroundSync] 📊 BOOKMARK PROCESSING END - success: ${successCount}, fail: ${failCount}`);
        }

        // 4. Discard legacy wallpaper sync metadata now that wallpapers are device-local only.
        if (byTable.sync_metadata.upserts.length > 0) {
            const allSyncMetadata = deduplicateByRecordId(byTable.sync_metadata.upserts);
            for (const item of allSyncMetadata) {
                throwIfPushCancelled(pushGeneration, 'discard legacy sync metadata');
                await db.syncQueue.delete(item.queueId);
                successCount++;
            }
            console.log(`[BackgroundSync] Discarded ${allSyncMetadata.length} legacy wallpaper sync item(s); wallpapers are local-only now`);
        }


        // 5. Delete bookmarks (reverse order: bookmarks -> boards -> pages)
        // FIX [Phase 5]: Verify server confirmation before removing from queue
        if (byTable.bookmarks.deletes.length > 0) {
            try {
                const ids = byTable.bookmarks.deletes.map(d => d.recordId);
                throwIfPushCancelled(pushGeneration, 'bookmarks delete');
                await deleteIdsInChunks('bookmarks', ids, authInfo.accessToken, 100, requestOptions);

                let deleteSuccess = 0;
                for (const item of byTable.bookmarks.deletes) {
                    // Accept both: server confirmed deletion OR item wasn't on server (already deleted)
                    // In either case, we can safely remove from queue
                    await db.syncQueue.delete(item.queueId);
                    successCount++;
                    deleteSuccess++;
                }
                console.log(`[BackgroundSync] Deleted ${deleteSuccess} bookmarks`);
            } catch (error) {
                if (error instanceof AuthorizationPolicyError) {
                    await markItemsAsPolicyFailed(byTable.bookmarks.deletes, error.message, 'bookmarks delete');
                    failCount += byTable.bookmarks.deletes.length;
                } else if (error instanceof AuthError) {
                    // Don't retry auth errors - leave in queue for when user re-authenticates
                    console.log(`[BackgroundSync] Auth error for bookmark deletes - not retrying, waiting for re-auth`);
                    for (const item of byTable.bookmarks.deletes) {
                        await db.syncQueue.update(item.queueId, { status: 'pending' });
                    }
                } else if (isLikelyTransientSyncError(error)) {
                    transientDeferredCount += await keepItemsPendingForTransientFailure(byTable.bookmarks.deletes, error, 'bookmarks delete');
                } else {
                    console.error('[BackgroundSync] Failed to delete bookmarks:', error);
                    for (const item of byTable.bookmarks.deletes) {
                        await handleFailedItem(item.queueId);
                        failCount++;
                    }
                }
            }
        }

        // 6. Delete boards
        // FIX [Phase 5]: Verify server confirmation before removing from queue
        if (byTable.boards.deletes.length > 0) {
            try {
                const ids = byTable.boards.deletes.map(d => d.recordId);
                throwIfPushCancelled(pushGeneration, 'boards delete');
                await deleteIdsInChunks('boards', ids, authInfo.accessToken, 100, requestOptions);

                let deleteSuccess = 0;
                for (const item of byTable.boards.deletes) {
                    // Accept both: server confirmed deletion OR item wasn't on server (already deleted)
                    await db.syncQueue.delete(item.queueId);
                    successCount++;
                    deleteSuccess++;
                }
                console.log(`[BackgroundSync] Deleted ${deleteSuccess} boards`);
            } catch (error) {
                if (error instanceof AuthorizationPolicyError) {
                    await markItemsAsPolicyFailed(byTable.boards.deletes, error.message, 'boards delete');
                    failCount += byTable.boards.deletes.length;
                } else if (error instanceof AuthError) {
                    // Don't retry auth errors - leave in queue for when user re-authenticates
                    console.log(`[BackgroundSync] Auth error for board deletes - not retrying, waiting for re-auth`);
                    for (const item of byTable.boards.deletes) {
                        await db.syncQueue.update(item.queueId, { status: 'pending' });
                    }
                } else if (isLikelyTransientSyncError(error)) {
                    transientDeferredCount += await keepItemsPendingForTransientFailure(byTable.boards.deletes, error, 'boards delete');
                } else {
                    console.error('[BackgroundSync] Failed to delete boards:', error);
                    for (const item of byTable.boards.deletes) {
                        await handleFailedItem(item.queueId);
                        failCount++;
                    }
                }
            }
        }

        // 7. Delete pages
        // FIX [Phase 5]: Verify server confirmation before removing from queue
        if (byTable.pages.deletes.length > 0) {
            try {
                const ids = byTable.pages.deletes.map(d => d.recordId);
                throwIfPushCancelled(pushGeneration, 'pages delete');
                await deleteIdsInChunks('pages', ids, authInfo.accessToken, 100, requestOptions);

                let deleteSuccess = 0;
                for (const item of byTable.pages.deletes) {
                    // Accept both: server confirmed deletion OR item wasn't on server (already deleted)
                    await db.syncQueue.delete(item.queueId);
                    successCount++;
                    deleteSuccess++;
                }
                console.log(`[BackgroundSync] Deleted ${deleteSuccess} pages`);
            } catch (error) {
                if (error instanceof AuthorizationPolicyError) {
                    await markItemsAsPolicyFailed(byTable.pages.deletes, error.message, 'pages delete');
                    failCount += byTable.pages.deletes.length;
                } else if (error instanceof AuthError) {
                    // Don't retry auth errors - leave in queue for when user re-authenticates
                    console.log(`[BackgroundSync] Auth error for page deletes - not retrying, waiting for re-auth`);
                    for (const item of byTable.pages.deletes) {
                        await db.syncQueue.update(item.queueId, { status: 'pending' });
                    }
                } else if (isLikelyTransientSyncError(error)) {
                    transientDeferredCount += await keepItemsPendingForTransientFailure(byTable.pages.deletes, error, 'pages delete');
                } else {
                    console.error('[BackgroundSync] Failed to delete pages:', error);
                    for (const item of byTable.pages.deletes) {
                        await handleFailedItem(item.queueId);
                        failCount++;
                    }
                }
            }
        }

        const remainingPending = await db.syncQueue.where('status').equals('pending').count();
        const hasMorePending = remainingPending > 0;
        let retryAfterMs = 0;
        if (transientDeferredCount > 0) {
            retryAfterMs = markTransientBackoff();
        } else if (remainingPending === 0 || successCount > 0) {
            clearTransientBackoff();
        }
        console.log(`[BackgroundSync] Queue processing complete. Success: ${successCount}, Failed: ${failCount}, Remaining pending: ${remainingPending}`);
        if (!hasMorePending) {
            await maybeClearSyncQueueOwnerUserId();
        }
        return { success: true, processed: successCount, failed: failCount, hasMorePending, remainingPending, retryAfterMs, transientDeferredCount };

    } catch (error) {
        if (error instanceof PushCancelledError) {
            console.info('[BackgroundSync] Queue processing cancelled:', error.message);
            return { success: false, reason: 'cancelled', error: error.message };
        }
        console.error('[BackgroundSync] Queue processing error:', error);
        return { success: false, error: error.message };
    } finally {
        // FIX [H1]: Always release lock in finally block to prevent deadlock
        // This ensures lock is released even on early returns or unexpected errors
        _activePushAbortControllers.delete(pushAbortController);
        _isPushing = false;
    }
}

/**
 * Handle failed queue item - increment retry count or mark as failed
 */
async function handleFailedItem(queueId) {
    try {
        const item = await db.syncQueue.get(queueId);
        if (!item) return;

        const newRetryCount = (item.retryCount || 0) + 1;

        if (newRetryCount >= MAX_RETRY_COUNT) {
            // Max retries exceeded - mark as failed and leave in queue for manual review
            await db.syncQueue.update(queueId, {
                status: 'failed',
                retryCount: newRetryCount
            });
            console.warn(`[BackgroundSync] Item ${queueId} exceeded max retries, marked as failed`);
        } else {
            // Reset to pending for retry
            await db.syncQueue.update(queueId, {
                status: 'pending',
                retryCount: newRetryCount
            });
        }
    } catch (error) {
        console.error('[BackgroundSync] Error handling failed item:', error);
    }
}

/**
 * Mark a set of queue items as permanently failed (non-retryable).
 * Used for authorization/policy denials where retrying will not help.
 */
async function markItemsAsPolicyFailed(items, reason, contextLabel = 'sync') {
    if (!Array.isArray(items) || items.length === 0) return;

    const summary = summarizeAuthError(reason, 300) || 'Authorization policy denied operation';
    const failedAt = new Date().toISOString();

    for (const item of items) {
        try {
            await db.syncQueue.update(item.queueId, {
                status: 'failed',
                retryCount: MAX_RETRY_COUNT,
                lastError: summary,
                failedAt
            });
        } catch (error) {
            console.error(`[BackgroundSync] Failed to mark queue item ${item.queueId} as policy-failed:`, error);
        }
    }

    console.warn(`[BackgroundSync] ${contextLabel}: marked ${items.length} item(s) as failed (authorization policy denied)`);
}

/**
 * Schedule a push with debounce
 * This is called after data changes to batch multiple rapid changes together
 *
 * FIX [C2]: Use chrome.storage flag instead of setTimeout
 * setTimeout doesn't survive service worker termination, causing scheduled pushes to be lost.
 * The background retry alarm will catch any pending pushes via the storage flag.
 * For immediate responsiveness, we also try to process immediately after debounce if worker is alive.
 */
function schedulePush(delayOverrideMs = SYNC_DEBOUNCE_MS) {
    if (_pushTimeout) {
        clearTimeout(_pushTimeout);
    }

    // Set a flag in chrome.storage to indicate a push is pending
    // This survives service worker termination and will be picked up by the alarm
    chrome.storage.local.set({
        syncPushPending: {
            timestamp: Date.now(),
            scheduledAt: new Date().toISOString()
        }
    }).catch(e => console.error('[BackgroundSync] Failed to set pending flag:', e));

    // Still use setTimeout for immediate responsiveness when worker stays alive
    // If worker dies, the alarm will catch it via the storage flag
    const backoffRemainingMs = getTransientBackoffRemainingMs();
    const delayMs = Math.max(
        Number.isFinite(delayOverrideMs) ? delayOverrideMs : SYNC_DEBOUNCE_MS,
        backoffRemainingMs
    );

    _pushTimeout = setTimeout(async () => {
        _pushTimeout = null;
        const result = await processSyncQueue();
        if (result?.hasMorePending) {
            console.log('[BackgroundSync] Additional pending items detected, scheduling next push pass');
            const nextDelayMs = Number.isFinite(result.retryAfterMs) && result.retryAfterMs > 0
                ? result.retryAfterMs
                : SYNC_DEBOUNCE_MS;
            schedulePush(nextDelayMs);
            return;
        }
        // Clear the pending flag once queue is drained for now.
        chrome.storage.local.remove('syncPushPending').catch(() => { });
    }, delayMs);

    console.log(`[BackgroundSync] Push scheduled in ${delayMs}ms (with storage fallback)`);
}

/**
 * Force immediate push (no debounce)
 */
async function forcePush() {
    if (_pushTimeout) {
        clearTimeout(_pushTimeout);
        _pushTimeout = null;
    }
    const backoffRemainingMs = getTransientBackoffRemainingMs();
    if (backoffRemainingMs > 0) {
        schedulePush(backoffRemainingMs);
        return { success: false, reason: 'transient_backoff', hasMorePending: true, retryAfterMs: backoffRemainingMs };
    }
    const result = await processSyncQueue();
    if (result?.hasMorePending) {
        const nextDelayMs = Number.isFinite(result.retryAfterMs) && result.retryAfterMs > 0
            ? result.retryAfterMs
            : SYNC_DEBOUNCE_MS;
        schedulePush(nextDelayMs);
    } else if (result?.reason === 'no_pending_items' || result?.success !== false) {
        chrome.storage.local.remove('syncPushPending').catch(() => { });
    }
    return result;
}

/**
 * Get queue status for diagnostics
 */
async function getQueueStatus() {
    try {
        await ensureBackgroundSyncDbReady();
        const pending = await db.syncQueue.where('status').equals('pending').count();
        const processing = await db.syncQueue.where('status').equals('processing').count();
        const failed = await db.syncQueue.where('status').equals('failed').count();

        return {
            pending,
            processing,
            failed,
            total: pending + processing + failed,
            isPushing: _isPushing
        };
    } catch (error) {
        return { error: error.message };
    }
}

/**
 * Clear all queued items and cancel pending push
 * Used during logout to prevent old user's operations from running
 */
async function clearAllQueued() {
    try {
        await ensureBackgroundSyncDbReady();
        // Cancel any pending debounced push
        if (_pushTimeout) {
            clearTimeout(_pushTimeout);
            _pushTimeout = null;
        }

        clearTransientBackoff();

        const activePushPromise = _pushPromise;
        cancelActivePush('clear queued sync work');
        if (activePushPromise) {
            try {
                await activePushPromise;
            } catch (error) {
                if (!(error instanceof PushCancelledError)) {
                    console.warn('[BackgroundSync] Active push did not shut down cleanly during queue clear:', error);
                }
            }
        }

        // Clear the sync queue
        const count = await db.syncQueue.count();
        await db.syncQueue.clear();

        // Clear the pending flag in storage
        await chrome.storage.local.remove(['syncPushPending', SYNC_QUEUE_OWNER_STORAGE_KEY]);

        console.log(`[BackgroundSync] Cleared ${count} queued items`);
        return { success: true, cleared: count };
    } catch (error) {
        console.error('[BackgroundSync] Error clearing queue:', error);
        return { success: false, error: error.message };
    }
}

// Export functions for use in background.js
// Note: In service worker context, we use global scope instead of window
if (typeof self !== 'undefined') {
    self.BackgroundSync = {
        addToSyncQueue,
        addBatchToSyncQueue,
        processSyncQueue,
        schedulePush,
        forcePush,
        getQueueStatus,
        clearAllQueued,
        // Conversion utilities for external use
        convertPageToServerFormat,
        convertBoardToServerFormat,
        convertBookmarkToServerFormat
    };
}

debugLog('[BackgroundSync] Module loaded');
