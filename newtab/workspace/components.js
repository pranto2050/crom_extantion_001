/**
 * Component-based rendering logic for Boards and Bookmarks.
 * Refactored for better maintainability and extensibility.
 */

const BoardComponent = {
    /**
     * Renders a board and its bookmarks into an HTML string.
     */
    render(board, bookmarks) {
        if (!board || !board.id) {
            console.error('Invalid board data for component rendering:', board);
            return '';
        }

        const escapedBoardId = escapeHTML(board.id);
        const { boardClasses, boardStyle } = this.getStyleAndClasses(board);
        const visibleBookmarks = getVisibleBookmarksForBoard(board.id, bookmarks);
        const bookmarkToggleControl = getBoardBookmarkToggleControl(board.id, bookmarks.length);

        const headerHTML = this.getHeader(board);
        const bookmarksHTML = visibleBookmarks
            .map(bookmark => BookmarkComponent.render(bookmark))
            .join('');
        const footerHTML = this.getFooter(escapedBoardId, bookmarkToggleControl);

        return `
            <div id="board-${escapedBoardId}" class="${boardClasses}" data-board-id="${escapedBoardId}"${boardStyle}>
                ${headerHTML}
                <ul class="board-links">${bookmarksHTML}</ul>
                ${footerHTML}
            </div>
        `.trim();
    },

    /**
     * Calculates classes and styles for the board based on its properties.
     */
    getStyleAndClasses(board) {
        const isShared = !!board.shareId;
        const boardColor = board.color ? normalizeHexColor(board.color, null) : null;
        
        let boardStyle = '';
        let boardClasses = 'board';

        if (boardColor) {
            boardStyle = ` style="--board-custom-color: ${boardColor};"`;
            boardClasses += ' has-custom-color';
        }

        if (privacyModeEnabled) boardClasses += ' privacy-blur';
        if (isShared) boardClasses += ' shared-board';

        return { boardClasses, boardStyle };
    },

    /**
     * Generates the header section of the board.
     */
    getHeader(board) {
        const escapedBoardId = escapeHTML(board.id);
        const escapedName = escapeHTML(board.name || 'Untitled Board');
        const isShared = !!board.shareId;
        const sharedSubtitle = isShared ? '<span class="shared-subtitle">Shared</span>' : '';

        return `
            <div class="board-title" draggable="true" data-board-id="${escapedBoardId}">
                <span class="board-title-text" title="Double-click to open all links in new tabs">${escapedName}</span>
                ${sharedSubtitle}
                <div class="board-buttons">
                    <button class="board-add-btn" data-action="add-bookmark" data-board-id="${escapedBoardId}" title="Add new link">
                        ${BOARD_ADD_ICON}
                    </button>
                    <div class="board-menu-container">
                        <button class="board-menu-btn" data-action="toggle-board-menu" data-board-id="${escapedBoardId}" title="Board options">&#8942;</button>
                    </div>
                </div>
            </div>
        `.trim();
    },

    /**
     * Generates the footer section of the board (e.g., show more button).
     */
    getFooter(escapedBoardId, bookmarkToggleControl) {
        if (!bookmarkToggleControl) return '';

        return `
            <button class="board-show-remaining-btn" 
                    data-action="${bookmarkToggleControl.action}" 
                    data-board-id="${escapedBoardId}">
                ${bookmarkToggleControl.label}
            </button>
        `.trim();
    }
};

const BookmarkComponent = {
    /**
     * Renders a single bookmark into an HTML string.
     */
    render(bookmark) {
        if (!bookmark || !bookmark.id || !bookmark.url) {
            console.error('Invalid bookmark data for component rendering:', bookmark);
            return '';
        }

        const escapedUrl = escapeHTML(bookmark.url);
        const escapedTitle = escapeHTML(bookmark.title || 'Untitled');
        const escapedBookmarkId = escapeHTML(bookmark.id);
        
        const noteHtml = this.getNoteHTML(bookmark.description);
        const tagsHtml = this.getTagsHTML(bookmark.tags);
        const actionsHtml = this.getActionsHTML(bookmark);
        
        const selectedClass = selectedBookmarks.has(bookmark.id) ? 'selected' : '';
        const classAttr = selectedClass ? ` class="${selectedClass}"` : '';
        const targetAttr = openLinksInNewTab ? 'target="_blank" rel="noopener noreferrer"' : '';

        return `
            <li id="bookmark-${escapedBookmarkId}" data-bookmark-id="${escapedBookmarkId}" draggable="true"${classAttr}>
                <a href="${escapedUrl}" ${targetAttr}>
                    <div class="bookmark-content">
                        <span class="favicon" data-url="${escapedUrl}" data-title="${escapedTitle}"></span>
                        <span class="bookmark-text">
                            <span class="bookmark-title">${escapedTitle}</span>
                            ${noteHtml}
                            ${tagsHtml}
                        </span>
                    </div>
                    ${actionsHtml}
                </a>
            </li>
        `.trim();
    },

    /**
     * Generates HTML for bookmark notes.
     */
    getNoteHTML(description) {
        const noteText = sanitizeBookmarkNote(description);
        return noteText ? `<span class="bookmark-note">${escapeHTML(noteText)}</span>` : '';
    },

    /**
     * Generates HTML for bookmark tags.
     */
    getTagsHTML(tags) {
        if (!window.taggingEnabled || !tags) return '';
        
        return `
            <div class="bookmark-tags">
                ${tags.split(',').map(tag => `<span class="bookmark-tag">${escapeHTML(tag.trim())}</span>`).join('')}
            </div>
        `.trim();
    },

    /**
     * Generates HTML for bookmark actions (edit, delete, pin).
     */
    getActionsHTML(bookmark) {
        const escapedBookmarkId = escapeHTML(bookmark.id);
        const pinIcon = bookmark.isPinned ? BOOKMARK_UNPIN_ICON : BOOKMARK_PIN_ICON;
        const pinTitle = bookmark.isPinned ? 'Unpin bookmark' : 'Pin bookmark';
        
        const pinBtnHtml = window.pinFavoritesEnabled
            ? `<button class="bookmark-pin-btn" data-action="pin-bookmark" data-bookmark-id="${escapedBookmarkId}" title="${pinTitle}">${pinIcon}</button>`
            : '';

        return `
            <div class="bookmark-actions">
                ${pinBtnHtml}
                <button class="bookmark-edit-btn" data-action="edit-bookmark" data-bookmark-id="${escapedBookmarkId}" title="Edit bookmark">${BOOKMARK_EDIT_ICON}</button>
                <button class="bookmark-delete-btn" data-action="delete-bookmark" data-bookmark-id="${escapedBookmarkId}" title="Delete bookmark">${BOOKMARK_DELETE_ICON}</button>
            </div>
        `.trim();
    }
};
