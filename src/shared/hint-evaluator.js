export function createHintState() {
  return {
    consumed: new Set(),
    firstTriggered: new Map(),
    triggered: new Set(),
    attemptCount: 0,
  };
}

export function recordCheckAttempt(state) {
  state.attemptCount += 1;
  return state.attemptCount;
}

export function consumeHint(state, hintId) {
  state.consumed.add(hintId);
}

export function evaluateHints(hints, state, event, evaluateCondition, { now = Date.now() } = {}) {
  const visibleHints = [];
  let nextEvaluationDelayMs = null;

  for (let index = 0; index < (hints?.length ?? 0); index += 1) {
    const hint = hints[index];
    if (!hint?.trigger || !hint.id) continue;
    const displayMode = hint.display_mode ?? 'triggered';
    const consumed = state.consumed.has(hint.id);
    if (consumed && displayMode !== 'checklist') continue;

    const trigger = hint.trigger;
    const delay = hint.delay_seconds ?? 0;
    const delayStarted = state.firstTriggered.has(hint.id);
    const isMatchingEvent = event?.type === trigger.event &&
      (trigger.event !== 'test_fail' || (event.failedCheckCount ?? 0) > 0) &&
      (event.hint_id === undefined || event.hint_id === hint.id);
    const isDelayTick = event?.type === 'timer' && delayStarted;
    const isInvalidationCheck = trigger.invalidate_on_condition_false === true &&
      state.triggered.has(hint.id) && event?.type === 'sim_event';
    const isPendingDelayCheck = delayStarted && event?.type !== 'timer';

    if (!isMatchingEvent && !isDelayTick && !isInvalidationCheck && !isPendingDelayCheck) continue;
    if ((trigger.after_attempts ?? 0) > state.attemptCount) continue;

    let conditionPassed = true;
    if (trigger.conditions !== undefined) {
      const conditionResult = evaluateCondition(trigger.conditions);
      conditionPassed = typeof conditionResult === 'boolean'
        ? conditionResult
        : conditionResult?.passed === true;
    }
    if (!conditionPassed) {
      state.firstTriggered.delete(hint.id);
      if (trigger.invalidate_on_condition_false === true) {
        state.triggered.delete(hint.id);
      }
      continue;
    }

    if (state.triggered.has(hint.id)) {
      continue;
    }
    if (!isMatchingEvent && !isDelayTick && !isPendingDelayCheck) continue;

    if (delay > 0) {
      if (!delayStarted) {
        state.firstTriggered.set(hint.id, now);
        nextEvaluationDelayMs = nextEvaluationDelayMs === null
          ? delay * 1000
          : Math.min(nextEvaluationDelayMs, delay * 1000);
        continue;
      }
      const remainingMs = delay * 1000 - (now - state.firstTriggered.get(hint.id));
      if (remainingMs > 0) {
        nextEvaluationDelayMs = nextEvaluationDelayMs === null
          ? remainingMs
          : Math.min(nextEvaluationDelayMs, remainingMs);
        continue;
      }
    }

    state.firstTriggered.delete(hint.id);
    state.triggered.add(hint.id);
  }

  for (let index = 0; index < (hints?.length ?? 0); index += 1) {
    const hint = hints[index];
    if (!hint?.id) continue;
    const displayMode = hint.display_mode ?? 'triggered';
    if (displayMode !== 'checklist' && (!state.triggered.has(hint.id) || state.consumed.has(hint.id))) {
      continue;
    }
    visibleHints.push({
      id: hint.id,
      message: hint.message,
      priority: hint.priority ?? 1,
      display_mode: displayMode,
      style: hint.style ?? 'info',
      triggered: state.triggered.has(hint.id),
      show_once: hint.show_once === true,
    });
  }
  visibleHints.sort((left, right) => right.priority - left.priority);
  return { visibleHints, nextEvaluationDelayMs };
}

export function getManualHintRequestState(hints, state, evaluateCondition) {
  const manualHints = Array.isArray(hints)
    ? hints.filter((hint) => hint?.trigger?.event === 'manual')
    : [];
  if (manualHints.length === 0) return { hasManualHints: false, canRequest: false };

  const canRequest = manualHints.some((hint) => {
    if (!hint?.id || state.consumed.has(hint.id)) return false;
    if ((hint.trigger.after_attempts ?? 0) > state.attemptCount) return false;
    if (hint.trigger.conditions === undefined) return true;
    const result = evaluateCondition(hint.trigger.conditions);
    return typeof result === 'boolean' ? result : result?.passed === true;
  });
  return { hasManualHints: true, canRequest };
}

export function createHintEventDebouncer(callback, delayMs = 250) {
  let timer;
  let pendingEvent;

  function flush() {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (pendingEvent === undefined) return;
    const event = pendingEvent;
    pendingEvent = undefined;
    callback(event);
  }

  return {
    push(event) {
      if (event?.type !== 'sim_event') {
        flush();
        callback(event);
        return;
      }
      pendingEvent = event;
      clearTimeout(timer);
      timer = setTimeout(flush, delayMs);
    },
    flush,
    cancel() {
      clearTimeout(timer);
      timer = undefined;
      pendingEvent = undefined;
    },
  };
}

