(function registerLumiListWallpaperFeature(global) {
    const modules = global.LumiListModules || (global.LumiListModules = {});
    const features = modules.features || (modules.features = {});

    features.wallpaper = function createWallpaperFeature(options) {
        const {
            getThemeMode,
            setThemeMode,
            canMutateAccountScopedPreferences,
            getWallpaperAccountScopeUserId,
            getWallpaperCatalogByTheme,
            setWallpaperCatalogByTheme,
            setBundledWallpaperCatalogState,
            getWallpaperSelectionByTheme,
            setWallpaperSelectionByTheme,
            getWallpaperThemeDefaults,
            setWallpaperThemeDefaults,
            normalizeWallpaperStyleConfig,
            getWallpaperStyleOverridesByTheme,
            setWallpaperStyleOverridesByTheme,
            getHostedWallpaperCatalogPromise,
            setHostedWallpaperCatalogPromise,
            getHostedWallpaperGalleryPromise,
            setHostedWallpaperGalleryPromise,
            getWallpaperPreferencesInitialized,
            setWallpaperPreferencesInitialized,
            wallpaperStorageKey,
            wallpaperLocalCacheKey,
            wallpaperStyleLocalCacheKey,
            wallpaperBinaryCacheLocalKey,
            wallpaperBootStyleCachePrefix,
            wallpaperBootBinaryCachePrefix,
            wallpaperBootSourceCachePrefix,
            wallpaperAccountLocalStateStorageKey,
            wallpaperCloudSyncStateStorageKey,
            wallpaperPendingHandoffStorageKey,
            wallpaperNewUserDefaultSeedStorageKey,
            wallpaperCatalogPath,
            wallpaperRemoteCatalogUrl,
            wallpaperRemoteGalleryUrl,
            wallpaperRemoteStoragePrefix,
            wallpaperGalleryUrl,
            wallpaperFilePattern,
            wallpaperUrlParam,
            wallpaperGalleryIdUrlParam,
            wallpaperThemeUrlParam,
            defaultWallpaperTileId,
            defaultWallpaperThemeStyles,
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
            getWallpaperNewUserDefaultConfig,
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
            localUserWallpaperSourceType,
            showGlassToast
        } = options;

        let hostedWallpaperSelectionMigrationPromise = null;
        const LOCAL_WALLPAPER_UPLOAD_MAX_WIDTH = 2560;
        const LOCAL_WALLPAPER_UPLOAD_JPEG_QUALITY = 0.8;
        const USER_UPLOAD_WALLPAPER_AUTO_STYLE_SAMPLE_MAX_DIMENSION = 96;
        const USER_UPLOAD_WALLPAPER_GENERIC_LABEL = 'Uploaded Wallpaper';
        const wallpaperSectionDisclosureState = {
            uploads: null,
            downloaded: null,
            starter: null,
            archived: null
        };
        let wallpaperContextMenuState = null;
        let wallpaperStylePersistTimeoutId = null;
        let wallpaperStyleEditorState = null;
        let wallpaperSelectionStorageWriteRequestId = 0;
        let wallpaperDownloadOverlayRequestCount = 0;
        let latestAppliedWallpaperAccountStateUserId = null;
        let latestAppliedWallpaperAccountStateUpdatedAtMs = null;
        const pendingWallpaperAccountStateFingerprints = new Set();
        const OWN_WALLPAPER_ACCOUNT_STATE_CLEANUP_DELAY = 5000;
        const wallpaperSelectionRevisionByTheme = {
            dark: 0,
            light: 0
        };

        function readThemeModeCache() {
            try {
                const cachedMode = localStorage.getItem('lumilist_theme_mode');
                return (cachedMode === 'dark' || cachedMode === 'light') ? cachedMode : null;
            } catch (error) {
                return null;
            }
        }

        function normalizeWallpaperAccountLocalState(rawState, userIdHint = null) {
            const normalizedUserId = (typeof userIdHint === 'string' && userIdHint.trim())
                ? userIdHint.trim()
                : null;
            const source = rawState && typeof rawState === 'object' ? rawState : {};
            const rawSelection = source.selectionByTheme && typeof source.selectionByTheme === 'object'
                ? source.selectionByTheme
                : {};
            const normalizedStyleOverrides = typeof normalizeWallpaperUserStyleOverrideState === 'function'
                ? normalizeWallpaperUserStyleOverrideState(source.styleOverridesByTheme)
                : (typeof createEmptyWallpaperStyleOverrideState === 'function'
                    ? createEmptyWallpaperStyleOverrideState()
                    : { dark: null, light: null });

            return {
                userId: normalizedUserId,
                themeMode: (source.themeMode === 'dark' || source.themeMode === 'light')
                    ? source.themeMode
                    : null,
                selectionByTheme: {
                    dark: typeof rawSelection.dark === 'string' && rawSelection.dark.trim()
                        ? rawSelection.dark.trim()
                        : null,
                    light: typeof rawSelection.light === 'string' && rawSelection.light.trim()
                        ? rawSelection.light.trim()
                        : null
                },
                styleOverridesByTheme: normalizedStyleOverrides,
                updatedAt: typeof source.updatedAt === 'string' && source.updatedAt.trim()
                    ? source.updatedAt.trim()
                    : null
            };
        }

        function getWallpaperAccountLocalStateUpdatedAtMs(rawState, userIdHint = null) {
            const normalizedState = normalizeWallpaperAccountLocalState(rawState, userIdHint);
            const parsed = Date.parse(normalizedState?.updatedAt || '');
            return Number.isFinite(parsed) ? parsed : null;
        }

        function getWallpaperAccountLocalStateFingerprint(rawState, userIdHint = null) {
            const normalizedState = normalizeWallpaperAccountLocalState(rawState, userIdHint);
            if (!normalizedState?.userId) {
                return null;
            }
            return JSON.stringify(normalizedState);
        }

        function rememberPendingWallpaperAccountState(rawState, userIdHint = null) {
            const fingerprint = getWallpaperAccountLocalStateFingerprint(rawState, userIdHint);
            if (!fingerprint) {
                return;
            }
            pendingWallpaperAccountStateFingerprints.add(fingerprint);
            setTimeout(() => {
                pendingWallpaperAccountStateFingerprints.delete(fingerprint);
            }, OWN_WALLPAPER_ACCOUNT_STATE_CLEANUP_DELAY);
        }

        function noteWallpaperAccountLocalStateApplied(rawState, userIdHint = null) {
            const normalizedState = normalizeWallpaperAccountLocalState(rawState, userIdHint);
            if (!normalizedState?.userId) {
                latestAppliedWallpaperAccountStateUserId = null;
                latestAppliedWallpaperAccountStateUpdatedAtMs = null;
                return;
            }

            const updatedAtMs = getWallpaperAccountLocalStateUpdatedAtMs(normalizedState, normalizedState.userId);
            if (
                latestAppliedWallpaperAccountStateUserId !== normalizedState.userId
                || latestAppliedWallpaperAccountStateUpdatedAtMs === null
                || updatedAtMs === null
                || updatedAtMs >= latestAppliedWallpaperAccountStateUpdatedAtMs
            ) {
                latestAppliedWallpaperAccountStateUserId = normalizedState.userId;
                latestAppliedWallpaperAccountStateUpdatedAtMs = updatedAtMs;
            }
        }

        function shouldIgnoreIncomingWallpaperAccountLocalState(rawState, userIdHint = null) {
            const normalizedState = normalizeWallpaperAccountLocalState(rawState, userIdHint);
            if (!normalizedState?.userId) {
                return false;
            }

            const fingerprint = getWallpaperAccountLocalStateFingerprint(normalizedState, normalizedState.userId);
            if (fingerprint && pendingWallpaperAccountStateFingerprints.delete(fingerprint)) {
                noteWallpaperAccountLocalStateApplied(normalizedState, normalizedState.userId);
                return true;
            }

            if (
                latestAppliedWallpaperAccountStateUserId
                && latestAppliedWallpaperAccountStateUserId === normalizedState.userId
                && latestAppliedWallpaperAccountStateUpdatedAtMs !== null
            ) {
                const incomingUpdatedAtMs = getWallpaperAccountLocalStateUpdatedAtMs(normalizedState, normalizedState.userId);
                if (
                    incomingUpdatedAtMs !== null
                    && incomingUpdatedAtMs < latestAppliedWallpaperAccountStateUpdatedAtMs
                ) {
                    return true;
                }
            }

            return false;
        }

        async function readWallpaperAccountLocalStateStore(prefetchedStorage = null) {
            if (!wallpaperAccountLocalStateStorageKey || !(typeof chrome !== 'undefined' && chrome.storage?.local)) {
                return {};
            }

            try {
                const hasPrefetchedStore = prefetchedStorage
                    && typeof prefetchedStorage === 'object'
                    && Object.prototype.hasOwnProperty.call(prefetchedStorage, wallpaperAccountLocalStateStorageKey);
                const result = hasPrefetchedStore
                    ? {
                        [wallpaperAccountLocalStateStorageKey]: prefetchedStorage[wallpaperAccountLocalStateStorageKey]
                    }
                    : await chrome.storage.local.get(wallpaperAccountLocalStateStorageKey);
                const rawStore = result?.[wallpaperAccountLocalStateStorageKey];
                return rawStore && typeof rawStore === 'object' ? rawStore : {};
            } catch (error) {
                console.warn('Failed to read local wallpaper account state store:', error);
                return {};
            }
        }

        async function getWallpaperAccountLocalState(userIdHint = null, prefetchedStorage = null) {
            const normalizedUserId = (typeof userIdHint === 'string' && userIdHint.trim())
                ? userIdHint.trim()
                : null;
            if (!normalizedUserId) {
                return null;
            }

            const store = await readWallpaperAccountLocalStateStore(prefetchedStorage);
            return normalizeWallpaperAccountLocalState(store?.[normalizedUserId], normalizedUserId);
        }

        function getCurrentUserWallpaperAccountStateFromPayload(storagePayload) {
            const currentWallpaperUserId = typeof getWallpaperAccountScopeUserId === 'function'
                ? getWallpaperAccountScopeUserId()
                : null;
            const store = storagePayload?.[wallpaperAccountLocalStateStorageKey];
            if (!currentWallpaperUserId || !store || typeof store !== 'object') {
                return null;
            }
            return normalizeWallpaperAccountLocalState(store?.[currentWallpaperUserId], currentWallpaperUserId);
        }

        async function commitWallpaperAccountStoragePayload(storagePayload, { requestId = null } = {}) {
            if (typeof chrome === 'undefined' || !chrome.storage?.local || !storagePayload || typeof storagePayload !== 'object') {
                return false;
            }
            if (requestId !== null && requestId !== wallpaperSelectionStorageWriteRequestId) {
                return false;
            }

            const currentUserState = getCurrentUserWallpaperAccountStateFromPayload(storagePayload);
            if (currentUserState?.userId) {
                rememberPendingWallpaperAccountState(currentUserState, currentUserState.userId);
                noteWallpaperAccountLocalStateApplied(currentUserState, currentUserState.userId);
            }

            await chrome.storage.local.set(storagePayload);
            return true;
        }

        function markWallpaperSelectionMutation(previousSelection, nextSelection) {
            ['dark', 'light'].forEach((theme) => {
                const previousWallpaper = normalizeWallpaperPathForTheme(theme, previousSelection?.[theme]);
                const nextWallpaper = normalizeWallpaperPathForTheme(theme, nextSelection?.[theme]);
                if (previousWallpaper !== nextWallpaper) {
                    wallpaperSelectionRevisionByTheme[theme] += 1;
                }
            });
        }

        function createWallpaperSelectionGuard(theme, wallpaperId = undefined) {
            const normalizedTheme = normalizeThemeMode(theme);
            const hasExplicitWallpaperId = arguments.length >= 2;
            const selectedWallpaper = hasExplicitWallpaperId
                ? wallpaperId
                : getWallpaperSelectionByTheme()?.[normalizedTheme];
            return {
                theme: normalizedTheme,
                wallpaperId: normalizeWallpaperPathForTheme(normalizedTheme, selectedWallpaper),
                revision: wallpaperSelectionRevisionByTheme[normalizedTheme] || 0
            };
        }

        function isWallpaperSelectionGuardCurrent(selectionGuard) {
            if (!selectionGuard || typeof selectionGuard !== 'object') {
                return true;
            }

            const normalizedTheme = normalizeThemeMode(selectionGuard.theme);
            if ((wallpaperSelectionRevisionByTheme[normalizedTheme] || 0) !== selectionGuard.revision) {
                return false;
            }

            const currentWallpaper = normalizeWallpaperPathForTheme(
                normalizedTheme,
                getWallpaperSelectionByTheme()?.[normalizedTheme]
            );
            return currentWallpaper === (selectionGuard.wallpaperId ?? null);
        }

        function reapplyActiveWallpaperIfGuardCurrent(selectionGuard, { preserveScroll = true } = {}) {
            if (!isWallpaperSelectionGuardCurrent(selectionGuard)) {
                return false;
            }
            applyActiveThemeWallpaper();
            renderWallpaperPopup({ preserveScroll });
            return true;
        }

        async function buildWallpaperAccountLocalStateStoragePatch({
            themeMode: nextThemeMode = undefined,
            selection: nextSelection = undefined,
            styleOverrides: nextStyleOverrides = undefined,
            prefetchedStorage = null
        } = {}) {
            const currentWallpaperUserId = typeof getWallpaperAccountScopeUserId === 'function'
                ? getWallpaperAccountScopeUserId()
                : null;
            if (!currentWallpaperUserId || !wallpaperAccountLocalStateStorageKey) {
                return null;
            }

            const store = await readWallpaperAccountLocalStateStore(prefetchedStorage);
            const existingState = normalizeWallpaperAccountLocalState(store?.[currentWallpaperUserId], currentWallpaperUserId);
            const effectiveThemeMode = (nextThemeMode === 'dark' || nextThemeMode === 'light')
                ? nextThemeMode
                : (existingState.themeMode === 'dark' || existingState.themeMode === 'light'
                    ? existingState.themeMode
                    : normalizeThemeMode(getThemeMode()));
            const selectionSource = nextSelection !== undefined
                ? nextSelection
                : (existingState.selectionByTheme || getWallpaperSelectionByTheme());
            const { selection: reconciledSelection } = reconcileWallpaperSelection(selectionSource, {
                preserveHostedSelections: true,
                preserveInstalledSelections: true
            });
            const effectiveStyleOverrides = nextStyleOverrides !== undefined
                ? (typeof normalizeWallpaperUserStyleOverrideState === 'function'
                    ? normalizeWallpaperUserStyleOverrideState(nextStyleOverrides)
                    : nextStyleOverrides)
                : (existingState.styleOverridesByTheme
                    || (typeof getWallpaperStyleOverridesByTheme === 'function'
                        ? getWallpaperStyleOverridesByTheme()
                        : (typeof createEmptyWallpaperStyleOverrideState === 'function'
                            ? createEmptyWallpaperStyleOverrideState()
                            : { dark: null, light: null })));

            return {
                [wallpaperAccountLocalStateStorageKey]: {
                    ...store,
                    [currentWallpaperUserId]: {
                        userId: currentWallpaperUserId,
                        themeMode: effectiveThemeMode,
                        selectionByTheme: {
                            dark: reconciledSelection.dark ?? null,
                            light: reconciledSelection.light ?? null
                        },
                        styleOverridesByTheme: effectiveStyleOverrides,
                        updatedAt: new Date().toISOString()
                    }
                }
            };
        }

        function hasConfiguredWallpaperAccountLocalState(state) {
            if (!state || typeof state !== 'object') {
                return false;
            }

            if (state.themeMode === 'dark' || state.themeMode === 'light') {
                return true;
            }

            const selection = state.selectionByTheme && typeof state.selectionByTheme === 'object'
                ? state.selectionByTheme
                : {};
            const hasSelectionOrTheme = Boolean(
                (typeof selection.dark === 'string' && selection.dark.trim())
                || (typeof selection.light === 'string' && selection.light.trim())
            );
            if (hasSelectionOrTheme) {
                return true;
            }

            const styleOverrides = state.styleOverridesByTheme && typeof state.styleOverridesByTheme === 'object'
                ? state.styleOverridesByTheme
                : {};
            return Boolean(
                (typeof hasConfiguredWallpaperUserStyleOverride === 'function'
                    && hasConfiguredWallpaperUserStyleOverride(styleOverrides.dark))
                || (typeof hasConfiguredWallpaperUserStyleOverride === 'function'
                    && hasConfiguredWallpaperUserStyleOverride(styleOverrides.light))
            );
        }

        function getCurrentWallpaperStyleOverridesByTheme() {
            if (typeof normalizeWallpaperUserStyleOverrideState === 'function') {
                return normalizeWallpaperUserStyleOverrideState(
                    typeof getWallpaperStyleOverridesByTheme === 'function'
                        ? getWallpaperStyleOverridesByTheme()
                        : null
                );
            }
            return typeof createEmptyWallpaperStyleOverrideState === 'function'
                ? createEmptyWallpaperStyleOverrideState()
                : { dark: null, light: null };
        }

        function areWallpaperStyleOverrideStatesEqual(leftState, rightState) {
            const left = getNormalizedWallpaperStyleOverrideState(leftState);
            const right = getNormalizedWallpaperStyleOverrideState(rightState);
            return ['dark', 'light'].every((theme) => (
                JSON.stringify(left[theme] || null) === JSON.stringify(right[theme] || null)
            ));
        }

        function getNormalizedWallpaperStyleOverrideState(rawState) {
            if (typeof normalizeWallpaperUserStyleOverrideState === 'function') {
                return normalizeWallpaperUserStyleOverrideState(rawState);
            }
            return typeof createEmptyWallpaperStyleOverrideState === 'function'
                ? createEmptyWallpaperStyleOverrideState()
                : { dark: null, light: null };
        }

        function setCurrentWallpaperStyleOverridesByTheme(nextOverrides) {
            if (typeof setWallpaperStyleOverridesByTheme === 'function') {
                setWallpaperStyleOverridesByTheme(getNormalizedWallpaperStyleOverrideState(nextOverrides));
            }
        }

        async function loadWallpaperStyleOverridesFromStorage(prefetchedStorage = null) {
            const emptyOverrides = getNormalizedWallpaperStyleOverrideState(null);
            const currentOverrides = getCurrentWallpaperStyleOverridesByTheme();
            const runtimeCleared = !areWallpaperStyleOverrideStatesEqual(currentOverrides, emptyOverrides);
            if (runtimeCleared) {
                setCurrentWallpaperStyleOverridesByTheme(emptyOverrides);
            }

            let migratedThemes = [];
            let clearedStoredOverrides = false;
            const currentWallpaperUserId = typeof getWallpaperAccountScopeUserId === 'function'
                ? getWallpaperAccountScopeUserId()
                : null;
            if (currentWallpaperUserId) {
                const accountState = await getWallpaperAccountLocalState(currentWallpaperUserId, prefetchedStorage);
                const legacyOverrides = getNormalizedWallpaperStyleOverrideState(accountState?.styleOverridesByTheme);
                const hasLegacyOverrides = ['dark', 'light'].some((theme) => (
                    typeof hasConfiguredWallpaperUserStyleOverride === 'function'
                        ? hasConfiguredWallpaperUserStyleOverride(legacyOverrides?.[theme])
                        : Boolean(legacyOverrides?.[theme])
                ));

                if (hasLegacyOverrides) {
                    for (const theme of ['dark', 'light']) {
                        const legacyOverride = legacyOverrides?.[theme] || null;
                        if (
                            !legacyOverride
                            || (
                                typeof hasConfiguredWallpaperUserStyleOverride === 'function'
                                && !hasConfiguredWallpaperUserStyleOverride(legacyOverride)
                            )
                        ) {
                            continue;
                        }

                        const selectedWallpaper = normalizeWallpaperPathForTheme(
                            theme,
                            accountState?.selectionByTheme?.[theme] ?? getWallpaperSelectionByTheme()?.[theme]
                        );
                        const installedRecord = isInstalledWallpaperRef(selectedWallpaper)
                            ? getInstalledWallpaperRecordByRef(selectedWallpaper)
                            : null;

                        if (
                            selectedWallpaper
                            && installedRecord
                            && isUserUploadWallpaperSourceType(installedRecord?.sourceType)
                            && typeof setInstalledWallpaperStyleLocally === 'function'
                        ) {
                            const migratedStyle = normalizeUserUploadWallpaperStyle(theme, {
                                ...(installedRecord?.style || buildUserUploadWallpaperBaseStyle(theme)),
                                ...legacyOverride
                            });
                            await setInstalledWallpaperStyleLocally(selectedWallpaper, {
                                style: migratedStyle
                            });
                            migratedThemes.push(theme);
                        }
                    }

                    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
                        const clearedPatch = await buildWallpaperAccountLocalStateStoragePatch({
                            styleOverrides: emptyOverrides,
                            prefetchedStorage
                        });
                        if (clearedPatch) {
                            await commitWallpaperAccountStoragePayload(clearedPatch);
                            clearedStoredOverrides = true;
                        }
                    }
                }
            }

            const changed = runtimeCleared || migratedThemes.length > 0 || clearedStoredOverrides;
            if (changed && getWallpaperPreferencesInitialized()) {
                applyActiveThemeWallpaper();
                renderWallpaperPopup({ preserveScroll: true });
            }
            return {
                styleOverridesByTheme: emptyOverrides,
                changed,
                migratedThemes
            };
        }

        async function saveWallpaperStyleOverridesToStorage(styleOverrides) {
            if (typeof chrome === 'undefined' || !chrome.storage?.local) {
                return;
            }
            if (wallpaperStylePersistTimeoutId !== null) {
                clearTimeout(wallpaperStylePersistTimeoutId);
                wallpaperStylePersistTimeoutId = null;
            }
            const accountStatePatch = await buildWallpaperAccountLocalStateStoragePatch({
                styleOverrides
            });
            if (accountStatePatch) {
                await commitWallpaperAccountStoragePayload(accountStatePatch);
            }
        }

        function buildCompactedWallpaperStyleOverride(baseStyle, rawOverride) {
            const normalizedBaseStyle = baseStyle && typeof baseStyle === 'object'
                ? baseStyle
                : getResolvedWallpaperStyleForTheme(getThemeMode(), {
                    includeUserOverrides: false
                });
            const normalizedOverride = typeof normalizeWallpaperUserStyleOverride === 'function'
                ? normalizeWallpaperUserStyleOverride(rawOverride)
                : rawOverride;
            if (!normalizedOverride || typeof normalizedOverride !== 'object') {
                return null;
            }

            const compactedOverride = {};
            if (
                typeof normalizedOverride.primary === 'string'
                && normalizedOverride.primary !== normalizedBaseStyle.primary
            ) {
                compactedOverride.primary = normalizedOverride.primary;
            }
            if (
                typeof normalizedOverride.boardBackgroundColor === 'string'
                && normalizedOverride.boardBackgroundColor !== normalizedBaseStyle.boardBackgroundColor
            ) {
                compactedOverride.boardBackgroundColor = normalizedOverride.boardBackgroundColor;
            }
            if (
                typeof normalizedOverride.boardBackgroundOpacity === 'number'
                && normalizedOverride.boardBackgroundOpacity !== normalizedBaseStyle.boardBackgroundOpacity
            ) {
                compactedOverride.boardBackgroundOpacity = normalizedOverride.boardBackgroundOpacity;
            }
            if (
                typeof normalizedOverride.boardBackdropBlur === 'number'
                && normalizedOverride.boardBackdropBlur !== normalizedBaseStyle.boardBackdropBlur
            ) {
                compactedOverride.boardBackdropBlur = normalizedOverride.boardBackdropBlur;
            }

            return Object.keys(compactedOverride).length > 0 ? compactedOverride : null;
        }

        function applyWallpaperStyleOverrideState(nextOverrides) {
            const normalizedNextOverrides = getNormalizedWallpaperStyleOverrideState(nextOverrides);
            if (areWallpaperStyleOverrideStatesEqual(
                getCurrentWallpaperStyleOverridesByTheme(),
                normalizedNextOverrides
            )) {
                return false;
            }

            setCurrentWallpaperStyleOverridesByTheme(normalizedNextOverrides);
            applyActiveThemeWallpaper();
            return true;
        }

        function isUserUploadWallpaperSourceType(sourceType) {
            return (
                typeof sourceType === 'string'
                && sourceType.trim() === (localUserWallpaperSourceType || 'user-upload')
            );
        }

        function buildZeroWallpaperOverlayStyle(style) {
            const source = style && typeof style === 'object' ? style : {};
            const overlay = source.overlay && typeof source.overlay === 'object'
                ? source.overlay
                : {};
            return {
                ...source,
                overlay: {
                    angle: Number.isFinite(Number(overlay.angle)) ? Number(overlay.angle) : 180,
                    topColor: typeof overlay.topColor === 'string' && overlay.topColor.trim()
                        ? overlay.topColor.trim()
                        : '#000000',
                    topOpacity: 0,
                    bottomColor: typeof overlay.bottomColor === 'string' && overlay.bottomColor.trim()
                        ? overlay.bottomColor.trim()
                        : (
                            typeof overlay.topColor === 'string' && overlay.topColor.trim()
                                ? overlay.topColor.trim()
                                : '#000000'
                        ),
                    bottomOpacity: 0
                }
            };
        }

        function clampWallpaperAutoStyleNumber(value, min, max, fallback) {
            const numeric = Number(value);
            if (!Number.isFinite(numeric)) {
                return fallback;
            }
            return Math.min(max, Math.max(min, numeric));
        }

        function rgbToHslForWallpaperAutoStyle(rgb) {
            const red = clampWallpaperAutoStyleNumber(rgb?.r, 0, 255, 0) / 255;
            const green = clampWallpaperAutoStyleNumber(rgb?.g, 0, 255, 0) / 255;
            const blue = clampWallpaperAutoStyleNumber(rgb?.b, 0, 255, 0) / 255;
            const max = Math.max(red, green, blue);
            const min = Math.min(red, green, blue);
            const delta = max - min;
            let hue = 0;

            if (delta !== 0) {
                if (max === red) {
                    hue = ((green - blue) / delta) % 6;
                } else if (max === green) {
                    hue = ((blue - red) / delta) + 2;
                } else {
                    hue = ((red - green) / delta) + 4;
                }
            }

            hue = (hue * 60 + 360) % 360;
            const lightness = (max + min) / 2;
            const saturation = delta === 0
                ? 0
                : delta / (1 - Math.abs((2 * lightness) - 1));

            return {
                h: hue,
                s: saturation,
                l: lightness
            };
        }

        function hslToRgbForWallpaperAutoStyle(hsl) {
            const hue = ((Number(hsl?.h) % 360) + 360) % 360;
            const saturation = clampWallpaperAutoStyleNumber(hsl?.s, 0, 1, 0);
            const lightness = clampWallpaperAutoStyleNumber(hsl?.l, 0, 1, 0);
            const chroma = (1 - Math.abs((2 * lightness) - 1)) * saturation;
            const huePrime = hue / 60;
            const second = chroma * (1 - Math.abs((huePrime % 2) - 1));
            let red = 0;
            let green = 0;
            let blue = 0;

            if (huePrime >= 0 && huePrime < 1) {
                red = chroma;
                green = second;
            } else if (huePrime < 2) {
                red = second;
                green = chroma;
            } else if (huePrime < 3) {
                green = chroma;
                blue = second;
            } else if (huePrime < 4) {
                green = second;
                blue = chroma;
            } else if (huePrime < 5) {
                red = second;
                blue = chroma;
            } else {
                red = chroma;
                blue = second;
            }

            const match = lightness - (chroma / 2);
            return {
                r: Math.round((red + match) * 255),
                g: Math.round((green + match) * 255),
                b: Math.round((blue + match) * 255)
            };
        }

        function loadWallpaperImageForAutoStyle(sourceUrl) {
            const source = typeof sourceUrl === 'string' ? sourceUrl.trim() : '';
            if (!source) {
                return Promise.reject(new Error('Missing wallpaper image source.'));
            }

            return new Promise((resolve, reject) => {
                const image = new Image();
                image.decoding = 'async';
                image.onload = () => resolve(image);
                image.onerror = () => reject(new Error('Failed to load wallpaper image.'));
                image.src = source;
            });
        }

        function collectWallpaperAutoStyleCandidates(imageData) {
            const { data } = imageData || {};
            const bins = new Map();
            let total = 0;
            let sumR = 0;
            let sumG = 0;
            let sumB = 0;

            if (!data || typeof data.length !== 'number') {
                return {
                    candidates: [],
                    averageRgb: null
                };
            }

            for (let index = 0; index < data.length; index += 4) {
                const alpha = data[index + 3];
                if (alpha < 24) {
                    continue;
                }

                const red = data[index];
                const green = data[index + 1];
                const blue = data[index + 2];
                const quantizedKey = `${red >> 4}-${green >> 4}-${blue >> 4}`;
                let bucket = bins.get(quantizedKey);
                if (!bucket) {
                    bucket = { count: 0, sumR: 0, sumG: 0, sumB: 0 };
                    bins.set(quantizedKey, bucket);
                }

                bucket.count += 1;
                bucket.sumR += red;
                bucket.sumG += green;
                bucket.sumB += blue;
                total += 1;
                sumR += red;
                sumG += green;
                sumB += blue;
            }

            if (!total) {
                return {
                    candidates: [],
                    averageRgb: null
                };
            }

            const candidates = Array.from(bins.values())
                .map((bucket) => {
                    const rgb = {
                        r: bucket.sumR / bucket.count,
                        g: bucket.sumG / bucket.count,
                        b: bucket.sumB / bucket.count
                    };
                    return {
                        count: bucket.count,
                        rgb,
                        hsl: rgbToHslForWallpaperAutoStyle(rgb),
                        luminance: relativeLuminanceFromRgb(rgb)
                    };
                })
                .sort((left, right) => right.count - left.count);

            return {
                candidates,
                averageRgb: {
                    r: sumR / total,
                    g: sumG / total,
                    b: sumB / total
                }
            };
        }

        function pickWallpaperAutoStyleAccentCandidate(candidates, theme, fallbackRgb) {
            const normalizedCandidates = Array.isArray(candidates) ? candidates : [];
            if (!normalizedCandidates.length) {
                return fallbackRgb;
            }

            const maxCount = normalizedCandidates[0].count || 1;
            const targetLuminance = normalizeThemeMode(theme) === 'light' ? 0.38 : 0.56;
            let best = null;
            let bestScore = Number.NEGATIVE_INFINITY;

            normalizedCandidates.slice(0, 128).forEach((candidate) => {
                const populationScore = candidate.count / maxCount;
                const saturationScore = candidate.hsl?.s || 0;
                const luminanceScore = 1 - Math.min(1, Math.abs((candidate.luminance ?? 0) - targetLuminance) / 0.55);
                const chromaBias = saturationScore > 0.22 ? 0.08 : -0.12;
                const neutralPenalty = saturationScore < 0.1 ? -0.25 : 0;
                const score = (populationScore * 0.45)
                    + (saturationScore * 0.35)
                    + (luminanceScore * 0.2)
                    + chromaBias
                    + neutralPenalty;
                if (score > bestScore) {
                    bestScore = score;
                    best = candidate.rgb;
                }
            });

            return best || normalizedCandidates[0].rgb || fallbackRgb;
        }

        function pickWallpaperAutoStyleAmbientCandidate(candidates, theme, fallbackRgb) {
            const normalizedCandidates = Array.isArray(candidates) ? candidates : [];
            if (!normalizedCandidates.length) {
                return fallbackRgb;
            }

            const maxCount = normalizedCandidates[0].count || 1;
            const targetLuminance = normalizeThemeMode(theme) === 'light' ? 0.86 : 0.2;
            let best = null;
            let bestScore = Number.NEGATIVE_INFINITY;

            normalizedCandidates.slice(0, 128).forEach((candidate) => {
                const populationScore = candidate.count / maxCount;
                const saturationScore = candidate.hsl?.s || 0;
                const luminanceScore = 1 - Math.min(1, Math.abs((candidate.luminance ?? 0) - targetLuminance) / 0.7);
                const neutralityScore = 1 - Math.min(1, saturationScore / 0.6);
                const score = (populationScore * 0.55)
                    + (luminanceScore * 0.3)
                    + (neutralityScore * 0.15);
                if (score > bestScore) {
                    bestScore = score;
                    best = candidate.rgb;
                }
            });

            return best || normalizedCandidates[0].rgb || fallbackRgb;
        }

        function normalizeWallpaperAutoStylePrimaryRgbForTheme(rgb, theme) {
            const hsl = rgbToHslForWallpaperAutoStyle(rgb);
            return normalizeThemeMode(theme) === 'light'
                ? hslToRgbForWallpaperAutoStyle({
                    h: hsl.h,
                    s: clampWallpaperAutoStyleNumber(Math.max(hsl.s, 0.22), 0.22, 0.72, hsl.s),
                    l: clampWallpaperAutoStyleNumber(hsl.l, 0.28, 0.56, hsl.l)
                })
                : hslToRgbForWallpaperAutoStyle({
                    h: hsl.h,
                    s: clampWallpaperAutoStyleNumber(Math.max(hsl.s, 0.25), 0.25, 0.8, hsl.s),
                    l: clampWallpaperAutoStyleNumber(hsl.l, 0.36, 0.68, hsl.l)
                });
        }

        function buildUserUploadWallpaperAutoStyleFromPalette({
            accentRgb = null,
            ambientRgb = null,
            averageRgb = null,
            theme = getThemeMode()
        } = {}) {
            const normalizedTheme = normalizeThemeMode(theme);
            const defaultStyle = buildUserUploadWallpaperBaseStyle(normalizedTheme);
            const fallbackPrimaryRgb = hexToRgb(defaultStyle.primary) || { r: 5, g: 229, b: 123 };
            const fallbackBoardRgb = hexToRgb(defaultStyle.boardBackgroundColor) || { r: 41, g: 46, b: 61 };
            const effectiveAccentRgb = accentRgb || averageRgb || fallbackPrimaryRgb;
            const effectiveAmbientRgb = ambientRgb || averageRgb || fallbackBoardRgb;
            const primary = rgbToHex(
                normalizeWallpaperAutoStylePrimaryRgbForTheme(effectiveAccentRgb, normalizedTheme)
            );
            const ambientHsl = rgbToHslForWallpaperAutoStyle(effectiveAmbientRgb);
            const boardSurfaceHsl = normalizedTheme === 'light'
                ? {
                    h: ambientHsl.h,
                    s: clampWallpaperAutoStyleNumber(ambientHsl.s * 0.35, 0.04, 0.18, 0.12),
                    l: clampWallpaperAutoStyleNumber(0.9 + ((ambientHsl.l - 0.5) * 0.08), 0.84, 0.95, 0.9)
                }
                : {
                    h: ambientHsl.h,
                    s: clampWallpaperAutoStyleNumber(ambientHsl.s * 0.45, 0.08, 0.28, 0.16),
                    l: clampWallpaperAutoStyleNumber(ambientHsl.l * 0.55, 0.1, 0.22, 0.18)
                };
            const boardBackgroundColor = rgbToHex(hslToRgbForWallpaperAutoStyle(boardSurfaceHsl));
            const boardTextColor = resolveReadableForegroundForHex(boardBackgroundColor, '#1A1F2E', '#FFFFFF');
            const boardTextRgb = hexToRgb(boardTextColor) || { r: 26, g: 31, b: 46 };
            const boardBackgroundRgb = hexToRgb(boardBackgroundColor) || fallbackBoardRgb;
            const linkDescriptionTextColor = rgbToHex(
                mixRgb(
                    boardTextRgb,
                    boardBackgroundRgb,
                    normalizedTheme === 'light' ? 0.4 : 0.32
                )
            );

            return normalizeUserUploadWallpaperStyle(normalizedTheme, {
                ...defaultStyle,
                primary,
                activeTextColor: resolveReadableForegroundForHex(primary, '#1A1F2E', '#FFFFFF'),
                tabHoverTextColor: boardTextColor,
                inactiveTabTextColor: boardTextColor,
                boardTextColor,
                linkDescriptionTextColor,
                iconColor: boardTextColor,
                tabArrowColor: boardTextColor,
                boardBackgroundColor
            });
        }

        async function buildUserUploadWallpaperAutoStyleFromDataUrl(dataUrl, theme) {
            const source = typeof dataUrl === 'string' ? dataUrl.trim() : '';
            if (!source) {
                return null;
            }

            const image = await loadWallpaperImageForAutoStyle(source);
            const naturalWidth = image.naturalWidth || image.width;
            const naturalHeight = image.naturalHeight || image.height;
            if (!naturalWidth || !naturalHeight) {
                throw new Error('Wallpaper image is empty.');
            }

            const scale = Math.min(
                1,
                USER_UPLOAD_WALLPAPER_AUTO_STYLE_SAMPLE_MAX_DIMENSION / Math.max(naturalWidth, naturalHeight)
            );
            const targetWidth = Math.max(1, Math.round(naturalWidth * scale));
            const targetHeight = Math.max(1, Math.round(naturalHeight * scale));
            const canvas = document.createElement('canvas');
            canvas.width = targetWidth;
            canvas.height = targetHeight;
            const context = canvas.getContext('2d', { willReadFrequently: true });
            if (!context) {
                throw new Error('Canvas context unavailable for wallpaper style analysis.');
            }

            context.drawImage(image, 0, 0, targetWidth, targetHeight);
            const imageData = context.getImageData(0, 0, targetWidth, targetHeight);
            const { candidates, averageRgb } = collectWallpaperAutoStyleCandidates(imageData);

            return buildUserUploadWallpaperAutoStyleFromPalette({
                accentRgb: pickWallpaperAutoStyleAccentCandidate(candidates, theme, averageRgb),
                ambientRgb: pickWallpaperAutoStyleAmbientCandidate(candidates, theme, averageRgb),
                averageRgb,
                theme
            });
        }

        function buildUserUploadWallpaperBaseStyle(theme) {
            return buildZeroWallpaperOverlayStyle(
                getResolvedWallpaperStyleForTheme(theme, {
                    allowWallpaper: false,
                    includeUserOverrides: false
                })
            );
        }

        function normalizeUserUploadWallpaperStyle(theme, rawStyle) {
            const normalizedTheme = normalizeThemeMode(theme);
            const defaultStyle = buildUserUploadWallpaperBaseStyle(normalizedTheme);
            const resolvedStyle = typeof normalizeWallpaperStyleConfig === 'function'
                ? normalizeWallpaperStyleConfig(rawStyle, defaultStyle)
                : {
                    ...defaultStyle,
                    ...(rawStyle && typeof rawStyle === 'object' ? rawStyle : {})
                };
            const zeroOverlayStyle = buildZeroWallpaperOverlayStyle(resolvedStyle);
            const nextStyleSource = {
                ...zeroOverlayStyle,
                addBoardColor: '#FFFFFF',
                inactiveControlColor: zeroOverlayStyle.boardBackgroundColor,
                inactiveControlOpacity: zeroOverlayStyle.boardBackgroundOpacity,
                inactiveControlBackdropBlur: zeroOverlayStyle.boardBackdropBlur,
                popupBackgroundColor: zeroOverlayStyle.boardBackgroundColor,
                popupBackgroundOpacity: 1,
                dropdownBackgroundColor: zeroOverlayStyle.boardBackgroundColor,
                dropdownBackgroundOpacity: 1
            };
            const normalizedStyle = typeof normalizeWallpaperStyleConfig === 'function'
                ? normalizeWallpaperStyleConfig(nextStyleSource, defaultStyle)
                : nextStyleSource;
            return buildZeroWallpaperOverlayStyle(normalizedStyle);
        }

        function areWallpaperStylesEqual(theme, leftStyle, rightStyle) {
            return JSON.stringify(normalizeUserUploadWallpaperStyle(theme, leftStyle))
                === JSON.stringify(normalizeUserUploadWallpaperStyle(theme, rightStyle));
        }

        function applyWallpaperStyleEditorDraftPreview() {
            if (!wallpaperStyleEditorState) {
                return false;
            }
            applyThemeStyleTokens(wallpaperStyleEditorState.draftStyle);
            return true;
        }

        function isWallpaperStyleEditorAllowed() {
            const currentWallpaperUserId = typeof getWallpaperAccountScopeUserId === 'function'
                ? getWallpaperAccountScopeUserId()
                : null;
            if (!currentWallpaperUserId) {
                return false;
            }
            if (
                typeof canMutateAccountScopedPreferences === 'function'
                && !canMutateAccountScopedPreferences()
            ) {
                return false;
            }
            return true;
        }

        function getWallpaperStyleEditorModalElements() {
            return {
                modal: document.getElementById('wallpaperStyleModal'),
                title: document.getElementById('wallpaperStyleModalTitle'),
                subtitle: document.getElementById('wallpaperStyleModalSubtitle'),
                controls: document.getElementById('wallpaperStyleModalControls'),
                resetButton: document.getElementById('wallpaperStyleModalResetBtn'),
                saveButton: document.getElementById('wallpaperStyleModalSaveBtn')
            };
        }

        function collapseWallpaperPopupForStyleEditor() {
            const wallpaperPopup = document.getElementById('wallpaperPopup');
            const floatingWallpaperBtn = document.getElementById('floatingWallpaperBtn');
            const popupWasActive = wallpaperPopup?.classList.contains('active') === true;

            closeWallpaperContextMenu();

            if (wallpaperPopup) {
                wallpaperPopup.classList.remove('active');
                wallpaperPopup.setAttribute('aria-hidden', 'true');
                wallpaperPopup.setAttribute('inert', '');
            }
            if (floatingWallpaperBtn) {
                floatingWallpaperBtn.classList.remove('active');
                floatingWallpaperBtn.setAttribute('aria-expanded', 'false');
            }

            return popupWasActive
                && floatingWallpaperBtn
                && typeof floatingWallpaperBtn.focus === 'function'
                ? floatingWallpaperBtn
                : null;
        }

        function updateWallpaperStyleEditorActionButtons() {
            const {
                resetButton,
                saveButton
            } = getWallpaperStyleEditorModalElements();
            if (!wallpaperStyleEditorState) {
                if (resetButton) {
                    resetButton.disabled = true;
                }
                if (saveButton) {
                    saveButton.disabled = true;
                }
                return;
            }

            const hasPendingChanges = !areWallpaperStylesEqual(
                wallpaperStyleEditorState.theme,
                wallpaperStyleEditorState.originalStyle,
                wallpaperStyleEditorState.draftStyle
            );
            const isAtDefaultStyle = areWallpaperStylesEqual(
                wallpaperStyleEditorState.theme,
                wallpaperStyleEditorState.defaultStyle,
                wallpaperStyleEditorState.draftStyle
            );

            if (resetButton) {
                resetButton.disabled = isAtDefaultStyle;
            }
            if (saveButton) {
                saveButton.disabled = !hasPendingChanges;
            }
        }

        function renderWallpaperStyleEditorModal() {
            const {
                title,
                subtitle,
                controls
            } = getWallpaperStyleEditorModalElements();
            if (!wallpaperStyleEditorState || !controls) {
                if (controls) {
                    controls.replaceChildren();
                }
                updateWallpaperStyleEditorActionButtons();
                return;
            }

            const activeTheme = wallpaperStyleEditorState.theme;
            const currentStyle = wallpaperStyleEditorState.draftStyle;
            const themeLabel = activeTheme === 'light' ? 'Light' : 'Dark';

            if (title) {
                title.textContent = 'Adjust Wallpaper Style';
            }
            if (subtitle) {
                subtitle.textContent = `${themeLabel} theme on this device.`;
            }

            const controlsGrid = document.createElement('div');
            controlsGrid.className = 'wallpaper-style-controls-grid';

            const applyDraftPatch = (stylePatch) => {
                if (!wallpaperStyleEditorState || !isWallpaperStyleEditorAllowed()) {
                    closeWallpaperStyleEditor({
                        restoreOriginalState: true,
                        restoreFocus: false
                    });
                    renderWallpaperPopup({ preserveScroll: true });
                    return;
                }

                wallpaperStyleEditorState.draftStyle = normalizeUserUploadWallpaperStyle(activeTheme, {
                    ...wallpaperStyleEditorState.draftStyle,
                    ...stylePatch
                });
                applyWallpaperStyleEditorDraftPreview();
                updateWallpaperStyleEditorActionButtons();
            };

            controlsGrid.append(
                createWallpaperStyleColorControl({
                    label: 'Primary Color',
                    value: currentStyle.primary,
                    onInput: (value) => {
                        applyDraftPatch({ primary: value });
                    }
                }),
                createWallpaperStyleColorControl({
                    label: 'Board Color',
                    value: currentStyle.boardBackgroundColor,
                    onInput: (value) => {
                        applyDraftPatch({ boardBackgroundColor: value });
                    }
                }),
                createWallpaperStyleRangeControl({
                    label: 'Board Opacity',
                    value: Math.round(currentStyle.boardBackgroundOpacity * 100),
                    min: 0,
                    max: 100,
                    step: 1,
                    formatter: (value) => `${Math.round(Number(value) || 0)}%`,
                    onInput: (value) => {
                        applyDraftPatch({
                            boardBackgroundOpacity: Number(value) / 100
                        });
                    }
                }),
                createWallpaperStyleRangeControl({
                    label: 'Board Blur',
                    value: Math.round(currentStyle.boardBackdropBlur),
                    min: 0,
                    max: 40,
                    step: 1,
                    formatter: (value) => `${Math.round(Number(value) || 0)}px`,
                    onInput: (value) => {
                        applyDraftPatch({
                            boardBackdropBlur: Number(value)
                        });
                    }
                })
            );

            controls.replaceChildren(controlsGrid);
            updateWallpaperStyleEditorActionButtons();
        }

        function openWallpaperStyleEditor({
            theme = getThemeMode(),
            wallpaperId = null,
            wallpaperLabel = null,
            returnFocusElement = null,
            initialDraftStyle = null
        } = {}) {
            if (!isWallpaperStyleEditorAllowed()) {
                return false;
            }

            const {
                modal,
                controls
            } = getWallpaperStyleEditorModalElements();
            if (!modal || !controls) {
                return false;
            }

            const normalizedTheme = normalizeThemeMode(theme);
            const installedRecord = isInstalledWallpaperRef(wallpaperId)
                ? getInstalledWallpaperRecordByRef(wallpaperId)
                : null;
            if (!installedRecord || !isUserUploadWallpaperSourceType(installedRecord?.sourceType)) {
                return false;
            }

            const collapsedPopupFocusTarget = collapseWallpaperPopupForStyleEditor();

            const defaultStyle = buildUserUploadWallpaperBaseStyle(normalizedTheme);
            const originalStyle = normalizeUserUploadWallpaperStyle(
                normalizedTheme,
                installedRecord?.style || defaultStyle
            );
            wallpaperStyleEditorState = {
                theme: normalizedTheme,
                wallpaperId: wallpaperId ?? null,
                wallpaperLabel: wallpaperLabel || 'Wallpaper',
                defaultStyle,
                originalStyle,
                draftStyle: normalizeUserUploadWallpaperStyle(
                    normalizedTheme,
                    initialDraftStyle || originalStyle
                ),
                returnFocusElement: (collapsedPopupFocusTarget || returnFocusElement)
                    && typeof (collapsedPopupFocusTarget || returnFocusElement).focus === 'function'
                    ? (collapsedPopupFocusTarget || returnFocusElement)
                    : null
            };

            applyWallpaperStyleEditorDraftPreview();
            renderWallpaperStyleEditorModal();
            modal.classList.add('active');
            const focusFirstInput = () => {
                const firstInput = modal.querySelector('.wallpaper-style-color-input, .wallpaper-style-range-input');
                if (firstInput && typeof firstInput.focus === 'function') {
                    firstInput.focus({ preventScroll: true });
                }
            };
            if (typeof requestAnimationFrame === 'function') {
                requestAnimationFrame(() => {
                    focusFirstInput();
                });
            } else {
                focusFirstInput();
            }
            return true;
        }

        function closeWallpaperStyleEditor({
            restoreOriginalState = true,
            restoreFocus = true
        } = {}) {
            const {
                modal,
                controls
            } = getWallpaperStyleEditorModalElements();
            const activeSession = wallpaperStyleEditorState;
            wallpaperStyleEditorState = null;
            if (restoreOriginalState && activeSession) {
                applyActiveThemeWallpaper();
            }
            if (controls) {
                controls.replaceChildren();
            }
            if (modal) {
                modal.classList.remove('active');
            }
            if (
                restoreFocus
                && activeSession?.returnFocusElement
                && activeSession.returnFocusElement.isConnected !== false
                && typeof activeSession.returnFocusElement.focus === 'function'
            ) {
                activeSession.returnFocusElement.focus({ preventScroll: true });
            }
        }

        function resetWallpaperStyleEditorDraft() {
            if (!wallpaperStyleEditorState) {
                return false;
            }
            if (!isWallpaperStyleEditorAllowed()) {
                closeWallpaperStyleEditor({
                    restoreOriginalState: true,
                    restoreFocus: false
                });
                renderWallpaperPopup({ preserveScroll: true });
                return false;
            }

            wallpaperStyleEditorState.draftStyle = normalizeUserUploadWallpaperStyle(
                wallpaperStyleEditorState.theme,
                wallpaperStyleEditorState.defaultStyle
            );
            applyWallpaperStyleEditorDraftPreview();
            renderWallpaperStyleEditorModal();
            return true;
        }

        async function saveWallpaperStyleEditorDraft() {
            if (!wallpaperStyleEditorState) {
                return false;
            }
            if (!isWallpaperStyleEditorAllowed()) {
                closeWallpaperStyleEditor({
                    restoreOriginalState: true,
                    restoreFocus: false
                });
                renderWallpaperPopup({ preserveScroll: true });
                return false;
            }

            const activeSession = wallpaperStyleEditorState;
            if (!isInstalledWallpaperRef(activeSession?.wallpaperId)) {
                closeWallpaperStyleEditor({
                    restoreOriginalState: true,
                    restoreFocus: false
                });
                renderWallpaperPopup({ preserveScroll: true });
                return false;
            }

            const installedRecord = getInstalledWallpaperRecordByRef(activeSession.wallpaperId);
            if (!installedRecord || !isUserUploadWallpaperSourceType(installedRecord?.sourceType)) {
                closeWallpaperStyleEditor({
                    restoreOriginalState: true,
                    restoreFocus: false
                });
                renderWallpaperPopup({ preserveScroll: true });
                return false;
            }

            const finalStyle = normalizeUserUploadWallpaperStyle(
                activeSession.theme,
                activeSession.draftStyle
            );
            try {
                const clearedPatch = await buildWallpaperAccountLocalStateStoragePatch({
                    styleOverrides: getNormalizedWallpaperStyleOverrideState(null)
                });
                if (clearedPatch && typeof chrome !== 'undefined' && chrome.storage?.local) {
                    await commitWallpaperAccountStoragePayload(clearedPatch);
                }
                if (typeof setInstalledWallpaperStyleLocally !== 'function') {
                    throw new Error('Wallpaper style saving is unavailable.');
                }
                await setInstalledWallpaperStyleLocally(activeSession.wallpaperId, {
                    style: finalStyle
                });
            } catch (error) {
                console.error('Failed to save wallpaper style:', error);
                showGlassToast('Style changes could not be saved. Please try again.', 'warning', 3600);
                return false;
            }

            closeWallpaperStyleEditor({
                restoreOriginalState: false
            });
            applyActiveThemeWallpaper();
            renderWallpaperPopup({ preserveScroll: true });
            return true;
        }

        function maybeOpenWallpaperStyleEditorAfterSelection(theme, wallpaperId, {
            wallpaperLabel = null,
            returnFocusElement = null,
            initialDraftStyle = null
        } = {}) {
            if (!isWallpaperStyleEditorAllowed()) {
                return false;
            }
            if (!isInstalledWallpaperRef(wallpaperId)) {
                return false;
            }
            const installedRecord = getInstalledWallpaperRecordByRef(wallpaperId);
            if (!isUserUploadWallpaperSourceType(installedRecord?.sourceType)) {
                return false;
            }
            return openWallpaperStyleEditor({
                theme,
                wallpaperId,
                wallpaperLabel,
                returnFocusElement,
                initialDraftStyle
            });
        }

        async function readPendingNewUserWallpaperDefaultSeed() {
            if (!wallpaperNewUserDefaultSeedStorageKey || !(typeof chrome !== 'undefined' && chrome.storage?.local)) {
                return null;
            }

            try {
                const result = await chrome.storage.local.get(wallpaperNewUserDefaultSeedStorageKey);
                const source = result?.[wallpaperNewUserDefaultSeedStorageKey];
                if (!source || typeof source !== 'object') {
                    return null;
                }

                const userId = (typeof source.userId === 'string' && source.userId.trim())
                    ? source.userId.trim()
                    : null;
                if (!userId) {
                    return null;
                }

                const createdAt = Number(source.createdAt);
                const isFresh = Number.isFinite(createdAt) && (Date.now() - createdAt) <= (30 * 60 * 1000);
                if (!isFresh) {
                    return null;
                }

                return {
                    userId,
                    createdAt
                };
            } catch (error) {
                console.warn('Failed to read pending new-user wallpaper default seed:', error);
                return null;
            }
        }

        async function clearPendingNewUserWallpaperDefaultSeed() {
            if (!wallpaperNewUserDefaultSeedStorageKey || !(typeof chrome !== 'undefined' && chrome.storage?.local)) {
                return;
            }

            try {
                await chrome.storage.local.remove(wallpaperNewUserDefaultSeedStorageKey);
            } catch (error) {
                console.warn('Failed to clear pending new-user wallpaper default seed:', error);
            }
        }

        function buildConfiguredNewUserWallpaperDefaultSeed() {
            const configuredDefault = typeof getWallpaperNewUserDefaultConfig === 'function'
                ? getWallpaperNewUserDefaultConfig()
                : null;
            const rawSelection = configuredDefault?.selectionByTheme && typeof configuredDefault.selectionByTheme === 'object'
                ? configuredDefault.selectionByTheme
                : {};
            const selectionByTheme = {
                dark: null,
                light: null
            };

            ['dark', 'light'].forEach((theme) => {
                const normalizedSelection = normalizeWallpaperPathForTheme(theme, rawSelection[theme]);
                if (normalizedSelection && findWallpaperCatalogEntry(theme, normalizedSelection)) {
                    selectionByTheme[theme] = normalizedSelection;
                }
            });

            let themeMode = (configuredDefault?.themeMode === 'dark' || configuredDefault?.themeMode === 'light')
                ? configuredDefault.themeMode
                : null;
            if (!themeMode) {
                themeMode = selectionByTheme.dark
                    ? 'dark'
                    : (selectionByTheme.light ? 'light' : null);
            }

            return {
                themeMode,
                selectionByTheme: {
                    dark: selectionByTheme.dark,
                    light: selectionByTheme.light
                }
            };
        }

        async function seedNewUserWallpaperDefaultIfPending() {
            const currentWallpaperUserId = typeof getWallpaperAccountScopeUserId === 'function'
                ? getWallpaperAccountScopeUserId()
                : null;
            if (!currentWallpaperUserId) {
                return false;
            }

            const pendingSeed = await readPendingNewUserWallpaperDefaultSeed();
            if (!pendingSeed || pendingSeed.userId !== currentWallpaperUserId) {
                return false;
            }

            const existingAccountState = await getWallpaperAccountLocalState(currentWallpaperUserId);
            if (hasConfiguredWallpaperAccountLocalState(existingAccountState)) {
                await clearPendingNewUserWallpaperDefaultSeed();
                return false;
            }

            const configuredSeed = buildConfiguredNewUserWallpaperDefaultSeed();
            if (!(configuredSeed.themeMode === 'dark' || configuredSeed.themeMode === 'light')) {
                await clearPendingNewUserWallpaperDefaultSeed();
                return false;
            }

            if (!(typeof chrome !== 'undefined' && chrome.storage?.local)) {
                await clearPendingNewUserWallpaperDefaultSeed();
                return false;
            }

            const storagePayload = {
                themeMode: configuredSeed.themeMode,
                [wallpaperStorageKey]: configuredSeed.selectionByTheme
            };
            const accountStatePatch = await buildWallpaperAccountLocalStateStoragePatch({
                themeMode: configuredSeed.themeMode,
                selection: configuredSeed.selectionByTheme
            });
            if (accountStatePatch) {
                Object.assign(storagePayload, accountStatePatch);
            }

            await commitWallpaperAccountStoragePayload(storagePayload);

            try {
                localStorage.setItem('lumilist_theme_mode', configuredSeed.themeMode);
            } catch (_error) {
                // Non-blocking cache write
            }

            cacheWallpaperSelectionLocally(configuredSeed.selectionByTheme);
            await clearPendingNewUserWallpaperDefaultSeed();
            return true;
        }

        async function seedPackagedDefaultForEmptyLocalWallpaperState() {
            const currentWallpaperUserId = typeof getWallpaperAccountScopeUserId === 'function'
                ? getWallpaperAccountScopeUserId()
                : null;
            if (!currentWallpaperUserId) {
                return false;
            }

            if (!(typeof chrome !== 'undefined' && chrome.storage?.local)) {
                return false;
            }

            const existingAccountState = await getWallpaperAccountLocalState(currentWallpaperUserId);
            if (hasConfiguredWallpaperAccountLocalState(existingAccountState)) {
                return false;
            }

            let sharedThemeMode = null;
            let hasSharedSelectionKey = false;
            try {
                const sharedState = await chrome.storage.local.get([
                    'themeMode',
                    wallpaperStorageKey
                ]);
                sharedThemeMode = (sharedState?.themeMode === 'dark' || sharedState?.themeMode === 'light')
                    ? sharedState.themeMode
                    : null;
                hasSharedSelectionKey = Object.prototype.hasOwnProperty.call(sharedState || {}, wallpaperStorageKey);
            } catch (error) {
                console.warn('Failed to inspect shared wallpaper storage before packaged fallback seed:', error);
            }

            if (sharedThemeMode || hasSharedSelectionKey) {
                return false;
            }

            const configuredSeed = buildConfiguredNewUserWallpaperDefaultSeed();
            if (!(configuredSeed.themeMode === 'dark' || configuredSeed.themeMode === 'light')) {
                return false;
            }

            const storagePayload = {
                themeMode: configuredSeed.themeMode,
                [wallpaperStorageKey]: configuredSeed.selectionByTheme
            };
            const accountStatePatch = await buildWallpaperAccountLocalStateStoragePatch({
                themeMode: configuredSeed.themeMode,
                selection: configuredSeed.selectionByTheme
            });
            if (accountStatePatch) {
                Object.assign(storagePayload, accountStatePatch);
            }

            await commitWallpaperAccountStoragePayload(storagePayload);

            try {
                localStorage.setItem('lumilist_theme_mode', configuredSeed.themeMode);
            } catch (_error) {
                // Non-blocking cache write
            }

            cacheWallpaperSelectionLocally(configuredSeed.selectionByTheme);
            return true;
        }

        function updateThemeModeToggle() {
            const darkBtn = document.getElementById('wallpaperThemeDarkBtn');
            const lightBtn = document.getElementById('wallpaperThemeLightBtn');
            const isLight = getThemeMode() === 'light';

            if (darkBtn) {
                darkBtn.classList.toggle('active', !isLight);
                darkBtn.setAttribute('aria-pressed', String(!isLight));
            }
            if (lightBtn) {
                lightBtn.classList.toggle('active', isLight);
                lightBtn.setAttribute('aria-pressed', String(isLight));
            }
        }

        function setWallpaperDownloadOverlayVisible(isVisible) {
            const overlay = document.getElementById('loadingOverlay');
            if (!overlay) return;

            if (isVisible) {
                if (typeof updateLoadingMessage === 'function') {
                    updateLoadingMessage(
                        'Wallpaper downloading...',
                        'Please wait while we add it to LumiLinks.'
                    );
                }
                overlay.style.display = '';
                overlay.classList.remove('hidden');
                return;
            }

            overlay.classList.add('hidden');
            window.setTimeout(() => {
                if (overlay.classList.contains('hidden')) {
                    overlay.style.display = 'none';
                }
            }, 300);
        }

        function pushWallpaperDownloadOverlayVisible() {
            wallpaperDownloadOverlayRequestCount += 1;
            if (wallpaperDownloadOverlayRequestCount === 1) {
                setWallpaperDownloadOverlayVisible(true);
            }
        }

        function popWallpaperDownloadOverlayVisible() {
            if (wallpaperDownloadOverlayRequestCount > 0) {
                wallpaperDownloadOverlayRequestCount -= 1;
            }
            if (wallpaperDownloadOverlayRequestCount === 0) {
                setWallpaperDownloadOverlayVisible(false);
            }
        }

        function getWallpaperHandoffStorage() {
            try {
                if (typeof sessionStorage !== 'undefined') {
                    return sessionStorage;
                }
            } catch (_error) {
                // Fall back to localStorage if sessionStorage is unavailable.
            }

            try {
                if (typeof localStorage !== 'undefined') {
                    return localStorage;
                }
            } catch (_error) {
                // Storage unavailable.
            }

            return null;
        }

        function normalizePendingWallpaperHandoff(rawValue) {
            const source = rawValue && typeof rawValue === 'object' ? rawValue : {};
            const theme = normalizeThemeMode(source.theme || source.wallpaperTheme);
            const galleryId = typeof source.galleryId === 'string' && source.galleryId.trim()
                ? source.galleryId.trim()
                : null;
            const wallpaper = normalizeWallpaperPathForTheme(theme, source.wallpaper || null);

            if (!galleryId && !wallpaper) {
                return null;
            }

            return {
                theme,
                galleryId,
                wallpaper,
                storedAt: typeof source.storedAt === 'string' && source.storedAt.trim()
                    ? source.storedAt.trim()
                    : new Date().toISOString()
            };
        }

        function readPendingWallpaperHandoff() {
            const storage = getWallpaperHandoffStorage();
            if (!storage || !wallpaperPendingHandoffStorageKey) {
                return null;
            }

            try {
                return normalizePendingWallpaperHandoff(
                    JSON.parse(storage.getItem(wallpaperPendingHandoffStorageKey) || 'null')
                );
            } catch (_error) {
                return null;
            }
        }

        function writePendingWallpaperHandoff(rawValue) {
            const storage = getWallpaperHandoffStorage();
            if (!storage || !wallpaperPendingHandoffStorageKey) {
                return;
            }

            const normalized = normalizePendingWallpaperHandoff(rawValue);
            if (!normalized) {
                storage.removeItem(wallpaperPendingHandoffStorageKey);
                return;
            }

            storage.setItem(wallpaperPendingHandoffStorageKey, JSON.stringify(normalized));
        }

        function clearPendingWallpaperHandoff() {
            const storage = getWallpaperHandoffStorage();
            if (!storage || !wallpaperPendingHandoffStorageKey) {
                return;
            }

            storage.removeItem(wallpaperPendingHandoffStorageKey);
        }

        function getHostedWallpaperSelectionEntries() {
            const currentSelection = getWallpaperSelectionByTheme();
            return ['dark', 'light'].map((theme) => {
                const normalizedSource = normalizeWallpaperPathForTheme(theme, currentSelection?.[theme]);
                if (!isHostedWallpaperUrl(normalizedSource)) {
                    return null;
                }
                return {
                    theme,
                    sourceUrl: normalizedSource
                };
            }).filter(Boolean);
        }

        async function dataUrlToBlob(dataUrl) {
            const response = await fetch(dataUrl);
            if (!response.ok) {
                throw new Error('Failed to convert cached wallpaper data URL into a blob.');
            }
            return response.blob();
        }

        function readWallpaperUploadFileAsDataUrl(file) {
            return new Promise((resolve, reject) => {
                if (!file || typeof FileReader === 'undefined') {
                    reject(new Error('Please choose an image to upload.'));
                    return;
                }

                const reader = new FileReader();
                reader.onload = () => {
                    const result = typeof reader.result === 'string' ? reader.result : '';
                    if (!result.startsWith('data:image/')) {
                        reject(new Error('Please choose an image file to upload.'));
                        return;
                    }
                    resolve(result);
                };
                reader.onerror = () => {
                    reject(new Error('Failed to read the selected image.'));
                };
                reader.readAsDataURL(file);
            });
        }

        function loadWallpaperUploadImageFromDataUrl(dataUrl) {
            return new Promise((resolve, reject) => {
                if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
                    reject(new Error('Please choose an image file to upload.'));
                    return;
                }

                const image = new Image();
                image.onload = () => resolve(image);
                image.onerror = () => reject(new Error('Failed to load the selected image.'));
                image.src = dataUrl;
            });
        }

        function getNormalizedLocalWallpaperUploadDimensions(
            sourceWidth,
            sourceHeight,
            maxWidth = LOCAL_WALLPAPER_UPLOAD_MAX_WIDTH
        ) {
            const width = Math.trunc(Number(sourceWidth));
            const height = Math.trunc(Number(sourceHeight));
            const normalizedMaxWidth = Math.max(1, Math.trunc(Number(maxWidth)) || LOCAL_WALLPAPER_UPLOAD_MAX_WIDTH);

            if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
                throw new Error('Selected image has invalid dimensions.');
            }

            if (width <= normalizedMaxWidth) {
                return {
                    width,
                    height,
                    wasResized: false
                };
            }

            const scale = normalizedMaxWidth / width;
            return {
                width: normalizedMaxWidth,
                height: Math.max(1, Math.round(height * scale)),
                wasResized: true
            };
        }

        async function convertWallpaperUploadFileToJpegDataUrl(
            file,
            quality = LOCAL_WALLPAPER_UPLOAD_JPEG_QUALITY
        ) {
            const sourceDataUrl = await readWallpaperUploadFileAsDataUrl(file);
            const image = await loadWallpaperUploadImageFromDataUrl(sourceDataUrl);
            const sourceWidth = image.naturalWidth || image.width;
            const sourceHeight = image.naturalHeight || image.height;
            const { width, height } = getNormalizedLocalWallpaperUploadDimensions(sourceWidth, sourceHeight);

            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;

            const context = canvas.getContext('2d', { alpha: false });
            if (!context) {
                throw new Error('Failed to prepare the uploaded image.');
            }

            // Flatten transparency before JPEG encoding so local uploads render consistently.
            context.fillStyle = '#FFFFFF';
            context.fillRect(0, 0, width, height);
            context.imageSmoothingEnabled = true;
            context.imageSmoothingQuality = 'high';
            context.drawImage(image, 0, 0, width, height);

            const jpegDataUrl = canvas.toDataURL('image/jpeg', quality);
            if (!jpegDataUrl || !jpegDataUrl.startsWith('data:image/jpeg;base64,')) {
                throw new Error('Failed to prepare the uploaded image.');
            }

            return jpegDataUrl;
        }

        async function readSharedWallpaperSelectionFromStorage() {
            if (!(typeof chrome !== 'undefined' && chrome.storage?.local)) {
                return null;
            }

            try {
                const result = await chrome.storage.local.get(wallpaperStorageKey);
                if (Object.prototype.hasOwnProperty.call(result || {}, wallpaperStorageKey)) {
                    return result[wallpaperStorageKey];
                }
            } catch (error) {
                console.warn('Failed to read shared wallpaper selection from storage:', error);
            }

            return null;
        }

        async function migrateHostedWallpaperSelections({ allowNetwork = false, showFailureToast = false } = {}) {
            const hostedSelections = getHostedWallpaperSelectionEntries();
            if (hostedSelections.length === 0) {
                return {
                    migratedThemes: [],
                    failedThemes: []
                };
            }

            if (hostedWallpaperSelectionMigrationPromise) {
                return hostedWallpaperSelectionMigrationPromise;
            }

            hostedWallpaperSelectionMigrationPromise = (async () => {
                const migratedThemes = [];
                const failedThemes = [];
                const migrationReplacements = [];
                let remoteCatalog = null;
                let didAnnounceNetworkMigration = false;

                const getRemoteCatalog = async () => {
                    if (!allowNetwork) return null;
                    if (!remoteCatalog) {
                        remoteCatalog = await loadHostedWallpaperCatalog({ apply: false, force: true });
                    }
                    return remoteCatalog;
                };

                for (const { theme, sourceUrl } of hostedSelections) {
                    if (typeof recordWallpaperDiagnosticEvent === 'function') {
                        recordWallpaperDiagnosticEvent('wallpaper-migration-attempted', {
                            theme,
                            sourceUrl,
                            allowNetwork
                        }, {
                            counter: 'migrationAttempts'
                        });
                    }

                    let remoteEntry = findWallpaperCatalogEntry(theme, sourceUrl);

                    if (!remoteEntry && allowNetwork) {
                        const remoteCatalogState = await getRemoteCatalog();
                        const remoteEntries = Array.isArray(remoteCatalogState?.themes?.[theme])
                            ? remoteCatalogState.themes[theme]
                            : [];
                        remoteEntry = remoteEntries.find((entry) => (
                            normalizeWallpaperPathForTheme(theme, entry?.file) === sourceUrl
                        )) || null;
                    }

                    let installResult = null;
                    const cachedDataUrl = getCachedWallpaperBinaryDataUrl(theme, sourceUrl);
                    const fallbackLabel = remoteEntry?.label || formatWallpaperLabelFromFile(sourceUrl);
                    const fallbackStyle = remoteEntry?.style || getResolvedWallpaperStyleForTheme(theme);

                    if (cachedDataUrl) {
                        try {
                            const cachedBlob = await dataUrlToBlob(cachedDataUrl);
                            installResult = await installWallpaperBlobLocally({
                                theme,
                                sourceUrl,
                                imageBlob: cachedBlob,
                                remoteId: remoteEntry?.id || null,
                                label: fallbackLabel,
                                style: fallbackStyle,
                                sourceType: 'migrated-hosted-cache'
                            });
                        } catch (error) {
                            console.warn('Failed to migrate cached hosted wallpaper locally:', error);
                        }
                    }

                    if (!installResult && allowNetwork) {
                        if (!didAnnounceNetworkMigration) {
                            showGlassToast('Updating your saved wallpaper...', 'info', 2200);
                            didAnnounceNetworkMigration = true;
                        }
                        try {
                            installResult = await installRemoteWallpaperLocally({
                                theme,
                                sourceUrl,
                                remoteId: remoteEntry?.id || null,
                                label: fallbackLabel,
                                style: fallbackStyle,
                                installContext: 'hosted-migration'
                            });
                        } catch (error) {
                            console.warn('Failed to migrate hosted wallpaper via remote fetch:', error);
                        }
                    }

                    if (installResult?.installedRef) {
                        migratedThemes.push(theme);
                        if (typeof recordWallpaperDiagnosticEvent === 'function') {
                            recordWallpaperDiagnosticEvent('wallpaper-migration-succeeded', {
                                theme,
                                sourceUrl,
                                installedRef: installResult.installedRef,
                                usedNetwork: allowNetwork
                            });
                        }
                        migrationReplacements.push({
                            theme,
                            previousSourceUrl: sourceUrl,
                            installedRef: installResult.installedRef
                        });
                    } else {
                        failedThemes.push(theme);
                        if (typeof recordWallpaperDiagnosticEvent === 'function') {
                            recordWallpaperDiagnosticEvent('wallpaper-migration-failed', {
                                theme,
                                sourceUrl,
                                allowNetwork
                            }, {
                                counter: 'migrationFailures'
                            });
                        }
                    }
                }

                if (migrationReplacements.length > 0) {
                    const latestSelection = getWallpaperSelectionByTheme();
                    const nextSelection = {
                        dark: latestSelection.dark ?? null,
                        light: latestSelection.light ?? null
                    };
                    let didUpdateSelection = false;

                    for (const replacement of migrationReplacements) {
                        const latestSource = normalizeWallpaperPathForTheme(
                            replacement.theme,
                            latestSelection?.[replacement.theme]
                        );
                        if (latestSource !== replacement.previousSourceUrl) {
                            continue;
                        }
                        nextSelection[replacement.theme] = replacement.installedRef;
                        didUpdateSelection = true;
                    }

                    if (didUpdateSelection) {
                        await setWallpaperSelection(nextSelection, { persist: true });
                    }
                }

                if (showFailureToast && failedThemes.length > 0) {
                    showGlassToast(
                        'We could not fully update one of your saved wallpapers yet. It will keep working for now. If needed, reinstall it from the wallpaper gallery.',
                        'warning',
                        5200
                    );
                }

                return {
                    migratedThemes,
                    failedThemes
                };
            })().finally(() => {
                hostedWallpaperSelectionMigrationPromise = null;
            });

            return hostedWallpaperSelectionMigrationPromise;
        }

        async function handleWallpaperPopupOpened() {
            await migrateHostedWallpaperSelections({
                allowNetwork: true,
                showFailureToast: true
            });
        }

        function getWallpaperTilePreviewSource(theme, filePath) {
            const resolvedPreview = resolveWallpaperRenderSource(theme, filePath);
            if (resolvedPreview) {
                return resolvedPreview;
            }

            if (!isInstalledWallpaperRef(filePath)) {
                return null;
            }

            const installedRecord = getInstalledWallpaperRecordByRef(filePath);
            return installedRecord?.thumbnailUrl || installedRecord?.sourceUrl || null;
        }

        async function cleanupUnavailableInstalledWallpaper(theme, installedRef, { sourceUrl = null, error = null } = {}) {
            const normalizedTheme = normalizeThemeMode(theme);
            const normalizedInstalledRef = normalizeWallpaperPathForTheme(normalizedTheme, installedRef);
            if (!isInstalledWallpaperRef(normalizedInstalledRef)) {
                return false;
            }

            const removalResult = await removeInstalledWallpaperRecordLocally(normalizedInstalledRef, { sourceUrl });
            if (removalResult?.removed) {
                await finalizeNonUndoableInstalledWallpaperRemoval(removalResult.recordId || null);
            }

            const latestSelection = getWallpaperSelectionByTheme();
            const shouldClearSelection = (latestSelection?.[normalizedTheme] ?? null) === normalizedInstalledRef;
            if (shouldClearSelection) {
                const nextSelection = {
                    dark: latestSelection.dark ?? null,
                    light: latestSelection.light ?? null,
                    [normalizedTheme]: null
                };
                await setWallpaperSelection(nextSelection, {
                    persist: true,
                    queueSync: false
                });
            } else {
                applyActiveThemeWallpaper();
                renderWallpaperPopup({ preserveScroll: true });
            }

            const currentWallpaperUserId = getWallpaperAccountScopeUserId();
            if (currentWallpaperUserId) {
                try {
                    const accountStatePatch = await buildWallpaperAccountLocalStateStoragePatch();
                    if (accountStatePatch && typeof chrome !== 'undefined' && chrome.storage?.local) {
                        await commitWallpaperAccountStoragePayload(accountStatePatch);
                    }
                } catch (persistError) {
                    console.warn('Failed to refresh local wallpaper account state after orphan cleanup:', persistError);
                }
            }

            if (typeof recordWallpaperDiagnosticEvent === 'function') {
                recordWallpaperDiagnosticEvent('wallpaper-orphan-cleaned', {
                    theme: normalizedTheme,
                    installedRef: normalizedInstalledRef,
                    sourceUrl,
                    status: error?.status || error?.statusCode || null,
                    error: error?.message || String(error ?? '')
                });
            }

            showGlassToast(
                'This wallpaper was removed from LumiLinks and has been deleted from your account.',
                'warning',
                4600
            );
            return true;
        }

        async function hydrateSelectedWallpaperForTheme(theme, {
            showOverlay = false,
            selectionGuard = null
        } = {}) {
            const normalizedTheme = normalizeThemeMode(theme);
            const currentSelection = normalizeWallpaperPathForTheme(
                normalizedTheme,
                getWallpaperSelectionByTheme()?.[normalizedTheme]
            );
            const activeSelectionGuard = selectionGuard || createWallpaperSelectionGuard(normalizedTheme, currentSelection);
            if (!isInstalledWallpaperRef(currentSelection)) {
                return currentSelection;
            }

            const selectedRecord = getInstalledWallpaperRecordByRef(currentSelection);
            const alreadyCached = Boolean(getCachedWallpaperBinaryDataUrl(normalizedTheme, currentSelection));
            if (
                !selectedRecord?.sourceUrl
                || selectedRecord?.imageBlob instanceof Blob
                || alreadyCached
            ) {
                return currentSelection;
            }

            if (showOverlay) {
                pushWallpaperDownloadOverlayVisible();
            }

            try {
                const installResult = await installRemoteWallpaperLocally({
                    theme: normalizedTheme,
                    sourceUrl: selectedRecord.sourceUrl,
                    remoteId: selectedRecord.remoteId,
                    label: selectedRecord.label,
                    style: selectedRecord.style,
                    thumbnailUrl: selectedRecord.thumbnailUrl,
                    version: selectedRecord.version,
                    installContext: 'cloud-hydration'
                });

                if (!isWallpaperSelectionGuardCurrent(activeSelectionGuard)) {
                    return currentSelection;
                }

                if (installResult?.installedRef && installResult.installedRef !== currentSelection) {
                    const latestSelection = getWallpaperSelectionByTheme();
                    await setWallpaperSelection({
                        dark: latestSelection.dark ?? null,
                        light: latestSelection.light ?? null,
                        [normalizedTheme]: installResult.installedRef
                    }, {
                        persist: true,
                        queueSync: false
                    });
                    return installResult.installedRef;
                }

                await ensureInstalledWallpaperBinaryCache(normalizedTheme, currentSelection);
                reapplyActiveWallpaperIfGuardCurrent(activeSelectionGuard, {
                    preserveScroll: true
                });
                return currentSelection;
            } catch (error) {
                if (isWallpaperRemoteAssetMissingError(error)) {
                    try {
                        const didCleanUp = await cleanupUnavailableInstalledWallpaper(
                            normalizedTheme,
                            currentSelection,
                            {
                                sourceUrl: selectedRecord?.sourceUrl || null,
                                error
                            }
                        );
                        if (didCleanUp) {
                            return normalizeWallpaperPathForTheme(
                                normalizedTheme,
                                getWallpaperSelectionByTheme()?.[normalizedTheme]
                            );
                        }
                    } catch (cleanupError) {
                        console.warn('Failed to clean up removed wallpaper after hydrate failure:', cleanupError);
                    }
                }

                console.warn('Failed to hydrate selected wallpaper locally:', error);
                if (showOverlay) {
                    showGlassToast('Wallpaper download failed. Please try again.', 'warning');
                }
                return currentSelection;
            } finally {
                if (showOverlay) {
                    popWallpaperDownloadOverlayVisible();
                }
            }
        }

        async function applyCloudWallpaperPreferences(cloudState) {
            const resolvedThemeMode = (cloudState?.themeMode === 'dark' || cloudState?.themeMode === 'light')
                ? cloudState.themeMode
                : getThemeMode();
            const hasConfiguredPreferences = cloudState?.hasConfiguredPreferences === true;

            if (!hasConfiguredPreferences) {
                return;
            }

            const rawSelection = cloudState?.selectionByTheme && typeof cloudState.selectionByTheme === 'object'
                ? cloudState.selectionByTheme
                : {};
            const rawSelectionPresence = cloudState?.selectionPresenceByTheme && typeof cloudState.selectionPresenceByTheme === 'object'
                ? cloudState.selectionPresenceByTheme
                : {};
            const currentSelection = getWallpaperSelectionByTheme();
            const nextSelection = {
                dark: rawSelectionPresence.dark === true
                    ? (typeof rawSelection.dark === 'string' && rawSelection.dark.trim()
                        ? rawSelection.dark.trim()
                        : null)
                    : (currentSelection.dark ?? null),
                light: rawSelectionPresence.light === true
                    ? (typeof rawSelection.light === 'string' && rawSelection.light.trim()
                        ? rawSelection.light.trim()
                        : null)
                    : (currentSelection.light ?? null)
            };

            ['dark', 'light'].forEach((theme) => {
                const normalizedSelection = normalizeWallpaperPathForTheme(theme, nextSelection[theme]);
                if (isHostedWallpaperUrl(normalizedSelection)) {
                    const installedRef = findInstalledWallpaperRefBySourceUrl(theme, normalizedSelection);
                    if (installedRef) {
                        nextSelection[theme] = installedRef;
                    }
                }
            });

            await saveThemeModeToStorage(resolvedThemeMode, {
                queueSync: false,
                applyWallpaper: false,
                renderPopup: false,
                hydrateSelection: false
            });
            await setWallpaperSelection(nextSelection, {
                persist: true,
                queueSync: false
            });
            await hydrateSelectedWallpaperForTheme(normalizeThemeMode(resolvedThemeMode), {
                showOverlay: false,
                selectionGuard: createWallpaperSelectionGuard(
                    normalizeThemeMode(resolvedThemeMode),
                    getWallpaperSelectionByTheme()?.[normalizeThemeMode(resolvedThemeMode)]
                )
            });
        }

        function normalizeWallpaperUndoArchivedAt(value) {
            return (typeof value === 'string' && value.trim()) ? value.trim() : null;
        }

        function getWallpaperUndoHistoryLabel(action, label) {
            const normalizedAction = action === 'restore' ? 'restore' : 'archive';
            const normalizedLabel = (typeof label === 'string' && label.trim())
                ? label.trim()
                : 'Wallpaper';
            return normalizedAction === 'restore'
                ? `Restore wallpaper "${normalizedLabel}"`
                : `Archive wallpaper "${normalizedLabel}"`;
        }

        async function finalizeNonUndoableInstalledWallpaperRemoval(recordId, { blockUndo = false } = {}) {
            const deletedEntityKey = typeof buildUndoRedoEntityKey === 'function' && recordId
                ? buildUndoRedoEntityKey('installedWallpapers', recordId)
                : null;
            if (deletedEntityKey && typeof pruneUndoRedoHistoryForEntityKeys === 'function') {
                await pruneUndoRedoHistoryForEntityKeys([deletedEntityKey]);
            }
            if (typeof clearRedoTailAfterNonUndoableMutation === 'function') {
                await clearRedoTailAfterNonUndoableMutation();
            }
            if (blockUndo && typeof setUndoRedoBlockedReason === 'function') {
                setUndoRedoBlockedReason('You cannot undo this.');
            }
        }

        function createWallpaperArchiveUndoToastOptions(installedRef, archived) {
            const normalizedInstalledRef = typeof installedRef === 'string' ? installedRef.trim() : '';
            if (!normalizedInstalledRef) {
                return null;
            }

            const originatingUserId = typeof getWallpaperAccountScopeUserId === 'function'
                ? getWallpaperAccountScopeUserId()
                : null;

            return {
                actionLabel: 'Undo',
                onAction: async () => {
                    const currentWallpaperUserId = typeof getWallpaperAccountScopeUserId === 'function'
                        ? getWallpaperAccountScopeUserId()
                        : null;
                    if (
                        originatingUserId
                        && currentWallpaperUserId !== originatingUserId
                    ) {
                        showGlassToast('Undo is no longer available after an account change.', 'warning', 3200);
                        return;
                    }

                    const didUndoArchiveChange = await setInstalledWallpaperArchivedState(
                        normalizedInstalledRef,
                        !archived,
                        {
                            enforceAccountBoundary: true,
                            showToast: true
                        }
                    );

                    if (!didUndoArchiveChange) {
                        showGlassToast('Undo is no longer available.', 'info', 2800);
                    }
                }
            };
        }

        async function setInstalledWallpaperArchivedState(installedRef, archived, {
            enforceAccountBoundary = false,
            showToast = true,
            recordHistory = true
        } = {}) {
            const normalizedInstalledRef = typeof installedRef === 'string' ? installedRef.trim() : '';
            if (!isInstalledWallpaperRef(normalizedInstalledRef)) {
                return false;
            }
            if (
                enforceAccountBoundary
                && typeof canMutateAccountScopedPreferences === 'function'
                && !canMutateAccountScopedPreferences()
            ) {
                return false;
            }

            const existingRecord = getInstalledWallpaperRecordByRef(normalizedInstalledRef);
            if (!existingRecord || typeof setInstalledWallpaperArchiveStateLocally !== 'function') {
                return false;
            }

            const currentlyArchived = Boolean(existingRecord?.archivedAt);
            if (currentlyArchived === archived) {
                return true;
            }

            const updateResult = await setInstalledWallpaperArchiveStateLocally(normalizedInstalledRef, {
                archived
            });
            if (!updateResult?.updated) {
                return false;
            }

            if (recordHistory && typeof recordUndoRedoHistoryEntry === 'function' && updateResult?.recordId) {
                await recordUndoRedoHistoryEntry({
                    kind: archived ? 'wallpaper_archive' : 'wallpaper_restore',
                    label: getWallpaperUndoHistoryLabel(archived ? 'archive' : 'restore', existingRecord?.label),
                    ops: [{
                        table: 'installedWallpapers',
                        id: updateResult.recordId,
                        mode: 'patch',
                        before: {
                            archivedAt: normalizeWallpaperUndoArchivedAt(existingRecord?.archivedAt)
                        },
                        after: {
                            archivedAt: normalizeWallpaperUndoArchivedAt(updateResult.archivedAt)
                        }
                    }]
                });
            }

            if (archived) {
                wallpaperSectionDisclosureState.archived = true;
            }

            applyActiveThemeWallpaper();
            renderWallpaperPopup({ preserveScroll: true });

            if (showToast) {
                showGlassToast(
                    archived
                        ? 'Wallpaper archived. Restore it anytime from Archived.'
                        : 'Wallpaper restored.',
                    'success',
                    5200,
                    createWallpaperArchiveUndoToastOptions(normalizedInstalledRef, archived)
                );
            }
            return true;
        }

        function getInstalledWallpaperRefTheme(installedRef) {
            const normalizedInstalledRef = typeof installedRef === 'string' ? installedRef.trim() : '';
            if (normalizeWallpaperPathForTheme('dark', normalizedInstalledRef)) {
                return 'dark';
            }
            if (normalizeWallpaperPathForTheme('light', normalizedInstalledRef)) {
                return 'light';
            }
            return null;
        }

        async function deleteInstalledWallpaper(installedRef, {
            enforceAccountBoundary = false,
            showToast = true
        } = {}) {
            const normalizedInstalledRef = typeof installedRef === 'string' ? installedRef.trim() : '';
            if (!isInstalledWallpaperRef(normalizedInstalledRef)) {
                return false;
            }
            if (
                enforceAccountBoundary
                && typeof canMutateAccountScopedPreferences === 'function'
                && !canMutateAccountScopedPreferences()
            ) {
                return false;
            }

            const existingRecord = getInstalledWallpaperRecordByRef(normalizedInstalledRef);
            if (!existingRecord) {
                return false;
            }
            const isDeletedLocalUserWallpaper = (
                (typeof isLocalOnlyInstalledWallpaperRef === 'function' && isLocalOnlyInstalledWallpaperRef(normalizedInstalledRef))
                || (
                    typeof existingRecord?.sourceType === 'string'
                    && existingRecord.sourceType.trim() === (localUserWallpaperSourceType || 'user-upload')
                )
            );

            const wallpaperTheme = getInstalledWallpaperRefTheme(normalizedInstalledRef);
            const removalResult = await removeInstalledWallpaperRecordLocally(normalizedInstalledRef, {
                sourceUrl: existingRecord?.sourceUrl || null
            });
            if (!removalResult?.removed) {
                return false;
            }

            const latestSelection = getWallpaperSelectionByTheme();
            const shouldClearSelection = wallpaperTheme
                ? (latestSelection?.[wallpaperTheme] ?? null) === normalizedInstalledRef
                : false;
            if (shouldClearSelection) {
                let replacementSelection = null;
                if (wallpaperTheme && isDeletedLocalUserWallpaper) {
                    const sharedSelection = await readSharedWallpaperSelectionFromStorage();
                    replacementSelection = normalizeWallpaperPathForTheme(
                        wallpaperTheme,
                        sharedSelection?.[wallpaperTheme]
                    );
                    if (
                        replacementSelection
                        && typeof isLocalOnlyInstalledWallpaperRef === 'function'
                        && isLocalOnlyInstalledWallpaperRef(replacementSelection)
                    ) {
                        replacementSelection = null;
                    }
                }
                await setWallpaperSelection({
                    dark: latestSelection.dark ?? null,
                    light: latestSelection.light ?? null,
                    [wallpaperTheme]: replacementSelection
                }, {
                    persist: true,
                    queueSync: false
                });
            } else {
                applyActiveThemeWallpaper();
                renderWallpaperPopup({ preserveScroll: true });
            }

            await finalizeNonUndoableInstalledWallpaperRemoval(removalResult?.recordId || null, {
                blockUndo: true
            });

            if (showToast) {
                showGlassToast('Wallpaper deleted.', 'success', 3200);
            }
            return true;
        }

        function createWallpaperActionIcon(action) {
            const namespace = 'http://www.w3.org/2000/svg';
            const svg = document.createElementNS(namespace, 'svg');
            svg.setAttribute('viewBox', '0 0 24 24');
            svg.setAttribute('width', '16');
            svg.setAttribute('height', '16');
            svg.setAttribute('aria-hidden', 'true');
            svg.setAttribute('focusable', 'false');
            svg.classList.add('wallpaper-tile-action-icon');

            const make = (tag, attrs = {}) => {
                const node = document.createElementNS(namespace, tag);
                Object.entries(attrs).forEach(([key, value]) => {
                    node.setAttribute(key, value);
                });
                return node;
            };

            svg.appendChild(make('path', {
                d: 'M0 0h24v24H0z',
                fill: 'none',
                stroke: 'none'
            }));

            if (action === 'download') {
                svg.appendChild(make('path', {
                    d: 'M12 4v10',
                    fill: 'none',
                    stroke: 'currentColor',
                    'stroke-width': '2',
                    'stroke-linecap': 'round'
                }));
                svg.appendChild(make('path', {
                    d: 'M8.5 10.5L12 14l3.5-3.5',
                    fill: 'none',
                    stroke: 'currentColor',
                    'stroke-width': '2',
                    'stroke-linecap': 'round',
                    'stroke-linejoin': 'round'
                }));
                svg.appendChild(make('path', {
                    d: 'M5 19h14',
                    fill: 'none',
                    stroke: 'currentColor',
                    'stroke-width': '2',
                    'stroke-linecap': 'round'
                }));
                return svg;
            }

            if (action === 'delete') {
                svg.appendChild(make('path', {
                    d: 'M4 7h16',
                    fill: 'none',
                    stroke: 'currentColor',
                    'stroke-width': '2',
                    'stroke-linecap': 'round'
                }));
                svg.appendChild(make('path', {
                    d: 'M10 11v6',
                    fill: 'none',
                    stroke: 'currentColor',
                    'stroke-width': '2',
                    'stroke-linecap': 'round'
                }));
                svg.appendChild(make('path', {
                    d: 'M14 11v6',
                    fill: 'none',
                    stroke: 'currentColor',
                    'stroke-width': '2',
                    'stroke-linecap': 'round'
                }));
                svg.appendChild(make('path', {
                    d: 'M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12',
                    fill: 'none',
                    stroke: 'currentColor',
                    'stroke-width': '2',
                    'stroke-linecap': 'round',
                    'stroke-linejoin': 'round'
                }));
                svg.appendChild(make('path', {
                    d: 'M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2',
                    fill: 'none',
                    stroke: 'currentColor',
                    'stroke-width': '2',
                    'stroke-linecap': 'round',
                    'stroke-linejoin': 'round'
                }));
                return svg;
            }

            if (action === 'edit') {
                svg.setAttribute('viewBox', '0 0 800 800');
                svg.appendChild(make('path', {
                    d: 'M714.538,78.452c-24.259,-23.235 -50.988,-35.008 -79.542,-35.008c-44.645,0 -77.227,28.843 -86.129,37.679c-12.552,12.419 -440.35,440.395 -440.35,440.395c-2.804,2.804 -4.829,6.321 -5.875,10.149c-9.637,35.654 -57.976,193.847 -58.466,195.449c-2.493,8.101 -0.267,16.937 5.697,22.901c4.295,4.273 10.015,6.565 15.868,6.565c2.315,0 4.629,-0.356 6.899,-1.091c1.625,-0.534 164.914,-53.302 191.799,-61.337c3.539,-1.068 6.788,-2.982 9.414,-5.586c16.981,-16.781 415.98,-411.351 442.465,-438.703c27.397,-28.22 41.017,-57.642 40.483,-87.353c-0.556,-29.355 -14.778,-57.62 -42.308,-84.037l0.045,-0.022Zm-172.771,73.844c11.328,2.737 38.079,11.729 65.387,39.281c27.597,27.842 35.053,59.667 36.455,66.923c-87.509,87.064 -288.945,286.363 -368.353,364.904c-7.322,-17.07 -19.184,-37.657 -38.257,-56.863c-23.279,-23.457 -46.982,-36.7 -65.254,-44.155c78.585,-78.607 283.826,-283.915 370,-370.067l0.022,-0.022Zm-400.223,407.635c12.241,3.249 37.634,12.686 63.518,38.769c19.941,20.119 29.355,42.286 33.584,55.817c-30.935,9.948 -98.682,33.317 -141.702,47.204c12.752,-41.974 34.296,-107.317 44.6,-141.791Zm542.504,-341.891c-0.912,0.935 -2.426,2.448 -4.229,4.273c-7.033,-18.116 -19.362,-41.396 -40.75,-62.939c-21.833,-22.011 -43.977,-34.986 -61.715,-42.664c1.513,-1.491 2.671,-2.671 3.138,-3.116c2.537,-2.515 25.661,-24.615 54.46,-24.615c16.58,0 32.872,7.567 48.406,22.478c18.428,17.693 27.953,35.142 28.265,51.878c0.312,17.092 -8.991,35.498 -27.597,54.704l0.022,0Z',
                    fill: 'currentColor'
                }));
                return svg;
            }

            if (action === 'restore') {
                svg.appendChild(make('path', {
                    d: 'M21 8v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8',
                    fill: 'none',
                    stroke: 'currentColor',
                    'stroke-width': '2',
                    'stroke-linecap': 'round',
                    'stroke-linejoin': 'round'
                }));
                svg.appendChild(make('path', {
                    d: 'M3 8l2-3h14l2 3',
                    fill: 'none',
                    stroke: 'currentColor',
                    'stroke-width': '2',
                    'stroke-linecap': 'round',
                    'stroke-linejoin': 'round'
                }));
                svg.appendChild(make('path', {
                    d: 'M12 16V10',
                    fill: 'none',
                    stroke: 'currentColor',
                    'stroke-width': '2',
                    'stroke-linecap': 'round'
                }));
                svg.appendChild(make('path', {
                    d: 'M9.5 12.5L12 10l2.5 2.5',
                    fill: 'none',
                    stroke: 'currentColor',
                    'stroke-width': '2',
                    'stroke-linecap': 'round',
                    'stroke-linejoin': 'round'
                }));
                return svg;
            }

            svg.appendChild(make('path', {
                d: 'M21 8v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8',
                fill: 'none',
                stroke: 'currentColor',
                'stroke-width': '2',
                'stroke-linecap': 'round',
                'stroke-linejoin': 'round'
            }));
            svg.appendChild(make('path', {
                d: 'M3 8l2-3h14l2 3',
                fill: 'none',
                stroke: 'currentColor',
                'stroke-width': '2',
                'stroke-linecap': 'round',
                'stroke-linejoin': 'round'
            }));
            svg.appendChild(make('path', {
                d: 'M12 10v6',
                fill: 'none',
                stroke: 'currentColor',
                'stroke-width': '2',
                'stroke-linecap': 'round'
            }));
            svg.appendChild(make('path', {
                d: 'M9.5 13.5L12 16l2.5-2.5',
                fill: 'none',
                stroke: 'currentColor',
                'stroke-width': '2',
                'stroke-linecap': 'round',
                'stroke-linejoin': 'round'
            }));
            return svg;
        }

        function createWallpaperContextMenuItemElement({
            action,
            label,
            icon = action,
            danger = false
        }) {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = `tab-menu-item${danger ? ' danger' : ''}`;
            item.dataset.action = action;
            item.setAttribute('role', 'menuitem');

            const iconWrap = document.createElement('span');
            iconWrap.className = 'tab-menu-icon';
            iconWrap.appendChild(createWallpaperActionIcon(icon));

            const text = document.createElement('span');
            text.textContent = label;

            item.append(iconWrap, text);
            return item;
        }

        function getWallpaperContextMenuElement() {
            const menu = document.getElementById('wallpaperContextMenu');
            return menu && typeof menu === 'object' ? menu : null;
        }

        function closeWallpaperContextMenu() {
            const menu = getWallpaperContextMenuElement();
            wallpaperContextMenuState = null;
            if (!menu) {
                return;
            }

            menu.classList.remove('active');
            menu.setAttribute('aria-hidden', 'true');
            menu.replaceChildren();
        }

        function getWallpaperDownloadExtensionFromMimeType(mimeType) {
            const normalizedMimeType = typeof mimeType === 'string'
                ? mimeType.trim().toLowerCase()
                : '';
            switch (normalizedMimeType) {
                case 'image/jpeg':
                case 'image/jpg':
                    return 'jpg';
                case 'image/png':
                    return 'png';
                case 'image/webp':
                    return 'webp';
                case 'image/avif':
                    return 'avif';
                case 'image/gif':
                    return 'gif';
                case 'image/svg+xml':
                    return 'svg';
                default:
                    return '';
            }
        }

        function inferWallpaperDownloadExtension(sourceUrl, mimeType) {
            const extensionFromMimeType = getWallpaperDownloadExtensionFromMimeType(mimeType);
            if (extensionFromMimeType) {
                return extensionFromMimeType;
            }

            const sourceHint = typeof sourceUrl === 'string' ? sourceUrl.trim() : '';
            if (sourceHint) {
                try {
                    const resolvedUrl = new URL(sourceHint, window.location.href);
                    const pathname = typeof resolvedUrl.pathname === 'string'
                        ? resolvedUrl.pathname
                        : '';
                    const extensionMatch = pathname.match(/\.([a-z0-9]{2,5})$/i);
                    if (extensionMatch?.[1]) {
                        const normalizedExtension = extensionMatch[1].toLowerCase();
                        return normalizedExtension === 'jpeg' ? 'jpg' : normalizedExtension;
                    }
                } catch (_error) {
                    const extensionMatch = sourceHint.match(/\.([a-z0-9]{2,5})(?:[?#].*)?$/i);
                    if (extensionMatch?.[1]) {
                        const normalizedExtension = extensionMatch[1].toLowerCase();
                        return normalizedExtension === 'jpeg' ? 'jpg' : normalizedExtension;
                    }
                }
            }

            return 'jpg';
        }

        function sanitizeWallpaperDownloadLabel(label) {
            const normalizedLabel = typeof label === 'string' && label.trim()
                ? label.trim()
                : 'wallpaper';
            return normalizedLabel
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '')
                || 'wallpaper';
        }

        function buildWallpaperDownloadFilename(label, theme, extension) {
            const normalizedTheme = normalizeThemeMode(theme);
            const normalizedExtension = typeof extension === 'string' && extension.trim()
                ? extension.trim().toLowerCase()
                : 'jpg';
            const safeLabel = sanitizeWallpaperDownloadLabel(label);
            return `lumilist-${normalizedTheme}-${safeLabel}.${normalizedExtension}`;
        }

        function triggerWallpaperBlobDownload(blob, filename) {
            if (!(blob instanceof Blob) || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
                throw new Error('Wallpaper download is unavailable in this browser.');
            }

            const objectUrl = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = objectUrl;
            anchor.download = filename;
            anchor.rel = 'noopener';
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();

            window.setTimeout(() => {
                if (typeof URL.revokeObjectURL === 'function') {
                    URL.revokeObjectURL(objectUrl);
                }
            }, 0);
        }

        async function resolveWallpaperDownloadPayload({
            theme,
            file,
            label
        }) {
            const normalizedTheme = normalizeThemeMode(theme);
            const normalizedFile = normalizeWallpaperPathForTheme(normalizedTheme, file);
            if (!normalizedFile) {
                throw new Error('Wallpaper source is unavailable.');
            }

            const installedRecord = isInstalledWallpaperRef(normalizedFile)
                ? getInstalledWallpaperRecordByRef(normalizedFile)
                : null;
            if (installedRecord?.imageBlob instanceof Blob) {
                return {
                    blob: installedRecord.imageBlob,
                    filename: buildWallpaperDownloadFilename(
                        label || installedRecord.label || formatWallpaperLabelFromFile(normalizedFile),
                        normalizedTheme,
                        inferWallpaperDownloadExtension(
                            installedRecord?.sourceUrl || normalizedFile,
                            installedRecord.imageBlob.type
                        )
                    )
                };
            }

            const renderSource = resolveWallpaperRenderSource(normalizedTheme, normalizedFile) || normalizedFile;
            const response = await fetch(renderSource);
            if (!response.ok) {
                throw new Error(`Wallpaper download failed with status ${response.status}.`);
            }

            const blob = await response.blob();
            if (!(blob instanceof Blob) || blob.size <= 0) {
                throw new Error('Wallpaper download returned no data.');
            }

            return {
                blob,
                filename: buildWallpaperDownloadFilename(
                    label || formatWallpaperLabelFromFile(normalizedFile),
                    normalizedTheme,
                    inferWallpaperDownloadExtension(renderSource, blob.type)
                )
            };
        }

        async function downloadWallpaperToDevice(context) {
            if (!context || typeof context !== 'object') {
                return false;
            }

            try {
                const downloadPayload = await resolveWallpaperDownloadPayload(context);
                triggerWallpaperBlobDownload(downloadPayload.blob, downloadPayload.filename);
                showGlassToast('Wallpaper downloaded.', 'success', 3200);
                return true;
            } catch (error) {
                console.warn('Failed to download wallpaper:', error);
                showGlassToast('Wallpaper download failed. Please try again.', 'warning');
                return false;
            }
        }

        function appendWallpaperActionButton(container, {
            action,
            file,
            label
        }) {
            const actionButton = document.createElement('button');
            actionButton.type = 'button';
            actionButton.className = `wallpaper-tile-action wallpaper-tile-action-${action}`;
            actionButton.dataset.wallpaperAction = action;
            actionButton.dataset.wallpaperId = file;
            actionButton.setAttribute('aria-label', `${action} ${label || 'wallpaper'}`);
            actionButton.title = action;
            actionButton.appendChild(createWallpaperActionIcon(action));
            container.appendChild(actionButton);
        }

        function getWallpaperEntryArchiveState(filePath) {
            if (!isInstalledWallpaperRef(filePath)) {
                return {
                    isInstalled: false,
                    isArchived: false,
                    archivedAt: null
                };
            }

            const installedRecord = getInstalledWallpaperRecordByRef(filePath);
            const archivedAt = typeof installedRecord?.archivedAt === 'string' && installedRecord.archivedAt.trim()
                ? installedRecord.archivedAt.trim()
                : null;
            return {
                isInstalled: true,
                isArchived: archivedAt !== null,
                archivedAt
            };
        }

        function normalizeWallpaperEntryForDisplay(theme, rawEntry) {
            if (!rawEntry || typeof rawEntry !== 'object') return null;

            const normalizedFile = normalizeWallpaperPathForTheme(theme, rawEntry.file);
            if (!normalizedFile) return null;

            const installedRecord = isInstalledWallpaperRef(normalizedFile)
                ? getInstalledWallpaperRecordByRef(normalizedFile)
                : null;
            const archiveState = getWallpaperEntryArchiveState(normalizedFile);
            const rawArchivedAt = typeof rawEntry.archivedAt === 'string' && rawEntry.archivedAt.trim()
                ? rawEntry.archivedAt.trim()
                : null;
            const isUserUpload = isUserUploadWallpaperSourceType(
                installedRecord?.sourceType || rawEntry.sourceType
            );
            return {
                ...rawEntry,
                file: normalizedFile,
                label: isUserUpload
                    ? USER_UPLOAD_WALLPAPER_GENERIC_LABEL
                    : (
                        typeof rawEntry.label === 'string' && rawEntry.label.trim()
                            ? rawEntry.label.trim()
                            : formatWallpaperLabelFromFile(rawEntry.file || normalizedFile)
                    ),
                hideTitle: isUserUpload,
                isInstalled: rawEntry.isInstalled === true || archiveState.isInstalled,
                isArchived: rawEntry.isArchived === true || archiveState.isArchived,
                archivedAt: rawArchivedAt || archiveState.archivedAt || null
            };
        }

        function createSyntheticWallpaperEntry(theme, filePath) {
            const normalizedFile = normalizeWallpaperPathForTheme(theme, filePath);
            if (!normalizedFile) return null;

            const installedRecord = isInstalledWallpaperRef(normalizedFile)
                ? getInstalledWallpaperRecordByRef(normalizedFile)
                : null;
            const archiveState = getWallpaperEntryArchiveState(normalizedFile);
            const isUserUpload = isUserUploadWallpaperSourceType(installedRecord?.sourceType);
            return {
                id: `saved:${normalizedFile}`,
                file: normalizedFile,
                label: isUserUpload
                    ? USER_UPLOAD_WALLPAPER_GENERIC_LABEL
                    : (
                        typeof installedRecord?.label === 'string' && installedRecord.label.trim()
                            ? installedRecord.label.trim()
                            : formatWallpaperLabelFromFile(normalizedFile)
                    ),
                style: installedRecord?.style || getResolvedWallpaperStyleForTheme(theme),
                sourceType: installedRecord?.sourceType || (archiveState.isInstalled ? 'remote-install' : 'saved'),
                isInstalled: archiveState.isInstalled,
                isArchived: archiveState.isArchived,
                archivedAt: archiveState.archivedAt,
                isSynthetic: true,
                hideTitle: isUserUpload
            };
        }

        function isUserUploadWallpaperEntry(entry) {
            return isUserUploadWallpaperSourceType(entry?.sourceType);
        }

        function buildWallpaperDisplayGroups(theme, selectedFile, themeEntries) {
            const userUploadEntries = [];
            const downloadedEntries = [];
            const starterEntries = [];
            const archivedEntries = [];
            let selectedPresent = false;

            for (const rawEntry of Array.isArray(themeEntries) ? themeEntries : []) {
                const entry = normalizeWallpaperEntryForDisplay(theme, rawEntry);
                if (!entry) continue;

                if (entry.file === selectedFile) {
                    selectedPresent = true;
                }

                if (entry.isInstalled) {
                    if (entry.isArchived) {
                        archivedEntries.push(entry);
                    } else if (isUserUploadWallpaperEntry(entry)) {
                        userUploadEntries.push(entry);
                    } else {
                        downloadedEntries.push(entry);
                    }
                } else {
                    starterEntries.push(entry);
                }
            }

            const selectedPreviewSource = selectedFile
                ? getWallpaperTilePreviewSource(theme, selectedFile)
                : null;
            if (
                selectedFile
                && !selectedPresent
                && (isHostedWallpaperUrl(selectedFile) || isInstalledWallpaperRef(selectedFile))
                && (selectedPreviewSource || hasCachedHostedWallpaperBinary(theme, selectedFile))
            ) {
                const syntheticEntry = createSyntheticWallpaperEntry(theme, selectedFile);
                if (syntheticEntry) {
                    if (syntheticEntry.isArchived) {
                        archivedEntries.unshift(syntheticEntry);
                    } else if (isUserUploadWallpaperEntry(syntheticEntry)) {
                        userUploadEntries.unshift(syntheticEntry);
                    } else {
                        downloadedEntries.unshift(syntheticEntry);
                    }
                }
            }

            return {
                userUploadEntries,
                downloadedEntries,
                starterEntries,
                archivedEntries
            };
        }

        function buildStarterWallpaperSectionEntries(starterEntries) {
            return [
                {
                    id: 'default',
                    file: null,
                    label: 'Default',
                    isDefault: true
                },
                ...(Array.isArray(starterEntries) ? starterEntries : [])
            ];
        }

        function createWallpaperTileElement({
            theme,
            file,
            label,
            hideTitle = false,
            isDefault = false,
            previewSource = null,
            isSelected = false,
            isInstalled = false,
            showEditAction = false,
            showArchiveAction = false,
            isArchived = false
        }) {
            const tile = document.createElement('div');
            tile.className = `wallpaper-tile${isDefault ? ' default' : ''}${isSelected ? ' selected' : ''}${isArchived ? ' archived' : ''}`;
            tile.dataset.wallpaperId = isDefault ? defaultWallpaperTileId : file;
            tile.dataset.wallpaperTheme = theme;
            if (!isDefault && label) {
                tile.dataset.wallpaperLabel = label;
            }
            if (isInstalled) {
                tile.dataset.wallpaperInstalled = 'true';
            }
            if (isArchived) {
                tile.dataset.wallpaperArchived = 'true';
            }

            const selectButton = document.createElement('button');
            selectButton.type = 'button';
            selectButton.className = 'wallpaper-tile-button';
            selectButton.setAttribute(
                'aria-label',
                isDefault
                    ? `Use default background for ${theme} theme`
                    : `Use ${label} wallpaper for ${theme} theme`
            );
            selectButton.setAttribute('aria-pressed', String(isSelected));
            if (!isDefault && label && !hideTitle) {
                selectButton.title = label;
            }

            const preview = document.createElement('div');
            preview.className = 'wallpaper-tile-preview';
            if (isDefault) {
                preview.textContent = 'Default';
            } else {
                const resolvedPreviewSource = previewSource || (isInstalledWallpaperRef(file) ? null : file);
                if (resolvedPreviewSource) {
                    preview.style.backgroundImage = toCssUrlValue(resolvedPreviewSource);
                }
            }

            selectButton.append(preview);
            if (!hideTitle || isDefault) {
                const tileLabel = document.createElement('div');
                tileLabel.className = 'wallpaper-tile-label';
                tileLabel.textContent = isDefault ? 'Default' : (label || 'Wallpaper');
                selectButton.append(tileLabel);
            }
            tile.append(selectButton);

            if (showArchiveAction) {
                const actions = document.createElement('div');
                actions.className = 'wallpaper-tile-actions';
                if (showEditAction) {
                    appendWallpaperActionButton(actions, {
                        action: 'edit',
                        file,
                        label
                    });
                }
                appendWallpaperActionButton(actions, {
                    action: isArchived ? 'restore' : 'archive',
                    file,
                    label
                });
                appendWallpaperActionButton(actions, {
                    action: 'delete',
                    file,
                    label
                });
                tile.append(actions);
            }

            return tile;
        }

        function createWallpaperSectionTitleElement(title, count, { collapsible = false } = {}) {
            const titleElement = document.createElement(collapsible ? 'summary' : 'div');
            titleElement.className = collapsible
                ? 'wallpaper-grid-section-summary'
                : 'wallpaper-grid-section-heading';

            const titleMain = document.createElement('span');
            titleMain.className = 'wallpaper-grid-section-heading-main';

            const titleText = document.createElement('span');
            titleText.className = 'wallpaper-grid-section-heading-text';
            titleText.textContent = title;

            const countBadge = document.createElement('span');
            countBadge.className = 'wallpaper-grid-section-count';
            countBadge.textContent = String(count);

            titleMain.append(titleText, countBadge);
            titleElement.append(titleMain);
            return titleElement;
        }

        function createWallpaperSectionElement({
            title,
            entries,
            theme,
            selectedFile,
            collapsible = false,
            open = true,
            stateKey = null
        }) {
            if (!Array.isArray(entries) || entries.length === 0) {
                return null;
            }

            const section = document.createElement(collapsible ? 'details' : 'section');
            section.className = `wallpaper-grid-section${collapsible ? ' wallpaper-grid-section-collapsible' : ''}`;
            if (collapsible) {
                section.open = open;
                if (stateKey) {
                    section.addEventListener('toggle', () => {
                        wallpaperSectionDisclosureState[stateKey] = section.open;
                    });
                }
            }

            section.append(
                createWallpaperSectionTitleElement(title, entries.length, {
                    collapsible
                })
            );

            const tiles = document.createElement('div');
            tiles.className = 'wallpaper-grid-section-tiles';

            for (const entry of entries) {
                tiles.appendChild(createWallpaperTileElement({
                    theme,
                    file: entry.file,
                    label: entry.label,
                    hideTitle: entry.hideTitle === true,
                    isDefault: entry.isDefault === true,
                    previewSource: entry.isDefault ? null : getWallpaperTilePreviewSource(theme, entry.file),
                    isSelected: entry.isDefault ? selectedFile === null : entry.file === selectedFile,
                    isInstalled: entry.isInstalled === true,
                    showEditAction: entry.isInstalled === true
                        && entry.isArchived !== true
                        && isUserUploadWallpaperEntry(entry),
                    showArchiveAction: entry.isInstalled === true,
                    isArchived: entry.isArchived === true
                }));
            }

            section.appendChild(tiles);
            return section;
        }

        function createWallpaperStyleColorControl({
            label,
            value,
            onInput
        }) {
            const control = document.createElement('label');
            control.className = 'wallpaper-style-color-control';

            const labelRow = document.createElement('div');
            labelRow.className = 'wallpaper-style-control-row';

            const labelText = document.createElement('span');
            labelText.className = 'wallpaper-style-control-label';
            labelText.textContent = label;

            const valueText = document.createElement('span');
            valueText.className = 'wallpaper-style-control-value';
            valueText.textContent = value;

            labelRow.append(labelText, valueText);

            const input = document.createElement('input');
            input.type = 'color';
            input.className = 'wallpaper-style-color-input';
            input.value = value;
            input.setAttribute('aria-label', label);
            input.addEventListener('input', () => {
                const nextValue = String(input.value || value).toUpperCase();
                valueText.textContent = nextValue;
                onInput(nextValue);
            });

            control.append(labelRow, input);
            return control;
        }

        function createWallpaperStyleRangeControl({
            label,
            value,
            min,
            max,
            step,
            formatter,
            onInput
        }) {
            const control = document.createElement('label');
            control.className = 'wallpaper-style-range-control';

            const labelRow = document.createElement('div');
            labelRow.className = 'wallpaper-style-control-row';

            const labelText = document.createElement('span');
            labelText.className = 'wallpaper-style-control-label';
            labelText.textContent = label;

            const valueText = document.createElement('span');
            valueText.className = 'wallpaper-style-control-value';
            valueText.textContent = formatter(value);

            labelRow.append(labelText, valueText);

            const input = document.createElement('input');
            input.type = 'range';
            input.className = 'wallpaper-style-range-input';
            input.min = String(min);
            input.max = String(max);
            input.step = String(step);
            input.value = String(value);
            input.setAttribute('aria-label', label);
            input.addEventListener('input', () => {
                const nextValue = Number(input.value);
                valueText.textContent = formatter(nextValue);
                onInput(nextValue);
            });

            control.append(labelRow, input);
            return control;
        }

        function renderWallpaperPopup({ preserveScroll = false } = {}) {
            const wallpaperGrid = document.getElementById('wallpaperGrid');
            if (!wallpaperGrid) return;
            closeWallpaperContextMenu();
            const previousScrollTop = preserveScroll ? wallpaperGrid.scrollTop : 0;

            const activeTheme = normalizeThemeMode(getThemeMode());
            const selectedFile = getWallpaperSelectionByTheme()[activeTheme] || null;
            const emptyState = document.getElementById('wallpaperEmptyState');
            const themeEntries = getWallpaperCatalogEntriesForTheme(activeTheme);
            const {
                userUploadEntries,
                downloadedEntries,
                starterEntries,
                archivedEntries
            } = buildWallpaperDisplayGroups(activeTheme, selectedFile, themeEntries);
            const starterSectionEntries = buildStarterWallpaperSectionEntries(starterEntries);
            const installedVisibleEntriesCount = userUploadEntries.length + downloadedEntries.length;

            updateThemeModeToggle();

            wallpaperGrid.replaceChildren();

            const userUploadSection = createWallpaperSectionElement({
                title: 'Your Wallpapers',
                entries: userUploadEntries,
                theme: activeTheme,
                selectedFile,
                collapsible: true,
                open: wallpaperSectionDisclosureState.uploads !== null
                    ? wallpaperSectionDisclosureState.uploads
                    : true,
                stateKey: 'uploads'
            });
            if (userUploadSection) {
                wallpaperGrid.appendChild(userUploadSection);
            }

            const downloadedSection = createWallpaperSectionElement({
                title: 'Downloaded Wallpapers',
                entries: downloadedEntries,
                theme: activeTheme,
                selectedFile,
                collapsible: true,
                open: wallpaperSectionDisclosureState.downloaded !== null
                    ? wallpaperSectionDisclosureState.downloaded
                    : true,
                stateKey: 'downloaded'
            });
            if (downloadedSection) {
                wallpaperGrid.appendChild(downloadedSection);
            }

            const shouldCollapseStarterByDefault = installedVisibleEntriesCount > 0;
            const starterSection = createWallpaperSectionElement({
                title: 'Starter Wallpapers',
                entries: starterSectionEntries,
                theme: activeTheme,
                selectedFile,
                collapsible: shouldCollapseStarterByDefault,
                open: wallpaperSectionDisclosureState.starter !== null
                    ? wallpaperSectionDisclosureState.starter
                    : true,
                stateKey: 'starter'
            });
            if (starterSection) {
                wallpaperGrid.appendChild(starterSection);
            }

            const archivedSection = createWallpaperSectionElement({
                title: 'Archived',
                entries: archivedEntries,
                theme: activeTheme,
                selectedFile,
                collapsible: true,
                open: wallpaperSectionDisclosureState.archived !== null
                    ? wallpaperSectionDisclosureState.archived
                    : archivedEntries.some((entry) => entry.file === selectedFile),
                stateKey: 'archived'
            });
            if (archivedSection) {
                wallpaperGrid.appendChild(archivedSection);
            }

            if (emptyState) {
                const noThemeWallpapers = installedVisibleEntriesCount === 0 && starterEntries.length === 0 && archivedEntries.length === 0;
                emptyState.classList.toggle('hidden', !noThemeWallpapers);
                if (noThemeWallpapers) {
                    emptyState.textContent = `No wallpapers available in wallpaper/${activeTheme}/. Add files and run npm run wallpapers:sync.`;
                }
            }

            if (preserveScroll) {
                const restoreScrollPosition = () => {
                    const maxScrollTop = Math.max(0, wallpaperGrid.scrollHeight - wallpaperGrid.clientHeight);
                    wallpaperGrid.scrollTop = Math.min(previousScrollTop, maxScrollTop);
                };
                restoreScrollPosition();
                if (typeof requestAnimationFrame === 'function') {
                    requestAnimationFrame(() => {
                        restoreScrollPosition();
                    });
                }
            }
        }

        function applyActiveThemeWallpaper(options = {}) {
            const allowLoggedOut = true; // options?.allowLoggedOut === true;
            const shouldCacheStyleLocally = options?.cacheStyleLocally !== false;
            const shouldPreferEditorDraft = options?.preferEditorDraft !== false;
            const body = document.body;
            const isAuthenticatedWorkspace = true; // body && !body.classList.contains('not-authenticated');
            if (!isAuthenticatedWorkspace && !allowLoggedOut) {
                return;
            }

            const currentThemeMode = getThemeMode();
            const wallpaperFile = getWallpaperSelectionByTheme()[currentThemeMode] || null;
            const wallpaperRenderSource = resolveWallpaperRenderSource(currentThemeMode, wallpaperFile);
            if (wallpaperFile && !wallpaperRenderSource) {
                const rootStyle = document.documentElement?.style || null;
                const existingWallpaperCss = (
                    typeof rootStyle?.getPropertyValue === 'function'
                        ? rootStyle.getPropertyValue('--ll-app-wallpaper-url')
                        : rootStyle?.['--ll-app-wallpaper-url']
                )?.trim() || '';
                if (existingWallpaperCss && existingWallpaperCss !== 'none') {
                    // Keep the bootstrap-painted wallpaper/theme until runtime hydration
                    // resolves a concrete binary/object URL for the current selection.
                    return;
                }
            }

            const resolvedStyle = getResolvedWallpaperStyleForTheme(currentThemeMode, {
                allowWallpaper: true
            });
            const editorDraftStyle = shouldPreferEditorDraft
                && wallpaperStyleEditorState
                && normalizeThemeMode(wallpaperStyleEditorState.theme) === currentThemeMode
                && (
                    !wallpaperStyleEditorState.wallpaperId
                    || !wallpaperFile
                    || wallpaperStyleEditorState.wallpaperId === wallpaperFile
                )
                ? wallpaperStyleEditorState.draftStyle
                : null;
            applyThemeStyleTokens(editorDraftStyle || resolvedStyle);
            document.documentElement.style.setProperty('--ll-app-wallpaper-url', toCssUrlValue(wallpaperRenderSource));
            if (shouldCacheStyleLocally) {
                cacheWallpaperStyleLocally();
            }
        }

        function applyLoggedOutDefaultThemeUi() {
            const configuredDefault = buildConfiguredNewUserWallpaperDefaultSeed();
            const resolvedThemeMode = configuredDefault.themeMode === 'light' ? 'light' : 'dark';
            closeWallpaperStyleEditor({
                restoreOriginalState: false,
                restoreFocus: false
            });
            setCurrentWallpaperStyleOverridesByTheme(
                typeof createEmptyWallpaperStyleOverrideState === 'function'
                    ? createEmptyWallpaperStyleOverrideState()
                    : { dark: null, light: null }
            );
            setThemeMode(resolvedThemeMode);
            setWallpaperSelectionByTheme({
                dark: configuredDefault.selectionByTheme.dark ?? null,
                light: configuredDefault.selectionByTheme.light ?? null
            });
            document.documentElement.setAttribute('data-theme', resolvedThemeMode);
            applyActiveThemeWallpaper({
                allowLoggedOut: true,
                cacheStyleLocally: false
            });
            updateThemeModeToggle();
            renderWallpaperPopup();
        }

        function clearLocalThemeWallpaperCaches() {
            if (typeof window !== 'undefined' && typeof window.__lumilistClearFontColorPreferenceState === 'function') {
                try {
                    window.__lumilistClearFontColorPreferenceState();
                } catch (_error) {
                    // Ignore runtime cleanup failures.
                }
            }
            const keys = [
                'lumilist_theme_mode',
                'lumilist_font_color',
                wallpaperLocalCacheKey,
                wallpaperStyleLocalCacheKey,
                wallpaperBinaryCacheLocalKey,
                `${wallpaperBootStyleCachePrefix}dark`,
                `${wallpaperBootStyleCachePrefix}light`,
                `${wallpaperBootSourceCachePrefix}dark`,
                `${wallpaperBootSourceCachePrefix}light`,
                `${wallpaperBootBinaryCachePrefix}dark`,
                `${wallpaperBootBinaryCachePrefix}light`
            ];
            for (const key of keys) {
                try {
                    localStorage.removeItem(key);
                } catch (_error) {
                    // Non-blocking cleanup.
                }
            }
        }

        async function clearPersistedThemeWallpaperState() {
            clearLocalThemeWallpaperCaches();
            if (typeof chrome !== 'undefined' && chrome.storage?.local) {
                try {
                    await chrome.storage.local.remove([
                        'themeMode',
                        'fontColor',
                        wallpaperStorageKey,
                        wallpaperCloudSyncStateStorageKey
                    ]);
                } catch (error) {
                    console.error('Failed to clear persisted theme/wallpaper state:', error);
                }
            }
        }

        async function resetThemeForLoggedOutState() {
            applyLoggedOutDefaultThemeUi();
            await clearPersistedThemeWallpaperState();
        }

        async function saveWallpaperSelectionToStorage(selection) {
            if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
            const writeRequestId = ++wallpaperSelectionStorageWriteRequestId;
            const previousSharedSelection = await readSharedWallpaperSelectionFromStorage();
            if (writeRequestId !== wallpaperSelectionStorageWriteRequestId) {
                return false;
            }
            const syncSafeSelection = typeof buildSyncSafeWallpaperSelection === 'function'
                ? buildSyncSafeWallpaperSelection(selection, previousSharedSelection)
                : selection;
            const storagePayload = {
                [wallpaperStorageKey]: syncSafeSelection
            };
            try {
                const accountStatePatch = await buildWallpaperAccountLocalStateStoragePatch({
                    selection,
                    themeMode: getThemeMode()
                });
                if (accountStatePatch) {
                    Object.assign(storagePayload, accountStatePatch);
                }
            } catch (error) {
                console.warn('Failed to merge local wallpaper account state before saving selection:', error);
            }
            return await commitWallpaperAccountStoragePayload(storagePayload, {
                requestId: writeRequestId
            });
        }

        async function handleWallpaperUploadButtonClick(uploadInput) {
            closeWallpaperContextMenu();

            if (
                typeof canMutateAccountScopedPreferences === 'function'
                && !canMutateAccountScopedPreferences()
            ) {
                return false;
            }

            if (!uploadInput || typeof uploadInput.click !== 'function') {
                return false;
            }

            if (uploadInput && 'value' in uploadInput) {
                uploadInput.value = '';
            }
            uploadInput.click();
            return true;
        }

        async function handleWallpaperUploadInputChange(event) {
            const uploadInput = event?.target;
            const selectedFile = uploadInput?.files?.[0] || null;
            if (!selectedFile) {
                if (uploadInput && 'value' in uploadInput) {
                    uploadInput.value = '';
                }
                return false;
            }

            if (
                typeof canMutateAccountScopedPreferences === 'function'
                && !canMutateAccountScopedPreferences()
            ) {
                if (uploadInput && 'value' in uploadInput) {
                    uploadInput.value = '';
                }
                return false;
            }

            if (typeof selectedFile?.type === 'string' && selectedFile.type && !selectedFile.type.startsWith('image/')) {
                showGlassToast('Please choose an image file to upload.', 'warning', 3200);
                if (uploadInput && 'value' in uploadInput) {
                    uploadInput.value = '';
                }
                return false;
            }

            let installedRef = null;

            try {
                const jpegDataUrl = await convertWallpaperUploadFileToJpegDataUrl(selectedFile);
                const activeTheme = normalizeThemeMode(getThemeMode());
                const [imageBlob, initialDraftStyle] = await Promise.all([
                    dataUrlToBlob(jpegDataUrl),
                    buildUserUploadWallpaperAutoStyleFromDataUrl(jpegDataUrl, activeTheme).catch((error) => {
                        console.warn('Failed to auto-generate uploaded wallpaper style:', error);
                        return null;
                    })
                ]);
                const installResult = await installWallpaperBlobLocally({
                    theme: activeTheme,
                    imageBlob,
                    label: USER_UPLOAD_WALLPAPER_GENERIC_LABEL,
                    style: buildUserUploadWallpaperBaseStyle(activeTheme),
                    sourceType: localUserWallpaperSourceType || 'user-upload'
                });

                installedRef = installResult?.installedRef || null;
                if (!installedRef) {
                    throw new Error('Failed to save the uploaded wallpaper.');
                }

                wallpaperSectionDisclosureState.uploads = true;
                const currentSelection = getWallpaperSelectionByTheme();
                const didApplySelection = await setWallpaperSelection({
                    dark: currentSelection.dark ?? null,
                    light: currentSelection.light ?? null,
                    [activeTheme]: installedRef
                }, {
                    persist: true,
                    enforceAccountBoundary: true
                });

                if (didApplySelection === false) {
                    await deleteInstalledWallpaper(installedRef, {
                        enforceAccountBoundary: false,
                        showToast: false
                    });
                    return false;
                }

                const selectionGuard = createWallpaperSelectionGuard(activeTheme, installedRef);
                await ensureInstalledWallpaperBinaryCache(activeTheme, installedRef);
                reapplyActiveWallpaperIfGuardCurrent(selectionGuard, {
                    preserveScroll: true
                });
                maybeOpenWallpaperStyleEditorAfterSelection(activeTheme, installedRef, {
                    wallpaperLabel: installResult?.label || USER_UPLOAD_WALLPAPER_GENERIC_LABEL,
                    initialDraftStyle
                });
                showGlassToast(
                    `Wallpaper uploaded for ${activeTheme === 'light' ? 'Light' : 'Dark'} theme on this device.`,
                    'success',
                    4200
                );
                return true;
            } catch (error) {
                if (installedRef) {
                    try {
                        await deleteInstalledWallpaper(installedRef, {
                            enforceAccountBoundary: false,
                            showToast: false
                        });
                    } catch (cleanupError) {
                        console.warn('Failed to clean up local wallpaper upload after selection failure:', cleanupError);
                    }
                }

                console.warn('Failed to upload wallpaper locally:', error);
                const failureMessage = (typeof error?.message === 'string' && error.message.trim())
                    ? error.message.trim()
                    : 'Wallpaper upload failed. Please try another image.';
                showGlassToast(failureMessage, 'warning', 4200);
                return false;
            } finally {
                if (uploadInput && 'value' in uploadInput) {
                    uploadInput.value = '';
                }
            }
        }

        async function setWallpaperSelection(selection, {
            persist = true,
            enforceAccountBoundary = false
        } = {}) {
            const currentSelection = getWallpaperSelectionByTheme();
            const { selection: reconciledSelection } = reconcileWallpaperSelection(selection, {
                preserveHostedSelections: true
            });
            const selectionChanged = !areWallpaperSelectionsEqual(currentSelection, reconciledSelection);
            if (
                enforceAccountBoundary
                && selectionChanged
                && typeof canMutateAccountScopedPreferences === 'function'
                && !canMutateAccountScopedPreferences()
            ) {
                return false;
            }
            if (selectionChanged) {
                markWallpaperSelectionMutation(currentSelection, reconciledSelection);
                setWallpaperSelectionByTheme(reconciledSelection);
            }

            cacheWallpaperSelectionLocally(getWallpaperSelectionByTheme());
            applyActiveThemeWallpaper();
            renderWallpaperPopup({ preserveScroll: true });

            if (persist && selectionChanged) {
                try {
                    await saveWallpaperSelectionToStorage(getWallpaperSelectionByTheme());
                } catch (error) {
                    console.error('Failed to save wallpaper selection:', error);
                }
            }

            const currentThemeMode = getThemeMode();
            const selectedWallpaper = getWallpaperSelectionByTheme()[currentThemeMode];
            const selectionGuard = createWallpaperSelectionGuard(currentThemeMode, selectedWallpaper);
            if (isHostedWallpaperUrl(selectedWallpaper)) {
                void ensureHostedWallpaperBinaryCache(currentThemeMode, selectedWallpaper).then((dataUrl) => {
                    if (!dataUrl) return;
                    reapplyActiveWallpaperIfGuardCurrent(selectionGuard, {
                        preserveScroll: true
                    });
                });
            } else if (isInstalledWallpaperRef(selectedWallpaper)) {
                void ensureInstalledWallpaperBinaryCache(currentThemeMode, selectedWallpaper).then((dataUrl) => {
                    if (!dataUrl) return;
                    reapplyActiveWallpaperIfGuardCurrent(selectionGuard, {
                        preserveScroll: true
                    });
                });
            }
        }

        async function handleWallpaperThemeButtonClick(event) {
            closeWallpaperContextMenu();
            const selectedMode = normalizeThemeMode(event?.currentTarget?.dataset?.themeMode);
            if (selectedMode !== getThemeMode()) {
                const didSave = await saveThemeModeToStorage(selectedMode, {
                    queueSync: true,
                    syncReason: 'wallpaper-theme-mode-change',
                    enforceAccountBoundary: true
                });
                if (didSave === false) {
                    updateThemeModeToggle();
                    renderWallpaperPopup({ preserveScroll: true });
                }
            } else {
                updateThemeModeToggle();
                renderWallpaperPopup({ preserveScroll: true });
            }
        }

        async function selectWallpaperForTheme(theme, wallpaperId, {
            openStyleEditor = false,
            returnFocusElement = null
        } = {}) {
            const normalizedTheme = normalizeThemeMode(theme);
            const currentSelection = getWallpaperSelectionByTheme();
            const nextSelection = {
                dark: currentSelection.dark ?? null,
                light: currentSelection.light ?? null
            };
            let wallpaperLabel = 'Default';

            if (!wallpaperId || wallpaperId === defaultWallpaperTileId) {
                nextSelection[normalizedTheme] = null;
            } else {
                const selectedEntry = findWallpaperCatalogEntry(normalizedTheme, wallpaperId);
                if (!selectedEntry) {
                    return false;
                }
                if (selectedEntry.isInstalled === true && selectedEntry.isArchived === true) {
                    const didRestoreArchivedWallpaper = await setInstalledWallpaperArchivedState(
                        wallpaperId,
                        false,
                        {
                            enforceAccountBoundary: true,
                            showToast: false,
                            recordHistory: false
                        }
                    );
                    if (didRestoreArchivedWallpaper === false) {
                        return false;
                    }
                }
                nextSelection[normalizedTheme] = wallpaperId;
                wallpaperLabel = typeof selectedEntry.label === 'string' && selectedEntry.label.trim()
                    ? selectedEntry.label.trim()
                    : formatWallpaperLabelFromFile(wallpaperId);
            }

            const didApplySelection = await setWallpaperSelection(nextSelection, {
                persist: true,
                queueSync: true,
                syncReason: 'wallpaper-selection-change',
                enforceAccountBoundary: true
            });
            if (didApplySelection === false) {
                return false;
            }

            await hydrateSelectedWallpaperForTheme(normalizedTheme, {
                showOverlay: true,
                selectionGuard: createWallpaperSelectionGuard(normalizedTheme, nextSelection[normalizedTheme])
            });

            if (openStyleEditor) {
                maybeOpenWallpaperStyleEditorAfterSelection(
                    normalizedTheme,
                    nextSelection[normalizedTheme],
                    {
                        wallpaperLabel,
                        returnFocusElement
                    }
                );
            }

            return true;
        }

        async function handleWallpaperTileClick(event) {
            closeWallpaperContextMenu();
            const actionButton = event?.target?.closest('.wallpaper-tile-action');
            if (actionButton) {
                const actionTile = actionButton.closest('.wallpaper-tile');
                const actionWallpaperId = actionTile?.dataset?.wallpaperId;
                const wallpaperAction = actionButton.dataset.wallpaperAction;
                if (!actionWallpaperId || !isInstalledWallpaperRef(actionWallpaperId)) {
                    return;
                }

                let didHandleAction = false;
                if (wallpaperAction === 'edit') {
                    const tileTheme = normalizeThemeMode(actionTile?.dataset?.wallpaperTheme || getThemeMode());
                    const currentSelection = getWallpaperSelectionByTheme();
                    if ((currentSelection?.[tileTheme] ?? null) === actionWallpaperId) {
                        didHandleAction = maybeOpenWallpaperStyleEditorAfterSelection(tileTheme, actionWallpaperId, {
                            wallpaperLabel: actionTile?.dataset?.wallpaperLabel || null,
                            returnFocusElement: actionButton
                        });
                    } else {
                        didHandleAction = await selectWallpaperForTheme(tileTheme, actionWallpaperId, {
                            openStyleEditor: true,
                            returnFocusElement: actionButton
                        });
                    }
                } else if (wallpaperAction === 'archive' || wallpaperAction === 'restore') {
                    didHandleAction = await setInstalledWallpaperArchivedState(
                        actionWallpaperId,
                        wallpaperAction === 'archive',
                        {
                            enforceAccountBoundary: true,
                            showToast: true
                        }
                    );
                } else if (wallpaperAction === 'delete') {
                    didHandleAction = await deleteInstalledWallpaper(actionWallpaperId, {
                        enforceAccountBoundary: true,
                        showToast: true
                    });
                }

                if (didHandleAction === false) {
                    renderWallpaperPopup({ preserveScroll: true });
                }
                return;
            }

            const tile = event.target.closest('.wallpaper-tile');
            if (!tile) return;

            const activeTheme = normalizeThemeMode(getThemeMode());
            const wallpaperId = tile.dataset.wallpaperId;
            await selectWallpaperForTheme(activeTheme, wallpaperId);
        }

        function getWallpaperContextMenuContext(tile) {
            const wallpaperId = typeof tile?.dataset?.wallpaperId === 'string'
                ? tile.dataset.wallpaperId.trim()
                : '';
            if (!wallpaperId || wallpaperId === defaultWallpaperTileId) {
                return null;
            }

            const theme = normalizeThemeMode(tile?.dataset?.wallpaperTheme || getThemeMode());
            const normalizedFile = normalizeWallpaperPathForTheme(theme, wallpaperId);
            if (!normalizedFile) {
                return null;
            }

            const matchingCatalogEntry = findWallpaperCatalogEntry(theme, normalizedFile);
            const resolvedEntry = normalizeWallpaperEntryForDisplay(theme, matchingCatalogEntry)
                || createSyntheticWallpaperEntry(theme, normalizedFile)
                || {
                    file: normalizedFile,
                    label: typeof tile?.dataset?.wallpaperLabel === 'string' && tile.dataset.wallpaperLabel.trim()
                        ? tile.dataset.wallpaperLabel.trim()
                        : formatWallpaperLabelFromFile(normalizedFile),
                    ...getWallpaperEntryArchiveState(normalizedFile)
                };

            return {
                theme,
                file: resolvedEntry.file,
                label: resolvedEntry.label,
                isInstalled: resolvedEntry.isInstalled === true,
                isArchived: resolvedEntry.isArchived === true
            };
        }

        function buildWallpaperContextMenuActions(context) {
            const actions = [{
                action: 'download',
                label: 'Download This Wallpaper',
                icon: 'download'
            }];

            if (context?.isInstalled === true) {
                actions.push({
                    action: context.isArchived ? 'restore' : 'archive',
                    label: context.isArchived ? 'Restore Wallpaper' : 'Archive Wallpaper',
                    icon: context.isArchived ? 'restore' : 'archive'
                });
                actions.push({ action: 'divider' });
                actions.push({
                    action: 'delete',
                    label: 'Delete Wallpaper',
                    icon: 'delete',
                    danger: true
                });
            }

            return actions;
        }

        function showWallpaperContextMenu(event, context) {
            const menu = getWallpaperContextMenuElement();
            if (!menu || !context) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();

            wallpaperContextMenuState = context;
            menu.replaceChildren();

            const actions = buildWallpaperContextMenuActions(context);
            for (const action of actions) {
                if (action.action === 'divider') {
                    const divider = document.createElement('div');
                    divider.className = 'tab-menu-divider';
                    divider.setAttribute('role', 'separator');
                    menu.appendChild(divider);
                    continue;
                }
                menu.appendChild(createWallpaperContextMenuItemElement(action));
            }

            menu.classList.add('active');
            menu.setAttribute('aria-hidden', 'false');

            const menuRect = menu.getBoundingClientRect();
            const menuWidth = menuRect.width || 220;
            const menuHeight = menuRect.height || 144;

            let left = event.clientX;
            let top = event.clientY;

            if (left + menuWidth > window.innerWidth) {
                left = window.innerWidth - menuWidth - 10;
            }
            if (top + menuHeight > window.innerHeight) {
                top = window.innerHeight - menuHeight - 10;
            }

            menu.style.left = `${Math.max(10, left)}px`;
            menu.style.top = `${Math.max(10, top)}px`;
        }

        async function handleWallpaperTileContextMenu(event) {
            const tile = event?.target?.closest('.wallpaper-tile');
            if (!tile || tile.classList.contains('default')) {
                return;
            }

            const context = getWallpaperContextMenuContext(tile);
            if (!context) {
                return;
            }

            showWallpaperContextMenu(event, context);
        }

        async function handleWallpaperContextMenuClick(event) {
            const menuItem = event?.target?.closest('.tab-menu-item');
            if (!menuItem) {
                return;
            }

            const action = typeof menuItem.dataset?.action === 'string'
                ? menuItem.dataset.action.trim()
                : '';
            if (!action) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();

            const context = wallpaperContextMenuState;
            closeWallpaperContextMenu();

            if (!context) {
                return;
            }

            if (action === 'download') {
                await downloadWallpaperToDevice(context);
                return;
            }

            if (context.isInstalled !== true) {
                return;
            }

            let didHandleAction = false;
            if (action === 'archive' || action === 'restore') {
                didHandleAction = await setInstalledWallpaperArchivedState(
                    context.file,
                    action === 'archive',
                    {
                        enforceAccountBoundary: true,
                        showToast: true
                    }
                );
            } else if (action === 'delete') {
                didHandleAction = await deleteInstalledWallpaper(context.file, {
                    enforceAccountBoundary: true,
                    showToast: true
                });
            }

            if (didHandleAction === false) {
                renderWallpaperPopup({ preserveScroll: true });
            }
        }

        async function loadWallpaperCatalog() {
            try {
                const response = await fetch(wallpaperCatalogPath, { cache: 'no-store' });
                if (!response.ok) {
                    throw new Error(`Wallpaper catalog request failed (${response.status})`);
                }
                const rawCatalog = await response.json();
                const localCatalog = normalizeWallpaperCatalog(rawCatalog);
                setBundledWallpaperCatalogState(localCatalog);
                return localCatalog;
            } catch (error) {
                console.warn('Failed to load wallpaper catalog. Falling back to empty set.', error);
                const fallbackCatalog = {
                    themes: createEmptyWallpaperCatalog(),
                    themeDefaults: createEmptyWallpaperThemeDefaults()
                };
                setBundledWallpaperCatalogState(fallbackCatalog);
                return fallbackCatalog;
            }
        }

        async function loadInstalledWallpaperCatalog({ apply = true } = {}) {
            const installedCatalog = await loadInstalledWallpaperCatalogFromDatabase();

            if (apply) {
                const { selection: reconciledSelection, changed } = reconcileWallpaperSelection(getWallpaperSelectionByTheme(), {
                    preserveHostedSelections: true
                });
                if (changed) {
                    setWallpaperSelectionByTheme(reconciledSelection);
                    cacheWallpaperSelectionLocally(getWallpaperSelectionByTheme());
                    void saveWallpaperSelectionToStorage(getWallpaperSelectionByTheme()).catch((error) => {
                        console.error('Failed to persist reconciled installed wallpaper selection:', error);
                    });
                }

                if (getWallpaperPreferencesInitialized()) {
                    applyActiveThemeWallpaper();
                    renderWallpaperPopup({ preserveScroll: true });
                }
            }

            return installedCatalog;
        }

        async function loadHostedWallpaperCatalog({ apply = true, force = false } = {}) {
            if (!force && getHostedWallpaperCatalogPromise()) {
                return getHostedWallpaperCatalogPromise();
            }

            const hostedPromise = (async () => {
                try {
                    if (typeof recordWallpaperDiagnosticEvent === 'function') {
                        recordWallpaperDiagnosticEvent('hosted-wallpaper-catalog-requested', {
                            apply,
                            force
                        }, {
                            counter: 'hostedCatalogRequests'
                        });
                    }
                    const response = await fetch(wallpaperRemoteCatalogUrl, { cache: 'no-store' });
                    if (!response.ok) {
                        throw new Error(`Hosted wallpaper catalog request failed (${response.status})`);
                    }

                    const rawCatalog = await response.json();
                    const remoteCatalog = normalizeWallpaperCatalog(rawCatalog, {
                        resolveFilePath: (theme, filePath) => {
                            const normalizedLocalPath = typeof filePath === 'string'
                                ? filePath.trim().replace(/^\/+/, '')
                                : '';
                            if (!normalizedLocalPath.startsWith(`wallpaper/${normalizeThemeMode(theme)}/`)) {
                                return null;
                            }
                            if (!wallpaperFilePattern.test(normalizedLocalPath)) {
                                return null;
                            }
                            return toHostedWallpaperUrl(normalizedLocalPath);
                        }
                    });

                    if (apply) {
                        const mergedCatalog = mergeWallpaperCatalogs(
                            getCurrentWallpaperCatalogState(),
                            remoteCatalog
                        );
                        setWallpaperCatalogByTheme(mergedCatalog.themes);
                        setWallpaperThemeDefaults(mergedCatalog.themeDefaults);

                        const { selection: reconciledSelection, changed } = reconcileWallpaperSelection(getWallpaperSelectionByTheme());
                        if (changed) {
                            setWallpaperSelectionByTheme(reconciledSelection);
                            cacheWallpaperSelectionLocally(getWallpaperSelectionByTheme());
                            void saveWallpaperSelectionToStorage(getWallpaperSelectionByTheme()).catch((error) => {
                                console.error('Failed to persist reconciled hosted wallpaper selection:', error);
                            });
                        }
                        applyActiveThemeWallpaper();
                        renderWallpaperPopup({ preserveScroll: true });
	                    }

                    if (typeof recordWallpaperDiagnosticEvent === 'function') {
                        recordWallpaperDiagnosticEvent('hosted-wallpaper-catalog-loaded', {
                            apply,
                            force,
                            darkCount: Array.isArray(remoteCatalog?.themes?.dark) ? remoteCatalog.themes.dark.length : 0,
                            lightCount: Array.isArray(remoteCatalog?.themes?.light) ? remoteCatalog.themes.light.length : 0
                        });
                    }

                    return remoteCatalog;
                } catch (error) {
                    console.warn('Failed to load hosted wallpaper catalog. Continuing with bundled wallpapers only.', error);
                    if (typeof recordWallpaperDiagnosticEvent === 'function') {
                        recordWallpaperDiagnosticEvent('hosted-wallpaper-catalog-failed', {
                            apply,
                            force,
                            error: error?.message || String(error)
                        }, {
                            counter: 'hostedCatalogFailures'
                        });
                    }
                    return {
                        themes: createEmptyWallpaperCatalog(),
                        themeDefaults: createEmptyWallpaperThemeDefaults()
                    };
                }
            })();

            setHostedWallpaperCatalogPromise(hostedPromise);
            return hostedPromise;
        }

        async function loadHostedWallpaperGalleryManifest({ apply = true, force = false } = {}) {
            if (!force && getHostedWallpaperGalleryPromise()) {
                return getHostedWallpaperGalleryPromise();
            }

            const hostedPromise = (async () => {
                try {
                    if (typeof recordWallpaperDiagnosticEvent === 'function') {
                        recordWallpaperDiagnosticEvent('wallpaper-gallery-manifest-requested', {
                            apply,
                            force
                        }, {
                            counter: 'galleryManifestRequests'
                        });
                    }
                    const response = await fetch(wallpaperRemoteGalleryUrl, { cache: 'no-store' });
                    if (!response.ok) {
                        throw new Error(`Hosted wallpaper gallery request failed (${response.status})`);
                    }

                    const rawGalleryManifest = await response.json();
                    const remoteCatalog = normalizeWallpaperCatalog(rawGalleryManifest);

                    if (apply) {
                        const mergedCatalog = mergeWallpaperCatalogs(
                            getCurrentWallpaperCatalogState(),
                            remoteCatalog
                        );
                        setWallpaperCatalogByTheme(mergedCatalog.themes);
                        applyActiveThemeWallpaper();
                        renderWallpaperPopup({ preserveScroll: true });
	                    }

                    if (typeof recordWallpaperDiagnosticEvent === 'function') {
                        recordWallpaperDiagnosticEvent('wallpaper-gallery-manifest-loaded', {
                            apply,
                            force,
                            darkCount: Array.isArray(remoteCatalog?.themes?.dark) ? remoteCatalog.themes.dark.length : 0,
                            lightCount: Array.isArray(remoteCatalog?.themes?.light) ? remoteCatalog.themes.light.length : 0
                        });
                    }

                    return remoteCatalog;
                } catch (error) {
                    console.warn('Failed to load hosted wallpaper gallery manifest. Continuing with available wallpapers only.', error);
                    if (typeof recordWallpaperDiagnosticEvent === 'function') {
                        recordWallpaperDiagnosticEvent('wallpaper-gallery-manifest-failed', {
                            apply,
                            force,
                            error: error?.message || String(error)
                        }, {
                            counter: 'galleryManifestFailures'
                        });
                    }
                    return {
                        themes: createEmptyWallpaperCatalog(),
                        themeDefaults: createEmptyWallpaperThemeDefaults()
                    };
                }
            })();

            setHostedWallpaperGalleryPromise(hostedPromise);
            return hostedPromise;
        }

        async function loadWallpaperSelectionFromStorage(prefetchedStorage = null) {
            let selectionFromStorage = null;
            let hasChromeSelection = false;
            let hasSharedChromeSelection = false;
            const currentWallpaperUserId = typeof getWallpaperAccountScopeUserId === 'function'
                ? getWallpaperAccountScopeUserId()
                : null;

            if (currentWallpaperUserId) {
                try {
                    const accountState = await getWallpaperAccountLocalState(currentWallpaperUserId, prefetchedStorage);
                    if (accountState) {
                        selectionFromStorage = accountState.selectionByTheme;
                        hasChromeSelection = true;
                    }
                } catch (error) {
                    console.warn('Failed to load local wallpaper account selection state:', error);
                }
            }

            if (typeof chrome !== 'undefined' && chrome.storage?.local) {
                try {
                    const hasPrefetchedSelection = prefetchedStorage
                        && typeof prefetchedStorage === 'object'
                        && Object.prototype.hasOwnProperty.call(prefetchedStorage, wallpaperStorageKey);
                    const result = hasPrefetchedSelection
                        ? {
                            [wallpaperStorageKey]: prefetchedStorage[wallpaperStorageKey]
                        }
                        : await chrome.storage.local.get(wallpaperStorageKey);
                    if (Object.prototype.hasOwnProperty.call(result, wallpaperStorageKey)) {
                        hasSharedChromeSelection = true;
                        if (!hasChromeSelection) {
                            selectionFromStorage = result[wallpaperStorageKey];
                            hasChromeSelection = true;
                        }
                    }
                } catch (error) {
                    console.error('Failed to load wallpaper selection from chrome storage:', error);
                }
            }

            if (!hasChromeSelection) {
                selectionFromStorage = readCachedWallpaperSelection();
            }

            const { selection: reconciledSelection, changed } = reconcileWallpaperSelection(selectionFromStorage, {
                preserveHostedSelections: true
            });
            setWallpaperSelectionByTheme(reconciledSelection);
            cacheWallpaperSelectionLocally(getWallpaperSelectionByTheme());

            if (changed || !hasChromeSelection || (currentWallpaperUserId && !hasSharedChromeSelection)) {
                try {
                    await saveWallpaperSelectionToStorage(getWallpaperSelectionByTheme());
                } catch (error) {
                    console.error('Failed to persist reconciled wallpaper selection:', error);
                }
            }

            await Promise.all(['dark', 'light'].map(async (theme) => {
                const selectedWallpaper = getWallpaperSelectionByTheme()[theme];
                if (isHostedWallpaperUrl(selectedWallpaper)) {
                    await ensureHostedWallpaperBinaryCache(theme, selectedWallpaper);
                    return;
                }
                if (isInstalledWallpaperRef(selectedWallpaper)) {
                    await ensureInstalledWallpaperBinaryCache(theme, selectedWallpaper);
                }
            }));
        }

        async function applyWebsiteWallpaperHandoffFromUrl() {
            const urlParams = new URLSearchParams(window.location.search);
            const rawGalleryId = urlParams.get(wallpaperGalleryIdUrlParam);
            const rawWallpaper = urlParams.get(wallpaperUrlParam);
            const rawTheme = urlParams.get(wallpaperThemeUrlParam);
            const queryHandoff = normalizePendingWallpaperHandoff({
                galleryId: rawGalleryId,
                wallpaper: rawWallpaper,
                theme: rawTheme
            });
            const storedHandoff = queryHandoff ? null : readPendingWallpaperHandoff();
            const resolvedHandoff = queryHandoff || storedHandoff;
            if (!resolvedHandoff) return;

            if (queryHandoff) {
                urlParams.delete(wallpaperGalleryIdUrlParam);
                urlParams.delete(wallpaperUrlParam);
                urlParams.delete(wallpaperThemeUrlParam);
                const nextQuery = urlParams.toString();
                window.history.replaceState({}, '', nextQuery ? `newtab.html?${nextQuery}` : 'newtab.html');
            }

            const currentWallpaperUserId = typeof getWallpaperAccountScopeUserId === 'function'
                ? getWallpaperAccountScopeUserId()
                : null;
            if (!currentWallpaperUserId) {
                if (queryHandoff) {
                    // writePendingWallpaperHandoff(queryHandoff);
                    // if (typeof recordWallpaperDiagnosticEvent === 'function') {
                    //     recordWallpaperDiagnosticEvent('website-wallpaper-handoff-deferred-auth', {
                    //         theme: queryHandoff.theme,
                    //         galleryId: queryHandoff.galleryId,
                    //         sourceUrl: queryHandoff.wallpaper
                    //     });
                    // }
                    // showGlassToast('Sign in to add this wallpaper to LumiList.', 'info', 3200);
                }
                // return;
            }

            clearPendingWallpaperHandoff();

            const handoffTheme = resolvedHandoff.theme;
            const normalizedWallpaper = resolvedHandoff.wallpaper;
            const resolvedGalleryId = resolvedHandoff.galleryId;

            pushWallpaperDownloadOverlayVisible();

            try {
                let selectedWallpaper = null;
                let matchedRemoteEntry = null;
                let fallbackHostedWallpaper = null;
                let equivalentCatalogEntry = null;
                let existingInstalledWallpaperRef = null;
                let refreshedExistingInstalledWallpaper = false;

                if (resolvedGalleryId) {
                    const galleryCatalog = await loadHostedWallpaperGalleryManifest({ apply: false, force: true });
                    const galleryEntries = Array.isArray(galleryCatalog?.themes?.[handoffTheme])
                        ? galleryCatalog.themes[handoffTheme]
                        : [];
                    matchedRemoteEntry = galleryEntries.find((entry) => entry?.id === resolvedGalleryId) || null;
                    if (matchedRemoteEntry?.file) {
                        fallbackHostedWallpaper = normalizeWallpaperPathForTheme(handoffTheme, matchedRemoteEntry.file);
                    }
                }

                if (!matchedRemoteEntry && normalizedWallpaper && isHostedWallpaperUrl(normalizedWallpaper)) {
                    const remoteCatalog = await loadHostedWallpaperCatalog({ apply: false, force: true });
                    const remoteEntries = Array.isArray(remoteCatalog?.themes?.[handoffTheme])
                        ? remoteCatalog.themes[handoffTheme]
                        : [];
                    matchedRemoteEntry = remoteEntries.find((entry) => (
                        normalizeWallpaperPathForTheme(handoffTheme, entry?.file) === normalizedWallpaper
                    )) || null;
                    if (matchedRemoteEntry?.file) {
                        fallbackHostedWallpaper = normalizeWallpaperPathForTheme(handoffTheme, matchedRemoteEntry.file);
                    }
                }

                if (!fallbackHostedWallpaper && isHostedWallpaperUrl(normalizedWallpaper)) {
                    fallbackHostedWallpaper = normalizedWallpaper;
                }

                const resolvedRemoteId = (matchedRemoteEntry?.id || resolvedGalleryId || null);
                if (typeof findInstalledWallpaperRefByRemoteIdentity === 'function') {
                    existingInstalledWallpaperRef = findInstalledWallpaperRefByRemoteIdentity(handoffTheme, {
                        remoteId: resolvedRemoteId,
                        sourceUrl: matchedRemoteEntry?.file || fallbackHostedWallpaper || normalizedWallpaper || null
                    });
                } else if (typeof findInstalledWallpaperRefBySourceUrl === 'function') {
                    existingInstalledWallpaperRef = findInstalledWallpaperRefBySourceUrl(
                        handoffTheme,
                        matchedRemoteEntry?.file || fallbackHostedWallpaper || normalizedWallpaper || null
                    );
                }

                if (matchedRemoteEntry?.file) {
                    equivalentCatalogEntry = typeof findEquivalentWallpaperCatalogEntry === 'function'
                        ? findEquivalentWallpaperCatalogEntry(handoffTheme, matchedRemoteEntry.file)
                        : null;
                }

                if (!equivalentCatalogEntry && fallbackHostedWallpaper && typeof findEquivalentWallpaperCatalogEntry === 'function') {
                    equivalentCatalogEntry = findEquivalentWallpaperCatalogEntry(handoffTheme, fallbackHostedWallpaper);
                }

                if (existingInstalledWallpaperRef && matchedRemoteEntry?.file) {
                    try {
                        const installResult = await installRemoteWallpaperLocally({
                            theme: handoffTheme,
                            sourceUrl: matchedRemoteEntry.file,
                            remoteId: resolvedRemoteId,
                            label: matchedRemoteEntry.label,
                            style: matchedRemoteEntry.style,
                            thumbnailUrl: matchedRemoteEntry.thumbnailUrl,
                            version: matchedRemoteEntry.version,
                            installContext: 'website-handoff-refresh-existing',
                            fetchCache: 'reload'
                        });
                        selectedWallpaper = installResult?.installedRef || existingInstalledWallpaperRef;
                        refreshedExistingInstalledWallpaper = Boolean(installResult?.installedRef || existingInstalledWallpaperRef);
                    } catch (error) {
                        console.warn('Failed to refresh the existing wallpaper locally. Falling back to the previous installed copy.', error);
                        selectedWallpaper = existingInstalledWallpaperRef;
                    }
                } else if (equivalentCatalogEntry?.file) {
                    selectedWallpaper = equivalentCatalogEntry.file;
                } else if (matchedRemoteEntry?.file) {
                    try {
                        const installResult = await installRemoteWallpaperLocally({
                            theme: handoffTheme,
                            sourceUrl: matchedRemoteEntry.file,
                            remoteId: resolvedRemoteId,
                            label: matchedRemoteEntry.label,
                            style: matchedRemoteEntry.style,
                            thumbnailUrl: matchedRemoteEntry.thumbnailUrl,
                            version: matchedRemoteEntry.version,
                            installContext: 'website-handoff'
                        });
                        selectedWallpaper = installResult.installedRef;
                    } catch (error) {
                        console.warn('Failed to install selected wallpaper locally. Falling back to hosted selection for compatibility.', error);
                        if (typeof recordWallpaperDiagnosticEvent === 'function') {
                            recordWallpaperDiagnosticEvent('website-wallpaper-handoff-install-failed', {
                                theme: handoffTheme,
                                galleryId: resolvedGalleryId || null,
                                sourceUrl: matchedRemoteEntry?.file || normalizedWallpaper || null,
                                error: error?.message || String(error)
                            });
                        }
                    }
                }

                if (!selectedWallpaper && normalizedWallpaper && findWallpaperCatalogEntry(handoffTheme, normalizedWallpaper)) {
                    selectedWallpaper = normalizedWallpaper;
                }

                if (!selectedWallpaper && fallbackHostedWallpaper && isHostedWallpaperUrl(fallbackHostedWallpaper)) {
                    await ensureHostedWallpaperBinaryCache(handoffTheme, fallbackHostedWallpaper);
                    selectedWallpaper = fallbackHostedWallpaper;
                    if (typeof recordWallpaperDiagnosticEvent === 'function') {
                        recordWallpaperDiagnosticEvent('website-wallpaper-handoff-used-hosted-fallback', {
                            theme: handoffTheme,
                            galleryId: resolvedGalleryId || null,
                            sourceUrl: fallbackHostedWallpaper
                        });
                    }
                }

                if (!selectedWallpaper) {
                    if (typeof recordWallpaperDiagnosticEvent === 'function') {
                        recordWallpaperDiagnosticEvent('website-wallpaper-handoff-unavailable', {
                            theme: handoffTheme,
                            galleryId: resolvedGalleryId || null,
                            sourceUrl: normalizedWallpaper || null
                        });
                    }
                    showGlassToast('Wallpaper is not available yet. Please try again in a moment.', 'warning');
                    return;
                }

                const currentSelection = getWallpaperSelectionByTheme();
                const didReuseSelectedWallpaperRef = (currentSelection?.[handoffTheme] ?? null) === (selectedWallpaper ?? null);
                const didApplyTheme = await saveThemeModeToStorage(handoffTheme, {
                    applyWallpaper: false,
                    renderPopup: false,
                    hydrateSelection: false,
                    persistAccountState: false,
                    enforceAccountBoundary: true
                });
                if (didApplyTheme === false) {
                    return;
                }

                const didApplySelection = await setWallpaperSelection({
                    dark: currentSelection.dark ?? null,
                    light: currentSelection.light ?? null,
                    [handoffTheme]: selectedWallpaper
                }, {
                    persist: true,
                    queueSync: true,
                    syncReason: 'website-wallpaper-install',
                    enforceAccountBoundary: true
                });
                if (didApplySelection === false) {
                    return;
                }

                const selectionGuard = createWallpaperSelectionGuard(handoffTheme, selectedWallpaper);
                if (isHostedWallpaperUrl(selectedWallpaper)) {
                    await ensureHostedWallpaperBinaryCache(handoffTheme, selectedWallpaper);
                    reapplyActiveWallpaperIfGuardCurrent(selectionGuard, {
                        preserveScroll: true
                    });
                } else if (isInstalledWallpaperRef(selectedWallpaper)) {
                    await ensureInstalledWallpaperBinaryCache(handoffTheme, selectedWallpaper);
                    reapplyActiveWallpaperIfGuardCurrent(selectionGuard, {
                        preserveScroll: true
                    });
                }
                if (typeof recordWallpaperDiagnosticEvent === 'function') {
                    recordWallpaperDiagnosticEvent('website-wallpaper-handoff-applied', {
                        theme: handoffTheme,
                        galleryId: resolvedGalleryId || null,
                        selectedWallpaper,
                        installed: isInstalledWallpaperRef(selectedWallpaper)
                    });
                }
                showGlassToast(
                    `${isInstalledWallpaperRef(selectedWallpaper) ? 'Wallpaper installed to' : 'Wallpaper added to'} ${handoffTheme === 'light' ? 'Light' : 'Dark'} theme`,
                    'success'
                );
            } finally {
                popWallpaperDownloadOverlayVisible();
            }
        }

        async function initializeWallpaperPreferences() {
            await loadWallpaperCatalog();
            // if (!getWallpaperAccountScopeUserId()) {
            //     applyLoggedOutDefaultThemeUi();
            //     setWallpaperPreferencesInitialized(true);
            //     return;
            // }
            await seedNewUserWallpaperDefaultIfPending();
            await seedPackagedDefaultForEmptyLocalWallpaperState();
            await loadThemeModeFromStorage(null, {
                allowStorageThemeMode: true, // Boolean(getWallpaperAccountScopeUserId()),
                allowCachedThemeMode: true,
                persistMissingThemeMode: true // Boolean(getWallpaperAccountScopeUserId())
            });
            await loadInstalledWallpaperCatalog({ apply: false });
            await loadWallpaperSelectionFromStorage();
            if (typeof loadWallpaperStyleOverridesFromStorage === 'function') {
                await loadWallpaperStyleOverridesFromStorage();
            }
            await migrateHostedWallpaperSelections({
                allowNetwork: false,
                showFailureToast: false
            });
            setWallpaperPreferencesInitialized(true);
            renderWallpaperPopup();
            applyActiveThemeWallpaper();
        }

        function openWallpaperGallery() {
            const targetUrl = new URL(wallpaperGalleryUrl);
            targetUrl.searchParams.set('source', 'extension');
            try {
                const extensionTarget = chrome?.runtime?.getURL?.('newtab.html');
                if (typeof extensionTarget === 'string' && extensionTarget) {
                    targetUrl.searchParams.set('ext_target', extensionTarget);
                }
            } catch (error) {
                console.warn('Failed to append runtime extension target to wallpaper gallery URL:', error);
            }
            try {
                const extensionId = chrome?.runtime?.id;
                if (typeof extensionId === 'string' && /^[a-z]{32}$/.test(extensionId)) {
                    targetUrl.searchParams.set('ext_id', extensionId);
                }
            } catch (error) {
                console.warn('Failed to append runtime extension ID to wallpaper gallery URL:', error);
            }
            const targetUrlString = targetUrl.toString();
            // Avoid the `noopener` window feature here because some browsers/extensions
            // return `null` even when the new tab successfully opens, which would trigger
            // a false same-tab fallback.
            const openedWindow = window.open(targetUrlString, '_blank');
            if (openedWindow) {
                try {
                    openedWindow.opener = null;
                } catch (_error) {
                    // Non-blocking hardening for browsers that disallow touching opener.
                }
            }
            if (!openedWindow) {
                window.location.assign(targetUrlString);
            }
        }

        function applyThemeMode(mode, {
            applyWallpaper = true,
            renderPopup = true,
            hydrateSelection = true
        } = {}) {
            setThemeMode(normalizeThemeMode(mode));
            document.documentElement.setAttribute('data-theme', getThemeMode());
            updateThemeModeToggle();
            if (getWallpaperPreferencesInitialized()) {
                if (applyWallpaper) {
                    applyActiveThemeWallpaper();
                }
                if (renderPopup) {
                    renderWallpaperPopup();
                }
                if (hydrateSelection) {
                    void hydrateSelectedWallpaperForTheme(getThemeMode(), { showOverlay: false });
                }
            }
        }

        async function saveThemeModeToStorage(mode, {
            applyWallpaper = true,
            renderPopup = true,
            hydrateSelection = true,
            persistAccountState = true,
            enforceAccountBoundary = false
        } = {}) {
            const normalized = normalizeThemeMode(mode);
            if (
                enforceAccountBoundary
                && normalized !== getThemeMode()
                && typeof canMutateAccountScopedPreferences === 'function'
                && !canMutateAccountScopedPreferences()
            ) {
                return false;
            }
            applyThemeMode(normalized, {
                applyWallpaper,
                renderPopup,
                hydrateSelection
            });

            try {
                localStorage.setItem('lumilist_theme_mode', normalized);
            } catch (error) {
                console.warn('Failed to cache theme mode in localStorage:', error);
            }
            if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                try {
                    const storagePayload = {
                        themeMode: normalized
                    };
                    if (persistAccountState) {
                        const accountStatePatch = await buildWallpaperAccountLocalStateStoragePatch({
                            themeMode: normalized,
                            selection: getWallpaperSelectionByTheme()
                        });
                        if (accountStatePatch) {
                            Object.assign(storagePayload, accountStatePatch);
                        }
                    }
                    await commitWallpaperAccountStoragePayload(storagePayload);
                } catch (error) {
                    console.error('Error saving theme mode:', error);
                }
            }
            return true;
        }

        async function loadThemeModeFromStorage(prefetchedStorage = null, options = {}) {
            let resolvedMode = 'dark';
            const allowStorageThemeMode = options?.allowStorageThemeMode !== false;
            const allowCachedThemeMode = options?.allowCachedThemeMode !== false;
            const persistMissingThemeMode = options?.persistMissingThemeMode !== false;
            const persistResolvedMode = options?.persistResolvedMode !== false;
            const applyWallpaper = options?.applyWallpaper !== false;
            const renderPopup = options?.renderPopup !== false;
            const hydrateSelection = options?.hydrateSelection !== false;
            const currentWallpaperUserId = typeof getWallpaperAccountScopeUserId === 'function'
                ? getWallpaperAccountScopeUserId()
                : null;

            if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                try {
                    const accountState = currentWallpaperUserId
                        ? await getWallpaperAccountLocalState(currentWallpaperUserId, prefetchedStorage)
                        : null;
                    const result = prefetchedStorage && typeof prefetchedStorage === 'object'
                        ? prefetchedStorage
                        : await chrome.storage.local.get('themeMode');
                    let shouldPersistResolvedMode = false;
                    if (allowStorageThemeMode && (accountState?.themeMode === 'dark' || accountState?.themeMode === 'light')) {
                        resolvedMode = accountState.themeMode;
                        shouldPersistResolvedMode = result?.themeMode !== resolvedMode;
                    } else if (allowStorageThemeMode && result && (result.themeMode === 'dark' || result.themeMode === 'light')) {
                        resolvedMode = result.themeMode;
                    } else if (allowCachedThemeMode) {
                        const cachedMode = readThemeModeCache();
                        if (cachedMode) {
                            resolvedMode = cachedMode;
                            shouldPersistResolvedMode = persistMissingThemeMode;
                        }
                    }
                    if (shouldPersistResolvedMode && persistResolvedMode) {
                        const storagePayload = {
                            themeMode: resolvedMode
                        };
                        const accountStatePatch = await buildWallpaperAccountLocalStateStoragePatch({
                            themeMode: resolvedMode
                        });
                        if (accountStatePatch) {
                            Object.assign(storagePayload, accountStatePatch);
                        }
                        await commitWallpaperAccountStoragePayload(storagePayload);
                    }
                } catch (error) {
                    console.error('Error loading theme mode:', error);
                }
            } else if (allowCachedThemeMode) {
                const cachedMode = readThemeModeCache();
                if (cachedMode) {
                    resolvedMode = cachedMode;
                }
            }

            try {
                localStorage.setItem('lumilist_theme_mode', resolvedMode);
            } catch (_error) {
                // Non-blocking fallback
            }

            applyThemeMode(resolvedMode, {
                applyWallpaper,
                renderPopup,
                hydrateSelection
            });
        }

        async function refreshAccountScopedWallpaperStateFromStorage(prefetchedStorage = null) {
            const currentWallpaperUserId = typeof getWallpaperAccountScopeUserId === 'function'
                ? getWallpaperAccountScopeUserId()
                : null;
            const incomingAccountState = currentWallpaperUserId
                ? await getWallpaperAccountLocalState(currentWallpaperUserId, prefetchedStorage)
                : null;
            if (
                incomingAccountState
                && shouldIgnoreIncomingWallpaperAccountLocalState(incomingAccountState, currentWallpaperUserId)
            ) {
                return false;
            }

            await loadThemeModeFromStorage(prefetchedStorage, {
                allowStorageThemeMode: true, // Boolean(getWallpaperAccountScopeUserId()),
                allowCachedThemeMode: true,
                persistMissingThemeMode: false,
                persistResolvedMode: false,
                applyWallpaper: false,
                renderPopup: false,
                hydrateSelection: false
            });
            await loadWallpaperSelectionFromStorage(prefetchedStorage);
            if (typeof loadWallpaperStyleOverridesFromStorage === 'function') {
                await loadWallpaperStyleOverridesFromStorage(prefetchedStorage);
            }
            if (incomingAccountState) {
                noteWallpaperAccountLocalStateApplied(incomingAccountState, currentWallpaperUserId);
            }
            if (getWallpaperPreferencesInitialized()) {
                applyActiveThemeWallpaper();
                renderWallpaperPopup({ preserveScroll: true });
                void hydrateSelectedWallpaperForTheme(getThemeMode(), { showOverlay: false });
            }
            return true;
        }

        return {
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
            handleWallpaperUploadButtonClick,
            handleWallpaperUploadInputChange,
            openWallpaperGallery,
            updateThemeModeToggle,
            closeWallpaperStyleEditor,
            resetWallpaperStyleEditorDraft,
            saveWallpaperStyleEditorDraft
        };
    };
})(window);
