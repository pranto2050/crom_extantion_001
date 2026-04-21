function isPrivateOrLocalHostname(hostname) {
    const blockedPatterns = [
        /^localhost$/i,
        /^127\./,
        /^10\./,
        /^172\.(1[6-9]|2[0-9]|3[01])\./,
        /^192\.168\./,
        /^169\.254\./,  // AWS metadata endpoint
        /^0\./,
        /^\[::1\]$/,    // IPv6 localhost
        /^\[fe80:/i,    // IPv6 link-local
        /^\[fc/i,       // IPv6 unique local
        /^\[fd/i        // IPv6 unique local
    ];
    return blockedPatterns.some(p => p.test(hostname));
}

function extractLinkAttribute(tag, attribute) {
    const attrRegex = new RegExp(attribute + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s"\'`=<>]+))', 'i');
    const match = tag.match(attrRegex);
    return (match && (match[1] || match[2] || match[3]) || '').trim();
}

const HTML_NAMED_ENTITIES = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    ndash: '–',
    mdash: '—',
    hellip: '…',
    copy: '©',
    reg: '®',
    trade: '™'
};

function decodeHtmlEntities(value) {
    if (!value || typeof value !== 'string') return '';

    return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]+);/g, (fullMatch, entity) => {
        if (!entity) return fullMatch;

        if (entity[0] === '#') {
            const isHex = entity[1] === 'x' || entity[1] === 'X';
            const codePointString = entity.slice(isHex ? 2 : 1);
            const codePoint = parseInt(codePointString, isHex ? 16 : 10);

            if (!Number.isFinite(codePoint)) return fullMatch;
            if (codePoint < 0 || codePoint > 0x10FFFF) return fullMatch;
            if (codePoint >= 0xD800 && codePoint <= 0xDFFF) return fullMatch;

            try {
                return String.fromCodePoint(codePoint);
            } catch (_) {
                return fullMatch;
            }
        }

        const normalized = entity.toLowerCase();
        return Object.prototype.hasOwnProperty.call(HTML_NAMED_ENTITIES, normalized)
            ? HTML_NAMED_ENTITIES[normalized]
            : fullMatch;
    });
}

function decodeHtmlEntitiesSafely(value, maxPasses = 3) {
    if (!value || typeof value !== 'string') return '';

    let decoded = value;
    for (let pass = 0; pass < maxPasses; pass++) {
        const next = decodeHtmlEntities(decoded);
        if (next === decoded) break;
        decoded = next;
    }
    return decoded;
}

function normalizeFetchedTitle(value) {
    if (!value || typeof value !== 'string') return '';
    return decodeHtmlEntitiesSafely(value)
        .replace(/\s+/g, ' ')
        .trim();
}

function decodeHtmlAttributeValue(value) {
    if (!value) return '';
    return decodeHtmlEntitiesSafely(value);
}

// Extract favicon candidates declared in HTML via <link rel="icon" href="...">
// Returns an ordered list of absolute icon URLs, limited to 5 candidates.
async function fetchFaviconLinksFromPage(url, options = {}) {
    if (!url || typeof url !== 'string') {
        throw new Error('Invalid URL: must be a non-empty string');
    }

    const pageUrl = new URL(url);
    if (!['http:', 'https:'].includes(pageUrl.protocol)) {
        throw new Error('Invalid protocol: only http and https allowed');
    }

    if (isPrivateOrLocalHostname(pageUrl.hostname.toLowerCase())) {
        throw new Error('Favicon link lookup blocked: private/internal address');
    }

    const timeoutMs = Math.max(1000, Math.min(Number(options?.timeoutMs) || 7000, 15000));
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(pageUrl.href, {
            method: 'GET',
            signal: controller.signal,
            headers: {
                'Accept': 'text/html,application/xhtml+xml'
            }
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
            throw new Error(`Fetch failed with status ${response.status}`);
        }

        const contentType = (response.headers.get('content-type') || '').toLowerCase();
        if (contentType && !contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
            return [];
        }

        // Read only initial bytes (icons are almost always declared in <head>)
        let html = '';
        if (response.body && typeof response.body.getReader === 'function') {
            const reader = response.body.getReader();
            const decoder = new TextDecoder('utf-8');
            let bytesRead = 0;
            const maxBytes = 150000;

            while (bytesRead < maxBytes) {
                const { done, value } = await reader.read();
                if (done) break;
                html += decoder.decode(value, { stream: true });
                bytesRead += value.length;

                if (html.includes('</head>') || html.includes('</HEAD>')) break;
            }
            reader.cancel();
        } else {
            html = (await response.text()).slice(0, 150000);
        }

        const finalPageUrl = response.url || pageUrl.href;
        const linkTags = html.match(/<link\b[^>]*>/gi) || [];
        const candidates = [];

        for (const tag of linkTags) {
            const rel = extractLinkAttribute(tag, 'rel').toLowerCase();
            if (!rel) continue;

            const relTokens = rel.split(/\s+/).filter(Boolean);
            if (!relTokens.includes('icon')) continue;

            const rawHref = decodeHtmlAttributeValue(extractLinkAttribute(tag, 'href'));
            if (!rawHref) continue;

            let resolved;
            try {
                resolved = new URL(rawHref, finalPageUrl).href;
            } catch (e) {
                continue;
            }

            try {
                const resolvedUrl = new URL(resolved);
                if (!['http:', 'https:'].includes(resolvedUrl.protocol)) continue;
                if (isPrivateOrLocalHostname(resolvedUrl.hostname.toLowerCase())) continue;
            } catch (e) {
                continue;
            }

            candidates.push(resolved);
            if (candidates.length >= 8) break;
        }

        return [...new Set(candidates)].slice(0, 5);
    } catch (error) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') {
            throw new Error('Favicon link lookup timed out');
        }
        throw error;
    }
}

function titleFromSlug(slug) {
    if (!slug || typeof slug !== 'string') return '';

    let decoded = slug;
    try {
        decoded = decodeURIComponent(slug);
    } catch (_) {
        // Keep original slug if decode fails.
    }

    const normalized = decoded
        .replace(/[-_]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (!normalized) return '';

    return normalized.replace(/\b\w/g, c => c.toUpperCase());
}

function extractFirstHttpUrl(text) {
    if (!text || typeof text !== 'string') return '';
    const match = text.match(/https?:\/\/[^\s<>"')\]]+/i);
    return match && match[0] ? match[0].trim() : '';
}

function normalizeTitleFetchUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '';

    const trimmed = rawUrl.trim();
    if (!trimmed) return '';

    // Markdown link format: [label](https://example.com)
    const markdownMatch = trimmed.match(/\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/i);
    if (markdownMatch && markdownMatch[1]) {
        return markdownMatch[1].trim();
    }

    // Common paste artifact: https://a.com](https://a.com
    const artifactIndex = trimmed.indexOf('](');
    if (artifactIndex > 0) {
        return trimmed.slice(0, artifactIndex).trim();
    }

    // If mixed text contains a URL, extract the first URL-like token.
    const embeddedUrl = extractFirstHttpUrl(trimmed);
    if (embeddedUrl) return embeddedUrl;

    return trimmed;
}

function parseChromeWebStorePath(urlObj) {
    if (!urlObj || !urlObj.hostname) return null;
    if (urlObj.hostname.toLowerCase() !== 'chromewebstore.google.com') return null;

    const segments = (urlObj.pathname || '')
        .split('/')
        .filter(Boolean);

    if ((segments[0] || '').toLowerCase() !== 'detail') return null;

    return {
        slug: segments[1] || '',
        extensionId: segments[2] || '',
        section: segments[3] || ''
    };
}

function isGenericChromeWebStoreTitle(title) {
    const normalized = normalizeFetchedTitle(title).toLowerCase();
    return normalized === '' || normalized === 'chrome web store';
}

function getKnownCorsSafeTitle(urlObj) {
    if (!urlObj || !urlObj.hostname) return '';

    const host = urlObj.hostname.toLowerCase();

    // Chrome Web Store can block extension-origin fetches in some contexts.
    // Keep a readable fallback title based on URL slug.
    if (host === 'chromewebstore.google.com') {
        const parsed = parseChromeWebStorePath(urlObj);
        const baseTitle = titleFromSlug(parsed?.slug || '');
        const section = (parsed?.section || '').toLowerCase();

        if (section === 'reviews' && baseTitle) {
            return `Reviews: ${baseTitle}`;
        }

        return baseTitle || 'Chrome Web Store';
    }

    return '';
}

async function queryTabsAsync(queryInfo) {
    return new Promise((resolve, reject) => {
        chrome.tabs.query(queryInfo, (tabs) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }
            resolve(tabs || []);
        });
    });
}

function removeTabSilently(tabId) {
    if (typeof tabId !== 'number') return;
    chrome.tabs.remove(tabId, () => {
        // Ignore close errors (tab may already be closed).
    });
}

async function getChromeWebStoreTitleFromOpenTabs(urlObj) {
    const parsedTarget = parseChromeWebStorePath(urlObj);
    if (!parsedTarget || !parsedTarget.extensionId) return '';

    try {
        const tabs = await queryTabsAsync({ url: '*://chromewebstore.google.com/detail/*' });
        for (const tab of tabs) {
            if (!tab || typeof tab.url !== 'string') continue;

            let parsedTabUrl;
            try {
                parsedTabUrl = new URL(tab.url);
            } catch (_) {
                continue;
            }

            const parsedTab = parseChromeWebStorePath(parsedTabUrl);
            if (!parsedTab || parsedTab.extensionId !== parsedTarget.extensionId) continue;

            const tabTitle = normalizeFetchedTitle(tab.title || '');
            if (!tabTitle) continue;
            if (isGenericChromeWebStoreTitle(tabTitle)) continue;
            return tabTitle;
        }
    } catch (error) {
        console.warn('[FetchTitle] Open tab lookup failed for Chrome Web Store:', error?.message || error);
    }

    return '';
}

async function getChromeWebStoreTitleFromBackgroundTab(url, options = {}) {
    // Keep this below newtab.js fetchPageTitleFromBackground() timeout (10s).
    const timeoutMs = Math.max(2500, Math.min(Number(options?.timeoutMs) || 7000, 9000));

    return new Promise((resolve) => {
        let settled = false;
        let createdTabId = null;
        let timeoutId = null;

        const cleanup = () => {
            chrome.tabs.onUpdated.removeListener(onUpdated);
            chrome.tabs.onRemoved.removeListener(onRemoved);
            if (timeoutId) {
                clearTimeout(timeoutId);
                timeoutId = null;
            }
        };

        const finalize = (title) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (typeof createdTabId === 'number') {
                removeTabSilently(createdTabId);
            }
            resolve(normalizeFetchedTitle(title || ''));
        };

        const maybeUseTitle = (rawTitle, allowGeneric = false) => {
            const candidate = normalizeFetchedTitle(rawTitle || '');
            if (!candidate) return false;
            if (!allowGeneric && isGenericChromeWebStoreTitle(candidate)) return false;
            finalize(candidate);
            return true;
        };

        const onUpdated = (tabId, changeInfo, tab) => {
            if (tabId !== createdTabId) return;
            if (maybeUseTitle(changeInfo?.title, false)) return;

            if (changeInfo?.status === 'complete') {
                // Accept whatever final title we have as a last resort.
                maybeUseTitle(tab?.title, true);
            }
        };

        const onRemoved = (tabId) => {
            if (tabId !== createdTabId) return;
            finalize('');
        };

        chrome.tabs.onUpdated.addListener(onUpdated);
        chrome.tabs.onRemoved.addListener(onRemoved);

        timeoutId = setTimeout(() => finalize(''), timeoutMs);

        chrome.tabs.create({ url, active: false }, (tab) => {
            if (chrome.runtime.lastError || !tab || typeof tab.id !== 'number') {
                console.warn('[FetchTitle] Temporary Chrome Web Store tab create failed:', chrome.runtime.lastError?.message || 'Unknown error');
                finalize('');
                return;
            }

            createdTabId = tab.id;
            maybeUseTitle(tab.title, false);
        });
    });
}

async function resolveChromeWebStoreTitle(urlObj, fallbackTitle) {
    const titleFromOpenTab = await getChromeWebStoreTitleFromOpenTabs(urlObj);
    if (titleFromOpenTab) return titleFromOpenTab;

    const titleFromTempTab = await getChromeWebStoreTitleFromBackgroundTab(urlObj.href);
    if (titleFromTempTab && !isGenericChromeWebStoreTitle(titleFromTempTab)) {
        return titleFromTempTab;
    }

    return fallbackTitle || titleFromTempTab || 'Chrome Web Store';
}

// Fetch page title from URL
async function fetchPageTitle(rawUrl) {
    let knownTitleFallback = '';

    try {
        const url = normalizeTitleFetchUrl(rawUrl);
        if (!url) {
            return { success: false, title: '', error: 'Invalid URL' };
        }

        // Validate URL
        const urlObj = new URL(url);
        

        // SECURITY FIX: Only allow http/https protocols
        // Block file://, chrome://, chrome-extension://, about:, data:, javascript:, etc.
        if (!['http:', 'https:'].includes(urlObj.protocol)) {
            
            return { success: false, title: '', error: 'Invalid URL protocol' };
        }

        // Keep a host-specific fallback title.
        knownTitleFallback = getKnownCorsSafeTitle(urlObj);

        // Chrome Web Store blocks extension-origin fetches via CORS.
        // Resolve from open/temporary tab title instead of network fetch.
        if (urlObj.hostname.toLowerCase() === 'chromewebstore.google.com') {
            const chromeWebStoreTitle = await resolveChromeWebStoreTitle(urlObj, knownTitleFallback);
            return { success: true, title: chromeWebStoreTitle || knownTitleFallback || 'Chrome Web Store' };
        }

        // Try oEmbed API for YouTube (SPAs don't have title in raw HTML)
        if (urlObj.hostname.includes('youtube.com') || urlObj.hostname.includes('youtu.be')) {
            
            try {
                const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
                // Add 5-second timeout with AbortController
                const youtubeController = new AbortController();
                const youtubeTimeoutId = setTimeout(() => youtubeController.abort(), 5000);
                let oembedResponse;
                try {
                    oembedResponse = await fetch(oembedUrl, { signal: youtubeController.signal });
                } finally {
                    clearTimeout(youtubeTimeoutId);
                }
                if (oembedResponse.ok) {
                    const data = await oembedResponse.json();
                    const normalizedTitle = normalizeFetchedTitle(data.title || '');
                    if (normalizedTitle) {
                        
                        return { success: true, title: normalizedTitle };
                    }
                }
            } catch (e) {
                console.warn('[FetchTitle] YouTube oEmbed unavailable, falling back to HTML:', e.message);
            }
        }

        // Try oEmbed API for Pinterest
        if (urlObj.hostname.includes('pinterest')) {
            
            try {
                const oembedUrl = `https://www.pinterest.com/oembed.json?url=${encodeURIComponent(url)}`;
                // Add 5-second timeout with AbortController
                const pinterestController = new AbortController();
                const pinterestTimeoutId = setTimeout(() => pinterestController.abort(), 5000);
                let oembedResponse;
                try {
                    oembedResponse = await fetch(oembedUrl, { signal: pinterestController.signal });
                } finally {
                    clearTimeout(pinterestTimeoutId);
                }
                if (oembedResponse.ok) {
                    const data = await oembedResponse.json();
                    // Pinterest oEmbed returns title in "title" or "description"
                    const title = normalizeFetchedTitle((data.title || data.description || ''));
                    if (title) {
                        
                        return { success: true, title: title };
                    }
                }
            } catch (e) {
                console.warn('[FetchTitle] Pinterest oEmbed unavailable, falling back to HTML:', e.message);
            }
        }

        // Fetch with timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => {
            
            controller.abort();
        }, 5000);

        let response;
        try {
            response = await fetch(url, {
                method: 'GET',
                signal: controller.signal,
                headers: {
                    'Accept': 'text/html,application/xhtml+xml'
                }
            });
        } finally {
            clearTimeout(timeoutId);
        }
        

        if (!response.ok) {
            if (knownTitleFallback) {
                return { success: true, title: knownTitleFallback };
            }
            
            return { success: false, title: '', error: `HTTP ${response.status}` };
        }

        // Read up to 200KB to handle sites like YouTube that put title late.
        // Fallback to response.text() when stream reader is unavailable.
        let html = '';
        const maxBytes = 200000;
        if (response.body && typeof response.body.getReader === 'function') {
            const reader = response.body.getReader();
            const decoder = new TextDecoder('utf-8');
            let bytesRead = 0;

            
            while (bytesRead < maxBytes) {
                const { done, value } = await reader.read();
                if (done) break;
                html += decoder.decode(value, { stream: true });
                bytesRead += value.length;

                // Check if we have the title tag already (early exit for simple sites)
                if (html.includes('</title>')) break;
            }
            reader.cancel(); // Stop reading
        } else {
            html = (await response.text()).slice(0, maxBytes);
        }
        

        // Parse title from HTML - try multiple methods
        let title = null;

        // Method 1: Standard <title> tag
        const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        if (titleMatch && titleMatch[1]) {
            title = titleMatch[1].trim();
            
        }

        // Method 2: Open Graph og:title meta tag
        if (!title) {
            const ogMatch = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i) ||
                           html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:title["']/i);
            if (ogMatch && ogMatch[1]) {
                title = ogMatch[1].trim();
                
            }
        }

        // Method 3: Twitter title meta tag
        if (!title) {
            const twitterMatch = html.match(/<meta[^>]*name=["']twitter:title["'][^>]*content=["']([^"']+)["']/i) ||
                                html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']twitter:title["']/i);
            if (twitterMatch && twitterMatch[1]) {
                title = twitterMatch[1].trim();
                
            }
        }

        if (title) {
            const normalizedTitle = normalizeFetchedTitle(title);
            if (normalizedTitle) {
                return { success: true, title: normalizedTitle };
            }
        }

        if (knownTitleFallback) {
            return { success: true, title: knownTitleFallback };
        }

        // Debug: Log first 1000 chars to see what YouTube returns
        
        return { success: false, title: '', error: 'No title found' };

    } catch (error) {
        if (knownTitleFallback) {
            return { success: true, title: knownTitleFallback };
        }

        if (error.name === 'AbortError') {
            return { success: false, title: '', error: 'Request timed out' };
        }

        // Expected for some sites due to bot protection/CORS/network policy.
        if (error.name === 'TypeError') {
            return { success: false, title: '', error: 'Network fetch failed' };
        }

        console.warn('[FetchTitle] Error:', error.name, error.message);
        return { success: false, title: '', error: error.message };
    }
}

// Fetch a favicon URL and convert it to Base64 data URL.
async function fetchFaviconAsBase64(url, options = {}) {
    // Validate URL - prevent SSRF and local file access
    if (!url || typeof url !== 'string') {
        throw new Error('Invalid URL: must be a non-empty string');
    }
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        throw new Error('Invalid protocol: only http and https allowed');
    }

    // SSRF Protection: Block private/internal IP addresses and localhost
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase();
    if (isPrivateOrLocalHostname(hostname)) {
        throw new Error('Favicon fetch blocked: private/internal address');
    }

    const timeoutMs = Math.max(1000, Math.min(Number(options?.timeoutMs) || 10000, 15000));
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(url, {
            signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
            throw new Error(`Fetch failed with status ${response.status}`);
        }

        // Validate content type - must be an image
        const contentType = response.headers.get('content-type') || '';
        if (!contentType.startsWith('image/') && !contentType.includes('icon') && !contentType.includes('octet-stream')) {
            throw new Error('Not an image: content-type is ' + contentType);
        }

        // Security: Block SVG favicons - can contain embedded JavaScript
        if (contentType.includes('svg')) {
            throw new Error('SVG favicons not supported for security reasons');
        }

        const blob = await response.blob();

        // Reject extremely large files (> 500KB is suspicious for a favicon)
        if (blob.size > 500000) {
            throw new Error('File too large for favicon: ' + blob.size + ' bytes');
        }

        // Convert blob to Base64 data URL
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result); // Returns data:image/...;base64,...
            reader.onerror = () => reject(new Error(`FileReader failed: ${reader.error?.message || 'unknown error'}`));
            reader.readAsDataURL(blob);
        });
    } catch (error) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') {
            throw new Error('Favicon fetch timed out');
        }
        throw error;
    }
}
