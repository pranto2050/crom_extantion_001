(function registerLumiListUiModesFeature(global) {
    const modules = global.LumiListModules || (global.LumiListModules = {});
    const features = modules.features || (modules.features = {});

    features.uiModes = function createUiModesFeature(options) {
        const {
            getPrivacyModeEnabled,
            setPrivacyModeEnabled,
            getIncognitoModeEnabled,
            setIncognitoModeEnabled,
            getCompactModeEnabled,
            setCompactModeEnabled,
            getIsSelectionMode,
            canMutateAccountScopedPreferences
        } = options;

        let incognitoHandlerInitialized = false;

        function applyPrivacyBlurToBoards() {
            const enabled = getPrivacyModeEnabled();
            document.querySelectorAll('.board').forEach((board) => {
                board.classList.toggle('privacy-blur', enabled);
            });
        }

        async function syncPrivacyModeFromStorage(prefetchedStorage = null) {
            if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                try {
                    const result = prefetchedStorage && typeof prefetchedStorage === 'object'
                        ? prefetchedStorage
                        : await chrome.storage.local.get('privacyModeEnabled');
                    setPrivacyModeEnabled(result.privacyModeEnabled === true);
                    updatePrivacyButtonState();
                } catch (error) {
                    console.error('Error loading privacy mode:', error);
                }
            }
        }

        async function savePrivacyModeToStorage() {
            if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                try {
                    await chrome.storage.local.set({ privacyModeEnabled: getPrivacyModeEnabled() });
                } catch (error) {
                    console.error('Error saving privacy mode:', error);
                }
            }
        }

        function updatePrivacyButtonState() {
            const privacyBtn = document.getElementById('floatingPrivacyBtn');
            if (!privacyBtn) return;

            if (getPrivacyModeEnabled()) {
                privacyBtn.classList.add('active');
                privacyBtn.title = 'Privacy Blur ON - Click to disable';
            } else {
                privacyBtn.classList.remove('active');
                privacyBtn.title = 'Toggle Privacy Blur';
            }
        }

        async function togglePrivacyMode() {
            if (typeof canMutateAccountScopedPreferences === 'function' && !canMutateAccountScopedPreferences()) {
                updatePrivacyButtonState();
                applyPrivacyBlurToBoards();
                return false;
            }

            setPrivacyModeEnabled(!getPrivacyModeEnabled());
            await savePrivacyModeToStorage();
            updatePrivacyButtonState();
            applyPrivacyBlurToBoards();
            return true;
        }

        async function saveIncognitoModeToStorage() {
            if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                try {
                    await chrome.storage.local.set({ incognitoModeEnabled: getIncognitoModeEnabled() });
                } catch (error) {
                    console.error('Error saving incognito mode:', error);
                }
            }
        }

        async function loadIncognitoModeFromStorage(prefetchedStorage = null) {
            if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                try {
                    const result = prefetchedStorage && typeof prefetchedStorage === 'object'
                        ? prefetchedStorage
                        : await chrome.storage.local.get('incognitoModeEnabled');
                    setIncognitoModeEnabled(result.incognitoModeEnabled === true);
                    updateIncognitoButtonState();
                } catch (error) {
                    console.error('Error loading incognito mode:', error);
                }
            }
        }

        function updateIncognitoButtonState() {
            const incognitoBtn = document.getElementById('floatingIncognitoBtn');
            if (!incognitoBtn) return;

            if (getIncognitoModeEnabled()) {
                incognitoBtn.classList.add('active');
                incognitoBtn.title = 'Incognito Mode ON - Click to disable';
            } else {
                incognitoBtn.classList.remove('active');
                incognitoBtn.title = 'Open links in Incognito';
            }
        }

        async function toggleIncognitoMode() {
            if (typeof canMutateAccountScopedPreferences === 'function' && !canMutateAccountScopedPreferences()) {
                updateIncognitoButtonState();
                return false;
            }

            setIncognitoModeEnabled(!getIncognitoModeEnabled());
            await saveIncognitoModeToStorage();
            updateIncognitoButtonState();
            return true;
        }

        function handleIncognitoLinkClick(event) {
            if (!getIncognitoModeEnabled()) return;

            const link = event.target.closest('.board-links a');
            if (!link) return;
            if (getIsSelectionMode()) return;

            event.preventDefault();
            event.stopPropagation();

            const url = link.href;
            if (!url) return;

            if (typeof chrome !== 'undefined' && chrome.windows && chrome.windows.create) {
                chrome.windows.create({ url, incognito: true });
            } else {
                window.open(url, '_blank');
            }
        }

        function openMultipleUrls(urls) {
            if (!urls || urls.length === 0) return;

            if (getIncognitoModeEnabled() && chrome?.windows?.create) {
                chrome.windows.create({ url: urls, incognito: true });
            } else if (chrome?.tabs?.create) {
                urls.forEach((url) => chrome.tabs.create({ url, active: false }));
            } else {
                urls.forEach((url) => window.open(url, '_blank'));
            }
        }

        function initIncognitoLinkHandler() {
            if (incognitoHandlerInitialized) return;
            incognitoHandlerInitialized = true;

            const container = document.querySelector('.container');
            if (container) {
                container.addEventListener('click', handleIncognitoLinkClick, true);
            }
        }

        async function saveCompactModeToStorage() {
            if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                try {
                    await chrome.storage.local.set({ compactModeEnabled: getCompactModeEnabled() });
                } catch (error) {
                    console.error('Error saving compact mode:', error);
                }
            }
        }

        async function loadCompactModeFromStorage(prefetchedStorage = null) {
            if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                try {
                    const result = prefetchedStorage && typeof prefetchedStorage === 'object'
                        ? prefetchedStorage
                        : await chrome.storage.local.get('compactModeEnabled');
                    setCompactModeEnabled(result.compactModeEnabled === true);
                    applyCompactMode();
                    updateCompactModeToggle();
                } catch (error) {
                    console.error('Error loading compact mode:', error);
                }
            }
        }

        function applyCompactMode() {
            document.body.classList.toggle('compact-mode', getCompactModeEnabled());
        }

        function updateCompactModeToggle() {
            const toggle = document.getElementById('compactModeToggle');
            if (toggle) {
                toggle.checked = getCompactModeEnabled();
            }
        }

        async function toggleCompactMode() {
            if (typeof canMutateAccountScopedPreferences === 'function' && !canMutateAccountScopedPreferences()) {
                updateCompactModeToggle();
                applyCompactMode();
                return false;
            }

            setCompactModeEnabled(!getCompactModeEnabled());
            await saveCompactModeToStorage();
            applyCompactMode();
            updateCompactModeToggle();
            return true;
        }

        return {
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
        };
    };
})(window);
