import { describe, expect, it, vi } from 'vitest';

import {
  startAutoLock,
  type AppLifecycle,
  type Lockable,
} from '../startAutoLock';

/**
 * Behavioral tests for the app-background auto-lock + privacy-overlay wiring.
 *
 * The `@capacitor/app` lifecycle plugin is the external boundary, so a faithful
 * fake captures the `appStateChange` / `pause` listeners the module registers
 * and lets the test drive the exact lifecycle transitions (background → resume)
 * the device emits. Nothing asserts what the fake returns; it asserts what the
 * auto-lock DOES on each transition — the contract that decides whether the app
 * locks on background and, critically, whether it RECOVERS (lowers the overlay)
 * on resume instead of staying permanently blank.
 */
type StateListener = (state: { isActive: boolean }) => void;
type PauseListener = () => void;

function makeAppLifecycle(): {
  app: AppLifecycle;
  emitState: (isActive: boolean) => void;
  emitPause: () => void;
} {
  let stateListener: StateListener | undefined;
  let pauseListener: PauseListener | undefined;
  const app: AppLifecycle = {
    addListener: ((eventName: string, fn: StateListener | PauseListener) => {
      if (eventName === 'appStateChange') stateListener = fn as StateListener;
      else pauseListener = fn as PauseListener;
      return Promise.resolve({ remove: () => Promise.resolve() });
    }) as AppLifecycle['addListener'],
  };
  return {
    app,
    emitState: (isActive) => stateListener?.({ isActive }),
    emitPause: () => pauseListener?.(),
  };
}

function makeManager(): Lockable & { lock: ReturnType<typeof vi.fn> } {
  return { lock: vi.fn(async () => undefined) };
}

describe('startAutoLock privacy overlay on resume', () => {
  it('lowers the privacy overlay when the app returns to the foreground (isActive:true)', async () => {
    const { app, emitState } = makeAppLifecycle();
    const onResignActive = vi.fn();
    const onForeground = vi.fn();
    const manager = makeManager();

    await startAutoLock({ app, manager, onResignActive, onForeground });

    // Background raises the overlay…
    emitState(false);
    expect(onResignActive).toHaveBeenCalledTimes(1);

    // …and the subsequent foreground transition LOWERS it, so the app is not
    // left permanently blank after one background cycle (the H-1 bug).
    emitState(true);
    expect(onForeground).toHaveBeenCalledTimes(1);
  });

  it('does NOT unlock the vault on resume — resume lowers the overlay only', async () => {
    const { app, emitState } = makeAppLifecycle();
    const onForeground = vi.fn();
    const manager = makeManager();

    await startAutoLock({ app, manager, onForeground });

    // A foreground transition must NEVER call any unlock path. The only secret-
    // touching call the auto-lock makes is `lock()` on background; resume keeps
    // the vault locked and the user re-authenticates.
    emitState(true);
    expect(onForeground).toHaveBeenCalledTimes(1);
    expect(manager.lock).not.toHaveBeenCalled();
    // (Lockable exposes no unlock; resume staying lock-only is structural here —
    // the assertion pins that resume does not even fire the background lock.)
  });

  it('still clears the full secret on background (isActive:false) and on pause', async () => {
    const { app, emitState, emitPause } = makeAppLifecycle();
    const manager = makeManager();

    await startAutoLock({ app, manager });

    emitState(false);
    expect(manager.lock).toHaveBeenCalledTimes(1);

    emitPause();
    expect(manager.lock).toHaveBeenCalledTimes(2);
  });
});
