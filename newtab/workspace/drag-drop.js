/*
========================================
DRAG AND DROP FUNCTIONALITY
========================================
This script implements HTML5 drag and drop for board rearrangement.
Users can drag boards between columns and reposition them within columns.
*/

// Global variables to track drag state
let draggedElement = null;      // Reference to the board currently being dragged
let draggedFromColumn = null;   // Reference to the column the board was dragged from
let draggedBookmark = null;     // Reference to the bookmark being dragged
let draggedFromBoard = null;    // Reference to the board the bookmark was dragged from
let isDraggingBookmark = false; // Flag to distinguish between board and bookmark dragging
let dragCleanupTimeout = null;  // Timeout for emergency cleanup
let lastDragActivity = null;    // Timestamp of last drag activity

// Global variables for cross-page drag functionality
let dragOriginPageId = null;    // Original page ID where drag started
let pageHoverTimeout = null;    // Timeout for delaying page switch on hover
let isPageSwitchingDuringDrag = false; // Flag to indicate page is switching during drag
let currentHoveredTabId = null; // Track which tab is currently being hovered during drag
let draggedBoardId = null;      // ID of board being dragged (for cross-page drops)
let draggedBookmarkId = null;   // ID of bookmark being dragged (for cross-page drops)

// Multi-select bookmark state
let selectedBookmarks = new Set();  // Set of selected bookmark IDs
let isSelectionMode = false;        // Whether selection mode is active
const MODIFIER_SWEEP_DRAG_THRESHOLD_PX = 6;
const MODIFIER_SWEEP_AUTO_SCROLL_EDGE_RATIO = 0.18;
const MODIFIER_SWEEP_AUTO_SCROLL_MAX_SPEED = 15;
const modifierSweepSelectionState = {
    pointerDown: false,
    active: false,
    startClientX: 0,
    startClientY: 0,
    currentClientX: 0,
    currentClientY: 0,
    startX: 0,
    startY: 0,
    currentX: 0,
    currentY: 0,
    selectionBoxEl: null,
    candidateBookmarkEls: [],
    baselineSelectedIds: new Set()
};
const MODIFIER_SWEEP_CLICK_SUPPRESS_MS = 250;
let suppressBookmarkClickAfterSweepUntil = 0;
let modifierSweepAutoScrollSpeed = 0;
let modifierSweepAutoScrollRaf = null;

// Clear all selected bookmarks
function clearBookmarkSelection() {
    selectedBookmarks.clear();
    document.querySelectorAll('.board-links li.selected').forEach(el => {
        el.classList.remove('selected');
    });
    updateSelectionCount();
}

function removeBookmarkIdsFromSelection(bookmarkIds) {
    if (!bookmarkIds || bookmarkIds.length === 0) return;

    let changed = false;
    bookmarkIds.forEach((bookmarkId) => {
        if (!bookmarkId) return;
        if (selectedBookmarks.delete(bookmarkId)) {
            changed = true;
        }
    });

    if (changed) {
        updateSelectionCount();
    }
}

// Re-apply selection state to DOM after Idiomorph morph
// The selectedBookmarks Set is preserved, but DOM elements may have lost .selected class
function reapplySelectionStateToDOM() {
    if (!isSelectionMode || selectedBookmarks.size === 0) return;

    // Remove stale .selected classes (elements that are no longer in selectedBookmarks)
    document.querySelectorAll('.board-links li.selected').forEach(el => {
        const bookmarkId = el.dataset.bookmarkId;
        if (bookmarkId && !selectedBookmarks.has(bookmarkId)) {
            el.classList.remove('selected');
        }
    });

    // Add .selected class to all bookmarks in the selectedBookmarks Set
    for (const bookmarkId of selectedBookmarks) {
        const bookmarkEl = document.querySelector(`.board-links li[data-bookmark-id="${bookmarkId}"]`);
        if (bookmarkEl && !bookmarkEl.classList.contains('selected')) {
            bookmarkEl.classList.add('selected');
        }
    }
}

// Delete all selected bookmarks (soft delete to trash)
async function deleteSelectedBookmarks() {
    if (selectedBookmarks.size === 0) return;

    // Check subscription status
    if (!canModify()) return;

    // Confirm deletion
    const count = selectedBookmarks.size;
    const confirmMessage = count === 1
        ? 'Delete this bookmark?'
        : `Delete ${count} bookmarks?`;

    if (!confirm(confirmMessage)) return;

    try {
        const now = getCurrentTimestamp();
        const bookmarkIds = Array.from(selectedBookmarks);
        const bookmarksBeforeDelete = await db.bookmarks.bulkGet(bookmarkIds);
        const beforeById = new Map(
            bookmarksBeforeDelete
                .filter(bookmark => !!bookmark)
                .map(bookmark => [bookmark.id, bookmark])
        );

        // Soft delete all selected bookmarks
        await db.transaction('rw', db.bookmarks, async () => {
            for (const id of bookmarkIds) {
                await db.bookmarks.update(id, {
                    deletedAt: now,
                    updatedAt: now
                });
            }
        });

        const bookmarksAfterDelete = await db.bookmarks.bulkGet(bookmarkIds);
        const ops = bookmarksAfterDelete
            .filter(bookmark => !!bookmark)
            .map(bookmark => ({
                table: 'bookmarks',
                id: bookmark.id,
                before: beforeById.get(bookmark.id) || null,
                after: bookmark
            }));
        const queueAttempt = await queueSyncItemsAtomically(
            bookmarksAfterDelete
                .filter(bookmark => !!bookmark)
                .map(bookmark => ({
                    op: 'upsert',
                    table: 'bookmarks',
                    id: bookmark.id,
                    data: bookmark
                })),
            { contextLabel: 'deleteSelectedBookmarks' }
        );
        if (!queueAttempt.success) {
            await rollbackLocalMutationOps(ops);
            throw new Error(queueAttempt.error || 'Failed to move selected bookmarks to trash.');
        }

        if (!isApplyingUndoRedoHistory) {
            await recordUndoRedoHistoryEntry({
                kind: 'bookmark_bulk_delete',
                label: bookmarkIds.length === 1 ? 'Delete 1 bookmark' : `Delete ${bookmarkIds.length} bookmarks`,
                ops
            });
        }

        // Remove elements from DOM
        bookmarkIds.forEach(id => {
            const el = document.querySelector(`li[data-bookmark-id="${id}"]`);
            if (el) el.remove();
        });

        // Exit selection mode immediately (before network operations)
        clearBookmarkSelection();
        toggleSelectionMode();

        broadcastDataChange('deleteSelectedBookmarks');
        if (largeBoardCollapseEnabled) {
            await loadBoardsFromDatabase();
        }
        await refreshSearchIfOpen();



    } catch (error) {
        console.error('Failed to delete selected bookmarks:', error);
        alert('Failed to delete bookmarks. Please try again.');
    }
}

// Update selection count display in the selection bar
function updateSelectionCount() {
    const countEl = document.getElementById('selectionCount');
    const deleteBtn = document.getElementById('selectionDelete');

    if (countEl) {
        const count = selectedBookmarks.size;
        countEl.textContent = count === 0 ? '0 selected' :
            count === 1 ? '1 selected' :
                `${count} selected`;
    }

    // Disable delete button when nothing selected
    if (deleteBtn) {
        deleteBtn.disabled = selectedBookmarks.size === 0;
    }
}

function isBookmarkActionClickTarget(target) {
    return !!target?.closest?.('.bookmark-actions, .bookmark-edit-btn, .bookmark-delete-btn, [data-action]');
}

function getBookmarkSelectionListItemFromEvent(event) {
    return event?.target?.closest?.('.board-links li[data-bookmark-id]') || null;
}

function isModifierSweepInteractiveTarget(target) {
    if (!target?.closest) return false;

    // Allow Shift-based selection interaction on bookmark rows themselves.
    if (target.closest('.board-links li[data-bookmark-id]')) {
        return false;
    }

    return !!target.closest(
        '.page-navigation, .selection-bar, .settings-modal, .import-popup, .modal, .modal-overlay, ' +
        '.tab-menu-dropdown, .floating-actions, button, input, textarea, select, label, [contenteditable="true"], .page-tab'
    );
}

function ensureModifierSweepSelectionBox() {
    if (modifierSweepSelectionState.selectionBoxEl) return modifierSweepSelectionState.selectionBoxEl;

    const box = document.createElement('div');
    box.className = 'modifier-sweep-selection-box';
    box.style.position = 'fixed';
    box.style.left = '0';
    box.style.top = '0';
    box.style.width = '0';
    box.style.height = '0';
    box.style.border = '1px solid var(--ll-accent-outline)';
    box.style.background = 'var(--ll-accent-soft-2)';
    box.style.borderRadius = '4px';
    box.style.pointerEvents = 'none';
    box.style.zIndex = '9999';
    box.style.display = 'none';
    document.body.appendChild(box);

    modifierSweepSelectionState.selectionBoxEl = box;
    return box;
}

function hideModifierSweepSelectionBox() {
    const box = modifierSweepSelectionState.selectionBoxEl;
    if (!box) return;
    box.style.display = 'none';
}

function getModifierSweepSelectionRect(documentX, documentY) {
    const left = Math.min(modifierSweepSelectionState.startX, documentX);
    const right = Math.max(modifierSweepSelectionState.startX, documentX);
    const top = Math.min(modifierSweepSelectionState.startY, documentY);
    const bottom = Math.max(modifierSweepSelectionState.startY, documentY);

    return {
        left,
        top,
        right,
        bottom,
        width: right - left,
        height: bottom - top
    };
}

function getViewportRectFromDocumentRect(rect) {
    return {
        left: rect.left - window.scrollX,
        top: rect.top - window.scrollY,
        right: rect.right - window.scrollX,
        bottom: rect.bottom - window.scrollY,
        width: rect.width,
        height: rect.height
    };
}

function getModifierSweepSelectionVisualTopBoundary() {
    const pageNavigation = document.querySelector('.page-navigation');
    if (!pageNavigation) return 0;

    const navRect = pageNavigation.getBoundingClientRect();
    if (!Number.isFinite(navRect.bottom)) return 0;

    return Math.max(0, navRect.bottom);
}

function updateModifierSweepSelectionBox(documentX, documentY) {
    const box = ensureModifierSweepSelectionBox();
    const rect = getModifierSweepSelectionRect(documentX, documentY);
    const viewportRect = getViewportRectFromDocumentRect(rect);
    const topBoundary = getModifierSweepSelectionVisualTopBoundary();
    const clippedTop = Math.max(viewportRect.top, topBoundary);
    const clippedBottom = viewportRect.bottom;
    const clippedHeight = Math.max(0, clippedBottom - clippedTop);

    if (clippedHeight <= 0 || viewportRect.width <= 0) {
        box.style.display = 'none';
        return rect;
    }

    box.style.left = `${viewportRect.left}px`;
    box.style.top = `${clippedTop}px`;
    box.style.width = `${viewportRect.width}px`;
    box.style.height = `${clippedHeight}px`;
    box.style.display = 'block';

    return rect;
}

function doRectsIntersect(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function isBlockingModalOpenForModifierSweep() {
    return !!document.querySelector('.modal-overlay.active, .import-popup.active');
}

function getModifierSweepAutoScrollSpeed(clientY) {
    const viewportHeight = window.innerHeight;
    const edgeThreshold = Math.max(40, viewportHeight * MODIFIER_SWEEP_AUTO_SCROLL_EDGE_RATIO);

    if (clientY < edgeThreshold) {
        const proximity = 1 - (clientY / edgeThreshold);
        return -Math.ceil(proximity * MODIFIER_SWEEP_AUTO_SCROLL_MAX_SPEED);
    }

    if (clientY > viewportHeight - edgeThreshold) {
        const distanceFromBottom = viewportHeight - clientY;
        const proximity = 1 - (distanceFromBottom / edgeThreshold);
        return Math.ceil(proximity * MODIFIER_SWEEP_AUTO_SCROLL_MAX_SPEED);
    }

    return 0;
}

function stopModifierSweepAutoScroll() {
    if (modifierSweepAutoScrollRaf) {
        cancelAnimationFrame(modifierSweepAutoScrollRaf);
        modifierSweepAutoScrollRaf = null;
    }
    modifierSweepAutoScrollSpeed = 0;
}

function startModifierSweepAutoScroll() {
    if (modifierSweepAutoScrollRaf) return;

    const step = () => {
        if (!modifierSweepSelectionState.pointerDown || !modifierSweepSelectionState.active || modifierSweepAutoScrollSpeed === 0) {
            stopModifierSweepAutoScroll();
            return;
        }

        if (isBlockingModalOpenForModifierSweep()) {
            resetModifierSweepSelectionState();
            return;
        }

        const previousScrollY = window.scrollY;
        window.scrollBy(0, modifierSweepAutoScrollSpeed);

        if (window.scrollY === previousScrollY) {
            stopModifierSweepAutoScroll();
            return;
        }

        modifierSweepSelectionState.currentX = modifierSweepSelectionState.currentClientX + window.scrollX;
        modifierSweepSelectionState.currentY = modifierSweepSelectionState.currentClientY + window.scrollY;

        const selectionRect = updateModifierSweepSelectionBox(
            modifierSweepSelectionState.currentX,
            modifierSweepSelectionState.currentY
        );
        applyModifierSweepSelectionByRect(selectionRect);

        modifierSweepAutoScrollRaf = requestAnimationFrame(step);
    };

    modifierSweepAutoScrollRaf = requestAnimationFrame(step);
}

function updateModifierSweepAutoScroll(clientY) {
    const nextSpeed = getModifierSweepAutoScrollSpeed(clientY);
    if (nextSpeed === modifierSweepAutoScrollSpeed) return;

    modifierSweepAutoScrollSpeed = nextSpeed;
    if (nextSpeed === 0) {
        stopModifierSweepAutoScroll();
    } else {
        startModifierSweepAutoScroll();
    }
}

function getIntersectingBookmarkIdsForModifierSweepRect(selectionRect) {
    const intersectingIds = new Set();

    modifierSweepSelectionState.candidateBookmarkEls.forEach((bookmarkEl) => {
        if (!bookmarkEl || !bookmarkEl.isConnected) return;
        const bookmarkId = bookmarkEl.getAttribute('data-bookmark-id');
        if (!bookmarkId) return;
        const bookmarkRectClient = bookmarkEl.getBoundingClientRect();
        const bookmarkRect = {
            left: bookmarkRectClient.left + window.scrollX,
            top: bookmarkRectClient.top + window.scrollY,
            right: bookmarkRectClient.right + window.scrollX,
            bottom: bookmarkRectClient.bottom + window.scrollY
        };
        if (doRectsIntersect(selectionRect, bookmarkRect)) {
            intersectingIds.add(bookmarkId);
        }
    });

    return intersectingIds;
}

function applyModifierSweepSelectionByRect(selectionRect) {
    const intersectingIds = getIntersectingBookmarkIdsForModifierSweepRect(selectionRect);
    const nextSelectedIds = new Set(modifierSweepSelectionState.baselineSelectedIds);

    // Shift marquee acts as toggle against the pre-drag selection baseline.
    intersectingIds.forEach((bookmarkId) => {
        if (nextSelectedIds.has(bookmarkId)) {
            nextSelectedIds.delete(bookmarkId);
        } else {
            nextSelectedIds.add(bookmarkId);
        }
    });

    // Only auto-enter selection mode once we actually have something selected.
    // If the user drags in empty space and selects nothing, keep mode off.
    if (!isSelectionMode && nextSelectedIds.size === 0) {
        return;
    }
    if (!isSelectionMode && nextSelectedIds.size > 0) {
        toggleSelectionMode();
    }

    modifierSweepSelectionState.candidateBookmarkEls.forEach((bookmarkEl) => {
        if (!bookmarkEl || !bookmarkEl.isConnected) return;
        const bookmarkId = bookmarkEl.getAttribute('data-bookmark-id');
        if (!bookmarkId) return;
        bookmarkEl.classList.toggle('selected', nextSelectedIds.has(bookmarkId));
    });

    // Clear any stale selected class outside the candidate set (defensive).
    document.querySelectorAll('.board-links li.selected').forEach((bookmarkEl) => {
        const bookmarkId = bookmarkEl.getAttribute('data-bookmark-id');
        if (!bookmarkId || !nextSelectedIds.has(bookmarkId)) {
            bookmarkEl.classList.remove('selected');
        }
    });

    selectedBookmarks = nextSelectedIds;
    updateSelectionCount();
}

function isMultiSelectModifierPressed(event) {
    if (!event) return false;
    return event.shiftKey;
}

function toggleBookmarkSelectionForListItem(listItem) {
    const bookmarkId = listItem?.getAttribute('data-bookmark-id');
    if (!bookmarkId) return;

    if (selectedBookmarks.has(bookmarkId)) {
        selectedBookmarks.delete(bookmarkId);
        listItem.classList.remove('selected');
    } else {
        selectedBookmarks.add(bookmarkId);
        listItem.classList.add('selected');
    }
    updateSelectionCount();
}

function resetModifierSweepSelectionState() {
    modifierSweepSelectionState.pointerDown = false;
    modifierSweepSelectionState.active = false;
    modifierSweepSelectionState.startClientX = 0;
    modifierSweepSelectionState.startClientY = 0;
    modifierSweepSelectionState.currentClientX = 0;
    modifierSweepSelectionState.currentClientY = 0;
    modifierSweepSelectionState.startX = 0;
    modifierSweepSelectionState.startY = 0;
    modifierSweepSelectionState.currentX = 0;
    modifierSweepSelectionState.currentY = 0;
    modifierSweepSelectionState.candidateBookmarkEls = [];
    modifierSweepSelectionState.baselineSelectedIds.clear();
    stopModifierSweepAutoScroll();
    hideModifierSweepSelectionBox();
}

function resetModifierSweepSelectionStateOnWindowBlur() {
    if (!modifierSweepSelectionState.pointerDown && !modifierSweepSelectionState.active) return;
    resetModifierSweepSelectionState();
}

function resetModifierSweepSelectionStateOnVisibilityChange() {
    if (!document.hidden) return;
    if (!modifierSweepSelectionState.pointerDown && !modifierSweepSelectionState.active) return;
    resetModifierSweepSelectionState();
}

function beginModifierSweepSelection(event) {
    if (!event || event.defaultPrevented) return;
    if (event.button !== 0) return;
    if (!isMultiSelectModifierPressed(event)) return;
    if (isBookmarkActionClickTarget(event.target)) return;
    if (isModifierSweepInteractiveTarget(event.target)) return;
    if (isBlockingModalOpenForModifierSweep()) return;
    if (event.clientY < getModifierSweepSelectionVisualTopBoundary()) return;

    modifierSweepSelectionState.pointerDown = true;
    modifierSweepSelectionState.active = false;
    modifierSweepSelectionState.startClientX = event.clientX;
    modifierSweepSelectionState.startClientY = event.clientY;
    modifierSweepSelectionState.currentClientX = event.clientX;
    modifierSweepSelectionState.currentClientY = event.clientY;
    modifierSweepSelectionState.startX = event.clientX + window.scrollX;
    modifierSweepSelectionState.startY = event.clientY + window.scrollY;
    modifierSweepSelectionState.currentX = modifierSweepSelectionState.startX;
    modifierSweepSelectionState.currentY = modifierSweepSelectionState.startY;
    modifierSweepSelectionState.candidateBookmarkEls = [];
    modifierSweepSelectionState.baselineSelectedIds = new Set(selectedBookmarks);
    hideModifierSweepSelectionBox();

    // Prevent native link drag/selection so we can "paint" selection while dragging.
    event.preventDefault();
}

function maybeActivateModifierSweepSelection(event) {
    if (!modifierSweepSelectionState.pointerDown || modifierSweepSelectionState.active) return false;

    const dx = event.clientX - modifierSweepSelectionState.startClientX;
    const dy = event.clientY - modifierSweepSelectionState.startClientY;
    const movedEnough = ((dx * dx) + (dy * dy)) >= (MODIFIER_SWEEP_DRAG_THRESHOLD_PX * MODIFIER_SWEEP_DRAG_THRESHOLD_PX);
    if (!movedEnough) return false;

    modifierSweepSelectionState.active = true;

    modifierSweepSelectionState.candidateBookmarkEls = Array.from(document.querySelectorAll('.board-links li[data-bookmark-id]'));

    return true;
}

function handleModifierSweepSelectionMouseMove(event) {
    if (!modifierSweepSelectionState.pointerDown) return;
    if (isBlockingModalOpenForModifierSweep()) {
        resetModifierSweepSelectionState();
        return;
    }

    // Button released without a mouseup event.
    if ((event.buttons & 1) === 0) {
        const wasActive = modifierSweepSelectionState.active;
        resetModifierSweepSelectionState();
        if (wasActive) suppressBookmarkClickAfterSweepUntil = Date.now() + MODIFIER_SWEEP_CLICK_SUPPRESS_MS;
        return;
    }

    if (!isMultiSelectModifierPressed(event)) {
        const wasActive = modifierSweepSelectionState.active;
        resetModifierSweepSelectionState();
        if (wasActive) suppressBookmarkClickAfterSweepUntil = Date.now() + MODIFIER_SWEEP_CLICK_SUPPRESS_MS;
        return;
    }

    const activatedNow = maybeActivateModifierSweepSelection(event);
    if (!modifierSweepSelectionState.active && !activatedNow) return;

    modifierSweepSelectionState.currentClientX = event.clientX;
    modifierSweepSelectionState.currentClientY = event.clientY;
    modifierSweepSelectionState.currentX = event.clientX + window.scrollX;
    modifierSweepSelectionState.currentY = event.clientY + window.scrollY;
    event.preventDefault();
    const selectionRect = updateModifierSweepSelectionBox(
        modifierSweepSelectionState.currentX,
        modifierSweepSelectionState.currentY
    );
    applyModifierSweepSelectionByRect(selectionRect);
    updateModifierSweepAutoScroll(event.clientY);
}

function handleModifierSweepSelectionMouseUp(event) {
    if (!modifierSweepSelectionState.pointerDown) return;
    if (isBlockingModalOpenForModifierSweep()) {
        resetModifierSweepSelectionState();
        return;
    }

    modifierSweepSelectionState.currentClientX = event.clientX;
    modifierSweepSelectionState.currentClientY = event.clientY;
    modifierSweepSelectionState.currentX = event.clientX + window.scrollX;
    modifierSweepSelectionState.currentY = event.clientY + window.scrollY;
    const wasActive = modifierSweepSelectionState.active;
    if (wasActive) {
        const selectionRect = updateModifierSweepSelectionBox(
            modifierSweepSelectionState.currentX,
            modifierSweepSelectionState.currentY
        );
        applyModifierSweepSelectionByRect(selectionRect);
    }
    resetModifierSweepSelectionState();
    if (wasActive) {
        suppressBookmarkClickAfterSweepUntil = Date.now() + MODIFIER_SWEEP_CLICK_SUPPRESS_MS;
        event.preventDefault();
    }
}

function shouldUseModifierMultiSelect(event) {
    if (!event || event.defaultPrevented) return false;
    if (event.button !== undefined && event.button !== 0) return false;
    return isMultiSelectModifierPressed(event);
}

function handleModifierBookmarkSelectionClick(event) {
    if (Date.now() < suppressBookmarkClickAfterSweepUntil && getBookmarkSelectionListItemFromEvent(event)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
    }

    if (!shouldUseModifierMultiSelect(event)) return;

    const listItem = getBookmarkSelectionListItemFromEvent(event);
    if (!listItem) return;
    if (isBookmarkActionClickTarget(event.target)) return;

    if (!isSelectionMode) {
        toggleSelectionMode();
    }

    // Block native Shift-click text selection/navigation and keep this as selection intent.
    event.preventDefault();
    event.stopImmediatePropagation();
    toggleBookmarkSelectionForListItem(listItem);
}

// Toggle selection mode for multi-select drag
function toggleSelectionMode() {
    isSelectionMode = !isSelectionMode;

    const btn = document.getElementById('floatingSelectBtn');
    const selectionBar = document.getElementById('selectionBar');

    if (isSelectionMode) {
        document.body.classList.add('selection-mode');
        if (btn) {
            btn.classList.add('active');
            btn.title = 'Done selecting';
            // Change to checkmark icon
            btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
        }
        // Show selection bar and reset count
        if (selectionBar) selectionBar.classList.remove('hidden');
        updateSelectionCount();
    } else {
        document.body.classList.remove('selection-mode');
        if (btn) {
            btn.classList.remove('active');
            btn.title = 'Select multiple bookmarks';
            // Change back to select icon
            btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M17 14l2 2 4-4"/></svg>`;
        }
        clearBookmarkSelection();
        // Hide selection bar
        if (selectionBar) selectionBar.classList.add('hidden');
    }
}

// Global variables for arrow auto-scroll during drag
let arrowHoverInterval = null;  // Interval for repeated scrolling when hovering over arrows
let currentHoveredArrow = null; // Track which arrow is being hovered ('left' or 'right')

// Global variables for edge auto-scroll during drag (vertical scrolling near screen edges)
let autoScrollAnimationId = null;  // requestAnimationFrame ID for smooth scrolling
let autoScrollSpeed = 0;           // Current scroll speed (negative = up, positive = down)

// Global variables for delete confirmation
let pendingDeleteItem = null;   // Item awaiting deletion confirmation
let pendingDeleteType = null;   // 'board' or 'bookmark'
let originalItemPosition = null; // Store original position for restoration
let dragActivityThreshold = 2000; // 2 seconds of inactivity before allowing state reset

/*
========================================
AUTO-SCROLL DURING DRAG (EDGE DETECTION)
========================================
Automatically scrolls the page when dragging near top/bottom edges
*/

/**
 * Handle auto-scroll during drag operations when near screen edges
 * Called on dragover events while dragging boards or bookmarks
 */
function handleAutoScrollDuringDrag(e) {
    // Only when actively dragging a board or bookmark
    if (!draggedElement && !draggedBookmark && !draggedBoardId && !draggedBookmarkId) {
        stopAutoScroll();
        return;
    }

    const viewportHeight = window.innerHeight;
    const edgeThreshold = viewportHeight * 0.20;  // 20% of viewport
    const mouseY = e.clientY;

    // Calculate scroll speed based on proximity to edge
    // Closer to edge = faster scroll (max 15px per frame at ~60fps)
    let newScrollSpeed = 0;

    if (mouseY < edgeThreshold) {
        // Near top - scroll up (negative speed)
        const proximity = 1 - (mouseY / edgeThreshold);  // 0 at threshold, 1 at edge
        newScrollSpeed = -Math.ceil(proximity * 15);
    } else if (mouseY > viewportHeight - edgeThreshold) {
        // Near bottom - scroll down (positive speed)
        const distanceFromBottom = viewportHeight - mouseY;
        const proximity = 1 - (distanceFromBottom / edgeThreshold);
        newScrollSpeed = Math.ceil(proximity * 15);
    }

    // Only update if speed changed
    if (newScrollSpeed !== autoScrollSpeed) {
        autoScrollSpeed = newScrollSpeed;

        if (autoScrollSpeed !== 0) {
            startAutoScroll();
        } else {
            stopAutoScroll();
        }
    }
}

/**
 * Start the auto-scroll animation loop
 */
function startAutoScroll() {
    // Don't start if already running
    if (autoScrollAnimationId) return;

    function scrollStep() {
        // Check if we should still be scrolling
        if (autoScrollSpeed === 0) {
            stopAutoScroll();
            return;
        }

        window.scrollBy(0, autoScrollSpeed);
        autoScrollAnimationId = requestAnimationFrame(scrollStep);
    }

    autoScrollAnimationId = requestAnimationFrame(scrollStep);
}

/**
 * Stop the auto-scroll animation
 */
function stopAutoScroll() {
    if (autoScrollAnimationId) {
        cancelAnimationFrame(autoScrollAnimationId);
        autoScrollAnimationId = null;
    }
    autoScrollSpeed = 0;
}

/*
========================================
EVENT LISTENER SETUP
========================================
Attach drag and drop event listeners to all relevant elements
*/

// Function to attach drag and drop event listeners
function attachDragDropListeners() {
    // Skip if drag in progress ON THE SAME PAGE - morph was already deferred by protection
    // This prevents detaching listeners from elements mid-drag
    // BUT: For cross-page drags, we MUST attach listeners to the target page's elements
    if ((_isBookmarkDragInProgress || _isBoardDragInProgress) && currentPageId === dragOriginPageId) {
        return;
    }

    const boardTitles = document.querySelectorAll('.board-title');
    const bookmarks = document.querySelectorAll('li[data-bookmark-id]');

    // Board titles: Remove and re-attach after morph (DOM element may be replaced)
    boardTitles.forEach(boardTitle => {
        boardTitle.removeEventListener('dragstart', handleDragStart);
        boardTitle.removeEventListener('dragend', handleDragEnd);
        boardTitle.addEventListener('dragstart', handleDragStart); // When drag begins
        boardTitle.addEventListener('dragend', handleDragEnd);     // When drag ends
    });

    // Columns: Always remove and re-attach (only 4 elements, cheap operation)
    document.querySelectorAll('.column').forEach(column => {
        column.removeEventListener('dragover', handleDragOver);
        column.removeEventListener('drop', handleDrop);
        column.addEventListener('dragover', handleDragOver);  // While dragging over column
        column.addEventListener('drop', handleDrop);          // When dropping in column
    });

    // Bookmark items: Remove and re-attach after morph (DOM element may be replaced)
    bookmarks.forEach(bookmark => {
        bookmark.removeEventListener('dragstart', handleBookmarkDragStart);
        bookmark.removeEventListener('dragend', handleBookmarkDragEnd);
        bookmark.addEventListener('dragstart', handleBookmarkDragStart); // When bookmark drag begins
        bookmark.addEventListener('dragend', handleBookmarkDragEnd);     // When bookmark drag ends
    });

    // Bookmark lists: Remove and re-attach after morph (DOM element may be replaced)
    document.querySelectorAll('.board-links').forEach(bookmarkList => {
        bookmarkList.removeEventListener('dragover', handleBookmarkDragOver);
        bookmarkList.removeEventListener('drop', handleBookmarkDrop);
        bookmarkList.addEventListener('dragover', handleBookmarkDragOver); // While dragging over bookmark list
        bookmarkList.addEventListener('drop', handleBookmarkDrop);         // When dropping bookmark in list
    });

    // Add cross-page drag listeners to all page tabs
    attachPageTabDragListeners();

    // Add arrow auto-scroll listeners for dragging across many tabs
    const scrollLeftBtn = document.getElementById('scrollLeft');
    const scrollRightBtn = document.getElementById('scrollRight');
    if (scrollLeftBtn && scrollRightBtn) {
        if (!scrollLeftBtn._dragListenersAttached) {
            scrollLeftBtn.addEventListener('dragover', handleArrowDragOver);
            scrollLeftBtn.addEventListener('dragleave', handleArrowDragLeave);
            scrollLeftBtn._dragListenersAttached = true;
        }
        if (!scrollRightBtn._dragListenersAttached) {
            scrollRightBtn.addEventListener('dragover', handleArrowDragOver);
            scrollRightBtn.addEventListener('dragleave', handleArrowDragLeave);
            scrollRightBtn._dragListenersAttached = true;
        }
    }

    // Add global document listeners to handle invalid drop zones and cleanup
    setupGlobalDragHandlers();
}

/*
========================================
GLOBAL DRAG HANDLERS
========================================
Handle dragging outside valid drop zones and provide fallback cleanup
*/
function setupGlobalDragHandlers() {
    // Remove any existing global listeners to avoid duplicates
    document.removeEventListener('dragover', handleGlobalDragOver);
    document.removeEventListener('drop', handleGlobalDrop);
    document.removeEventListener('dragleave', handleGlobalDragLeave);

    // Add global document listeners
    document.addEventListener('dragover', handleGlobalDragOver);
    document.addEventListener('drop', handleGlobalDrop);
    document.addEventListener('dragleave', handleGlobalDragLeave);
}

// Handle dragover outside valid drop zones
function handleGlobalDragOver(e) {
    // Only handle when we're dragging something
    // Check both DOM elements AND IDs (for cross-page drags where elements are null)
    if (!draggedBookmark && !draggedElement && !draggedBoardId && !draggedBookmarkId) {
        return;
    }

    // Update drag activity tracking
    updateDragActivity();

    // Keep bookmark-create-board target in sync with cursor position during drag.
    if (isBookmarkDragActive()) {
        updateBookmarkDragPlaceholderPosition(e.clientX, e.clientY);
    }

    // Determine valid drop zones based on what we're dragging
    let isOverValidDropZone = false;

    if (isDraggingBookmark) {
        // For bookmarks, board links and add-board placeholders are valid.
        isOverValidDropZone = e.target.closest('.board-links') !== null ||
            e.target.closest('.add-board-placeholder') !== null;
    } else {
        // For boards, .column elements are valid
        isOverValidDropZone = e.target.closest('.column') !== null;
    }

    if (!isOverValidDropZone) {
        // We're outside valid drop zones - prevent drop and provide visual feedback
        e.preventDefault();
        e.dataTransfer.dropEffect = 'none';

        // Clean up any visible drop indicators but be selective (visual only)
        if (isDraggingBookmark) {
            // Remove bookmark drop indicators and drop zone styling
            document.querySelectorAll('.bookmark-drop-indicator').forEach(indicator => {
                indicator.remove();
            });
            document.querySelectorAll('.board-links.drop-zone').forEach(list => {
                list.classList.remove('drop-zone');
            });
        } else {
            // Remove board drop indicators
            document.querySelectorAll('.drop-indicator').forEach(indicator => {
                indicator.remove();
            });
        }
    }
}

// Handle drops outside valid zones
function handleGlobalDrop(e) {
    // Only handle when we're dragging bookmarks
    // Check both DOM element AND ID (for cross-page drags where element is null)
    if (!draggedBookmark && !draggedBookmarkId) {
        return;
    }

    // Check if we're dropping on a valid bookmark drop zone
    const validDropZone = e.target.closest('.board-links') || e.target.closest('.add-board-placeholder');

    if (!validDropZone) {
        // Invalid drop - prevent it and clean up
        e.preventDefault();
        e.stopPropagation();



        // Clean up all indicators
        cleanupAllDragIndicators();

        // The bookmark will stay in its original position since we don't move it
        return false;
    }
}

// Handle drag leave events for additional cleanup
function handleGlobalDragLeave(e) {
    // Only handle when we're dragging something and leaving the document
    // Check both DOM elements AND IDs (for cross-page drags where elements are null)
    if ((!draggedBookmark && !draggedElement && !draggedBoardId && !draggedBookmarkId) || e.target !== document.documentElement) {
        return;
    }

    // Clean up indicators when leaving the document area
    cleanupAllDragIndicators();
}

/*
========================================
CROSS-PAGE DRAG FUNCTIONALITY
========================================
Enable dragging boards and bookmarks across pages by hovering over tabs
*/

// Attach dragover and dragleave listeners to page tabs for cross-page drag
function attachPageTabDragListeners() {
    const tabs = document.querySelectorAll('.page-tab');
    tabs.forEach((tab, index) => {
        // Remove existing listeners to prevent duplicates (function is called multiple times)
        tab.removeEventListener('dragover', handlePageTabDragOver);
        tab.removeEventListener('dragleave', handlePageTabDragLeave);
        // Add fresh listeners
        tab.addEventListener('dragover', handlePageTabDragOver);
        tab.addEventListener('dragleave', handlePageTabDragLeave);
    });
}

// Handle dragover on arrow buttons during drag operations to enable auto-scroll
function handleArrowDragOver(e) {
    // Only handle when we're dragging something (board or bookmark)
    if (!draggedElement && !draggedBookmark && !draggedBoardId && !draggedBookmarkId) {
        return;
    }

    e.preventDefault();
    e.stopPropagation();

    if (isBookmarkDragActive()) {
        hideAddBoardPlaceholder();
    }

    // Determine which arrow is being hovered
    const arrowDirection = this.id === 'scrollLeft' ? 'left' : 'right';

    // If we're already hovering this same arrow, don't restart the interval
    if (currentHoveredArrow === arrowDirection) {
        return;
    }

    // Clear any existing interval from previous arrow
    if (arrowHoverInterval) {
        clearInterval(arrowHoverInterval);
    }

    // Update current hovered arrow
    currentHoveredArrow = arrowDirection;

    // Add visual feedback
    this.classList.add('drag-hover-active');

    // Get the tabs container
    const pageTabsContainer = document.getElementById('pageTabs');
    if (!pageTabsContainer) return;

    // Scroll immediately
    const scrollAmount = arrowDirection === 'left' ? -200 : 200;
    pageTabsContainer.scrollBy({ left: scrollAmount, behavior: 'smooth' });

    // Set interval to scroll every 1 second (1000ms)
    arrowHoverInterval = setInterval(() => {
        pageTabsContainer.scrollBy({ left: scrollAmount, behavior: 'smooth' });
    }, 1000);
}

// Handle dragleave on arrow buttons to stop auto-scroll
function handleArrowDragLeave(e) {
    // Check if we're actually leaving the arrow or just moving to a child element
    const relatedTarget = e.relatedTarget;

    // If relatedTarget is null or is not a child of this arrow, we're truly leaving
    if (!relatedTarget || !this.contains(relatedTarget)) {
        // Clear the interval to stop auto-scrolling
        if (arrowHoverInterval) {
            clearInterval(arrowHoverInterval);
            arrowHoverInterval = null;
        }

        // Remove visual feedback
        this.classList.remove('drag-hover-active');

        // Reset hover tracking
        currentHoveredArrow = null;
    }
}

// Handle dragover on page tabs during drag operations
function handlePageTabDragOver(e) {
    // Only handle when we're dragging something (board or bookmark)
    // Check both DOM elements AND IDs (for cross-page drags where elements are null)
    if (!draggedElement && !draggedBookmark && !draggedBoardId && !draggedBookmarkId) {
        // Nothing being dragged (e.g., tab reorder) - skip silently
        return;
    }

    e.preventDefault();
    e.stopPropagation();

    if (isBookmarkDragActive()) {
        hideAddBoardPlaceholder();
    }

    const targetPageId = this.dataset.pageId;

    // Don't switch if already on this page
    if (targetPageId === currentPageId) {
        return;
    }

    // If we're already hovering this same tab, don't reset the timeout!
    if (currentHoveredTabId === targetPageId) {
        return;
    }

    // We're entering a NEW tab - add visual feedback
    this.classList.add('drag-hover');

    // Clear any existing timeout from previous tab
    if (pageHoverTimeout) {
        clearTimeout(pageHoverTimeout);
    }

    // Update current hovered tab
    currentHoveredTabId = targetPageId;

    // Set timeout to switch page after 500ms of hovering
    pageHoverTimeout = setTimeout(async () => {
        await switchPageDuringDrag(targetPageId);
    }, 500);
}

// Handle dragleave on page tabs
function handlePageTabDragLeave(e) {
    // Only handle when we're dragging something (board or bookmark)
    if (!draggedElement && !draggedBookmark && !draggedBoardId && !draggedBookmarkId) {
        return;
    }

    // Check if we're actually leaving the tab or just moving to a child element
    const relatedTarget = e.relatedTarget;

    // If relatedTarget is null or is not a child of this tab, we're truly leaving
    if (!relatedTarget || !this.contains(relatedTarget)) {
        // Remove visual feedback
        this.classList.remove('drag-hover');

        // Reset current hovered tab
        currentHoveredTabId = null;

        // Cancel pending page switch
        if (pageHoverTimeout) {
            clearTimeout(pageHoverTimeout);
            pageHoverTimeout = null;
        }
    }
    // If relatedTarget is a child of this tab, ignore this dragleave event
}

// Switch to a different page while maintaining drag state
async function switchPageDuringDrag(targetPageId) {
    try {
        isPageSwitchingDuringDrag = true;

        // Switch to the target page (loads boards so user can see where to drop)
        // The drag state is preserved through draggedBoardId/draggedBookmarkId variables
        await switchToPage(targetPageId);

        // For cross-page drags, we DON'T restore draggedElement/draggedBookmark from DOM
        // because the element doesn't exist on the new page yet (it's still on the origin page)
        // We'll handle the actual move in the drop handler using the stored IDs
        // Keep draggedElement and draggedBookmark as null for cross-page drags
        // The drop handler will detect this and handle it specially
        draggedElement = null;
        draggedBookmark = null;

        // Reset currentHoveredTabId so we can hover another tab immediately
        currentHoveredTabId = null;

        isPageSwitchingDuringDrag = false;

    } catch (error) {
        console.error('[Cross-Page Drag] switchPageDuringDrag FAILED:', error);
        isPageSwitchingDuringDrag = false;
    }
}

/*
========================================
TRASH MANAGEMENT FUNCTIONS
========================================
Soft delete and restore operations for pages, boards, and bookmarks
Implements 30-day retention with automatic cleanup
*/

// Move item to trash (soft delete)
// FIX [Issue #3]: Wrap database operations in transaction to prevent inconsistent state on crash

// Initialize select button for multi-select mode
let selectFeatureInitialized = false;
function initSelectFeature() {
    if (selectFeatureInitialized) return;
    selectFeatureInitialized = true;

    const container = document.querySelector('.container');
    // Capture phase ensures modifier sweep/click selection wins before link navigation/incognito handlers.
    document.addEventListener('mousedown', beginModifierSweepSelection, true);
    document.addEventListener('mousemove', handleModifierSweepSelectionMouseMove, true);
    document.addEventListener('mouseup', handleModifierSweepSelectionMouseUp, true);
    window.addEventListener('blur', resetModifierSweepSelectionStateOnWindowBlur, true);
    document.addEventListener('visibilitychange', resetModifierSweepSelectionStateOnVisibilityChange, true);
    if (container) {
        container.addEventListener('click', handleModifierBookmarkSelectionClick, true);
    }

    const selectBtn = document.getElementById('floatingSelectBtn');
    if (selectBtn) {
        selectBtn.addEventListener('click', toggleSelectionMode);
    }

    // Selection bar Cancel button
    const cancelBtn = document.getElementById('selectionCancel');
    if (cancelBtn) {
        cancelBtn.addEventListener('click', () => {
            clearBookmarkSelection();
            toggleSelectionMode();
        });
    }

    // Selection bar Done button
    const doneBtn = document.getElementById('selectionDone');
    if (doneBtn) {
        doneBtn.addEventListener('click', toggleSelectionMode);
    }

    // Selection bar Delete button
    const deleteBtn = document.getElementById('selectionDelete');
    if (deleteBtn) {
        deleteBtn.addEventListener('click', async () => {
            await deleteSelectedBookmarks();
        });
    }

    // Privacy blur button
    const privacyBtn = document.getElementById('floatingPrivacyBtn');
    if (privacyBtn) {
        privacyBtn.addEventListener('click', togglePrivacyMode);
    }

    // Incognito mode button
    const incognitoBtn = document.getElementById('floatingIncognitoBtn');
    if (incognitoBtn) {
        incognitoBtn.addEventListener('click', toggleIncognitoMode);
    }
}

function handleDragStart(e) {
    // Block drag in read-only mode (grace/expired status)
    if (!canModify()) {
        e.preventDefault();
        return false;
    }

    // Hide add-board placeholder during drag
    hideAddBoardPlaceholder();

    // Store references to the dragged title element and find the board
    const titleElement = this;                     // 'this' refers to the board title being dragged
    const boardElement = titleElement.parentNode; // Find the parent board element
    draggedElement = boardElement;                 // Store the board (not title) for positioning
    draggedFromColumn = boardElement.parentNode;   // Store the original column for reference
    isDraggingBookmark = false;                    // This is a board drag

    // Store origin page ID and board ID for cross-page drag detection
    dragOriginPageId = currentPageId;
    draggedBoardId = boardElement.dataset.boardId;



    // Set flag to defer any loadBoardsFromDatabase calls during drag
    _isBoardDragInProgress = true;

    // Initialize drag activity tracking
    updateDragActivity();

    // Add visual feedback class to show the title is being dragged
    titleElement.classList.add('dragging');
    // CRITICAL: Also add to board element so .board:not(.dragging) selectors work
    boardElement.classList.add('dragging');

    // Create custom drag image with background for better visual feedback
    const dragGhost = titleElement.cloneNode(true);
    const ghostBoardRgb = getThemeTokenValue('--ll-board-bg-rgb', '41, 46, 61');
    const ghostBoardOpacity = getThemeTokenValue('--ll-board-bg-opacity', '0.5');
    const ghostBackground = `rgba(${ghostBoardRgb}, ${ghostBoardOpacity})`;
    const ghostBorder = getThemeTokenValue('--ll-border-soft', 'rgba(255, 255, 255, 0.1)');
    const ghostShadow = getThemeTokenValue('--ll-shadow-sm', '0 4px 12px rgba(0, 0, 0, 0.3)');
    const ghostTextColor = getThemeTokenValue('--ll-board-text-color', '#B8C5D1');
    const ghostBlur = getThemeTokenValue('--ll-board-backdrop-blur', '16px');
    const ghostSaturate = getThemeTokenValue('--ll-board-backdrop-saturate', '120%');
    dragGhost.style.position = 'absolute';
    dragGhost.style.top = '-1000px'; // Position off-screen
    dragGhost.style.left = '-1000px';
    dragGhost.style.backgroundColor = ghostBackground;
    dragGhost.style.color = ghostTextColor;
    dragGhost.style.padding = '10px 15px';
    dragGhost.style.borderRadius = '10px';
    dragGhost.style.border = `1px solid ${ghostBorder}`;
    dragGhost.style.boxShadow = ghostShadow;
    dragGhost.style.width = titleElement.offsetWidth + 'px'; // Match original width
    dragGhost.style.opacity = '1';
    dragGhost.style.backdropFilter = `blur(${ghostBlur}) saturate(${ghostSaturate})`;
    dragGhost.style.webkitBackdropFilter = `blur(${ghostBlur}) saturate(${ghostSaturate})`;
    document.body.appendChild(dragGhost);

    // Set the custom drag image (centered on cursor)
    const offsetX = dragGhost.offsetWidth / 2;
    const offsetY = dragGhost.offsetHeight / 2;
    e.dataTransfer.setDragImage(dragGhost, offsetX, offsetY);

    // Remove the drag ghost after a short delay (browser has already captured it)
    setTimeout(() => {
        document.body.removeChild(dragGhost);
    }, 0);

    // Set up emergency cleanup as safety net
    setupEmergencyCleanup();

    // Add auto-scroll listener for edge detection during drag
    document.addEventListener('dragover', handleAutoScrollDuringDrag);

    // Configure the drag operation
    e.dataTransfer.effectAllowed = 'move';                      // Only allow move operations
    e.dataTransfer.setData('text/html', boardElement.outerHTML); // Store board HTML (for compatibility)
}

function handleBookmarkDragStart(e) {



    // Block drag in read-only mode (grace/expired status)
    if (!canModify()) {

        e.preventDefault();
        return false;
    }

    // Modifier-based sweep selection should never initiate bookmark DnD.
    if (modifierSweepSelectionState.pointerDown || modifierSweepSelectionState.active || isMultiSelectModifierPressed(e)) {
        e.preventDefault();
        return false;
    }

    // Hide add-board placeholder during drag
    hideAddBoardPlaceholder();

    // Set flag to defer DOM re-renders during drag (prevents visual glitches)
    _isBookmarkDragInProgress = true;

    // Store references to the dragged bookmark and its original board
    draggedBookmark = this;                          // 'this' refers to the bookmark <li> being dragged
    draggedFromBoard = this.closest('.board');       // Find the parent board
    isDraggingBookmark = true;                       // This is a bookmark drag



    // Handle multi-select: if dragging a non-selected item, clear selection and select just this one
    const bookmarkId = this.dataset.bookmarkId;
    if (!selectedBookmarks.has(bookmarkId)) {
        clearBookmarkSelection();
        selectedBookmarks.add(bookmarkId);
        this.classList.add('selected');
    }

    // Store origin page ID and bookmark ID for cross-page drag detection
    dragOriginPageId = currentPageId;
    draggedBookmarkId = bookmarkId;



    // Initialize drag activity tracking
    updateDragActivity();

    // Add visual feedback classes
    this.classList.add('dragging');
    document.body.classList.add('dragging-bookmark');

    // Show count badge if multiple selected
    if (selectedBookmarks.size > 1) {
        this.classList.add('multi-drag');
        this.dataset.dragCount = selectedBookmarks.size;
    }

    // Set up emergency cleanup as safety net
    setupEmergencyCleanup();

    // Add auto-scroll listener for edge detection during drag
    document.addEventListener('dragover', handleAutoScrollDuringDrag);

    // Configure the drag operation
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/html', this.outerHTML);

    // Prevent the event from bubbling up to the board
    e.stopPropagation();
}

/*
========================================
DRAG END HANDLERS
========================================
Called when drag operation completes (success or failure)
*/
function handleDragEnd(e) {
    // Remove the visual dragging effect from the title
    this.classList.remove('dragging');
    // CRITICAL: Also remove from board element (added in handleDragStart for selector compatibility)
    const boardElement = this.closest('.board');
    if (boardElement) {
        boardElement.classList.remove('dragging');
    }

    // Remove drag-hover class from all tabs (immediate visual cleanup)
    document.querySelectorAll('.page-tab.drag-hover').forEach(tab => {
        tab.classList.remove('drag-hover');
    });

    // Clean up arrow auto-scroll (immediate)
    if (arrowHoverInterval) {
        clearInterval(arrowHoverInterval);
        arrowHoverInterval = null;
    }
    currentHoveredArrow = null;
    document.querySelectorAll('.nav-arrow.drag-hover-active').forEach(arrow => {
        arrow.classList.remove('drag-hover-active');
    });

    // Stop edge auto-scroll and remove listener
    stopAutoScroll();
    document.removeEventListener('dragover', handleAutoScrollDuringDrag);

    // Clear board drag flag BEFORE cleanup so cleanupAllDragIndicators can run
    // This must happen before cleanup, but AFTER all drag event processing is done
    _isBoardDragInProgress = false;

    // Use comprehensive cleanup function (immediate visual cleanup)
    cleanupAllDragIndicators();

    // Reset global drag state variables (immediate)
    draggedElement = null;
    draggedFromColumn = null;

    // DELAY cross-page drag state cleanup to allow handleDrop to complete first
    // The drop event may fire after dragend, so we need to keep IDs available briefly
    setTimeout(async () => {
        dragOriginPageId = null;
        currentHoveredTabId = null;
        draggedBoardId = null;
        draggedBookmarkId = null;
        if (pageHoverTimeout) {
            clearTimeout(pageHoverTimeout);
            pageHoverTimeout = null;
        }

        // Run any pending loadBoardsFromDatabase that was deferred during drag
        if (_loadBoardsPendingAfterDrag) {
            _loadBoardsPendingAfterDrag = false;

            await loadBoardsFromDatabase();
        }
    }, 100); // 100ms delay ensures drop handler can access the IDs
}

function handleBookmarkDragEnd(e) {
    // Remove the visual dragging effect
    this.classList.remove('dragging', 'multi-drag');
    delete this.dataset.dragCount;

    // Remove drag-hover class from all tabs (immediate visual cleanup)
    document.querySelectorAll('.page-tab.drag-hover').forEach(tab => {
        tab.classList.remove('drag-hover');
    });

    // Clean up arrow auto-scroll (immediate)
    if (arrowHoverInterval) {
        clearInterval(arrowHoverInterval);
        arrowHoverInterval = null;
    }
    currentHoveredArrow = null;
    document.querySelectorAll('.nav-arrow.drag-hover-active').forEach(arrow => {
        arrow.classList.remove('drag-hover-active');
    });

    // Stop edge auto-scroll and remove listener
    stopAutoScroll();
    document.removeEventListener('dragover', handleAutoScrollDuringDrag);

    // Clear bookmark drag flag BEFORE cleanup so cleanupAllDragIndicators can run
    // This must happen before cleanup, but AFTER all drag event processing is done
    _isBookmarkDragInProgress = false;

    // Use comprehensive cleanup function (immediate visual cleanup)
    cleanupAllDragIndicators();

    // Restore non-drag placeholder behavior immediately after bookmark drag ends.
    if (pageHasBoards) {
        hideAddBoardPlaceholder();
    } else {
        showAddBoardPlaceholder(0);
    }

    // Clear selection after drag ends (unless in selection mode)
    // This handles failed drops where handleBookmarkDrop never fires
    if (!isSelectionMode) {
        clearBookmarkSelection();
    }

    // Reset bookmark drag state variables (immediate)
    draggedBookmark = null;
    draggedFromBoard = null;
    isDraggingBookmark = false;

    // DELAY cross-page drag state cleanup to allow handleBookmarkDrop to complete first
    // The drop event may fire after dragend, so we need to keep IDs available briefly
    setTimeout(async () => {
        dragOriginPageId = null;
        currentHoveredTabId = null;
        draggedBoardId = null;
        draggedBookmarkId = null;
        if (pageHoverTimeout) {
            clearTimeout(pageHoverTimeout);
            pageHoverTimeout = null;
        }

        // Run any pending loadBoardsFromDatabase that was deferred during drag
        if (_loadBoardsPendingAfterBookmarkDrag) {
            _loadBoardsPendingAfterBookmarkDrag = false;

            await loadBoardsFromDatabase();
        }
    }, 100); // 100ms delay ensures drop handler can access the IDs
}

/*
========================================
VISUAL CLEANUP FUNCTION
========================================
Cleans up only visual indicators without affecting drag state variables
*/
function cleanupVisualDragIndicators() {
    // Clean up all board drop indicators
    document.querySelectorAll('.drop-indicator').forEach(indicator => {
        indicator.remove();
    });

    // Clean up all bookmark drop indicators
    document.querySelectorAll('.bookmark-drop-indicator').forEach(indicator => {
        indicator.remove();
    });

    // Remove drop zone styling from all bookmark lists
    document.querySelectorAll('.board-links.drop-zone').forEach(list => {
        list.classList.remove('drop-zone');
    });

    // Reset add-board placeholder visual state from drag mode.
    document.querySelectorAll('.add-board-placeholder').forEach(placeholder => {
        setAddBoardPlaceholderMode(placeholder, false);
    });
    setAddBoardPlaceholderDragHoverState(null, false);

    // Remove active classes from any remaining indicators
    document.querySelectorAll('.drop-indicator.active, .bookmark-drop-indicator.active').forEach(indicator => {
        indicator.classList.remove('active');
        indicator.remove();
    });

    // Remove dragging classes from any elements that might still have them
    // BUT skip if a new drag is already in progress (prevents race condition where
    // user starts drag 2 while drag 1's cleanup is still running)
    if (!_isBookmarkDragInProgress && !_isBoardDragInProgress) {
        document.querySelectorAll('.dragging').forEach(element => {
            element.classList.remove('dragging');
        });
    }

    // NOTE: Delete zone is NOT hidden here - it should stay visible during drag
    // Only hide it when drag actually ends (in handleDragEnd/handleBookmarkDragEnd)

    // Remove body drag classes for visual feedback
    document.body.classList.remove('dragging-bookmark');
}

/*
========================================
COMPREHENSIVE CLEANUP FUNCTION
========================================
Cleans up all drag indicators, drop zones, and drag states
*/
function cleanupAllDragIndicators() {
    // CRITICAL: Skip cleanup if a NEW drag has already started
    // This prevents race condition where:
    // 1. User completes drag 1, which triggers async save
    // 2. User immediately starts drag 2
    // 3. Drag 1's cleanup runs and would clear drag 2's state
    if (_isBookmarkDragInProgress || _isBoardDragInProgress) {

        return;
    }

    // Clear any existing cleanup timeout
    if (dragCleanupTimeout) {
        clearTimeout(dragCleanupTimeout);
        dragCleanupTimeout = null;
    }

    // Stop edge auto-scroll (safety net for edge cases)
    stopAutoScroll();
    document.removeEventListener('dragover', handleAutoScrollDuringDrag);

    // First clean up visual elements
    cleanupVisualDragIndicators();

    // Then reset drag state variables
    resetDragState();
}

/*
========================================
DRAG STATE RESET FUNCTION
========================================
Resets all drag state variables
*/
function resetDragState() {
    draggedElement = null;
    draggedFromColumn = null;
    draggedBookmark = null;
    draggedFromBoard = null;
    isDraggingBookmark = false;
    lastDragActivity = null;

    // Also clear the render-blocking flags that defer loadBoardsFromDatabase
    // These can get stuck if dragend event doesn't fire properly
    _isBoardDragInProgress = false;
    _isBookmarkDragInProgress = false;
    _loadBoardsPendingAfterDrag = false;
    _loadBoardsPendingAfterBookmarkDrag = false;
}

/*
========================================
EMERGENCY CLEANUP FUNCTION
========================================
Sets up a timeout-based cleanup as a safety net for edge cases
*/
function setupEmergencyCleanup() {
    // Clear any existing timeout
    if (dragCleanupTimeout) {
        clearTimeout(dragCleanupTimeout);
    }

    // Set up emergency cleanup after 15 seconds (increased from 5)
    dragCleanupTimeout = setTimeout(() => {


        // Check if there has been recent drag activity
        const now = Date.now();
        const timeSinceLastActivity = lastDragActivity ? (now - lastDragActivity) : Infinity;

        if (timeSinceLastActivity > dragActivityThreshold) {
            // No recent activity, safe to reset everything

            cleanupAllDragIndicators();
        } else {
            // Recent activity detected, only clean up visuals but keep drag state

            cleanupVisualDragIndicators();

            // Set up another cleanup check in a few seconds
            setupEmergencyCleanup();
        }
    }, 15000); // Increased from 5000ms to 15000ms
}

/*
========================================
DRAG ACTIVITY TRACKING
========================================
Updates the last drag activity timestamp
*/
function updateDragActivity() {
    lastDragActivity = Date.now();
}

/*
========================================
DRAG OVER HANDLERS
========================================
Called continuously while dragging over a column or bookmark list
Shows visual feedback of where the element will be dropped
*/
function handleDragOver(e) {
    // Only handle board dragging in this function
    if (isDraggingBookmark) {
        return;
    }

    // For cross-page drags, draggedElement might be null but draggedBoardId will be set
    // Allow dragover to proceed for both same-page and cross-page drags
    if (!draggedElement && !draggedBoardId) {
        return;
    }

    // Update drag activity tracking
    updateDragActivity();

    // Prevent default to allow drop (required for HTML5 drag and drop)
    if (e.preventDefault) {
        e.preventDefault();
    }

    // Set the visual drop effect
    e.dataTransfer.dropEffect = 'move';

    // Calculate where the board should be inserted based on mouse position
    const afterElement = getDragAfterElement(this, e.clientY);

    // Remove any existing active drop indicator
    const dropIndicator = document.querySelector('.drop-indicator.active');
    if (dropIndicator) {
        dropIndicator.classList.remove('active');
    }

    // Create and position the drop indicator
    const indicator = getOrCreateDropIndicator();

    if (afterElement == null) {
        // If no element found, insert at the end of the column
        this.appendChild(indicator);
    } else {
        // Insert the indicator before the calculated element
        this.insertBefore(indicator, afterElement);
    }

    // Make the indicator visible
    indicator.classList.add('active');

    return false; // Prevent default browser behavior
}

function handleBookmarkDragOver(e) {
    // Only handle bookmark dragging in this function
    if (!isDraggingBookmark) {
        return;
    }

    // For cross-page drags, draggedBookmark might be null but draggedBookmarkId will be set
    // Also handles case where morph replaced DOM element mid-drag (stale reference)
    // Allow dragover to proceed for both same-page and cross-page drags
    if (!draggedBookmark && draggedBookmarkId) {
        // Try to recover the element reference using UUID (may have been replaced by morph)
        draggedBookmark = document.querySelector(`li[data-bookmark-id="${draggedBookmarkId}"]`);
        if (draggedBookmark) {

        }
    }
    if (!draggedBookmark && !draggedBookmarkId) {
        return;
    }

    // Update drag activity tracking
    updateDragActivity();

    // Validate this is a proper bookmark list target
    if (!this.classList.contains('board-links')) {
        e.dataTransfer.dropEffect = 'none';
        return;
    }

    // Prevent default to allow drop
    if (e.preventDefault) {
        e.preventDefault();
    }

    // Set the visual drop effect
    e.dataTransfer.dropEffect = 'move';

    // Clear drop zone styling from other lists first
    document.querySelectorAll('.board-links.drop-zone').forEach(list => {
        if (list !== this) {
            list.classList.remove('drop-zone');
        }
    });

    // Add drop zone styling to the current bookmark list
    this.classList.add('drop-zone');

    // Calculate where the bookmark should be inserted
    const afterElement = getBookmarkDragAfterElement(this, e.clientY);

    // Remove any existing active bookmark drop indicator
    const existingIndicators = document.querySelectorAll('.bookmark-drop-indicator.active');
    existingIndicators.forEach(indicator => {
        indicator.classList.remove('active');
        if (indicator.parentNode !== this) {
            indicator.remove();
        }
    });

    // Create and position the bookmark drop indicator
    const indicator = getOrCreateBookmarkDropIndicator();

    if (afterElement == null) {
        // If no element found, insert at the end of the list
        this.appendChild(indicator);
    } else {
        // Insert the indicator before the calculated element
        this.insertBefore(indicator, afterElement);
    }

    // Make the indicator visible
    indicator.classList.add('active');

    return false;
}

function getDraggedBookmarkIdsForDrop() {
    if (selectedBookmarks.size > 1) {
        const selectedElements = Array.from(document.querySelectorAll('li[data-bookmark-id].selected'));

        // Same-page drags: preserve visual order for deterministic placement.
        if (selectedElements.length === selectedBookmarks.size) {
            selectedElements.sort((a, b) => {
                const aRect = a.getBoundingClientRect();
                const bRect = b.getBoundingClientRect();
                if (aRect.top !== bRect.top) return aRect.top - bRect.top;
                return aRect.left - bRect.left;
            });
            return selectedElements
                .map(el => el.getAttribute('data-bookmark-id'))
                .filter(id => !!id);
        }

        // Cross-page fallback: deterministic order without relying on source DOM.
        return Array.from(selectedBookmarks).sort((a, b) => a.localeCompare(b));
    }

    if (draggedBookmarkId) {
        return [draggedBookmarkId];
    }

    const draggedId = draggedBookmark?.getAttribute?.('data-bookmark-id');
    return draggedId ? [draggedId] : [];
}

function handleAddBoardPlaceholderDragOver(e) {
    if (!isBookmarkDragActive()) {
        return;
    }

    if (e.preventDefault) {
        e.preventDefault();
    }
    if (e.stopPropagation) {
        e.stopPropagation();
    }

    updateDragActivity();
    e.dataTransfer.dropEffect = 'move';

    // Clear bookmark list indicators while targeting add-board placeholder.
    document.querySelectorAll('.bookmark-drop-indicator').forEach(indicator => indicator.remove());
    document.querySelectorAll('.board-links.drop-zone').forEach(list => list.classList.remove('drop-zone'));

    setAddBoardPlaceholderMode(this, true);
    setAddBoardPlaceholderDragHoverState(this, true);
}

async function createBoardAndMoveDraggedBookmarks(targetColumnIndex) {
    if (!canModify()) {
        return false;
    }

    const bookmarkIds = Array.from(new Set(getDraggedBookmarkIdsForDrop()));
    if (bookmarkIds.length === 0) {
        showGlassToast('Could not determine bookmark to move.', 'error');
        return false;
    }

    const hadMultiSelection = selectedBookmarks.size > 1;

    try {
        const syncScope = await ensureLocalMutationSyncScopeAllowed({
            contextLabel: 'createBoardAndMoveDraggedBookmarks'
        });
        if (!syncScope.allowed) {
            return false;
        }

        const limitCheck = checkBoardLimit(1);
        if (!limitCheck.allowed) {
            showGlassToast(limitCheck.warning, 'error');
            return false;
        }

        const bookmarksToMoveRaw = await db.bookmarks.where('id').anyOf(bookmarkIds).toArray();
        const bookmarkById = new Map(bookmarksToMoveRaw.map(bookmark => [bookmark.id, bookmark]));
        const bookmarksToMove = bookmarkIds.filter(id => {
            const bookmark = bookmarkById.get(id);
            return !!bookmark && !bookmark.deletedAt;
        });

        if (bookmarksToMove.length === 0) {
            showGlassToast('No active bookmarks available to move.', 'error');
            return false;
        }

        const boardsInColumn = await db.boards
            .where('pageId')
            .equals(currentPageId)
            .filter(board => !board.deletedAt && board.columnIndex === targetColumnIndex)
            .toArray();

        const newBoardOrder = boardsInColumn.length > 0
            ? Math.max(...boardsInColumn.map(board => board.order || 0)) + 1
            : 0;
        const newBoardId = generateId();
        const createdBoard = {
            id: newBoardId,
            ...withTimestamps({
                name: 'New Board',
                columnIndex: targetColumnIndex,
                order: newBoardOrder,
                description: null,
                pageId: currentPageId
            })
        };

        const sourceBoardIds = new Set(
            bookmarksToMove
                .map(id => bookmarkById.get(id)?.boardId)
                .filter(boardId => !!boardId)
        );
        const sourceBoardIdList = Array.from(sourceBoardIds);

        const sourceBoardBookmarksBefore = sourceBoardIdList.length > 0
            ? await db.bookmarks.where('boardId').anyOf(sourceBoardIdList).filter(bookmark => !bookmark.deletedAt).toArray()
            : [];
        const bookmarkBeforeById = createUndoRedoSnapshotMap(sourceBoardBookmarksBefore);

        const now = getCurrentTimestamp();
        const reorderedBookmarkIds = new Set();

        await db.transaction('rw', db.boards, db.bookmarks, async () => {
            await db.boards.add(createdBoard);

            // Move dragged bookmarks to the new board in deterministic order.
            for (let i = 0; i < bookmarksToMove.length; i++) {
                await db.bookmarks.update(bookmarksToMove[i], {
                    boardId: newBoardId,
                    order: i,
                    updatedAt: now
                });
            }

            // Reindex source boards after removal to keep contiguous order values.
            for (const sourceBoardId of sourceBoardIds) {
                const remainingBookmarks = await db.bookmarks
                    .where('boardId')
                    .equals(sourceBoardId)
                    .filter(bookmark => !bookmark.deletedAt)
                    .sortBy('order');

                for (let i = 0; i < remainingBookmarks.length; i++) {
                    await db.bookmarks.update(remainingBookmarks[i].id, {
                        order: i,
                        updatedAt: now
                    });
                    reorderedBookmarkIds.add(remainingBookmarks[i].id);
                }
            }
        });

        boardCount++;

        const bookmarkIdsToSync = new Set([...bookmarksToMove, ...reorderedBookmarkIds]);
        const bookmarkAfterById = await collectUndoRedoSnapshotsByIds('bookmarks', Array.from(bookmarkIdsToSync));
        const ops = [
            { table: 'boards', id: newBoardId, before: null, after: createdBoard },
            ...buildUndoRedoOpsFromSnapshotMaps('bookmarks', bookmarkBeforeById, bookmarkAfterById)
        ];
        const queueAttempt = await queueSyncItemsAtomically(
            [
                {
                    op: 'upsert',
                    table: 'boards',
                    id: newBoardId,
                    data: createdBoard
                },
                ...ops
                    .filter(op => op.table === 'bookmarks' && op.after)
                    .map(op => ({
                        op: 'upsert',
                        table: 'bookmarks',
                        id: op.id,
                        data: op.after
                    }))
            ],
            { contextLabel: 'createBoardAndMoveDraggedBookmarks' }
        );
        if (!queueAttempt.success) {
            await rollbackLocalMutationOps(ops);
            showGlassToast(queueAttempt.error || 'Failed to create board from bookmark drop. Please try again.', 'error');
            await loadBoardsFromDatabase();
            return false;
        }

        if (!isApplyingUndoRedoHistory) {
            await recordUndoRedoHistoryEntry({
                kind: 'bookmark_create_board_drop',
                label: bookmarksToMove.length === 1
                    ? 'Move 1 bookmark to new board'
                    : `Move ${bookmarksToMove.length} bookmarks to new board`,
                ops
            });
        }

        if (limitCheck.warning && typeof BOARD_WARNING_THRESHOLD !== 'undefined' && boardCount === BOARD_WARNING_THRESHOLD + 1) {
            showGlassToast(limitCheck.warning, 'info');
        } else if (limitCheck.warning && typeof BOARD_CRITICAL_THRESHOLD !== 'undefined' && boardCount === BOARD_CRITICAL_THRESHOLD + 1) {
            showGlassToast(limitCheck.warning, 'warning');
        }

        clearBookmarkSelection();
        if (hadMultiSelection && isSelectionMode) {
            toggleSelectionMode();
        }

        pageHasBoards = true;
        hideAddBoardPlaceholder();
        await loadBoardsFromDatabase();

        broadcastDataChange('bookmarkDropCreateBoard');
        return true;
    } catch (error) {
        console.error('Failed to create board from bookmark drop:', error);
        showGlassToast('Failed to create board from bookmark drop. Please try again.', 'error');
        return false;
    } finally {
        cleanupAllDragIndicators();
    }
}

async function handleAddBoardPlaceholderDrop(e) {
    // Only handle bookmark dropping in this flow.
    if (!isDraggingBookmark) {
        return;
    }

    if (!canModify()) {
        showGlassToast('Cannot move bookmarks in read-only mode.', 'warning');
        cleanupAllDragIndicators();
        return false;
    }

    if (e.preventDefault) {
        e.preventDefault();
    }
    if (e.stopPropagation) {
        e.stopPropagation();
    }

    const targetColumnIndex = parseInt(this.dataset.targetColumn, 10);
    if (isNaN(targetColumnIndex)) {
        cleanupAllDragIndicators();
        return false;
    }

    await createBoardAndMoveDraggedBookmarks(targetColumnIndex);
    return false;
}

/*
========================================
DROP HANDLERS
========================================
Called when user releases the dragged element over a drop zone
Actually moves the element to the new position and saves to database
*/

// Handle cross-page board drop (board moved from one page to another)
async function handleCrossPageBoardDrop(e, targetColumn) {
    // Block in read-only mode
    if (!canModify()) return false;

    try {
        const syncScope = await ensureLocalMutationSyncScopeAllowed({
            contextLabel: 'handleCrossPageBoardDrop'
        });
        if (!syncScope.allowed) {
            return false;
        }

        const targetColumnIndex = parseInt(targetColumn.getAttribute('data-column'));


        // First, verify the dragged board exists in the database
        const draggedBoard = await db.boards.get(draggedBoardId);
        if (!draggedBoard) {
            console.error(`  ERROR: Dragged board ${draggedBoardId} not found in database!`);
            throw new Error(`Board ${draggedBoardId} not found in database`);
        }

        const originPageId = draggedBoard.pageId || dragOriginPageId;
        const originColumnIndex = Number.isFinite(draggedBoard.columnIndex)
            ? draggedBoard.columnIndex
            : parseInt(draggedBoard.columnIndex, 10);

        // Calculate the position in the target column based on drop location
        const afterElement = getDragAfterElement(targetColumn, e.clientY);

        // Get all boards in target column from DATABASE for proper order calculation
        const boardsInTargetColumn = await db.boards
            .where('pageId').equals(currentPageId)
            .filter(b => !b.deletedAt && b.columnIndex === targetColumnIndex && b.id !== draggedBoardId)
            .sortBy('order');
        const originColumnBoards = originPageId && !Number.isNaN(originColumnIndex)
            ? await db.boards
                .where('pageId').equals(originPageId)
                .filter(board => !board.deletedAt && board.columnIndex === originColumnIndex && board.id !== draggedBoardId)
                .sortBy('order')
            : [];
        const boardBeforeById = createUndoRedoSnapshotMap([
            draggedBoard,
            ...boardsInTargetColumn,
            ...originColumnBoards
        ]);
        const changedBoardIds = new Set([draggedBoardId]);

        let newOrder = 0;

        if (afterElement == null) {
            // Dropping at the end - get max order + 1
            if (boardsInTargetColumn.length > 0) {
                newOrder = Math.max(...boardsInTargetColumn.map(b => b.order)) + 1;
            } else {
                newOrder = 0;
            }
        } else {
            // Find the order of the board we're inserting before
            const afterBoardId = afterElement.closest('.board')?.getAttribute('data-board-id') || null;
            if (afterBoardId) {
                const afterBoard = boardsInTargetColumn.find(b => b.id === afterBoardId);
                if (afterBoard) {
                    newOrder = afterBoard.order;
                }
            }
        }




        const now = getCurrentTimestamp();

        await db.transaction('rw', db.boards, async () => {
            // Increment order of boards that need to shift down to make room.
            for (const board of boardsInTargetColumn) {
                if (board.order >= newOrder) {
                    await db.boards.update(board.id, {
                        order: board.order + 1,
                        updatedAt: now
                    });
                    changedBoardIds.add(board.id);
                }
            }

            // Now update the dragged board with its new position.
            await db.boards.update(draggedBoardId, {
                pageId: currentPageId,
                columnIndex: targetColumnIndex,
                order: newOrder,
                updatedAt: now
            });

            // Reindex the origin column after removing the moved board.
            for (let i = 0; i < originColumnBoards.length; i++) {
                await db.boards.update(originColumnBoards[i].id, {
                    order: i,
                    updatedAt: now
                });
                changedBoardIds.add(originColumnBoards[i].id);
            }
        });

        const boardAfterById = await collectUndoRedoSnapshotsByIds('boards', Array.from(changedBoardIds));
        const boardOps = buildUndoRedoOpsFromSnapshotMaps('boards', boardBeforeById, boardAfterById);
        const queueAttempt = await queueSyncItemsAtomically(
            boardOps
                .filter(op => op.after)
                .map(op => ({
                    op: 'upsert',
                    table: 'boards',
                    id: op.id,
                    data: op.after
                })),
            { contextLabel: 'handleCrossPageBoardDrop' }
        );
        if (!queueAttempt.success) {
            await rollbackLocalMutationOps(boardOps);
            showGlassToast(queueAttempt.error || 'Failed to move board to new page. Please try again.', 'error');
            await loadBoardsFromDatabase();
            return false;
        }

        if (!isApplyingUndoRedoHistory) {
            await recordUndoRedoHistoryEntry({
                kind: 'board_move_cross_page',
                label: `Move board "${draggedBoard.name || 'Untitled'}"`,
                ops: boardOps
            });
        }



        // Reload the current page FIRST to show the moved board immediately

        // IMPORTANT: Explicitly set pageHasBoards and hide placeholder before render
        // Prevents race condition where placeholder could still be clickable during render
        pageHasBoards = true;
        hideAddBoardPlaceholder();
        await loadBoardsFromDatabase();

        broadcastDataChange('crossPageBoardDrop');
        return true;
    } catch (error) {
        console.error('[Cross-Page Drag] handleCrossPageBoardDrop FAILED:', error);
        showGlassToast('Failed to move board to new page. Please try again.', 'error');
        return false;
    } finally {
        // Clean up drag indicators
        cleanupAllDragIndicators();
    }
}

async function handleDrop(e) {
    // Only handle board dropping in this function
    if (isDraggingBookmark) {
        return;
    }

    // FIX: Check if user can modify (subscription status check)
    if (!canModify()) {
        showGlassToast('Cannot move boards in read-only mode.', 'warning');
        cleanupAllDragIndicators();
        return;
    }

    // Prevent event bubbling
    if (e.stopPropagation) {
        e.stopPropagation();
    }





    // Check if this is a cross-page drop
    const isCrossPageDrop = dragOriginPageId !== null && dragOriginPageId !== currentPageId;

    if (isCrossPageDrop) {

        await handleCrossPageBoardDrop(e, this);
        return false;
    }

    if (!draggedElement) {
        console.warn('[Drag] Dropping board without an active draggedElement; cleaning up stale drag state.');
        cleanupAllDragIndicators();
        return false;
    }

    // Normal same-page drop logic
    // Only proceed if we're dropping onto a different element
    if (draggedElement !== this) {
        // Get current position before any DOM manipulation
        const currentColumn = draggedElement.parentNode;
        const currentIndex = getElementIndex(draggedElement);
        const targetColumn = this;

        // Calculate the exact position where the board should be inserted
        const afterElement = getDragAfterElement(this, e.clientY);

        // Calculate target index
        let targetIndex;
        if (afterElement == null) {
            // Dropping at the end of the column
            targetIndex = targetColumn.children.length - 1; // -1 because we haven't removed the dragged element yet
        } else {
            targetIndex = getElementIndex(afterElement);
            // If dropping in the same column and the target is after the current position,
            // we need to adjust for the fact that we'll remove the current element first
            if (currentColumn === targetColumn && targetIndex > currentIndex) {
                targetIndex -= 1;
            }
        }

        // Check if we're dropping in the exact same position
        const isSamePosition = (currentColumn === targetColumn && currentIndex === targetIndex);

        if (!isSamePosition) {
            // FLIP: Capture positions of all boards before DOM change
            const affectedColumns = [targetColumn];
            if (currentColumn && currentColumn !== targetColumn) {
                affectedColumns.push(currentColumn);
            }
            const boardPositions = new Map();
            affectedColumns.forEach(col => {
                if (!col) return;
                col.querySelectorAll('.board:not(.dragging)').forEach(board => {
                    boardPositions.set(board, board.getBoundingClientRect());
                });
            });

            // Remove the dragged element from its original position in the DOM
            draggedElement.remove();

            // Insert the dragged element in its new position
            if (afterElement == null) {
                // If no element found, append to the end of the column
                this.appendChild(draggedElement);
            } else {
                // Insert before the calculated element
                this.insertBefore(draggedElement, afterElement);
            }

            // FLIP: Animate displaced boards
            boardPositions.forEach((oldRect, board) => {
                const newRect = board.getBoundingClientRect();
                const deltaY = oldRect.top - newRect.top;
                const deltaX = oldRect.left - newRect.left;
                if (deltaY !== 0 || deltaX !== 0) {
                    board.style.transform = `translate(${deltaX}px, ${deltaY}px)`;
                    board.style.transition = 'none';
                    requestAnimationFrame(() => {
                        requestAnimationFrame(() => {
                            board.style.transition = 'transform 0.25s ease';
                            board.style.transform = '';
                        });
                    });
                }
            });

            // Save the new board position to database
            await saveBoardPosition(draggedElement, this);
        } else {

        }
    }

    // Clean up drag indicators
    cleanupAllDragIndicators();

    return false; // Prevent default browser behavior
}

// Handle cross-page bookmark drop (bookmark moved from one page to another)
// Supports multi-select: moves all selected bookmarks if multiple are selected
async function handleCrossPageBookmarkDrop(e, targetBookmarkList, targetBoard) {
    // Block in read-only mode
    if (!canModify()) return false;

    // Determine which bookmarks to move (multi-select or single)
    const bookmarksToMove = selectedBookmarks.size > 1
        ? Array.from(selectedBookmarks)
        : [draggedBookmarkId];
    const validBookmarkIds = bookmarksToMove.filter(Boolean);
    if (validBookmarkIds.length === 0) {
        cleanupAllDragIndicators();
        return false;
    }

    try {
        const syncScope = await ensureLocalMutationSyncScopeAllowed({
            contextLabel: 'handleCrossPageBookmarkDrop'
        });
        if (!syncScope.allowed) {
            return false;
        }

        const targetBoardId = targetBoard.getAttribute('data-board-id');


        // Calculate the position using the DOM element the user dropped near
        const afterElement = getBookmarkDragAfterElement(targetBookmarkList, e.clientY);

        // Get existing bookmarks from DATABASE (not DOM!) to avoid order conflicts
        // This is the same pattern used in handleCrossPageBoardDrop which works correctly
        const existingBookmarks = await db.bookmarks
            .where('boardId').equals(targetBoardId)
            .filter(b => !b.deletedAt)
            .sortBy('order');
        const bookmarkRowsToMove = await db.bookmarks.where('id').anyOf(validBookmarkIds).toArray();
        const sourceBoardIds = new Set(
            bookmarkRowsToMove
                .map(bookmark => bookmark?.boardId)
                .filter(boardId => !!boardId && boardId !== targetBoardId)
        );
        const sourceBoardBookmarks = sourceBoardIds.size > 0
            ? await db.bookmarks
                .where('boardId')
                .anyOf(Array.from(sourceBoardIds))
                .filter(bookmark => !bookmark.deletedAt)
                .toArray()
            : [];
        const bookmarkBeforeById = createUndoRedoSnapshotMap([
            ...existingBookmarks,
            ...bookmarkRowsToMove,
            ...sourceBoardBookmarks
        ]);

        let newOrder = 0;

        if (afterElement == null) {
            // Dropping at the end - get max order + 1
            if (existingBookmarks.length > 0) {
                newOrder = Math.max(...existingBookmarks.map(b => b.order)) + 1;
            }
        } else {
            // Find the order of the bookmark we're inserting before
            const afterBookmarkId = afterElement.getAttribute('data-bookmark-id');
            const afterBookmark = existingBookmarks.find(b => b.id === afterBookmarkId);
            if (afterBookmark) {
                newOrder = afterBookmark.order;
            } else {
                // Fallback: afterElement exists in DOM but not in DB (stale DOM or parse error)
                // Use position 0 but log warning for debugging
                console.warn(`[Cross-Page Drag] afterBookmark not found in DB for id ${afterBookmarkId}, using order 0`);
                newOrder = 0;
            }
        }




        const now = getCurrentTimestamp();

        const bookmarksToShift = existingBookmarks.filter(b => b.order >= newOrder);
        const changedBookmarkIds = new Set(validBookmarkIds);

        await db.transaction('rw', db.bookmarks, async () => {
            // FIRST: Shift existing bookmarks at or after newOrder DOWN to make room.
            for (const bookmark of bookmarksToShift) {
                await db.bookmarks.update(bookmark.id, {
                    order: bookmark.order + validBookmarkIds.length,
                    updatedAt: now
                });
                changedBookmarkIds.add(bookmark.id);
            }

            // THEN: Move all selected bookmarks to the target board with sequential order values.
            for (let i = 0; i < validBookmarkIds.length; i++) {
                const bookmarkId = validBookmarkIds[i];
                await db.bookmarks.update(bookmarkId, {
                    boardId: targetBoardId,
                    order: newOrder + i,
                    updatedAt: now
                });
            }

            // Reindex source boards after removal so they stay contiguous.
            for (const sourceBoardId of sourceBoardIds) {
                const remainingBookmarks = await db.bookmarks
                    .where('boardId')
                    .equals(sourceBoardId)
                    .filter(bookmark => !bookmark.deletedAt)
                    .sortBy('order');

                for (let i = 0; i < remainingBookmarks.length; i++) {
                    await db.bookmarks.update(remainingBookmarks[i].id, {
                        order: i,
                        updatedAt: now
                    });
                    changedBookmarkIds.add(remainingBookmarks[i].id);
                }
            }
        });

        const bookmarkAfterById = await collectUndoRedoSnapshotsByIds('bookmarks', Array.from(changedBookmarkIds));
        const bookmarkOps = buildUndoRedoOpsFromSnapshotMaps('bookmarks', bookmarkBeforeById, bookmarkAfterById);
        const queueAttempt = await queueSyncItemsAtomically(
            bookmarkOps
                .filter(op => op.after)
                .map(op => ({
                    op: 'upsert',
                    table: 'bookmarks',
                    id: op.id,
                    data: op.after
                })),
            { contextLabel: 'handleCrossPageBookmarkDrop' }
        );
        if (!queueAttempt.success) {
            await rollbackLocalMutationOps(bookmarkOps);
            showGlassToast(queueAttempt.error || 'Failed to move bookmark(s) to new page. Please try again.', 'error');
            await loadBoardsFromDatabase();
            return false;
        }

        if (!isApplyingUndoRedoHistory) {
            await recordUndoRedoHistoryEntry({
                kind: 'bookmark_move_cross_page',
                label: validBookmarkIds.length === 1 ? 'Move 1 bookmark' : `Move ${validBookmarkIds.length} bookmarks`,
                ops: bookmarkOps
            });
        }



        // Clear selection UI immediately (before sync)
        clearBookmarkSelection();
        if (isSelectionMode) {
            toggleSelectionMode();
        }

        // Reload the current page to show the moved bookmarks immediately

        await loadBoardsFromDatabase();

        broadcastDataChange('crossPageBookmarkDrop');
        return true;
    } catch (error) {
        console.error('[Cross-Page Drag] handleCrossPageBookmarkDrop FAILED:', error);
        showGlassToast('Failed to move bookmark(s) to new page. Please try again.', 'error');
        return false;
    } finally {
        // Clean up drag indicators
        cleanupAllDragIndicators();
    }
}

async function handleBookmarkDrop(e) {
    // Only handle bookmark dropping in this function
    if (!isDraggingBookmark) {
        return;
    }

    // FIX: Check if user can modify (subscription status check)
    if (!canModify()) {
        showGlassToast('Cannot move bookmarks in read-only mode.', 'warning');
        cleanupAllDragIndicators();
        return;
    }





    // Validate that we're dropping on a valid bookmark list (.board-links)
    if (!this.classList.contains('board-links')) {

        e.preventDefault();
        e.stopPropagation();
        cleanupAllDragIndicators();
        return false;
    }

    // Prevent event bubbling
    if (e.stopPropagation) {
        e.stopPropagation();
    }

    // Additional validation - ensure the target is within a valid board
    const targetBoard = this.closest('.board');
    if (!targetBoard) {

        e.preventDefault();
        cleanupAllDragIndicators();
        return false;
    }

    // Check if this is a cross-page drop
    const isCrossPageDrop = dragOriginPageId !== null && dragOriginPageId !== currentPageId;

    if (isCrossPageDrop) {

        await handleCrossPageBookmarkDrop(e, this, targetBoard);
        return false;
    }

    // Normal same-page drop logic
    if (!draggedBookmark) {

        return false;
    }



    // Calculate the exact position where the bookmark should be inserted
    const afterElement = getBookmarkDragAfterElement(this, e.clientY);

    // Handle multi-select: move all selected bookmarks
    if (selectedBookmarks.size > 1) {


        // Get all selected bookmark elements, sorted by their current DOM position
        const selectedElements = Array.from(document.querySelectorAll('li[data-bookmark-id].selected'))
            .sort((a, b) => {
                const aRect = a.getBoundingClientRect();
                const bRect = b.getBoundingClientRect();
                return aRect.top - bRect.top;
            });

        // Track affected source boards
        const affectedBoardIds = new Set();
        selectedElements.forEach(el => {
            const parentBoard = el.closest('.board');
            if (parentBoard) {
                affectedBoardIds.add(parentBoard.getAttribute('data-board-id'));
            }
        });

        // FLIP: Capture positions of all bookmarks before DOM change
        const affectedLists = [this];
        selectedElements.forEach(el => {
            const sourceList = el.closest('.board-links');
            if (sourceList && sourceList !== this && !affectedLists.includes(sourceList)) {
                affectedLists.push(sourceList);
            }
        });
        const bookmarkPositions = new Map();
        affectedLists.forEach(list => {
            if (!list) return;
            list.querySelectorAll('li:not(.dragging)').forEach(li => {
                bookmarkPositions.set(li, li.getBoundingClientRect());
            });
        });

        // Resolve a stable insertion reference. The original afterElement can be part of the
        // moving selection, so it may be detached before insertBefore executes.
        const movingSet = new Set(selectedElements);
        let insertBeforeNode = afterElement;
        while (insertBeforeNode && (insertBeforeNode.parentNode !== this || movingSet.has(insertBeforeNode))) {
            insertBeforeNode = insertBeforeNode.nextElementSibling;
        }

        // Move each selected bookmark to the target position
        selectedElements.forEach(bookmarkEl => {
            bookmarkEl.remove();
            if (insertBeforeNode && insertBeforeNode.parentNode === this) {
                this.insertBefore(bookmarkEl, insertBeforeNode);
            } else {
                this.appendChild(bookmarkEl);
            }
        });

        // FLIP: Animate displaced bookmarks
        bookmarkPositions.forEach((oldRect, li) => {
            const newRect = li.getBoundingClientRect();
            const deltaY = oldRect.top - newRect.top;
            if (deltaY !== 0) {
                li.style.transform = `translateY(${deltaY}px)`;
                li.style.transition = 'none';
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        li.style.transition = 'transform 0.25s ease';
                        li.style.transform = '';
                    });
                });
            }
        });

        // Clear selection UI immediately after visual drop (before sync)
        clearBookmarkSelection();
        if (isSelectionMode) {
            toggleSelectionMode();
        }

        // Save positions for all moved bookmarks (sync can happen in background)
        await saveMultipleBookmarkPositions(this, affectedBoardIds);

    } else {
        // Single bookmark drag (existing logic)
        const sourceList = draggedBookmark.closest('.board-links');

        // FLIP: Capture positions of all bookmarks before DOM change
        const affectedLists = [this];
        if (sourceList && sourceList !== this) {
            affectedLists.push(sourceList);
        }
        const bookmarkPositions = new Map();
        affectedLists.forEach(list => {
            if (!list) return;
            list.querySelectorAll('li:not(.dragging)').forEach(li => {
                bookmarkPositions.set(li, li.getBoundingClientRect());
            });
        });

        draggedBookmark.remove();

        if (afterElement && afterElement.parentNode === this) {
            this.insertBefore(draggedBookmark, afterElement);
        } else {
            this.appendChild(draggedBookmark);
        }

        // FLIP: Animate displaced bookmarks
        bookmarkPositions.forEach((oldRect, li) => {
            const newRect = li.getBoundingClientRect();
            const deltaY = oldRect.top - newRect.top;
            if (deltaY !== 0) {
                li.style.transform = `translateY(${deltaY}px)`;
                li.style.transition = 'none';
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        li.style.transition = 'transform 0.25s ease';
                        li.style.transform = '';
                    });
                });
            }
        });

        await saveBookmarkPosition(draggedBookmark, this);

        // Clear selection
        clearBookmarkSelection();
    }

    // Clean up drag indicators
    cleanupAllDragIndicators();

    return false;
}

/*
========================================
DATABASE UPDATE FUNCTIONS
========================================
Functions to save board and bookmark positions after drag and drop
*/

// Save board position after drag and drop
async function saveBoardPosition(boardElement, newColumn) {
    // Block in read-only mode
    if (!canModify()) return;

    // Ensure dragging class is removed before calculating position
    boardElement.classList.remove('dragging');

    try {
        const boardId = boardElement.getAttribute('data-board-id');
        const newColumnIndex = parseInt(newColumn.getAttribute('data-column'));
        if (isNaN(newColumnIndex)) {
            console.error('[saveBoardPosition] Invalid target column index');
            return;
        }

        // Validate target page exists and isn't deleted (for cross-page drags)
        const targetPageId = currentPageId;
        const targetPage = await db.pages.get(targetPageId);
        if (!targetPage || targetPage.deletedAt) {
            console.error('[saveBoardPosition] Target page no longer exists or is deleted');
            showGlassToast('Target page no longer exists', 'error');
            await loadBoardsFromDatabase();
            return;
        }

        const movingBoardBefore = await db.boards.get(boardId);
        if (!movingBoardBefore || movingBoardBefore.deletedAt) {
            console.error('[saveBoardPosition] Board no longer exists or is deleted');
            showGlassToast('Board no longer exists', 'error');
            await loadBoardsFromDatabase();
            return;
        }

        const originalPageId = movingBoardBefore.pageId;
        const originalColumnIndex = Number(movingBoardBefore.columnIndex);
        const isCrossPageMove = !!originalPageId && originalPageId !== targetPageId;

        const targetPageBoardsBefore = await db.boards
            .where('pageId')
            .equals(targetPageId)
            .filter(board => !board.deletedAt)
            .toArray();
        const historyBeforeRows = movingBoardBefore
            ? [movingBoardBefore, ...targetPageBoardsBefore]
            : targetPageBoardsBefore;

        if (isCrossPageMove && !Number.isNaN(originalColumnIndex)) {
            const originPageBoards = await db.boards
                .where('[pageId+columnIndex+order]')
                .between([originalPageId, originalColumnIndex, 0], [originalPageId, originalColumnIndex, Infinity])
                .filter(board => !board.deletedAt)
                .toArray();
            historyBeforeRows.push(...originPageBoards);
        }
        const boardBeforeById = createUndoRedoSnapshotMap(historyBeforeRows);

        const now = getCurrentTimestamp();

        // Get all boards in the new column to determine order
        const boardsInColumn = Array.from(newColumn.querySelectorAll('.board'));
        const newOrder = boardsInColumn.indexOf(boardElement);

        // Prepare update object with timestamp
        const updateData = {
            columnIndex: newColumnIndex,
            order: newOrder,
            updatedAt: now
        };

        // If this is a cross-page drag, update the pageId as well
        if (isCrossPageMove) {
            updateData.pageId = currentPageId;

        }

        // Update board in database
        await db.boards.update(boardId, updateData);

        // Update order for other boards in the same column on current page
        // Pass timestamp to ensure all boards share the same timestamp for proper sync
        await updateColumnBoardOrders(newColumnIndex, now, { queueChanges: false });

        // Reorder remaining boards in the origin column when board moved away from it.
        const movedOutOfOriginalColumn = !!originalPageId && !Number.isNaN(originalColumnIndex) &&
            (originalPageId !== targetPageId || originalColumnIndex !== newColumnIndex);
        if (movedOutOfOriginalColumn) {
            const originColumnBoardsAfter = await db.boards
                .where('[pageId+columnIndex+order]')
                .between([originalPageId, originalColumnIndex, 0], [originalPageId, originalColumnIndex, Infinity])
                .filter(board => !board.deletedAt)
                .toArray();

            for (let i = 0; i < originColumnBoardsAfter.length; i++) {
                await db.boards.update(originColumnBoardsAfter[i].id, { order: i, updatedAt: now });
            }
        }

        const boardAfterById = await collectUndoRedoSnapshotsByIds('boards', Array.from(boardBeforeById.keys()));
        const boardOps = buildUndoRedoOpsFromSnapshotMaps('boards', boardBeforeById, boardAfterById);
        const queueAttempt = await queueSyncItemsAtomically(
            boardOps
                .filter(op => op.after)
                .map(op => ({
                    op: 'upsert',
                    table: 'boards',
                    id: op.id,
                    data: op.after
                })),
            { contextLabel: 'saveBoardPosition' }
        );
        if (!queueAttempt.success) {
            await rollbackLocalMutationOps(boardOps);
            showGlassToast(queueAttempt.error || 'Failed to save board position. Please try again.', 'error');
            await loadBoardsFromDatabase();
            return;
        }

        if (!isApplyingUndoRedoHistory) {
            await recordUndoRedoHistoryEntry({
                kind: 'board_reorder',
                label: `Move board "${movingBoardBefore?.name || 'Untitled'}"`,
                ops: boardOps
            });
        }



        broadcastDataChange('saveBoardPosition');

    } catch (error) {
        console.error('Failed to save board position:', error);
    }
}

// Update order for all boards in a column
// timestamp parameter ensures all boards in a drag operation share the same timestamp
// This prevents cross-browser sync issues where different timestamps cause merge conflicts
async function updateColumnBoardOrders(columnIndex, timestamp = null, options = {}) {
    try {
        // Validate columnIndex to prevent null pointer errors
        if (columnIndex === null || columnIndex === undefined || isNaN(columnIndex)) {
            console.warn('updateColumnBoardOrders: Invalid columnIndex:', columnIndex);
            return;
        }

        const column = document.querySelector(`[data-column="${columnIndex}"]`);
        if (!column) {
            console.warn(`updateColumnBoardOrders: Column ${columnIndex} not found in DOM`);
            return;
        }
        const boardElements = Array.from(column.querySelectorAll('.board:not(.dragging)'));
        // Use passed timestamp if provided, otherwise generate new one
        const now = timestamp || getCurrentTimestamp();
        const updatedBoardIds = [];
        const shouldQueueChanges = options?.queueChanges !== false;

        for (let i = 0; i < boardElements.length; i++) {
            const boardId = boardElements[i].getAttribute('data-board-id');
            await db.boards.update(boardId, { order: i, updatedAt: now });
            updatedBoardIds.push(boardId);
            if (shouldQueueChanges) {
                const board = await db.boards.get(boardId);
                if (board) await queueSyncToBackground('upsert', 'boards', boardId, board);
            }
        }

        return updatedBoardIds;

    } catch (error) {
        console.error('Failed to update board orders:', error);
        return [];
    }
}

// Save bookmark position after drag and drop
async function saveBookmarkPosition(bookmarkElement, newBookmarkList) {
    // Block in read-only mode
    if (!canModify()) return;

    // Ensure dragging and selected classes are removed before calculating position
    bookmarkElement.classList.remove('dragging');
    bookmarkElement.classList.remove('selected');

    try {
        const bookmarkId = bookmarkElement.getAttribute('data-bookmark-id');
        const newBoard = newBookmarkList.closest('.board');
        const newBoardId = newBoard.getAttribute('data-board-id');
        const movingBookmarkBefore = await db.bookmarks.get(bookmarkId);

        if (!movingBookmarkBefore || movingBookmarkBefore.deletedAt) {
            console.error('[saveBookmarkPosition] Bookmark no longer exists or is deleted');
            showGlassToast('Bookmark no longer exists', 'error');
            await loadBoardsFromDatabase();
            return;
        }

        // Validate target board exists and isn't deleted
        const targetBoard = await db.boards.get(newBoardId);
        if (!targetBoard || targetBoard.deletedAt) {
            console.error('[saveBookmarkPosition] Target board no longer exists or is deleted');
            showGlassToast('Target board no longer exists', 'error');
            await loadBoardsFromDatabase();
            return;
        }

        // Resolve original board from DB state first so undo works even if drag globals were reset.
        const originalBoardId = movingBookmarkBefore.boardId ||
            (draggedFromBoard && draggedFromBoard.getAttribute ? draggedFromBoard.getAttribute('data-board-id') : null);
        const affectedBoardIds = new Set([newBoardId]);
        if (originalBoardId) {
            affectedBoardIds.add(originalBoardId);
        }
        const affectedBoardIdList = Array.from(affectedBoardIds).filter(Boolean);
        const bookmarksBefore = affectedBoardIdList.length > 0
            ? await db.bookmarks.where('boardId').anyOf(affectedBoardIdList).filter(b => !b.deletedAt).toArray()
            : [];
        const bookmarkBeforeById = createUndoRedoSnapshotMap(bookmarksBefore);
        bookmarkBeforeById.set(bookmarkId, cloneUndoRedoSnapshot(movingBookmarkBefore));
        const now = getCurrentTimestamp();

        // Get all bookmarks in the new list to determine order
        const bookmarksInList = Array.from(newBookmarkList.querySelectorAll('li[data-bookmark-id]'));
        const newOrder = bookmarksInList.indexOf(bookmarkElement);

        // Update bookmark in database with timestamp
        await db.bookmarks.update(bookmarkId, {
            boardId: newBoardId,
            order: newOrder,
            updatedAt: now
        });

        // Update order for other bookmarks in the same board
        // Pass timestamp to ensure all bookmarks share the same timestamp for proper sync
        await updateBoardBookmarkOrders(newBoardId, now, { queueChanges: false });

        // If moved to a different board, also update the original board
        if (originalBoardId && originalBoardId !== newBoardId) {
            await updateBoardBookmarkOrders(originalBoardId, now, { queueChanges: false });
        }

        const bookmarkAfterById = await collectUndoRedoSnapshotsByIds('bookmarks', Array.from(bookmarkBeforeById.keys()));
        const bookmarkOps = buildUndoRedoOpsFromSnapshotMaps('bookmarks', bookmarkBeforeById, bookmarkAfterById);
        const queueAttempt = await queueSyncItemsAtomically(
            bookmarkOps
                .filter(op => op.after)
                .map(op => ({
                    op: 'upsert',
                    table: 'bookmarks',
                    id: op.id,
                    data: op.after
                })),
            { contextLabel: 'saveBookmarkPosition' }
        );
        if (!queueAttempt.success) {
            await rollbackLocalMutationOps(bookmarkOps);
            showGlassToast(queueAttempt.error || 'Failed to save bookmark position. Please try again.', 'error');
            await loadBoardsFromDatabase();
            return;
        }

        if (!isApplyingUndoRedoHistory) {
            const movedBookmark = bookmarkAfterById.get(bookmarkId) || null;
            await recordUndoRedoHistoryEntry({
                kind: 'bookmark_reorder',
                label: `Move bookmark "${movedBookmark?.title || 'Untitled'}"`,
                ops: bookmarkOps
            });
        }



        // Recompute collapsed/visible bookmark slices after drag move so source/target boards
        // reflect the new top-N window and "Show remaining" label correctly.
        if (largeBoardCollapseEnabled) {
            await loadBoardsFromDatabase();
        }

        broadcastDataChange('saveBookmarkPosition');

    } catch (error) {
        console.error('Failed to save bookmark position:', error);
    }
}

// Save positions for multiple bookmarks after multi-drag
async function saveMultipleBookmarkPositions(targetBoardLinks, affectedBoardIds) {
    // Block in read-only mode
    if (!canModify()) return;

    // Clean up selection and dragging classes before position calculation
    document.querySelectorAll('li[data-bookmark-id].selected, li[data-bookmark-id].dragging').forEach(el => {
        el.classList.remove('selected');
        el.classList.remove('dragging');
    });

    try {
        const now = getCurrentTimestamp();

        // Update all bookmarks in the target board with new order
        const targetBoard = targetBoardLinks.closest('.board');
        const targetBoardId = targetBoard.getAttribute('data-board-id');
        const historyBoardIds = new Set([targetBoardId]);
        if (affectedBoardIds && typeof affectedBoardIds.forEach === 'function') {
            affectedBoardIds.forEach(boardId => {
                if (boardId) historyBoardIds.add(boardId);
            });
        }
        const historyBoardIdList = Array.from(historyBoardIds).filter(Boolean);
        const bookmarksBefore = historyBoardIdList.length > 0
            ? await db.bookmarks.where('boardId').anyOf(historyBoardIdList).filter(b => !b.deletedAt).toArray()
            : [];
        const bookmarkBeforeById = createUndoRedoSnapshotMap(bookmarksBefore);
        const allBookmarksInTarget = targetBoardLinks.querySelectorAll('li[data-bookmark-id]');

        // Collect all bookmark IDs that will be updated
        const updatedBookmarkIds = [];

        await db.transaction('rw', db.bookmarks, async () => {
            // Update all bookmarks in target board (use for...of to properly await each update)
            let index = 0;
            for (const el of allBookmarksInTarget) {
                const id = el.getAttribute('data-bookmark-id');
                await db.bookmarks.update(id, {
                    boardId: targetBoardId,
                    order: index,
                    updatedAt: now
                });
                updatedBookmarkIds.push(id);
                index++;
            }

            // Update order in any affected source boards
            for (const boardId of affectedBoardIds) {
                if (boardId !== targetBoardId) {
                    const boardElement = document.querySelector(`[data-board-id="${boardId}"]`);
                    if (boardElement) {
                        const bookmarkElements = boardElement.querySelectorAll('li[data-bookmark-id]');
                        let sourceIndex = 0;
                        for (const el of bookmarkElements) {
                            const id = el.getAttribute('data-bookmark-id');
                            await db.bookmarks.update(id, { order: sourceIndex, updatedAt: now });
                            if (!updatedBookmarkIds.includes(id)) {
                                updatedBookmarkIds.push(id);
                            }
                            sourceIndex++;
                        }
                    }
                }
            }
        });

        const bookmarkAfterById = await collectUndoRedoSnapshotsByIds('bookmarks', Array.from(bookmarkBeforeById.keys()));
        const bookmarkOps = buildUndoRedoOpsFromSnapshotMaps('bookmarks', bookmarkBeforeById, bookmarkAfterById);
        const queueAttempt = await queueSyncItemsAtomically(
            bookmarkOps
                .filter(op => op.after)
                .map(op => ({
                    op: 'upsert',
                    table: 'bookmarks',
                    id: op.id,
                    data: op.after
                })),
            { contextLabel: 'saveMultipleBookmarkPositions' }
        );
        if (!queueAttempt.success) {
            await rollbackLocalMutationOps(bookmarkOps);
            showGlassToast(queueAttempt.error || 'Failed to save bookmark positions. Please try again.', 'error');
            await loadBoardsFromDatabase();
            return;
        }

        if (!isApplyingUndoRedoHistory) {
            await recordUndoRedoHistoryEntry({
                kind: 'bookmark_multi_reorder',
                label: 'Move selected bookmarks',
                ops: bookmarkOps
            });
        }



        // Recompute collapsed/visible bookmark slices after multi-move so source/target boards
        // reflect the new top-N window and "Show remaining" label correctly.
        if (largeBoardCollapseEnabled) {
            await loadBoardsFromDatabase();
        }

        broadcastDataChange('saveMultipleBookmarkPositions');

    } catch (error) {
        console.error('Failed to save multiple bookmark positions:', error);
    }
}

// Update order for all bookmarks in a board
// timestamp parameter ensures all bookmarks in a drag operation share the same timestamp
// This prevents cross-browser sync issues where different timestamps cause merge conflicts
async function updateBoardBookmarkOrders(boardId, timestamp = null, options = {}) {
    try {
        const boardElement = document.querySelector(`[data-board-id="${boardId}"]`);
        // FIX [H6]: Null check to prevent TypeError when board element not found
        // This can happen during rapid operations or when board was just deleted
        if (!boardElement) {
            console.warn(`[updateBoardBookmarkOrders] Board element not found for ID: ${boardId}`);
            return;
        }
        const bookmarkElements = Array.from(boardElement.querySelectorAll('li[data-bookmark-id]:not(.dragging)'));
        // Use passed timestamp if provided, otherwise generate new one
        const now = timestamp || getCurrentTimestamp();
        const updatedBookmarkIds = [];
        const shouldQueueChanges = options?.queueChanges !== false;

        for (let i = 0; i < bookmarkElements.length; i++) {
            const bookmarkId = bookmarkElements[i].getAttribute('data-bookmark-id');
            await db.bookmarks.update(bookmarkId, { order: i, updatedAt: now });
            updatedBookmarkIds.push(bookmarkId);
            if (shouldQueueChanges) {
                const bookmark = await db.bookmarks.get(bookmarkId);
                if (bookmark) await queueSyncToBackground('upsert', 'bookmarks', bookmarkId, bookmark);
            }
        }

        return updatedBookmarkIds;

    } catch (error) {
        console.error('Failed to update bookmark orders:', error);
        return [];
    }
}
