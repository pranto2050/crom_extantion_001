/**
 * LumiList Sync Manager (Supabase Edition)
 *
 * Handles cloud sync with Supabase backend.
 * Uses Supabase Auth for authentication and normalized tables for data storage.
 */

// Centralized timeout constants for all auth operations
// These prevent Supabase calls from hanging indefinitely on slow/unreachable servers
const AUTH_TIMEOUTS = {
    GET_USER: 5000,           // getUser() network fallback
    GET_SESSION: 5000,        // getSession() calls
    SESSION_REFRESH: 8000,    // refreshSession() calls
    SET_SESSION: 10000,       // setSession() during OAuth
    SIGN_OUT: 2000,           // signOut() call (local cleanup already done)
    CROSS_TAB_SYNC: 15000,    // Cross-tab sync operations
    SYNC_OPERATION: 30000,    // FIX: General sync operations (checkServerHasData, fetchServerData, getSubscription)
};

const TRANSIENT_PULL_BACKOFF_MS = 60000;
const TRANSIENT_NETWORK_DEGRADED_WINDOW_MS = 10 * 60 * 1000;
const SUBSCRIPTION_LAST_KNOWN_KEY = 'subscriptionLastKnownState';
const SYNC_MANAGER_WALLPAPER_CLOUD_SYNC_STATE_STORAGE_KEY = 'wallpaperCloudSyncState';
const SYNC_MANAGER_LOGIN_SYNC_STATE_STORAGE_KEY = 'lumilist_login_sync_state';
const SYNC_MANAGER_LOGIN_SYNC_COMPLETE_STORAGE_KEY = 'lumilist_login_sync_complete';
const SYNC_MANAGER_ACCOUNT_BOUNDARY_STORAGE_KEYS = [
    'currentPageId',
    'privacyModeEnabled',
    'incognitoModeEnabled',
    'compactModeEnabled',
    'largeBoardCollapseEnabled',
    'largeBoardVisibleBookmarkLimit',
    'largeBoardExpandedBoardIds',
    'themeMode',
    'truncateTitles',
    'openInNewTab',
    'showBookmarkNotes',
    'closeTabsAfterSaveAllTabs',
    'privateLinksIncognito',
    'quickSavePageId',
    'trialBannerDismissed',
    'trialWarningDismissedAt',
    'cancelledWarningDismissedAt'
];
const SUPABASE_TRANSIENT_AUTO_REFRESH_LOG_PREFIX = 'Auto refresh tick failed with error. This is likely a transient error.';

const SYNC_UNDO_REDO_HISTORY_STATE_ID = 'main';
const SYNC_UNDO_REDO_HISTORY_MAX_DEPTH_DEFAULT = 200;

const nativeConsoleError = (typeof console !== 'undefined' && typeof console.error === 'function')
    ? console.error.bind(console)
    : null;
const nativeConsoleWarn = (typeof console !== 'undefined' && typeof console.warn === 'function')
    ? console.warn.bind(console)
    : null;
let supabaseTransientConsoleFilterInstalled = false;

// Helper to add timeout to any promise
function withSyncTimeout(promise, timeoutMs, operationName) {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`${operationName} timed out after ${timeoutMs / 1000}s`)), timeoutMs)
        )
    ]);
}

function formatErrorForLog(error) {
    if (!error) return 'none';
    if (typeof error === 'string') return error;
    if (error instanceof Error) return error.message || String(error);

    const normalizePart = (value) => {
        if (value === null || value === undefined) return null;
        const text = String(value).trim();
        return text.length > 0 ? text : null;
    };

    const code = normalizePart(error.code);
    const message = normalizePart(error.message);
    let details = normalizePart(error.details);
    const hint = normalizePart(error.hint);

    // Supabase fetch errors often repeat the message in "details"; keep summaries compact.
    if (message && details) {
        if (details === message || details.startsWith(`${message}\n`) || details.startsWith(`${message} |`)) {
            details = null;
        }
    }

    const parts = [code, message, details, hint].filter(Boolean);
    if (parts.length > 0) return parts.join(' | ');

    try {
        return JSON.stringify(error);
    } catch (e) {
        return String(error);
    }
}

function recordSubscriptionDebug() {
    return null;
}

if (typeof window !== 'undefined') {
    window.recordSubscriptionDebug = recordSubscriptionDebug;
    window.LumiListSubscriptionDebug = {
        async getRecentEntries() {
            return [];
        },
        async clear() {},
        async dumpToConsole() {
            return [];
        }
    };
}

if (typeof globalThis !== 'undefined') {
    globalThis.recordSubscriptionDebug = recordSubscriptionDebug;
}

function extractErrorDetails(error) {
    if (!error) {
        return { type: 'none', message: 'No error object provided' };
    }

    if (typeof error === 'string') {
        return { type: 'string', message: error };
    }

    if (error instanceof Error) {
        return {
            type: error.name || 'Error',
            message: error.message || String(error),
            stack: error.stack || null,
            cause: error.cause || null
        };
    }

    const details = {
        type: error.name || typeof error,
        message: error.message || formatErrorForLog(error),
        code: error.code || null,
        status: error.status || error.statusCode || null,
        details: error.details || null,
        hint: error.hint || null
    };

    try {
        details.raw = JSON.parse(JSON.stringify(error));
    } catch (e) {
        details.raw = String(error);
    }

    return details;
}

function isLikelyNetworkFetchError(error) {
    const message = formatErrorForLog(error).toLowerCase();
    return message.includes('failed to fetch') ||
        message.includes('networkerror') ||
        message.includes('network request failed') ||
        message.includes('fetch failed') ||
        message.includes('load failed') ||
        message.includes('err_connection_timed_out') ||
        message.includes('could not resolve host') ||
        message.includes('name not resolved');
}

function isLikelyTimeoutError(error) {
    const message = formatErrorForLog(error).toLowerCase();
    return message.includes('timed out') ||
        message.includes('timeout') ||
        message.includes('aborterror');
}

function extractHttpStatusFromError(error) {
    if (!error) return null;

    const directStatus = Number(error.status || error.statusCode);
    if (Number.isFinite(directStatus)) return directStatus;

    const numericCode = Number(error.code);
    if (Number.isFinite(numericCode) && numericCode >= 100 && numericCode <= 599) {
        return numericCode;
    }

    const message = formatErrorForLog(error);
    const statusMatch = message.match(/\b(4\d{2}|5\d{2})\b/);
    if (statusMatch) {
        return Number(statusMatch[1]);
    }

    return null;
}

function isLikelyTransientHttpStatusError(error) {
    const status = extractHttpStatusFromError(error);
    if (status === 408 || status === 425 || status === 429) return true;
    if (status !== null && status >= 500 && status <= 599) return true;

    const message = formatErrorForLog(error).toLowerCase();
    return message.includes('service unavailable') ||
        message.includes('temporarily unavailable') ||
        message.includes('bad gateway') ||
        message.includes('gateway timeout') ||
        message.includes('too many requests');
}

function isLikelyTransientNetworkError(error) {
    return isLikelyNetworkFetchError(error) ||
        isLikelyTimeoutError(error) ||
        isLikelyTransientHttpStatusError(error);
}

function isSupabaseLibraryRuntimeHint(value) {
    const text = String(value || '').toLowerCase();
    return text.includes('supabase.min.js') ||
        text.includes('authretryablefetcherror') ||
        text.includes('auto refresh tick failed with error');
}

function findErrorLikeValue(values = []) {
    return values.find((value) => value instanceof Error || (
        value &&
        typeof value === 'object' &&
        (typeof value.message === 'string' || typeof value.stack === 'string')
    )) || null;
}

function isTransientSupabaseRuntimeError(error, extraContext = {}) {
    if (!isLikelyTransientNetworkError(error)) return false;

    return isSupabaseLibraryRuntimeHint(error?.name) ||
        isSupabaseLibraryRuntimeHint(error?.stack) ||
        isSupabaseLibraryRuntimeHint(extraContext?.message) ||
        isSupabaseLibraryRuntimeHint(extraContext?.filename);
}

function getSuppressibleSupabaseConsoleError(args = []) {
    if (!Array.isArray(args) || args.length === 0) return null;

    const firstArg = args[0];
    if (typeof firstArg !== 'string' || !firstArg.includes(SUPABASE_TRANSIENT_AUTO_REFRESH_LOG_PREFIX)) {
        return null;
    }

    const candidateError = findErrorLikeValue(args.slice(1)) || new Error(firstArg);
    if (!isTransientSupabaseRuntimeError(candidateError, { message: firstArg })) {
        return null;
    }

    return {
        message: firstArg,
        error: candidateError
    };
}

function installSupabaseTransientConsoleFilter() {
    if (supabaseTransientConsoleFilterInstalled) return;
    if (!nativeConsoleError || !nativeConsoleWarn || typeof console === 'undefined') return;

    console.error = (...args) => {
        const suppressible = getSuppressibleSupabaseConsoleError(args);
        if (suppressible) {
            nativeConsoleWarn('[SyncManager] Suppressed transient Supabase auth console error:', formatErrorForLog(suppressible.error));
            return;
        }

        nativeConsoleError(...args);
    };

    supabaseTransientConsoleFilterInstalled = true;
}

function isLikelyAuthSessionError(error) {
    if (!error) return false;

    const status = extractHttpStatusFromError(error);
    if (status === 401 || status === 403) return true;

    const code = String(error.code || '').toUpperCase();
    if (code === '401' || code === '403' || code === 'PGRST301') return true;

    const message = formatErrorForLog(error).toLowerCase();
    return message.includes('jwt') ||
        message.includes('refresh token') ||
        message.includes('token') ||
        message.includes('unauthorized') ||
        message.includes('forbidden') ||
        message.includes('session expired') ||
        message.includes('auth session missing');
}

function isKnownSubscriptionStatus(status) {
    return status === 'trial' ||
        status === 'active' ||
        status === 'grace' ||
        status === 'expired';
}

function isValidChromeExtensionId(id) {
    return /^[a-z]{32}$/.test(id || '');
}

function isValidRuntimeExtensionTargetUrl(targetUrl) {
    try {
        if (!targetUrl || typeof targetUrl !== 'string') return false;
        const parsed = new URL(targetUrl);
        const isExtensionProtocol = parsed.protocol === 'chrome-extension:' || parsed.protocol === 'moz-extension:';
        if (!isExtensionProtocol) return false;
        if (!parsed.host) return false;
        // Keep callback target constrained to extension new tab entrypoint.
        return parsed.pathname === '/newtab.html';
    } catch (e) {
        return false;
    }
}

function buildWallpaperCloudSyncState(userId, syncMetadataRow) {
    const row = syncMetadataRow && typeof syncMetadataRow === 'object'
        ? syncMetadataRow
        : {};
    const hasExplicitSelection = row.wallpaper_selection && typeof row.wallpaper_selection === 'object';
    const selection = hasExplicitSelection
        ? row.wallpaper_selection
        : {};
    const installs = Array.isArray(row.wallpaper_installs)
        ? row.wallpaper_installs
        : [];
    const hasConfiguredPreferences = (row.theme_mode === 'dark' || row.theme_mode === 'light')
        || selection.dark !== undefined
        || selection.light !== undefined
        || installs.length > 0
        || !!row.wallpaper_preferences_updated_at;

    return {
        userId: typeof userId === 'string' && userId.trim() ? userId.trim() : null,
        hasConfiguredPreferences,
        themeMode: (row.theme_mode === 'dark' || row.theme_mode === 'light') ? row.theme_mode : null,
        selectionByTheme: {
            dark: typeof selection.dark === 'string' && selection.dark.trim() ? selection.dark.trim() : null,
            light: typeof selection.light === 'string' && selection.light.trim() ? selection.light.trim() : null
        },
        selectionPresenceByTheme: {
            dark: hasExplicitSelection ? Object.prototype.hasOwnProperty.call(selection, 'dark') : false,
            light: hasExplicitSelection ? Object.prototype.hasOwnProperty.call(selection, 'light') : false
        },
        installedWallpapers: installs,
        updatedAt: typeof row.wallpaper_preferences_updated_at === 'string' && row.wallpaper_preferences_updated_at.trim()
            ? row.wallpaper_preferences_updated_at.trim()
            : null,
        fetchedAt: new Date().toISOString()
    };
}

async function storeWallpaperCloudSyncState(userId, syncMetadataRow) {
    void buildWallpaperCloudSyncState(userId, syncMetadataRow);
}

function resolveRuntimeExtensionTargetUrl() {
    try {
        if (typeof chrome !== 'undefined' && chrome?.runtime?.getURL) {
            const targetUrl = chrome.runtime.getURL('newtab.html');
            if (isValidRuntimeExtensionTargetUrl(targetUrl)) {
                return targetUrl;
            }
        }
    } catch (e) {
        console.warn('Failed to resolve extension target URL from runtime:', e?.message || e);
    }

    // Fallback if already on extension newtab page.
    try {
        if (typeof window !== 'undefined' && window?.location?.href) {
            const parsed = new URL(window.location.href);
            const isExtensionProtocol = parsed.protocol === 'chrome-extension:' || parsed.protocol === 'moz-extension:';
            if (isExtensionProtocol && parsed.pathname === '/newtab.html') {
                return parsed.toString();
            }
        }
    } catch (e) {
        console.warn('Failed to resolve extension target URL from location:', e?.message || e);
    }

    return null;
}

function resolveRuntimeExtensionId() {
    // Primary source in extension contexts.
    const runtimeId = (typeof chrome !== 'undefined' && chrome?.runtime?.id) ? chrome.runtime.id : null;
    if (isValidChromeExtensionId(runtimeId)) {
        return runtimeId;
    }

    // Fallback for edge cases where runtime.id is unavailable but getURL still works.
    try {
        if (typeof chrome !== 'undefined' && chrome?.runtime?.getURL) {
            const runtimeUrl = chrome.runtime.getURL('/');
            const host = new URL(runtimeUrl).host;
            if (isValidChromeExtensionId(host)) {
                return host;
            }
        }
    } catch (e) {
        console.warn('Failed to resolve extension ID from runtime URL:', e?.message || e);
    }

    // Final fallback if currently running inside an extension page.
    try {
        if (typeof window !== 'undefined' && window?.location?.protocol === 'chrome-extension:') {
            const host = window.location.host;
            if (isValidChromeExtensionId(host)) {
                return host;
            }
        }
    } catch (e) {
        console.warn('Failed to resolve extension ID from location:', e?.message || e);
    }

    return null;
}

const SyncManager = {
    // Supabase query limits - use SERVER-SIDE limits (with safety buffer for race conditions)
    // Client limits: 10,000/50,000/100,000 - Server allows slightly more to handle edge cases
    // Supabase has a default limit of 1000 rows, so we must explicitly set higher limits
    SYNC_PAGE_LIMIT: 11000,        // Server-side: 11,000 (10,000 + 10% buffer)
    SYNC_BOARD_LIMIT: 55000,       // Server-side: 55,000 (50,000 + 10% buffer)
    SYNC_BOOKMARK_LIMIT: 102000,   // Server-side: 102,000 (100,000 + 2% buffer)

    // Storage keys (keeping same keys for compatibility)
    USER_KEY: 'lumilist_user',
    SESSION_INVALIDATED_KEY: 'lumilist_session_invalidated',
    SYNC_VERSION_KEY: 'lumilist_sync_version',
    DELTA_SYNC_KEY: 'lumilist_last_delta_sync',
    AUTH_TOKEN_KEY_SUFFIX: '-auth-token',
    NATIVE_CHROME_OAUTH_EXTENSION_IDS: [
        'cojaakbhllmokhfioangjgnaphkmljkc', // current unpacked/dev folder
        'pcekakljniocipfpmjmpmgaleigcbhlh', // Chrome Web Store listing/runtime ID
        'jnnpogbgfpkiicpcnphfbmabfbiogkpb'  // legacy production fallback ID
    ],

    // Supabase client reference
    _supabase: null,
    _hasSupabaseRejectionGuard: false,
    _oauthLoginInProgress: false,

    _getExtensionIdentityRuntime() {
        if (typeof browser !== 'undefined' && browser?.identity) {
            return { api: browser.identity, flavor: 'browser' };
        }

        if (typeof chrome !== 'undefined' && chrome?.identity) {
            return { api: chrome.identity, flavor: 'chrome' };
        }

        return null;
    },

    _resolveBrowserOAuthRedirectUrl(identityRuntime) {
        const identityApi = identityRuntime?.api;
        if (!identityApi || typeof identityApi.getRedirectURL !== 'function') {
            return null;
        }

        try {
            const redirectUrl = identityApi.getRedirectURL();
            if (typeof redirectUrl !== 'string' || !redirectUrl.trim()) {
                return null;
            }

            const parsed = new URL(redirectUrl);
            if (parsed.protocol !== 'https:') {
                return null;
            }

            return parsed.toString();
        } catch (error) {
            console.warn('Failed to resolve browser OAuth redirect URL:', error?.message || error);
            return null;
        }
    },

    _isStableChromeNativeOAuthExtensionId(extensionId) {
        const normalized = typeof extensionId === 'string'
            ? extensionId.trim().toLowerCase()
            : '';
        if (!/^[a-z]{32}$/.test(normalized)) {
            return false;
        }

        return this.NATIVE_CHROME_OAUTH_EXTENSION_IDS.includes(normalized);
    },

    _resolveGoogleOAuthTransport({ identityRuntime, browserOAuthRedirectUrl, extensionId }) {
        if (!identityRuntime) {
            return {
                useNative: false,
                fallbackReason: 'identity-api-unavailable'
            };
        }

        if (!browserOAuthRedirectUrl) {
            return {
                useNative: false,
                fallbackReason: 'identity-missing-redirect-url'
            };
        }

        // Firefox/browser.identity runtimes use stable browser-managed redirect URLs,
        // so keep the native flow whenever a redirect URL is available.
        if (identityRuntime.flavor !== 'chrome') {
            return {
                useNative: true,
                fallbackReason: null
            };
        }

        // Chrome unpacked extension IDs change with the local folder path unless the
        // build is pinned. Unknown unpacked IDs should use the hosted callback so
        // local release folders keep working without per-folder Supabase allow-list churn.
        if (!this._isStableChromeNativeOAuthExtensionId(extensionId)) {
            return {
                useNative: false,
                fallbackReason: 'chrome-unrecognized-unpacked-extension-id'
            };
        }

        return {
            useNative: true,
            fallbackReason: null
        };
    },

    _isUserCancelledIdentityAuthFlowErrorMessage(message) {
        const normalizedMessage = String(message || '').toLowerCase();
        return normalizedMessage.includes('did not approve access') ||
            normalizedMessage.includes('cancelled before completion') ||
            normalizedMessage.includes('canceled before completion') ||
            normalizedMessage.includes('login was cancelled') ||
            normalizedMessage.includes('login was canceled');
    },

    _isBenignPostClearAuthKey(key, value) {
        return key === 'themeMode' && value === 'dark';
    },

    async _launchBrowserIdentityAuthFlow(identityRuntime, details) {
        const identityApi = identityRuntime?.api;
        if (!identityApi || typeof identityApi.launchWebAuthFlow !== 'function') {
            throw new Error('Browser identity auth flow is unavailable.');
        }

        if (identityRuntime.flavor === 'browser') {
            return identityApi.launchWebAuthFlow(details);
        }

        return new Promise((resolve, reject) => {
            try {
                identityApi.launchWebAuthFlow(details, (redirectUrl) => {
                    const runtimeError = chrome?.runtime?.lastError;
                    if (runtimeError) {
                        const runtimeMessage = runtimeError.message || 'launchWebAuthFlow failed';
                        if (this._isUserCancelledIdentityAuthFlowErrorMessage(runtimeMessage)) {
                            reject(new Error('Login was cancelled before completion.'));
                            return;
                        }
                        reject(new Error(runtimeMessage));
                        return;
                    }

                    if (typeof redirectUrl !== 'string' || !redirectUrl.trim()) {
                        reject(new Error('Login was cancelled before completion.'));
                        return;
                    }

                    resolve(redirectUrl);
                });
            } catch (error) {
                reject(error);
            }
        });
    },

    _buildExtensionAuthReturnUrl(extensionTargetUrl, authRedirectUrl) {
        const extensionUrl = new URL(extensionTargetUrl);
        const authUrl = new URL(authRedirectUrl);
        extensionUrl.search = authUrl.search;
        // Force a full document navigation back into newtab.html.
        // A hash-only update on the already-open extension tab would not rerun startup auth handling.
        extensionUrl.searchParams.set('lumilist_oauth', '1');
        extensionUrl.hash = authUrl.hash;
        return extensionUrl.toString();
    },

    async _storeOAuthRedirectDebugInfo(debugInfo) {
        try {
            if (typeof chrome !== 'undefined' && chrome?.storage?.local) {
                await chrome.storage.local.set({
                    lumilist_last_oauth_redirect: {
                        ...debugInfo,
                        timestamp: new Date().toISOString()
                    }
                });
            }
        } catch (error) {
            console.warn('Failed to store OAuth redirect debug info:', error?.message || error);
        }
    },

    async _startHostedGoogleLogin({ supabase, extensionTargetUrl, extensionId, fallbackReason = null }) {
        const callbackUrl = new URL('https://lumilist.in/auth/callback/');
        callbackUrl.searchParams.set('ext_target', extensionTargetUrl);
        if (extensionId) {
            callbackUrl.searchParams.set('ext_id', extensionId);
        }

        await this._storeOAuthRedirectDebugInfo({
            transport: 'hosted-callback',
            fallbackReason,
            extensionId,
            extensionTargetUrl,
            redirectTo: callbackUrl.toString()
        });

        const { error } = await supabase.auth.signInWithOAuth({
            provider: 'google',
            options: {
                redirectTo: callbackUrl.toString(),
                // Redundant transport path: keep ext_target in provider query context too.
                // Primary source remains redirectTo query param.
                queryParams: extensionId
                    ? { ext_target: extensionTargetUrl, ext_id: extensionId }
                    : { ext_target: extensionTargetUrl },
                skipBrowserRedirect: false
            }
        });

        if (error) {
            this._oauthLoginInProgress = false;
            return { success: false, error: error.message };
        }

        // The browser will redirect - success will be handled by URL detection.
        // Safety valve in case browser blocks redirect (prevents stale lock in current tab).
        setTimeout(() => {
            this._oauthLoginInProgress = false;
        }, 20000);

        return { success: true, redirecting: true, transport: 'hosted-callback' };
    },

    async _startNativeGoogleLogin({
        supabase,
        extensionTargetUrl,
        extensionId,
        identityRuntime,
        browserOAuthRedirectUrl
    }) {
        await this._storeOAuthRedirectDebugInfo({
            transport: 'browser-identity',
            extensionId,
            extensionTargetUrl,
            redirectTo: browserOAuthRedirectUrl
        });

        const { data, error } = await supabase.auth.signInWithOAuth({
            provider: 'google',
            options: {
                redirectTo: browserOAuthRedirectUrl,
                skipBrowserRedirect: true
            }
        });

        if (error) {
            this._oauthLoginInProgress = false;
            return { success: false, error: error.message };
        }

        const providerUrl = data?.url || null;
        if (!providerUrl) {
            this._oauthLoginInProgress = false;
            return { success: false, error: 'Google sign-in URL was not returned.' };
        }

        await this._storeOAuthRedirectDebugInfo({
            transport: 'browser-identity',
            extensionId,
            extensionTargetUrl,
            redirectTo: browserOAuthRedirectUrl,
            providerUrl
        });

        let authRedirectUrl;
        try {
            authRedirectUrl = await this._launchBrowserIdentityAuthFlow(identityRuntime, {
                url: providerUrl,
                interactive: true
            });
        } catch (error) {
            this._oauthLoginInProgress = false;
            return { success: false, error: error?.message || 'Google login could not be completed.' };
        }

        if (typeof authRedirectUrl !== 'string' || !authRedirectUrl.trim()) {
            this._oauthLoginInProgress = false;
            return { success: false, error: 'Login was cancelled before completion.' };
        }

        const extensionAuthReturnUrl = this._buildExtensionAuthReturnUrl(extensionTargetUrl, authRedirectUrl);
        this._oauthLoginInProgress = false;

        if (typeof window?.location?.assign === 'function') {
            window.location.assign(extensionAuthReturnUrl);
        } else if (typeof window !== 'undefined' && window?.location) {
            window.location.href = extensionAuthReturnUrl;
        } else {
            return { success: false, error: 'Current extension tab is unavailable.' };
        }

        return { success: true, redirecting: true, transport: 'browser-identity' };
    },

    _ensureSupabaseNetworkRejectionGuard() {
        if (this._hasSupabaseRejectionGuard) return;
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;

        installSupabaseTransientConsoleFilter();

        window.addEventListener('unhandledrejection', (event) => {
            const reason = event?.reason;
            if (!reason) return;

            if (isTransientSupabaseRuntimeError(reason)) {
                event.preventDefault();
                console.warn('[SyncManager] Suppressed transient Supabase auth rejection:', formatErrorForLog(reason));
            }
        });

        window.addEventListener('error', (event) => {
            const candidateError = event?.error || new Error(String(event?.message || 'Unknown Supabase runtime error'));
            if (!isTransientSupabaseRuntimeError(candidateError, {
                message: event?.message,
                filename: event?.filename
            })) {
                return;
            }

            event.preventDefault();
            if (nativeConsoleWarn) {
                nativeConsoleWarn('[SyncManager] Suppressed transient Supabase runtime error:', formatErrorForLog(candidateError));
            }
        });

        this._hasSupabaseRejectionGuard = true;
    },

    /**
     * Capture sync errors in console for diagnostics
     */
    _buildDiagnosticContext(operation, extraContext = {}) {
        const locationHref = (typeof window !== 'undefined' && window?.location?.href)
            ? window.location.href
            : null;

        return {
            operation,
            timestamp: new Date().toISOString(),
            online: (typeof navigator !== 'undefined') ? navigator.onLine : null,
            visibilityState: (typeof document !== 'undefined') ? document.visibilityState : null,
            page: locationHref,
            runtimeExtensionId: resolveRuntimeExtensionId(),
            runtimeExtensionTargetUrl: resolveRuntimeExtensionTargetUrl(),
            hasSupabaseClient: !!this._supabase,
            ...extraContext
        };
    },

    _captureError(error, operation, extraContext = {}) {
        const summary = formatErrorForLog(error);
        const details = extractErrorDetails(error);
        const context = this._buildDiagnosticContext(operation, extraContext);

        const transientNetworkError = isLikelyTransientNetworkError(error);
        if (transientNetworkError) {
            context.likelyCause = context.online
                ? 'Network reachable but request failed (ad blocker, DNS/VPN/firewall, transient Supabase outage, or browser fetch interruption)'
                : 'Offline at failure time';
        }

        const logger = transientNetworkError ? console.warn : console.error;
        logger(`[SyncManager] ${operation}: ${summary}`, {
            summary,
            details,
            context
        });
    },

    _findSupabaseAuthTokenKey(source = {}) {
        return Object.keys(source || {}).find(
            (key) => key.startsWith('sb-') && key.endsWith(this.AUTH_TOKEN_KEY_SUFFIX)
        ) || null;
    },

    _parseStoredSupabaseSession(rawSession) {
        if (!rawSession) return null;

        let parsedSession = rawSession;
        if (typeof rawSession === 'string') {
            try {
                parsedSession = JSON.parse(rawSession);
            } catch (error) {
                return null;
            }
        }

        if (!parsedSession || typeof parsedSession !== 'object') return null;

        const candidateSession =
            parsedSession.currentSession ||
            parsedSession.session ||
            parsedSession.data?.session ||
            parsedSession;

        if (!candidateSession || typeof candidateSession !== 'object') return null;

        const accessToken = candidateSession.access_token || parsedSession.access_token || null;
        const refreshToken = candidateSession.refresh_token || parsedSession.refresh_token || null;
        if (!accessToken || !refreshToken) return null;

        return {
            access_token: accessToken,
            refresh_token: refreshToken,
            expires_at: candidateSession.expires_at || parsedSession.expires_at || null,
            user:
                candidateSession.user ||
                parsedSession.user ||
                parsedSession.data?.session?.user ||
                null
        };
    },

    async _readStoredSupabaseSessionRecord() {
        try {
            if (typeof chrome === 'undefined' || !chrome.storage?.local) return null;

            const allData = await chrome.storage.local.get(null);
            const authTokenKey = this._findSupabaseAuthTokenKey(allData);
            if (!authTokenKey) return null;

            const rawValue = allData[authTokenKey];
            const session = this._parseStoredSupabaseSession(rawValue);
            return {
                authTokenKey,
                rawValue,
                session
            };
        } catch (error) {
            console.warn('[SyncManager] Failed reading stored Supabase session:', formatErrorForLog(error));
            return null;
        }
    },

    async _recoverUserFromStoredSupabaseSession() {
        try {
            const sessionRecord = await this._readStoredSupabaseSessionRecord();
            const candidateUser = sessionRecord?.session?.user || null;

            if (!candidateUser?.id) return null;

            const recoveredUser = {
                id: candidateUser.id,
                email: candidateUser.email || null
            };
            await this.setStoredUser(recoveredUser);
            return recoveredUser;
        } catch (error) {
            console.warn('[SyncManager] Failed to recover user from stored Supabase session:', formatErrorForLog(error));
            return null;
        }
    },

    async adoptStoredSupabaseSession(rawSession, options = {}) {
        const parsedSession = this._parseStoredSupabaseSession(rawSession);
        if (!parsedSession) {
            return false;
        }

        const supabase = this.getSupabase();
        if (!supabase?.auth) {
            return false;
        }

        const allowNoopRecovery = options.allowNoopRecovery === true;
        let currentSession = null;

        try {
            const currentSessionResult = await supabase.auth.getSession();
            currentSession = currentSessionResult?.data?.session || null;
        } catch (error) {
            console.warn('[SyncManager] Failed reading current Supabase session before adoption:', formatErrorForLog(error));
        }

        const sameSession =
            currentSession?.refresh_token === parsedSession.refresh_token &&
            currentSession?.access_token === parsedSession.access_token;
        const incomingUser = parsedSession.user || currentSession?.user || null;

        if (sameSession) {
            if (allowNoopRecovery) {
                if (incomingUser?.id) {
                    await this.setStoredUser({
                        id: incomingUser.id,
                        email: incomingUser.email || null
                    });
                } else {
                    await this.clearSessionInvalidation();
                }
                return true;
            }
            return false;
        }

        try {
            if (typeof supabase.auth.stopAutoRefresh === 'function') {
                await supabase.auth.stopAutoRefresh();
            }
        } catch (error) {
            console.warn('[SyncManager] Failed stopping Supabase auto-refresh before session adoption:', formatErrorForLog(error));
        }

        try {
            const { data, error } = await supabase.auth.setSession({
                access_token: parsedSession.access_token,
                refresh_token: parsedSession.refresh_token
            });
            if (error) {
                throw error;
            }

            const adoptedUser =
                data?.session?.user ||
                data?.user ||
                parsedSession.user ||
                null;

            if (adoptedUser?.id) {
                await this.setStoredUser({
                    id: adoptedUser.id,
                    email: adoptedUser.email || null
                });
            } else {
                await this.clearSessionInvalidation();
            }

            return true;
        } catch (error) {
            this._captureError(error, 'adopt_stored_supabase_session', {
                hasIncomingUser: !!parsedSession.user?.id
            });
            return false;
        } finally {
            try {
                if (typeof supabase.auth.startAutoRefresh === 'function') {
                    await supabase.auth.startAutoRefresh();
                }
            } catch (error) {
                console.warn('[SyncManager] Failed restarting Supabase auto-refresh after session adoption:', formatErrorForLog(error));
            }
        }
    },

    async recoverSupabaseSessionAfterRefreshFailure() {
        const initialRecord = await this._readStoredSupabaseSessionRecord();
        if (initialRecord?.rawValue) {
            const recoveredImmediately = await this.adoptStoredSupabaseSession(initialRecord.rawValue);
            if (recoveredImmediately) {
                return true;
            }
        }

        await new Promise((resolve) => setTimeout(resolve, 250));

        const retriedRecord = await this._readStoredSupabaseSessionRecord();
        if (!retriedRecord?.rawValue) {
            return false;
        }

        if (retriedRecord.rawValue === initialRecord?.rawValue) {
            return false;
        }

        return this.adoptStoredSupabaseSession(retriedRecord.rawValue);
    },

    /**
     * Get Supabase client (lazy initialization)
     */
    getSupabase() {
        this._ensureSupabaseNetworkRejectionGuard();

        if (!this._supabase) {
            if (typeof window !== 'undefined' && window.initSupabase) {
                try {
                    this._supabase = window.initSupabase();
                } catch (error) {
                    this._captureError(error, 'supabase_init');
                    this._supabase = null;
                }
            }
        }
        return this._supabase;
    },

    _hasPersistedSubscriptionRecord(subscription) {
        if (!subscription || typeof subscription !== 'object') return false;
        return Boolean(
            subscription.id ||
            subscription.plan ||
            subscription.trial_ends_at ||
            subscription.trial_started_at ||
            subscription.subscription_started_at ||
            subscription.subscription_ends_at ||
            subscription.billing_cycle_ends_at ||
            subscription.grace_ends_at ||
            subscription.razorpay_subscription_id
        );
    },

    _isLikelyAuthSessionError(error) {
        if (typeof isLikelyAuthSessionError === 'function') {
            return isLikelyAuthSessionError(error);
        }

        if (!error) return false;

        const rawStatus = error?.status ?? error?.statusCode ?? null;
        const normalizedStatus = Number.parseInt(String(rawStatus ?? ''), 10);
        if (normalizedStatus === 401 || normalizedStatus === 403) {
            return true;
        }

        const code = String(error?.code || '').toUpperCase();
        if (code === '401' || code === '403' || code === 'PGRST301') {
            return true;
        }

        const message = String(error?.message || error || '').toLowerCase();
        return message.includes('invalid or expired token') ||
            message.includes('jwt') ||
            message.includes('refresh token') ||
            message.includes('token') ||
            message.includes('unauthorized') ||
            message.includes('forbidden') ||
            message.includes('session expired') ||
            message.includes('auth session missing');
    },

    async _getSubscriptionFunctionAccessToken(supabase) {
        try {
            if (supabase?.auth?.getSession) {
                const timeoutPromise = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('getSubscriptionSession timeout')), AUTH_TIMEOUTS.GET_SESSION)
                );
                const sessionPromise = supabase.auth.getSession();
                const { data: { session } = { session: null } } = await Promise.race([sessionPromise, timeoutPromise]);
                if (session?.access_token) {
                    return session.access_token;
                }
            }
        } catch (error) {
            console.warn('[SyncManager] Failed to read Supabase session for subscription function:', formatErrorForLog(error));
        }

        const sessionRecord = await this._readStoredSupabaseSessionRecord();
        return sessionRecord?.session?.access_token || null;
    },

    async _refreshSubscriptionFunctionAccessToken(supabase) {
        if (!supabase?.auth?.refreshSession) return null;

        try {
            const { data: { session } = { session: null }, error } = await withSyncTimeout(
                supabase.auth.refreshSession(),
                AUTH_TIMEOUTS.SESSION_REFRESH,
                'refreshSubscriptionSession'
            );
            if (error) {
                throw error;
            }
            return session?.access_token || null;
        } catch (error) {
            globalThis.recordSubscriptionDebug?.('sync.subscription.edge.refresh.error', {
                error,
                errorSummary: formatErrorForLog(error)
            });
            return null;
        }
    },

    async _fetchSubscriptionViaEdgeFunction(supabase) {
        const supabaseUrl = (typeof window !== 'undefined' && window.SUPABASE_URL) ? window.SUPABASE_URL : null;
        if (!supabaseUrl) {
            globalThis.recordSubscriptionDebug?.('sync.subscription.edge.missing_url', {});
            return { subscription: null, fetchError: new Error('Supabase URL unavailable'), missing: false };
        }

        let accessToken = await this._getSubscriptionFunctionAccessToken(supabase);
        if (!accessToken) {
            globalThis.recordSubscriptionDebug?.('sync.subscription.edge.missing_token', {});
            return { subscription: null, fetchError: new Error('Missing auth token for subscription function'), missing: false };
        }

        for (let attempt = 0; attempt < 2; attempt++) {
            globalThis.recordSubscriptionDebug?.('sync.subscription.edge.request.start', {
                hasSupabase: Boolean(supabase),
                hasToken: Boolean(accessToken),
                attempt,
                url: `${supabaseUrl}/functions/v1/get-subscription`
            });

            try {
                const response = await withSyncTimeout(
                    fetch(`${supabaseUrl}/functions/v1/get-subscription`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${accessToken}`
                        },
                        body: JSON.stringify({})
                    }),
                    AUTH_TIMEOUTS.SYNC_OPERATION,
                    'getSubscriptionEdge'
                );

                if (!response.ok) {
                    let errorText = '';
                    try {
                        errorText = await response.text();
                    } catch (_) {
                        errorText = '';
                    }
                    const error = new Error(`Subscription function failed: ${response.status} ${errorText}`.trim());
                    error.status = response.status;

                    if (attempt === 0 && this._isLikelyAuthSessionError(error)) {
                        const refreshedAccessToken = await this._refreshSubscriptionFunctionAccessToken(supabase);
                        if (refreshedAccessToken && refreshedAccessToken !== accessToken) {
                            globalThis.recordSubscriptionDebug?.('sync.subscription.edge.request.retry_after_refresh', {
                                attempt,
                                previousErrorSummary: formatErrorForLog(error)
                            });
                            accessToken = refreshedAccessToken;
                            continue;
                        }
                        error.subscriptionRefreshAttempted = true;
                    }

                    throw error;
                }

                const data = await response.json();
                const hasPersistedRecord = this._hasPersistedSubscriptionRecord(data);
                globalThis.recordSubscriptionDebug?.('sync.subscription.edge.request.success', {
                    responseOk: response.ok,
                    attempt,
                    persistedRecord: hasPersistedRecord,
                    payload: data
                });
                return {
                    subscription: hasPersistedRecord ? data : null,
                    fetchError: null,
                    missing: !hasPersistedRecord
                };
            } catch (error) {
                if (
                    attempt === 0 &&
                    this._isLikelyAuthSessionError(error) &&
                    error?.subscriptionRefreshAttempted !== true
                ) {
                    const refreshedAccessToken = await this._refreshSubscriptionFunctionAccessToken(supabase);
                    if (refreshedAccessToken && refreshedAccessToken !== accessToken) {
                        globalThis.recordSubscriptionDebug?.('sync.subscription.edge.request.retry_after_refresh', {
                            attempt,
                            previousErrorSummary: formatErrorForLog(error)
                        });
                        accessToken = refreshedAccessToken;
                        continue;
                    }
                }

                globalThis.recordSubscriptionDebug?.('sync.subscription.edge.request.error', {
                    error,
                    attempt,
                    errorSummary: formatErrorForLog(error)
                });
                return { subscription: null, fetchError: error, missing: false };
            }
        }

        return { subscription: null, fetchError: new Error('Subscription function retry exhausted'), missing: false };
    },

    /**
     * Get current authenticated user
     * Uses cache-first approach with timeout to prevent hanging
     * FIX: Repopulates cache on network success to prevent future timeouts
     */
    async getUser() {
        // CACHE-FIRST: Check local storage for cached user (instant, never hangs)
        const cachedUser = await this.getStoredUser();
        if (cachedUser && cachedUser.id) {
            if (await this.isSessionInvalidatedForUser(cachedUser)) {
                console.warn('[SyncManager] getUser blocked because the cached session was invalidated');
                return null;
            }
            return cachedUser;
        }

        const invalidation = await this.getSessionInvalidation();
        if (invalidation) {
            return null;
        }

        // NO CACHED USER: Fall back to Supabase auth with timeout
        const supabase = this.getSupabase();
        if (!supabase) return null;

        try {
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('getUser timeout')), AUTH_TIMEOUTS.GET_USER)
            );
            const userPromise = supabase.auth.getUser();
            const { data: { user } } = await Promise.race([userPromise, timeoutPromise]);

            // FIX: Repopulate cache on network success to prevent future network calls
            if (user) {
                await this.setStoredUser({ id: user.id, email: user.email });
                
            }

            return user;
        } catch (error) {
            const transientNetworkError = isLikelyTransientNetworkError(error);
            if (transientNetworkError) {
                this._markTransientNetworkFailure();
                const recoveredUser = await this._recoverUserFromStoredSupabaseSession();
                if (recoveredUser?.id) {
                    if (await this.isSessionInvalidatedForUser(recoveredUser)) {
                        console.warn('[SyncManager] Ignoring recovered Supabase session because it was already invalidated');
                        return null;
                    }
                    console.warn('[SyncManager] getUser recovered from stored session during transient auth/network issue');
                    return recoveredUser;
                }
            }
            this._captureError(error, 'get_user', { hasCache: !!cachedUser });
            return null;
        }
    },

    /**
     * Check if server has any data for current user
     * Used to prevent creating default Home page when server has existing data
     */
    async checkServerHasData() {
        const supabase = this.getSupabase();
        if (!supabase) return null;

        // Use getUser() which has timeout protection
        const user = await this.getUser();
        if (!user) return null;

        try {
            // FIX: Add timeout to prevent hanging indefinitely
            const { count, error } = await withSyncTimeout(
                supabase
                    .from('pages')
                    .select('*', { count: 'exact', head: true })
                    .eq('user_id', user.id)
                    .is('deleted_at', null),
                AUTH_TIMEOUTS.SYNC_OPERATION,
                'checkServerHasData'
            );

            if (error) {
                console.error('Error checking server data:', error);
                if (isLikelyAuthSessionError(error)) {
                    await this.handleAuthFailure('Session expired - please login again');
                }
                return null;
            }

            return (count || 0) > 0;
        } catch (e) {
            console.error('checkServerHasData timeout or error:', e);
            if (isLikelyAuthSessionError(e)) {
                await this.handleAuthFailure('Session expired - please login again');
            }
            return null;
        }
    },

    /**
     * Fetch all server data for current user
     * Used to import data when local is empty but server has data
     */
    async fetchServerData() {
        const supabase = this.getSupabase();
        if (!supabase) return null;

        // Use getUser() which has timeout protection
        const user = await this.getUser();
        if (!user) return null;

        

        try {
            // FIX: Add timeout to prevent hanging indefinitely
            // Fetch all data in parallel with timeout wrapper
            // IMPORTANT: Supabase has a default limit of 1000 rows. We must use .range()
            // to fetch all items up to the app's limits
            const [pagesRes, boardsRes, bookmarksRes] = await withSyncTimeout(
                Promise.all([
                    supabase.from('pages').select('*').eq('user_id', user.id).order('order').range(0, this.SYNC_PAGE_LIMIT - 1),
                    supabase.from('boards').select('*').eq('user_id', user.id).order('order').range(0, this.SYNC_BOARD_LIMIT - 1),
                    supabase.from('bookmarks').select('*').eq('user_id', user.id).order('order').range(0, this.SYNC_BOOKMARK_LIMIT - 1)
                ]),
                AUTH_TIMEOUTS.SYNC_OPERATION,
                'fetchServerData'
            );

            if (pagesRes.error) {
                console.error('Error fetching pages:', pagesRes.error);
                if (isLikelyAuthSessionError(pagesRes.error)) {
                    await this.handleAuthFailure('Session expired - please login again');
                }
                return null;
            }
            if (boardsRes.error) {
                console.error('Error fetching boards:', boardsRes.error);
                if (isLikelyAuthSessionError(boardsRes.error)) {
                    await this.handleAuthFailure('Session expired - please login again');
                }
                return null;
            }
            if (bookmarksRes.error) {
                console.error('Error fetching bookmarks:', bookmarksRes.error);
                if (isLikelyAuthSessionError(bookmarksRes.error)) {
                    await this.handleAuthFailure('Session expired - please login again');
                }
                return null;
            }

            return this.normalizeServerDataPayload({
                pages: pagesRes.data || [],
                boards: boardsRes.data || [],
                bookmarks: bookmarksRes.data || []
            });
        } catch (e) {
            console.error('fetchServerData timeout or error:', e);
            if (isLikelyAuthSessionError(e)) {
                await this.handleAuthFailure('Session expired - please login again');
            }
            return null;
        }
    },

    /**
     * Get stored user info (for display purposes)
     */
    async getStoredUser() {
        return new Promise((resolve) => {
            chrome.storage.local.get([this.USER_KEY], (result) => {
                resolve(result[this.USER_KEY] || null);
            });
        });
    },

    async getSessionInvalidation() {
        return new Promise((resolve) => {
            chrome.storage.local.get([this.SESSION_INVALIDATED_KEY], (result) => {
                resolve(result[this.SESSION_INVALIDATED_KEY] || null);
            });
        });
    },

    async markSessionInvalidated(reason, user = null) {
        const targetUser = user || await this.getStoredUser();
        const payload = {
            reason: reason || 'Session expired. Please login again.',
            userId: targetUser?.id || null,
            email: targetUser?.email || null,
            timestamp: Date.now(),
            recordedAt: new Date().toISOString()
        };

        return new Promise((resolve) => {
            chrome.storage.local.set({ [this.SESSION_INVALIDATED_KEY]: payload }, () => {
                resolve(payload);
            });
        });
    },

    async clearSessionInvalidation() {
        return new Promise((resolve) => {
            chrome.storage.local.remove([this.SESSION_INVALIDATED_KEY], resolve);
        });
    },

    async isSessionInvalidatedForUser(user) {
        const invalidation = await this.getSessionInvalidation();
        if (!invalidation) return false;

        const userId = typeof user === 'string' ? user : user?.id || null;
        if (!invalidation.userId || !userId) return true;
        return invalidation.userId === userId;
    },

    /**
     * Store user info for display
     */
    async setStoredUser(user) {
        return new Promise((resolve) => {
            chrome.storage.local.set({ [this.USER_KEY]: user }, () => {
                chrome.storage.local.remove([this.SESSION_INVALIDATED_KEY], resolve);
            });
        });
    },

    /**
     * Clear stored user info only (for auth state changes)
     */
    async clearStoredUser() {
        return new Promise((resolve) => {
            chrome.storage.local.remove([this.USER_KEY], resolve);
        });
    },

    // ==================== BOOKMARK LIMIT METHODS ====================

    /**
     * Fetch bookmark count from server (includes trash)
     * Used before bulk imports for accurate limit checking
     * @returns {number|null} Bookmark count or null on error
     */
    async getServerBookmarkCount() {
        const supabase = await this.getSupabase();
        if (!supabase) return null;

        const user = await this.getUser();
        if (!user) return null;

        try {
            const { count, error } = await withSyncTimeout(
                supabase
                    .from('bookmarks')
                    .select('*', { count: 'exact', head: true })
                    .eq('user_id', user.id),
                AUTH_TIMEOUTS.SYNC_OPERATION,
                'getServerBookmarkCount'
            );

            if (error) {
                console.error('[SyncManager] Failed to fetch bookmark count:', error);
                return null;
            }

            
            return count;
        } catch (e) {
            console.error('[SyncManager] getServerBookmarkCount timeout or error:', e);
            return null;
        }
    },

    normalizeServerPage(page) {
        if (!page?.id) return null;
        return {
            id: page.id,
            name: page.name,
            order: page.order,
            isDefault: page.isDefault ?? page.is_default ?? false,
            createdAt: page.createdAt ?? page.created_at ?? null,
            updatedAt: page.updatedAt ?? page.updated_at ?? null,
            syncVersion: this.normalizeSyncVersionValue(page.syncVersion ?? page.sync_version ?? null),
            deletedAt: page.deletedAt ?? page.deleted_at ?? null,
            shareId: page.shareId ?? page.share_id ?? null
        };
    },

    normalizeServerBoard(board) {
        if (!board?.id) return null;
        return {
            id: board.id,
            pageId: board.pageId ?? board.page_id ?? null,
            name: board.name,
            columnIndex: board.columnIndex ?? board.column_index ?? 0,
            order: board.order,
            createdAt: board.createdAt ?? board.created_at ?? null,
            updatedAt: board.updatedAt ?? board.updated_at ?? null,
            syncVersion: this.normalizeSyncVersionValue(board.syncVersion ?? board.sync_version ?? null),
            deletedAt: board.deletedAt ?? board.deleted_at ?? null,
            shareId: board.shareId ?? board.share_id ?? null,
            color: board.color ?? null
        };
    },

    normalizeServerBookmark(bookmark) {
        if (!bookmark?.id) return null;
        return {
            id: bookmark.id,
            boardId: bookmark.boardId ?? bookmark.board_id ?? null,
            title: bookmark.title,
            url: bookmark.url,
            description: bookmark.description,
            order: bookmark.order,
            createdAt: bookmark.createdAt ?? bookmark.created_at ?? null,
            updatedAt: bookmark.updatedAt ?? bookmark.updated_at ?? null,
            syncVersion: this.normalizeSyncVersionValue(bookmark.syncVersion ?? bookmark.sync_version ?? null),
            deletedAt: bookmark.deletedAt ?? bookmark.deleted_at ?? null
        };
    },

    normalizeSyncVersionValue(value) {
        if (value === null || value === undefined || value === '') {
            return null;
        }

        try {
            const normalized = BigInt(value);
            return normalized > 0n ? normalized.toString() : null;
        } catch (error) {
            return null;
        }
    },

    parseSyncVersion(value) {
        const normalized = this.normalizeSyncVersionValue(value);
        if (!normalized) return null;

        try {
            return BigInt(normalized);
        } catch (error) {
            return null;
        }
    },

    getMaxSyncVersion(rows = []) {
        let maxVersion = null;
        for (const row of rows) {
            const version = this.parseSyncVersion(row?.syncVersion ?? row?.sync_version ?? null);
            if (version === null) continue;
            if (maxVersion === null || version > maxVersion) {
                maxVersion = version;
            }
        }
        return maxVersion !== null ? maxVersion.toString() : null;
    },

    normalizeServerDataPayload(data = {}) {
        return {
            ...data,
            pages: Array.isArray(data.pages)
                ? data.pages.map(page => this.normalizeServerPage(page)).filter(Boolean)
                : [],
            boards: Array.isArray(data.boards)
                ? data.boards.map(board => this.normalizeServerBoard(board)).filter(Boolean)
                : [],
            bookmarks: Array.isArray(data.bookmarks)
                ? data.bookmarks.map(bookmark => this.normalizeServerBookmark(bookmark)).filter(Boolean)
                : []
        };
    },

    async getLocalDataCounts() {
        const [pages, boards, bookmarks] = await Promise.all([
            db.pages.count(),
            db.boards.count(),
            db.bookmarks.count()
        ]);
        return { pages, boards, bookmarks };
    },

    shouldUseDeltaSync(localCounts) {
        return (localCounts?.pages || 0) > 0 &&
            (localCounts?.boards || 0) > 0 &&
            (localCounts?.bookmarks || 0) > 0;
    },

    // ==================== DELTA SYNC METHODS ====================

    /**
     * Get the last delta sync checkpoint and user ID.
     * Supports legacy timestamp-only checkpoint values stored by older builds.
     */
    async getLastDeltaSyncState() {
        return new Promise((resolve) => {
            chrome.storage.local.get([this.DELTA_SYNC_KEY], (result) => {
                const stored = result[this.DELTA_SYNC_KEY] || null;
                if (!stored) {
                    resolve(null);
                    return;
                }

                if (typeof stored === 'string') {
                    resolve({ timestamp: stored, syncVersion: null, userId: null });
                    return;
                }

                resolve({
                    timestamp: stored.timestamp || null,
                    syncVersion: this.normalizeSyncVersionValue(stored.syncVersion),
                    userId: stored.userId || null
                });
            });
        });
    },

    async getLastDeltaSyncTime() {
        return this.getLastDeltaSyncState();
    },

    /**
     * Store the last delta sync checkpoint with user ID validation.
     */
    async setLastDeltaSyncState(checkpoint, userId) {
        const normalizedCheckpoint = {
            timestamp: checkpoint?.timestamp || null,
            syncVersion: this.normalizeSyncVersionValue(checkpoint?.syncVersion ?? null),
            userId: userId || null
        };

        return new Promise((resolve) => {
            chrome.storage.local.set({
                [this.DELTA_SYNC_KEY]: normalizedCheckpoint
            }, resolve);
        });
    },

    async setLastDeltaSyncTime(timestamp, userId) {
        return this.setLastDeltaSyncState({ timestamp }, userId);
    },

    // ==================== END DELTA SYNC METHODS ====================

    /**
     * Clear all auth-related data from chrome.storage (for logout)
     * This includes: user cache, sync version, subscription data, and ALL Supabase keys
     *
     * FIX: Aggressively clears ALL Supabase-related keys (sb-*) to prevent stale state
     * FIX: Also clears localStorage in case of fallback storage
     */
    async clearAuth(options = {}) {
        const preserveStoredUser = options.preserveStoredUser === true;
        const preserveSessionInvalidation = options.preserveSessionInvalidation === true;
        const knownKeys = [
            this.SYNC_VERSION_KEY,                 // lumilist_sync_version
            this.DELTA_SYNC_KEY,                   // lumilist_last_delta_sync (delta sync timestamp)
            'subscriptionStatus',                  // Subscription status cache
            'subscriptionDaysLeft',                // Days left cache
            'subscriptionData',                    // Full subscription data cache
            SUBSCRIPTION_LAST_KNOWN_KEY,           // Last known good subscription state (fallback during outages)
            SYNC_MANAGER_WALLPAPER_CLOUD_SYNC_STATE_STORAGE_KEY,
            SYNC_MANAGER_LOGIN_SYNC_STATE_STORAGE_KEY,
            SYNC_MANAGER_LOGIN_SYNC_COMPLETE_STORAGE_KEY,
            'sb-xbccmcszhnybxzlirjgk-auth-token',  // Supabase session token
            '_lastProcessedToken'                  // OAuth token deduplication fingerprint
        ].concat(SYNC_MANAGER_ACCOUNT_BOUNDARY_STORAGE_KEYS);
        if (!preserveStoredUser) {
            knownKeys.unshift(this.USER_KEY);
        }
        if (!preserveSessionInvalidation) {
            knownKeys.push(this.SESSION_INVALIDATED_KEY);
        }

        // FIX: Wrap in timeout to prevent hanging if Chrome storage API is frozen
        const clearPromise = new Promise((resolve, reject) => {
            // First, get ALL keys to find any Supabase-related ones we might have missed
            chrome.storage.local.get(null, (allData) => {
                const allKeys = Object.keys(allData || {});

                // Find all keys starting with 'sb-' (Supabase keys)
                const supabaseKeys = allKeys.filter(k => k.startsWith('sb-'));

                // Combine known keys with any discovered Supabase keys
                const keysToRemove = [...new Set([...knownKeys, ...supabaseKeys])];

                if (supabaseKeys.length > 0) {
                    
                }

                chrome.storage.local.remove(keysToRemove, () => {
                    if (chrome.runtime.lastError) {
                        console.error('clearAuth failed:', chrome.runtime.lastError);
                        reject(chrome.runtime.lastError);
                        return;
                    }

                    // Also clear localStorage in case Supabase fell back to it
                    try {
                        if (typeof localStorage !== 'undefined') {
                            const localStorageKeys = Object.keys(localStorage);
                            const supabaseLocalKeys = localStorageKeys.filter(k =>
                                k.startsWith('sb-') || k.includes('supabase')
                            );
                            supabaseLocalKeys.forEach(k => {
                                localStorage.removeItem(k);
                                
                            });
                            localStorage.removeItem('lumilist_theme_mode');
                        }
                    } catch (e) {
                        console.warn('clearAuth: localStorage cleanup failed:', e);
                    }

                    // Verify removal
                    chrome.storage.local.get(keysToRemove, (result) => {
                        const remainingEntries = Object.entries(result || {})
                            .filter(([key]) => keysToRemove.includes(key));
                        const problematicEntries = remainingEntries.filter(([key, value]) =>
                            !this._isBenignPostClearAuthKey(key, value)
                        );
                        if (problematicEntries.length > 0) {
                            console.warn('clearAuth: Some keys not cleared:', problematicEntries.map(([key]) => key));
                        } else {
                            
                        }
                        resolve();
                    });
                });
            });
        });

        // Race against timeout to prevent hanging if Chrome API is frozen
        const timeoutMs = 5000;
        try {
            await Promise.race([
                clearPromise,
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('clearAuth timeout')), timeoutMs)
                )
            ]);
        } catch (error) {
            console.error('clearAuth error:', error.message);
            // Continue with logout even if clear failed - better to let user out
        }
    },

    /**
     * Handle auth failure (invalid refresh token, 401/403 errors)
     * Preserves the local workspace, clears auth tokens, and notifies UI to show login
     *
     * @param {string} reason - Description of why auth failed
     */
    async handleAuthFailure(reason) {
        console.error('🔐 Auth failure detected:', reason);
        const storedUser = await this.getStoredUser();
        await this.markSessionInvalidated(reason, storedUser);

        // Clear subscription cache too
        await new Promise(resolve => {
            chrome.storage.local.remove([
                'subscriptionStatus',
                'subscriptionDaysLeft',
                'subscriptionData',
                SUBSCRIPTION_LAST_KNOWN_KEY
            ], resolve);
        });

        try {
            await this.clearAuth({
                preserveStoredUser: true,
                preserveSessionInvalidation: true
            });
        } catch (error) {
            console.warn('[SyncManager] Failed to clear auth tokens after session invalidation:', formatErrorForLog(error));
        }

        this._oauthLoginInProgress = false;
        this._supabase = null;

        // Notify UI to show login screen
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('lumilist-auth-failure', {
                detail: { reason }
            }));
        }
    },

    /**
     * Broadcast that login sync completed so other tabs can refresh UI from IndexedDB
     * without triggering their own server syncs.
     *
     * This is intentionally lightweight and local-only.
     */
    async _signalLoginSyncComplete(userId, action = null) {
        if (!userId || typeof chrome === 'undefined' || !chrome.storage?.local) return;
        const timestamp = Date.now();
        try {
            await chrome.storage.local.set({
                [SYNC_MANAGER_LOGIN_SYNC_COMPLETE_STORAGE_KEY]: {
                    userId,
                    timestamp,
                    action: action || null
                },
                [SYNC_MANAGER_LOGIN_SYNC_STATE_STORAGE_KEY]: {
                    userId,
                    phase: 'completed',
                    timestamp,
                    action: action || null
                }
            });
        } catch (e) {
            console.warn('Failed to signal login sync complete:', e);
        }
    },

    async _markLoginSyncPending(userId) {
        if (!userId || typeof chrome === 'undefined' || !chrome.storage?.local) return;
        try {
            await chrome.storage.local.set({
                [SYNC_MANAGER_LOGIN_SYNC_STATE_STORAGE_KEY]: {
                    userId,
                    phase: 'pending',
                    timestamp: Date.now(),
                    action: null
                }
            });
        } catch (e) {
            console.warn('Failed to mark login sync pending:', e);
        }
    },

    async _clearLoginSyncState() {
        if (typeof chrome === 'undefined' || !chrome.storage?.local?.remove) return;
        try {
            await chrome.storage.local.remove([
                SYNC_MANAGER_LOGIN_SYNC_STATE_STORAGE_KEY,
                SYNC_MANAGER_LOGIN_SYNC_COMPLETE_STORAGE_KEY
            ]);
        } catch (e) {
            console.warn('Failed to clear login sync state:', e);
        }
    },

    /**
     * Check if user is logged in
     * Uses cache-first approach: checks chrome.storage.local first (instant),
     * falls back to Supabase auth only if no cached user exists.
     * This ensures logged-in users never see the welcome screen due to auth hanging.
     *
     * FIX: Repopulates cache on network success to prevent future timeouts.
     * FIX: Clears orphaned session tokens on repeated timeouts.
     */
    async isLoggedIn() {
        // CACHE-FIRST: Check local storage for cached user (instant, never hangs)
        const cachedUser = await this.getStoredUser();
        if (cachedUser && cachedUser.id) {
            if (await this.isSessionInvalidatedForUser(cachedUser)) {
                console.warn('isLoggedIn: cached user present but session was invalidated, requiring login');
                return false;
            }
            
            return true;
        }

        const invalidation = await this.getSessionInvalidation();
        if (invalidation) {
            return false;
        }

        // NO CACHED USER: Fall back to Supabase auth with timeout
        const supabase = this.getSupabase();
        if (!supabase) return false;

        try {
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Auth timeout')), AUTH_TIMEOUTS.GET_SESSION)
            );
            const sessionPromise = supabase.auth.getSession();
            const { data: { session } } = await Promise.race([sessionPromise, timeoutPromise]);

            // FIX: Repopulate cache on success to prevent future network calls
            if (session?.user) {
                await this.setStoredUser({
                    id: session.user.id,
                    email: session.user.email
                });
                
            }

            return !!session;
        } catch (error) {
            const transientNetworkError = isLikelyTransientNetworkError(error);
            if (transientNetworkError) {
                this._markTransientNetworkFailure();
                console.warn('isLoggedIn: transient network/auth fetch issue:', formatErrorForLog(error));
                const recoveredUser = await this._recoverUserFromStoredSupabaseSession();
                if (recoveredUser?.id) {
                    if (await this.isSessionInvalidatedForUser(recoveredUser)) {
                        console.warn('isLoggedIn: recovered session ignored because it was already invalidated');
                        return false;
                    }
                    console.warn('isLoggedIn: recovered user from stored Supabase session during transient failure');
                    return true;
                }
            } else {
                console.error('isLoggedIn error:', error);
            }
            // Don't clear tokens on timeout - this breaks login when Supabase is slow
            // If user is truly logged out, logout() will clear tokens explicitly
            if (error.message === 'Auth timeout') {
                console.warn('isLoggedIn: Auth timeout - Supabase may be slow/unreachable');
            }
            return false; // No cached user and auth failed - show welcome screen
        }
    },

    // ==================== SUBSCRIPTION METHODS ====================

    /**
     * Get user's subscription from Supabase
     */
    async getSubscription() {
        const supabase = this.getSupabase();
        const user = await this.getUser();
        if (!supabase || !user) {
            globalThis.recordSubscriptionDebug?.('sync.subscription.get.skipped', {
                hasSupabase: Boolean(supabase),
                hasUser: Boolean(user),
                offline: this._isOffline || (typeof navigator !== 'undefined' && !navigator.onLine)
            });
            if (this._isOffline || (typeof navigator !== 'undefined' && !navigator.onLine) || this._isRecentlyTransientNetworkDegraded()) {
                return { subscription: null, fetchError: new Error('Subscription fetch deferred while network is degraded'), missing: false };
            }
            return { subscription: null, fetchError: null, missing: true };
        }

        try {
            const result = await this._fetchSubscriptionViaEdgeFunction(supabase);
            globalThis.recordSubscriptionDebug?.('sync.subscription.get.result', {
                hasSubscription: Boolean(result.subscription),
                missing: result.missing,
                fetchError: result.fetchError,
                subscription: result.subscription
            });

            if (result.fetchError) {
                if (isLikelyTransientNetworkError(result.fetchError)) {
                    this._markTransientNetworkFailure();
                    globalThis.recordSubscriptionDebug?.('sync.subscription.get.deferred', {
                        errorSummary: formatErrorForLog(result.fetchError)
                    });
                } else if (this._isLikelyAuthSessionError(result.fetchError)) {
                    globalThis.recordSubscriptionDebug?.('sync.subscription.get.auth_deferred', {
                        errorSummary: formatErrorForLog(result.fetchError)
                    });
                } else {
                    console.error('Error fetching subscription:', result.fetchError);
                }
                return result;
            }

            return result;
        } catch (e) {
            if (isLikelyTransientNetworkError(e)) {
                this._markTransientNetworkFailure();
                globalThis.recordSubscriptionDebug?.('sync.subscription.get.deferred', {
                    errorSummary: formatErrorForLog(e)
                });
            } else if (this._isLikelyAuthSessionError(e)) {
                globalThis.recordSubscriptionDebug?.('sync.subscription.get.auth_deferred', {
                    errorSummary: formatErrorForLog(e)
                });
            } else {
                console.error('Subscription fetch error:', e);
            }
            return { subscription: null, fetchError: e, missing: false };
        }
    },

    /**
     * Fetch subscription from server and return computed status
     * Used for visibility change re-validation (bypasses cached data)
     * Returns { status, daysLeft, subscription } or null on error
     */
    async fetchSubscriptionFromServer() {
        try {
            const result = await this.getSubscription();
            if (!result) return null;

            if (result.fetchError) {
                if (isLikelyTransientNetworkError(result.fetchError)) {
                    this._markTransientNetworkFailure();
                    // Keep cached subscription status on transient fetch issues.
                    return null;
                }
                if (this._isLikelyAuthSessionError(result.fetchError)) {
                    globalThis.recordSubscriptionDebug?.('sync.subscription.fetch_server.auth_deferred', {
                        errorSummary: formatErrorForLog(result.fetchError)
                    });
                    return null;
                }
                return { status: null, daysLeft: 0, subscription: null };
            }

            if (result.missing || !result.subscription) {
                if (this._isOffline || (typeof navigator !== 'undefined' && !navigator.onLine) || this._isRecentlyTransientNetworkDegraded()) {
                    this._markTransientNetworkFailure();
                    return null;
                }
                // Fail closed: missing subscription row should not grant write access.
                // Server-side RLS also denies writes in this state.
                return { status: null, daysLeft: 0, subscription: null };
            }

            const subscription = result.subscription;
            const status = this.getEffectiveStatus(subscription);
            const daysLeft = this.getDaysRemaining(subscription, status);
            globalThis.recordSubscriptionDebug?.('sync.subscription.fetch_server.resolved', {
                status,
                daysLeft,
                subscription
            });

            return { status, daysLeft, subscription };
        } catch (error) {
            console.error('[fetchSubscriptionFromServer] Error:', error);
            globalThis.recordSubscriptionDebug?.('sync.subscription.fetch_server.error', {
                error,
                errorSummary: formatErrorForLog(error)
            });
            return null;
        }
    },

    async _applySubscriptionStateFromPull(serverData, source = 'pull') {
        const subscriptionState = serverData?.subscriptionState || 'missing';
        globalThis.recordSubscriptionDebug?.('sync.subscription.pull.apply.start', {
            source,
            subscriptionState,
            subscription: serverData?.subscription || null
        });

        if (subscriptionState === 'deferred') {
            globalThis.recordSubscriptionDebug?.('sync.subscription.pull.apply.deferred', { source });
            return;
        }

        if (serverData?.subscription) {
            const status = this.getEffectiveStatus(serverData.subscription);
            const daysLeft = this.getDaysRemaining(serverData.subscription, status);
            await this.storeSubscriptionStatus(status, daysLeft, serverData.subscription);
            globalThis.recordSubscriptionDebug?.('sync.subscription.pull.apply.stored', {
                source,
                status,
                daysLeft,
                subscription: serverData.subscription
            });
            return;
        }

        // Authoritative "missing row" response should fail closed.
        await this.storeSubscriptionStatus(null, 0, null);
        globalThis.recordSubscriptionDebug?.('sync.subscription.pull.apply.fail_closed', { source });
    },

    getFailureRecoveryGraceEnd(subscription) {
        if (!subscription) return null;

        const status = String(subscription.status || '').toLowerCase();
        if (status !== 'pending' && status !== 'past_due' && status !== 'halted' && status !== 'grace') {
            return null;
        }

        if (!subscription.subscription_ends_at) return null;
        const accessEnd = new Date(subscription.subscription_ends_at);
        if (!Number.isFinite(accessEnd.getTime())) return null;
        return new Date(accessEnd.getTime() + 7 * 24 * 60 * 60 * 1000);
    },

    hasPaidOrGraceAccessAnchors(subscription) {
        if (!subscription || typeof subscription !== 'object') return false;

        return Boolean(
            subscription.subscription_started_at ||
            subscription.subscription_ends_at ||
            subscription.billing_cycle_ends_at ||
            subscription.grace_ends_at
        );
    },

    shouldPreserveTrialWhileCheckoutIncomplete(subscription) {
        if (!subscription || typeof subscription !== 'object') return false;

        const rawStatus = String(subscription.status || '').toLowerCase();
        if (
            rawStatus === 'active' ||
            rawStatus === 'past_due' ||
            rawStatus === 'halted' ||
            rawStatus === 'grace' ||
            rawStatus === 'cancelled' ||
            rawStatus === 'paused'
        ) {
            return false;
        }

        return !this.hasPaidOrGraceAccessAnchors(subscription);
    },

    getTrialWindowEnd(subscription) {
        if (!subscription || typeof subscription !== 'object') return null;

        if (subscription.trial_ends_at) {
            const explicitTrialEnd = new Date(subscription.trial_ends_at);
            if (Number.isFinite(explicitTrialEnd.getTime())) {
                return explicitTrialEnd;
            }
        }

        if (!this.shouldPreserveTrialWhileCheckoutIncomplete(subscription)) {
            return null;
        }

        const trialStartSource = subscription.trial_started_at || subscription.created_at || null;
        if (!trialStartSource) return null;

        const trialStart = new Date(trialStartSource);
        if (!Number.isFinite(trialStart.getTime())) return null;

        return new Date(trialStart.getTime() + 30 * 24 * 60 * 60 * 1000);
    },

    /**
     * Calculate effective subscription status based on dates
     * Returns: 'trial', 'grace', 'expired', 'active'
     * FIX [Issue #4]: Handle all possible Razorpay subscription statuses explicitly
     */
    getEffectiveStatus(subscription) {
        if (!subscription) return 'expired';

        const now = new Date();
        const { status, grace_ends_at, subscription_ends_at } = subscription;
        const normalizedStatus = String(status || '').toLowerCase();
        const trialEnd = this.getTrialWindowEnd(subscription);
        const preserveTrialWhileCheckoutIncomplete =
            Boolean(trialEnd && trialEnd > now) &&
            this.shouldPreserveTrialWhileCheckoutIncomplete(subscription);

        if (preserveTrialWhileCheckoutIncomplete) {
            return 'trial';
        }

        // Active paid subscription
        if (normalizedStatus === 'active') {
            if (subscription_ends_at) {
                const subEnd = new Date(subscription_ends_at);
                // Add 6-hour buffer for webhook delivery on renewal
                // This prevents showing "expired" while renewal payment is processing
                // Razorpay may take minutes to send the webhook after charging
                const bufferMs = 6 * 60 * 60 * 1000; // 6 hours
                const bufferEnd = new Date(subEnd.getTime() + bufferMs);

                if (now > bufferEnd) {
                    // Past buffer period - truly expired or webhook failed
                    return 'expired';
                }
                // Within buffer or before end date - keep as active
            }
            return 'active';
        }

        // Trial period
        if (normalizedStatus === 'trial') {
            if (trialEnd && trialEnd > now) {
                return 'trial';
            }
            // Trial ended, check grace period
            const graceEnd = grace_ends_at
                ? new Date(grace_ends_at)
                : (trialEnd ? new Date(trialEnd.getTime() + 7 * 24 * 60 * 60 * 1000) : null);
            if (now < graceEnd) {
                return 'grace';
            }
            return 'expired';
        }

        // Grace period
        if (normalizedStatus === 'grace') {
            const failureGraceEnd = this.getFailureRecoveryGraceEnd(subscription);
            if (failureGraceEnd && failureGraceEnd > now) {
                return 'grace';
            }
            if (grace_ends_at && new Date(grace_ends_at) > now) {
                return 'grace';
            }
            return 'expired';
        }

        // Cancelled - access until end date, then 30-day grace period
        if (normalizedStatus === 'cancelled') {
            if (subscription_ends_at) {
                const subEnd = new Date(subscription_ends_at);
                if (subEnd > now) {
                    return 'active'; // Still has full access until subscription_ends_at
                }
                // Subscription ended - check 30-day grace period
                const graceEnd = new Date(subEnd.getTime() + 30 * 24 * 60 * 60 * 1000);
                if (now < graceEnd) {
                    return 'grace'; // Read-only access for 30 days
                }
            }
            return 'expired';
        }

        // FIX [Issue #4]: Handle Razorpay-specific statuses explicitly
        // For created/pending/authenticated (payment not completed), DO NOT grant premium
        // unless user already has remaining paid time (subscription_ends_at in future).
        if (normalizedStatus === 'created' || normalizedStatus === 'pending' || normalizedStatus === 'authenticated') {
            if (subscription_ends_at) {
                const subEnd = new Date(subscription_ends_at);
                if (subEnd > now) {
                    return 'active';
                }
            }

            const failureGraceEnd = this.getFailureRecoveryGraceEnd(subscription);
            if (failureGraceEnd && failureGraceEnd > now) {
                return 'grace';
            }

            // Fall back to trial/grace based on trial dates
            if (trialEnd && trialEnd > now) {
                return 'trial';
            }
            if (grace_ends_at && new Date(grace_ends_at) > now) {
                return 'grace';
            }
            if (trialEnd) {
                const graceEnd = new Date(trialEnd.getTime() + 7 * 24 * 60 * 60 * 1000);
                if (now < graceEnd) {
                    return 'grace';
                }
            }
            return 'expired';
        }

        // 'paused' - Razorpay paused subscription (user requested or admin action)
        // Keep access while the paid-access window is still valid.
        if (normalizedStatus === 'paused') {
            if (!subscription_ends_at) return 'active';
            return new Date(subscription_ends_at) > now ? 'active' : 'expired';
        }

        // 'past_due' - Razorpay failed to charge, but retry is still in progress.
        // Keep full access only while the paid-access window is still valid.
        if (normalizedStatus === 'past_due') {
            if (!subscription_ends_at) return 'active';
            if (new Date(subscription_ends_at) > now) {
                return 'active';
            }
            const failureGraceEnd = this.getFailureRecoveryGraceEnd(subscription);
            if (failureGraceEnd && failureGraceEnd > now) {
                return 'grace';
            }
            if (grace_ends_at && new Date(grace_ends_at) > now) {
                return 'grace';
            }
            return 'expired';
        }

        // 'halted' - Razorpay stopped retrying.
        // Keep full access through the paid-access window, then fall back to read-only grace.
        if (normalizedStatus === 'halted') {
            if (subscription_ends_at && new Date(subscription_ends_at) > now) {
                return 'active';
            }
            const failureGraceEnd = this.getFailureRecoveryGraceEnd(subscription);
            if (failureGraceEnd && failureGraceEnd > now) {
                return 'grace';
            }
            if (grace_ends_at && new Date(grace_ends_at) > now) {
                return 'grace';
            }
            return 'expired';
        }

        if (normalizedStatus === 'expired') {
            return 'expired';
        }

        // Unknown status - log error but fail safe to grace instead of expired
        // This prevents users from being locked out due to unexpected status values
        console.error(`[Subscription] Unknown status '${normalizedStatus}' - defaulting to grace period (fail-safe)`);
        return 'grace';
    },

    /**
     * Get days remaining for current status
     */
    getDaysRemaining(subscription, status) {
        if (!subscription) return 0;

        const now = new Date();
        let endDate;
        const trialEnd = this.getTrialWindowEnd(subscription);

        if (status === 'trial') {
            endDate = trialEnd;
        } else if (status === 'grace') {
            // Grace period end date calculation
            if (subscription.grace_ends_at) {
                endDate = new Date(subscription.grace_ends_at);
            } else if (String(subscription.status || '').toLowerCase() === 'cancelled' && subscription.subscription_ends_at) {
                // Cancelled subscriber grace: 30 days after subscription ended
                endDate = new Date(new Date(subscription.subscription_ends_at).getTime() + 30 * 24 * 60 * 60 * 1000);
            } else if (
                (
                    String(subscription.status || '').toLowerCase() === 'pending' ||
                    String(subscription.status || '').toLowerCase() === 'past_due' ||
                    String(subscription.status || '').toLowerCase() === 'halted' ||
                    String(subscription.status || '').toLowerCase() === 'grace'
                ) &&
                subscription.subscription_ends_at
            ) {
                // Failed-payment grace: 7 days after the paid-access offset window ends.
                endDate = new Date(new Date(subscription.subscription_ends_at).getTime() + 7 * 24 * 60 * 60 * 1000);
            } else if (trialEnd) {
                // Trial grace: 7 days after trial ended
                endDate = new Date(trialEnd.getTime() + 7 * 24 * 60 * 60 * 1000);
            }
        } else if (status === 'active' && subscription.subscription_ends_at) {
            endDate = new Date(subscription.subscription_ends_at);
        } else {
            return 0;
        }

        if (!endDate || !Number.isFinite(endDate.getTime())) {
            return 0;
        }

        const daysLeft = Math.ceil((endDate - now) / (1000 * 60 * 60 * 24));
        return Math.max(0, daysLeft);
    },

    /**
     * Store subscription status in chrome.storage for quick access
     * Also stores raw subscription object for UI to check cancelled state
     */
    async storeSubscriptionStatus(status, daysLeft, subscription = null) {
        try {
            const payload = {
                subscriptionStatus: status,
                subscriptionDaysLeft: daysLeft,
                subscriptionData: subscription
            };

            if (isKnownSubscriptionStatus(status)) {
                payload[SUBSCRIPTION_LAST_KNOWN_KEY] = {
                    status,
                    daysLeft: Number.isFinite(daysLeft) ? daysLeft : 0,
                    subscription: subscription || null,
                    savedAt: new Date().toISOString()
                };
            }

            await chrome.storage.local.set(payload);
            globalThis.recordSubscriptionDebug?.('sync.subscription.store', {
                status,
                daysLeft,
                subscription
            });
        } catch (e) {
            console.error('Error storing subscription status:', e);
            globalThis.recordSubscriptionDebug?.('sync.subscription.store.error', {
                error: e,
                status,
                daysLeft,
                subscription
            });
        }
    },

    /**
     * Get stored subscription status (for quick checks without network)
     */
    async getStoredSubscriptionStatus() {
        try {
            const result = await chrome.storage.local.get([
                'subscriptionStatus',
                'subscriptionDaysLeft',
                'subscriptionData',
                SUBSCRIPTION_LAST_KNOWN_KEY
            ]);

            const status = result.subscriptionStatus ?? null;
            const daysLeft = Number.isFinite(result.subscriptionDaysLeft) ? result.subscriptionDaysLeft : 0;
            const subscription = result.subscriptionData || null;

            if (subscription) {
                const derivedStatus = this.getEffectiveStatus(subscription);
                const derivedDaysLeft = this.getDaysRemaining(subscription, derivedStatus);
                globalThis.recordSubscriptionDebug?.('sync.subscription.stored.read', {
                    rawStatus: status,
                    rawDaysLeft: daysLeft,
                    derivedStatus,
                    derivedDaysLeft,
                    subscription
                });

                if (isKnownSubscriptionStatus(derivedStatus)) {
                    const statusMatchesDerived = isKnownSubscriptionStatus(status) && status === derivedStatus;
                    const daysMatchDerived = Number.isFinite(result.subscriptionDaysLeft) && daysLeft === derivedDaysLeft;

                    if (!statusMatchesDerived || !daysMatchDerived) {
                        globalThis.recordSubscriptionDebug?.('sync.subscription.stored.corrected', {
                            rawStatus: status,
                            rawDaysLeft: daysLeft,
                            correctedStatus: derivedStatus,
                            correctedDaysLeft: derivedDaysLeft,
                            subscription
                        });
                        return {
                            status: derivedStatus,
                            daysLeft: derivedDaysLeft,
                            subscription,
                            source: statusMatchesDerived ? 'current-derived' : 'current-corrected',
                            isStale: !statusMatchesDerived
                        };
                    }
                }
            }

            if (isKnownSubscriptionStatus(status)) {
                globalThis.recordSubscriptionDebug?.('sync.subscription.stored.current', {
                    status,
                    daysLeft,
                    subscription
                });
                return { status, daysLeft, subscription, source: 'current', isStale: false };
            }

            // Preserve behavior for explicit fail-closed state with no fallback.
            const lastKnown = result[SUBSCRIPTION_LAST_KNOWN_KEY];
            if (status === null && lastKnown && isKnownSubscriptionStatus(lastKnown.status)) {
                globalThis.recordSubscriptionDebug?.('sync.subscription.stored.last_known', {
                    status: lastKnown.status,
                    daysLeft: lastKnown.daysLeft,
                    subscription: lastKnown.subscription || null
                });
                return {
                    status: lastKnown.status,
                    daysLeft: Number.isFinite(lastKnown.daysLeft) ? lastKnown.daysLeft : 0,
                    subscription: lastKnown.subscription || null,
                    source: 'last-known',
                    isStale: true,
                    staleSince: lastKnown.savedAt || null
                };
            }

            // Legacy recovery path: if raw subscription row exists, derive effective status.
            if (status === null && subscription) {
                const derivedStatus = this.getEffectiveStatus(subscription);
                const derivedDaysLeft = this.getDaysRemaining(subscription, derivedStatus);
                if (isKnownSubscriptionStatus(derivedStatus)) {
                    globalThis.recordSubscriptionDebug?.('sync.subscription.stored.derived_from_raw', {
                        status: derivedStatus,
                        daysLeft: derivedDaysLeft,
                        subscription
                    });
                    return {
                        status: derivedStatus,
                        daysLeft: derivedDaysLeft,
                        subscription,
                        source: 'derived',
                        isStale: true
                    };
                }
            }

            globalThis.recordSubscriptionDebug?.('sync.subscription.stored.unknown', {
                rawStatus: status,
                rawDaysLeft: daysLeft,
                subscription
            });
            return {
                status,
                daysLeft,
                subscription,
                source: 'unknown',
                isStale: false
            };
        } catch (e) {
            globalThis.recordSubscriptionDebug?.('sync.subscription.stored.error', {
                error: e,
                errorSummary: formatErrorForLog(e)
            });
            return { status: null, daysLeft: 0, subscription: null, source: 'unknown', isStale: false };
        }
    },

    // ==================== END SUBSCRIPTION METHODS ====================

    /**
     * Logout user
     * FIX: Clear auth FIRST to prevent race condition where background signOut
     * could write tokens back after clearAuth completes.
     * FIX: Clear BackgroundSync queue to prevent old user's operations from running
     */
    async logout() {
        this._oauthLoginInProgress = false;

        // 0. Clear BackgroundSync queue FIRST (prevents push after signout)
        try {
            await chrome.runtime.sendMessage({ action: 'clearSyncQueue' });
            
        } catch (e) {
            console.warn('Failed to clear sync queue:', e.message);
        }

        // 1. Clear auth FIRST to prevent background writes from corrupting state
        await this.clearAuth();

        // 2. Null client to prevent any more storage operations
        const supabase = this._supabase;
        this._supabase = null;

        // 3. Attempt server-side signout (best effort, already logged out locally)
        if (supabase) {
            try {
                // Use local-only signout to avoid network dependency
                // Short timeout since local cleanup is already done
                await Promise.race([
                    supabase.auth.signOut({ scope: 'local' }),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('signOut timeout')), AUTH_TIMEOUTS.SIGN_OUT))
                ]);
            } catch (error) {
                // Ignore - local cleanup already done, this is just best-effort server notify
                console.warn('signOut error (local cleanup already done):', error.message);
            }
        }

        return { success: true };
    },

    /**
     * Login with Google OAuth (redirect approach)
     * DISABLED: Google Login removed per user request
     */
    async loginWithGoogle() {
        return { success: false, error: 'Login is currently disabled.' };
    },

    /**
     * Pull data from Supabase (normalized tables)
     * FIX [Issue #20]: Added 30-second timeout to prevent page load hanging forever
     *
     * @param {boolean} isDeltaSync - If true, only fetch items modified since last sync
     *                                (uses stored timestamp with 5-second buffer for clock skew)
     */
    async pull(isDeltaSync = false) {
        globalThis.recordSubscriptionDebug?.('sync.subscription.pull.start', {
            isDeltaSync
        });
        // FIX [Issue #4]: Check offline status before making network requests
        if (!navigator.onLine) {
            
            return { success: false, error: 'Offline', isOffline: true };
        }

        const supabase = this.getSupabase();
        if (!supabase) {
            return { success: false, error: 'Supabase not initialized' };
        }

        const user = await this.getUser();
        if (!user) {
            return { success: false, error: 'Not logged in' };
        }

        // FIX [Issue #20]: Timeout wrapper to prevent hanging forever
        const PULL_TIMEOUT_MS = 30000; // 30 seconds
        const withTimeout = (promise, timeoutMs) => {
            return Promise.race([
                promise,
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error(`Pull timed out after ${timeoutMs / 1000}s`)), timeoutMs)
                )
            ]);
        };

        // Keep this outside try so catch can include it in diagnostics.
        let lastSyncTime = null;
        let lastSyncVersion = null;

        try {
            // Delta sync: Get last sync checkpoint for incremental pull
            if (isDeltaSync) {
                const stored = await this.getLastDeltaSyncState();
                // Validate user ID to prevent data mixing on account switch
                if (stored && stored.userId === user.id) {
                    lastSyncTime = stored.timestamp || null;
                    lastSyncVersion = this.normalizeSyncVersionValue(stored.syncVersion);
                } else if (stored && stored.userId !== user.id) {
                    
                }
            }

            // Build queries - with a syncVersion delta filter when we have a valid checkpoint.
            // IMPORTANT: Supabase has a default limit of 1000 rows. We must use .range()
            // to fetch all items up to the app's limits
            let pagesQuery = supabase.from('pages').select('*').eq('user_id', user.id);
            let boardsQuery = supabase.from('boards').select('*').eq('user_id', user.id);
            let bookmarksQuery = supabase.from('bookmarks').select('*').eq('user_id', user.id);

            if (lastSyncVersion) {
                pagesQuery = pagesQuery.gt('sync_version', lastSyncVersion).order('sync_version', { ascending: true }).range(0, this.SYNC_PAGE_LIMIT - 1);
                boardsQuery = boardsQuery.gt('sync_version', lastSyncVersion).order('sync_version', { ascending: true }).range(0, this.SYNC_BOARD_LIMIT - 1);
                bookmarksQuery = bookmarksQuery.gt('sync_version', lastSyncVersion).order('sync_version', { ascending: true }).range(0, this.SYNC_BOOKMARK_LIMIT - 1);
            } else if (lastSyncTime) {
                // Legacy fallback for older local checkpoints that only stored timestamps.
                const bufferTime = new Date(new Date(lastSyncTime).getTime() - 5000).toISOString();

                pagesQuery = pagesQuery.gte('updated_at', bufferTime).order('updated_at', { ascending: true }).range(0, this.SYNC_PAGE_LIMIT - 1);
                boardsQuery = boardsQuery.gte('updated_at', bufferTime).order('updated_at', { ascending: true }).range(0, this.SYNC_BOARD_LIMIT - 1);
                bookmarksQuery = bookmarksQuery.gte('updated_at', bufferTime).order('updated_at', { ascending: true }).range(0, this.SYNC_BOOKMARK_LIMIT - 1);
            } else {
                pagesQuery = pagesQuery.order('order').range(0, this.SYNC_PAGE_LIMIT - 1);
                boardsQuery = boardsQuery.order('order').range(0, this.SYNC_BOARD_LIMIT - 1);
                bookmarksQuery = bookmarksQuery.order('order').range(0, this.SYNC_BOOKMARK_LIMIT - 1);
            }

            // newSyncTime will be calculated AFTER we get server data
            // using MAX(updated_at) from the response - this uses SERVER's clock, not client's
            let newSyncTime = null;
            let newSyncVersion = lastSyncVersion;

            // Fetch all data in parallel (including trashed items for cross-device sync)
            // Use .maybeSingle() for sync_metadata and subscriptions to avoid 406 errors for new users.
            // Retry once when all query errors look like transient network fetch failures.
            const runPullQueries = () => withTimeout(
                Promise.all([
                    pagesQuery,
                    boardsQuery,
                    bookmarksQuery,
                    Promise.resolve({ data: null, error: null }),
                    this.getSubscription()
                ]),
                PULL_TIMEOUT_MS
            );

            let pagesRes;
            let boardsRes;
            let bookmarksRes;
            let metaRes;
            let subscriptionRes;
            let queryErrors = [];

            for (let attempt = 0; attempt < 2; attempt++) {
                [pagesRes, boardsRes, bookmarksRes, metaRes, subscriptionRes] = await runPullQueries();
                queryErrors = [pagesRes.error, boardsRes.error, bookmarksRes.error].filter(Boolean);
                if (queryErrors.length === 0) break;

                const allNetworkErrors = queryErrors.every(isLikelyNetworkFetchError);
                if (attempt === 0 && allNetworkErrors) {
                    await new Promise(resolve => setTimeout(resolve, 400));
                    continue;
                }
                break;
            }

            // Log delta sync results
            if (lastSyncVersion || lastSyncTime) {
                
            }

            // Check for auth errors (401/403) - indicates invalid session/refresh token
            const isAuthError = (error) => {
                if (!error) return false;
                const code = error.code?.toString() || '';
                const message = error.message?.toLowerCase() || '';
                return code === '401' || code === '403' || code === 'PGRST301' ||
                       message.includes('jwt') || message.includes('token') ||
                       message.includes('unauthorized') || message.includes('forbidden');
            };

            // Check all responses for auth errors first
            for (const res of [pagesRes, boardsRes, bookmarksRes]) {
                if (res.error && isAuthError(res.error)) {
                    console.error('🔐 Auth error in pull():', res.error);
                    await this.handleAuthFailure('Session expired - please login again');
                    return { success: false, error: 'Session expired', isAuthError: true };
                }
            }

            if (queryErrors.length > 0) {
                if (pagesRes.error) throw pagesRes.error;
                if (boardsRes.error) throw boardsRes.error;
                if (bookmarksRes.error) throw bookmarksRes.error;
            }

            const normalizedData = this.normalizeServerDataPayload({
                pages: pagesRes.data || [],
                boards: boardsRes.data || [],
                bookmarks: bookmarksRes.data || []
            });

            const allSyncVersionRows = [
                ...(pagesRes.data || []),
                ...(boardsRes.data || []),
                ...(bookmarksRes.data || [])
            ];
            const maxSyncVersion = this.getMaxSyncVersion(allSyncVersionRows);
            if (maxSyncVersion) {
                newSyncVersion = maxSyncVersion;
            }

            // Keep updated_at for diagnostics/display and legacy fallback.
            const allUpdatedAts = [
                ...(pagesRes.data || []).map(p => p.updated_at),
                ...(boardsRes.data || []).map(b => b.updated_at),
                ...(bookmarksRes.data || []).map(b => b.updated_at)
            ].filter(Boolean);

            if (allUpdatedAts.length > 0) {
                // Use the latest updated_at from server data
                const maxTime = new Date(Math.max(...allUpdatedAts.map(d => new Date(d).getTime())));
                newSyncTime = maxTime.toISOString();
                
            } else {
                // No data returned - use client time as fallback (safe for empty results)
                newSyncTime = new Date().toISOString();
                
            }

            const version = metaRes.data?.data_version || 0;
            const syncedAt = metaRes.data?.last_synced_at || new Date().toISOString();
            if (metaRes.error) {
                console.warn(`[SyncManager] pull: failed to refresh wallpaper cloud sync state: ${formatErrorForLog(metaRes.error)}`);
            }

            // Keep subscription status stable when only the subscription query is transiently failing.
            let subscription = null;
            let subscriptionState = 'missing';
            if (subscriptionRes.fetchError) {
                const subscriptionErrorSummary = formatErrorForLog(subscriptionRes.fetchError);
                if (isLikelyTransientNetworkError(subscriptionRes.fetchError)) {
                    subscriptionState = 'deferred';
                    globalThis.recordSubscriptionDebug?.('sync.subscription.pull.deferred', {
                        errorSummary: subscriptionErrorSummary
                    });
                } else if (this._isLikelyAuthSessionError(subscriptionRes.fetchError)) {
                    subscriptionState = 'deferred';
                    globalThis.recordSubscriptionDebug?.('sync.subscription.pull.auth_deferred', {
                        errorSummary: subscriptionErrorSummary
                    });
                } else {
                    subscriptionState = 'missing';
                    console.warn(`[SyncManager] pull: subscription query failed, defaulting to fail-closed status: ${subscriptionErrorSummary}`);
                }
            } else if (subscriptionRes.subscription) {
                subscription = subscriptionRes.subscription;
                subscriptionState = 'present';
            }

            // Store the server version for conflict detection
            await new Promise((resolve) => {
                chrome.storage.local.set({ [this.SYNC_VERSION_KEY]: version }, resolve);
            });

            return {
                success: true,
                data: {
                    ...normalizedData,
                    subscription,
                    subscriptionState,
                    syncedAt
                },
                version,
                newSyncTime,
                newSyncVersion
            };
        } catch (error) {
            globalThis.recordSubscriptionDebug?.('sync.subscription.pull.error', {
                error,
                errorSummary: formatErrorForLog(error)
            });
            const diagnosticId = `pull-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            let cachedUser = null;
            try {
                cachedUser = await this.getStoredUser();
            } catch (e) {
                // Diagnostics only - ignore read failures.
            }

            const debug = {
                diagnosticId,
                isDeltaSync,
                pullTimeoutMs: PULL_TIMEOUT_MS,
                lastSyncTime,
                userId: user?.id || null,
                hasCachedUser: !!cachedUser?.id,
                cachedUserId: cachedUser?.id || null
            };

            const transientNetworkError = isLikelyTransientNetworkError(error);
            if (transientNetworkError) {
                this._markTransientNetworkFailure();
                debug.hint = navigator.onLine
                    ? 'Check ad blocker, firewall, VPN/DNS, or temporary Supabase connectivity'
                    : 'Browser is offline';
            }

            this._captureError(error, 'pull', debug);
            return {
                success: false,
                error: formatErrorForLog(error),
                debug,
                diagnosticId,
                isOffline: !navigator.onLine,
                isTransientNetworkError: transientNetworkError
            };
        }
    },

    // NOTE: push() and exportLocalData() removed - all push operations now handled by BackgroundSync
    // This prevents race conditions between two sync systems
    // See background-sync.js for the unified sync implementation

    /**
     * Recalculate board orders after merge to fix conflicts
     */
    async recalculateBoardOrders(options = {}) {
        let updatedCount = 0;
        const shouldQueueSync = options.queueSync === true;
        const shouldTouchUpdatedAt = options.touchUpdatedAt === true;
        try {
            const allBoards = await db.boards.toArray();

            // Group boards by pageId and columnIndex
            const groupedBoards = {};
            for (const board of allBoards) {
                const pageId = board.pageId ?? board.page_id ?? '';
                const columnIndex = board.columnIndex ?? board.column_index ?? 0;
                const key = `${pageId}-${columnIndex}`;
                if (!groupedBoards[key]) {
                    groupedBoards[key] = [];
                }
                groupedBoards[key].push(board);
            }

            // For each group, sort by existing order then createdAt, then reassign orders
            for (const key of Object.keys(groupedBoards)) {
                const boards = groupedBoards[key];
                boards.sort((a, b) => {
                    if (a.order !== undefined && b.order !== undefined) {
                        return a.order - b.order;
                    }
                    if (a.createdAt && b.createdAt) {
                        return new Date(a.createdAt) - new Date(b.createdAt);
                    }
                    // UUIDs are strings, use localeCompare instead of numeric subtraction
                    return (a.id || '').localeCompare(b.id || '');
                });

                for (let i = 0; i < boards.length; i++) {
                    if (boards[i].order !== i) {
                        const changes = { order: i };
                        if (shouldTouchUpdatedAt) {
                            changes.updatedAt = new Date().toISOString();
                        }
                        await db.boards.update(boards[i].id, changes);
                        updatedCount++;
                        // Merge/startup normalization must stay local-only.
                        if (shouldQueueSync) {
                            try {
                                const updated = await db.boards.get(boards[i].id);
                                if (updated && typeof queueSyncToBackground === 'function') {
                                    await queueSyncToBackground('upsert', 'boards', boards[i].id, updated);
                                }
                            } catch (e) {
                                console.warn('Failed to queue board order fix for sync:', e);
                            }
                        }
                    }
                }
            }

            return updatedCount;
        } catch (error) {
            console.error('Error recalculating board orders:', error);
            return updatedCount;
        }
    },

    /**
     * Server-driven mutations are not local user actions. Keep undo/redo stack
     * consistent by resetting history whenever sync mutates local data.
     */
    async clearUndoRedoHistoryFromSync(reason = 'sync_mutation', options = {}) {
        if (typeof db === 'undefined' || !db.historyEntries || !db.historyState) {
            return false;
        }

        const preserveAfterSeqRaw = Number(options?.preserveAfterSeq);
        const preserveAfterSeq = Number.isFinite(preserveAfterSeqRaw) && preserveAfterSeqRaw > 0
            ? Math.floor(preserveAfterSeqRaw)
            : 0;

        try {
            await db.transaction('rw', db.historyEntries, db.historyState, async () => {
                if (preserveAfterSeq > 0) {
                    // Preserve entries newer than the baseline by deleting only the
                    // older prefix. Avoid reindexing so repeated clears in the same
                    // sync run still preserve the same "newer than baseline" range.
                    await db.historyEntries.where('seq').belowOrEqual(preserveAfterSeq).delete();
                    const newestEntry = await db.historyEntries.orderBy('seq').last();
                    const newestSeq = Number(newestEntry?.seq) || 0;

                    await db.historyState.clear();
                    await db.historyState.put({
                        id: SYNC_UNDO_REDO_HISTORY_STATE_ID,
                        cursorSeq: newestSeq,
                        headSeq: newestSeq,
                        maxDepth: SYNC_UNDO_REDO_HISTORY_MAX_DEPTH_DEFAULT
                    });
                    return;
                }

                await db.historyEntries.clear();
                await db.historyState.clear();
                await db.historyState.put({
                    id: SYNC_UNDO_REDO_HISTORY_STATE_ID,
                    cursorSeq: 0,
                    headSeq: 0,
                    maxDepth: SYNC_UNDO_REDO_HISTORY_MAX_DEPTH_DEFAULT
                });
            });
            if (preserveAfterSeq > 0) {
                console.log(`[SyncManager] Cleared undo/redo history up to seq ${preserveAfterSeq} (${reason})`);
            } else {
                console.log(`[SyncManager] Cleared undo/redo history (${reason})`);
            }
            return true;
        } catch (error) {
            console.warn(`[SyncManager] Failed to clear undo/redo history (${reason}):`, error);
            return false;
        }
    },

    async getUndoRedoHeadSeq() {
        if (typeof db === 'undefined' || !db.historyState) {
            return 0;
        }

        try {
            const state = await db.historyState.get(SYNC_UNDO_REDO_HISTORY_STATE_ID);
            return Number(state?.headSeq) || 0;
        } catch (error) {
            console.warn('[SyncManager] Failed to read undo/redo head seq:', error);
            return 0;
        }
    },

    /**
     * Clean up local items that were permanently deleted on server.
     * Called UNCONDITIONALLY in autoSyncOnLoad to handle cross-browser permanent deletes.
     *
     * Key insight: Delta sync only returns MODIFIED items. When an item is permanently
     * deleted (hard delete), it's GONE from server - not returned by delta sync.
     * This method fetches ALL server IDs and removes local items that no longer exist.
     *
     * Safety: Items in syncQueue are new (not yet pushed) and are preserved.
     */
    async cleanupDeletedItems(undoHistoryBaselineSeq = 0) {
        // FIX [Issue #4]: Check offline status before making network requests
        if (!navigator.onLine) {
            
            return 0;
        }

        const supabase = this.getSupabase();
        const user = await this.getUser();
        if (!supabase || !user) {
            
            return 0;
        }

        

        try {
            // Fetch ALL server IDs (not delta - we need complete picture)
            // IMPORTANT: Supabase has a default limit of 1000 rows. We must use .range()
            // to fetch all IDs up to the app's limits, otherwise cleanup will incorrectly
            // delete items that exist on the server but weren't returned in the query.
            const fetchAllServerIds = () => Promise.all([
                supabase.from('pages').select('id').eq('user_id', user.id).range(0, this.SYNC_PAGE_LIMIT - 1),
                supabase.from('boards').select('id').eq('user_id', user.id).range(0, this.SYNC_BOARD_LIMIT - 1),
                supabase.from('bookmarks').select('id').eq('user_id', user.id).range(0, this.SYNC_BOOKMARK_LIMIT - 1)
            ]);

            let allServerPages;
            let allServerBoards;
            let allServerBookmarks;
            let queryErrors = [];

            // Retry once when all query errors look like transient network fetch failures.
            for (let attempt = 0; attempt < 2; attempt++) {
                [allServerPages, allServerBoards, allServerBookmarks] = await fetchAllServerIds();
                queryErrors = [allServerPages.error, allServerBoards.error, allServerBookmarks.error].filter(Boolean);
                if (queryErrors.length === 0) break;

                const allNetworkErrors = queryErrors.every(isLikelyNetworkFetchError);
                if (attempt === 0 && allNetworkErrors) {
                    await new Promise(resolve => setTimeout(resolve, 400));
                    continue;
                }
                break;
            }

            // Check for query errors
            if (queryErrors.length > 0) {
                const pagesError = formatErrorForLog(allServerPages.error);
                const boardsError = formatErrorForLog(allServerBoards.error);
                const bookmarksError = formatErrorForLog(allServerBookmarks.error);
                const allNetworkErrors = queryErrors.every(isLikelyNetworkFetchError);

                if (allNetworkErrors) {
                    console.info(`🗑️ [Cleanup] Skipped due to transient network fetch failure: pages=${pagesError}; boards=${boardsError}; bookmarks=${bookmarksError}`);
                } else {
                    console.warn(`🗑️ [Cleanup] Query errors: pages=${pagesError}; boards=${boardsError}; bookmarks=${bookmarksError}`);
                }
                return 0;
            }

            const serverPageIds = new Set((allServerPages.data || []).map(p => p.id));
            const serverBoardIds = new Set((allServerBoards.data || []).map(b => b.id));
            const serverBookmarkIds = new Set((allServerBookmarks.data || []).map(b => b.id));

            

            // Get pending IDs from syncQueue - these are NEW items not yet pushed
            const pendingIds = new Set();
            try {
                const queueItems = await db.syncQueue.toArray();
                queueItems.forEach(q => {
                    if (q.recordId) pendingIds.add(q.recordId);
                });
                if (pendingIds.size > 0) {
                    
                }
            } catch (e) {
                console.warn('🗑️ [Cleanup] Could not read syncQueue:', e);
            }

            // Get all local items
            const localPages = await db.pages.toArray();
            const localBoards = await db.boards.toArray();
            const localBookmarks = await db.bookmarks.toArray();

            // Find items to delete: exist locally but NOT on server AND NOT pending upload
            const pagesToDelete = localPages.filter(p => !serverPageIds.has(p.id) && !pendingIds.has(p.id));
            const boardsToDelete = localBoards.filter(b => !serverBoardIds.has(b.id) && !pendingIds.has(b.id));
            const bookmarksToDelete = localBookmarks.filter(b => !serverBookmarkIds.has(b.id) && !pendingIds.has(b.id));

            const totalToDelete = pagesToDelete.length + boardsToDelete.length + bookmarksToDelete.length;

            if (totalToDelete > 0) {
                

                // Delete in correct order: bookmarks first, then boards, then pages
                if (bookmarksToDelete.length > 0) {
                    await db.bookmarks.bulkDelete(bookmarksToDelete.map(b => b.id));
                }
                if (boardsToDelete.length > 0) {
                    await db.boards.bulkDelete(boardsToDelete.map(b => b.id));
                }
                if (pagesToDelete.length > 0) {
                    await db.pages.bulkDelete(pagesToDelete.map(p => p.id));
                }

                await this.clearUndoRedoHistoryFromSync('cleanup_deleted_items', {
                    preserveAfterSeq: undoHistoryBaselineSeq
                });

                
            } else {
                
            }

            return totalToDelete;
        } catch (error) {
            if (isLikelyNetworkFetchError(error)) {
                console.info(`🗑️ [Cleanup] Skipped due to transient network error: ${formatErrorForLog(error)}`);
            } else {
                console.warn(`🗑️ [Cleanup] Error: ${formatErrorForLog(error)}`);
            }
            return 0;
        }
    },

    /**
     * Merge server data with local data using Last Write Wins
     */
    async mergeServerData(serverData, undoHistoryBaselineSeq = 0) {
        

        if (!serverData) {
            console.error('🔀 [Merge] No server data to merge');
            return { merged: false, changes: 0 };
        }

        

        let changes = 0;
        // FIX: Use epoch (far past) when no sync time exists, preventing false "older than server" comparisons
        // Previously used new Date() which made ALL local items appear older than server → data loss
        const serverSyncTime = serverData.syncedAt ? new Date(serverData.syncedAt) : new Date(0);

        const pendingDeleteIds = {
            pages: new Set(),
            boards: new Set(),
            bookmarks: new Set()
        };
        const pendingUpsertIds = {
            pages: new Set(),
            boards: new Set(),
            bookmarks: new Set()
        };
        if (db.syncQueue) {
            try {
                const pendingQueueItems = await db.syncQueue
                    .where('status')
                    .anyOf(['pending', 'processing'])
                    .toArray();
                for (const item of pendingQueueItems) {
                    if (!item?.recordId) continue;
                    if (item.operation === 'delete') {
                        if (item.tableName === 'pages') pendingDeleteIds.pages.add(item.recordId);
                        if (item.tableName === 'boards') pendingDeleteIds.boards.add(item.recordId);
                        if (item.tableName === 'bookmarks') pendingDeleteIds.bookmarks.add(item.recordId);
                    } else if (item.operation === 'upsert') {
                        if (item.tableName === 'pages') pendingUpsertIds.pages.add(item.recordId);
                        if (item.tableName === 'boards') pendingUpsertIds.boards.add(item.recordId);
                        if (item.tableName === 'bookmarks') pendingUpsertIds.bookmarks.add(item.recordId);
                    }
                }
            } catch (error) {
                console.warn('🔀 [Merge] Failed to read pending sync queue; continuing merge without local-pending guards:', error);
            }
        }

        try {
            await db.transaction('rw', [db.pages, db.boards, db.bookmarks], async () => {
                // Create sets of server IDs for deletion detection
                const serverPageIds = new Set((serverData.pages || []).map(p => p.id));
                const serverBoardIds = new Set((serverData.boards || []).map(b => b.id));
                const serverBookmarkIds = new Set((serverData.bookmarks || []).map(b => b.id));

                

                // Merge pages
                const localPages = await db.pages.toArray();
                const localPagesMap = new Map(localPages.map(p => [p.id, p]));

                if (serverData.pages && serverData.pages.length > 0) {
                    for (const serverPage of serverData.pages) {
                        if (pendingDeleteIds.pages.has(serverPage.id) || pendingUpsertIds.pages.has(serverPage.id)) {
                            continue;
                        }
                        const localPage = localPagesMap.get(serverPage.id);

                        if (!localPage) {
                            await db.pages.add(serverPage);
                            changes++;
                            
                        } else if (this.compareRecordFreshness(serverPage, localPage) > 0) {
                            if (this.shouldReplaceLocalRecord(serverPage, localPage, this.isPageEqual)) {
                                await db.pages.put(serverPage);
                                changes++;
                                
                            }
                        }
                    }
                }

                // FIX: REMOVED aggressive local deletion logic
                // Previously this deleted local pages not found on server, causing MASSIVE data loss
                // when user imported data locally and refreshed before push completed.
                //
                // Correct behavior: Local items not on server should be PUSHED to server, not deleted locally.
                // Server-side deletions are synced via deletedAt field in the server→local merge above.
                // See: https://github.com/lumilist/issues - "Data Loss on Page Refresh After Import"

                // Merge boards
                const localBoards = await db.boards.toArray();
                const localBoardsMap = new Map(localBoards.map(b => [b.id, b]));

                if (serverData.boards && serverData.boards.length > 0) {
                    for (const serverBoard of serverData.boards) {
                        if (pendingDeleteIds.boards.has(serverBoard.id) ||
                            pendingDeleteIds.pages.has(serverBoard.pageId) ||
                            pendingUpsertIds.boards.has(serverBoard.id) ||
                            pendingUpsertIds.pages.has(serverBoard.pageId)) {
                            continue;
                        }
                        const localBoard = localBoardsMap.get(serverBoard.id);

                        if (!localBoard) {
                            await db.boards.add(serverBoard);
                            changes++;
                            
                        } else if (this.compareRecordFreshness(serverBoard, localBoard) > 0) {
                            if (this.shouldReplaceLocalRecord(serverBoard, localBoard, this.isBoardEqual)) {
                                await db.boards.put(serverBoard);
                                changes++;
                                
                            }
                        }
                    }
                }

                // FIX: REMOVED aggressive local deletion logic
                // Previously this deleted local boards not found on server, causing MASSIVE data loss.
                // Local items not on server should be PUSHED, not deleted.
                // Server deletions sync via deletedAt field.

                // Merge bookmarks
                const localBookmarks = await db.bookmarks.toArray();
                const localBookmarksMap = new Map(localBookmarks.map(b => [b.id, b]));

                // FIX: Build URL lookup map for content-based deduplication
                // Key: "boardId:normalizedUrl", Value: bookmark object
                // This prevents duplicates when IDs don't match but URL+board is the same
                const localBookmarksByUrl = new Map();
                for (const b of localBookmarks) {
                    if (!b.deletedAt && b.url) {
                        const key = `${b.boardId}:${this.normalizeUrlForDedup(b.url)}`;
                        localBookmarksByUrl.set(key, b);
                    }
                }

                if (serverData.bookmarks && serverData.bookmarks.length > 0) {
                    for (const serverBookmark of serverData.bookmarks) {
                        if (pendingDeleteIds.bookmarks.has(serverBookmark.id) ||
                            pendingDeleteIds.boards.has(serverBookmark.boardId) ||
                            pendingUpsertIds.bookmarks.has(serverBookmark.id) ||
                            pendingUpsertIds.boards.has(serverBookmark.boardId)) {
                            continue;
                        }
                        const localBookmark = localBookmarksMap.get(serverBookmark.id);

                        if (!localBookmark) {
                            // FIX: Before adding as "new", check if same URL exists locally on same board
                            // This handles ID mismatch scenarios (multi-browser, BackgroundSync edge cases)
                            const urlKey = `${serverBookmark.boardId}:${this.normalizeUrlForDedup(serverBookmark.url)}`;
                            const existingByUrl = localBookmarksByUrl.get(urlKey);

                            if (existingByUrl && !existingByUrl.deletedAt) {
                                if (pendingUpsertIds.bookmarks.has(existingByUrl.id)) {
                                    continue;
                                }

                                if (this.compareRecordFreshness(serverBookmark, existingByUrl) > 0) {
                                    await db.bookmarks.put({
                                        ...serverBookmark,
                                        id: existingByUrl.id  // KEEP local ID, update content only
                                    });
                                    changes++;
                                    
                                } else {
                                    // Local is newer - skip adding server version (would be duplicate)
                                    
                                }
                            } else {
                                // Truly new - no matching URL found
                                await db.bookmarks.add(serverBookmark);
                                changes++;
                                
                            }
                        } else {
                            // ID matches - verify they're actually the same bookmark by URL
                            // This prevents ID collision when different browsers create bookmarks
                            // that get assigned the same ID (local auto-increment vs server BIGSERIAL)
                            const localUrl = this.normalizeUrlForDedup(localBookmark.url);
                            const serverUrl = this.normalizeUrlForDedup(serverBookmark.url);

                            if (localUrl === serverUrl) {
                                if (this.compareRecordFreshness(serverBookmark, localBookmark) > 0) {
                                    if (this.shouldReplaceLocalRecord(serverBookmark, localBookmark, this.isBookmarkEqual)) {
                                        await db.bookmarks.put(serverBookmark);
                                        changes++;
                                        
                                    }
                                }
                            } else {
                                // ID COLLISION: Different bookmarks with same ID!
                                // This happens when:
                                // 1. Browser A creates bookmark, gets local ID X (not yet pushed)
                                // 2. Browser B creates different bookmark, pushes, server assigns ID X
                                // 3. Browser A pulls - sees server ID X colliding with local ID X
                                console.warn(`ID collision detected: local "${localBookmark.title}" (${localUrl}) vs server "${serverBookmark.title}" (${serverUrl}) at ID ${serverBookmark.id}`);

                                // 1. Remap local bookmark to a new ID to free up the colliding ID
                                const localData = { ...localBookmark };
                                localData.id = crypto.randomUUID();  // Generate new UUID for local bookmark
                                await db.bookmarks.delete(localBookmark.id);
                                const newLocalId = await db.bookmarks.add(localData);
                                

                                // 2. Add server bookmark with its ID (now that the ID is free)
                                await db.bookmarks.add(serverBookmark);
                                changes++;
                                
                            }
                        }
                    }
                }

                // FIX: REMOVED aggressive local deletion logic
                // Previously this deleted local bookmarks not found on server, causing MASSIVE data loss
                // (715 bookmarks lost after import + refresh). Local items not on server should be PUSHED.
                // Server deletions sync via deletedAt field.
            });

            // DEBUG: Log final state after merge
            const finalPages = await db.pages.count();
            const finalBoards = await db.boards.count();
            const finalBookmarks = await db.bookmarks.count();
            

            // Log bookmarks per board after merge
            const allBookmarksAfter = await db.bookmarks.toArray();
            const afterByBoard = {};
            for (const bm of allBookmarksAfter) {
                afterByBoard[bm.boardId] = (afterByBoard[bm.boardId] || 0) + 1;
            }
            

            // Recalculate board orders locally to stabilize rendering without creating
            // synthetic sync writes during startup or merge.
            const orderFixCount = await this.recalculateBoardOrders({
                queueSync: false,
                touchUpdatedAt: false
            });
            if (orderFixCount > 0) {
                changes += orderFixCount;
            }

            if (changes > 0) {
                await this.clearUndoRedoHistoryFromSync('merge_server_data', {
                    preserveAfterSeq: undoHistoryBaselineSeq
                });
            }

            
            return { merged: true, changes };
        } catch (error) {
            this._captureError(error, 'merge_server_data', { changes });
            return { merged: false, changes: 0, error: error.message };
        }
    },

    compareRecordFreshness(serverRecord, localRecord) {
        if (!serverRecord) return -1;
        if (!localRecord) return 1;

        const serverVersion = this.parseSyncVersion(serverRecord.syncVersion);
        const localVersion = this.parseSyncVersion(localRecord.syncVersion);

        if (serverVersion !== null || localVersion !== null) {
            if (serverVersion === null) return -1;
            if (localVersion === null) return 1;
            if (serverVersion > localVersion) return 1;
            if (serverVersion < localVersion) return -1;
        }

        const serverWins = this.isNewer(serverRecord.updatedAt, localRecord.updatedAt);
        const localWins = this.isNewer(localRecord.updatedAt, serverRecord.updatedAt);

        if (serverWins && !localWins) return 1;
        if (localWins && !serverWins) return -1;
        return serverWins ? 1 : 0;
    },

    shouldReplaceLocalRecord(serverRecord, localRecord, equalityFn) {
        if (!localRecord) return true;

        if (!equalityFn.call(this, serverRecord, localRecord)) {
            return true;
        }

        return (serverRecord.syncVersion || null) !== (localRecord.syncVersion || null) ||
            (serverRecord.updatedAt || null) !== (localRecord.updatedAt || null) ||
            (serverRecord.createdAt || null) !== (localRecord.createdAt || null);
    },

    /**
     * Check if timestamp A is newer than timestamp B.
     * This is now a fallback only; syncVersion is the primary conflict signal.
     */
    isNewer(timestampA, timestampB) {
        if (!timestampA) return false;
        if (!timestampB) return true;
        // Server wins on tie - ensures drag position updates always sync correctly
        const serverTime = new Date(timestampA).getTime();
        const localTime = new Date(timestampB).getTime();
        return serverTime >= localTime;
    },

    /**
     * Check if two pages have identical content (for avoiding unnecessary writes)
     */
    isPageEqual(a, b) {
        return a.name === b.name &&
            a.order === b.order &&
            a.isDefault === b.isDefault &&
            a.deletedAt === b.deletedAt &&
            a.shareId === b.shareId;
    },

    /**
     * Check if two boards have identical content (for avoiding unnecessary writes)
     */
    isBoardEqual(a, b) {
        return a.name === b.name &&
            a.columnIndex === b.columnIndex &&
            a.order === b.order &&
            a.pageId === b.pageId &&
            a.deletedAt === b.deletedAt &&
            a.shareId === b.shareId &&
            a.color === b.color;
    },

    /**
     * Check if two bookmarks have identical content (for avoiding unnecessary writes)
     */
    isBookmarkEqual(a, b) {
        return a.title === b.title &&
            a.url === b.url &&
            a.description === b.description &&
            a.order === b.order &&
            a.boardId === b.boardId &&
            a.deletedAt === b.deletedAt;
    },

    /**
     * Normalize URL for deduplication purposes
     * Removes trailing slashes, normalizes protocol, removes fragments
     * This allows matching URLs that are logically the same but differ in formatting
     */
    normalizeUrlForDedup(url) {
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
    },

    /**
     * Import server data to local (replaces all local data - server-first)
     */
    async createDefaultHomePage(options = {}) {
        const now = new Date().toISOString();
        const pageId = crypto.randomUUID();
        const page = {
            id: pageId,
            name: options.name || 'Home',
            order: Number.isFinite(Number(options.order)) ? Number(options.order) : 0,
            isDefault: options.isDefault !== false,
            pendingStartupSync: options.pendingStartupSync === true,
            createdAt: now,
            updatedAt: now
        };

        await db.pages.add(page);

        if (options.queueForSync !== false) {
            try {
                if (typeof queueSyncToBackground === 'function') {
                    await queueSyncToBackground('upsert', 'pages', pageId, page, {
                        scheduleFlush: options.scheduleSync !== false,
                        contextLabel: options.contextLabel || 'default home bootstrap'
                    });
                } else if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
                    const response = await chrome.runtime.sendMessage({
                        action: 'queueSync',
                        payload: {
                            operation: 'upsert',
                            tableName: 'pages',
                            recordId: pageId,
                            data: page,
                            syncOptions: {
                                schedulePush: options.scheduleSync !== false,
                                contextLabel: options.contextLabel || 'default home bootstrap'
                            }
                        }
                    });
                    if (response && response.success === false) {
                        console.warn('createDefaultHomePage: Failed to queue page for sync:', response.error);
                    }
                }
            } catch (error) {
                console.warn('createDefaultHomePage: Failed to queue page for sync:', error?.message || error);
            }
        }

        return { pageId, page };
    },

    /**
     * Import server data to local (replaces all local data - server-first)
     */
    async importServerData(data, undoHistoryBaselineSeq = 0, options = {}) {
        const normalizedData = this.normalizeServerDataPayload(data);
        if (!normalizedData) {
            console.error('No data to import');
            return false;
        }

        // SAFETY CHECK: Don't import if it would leave zero pages
        if (!normalizedData.pages || normalizedData.pages.length === 0) {
            console.warn('Server data has no pages - aborting import to prevent zero pages state');
            return false;
        }

        try {
            const shouldClearExistingLocal = options.clearExistingLocal !== false;
            const shouldClearSyncQueue = options.clearSyncQueue !== false;
            const importTables = [db.pages, db.boards, db.bookmarks];
            if (shouldClearSyncQueue && db.syncQueue) importTables.push(db.syncQueue);

            await db.transaction('rw', importTables, async () => {
                if (shouldClearExistingLocal) {
                    await db.pages.clear();
                    await db.boards.clear();
                    await db.bookmarks.clear();
                }
                if (shouldClearSyncQueue && db.syncQueue) {
                    await db.syncQueue.clear();
                }

                // Import server data
                if (normalizedData.pages?.length > 0) {
                    await db.pages.bulkAdd(normalizedData.pages);
                }
                if (normalizedData.boards?.length > 0) {
                    await db.boards.bulkAdd(normalizedData.boards);
                }
                if (normalizedData.bookmarks?.length > 0) {
                    await db.bookmarks.bulkAdd(normalizedData.bookmarks);
                }
            });

            await this.clearUndoRedoHistoryFromSync('import_server_data', {
                preserveAfterSeq: undoHistoryBaselineSeq
            });

            // Verify data is readable - this forces IndexedDB commit visibility
            const verifyCount = await db.pages.count();
            
            return true;
        } catch (error) {
            console.error('Import error:', error);
            return false;
        }
    },

    // Sync state management
    // NOTE: Push operations moved to BackgroundSync (background-sync.js)
    // SyncManager only handles pull, merge, and auth operations
    _isSyncing: false,
    _isOffline: false,
    _transientPullBackoffUntil: 0,
    _lastTransientNetworkFailureAt: 0,

    /**
     * Check if currently syncing (for UI guards)
     */
    isSyncing() {
        return this._isSyncing;
    },

    _getTransientPullBackoffRemainingMs() {
        const remaining = this._transientPullBackoffUntil - Date.now();
        return remaining > 0 ? remaining : 0;
    },

    _isTransientPullFailure(pullResult) {
        if (!pullResult) return false;
        if (pullResult.isTransientNetworkError) return true;
        return isLikelyTransientNetworkError(pullResult.error);
    },

    _setTransientPullBackoff(reason, backoffMs = TRANSIENT_PULL_BACKOFF_MS) {
        this._transientPullBackoffUntil = Date.now() + backoffMs;
        const seconds = Math.ceil(backoffMs / 1000);
        console.warn(`[SyncManager] Pull backoff enabled for ${seconds}s due to transient network issue: ${reason || 'unknown'}`);
    },

    _clearTransientPullBackoff() {
        this._transientPullBackoffUntil = 0;
    },

    _markTransientNetworkFailure() {
        this._lastTransientNetworkFailureAt = Date.now();
    },

    _clearTransientNetworkFailure() {
        this._lastTransientNetworkFailureAt = 0;
    },

    _isRecentlyTransientNetworkDegraded(windowMs = TRANSIENT_NETWORK_DEGRADED_WINDOW_MS) {
        if (!this._lastTransientNetworkFailureAt) return false;
        return (Date.now() - this._lastTransientNetworkFailureAt) <= windowMs;
    },

    /**
     * Notify UI of sync status
     */
    _notifySyncStatus(status, detail = null) {
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('lumilist-sync-status', {
                detail: { status, detail, timestamp: Date.now() }
            }));
        }
    },

    /**
     * Handle coming back online - trigger BackgroundSync to process queue
     */
    async _handleOnline() {
        
        this._isOffline = false;
        // Tell BackgroundSync to process any queued items
        try {
            await chrome.runtime.sendMessage({ action: 'forcePush' });
            
        } catch (e) {
            console.warn('Failed to trigger BackgroundSync:', e.message);
        }
    },

    /**
     * Handle going offline
     */
    _handleOffline() {
        
        this._isOffline = true;
        this._markTransientNetworkFailure();
    },

    /**
     * Initialize online/offline listeners
     */
    initNetworkListeners() {
        if (typeof window !== 'undefined') {
            window.addEventListener('online', () => this._handleOnline());
            window.addEventListener('offline', () => this._handleOffline());
            this._isOffline = !navigator.onLine;
        }
    },

    /**
     * Auto-sync on page load - MERGE server data with local
     */
    async autoSyncOnLoad() {
        globalThis.recordSubscriptionDebug?.('sync.subscription.auto_sync.start', {
            isSyncing: this._isSyncing
        });
        // FIX [C4]: Re-entrancy guard to prevent concurrent execution
        // This can happen when called twice rapidly (e.g., cross-tab login triggers both handlers)
        if (this._isSyncing) {
            
            return false;
        }

        this._isSyncing = true;

        try {
            if (!(await this.isLoggedIn())) {
                
                return false;
            }

            const backoffRemainingMs = this._getTransientPullBackoffRemainingMs();
            if (backoffRemainingMs > 0) {
                return false;
            }

            // Note: We removed the redundant getSession() verification here.
            // isLoggedIn() already verifies the session (calls getSession() on cache miss and caches the result).
            // Supabase's autoRefreshToken: true handles token refresh automatically before each request.
            // If the session is truly invalid, pull() will fail with auth error and trigger logout.
            // This saves ~1 auth API call per page refresh.

            // Note: We removed ensureValidSession() here because Supabase's autoRefreshToken: true
            // handles token refresh automatically before each request. This saves ~294 auth API calls/day.

            this._notifySyncStatus('syncing');
            // Preserve user actions that happen while sync is running (for example
            // background quick-save) by only clearing history up to this baseline.
            const undoHistoryBaselineSeq = await this.getUndoRedoHeadSeq();
            const localCountsForPull = await this.getLocalDataCounts();
            const useDeltaSync = this.shouldUseDeltaSync(localCountsForPull);

            // Delta sync only works when the local cache is complete enough to merge against.
            // After a restart or IndexedDB loss, a partial delta payload is not enough to restore
            // the workspace, so fall back to a full pull instead.
            const pullResult = await this.pull(useDeltaSync);

            if (!pullResult.success) {
                const transientFailure = this._isTransientPullFailure(pullResult);
                if (pullResult.isOffline || transientFailure) {
                    if (transientFailure) {
                        this._markTransientNetworkFailure();
                        this._setTransientPullBackoff(pullResult.error);
                    }
                } else {
                    const diagnosticSuffix = pullResult.diagnosticId
                        ? ` (diagnosticId: ${pullResult.diagnosticId})`
                        : '';
                    console.error(`📥 [AutoSync] Pull failed: ${pullResult.error || 'Unknown error'}${diagnosticSuffix}`);
                }
                return false;
            }

            this._clearTransientPullBackoff();
            this._clearTransientNetworkFailure();

            const serverData = pullResult.data;
            const newSyncTime = pullResult.newSyncTime;
            const newSyncVersion = pullResult.newSyncVersion;
            globalThis.recordSubscriptionDebug?.('sync.subscription.auto_sync.pull_success', {
                subscriptionState: serverData?.subscriptionState || null,
                subscription: serverData?.subscription || null,
                newSyncTime,
                newSyncVersion
            });

            // Process and store subscription status (fetched along with other data).
            // For transient subscription-query failures we preserve cached status.
            await this._applySubscriptionStateFromPull(serverData, 'autoSyncOnLoad');

            // Check if local has any data
            const localCounts = await this.getLocalDataCounts();
            const localPages = localCounts.pages;
            const localBoards = localCounts.boards;
            const localBookmarks = localCounts.bookmarks;
            const localHasData = localPages > 0 || localBoards > 0 || localBookmarks > 0;

            

            // CRITICAL: Clean up items permanently deleted on server BEFORE merge/import logic
            // This runs UNCONDITIONALLY - even when delta sync returns empty (no modified items)
            // Without this, permanently deleted items would never be removed from other browsers
            await this.cleanupDeletedItems(undoHistoryBaselineSeq);

            const serverHasData = serverData.pages?.length > 0 || serverData.boards?.length > 0 || serverData.bookmarks?.length > 0;

            

            if (serverHasData) {
                if (localHasData) {
                    // MERGE: Both have data - use Last-Write-Wins
                    
                    const mergeResult = await this.mergeServerData(serverData, undoHistoryBaselineSeq);

                    if (mergeResult.merged) {
                        
                        this._notifySyncStatus('success');

                        // Store delta sync checkpoint for next incremental sync
                        const user = await this.getUser();
                        if (user) {
                            await this.setLastDeltaSyncState({
                                timestamp: newSyncTime,
                                syncVersion: newSyncVersion
                            }, user.id);
                        }

                        // Don't auto-push after merge - merge already synced server→local
                        // Local changes are synced via BackgroundSync through queueSyncToBackground()
                        return mergeResult.changes > 0;
                    } else {
                        console.error('📥 [AutoSync] ❌ Merge failed:', mergeResult.error);
                        this._notifySyncStatus('error', mergeResult.error);
                        return false;
                    }
                } else {
                    // IMPORT: Local is empty, server has data
                    
                    await this.importServerData(serverData, undoHistoryBaselineSeq);
                    
                    this._notifySyncStatus('success');

                    // Store delta sync checkpoint for next incremental sync
                    const user = await this.getUser();
                    if (user) {
                        await this.setLastDeltaSyncState({
                            timestamp: newSyncTime,
                            syncVersion: newSyncVersion
                        }, user.id);
                    }

                    return true;
                }
            } else if (localHasData) {
                // Startup/open-tab sync must stay read-only. If the server is empty while
                // local cache still has data, wait for an actual user mutation or explicit sync.
                this._notifySyncStatus('success');
                return false;
            } else {
                // Logged-in workspace with empty server + empty local still needs a visible default page,
                // but startup must not push anything until the user performs a real mutation.
                await this.createDefaultHomePage({
                    queueForSync: false,
                    pendingStartupSync: true,
                    contextLabel: 'startup empty workspace bootstrap'
                });
                this._notifySyncStatus('success');

                const user = await this.getUser();
                if (user) {
                    await this.setLastDeltaSyncState({
                        timestamp: newSyncTime,
                        syncVersion: newSyncVersion
                    }, user.id);
                }

                return true;
            }

        } catch (error) {
            console.error('Auto-sync error:', error);
            globalThis.recordSubscriptionDebug?.('sync.subscription.auto_sync.error', {
                error,
                errorSummary: formatErrorForLog(error)
            });
            this._notifySyncStatus('error', error.message);
            return false;
        } finally {
            this._isSyncing = false;
            globalThis.recordSubscriptionDebug?.('sync.subscription.auto_sync.end', {
                isSyncing: this._isSyncing
            });
        }
    },

    /**
     * Sync on login - ALWAYS clears local and downloads from cloud
     * This is the SAFE login sync that prevents data loss.
     *
     * Flow:
     * 1. Clear ALL local data (pages, boards, bookmarks)
     * 2. Pull from cloud
     * 3. If cloud has data → import it
     * 4. If cloud is empty (new user) → create default Home page locally
     *
     * This approach:
     * - Prevents corrupted/empty local data from overwriting cloud
     * - Handles account switching cleanly (no data mixing)
     * - Cloud is always the source of truth on login
     */
    async syncOnLogin() {
        // FIX [H7]: Re-entrancy guard to prevent concurrent execution
        // Prevents issues when multiple auth events trigger this function simultaneously
        if (this._isSyncing) {
            
            return { success: false, error: 'Sync already in progress' };
        }

        this._isSyncing = true;

        try {
            if (!(await this.isLoggedIn())) {
                
                return { success: false, error: 'Not logged in' };
            }

            const loginSyncUserId = (await this.getStoredUser())?.id || null;
            await this._markLoginSyncPending(loginSyncUserId);

            this._notifySyncStatus('syncing');
            // Step 1: Pull from cloud FIRST (before clearing local)
            // This ensures we have cloud data before we clear anything
            
            const pullResult = await this.pull();

            if (!pullResult.success) {
                const transientFailure = this._isTransientPullFailure(pullResult);
                if (pullResult.isOffline || transientFailure) {
                    if (transientFailure) {
                        this._markTransientNetworkFailure();
                    }
                    console.warn('syncOnLogin: Pull deferred due to temporary network issue', {
                        error: pullResult.error,
                        diagnosticId: pullResult.diagnosticId || null,
                        debug: pullResult.debug || null
                    });
                    this._notifySyncStatus('error', pullResult.error || 'Temporary network issue');
                } else {
                    console.error('syncOnLogin: Pull failed', {
                        error: pullResult.error,
                        diagnosticId: pullResult.diagnosticId || null,
                        debug: pullResult.debug || null
                    });
                    this._notifySyncStatus('error', pullResult.error);
                }
                await this._clearLoginSyncState();
                // DON'T clear local data if pull fails - user keeps their local data
                return { success: false, error: pullResult.error };
            }

            this._clearTransientNetworkFailure();
            const serverData = pullResult.data;
            // Check all data types, not just pages (matches autoSyncOnLoad pattern at line 1260)
            const serverHasData = serverData.pages?.length > 0 || serverData.boards?.length > 0 || serverData.bookmarks?.length > 0;

            

            // Process and store subscription status.
            // For transient subscription-query failures we preserve cached status.
            await this._applySubscriptionStateFromPull(serverData, 'syncOnLogin');

            // FIX [Issue #6]: Backup local data BEFORE clearing to prevent data loss if import fails
            
            let localBackup = null;
            try {
                localBackup = {
                    pages: await db.pages.toArray(),
                    boards: await db.boards.toArray(),
                    bookmarks: await db.bookmarks.toArray()
                };
                
            } catch (backupError) {
                console.warn('syncOnLogin: Failed to create backup, proceeding anyway:', backupError);
            }

            // Step 2: Clear ALL local data AND stale chrome.storage
            // IMPORTANT: Also clear undo/redo history + pending sync queue so a different
            // account can never inherit prior account history or queued mutations.
            
            const tablesToClear = [db.pages, db.boards, db.bookmarks];
            if (db.syncQueue) tablesToClear.push(db.syncQueue);
            if (db.favicons) tablesToClear.push(db.favicons);
            if (db.historyEntries) tablesToClear.push(db.historyEntries);
            if (db.historyState) tablesToClear.push(db.historyState);

            await db.transaction('rw', tablesToClear, async () => {
                await db.pages.clear();
                await db.boards.clear();
                await db.bookmarks.clear();
                if (db.syncQueue) await db.syncQueue.clear();
                if (db.favicons) await db.favicons.clear();
                if (db.historyEntries) await db.historyEntries.clear();
                if (db.historyState) {
                    await db.historyState.clear();
                    await db.historyState.put({
                        id: SYNC_UNDO_REDO_HISTORY_STATE_ID,
                        cursorSeq: 0,
                        headSeq: 0,
                        maxDepth: SYNC_UNDO_REDO_HISTORY_MAX_DEPTH_DEFAULT
                    });
                }
            });

            // Clear account-boundary-scoped UI state so another account cannot inherit it.
            if (typeof chrome !== 'undefined' && chrome.storage) {
                await chrome.storage.local.remove(SYNC_MANAGER_ACCOUNT_BOUNDARY_STORAGE_KEYS);
                
            }

            // Step 3: Import cloud data OR create default Home
            if (serverHasData) {
                
                const importSuccess = await this.importServerData(serverData, 0, {
                    clearExistingLocal: false,
                    clearSyncQueue: false
                });

                if (importSuccess) {
                    
                    this._notifySyncStatus('success');

                    // Store delta sync checkpoint for subsequent page loads
                    const user = await this.getUser();
                    if (user) {
                        await this.setLastDeltaSyncState({
                            timestamp: pullResult.newSyncTime,
                            syncVersion: pullResult.newSyncVersion
                        }, user.id);
                    }
                    // Signal other tabs that login sync completed (UI-only reload)
                    await this._signalLoginSyncComplete(user?.id, 'imported');

                    return {
                        success: true,
                        action: 'imported',
                        count: serverData.bookmarks?.length || 0
                    };
                } else {
                    // FIX [Issue #6]: Restore from backup if import fails
                    console.error('syncOnLogin: Import failed, attempting to restore from backup...');
                    if (localBackup && (localBackup.pages.length > 0 || localBackup.boards.length > 0 || localBackup.bookmarks.length > 0)) {
                        try {
                            await db.transaction('rw', [db.pages, db.boards, db.bookmarks], async () => {
                                if (localBackup.pages.length > 0) await db.pages.bulkAdd(localBackup.pages);
                                if (localBackup.boards.length > 0) await db.boards.bulkAdd(localBackup.boards);
                                if (localBackup.bookmarks.length > 0) await db.bookmarks.bulkAdd(localBackup.bookmarks);
                            });
                            
                        } catch (restoreError) {
                            console.error('syncOnLogin: Failed to restore from backup:', restoreError);
                        }
                    }
                    this._notifySyncStatus('error', 'Import failed');
                    await this._clearLoginSyncState();
                    return { success: false, error: 'Failed to import cloud data' };
                }
            } else {
                // New user - cloud is empty, create default Home page
                

                const { pageId: localPageId } = await this.createDefaultHomePage({
                    queueForSync: false,
                    pendingStartupSync: true,
                    contextLabel: 'login empty workspace bootstrap'
                });

                // No need to re-pull - we use client-generated UUIDs now, so server keeps the same ID
                this._notifySyncStatus('success');

                // Store delta sync checkpoint for subsequent page loads
                const user = await this.getUser();
                if (user) {
                    await this.setLastDeltaSyncState({
                        timestamp: pullResult.newSyncTime,
                        syncVersion: pullResult.newSyncVersion
                    }, user.id);
                }
                // Signal other tabs that login sync completed (UI-only reload)
                await this._signalLoginSyncComplete(user?.id, 'created_home');

                return {
                    success: true,
                    action: 'created_home',
                    pageId: localPageId
                };
            }
        } catch (error) {
            console.error('syncOnLogin error:', error);
            this._notifySyncStatus('error', error.message);
            await this._clearLoginSyncState();
            return { success: false, error: error.message };
        } finally {
            this._isSyncing = false;
        }
    },

    /**
     * Force clear all auth state - useful for debugging stuck login states
     * Can be called from console: SyncManager.forceReset()
     */
    async forceReset() {
        this._oauthLoginInProgress = false;

        

        // 1. Clear the Supabase client
        this._supabase = null;

        // 2. Clear all chrome.storage.local keys related to auth
        await this.clearAuth();

        // 3. Clear IndexedDB
        if (typeof db !== 'undefined') {
            try {
                const clearOps = [
                    db.pages.clear(),
                    db.boards.clear(),
                    db.bookmarks.clear(),
                    db.syncQueue.clear(),
                    db.favicons.clear()
                ];
                if (db.historyEntries) clearOps.push(db.historyEntries.clear());
                if (db.historyState) clearOps.push(db.historyState.clear());
                await Promise.all(clearOps);
                
            } catch (e) {
                console.error('Failed to clear IndexedDB:', e);
            }
        }

        // 4. Clear localStorage
        try {
            if (typeof localStorage !== 'undefined') {
                const keysToRemove = Object.keys(localStorage).filter(k =>
                    k.startsWith('sb-') || k.includes('supabase') || k.includes('lumilist')
                );
                keysToRemove.forEach(k => localStorage.removeItem(k));
                
            }
        } catch (e) {
            console.warn('localStorage clear failed:', e);
        }

        
        return { success: true, message: 'Auth state cleared. Please refresh.' };
    },

};

// Make SyncManager and timeout constants globally available
window.SyncManager = SyncManager;
window.AUTH_TIMEOUTS = AUTH_TIMEOUTS;

// Initialize network listeners on load
if (typeof window !== 'undefined') {
    SyncManager.initNetworkListeners();

    // Cache invalidation listener: reset Supabase client when user logs out
    // This ensures the client is re-initialized fresh on next login
    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName === 'local' && changes.lumilist_user && !changes.lumilist_user.newValue) {
            
            SyncManager._supabase = null;
        }
    });
}
