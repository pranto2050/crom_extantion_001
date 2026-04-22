// Review prompt policy controls (user-scoped state is persisted in chrome.storage.local)
const REVIEW_PROMPT_STORAGE_VERSION = 1;
const REVIEW_PROMPT_STATE_KEY_PREFIX = 'LumiList_review_prompt_v1_';
const REVIEW_PROMPT_INSTALL_TS_KEY = 'LumiList_review_install_timestamp';
const REVIEW_PROMPT_MIN_BOOKMARKS = 20;
const REVIEW_PROMPT_MIN_INSTALL_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const REVIEW_PROMPT_TRIAL_WARNING_DAYS_THRESHOLD = 3;
const REVIEW_PROMPT_RECENT_ISSUE_WINDOW_MS = 72 * 60 * 60 * 1000;
const REVIEW_PROMPT_DISMISS_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;
const REVIEW_PROMPT_NOT_NOW_COOLDOWN_MS = 45 * 24 * 60 * 60 * 1000;
const REVIEW_PROMPT_MAX_PROMPTS = 3;

let _reviewPromptMutationChain = Promise.resolve();

function queueReviewPromptMutation(task) {
    const next = _reviewPromptMutationChain.then(
        () => task(),
        () => task()
    );
    _reviewPromptMutationChain = next.catch(() => { });
    return next;
}

function normalizeTimestamp(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return 0;
    return Math.floor(numeric);
}

function clampPositiveInteger(value, fallback = 0, max = Number.MAX_SAFE_INTEGER) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    if (numeric <= 0) return fallback;
    return Math.min(max, Math.floor(numeric));
}

function normalizeNonNegativeInteger(value, fallback = null, max = Number.MAX_SAFE_INTEGER) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    if (numeric < 0) return fallback;
    return Math.min(max, Math.floor(numeric));
}

function getReviewPromptStateKey(userId) {
    return `${REVIEW_PROMPT_STATE_KEY_PREFIX}${userId}`;
}

function getDefaultReviewPromptState() {
    return {
        version: REVIEW_PROMPT_STORAGE_VERSION,
        manualBookmarkCount: 0,
        promptCount: 0,
        cooldownUntil: 0,
        lastPromptedAt: 0,
        lastDismissedAt: 0,
        lastNotNowAt: 0,
        reviewCtaClickedAt: 0,
        lastMajorIssueAt: 0,
        lastManualBookmarkAt: 0,
        lastPromptTrigger: '',
        lastIssueType: '',
        neverPromptAgain: false
    };
}

function normalizeReviewPromptState(raw) {
    const source = (raw && typeof raw === 'object') ? raw : {};
    const defaults = getDefaultReviewPromptState();
    return {
        ...defaults,
        manualBookmarkCount: clampPositiveInteger(source.manualBookmarkCount, 0, 100000000),
        promptCount: clampPositiveInteger(source.promptCount, 0, 1000),
        cooldownUntil: normalizeTimestamp(source.cooldownUntil),
        lastPromptedAt: normalizeTimestamp(source.lastPromptedAt),
        lastDismissedAt: normalizeTimestamp(source.lastDismissedAt),
        lastNotNowAt: normalizeTimestamp(source.lastNotNowAt),
        reviewCtaClickedAt: normalizeTimestamp(source.reviewCtaClickedAt),
        lastMajorIssueAt: normalizeTimestamp(source.lastMajorIssueAt),
        lastManualBookmarkAt: normalizeTimestamp(source.lastManualBookmarkAt),
        lastPromptTrigger: typeof source.lastPromptTrigger === 'string'
            ? source.lastPromptTrigger.slice(0, 64)
            : '',
        lastIssueType: typeof source.lastIssueType === 'string'
            ? source.lastIssueType.slice(0, 64)
            : '',
        neverPromptAgain: source.neverPromptAgain === true
    };
}

function evaluateReviewPromptEligibility(state, installTimestamp, now = Date.now()) {
    if (!state) return { eligible: false, reason: 'missing_state' };
    if (state.neverPromptAgain || state.reviewCtaClickedAt > 0) {
        return { eligible: false, reason: 'already_reviewed' };
    }
    if (state.promptCount >= REVIEW_PROMPT_MAX_PROMPTS) {
        return { eligible: false, reason: 'max_prompts' };
    }
    if (state.manualBookmarkCount < REVIEW_PROMPT_MIN_BOOKMARKS) {
        return { eligible: false, reason: 'bookmark_threshold' };
    }
    if (!installTimestamp || (now - installTimestamp) < REVIEW_PROMPT_MIN_INSTALL_AGE_MS) {
        return { eligible: false, reason: 'install_age' };
    }
    if (state.cooldownUntil > now) {
        return { eligible: false, reason: 'cooldown' };
    }
    if (state.lastMajorIssueAt > 0 && (now - state.lastMajorIssueAt) < REVIEW_PROMPT_RECENT_ISSUE_WINDOW_MS) {
        return { eligible: false, reason: 'recent_issue' };
    }
    return { eligible: true, reason: 'eligible' };
}

async function ensureReviewPromptInstallTimestamp() {
    const existing = await chrome.storage.local.get(REVIEW_PROMPT_INSTALL_TS_KEY);
    const normalized = normalizeTimestamp(existing[REVIEW_PROMPT_INSTALL_TS_KEY]);
    if (normalized > 0) {
        return normalized;
    }
    const now = Date.now();
    await chrome.storage.local.set({ [REVIEW_PROMPT_INSTALL_TS_KEY]: now });
    return now;
}

async function resolveReviewPromptUserId(explicitUserId = null) {
    if (typeof explicitUserId === 'string' && explicitUserId.trim()) {
        return explicitUserId.trim();
    }
    const result = await chrome.storage.local.get('LumiList_user');
    return result?.LumiList_user?.id || null;
}

async function mutateReviewPromptState(userId, mutator) {
    if (!userId) {
        throw new Error('Review prompt state mutation requires user id');
    }
    return queueReviewPromptMutation(async () => {
        const key = getReviewPromptStateKey(userId);
        const storageData = await chrome.storage.local.get([key, REVIEW_PROMPT_INSTALL_TS_KEY]);
        const now = Date.now();

        let installTimestamp = normalizeTimestamp(storageData[REVIEW_PROMPT_INSTALL_TS_KEY]);
        if (!installTimestamp) {
            installTimestamp = now;
            await chrome.storage.local.set({ [REVIEW_PROMPT_INSTALL_TS_KEY]: installTimestamp });
        }

        const currentState = normalizeReviewPromptState(storageData[key]);
        const nextStateRaw = await mutator({ ...currentState }, { now, installTimestamp, userId });

        if (!nextStateRaw) {
            return {
                state: currentState,
                installTimestamp,
                now,
                changed: false
            };
        }

        const nextState = normalizeReviewPromptState(nextStateRaw);
        await chrome.storage.local.set({ [key]: nextState });
        return {
            state: nextState,
            installTimestamp,
            now,
            changed: true
        };
    });
}

async function trackReviewPromptManualBookmarks(userId, count = 1) {
    const safeCount = clampPositiveInteger(count, 0, 1000000);
    if (safeCount < 1) {
        return {
            state: null,
            changed: false
        };
    }
    return mutateReviewPromptState(userId, (state, ctx) => {
        state.manualBookmarkCount = Math.min(100000000, state.manualBookmarkCount + safeCount);
        state.lastManualBookmarkAt = ctx.now;
        return state;
    });
}

async function trackReviewPromptIssue(userId, issueType = 'general') {
    const safeIssueType = (typeof issueType === 'string' && issueType.trim())
        ? issueType.trim().slice(0, 64)
        : 'general';
    return mutateReviewPromptState(userId, (state, ctx) => {
        state.lastMajorIssueAt = ctx.now;
        state.lastIssueType = safeIssueType;
        return state;
    });
}

async function requestReviewPromptDisplay(userId, trigger = 'manual') {
    if (!userId) {
        throw new Error('Review prompt display check requires user id');
    }
    return queueReviewPromptMutation(async () => {
        const key = getReviewPromptStateKey(userId);
        const storageData = await chrome.storage.local.get([
            key,
            REVIEW_PROMPT_INSTALL_TS_KEY,
            'subscriptionStatus',
            'subscriptionDaysLeft',
            'subscriptionData',
            'subscriptionLastKnownState'
        ]);
        const now = Date.now();

        let installTimestamp = normalizeTimestamp(storageData[REVIEW_PROMPT_INSTALL_TS_KEY]);
        if (!installTimestamp) {
            installTimestamp = now;
            await chrome.storage.local.set({ [REVIEW_PROMPT_INSTALL_TS_KEY]: installTimestamp });
        }

        const subscriptionStatus = resolveEffectiveSubscriptionStatus(storageData);
        const subscriptionDaysLeft = resolveEffectiveSubscriptionDaysLeft(storageData);
        const subscriptionEligibility = evaluateReviewPromptSubscriptionEligibility(
            subscriptionStatus,
            subscriptionDaysLeft
        );
        if (!subscriptionEligibility.eligible) {
            return {
                showPrompt: false,
                reason: subscriptionEligibility.reason,
                state: normalizeReviewPromptState(storageData[key]),
                installTimestamp
            };
        }

        const reviewSubscription = resolveReviewPromptSubscriptionRecord(storageData);
        if (!isStrictlyActivePaidReviewSubscription(reviewSubscription)) {
            return {
                showPrompt: false,
                reason: 'subscription_not_active_paid',
                state: normalizeReviewPromptState(storageData[key]),
                installTimestamp
            };
        }

        const currentState = normalizeReviewPromptState(storageData[key]);
        const eligibility = evaluateReviewPromptEligibility(currentState, installTimestamp, now);
        if (!eligibility.eligible) {
            return {
                showPrompt: false,
                reason: eligibility.reason,
                state: currentState,
                installTimestamp
            };
        }

        const nextState = normalizeReviewPromptState({
            ...currentState,
            promptCount: Math.min(1000, currentState.promptCount + 1),
            lastPromptedAt: now,
            cooldownUntil: Math.max(currentState.cooldownUntil || 0, now + REVIEW_PROMPT_DISMISS_COOLDOWN_MS),
            lastPromptTrigger: typeof trigger === 'string' ? trigger.slice(0, 64) : 'manual'
        });
        await chrome.storage.local.set({ [key]: nextState });

        return {
            showPrompt: true,
            reason: 'eligible',
            state: nextState,
            installTimestamp
        };
    });
}

async function applyReviewPromptAction(userId, action = 'dismiss') {
    const safeAction = (typeof action === 'string' && action.trim())
        ? action.trim()
        : 'dismiss';
    return mutateReviewPromptState(userId, (state, ctx) => {
        switch (safeAction) {
            case 'review_clicked':
                state.reviewCtaClickedAt = ctx.now;
                state.neverPromptAgain = true;
                state.cooldownUntil = Number.MAX_SAFE_INTEGER;
                break;
            case 'not_now':
                state.lastNotNowAt = ctx.now;
                state.cooldownUntil = ctx.now + REVIEW_PROMPT_NOT_NOW_COOLDOWN_MS;
                break;
            case 'dismiss':
            default:
                state.lastDismissedAt = ctx.now;
                state.cooldownUntil = Math.max(state.cooldownUntil || 0, ctx.now + REVIEW_PROMPT_DISMISS_COOLDOWN_MS);
                break;
        }
        return state;
    });
}

function isKnownSubscriptionStatus(status) {
    return status === 'trial' ||
        status === 'active' ||
        status === 'grace' ||
        status === 'expired';
}

const BACKGROUND_SUBSCRIPTION_REFRESH_TIMEOUT_MS = 5000;
const BACKGROUND_SUBSCRIPTION_REFRESH_COOLDOWN_MS = 15000;
let pendingBackgroundSubscriptionRefresh = null;
let lastBackgroundSubscriptionRefreshAt = 0;

function parseSubscriptionDate(value) {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
}

function getFailureRecoveryGraceEnd(subscription) {
    if (!subscription || typeof subscription !== 'object') return null;

    const rawStatus = String(subscription.status || '').toLowerCase();
    if (
        rawStatus !== 'pending' &&
        rawStatus !== 'past_due' &&
        rawStatus !== 'halted' &&
        rawStatus !== 'grace'
    ) {
        return null;
    }

    const accessEnd = parseSubscriptionDate(subscription.subscription_ends_at);
    if (!accessEnd) return null;
    return new Date(accessEnd.getTime() + (7 * 24 * 60 * 60 * 1000));
}

function hasPaidOrGraceAccessAnchors(subscription) {
    if (!subscription || typeof subscription !== 'object') return false;

    return Boolean(
        subscription.subscription_started_at ||
        subscription.subscription_ends_at ||
        subscription.billing_cycle_ends_at ||
        subscription.grace_ends_at
    );
}

function shouldPreserveTrialWhileCheckoutIncomplete(subscription) {
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

    return !hasPaidOrGraceAccessAnchors(subscription);
}

function getTrialWindowEnd(subscription) {
    if (!subscription || typeof subscription !== 'object') return null;

    const explicitTrialEnd = parseSubscriptionDate(subscription.trial_ends_at);
    if (explicitTrialEnd) {
        return explicitTrialEnd;
    }

    if (!shouldPreserveTrialWhileCheckoutIncomplete(subscription)) {
        return null;
    }

    const trialStart = parseSubscriptionDate(subscription.trial_started_at || subscription.created_at);
    if (!trialStart) return null;
    return new Date(trialStart.getTime() + (30 * 24 * 60 * 60 * 1000));
}

function deriveEffectiveSubscriptionStatus(subscription) {
    if (!subscription || typeof subscription !== 'object') return null;

    const now = Date.now();
    const rawStatus = String(subscription.status || '').toLowerCase();
    const trialEnd = getTrialWindowEnd(subscription);
    const storedGraceEnd = parseSubscriptionDate(subscription.grace_ends_at);
    const accessEnd = parseSubscriptionDate(subscription.subscription_ends_at);
    const preserveTrialWhileCheckoutIncomplete =
        Boolean(trialEnd && trialEnd.getTime() > now) &&
        shouldPreserveTrialWhileCheckoutIncomplete(subscription);

    if (preserveTrialWhileCheckoutIncomplete) {
        return 'trial';
    }

    if (rawStatus === 'active') {
        if (!accessEnd) return 'active';
        const bufferedAccessEnd = accessEnd.getTime() + (6 * 60 * 60 * 1000);
        return now <= bufferedAccessEnd ? 'active' : 'expired';
    }

    if (rawStatus === 'trial') {
        if (trialEnd && trialEnd.getTime() > now) return 'trial';
        const derivedGraceEnd = storedGraceEnd || (trialEnd ? new Date(trialEnd.getTime() + (7 * 24 * 60 * 60 * 1000)) : null);
        return derivedGraceEnd && derivedGraceEnd.getTime() > now ? 'grace' : 'expired';
    }

    if (rawStatus === 'grace') {
        const failureRecoveryGraceEnd = getFailureRecoveryGraceEnd(subscription);
        if (failureRecoveryGraceEnd && failureRecoveryGraceEnd.getTime() > now) return 'grace';
        return storedGraceEnd && storedGraceEnd.getTime() > now ? 'grace' : 'expired';
    }

    if (rawStatus === 'cancelled') {
        if (accessEnd && accessEnd.getTime() > now) return 'active';
        const cancelledGraceEnd = accessEnd ? new Date(accessEnd.getTime() + (30 * 24 * 60 * 60 * 1000)) : null;
        return cancelledGraceEnd && cancelledGraceEnd.getTime() > now ? 'grace' : 'expired';
    }

    if (rawStatus === 'created' || rawStatus === 'pending' || rawStatus === 'authenticated') {
        if (accessEnd && accessEnd.getTime() > now) return 'active';
        const failureRecoveryGraceEnd = getFailureRecoveryGraceEnd(subscription);
        if (failureRecoveryGraceEnd && failureRecoveryGraceEnd.getTime() > now) return 'grace';
        if (trialEnd && trialEnd.getTime() > now) return 'trial';
        if (storedGraceEnd && storedGraceEnd.getTime() > now) return 'grace';
        const trialGraceEnd = trialEnd ? new Date(trialEnd.getTime() + (7 * 24 * 60 * 60 * 1000)) : null;
        return trialGraceEnd && trialGraceEnd.getTime() > now ? 'grace' : 'expired';
    }

    if (rawStatus === 'paused') {
        return !accessEnd || accessEnd.getTime() > now ? 'active' : 'expired';
    }

    if (rawStatus === 'past_due' || rawStatus === 'halted') {
        if (accessEnd && accessEnd.getTime() > now) return 'active';
        const failureRecoveryGraceEnd = getFailureRecoveryGraceEnd(subscription);
        if (failureRecoveryGraceEnd && failureRecoveryGraceEnd.getTime() > now) return 'grace';
        return storedGraceEnd && storedGraceEnd.getTime() > now ? 'grace' : 'expired';
    }

    if (rawStatus === 'expired') {
        return 'expired';
    }

    return null;
}

function deriveEffectiveSubscriptionDaysLeft(subscription, effectiveStatus) {
    if (!subscription || typeof subscription !== 'object' || !isKnownSubscriptionStatus(effectiveStatus)) {
        return null;
    }

    const now = Date.now();
    let endDate = null;
    const trialEnd = getTrialWindowEnd(subscription);

    if (effectiveStatus === 'trial') {
        endDate = trialEnd;
    } else if (effectiveStatus === 'active') {
        endDate = parseSubscriptionDate(subscription.subscription_ends_at);
    } else if (effectiveStatus === 'grace') {
        const rawStatus = String(subscription.status || '').toLowerCase();
        endDate = parseSubscriptionDate(subscription.grace_ends_at) || getFailureRecoveryGraceEnd(subscription);
        if (!endDate && rawStatus === 'cancelled') {
            const cancelledAccessEnd = parseSubscriptionDate(subscription.subscription_ends_at);
            if (cancelledAccessEnd) {
                endDate = new Date(cancelledAccessEnd.getTime() + (30 * 24 * 60 * 60 * 1000));
            }
        }

        if (!endDate) {
            if (trialEnd) {
                endDate = new Date(trialEnd.getTime() + (7 * 24 * 60 * 60 * 1000));
            }
        }
    } else {
        return 0;
    }

    if (!endDate) return 0;
    const daysLeft = Math.ceil((endDate.getTime() - now) / (1000 * 60 * 60 * 24));
    return Math.max(0, daysLeft);
}

function hasPersistedSubscriptionRecord(subscription) {
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
}

function resolveEffectiveSubscriptionSnapshot(storageData = {}) {
    const currentSubscription = storageData.subscriptionData;
    const currentDerivedStatus = deriveEffectiveSubscriptionStatus(currentSubscription);
    if (isKnownSubscriptionStatus(currentDerivedStatus)) {
        const currentDerivedDaysLeft = deriveEffectiveSubscriptionDaysLeft(currentSubscription, currentDerivedStatus);
        return {
            status: currentDerivedStatus,
            daysLeft: currentDerivedDaysLeft
        };
    }

    if (isKnownSubscriptionStatus(storageData.subscriptionStatus)) {
        return {
            status: storageData.subscriptionStatus,
            daysLeft: normalizeNonNegativeInteger(storageData.subscriptionDaysLeft)
        };
    }

    const lastKnown = storageData.subscriptionLastKnownState;
    const lastKnownSubscription = lastKnown && typeof lastKnown === 'object' ? lastKnown.subscription : null;
    const lastKnownDerivedStatus = deriveEffectiveSubscriptionStatus(lastKnownSubscription);
    if (isKnownSubscriptionStatus(lastKnownDerivedStatus)) {
        const lastKnownDerivedDaysLeft = deriveEffectiveSubscriptionDaysLeft(lastKnownSubscription, lastKnownDerivedStatus);
        return {
            status: lastKnownDerivedStatus,
            daysLeft: lastKnownDerivedDaysLeft
        };
    }

    if (lastKnown && isKnownSubscriptionStatus(lastKnown.status)) {
        return {
            status: lastKnown.status,
            daysLeft: normalizeNonNegativeInteger(lastKnown.daysLeft)
        };
    }

    return {
        status: null,
        daysLeft: null
    };
}

function buildStoredSubscriptionStatePayload(status, daysLeft, subscription) {
    const safeDaysLeft = Number.isFinite(daysLeft) ? daysLeft : 0;
    const payload = {
        subscriptionStatus: status,
        subscriptionDaysLeft: safeDaysLeft,
        subscriptionData: subscription || null
    };

    if (isKnownSubscriptionStatus(status)) {
        payload.subscriptionLastKnownState = {
            status,
            daysLeft: safeDaysLeft,
            subscription: subscription || null,
            savedAt: new Date().toISOString()
        };
    } else {
        payload.subscriptionLastKnownState = null;
    }

    return payload;
}

function parseBackgroundStoredSession(rawSession) {
    if (typeof parseStoredSession === 'function') {
        return parseStoredSession(rawSession);
    }

    if (!rawSession) return null;
    if (typeof rawSession === 'object') return rawSession;
    if (typeof rawSession !== 'string') return null;

    try {
        return JSON.parse(rawSession);
    } catch (error) {
        console.warn('[BackgroundSubscription] Failed to parse stored session:', error);
        return null;
    }
}

async function refreshBackgroundSubscriptionStatus(force = false) {
    if (pendingBackgroundSubscriptionRefresh) {
        return pendingBackgroundSubscriptionRefresh;
    }

    const now = Date.now();
    if (!force && (now - lastBackgroundSubscriptionRefreshAt) < BACKGROUND_SUBSCRIPTION_REFRESH_COOLDOWN_MS) {
        return null;
    }

    if (
        typeof chrome === 'undefined' ||
        !chrome?.storage?.local?.get ||
        typeof fetch !== 'function' ||
        typeof SUPABASE_URL !== 'string' ||
        !SUPABASE_URL ||
        typeof AUTH_TOKEN_KEY !== 'string' ||
        !AUTH_TOKEN_KEY
    ) {
        return null;
    }

    pendingBackgroundSubscriptionRefresh = (async () => {
        try {
            const storageData = await chrome.storage.local.get([AUTH_TOKEN_KEY]);
            const session = parseBackgroundStoredSession(storageData[AUTH_TOKEN_KEY]);
            const accessToken = session?.access_token;
            if (!accessToken) {
                return null;
            }

            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => reject(new Error('subscription refresh timeout')), BACKGROUND_SUBSCRIPTION_REFRESH_TIMEOUT_MS);
            });
            const fetchPromise = fetch(`${SUPABASE_URL}/functions/v1/get-subscription`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${accessToken}`
                },
                body: JSON.stringify({})
            });

            const response = await Promise.race([fetchPromise, timeoutPromise]);
            if (!response.ok) {
                return null;
            }

            const subscription = await response.json();
            const rawStatus = typeof subscription?.status === 'string'
                ? subscription.status.trim().toLowerCase()
                : '';
            const isSyntheticTrial = rawStatus === 'trial' && !hasPersistedSubscriptionRecord(subscription);
            const persistedSubscription = hasPersistedSubscriptionRecord(subscription) ? subscription : null;
            const status = isSyntheticTrial
                ? 'trial'
                : (persistedSubscription ? deriveEffectiveSubscriptionStatus(persistedSubscription) : null);
            const daysLeft = isSyntheticTrial
                ? 0
                : (persistedSubscription ? deriveEffectiveSubscriptionDaysLeft(persistedSubscription, status) : 0);

            await chrome.storage.local.set(
                buildStoredSubscriptionStatePayload(status, daysLeft, persistedSubscription)
            );

            lastBackgroundSubscriptionRefreshAt = Date.now();
            return {
                status,
                daysLeft,
                subscription: persistedSubscription
            };
        } catch (error) {
            console.warn('[BackgroundSubscription] Failed to refresh subscription status:', error);
            return null;
        } finally {
            pendingBackgroundSubscriptionRefresh = null;
        }
    })();

    return pendingBackgroundSubscriptionRefresh;
}

function resolveEffectiveSubscriptionStatus(storageData = {}) {
    return resolveEffectiveSubscriptionSnapshot(storageData).status;
}

function resolveEffectiveSubscriptionDaysLeft(storageData = {}) {
    return resolveEffectiveSubscriptionSnapshot(storageData).daysLeft;
}

function isStrictlyActivePaidReviewSubscription(subscription) {
    if (!subscription || typeof subscription !== 'object') return false;
    if (!hasPersistedSubscriptionRecord(subscription)) return false;
    return String(subscription.status || '').trim().toLowerCase() === 'active';
}

function resolveReviewPromptSubscriptionRecord(storageData = {}) {
    const currentSubscription = storageData.subscriptionData;
    if (currentSubscription && typeof currentSubscription === 'object') {
        return currentSubscription;
    }

    const lastKnownSubscription = storageData.subscriptionLastKnownState?.subscription;
    if (lastKnownSubscription && typeof lastKnownSubscription === 'object') {
        return lastKnownSubscription;
    }

    return null;
}

function evaluateReviewPromptSubscriptionEligibility(subscriptionStatus, daysLeft = null) {
    if (
        subscriptionStatus === 'trial'
        && daysLeft !== null
        && daysLeft <= REVIEW_PROMPT_TRIAL_WARNING_DAYS_THRESHOLD
    ) {
        return { eligible: false, reason: 'trial_ending_soon' };
    }

    if (subscriptionStatus === 'trial') {
        return { eligible: false, reason: 'subscription_trial' };
    }

    if (subscriptionStatus === 'active') {
        return { eligible: true, reason: 'eligible' };
    }

    if (subscriptionStatus === 'grace') {
        return { eligible: false, reason: 'subscription_grace' };
    }

    if (subscriptionStatus === 'expired') {
        return { eligible: false, reason: 'subscription_expired' };
    }

    return { eligible: false, reason: 'subscription_unknown' };
}

function evaluateSubscriptionWriteAccess(subscriptionStatus) {
    return { allowed: true };
}
