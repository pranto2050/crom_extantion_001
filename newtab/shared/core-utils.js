(function registerLumiListCoreUtils(global) {
    const modules = global.LumiListModules || (global.LumiListModules = {});

    function generateId() {
        return crypto.randomUUID();
    }

    function safeParseInt(value, defaultValue = 0) {
        if (value === null || value === undefined) return defaultValue;
        const parsed = parseInt(value, 10);
        return isNaN(parsed) ? defaultValue : parsed;
    }

    function validateColumnIndex(columnIndex) {
        const parsed = safeParseInt(columnIndex, 0);
        return Math.max(0, Math.min(3, parsed));
    }

    function escapeHTML(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function isUnsafeUrl(url) {
        if (!url || typeof url !== 'string') return true;
        const lowerUrl = url.toLowerCase().trim();
        const unsafeSchemes = [
            'javascript:',
            'data:',
            'vbscript:',
            'chrome:',
            'chrome-extension:',
            'about:',
            'file:',
            'blob:',
            'moz-extension:',
            'ms-browser-extension:'
        ];
        return unsafeSchemes.some(scheme => lowerUrl.startsWith(scheme));
    }

    function sanitizeUrl(url) {
        if (!url || typeof url !== 'string') return null;
        const trimmedUrl = url.trim();
        if (isUnsafeUrl(trimmedUrl)) return null;
        if (!trimmedUrl.match(/^[a-zA-Z]+:\/\//)) {
            return 'https://' + trimmedUrl;
        }
        return trimmedUrl;
    }

    function normalizeUrlForDedup(url) {
        if (!url) return '';
        try {
            const parsed = new URL(url);
            let normalized = parsed.protocol.toLowerCase() + '//' + parsed.hostname.toLowerCase();
            if (parsed.port && parsed.port !== '80' && parsed.port !== '443') {
                normalized += ':' + parsed.port;
            }
            let pathname = parsed.pathname;
            if (pathname.length > 1 && pathname.endsWith('/')) {
                pathname = pathname.slice(0, -1);
            }
            normalized += pathname;
            if (parsed.search) {
                const params = new URLSearchParams(parsed.search);
                const sortedParams = new URLSearchParams([...params.entries()].sort());
                normalized += '?' + sortedParams.toString();
            }
            return normalized;
        } catch (error) {
            return url.trim().toLowerCase();
        }
    }

    function normalizeBooleanValue(value) {
        return value === true || value === 'true' || value === 1 || value === '1';
    }

    function getCurrentTimestamp() {
        return new Date().toISOString();
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    modules.coreUtils = {
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
    };
})(window);
