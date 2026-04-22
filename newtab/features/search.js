(function registerLumiListSearchFeature(global) {
    const modules = global.LumiListModules || (global.LumiListModules = {});
    const features = modules.features || (modules.features = {});

    features.search = function createSearchFeature(options) {
        const {
            searchState,
            searchBehaviorStorageKey,
            searchBehaviorDecayWindowDays,
            searchAliasMap,
            searchScopeOptions,
            searchScopeValues,
            searchMatchModeOptions,
            searchMatchModeValues,
            searchDefaultOptions,
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
            getCurrentPageId,
            getIncognitoModeEnabled,
            getOpenLinksInNewTab,
            trackBookmarkVisit
        } = options;

        let searchFeatureInitialized = false;
        let searchOverlayMouseDownOutside = false;

        function normalizeSearchText(value) {
            if (value === null || value === undefined) return '';
            return String(value).toLowerCase().replace(/\s+/g, ' ').trim();
        }

        function uniqueTokens(tokens) {
            return [...new Set((tokens || []).filter(Boolean))];
        }

        function tokenizeSearchValue(value) {
            const normalized = normalizeSearchText(value).replace(/[^a-z0-9]+/g, ' ');
            if (!normalized) return [];
            return uniqueTokens(normalized.split(' ').filter(Boolean));
        }

        function getQueryTokens(value) {
            return tokenizeSearchValue(value);
        }

        function expandAliasTokens(tokens) {
            const expanded = [];
            for (const token of tokens || []) {
                const aliasExpansion = searchAliasMap[token];
                if (aliasExpansion && aliasExpansion.length > 0) {
                    expanded.push(...aliasExpansion);
                } else {
                    expanded.push(token);
                }
            }
            return uniqueTokens(expanded);
        }

        function normalizeSearchScope(value) {
            return searchScopeValues.includes(value) ? value : searchDefaultOptions.scope;
        }

        function normalizeSearchMatchMode(value) {
            return searchMatchModeValues.includes(value) ? value : searchDefaultOptions.matchMode;
        }

        function getSearchOptions(config = {}) {
            return {
                scope: normalizeSearchScope(config.scope !== undefined ? config.scope : searchState.scope),
                matchMode: normalizeSearchMatchMode(config.matchMode !== undefined ? config.matchMode : searchState.matchMode)
            };
        }

        function getScopedQueryTokens(rawTokens, config = searchDefaultOptions) {
            const searchOptions = getSearchOptions(config);
            if (searchOptions.matchMode === searchMatchModeOptions.STRICT) {
                return uniqueTokens(rawTokens || []);
            }
            return expandAliasTokens(rawTokens);
        }

        function getMaxTypoDistance(tokenLength) {
            if (tokenLength >= 9) return 2;
            if (tokenLength >= 5) return 1;
            return 0;
        }

        function isWithinLevenshteinDistance(a, b, maxDistance) {
            if (a === b) return true;

            const aLen = a.length;
            const bLen = b.length;
            if (Math.abs(aLen - bLen) > maxDistance) return false;

            let previousRow = new Array(bLen + 1);
            for (let j = 0; j <= bLen; j++) {
                previousRow[j] = j;
            }

            for (let i = 1; i <= aLen; i++) {
                const currentRow = new Array(bLen + 1);
                currentRow[0] = i;
                let rowMinimum = currentRow[0];

                for (let j = 1; j <= bLen; j++) {
                    const cost = a[i - 1] === b[j - 1] ? 0 : 1;
                    const deletion = previousRow[j] + 1;
                    const insertion = currentRow[j - 1] + 1;
                    const substitution = previousRow[j - 1] + cost;
                    const value = Math.min(deletion, insertion, substitution);
                    currentRow[j] = value;
                    if (value < rowMinimum) rowMinimum = value;
                }

                if (rowMinimum > maxDistance) return false;
                previousRow = currentRow;
            }

            return previousRow[bLen] <= maxDistance;
        }

        function tokenMatchesCandidate(queryToken, candidateToken, config = searchDefaultOptions) {
            if (!queryToken || !candidateToken) return false;
            const searchOptions = getSearchOptions(config);

            if (searchOptions.matchMode === searchMatchModeOptions.STRICT) {
                return candidateToken === queryToken;
            }

            if (candidateToken === queryToken) return true;
            if (candidateToken.includes(queryToken) || queryToken.includes(candidateToken)) return true;

            const minimumLength = Math.min(queryToken.length, candidateToken.length);
            const maxDistance = getMaxTypoDistance(minimumLength);
            if (maxDistance === 0) return false;
            if (Math.abs(queryToken.length - candidateToken.length) > maxDistance) return false;

            return isWithinLevenshteinDistance(queryToken, candidateToken, maxDistance);
        }

        function matchesAllTokens(queryTokens, candidateTokens, config = searchDefaultOptions) {
            if (!queryTokens || queryTokens.length === 0) return false;
            if (!candidateTokens || candidateTokens.length === 0) return false;
            return queryTokens.every((queryToken) =>
                candidateTokens.some((candidateToken) => tokenMatchesCandidate(queryToken, candidateToken, config))
            );
        }

        function getSearchHighlightTokens(query, config = searchDefaultOptions) {
            const searchOptions = getSearchOptions(config);
            const rawTokens = getQueryTokens(query);
            if (searchOptions.matchMode === searchMatchModeOptions.STRICT) {
                return uniqueTokens(rawTokens).filter((token) => token.length >= 2);
            }
            const aliasTokens = expandAliasTokens(rawTokens);
            return uniqueTokens([...rawTokens, ...aliasTokens]).filter((token) => token.length >= 2);
        }

        function levenshteinDistance(a, b) {
            if (a.length === 0) return b.length;
            if (b.length === 0) return a.length;
            const matrix = [];
            for (let i = 0; i <= b.length; i++) matrix[i] = [i];
            for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
            for (let i = 1; i <= b.length; i++) {
                for (let j = 1; j <= a.length; j++) {
                    if (b.charAt(i - 1) === a.charAt(j - 1)) {
                        matrix[i][j] = matrix[i - 1][j - 1];
                    } else {
                        matrix[i][j] = Math.min(
                            matrix[i - 1][j - 1] + 1,
                            matrix[i][j - 1] + 1,
                            matrix[i - 1][j] + 1
                        );
                    }
                }
            }
            return matrix[b.length][a.length];
        }

        function isFuzzyMatch(text, query) {
            if (!text || !query) return false;
            const normalizedText = text.toLowerCase();
            const normalizedQuery = query.toLowerCase();
            if (normalizedText.includes(normalizedQuery)) return true;
            if (normalizedQuery.length < 3) return false;
            const distance = levenshteinDistance(normalizedText, normalizedQuery);
            const threshold = normalizedQuery.length > 5 ? 2 : 1;
            return distance <= threshold;
        }

        function getSearchNoResultsMessage(query, config = searchDefaultOptions) {
            const searchOptions = getSearchOptions(config);
            const trimmedQuery = query.trim();
            if (searchOptions.scope === searchScopeOptions.BOARD) {
                return `No board names matched "${trimmedQuery}".`;
            }
            if (searchOptions.scope === searchScopeOptions.TITLE) {
                return `No bookmark titles matched "${trimmedQuery}".`;
            }
            if (searchOptions.scope === searchScopeOptions.URL) {
                return `No bookmark URLs matched "${trimmedQuery}".`;
            }
            if (searchOptions.scope === searchScopeOptions.NOTE) {
                return `No bookmark descriptions matched "${trimmedQuery}".`;
            }
            return `No boards or bookmarks matched "${trimmedQuery}".`;
        }

        function escapeRegExp(value) {
            return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }

        function renderHighlightedText(value, highlightTokens) {
            const source = value || '';
            if (!source) return '';

            const tokens = uniqueTokens(highlightTokens).filter((token) => token.length >= 2);
            if (tokens.length === 0) {
                return escapeHTML(source);
            }

            const sortedTokens = [...tokens].sort((a, b) => b.length - a.length);
            const regex = new RegExp(sortedTokens.map(escapeRegExp).join('|'), 'gi');

            let html = '';
            let lastIndex = 0;
            let match;

            while ((match = regex.exec(source)) !== null) {
                const matchStart = match.index;
                const matchText = match[0];
                html += escapeHTML(source.slice(lastIndex, matchStart));
                html += `<mark class="search-highlight">${escapeHTML(matchText)}</mark>`;
                lastIndex = matchStart + matchText.length;
            }

            html += escapeHTML(source.slice(lastIndex));
            return html;
        }

        function formatSearchUrlForDisplay(url) {
            if (!url) return '';
            try {
                const parsed = new URL(url);
                const base = `${parsed.hostname}${parsed.pathname}`.replace(/\/$/, '');
                const withQuery = parsed.search ? `${base}${parsed.search}` : base;
                return withQuery || parsed.hostname || url;
            } catch (_error) {
                return String(url);
            }
        }

        function loadSearchBehaviorState() {
            try {
                const raw = localStorage.getItem(searchBehaviorStorageKey);
                if (!raw) return;

                const parsed = JSON.parse(raw);
                searchState.behavior = {
                    boards: (parsed && typeof parsed.boards === 'object') ? parsed.boards : {},
                    bookmarks: (parsed && typeof parsed.bookmarks === 'object') ? parsed.bookmarks : {}
                };
            } catch (error) {
                console.warn('Failed to load search behavior state:', error);
                searchState.behavior = { boards: {}, bookmarks: {} };
            }
        }

        function persistSearchBehaviorState() {
            try {
                localStorage.setItem(searchBehaviorStorageKey, JSON.stringify(searchState.behavior));
            } catch (error) {
                console.warn('Failed to persist search behavior state:', error);
            }
        }

        function updateSearchBehaviorMetric(type, id) {
            if (!id) return;
            const target = (type === 'boards') ? searchState.behavior.boards : searchState.behavior.bookmarks;
            const existing = target[id] || { count: 0, lastOpened: 0 };
            target[id] = {
                count: Math.min((existing.count || 0) + 1, 100000),
                lastOpened: Date.now()
            };
            persistSearchBehaviorState();
        }

        function recordSearchBoardOpen(boardId) {
            updateSearchBehaviorMetric('boards', boardId);
        }

        function recordSearchBookmarkOpen(bookmarkId) {
            updateSearchBehaviorMetric('bookmarks', bookmarkId);
            if (typeof trackBookmarkVisit === 'function') {
                trackBookmarkVisit(bookmarkId);
            }
        }

        function getBehaviorMetricScore(metric, weight = 1) {
            if (!metric) return 0;
            const count = Math.max(0, metric.count || 0);
            const freqScore = Math.log2(1 + count) * 4;
            const ageInDays = Math.max(0, (Date.now() - (metric.lastOpened || 0)) / 86400000);
            const recencyRatio = Math.max(0, (searchBehaviorDecayWindowDays - ageInDays) / searchBehaviorDecayWindowDays);
            const recencyScore = recencyRatio * 3;
            return (freqScore + recencyScore) * weight;
        }

        function computeBehaviorScore(boardId, matchedBookmarks) {
            const boardScore = getBehaviorMetricScore(searchState.behavior.boards[boardId], 1.6);
            const bookmarkScores = (matchedBookmarks || [])
                .map((bookmark) => getBehaviorMetricScore(searchState.behavior.bookmarks[bookmark.id], 1))
                .filter((score) => score > 0)
                .sort((a, b) => b - a)
                .slice(0, 5);
            const bookmarkScore = bookmarkScores.reduce((sum, value) => sum + value, 0);
            return boardScore + bookmarkScore;
        }

        function clearSearchKeyboardItems() {
            if (searchState.keyboardItems.length > 0) {
                searchState.keyboardItems.forEach((item) => item.classList.remove('search-keyboard-active'));
            }
            searchState.keyboardItems = [];
            searchState.activeItemIndex = -1;
        }

        function setSearchActiveItem(index) {
            if (!searchState.keyboardItems.length) {
                searchState.activeItemIndex = -1;
                return;
            }

            searchState.keyboardItems.forEach((item) => item.classList.remove('search-keyboard-active'));

            if (index < 0 || index >= searchState.keyboardItems.length) {
                searchState.activeItemIndex = -1;
                return;
            }

            searchState.activeItemIndex = index;
            const activeItem = searchState.keyboardItems[index];
            activeItem.classList.add('search-keyboard-active');
            activeItem.scrollIntoView({ block: 'nearest' });
        }

        function rebuildSearchKeyboardItems() {
            const { overlay } = getSearchDomElements();
            clearSearchKeyboardItems();
            if (!overlay) return;
            searchState.keyboardItems = Array.from(overlay.querySelectorAll('.search-result-board-btn, .search-result-link'));
        }

        function moveSearchActiveSelection(direction) {
            const items = searchState.keyboardItems;
            if (!items || items.length === 0) return;

            if (searchState.activeItemIndex < 0) {
                const fallbackIndex = direction > 0 ? 0 : items.length - 1;
                setSearchActiveItem(fallbackIndex);
                return;
            }

            const nextIndex = (searchState.activeItemIndex + direction + items.length) % items.length;
            setSearchActiveItem(nextIndex);
        }

        function getSearchDomElements() {
            return {
                button: document.getElementById('floatingSearchBtn'),
                backdrop: document.getElementById('searchBackdrop'),
                overlay: document.getElementById('searchOverlay'),
                input: document.getElementById('searchInput'),
                scopeSelect: document.getElementById('searchScopeSelect'),
                scopeButtons: Array.from(document.querySelectorAll('.search-scope-chip')),
                strictToggle: document.getElementById('searchStrictToggle'),
                panel: document.getElementById('searchResultsPanel'),
                grid: document.getElementById('searchResultsGrid'),
                empty: document.getElementById('searchEmptyState')
            };
        }

        function isSearchOverlayOpen() {
            return searchState.isOpen === true;
        }

        function setSearchScopeButtonState(scopeButtons, scope) {
            const normalizedScope = normalizeSearchScope(scope);
            for (const button of scopeButtons || []) {
                const buttonScope = normalizeSearchScope(button.dataset.searchScope);
                const isActive = buttonScope === normalizedScope;
                button.classList.toggle('active', isActive);
                button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
            }
        }

        function getSearchScopeFromButtons(scopeButtons) {
            const activeButton = (scopeButtons || []).find((button) => button.classList.contains('active'));
            if (!activeButton) return null;
            return normalizeSearchScope(activeButton.dataset.searchScope);
        }

        function applySearchOptionsToControls(config = searchDefaultOptions) {
            const normalized = getSearchOptions(config);
            searchState.scope = normalized.scope;
            searchState.matchMode = normalized.matchMode;

            const { scopeSelect, scopeButtons, strictToggle } = getSearchDomElements();
            if (scopeSelect) {
                scopeSelect.value = normalized.scope;
            }
            setSearchScopeButtonState(scopeButtons, normalized.scope);
            if (strictToggle) {
                strictToggle.checked = normalized.matchMode === searchMatchModeOptions.STRICT;
            }
            return normalized;
        }

        function getSearchOptionsFromControls() {
            const { scopeSelect, scopeButtons, strictToggle } = getSearchDomElements();
            const scopeFromButtons = getSearchScopeFromButtons(scopeButtons);
            return getSearchOptions({
                scope: scopeSelect ? scopeSelect.value : (scopeFromButtons || searchState.scope),
                matchMode: strictToggle && strictToggle.checked
                    ? searchMatchModeOptions.STRICT
                    : searchMatchModeOptions.SMART
            });
        }

        function syncSearchStateFromControls() {
            const searchOptions = getSearchOptionsFromControls();
            searchState.scope = searchOptions.scope;
            searchState.matchMode = searchOptions.matchMode;
            return searchOptions;
        }

        function resetSearchControlsToDefaults() {
            return applySearchOptionsToControls(searchDefaultOptions);
        }

        function runSearchForCurrentInput() {
            const { input } = getSearchDomElements();
            const searchOptions = syncSearchStateFromControls();
            const query = input ? input.value.trim() : searchState.query;
            searchState.query = query;

            if (!query) {
                renderSearchResults([], '', searchOptions);
                return;
            }

            const results = performSearch(query, searchOptions);
            renderSearchResults(results, query, searchOptions);
        }

        function closeSearchOverlay(config = {}) {
            const { clearQuery = true, restoreFocus = true } = config;
            const { button, backdrop, overlay, input, panel, grid, empty } = getSearchDomElements();
            if (!overlay) return;

            const activeElement = document.activeElement;
            const focusWasInsideSearch = !!activeElement && (
                activeElement === input ||
                overlay.contains(activeElement) ||
                (backdrop && backdrop.contains(activeElement))
            );

            overlay.classList.remove('active');
            overlay.classList.remove('with-results');
            if (backdrop) {
                backdrop.classList.remove('active');
            }
            if (button) {
                button.classList.remove('active');
            }

            searchState.isOpen = false;
            clearSearchKeyboardItems();

            if (restoreFocus && focusWasInsideSearch) {
                if (button && typeof button.focus === 'function') {
                    button.focus({ preventScroll: true });
                } else if (activeElement && typeof activeElement.blur === 'function') {
                    activeElement.blur();
                }
            }

            if (!clearQuery) return;

            searchState.query = '';
            if (input) input.value = '';
            if (panel) panel.classList.add('hidden');
            if (grid) grid.innerHTML = '';
            if (empty) {
                empty.classList.add('hidden');
                empty.textContent = 'No results found.';
            }
        }

        async function rebuildSearchDataset() {
            try {
                const [pages, boards, bookmarks] = await Promise.all([
                    db.pages.filter((page) => !page.deletedAt).sortBy('order'),
                    db.boards.filter((board) => !board.deletedAt).toArray(),
                    db.bookmarks.filter((bookmark) => !bookmark.deletedAt).toArray()
                ]);

                const pageMap = new Map();
                pages.forEach((page, index) => {
                    pageMap.set(page.id, {
                        id: page.id,
                        name: page.name || 'Untitled Page',
                        order: safeParseInt(page.order, index)
                    });
                });

                const bookmarksByBoard = new Map();
                for (const bookmark of bookmarks) {
                    const boardBookmarks = bookmarksByBoard.get(bookmark.boardId) || [];
                    const description = sanitizeBookmarkNote(bookmark.description) || '';
                    boardBookmarks.push({
                        id: bookmark.id,
                        title: bookmark.title || 'Untitled',
                        titleNorm: normalizeSearchText(bookmark.title || ''),
                        titleTokens: tokenizeSearchValue(bookmark.title || ''),
                        url: bookmark.url || '',
                        urlNorm: normalizeSearchText(bookmark.url || ''),
                        urlTokens: tokenizeSearchValue(bookmark.url || ''),
                        description: description,
                        descriptionNorm: normalizeSearchText(description),
                        descriptionTokens: tokenizeSearchValue(description),
                        tags: bookmark.tags || '',
                        tagsNorm: normalizeSearchText(bookmark.tags || ''),
                        tagsTokens: tokenizeSearchValue(bookmark.tags || ''),
                        urlDisplay: formatSearchUrlForDisplay(bookmark.url || ''),
                        tokens: [],
                        order: safeParseInt(bookmark.order, 0)
                    });
                    bookmarksByBoard.set(bookmark.boardId, boardBookmarks);
                }

                for (const boardBookmarks of bookmarksByBoard.values()) {
                    boardBookmarks.sort((a, b) => a.order - b.order);
                    for (const bookmark of boardBookmarks) {
                        bookmark.tokens = uniqueTokens([
                            ...bookmark.titleTokens,
                            ...bookmark.urlTokens,
                            ...bookmark.descriptionTokens,
                            ...bookmark.tagsTokens
                        ]);
                    }
                }

                const dataset = boards
                    .map((board) => {
                        const page = pageMap.get(board.pageId);
                        if (!page) return null;

                        return {
                            pageId: page.id,
                            pageName: page.name,
                            pageOrder: page.order,
                            boardId: board.id,
                            boardName: board.name || 'Untitled Board',
                            boardNameNorm: normalizeSearchText(board.name || ''),
                            boardTokens: tokenizeSearchValue(board.name || ''),
                            boardColumnIndex: safeParseInt(board.columnIndex, 0),
                            boardOrder: safeParseInt(board.order, 0),
                            bookmarks: bookmarksByBoard.get(board.id) || []
                        };
                    })
                    .filter(Boolean);

                dataset.sort((a, b) => {
                    if (a.pageOrder !== b.pageOrder) return a.pageOrder - b.pageOrder;
                    if (a.boardColumnIndex !== b.boardColumnIndex) return a.boardColumnIndex - b.boardColumnIndex;
                    return a.boardOrder - b.boardOrder;
                });

                searchState.dataset = dataset;
                return dataset;
            } catch (error) {
                console.error('Failed to rebuild search dataset:', error);
                searchState.dataset = [];
                return [];
            }
        }

        function performSearch(query, config = searchDefaultOptions) {
            const searchOptions = getSearchOptions(config);
            const rawTokens = getQueryTokens(query);
            if (rawTokens.length === 0) return [];

            const queryTokens = getScopedQueryTokens(rawTokens, searchOptions);
            const normalizedQuery = normalizeSearchText(query);
            const includeBoardName = searchOptions.scope === searchScopeOptions.ALL || searchOptions.scope === searchScopeOptions.BOARD;
            const includeTitle = searchOptions.scope === searchScopeOptions.ALL || searchOptions.scope === searchScopeOptions.TITLE;
            const includeUrl = searchOptions.scope === searchScopeOptions.ALL || searchOptions.scope === searchScopeOptions.URL;
            const includeNote = searchOptions.scope === searchScopeOptions.ALL || searchOptions.scope === searchScopeOptions.NOTE;
            const includeTags = window.advancedSearchEnabled && (searchOptions.scope === searchScopeOptions.ALL || searchOptions.scope === 'tags');
            
            const results = [];

            for (const boardEntry of searchState.dataset) {
                const boardNamePhraseMatch = includeBoardName && (boardEntry.boardNameNorm.includes(normalizedQuery) || (window.fuzzySearchEnabled && isFuzzyMatch(boardEntry.boardNameNorm, normalizedQuery)));
                const boardNameTokenMatch = includeBoardName && matchesAllTokens(queryTokens, boardEntry.boardTokens, searchOptions);
                const boardNameMatch = boardNamePhraseMatch || boardNameTokenMatch;

                const bookmarkMatches = [];
                let bookmarkPhraseMatchCount = 0;
                for (const bookmark of boardEntry.bookmarks) {
                    const titlePhraseMatch = includeTitle && (bookmark.titleNorm.includes(normalizedQuery) || (window.fuzzySearchEnabled && isFuzzyMatch(bookmark.titleNorm, normalizedQuery)));
                    const urlPhraseMatch = includeUrl && (bookmark.urlNorm.includes(normalizedQuery) || (window.fuzzySearchEnabled && isFuzzyMatch(bookmark.urlNorm, normalizedQuery)));
                    const descriptionPhraseMatch = includeNote && (bookmark.descriptionNorm.includes(normalizedQuery) || (window.fuzzySearchEnabled && isFuzzyMatch(bookmark.descriptionNorm, normalizedQuery)));
                    const tagsPhraseMatch = includeTags && (bookmark.tagsNorm.includes(normalizedQuery) || (window.fuzzySearchEnabled && isFuzzyMatch(bookmark.tagsNorm, normalizedQuery)));

                    const titleTokenMatch = includeTitle && matchesAllTokens(queryTokens, bookmark.titleTokens, searchOptions);
                    const urlTokenMatch = includeUrl && matchesAllTokens(queryTokens, bookmark.urlTokens, searchOptions);
                    const descriptionTokenMatch = includeNote && matchesAllTokens(queryTokens, bookmark.descriptionTokens, searchOptions);
                    const tagsTokenMatch = includeTags && matchesAllTokens(queryTokens, bookmark.tagsTokens, searchOptions);

                    const titleMatched = titlePhraseMatch || titleTokenMatch;
                    const urlMatched = urlPhraseMatch || urlTokenMatch;
                    const descriptionMatched = descriptionPhraseMatch || descriptionTokenMatch;
                    const tagsMatched = tagsPhraseMatch || tagsTokenMatch;

                    if (!titleMatched && !urlMatched && !descriptionMatched && !tagsMatched) continue;

                    bookmarkMatches.push({
                        ...bookmark,
                        titleMatched,
                        urlMatched,
                        descriptionMatched,
                        tagsMatched
                    });

                    if (titlePhraseMatch || urlPhraseMatch || descriptionPhraseMatch || tagsPhraseMatch) {
                        bookmarkPhraseMatchCount += 1;
                    }
                }

                if (!boardNameMatch && bookmarkMatches.length === 0) continue;

                const bookmarksToShow = (bookmarkMatches.length > 0)
                    ? bookmarkMatches
                    : (boardNameMatch ? boardEntry.bookmarks : []);

                results.push({
                    ...boardEntry,
                    boardNameMatch,
                    boardNamePhraseMatch,
                    bookmarkMatchCount: bookmarkMatches.length,
                    bookmarkPhraseMatchCount,
                    behaviorScore: computeBehaviorScore(boardEntry.boardId, bookmarksToShow),
                    matchedBookmarks: bookmarksToShow
                });
            }

            results.sort((a, b) => {
                if (a.bookmarkPhraseMatchCount !== b.bookmarkPhraseMatchCount) {
                    return b.bookmarkPhraseMatchCount - a.bookmarkPhraseMatchCount;
                }
                const aHasBookmarkMatches = a.bookmarkMatchCount > 0 ? 1 : 0;
                const bHasBookmarkMatches = b.bookmarkMatchCount > 0 ? 1 : 0;

                if (aHasBookmarkMatches !== bHasBookmarkMatches) {
                    return bHasBookmarkMatches - aHasBookmarkMatches;
                }
                if (a.bookmarkMatchCount !== b.bookmarkMatchCount) {
                    return b.bookmarkMatchCount - a.bookmarkMatchCount;
                }
                if (a.boardNamePhraseMatch !== b.boardNamePhraseMatch) {
                    return a.boardNamePhraseMatch ? -1 : 1;
                }
                if (a.behaviorScore !== b.behaviorScore) {
                    return b.behaviorScore - a.behaviorScore;
                }
                if (a.pageOrder !== b.pageOrder) {
                    return a.pageOrder - b.pageOrder;
                }
                if (a.boardColumnIndex !== b.boardColumnIndex) {
                    return a.boardColumnIndex - b.boardColumnIndex;
                }
                if (a.boardOrder !== b.boardOrder) {
                    return a.boardOrder - b.boardOrder;
                }
                return a.boardName.localeCompare(b.boardName);
            });

            return results;
        }

        function renderSearchResults(results, query, config = searchDefaultOptions) {
            const { overlay, panel, grid, empty } = getSearchDomElements();
            if (!overlay || !panel || !grid || !empty) return;

            const queryTokens = getQueryTokens(query);
            if (queryTokens.length === 0) {
                panel.classList.add('hidden');
                overlay.classList.remove('with-results');
                grid.innerHTML = '';
                empty.classList.add('hidden');
                empty.textContent = 'No results found.';
                clearSearchKeyboardItems();
                return;
            }

            panel.classList.remove('hidden');
            overlay.classList.add('with-results');

            const highlightTokens = getSearchHighlightTokens(query, config);
            const targetAttr = getOpenLinksInNewTab() ? ' target="_blank" rel="noopener noreferrer"' : '';
            const googleSearchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;

            const googleSearchHTML = `
                <div class="search-result-card external-search-card">
                    <ul class="search-result-links">
                        <li>
                            <a class="search-result-link external-search-link" href="${googleSearchUrl}" ${targetAttr}>
                                <span class="favicon external-search-favicon">
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                        <circle cx="11" cy="11" r="8"></circle>
                                        <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                                    </svg>
                                </span>
                                <span class="search-result-link-text">
                                    <span class="search-result-link-title">Search Google for "${escapeHTML(query)}"</span>
                                </span>
                            </a>
                        </li>
                    </ul>
                </div>
            `;

            if (!results || results.length === 0) {
                grid.innerHTML = googleSearchHTML;
                empty.textContent = getSearchNoResultsMessage(query, config);
                empty.classList.remove('hidden');
                rebuildSearchKeyboardItems();
                return;
            }

            empty.classList.add('hidden');
            empty.textContent = 'No results found.';

            const cardsHTML = results.map((result) => {
                const linksHTML = result.matchedBookmarks
                    .map((bookmark) => {
                        const safeUrl = sanitizeUrl(bookmark.url);
                        if (!safeUrl) return '';
                        const escapedUrl = escapeHTML(safeUrl);
                        const linkTitle = bookmark.title || bookmark.urlDisplay || bookmark.url || 'Untitled';
                        const highlightedTitle = renderHighlightedText(linkTitle, highlightTokens);
                        const showUrlRow = bookmark.url && bookmark.urlMatched && !bookmark.titleMatched;
                        const urlRow = showUrlRow
                            ? `<span class="search-result-link-url">${renderHighlightedText(bookmark.urlDisplay || bookmark.url, highlightTokens)}</span>`
                            : '';
                        const showNoteRow = bookmark.description && bookmark.descriptionMatched;
                        const noteRow = showNoteRow
                            ? `<span class="search-result-link-note">${renderHighlightedText(bookmark.description, highlightTokens)}</span>`
                            : '';
                        const showTagsRow = bookmark.tags && bookmark.tagsMatched;
                        const tagsRow = showTagsRow
                            ? `<span class="search-result-link-tags">${renderHighlightedText(bookmark.tags, highlightTokens)}</span>`
                            : '';

                        return `<li>
                    <a class="search-result-link" href="${escapedUrl}" data-url="${escapedUrl}" data-bookmark-id="${escapeHTML(bookmark.id)}" data-board-id="${escapeHTML(result.boardId)}" data-page-id="${escapeHTML(result.pageId)}" ${targetAttr}>
                        <span class="favicon" data-url="${escapedUrl}" data-title="${escapeHTML(linkTitle)}"></span>
                        <span class="search-result-link-text">
                            <span class="search-result-link-title">${highlightedTitle}</span>
                            ${urlRow}
                            ${noteRow}
                            ${tagsRow}
                        </span>
                    </a>
                </li>`;
                    })
                    .join('');

                const linksOrEmpty = linksHTML || '<li class="search-result-empty-row">No links in this board.</li>';

                return `<div class="search-result-card">
            <div class="search-result-header">
                <button class="search-result-board-btn" type="button" data-board-id="${escapeHTML(result.boardId)}" data-page-id="${escapeHTML(result.pageId)}">${renderHighlightedText(result.boardName, highlightTokens)}</button>
                <span class="search-result-page-badge" title="${escapeHTML(result.pageName)}">${escapeHTML(result.pageName)}</span>
            </div>
            <ul class="search-result-links">${linksOrEmpty}</ul>
        </div>`;
            }).join('');

            grid.innerHTML = googleSearchHTML + cardsHTML;
            initializeNewFavicons();
            rebuildSearchKeyboardItems();
        }

        function openUrlFromSearch(url) {
            if (!url) return;

            if (getIncognitoModeEnabled() && chrome?.windows?.create) {
                chrome.windows.create({ url, incognito: true });
                return;
            }

            if (getOpenLinksInNewTab()) {
                if (chrome?.tabs?.create) {
                    chrome.tabs.create({ url, active: false });
                } else {
                    window.open(url, '_blank', 'noopener,noreferrer');
                }
                return;
            }

            window.location.href = url;
        }

        async function activateSearchKeyboardSelection(config = {}) {
            const { forceBoardOpen = false } = config;
            if (!searchState.keyboardItems || searchState.keyboardItems.length === 0) {
                const query = searchState.query;
                if (query && query.trim()) {
                    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query.trim())}`;
                    openUrlFromSearch(searchUrl);
                    closeSearchOverlay();
                }
                return;
            }

            const currentIndex = searchState.activeItemIndex >= 0 ? searchState.activeItemIndex : 0;
            let targetItem = searchState.keyboardItems[currentIndex];
            if (!targetItem) return;

            if (forceBoardOpen && targetItem.classList.contains('search-result-link')) {
                const boardButton = targetItem.closest('.search-result-card')?.querySelector('.search-result-board-btn');
                if (boardButton) {
                    targetItem = boardButton;
                }
            }

            if (targetItem.classList.contains('search-result-board-btn')) {
                const boardId = targetItem.dataset.boardId;
                const pageId = targetItem.dataset.pageId;
                if (!boardId || !pageId) return;
                recordSearchBoardOpen(boardId);
                await jumpToBoardFromSearch(boardId, pageId);
                return;
            }

            if (targetItem.classList.contains('search-result-link')) {
                const url = targetItem.getAttribute('href');
                if (!url) return;

                const bookmarkId = targetItem.dataset.bookmarkId;
                const boardId = targetItem.dataset.boardId;
                if (bookmarkId) recordSearchBookmarkOpen(bookmarkId);
                if (boardId) recordSearchBoardOpen(boardId);
                openUrlFromSearch(url);
            }
        }

        async function jumpToBoardFromSearch(boardId, pageId) {
            if (!boardId || !pageId) return;

            closeSearchOverlay();

            try {
                if (getCurrentPageId() !== pageId) {
                    await switchToPage(pageId);
                }

                let boardElement = document.querySelector(`.board[data-board-id="${boardId}"]`);
                if (!boardElement) {
                    await loadBoardsFromDatabase();
                    boardElement = document.querySelector(`.board[data-board-id="${boardId}"]`);
                }

                if (!boardElement) return;

                boardElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
                boardElement.classList.remove('search-jump-highlight');
                void boardElement.offsetWidth;
                boardElement.classList.add('search-jump-highlight');
                setTimeout(() => {
                    boardElement.classList.remove('search-jump-highlight');
                }, 1400);
            } catch (error) {
                console.error('Failed to jump to board from search:', error);
            }
        }

        async function openSearchOverlay() {
            const { button, backdrop, overlay, input } = getSearchDomElements();
            if (!overlay || !input) return;

            if (document.body.classList.contains('not-authenticated') || document.body.classList.contains('subscription-expired')) {
                return;
            }

            searchState.isOpen = true;
            overlay.classList.add('active');
            if (backdrop) {
                backdrop.classList.add('active');
            }
            if (button) {
                button.classList.add('active');
            }

            closeImportPopup();
            closeTabContextMenu();
            closeBoardMenus();

            await rebuildSearchDataset();
            resetSearchControlsToDefaults();
            runSearchForCurrentInput();

            input.focus();
        }

        async function toggleSearchOverlay() {
            if (isSearchOverlayOpen()) {
                closeSearchOverlay();
                return;
            }
            await openSearchOverlay();
        }

        async function refreshSearchIfOpen() {
            if (!isSearchOverlayOpen()) return;

            await rebuildSearchDataset();
            runSearchForCurrentInput();
        }

        function initSearchFeature() {
            if (searchFeatureInitialized) return;
            searchFeatureInitialized = true;
            loadSearchBehaviorState();

            const { button, backdrop, overlay, input, scopeSelect, scopeButtons, strictToggle } = getSearchDomElements();
            if (!button || !overlay || !input) return;

            button.addEventListener('click', async (event) => {
                event.stopPropagation();
                await toggleSearchOverlay();
            });

            input.addEventListener('input', () => {
                runSearchForCurrentInput();
            });

            if (scopeSelect) {
                scopeSelect.addEventListener('change', () => {
                    runSearchForCurrentInput();
                });
            }

            if (scopeButtons && scopeButtons.length > 0) {
                scopeButtons.forEach((buttonEl) => {
                    buttonEl.addEventListener('click', () => {
                        const selectedScope = normalizeSearchScope(buttonEl.dataset.searchScope);
                        applySearchOptionsToControls({
                            scope: selectedScope,
                            matchMode: searchState.matchMode
                        });
                        runSearchForCurrentInput();
                    });
                });
            }

            if (strictToggle) {
                strictToggle.addEventListener('change', () => {
                    runSearchForCurrentInput();
                });
            }

            overlay.addEventListener('click', async (event) => {
                const boardButton = event.target.closest('.search-result-board-btn');
                if (boardButton) {
                    const boardId = boardButton.dataset.boardId;
                    const pageId = boardButton.dataset.pageId;
                    if (boardId) recordSearchBoardOpen(boardId);
                    await jumpToBoardFromSearch(boardId, pageId);
                    return;
                }

                const resultLink = event.target.closest('.search-result-link');
                if (!resultLink) return;

                const bookmarkId = resultLink.dataset.bookmarkId;
                const boardId = resultLink.dataset.boardId;
                if (bookmarkId) recordSearchBookmarkOpen(bookmarkId);
                if (boardId) recordSearchBoardOpen(boardId);

                if (!getIncognitoModeEnabled()) return;

                event.preventDefault();
                event.stopPropagation();
                const url = resultLink.getAttribute('href');
                if (!url) return;
                openUrlFromSearch(url);
            });

            if (backdrop) {
                backdrop.addEventListener('click', () => {
                    closeSearchOverlay();
                });
            }

            document.addEventListener('keydown', async (event) => {
                const isSearchShortcut = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k';
                if (isSearchShortcut) {
                    event.preventDefault();
                    await toggleSearchOverlay();
                    if (isSearchOverlayOpen()) {
                        input.focus();
                        input.select();
                    }
                    return;
                }

                if (!isSearchOverlayOpen()) return;

                const activeElement = document.activeElement;
                const focusOnSearchControls = !!activeElement && (
                    activeElement === scopeSelect ||
                    activeElement === strictToggle ||
                    !!activeElement.closest?.('.search-filters-row')
                );

                if (event.key === 'ArrowDown') {
                    if (focusOnSearchControls) return;
                    event.preventDefault();
                    moveSearchActiveSelection(1);
                    return;
                }

                if (event.key === 'ArrowUp') {
                    if (focusOnSearchControls) return;
                    event.preventDefault();
                    moveSearchActiveSelection(-1);
                    return;
                }

                if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey && !event.altKey) {
                    if (focusOnSearchControls) return;
                    const focusInsideSearch = activeElement === input || overlay.contains(activeElement);
                    if (!focusInsideSearch) return;

                    event.preventDefault();
                    await activateSearchKeyboardSelection({ forceBoardOpen: event.shiftKey });
                }
            });

            document.addEventListener('mousedown', (event) => {
                if (!isSearchOverlayOpen()) return;

                const clickOutside = !overlay.contains(event.target) && !button.contains(event.target);
                searchOverlayMouseDownOutside = clickOutside;
            });

            document.addEventListener('mouseup', (event) => {
                if (!isSearchOverlayOpen()) {
                    searchOverlayMouseDownOutside = false;
                    return;
                }

                const mouseUpOutside = !overlay.contains(event.target) && !button.contains(event.target);
                if (searchOverlayMouseDownOutside && mouseUpOutside) {
                    closeSearchOverlay();
                }
                searchOverlayMouseDownOutside = false;
            });
        }

        return {
            closeSearchOverlay,
            refreshSearchIfOpen,
            initSearchFeature,
            isSearchOverlayOpen,
            openSearchOverlay,
            toggleSearchOverlay,
            rebuildSearchDataset,
            performSearch,
            renderSearchResults
        };
    };
})(window);
