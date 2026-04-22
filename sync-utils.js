/**
 * LumiList Sync Utilities
 * Pure functions extracted for testing
 *
 * These functions handle timestamp comparison, URL normalization,
 * and record equality checks used in the sync process.
 */

/**
 * Check if timestamp A is newer than (or equal to) timestamp B
 * Server wins on tie to ensure consistent sync behavior
 *
 * @param {string|null} timestampA - First timestamp (usually server)
 * @param {string|null} timestampB - Second timestamp (usually local)
 * @returns {boolean} True if A is newer or equal to B
 */
function isNewer(timestampA, timestampB) {
    if (!timestampA) return false;
    if (!timestampB) return true;
    // Server wins on tie - ensures drag position updates always sync correctly
    const serverTime = new Date(timestampA).getTime();
    const localTime = new Date(timestampB).getTime();
    return serverTime >= localTime;
}

/**
 * Check if two pages have identical content
 * Used to avoid unnecessary database writes
 *
 * @param {Object} a - First page object
 * @param {Object} b - Second page object
 * @returns {boolean} True if pages are equal
 */
function isPageEqual(a, b) {
    return a.name === b.name &&
        a.order === b.order &&
        a.isDefault === b.isDefault &&
        a.deletedAt === b.deletedAt &&
        a.shareId === b.shareId;
}

/**
 * Check if two boards have identical content
 * Used to avoid unnecessary database writes
 *
 * @param {Object} a - First board object
 * @param {Object} b - Second board object
 * @returns {boolean} True if boards are equal
 */
function isBoardEqual(a, b) {
    return a.name === b.name &&
        a.columnIndex === b.columnIndex &&
        a.order === b.order &&
        a.pageId === b.pageId &&
        a.deletedAt === b.deletedAt &&
        a.shareId === b.shareId &&
        a.color === b.color;
}

/**
 * Check if two bookmarks have identical content
 * Used to avoid unnecessary database writes
 *
 * @param {Object} a - First bookmark object
 * @param {Object} b - Second bookmark object
 * @returns {boolean} True if bookmarks are equal
 */
function isBookmarkEqual(a, b) {
    return a.title === b.title &&
        a.url === b.url &&
        a.description === b.description &&
        a.order === b.order &&
        a.boardId === b.boardId &&
        a.deletedAt === b.deletedAt;
}

/**
 * Normalize URL for deduplication purposes
 * Removes trailing slashes, normalizes protocol, removes fragments
 * This allows matching URLs that are logically the same but differ in formatting
 *
 * @param {string} url - URL to normalize
 * @returns {string} Normalized URL
 */
function normalizeUrlForDedup(url) {
    if (!url) return '';
    try {
        // Parse the URL
        const parsed = new URL(url);
        // Lowercase protocol and hostname
        let normalized = parsed.protocol.toLowerCase() + '//' + parsed.hostname.toLowerCase();
        // Add port if non-default
        if (parsed.port && parsed.port !== '80' && parsed.port !== '443') {
            normalized += ':' + parsed.port;
        }
        // Add pathname (remove trailing slash unless it's just "/")
        let pathname = parsed.pathname;
        if (pathname.length > 1 && pathname.endsWith('/')) {
            pathname = pathname.slice(0, -1);
        }
        normalized += pathname;
        // Add search params (sorted for consistency)
        if (parsed.search) {
            const params = new URLSearchParams(parsed.search);
            const sortedParams = new URLSearchParams([...params.entries()].sort());
            normalized += '?' + sortedParams.toString();
        }
        // Omit fragment (hash) - same page, different anchor shouldn't be duplicate
        return normalized;
    } catch (e) {
        // If URL parsing fails, return the original trimmed and lowercased
        return url.trim().toLowerCase();
    }
}

/**
 * Determine what action to take for merging a record
 * Implements Last-Write-Wins strategy
 *
 * @param {Object|null} serverRecord - Record from server
 * @param {Object|null} localRecord - Record from local database
 * @returns {{action: string, record: Object}} Action to take and resulting record
 */
function mergeRecord(serverRecord, localRecord) {
    if (!localRecord) {
        return { action: 'insert', record: serverRecord };
    }
    if (isNewer(serverRecord.updatedAt, localRecord.updatedAt)) {
        return { action: 'update', record: serverRecord };
    }
    return { action: 'keep', record: localRecord };
}

// Export for both CommonJS (Jest) and browser (window global)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        isNewer,
        isPageEqual,
        isBoardEqual,
        isBookmarkEqual,
        normalizeUrlForDedup,
        mergeRecord
    };
} else if (typeof window !== 'undefined') {
    window.SyncUtils = {
        isNewer,
        isPageEqual,
        isBoardEqual,
        isBookmarkEqual,
        normalizeUrlForDedup,
        mergeRecord
    };
}
