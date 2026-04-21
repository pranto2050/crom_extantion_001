(() => {
    const WALLPAPER_BOOT_AUTH_HINT_LOCAL_KEY = 'lumilist_wallpaper_boot_auth_hint_v1';
    const WALLPAPER_LOGGED_OUT_DEFAULT_SNAPSHOT_LOCAL_KEY = 'lumilist_logged_out_default_visual_v1';
    const SYNC_USER_STORAGE_KEY = 'lumilist_user';
    const SYNC_SESSION_INVALIDATED_STORAGE_KEY = 'lumilist_session_invalidated';
    const DEFAULT_THEME_STYLES = {
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

    function clampNumber(value, min, max, fallback) {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) return fallback;
        return Math.min(max, Math.max(min, numeric));
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

    function normalizeTabHoverTextColor(value, fallback) {
        return normalizeHexColor(value, fallback);
    }

    function normalizeThemeStyle(rawStyle, fallbackStyle) {
        const source = rawStyle && typeof rawStyle === 'object' ? rawStyle : {};
        const fallback = fallbackStyle && typeof fallbackStyle === 'object'
            ? fallbackStyle
            : DEFAULT_THEME_STYLES.dark;
        const sourceOverlay = source.overlay && typeof source.overlay === 'object'
            ? source.overlay
            : {};
        const fallbackOverlay = fallback.overlay && typeof fallback.overlay === 'object'
            ? fallback.overlay
            : DEFAULT_THEME_STYLES.dark.overlay;

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

    function rgbaFromHex(hexColor, opacity) {
        const rgb = hexToRgb(hexColor) || { r: 0, g: 0, b: 0 };
        const alpha = normalizeOpacity(opacity, 1);
        return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
    }

    function buildAccentPalette(primaryHex, themeMode) {
        const fallbackPrimary = DEFAULT_THEME_STYLES[themeMode].primary;
        const baseHex = normalizeHexColor(primaryHex, fallbackPrimary);
        const baseRgb = hexToRgb(baseHex) || hexToRgb(fallbackPrimary);
        const isLightTheme = themeMode === 'light';
        const white = { r: 255, g: 255, b: 255 };
        const black = { r: 0, g: 0, b: 0 };

        const adjustHexTone = (hexColor, amount) => {
            const resolvedHex = normalizeHexColor(hexColor, fallbackPrimary);
            const resolvedRgb = hexToRgb(resolvedHex) || baseRgb;
            const shiftChannel = (channel) => clampNumber(channel + (amount * 255), 0, 255, channel);
            return rgbToHex({
                r: shiftChannel(resolvedRgb.r),
                g: shiftChannel(resolvedRgb.g),
                b: shiftChannel(resolvedRgb.b)
            });
        };

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

    function applyThemeStyleTokens(themeStyle, mode) {
        const resolvedStyle = normalizeThemeStyle(themeStyle, DEFAULT_THEME_STYLES[mode]);
        const overlay = resolvedStyle.overlay;
        const overlayCss = `linear-gradient(${normalizeOverlayAngle(overlay.angle, 180)}deg, ${rgbaFromHex(overlay.topColor, overlay.topOpacity)}, ${rgbaFromHex(overlay.bottomColor, overlay.bottomOpacity)})`;
        const accentPalette = buildAccentPalette(resolvedStyle.primary, mode);
        const normalizedActiveTextColor = normalizeHexColor(
            resolvedStyle.activeTextColor,
            DEFAULT_THEME_STYLES[mode].activeTextColor
        );
        const normalizedTabHoverTextColor = normalizeHexColor(
            resolvedStyle.tabHoverTextColor,
            DEFAULT_THEME_STYLES[mode].tabHoverTextColor
        );
        const normalizedInactiveTabTextColor = normalizeHexColor(
            resolvedStyle.inactiveTabTextColor,
            DEFAULT_THEME_STYLES[mode].inactiveTabTextColor
        );
        const normalizedBoardTextColor = normalizeHexColor(
            resolvedStyle.boardTextColor,
            DEFAULT_THEME_STYLES[mode].boardTextColor
        );
        const normalizedLinkDescriptionTextColor = normalizeHexColor(
            resolvedStyle.linkDescriptionTextColor,
            DEFAULT_THEME_STYLES[mode].linkDescriptionTextColor
        );
        const normalizedIconColor = normalizeHexColor(
            resolvedStyle.iconColor,
            DEFAULT_THEME_STYLES[mode].iconColor
        );
        const normalizedTabArrowColor = normalizeHexColor(
            resolvedStyle.tabArrowColor,
            DEFAULT_THEME_STYLES[mode].tabArrowColor
        );
        const normalizedAddBoardColor = normalizeHexColor(resolvedStyle.addBoardColor, DEFAULT_THEME_STYLES[mode].addBoardColor);
        const addBoardIconColor = resolveReadableForegroundForHex(normalizedAddBoardColor, '#1A1F2E', '#FFFFFF');
        const addBoardRgb = hexToRgb(normalizedAddBoardColor) || hexToRgb(DEFAULT_THEME_STYLES[mode].addBoardColor) || { r: 45, g: 255, b: 177 };
        const normalizedBoardBackgroundColor = normalizeHexColor(
            resolvedStyle.boardBackgroundColor,
            DEFAULT_THEME_STYLES[mode].boardBackgroundColor
        );
        const boardBackgroundRgb = hexToRgb(normalizedBoardBackgroundColor)
            || hexToRgb(DEFAULT_THEME_STYLES[mode].boardBackgroundColor)
            || { r: 41, g: 46, b: 61 };
        const boardBackgroundOpacity = normalizeOpacity(
            resolvedStyle.boardBackgroundOpacity,
            DEFAULT_THEME_STYLES[mode].boardBackgroundOpacity
        );
        const boardBackdropBlur = normalizeBoardBackdropBlur(
            resolvedStyle.boardBackdropBlur,
            DEFAULT_THEME_STYLES[mode].boardBackdropBlur
        );
        const boardBackdropSaturate = normalizeBoardBackdropSaturate(
            resolvedStyle.boardBackdropSaturate,
            DEFAULT_THEME_STYLES[mode].boardBackdropSaturate
        );
        const normalizedInactiveControlColor = normalizeHexColor(
            resolvedStyle.inactiveControlColor,
            DEFAULT_THEME_STYLES[mode].inactiveControlColor
        );
        const inactiveControlRgb = hexToRgb(normalizedInactiveControlColor)
            || hexToRgb(DEFAULT_THEME_STYLES[mode].inactiveControlColor)
            || { r: 58, g: 70, b: 82 };
        const inactiveControlOpacity = normalizeOpacity(
            resolvedStyle.inactiveControlOpacity,
            DEFAULT_THEME_STYLES[mode].inactiveControlOpacity
        );
        const inactiveControlBackdropBlur = normalizeInactiveControlBackdropBlur(
            resolvedStyle.inactiveControlBackdropBlur,
            DEFAULT_THEME_STYLES[mode].inactiveControlBackdropBlur
        );
        const inactiveControlBackdropSaturate = normalizeInactiveControlBackdropSaturate(
            resolvedStyle.inactiveControlBackdropSaturate,
            DEFAULT_THEME_STYLES[mode].inactiveControlBackdropSaturate
        );
        const inactiveControlHoverOpacity = Number(Math.min(1, inactiveControlOpacity + 0.12).toFixed(3));
        const normalizedPopupBackgroundColor = normalizeHexColor(
            resolvedStyle.popupBackgroundColor,
            DEFAULT_THEME_STYLES[mode].popupBackgroundColor
        );
        const popupBackgroundRgb = hexToRgb(normalizedPopupBackgroundColor)
            || hexToRgb(DEFAULT_THEME_STYLES[mode].popupBackgroundColor)
            || { r: 40, g: 44, b: 52 };
        const popupBackgroundOpacity = normalizeOpacity(
            resolvedStyle.popupBackgroundOpacity,
            DEFAULT_THEME_STYLES[mode].popupBackgroundOpacity
        );
        const popupBackgroundOpacitySoft = Number(Math.max(0, popupBackgroundOpacity - 0.1).toFixed(3));
        const popupBackgroundSidebarOpacity = Number(Math.max(0, popupBackgroundOpacity - 0.24).toFixed(3));
        const popupBackgroundContentOpacity = Number(Math.max(0, popupBackgroundOpacity - 0.08).toFixed(3));
        const normalizedPopupCardBackgroundColor = normalizeHexColor(
            resolvedStyle.popupCardBackgroundColor,
            DEFAULT_THEME_STYLES[mode].popupCardBackgroundColor
        );
        const popupCardBackgroundRgb = hexToRgb(normalizedPopupCardBackgroundColor)
            || hexToRgb(DEFAULT_THEME_STYLES[mode].popupCardBackgroundColor)
            || { r: 255, g: 255, b: 255 };
        const popupCardBackgroundOpacity = normalizeOpacity(
            resolvedStyle.popupCardBackgroundOpacity,
            DEFAULT_THEME_STYLES[mode].popupCardBackgroundOpacity
        );
        const normalizedDropdownBackgroundColor = normalizeHexColor(
            resolvedStyle.dropdownBackgroundColor,
            DEFAULT_THEME_STYLES[mode].dropdownBackgroundColor
        );
        const dropdownBackgroundRgb = hexToRgb(normalizedDropdownBackgroundColor)
            || hexToRgb(DEFAULT_THEME_STYLES[mode].dropdownBackgroundColor)
            || { r: 62, g: 69, b: 91 };
        const dropdownBackgroundOpacity = normalizeOpacity(
            resolvedStyle.dropdownBackgroundOpacity,
            DEFAULT_THEME_STYLES[mode].dropdownBackgroundOpacity
        );
        const dropdownBackgroundOpacitySoft = Number(Math.max(0, dropdownBackgroundOpacity - 0.1).toFixed(3));
        const rootStyle = document.documentElement.style;

        rootStyle.setProperty('--ll-app-wallpaper-overlay', overlayCss);
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
        rootStyle.setProperty('--ll-tab-hover-text-color', normalizedTabHoverTextColor);
        rootStyle.setProperty('--ll-tab-inactive-text-color', normalizedInactiveTabTextColor);
        rootStyle.setProperty('--ll-board-text-color', normalizedBoardTextColor);
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

    function normalizeThemeMode(value) {
        return value === 'light' ? 'light' : 'dark';
    }

    function normalizeBundledWallpaperPath(value, mode) {
        const trimmed = typeof value === 'string' ? value.trim().replace(/^\/+/, '') : '';
        if (!trimmed) return null;
        const normalizedMode = normalizeThemeMode(mode);
        const pattern = new RegExp(`^wallpaper/${normalizedMode}/.+\\.(jpg|jpeg|png|webp|avif)$`, 'i');
        return pattern.test(trimmed) ? trimmed : null;
    }

    function setBootWallpaperUrl(source) {
        const normalizedSource = typeof source === 'string' ? source.trim() : '';
        if (!normalizedSource) {
            document.documentElement.style.setProperty('--ll-app-wallpaper-url', 'none');
            return;
        }

        const escaped = normalizedSource.replace(/["\\]/g, '\\$&');
        document.documentElement.style.setProperty('--ll-app-wallpaper-url', `url("${escaped}")`);
    }

    function applyBootVisualSnapshot(snapshot) {
        const mode = normalizeThemeMode(snapshot?.themeMode);
        document.documentElement.setAttribute('data-theme', mode);
        applyThemeStyleTokens(snapshot?.style, mode);
        applyBootFontColorOverride();
        setBootWallpaperUrl(normalizeBundledWallpaperPath(snapshot?.wallpaper, mode));
    }

    function applyBootFontColorOverride() {
        try {
            const cachedFontColorRaw = localStorage.getItem('lumilist_font_color');
            const cachedFontColor = normalizeHexColor(cachedFontColorRaw, null);
            if (cachedFontColor) {
                document.documentElement.style.setProperty('--ll-board-text-color', cachedFontColor);
            }
        } catch (_error) {
            // Boot color cache should never block startup styling.
        }
    }

    function readLoggedOutDefaultVisualSnapshot() {
        try {
            const rawSnapshot = localStorage.getItem(WALLPAPER_LOGGED_OUT_DEFAULT_SNAPSHOT_LOCAL_KEY);
            if (!rawSnapshot) {
                return null;
            }

            const parsedSnapshot = JSON.parse(rawSnapshot);
            const mode = normalizeThemeMode(parsedSnapshot?.themeMode);
            return {
                themeMode: mode,
                wallpaper: normalizeBundledWallpaperPath(parsedSnapshot?.wallpaper, mode),
                style: normalizeThemeStyle(parsedSnapshot?.style, DEFAULT_THEME_STYLES[mode]),
                updatedAt: typeof parsedSnapshot?.updatedAt === 'string' ? parsedSnapshot.updatedAt : null
            };
        } catch (_error) {
            return null;
        }
    }

    function hasTrustedStartupStoredUser(storedUser, sessionInvalidation) {
        const userId = typeof storedUser?.id === 'string' && storedUser.id.trim()
            ? storedUser.id.trim()
            : null;
        if (!userId) {
            return false;
        }
        if (!sessionInvalidation) {
            return true;
        }
        const invalidatedUserId = typeof sessionInvalidation?.userId === 'string' && sessionInvalidation.userId.trim()
            ? sessionInvalidation.userId.trim()
            : null;
        if (!invalidatedUserId) {
            return false;
        }
        return invalidatedUserId !== userId;
    }

    function applyLoggedOutBootstrapVisual() {
        const snapshot = readLoggedOutDefaultVisualSnapshot();
        if (snapshot) {
            applyBootVisualSnapshot(snapshot);
            return true;
        }

        document.documentElement.setAttribute('data-theme', 'dark');
        applyThemeStyleTokens(DEFAULT_THEME_STYLES.dark, 'dark');
        document.documentElement.style.setProperty('--ll-app-wallpaper-url', 'none');
        return false;
    }

    function applyCachedUserBootstrapVisual() {
        const cachedMode = localStorage.getItem('lumilist_theme_mode');
        const mode = cachedMode === 'light' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', mode);

        const cachedStyleRaw = localStorage.getItem('lumilist_wallpaper_style_by_theme');
        let cachedStyle = null;
        if (cachedStyleRaw) {
            const parsed = JSON.parse(cachedStyleRaw);
            if (parsed && typeof parsed === 'object') {
                cachedStyle = parsed[mode];
            }
        }
        try {
            const directBootStyleRaw = localStorage.getItem(`lumilist_wallpaper_boot_style_${mode}`);
            if (directBootStyleRaw) {
                const parsedDirectBootStyle = JSON.parse(directBootStyleRaw);
                if (parsedDirectBootStyle && typeof parsedDirectBootStyle === 'object') {
                    cachedStyle = parsedDirectBootStyle;
                }
            }
        } catch (e) {
            // Fall back to the generic style cache if boot-style cache is unreadable.
        }
        applyThemeStyleTokens(cachedStyle, mode);
        applyBootFontColorOverride();

        const cachedWallpaperRaw = localStorage.getItem('lumilist_wallpaper_selection');
        if (!cachedWallpaperRaw) {
            document.documentElement.style.setProperty('--ll-app-wallpaper-url', 'none');
            return;
        }

        const cachedWallpaperSelection = JSON.parse(cachedWallpaperRaw);
        const candidate = cachedWallpaperSelection && typeof cachedWallpaperSelection === 'object'
            ? cachedWallpaperSelection[mode]
            : null;
        const normalized = typeof candidate === 'string'
            ? candidate.trim().replace(/^\/+/, '')
            : '';
        const isAllowedPath = /^wallpaper\/(dark|light)\/.+\.(jpg|jpeg|png|webp|avif)$/i.test(normalized);
        const isAllowedHostedPath = /^https:\/\/xbccmcszhnybxzlirjgk\.supabase\.co\/storage\/v1\/object\/public\/wallpaper\/(dark|light)\/.+\.(jpg|jpeg|png|webp|avif)$/i.test(normalized);

        let cachedBinaryDataUrl = null;
        let bootFallbackSource = null;
        try {
            const binaryCacheRaw = localStorage.getItem('lumilist_wallpaper_binary_cache_v1');
            if (binaryCacheRaw) {
                const parsedBinaryCache = JSON.parse(binaryCacheRaw);
                const entry = parsedBinaryCache && typeof parsedBinaryCache === 'object'
                    ? parsedBinaryCache[mode]
                    : null;
                if (
                    entry
                    && typeof entry === 'object'
                    && entry.source === candidate
                    && typeof entry.dataUrl === 'string'
                    && entry.dataUrl.startsWith('data:image/')
                ) {
                    cachedBinaryDataUrl = entry.dataUrl;
                    bootFallbackSource = 'binary-cache';
                }
            }
        } catch (e) {
            cachedBinaryDataUrl = null;
            bootFallbackSource = null;
        }

        if (cachedBinaryDataUrl) {
            recordBootWallpaperDiagnostic({
                mode,
                source: bootFallbackSource || 'binary-cache',
                wallpaper: candidate
            }, 'bootFallbackUses');
            setBootWallpaperUrl(cachedBinaryDataUrl);
        } else if (isAllowedPath || isAllowedHostedPath) {
            if (isAllowedHostedPath) {
                recordBootWallpaperDiagnostic({
                    mode,
                    source: 'hosted-url',
                    wallpaper: candidate
                }, 'bootFallbackUses');
            }
            setBootWallpaperUrl(normalized);
        } else {
            document.documentElement.style.setProperty('--ll-app-wallpaper-url', 'none');
        }
    }

    function recordBootWallpaperDiagnostic(detail, counterName = null) {
        try {
            const storageKey = 'lumilist_wallpaper_diagnostics_v1';
            const maxEvents = 60;
            const rawState = localStorage.getItem(storageKey);
            const parsedState = rawState ? JSON.parse(rawState) : {};
            const counters = {
                hostedCatalogRequests: 0,
                hostedCatalogFailures: 0,
                galleryManifestRequests: 0,
                galleryManifestFailures: 0,
                installDownloads: 0,
                installFailures: 0,
                migrationAttempts: 0,
                migrationFailures: 0,
                bootFallbackUses: 0,
                ...(parsedState && typeof parsedState.counters === 'object' ? parsedState.counters : {})
            };

            if (counterName && Object.prototype.hasOwnProperty.call(counters, counterName)) {
                counters[counterName] = Math.max(0, Number(counters[counterName] || 0) + 1);
            }

            const event = {
                at: new Date().toISOString(),
                type: 'wallpaper-boot-fallback-used',
                detail
            };

            localStorage.setItem(storageKey, JSON.stringify({
                version: 1,
                rolloutFlags: {
                    explicitRemoteGallery: true,
                    localInstallOnDemand: true,
                    hostedStartupMergeDisabled: true,
                    cloudPreferenceSync: true,
                    diagnosticsEnabled: true
                },
                counters,
                events: Array.isArray(parsedState?.events)
                    ? [event, ...parsedState.events].slice(0, maxEvents)
                    : [event],
                lastUpdatedAt: event.at
            }));
        } catch (e) {
            // Diagnostics should never block boot styling.
        }
    }

    try {
        const authHint = localStorage.getItem(WALLPAPER_BOOT_AUTH_HINT_LOCAL_KEY);
        for (const cleanupMode of ['dark', 'light']) {
            try {
                localStorage.removeItem(`lumilist_wallpaper_boot_source_${cleanupMode}`);
                localStorage.removeItem(`lumilist_wallpaper_boot_binary_${cleanupMode}`);
            } catch (e) {
                // Legacy cleanup should never block boot styling.
            }
        }

        if (authHint === 'logged_out') {
            applyLoggedOutBootstrapVisual();
        } else {
            applyCachedUserBootstrapVisual();
        }

        if (typeof chrome !== 'undefined' && chrome.storage?.local?.get) {
            chrome.storage.local.get(
                [SYNC_USER_STORAGE_KEY, SYNC_SESSION_INVALIDATED_STORAGE_KEY],
                (storageState = {}) => {
                    try {
                        const storedUser = storageState?.[SYNC_USER_STORAGE_KEY] || null;
                        const sessionInvalidation = storageState?.[SYNC_SESSION_INVALIDATED_STORAGE_KEY] || null;
                        const hasTrustedUser = hasTrustedStartupStoredUser(storedUser, sessionInvalidation);
                        localStorage.setItem(
                            WALLPAPER_BOOT_AUTH_HINT_LOCAL_KEY,
                            hasTrustedUser ? 'authenticated' : 'logged_out'
                        );
                        if (hasTrustedUser) {
                            if (authHint !== 'authenticated') {
                                applyCachedUserBootstrapVisual();
                        applyBootFontColorOverride();
                            }
                        } else if (authHint !== 'logged_out') {
                            applyLoggedOutBootstrapVisual();
                        }
                    } catch (_error) {
                        // Non-blocking auth hint re-check.
                    }
                }
            );
        }
    } catch (e) {
        document.documentElement.setAttribute('data-theme', 'dark');
        applyThemeStyleTokens(DEFAULT_THEME_STYLES.dark, 'dark');
        document.documentElement.style.setProperty('--ll-app-wallpaper-url', 'none');
    }
})();
