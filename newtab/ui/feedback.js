(function registerLumiListFeedback(global) {
    const modules = global.LumiListModules || (global.LumiListModules = {});
    const escapeHtml = modules.coreUtils?.escapeHtml || ((value) => String(value ?? ''));

    function updateLoadingMessage(title, message) {
        const titleEl = document.getElementById('loadingTitle');
        const messageEl = document.getElementById('loadingMessage');

        if (titleEl && title) titleEl.textContent = title;
        if (messageEl && message) messageEl.textContent = message;
    }

    function showGlassToast(message, type = 'info', duration = 3000, options = {}) {
        const container = document.getElementById('toastContainer');
        if (!container) return;

        const MAX_TOASTS = 5;
        const existingToasts = container.querySelectorAll('.glass-toast');
        if (existingToasts.length >= MAX_TOASTS) {
            existingToasts[0]._llDispose?.();
        }

        const icons = {
            success: '✓',
            error: '✕',
            warning: '⚠',
            info: 'ℹ'
        };

        const toast = document.createElement('div');
        toast.className = `glass-toast ${type}`;
        toast.setAttribute('role', 'status');

        const icon = document.createElement('span');
        icon.className = 'glass-toast-icon';
        icon.textContent = icons[type] || icons.info;

        const messageEl = document.createElement('span');
        messageEl.className = 'glass-toast-message';
        messageEl.innerHTML = escapeHtml(message);

        toast.append(icon, messageEl);

        let removeTimerId = null;
        let dismissTimerId = null;
        const clearTimers = () => {
            if (dismissTimerId) {
                clearTimeout(dismissTimerId);
                dismissTimerId = null;
            }
            if (removeTimerId) {
                clearTimeout(removeTimerId);
                removeTimerId = null;
            }
        };
        const removeToast = () => {
            clearTimers();
            toast.remove();
        };
        const dismissToast = () => {
            clearTimers();
            toast.classList.remove('show');
            removeTimerId = setTimeout(removeToast, 300);
        };
        toast._llDispose = removeToast;

        const actionLabel = typeof options?.actionLabel === 'string' ? options.actionLabel.trim() : '';
        const onAction = typeof options?.onAction === 'function' ? options.onAction : null;
        if (actionLabel && onAction) {
            const actionButton = document.createElement('button');
            actionButton.type = 'button';
            actionButton.className = 'glass-toast-action';
            actionButton.textContent = actionLabel;
            actionButton.addEventListener('click', async (event) => {
                event.preventDefault();
                event.stopPropagation();
                if (actionButton.disabled) return;

                actionButton.disabled = true;
                try {
                    await onAction();
                } catch (error) {
                    console.warn('Toast action failed:', error);
                } finally {
                    dismissToast();
                }
            });
            toast.appendChild(actionButton);
        }

        container.appendChild(toast);

        requestAnimationFrame(() => {
            toast.classList.add('show');
        });

        if (Number.isFinite(duration) && duration > 0) {
            dismissTimerId = setTimeout(dismissToast, duration);
        }

        return {
            dismiss: dismissToast,
            element: toast
        };
    }

    function showGlassConfirm(title, message, options = {}) {
        return new Promise((resolve) => {
            const modal = document.getElementById('glassConfirmModal');
            const titleEl = document.getElementById('glassConfirmTitle');
            const messageEl = document.getElementById('glassConfirmMessage');
            const okBtn = document.getElementById('glassConfirmOkBtn');
            const cancelBtn = document.getElementById('glassConfirmCancelBtn');

            if (!modal) {
                resolve(false);
                return;
            }

            titleEl.textContent = title;
            messageEl.textContent = message;
            okBtn.textContent = options.confirmText || 'OK';
            cancelBtn.textContent = options.cancelText || 'Cancel';
            okBtn.className = `btn ${options.confirmClass || 'btn-primary'}`;
            modal.classList.add('active');

            const handleConfirm = () => {
                cleanup();
                modal.classList.remove('active');
                resolve(true);
            };

            const handleCancel = () => {
                cleanup();
                modal.classList.remove('active');
                resolve(false);
            };

            const handleKeydown = (event) => {
                if (event.key === 'Escape') {
                    handleCancel();
                } else if (event.key === 'Enter') {
                    handleConfirm();
                }
            };

            let mouseDownOnOverlay = false;
            const handleMouseDownOutside = (event) => {
                mouseDownOnOverlay = (event.target === modal);
            };
            const handleMouseUpOutside = (event) => {
                if (mouseDownOnOverlay && event.target === modal) {
                    handleCancel();
                }
                mouseDownOnOverlay = false;
            };

            const cleanup = () => {
                okBtn.removeEventListener('click', handleConfirm);
                cancelBtn.removeEventListener('click', handleCancel);
                document.removeEventListener('keydown', handleKeydown);
                modal.removeEventListener('mousedown', handleMouseDownOutside);
                modal.removeEventListener('mouseup', handleMouseUpOutside);
            };

            okBtn.addEventListener('click', handleConfirm);
            cancelBtn.addEventListener('click', handleCancel);
            document.addEventListener('keydown', handleKeydown);
            modal.addEventListener('mousedown', handleMouseDownOutside);
            modal.addEventListener('mouseup', handleMouseUpOutside);
            cancelBtn.focus();
        });
    }

    modules.feedback = {
        updateLoadingMessage,
        showGlassToast,
        showGlassConfirm
    };
})(window);
