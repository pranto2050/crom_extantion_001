/*
========================================
DATABASE SETUP AND INITIALIZATION
========================================
Using Dexie.js as a wrapper for IndexedDB to store boards and bookmarks locally
*/

const lumiListModules = window.LumiListModules || {};
if (!lumiListModules.coreUtils || !lumiListModules.feedback) {
    throw new Error('LumiList shared runtime modules failed to load before newtab.js');
}
const featureFactories = lumiListModules.features || {};

const {
    generateId,
    safeParseInt,
    validateColumnIndex,
    escapeHTML,
    isUnsafeUrl,
    sanitizeUrl,
    normalizeUrlForDedup,
    normalizeBooleanValue,
    getCurrentTimestamp,
    escapeHtml
} = lumiListModules.coreUtils;

const {
    updateLoadingMessage,
    showGlassToast,
    showGlassConfirm
} = lumiListModules.feedback;

// Database schema definition
const db = new Dexie('BookmarkManager');

const UNDO_REDO_HISTORY_STATE_ID = 'main';
const UNDO_REDO_HISTORY_MAX_DEPTH_DEFAULT = 200;
// Sync queue capacity should align with background-sync.js MAX_QUEUE_SIZE.
const SYNC_QUEUE_CAPACITY_LIMIT = 120000;
// Keep undo/redo chunking threshold conservative for UI responsiveness.
const UNDO_REDO_SYNC_QUEUE_LIMIT = 1000;
// Conservative chunk size leaves room for other pending queue entries.
const UNDO_REDO_SYNC_CHUNK_SIZE = 250;
const SESSION_INVALIDATION_STORAGE_KEY = 'lumilist_session_invalidated';
const FLOATING_CONTROL_POPUP_GAP_PX = 14;
const FLOATING_CONTROL_POPUP_MARGIN_PX = 16;

// Version 21: Add tags, isPinned, and folder fields for bookmarks
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

// Version 20: Add visit tracking fields for bookmarks
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

// Version 19: Add archive metadata for locally installed wallpaper assets
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
// Version 18: Add locally installed wallpaper asset storage
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

// Version 17: Add undo/redo history tables
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

// Version 16: Add Base64 data caching for favicons (instant loading)
db.version(16).stores({
    pages: 'id, name, order, createdAt, isDefault, deletedAt, updatedAt, shareId',
    boards: 'id, pageId, name, columnIndex, order, createdAt, [pageId+columnIndex+order], deletedAt, updatedAt, shareId',
    bookmarks: 'id, boardId, title, url, description, order, createdAt, deletedAt, updatedAt',
    favicons: 'id, data, url, timestamp',  // 'id' is cache key (usually hostname), 'data' is Base64
    syncQueue: '++id, operation, tableName, recordId, timestamp, status, retryCount'
});

// Version 15: Switch to client-generated UUIDs (eliminates ID remapping complexity)
// IDs are now TEXT (UUIDs) instead of auto-increment integers
db.version(15).stores({
    pages: 'id, name, order, createdAt, isDefault, deletedAt, updatedAt, shareId',
    boards: 'id, pageId, name, columnIndex, order, createdAt, [pageId+columnIndex+order], deletedAt, updatedAt, shareId',
    bookmarks: 'id, boardId, title, url, description, order, createdAt, deletedAt, updatedAt',
    favicons: 'id, hostname, url, timestamp',
    syncQueue: '++id, operation, tableName, recordId, timestamp, status, retryCount'
    // idMappings table removed - no longer needed with UUIDs!
}).upgrade(async tx => {


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

// Version 14: Add idMappings table for tracking local→server ID remaps (fixes sync race condition)
db.version(14).stores({
    pages: '++id, name, order, createdAt, isDefault, deletedAt, updatedAt, shareId',
    boards: '++id, pageId, name, columnIndex, order, createdAt, [pageId+columnIndex+order], deletedAt, updatedAt, shareId',
    bookmarks: '++id, boardId, title, url, description, order, createdAt, deletedAt, updatedAt',
    favicons: 'id, hostname, url, timestamp',
    syncQueue: '++id, operation, tableName, recordId, timestamp, status, retryCount',
    idMappings: '[tableName+localId], tableName, localId, serverId, createdAt'
});

// Version 13: Add shareId to pages and boards for simplified sharing
db.version(13).stores({
    pages: '++id, name, order, createdAt, isDefault, deletedAt, updatedAt, shareId',
    boards: '++id, pageId, name, columnIndex, order, createdAt, [pageId+columnIndex+order], deletedAt, updatedAt, shareId',
    bookmarks: '++id, boardId, title, url, description, order, createdAt, deletedAt, updatedAt',
    favicons: 'id, hostname, url, timestamp',
    syncQueue: '++id, operation, tableName, recordId, timestamp, status, retryCount'
});
// Version 12: Remove lock page feature fields (isPrivate, passcodeHash, encryptionSalt, encryptionSalt, encryptedKeyBackup, recoveryKeyId)
db.version(12).stores({
    pages: '++id, name, order, createdAt, isDefault, deletedAt, updatedAt',
    boards: '++id, pageId, name, columnIndex, order, createdAt, [pageId+columnIndex+order], deletedAt, updatedAt',
    bookmarks: '++id, boardId, title, url, description, order, createdAt, deletedAt, updatedAt',
    favicons: 'id, hostname, url, timestamp',
    syncQueue: '++id, operation, tableName, recordId, timestamp, status, retryCount'
});
// Version 11: Add syncQueue for background sync
db.version(11).stores({
    pages: '++id, name, order, createdAt, isDefault, isPrivate, passcodeHash, encryptionSalt, encryptedKeyBackup, recoveryKeyId, deletedAt, updatedAt',
    boards: '++id, pageId, name, columnIndex, order, createdAt, [pageId+columnIndex+order], deletedAt, updatedAt',
    bookmarks: '++id, boardId, title, url, description, order, createdAt, deletedAt, updatedAt',
    favicons: 'id, hostname, url, timestamp',
    syncQueue: '++id, operation, tableName, recordId, timestamp, status, retryCount'
});
// Version 10: Re-add lock page feature with OTP recovery support
db.version(10).stores({
    pages: '++id, name, order, createdAt, isDefault, isPrivate, passcodeHash, encryptionSalt, encryptedKeyBackup, recoveryKeyId, deletedAt',
    boards: '++id, pageId, name, columnIndex, order, createdAt, [pageId+columnIndex+order], deletedAt',
    bookmarks: '++id, boardId, title, url, description, order, createdAt, deletedAt',
    favicons: 'id, hostname, url, timestamp'
});
// Version 9: Remove private page/encryption fields (feature removed)
db.version(9).stores({
    pages: '++id, name, order, createdAt, isDefault, deletedAt',
    boards: '++id, pageId, name, columnIndex, order, createdAt, [pageId+columnIndex+order], deletedAt',
    bookmarks: '++id, boardId, title, url, description, order, createdAt, deletedAt',
    favicons: 'id, hostname, url, timestamp'
});
// Version 8: Add passcode recovery support (encryptedKeyBackup for account-linked recovery)
db.version(8).stores({
    pages: '++id, name, order, createdAt, isDefault, isPrivate, passcodeHash, encryptionSalt, encryptedKeyBackup, deletedAt',
    boards: '++id, pageId, name, columnIndex, order, createdAt, [pageId+columnIndex+order], deletedAt',
    bookmarks: '++id, boardId, title, url, description, order, createdAt, deletedAt',
    favicons: 'id, hostname, url, timestamp'
});
// Version 7: Add encryption support for private pages
db.version(7).stores({
    pages: '++id, name, order, createdAt, isDefault, isPrivate, passcodeHash, encryptionSalt, deletedAt',
    boards: '++id, pageId, name, columnIndex, order, createdAt, [pageId+columnIndex+order], deletedAt',
    bookmarks: '++id, boardId, title, url, description, order, createdAt, deletedAt',
    favicons: 'id, hostname, url, timestamp'
});
// Version 6: Add soft delete support (deletedAt for trash feature)
db.version(6).stores({
    pages: '++id, name, order, createdAt, isDefault, isPrivate, passcodeHash, deletedAt',
    boards: '++id, pageId, name, columnIndex, order, createdAt, [pageId+columnIndex+order], deletedAt',
    bookmarks: '++id, boardId, title, url, description, order, createdAt, deletedAt',
    favicons: 'id, hostname, url, timestamp'
});
// Version 5: Add private page support
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

// Maintain version 2 for backward compatibility
db.version(2).stores({
    boards: '++id, name, columnIndex, order, createdAt, [columnIndex+order]',
    bookmarks: '++id, boardId, title, url, description, order, createdAt'
});

// FIX [Issue #5]: Add event handlers for IndexedDB schema upgrade blocking
// When multiple tabs are open and one tries to upgrade, others may block the upgrade
db.on('blocked', () => {
    console.warn('Database upgrade blocked - please close other LumiList tabs');
    // Show user-friendly notification
    alert('LumiList needs to update its database. Please close other LumiList tabs and refresh this page.');
});

db.on('versionchange', (event) => {

    db.close();
    // Reload the page to pick up the new database version
    alert('LumiList has been updated in another tab. This page will now refresh.');
    window.location.reload();
});

// Global state for current active page
let currentPageId = null;
let currentPageToRename = null;    // Track page being renamed via modal
let pageTabsSortableInstance = null; // SortableJS instance for page tabs

// Privacy blur mode state
let privacyModeEnabled = false;

// Incognito mode state - opens links in incognito windows
let incognitoModeEnabled = false;

// Compact mode state - reduces spacing and sizes
let compactModeEnabled = false;

// Device-local floating controls preference.
let floatingControlsCollapsedEnabled = false;

// Bookmark note visibility state (controls inline note rendering under titles).
// Default ON so descriptions are visible unless user explicitly disables them.
let showBookmarkNotes = true;
let closeTabsAfterSaveAllTabsEnabled = false;

// Usage Tracking Insights state
let usageTrackingEnabled = false;
const USAGE_TRACKING_STORAGE_KEY = 'usageTrackingEnabled';

// Clock state
let showClockEnabled = false;
let autoBoardColorEnabled = false;
let clockIntervalId = null;

// Smart Folders state
let smartFoldersEnabled = false;
const SMART_FOLDERS_STORAGE_KEY = 'smartFoldersEnabled';

// Tagging System state
let taggingEnabled = false;
const TAGGING_STORAGE_KEY = 'taggingEnabled';

// Advanced Search state
let advancedSearchEnabled = false;
const ADVANCED_SEARCH_STORAGE_KEY = 'advancedSearchEnabled';

// Fuzzy Search state
let fuzzySearchEnabled = false;
const FUZZY_SEARCH_STORAGE_KEY = 'fuzzySearchEnabled';

// Recently Used state
let recentlyUsedEnabled = false;
const RECENTLY_USED_STORAGE_KEY = 'recentlyUsedEnabled';

// Frequently Used state
let frequentlyUsedEnabled = false;
const FREQUENTLY_USED_STORAGE_KEY = 'frequentlyUsedEnabled';

// Pin Favorites state
let pinFavoritesEnabled = false;
const PIN_FAVORITES_STORAGE_KEY = 'pinFavoritesEnabled';

// Large board collapse setting - show first N bookmarks with manual expand
let largeBoardCollapseEnabled = false;
const LARGE_BOARD_VISIBLE_LIMIT_OPTIONS = [5, 10, 15, 20, 25, 30, 40, 50];
const LARGE_BOARD_VISIBLE_LIMIT_DEFAULT = 10;
const LARGE_BOARD_VISIBLE_LIMIT_STORAGE_KEY = 'largeBoardVisibleBookmarkLimit';
let largeBoardVisibleBookmarkLimit = LARGE_BOARD_VISIBLE_LIMIT_DEFAULT;
const LARGE_BOARD_EXPANDED_IDS_STORAGE_KEY = 'largeBoardExpandedBoardIds';
const expandedLargeBoardIds = new Set();

// Theme mode state - dark (default) or light
let themeMode = 'dark';
const WALLPAPER_STORAGE_KEY = 'wallpaperSelectionByTheme';
const PAGE_WALLPAPERS_STORAGE_KEY = 'pageWallpaperSelections';
const WALLPAPER_LOCAL_CACHE_KEY = 'lumilist_wallpaper_selection';
const WALLPAPER_STYLE_LOCAL_CACHE_KEY = 'lumilist_wallpaper_style_by_theme';
const WALLPAPER_BINARY_CACHE_LOCAL_KEY = 'lumilist_wallpaper_binary_cache_v1';
const WALLPAPER_BOOT_STYLE_CACHE_PREFIX = 'lumilist_wallpaper_boot_style_';
const WALLPAPER_BOOT_BINARY_CACHE_PREFIX = 'lumilist_wallpaper_boot_binary_';
const WALLPAPER_BOOT_SOURCE_CACHE_PREFIX = 'lumilist_wallpaper_boot_source_';
const WALLPAPER_BOOT_AUTH_HINT_LOCAL_KEY = 'lumilist_wallpaper_boot_auth_hint_v1';
const WALLPAPER_LOGGED_OUT_DEFAULT_SNAPSHOT_LOCAL_KEY = 'lumilist_logged_out_default_visual_v1';
const WALLPAPER_ACCOUNT_LOCAL_STATE_STORAGE_KEY = 'wallpaperLocalStateByUser';
const WALLPAPER_CLOUD_SYNC_STATE_STORAGE_KEY = 'wallpaperCloudSyncState';
const WALLPAPER_PENDING_HANDOFF_STORAGE_KEY = 'lumilist_pending_wallpaper_handoff_v1';
const WALLPAPER_NEW_USER_DEFAULT_SEED_STORAGE_KEY = 'lumilist_pending_new_user_wallpaper_default_seed_v1';
const WALLPAPER_DIAGNOSTICS_LOCAL_KEY = 'lumilist_wallpaper_diagnostics_v1';
const WALLPAPER_DIAGNOSTICS_MAX_EVENTS = 60;
const WALLPAPER_RUNTIME_ROLLOUT_FLAGS = Object.freeze({
    explicitRemoteGallery: true,
    localInstallOnDemand: true,
    hostedStartupMergeDisabled: true,
    cloudPreferenceSync: true,
    diagnosticsEnabled: true
});
const WALLPAPER_DIAGNOSTIC_COUNTER_KEYS = Object.freeze([
    'hostedCatalogRequests',
    'hostedCatalogFailures',
    'galleryManifestRequests',
    'galleryManifestFailures',
    'installDownloads',
    'installFailures',
    'migrationAttempts',
    'migrationFailures',
    'bootFallbackUses'
]);
const WALLPAPER_SYNC_METADATA_RECORD_ID = 'wallpaper_preferences';
const INSTALLED_WALLPAPER_CATALOG_VERSION_STORAGE_KEY = 'installedWallpaperCatalogVersion';
const INSTALLED_WALLPAPER_SOURCE_PREFIX = 'lumilist-installed://';
const LOCAL_USER_WALLPAPER_SOURCE_TYPE = 'user-upload';
const WALLPAPER_CATALOG_PATH = 'wallpaper/catalog.json';
const WALLPAPER_REMOTE_CATALOG_URL = 'https://xbccmcszhnybxzlirjgk.supabase.co/storage/v1/object/public/wallpaper/catalog.json';
const WALLPAPER_REMOTE_GALLERY_URL = 'https://xbccmcszhnybxzlirjgk.supabase.co/storage/v1/object/public/wallpaper/gallery.json';
const WALLPAPER_REMOTE_STORAGE_PREFIX = 'https://xbccmcszhnybxzlirjgk.supabase.co/storage/v1/object/public/wallpaper/';
const WALLPAPER_GALLERY_URL = 'https://lumilist.in/wallpapers/';
const WALLPAPER_FILE_PATTERN = /\.(?:jpg|jpeg|png|webp|avif)$/i;
const WALLPAPER_URL_PARAM = 'wallpaper';
const WALLPAPER_GALLERY_ID_URL_PARAM = 'wallpaperGalleryId';
const WALLPAPER_THEME_URL_PARAM = 'wallpaperTheme';
const DEFAULT_WALLPAPER_TILE_ID = '__default__';
const DEFAULT_WALLPAPER_THEME_STYLES = {
    dark: {
        primary: '#05E57B',
        activeTextColor: '#1A1F2E',
        tabHoverTextColor: '#D5DEE8',
        inactiveTabTextColor: '#B8C5D1',
        boardTextColor: '#B8C5D1',
        linkDescriptionTextColor: '#8A9AAA',
        iconColor: '#B8C5D1',
        tabArrowColor: '#B8C5D1',
        addBoardColor: '#2DFFB1',
        boardBackgroundColor: '#292E3D',
        boardBackgroundOpacity: 0.5,
        boardBackdropBlur: 16,
        boardBackdropSaturate: 120,
        inactiveControlColor: '#3A4652',
        inactiveControlOpacity: 0.6,
        inactiveControlBackdropBlur: 12,
        inactiveControlBackdropSaturate: 120,
        popupBackgroundColor: '#282C34',
        popupBackgroundOpacity: 0.92,
        popupCardBackgroundColor: '#FFFFFF',
        popupCardBackgroundOpacity: 0.05,
        dropdownBackgroundColor: '#3E455B',
        dropdownBackgroundOpacity: 0.9,
        overlay: {
            angle: 180,
            topColor: '#212531',
            topOpacity: 0.58,
            bottomColor: '#212531',
            bottomOpacity: 0.76
        }
    },
    light: {
        primary: '#00B868',
        activeTextColor: '#F4FBF8',
        tabHoverTextColor: '#F4FBF8',
        inactiveTabTextColor: '#273D57',
        boardTextColor: '#273D57',
        linkDescriptionTextColor: '#607892',
        iconColor: '#273D57',
        tabArrowColor: '#273D57',
        addBoardColor: '#00D97A',
        boardBackgroundColor: '#FFFFFF',
        boardBackgroundOpacity: 0.38,
        boardBackdropBlur: 16,
        boardBackdropSaturate: 120,
        inactiveControlColor: '#F3F0FF',
        inactiveControlOpacity: 0.45,
        inactiveControlBackdropBlur: 12,
        inactiveControlBackdropSaturate: 120,
        popupBackgroundColor: '#FFFFFF',
        popupBackgroundOpacity: 0.94,
        popupCardBackgroundColor: '#FFFFFF',
        popupCardBackgroundOpacity: 0.95,
        dropdownBackgroundColor: '#FFFFFF',
        dropdownBackgroundOpacity: 0.92,
        overlay: {
            angle: 180,
            topColor: '#F5F4F0',
            topOpacity: 0.18,
            bottomColor: '#F5F4F0',
            bottomOpacity: 0.34
        }
    }
};
let bundledWallpaperCatalogByTheme = { dark: [], light: [] };
let installedWallpaperCatalogByTheme = { dark: [], light: [] };
let wallpaperCatalogByTheme = { dark: [], light: [] };
let wallpaperSelectionByTheme = { dark: null, light: null };
let pageWallpaperSelections = {};

function getWallpaperSelectionByTheme(options = {}) {
    const { ignorePageSpecific = false } = options;
    if (!ignorePageSpecific && typeof currentPageId !== 'undefined' && currentPageId && pageWallpaperSelections && pageWallpaperSelections[currentPageId]) {
        return pageWallpaperSelections[currentPageId];
    }
    return wallpaperSelectionByTheme;
}
let wallpaperThemeDefaults = createEmptyWallpaperThemeDefaults();
let wallpaperStyleOverridesByTheme = createEmptyWallpaperStyleOverrideState();
let wallpaperNewUserDefaultConfig = createEmptyNewUserWallpaperDefaultConfig();
let hostedWallpaperCatalogPromise = null;
let hostedWallpaperGalleryPromise = null;
let installedWallpaperRecordsByRef = new Map();
let installedWallpaperObjectUrlsByRef = new Map();
let installedWallpaperCatalogVersion = null;
let wallpaperCloudSyncState = null;
let wallpaperAccountScopeUserId = null;
let wallpaperPreferenceSyncReadyUserId = null;
let wallpaperPreferenceSyncPending = false;
let wallpaperPreferencesInitialized = false;
let wallpaperCloudSyncApplyChain = Promise.resolve();
let wallpaperLastAppliedCloudSyncFingerprint = null;
const pendingWallpaperCloudSyncFingerprints = new Set();
let pendingLoggedOutThemeResetPromise = null;

const QUICK_SAVE_COMMAND_NAME = 'quick-save';
const SHORTCUTS_SETTINGS_URL = 'chrome://extensions/shortcuts';
const EXTENSIONS_SETTINGS_URL = 'chrome://extensions';
const SYNC_USER_STORAGE_KEY = 'lumilist_user';
const SYNC_SESSION_INVALIDATED_STORAGE_KEY = 'lumilist_session_invalidated';
const LOGIN_SYNC_STATE_STORAGE_KEY = 'lumilist_login_sync_state';
const SHOW_BOOKMARK_NOTES_STORAGE_KEY = 'showBookmarkNotes';
const CLOSE_TABS_AFTER_SAVE_ALL_STORAGE_KEY = 'closeTabsAfterSaveAllTabs';
const FLOATING_CONTROLS_COLLAPSED_STORAGE_KEY = 'floatingControlsCollapsedEnabled';
const SHOW_CLOCK_STORAGE_KEY = 'showClockEnabled';
const AUTO_BOARD_COLOR_STORAGE_KEY = 'autoBoardColorEnabled';
const FONT_COLOR_STORAGE_KEY = 'fontColor';
const FONT_COLOR_LOCAL_CACHE_KEY = 'lumilist_font_color';
const CLOCK_POSITION_STORAGE_KEY = 'clockPosition';
const CLOCK_SIZE_STORAGE_KEY = 'clockSize';
const STARTUP_STORAGE_KEYS = Object.freeze([
    SYNC_USER_STORAGE_KEY,
    SYNC_SESSION_INVALIDATED_STORAGE_KEY,
    WALLPAPER_ACCOUNT_LOCAL_STATE_STORAGE_KEY,
    WALLPAPER_CLOUD_SYNC_STATE_STORAGE_KEY,
    'themeMode',
    'initialized',
    'currentPageId',
    'privacyModeEnabled',
    'incognitoModeEnabled',
    'compactModeEnabled',
    'truncateTitles',
    'openInNewTab',
    SHOW_BOOKMARK_NOTES_STORAGE_KEY,
    CLOSE_TABS_AFTER_SAVE_ALL_STORAGE_KEY,
    FLOATING_CONTROLS_COLLAPSED_STORAGE_KEY,
    SHOW_CLOCK_STORAGE_KEY,
    USAGE_TRACKING_STORAGE_KEY,
    SMART_FOLDERS_STORAGE_KEY,
    TAGGING_STORAGE_KEY,
    ADVANCED_SEARCH_STORAGE_KEY,
    FUZZY_SEARCH_STORAGE_KEY,
    RECENTLY_USED_STORAGE_KEY,
    FREQUENTLY_USED_STORAGE_KEY,
    PIN_FAVORITES_STORAGE_KEY,
    FONT_COLOR_STORAGE_KEY,
    AUTO_BOARD_COLOR_STORAGE_KEY,
    'largeBoardCollapseEnabled',
    LARGE_BOARD_VISIBLE_LIMIT_STORAGE_KEY,
    LARGE_BOARD_EXPANDED_IDS_STORAGE_KEY,
    PAGE_WALLPAPERS_STORAGE_KEY
]);
const BOOKMARK_DESCRIPTION_MAX_LENGTH = 2000;

// Global state for live search overlay
const searchState = {
    isOpen: false,
    query: '',
    scope: 'all',
    matchMode: 'smart',
    dataset: [],
    keyboardItems: [],
    activeItemIndex: -1,
    behavior: {
        boards: {},
        bookmarks: {}
    }
};

// Flag to track if initial auth/sync completed - used by cross-tab storage listeners
let initialAuthCompleted = false;

// Feature flag for DOM morphing (set to false to use legacy rendering)
const USE_IDIOMORPH = true;

// Flag to track when current tab is actively authenticating (prevents cross-tab handler from firing on own changes)
// Exposed on window so sync.js can check it during token clearing decisions
let isCurrentTabAuthenticating = false;
window.isCurrentTabAuthenticating = false;

// Loading overlay state management
let isInitialLoadComplete = false;
const WORKSPACE_STARTUP_INDICATOR_DELAY_MS = 180;
let workspaceStartupIndicatorTimeoutId = null;

// Deduplication for cross-tab auth changes (prevents duplicate processing on unstable networks)
// Tracks both userId AND oldUserId to allow rapid same-account re-login
let _lastProcessedAuthChange = { userId: null, oldUserId: null, timestamp: 0 };

// FIX [C5]: Track the last sync timestamp for deduplication across multiple handlers
// Both storage.onChanged and onAuthStateChange can trigger syncs on cross-tab login
// The re-entrancy guard in autoSyncOnLoad() handles most cases, this adds extra safety
let _lastAuthSyncTimestamp = 0;
const AUTH_SYNC_DEBOUNCE_MS = 2000; // 2 second window for deduplication

// Flag to prevent onAuthStateChange from racing with storage listener during cross-tab login
// When storage listener starts handling login, this blocks onAuthStateChange SIGNED_IN from racing
let _crossTabLoginInProgress = false;

// Pending cross-tab auth signals that arrive before initialization completes
let _pendingAuthChange = null;
let _pendingLoginSyncSignal = null;
let _isHandlingSessionInvalidation = false;
let _suppressLateAuthReconcileUntil = 0;
let customFontColor = null;

function normalizeRuntimeUserId(userId) {
    return (typeof userId === 'string' && userId.trim()) ? userId.trim() : null;
}

function setWorkspaceOwnerUserId(userId) {
    const normalized = normalizeRuntimeUserId(userId);
    window.__lumilistWorkspaceOwnerUserId = normalized;
    setWallpaperAccountScopeUserId(normalized);
}

function setActiveStoredUserId(userId) {
    window.__lumilistActiveStoredUserId = normalizeRuntimeUserId(userId);
}

function writeThemeBootstrapAuthHint(isAuthenticated) {
    try {
        localStorage.setItem(
            WALLPAPER_BOOT_AUTH_HINT_LOCAL_KEY,
            isAuthenticated === true ? 'authenticated' : 'logged_out'
        );
    } catch (_error) {
        // Non-blocking bootstrap hint cache.
    }
}

function getActiveStoredUserId() {
    return normalizeRuntimeUserId(window.__lumilistActiveStoredUserId);
}

async function getCurrentStoredUserId() {
    const activeStoredUserId = getActiveStoredUserId();
    if (activeStoredUserId) {
        return activeStoredUserId;
    }

    try {
        if (typeof SyncManager !== 'undefined' && typeof SyncManager.getStoredUser === 'function') {
            const storedUser = await SyncManager.getStoredUser();
            const storedUserId = normalizeRuntimeUserId(storedUser?.id);
            if (storedUserId) {
                return storedUserId;
            }
        }
    } catch (error) {
        console.warn('Failed to read stored user from SyncManager:', error);
    }

    try {
        if (typeof chrome !== 'undefined' && chrome.storage?.local) {
            const result = await chrome.storage.local.get('lumilist_user');
            return normalizeRuntimeUserId(result?.lumilist_user?.id);
        }
    } catch (error) {
        console.warn('Failed to read stored user from storage:', error);
    }

    return null;
}

function getWorkspaceMutationBlockedReason() {
    const workspaceOwnerUserId = normalizeRuntimeUserId(window.__lumilistWorkspaceOwnerUserId);
    const activeStoredUserId = getActiveStoredUserId();

    if (_crossTabLoginInProgress) {
        return 'LumiList is still syncing this account. Please wait a moment and try again.';
    }

    if (workspaceOwnerUserId && activeStoredUserId && workspaceOwnerUserId !== activeStoredUserId) {
        return 'This tab is out of date after an account change. Reload LumiList before editing.';
    }

    if (workspaceOwnerUserId && !activeStoredUserId) {
        return 'You are signed out in this tab. Reload LumiList before editing.';
    }

    return null;
}

function showWorkspaceMutationBlockedToast(reason, cooldownMs = 3000) {
    if (!reason) return;
    if (!window._lastStaleWorkspaceToastAt) window._lastStaleWorkspaceToastAt = 0;
    const now = Date.now();
    if (now - window._lastStaleWorkspaceToastAt > cooldownMs) {
        window._lastStaleWorkspaceToastAt = now;
        showGlassToast(reason, 'warning');
    }
}

function canMutateAccountScopedPreferences() {
    const workspaceMutationBlockedReason = getWorkspaceMutationBlockedReason();
    if (workspaceMutationBlockedReason) {
        showWorkspaceMutationBlockedToast(workspaceMutationBlockedReason);
        return false;
    }
    return true;
}

function isAuthBoundaryStorageChange(change) {
    if (!change || typeof change !== 'object') return false;
    const oldUserId = normalizeRuntimeUserId(change.oldValue?.id);
    const newUserId = normalizeRuntimeUserId(change.newValue?.id);
    return oldUserId !== newUserId;
}

function shouldApplyAccountScopedStorageUpdate(lumilistUserChange = null) {
    if (_crossTabLoginInProgress) {
        return false;
    }

    if (isAuthBoundaryStorageChange(lumilistUserChange)) {
        return false;
    }

    const workspaceOwnerUserId = normalizeRuntimeUserId(window.__lumilistWorkspaceOwnerUserId);
    const activeStoredUserId = getActiveStoredUserId();

    if (!workspaceOwnerUserId || !activeStoredUserId) {
        return false;
    }

    return workspaceOwnerUserId === activeStoredUserId;
}

function suppressLateAuthReconcile(durationMs = 30000) {
    const resolvedDurationMs = Number.isFinite(durationMs) ? Math.max(durationMs, 0) : 30000;
    _suppressLateAuthReconcileUntil = Date.now() + resolvedDurationMs;
}

function clearLateAuthReconcileSuppression() {
    _suppressLateAuthReconcileUntil = 0;
}

function isLateAuthReconcileSuppressed() {
    return _suppressLateAuthReconcileUntil > Date.now();
}

function resetCrossTabLoginWaitState({ clearPendingAuthChange = false, clearPendingSignal = false } = {}) {
    _crossTabLoginInProgress = false;
    _pendingCrossTabLoginUserId = null;

    if (_crossTabLoginTimeoutId) {
        clearTimeout(_crossTabLoginTimeoutId);
        _crossTabLoginTimeoutId = null;
    }

    if (clearPendingAuthChange) {
        _pendingAuthChange = null;
    }
    if (clearPendingSignal) {
        _pendingLoginSyncSignal = null;
    }
}

function normalizeLoginSyncState(rawState) {
    if (!rawState || typeof rawState !== 'object') return null;
    const userId = (typeof rawState.userId === 'string' && rawState.userId.trim())
        ? rawState.userId.trim()
        : null;
    const phase = (typeof rawState.phase === 'string' && rawState.phase.trim())
        ? rawState.phase.trim()
        : null;
    const action = (typeof rawState.action === 'string' && rawState.action.trim())
        ? rawState.action.trim()
        : null;
    const timestamp = Number(rawState.timestamp);

    if (!userId || !phase) return null;

    return {
        userId,
        phase,
        action,
        timestamp: Number.isFinite(timestamp) ? timestamp : 0
    };
}

async function getStoredLoginSyncState() {
    if (!(typeof chrome !== 'undefined' && chrome.storage?.local?.get)) {
        return null;
    }

    try {
        const result = await chrome.storage.local.get(LOGIN_SYNC_STATE_STORAGE_KEY);
        return normalizeLoginSyncState(result?.[LOGIN_SYNC_STATE_STORAGE_KEY]);
    } catch (error) {
        console.warn('Failed to read stored login sync state:', error);
        return null;
    }
}

async function analyzeBookmarkUsage() {
    try {
        const allBookmarks = await db.bookmarks.filter(b => !b.deletedAt).toArray();
        if (allBookmarks.length === 0) {
            return {
                top_used: [],
                least_used: [],
                suggest_remove: [],
                insights: "No bookmark data available yet. Start visiting your bookmarks to see insights!"
            };
        }

        // 1. Identify top 5 most used bookmarks
        const sortedByVisit = [...allBookmarks].sort((a, b) => (b.visitCount || 0) - (a.visitCount || 0));
        const topUsed = sortedByVisit.slice(0, 5).map(b => ({
            id: b.id,
            title: b.title || 'Untitled',
            url: b.url,
            visit_count: b.visitCount || 0
        }));

        // 2. Identify rarely used bookmarks (visit_count low or not visited recently)
        const now = new Date();
        const thirtyDaysAgo = new Date(now.setDate(now.getDate() - 30));
        
        const leastUsed = allBookmarks
            .filter(b => (b.visitCount || 0) < 2 || (b.lastVisited && new Date(b.lastVisited) < thirtyDaysAgo))
            .sort((a, b) => (a.visitCount || 0) - (b.visitCount || 0))
            .slice(0, 5)
            .map(b => ({
                id: b.id,
                title: b.title || 'Untitled',
                url: b.url,
                visit_count: b.visitCount || 0,
                last_visited: b.lastVisited || 'Never'
            }));

        // 3. Suggest bookmarks that can be removed or archived
        // (Bookmarks not visited in 60 days or with 0 visits and created > 30 days ago)
        const sixtyDaysAgo = new Date();
        sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
        const suggestRemove = allBookmarks
            .filter(b => {
                const neverVisited = !b.lastVisited && new Date(b.createdAt) < thirtyDaysAgo;
                const oldVisit = b.lastVisited && new Date(b.lastVisited) < sixtyDaysAgo;
                return neverVisited || oldVisit;
            })
            .slice(0, 5)
            .map(b => ({
                id: b.id,
                title: b.title || 'Untitled',
                url: b.url
            }));

        // 4. Detect patterns (simple domain-based pattern for now)
        const domains = allBookmarks.map(b => {
            try {
                return new URL(b.url).hostname;
            } catch (e) {
                return null;
            }
        }).filter(Boolean);
        
        const domainCounts = {};
        domains.forEach(d => domainCounts[d] = (domainCounts[d] || 0) + 1);
        const topDomain = Object.entries(domainCounts).sort((a, b) => b[1] - a[1])[0];
        
        let insights = "";
        if (topDomain) {
            insights = `You have ${topDomain[1]} bookmarks from ${topDomain[0]}. This seems to be a major category for you. `;
        }
        insights += `You've visited your top bookmark ${topUsed[0]?.visit_count || 0} times.`;

        return {
            top_used: topUsed,
            least_used: leastUsed,
            suggest_remove: suggestRemove,
            insights: insights
        };
    } catch (error) {
        console.error('Failed to analyze bookmark usage:', error);
        return null;
    }
}

function renderInsightsUI(data) {
    const content = document.getElementById('insightsContent');
    if (!content || !data) return;

    if (data.top_used.length === 0 && data.least_used.length === 0) {
        content.innerHTML = `<div class="insights-summary">${data.insights}</div>`;
        return;
    }

    let html = '';

    // Top Used
    if (data.top_used.length > 0) {
        html += `
            <div class="insights-section">
                <div class="insights-section-title">Top 5 Most Used</div>
                <ul class="insights-list">
                    ${data.top_used.map(b => `
                        <li class="insights-item">
                            <div class="insights-item-info">
                                <span class="insights-item-title">${escapeHTML(b.title)}</span>
                                <div class="insights-item-meta">${b.visit_count} visits</div>
                            </div>
                        </li>
                    `).join('')}
                </ul>
            </div>
        `;
    }

    // Least Used
    if (data.least_used.length > 0) {
        html += `
            <div class="insights-section">
                <div class="insights-section-title">Rarely Used</div>
                <ul class="insights-list">
                    ${data.least_used.map(b => `
                        <li class="insights-item">
                            <div class="insights-item-info">
                                <span class="insights-item-title">${escapeHTML(b.title)}</span>
                                <div class="insights-item-meta">Last: ${b.last_visited === 'Never' ? 'Never' : new Date(b.last_visited).toLocaleDateString()}</div>
                            </div>
                        </li>
                    `).join('')}
                </ul>
            </div>
        `;
    }

    // Suggestions
    if (data.suggest_remove.length > 0) {
        html += `
            <div class="insights-section">
                <div class="insights-section-title">Suggestions to Archive</div>
                <ul class="insights-list">
                    ${data.suggest_remove.map(b => `
                        <li class="insights-item">
                            <div class="insights-item-info">
                                <span class="insights-item-title">${escapeHTML(b.title)}</span>
                            </div>
                        </li>
                    `).join('')}
                </ul>
            </div>
        `;
    }

    // Insights
    html += `
        <div class="insights-section">
            <div class="insights-section-title">General Patterns</div>
            <div class="insights-summary">${escapeHTML(data.insights)}</div>
        </div>
    `;

    content.innerHTML = html;
}

async function updateUsageTrackingVisibility() {
    const btn = document.getElementById('floatingInsightsBtn');
    if (!btn) return;

    if (usageTrackingEnabled) {
        btn.classList.remove('hidden');
    } else {
        btn.classList.add('hidden');
        closeInsightsPopup();
    }
}

async function toggleSmartFoldersSetting() {
    const toggle = document.getElementById('smartFoldersToggle');
    smartFoldersEnabled = toggle?.checked === true;
    window.smartFoldersEnabled = smartFoldersEnabled;
    try {
        await chrome.storage.local.set({ [SMART_FOLDERS_STORAGE_KEY]: smartFoldersEnabled });
        await loadBoardsFromDatabase();
    } catch (error) {
        console.error('Error saving smart folders setting:', error);
    }
}

async function toggleTaggingSetting() {
    const toggle = document.getElementById('taggingToggle');
    taggingEnabled = toggle?.checked === true;
    window.taggingEnabled = taggingEnabled;
    try {
        await chrome.storage.local.set({ [TAGGING_STORAGE_KEY]: taggingEnabled });
        await loadBoardsFromDatabase();
    } catch (error) {
        console.error('Error saving tagging setting:', error);
    }
}

async function toggleAdvancedSearchSetting() {
    const toggle = document.getElementById('advancedSearchToggle');
    advancedSearchEnabled = toggle?.checked === true;
    window.advancedSearchEnabled = advancedSearchEnabled;
    try {
        await chrome.storage.local.set({ [ADVANCED_SEARCH_STORAGE_KEY]: advancedSearchEnabled });
    } catch (error) {
        console.error('Error saving advanced search setting:', error);
    }
}

async function toggleFuzzySearchSetting() {
    const toggle = document.getElementById('fuzzySearchToggle');
    fuzzySearchEnabled = toggle?.checked === true;
    window.fuzzySearchEnabled = fuzzySearchEnabled;
    try {
        await chrome.storage.local.set({ [FUZZY_SEARCH_STORAGE_KEY]: fuzzySearchEnabled });
    } catch (error) {
        console.error('Error saving fuzzy search setting:', error);
    }
}

async function toggleRecentlyUsedSetting() {
    const toggle = document.getElementById('recentlyUsedToggle');
    recentlyUsedEnabled = toggle?.checked === true;
    window.recentlyUsedEnabled = recentlyUsedEnabled;
    if (recentlyUsedEnabled && frequentlyUsedEnabled) {
        frequentlyUsedEnabled = false;
        window.frequentlyUsedEnabled = false;
        const freqToggle = document.getElementById('frequentlyUsedToggle');
        if (freqToggle) freqToggle.checked = false;
        await chrome.storage.local.set({ [FREQUENTLY_USED_STORAGE_KEY]: false });
    }
    try {
        await chrome.storage.local.set({ [RECENTLY_USED_STORAGE_KEY]: recentlyUsedEnabled });
        await loadBoardsFromDatabase();
    } catch (error) {
        console.error('Error saving recently used setting:', error);
    }
}

async function toggleFrequentlyUsedSetting() {
    const toggle = document.getElementById('frequentlyUsedToggle');
    frequentlyUsedEnabled = toggle?.checked === true;
    window.frequentlyUsedEnabled = frequentlyUsedEnabled;
    if (frequentlyUsedEnabled && recentlyUsedEnabled) {
        recentlyUsedEnabled = false;
        window.recentlyUsedEnabled = false;
        const recToggle = document.getElementById('recentlyUsedToggle');
        if (recToggle) recToggle.checked = false;
        await chrome.storage.local.set({ [RECENTLY_USED_STORAGE_KEY]: false });
    }
    try {
        await chrome.storage.local.set({ [FREQUENTLY_USED_STORAGE_KEY]: frequentlyUsedEnabled });
        await loadBoardsFromDatabase();
    } catch (error) {
        console.error('Error saving frequently used setting:', error);
    }
}

async function togglePinFavoritesSetting() {
    const toggle = document.getElementById('pinFavoritesToggle');
    pinFavoritesEnabled = toggle?.checked === true;
    window.pinFavoritesEnabled = pinFavoritesEnabled;
    try {
        await chrome.storage.local.set({ [PIN_FAVORITES_STORAGE_KEY]: pinFavoritesEnabled });
        await loadBoardsFromDatabase();
    } catch (error) {
        console.error('Error saving pin favorites setting:', error);
    }
}

async function toggleUsageTrackingSetting() {
    const toggle = document.getElementById('usageTrackingToggle');
    const previousValue = usageTrackingEnabled;
    const nextValue = toggle?.checked === true;

    usageTrackingEnabled = nextValue;
    updateUsageTrackingVisibility();

    try {
        await chrome.storage.local.set({ [USAGE_TRACKING_STORAGE_KEY]: usageTrackingEnabled });
    } catch (error) {
        console.error('Error saving usage tracking setting:', error);
        usageTrackingEnabled = previousValue;
        updateUsageTrackingVisibility();
        if (toggle) toggle.checked = previousValue;
    }
}

async function loadAllSettings() {
    try {
        const result = await chrome.storage.local.get([
            USAGE_TRACKING_STORAGE_KEY,
            SMART_FOLDERS_STORAGE_KEY,
            TAGGING_STORAGE_KEY,
            ADVANCED_SEARCH_STORAGE_KEY,
            FUZZY_SEARCH_STORAGE_KEY,
            RECENTLY_USED_STORAGE_KEY,
            FREQUENTLY_USED_STORAGE_KEY,
            PIN_FAVORITES_STORAGE_KEY
        ]);

        usageTrackingEnabled = result[USAGE_TRACKING_STORAGE_KEY] === true;
        updateUsageTrackingVisibility();
        const usageToggle = document.getElementById('usageTrackingToggle');
        if (usageToggle) usageToggle.checked = usageTrackingEnabled;

        smartFoldersEnabled = result[SMART_FOLDERS_STORAGE_KEY] === true;
        const smartFoldersToggle = document.getElementById('smartFoldersToggle');
        if (smartFoldersToggle) smartFoldersToggle.checked = smartFoldersEnabled;

        taggingEnabled = result[TAGGING_STORAGE_KEY] === true;
        const taggingToggle = document.getElementById('taggingToggle');
        if (taggingToggle) taggingToggle.checked = taggingEnabled;

        advancedSearchEnabled = result[ADVANCED_SEARCH_STORAGE_KEY] === true;
        const advancedSearchToggle = document.getElementById('advancedSearchToggle');
        if (advancedSearchToggle) advancedSearchToggle.checked = advancedSearchEnabled;

        fuzzySearchEnabled = result[FUZZY_SEARCH_STORAGE_KEY] === true;
        const fuzzySearchToggle = document.getElementById('fuzzySearchToggle');
        if (fuzzySearchToggle) fuzzySearchToggle.checked = fuzzySearchEnabled;

        recentlyUsedEnabled = result[RECENTLY_USED_STORAGE_KEY] === true;
        const recentlyUsedToggle = document.getElementById('recentlyUsedToggle');
        if (recentlyUsedToggle) recentlyUsedToggle.checked = recentlyUsedEnabled;

        frequentlyUsedEnabled = result[FREQUENTLY_USED_STORAGE_KEY] === true;
        const frequentlyUsedToggle = document.getElementById('frequentlyUsedToggle');
        if (frequentlyUsedToggle) frequentlyUsedToggle.checked = frequentlyUsedEnabled;

        pinFavoritesEnabled = result[PIN_FAVORITES_STORAGE_KEY] === true;
        const pinFavoritesToggle = document.getElementById('pinFavoritesToggle');
        if (pinFavoritesToggle) pinFavoritesToggle.checked = pinFavoritesEnabled;

        // Attach to window for other modules
        window.smartFoldersEnabled = smartFoldersEnabled;
        window.taggingEnabled = taggingEnabled;
        window.advancedSearchEnabled = advancedSearchEnabled;
        window.fuzzySearchEnabled = fuzzySearchEnabled;
        window.recentlyUsedEnabled = recentlyUsedEnabled;
        window.frequentlyUsedEnabled = frequentlyUsedEnabled;
        window.pinFavoritesEnabled = pinFavoritesEnabled;

    } catch (error) {
        console.error('Error loading settings:', error);
    }
}

async function loadUsageTrackingSetting() {
    await loadAllSettings();
}

function openInsightsPopup() {
    const popup = document.getElementById('insightsPopup');
    const btn = document.getElementById('floatingInsightsBtn');
    if (!popup || !btn) return;

    popup.classList.add('active');
    btn.classList.add('active');
    
    // Position near button
    if (typeof positionFloatingPopupNearButton === 'function') {
        positionFloatingPopupNearButton(popup, btn);
    }

    // Trigger analysis
    analyzeBookmarkUsage().then(data => {
        renderInsightsUI(data);
    });
}

function closeInsightsPopup() {
    const popup = document.getElementById('insightsPopup');
    const btn = document.getElementById('floatingInsightsBtn');
    if (!popup) return;

    popup.classList.remove('active');
    if (btn) btn.classList.remove('active');
}

function toggleInsightsPopup() {
    const popup = document.getElementById('insightsPopup');
    if (popup?.classList.contains('active')) {
        closeInsightsPopup();
    } else {
        openInsightsPopup();
    }
}

async function trackBookmarkVisit(bookmarkId) {
    if (!bookmarkId) return;
    try {
        const bookmark = await db.bookmarks.get(bookmarkId);
        if (bookmark) {
            const now = new Date().toISOString();
            const updateData = {
                visitCount: (bookmark.visitCount || 0) + 1,
                lastVisited: now,
                updatedAt: now
            };
            await db.bookmarks.update(bookmarkId, updateData);
            
            // Broadcast change for other tabs
            if (typeof broadcastDataChange === 'function') {
                broadcastDataChange('trackBookmarkVisit');
            }
        }
    } catch (error) {
        console.error('Failed to track bookmark visit:', error);
    }
}

async function toggleBookmarkPin(bookmarkId) {
    if (!bookmarkId) return;
    try {
        const bookmark = await db.bookmarks.get(bookmarkId);
        if (bookmark) {
            const now = new Date().toISOString();
            const updateData = {
                isPinned: !bookmark.isPinned,
                updatedAt: now
            };
            await db.bookmarks.update(bookmarkId, updateData);
            
            // Re-render boards to reflect pin changes
            await loadBoardsFromDatabase();
            
            // Broadcast change for other tabs
            if (typeof broadcastDataChange === 'function') {
                broadcastDataChange('toggleBookmarkPin');
            }
        }
    } catch (error) {
        console.error('Failed to toggle bookmark pin:', error);
    }
}

// Global click listener for bookmark tracking
document.addEventListener('click', (e) => {
    const bookmarkLink = e.target.closest('li[data-bookmark-id] a');
    if (bookmarkLink) {
        const listItem = bookmarkLink.closest('li[data-bookmark-id]');
        const bookmarkId = listItem?.dataset.bookmarkId;
        if (bookmarkId) {
            trackBookmarkVisit(bookmarkId);
        }
    }
}, true); // Use capture phase to ensure we catch it before other handlers might stop propagation

setWorkspaceOwnerUserId(null);
setActiveStoredUserId(null);

function snapshotSupabaseAuthSession(session) {
    if (!session?.user) return null;

    return {
        user: {
            id: session.user.id,
            email: session.user.email || null
        }
    };
}

function queueSupabaseAuthStateChange(listenerState, event, session) {
    const queuedSession = snapshotSupabaseAuthSession(session);

    // Supabase recommends keeping this callback synchronous; defer our real work
    // into a serialized queue so auth events stay ordered without re-entering auth.
    window.setTimeout(() => {
        listenerState.queue = listenerState.queue.then(
            () => processSupabaseAuthStateChange(listenerState, event, queuedSession),
            () => processSupabaseAuthStateChange(listenerState, event, queuedSession)
        ).catch((error) => {
            console.error(`Error processing deferred auth event ${event}:`, error);
        });
    }, 0);
}

async function processSupabaseAuthStateChange(listenerState, event, session) {
    if (event === 'SIGNED_OUT') {
        try {
            // Skip if this tab is handling logout (handleLogout manages UI itself)
            if (isCurrentTabAuthenticating) {

                return;
            }
            // Double-check: only clear if we actually had a stored user
            const storedUser = await SyncManager.getStoredUser();
            if (!storedUser) {

                return;
            }


            // FIX: Clear IndexedDB to prevent old data flash on next login
            // This is a defensive measure - storage listener also clears, but may race
            await Promise.all([
                db.pages.clear(),
                db.boards.clear(),
                db.bookmarks.clear(),
                db.syncQueue.clear(),
                db.favicons.clear(),
                clearUndoRedoHistory()
            ]);

            setWorkspaceOwnerUserId(null);
            setActiveStoredUserId(null);
            writeThemeBootstrapAuthHint(false);
            await resetWallpaperStateForAccountBoundary({ clearPersistedState: true });
            await SyncManager.clearStoredUser();
            updateAuthUI();
        } catch (error) {
            console.error('Error handling SIGNED_OUT event:', error);
        }
    } else if (event === 'TOKEN_REFRESHED' && !session) {
        // TOKEN_REFRESHED with no session = auto-refresh failed (invalid refresh token)
        console.error('🔐 Token refresh failed - refresh token invalid, invalidating session');
        try {
            const recovered = await SyncManager.recoverSupabaseSessionAfterRefreshFailure();
            if (recovered) {
                console.warn('Recovered extension session from newer stored Supabase session after refresh failure');
                return;
            }
            await handleSessionInvalidation('Session expired. Please login again.');
        } catch (error) {
            console.error('Error handling TOKEN_REFRESHED failure:', error);
            // Force reload to show login screen
            window.location.reload();
        }
    } else if (event === 'SIGNED_IN' && session?.user) {
        try {
            // Skip if storage listener is handling cross-tab login
            // This prevents the two handlers from racing and showing stale data
            if (_crossTabLoginInProgress) {

                return;
            }

            // Check if this is a DIFFERENT user (account switch from another tab)
            const oldUser = await SyncManager.getStoredUser();
            const newUserId = session.user.id;
            const isAccountSwitch = oldUser && oldUser.id && oldUser.id !== newUserId;

            if (isAccountSwitch) {

                // Clear old account's local data before loading new account
                await db.pages.clear();
                await db.boards.clear();
                await db.bookmarks.clear();
                await db.syncQueue.clear();
                await clearUndoRedoHistory();
                setWorkspaceOwnerUserId(newUserId);
                await resetWallpaperStateForAccountBoundary({ clearPersistedState: true });
            }

            // Store new user info
            await SyncManager.setStoredUser({
                id: session.user.id,
                email: session.user.email
            });
            setActiveStoredUserId(session.user.id);
            writeThemeBootstrapAuthHint(true);
            setWallpaperAccountScopeUserId(session.user.id);
            await loadWallpaperCloudSyncStateFromStorage(session.user.id);

            // Skip sync if we already synced during init or auth redirect
            // BUT always sync if account switched (need to load new account's data)
            if ((!listenerState.wasAuthRedirect && !listenerState.hasCompletedInitialSync) || isAccountSwitch) {

                // FIX: Wrap sync operations in timeout to prevent hanging
                try {
                    const syncTimeout = window.AUTH_TIMEOUTS?.CROSS_TAB_SYNC || 15000;
                    const syncPromise = (async () => {
                        // CROSS-BROWSER SYNC FIX: Always refresh UI after sync
                        await SyncManager.autoSyncOnLoad();
                        await applyWallpaperCloudSyncState(
                            (await chrome.storage.local.get(WALLPAPER_CLOUD_SYNC_STATE_STORAGE_KEY))[WALLPAPER_CLOUD_SYNC_STATE_STORAGE_KEY],
                            { source: 'signed-in-auto-sync' }
                        );
                        await ensureWallpaperPreferencesInitialized();
                        await applyWebsiteWallpaperHandoffFromUrl();
                        await loadPagesNavigation();
                        await ensureFirstTabSelected();  // Ensure a page tab is selected
                        await loadBoardsFromDatabase();
                        // Refresh subscription UI with fresh data
                        checkSubscription();
                    })();
                    const timeout = new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('SIGNED_IN sync timeout')), syncTimeout)
                    );
                    await Promise.race([syncPromise, timeout]);
                } catch (syncError) {
                    console.error('SIGNED_IN sync failed or timed out:', syncError.message);
                    reportReviewPromptIssue('sync').catch((issueError) => {
                        console.warn('[ReviewPrompt] Failed to track SIGNED_IN sync issue:', issueError);
                    });
                    // Reload page to get fresh state
                    window.location.reload();
                    return;
                }
            } else {

            }

            setWorkspaceOwnerUserId(newUserId);
            clearLateAuthReconcileSuppression();
            // Update auth UI AFTER data is loaded to prevent flash of empty/stale content
            updateAuthUI();
        } catch (error) {
            console.error('Error handling SIGNED_IN event:', error);
        }
    } else if (event === 'USER_UPDATED' && session?.user) {
        try {
            // User data updated (e.g., email change)
            await SyncManager.setStoredUser({
                id: session.user.id,
                email: session.user.email
            });
            setActiveStoredUserId(session.user.id);
            writeThemeBootstrapAuthHint(true);
        } catch (error) {
            console.error('Error handling USER_UPDATED event:', error);
        }
    }
}

if (!featureFactories.uiModes || !featureFactories.quickSaveSettings || !featureFactories.shortcutBoardSettings || !featureFactories.search || !featureFactories.wallpaper) {
    throw new Error('LumiList feature modules failed to load before newtab.js');
}

const uiModesFeature = featureFactories.uiModes({
    getPrivacyModeEnabled: () => privacyModeEnabled,
    setPrivacyModeEnabled: (value) => {
        privacyModeEnabled = value === true;
    },
    getIncognitoModeEnabled: () => incognitoModeEnabled,
    setIncognitoModeEnabled: (value) => {
        incognitoModeEnabled = value === true;
    },
    getCompactModeEnabled: () => compactModeEnabled,
    setCompactModeEnabled: (value) => {
        compactModeEnabled = value === true;
    },
    getIsSelectionMode: () => isSelectionMode === true,
    canMutateAccountScopedPreferences
});

const {
    applyPrivacyBlurToBoards,
    syncPrivacyModeFromStorage,
    savePrivacyModeToStorage,
    updatePrivacyButtonState,
    togglePrivacyMode,
    saveIncognitoModeToStorage,
    loadIncognitoModeFromStorage,
    updateIncognitoButtonState,
    toggleIncognitoMode,
    handleIncognitoLinkClick,
    openMultipleUrls,
    initIncognitoLinkHandler,
    saveCompactModeToStorage,
    loadCompactModeFromStorage,
    applyCompactMode,
    updateCompactModeToggle,
    toggleCompactMode
} = uiModesFeature;

const quickSaveSettingsFeature = featureFactories.quickSaveSettings({
    db,
    quickSaveCommandName: QUICK_SAVE_COMMAND_NAME,
    shortcutsSettingsUrl: SHORTCUTS_SETTINGS_URL,
    extensionsSettingsUrl: EXTENSIONS_SETTINGS_URL
});

const {
    isMacPlatformForQuickSaveSettings,
    getQuickSaveFallbackShortcutLabel,
    updateSettingsQuickSaveShortcutUi,
    createSettingsTab,
    getQuickSaveCommandDetails,
    loadSettingsQuickSaveShortcut,
    openQuickSaveShortcutSettings,
    loadSettingsQuickSaveDestinationOptions,
    refreshSettingsQuickSaveControls
} = quickSaveSettingsFeature;

const shortcutBoardSettingsFeature = featureFactories.shortcutBoardSettings({
    db,
    canMutateAccountScopedPreferences
});

const {
    loadShortcutBoardSettingsControls,
    saveShortcutDefaultBoardSetting,
    saveShortcutUseLastBoardSetting
} = shortcutBoardSettingsFeature;

let _lastLoginSyncSignal = { userId: null, timestamp: 0 };
let _pendingCrossTabLoginUserId = null;
let _crossTabLoginTimeoutId = null;
let _onboardingRetryTimeoutId = null;
let _onboardingOpenTimeoutId = null;

const QUICK_TOUR_STORAGE_KEY_PREFIX = 'lumilist_quick_tour_v1_';
const QUICK_TOUR_VERSION = 1;
const QUICK_TOUR_TARGET_RETRY_LIMIT = 12;
const QUICK_TOUR_TARGET_RETRY_DELAY_MS = 150;
const QUICK_TOUR_EDGE_PADDING = 8;
const QUICK_TOUR_ANCHOR_GAP = 12;
const QUICK_TOUR_STEPS = Object.freeze([
    {
        id: 'create_board',
        title: 'Step 1 of 3: Create your first board',
        body: 'Click Add Board, type a name, then press Enter.'
    },
    {
        id: 'add_link',
        title: 'Step 2 of 3: Add your first link',
        body: 'Click the + link button on your board, paste a URL, then press Add.'
    },
    {
        id: 'open_wallpaper',
        title: 'Step 3 of 3: Explore wallpapers',
        body: 'Open Style here to change your wallpaper and the look of your workspace.'
    }
]);

const quickTourEventListeners = new Set();
let quickTourPopoverEl = null;
let quickTourCurrentTargetEl = null;
let quickTourForcedBoardEl = null;
let quickTourEventUnsubscribe = null;
let quickTourRepositionHandler = null;
let quickTourEscapeHandler = null;
let quickTourPointerMoveHandler = null;
let quickTourMutationObserver = null;
let quickTourAnchorRefreshRafId = null;
let quickTourRetryTimeoutId = null;
let quickTourState = {
    active: false,
    stepIndex: 0,
    retryCount: 0,
    source: null,
    userId: null,
    context: {
        boardId: null
    }
};

// Unique ID for this tab instance (used to coordinate onboarding ownership across tabs)
const TAB_INSTANCE_ID = (() => {
    try {
        const existing = sessionStorage.getItem('lumilist_tab_instance_id');
        if (existing) return existing;
        const id = (crypto?.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        sessionStorage.setItem('lumilist_tab_instance_id', id);
        return id;
    } catch (e) {
        // Fallback if sessionStorage is unavailable
        return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
})();

// ==================== BOOKMARK LIMIT FEATURE ====================
// Prevents database abuse while maintaining instant UI responsiveness
// Limit: 100,000 client-side, 102,000 server-side (soft buffer for race conditions)
// Count includes: Active bookmarks + trashed bookmarks (prevents trash workaround)

let bookmarkCount = 0;  // Local cache for instant limit checks on single adds
const BOOKMARK_LIMIT = 100000;
const BOOKMARK_WARNING_THRESHOLD = 90000;  // Show soft warning
const BOOKMARK_CRITICAL_THRESHOLD = 95000;  // Show critical warning
const REVIEW_PROMPT_MODAL_ID = 'reviewPromptModal';
const REVIEW_PROMPT_CWS_REVIEW_URL = 'https://chromewebstore.google.com/detail/lumilist/pcekakljniocipfpmjmpmgaleigcbhlh/reviews';
const REVIEW_PROMPT_TRIAL_WARNING_DAYS_THRESHOLD = 3;
const REVIEW_PROMPT_ISSUE_REPORT_COOLDOWN_MS = 5 * 60 * 1000;

let reviewPromptCheckInFlight = false;
let activeReviewPromptUserId = null;
let activeDeleteAccountModalUserId = null;
let activeChromeImportUserId = null;
let pendingWelcomeNotice = null;
let pendingWelcomeNoticeTimeoutId = null;
const reviewPromptIssueCooldownByType = new Map();

/**
 * Initialize bookmark count from IndexedDB
 * Called on page load after database initialization
 */
async function initBookmarkCount() {
    try {
        bookmarkCount = await db.bookmarks.count();

    } catch (error) {
        console.error('[Bookmark Limit] Failed to initialize bookmark count:', error);
        bookmarkCount = 0;
    }
}

/**
 * Recalculate bookmark count from IndexedDB
 * Called after sync, cross-tab changes, etc.
 * Note: This now calls recalculateAllCounts() which updates page/board/bookmark counts
 */
async function recalculateBookmarkCount() {
    await recalculateAllCounts();
}

/**
 * Check if can add N bookmarks using local cache (instant check for single adds)
 * @param {number} countToAdd - Number of bookmarks to add (default 1)
 * @returns {{ allowed: boolean, remaining: number, warning: string|null }}
 */
function checkBookmarkLimit(countToAdd = 1) {
    const remaining = BOOKMARK_LIMIT - bookmarkCount;
    const newTotal = bookmarkCount + countToAdd;

    if (newTotal > BOOKMARK_LIMIT) {
        return {
            allowed: false,
            remaining: Math.max(0, remaining),
            warning: `Bookmark limit reached (${bookmarkCount.toLocaleString()}/${BOOKMARK_LIMIT.toLocaleString()}). Delete some bookmarks to add more.`
        };
    }

    let warning = null;
    if (bookmarkCount >= BOOKMARK_CRITICAL_THRESHOLD) {
        warning = `You're close to the bookmark limit (${remaining.toLocaleString()} remaining)`;
    } else if (bookmarkCount >= BOOKMARK_WARNING_THRESHOLD) {
        warning = `You have ${remaining.toLocaleString()} bookmark slots remaining`;
    }

    return { allowed: true, remaining, warning };
}

/**
 * Check bookmark limit using fresh server count (for bulk imports)
 * Fetches actual count from server to handle cross-device sync scenarios
 * @param {number} countToAdd - Number of bookmarks to add
 * @returns {Promise<{ allowed: boolean, remaining: number, serverCount: number|null, warning: string|null }>}
 */
async function checkBookmarkLimitForBulkImport(countToAdd) {
    // First get fresh server count for accuracy
    let serverCount = null;
    if (typeof SyncManager !== 'undefined') {
        serverCount = await SyncManager.getServerBookmarkCount();
    }

    // Use server count if available, otherwise fall back to local count
    const actualCount = serverCount !== null ? serverCount : bookmarkCount;
    const remaining = BOOKMARK_LIMIT - actualCount;
    const newTotal = actualCount + countToAdd;

    if (newTotal > BOOKMARK_LIMIT) {
        return {
            allowed: false,
            remaining: Math.max(0, remaining),
            serverCount,
            warning: `Cannot import ${countToAdd.toLocaleString()} bookmarks. You have ${actualCount.toLocaleString()} bookmarks and the limit is ${BOOKMARK_LIMIT.toLocaleString()}. You can import up to ${Math.max(0, remaining).toLocaleString()} more.`
        };
    }

    let warning = null;
    if (actualCount >= BOOKMARK_CRITICAL_THRESHOLD) {
        warning = `After this import, you'll have ${newTotal.toLocaleString()}/${BOOKMARK_LIMIT.toLocaleString()} bookmarks`;
    }

    return { allowed: true, remaining, serverCount, warning };
}

// ==================== PAGE LIMIT FEATURE ====================
// Prevents database abuse while maintaining instant UI responsiveness
// Limit: 10,000 client-side, 11,000 server-side (soft buffer for race conditions)
// Count includes: Active pages + trashed pages (prevents trash workaround)

let pageCount = 0;  // Local cache for instant limit checks
const PAGE_LIMIT = 10000;
const PAGE_WARNING_THRESHOLD = 8000;  // Show soft warning
const PAGE_CRITICAL_THRESHOLD = 9500;  // Show critical warning

/**
 * Initialize page count from IndexedDB
 * Called on page load after database initialization
 */
async function initPageCount() {
    try {
        pageCount = await db.pages.count();

    } catch (error) {
        console.error('[Page Limit] Failed to initialize page count:', error);
        pageCount = 0;
    }
}

/**
 * Check if can add N pages using local cache (instant check)
 * @param {number} countToAdd - Number of pages to add (default 1)
 * @returns {{ allowed: boolean, remaining: number, warning: string|null }}
 */
function checkPageLimit(countToAdd = 1) {
    const remaining = PAGE_LIMIT - pageCount;
    const newTotal = pageCount + countToAdd;

    if (newTotal > PAGE_LIMIT) {
        return {
            allowed: false,
            remaining: Math.max(0, remaining),
            warning: `Page limit reached (${pageCount}/${PAGE_LIMIT}). Delete some pages to add more.`
        };
    }

    let warning = null;
    if (pageCount >= PAGE_CRITICAL_THRESHOLD) {
        warning = `You're close to the page limit (${remaining} remaining)`;
    } else if (pageCount >= PAGE_WARNING_THRESHOLD) {
        warning = `You have ${remaining} page slots remaining`;
    }

    return { allowed: true, remaining, warning };
}

// ==================== BOARD LIMIT FEATURE ====================
// Prevents database abuse while maintaining instant UI responsiveness
// Limit: 50,000 client-side, 55,000 server-side (soft buffer for race conditions)
// Count includes: Active boards + trashed boards (prevents trash workaround)

let boardCount = 0;  // Local cache for instant limit checks
const BOARD_LIMIT = 50000;
const BOARD_WARNING_THRESHOLD = 40000;  // Show soft warning
const BOARD_CRITICAL_THRESHOLD = 45000;  // Show critical warning

/**
 * Initialize board count from IndexedDB
 * Called on page load after database initialization
 */
async function initBoardCount() {
    try {
        boardCount = await db.boards.count();

    } catch (error) {
        console.error('[Board Limit] Failed to initialize board count:', error);
        boardCount = 0;
    }
}

/**
 * Check if can add N boards using local cache (instant check)
 * @param {number} countToAdd - Number of boards to add (default 1)
 * @returns {{ allowed: boolean, remaining: number, warning: string|null }}
 */
function checkBoardLimit(countToAdd = 1) {
    const remaining = BOARD_LIMIT - boardCount;
    const newTotal = boardCount + countToAdd;

    if (newTotal > BOARD_LIMIT) {
        return {
            allowed: false,
            remaining: Math.max(0, remaining),
            warning: `Board limit reached (${boardCount.toLocaleString()}/${BOARD_LIMIT.toLocaleString()}). Delete some boards to add more.`
        };
    }

    let warning = null;
    if (boardCount >= BOARD_CRITICAL_THRESHOLD) {
        warning = `You're close to the board limit (${remaining} remaining)`;
    } else if (boardCount >= BOARD_WARNING_THRESHOLD) {
        warning = `You have ${remaining} board slots remaining`;
    }

    return { allowed: true, remaining, warning };
}

/**
 * Recalculate all entity counts from IndexedDB
 * Called after sync, cross-tab changes, etc.
 */
async function recalculateAllCounts() {
    try {
        pageCount = await db.pages.count();
        boardCount = await db.boards.count();
        bookmarkCount = await db.bookmarks.count();

    } catch (error) {
        console.error('[Limits] Failed to recalculate counts:', error);
    }
}

/**
 * Get Supabase access token for API authentication
 * Uses the Supabase session token which is verified by Edge Functions
 * SECURITY FIX: Replaced hardcoded HMAC secret with Supabase session tokens
 * @returns {Promise<string|null>} Access token or null if not logged in
 */
async function getSupabaseAccessToken() {
    try {
        const supabase = SyncManager.getSupabase();
        if (!supabase) {
            console.error('getSupabaseAccessToken: Supabase client not available');
            return null;
        }

        const { data: { session }, error } = await supabase.auth.getSession();
        if (error) {
            console.error('getSupabaseAccessToken: Error getting session:', error);
            return null;
        }

        if (!session?.access_token) {
            console.error('getSupabaseAccessToken: No access token in session');
            return null;
        }

        return session.access_token;
    } catch (e) {
        console.error('getSupabaseAccessToken: Exception:', e);
        return null;
    }
}

/**
 * Clear all board columns
 */
function clearAllColumns() {
    document.querySelectorAll('.column').forEach(column => {
        column.innerHTML = '';
    });
}

async function hasAnyLocalWorkspaceData() {
    try {
        const [pageCount, boardCount, bookmarkCount] = await Promise.all([
            db.pages.count(),
            db.boards.count(),
            db.bookmarks.count()
        ]);
        return (pageCount + boardCount + bookmarkCount) > 0;
    } catch (error) {
        console.error('Failed to inspect local workspace data:', error);
        return false;
    }
}

function hideLoadingOverlay() {
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) {
        overlay.classList.add('hidden');
        // Remove from DOM after transition
        setTimeout(() => {
            if (overlay.classList.contains('hidden')) {
                overlay.style.display = 'none';
            }
        }, 300);
    }
    isInitialLoadComplete = true;
}

async function showWorkspaceLoadFailure(message, options = {}) {
    const suppressReconcileMs = Number.isFinite(options.suppressReconcileMs)
        ? Math.max(options.suppressReconcileMs, 0)
        : 30000;

    resetCrossTabLoginWaitState();
    suppressLateAuthReconcile(suppressReconcileMs);
    setWorkspaceOwnerUserId(null);
    currentPageId = null;

    try {
        if (typeof chrome !== 'undefined' && chrome.storage?.local?.remove) {
            await chrome.storage.local.remove(['currentPageId']);
        }
    } catch (error) {
        console.warn('Failed to clear currentPageId while showing workspace load failure:', error);
    }

    clearAllColumns();
    hideLoadingOverlay();
    resetAccountBoundaryTransientUi({ quickTourReason: 'workspace_load_failure' });
    showWelcomeScreen();
    showAuthError(message);
}

function resetAccountBoundaryTransientUi(options = {}) {
    const quickTourReason = (typeof options.quickTourReason === 'string' && options.quickTourReason.trim())
        ? options.quickTourReason.trim()
        : 'account_boundary';

    if (_onboardingRetryTimeoutId) {
        clearTimeout(_onboardingRetryTimeoutId);
        _onboardingRetryTimeoutId = null;
    }
    if (_onboardingOpenTimeoutId) {
        clearTimeout(_onboardingOpenTimeoutId);
        _onboardingOpenTimeoutId = null;
    }
    closeSettingsModal();
    closeWallpaperPopup();
    closeChromeImportModal();
    closeDeleteAccountModal();
    closeOnboardingModal();
    stopQuickTour(quickTourReason);
    void closeReviewPromptModal().catch((error) => {
        console.warn('[ReviewPrompt] Failed to close modal during account-boundary cleanup:', error);
    });
}

function beginWorkspaceStartupShell() {
    const body = document.body;
    if (!body || body.classList.contains('not-authenticated') || body.classList.contains('workspace-startup-pending')) {
        return;
    }

    body.classList.add('workspace-startup-pending');
    body.classList.remove('workspace-startup-indicator-visible');

    if (workspaceStartupIndicatorTimeoutId) {
        clearTimeout(workspaceStartupIndicatorTimeoutId);
    }

    workspaceStartupIndicatorTimeoutId = window.setTimeout(() => {
        workspaceStartupIndicatorTimeoutId = null;
        if (!document.body?.classList?.contains('workspace-startup-pending')) {
            return;
        }
        if (document.body.classList.contains('not-authenticated')) {
            return;
        }
        document.body.classList.add('workspace-startup-indicator-visible');
    }, WORKSPACE_STARTUP_INDICATOR_DELAY_MS);
}

function finishWorkspaceStartupShell() {
    if (workspaceStartupIndicatorTimeoutId) {
        clearTimeout(workspaceStartupIndicatorTimeoutId);
        workspaceStartupIndicatorTimeoutId = null;
    }

    const body = document.body;
    if (!body) return;
    body.classList.remove('workspace-startup-indicator-visible');
    body.classList.remove('workspace-startup-pending');

    // Page-tab overflow is measured while the shell is hidden during startup,
    // so re-evaluate it after the nav becomes visible.
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            if (typeof updateTabNavigation === 'function') {
                updateTabNavigation();
            }
        });
    });
}

function queueLoggedOutThemeReset() {
    if (!pendingLoggedOutThemeResetPromise) {
        pendingLoggedOutThemeResetPromise = clearPersistedThemeWallpaperState()
            .catch((error) => {
                console.error('Failed to clear theme state while showing welcome screen:', error);
            })
            .finally(() => {
                pendingLoggedOutThemeResetPromise = null;
            });
    }

    return pendingLoggedOutThemeResetPromise;
}

// Listen for storage changes (sync across tabs)
if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
        try {
            const canApplyAccountScopedStorageState = areaName === 'local'
                && shouldApplyAccountScopedStorageUpdate(changes.lumilist_user);

            if (areaName === 'local' && changes.privacyModeEnabled && canApplyAccountScopedStorageState) {
                const newValue = changes.privacyModeEnabled.newValue === true;
                if (newValue !== privacyModeEnabled) {
                    privacyModeEnabled = newValue;
                    updatePrivacyButtonState();
                    // Update all existing boards
                    document.querySelectorAll('.board').forEach(board => {
                        if (privacyModeEnabled) {
                            board.classList.add('privacy-blur');
                        } else {
                            board.classList.remove('privacy-blur');
                        }
                    });

                }
            }

            // Sync incognito mode across tabs
            if (areaName === 'local' && changes.incognitoModeEnabled && canApplyAccountScopedStorageState) {
                const newValue = changes.incognitoModeEnabled.newValue === true;
                if (newValue !== incognitoModeEnabled) {
                    incognitoModeEnabled = newValue;
                    updateIncognitoButtonState();

                }
            }

            // Sync compact mode across tabs
            if (areaName === 'local' && changes.compactModeEnabled && canApplyAccountScopedStorageState) {
                const newValue = changes.compactModeEnabled.newValue === true;
                if (newValue !== compactModeEnabled) {
                    compactModeEnabled = newValue;
                    applyCompactMode();
                    updateCompactModeToggle();

                }
            }

            if (areaName === 'local' && changes[FLOATING_CONTROLS_COLLAPSED_STORAGE_KEY]) {
                const newValue = changes[FLOATING_CONTROLS_COLLAPSED_STORAGE_KEY].newValue === true;
                if (newValue !== floatingControlsCollapsedEnabled) {
                    floatingControlsCollapsedEnabled = newValue;
                    applyFloatingControlsCollapsedState();
                    updateFloatingControlsCollapsedToggle();
                }
            }

            // Sync large board collapse setting across tabs
            if (areaName === 'local' && changes.largeBoardCollapseEnabled && canApplyAccountScopedStorageState) {
                const newValue = changes.largeBoardCollapseEnabled.newValue === true;
                if (newValue !== largeBoardCollapseEnabled) {
                    largeBoardCollapseEnabled = newValue;
                    updateLargeBoardCollapseToggle();
                    loadBoardsFromDatabase().catch((error) => {
                        console.error('Failed to refresh boards after large board collapse setting changed:', error);
                    });
                }
            }

            // Sync large board visible limit across tabs
            if (areaName === 'local' && changes[LARGE_BOARD_VISIBLE_LIMIT_STORAGE_KEY] && canApplyAccountScopedStorageState) {
                const nextLimit = normalizeLargeBoardVisibleLimit(
                    changes[LARGE_BOARD_VISIBLE_LIMIT_STORAGE_KEY].newValue
                );
                if (nextLimit !== largeBoardVisibleBookmarkLimit) {
                    largeBoardVisibleBookmarkLimit = nextLimit;
                    updateLargeBoardVisibleLimitControl();
                    if (largeBoardCollapseEnabled) {
                        loadBoardsFromDatabase().catch((error) => {
                            console.error('Failed to refresh boards after large board visible limit changed:', error);
                        });
                    }
                }
            }

            // Sync expanded/collapsed board state across tabs
            if (areaName === 'local' && changes[LARGE_BOARD_EXPANDED_IDS_STORAGE_KEY] && canApplyAccountScopedStorageState) {
                const incomingIds = normalizeExpandedBoardIdList(
                    changes[LARGE_BOARD_EXPANDED_IDS_STORAGE_KEY].newValue
                );
                if (!hasSameExpandedBoardIds(incomingIds)) {
                    setExpandedBoardIds(incomingIds);
                    if (largeBoardCollapseEnabled) {
                        loadBoardsFromDatabase().catch((error) => {
                            console.error('Failed to refresh boards after expanded board state changed:', error);
                        });
                    }
                }
            }

            // Sync theme mode across tabs
            if (areaName === 'local' && changes.themeMode && canApplyAccountScopedStorageState) {
                const newMode = normalizeThemeMode(changes.themeMode.newValue);
                if (newMode !== themeMode) {
                    applyThemeMode(newMode);
                    try {
                        localStorage.setItem('lumilist_theme_mode', newMode);
                    } catch (e) {
                        // Non-blocking cache update
                    }
                    updateFontColorSettingControl();
                }
            }

            if (areaName === 'local' && changes[FONT_COLOR_STORAGE_KEY] && canApplyAccountScopedStorageState) {
                const nextFontColor = normalizeHexColor(changes[FONT_COLOR_STORAGE_KEY].newValue, null);
                if (nextFontColor !== customFontColor) {
                    customFontColor = nextFontColor;
                    cacheFontColorPreferenceLocally(nextFontColor);
                    if (nextFontColor) {
                        applyFontColorPreference(nextFontColor);
                    } else {
                        applyThemeStyleTokens(getResolvedWallpaperStyleForTheme(themeMode));
                    }
                    updateFontColorSettingControl();
                }
            }

            if (areaName === 'local' && changes.truncateTitles && canApplyAccountScopedStorageState) {
                const truncateEnabled = changes.truncateTitles.newValue !== false;
                applyTruncateTitlesSetting(truncateEnabled);
                const toggle = document.getElementById('truncateTitlesToggle');
                if (toggle) {
                    toggle.checked = truncateEnabled;
                }
            }

            if (areaName === 'local' && changes.openInNewTab && canApplyAccountScopedStorageState) {
                const newValue = changes.openInNewTab.newValue === true;
                if (newValue !== openLinksInNewTab) {
                    openLinksInNewTab = newValue;
                    applyOpenInNewTabSetting(openLinksInNewTab);
                    const toggle = document.getElementById('openInNewTabToggle');
                    if (toggle) {
                        toggle.checked = openLinksInNewTab;
                    }
                }
            }

            if (areaName === 'local' && changes[CLOSE_TABS_AFTER_SAVE_ALL_STORAGE_KEY] && canApplyAccountScopedStorageState) {
                const newValue = changes[CLOSE_TABS_AFTER_SAVE_ALL_STORAGE_KEY].newValue === true;
                if (newValue !== closeTabsAfterSaveAllTabsEnabled) {
                    closeTabsAfterSaveAllTabsEnabled = newValue;
                    const toggle = document.getElementById('closeTabsAfterSaveAllToggle');
                    if (toggle) {
                        toggle.checked = closeTabsAfterSaveAllTabsEnabled;
                    }
                }
            }

            if (areaName === 'local' && changes[WALLPAPER_CLOUD_SYNC_STATE_STORAGE_KEY] && canApplyAccountScopedStorageState) {
                applyWallpaperCloudSyncState(
                    changes[WALLPAPER_CLOUD_SYNC_STATE_STORAGE_KEY].newValue,
                    { source: 'storage-change' }
                ).catch((error) => {
                    console.error('Failed to apply wallpaper cloud sync state from storage change:', error);
                });
            }

            if (areaName === 'local' && changes[INSTALLED_WALLPAPER_CATALOG_VERSION_STORAGE_KEY] && canApplyAccountScopedStorageState) {
                const nextVersion = typeof changes[INSTALLED_WALLPAPER_CATALOG_VERSION_STORAGE_KEY].newValue === 'string'
                    ? changes[INSTALLED_WALLPAPER_CATALOG_VERSION_STORAGE_KEY].newValue
                    : null;
                if (nextVersion && nextVersion !== installedWallpaperCatalogVersion) {
                    installedWallpaperCatalogVersion = nextVersion;
                    loadInstalledWallpaperCatalog().catch((error) => {
                        console.error('Failed to refresh installed wallpaper catalog after storage change:', error);
                    });
                }
            }

            if (areaName === 'local' && changes[WALLPAPER_ACCOUNT_LOCAL_STATE_STORAGE_KEY] && canApplyAccountScopedStorageState) {
                const prefetchedStorage = {
                    [WALLPAPER_ACCOUNT_LOCAL_STATE_STORAGE_KEY]: changes[WALLPAPER_ACCOUNT_LOCAL_STATE_STORAGE_KEY].newValue
                };
                if (changes.themeMode) {
                    prefetchedStorage.themeMode = changes.themeMode.newValue;
                }
                if (changes[WALLPAPER_STORAGE_KEY]) {
                    prefetchedStorage[WALLPAPER_STORAGE_KEY] = changes[WALLPAPER_STORAGE_KEY].newValue;
                }
                refreshAccountScopedWallpaperStateFromStorage(prefetchedStorage).catch((error) => {
                    console.error('Failed to refresh account-scoped wallpaper state after storage change:', error);
                });
            }

            if (areaName === 'local' && changes[WALLPAPER_STORAGE_KEY] && canApplyAccountScopedStorageState) {
                if (!getWallpaperAccountScopeUserId()) {
                    const incomingSelection = changes[WALLPAPER_STORAGE_KEY].newValue;
                    const { selection: reconciledSelection } = reconcileWallpaperSelection(incomingSelection, {
                        preserveHostedSelections: true
                    });
                    if (!areWallpaperSelectionsEqual(wallpaperSelectionByTheme, reconciledSelection)) {
                        wallpaperSelectionByTheme = reconciledSelection;
                        cacheWallpaperSelectionLocally(wallpaperSelectionByTheme);
                        applyActiveThemeWallpaper();
                        renderWallpaperPopup({ preserveScroll: true });
                    }
                }
            }

            // Sync quick save destination dropdown while settings modal is open
            if (areaName === 'local' && changes.quickSavePageId && canApplyAccountScopedStorageState) {
                const settingsModal = document.getElementById('settingsModal');
                if (settingsModal && settingsModal.classList.contains('active')) {
                    refreshSettingsQuickSaveControls().catch((error) => {
                        console.error('Failed to refresh quick save settings after storage change:', error);
                    });
                }
            }

            if (
                areaName === 'local' &&
                canApplyAccountScopedStorageState &&
                (changes.shortcutDefaultBoardId || changes.shortcutUseLastBoard || changes.shortcutLastBoardId)
            ) {
                const settingsModal = document.getElementById('settingsModal');
                if (settingsModal && settingsModal.classList.contains('active')) {
                    loadShortcutBoardSettingsControls().catch((error) => {
                        console.error('Failed to refresh shortcut board settings after storage change:', error);
                    });
                }
            }

            if (areaName === 'local' && changes.privateLinksIncognito && canApplyAccountScopedStorageState) {
                const privateLinksIncognitoToggle = document.getElementById('privateLinksIncognitoToggle');
                if (privateLinksIncognitoToggle) {
                    privateLinksIncognitoToggle.checked = changes.privateLinksIncognito.newValue !== false;
                }
            }

            // Sync bookmark note visibility across tabs
            if (areaName === 'local' && changes[SHOW_BOOKMARK_NOTES_STORAGE_KEY] && canApplyAccountScopedStorageState) {
                const newValue = changes[SHOW_BOOKMARK_NOTES_STORAGE_KEY].newValue !== false;
                if (newValue !== showBookmarkNotes) {
                    showBookmarkNotes = newValue;
                    applyShowBookmarkNotesSetting(showBookmarkNotes);
                    const toggle = document.getElementById('showBookmarkNotesToggle');
                    if (toggle) {
                        toggle.checked = showBookmarkNotes;
                    }
                }
            }

            const authTokenChangeEntry = areaName === 'local'
                ? Object.entries(changes).find(([key]) => key.startsWith('sb-') && key.endsWith('-auth-token'))
                : null;
            if (authTokenChangeEntry && !isCurrentTabAuthenticating) {
                const [, authTokenChange] = authTokenChangeEntry;
                const hasIncomingSession =
                    authTokenChange?.newValue &&
                    authTokenChange.newValue !== authTokenChange.oldValue;

                if (hasIncomingSession) {
                    (async () => {
                        const adopted = await SyncManager.adoptStoredSupabaseSession(
                            authTokenChange.newValue,
                            { allowNoopRecovery: true }
                        );
                        if (adopted && initialAuthCompleted && document.body.classList.contains('not-authenticated')) {
                            await updateAuthUI({ skipOnboarding: true });
                        }
                    })().catch((error) => {
                        console.error('Failed to adopt updated Supabase session from shared storage:', error);
                    });
                }
            }

            // Listen for auth changes from other tabs (logout, login, account switch)
            if (areaName === 'local' && changes.lumilist_user) {
                setActiveStoredUserId(changes.lumilist_user.newValue?.id || null);

                // Skip if this tab initiated the auth change (prevents duplicate processing)
                if (isCurrentTabAuthenticating) {

                    return;
                }

                const oldValue = changes.lumilist_user.oldValue;
                const newValue = changes.lumilist_user.newValue;

                // Case 1: Logout detected (user was logged in, now logged out)
                if (oldValue && !newValue) {

                    // Clear local IndexedDB and show welcome screen
                    // FIX: Include favicons.clear() for privacy (hostnames persist otherwise)
                    Promise.all([
                        db.pages.clear(),
                        db.boards.clear(),
                        db.bookmarks.clear(),
                        db.syncQueue.clear(),
                        db.favicons.clear(),
                        clearUndoRedoHistory()
                    ]).then(async () => {
                        // Clean up onboarding ownership key for the logged-out user
                        if (oldValue?.id && typeof chrome !== 'undefined' && chrome.storage?.local) {
                            const ownerKey = `lumilist_onboarding_owner_${oldValue.id}`;
                            chrome.storage.local.remove(ownerKey);
                        }
                        setWorkspaceOwnerUserId(null);
                        await resetWallpaperStateForAccountBoundary({ clearPersistedState: true });
                        // Reset SyncManager's cached Supabase reference to force re-init
                        if (typeof SyncManager !== 'undefined' && SyncManager._supabase) {
                            SyncManager._supabase = null;
                        }
                        // Clear subscription window variables
                        window.subscriptionStatus = null;
                        window.subscriptionDaysLeft = null;
                        window.subscriptionData = null;
                        updateAuthUI();
                    }).catch(error => {
                        console.error('Error clearing data on cross-tab logout:', error);
                        // Force reload as fallback
                        window.location.reload();
                    });
                }
                // Case 2: Login or account switch detected (new user logged in, or different user)
                else if (newValue && (!oldValue || oldValue.id !== newValue.id)) {
                    // Record pending auth change (used if login happens during init)
                    _pendingAuthChange = { oldValue, newValue, timestamp: Date.now() };

                    // Skip during initialization - handle after init completes
                    if (!initialAuthCompleted) {

                        return;
                    }

                    // DEDUPLICATION: Ignore same change within 1 second (prevents duplicate processing)
                    // Track both userId AND oldUserId to allow rapid same-account re-login
                    const now = Date.now();
                    const currentOldUserId = oldValue?.id || null;
                    if (_lastProcessedAuthChange.userId === newValue.id &&
                        _lastProcessedAuthChange.oldUserId === currentOldUserId &&
                        now - _lastProcessedAuthChange.timestamp < 1000) {

                        return;
                    }
                    _lastProcessedAuthChange = { userId: newValue.id, oldUserId: currentOldUserId, timestamp: now };

                    if (oldValue?.id && oldValue.id !== newValue.id) {
                        setWorkspaceOwnerUserId(newValue.id);
                        void resetWallpaperStateForAccountBoundary({ clearPersistedState: true }).catch((error) => {
                            console.error('Failed to reset wallpaper state during cross-tab account switch:', error);
                        });
                    }
                    beginCrossTabLoginWait(newValue.id);
                }
            }

            if (areaName === 'local' && changes[SESSION_INVALIDATION_STORAGE_KEY]?.newValue) {
                const invalidation = changes[SESSION_INVALIDATION_STORAGE_KEY].newValue;
                handleSessionInvalidation(
                    invalidation?.reason || 'Session expired. Please login again.'
                ).catch((error) => {
                    console.error('Error handling cross-tab session invalidation:', error);
                });
            }

            // Listen for login sync completion (other tabs finished syncOnLogin)
            if (areaName === 'local' && changes.lumilist_login_sync_complete) {
                const signal = changes.lumilist_login_sync_complete.newValue;
                if (!signal?.userId) return;

                // Skip if this tab initiated the auth change
                if (isCurrentTabAuthenticating) {

                    return;
                }

                // If init not complete, defer handling until after init
                if (!initialAuthCompleted) {

                    _pendingLoginSyncSignal = signal;
                    return;
                }

                (async () => {
                    await handleLoginSyncCompleteSignal(signal);
                })();
            }
        } catch (error) {
            console.error('Error in storage change handler:', error);
        }
    });
}

// ==================== SEARCH OVERLAY FUNCTIONS ====================

const SEARCH_BEHAVIOR_STORAGE_KEY = 'lumilist_search_behavior_v1';
const SEARCH_BEHAVIOR_DECAY_WINDOW_DAYS = 21;
const SEARCH_ALIAS_MAP = Object.freeze({
    gsc: ['google', 'search', 'console'],
    gdrive: ['google', 'drive'],
    gdoc: ['google', 'docs'],
    gdocs: ['google', 'docs'],
    gsheet: ['google', 'sheets'],
    gsheets: ['google', 'sheets'],
    gcal: ['google', 'calendar'],
    ga: ['google', 'analytics'],
    gads: ['google', 'ads'],
    yt: ['youtube'],
    gm: ['gmail']
});
const SEARCH_SCOPE_OPTIONS = Object.freeze({
    ALL: 'all',
    BOARD: 'board',
    TITLE: 'title',
    URL: 'url',
    NOTE: 'note',
    TAGS: 'tags'
});
const SEARCH_SCOPE_VALUES = Object.freeze(Object.values(SEARCH_SCOPE_OPTIONS));
const SEARCH_MATCH_MODE_OPTIONS = Object.freeze({
    SMART: 'smart',
    STRICT: 'strict'
});
const SEARCH_MATCH_MODE_VALUES = Object.freeze(Object.values(SEARCH_MATCH_MODE_OPTIONS));
const SEARCH_DEFAULT_OPTIONS = Object.freeze({
    scope: SEARCH_SCOPE_OPTIONS.ALL,
    matchMode: SEARCH_MATCH_MODE_OPTIONS.SMART
});

const searchFeature = featureFactories.search({
    searchState,
    searchBehaviorStorageKey: SEARCH_BEHAVIOR_STORAGE_KEY,
    searchBehaviorDecayWindowDays: SEARCH_BEHAVIOR_DECAY_WINDOW_DAYS,
    searchAliasMap: SEARCH_ALIAS_MAP,
    searchScopeOptions: SEARCH_SCOPE_OPTIONS,
    searchScopeValues: SEARCH_SCOPE_VALUES,
    searchMatchModeOptions: SEARCH_MATCH_MODE_OPTIONS,
    searchMatchModeValues: SEARCH_MATCH_MODE_VALUES,
    searchDefaultOptions: SEARCH_DEFAULT_OPTIONS,
    db,
    safeParseInt,
    escapeHTML,
    sanitizeUrl,
    sanitizeBookmarkNote,
    initializeNewFavicons,
    closeImportPopup,
    closeTabContextMenu,
    closeBoardMenus,
    switchToPage,
    loadBoardsFromDatabase,
    getCurrentPageId: () => currentPageId,
    getIncognitoModeEnabled: () => incognitoModeEnabled,
    getOpenLinksInNewTab: () => openLinksInNewTab,
    trackBookmarkVisit
});

const {
    closeSearchOverlay,
    refreshSearchIfOpen,
    initSearchFeature,
    isSearchOverlayOpen,
    openSearchOverlay,
    toggleSearchOverlay,
    rebuildSearchDataset,
    performSearch,
    renderSearchResults
} = searchFeature;

const wallpaperFeature = featureFactories.wallpaper({
    getThemeMode: () => themeMode,
    setThemeMode: (value) => {
        themeMode = value;
    },
    canMutateAccountScopedPreferences,
    getWallpaperAccountScopeUserId,
    getWallpaperCatalogByTheme: () => wallpaperCatalogByTheme,
    setWallpaperCatalogByTheme: (value) => {
        wallpaperCatalogByTheme = value;
    },
    setBundledWallpaperCatalogState,
    getWallpaperSelectionByTheme,
    setWallpaperSelectionByTheme: (value) => {
        wallpaperSelectionByTheme = value;
    },
    getCurrentPageId: () => currentPageId,
    getPageWallpaperSelections: () => pageWallpaperSelections,
    setPageWallpaperSelections: (value) => {
        pageWallpaperSelections = value || {};
    },
    pageWallpaperStorageKey: PAGE_WALLPAPERS_STORAGE_KEY,
    savePageWallpaperSelectionToStorage: (pageId, selection) => {
        if (wallpaperFeature && typeof wallpaperFeature.savePageWallpaperSelectionToStorage === 'function') {
            return wallpaperFeature.savePageWallpaperSelectionToStorage(pageId, selection);
        }
    },
    getWallpaperThemeDefaults: () => wallpaperThemeDefaults,
    setWallpaperThemeDefaults: (value) => {
        wallpaperThemeDefaults = value;
    },
    normalizeWallpaperStyleConfig,
    getWallpaperStyleOverridesByTheme: () => wallpaperStyleOverridesByTheme,
    setWallpaperStyleOverridesByTheme: (value) => {
        wallpaperStyleOverridesByTheme = normalizeWallpaperUserStyleOverrideState(value);
    },
    getHostedWallpaperCatalogPromise: () => hostedWallpaperCatalogPromise,
    setHostedWallpaperCatalogPromise: (value) => {
        hostedWallpaperCatalogPromise = value;
    },
    getHostedWallpaperGalleryPromise: () => hostedWallpaperGalleryPromise,
    setHostedWallpaperGalleryPromise: (value) => {
        hostedWallpaperGalleryPromise = value;
    },
    getWallpaperPreferencesInitialized: () => wallpaperPreferencesInitialized,
    setWallpaperPreferencesInitialized: (value) => {
        wallpaperPreferencesInitialized = value === true;
    },
    wallpaperStorageKey: WALLPAPER_STORAGE_KEY,
    wallpaperLocalCacheKey: WALLPAPER_LOCAL_CACHE_KEY,
    wallpaperStyleLocalCacheKey: WALLPAPER_STYLE_LOCAL_CACHE_KEY,
    wallpaperBinaryCacheLocalKey: WALLPAPER_BINARY_CACHE_LOCAL_KEY,
    wallpaperBootStyleCachePrefix: WALLPAPER_BOOT_STYLE_CACHE_PREFIX,
    wallpaperBootBinaryCachePrefix: WALLPAPER_BOOT_BINARY_CACHE_PREFIX,
    wallpaperBootSourceCachePrefix: WALLPAPER_BOOT_SOURCE_CACHE_PREFIX,
    wallpaperAccountLocalStateStorageKey: WALLPAPER_ACCOUNT_LOCAL_STATE_STORAGE_KEY,
    wallpaperCloudSyncStateStorageKey: WALLPAPER_CLOUD_SYNC_STATE_STORAGE_KEY,
    wallpaperPendingHandoffStorageKey: WALLPAPER_PENDING_HANDOFF_STORAGE_KEY,
    wallpaperNewUserDefaultSeedStorageKey: WALLPAPER_NEW_USER_DEFAULT_SEED_STORAGE_KEY,
    wallpaperCatalogPath: WALLPAPER_CATALOG_PATH,
    wallpaperRemoteCatalogUrl: WALLPAPER_REMOTE_CATALOG_URL,
    wallpaperRemoteGalleryUrl: WALLPAPER_REMOTE_GALLERY_URL,
    wallpaperRemoteStoragePrefix: WALLPAPER_REMOTE_STORAGE_PREFIX,
    wallpaperGalleryUrl: WALLPAPER_GALLERY_URL,
    wallpaperFilePattern: WALLPAPER_FILE_PATTERN,
    wallpaperUrlParam: WALLPAPER_URL_PARAM,
    wallpaperGalleryIdUrlParam: WALLPAPER_GALLERY_ID_URL_PARAM,
    wallpaperThemeUrlParam: WALLPAPER_THEME_URL_PARAM,
    defaultWallpaperTileId: DEFAULT_WALLPAPER_TILE_ID,
    defaultWallpaperThemeStyles: DEFAULT_WALLPAPER_THEME_STYLES,
    normalizeThemeMode,
    createEmptyWallpaperStyleOverrideState,
    createEmptyWallpaperCatalog,
    createEmptyWallpaperThemeDefaults,
    normalizeWallpaperCatalog,
    normalizeWallpaperUserStyleOverride,
    normalizeWallpaperUserStyleOverrideState,
    getWallpaperCatalogEntriesForTheme,
    mergeWallpaperCatalogs,
    getCurrentWallpaperCatalogState,
    getWallpaperNewUserDefaultConfig: () => wallpaperNewUserDefaultConfig,
    isHostedWallpaperUrl,
    isInstalledWallpaperRef,
    hasCachedHostedWallpaperBinary,
    getCachedWallpaperBinaryDataUrl,
    getInstalledWallpaperRecordByRef,
    findInstalledWallpaperRefBySourceUrl,
    findInstalledWallpaperRefByRemoteIdentity,
    resolveWallpaperRenderSource,
    findWallpaperCatalogEntry,
    findEquivalentWallpaperCatalogEntry,
    areWallpaperSelectionsEqual,
    reconcileWallpaperSelection,
    cacheWallpaperSelectionLocally,
    readCachedWallpaperSelection,
    hasConfiguredWallpaperUserStyleOverride,
    getResolvedWallpaperStyleForTheme,
    cacheWallpaperStyleLocally,
    ensureHostedWallpaperBinaryCache,
    ensureInstalledWallpaperBinaryCache,
    loadInstalledWallpaperCatalogFromDatabase,
    installWallpaperBlobLocally,
    installRemoteWallpaperLocally,
    isWallpaperRemoteAssetMissingError,
    removeInstalledWallpaperRecordLocally,
    setInstalledWallpaperStyleLocally,
    setInstalledWallpaperArchiveStateLocally,
    normalizeWallpaperPathForTheme,
    formatWallpaperLabelFromFile,
    toHostedWallpaperUrl,
    recordUndoRedoHistoryEntry,
    buildUndoRedoEntityKey,
    pruneUndoRedoHistoryForEntityKeys,
    clearRedoTailAfterNonUndoableMutation,
    setUndoRedoBlockedReason,
    recordWallpaperDiagnosticEvent,
    updateLoadingMessage,
    applyThemeStyleTokens,
    toCssUrlValue,
    buildSyncSafeWallpaperSelection,
    isLocalOnlyInstalledWallpaperRef,
    localUserWallpaperSourceType: LOCAL_USER_WALLPAPER_SOURCE_TYPE,
    showGlassToast
});

const {
    renderWallpaperPopup,
    applyActiveThemeWallpaper,
    applyLoggedOutDefaultThemeUi,
    clearPersistedThemeWallpaperState,
    resetThemeForLoggedOutState,
    setWallpaperSelection,
    handleWallpaperThemeButtonClick,
    handleWallpaperTileClick,
    handleWallpaperTileContextMenu,
    handleWallpaperContextMenuClick,
    handleWallpaperUploadButtonClick,
    handleWallpaperUploadInputChange,
    closeWallpaperContextMenu,
    loadWallpaperCatalog,
    loadHostedWallpaperCatalog,
    loadInstalledWallpaperCatalog,
    loadWallpaperSelectionFromStorage,
    loadWallpaperStyleOverridesFromStorage,
    initializeWallpaperPreferences,
    handleWallpaperPopupOpened,
    applyCloudWallpaperPreferences,
    applyThemeMode,
    saveThemeModeToStorage,
    loadThemeModeFromStorage,
    refreshAccountScopedWallpaperStateFromStorage,
    applyWebsiteWallpaperHandoffFromUrl,
    openWallpaperGallery,
    updateThemeModeToggle,
    closeWallpaperStyleEditor,
    resetWallpaperStyleEditorDraft,
    saveWallpaperStyleEditorDraft
} = wallpaperFeature;

let wallpaperPreferencesInitializationPromise = null;
let wallpaperPreferencesInitializationScopeUserId = null;

function ensureWallpaperPreferencesInitialized(prefetchedStorage = null) {
    const currentWallpaperScopeUserId = getWallpaperAccountScopeUserId() || null;
    if (
        wallpaperPreferencesInitializationPromise
        && currentWallpaperScopeUserId === wallpaperPreferencesInitializationScopeUserId
    ) {
        return wallpaperPreferencesInitializationPromise;
    }

    wallpaperPreferencesInitializationScopeUserId = currentWallpaperScopeUserId;
    wallpaperPreferencesInitializationPromise = (async () => {
        try {
            await initializeWallpaperPreferences(prefetchedStorage);
        } catch (error) {
            wallpaperPreferencesInitializationPromise = null;
            wallpaperPreferencesInitializationScopeUserId = null;
            throw error;
        }
    })();

    return wallpaperPreferencesInitializationPromise;
}

async function resetWallpaperStateForAccountBoundary({ clearPersistedState = true } = {}) {
    wallpaperPreferencesInitializationPromise = null;
    wallpaperPreferencesInitializationScopeUserId = null;
    wallpaperPreferencesInitialized = false;
    if (clearPersistedState) {
        await resetThemeForLoggedOutState();
    } else {
        applyLoggedOutDefaultThemeUi();
    }

    await loadInstalledWallpaperCatalog({ apply: true });
}

async function applyWallpaperCloudSyncState(rawState, { source = 'storage' } = {}) {
    void rawState;
    void source;
    return wallpaperCloudSyncState;
}

// ==================== IDIOMORPH EVENT DELEGATION ====================
// Handle click events for board/bookmark actions generated via Idiomorph morphing
// Uses data-action attributes for CSP compliance (no inline event handlers)

let morphActionHandlerInitialized = false;
function initMorphActionHandler() {
    if (morphActionHandlerInitialized) return;
    morphActionHandlerInitialized = true;

    const container = document.querySelector('.container');
    if (!container) return;

    // Track in-progress actions to prevent rapid double-click duplicates
    let actionInProgress = false;

    // Event delegation for all morphed board/bookmark action buttons
    container.addEventListener('click', async (e) => {
        // Handle add-board-placeholder clicks via delegation
        // MUST check both: IS on placeholder AND is NOT on a board (prevents bug after Chrome import)
        const placeholder = e.target.closest('.add-board-placeholder');
        if (placeholder && !e.target.closest('.board')) {
            const columnIndex = parseInt(placeholder.dataset.targetColumn, 10);
            if (!isNaN(columnIndex)) {
                showInlineBoardInput(columnIndex);
            }
            return;
        }

        const actionBtn = e.target.closest('[data-action]');
        if (!actionBtn) return;

        const action = actionBtn.dataset.action;
        const boardId = actionBtn.dataset.boardId ? actionBtn.dataset.boardId : null;
        const bookmarkId = actionBtn.dataset.bookmarkId ? actionBtn.dataset.bookmarkId : null;

        // Prevent default link behavior for action buttons
        e.preventDefault();
        e.stopPropagation();

        // Prevent rapid double-click duplicate operations for async actions
        // Menu toggle is exempt (fast, idempotent, needs responsive feel)
        if (action !== 'toggle-board-menu' && actionInProgress) {

            return;
        }

        try {
            actionInProgress = true;
            switch (action) {
                // Board actions
                case 'add-bookmark':
                    if (boardId) openAddBookmarkModal(boardId);
                    break;
                case 'show-remaining-bookmarks':
                    if (boardId) {
                        const changed = revealBoardBookmarks(boardId);
                        if (changed) await saveExpandedBoardIdsToStorage();
                        if (typeof actionBtn.blur === 'function') actionBtn.blur();
                        await loadBoardsFromDatabase();
                    }
                    break;
                case 'collapse-board-bookmarks':
                    if (boardId) {
                        const changed = collapseBoardBookmarks(boardId);
                        if (changed) await saveExpandedBoardIdsToStorage();
                        if (typeof actionBtn.blur === 'function') actionBtn.blur();
                        await loadBoardsFromDatabase();
                    }
                    break;
                case 'toggle-board-menu':
                    if (boardId) toggleBoardMenu(boardId);
                    break;
                case 'open-all-links':
                    if (boardId) {
                        await openAllBoardLinks(boardId);
                        closeBoardMenus();
                    }
                    break;
                case 'fetch-all-titles':
                    if (boardId) {
                        closeBoardMenus(); // Close menu immediately; action can take time
                        await fetchAllBoardLinkTitles(boardId);
                    }
                    break;
                case 'edit-board':
                    if (boardId) {
                        await openEditBoardModal(boardId);
                        closeBoardMenus();
                    }
                    break;
                case 'share-board':
                    if (boardId) {
                        if (!canModify()) break;
                        closeBoardMenus();  // Close menu immediately before async operation
                        await openShareModal('board', boardId);
                    }
                    break;
                case 'delete-board':
                    if (boardId) {
                        const board = await db.boards.get(boardId);
                        if (board) {
                            await showDeleteConfirmation(board.name, 'board', boardId);
                        } else {
                            // Board not found in database - sync with server and refresh UI
                            console.error(`Board ${boardId} not found in database - syncing with server`);
                            showGlassToast('Board not found. Syncing...', 'warning');
                            await SyncManager.autoSyncOnLoad();  // Pull fresh data from SERVER
                            await loadBoardsFromDatabase();       // Then refresh UI
                        }
                        closeBoardMenus();
                    }
                    break;
                // Bookmark actions
                case 'pin-bookmark':
                    if (bookmarkId) await toggleBookmarkPin(bookmarkId);
                    break;
                case 'edit-bookmark':
                    if (bookmarkId) await openEditBookmarkModal(bookmarkId);
                    break;
                case 'delete-bookmark':
                    if (bookmarkId) {
                        const bookmark = await db.bookmarks.get(bookmarkId);
                        if (bookmark) {
                            await showDeleteConfirmation(bookmark.title, 'bookmark', bookmarkId);
                        }
                    }
                    break;
            }
        } catch (error) {
            console.error(`Error handling action '${action}':`, error);
        } finally {
            actionInProgress = false;
        }
    });

    // Event delegation for board menu items (menus are appended to document.body, outside .container)
    document.body.addEventListener('click', async (e) => {
        const actionBtn = e.target.closest('.board-menu [data-action]');
        if (!actionBtn) return;

        const action = actionBtn.dataset.action;
        const boardId = actionBtn.dataset.boardId ? actionBtn.dataset.boardId : null;

        e.preventDefault();
        e.stopPropagation();

        try {
            switch (action) {
                case 'open-all-links':
                    if (boardId) {
                        await openAllBoardLinks(boardId);
                        closeBoardMenus();
                    }
                    break;
                case 'fetch-all-titles':
                    if (boardId) {
                        closeBoardMenus(); // Close menu immediately; action can take time
                        await fetchAllBoardLinkTitles(boardId);
                    }
                    break;
                case 'edit-board':
                    if (boardId) {
                        await openEditBoardModal(boardId);
                        closeBoardMenus();
                    }
                    break;
                case 'share-board':
                    if (boardId) {
                        if (!canModify()) break;
                        closeBoardMenus();  // Close menu immediately before async operation
                        await openShareModal('board', boardId);
                    }
                    break;
                case 'delete-board':
                    if (boardId) {
                        const board = await db.boards.get(boardId);
                        if (board) {
                            await showDeleteConfirmation(board.name, 'board', boardId);
                        } else {
                            // Board not found in database - sync with server and refresh UI
                            console.error(`Board ${boardId} not found in database - syncing with server`);
                            showGlassToast('Board not found. Syncing...', 'warning');
                            await SyncManager.autoSyncOnLoad();  // Pull fresh data from SERVER
                            await loadBoardsFromDatabase();       // Then refresh UI
                        }
                        closeBoardMenus();
                    }
                    break;
            }
        } catch (error) {
            console.error(`Error handling board menu action '${action}':`, error);
        }
    });

    // Event delegation for bookmark selection in selection mode
    // This is separate from the action handler because it needs to intercept clicks on the entire li element
    container.addEventListener('click', function (e) {
        // Only handle in selection mode
        if (!isSelectionMode) return;

        // Find the bookmark list item
        const listItem = getBookmarkSelectionListItemFromEvent(e);
        if (!listItem) return;

        // Don't handle if clicking on action buttons
        if (isBookmarkActionClickTarget(e.target)) return;

        e.preventDefault();
        e.stopPropagation();
        toggleBookmarkSelectionForListItem(listItem);
    });

    // Event delegation for double-click on board titles (open all links)
    container.addEventListener('dblclick', async (e) => {
        const titleText = e.target.closest('.board-title-text');
        if (!titleText) return;

        e.stopPropagation();
        e.preventDefault();

        const boardElement = titleText.closest('.board');
        if (!boardElement) return;

        const boardId = boardElement.dataset.boardId;
        if (!boardId) return;

        try {
            // Get all bookmarks for this board (excluding deleted)
            const bookmarks = await db.bookmarks
                .where('boardId').equals(boardId)
                .filter(b => !b.deletedAt)
                .toArray();

            if (bookmarks.length === 0) return;

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


}

function getBoardExpansionKey(boardId) {
    return String(boardId ?? '').trim();
}

function normalizeLargeBoardVisibleLimit(value) {
    const parsed = parseInt(value, 10);
    if (Number.isNaN(parsed)) return LARGE_BOARD_VISIBLE_LIMIT_DEFAULT;
    if (LARGE_BOARD_VISIBLE_LIMIT_OPTIONS.includes(parsed)) return parsed;

    // Fallback to the closest supported option for out-of-band stored values.
    let closest = LARGE_BOARD_VISIBLE_LIMIT_DEFAULT;
    let smallestDelta = Infinity;
    for (const option of LARGE_BOARD_VISIBLE_LIMIT_OPTIONS) {
        const delta = Math.abs(option - parsed);
        if (delta < smallestDelta) {
            smallestDelta = delta;
            closest = option;
        }
    }
    return closest;
}

function normalizeExpandedBoardIdList(value) {
    if (!Array.isArray(value)) return [];

    const unique = new Set();
    for (const entry of value) {
        const normalized = getBoardExpansionKey(entry);
        if (!normalized) continue;
        unique.add(normalized);
    }
    return Array.from(unique);
}

function setExpandedBoardIds(boardIds) {
    expandedLargeBoardIds.clear();
    for (const boardId of boardIds) {
        expandedLargeBoardIds.add(boardId);
    }
}

function hasSameExpandedBoardIds(boardIds) {
    if (!Array.isArray(boardIds)) return false;
    if (boardIds.length !== expandedLargeBoardIds.size) return false;
    for (const boardId of boardIds) {
        if (!expandedLargeBoardIds.has(boardId)) return false;
    }
    return true;
}

async function saveExpandedBoardIdsToStorage() {
    if (!(typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local)) {
        return;
    }

    try {
        await chrome.storage.local.set({
            [LARGE_BOARD_EXPANDED_IDS_STORAGE_KEY]: Array.from(expandedLargeBoardIds)
        });
    } catch (error) {
        console.error('Failed to save expanded board state:', error);
    }
}

async function pruneExpandedBoardIdsAgainstExistingBoards(options = {}) {
    const persist = options.persist === true;
    try {
        const existingBoardIds = await db.boards
            .filter(board => !board.deletedAt)
            .primaryKeys();
        const existingBoardIdSet = new Set(existingBoardIds.map(id => getBoardExpansionKey(id)));

        let changed = false;
        for (const boardId of Array.from(expandedLargeBoardIds)) {
            if (!existingBoardIdSet.has(boardId)) {
                expandedLargeBoardIds.delete(boardId);
                changed = true;
            }
        }

        if (changed && persist) {
            await saveExpandedBoardIdsToStorage();
        }
    } catch (error) {
        console.error('Failed to prune expanded board IDs:', error);
    }
}

function isBoardExpanded(boardId) {
    return expandedLargeBoardIds.has(getBoardExpansionKey(boardId));
}

function shouldCollapseBoardBookmarks(boardId, totalBookmarks) {
    return largeBoardCollapseEnabled &&
        totalBookmarks > largeBoardVisibleBookmarkLimit &&
        !isBoardExpanded(boardId);
}

function getVisibleBookmarksForBoard(boardId, bookmarks) {
    if (!Array.isArray(bookmarks)) return [];
    if (!shouldCollapseBoardBookmarks(boardId, bookmarks.length)) return bookmarks;
    return bookmarks.slice(0, largeBoardVisibleBookmarkLimit);
}

function getShowRemainingBookmarksLabel(remainingCount) {
    return remainingCount === 1
        ? 'Show remaining 1 bookmark'
        : `Show remaining ${remainingCount} bookmarks`;
}

function getCollapseBookmarksLabel() {
    return 'Collapse';
}

function getBoardBookmarkToggleControl(boardId, totalBookmarks) {
    if (!largeBoardCollapseEnabled || totalBookmarks <= largeBoardVisibleBookmarkLimit) {
        return null;
    }

    if (isBoardExpanded(boardId)) {
        return {
            action: 'collapse-board-bookmarks',
            label: getCollapseBookmarksLabel()
        };
    }

    return {
        action: 'show-remaining-bookmarks',
        label: getShowRemainingBookmarksLabel(totalBookmarks - largeBoardVisibleBookmarkLimit)
    };
}

function updateLargeBoardCollapseToggle() {
    const toggle = document.getElementById('largeBoardCollapseToggle');
    if (toggle) {
        toggle.checked = largeBoardCollapseEnabled;
    }
    updateLargeBoardVisibleLimitControl();
}

function updateLargeBoardVisibleLimitControl() {
    const select = document.getElementById('largeBoardVisibleLimitSelect');
    const settingRow = document.getElementById('largeBoardVisibleLimitSetting');
    if (settingRow) {
        settingRow.style.display = largeBoardCollapseEnabled ? 'flex' : 'none';
    }
    if (!select) return;

    select.value = String(largeBoardVisibleBookmarkLimit);
    select.disabled = !largeBoardCollapseEnabled;
}

async function loadLargeBoardCollapseSetting(prefetchedStorage = null) {
    try {
        const result = prefetchedStorage && typeof prefetchedStorage === 'object'
            ? prefetchedStorage
            : await chrome.storage.local.get([
                'largeBoardCollapseEnabled',
                LARGE_BOARD_VISIBLE_LIMIT_STORAGE_KEY,
                LARGE_BOARD_EXPANDED_IDS_STORAGE_KEY
            ]);
        largeBoardCollapseEnabled = result.largeBoardCollapseEnabled === true;
        largeBoardVisibleBookmarkLimit = normalizeLargeBoardVisibleLimit(
            result[LARGE_BOARD_VISIBLE_LIMIT_STORAGE_KEY]
        );
        const expandedIds = normalizeExpandedBoardIdList(result[LARGE_BOARD_EXPANDED_IDS_STORAGE_KEY]);
        setExpandedBoardIds(expandedIds);
        await pruneExpandedBoardIdsAgainstExistingBoards({ persist: true });

        updateLargeBoardCollapseToggle();
    } catch (error) {
        console.error('Failed to load large board collapse setting:', error);
    }
}

async function handleLargeBoardCollapseToggle(event) {
    if (!canMutateAccountScopedPreferences()) {
        updateLargeBoardCollapseToggle();
        return;
    }

    const enabled = event.target.checked === true;
    largeBoardCollapseEnabled = enabled;
    updateLargeBoardCollapseToggle();

    try {
        await chrome.storage.local.set({ largeBoardCollapseEnabled: enabled });
    } catch (error) {
        console.error('Failed to save large board collapse setting:', error);
    }

    try {
        await loadBoardsFromDatabase();
    } catch (error) {
        console.error('Failed to refresh boards after updating large board collapse setting:', error);
    }
}

function revealBoardBookmarks(boardId) {
    const key = getBoardExpansionKey(boardId);
    if (!key) return false;
    const sizeBefore = expandedLargeBoardIds.size;
    expandedLargeBoardIds.add(key);
    return expandedLargeBoardIds.size !== sizeBefore;
}

function collapseBoardBookmarks(boardId) {
    const key = getBoardExpansionKey(boardId);
    if (!key) return false;
    return expandedLargeBoardIds.delete(key);
}

async function handleLargeBoardVisibleLimitChange(event) {
    if (!canMutateAccountScopedPreferences()) {
        updateLargeBoardVisibleLimitControl();
        return;
    }

    const nextLimit = normalizeLargeBoardVisibleLimit(event?.target?.value);
    const changed = nextLimit !== largeBoardVisibleBookmarkLimit;
    largeBoardVisibleBookmarkLimit = nextLimit;
    updateLargeBoardVisibleLimitControl();

    try {
        await chrome.storage.local.set({ [LARGE_BOARD_VISIBLE_LIMIT_STORAGE_KEY]: nextLimit });
    } catch (error) {
        console.error('Failed to save large board visible bookmark limit:', error);
    }

    if (changed && largeBoardCollapseEnabled) {
        try {
            await loadBoardsFromDatabase();
        } catch (error) {
            console.error('Failed to refresh boards after changing visible bookmark limit:', error);
        }
    }
}

function normalizeThemeMode(mode) {
    return mode === 'light' ? 'light' : 'dark';
}

function createEmptyWallpaperCatalog() {
    return { dark: [], light: [] };
}

function createEmptyWallpaperSelection() {
    return { dark: null, light: null };
}

function createEmptyWallpaperStyleOverrideState() {
    return { dark: null, light: null };
}

function createEmptyNewUserWallpaperDefaultConfig() {
    return {
        themeMode: null,
        selectionByTheme: createEmptyWallpaperSelection(),
        updatedAt: null
    };
}

function normalizeBundledWallpaperPathForTheme(theme, filePath) {
    if (typeof filePath !== 'string') return null;
    const normalizedTheme = normalizeThemeMode(theme);
    const trimmed = filePath.trim().replace(/^\/+/, '');
    if (!trimmed.startsWith(`wallpaper/${normalizedTheme}/`)) return null;
    if (!WALLPAPER_FILE_PATTERN.test(trimmed)) return null;
    return trimmed;
}

function normalizeNewUserWallpaperDefaultConfig(rawDefault, options = {}) {
    const source = isPlainObject(rawDefault) ? rawDefault : {};
    const rawSelection = isPlainObject(source.selectionByTheme) ? source.selectionByTheme : {};
    const resolveSelectionFile = typeof options.resolveSelectionFile === 'function'
        ? options.resolveSelectionFile
        : normalizeBundledWallpaperPathForTheme;
    const normalizedSelection = createEmptyWallpaperSelection();

    ['dark', 'light'].forEach((theme) => {
        normalizedSelection[theme] = resolveSelectionFile(theme, rawSelection[theme]);
    });

    let resolvedThemeMode = (source.themeMode === 'dark' || source.themeMode === 'light')
        ? source.themeMode
        : null;
    if (!resolvedThemeMode) {
        resolvedThemeMode = normalizedSelection.dark
            ? 'dark'
            : (normalizedSelection.light ? 'light' : null);
    }

    return {
        themeMode: resolvedThemeMode,
        selectionByTheme: normalizedSelection,
        updatedAt: typeof source.updatedAt === 'string' && source.updatedAt.trim()
            ? source.updatedAt.trim()
            : null
    };
}

function normalizeWallpaperSyncUserId(value) {
    return (typeof value === 'string' && value.trim()) ? value.trim() : null;
}

function createEmptyWallpaperCloudSyncState(userId = null) {
    return {
        userId: normalizeWallpaperSyncUserId(userId),
        hasConfiguredPreferences: false,
        themeMode: null,
        selectionByTheme: createEmptyWallpaperSelection(),
        selectionPresenceByTheme: {
            dark: false,
            light: false
        },
        installedWallpapers: [],
        updatedAt: null,
        fetchedAt: null
    };
}

function getWallpaperCloudStateUpdatedAtMs(state) {
    const parsed = Date.parse(state?.updatedAt || '');
    return Number.isFinite(parsed) ? parsed : null;
}

function getNextWallpaperPreferenceUpdatedAt(userId = wallpaperAccountScopeUserId, currentState = wallpaperCloudSyncState) {
    const normalizedUserId = normalizeWallpaperSyncUserId(userId);
    const currentStateUserId = normalizeWallpaperSyncUserId(currentState?.userId);
    const currentUpdatedAtMs = (
        normalizedUserId
        && currentStateUserId === normalizedUserId
    )
        ? getWallpaperCloudStateUpdatedAtMs(currentState)
        : null;
    const nowMs = Date.now();
    const nextMs = currentUpdatedAtMs !== null && currentUpdatedAtMs >= nowMs
        ? currentUpdatedAtMs + 1
        : nowMs;
    return new Date(nextMs).toISOString();
}

function shouldIgnoreIncomingWallpaperCloudState(incomingState, currentState = wallpaperCloudSyncState) {
    const normalizedIncomingUserId = normalizeWallpaperSyncUserId(incomingState?.userId);
    const normalizedCurrentUserId = normalizeWallpaperSyncUserId(currentState?.userId);
    if (!normalizedIncomingUserId || !normalizedCurrentUserId || normalizedIncomingUserId !== normalizedCurrentUserId) {
        return false;
    }

    const currentUpdatedAtMs = getWallpaperCloudStateUpdatedAtMs(currentState);
    if (currentUpdatedAtMs === null) {
        return false;
    }

    const incomingUpdatedAtMs = getWallpaperCloudStateUpdatedAtMs(incomingState);
    if (incomingUpdatedAtMs === null) {
        return currentState?.hasConfiguredPreferences === true;
    }

    return incomingUpdatedAtMs < currentUpdatedAtMs;
}

function getWallpaperCloudSyncStateFingerprint(state) {
    const source = state && typeof state === 'object' ? state : {};
    const installs = Array.isArray(source.installedWallpapers)
        ? source.installedWallpapers.map((entry) => ({
            id: typeof entry?.id === 'string' && entry.id.trim() ? entry.id.trim() : null,
            theme: normalizeThemeMode(entry?.theme),
            remoteId: typeof entry?.remoteId === 'string' && entry.remoteId.trim() ? entry.remoteId.trim() : null,
            sourceUrl: typeof entry?.sourceUrl === 'string' && entry.sourceUrl.trim() ? entry.sourceUrl.trim() : null,
            version: typeof entry?.version === 'string' && entry.version.trim() ? entry.version.trim() : null,
            updatedAt: typeof entry?.updatedAt === 'string' && entry.updatedAt.trim() ? entry.updatedAt.trim() : null
        }))
        : [];

    return JSON.stringify({
        userId: normalizeWallpaperSyncUserId(source.userId),
        hasConfiguredPreferences: source.hasConfiguredPreferences === true,
        themeMode: (source.themeMode === 'dark' || source.themeMode === 'light')
            ? source.themeMode
            : null,
        selectionByTheme: {
            dark: typeof source?.selectionByTheme?.dark === 'string' && source.selectionByTheme.dark.trim()
                ? source.selectionByTheme.dark.trim()
                : null,
            light: typeof source?.selectionByTheme?.light === 'string' && source.selectionByTheme.light.trim()
                ? source.selectionByTheme.light.trim()
                : null
        },
        selectionPresenceByTheme: {
            dark: source?.selectionPresenceByTheme?.dark === true,
            light: source?.selectionPresenceByTheme?.light === true
        },
        updatedAt: typeof source.updatedAt === 'string' && source.updatedAt.trim()
            ? source.updatedAt.trim()
            : null,
        installedWallpapers: installs
    });
}

function getWallpaperAccountScopeUserId() {
    return wallpaperAccountScopeUserId;
}

function setWallpaperAccountScopeUserId(userId) {
    const normalizedUserId = normalizeWallpaperSyncUserId(userId);
    const didUserChange = normalizedUserId !== wallpaperAccountScopeUserId;
    wallpaperAccountScopeUserId = normalizedUserId;
    if (didUserChange) {
        wallpaperLastAppliedCloudSyncFingerprint = null;
        pendingWallpaperCloudSyncFingerprints.clear();
    }
    if (!normalizedUserId) {
        wallpaperCloudSyncState = createEmptyWallpaperCloudSyncState(null);
        wallpaperPreferenceSyncReadyUserId = null;
        wallpaperPreferenceSyncPending = false;
        if (didUserChange) {
            wallpaperCloudSyncApplyChain = Promise.resolve();
        }
        return;
    }

    if (wallpaperCloudSyncState?.userId !== normalizedUserId) {
        wallpaperCloudSyncState = createEmptyWallpaperCloudSyncState(normalizedUserId);
    }
    if (wallpaperPreferenceSyncReadyUserId && wallpaperPreferenceSyncReadyUserId !== normalizedUserId) {
        wallpaperPreferenceSyncReadyUserId = null;
    }
}

function createWallpaperCatalogState(
    catalog,
    themeDefaults = wallpaperThemeDefaults,
    newUserDefault = wallpaperNewUserDefaultConfig
) {
    return {
        themes: isPlainObject(catalog) ? catalog : createEmptyWallpaperCatalog(),
        themeDefaults: isPlainObject(themeDefaults) ? themeDefaults : createEmptyWallpaperThemeDefaults(),
        newUserDefault: isPlainObject(newUserDefault)
            ? newUserDefault
            : createEmptyNewUserWallpaperDefaultConfig()
    };
}

function rebuildWallpaperCatalogState() {
    const mergedCatalog = mergeWallpaperCatalogs(
        createWallpaperCatalogState(bundledWallpaperCatalogByTheme, wallpaperThemeDefaults),
        createWallpaperCatalogState(installedWallpaperCatalogByTheme, wallpaperThemeDefaults)
    );
    wallpaperCatalogByTheme = mergedCatalog.themes;
}

function setBundledWallpaperCatalogState(catalogState) {
    bundledWallpaperCatalogByTheme = isPlainObject(catalogState?.themes)
        ? catalogState.themes
        : createEmptyWallpaperCatalog();
    wallpaperThemeDefaults = isPlainObject(catalogState?.themeDefaults)
        ? catalogState.themeDefaults
        : createEmptyWallpaperThemeDefaults();
    wallpaperNewUserDefaultConfig = normalizeNewUserWallpaperDefaultConfig(catalogState?.newUserDefault);
    rebuildWallpaperCatalogState();
    persistLoggedOutDefaultVisualSnapshot();
}

function setInstalledWallpaperCatalogState(catalog) {
    installedWallpaperCatalogByTheme = isPlainObject(catalog)
        ? catalog
        : createEmptyWallpaperCatalog();
    rebuildWallpaperCatalogState();
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function createEmptyWallpaperDiagnosticsCounters() {
    return {
        hostedCatalogRequests: 0,
        hostedCatalogFailures: 0,
        galleryManifestRequests: 0,
        galleryManifestFailures: 0,
        installDownloads: 0,
        installFailures: 0,
        migrationAttempts: 0,
        migrationFailures: 0,
        bootFallbackUses: 0
    };
}

function createEmptyWallpaperDiagnosticsState() {
    return {
        version: 1,
        rolloutFlags: { ...WALLPAPER_RUNTIME_ROLLOUT_FLAGS },
        counters: createEmptyWallpaperDiagnosticsCounters(),
        events: [],
        lastUpdatedAt: null
    };
}

function sanitizeWallpaperDiagnosticString(value, maxLength = 220) {
    const normalized = typeof value === 'string'
        ? value.replace(/\s+/g, ' ').trim()
        : String(value ?? '').replace(/\s+/g, ' ').trim();
    if (!normalized) return '';
    return normalized.length > maxLength
        ? `${normalized.slice(0, maxLength)}...`
        : normalized;
}

function normalizeWallpaperDiagnosticDetailValue(value, depth = 0) {
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value === 'string') {
        return sanitizeWallpaperDiagnosticString(value);
    }
    if (value instanceof Error) {
        return sanitizeWallpaperDiagnosticString(value.message || String(value));
    }
    if (Array.isArray(value)) {
        if (depth >= 1) {
            return value.length;
        }
        return value.slice(0, 6).map((entry) => normalizeWallpaperDiagnosticDetailValue(entry, depth + 1));
    }
    if (isPlainObject(value)) {
        if (depth >= 1) {
            return Object.keys(value).slice(0, 6);
        }

        const normalized = {};
        Object.entries(value).slice(0, 10).forEach(([key, entryValue]) => {
            const normalizedValue = normalizeWallpaperDiagnosticDetailValue(entryValue, depth + 1);
            if (normalizedValue !== undefined) {
                normalized[key] = normalizedValue;
            }
        });
        return normalized;
    }
    if (value === undefined) {
        return undefined;
    }
    return sanitizeWallpaperDiagnosticString(value);
}

function normalizeWallpaperDiagnosticDetail(detail) {
    if (!isPlainObject(detail)) {
        const normalizedValue = normalizeWallpaperDiagnosticDetailValue(detail);
        return normalizedValue === undefined ? {} : { value: normalizedValue };
    }

    const normalized = {};
    Object.entries(detail).slice(0, 10).forEach(([key, value]) => {
        const normalizedValue = normalizeWallpaperDiagnosticDetailValue(value);
        if (normalizedValue !== undefined) {
            normalized[key] = normalizedValue;
        }
    });
    return normalized;
}

function readWallpaperDiagnosticsState() {
    const fallbackState = createEmptyWallpaperDiagnosticsState();
    try {
        const rawState = localStorage.getItem(WALLPAPER_DIAGNOSTICS_LOCAL_KEY);
        if (!rawState) {
            return fallbackState;
        }

        const parsedState = JSON.parse(rawState);
        const rawCounters = isPlainObject(parsedState?.counters) ? parsedState.counters : {};
        const normalizedCounters = createEmptyWallpaperDiagnosticsCounters();
        WALLPAPER_DIAGNOSTIC_COUNTER_KEYS.forEach((counterKey) => {
            const rawValue = Number(rawCounters[counterKey]);
            normalizedCounters[counterKey] = Number.isFinite(rawValue) && rawValue >= 0
                ? Math.floor(rawValue)
                : 0;
        });

        const normalizedEvents = Array.isArray(parsedState?.events)
            ? parsedState.events
                .filter((entry) => isPlainObject(entry) && typeof entry.type === 'string' && entry.type.trim())
                .slice(0, WALLPAPER_DIAGNOSTICS_MAX_EVENTS)
                .map((entry) => ({
                    at: typeof entry.at === 'string' && entry.at.trim() ? entry.at.trim() : null,
                    type: sanitizeWallpaperDiagnosticString(entry.type, 120),
                    detail: normalizeWallpaperDiagnosticDetail(entry.detail)
                }))
            : [];

        return {
            version: 1,
            rolloutFlags: { ...WALLPAPER_RUNTIME_ROLLOUT_FLAGS },
            counters: normalizedCounters,
            events: normalizedEvents,
            lastUpdatedAt: typeof parsedState?.lastUpdatedAt === 'string' && parsedState.lastUpdatedAt.trim()
                ? parsedState.lastUpdatedAt.trim()
                : null
        };
    } catch (error) {
        return fallbackState;
    }
}

function writeWallpaperDiagnosticsState(state) {
    try {
        localStorage.setItem(WALLPAPER_DIAGNOSTICS_LOCAL_KEY, JSON.stringify(state));
        return true;
    } catch (error) {
        return false;
    }
}

function recordWallpaperDiagnosticEvent(type, detail = {}, options = {}) {
    if (WALLPAPER_RUNTIME_ROLLOUT_FLAGS.diagnosticsEnabled !== true) {
        return null;
    }

    const normalizedType = sanitizeWallpaperDiagnosticString(type, 120);
    if (!normalizedType) {
        return null;
    }

    const diagnosticsState = readWallpaperDiagnosticsState();
    const counterName = typeof options?.counter === 'string' ? options.counter.trim() : '';
    const counterDeltaRaw = Number(options?.counterDelta);
    const counterDelta = Number.isFinite(counterDeltaRaw) ? Math.floor(counterDeltaRaw) : 1;
    if (
        counterName
        && Object.prototype.hasOwnProperty.call(diagnosticsState.counters, counterName)
        && counterDelta !== 0
    ) {
        diagnosticsState.counters[counterName] = Math.max(
            0,
            diagnosticsState.counters[counterName] + counterDelta
        );
    }

    const event = {
        at: new Date().toISOString(),
        type: normalizedType,
        detail: normalizeWallpaperDiagnosticDetail(detail)
    };

    diagnosticsState.events = [event, ...diagnosticsState.events].slice(0, WALLPAPER_DIAGNOSTICS_MAX_EVENTS);
    diagnosticsState.lastUpdatedAt = event.at;
    writeWallpaperDiagnosticsState(diagnosticsState);
    return event;
}

function clearWallpaperDiagnosticsState() {
    const emptyState = createEmptyWallpaperDiagnosticsState();
    writeWallpaperDiagnosticsState(emptyState);
    return emptyState;
}

function getWallpaperDiagnosticsSnapshot() {
    return readWallpaperDiagnosticsState();
}

function exposeWallpaperDiagnosticsDebugApi() {
    if (typeof window === 'undefined') return;

    window.LumiListWallpaperDebug = {
        getSnapshot() {
            return getWallpaperDiagnosticsSnapshot();
        },
        clear() {
            return clearWallpaperDiagnosticsState();
        },
        getRolloutFlags() {
            return { ...WALLPAPER_RUNTIME_ROLLOUT_FLAGS };
        }
    };
}

exposeWallpaperDiagnosticsDebugApi();

function clampNumber(value, min, max, fallback) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.min(max, Math.max(min, numeric));
}

/**
 * Generates a random vibrant hex color.
 * Ensures the color is not too dark or too light for good contrast.
 */
function generateRandomColor() {
    const hue = Math.floor(Math.random() * 360);
    // Vibrant colors: high saturation (70-90%) and medium-high brightness (60-80%)
    const saturation = 70 + Math.floor(Math.random() * 20);
    const lightness = 60 + Math.floor(Math.random() * 10);
    
    return hslToHex(hue, saturation, lightness);
}

/**
 * Helper to convert HSL to Hex
 */
function hslToHex(h, s, l) {
    l /= 100;
    const a = s * Math.min(l, 1 - l) / 100;
    const f = n => {
        const k = (n + h / 30) % 12;
        const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
        return Math.round(255 * color).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`.toUpperCase();
}

function normalizeHexColor(value, fallback) {
    const candidate = typeof value === 'string' ? value.trim() : '';
    const match = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(candidate);
    if (!match) return fallback;
    const raw = match[1];
    if (raw.length === 3) {
        const expanded = raw.split('').map(char => char + char).join('');
        return `#${expanded.toUpperCase()}`;
    }
    return `#${raw.toUpperCase()}`;
}

function normalizeOverlayAngle(value, fallback) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    const normalized = ((numeric % 360) + 360) % 360;
    return Number(normalized.toFixed(3));
}

function normalizeOpacity(value, fallback) {
    const normalized = clampNumber(value, 0, 1, fallback);
    return Number(normalized.toFixed(3));
}

function normalizeBoardBackdropBlur(value, fallback) {
    const normalized = clampNumber(value, 0, 40, fallback);
    return Number(normalized.toFixed(2));
}

function normalizeBoardBackdropSaturate(value, fallback) {
    const normalized = clampNumber(value, 0, 300, fallback);
    return Number(normalized.toFixed(2));
}

function normalizeInactiveControlBackdropBlur(value, fallback) {
    const normalized = clampNumber(value, 0, 40, fallback);
    return Number(normalized.toFixed(2));
}

function normalizeInactiveControlBackdropSaturate(value, fallback) {
    const normalized = clampNumber(value, 0, 300, fallback);
    return Number(normalized.toFixed(2));
}

function normalizeWallpaperUserStyleOverride(rawOverride) {
    const source = rawOverride && typeof rawOverride === 'object' && !Array.isArray(rawOverride)
        ? rawOverride
        : {};
    const normalized = {};
    const primary = normalizeHexColor(source.primary, null);
    const boardBackgroundColor = normalizeHexColor(source.boardBackgroundColor, null);
    const boardBackgroundOpacity = Number.isFinite(Number(source.boardBackgroundOpacity))
        ? normalizeOpacity(source.boardBackgroundOpacity, 0)
        : null;
    const boardBackdropBlur = Number.isFinite(Number(source.boardBackdropBlur))
        ? normalizeBoardBackdropBlur(source.boardBackdropBlur, 0)
        : null;

    if (primary) {
        normalized.primary = primary;
    }
    if (boardBackgroundColor) {
        normalized.boardBackgroundColor = boardBackgroundColor;
    }
    if (boardBackgroundOpacity !== null) {
        normalized.boardBackgroundOpacity = boardBackgroundOpacity;
    }
    if (boardBackdropBlur !== null) {
        normalized.boardBackdropBlur = boardBackdropBlur;
    }

    return Object.keys(normalized).length > 0 ? normalized : null;
}

function normalizeWallpaperUserStyleOverrideState(rawState) {
    const source = rawState && typeof rawState === 'object' && !Array.isArray(rawState)
        ? rawState
        : {};
    return {
        dark: normalizeWallpaperUserStyleOverride(source.dark),
        light: normalizeWallpaperUserStyleOverride(source.light)
    };
}

function hasConfiguredWallpaperUserStyleOverride(rawOverride) {
    return Boolean(normalizeWallpaperUserStyleOverride(rawOverride));
}

function normalizeTabHoverTextColor(value, fallback) {
    return normalizeHexColor(value, fallback);
}

function normalizeWallpaperStyleConfig(rawStyle, fallbackStyle) {
    const source = isPlainObject(rawStyle) ? rawStyle : {};
    const fallback = isPlainObject(fallbackStyle) ? fallbackStyle : DEFAULT_WALLPAPER_THEME_STYLES.dark;
    const sourceOverlay = isPlainObject(source.overlay) ? source.overlay : {};
    const fallbackOverlay = isPlainObject(fallback.overlay)
        ? fallback.overlay
        : DEFAULT_WALLPAPER_THEME_STYLES.dark.overlay;

    return {
        primary: normalizeHexColor(source.primary, fallback.primary),
        activeTextColor: normalizeHexColor(source.activeTextColor, fallback.activeTextColor),
        tabHoverTextColor: normalizeTabHoverTextColor(
            source.tabHoverTextColor,
            fallback.tabHoverTextColor
        ),
        inactiveTabTextColor: normalizeHexColor(source.inactiveTabTextColor, fallback.inactiveTabTextColor),
        boardTextColor: normalizeHexColor(source.boardTextColor, fallback.boardTextColor),
        linkDescriptionTextColor: normalizeHexColor(
            source.linkDescriptionTextColor,
            fallback.linkDescriptionTextColor
        ),
        iconColor: normalizeHexColor(source.iconColor, fallback.iconColor),
        tabArrowColor: normalizeHexColor(
            source.tabArrowColor,
            fallback.tabArrowColor || fallback.iconColor
        ),
        addBoardColor: normalizeHexColor(source.addBoardColor, fallback.addBoardColor),
        boardBackgroundColor: normalizeHexColor(
            source.boardBackgroundColor,
            fallback.boardBackgroundColor
        ),
        boardBackgroundOpacity: normalizeOpacity(
            source.boardBackgroundOpacity,
            fallback.boardBackgroundOpacity
        ),
        boardBackdropBlur: normalizeBoardBackdropBlur(
            source.boardBackdropBlur,
            fallback.boardBackdropBlur
        ),
        boardBackdropSaturate: normalizeBoardBackdropSaturate(
            source.boardBackdropSaturate,
            fallback.boardBackdropSaturate
        ),
        inactiveControlColor: normalizeHexColor(
            source.inactiveControlColor,
            fallback.inactiveControlColor
        ),
        inactiveControlOpacity: normalizeOpacity(
            source.inactiveControlOpacity,
            fallback.inactiveControlOpacity
        ),
        inactiveControlBackdropBlur: normalizeInactiveControlBackdropBlur(
            source.inactiveControlBackdropBlur,
            fallback.inactiveControlBackdropBlur
        ),
        inactiveControlBackdropSaturate: normalizeInactiveControlBackdropSaturate(
            source.inactiveControlBackdropSaturate,
            fallback.inactiveControlBackdropSaturate
        ),
        popupBackgroundColor: normalizeHexColor(
            source.popupBackgroundColor,
            fallback.popupBackgroundColor
        ),
        popupBackgroundOpacity: normalizeOpacity(
            source.popupBackgroundOpacity,
            fallback.popupBackgroundOpacity
        ),
        popupCardBackgroundColor: normalizeHexColor(
            source.popupCardBackgroundColor,
            fallback.popupCardBackgroundColor
        ),
        popupCardBackgroundOpacity: normalizeOpacity(
            source.popupCardBackgroundOpacity,
            fallback.popupCardBackgroundOpacity
        ),
        dropdownBackgroundColor: normalizeHexColor(
            source.dropdownBackgroundColor,
            fallback.dropdownBackgroundColor
        ),
        dropdownBackgroundOpacity: normalizeOpacity(
            source.dropdownBackgroundOpacity,
            fallback.dropdownBackgroundOpacity
        ),
        overlay: {
            angle: normalizeOverlayAngle(sourceOverlay.angle, fallbackOverlay.angle),
            topColor: normalizeHexColor(sourceOverlay.topColor, fallbackOverlay.topColor),
            topOpacity: normalizeOpacity(sourceOverlay.topOpacity, fallbackOverlay.topOpacity),
            bottomColor: normalizeHexColor(sourceOverlay.bottomColor, fallbackOverlay.bottomColor),
            bottomOpacity: normalizeOpacity(sourceOverlay.bottomOpacity, fallbackOverlay.bottomOpacity)
        }
    };
}

function createEmptyWallpaperThemeDefaults() {
    return {
        dark: normalizeWallpaperStyleConfig(
            DEFAULT_WALLPAPER_THEME_STYLES.dark,
            DEFAULT_WALLPAPER_THEME_STYLES.dark
        ),
        light: normalizeWallpaperStyleConfig(
            DEFAULT_WALLPAPER_THEME_STYLES.light,
            DEFAULT_WALLPAPER_THEME_STYLES.light
        )
    };
}

function getWallpaperThemeDefaultForTheme(theme) {
    const normalizedTheme = normalizeThemeMode(theme);
    const defaults = isPlainObject(wallpaperThemeDefaults)
        ? wallpaperThemeDefaults
        : createEmptyWallpaperThemeDefaults();
    const fallback = DEFAULT_WALLPAPER_THEME_STYLES[normalizedTheme];
    return normalizeWallpaperStyleConfig(defaults[normalizedTheme], fallback);
}

function applyWallpaperUserStyleOverride(theme, baseStyle) {
    const normalizedTheme = normalizeThemeMode(theme);
    const resolvedBaseStyle = normalizeWallpaperStyleConfig(
        baseStyle,
        getWallpaperThemeDefaultForTheme(normalizedTheme)
    );
    const styleOverride = normalizeWallpaperUserStyleOverride(
        wallpaperStyleOverridesByTheme?.[normalizedTheme]
    );
    if (!styleOverride) {
        return resolvedBaseStyle;
    }

    const mergedStyle = {
        ...resolvedBaseStyle,
        ...styleOverride
    };

    if (styleOverride.boardBackgroundColor) {
        mergedStyle.dropdownBackgroundColor = styleOverride.boardBackgroundColor;
        mergedStyle.dropdownBackgroundOpacity = 1;
    }

    return normalizeWallpaperStyleConfig(
        mergedStyle,
        getWallpaperThemeDefaultForTheme(normalizedTheme)
    );
}

function buildLoggedOutDefaultVisualSnapshot() {
    const configuredDefault = normalizeNewUserWallpaperDefaultConfig(wallpaperNewUserDefaultConfig);
    const resolvedThemeMode = configuredDefault.themeMode === 'light' ? 'light' : 'dark';
    const defaultThemeStyle = getWallpaperThemeDefaultForTheme(resolvedThemeMode);
    const bundledEntries = Array.isArray(bundledWallpaperCatalogByTheme?.[resolvedThemeMode])
        ? bundledWallpaperCatalogByTheme[resolvedThemeMode]
        : [];
    let wallpaper = normalizeBundledWallpaperPathForTheme(
        resolvedThemeMode,
        configuredDefault.selectionByTheme?.[resolvedThemeMode]
    );
    let style = defaultThemeStyle;

    if (wallpaper) {
        const matchedEntry = bundledEntries.find((entry) => entry?.file === wallpaper);
        if (matchedEntry) {
            style = normalizeWallpaperStyleConfig(matchedEntry.style, defaultThemeStyle);
        } else {
            wallpaper = null;
        }
    }

    return {
        themeMode: resolvedThemeMode,
        wallpaper,
        style,
        updatedAt: new Date().toISOString()
    };
}

function persistLoggedOutDefaultVisualSnapshot() {
    const snapshot = buildLoggedOutDefaultVisualSnapshot();
    try {
        localStorage.setItem(
            WALLPAPER_LOGGED_OUT_DEFAULT_SNAPSHOT_LOCAL_KEY,
            JSON.stringify(snapshot)
        );
    } catch (_error) {
        // Non-blocking bootstrap snapshot cache.
    }
    return snapshot;
}

function hexToRgb(hexColor) {
    const normalized = normalizeHexColor(hexColor, null);
    if (!normalized) return null;
    const value = normalized.slice(1);
    return {
        r: parseInt(value.slice(0, 2), 16),
        g: parseInt(value.slice(2, 4), 16),
        b: parseInt(value.slice(4, 6), 16)
    };
}

function rgbToHex(rgb) {
    const toHex = (value) => Math.round(value).toString(16).padStart(2, '0').toUpperCase();
    return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`;
}

function mixRgb(sourceRgb, targetRgb, amount) {
    const ratio = clampNumber(amount, 0, 1, 0);
    return {
        r: sourceRgb.r + (targetRgb.r - sourceRgb.r) * ratio,
        g: sourceRgb.g + (targetRgb.g - sourceRgb.g) * ratio,
        b: sourceRgb.b + (targetRgb.b - sourceRgb.b) * ratio
    };
}

function relativeLuminanceFromRgb(rgb) {
    const toLinear = (value) => {
        const channel = clampNumber(value, 0, 255, 0) / 255;
        return channel <= 0.03928
            ? channel / 12.92
            : Math.pow((channel + 0.055) / 1.055, 2.4);
    };

    const r = toLinear(rgb.r);
    const g = toLinear(rgb.g);
    const b = toLinear(rgb.b);
    return (0.2126 * r) + (0.7152 * g) + (0.0722 * b);
}

function resolveReadableForegroundForHex(backgroundHex, darkHex = '#1A1F2E', lightHex = '#FFFFFF') {
    const backgroundRgb = hexToRgb(backgroundHex);
    const darkRgb = hexToRgb(darkHex);
    const lightRgb = hexToRgb(lightHex);
    if (!backgroundRgb || !darkRgb || !lightRgb) return darkHex;

    const backgroundLuminance = relativeLuminanceFromRgb(backgroundRgb);
    const darkLuminance = relativeLuminanceFromRgb(darkRgb);
    const lightLuminance = relativeLuminanceFromRgb(lightRgb);

    const contrastWithDark = (Math.max(backgroundLuminance, darkLuminance) + 0.05)
        / (Math.min(backgroundLuminance, darkLuminance) + 0.05);
    const contrastWithLight = (Math.max(backgroundLuminance, lightLuminance) + 0.05)
        / (Math.min(backgroundLuminance, lightLuminance) + 0.05);

    return contrastWithDark >= contrastWithLight ? darkHex : lightHex;
}

function resolveReadableForegroundForHexes(backgroundHexes, darkHex = '#1A1F2E', lightHex = '#FFFFFF') {
    const candidates = Array.isArray(backgroundHexes) ? backgroundHexes : [];
    const validBackgroundHexes = candidates.filter((value) => Boolean(hexToRgb(value)));
    if (validBackgroundHexes.length === 0) {
        return darkHex;
    }

    const darkRgb = hexToRgb(darkHex);
    const lightRgb = hexToRgb(lightHex);
    if (!darkRgb || !lightRgb) {
        return darkHex;
    }

    const darkLuminance = relativeLuminanceFromRgb(darkRgb);
    const lightLuminance = relativeLuminanceFromRgb(lightRgb);
    let minimumContrastWithDark = Number.POSITIVE_INFINITY;
    let minimumContrastWithLight = Number.POSITIVE_INFINITY;

    validBackgroundHexes.forEach((backgroundHex) => {
        const backgroundRgb = hexToRgb(backgroundHex);
        if (!backgroundRgb) {
            return;
        }
        const backgroundLuminance = relativeLuminanceFromRgb(backgroundRgb);
        const contrastWithDark = (Math.max(backgroundLuminance, darkLuminance) + 0.05)
            / (Math.min(backgroundLuminance, darkLuminance) + 0.05);
        const contrastWithLight = (Math.max(backgroundLuminance, lightLuminance) + 0.05)
            / (Math.min(backgroundLuminance, lightLuminance) + 0.05);

        minimumContrastWithDark = Math.min(minimumContrastWithDark, contrastWithDark);
        minimumContrastWithLight = Math.min(minimumContrastWithLight, contrastWithLight);
    });

    return minimumContrastWithDark >= minimumContrastWithLight ? darkHex : lightHex;
}

function rgbaFromHex(hexColor, opacity) {
    const rgb = hexToRgb(hexColor) || { r: 0, g: 0, b: 0 };
    const alpha = normalizeOpacity(opacity, 1);
    return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

function toOverlayGradientCss(overlayConfig) {
    const overlay = isPlainObject(overlayConfig)
        ? overlayConfig
        : DEFAULT_WALLPAPER_THEME_STYLES.dark.overlay;
    const angle = normalizeOverlayAngle(overlay.angle, 180);
    const topOpacity = normalizeOpacity(overlay.topOpacity, 0);
    const bottomOpacity = normalizeOpacity(overlay.bottomOpacity, 0);
    if (topOpacity <= 0 && bottomOpacity <= 0) {
        return 'none';
    }
    return `linear-gradient(${angle}deg, ${rgbaFromHex(overlay.topColor, overlay.topOpacity)}, ${rgbaFromHex(overlay.bottomColor, overlay.bottomOpacity)})`;
}

function adjustHexTone(hexColor, amount) {
    const baseHex = normalizeHexColor(hexColor, '#05E57B');
    const baseRgb = hexToRgb(baseHex) || { r: 5, g: 229, b: 123 };
    const shiftChannel = (channel) => clampNumber(channel + (amount * 255), 0, 255, channel);
    return rgbToHex({
        r: shiftChannel(baseRgb.r),
        g: shiftChannel(baseRgb.g),
        b: shiftChannel(baseRgb.b)
    });
}

function buildAccentPalette(primaryHex, theme) {
    const normalizedTheme = normalizeThemeMode(theme);
    const fallbackPrimary = DEFAULT_WALLPAPER_THEME_STYLES[normalizedTheme].primary;
    const baseHex = normalizeHexColor(primaryHex, fallbackPrimary);
    const baseRgb = hexToRgb(baseHex) || hexToRgb(fallbackPrimary);
    const isLightTheme = normalizedTheme === 'light';
    const white = { r: 255, g: 255, b: 255 };
    const black = { r: 0, g: 0, b: 0 };

    const accent1 = baseHex;
    const accent2 = adjustHexTone(baseHex, -0.12);
    const accent3 = adjustHexTone(baseHex, 0.04);
    const accent4 = adjustHexTone(baseHex, -0.18);
    const accentHover = adjustHexTone(baseHex, 0.12);

    const softAlpha = isLightTheme ? 0.16 : 0.15;
    const soft2Alpha = isLightTheme ? 0.16 : 0.15;
    const soft3Alpha = isLightTheme ? 0.21 : 0.2;
    const borderAlpha = isLightTheme ? 0.45 : 0.4;
    const outlineAlpha = isLightTheme ? 0.5 : 0.4;
    const searchBadgeText = rgbToHex(mixRgb(baseRgb, isLightTheme ? black : white, isLightTheme ? 0.72 : 0.6));
    const accentRgb = `${Math.round(baseRgb.r)}, ${Math.round(baseRgb.g)}, ${Math.round(baseRgb.b)}`;

    return {
        accent1,
        accent2,
        accent3,
        accent4,
        accentHover,
        accentRgb,
        accentSoft: `rgba(${baseRgb.r}, ${baseRgb.g}, ${baseRgb.b}, ${softAlpha})`,
        accentSoft2: `rgba(${baseRgb.r}, ${baseRgb.g}, ${baseRgb.b}, ${soft2Alpha})`,
        accentSoft3: `rgba(${baseRgb.r}, ${baseRgb.g}, ${baseRgb.b}, ${soft3Alpha})`,
        borderAccent: `rgba(${baseRgb.r}, ${baseRgb.g}, ${baseRgb.b}, ${borderAlpha})`,
        accentOutline: `rgba(${baseRgb.r}, ${baseRgb.g}, ${baseRgb.b}, ${outlineAlpha})`,
        searchPageBadgeBg: `rgba(${baseRgb.r}, ${baseRgb.g}, ${baseRgb.b}, ${isLightTheme ? 0.2 : 0.13})`,
        searchPageBadgeBorder: `rgba(${baseRgb.r}, ${baseRgb.g}, ${baseRgb.b}, ${isLightTheme ? 0.5 : 0.32})`,
        searchPageBadgeText: searchBadgeText
    };
}

function getExpiredOverlayThemeBaseTokens(theme) {
    const normalizedTheme = normalizeThemeMode(theme);
    if (normalizedTheme === 'light') {
        return {
            overlayBg: 'rgba(245, 244, 240, 0.92)',
            bodyBackdrop: 'linear-gradient(135deg, #EEF4FB 0%, #DDE9F6 100%)',
            cardBg: 'rgba(15, 23, 42, 0.04)',
            cardBgHover: 'rgba(15, 23, 42, 0.07)',
            borderMuted: 'rgba(15, 23, 42, 0.1)',
            borderStrong: 'rgba(15, 23, 42, 0.2)',
            textPrimary: '#141E2D',
            textSecondary: '#273D57',
            textMuted: '#607892',
            textInverse: '#F4FBF8',
            featureColor: 'rgba(20, 30, 45, 0.76)',
            logoutBg: 'rgba(15, 23, 42, 0.06)',
            logoutBgHover: 'rgba(15, 23, 42, 0.1)',
            logoutColor: 'rgba(20, 30, 45, 0.82)',
            logoutColorHover: '#141E2D',
            deleteColor: '#607892',
            deleteHover: '#141E2D'
        };
    }

    return {
        overlayBg: 'rgba(12, 16, 26, 0.94)',
        bodyBackdrop: 'linear-gradient(135deg, #1A1A2E 0%, #16213E 100%)',
        cardBg: 'rgba(255, 255, 255, 0.05)',
        cardBgHover: 'rgba(255, 255, 255, 0.07)',
        borderMuted: 'rgba(255, 255, 255, 0.08)',
        borderStrong: 'rgba(255, 255, 255, 0.15)',
        textPrimary: '#FFFFFF',
        textSecondary: '#B8C5D1',
        textMuted: '#6A7A8A',
        textInverse: '#1A1F2E',
        featureColor: 'rgba(255, 255, 255, 0.75)',
        logoutBg: 'rgba(255, 255, 255, 0.06)',
        logoutBgHover: 'rgba(255, 255, 255, 0.1)',
        logoutColor: 'rgba(255, 255, 255, 0.86)',
        logoutColorHover: '#FFFFFF',
        deleteColor: '#6A7A8A',
        deleteHover: 'rgba(255, 255, 255, 0.75)'
    };
}

function clearExpiredOverlayTheme() {
    const overlay = document.getElementById('expiredOverlay');
    if (overlay) {
        [
            '--ll-expired-overlay-bg',
            '--ll-expired-title-color',
            '--ll-expired-label-color',
            '--ll-expired-text-primary',
            '--ll-expired-text-secondary',
            '--ll-expired-text-muted',
            '--ll-expired-text-inverse',
            '--ll-expired-card-bg',
            '--ll-expired-card-bg-hover',
            '--ll-expired-card-border',
            '--ll-expired-card-border-strong',
            '--ll-expired-border-accent',
            '--ll-expired-border-accent-strong',
            '--ll-expired-accent-outline',
            '--ll-expired-accent-1',
            '--ll-expired-accent-3',
            '--ll-expired-accent-hover',
            '--ll-expired-recommended-bg',
            '--ll-expired-recommended-shadow',
            '--ll-expired-feature-color',
            '--ll-expired-logout-bg',
            '--ll-expired-logout-color',
            '--ll-expired-logout-border',
            '--ll-expired-logout-bg-hover',
            '--ll-expired-logout-color-hover',
            '--ll-expired-delete-color',
            '--ll-expired-delete-hover'
        ].forEach((propertyName) => {
            overlay.style.removeProperty(propertyName);
        });
    }

    if (document.body?.style) {
        document.body.style.removeProperty('--ll-expired-body-bg');
    }
}

function applyExpiredOverlayTheme() {
    const overlay = document.getElementById('expiredOverlay');
    if (!overlay) {
        return null;
    }

    const defaultSnapshot = buildLoggedOutDefaultVisualSnapshot();
    const themeMode = normalizeThemeMode(defaultSnapshot?.themeMode);
    const themeStyle = normalizeWallpaperStyleConfig(
        defaultSnapshot?.style,
        getWallpaperThemeDefaultForTheme(themeMode)
    );
    const accentPalette = buildAccentPalette(themeStyle.primary, themeMode);
    const baseTokens = getExpiredOverlayThemeBaseTokens(themeMode);
    const recommendedBackground = themeMode === 'light'
        ? `linear-gradient(145deg, rgba(${accentPalette.accentRgb}, 0.16), rgba(${accentPalette.accentRgb}, 0.05))`
        : `linear-gradient(145deg, rgba(${accentPalette.accentRgb}, 0.08), rgba(${accentPalette.accentRgb}, 0.02))`;
    const recommendedShadow = themeMode === 'light'
        ? `rgba(${accentPalette.accentRgb}, 0.18)`
        : `rgba(${accentPalette.accentRgb}, 0.12)`;

    overlay.style.setProperty('--ll-expired-overlay-bg', baseTokens.overlayBg);
    overlay.style.setProperty('--ll-expired-title-color', baseTokens.textPrimary);
    overlay.style.setProperty('--ll-expired-label-color', accentPalette.accent1);
    overlay.style.setProperty('--ll-expired-text-primary', baseTokens.textPrimary);
    overlay.style.setProperty('--ll-expired-text-secondary', baseTokens.textSecondary);
    overlay.style.setProperty('--ll-expired-text-muted', baseTokens.textMuted);
    overlay.style.setProperty('--ll-expired-text-inverse', baseTokens.textInverse);
    overlay.style.setProperty('--ll-expired-card-bg', baseTokens.cardBg);
    overlay.style.setProperty('--ll-expired-card-bg-hover', baseTokens.cardBgHover);
    overlay.style.setProperty('--ll-expired-card-border', baseTokens.borderMuted);
    overlay.style.setProperty('--ll-expired-card-border-strong', baseTokens.borderStrong);
    overlay.style.setProperty('--ll-expired-border-accent', accentPalette.borderAccent);
    overlay.style.setProperty(
        '--ll-expired-border-accent-strong',
        themeMode === 'light'
            ? `rgba(${accentPalette.accentRgb}, 0.5)`
            : `rgba(${accentPalette.accentRgb}, 0.45)`
    );
    overlay.style.setProperty('--ll-expired-accent-outline', accentPalette.accentOutline);
    overlay.style.setProperty('--ll-expired-accent-1', accentPalette.accent1);
    overlay.style.setProperty('--ll-expired-accent-3', accentPalette.accent3);
    overlay.style.setProperty('--ll-expired-accent-hover', accentPalette.accentHover);
    overlay.style.setProperty('--ll-expired-recommended-bg', recommendedBackground);
    overlay.style.setProperty('--ll-expired-recommended-shadow', recommendedShadow);
    overlay.style.setProperty('--ll-expired-feature-color', baseTokens.featureColor);
    overlay.style.setProperty('--ll-expired-logout-bg', baseTokens.logoutBg);
    overlay.style.setProperty('--ll-expired-logout-color', baseTokens.logoutColor);
    overlay.style.setProperty('--ll-expired-logout-border', baseTokens.borderMuted);
    overlay.style.setProperty('--ll-expired-logout-bg-hover', baseTokens.logoutBgHover);
    overlay.style.setProperty('--ll-expired-logout-color-hover', baseTokens.logoutColorHover);
    overlay.style.setProperty('--ll-expired-delete-color', baseTokens.deleteColor);
    overlay.style.setProperty('--ll-expired-delete-hover', baseTokens.deleteHover);

    if (document.body?.style) {
        document.body.style.setProperty('--ll-expired-body-bg', baseTokens.bodyBackdrop);
    }

    return {
        themeMode,
        primary: accentPalette.accent1
    };
}

function formatWallpaperLabelFromFile(filePath) {
    if (typeof filePath !== 'string' || !filePath.trim()) {
        return 'Wallpaper';
    }
    const fileName = filePath.split('/').pop() || '';
    const withoutExt = fileName.replace(/\.[^.]+$/, '');
    const normalized = withoutExt
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (!normalized) return 'Wallpaper';
    return normalized.replace(/\b\w/g, char => char.toUpperCase());
}

function normalizeWallpaperCloudInstallEntry(rawEntry) {
    if (!isPlainObject(rawEntry)) return null;

    const theme = normalizeThemeMode(rawEntry.theme);
    const sourceUrl = normalizeWallpaperPathForTheme(
        theme,
        rawEntry.sourceUrl || rawEntry.file || rawEntry.assetUrl || null
    );
    if (!isHostedWallpaperUrl(sourceUrl)) {
        return null;
    }

    const remoteId = typeof rawEntry.remoteId === 'string' && rawEntry.remoteId.trim()
        ? rawEntry.remoteId.trim()
        : (typeof rawEntry.id === 'string' && rawEntry.id.trim() ? rawEntry.id.trim() : null);
    const recordId = normalizeInstalledWallpaperRecordId(
        rawEntry.recordId || rawEntry.localId || rawEntry.installedId || rawEntry.id
    ) || createInstalledWallpaperRecordId({
        theme,
        remoteId,
        sourceUrl
    });

    return {
        id: recordId,
        theme,
        remoteId,
        sourceUrl,
        label: typeof rawEntry.label === 'string' && rawEntry.label.trim()
            ? rawEntry.label.trim()
            : formatWallpaperLabelFromFile(sourceUrl),
        style: normalizeWallpaperStyleConfig(
            rawEntry.style,
            getWallpaperThemeDefaultForTheme(theme)
        ),
        thumbnailUrl: typeof rawEntry.thumbnailUrl === 'string' && rawEntry.thumbnailUrl.trim()
            ? rawEntry.thumbnailUrl.trim()
            : null,
        version: typeof rawEntry.version === 'string' && rawEntry.version.trim()
            ? rawEntry.version.trim()
            : null,
        archivedAt: normalizeWallpaperArchivedAt(rawEntry.archivedAt),
        installedAt: typeof rawEntry.installedAt === 'string' && rawEntry.installedAt.trim()
            ? rawEntry.installedAt.trim()
            : null,
        updatedAt: typeof rawEntry.updatedAt === 'string' && rawEntry.updatedAt.trim()
            ? rawEntry.updatedAt.trim()
            : null
    };
}

function normalizeWallpaperCloudSyncState(rawState, userIdHint = wallpaperAccountScopeUserId) {
    const normalizedUserHint = normalizeWallpaperSyncUserId(userIdHint);
    const source = isPlainObject(rawState) ? rawState : {};
    const sourceUserId = normalizeWallpaperSyncUserId(source.userId);

    if (normalizedUserHint && sourceUserId && sourceUserId !== normalizedUserHint) {
        return createEmptyWallpaperCloudSyncState(normalizedUserHint);
    }

    const normalizedState = createEmptyWallpaperCloudSyncState(sourceUserId || normalizedUserHint || null);
    normalizedState.hasConfiguredPreferences = source.hasConfiguredPreferences === true;
    normalizedState.themeMode = (source.themeMode === 'dark' || source.themeMode === 'light')
        ? source.themeMode
        : null;

    const rawSelection = isPlainObject(source.selectionByTheme) ? source.selectionByTheme : {};
    const rawSelectionPresence = isPlainObject(source.selectionPresenceByTheme)
        ? source.selectionPresenceByTheme
        : null;
    normalizedState.selectionByTheme = {
        dark: typeof rawSelection.dark === 'string' && rawSelection.dark.trim()
            ? rawSelection.dark.trim()
            : null,
        light: typeof rawSelection.light === 'string' && rawSelection.light.trim()
            ? rawSelection.light.trim()
            : null
    };
    normalizedState.selectionPresenceByTheme = {
        dark: rawSelectionPresence
            ? rawSelectionPresence.dark === true
            : Object.prototype.hasOwnProperty.call(rawSelection, 'dark'),
        light: rawSelectionPresence
            ? rawSelectionPresence.light === true
            : Object.prototype.hasOwnProperty.call(rawSelection, 'light')
    };

    const installs = Array.isArray(source.installedWallpapers)
        ? source.installedWallpapers
        : [];
    const seenRecordIds = new Set();
    normalizedState.installedWallpapers = installs.map((entry) => normalizeWallpaperCloudInstallEntry(entry))
        .filter((entry) => {
            if (!entry || seenRecordIds.has(entry.id)) return false;
            seenRecordIds.add(entry.id);
            return true;
        })
        .sort((left, right) => {
            const leftTime = Date.parse(left?.updatedAt || 0);
            const rightTime = Date.parse(right?.updatedAt || 0);
            return rightTime - leftTime;
        });

    normalizedState.updatedAt = typeof source.updatedAt === 'string' && source.updatedAt.trim()
        ? source.updatedAt.trim()
        : null;
    normalizedState.fetchedAt = typeof source.fetchedAt === 'string' && source.fetchedAt.trim()
        ? source.fetchedAt.trim()
        : null;
    normalizedState.hasConfiguredPreferences = normalizedState.hasConfiguredPreferences
        || normalizedState.themeMode === 'dark'
        || normalizedState.themeMode === 'light'
        || normalizedState.selectionPresenceByTheme.dark === true
        || normalizedState.selectionPresenceByTheme.light === true
        || normalizedState.installedWallpapers.length > 0
        || normalizedState.updatedAt !== null;
    return normalizedState;
}

function buildWallpaperCloudSyncStateFromPreferencePayload(userId, payload) {
    const normalizedUserId = normalizeWallpaperSyncUserId(userId);
    if (!normalizedUserId) {
        return createEmptyWallpaperCloudSyncState(null);
    }

    const sourcePayload = payload && typeof payload === 'object' ? payload : {};
    const hasExplicitSelectionPayload = sourcePayload.wallpaper_selection && typeof sourcePayload.wallpaper_selection === 'object';
    const rawSelection = hasExplicitSelectionPayload
        ? sourcePayload.wallpaper_selection
        : {};
    const updatedAt = (typeof sourcePayload.wallpaper_preferences_updated_at === 'string' && sourcePayload.wallpaper_preferences_updated_at.trim())
        ? sourcePayload.wallpaper_preferences_updated_at.trim()
        : new Date().toISOString();

    return {
        userId: normalizedUserId,
        hasConfiguredPreferences: true,
        themeMode: (sourcePayload.theme_mode === 'dark' || sourcePayload.theme_mode === 'light')
            ? sourcePayload.theme_mode
            : null,
        selectionByTheme: {
            dark: typeof rawSelection.dark === 'string' && rawSelection.dark.trim()
                ? rawSelection.dark.trim()
                : null,
            light: typeof rawSelection.light === 'string' && rawSelection.light.trim()
                ? rawSelection.light.trim()
                : null
        },
        selectionPresenceByTheme: {
            dark: hasExplicitSelectionPayload ? Object.prototype.hasOwnProperty.call(rawSelection, 'dark') : false,
            light: hasExplicitSelectionPayload ? Object.prototype.hasOwnProperty.call(rawSelection, 'light') : false
        },
        installedWallpapers: Array.isArray(sourcePayload.wallpaper_installs)
            ? sourcePayload.wallpaper_installs
            : [],
        updatedAt,
        fetchedAt: new Date().toISOString()
    };
}

async function persistWallpaperCloudSyncStateFromPreferencePayload(userId, payload) {
    const optimisticState = buildWallpaperCloudSyncStateFromPreferencePayload(userId, payload);
    const normalizedState = await importWallpaperCloudManifestIntoDatabase(optimisticState, {
        broadcast: false
    });

    if (!(typeof chrome !== 'undefined' && chrome.storage?.local?.set)) {
        return normalizedState;
    }

    try {
        await chrome.storage.local.set({
            [WALLPAPER_CLOUD_SYNC_STATE_STORAGE_KEY]: normalizedState
        });
    } catch (error) {
        console.warn('Failed to persist optimistic wallpaper cloud sync state locally:', error);
    }

    return normalizedState;
}

function getWallpaperCloudManifestEntriesForUser(userId = wallpaperAccountScopeUserId) {
    const normalizedUserId = normalizeWallpaperSyncUserId(userId);
    if (!normalizedUserId) return [];
    if (!wallpaperCloudSyncState || wallpaperCloudSyncState.userId !== normalizedUserId) {
        return [];
    }
    return Array.isArray(wallpaperCloudSyncState.installedWallpapers)
        ? wallpaperCloudSyncState.installedWallpapers
        : [];
}

function getWallpaperCloudManifestLookupForUser(userId = wallpaperAccountScopeUserId) {
    const ids = new Set();
    const sourceUrls = new Set();
    const remoteIdsByTheme = {
        dark: new Set(),
        light: new Set()
    };

    for (const entry of getWallpaperCloudManifestEntriesForUser(userId)) {
        ids.add(entry.id);
        if (entry.sourceUrl) {
            sourceUrls.add(entry.sourceUrl);
        }
        if (entry.remoteId) {
            remoteIdsByTheme[entry.theme]?.add(entry.remoteId);
        }
    }

    return {
        ids,
        sourceUrls,
        remoteIdsByTheme
    };
}

function getSelectedInstalledWallpaperRecordIds(selection = wallpaperSelectionByTheme) {
    const selectedRecordIds = new Set();
    ['dark', 'light'].forEach((theme) => {
        const parsed = parseInstalledWallpaperRef(selection?.[theme]);
        if (parsed?.recordId) {
            selectedRecordIds.add(parsed.recordId);
        }
    });
    return selectedRecordIds;
}

function normalizeInstalledWallpaperRecordId(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function getInstalledWallpaperTimestampMs(value, fields = []) {
    const source = value && typeof value === 'object' ? value : {};
    for (const field of fields) {
        const parsed = Date.parse(source?.[field] || '');
        if (Number.isFinite(parsed) && parsed > 0) {
            return parsed;
        }
    }
    return 0;
}

function normalizeWallpaperArchivedAt(value) {
    return (typeof value === 'string' && value.trim())
        ? value.trim()
        : null;
}

function compareInstalledWallpaperFreshness(left, right) {
    const leftTime = getInstalledWallpaperTimestampMs(left, ['updatedAt', 'installedAt']);
    const rightTime = getInstalledWallpaperTimestampMs(right, ['updatedAt', 'installedAt']);
    if (leftTime !== rightTime) {
        return rightTime - leftTime;
    }

    const leftInstalledTime = getInstalledWallpaperTimestampMs(left, ['installedAt']);
    const rightInstalledTime = getInstalledWallpaperTimestampMs(right, ['installedAt']);
    if (leftInstalledTime !== rightInstalledTime) {
        return rightInstalledTime - leftInstalledTime;
    }

    const leftId = normalizeInstalledWallpaperRecordId(left?.id || left?.recordId || '');
    const rightId = normalizeInstalledWallpaperRecordId(right?.id || right?.recordId || '');
    return leftId.localeCompare(rightId);
}

function compareInstalledWallpaperDisplayOrder(left, right) {
    const leftInstalledTime = getInstalledWallpaperTimestampMs(left, ['installedAt', 'updatedAt']);
    const rightInstalledTime = getInstalledWallpaperTimestampMs(right, ['installedAt', 'updatedAt']);
    if (leftInstalledTime !== rightInstalledTime) {
        return rightInstalledTime - leftInstalledTime;
    }

    const leftLabel = typeof left?.label === 'string' ? left.label.trim() : '';
    const rightLabel = typeof right?.label === 'string' ? right.label.trim() : '';
    if (leftLabel !== rightLabel) {
        return leftLabel.localeCompare(rightLabel);
    }

    const leftId = normalizeInstalledWallpaperRecordId(left?.id || left?.recordId || '');
    const rightId = normalizeInstalledWallpaperRecordId(right?.id || right?.recordId || '');
    return leftId.localeCompare(rightId);
}

function createInstalledWallpaperRef(theme, wallpaperId) {
    const normalizedTheme = normalizeThemeMode(theme);
    const normalizedId = normalizeInstalledWallpaperRecordId(wallpaperId);
    if (!normalizedId) return null;
    return `${INSTALLED_WALLPAPER_SOURCE_PREFIX}${normalizedTheme}/${encodeURIComponent(normalizedId)}`;
}

function parseInstalledWallpaperRef(filePath) {
    if (typeof filePath !== 'string') return null;
    const raw = filePath.trim();
    if (!raw.startsWith(INSTALLED_WALLPAPER_SOURCE_PREFIX)) return null;

    try {
        const parsedUrl = new URL(raw);
        if (parsedUrl.protocol !== 'lumilist-installed:') return null;
        const theme = normalizeThemeMode(parsedUrl.hostname);
        const recordId = normalizeInstalledWallpaperRecordId(
            decodeURIComponent(parsedUrl.pathname.replace(/^\/+/, ''))
        );
        if (!recordId) return null;
        return {
            theme,
            recordId,
            ref: createInstalledWallpaperRef(theme, recordId)
        };
    } catch (error) {
        return null;
    }
}

function isInstalledWallpaperRef(filePath) {
    return Boolean(parseInstalledWallpaperRef(filePath));
}

function computeStableWallpaperIdHash(value) {
    const source = typeof value === 'string' ? value : String(value ?? '');
    let hash = 2166136261;
    for (let index = 0; index < source.length; index += 1) {
        hash ^= source.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

function createInstalledWallpaperRecordId({ theme, remoteId = null, sourceUrl = null }) {
    const normalizedTheme = normalizeThemeMode(theme);
    const normalizedRemoteId = typeof remoteId === 'string' ? remoteId.trim() : '';
    if (normalizedRemoteId) {
        return `gallery:${normalizedTheme}:${normalizedRemoteId}`;
    }

    const normalizedSourceUrl = typeof sourceUrl === 'string' ? sourceUrl.trim() : '';
    if (normalizedSourceUrl) {
        return `hosted:${normalizedTheme}:${computeStableWallpaperIdHash(normalizedSourceUrl)}`;
    }

    return `installed:${normalizedTheme}:${generateId()}`;
}

function findExistingInstalledWallpaperRecordId({ theme, remoteId = null, sourceUrl = null }) {
    const normalizedTheme = normalizeThemeMode(theme);
    const normalizedRemoteId = typeof remoteId === 'string' ? remoteId.trim() : '';
    const normalizedSourceUrl = typeof sourceUrl === 'string' ? sourceUrl.trim() : '';

    for (const record of installedWallpaperRecordsByRef.values()) {
        if (normalizeThemeMode(record?.theme) !== normalizedTheme) continue;
        if (normalizedRemoteId && record?.remoteId === normalizedRemoteId) {
            return normalizeInstalledWallpaperRecordId(record?.id) || null;
        }
        if (normalizedSourceUrl && record?.sourceUrl === normalizedSourceUrl) {
            return normalizeInstalledWallpaperRecordId(record?.id) || null;
        }
    }

    return null;
}

function toHostedWallpaperUrl(relativePath) {
    const normalizedRelative = typeof relativePath === 'string'
        ? relativePath.trim().replace(/^\/+/, '').replace(/^wallpaper\//, '')
        : '';
    if (!normalizedRelative) return null;
    const encoded = normalizedRelative
        .split('/')
        .filter(Boolean)
        .map(segment => encodeURIComponent(segment))
        .join('/');
    return encoded ? `${WALLPAPER_REMOTE_STORAGE_PREFIX}${encoded}` : null;
}

function isHostedWallpaperUrl(filePath) {
    return typeof filePath === 'string'
        && filePath.startsWith(WALLPAPER_REMOTE_STORAGE_PREFIX);
}

function getInstalledWallpaperRecordByRef(filePath) {
    const parsedRef = parseInstalledWallpaperRef(filePath);
    if (!parsedRef) return null;
    return installedWallpaperRecordsByRef.get(parsedRef.ref) || null;
}

function isLocalUserWallpaperRecord(rawRecord) {
    return typeof rawRecord?.sourceType === 'string'
        && rawRecord.sourceType.trim() === LOCAL_USER_WALLPAPER_SOURCE_TYPE;
}

function isLocalOnlyInstalledWallpaperRef(filePath) {
    const normalizedPath = typeof filePath === 'string' ? filePath.trim() : '';
    if (!isInstalledWallpaperRef(normalizedPath)) {
        return false;
    }
    return isLocalUserWallpaperRecord(getInstalledWallpaperRecordByRef(normalizedPath));
}

function buildSyncSafeWallpaperSelection(rawSelection, fallbackSelection = null) {
    const source = rawSelection && typeof rawSelection === 'object' ? rawSelection : {};
    const fallback = fallbackSelection && typeof fallbackSelection === 'object' ? fallbackSelection : {};
    const resolved = createEmptyWallpaperSelection();

    ['dark', 'light'].forEach((theme) => {
        const normalizedSelection = normalizeWallpaperPathForTheme(theme, source[theme]);
        if (normalizedSelection && isLocalOnlyInstalledWallpaperRef(normalizedSelection)) {
            const fallbackSelectionForTheme = normalizeWallpaperPathForTheme(theme, fallback[theme]);
            resolved[theme] = (fallbackSelectionForTheme && !isLocalOnlyInstalledWallpaperRef(fallbackSelectionForTheme))
                ? fallbackSelectionForTheme
                : null;
            return;
        }

        resolved[theme] = normalizedSelection ?? null;
    });

    return resolved;
}

function findInstalledWallpaperRefBySourceUrl(theme, sourceUrl) {
    const normalizedTheme = normalizeThemeMode(theme);
    const normalizedSourceUrl = normalizeWallpaperPathForTheme(normalizedTheme, sourceUrl);
    if (!normalizedSourceUrl) return null;

    for (const [installedRef, record] of installedWallpaperRecordsByRef.entries()) {
        if (normalizeThemeMode(record?.theme) !== normalizedTheme) continue;
        if (record?.sourceUrl === normalizedSourceUrl) {
            return installedRef;
        }
    }

    return null;
}

function findInstalledWallpaperRefByRemoteIdentity(theme, {
    remoteId = null,
    sourceUrl = null
} = {}) {
    const normalizedTheme = normalizeThemeMode(theme);
    const recordId = findExistingInstalledWallpaperRecordId({
        theme: normalizedTheme,
        remoteId,
        sourceUrl: normalizeWallpaperPathForTheme(normalizedTheme, sourceUrl)
    });
    return recordId ? createInstalledWallpaperRef(normalizedTheme, recordId) : null;
}

function getWallpaperCanonicalSourceIdentity(theme, candidate) {
    const normalizedTheme = normalizeThemeMode(theme);
    const source = isPlainObject(candidate) ? candidate : null;
    const normalizedRemoteId = typeof source?.remoteId === 'string' && source.remoteId.trim()
        ? source.remoteId.trim()
        : '';
    const normalizedRecordId = normalizeInstalledWallpaperRecordId(
        source?.id || source?.recordId || null
    );

    const normalizedPath = typeof candidate === 'string'
        ? normalizeWallpaperPathForTheme(normalizedTheme, candidate)
        : normalizeWallpaperPathForTheme(normalizedTheme, source?.sourceUrl || source?.file || null);

    if (isInstalledWallpaperRef(normalizedPath)) {
        const installedRecord = getInstalledWallpaperRecordByRef(normalizedPath);
        const normalizedInstalledSourceUrl = normalizeWallpaperPathForTheme(
            normalizedTheme,
            installedRecord?.sourceUrl || null
        );
        if (isHostedWallpaperUrl(normalizedInstalledSourceUrl)) {
            return `source:${normalizedTheme}:${normalizedInstalledSourceUrl}`;
        }

        const installedRemoteId = typeof installedRecord?.remoteId === 'string' && installedRecord.remoteId.trim()
            ? installedRecord.remoteId.trim()
            : '';
        if (installedRemoteId) {
            return `remote:${normalizedTheme}:${installedRemoteId}`;
        }

        const parsedRef = parseInstalledWallpaperRef(normalizedPath);
        if (parsedRef?.recordId) {
            return `record:${normalizedTheme}:${parsedRef.recordId}`;
        }
    }

    if (isHostedWallpaperUrl(normalizedPath)) {
        return `source:${normalizedTheme}:${normalizedPath}`;
    }

    if (typeof normalizedPath === 'string' && normalizedPath.startsWith(`wallpaper/${normalizedTheme}/`)) {
        const hostedEquivalent = toHostedWallpaperUrl(normalizedPath);
        return hostedEquivalent
            ? `source:${normalizedTheme}:${hostedEquivalent}`
            : `bundled:${normalizedTheme}:${normalizedPath}`;
    }

    if (normalizedRemoteId) {
        return `remote:${normalizedTheme}:${normalizedRemoteId}`;
    }

    if (normalizedRecordId) {
        return `record:${normalizedTheme}:${normalizedRecordId}`;
    }

    return null;
}

function findBundledWallpaperEquivalentEntry(theme, candidate) {
    const normalizedTheme = normalizeThemeMode(theme);
    const candidateIdentity = getWallpaperCanonicalSourceIdentity(normalizedTheme, candidate);
    if (!candidateIdentity) return null;

    const bundledEntries = Array.isArray(bundledWallpaperCatalogByTheme[normalizedTheme])
        ? bundledWallpaperCatalogByTheme[normalizedTheme]
        : [];

    for (const entry of bundledEntries) {
        if (getWallpaperCanonicalSourceIdentity(normalizedTheme, entry?.file || null) === candidateIdentity) {
            return entry;
        }
    }

    return null;
}

function findEquivalentWallpaperCatalogEntry(theme, candidate) {
    const normalizedTheme = normalizeThemeMode(theme);
    const candidateIdentity = getWallpaperCanonicalSourceIdentity(normalizedTheme, candidate);
    if (!candidateIdentity) return null;

    const catalogEntries = getWallpaperCatalogEntriesForTheme(normalizedTheme);
    for (const entry of catalogEntries) {
        if (getWallpaperCanonicalSourceIdentity(normalizedTheme, entry?.file || null) === candidateIdentity) {
            return entry;
        }
    }

    return null;
}

function getInstalledWallpaperObjectUrl(filePath) {
    const parsedRef = parseInstalledWallpaperRef(filePath);
    if (!parsedRef) return null;

    const existingObjectUrl = installedWallpaperObjectUrlsByRef.get(parsedRef.ref);
    if (typeof existingObjectUrl === 'string' && existingObjectUrl) {
        return existingObjectUrl;
    }

    const record = installedWallpaperRecordsByRef.get(parsedRef.ref);
    if (!(record?.imageBlob instanceof Blob)) {
        return null;
    }

    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
        return null;
    }

    try {
        const objectUrl = URL.createObjectURL(record.imageBlob);
        installedWallpaperObjectUrlsByRef.set(parsedRef.ref, objectUrl);
        return objectUrl;
    } catch (error) {
        console.warn('Failed to create installed wallpaper object URL:', error);
        return null;
    }
}

function revokeInstalledWallpaperObjectUrl(filePath) {
    const parsedRef = parseInstalledWallpaperRef(filePath);
    if (!parsedRef) return;

    const existingObjectUrl = installedWallpaperObjectUrlsByRef.get(parsedRef.ref);
    if (typeof existingObjectUrl === 'string' && existingObjectUrl && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
        try {
            URL.revokeObjectURL(existingObjectUrl);
        } catch (error) {
            console.warn('Failed to revoke installed wallpaper object URL:', error);
        }
    }
    installedWallpaperObjectUrlsByRef.delete(parsedRef.ref);
}

function shouldKeepInstalledWallpaperObjectUrl(existingRecord, nextRecord) {
    if (!(existingRecord?.imageBlob instanceof Blob) || !(nextRecord?.imageBlob instanceof Blob)) {
        return false;
    }

    return normalizeThemeMode(existingRecord?.theme) === normalizeThemeMode(nextRecord?.theme)
        && (existingRecord?.sourceUrl || null) === (nextRecord?.sourceUrl || null)
        && (existingRecord?.remoteId || null) === (nextRecord?.remoteId || null)
        && (existingRecord?.version || null) === (nextRecord?.version || null)
        && (existingRecord?.mimeType || null) === (nextRecord?.mimeType || null)
        && Number(existingRecord?.byteSize || 0) === Number(nextRecord?.byteSize || 0);
}

function revokeStaleInstalledWallpaperObjectUrls(nextRecordMap) {
    for (const [ref, existingRecord] of installedWallpaperRecordsByRef.entries()) {
        const nextRecord = nextRecordMap.get(ref);
        if (!nextRecord) {
            revokeInstalledWallpaperObjectUrl(ref);
            continue;
        }

        if (shouldKeepInstalledWallpaperObjectUrl(existingRecord, nextRecord)) {
            continue;
        }

        if (
            nextRecord.updatedAt !== existingRecord?.updatedAt
            || normalizeThemeMode(nextRecord?.theme) !== normalizeThemeMode(existingRecord?.theme)
            || (nextRecord?.sourceUrl || null) !== (existingRecord?.sourceUrl || null)
            || (nextRecord?.remoteId || null) !== (existingRecord?.remoteId || null)
            || (nextRecord?.version || null) !== (existingRecord?.version || null)
            || (nextRecord?.mimeType || null) !== (existingRecord?.mimeType || null)
            || Number(nextRecord?.byteSize || 0) !== Number(existingRecord?.byteSize || 0)
            || Boolean(nextRecord?.imageBlob instanceof Blob) !== Boolean(existingRecord?.imageBlob instanceof Blob)
        ) {
            revokeInstalledWallpaperObjectUrl(ref);
        }
    }
}

function createEmptyWallpaperBinaryCache() {
    return { dark: null, light: null };
}

function readCachedWallpaperBinaryCache() {
    try {
        const raw = localStorage.getItem(WALLPAPER_BINARY_CACHE_LOCAL_KEY);
        if (!raw) return createEmptyWallpaperBinaryCache();
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object'
            ? {
                dark: parsed.dark || null,
                light: parsed.light || null
            }
            : createEmptyWallpaperBinaryCache();
    } catch (error) {
        return createEmptyWallpaperBinaryCache();
    }
}

function getCachedWallpaperBinaryDataUrl(theme, sourceUrl) {
    const normalizedTheme = normalizeThemeMode(theme);
    const cache = readCachedWallpaperBinaryCache();
    const entry = cache[normalizedTheme];
    if (!entry || entry.source !== sourceUrl || typeof entry.dataUrl !== 'string') {
        return null;
    }
    return entry.dataUrl;
}

function hasCachedWallpaperBinary(theme, sourceUrl) {
    return Boolean(getCachedWallpaperBinaryDataUrl(theme, sourceUrl));
}

function hasCachedHostedWallpaperBinary(theme, sourceUrl) {
    return hasCachedWallpaperBinary(theme, sourceUrl);
}

function writeHostedWallpaperBootCache(theme, _sourceUrl, _dataUrl) {
    const normalizedTheme = normalizeThemeMode(theme);
    const bootSourceKey = `${WALLPAPER_BOOT_SOURCE_CACHE_PREFIX}${normalizedTheme}`;
    const bootBinaryKey = `${WALLPAPER_BOOT_BINARY_CACHE_PREFIX}${normalizedTheme}`;
    try {
        // The old split boot cache duplicated large wallpaper binaries in localStorage.
        // Once quota pressure hit, it could leave a new source key paired with a stale
        // binary key on the next startup. Keep the canonical binary cache only and
        // clean up the legacy split keys opportunistically.
        if (localStorage.getItem(bootSourceKey) !== null) {
            localStorage.removeItem(bootSourceKey);
        }
        if (localStorage.getItem(bootBinaryKey) !== null) {
            localStorage.removeItem(bootBinaryKey);
        }
    } catch (error) {
        console.warn('Failed to clear legacy wallpaper boot cache locally:', error);
    }
}

function writeWallpaperBootStyleCache(theme, style) {
    const normalizedTheme = normalizeThemeMode(theme);
    try {
        localStorage.setItem(
            `${WALLPAPER_BOOT_STYLE_CACHE_PREFIX}${normalizedTheme}`,
            JSON.stringify(style)
        );
    } catch (error) {
        console.warn('Failed to write wallpaper boot style cache locally:', error);
    }
}

function writeCachedWallpaperBinaryDataUrl(theme, sourceUrl, dataUrl) {
    const normalizedTheme = normalizeThemeMode(theme);
    const cache = readCachedWallpaperBinaryCache();
    cache[normalizedTheme] = {
        source: sourceUrl,
        dataUrl,
        cachedAt: new Date().toISOString()
    };

    try {
        localStorage.setItem(WALLPAPER_BINARY_CACHE_LOCAL_KEY, JSON.stringify(cache));
        writeHostedWallpaperBootCache(normalizedTheme, sourceUrl, dataUrl);
        return true;
    } catch (error) {
        console.warn('Failed to cache wallpaper binary locally:', error);
        return false;
    }
}

function clearCachedWallpaperBinaryDataUrl(theme, sourceUrl) {
    const normalizedTheme = normalizeThemeMode(theme);
    const normalizedSource = normalizeWallpaperPathForTheme(normalizedTheme, sourceUrl);
    if (!normalizedSource) return false;

    let didClear = false;

    try {
        const cache = readCachedWallpaperBinaryCache();
        if (cache?.[normalizedTheme]?.source === normalizedSource) {
            cache[normalizedTheme] = null;
            localStorage.setItem(WALLPAPER_BINARY_CACHE_LOCAL_KEY, JSON.stringify(cache));
            didClear = true;
        }
    } catch (error) {
        console.warn('Failed to clear wallpaper binary cache locally:', error);
    }

    try {
        const bootSourceKey = `${WALLPAPER_BOOT_SOURCE_CACHE_PREFIX}${normalizedTheme}`;
        const bootBinaryKey = `${WALLPAPER_BOOT_BINARY_CACHE_PREFIX}${normalizedTheme}`;
        if (localStorage.getItem(bootSourceKey) === normalizedSource) {
            localStorage.removeItem(bootSourceKey);
            localStorage.removeItem(bootBinaryKey);
            didClear = true;
        }
    } catch (error) {
        console.warn('Failed to clear wallpaper boot cache locally:', error);
    }

    return didClear;
}

function normalizeWallpaperPathForTheme(theme, filePath) {
    if (typeof filePath !== 'string') return null;
    const normalizedTheme = normalizeThemeMode(theme);
    const raw = filePath.trim();
    const installedRef = parseInstalledWallpaperRef(raw);
    if (installedRef) {
        return installedRef.theme === normalizedTheme ? installedRef.ref : null;
    }

    const trimmed = raw.replace(/^\/+/, '');
    if (trimmed.startsWith(`wallpaper/${normalizedTheme}/`) && WALLPAPER_FILE_PATTERN.test(trimmed)) {
        return trimmed;
    }

    try {
        const candidateUrl = new URL(raw);
        if (!candidateUrl.href.startsWith(WALLPAPER_REMOTE_STORAGE_PREFIX)) return null;
        const relativePath = decodeURIComponent(candidateUrl.href.slice(WALLPAPER_REMOTE_STORAGE_PREFIX.length));
        if (!relativePath.startsWith(`${normalizedTheme}/`)) return null;
        if (!WALLPAPER_FILE_PATTERN.test(relativePath)) return null;
        return toHostedWallpaperUrl(`wallpaper/${relativePath}`);
    } catch (error) {
        return null;
    }
}

function normalizeWallpaperCatalog(rawCatalog, options = {}) {
    const resolveFilePath = typeof options.resolveFilePath === 'function'
        ? options.resolveFilePath
        : ((theme, filePath) => normalizeWallpaperPathForTheme(theme, filePath));
    const normalizedCatalog = createEmptyWallpaperCatalog();
    const normalizedThemeDefaults = createEmptyWallpaperThemeDefaults();
    const rawCatalogObject = isPlainObject(rawCatalog) ? rawCatalog : {};
    const rawThemeDefaults = isPlainObject(rawCatalogObject.themeDefaults)
        ? rawCatalogObject.themeDefaults
        : {};
    const rawThemes = isPlainObject(rawCatalogObject.themes) ? rawCatalogObject.themes : null;
    const normalizedNewUserDefault = normalizeNewUserWallpaperDefaultConfig(rawCatalogObject.newUserDefault, {
        resolveSelectionFile: normalizeBundledWallpaperPathForTheme
    });
    const themes = ['dark', 'light'];

    for (const theme of themes) {
        normalizedThemeDefaults[theme] = normalizeWallpaperStyleConfig(
            rawThemeDefaults[theme],
            DEFAULT_WALLPAPER_THEME_STYLES[theme]
        );

        const rawEntries = Array.isArray(rawThemes?.[theme]) ? rawThemes[theme] : [];
        const dedupe = new Set();
        const normalizedEntries = [];

        for (const entry of rawEntries) {
            if (!entry || typeof entry !== 'object') continue;
            const file = resolveFilePath(theme, entry.file);
            if (!file || dedupe.has(file)) continue;
            dedupe.add(file);

            const entryId = typeof entry.id === 'string' && entry.id.trim()
                ? entry.id.trim()
                : file.replace(/\.[^.]+$/, '');
            const entryLabel = typeof entry.label === 'string' && entry.label.trim()
                ? entry.label.trim()
                : formatWallpaperLabelFromFile(file);
            const entryStyle = normalizeWallpaperStyleConfig(
                entry?.style,
                normalizedThemeDefaults[theme]
            );

            normalizedEntries.push({
                id: entryId,
                file,
                label: entryLabel,
                style: entryStyle,
                sourceType: 'bundled',
                isInstalled: false,
                isArchived: false,
                archivedAt: null
            });
        }

        normalizedCatalog[theme] = normalizedEntries;
    }

    ['dark', 'light'].forEach((theme) => {
        const selectedFile = normalizedNewUserDefault.selectionByTheme?.[theme];
        if (!selectedFile) {
            return;
        }
        const fileExists = normalizedCatalog[theme].some((entry) => entry?.file === selectedFile);
        if (!fileExists) {
            normalizedNewUserDefault.selectionByTheme[theme] = null;
        }
    });

    return {
        themes: normalizedCatalog,
        themeDefaults: normalizedThemeDefaults,
        newUserDefault: normalizedNewUserDefault
    };
}

function getWallpaperCatalogEntriesForTheme(theme) {
    const normalizedTheme = normalizeThemeMode(theme);
    return Array.isArray(wallpaperCatalogByTheme[normalizedTheme])
        ? wallpaperCatalogByTheme[normalizedTheme]
        : [];
}

function mergeWallpaperCatalogs(primaryCatalog, secondaryCatalog) {
    const mergedCatalog = {
        themes: createEmptyWallpaperCatalog(),
        themeDefaults: primaryCatalog?.themeDefaults || createEmptyWallpaperThemeDefaults(),
        newUserDefault: primaryCatalog?.newUserDefault || createEmptyNewUserWallpaperDefaultConfig()
    };

    ['dark', 'light'].forEach((theme) => {
        const mergedEntries = [];
        const seenFiles = new Set();
        const sources = [
            ...(Array.isArray(primaryCatalog?.themes?.[theme]) ? primaryCatalog.themes[theme] : []),
            ...(Array.isArray(secondaryCatalog?.themes?.[theme]) ? secondaryCatalog.themes[theme] : [])
        ];

        sources.forEach((entry) => {
            if (!entry?.file || seenFiles.has(entry.file)) return;
            seenFiles.add(entry.file);
            mergedEntries.push(entry);
        });

        mergedCatalog.themes[theme] = mergedEntries;
    });

    return mergedCatalog;
}

function getCurrentWallpaperCatalogState() {
    return {
        themes: {
            dark: Array.isArray(wallpaperCatalogByTheme.dark) ? wallpaperCatalogByTheme.dark : [],
            light: Array.isArray(wallpaperCatalogByTheme.light) ? wallpaperCatalogByTheme.light : []
        },
        themeDefaults: wallpaperThemeDefaults || createEmptyWallpaperThemeDefaults(),
        newUserDefault: wallpaperNewUserDefaultConfig || createEmptyNewUserWallpaperDefaultConfig()
    };
}

function readCachedWallpaperStyleByTheme() {
    let parsed = null;
    try {
        const raw = localStorage.getItem(WALLPAPER_STYLE_LOCAL_CACHE_KEY);
        if (raw) {
            const parsedRaw = JSON.parse(raw);
            if (parsedRaw && typeof parsedRaw === 'object') {
                parsed = parsedRaw;
            }
        }
    } catch (error) {
        parsed = null;
    }

    const resolved = {
        dark: parsed?.dark && typeof parsed.dark === 'object' ? parsed.dark : null,
        light: parsed?.light && typeof parsed.light === 'object' ? parsed.light : null
    };
    let hasValue = Boolean(resolved.dark || resolved.light);

    for (const theme of ['dark', 'light']) {
        try {
            const bootRaw = localStorage.getItem(`${WALLPAPER_BOOT_STYLE_CACHE_PREFIX}${theme}`);
            if (!bootRaw) continue;
            const parsedBootStyle = JSON.parse(bootRaw);
            if (parsedBootStyle && typeof parsedBootStyle === 'object') {
                resolved[theme] = parsedBootStyle;
                hasValue = true;
            }
        } catch (_error) {
            // Fall back to the generic cache for this theme.
        }
    }

    return hasValue ? resolved : null;
}

async function blobToDataUrl(blob) {
    return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('Failed to read wallpaper cache data.'));
        reader.readAsDataURL(blob);
    });
}

async function fetchHostedWallpaperAsDataUrl(sourceUrl) {
    const response = await fetch(sourceUrl, { cache: 'force-cache' });
    if (!response.ok) {
        throw new Error(`Wallpaper fetch failed (${response.status})`);
    }
    const blob = await response.blob();
    if (!blob.size) {
        throw new Error('Wallpaper fetch returned empty data.');
    }
    return await blobToDataUrl(blob);
}

async function ensureHostedWallpaperBinaryCache(theme, sourceUrl) {
    if (!isHostedWallpaperUrl(sourceUrl)) return null;

    const existingDataUrl = getCachedWallpaperBinaryDataUrl(theme, sourceUrl);
    if (existingDataUrl) {
        writeHostedWallpaperBootCache(theme, sourceUrl, existingDataUrl);
        return existingDataUrl;
    }

    try {
        const dataUrl = await fetchHostedWallpaperAsDataUrl(sourceUrl);
        const didCache = writeCachedWallpaperBinaryDataUrl(theme, sourceUrl, dataUrl);
        return didCache ? dataUrl : null;
    } catch (error) {
        console.warn('Failed to cache hosted wallpaper locally:', error);
        return null;
    }
}

async function ensureInstalledWallpaperBinaryCache(theme, sourceUrl) {
    const normalizedTheme = normalizeThemeMode(theme);
    const normalizedSource = normalizeWallpaperPathForTheme(normalizedTheme, sourceUrl);
    if (!isInstalledWallpaperRef(normalizedSource)) return null;

    const existingDataUrl = getCachedWallpaperBinaryDataUrl(normalizedTheme, normalizedSource);
    if (existingDataUrl) {
        writeHostedWallpaperBootCache(normalizedTheme, normalizedSource, existingDataUrl);
        return existingDataUrl;
    }

    const installedRecord = getInstalledWallpaperRecordByRef(normalizedSource);
    if (!(installedRecord?.imageBlob instanceof Blob)) {
        return null;
    }

    try {
        const dataUrl = await blobToDataUrl(installedRecord.imageBlob);
        const didCache = writeCachedWallpaperBinaryDataUrl(normalizedTheme, normalizedSource, dataUrl);
        return didCache ? dataUrl : null;
    } catch (error) {
        console.warn('Failed to cache installed wallpaper locally:', error);
        return null;
    }
}

async function loadInstalledWallpaperCatalogFromDatabase() {
    try {
        const rawRecords = await db.table('installedWallpapers').toArray();
        const currentWallpaperUserId = getWallpaperAccountScopeUserId();
        const selectedRecordIds = getSelectedInstalledWallpaperRecordIds();
        const cloudManifestLookup = getWallpaperCloudManifestLookupForUser(currentWallpaperUserId);
        const recordsToClaimForCurrentUser = [];
        const visibleCatalogIdentities = new Set();

        rawRecords.sort(compareInstalledWallpaperFreshness);

        const nextCatalog = createEmptyWallpaperCatalog();
        const nextRecordMap = new Map();
        const nextCatalogEntriesByTheme = {
            dark: [],
            light: []
        };

        for (const rawRecord of rawRecords) {
            const recordId = normalizeInstalledWallpaperRecordId(rawRecord?.id);
            if (!recordId) continue;

            const theme = normalizeThemeMode(rawRecord?.theme);
            const installedRef = createInstalledWallpaperRef(theme, recordId);
            if (!installedRef) continue;

            const installedAt = typeof rawRecord?.installedAt === 'string' && rawRecord.installedAt
                ? rawRecord.installedAt
                : new Date().toISOString();
            const updatedAt = typeof rawRecord?.updatedAt === 'string' && rawRecord.updatedAt
                ? rawRecord.updatedAt
                : installedAt;
            const label = typeof rawRecord?.label === 'string' && rawRecord.label.trim()
                ? rawRecord.label.trim()
                : formatWallpaperLabelFromFile(rawRecord?.sourceUrl || recordId);
            const ownerUserId = normalizeWallpaperSyncUserId(rawRecord?.ownerUserId);
            const normalizedRecord = {
                ...rawRecord,
                id: recordId,
                ownerUserId,
                theme,
                label,
                style: normalizeWallpaperStyleConfig(
                    rawRecord?.style,
                    getWallpaperThemeDefaultForTheme(theme)
                ),
                sourceType: typeof rawRecord?.sourceType === 'string' && rawRecord.sourceType.trim()
                    ? rawRecord.sourceType.trim()
                    : 'remote-install',
                remoteId: typeof rawRecord?.remoteId === 'string' && rawRecord.remoteId.trim()
                    ? rawRecord.remoteId.trim()
                    : null,
                sourceUrl: typeof rawRecord?.sourceUrl === 'string' && rawRecord.sourceUrl.trim()
                    ? rawRecord.sourceUrl.trim()
                    : null,
                thumbnailUrl: typeof rawRecord?.thumbnailUrl === 'string' && rawRecord.thumbnailUrl.trim()
                    ? rawRecord.thumbnailUrl.trim()
                    : null,
                version: typeof rawRecord?.version === 'string' && rawRecord.version.trim()
                    ? rawRecord.version.trim()
                    : null,
                mimeType: typeof rawRecord?.mimeType === 'string' && rawRecord.mimeType.trim()
                    ? rawRecord.mimeType.trim()
                    : ((rawRecord?.imageBlob instanceof Blob && rawRecord.imageBlob.type) ? rawRecord.imageBlob.type : null),
                byteSize: Number.isFinite(Number(rawRecord?.byteSize))
                    ? Number(rawRecord.byteSize)
                    : ((rawRecord?.imageBlob instanceof Blob && Number.isFinite(rawRecord.imageBlob.size)) ? rawRecord.imageBlob.size : 0),
                archivedAt: normalizeWallpaperArchivedAt(rawRecord?.archivedAt),
                installedAt,
                updatedAt,
                imageBlob: rawRecord?.imageBlob instanceof Blob ? rawRecord.imageBlob : null
            };

            const isSelectedRecord = selectedRecordIds.has(recordId);
            const isCloudReferencedRecord = cloudManifestLookup.ids.has(recordId)
                || (normalizedRecord.sourceUrl && cloudManifestLookup.sourceUrls.has(normalizedRecord.sourceUrl))
                || (normalizedRecord.remoteId && cloudManifestLookup.remoteIdsByTheme[theme]?.has(normalizedRecord.remoteId));
            const isVisibleForCurrentScope = currentWallpaperUserId
                ? (ownerUserId === currentWallpaperUserId || isSelectedRecord || isCloudReferencedRecord)
                : (!ownerUserId || isSelectedRecord);

            if (!isVisibleForCurrentScope) {
                continue;
            }

            if (currentWallpaperUserId && ownerUserId !== currentWallpaperUserId && (isSelectedRecord || isCloudReferencedRecord)) {
                recordsToClaimForCurrentUser.push({
                    ...normalizedRecord,
                    ownerUserId: currentWallpaperUserId
                });
                normalizedRecord.ownerUserId = currentWallpaperUserId;
            }

            nextRecordMap.set(installedRef, normalizedRecord);

            const catalogIdentity = getWallpaperCanonicalSourceIdentity(theme, {
                id: recordId,
                remoteId: normalizedRecord.remoteId,
                sourceUrl: normalizedRecord.sourceUrl
            }) || `record:${theme}:${recordId}`;
            const bundledEquivalentEntry = findBundledWallpaperEquivalentEntry(theme, {
                id: recordId,
                remoteId: normalizedRecord.remoteId,
                sourceUrl: normalizedRecord.sourceUrl
            });

            if (bundledEquivalentEntry || visibleCatalogIdentities.has(catalogIdentity)) {
                continue;
            }

            visibleCatalogIdentities.add(catalogIdentity);
            nextCatalogEntriesByTheme[theme].push({
                id: `installed:${recordId}`,
                file: installedRef,
                label,
                style: normalizedRecord.style,
                sourceType: normalizedRecord.sourceType,
                isInstalled: true,
                isArchived: Boolean(normalizedRecord.archivedAt),
                archivedAt: normalizedRecord.archivedAt,
                installedAt: normalizedRecord.installedAt,
                updatedAt: normalizedRecord.updatedAt
            });
        }

        ['dark', 'light'].forEach((theme) => {
            nextCatalog[theme] = nextCatalogEntriesByTheme[theme]
                .sort(compareInstalledWallpaperDisplayOrder)
                .map(({ installedAt: _installedAt, updatedAt: _updatedAt, ...entry }) => entry);
        });

        if (recordsToClaimForCurrentUser.length > 0) {
            await db.table('installedWallpapers').bulkPut(recordsToClaimForCurrentUser);
        }

        revokeStaleInstalledWallpaperObjectUrls(nextRecordMap);
        installedWallpaperRecordsByRef = nextRecordMap;
        setInstalledWallpaperCatalogState(nextCatalog);
        return nextCatalog;
    } catch (error) {
        console.warn('Failed to load installed wallpaper catalog from IndexedDB. Continuing without installed wallpapers.', error);
        revokeStaleInstalledWallpaperObjectUrls(new Map());
        installedWallpaperRecordsByRef = new Map();
        setInstalledWallpaperCatalogState(createEmptyWallpaperCatalog());
        return createEmptyWallpaperCatalog();
    }
}

async function broadcastInstalledWallpaperCatalogVersionChange(version = new Date().toISOString()) {
    installedWallpaperCatalogVersion = version;
    if (typeof chrome === 'undefined' || !chrome.storage?.local) {
        return;
    }

    try {
        await chrome.storage.local.set({
            [INSTALLED_WALLPAPER_CATALOG_VERSION_STORAGE_KEY]: version
        });
    } catch (error) {
        console.warn('Failed to broadcast installed wallpaper catalog refresh:', error);
    }
}

async function installWallpaperBlobLocally({
    id = null,
    theme,
    sourceUrl = null,
    imageBlob,
    originalImageBlob = null,
    remoteId = null,
    label = null,
    style = null,
    thumbnailUrl = null,
    version = null,
    sourceType = null,
    cropState = null
}) {
    const normalizedTheme = normalizeThemeMode(theme);
    const normalizedSourceType = typeof sourceType === 'string' && sourceType.trim()
        ? sourceType.trim()
        : null;
    const isLocalUserUpload = normalizedSourceType === LOCAL_USER_WALLPAPER_SOURCE_TYPE;
    const normalizedSourceUrl = isLocalUserUpload
        // User uploads are copied into IndexedDB and must not depend on the original disk path.
        ? null
        : normalizeWallpaperPathForTheme(normalizedTheme, sourceUrl);
    if (!isLocalUserUpload && !isHostedWallpaperUrl(normalizedSourceUrl)) {
        throw new Error('Wallpaper source must be a hosted wallpaper URL.');
    }

    if (!(imageBlob instanceof Blob) || !imageBlob.size) {
        throw new Error('Wallpaper install requires a non-empty image blob.');
    }

    const recordId = id || findExistingInstalledWallpaperRecordId({
        theme: normalizedTheme,
        remoteId,
        sourceUrl: normalizedSourceUrl
    }) || createInstalledWallpaperRecordId({
        theme: normalizedTheme,
        remoteId,
        sourceUrl: normalizedSourceUrl
    });
    const installedRef = createInstalledWallpaperRef(normalizedTheme, recordId);
    const existingRecord = await db.table('installedWallpapers').get(recordId);
    const now = new Date().toISOString();
    const ownerUserId = getWallpaperAccountScopeUserId();

    await db.table('installedWallpapers').put({
        id: recordId,
        ownerUserId,
        theme: normalizedTheme,
        label: typeof label === 'string' && label.trim()
            ? label.trim()
            : formatWallpaperLabelFromFile(normalizedSourceUrl),
        style: normalizeWallpaperStyleConfig(style, getWallpaperThemeDefaultForTheme(normalizedTheme)),
        sourceType: normalizedSourceType
            ? normalizedSourceType
            : (typeof remoteId === 'string' && remoteId.trim() ? 'remote-gallery' : 'remote-hosted'),
        remoteId: typeof remoteId === 'string' && remoteId.trim() ? remoteId.trim() : null,
        sourceUrl: normalizedSourceUrl,
        thumbnailUrl: typeof thumbnailUrl === 'string' && thumbnailUrl.trim() ? thumbnailUrl.trim() : null,
        version: typeof version === 'string' && version.trim() ? version.trim() : null,
        mimeType: imageBlob.type || null,
        byteSize: imageBlob.size,
        imageBlob,
        originalImageBlob: originalImageBlob instanceof Blob ? originalImageBlob : (existingRecord?.originalImageBlob || null),
        cropState: cropState || existingRecord?.cropState || null,
        archivedAt: null,
        installedAt: existingRecord?.installedAt || now,
        updatedAt: now
    });

    clearCachedWallpaperBinaryDataUrl(normalizedTheme, installedRef);
    await loadInstalledWallpaperCatalogFromDatabase();
    await broadcastInstalledWallpaperCatalogVersionChange(now);

    return {
        installedRef,
        record: getInstalledWallpaperRecordByRef(installedRef)
    };
}

async function installRemoteWallpaperLocally({
    theme,
    sourceUrl,
    remoteId = null,
    label = null,
    style = null,
    thumbnailUrl = null,
    version = null,
    installContext = 'unknown',
    fetchCache = 'force-cache'
}) {
    const normalizedTheme = normalizeThemeMode(theme);
    const normalizedSourceUrl = normalizeWallpaperPathForTheme(normalizedTheme, sourceUrl);
    if (!isHostedWallpaperUrl(normalizedSourceUrl)) {
        throw new Error('Wallpaper install source must be a hosted wallpaper URL.');
    }

    recordWallpaperDiagnosticEvent('wallpaper-install-download-started', {
        theme: normalizedTheme,
        installContext,
        remoteId: remoteId || null,
        sourceUrl: normalizedSourceUrl
    }, {
        counter: 'installDownloads'
    });

    try {
        const response = await fetch(normalizedSourceUrl, { cache: fetchCache });
        if (!response.ok) {
            const installError = new Error(`Wallpaper install failed (${response.status})`);
            installError.status = response.status;
            throw installError;
        }

        const imageBlob = await response.blob();
        if (!imageBlob.size) {
            throw new Error('Wallpaper install returned empty data.');
        }

        const installResult = await installWallpaperBlobLocally({
            theme: normalizedTheme,
            sourceUrl: normalizedSourceUrl,
            imageBlob,
            remoteId,
            label,
            style,
            thumbnailUrl,
            version,
            sourceType: typeof remoteId === 'string' && remoteId.trim() ? 'remote-gallery' : 'remote-hosted'
        });

        recordWallpaperDiagnosticEvent('wallpaper-install-download-succeeded', {
            theme: normalizedTheme,
            installContext,
            remoteId: remoteId || null,
            sourceUrl: normalizedSourceUrl,
            installedRef: installResult?.installedRef || null
        });

        return installResult;
    } catch (error) {
        recordWallpaperDiagnosticEvent('wallpaper-install-download-failed', {
            theme: normalizedTheme,
            installContext,
            remoteId: remoteId || null,
            sourceUrl: normalizedSourceUrl,
            error: error?.message || String(error)
        }, {
            counter: 'installFailures'
        });
        throw error;
    }
}

function extractWallpaperHttpStatusFromError(error) {
    if (!error) return null;

    const directStatus = Number(error.status || error.statusCode);
    if (Number.isFinite(directStatus)) {
        return directStatus;
    }

    const numericCode = Number(error.code);
    if (Number.isFinite(numericCode) && numericCode >= 100 && numericCode <= 599) {
        return numericCode;
    }

    const message = error instanceof Error
        ? error.message
        : String(error ?? '');
    const statusMatch = message.match(/\b(4\d{2}|5\d{2})\b/);
    return statusMatch ? Number(statusMatch[1]) : null;
}

function isWallpaperRemoteAssetMissingError(error) {
    const status = extractWallpaperHttpStatusFromError(error);
    return status === 400 || status === 404;
}

async function removeInstalledWallpaperRecordLocally(installedRef, { sourceUrl = null } = {}) {
    const parsedRef = parseInstalledWallpaperRef(installedRef);
    if (!parsedRef?.recordId) {
        return {
            removed: false,
            installedRef: null,
            recordId: null,
            theme: null,
            sourceUrl: null,
            remoteId: null
        };
    }

    const normalizedInstalledRef = parsedRef.ref;
    const existingRecord = getInstalledWallpaperRecordByRef(normalizedInstalledRef);
    const normalizedSourceUrl = normalizeWallpaperPathForTheme(
        parsedRef.theme,
        sourceUrl || existingRecord?.sourceUrl || null
    );

    clearCachedWallpaperBinaryDataUrl(parsedRef.theme, normalizedInstalledRef);
    if (normalizedSourceUrl) {
        clearCachedWallpaperBinaryDataUrl(parsedRef.theme, normalizedSourceUrl);
    }
    revokeInstalledWallpaperObjectUrl(normalizedInstalledRef);

    await db.table('installedWallpapers').delete(parsedRef.recordId);
    await loadInstalledWallpaperCatalogFromDatabase();
    await broadcastInstalledWallpaperCatalogVersionChange(new Date().toISOString());

    return {
        removed: true,
        installedRef: normalizedInstalledRef,
        recordId: parsedRef.recordId,
        theme: parsedRef.theme,
        sourceUrl: normalizedSourceUrl,
        remoteId: typeof existingRecord?.remoteId === 'string' && existingRecord.remoteId.trim()
            ? existingRecord.remoteId.trim()
            : null
    };
}

async function setInstalledWallpaperArchiveStateLocally(installedRef, { archived = true } = {}) {
    const parsedRef = parseInstalledWallpaperRef(installedRef);
    if (!parsedRef?.recordId) {
        return {
            updated: false,
            installedRef: null,
            recordId: null,
            theme: null,
            archivedAt: null
        };
    }

    const normalizedInstalledRef = parsedRef.ref;
    const existingRecord = getInstalledWallpaperRecordByRef(normalizedInstalledRef);
    if (!existingRecord) {
        return {
            updated: false,
            installedRef: normalizedInstalledRef,
            recordId: parsedRef.recordId,
            theme: parsedRef.theme,
            archivedAt: null
        };
    }

    const nextArchivedAt = archived ? new Date().toISOString() : null;
    const currentArchivedAt = normalizeWallpaperArchivedAt(existingRecord.archivedAt);
    if ((currentArchivedAt !== null) === (nextArchivedAt !== null)) {
        return {
            updated: true,
            installedRef: normalizedInstalledRef,
            recordId: parsedRef.recordId,
            theme: parsedRef.theme,
            archivedAt: currentArchivedAt
        };
    }

    const mutationTimestamp = new Date().toISOString();
    await db.table('installedWallpapers').update(parsedRef.recordId, {
        archivedAt: nextArchivedAt,
        updatedAt: mutationTimestamp
    });
    await loadInstalledWallpaperCatalogFromDatabase();
    await broadcastInstalledWallpaperCatalogVersionChange(mutationTimestamp);

    return {
        updated: true,
        installedRef: normalizedInstalledRef,
        recordId: parsedRef.recordId,
        theme: parsedRef.theme,
        archivedAt: nextArchivedAt
    };
}

async function setInstalledWallpaperStyleLocally(installedRef, { style } = {}) {
    const parsedRef = parseInstalledWallpaperRef(installedRef);
    if (!parsedRef?.recordId) {
        return {
            updated: false,
            installedRef: null,
            recordId: null,
            theme: null,
            style: null
        };
    }

    const normalizedInstalledRef = parsedRef.ref;
    const existingRecord = getInstalledWallpaperRecordByRef(normalizedInstalledRef);
    if (!existingRecord) {
        return {
            updated: false,
            installedRef: normalizedInstalledRef,
            recordId: parsedRef.recordId,
            theme: parsedRef.theme,
            style: null
        };
    }

    const nextStyle = normalizeWallpaperStyleConfig(
        style,
        getWallpaperThemeDefaultForTheme(parsedRef.theme)
    );

    if (JSON.stringify(existingRecord.style || null) === JSON.stringify(nextStyle)) {
        return {
            updated: true,
            installedRef: normalizedInstalledRef,
            recordId: parsedRef.recordId,
            theme: parsedRef.theme,
            style: nextStyle
        };
    }

    const mutationTimestamp = new Date().toISOString();
    await db.table('installedWallpapers').update(parsedRef.recordId, {
        style: nextStyle,
        updatedAt: mutationTimestamp
    });
    await loadInstalledWallpaperCatalogFromDatabase();
    await broadcastInstalledWallpaperCatalogVersionChange(mutationTimestamp);

    return {
        updated: true,
        installedRef: normalizedInstalledRef,
        recordId: parsedRef.recordId,
        theme: parsedRef.theme,
        style: nextStyle
    };
}

async function importWallpaperCloudManifestIntoDatabase(rawState, { broadcast = false } = {}) {
    const currentWallpaperUserId = getWallpaperAccountScopeUserId();
    const normalizedState = normalizeWallpaperCloudSyncState(rawState, currentWallpaperUserId);

    if (shouldIgnoreIncomingWallpaperCloudState(normalizedState, wallpaperCloudSyncState)) {
        recordWallpaperDiagnosticEvent('wallpaper-cloud-state-ignored-stale', {
            userId: normalizedState?.userId || null,
            incomingUpdatedAt: normalizedState?.updatedAt || null,
            currentUpdatedAt: wallpaperCloudSyncState?.updatedAt || null
        });
        return wallpaperCloudSyncState;
    }

    wallpaperCloudSyncState = normalizedState;

    if (!currentWallpaperUserId || normalizedState.userId !== currentWallpaperUserId) {
        await loadInstalledWallpaperCatalogFromDatabase();
        return normalizedState;
    }

    const manifestEntries = Array.isArray(normalizedState.installedWallpapers)
        ? [...normalizedState.installedWallpapers].sort((left, right) => {
            const leftTime = Date.parse(left?.updatedAt || 0);
            const rightTime = Date.parse(right?.updatedAt || 0);
            return rightTime - leftTime;
        })
        : [];
    const dedupedManifestEntries = [];
    const seenManifestIdentities = new Set();

    manifestEntries.forEach((entry) => {
        const entryIdentity = getWallpaperCanonicalSourceIdentity(entry?.theme, entry)
            || `record:${normalizeThemeMode(entry?.theme)}:${normalizeInstalledWallpaperRecordId(entry?.id)}`;
        if (!entryIdentity || seenManifestIdentities.has(entryIdentity)) {
            return;
        }
        if (findBundledWallpaperEquivalentEntry(entry?.theme, entry)) {
            return;
        }
        seenManifestIdentities.add(entryIdentity);
        dedupedManifestEntries.push(entry);
    });

    if (dedupedManifestEntries.length > 0) {
        const existingRecords = await db.table('installedWallpapers').toArray();
        const existingById = new Map(
            existingRecords.map((record) => [
                normalizeInstalledWallpaperRecordId(record?.id),
                record
            ])
        );
        const now = new Date().toISOString();
        const recordsToUpsert = dedupedManifestEntries.map((entry) => {
            const existingRecord = existingById.get(entry.id) || null;
            return {
                ...(existingRecord || {}),
                id: entry.id,
                ownerUserId: currentWallpaperUserId,
                theme: entry.theme,
                label: entry.label,
                style: entry.style,
                sourceType: existingRecord?.sourceType || (entry.remoteId ? 'remote-gallery' : 'remote-hosted'),
                remoteId: entry.remoteId,
                sourceUrl: entry.sourceUrl,
                thumbnailUrl: entry.thumbnailUrl,
                version: entry.version,
                mimeType: existingRecord?.mimeType || null,
                byteSize: Number.isFinite(Number(existingRecord?.byteSize))
                    ? Number(existingRecord.byteSize)
                    : 0,
                imageBlob: existingRecord?.imageBlob instanceof Blob ? existingRecord.imageBlob : null,
                installedAt: existingRecord?.installedAt || entry.installedAt || entry.updatedAt || now,
                updatedAt: entry.updatedAt || existingRecord?.updatedAt || now
            };
        });

        await db.table('installedWallpapers').bulkPut(recordsToUpsert);
    }

    await loadInstalledWallpaperCatalogFromDatabase();

    if (broadcast) {
        await broadcastInstalledWallpaperCatalogVersionChange(normalizedState.updatedAt || new Date().toISOString());
    }

    return normalizedState;
}

async function loadWallpaperCloudSyncStateFromStorage(userIdHint = wallpaperAccountScopeUserId, prefetchedRawState) {
    const normalizedUserHint = normalizeWallpaperSyncUserId(userIdHint);
    void prefetchedRawState;
    wallpaperCloudSyncState = createEmptyWallpaperCloudSyncState(normalizedUserHint);
    await loadInstalledWallpaperCatalogFromDatabase();
    return wallpaperCloudSyncState;
}

async function buildWallpaperPreferenceSyncPayload(userId) {
    const normalizedUserId = normalizeWallpaperSyncUserId(userId);
    if (!normalizedUserId) {
        return null;
    }

    let selectionSource = wallpaperSelectionByTheme;
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        try {
            const result = await chrome.storage.local.get(WALLPAPER_STORAGE_KEY);
            if (Object.prototype.hasOwnProperty.call(result, WALLPAPER_STORAGE_KEY)) {
                selectionSource = result[WALLPAPER_STORAGE_KEY];
            }
        } catch (error) {
            console.warn('Failed to read shared wallpaper selection for sync payload:', error);
        }
    }

    const syncSafeSelection = buildSyncSafeWallpaperSelection(selectionSource);
    const { selection: reconciledSelection } = reconcileWallpaperSelection(syncSafeSelection, {
        preserveHostedSelections: true,
        preserveInstalledSelections: true
    });
    const selectedRecordIds = getSelectedInstalledWallpaperRecordIds(reconciledSelection);
    const cloudManifestLookup = getWallpaperCloudManifestLookupForUser(normalizedUserId);
    const rawRecords = await db.table('installedWallpapers').toArray();
    rawRecords.sort(compareInstalledWallpaperDisplayOrder);
    const syncableWallpapers = [];
    const seenWallpaperIdentities = new Set();

    for (const rawRecord of rawRecords) {
        if (isLocalUserWallpaperRecord(rawRecord)) {
            continue;
        }

        const entry = normalizeWallpaperCloudInstallEntry({
            id: rawRecord?.id,
            recordId: rawRecord?.id,
            theme: rawRecord?.theme,
            remoteId: rawRecord?.remoteId,
            sourceUrl: rawRecord?.sourceUrl,
            label: rawRecord?.label,
            style: rawRecord?.style,
            thumbnailUrl: rawRecord?.thumbnailUrl,
            version: rawRecord?.version,
            installedAt: rawRecord?.installedAt || null,
            updatedAt: rawRecord?.updatedAt || rawRecord?.installedAt || null
        });
        if (!entry) continue;

        const ownerUserId = normalizeWallpaperSyncUserId(rawRecord?.ownerUserId);
        const includeRecord = ownerUserId === normalizedUserId
            || selectedRecordIds.has(entry.id)
            || cloudManifestLookup.ids.has(entry.id)
            || (entry.sourceUrl && cloudManifestLookup.sourceUrls.has(entry.sourceUrl))
            || (entry.remoteId && cloudManifestLookup.remoteIdsByTheme[entry.theme]?.has(entry.remoteId));

        if (!includeRecord) {
            continue;
        }

        if (findBundledWallpaperEquivalentEntry(entry.theme, entry)) {
            continue;
        }

        const entryIdentity = getWallpaperCanonicalSourceIdentity(entry.theme, entry)
            || `record:${entry.theme}:${entry.id}`;
        if (seenWallpaperIdentities.has(entryIdentity)) {
            continue;
        }

        seenWallpaperIdentities.add(entryIdentity);
        syncableWallpapers.push(entry);
    }

    syncableWallpapers.sort(compareInstalledWallpaperDisplayOrder);

    return {
        theme_mode: normalizeThemeMode(themeMode),
        wallpaper_selection: {
            dark: reconciledSelection.dark ?? null,
            light: reconciledSelection.light ?? null
        },
        wallpaper_installs: syncableWallpapers,
        wallpaper_preferences_updated_at: getNextWallpaperPreferenceUpdatedAt(normalizedUserId)
    };
}

async function persistCurrentWallpaperCloudSyncStateLocally(userId = wallpaperAccountScopeUserId) {
    const normalizedUserId = normalizeWallpaperSyncUserId(userId);
    if (!normalizedUserId) {
        return null;
    }

    const payload = await buildWallpaperPreferenceSyncPayload(normalizedUserId);
    if (!payload) {
        return null;
    }

    await persistWallpaperCloudSyncStateFromPreferencePayload(normalizedUserId, payload);
    return payload;
}

async function queueWallpaperPreferenceSync(reason = 'wallpaper-preferences') {
    wallpaperPreferenceSyncPending = false;
    return { success: false, skipped: true, reason: 'wallpaper_sync_disabled', context: reason };
}

async function markWallpaperPreferenceSyncReady(userId) {
    const normalizedUserId = normalizeWallpaperSyncUserId(userId);
    if (!normalizedUserId || normalizedUserId !== getWallpaperAccountScopeUserId()) {
        return;
    }

    wallpaperPreferenceSyncReadyUserId = normalizedUserId;

    if (wallpaperPreferencesInitialized) {
        try {
            await ensureWallpaperPreferencesInitialized();
            await applyWebsiteWallpaperHandoffFromUrl();
        } catch (error) {
            console.warn('Failed to resume pending wallpaper handoff after local wallpaper restore:', error);
        }
    }
}

function resolveWallpaperRenderSource(theme, filePath) {
    const normalizedTheme = normalizeThemeMode(theme);
    const normalizedPath = normalizeWallpaperPathForTheme(normalizedTheme, filePath);
    if (isInstalledWallpaperRef(normalizedPath)) {
        const installedRecord = getInstalledWallpaperRecordByRef(normalizedPath);
        const hostedFallbackSource = normalizeWallpaperPathForTheme(
            normalizedTheme,
            installedRecord?.sourceUrl || null
        );
        return getCachedWallpaperBinaryDataUrl(normalizedTheme, normalizedPath)
            || getInstalledWallpaperObjectUrl(normalizedPath)
            || hostedFallbackSource
            || null;
    }
    if (isHostedWallpaperUrl(normalizedPath)) {
        return getCachedWallpaperBinaryDataUrl(normalizedTheme, normalizedPath) || normalizedPath;
    }
    return normalizedPath;
}

function findWallpaperCatalogEntry(theme, filePath) {
    if (!filePath) return null;
    const normalizedFile = normalizeWallpaperPathForTheme(theme, filePath);
    if (!normalizedFile) return null;
    return getWallpaperCatalogEntriesForTheme(theme).find(entry => entry.file === normalizedFile) || null;
}

function areWallpaperSelectionsEqual(a, b) {
    return (a?.dark ?? null) === (b?.dark ?? null)
        && (a?.light ?? null) === (b?.light ?? null);
}

function reconcileWallpaperSelection(rawSelection, options = {}) {
    const preserveHostedSelections = options.preserveHostedSelections === true;
    const preserveInstalledSelections = options.preserveInstalledSelections !== false;
    const preserveBundledSelections = options.preserveBundledSelections !== false;
    const source = rawSelection && typeof rawSelection === 'object' ? rawSelection : {};
    const resolved = createEmptyWallpaperSelection();
    let changed = false;
    const themes = ['dark', 'light'];

    for (const theme of themes) {
        const hasThemeKey = Object.prototype.hasOwnProperty.call(source, theme);
        const sourceValue = hasThemeKey ? source[theme] : undefined;
        const normalizedTheme = normalizeThemeMode(theme);

        if (hasThemeKey && sourceValue === null) {
            resolved[normalizedTheme] = null;
        } else {
            const normalizedPath = normalizeWallpaperPathForTheme(normalizedTheme, sourceValue);
            const equivalentCatalogEntry = normalizedPath
                ? findEquivalentWallpaperCatalogEntry(normalizedTheme, normalizedPath)
                : null;
            const shouldPreserveHosted = preserveHostedSelections && isHostedWallpaperUrl(normalizedPath);
            const shouldPreserveInstalled = preserveInstalledSelections && isInstalledWallpaperRef(normalizedPath);
            const shouldPreserveBundled = preserveBundledSelections
                && normalizedPath
                && !isHostedWallpaperUrl(normalizedPath)
                && !isInstalledWallpaperRef(normalizedPath);
            const hasCachedHostedBinary = isHostedWallpaperUrl(normalizedPath)
                && hasCachedHostedWallpaperBinary(normalizedTheme, normalizedPath);
            const hasCachedInstalledBinary = isInstalledWallpaperRef(normalizedPath)
                && hasCachedWallpaperBinary(normalizedTheme, normalizedPath);
            if (equivalentCatalogEntry?.file) {
                resolved[normalizedTheme] = equivalentCatalogEntry.file;
            } else if (
                normalizedPath
                && (
                    findWallpaperCatalogEntry(normalizedTheme, normalizedPath)
                    || shouldPreserveHosted
                    || shouldPreserveInstalled
                    || shouldPreserveBundled
                    || hasCachedHostedBinary
                    || hasCachedInstalledBinary
                )
            ) {
                resolved[normalizedTheme] = normalizedPath;
            } else {
                resolved[normalizedTheme] = null;
            }
        }

        if (!hasThemeKey || sourceValue !== resolved[normalizedTheme]) {
            changed = true;
        }
    }

    return { selection: resolved, changed };
}

function cacheWallpaperSelectionLocally(selection = wallpaperSelectionByTheme) {
    try {
        localStorage.setItem(WALLPAPER_LOCAL_CACHE_KEY, JSON.stringify({
            dark: selection.dark ?? null,
            light: selection.light ?? null
        }));
    } catch (error) {
        // Non-blocking cache write.
    }
}

function readCachedWallpaperSelection() {
    try {
        const raw = localStorage.getItem(WALLPAPER_LOCAL_CACHE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (error) {
        return null;
    }
}

function getResolvedWallpaperStyleForTheme(theme, {
    allowWallpaper = true,
    includeUserOverrides = true
} = {}) {
    const normalizedTheme = normalizeThemeMode(theme);
    const defaultThemeStyle = getWallpaperThemeDefaultForTheme(normalizedTheme);
    if (!allowWallpaper) {
        return includeUserOverrides && typeof applyWallpaperUserStyleOverride === 'function'
            ? applyWallpaperUserStyleOverride(normalizedTheme, defaultThemeStyle)
            : defaultThemeStyle;
    }

    // Use the active selection (which may be page-specific) instead of the global wallpaperSelectionByTheme
    const activeSelection = getWallpaperSelectionByTheme();
    const selectedFile = activeSelection[normalizedTheme] || null;
    const selectedEntry = selectedFile
        ? findWallpaperCatalogEntry(normalizedTheme, selectedFile)
        : null;
    const cachedStyles = selectedFile ? readCachedWallpaperStyleByTheme() : null;
    const cachedStyleForTheme = cachedStyles?.[normalizedTheme];
    const selectedInstalledRecord = isInstalledWallpaperRef(selectedFile)
        ? getInstalledWallpaperRecordByRef(selectedFile)
        : null;
    let resolvedStyle = null;
    if (selectedInstalledRecord) {
        if (selectedInstalledRecord?.style) {
            resolvedStyle = normalizeWallpaperStyleConfig(selectedInstalledRecord.style, defaultThemeStyle);
        } else if (selectedEntry?.style) {
            resolvedStyle = normalizeWallpaperStyleConfig(selectedEntry.style, defaultThemeStyle);
        } else {
            resolvedStyle = normalizeWallpaperStyleConfig(cachedStyleForTheme, defaultThemeStyle);
        }
    } else if (!selectedEntry && selectedFile) {
        // Startup can reapply the current wallpaper before the bundled catalog finishes
        // hydrating. Reuse the cached per-theme style so we do not flash the default
        // dark/light overlay tokens over the already-bootstrapped wallpaper.
        resolvedStyle = normalizeWallpaperStyleConfig(cachedStyleForTheme, defaultThemeStyle);
    } else {
        resolvedStyle = normalizeWallpaperStyleConfig(selectedEntry?.style, defaultThemeStyle);
    }

    if (
        selectedInstalledRecord
        && typeof selectedInstalledRecord?.sourceType === 'string'
        && selectedInstalledRecord.sourceType.trim() === LOCAL_USER_WALLPAPER_SOURCE_TYPE
    ) {
        const userUploadBoardColor = normalizeHexColor(
            resolvedStyle.boardBackgroundColor,
            defaultThemeStyle.boardBackgroundColor
        );
        const userUploadBoardOpacity = normalizeOpacity(
            resolvedStyle.boardBackgroundOpacity,
            defaultThemeStyle.boardBackgroundOpacity
        );
        const userUploadBoardBlur = normalizeBoardBackdropBlur(
            resolvedStyle.boardBackdropBlur,
            defaultThemeStyle.boardBackdropBlur
        );
        resolvedStyle = normalizeWallpaperStyleConfig({
            ...resolvedStyle,
            addBoardColor: '#FFFFFF',
            inactiveControlColor: userUploadBoardColor,
            inactiveControlOpacity: userUploadBoardOpacity,
            inactiveControlBackdropBlur: userUploadBoardBlur,
            popupBackgroundColor: userUploadBoardColor,
            popupBackgroundOpacity: 1,
            dropdownBackgroundColor: userUploadBoardColor,
            dropdownBackgroundOpacity: 1,
            overlay: {
                ...(resolvedStyle?.overlay || {}),
                topOpacity: 0,
                bottomOpacity: 0
            }
        }, defaultThemeStyle);
    }

    return includeUserOverrides && typeof applyWallpaperUserStyleOverride === 'function'
        ? applyWallpaperUserStyleOverride(normalizedTheme, resolvedStyle)
        : resolvedStyle;
}

function cacheWallpaperStyleLocally() {
    try {
        const cachePayload = {
            dark: getResolvedWallpaperStyleForTheme('dark'),
            light: getResolvedWallpaperStyleForTheme('light')
        };
        localStorage.setItem(WALLPAPER_STYLE_LOCAL_CACHE_KEY, JSON.stringify(cachePayload));
        writeWallpaperBootStyleCache('dark', cachePayload.dark);
        writeWallpaperBootStyleCache('light', cachePayload.light);
    } catch (error) {
        // Non-blocking cache write.
    }
}

function applyThemeStyleTokens(themeStyle) {
    const normalizedTheme = normalizeThemeMode(themeMode);
    const resolvedStyle = normalizeWallpaperStyleConfig(
        themeStyle,
        DEFAULT_WALLPAPER_THEME_STYLES[normalizedTheme]
    );
    const accentPalette = buildAccentPalette(resolvedStyle.primary, normalizedTheme);
    const computedAccentActiveTextColor = resolveReadableForegroundForHexes([
        accentPalette.accent1,
        accentPalette.accent3,
        accentPalette.accentHover
    ], '#1A1F2E', '#FFFFFF');
    const normalizedActiveTextColor = normalizeHexColor(
        resolvedStyle.activeTextColor,
        DEFAULT_WALLPAPER_THEME_STYLES[normalizedTheme].activeTextColor
    );
    const normalizedTabHoverTextColor = normalizeHexColor(
        resolvedStyle.tabHoverTextColor,
        DEFAULT_WALLPAPER_THEME_STYLES[normalizedTheme].tabHoverTextColor
    );
    const normalizedInactiveTabTextColor = normalizeHexColor(
        resolvedStyle.inactiveTabTextColor,
        DEFAULT_WALLPAPER_THEME_STYLES[normalizedTheme].inactiveTabTextColor
    );
    const normalizedBoardTextColor = normalizeHexColor(
        resolvedStyle.boardTextColor,
        DEFAULT_WALLPAPER_THEME_STYLES[normalizedTheme].boardTextColor
    );
    const normalizedLinkDescriptionTextColor = normalizeHexColor(
        resolvedStyle.linkDescriptionTextColor,
        DEFAULT_WALLPAPER_THEME_STYLES[normalizedTheme].linkDescriptionTextColor
    );
    const normalizedIconColor = normalizeHexColor(
        resolvedStyle.iconColor,
        DEFAULT_WALLPAPER_THEME_STYLES[normalizedTheme].iconColor
    );
    const normalizedTabArrowColor = normalizeHexColor(
        resolvedStyle.tabArrowColor,
        DEFAULT_WALLPAPER_THEME_STYLES[normalizedTheme].tabArrowColor
    );
    const normalizedAddBoardColor = normalizeHexColor(resolvedStyle.addBoardColor, DEFAULT_WALLPAPER_THEME_STYLES[normalizedTheme].addBoardColor);
    const addBoardIconColor = resolveReadableForegroundForHex(normalizedAddBoardColor, '#1A1F2E', '#FFFFFF');
    const addBoardRgb = hexToRgb(normalizedAddBoardColor) || hexToRgb(DEFAULT_WALLPAPER_THEME_STYLES[normalizedTheme].addBoardColor) || { r: 45, g: 255, b: 177 };
    const normalizedBoardBackgroundColor = normalizeHexColor(
        resolvedStyle.boardBackgroundColor,
        DEFAULT_WALLPAPER_THEME_STYLES[normalizedTheme].boardBackgroundColor
    );
    const boardBackgroundRgb = hexToRgb(normalizedBoardBackgroundColor)
        || hexToRgb(DEFAULT_WALLPAPER_THEME_STYLES[normalizedTheme].boardBackgroundColor)
        || { r: 41, g: 46, b: 61 };
    const boardBackgroundOpacity = normalizeOpacity(
        resolvedStyle.boardBackgroundOpacity,
        DEFAULT_WALLPAPER_THEME_STYLES[normalizedTheme].boardBackgroundOpacity
    );
    const boardBackdropBlur = normalizeBoardBackdropBlur(
        resolvedStyle.boardBackdropBlur,
        DEFAULT_WALLPAPER_THEME_STYLES[normalizedTheme].boardBackdropBlur
    );
    const boardBackdropSaturate = normalizeBoardBackdropSaturate(
        resolvedStyle.boardBackdropSaturate,
        DEFAULT_WALLPAPER_THEME_STYLES[normalizedTheme].boardBackdropSaturate
    );
    const normalizedInactiveControlColor = normalizeHexColor(
        resolvedStyle.inactiveControlColor,
        DEFAULT_WALLPAPER_THEME_STYLES[normalizedTheme].inactiveControlColor
    );
    const inactiveControlRgb = hexToRgb(normalizedInactiveControlColor)
        || hexToRgb(DEFAULT_WALLPAPER_THEME_STYLES[normalizedTheme].inactiveControlColor)
        || { r: 58, g: 70, b: 82 };
    const inactiveControlOpacity = normalizeOpacity(
        resolvedStyle.inactiveControlOpacity,
        DEFAULT_WALLPAPER_THEME_STYLES[normalizedTheme].inactiveControlOpacity
    );
    const inactiveControlBackdropBlur = normalizeInactiveControlBackdropBlur(
        resolvedStyle.inactiveControlBackdropBlur,
        DEFAULT_WALLPAPER_THEME_STYLES[normalizedTheme].inactiveControlBackdropBlur
    );
    const inactiveControlBackdropSaturate = normalizeInactiveControlBackdropSaturate(
        resolvedStyle.inactiveControlBackdropSaturate,
        DEFAULT_WALLPAPER_THEME_STYLES[normalizedTheme].inactiveControlBackdropSaturate
    );
    const inactiveControlHoverOpacity = Number(Math.min(1, inactiveControlOpacity + 0.12).toFixed(3));
    const normalizedPopupBackgroundColor = normalizeHexColor(
        resolvedStyle.popupBackgroundColor,
        DEFAULT_WALLPAPER_THEME_STYLES[normalizedTheme].popupBackgroundColor
    );
    const popupBackgroundRgb = hexToRgb(normalizedPopupBackgroundColor)
        || hexToRgb(DEFAULT_WALLPAPER_THEME_STYLES[normalizedTheme].popupBackgroundColor)
        || { r: 40, g: 44, b: 52 };
    const popupBackgroundOpacity = normalizeOpacity(
        resolvedStyle.popupBackgroundOpacity,
        DEFAULT_WALLPAPER_THEME_STYLES[normalizedTheme].popupBackgroundOpacity
    );
    const popupBackgroundOpacitySoft = Number(Math.max(0, popupBackgroundOpacity - 0.1).toFixed(3));
    const popupBackgroundSidebarOpacity = Number(Math.max(0, popupBackgroundOpacity - 0.24).toFixed(3));
    const popupBackgroundContentOpacity = Number(Math.max(0, popupBackgroundOpacity - 0.08).toFixed(3));
    const normalizedPopupCardBackgroundColor = normalizeHexColor(
        resolvedStyle.popupCardBackgroundColor,
        DEFAULT_WALLPAPER_THEME_STYLES[normalizedTheme].popupCardBackgroundColor
    );
    const popupCardBackgroundRgb = hexToRgb(normalizedPopupCardBackgroundColor)
        || hexToRgb(DEFAULT_WALLPAPER_THEME_STYLES[normalizedTheme].popupCardBackgroundColor)
        || { r: 255, g: 255, b: 255 };
    const popupCardBackgroundOpacity = normalizeOpacity(
        resolvedStyle.popupCardBackgroundOpacity,
        DEFAULT_WALLPAPER_THEME_STYLES[normalizedTheme].popupCardBackgroundOpacity
    );
    const normalizedDropdownBackgroundColor = normalizeHexColor(
        resolvedStyle.dropdownBackgroundColor,
        DEFAULT_WALLPAPER_THEME_STYLES[normalizedTheme].dropdownBackgroundColor
    );
    const dropdownBackgroundRgb = hexToRgb(normalizedDropdownBackgroundColor)
        || hexToRgb(DEFAULT_WALLPAPER_THEME_STYLES[normalizedTheme].dropdownBackgroundColor)
        || { r: 62, g: 69, b: 91 };
    const dropdownBackgroundOpacity = normalizeOpacity(
        resolvedStyle.dropdownBackgroundOpacity,
        DEFAULT_WALLPAPER_THEME_STYLES[normalizedTheme].dropdownBackgroundOpacity
    );
    const dropdownBackgroundOpacitySoft = Number(Math.max(0, dropdownBackgroundOpacity - 0.1).toFixed(3));
    const rootStyle = document.documentElement.style;

    rootStyle.setProperty('--ll-app-wallpaper-overlay', toOverlayGradientCss(resolvedStyle.overlay));
    rootStyle.setProperty('--ll-accent-1', accentPalette.accent1);
    rootStyle.setProperty('--ll-accent-2', accentPalette.accent2);
    rootStyle.setProperty('--ll-accent-3', accentPalette.accent3);
    rootStyle.setProperty('--ll-accent-4', accentPalette.accent4);
    rootStyle.setProperty('--ll-accent-hover', accentPalette.accentHover);
    rootStyle.setProperty('--ll-accent-rgb', accentPalette.accentRgb);
    rootStyle.setProperty('--ll-accent-soft', accentPalette.accentSoft);
    rootStyle.setProperty('--ll-accent-soft-2', accentPalette.accentSoft2);
    rootStyle.setProperty('--ll-accent-soft-3', accentPalette.accentSoft3);
    rootStyle.setProperty('--ll-border-accent', accentPalette.borderAccent);
    rootStyle.setProperty('--ll-accent-outline', accentPalette.accentOutline);
    rootStyle.setProperty('--ll-search-page-badge-bg', accentPalette.searchPageBadgeBg);
    rootStyle.setProperty('--ll-search-page-badge-border', accentPalette.searchPageBadgeBorder);
    rootStyle.setProperty('--ll-search-page-badge-text', accentPalette.searchPageBadgeText);
    rootStyle.setProperty('--ll-active-text-color', normalizedActiveTextColor);
    rootStyle.setProperty('--ll-accent-active-text-color', computedAccentActiveTextColor);
    rootStyle.setProperty('--ll-tab-hover-text-color', normalizedTabHoverTextColor);
    rootStyle.setProperty('--ll-tab-inactive-text-color', normalizedInactiveTabTextColor);
    rootStyle.setProperty('--ll-board-text-color', normalizedBoardTextColor);
    applyFontColorPreference();
    rootStyle.setProperty('--ll-link-description-color', normalizedLinkDescriptionTextColor);
    rootStyle.setProperty('--ll-icon-color', normalizedIconColor);
    rootStyle.setProperty('--ll-icon-dot', normalizedIconColor);
    rootStyle.setProperty('--ll-tab-arrow-color', normalizedTabArrowColor);
    rootStyle.setProperty('--ll-add-board-color', normalizedAddBoardColor);
    rootStyle.setProperty('--ll-add-board-rgb', `${Math.round(addBoardRgb.r)}, ${Math.round(addBoardRgb.g)}, ${Math.round(addBoardRgb.b)}`);
    rootStyle.setProperty('--ll-add-board-icon-color', addBoardIconColor);
    rootStyle.setProperty('--ll-board-bg-color', normalizedBoardBackgroundColor);
    rootStyle.setProperty('--ll-board-bg-rgb', `${Math.round(boardBackgroundRgb.r)}, ${Math.round(boardBackgroundRgb.g)}, ${Math.round(boardBackgroundRgb.b)}`);
    rootStyle.setProperty('--ll-board-bg-opacity', String(boardBackgroundOpacity));
    rootStyle.setProperty('--ll-board-backdrop-blur', `${boardBackdropBlur}px`);
    rootStyle.setProperty('--ll-board-backdrop-saturate', `${boardBackdropSaturate}%`);
    rootStyle.setProperty('--ll-control-bg-color', normalizedInactiveControlColor);
    rootStyle.setProperty('--ll-control-bg-rgb', `${Math.round(inactiveControlRgb.r)}, ${Math.round(inactiveControlRgb.g)}, ${Math.round(inactiveControlRgb.b)}`);
    rootStyle.setProperty('--ll-control-bg-opacity', String(inactiveControlOpacity));
    rootStyle.setProperty('--ll-control-bg-hover-opacity', String(inactiveControlHoverOpacity));
    rootStyle.setProperty('--ll-control-backdrop-blur', `${inactiveControlBackdropBlur}px`);
    rootStyle.setProperty('--ll-control-backdrop-saturate', `${inactiveControlBackdropSaturate}%`);
    rootStyle.setProperty('--ll-popup-bg-color', normalizedPopupBackgroundColor);
    rootStyle.setProperty('--ll-popup-bg-rgb', `${Math.round(popupBackgroundRgb.r)}, ${Math.round(popupBackgroundRgb.g)}, ${Math.round(popupBackgroundRgb.b)}`);
    rootStyle.setProperty('--ll-popup-bg-opacity', String(popupBackgroundOpacity));
    rootStyle.setProperty('--ll-popup-bg-opacity-soft', String(popupBackgroundOpacitySoft));
    rootStyle.setProperty('--ll-popup-bg-sidebar-opacity', String(popupBackgroundSidebarOpacity));
    rootStyle.setProperty('--ll-popup-bg-content-opacity', String(popupBackgroundContentOpacity));
    rootStyle.setProperty('--ll-popup-card-bg-color', normalizedPopupCardBackgroundColor);
    rootStyle.setProperty('--ll-popup-card-bg-rgb', `${Math.round(popupCardBackgroundRgb.r)}, ${Math.round(popupCardBackgroundRgb.g)}, ${Math.round(popupCardBackgroundRgb.b)}`);
    rootStyle.setProperty('--ll-popup-card-bg-opacity', String(popupCardBackgroundOpacity));
    rootStyle.setProperty(
        '--ll-popup-bg-surface',
        `linear-gradient(135deg, rgba(${Math.round(popupBackgroundRgb.r)}, ${Math.round(popupBackgroundRgb.g)}, ${Math.round(popupBackgroundRgb.b)}, ${popupBackgroundOpacity}), rgba(${Math.round(popupBackgroundRgb.r)}, ${Math.round(popupBackgroundRgb.g)}, ${Math.round(popupBackgroundRgb.b)}, ${popupBackgroundOpacitySoft}))`
    );
    rootStyle.setProperty('--ll-dropdown-bg-color', normalizedDropdownBackgroundColor);
    rootStyle.setProperty('--ll-dropdown-bg-rgb', `${Math.round(dropdownBackgroundRgb.r)}, ${Math.round(dropdownBackgroundRgb.g)}, ${Math.round(dropdownBackgroundRgb.b)}`);
    rootStyle.setProperty('--ll-dropdown-bg-opacity', String(dropdownBackgroundOpacity));
    rootStyle.setProperty('--ll-dropdown-bg-opacity-soft', String(dropdownBackgroundOpacitySoft));
    rootStyle.setProperty(
        '--ll-dropdown-bg-surface',
        `linear-gradient(135deg, rgba(${Math.round(dropdownBackgroundRgb.r)}, ${Math.round(dropdownBackgroundRgb.g)}, ${Math.round(dropdownBackgroundRgb.b)}, ${dropdownBackgroundOpacity}), rgba(${Math.round(dropdownBackgroundRgb.r)}, ${Math.round(dropdownBackgroundRgb.g)}, ${Math.round(dropdownBackgroundRgb.b)}, ${dropdownBackgroundOpacitySoft}))`
    );
}

function toCssUrlValue(filePath) {
    if (!filePath) return 'none';
    const escaped = String(filePath).replace(/["\\]/g, '\\$&');
    return `url("${escaped}")`;
}

function getThemeTokenValue(tokenName, fallback = '') {
    try {
        const rawValue = getComputedStyle(document.documentElement).getPropertyValue(tokenName);
        const trimmedValue = rawValue ? rawValue.trim() : '';
        return trimmedValue || fallback;
    } catch (e) {
        return fallback;
    }
}

// Ensure first tab is selected after login/sync
async function ensureFirstTabSelected() {
    // Get all non-deleted pages
    const pages = await db.pages.filter(p => !p.deletedAt).sortBy('order');

    if (pages.length === 0) {

        return;
    }

    // Check if current page ID is valid (exists in pages list)
    const validPage = pages.find(p => p.id === currentPageId);

    if (!validPage) {
        // Only reset to first page if current selection is invalid

        currentPageId = pages[0].id;
        if (typeof chrome !== 'undefined' && chrome.storage) {
            await chrome.storage.local.set({ currentPageId: pages[0].id });
        }
    } else {

    }

    // Force update the active tab styling on all tabs
    document.querySelectorAll('.page-tab').forEach(tab => {
        const tabPageId = tab.dataset.pageId;
        tab.classList.remove('active');
        if (tabPageId === currentPageId) {
            tab.classList.add('active');
        }
    });

    // Also update dropdown items
    document.querySelectorAll('.dropdown-item').forEach(item => {
        const itemPageId = item.dataset.pageId;
        item.classList.remove('active');
        if (itemPageId === currentPageId) {
            item.classList.add('active');
        }
    });

    // Boards will be loaded by the caller - removed redundant loadBoardsFromDatabase() call

}

// Module-level variable to track sync polling interval (prevents memory leaks)
let syncPollInterval = null;

// Listen for reload signal from background script or other tabs
if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
        try {
            // Listen for reload signal from background script or other tabs
            if (areaName === 'local' && changes.reloadBoardsSignal) {
                const newValue = changes.reloadBoardsSignal.newValue;
                if (newValue && newValue.timestamp) {
                    // Skip during initialization - main flow will handle board loading
                    if (!initialAuthCompleted) {

                        return;
                    }
                    // FIX [Critical #5]: Skip if this tab just broadcasted (prevent self-reload)
                    // FIX [Issue #2]: Use Set.has() to check against all recent broadcast IDs
                    // This handles rapid consecutive broadcasts where listener fires after next broadcast
                    if (newValue.broadcastId && ownBroadcastIds.has(newValue.broadcastId)) {

                        return;
                    }



                    // Skip if sync is in progress to avoid race conditions
                    if (typeof SyncManager !== 'undefined' && SyncManager.isSyncing && SyncManager.isSyncing()) {

                        // Clear any existing polling interval before creating new one
                        if (syncPollInterval) {
                            clearInterval(syncPollInterval);
                            syncPollInterval = null;
                        }
                        // Wait for sync to complete before reloading
                        syncPollInterval = setInterval(async () => {
                            try {
                                if (!SyncManager.isSyncing()) {
                                    clearInterval(syncPollInterval);
                                    syncPollInterval = null;
                                    await loadPagesNavigation();
                                    await ensureFirstTabSelected();  // Validate current page exists (may have been deleted)
                                    await loadBoardsFromDatabase();
                                    await refreshSearchIfOpen();

                                }
                            } catch (pollError) {
                                console.error('Error in sync poll interval:', pollError);
                                clearInterval(syncPollInterval);
                                syncPollInterval = null;
                            }
                        }, 200);
                        // FIX [Critical #7]: Safety timeout - still load boards even if sync hangs
                        // Without this fallback, user sees stale data forever when sync takes >5 seconds
                        setTimeout(async () => {
                            if (syncPollInterval) {
                                clearInterval(syncPollInterval);
                                syncPollInterval = null;

                                try {
                                    await loadPagesNavigation();
                                    await ensureFirstTabSelected();  // Validate current page exists (may have been deleted)
                                    await loadBoardsFromDatabase();
                                    await refreshSearchIfOpen();
                                } catch (e) {
                                    console.error('Failed to load boards after timeout:', e);
                                }
                            }
                        }, 5000);
                        return;
                    }

                    // Delay to ensure IndexedDB writes are complete
                    setTimeout(async () => {
                        // Cancel any pending placeholder timeout - new data is coming
                        if (_showPlaceholderTimeoutId) {
                            clearTimeout(_showPlaceholderTimeoutId);
                            _showPlaceholderTimeoutId = null;
                        }
                        try {
                            // Recalculate bookmark count (may have changed from cross-tab operations)
                            await recalculateBookmarkCount();
                            await loadPagesNavigation();
                            await ensureFirstTabSelected();  // Validate current page exists (may have been deleted)
                            await loadBoardsFromDatabase();
                            await refreshSearchIfOpen();


                            // Quick save already synced via BackgroundSync - no need to trigger again
                            if (newValue.source === 'quickSave') {
                                await maybeShowReviewPrompt('quick_save');
                            }
                        } catch (e) {
                            console.error('Failed to reload boards:', e);
                        }
                    }, 300);
                }
            }
        } catch (error) {
            console.error('Error in reloadBoardsSignal handler:', error?.message || error, error?.stack);
        }
    });
}

// Operation locks to prevent race conditions
let isAddingBookmark = false;
let isAddingBoard = false;
let isCreatingPage = false;

/*
========================================
UTILITY FUNCTIONS
========================================
Helper functions for validation and error prevention
*/

// NOTE: Shared utility helpers are now loaded from newtab/shared/core-utils.js.

/*
========================================
UTILITY FUNCTIONS
========================================
Helper functions for calculating drop positions and managing indicators
*/

/**
 * Gets the index of an element within its parent container
 * @param {HTMLElement} element - The element to find the index of
 * @returns {number} - The index of the element, or -1 if not found
 */
function getElementIndex(element) {
    const parent = element.parentNode;
    if (!parent) return -1;

    const siblings = Array.from(parent.children);
    return siblings.indexOf(element);
}

/**
 * Determines which board element the dragged board should be inserted after
 * Based on the vertical mouse position (y-coordinate)
 * 
 * @param {HTMLElement} container - The column container element
 * @param {number} y - The current Y coordinate of the mouse cursor
 * @returns {HTMLElement|null} - The board element to insert after, or null for end of column
 */
function getDragAfterElement(container, y) {
    // Get all board elements in this column (excluding the one being dragged)
    const draggableElements = [...container.querySelectorAll('.board:not(.dragging)')];

    // Use reduce to find the closest board element based on mouse position
    return draggableElements.reduce((closest, child) => {
        // Get the position and dimensions of the current board element
        const box = child.getBoundingClientRect();

        // Calculate offset from mouse Y position to the center of this board
        const offset = y - box.top - box.height / 2;

        // If mouse is above the center of this board and this is the closest so far
        if (offset < 0 && offset > closest.offset) {
            return { offset: offset, element: child };
        } else {
            return closest; // Keep the previous closest element
        }
    }, { offset: Number.NEGATIVE_INFINITY }).element; // Start with negative infinity for comparison
}

/**
 * Creates or reuses a drop indicator element
 * The drop indicator is the green line that shows where the board will be placed
 * 
 * @returns {HTMLElement} - The drop indicator element
 */
function getOrCreateDropIndicator() {
    // Try to find an existing drop indicator
    let indicator = document.querySelector('.drop-indicator');

    // If no indicator exists, create a new one
    if (!indicator) {
        indicator = document.createElement('div');
        indicator.className = 'drop-indicator'; // Apply CSS styling
    }

    return indicator;
}

/**
 * Determines which bookmark element the dragged bookmark should be inserted after
 * Based on the vertical mouse position (y-coordinate)
 * 
 * @param {HTMLElement} container - The bookmark list container element
 * @param {number} y - The current Y coordinate of the mouse cursor
 * @returns {HTMLElement|null} - The bookmark element to insert after, or null for end of list
 */
function getBookmarkDragAfterElement(container, y) {
    // Get all bookmark elements in this list (excluding the one being dragged)
    // FIX [Issue #1]: Don't exclude .selected - causes wrong position calculation during multi-select drag
    const draggableElements = [...container.querySelectorAll('li[data-bookmark-id]:not(.dragging)')];

    // Use reduce to find the closest bookmark element based on mouse position
    return draggableElements.reduce((closest, child) => {
        // Get the position and dimensions of the current bookmark element
        const box = child.getBoundingClientRect();

        // Calculate offset from mouse Y position to the center of this bookmark
        const offset = y - box.top - box.height / 2;

        // If mouse is above the center of this bookmark and this is the closest so far
        if (offset < 0 && offset > closest.offset) {
            return { offset: offset, element: child };
        } else {
            return closest; // Keep the previous closest element
        }
    }, { offset: Number.NEGATIVE_INFINITY }).element; // Start with negative infinity for comparison
}

/**
 * Creates or reuses a bookmark drop indicator element
 * The drop indicator is the green line that shows where the bookmark will be placed
 * 
 * @returns {HTMLElement} - The bookmark drop indicator element
 */
function getOrCreateBookmarkDropIndicator() {
    // Try to find an existing bookmark drop indicator
    let indicator = document.querySelector('.bookmark-drop-indicator');

    // If no indicator exists, create a new one
    if (!indicator) {
        indicator = document.createElement('div');
        indicator.className = 'bookmark-drop-indicator'; // Apply CSS styling
    }

    return indicator;
}

/*
========================================
ADD BOOKMARK FUNCTIONALITY
========================================
Functions for adding new bookmarks to boards
*/

// Global variable to track which board we're adding to
let currentBoardId = null;

function getDescriptionCharactersRemaining(descriptionText = '') {
    return BOOKMARK_DESCRIPTION_MAX_LENGTH - descriptionText.length;
}

function updateDescriptionRemainingCounter(textarea, counterElement) {
    if (!counterElement) return;
    const currentValue = textarea && typeof textarea.value === 'string' ? textarea.value : '';
    counterElement.textContent = String(getDescriptionCharactersRemaining(currentValue));
}

function initializeDescriptionRemainingCounter(textarea, counterElement) {
    if (!textarea || !counterElement) return;
    textarea.maxLength = BOOKMARK_DESCRIPTION_MAX_LENGTH;
    if (textarea.dataset.descriptionCounterBound !== 'true') {
        textarea.addEventListener('input', () => {
            updateDescriptionRemainingCounter(textarea, counterElement);
        });
        textarea.dataset.descriptionCounterBound = 'true';
    }
    updateDescriptionRemainingCounter(textarea, counterElement);
}

// Show inline link input inside a board (replaces modal)
// Two-state UI: URL input first, then auto-fetch title and show title textarea
function showInlineLinkInput(boardId) {
    // Block in read-only mode (grace/expired status)
    if (!canModify()) return;

    // Set flag to protect input from being wiped by loadBoardsFromDatabase
    _isInlineInputActive = true;

    // Remove any existing inline link input
    document.querySelectorAll('.inline-link-input').forEach(el => el.remove());

    // Find the board element
    const boardElement = document.querySelector(`.board[data-board-id="${boardId}"]`);
    if (!boardElement) {
        _isInlineInputActive = false;
        return;
    }

    // Find the bookmark list container (ul.board-links)
    const bookmarkList = boardElement.querySelector('.board-links');
    if (!bookmarkList) {
        _isInlineInputActive = false;
        return;
    }

    // Store current board ID
    currentBoardId = boardId;

    // Create inline input element - State 1: URL only
    const inputContainer = document.createElement('div');
    inputContainer.className = 'inline-link-input';
    inputContainer.innerHTML = `
        <div class="inline-link-input-fields">
            <div class="url-display"></div>
            <input type="text" class="url-input" placeholder="https://example.com" autofocus>
            <div class="loading-indicator">
                <div class="loading-spinner"></div>
                <span>Fetching title...</span>
            </div>
            <textarea class="title-textarea" placeholder="Enter a title for this link"></textarea>
            <div class="note-input-wrap">
                <textarea class="note-textarea" placeholder="Optional description (shown below title)"></textarea>
                <span class="description-char-remaining" aria-live="polite" aria-atomic="true"></span>
            </div>
        </div>
        <div class="inline-link-input-buttons">
            <button class="inline-link-input-btn">Add Link</button>
            <button class="inline-link-input-cancel">Cancel</button>
        </div>
    `;

    // Append to bookmark list
    bookmarkList.appendChild(inputContainer);

    // Get elements
    const urlInput = inputContainer.querySelector('.url-input');
    const urlDisplay = inputContainer.querySelector('.url-display');
    const titleTextarea = inputContainer.querySelector('.title-textarea');
    const noteTextarea = inputContainer.querySelector('.note-textarea');
    const noteRemainingCounter = inputContainer.querySelector('.description-char-remaining');
    const addBtn = inputContainer.querySelector('.inline-link-input-btn');
    const cancelBtn = inputContainer.querySelector('.inline-link-input-cancel');

    initializeDescriptionRemainingCounter(noteTextarea, noteRemainingCounter);

    // Track state
    let currentUrl = '';
    let isInTitleState = false;
    let userInteractedWithTitle = false;

    // Focus the URL input
    setTimeout(() => urlInput.focus(), 50);

    // Normalize and validate URL
    function normalizeUrl(url) {
        url = url.trim();
        if (!url) return null;

        // Add https:// if no protocol
        if (!url.match(/^https?:\/\//i)) {
            url = 'https://' + url;
        }

        try {
            new URL(url); // Validate
            return url;
        } catch {
            return null;
        }
    }

    // Fetch title from background.js with timeout to prevent hanging
    async function fetchTitle(url) {
        return fetchPageTitleFromBackground(url);
    }

    // Transition to title state
    async function transitionToTitleState() {
        const url = normalizeUrl(urlInput.value);
        if (!url) {
            urlInput.focus();
            return;
        }

        currentUrl = url;
        userInteractedWithTitle = false; // Reset before fetch

        // Show loading state
        inputContainer.classList.add('state-loading');
        urlDisplay.textContent = url;

        // Fetch title
        const result = await fetchTitle(url);

        // Remove loading, show title state
        inputContainer.classList.remove('state-loading');
        inputContainer.classList.add('state-title');
        isInTitleState = true;

        // Set title from fetch, with site-name fallback when fetch fails.
        const fetchedTitle = (result?.success && typeof result.title === 'string')
            ? result.title.trim()
            : '';
        titleTextarea.value = fetchedTitle || getFallbackTitleFromUrl(url);
        if (noteTextarea) {
            noteTextarea.value = '';
            updateDescriptionRemainingCounter(noteTextarea, noteRemainingCounter);
        }

        // Focus title textarea (only select if user hasn't interacted yet)
        setTimeout(() => {
            titleTextarea.focus();
            if (!userInteractedWithTitle) {
                titleTextarea.select();
            }
        }, 50);
    }

    // Handle adding the link
    async function addLink() {
        if (!isInTitleState) {
            // Still in URL state, transition first
            await transitionToTitleState();
            return;
        }

        let title = titleTextarea.value.trim();

        // Use URL as title if no title provided
        if (!title) {
            title = getFallbackTitleFromUrl(currentUrl);
        }

        const note = noteTextarea ? noteTextarea.value : null;

        // Add the bookmark
        await addNewBookmark(title, currentUrl, note);

        // Remove the input and allow pending reloads
        currentBoardId = null;
        completeInlineInput();
    }

    // Handle cancel
    function cancel() {
        inputContainer.remove();
        currentBoardId = null;
        // Allow pending reloads
        completeInlineInput();
    }

    // URL input: Enter triggers title fetch, Escape cancels
    urlInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            transitionToTitleState();
        } else if (e.key === 'Escape') {
            cancel();
        }
    });

    // URL input: blur triggers title fetch (if has value)
    urlInput.addEventListener('blur', () => {
        // Small delay to check if focus moved to cancel button
        setTimeout(() => {
            if (urlInput.value.trim() && !isInTitleState &&
                document.activeElement !== cancelBtn) {
                transitionToTitleState();
            }
        }, 100);
    });

    // Title textarea: Enter submits (Shift+Enter for newline), Escape cancels
    titleTextarea.addEventListener('keydown', (e) => {
        userInteractedWithTitle = true;
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            addLink();
        } else if (e.key === 'Escape') {
            cancel();
        }
    });

    // Track user interaction to prevent re-selecting after fetch
    titleTextarea.addEventListener('mousedown', () => {
        userInteractedWithTitle = true;
    });

    // Note textarea: Escape cancels, Ctrl/Cmd+Enter submits
    noteTextarea.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            cancel();
            return;
        }
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            addLink();
        }
    });

    // Button clicks
    addBtn.addEventListener('click', addLink);
    cancelBtn.addEventListener('click', cancel);

    // Prevent drag events from interfering
    inputContainer.addEventListener('mousedown', (e) => {
        e.stopPropagation();
    });
}

// Open the add bookmark modal (kept for compatibility)
function openAddBookmarkModal(boardId) {
    // Use inline input instead
    showInlineLinkInput(boardId);
}

// Close the add bookmark modal
function closeAddBookmarkModal() {
    const modal = document.getElementById('addBookmarkModal');
    modal.classList.remove('active');
    currentBoardId = null;

    // Reset form
    document.getElementById('addBookmarkForm').reset();
    
    // Hide Privacy Analysis
    const analysisContainer = document.getElementById('addBookmarkPrivacyAnalysis');
    if (analysisContainer) {
        analysisContainer.classList.add('hidden');
        analysisContainer.innerHTML = '';
    }

    updateDescriptionRemainingCounter(
        document.getElementById('bookmarkDescription'),
        document.getElementById('bookmarkDescriptionRemaining')
    );
}

async function getReviewPromptUserId() {
    return getCurrentStoredUserId();
}

async function sendReviewPromptMessage(action, payload = {}) {
    if (!(typeof chrome !== 'undefined' && chrome.runtime?.sendMessage)) {
        return null;
    }
    try {
        return await chrome.runtime.sendMessage({
            action,
            ...payload
        });
    } catch (error) {
        console.warn(`[ReviewPrompt] ${action} message failed:`, error);
        return null;
    }
}

function isKnownReviewPromptSubscriptionStatus(status) {
    return status === 'trial' ||
        status === 'active' ||
        status === 'grace' ||
        status === 'expired';
}

function isKnownSettingsSubscriptionStatus(status) {
    return status === 'trial' ||
        status === 'active' ||
        status === 'cancelled' ||
        status === 'grace' ||
        status === 'expired';
}

function isReviewPromptSubscriptionEligibleStatus(status) {
    return status === 'active';
}

function isStrictlyActivePaidReviewSubscription(subscription) {
    if (!subscription || typeof subscription !== 'object') return false;
    return String(subscription.status || '').trim().toLowerCase() === 'active';
}

async function canShowReviewPromptForSubscription() {
    let status = isKnownReviewPromptSubscriptionStatus(window.subscriptionStatus)
        ? window.subscriptionStatus
        : null;
    let daysLeft = Number.isFinite(window.subscriptionDaysLeft)
        ? Math.floor(window.subscriptionDaysLeft)
        : null;
    let subscription = (window.subscriptionData && typeof window.subscriptionData === 'object')
        ? window.subscriptionData
        : null;

    if (!status && isKnownReviewPromptSubscriptionStatus(window.cachedSubscriptionStatus)) {
        status = window.cachedSubscriptionStatus;
    }
    if (daysLeft === null && Number.isFinite(window.cachedSubscriptionDaysLeft)) {
        daysLeft = Math.floor(window.cachedSubscriptionDaysLeft);
    }

    if (!status && typeof chrome !== 'undefined' && chrome.storage?.local) {
        try {
            const result = await chrome.storage.local.get([
                'subscriptionStatus',
                'subscriptionDaysLeft',
                'subscriptionData',
                'subscriptionLastKnownState'
            ]);
            if (isKnownReviewPromptSubscriptionStatus(result.subscriptionStatus)) {
                status = result.subscriptionStatus;
            } else if (isKnownReviewPromptSubscriptionStatus(result.subscriptionLastKnownState?.status)) {
                status = result.subscriptionLastKnownState.status;
            }
            if (!subscription && result.subscriptionData && typeof result.subscriptionData === 'object') {
                subscription = result.subscriptionData;
            } else if (!subscription && result.subscriptionLastKnownState?.subscription && typeof result.subscriptionLastKnownState.subscription === 'object') {
                subscription = result.subscriptionLastKnownState.subscription;
            }
            if (daysLeft === null) {
                if (Number.isFinite(result.subscriptionDaysLeft)) {
                    daysLeft = Math.floor(result.subscriptionDaysLeft);
                } else if (Number.isFinite(result.subscriptionLastKnownState?.daysLeft)) {
                    daysLeft = Math.floor(result.subscriptionLastKnownState.daysLeft);
                }
            }
        } catch (error) {
            console.warn('[ReviewPrompt] Failed to read subscription status for review gating:', error);
        }
    }

    if (
        status === 'trial'
        && daysLeft !== null
        && daysLeft <= REVIEW_PROMPT_TRIAL_WARNING_DAYS_THRESHOLD
    ) {
        return false;
    }

    if (!isReviewPromptSubscriptionEligibleStatus(status)) {
        return false;
    }

    return isStrictlyActivePaidReviewSubscription(subscription);
}

function isReviewPromptModalActive() {
    const modal = document.getElementById(REVIEW_PROMPT_MODAL_ID);
    return !!(modal && modal.classList.contains('active'));
}

function isReviewPromptUiBlocked() {
    if (!initialAuthCompleted) return true;
    if (document.visibilityState !== 'visible') return true;
    if (!document.hasFocus()) return true;
    if (document.body?.classList?.contains('not-authenticated')) return true;
    if (_crossTabLoginInProgress) return true;
    if (quickTourState?.active) return true;

    if (typeof isSearchOverlayOpen === 'function' && isSearchOverlayOpen()) {
        return true;
    }

    if (document.querySelector('.modal-overlay.active:not(#reviewPromptModal)')) {
        return true;
    }

    const importPopup = document.getElementById('importPopup');
    if (importPopup && importPopup.classList.contains('active')) {
        return true;
    }

    const wallpaperPopup = document.getElementById('wallpaperPopup');
    if (wallpaperPopup && wallpaperPopup.classList.contains('active')) {
        return true;
    }

    return false;
}

function openReviewPromptModal(userId = null) {
    const modal = document.getElementById(REVIEW_PROMPT_MODAL_ID);
    const promptUserId = normalizeRuntimeUserId(userId);
    if (!modal) {
        activeReviewPromptUserId = promptUserId;
        return;
    }
    if (modal.classList.contains('active')) {
        activeReviewPromptUserId = promptUserId;
        return;
    }
    activeReviewPromptUserId = promptUserId;
    modal.classList.add('active');

    const primaryBtn = document.getElementById('reviewPromptLeaveReviewBtn');
    if (primaryBtn) {
        primaryBtn.focus();
    }
}

async function closeReviewPromptModal(options = {}) {
    const { userAction = null, recordDismiss = false } = options;
    const modal = document.getElementById(REVIEW_PROMPT_MODAL_ID);
    if (!modal) {
        activeReviewPromptUserId = null;
        return;
    }

    const wasActive = modal.classList.contains('active');
    modal.classList.remove('active');
    const promptUserId = normalizeRuntimeUserId(activeReviewPromptUserId);
    activeReviewPromptUserId = null;
    if (!wasActive) return;

    const resolvedAction = userAction || (recordDismiss ? 'dismiss' : null);
    if (!resolvedAction) return;

    const userId = promptUserId || await getReviewPromptUserId();
    if (!userId) return;
    await sendReviewPromptMessage('reviewPromptHandleAction', {
        userId,
        userAction: resolvedAction
    });
}

async function trackReviewPromptManualBookmark(count = 1) {
    const safeCount = Number.isFinite(Number(count))
        ? Math.max(0, Math.floor(Number(count)))
        : 0;
    if (safeCount < 1) return;

    const userId = await getReviewPromptUserId();
    if (!userId) return;

    await sendReviewPromptMessage('reviewPromptTrackManualBookmark', {
        userId,
        count: safeCount
    });
}

async function reportReviewPromptIssue(issueType = 'general') {
    const safeIssueType = (typeof issueType === 'string' && issueType.trim())
        ? issueType.trim().slice(0, 64)
        : 'general';
    const userId = await getReviewPromptUserId();
    if (!userId) return;

    const now = Date.now();
    const issueKey = `${userId}:${safeIssueType}`;
    const lastReportedAt = reviewPromptIssueCooldownByType.get(issueKey) || 0;
    if ((now - lastReportedAt) < REVIEW_PROMPT_ISSUE_REPORT_COOLDOWN_MS) {
        return;
    }
    reviewPromptIssueCooldownByType.set(issueKey, now);

    await sendReviewPromptMessage('reviewPromptTrackIssue', {
        userId,
        issueType: safeIssueType
    });
}

async function maybeShowReviewPrompt(trigger = 'manual_bookmark_add') {
    if (reviewPromptCheckInFlight) return;
    if (isReviewPromptModalActive()) return;
    if (isReviewPromptUiBlocked()) return;
    if (!await canShowReviewPromptForSubscription()) return;

    const userId = await getReviewPromptUserId();
    if (!userId) return;

    reviewPromptCheckInFlight = true;
    try {
        const response = await sendReviewPromptMessage('reviewPromptRequestDisplay', {
            userId,
            trigger
        });
        if (!response?.success || !response.showPrompt) return;

        // Re-check just before rendering in case UI state changed while waiting on background response.
        if (isReviewPromptUiBlocked()) return;
        const latestUserId = await getReviewPromptUserId();
        if (!latestUserId || latestUserId !== userId) return;
        openReviewPromptModal(userId);
    } finally {
        reviewPromptCheckInFlight = false;
    }
}

async function handleReviewPromptLeaveReview() {
    await closeReviewPromptModal({ userAction: 'review_clicked' });
    const reviewUrl = REVIEW_PROMPT_CWS_REVIEW_URL;
    if (typeof chrome !== 'undefined' && chrome.tabs?.create) {
        chrome.tabs.create({ url: reviewUrl });
        return;
    }
    window.open(reviewUrl, '_blank', 'noopener');
}

async function handleReviewPromptNotNow() {
    await closeReviewPromptModal({ userAction: 'not_now' });
}

// Add new bookmark to database (with transaction to prevent race conditions)
async function addNewBookmark(title, url, description) {
    // FIX: Check if user can modify (subscription status check)
    if (!canModify()) {
        showGlassToast('Cannot add bookmarks in read-only mode.', 'warning');
        return;
    }

    // Prevent duplicate submissions
    if (isAddingBookmark) {
        console.warn('Bookmark add already in progress');
        return;
    }

    isAddingBookmark = true;

    try {
        // Validate URL
        const safeUrl = sanitizeUrl(url);
        if (!safeUrl) {
            showGlassToast('Invalid or unsafe URL. Please enter a valid URL.', 'warning');
            return;
        }

        const boardId = currentBoardId;
        if (!boardId) {
            console.error('No board selected for bookmark');
            return;
        }

        // Get all existing bookmarks in this board to find max order (exclude soft-deleted)
        const existingBookmarks = await db.bookmarks
            .where('boardId')
            .equals(boardId)
            .filter(b => !b.deletedAt)
            .toArray();

        // Calculate the next order (add at bottom)
        const maxOrder = existingBookmarks.length > 0
            ? Math.max(...existingBookmarks.map(b => b.order)) + 1
            : 0;

        const resolvedTitle = (typeof title === 'string' ? title.trim() : '') || getFallbackTitleFromUrl(safeUrl);

        // Create new bookmark object at the bottom of the list
        const newBookmark = {
            boardId: boardId,
            title: resolvedTitle || 'Untitled',
            url: safeUrl,
            description: sanitizeBookmarkNote(description),
            order: maxOrder
        };

        // Add to database using wrapper (triggers sync)
        const bookmarkId = await addBookmark(newBookmark);
        if (!bookmarkId) return;

        // Update only the bookmarks in the board (preserves position)
        await updateBoardBookmarks(boardId);

        emitQuickTourEvent('bookmark_created', {
            bookmarkId,
            boardId
        });
        // Review prompt gating: count only manual adds (imports do not call this path).
        try {
            await trackReviewPromptManualBookmark(1);
            await maybeShowReviewPrompt('manual_bookmark_add');
        } catch (reviewPromptError) {
            console.warn('[ReviewPrompt] Failed to process manual bookmark event:', reviewPromptError);
        }

    } catch (error) {
        console.error('Failed to add bookmark:', error);
        showGlassToast('Failed to add bookmark. Please try again.', 'error');
    } finally {
        isAddingBookmark = false;
    }
}

// Update bookmarks in a board without changing its position
async function updateBoardBookmarks(boardId) {
    try {
        // Find the existing board element
        const boardElement = document.querySelector(`[data-board-id="${boardId}"]`);
        if (!boardElement) return;

        // Get updated bookmarks from database (exclude soft-deleted)
        const bookmarks = await db.bookmarks
            .where('boardId')
            .equals(boardId)
            .filter(b => !b.deletedAt)
            .sortBy('order');
        const visibleBookmarks = getVisibleBookmarksForBoard(boardId, bookmarks);
        const bookmarkToggleControl = getBoardBookmarkToggleControl(boardId, bookmarks.length);

        // Find the existing bookmarks list
        const existingBookmarksList = boardElement.querySelector('.board-links');
        if (!existingBookmarksList) return;

        // Re-render bookmarks using component
        const bookmarksHTML = visibleBookmarks
            .map(bookmark => BookmarkComponent.render(bookmark))
            .join('');
        
        // Use Idiomorph if available for smoother update, otherwise innerHTML
        if (window.Idiomorph) {
            window.Idiomorph.morph(existingBookmarksList, `<ul class="board-links">${bookmarksHTML}</ul>`, {
                morphStyle: 'innerHTML'
            });
        } else {
            existingBookmarksList.innerHTML = bookmarksHTML;
        }

        // Keep the board-level expand/collapse control in sync
        let existingToggleButton = boardElement.querySelector('.board-show-remaining-btn');
        
        if (bookmarkToggleControl) {
            const buttonHTML = `
                <button class="board-show-remaining-btn" 
                        data-action="${bookmarkToggleControl.action}" 
                        data-board-id="${escapeHTML(boardId)}">
                    ${bookmarkToggleControl.label}
                </button>
            `.trim();

            if (existingToggleButton) {
                if (window.Idiomorph) {
                    window.Idiomorph.morph(existingToggleButton, buttonHTML);
                } else {
                    const temp = document.createElement('div');
                    temp.innerHTML = buttonHTML;
                    existingToggleButton.replaceWith(temp.firstChild);
                }
            } else {
                const temp = document.createElement('div');
                temp.innerHTML = buttonHTML;
                boardElement.appendChild(temp.firstChild);
            }
        } else if (existingToggleButton) {
            existingToggleButton.remove();
        }

        // Initialize favicons for new elements
        if (typeof populateFavicons === 'function') {
            await populateFavicons();
        }

        // Reattach drag-drop listeners to the newly created bookmark elements
        if (typeof attachDragDropListeners === 'function') {
            attachDragDropListeners();
        }

        // Apply open in new tab setting to newly created links
        if (typeof applyOpenInNewTabSetting === 'function') {
            applyOpenInNewTabSetting(openLinksInNewTab);
        }

        if (typeof refreshSearchIfOpen === 'function') {
            await refreshSearchIfOpen();
        }

    } catch (error) {
        console.error('Failed to update board bookmarks:', error);
    }
}

// Validate URL format
function isValidUrl(string) {
    try {
        new URL(string);
        return true;
    } catch (_) {
        return false;
    }
}

// PSL-aware registrable domain parsing for fallback title generation.
// This uses a lightweight PSL rule engine (exact, wildcard, exception rules)
// plus common ccTLD category rules for better coverage than a fixed TLD list.
const TITLE_PSL_EXACT_RULES = new Set([
    // UK
    'ac.uk', 'co.uk', 'gov.uk', 'ltd.uk', 'me.uk', 'net.uk', 'org.uk', 'plc.uk', 'sch.uk',
    // AU
    'asn.au', 'com.au', 'edu.au', 'gov.au', 'id.au', 'net.au', 'org.au',
    // NZ
    'ac.nz', 'co.nz', 'geek.nz', 'gen.nz', 'govt.nz', 'iwi.nz', 'kiwi.nz', 'maori.nz', 'net.nz', 'org.nz',
    // IN
    'ac.in', 'co.in', 'edu.in', 'firm.in', 'gen.in', 'gov.in', 'ind.in', 'mil.in', 'net.in', 'nic.in', 'org.in', 'res.in',
    // JP
    'ac.jp', 'ad.jp', 'co.jp', 'ed.jp', 'go.jp', 'gr.jp', 'lg.jp', 'ne.jp', 'or.jp',
    // BR
    'com.br', 'edu.br', 'gov.br', 'net.br', 'org.br',
    // ZA
    'ac.za', 'co.za', 'edu.za', 'gov.za', 'net.za', 'org.za',
    // MX
    'com.mx', 'edu.mx', 'gob.mx', 'net.mx', 'org.mx',
    // KR
    'ac.kr', 'co.kr', 'go.kr', 'mil.kr', 'ne.kr', 'or.kr', 'pe.kr', 're.kr',
    // SG
    'com.sg', 'edu.sg', 'gov.sg', 'net.sg', 'org.sg', 'per.sg',
    // MY
    'com.my', 'edu.my', 'gov.my', 'net.my', 'org.my',
    // HK
    'com.hk', 'edu.hk', 'gov.hk', 'idv.hk', 'net.hk', 'org.hk',
    // TR
    'bel.tr', 'com.tr', 'edu.tr', 'gov.tr', 'net.tr', 'org.tr',
    // CN
    'ac.cn', 'com.cn', 'edu.cn', 'gov.cn', 'mil.cn', 'net.cn', 'org.cn'
]);

const TITLE_PSL_WILDCARD_RULES = new Set([
    // Public Suffix List wildcard-style examples
    'ck'
]);

const TITLE_PSL_EXCEPTION_RULES = new Set([
    // Exception for *.ck in PSL
    'www.ck'
]);

const TITLE_PSL_COMMON_CCTLD_SLD = new Set([
    'ac', 'asn', 'bel', 'co', 'com', 'edu', 'firm', 'gen', 'go',
    'gob', 'gov', 'id', 'idv', 'ind', 'ltd', 'mil', 'name', 'net',
    'ne', 'nic', 'nom', 'or', 'org', 'plc', 'res', 'sch'
]);

const TITLE_GENERIC_PATH_TOKENS = new Set([
    'about', 'account', 'accounts', 'admin', 'api', 'app', 'apps',
    'auth', 'callback', 'content', 'd', 'dashboard', 'default',
    'edit', 'en', 'feed', 'home', 'i', 'id', 'index', 'item', 'items',
    'login', 'logout', 'm', 'mobile', 'new', 'page', 'pages', 'p',
    'post', 'posts', 'profile', 'root', 'settings', 'share', 'u',
    'user', 'users', 'v', 'view', 'www'
]);

const TITLE_ACRONYM_TOKENS = new Set([
    'ai', 'api', 'cdn', 'crm', 'cpu', 'css', 'dns', 'faq', 'gpu',
    'html', 'http', 'https', 'id', 'ip', 'json', 'oauth', 'pdf',
    'seo', 'sdk', 'sms', 'sql', 'ssh', 'ssl', 'sso', 'tcp', 'tls',
    'ui', 'uid', 'url', 'ux', 'xml', 'yaml'
]);

const TITLE_MINOR_WORDS = new Set([
    'a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'of',
    'on', 'or', 'the', 'to', 'vs', 'via'
]);

const TITLE_QUERY_PRIORITY_KEYS = [
    'q', 'query', 'search', 'term', 'keyword', 'keywords',
    'topic', 'section', 'tab', 'view', 'screen', 'page',
    'name', 'title', 'resource', 'resource_id', 'doc', 'docid',
    'project', 'repo', 'board', 'folder', 'category'
];

const TITLE_GENERIC_QUERY_TOKENS = new Set([
    'all', 'any', 'default', 'false', 'id', 'item', 'items',
    'link', 'list', 'none', 'null', 'page', 'q', 'search',
    'tab', 'true', 'undefined', 'url', 'view'
]);

function getPublicSuffixLengthFromPsl(hostLabels) {
    if (!Array.isArray(hostLabels) || hostLabels.length === 0) return 0;

    // Exception rules take precedence and remove one left-most label.
    let exceptionLength = 0;
    for (let i = 0; i < hostLabels.length; i++) {
        const candidate = hostLabels.slice(i).join('.');
        if (TITLE_PSL_EXCEPTION_RULES.has(candidate)) {
            exceptionLength = Math.max(exceptionLength, hostLabels.length - i);
        }
    }
    if (exceptionLength > 0) {
        return Math.max(1, exceptionLength - 1);
    }

    let matchedLength = 1; // Default PSL rule: "*"

    // Exact rules
    for (let i = 0; i < hostLabels.length; i++) {
        const candidate = hostLabels.slice(i).join('.');
        if (TITLE_PSL_EXACT_RULES.has(candidate)) {
            matchedLength = Math.max(matchedLength, hostLabels.length - i);
        }
    }

    // Wildcard rules
    for (let i = 0; i < hostLabels.length - 1; i++) {
        const wildcardBase = hostLabels.slice(i + 1).join('.');
        if (TITLE_PSL_WILDCARD_RULES.has(wildcardBase)) {
            matchedLength = Math.max(matchedLength, hostLabels.length - i);
        }
    }

    // Coverage booster for common ccTLD structures (e.g., gov.in, com.tr).
    if (hostLabels.length >= 2) {
        const tld = hostLabels[hostLabels.length - 1];
        const sld = hostLabels[hostLabels.length - 2];
        if (tld.length === 2 && TITLE_PSL_COMMON_CCTLD_SLD.has(sld)) {
            matchedLength = Math.max(matchedLength, 2);
        }
    }

    return Math.min(matchedLength, hostLabels.length);
}

function parseRegistrableDomain(hostname) {
    const labels = (hostname || '').toLowerCase().split('.').filter(Boolean);
    if (labels.length === 0) return null;

    const publicSuffixLength = getPublicSuffixLengthFromPsl(labels);
    const registrableIndex = labels.length - publicSuffixLength - 1;

    if (registrableIndex < 0) {
        return {
            registrableLabel: labels[0],
            registrableDomain: labels.join('.'),
            subdomainLabels: []
        };
    }

    return {
        registrableLabel: labels[registrableIndex],
        registrableDomain: labels.slice(registrableIndex).join('.'),
        subdomainLabels: labels.slice(0, registrableIndex)
    };
}

function formatFallbackTitleWord(word, index) {
    const safeWord = (word || '').trim();
    if (!safeWord) return '';

    const lowered = safeWord.toLowerCase();

    // Keep common technical acronyms fully uppercase.
    if (TITLE_ACRONYM_TOKENS.has(lowered)) {
        return lowered.toUpperCase();
    }

    // Preserve readability for auth/product terms like 2fa, 3ds, 4xx.
    if (/^\d+[a-z]{2,4}$/i.test(safeWord)) {
        return safeWord.replace(/^(\d+)([a-z]{2,4})$/i, (_, digits, letters) => `${digits}${letters.toUpperCase()}`);
    }

    if (index > 0 && TITLE_MINOR_WORDS.has(lowered)) {
        return lowered;
    }

    return lowered.charAt(0).toUpperCase() + lowered.slice(1);
}

function formatFallbackTitleToken(token) {
    const safeToken = (token || '').trim();
    if (!safeToken) return 'Untitled';

    const withSpaces = safeToken
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[._-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (!withSpaces) return 'Untitled';

    const words = withSpaces.split(' ').filter(Boolean);
    if (words.length === 0) return 'Untitled';

    return words.map((word, index) => formatFallbackTitleWord(word, index)).join(' ');
}

function isGenericSubdomainToken(token) {
    const t = (token || '').toLowerCase();
    if (!t) return true;

    // Generic routing/infra subdomains that usually don't improve readability.
    const genericTokens = new Set([
        'm', 'mobile', 'www', 'ww1', 'ww2', 'w1', 'w2',
        'app', 'apps', 'api', 'cdn', 'static', 'assets',
        'img', 'images', 'media', 'edge', 'amp'
    ]);

    return genericTokens.has(t);
}

function sanitizePathToken(token) {
    if (!token) return '';

    let decoded = token;
    try {
        decoded = decodeURIComponent(token);
    } catch (_) {
        // Keep original token if decode fails
    }

    return decoded
        .trim()
        .toLowerCase()
        .replace(/\.[a-z0-9]{1,6}$/i, '');
}

function isOpaquePathToken(token) {
    if (!token) return true;
    if (/^\d+$/.test(token)) return true;
    if (/^[a-f0-9]{12,}$/i.test(token)) return true;
    if (/^[a-z0-9]{20,}$/i.test(token) && !token.includes('-') && !token.includes('_')) return true;
    return false;
}

function isMeaningfulContextToken(token, options = {}) {
    const normalized = sanitizePathToken(token);
    const source = options?.source || 'general';
    if (!normalized) return false;
    if (normalized.length <= 1) return false;
    if (TITLE_GENERIC_PATH_TOKENS.has(normalized)) return false;
    if (source === 'query' && TITLE_GENERIC_QUERY_TOKENS.has(normalized)) return false;
    if (isGenericSubdomainToken(normalized)) return false;
    if (isOpaquePathToken(normalized)) return false;
    return true;
}

function getPathFallbackToken(pathname) {
    if (!pathname || typeof pathname !== 'string') return '';

    const pathSegments = pathname
        .split('/')
        .map(sanitizePathToken)
        .filter(Boolean);

    for (const segment of pathSegments) {
        if (TITLE_GENERIC_PATH_TOKENS.has(segment)) continue;
        if (isOpaquePathToken(segment)) continue;
        return segment;
    }

    return '';
}

function tokenizeQueryValue(value) {
    if (!value || typeof value !== 'string') return [];

    let decoded = value;
    try {
        decoded = decodeURIComponent(value);
    } catch (_) {
        // Keep original value if decode fails
    }

    const normalized = decoded
        .replace(/\+/g, ' ')
        .replace(/[()[\]{}]/g, ' ')
        .trim();

    if (!normalized) return [];

    const tokens = [];

    // Some params embed full URLs (e.g. redirect targets). Extract useful host/path tokens.
    try {
        const embeddedUrl = new URL(normalized);
        const embeddedHost = (embeddedUrl.hostname || '').replace(/^www\./i, '').toLowerCase();
        if (embeddedHost) {
            const embeddedDomainInfo = parseRegistrableDomain(embeddedHost);
            const embeddedSiteToken = sanitizePathToken(
                embeddedDomainInfo?.registrableLabel || embeddedHost.split('.')[0] || ''
            );
            if (embeddedSiteToken) tokens.push(embeddedSiteToken);

            const embeddedPathToken = getPathFallbackToken(embeddedUrl.pathname || '');
            if (embeddedPathToken) tokens.push(embeddedPathToken);
        }
    } catch (_) {
        // Not an embedded URL; continue with token splitting.
    }

    const roughParts = normalized.split(/[\/\\?&#=,:;|]+|\s+/);
    for (const part of roughParts) {
        const cleaned = sanitizePathToken(part);
        if (!cleaned) continue;

        const dotSeparated = cleaned.split('.').map(sanitizePathToken).filter(Boolean);
        if (dotSeparated.length > 1) {
            tokens.push(...dotSeparated);
        } else {
            tokens.push(cleaned);
        }
    }

    return [...new Set(tokens)];
}

function getQueryFallbackToken(searchParams) {
    if (!searchParams || typeof searchParams.entries !== 'function') return '';

    const entries = Array.from(searchParams.entries());
    if (entries.length === 0) return '';

    const getPriority = (key) => {
        const normalizedKey = (key || '').toLowerCase();
        const idx = TITLE_QUERY_PRIORITY_KEYS.indexOf(normalizedKey);
        return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
    };

    entries.sort((a, b) => {
        const priorityA = getPriority(a[0]);
        const priorityB = getPriority(b[0]);
        if (priorityA !== priorityB) return priorityA - priorityB;
        return (a[0] || '').localeCompare(b[0] || '');
    });

    for (const [rawKey, rawValue] of entries) {
        const valueTokens = tokenizeQueryValue(rawValue);
        for (const token of valueTokens) {
            if (TITLE_GENERIC_QUERY_TOKENS.has(token)) continue;
            if (isMeaningfulContextToken(token, { source: 'query' })) return token;
        }

        const keyToken = sanitizePathToken(rawKey);
        if (
            keyToken &&
            !TITLE_GENERIC_QUERY_TOKENS.has(keyToken) &&
            isMeaningfulContextToken(keyToken, { source: 'query' })
        ) {
            return keyToken;
        }
    }

    return '';
}

// Final fallback title resolver: returns a readable site name from URL.
// Examples:
// https://x.com -> "X"
// https://search.google.com -> "Google Search"
// https://www.google.com/maps -> "Google Maps"
function getFallbackTitleFromUrl(url) {
    if (!url || typeof url !== 'string') return 'Untitled';

    try {
        const parsed = new URL(url);
        const hostname = (parsed.hostname || '').replace(/^www\./i, '').toLowerCase();
        if (!hostname) return 'Untitled';

        const hostParts = hostname.split('.').filter(Boolean);
        const isIPv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
        const isIPv6 = hostname.includes(':');

        if (isIPv4) {
            return hostname;
        }

        if (isIPv6) {
            return hostname.replace(/^\[|\]$/g, '');
        }

        if (hostParts.length === 1) {
            return formatFallbackTitleToken(hostParts[0] || hostname);
        }

        const domainInfo = parseRegistrableDomain(hostname);
        const siteToken = domainInfo?.registrableLabel || hostParts[0];
        const siteTitle = formatFallbackTitleToken(siteToken);

        // For subdomains, append a readable product/context token when meaningful.
        // e.g., search.google.com -> "Google Search"
        const subdomainParts = domainInfo?.subdomainLabels || [];
        let subdomainToken = '';
        if (subdomainParts.length > 0) {
            // Prefer nearest subdomain to the registrable domain (often most descriptive).
            for (let i = subdomainParts.length - 1; i >= 0; i--) {
                const candidate = subdomainParts[i];
                if (isMeaningfulContextToken(candidate)) {
                    subdomainToken = candidate;
                    break;
                }
            }
        }

        // If no useful subdomain context, use first meaningful path token.
        let contextToken = subdomainToken;
        if (!contextToken) {
            const pathToken = getPathFallbackToken(parsed.pathname || '');
            if (isMeaningfulContextToken(pathToken)) {
                contextToken = pathToken;
            }
        }

        // Final context fallback: check query params (e.g. ?tab=analytics, ?section=billing).
        if (!contextToken) {
            const queryToken = getQueryFallbackToken(parsed.searchParams);
            if (isMeaningfulContextToken(queryToken)) {
                contextToken = queryToken;
            }
        }

        if (!contextToken) return siteTitle;

        const contextTitle = formatFallbackTitleToken(contextToken);
        if (!contextTitle || contextTitle.toLowerCase() === siteTitle.toLowerCase()) {
            return siteTitle;
        }

        return `${siteTitle} ${contextTitle}`;
    } catch (_) {
        const hostCandidate = url
            .replace(/^https?:\/\//i, '')
            .replace(/^www\./i, '')
            .split('/')[0];

        if (!hostCandidate) return 'Untitled';

        // Keep IPv6 literal intact; otherwise strip port suffix from host.
        let hostWithoutPort = hostCandidate;
        if (hostWithoutPort.startsWith('[')) {
            hostWithoutPort = hostWithoutPort.replace(/^\[|\]$/g, '');
        } else {
            hostWithoutPort = hostWithoutPort.split(':')[0];
        }

        const isIPv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostWithoutPort);
        const isIPv6 = hostWithoutPort.includes(':');
        if (isIPv4 || isIPv6) return hostWithoutPort;

        const domainInfo = parseRegistrableDomain(hostWithoutPort);
        const siteToken = domainInfo?.registrableLabel || hostWithoutPort.split('.')[0] || hostWithoutPort;
        return formatFallbackTitleToken(siteToken);
    }
}

async function fetchPageTitleFromBackground(url) {
    const FETCH_TIMEOUT = 10000; // 10 seconds

    return new Promise((resolve) => {
        let resolved = false;

        const timeoutId = setTimeout(() => {
            if (!resolved) {
                resolved = true;
                console.warn('[FetchTitle] Timeout waiting for background response');
                resolve({ success: false, title: '', error: 'Request timed out' });
            }
        }, FETCH_TIMEOUT);

        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
            chrome.runtime.sendMessage({ action: 'fetchPageTitle', url }, (response) => {
                if (resolved) return;
                resolved = true;
                clearTimeout(timeoutId);

                if (chrome.runtime.lastError) {
                    console.error('Error fetching title:', chrome.runtime.lastError);
                    resolve({ success: false, title: '', error: chrome.runtime.lastError.message });
                    return;
                }
                resolve(response || { success: false, title: '', error: 'No response from background' });
            });
        } else {
            resolved = true;
            clearTimeout(timeoutId);
            resolve({ success: false, title: '', error: 'Extension runtime unavailable' });
        }
    });
}

/*
========================================
EDIT BOOKMARK FUNCTIONALITY
========================================
Functions for editing existing bookmarks
*/

// Global variable to store current bookmark being edited
let currentBookmarkToEdit = null;

// Open edit bookmark modal
async function openEditBookmarkModal(bookmarkId) {
    // Block in read-only mode (grace/expired status)
    if (!canModify()) return;

    try {
        // Get bookmark data from database
        const bookmark = await db.bookmarks.get(bookmarkId);
        if (!bookmark) {
            showGlassToast('Bookmark not found', 'error');
            return;
        }

        // Block editing trashed items
        if (bookmark.deletedAt) {
            showGlassToast('Cannot edit items in trash. Restore first.', 'error');
            return;
        }

        // Store current bookmark ID
        currentBookmarkToEdit = bookmarkId;

        // Populate form fields with current data
        document.getElementById('editBookmarkUrl').value = bookmark.url;
        document.getElementById('editBookmarkTitle').value = bookmark.title;
        const editDescriptionField = document.getElementById('editBookmarkDescription');
        editDescriptionField.value = bookmark.description || '';
        updateDescriptionRemainingCounter(
            editDescriptionField,
            document.getElementById('editBookmarkDescriptionRemaining')
        );

        // Clear any previous fetch error
        document.getElementById('fetchTitleError').textContent = '';

        // Show modal
        const modal = document.getElementById('editBookmarkModal');
        modal.classList.add('active');

        // Focus on title field
        document.getElementById('editBookmarkTitle').focus();

        // Trigger Privacy & Security Analysis
        if (lumiListModules.privacyUI) {
            const analysis = lumiListModules.privacyAssistant.analyze({
                password: '',
                bookmark: {
                    title: bookmark.title,
                    url: bookmark.url,
                    description: bookmark.description || '',
                    tags: ''
                }
            });
            lumiListModules.privacyUI.renderAnalysis('editBookmarkPrivacyAnalysis', analysis);
        }

    } catch (error) {
        console.error('Failed to open edit bookmark modal:', error);
        showGlassToast('Failed to open edit form. Please try again.', 'error');
    }
}

// Close edit bookmark modal
function closeEditBookmarkModal() {
    const modal = document.getElementById('editBookmarkModal');
    modal.classList.remove('active');
    currentBookmarkToEdit = null;

    // Reset form
    document.getElementById('editBookmarkForm').reset();

    // Hide Privacy Analysis
    const analysisContainer = document.getElementById('editBookmarkPrivacyAnalysis');
    if (analysisContainer) {
        analysisContainer.classList.add('hidden');
        analysisContainer.innerHTML = '';
    }

    updateDescriptionRemainingCounter(
        document.getElementById('editBookmarkDescription'),
        document.getElementById('editBookmarkDescriptionRemaining')
    );
}

// Update bookmark in database (for edit modal)
async function saveBookmarkEdit(bookmarkId, title, url, description) {
    // FIX: Check if user can modify (subscription status check)
    if (!canModify()) {
        showGlassToast('Cannot edit bookmarks in read-only mode.', 'warning');
        return;
    }

    try {
        // Sanitize URL to prevent XSS via javascript:, data: protocols
        const safeUrl = sanitizeUrl(url);
        if (!safeUrl) {
            showGlassToast('Invalid or unsafe URL.', 'warning');
            return;
        }

        // Get the bookmark to preserve boardId
        const existingBookmark = await db.bookmarks.get(bookmarkId);
        if (!existingBookmark) {
            throw new Error('Bookmark not found');
        }

        const resolvedTitle = (typeof title === 'string' ? title.trim() : '') || getFallbackTitleFromUrl(safeUrl);

        // Update bookmark data using the wrapper (triggers sync)
        await updateBookmark(bookmarkId, {
            title: resolvedTitle || 'Untitled',
            url: safeUrl,
            description: sanitizeBookmarkNote(description)
        });

        // Update the board display
        await updateBoardBookmarks(existingBookmark.boardId);
    } catch (error) {
        console.error('Failed to update bookmark:', error);
        showGlassToast('Failed to update bookmark. Please try again.', 'error');
    }
}

/*
========================================
BOARD MENU DROPDOWN FUNCTIONALITY
========================================
Functions for the 3-dot board menu
*/

// Store active scroll listener for cleanup (memory leak prevention)
let _activeBoardMenuScrollListener = null;

// Toggle board dropdown menu
function toggleBoardMenu(boardId) {
    const menu = document.getElementById(`board-menu-${boardId}`);
    const button = document.querySelector(`.board-menu-btn[data-board-id="${boardId}"]`);
    if (!menu || !button) {
        console.warn(`toggleBoardMenu: Missing element - menu: ${!!menu}, button: ${!!button}, boardId: ${boardId}`);
        // Try to recreate menu if missing
        if (!menu && button) {
            const boardElement = button.closest('.board');
            if (boardElement) {
                const isShared = boardElement.classList.contains('shared-board');
                ensureBoardMenuExists(boardId, isShared);
                // Retry after creating menu
                const newMenu = document.getElementById(`board-menu-${boardId}`);
                if (newMenu) {

                    toggleBoardMenu(boardId); // Recursive call with newly created menu
                    return;
                }
            }
        }
        return;
    }

    // Keep board and page dropdown systems in sync
    closeTabContextMenu();

    // Close all other menus first
    closeBoardMenus(boardId);

    // Toggle this menu
    const isOpening = !menu.classList.contains('active');
    menu.classList.toggle('active');

    if (isOpening) {
        // Position the menu using fixed coordinates
        const buttonRect = button.getBoundingClientRect();
        const menuWidth = 150;

        let left = buttonRect.right - menuWidth;
        let top = buttonRect.bottom + 4;

        // Ensure menu doesn't go off-screen
        if (left < 10) left = 10;
        if (left + menuWidth > window.innerWidth - 10) {
            left = window.innerWidth - menuWidth - 10;
        }

        const menuHeight = menu.offsetHeight || 150;
        if (top + menuHeight > window.innerHeight - 10) {
            top = buttonRect.top - menuHeight - 4;
        }

        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;

        // Close menu on scroll since it's fixed positioned
        // Store reference for cleanup when menu closes via other means (click outside)
        _activeBoardMenuScrollListener = () => {
            closeBoardMenus();
        };
        window.addEventListener('scroll', _activeBoardMenuScrollListener, true);
    }
}

// Close all board menus (optionally except one)
function closeBoardMenus(exceptBoardId = null) {
    document.querySelectorAll('.board-menu').forEach(menu => {
        if (exceptBoardId && menu.id === `board-menu-${exceptBoardId}`) {
            return; // Skip this one
        }
        menu.classList.remove('active');
    });

    // Clean up scroll listener to prevent memory leak
    if (_activeBoardMenuScrollListener) {
        window.removeEventListener('scroll', _activeBoardMenuScrollListener, true);
        _activeBoardMenuScrollListener = null;
    }
}

// Open all links in a board
async function openAllBoardLinks(boardId) {
    try {
        const bookmarks = await db.bookmarks
            .where('boardId')
            .equals(boardId)
            .filter(b => !b.deletedAt)
            .toArray();

        if (bookmarks.length === 0) {
            showGlassToast('No links in this board', 'info');
            return;
        }

        // Open all links (respects incognito mode)
        const urls = bookmarks.filter(b => b.url).map(b => b.url);
        openMultipleUrls(urls);
    } catch (error) {
        console.error('Failed to open board links:', error);
    }
}

function showFetchTitlesProgressModal(totalLinks) {
    const modal = document.getElementById('fetchTitlesModal');
    const progressBar = document.getElementById('fetchTitlesProgressBar');
    const statusText = document.getElementById('fetchTitlesStatusText');

    if (!modal || !progressBar || !statusText) return false;

    progressBar.style.width = '0%';
    statusText.textContent = `0 of ${totalLinks} links processed`;
    modal.classList.add('active');
    return true;
}

function updateFetchTitlesProgressModal(processedCount, totalLinks) {
    const progressBar = document.getElementById('fetchTitlesProgressBar');
    const statusText = document.getElementById('fetchTitlesStatusText');
    if (!progressBar || !statusText || totalLinks <= 0) return;

    const clampedProcessed = Math.max(0, Math.min(processedCount, totalLinks));
    const percent = Math.round((clampedProcessed / totalLinks) * 100);
    progressBar.style.width = `${percent}%`;
    statusText.textContent = `${clampedProcessed} of ${totalLinks} links processed`;
}

function hideFetchTitlesProgressModal() {
    const modal = document.getElementById('fetchTitlesModal');
    if (!modal) return;
    modal.classList.remove('active');
}

function setImportLinksProgressCancelable(isCancelable) {
    const cancelBtn = document.getElementById('cancelImportLinksProgressBtn');
    if (!cancelBtn) return;
    cancelBtn.style.display = isCancelable ? 'inline-flex' : 'none';
    cancelBtn.disabled = !isCancelable;
}

function showImportLinksProgressModal(titleText = 'Importing links', statusTextValue = 'Starting...') {
    const modal = document.getElementById('importLinksProgressModal');
    const title = document.getElementById('importLinksProgressTitle');
    const statusText = document.getElementById('importLinksProgressStatusText');
    const progressBar = document.getElementById('importLinksProgressBar');

    if (!modal || !title || !statusText || !progressBar) return false;

    title.textContent = titleText;
    statusText.textContent = statusTextValue;
    progressBar.style.width = '0%';
    setImportLinksProgressCancelable(false);
    modal.classList.add('active');
    return true;
}

function updateImportLinksProgressModal(titleText, statusTextValue, processed = 0, total = 0) {
    const title = document.getElementById('importLinksProgressTitle');
    const statusText = document.getElementById('importLinksProgressStatusText');
    const progressBar = document.getElementById('importLinksProgressBar');
    if (!title || !statusText || !progressBar) return;

    if (typeof titleText === 'string' && titleText.trim()) {
        title.textContent = titleText;
    }
    if (typeof statusTextValue === 'string' && statusTextValue.trim()) {
        statusText.textContent = statusTextValue;
    }

    if (Number.isFinite(total) && total > 0) {
        const clampedProcessed = Math.max(0, Math.min(processed, total));
        const percent = Math.round((clampedProcessed / total) * 100);
        progressBar.style.width = `${percent}%`;
    }
}

function hideImportLinksProgressModal() {
    const modal = document.getElementById('importLinksProgressModal');
    if (!modal) return;
    setImportLinksProgressCancelable(false);
    modal.classList.remove('active');
}

function buildImportRollbackSyncOperations(importOps = []) {
    const normalizedOps = normalizeUndoRedoOps(importOps);
    if (normalizedOps.length === 0) return [];

    return buildUndoRedoSyncOperations(
        normalizedOps.map((op) => ({
            table: op.table,
            id: op.id,
            snapshot: cloneUndoRedoSnapshot(op.before)
        }))
    );
}

async function rollbackImportMutationBatch(importOps = [], options = {}) {
    const normalizedOps = normalizeUndoRedoOps(importOps);
    if (normalizedOps.length === 0) {
        return { success: true, rolledBack: false };
    }

    const queueAttempt = await queueSyncOperationsAtomically(
        buildImportRollbackSyncOperations(normalizedOps),
        {
            contextLabel: options.contextLabel || 'rollbackImportMutationBatch',
            ensureBootstrapPages: false
        }
    );
    if (!queueAttempt.success) {
        return {
            success: false,
            error: queueAttempt.error || 'Failed to queue rollback for partial import changes.'
        };
    }

    await rollbackLocalMutationOps(normalizedOps);
    return { success: true, rolledBack: true };
}

// Fetch page titles for all links in a board and update bookmark names in bulk.
async function fetchAllBoardLinkTitles(boardId) {
    // Block in read-only mode (grace/expired status)
    if (!canModify()) return;

    let progressModalShown = false;

    try {
        const syncScope = await ensureLocalMutationSyncScopeAllowed({
            contextLabel: 'fetchAllBoardLinkTitles'
        });
        if (!syncScope.allowed) {
            return;
        }

        const board = await db.boards.get(boardId);
        if (!board || board.deletedAt) {
            showGlassToast('Board not found', 'error');
            return;
        }

        const bookmarks = await db.bookmarks
            .where('boardId')
            .equals(boardId)
            .filter(b => !b.deletedAt)
            .toArray();

        if (bookmarks.length === 0) {
            showGlassToast('No links in this board', 'info');
            return;
        }

        const confirmed = await showGlassConfirm(
            'Replace All Link Titles?',
            `This will fetch and replace titles for links in "${board.name}". Existing custom titles will be overwritten.`,
            { confirmText: 'Fetch & Replace' }
        );
        if (!confirmed) {
            return;
        }

        progressModalShown = showFetchTitlesProgressModal(bookmarks.length);

        const updates = [];
        let processedCount = 0;
        const CONCURRENCY = 4;
        let cursor = 0;

        async function worker() {
            while (true) {
                const index = cursor++;
                if (index >= bookmarks.length) break;

                const bookmark = bookmarks[index];
                try {
                    if (!bookmark || !bookmark.id || !bookmark.url) {
                        continue;
                    }

                    const safeUrl = sanitizeUrl(bookmark.url);
                    if (!safeUrl) {
                        continue;
                    }

                    const result = await fetchPageTitleFromBackground(safeUrl);
                    const fetchedTitle = (result?.success && typeof result.title === 'string')
                        ? result.title.trim()
                        : '';

                    if (!fetchedTitle) {
                        continue;
                    }

                    const currentTitle = (typeof bookmark.title === 'string') ? bookmark.title.trim() : '';
                    if (!fetchedTitle || fetchedTitle === currentTitle) {
                        continue;
                    }

                    updates.push({
                        id: bookmark.id,
                        title: fetchedTitle
                    });
                } catch (error) {
                    console.error('Failed to fetch title for bookmark:', bookmark?.id, error);
                } finally {
                    processedCount++;
                    if (progressModalShown) {
                        updateFetchTitlesProgressModal(processedCount, bookmarks.length);
                    }
                }
            }
        }

        await Promise.all(
            Array.from({ length: Math.min(CONCURRENCY, bookmarks.length) }, () => worker())
        );

        if (updates.length === 0) {
            return;
        }

        const now = getCurrentTimestamp();
        await db.transaction('rw', db.bookmarks, async () => {
            for (const update of updates) {
                await db.bookmarks.update(update.id, {
                    title: update.title,
                    updatedAt: now
                });
            }
        });

        const changedIds = updates.map(update => update.id);
        const updatedBookmarks = (await db.bookmarks.bulkGet(changedIds)).filter(Boolean);
        if (updatedBookmarks.length > 0) {
            const beforeById = createUndoRedoSnapshotMap(
                bookmarks.filter(bookmark => changedIds.includes(bookmark.id))
            );
            const afterById = createUndoRedoSnapshotMap(updatedBookmarks);
            const ops = buildUndoRedoOpsFromSnapshotMaps('bookmarks', beforeById, afterById);
            const queueAttempt = await queueSyncItemsAtomically(
                ops
                    .filter(op => op.after)
                    .map(op => ({
                        op: 'upsert',
                        table: 'bookmarks',
                        id: op.id,
                        data: op.after
                    })),
                { contextLabel: 'fetchAllBoardLinkTitles' }
            );
            if (!queueAttempt.success) {
                await rollbackLocalMutationOps(ops);
                if (!queueAttempt.staleWorkspace) {
                    showGlassToast(queueAttempt.error || 'Failed to replace link titles. Please try again.', 'error');
                }
                await updateBoardBookmarks(boardId);
                return;
            }

            if (!isApplyingUndoRedoHistory) {
                await recordUndoRedoHistoryEntry({
                    kind: 'bookmark_bulk_title_replace',
                    label: updatedBookmarks.length === 1
                        ? 'Replace title for 1 bookmark'
                        : `Replace titles for ${updatedBookmarks.length} bookmarks`,
                    ops
                });
            }
        }

        await updateBoardBookmarks(boardId);
        broadcastDataChange('fetchAllBoardLinkTitles');
    } catch (error) {
        console.error('Failed to fetch all board link titles:', error);
    } finally {
        if (progressModalShown) {
            hideFetchTitlesProgressModal();
        }
    }
}

// Close board menus when clicking outside
document.addEventListener('click', (e) => {
    // Check both the container (has the ⋮ button) and the dropdown menu itself (appended to body)
    if (!e.target.closest('.board-menu-container') && !e.target.closest('.board-menu')) {
        closeBoardMenus();
    }
});

// Close dropdowns on right-click outside their own menu surfaces (capture phase)
document.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('.board-menu-container') && !e.target.closest('.board-menu')) {
        closeBoardMenus();
    }

    if (!e.target.closest('.tab-menu-dropdown')) {
        closeTabContextMenu();
    }

    if (!e.target.closest('.wallpaper-context-menu')) {
        closeWallpaperContextMenu();
    }
}, true);

/*
========================================
EDIT BOARD FUNCTIONALITY
========================================
Functions for editing board names
*/

// Global variable to store current board being edited
let currentBoardToEdit = null;

// Open edit board modal
async function openEditBoardModal(boardId) {
    // Block in read-only mode (grace/expired status)
    if (!canModify()) return;

    try {
        // Get board data from database
        const board = await db.boards.get(boardId);
        if (!board) {
            showGlassToast('Board not found', 'error');
            return;
        }

        // Block editing trashed items
        if (board.deletedAt) {
            showGlassToast('Cannot edit items in trash. Restore first.', 'error');
            return;
        }

        // Store current board ID
        currentBoardToEdit = boardId;

        // Populate form fields with current values
        document.getElementById('editBoardName').value = board.name;

        const colorInput = document.getElementById('editBoardColor');
        const defaultColorToggle = document.getElementById('editBoardUseDefaultColor');
        const hasCustomColor = typeof board.color === 'string' && board.color.trim() !== '';

        colorInput.value = normalizeHexColor(hasCustomColor ? board.color : '#ffffff', '#ffffff');
        if (defaultColorToggle) {
            defaultColorToggle.checked = !hasCustomColor;
        }
        colorInput.disabled = !!defaultColorToggle?.checked;

        // Show modal
        const modal = document.getElementById('editBoardModal');
        modal.classList.add('active');

        // Focus on name field
        document.getElementById('editBoardName').focus();

    } catch (error) {
        console.error('Failed to open edit board modal:', error);
        showGlassToast('Failed to open edit form. Please try again.', 'error');
    }
}

// Close edit board modal
function closeEditBoardModal() {
    const modal = document.getElementById('editBoardModal');
    modal.classList.remove('active');
    currentBoardToEdit = null;

    // Reset form
    const form = document.getElementById('editBoardForm');
    form.reset();

    const colorInput = document.getElementById('editBoardColor');
    const defaultColorToggle = document.getElementById('editBoardUseDefaultColor');
    if (colorInput) {
        colorInput.disabled = false;
        colorInput.value = '#ffffff';
    }
    if (defaultColorToggle) {
        defaultColorToggle.checked = false;
    }
}

// Update board details in database
async function updateBoardDetails(boardId, newName, newColor) {
    // Block in read-only mode
    if (!canModify()) return;

    try {
        const trimmedName = newName.trim();
        const normalizedColor = typeof newColor === 'string' && newColor.trim() !== ''
            ? normalizeHexColor(newColor, '#ffffff')
            : null;
        
        const updateResult = await updateBoard(boardId, {
            name: trimmedName,
            color: normalizedColor
        }, {
            historyKind: 'board_edit',
            historyLabel: `Edit board "${trimmedName}"`
        });

        if (!updateResult) {
            showGlassToast('Board not found', 'error');
            return;
        }

        // Update the board title and color in DOM immediately
        const boardElement = document.querySelector(`[data-board-id="${boardId}"]`);
        if (boardElement) {
            const titleTextElement = boardElement.querySelector('.board-title-text');
            if (titleTextElement) {
                titleTextElement.textContent = trimmedName;
            }
            if (normalizedColor) {
                boardElement.style.setProperty('--board-custom-color', normalizedColor);
                boardElement.classList.add('has-custom-color');
            } else {
                boardElement.style.removeProperty('--board-custom-color');
                boardElement.classList.remove('has-custom-color');
            }
        }
        await refreshSearchIfOpen();

    } catch (error) {
        console.error('Failed to update board details:', error);
        showGlassToast('Failed to update board. Please try again.', 'error');
    }
}

/*
========================================
ADD BOARD FUNCTIONALITY
========================================
Functions for creating new boards
*/

// Close the add board modal
function closeAddBoardModal() {
    const modal = document.getElementById('addBoardModal');
    modal.classList.remove('active');

    // Reset form
    document.getElementById('addBoardForm').reset();
}

// Open the add page modal
function openAddPageModal() {
    // Block in read-only mode (grace/expired status)
    if (!canModify()) return;

    const modal = document.getElementById('addPageModal');
    modal.classList.add('active');

    // Focus on the name field
    document.getElementById('pageName').focus();
}

// Close the add page modal
function closeAddPageModal() {
    const modal = document.getElementById('addPageModal');
    modal.classList.remove('active');

    // Reset form
    document.getElementById('addPageForm').reset();
}

// Create new board and add to database
async function createNewBoard(name, description, columnIndex = null) {
    // Guard against multiple concurrent calls (user hitting Enter repeatedly)
    if (isAddingBoard) {
        console.warn('Board creation already in progress');
        return;
    }
    isAddingBoard = true;

    try {
        // Get the target column (from parameter or default to 0)
        const targetColumn = typeof columnIndex === 'number' ? columnIndex : 0;

        // Get the max order in the target column to add at the bottom
        const boardsInColumn = await db.boards
            .where('pageId')
            .equals(currentPageId)
            .and(board => board.columnIndex === targetColumn)
            .toArray();

        const maxOrder = boardsInColumn.length > 0
            ? Math.max(...boardsInColumn.map(b => b.order)) + 1
            : 0;

        // Create new board object - goes to target column at the bottom
        const newBoardData = {
            name: name.trim(),
            columnIndex: targetColumn,
            order: maxOrder,
            description: description ? description.trim() : null,
            pageId: currentPageId, // Associate board with current page
            color: autoBoardColorEnabled ? generateRandomColor() : null
        };

        // Add to database using wrapper (auto-syncs to server)
        const boardId = await addBoard(newBoardData);
        if (!boardId) return;
        newBoardData.id = boardId;

        // IMPORTANT: Explicitly set pageHasBoards and hide placeholder BEFORE render
        // Prevents race condition where placeholder could still be clickable during render
        pageHasBoards = true;
        hideAddBoardPlaceholder();

        // Refresh the display
        await loadBoardsFromDatabase();

        emitQuickTourEvent('board_created', {
            boardId,
            pageId: currentPageId
        });
    } catch (error) {
        console.error('Failed to create board:', error);
        showGlassToast('Failed to create board. Please try again.', 'error');
    } finally {
        isAddingBoard = false;
    }
}

function updateSettingsVersionInfo() {
    const versionRow = document.getElementById('settingsVersionRow');
    const versionText = document.getElementById('settingsVersionText');
    if (!versionRow || !versionText) return;

    let version = '';
    try {
        if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.getManifest === 'function') {
            version = chrome.runtime.getManifest()?.version || '';
        }
    } catch (error) {
        console.warn('Unable to read extension manifest version for settings:', error);
    }

    if (version) {
        versionText.textContent = `Version ${version}`;
        versionRow.hidden = false;
    } else {
        versionRow.hidden = true;
    }
}

// Open settings modal
/**
 * Populates the page selection dropdown in the Customize Background settings section.
 */
async function populateCustomizeBackgroundPageSelect() {
    const select = document.getElementById('customizeBackgroundPageSelect');
    if (!select) return;

    try {
        const pages = await db.pages.filter(p => !p.deletedAt).sortBy('order');
        const currentOptions = Array.from(select.options).map(opt => opt.value);
        const newOptions = pages.map(p => p.id);

        // Only update if the options have changed
        if (JSON.stringify(currentOptions) === JSON.stringify(newOptions)) {
            updateResetBackgroundButtonVisibility();
            return;
        }

        select.innerHTML = '';
        pages.forEach(page => {
            const option = document.createElement('option');
            option.value = page.id;
            option.textContent = page.name || 'Untitled Page';
            if (page.id === currentPageId) {
                option.selected = true;
            }
            select.appendChild(option);
        });

        updateResetBackgroundButtonVisibility();
    } catch (error) {
        console.error('Failed to populate customize background page select:', error);
    }
}

/**
 * Updates the visibility of the "Reset to Global" button based on the selected page's background.
 */
function updateResetBackgroundButtonVisibility() {
    const select = document.getElementById('customizeBackgroundPageSelect');
    const resetBtn = document.getElementById('resetPageBackgroundBtn');
    if (!select || !resetBtn) return;

    const selectedPageId = select.value;
    const selections = pageWallpaperSelections || {};
    
    if (selections[selectedPageId]) {
        resetBtn.style.display = 'block';
    } else {
        resetBtn.style.display = 'none';
    }
}

/**
 * Handles the "Change Background" button click for a specific page.
 */
async function handleChangePageBackgroundClick() {
    const select = document.getElementById('customizeBackgroundPageSelect');
    if (!select) return;

    const selectedPageId = select.value;
    if (!selectedPageId) return;

    // Set a global flag or context so the wallpaper feature knows we are selecting for a specific page
    window.wallpaperSelectionTargetPageId = selectedPageId;

    // Open the wallpaper popup
    if (typeof openWallpaperPopup === 'function') {
        openWallpaperPopup();
        // Close settings modal to show the wallpaper popup clearly
        closeSettingsModal();
    }
}

/**
 * Handles the "Reset to Global" button click for a specific page.
 */
async function handleResetPageBackgroundClick() {
    const select = document.getElementById('customizeBackgroundPageSelect');
    if (!select) return;

    const selectedPageId = select.value;
    if (!selectedPageId) return;

    try {
        if (wallpaperFeature && typeof wallpaperFeature.savePageWallpaperSelectionToStorage === 'function') {
            await wallpaperFeature.savePageWallpaperSelectionToStorage(selectedPageId, null);
            
            // If the reset page is the current page, apply the wallpaper immediately
            if (selectedPageId === currentPageId) {
                if (typeof applyActiveThemeWallpaper === 'function') {
                    applyActiveThemeWallpaper();
                }
            }
            
            updateResetBackgroundButtonVisibility();
            showGlassToast('Background reset to global default', 'info');
        }
    } catch (error) {
        console.error('Failed to reset page background:', error);
        showGlassToast('Failed to reset background', 'error');
    }
}

async function openSettingsModal() {
    const modal = document.getElementById('settingsModal');

    // Show modal IMMEDIATELY - don't wait for async operations
    modal.classList.add('active');

    // Reset to General tab
    document.querySelectorAll('.settings-nav-item').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.settings-tab-pane').forEach(c => c.classList.remove('active'));

    // Select the first nav item (General) and its content
    const generalTab = document.querySelector('.settings-nav-item[data-tab="general"]');
    const generalContent = document.getElementById('settingsGeneralTab');

    if (generalTab) generalTab.classList.add('active');
    if (generalContent) generalContent.classList.add('active');

    // Ensure settings toggles reflect latest values.
    updateThemeModeToggle();
    updateCompactModeToggle();
    updateFloatingControlsCollapsedToggle();
    updateLargeBoardCollapseToggle();
    updateFontColorSettingControl();
    populateCustomizeBackgroundPageSelect();
    loadCloseTabsAfterSaveAllTabsSetting().catch((error) => {
        console.error('Failed to load close-tabs-after-save-all setting for settings modal:', error);
    });
    updateSettingsVersionInfo();
    refreshSettingsQuickSaveControls().catch((error) => {
        console.error('Failed to refresh quick save settings controls:', error);
    });
    loadShortcutBoardSettingsControls().catch((error) => {
        console.error('Failed to refresh shortcut board settings controls:', error);
    });

    // Update account section - fast lookup from storage
    const loggedIn = document.getElementById('settingsLoggedIn');
    const loggedOut = document.getElementById('settingsLoggedOut');
    const emailEl = document.getElementById('settingsAccountEmail');
    const avatarEl = document.getElementById('settingsUserAvatar');

    try {
        const stored = await chrome.storage.local.get('lumilist_user');
        if (stored.lumilist_user?.email) {
            const email = stored.lumilist_user.email;
            emailEl.textContent = email;
            // Set avatar to first letter of email
            if (avatarEl) {
                avatarEl.textContent = email.charAt(0).toUpperCase();
            }
            loggedIn.style.display = 'block';
            loggedOut.style.display = 'none';

            // Use CACHED subscription data for instant display
            // Subscription data is synced on page load via autoSyncOnLoad() - no need for background refresh here
            if (typeof updateSettingsSubscriptionDisplay === 'function') {
                updateSettingsSubscriptionDisplay().catch((error) => {
                    console.error('Failed to refresh settings subscription display:', error);
                });
            }
        } else {
            loggedIn.style.display = 'none';
            loggedOut.style.display = 'block';
        }
    } catch (e) {
        // Default to logged out state on error
        loggedIn.style.display = 'none';
        loggedOut.style.display = 'block';
    }
}

// Close settings modal
function closeSettingsModal() {
    const modal = document.getElementById('settingsModal');
    if (modal) {
        modal.classList.remove('active');
    }
}

/*
========================================
CHROME BOOKMARKS IMPORT
========================================
Functions for importing Chrome's native bookmarks into LumiList
*/

// Get all Chrome bookmarks organized by folder
async function getChromeBookmarks() {
    return new Promise((resolve) => {
        chrome.bookmarks.getTree((tree) => {
            const folders = [];
            let totalBookmarks = 0;

            // Process each root folder (Bookmarks Bar, Other Bookmarks, Mobile Bookmarks)
            function processFolder(node, depth = 0) {
                // Skip the root node (id "0")
                if (node.id === "0") {
                    node.children?.forEach(child => processFolder(child, depth));
                    return;
                }

                // It's a folder if it has no url
                if (!node.url && node.children) {
                    // Count bookmarks in this folder (including nested)
                    const bookmarkCount = countBookmarksInFolder(node);

                    if (bookmarkCount > 0) {
                        folders.push({
                            id: node.id,
                            name: node.title || 'Untitled Folder',
                            bookmarkCount: bookmarkCount,
                            depth: depth,
                            node: node // Keep reference for import
                        });
                        totalBookmarks += bookmarkCount;
                    }

                    // Only process direct children folders (not nested too deep)
                    if (depth < 1) {
                        node.children.forEach(child => processFolder(child, depth + 1));
                    }
                }
            }

            // Count all bookmarks in a folder (including subfolders - flattened)
            function countBookmarksInFolder(folder) {
                let count = 0;
                function traverse(node) {
                    if (node.url) {
                        count++;
                    } else if (node.children) {
                        node.children.forEach(child => traverse(child));
                    }
                }
                folder.children?.forEach(child => traverse(child));
                return count;
            }

            processFolder(tree[0]);
            resolve({ folders, totalBookmarks });
        });
    });
}

// Collect all bookmarks from a folder (flattening nested folders)
function collectBookmarksFromFolder(folder) {
    const bookmarks = [];

    function traverse(node) {
        if (node.url) {
            // It's a bookmark
            bookmarks.push({
                title: node.title || '',
                url: node.url
            });
        } else if (node.children) {
            // It's a folder - recurse into children
            node.children.forEach(child => traverse(child));
        }
    }

    folder.children?.forEach(child => traverse(child));
    return bookmarks;
}

function prepareChromeImportBookmarks(rawBookmarks = []) {
    const validBookmarks = [];
    let skippedCount = 0;

    for (const bookmark of rawBookmarks) {
        if (isUnsafeUrl(bookmark?.url)) {
            skippedCount++;
            console.warn(`Skipped unsafe URL: ${bookmark?.url}`);
            continue;
        }

        const safeUrl = sanitizeUrl(bookmark?.url);
        if (!safeUrl) {
            skippedCount++;
            console.warn(`Skipped invalid URL: ${bookmark?.url}`);
            continue;
        }

        let title = bookmark?.title;
        if (!title) {
            try {
                title = new URL(safeUrl).hostname;
            } catch {
                title = 'Untitled';
            }
        }

        validBookmarks.push({
            title,
            url: safeUrl
        });
    }

    return { validBookmarks, skippedCount };
}

// Show the Chrome import modal with folder list
async function showChromeImportModal() {
    const blockedReason = getWorkspaceMutationBlockedReason();
    if (blockedReason) {
        showWorkspaceMutationBlockedToast(blockedReason);
        return;
    }

    const modalUserId = await getCurrentStoredUserId();
    if (!modalUserId) {
        showGlassToast('Please sign in again before importing Chrome bookmarks.', 'warning');
        return;
    }

    const modal = document.getElementById('importChromeModal');
    const preview = document.getElementById('chromeImportPreview');
    const progressSection = document.getElementById('chromeImportProgress');
    const confirmBtn = document.getElementById('confirmChromeImportBtn');

    activeChromeImportUserId = modalUserId;

    // Reset state
    progressSection.style.display = 'none';
    confirmBtn.disabled = false;
    confirmBtn.textContent = 'Import Selected';

    // Get Chrome bookmarks
    const { folders, totalBookmarks } = await getChromeBookmarks();
    const latestUserId = await getCurrentStoredUserId();
    if (!latestUserId || latestUserId !== modalUserId) {
        activeChromeImportUserId = null;
        return;
    }

    if (folders.length === 0) {
        preview.innerHTML = '<div class="import-empty-message">No bookmark folders found in Chrome.</div>';
        confirmBtn.disabled = true;
    } else {
        // Render folder list with checkboxes
        preview.innerHTML = folders.map(folder => `
            <label class="import-folder-item">
                <input type="checkbox" value="${escapeHtml(folder.id)}" checked>
                <div class="import-folder-info">
                    <span class="import-folder-name">${escapeHtml(folder.name)}</span>
                    <span class="import-folder-count">${folder.bookmarkCount} bookmark${folder.bookmarkCount !== 1 ? 's' : ''}</span>
                </div>
            </label>
        `).join('');

        // Store folder data for import
        modal.folderData = folders;
    }

    // Show modal
    modal.classList.add('active');
}

// Close Chrome import modal
function closeChromeImportModal() {
    const modal = document.getElementById('importChromeModal');
    const preview = document.getElementById('chromeImportPreview');
    const progressSection = document.getElementById('chromeImportProgress');
    const cancelBtn = document.getElementById('cancelChromeImportBtn');

    activeChromeImportUserId = null;
    modal.classList.remove('active');
    delete modal.folderData;

    // Reset state for next open
    if (preview) preview.style.display = 'block';
    if (progressSection) progressSection.style.display = 'none';
    if (cancelBtn) cancelBtn.disabled = false;
}

// Import selected Chrome bookmark folders
async function importSelectedChromeBookmarks() {
    // Block imports in read-only mode (grace/expired)
    if (!canModify()) return;

    const blockedReason = getWorkspaceMutationBlockedReason();
    if (blockedReason) {
        closeChromeImportModal();
        showWorkspaceMutationBlockedToast(blockedReason);
        return;
    }

    const modalUserId = normalizeRuntimeUserId(activeChromeImportUserId);
    const currentUserId = await getCurrentStoredUserId();
    if (!modalUserId || !currentUserId || modalUserId !== currentUserId) {
        closeChromeImportModal();
        showGlassToast('This import window is out of date after an account change. Please reopen it.', 'warning');
        return;
    }

    // FIX: Mutex to prevent concurrent Chrome imports
    if (_chromeImportInProgress) {

        showToast('Import already in progress', 'info');
        return;
    }
    _chromeImportInProgress = true;

    const modal = document.getElementById('importChromeModal');
    const preview = document.getElementById('chromeImportPreview');
    const progressSection = document.getElementById('chromeImportProgress');
    const progressBar = document.getElementById('importProgressBar');
    const statusText = document.getElementById('importStatusText');
    const confirmBtn = document.getElementById('confirmChromeImportBtn');
    const cancelBtn = document.getElementById('cancelChromeImportBtn');

    // Get selected folder IDs
    const selectedIds = Array.from(preview.querySelectorAll('input[type="checkbox"]:checked'))
        .map(cb => cb.value);

    if (selectedIds.length === 0) {
        showToast('Please select at least one folder to import', 'error');
        _chromeImportInProgress = false;
        return;
    }

    // Get folder data
    const folders = modal.folderData || [];
    const selectedFolders = folders.filter(f => selectedIds.includes(f.id));

    const preparedFolders = selectedFolders.map((folder) => {
        const { validBookmarks, skippedCount } = prepareChromeImportBookmarks(
            collectBookmarksFromFolder(folder.node)
        );
        return {
            ...folder,
            validBookmarks,
            skippedCount
        };
    });
    const importableFolders = preparedFolders.filter((folder) => folder.validBookmarks.length > 0);
    const totalBookmarksToImport = importableFolders.reduce((sum, folder) => sum + folder.validBookmarks.length, 0);
    const totalBoardsToImport = importableFolders.length;

    // Check board limit BEFORE importing (each folder becomes a board)
    const boardLimitCheck = checkBoardLimit(totalBoardsToImport);
    if (!boardLimitCheck.allowed) {
        console.warn('[Chrome Import] Board limit would be exceeded:', boardLimitCheck.warning);
        if (boardLimitCheck.remaining > 0) {
            showGlassToast(`Can only import ${boardLimitCheck.remaining} of ${totalBoardsToImport} folders. Unselect some folders or delete boards first.`, 'warning');
        } else {
            showGlassToast(boardLimitCheck.warning, 'error');
        }
        _chromeImportInProgress = false;
        return;
    }

    if (totalBoardsToImport === 0 || totalBookmarksToImport === 0) {
        showGlassToast('No valid bookmarks found in the selected folders.', 'warning');
        _chromeImportInProgress = false;
        return;
    }

    // Check bookmark limit BEFORE importing (fetch fresh server count for bulk operations)
    const limitCheck = await checkBookmarkLimitForBulkImport(totalBookmarksToImport);
    if (!limitCheck.allowed) {
        console.warn('[Chrome Import] Bookmark limit would be exceeded:', limitCheck.warning);
        if (limitCheck.remaining > 0) {
            showGlassToast(`Can only import ${limitCheck.remaining.toLocaleString()} of ${totalBookmarksToImport.toLocaleString()} bookmarks. Unselect some folders or delete bookmarks first.`, 'warning');
        } else {
            showGlassToast(limitCheck.warning, 'error');
        }
        _chromeImportInProgress = false;
        return;
    }

    // Show progress, hide preview
    preview.style.display = 'none';
    progressSection.style.display = 'block';
    confirmBtn.disabled = true;
    cancelBtn.disabled = true;
    let importedCount = 0;
    let skippedCount = preparedFolders.reduce((sum, folder) => sum + folder.skippedCount, 0);
    const totalFolders = importableFolders.length;
    const chromeImportOps = [];
    let chromeImportCommitted = false;

    try {

        for (let i = 0; i < importableFolders.length; i++) {
            const folder = importableFolders[i];

            // Update progress
            const progress = Math.round(((i + 1) / totalFolders) * 100);
            progressBar.style.width = `${progress}%`;
            statusText.textContent = `Importing "${folder.name}"... (${i + 1}/${totalFolders})`;

            // Find the next column and order for the new board
            const boards = await db.boards
                .where('pageId')
                .equals(currentPageId)
                .filter(b => !b.deletedAt)
                .toArray();
            const boardName = buildUniqueImportedBoardName(
                folder.name,
                collectImportedNameRegistry(boards, sanitizeBoardName)
            );

            // Find column with fewest boards
            const columnCounts = [0, 0, 0, 0];
            boards.forEach(b => {
                if (b.columnIndex >= 0 && b.columnIndex < 4) {
                    columnCounts[b.columnIndex]++;
                }
            });
            const targetColumn = columnCounts.indexOf(Math.min(...columnCounts));

            // Get max order for target column
            const maxOrder = boards
                .filter(b => b.columnIndex === targetColumn)
                .reduce((max, b) => Math.max(max, b.order || 0), -1);

            // Create the board using wrapper function (handles timestamps, sync, etc.)
            const boardId = await addBoard({
                pageId: currentPageId,
                name: boardName,
                columnIndex: targetColumn,
                order: maxOrder + 1
            }, { skipHistory: true });
            if (!boardId) {
                throw new Error(`Failed to create import board "${boardName}".`);
            }
            const createdBoard = await db.boards.get(boardId);
            if (createdBoard) {
                chromeImportOps.push({
                    table: 'boards',
                    id: createdBoard.id,
                    before: null,
                    after: createdBoard
                });
            }

            const validBookmarks = folder.validBookmarks.map((bookmark, index) => ({
                boardId,
                title: bookmark.title,
                url: bookmark.url,
                order: index
            }));

            const addedIds = await bulkAddBookmarks(validBookmarks, { skipHistory: true });
            importedCount += addedIds.length;
            if (addedIds.length > 0) {
                const createdBookmarks = (await db.bookmarks.bulkGet(addedIds)).filter(Boolean);
                createdBookmarks.forEach((bookmark) => {
                    chromeImportOps.push({
                        table: 'bookmarks',
                        id: bookmark.id,
                        before: null,
                        after: bookmark
                    });
                });
            }
        }

        if (!isApplyingUndoRedoHistory && chromeImportOps.length > 0) {
            await recordUndoRedoHistoryEntry({
                kind: 'import_chrome_bookmarks',
                label: `Import ${importedCount} Chrome bookmarks`,
                ops: chromeImportOps
            });
        }
        chromeImportCommitted = true;

        // Success
        statusText.textContent = `Import complete!`;
        progressBar.style.width = '100%';

        // Close modal immediately after showing completion (don't wait for board rendering)
        setTimeout(() => {
            closeChromeImportModal();
            closeSettingsModal();

            let message = `Imported ${importedCount} bookmark${importedCount !== 1 ? 's' : ''}`;
            if (skippedCount > 0) {
                message += ` (${skippedCount} skipped)`;
            }
            showGlassToast(message, 'success');
        }, 300);

        // IMPORTANT: Explicitly set pageHasBoards and hide placeholder BEFORE loadBoardsFromDatabase()
        // This mimics what happens when manually adding a board - ensures placeholder is removed
        pageHasBoards = true;
        hideAddBoardPlaceholder();

        // Reload boards asynchronously - renders in background after modal closes
        loadBoardsFromDatabase();
        broadcastDataChange('chromeImport');

    } catch (error) {
        console.error('Import error:', error);
        if (!chromeImportCommitted && chromeImportOps.length > 0) {
            const rollbackResult = await rollbackImportMutationBatch(chromeImportOps, {
                contextLabel: 'chromeImportRollback'
            });
            if (!rollbackResult.success) {
                console.error('Failed to roll back partial Chrome import:', rollbackResult.error);
                statusText.textContent = 'Import failed and partial changes may still exist. Refresh to resync.';
                confirmBtn.disabled = false;
                cancelBtn.disabled = false;
                return;
            }
            await loadBoardsFromDatabase();
        }
        statusText.textContent = 'Import failed. Please try again.';
        confirmBtn.disabled = false;
        cancelBtn.disabled = false;
        progressSection.style.display = 'none';
        preview.style.display = 'block';
    } finally {
        // FIX: Always reset mutex
        _chromeImportInProgress = false;
    }
}

// Open onboarding modal
function openOnboardingModal() {
    const modal = document.getElementById('onboardingModal');
    if (!modal) return;

    // Detect platform and update keyboard shortcut
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0 ||
        navigator.userAgent.toUpperCase().indexOf('MAC') >= 0;
    const shortcutElement = document.getElementById('quickSaveShortcut');
    if (shortcutElement) {
        shortcutElement.textContent = isMac ? 'Cmd+Shift+Y' : 'Ctrl+Shift+Y';
    }

    modal.classList.add('active');
}

// Close onboarding modal
function closeOnboardingModal() {
    const modal = document.getElementById('onboardingModal');
    if (!modal) return;
    modal.classList.remove('active');
}

function getQuickTourStorageKey(userId) {
    return `${QUICK_TOUR_STORAGE_KEY_PREFIX}${userId}`;
}

function clearQuickTourRetryTimeout() {
    if (quickTourRetryTimeoutId) {
        clearTimeout(quickTourRetryTimeoutId);
        quickTourRetryTimeoutId = null;
    }
}

function cancelQuickTourAnchorRefreshFrame() {
    if (quickTourAnchorRefreshRafId !== null) {
        cancelAnimationFrame(quickTourAnchorRefreshRafId);
        quickTourAnchorRefreshRafId = null;
    }
}

function refreshQuickTourAnchorTarget() {
    quickTourAnchorRefreshRafId = null;

    if (!quickTourState.active || !quickTourPopoverEl) return;

    const step = QUICK_TOUR_STEPS[quickTourState.stepIndex];
    if (!step) return;

    const stepState = resolveQuickTourStepState(step, quickTourState.context);
    const targetEl = stepState?.targetEl || null;
    if (!targetEl) return;

    updateQuickTourPopoverContent(quickTourPopoverEl, stepState);
    syncQuickTourForcedBoard(step, quickTourState.context, targetEl);
    setQuickTourTargetHighlight(targetEl);
    positionQuickTourPopover(targetEl, stepState?.placement || 'auto');
}

function scheduleQuickTourAnchorRefresh() {
    if (!quickTourState.active) return;
    if (quickTourAnchorRefreshRafId !== null) return;

    quickTourAnchorRefreshRafId = requestAnimationFrame(() => {
        refreshQuickTourAnchorTarget();
    });
}

function emitQuickTourEvent(type, payload = {}) {
    if (!type || quickTourEventListeners.size === 0) return;

    for (const listener of quickTourEventListeners) {
        try {
            listener({ type, payload, timestamp: Date.now() });
        } catch (error) {
            console.error('[QuickTour] Listener error:', error);
        }
    }
}

function onQuickTourEvent(listener) {
    if (typeof listener !== 'function') {
        return () => { };
    }

    quickTourEventListeners.add(listener);
    return () => {
        quickTourEventListeners.delete(listener);
    };
}

function shouldPersistQuickTourCompletion(source) {
    return source !== 'dev-test-button';
}

async function markQuickTourCompletedForUser(userId) {
    if (!userId || typeof chrome === 'undefined' || !chrome.storage?.local) {
        return;
    }

    try {
        const key = getQuickTourStorageKey(userId);
        await chrome.storage.local.set({
            [key]: {
                completed: true,
                completedAt: new Date().toISOString(),
                version: QUICK_TOUR_VERSION
            }
        });
    } catch (error) {
        console.error('[QuickTour] Failed to persist completion status:', error);
    }
}

function ensureQuickTourPopoverElement() {
    if (quickTourPopoverEl) return quickTourPopoverEl;

    const popover = document.createElement('div');
    popover.className = 'quick-tour-popover';
    popover.innerHTML = `
        <div class="quick-tour-title"></div>
        <div class="quick-tour-body"></div>
        <div class="quick-tour-actions">
            <button type="button" class="quick-tour-skip">Skip tour</button>
        </div>
    `;

    const skipBtn = popover.querySelector('.quick-tour-skip');
    if (skipBtn) {
        skipBtn.addEventListener('click', () => {
            stopQuickTour('dismissed');
        });
    }

    document.body.appendChild(popover);
    quickTourPopoverEl = popover;
    return popover;
}

function clearQuickTourTargetHighlight() {
    if (quickTourCurrentTargetEl) {
        quickTourCurrentTargetEl.classList.remove('quick-tour-target');
        quickTourCurrentTargetEl = null;
    }
}

function setQuickTourTargetHighlight(targetEl) {
    if (!targetEl) return;
    if (quickTourCurrentTargetEl === targetEl) return;

    clearQuickTourTargetHighlight();
    targetEl.classList.add('quick-tour-target');
    quickTourCurrentTargetEl = targetEl;
}

function clearQuickTourForcedBoard() {
    if (quickTourForcedBoardEl) {
        quickTourForcedBoardEl.classList.remove('quick-tour-force-actions');
        quickTourForcedBoardEl = null;
    }
}

function syncQuickTourForcedBoard(step, context = {}, targetEl = null) {
    if (!step || step.id !== 'add_link') {
        clearQuickTourForcedBoard();
        return;
    }

    let boardEl = null;
    if (context.boardId) {
        const escapedBoardId = escapeCssAttributeValue(context.boardId);
        boardEl = document.querySelector(`.board[data-board-id="${escapedBoardId}"]`);
    }

    if (!boardEl && targetEl) {
        boardEl = targetEl.closest('.board');
    }

    if (!boardEl) {
        clearQuickTourForcedBoard();
        return;
    }

    if (quickTourForcedBoardEl === boardEl) return;

    clearQuickTourForcedBoard();
    boardEl.classList.add('quick-tour-force-actions');
    quickTourForcedBoardEl = boardEl;
}

function getQuickTourBoardElement(context = {}) {
    if (context.boardId) {
        const escapedBoardId = escapeCssAttributeValue(context.boardId);
        const boardEl = document.querySelector(`.board[data-board-id="${escapedBoardId}"]`);
        if (boardEl) {
            return boardEl;
        }
    }

    return document.querySelector('.board');
}

function resolveQuickTourAddLinkState(context = {}) {
    const boardEl = getQuickTourBoardElement(context);
    const inlineLinkInput = boardEl?.querySelector('.inline-link-input')
        || document.querySelector('.inline-link-input');

    if (!inlineLinkInput) {
        return {
            stage: 'button',
            boardEl,
            targetEl: boardEl?.querySelector('.board-add-btn') || document.querySelector('.board-add-btn'),
            placement: 'auto'
        };
    }

    if (inlineLinkInput.classList.contains('state-loading')) {
        return {
            stage: 'loading',
            boardEl,
            targetEl: inlineLinkInput,
            placement: 'side'
        };
    }

    if (inlineLinkInput.classList.contains('state-title')) {
        return {
            stage: 'finish',
            boardEl,
            targetEl: inlineLinkInput,
            placement: 'side'
        };
    }

    return {
        stage: 'url',
        boardEl,
        targetEl: inlineLinkInput.querySelector('.url-input') || inlineLinkInput,
        placement: 'side'
    };
}

function resolveQuickTourStepState(step, context = {}) {
    if (!step?.id) return null;

    if (step.id === 'create_board') {
        let targetEl = document.querySelector('.inline-board-input');
        if (!targetEl) {
            targetEl = document.querySelector('.add-board-placeholder');
        }

        if (!targetEl) {
            const fallbackColumnIndex = Number.isInteger(currentPlaceholderColumn)
                ? currentPlaceholderColumn
                : (Number.isInteger(lastActivePlaceholderColumn) ? lastActivePlaceholderColumn : 0);
            showAddBoardPlaceholder(fallbackColumnIndex);
            targetEl = document.querySelector('.add-board-placeholder')
                || document.querySelector(`.column[data-column="${fallbackColumnIndex}"]`)
                || document.querySelector('.column[data-column="0"]');
        }

        return {
            title: step.title,
            body: step.body,
            targetEl,
            placement: 'auto'
        };
    }

    if (step.id === 'add_link') {
        const addLinkState = resolveQuickTourAddLinkState(context);
        let body = 'Click the + link button on your board to open the link form.';

        if (addLinkState.stage === 'url') {
            body = 'Enter your URL here, then press Enter or Add Link.';
        } else if (addLinkState.stage === 'loading') {
            body = 'Fetching the title for your link...';
        } else if (addLinkState.stage === 'finish') {
            body = 'Review the title and optional description, then click Add Link.';
        }

        return {
            title: step.title,
            body,
            targetEl: addLinkState.targetEl,
            placement: addLinkState.placement
        };
    }

    if (step.id === 'open_wallpaper') {
        return {
            title: step.title,
            body: 'Open Style here to change your wallpaper and the look of your workspace.',
            targetEl: document.getElementById('floatingWallpaperBtn'),
            placement: 'auto'
        };
    }

    return {
        title: step.title,
        body: step.body,
        targetEl: null,
        placement: 'auto'
    };
}

function updateQuickTourPopoverContent(popover, stepState) {
    if (!popover || !stepState) return;

    const titleEl = popover.querySelector('.quick-tour-title');
    const bodyEl = popover.querySelector('.quick-tour-body');
    if (titleEl) titleEl.textContent = stepState.title || '';
    if (bodyEl) bodyEl.textContent = stepState.body || '';
}

function positionQuickTourPopover(targetEl, placement = 'auto') {
    if (!quickTourPopoverEl || !targetEl) return;

    const targetRect = targetEl.getBoundingClientRect();
    if (targetRect.width === 0 && targetRect.height === 0) return;

    quickTourPopoverEl.style.visibility = 'hidden';
    quickTourPopoverEl.style.left = '0px';
    quickTourPopoverEl.style.top = '0px';
    const popoverRect = quickTourPopoverEl.getBoundingClientRect();

    const getAutoPosition = () => {
        let left = targetRect.left;
        let top = targetRect.bottom + QUICK_TOUR_ANCHOR_GAP;

        if (left + popoverRect.width > window.innerWidth - QUICK_TOUR_EDGE_PADDING) {
            left = window.innerWidth - popoverRect.width - QUICK_TOUR_EDGE_PADDING;
        }
        if (left < QUICK_TOUR_EDGE_PADDING) {
            left = QUICK_TOUR_EDGE_PADDING;
        }

        const wouldOverflowBottom = top + popoverRect.height > window.innerHeight - QUICK_TOUR_EDGE_PADDING;
        if (wouldOverflowBottom) {
            const aboveTop = targetRect.top - popoverRect.height - QUICK_TOUR_ANCHOR_GAP;
            top = aboveTop >= QUICK_TOUR_EDGE_PADDING
                ? aboveTop
                : Math.max(QUICK_TOUR_EDGE_PADDING, window.innerHeight - popoverRect.height - QUICK_TOUR_EDGE_PADDING);
        }

        return { left, top };
    };

    let position = getAutoPosition();
    if (placement === 'side') {
        const maxTop = Math.max(
            QUICK_TOUR_EDGE_PADDING,
            window.innerHeight - popoverRect.height - QUICK_TOUR_EDGE_PADDING
        );
        const alignedTop = Math.min(Math.max(targetRect.top, QUICK_TOUR_EDGE_PADDING), maxTop);
        const rightLeft = targetRect.right + QUICK_TOUR_ANCHOR_GAP;
        const leftLeft = targetRect.left - popoverRect.width - QUICK_TOUR_ANCHOR_GAP;

        if (rightLeft + popoverRect.width <= window.innerWidth - QUICK_TOUR_EDGE_PADDING) {
            position = {
                left: rightLeft,
                top: alignedTop
            };
        } else if (leftLeft >= QUICK_TOUR_EDGE_PADDING) {
            position = {
                left: leftLeft,
                top: alignedTop
            };
        }
    }

    quickTourPopoverEl.style.left = `${Math.round(position.left)}px`;
    quickTourPopoverEl.style.top = `${Math.round(position.top)}px`;
    quickTourPopoverEl.style.visibility = 'visible';
}

function escapeCssAttributeValue(value) {
    if (typeof value !== 'string') return '';
    if (window.CSS && typeof window.CSS.escape === 'function') {
        return window.CSS.escape(value);
    }
    return value.replace(/["\\]/g, '\\$&');
}

async function renderQuickTourStep(step, context = {}) {
    if (!quickTourState.active || !step) return;

    const stepState = resolveQuickTourStepState(step, context);
    const targetEl = stepState?.targetEl || null;
    if (!targetEl) {
        clearQuickTourRetryTimeout();
        if (quickTourState.retryCount >= QUICK_TOUR_TARGET_RETRY_LIMIT) {
            console.warn('[QuickTour] Could not resolve target for step:', step.id);
            stopQuickTour('target_missing');
            return;
        }

        quickTourState.retryCount += 1;
        quickTourRetryTimeoutId = setTimeout(() => {
            renderQuickTourStep(step, context).catch((error) => {
                console.error('[QuickTour] Failed to render step:', error);
                stopQuickTour('render_error');
            });
        }, QUICK_TOUR_TARGET_RETRY_DELAY_MS);
        return;
    }

    clearQuickTourRetryTimeout();
    quickTourState.retryCount = 0;

    const popover = ensureQuickTourPopoverElement();
    updateQuickTourPopoverContent(popover, stepState);

    syncQuickTourForcedBoard(step, context, targetEl);
    setQuickTourTargetHighlight(targetEl);
    positionQuickTourPopover(targetEl, stepState?.placement || 'auto');
}

function cleanupQuickTourRuntime() {
    clearQuickTourRetryTimeout();
    cancelQuickTourAnchorRefreshFrame();

    if (quickTourEventUnsubscribe) {
        quickTourEventUnsubscribe();
        quickTourEventUnsubscribe = null;
    }

    if (quickTourRepositionHandler) {
        window.removeEventListener('resize', quickTourRepositionHandler);
        window.removeEventListener('scroll', quickTourRepositionHandler, true);
        quickTourRepositionHandler = null;
    }

    if (quickTourEscapeHandler) {
        document.removeEventListener('keydown', quickTourEscapeHandler, true);
        quickTourEscapeHandler = null;
    }

    if (quickTourPointerMoveHandler) {
        document.removeEventListener('mousemove', quickTourPointerMoveHandler, true);
        quickTourPointerMoveHandler = null;
    }

    if (quickTourMutationObserver) {
        quickTourMutationObserver.disconnect();
        quickTourMutationObserver = null;
    }

    clearQuickTourForcedBoard();

    if (quickTourPopoverEl) {
        quickTourPopoverEl.remove();
        quickTourPopoverEl = null;
    }

    clearQuickTourTargetHighlight();
}

function stopQuickTour(reason = 'dismissed') {
    if (!quickTourState.active && !quickTourPopoverEl && !quickTourCurrentTargetEl) {
        return;
    }

    cleanupQuickTourRuntime();
    quickTourState = {
        active: false,
        stepIndex: 0,
        retryCount: 0,
        source: null,
        userId: null,
        context: {
            boardId: null
        }
    };

    if (reason === 'target_missing') {
        console.warn('[QuickTour] Stopped because target could not be resolved.');
    }
}

async function startQuickTour(options = {}) {
    stopQuickTour('restart');

    if (typeof SyncManager === 'undefined') {
        return;
    }

    const isLoggedIn = await SyncManager.isLoggedIn();
    if (!isLoggedIn) {
        showGlassToast('Please sign in to start the quick tour.', 'warning');
        return;
    }

    if (typeof canModify === 'function' && !canModify()) {
        showGlassToast('Quick tour is unavailable in read-only mode.', 'warning');
        return;
    }

    const storedUser = await SyncManager.getStoredUser();
    const userId = storedUser?.id || null;
    if (!userId) {
        showGlassToast('Please sign in to start the quick tour.', 'warning');
        return;
    }

    quickTourState = {
        active: true,
        stepIndex: 0,
        retryCount: 0,
        source: options.source || 'manual',
        userId,
        context: {
            boardId: null
        }
    };

    quickTourRepositionHandler = () => {
        scheduleQuickTourAnchorRefresh();
    };
    window.addEventListener('resize', quickTourRepositionHandler);
    window.addEventListener('scroll', quickTourRepositionHandler, true);

    quickTourEscapeHandler = (event) => {
        if (event.key !== 'Escape' || !quickTourState.active) return;
        stopQuickTour('dismissed');
    };
    document.addEventListener('keydown', quickTourEscapeHandler, true);

    quickTourPointerMoveHandler = () => {
        scheduleQuickTourAnchorRefresh();
    };
    document.addEventListener('mousemove', quickTourPointerMoveHandler, true);

    const boardContainer = document.querySelector('.container');
    if (boardContainer && typeof MutationObserver !== 'undefined') {
        quickTourMutationObserver = new MutationObserver(() => {
            scheduleQuickTourAnchorRefresh();
        });
        quickTourMutationObserver.observe(boardContainer, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class']
        });
    }

    quickTourEventUnsubscribe = onQuickTourEvent(async (event) => {
        if (!quickTourState.active || !event?.type) return;

        if (quickTourState.stepIndex === 0 && event.type === 'board_created') {
            quickTourState.context.boardId = event.payload?.boardId || null;
            quickTourState.stepIndex = 1;
            await renderQuickTourStep(QUICK_TOUR_STEPS[1], quickTourState.context);
            return;
        }

        if (quickTourState.stepIndex === 1 && event.type === 'bookmark_created') {
            quickTourState.stepIndex = 2;
            await renderQuickTourStep(QUICK_TOUR_STEPS[2], quickTourState.context);
            return;
        }

        if (quickTourState.stepIndex === 2 && event.type === 'wallpaper_opened') {
            if (shouldPersistQuickTourCompletion(quickTourState.source)) {
                await markQuickTourCompletedForUser(quickTourState.userId);
            }
            stopQuickTour('completed');
            showGlassToast('You are all set.', 'success');
        }
    });

    await renderQuickTourStep(QUICK_TOUR_STEPS[0], quickTourState.context);
}

// Check if we should show onboarding for new users
// isNewUser: Pass true when we already know this is a new user (e.g., syncOnLogin returned 'created_home')
//            This skips the server data check to avoid race condition where Home page was just pushed
async function checkShowOnboarding(isNewUser = false) {
    try {
        // Get current user ID to make the flag user-specific
        const userResult = await chrome.storage.local.get('lumilist_user');
        const userId = userResult.lumilist_user?.id;
        if (!userId) {

            return;
        }

        // Use user-specific key for the onboarding flag
        const onboardingKey = `lumilist_has_seen_onboarding_${userId}`;
        const result = await chrome.storage.local.get(onboardingKey);

        if (!result[onboardingKey]) {
            // Ensure only ONE tab shows onboarding (avoid multi-tab popups)
            const ownerKey = `lumilist_onboarding_owner_${userId}`;
            const ownerResult = await chrome.storage.local.get(ownerKey);
            const owner = ownerResult[ownerKey];

            // If another tab already claimed ownership recently, skip showing here
            const OWNER_TTL_MS = 30000; // 30s lease
            if (owner && owner.userId === userId && owner.tabId && owner.tabId !== TAB_INSTANCE_ID) {
                const isExpired = (Date.now() - (owner.timestamp || 0)) > OWNER_TTL_MS;
                if (!isExpired) {
                    // Schedule a local retry ONLY if this looks like a brand-new account
                    // and we can do so without any server checks.
                    if (!_onboardingRetryTimeoutId) {
                        const signalResult = await chrome.storage.local.get('lumilist_login_sync_complete');
                        const signal = signalResult?.lumilist_login_sync_complete;
                        if (signal?.userId === userId && signal?.action === 'created_home') {
                            const remaining = OWNER_TTL_MS - (Date.now() - (owner.timestamp || 0));
                            const delay = Math.max(remaining + 50, 50);
                            _onboardingRetryTimeoutId = setTimeout(() => {
                                _onboardingRetryTimeoutId = null;
                                checkShowOnboarding(true); // local-only retry, no server call
                            }, delay);
                        }
                    }
                    return;
                }
            }

            // Claim ownership for this tab (best-effort)
            const newOwner = { userId, tabId: TAB_INSTANCE_ID, timestamp: Date.now() };
            await chrome.storage.local.set({ [ownerKey]: newOwner });

            // Verify ownership (handles race where another tab writes after us)
            const verifyResult = await chrome.storage.local.get(ownerKey);
            const verifyOwner = verifyResult[ownerKey];
            if (!verifyOwner || verifyOwner.tabId !== TAB_INSTANCE_ID) {

                return;
            }

            // Check if user already has LOCAL bookmarks - if so, skip onboarding
            const bookmarkCount = await db.bookmarks.filter(b => !b.deletedAt).count();
            if (bookmarkCount > 0) {
                // Clear ownership since we won't show onboarding
                await chrome.storage.local.remove(ownerKey);
                return;
            }

            // ALSO check if user has SERVER data (reinstall scenario)
            // This prevents showing onboarding for existing users who reinstalled
            // Skip this check if we already know this is a new user (avoids race condition
            // where syncOnLogin creates Home page before this check runs)
            if (!isNewUser) {
                const serverHasData = await SyncManager.checkServerHasData();
                if (serverHasData !== false) {
                    // Clear ownership since we won't show onboarding
                    await chrome.storage.local.remove(ownerKey);
                    return;
                }
            }

            // Only show onboarding for truly new users (no local AND no server data)
            if (_onboardingOpenTimeoutId) {
                clearTimeout(_onboardingOpenTimeoutId);
                _onboardingOpenTimeoutId = null;
            }

            _onboardingOpenTimeoutId = setTimeout(async () => {
                _onboardingOpenTimeoutId = null;

                try {
                    const latestResult = await chrome.storage.local.get([
                        'lumilist_user',
                        ownerKey
                    ]);
                    const latestUserId = latestResult?.lumilist_user?.id || null;
                    const latestOwner = latestResult?.[ownerKey];

                    if (latestUserId !== userId) {
                        return;
                    }

                    if (!latestOwner || latestOwner.tabId !== TAB_INSTANCE_ID) {
                        return;
                    }

                    if (_crossTabLoginInProgress || document.body?.classList?.contains('not-authenticated')) {
                        return;
                    }

                    openOnboardingModal();
                    // Mark as seen ONLY when we actually show the modal
                    await chrome.storage.local.set({ [onboardingKey]: true });
                    // Clean up ownership now that onboarding has been shown
                    await chrome.storage.local.remove(ownerKey);
                } catch (error) {
                    console.error('Failed to open delayed onboarding modal:', error);
                }
            }, 500);
        }
    } catch (error) {
        console.error('Error checking onboarding status:', error);
    }
}

/*
========================================
FAVICON FUNCTIONALITY
========================================
Favicon fetching with caching and fallback chain:
Cache → Direct /favicon.ico → HTML <link rel="icon"> → Google S2 → DuckDuckGo
*/

// Cache expiry: 7 days
const FAVICON_CACHE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
const FAVICON_COMPRESS_THRESHOLD = 5000; // Compress if > 5KB
const FAVICON_TARGET_SIZE = 32; // 32x32 pixels
const FAVICON_WEBP_QUALITY = 0.8; // 80% quality
const MAX_FAVICON_CACHE_ENTRIES = 2000; // Cap cache size (~20MB max at 10KB avg)

// Track in-flight favicon work to prevent duplicate background requests.
const pendingFaviconResolutions = new Map(); // faviconCacheKey -> Promise<{data, sourceUrl, transientFailure}>
const pendingFaviconDataFetches = new Map(); // iconUrl -> Promise<{data, error, transientFailure}>
const pendingLinkTagLookups = new Map(); // faviconCacheKey -> Promise<{icons, transientFailure}>
const pendingFaviconResolutionQueue = [];
const FAVICON_CANDIDATE_FETCH_TIMEOUT_MS = 5000;
const FAVICON_LINK_TAG_LOOKUP_TIMEOUT_MS = 5500;
const FAVICON_RESOLUTION_MAX_MS = 15000;
const FAVICON_RESOLUTION_CONCURRENCY = 4;
let activeFaviconResolutionCount = 0;

function isRetryableFaviconHttpStatus(statusCode) {
    return statusCode === 408
        || statusCode === 425
        || statusCode === 429
        || (statusCode >= 500 && statusCode <= 599);
}

function isTransientFaviconFailureMessage(errorMessage) {
    const normalized = String(errorMessage || '').trim().toLowerCase();
    if (!normalized) return true;

    const statusMatch = normalized.match(/status\s+(\d{3})/);
    if (statusMatch) {
        return isRetryableFaviconHttpStatus(Number(statusMatch[1]));
    }

    return [
        'timed out',
        'timeout',
        'failed to fetch',
        'networkerror',
        'network request failed',
        'message port closed',
        'receiving end does not exist',
        'could not establish connection',
        'extension context invalidated',
        'service worker',
        'aborterror',
        'aborted'
    ].some(pattern => normalized.includes(pattern));
}

function shouldCacheMissingFaviconResult(resolveResult) {
    return !!resolveResult && resolveResult.transientFailure !== true;
}

function runWithFaviconResolutionSlot(task) {
    return new Promise((resolve, reject) => {
        const startTask = () => {
            activeFaviconResolutionCount++;

            Promise.resolve()
                .then(task)
                .then(resolve, reject)
                .finally(() => {
                    activeFaviconResolutionCount = Math.max(0, activeFaviconResolutionCount - 1);
                    const nextTask = pendingFaviconResolutionQueue.shift();
                    if (typeof nextTask === 'function') {
                        nextTask();
                    }
                });
        };

        if (activeFaviconResolutionCount < FAVICON_RESOLUTION_CONCURRENCY) {
            startTask();
            return;
        }

        pendingFaviconResolutionQueue.push(startTask);
    });
}

// Resolve icon URLs declared in page HTML (<link rel="icon" href="...">)
// Deduplicated per favicon cache key to avoid repeated parallel lookups.
async function fetchLinkTagIconCandidates(pageUrl, faviconCacheKey, hostnameForLog, timeoutMs = FAVICON_LINK_TAG_LOOKUP_TIMEOUT_MS) {
    if (!navigator.onLine) return { icons: [], transientFailure: true };
    if (!pageUrl || !faviconCacheKey) return { icons: [], transientFailure: false };
    if (pendingLinkTagLookups.has(faviconCacheKey)) {
        return pendingLinkTagLookups.get(faviconCacheKey);
    }

    const lookupPromise = (async () => {
        let transientFailure = false;
        try {
            const response = await chrome.runtime.sendMessage({
                action: 'fetchFaviconLinksFromPage',
                url: pageUrl,
                timeoutMs
            });

            if (response?.success && Array.isArray(response.icons)) {
                return {
                    icons: response.icons
                        .filter(iconUrl => typeof iconUrl === 'string' && /^https?:\/\//i.test(iconUrl)),
                    transientFailure: false
                };
            }

            transientFailure = !response
                || !response.error
                || isTransientFaviconFailureMessage(response.error);
        } catch (error) {
            transientFailure = true;
            console.warn('[Favicon] Link-tag icon lookup failed for', hostnameForLog || faviconCacheKey, error?.message);
        } finally {
            pendingLinkTagLookups.delete(faviconCacheKey);
        }
        return { icons: [], transientFailure };
    })();

    pendingLinkTagLookups.set(faviconCacheKey, lookupPromise);
    return lookupPromise;
}

/**
 * Compress a Base64 favicon to 32x32 WebP for storage efficiency
 * @param {string} base64Data - Original Base64 data URL
 * @returns {Promise<string>} - Compressed Base64 data URL (WebP)
 */
function compressFavicon(base64Data) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            try {
                const canvas = document.createElement('canvas');
                canvas.width = FAVICON_TARGET_SIZE;
                canvas.height = FAVICON_TARGET_SIZE;
                const ctx = canvas.getContext('2d');

                // Draw image scaled to 32x32
                ctx.drawImage(img, 0, 0, FAVICON_TARGET_SIZE, FAVICON_TARGET_SIZE);

                // Export as WebP (smaller than PNG/JPEG)
                const compressed = canvas.toDataURL('image/webp', FAVICON_WEBP_QUALITY);
                resolve(compressed);
            } catch (err) {
                reject(err);
            }
        };
        img.onerror = () => reject(new Error('Failed to load image for compression'));
        img.src = base64Data;
    });
}

// Get cached favicon for a favicon cache key.
// Returns:
// - { data, url } for a successful cache hit
// - { missing: true } when we recently confirmed no favicon
// - null on cache miss/expired
async function getCachedFavicon(faviconCacheKey) {
    try {
        const cached = await db.favicons.get(faviconCacheKey);
        if (cached) {
            const age = Date.now() - (cached.timestamp || 0);
            if (age < FAVICON_CACHE_EXPIRY_MS) {
                // Negative cache hit: skip retrying known-missing favicons.
                if (cached.failed === true) {
                    return { missing: true };
                }

                // Validate Base64 format before returning
                if (cached.data && !cached.data.startsWith('data:image/')) {
                    // Corrupted data - delete and return miss
                    console.warn(`[Favicon] Corrupted cache data for ${faviconCacheKey}, deleting`);
                    await db.favicons.delete(faviconCacheKey);
                    return null;
                }

                if (cached.data || cached.url) {
                    return { data: cached.data || null, url: cached.url || null };
                }
                return null;
            }
            // Expired - delete and return null
            await db.favicons.delete(faviconCacheKey);
        }
    } catch (e) {
        console.error('Favicon cache read error:', e);
    }
    return null;
}

// Cache a successful favicon URL and optionally Base64 data
// base64Data is optional - if provided, enables instant loading on next visit
// Large favicons are compressed to 32x32 WebP for storage efficiency
async function cacheFavicon(faviconCacheKey, url, base64Data = null) {
    const cacheEntry = {
        id: faviconCacheKey,
        url: url,
        timestamp: Date.now(),
        failed: false
    };

    try {
        // Enforce storage limit with LRU eviction
        const count = await db.favicons.count();
        if (count >= MAX_FAVICON_CACHE_ENTRIES) {
            // Evict oldest 10% of entries
            const evictCount = Math.floor(MAX_FAVICON_CACHE_ENTRIES * 0.1);
            const oldestEntries = await db.favicons
                .orderBy('timestamp')
                .limit(evictCount)
                .toArray();
            if (oldestEntries.length > 0) {
                await db.favicons.bulkDelete(oldestEntries.map(e => e.id));
            }
        }

        if (base64Data) {
            // Compress if over threshold to prevent IndexedDB bloat
            if (base64Data.length > FAVICON_COMPRESS_THRESHOLD) {
                try {
                    const compressed = await compressFavicon(base64Data);
                    cacheEntry.data = compressed;
                } catch (err) {
                    // Only store uncompressed if under 10KB (acceptable size)
                    // Otherwise just cache URL only to prevent IndexedDB bloat
                    if (base64Data.length <= 10000) {
                        cacheEntry.data = base64Data;
                    }
                }
            } else {
                cacheEntry.data = base64Data;
            }
        }

        await db.favicons.put(cacheEntry);
    } catch (e) {
        // Handle quota exceeded - emergency cleanup then retry
        if (e.name === 'QuotaExceededError') {
            try {
                const evictCount = Math.floor(MAX_FAVICON_CACHE_ENTRIES * 0.2);
                const oldest = await db.favicons.orderBy('timestamp').limit(evictCount).toArray();
                await db.favicons.bulkDelete(oldest.map(e => e.id));
                // Retry the write after cleanup
                await db.favicons.put(cacheEntry);
                return; // Success after retry
            } catch (retryError) {
                console.error('Favicon cache write failed even after cleanup:', retryError);
            }
        } else {
            console.error('Favicon cache write error:', e);
        }
    }
}

// Cache a negative result when all favicon providers fail.
// This suppresses repeated network retries and console 404 noise for the same domain.
async function cacheMissingFavicon(faviconCacheKey) {
    const cacheEntry = {
        id: faviconCacheKey,
        failed: true,
        timestamp: Date.now()
    };

    try {
        const count = await db.favicons.count();
        if (count >= MAX_FAVICON_CACHE_ENTRIES) {
            const evictCount = Math.floor(MAX_FAVICON_CACHE_ENTRIES * 0.1);
            const oldestEntries = await db.favicons
                .orderBy('timestamp')
                .limit(evictCount)
                .toArray();
            if (oldestEntries.length > 0) {
                await db.favicons.bulkDelete(oldestEntries.map(e => e.id));
            }
        }

        await db.favicons.put(cacheEntry);
    } catch (e) {
        if (e.name === 'QuotaExceededError') {
            try {
                const evictCount = Math.floor(MAX_FAVICON_CACHE_ENTRIES * 0.2);
                const oldest = await db.favicons.orderBy('timestamp').limit(evictCount).toArray();
                await db.favicons.bulkDelete(oldest.map(entry => entry.id));
                await db.favicons.put(cacheEntry);
                return;
            } catch (retryError) {
                console.error('Favicon missing-cache write failed after cleanup:', retryError);
            }
        } else {
            console.error('Favicon missing-cache write error:', e);
        }
    }
}

// Proactively clean up expired favicon cache entries
// Called on page load to prevent unbounded cache growth
async function cleanupExpiredFavicons() {
    try {
        const cutoffTime = Date.now() - FAVICON_CACHE_EXPIRY_MS;
        const expiredEntries = await db.favicons
            .filter(entry => (entry.timestamp || 0) < cutoffTime)
            .toArray();

        if (expiredEntries.length > 0) {
            await db.favicons.bulkDelete(expiredEntries.map(e => e.id));
        }
    } catch (e) {
        console.error('Favicon cleanup error:', e);
    }
}

// Common multi-part TLDs that need special handling
// e.g., api.example.co.uk should return example.co.uk, not co.uk
const MULTI_PART_TLDS = [
    'co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'me.uk',
    'com.au', 'net.au', 'org.au',
    'co.nz', 'org.nz',
    'co.jp', 'ne.jp', 'or.jp',
    'com.br', 'org.br',
    'co.in', 'org.in', 'net.in',
    'co.za',
    'com.mx',
    'co.kr'
];

// Helper function to extract root domain from hostname
// e.g., lumiscale.sentry.io → sentry.io, www.github.com → github.com
// e.g., api.example.co.uk → example.co.uk (handles multi-part TLDs)
// Returns null if hostname is already a root domain (2 parts or less)
function getRootDomain(hostname) {
    const parts = hostname.split('.');
    // If only 2 parts (e.g., sentry.io), no subdomain - already root
    if (parts.length <= 2) return null;

    // Check for multi-part TLDs (e.g., co.uk, com.au)
    const lastTwo = parts.slice(-2).join('.');
    if (MULTI_PART_TLDS.includes(lastTwo)) {
        // For multi-part TLDs, we need 3 parts for root domain
        if (parts.length <= 3) return null;  // Already at root (e.g., example.co.uk)
        return parts.slice(-3).join('.');    // Return last 3 parts (e.g., example.co.uk)
    }

    // Standard TLD - return last 2 parts as root domain
    return parts.slice(-2).join('.');
}

// Build favicon cache key. Most sites use hostname only.
// For host+path Google product patterns (e.g., docs.google.com/spreadsheets),
// include the matched product path segment to prevent cross-product collisions.
function getFaviconCacheKey(urlObj, matchedGooglePattern = null) {
    if (!urlObj || !urlObj.hostname) return null;
    const hostname = urlObj.hostname.toLowerCase();

    if (matchedGooglePattern && matchedGooglePattern.includes('/')) {
        const patternParts = matchedGooglePattern.split('/');
        const patternHost = patternParts[0];
        const patternPath = patternParts.slice(1).join('/');

        if (
            patternPath &&
            (hostname === patternHost || hostname.endsWith('.' + patternHost))
        ) {
            return `${hostname}/${patternPath}`;
        }
    }

    return hostname;
}

async function fetchFaviconDataUrlCandidate(iconUrl, timeoutMs = FAVICON_CANDIDATE_FETCH_TIMEOUT_MS) {
    if (!navigator.onLine) {
        return { data: null, error: 'Offline', transientFailure: true };
    }
    if (!iconUrl || typeof iconUrl !== 'string') {
        return { data: null, error: 'Invalid icon URL', transientFailure: false };
    }
    if (!/^https?:\/\//i.test(iconUrl)) {
        return { data: null, error: 'Invalid icon protocol', transientFailure: false };
    }

    if (pendingFaviconDataFetches.has(iconUrl)) {
        return pendingFaviconDataFetches.get(iconUrl);
    }

    const fetchPromise = (async () => {
        try {
            const response = await chrome.runtime.sendMessage({
                action: 'fetchFaviconAsBase64',
                url: iconUrl,
                timeoutMs
            });
            if (response?.success && typeof response.data === 'string' && response.data.startsWith('data:image/')) {
                return { data: response.data, error: null, transientFailure: false };
            }
            const errorMessage = typeof response?.error === 'string' ? response.error : '';
            return {
                data: null,
                error: errorMessage,
                transientFailure: !response || !errorMessage || isTransientFaviconFailureMessage(errorMessage)
            };
        } catch (error) {
            return {
                data: null,
                error: error?.message || String(error || ''),
                transientFailure: true
            };
        } finally {
            pendingFaviconDataFetches.delete(iconUrl);
        }
    })();

    pendingFaviconDataFetches.set(iconUrl, fetchPromise);
    return fetchPromise;
}

async function resolveFaviconFromCandidateChain({
    pageUrl,
    faviconCacheKey,
    hostnameForLog,
    initialCandidates,
    directAttemptCount,
    maxDurationMs = FAVICON_RESOLUTION_MAX_MS
}) {
    if (!navigator.onLine) {
        return { data: null, sourceUrl: null, transientFailure: true };
    }

    const candidates = Array.isArray(initialCandidates)
        ? Array.from(new Set(initialCandidates.filter(candidate => typeof candidate === 'string' && /^https?:\/\//i.test(candidate))))
        : [];
    if (candidates.length === 0) {
        return { data: null, sourceUrl: null, transientFailure: false };
    }

    const clampedDurationMs = Math.max(1500, Math.min(Number(maxDurationMs) || FAVICON_RESOLUTION_MAX_MS, 20000));
    const deadline = Date.now() + clampedDurationMs;
    let cursor = 0;
    let linkTagLookupAttempted = false;
    const safeDirectAttemptCount = Math.max(0, Number(directAttemptCount) || 0);
    let hadTransientFailure = false;

    while (cursor < candidates.length && Date.now() < deadline) {
        if (!linkTagLookupAttempted && cursor >= safeDirectAttemptCount) {
            linkTagLookupAttempted = true;
            try {
                const remainingForLookupMs = deadline - Date.now();
                if (remainingForLookupMs <= 0) break;

                const lookupTimeoutMs = Math.max(1000, Math.min(FAVICON_LINK_TAG_LOOKUP_TIMEOUT_MS, remainingForLookupMs));
                const linkTagResult = await fetchLinkTagIconCandidates(
                    pageUrl,
                    faviconCacheKey,
                    hostnameForLog,
                    lookupTimeoutMs
                );
                if (linkTagResult?.transientFailure) {
                    hadTransientFailure = true;
                }
                const linkTagIcons = Array.isArray(linkTagResult?.icons) ? linkTagResult.icons : [];
                const uniqueNewCandidates = linkTagIcons.filter(iconUrl => !candidates.includes(iconUrl));
                if (uniqueNewCandidates.length > 0) {
                    candidates.splice(cursor, 0, ...uniqueNewCandidates);
                }
            } catch (error) {
                // Best effort only.
            }
        }

        const iconUrl = candidates[cursor];
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break;

        const perAttemptTimeoutMs = Math.max(1000, Math.min(FAVICON_CANDIDATE_FETCH_TIMEOUT_MS, remainingMs));
        const fetchResult = await fetchFaviconDataUrlCandidate(iconUrl, perAttemptTimeoutMs);
        if (fetchResult?.data) {
            return { data: fetchResult.data, sourceUrl: iconUrl, transientFailure: false };
        }
        if (fetchResult?.transientFailure) {
            hadTransientFailure = true;
        }

        cursor++;
    }

    const hitDeadline = cursor < candidates.length && Date.now() >= deadline;
    return {
        data: null,
        sourceUrl: null,
        transientFailure: hadTransientFailure || hitDeadline
    };
}

function resolveFaviconForCacheKeyOnce(cacheKey, resolver) {
    if (!cacheKey || typeof resolver !== 'function') {
        return Promise.resolve(null);
    }

    if (pendingFaviconResolutions.has(cacheKey)) {
        return pendingFaviconResolutions.get(cacheKey);
    }

    const resolutionPromise = (async () => {
        try {
            return await resolver();
        } finally {
            pendingFaviconResolutions.delete(cacheKey);
        }
    })();

    pendingFaviconResolutions.set(cacheKey, resolutionPromise);
    return resolutionPromise;
}

function buildGooglePathVariants(pathname) {
    const initialSegments = String(pathname || '/').split('/').filter(Boolean);
    if (initialSegments.length === 0) {
        return ['/'];
    }

    const variants = [];
    const seen = new Set();
    const queue = [initialSegments];

    while (queue.length > 0) {
        const segments = queue.shift();
        const variantPath = '/' + segments.join('/');
        if (seen.has(variantPath)) continue;

        seen.add(variantPath);
        variants.push(variantPath);

        if (segments.length >= 2 && segments[0] === 'u' && /^\d+$/.test(segments[1])) {
            queue.push(segments.slice(2));
        }

        if (segments.length >= 2 && segments[0] === 'a' && segments[1]) {
            queue.push(segments.slice(2));
        }

        if (segments.length >= 3 && segments[1] === 'u' && /^\d+$/.test(segments[2])) {
            queue.push([segments[0], ...segments.slice(3)]);
        }

        if (segments.length >= 3 && segments[1] === 'a' && segments[2]) {
            queue.push([segments[0], ...segments.slice(3)]);
        }
    }

    return variants;
}

function matchesGoogleProductPattern(urlObj, pattern) {
    if (!urlObj || !urlObj.hostname || !pattern) return false;

    const patternParts = pattern.split('/');
    const patternHost = patternParts[0];
    const patternPath = patternParts.slice(1).join('/');
    const hostname = urlObj.hostname.toLowerCase();

    if (hostname !== patternHost && !hostname.endsWith('.' + patternHost)) {
        return false;
    }

    if (!patternPath) {
        return true;
    }

    const directPrefix = '/' + patternPath;
    return buildGooglePathVariants(urlObj.pathname).some((variantPath) =>
        variantPath === directPrefix || variantPath.startsWith(directPrefix + '/')
    );
}

function getGoogleProductFaviconMatch(urlObj, googleProductFavicons) {
    if (!urlObj || !googleProductFavicons || typeof googleProductFavicons !== 'object') {
        return { googleFavicon: null, matchedGooglePattern: null };
    }

    for (const [pattern, faviconUrl] of Object.entries(googleProductFavicons)) {
        if (matchesGoogleProductPattern(urlObj, pattern)) {
            return {
                googleFavicon: faviconUrl,
                matchedGooglePattern: pattern
            };
        }
    }

    return { googleFavicon: null, matchedGooglePattern: null };
}

// Favicon fetcher with caching and fallback chain.
// Network resolution happens in background.js and returns Base64 data URLs, so
// newtab never embeds third-party favicon URLs directly in <img src>.
async function createFaviconElement(url, title = '') {
    const faviconContainer = document.createElement('div');
    faviconContainer.className = 'favicon';
    faviconContainer.classList.add('favicon-loading');

    let urlObj;
    let hostname;
    let protocol;
    try {
        urlObj = new URL(url);
        hostname = urlObj.hostname;
        protocol = urlObj.protocol;
    } catch (error) {
        faviconContainer.className = 'favicon-fallback';
        return faviconContainer;
    }

    // Skip favicon fetching for internal/non-fetchable URLs
    // These will always fail and waste time on network requests
    const skipProtocols = ['chrome:', 'chrome-extension:', 'file:', 'about:', 'data:', 'javascript:', 'blob:'];
    const skipHostnames = ['localhost', '127.0.0.1', '0.0.0.0', '[::1]'];

    if (skipProtocols.includes(protocol) ||
        skipHostnames.includes(hostname) ||
        hostname.endsWith('.local') ||
        hostname.endsWith('.localhost') ||
        !hostname.includes('.')) {  // No TLD = likely internal
        faviconContainer.className = 'favicon-fallback';
        return faviconContainer;
    }

    const img = document.createElement('img');
    img.alt = 'Favicon';
    img.addEventListener('load', () => {
        faviconContainer.classList.remove('favicon-loading');
    });
    faviconContainer.appendChild(img);

    // Special favicon URLs for Google products (many return wrong/generic icons)
    const googleProductFavicons = {
        // Docs suite (all under docs.google.com - returns Drive icon by default)
        'docs.google.com/spreadsheets': 'https://ssl.gstatic.com/docs/spreadsheets/favicon3.ico',
        'docs.google.com/document': 'https://ssl.gstatic.com/docs/documents/images/kix-favicon7.ico',
        'docs.google.com/presentation': 'https://ssl.gstatic.com/docs/presentations/images/favicon5.ico',
        'docs.google.com/forms': 'https://ssl.gstatic.com/docs/forms/device_home/android_192.png',
        'docs.google.com': 'https://ssl.gstatic.com/docs/documents/images/kix-favicon7.ico',
        'sheets.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/sheets_48dp.png',
        'slides.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/slides_48dp.png',
        'forms.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/forms_48dp.png',
        'chromewebstore.google.com': 'https://ssl.gstatic.com/chrome/webstore/images/icon_96px.png',

        // Other Google products (use gstatic branding product images for consistency)
        'console.firebase.google.com': 'https://www.gstatic.com/mobilesdk/240501_mobilesdk/firebase_96dp.png',
        'drive.google.com': 'https://ssl.gstatic.com/images/branding/product/2x/drive_2020q4_48dp.png',
        'calendar.google.com': 'https://ssl.gstatic.com/images/branding/product/2x/calendar_2020q4_48dp.png',
        'meet.google.com': 'https://ssl.gstatic.com/images/branding/product/2x/meet_2020q4_48dp.png',
        'chat.google.com': 'https://ssl.gstatic.com/images/branding/product/2x/chat_2020q4_48dp.png',
        'keep.google.com': 'https://ssl.gstatic.com/images/branding/product/2x/keep_2020q4_48dp.png',
        'photos.google.com': 'https://ssl.gstatic.com/images/branding/product/2x/photos_48dp.png',
        'maps.google.com': 'https://www.gstatic.com/images/branding/product/2x/maps_48dp.png',
        'translate.google.com': 'https://ssl.gstatic.com/images/branding/product/2x/translate_48dp.png',
        'news.google.com': 'https://www.gstatic.com/images/branding/product/2x/news_48dp.png',
        'finance.google.com': 'https://www.gstatic.com/finance/favicon/finance_496x496.png',
        'mail.google.com': 'https://ssl.gstatic.com/images/branding/product/2x/gmail_2020q4_48dp.png',
        'books.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/play_books_48dp.png',
        'patents.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/patents_48dp.png',
        // Additional Google products
        'music.youtube.com': 'https://music.youtube.com/img/favicon_48.png',
        'youtube.com': 'https://www.gstatic.com/youtube/img/branding/favicon/favicon_144x144.png',
        'store.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/gstore_48dp.png',
        'cloud.google.com': 'https://www.gstatic.com/images/branding/product/1x/google_cloud_48dp.png',
        'mapsplatform.google.com': 'https://mapsplatform.google.com/static/images/gmp_favicon_32px_2x.png',
        'play.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/play_prism_48dp.png',
        'colab.research.google.com': 'https://colab.research.google.com/img/colab_favicon_256px.png',
        'ai.google.dev': 'https://www.gstatic.com/devrel-devsite/prod/v5ecaab6967af5bdfffc1b93fe7d0ad58c271bf9f563243cec25f323a110134f0/googledevai/images/touchicon-180-new.png',
        'aistudio.google.com': 'https://www.gstatic.com/aistudio/ai_studio_favicon_2_96x96.png',
        'gemini.google.com': 'https://www.gstatic.com/lamda/images/gemini_sparkle_4g_512_lt_f94943af3be039176192d.png',
        'notebooklm.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/notebooklm_48dp.png',
        'deepmind.google.com': 'https://storage.googleapis.com/gdm-deepmind-com-prod-public/icons/google_deepmind_2x_96dp.png',
        'fonts.google.com': 'https://www.gstatic.com/images/branding/product/1x/google_fonts_64dp.png',
        'artsandculture.google.com': 'https://www.gstatic.com/culturalinstitute/stella/favicon-32x32-v1.png',
        'contacts.google.com': 'https://www.gstatic.com/images/branding/product/1x/contacts_2022_48dp.png',
        'support.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/support_48dp.png',
        'passwords.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/password_manager_48dp.png',
        'myaccount.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/identity_48dp.png',
        'account.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/identity_48dp.png',
        'groups.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/groups_48dp.png',
        'sites.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/sites_48dp.png',
        'voice.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/voice_2020q4_48dp.png',
        'earth.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/earth_48dp.png',
        'one.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/one_48dp.png',
        'fi.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/fi_48dp.png',
        'ads.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/ads_48dp.png',
        'analytics.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/analytics_48dp.png',
        'podcasts.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/podcasts_48dp.png',
        'classroom.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/classroom_48dp.png',
        'tasks.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/tasks_48dp.png',
        'jamboard.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/jamboard_48dp.png',
        'assistant.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/assistant_48dp.png',
        'currents.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/currents_48dp.png',
        'blogger.com': 'https://ssl.gstatic.com/images/branding/product/1x/blogger_48dp.png',
        // More Google products (verified working)
        'shopping.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/shopping_48dp.png',
        'trends.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/trends_48dp.png',
        'pay.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/pay_48dp.png',
        'admin.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/admin_48dp.png',
        'scholar.google.com': 'https://scholar.google.com/favicon.ico',
        'search.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/search_console_48dp.png',
        'datastudio.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/data_studio_48dp.png',
        'lookerstudio.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/data_studio_48dp.png',
        'messages.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/messages_48dp.png',
        'youtubekids.com': 'https://ssl.gstatic.com/images/branding/product/1x/youtube_kids_48dp.png',
        'travel.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/travel_48dp.png',
        'waze.com': 'https://ssl.gstatic.com/images/branding/product/1x/waze_48dp.png',
        'tv.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/google_tv_48dp.png',
        'adsense.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/adsense_48dp.png',
        'lens.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/lens_48dp.png',
        'alerts.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/alerts_48dp.png',
        'play.google.com/store/books': 'https://ssl.gstatic.com/images/branding/product/1x/play_books_48dp.png',
        'play.google.com/store/movies': 'https://ssl.gstatic.com/images/branding/product/1x/play_movies_48dp.png',
        'home.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/google_home_48dp.png',
        'vids.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/vids_48dp.png',
        'recaptcha.net': 'https://ssl.gstatic.com/images/branding/product/1x/recaptcha_48dp.png',
        'script.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/apps_script_48dp.png',
        'domains.google': 'https://ssl.gstatic.com/images/branding/product/1x/domains_48dp.png',
        'domains.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/domains_48dp.png',
        'merchants.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/merchant_center_48dp.png',
        // Additional verified Google products
        'wallet.google': 'https://ssl.gstatic.com/images/branding/product/1x/wallet_48dp.png',
        'files.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/files_48dp.png',
        'admob.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/admob_48dp.png',
        'firebase.google.com': 'https://www.gstatic.com/images/branding/product/1x/firebase_48dp.png',
        'flutter.dev': 'https://ssl.gstatic.com/images/branding/product/1x/flutter_48dp.png',
        'wearos.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/wear_os_48dp.png',
        'developer.android.com': 'https://ssl.gstatic.com/images/branding/product/1x/android_studio_48dp.png',
        'play.google.com/googleplaygames': 'https://ssl.gstatic.com/images/branding/product/1x/play_games_48dp.png',
        'optimize.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/optimize_48dp.png',
        'marketingplatform.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/marketing_platform_48dp.png',
        'families.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/family_link_48dp.png',
        'hangouts.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/hangouts_48dp.png',
        'duo.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/duo_48dp.png',
        'fitbit.com': 'https://ssl.gstatic.com/images/branding/product/1x/fitbit_48dp.png',
        'studio.youtube.com': 'https://ssl.gstatic.com/images/branding/product/1x/youtube_studio_48dp.png',
        'developers.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/google_developers_48dp.png',
        'admanager.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/admanager_48dp.png',
        'www.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/googleg_48dp.png',
        'google.com/maps/streetview': 'https://ssl.gstatic.com/images/branding/product/1x/streetview_48dp.png',
        'chrome.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/chrome_48dp.png',
        // Workspace & Enterprise
        'vault.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/vault_48dp.png',
        'appsheet.com': 'https://ssl.gstatic.com/images/branding/product/1x/appsheet_48dp.png',
        'cloudsearch.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/cloud_search_48dp.png',
        // Developer tools
        'idx.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/idx_48dp.png',
        'pagespeed.web.dev': 'https://ssl.gstatic.com/images/branding/product/1x/pagespeed_48dp.png',
        'docs.google.com/drawings': 'https://ssl.gstatic.com/images/branding/product/1x/drawings_48dp.png',
        // Hardware & devices
        'chromecast.com': 'https://ssl.gstatic.com/images/branding/product/1x/chromecast_48dp.png',
        'android.com/tv': 'https://ssl.gstatic.com/images/branding/product/1x/android_tv_48dp.png',
        // Consumer apps
        'localguides.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/local_guides_48dp.png',
        'stadia.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/stadia_48dp.png',
        'authenticator.google.com': 'https://ssl.gstatic.com/images/branding/product/1x/authenticator_48dp.png',
        'gboard.app': 'https://ssl.gstatic.com/images/branding/product/1x/gboard_48dp.png',
        // Catch-all fallback for remaining *.google.com hosts not listed above.
        // Keep this near the end so specific hosts/paths still win first.
        'google.com': 'https://ssl.gstatic.com/images/branding/product/1x/googleg_48dp.png',
        // Catch-all fallback for remaining *.google hosts (for example labs.google).
        'google': 'https://ssl.gstatic.com/images/branding/product/1x/googleg_48dp.png'
    };

    // Check if URL matches a Google product (secure hostname + path matching)
    // This prevents phishing URLs like evil.com/docs.google.com/ from matching
    const { googleFavicon, matchedGooglePattern } = getGoogleProductFaviconMatch(urlObj, googleProductFavicons);

    // Build base fallback chain based on URL type.
    // HTML rel=icon candidates are inserted later (only after direct attempts fail).
    let fallbackChain;
    let directAttemptCount;
    const faviconCacheKey = getFaviconCacheKey(urlObj, matchedGooglePattern) || hostname;
    if (googleFavicon) {
        // Google product: use official icon first, then DDG, then S2 as final fallback.
        fallbackChain = [
            googleFavicon,
            `https://icons.duckduckgo.com/ip3/${hostname}.ico`,
            `https://www.google.com/s2/favicons?sz=32&domain=${hostname}`
        ];
        directAttemptCount = 1;
    } else {
        // All other sites: check for subdomain and add root domain fallbacks
        const rootDomain = getRootDomain(hostname);
        if (rootDomain) {
            // Subdomain detected: add root domain fallbacks
            // e.g., lumiscale.sentry.io → try sentry.io as well
            fallbackChain = [
                `https://${hostname}/favicon.ico`,           // 1. Direct subdomain
                `https://${rootDomain}/favicon.ico`,         // 2. Root domain direct
                `https://icons.duckduckgo.com/ip3/${rootDomain}.ico`,             // 3. DDG with root
                `https://icons.duckduckgo.com/ip3/${hostname}.ico`,               // 4. DDG with subdomain
                `https://www.google.com/s2/favicons?sz=32&domain=${rootDomain}`,  // 5. S2 with root
                `https://www.google.com/s2/favicons?sz=32&domain=${hostname}`      // 6. S2 with subdomain
            ];
            directAttemptCount = 2;
        } else {
            // No subdomain: standard fallback chain
            fallbackChain = [
                `https://${hostname}/favicon.ico`,
                `https://icons.duckduckgo.com/ip3/${hostname}.ico`,
                `https://www.google.com/s2/favicons?sz=32&domain=${hostname}`
            ];
            directAttemptCount = 1;
        }
    }

    let hasRecoveryAttempted = false;
    let isResolving = false;
    let forceRefreshNextResolve = false;
    const initialFallbackChain = Array.from(fallbackChain);

    async function resolveAndApplyFavicon() {
        if (isResolving) return { applied: false, transientFailure: true };
        if (!navigator.onLine) return { applied: false, transientFailure: true };

        isResolving = true;
        try {
            const resolution = await resolveFaviconForCacheKeyOnce(
                faviconCacheKey,
                async () => runWithFaviconResolutionSlot(async () => {
                    const candidates = Array.from(initialFallbackChain);
                    const cachedUrlCandidate = (typeof img.dataset.cachedUrl === 'string')
                        ? img.dataset.cachedUrl.trim()
                        : '';

                    if (cachedUrlCandidate && /^https?:\/\//i.test(cachedUrlCandidate) && !forceRefreshNextResolve) {
                        if (!candidates.includes(cachedUrlCandidate)) {
                            candidates.unshift(cachedUrlCandidate);
                        }
                    }

                    return resolveFaviconFromCandidateChain({
                        pageUrl: url,
                        faviconCacheKey,
                        hostnameForLog: hostname,
                        initialCandidates: candidates,
                        directAttemptCount,
                        maxDurationMs: FAVICON_RESOLUTION_MAX_MS
                    });
                })
            );

            if (resolution?.data) {
                img.dataset.cachedData = resolution.data;
                if (resolution.sourceUrl) {
                    img.dataset.cachedUrl = resolution.sourceUrl;
                    void cacheFavicon(faviconCacheKey, resolution.sourceUrl, resolution.data);
                }
                img.src = resolution.data;
                forceRefreshNextResolve = false;
                return { applied: true, transientFailure: false };
            }

            return {
                applied: false,
                transientFailure: resolution?.transientFailure === true
            };
        } finally {
            isResolving = false;
        }
    }

    async function applyFallbackState({ cacheMissing = true } = {}) {
        faviconContainer.className = 'favicon-fallback';
        if (img.parentNode) {
            img.remove();
        }
        if (cacheMissing) {
            await cacheMissingFavicon(faviconCacheKey);
        }
    }

    img.onerror = async () => {
        if (hasRecoveryAttempted) {
            await applyFallbackState();
            return;
        }

        hasRecoveryAttempted = true;
        forceRefreshNextResolve = true;
        try {
            await db.favicons.delete(faviconCacheKey);
        } catch (e) {
            console.error('Failed to delete stale favicon cache:', e);
        }

        const recovered = await resolveAndApplyFavicon();
        if (!recovered?.applied) {
            await applyFallbackState({
                cacheMissing: shouldCacheMissingFaviconResult(recovered)
            });
        }
    };

    // Await cache check first.
    let cachedResult = await getCachedFavicon(faviconCacheKey);

    // Self-heal stale cache entries for Google products.
    // Older cache keys may hold generic/incorrect icons (e.g. Docs showing Drive icon).
    if (googleFavicon && cachedResult && !cachedResult.missing) {
        const cachedUrl = typeof cachedResult.url === 'string' ? cachedResult.url : '';
        let isSameCanonicalIcon = false;
        try {
            if (cachedUrl) {
                const cachedIconUrl = new URL(cachedUrl);
                const canonicalIconUrl = new URL(googleFavicon);
                isSameCanonicalIcon =
                    cachedIconUrl.origin === canonicalIconUrl.origin &&
                    cachedIconUrl.pathname === canonicalIconUrl.pathname;
            }
        } catch (e) {
            isSameCanonicalIcon = cachedUrl === googleFavicon;
        }

        if (!isSameCanonicalIcon) {
            try {
                await db.favicons.delete(faviconCacheKey);
            } catch (e) {
                console.warn('[Favicon] Failed to clear stale Google favicon cache for', faviconCacheKey, e?.message);
            }
            cachedResult = null;
        }
    }

    if (cachedResult) {
        if (cachedResult.missing) {
            faviconContainer.className = 'favicon-fallback';
            img.remove();
            return faviconContainer;
        }

        // Cache hit with Base64 data is instant and requires no network.
        if (cachedResult.data) {
            img.dataset.cachedData = cachedResult.data;
            img.dataset.cachedUrl = cachedResult.url || cachedResult.data;
            img.src = cachedResult.data;
            return faviconContainer;
        }

        if (cachedResult.url) {
            img.dataset.cachedUrl = cachedResult.url;
        }
    }

    // Resolve in background and apply Base64-only icon source.
    void (async () => {
        const resolved = await resolveAndApplyFavicon();
        if (!resolved?.applied) {
            await applyFallbackState({
                cacheMissing: shouldCacheMissingFaviconResult(resolved)
            });
        }
    })();

    return faviconContainer;
}

/*
========================================
DISPLAY SETTINGS
========================================
Functions for managing display settings like title truncation
*/

// Load truncate titles setting from storage and apply it
async function loadTruncateTitlesSetting(prefetchedStorage = null) {
    try {
        const result = prefetchedStorage && typeof prefetchedStorage === 'object'
            ? prefetchedStorage
            : await chrome.storage.local.get(['truncateTitles']);
        // Default to true (truncate enabled) if not set
        const truncateEnabled = result.truncateTitles !== false;

        // Apply the setting to the page
        applyTruncateTitlesSetting(truncateEnabled);

        // Update the toggle checkbox to match
        const toggle = document.getElementById('truncateTitlesToggle');
        if (toggle) {
            toggle.checked = truncateEnabled;
        }
    } catch (error) {
        console.error('Failed to load truncate titles setting:', error);
    }
}

// Handle truncate titles toggle change
async function handleTruncateTitlesToggle(event) {
    if (!canMutateAccountScopedPreferences()) {
        await loadTruncateTitlesSetting();
        return;
    }

    const truncateEnabled = event.target.checked;

    try {
        // Save the setting
        await chrome.storage.local.set({ truncateTitles: truncateEnabled });

        // Apply the setting immediately
        applyTruncateTitlesSetting(truncateEnabled);


    } catch (error) {
        console.error('Failed to save truncate titles setting:', error);
    }
}

// Apply the truncate titles setting to the page
function applyTruncateTitlesSetting(truncateEnabled) {
    if (truncateEnabled) {
        // Remove full-title-mode class to enable truncation
        document.body.classList.remove('full-title-mode');
    } else {
        // Add full-title-mode class to show full titles
        document.body.classList.add('full-title-mode');
    }
}

// Load Automatic Board Color setting from storage
async function loadAutoBoardColorSetting(prefetchedStorage = null) {
    try {
        const result = prefetchedStorage && typeof prefetchedStorage === 'object'
            ? prefetchedStorage
            : await chrome.storage.local.get([AUTO_BOARD_COLOR_STORAGE_KEY]);
        
        autoBoardColorEnabled = result[AUTO_BOARD_COLOR_STORAGE_KEY] === true;

        // Update the toggle checkbox to match
        const toggle = document.getElementById('autoBoardColorToggle');
        if (toggle) {
            toggle.checked = autoBoardColorEnabled;
        }
    } catch (error) {
        console.error('Failed to load auto board color setting:', error);
    }
}

// Handle Automatic Board Color toggle change
async function handleAutoBoardColorToggle(event) {
    if (!canMutateAccountScopedPreferences()) {
        await loadAutoBoardColorSetting();
        return;
    }

    autoBoardColorEnabled = event.target.checked;

    try {
        // Save the setting
        await chrome.storage.local.set({ [AUTO_BOARD_COLOR_STORAGE_KEY]: autoBoardColorEnabled });
        showGlassToast(autoBoardColorEnabled ? 'Automatic board colors enabled' : 'Automatic board colors disabled', 'info');
    } catch (error) {
        console.error('Failed to save auto board color setting:', error);
    }
}

// Load clock setting from storage and apply it
async function loadShowClockSetting(prefetchedStorage = null) {
    try {
        const result = prefetchedStorage && typeof prefetchedStorage === 'object'
            ? prefetchedStorage
            : await chrome.storage.local.get([SHOW_CLOCK_STORAGE_KEY]);
        
        showClockEnabled = result[SHOW_CLOCK_STORAGE_KEY] === true;

        // Apply the setting
        applyShowClockSetting(showClockEnabled);

        // Update the toggle checkbox to match
        const toggle = document.getElementById('showClockToggle');
        if (toggle) {
            toggle.checked = showClockEnabled;
        }
    } catch (error) {
        console.error('Failed to load clock setting:', error);
    }
}

// Handle show clock toggle change
async function handleShowClockToggle(event) {
    if (!canMutateAccountScopedPreferences()) {
        await loadShowClockSetting();
        return;
    }

    showClockEnabled = event.target.checked;

    try {
        // Save the setting
        await chrome.storage.local.set({ [SHOW_CLOCK_STORAGE_KEY]: showClockEnabled });

        // Apply the setting immediately
        applyShowClockSetting(showClockEnabled);
    } catch (error) {
        console.error('Failed to save clock setting:', error);
    }
}

// Apply the show clock setting to the page
function applyShowClockSetting(enabled) {
    const clockEl = document.getElementById('mainClock');
    if (!clockEl) return;

    if (enabled) {
        clockEl.classList.remove('hidden');
        startClockInterval();
        initClockInteractions(); // Initialize interactions when shown
    } else {
        clockEl.classList.add('hidden');
        stopClockInterval();
    }
}

function getDefaultFontColorForCurrentTheme() {
    const normalizedTheme = normalizeThemeMode(themeMode);
    return DEFAULT_WALLPAPER_THEME_STYLES[normalizedTheme].boardTextColor;
}

function getResolvedFontColorPreference() {
    return customFontColor || getDefaultFontColorForCurrentTheme();
}

function cacheFontColorPreferenceLocally(fontColor) {
    try {
        if (fontColor) {
            localStorage.setItem(FONT_COLOR_LOCAL_CACHE_KEY, fontColor);
        } else {
            localStorage.removeItem(FONT_COLOR_LOCAL_CACHE_KEY);
        }
    } catch (error) {
        // Non-blocking cache update.
    }
}

function clearFontColorPreferenceState() {
    customFontColor = null;
    cacheFontColorPreferenceLocally(null);
    updateFontColorSettingControl();
}

window.__lumilistClearFontColorPreferenceState = clearFontColorPreferenceState;

function applyFontColorPreference(fontColor = customFontColor) {
    const normalizedFontColor = normalizeHexColor(fontColor, null);
    if (!normalizedFontColor) {
        return;
    }

    document.documentElement.style.setProperty('--ll-board-text-color', normalizedFontColor);
}

function updateFontColorSettingControl() {
    const fontColorInput = document.getElementById('fontColorInput');
    const fontColorValue = document.getElementById('fontColorValue');
    if (!fontColorInput && !fontColorValue) return;

    const resolvedFontColor = getResolvedFontColorPreference();
    if (fontColorInput && resolvedFontColor && fontColorInput.value !== resolvedFontColor) {
        fontColorInput.value = resolvedFontColor;
    }

    if (fontColorValue) {
        fontColorValue.textContent = resolvedFontColor || getDefaultFontColorForCurrentTheme();
    }
}

async function loadFontColorSetting(prefetchedStorage = null) {
    try {
        const result = prefetchedStorage && typeof prefetchedStorage === 'object'
            ? prefetchedStorage
            : await chrome.storage.local.get([FONT_COLOR_STORAGE_KEY]);
        customFontColor = normalizeHexColor(result[FONT_COLOR_STORAGE_KEY], null);
        cacheFontColorPreferenceLocally(customFontColor);
        applyFontColorPreference();
        updateFontColorSettingControl();
    } catch (error) {
        console.error('Failed to load font color setting:', error);
    }
}

async function handleFontColorChange(event) {
    if (!canMutateAccountScopedPreferences()) {
        await loadFontColorSetting();
        return;
    }

    const nextColor = normalizeHexColor(event.target.value, null);
    if (!nextColor) {
        await loadFontColorSetting();
        return;
    }

    customFontColor = nextColor;

    try {
        await chrome.storage.local.set({ [FONT_COLOR_STORAGE_KEY]: nextColor });
        cacheFontColorPreferenceLocally(nextColor);
        applyFontColorPreference(nextColor);
        updateFontColorSettingControl();
    } catch (error) {
        console.error('Failed to save font color setting:', error);
        showGlassToast('Failed to save font color. Please try again.', 'error');
    }
}

async function resetFontColorSetting() {
    if (!canMutateAccountScopedPreferences()) {
        await loadFontColorSetting();
        return;
    }

    customFontColor = null;

    try {
        await chrome.storage.local.remove(FONT_COLOR_STORAGE_KEY);
        cacheFontColorPreferenceLocally(null);
        applyThemeStyleTokens(getResolvedWallpaperStyleForTheme(themeMode));
        updateFontColorSettingControl();
    } catch (error) {
        console.error('Failed to reset font color setting:', error);
        showGlassToast('Failed to reset font color. Please try again.', 'error');
    }
}

// Initialize clock drag and resize functionality
function initClockInteractions() {
    const clockEl = document.getElementById('mainClock');
    const resizeHandle = document.getElementById('clockResizeHandle');
    if (!clockEl || !resizeHandle || clockEl.dataset.interactionsInitialized === 'true') return;

    // Mark as initialized to avoid duplicate listeners
    clockEl.dataset.interactionsInitialized = 'true';

    let isDragging = false;
    let isResizing = false;
    let startX, startY, startLeft, startTop, startWidth, startHeight;

    // Load saved position and size
    chrome.storage.local.get([CLOCK_POSITION_STORAGE_KEY, CLOCK_SIZE_STORAGE_KEY], (result) => {
        if (result[CLOCK_POSITION_STORAGE_KEY]) {
            const { left, top } = result[CLOCK_POSITION_STORAGE_KEY];
            clockEl.style.left = left;
            clockEl.style.top = top;
            clockEl.style.transform = 'none'; // Remove centering transform if custom position exists
        }
        if (result[CLOCK_SIZE_STORAGE_KEY]) {
            const { width, height, timeFontSize, dateFontSize } = result[CLOCK_SIZE_STORAGE_KEY];
            clockEl.style.width = width;
            clockEl.style.height = height;
            
            // Re-calculate padding and visibility based on saved dimensions
            const w = parseFloat(width);
            const h = parseFloat(height);
            const paddingX = Math.max(15, 60 * (w / 350));
            const paddingY = Math.max(10, 40 * (h / 200));
            clockEl.style.padding = `${paddingY}px ${paddingX}px`;

            const timeEl = clockEl.querySelector('.clock-time');
            const dateEl = clockEl.querySelector('.clock-date');
            
            if (timeEl && timeFontSize) {
                timeEl.style.fontSize = timeFontSize;
            }
            
            if (dateEl) {
                if (h < 110 || w < 180) {
                    dateEl.style.display = 'none';
                    if (timeEl) timeEl.style.marginBottom = '0';
                } else {
                    dateEl.style.display = 'block';
                    if (dateFontSize) dateEl.style.fontSize = dateFontSize;
                    if (timeEl) timeEl.style.marginBottom = '12px';
                }
            }
        }
    });

    // Mouse Down for Dragging
    clockEl.addEventListener('mousedown', (e) => {
        // Only drag if it's the main container or its children (but not the resize handle)
        if (e.target === resizeHandle || resizeHandle.contains(e.target)) return;
        
        isDragging = true;
        clockEl.classList.add('dragging');
        
        const rect = clockEl.getBoundingClientRect();
        startX = e.clientX;
        startY = e.clientY;
        startLeft = rect.left;
        startTop = rect.top;
        
        // Ensure no transform is active during drag
        clockEl.style.transform = 'none';
        clockEl.style.left = `${startLeft}px`;
        clockEl.style.top = `${startTop}px`;

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });

    // Mouse Down for Resizing
    resizeHandle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        
        isResizing = true;
        clockEl.classList.add('resizing');
        
        const rect = clockEl.getBoundingClientRect();
        startX = e.clientX;
        startY = e.clientY;
        startWidth = rect.width;
        startHeight = rect.height;
        
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });

    function onMouseMove(e) {
        if (isDragging) {
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            clockEl.style.left = `${startLeft + dx}px`;
            clockEl.style.top = `${startTop + dy}px`;
        } else if (isResizing) {
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            
            // Set limits
            const newWidth = Math.max(120, startWidth + dx);
            const newHeight = Math.max(60, startHeight + dy);
            
            clockEl.style.width = `${newWidth}px`;
            clockEl.style.height = `${newHeight}px`;
            
            // Adjust padding based on size
            const paddingX = Math.max(15, 60 * (newWidth / 350));
            const paddingY = Math.max(10, 40 * (newHeight / 200));
            clockEl.style.padding = `${paddingY}px ${paddingX}px`;

            // Responsive font size adjustment
            const scaleFactor = Math.min(newWidth / 350, newHeight / 200);
            const timeEl = clockEl.querySelector('.clock-time');
            const dateEl = clockEl.querySelector('.clock-date');
            
            if (timeEl) {
                timeEl.style.fontSize = `${Math.max(24, 100 * scaleFactor)}px`;
            }
            
            if (dateEl) {
                // Hide date if it's too small
                if (newHeight < 110 || newWidth < 180) {
                    dateEl.style.display = 'none';
                    if (timeEl) timeEl.style.marginBottom = '0';
                } else {
                    dateEl.style.display = 'block';
                    dateEl.style.fontSize = `${Math.max(12, 20 * scaleFactor)}px`;
                    if (timeEl) timeEl.style.marginBottom = '12px';
                }
            }
        }
    }

    function onMouseUp() {
        if (isDragging || isResizing) {
            // Save to storage
            if (isDragging) {
                chrome.storage.local.set({
                    [CLOCK_POSITION_STORAGE_KEY]: {
                        left: clockEl.style.left,
                        top: clockEl.style.top
                    }
                });
            }
            if (isResizing) {
                const timeEl = clockEl.querySelector('.clock-time');
                const dateEl = clockEl.querySelector('.clock-date');
                chrome.storage.local.set({
                    [CLOCK_SIZE_STORAGE_KEY]: {
                        width: clockEl.style.width,
                        height: clockEl.style.height,
                        timeFontSize: timeEl ? timeEl.style.fontSize : null,
                        dateFontSize: dateEl ? dateEl.style.fontSize : null
                    }
                });
            }
        }
        
        isDragging = false;
        isResizing = false;
        clockEl.classList.remove('dragging');
        clockEl.classList.remove('resizing');
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
    }
}

function startClockInterval() {
    if (clockIntervalId) return;
    updateClock(); // Initial call
    clockIntervalId = setInterval(updateClock, 1000);
}

function stopClockInterval() {
    if (clockIntervalId) {
        clearInterval(clockIntervalId);
        clockIntervalId = null;
    }
}

function updateClock() {
    const clockTimeEl = document.getElementById('clockTime');
    const clockDateEl = document.getElementById('clockDate');
    if (!clockTimeEl || !clockDateEl) return;

    // Use Dhaka timezone
    const now = new Date();
    const options = {
        timeZone: 'Asia/Dhaka',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
    };
    
    const timeFormatter = new Intl.DateTimeFormat('en-US', options);
    clockTimeEl.textContent = timeFormatter.format(now);

    const dateOptions = {
        timeZone: 'Asia/Dhaka',
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    };
    const dateFormatter = new Intl.DateTimeFormat('en-US', dateOptions);
    clockDateEl.textContent = dateFormatter.format(now);
}

// Global variable to track open in new tab setting
let openLinksInNewTab = false;

// Load open in new tab setting from storage and apply it
async function loadOpenInNewTabSetting(prefetchedStorage = null) {
    try {
        const result = prefetchedStorage && typeof prefetchedStorage === 'object'
            ? prefetchedStorage
            : await chrome.storage.local.get(['openInNewTab']);
        // Default to false (open in same tab) if not set
        openLinksInNewTab = result.openInNewTab === true;

        // Apply the setting to existing links
        applyOpenInNewTabSetting(openLinksInNewTab);

        // Update the toggle checkbox to match
        const toggle = document.getElementById('openInNewTabToggle');
        if (toggle) {
            toggle.checked = openLinksInNewTab;
        }
    } catch (error) {
        console.error('Failed to load open in new tab setting:', error);
    }
}

// Handle open in new tab toggle change
async function handleOpenInNewTabToggle(event) {
    if (!canMutateAccountScopedPreferences()) {
        await loadOpenInNewTabSetting();
        return;
    }

    openLinksInNewTab = event.target.checked;

    try {
        // Save the setting
        await chrome.storage.local.set({ openInNewTab: openLinksInNewTab });

        // Apply the setting immediately
        applyOpenInNewTabSetting(openLinksInNewTab);
        await refreshSearchIfOpen();


    } catch (error) {
        console.error('Failed to save open in new tab setting:', error);
    }
}

// Apply the open in new tab setting to all bookmark links
function applyOpenInNewTabSetting(openInNewTab) {
    const bookmarkLinks = document.querySelectorAll('.board-links a');
    bookmarkLinks.forEach(link => {
        if (openInNewTab) {
            link.setAttribute('target', '_blank');
            link.setAttribute('rel', 'noopener noreferrer');
        } else {
            link.removeAttribute('target');
            link.removeAttribute('rel');
        }
    });
}

// Load show bookmark notes setting from storage and apply it
async function loadShowBookmarkNotesSetting(prefetchedStorage = null) {
    try {
        const result = prefetchedStorage && typeof prefetchedStorage === 'object'
            ? prefetchedStorage
            : await chrome.storage.local.get([SHOW_BOOKMARK_NOTES_STORAGE_KEY]);
        // Default ON when preference key is missing.
        showBookmarkNotes = result[SHOW_BOOKMARK_NOTES_STORAGE_KEY] !== false;
        applyShowBookmarkNotesSetting(showBookmarkNotes);

        const toggle = document.getElementById('showBookmarkNotesToggle');
        if (toggle) {
            toggle.checked = showBookmarkNotes;
        }
    } catch (error) {
        console.error('Failed to load bookmark notes visibility setting:', error);
    }
}

// Handle show bookmark notes toggle change
async function handleShowBookmarkNotesToggle(event) {
    if (!canMutateAccountScopedPreferences()) {
        await loadShowBookmarkNotesSetting();
        return;
    }

    showBookmarkNotes = event.target.checked;

    try {
        await chrome.storage.local.set({ [SHOW_BOOKMARK_NOTES_STORAGE_KEY]: showBookmarkNotes });
        applyShowBookmarkNotesSetting(showBookmarkNotes);
    } catch (error) {
        console.error('Failed to save bookmark notes visibility setting:', error);
    }
}

// Apply bookmark note visibility setting to the page
function applyShowBookmarkNotesSetting(notesVisible) {
    document.body.classList.toggle('show-bookmark-notes', notesVisible === true);
}

async function loadCloseTabsAfterSaveAllTabsSetting(prefetchedStorage = null) {
    try {
        const result = prefetchedStorage && typeof prefetchedStorage === 'object'
            ? prefetchedStorage
            : await chrome.storage.local.get([CLOSE_TABS_AFTER_SAVE_ALL_STORAGE_KEY]);
        closeTabsAfterSaveAllTabsEnabled = result[CLOSE_TABS_AFTER_SAVE_ALL_STORAGE_KEY] === true;

        const toggle = document.getElementById('closeTabsAfterSaveAllToggle');
        if (toggle) {
            toggle.checked = closeTabsAfterSaveAllTabsEnabled;
        }
    } catch (error) {
        console.error('Failed to load close-tabs-after-save-all setting:', error);
    }
}

async function handleCloseTabsAfterSaveAllTabsToggle(event) {
    if (!canMutateAccountScopedPreferences()) {
        await loadCloseTabsAfterSaveAllTabsSetting();
        return;
    }

    closeTabsAfterSaveAllTabsEnabled = event.target.checked === true;

    try {
        await chrome.storage.local.set({
            [CLOSE_TABS_AFTER_SAVE_ALL_STORAGE_KEY]: closeTabsAfterSaveAllTabsEnabled
        });
    } catch (error) {
        console.error('Failed to save close-tabs-after-save-all setting:', error);
    }
}

function hasTrustedStartupStoredUser(storedUser, sessionInvalidation) {
    const userId = storedUser?.id || null;
    if (!userId) {
        return false;
    }
    if (!sessionInvalidation) {
        return true;
    }
    if (!sessionInvalidation.userId) {
        return false;
    }
    return sessionInvalidation.userId !== userId;
}

async function loadStartupStorageState() {
    if (!(typeof chrome !== 'undefined' && chrome.storage?.local?.get)) {
        return {
            loaded: false,
            storage: {},
            storedUser: null,
            sessionInvalidation: null,
            hasTrustedStoredUser: false
        };
    }

    try {
        const storage = await chrome.storage.local.get(STARTUP_STORAGE_KEYS);
        const storedUser = storage?.[SYNC_USER_STORAGE_KEY] || null;
        const sessionInvalidation = storage?.[SYNC_SESSION_INVALIDATED_STORAGE_KEY] || null;

        return {
            loaded: true,
            storage,
            storedUser,
            sessionInvalidation,
            hasTrustedStoredUser: hasTrustedStartupStoredUser(storedUser, sessionInvalidation)
        };
    } catch (error) {
        console.warn('Failed to load batched startup storage state:', error);
        return {
            loaded: false,
            storage: {},
            storedUser: null,
            sessionInvalidation: null,
            hasTrustedStoredUser: false
        };
    }
}

/*
========================================
PAGE INITIALIZATION
========================================
Initialize the database and load content when page loads
*/

// Initialize the application when DOM is ready
document.addEventListener('DOMContentLoaded', async function () {
    try {
        const startupStorageState = await loadStartupStorageState();
        const initialWallpaperScopeUser = startupStorageState.storedUser;
        const startupStorage = startupStorageState.loaded ? startupStorageState.storage : null;
        const hasTrustedStoredUser = startupStorageState.hasTrustedStoredUser === true;
        const welcomeScreen = document.getElementById('welcomeScreen');

        await loadFloatingControlsCollapseSetting(startupStorage);
        await loadUsageTrackingSetting();
        setActiveStoredUserId(initialWallpaperScopeUser?.id || null);
        writeThemeBootstrapAuthHint(hasTrustedStoredUser);

        if (hasTrustedStoredUser) {
            document.body.classList.remove('not-authenticated');
            beginWorkspaceStartupShell();
            if (welcomeScreen) welcomeScreen.classList.add('hidden');
        }

        setWorkspaceOwnerUserId(initialWallpaperScopeUser?.id || null);
        await loadWallpaperCloudSyncStateFromStorage(
            initialWallpaperScopeUser?.id || null,
            startupStorage?.[WALLPAPER_CLOUD_SYNC_STATE_STORAGE_KEY]
        );

        // Apply theme mode at the earliest possible point to avoid color flash.
        await loadThemeModeFromStorage(startupStorage, {
            allowStorageThemeMode: hasTrustedStoredUser,
            allowCachedThemeMode: hasTrustedStoredUser,
            persistMissingThemeMode: hasTrustedStoredUser
        });
        await loadFontColorSetting(startupStorage);

        // EARLY IMPORT CHECK: Show loading overlay immediately if import parameter is present.
        // This happens BEFORE any other initialization to provide instant visual feedback.
        const urlParams = new URLSearchParams(window.location.search);
        const initialLocationHash = window.location.hash || '';
        const hasPendingAuthRedirect =
            initialLocationHash.includes('access_token') ||
            initialLocationHash.includes('error=') ||
            initialLocationHash.includes('error_description=') ||
            urlParams.has('code') ||
            urlParams.has('error') ||
            urlParams.has('error_description') ||
            urlParams.get('type') === 'recovery' ||
            initialLocationHash.includes('type=recovery');
        const importShareId = urlParams.get('import');
        const isContextMenuImport = urlParams.get('contextMenuImport');
        const hasDeferredImportFlow = Boolean(importShareId || isContextMenuImport);
        if (hasDeferredImportFlow) {
            const loadingOverlay = document.getElementById('loadingOverlay');
            const loadingTitle = document.getElementById('loadingTitle');
            const loadingMessage = document.getElementById('loadingMessage');
            if (loadingOverlay && loadingTitle && loadingMessage) {
                if (importShareId) {
                    loadingTitle.textContent = 'Importing...';
                    loadingMessage.textContent = 'Fetching shared content';
                } else {
                    loadingTitle.textContent = 'Preparing import...';
                    loadingMessage.textContent = 'Please wait while we load links';
                }
                loadingOverlay.style.display = '';
                loadingOverlay.classList.remove('hidden');
            }
        }



        // CRITICAL: Initialize UI event listeners FIRST, before ANY async operations
        // These only need DOM elements (which exist at DOMContentLoaded)
        // This prevents silent failures from async operations from breaking UI
        setupModalEventListeners();
        initTrashFeature();
        initSelectFeature();
        initSearchFeature();

        // Listen for auth failures from SyncManager (e.g., invalid refresh token, 401/403 errors)
        window.addEventListener('lumilist-auth-failure', async (e) => {
            await handleSessionInvalidation(
                e.detail?.reason || 'Session expired. Please login again.'
            );
        });

        // SUBSCRIPTION UPDATE: Re-validate subscription when tab becomes visible
        // This handles the case when user subscribes on website and returns to extension
        // Uses 5-second cooldown to prevent excessive API calls on rapid tab switching
        document.addEventListener('visibilitychange', async () => {
            if (document.visibilityState === 'visible') {
                await checkSubscriptionOnReturn();
            }
        });

        initIncognitoLinkHandler();
        initMorphActionHandler(); // Event delegation for Idiomorph-generated board/bookmark buttons

        // EARLY BANNER FIX: Show subscription banner from cache IMMEDIATELY
        // This prevents the 70px content shift flicker by showing the banner
        // BEFORE any async operations (like autoSyncOnLoad) complete.
        // Must be after UI listeners (so banner dismiss buttons work)
        await showBannerFromCachedStatus();

        // CROSS-BROWSER SYNC FIX: Add listener for sync status events
        // This allows UI to respond to sync errors and show appropriate feedback
        window.addEventListener('lumilist-sync-status', (event) => {
            try {
                const detail = event?.detail;
                if (!detail) return;
                const { status, detail: errorDetail } = detail;
                if (status === 'error') {
                    console.error('Sync error:', errorDetail);
                    showGlassToast('Sync failed. Changes saved locally.', 'warning');
                } else if (status === 'success') {

                }
            } catch (error) {
                console.error('Error handling sync status event:', error);
            }
        });

        // Loading overlay is visible by default - update message (but skip while import flow is active)
        if (!hasDeferredImportFlow) {
            updateLoadingMessage('Loading LumiList...', 'Checking authentication...');
        }

        // Early detection of recovery mode - show blocking overlay BEFORE anything renders
        // Note: urlParams already defined at top of this handler for import check
        if (urlParams.get('type') === 'recovery' || initialLocationHash.includes('type=recovery')) {

            isRecoveryMode = true;
            document.body.classList.add('recovery-mode');  // Hide all UI elements
            const recoveryOverlay = document.getElementById('recoveryOverlay');
            if (recoveryOverlay) {
                recoveryOverlay.classList.add('active');
            }
            // Hide loading overlay during recovery mode
            hideLoadingOverlay();
        }

        // Force bypass login check - always treat as "logged in" for local-only use
        let isLoggedIn = true;
        setWorkspaceOwnerUserId(null);

        // Always hide welcome screen and show workspace
        document.body.classList.remove('not-authenticated');
        beginWorkspaceStartupShell();
        if (welcomeScreen) welcomeScreen.classList.add('hidden');

        try {
            await initializeDatabase({
                shouldLoadBoards: true,
                isLoggedIn: false, // Tell DB system we are not technically authenticated (for sync logic)
                startupStorage,
                deferBootstrap: false
            });
        } finally {
            finishWorkspaceStartupShell();
        }

        void (async () => {
            try {
                await ensureWallpaperPreferencesInitialized(startupStorage);
                await applyWebsiteWallpaperHandoffFromUrl();
            } catch (error) {
                console.error('Deferred wallpaper startup initialization failed:', error);
            }
        })();

        await initializeUndoRedoHistoryState();

        // Initialize entity count caches for limit checking
        await Promise.all([
            initPageCount(),
            initBoardCount(),
            initBookmarkCount()
        ]);

        // Handle auth redirects first (OAuth, email verification, password reset)
        // This must run before auto-sync to properly handle the auth flow
        // Pass the early-captured hash since Supabase may have cleared it by now
        const wasAuthRedirect = await handleAuthRedirect(initialLocationHash);
        if (wasAuthRedirect) {

            // If it was an auth redirect, the handleAuthRedirect function handles the UI updates
        }

        // Set up auth state change listener to handle session expiration and token refresh.
        // The callback itself stays synchronous and defers work into our own queue.
        const authListenerState = {
            hasCompletedInitialSync: false,
            queue: Promise.resolve(),
            wasAuthRedirect
        };
        const supabase = SyncManager.getSupabase();
        if (supabase) {
            supabase.auth.onAuthStateChange((event, session) => {
                // Ignore ALL auth events during initial page load to prevent blocking initialization.
                // On page load, Supabase may fire INITIAL_SESSION or SIGNED_IN; those must stay ignored.
                if (!initialAuthCompleted) {

                    return;
                }

                queueSupabaseAuthStateChange(authListenerState, event, session);
            });
        }

        // Server-first: Auto-sync on page load (fetch from server if logged in)
        // Skip auto-sync during password recovery to keep the reset form visible
        // Skip auto-sync if this was a login redirect (handleAuthRedirect already called syncOnLogin)
        // Sync happens silently in background - no loading overlay on refresh/new tab
        const isLoginRedirect = wasAuthRedirect === true;
        if (!isLoginRedirect && wasAuthRedirect !== 'recovery' && typeof SyncManager !== 'undefined' && SyncManager.autoSyncOnLoad) {
            try {
                // Sync with server and check if changes were merged
                const changesOccurred = await SyncManager.autoSyncOnLoad();
                await applyWallpaperCloudSyncState(
                    (await chrome.storage.local.get(WALLPAPER_CLOUD_SYNC_STATE_STORAGE_KEY))[WALLPAPER_CLOUD_SYNC_STATE_STORAGE_KEY],
                    { source: 'post-auto-sync' }
                );

                // Validate currentPageId still exists (or repopulate it after a startup bootstrap/import).
                const pagesAfterSync = await db.pages.filter(p => !p.deletedAt).sortBy('order');
                if (pagesAfterSync.length > 0) {
                    const currentPageExists = currentPageId
                        ? pagesAfterSync.find(page => page.id === currentPageId)
                        : null;
                    if (!currentPageExists) {
                        currentPageId = pagesAfterSync[0].id;
                        chrome.storage.local.set({ currentPageId: pagesAfterSync[0].id });

                    }
                }

                // Recalculate bookmark count after sync (may have changed from server)
                await recalculateBookmarkCount();

                // Only refresh UI if server had changes (avoids double render with Idiomorph)
                if (changesOccurred) {
                    await loadPagesNavigation({ scrollToActive: false });
                    await loadBoardsFromDatabase();

                } else {

                }
                // Always refresh subscription UI with fresh data from server
                checkSubscription();
            } catch (error) {
                console.error('Auto-sync error:', error);
                reportReviewPromptIssue('sync').catch((issueError) => {
                    console.warn('[ReviewPrompt] Failed to track auto-sync issue:', issueError);
                });
                // Check if we have a cached user (instant - never fails on network errors)
                // Only show welcome screen if truly logged out, not on network issues
                const cachedUser = await SyncManager.getStoredUser();
                if (!cachedUser?.id) {
                    console.error('No cached user - session expired, updating auth UI...');
                    updateAuthUI();
                } else if (!(await hasAnyLocalWorkspaceData())) {
                    console.error('Sync failed and no local workspace cache is available - keeping welcome screen visible');
                    await showWorkspaceLoadFailure('We could not load your data. Please refresh and try again.');
                } else {
                    console.error('Sync failed but user is cached - likely network issue, not updating auth UI');
                }
            }
        }
        // Mark init sync as complete - prevents redundant sync in SIGNED_IN handler
        authListenerState.hasCompletedInitialSync = true;

        // NOTE: Modal event listeners, trash, select, incognito, and lock page event listeners
        // are now initialized EARLY at the start of DOMContentLoaded (before any async operations)
        // to prevent silent failures from async errors breaking the UI.

        // NOTE: Startup display and shell settings now come from the batched
        // initializeDatabase() preload path before the first board render.

        // Clean up expired trash items (items older than 30 days)
        // FIX [Issue #1]: Add await to prevent data loss if tab closes immediately
        await cleanupExpiredTrash();


        // Clean up expired favicon cache entries (older than 7 days)
        // FIX [Issue #1]: Add await to prevent incomplete cleanup if tab closes
        await cleanupExpiredFavicons();


        // Ensure first tab is selected (handles race conditions)
        if (isLoggedIn) {
            updateLoadingMessage('Almost ready...', 'Preparing your workspace...');
            await ensureFirstTabSelected();
            // Note: Boards already loaded at line 7971 after autoSyncOnLoad() - no need to reload here
        }

        // All done - hide loading overlay (but not if import is in progress)
        if (!hasDeferredImportFlow) {
            hideLoadingOverlay();
        }

        // Check onboarding AFTER loading overlay is hidden (only for logged in users)
        if (isLoggedIn) {
            await checkShowOnboarding();
        }

        // Mark initialization complete - auth state listener can now respond to events
        initialAuthCompleted = true;

        // Process any cross-tab auth/sync signals that arrived during init
        if (_pendingLoginSyncSignal) {
            await handleLoginSyncCompleteSignal(_pendingLoginSyncSignal);
            _pendingLoginSyncSignal = null;
            _pendingAuthChange = null;
        } else if (_pendingAuthChange?.newValue) {
            beginCrossTabLoginWait(_pendingAuthChange.newValue.id);
            _pendingAuthChange = null;
        }

        // Late auth reconcile: handle cases where login happened before listeners were ready
        // This avoids tabs getting stuck on the welcome screen after cross-tab login.
        try {
            if (typeof SyncManager !== 'undefined') {
                const storedUser = await SyncManager.getStoredUser();
                const welcomeScreen = document.getElementById('welcomeScreen');
                const isWelcomeVisible = welcomeScreen && !welcomeScreen.classList.contains('hidden');
                if (storedUser?.id && isWelcomeVisible && !isLateAuthReconcileSuppressed()) {
                    const signalResult = await chrome.storage.local.get('lumilist_login_sync_complete');
                    const signal = signalResult?.lumilist_login_sync_complete;
                    if (signal?.userId === storedUser.id) {
                        await handleLoginSyncCompleteSignal(signal);
                    } else {
                        const [pageCount, boardCount, bookmarkCount] = await Promise.all([
                            db.pages.count(),
                            db.boards.count(),
                            db.bookmarks.count()
                        ]);
                        const hasLocalData = (pageCount + boardCount + bookmarkCount) > 0;
                        if (hasLocalData) {
                            await handleLoginSyncCompleteSignal({
                                userId: storedUser.id,
                                timestamp: Date.now()
                            });
                        } else {
                            beginCrossTabLoginWait(storedUser.id);
                        }
                    }
                }
            }
        } catch (e) {
            console.error('Late auth reconcile failed:', e);
        }

    } catch (error) {
        // CRITICAL: Show recovery UI if initialization fails completely
        console.error('Critical initialization error:', error);
        finishWorkspaceStartupShell();

        // Hide loading overlay if present
        const loadingOverlay = document.getElementById('loadingOverlay');
        if (loadingOverlay) {
            loadingOverlay.classList.add('hidden');
        }

        // Show error message to user
        const errorContainer = document.createElement('div');
        errorContainer.className = 'fatal-init-error';
        const titleEl = document.createElement('h2');
        titleEl.className = 'fatal-init-error-title';
        titleEl.textContent = 'Something went wrong';

        const messageEl = document.createElement('p');
        messageEl.className = 'fatal-init-error-message';
        messageEl.textContent = 'LumiList encountered an error during initialization. Please try refreshing the page.';

        const refreshBtn = document.createElement('button');
        refreshBtn.className = 'fatal-init-error-button';
        refreshBtn.textContent = 'Refresh Page';
        refreshBtn.addEventListener('click', () => window.location.reload());

        const errorEl = document.createElement('p');
        errorEl.className = 'fatal-init-error-detail';
        const errorMessage = (error && error.message) ? error.message : 'Unknown error';
        errorEl.textContent = `Error: ${errorMessage}`;

        errorContainer.append(titleEl, messageEl, refreshBtn, errorEl);
        document.body.appendChild(errorContainer);
    }
});

// Helper for safe modal close-on-click-outside
// Only closes when both mousedown and mouseup happen on the overlay
function setupModalClickOutside(modal, closeFunction) {
    if (!modal) return;
    let mouseDownOnOverlay = false;

    const handleMouseDown = (e) => {
        mouseDownOnOverlay = (e.target === modal);
    };

    const handleMouseUp = (e) => {
        if (mouseDownOnOverlay && e.target === modal) {
            closeFunction();
        }
        mouseDownOnOverlay = false;
    };

    modal.addEventListener('mousedown', handleMouseDown);
    modal.addEventListener('mouseup', handleMouseUp);
}

// Set up event listeners for modal interactions
let modalEventListenersInitialized = false;
function setupModalEventListeners() {
    if (modalEventListenersInitialized) return;
    modalEventListenersInitialized = true;

    // Page navigation setup - both plus buttons trigger the same modal
    const addPageBtn = document.getElementById('addPageBtn');
    if (addPageBtn) {
        addPageBtn.addEventListener('click', openAddPageModal);
    }
    const addPageBtnOverflow = document.getElementById('addPageBtnOverflow');
    if (addPageBtnOverflow) {
        addPageBtnOverflow.addEventListener('click', openAddPageModal);
    }

    // Floating Add Board button setup - uses inline input in column 0 (removed from UI)
    const floatingAddBtn = document.getElementById('floatingAddBtn');
    if (floatingAddBtn) {
        floatingAddBtn.addEventListener('click', () => showInlineBoardInput(0));
    }

    // Bookmark modal setup
    const bookmarkModal = document.getElementById('addBookmarkModal');
    const bookmarkForm = document.getElementById('addBookmarkForm');
    const cancelBtn = document.getElementById('cancelBtn');
    const bookmarkDescriptionField = document.getElementById('bookmarkDescription');
    const bookmarkDescriptionRemaining = document.getElementById('bookmarkDescriptionRemaining');

    // Board modal setup
    const boardModal = document.getElementById('addBoardModal');
    const boardForm = document.getElementById('addBoardForm');
    const cancelBoardBtn = document.getElementById('cancelBoardBtn');

    // Page modal setup
    const pageModal = document.getElementById('addPageModal');
    const pageForm = document.getElementById('addPageForm');
    const cancelPageBtn = document.getElementById('cancelPageBtn');

    // Settings modal setup
    const settingsModal = document.getElementById('settingsModal');
    const floatingSettingsBtn = document.getElementById('floatingSettingsBtn');
    const cancelSettingsBtn = document.getElementById('cancelSettingsBtn');
    const reviewPromptModal = document.getElementById(REVIEW_PROMPT_MODAL_ID);
    const reviewPromptLeaveReviewBtn = document.getElementById('reviewPromptLeaveReviewBtn');
    const reviewPromptNotNowBtn = document.getElementById('reviewPromptNotNowBtn');

    // Bookmark modal listeners
    setupModalClickOutside(bookmarkModal, closeAddBookmarkModal);

    cancelBtn.addEventListener('click', closeAddBookmarkModal);

    bookmarkForm.addEventListener('submit', async function (e) {
        e.preventDefault();

        const formData = new FormData(bookmarkForm);
        const title = formData.get('title');
        const url = formData.get('url');
        const description = formData.get('description');

        // Validate required fields
        if (!title || !url) {
            showGlassToast('Please fill in both title and URL fields.', 'warning');
            return;
        }

        // Validate URL format
        if (!isValidUrl(url)) {
            showGlassToast('Please enter a valid URL (e.g., https://example.com)', 'warning');
            return;
        }

        // Add the bookmark
        await addNewBookmark(title, url, description);

        // Close modal
        closeAddBookmarkModal();
    });

    if (reviewPromptModal) {
        setupModalClickOutside(reviewPromptModal, () => {
            closeReviewPromptModal({ recordDismiss: true }).catch((error) => {
                console.warn('[ReviewPrompt] Failed to close modal on outside click:', error);
            });
        });
    }
    if (reviewPromptLeaveReviewBtn) {
        reviewPromptLeaveReviewBtn.addEventListener('click', () => {
            handleReviewPromptLeaveReview().catch((error) => {
                console.warn('[ReviewPrompt] Leave-review handler failed:', error);
            });
        });
    }
    if (reviewPromptNotNowBtn) {
        reviewPromptNotNowBtn.addEventListener('click', () => {
            handleReviewPromptNotNow().catch((error) => {
                console.warn('[ReviewPrompt] Not-now handler failed:', error);
            });
        });
    }

    // Board modal listeners
    setupModalClickOutside(boardModal, closeAddBoardModal);

    cancelBoardBtn.addEventListener('click', closeAddBoardModal);

    boardForm.addEventListener('submit', async function (e) {
        e.preventDefault();

        const formData = new FormData(boardForm);
        const name = formData.get('name');
        const description = formData.get('description');

        // Validate required fields
        if (!name || name.trim() === '') {
            showGlassToast('Please enter a board name.', 'warning');
            return;
        }

        // Create the board
        await createNewBoard(name, description);

        // Close modal
        closeAddBoardModal();
    });

    // Page modal listeners
    setupModalClickOutside(pageModal, closeAddPageModal);

    cancelPageBtn.addEventListener('click', closeAddPageModal);

    pageForm.addEventListener('submit', async function (e) {
        e.preventDefault();

        const formData = new FormData(pageForm);
        const name = formData.get('name');
        const password = formData.get('password');

        // Validate required fields
        if (!name || name.trim() === '') {
            showGlassToast('Please enter a page name.', 'warning');
            return;
        }

        // Close modal immediately for better UX
        closeAddPageModal();

        try {
            // Create the page (async operations happen in background)
            await createNewPage(name, password);
        } catch (error) {
            showGlassToast('Failed to create page. Please try again.', 'error');
            console.error('Page creation failed:', error);
        }
    });

    // Edit bookmark modal setup
    const editBookmarkModal = document.getElementById('editBookmarkModal');
    const editBookmarkForm = document.getElementById('editBookmarkForm');
    const cancelEditBookmarkBtn = document.getElementById('cancelEditBookmarkBtn');
    const editBookmarkDescriptionField = document.getElementById('editBookmarkDescription');
    const editBookmarkDescriptionRemaining = document.getElementById('editBookmarkDescriptionRemaining');

    initializeDescriptionRemainingCounter(bookmarkDescriptionField, bookmarkDescriptionRemaining);
    initializeDescriptionRemainingCounter(editBookmarkDescriptionField, editBookmarkDescriptionRemaining);

    // Edit bookmark modal listeners
    setupModalClickOutside(editBookmarkModal, closeEditBookmarkModal);

    cancelEditBookmarkBtn.addEventListener('click', closeEditBookmarkModal);

    // Fetch title button in edit bookmark modal
    document.getElementById('fetchEditTitleBtn').addEventListener('click', async function () {
        const urlInput = document.getElementById('editBookmarkUrl');
        const titleInput = document.getElementById('editBookmarkTitle');
        const errorSpan = document.getElementById('fetchTitleError');
        const url = urlInput.value.trim();

        // Clear previous error
        errorSpan.textContent = '';

        if (!url || !isValidUrl(url)) {
            errorSpan.textContent = 'Please enter a valid URL first';
            return;
        }

        // Show loading state
        const originalText = this.textContent;
        this.disabled = true;
        this.textContent = 'Fetching...';

        try {
            const result = await fetchPageTitleFromBackground(url);

            const fetchedTitle = (result?.success && typeof result.title === 'string')
                ? result.title.trim()
                : '';

            titleInput.value = fetchedTitle || getFallbackTitleFromUrl(url);
            titleInput.focus();
            titleInput.select();
        } catch (error) {
            console.error('Error fetching title:', error);
            titleInput.value = getFallbackTitleFromUrl(url);
            titleInput.focus();
            titleInput.select();
        } finally {
            this.disabled = false;
            this.textContent = originalText;
        }
    });

    editBookmarkForm.addEventListener('submit', async function (e) {
        e.preventDefault();

        if (!currentBookmarkToEdit) return;
        const bookmarkId = currentBookmarkToEdit;

        const formData = new FormData(editBookmarkForm);
        const title = formData.get('title');
        const url = formData.get('url');
        const description = formData.get('description');

        // Validate required fields
        if (!title || !url) {
            showGlassToast('Please fill in both title and URL fields.', 'warning');
            return;
        }

        // Validate URL format
        if (!isValidUrl(url)) {
            showGlassToast('Please enter a valid URL (e.g., https://example.com)', 'warning');
            return;
        }

        // Close modal immediately; run async updates in the background
        closeEditBookmarkModal();

        // Update the bookmark
        await saveBookmarkEdit(bookmarkId, title, url, description);
    });

    // Edit board modal setup
    const editBoardModal = document.getElementById('editBoardModal');
    const editBoardForm = document.getElementById('editBoardForm');
    const cancelEditBoardBtn = document.getElementById('cancelEditBoardBtn');

    // Edit board modal listeners
    setupModalClickOutside(editBoardModal, closeEditBoardModal);

    cancelEditBoardBtn.addEventListener('click', closeEditBoardModal);

    editBoardForm.addEventListener('submit', async function (e) {
        e.preventDefault();

        if (!currentBoardToEdit) return;
        const boardId = currentBoardToEdit;

        const formData = new FormData(editBoardForm);
        const name = formData.get('name');
        const color = document.getElementById('editBoardUseDefaultColor')?.checked ? null : formData.get('color');

        // Validate required fields
        if (!name || name.trim() === '') {
            showGlassToast('Please enter a board name.', 'warning');
            return;
        }

        // Close modal immediately; run async updates in the background
        closeEditBoardModal();

        // Update the board
        await updateBoardDetails(boardId, name, color);
    });

    const editBoardColor = document.getElementById('editBoardColor');
    const editBoardUseDefaultColor = document.getElementById('editBoardUseDefaultColor');
    if (editBoardColor && editBoardUseDefaultColor) {
        editBoardUseDefaultColor.addEventListener('change', () => {
            editBoardColor.disabled = editBoardUseDefaultColor.checked;
        });
    }

    // Rename page modal listeners
    const renamePageModal = document.getElementById('renamePageModal');
    const cancelRenamePageBtn = document.getElementById('cancelRenamePageBtn');
    const renamePageForm = document.getElementById('renamePageForm');

    setupModalClickOutside(renamePageModal, closeRenamePageModal);

    cancelRenamePageBtn.addEventListener('click', closeRenamePageModal);

    renamePageForm.addEventListener('submit', async function (e) {
        e.preventDefault();

        if (!currentPageToRename) {
            console.error('No page selected for rename');
            closeRenamePageModal();
            return;
        }

        const pageId = currentPageToRename.id;
        if (!pageId) {
            console.error('Page ID is missing:', currentPageToRename);
            closeRenamePageModal();
            return;
        }

        const newName = document.getElementById('renamePageInput').value.trim();
        if (!newName) {
            showGlassToast('Please enter a page name.', 'warning');
            return;
        }

        // Close immediately; run async updates in the background
        closeRenamePageModal();

        try {
            await updatePage(pageId, { name: newName });
            await loadPagesNavigation();
        } catch (error) {
            console.error('Failed to rename page:', error);
            showGlassToast('Failed to rename page. Please try again.', 'error');
        }
    });

    // Delete confirmation modal setup
    const deleteConfirmModal = document.getElementById('deleteConfirmModal');
    const cancelDeleteBtn = document.getElementById('cancelDeleteBtn');
    const confirmDeleteBtn = document.getElementById('confirmDeleteBtn');

    // Delete confirmation modal listeners
    setupModalClickOutside(deleteConfirmModal, cancelDeletion);

    cancelDeleteBtn.addEventListener('click', cancelDeletion);

    confirmDeleteBtn.addEventListener('click', confirmDeletion);

    // Settings modal listeners
    if (floatingSettingsBtn) {
        floatingSettingsBtn.addEventListener('click', openSettingsModal);
    } else {
        console.error('Settings button not found!');
    }

    if (settingsModal) {
        setupModalClickOutside(settingsModal, closeSettingsModal);
    }

    // Truncate titles toggle
    const truncateTitlesToggle = document.getElementById('truncateTitlesToggle');
    if (truncateTitlesToggle) {
        truncateTitlesToggle.addEventListener('change', handleTruncateTitlesToggle);
    }

    // Open in new tab toggle
    const openInNewTabToggle = document.getElementById('openInNewTabToggle');
    if (openInNewTabToggle) {
        openInNewTabToggle.addEventListener('change', handleOpenInNewTabToggle);
    }

    // Show bookmark notes toggle
    const showBookmarkNotesToggle = document.getElementById('showBookmarkNotesToggle');
    if (showBookmarkNotesToggle) {
        showBookmarkNotesToggle.addEventListener('change', handleShowBookmarkNotesToggle);
    }

    const smartFoldersToggle = document.getElementById('smartFoldersToggle');
    if (smartFoldersToggle) {
        smartFoldersToggle.addEventListener('change', toggleSmartFoldersSetting);
    }

    const taggingToggle = document.getElementById('taggingToggle');
    if (taggingToggle) {
        taggingToggle.addEventListener('change', toggleTaggingSetting);
    }

    const advancedSearchToggle = document.getElementById('advancedSearchToggle');
    if (advancedSearchToggle) {
        advancedSearchToggle.addEventListener('change', toggleAdvancedSearchSetting);
    }

    const fuzzySearchToggle = document.getElementById('fuzzySearchToggle');
    if (fuzzySearchToggle) {
        fuzzySearchToggle.addEventListener('change', toggleFuzzySearchSetting);
    }

    const recentlyUsedToggle = document.getElementById('recentlyUsedToggle');
    if (recentlyUsedToggle) {
        recentlyUsedToggle.addEventListener('change', toggleRecentlyUsedSetting);
    }

    const frequentlyUsedToggle = document.getElementById('frequentlyUsedToggle');
    if (frequentlyUsedToggle) {
        frequentlyUsedToggle.addEventListener('change', toggleFrequentlyUsedSetting);
    }

    const pinFavoritesToggle = document.getElementById('pinFavoritesToggle');
    if (pinFavoritesToggle) {
        pinFavoritesToggle.addEventListener('change', togglePinFavoritesSetting);
    }

    const closeTabsAfterSaveAllToggle = document.getElementById('closeTabsAfterSaveAllToggle');
    if (closeTabsAfterSaveAllToggle) {
        closeTabsAfterSaveAllToggle.addEventListener('change', handleCloseTabsAfterSaveAllTabsToggle);
    }

    const fontColorInput = document.getElementById('fontColorInput');
    if (fontColorInput) {
        fontColorInput.addEventListener('input', handleFontColorChange);
    }

    const resetFontColorBtn = document.getElementById('resetFontColorBtn');
    if (resetFontColorBtn) {
        resetFontColorBtn.addEventListener('click', resetFontColorSetting);
    }

    // Compact mode toggle
    const compactModeToggle = document.getElementById('compactModeToggle');
    if (compactModeToggle) {
        compactModeToggle.addEventListener('change', toggleCompactMode);
    }

    const usageTrackingToggle = document.getElementById('usageTrackingToggle');
    if (usageTrackingToggle) {
        usageTrackingToggle.addEventListener('change', toggleUsageTrackingSetting);
    }

    // Automatic Board Color toggle
    const autoBoardColorToggle = document.getElementById('autoBoardColorToggle');
    if (autoBoardColorToggle) {
        autoBoardColorToggle.addEventListener('change', handleAutoBoardColorToggle);
    }

    // Randomize Board Color button in edit modal
    const randomizeBoardColorBtn = document.getElementById('randomizeBoardColorBtn');
    if (randomizeBoardColorBtn) {
        randomizeBoardColorBtn.addEventListener('click', () => {
            const colorInput = document.getElementById('editBoardColor');
            const defaultToggle = document.getElementById('editBoardUseDefaultColor');
            if (colorInput) {
                if (defaultToggle) {
                    defaultToggle.checked = false;
                    colorInput.disabled = false;
                }
                colorInput.value = generateRandomColor();
            }
        });
    }

    // Show clock toggle
    const showClockToggle = document.getElementById('showClockToggle');
    if (showClockToggle) {
        showClockToggle.addEventListener('change', handleShowClockToggle);
    }

    const floatingControlsCollapsedToggle = document.getElementById('floatingControlsCollapsedToggle');
    if (floatingControlsCollapsedToggle) {
        floatingControlsCollapsedToggle.addEventListener('change', toggleFloatingControlsCollapseSetting);
    }

    // Large board collapse toggle
    const largeBoardCollapseToggle = document.getElementById('largeBoardCollapseToggle');
    if (largeBoardCollapseToggle) {
        largeBoardCollapseToggle.addEventListener('change', handleLargeBoardCollapseToggle);
    }

    const largeBoardVisibleLimitSelect = document.getElementById('largeBoardVisibleLimitSelect');
    if (largeBoardVisibleLimitSelect) {
        largeBoardVisibleLimitSelect.addEventListener('change', handleLargeBoardVisibleLimitChange);
    }

    // Customize Background settings
    const customizeBackgroundPageSelect = document.getElementById('customizeBackgroundPageSelect');
    if (customizeBackgroundPageSelect) {
        customizeBackgroundPageSelect.addEventListener('change', updateResetBackgroundButtonVisibility);
    }

    const changePageBackgroundBtn = document.getElementById('changePageBackgroundBtn');
    if (changePageBackgroundBtn) {
        changePageBackgroundBtn.addEventListener('click', handleChangePageBackgroundClick);
    }

    const resetPageBackgroundBtn = document.getElementById('resetPageBackgroundBtn');
    if (resetPageBackgroundBtn) {
        resetPageBackgroundBtn.addEventListener('click', handleResetPageBackgroundClick);
    }

    // Quick save destination setting
    const settingsQuickSavePage = document.getElementById('settingsQuickSavePage');
    if (settingsQuickSavePage) {
        settingsQuickSavePage.addEventListener('change', async () => {
            if (!canMutateAccountScopedPreferences()) {
                await loadSettingsQuickSaveDestinationOptions();
                return;
            }

            try {
                await chrome.storage.local.set({ quickSavePageId: settingsQuickSavePage.value || 'current' });
            } catch (error) {
                console.error('Failed to save quick save destination from settings:', error);
                showGlassToast('Failed to save quick save destination. Please try again.', 'error');
            }
        });
    }

    // Quick save shortcut change button
    const settingsChangeShortcutBtn = document.getElementById('settingsChangeShortcutBtn');
    if (settingsChangeShortcutBtn) {
        settingsChangeShortcutBtn.addEventListener('click', async () => {
            await openQuickSaveShortcutSettings();
        });
    }

    const settingsShortcutDefaultBoard = document.getElementById('settingsShortcutDefaultBoard');
    if (settingsShortcutDefaultBoard) {
        settingsShortcutDefaultBoard.addEventListener('change', async () => {
            try {
                await saveShortcutDefaultBoardSetting();
            } catch (error) {
                console.error('Failed to save shortcut default board:', error);
                showGlassToast('Failed to save shortcut default board. Please try again.', 'error');
            }
        });
    }

    const settingsShortcutUseLastBoardToggle = document.getElementById('settingsShortcutUseLastBoardToggle');
    if (settingsShortcutUseLastBoardToggle) {
        settingsShortcutUseLastBoardToggle.addEventListener('change', async () => {
            try {
                await saveShortcutUseLastBoardSetting();
            } catch (error) {
                console.error('Failed to save shortcut board preference:', error);
                showGlassToast('Failed to save shortcut board preference. Please try again.', 'error');
            }
        });
    }

    window.addEventListener('focus', () => {
        if (settingsModal && settingsModal.classList.contains('active')) {
            loadSettingsQuickSaveShortcut().catch(err => {
                console.error('Failed to refresh quick save shortcut in settings:', err);
            });
            loadShortcutBoardSettingsControls().catch((error) => {
                console.error('Failed to refresh shortcut board settings in settings modal:', error);
            });
        }
    });

    // Private links incognito toggle
    const privateLinksIncognitoToggle = document.getElementById('privateLinksIncognitoToggle');
    if (privateLinksIncognitoToggle) {
        // Load saved setting
        chrome.storage.local.get('privateLinksIncognito', (result) => {
            // Default to true (checked) if not set
            privateLinksIncognitoToggle.checked = result.privateLinksIncognito !== false;
        });

        // Save on change
        privateLinksIncognitoToggle.addEventListener('change', async function () {
            if (!canMutateAccountScopedPreferences()) {
                try {
                    const result = await chrome.storage.local.get('privateLinksIncognito');
                    this.checked = result.privateLinksIncognito !== false;
                } catch (error) {
                    console.error('Failed to restore private-links incognito toggle after blocked change:', error);
                }
                return;
            }

            chrome.storage.local.set({ privateLinksIncognito: this.checked });
        });
    }

    if (cancelSettingsBtn) {
        cancelSettingsBtn.addEventListener('click', closeSettingsModal);
    }

    // Close settings X button
    const closeSettingsBtn = document.getElementById('closeSettingsBtn');
    if (closeSettingsBtn) {
        closeSettingsBtn.addEventListener('click', closeSettingsModal);
    }

    // Settings tabs switching
    if (settingsModal) {
        settingsModal.addEventListener('click', (e) => {
            const navItem = e.target.closest('.settings-nav-item');
            if (navItem) {
                const tabName = navItem.dataset.tab;

                // SPECIAL SECURITY CHECK: If user clicks "Security", ask for admin password
                if (tabName === 'security' && !lumiListModules.adminAuth.isAuthenticated()) {
                    const modal = document.getElementById('adminPasswordModal');
                    const error = document.getElementById('adminPasswordError');
                    const input = document.getElementById('adminPasswordInput');
                    
                    if (modal && input) {
                        input.value = '';
                        error.classList.add('hidden');
                        modal.classList.add('active');
                        setTimeout(() => input.focus(), 100);
                    }
                    return; // Stop here, wait for password
                }

                // Update tab buttons
                document.querySelectorAll('.settings-nav-item').forEach(t => t.classList.remove('active'));
                navItem.classList.add('active');

                // Update tab content
                document.querySelectorAll('.settings-tab-pane').forEach(c => c.classList.remove('active'));
                const tabId = 'settings' + tabName.charAt(0).toUpperCase() + tabName.slice(1) + 'Tab';
                const tabContent = document.getElementById(tabId);

                if (tabContent) {
                    tabContent.classList.add('active');
                    
                    // Special handling for security tab
                    if (tabName === 'security') {
                        loadSettingsSecurityOptions();
                    }
                } else {
                    console.warn('[Settings] Tab content element not found:', { tabName, tabId });
                }

                // Reset scroll position to top
                const settingsContent = document.querySelector('.settings-content'); // Scroll container inside modal
                if (settingsContent) settingsContent.scrollTop = 0;
            }
        });
    }

    // Chrome bookmarks import modal listeners
    const importChromeModal = document.getElementById('importChromeModal');
    const cancelChromeImportBtn = document.getElementById('cancelChromeImportBtn');
    const confirmChromeImportBtn = document.getElementById('confirmChromeImportBtn');

    if (cancelChromeImportBtn) {
        cancelChromeImportBtn.addEventListener('click', closeChromeImportModal);
    }

    if (confirmChromeImportBtn) {
        confirmChromeImportBtn.addEventListener('click', importSelectedChromeBookmarks);
    }

    if (importChromeModal) {
        setupModalClickOutside(importChromeModal, closeChromeImportModal);
    }

    // Onboarding modal listeners
    const onboardingModal = document.getElementById('onboardingModal');
    const skipOnboardingBtn = document.getElementById('skipOnboardingBtn');
    const importOnboardingBtn = document.getElementById('importOnboardingBtn');

    if (skipOnboardingBtn) {
        skipOnboardingBtn.addEventListener('click', () => {
            closeOnboardingModal();
            startQuickTour({ source: 'onboarding' }).catch((error) => {
                console.error('[QuickTour] Failed to start from onboarding:', error);
            });
        });
    }

    if (importOnboardingBtn) {
        importOnboardingBtn.addEventListener('click', () => {
            closeOnboardingModal();
            showChromeImportModal();
        });
    }

    if (onboardingModal) {
        setupModalClickOutside(onboardingModal, closeOnboardingModal);
    }

    // App-level undo/redo shortcuts.
    document.addEventListener('keydown', handleUndoRedoShortcutKeydown, true);

    // Close modals on Escape key
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
            if (typeof isSearchOverlayOpen === 'function' && isSearchOverlayOpen()) {
                closeSearchOverlay();
                return;
            }

            if (isFloatingToolsDockOpen()) {
                closeFloatingToolsDock();
                return;
            }

            if (reviewPromptModal && reviewPromptModal.classList.contains('active')) {
                closeReviewPromptModal({ recordDismiss: true }).catch((error) => {
                    console.warn('[ReviewPrompt] Failed to close modal on Escape:', error);
                });
                return;
            }

            const importLinksProgressModal = document.getElementById('importLinksProgressModal');
            if (importLinksProgressModal && importLinksProgressModal.classList.contains('active')) {
                requestCancelActiveImportLinksRun();
                return;
            }

            // Exit selection mode if active
            if (isSelectionMode) {
                toggleSelectionMode();
            }
            // Clear bookmark selection first
            if (selectedBookmarks.size > 0) {
                clearBookmarkSelection();
            }
            if (pageModal.classList.contains('active')) {
                closeAddPageModal();
            }
            if (bookmarkModal.classList.contains('active')) {
                closeAddBookmarkModal();
            }
            if (boardModal.classList.contains('active')) {
                closeAddBoardModal();
            }
            if (editBookmarkModal.classList.contains('active')) {
                closeEditBookmarkModal();
            }
            if (editBoardModal.classList.contains('active')) {
                closeEditBoardModal();
            }
            if (renamePageModal && renamePageModal.classList.contains('active')) {
                closeRenamePageModal();
            }
            if (deleteConfirmModal.classList.contains('active')) {
                cancelDeletion();
            }
            const trashModal = document.getElementById('trashModal');
            if (trashModal && trashModal.classList.contains('active')) {
                closeTrashModal();
            }
            if (settingsModal.classList.contains('active')) {
                closeSettingsModal();
            }
            if (importChromeModal && importChromeModal.classList.contains('active')) {
                closeChromeImportModal();
            }
            if (onboardingModal && onboardingModal.classList.contains('active')) {
                closeOnboardingModal();
            }
            // Share modal (Issue 5)
            const shareModal = document.getElementById('shareModal');
            if (shareModal && shareModal.classList.contains('active')) {
                closeShareModal();
            }
            // Import share modal - only close if it's active and not waiting for user input
            // Note: importShareModal uses Promise-based pattern, so we just close it visually
            const importShareModal = document.getElementById('importShareModal');
            if (importShareModal && importShareModal.classList.contains('active')) {
                // Clicking cancel button will properly resolve the promise
                const cancelBtn = document.getElementById('cancelImportShareBtn');
                if (cancelBtn) cancelBtn.click();
            }
            // Import links modal
            const importLinksModal = document.getElementById('importLinksModal');
            if (importLinksModal && importLinksModal.classList.contains('active')) {
                closeImportLinksModal();
            }
            const deleteAccountModal = document.getElementById('deleteAccountModal');
            if (deleteAccountModal && deleteAccountModal.classList.contains('active')) {
                closeDeleteAccountModal();
            }
            // Import popup menu
            const importPopup = document.getElementById('importPopup');
            if (importPopup && importPopup.classList.contains('active')) {
                closeImportPopup();
            }
            const wallpaperStyleModal = document.getElementById('wallpaperStyleModal');
            if (wallpaperStyleModal && wallpaperStyleModal.classList.contains('active')) {
                closeWallpaperStyleEditor();
                return;
            }
            const wallpaperPopup = document.getElementById('wallpaperPopup');
            if (wallpaperPopup && wallpaperPopup.classList.contains('active')) {
                closeWallpaperPopup();
            }
            // Page/board dropdown popups
            closeTabContextMenu();
            closeBoardMenus();
        }
    });

    // ========================================
    // AUTH & SYNC EVENT HANDLERS
    // ========================================
    setupAuthEventListeners();
}

/*
========================================
AUTH & SYNC UI FUNCTIONS
========================================
Handle authentication modal and sync functionality
*/

// Setup auth-related event listeners
function setupAuthEventListeners() {
    // Welcome screen Google button removed per user request
    const welcomeGoogleBtn = document.getElementById('welcomeGoogleBtn');
    if (welcomeGoogleBtn) {
        welcomeGoogleBtn.style.display = 'none';
    }

    // Settings modal account buttons
    const settingsSignInBtn = document.getElementById('settingsSignInBtn');
    const settingsLogoutBtn = document.getElementById('settingsLogoutBtn');

    if (settingsSignInBtn) {
        settingsSignInBtn.style.display = 'none';
    }

    if (settingsLogoutBtn) {
        settingsLogoutBtn.addEventListener('click', async () => {
            // Close settings modal
            const settingsModal = document.getElementById('settingsModal');
            if (settingsModal) settingsModal.classList.remove('active');
            // Perform logout
            await handleLogout();
        });
    }

    // Initialize Admin Auth Logic
    function initializeAdminAuth() {
        const modal = document.getElementById('adminPasswordModal');
        const form = document.getElementById('adminPasswordForm');
        const cancelBtn = document.getElementById('cancelAdminAuthBtn');
        const error = document.getElementById('adminPasswordError');
        const input = document.getElementById('adminPasswordInput');

        if (form) {
            form.addEventListener('submit', async (e) => {
                e.preventDefault();
                const password = input.value;
                const success = await lumiListModules.adminAuth.verifyAdminPassword(password);
                
                if (success) {
                    modal.classList.remove('active');
                    // Switch to security tab now that we are authorized
                    document.querySelectorAll('.settings-tab-pane').forEach(p => p.classList.remove('active'));
                    document.getElementById('settingsSecurityTab').classList.add('active');
                    document.querySelectorAll('.settings-nav-item').forEach(t => {
                        if (t.dataset.tab === 'security') t.classList.add('active');
                        else t.classList.remove('active');
                    });
                    loadSettingsSecurityOptions();
                } else {
                    error.classList.remove('hidden');
                }
            });
        }

        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => {
                modal.classList.remove('active');
                // Revert to general tab since auth was cancelled
                document.querySelector('.settings-nav-item[data-tab="general"]').click();
            });
        }
    }

    initializeAdminAuth();

    // Delete Account button and modal
    const deleteAccountBtn = document.getElementById('deleteAccountBtn');
    const deleteAccountModal = document.getElementById('deleteAccountModal');
    const cancelDeleteAccountBtn = document.getElementById('cancelDeleteAccountBtn');
    const confirmDeleteAccountBtn = document.getElementById('confirmDeleteAccountBtn');

    if (deleteAccountBtn) {
        deleteAccountBtn.addEventListener('click', () => {
            // Close settings modal first
            const settingsModal = document.getElementById('settingsModal');
            if (settingsModal) settingsModal.classList.remove('active');
            // Show delete account modal
            handleDeleteAccount();
        });
    }

    if (cancelDeleteAccountBtn) {
        cancelDeleteAccountBtn.addEventListener('click', () => {
            closeDeleteAccountModal();
        });
    }

    if (confirmDeleteAccountBtn) {
        confirmDeleteAccountBtn.addEventListener('click', () => {
            executeDeleteAccount();
        });
    }

    // Delete account input field listeners (set up once, not on every modal open)
    const deleteConfirmInput = document.getElementById('deleteConfirmInput');
    if (deleteConfirmInput && confirmDeleteAccountBtn) {
        // Enable/disable confirm button based on input
        deleteConfirmInput.addEventListener('input', () => {
            confirmDeleteAccountBtn.disabled = deleteConfirmInput.value.trim() !== 'DELETE';
        });

        // Handle Enter key
        deleteConfirmInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && deleteConfirmInput.value.trim() === 'DELETE') {
                confirmDeleteAccountBtn.click();
            }
        });
    }

    // Close delete account modal when clicking outside (safe drag-outside handling)
    setupModalClickOutside(deleteAccountModal, closeDeleteAccountModal);

    // Report Bug button
    const reportBugBtn = document.getElementById('reportBugBtn');
    if (reportBugBtn) {
        reportBugBtn.addEventListener('click', () => {
            openBugReportPage();
        });
    }

    // Initialize Security Features
    initializePasswordPrompt();
    const lockPageBtn = document.getElementById('lockPageBtn');
    if (lockPageBtn) {
        lockPageBtn.addEventListener('click', async () => {
            const pageId = document.getElementById('lockPageSelect').value;
            const password = document.getElementById('lockPagePasswordInput').value;
            
            if (!pageId) {
                showGlassToast('Please select a page to lock.', 'warning');
                return;
            }
            if (!password) {
                showGlassToast('Please enter a password.', 'warning');
                return;
            }
            
            await lockPage(pageId, password);
            document.getElementById('lockPagePasswordInput').value = '';
        });
    }

    // Initialize Privacy & Security Assistant UI listeners
    if (lumiListModules.privacyUI) {
        lumiListModules.privacyUI.attachAnalysisListeners('addBookmarkForm', 'addBookmarkPrivacyAnalysis');
        lumiListModules.privacyUI.attachAnalysisListeners('editBookmarkForm', 'editBookmarkPrivacyAnalysis');
    }

    // Startup auth UI is now handled in DOMContentLoaded so we do not
    // clobber the theme-bootstrap wallpaper before wallpaper preferences hydrate.
}

// Update the main auth UI (welcome screen visibility)
async function updateAuthUI(options = {}) {
    if (typeof SyncManager === 'undefined') {

        return;
    }

    const { skipOnboarding = false } = options;

    const isLoggedIn = await SyncManager.isLoggedIn();
    const welcomeScreen = document.getElementById('welcomeScreen');

    // Show/hide welcome screen and update body class for UI visibility
    if (isLoggedIn) {
        writeThemeBootstrapAuthHint(true);
        document.body.classList.remove('not-authenticated');
        if (welcomeScreen) welcomeScreen.classList.add('hidden');
        applyActiveThemeWallpaper();

        // Ensure tab overflow arrows update after UI becomes visible
        requestAnimationFrame(() => {
            if (typeof updateTabNavigation === 'function') {
                updateTabNavigation();
            }
        });
    } else {
        writeThemeBootstrapAuthHint(false);
        document.body.classList.add('not-authenticated');
        resetSubscriptionUiForAccountBoundary();
        try {
            await loadWallpaperCatalog();
        } catch (error) {
            console.warn('Failed to preload wallpaper catalog for welcome screen:', error);
        }
        await resetThemeForLoggedOutState();
        if (welcomeScreen) welcomeScreen.classList.remove('hidden');
        resetAccountBoundaryTransientUi({ quickTourReason: 'signed_out' });

        // Reset welcome screen to default button state (fix for stale syncing state after logout)
        const syncingDiv = document.getElementById('welcomeSyncing');
        setWelcomeGoogleButtonState({ visible: true, disabled: false, loading: false });
        if (syncingDiv) syncingDiv.classList.add('hidden');
    }

    // Check if we should show onboarding for new users
    if (isLoggedIn) {
        if (!skipOnboarding) {
            checkShowOnboarding();
        }
        // Check subscription status after auth is confirmed
        checkSubscription();
    }
}

// ==================== SUBSCRIPTION FUNCTIONS ====================

/**
 * Check if warning was dismissed within 24 hours (synchronous helper)
 * @param {string|null} dismissedAt - ISO timestamp or null
 * @returns {boolean} - true if dismissed within 24 hours
 */
function isWarningDismissedRecently(dismissedAt) {
    if (!dismissedAt) return false;
    const dismissedDate = new Date(dismissedAt);
    const hoursSince = (Date.now() - dismissedDate.getTime()) / (1000 * 60 * 60);
    return hoursSince < 24;
}

/**
 * Show subscription banner from cached status (called early in init)
 * This prevents the 70px content shift flicker by showing the banner
 * BEFORE any async operations complete.
 *
 * Flow: Read cached status -> Show banner immediately -> Async sync later updates if changed
 */
function isPaymentFailureSubscriptionState(subscription) {
    const rawStatus = String(subscription?.status || '').toLowerCase();
    return rawStatus === 'pending' ||
        rawStatus === 'past_due' ||
        rawStatus === 'halted' ||
        rawStatus === 'grace';
}

function requiresPaymentRecovery(subscription) {
    if (!subscription || typeof subscription !== 'object') return false;
    if (subscription.payment_recovery_required === true) return true;

    const rawStatus = String(subscription.status || '').toLowerCase();
    if (rawStatus === 'past_due' || rawStatus === 'halted') {
        return true;
    }

    if (rawStatus === 'grace') {
        return Boolean(subscription.razorpay_subscription_id || subscription.subscription_ends_at || subscription.billing_cycle_ends_at);
    }

    if (rawStatus === 'pending') {
        return Boolean(subscription.billing_cycle_ends_at);
    }

    return false;
}

function requiresCheckoutResume(subscription) {
    if (!subscription || typeof subscription !== 'object') return false;
    if (subscription.checkout_resume_required !== true) return false;

    const checkoutResumeSubscriptionId = typeof subscription.checkout_resume_subscription_id === 'string'
        ? subscription.checkout_resume_subscription_id.trim()
        : '';

    return Boolean(checkoutResumeSubscriptionId);
}

function configureExpiredOverlay(subscription = null) {
    const labelEl = document.getElementById('expiredOverlayLabel');
    const titleEl = document.getElementById('expiredOverlayTitle');
    const subtitleEl = document.getElementById('expiredOverlaySubtitle');
    const pricingCardsEl = document.getElementById('expiredPricingCards');
    const recoveryPanelEl = document.getElementById('expiredRecoveryPanel');
    const recoveryCopyEl = document.getElementById('expiredRecoveryCopy');
    const recoveryBtnEl = document.getElementById('expiredRecoveryBtn');
    const checkoutResumeMode = requiresCheckoutResume(subscription);
    const recoveryMode = requiresPaymentRecovery(subscription);

    if (checkoutResumeMode) {
        if (labelEl) labelEl.textContent = 'Checkout';
        if (titleEl) titleEl.textContent = 'Continue LumiList Checkout';
        if (subtitleEl) subtitleEl.textContent = 'Finish the subscription checkout you already started.';
        if (recoveryCopyEl) {
            recoveryCopyEl.textContent = 'You already started a LumiList checkout for this account. Continue in Manage to finish it without starting a second subscription.';
        }
        if (recoveryBtnEl) recoveryBtnEl.textContent = 'Continue Checkout';
        if (pricingCardsEl) pricingCardsEl.classList.add('hidden');
        if (recoveryPanelEl) recoveryPanelEl.classList.remove('hidden');
        return;
    }

    if (recoveryMode) {
        if (labelEl) labelEl.textContent = 'Payment Recovery';
        if (titleEl) titleEl.textContent = 'Restore LumiList Premium';
        if (subtitleEl) subtitleEl.textContent = 'Update the payment method for your existing subscription to continue.';
        if (recoveryCopyEl) {
            recoveryCopyEl.textContent = 'Your existing LumiList subscription still needs payment recovery. Continue in Manage to update the payment method on Razorpay and restore access without creating a second subscription.';
        }
        if (recoveryBtnEl) recoveryBtnEl.textContent = 'Fix Payment Method';
        if (pricingCardsEl) pricingCardsEl.classList.add('hidden');
        if (recoveryPanelEl) recoveryPanelEl.classList.remove('hidden');
        return;
    }

    if (labelEl) labelEl.textContent = 'Pricing';
    if (titleEl) titleEl.textContent = 'Unlock LumiList Premium';
    if (subtitleEl) subtitleEl.textContent = 'Organize your bookmarks beautifully';
    if (pricingCardsEl) pricingCardsEl.classList.remove('hidden');
    if (recoveryPanelEl) recoveryPanelEl.classList.add('hidden');
}

function updateGraceBannerCopy(subscription, daysLeft) {
    const graceBanner = document.getElementById('graceBanner');
    const graceDaysEl = document.getElementById('graceDays');
    const graceTextEl = graceBanner?.querySelector('.grace-text');
    const graceCountdownEl = graceBanner?.querySelector('.grace-countdown');
    const graceActionBtn = document.getElementById('graceSubscribeBtn');

    if (graceDaysEl) graceDaysEl.textContent = daysLeft;

    if (isPaymentFailureSubscriptionState(subscription)) {
        if (graceTextEl) graceTextEl.textContent = 'Payment failed. LumiList is currently read-only.';
        if (graceCountdownEl) {
            graceCountdownEl.innerHTML = 'Read-only access ends in <strong id="graceDays">' + daysLeft + '</strong> days';
        }
        if (graceActionBtn) graceActionBtn.textContent = requiresPaymentRecovery(subscription) ? 'Fix Payment Method' : 'Subscribe';
        return;
    }

    if (graceTextEl) graceTextEl.textContent = 'Your trial has ended. Subscribe to keep access.';
    if (graceCountdownEl) {
        graceCountdownEl.innerHTML = 'You will lose access in <strong id="graceDays">' + daysLeft + '</strong> days';
    }
    if (graceActionBtn) graceActionBtn.textContent = 'Subscribe Now';
}

function getExpiredSubscriptionMessage(subscription) {
    if (requiresCheckoutResume(subscription)) {
        return 'Finish the checkout you already started to continue using LumiList.';
    }

    return requiresPaymentRecovery(subscription)
        ? 'Your premium access has ended. Update your payment method to continue.'
        : isPaymentFailureSubscriptionState(subscription)
            ? 'Your premium access has ended. Subscribe to continue.'
            : 'Your trial has expired. Subscribe to continue.';
}

function logSubscriptionDebugEvent(event, details = {}) {
    try {
        if (typeof window !== 'undefined' && typeof window.recordSubscriptionDebug === 'function') {
            window.recordSubscriptionDebug(event, details);
        }
    } catch (_error) {
    }
}

if (typeof globalThis !== 'undefined') {
    globalThis.logSubscriptionDebugEvent = logSubscriptionDebugEvent;
}

function hasAuthenticatedRuntimeSubscriptionContext() {
    if (typeof getActiveStoredUserId === 'function' && getActiveStoredUserId()) {
        return true;
    }
    return Boolean(
        initialAuthCompleted &&
        typeof document !== 'undefined' &&
        !document.body?.classList?.contains('not-authenticated')
    );
}

function reconcileSignedInExpiredSnapshot(status, daysLeft, subscription) {
    globalThis.logSubscriptionDebugEvent?.('newtab.subscription.reconcile.start', {
        status,
        daysLeft,
        subscription,
        hasAuthenticatedRuntimeContext: hasAuthenticatedRuntimeSubscriptionContext()
    });
    if (status !== 'expired' || !hasAuthenticatedRuntimeSubscriptionContext()) {
        return {
            status,
            daysLeft,
            subscription,
            needsFreshFetch: false
        };
    }

    if (!subscription) {
        globalThis.logSubscriptionDebugEvent?.('newtab.subscription.reconcile.needs_fresh_fetch', {
            reason: 'expired-without-subscription',
            status,
            daysLeft
        });
        return {
            status: null,
            daysLeft: 0,
            subscription: null,
            needsFreshFetch: true
        };
    }

    if (
        typeof SyncManager !== 'undefined' &&
        typeof SyncManager.getEffectiveStatus === 'function' &&
        typeof SyncManager.getDaysRemaining === 'function'
    ) {
        const derivedStatus = SyncManager.getEffectiveStatus(subscription);
        const derivedDaysLeft = SyncManager.getDaysRemaining(subscription, derivedStatus);
        if (derivedStatus !== 'expired') {
            globalThis.logSubscriptionDebugEvent?.('newtab.subscription.reconcile.corrected', {
                originalStatus: status,
                originalDaysLeft: daysLeft,
                correctedStatus: derivedStatus,
                correctedDaysLeft: derivedDaysLeft,
                subscription
            });
            return {
                status: derivedStatus,
                daysLeft: derivedDaysLeft,
                subscription,
                needsFreshFetch: false
            };
        }
    }

    globalThis.logSubscriptionDebugEvent?.('newtab.subscription.reconcile.kept_expired', {
        status,
        daysLeft,
        subscription
    });
    return {
        status,
        daysLeft,
        subscription,
        needsFreshFetch: false
    };
}

async function showBannerFromCachedStatus() {
    try {
        const [result, storedSubscriptionState] = await Promise.all([
            chrome.storage.local.get([
                'trialBannerDismissed',
                'trialWarningDismissedAt',
                'cancelledWarningDismissedAt'
            ]),
            (typeof SyncManager !== 'undefined' && typeof SyncManager.getStoredSubscriptionStatus === 'function')
                ? SyncManager.getStoredSubscriptionStatus()
                : Promise.resolve(null)
        ]);

        const status = storedSubscriptionState?.status ?? null;
        const daysLeft = Number.isFinite(storedSubscriptionState?.daysLeft) ? storedSubscriptionState.daysLeft : 0;
        const subscription = storedSubscriptionState?.subscription || null;
        const hasRuntimeUserContext = typeof getActiveStoredUserId === 'function' && Boolean(getActiveStoredUserId());

        globalThis.logSubscriptionDebugEvent?.('newtab.subscription.banner_cache.read', {
            status,
            daysLeft,
            subscription,
            hasRuntimeUserContext
        });

        // Set window variables early for comparison in checkSubscription()
        window.cachedSubscriptionStatus = status;
        window.cachedSubscriptionDaysLeft = daysLeft;

        // Prime the runtime subscription state from cache so startup mutation guards
        // do not briefly treat a known-good account as "unknown" before the async
        // subscription refresh finishes.
        if (
            hasRuntimeUserContext &&
            window.subscriptionStatus === undefined &&
            (status === 'trial' || status === 'active' || status === 'grace' || status === 'expired')
        ) {
            window.subscriptionStatus = status;
            window.subscriptionDaysLeft = Number.isFinite(daysLeft) ? daysLeft : 0;
            window.subscriptionData = subscription || null;
        }

        // No cached data = first-time user, don't show anything yet
        // checkSubscription() will handle it after sync completes
        if (!status) {

            return;
        }



        // Mirror updateSubscriptionUI logic to show correct banner immediately
        switch (status) {
            case 'trial':
                globalThis.logSubscriptionDebugEvent?.('newtab.subscription.banner_cache.show_trial', {
                    daysLeft,
                    subscription
                });
                if (daysLeft <= 3) {
                    if (!isWarningDismissedRecently(result.trialWarningDismissedAt)) {
                        showTrialWarningBanner(daysLeft);
                    }
                } else {
                    if (result.trialBannerDismissed !== true) {
                        showTrialBanner(daysLeft);
                    }
                }
                break;

            case 'grace':
                globalThis.logSubscriptionDebugEvent?.('newtab.subscription.banner_cache.show_grace', {
                    daysLeft,
                    subscription
                });
                const graceBanner = document.getElementById('graceBanner');
                if (graceBanner) {
                    graceBanner.classList.remove('hidden');
                    updateGraceBannerCopy(subscription, daysLeft);
                }
                document.body.classList.add('has-grace-banner');
                break;

            case 'expired':
                globalThis.logSubscriptionDebugEvent?.('newtab.subscription.banner_cache.expired', {
                    hasRuntimeUserContext,
                    subscription
                });
                window.__deferredExpiredOverlayFromCache = false;
                showExpiredOverlay();
                break;

            case 'active':
                globalThis.logSubscriptionDebugEvent?.('newtab.subscription.banner_cache.active', {
                    daysLeft,
                    subscription
                });
                // Check if cancelled with <=3 days left
                if (subscription?.status === 'cancelled' && daysLeft <= 3) {
                    if (!isWarningDismissedRecently(result.cancelledWarningDismissedAt)) {
                        showCancelledWarningBanner(daysLeft);
                    }
                }
                // Otherwise no banner for active users
                break;
        }
    } catch (error) {
        console.error('[BannerCache] Error reading cached status:', error);
        globalThis.logSubscriptionDebugEvent?.('newtab.subscription.banner_cache.error', {
            error
        });
        // On error, don't show any banner - let checkSubscription handle it
    }
}

/**
 * Check subscription status and update UI accordingly
 * Uses stored data from autoSyncOnLoad() to avoid extra database calls
 *
 * FLICKER FIX: Only updates UI if status actually changed from cached value.
 * The cached value is set early by showBannerFromCachedStatus() to prevent
 * the 70px content shift flicker.
 */
async function checkSubscription() {
    if (typeof SyncManager === 'undefined' || !SyncManager.getStoredSubscriptionStatus) {

        return;
    }

    try {
        // Use stored subscription data (populated by autoSyncOnLoad)
        const storedState = await SyncManager.getStoredSubscriptionStatus();
        let status = storedState?.status ?? null;
        let daysLeft = Number.isFinite(storedState?.daysLeft) ? storedState.daysLeft : 0;
        let subscription = storedState?.subscription || null;
        globalThis.logSubscriptionDebugEvent?.('newtab.subscription.check.start', {
            storedStatus: status,
            storedDaysLeft: daysLeft,
            storedSubscription: subscription,
            storedSource: storedState?.source || null,
            storedIsStale: storedState?.isStale ?? null
        });
        let reconciledState = reconcileSignedInExpiredSnapshot(status, daysLeft, subscription);

        if (
            reconciledState.needsFreshFetch &&
            typeof SyncManager.fetchSubscriptionFromServer === 'function'
        ) {
            globalThis.logSubscriptionDebugEvent?.('newtab.subscription.check.fetch_server.start', {
                reason: 'reconciled-state-needs-fresh-fetch'
            });
            const freshState = await SyncManager.fetchSubscriptionFromServer();
            if (freshState) {
                status = freshState.status ?? null;
                daysLeft = Number.isFinite(freshState.daysLeft) ? freshState.daysLeft : 0;
                subscription = freshState.subscription || null;
                globalThis.logSubscriptionDebugEvent?.('newtab.subscription.check.fetch_server.success', {
                    status,
                    daysLeft,
                    subscription
                });
                reconciledState = reconcileSignedInExpiredSnapshot(status, daysLeft, subscription);

                if (
                    typeof SyncManager.storeSubscriptionStatus === 'function' &&
                    (
                        status !== storedState?.status ||
                        daysLeft !== storedState?.daysLeft ||
                        subscription !== (storedState?.subscription || null)
                    )
                ) {
                    await SyncManager.storeSubscriptionStatus(status, daysLeft, subscription);
                }
            }
        }

        status = reconciledState.status ?? null;
        daysLeft = Number.isFinite(reconciledState.daysLeft) ? reconciledState.daysLeft : 0;
        subscription = reconciledState.subscription || null;
        globalThis.logSubscriptionDebugEvent?.('newtab.subscription.check.final', {
            status,
            daysLeft,
            subscription,
            cachedStatus: window.cachedSubscriptionStatus,
            cachedDaysLeft: window.cachedSubscriptionDaysLeft
        });



        // Check if status changed from cached value (set by showBannerFromCachedStatus)
        const statusChanged = window.cachedSubscriptionStatus !== status ||
            window.cachedSubscriptionDaysLeft !== daysLeft;
        const shouldReplayDeferredExpiredOverlay =
            status === 'expired' &&
            window.__deferredExpiredOverlayFromCache === true;

        // Store for quick access throughout app
        window.subscriptionStatus = status;
        window.subscriptionDaysLeft = daysLeft;
        window.subscriptionData = subscription;  // Raw subscription for checking cancelled status

        // Only update UI if status actually changed (prevents redundant flicker)
        // First-time users (no cached status) will always get UI update
        if (statusChanged || window.cachedSubscriptionStatus === undefined || shouldReplayDeferredExpiredOverlay) {
            globalThis.logSubscriptionDebugEvent?.('newtab.subscription.check.update_ui', {
                statusChanged,
                replayingDeferredExpiredOverlay: shouldReplayDeferredExpiredOverlay,
                status,
                daysLeft,
                subscription
            });
            updateSubscriptionUI(status, daysLeft, subscription);
        } else {
            globalThis.logSubscriptionDebugEvent?.('newtab.subscription.check.noop', {
                status,
                daysLeft,
                subscription
            });
        }

    } catch (error) {
        console.error('Error checking subscription:', error);
        globalThis.logSubscriptionDebugEvent?.('newtab.subscription.check.error', {
            error,
            currentStatus: window.subscriptionStatus,
            cachedStatus: window.cachedSubscriptionStatus,
            currentSubscription: window.subscriptionData || null
        });
        const fallbackStatus = window.subscriptionStatus ?? window.cachedSubscriptionStatus;
        const fallbackDaysLeft = Number.isFinite(window.subscriptionDaysLeft)
            ? window.subscriptionDaysLeft
            : (Number.isFinite(window.cachedSubscriptionDaysLeft) ? window.cachedSubscriptionDaysLeft : 0);
        const hasKnownFallbackStatus =
            fallbackStatus === 'trial' ||
            fallbackStatus === 'active' ||
            fallbackStatus === 'grace' ||
            fallbackStatus === 'expired';

        // During transient outages, preserve last known subscription state so existing
        // signed-in users can continue local edits and queue sync safely.
        if (isTransientSyncDegraded() && hasKnownFallbackStatus) {
            window.subscriptionStatus = fallbackStatus;
            window.subscriptionDaysLeft = fallbackDaysLeft;
            return;
        }

        // Fail closed on subscription-check errors to avoid local writes that server RLS denies.
        // Keep existing status if present; otherwise move to unknown (blocked by canModify()).
        if (window.subscriptionStatus === undefined) {
            window.subscriptionStatus = null;
            window.subscriptionDaysLeft = 0;
        }
    }

}

// Cooldown tracking for visibility change subscription checks
let lastVisibilityCheck = 0;
const VISIBILITY_CHECK_COOLDOWN = 5000; // 5 seconds

/**
 * Check subscription status when user returns to tab
 * Fetches fresh data from server to detect subscription changes
 * (e.g., user subscribes on website and returns to extension)
 */
async function checkSubscriptionOnReturn() {
    // Skip during initialization - main flow handles subscription check
    if (!initialAuthCompleted) return;

    // Only check if user is logged in
    if (!await SyncManager.isLoggedIn()) return;

    // Throttle to prevent excessive API calls on rapid tab switching
    const now = Date.now();
    if (now - lastVisibilityCheck < VISIBILITY_CHECK_COOLDOWN) return;
    lastVisibilityCheck = now;

    try {
        // Fetch fresh subscription data from server (bypasses cache)
        const result = await SyncManager.fetchSubscriptionFromServer();
        if (!result) return;

        const { status: newStatus, daysLeft: newDaysLeft, subscription: newSubscription } = result;

        // Compare with current cached status
        const currentStatus = window.subscriptionStatus;
        const currentDaysLeft = window.subscriptionDaysLeft;

        // Check if status actually changed
        const statusChanged = newStatus !== currentStatus || newDaysLeft !== currentDaysLeft;

        if (statusChanged) {


            // Update window variables
            window.subscriptionStatus = newStatus;
            window.subscriptionDaysLeft = newDaysLeft;
            window.subscriptionData = newSubscription;

            // Update storage for persistence
            await SyncManager.storeSubscriptionStatus(newStatus, newDaysLeft, newSubscription);

            // Update cached values to match (prevents double update)
            window.cachedSubscriptionStatus = newStatus;
            window.cachedSubscriptionDaysLeft = newDaysLeft;

            // Update UI to reflect new status
            await updateSubscriptionUI(newStatus, newDaysLeft, newSubscription);
        }
    } catch (error) {
        console.error('[Subscription] Error checking on tab return:', error);
    }
}

// ==================== TRIAL BANNER FUNCTIONS ====================

const TRIAL_BANNER_AUTO_HIDE_MS = 30 * 1000;
let trialBannerTimeoutId = null;

/**
 * Check if trial banner was dismissed by user
 */
async function isTrialBannerDismissed() {
    const result = await chrome.storage.local.get('trialBannerDismissed');
    return result.trialBannerDismissed === true;
}

/**
 * Dismiss trial banner permanently (persists across sessions)
 */
async function dismissTrialBanner(options = {}) {
    const suppressGuardToast = options?.suppressGuardToast === true;
    const blockedReason = getWorkspaceMutationBlockedReason();
    if (blockedReason) {
        if (!suppressGuardToast) {
            showWorkspaceMutationBlockedToast(blockedReason);
        }
        hideTrialBanner();
        return false;
    }
    await chrome.storage.local.set({ trialBannerDismissed: true });
    hideTrialBanner();
    return true;
}

/**
 * Show trial banner with days remaining
 */
function showTrialBanner(daysLeft) {
    const banner = document.getElementById('trialBanner');
    const daysSpan = document.getElementById('trialBannerDays');
    if (banner && daysSpan) {
        daysSpan.textContent = daysLeft;
        banner.classList.remove('hidden');
        document.body.classList.add('has-trial-banner');
        if (trialBannerTimeoutId) {
            clearTimeout(trialBannerTimeoutId);
        }
        trialBannerTimeoutId = setTimeout(() => {
            dismissTrialBanner({ suppressGuardToast: true });
        }, TRIAL_BANNER_AUTO_HIDE_MS);
    }
}

/**
 * Hide trial banner
 */
function hideTrialBanner() {
    const banner = document.getElementById('trialBanner');
    if (banner) {
        banner.classList.add('hidden');
    }
    // Always remove body class, even if element doesn't exist
    document.body.classList.remove('has-trial-banner');
    if (trialBannerTimeoutId) {
        clearTimeout(trialBannerTimeoutId);
        trialBannerTimeoutId = null;
    }
}

/**
 * Initialize trial banner dismiss button listener
 */
function initTrialBanner() {
    const dismissBtn = document.getElementById('trialBannerDismiss');
    if (dismissBtn) {
        dismissBtn.addEventListener('click', dismissTrialBanner);
    }
}

// ==================== END TRIAL BANNER FUNCTIONS ====================

// ==================== TRIAL WARNING BANNER FUNCTIONS ====================

/**
 * Check if trial warning banner was dismissed (with 24h expiry)
 * Unlike the regular trial banner which is permanently dismissible,
 * the warning banner only stays dismissed for 24 hours
 */
async function isTrialWarningDismissedToday() {
    const result = await chrome.storage.local.get('trialWarningDismissedAt');
    if (!result.trialWarningDismissedAt) return false;

    const dismissedAt = new Date(result.trialWarningDismissedAt);
    const now = new Date();
    const hoursSinceDismissed = (now - dismissedAt) / (1000 * 60 * 60);

    // If more than 24 hours have passed, it's no longer dismissed
    return hoursSinceDismissed < 24;
}

/**
 * Dismiss warning banner for 24 hours
 */
async function dismissTrialWarningForToday() {
    if (!canMutateAccountScopedPreferences()) {
        hideTrialWarningBanner();
        return false;
    }
    await chrome.storage.local.set({ trialWarningDismissedAt: new Date().toISOString() });
    hideTrialWarningBanner();
    return true;
}

/**
 * Show trial warning banner (for trial ending soon - 3 days or less)
 */
function showTrialWarningBanner(daysLeft) {
    const banner = document.getElementById('trialWarningBanner');
    const daysSpan = document.getElementById('trialWarningDays');
    if (banner && daysSpan) {
        daysSpan.textContent = daysLeft;
        banner.classList.remove('hidden');
        document.body.classList.add('has-trial-warning-banner');
        // Hide regular trial banner if showing warning
        hideTrialBanner();
    }
}

/**
 * Hide trial warning banner
 */
function hideTrialWarningBanner() {
    const banner = document.getElementById('trialWarningBanner');
    if (banner) {
        banner.classList.add('hidden');
    }
    // Always remove body class, even if element doesn't exist
    document.body.classList.remove('has-trial-warning-banner');
}

/**
 * Initialize trial warning banner listeners
 */
function initTrialWarningBanner() {
    const dismissBtn = document.getElementById('trialWarningDismiss');
    const manageBtn = document.getElementById('trialWarningManageBtn');

    if (dismissBtn) {
        dismissBtn.addEventListener('click', dismissTrialWarningForToday);
    }

    if (manageBtn) {
        manageBtn.addEventListener('click', () => {
            openSubscribePage('yearly');
        });
    }
}

// ==================== CANCELLED WARNING BANNER FUNCTIONS ====================

/**
 * Check if cancelled warning banner was dismissed (with 24h expiry)
 * Similar to trial warning - returns daily to remind user to resubscribe
 */
async function isCancelledWarningDismissedToday() {
    const result = await chrome.storage.local.get('cancelledWarningDismissedAt');
    if (!result.cancelledWarningDismissedAt) return false;

    const dismissedAt = new Date(result.cancelledWarningDismissedAt);
    const now = new Date();
    const hoursSinceDismissed = (now - dismissedAt) / (1000 * 60 * 60);

    // If more than 24 hours have passed, it's no longer dismissed
    return hoursSinceDismissed < 24;
}

/**
 * Dismiss cancelled warning banner for 24 hours
 */
async function dismissCancelledWarningForToday() {
    if (!canMutateAccountScopedPreferences()) {
        hideTrialWarningBanner();
        return false;
    }
    await chrome.storage.local.set({ cancelledWarningDismissedAt: new Date().toISOString() });
    hideTrialWarningBanner();
    return true;
}

/**
 * Show cancelled warning banner (for cancelled subscription ending soon - 3 days or less)
 * Reuses the trial warning banner HTML with different text
 */
function showCancelledWarningBanner(daysLeft) {
    const banner = document.getElementById('trialWarningBanner');
    if (!banner) return;

    // Update text for cancelled context
    const textEl = banner.querySelector('.trial-warning-text');
    if (textEl) {
        textEl.textContent = `Your subscription ends in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}! Resubscribe to keep editing.`;
    }

    // Update button text (uses .trial-warning-btn class from HTML)
    const subscribeBtn = banner.querySelector('.trial-warning-btn');
    if (subscribeBtn) subscribeBtn.textContent = 'Resubscribe Now';

    // Update dismiss handler to use cancelled-specific function
    const dismissBtn = document.getElementById('trialWarningDismiss');
    if (dismissBtn) {
        // Remove old listener and add new one
        const newDismissBtn = dismissBtn.cloneNode(true);
        dismissBtn.parentNode.replaceChild(newDismissBtn, dismissBtn);
        newDismissBtn.addEventListener('click', dismissCancelledWarningForToday);
    }

    banner.classList.remove('hidden');
    document.body.classList.add('has-trial-warning-banner');
}

// ==================== END TRIAL WARNING BANNER FUNCTIONS ====================

function resetSubscriptionUiForAccountBoundary() {
    const graceBanner = document.getElementById('graceBanner');
    const expiredOverlay = document.getElementById('expiredOverlay');

    hideTrialBanner();
    hideTrialWarningBanner();
    if (graceBanner) graceBanner.classList.add('hidden');
    if (expiredOverlay) expiredOverlay.classList.add('hidden');
    clearExpiredOverlayTheme();
    document.body.classList.remove('has-grace-banner');
    document.body.classList.remove('subscription-expired');
    window.__deferredExpiredOverlayFromCache = false;

    window.subscriptionStatus = null;
    window.subscriptionDaysLeft = null;
    window.subscriptionData = null;
    window.cachedSubscriptionStatus = null;
    window.cachedSubscriptionDaysLeft = null;
}

/**
 * Update UI elements based on subscription status
 * @param {string} status - Effective status (trial, grace, active, expired)
 * @param {number} daysLeft - Days remaining
 * @param {object|null} subscription - Raw subscription object (to check if cancelled)
 */
async function updateSubscriptionUI(status, daysLeft, subscription = null) {
    const reconciledState = reconcileSignedInExpiredSnapshot(status, daysLeft, subscription);
    status = reconciledState.status ?? null;
    daysLeft = Number.isFinite(reconciledState.daysLeft) ? reconciledState.daysLeft : 0;
    subscription = reconciledState.subscription || null;

    globalThis.logSubscriptionDebugEvent?.('newtab.subscription.ui.update', {
        status,
        daysLeft,
        subscription,
        needsFreshFetch: reconciledState.needsFreshFetch ?? false,
        stack: new Error('subscription-ui-update').stack
    });

    const trialBadge = document.getElementById('trialBadge');
    const graceBanner = document.getElementById('graceBanner');
    const expiredOverlay = document.getElementById('expiredOverlay');

    // Hide all subscription UI first
    if (trialBadge) trialBadge.classList.add('hidden');
    if (graceBanner) graceBanner.classList.add('hidden');
    if (expiredOverlay) expiredOverlay.classList.add('hidden');
    clearExpiredOverlayTheme();
    hideTrialBanner();
    hideTrialWarningBanner();
    document.body.classList.remove('has-grace-banner');
    document.body.classList.remove('subscription-expired');
    if (status !== 'expired') {
        window.__deferredExpiredOverlayFromCache = false;
    }

    switch (status) {
        case 'trial':
            // Check if trial is ending soon (3 days or less)
            if (daysLeft <= 3) {
                // Show warning banner if not dismissed today
                const warningDismissed = await isTrialWarningDismissedToday();
                if (!warningDismissed) {
                    showTrialWarningBanner(daysLeft);
                }
            } else {
                // Regular trial - show normal banner if not dismissed
                const bannerDismissed = await isTrialBannerDismissed();
                if (!bannerDismissed) {
                    showTrialBanner(daysLeft);
                }
            }
            break;

        case 'grace':
            // Show grace banner
            if (graceBanner) {
                graceBanner.classList.remove('hidden');
                updateGraceBannerCopy(subscription, daysLeft);
            }
            document.body.classList.add('has-grace-banner');
            break;

        case 'expired':
            // Show expired overlay
            showExpiredOverlay();
            break;

        case 'active':
            // Check if this is a cancelled subscriber with ≤3 days left
            // getEffectiveStatus returns 'active' for cancelled users while subscription_ends_at > now
            if (subscription?.status === 'cancelled' && daysLeft <= 3) {
                const warningDismissed = await isCancelledWarningDismissedToday();
                if (!warningDismissed) {
                    showCancelledWarningBanner(daysLeft);
                }
            }
            // Otherwise hide all (normal active user)
            break;

        case 'cancelled':
            // Cancelled but still has access - show nothing or a subtle indicator
            break;
    }

    if (typeof updateSettingsSubscriptionDisplay === 'function') {
        updateSettingsSubscriptionDisplay().catch((error) => {
            console.error('Failed to sync settings subscription display:', error);
        });
    }
}

/**
 * Show the expired overlay with pricing options
 * IMPORTANT: This also hides all content to prevent DevTools bypass
 */
function showExpiredOverlay() {
    globalThis.logSubscriptionDebugEvent?.('newtab.subscription.overlay.show', {
        status: window.subscriptionStatus,
        daysLeft: window.subscriptionDaysLeft,
        cachedStatus: window.cachedSubscriptionStatus,
        cachedDaysLeft: window.cachedSubscriptionDaysLeft,
        subscription: window.subscriptionData || null,
        stack: new Error('showExpiredOverlay').stack
    });
    const overlay = document.getElementById('expiredOverlay');
    applyExpiredOverlayTheme();
    configureExpiredOverlay(window.subscriptionData || null);
    if (overlay) {
        overlay.classList.remove('hidden');
    }
    window.__deferredExpiredOverlayFromCache = false;

    // Add class that hides all content via CSS blur
    // This prevents bypass by deleting overlay in DevTools
    document.body.classList.add('subscription-expired');

    // NOTE: We do NOT clear the board content anymore
    // This allows recovery if subscription renews (webhook arrives late)
    // The CSS blur makes content unreadable and pointer-events: none blocks interaction


}

function captureDevSubscriptionPreviewState() {
    if (window.__devSubscriptionPreviewState?.snapshot) {
        return window.__devSubscriptionPreviewState.snapshot;
    }

    const snapshot = {
        status: window.subscriptionStatus,
        daysLeft: window.subscriptionDaysLeft,
        subscription: window.subscriptionData,
        cachedStatus: window.cachedSubscriptionStatus,
        cachedDaysLeft: window.cachedSubscriptionDaysLeft
    };
    window.__devSubscriptionPreviewState = {
        mode: null,
        snapshot
    };
    return snapshot;
}

function buildDevPaymentRecoveryPreviewSubscription({ expired = false } = {}) {
    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;
    const accessEnd = expired ? new Date(now - (8 * oneDayMs)) : new Date(now);
    const billingCycleEnd = new Date(accessEnd.getTime() - (7 * oneDayMs));
    const subscriptionStart = new Date(billingCycleEnd.getTime() - (30 * oneDayMs));

    return {
        status: 'halted',
        plan: 'monthly',
        payment_recovery_required: true,
        razorpay_subscription_id: 'sub_DEV_PAYMENT_RECOVERY',
        subscription_started_at: subscriptionStart.toISOString(),
        billing_cycle_ends_at: billingCycleEnd.toISOString(),
        subscription_ends_at: accessEnd.toISOString(),
        paid_count: 1
    };
}

async function restoreDevSubscriptionPreviewState() {
    const previewState = window.__devSubscriptionPreviewState;
    const snapshot = previewState?.snapshot;
    if (!snapshot) return;

    window.subscriptionStatus = snapshot.status;
    window.subscriptionDaysLeft = snapshot.daysLeft;
    window.subscriptionData = snapshot.subscription;
    window.cachedSubscriptionStatus = snapshot.cachedStatus;
    window.cachedSubscriptionDaysLeft = snapshot.cachedDaysLeft;
    window.__devSubscriptionPreviewState = null;

    const restoreStatus = snapshot.status;
    const restoreDaysLeft = Number.isFinite(snapshot.daysLeft) ? snapshot.daysLeft : 0;
    await updateSubscriptionUI(restoreStatus, restoreDaysLeft, snapshot.subscription || null);
    showGlassToast('Restored live subscription UI.', 'success');
}

async function showDevSubscriptionPreview(mode = 'payment_grace') {
    const currentMode = window.__devSubscriptionPreviewState?.mode || null;
    if (currentMode === mode) {
        await restoreDevSubscriptionPreviewState();
        return;
    }

    captureDevSubscriptionPreviewState();

    let previewSubscription;
    let previewStatus;
    let previewDaysLeft;

    if (mode === 'payment_expired') {
        previewSubscription = buildDevPaymentRecoveryPreviewSubscription({ expired: true });
        previewStatus = 'expired';
        previewDaysLeft = 0;
    } else {
        previewSubscription = buildDevPaymentRecoveryPreviewSubscription({ expired: false });
        previewStatus = typeof SyncManager?.getEffectiveStatus === 'function'
            ? SyncManager.getEffectiveStatus(previewSubscription)
            : 'grace';
        previewDaysLeft = typeof SyncManager?.getDaysRemaining === 'function'
            ? SyncManager.getDaysRemaining(previewSubscription, previewStatus)
            : 7;
    }

    window.subscriptionStatus = previewStatus;
    window.subscriptionDaysLeft = previewDaysLeft;
    window.subscriptionData = previewSubscription;
    window.cachedSubscriptionStatus = previewStatus;
    window.cachedSubscriptionDaysLeft = previewDaysLeft;
    window.__devSubscriptionPreviewState.mode = mode;

    await updateSubscriptionUI(previewStatus, previewDaysLeft, previewSubscription);

    if (mode === 'payment_expired') {
        showGlassToast('Dev preview: final failed-payment recovery overlay. Click the test button again to restore.', 'warning');
        return;
    }

    showGlassToast('Dev preview: post-retry failed-payment banner. Shift-click the test button to preview the final recovery overlay.', 'warning');
}

function isTransientSyncDegraded() {
    if (typeof SyncManager === 'undefined') return false;
    try {
        const isOfflineNow = (typeof navigator !== 'undefined' && navigator.onLine === false) || SyncManager._isOffline === true;
        const hasPullBackoff = typeof SyncManager._getTransientPullBackoffRemainingMs === 'function' &&
            SyncManager._getTransientPullBackoffRemainingMs() > 0;
        const hasRecentTransientFailure = typeof SyncManager._isRecentlyTransientNetworkDegraded === 'function' &&
            SyncManager._isRecentlyTransientNetworkDegraded();
        return isOfflineNow || hasPullBackoff || hasRecentTransientFailure;
    } catch (e) {
        return false;
    }
}

/**
 * Check if user can modify data (called before any add/edit/delete operation)
 */
function canModify() {
    return true;
}

/**
 * Prepare a secure auth handoff for website pages without putting the token in URL params.
 * Uses window.name + one-time nonce in query string.
 */
function createWebsiteAuthHandoff(targetUrl, token) {
    const handoffNonce = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const handoffPayload = JSON.stringify({
        llAuthToken: token,
        llAuthNonce: handoffNonce,
        llIssuedAt: Date.now()
    });

    const url = new URL(targetUrl);
    url.searchParams.set('handoff', handoffNonce);

    return { handoffPayload, handoffUrl: url.toString() };
}

/**
 * Open subscription page (called when user clicks subscribe button)
 * Uses secure signed token instead of plaintext user_id
 * Opens window SYNCHRONOUSLY to avoid browser popup blocker
 */
async function openSubscribePage(plan = null) {
    if (requiresPaymentRecovery(window.subscriptionData || null) || requiresCheckoutResume(window.subscriptionData || null)) {
        await openManageSubscriptionPage();
        return;
    }

    // Open window SYNCHRONOUSLY to avoid popup blocker
    // (browsers block window.open after async operations)
    const newWindow = window.open('about:blank', '_blank');

    try {

        const user = await SyncManager.getUser();


        if (!user || !user.id) {
            console.error('openSubscribePage: No user or user.id', { user });
            if (newWindow) newWindow.close();
            showGlassToast('Please sign in first', 'error');
            return;
        }

        // Get Supabase access token for authentication

        const token = await getSupabaseAccessToken();
        if (!token) {
            if (newWindow) newWindow.close();
            showGlassToast('Authentication failed. Please try signing in again.', 'error');
            reportReviewPromptIssue('payment').catch((issueError) => {
                console.warn('[ReviewPrompt] Failed to track payment auth issue:', issueError);
            });
            return;
        }


        const subscribeBaseUrl = new URL('https://lumilist.in/subscribe');
        if (plan === 'monthly' || plan === 'yearly') {
            subscribeBaseUrl.searchParams.set('plan', plan);
        }
        const { handoffPayload, handoffUrl } = createWebsiteAuthHandoff(subscribeBaseUrl.toString(), token);


        // Redirect the already-open window
        if (newWindow) {
            newWindow.name = handoffPayload;
            newWindow.location.href = handoffUrl;
        } else {
            // Fallback if popup was blocked anyway
            showGlassToast('Please allow popups for this site', 'warning');
        }
    } catch (error) {
        console.error('openSubscribePage: Error:', error);
        if (newWindow) newWindow.close();
        showGlassToast('Could not open subscription page', 'error');
        reportReviewPromptIssue('payment').catch((issueError) => {
            console.warn('[ReviewPrompt] Failed to track payment open-subscribe issue:', issueError);
        });
    }
}

/**
 * Initialize subscription event listeners
 */
function initSubscriptionListeners() {
    // Grace banner subscribe button
    const graceSubscribeBtn = document.getElementById('graceSubscribeBtn');
    if (graceSubscribeBtn) {
        graceSubscribeBtn.addEventListener('click', () => openSubscribePage('yearly'));
    }

    // Expired overlay subscribe buttons (using event delegation)
    const expiredOverlay = document.getElementById('expiredOverlay');
    if (expiredOverlay) {
        expiredOverlay.addEventListener('click', (e) => {
            const btn = e.target.closest('.subscribe-btn');
            if (btn) {
                const plan = btn.dataset.plan || 'yearly';
                openSubscribePage(plan);
            }
        });
    }

    const expiredRecoveryBtn = document.getElementById('expiredRecoveryBtn');
    if (expiredRecoveryBtn) {
        expiredRecoveryBtn.addEventListener('click', () => openManageSubscriptionPage());
    }

    // Expired overlay delete account link
    const expiredDeleteAccountBtn = document.getElementById('expiredDeleteAccountBtn');
    if (expiredDeleteAccountBtn) {
        expiredDeleteAccountBtn.addEventListener('click', (e) => {
            e.preventDefault();
            handleDeleteAccount();
        });
    }

    // Expired overlay logout button
    const expiredLogoutBtn = document.getElementById('expiredLogoutBtn');
    if (expiredLogoutBtn) {
        expiredLogoutBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            await handleLogout();
        });
    }

    // Settings modal subscribe button
    // For cancelled users with access remaining, open manage page (can Resume for free)
    const settingsSubscribeBtn = document.getElementById('settingsSubscribeBtn');
    if (settingsSubscribeBtn) {
        settingsSubscribeBtn.addEventListener('click', () => {
            const isCancelled = window.subscriptionData?.status === 'cancelled';
            const hasAccess = window.subscriptionStatus === 'active';
            if (requiresPaymentRecovery(window.subscriptionData)) {
                openManageSubscriptionPage();
            } else if (isCancelled && hasAccess) {
                openManageSubscriptionPage();
            } else {
                // Settings CTA should preselect yearly when opening subscribe from extension.
                openSubscribePage('yearly');
            }
        });
    }

    // Settings modal manage subscription button
    const settingsManageSubBtn = document.getElementById('settingsManageSubBtn');
    if (settingsManageSubBtn) {
        settingsManageSubBtn.addEventListener('click', openManageSubscriptionPage);
    }

    // Initialize trial banner dismiss button
    initTrialBanner();

    // Initialize trial warning banner (for trial ending soon)
    initTrialWarningBanner();
}

/**
 * Update subscription display in settings modal
 */
async function resolveSettingsSubscriptionSnapshot() {
    let status = isKnownSettingsSubscriptionStatus(window.subscriptionStatus)
        ? window.subscriptionStatus
        : null;
    let daysLeft = Number.isFinite(window.subscriptionDaysLeft)
        ? window.subscriptionDaysLeft
        : 0;
    let subscription = window.subscriptionData || null;

    if (typeof SyncManager !== 'undefined' && typeof SyncManager.getStoredSubscriptionStatus === 'function') {
        try {
            const storedState = await SyncManager.getStoredSubscriptionStatus();
            if (storedState) {
                if (isKnownSettingsSubscriptionStatus(storedState.status)) {
                    status = storedState.status;
                }
                if (Number.isFinite(storedState.daysLeft)) {
                    daysLeft = storedState.daysLeft;
                }
                if (storedState.subscription) {
                    subscription = storedState.subscription;
                }
            }
        } catch (error) {
            console.warn('Failed to read stored subscription state for settings:', error);
        }
    }

    if (
        (status === null || status === 'expired') &&
        typeof SyncManager !== 'undefined' &&
        typeof SyncManager.fetchSubscriptionFromServer === 'function'
    ) {
        try {
            const freshState = await SyncManager.fetchSubscriptionFromServer();
            if (freshState) {
                if (isKnownSettingsSubscriptionStatus(freshState.status)) {
                    status = freshState.status;
                }
                if (Number.isFinite(freshState.daysLeft)) {
                    daysLeft = freshState.daysLeft;
                }
                if (freshState.subscription) {
                    subscription = freshState.subscription;
                }
                if (
                    isKnownSettingsSubscriptionStatus(freshState.status) &&
                    typeof SyncManager.storeSubscriptionStatus === 'function'
                ) {
                    await SyncManager.storeSubscriptionStatus(
                        freshState.status,
                        Number.isFinite(freshState.daysLeft) ? freshState.daysLeft : 0,
                        freshState.subscription || null
                    );
                }
            }
        } catch (error) {
            console.warn('Failed to refresh subscription state for settings:', error);
        }
    }

    if (status !== null || subscription) {
        window.subscriptionStatus = status;
        window.subscriptionDaysLeft = Number.isFinite(daysLeft) ? daysLeft : 0;
        window.subscriptionData = subscription || null;
    }

    return {
        status,
        daysLeft: Number.isFinite(daysLeft) ? daysLeft : 0,
        subscription
    };
}

async function updateSettingsSubscriptionDisplay() {
    const statusEl = document.getElementById('settingsSubscriptionStatus');
    const infoEl = document.getElementById('settingsSubscriptionInfo');
    const subscribeBtn = document.getElementById('settingsSubscribeBtn');
    const manageBtn = document.getElementById('settingsManageSubBtn');

    if (!statusEl || !infoEl || !subscribeBtn || !manageBtn) return;

    const snapshot = await resolveSettingsSubscriptionSnapshot();
    const status = snapshot.status ?? null;
    const daysLeft = Number.isFinite(snapshot.daysLeft) ? snapshot.daysLeft : 0;
    const subscription = snapshot.subscription || null;

    statusEl.classList.remove('is-trial', 'is-active', 'is-cancelled', 'is-grace', 'is-expired');
    infoEl.classList.remove('is-warning', 'is-danger');
    manageBtn.style.display = 'none';

    // Update status badge
    if (status === 'trial') {
        statusEl.textContent = 'Trial';
        statusEl.classList.add('is-trial');
        infoEl.innerHTML = `<span class="days-count">${daysLeft}</span> days remaining`;
        infoEl.style.display = 'block';
        subscribeBtn.textContent = 'Upgrade to Premium';
        subscribeBtn.style.display = 'block';
    } else if (status === 'active') {
        // Check if this is a cancelled subscriber with remaining access
        const isCancelled = subscription?.status === 'cancelled';
        statusEl.textContent = isCancelled ? 'Cancelled' : 'Premium';
        statusEl.classList.add(isCancelled ? 'is-cancelled' : 'is-active');
        if (daysLeft > 0) {
            const verb = isCancelled ? 'Ends' : 'Renews';
            infoEl.innerHTML = `${verb} in <span class="days-count">${daysLeft}</span> days`;
            if (isCancelled) infoEl.classList.add('is-warning');
            infoEl.style.display = 'block';
        } else {
            infoEl.style.display = 'none';
        }
        // For cancelled users: show only Manage button (they can Resume for free there)
        // For active users: show only Manage button
        subscribeBtn.style.display = 'none';
        manageBtn.style.display = 'block';
    } else if (status === 'cancelled') {
        statusEl.textContent = 'Cancelled';
        statusEl.classList.add('is-cancelled');
        infoEl.classList.add('is-warning');
        infoEl.textContent = daysLeft > 0
            ? `Access until end of period (${daysLeft} days)`
            : 'Subscription cancelled';
        infoEl.style.display = 'block';
        subscribeBtn.textContent = 'Resubscribe';
        subscribeBtn.style.display = 'block';
    } else if (status === 'grace') {
        const paymentFailureGrace = isPaymentFailureSubscriptionState(subscription);
        statusEl.textContent = paymentFailureGrace ? 'Payment Failed' : 'Grace Period';
        statusEl.classList.add('is-grace');
        infoEl.classList.add('is-warning');
        infoEl.innerHTML = paymentFailureGrace
            ? `Read-only access ends in <span class="days-count">${daysLeft}</span> days`
            : `Subscribe within <span class="days-count">${daysLeft}</span> days`;
        infoEl.style.display = 'block';
        subscribeBtn.textContent = paymentFailureGrace ? 'Fix Payment Method' : 'Subscribe Now';
        subscribeBtn.style.display = 'block';
    } else if (status === 'expired') {
        const paymentRecoveryExpired = requiresPaymentRecovery(subscription);
        const checkoutResumeExpired = requiresCheckoutResume(subscription);
        statusEl.textContent = checkoutResumeExpired ? 'Checkout' : 'Expired';
        statusEl.classList.add(checkoutResumeExpired ? 'is-grace' : 'is-expired');
        infoEl.classList.add(checkoutResumeExpired ? 'is-warning' : 'is-danger');
        infoEl.textContent = checkoutResumeExpired
            ? 'Finish the checkout you already started to continue using LumiList'
            : paymentRecoveryExpired
                ? 'Update your payment method to continue using LumiList'
                : 'Subscribe to continue using LumiList';
        infoEl.style.display = 'block';
        subscribeBtn.textContent = checkoutResumeExpired
            ? 'Continue Checkout'
            : paymentRecoveryExpired
                ? 'Fix Payment Method'
                : 'Subscribe Now';
        subscribeBtn.style.display = 'block';
    } else {
        statusEl.textContent = 'Local';
        statusEl.classList.add('is-active');
        infoEl.textContent = 'No account connected. Using local storage.';
        infoEl.style.display = 'block';
        subscribeBtn.style.display = 'none';
        manageBtn.style.display = 'none';
    }
}

/**
 * Open manage subscription page on website
 * Uses secure signed token instead of plaintext user_id
 * Opens window SYNCHRONOUSLY to avoid browser popup blocker
 */
async function openManageSubscriptionPage() {
    // Open window SYNCHRONOUSLY to avoid popup blocker
    // (browsers block window.open after async operations)
    const newWindow = window.open('about:blank', '_blank');

    try {

        const user = await SyncManager.getUser();


        if (!user || !user.id) {
            console.error('openManageSubscriptionPage: No user or user.id', { user });
            if (newWindow) newWindow.close();
            showGlassToast('Please sign in to manage your subscription', 'error');
            return;
        }

        // Get Supabase access token for authentication
        // Supabase tokens are longer-lived (~1 hour) and auto-refresh

        const token = await getSupabaseAccessToken();
        if (!token) {
            if (newWindow) newWindow.close();
            showGlassToast('Authentication failed. Please try signing in again.', 'error');
            reportReviewPromptIssue('payment').catch((issueError) => {
                console.warn('[ReviewPrompt] Failed to track manage-subscription auth issue:', issueError);
            });
            return;
        }


        const { handoffPayload, handoffUrl } = createWebsiteAuthHandoff('https://lumilist.in/manage', token);


        // Redirect the already-open window
        if (newWindow) {
            newWindow.name = handoffPayload;
            newWindow.location.href = handoffUrl;
        } else {
            // Fallback if popup was blocked anyway
            showGlassToast('Please allow popups for this site', 'warning');
        }
    } catch (error) {
        if (newWindow) newWindow.close();
        console.error('Error opening manage subscription page:', error);
        showGlassToast('Could not open subscription page', 'error');
        reportReviewPromptIssue('payment').catch((issueError) => {
            console.warn('[ReviewPrompt] Failed to track manage-subscription issue:', issueError);
        });
    }
}

// Initialize subscription listeners when DOM is ready
document.addEventListener('DOMContentLoaded', initSubscriptionListeners);

// ==================== END SUBSCRIPTION FUNCTIONS ====================

// Show auth error message
function showAuthError(message) {
    const errorDiv = document.getElementById('authError');
    const successDiv = document.getElementById('authSuccess');
    if (errorDiv) {
        errorDiv.textContent = message;
        errorDiv.classList.add('visible');
    }
    if (successDiv) {
        successDiv.classList.remove('visible');
    }

    reportReviewPromptIssue('auth').catch((error) => {
        console.warn('[ReviewPrompt] Failed to track auth issue:', error);
    });
}

// Show auth success message
function showAuthSuccess(message) {
    const errorDiv = document.getElementById('authError');
    const successDiv = document.getElementById('authSuccess');
    if (successDiv) {
        successDiv.textContent = message;
        successDiv.classList.add('visible');
    }
    if (errorDiv) {
        errorDiv.classList.remove('visible');
    }
}

async function handleSessionInvalidation(reason = 'Session expired. Please login again.') {
    showAuthError(reason);

    if (_isHandlingSessionInvalidation) {
        return;
    }

    _isHandlingSessionInvalidation = true;

    try {
        isCurrentTabAuthenticating = false;
        window.isCurrentTabAuthenticating = false;
        clearLateAuthReconcileSuppression();
        resetCrossTabLoginWaitState({
            clearPendingAuthChange: true,
            clearPendingSignal: true
        });
        resetSubscriptionUiForAccountBoundary();

        window.subscriptionStatus = null;
        window.subscriptionDaysLeft = null;
        window.subscriptionData = null;
        setWorkspaceOwnerUserId(null);
        setActiveStoredUserId(null);

        showWelcomeScreen();
        resetAccountBoundaryTransientUi({ quickTourReason: 'session_expired' });

        // Remove stale OAuth params so reloads do not retry against the dead session.
        history.replaceState(null, '', window.location.pathname);
    } catch (error) {
        console.error('Error handling session invalidation:', error);
    } finally {
        _isHandlingSessionInvalidation = false;
    }
}

// Handle logout
async function handleLogout() {
    try {
        resetAccountBoundaryTransientUi({ quickTourReason: 'logout' });
        resetSubscriptionUiForAccountBoundary();
        writeThemeBootstrapAuthHint(false);

        // Show welcome screen IMMEDIATELY for instant visual feedback
        const welcomeScreen = document.getElementById('welcomeScreen');
        if (welcomeScreen) welcomeScreen.classList.remove('hidden');
        document.body.classList.add('not-authenticated');
        applyLoggedOutDefaultThemeUi();

        // Show "Signing out..." state
        const syncingDiv = document.getElementById('welcomeSyncing');
        setWelcomeGoogleButtonState({ visible: false, disabled: false, loading: false });
        if (syncingDiv) {
            syncingDiv.classList.remove('hidden');
            const syncingText = syncingDiv.querySelector('span');
            if (syncingText) syncingText.textContent = 'Signing out...';
        }

        // Set flag to prevent cross-tab handler from firing on our own logout
        isCurrentTabAuthenticating = true; window.isCurrentTabAuthenticating = true;

        // Capture user ID for onboarding ownership cleanup
        let logoutUserId = null;
        try {
            const storedUser = await SyncManager.getStoredUser();
            logoutUserId = storedUser?.id || null;
        } catch (e) {
            console.warn('Failed to read stored user during logout:', e);
        }

        await SyncManager.logout();
        setWorkspaceOwnerUserId(null);
        setActiveStoredUserId(null);

        // Clear local data (so next account doesn't see old data)
        await db.pages.clear();
        await db.boards.clear();
        await db.bookmarks.clear();
        await db.syncQueue.clear();  // H1: Clear pending sync operations
        await db.favicons.clear();   // H2: Clear favicon cache (privacy)
        await clearUndoRedoHistory();
        await clearPersistedThemeWallpaperState();

        // Clean up onboarding ownership key for this user
        if (logoutUserId && typeof chrome !== 'undefined' && chrome.storage?.local) {
            const ownerKey = `lumilist_onboarding_owner_${logoutUserId}`;
            await chrome.storage.local.remove(ownerKey);
        }

        // CRITICAL: Clear URL hash to prevent stale OAuth tokens from re-logging in on reload
        history.replaceState(null, '', window.location.pathname);

        showAuthSuccess('Signed out. Reloading...');

        // Reload page to show clean state with login overlay
        setTimeout(() => {
            window.location.reload();
        }, 1000);
    } catch (error) {
        console.error('Logout error:', error);
        showAuthError('Logout failed');
    } finally {
        // C3: Always reset flag, even on error, to prevent blocking cross-tab auth
        isCurrentTabAuthenticating = false;
        window.isCurrentTabAuthenticating = false;
    }
}

// Open GitHub issue page with pre-filled bug report template
function openBugReportPage() {
    const url = `https://github.com/pranto2050`;
    chrome.tabs.create({ url });
}

// Account deletion state flag (locks modal during deletion)
let isDeleteAccountInProgress = false;

// Close delete account modal (no-op if deletion is in progress)
function closeDeleteAccountModal() {
    const modal = document.getElementById('deleteAccountModal');
    if (!modal || isDeleteAccountInProgress) return;
    activeDeleteAccountModalUserId = null;
    modal.classList.remove('active');
}

// Handle account deletion - show modal
// NOTE: Event listeners for input/button are set up once in setupAuthEventListeners()
async function handleDeleteAccount() {
    const blockedReason = getWorkspaceMutationBlockedReason();
    if (blockedReason) {
        showWorkspaceMutationBlockedToast(blockedReason);
        return;
    }

    const modalUserId = await getCurrentStoredUserId();
    if (!modalUserId) {
        showGlassToast('Please sign in again before deleting your account.', 'warning');
        return;
    }

    const modal = document.getElementById('deleteAccountModal');
    const input = document.getElementById('deleteConfirmInput');
    const confirmBtn = document.getElementById('confirmDeleteAccountBtn');
    const errorEl = document.getElementById('deleteAccountError');

    if (!modal || !input || !confirmBtn) return;

    activeDeleteAccountModalUserId = modalUserId;

    // Reset modal state
    isDeleteAccountInProgress = false;
    input.value = '';
    confirmBtn.disabled = true;
    if (errorEl) {
        errorEl.style.display = 'none';
        errorEl.textContent = '';
    }
    const cancelBtn = document.getElementById('cancelDeleteAccountBtn');
    if (cancelBtn) {
        cancelBtn.disabled = false;
        cancelBtn.style.display = '';
    }
    input.disabled = false;

    // Show modal
    modal.classList.add('active');
    input.focus();
}

// Execute account deletion
async function executeDeleteAccount() {
    const modal = document.getElementById('deleteAccountModal');
    const confirmBtn = document.getElementById('confirmDeleteAccountBtn');
    const errorEl = document.getElementById('deleteAccountError');
    const input = document.getElementById('deleteConfirmInput');
    const cancelBtn = document.getElementById('cancelDeleteAccountBtn');

    // Double-click guard - check synchronously before async work
    if (confirmBtn.disabled) return;
    confirmBtn.disabled = true;

    // Validate input (trim whitespace for user convenience)
    const inputValue = input.value.trim();
    if (inputValue !== 'DELETE') {
        if (errorEl) {
            errorEl.textContent = 'Please type DELETE to confirm';
            errorEl.style.display = 'block';
        }
        confirmBtn.disabled = false;
        return;
    }

    const blockedReason = getWorkspaceMutationBlockedReason();
    if (blockedReason) {
        confirmBtn.disabled = false;
        closeDeleteAccountModal();
        showWorkspaceMutationBlockedToast(blockedReason);
        return;
    }

    const modalUserId = normalizeRuntimeUserId(activeDeleteAccountModalUserId);
    const currentUserId = await getCurrentStoredUserId();
    if (!modalUserId || !currentUserId || modalUserId !== currentUserId) {
        confirmBtn.disabled = false;
        closeDeleteAccountModal();
        showGlassToast('This delete request is out of date after an account change. Please reopen it.', 'warning');
        return;
    }

    // Lock modal during deletion
    isDeleteAccountInProgress = true;
    if (cancelBtn) {
        cancelBtn.disabled = true;
        cancelBtn.style.display = 'none'; // Hide cancel button during deletion
    }
    if (input) input.disabled = true;

    // Show loading state
    const originalText = confirmBtn.textContent;
    confirmBtn.textContent = 'Deleting...';

    try {
        // Get Supabase access token for authentication
        const token = await getSupabaseAccessToken();
        if (!token) {
            throw new Error('Authentication failed. Please try signing in again.');
        }

        // Call delete-account Edge Function with timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 second timeout

        const response = await fetch(`${SUPABASE_FUNCTIONS_URL}/delete-account`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({}),
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || 'Failed to delete account');
        }

        // Close modal immediately
        if (modal) modal.classList.remove('active');
        activeDeleteAccountModalUserId = null;

        // Set flag to prevent cross-tab handler from firing
        isCurrentTabAuthenticating = true; window.isCurrentTabAuthenticating = true;

        // Use SyncManager.logout() for thorough cleanup (cancels scheduled push, retries, etc.)
        await SyncManager.logout();
        setWorkspaceOwnerUserId(null);
        setActiveStoredUserId(null);

        // Clear all local IndexedDB data
        await db.pages.clear();
        await db.boards.clear();
        await db.bookmarks.clear();
        await db.syncQueue.clear();
        await db.favicons.clear();
        await clearUndoRedoHistory();

        // Clear ALL chrome.storage keys (complete cleanup for GDPR compliance)
        const storageSnapshot = await chrome.storage.local.get(null);
        const supabaseSessionKeys = Object.keys(storageSnapshot || {}).filter((key) =>
            key.startsWith('sb-') && key.endsWith('-auth-token')
        );

        await chrome.storage.local.remove([
            // Auth keys
            'lumilist_user',
            'lumilist_sync_version',
            'currentPageId',
            // User preferences (must not leak to next account)
            'privacyModeEnabled',
            'incognitoModeEnabled',
            'compactModeEnabled',
            'largeBoardCollapseEnabled',
            'largeBoardVisibleBookmarkLimit',
            'largeBoardExpandedBoardIds',
            'themeMode',
            WALLPAPER_STORAGE_KEY,
            WALLPAPER_CLOUD_SYNC_STATE_STORAGE_KEY,
            'truncateTitles',
            'openInNewTab',
            'showBookmarkNotes',
            CLOSE_TABS_AFTER_SAVE_ALL_STORAGE_KEY,
            'privateLinksIncognito',
            'quickSavePageId',
            FONT_COLOR_STORAGE_KEY,
            // Banner/warning dismissals
            'trialBannerDismissed',
            'trialWarningDismissedAt',
            'cancelledWarningDismissedAt',
            // Onboarding
            'onboardingCompleted'
        ].concat(supabaseSessionKeys));

        try {
            localStorage.removeItem('lumilist_theme_mode');
            localStorage.removeItem(WALLPAPER_LOCAL_CACHE_KEY);
            localStorage.removeItem(WALLPAPER_STYLE_LOCAL_CACHE_KEY);
            localStorage.removeItem(FONT_COLOR_LOCAL_CACHE_KEY);
            localStorage.removeItem(WALLPAPER_BINARY_CACHE_LOCAL_KEY);
        } catch (e) {
            // non-blocking
        }

        // Clear URL hash to prevent re-auth
        history.replaceState(null, '', window.location.pathname);

        // Keep the explanation visible on the logged-out screen so deletion
        // does not look like a plain sign-out.
        setPendingWelcomeNotice({
            message: 'Your LumiList account was deleted.',
            variant: 'error',
            durationMs: 60000
        });

        // Immediately show logged-out state
        clearAllColumns();
        document.querySelectorAll('.board-menu').forEach(menu => menu.remove());
        showWelcomeScreen();
        isDeleteAccountInProgress = false;

    } catch (error) {
        console.error('Delete account error:', error);
        confirmBtn.textContent = originalText;
        confirmBtn.disabled = false;
        if (cancelBtn) {
            cancelBtn.disabled = false;
            cancelBtn.style.display = '';
        }
        if (input) input.disabled = false;
        isDeleteAccountInProgress = false;

        // Handle timeout specifically
        const errorMessage = error.name === 'AbortError'
            ? 'Request timed out. Please try again.'
            : (error.message || 'Failed to delete account. Please try again.');

        if (errorEl) {
            errorEl.textContent = errorMessage;
            errorEl.style.display = 'block';
        }
    } finally {
        // Always reset flag to prevent blocking cross-tab auth
        isCurrentTabAuthenticating = false;
        window.isCurrentTabAuthenticating = false;
        if (!isDeleteAccountInProgress) {
            // Only reset if we haven't already logged out
            confirmBtn.textContent = confirmBtn.textContent === 'Deleting...' ? originalText : confirmBtn.textContent;
        }
    }
}

// Handle auth redirects (Google OAuth)
// earlyHash: Pass the hash captured before Supabase init, as Supabase clears it
async function handleAuthRedirect(earlyHash = null) {
    const hash = earlyHash || window.location.hash;
    const searchParams = new URLSearchParams(window.location.search);
    const authCode = searchParams.get('code');
    const hasOAuthCode = typeof authCode === 'string' && authCode.length > 0;

    const clearAuthParamsFromUrl = () => {
        try {
            const cleanUrl = new URL(window.location.href);
            ['code', 'state', 'error', 'error_code', 'error_description', 'type', 'lumilist_oauth'].forEach((key) => {
                cleanUrl.searchParams.delete(key);
            });
            cleanUrl.hash = '';
            history.replaceState(null, '', `${cleanUrl.pathname}${cleanUrl.search}`);
        } catch (e) {
            history.replaceState(null, '', window.location.pathname);
        }
    };

    const isLikelyTransientAuthNetworkError = (error) => {
        const message = String(error?.message || error || '').toLowerCase();
        return message.includes('timeout') ||
            message.includes('timed out') ||
            message.includes('failed to fetch') ||
            message.includes('network') ||
            message.includes('fetch failed');
    };

    // Check for OAuth success (token-in-hash or code-in-query callback flow)
    if (hash.includes('access_token') || hasOAuthCode) {


        // Set flag to prevent cross-tab handler from firing on our own storage changes
        isCurrentTabAuthenticating = true; window.isCurrentTabAuthenticating = true;

        // FIX: Wrap in try/finally to ensure flag is always reset even if exception occurs
        try {
            // Show welcome screen with syncing state (NOT loading overlay)
            const welcomeScreen = document.getElementById('welcomeScreen');
            const syncingDiv = document.getElementById('welcomeSyncing');

            if (welcomeScreen) welcomeScreen.classList.remove('hidden');
            setWelcomeGoogleButtonState({ visible: false, disabled: false, loading: false });
            if (syncingDiv) syncingDiv.classList.remove('hidden');

            const syncingText = syncingDiv ? syncingDiv.querySelector('span') : null;
            let user = null;
            let authFailureMessage = null;

            // DIRECT TOKEN EXTRACTION: Parse tokens from URL hash and set session directly
            // This is more reliable than waiting for Supabase's auto-detection
            const supabase = SyncManager.getSupabase();
            if (!supabase) {
                setWelcomeGoogleButtonState({ visible: true, disabled: false, loading: false });
                if (syncingDiv) syncingDiv.classList.add('hidden');
                if (syncingText) syncingText.textContent = 'Syncing please wait';
                showAuthError('Login failed. Auth client is not initialized. Please refresh and try again.');
                clearAuthParamsFromUrl();
                return true;
            }

            if (supabase && hash) {
                try {
                    // Parse hash parameters
                    const hashParams = new URLSearchParams(hash.substring(1));
                    const accessToken = hashParams.get('access_token');
                    const refreshToken = hashParams.get('refresh_token');

                    // NOTE: Hash clearing moved to AFTER successful setSession() to prevent data loss
                    // If setSession() fails, tokens stay in URL so user can retry on refresh

                    if (accessToken && refreshToken) {
                        // FIX: Token deduplication - prevent re-processing of same callback on rapid refreshes.
                        // Use both access + refresh token prefixes to reduce collisions across different login attempts.
                        const tokenFingerprint = `${accessToken.substring(0, 32)}.${refreshToken.substring(0, 32)}`;
                        const processed = await chrome.storage.local.get('_lastProcessedToken');
                        let shouldSetSessionFromHash = true;
                        if (processed._lastProcessedToken === tokenFingerprint) {
                            clearAuthParamsFromUrl();

                            // Check if we already have a valid session from previous processing.
                            // If not, we must retry setSession() (previous attempt may have failed or session was cleared).
                            const { data: existingSession } = await supabase.auth.getSession();
                            if (existingSession?.session?.user) {
                                user = existingSession.session.user;
                                shouldSetSessionFromHash = false;
                            } else {
                                await chrome.storage.local.remove('_lastProcessedToken');
                            }
                        }

                        if (shouldSetSessionFromHash) {

                            if (syncingText) syncingText.textContent = 'Authenticating...';

                            // Mark token as being processed (before setSession to handle crashes)
                            await chrome.storage.local.set({ '_lastProcessedToken': tokenFingerprint });

                            // Set session directly with tokens from URL - more reliable than auto-detect
                            // FIX: Add timeout to prevent hanging on slow Supabase
                            try {
                                const setSessionPromise = supabase.auth.setSession({
                                    access_token: accessToken,
                                    refresh_token: refreshToken
                                });
                                const timeout = new Promise((_, reject) =>
                                    setTimeout(() => reject(new Error('setSession timeout')), window.AUTH_TIMEOUTS?.SET_SESSION || 10000)
                                );
                                const { data, error } = await Promise.race([setSessionPromise, timeout]);

                                if (error) {
                                    console.error('Failed to set session from tokens:', error.message);
                                    authFailureMessage = error.message || authFailureMessage;
                                    // Don't clear hash on error - tokens stay in URL for retry on refresh
                                } else if (data?.user) {

                                    user = data.user;
                                    // FIX: Clear hash AFTER successful setSession to prevent double processing
                                    // This ensures tokens are only cleared when session is properly established
                                    clearAuthParamsFromUrl();
                                }
                            } catch (setSessionError) {
                                console.error('setSession error:', setSessionError.message);
                                authFailureMessage = setSessionError.message || authFailureMessage;
                            }
                        }
                    }
                } catch (tokenError) {
                    console.error('Error parsing OAuth tokens:', tokenError);
                }
            }

            // PKCE fallback: exchange OAuth code from query params for a session.
            // This supports callback flows that don't carry tokens in the URL hash.
            if (!user && hasOAuthCode) {
                if (syncingText) syncingText.textContent = 'Authenticating...';

                const exchangeCode = async () => {
                    const exchangePromise = supabase.auth.exchangeCodeForSession(authCode);
                    const timeout = new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('exchangeCodeForSession timeout')), window.AUTH_TIMEOUTS?.SET_SESSION || 10000)
                    );
                    return Promise.race([exchangePromise, timeout]);
                };

                for (let attempt = 0; attempt < 3 && !user; attempt++) {
                    try {
                        const { data, error } = await exchangeCode();
                        if (error) {
                            authFailureMessage = error.message || authFailureMessage;
                            throw new Error(error.message || 'exchangeCodeForSession failed');
                        }

                        user = data?.user || data?.session?.user || null;
                        if (user) {
                            clearAuthParamsFromUrl();
                            break;
                        }
                    } catch (exchangeError) {
                        authFailureMessage = exchangeError.message || authFailureMessage;
                        console.error('OAuth code exchange failed:', exchangeError.message || exchangeError);

                        if (attempt < 2 && isLikelyTransientAuthNetworkError(exchangeError)) {
                            await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
                            continue;
                        }
                        break;
                    }
                }
            }

            // Fallback: If direct token setting failed, try the old method
            if (!user) {

                if (syncingText) syncingText.textContent = 'Connecting...';

                // Wait for Supabase to process tokens
                await new Promise(resolve => setTimeout(resolve, 1000));

                // Try to get user with retries (each attempt has a timeout)
                for (let attempt = 0; attempt < 5; attempt++) {
                    if (syncingText && attempt > 0) {
                        syncingText.textContent = `Connecting... (attempt ${attempt + 1}/5)`;
                    }

                    // Try getSession first (faster than isLoggedIn)
                    // FIX: Add timeout to prevent hanging on slow Supabase
                    try {
                        const sessionPromise = supabase.auth.getSession();
                        const timeout = new Promise((_, reject) =>
                            setTimeout(() => reject(new Error('getSession timeout')), window.AUTH_TIMEOUTS?.GET_SESSION || 5000)
                        );
                        const { data: sessionData } = await Promise.race([sessionPromise, timeout]);
                        if (sessionData?.session?.user) {
                            user = sessionData.session.user;

                            break;
                        }
                    } catch (e) {
                        console.warn('getSession attempt', attempt + 1, 'failed:', e.message);
                    }

                    // Wait longer on each retry: 500ms, 1000ms, 1500ms, 2000ms, 2500ms
                    await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
                }
            }

            // Handle failure case - no user after all attempts
            if (!user) {
                console.error('OAuth login failed - could not retrieve user');
                setWelcomeGoogleButtonState({ visible: true, disabled: false, loading: false });
                if (syncingDiv) syncingDiv.classList.add('hidden');
                if (syncingText) syncingText.textContent = 'Syncing please wait'; // Reset text
                showAuthError(authFailureMessage || 'Login failed. Please try again.');
                clearAuthParamsFromUrl();
                return true;
            }

            // Success - we have a user
            // Store user info for Settings modal
            if (user?.id && typeof chrome !== 'undefined' && chrome.storage?.local) {
                // Claim onboarding ownership for this tab BEFORE broadcasting auth change
                // This ensures other tabs won't show onboarding while this tab is logging in.
                const ownerKey = `lumilist_onboarding_owner_${user.id}`;
                await chrome.storage.local.set({
                    [ownerKey]: {
                        userId: user.id,
                        tabId: TAB_INSTANCE_ID,
                        timestamp: Date.now(),
                        reason: 'login-tab'
                    }
                });
            }

            const previousStoredUser = await SyncManager.getStoredUser();
            const isAccountSwitch = previousStoredUser?.id && previousStoredUser.id !== user.id;
            if (isAccountSwitch) {
                await db.pages.clear();
                await db.boards.clear();
                await db.bookmarks.clear();
                await db.syncQueue.clear();
                await clearUndoRedoHistory();
                setWorkspaceOwnerUserId(user.id);
                await resetWallpaperStateForAccountBoundary({ clearPersistedState: true });
            }

            await SyncManager.setStoredUser({
                id: user.id,
                email: user.email
            });
            setWallpaperAccountScopeUserId(user.id);
            await loadWallpaperCloudSyncStateFromStorage(user.id);

            // Use syncOnLogin for SAFE cloud-first sync
            // This clears local data and downloads from cloud, preventing data loss
            try {
                if (syncingText) syncingText.textContent = 'Syncing data...';
                const loginResult = await SyncManager.syncOnLogin();


                if (loginResult.success) {
                    clearLateAuthReconcileSuppression();
                    if (loginResult.action === 'imported') {

                    } else if (loginResult.action === 'created_home') {
                        try {
                            await chrome.storage.local.set({
                                [WALLPAPER_NEW_USER_DEFAULT_SEED_STORAGE_KEY]: {
                                    userId: user.id,
                                    createdAt: Date.now()
                                }
                            });
                        } catch (error) {
                            console.warn('Failed to queue pending new-user wallpaper default seed:', error);
                        }
                    }
                    await applyWallpaperCloudSyncState(
                        (await chrome.storage.local.get(WALLPAPER_CLOUD_SYNC_STATE_STORAGE_KEY))[WALLPAPER_CLOUD_SYNC_STATE_STORAGE_KEY],
                        { source: 'post-login-sync' }
                    );
                    await ensureWallpaperPreferencesInitialized();
                    await applyWebsiteWallpaperHandoffFromUrl();
                } else {
                    console.error('Login sync failed:', loginResult.error);
                    clearAuthParamsFromUrl();
                    await showWorkspaceLoadFailure('Login succeeded, but we could not load your data. Please refresh and try again.');
                    return true;
                }

                // Set current page if not set
                // Use sortBy() instead of orderBy() - orderBy() after filter() discards the filter!
                const pages = await db.pages.filter(p => !p.deletedAt).sortBy('order');
                if (pages.length > 0) {
                    currentPageId = pages[0].id;
                    if (typeof chrome !== 'undefined' && chrome.storage) {
                        await chrome.storage.local.set({ currentPageId: pages[0].id });
                    }
                }

                await loadPagesNavigation();

                // Ensure first tab is selected BEFORE loading boards
                await ensureFirstTabSelected();
                await loadBoardsFromDatabase();
                setWorkspaceOwnerUserId(user.id);
                hideWelcomeScreen();
                updateAuthUI();

                // Show onboarding modal for new users after OAuth login
                if (loginResult.action === 'created_home') {
                    checkShowOnboarding(true);  // Pass true to skip server check (we know it's a new user)
                }
            } catch (error) {
                console.error('Post-auth sync error:', error);
                clearAuthParamsFromUrl();
                await showWorkspaceLoadFailure('Login succeeded, but we could not load your data. Please refresh and try again.');
                return true;
            }

            // Clear hash from URL
            clearAuthParamsFromUrl();

            return true;
        } finally {
            // FIX: Always reset flag, even if an exception occurred
            isCurrentTabAuthenticating = false;
            window.isCurrentTabAuthenticating = false;
        }
    }

    // Check for error in URL (failed OAuth or verification)
    const hashParams = hash.startsWith('#') ? new URLSearchParams(hash.substring(1)) : new URLSearchParams();
    if (hashParams.has('error') || hashParams.has('error_description') ||
        searchParams.has('error') || searchParams.has('error_description')) {
        const rawError = hashParams.get('error_description') ||
            searchParams.get('error_description') ||
            hashParams.get('error') ||
            searchParams.get('error');
        let errorMsg = 'Authentication failed. Please try again.';
        if (rawError) {
            errorMsg = decodeURIComponent(rawError.replace(/\+/g, ' '));
            console.error('Auth error:', errorMsg);
        }
        // Show welcome screen for retry
        showWelcomeScreen();
        // Show error toast to user
        showGlassToast(errorMsg, 'error');
        // Clear the error from URL
        clearAuthParamsFromUrl();
        return true;
    }

    return false;
}

// ============ Welcome Screen Functions ============

const WELCOME_GOOGLE_BUTTON_DEFAULT_LABEL = 'Sign in with Google';
const WELCOME_GOOGLE_BUTTON_LOADING_LABEL = 'Opening Google Sign-In...';

function setWelcomeGoogleButtonState({
    visible = true,
    disabled = false,
    loading = false,
    label = null
} = {}) {
    const googleBtn = document.getElementById('welcomeGoogleBtn');
    if (!googleBtn) return;

    googleBtn.style.display = visible ? '' : 'none';
    googleBtn.disabled = !!disabled;
    googleBtn.classList.toggle('is-loading', !!loading);

    if (loading) {
        googleBtn.setAttribute('aria-busy', 'true');
    } else {
        googleBtn.removeAttribute('aria-busy');
    }

    const btnText = googleBtn.querySelector('.btn-text');
    if (btnText) {
        if (typeof label === 'string' && label.trim()) {
            btnText.textContent = label.trim();
        } else {
            btnText.textContent = loading
                ? WELCOME_GOOGLE_BUTTON_LOADING_LABEL
                : WELCOME_GOOGLE_BUTTON_DEFAULT_LABEL;
        }
    }
}

// Show welcome screen in "syncing" state for cross-tab login
function showWelcomeSyncingState(message = 'Syncing data...') {
    const welcomeScreen = document.getElementById('welcomeScreen');
    const syncingDiv = document.getElementById('welcomeSyncing');

    if (welcomeScreen) welcomeScreen.classList.remove('hidden');
    document.body.classList.add('not-authenticated');

    setWelcomeGoogleButtonState({ visible: false, disabled: false, loading: false });
    if (syncingDiv) {
        syncingDiv.classList.remove('hidden');
        const syncingText = syncingDiv.querySelector('span');
        if (syncingText) syncingText.textContent = message;
    }
}

// Begin waiting for another tab to finish login sync (UI-only, no server sync)
function beginCrossTabLoginWait(userId) {
    if (!userId) return;

    // Mark cross-tab login in progress to block onAuthStateChange SIGNED_IN from racing
    _crossTabLoginInProgress = true;
    _pendingCrossTabLoginUserId = userId;
    setWorkspaceOwnerUserId(null);
    void resetWallpaperStateForAccountBoundary({ clearPersistedState: true }).catch((error) => {
        console.error('Failed to reset wallpaper state while waiting for cross-tab login:', error);
    });
    resetSubscriptionUiForAccountBoundary();
    resetAccountBoundaryTransientUi({ quickTourReason: 'account_boundary' });

    // Show syncing state and clear visible UI to avoid old data flash
    showWelcomeSyncingState('Syncing data...');
    clearAllColumns();

    // Start safety timeout to avoid stuck state if signal never arrives
    if (_crossTabLoginTimeoutId) {
        clearTimeout(_crossTabLoginTimeoutId);
        _crossTabLoginTimeoutId = null;
    }
    _crossTabLoginTimeoutId = setTimeout(() => {
        if (_pendingCrossTabLoginUserId) {
            console.warn('Cross-tab login sync signal timeout - loading local data');
            handleLoginSyncCompleteSignal({
                userId: _pendingCrossTabLoginUserId,
                timestamp: Date.now()
            });
        }
    }, 15000);
}

// Handle cross-tab login sync completion (UI-only reload, no server sync)
async function handleLoginSyncCompleteSignal(signal) {
    try {
        if (!signal?.userId) return;
        // Deduplicate repeated signals
        if (_lastLoginSyncSignal.userId === signal.userId &&
            _lastLoginSyncSignal.timestamp >= signal.timestamp) {
            return;
        }
        _lastLoginSyncSignal = {
            userId: signal.userId,
            timestamp: signal.timestamp,
            action: signal.action || null
        };

        // Ignore if this tab is the one actively authenticating
        if (isCurrentTabAuthenticating) return;

        // Ensure this signal matches the current logged-in user
        const storedUser = await SyncManager.getStoredUser();
        if (!storedUser?.id || storedUser.id !== signal.userId) {
            if (_pendingCrossTabLoginUserId === signal.userId) {
                resetCrossTabLoginWaitState();
            }
            return;
        }

        const loginSyncState = await getStoredLoginSyncState();
        const hasExplicitCompletionSignal = typeof signal.action === 'string' && signal.action.trim().length > 0;
        const hasCompletedLoginSync = hasExplicitCompletionSignal || (
            loginSyncState?.userId === signal.userId
            && loginSyncState.phase === 'completed'
        );

        if (!hasCompletedLoginSync) {
            await showWorkspaceLoadFailure('We could not finish loading your data. Please refresh and try again.');
            return;
        }

        // Hide welcome screen and load UI from local IndexedDB (no server calls)
        clearLateAuthReconcileSuppression();
        setWorkspaceOwnerUserId(storedUser.id);
        hideWelcomeScreen();
        beginWorkspaceStartupShell();
        await recalculateBookmarkCount();
        await loadPagesNavigation();
        await ensureFirstTabSelected();
        await loadBoardsFromDatabase();

        // Refresh settings/auth UI (uses cached data)
        // Skip onboarding check here to avoid duplicate server checks across tabs
        updateAuthUI({ skipOnboarding: true });
        await applyWallpaperCloudSyncState(
            (await chrome.storage.local.get(WALLPAPER_CLOUD_SYNC_STATE_STORAGE_KEY))[WALLPAPER_CLOUD_SYNC_STATE_STORAGE_KEY],
            { source: 'cross-tab-login-complete' }
        );
        await ensureWallpaperPreferencesInitialized();
        await applyWebsiteWallpaperHandoffFromUrl();

        // Clear cross-tab login guards once UI is ready
        if (_pendingCrossTabLoginUserId === signal.userId) {
            resetCrossTabLoginWaitState();
        }
        if (_pendingAuthChange?.newValue?.id === signal.userId) {
            _pendingAuthChange = null;
        }
    } catch (error) {
        console.error('Error handling login sync complete signal:', error);
        await showWorkspaceLoadFailure('We could not finish loading your data. Please refresh and try again.');
    } finally {
        finishWorkspaceStartupShell();
    }
}

function normalizePendingWelcomeNotice(notice) {
    if (!notice || typeof notice !== 'object') {
        return null;
    }

    const message = typeof notice.message === 'string' ? notice.message.trim() : '';
    if (!message) {
        return null;
    }

    const variant = typeof notice.variant === 'string'
        ? notice.variant.trim().toLowerCase()
        : 'info';
    const allowedVariants = new Set(['success', 'warning', 'info', 'error']);
    const rawDurationMs = Number(notice.durationMs);
    const durationMs = Number.isFinite(rawDurationMs) && rawDurationMs > 0
        ? rawDurationMs
        : null;

    return {
        message,
        variant: allowedVariants.has(variant) ? variant : 'info',
        durationMs
    };
}

function clearPendingWelcomeNoticeTimer() {
    if (pendingWelcomeNoticeTimeoutId) {
        clearTimeout(pendingWelcomeNoticeTimeoutId);
        pendingWelcomeNoticeTimeoutId = null;
    }
}

function renderPendingWelcomeNotice() {
    const noticeEl = document.getElementById('welcomeNotice');
    if (!noticeEl) {
        return;
    }

    noticeEl.classList.remove('success', 'warning', 'info', 'error');

    if (!pendingWelcomeNotice) {
        noticeEl.textContent = '';
        noticeEl.classList.add('hidden');
        return;
    }

    noticeEl.textContent = pendingWelcomeNotice.message;
    noticeEl.classList.add(pendingWelcomeNotice.variant);
    noticeEl.classList.remove('hidden');
}

function setPendingWelcomeNotice(notice) {
    clearPendingWelcomeNoticeTimer();
    pendingWelcomeNotice = normalizePendingWelcomeNotice(notice);
    renderPendingWelcomeNotice();

    if (pendingWelcomeNotice?.durationMs) {
        pendingWelcomeNoticeTimeoutId = setTimeout(() => {
            pendingWelcomeNoticeTimeoutId = null;
            clearPendingWelcomeNotice();
        }, pendingWelcomeNotice.durationMs);
    }
}

function clearPendingWelcomeNotice() {
    clearPendingWelcomeNoticeTimer();
    pendingWelcomeNotice = null;
    renderPendingWelcomeNotice();
}

// Show welcome screen (for logged out users)
function showWelcomeScreen() {
    // Automatically hide welcome screen to allow local-only use
    hideWelcomeScreen();
    return;
}

function showWelcomeScreenOriginal() {
    resetSubscriptionUiForAccountBoundary();

    // Reset internal state BEFORE showing (prevents stale "Syncing please wait" flash)
    const syncingDiv = document.getElementById('welcomeSyncing');
    setWelcomeGoogleButtonState({ visible: true, disabled: false, loading: false });
    if (syncingDiv) {
        syncingDiv.classList.add('hidden');
        // Reset text back to default (handleLogout changes it to "Signing out...")
        const syncingText = syncingDiv.querySelector('span');
        if (syncingText) syncingText.textContent = 'Syncing please wait';
    }
    renderPendingWelcomeNotice();

    const welcomeScreen = document.getElementById('welcomeScreen');
    if (welcomeScreen) welcomeScreen.classList.remove('hidden');
    document.body.classList.add('not-authenticated');
    writeThemeBootstrapAuthHint(false);
    applyLoggedOutDefaultThemeUi();
    void loadWallpaperCatalog().then(() => {
        if (document.body?.classList?.contains('not-authenticated')) {
            applyLoggedOutDefaultThemeUi();
        }
    }).catch((error) => {
        console.warn('Failed to refresh welcome screen with packaged wallpaper default:', error);
    });
    void queueLoggedOutThemeReset();
}

// Hide welcome screen
function hideWelcomeScreen() {
    const welcomeScreen = document.getElementById('welcomeScreen');
    if (welcomeScreen) welcomeScreen.classList.add('hidden');
    document.body.classList.remove('not-authenticated');
    writeThemeBootstrapAuthHint(true);

    // Reset welcome screen internal state for next time it's shown (e.g., after logout)
    const syncingDiv = document.getElementById('welcomeSyncing');
    setWelcomeGoogleButtonState({ visible: true, disabled: false, loading: false });
    if (syncingDiv) syncingDiv.classList.add('hidden');
    clearPendingWelcomeNotice();
}

function isUserCancelledGoogleLoginError(errorMessage) {
    return false;
}

// Handle Google login from welcome screen - DISABLED
async function handleWelcomeGoogleLogin() {
    return;
}

/*
============================================================
BOARD & PAGE SHARING FUNCTIONALITY
============================================================
Functions for sharing boards and pages via public links
*/

const SUPABASE_FUNCTIONS_URL = 'https://xbccmcszhnybxzlirjgk.supabase.co/functions/v1';

// Current share being managed in modal
let currentShareModalData = null;

// Race condition guards for share modal operations
let shareModalInProgress = false;
let isStopShareInProgress = false;

/**
 * Create a new share (or return existing one)
 * Updates local IndexedDB with the new shareId
 */
async function createShare(type, itemId) {
    try {
        // Get Supabase access token for authentication
        const token = await getSupabaseAccessToken();
        if (!token) {
            showGlassToast('Please sign in to share content', 'error');
            return null;
        }

        // Add timeout to prevent indefinite hanging (like stopShare)
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);

        const response = await fetch(`${SUPABASE_FUNCTIONS_URL}/create-share`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                share_type: type,
                item_id: itemId
            }),
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        const data = await response.json();

        if (!response.ok) {
            showGlassToast(data.error || 'Failed to create share', 'error');
            return null;
        }

        // Update local IndexedDB with the new shareId using wrapper functions
        // This ensures updatedAt, queueSyncToBackground, and broadcastDataChange are called
        let updateResult;
        try {
            if (type === 'board') {
                updateResult = await updateBoard(itemId, { shareId: data.share_id }, { skipHistory: true });
            } else {
                updateResult = await updatePage(itemId, { shareId: data.share_id }, { skipHistory: true });
            }
        } catch (updateError) {
            console.warn(`Local ${type} ${itemId} failed to persist after share creation:`, updateError);
            showGlassToast('Share created but local update failed. Refresh to sync.', 'warning');
            return data;
        }

        // Check if local update succeeded (0 = record not found)
        if (updateResult === 0) {
            console.warn(`Local ${type} ${itemId} not found during share creation`);
            showGlassToast('Share created but local update failed. Refresh to sync.', 'warning');
        }

        return data;
    } catch (error) {
        console.error('Error creating share:', error);
        // Show user-friendly error message
        if (error.name === 'AbortError') {
            showGlassToast('Request timed out. Please try again.', 'error');
        } else {
            showGlassToast('Failed to create share', 'error');
        }
        return null;
    }
}

/**
 * Stop sharing a board or page
 * Clears the shareId from the item
 */
async function stopShare(type, itemId, options = {}) {
    try {
        // Get Supabase access token for authentication
        const token = await getSupabaseAccessToken();
        if (!token) {
            showGlassToast('Please sign in to manage sharing', 'warning');
            return false;
        }

        // Add timeout to prevent indefinite hanging
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);

        const response = await fetch(`${SUPABASE_FUNCTIONS_URL}/stop-share`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                share_type: type,
                item_id: itemId
            }),
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            // Safe JSON parsing - response might not be valid JSON
            let errorMessage = 'Failed to stop sharing';
            try {
                const data = await response.json();
                errorMessage = data.error || errorMessage;
            } catch (e) {
                // Response wasn't valid JSON, use default message
            }
            showGlassToast(errorMessage, 'error');
            return false;
        }

        if (options.skipLocalUpdate) {
            return true;
        }

        // Update local IndexedDB to clear shareId using wrapper functions
        // This ensures updatedAt, queueSyncToBackground, and broadcastDataChange are called
        let updateResult;
        try {
            if (type === 'board') {
                updateResult = await updateBoard(itemId, { shareId: null }, { skipHistory: true });
            } else {
                updateResult = await updatePage(itemId, { shareId: null }, { skipHistory: true });
            }
        } catch (updateError) {
            console.warn(`Local ${type} ${itemId} failed to persist after stop-share:`, updateError);
            showGlassToast('Share stopped but local update failed. Refresh to sync.', 'warning');
            return true;
        }

        // Check if local update succeeded (0 = record not found)
        if (updateResult === 0) {
            console.warn(`Local ${type} ${itemId} not found during stop share`);
            showGlassToast('Share stopped but local update failed. Refresh to sync.', 'warning');
        }

        return true;
    } catch (error) {
        console.error('Error stopping share:', error);
        // Show user-friendly error message
        if (error.name === 'AbortError') {
            showGlassToast('Request timed out. Please try again.', 'error');
        } else {
            showGlassToast('Failed to stop sharing. Please try again.', 'error');
        }
        return false;
    }
}

/**
 * Open share modal for a board or page
 * Simplified architecture: shareId stored directly on board/page
 */
async function openShareModal(type, itemId) {
    // Race condition guard - prevent concurrent calls
    if (shareModalInProgress) {

        return;
    }

    // Clear any stale data before async operations (Issue 4)
    currentShareModalData = null;

    try {
        shareModalInProgress = true;

        // Check if user is logged in
        const isLoggedIn = await SyncManager.isLoggedIn();
        if (!isLoggedIn) {
            showGlassToast('Please sign in to share content', 'warning');
            return;
        }

        // Show modal immediately with loading state
        const modal = document.getElementById('shareModal');
        const title = document.getElementById('shareModalTitle');
        const linkInput = document.getElementById('shareLinkInput');
        const copyBtn = document.getElementById('copyShareLinkBtn');
        const stopBtn = document.getElementById('stopShareBtn');

        title.textContent = 'Loading...';
        linkInput.value = 'Generating share link...';

        // Disable buttons during loading (Issue 3)
        if (copyBtn) copyBtn.disabled = true;
        if (stopBtn) stopBtn.disabled = true;

        modal.classList.add('active');

        // Get the item from IndexedDB
        let item = null;
        if (type === 'board') {
            item = await db.boards.get(itemId);
        } else {
            item = await db.pages.get(itemId);
        }

        if (!item) {
            showGlassToast('Item not found', 'error');
            modal.classList.remove('active');
            return;
        }

        const itemName = item.name || (type === 'board' ? 'Board' : 'Page');
        let shareId = item.shareId;

        // If not shared yet, create a new share
        if (!shareId) {
            showGlassToast('Creating share link...', 'info');
            const newShare = await createShare(type, itemId);
            if (!newShare) {
                modal.classList.remove('active');
                return;
            }
            shareId = newShare.share_id;
        }

        // Store current share data for modal actions
        currentShareModalData = {
            type: type,
            itemId: itemId,
            shareId: shareId
        };

        // Update modal UI
        title.textContent = `Share "${itemName}"`;
        linkInput.value = `https://lumilist.in/share/?id=${shareId}`;

        // Re-enable buttons after URL is set (Issue 3)
        if (copyBtn) copyBtn.disabled = false;
        if (stopBtn) stopBtn.disabled = false;

        // Refresh boards to show shared indicator
        await loadBoardsFromDatabase();
        await loadPagesNavigation();
    } finally {
        shareModalInProgress = false;
    }
}

/**
 * Close share modal
 */
function closeShareModal() {
    const modal = document.getElementById('shareModal');
    modal.classList.remove('active');
    currentShareModalData = null;
}

/**
 * Copy share link to clipboard
 */
async function copyShareLink() {
    const linkInput = document.getElementById('shareLinkInput');
    const copyBtn = document.getElementById('copyShareLinkBtn');

    try {
        await navigator.clipboard.writeText(linkInput.value);
        copyBtn.classList.add('copied');
        showGlassToast('Link copied to clipboard!', 'success');

        setTimeout(() => {
            copyBtn.classList.remove('copied');
        }, 2000);
    } catch (error) {
        // Fallback: select the input
        linkInput.select();
        document.execCommand('copy');
        showGlassToast('Link copied to clipboard!', 'success');
    }
}

/**
 * Handle stop sharing button
 */
async function handleStopShare() {
    // Race condition guard - prevent double-click
    if (!currentShareModalData || isStopShareInProgress) return;

    const stopBtn = document.getElementById('stopShareBtn');

    // Disable button immediately before any async work
    isStopShareInProgress = true;
    if (stopBtn) stopBtn.disabled = true;

    try {
        const confirmed = await showGlassConfirm(
            'Stop sharing?',
            'This will permanently remove the share link. Anyone who has imported this content will keep their copy.',
            { confirmText: 'Stop Sharing', confirmClass: 'btn-danger' }
        );

        if (!confirmed) return;

        // Show loading state on button
        if (stopBtn) stopBtn.textContent = 'Stopping...';

        const success = await stopShare(currentShareModalData.type, currentShareModalData.itemId);

        if (success) {
            showGlassToast('Sharing stopped', 'success');
            closeShareModal();

            // Refresh to update indicators
            await loadBoardsFromDatabase();
            await loadPagesNavigation();
        } else {
            // Error message already shown by stopShare, just close modal
            closeShareModal();
        }
    } finally {
        // Restore button state
        if (stopBtn) {
            stopBtn.textContent = 'Stop Sharing';
            stopBtn.disabled = false;
        }
        isStopShareInProgress = false;
    }
}

// Initialize share modal event listeners
document.addEventListener('DOMContentLoaded', function () {
    // Close button
    const closeBtn = document.getElementById('closeShareModalBtn');
    if (closeBtn) {
        closeBtn.addEventListener('click', closeShareModal);
    }

    // Copy button
    const copyBtn = document.getElementById('copyShareLinkBtn');
    if (copyBtn) {
        copyBtn.addEventListener('click', copyShareLink);
    }

    // Stop sharing button
    const stopShareBtn = document.getElementById('stopShareBtn');
    if (stopShareBtn) {
        stopShareBtn.addEventListener('click', handleStopShare);
    }

    // Close on overlay click (safe drag-outside handling)
    const modal = document.getElementById('shareModal');
    setupModalClickOutside(modal, closeShareModal);
});

/*
============================================================
IMPORT LINKS FUNCTIONALITY
============================================================
Import links from pasted text, HTML, or file uploads with smart grouping
*/

/**
 * Normalize URL for duplicate detection
 * Removes trailing slashes, utm params, forces lowercase
 */
function normalizeUrlForDuplicateCheck(url) {
    try {
        const u = new URL(url);
        // Remove common tracking parameters
        const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref', 'source', 'fbclid', 'gclid'];
        trackingParams.forEach(param => u.searchParams.delete(param));
        // Normalize: origin + pathname (no trailing slash) + cleaned query + hash
        let normalized = u.origin + u.pathname.replace(/\/$/, '');
        const search = u.searchParams.toString();
        if (search) normalized += `?${search}`;
        if (u.hash) normalized += u.hash;
        return normalized.toLowerCase();
    } catch {
        return url.toLowerCase();
    }
}

/**
 * Extract URLs from any text with surrounding context
 * Supports Markdown link syntax [title](url) - extracts title as bookmark name
 */
function extractUrlsFromText(text) {
    // Null/undefined check
    if (!text || typeof text !== 'string') {
        return [];
    }

    const results = [];
    const seenUrls = new Set();

    // First, extract Markdown links: [title](url) - preserves the title
    const markdownLinkRegex = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/gi;
    let match;

    while ((match = markdownLinkRegex.exec(text)) !== null) {
        // Unescape brackets/parentheses that were escaped for Markdown
        const title = match[1].replace(/\\([\[\]()])/g, '$1');
        const url = match[2];
        const normalizedUrl = normalizeUrlForDuplicateCheck(url);

        if (!seenUrls.has(normalizedUrl) && !isUnsafeUrl(url)) {
            seenUrls.add(normalizedUrl);
            results.push({
                url: url,
                title: title,  // Preserve the Markdown title for bookmark name
                context: ''
            });
        }
    }

    // Then extract plain URLs (existing logic) - skip those already found as Markdown
    const urlRegex = /(https?:\/\/[^\s<>"')\]]+)/gi;
    while ((match = urlRegex.exec(text)) !== null) {
        const url = match[1];
        // Clean trailing punctuation
        const cleanUrl = url.replace(/[.,;:!?)]+$/, '');
        const normalizedUrl = normalizeUrlForDuplicateCheck(cleanUrl);

        // Skip if already found as Markdown link or duplicate
        if (seenUrls.has(normalizedUrl)) continue;
        if (isUnsafeUrl(cleanUrl)) continue;

        seenUrls.add(normalizedUrl);

        // Extract surrounding context (~10 words before and after)
        const idx = match.index;
        const before = text.substring(Math.max(0, idx - 150), idx);
        const after = text.substring(idx + url.length, idx + url.length + 150);

        const beforeWords = before.split(/\s+/).slice(-10).join(' ').trim();
        const afterWords = after.split(/\s+/).slice(0, 10).join(' ').trim();
        const context = `${beforeWords} ${afterWords}`.trim();

        results.push({ url: cleanUrl, title: null, context });
    }
    return results;
}

/**
 * Find the nearest heading element above a given element
 */
function findNearestHeading(element) {
    let el = element;
    while (el && el.tagName !== 'BODY') {
        // Check previous siblings for headings
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

/**
 * Check if two elements are close in the DOM (proximate siblings)
 */
function areProximateSiblings(el1, el2) {
    if (!el1 || !el2) return false;
    if (el1 === el2) return true;
    if (el1.parentElement === el2.parentElement) return true;
    // Check if they share grandparent
    if (el1.parentElement?.parentElement === el2.parentElement?.parentElement) return true;
    return false;
}

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

/**
 * Extract Papaly categories (boards) and links when Papaly HTML structure is detected
 * Returns array of { name, links } or null if not detected
 */
function extractPapalyGroupsFromHtmlDoc(doc) {
    const boards = doc.querySelectorAll('.board');
    let activeBoard = null;
    if (boards && boards.length > 0) {
        activeBoard = Array.from(boards).find(board =>
            typeof board.getAttribute === 'function' &&
            (board.getAttribute('style') || '').toLowerCase().includes('display: block')
        ) || boards[boards.length - 1];
    }

    const containers = activeBoard
        ? activeBoard.querySelectorAll('.cards-container.theme-card')
        : doc.querySelectorAll('.cards-container.theme-card');
    const rootContainer = containers.length > 0 ? containers[containers.length - 1] : null;
    if (!rootContainer) return null;

    const slots = rootContainer.querySelectorAll('.category-slot');
    if (!slots || slots.length === 0) return null;

    const groups = [];

    slots.forEach(slot => {
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

                // Security: Block javascript: URLs and unsafe schemes
                if (href.toLowerCase().trim().startsWith('javascript:')) return;
                if (isUnsafeUrl(href)) return;
                if (!href.startsWith('http')) return;

                const title = resolvePapalyLinkTitle(linkEl, item, href);
                const noteText = normalizePapalyText(item.querySelector('.item-bookmark-note')?.textContent || '');

                const rawItemPosition = parseFloat(item.getAttribute('item-position'));
                const itemOrder = Number.isFinite(rawItemPosition) ? rawItemPosition : idx;

                links.push({ url: href, title: title || href, context: noteText, _order: itemOrder });
            });

            if (links.length > 0) {
                links.sort((a, b) => (a._order || 0) - (b._order || 0));
                links.forEach(link => { delete link._order; });
                groups.push({ name, links, columnIndex: slotIndex, orderKey });
            }

            cardIndex++;
        });
    });

    if (groups.length === 0) return null;

    groups.sort((a, b) => {
        const colA = Number.isFinite(a.columnIndex) ? a.columnIndex : 0;
        const colB = Number.isFinite(b.columnIndex) ? b.columnIndex : 0;
        if (colA !== colB) return colA - colB;
        const ordA = Number.isFinite(a.orderKey) ? a.orderKey : 0;
        const ordB = Number.isFinite(b.orderKey) ? b.orderKey : 0;
        return ordA - ordB;
    });

    return groups;
}

/**
 * Extract links from HTML with proximity-based grouping
 */
function extractLinksFromHtml(html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    // Papaly-specific grouping: use category titles as board names
    const papalyGroups = extractPapalyGroupsFromHtmlDoc(doc);
    if (papalyGroups && papalyGroups.length > 0) {
        return papalyGroups;
    }

    const links = doc.querySelectorAll('a[href]');

    const groups = [];
    let currentGroup = { name: null, links: [] };
    let lastParent = null;

    links.forEach(link => {
        const href = link.getAttribute('href');
        if (!href) return;

        // Security: Block javascript: URLs (even if followed by http, e.g., "javascript:http://evil.com")
        if (href.toLowerCase().trim().startsWith('javascript:')) {
            console.warn('[Security] Blocked javascript: URL in HTML import:', href.substring(0, 50));
            return;
        }

        // Security: Block all unsafe URL schemes
        if (isUnsafeUrl(href)) {
            console.warn('[Security] Blocked unsafe URL in HTML import:', href.substring(0, 50));
            return;
        }

        // Only allow http/https URLs
        if (!href.startsWith('http')) return;

        const title = link.textContent.trim() || href;

        // Find nearest heading for group name
        const heading = findNearestHeading(link);

        // Check if we should start a new group
        const parent = link.parentElement;
        const shouldBreak = (heading && heading !== currentGroup.name) ||
            (lastParent && !areProximateSiblings(lastParent, parent) && currentGroup.links.length > 0);

        if (shouldBreak && currentGroup.links.length > 0) {
            groups.push(currentGroup);
            currentGroup = { name: heading, links: [] };
        }

        if (heading) currentGroup.name = heading;
        currentGroup.links.push({ url: href, title, context: '' });
        lastParent = parent;
    });

    if (currentGroup.links.length > 0) {
        groups.push(currentGroup);
    }

    return groups;
}

function normalizeImportHtmlText(value) {
    if (typeof value !== 'string') return '';
    return value.replace(/\s+/g, ' ').trim();
}

function getDirectChildByTag(parent, tagName) {
    if (!parent || !parent.children || !tagName) return null;
    const normalizedTag = String(tagName).toUpperCase();
    return Array.from(parent.children).find(child => child.tagName === normalizedTag) || null;
}

function extractNetscapeDlEntries(dlEl) {
    if (!dlEl || dlEl.tagName !== 'DL') return [];

    const entries = [];
    const children = Array.from(dlEl.children || []);

    for (let i = 0; i < children.length; i++) {
        const element = children[i];
        if (!element || element.tagName !== 'DT') continue;

        const folderEl = getDirectChildByTag(element, 'H3');
        const linkEl = getDirectChildByTag(element, 'A');

        let nestedDl = getDirectChildByTag(element, 'DL');
        if (!nestedDl) {
            let nextIndex = i + 1;
            while (nextIndex < children.length && children[nextIndex]?.tagName === 'P') {
                nextIndex++;
            }
            if (nextIndex < children.length && children[nextIndex]?.tagName === 'DL') {
                nestedDl = children[nextIndex];
                i = nextIndex;
            }
        }

        if (folderEl) {
            entries.push({
                kind: 'folder',
                title: normalizeImportHtmlText(folderEl.textContent || ''),
                childrenDl: nestedDl || null
            });
            continue;
        }

        if (linkEl) {
            const href = normalizeImportHtmlText(linkEl.getAttribute('href') || '');
            if (!href) continue;
            const title = normalizeImportHtmlText(linkEl.textContent || '') || href;
            entries.push({
                kind: 'link',
                url: href,
                title
            });
        }
    }

    return entries;
}

function collectNetscapeLinksFromDl(dlEl) {
    const links = [];
    const entries = extractNetscapeDlEntries(dlEl);

    for (const entry of entries) {
        if (entry.kind === 'link') {
            links.push({ url: entry.url, title: entry.title, context: '' });
            continue;
        }

        if (entry.kind === 'folder' && entry.childrenDl) {
            links.push(...collectNetscapeLinksFromDl(entry.childrenDl));
        }
    }

    return links;
}

function looksLikePapalyNetscapeExport(doc, topLevelFolderNames = []) {
    const normalizedNames = (Array.isArray(topLevelFolderNames) ? topLevelFolderNames : [])
        .map(name => normalizeImportHtmlText(name).toLowerCase())
        .filter(Boolean);

    const hasTutorial = normalizedNames.includes('tutorial');
    const hasMyFirstBoard = normalizedNames.includes('my first board');
    const hasImportFolder = normalizedNames.includes('import');
    const hasPapalyLink = !!doc.querySelector('a[href*="papaly.com"]');
    const hasPapalyCloudflareScript = !!doc.querySelector('script[src*="static.cloudflareinsights.com/beacon.min.js"]');

    if (hasTutorial && hasMyFirstBoard) return true;
    if (hasImportFolder && hasPapalyLink) return true;
    if (hasPapalyCloudflareScript && normalizedNames.length > 0) return true;
    return false;
}

function extractPapalyPagesFromHtmlDoc(doc) {
    const rootDl = doc.querySelector('dl');
    if (!rootDl) return null;

    const topLevelEntries = extractNetscapeDlEntries(rootDl)
        .filter(entry => entry.kind === 'folder');
    if (topLevelEntries.length === 0) return null;

    const topLevelNames = topLevelEntries.map(entry => entry.title);
    if (!looksLikePapalyNetscapeExport(doc, topLevelNames)) return null;

    const pages = [];

    topLevelEntries.forEach((boardEntry, boardIndex) => {
        if (!boardEntry?.childrenDl) return;

        const categoryEntries = extractNetscapeDlEntries(boardEntry.childrenDl);
        const groups = [];
        const uncategorizedLinks = [];
        let categoryIndex = 0;

        for (const categoryEntry of categoryEntries) {
            if (categoryEntry.kind === 'folder') {
                const categoryLinks = collectNetscapeLinksFromDl(categoryEntry.childrenDl);
                if (categoryLinks.length > 0) {
                    groups.push({
                        name: categoryEntry.title || `Category ${categoryIndex + 1}`,
                        links: categoryLinks,
                        orderKey: categoryIndex
                    });
                }
                categoryIndex++;
                continue;
            }

            if (categoryEntry.kind === 'link') {
                uncategorizedLinks.push({
                    url: categoryEntry.url,
                    title: categoryEntry.title || categoryEntry.url,
                    context: ''
                });
            }
        }

        if (uncategorizedLinks.length > 0) {
            groups.push({
                name: 'Uncategorized',
                links: uncategorizedLinks,
                orderKey: categoryIndex
            });
        }

        if (groups.length === 0) return;

        pages.push({
            name: boardEntry.title || `Papaly Board ${boardIndex + 1}`,
            groups,
            orderKey: boardIndex
        });
    });

    return pages.length > 0 ? pages : null;
}

function extractPapalyPagesFromHtml(html) {
    if (typeof html !== 'string' || !html.trim()) return null;
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    return extractPapalyPagesFromHtmlDoc(doc);
}

/**
 * Group links by domain
 */
function groupByDomain(links) {
    // Null/undefined check
    if (!links || !Array.isArray(links)) {
        return [];
    }

    const groups = {};

    for (const link of links) {
        try {
            const domain = new URL(link.url).hostname.replace(/^www\./, '');
            if (!groups[domain]) {
                groups[domain] = [];
            }
            groups[domain].push(link);
        } catch (e) {
            // Invalid URL, skip
        }
    }

    // Separate domains with 2+ links from single-link domains
    const result = [];
    const otherLinks = [];

    for (const [domain, domainLinks] of Object.entries(groups)) {
        if (domainLinks.length >= 2) {
            // Domain has multiple links - give it its own board
            result.push({ name: domain, links: domainLinks });
        } else {
            // Single link - collect into "Other Links" board
            otherLinks.push(...domainLinks);
        }
    }

    // Add "Other Links" board if there are any single-domain links
    if (otherLinks.length > 0) {
        result.push({ name: 'Imported Links', links: otherLinks });
    }

    return result;
}

/**
 * Group by double line breaks (1+ consecutive blank line = new group)
 * Pattern: newline + optional whitespace + newline
 */
function groupByLineBreaks(text) {
    // Null/undefined check
    if (!text || typeof text !== 'string') {
        return [];
    }

    // Split by 1+ empty lines (2+ consecutive newlines)
    const sections = text.split(/\n\s*\n/);
    const groups = [];

    sections.forEach((section, idx) => {
        const links = extractUrlsFromText(section);
        if (links.length > 0) {
            groups.push({
                name: `Group ${idx + 1}`,
                // Preserve extracted title instead of overwriting with URL
                links: links.map(l => ({ url: l.url, title: l.title || l.url, context: l.context }))
            });
        }
    });

    return groups;
}

/**
 * Groups links by markdown heading markers (## Heading)
 * Returns array of { name: string, links: [{url, title}] }
 */
function groupByMarkdownHeadings(text) {
    if (!text || typeof text !== 'string') {
        return [];
    }

    const lines = text.split('\n');
    const groups = [];
    let currentGroup = null;
    let hasHeading = false;

    for (const line of lines) {
        const trimmed = line.trim();

        // Check for heading (## or # at start)
        const headingMatch = trimmed.match(/^#{1,6}\s+(.+)$/);
        if (headingMatch) {
            hasHeading = true;
            // Save previous group if it has links
            if (currentGroup && currentGroup.links.length > 0) {
                groups.push(currentGroup);
            }
            // Start new group
            currentGroup = {
                name: headingMatch[1].trim().substring(0, 100),
                links: []
            };
            continue;
        }

        // Skip empty lines and non-URL lines
        if (!trimmed) continue;

        // Check if line is a Markdown link [title](url) or raw URL
        const markdownMatch = trimmed.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)/);
        const urlMatch = trimmed.match(/^(https?:\/\/[^\s]+)/);

        if (markdownMatch || urlMatch) {
            const url = markdownMatch ? markdownMatch[2] : urlMatch[1];
            const title = markdownMatch ? markdownMatch[1].replace(/\\([\[\]()])/g, '$1') : url;

            // If no group yet, create default
            if (!currentGroup) {
                currentGroup = { name: 'Imported Links', links: [] };
            }
            currentGroup.links.push({
                url: url,
                title: title
            });
        }
    }

    // Push final group
    if (currentGroup && currentGroup.links.length > 0) {
        groups.push(currentGroup);
    }

    return hasHeading ? groups : [];
}

/**
 * Check if content looks like CSV format
 * Detects comma or tab-separated data with consistent column counts
 */
function isCsvContent(content) {
    if (!content || typeof content !== 'string') {
        return false;
    }

    const lines = content.trim().split('\n').filter(line => line.trim());
    if (lines.length < 2) {
        return false; // Need at least header + 1 data row
    }

    // Detect delimiter (comma or tab)
    const firstLine = lines[0];
    const hasCommas = firstLine.includes(',');
    const hasTabs = firstLine.includes('\t');

    if (!hasCommas && !hasTabs) {
        return false;
    }

    // Check for consistent column count across first few lines
    const delimiter = hasTabs ? '\t' : ',';
    const columnCounts = lines.slice(0, Math.min(5, lines.length)).map(line => {
        // Simple split - doesn't handle quoted fields with delimiters inside
        return line.split(delimiter).length;
    });

    const firstCount = columnCounts[0];
    if (firstCount < 2) {
        return false; // Need at least 2 columns
    }

    // Allow some variance but most lines should match
    const matchingLines = columnCounts.filter(c => c === firstCount).length;
    return matchingLines >= columnCounts.length * 0.8;
}

/**
 * Extract links from CSV content with automatic column detection
 * Groups by group/category/folder column if present
 */
function extractLinksFromCsv(content) {
    if (!content || typeof content !== 'string') {
        return [];
    }

    const lines = content.trim().split('\n').filter(line => line.trim());
    if (lines.length < 2) {
        return [];
    }

    // Detect delimiter
    const firstLine = lines[0];
    const delimiter = firstLine.includes('\t') ? '\t' : ',';

    // Parse CSV with basic handling of quoted fields
    function parseCSVLine(line) {
        const result = [];
        let current = '';
        let inQuotes = false;

        for (let i = 0; i < line.length; i++) {
            const char = line[i];

            if (char === '"') {
                if (inQuotes && line[i + 1] === '"') {
                    // Escaped quote
                    current += '"';
                    i++;
                } else {
                    inQuotes = !inQuotes;
                }
            } else if (char === delimiter && !inQuotes) {
                result.push(current.trim());
                current = '';
            } else {
                current += char;
            }
        }
        result.push(current.trim());
        return result;
    }

    // Parse header row
    const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase().replace(/['"]/g, ''));

    // Find URL column
    const urlColumnNames = ['url', 'link', 'href', 'address', 'website'];
    let urlColumnIndex = headers.findIndex(h => urlColumnNames.includes(h));

    // If no named URL column, find column containing URLs
    if (urlColumnIndex === -1) {
        // Check first data row for URL-like content
        if (lines.length > 1) {
            const firstDataRow = parseCSVLine(lines[1]);
            urlColumnIndex = firstDataRow.findIndex(cell =>
                /^https?:\/\//i.test(cell.replace(/['"]/g, ''))
            );
        }
    }

    if (urlColumnIndex === -1) {
        return []; // No URL column found
    }

    // Find title column
    const titleColumnNames = ['title', 'name', 'description', 'label', 'text'];
    let titleColumnIndex = headers.findIndex(h => titleColumnNames.includes(h));

    // Find group column
    const groupColumnNames = ['group', 'category', 'folder', 'tag', 'board', 'section', 'type'];
    let groupColumnIndex = headers.findIndex(h => groupColumnNames.includes(h));

    // Parse data rows
    const groupsMap = new Map(); // groupName -> links[]
    const defaultGroupName = 'Imported Links';

    for (let i = 1; i < lines.length; i++) {
        const row = parseCSVLine(lines[i]);

        // Get URL
        let url = row[urlColumnIndex]?.replace(/^['"]|['"]$/g, '').trim();
        if (!url || !url.match(/^https?:\/\//i)) {
            continue; // Skip rows without valid URLs
        }

        // Get title
        let title = titleColumnIndex !== -1
            ? row[titleColumnIndex]?.replace(/^['"]|['"]$/g, '').trim()
            : null;
        if (!title) {
            title = url;
        }

        // Get group name
        let groupName = groupColumnIndex !== -1
            ? row[groupColumnIndex]?.replace(/^['"]|['"]$/g, '').trim()
            : null;
        if (!groupName) {
            groupName = defaultGroupName;
        }

        // Add to group
        if (!groupsMap.has(groupName)) {
            groupsMap.set(groupName, []);
        }
        groupsMap.get(groupName).push({ url, title });
    }

    // Convert map to array format
    const groups = [];
    for (const [name, links] of groupsMap) {
        if (links.length > 0) {
            groups.push({ name: name.substring(0, 100), links });
        }
    }

    return groups;
}

/**
 * Check if content looks like JSON
 */
function isJsonContent(content) {
    const trimmed = content.trim();
    return (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']'));
}

/**
 * Extract URLs from parsed JSON object (recursively)
 * Returns unique URLs with associated titles if found
 */
function extractUrlsFromJson(content) {
    let parsed;
    try {
        parsed = JSON.parse(content);
    } catch (e) {
        console.warn('[Import Links] Invalid JSON, falling back to text extraction');
        return null; // Signal to use text extraction instead
    }

    const urlMap = new Map(); // url -> { url, title, context }

    function extractFromValue(value, parentKey = '') {
        if (typeof value === 'string') {
            // Check if this string is a URL
            if (/^https?:\/\//i.test(value)) {
                const normalizedUrl = normalizeUrlForDuplicateCheck(value);
                // Only add if not seen before (deduplication)
                if (!urlMap.has(normalizedUrl)) {
                    urlMap.set(normalizedUrl, {
                        url: value,
                        title: value, // Will try to find title from sibling keys
                        context: ''
                    });
                }
            }
        } else if (Array.isArray(value)) {
            value.forEach(item => extractFromValue(item, parentKey));
        } else if (value && typeof value === 'object') {
            // Look for URL fields and associated title fields
            const urlFields = ['url', 'href', 'link', 'uri', 'src'];
            const titleFields = ['title', 'name', 'label', 'text', 'description'];

            let foundUrl = null;
            let foundTitle = null;

            // First pass: find URL and title in this object
            for (const key of Object.keys(value)) {
                const lowerKey = key.toLowerCase();
                if (urlFields.includes(lowerKey) && typeof value[key] === 'string' && /^https?:\/\//i.test(value[key])) {
                    foundUrl = value[key];
                }
                if (titleFields.includes(lowerKey) && typeof value[key] === 'string') {
                    foundTitle = value[key];
                }
            }

            // If we found a URL, add it with its title
            if (foundUrl) {
                const normalizedUrl = normalizeUrlForDuplicateCheck(foundUrl);
                if (!urlMap.has(normalizedUrl)) {
                    urlMap.set(normalizedUrl, {
                        url: foundUrl,
                        title: foundTitle || foundUrl,
                        context: ''
                    });
                }
            }

            // Recursively extract from all values
            for (const key of Object.keys(value)) {
                extractFromValue(value[key], key);
            }
        }
    }

    extractFromValue(parsed);

    return Array.from(urlMap.values());
}

/**
 * Try to extract groups from JSON structure (folders, tags, windows, etc.)
 * Detects common bookmark export formats and preserves their grouping
 * Returns null if no recognizable structure found
 */
function extractGroupsFromJsonStructure(content) {
    // Size limit to prevent memory issues with very large files
    const MAX_JSON_SIZE = 10 * 1024 * 1024; // 10MB limit
    if (!content || content.length > MAX_JSON_SIZE) {
        console.warn('[Import] JSON content empty or too large');
        return null;
    }

    let parsed;
    try {
        parsed = JSON.parse(content);
    } catch (e) {
        return null;
    }

    const groups = [];

    // Dangerous prototype keys to sanitize
    const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

    // ========== Helper Functions for Flexible Field Extraction ==========

    // Helper to sanitize keys that could cause prototype pollution
    function sanitizeKey(key) {
        if (typeof key !== 'string') return String(key);
        return DANGEROUS_KEYS.has(key) ? `_${key}` : key;
    }

    // Helper to extract URL from any bookmark-like object
    function extractUrl(item) {
        if (!item || typeof item !== 'object') return null;
        const url = item.url || item.link || item.href || item.uri || item.address || item.resolved_url;
        // Ensure URL is a string
        return typeof url === 'string' ? url : null;
    }

    // Helper to extract title from any bookmark-like object
    function extractTitle(item, fallbackUrl) {
        if (!item || typeof item !== 'object') return fallbackUrl;
        const candidates = [item.title, item.name, item.label, item.text, item.resolved_title];
        for (const candidate of candidates) {
            if (typeof candidate === 'string' && candidate.trim() !== '') {
                return candidate;
            }
            // Convert numbers to strings
            if (typeof candidate === 'number') {
                return String(candidate);
            }
        }
        return fallbackUrl;
    }

    // Helper to extract children array from any container
    function extractChildrenArray(container) {
        if (!container || typeof container !== 'object') return null;
        const candidates = [container.children, container.bookmarks, container.links,
        container.items, container.urls, container.entries, container.tabs];
        for (const candidate of candidates) {
            if (Array.isArray(candidate)) {
                return candidate;
            }
        }
        return null;
    }

    // Helper to extract group name from any container
    function extractGroupName(container, fallback) {
        if (!container || typeof container !== 'object') return fallback;
        const candidates = [container.name, container.title, container.label, container.folder];
        for (const candidate of candidates) {
            if (typeof candidate === 'string' && candidate.trim() !== '') {
                return sanitizeKey(candidate);
            }
        }
        return fallback;
    }

    // Helper to extract tags array
    function extractTags(item) {
        if (!item || typeof item !== 'object') return null;
        const tags = item.tags || item.labels || item.keywords || item.categories;
        if (Array.isArray(tags)) {
            // Filter to only string tags
            return tags.filter(t => typeof t === 'string' && t.trim() !== '');
        }
        // Handle comma-separated string tags
        if (typeof tags === 'string' && tags.trim() !== '') {
            return tags.split(/[,;]/).map(t => t.trim()).filter(t => t !== '');
        }
        return null;
    }

    // Helper to add group with duplicate name merging
    function addGroup(name, links) {
        if (!name || !links || links.length === 0) return;
        const existing = groups.find(g => g.name === name);
        if (existing) {
            existing.links.push(...links);
        } else {
            groups.push({ name, links });
        }
    }

    // ========== Pattern 1: Browser bookmark export format ==========
    // { children: [{ title: "Folder", children: [{title, url}] }] }
    function extractFromChildren(node, parentName = null, depth = 0) {
        // Prevent stack overflow with depth limit
        if (!node || depth > 50) return;

        if (Array.isArray(node)) {
            node.forEach(item => extractFromChildren(item, parentName, depth + 1));
            return;
        }

        const children = extractChildrenArray(node);
        if (children && Array.isArray(children)) {
            const folderName = extractGroupName(node, parentName);
            const linksInFolder = [];
            const subfolders = [];

            for (const child of children) {
                const childUrl = extractUrl(child);
                if (childUrl) {
                    linksInFolder.push({ url: childUrl, title: extractTitle(child, childUrl) });
                } else if (extractChildrenArray(child)) {
                    subfolders.push(child);
                }
            }

            if (linksInFolder.length > 0 && folderName) {
                addGroup(folderName, linksInFolder);
            }

            subfolders.forEach(sf => extractFromChildren(sf, extractGroupName(sf, null), depth + 1));
        }
    }

    // ========== Pattern 2: Array with tags (Pocket/Pinboard style) ==========
    // [{ url, title, tags: ["work", "read-later"] }]
    function extractByTags(items) {
        if (!Array.isArray(items)) return;

        // Use Object.create(null) to prevent prototype pollution
        const tagGroups = Object.create(null);
        const untagged = [];

        for (const item of items) {
            const url = extractUrl(item);
            if (!url) continue;
            const link = { url, title: extractTitle(item, url) };

            const tags = extractTags(item);
            if (tags && tags.length > 0) {
                const tag = sanitizeKey(tags[0]); // Sanitize tag name
                if (!tagGroups[tag]) tagGroups[tag] = [];
                tagGroups[tag].push(link);
            } else {
                untagged.push(link);
            }
        }

        for (const tag of Object.keys(tagGroups)) {
            addGroup(tag, tagGroups[tag]);
        }
        if (untagged.length > 0) {
            addGroup('Untagged', untagged);
        }
    }

    // ========== Pattern 3: Session Buddy / Tab Session Manager format ==========
    // { windows: [{ tabs: [{url, title}] }] } or { sessions: [...] }
    function extractFromSessionBuddy(data) {
        const windows = data.windows || data.sessions;
        if (!Array.isArray(windows)) return false;

        for (let idx = 0; idx < windows.length; idx++) {
            const win = windows[idx];
            if (!win || typeof win !== 'object') continue;

            const tabs = extractChildrenArray(win);
            if (!Array.isArray(tabs)) continue;

            const links = [];
            for (const t of tabs) {
                const url = extractUrl(t);
                if (url && url.startsWith('http')) {
                    links.push({ url, title: extractTitle(t, url) });
                }
            }

            if (links.length > 0) {
                addGroup(extractGroupName(win, `Window ${idx + 1}`), links);
            }
        }

        return groups.length > 0;
    }

    // ========== Pattern 4: Boards/Groups/Collections array ==========
    // { boards: [{ name, bookmarks: [{title, url}] }] }
    // LumiList, Raindrop, Toby, Linkwarden, etc.
    function extractFromBoardsArray(data) {
        // Try all possible container keys
        const containerKeys = ['boards', 'groups', 'collections', 'folders', 'categories', 'lists'];
        let boardsArray = null;

        for (const key of containerKeys) {
            if (Array.isArray(data[key]) && data[key].length > 0) {
                boardsArray = data[key];
                break;
            }
        }

        if (!boardsArray) return false;

        for (const board of boardsArray) {
            if (!board || typeof board !== 'object') continue;

            const boardName = extractGroupName(board, null);
            if (!boardName) continue;

            const bookmarks = extractChildrenArray(board);
            if (!Array.isArray(bookmarks) || bookmarks.length === 0) continue;

            const links = [];
            for (const b of bookmarks) {
                const url = extractUrl(b);
                if (url) {
                    links.push({ url, title: extractTitle(b, url) });
                }
            }

            if (links.length > 0) {
                addGroup(boardName, links);
            }
        }

        return groups.length > 0;
    }

    // ========== Pattern 5: Flat array of bookmarks ==========
    // [{ url, title }, ...] - Pinboard, Pocket API, Instapaper
    function extractFromFlatArray(items) {
        if (!Array.isArray(items)) return false;

        const hasUrls = items.some(item => extractUrl(item));
        if (!hasUrls) return false;

        // Use Object.create(null) to prevent prototype pollution
        const tagGroups = Object.create(null);
        const untagged = [];

        for (const item of items) {
            const url = extractUrl(item);
            if (!url) continue;

            const link = { url, title: extractTitle(item, url) };
            const tags = extractTags(item);

            if (tags && tags.length > 0) {
                const tag = sanitizeKey(tags[0]); // Sanitize tag name
                if (!tagGroups[tag]) tagGroups[tag] = [];
                tagGroups[tag].push(link);
            } else {
                untagged.push(link);
            }
        }

        for (const tag of Object.keys(tagGroups)) {
            addGroup(tag, tagGroups[tag]);
        }
        if (untagged.length > 0) {
            addGroup('Imported', untagged);
        }

        return groups.length > 0;
    }

    // ========== Pattern 6: Chrome/Edge/Brave internal format ==========
    // { roots: { bookmark_bar: {children}, other: {children}, synced: {children} } }
    function extractFromChromeRoots(data) {
        if (!data.roots) return false;

        const rootKeys = ['bookmark_bar', 'other', 'synced', 'mobile'];
        for (const rootKey of rootKeys) {
            const root = data.roots[rootKey];
            if (root && extractChildrenArray(root)) {
                extractFromChildren(root, extractGroupName(root, rootKey.replace('_', ' ')));
            }
        }

        return groups.length > 0;
    }

    // ========== Pattern 7: Workspace/Container format (Arc, Workona) ==========
    // { containers/workspaces: [{ name, spaces/items/tabs }] }
    function extractFromWorkspaces(data) {
        const containers = data.containers || data.workspaces || data.profiles;
        if (!Array.isArray(containers)) return false;

        for (const container of containers) {
            if (!container || typeof container !== 'object') continue;

            const containerName = extractGroupName(container, 'Workspace');
            const items = extractChildrenArray(container) || container.spaces;

            if (Array.isArray(items)) {
                const links = [];
                for (const item of items) {
                    if (!item || typeof item !== 'object') continue;

                    const url = extractUrl(item);
                    if (url) {
                        links.push({ url, title: extractTitle(item, url) });
                    } else {
                        // Nested space - recursively extract
                        const nestedItems = extractChildrenArray(item);
                        if (Array.isArray(nestedItems)) {
                            for (const nested of nestedItems) {
                                const nestedUrl = extractUrl(nested);
                                if (nestedUrl) {
                                    links.push({ url: nestedUrl, title: extractTitle(nested, nestedUrl) });
                                }
                            }
                        }
                    }
                }
                if (links.length > 0) {
                    addGroup(containerName, links);
                }
            }
        }

        return groups.length > 0;
    }

    // ========== Fallback: Deep recursive search for URLs ==========
    // Searches any JSON structure for arrays containing URL-like objects
    function extractByDeepSearch(data, depth = 0, visited = new WeakSet()) {
        if (depth > 6) return false; // Prevent infinite recursion
        if (!data || typeof data !== 'object') return false;
        if (visited.has(data)) return false;
        visited.add(data);

        if (Array.isArray(data)) {
            const links = [];
            for (const item of data) {
                if (item && typeof item === 'object') {
                    const url = extractUrl(item);
                    if (url && url.startsWith('http')) {
                        links.push({ url, title: extractTitle(item, url) });
                    }
                }
            }
            if (links.length > 0) {
                addGroup('Imported', links);
                return true;
            }
        }

        if (!Array.isArray(data)) {
            for (const value of Object.values(data)) {
                if (value && typeof value === 'object') {
                    if (extractByDeepSearch(value, depth + 1, visited)) {
                        return true;
                    }
                }
            }
        }

        return false;
    }

    // ========== Pattern Detection - Try each in order of specificity ==========

    // Pattern 6: Chrome internal format (most specific)
    if (parsed.roots && (parsed.roots.bookmark_bar || parsed.roots.other)) {
        extractFromChromeRoots(parsed);
    }
    // Pattern 4: Boards/Groups/Collections
    else if (parsed.boards || parsed.groups || parsed.collections || parsed.folders || parsed.categories || parsed.lists) {
        extractFromBoardsArray(parsed);
    }
    // Pattern 7: Workspaces/Containers (Arc, Workona)
    else if (parsed.containers || parsed.workspaces || parsed.profiles) {
        extractFromWorkspaces(parsed);
    }
    // Pattern 3: Session Buddy format
    else if (parsed.windows || parsed.sessions) {
        extractFromSessionBuddy(parsed);
    }
    // Pattern 1: Browser bookmark tree (children)
    else if (parsed.children || (Array.isArray(parsed) && parsed.length > 0 && parsed[0]?.children)) {
        extractFromChildren(parsed);
    }
    // Array formats
    else if (Array.isArray(parsed) && parsed.length > 0) {
        const firstItem = parsed[0];
        // Pattern 2: Tag-based grouping
        if (extractTags(firstItem)) {
            extractByTags(parsed);
        }
        // Pattern 5: Flat array with URLs
        else if (extractUrl(firstItem)) {
            extractFromFlatArray(parsed);
        }
    }

    // Fallback: Deep search if nothing worked
    if (groups.length === 0) {
        extractByDeepSearch(parsed);
    }

    return groups.length > 0 ? groups : null;
}

// Import-link title resolution helpers for non-Papaly imports.
function isUrlLikeImportTitle(title, url) {
    const cleanTitle = typeof title === 'string' ? title.trim() : '';
    if (!cleanTitle) return true;

    if (/^(https?:\/\/|www\.)/i.test(cleanTitle)) {
        return true;
    }

    if (!/\s/.test(cleanTitle) && /^[a-z0-9.-]+\.[a-z]{2,}(?:\/|$)/i.test(cleanTitle)) {
        return true;
    }

    const rawUrl = typeof url === 'string' ? url.trim() : '';
    if (!rawUrl) return false;

    try {
        const parsedUrl = new URL(rawUrl);
        const titleLower = cleanTitle.toLowerCase();
        const normalizedTitle = titleLower
            .replace(/^https?:\/\//, '')
            .replace(/^www\./, '')
            .replace(/\/$/, '');

        const fullUrlNoProtocol = parsedUrl.href.toLowerCase()
            .replace(/^https?:\/\//, '')
            .replace(/^www\./, '')
            .replace(/\/$/, '');
        if (normalizedTitle === fullUrlNoProtocol) return true;

        const host = (parsedUrl.hostname || '').toLowerCase();
        const hostNoWww = host.replace(/^www\./, '');
        if (titleLower === host || titleLower === hostNoWww) return true;

        const hostWithPath = `${hostNoWww}${(parsedUrl.pathname || '').replace(/\/$/, '')}`.replace(/\/$/, '');
        if (hostWithPath && normalizedTitle === hostWithPath) return true;
    } catch (_) {
        return false;
    }

    return false;
}

function resolveImportedLinkTitle({ url, incomingTitle, fetchedTitle }) {
    const cleanFetchedTitle = typeof fetchedTitle === 'string' ? fetchedTitle.trim() : '';
    if (cleanFetchedTitle) {
        return cleanFetchedTitle;
    }

    const cleanIncomingTitle = typeof incomingTitle === 'string' ? incomingTitle.trim() : '';
    if (cleanIncomingTitle && !isUrlLikeImportTitle(cleanIncomingTitle, url)) {
        return cleanIncomingTitle;
    }

    const fallbackTitle = getFallbackTitleFromUrl(url);
    if (typeof fallbackTitle === 'string' && fallbackTitle.trim()) {
        return fallbackTitle.trim();
    }

    if (cleanIncomingTitle) return cleanIncomingTitle;
    if (typeof url === 'string' && url.trim()) return url.trim();
    return 'Untitled';
}

async function fetchTitlesForImportTargets(targets, options = {}) {
    const uniqueTargets = Array.isArray(targets)
        ? Array.from(new Set(targets.filter(url => typeof url === 'string' && url.trim())))
        : [];
    const totalTargets = uniqueTargets.length;
    const fetchedTitleByUrl = new Map();
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const shouldCancel = typeof options.shouldCancel === 'function'
        ? options.shouldCancel
        : () => false;

    if (totalTargets === 0) {
        if (onProgress) onProgress(0, 0);
        return fetchedTitleByUrl;
    }

    const concurrency = Math.max(1, Math.min(Number(options.concurrency) || 4, 12));
    let cursor = 0;
    let processedCount = 0;

    async function worker() {
        while (true) {
            if (shouldCancel()) break;
            const index = cursor++;
            if (index >= totalTargets) break;

            const targetUrl = uniqueTargets[index];
            try {
                const result = await fetchPageTitleFromBackground(targetUrl);
                const fetchedTitle = (result?.success && typeof result.title === 'string')
                    ? result.title.trim()
                    : '';
                if (fetchedTitle) {
                    fetchedTitleByUrl.set(targetUrl, fetchedTitle);
                }
            } catch (error) {
                console.warn('[Import Links] Failed to fetch title for URL:', targetUrl, error);
            } finally {
                processedCount++;
                if (onProgress) {
                    onProgress(processedCount, totalTargets, targetUrl);
                }
            }
        }
    }

    await Promise.all(
        Array.from({ length: Math.min(concurrency, totalTargets) }, () => worker())
    );

    return fetchedTitleByUrl;
}

function collectPreparedImportGroups(groups) {
    const preparedGroups = [];
    let totalUnsafe = 0;
    let totalPreparedLinks = 0;
    const importedInThisSession = new Set();

    for (const group of (Array.isArray(groups) ? groups : [])) {
        if (!group || !Array.isArray(group.links) || group.links.length === 0) continue;

        const preparedLinks = [];
        for (const link of group.links) {
            if (!link || typeof link.url !== 'string') {
                continue;
            }

            if (isUnsafeUrl(link.url)) {
                console.warn('[Import Links] Skipped unsafe URL:', link.url);
                totalUnsafe++;
                continue;
            }

            const safeUrl = sanitizeUrl(link.url);
            if (!safeUrl) {
                console.warn('[Import Links] Skipped invalid URL:', link.url);
                totalUnsafe++;
                continue;
            }

            const normalizedUrl = normalizeUrlForDuplicateCheck(safeUrl);
            if (importedInThisSession.has(normalizedUrl)) {
                continue;
            }
            importedInThisSession.add(normalizedUrl);

            preparedLinks.push({ ...link, url: safeUrl });
            totalPreparedLinks++;
        }

        if (preparedLinks.length === 0) continue;
        preparedGroups.push({
            ...group,
            links: preparedLinks
        });
    }

    return {
        preparedGroups,
        totalUnsafe,
        totalPreparedLinks
    };
}

function getImportTitleFetchTargets(preparedGroups, isPapalyImportForTitleFetch = false) {
    if (isPapalyImportForTitleFetch) return [];
    if (!Array.isArray(preparedGroups) || preparedGroups.length === 0) return [];

    const targets = [];
    const seenUrls = new Set();

    for (const group of preparedGroups) {
        if (!group || !Array.isArray(group.links)) continue;
        for (const link of group.links) {
            const url = (typeof link?.url === 'string') ? link.url : '';
            if (!url || seenUrls.has(url)) continue;
            seenUrls.add(url);
            targets.push(url);
        }
    }

    return targets;
}

function resolveImportedLinkRawDescription(link, isPapalyImport = false) {
    const explicitDescription = typeof link?.description === 'string'
        ? link.description.trim()
        : '';
    if (explicitDescription) {
        return explicitDescription;
    }

    if (isPapalyImport) {
        const papalyNote = typeof link?.context === 'string'
            ? link.context.trim()
            : '';
        if (papalyNote) {
            return papalyNote;
        }
    }

    return null;
}

/**
 * Open the Import Links modal
 */
const IMPORT_LINKS_CREATE_PAGE_VALUE = '__create_page__';
const IMPORT_LINKS_SYNC_CHUNK_SIZE = 250;
let _importLinksFileDetectionToken = 0;

async function populateImportLinksPageSelect(pageSelect, selectedPageId = currentPageId) {
    const pages = await db.pages.filter(p => !p.deletedAt).toArray();
    pages.sort((a, b) => a.order - b.order);

    const options = pages.map(p =>
        `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`
    ).join('');
    pageSelect.innerHTML = options + `<option value="${IMPORT_LINKS_CREATE_PAGE_VALUE}">➕ Create New Page</option>`;

    const selectedExists = selectedPageId && pages.some(p => p.id === selectedPageId);
    if (selectedExists) {
        pageSelect.value = selectedPageId;
    } else if (pages.length > 0) {
        pageSelect.value = pages[0].id;
    } else {
        pageSelect.value = IMPORT_LINKS_CREATE_PAGE_VALUE;
    }

    if (pageSelect.value !== IMPORT_LINKS_CREATE_PAGE_VALUE) {
        pageSelect.dataset.lastSelectedPageId = pageSelect.value;
    }
}

function resetImportLinksCreatePageUI() {
    const createRow = document.getElementById('importLinksCreatePageRow');
    const createInput = document.getElementById('importLinksCreatePageInput');
    if (createRow) createRow.style.display = 'none';
    if (createInput) createInput.value = '';
}

function setImportLinksPapalyFileUi(enabled, options = {}) {
    const papalySummary = document.getElementById('importLinksPapalySummary');
    const papalyCounts = document.getElementById('importLinksPapalyCounts');
    const papalyHint = document.getElementById('importLinksPapalyHint');
    const groupingRow = document.getElementById('importLinksGroupingRow');
    const targetLocationSection = document.getElementById('importLinksTargetLocationSection');
    const pageRow = document.getElementById('importLinksPageRow');
    const distributionRow = document.getElementById('importLinksDistributionRow');
    const placementRow = document.getElementById('importLinksPlacementRow');
    const createRow = document.getElementById('importLinksCreatePageRow');
    const columnRow = document.getElementById('importLinksColumnRow');

    if (enabled) {
        const pageCountRaw = Number(options.pageCount);
        const hasPageCount = Number.isFinite(pageCountRaw) && pageCountRaw >= 0;
        const pageCount = hasPageCount ? Math.floor(pageCountRaw) : 0;
        const boardCount = Number(options.boardCount) || 0;
        const linkCount = Number(options.linkCount) || 0;
        if (papalySummary) papalySummary.style.display = 'block';
        if (papalyCounts) {
            if (hasPageCount) {
                const pageLabel = pageCount === 1 ? 'page' : 'pages';
                papalyCounts.innerHTML = `<strong>${pageCount} ${pageLabel}</strong>, <strong>${boardCount} boards</strong> and <strong>${linkCount} links</strong> will be imported.`;
            } else {
                papalyCounts.innerHTML = `<strong>${boardCount} boards</strong> and <strong>${linkCount} links</strong> will be imported.`;
            }
        }
        if (papalyHint) {
            papalyHint.textContent = 'We\'ll create one LumiList page per Papaly board automatically.';
        }
        if (groupingRow) groupingRow.style.display = 'none';
        if (targetLocationSection) {
            targetLocationSection.style.display = 'none';
        } else {
            if (pageRow) pageRow.style.display = 'none';
            if (distributionRow) distributionRow.style.display = 'none';
            if (placementRow) placementRow.style.display = 'none';
        }
        if (createRow) createRow.style.display = 'none';
        if (columnRow) columnRow.style.display = 'none';
        return;
    }

    if (papalySummary) papalySummary.style.display = 'none';
    if (papalyCounts) papalyCounts.textContent = '';
    if (papalyHint) {
        papalyHint.textContent = 'We\'ll keep the same column placement and ordering from Papaly.';
    }
    if (groupingRow) groupingRow.style.display = 'block';
    if (targetLocationSection) {
        targetLocationSection.style.display = 'block';
    } else {
        if (pageRow) pageRow.style.display = 'block';
        if (distributionRow) distributionRow.style.display = 'flex';
        if (placementRow) placementRow.style.display = 'flex';
    }
}

async function detectPapalyExportFromImportFile(file) {
    const token = ++_importLinksFileDetectionToken;
    if (!file) {
        setImportLinksPapalyFileUi(false);
        return null;
    }

    const fileName = typeof file.name === 'string' ? file.name.toLowerCase() : '';
    const extension = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.')) : '';
    const isLikelyHtml = extension === '.html'
        || extension === '.htm'
        || (typeof file.type === 'string' && file.type.toLowerCase().includes('html'));
    if (!isLikelyHtml) {
        setImportLinksPapalyFileUi(false);
        return null;
    }

    try {
        const content = await file.text();
        if (token !== _importLinksFileDetectionToken) return null;

        const papalyPages = extractPapalyPagesFromHtml(content);
        if (!Array.isArray(papalyPages) || papalyPages.length === 0) {
            setImportLinksPapalyFileUi(false);
            return null;
        }

        const boardCount = papalyPages.reduce((sum, page) => sum + ((Array.isArray(page?.groups) ? page.groups.length : 0)), 0);
        const linkCount = papalyPages.reduce((sum, page) => {
            if (!Array.isArray(page?.groups)) return sum;
            return sum + page.groups.reduce((groupSum, group) => groupSum + ((Array.isArray(group?.links) ? group.links.length : 0)), 0);
        }, 0);

        setImportLinksPapalyFileUi(true, {
            pageCount: papalyPages.length,
            boardCount,
            linkCount
        });
        return papalyPages;
    } catch (error) {
        if (token === _importLinksFileDetectionToken) {
            console.warn('[Import Links] Failed to analyze selected file for Papaly layout:', error);
            setImportLinksPapalyFileUi(false);
        }
        return null;
    }
}

async function openImportLinksModal() {
    const modal = document.getElementById('importLinksModal');
    const textarea = document.getElementById('importLinksTextarea');
    const pageSelect = document.getElementById('importLinksPage');
    const fileInput = document.getElementById('importLinksFile');

    // Null check for required elements
    if (!modal || !textarea || !pageSelect) {
        console.error('[Import Links] Modal elements not found');
        return;
    }

    // Reset state
    _importLinksFileDetectionToken += 1;
    textarea.value = '';
    textarea.placeholder = 'Paste URLs, HTML, or any text containing links...';
    textarea.style.display = 'block';
    if (fileInput) fileInput.value = '';
    setImportLinksPapalyFileUi(false);

    // Reset file indicator visibility
    const fileIndicator = document.getElementById('importLinksFileIndicator');
    const uploadRow = document.getElementById('importLinksUploadRow');
    if (fileIndicator) fileIndicator.style.display = 'none';
    if (uploadRow) uploadRow.style.display = 'flex';

    // Reset grouping dropdown to default
    const groupingSelect = document.getElementById('importLinksGrouping');
    if (groupingSelect) groupingSelect.value = 'smart';

    // Reset distribution dropdown to default and hide column selector
    const distributionSelect = document.getElementById('importLinksDistribution');
    const columnRow = document.getElementById('importLinksColumnRow');
    if (distributionSelect) distributionSelect.value = 'left-to-right';
    if (columnRow) columnRow.style.display = 'none';

    // Reset placement checkbox to default (checked)
    const belowExistingCheckbox = document.getElementById('importLinksBelowExisting');
    if (belowExistingCheckbox) belowExistingCheckbox.checked = true;

    // Populate page dropdown
    await populateImportLinksPageSelect(pageSelect, currentPageId);
    resetImportLinksCreatePageUI();

    modal.classList.add('active');
    textarea.focus();

    _contextMenuImportMeta = null;
    _isContextMenuImportFlow = false;
}

/**
 * Close the Import Links modal
 */
function closeImportLinksModal(options = {}) {
    const modal = document.getElementById('importLinksModal');
    if (modal) {
        modal.classList.remove('active');
    }
    const shouldClearContextMeta = options.clearContextMeta !== false;
    if (shouldClearContextMeta) {
        _contextMenuImportMeta = null;
        _isContextMenuImportFlow = false;
    }
}

// Mutex flag to prevent concurrent imports
let _importLinksInProgress = false;
let _contextMenuImportMeta = null;
let _isContextMenuImportFlow = false;
let _activeImportLinksRun = null;

const IMPORT_LINKS_CANCELLED_ERROR_CODE = 'IMPORT_LINKS_CANCELLED';

function requestCancelActiveImportLinksRun() {
    if (!_activeImportLinksRun || !_activeImportLinksRun.canCancel || _activeImportLinksRun.cancelRequested) {
        return false;
    }

    _activeImportLinksRun.cancelRequested = true;
    updateImportLinksProgressModal('Importing links', 'Cancelling import...', 0, 0);
    setImportLinksProgressCancelable(false);
    return true;
}

// Maximum file size for import (10MB)
const IMPORT_LINKS_MAX_FILE_SIZE = 10 * 1024 * 1024;

// Allowed file extensions for import
const IMPORT_LINKS_ALLOWED_EXTENSIONS = ['.html', '.htm', '.json', '.csv', '.txt', '.md'];

/**
 * Handle the import action
 */
async function handleImportLinks() {
    // Race condition guard - prevent concurrent imports
    if (_importLinksInProgress) {

        return;
    }
    _importLinksInProgress = true;

    // Get button and lock action while import runs
    const importBtn = document.getElementById('confirmImportLinksBtn');
    const originalBtnText = importBtn ? importBtn.textContent : 'Import Links';
    if (importBtn) {
        importBtn.disabled = true;
    }
    let importProgressModalShown = false;
    let shouldReopenImportModal = false;
    const importRun = {
        cancelRequested: false,
        canCancel: false
    };
    const importMutationOps = [];
    let importMutationsCommitted = false;
    _activeImportLinksRun = importRun;

    try {
        // Check subscription status
        if (typeof canModify === 'function' && !canModify()) {
            showGlassToast('Upgrade to import links', 'warning');
            return;
        }

        const textarea = document.getElementById('importLinksTextarea');
        const fileInput = document.getElementById('importLinksFile');
        const pageSelect = document.getElementById('importLinksPage');
        const columnSelect = document.getElementById('importLinksColumn');
        const distributionSelect = document.getElementById('importLinksDistribution');
        const belowExistingCheckbox = document.getElementById('importLinksBelowExisting');

        // Null check for required elements
        if (!textarea || !pageSelect || !columnSelect) {
            console.error('[Import Links] Form elements not found');
            showGlassToast('Something went wrong', 'error');
            return;
        }

        const selectedPageId = pageSelect.value;
        const singleColumnIndex = parseInt(columnSelect.value, 10);
        const distribution = distributionSelect?.value || 'single'; // 'single' or 'left-to-right'
        const placeBelowExisting = belowExistingCheckbox?.checked !== false; // default true

        let content = textarea.value.trim();

        // Handle file upload (file takes priority)
        if (fileInput && fileInput.files.length > 0) {
            const file = fileInput.files[0];

            // File size validation
            if (file.size > IMPORT_LINKS_MAX_FILE_SIZE) {
                showGlassToast(`File too large. Maximum size is ${IMPORT_LINKS_MAX_FILE_SIZE / (1024 * 1024)}MB`, 'error');
                return;
            }

            // File type validation
            const fileExtension = '.' + file.name.split('.').pop().toLowerCase();
            if (!IMPORT_LINKS_ALLOWED_EXTENSIONS.includes(fileExtension)) {
                showGlassToast(`Unsupported file type. Allowed: ${IMPORT_LINKS_ALLOWED_EXTENSIONS.join(', ')}`, 'error');
                return;
            }

            try {
                content = await file.text();
            } catch (e) {
                console.error('[Import Links] Failed to read file:', e);
                showGlassToast('Failed to read file', 'error');
                return;
            }

            // Check for empty file
            if (!content.trim()) {
                showGlassToast('The uploaded file is empty', 'error');
                return;
            }
        }

        const contextMenuRawGroups = Array.isArray(_contextMenuImportMeta?.rawGroups)
            ? _contextMenuImportMeta.rawGroups
            : null;
        const useContextMenuRawGroups = !!(contextMenuRawGroups && contextMenuRawGroups.length > 0);
        const isContextMenuImportFlow = _isContextMenuImportFlow;

        if (!content && !useContextMenuRawGroups) {
            showGlassToast('Please paste or upload content', 'error');
            return;
        }

        // Get user's grouping preference
        const groupingStrategy = document.getElementById('importLinksGrouping')?.value || 'smart';

        let groups = [];
        let isPapalyImport = useContextMenuRawGroups;
        let papalyExportPages = null;
        if (useContextMenuRawGroups) {
            groups = contextMenuRawGroups.map(group => ({
                ...group,
                links: Array.isArray(group?.links)
                    ? group.links.map(link => ({ ...link }))
                    : []
            }));
        } else {
            // Detect content format
            const isHtml = content.includes('<a ') || content.includes('</a>') || content.includes('<A ');
            const isJson = isJsonContent(content);

            // Extract all links first (used by domain/single strategies)
            let extractedHtmlGroups = null;
            let allLinks = [];
            if (isHtml) {
                papalyExportPages = extractPapalyPagesFromHtml(content);
                if (papalyExportPages && papalyExportPages.length > 0) {
                    isPapalyImport = true;
                    extractedHtmlGroups = papalyExportPages.flatMap(page => (
                        Array.isArray(page?.groups) ? page.groups : []
                    ));
                    allLinks = extractedHtmlGroups.flatMap(group => group.links || []);
                } else {
                    extractedHtmlGroups = extractLinksFromHtml(content);
                    allLinks = extractedHtmlGroups.flatMap(g => g.links);
                    isPapalyImport = extractedHtmlGroups.some(group =>
                        Number.isFinite(group?.columnIndex) || Number.isFinite(group?.orderKey)
                    );
                }
            } else if (isJson) {
                allLinks = extractUrlsFromJson(content) || extractUrlsFromText(content);
            } else {
                allLinks = extractUrlsFromText(content);
            }

            // Apply selected grouping strategy
            switch (groupingStrategy) {
                case 'domain':
                    // Force domain grouping for all formats
                    groups = groupByDomain(allLinks);
                    break;
                case 'single':
                    // Put all links in one board
                    groups = [{
                        name: `Imported ${new Date().toLocaleDateString()}`,
                        links: allLinks
                    }];
                    break;
                case 'smart':
                default:
                    // Current auto-detection behavior
                    if (isHtml) {
                        groups = extractedHtmlGroups || [];
                    } else if (isJson) {
                        // Try to extract groups from JSON structure first (folders, tags, windows)
                        const structuredGroups = extractGroupsFromJsonStructure(content);
                        if (structuredGroups && structuredGroups.length > 0) {
                            groups = structuredGroups;
                        } else {
                            // No structure detected, fall back to domain grouping
                            const jsonLinks = extractUrlsFromJson(content);
                            groups = (jsonLinks && jsonLinks.length > 0)
                                ? groupByDomain(jsonLinks)
                                : groupByDomain(extractUrlsFromText(content));
                        }
                    } else {
                        // Plain text: try multiple strategies in order of specificity
                        // 1. First try markdown headings (## Heading format)
                        const headingGroups = groupByMarkdownHeadings(content);
                        if (headingGroups.length > 0) {
                            groups = headingGroups;
                        }
                        // 2. Try CSV parsing if content looks like CSV
                        else if (isCsvContent(content)) {
                            const csvGroups = extractLinksFromCsv(content);
                            if (csvGroups.length > 0) {
                                groups = csvGroups;
                            } else {
                                // CSV detected but no URLs found, fall back to domain grouping
                                groups = groupByDomain(extractUrlsFromText(content));
                            }
                        }
                        // 3. Try line break grouping (1+ blank line separates groups)
                        else {
                            const lineGroups = groupByLineBreaks(content);
                            groups = (lineGroups.length > 1)
                                ? lineGroups
                                : groupByDomain(extractUrlsFromText(content));
                        }
                    }
                    break;
            }
        }

        // Apply context-menu layout metadata when available
        if (_contextMenuImportMeta && Array.isArray(_contextMenuImportMeta.groups)) {
            const metaByName = new Map();
            _contextMenuImportMeta.groups.forEach(meta => {
                if (meta && typeof meta.name === 'string' && !metaByName.has(meta.name)) {
                    metaByName.set(meta.name, meta);
                }
            });

            groups = groups.map(group => {
                if (!group || typeof group.name !== 'string') return group;
                const meta = metaByName.get(group.name);
                if (!meta) return group;
                const columnIndex = Number.isFinite(group.columnIndex) ? group.columnIndex : meta.columnIndex;
                const orderKey = Number.isFinite(group.orderKey) ? group.orderKey : meta.orderKey;
                return { ...group, columnIndex, orderKey };
            });
        }

        const normalizeColumnIndex = (value) => {
            if (!Number.isFinite(value)) return null;
            const maxCols = 4;
            const normalized = ((Math.floor(value) % maxCols) + maxCols) % maxCols;
            return normalized;
        };

        const isPapalyMultiPageImport = Array.isArray(papalyExportPages) && papalyExportPages.length > 0;
        if (isPapalyMultiPageImport) {
            const preparedPapalyPages = [];
            let totalUnsafe = 0;
            let totalPreparedLinks = 0;
            let totalBoardsToImport = 0;

            for (const page of papalyExportPages) {
                if (!page || !Array.isArray(page.groups)) continue;
                const {
                    preparedGroups,
                    totalUnsafe: pageUnsafe,
                    totalPreparedLinks: pagePreparedLinks
                } = collectPreparedImportGroups(page.groups);

                totalUnsafe += pageUnsafe;
                if (preparedGroups.length === 0 || pagePreparedLinks === 0) continue;

                preparedPapalyPages.push({
                    name: sanitizePageName(page.name, 100),
                    groups: preparedGroups
                });
                totalBoardsToImport += preparedGroups.length;
                totalPreparedLinks += pagePreparedLinks;
            }

            const totalPagesToImport = preparedPapalyPages.length;
            if (totalPagesToImport === 0 || totalPreparedLinks === 0) {
                showGlassToast('No links found in content', 'error');
                return;
            }

            const pageLimitCheck = checkPageLimit(totalPagesToImport);
            if (!pageLimitCheck.allowed) {
                if (pageLimitCheck.remaining > 0) {
                    showGlassToast(`Can only import ${pageLimitCheck.remaining} of ${totalPagesToImport} pages. Delete some pages first.`, 'warning');
                } else {
                    showGlassToast(pageLimitCheck.warning, 'error');
                }
                return;
            }

            const boardLimitCheck = checkBoardLimit(totalBoardsToImport);
            if (!boardLimitCheck.allowed) {
                if (boardLimitCheck.remaining > 0) {
                    showGlassToast(`Can only import ${boardLimitCheck.remaining} of ${totalBoardsToImport} boards. Delete some boards first.`, 'warning');
                } else {
                    showGlassToast(boardLimitCheck.warning, 'error');
                }
                return;
            }

            const limitCheck = await checkBookmarkLimitForBulkImport(totalPreparedLinks);
            if (!limitCheck.allowed) {
                if (limitCheck.remaining > 0) {
                    showGlassToast(`Can only import ${limitCheck.remaining.toLocaleString()} of ${totalPreparedLinks.toLocaleString()} links. Delete bookmarks first.`, 'warning');
                } else {
                    showGlassToast(limitCheck.warning, 'error');
                }
                return;
            }

            closeImportLinksModal({ clearContextMeta: false });
            importProgressModalShown = showImportLinksProgressModal(
                'Importing Papaly export',
                `0 of ${totalPreparedLinks} links imported`
            );
            importRun.canCancel = true;
            if (importProgressModalShown) {
                setImportLinksProgressCancelable(true);
            }

            const existingPages = await db.pages.filter(page => !page.deletedAt).toArray();
            const existingPageNames = collectImportedNameRegistry(existingPages, sanitizePageName);

            const lastPage = await db.pages.orderBy('order').reverse().first();
            let nextPageOrder = Number.isFinite(lastPage?.order) ? (lastPage.order + 1) : 0;

            let totalImported = 0;
            let totalBoardsCreated = 0;
            let totalPagesCreated = 0;
            let firstImportedPageId = null;

            for (const page of preparedPapalyPages) {
                if (importRun.cancelRequested) {
                    const cancelError = new Error('Import cancelled by user');
                    cancelError.code = IMPORT_LINKS_CANCELLED_ERROR_CODE;
                    throw cancelError;
                }

                const uniquePageName = buildUniqueImportedPageName(page.name, existingPageNames);
                const pageId = await addPage({
                    name: uniquePageName,
                    order: nextPageOrder++
                }, { skipHistory: true });
                if (!pageId) {
                    throw new Error(`Failed to create imported page "${uniquePageName}".`);
                }

                if (!firstImportedPageId) firstImportedPageId = pageId;
                totalPagesCreated++;

                const createdPage = await db.pages.get(pageId);
                if (createdPage) {
                    importMutationOps.push({
                        table: 'pages',
                        id: createdPage.id,
                        before: null,
                        after: createdPage
                    });
                }

                const columnOrders = [0, 0, 0, 0];
                const importedBoardNames = new Set();
                const hasExplicitColumnsForPage = page.groups.some(group => Number.isFinite(group?.columnIndex));
                let groupIndex = 0;
                let boardSequence = 1;

                for (const group of page.groups) {
                    if (!group?.links || group.links.length === 0) continue;
                    if (importRun.cancelRequested) {
                        const cancelError = new Error('Import cancelled by user');
                        cancelError.code = IMPORT_LINKS_CANCELLED_ERROR_CODE;
                        throw cancelError;
                    }

                    const explicitColumn = normalizeColumnIndex(group.columnIndex);
                    const columnIndex = hasExplicitColumnsForPage && explicitColumn !== null
                        ? explicitColumn
                        : (distribution === 'left-to-right' ? groupIndex % 4 : singleColumnIndex);
                    const order = columnOrders[columnIndex]++;

                    const boardName = buildUniqueImportedBoardName(
                        normalizeImportHtmlText(group.name) || `Group ${boardSequence}`,
                        importedBoardNames
                    );
                    const boardId = await addBoard({
                        pageId,
                        name: boardName,
                        columnIndex,
                        order
                    }, { skipHistory: true });

                    groupIndex++;

                    if (!boardId) {
                        throw new Error(`Failed to create imported board "${boardName}".`);
                    }

                    boardSequence++;
                    totalBoardsCreated++;

                    const createdBoard = await db.boards.get(boardId);
                    if (createdBoard) {
                        importMutationOps.push({
                            table: 'boards',
                            id: createdBoard.id,
                            before: null,
                            after: createdBoard
                        });
                    }

                    const bookmarksData = group.links.map((link, idx) => ({
                        boardId,
                        title: sanitizeTitle(
                            ((typeof link?.title === 'string') ? link.title.trim() : '') || link.url,
                            500
                        ),
                        url: link.url,
                        description: sanitizeBookmarkNote(
                            resolveImportedLinkRawDescription(link, true)
                        ),
                        order: idx
                    }));

                    if (bookmarksData.length === 0) continue;

                    const addedIds = await bulkAddBookmarks(bookmarksData, {
                        skipHistory: true,
                        syncChunkSize: IMPORT_LINKS_SYNC_CHUNK_SIZE
                    });
                    totalImported += addedIds.length;

                    if (importProgressModalShown) {
                        updateImportLinksProgressModal(
                            'Importing Papaly export',
                            `${totalImported} of ${totalPreparedLinks} links imported`,
                            totalImported,
                            totalPreparedLinks
                        );
                    }

                    if (addedIds.length > 0) {
                        const createdBookmarks = (await db.bookmarks.bulkGet(addedIds)).filter(Boolean);
                        createdBookmarks.forEach(bookmark => {
                            importMutationOps.push({
                                table: 'bookmarks',
                                id: bookmark.id,
                                before: null,
                                after: bookmark
                            });
                        });
                    }
                }
            }

            importRun.canCancel = false;
            setImportLinksProgressCancelable(false);

            if (!isApplyingUndoRedoHistory && importMutationOps.length > 0) {
                await recordUndoRedoHistoryEntry({
                    kind: 'import_links_papaly_pages',
                    label: `Import ${totalImported} links into ${totalBoardsCreated} boards across ${totalPagesCreated} pages`,
                    ops: importMutationOps
                });
            }
            importMutationsCommitted = true;

            if (totalBoardsCreated > 0) {
                pageHasBoards = true;
                hideAddBoardPlaceholder();
            }

            // Rebuild tabs so newly created pages are visible immediately.
            await loadPagesNavigation();

            if (firstImportedPageId && firstImportedPageId !== currentPageId) {
                await switchToPage(firstImportedPageId);
            } else {
                await loadBoardsFromDatabase();
            }

            closeImportLinksModal();
            broadcastDataChange('importLinks');

            let message = `Imported ${totalImported} link${totalImported !== 1 ? 's' : ''} into ${totalBoardsCreated} board${totalBoardsCreated !== 1 ? 's' : ''} across ${totalPagesCreated} page${totalPagesCreated !== 1 ? 's' : ''}`;
            if (totalUnsafe > 0) {
                message += ` (${totalUnsafe} unsafe URL${totalUnsafe !== 1 ? 's' : ''} blocked)`;
            }
            showGlassToast(message, totalImported > 0 ? 'success' : 'info');
            return;
        }

        if (selectedPageId === IMPORT_LINKS_CREATE_PAGE_VALUE) {
            showGlassToast('Please select or create a page first', 'warning');
            return;
        }
        const pageId = selectedPageId;

        const hasExplicitColumns = groups.some(group => Number.isFinite(group?.columnIndex));
        if (hasExplicitColumns) {
            groups = groups.map((group, idx) => ({ ...group, _importIndex: idx }));
            groups.sort((a, b) => {
                const colA = Number.isFinite(a.columnIndex) ? a.columnIndex : 0;
                const colB = Number.isFinite(b.columnIndex) ? b.columnIndex : 0;
                if (colA !== colB) return colA - colB;
                const ordA = Number.isFinite(a.orderKey) ? a.orderKey : a._importIndex;
                const ordB = Number.isFinite(b.orderKey) ? b.orderKey : b._importIndex;
                if (ordA !== ordB) return ordA - ordB;
                return a._importIndex - b._importIndex;
            });
        }

        if (groups.length === 0 || groups.every(g => g.links.length === 0)) {
            showGlassToast('No links found in content', 'error');
            return;
        }

        const {
            preparedGroups,
            totalUnsafe,
            totalPreparedLinks
        } = collectPreparedImportGroups(groups);

        if (preparedGroups.length === 0 || totalPreparedLinks === 0) {
            showGlassToast('No links found in content', 'error');
            return;
        }

        // Use prepared counts (after dedupe + safety filtering) for accurate limit checks.
        const totalLinksToImport = totalPreparedLinks;
        const totalBoardsToImport = preparedGroups.length;

        // Check board limit BEFORE importing (each group becomes a board)
        const boardLimitCheck = checkBoardLimit(totalBoardsToImport);
        if (!boardLimitCheck.allowed) {
            console.warn('[Import Links] Board limit would be exceeded:', boardLimitCheck.warning);
            if (boardLimitCheck.remaining > 0) {
                showGlassToast(`Can only import ${boardLimitCheck.remaining} of ${totalBoardsToImport} groups. Use different grouping or delete boards first.`, 'warning');
            } else {
                showGlassToast(boardLimitCheck.warning, 'error');
            }
            return;
        }

        // Check bookmark limit BEFORE importing (fetch fresh server count for bulk operations)
        const limitCheck = await checkBookmarkLimitForBulkImport(totalLinksToImport);
        if (!limitCheck.allowed) {
            console.warn('[Import Links] Bookmark limit would be exceeded:', limitCheck.warning);
            // Offer partial import if some slots are available
            if (limitCheck.remaining > 0) {
                showGlassToast(`Can only import ${limitCheck.remaining.toLocaleString()} of ${totalLinksToImport.toLocaleString()} links. Reduce selection or delete bookmarks first.`, 'warning');
            } else {
                showGlassToast(limitCheck.warning, 'error');
            }
            return;
        }

        // Show pre-import warning if approaching limit
        if (limitCheck.warning) {

        }

        // Transition from import form modal to dedicated progress modal.
        closeImportLinksModal({ clearContextMeta: false });
        importProgressModalShown = showImportLinksProgressModal(
            'Importing links',
            `0 of ${totalPreparedLinks} links imported`
        );

        const titleFetchTargets = getImportTitleFetchTargets(preparedGroups, isPapalyImport);
        let fetchedTitleByUrl = new Map();

        if (titleFetchTargets.length > 0) {
            importRun.canCancel = true;
            if (importProgressModalShown) {
                setImportLinksProgressCancelable(true);
            }
            try {
                if (importProgressModalShown) {
                    updateImportLinksProgressModal(
                        'Importing links',
                        `0 of ${titleFetchTargets.length} links processed`,
                        0,
                        titleFetchTargets.length
                    );
                }
                fetchedTitleByUrl = await fetchTitlesForImportTargets(titleFetchTargets, {
                    concurrency: 4,
                    shouldCancel: () => importRun.cancelRequested,
                    onProgress: (processedCount, totalCount) => {
                        if (importProgressModalShown) {
                            updateImportLinksProgressModal(
                                'Importing links',
                                `${processedCount} of ${totalCount} links processed`,
                                processedCount,
                                totalCount
                            );
                        }
                    }
                });
            } catch (error) {
                console.warn('[Import Links] Title fetch pass failed. Falling back to inferred/imported titles.', error);
            }

            if (importRun.cancelRequested) {
                const cancelError = new Error('Import cancelled by user');
                cancelError.code = IMPORT_LINKS_CANCELLED_ERROR_CODE;
                throw cancelError;
            }
        }
        importRun.canCancel = false;
        setImportLinksProgressCancelable(false);

        let topPlacementWarningMessage = null;

        // Import groups as boards
        let totalImported = 0;
        let boardsCreated = 0;
        if (importProgressModalShown) {
            updateImportLinksProgressModal(
                'Importing links',
                `0 of ${totalPreparedLinks} links imported`,
                0,
                totalPreparedLinks
            );
        }

        const existingBoardsOnPage = await db.boards.filter(b =>
            b.pageId === pageId && !b.deletedAt
        ).toArray();
        const existingBoardNames = collectImportedNameRegistry(existingBoardsOnPage, sanitizeBoardName);

        // Calculate per-column order tracking and cache existing boards for later shifting
        const columnOrders = {};
        for (let col = 0; col < 4; col++) {
            const existingBoards = existingBoardsOnPage
                .filter(b => b.columnIndex === col)
                .sort((a, b) => (a.order || 0) - (b.order || 0));
            const importStartOrder = existingBoards.length > 0
                ? Math.max(...existingBoards.map(b => b.order || 0)) + 1
                : 0;

            columnOrders[col] = {
                // For "place at top", create imported boards below existing first.
                // A final atomic reorder pass moves them to the top or cleanly rolls back.
                nextOrder: importStartOrder,
                boardsCreated: 0,
                createdBoardIds: [],
                existingBoards
            };
        }

        let groupIndex = 0;
        let boardSequence = 1;
        for (const group of preparedGroups) {
            if (!group.links || group.links.length === 0) continue;

            // Determine column based on distribution method
            const explicitColumn = normalizeColumnIndex(group.columnIndex);
            const columnIndex = hasExplicitColumns && explicitColumn !== null
                ? explicitColumn
                : (distribution === 'left-to-right' ? groupIndex % 4 : singleColumnIndex);

            // Get order for this column and increment counters
            const order = columnOrders[columnIndex].nextOrder++;
            columnOrders[columnIndex].boardsCreated++;

            // Create board
            const rawGroupName = (group && typeof group.name === 'string') ? group.name.trim() : '';
            const shouldForceNewBoardName = isContextMenuImportFlow && !isPapalyImport;
            const baseBoardName = shouldForceNewBoardName ? 'New Board' : (rawGroupName || `Group ${boardSequence}`);
            const boardName = buildUniqueImportedBoardName(baseBoardName, existingBoardNames);
            const boardId = await addBoard({
                pageId,
                name: boardName,
                columnIndex,
                order
            }, { skipHistory: true });

            groupIndex++;

            if (!boardId) {
                throw new Error(`Failed to create imported board "${boardName}".`);
            }

            boardSequence++;
            boardsCreated++;
            columnOrders[columnIndex].createdBoardIds.push(boardId);
            const createdBoard = await db.boards.get(boardId);
            if (createdBoard) {
                importMutationOps.push({
                    table: 'boards',
                    id: createdBoard.id,
                    before: null,
                    after: createdBoard
                });
            }

            const bookmarksData = group.links.map((link, idx) => {
                const resolvedTitle = isPapalyImport
                    ? (((typeof link.title === 'string') ? link.title.trim() : '') || link.url)
                    : resolveImportedLinkTitle({
                        url: link.url,
                        incomingTitle: link.title,
                        fetchedTitle: fetchedTitleByUrl.get(link.url)
                    });

                return {
                    boardId,
                    title: sanitizeTitle(resolvedTitle, 500),
                    url: link.url,
                    description: sanitizeBookmarkNote(
                        resolveImportedLinkRawDescription(link, isPapalyImport)
                    ),
                    order: idx
                };
            });

            const addedIds = await bulkAddBookmarks(bookmarksData, {
                skipHistory: true,
                syncChunkSize: IMPORT_LINKS_SYNC_CHUNK_SIZE
            });
            totalImported += addedIds.length;
            if (importProgressModalShown) {
                updateImportLinksProgressModal(
                    'Importing links',
                    `${totalImported} of ${totalPreparedLinks} links imported`,
                    totalImported,
                    totalPreparedLinks
                );
            }

            if (addedIds.length > 0) {
                const createdBookmarks = (await db.bookmarks.bulkGet(addedIds)).filter(Boolean);
                createdBookmarks.forEach((bookmark) => {
                    importMutationOps.push({
                        table: 'bookmarks',
                        id: bookmark.id,
                        before: null,
                        after: bookmark
                    });
                });
            }
        }

        // If placing at top, perform one atomic reorder pass after all imports finish.
        if (!placeBelowExisting) {
            const reorderBoardIds = new Set();
            Object.values(columnOrders).forEach((columnState) => {
                columnState.existingBoards.forEach((board) => reorderBoardIds.add(board.id));
                columnState.createdBoardIds.forEach((boardId) => reorderBoardIds.add(boardId));
            });

            const reorderBeforeById = await collectUndoRedoSnapshotsByIds('boards', Array.from(reorderBoardIds));
            const reorderedBoardIds = new Set();
            const reorderTimestamp = getCurrentTimestamp();

            await db.transaction('rw', db.boards, async () => {
                for (let col = 0; col < 4; col++) {
                    const shiftAmount = columnOrders[col].createdBoardIds.length;
                    if (shiftAmount === 0) {
                        continue;
                    }

                    for (let index = 0; index < columnOrders[col].createdBoardIds.length; index++) {
                        const boardId = columnOrders[col].createdBoardIds[index];
                        const boardBefore = reorderBeforeById.get(boardId);
                        if (!boardBefore || boardBefore.order === index) {
                            continue;
                        }

                        await db.boards.update(boardId, {
                            order: index,
                            updatedAt: reorderTimestamp
                        });
                        reorderedBoardIds.add(boardId);
                    }

                    for (const board of columnOrders[col].existingBoards) {
                        const nextOrder = (board.order || 0) + shiftAmount;
                        const boardBefore = reorderBeforeById.get(board.id);
                        if (!boardBefore || boardBefore.order === nextOrder) {
                            continue;
                        }

                        await db.boards.update(board.id, {
                            order: nextOrder,
                            updatedAt: reorderTimestamp
                        });
                        reorderedBoardIds.add(board.id);
                    }
                }
            });

            if (reorderedBoardIds.size > 0) {
                const reorderAfterById = await collectUndoRedoSnapshotsByIds('boards', Array.from(reorderedBoardIds));
                const reorderBeforeChanged = new Map(
                    Array.from(reorderedBoardIds).map((boardId) => [boardId, reorderBeforeById.get(boardId) || null])
                );
                const reorderOps = buildUndoRedoOpsFromSnapshotMaps('boards', reorderBeforeChanged, reorderAfterById);
                const queueAttempt = await queueSyncItemsAtomically(
                    reorderOps
                        .filter(op => op.after)
                        .map(op => ({
                            op: 'upsert',
                            table: 'boards',
                            id: op.id,
                            data: op.after
                        })),
                    { contextLabel: 'importLinksTopPlacement' }
                );
                if (!queueAttempt.success) {
                    await rollbackLocalMutationOps(reorderOps);
                    topPlacementWarningMessage = 'Imported boards were kept below existing boards because top placement could not be synced.';
                    console.warn('[Import Links] Failed to sync top-placement board reorder. Keeping imported boards below existing boards.', queueAttempt.error);
                } else {
                    importMutationOps.push(...reorderOps);
                }
            }
        }

        if (!isApplyingUndoRedoHistory && importMutationOps.length > 0) {
            await recordUndoRedoHistoryEntry({
                kind: 'import_links',
                label: `Import ${totalImported} links into ${boardsCreated} boards`,
                ops: importMutationOps
            });
        }
        importMutationsCommitted = true;

        // IMPORTANT: Explicitly set pageHasBoards and hide placeholder before render
        pageHasBoards = true;
        hideAddBoardPlaceholder();

        // Switch to target page if different from current
        if (pageId !== currentPageId) {
            await switchToPage(pageId);
        } else {
            await loadBoardsFromDatabase();
        }

        closeImportLinksModal();
        broadcastDataChange('importLinks');

        // Show summary toast
        let message = `Imported ${totalImported} link${totalImported !== 1 ? 's' : ''} into ${boardsCreated} board${boardsCreated !== 1 ? 's' : ''}`;
        if (totalUnsafe > 0) {
            message += ` (${totalUnsafe} unsafe URL${totalUnsafe !== 1 ? 's' : ''} blocked)`;
        }
        if (topPlacementWarningMessage) {
            message += `. ${topPlacementWarningMessage}`;
        }
        showGlassToast(
            message,
            topPlacementWarningMessage
                ? 'warning'
                : (totalImported > 0 ? 'success' : 'info')
        );

    } catch (error) {
        const isCancelled = error?.code === IMPORT_LINKS_CANCELLED_ERROR_CODE;
        if (!importMutationsCommitted && importMutationOps.length > 0) {
            const rollbackResult = await rollbackImportMutationBatch(importMutationOps, {
                contextLabel: 'importLinksRollback'
            });
            if (!rollbackResult.success) {
                console.error('[Import Links] Failed to roll back partial import:', rollbackResult.error);
                showGlassToast('Import failed and partial changes could not be fully rolled back. Refresh to resync.', 'error');
                shouldReopenImportModal = false;
                return;
            } else {
                await loadPagesNavigation({ scrollToActive: false });
                await loadBoardsFromDatabase();
            }
        }

        if (isCancelled) {
            showGlassToast('Import cancelled', 'info');
        } else {
            console.error('[Import Links] Import error:', error);
            showGlassToast('Import failed. Please try again.', 'error');
        }

        if (importProgressModalShown) {
            shouldReopenImportModal = true;
        }
    } finally {
        if (importProgressModalShown) {
            hideImportLinksProgressModal();
        }
        if (shouldReopenImportModal) {
            const modal = document.getElementById('importLinksModal');
            if (modal) {
                modal.classList.add('active');
            }
        }
        _activeImportLinksRun = null;
        _importLinksInProgress = false;
        // Restore button state
        if (importBtn) {
            importBtn.disabled = false;
            importBtn.textContent = originalBtnText;
        }
    }
}

// Import Links modal event listeners (set up on DOMContentLoaded)
document.addEventListener('DOMContentLoaded', function () {
    // Confirm import button
    const confirmImportLinksBtn = document.getElementById('confirmImportLinksBtn');
    if (confirmImportLinksBtn) {
        confirmImportLinksBtn.addEventListener('click', handleImportLinks);
    }

    // Cancel button
    const cancelImportLinksBtn = document.getElementById('cancelImportLinksBtn');
    if (cancelImportLinksBtn) {
        cancelImportLinksBtn.addEventListener('click', closeImportLinksModal);
    }

    const cancelImportLinksProgressBtn = document.getElementById('cancelImportLinksProgressBtn');
    if (cancelImportLinksProgressBtn) {
        cancelImportLinksProgressBtn.addEventListener('click', requestCancelActiveImportLinksRun);
    }

    // Distribution toggle - show/hide column selector
    const distributionSelect = document.getElementById('importLinksDistribution');
    const columnRow = document.getElementById('importLinksColumnRow');
    if (distributionSelect && columnRow) {
        distributionSelect.addEventListener('change', () => {
            columnRow.style.display = distributionSelect.value === 'single' ? 'block' : 'none';
        });
    }

    // File input change - update placeholder to show selected file
    const importLinksFile = document.getElementById('importLinksFile');
    if (importLinksFile) {
        importLinksFile.addEventListener('change', async (e) => {
            const textarea = document.getElementById('importLinksTextarea');
            const fileIndicator = document.getElementById('importLinksFileIndicator');
            const fileName = document.getElementById('importLinksFileName');
            const uploadRow = document.getElementById('importLinksUploadRow');

            if (e.target.files.length > 0) {
                const file = e.target.files[0];
                // Show file indicator, hide textarea and upload row
                if (textarea) textarea.style.display = 'none';
                if (uploadRow) uploadRow.style.display = 'none';
                if (fileIndicator) {
                    fileIndicator.style.display = 'block';
                    if (fileName) fileName.textContent = file.name;
                }
                await detectPapalyExportFromImportFile(file);
            } else {
                _importLinksFileDetectionToken += 1;
                setImportLinksPapalyFileUi(false);
            }
        });
    }

    // Create new page from Import Links dropdown
    const importLinksPageSelect = document.getElementById('importLinksPage');
    const importLinksCreateRow = document.getElementById('importLinksCreatePageRow');
    const importLinksCreateInput = document.getElementById('importLinksCreatePageInput');
    const importLinksCreateBtn = document.getElementById('importLinksCreatePageBtn');
    const importLinksCancelCreateBtn = document.getElementById('importLinksCancelCreatePageBtn');
    let importLinksCreateInProgress = false;

    if (importLinksPageSelect) {
        importLinksPageSelect.addEventListener('change', () => {
            if (importLinksPageSelect.value === IMPORT_LINKS_CREATE_PAGE_VALUE) {
                if (importLinksCreateRow) importLinksCreateRow.style.display = 'flex';
                if (importLinksCreateInput) {
                    importLinksCreateInput.value = '';
                    importLinksCreateInput.focus();
                }
            } else {
                if (importLinksCreateRow) importLinksCreateRow.style.display = 'none';
                if (importLinksCreateInput) importLinksCreateInput.value = '';
                importLinksPageSelect.dataset.lastSelectedPageId = importLinksPageSelect.value;
            }
        });
    }

    if (importLinksCreateBtn) {
        importLinksCreateBtn.addEventListener('click', async () => {
            if (importLinksCreateInProgress) return;
            if (!importLinksCreateInput || !importLinksPageSelect) return;

            const name = importLinksCreateInput.value.trim();
            if (!name) {
                showGlassToast('Please enter a page name', 'warning');
                importLinksCreateInput.focus();
                return;
            }

            importLinksCreateInProgress = true;
            importLinksCreateBtn.disabled = true;

            try {
                const lastPage = await db.pages.orderBy('order').reverse().first();
                const nextOrder = lastPage ? lastPage.order + 1 : 0;
                const existingPages = await db.pages.filter(p => !p.deletedAt).toArray();
                const uniqueName = buildUniqueImportedPageName(
                    name,
                    collectImportedNameRegistry(existingPages, sanitizePageName)
                );
                const newPageId = await addPage({ name: uniqueName, order: nextOrder, isDefault: false });
                if (!newPageId) return;

                await populateImportLinksPageSelect(importLinksPageSelect, newPageId);
                resetImportLinksCreatePageUI();

                await loadPagesNavigation({ scrollToActive: false });
            } finally {
                importLinksCreateBtn.disabled = false;
                importLinksCreateInProgress = false;
            }
        });
    }

    if (importLinksCreateInput) {
        importLinksCreateInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && importLinksCreateBtn) {
                e.preventDefault();
                importLinksCreateBtn.click();
            }
        });
    }

    if (importLinksCancelCreateBtn) {
        importLinksCancelCreateBtn.addEventListener('click', () => {
            if (!importLinksPageSelect) return;
            const fallback = importLinksPageSelect.dataset.lastSelectedPageId;
            if (fallback && importLinksPageSelect.querySelector(`option[value="${fallback}"]`)) {
                importLinksPageSelect.value = fallback;
            } else {
                const firstOption = importLinksPageSelect.querySelector(`option:not([value="${IMPORT_LINKS_CREATE_PAGE_VALUE}"])`);
                if (firstOption) importLinksPageSelect.value = firstOption.value;
            }
            if (importLinksPageSelect.value !== IMPORT_LINKS_CREATE_PAGE_VALUE) {
                importLinksPageSelect.dataset.lastSelectedPageId = importLinksPageSelect.value;
            }
            resetImportLinksCreatePageUI();
        });
    }

    // Clear file button
    const clearImportFileBtn = document.getElementById('clearImportFileBtn');
    if (clearImportFileBtn) {
        clearImportFileBtn.addEventListener('click', () => {
            const textarea = document.getElementById('importLinksTextarea');
            const fileIndicator = document.getElementById('importLinksFileIndicator');
            const fileInput = document.getElementById('importLinksFile');
            const uploadRow = document.getElementById('importLinksUploadRow');

            // Reset file input
            if (fileInput) fileInput.value = '';
            _importLinksFileDetectionToken += 1;
            setImportLinksPapalyFileUi(false);

            // Show textarea and upload row, hide file indicator
            if (textarea) textarea.style.display = 'block';
            if (uploadRow) uploadRow.style.display = 'flex';
            if (fileIndicator) fileIndicator.style.display = 'none';
        });
    }

    // Close on overlay click (safe drag-outside handling)
    const importLinksModal = document.getElementById('importLinksModal');
    setupModalClickOutside(importLinksModal, closeImportLinksModal);

    // ============ FLOATING IMPORT BUTTON & POPUP ============

    const floatingImportBtn = document.getElementById('floatingImportBtn');
    const importPopup = document.getElementById('importPopup');
    const importChromeBookmarksPopupBtn = document.getElementById('importChromeBookmarksPopupBtn');
    const importLinksPopupBtn = document.getElementById('importLinksPopupBtn');
    const floatingWallpaperBtn = document.getElementById('floatingWallpaperBtn');
    const wallpaperPopup = document.getElementById('wallpaperPopup');
    const wallpaperThemeButtons = document.querySelectorAll('.wallpaper-theme-btn');
    const wallpaperGrid = document.getElementById('wallpaperGrid');
    const wallpaperContextMenu = document.getElementById('wallpaperContextMenu');
    const wallpaperUploadBtn = document.getElementById('wallpaperUploadBtn');
    const wallpaperUploadInput = document.getElementById('wallpaperUploadInput');
    const wallpaperGalleryLinkBtn = document.getElementById('wallpaperGalleryLinkBtn');
    const wallpaperStyleModal = document.getElementById('wallpaperStyleModal');
    const wallpaperStyleModalCancelBtn = document.getElementById('wallpaperStyleModalCancelBtn');
    const wallpaperStyleModalResetBtn = document.getElementById('wallpaperStyleModalResetBtn');
    const wallpaperStyleModalSaveBtn = document.getElementById('wallpaperStyleModalSaveBtn');

    // Toggle popup on button click
    if (floatingImportBtn && importPopup) {
        floatingImportBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (importPopup.classList.contains('active')) {
                closeImportPopup();
            } else {
                closeWallpaperPopup();
                openImportPopup();
            }
        });
    }

    // Chrome bookmarks import from popup
    if (importChromeBookmarksPopupBtn) {
        importChromeBookmarksPopupBtn.addEventListener('click', () => {
            closeImportPopup();
            showChromeImportModal();
        });
    }

    // Import links from popup
    if (importLinksPopupBtn) {
        importLinksPopupBtn.addEventListener('click', () => {
            closeImportPopup();
            openImportLinksModal();
        });
    }

    if (floatingWallpaperBtn && wallpaperPopup) {
        floatingWallpaperBtn.setAttribute('aria-haspopup', 'dialog');
        floatingWallpaperBtn.setAttribute('aria-expanded', 'false');
        floatingWallpaperBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (wallpaperPopup.classList.contains('active')) {
                closeWallpaperPopup();
            } else {
                closeImportPopup();
                openWallpaperPopup();
            }
        });
    }



    wallpaperThemeButtons.forEach(button => {
        button.addEventListener('click', handleWallpaperThemeButtonClick);
    });

    if (wallpaperGrid) {
        wallpaperGrid.addEventListener('click', (event) => {
            handleWallpaperTileClick(event).catch((error) => {
                console.error('Failed to update wallpaper selection:', error);
            });
        });
        wallpaperGrid.addEventListener('contextmenu', (event) => {
            handleWallpaperTileContextMenu(event).catch((error) => {
                console.error('Failed to open wallpaper context menu:', error);
            });
        });
        wallpaperGrid.addEventListener('scroll', () => {
            closeWallpaperContextMenu();
        }, { passive: true });
    }

    if (wallpaperContextMenu) {
        wallpaperContextMenu.addEventListener('click', (event) => {
            handleWallpaperContextMenuClick(event).catch((error) => {
                console.error('Failed to handle wallpaper context menu action:', error);
            });
        });
    }

    if (wallpaperUploadBtn && wallpaperUploadInput) {
        wallpaperUploadBtn.addEventListener('click', () => {
            handleWallpaperUploadButtonClick(wallpaperUploadInput).catch((error) => {
                console.error('Failed to start wallpaper upload:', error);
            });
        });
    }

    if (wallpaperUploadInput) {
        wallpaperUploadInput.addEventListener('change', (event) => {
            handleWallpaperUploadInputChange(event).catch((error) => {
                console.error('Failed to upload local wallpaper:', error);
            });
        });
    }

    if (wallpaperGalleryLinkBtn) {
        wallpaperGalleryLinkBtn.addEventListener('click', () => {
            closeWallpaperPopup({ restoreFocus: false });
            openWallpaperGallery();
        });
    }

    if (wallpaperStyleModal) {
        setupModalClickOutside(wallpaperStyleModal, () => {
            closeWallpaperStyleEditor();
        });
    }

    if (wallpaperStyleModalCancelBtn) {
        wallpaperStyleModalCancelBtn.addEventListener('click', () => {
            closeWallpaperStyleEditor();
        });
    }

    if (wallpaperStyleModalResetBtn) {
        wallpaperStyleModalResetBtn.addEventListener('click', () => {
            resetWallpaperStyleEditorDraft();
        });
    }

    if (wallpaperStyleModalSaveBtn) {
        wallpaperStyleModalSaveBtn.addEventListener('click', () => {
            saveWallpaperStyleEditorDraft().catch((error) => {
                console.error('Failed to save wallpaper style changes:', error);
            });
        });
    }

    // Close popup when clicking outside (safe drag-outside handling)
    let importPopupMouseDownOutside = false;
    let wallpaperPopupMouseDownOutside = false;
    document.addEventListener('mousedown', (e) => {
        if (importPopup && importPopup.classList.contains('active')) {
            importPopupMouseDownOutside = !importPopup.contains(e.target) && e.target !== floatingImportBtn;
        }
        if (wallpaperPopup && wallpaperPopup.classList.contains('active')) {
            const startedInsideWallpaperMenu = !!e.target.closest('.wallpaper-context-menu');
            const startedInsideWallpaperStyleModal = !!e.target.closest('#wallpaperStyleModal');
            wallpaperPopupMouseDownOutside = !wallpaperPopup.contains(e.target)
                && e.target !== floatingWallpaperBtn
                && !startedInsideWallpaperMenu
                && !startedInsideWallpaperStyleModal;
        }
    });
    document.addEventListener('mouseup', (e) => {
        if (importPopup && importPopup.classList.contains('active')) {
            const mouseUpOutside = !importPopup.contains(e.target) && e.target !== floatingImportBtn;
            if (importPopupMouseDownOutside && mouseUpOutside) {
                closeImportPopup();
            }
        }
        if (wallpaperPopup && wallpaperPopup.classList.contains('active')) {
            const endedInsideWallpaperMenu = !!e.target.closest('.wallpaper-context-menu');
            const endedInsideWallpaperStyleModal = !!e.target.closest('#wallpaperStyleModal');
            const mouseUpOutside = !wallpaperPopup.contains(e.target)
                && e.target !== floatingWallpaperBtn
                && !endedInsideWallpaperMenu
                && !endedInsideWallpaperStyleModal;
            if (wallpaperPopupMouseDownOutside && mouseUpOutside) {
                closeWallpaperPopup();
            }
        }
        importPopupMouseDownOutside = false;
        wallpaperPopupMouseDownOutside = false;
    });
    document.addEventListener('click', (event) => {
        if (!event.target.closest('.wallpaper-context-menu')) {
            closeWallpaperContextMenu();
        }
        if (!event.target.closest('.insights-popup') && !event.target.closest('.floating-insights-btn')) {
            closeInsightsPopup();
        }
    });

    initFloatingControlsDock();
});

let floatingControlsDockInitialized = false;

function getFloatingControlsDom() {
    return {
        rail: document.getElementById('floatingControlsRail'),
        toolsToggle: document.getElementById('floatingToolsToggle'),
        toolsMenu: document.getElementById('floatingToolsMenu'),
        searchBtn: document.getElementById('floatingSearchBtn'),
        settingsBtn: document.getElementById('floatingSettingsBtn'),
        importBtn: document.getElementById('floatingImportBtn'),
        importPopup: document.getElementById('importPopup'),
        wallpaperBtn: document.getElementById('floatingWallpaperBtn'),
        wallpaperPopup: document.getElementById('wallpaperPopup')
    };
}

function getFloatingControlsCollapsedEnabled() {
    return floatingControlsCollapsedEnabled === true;
}

function setFloatingControlsCollapsedEnabled(value) {
    floatingControlsCollapsedEnabled = value === true;
}

function isFloatingToolsDockOpen() {
    return !!document.getElementById('floatingControlsRail')?.classList.contains('tools-open');
}

function applyFloatingControlsCollapsedState() {
    if (typeof document === 'undefined') return;

    document.body.classList.toggle('floating-controls-collapsed', getFloatingControlsCollapsedEnabled());

    if (!getFloatingControlsCollapsedEnabled()) {
        closeFloatingToolsDock({ restoreFocus: false });
    }

    requestAnimationFrame(() => {
        repositionActiveFloatingPopups();
    });
}

function updateFloatingControlsCollapsedToggle() {
    const toggle = document.getElementById('floatingControlsCollapsedToggle');
    if (toggle) {
        toggle.checked = getFloatingControlsCollapsedEnabled();
    }
}

async function loadFloatingControlsCollapseSetting(prefetchedStorage = null) {
    try {
        const result = prefetchedStorage && typeof prefetchedStorage === 'object'
            ? prefetchedStorage
            : await chrome.storage.local.get(FLOATING_CONTROLS_COLLAPSED_STORAGE_KEY);
        setFloatingControlsCollapsedEnabled(result[FLOATING_CONTROLS_COLLAPSED_STORAGE_KEY] === true);
        applyFloatingControlsCollapsedState();
        updateFloatingControlsCollapsedToggle();
    } catch (error) {
        console.error('Error loading floating controls layout setting:', error);
        setFloatingControlsCollapsedEnabled(false);
        applyFloatingControlsCollapsedState();
        updateFloatingControlsCollapsedToggle();
    }
}

async function saveFloatingControlsCollapseSetting() {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
    await chrome.storage.local.set({
        [FLOATING_CONTROLS_COLLAPSED_STORAGE_KEY]: getFloatingControlsCollapsedEnabled()
    });
}

async function toggleFloatingControlsCollapseSetting() {
    const toggle = document.getElementById('floatingControlsCollapsedToggle');
    const previousValue = getFloatingControlsCollapsedEnabled();
    const nextValue = toggle?.checked === true;

    setFloatingControlsCollapsedEnabled(nextValue);
    applyFloatingControlsCollapsedState();
    updateFloatingControlsCollapsedToggle();

    try {
        await saveFloatingControlsCollapseSetting();
        return true;
    } catch (error) {
        console.error('Error saving floating controls layout setting:', error);
        setFloatingControlsCollapsedEnabled(previousValue);
        applyFloatingControlsCollapsedState();
        updateFloatingControlsCollapsedToggle();
        showGlassToast('Failed to save the floating tools layout. Please try again.', 'error');
        return false;
    }
}

function openFloatingToolsDock() {
    const { rail, toolsToggle } = getFloatingControlsDom();
    if (!rail || !toolsToggle || !getFloatingControlsCollapsedEnabled()) return;

    rail.classList.add('tools-open');
    toolsToggle.classList.add('active');
    toolsToggle.setAttribute('aria-expanded', 'true');
}

function closeFloatingToolsDock(options = {}) {
    const { restoreFocus = true } = options;
    const { rail, toolsToggle } = getFloatingControlsDom();
    if (!rail || !toolsToggle) return;

    const shouldRestoreFocus =
        restoreFocus &&
        rail.classList.contains('tools-open') &&
        typeof toolsToggle.focus === 'function' &&
        rail.contains(document.activeElement);

    rail.classList.remove('tools-open');
    toolsToggle.classList.remove('active');
    toolsToggle.setAttribute('aria-expanded', 'false');

    if (shouldRestoreFocus) {
        toolsToggle.focus({ preventScroll: true });
    }
}

function toggleFloatingToolsDock() {
    if (!getFloatingControlsCollapsedEnabled()) return;
    if (isFloatingToolsDockOpen()) {
        closeFloatingToolsDock();
    } else {
        openFloatingToolsDock();
    }
}

function positionFloatingPopupNearButton(popup, anchor) {
    if (!popup || !anchor) return;

    const popupRect = popup.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    const popupWidth = popupRect.width || popup.offsetWidth || 0;
    const popupHeight = popupRect.height || popup.offsetHeight || 0;

    if (!popupWidth || !popupHeight) return;

    const preferredLeft = anchorRect.left - popupWidth - FLOATING_CONTROL_POPUP_GAP_PX;
    const fallbackLeft = anchorRect.right + FLOATING_CONTROL_POPUP_GAP_PX;
    const maxLeft = window.innerWidth - popupWidth - FLOATING_CONTROL_POPUP_MARGIN_PX;
    const minLeft = FLOATING_CONTROL_POPUP_MARGIN_PX;
    const maxTop = window.innerHeight - popupHeight - FLOATING_CONTROL_POPUP_MARGIN_PX;
    const minTop = FLOATING_CONTROL_POPUP_MARGIN_PX;

    let left = preferredLeft;
    if (left < minLeft && fallbackLeft <= maxLeft) {
        left = fallbackLeft;
    }

    left = clampNumber(left, minLeft, Math.max(minLeft, maxLeft), minLeft);
    const centeredTop = anchorRect.top + (anchorRect.height / 2) - (popupHeight / 2);
    const top = clampNumber(centeredTop, minTop, Math.max(minTop, maxTop), minTop);

    popup.style.left = `${Math.round(left)}px`;
    popup.style.top = `${Math.round(top)}px`;
    popup.style.right = 'auto';
    popup.style.bottom = 'auto';
}

function repositionActiveFloatingPopups() {
    const { importBtn, importPopup, wallpaperBtn, wallpaperPopup } = getFloatingControlsDom();
    if (importPopup?.classList.contains('active') && importBtn) {
        positionFloatingPopupNearButton(importPopup, importBtn);
    }
    if (wallpaperPopup?.classList.contains('active') && wallpaperBtn) {
        positionFloatingPopupNearButton(wallpaperPopup, wallpaperBtn);
    }
}

function initFloatingControlsDock() {
    if (floatingControlsDockInitialized) return;
    floatingControlsDockInitialized = true;

    const {
        rail,
        toolsToggle,
        toolsMenu,
        importPopup,
        wallpaperPopup
    } = getFloatingControlsDom();

    const insightsBtn = document.getElementById('floatingInsightsBtn');
    const closeInsightsBtn = document.getElementById('closeInsightsBtn');

    if (insightsBtn) {
        insightsBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleInsightsPopup();
        });
    }

    if (closeInsightsBtn) {
        closeInsightsBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            closeInsightsPopup();
        });
    }

    const insightsPopup = document.getElementById('insightsPopup');
    if (insightsPopup) {
        insightsPopup.addEventListener('click', (e) => {
            e.stopPropagation();
        });
    }

    if (!rail || !toolsToggle || !toolsMenu) return;

    toolsToggle.addEventListener('click', (event) => {
        event.stopPropagation();
        toggleFloatingToolsDock();
    });

    document.addEventListener('mousedown', (event) => {
        if (!getFloatingControlsCollapsedEnabled() || !isFloatingToolsDockOpen()) return;

        const target = event.target;
        if (
            rail.contains(target) ||
            importPopup?.contains(target) ||
            wallpaperPopup?.contains(target)
        ) {
            return;
        }

        closeFloatingToolsDock({ restoreFocus: false });
    });

    window.addEventListener('resize', () => {
        repositionActiveFloatingPopups();
    });

    applyFloatingControlsCollapsedState();
}

function openImportPopup() {
    const { importBtn, importPopup } = getFloatingControlsDom();
    if (!importPopup || !importBtn) return;

    positionFloatingPopupNearButton(importPopup, importBtn);
    importPopup.classList.add('active');
    importBtn.classList.add('active');

    requestAnimationFrame(() => {
        if (importPopup.classList.contains('active')) {
            positionFloatingPopupNearButton(importPopup, importBtn);
        }
    });
}

/**
 * Close the import popup menu
 */
function closeImportPopup() {
    const { importPopup, importBtn } = getFloatingControlsDom();
    if (importPopup) {
        importPopup.classList.remove('active');
    }
    if (importBtn) {
        importBtn.classList.remove('active');
    }
}

function openWallpaperPopup() {
    const { wallpaperPopup, wallpaperBtn } = getFloatingControlsDom();
    closeWallpaperContextMenu();
    if (wallpaperPopup) {
        positionFloatingPopupNearButton(wallpaperPopup, wallpaperBtn);
        wallpaperPopup.classList.add('active');
        wallpaperPopup.setAttribute('aria-hidden', 'false');
        wallpaperPopup.removeAttribute('inert');
    }
    if (wallpaperBtn) {
        wallpaperBtn.classList.add('active');
        wallpaperBtn.setAttribute('aria-expanded', 'true');
    }
    renderWallpaperPopup();
    handleWallpaperPopupOpened().catch((error) => {
        console.error('Failed to update hosted wallpaper migration state:', error);
    });
    emitQuickTourEvent('wallpaper_opened');
    if (wallpaperPopup && typeof wallpaperPopup.focus === 'function') {
        requestAnimationFrame(() => {
            if (wallpaperPopup.classList.contains('active')) {
                positionFloatingPopupNearButton(wallpaperPopup, wallpaperBtn);
                wallpaperPopup.focus({ preventScroll: true });
            }
        });
    }
}

function closeWallpaperPopup(options = {}) {
    const { restoreFocus = true } = options;
    const { wallpaperPopup, wallpaperBtn } = getFloatingControlsDom();
    const activeElement = document.activeElement;
    const focusWasInsidePopup = !!(wallpaperPopup && activeElement && wallpaperPopup.contains(activeElement));

    if (focusWasInsidePopup) {
        if (restoreFocus && wallpaperBtn && typeof wallpaperBtn.focus === 'function') {
            wallpaperBtn.focus({ preventScroll: true });
        } else if (typeof activeElement.blur === 'function') {
            activeElement.blur();
        }
    }

    closeWallpaperContextMenu();
    closeWallpaperStyleEditor({
        restoreOriginalState: true,
        restoreFocus: false
    });

    if (wallpaperPopup) {
        wallpaperPopup.classList.remove('active');
        wallpaperPopup.setAttribute('aria-hidden', 'true');
        wallpaperPopup.setAttribute('inert', '');
    }
    if (wallpaperBtn) {
        wallpaperBtn.classList.remove('active');
        wallpaperBtn.setAttribute('aria-expanded', 'false');
    }

    // Clear targeted page ID when closing the popup
    window.wallpaperSelectionTargetPageId = null;
}

/*
============================================================
SHARE IMPORT FUNCTIONALITY
============================================================
Handle importing shared content from ?import= URL parameter
*/

// Flag to prevent double imports (race condition protection)
let _shareImportInProgress = false;

// Flag to prevent concurrent Chrome imports
let _chromeImportInProgress = false;

/**
 * Sanitize title for imported bookmarks
 * @param {string} title - The title to sanitize
 * @param {number} maxLength - Maximum length (default 500)
 * @returns {string} Sanitized title
 */
function sanitizeTitle(title, maxLength = 500) {
    if (!title || typeof title !== 'string') return 'Untitled';
    return title.trim().substring(0, maxLength) || 'Untitled';
}

/**
 * Sanitize bookmark note text
 * @param {string} note - Optional note text
 * @param {number} maxLength - Maximum length (default 2000)
 * @returns {string|null} Sanitized note or null when empty
 */
function sanitizeBookmarkNote(note, maxLength = BOOKMARK_DESCRIPTION_MAX_LENGTH) {
    if (typeof note !== 'string') return null;
    const trimmed = note.trim();
    if (!trimmed) return null;
    return trimmed.substring(0, maxLength);
}

/**
 * Sanitize board name for imported boards
 * @param {string} name - The board name to sanitize
 * @param {number} maxLength - Maximum length (default 200)
 * @returns {string} Sanitized board name
 */
function sanitizeBoardName(name, maxLength = 200) {
    if (!name || typeof name !== 'string') return 'Imported Board';
    return name.trim().substring(0, maxLength) || 'Imported Board';
}

function sanitizePageName(name, maxLength = 200) {
    if (!name || typeof name !== 'string') return 'Imported Page';
    return name.trim().substring(0, maxLength) || 'Imported Page';
}

function normalizeImportedNameKey(name) {
    if (typeof name !== 'string') return '';
    return name.trim().toLowerCase();
}

function collectImportedNameRegistry(records, sanitizeName) {
    const usedNames = new Set();
    if (!Array.isArray(records) || typeof sanitizeName !== 'function') {
        return usedNames;
    }

    for (const record of records) {
        const normalized = normalizeImportedNameKey(sanitizeName(record?.name));
        if (normalized) {
            usedNames.add(normalized);
        }
    }

    return usedNames;
}

function buildUniqueImportedName(baseName, existingLowerNames, sanitizeName = sanitizePageName) {
    const fallbackName = sanitizeName(baseName);
    const isSetLike = existingLowerNames
        && typeof existingLowerNames.has === 'function'
        && typeof existingLowerNames.add === 'function'
        && typeof existingLowerNames.clear === 'function';
    const usedNames = isSetLike ? existingLowerNames : new Set();

    if (isSetLike) {
        const normalizedNames = Array.from(existingLowerNames)
            .map(normalizeImportedNameKey)
            .filter(Boolean);
        usedNames.clear();
        normalizedNames.forEach(name => usedNames.add(name));
    }

    let candidate = fallbackName;
    let counter = 2;
    while (usedNames.has(normalizeImportedNameKey(candidate))) {
        candidate = `${fallbackName} (${counter})`;
        counter++;
    }

    usedNames.add(normalizeImportedNameKey(candidate));
    return candidate;
}

function buildUniqueImportedPageName(baseName, existingLowerNames) {
    return buildUniqueImportedName(baseName, existingLowerNames, sanitizePageName);
}

function buildUniqueImportedBoardName(baseName, existingLowerNames) {
    return buildUniqueImportedName(baseName, existingLowerNames, sanitizeBoardName);
}

function prepareShareImportBoards(rawBoards = []) {
    const preparedBoards = [];
    let skippedCount = 0;

    for (const board of rawBoards) {
        if (!board) continue;

        const preparedBookmarks = [];
        for (const bookmark of (board.bookmarks || [])) {
            if (isUnsafeUrl(bookmark?.url)) {
                skippedCount++;
                console.warn(`Skipped unsafe URL in share import: ${bookmark?.url}`);
                continue;
            }

            const safeUrl = sanitizeUrl(bookmark?.url);
            if (!safeUrl) {
                skippedCount++;
                console.warn(`Skipped invalid URL in share import: ${bookmark?.url}`);
                continue;
            }

            preparedBookmarks.push({
                title: sanitizeTitle(bookmark?.title || safeUrl),
                url: safeUrl,
                description: sanitizeBookmarkNote(bookmark?.description),
                order: preparedBookmarks.length
            });
        }

        if (preparedBookmarks.length === 0) {
            continue;
        }

        preparedBoards.push({
            ...board,
            bookmarks: preparedBookmarks
        });
    }

    return { preparedBoards, skippedCount };
}

/**
 * Fetch shared content from public API
 */
async function fetchShareData(shareId) {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);

        const response = await fetch(`${SUPABASE_FUNCTIONS_URL}/get-share?id=${shareId}`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            return { status: 'not_found' };
        }

        return await response.json();
    } catch (error) {
        if (error.name === 'AbortError') {
            console.error('Share fetch timed out');
            return { status: 'timeout' };
        }
        console.error('Error fetching share data:', error);
        return { status: 'not_found' };
    }
}

// Note: incrementImportCount removed - simplified sharing architecture doesn't track import counts

/**
 * Show import confirmation modal
 * Returns: { targetPageId } or null if cancelled
 */
async function showImportConfirmModal(shareData) {
    return new Promise(async (resolve) => {
        const modal = document.getElementById('importShareModal');
        const typeEl = document.getElementById('importShareType');
        const titleEl = document.getElementById('importShareTitle');
        const statsEl = document.getElementById('importShareStats');
        const pageSelectSection = document.getElementById('importSharePageSelectSection');
        const pageSelect = document.getElementById('importSharePageSelect');
        const pageInfoSection = document.getElementById('importSharePageInfo');
        const cancelBtn = document.getElementById('cancelImportShareBtn');
        const confirmBtn = document.getElementById('confirmImportShareBtn');

        // Set content
        const isPage = shareData.share.share_type === 'page';
        typeEl.textContent = isPage ? '📄 Shared Page' : '📋 Shared Board';
        titleEl.textContent = shareData.share.title;

        // Count total bookmarks
        const totalBookmarks = shareData.boards.reduce((sum, b) => sum + (b.bookmarks?.length || 0), 0);
        if (isPage) {
            statsEl.textContent = `${shareData.boards.length} boards, ${totalBookmarks} bookmarks`;
        } else {
            statsEl.textContent = `${totalBookmarks} bookmarks`;
        }

        // Show/hide page selection
        if (isPage) {
            pageSelectSection.style.display = 'none';
            pageInfoSection.style.display = 'block';
            confirmBtn.textContent = 'Import Page';
        } else {
            pageSelectSection.style.display = 'block';
            pageInfoSection.style.display = 'none';
            confirmBtn.textContent = 'Import Board';

            // Populate page dropdown
            const pages = await db.pages.filter(p => !p.deletedAt).toArray();
            pages.sort((a, b) => a.order - b.order);

            pageSelect.innerHTML = '';

            // Handle empty pages case
            if (pages.length === 0) {
                const option = document.createElement('option');
                option.value = '';
                option.textContent = 'No pages available';
                option.disabled = true;
                pageSelect.appendChild(option);
            } else {
                pages.forEach(page => {
                    const option = document.createElement('option');
                    option.value = page.id;
                    option.textContent = page.name;
                    // Select current page, or first page if currentPageId is null
                    if (page.id === currentPageId || (!currentPageId && pages.indexOf(page) === 0)) {
                        option.selected = true;
                    }
                    pageSelect.appendChild(option);
                });
            }
        }

        // Event handlers (defined before cleanup so cleanup can reference them)
        const handleCancelClick = () => {
            cleanup();
            modal.classList.remove('active');
            resolve(null);
        };

        const handleConfirmClick = () => {
            cleanup();
            modal.classList.remove('active');
            // Validate pageSelect.value (IDs are now UUIDs, not integers)
            const pageValue = pageSelect.value;
            const targetPageId = isPage ? null : (pageValue || null);
            if (!isPage && !targetPageId) {
                showGlassToast('Please select a valid page', 'error');
                resolve(null);
                return;
            }
            resolve({ targetPageId });
        };

        // Close on overlay click (safe drag-outside handling)
        let mouseDownOnOverlay = false;
        const handleOverlayMouseDown = (e) => {
            mouseDownOnOverlay = (e.target === modal);
        };
        const handleOverlayMouseUp = (e) => {
            if (mouseDownOnOverlay && e.target === modal) {
                handleCancelClick();
            }
            mouseDownOnOverlay = false;
        };

        // Close on Escape key
        const handleEscapeKey = (e) => {
            if (e.key === 'Escape') {
                handleCancelClick();
            }
        };

        // Cleanup function to remove all listeners
        let cleanedUp = false;
        const cleanup = () => {
            if (cleanedUp) return;
            cleanedUp = true;
            modal.removeEventListener('mousedown', handleOverlayMouseDown);
            modal.removeEventListener('mouseup', handleOverlayMouseUp);
            document.removeEventListener('keydown', handleEscapeKey);
            newCancelBtn.removeEventListener('click', handleCancelClick);
            newConfirmBtn.removeEventListener('click', handleConfirmClick);
        };

        // Clean up old listeners via cloneNode for buttons
        const newCancelBtn = cancelBtn.cloneNode(true);
        cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);
        const newConfirmBtn = confirmBtn.cloneNode(true);
        confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);

        // Add listeners
        newCancelBtn.addEventListener('click', handleCancelClick);
        newConfirmBtn.addEventListener('click', handleConfirmClick);
        modal.addEventListener('mousedown', handleOverlayMouseDown);
        modal.addEventListener('mouseup', handleOverlayMouseUp);
        document.addEventListener('keydown', handleEscapeKey);

        // Show modal
        modal.classList.add('active');
    });
}

/**
 * Handle share import from URL parameter
 * @param {string} shareId - The share UUID
 * @param {string|null} boardIndex - Optional board index for importing a single board from a page share
 */
async function handleShareImport(shareId, boardIndex = null) {
    // Race condition protection: prevent double imports
    if (_shareImportInProgress) {

        return;
    }
    _shareImportInProgress = true;
    const shareImportOps = [];
    let shareImportCommitted = false;

    // Clear URL immediately to prevent re-trigger on refresh
    window.history.replaceState({}, '', 'newtab.html');

    try {


        // Note: Loading overlay is already shown at DOMContentLoaded start (early import check)
        // We just need to hide it after fetch completes

        // Fetch share data
        const shareData = await fetchShareData(shareId);

        // Hide loading overlay after fetch
        hideLoadingOverlay();

        if (shareData.status !== 'active') {
            let message = 'This share is no longer available';
            if (shareData.status === 'disabled') {
                message = 'This share has been disabled by the owner';
            } else if (shareData.status === 'deleted') {
                message = 'This content has been removed';
            } else if (shareData.status === 'timeout') {
                message = 'Request timed out. Please try again.';
            }
            showGlassToast(message, 'error');
            return;
        }

        // Validate shareData structure
        if (!shareData.share || typeof shareData.share !== 'object' || !Array.isArray(shareData.boards)) {
            console.error('Invalid share data structure:', shareData);
            showGlassToast('Invalid share data received', 'error');
            return;
        }

        if (!shareData.share.share_type || !shareData.share.title) {
            console.error('Missing required share properties:', shareData.share);
            showGlassToast('Invalid share data received', 'error');
            return;
        }

        // Self-import detection - prevent users from importing their own shared content
        // This causes duplicates because they already have the content locally
        const ownPage = await db.pages.filter(p => p.shareId === shareId && !p.deletedAt).first();
        const ownBoard = await db.boards.filter(b => b.shareId === shareId && !b.deletedAt).first();
        if (ownPage || ownBoard) {
            const itemName = ownPage ? ownPage.name : ownBoard.name;

            showGlassToast('This is your own shared content - no need to import!', 'info');
            return;
        }

        // Check if user can modify (subscription status check)
        // Check this after self-import detection so we give a better message if it's their own content
        if (!canModify()) {
            showGlassToast('Cannot import content in read-only mode. Please renew your subscription.', 'warning');
            return;
        }

        // If boardIndex is provided, filter to just that board and treat as single board import
        // Create a working copy to avoid mutating original shareData
        let importData = {
            ...shareData,
            share: { ...shareData.share },
            boards: [...shareData.boards]
        };

        if (boardIndex !== null && shareData.share.share_type === 'page') {
            const index = parseInt(boardIndex, 10);
            if (!isNaN(index) && index >= 0 && index < shareData.boards.length) {
                // Filter to just the specified board
                const selectedBoard = shareData.boards[index];
                importData.boards = [selectedBoard];
                // Change share type to 'board' so modal shows page selector
                importData.share.share_type = 'board';
                // Update title to show board name
                importData.share.title = selectedBoard.name;

            } else {
                console.warn('Invalid boardIndex:', boardIndex);
                showGlassToast('Invalid board selection. Importing full page instead.', 'warning');
                // Continue with full page import (importData is unchanged)
            }
        }

        const { preparedBoards, skippedCount: shareSkippedCount } = prepareShareImportBoards(importData.boards);
        if (preparedBoards.length === 0) {
            showGlassToast('No valid bookmarks found in this shared content.', 'warning');
            return;
        }
        importData = {
            ...importData,
            boards: preparedBoards
        };

        // Calculate totals to import for limit checks after URL safety filtering
        const totalBookmarksToImport = importData.boards.reduce((sum, board) =>
            sum + (board.bookmarks?.length || 0), 0);
        const totalBoardsToImport = importData.boards.length;
        const isPageImport = importData.share.share_type === 'page';

        // Check page limit if importing a page
        if (isPageImport) {
            const pageLimitCheck = checkPageLimit(1);
            if (!pageLimitCheck.allowed) {
                console.warn('[Share Import] Page limit would be exceeded:', pageLimitCheck.warning);
                showGlassToast(pageLimitCheck.warning, 'error');
                return;
            }
        }

        // Check board limit BEFORE importing
        if (totalBoardsToImport > 0) {
            const boardLimitCheck = checkBoardLimit(totalBoardsToImport);
            if (!boardLimitCheck.allowed) {
                console.warn('[Share Import] Board limit would be exceeded:', boardLimitCheck.warning);
                showGlassToast(boardLimitCheck.warning, 'error');
                return;
            }
        }

        // Check bookmark limit BEFORE importing (fetch fresh server count for bulk operations)
        const limitCheck = await checkBookmarkLimitForBulkImport(totalBookmarksToImport);
        if (!limitCheck.allowed) {
            console.warn('[Share Import] Bookmark limit would be exceeded:', limitCheck.warning);
            showGlassToast(limitCheck.warning, 'error');
            return;
        }

        // Show confirmation modal
        const importOptions = await showImportConfirmModal(importData);
        if (!importOptions) {
            // User cancelled
            return;
        }

        showGlassToast('Importing...', 'info');

        let newPageId = null;  // Will be set if importing a page

        if (importData.share.share_type === 'page') {
            // Page import - creates new page with all boards
            const existingPages = await db.pages.filter(p => !p.deletedAt).toArray();
            const uniqueName = buildUniqueImportedPageName(
                importData.share.title,
                collectImportedNameRegistry(existingPages, sanitizePageName)
            );

            // Calculate the next order value (same as createNewPage())
            const lastPage = await db.pages.orderBy('order').reverse().first();
            const nextPageOrder = lastPage ? lastPage.order + 1 : 0;

            newPageId = await addPage({ name: uniqueName, order: nextPageOrder }, { skipHistory: true });
            if (!newPageId) {
                throw new Error('Failed to create imported page.');
            }
            const createdPage = await db.pages.get(newPageId);
            if (createdPage) {
                shareImportOps.push({
                    table: 'pages',
                    id: createdPage.id,
                    before: null,
                    after: createdPage
                });
            }
            const importedBoardNames = new Set();

            for (const board of importData.boards) {
                const newBoardId = await addBoard({
                    pageId: newPageId,
                    name: buildUniqueImportedBoardName(board.name, importedBoardNames),
                    columnIndex: Math.max(0, Math.min(3, parseInt(board.column_index, 10) || 0)),
                    order: board.order || 0
                }, { skipHistory: true });
                if (!newBoardId) {
                    throw new Error(`Failed to create imported board "${board.name || 'Untitled'}".`);
                }
                const createdBoard = await db.boards.get(newBoardId);
                if (createdBoard) {
                    shareImportOps.push({
                        table: 'boards',
                        id: createdBoard.id,
                        before: null,
                        after: createdBoard
                    });
                }

                for (const bookmark of (board.bookmarks || [])) {
                    const bookmarkId = await addBookmark({
                        boardId: newBoardId,
                        title: bookmark.title,
                        url: bookmark.url,
                        description: bookmark.description,
                        order: bookmark.order || 0
                    }, { skipHistory: true });
                    if (!bookmarkId) {
                        throw new Error(`Failed to import a bookmark into "${board.name || 'Untitled'}".`);
                    }
                    const createdBookmark = await db.bookmarks.get(bookmarkId);
                    if (createdBookmark) {
                        shareImportOps.push({
                            table: 'bookmarks',
                            id: createdBookmark.id,
                            before: null,
                            after: createdBookmark
                        });
                    }
                }
            }

            // Note: switchToPage() is called after loadPagesNavigation() below
            // so the page tab exists in the DOM before we try to mark it active

        } else {
            // Single board import to selected page
            const targetPageId = importOptions.targetPageId;
            const boardData = importData.boards[0];

            const existingBoards = await db.boards.filter(b => b.pageId === targetPageId && !b.deletedAt).toArray();
            const uniqueBoardName = buildUniqueImportedBoardName(
                boardData.name,
                collectImportedNameRegistry(existingBoards, sanitizeBoardName)
            );

            // Shift existing boards in column 0 down to make room at top
            const column0Boards = existingBoards.filter(b => b.columnIndex === 0);
            for (const board of column0Boards) {
                const updateResult = await updateBoard(board.id, { order: (board.order || 0) + 1 }, { skipHistory: true });
                if (updateResult <= 0) {
                    throw new Error(`Failed to shift board "${board.name || 'Untitled'}" before import.`);
                }
                const updatedBoard = await db.boards.get(board.id);
                if (updatedBoard) {
                    shareImportOps.push({
                        table: 'boards',
                        id: updatedBoard.id,
                        before: board,
                        after: updatedBoard
                    });
                }
            }

            // Add imported board at top of first column (order: 0)
            const newBoardId = await addBoard({
                pageId: targetPageId,
                name: uniqueBoardName,
                columnIndex: 0,
                order: 0
            }, { skipHistory: true });
            if (!newBoardId) {
                throw new Error(`Failed to create imported board "${uniqueBoardName}".`);
            }
            const createdBoard = await db.boards.get(newBoardId);
            if (createdBoard) {
                shareImportOps.push({
                    table: 'boards',
                    id: createdBoard.id,
                    before: null,
                    after: createdBoard
                });
            }

            for (const bookmark of (boardData.bookmarks || [])) {
                const bookmarkId = await addBookmark({
                    boardId: newBoardId,
                    title: bookmark.title,
                    url: bookmark.url,
                    description: bookmark.description,
                    order: bookmark.order || 0
                }, { skipHistory: true });
                if (!bookmarkId) {
                    throw new Error(`Failed to import a bookmark into "${uniqueBoardName}".`);
                }
                const createdBookmark = await db.bookmarks.get(bookmarkId);
                if (createdBookmark) {
                    shareImportOps.push({
                        table: 'bookmarks',
                        id: createdBookmark.id,
                        before: null,
                        after: createdBookmark
                    });
                }
            }

            // Note: switchToPage() is called after loadPagesNavigation() below
        }

        if (!isApplyingUndoRedoHistory && shareImportOps.length > 0) {
            await recordUndoRedoHistoryEntry({
                kind: importData.share.share_type === 'page' ? 'share_import_page' : 'share_import_board',
                label: importData.share.share_type === 'page'
                    ? `Import shared page "${importData.share.title}"`
                    : `Import shared board "${importData.share.title}"`,
                ops: shareImportOps
            });
        }
        shareImportCommitted = true;

        // Determine which page to switch to after import
        const switchToPageId = importOptions.importType === 'page' ? newPageId :
            (importOptions.targetPageId !== currentPageId ? importOptions.targetPageId : null);

        await loadPagesNavigation();  // Rebuild page tabs to show new imported page

        // Switch to the appropriate page AFTER tabs are rendered
        if (switchToPageId) {
            await switchToPage(switchToPageId);
        }
        let successMessage = 'Imported successfully!';
        if (shareSkippedCount > 0) {
            successMessage += ` (${shareSkippedCount} invalid or unsafe link${shareSkippedCount !== 1 ? 's' : ''} skipped)`;
        }
        showGlassToast(successMessage, 'success');
        // IMPORTANT: Explicitly set pageHasBoards and hide placeholder before render
        // Prevents race condition where placeholder could still be clickable during render
        pageHasBoards = true;
        hideAddBoardPlaceholder();
        await loadBoardsFromDatabase();

    } catch (error) {
        console.error('Import error:', error);
        if (!shareImportCommitted && shareImportOps.length > 0) {
            const rollbackResult = await rollbackImportMutationBatch(shareImportOps, {
                contextLabel: 'handleShareImportRollback'
            });
            if (!rollbackResult.success) {
                console.error('Failed to roll back partial share import:', rollbackResult.error);
                showGlassToast('Import failed and partial changes could not be fully rolled back. Refresh to resync.', 'error');
                _shareImportInProgress = false;
                return;
            }
            await loadPagesNavigation({ scrollToActive: false });
            await loadBoardsFromDatabase();
        }
        showGlassToast('Import failed. Please try again.', 'error');
    } finally {
        _shareImportInProgress = false;
    }
}

/**
 * Check for import parameter on page load
 */
function checkForShareImport() {
    const urlParams = new URLSearchParams(window.location.search);
    const importShareId = urlParams.get('import');
    const boardIndex = urlParams.get('boardIndex');

    if (importShareId) {


        // Note: Loading overlay is already shown at DOMContentLoaded start (early import check)
        // No need to show it again here

        // Wait a bit for the page to fully load, then handle import with proper error handling
        setTimeout(async () => {
            try {
                await handleShareImport(importShareId, boardIndex);
            } catch (error) {
                console.error('Share import failed:', error);
                hideLoadingOverlay();
                showGlassToast('Import failed. Please try again.', 'error');
                window.history.replaceState({}, '', 'newtab.html');
            }
        }, 500);
    }
}

// Check for import parameter after DOM loads
document.addEventListener('DOMContentLoaded', function () {
    // Delay to allow other init to complete
    setTimeout(checkForShareImport, 1000);
    // Check for context menu import after share import check
    setTimeout(checkForContextMenuImport, 1200);
});

/**
 * Check for context menu import parameter on page load
 * Triggered when user right-clicks "Save All Links to LumiList"
 */
async function checkForContextMenuImport() {
    const urlParams = new URLSearchParams(window.location.search);
    const isContextMenuImport = urlParams.get('contextMenuImport');

    if (!isContextMenuImport) return;

    updateLoadingMessage('Preparing import...', 'Please wait while we load links');
    const loadingOverlay = document.getElementById('loadingOverlay');
    if (loadingOverlay) {
        loadingOverlay.style.display = '';
        loadingOverlay.classList.remove('hidden');
    }


    // Clean URL immediately to prevent re-trigger on refresh
    window.history.replaceState({}, '', 'newtab.html');

    try {
        // Get import data from storage
        const { contextMenuImportData } = await chrome.storage.local.get('contextMenuImportData');

        if (!contextMenuImportData) {

            showGlassToast('Import data not found. Please try again.', 'error');
            hideLoadingOverlay();
            return;
        }

        // Check staleness (5 minute max)
        const MAX_STALENESS_MS = 5 * 60 * 1000;
        if (Date.now() - contextMenuImportData.timestamp > MAX_STALENESS_MS) {

            await chrome.storage.local.remove('contextMenuImportData');
            showGlassToast('Import data expired. Please try again.', 'error');
            hideLoadingOverlay();
            return;
        }

        // Remove temp data
        await chrome.storage.local.remove('contextMenuImportData');

        // Open import modal with the data
        await openImportLinksModalWithData(contextMenuImportData);
        hideLoadingOverlay();

    } catch (error) {
        console.error('[ContextMenuImport] Error:', error);
        showGlassToast('Failed to load import data', 'error');
        hideLoadingOverlay();
    }
}

/**
 * Open the Import Links modal with pre-filled data from context menu
 * @param {Object} importData - Data from context menu extraction
 * @param {Array} importData.links - Array of {url, title, heading} objects
 * @param {string} importData.sourceUrl - URL of the source page
 * @param {string} importData.sourceTitle - Title of the source page
 */
async function openImportLinksModalWithData(importData) {
    const modal = document.getElementById('importLinksModal');
    const textarea = document.getElementById('importLinksTextarea');
    const pageSelect = document.getElementById('importLinksPage');
    const groupingSelect = document.getElementById('importLinksGrouping');
    const fileInput = document.getElementById('importLinksFile');

    if (!modal || !textarea || !pageSelect) {
        console.error('[ContextMenuImport] Modal elements not found');
        showGlassToast('Failed to open import modal', 'error');
        return;
    }
    _isContextMenuImportFlow = true;
    _importLinksFileDetectionToken += 1;
    setImportLinksPapalyFileUi(false);

    // Reset file input and indicators
    if (fileInput) fileInput.value = '';
    const fileIndicator = document.getElementById('importLinksFileIndicator');
    const uploadRow = document.getElementById('importLinksUploadRow');
    if (fileIndicator) fileIndicator.style.display = 'none';
    if (uploadRow) uploadRow.style.display = 'flex';

    const preGrouped = Array.isArray(importData.groups) && importData.groups.length > 0;
    let finalGroups = [];
    let links = [];

    if (preGrouped) {
        finalGroups = importData.groups.map(group => ({
            name: (group.name || 'Imported Links').trim(),
            links: Array.isArray(group.links) ? group.links : [],
            columnIndex: Number.isFinite(group.columnIndex) ? group.columnIndex : group.columnIndex,
            orderKey: Number.isFinite(group.orderKey) ? group.orderKey : group.orderKey
        }));
        links = finalGroups.flatMap(group => group.links || []);
    } else {
        // Group links by containerId for proximity-based grouping
        links = importData.links || [];
        const groupedByContainer = new Map();

        links.forEach(link => {
            const containerId = link.containerId || 0;
            if (!groupedByContainer.has(containerId)) {
                groupedByContainer.set(containerId, {
                    heading: link.heading || null,
                    links: []
                });
            }
            groupedByContainer.get(containerId).links.push(link);
            // Use first heading found in group
            if (link.heading && !groupedByContainer.get(containerId).heading) {
                groupedByContainer.set(containerId, {
                    ...groupedByContainer.get(containerId),
                    heading: link.heading
                });
            }
        });

        // Consolidate single-link groups into "Other Links"
        const otherLinks = [];

        groupedByContainer.forEach(group => {
            if (group.links.length === 1) {
                otherLinks.push(group.links[0]);
            } else {
                finalGroups.push({
                    name: group.heading || null,
                    links: group.links
                });
            }
        });

        if (otherLinks.length > 0) {
            finalGroups.push({
                name: 'Other Links',
                links: otherLinks
            });
        }
    }

    const hasLayoutMeta = finalGroups.some(group =>
        Number.isFinite(group.columnIndex) || Number.isFinite(group.orderKey)
    );
    if (hasLayoutMeta) {
        finalGroups.sort((a, b) => {
            const colA = Number.isFinite(a.columnIndex) ? a.columnIndex : 0;
            const colB = Number.isFinite(b.columnIndex) ? b.columnIndex : 0;
            if (colA !== colB) return colA - colB;
            const ordA = Number.isFinite(a.orderKey) ? a.orderKey : 0;
            const ordB = Number.isFinite(b.orderKey) ? b.orderKey : 0;
            return ordA - ordB;
        });
    }

    const isPapalyImport = importData?.source === 'papaly' || hasLayoutMeta;
    _contextMenuImportMeta = hasLayoutMeta ? {
        groups: finalGroups
            .filter(group => group && typeof group.name === 'string')
            .map(group => ({
                name: group.name,
                columnIndex: group.columnIndex,
                orderKey: group.orderKey
            })),
        rawGroups: isPapalyImport
            ? finalGroups.map(group => ({
                ...group,
                links: Array.isArray(group?.links)
                    ? group.links.map(link => ({ ...link }))
                    : []
            }))
            : null
    } : null;

    const papalySummary = document.getElementById('importLinksPapalySummary');
    const papalyCounts = document.getElementById('importLinksPapalyCounts');
    const groupingRow = document.getElementById('importLinksGroupingRow');
    const distributionRow = document.getElementById('importLinksDistributionRow');

    if (isPapalyImport) {
        if (papalySummary) papalySummary.style.display = 'block';
        if (papalyCounts) {
            const boardCount = finalGroups.length;
            const linkCount = links.length;
            papalyCounts.innerHTML = `<strong>${boardCount} boards</strong> and <strong>${linkCount} links</strong> will be imported.`;
        }
        // Hide editable controls for Papaly
        textarea.style.display = 'none';
        if (uploadRow) uploadRow.style.display = 'none';
        if (fileIndicator) fileIndicator.style.display = 'none';
        if (groupingRow) groupingRow.style.display = 'none';
        if (distributionRow) distributionRow.style.display = 'none';
    } else {
        if (papalySummary) papalySummary.style.display = 'none';
        textarea.style.display = 'block';
        if (uploadRow) uploadRow.style.display = 'flex';
        if (groupingRow) groupingRow.style.display = 'block';
        if (distributionRow) distributionRow.style.display = 'flex';
    }

    // Format as Markdown with ## headings and [title](url) links
    let formattedMarkdown = '';

    // Add source info as heading
    if (importData.sourceTitle) {
        formattedMarkdown += `# Links from: ${importData.sourceTitle}\n\n`;
    }

    // Helper to get display title for a link
    const getLinkTitle = (link) => {
        if (link.title && link.title !== link.url) {
            // Escape brackets and parentheses for valid Markdown
            return link.title.replace(/[\[\]()]/g, '\\$&');
        }
        try {
            return new URL(link.url).hostname;
        } catch {
            return link.url;
        }
    };

    // Add groups with headings
    let groupNumber = 1;
    finalGroups.forEach(group => {
        const groupName = group.name || `Group ${groupNumber++}`;
        formattedMarkdown += `## ${groupName}\n`;
        (group.links || []).forEach(link => {
            const title = getLinkTitle(link);
            formattedMarkdown += `[${title}](${link.url})\n`;
        });
        formattedMarkdown += '\n';
    });

    // Pre-fill textarea with Markdown (hidden for Papaly summary mode)
    textarea.value = formattedMarkdown.trim();
    if (!isPapalyImport) {
        textarea.style.display = 'block';
    }

    // Set grouping to smart (auto-detect)
    if (groupingSelect) {
        groupingSelect.value = 'smart';
    }

    // Reset distribution dropdown to default and hide column selector
    const distributionSelect = document.getElementById('importLinksDistribution');
    const columnRow = document.getElementById('importLinksColumnRow');
    if (distributionSelect) distributionSelect.value = 'left-to-right';
    if (columnRow) columnRow.style.display = 'none';

    // Reset placement checkbox to default (checked)
    const belowExistingCheckbox = document.getElementById('importLinksBelowExisting');
    if (belowExistingCheckbox) belowExistingCheckbox.checked = true;

    // Populate page dropdown
    await populateImportLinksPageSelect(pageSelect, currentPageId);
    resetImportLinksCreatePageUI();

    // Show modal
    modal.classList.add('active');
    if (isPapalyImport) {
        if (pageSelect) pageSelect.focus();
    } else {
        textarea.focus();
    }

    // Show toast with link count
    const linkCount = links.length;
    showGlassToast(`Found ${linkCount} link${linkCount !== 1 ? 's' : ''} - review and import`, 'info');
}

// Listen for messages from background script (e.g., after quick save)
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'reloadBoards') {

            loadBoardsFromDatabase().then(() => {

                sendResponse({ success: true });
            }).catch(error => {
                console.error('Failed to reload boards:', error);
                sendResponse({ success: false });
            });
            return true; // Keep the message channel open for async response
        }

        // FIX [H4]: Handle sync queue overflow notification
        if (request.action === 'syncQueueOverflow') {
            console.warn('⚠️ Sync queue overflow detected:', request.message);
            if (typeof showGlassToast === 'function') {
                showGlassToast('Some changes may not sync. Try refreshing the page.', 'warning');
            }
            reportReviewPromptIssue('sync').catch((error) => {
                console.warn('[ReviewPrompt] Failed to track sync overflow issue:', error);
            });
            sendResponse({ received: true });
            return false;
        }
    });
}
